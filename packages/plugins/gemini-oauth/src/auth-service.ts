/**
 * Gemini OAuth (Antigravity) — credential storage, browser login state
 * machine, managed-provider upsert and the admin-facing mutation service.
 *
 * MOVED VERBATIM from the former core module
 * `packages/core/src/services/gemini-oauth-auth.ts` when the provider became
 * the first provider plugin. ONLY the host-coupling points were rewired:
 *   - config reads (`readConfigFileRaw`) → injected `readRawConfig`
 *     (`ctx.host.readRawConfig`, interpolation-free so $VAR placeholders
 *     survive a read-modify-write round trip);
 *   - config writes (`writeConfigFile`) → injected `writeConfig`
 *     (`ctx.host.writeConfig`, keeping core's snapshot/backup semantics);
 *   - the private 40-line runtime reload copy → `ctx.host.reloadRuntime`
 *     (the core owns the canonical POST-/api-config reload sequence);
 *   - `getDirectDispatcher()` → injected `getDirectDispatcher`
 *     (`ctx.host.getDirectDispatcher`);
 *   - the default credential path (`HOME_DIR`) → the store is constructed by
 *     plugin.ts at `join(ctx.host.configDir, "gemini-oauth-credentials.json")`.
 * The extra `reconcileHealthStore` call after reload was dropped: the host
 * reload sequence already performs it.
 *
 * Design contract: docs/design/gemini-provider-contract.md (frozen, M2).
 *
 * Invariants (contract §0 / §1.3 / §1.4 / §1.5):
 *  - Tokens live ONLY in the 0600 `<configDir>/gemini-oauth-credentials.json`
 *    file; they never enter config.json, /api/config, logs, errors or admin
 *    responses. config.json holds the constant marker api_key only.
 *  - One account (v1). At most one browser login in flight; loopback callback
 *    bound to 127.0.0.1:0, path /oauth-callback, 10-minute TTL, PKCE S256 and
 *    a CSRF `state` verified with timing-safe comparison.
 *  - Every credential/config read-modify-write goes through ONE serial
 *    mutation queue with synchronous epoch invalidation (disconnect/cancel
 *    invalidate in-flight login persistence immediately).
 *  - A rotated refresh_token is durably persisted BEFORE the in-memory token
 *    cache identity switches. A failed login never overwrites a good account.
 *  - Sync failures keep the previous model list; disconnect removes the
 *    provider AND cleans its Router references (the WorkBuddy disconnect
 *    leaves Router intact — Gemini's frozen contract requires cleanup).
 */
import { createServer, type Server as HttpServer } from "node:http";
import { timingSafeEqual, randomBytes } from "node:crypto";
import { promises as fs, constants } from "node:fs";
import { dirname, join } from "node:path";
import {
  GEMINI_OAUTH_API_KEY,
  GEMINI_OAUTH_CALLBACK_PATH,
  GEMINI_OAUTH_DATA_PLANE,
  GEMINI_OAUTH_FALLBACK_MODELS,
  GEMINI_OAUTH_LOGIN_TTL_MS,
  GEMINI_OAUTH_PROVIDER_NAME,
  GEMINI_OAUTH_REAUTH_COOLDOWN_MS,
  antigravityClientId,
  antigravityClientSecret,
  antigravityWireModel,
  buildAuthorizeUrl,
  clearGeminiOauthTokenCaches,
  collapseAntigravityModels,
  createGeminiOauthTokenState,
  createPkcePair,
  discoverAntigravityProject,
  exchangeCodeForTokens,
  fetchAvailableModelVariants,
  fetchAvailableModels,
  fetchUserEmail,
  fetchGeminiOauthQuota,
  type GeminiOauthQuotaSnapshot,
  type GeminiOauthRequestIdentity,
  GEMINI_OAUTH_QUOTA_COOLDOWN_MS,
  isGeminiOauthBreakerCode,
  invalidateGeminiOauthAccessToken,
  isGeminiOauthConfigured,
  isManagedGeminiOauthConfigProvider,
  isStickyGeminiOauthError,
  lockGeminiOauthProvider,
  protectGeminiOauthConfig,
  refreshAccessToken,
  sanitizeValidationUrl,
  type GeminiOauthErrorInfo,
  type GeminiOauthErrorCode,
  type GeminiOauthFetch,
  type GeminiOauthModelInfo,
} from "./protocol";

import { geminiOauthQuotaPool, normalizeGeminiOauthPoolLocks, pruneGeminiOauthPoolLocks } from "./quota-pools";

const GEMINI_OAUTH_QUOTA_CACHE_TTL_MS = 60_000;

export const CREDENTIAL_FILE = "gemini-oauth-credentials.json";
const MAX_CREDENTIAL_BYTES = 256 * 1024;
const PROVIDER_KEYS = ["Providers", "providers"] as const;

/** Persisted account block (contract §1.3). `lastError` carries a stable code
 *  only — never arbitrary upstream text or token material. */
export interface GeminiOauthAccount {
  email: string;
  refreshToken: string;
  projectId: string;
  tier: string;
  importedAt: string;
  lastError: { code: GeminiOauthErrorCode; validationUrl?: string } | null;
  cooldownUntil: number | null;
}

/** On-disk schema (contract §1.3, version 2). `rawModelIds` is the one
 *  documented extension: non-secret unfolded upstream ids the variant mapper
 *  needs after a restart (the collapsed provider.models list loses them).
 *  `hiddenModels` is the user's model-hide preference: it stores the ids the
 *  UI shows (collapsed effort-family ids), NEVER the raw upstream ids above, so
 *  hiding a family removes exactly the id the user saw. Optional on load, so
 *  every credential file written before it existed still reads.
 *  `rawModelIds` stays untouched by hide/restore: the variant mapper keeps
 *  resolving hidden families for callers that addressed them directly. */
export interface GeminiOauthCredentialData {
  version: 2;
  kind: "antigravity";
  account: GeminiOauthAccount;
  rawModelIds?: string[];
  hiddenModels?: string[];
  /** Independent quota parks; account identity/verification stays in account. */
  poolLocks?: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Fixed, safe admin-facing error catalogue
// ---------------------------------------------------------------------------

export const GEMINI_OAUTH_LAST_ERROR_CODES: ReadonlySet<GeminiOauthErrorCode> = new Set([
  "gemini_oauth_identity_blocked",
  "gemini_oauth_validation_required",
  "gemini_oauth_quota_exceeded",
  "gemini_oauth_reauth_required",
  "gemini_oauth_upstream_error",
  "gemini_oauth_transient",
]);

/** Fixed status-line copy per code; the UI localizes by code and never shows
 *  raw upstream text. */
export const GEMINI_OAUTH_SAFE_MESSAGES: Record<string, string> = {
  gemini_oauth_identity_blocked:
    "Google rejected the request as a third-party Claude client (not a quota problem).",
  gemini_oauth_validation_required: "Google requires account verification before continuing.",
  gemini_oauth_quota_exceeded: "Gemini OAuth quota exceeded.",
  gemini_oauth_reauth_required: "The saved sign-in was rejected; authorize again.",
  gemini_oauth_upstream_error: "Gemini OAuth upstream request failed.",
  gemini_oauth_transient: "Gemini OAuth upstream is temporarily unavailable.",
};

/** Host capabilities this service needs. Everything stateful is injected by
 *  plugin.ts straight from PluginContext.host — the plugin never bundles a
 *  copy of a core stateful module. */
export interface GeminiOauthServiceHost {
  /** Raw config read (NO env interpolation) so placeholders survive writes. */
  readRawConfig: () => Promise<any>;
  /** Persist the next config (core-owned snapshot/backup semantics). */
  writeConfig: (next: any) => Promise<void>;
  /** The canonical core reload sequence, run after every config write. */
  reloadRuntime: (config?: any) => Promise<void> | void;
  /** undici Agent that bypasses CCR/proxy env routing (fixed Google origins). */
  getDirectDispatcher: () => unknown;
}

export interface GeminiOauthServiceOptions {
  host: GeminiOauthServiceHost;
  logger?: any;
  fetch?: GeminiOauthFetch;
  store: GeminiOauthCredentialStore;
}

export interface GeminiOauthStatusResult {
  configured: boolean;
  connected: boolean;
  kind: "antigravity";
  email: string | null;
  project: string | null;
  tier: string | null;
  /** Length of `models` (kept for older clients); hidden models are excluded. */
  modelsCount: number;
  /** Visible managed models (UI ids — collapsed effort-family ids), in provider order. */
  models: string[];
  /** Hidden models (same id space as `models`), for single/all restore. */
  hiddenModels: string[];
  lastError: { code: GeminiOauthErrorCode; message: string; validationUrl?: string } | null;
  cooldownUntil: number | null;
}

export interface GeminiOauthSyncResult {
  ok: boolean;
  modelsCount: number;
  clearedRefs: string[];
  error?: GeminiOauthErrorCode | "gemini_oauth_not_connected" | "gemini_oauth_models_fetch_failed";
}

export interface GeminiOauthDisconnectResult {
  ok: true;
  removedModelRefs: string[];
  defaultFallback: string | null;
}

export interface GeminiOauthHideResult {
  ok: true;
  /** Router FIELD PATHS rewritten ("default", "scenario:think", "models:<alias>", "fallback"). */
  clearedRefs: string[];
  /** The actual `gemini-oauth,<model>` refs that left Router (empty when none matched). */
  removedModelRefs: string[];
  /** Persisted `Router.default` after the rewrite ("" when it was cleared). */
  defaultFallback: string | null;
  models: string[];
  hiddenModels: string[];
}

export interface GeminiOauthRestoreResult {
  ok: true;
  /** Models that became visible again (only discovered/registered ones). */
  restored: string[];
  models: string[];
  hiddenModels: string[];
}

/**
 * A hide/restore input that is not a plausible model id. Rejections happen
 * before any store/config read: empty, over-long, comma-bearing (would split a
 * `provider,model` ref) and control-character ids are all refused.
 */
export function isGeminiOauthModelId(value: unknown): value is string {
  return boundedString(value, 256) && !value.includes(",");
}

// ---------------------------------------------------------------------------
// 0600 credential file
// ---------------------------------------------------------------------------

const LAST_ERROR_ALLOWLIST: ReadonlySet<string> = GEMINI_OAUTH_LAST_ERROR_CODES;

function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
}

