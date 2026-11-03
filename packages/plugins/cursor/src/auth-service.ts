import { constants } from "node:fs";
import { open, mkdir, chmod, rename, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { _internal, type CursorAuth, type CursorModelInfo, type CursorSignInResult, type CursorSignInMethod, type CursorUsageWindow } from "./vendor/engine.mjs";
import { nativeSessions } from "./vendor/native-session.mjs";
import type { PluginHostCapabilities } from "./core-types";
import {
  CURSOR_CREDENTIAL_FILE, CURSOR_MARKER, CURSOR_PROVIDER,
  clampCursorCooldown, cursorError, isCursorManaged, lockCursorProvider,
} from "./protocol";

/**
 * Normalized model record kept in the private credential file: exactly the
 * fields status/card render (id, display name, context). Everything else the
 * engine listing carries (variants, parameters, usable ids) is shed at sync
 * time — vendor payloads never persist here.
 */
export interface CursorModelRecord { key: string; name: string; context: number }

/**
 * One of the three sign-ins Cursor accounts are made of:
 * - `browser`: the PKCE sign-in cursor-agent does; the token is NEVER renewed
 *   (the engine holds no refresh path for it) — expiry requires re-login;
 * - `cli`: the import of what `cursor-agent login` keeps (Mac keychain, else
 *   its auth.json), read fresh each request and never written;
 * - `api`: a Cursor API key, exchanged for a token per request as the CLI does
 *   with CURSOR_API_KEY.
 */
export type CursorCredential =
  | { type: "browser"; access: string; refresh: string; expires: number; accountId?: string; plan?: string }
  | { type: "cli"; accountId?: string; plan?: string }
  | { type: "api"; key: string; accountId?: string; plan?: string };

type Saved = { version: 1; credential: CursorCredential; models: CursorModelRecord[] };

export interface CursorLoginState {
  state: "idle" | "pending" | "success" | "failed" | "cancelled";
  url?: string;
  error?: string;
}

export interface CursorServiceOptions {
  host: PluginHostCapabilities;
  /** Test seam: inject a fake engine internal seam; the real one is the vendored module. */
  engine?: typeof _internal;
}

export interface CursorUsageSnapshot {
  known: boolean;
  stale: boolean;
  observedAt?: number;
  windows: CursorUsageWindow[];
  plan?: string;
  coolingUntil?: number;
}

const USAGE_CACHE_MS = 60_000;
const DEFAULT_429_COOLDOWN_MS = 300_000;
const FILE_MAX_BYTES = 1_048_576;
const MAX_LOGIN_POLLS_MS = 10 * 60_000; // upstream polls at most ~10 minutes

const field = (v: unknown, max: number): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= max && !/[\x00-\x1f]/.test(v);
const softField = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
// accountId/plan are OPTIONAL on every credential variant (Cursor simply may
// not report them); absent must validate, only a present-but-invalid value
// rejects — otherwise no CLI import or bare browser credential could ever
// persist (found by the adapter suite: softField(undefined) is false).
const optSoftField = (v: unknown, max: number): v is string | undefined => v === undefined || softField(v, max);

const validModelRecords = (v: unknown): v is CursorModelRecord[] =>
  Array.isArray(v) && v.length <= 512 && v.every(m => m != null && typeof m === "object" &&
    field(m.key, 256) && softField(m.name, 256) && typeof m.context === "number" &&
    Number.isFinite(m.context) && m.context >= 0);

/** Strict on-disk shape: version, credential fields, capped model arrays. */
function validate(value: any): Saved {
  const c = value?.credential;
  const okBase = value?.version === 1 && c && typeof c === "object" && validModelRecords(value.models);
  if (!okBase) throw cursorError("cursor_credential_invalid");
  let credential: CursorCredential;
  if (c.type === "browser") {
    if (!field(c.access, 32768) || !softField(c.refresh, 32768) || !Number.isFinite(c.expires) ||
        !optSoftField(c.accountId, 1024) || !optSoftField(c.plan, 256)) throw cursorError("cursor_credential_invalid");
    credential = { type: "browser", access: c.access, refresh: c.refresh, expires: c.expires,
      ...(c.accountId !== undefined ? { accountId: c.accountId } : {}), ...(c.plan !== undefined ? { plan: c.plan } : {}) };
  } else if (c.type === "cli") {
    if (!optSoftField(c.accountId, 1024) || !optSoftField(c.plan, 256)) throw cursorError("cursor_credential_invalid");
    credential = { type: "cli", ...(c.accountId !== undefined ? { accountId: c.accountId } : {}), ...(c.plan !== undefined ? { plan: c.plan } : {}) };
  } else if (c.type === "api") {
    if (!field(c.key, 4096) || !optSoftField(c.accountId, 1024) || !optSoftField(c.plan, 256)) throw cursorError("cursor_credential_invalid");
    credential = { type: "api", key: c.key,
      ...(c.accountId !== undefined ? { accountId: c.accountId } : {}), ...(c.plan !== undefined ? { plan: c.plan } : {}) };
  } else {
    throw cursorError("cursor_credential_invalid");
  }
  return { version: 1, credential, models: value.models.map((m: CursorModelRecord) => ({ key: m.key, name: m.name, context: m.context })) };
}

/** Public account recognition only: the email local part is masked. */
export function maskEmail(email: string | undefined): string | null {
  if (!email) return null;
  const at = email.indexOf("@");
  if (at <= 0) return null;
  return `${email[0]}***${email.slice(at)}`;
}

function toRecord(m: CursorModelInfo): CursorModelRecord {
  return { key: String(m.id), name: String(m.name ?? m.id), context: Number(m.context) || 0 };
}

/**
 * The saved credential as the engine's auth object (upstream tokenOf's three
 * shapes). The CLI mark is spelled by the engine itself; a browser credential
 * carries whatever Cursor answered (refresh token or "none") — the engine
 * never uses it to renew, and this adapter never pretends otherwise.
 */
function toEngineAuth(c: CursorCredential): CursorAuth {
  if (c.type === "api") return { type: "api", key: c.key };
  if (c.type === "cli") return { type: "oauth", access: "", refresh: _internal.CLI_MARK, expires: 0 };
  return { type: "oauth", access: c.access, refresh: c.refresh, expires: c.expires };
}

/**
 * One connected identity over the vendored engine, serialized mutations
 * (qoder's service structure) over cursor's persistence hygiene
 * (O_NOFOLLOW/O_EXCL + fsync + rename, ≤1MB file, strict validate). The
 * engine seam is injectable for offline tests; the real one is the vendored
 * module whose transport the plugin configures at activation.
 */
export class CursorAuthService {
  readonly engine: typeof _internal;
  readonly file: string;
  private loaded?: Promise<void>;
  private saved?: Saved;
  private queue: Promise<unknown> = Promise.resolve();
  private persistChain: Promise<void> = Promise.resolve();
  private generation = 0;
  private disconnecting = false;
  private expired = false;
  private lastError?: string;
  private coolingUntil = 0;
  private usage?: CursorUsageSnapshot & { observedAt: number };
  private usageJob?: Promise<CursorUsageSnapshot>;
  /** In-flight data-plane requests: disconnect aborts them (coreApi=1 gives no other disposal hook). */
  private active = new Set<AbortController>();
  /** The pending browser sign-in job, if any. */
  private login?: {
    controller: AbortController;
    job: Promise<CursorSignInResult>;
    url: string;
    startedAt: number;
    outcome: null | { state: "success" | "failed" | "cancelled"; error?: string };
  };

  constructor(readonly options: CursorServiceOptions) {
    this.engine = options.engine ?? _internal;
    this.file = join(options.host.configDir, CURSOR_CREDENTIAL_FILE);
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const job = this.queue.then(fn); this.queue = job.catch(() => {}); return job;
  }

  private async load(): Promise<void> {
    this.loaded ??= (async () => {
      let handle;
      try {
        handle = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > FILE_MAX_BYTES) throw cursorError("cursor_credential_invalid");
        await handle.chmod(0o600);
        this.saved = validate(JSON.parse(await handle.readFile("utf8")));
      } catch (e: any) { if (e?.code !== "ENOENT") throw cursorError("cursor_credential_unreadable", 500); }
      finally { await handle?.close(); }
    })().catch((error: unknown) => { this.loaded = undefined; throw error; });
    return this.loaded;
  }

  /** Validate and serialize before replacing the file. The loader must never
   *  accept a state this writer created, and JSON byte growth is bounded. */
  private serializeSaved(next: Saved): string {
    const checked = validate(next);
    const text = JSON.stringify(checked);
    if (Buffer.byteLength(text, "utf8") > FILE_MAX_BYTES) throw cursorError("cursor_persist_failed", 500);
    return text;
  }

  private async persist(next: Saved): Promise<void> {
    await mkdir(this.options.host.configDir, { recursive: true, mode: 0o700 });
    const text = this.serializeSaved(next);
    const temp = `${this.file}.${randomBytes(12).toString("hex")}.tmp`;
    let handle;
    try {
      handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(text);
      await handle.sync();
      await handle.close(); handle = undefined;
      await rename(temp, this.file);
      this.saved = next;
    } catch { throw cursorError("cursor_persist_failed", 500); }
    finally { await handle?.close(); await unlink(temp).catch(() => {}); }
  }

  /**
   * The ONLY writers of durable state: each job re-reads the latest saved
   * state at execution time, writes config first and persists after; a
   * persist failure after a successful config write rolls the managed entry
   * back so config never names models the private file lost.
   */
  private mutate(merge: (current: Saved) => Saved, writeConfig = true): Promise<void> {
    const job = this.persistChain.then(async () => {
      const current = this.saved;
      if (!current || this.disconnecting) throw cursorError("cursor_not_connected", 409);
      const next = merge(current);
      if (writeConfig) {
        await this.updateConfig(next);
        try { await this.persist(next); }
        catch (error) { await this.updateConfig(undefined).catch(() => {}); throw error; }
      } else {
        await this.persist(next);
      }
    });
    this.persistChain = job.catch(() => {});
    return job;
  }

  private async rawConfig(): Promise<any> {
    // Writing interpolated secrets back is unsafe; require the canonical host capability.
    if (!this.options.host.readRawConfig) throw cursorError("cursor_raw_config_required", 500);
    return structuredClone(await this.options.host.readRawConfig());
  }

  private async updateConfig(saved?: Saved): Promise<void> {
    const cfg = await this.rawConfig();
    const before = structuredClone(cfg);
    const key = Array.isArray(cfg.providers) && !Array.isArray(cfg.Providers) ? "providers" : "Providers";
    const list: any[] = cfg[key] ?? [];
    const at = list.findIndex((p: any) => isCursorManaged(p) || p?.name === CURSOR_PROVIDER);
    if (saved) {
      if (at < 0 && list.some(p => p?.name === CURSOR_PROVIDER)) throw cursorError("cursor_provider_name_conflict");
      const provider = lockCursorProvider({ ...(at >= 0 ? list[at] : {}),
        models: saved.models.map(m => m.key),
        enabled: at >= 0 ? list[at].enabled !== false : true });
      if (at >= 0) list[at] = provider; else list.push(provider);
    } else if (at >= 0) list.splice(at, 1);
    cfg[key] = list;
    try { await this.options.host.writeConfig(cfg); await this.options.host.reloadRuntime(cfg); }
    catch {
      await this.options.host.writeConfig(before).then(() => this.options.host.reloadRuntime(before)).catch(() => {});
      throw cursorError("cursor_config_write_failed", 500);
    }
  }

  /**
   * Circuit breaker BEFORE any refresh/network work (Gemini lesson, contract).
   * A browser token past its expiry fails closed here — there is no refresh
   * to spend: Cursor's browser sign-in has nothing to renew it with, so
   * expiry requires re-login.
   */
  async ensureUsable(): Promise<void> {
    await this.load();
    if (!this.saved || this.disconnecting) throw cursorError("cursor_not_connected", 409);
    if (this.coolingUntil > Date.now()) throw cursorError("cursor_rate_limited", 429);
    if (this.expired) throw cursorError("cursor_reauth_required", 401);
    const c = this.saved.credential;
    if (c.type === "browser" && c.expires > 0 && c.expires <= Date.now()) {
      this.expired = true;
      this.lastError = "cursor_reauth_required";
      throw cursorError("cursor_reauth_required", 401);
    }
  }

  /** Resolve the account's token through the engine (CLI/API-key paths may hit upstream). */
  private async engineToken(): Promise<string> {
    await this.load();
    if (!this.saved || this.disconnecting) throw cursorError("cursor_not_connected", 409);
    try { return await this.engine.tokenOf(toEngineAuth(this.saved.credential)); }
    catch (e: any) {
      if (e instanceof this.engine.AuthError || e?.status === 401) {
        this.expired = true;
        this.lastError = "cursor_reauth_required";
        throw cursorError("cursor_reauth_required", 401);
      }
      throw e?.code ? e : cursorError("cursor_upstream_error", 502);
    }
  }

  private waitWithSignal<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return work;
    if (signal.aborted) return Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    return new Promise<T>((resolve, reject) => {
      const stop = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      signal.addEventListener("abort", stop, { once: true });
      work.then(
        value => { signal.removeEventListener("abort", stop); resolve(value); },
        error => { signal.removeEventListener("abort", stop); reject(error); },
      );
    });
  }

  /**
   * One bounded engine chat transaction for the managed runtime's
   * dispatchRequest. The engine folds every upstream failure into an
   * errorResponse Response; the runtime classifies it. The controller joins
   * `active` so disconnect aborts in-flight work.
   */
  async dispatch(chatBody: any, signal?: AbortSignal): Promise<Response> {
    await this.ensureUsable();
    if (!this.saved || this.disconnecting) throw cursorError("cursor_not_connected", 409);
    const controller = new AbortController();
    const stop = () => controller.abort();
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) controller.abort();
    this.active.add(controller);
    try {
      const auth = toEngineAuth(this.saved.credential);
      const session = typeof chatBody?.prompt_cache_key === "string" ? chatBody.prompt_cache_key : "";
      return await this.waitWithSignal(this.engine.answer(auth, chatBody, controller.signal, session), signal);
    } finally {
      this.active.delete(controller);
      signal?.removeEventListener("abort", stop);
    }
  }

  // ---- sign-ins -----------------------------------------------------------------------

  /** The pending browser sign-in, started with the engine's PKCE flow. */
  async startBrowserLogin(): Promise<{ url: string }> {
    return this.exclusive(async () => {
      await this.load();
      if (this.saved) throw cursorError("cursor_already_connected", 409);
      if (this.login && this.login.outcome === null && Date.now() - this.login.startedAt < MAX_LOGIN_POLLS_MS) {
        throw cursorError("cursor_login_busy", 409);
      }
      const controller = new AbortController();
      const method: CursorSignInMethod = this.engine.browserSignIn(controller.signal);
      const generation = this.generation;
      const startedAt = Date.now();
      const job = method.callback().then(async (result): Promise<CursorSignInResult> => {
        if (generation !== this.generation || this.disconnecting) {
          // A disconnect (or a newer login) landed meanwhile: never resurrect
          // the older job's outcome.
          return { type: "failed", error: "superseded" };
        }
        if (result.type !== "success") return result;
        const credential: CursorCredential = {
          type: "browser", access: result.access, refresh: result.refresh, expires: result.expires,
          ...(result.accountId ? { accountId: result.accountId } : {}),
          ...(result.plan ? { plan: result.plan } : {}),
        };
        await this.persistNewCredential(credential);
        return result;
      });
      this.login = { controller, job, url: method.url, startedAt, outcome: null };
      void job.then(result => {
        if (!this.login || this.login.job !== job) return; // superseded by a newer job or disconnect
        this.login.outcome = result.type === "success" ? { state: "success" }
          : result.error === "the sign-in was cancelled" ? { state: "cancelled", error: result.error }
          : { state: "failed", error: result.error };
      }).catch((error: any) => {
        if (this.login?.job === job) this.login.outcome = { state: "failed", error: String(error?.message ?? error) };
      });
      return { url: method.url };
    });
  }

  loginState(): CursorLoginState {
    if (!this.login) return { state: "idle" };
    if (this.login.outcome) {
      return { state: this.login.outcome.state, ...(this.login.outcome.error ? { error: this.login.outcome.error } : {}) };
    }
    if (Date.now() - this.login.startedAt > MAX_LOGIN_POLLS_MS) {
      this.login.controller.abort();
      this.login.outcome = { state: "failed", error: "the sign-in timed out" };
      return { state: "failed", error: "the sign-in timed out" };
    }
    return { state: "pending", url: this.login.url };
  }

  cancelLogin(): { success: true } {
    if (this.login && this.login.outcome === null) {
      this.login.controller.abort();
      this.login.outcome = { state: "cancelled", error: "the sign-in was cancelled" };
    }
    return { success: true };
  }

  /** Import the account `cursor-agent login` signed in to; its token is read fresh each request. */
  async connectCli(): Promise<{ success: true }> {
    return this.exclusive(async () => {
      await this.load();
      if (this.saved) throw cursorError("cursor_already_connected", 409);
      const result = await this.engine.cliSignIn().callback();
      if (result.type !== "success") throw Object.assign(cursorError("cursor_login_failed", 422), { detail: result.error });
      const credential: CursorCredential = { type: "cli",
        ...(result.accountId ? { accountId: result.accountId } : {}), ...(result.plan ? { plan: result.plan } : {}) };
      await this.persistNewCredential(credential);
      return { success: true };
    });
  }

  /** Exchange a Cursor API key the way the CLI does with CURSOR_API_KEY. */
  async connectApiKey(key: unknown): Promise<{ success: true }> {
    return this.exclusive(async () => {
      await this.load();
      if (this.saved) throw cursorError("cursor_already_connected", 409);
      if (typeof key !== "string" || !field(key, 4096)) throw cursorError("cursor_credential_invalid", 422);
      let token: string;
      let who: { email: string; plan: string };
      try {
        // The exchange itself proves the key; upstream 401 here is Cursor
        // refusing THIS key during an explicit login — reported as such, and
        // never as a latched account state.
        token = await this.engine.keyToken(key);
        who = await this.engine.whoIs(token);
      } catch (e: any) {
        if (e instanceof this.engine.AuthError || e?.status === 401) {
          throw Object.assign(cursorError("cursor_login_failed", 422), { detail: e?.message });
        }
        throw e?.code ? e : cursorError("cursor_upstream_error", 502);
      }
      const credential: CursorCredential = { type: "api", key,
        ...(who.email ? { accountId: who.email } : {}), ...(who.plan ? { plan: who.plan } : {}) };
      await this.persistNewCredential(credential);
      return { success: true };
    });
  }

  /** Persist FIRST, then config; a config failure rolls the file back. */
  private async persistNewCredential(credential: CursorCredential): Promise<void> {
    const next: Saved = { version: 1, credential, models: [] };
    await this.persist(next);
    try { await this.updateConfig(next); }
    catch (e) { await rm(this.file, { force: true }); this.saved = undefined; throw e; }
    this.expired = false;
    this.lastError = undefined;
    this.coolingUntil = 0;
  }

  // ---- models / usage ------------------------------------------------------------------

  async syncModels(): Promise<{ success: true; models: string[]; modelCount: number }> {
    return this.exclusive(async () => {
      const tok = await this.engineToken();
      let listing: CursorModelInfo[];
      try { listing = await this.engine.usable(tok); }
      catch (error: any) {
        if (error instanceof this.engine.AuthError || error?.status === 401) {
          this.expired = true; this.lastError = "cursor_reauth_required";
          throw cursorError("cursor_reauth_required", 401);
        }
        throw error?.code ? error : cursorError("cursor_upstream_error", 502);
      }
      const models = (Array.isArray(listing) ? listing : []).map(toRecord).filter(m => m.key).slice(0, 512);
      if (!models.length) throw cursorError("cursor_upstream_error");
      // A synced non-empty listing is validated upstream success (qoder parity).
      this.noteUpstreamSuccess();
      await this.mutate(current => ({ ...current, models }));
      return { success: true, models: models.map(m => m.key), modelCount: models.length };
    });
  }

  async getUsage(): Promise<CursorUsageSnapshot> {
    await this.load();
    if (!this.saved || this.disconnecting) throw cursorError("cursor_not_connected", 409);
    const snapshot = (): CursorUsageSnapshot => this.usage
      ? { ...this.usage, stale: Date.now() - this.usage.observedAt > USAGE_CACHE_MS, coolingUntil: this.coolingUntil || undefined }
      : { known: false, stale: false, windows: [], coolingUntil: this.coolingUntil || undefined };
    if (this.usage && Date.now() - this.usage.observedAt < USAGE_CACHE_MS) return snapshot();
    if (this.usageJob) return this.usageJob;
    this.usageJob = (async () => {
      try {
        const tok = await this.engineToken();
        // The dashboard's windows need the model ids to split the pools; a
        // missing/malformed body is not a validated success (UNKNOWN-tolerant).
        const ids = (this.saved?.models ?? []).map(m => m.key);
        const [u, plan, bot] = await Promise.all([
          this.engine.usage(tok, ids), this.engine.planOf(tok), this.engine.botUsage(tok),
        ]);
        if (!u || u.error || !Array.isArray(u.windows)) throw 0;
        this.noteUpstreamSuccess();
        const windows = [...u.windows.filter((w) => w.name !== "Total" && !(w.name === "On-demand" && w.aside)), ...bot,
          ...u.windows.filter((w) => w.name === "Total" || (w.name === "On-demand" && w.aside))];
        this.usage = { known: true, stale: false, observedAt: Date.now(), windows, ...(plan ? { plan } : {}) };
      } catch { return snapshot(); }
      return snapshot();
    })().finally(() => { this.usageJob = undefined; });
    return this.usageJob;
  }

  // ---- account bookkeeping ---------------------------------------------------------------

  /**
   * Latched state heals ONLY per contract: success clears cooling + lastError,
   * never the expired latch — for Cursor that one clears solely through an
   * explicit reconnect (a browser token cannot be renewed; the engine's
   * CLI/API-key paths re-resolve their tokens per request on their own).
   */
  noteUpstreamSuccess(): void {
    this.lastError = undefined;
    this.coolingUntil = 0;
  }

  async noteUpstreamError(info: { code: string; httpStatus?: number; cooldownMs?: number }): Promise<void> {
    if (info.code === "cursor_reauth_required" || info.httpStatus === 401) {
      this.expired = true;
      this.lastError = "cursor_reauth_required";
      return;
    }
    this.lastError = ["cursor_rate_limited", "cursor_upstream_error"].includes(info.code) ? info.code : "cursor_upstream_error";
    if (info.code === "cursor_rate_limited") {
      this.coolingUntil = Date.now() + clampCursorCooldown(info.cooldownMs ?? DEFAULT_429_COOLDOWN_MS);
    }
  }

  async getStatus(): Promise<any> {
    await this.load().catch(() => {});
    const saved = this.saved;
    const models = (saved?.models ?? []).map(m => ({ id: m.key, name: m.name, context: m.context }));
    return {
      status: saved ? "connected" : "not_connected",
      providerName: CURSOR_PROVIDER,
      credentialType: saved?.credential.type,
      account: saved ? maskEmail(saved.credential.accountId) ?? undefined : undefined,
      plan: saved ? saved.credential.plan || undefined : undefined,
      models, modelCount: models.length,
      login: this.loginState(),
      ...(this.coolingUntil > Date.now() ? { coolingUntil: this.coolingUntil } : {}),
      ...(this.expired ? { expired: true } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  /**
   * Teardown. Fault tolerance (review lesson from the lost implementation):
   * - a corrupt credential file still removes the managed entry + file;
   * - double disconnect is idempotent;
   * - a pending browser sign-in is cancelled and its late outcome discarded.
   * In-flight data-plane requests are aborted through their controllers and
   * this account's retained native owners are cancelled — as far as coreApi=1
   * allows (the host has no provider-disposal hook; see README).
   */
  async disconnect(): Promise<{ success: true }> {
    return this.exclusive(async () => {
      // Teardown must survive a corrupt credential file: remove config + file.
      await this.load().catch(() => {});
      this.disconnecting = true;
      this.generation++; // invalidates in-flight logins and their outcomes
      // Abort in-flight data-plane work FIRST so nothing persists after us.
      for (const controller of this.active) controller.abort();
      this.active.clear();
      if (this.login && this.login.outcome === null) {
        this.login.controller.abort();
        this.login.outcome = { state: "cancelled", error: "the sign-in was cancelled" };
      }
      // A queued mutation (e.g. a login persist started before disconnect)
      // must finish before the credential file is removed, so no writer
      // resurrects it.
      await this.persistChain.catch(() => {});
      const savedBefore = this.saved;
      try { await this.updateConfig(); } catch (e) { this.disconnecting = false; throw e; }
      await rm(this.file, { force: true });
      this.saved = undefined;
      // Cancel this account's retained native owners (same token hash) and
      // drop the engine's per-token caches. Never blocks teardown.
      try {
        const token = savedBefore?.credential.type === "browser" ? savedBefore.credential.access
          : savedBefore?.credential.type === "api" ? savedBefore.credential.key : undefined;
        const account = token ? createHash("sha256").update(token).digest("hex") : undefined;
        for (const owner of [...nativeSessions.entries]) {
          if (!account || owner.account === account) await owner.cancel("cursor account disconnected").catch(() => {});
        }
        this.engine.resetCaches();
      } catch { /* dispose never blocks teardown */ }
      this.login = undefined;
      this.usage = undefined;
      this.expired = false;
      this.lastError = undefined;
      this.coolingUntil = 0;
      this.disconnecting = false;
      return { success: true };
    });
  }

  /** Cheap account-state check for the background recovery probe (no network). */
  async probeAccountState(): Promise<{ available: boolean; parkedUntil?: number; reason?: string }> {
    await this.load().catch(() => {});
    if (!this.saved || this.disconnecting) return { available: false, reason: "not_connected" };
    if (this.coolingUntil > Date.now()) return { available: false, parkedUntil: this.coolingUntil, reason: "rate_limited" };
    if (this.expired) return { available: false, reason: "reauth_required" };
    const c = this.saved.credential;
    if (c.type === "browser" && c.expires > 0 && c.expires <= Date.now()) return { available: false, reason: "expired" };
    return { available: true };
  }

  /** Level-2 liveness: the cheapest call that proves Cursor answers for THIS account. */
  async probeLiveness(signal?: AbortSignal): Promise<Response> {
    const tok = await this.engineToken();
    try {
      const plan = await this.engine.unary(_internal.API, "aiserver.v1.DashboardService/GetPlanInfo", tok, {}, 15_000);
      return Response.json({ ok: true, ...(plan ? { plan } : {}) }, { status: 200, signal } as ResponseInit);
    } catch (e: any) {
      const status = Number(e?.status) >= 400 && Number(e?.status) <= 599 ? Number(e.status) : 502;
      return Response.json({ ok: false }, { status, signal } as ResponseInit);
    }
  }

  /** Marker identity, for tests and the runtime's isManaged. */
  get marker(): string { return CURSOR_MARKER; }
}