import { constants } from "node:fs";
import { open, mkdir, chmod, rename, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createQoderEngine, type QoderCredential, type QoderEngine, type QoderModelInfo } from "./vendor/engine.mjs";
import type { PluginHostCapabilities } from "./core-types";
import { QODER_PROVIDER, isQoderManaged, lockQoderProvider, qoderError, validPAT } from "./protocol";

/**
 * Normalized model record kept in the private credential file: exactly the
 * fields status/card render (id, display name, context, free flag). Everything
 * else the engine listing carries (efforts, rates, upstream raw config) is
 * shed at sync time — secrets and vendor payloads never persist here.
 */
export interface QoderModelRecord { key: string; name: string; context: number; free: boolean }

type Saved = { version: 1; credential: QoderCredential; models: QoderModelRecord[]; hiddenModels: string[] };
export interface QoderServiceOptions {
  host: PluginHostCapabilities;
  fetch?: typeof fetch;
  /** Test seam: inject a fake engine; the real one is built from the host dispatcher. */
  engine?: QoderEngine;
}
export interface QoderUsageSnapshot { known: boolean; stale: boolean; observedAt?: number;
  windows: Array<{ name: string; used: number; display: string }>; plan?: string; until?: string; coolingUntil?: number }

const REFRESH_LEAD_MS = 5 * 60_000; // matches the engine's REFRESH_LEAD: refresh before a request
const USAGE_CACHE_MS = 60_000;
const COOLDOWN_CAP_MS = 3_600_000; // grok parity: latched cooldown never exceeds one hour
const DEFAULT_429_COOLDOWN_MS = 300_000;
const FILE_MAX_BYTES = 1_048_576;

const field = (v: unknown, max: number): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= max && !/[\x00-\x1f]/.test(v);
const softField = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;

const validModels = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length <= 2048 && v.every(m => field(m, 256));
const validModelRecords = (v: unknown): v is QoderModelRecord[] =>
  Array.isArray(v) && v.length <= 512 && v.every(m => m != null && typeof m === "object" &&
    field(m.key, 256) && softField(m.name, 256) && typeof m.context === "number" &&
    Number.isFinite(m.context) && m.context >= 0 && typeof m.free === "boolean");

/** Strict on-disk shape: version, credential fields, capped model arrays. */
function validate(value: any): Saved {
  const c = value?.credential;
  if (value?.version !== 1 || !c || typeof c !== "object" ||
    !field(c.access, 32768) || !softField(c.refresh, 32768) || !Number.isFinite(c.expires) ||
    !field(c.uid, 256) || !softField(c.email, 1024) || !softField(c.name, 1024) ||
    !field(c.accountId, 256) || !field(c.machineId, 128) || !validPAT(c.pat) ||
    !validModelRecords(value.models) || !validModels(value.hiddenModels)) throw qoderError("qoder_credential_invalid");
  return {
    version: 1,
    credential: {
      access: c.access, refresh: c.refresh, expires: c.expires, uid: c.uid,
      email: c.email, name: c.name, accountId: c.accountId, machineId: c.machineId, pat: c.pat,
    },
    models: value.models.map((m: QoderModelRecord) => ({ key: m.key, name: m.name, context: m.context, free: m.free })),
    hiddenModels: [...new Set<string>(value.hiddenModels)],
  };
}

/** Public account recognition only: the email local part is masked. */
export function maskEmail(email: string | undefined): string | null {
  if (!email) return null;
  const at = email.indexOf("@");
  if (at <= 0) return null;
  return `${email[0]}***${email.slice(at)}`;
}

function toRecord(m: QoderModelInfo): QoderModelRecord {
  return { key: String(m.key), name: String(m.name ?? m.key), context: Number(m.context) || 0, free: m.free === true };
}

/**
 * One connected identity, one engine, serialized mutations (grok's service
 * structure) over cursor's persistence hygiene (O_NOFOLLOW/O_EXCL + fsync +
 * rename, ≤1MB file, strict validate). The engine is injectable for offline
 * tests; by default it is built around the host's subscription dispatcher.
 */