/** Whitelist normalization: unknown fields never survive a save/load round-trip. */
export function normalizeGeminiOauthData(raw: any): GeminiOauthCredentialData {
  if (!raw || typeof raw !== "object" || raw.version !== 2 || raw.kind !== "antigravity") {
    throw new Error("gemini_oauth_credential_invalid");
  }
  const a = raw.account;
  if (!a || typeof a !== "object") throw new Error("gemini_oauth_credential_invalid");
  if (!boundedString(a.email, 253) || !boundedString(a.refreshToken, 8192)) {
    throw new Error("gemini_oauth_credential_invalid");
  }
  if (typeof a.projectId !== "string" || a.projectId.length > 256) {
    throw new Error("gemini_oauth_credential_invalid");
  }
  if (typeof a.tier !== "string" || a.tier.length > 128) {
    throw new Error("gemini_oauth_credential_invalid");
  }
  if (typeof a.importedAt !== "string" || Number.isNaN(Date.parse(a.importedAt))) {
    throw new Error("gemini_oauth_credential_invalid");
  }
  let lastError: GeminiOauthAccount["lastError"] = null;
  if (a.lastError !== null && a.lastError !== undefined) {
    if (!a.lastError || typeof a.lastError !== "object" || !LAST_ERROR_ALLOWLIST.has(a.lastError.code)) {
      throw new Error("gemini_oauth_credential_invalid");
    }
    lastError = { code: a.lastError.code };
    const validationUrl = sanitizeValidationUrl(a.lastError.validationUrl);
    if (validationUrl) lastError.validationUrl = validationUrl;
  }
  const cooldownUntil =
    a.cooldownUntil === null || a.cooldownUntil === undefined
      ? null
      : Number.isFinite(a.cooldownUntil) && a.cooldownUntil > 0
        ? Math.floor(a.cooldownUntil)
        : (() => { throw new Error("gemini_oauth_credential_invalid"); })();
  let rawModelIds: string[] | undefined;
  if (Array.isArray(raw.rawModelIds)) {
    const ids = (raw.rawModelIds as unknown[]).filter((id): id is string => boundedString(id, 256) && !id.includes(","));
    if (ids.length > 256) throw new Error("gemini_oauth_credential_invalid");
    rawModelIds = [...new Set(ids)];
  }
  let hiddenModels: string[] | undefined;
  if (raw.hiddenModels !== undefined) {
    if (!Array.isArray(raw.hiddenModels)) throw new Error("gemini_oauth_credential_invalid");
    // Same id grammar as the hide route; anything else is a corrupt file, not
    // a value to silently drop (a dropped entry would resurrect a model).
    const hidden = (raw.hiddenModels as unknown[]).filter((id): id is string => boundedString(id, 256) && !id.includes(","));
    if (hidden.length !== raw.hiddenModels.length || hidden.length > 256) {
      throw new Error("gemini_oauth_credential_invalid");
    }
    hiddenModels = [...new Set(hidden)];
  }
  const data: GeminiOauthCredentialData = {
    version: 2,
    kind: "antigravity",
    account: {
      email: a.email,
      refreshToken: a.refreshToken,
      projectId: a.projectId,
      tier: a.tier,
      importedAt: a.importedAt,
      lastError,
      cooldownUntil,
    },
  };
  if (rawModelIds) data.rawModelIds = rawModelIds;
  if (hiddenModels?.length) data.hiddenModels = hiddenModels;
  const poolLocks = normalizeGeminiOauthPoolLocks(raw.poolLocks);
  if (poolLocks) data.poolLocks = poolLocks;
  return data;
}

export class GeminiOauthCredentialStore {
  constructor(readonly path: string) {}

  async load(): Promise<GeminiOauthCredentialData | null> {
    let file: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      file = await fs.open(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_CREDENTIAL_BYTES || (process.platform !== "win32" && stat.mode & 0o077)) {
        throw new Error("gemini_oauth_credential_unreadable");
      }
      const text = await file.readFile("utf8");
      return normalizeGeminiOauthData(JSON.parse(text));
    } catch (error: any) {
      if (error?.code === "ENOENT") return null;
      throw geminiOauthAdminError("gemini_oauth_credential_unreadable", 500);
    } finally {
      await file?.close();
    }
  }

  /** Atomic 0600 write (temp file + rename, fsync). */
  async save(data: GeminiOauthCredentialData): Promise<void> {
    const safe = normalizeGeminiOauthData(data);
    await fs.mkdir(dirname(this.path), { recursive: true, mode: 0o700 }).catch(() => {});
    const temp = `${this.path}.${randomBytes(12).toString("hex")}.tmp`;
    try {
      const file = await fs.open(temp, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(safe), "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await fs.rename(temp, this.path);
      if (process.platform !== "win32") await fs.chmod(this.path, 0o600);
    } catch {
      throw geminiOauthAdminError("gemini_oauth_config_write_failed", 500);
    } finally {
      await fs.unlink(temp).catch(() => {});
    }
  }

  async delete(): Promise<boolean> {
    try {
      await fs.unlink(this.path);
      return true;
    } catch (error: any) {
      if (error?.code === "ENOENT") return false;
      throw geminiOauthAdminError("gemini_oauth_config_write_failed", 500);
    }
  }
}

/** A service-layer failure with the stable admin code and its HTTP status. */
export function geminiOauthAdminError(code: string, statusCode = 422): Error & { code: string; statusCode: number; geminiOauth: true } {
  return Object.assign(new Error(code), { code, statusCode, geminiOauth: true as const });
}

// ---------------------------------------------------------------------------
// Router reference cleanup (disconnect / model-list shrink)
// ---------------------------------------------------------------------------

function refProviderModel(value: string): [string, string] | null {
  const i = value.indexOf(",");
  if (i <= 0 || i === value.length - 1) return null;
  return [value.slice(0, i), value.slice(i + 1)];
}

/**
 * Structural Router walk: drop/rewrite only `gemini-oauth,<model>` refs whose
 * model is in `models`. `default` is repointed to `firstVisible` (a still-registered
 * Gemini model) or cleared; scenario strings/arrays clear/drop; `models` alias
 * entries are removed; `families.<f>.default` is cleared; a nested
 * `fallback` chain drops matching stages and a stage emptied that way is removed
 * entirely. Unrelated refs, providers and models are byte-identical.
 */
