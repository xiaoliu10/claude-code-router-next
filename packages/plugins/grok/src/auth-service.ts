import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createGrokEngine, type Credential, type GrokEngine, type GrokModel } from "./vendor/engine.mjs";
import type { PluginHostCapabilities } from "./core-types";
import { GROK_BASE, GROK_PROVIDER, grokError, isGrokManaged, lockGrokProvider, validDeviceUrl } from "./protocol";

type Saved = { home: string; owned: boolean; credential: Credential; models: GrokModel[]; hiddenModels: string[] };
type Login = { id: string; home: string; child: ChildProcess; url: string; expiresAt: number;
  state: "pending" | "connected" | "cancelled" | "expired" | "error"; closed: Promise<void>; timer: ReturnType<typeof setTimeout>; done?: boolean; ok?: boolean };
export interface GrokUsage { known: boolean; stale: boolean; observedAt?: number; usedPercent?: number; resetAt?: number; rateLimitedUntil?: number }
export interface GrokServiceOptions {
  host: PluginHostCapabilities;
  env?: NodeJS.ProcessEnv;
  userHome?: string;
  fetch?: typeof fetch;
  loginTimeoutMs?: number;
  linkTimeoutMs?: number;
}
/** Only explicit import and device login touch external CLI homes. The official CLI owns refresh-token rotation. */
export class GrokAuthService {
  readonly engine: GrokEngine;
  readonly file: string;
  private loaded?: Promise<void>;
  private saved?: Saved;
  private login?: Login;
  private refresh?: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private disconnecting = false;
  private activeFetches = new Set<AbortController>();
  private lastError?: string;
  private coolingUntil = 0;
  private usage?: GrokUsage;
  private usageJob?: Promise<GrokUsage>;
  private readonly env: NodeJS.ProcessEnv;
  constructor(readonly options: GrokServiceOptions) {
    this.env = { ...(options.env ?? process.env) };
    this.engine = createGrokEngine({ env: this.env, userHome: options.userHome ?? homedir() });
    this.file = join(options.host.configDir, "grok-credentials.json");
  }
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const job = this.queue.then(fn); this.queue = job.catch(() => {}); return job;
  }
  private async load(): Promise<void> {
    this.loaded ??= (async () => {
      try {
        const s = JSON.parse(await readFile(this.file, "utf8"));
        if (!s || !isAbsolute(s.home) || typeof s.owned !== "boolean" || !s.credential?.key ||
          typeof s.credential.key !== "string" || !Number.isFinite(s.credential.expires) ||
          !Array.isArray(s.models) || !Array.isArray(s.hiddenModels) ||
          (s.owned && !this.ownedHome(s.home))) throw grokError("grok_credential_invalid");
        await chmod(this.file, 0o600);
        this.saved = s;
      } catch (e: any) { if (e?.code !== "ENOENT") throw grokError("grok_credential_unreadable", 500); }
    })().catch((error: unknown) => { this.loaded = undefined; throw error; });
    return this.loaded;
  }
  private ownedHome(home: string): boolean {
    const base = resolve(this.options.host.configDir, "grok-homes");
    return resolve(home) === join(base, home.split(/[\\/]/).at(-1)!) && /^[a-f0-9]{32}$/.test(home.split(/[\\/]/).at(-1)!);
  }
  private async persist(next: Saved): Promise<void> {
    await mkdir(this.options.host.configDir, { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${randomBytes(8).toString("hex")}`;
    try {
      await writeFile(temp, JSON.stringify(next), { mode: 0o600, flag: "wx" });
      await rename(temp, this.file);
      this.saved = next;
    } catch { throw grokError("grok_persist_failed", 500); }
    finally { await rm(temp, { force: true }); }
  }
  /**
   * The ONLY writers of durable state. Serialized independently of the admin
   * queue so a data-plane credential refresh cannot interleave a stale snapshot
   * between a model mutation's config write and its private persist (the lost
   * update would silently drop synced models). Each job reads the LATEST saved
   * state at execution time; a persist failure after a successful config write
   * rolls the managed entry back to the pre-mutation config.
   */
  private persistChain: Promise<void> = Promise.resolve();
  private mutate(merge: (current: Saved) => Saved, writeConfig = true): Promise<void> {
    const job = this.persistChain.then(async () => {
      const current = this.saved;
      if (!current || this.disconnecting) throw grokError("grok_not_connected", 409);
      const next = merge(current);
      if (writeConfig) {
        await this.updateConfig(next);
        try { await this.persist(next); }
        catch (error) { await this.updateConfig(current).catch(() => {}); throw error; }
      } else {
        await this.persist(next);
      }
    });
    this.persistChain = job.catch(() => {});
    return job;
  }
  private async rawConfig(): Promise<any> {
    // Writing interpolated secrets back is unsafe; require the canonical host capability.
    if (!this.options.host.readRawConfig) throw grokError("grok_raw_config_required", 500);
    return structuredClone(await this.options.host.readRawConfig());
  }
  private async updateConfig(saved?: Saved): Promise<void> {
    const cfg = await this.rawConfig();
    const before = structuredClone(cfg);
    const key = Array.isArray(cfg.providers) && !Array.isArray(cfg.Providers) ? "providers" : "Providers";
    const list: any[] = cfg[key] ?? [];
    const at = list.findIndex(isGrokManaged);
    if (saved) {
      if (at < 0 && list.some(p => p?.name === GROK_PROVIDER)) throw grokError("grok_provider_name_conflict");
      const provider = lockGrokProvider({ ...(at >= 0 ? list[at] : {}),
        models: saved.models.filter(m => !saved.hiddenModels.includes(m.id)).map(m => m.id),
        grok_models: saved.models, enabled: at >= 0 ? list[at].enabled !== false : true });
      if (at >= 0) list[at] = provider; else list.push(provider);
    } else if (at >= 0) list.splice(at, 1);
    cfg[key] = list;
    try { await this.options.host.writeConfig(cfg); await this.options.host.reloadRuntime(cfg); }
    catch {
      await this.options.host.writeConfig(before).then(() => this.options.host.reloadRuntime(before)).catch(() => {});
      throw grokError("grok_config_write_failed", 500);
    }
  }
  private async adopt(home: string, owned: boolean): Promise<void> {
    await this.load();
    if (this.saved) throw grokError("grok_already_connected", 409);
    const env = await this.childEnv(home);
    this.engine.setProxyUrl(env.HTTPS_PROXY ?? "");
    const c = await this.engine.token(home);
    if (owned && !c.who) throw grokError("grok_identity_missing");
    if (owned) await chmod(join(home, "auth.json"), 0o600);
    const next = { home, owned, credential: c, models: [], hiddenModels: [] };
    await this.persist(next);
    try { await this.updateConfig(next); }
    catch (e) { await rm(this.file, { force: true }); this.saved = undefined; throw e; }
    this.lastError = undefined;
  }
  async importCurrent(): Promise<{ success: true }> {
    return this.exclusive(async () => {
      if (!this.engine.executable()) throw grokError("grok_cli_missing");
      if (this.login?.state === "pending") throw grokError("grok_login_busy", 409);
      await this.adopt(this.engine.cliHome(), false);
      return { success: true };
    });
  }
  private async childEnv(home: string): Promise<NodeJS.ProcessEnv> {
    const cfg = await this.rawConfig();
    const proxy = cfg.SUBSCRIPTION_PROXY_URL;
    if (proxy != null && typeof proxy !== "string") throw grokError("grok_proxy_invalid");
    let url = proxy ?? "";
    // Resolve only the explicit subscription setting, never PROXY_URL or ambient proxy variables.
    if (url.startsWith("$")) url = this.env[url.slice(1)] ?? "";
    if (proxy && !url) throw grokError("grok_proxy_invalid");
    if (url) { try { if (!["http:", "https:"].includes(new URL(url).protocol)) throw 0; } catch { throw grokError("grok_proxy_invalid"); } }
    return createGrokEngine({ env: this.env, userHome: this.options.userHome, proxyUrl: url }).envFor(home);
  }
  async startLogin(): Promise<any> {
    return this.exclusive(async () => {
      await this.load();
      if (this.saved) throw grokError("grok_already_connected", 409);
      if (this.login?.state === "pending") throw grokError("grok_login_busy", 409);
      const exe = this.engine.executable();
      if (!exe) throw grokError("grok_cli_missing");
      const id = randomBytes(16).toString("hex");
      const home = join(this.options.host.configDir, "grok-homes", id);
      const env = await this.childEnv(home);
      if (process.platform !== "darwin" && process.platform !== "win32") env.BROWSER = "true";
      await mkdir(home, { recursive: true, mode: 0o700 });
      const child = spawn(exe, ["login", "--device-auth"], { cwd: this.options.host.configDir, env, stdio: ["ignore", "pipe", "pipe"] });
      let found!: (url: string) => void;
      const link = new Promise<string>(r => { found = r; });
      let close!: () => void;
      const closed = new Promise<void>(r => { close = r; });
      const job: Login = { id, home, child, url: "", expiresAt: Date.now() + (this.options.loginTimeoutMs ?? 600000),
        state: "pending", closed, timer: setTimeout(() => { void this.exclusive(async () => { if (job.state === "pending") await this.stopLogin(job, "expired"); }).catch(() => {}); }, this.options.loginTimeoutMs ?? 600000) };
      job.timer.unref(); this.login = job;
      let buffer = "";
      const inspect = (chunk: Buffer) => {
        buffer += chunk.toString();
        if (buffer.length > 65536) { found(""); void this.stopLogin(job, "error"); return; }
        for (const line of buffer.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split(/\r?\n/)) {
          if (/\berror\b/i.test(line)) continue;
          const candidate = line.match(/https:\/\/[^\s<>"']+/)?.[0]?.replace(/[.,;)\]]+$/, "");
          if (candidate && validDeviceUrl(candidate)) { job.url = candidate; found(candidate); }
        }
      };
      child.stdout!.on("data", inspect); child.stderr!.on("data", inspect);
      child.once("error", () => { job.done = true; job.ok = false; found(""); close(); });
      child.once("close", code => { job.done = true; job.ok = code === 0; found(job.url); close(); });
      let timer!: ReturnType<typeof setTimeout>;
      const url = await Promise.race([link, new Promise<string>(r => { timer = setTimeout(() => r(""), this.options.linkTimeoutMs ?? 30000); })]);
      clearTimeout(timer);
      if (!url || job.state !== "pending") { await this.stopLogin(job, "error"); throw grokError("grok_login_failed"); }
      return { loginId: id, url, expiresAt: job.expiresAt, opened: process.platform === "darwin" || process.platform === "win32" };
    });
  }
  private async stopLogin(job: Login, state: Login["state"]): Promise<void> {
    job.state = state; clearTimeout(job.timer);
    if (!job.done) { job.child.kill("SIGKILL"); await job.closed; }
    if (this.ownedHome(job.home)) await rm(job.home, { recursive: true, force: true });
  }
  async pollLogin(id: string): Promise<any> {
    return this.exclusive(async () => {
      const job = this.login;
      if (!job || job.id !== id) throw grokError("grok_login_unknown");
      if (job.state === "pending" && job.done) {
        if (!job.ok) await this.stopLogin(job, "error");
        else {
          clearTimeout(job.timer);
          try { await this.adopt(job.home, true); job.state = "connected"; }
          catch { await this.stopLogin(job, "error"); }
        }
      }
      return { status: job.state };
    });
  }
  async cancelLogin(id: string): Promise<any> {
    return this.exclusive(async () => {
      if (!this.login || this.login.id !== id) throw grokError("grok_login_unknown");
      if (this.login.state === "pending") await this.stopLogin(this.login, "cancelled");
      return { success: true };
    });
  }
  async getAccessToken(): Promise<string> {
    await this.load();
    if (!this.saved || this.disconnecting) throw grokError("grok_not_connected", 409);
    if (this.saved.credential.expires - Date.now() < 300000) await this.forceTokenRefresh(false);
    return this.saved!.credential.key;
  }
  async forceTokenRefresh(force = true): Promise<void> {
    await this.load();
    if (!this.saved || this.disconnecting) throw grokError("grok_not_connected", 409);
    if (this.refresh) return this.refresh;
    const saved = this.saved, generation = this.generation;
    this.refresh = (async () => {
      try {
        // Preserve per-home single-flight and torn-read cache across operations.
        const env = await this.childEnv(saved.home);
        this.engine.setProxyUrl(env.HTTPS_PROXY ?? "");
        const c = await this.engine.token(saved.home, force ? saved.credential.key : false);
        if (generation !== this.generation || this.saved?.home !== saved.home || this.disconnecting) throw grokError("grok_not_connected", 409);
        // Models/hidden state is merged from the CURRENT durable state at chain
        // execution time, never from the pre-refresh snapshot.
        await this.mutate(current => ({ ...current, credential: c }), false);
        this.lastError = undefined;
      } catch (error: any) {
      // Infrastructure failures are not "expired": surface and latch them honestly.
      if (["grok_persist_failed", "grok_raw_config_required", "grok_proxy_invalid"].includes(error?.code)) {
        this.lastError = "grok_upstream_error"; throw error;
      }
      this.lastError = "grok_reauth_required"; throw grokError("grok_reauth_required");
    }
    })().finally(() => { this.refresh = undefined; });
    return this.refresh;
  }
  async signHeaders(headers: Headers): Promise<void> {
    const key = await this.getAccessToken();
    const env = await this.childEnv(this.saved!.home);
    this.engine.setProxyUrl(env.HTTPS_PROXY ?? "");
    await this.engine.sign(headers, key);
  }
  private async request(path: "/models" | "/billing?format=credits"): Promise<Response> {
    const send = async () => {
      const headers = new Headers({ Accept: "application/json" });
      await this.signHeaders(headers);
      const controller = new AbortController(); this.activeFetches.add(controller);
      try {
        // Include body consumption in the timeout and disconnect lifetime.
        const response = await (this.options.fetch ?? fetch)(`${GROK_BASE}${path}`, { headers, redirect: "error", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
          dispatcher: this.options.host.getSubscriptionDispatcher?.() ?? this.options.host.getDirectDispatcher() } as RequestInit);
        const body = await response.arrayBuffer();
        return new Response(body, { status: response.status, headers: response.headers });
      } finally { this.activeFetches.delete(controller); }
    };
    let response = await send();
    if (response.status === 401) { await response.body?.cancel(); await this.forceTokenRefresh(); response = await send(); }
    if (!response.ok) { await response.body?.cancel(); throw grokError(response.status === 401 ? "grok_reauth_required" : "grok_upstream_error"); }
    return response;
  }
  async syncModels(): Promise<any> {
    return this.exclusive(async () => {
      await this.load();
      if (!this.saved || this.disconnecting) throw grokError("grok_not_connected", 409);
      let body: any;
      try { body = await (await this.request("/models")).json(); }
      catch (error) { if ((error as any)?.code) throw error; throw grokError("grok_upstream_error"); }
      const models: GrokModel[] = [];
      for (const d of Array.isArray(body?.data) ? body.data : []) {
        if (typeof d?.id !== "string" || !d.id || (d.api_backend && d.api_backend !== "responses")) continue;
        models.push(...this.engine.windowsOf(d, (Array.isArray(d.reasoning_efforts) ? d.reasoning_efforts : []).map((e: any) => e?.value).filter((e: any) => typeof e === "string").reverse()));
      }
      if (!models.length) throw grokError("grok_models_empty");
      this.noteUpstreamSuccess();
      await this.mutate(current => ({ ...current, models }));
      return { success: true, models: models.map(m => m.id), modelCount: models.length };
    });
  }
  async setModelHidden(id: string, hidden: boolean): Promise<any> {
    return this.exclusive(async () => {
      await this.load();
      if (!this.saved?.models.some(m => m.id === id)) throw grokError("grok_model_unknown");
      await this.mutate(current => ({ ...current,
        hiddenModels: [...new Set([...current.hiddenModels.filter(m => m !== id), ...(hidden ? [id] : [])])] }));
      return { success: true };
    });
  }
  async getUsage(): Promise<GrokUsage> {
    if (this.usageJob) return this.usageJob;
    this.usageJob = (async () => {
      try {
        const data: any = await (await this.request("/billing?format=credits")).json();
        const value = data?.config?.creditUsagePercent;
        // A well-formed reading (zero used is legitimate; missing is not) is the
        // only quota shape that counts as validated success for healing.
        if (typeof value !== "number" || !Number.isFinite(value)) throw 0;
        this.noteUpstreamSuccess();
        const end = Date.parse(data.config.currentPeriod?.end ?? data.config.billingPeriodEnd ?? "");
        this.usage = { known: true, stale: false, observedAt: Date.now(), usedPercent: Math.min(100, Math.max(0, value)), ...(Number.isFinite(end) ? { resetAt: end } : {}) };
      } catch { return { ...(this.usage ?? { known: false }), stale: !!this.usage, rateLimitedUntil: this.coolingUntil }; }
      return { ...this.usage!, rateLimitedUntil: this.coolingUntil };
    })().finally(() => { this.usageJob = undefined; });
    return this.usageJob;
  }
  /**
   * Latched account state (reauth/expired, rate cooldown) heals ONLY on a
   * validated successful upstream exchange — a legitimate data-plane terminal,
   * a synced non-empty model list, or a well-formed quota reading. Missing or
   * malformed quota never counts as success, so a billing failure cannot
   * override a 429 cooldown and a 200 SSE carrying a failure never heals.
   */
  noteUpstreamSuccess(): void {
    this.lastError = undefined;
    this.coolingUntil = 0;
  }
  async noteUpstreamError(info: { code: string; cooldownMs?: number }): Promise<void> {
    this.lastError = ["grok_reauth_required", "grok_rate_limited", "grok_upstream_error"].includes(info.code) ? info.code : "grok_upstream_error";
    if (info.code === "grok_rate_limited") this.coolingUntil = Date.now() + Math.min(info.cooldownMs ?? 300000, 3600000);
  }
  async ensureUsable(): Promise<void> {
    await this.load();
    if (!this.saved || this.disconnecting) throw grokError("grok_not_connected", 409);
    if (this.coolingUntil > Date.now()) throw grokError("grok_rate_limited", 429);
  }
  async getStatus(): Promise<any> {
    await this.load();
    const models = this.saved?.models ?? [];
    return { status: this.saved ? (this.lastError === "grok_reauth_required" ? "expired" : "connected") : "not_connected",
      providerName: GROK_PROVIDER, account: this.saved?.credential.who ? `${this.saved.credential.who.slice(0, 3)}…` : undefined,
      models: models.map(m => ({ id: m.id, context: m.context, efforts: m.efforts, hidden: this.saved!.hiddenModels.includes(m.id) })),
      modelCount: models.length, lastError: this.lastError, coolingUntil: this.coolingUntil };
  }
  async disconnect(): Promise<any> {
    return this.exclusive(async () => {
      // Teardown must survive a corrupt credential file: remove config + file.
      await this.load().catch(() => {});
      if (this.login?.state === "pending") await this.stopLogin(this.login, "cancelled");
      this.disconnecting = true;
      this.engine.cancelPending();
      for (const controller of this.activeFetches) controller.abort();
      await this.refresh?.catch(() => {});
      await this.usageJob?.catch(() => {});
      // A queued mutation (e.g. a refresh persist started before disconnect) must
      // finish before the credential file is removed, so no writer resurrects it.
      await this.persistChain.catch(() => {});
      try { await this.updateConfig(); } catch (e) { this.disconnecting = false; throw e; }
      const old = this.saved;
      await rm(this.file, { force: true }); this.saved = undefined; this.generation++;
      if (old?.owned && this.ownedHome(old.home)) await rm(old.home, { recursive: true, force: true });
      this.usage = undefined; this.lastError = undefined; this.coolingUntil = 0; this.disconnecting = false;
      return { success: true };
    });
  }
}