export class QoderAuthService {
  readonly engine: QoderEngine;
  readonly file: string;
  private loaded?: Promise<void>;
  private saved?: Saved;
  private refresh?: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private persistChain: Promise<void> = Promise.resolve();
  private generation = 0;
  private disconnecting = false;
  private expired = false;
  private lastError?: string;
  private coolingUntil = 0;
  private usage?: QoderUsageSnapshot & { observedAt: number };
  private usageJob?: Promise<QoderUsageSnapshot>;
  constructor(readonly options: QoderServiceOptions) {
    // The internal-refresh seam is wired BEFORE the engine exists. A PAT
    // re-exchange rotates access/refresh/expires while renew() keeps the rest
    // of the credential (uid/pat/machineId come from the spread of the prior
    // credential), so the persistence guard matches on uid+pat. The callback
    // is fire-and-forget in the engine; here it joins the serialized persist
    // chain without touching config (visibility is unaffected by a rotation).
    const network = options.fetch ?? ((input: any, init?: any) => fetch(input, init));
    // Fixed subscription origins ride the host's dispatcher; redirect:"error"
    // keeps the engine on the pinned origins (parity with lockUpstream).
    const hostFetch: typeof fetch = (input: any, init?: any) => network(input, {
      ...init, redirect: "error",
      dispatcher: options.host.getSubscriptionDispatcher?.() ?? options.host.getDirectDispatcher(),
    } as RequestInit);
    this.engine = options.engine ?? createQoderEngine({
      fetch: hostFetch,
      // The engine cannot know the host's connection generation, but a
      // rotation preserves the credential machineId while every new PAT
      // connect generates one. The bound machineId inside the rotated
      // credential therefore identifies its originating connection, so a
      // rotation delivered after a disconnect+reconnect (even with the SAME
      // PAT) cannot overwrite the new connection.
      onRefresh: n => this.handleEngineRefresh(n),
    });
    this.file = join(options.host.configDir, "qoder-credentials.json");
  }
  /**
   * Persist a credential the engine rotated on its own during a request
   * (engine options.onRefresh). Credential-only mutation (no config write),
   * guarded by generation + uid+pat so a stale rotation after disconnect or a
   * different account can never resurrect state. Failures are swallowed: a
   * crash before persistence still recovers through PAT re-exchange.
   */
  handleEngineRefresh(next: QoderCredential): void {
    this.persistChain = this.persistChain.then(async () => {
      const current = this.saved;
      if (this.disconnecting || !current ||
          current.credential.uid !== next.uid || current.credential.pat !== next.pat ||
          current.credential.machineId !== next.machineId) return;
      await this.persist({ ...current, credential: next });
      this.expired = false;
      this.lastError = undefined;
    }).catch(() => { /* non-fatal: PAT re-exchange recovers on restart */ });
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
        if (!stat.isFile() || stat.size > FILE_MAX_BYTES) throw qoderError("qoder_credential_invalid");
        await handle.chmod(0o600);
        this.saved = validate(JSON.parse(await handle.readFile("utf8")));
      } catch (e: any) { if (e?.code !== "ENOENT") throw qoderError("qoder_credential_unreadable", 500); }
      finally { await handle?.close(); }
    })().catch((error: unknown) => { this.loaded = undefined; throw error; });
    return this.loaded;
  }
  /** Validate and serialize before replacing the file. The loader must never
   *  accept a state this writer created, and JSON byte growth is bounded. */
  private serializeSaved(next: Saved): string {
    const checked = validate(next);
    const text = JSON.stringify(checked);
    if (Buffer.byteLength(text, "utf8") > FILE_MAX_BYTES) throw qoderError("qoder_persist_failed", 500);
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
    } catch { throw qoderError("qoder_persist_failed", 500); }
    finally { await handle?.close(); await unlink(temp).catch(() => {}); }
  }
  /**
   * The ONLY writers of durable state (grok parity): each job re-reads the
   * latest saved state at execution time, writes config first and persists
   * after; a persist failure after a successful config write rolls the managed
   * entry back so config never names models the private file lost.
   */
  private mutate(merge: (current: Saved) => Saved, writeConfig = true): Promise<void> {
    const job = this.persistChain.then(async () => {
      const current = this.saved;
      if (!current || this.disconnecting) throw qoderError("qoder_not_connected", 409);
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
    if (!this.options.host.readRawConfig) throw qoderError("qoder_raw_config_required", 500);
    return structuredClone(await this.options.host.readRawConfig());
  }
  private async updateConfig(saved?: Saved): Promise<void> {
    const cfg = await this.rawConfig();
    const before = structuredClone(cfg);
    const key = Array.isArray(cfg.providers) && !Array.isArray(cfg.Providers) ? "providers" : "Providers";
    const list: any[] = cfg[key] ?? [];
    const at = list.findIndex(isQoderManaged);
    if (saved) {
      if (at < 0 && list.some(p => p?.name === QODER_PROVIDER)) throw qoderError("qoder_provider_name_conflict");
      const provider = lockQoderProvider({ ...(at >= 0 ? list[at] : {}),
        models: saved.models.filter(m => !saved.hiddenModels.includes(m.key)).map(m => m.key),
        enabled: at >= 0 ? list[at].enabled !== false : true });
      if (at >= 0) list[at] = provider; else list.push(provider);
    } else if (at >= 0) list.splice(at, 1);
    cfg[key] = list;
    try { await this.options.host.writeConfig(cfg); await this.options.host.reloadRuntime(cfg); }
    catch {
      await this.options.host.writeConfig(before).then(() => this.options.host.reloadRuntime(before)).catch(() => {});
      throw qoderError("qoder_config_write_failed", 500);
    }
  }
  /** Exchange a PAT for a job token: persist FIRST, then config, rollback on failure. */
  async connectPAT(pat: unknown): Promise<{ success: true }> {
    return this.exclusive(async () => {
      await this.load();
      if (this.saved) throw qoderError("qoder_already_connected", 409);
      if (!validPAT(pat)) throw qoderError("qoder_pat_invalid", 422);
      let credential: QoderCredential;
      try { credential = await this.engine.connectPAT(pat); }
      catch (e: any) { if (e?.code) throw e; throw qoderError("qoder_upstream_error", 502); }
      const next: Saved = { version: 1, credential, models: [], hiddenModels: [] };
      await this.persist(next);
      try { await this.updateConfig(next); }
      catch (e) { await rm(this.file, { force: true }); this.saved = undefined; throw e; }
      this.expired = false; this.lastError = undefined; this.coolingUntil = 0;
      return { success: true };
    });
  }
  /**
   * Single-flight job-token refresh (contract): rotated credentials persist
   * through the mutate chain; a refresh that lands after a disconnect (or any
   * generation bump) is discarded WITHOUT latching reauth. The engine's own
   * PAT re-exchange recovery clears the expired latch on success.
   */
  async forceTokenRefresh(): Promise<void> {
    await this.load();
    if (!this.saved || this.disconnecting) throw qoderError("qoder_not_connected", 409);
    if (this.refresh) return this.refresh;
    const saved = this.saved, generation = this.generation;
    this.refresh = (async () => {
      try {
        const c = await this.engine.refresh(saved.credential);
        if (generation !== this.generation || this.saved?.credential.machineId !== saved.credential.machineId || this.disconnecting) {
          throw qoderError("qoder_not_connected", 409);
        }
        await this.mutate(current => ({ ...current, credential: c }), false);
        this.expired = false;
        this.lastError = undefined;
      } catch (error: any) {
        // Superseded by disconnect/generation: surface honestly, latch nothing.
        if (generation !== this.generation || this.disconnecting || !this.saved) throw qoderError("qoder_not_connected", 409);
        if (error?.expired === true) {
          this.expired = true; this.lastError = "qoder_reauth_required";
          throw qoderError("qoder_reauth_required", 401);
        }
        // Infrastructure failures are not "expired": surface and latch them honestly.
        if (["qoder_persist_failed", "qoder_credential_invalid", "qoder_raw_config_required", "qoder_proxy_invalid"].includes(error?.code)) {
          this.lastError = "qoder_upstream_error"; throw error;
        }
        // A 5xx/network/timeout refresh failure is transient. Only explicit
        // expired evidence (401/403 or refused PAT) may latch reauthentication.
        this.lastError = "qoder_upstream_error";
        throw qoderError("qoder_upstream_error", 502);
      } finally { this.refresh = undefined; }
    })();
    return this.refresh;
  }
  /** Circuit breaker BEFORE any refresh/network work (Gemini lesson, contract). */
  async ensureUsable(): Promise<void> {
    await this.load();
    if (!this.saved || this.disconnecting) throw qoderError("qoder_not_connected", 409);
    if (this.coolingUntil > Date.now()) throw qoderError("qoder_rate_limited", 429);
    if (this.expired) throw qoderError("qoder_reauth_required", 401);
  }
  /** Credential with the engine's refresh lead applied; single-flight coalesces callers. */
  private async waitWithSignal<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return work;
    if (signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    return await new Promise<T>((resolve, reject) => {
      const stop = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      signal.addEventListener("abort", stop, { once: true });
      work.then(
        value => { signal.removeEventListener("abort", stop); resolve(value); },
        error => { signal.removeEventListener("abort", stop); reject(error); },
      );
    });
  }
  /** Credential with the engine's refresh lead applied; the shared rotation
   *  may continue after this caller stops waiting, so a token is never lost. */
  private async freshCredential(signal?: AbortSignal): Promise<QoderCredential> {
    await this.load();
    if (!this.saved || this.disconnecting) throw qoderError("qoder_not_connected", 409);
    if (this.saved.credential.expires - Date.now() < REFRESH_LEAD_MS) {
      await this.waitWithSignal(this.forceTokenRefresh(), signal);
    }
    return this.saved!.credential;
  }
  /** One bounded engine chat transaction for the managed runtime's dispatchRequest. */
  async dispatch(chatBody: any, signal: AbortSignal): Promise<Response> {
    await this.ensureUsable();
    const cred = await this.freshCredential(signal);
    const session = typeof chatBody?.prompt_cache_key === "string" && chatBody.prompt_cache_key ? chatBody.prompt_cache_key : "";
    return this.engine.chat(cred, chatBody, { session, signal });
  }
  async syncModels(): Promise<{ success: true; models: string[]; modelCount: number }> {
    return this.exclusive(async () => {
      const cred = await this.freshCredential();
      let listing: QoderModelInfo[];
      try { listing = await this.engine.models(cred, true); }
      catch (error: any) {
        if (error?.expired === true) { this.expired = true; this.lastError = "qoder_reauth_required"; throw qoderError("qoder_reauth_required", 401); }
        if (error?.code) throw error;
        throw qoderError("qoder_upstream_error", 502);
      }
      const models = (Array.isArray(listing) ? listing : []).map(toRecord).filter(m => m.key && !["auto", "default"].includes(m.key)).slice(0, 512);
      if (!models.length) throw qoderError("qoder_upstream_error");
      // A synced non-empty listing is validated upstream success (grok parity).
      this.noteUpstreamSuccess();
      await this.mutate(current => ({ ...current, models }));
      return { success: true, models: models.map(m => m.key), modelCount: models.length };
    });
  }
  async setModelHidden(key: string, hidden: boolean): Promise<{ success: true }> {
    return this.exclusive(async () => {
      await this.load();
      if (!this.saved || this.disconnecting) throw qoderError("qoder_not_connected", 409);
      if (typeof key !== "string" || !this.saved.models.some(m => m.key === key)) throw qoderError("qoder_model_unknown");
      await this.mutate(current => ({ ...current,
        hiddenModels: [...new Set([...current.hiddenModels.filter(m => m !== key), ...(hidden ? [key] : [])])] }));
      return { success: true };
    });
  }
  async getUsage(): Promise<QoderUsageSnapshot> {
    await this.load();
    if (!this.saved || this.disconnecting) throw qoderError("qoder_not_connected", 409);
    const snapshot = (): QoderUsageSnapshot => this.usage
      ? { ...this.usage, stale: Date.now() - this.usage.observedAt > USAGE_CACHE_MS, coolingUntil: this.coolingUntil || undefined }
      : { known: false, stale: false, windows: [], coolingUntil: this.coolingUntil || undefined };
    if (this.usage && Date.now() - this.usage.observedAt < USAGE_CACHE_MS) return snapshot();
    if (this.usageJob) return this.usageJob;
    this.usageJob = (async () => {
      try {
        const cred = await this.freshCredential();
        const result = await this.engine.usage(cred);
        // A malformed/missing quota body is not a validated success (grok parity).
        if (!result || result.error || !Array.isArray(result.windows)) throw 0;
        this.noteUpstreamSuccess();
        this.usage = { known: true, stale: false, observedAt: Date.now(), windows: result.windows, plan: result.plan, until: result.until };
      } catch { return snapshot(); }
      return snapshot();
    })().finally(() => { this.usageJob = undefined; });
    return this.usageJob;
  }
  /**
   * Latched state heals ONLY per contract: success clears cooling + lastError,
   * never the expired latch — that one clears solely through a successful
   * engine refresh (PAT re-exchange) or an explicit reconnect.
   */
  noteUpstreamSuccess(): void {
    this.lastError = undefined;
    this.coolingUntil = 0;
  }
  async noteUpstreamError(info: { code: string; httpStatus?: number; cooldownMs?: number }): Promise<void> {
    if (info.code === "qoder_reauth_required" || info.httpStatus === 401) {
      this.expired = true;
      this.lastError = "qoder_reauth_required";
      return;
    }
    this.lastError = ["qoder_rate_limited", "qoder_upstream_error"].includes(info.code) ? info.code : "qoder_upstream_error";
    if (info.code === "qoder_rate_limited") {
      this.coolingUntil = Date.now() + Math.min(Math.max(info.cooldownMs ?? DEFAULT_429_COOLDOWN_MS, 0), COOLDOWN_CAP_MS);
    }
  }
  async getStatus(): Promise<any> {
    await this.load();
    const saved = this.saved;
    const models = (saved?.models ?? []).map(m => ({
      id: m.key, name: m.name, context: m.context, free: m.free,
      hidden: saved!.hiddenModels.includes(m.key),
    }));
    return {
      status: saved ? "connected" : "not_connected",
      providerName: QODER_PROVIDER,
      account: saved ? maskEmail(saved.credential.email) ?? maskEmail(saved.credential.accountId) ?? undefined : undefined,
      models, modelCount: models.length,
      ...(this.coolingUntil > Date.now() ? { coolingUntil: this.coolingUntil } : {}),
      ...(this.expired ? { expired: true } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }
  async disconnect(): Promise<{ success: true }> {
    return this.exclusive(async () => {
      // Teardown must survive a corrupt credential file: remove config + file.
      await this.load().catch(() => {});
      this.disconnecting = true;
      this.generation++; // invalidates in-flight refreshes (contract)
      await this.refresh?.catch(() => {});
      await this.usageJob?.catch(() => {});
      // A queued mutation (e.g. a refresh persist started before disconnect)
      // must finish before the credential file is removed, so no writer
      // resurrects it.
      await this.persistChain.catch(() => {});
      try { await this.updateConfig(); } catch (e) { this.disconnecting = false; throw e; }
      await rm(this.file, { force: true });
      this.saved = undefined;
      try { this.engine.dispose(); } catch { /* dispose never blocks teardown */ }
      this.usage = undefined; this.expired = false; this.lastError = undefined; this.coolingUntil = 0;
      this.disconnecting = false;
      return { success: true };
    });
  }
}