export function clearGeminiOauthRouterRefs(
  router: any,
  models: ReadonlySet<string>,
  firstVisible: string | null
): { router: any; clearedRefs: string[]; removedRefs: string[] } {
  const clearedRefs: string[] = [];
  const removedRefs: string[] = [];
  if (!router || typeof router !== "object" || Array.isArray(router)) return { router, clearedRefs, removedRefs };
  const next = structuredClone(router);
  const hit = (v: string): boolean => {
    const pm = refProviderModel(v);
    return !!pm && pm[0] === GEMINI_OAUTH_PROVIDER_NAME && (models.size === 0 || models.has(pm[1]));
  };
  const record = (v: string) => {
    if (!removedRefs.includes(v)) removedRefs.push(v);
  };
  if (typeof next.default === "string" && hit(next.default)) {
    record(next.default);
    next.default = firstVisible ? `${GEMINI_OAUTH_PROVIDER_NAME},${firstVisible}` : "";
    clearedRefs.push("default");
  }
  for (const [k, v] of Object.entries(next)) {
    if (["default", "models", "families", "fallback"].includes(k)) continue;
    if (typeof v === "string" && hit(v)) {
      record(v);
      next[k] = "";
      clearedRefs.push(`scenario:${k}`);
    } else if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
      for (const item of v as string[]) if (hit(item)) record(item);
      const kept = (v as string[]).filter((x) => !hit(x));
      if (kept.length !== (v as string[]).length) {
        next[k] = kept;
        clearedRefs.push(`scenario:${k}`);
      }
    }
  }
  if (next.models && typeof next.models === "object" && !Array.isArray(next.models)) {
    for (const [k, v] of Object.entries(next.models)) {
      if (typeof v === "string" && hit(v)) {
        record(v);
        delete next.models[k];
        clearedRefs.push(`models:${k}`);
      }
    }
  }
  if (next.families && typeof next.families === "object" && !Array.isArray(next.families)) {
    for (const [f, fam] of Object.entries(next.families)) {
      if (fam && typeof fam === "object" && !Array.isArray(fam) && typeof (fam as any).default === "string" && hit((fam as any).default)) {
        record((fam as any).default);
        (fam as any).default = "";
        clearedRefs.push(`families.${f}.default`);
      }
    }
  }
  // Router.fallback is an ordered list of stages; each stage holds one or more
  // `<provider>,<model>` refs (string or array). Drop only the matching refs and
  // remove a stage that nothing references any more — the rest keeps its order.
  if (Array.isArray(next.fallback)) {
    const stages = next.fallback as any[];
    const kept: any[] = [];
    let changed = false;
    for (const stage of stages) {
      if (typeof stage === "string") {
        if (!hit(stage)) { kept.push(stage); continue; }
        record(stage); changed = true;
        continue;
      }
      if (Array.isArray(stage) && stage.every((x) => typeof x === "string")) {
        for (const item of stage as string[]) if (hit(item)) record(item);
        const rest = (stage as string[]).filter((x) => !hit(x));
        if (rest.length === stage.length) { kept.push(stage); continue; }
        changed = true;
        if (rest.length) kept.push(rest);
        continue;
      }
      kept.push(stage);
    }
    if (changed) {
      next.fallback = kept;
      clearedRefs.push("fallback");
    }
  }
  return { router: next, clearedRefs, removedRefs };
}

// ---------------------------------------------------------------------------
// Browser login state
// ---------------------------------------------------------------------------

interface PendingLogin {
  loginId: string;
  state: string;
  verifier: string;
  redirectUri: string;
  expiresAt: number;
  server: HttpServer;
  timer: NodeJS.Timeout;
  epoch: number;
  /** Resolves with the authorization code, or rejects on cancel/timeout/error. */
  callback: Promise<{ code: string }>;
  resolveCallback: (value: { code: string }) => void;
  rejectCallback: (error: Error) => void;
  result?: GeminiOauthPollResult;
  inFlight?: Promise<GeminiOauthPollResult>;
  lastPoll: number;
}

/** Error codes the login poll may report (admin catalogue, distinct from
 *  the data-plane taxonomy persisted in lastError). */
export type GeminiOauthPollErrorCode =
  | GeminiOauthErrorCode
  | "gemini_oauth_not_configured"
  | "gemini_oauth_not_connected"
  | "gemini_oauth_login_busy"
  | "gemini_oauth_login_cancelled"
  | "gemini_oauth_login_state_rejected"
  | "gemini_oauth_login_account_failed"
  | "gemini_oauth_login_persist_failed"
  | "gemini_oauth_name_conflict"
  | "gemini_oauth_models_fetch_failed";

