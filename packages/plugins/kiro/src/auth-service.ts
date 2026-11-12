import { clearKiroRouterRefs } from "./router";
import { constants } from "node:fs";
import { open, mkdir, rename, unlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { PluginHostCapabilities, PluginClassifiedError } from "./core-types";
import { KIRO_SITE, KIRO_PROVIDER, CALLBACK_PORTS, BUILDER_ID_START, BUILDER_ID_PROFILE, KIRO_REGIONS, KIRO_SCOPES, DEFAULT_REGION, authURL, refreshURL, managementURL, oidcURL, validRegion, validStartUrl, kiroError, isKiroManaged, lockKiroProvider, regionOf, isPermanentOAuthFailure } from "./protocol";

export type KiroLoginMethod = "portal" | "builderid" | "idc";
export interface KiroCredential {
  id: string; uid: string; email: string; accountId: string; access: string; refresh: string; expires: number;
  /** Kiro service region: where the account's API is, i.e. its profile ARN's region. */
  region: string; method: "social" | "idc"; loginProvider: string; profile: string;
  /** Sign-in region (AWS directory or Kiro portal region); only used to reach OIDC/token endpoints. */
  signInRegion?: string;
  clientId?: string; clientSecret?: string;
  plan?: string; needReauth?: boolean; coolingUntil?: number;
}
export interface KiroModelRecord { id: string; key: string; name: string; context: number; output: number; images: boolean }
export interface KiroUsageSnapshot { known: boolean; stale: boolean; plan?: string; user?: string; observedAt?: number;
  windows: Array<{ name: string; used: number; amount: number; limit: number; unit: string; display: string; resetsAt?: string; expiresAt?: string }> }
interface Saved { version: 1; accounts: KiroCredential[]; models: KiroModelRecord[]; hiddenModels: string[] }
interface Login { id: string; state: string; verifier: string; port: number; server: Server; timer: ReturnType<typeof setTimeout>;
  stage: "portal" | "aws"; region: string; provider?: string; clientId?: string; clientSecret?: string; url: string;
  status: "pending" | "complete" | "cancelled" | "expired" | "failed"; account?: ReturnType<typeof publicAccount>; busy?: boolean }
export interface KiroServiceOptions { host: PluginHostCapabilities; fetch?: typeof fetch; now?: () => number }
// Vendor JSON is decoded and reduced at the boundary; it never enters public responses verbatim.
type Json = Record<string, any>;
const names: Record<string, string> = { google: "Google", github: "GitHub", builderid: "Builder ID", enterprise: "IAM Identity Center", internal: "Internal" };
const publicAccount = (c: KiroCredential) => ({ id: c.id, uid: c.uid, email: c.email, accountId: c.accountId, name: c.accountId,
  method: c.method, loginProvider: c.loginProvider, region: c.region, plan: c.plan, needReauth: !!c.needReauth, coolingUntil: c.coolingUntil ?? 0 });
const secret = () => randomBytes(32).toString("base64url");
const challenge = (s: string) => createHash("sha256").update(s).digest("base64url");
const text = (v: unknown, max = 32768): v is string => typeof v === "string" && v.length <= max && !/[\x00-\x1f]/.test(v);
/** Token and refresh endpoints: the only ones whose non-2xx answer can end a sign-in. */
const AUTH_ENDPOINT = /\/(?:token|refreshToken)(?:$|\?)/;

export class KiroAuthService {
  readonly site = KIRO_SITE;
  readonly file: string;
  private saved: Saved = { version: 1, accounts: [], models: [], hiddenModels: [] };
  private loaded?: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private refreshes = new Map<string, Promise<KiroCredential>>();
  private logins = new Map<string, Login>();
  private usage = new Map<string, KiroUsageSnapshot>();
  constructor(readonly options: KiroServiceOptions) { this.file = join(options.host.configDir, KIRO_SITE.credentialFile); }
  private now() { return this.options.now?.() ?? Date.now(); }
  /**
   * The credential-commit lane: sections run one at a time, strictly in submission order.
   * Nothing inside a section ever waits on it again — `load()` reads through its own cached
   * promise and `commit`'s host callbacks never enqueue — so a section cannot deadlock on itself.
   */
  private exclusive<T>(action: () => Promise<T>): Promise<T> { const job = this.queue.then(action); this.queue = job.catch(() => {}); return job; }
  private validate(value: Json): Saved {
    if (value?.version !== 1) throw kiroError("kiro_credential_invalid");
    // Accept the original single-credential envelope and magpie field aliases.
    const list = value.accounts ?? (value.credential ? [value.credential] : []);
    if (!Array.isArray(list) || list.length > 128 || !Array.isArray(value.models ?? []) || !Array.isArray(value.hiddenModels ?? [])) throw kiroError("kiro_credential_invalid");
    const accounts = list.map((v: Json): KiroCredential => {
      const provider = String(v.loginProvider ?? v.uid ?? "").toLowerCase();
      const uid = provider === "awsidc" ? "enterprise" : provider;
      const rawRegion = v.region ?? DEFAULT_REGION, access = v.access ?? v.accessToken, refresh = v.refresh ?? v.refreshToken ?? "";
      const profile = v.profile ?? v.profileArn ?? (uid === "builderid" ? BUILDER_ID_PROFILE : "");
      // Legacy files stored the sign-in (directory) region in `region`; the Kiro service region is
      // where the profile ARN says (Kiro's nearest region when the profile carries none). Normalize
      // at load so management calls never reach a stale directory region before the first refresh;
      // the stored region stays the sign-in region for the token endpoints.
      const region = regionOf(profile, rawRegion);
      const expires = v.expires ?? Date.parse(v.expiresAt ?? "");
      if ((v.id !== undefined && (!text(v.id, 128) || !v.id)) || !text(v.accountId ?? "", 2048)) throw kiroError("kiro_credential_invalid");
      if (!text(access) || !access || !text(refresh) || !Number.isFinite(expires) || !validRegion(region) || !text(uid, 128) || !text(v.email ?? "", 1024) || !text(profile, 2048) || !text(v.clientId ?? "") || !text(v.clientSecret ?? "") || !text(v.signInRegion ?? "")) throw kiroError("kiro_credential_invalid");
      const email = v.email ?? "", accountId = email ? `${email}${names[uid] ? ` (${names[uid]})` : ""}` : v.accountId ?? "Kiro account";
      return { id: v.id ?? createHash("sha256").update(`${email}:${uid}:${email ? "" : access}`).digest("hex").slice(0, 24), uid, email, accountId,
        access, refresh, expires, method: v.method === "idc" || ["builderid", "enterprise", "internal"].includes(uid) ? "idc" : "social", loginProvider: uid,
        region, profile, signInRegion: v.signInRegion ?? rawRegion, clientId: v.clientId, clientSecret: v.clientSecret,
        plan: text(v.plan, 256) ? v.plan : undefined, needReauth: v.needReauth === true, coolingUntil: Number.isFinite(v.coolingUntil) ? v.coolingUntil : 0 };
    });
    const models = (value.models ?? []).map((m: Json) => {
      const id = m.id ?? m.key;
      if (!text(id, 256) || !id || !text(m.name, 256) || !Number.isFinite(m.context)) throw kiroError("kiro_credential_invalid");
      return { id, key: id, name: m.name, context: m.context, output: Number(m.output) || 0, images: m.images === true };
    });
    if (models.length > 2048 || value.hiddenModels?.length > 2048 || !(value.hiddenModels ?? []).every((m: unknown) => text(m, 256))) throw kiroError("kiro_credential_invalid");
    return { version: 1, accounts, models, hiddenModels: [...new Set<string>(value.hiddenModels ?? [])] };
  }
  private async load() {
    this.loaded ??= (async () => {
      let handle;
      try { handle = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const stat = await handle.stat(); if (!stat.isFile() || stat.size > 1_048_576) throw kiroError("kiro_credential_invalid");
        this.saved = this.validate(JSON.parse(await handle.readFile("utf8")));
        try { await handle.chmod(0o600); } catch { /* a read-only mount keeps its own mode */ }
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw kiroError("kiro_credential_unreadable", 500); }
      finally { await handle?.close(); }
    })().catch(e => { this.loaded = undefined; throw e; });
    return this.loaded;
  }
  private async persist(next: Saved) {
    await this.load();
    const serialized = JSON.stringify(this.validate(next));
    if (Buffer.byteLength(serialized) > 1_048_576) throw kiroError("kiro_persist_failed", 500);
    await mkdir(this.options.host.configDir, { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${secret()}.tmp`; let handle;
    try { handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(serialized); await handle.sync(); await handle.close(); handle = undefined; await rename(temp, this.file); this.saved = next;
    } catch { throw kiroError("kiro_persist_failed", 500); } finally { await handle?.close(); await unlink(temp).catch(() => {}); }
  }
  private async config(next: Saved) {
    const host = this.options.host; if (!host.readRawConfig) throw kiroError("kiro_raw_config_required", 500);
    const cfg = structuredClone(await host.readRawConfig()), previous = structuredClone(cfg);
    const key = Array.isArray(cfg.providers) && !Array.isArray(cfg.Providers) ? "providers" : "Providers";
    const list: Json[] = cfg[key] ?? [], at = list.findIndex(isKiroManaged);
    if (next.accounts.length) {
      if (at < 0 && list.some(p => p.name === KIRO_PROVIDER)) throw kiroError("kiro_provider_name_conflict");
      const p = lockKiroProvider({ ...(at >= 0 ? list[at] : {}), models: next.models.filter(m => !next.hiddenModels.includes(m.id)).map(m => m.id), enabled: at >= 0 ? list[at].enabled !== false : true });
      if (at < 0) list.push(p); else list[at] = p;
    } else if (at >= 0) list.splice(at, 1);
    cfg[key] = list;
    if ("Router" in cfg) {
      const hidden = new Set(next.hiddenModels);
      const firstVisible = next.models.find(model => !hidden.has(model.id))?.id ?? null;
      cfg.Router = clearKiroRouterRefs(cfg.Router, hidden, firstVisible);
    }
    const expectedRouter = JSON.stringify(cfg.Router ?? null);
    try {
      await host.writeConfig(cfg);
      if (JSON.stringify(cfg.Router ?? null) !== expectedRouter) throw kiroError("kiro_config_write_failed", 500);
      await host.reloadRuntime(cfg);
    } catch {
      await host.writeConfig(previous).catch(() => {});
      await host.reloadRuntime(previous).catch(() => {});
      throw kiroError("kiro_config_write_failed", 500);
    }
  }
  private async commit(next: Saved) {
    const old = this.saved; await this.config(next);
    try { await this.persist(next); } catch (e) { await this.config(old).catch(() => {}); throw e; }
  }
  private async request(url: string, body?: Json, token?: string): Promise<Json> {
    let res: Response;
    try { res = await (this.options.fetch ?? fetch)(url, { method: body ? "POST" : "GET", redirect: "error",
      headers: { Accept: "application/json", "Accept-Encoding": "identity", "User-Agent": "Kiro-Desktop/0.2.13", ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000),
      dispatcher: this.options.host.getSubscriptionDispatcher?.() ?? this.options.host.getDirectDispatcher() } as RequestInit); }
    catch { throw kiroError("kiro_upstream_error", 502); }
    if (!res.ok) {
      // A token/refresh answer that ends the sign-in is read at a bounded size and by code only:
      // the vendor's error_description is never surfaced or persisted.
      const permanent = AUTH_ENDPOINT.test(url) && isPermanentOAuthFailure(res.status, await this.oauthError(res));
      await res.body?.cancel().catch(() => {});
      throw kiroError(permanent ? "kiro_reauth_required" : "kiro_upstream_error", permanent ? 401 : 502);
    }
    try { return await res.json() as Json; } catch { throw kiroError("kiro_upstream_error", 502); }
  }
  /** Reads at most 8 KiB of an OAuth error body, and only its code. */
  private async oauthError(res: Response): Promise<{ error?: unknown }> {
    if (!res.body || res.status !== 400) return {};
    const reader = res.body.getReader(), decoder = new TextDecoder(); let raw = "", size = 0;
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break; size += value?.length ?? 0;
        if (size > 8192) return {}; raw += decoder.decode(value, { stream: true }); }
      raw += decoder.decode();
      const parsed = JSON.parse(raw) as Json;
      return { error: parsed?.error };
    } catch { return {}; } finally { await reader.cancel().catch(() => {}); }
  }
  private management(c: KiroCredential, operation: string, query: Record<string, string> = {}, body?: Json) {
    const q = new URLSearchParams({ origin: "KIRO_CLI", profileArn: c.profile, ...query });
    return this.request(`${managementURL(c.region)}/${operation}${body ? "" : `?${q}`}`, body, c.access);
  }
  /** A profile without a region-bearing ARN needs a Kiro region; ask Kiro's own regions in order. */
  private async discoverProfile(c: KiroCredential): Promise<string> {
    for (const region of KIRO_REGIONS) {
      try {
        const probe: KiroCredential = { ...c, region };
        const p = await this.management(probe, "List-Available-Profiles", {}, {});
        const arn = p.profiles?.find((v: Json) => typeof v.arn === "string" && v.arn)?.arn;
        if (typeof arn === "string" && arn) return arn;
      } catch { /* try Kiro's next region */ }
    }
    return "";
  }
  private async identify(c: KiroCredential) {
    if (c.uid === "builderid") c.profile = BUILDER_ID_PROFILE;
    else if (!c.profile) c.profile = await this.discoverProfile(c);
    // The account's API lives where its profile ARN says, not where the directory login happened.
    c.region = regionOf(c.profile, c.signInRegion ?? c.region);
    const l = await this.management(c, "Get-Usage-Limits", { resourceType: "CREDIT", isEmailRequired: "true" });
    c.email = typeof l.userInfo?.email === "string" ? l.userInfo.email : "";
    if (!c.email) throw kiroError("kiro_login_failed", 502);
    c.plan = String(l.subscriptionInfo?.subscriptionTitle ?? "");
    c.accountId = c.email ? `${c.email}${names[c.uid] ? ` (${names[c.uid]})` : ""}` : "Kiro account";
    this.usage.set(c.id, this.usageOf(l));
  }
  private usageOf(l: Json): KiroUsageSnapshot {
    const windows: KiroUsageSnapshot["windows"] = [];
    for (const u of l.usageBreakdownList ?? []) {
      const entries = [{ ...u, label: u.displayNamePlural ?? u.displayName ?? "Credits" }, ...(u.freeTrialInfo?.freeTrialStatus === "ACTIVE" ? [{ ...u.freeTrialInfo, label: "Free trial" }] : [])];
      for (const v of entries) { const amount = Number(v.currentUsageWithPrecision) || 0, limit = Number(v.usageLimitWithPrecision) || 0;
        const reset = Number(v.freeTrialExpiry ?? v.nextDateReset ?? l.nextDateReset);
        if (limit > 0) windows.push({ name: v.label, used: amount / limit * 100, amount, limit, unit: "credits", display: `${amount} / ${limit}`, ...(reset > 0 && Number.isFinite(reset) ? { resetsAt: new Date(reset * 1000).toISOString() } : {}) }); }
      // Promotional / gifted credits ("bonuses", e.g. FIRST_UPGRADE_TRIAL) are
      // separate balances attached to the same breakdown entry. Surface each
      // ACTIVE one as its own window; its timestamp is an EXPIRY, not a reset.
      for (const b of Array.isArray(u.bonuses) ? u.bonuses : []) {
        if (b?.status !== "ACTIVE") continue;
        const bAmount = Number(b.currentUsageWithPrecision ?? b.currentUsage) || 0;
        const bLimit = Number(b.usageLimitWithPrecision ?? b.usageLimit) || 0;
        const expires = Number(b.expiresAt);
        if (!(bLimit > 0)) continue;
        windows.push({ name: String(b.displayName ?? b.description ?? "Bonus"), used: bAmount / bLimit * 100, amount: bAmount, limit: bLimit, unit: "credits", display: `${bAmount} / ${bLimit}`, ...(expires > 0 && Number.isFinite(expires) ? { expiresAt: new Date(expires * 1000).toISOString() } : {}) });
      }
    }
    return { known: true, stale: false, plan: String(l.subscriptionInfo?.subscriptionTitle ?? ""), user: l.userInfo?.email, observedAt: this.now(), windows };
  }
  private async listen(): Promise<{ server: Server; port: number }> {
    for (const port of CALLBACK_PORTS) { const server = createServer();
      const ok = await new Promise<boolean>(resolve => { const error = () => resolve(false); server.once("error", error); server.listen(port, "127.0.0.1", () => { server.removeListener("error", error); resolve(true); }); });
      if (ok) { server.unref(); return { server, port }; }
    } throw kiroError("kiro_callback_ports_busy", 409);
  }
  private end(l: Login, status: Login["status"]) { l.status = status; clearTimeout(l.timer); l.server.close(); }
  /** Token and refresh endpoints follow the sign-in region, never the profile region. */
  private signInRegion(c: KiroCredential) { return validRegion(c.signInRegion) ? c.signInRegion : c.region; }
  private async startAWS(l: Login, provider: string, issuer: string, region: string) {
    if (!validRegion(region) || !validStartUrl(issuer)) throw kiroError("kiro_login_invalid");
    const reg = await this.request(`${oidcURL(region)}/client/register`, { clientName: "Kiro IDE", clientType: "public", scopes: KIRO_SCOPES,
      grantTypes: ["authorization_code", "refresh_token"], redirectUris: ["http://127.0.0.1/oauth/callback"], issuerUrl: issuer });
    if (l.status !== "pending") throw kiroError("kiro_login_cancelled", 409);
    if (!text(reg.clientId) || !reg.clientId) throw kiroError("kiro_login_failed", 502);
    Object.assign(l, { stage: "aws", region, provider, clientId: reg.clientId, clientSecret: reg.clientSecret, state: secret(), verifier: secret() });
    const q = new URLSearchParams({ response_type: "code", client_id: l.clientId!, redirect_uri: `http://127.0.0.1:${l.port}/oauth/callback`, scopes: KIRO_SCOPES.join(","), state: l.state, code_challenge: challenge(l.verifier), code_challenge_method: "S256" });
    l.url = `${oidcURL(region)}/authorize?${q}`;
  }
  async startLogin(input: { method: KiroLoginMethod; startUrl?: string; region?: string }) {
    await this.load();
    if (!["portal", "builderid", "idc"].includes(input?.method) || !validRegion(input.region ?? DEFAULT_REGION) || (input.method === "idc" && !validStartUrl(input.startUrl))) throw kiroError("kiro_login_invalid");
    // Bound pending listeners and retained terminal sessions. No await before the listener is
    // registered: `listen()` is awaited inside the critical section so two racing starts cannot
    // both see the same old session list and each open a listener of their own.
    const l = await this.exclusive(async () => {
      for (const old of this.logins.values()) if (old.status === "pending") this.end(old, "cancelled");
      while (this.logins.size >= 32) this.logins.delete(this.logins.keys().next().value!);
      const { server, port } = await this.listen();
      const login: Login = { id: randomUUID(), server, port, timer: undefined as unknown as ReturnType<typeof setTimeout>, state: secret(), verifier: secret(), stage: "portal", region: input.region ?? DEFAULT_REGION, status: "pending", url: "" };
      login.timer = setTimeout(() => this.end(login, "expired"), 600_000); login.timer.unref(); this.logins.set(login.id, login);
      server.on("request", async (req, res) => {
        res.setHeader("Connection", "close");
        try { const result = await this.completeLogin(login.id, `http://127.0.0.1:${port}${req.url}`);
          if (result.status === "pending") { res.writeHead(302, { Location: login.url }); res.end(); }
          else { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end("<!doctype html><title>Kiro</title>Signed in. You can close this tab."); }
        } catch { res.writeHead(400, { "Content-Type": "text/plain" }); res.end("Kiro callback rejected. Return to CCR to continue."); }
      });
      return login;
    });
    // AWS registration is a remote call and stays outside the critical section; a competing
    // start cancels this session here, and `startAWS` refuses to go on for a cancelled login.
    try {
      if (input.method === "portal") l.url = `${KIRO_SITE.web}/signin?${new URLSearchParams({ state: l.state, code_challenge: challenge(l.verifier), code_challenge_method: "S256", redirect_uri: `http://localhost:${l.port}`, redirect_from: "KiroIDE" })}`;
      else await this.startAWS(l, input.method === "idc" ? "enterprise" : "builderid", input.method === "idc" ? input.startUrl! : BUILDER_ID_START, l.region);
      if (l.status !== "pending") throw kiroError("kiro_login_cancelled", 409);
      return { loginId: l.id, url: l.url };
    } catch (e) { if (l.status === "pending") this.end(l, "failed"); throw e; }
  }
  private login(id: unknown): Login { const l = typeof id === "string" ? this.logins.get(id) : undefined; if (!l) throw kiroError("kiro_login_unknown", 404); return l; }
  async pollLogin(id: string, callbackUrl?: string) { if (callbackUrl !== undefined) return this.completeLogin(id, callbackUrl); const l = this.login(id); return { status: l.status, ...(l.account ? { account: l.account } : {}), ...(l.status === "pending" ? { url: l.url } : {}) }; }
  async cancelLogin(id: string) { return this.exclusive(async () => { const l = this.login(id); if (l.status === "pending") this.end(l, "cancelled"); return { status: l.status }; }); }
  async completeLogin(id: string, callbackUrl: string): Promise<{ status: string; account?: ReturnType<typeof publicAccount>; url?: string }> {
    const l = this.login(id); if (l.status !== "pending") throw kiroError(l.status === "expired" ? "kiro_login_expired" : "kiro_login_cancelled", 409);
    let u: URL;
    try { if (typeof callbackUrl !== "string" || callbackUrl.length > 16384) throw new Error(); u = new URL(callbackUrl); } catch { throw kiroError("kiro_callback_invalid"); }
    if (u.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(u.hostname) || Number(u.port) !== l.port || u.username || u.password || !["/oauth/callback", "/signin/callback"].includes(u.pathname) || u.searchParams.get("state") !== l.state || (l.stage === "aws" && u.pathname !== "/oauth/callback")) throw kiroError("kiro_callback_invalid");
    if (l.busy) throw kiroError("kiro_login_busy", 409);
    l.busy = true;
    // From the moment an authorized callback starts trading its code, a terminal failure ends the
    // session: the authorization code is single-use, so leaving the session pending would strand
    // the listener and offer no retry. A callback that fails before this point (state, host, path)
    // is not this session's and must not cancel it.
    let redeeming = false;
    try {
      const q = u.searchParams; if (q.has("error")) { this.end(l, "failed"); throw kiroError("kiro_login_failed"); }
      if (l.stage === "portal" && ["builderid", "awsidc", "internal"].includes(q.get("login_option") ?? "")) {
        await this.startAWS(l, q.get("login_option") === "awsidc" ? "enterprise" : q.get("login_option")!, q.get("issuer_url")!, q.get("idc_region")!);
        return { status: "pending", url: l.url };
      }
      const provider = l.stage === "aws" ? l.provider! : q.get("login_option")!;
      if (!q.get("code") || (l.stage === "portal" && !["google", "github"].includes(provider))) throw kiroError("kiro_callback_invalid");
      redeeming = true;
      const signInRegion = l.region;
      const t = l.stage === "aws" ? await this.request(`${oidcURL(signInRegion)}/token`, { clientId: l.clientId, clientSecret: l.clientSecret, grantType: "authorization_code", redirectUri: `http://127.0.0.1:${l.port}/oauth/callback`, code: q.get("code"), codeVerifier: l.verifier }) :
        await this.request(`${authURL(signInRegion)}/oauth/token`, { code: q.get("code"), code_verifier: l.verifier, redirect_uri: `http://localhost:${l.port}${u.pathname}?login_option=${provider}` });
      if (!text(t.accessToken) || !t.accessToken) throw kiroError("kiro_login_failed", 502);
      const profile = text(t.profileArn, 2048) ? t.profileArn : "";
      // The sign-in region reaches the token endpoints; the profile region is where the API is.
      const c: KiroCredential = { id: randomUUID(), uid: provider, email: "", accountId: "Kiro account", access: t.accessToken, refresh: text(t.refreshToken) ? t.refreshToken : "", expires: this.now() + (Number(t.expiresIn) > 0 ? Number(t.expiresIn) : 3600) * 1000,
        method: l.stage === "aws" ? "idc" : "social", loginProvider: provider, region: regionOf(profile, signInRegion), profile, signInRegion, clientId: l.clientId, clientSecret: l.clientSecret };
      await this.identify(c);
      await this.exclusive(async () => {
        if (l.status !== "pending") throw kiroError("kiro_login_cancelled", 409);
        const old = this.saved.accounts.find(a => a.uid === c.uid && a.email === c.email && !!c.email); if (old) c.id = old.id;
        await this.commit({ ...this.saved, accounts: [...this.saved.accounts.filter(a => a.id !== c.id), c] });
      });
      l.account = publicAccount(c); this.end(l, "complete");
      return { status: "complete", account: l.account };
    } catch (e) {
      // A concurrent cancel/expiry already ended the session; keep its status and its error.
      if (redeeming && l.status === "pending" && (e as { code?: string }).code !== "kiro_login_cancelled") this.end(l, "failed");
      throw e;
    } finally { l.busy = false; }
  }
  private select(id?: string) { const c = id ? this.saved.accounts.find(a => a.id === id || a.accountId === id) : this.saved.accounts.find(a => !a.needReauth && (a.coolingUntil ?? 0) <= this.now()) ?? this.saved.accounts[0]; if (!c) throw kiroError("kiro_not_connected", 409); return c; }
  async ensureUsable(account?: string) { await this.load(); const c = this.select(account); if (c.needReauth) throw kiroError("kiro_reauth_required", 401); if ((c.coolingUntil ?? 0) > this.now()) throw kiroError("kiro_account_cooling", 429); }
  async getCredential(account?: string): Promise<KiroCredential> { await this.ensureUsable(account); const c = this.select(account); return c.expires - this.now() > 120_000 ? { ...c } : this.forceTokenRefresh(c.id); }
  async forceTokenRefresh(account?: string): Promise<KiroCredential> {
    await this.ensureUsable(account); const c = this.select(account), existing = this.refreshes.get(c.id); if (existing) return existing;
    const job = (async () => {
      try {
        if (!c.refresh) throw kiroError("kiro_reauth_required", 401);
        const signInRegion = this.signInRegion(c);
        const t = await this.request(c.method === "idc" ? `${oidcURL(signInRegion)}/token` : refreshURL(signInRegion), c.method === "idc" ? { clientId: c.clientId, clientSecret: c.clientSecret, refreshToken: c.refresh, grantType: "refresh_token" } : { refreshToken: c.refresh });
        if (!text(t.accessToken) || !t.accessToken) throw kiroError("kiro_reauth_required", 401);
        const profile = text(t.profileArn, 2048) && t.profileArn ? t.profileArn : c.profile;
        const next = { ...c, access: t.accessToken, refresh: text(t.refreshToken) && t.refreshToken ? t.refreshToken : c.refresh, expires: this.now() + (Number(t.expiresIn) > 0 ? Number(t.expiresIn) : 3600) * 1000, profile, region: regionOf(profile, c.region) };
        await this.exclusive(() => this.upsert(c, next));
        return { ...next };
      } catch (e) { if ((e as { code?: string }).code === "kiro_reauth_required") await this.markError(c, { code: "kiro_reauth_required", cooldownMs: 3_600_000 }); throw e; }
      finally { this.refreshes.delete(c.id); }
    })(); this.refreshes.set(c.id, job); return job;
  }
  /**
   * Merges freshly rotated tokens into the account as it is stored *now*, not into the snapshot
   * the refresh started from: a concurrent cooldown/reauth update replaces the account object, and
   * discarding the rotated tokens there would spend a refresh token the server may already have
   * retired. Only a real disconnect (account gone) or a new sign-in (credentials changed) refuses.
   * Callers hold the exclusive credential-commit lane.
   */
  private async upsert(previous: KiroCredential, next: KiroCredential) {
    const at = this.saved.accounts.findIndex(a => a.id === previous.id);
    if (at < 0) throw kiroError("kiro_not_connected", 409);
    const current = this.saved.accounts[at];
    if (current.access !== previous.access || current.refresh !== previous.refresh) throw kiroError("kiro_not_connected", 409);
    const merged: KiroCredential = { ...current, access: next.access, refresh: next.refresh, expires: next.expires, profile: next.profile, region: next.region };
    const accounts = [...this.saved.accounts]; accounts[at] = merged;
    await this.persist({ ...this.saved, accounts });
  }
  private markError(c: KiroCredential, info: { code: string; cooldownMs?: number }) { return this.exclusive(async () => {
    const at = this.saved.accounts.findIndex(a => a.id === c.id); if (at < 0) return;
    const current = this.saved.accounts[at], accounts = [...this.saved.accounts];
    accounts[at] = { ...current, needReauth: info.code === "kiro_reauth_required" || current.needReauth, coolingUntil: this.now() + Math.min(info.cooldownMs ?? 300_000, 3_600_000) };
    await this.persist({ ...this.saved, accounts }); }); }
  async noteUpstreamError(info: PluginClassifiedError, account?: string) { await this.load(); try { await this.markError(this.select(account), info); } catch { /* Telemetry never breaks the response path. */ } }
  async getStatus() { await this.load(); return { connected: !!this.saved.accounts.length, status: this.saved.accounts.length ? "connected" : "disconnected", providerName: KIRO_PROVIDER,
    // `models` is the VISIBLE catalog (same contract as the gemini-oauth
    // status endpoint): hidden ids are reported separately via hiddenModels,
    // so the card's visible-chips row never renders a hidden model after a
    // reload — the hide action's optimistic patch only masked this until the
    // next status fetch.
    accounts: this.saved.accounts.map(publicAccount), models: this.saved.models.filter(m => !this.saved.hiddenModels.includes(m.id)), hiddenModels: this.saved.hiddenModels, plan: this.saved.accounts[0]?.plan ?? null,
    usage: this.saved.accounts.map(c => ({ account: c.id, ...(this.usage.get(c.id) ?? { known: false, stale: true, windows: [] }) })) }; }
  async getUsage(account?: string) {
    const c = await this.getCredential(account);
    try { const l = await this.management(c, "Get-Usage-Limits", { resourceType: "CREDIT", isEmailRequired: "true" }); const usage = this.usageOf(l); this.usage.set(c.id, usage); return usage; }
    catch (e) { if ((e as { code?: string }).code === "kiro_reauth_required") await this.noteUpstreamError({ code: "kiro_reauth_required", message: "kiro_reauth_required", httpStatus: 401, cooldownMs: 3_600_000 }, c.id); throw e; }
  }
  async syncModels(account?: string) {
    const c = await this.getCredential(account), models: KiroModelRecord[] = [], seen = new Set<string>(); let nextToken = "", defaultId = "";
    try {
      do { const p = await this.management(c, "List-Available-Models", nextToken ? { nextToken } : {}); defaultId ||= p.defaultModel?.modelId ?? "";
        for (const m of p.models ?? []) if (text(m.modelId, 256) && m.modelId && !models.some(v => v.id === m.modelId)) models.push({ id: m.modelId, key: m.modelId, name: String(m.modelName ?? m.modelId), context: Number(m.tokenLimits?.maxInputTokens) || 0, output: Number(m.tokenLimits?.maxOutputTokens) || 0, images: (m.supportedInputTypes ?? []).some((v: string) => v.toUpperCase() === "IMAGE") });
        nextToken = p.nextToken ?? ""; if (nextToken && (seen.has(nextToken) || seen.size >= 100)) throw kiroError("kiro_upstream_error", 502); seen.add(nextToken);
      } while (nextToken);
      if (!models.length) throw kiroError("kiro_upstream_error", 502);
      models.sort((a, b) => Number(b.id === defaultId) - Number(a.id === defaultId));
      await this.exclusive(async () => { if (!this.saved.accounts.some(a => a.id === c.id && a.access === c.access)) throw kiroError("kiro_not_connected", 409); await this.commit({ ...this.saved, models }); });
      return { success: true, models };
    } catch (e) { if ((e as { code?: string }).code === "kiro_reauth_required") await this.noteUpstreamError({ code: "kiro_reauth_required", message: "kiro_reauth_required", httpStatus: 401, cooldownMs: 3_600_000 }, c.id); throw e; }
  }
  async setModelHidden(model: string, hidden: boolean) { await this.load(); return this.exclusive(async () => { if (!this.saved.models.some(m => m.id === model)) throw kiroError("kiro_model_unknown"); const set = new Set(this.saved.hiddenModels); if (hidden) set.add(model); else set.delete(model); await this.commit({ ...this.saved, hiddenModels: [...set] }); return { success: true }; }); }
  async disconnect(account?: string) { await this.load(); return this.exclusive(async () => { const id = account ? this.select(account).id : undefined;
    for (const l of this.logins.values()) if (l.status === "pending") this.end(l, "cancelled");
    const next = { ...this.saved, accounts: id ? this.saved.accounts.filter(a => a.id !== id) : [] };
    if (!next.accounts.length) { next.models = []; next.hiddenModels = []; }
    await this.commit(next); if (!next.accounts.length) await rm(this.file, { force: true }); return { success: true }; }); }
  close() { for (const l of this.logins.values()) if (l.status === "pending") this.end(l, "cancelled"); }
}
