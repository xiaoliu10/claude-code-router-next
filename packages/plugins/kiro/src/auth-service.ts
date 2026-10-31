import { constants } from "node:fs";
import { open, mkdir, rename, unlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { PluginHostCapabilities, PluginClassifiedError } from "./core-types";
import { KIRO_SITE, KIRO_PROVIDER, CALLBACK_PORTS, BUILDER_ID_START, BUILDER_ID_PROFILE, KIRO_SCOPES, DEFAULT_REGION, authURL, refreshURL, managementURL, oidcURL, validRegion, validStartUrl, kiroError, isKiroManaged, lockKiroProvider } from "./protocol";

export type KiroLoginMethod = "portal" | "builderid" | "idc";
export interface KiroCredential {
  id: string; uid: string; email: string; accountId: string; access: string; refresh: string; expires: number;
  method: "social" | "idc"; loginProvider: string; region: string; profile: string; clientId?: string; clientSecret?: string;
  plan?: string; needReauth?: boolean; coolingUntil?: number;
}
export interface KiroModelRecord { id: string; key: string; name: string; context: number; output: number; images: boolean }
export interface KiroUsageSnapshot { known: boolean; stale: boolean; plan?: string; user?: string; observedAt?: number;
  windows: Array<{ name: string; used: number; amount: number; limit: number; unit: string; display: string; resetsAt?: string }> }
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
  private exclusive<T>(action: () => Promise<T>): Promise<T> { const job = this.queue.then(action); this.queue = job.catch(() => {}); return job; }
  private validate(value: Json): Saved {
    if (value?.version !== 1) throw kiroError("kiro_credential_invalid");
    // Accept the original single-credential envelope and magpie field aliases.
    const list = value.accounts ?? (value.credential ? [value.credential] : []);
    if (!Array.isArray(list) || list.length > 128 || !Array.isArray(value.models ?? []) || !Array.isArray(value.hiddenModels ?? [])) throw kiroError("kiro_credential_invalid");
    const accounts = list.map((v: Json): KiroCredential => {
      const provider = String(v.loginProvider ?? v.uid ?? "").toLowerCase();
      const uid = provider === "awsidc" ? "enterprise" : provider;
      const region = v.region ?? DEFAULT_REGION, access = v.access ?? v.accessToken, refresh = v.refresh ?? v.refreshToken ?? "";
      const expires = v.expires ?? Date.parse(v.expiresAt ?? "");
      if ((v.id !== undefined && (!text(v.id, 128) || !v.id)) || !text(v.accountId ?? "", 2048)) throw kiroError("kiro_credential_invalid");
      if (!text(access) || !access || !text(refresh) || !Number.isFinite(expires) || !validRegion(region) || !text(uid, 128) || !text(v.email ?? "", 1024) || !text(v.profile ?? v.profileArn ?? "", 2048) || !text(v.clientId ?? "") || !text(v.clientSecret ?? "")) throw kiroError("kiro_credential_invalid");
      const email = v.email ?? "", accountId = email ? `${email}${names[uid] ? ` (${names[uid]})` : ""}` : v.accountId ?? "Kiro account";
      return { id: v.id ?? createHash("sha256").update(`${email}:${uid}:${email ? "" : access}`).digest("hex").slice(0, 24), uid, email, accountId,
        access, refresh, expires, method: v.method === "idc" || ["builderid", "enterprise", "internal"].includes(uid) ? "idc" : "social", loginProvider: uid,
        region, profile: v.profile ?? v.profileArn ?? (uid === "builderid" ? BUILDER_ID_PROFILE : ""), clientId: v.clientId, clientSecret: v.clientSecret,
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
        this.saved = this.validate(JSON.parse(await handle.readFile("utf8"))); await handle.chmod(0o600);
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw kiroError("kiro_credential_unreadable", 500); }
      finally { await handle?.close(); }
    })().catch(e => { this.loaded = undefined; throw e; });
    return this.loaded;
  }
  private async persist(next: Saved) {
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
    try { await host.writeConfig(cfg); await host.reloadRuntime(cfg); }
    catch { await host.writeConfig(previous).then(() => host.reloadRuntime(previous)).catch(() => {}); throw kiroError("kiro_config_write_failed", 500); }
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
    if (!res.ok) { await res.body?.cancel(); throw kiroError([401, 403].includes(res.status) ? "kiro_reauth_required" : "kiro_upstream_error", [401, 403].includes(res.status) ? 401 : 502); }
    try { return await res.json() as Json; } catch { throw kiroError("kiro_upstream_error", 502); }
  }
  private management(c: KiroCredential, operation: string, query: Record<string, string> = {}, body?: Json) {
    const q = new URLSearchParams({ origin: "KIRO_CLI", profileArn: c.profile, ...query });
    return this.request(`${managementURL(c.region)}/${operation}${body ? "" : `?${q}`}`, body, c.access);
  }
  private async identify(c: KiroCredential) {
    if (c.uid === "builderid") c.profile = BUILDER_ID_PROFILE;
    else if (!c.profile) { const p = await this.management(c, "List-Available-Profiles", {}, {}); c.profile = p.profiles?.find((v: Json) => typeof v.arn === "string")?.arn ?? ""; }
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
    // Bound pending listeners and retained terminal sessions.
    for (const l of this.logins.values()) if (l.status === "pending") this.end(l, "cancelled");
    while (this.logins.size >= 32) this.logins.delete(this.logins.keys().next().value!);
    const { server, port } = await this.listen();
    const l: Login = { id: randomUUID(), server, port, timer: undefined as unknown as ReturnType<typeof setTimeout>, state: secret(), verifier: secret(), stage: "portal", region: input.region ?? DEFAULT_REGION, status: "pending", url: "" };
    l.timer = setTimeout(() => this.end(l, "expired"), 600_000); l.timer.unref(); this.logins.set(l.id, l);
    server.on("request", async (req, res) => {
      res.setHeader("Connection", "close");
      try { const result = await this.completeLogin(l.id, `http://127.0.0.1:${port}${req.url}`);
        if (result.status === "pending") { res.writeHead(302, { Location: l.url }); res.end(); }
        else { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end("<!doctype html><title>Kiro</title>Signed in. You can close this tab."); }
      } catch { res.writeHead(400, { "Content-Type": "text/plain" }); res.end("Kiro callback rejected. Return to CCR to continue."); }
    });
    try {
      if (input.method === "portal") l.url = `${KIRO_SITE.web}/signin?${new URLSearchParams({ state: l.state, code_challenge: challenge(l.verifier), code_challenge_method: "S256", redirect_uri: `http://localhost:${port}`, redirect_from: "KiroIDE" })}`;
      else await this.startAWS(l, input.method === "idc" ? "enterprise" : "builderid", input.method === "idc" ? input.startUrl! : BUILDER_ID_START, l.region);
      return { loginId: l.id, url: l.url };
    } catch (e) { this.end(l, "failed"); throw e; }
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
    try {
      const q = u.searchParams; if (q.has("error")) { this.end(l, "failed"); throw kiroError("kiro_login_failed"); }
      if (l.stage === "portal" && ["builderid", "awsidc", "internal"].includes(q.get("login_option") ?? "")) {
        await this.startAWS(l, q.get("login_option") === "awsidc" ? "enterprise" : q.get("login_option")!, q.get("issuer_url")!, q.get("idc_region")!);
        return { status: "pending", url: l.url };
      }
      const provider = l.stage === "aws" ? l.provider! : q.get("login_option")!;
      if (!q.get("code") || (l.stage === "portal" && !["google", "github"].includes(provider))) throw kiroError("kiro_callback_invalid");
      const t = l.stage === "aws" ? await this.request(`${oidcURL(l.region)}/token`, { clientId: l.clientId, clientSecret: l.clientSecret, grantType: "authorization_code", redirectUri: `http://127.0.0.1:${l.port}/oauth/callback`, code: q.get("code"), codeVerifier: l.verifier }) :
        await this.request(`${authURL(l.region)}/oauth/token`, { code: q.get("code"), code_verifier: l.verifier, redirect_uri: `http://localhost:${l.port}${u.pathname}?login_option=${provider}` });
      if (!text(t.accessToken) || !t.accessToken) throw kiroError("kiro_login_failed", 502);
      const c: KiroCredential = { id: randomUUID(), uid: provider, email: "", accountId: "Kiro account", access: t.accessToken, refresh: t.refreshToken ?? "", expires: this.now() + (Number(t.expiresIn) > 0 ? Number(t.expiresIn) : 3600) * 1000,
        method: l.stage === "aws" ? "idc" : "social", loginProvider: provider, region: l.region, profile: t.profileArn ?? "", clientId: l.clientId, clientSecret: l.clientSecret };
      await this.identify(c);
      await this.exclusive(async () => { if (l.status !== "pending") throw kiroError("kiro_login_cancelled", 409);
        const old = this.saved.accounts.find(a => a.uid === c.uid && a.email === c.email && !!c.email); if (old) c.id = old.id;
        await this.commit({ ...this.saved, accounts: [...this.saved.accounts.filter(a => a.id !== c.id), c] });
        l.account = publicAccount(c); this.end(l, "complete"); });
      return { status: "complete", account: l.account };
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
        const t = await this.request(c.method === "idc" ? `${oidcURL(c.region)}/token` : refreshURL(c.region), c.method === "idc" ? { clientId: c.clientId, clientSecret: c.clientSecret, refreshToken: c.refresh, grantType: "refresh_token" } : { refreshToken: c.refresh });
        if (!text(t.accessToken) || !t.accessToken) throw kiroError("kiro_reauth_required", 401);
        const next = { ...c, access: t.accessToken, refresh: t.refreshToken || c.refresh, expires: this.now() + (Number(t.expiresIn) > 0 ? Number(t.expiresIn) : 3600) * 1000, profile: t.profileArn ?? c.profile };
        await this.exclusive(async () => { if (!this.saved.accounts.includes(c)) throw kiroError("kiro_not_connected", 409); await this.persist({ ...this.saved, accounts: this.saved.accounts.map(a => a === c ? next : a) }); }); return { ...next };
      } catch (e) { if ((e as { code?: string }).code === "kiro_reauth_required") await this.markError(c, { code: "kiro_reauth_required", cooldownMs: 3_600_000 }); throw e; }
      finally { this.refreshes.delete(c.id); }
    })(); this.refreshes.set(c.id, job); return job;
  }
  private markError(c: KiroCredential, info: { code: string; cooldownMs?: number }) { return this.exclusive(async () => { if (!this.saved.accounts.includes(c)) return;
    await this.persist({ ...this.saved, accounts: this.saved.accounts.map(a => a === c ? { ...a, needReauth: info.code === "kiro_reauth_required" || a.needReauth, coolingUntil: this.now() + Math.min(info.cooldownMs ?? 300_000, 3_600_000) } : a) }); }); }
  async noteUpstreamError(info: PluginClassifiedError, account?: string) { await this.load(); try { await this.markError(this.select(account), info); } catch { /* Telemetry never breaks the response path. */ } }
  async getStatus() { await this.load(); return { connected: !!this.saved.accounts.length, status: this.saved.accounts.length ? "connected" : "disconnected", providerName: KIRO_PROVIDER,
    accounts: this.saved.accounts.map(publicAccount), models: this.saved.models, hiddenModels: this.saved.hiddenModels, plan: this.saved.accounts[0]?.plan ?? null,
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