export type GeminiOauthPollResult =
  | { status: "pending" }
  | { status: "success"; email: string | null }
  | { status: "failed"; error: GeminiOauthPollErrorCode };

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class GeminiOauthAuthService {
  /** Serial queue for every credential/config read-modify-write. */
  private mutationTail: Promise<unknown> = Promise.resolve();
  /** Bumped synchronously on disconnect; in-flight login persistence must abort. */
  private epoch = 0;
  private pending: PendingLogin | null = null;
  private loginStarting = 0;
  /** In-memory account snapshot; the 0600 file is the source of truth. */
  private readonly tokenState = createGeminiOauthTokenState();
  private account: GeminiOauthAccount | null = null;
  private rawModelIds: string[] = [];
  /** Persisted hide preference (UI model ids). Always mirrors the 0600 file. */
  private hiddenModels: string[] = [];
  private loaded = false;
  private loadFlight: Promise<GeminiOauthAccount | null> | null = null;
  private poolLocks: Record<string, number> = {};
  private quotaGeneration = 0;
  private quotaCache: { epoch: number; account: string; expiresAt: number; value: GeminiOauthQuotaSnapshot | null } | null = null;
  private quotaFlight: { epoch: number; account: string; promise: Promise<GeminiOauthQuotaSnapshot | null> } | null = null;
  /** Data-plane access-token refresh single-flight bridge (keyed refresh token). */
  private refreshFlight: { key: string; promise: Promise<string> } | null = null;

  constructor(private readonly options: GeminiOauthServiceOptions) {}

  private get log(): any {
    return this.options.logger ?? console;
  }

  private get store(): GeminiOauthCredentialStore {
    return this.options.store;
  }

  /** Fixed Google origins ignore configured CCR/proxy environment routing. */
  private directFetch(url: string, init: RequestInit = {}): ReturnType<GeminiOauthFetch> {
    return this.fetchImpl(url, { ...init, dispatcher: this.options.host.getDirectDispatcher() } as RequestInit);
  }

  private get fetchImpl(): GeminiOauthFetch {
    return this.options.fetch ?? ((url, init) => fetch(url, init));
  }

  private enqueueMutation<T>(action: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(action);
    this.mutationTail = result.catch(() => {});
    return result;
  }

  // ---------------------------------------------------------------- loading --

  private async ensureLoaded(force = false): Promise<GeminiOauthAccount | null> {
    if (this.loaded && !force) return this.account;
    if (this.loadFlight && !force) return this.loadFlight;
    const flight = (async () => {
      const data = await this.store.load().catch((): GeminiOauthCredentialData | null => null);
      const nextAccount = data?.account ?? null;
      if (this.accountIdentity(this.account) !== this.accountIdentity(nextAccount)) this.clearQuotaCache();
      this.account = nextAccount;
      this.poolLocks = data?.poolLocks ?? {};
      this.rawModelIds = data?.rawModelIds ?? [];
      this.hiddenModels = data?.hiddenModels ?? [];
      this.loaded = true;
      return this.account;
    })();
    this.loadFlight = flight;
    try { return await flight; }
    finally { if (this.loadFlight === flight) this.loadFlight = null; }
  }

  /**
   * Persist the account block. `rawModelIds`/`hiddenModels` default to the
   * in-memory values and are carried over explicitly: a token refresh or an
   * error bookkeeping write must never drop the hide preference.
   */
  private async writeAccount(account: GeminiOauthAccount, rawModelIds?: string[], hiddenModels?: string[]): Promise<void> {
    const data: GeminiOauthCredentialData = {
      version: 2,
      kind: "antigravity",
      account,
    };
    const ids = rawModelIds ?? this.rawModelIds;
    if (ids.length) data.rawModelIds = ids;
    const hidden = hiddenModels ?? this.hiddenModels;
    if (hidden.length) data.hiddenModels = hidden;
    const changedIdentity = this.accountIdentity(account) !== this.accountIdentity(this.account);
    if (!changedIdentity && Object.keys(this.poolLocks).length) data.poolLocks = pruneGeminiOauthPoolLocks(this.poolLocks, Date.now());
    await this.store.save(data);
    if (changedIdentity) this.clearQuotaCache();
    this.poolLocks = data.poolLocks ?? {};
    this.account = account;
    this.rawModelIds = ids.length ? ids : this.rawModelIds;
    this.hiddenModels = hidden;
  }

  // ----------------------------------------------------------------- status --

  async getStatus(): Promise<GeminiOauthStatusResult> {
    const account = await this.ensureLoaded();
    const { models, hiddenModels } = await this.managedModels();
    const now = Date.now();
    // A parked-account error is shown only while its cooldown is live,
    // EXCEPT sticky ones: a reauth failure cannot be waited out, so it stays
    // reported after the cooldown lapses (the cooldown bounds the recovery
    // probe's network spend; it does not mean the account recovered).
    const cooling = account?.cooldownUntil && account.cooldownUntil > now;
    const showLastError = account?.lastError
      ? (!account.cooldownUntil || cooling || isStickyGeminiOauthError(account.lastError.code))
      : false;
    const lastError = showLastError && account?.lastError
      ? {
          code: account.lastError.code,
          message: GEMINI_OAUTH_SAFE_MESSAGES[account.lastError.code] ?? GEMINI_OAUTH_SAFE_MESSAGES.gemini_oauth_upstream_error,
          ...(account.lastError.validationUrl ? { validationUrl: account.lastError.validationUrl } : {}),
        }
      : null;
    return {
      configured: isGeminiOauthConfigured(),
      connected: !!account,
      kind: "antigravity",
      email: account?.email ?? null,
      project: account?.projectId ?? null,
      tier: account?.tier ?? null,
      modelsCount: models.length,
      models,
      hiddenModels,
      lastError,
      cooldownUntil: cooling ? (account!.cooldownUntil as number) : null,
    };
  }

  /**
   * Visible + hidden managed models, both in the UI id space. The visible list
   * is the provider's registered list minus the hide preference, so status and
   * the saved config always agree (including the empty list when all are
   * hidden — no static fallback is re-added here).
   */
  private async managedModels(): Promise<{ models: string[]; hiddenModels: string[] }> {
    const hiddenModels = [...this.hiddenModels].filter(isGeminiOauthModelId);
    const hidden = new Set(hiddenModels);
    let registered: string[] = [];
    try {
      const config = await this.readConfig();
      const provider = this.findManaged(config);
      registered = Array.isArray(provider?.models)
        ? provider.models.filter((m: any): m is string => typeof m === "string")
        : [];
    } catch {
      registered = [];
    }
    const models = registered.filter((m) => !hidden.has(m));
    return { models, hiddenModels };
  }

  private async managedModelsCount(): Promise<number> {
    const { models } = await this.managedModels();
    return models.length;
  }

  private findManaged(config: any): any | undefined {
    for (const key of PROVIDER_KEYS) {
      const list = config?.[key];
      if (Array.isArray(list)) {
        const found = list.find((p: any) => isManagedGeminiOauthConfigProvider(p));
        if (found) return found;
      }
    }
    return undefined;
  }

  private async readConfig(): Promise<any> {
    try {
      return await this.options.host.readRawConfig();
    } catch {
      return {};
    }
  }

  // ---------------------------------------------------------- browser login --

  /**
   * Start one browser authorization: binds the loopback callback server
   * (127.0.0.1:0, /oauth-callback), builds the PKCE + state authorize URL.
   * At most one login runs at a time; TTL 30 minutes.
   */
  startLogin(): Promise<{ loginId: string; url: string; expiresAt: number }> {
    if (!isGeminiOauthConfigured()) {
      return Promise.reject(geminiOauthAdminError("gemini_oauth_not_configured", 503));
    }
    this.prunePending();
    if (this.pending || this.loginStarting > 0) {
      return Promise.reject(geminiOauthAdminError("gemini_oauth_login_busy", 429));
    }
    this.loginStarting++;
    return this.createPendingLogin()
      .catch((error) => {
        throw error?.code && GEMINI_OAUTH_LAST_ERROR_CODES.has(error.code as GeminiOauthErrorCode)
          ? error
          : geminiOauthAdminError("gemini_oauth_login_state_rejected", 500);
      })
      .finally(() => { this.loginStarting--; });
  }

  private async createPendingLogin(): Promise<{ loginId: string; url: string; expiresAt: number }> {
    // Both values are required and read from the environment only; a missing
    // value is a stable configuration error, never echoed.
    antigravityClientId();
    antigravityClientSecret();

    const { verifier, challenge } = createPkcePair();
    const state = randomBytes(24).toString("base64url");
    const loginId = randomBytes(24).toString("hex");

    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw geminiOauthAdminError("gemini_oauth_login_state_rejected", 500);
    }
    // magpie binds 127.0.0.1 but hands Google the `localhost` hostname
    // (antigravityApp.loopback); the browser resolves it back to loopback.
    const redirectUri = `http://localhost:${address.port}${GEMINI_OAUTH_CALLBACK_PATH}`;
    const url = buildAuthorizeUrl({ redirectUri, state, codeChallenge: challenge });
    const expiresAt = Date.now() + GEMINI_OAUTH_LOGIN_TTL_MS;

    let resolveCallback!: (value: { code: string }) => void;
    let rejectCallback!: (error: Error) => void;
    const callback = new Promise<{ code: string }>((resolve, reject) => {
      resolveCallback = resolve;
      rejectCallback = reject;
    });
    // A rejected/never-awaited callback promise must never crash the process.
    callback.catch(() => {});

    const job: PendingLogin = {
      loginId, state, verifier, redirectUri, expiresAt, server,
      timer: setTimeout(() => {
        this.terminalize(job, { status: "failed", error: "gemini_oauth_login_state_rejected" });
        job.rejectCallback(geminiOauthAdminError("gemini_oauth_login_state_rejected", 410));
      }, GEMINI_OAUTH_LOGIN_TTL_MS),
      epoch: this.epoch,
      callback, resolveCallback, rejectCallback, lastPoll: 0,
    };
    if (typeof job.timer.unref === "function") job.timer.unref();

    server.on("request", (req, res) => {
      try {
        this.handleCallback(req, res, job);
      } catch {
        try { res.statusCode = 500; res.end(); } catch { /* best-effort failure response; never mask the original error */ }
      }
    });

    this.pending = job;
    return { loginId, url, expiresAt };
  }

  /** Loopback callback handler: exact path, localhost Host, CSRF state. */
  private handleCallback(req: any, res: any, job: PendingLogin): void {
    const sendPage = (ok: boolean, heading: string, body: string) => {
      res.statusCode = ok ? 200 : 400;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(`<!doctype html><meta charset="utf-8"><title>${heading}</title>` +
        `<body style="font-family:system-ui;padding:2rem"><h2>${heading}</h2><p>${body}</p></body>`);
    };
    if (req.method !== "GET") {
      res.statusCode = 405;
      res.end();
      return;
    }
    let target: URL;
    try {
      target = new URL(req.url ?? "/", "http://127.0.0.1");
    } catch {
      res.statusCode = 400;
      res.end();
      return;
    }
    if (target.pathname === "/favicon.ico") {
      res.statusCode = 204;
      res.end();
      return;
    }
    if (target.pathname !== GEMINI_OAUTH_CALLBACK_PATH) {
      res.statusCode = 404;
      res.end();
      return;
    }
    // DNS-rebinding guard: the browser must address this loopback server by
    // its own localhost authority.
    const host = String(req.headers?.host ?? "");
    const port = (job.server.address() as any)?.port;
    const allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
    if (!allowedHosts.has(host)) {
      sendPage(false, "Sign-in rejected", "This request did not come from the local sign-in page.");
      return;
    }
    const params = target.searchParams;
    if (this.pending !== job || params.get("state") === null ||
      typeof params.get("state") !== "string" ||
      !this.sameState(params.get("state") as string, job.state) ||
      Date.now() >= job.expiresAt) {
      sendPage(false, "This link isn't from CCR's sign-in", "Start it again from CCR.");
      return;
    }
    const upstreamError = params.get("error");
    if (upstreamError) {
      sendPage(false, "Sign-in didn't finish", "Google declined the authorization. Start it again from CCR.");
      this.terminalize(job, { status: "failed", error: "gemini_oauth_login_state_rejected" });
      return;
    }
    const code = params.get("code");
    if (!code || code.length > 2048 || /[\x00-\x1f\x7f]/.test(code)) {
      sendPage(false, "Sign-in didn't finish", "The callback carried no valid code. Start it again from CCR.");
      this.terminalize(job, { status: "failed", error: "gemini_oauth_login_state_rejected" });
      return;
    }
    sendPage(true, "Sign-in received", "You can close this page and return to CCR.");
    // Stop listening immediately: one callback only; the job stays pending
    // while its token-exchange chain finishes.
    this.finishCallback(job, null, { code });
  }

  private sameState(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
  }

  /** Close the callback server and resolve/reject the code wait, but KEEP
   *  the job in `pending` until its exchange chain reaches a terminal result
   *  (the UI keeps polling the same loginId while tokens are exchanged). */
  private finishCallback(job: PendingLogin, error: Error | null, value?: { code: string }): void {
    clearTimeout(job.timer);
    job.server.close(() => {});
    if (error) job.rejectCallback(error);
    else if (value) job.resolveCallback(value);
  }

  /** Give a login its terminal poll result and free the single login slot. */
  private terminalize(job: PendingLogin, result: GeminiOauthPollResult): void {
    job.result = result;
    clearTimeout(job.timer);
    job.server.close(() => {});
    if (this.pending === job) this.pending = null;
  }

  cancelLogin(loginId: string): { ok: true } {
    const job = this.pending;
    if (job && job.loginId === loginId) {
      this.terminalize(job, { status: "failed", error: "gemini_oauth_login_state_rejected" });
      job.rejectCallback(geminiOauthAdminError("gemini_oauth_login_cancelled", 409));
    }
    return { ok: true };
  }

  async pollLogin(loginId: string): Promise<GeminiOauthPollResult> {
    if (typeof loginId !== "string" || !/^[a-f0-9]{48}$/.test(loginId)) {
      return { status: "failed", error: "gemini_oauth_login_state_rejected" };
    }
    const job = this.pending;
    if (!job || job.loginId !== loginId) {
      // A finished/unknown job may still be completing its chain; guard races
      // by returning rejected state. (Only the browser that started it polls.)
      return { status: "failed", error: "gemini_oauth_login_state_rejected" };
    }
    if (job.result) return job.result;
    if (Date.now() >= job.expiresAt) {
      this.terminalize(job, { status: "failed", error: "gemini_oauth_login_state_rejected" });
      return { status: "failed", error: "gemini_oauth_login_state_rejected" };
    }
    if (job.inFlight) return job.inFlight;
    if (Date.now() - job.lastPoll < 1000) return { status: "pending" };
    job.lastPoll = Date.now();
    job.inFlight = this.runLogin(job).finally(() => { job.inFlight = undefined; });
    return job.inFlight;
  }

  private failLogin(job: PendingLogin, error: GeminiOauthPollErrorCode): GeminiOauthPollResult {
    this.log.error?.(`[gemini-oauth] LOGIN_FAIL ${error} loginId=${job.loginId.slice(0, 8)}`);
    this.terminalize(job, { status: "failed", error });
    return job.result!;
  }

  /** Token → userinfo → project → models → persist credential + provider. */
  private async runLogin(job: PendingLogin): Promise<GeminiOauthPollResult> {
    let code: string;
    try {
      const callback = await Promise.race([
        job.callback,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), Math.max(1, job.expiresAt - Date.now()))),
      ]);
      code = callback.code;
    } catch {
      return this.failLogin(job, "gemini_oauth_login_state_rejected");
    }
    const epoch = job.epoch;
    const isCurrent = () => this.epoch === epoch && this.pending === job;

    let tokens: { accessToken: string; refreshToken: string; expiresIn: number };
    try {
      tokens = await exchangeCodeForTokens({
        code,
        codeVerifier: job.verifier,
        redirectUri: job.redirectUri,
        fetchImpl: (url, init) => this.directFetch(url, init),
      });
    } catch (error: any) {
      this.log.error?.(`[gemini-oauth] LOGIN_STEP_FAIL exchange: code=${error?.code ?? "none"} message=${error?.message ?? ""}`);
      return this.failLogin(job, "gemini_oauth_login_account_failed");
    }
    if (!isCurrent()) return this.failLogin(job, "gemini_oauth_login_state_rejected");

    let email: string;
    try {
      email = await fetchUserEmail(tokens.accessToken, (url, init) => this.directFetch(url, init));
    } catch (emailError: any) {
      this.log.error?.(`[gemini-oauth] LOGIN_STEP_FAIL email: code=${emailError?.code ?? "none"} message=${emailError?.message ?? ""}`);
      return this.failLogin(job, "gemini_oauth_login_account_failed");
    }

    let project: { projectId: string; tier: string };
    try {
      project = await discoverAntigravityProject(tokens.accessToken, (url, init) => this.directFetch(url, init));
    } catch (error: any) {
      this.log.error?.(`[gemini-oauth] LOGIN_STEP_FAIL project: code=${error?.code ?? "none"} status=${error?.httpStatus ?? "none"} message=${error?.message ?? ""}`);
      return this.failLogin(job, "gemini_oauth_login_account_failed");
    }

    // Model discovery never fails the login: the static table is the fallback.
    const { collapsed, rawIds } = await this.discoverModels(tokens.accessToken, project.projectId, project.tier);

    if (await this.hasNameConflict()) return this.failLogin(job, "gemini_oauth_name_conflict");
    if (!isCurrent()) return this.failLogin(job, "gemini_oauth_login_state_rejected");

    const previous = await this.store.load().catch((): GeminiOauthCredentialData | null => null);
    const account: GeminiOauthAccount = {
      email,
      refreshToken: tokens.refreshToken,
      projectId: project.projectId,
      tier: project.tier,
      importedAt: new Date().toISOString(),
      lastError: null,
      cooldownUntil: null,
    };
    try {
      await this.enqueueMutation(async () => {
        if (!isCurrent()) throw geminiOauthAdminError("gemini_oauth_login_cancelled", 409);
        // A re-authorization replaces the account, never the user's hide
        // preference: hidden models stay hidden across a re-login.
        const hidden = [...(previous?.hiddenModels ?? [])];
        await this.writeAccount(account, rawIds, hidden);
        if (!isCurrent()) throw geminiOauthAdminError("gemini_oauth_login_cancelled", 409);
        try {
          await this.upsertManagedProvider(collapsed.map((m) => m.id).filter((id) => !hidden.includes(id)));
        } catch (error) {
          // Provider write failed: roll the credential back so the account
          // is never half-connected.
          if (previous) await this.store.save(previous).catch(() => {});
          else await this.store.delete().catch(() => {});
          this.loaded = false;
          throw error;
        }
      });
    } catch (error: any) {
      if (error?.code === "gemini_oauth_name_conflict") return this.failLogin(job, "gemini_oauth_name_conflict");
      this.log.error?.("[gemini-oauth] login persist failed; credential rolled back");
      return this.failLogin(job, "gemini_oauth_login_persist_failed");
    }

    this.epoch++;
    this.clearQuotaCache();
    // The new refresh identity is now the only one future refreshes may use.
    clearGeminiOauthTokenCaches(this.tokenState);
    job.result = { status: "success", email };
    if (this.pending === job) this.pending = null;
    return job.result;
  }

  private prunePending(): void {
    const job = this.pending;
    if (job && Date.now() >= job.expiresAt && !job.result) {
      this.terminalize(job, { status: "failed", error: "gemini_oauth_login_state_rejected" });
      job.rejectCallback(geminiOauthAdminError("gemini_oauth_login_state_rejected", 410));
    }
  }

  private async hasNameConflict(): Promise<boolean> {
    const config = await this.readConfig();
    for (const key of PROVIDER_KEYS) {
      const list = config?.[key];
      if (!Array.isArray(list)) continue;
      if (list.some((p: any) => p?.name === GEMINI_OAUTH_PROVIDER_NAME && !isManagedGeminiOauthConfigProvider(p))) {
        return true;
      }
    }
    return false;
  }

  /** Live discovery with raw variants + collapsed list; static table on any failure. */
  private async discoverModels(
    accessToken: string,
    projectId: string,
    tier: string
  ): Promise<{ collapsed: GeminiOauthModelInfo[]; rawIds: string[] }> {
    const fetchImpl: GeminiOauthFetch = (url, init) => this.directFetch(url, init);
    try {
      const raw = await fetchAvailableModelVariants(accessToken, projectId, tier, fetchImpl);
      if (raw.length) {
        const collapsed = await fetchAvailableModels(accessToken, projectId, tier, fetchImpl);
        return { collapsed, rawIds: raw.map((m) => m.id) };
      }
    } catch (error: any) {
      this.log.warn?.(`[gemini-oauth] model discovery failed, using static table: ${GEMINI_OAUTH_LAST_ERROR_CODES.has(error?.code) ? error.code : "upstream"}`);
    }
    return {
      collapsed: GEMINI_OAUTH_FALLBACK_MODELS.map((m) => ({ id: m.id, name: m.name, images: m.images, picker: 0 })),
      rawIds: GEMINI_OAUTH_FALLBACK_MODELS.map((m) => m.id),
    };
  }

  // ------------------------------------------------------------------- sync --

  async syncModels(): Promise<GeminiOauthSyncResult> {
    const account = await this.ensureLoaded();
    if (!account) {
      throw geminiOauthAdminError("gemini_oauth_not_connected", 409);
    }
    const identity = await this.captureRequestIdentity();
    const accessToken = await this.getAccessToken();
    let raw: GeminiOauthModelInfo[];
    try {
      raw = await fetchAvailableModelVariants(
        accessToken,
        account.projectId,
        account.tier,
        (url, init) => this.directFetch(url, init)
      );
    } catch (error: any) {
      // Reauth-class failures are reported as such; everything else keeps the
      // previous model list.
      if (error?.code === "gemini_oauth_reauth_required") {
        throw geminiOauthAdminError("gemini_oauth_reauth_required", 401);
      }
      const count = await this.managedModelsCount();
      return { ok: false, modelsCount: count, clearedRefs: [], error: "gemini_oauth_models_fetch_failed" };
    }
    if (!raw.length) {
      const count = await this.managedModelsCount();
      return { ok: false, modelsCount: count, clearedRefs: [], error: "gemini_oauth_models_fetch_failed" };
    }
    const collapsedIds = (await fetchAvailableModels(
      accessToken,
      account.projectId,
      account.tier,
      (url, init) => this.directFetch(url, init)
    ).catch(() => raw)).map((m) => m.id);
    const rawIds = raw.map((m) => m.id);

    return this.enqueueMutation(async () => {
      const current = await this.store.load();
      if (!current || !this.matchesIdentity(identity, current.account)) throw geminiOauthAdminError("gemini_oauth_not_connected", 409);
      const config = await this.readConfig();
      const provider = this.findManaged(config);
      const currentModels: string[] = Array.isArray(provider?.models)
        ? provider.models.filter((m: any) => typeof m === "string")
        : [];
      // The hide preference survives a sync: discovery never resurrects a
      // hidden model, and `rawModelIds` keeps every unfolded variant so the
      // variant mapper still resolves a hidden family.
      const hidden = [...this.hiddenModels].filter(isGeminiOauthModelId);
      const hiddenSet = new Set(hidden);
      const visible = collapsedIds.filter((m) => !hiddenSet.has(m));
      const nextSet = new Set(visible);
      const dropped = new Set(currentModels.filter((m) => !nextSet.has(m)));
      const firstVisible = visible[0] ?? null;
      const cleaned = clearGeminiOauthRouterRefs(config.Router ?? {}, dropped, firstVisible);
      const previousConfig = structuredClone(config);
      try {
        await this.writeAccount({ ...current.account, lastError: null, cooldownUntil: null }, rawIds, hidden);
        await this.upsertManagedProvider(visible, { router: cleaned.clearedRefs.length ? cleaned.router : undefined });
      } catch {
        try { await this.options.host.writeConfig(previousConfig); await this.options.host.reloadRuntime(previousConfig); } catch { /* best-effort rollback; surface the original sync failure below */ }
        return { ok: false, modelsCount: currentModels.length, clearedRefs: [], error: "gemini_oauth_models_fetch_failed" } as GeminiOauthSyncResult;
      }
      return { ok: true, modelsCount: visible.length, clearedRefs: cleaned.clearedRefs };
    });
  }

  // ------------------------------------------------- hide / restore models ---

  /**
   * Hide one model (an explicit user action).
   *  - The blacklist stores the id the UI showed (a collapsed effort-family id
   *    is hidden as a whole family); `rawModelIds` keeps every unfolded variant
   *    so the variant mapper still resolves wire ids.
   *  - The managed provider's `models` loses the id immediately, so status, the
   *    saved config and the picker stay consistent.
   *  - Router is structurally cleaned for the hidden refs only; unrelated
   *    providers/models are byte-identical.
   *  - Credential and config writes share the single mutation queue. A failure
   *    restores the previous credential file AND the previous config.
   */
  async hideModel(model: string): Promise<GeminiOauthHideResult> {
    if (!isGeminiOauthModelId(model)) throw geminiOauthAdminError("gemini_oauth_model_invalid", 422);
    return this.enqueueMutation(async () => {
      const data = await this.store.load().catch((): GeminiOauthCredentialData | null => null);
      if (!data) throw geminiOauthAdminError("gemini_oauth_not_connected", 409);
      const previousHidden = data.hiddenModels ?? [];
      const config = await this.readConfig();
      const previousConfig = structuredClone(config);
      const provider = this.findManaged(config);
      // Only a model this provider actually exposes can be hidden: an arbitrary
      // id would be written into the Router walk and the blacklist.
      const registered = Array.isArray(provider?.models)
        ? (provider.models as unknown[]).filter((m): m is string => typeof m === "string")
        : [];
      if (!registered.includes(model)) throw geminiOauthAdminError("gemini_oauth_model_invalid", 422);
      const hidden = [...new Set([...previousHidden, model])];
      const visible = registered.filter((m) => !hidden.includes(m));
      const firstVisible = visible[0] ?? null;
      const cleaned = clearGeminiOauthRouterRefs(config.Router ?? {}, new Set([model]), firstVisible);
      try {
        await this.store.save({ ...data, hiddenModels: hidden });
        this.hiddenModels = hidden;
        await this.upsertManagedProvider(visible, { router: cleaned.clearedRefs.length ? cleaned.router : undefined });
      } catch {
        try {
          await this.store.save(data);
          this.hiddenModels = previousHidden;
          await this.options.host.writeConfig(previousConfig);
          await this.options.host.reloadRuntime(previousConfig);
        } catch {
          // Sanitized: a raw error may carry a filesystem path.
          this.log.error?.("[gemini-oauth] hide rollback failed");
        }
        this.log.error?.("[gemini-oauth] hide persist failed; rolled back");
        throw geminiOauthAdminError("gemini_oauth_config_write_failed", 500);
      }
      const persisted = await this.readConfig().catch(() => null);
      const defaultFallback = typeof persisted?.Router?.default === "string" ? persisted.Router.default : null;
      return {
        ok: true as const,
        clearedRefs: cleaned.clearedRefs,
        removedModelRefs: cleaned.removedRefs,
        defaultFallback,
        models: visible,
        hiddenModels: hidden,
      };
    });
  }

  /**
   * Restore one hidden model, or every hidden model when `model` is omitted.
   * Restoration only re-registers models that are still part of the account's
   * discovered set — a model the upstream no longer serves is dropped from the
   * blacklist without being re-registered. Router is never rewritten here
   * (re-wiring stays the user's explicit action, and an old fallback must not
   * silently come back).
   */
  async restoreModels(model?: string): Promise<GeminiOauthRestoreResult> {
    if (model !== undefined && !isGeminiOauthModelId(model)) {
      throw geminiOauthAdminError("gemini_oauth_model_invalid", 422);
    }
    return this.enqueueMutation(async () => {
      const data = await this.store.load().catch((): GeminiOauthCredentialData | null => null);
      if (!data) throw geminiOauthAdminError("gemini_oauth_not_connected", 409);
      const previousHidden = data.hiddenModels ?? [];
      const hiddenSet = new Set(previousHidden);
      const config = await this.readConfig();
      const previousConfig = structuredClone(config);
      const provider = this.findManaged(config);
      const registered: string[] = Array.isArray(provider?.models)
        ? (provider.models as unknown[]).filter((m): m is string => typeof m === "string")
        : [];
      // Restorable = hidden IDs this account still exposes. "Available" is the
      // union of today's registration, the persisted unfolded discovery set and
      // the family ids that set collapses into (a family hide is restorable
      // exactly when discovery still collapses that family).
      const rawModelIds = (data.rawModelIds ?? []).filter(isGeminiOauthModelId);
      const available = new Set<string>([
        ...registered,
        ...rawModelIds,
        ...collapseAntigravityModels(rawModelIds.map((id) => ({ id, picker: 0 }))).map((m) => m.id),
      ]);
      const requested = model === undefined ? [...hiddenSet] : (hiddenSet.has(model) ? [model] : []);
      const restorable = requested.filter((m) => available.has(m));
      // Restore-all clears every blacklist entry (an id the upstream no longer
      // serves must not linger forever) and a single restore clears only its own,
      // so one vanished id never blocks the others.
      const nextHidden = model === undefined ? [] : previousHidden.filter((m) => m !== model);
      // The provider's own order decides where a restored model sits: in a synced
      // list a hidden family is still registered as its collapsed id, so that
      // slot is reused instead of appending a duplicate. Only `restorable` models
      // actually become visible.
      const restorableSet = new Set(restorable);
      const nextVisible: string[] = [];
      for (const m of registered) {
        if (restorableSet.has(m) && !nextVisible.includes(m)) { nextVisible.push(m); continue; }
        if (!restorableSet.has(m)) nextVisible.push(m);
      }
      for (const m of restorable) if (!nextVisible.includes(m)) nextVisible.push(m);
      try {
        await this.store.save({ ...data, hiddenModels: nextHidden });
        this.hiddenModels = nextHidden;
        await this.upsertManagedProvider(nextVisible);
      } catch {
        try {
          await this.store.save(data);
          this.hiddenModels = previousHidden;
          await this.options.host.writeConfig(previousConfig);
          await this.options.host.reloadRuntime(previousConfig);
        } catch {
          this.log.error?.("[gemini-oauth] restore rollback failed");
        }
        this.log.error?.("[gemini-oauth] restore persist failed; rolled back");
        throw geminiOauthAdminError("gemini_oauth_config_write_failed", 500);
      }
      return { ok: true as const, restored: restorable, models: nextVisible, hiddenModels: nextHidden };
    });
  }

  // -------------------------------------------------------------- disconnect --

  async disconnect(): Promise<GeminiOauthDisconnectResult> {
    this.clearQuotaCache();
    const job = this.pending;
    if (job) {
      this.epoch++;
      this.terminalize(job, { status: "failed", error: "gemini_oauth_login_state_rejected" });
      job.rejectCallback(geminiOauthAdminError("gemini_oauth_login_cancelled", 409));
    } else {
      this.epoch++;
    }
    return this.enqueueMutation(async () => {
      const config = await this.readConfig();
      const provider = this.findManaged(config);
      // Disconnect removes every registered AND hidden managed model reference,
      // including folded variants that a previous release registered.
      const models = new Set<string>([
        ...(Array.isArray(provider?.models) ? provider.models.filter((m: any) => typeof m === "string") : []),
        ...this.hiddenModels,
      ]);
      const removedModelRefs: string[] = [];
      let defaultFallback: string | null = null;
      const previousConfig = structuredClone(config);
      let removedProvider = false;
      if (provider) {
        const cleaned = clearGeminiOauthRouterRefs(config.Router ?? {}, models, null);
        for (const key of PROVIDER_KEYS) {
          const list = config?.[key];
          if (!Array.isArray(list)) continue;
          const index = list.findIndex((p: any) => p === provider || isManagedGeminiOauthConfigProvider(p));
          if (index >= 0) {
            list.splice(index, 1);
            config[key] = list;
            removedProvider = true;
          }
        }
        if (cleaned.clearedRefs.length) config.Router = cleaned.router;
        try {
          await this.options.host.writeConfig(config);
        } catch {
          try { await this.options.host.writeConfig(previousConfig); await this.options.host.reloadRuntime(previousConfig); } catch { /* best-effort rollback; the original write failure is rethrown below */ }
          throw geminiOauthAdminError("gemini_oauth_config_write_failed", 500);
        }
        removedModelRefs.push(...cleaned.removedRefs);
        const persisted = await this.readConfig().catch(() => null);
        defaultFallback = typeof persisted?.Router?.default === "string" ? persisted.Router.default : null;
        await this.options.host.reloadRuntime(config);
      }
      // Credential file last: a failed provider write leaves the account intact.
      await this.store.delete().catch(() => {});
      this.account = null;
      this.poolLocks = {};
      this.rawModelIds = [];
      this.hiddenModels = [];
      this.loaded = false;
      this.refreshFlight = null;
      clearGeminiOauthTokenCaches(this.tokenState);
      void removedProvider;
      return { ok: true as const, removedModelRefs, defaultFallback };
    });
  }

  // ------------------------------------------------------- data-plane access --

  /**
   * Live access token for the data plane. The memory refresh is single-flight
   * keyed by the current refresh token; when Google rotates the refresh token
   * it is durably persisted (through the mutation queue) BEFORE the cache
   * identity switches.
   */
  async getAccessToken(): Promise<string> {
    const account = await this.ensureLoaded();
    if (!account) throw geminiOauthAdminError("gemini_oauth_not_connected", 409);
    const key = `${account.refreshToken}|${account.importedAt}`;
    if (this.refreshFlight?.key === key) return this.refreshFlight.promise;
    const epoch = this.epoch;
    const promise = refreshAccessToken(
      account.refreshToken,
      (url, init) => this.directFetch(url, init),
      Date.now(),
      (rotated: string) => this.persistRotatedRefreshToken(rotated, account.refreshToken, epoch),
      this.tokenState
    ).then(token => {
      if (this.epoch !== epoch) {
        clearGeminiOauthTokenCaches(this.tokenState);
        throw geminiOauthAdminError("gemini_oauth_not_connected", 409);
      }
      return token;
    }).catch(async (error) => {
      if (this.refreshFlight?.key === key) this.refreshFlight = null;
      // Same epoch guard the success branch has: a flight started before a
      // disconnect/reconnect belongs to the OLD account. noteUpstreamError()
      // writes onto whatever credential file exists at write time, so without
      // this a stale failure would park a just-re-authorized account for an
      // hour — the exact pain this fix exists to remove.
      if (this.epoch !== epoch) throw error;
      // A rejected refresh grant is the most common way a login expires, and it
      // happens BEFORE any data-plane call — so no response ever reaches the
      // classifier and noteUpstreamError. Record it here, otherwise the account
      // keeps no state at all: the recovery probe sees a healthy account and
      // spends a real refresh call on the dead token every interval, while the
      // UI card reports "connected".
      if (error?.code === "gemini_oauth_reauth_required") {
        const cooldownMs = typeof error.cooldownMs === "number" ? error.cooldownMs : GEMINI_OAUTH_REAUTH_COOLDOWN_MS;
        // Awaited, not fire-and-forget: the parked state must be durable before
        // the failure reaches the caller, otherwise a probe that runs between
        // the throw and the write would still see a healthy account.
        try {
          await this.noteUpstreamError({
            code: "gemini_oauth_reauth_required",
            message: error.message ?? "Gemini OAuth 登录态已失效，请重新授权登录。",
            httpStatus: 401,
            cooldownMs,
          }, undefined, { epoch, account: this.accountIdentity(account) });
        } catch {
          // Bookkeeping must never mask the original failure.
        }
      }
      throw error;
    });
    this.refreshFlight = { key, promise };
    try {
      return await promise;
    } finally {
      if (this.refreshFlight?.key === key && this.refreshFlight.promise === promise) {
        // Keep the flight briefly? No: token caching lives inside refreshAccessToken.
        this.refreshFlight = null;
      }
    }
  }

  /**
   * Durably persist a rotated refresh token before the cache switches to it.
   * The write spreads the CURRENT file contents, so `rawModelIds` and
   * `hiddenModels` travel with it untouched.
   */
  private persistRotatedRefreshToken(rotated: string, expected: string, epoch: number): Promise<void> {
    return this.enqueueMutation(async () => {
      const current = await this.store.load().catch((): GeminiOauthCredentialData | null => null);
      if (!current || this.epoch !== epoch || current.account.refreshToken !== expected) {
        throw geminiOauthAdminError("gemini_oauth_not_connected", 409);
      }
      const next: GeminiOauthCredentialData = {
        ...current,
        account: { ...current.account, refreshToken: rotated },
      };
      await this.store.save(next);
      this.account = next.account;
      this.hiddenModels = next.hiddenModels ?? [];
    });
  }

  /** The 401 seam's one forced re-send: drop the cached access token. */
  async forceTokenRefresh(): Promise<void> {
    const account = this.account ?? (await this.ensureLoaded());
    invalidateGeminiOauthAccessToken(account?.refreshToken, this.tokenState);
  }

  async getProject(): Promise<string> {
    const account = await this.ensureLoaded();
    if (!account?.projectId) throw geminiOauthAdminError("gemini_oauth_not_connected", 409);
    return account.projectId;
  }

  async resolveWireModel(requested: string, effort?: string): Promise<string> {
    await this.ensureLoaded();
    const raw = this.rawModelIds.length
      ? this.rawModelIds.map((id) => ({ id }))
      : GEMINI_OAUTH_FALLBACK_MODELS;
    return antigravityWireModel(raw, requested, effort);
  }

  private accountIdentity(account: GeminiOauthAccount | null): string {
    return account ? JSON.stringify([account.email, account.importedAt, account.projectId]) : "";
  }

  async captureRequestIdentity(): Promise<GeminiOauthRequestIdentity> {
    const epoch = this.epoch;
    const account = await this.ensureLoaded();
    return { epoch, account: this.accountIdentity(account) };
  }

  async isRequestIdentityCurrent(identity: GeminiOauthRequestIdentity): Promise<boolean> {
    const account = await this.ensureLoaded();
    return this.matchesIdentity(identity, account);
  }

  private matchesIdentity(identity: GeminiOauthRequestIdentity, account: GeminiOauthAccount | null): boolean {
    return identity.epoch === this.epoch && identity.account === this.accountIdentity(account);
  }

  async isAccountCooling(model?: string): Promise<boolean> {
    const account = await this.ensureLoaded();
    // Old quota-only parks have no attributable model. Known siblings must
    // not inherit that account-wide lock after upgrading.
    if (model && account?.lastError?.code === "gemini_oauth_quota_exceeded") return false;
    return !!account?.cooldownUntil && account.cooldownUntil > Date.now();
  }

  async getPoolCooldown(model: string): Promise<{ pool: string; until: number } | null> {
    await this.ensureLoaded();
    const pool = geminiOauthQuotaPool(model);
    const until = this.poolLocks[pool];
    return pool && until > Date.now() ? { pool, until } : null;
  }

  private clearQuotaCache(): void {
    this.quotaGeneration++;
    this.quotaCache = null;
    this.quotaFlight = null;
  }

  /** Shared advisory read for the runtime and admin route. Null is cached too. */
  async getQuota(): Promise<GeminiOauthQuotaSnapshot | null> {
    const identity = await this.captureRequestIdentity();
    if (!this.matchesIdentity(identity, this.account)) return null;
    const now = Date.now();
    const account = this.account;
    const globallyParked = account && account.lastError?.code !== "gemini_oauth_quota_exceeded" &&
      (isStickyGeminiOauthError(account.lastError?.code) || (!!account.cooldownUntil && account.cooldownUntil > now));
    if (globallyParked) return null;
    if (this.quotaCache?.epoch === identity.epoch && this.quotaCache.account === identity.account && this.quotaCache.expiresAt > now) return this.quotaCache.value;
    if (this.quotaFlight?.epoch === identity.epoch && this.quotaFlight.account === identity.account) return this.quotaFlight.promise;
    const generation = this.quotaGeneration;
    const promise = (async () => {
      let value: GeminiOauthQuotaSnapshot | null = null;
      try {
        const account = this.account;
        const legacyQuota = account?.lastError?.code === "gemini_oauth_quota_exceeded";
        if (account && !isStickyGeminiOauthError(account.lastError?.code) &&
            (legacyQuota || !account.cooldownUntil || account.cooldownUntil <= Date.now())) {
          const accessToken = await this.getAccessToken();
          if (!this.matchesIdentity(identity, this.account)) return null;
          const snapshot = await fetchGeminiOauthQuota({ accessToken, project: account.projectId, fetchImpl: (url, init) => this.directFetch(url, init) });
          if (Object.keys(snapshot.models).length || snapshot.pools.length) value = snapshot;
        }
      } catch { /* Advisory failure; null is cached to bound polling traffic. */ }
      if (!this.matchesIdentity(identity, this.account) || generation !== this.quotaGeneration) return null;
      this.quotaCache = { ...identity, expiresAt: Date.now() + GEMINI_OAUTH_QUOTA_CACHE_TTL_MS, value };
      return value;
    })();
    const flight = { ...identity, promise };
    this.quotaFlight = flight;
    try { return await promise; }
    finally { if (this.quotaFlight === flight) this.quotaFlight = null; }
  }

  /** Capture before joining the mutation queue; stale replies cannot affect a
   *  replacement login, even if the file is replaced while waiting to write. */
  async noteUpstreamError(info: GeminiOauthErrorInfo, model?: string, requestIdentity?: GeminiOauthRequestIdentity): Promise<void> {
    if (isGeminiOauthBreakerCode(info.code)) return;
    const identity = requestIdentity ?? await this.captureRequestIdentity();
    await this.enqueueMutation(async () => {
      const current = await this.store.load().catch((): GeminiOauthCredentialData | null => null);
      if (!current || !this.matchesIdentity(identity, current.account)) return;
      const now = Date.now();
      const account = { ...current.account };
      const poolLocks = pruneGeminiOauthPoolLocks(current.poolLocks ?? {}, now);
      const accountProtected = isStickyGeminiOauthError(account.lastError?.code) ||
        (account.lastError?.code !== "gemini_oauth_quota_exceeded" && !!account.cooldownUntil && account.cooldownUntil > now);
      if (info.code === "gemini_oauth_quota_exceeded") {
        const pool = geminiOauthQuotaPool(model);
        if (pool) {
          const duration = typeof info.cooldownMs === "number" && Number.isFinite(info.cooldownMs) && info.cooldownMs > 0
            ? info.cooldownMs : GEMINI_OAUTH_QUOTA_COOLDOWN_MS;
          poolLocks[pool] = Math.max(poolLocks[pool] ?? 0, now + duration);
        }
        // No model means no attributable quota lock: never invent an
        // account-wide park, and skip the write when nothing would change.
        if (accountProtected) {
          if (!pool) return;
        } else if (account.lastError || account.cooldownUntil) {
          account.lastError = null;
          account.cooldownUntil = null;
        } else if (!pool) {
          return;
        }
      } else if (!accountProtected || isStickyGeminiOauthError(info.code)) {
        account.lastError = { code: info.code, ...(info.validationUrl ? { validationUrl: info.validationUrl } : {}) };
        account.cooldownUntil = info.cooldownMs ? now + info.cooldownMs : null;
      }
      const next: GeminiOauthCredentialData = { ...current, account, poolLocks };
      await this.store.save(next);
      this.account = account;
      if (info.code !== "gemini_oauth_quota_exceeded") this.clearQuotaCache();
      this.poolLocks = normalizeGeminiOauthPoolLocks(poolLocks) ?? {};
      this.hiddenModels = next.hiddenModels ?? [];
    }).catch(() => { /* Bookkeeping cannot break the response path. */ });
  }

  /** A success never clears an active quota lock, including a newer same-pool
   *  refusal while an older request finishes. Account guards also survive. */
  async noteRequestSuccess(model?: string, requestIdentity?: GeminiOauthRequestIdentity): Promise<void> {
    const identity = requestIdentity ?? await this.captureRequestIdentity();
    await this.enqueueMutation(async () => {
      const current = await this.store.load().catch((): GeminiOauthCredentialData | null => null);
      if (!current || !this.matchesIdentity(identity, current.account)) return;
      const account = { ...current.account };
      const now = Date.now();
      const protectedAccount = isStickyGeminiOauthError(account.lastError?.code) ||
        (account.lastError?.code !== "gemini_oauth_quota_exceeded" && !!account.cooldownUntil && account.cooldownUntil > now);
      if (protectedAccount) return;
      const poolLocks = pruneGeminiOauthPoolLocks(current.poolLocks ?? {}, now);
      if (!account.lastError && !account.cooldownUntil && Object.keys(poolLocks).length === Object.keys(current.poolLocks ?? {}).length) return;
      account.lastError = null;
      account.cooldownUntil = null;
      const next: GeminiOauthCredentialData = { ...current, account, poolLocks };
      await this.store.save(next);
      this.account = account;
      this.poolLocks = poolLocks;
      this.hiddenModels = next.hiddenModels ?? [];
    }).catch(() => { /* Bookkeeping cannot break the response path. */ });
  }

  // ------------------------------------------------------- config mutation ---

  /**
   * Fresh raw-config read → managed entry upsert (name/URL/key/transformer
   * locked, `enabled:false` preserved) → existing save semantics. Never
   * modifies Router.
   */
  private async upsertManagedProvider(models: string[], options?: { router?: any }): Promise<void> {
    const config = await this.options.host.readRawConfig();
    const previousConfig = structuredClone(config);
    const routerBefore = JSON.stringify(config.Router ?? null);
    let list: any[] = [];
    let usedKey: (typeof PROVIDER_KEYS)[number] = "Providers";
    for (const key of PROVIDER_KEYS) {
      if (Array.isArray(config?.[key])) { usedKey = key; list = config[key]; break; }
    }
    if (!Array.isArray(config[usedKey])) {
      config[usedKey] = list = [];
    }
    const index = list.findIndex((p: any) => isManagedGeminiOauthConfigProvider(p));
    if (index >= 0) {
      const existing = list[index];
      const enabled = existing.enabled !== false;
      list[index] = lockGeminiOauthProvider({ ...existing, models, enabled });
    } else {
      list.push(lockGeminiOauthProvider({ name: GEMINI_OAUTH_PROVIDER_NAME, models, enabled: true }));
    }
    config[usedKey] = list;
    if (options?.router) config.Router = options.router;

    // Defence in depth: a generic save must never redirect managed transport.
    protectGeminiOauthConfig(config, config);
    try {
      await this.options.host.writeConfig(config);
    } catch {
      try {
        await this.options.host.writeConfig(previousConfig);
        await this.options.host.reloadRuntime(previousConfig);
      } catch {
        this.log.error?.("[gemini-oauth] previous configuration restoration failed");
      }
      throw geminiOauthAdminError("gemini_oauth_config_write_failed", 500);
    }
    const expectedRouter = options?.router ?? previousConfig.Router;
    if (JSON.stringify(config.Router ?? null) !== JSON.stringify(expectedRouter ?? null)) {
      throw new Error("Gemini OAuth 配置写入被拒绝：Router 发生变化");
    }
    void routerBefore;
    await this.options.host.reloadRuntime(config);
  }

}
