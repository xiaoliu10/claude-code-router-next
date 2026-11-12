/**
 * Codex subscription — credential storage, PKCE browser login state machine
 * (1455 / registered 1457 fallback / paste-callback), token lifecycle
 * (single-flight refresh, persist-before-use, outlives caller cancellation),
 * dynamic model + instruction cache, wham usage and the managed-provider
 * config upsert.
 *
 * Invariants (implementation contract):
 *  - Tokens live ONLY in the 0600 `<configDir>/codex-credentials.json`; they
 *    never enter config.json, Router, logs, errors or status responses.
 *  - Managed provider name is `codex-subscription`; a user provider named
 *    `codex` is never touched.
 *  - Raw config read → minimal managed-entry mutation → write → reload.
 *    Router changes only for explicit hide cleanup; unrelated providers survive byte-for-byte.
 *  - At most one login per service. Strict one-use state, exact callback
 *    path, loopback-only listener, TTL expiry, explicit cancel.
 *  - We NEVER send /cancel to another app's listener: busy 1455 moves us to
 *    1457, busy both moves the login to paste mode.
 *  - A refresh always runs to completion and persists rotated tokens BEFORE
 *    the fresh access token is used, even if the caller stopped waiting.
 *
 * Canonical host API types are type-only imports (erased at build time); no
 * host runtime module is ever imported.
 */
import { clearCodexRouterRefs } from "./router";
import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { promises as fs, constants } from "node:fs";
import { dirname, join } from "node:path";
import type { PluginClassifiedError, PluginHostCapabilities } from "../../../core/src/provider-plugins/types";
import {
  CODEX_CALLBACK_PATH,
  CODEX_CALLBACK_PORTS,
  CODEX_LOOPBACK_HOSTS,
  CODEX_LOGIN_TTL_MS,
  CODEX_PROVIDER_NAME,
  CODEX_REFRESH_LEAD_MS,
  accessTokenExpiryMs,
  codexAdminError,
  buildCodexAuthorizeUrl,
  createCodexPkce,
  consumeCodexResetCredit,
  exchangeCodexCode,
  fetchCodexModels,
  fetchCodexResetCredits,
  fetchCodexUsage,
  isCodexManagedConfigProvider,
  isCodexModelId,
  lockCodexProvider,
  protectCodexConfig,
  randomToken,
  rateLimitsSaturated,
  readCodexIdClaims,
  refreshCodexTokens,
  safeEqualState,
  selectCodexModels,
  CODEX_SAFE_MESSAGES,
  type CodexAdminCode,
  type CodexErrorCode,
  type CodexFetch,
  type CodexFetchInit,
  type CodexLoginPoll,
  type CodexLoginStart,
  type CodexModelInfo,
  type CodexRateLimits,
  type CodexResetCredits,
  type CodexResetConsumeResult,
  type CodexStatus,
  type CodexTokens,
  type CodexUsage,
} from "./protocol";

export const CODEX_CREDENTIAL_FILE = "codex-credentials.json";
const MAX_CREDENTIAL_BYTES = 256 * 1024;
const PROVIDER_KEYS = ["Providers", "providers"] as const;
/** Usage reads are at-most-once-a-minute (magpie #1295: near-cap accounts). */
const USAGE_CACHE_MS = 60_000;

// ---------------------------------------------------------------------------
// On-disk credential schema
// ---------------------------------------------------------------------------

export interface CodexStoredModel {
  slug: string;
  displayName: string;
  instructions?: string;
}

export interface CodexAccountRecord {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  accountId: string;
  email: string;
  plan: string;
  connectedAt: string;
  /** Access-token JWT exp in epoch ms; null when the JWT carried no exp. */
  accessExp: number | null;
  /** Data-plane error channel (noteUpstreamError). */
  lastError: { code: CodexErrorCode } | null;
  cooldownUntil: number | null;
  /** Rate-limit observation channel (noteRateLimits) — kept separate. */
  rateLimitCooldownUntil: number | null;
}

export interface CodexCredentialData {
  version: 1;
  kind: "codex-subscription";
  account: CodexAccountRecord;
  /** Full discovered model list (including hidden ones — restore needs it). */
  models: CodexStoredModel[];
  /** User-hidden model slugs (workbuddy-style blacklist: survives sync/re-login). */
  hiddenModels: string[];
  rateLimits: CodexRateLimits | null;
}

/** Result of POST /api/codex/models/hide (route adds the ok/success envelope). */
export interface CodexModelHideResult {
  success: true;
  model: string;
  /** Registered, visible models after the hide. */
  models: string[];
  hiddenModels: string[];
}

/** Result of POST /api/codex/models/restore; `restored` is empty for no-ops. */
export interface CodexModelRestoreResult {
  success: true;
  restored: string[];
  models: string[];
  hiddenModels: string[];
}

const LAST_ERROR_CODES: ReadonlySet<string> = new Set<CodexErrorCode>([
  "codex_reauth_required",
  "codex_usage_limit",
  "codex_rate_limited",
  "codex_overloaded",
  "codex_request_rejected",
  "codex_upstream_error",
]);

function boundedString(value: unknown, max: number, min = 1): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
}

function normalizeRateLimits(raw: unknown): CodexRateLimits | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as any;
  if (typeof r.observedAt !== "number" || !Number.isFinite(r.observedAt) || (r.source !== "headers" && r.source !== "sse")) {
    return null;
  }
  const window = (w: any) => {
    if (!w || typeof w !== "object" || typeof w.usedPercent !== "number") return undefined;
    const out: CodexRateLimits["primary"] = { usedPercent: w.usedPercent };
    if (typeof w.windowSeconds === "number") out!.windowSeconds = w.windowSeconds;
    if (typeof w.resetAt === "number") out!.resetAt = w.resetAt;
    return out;
  };
  return {
    ...(window(r.primary) ? { primary: window(r.primary) } : {}),
    ...(window(r.secondary) ? { secondary: window(r.secondary) } : {}),
    observedAt: r.observedAt,
    source: r.source,
  };
}

/** Whitelist normalization — unknown fields never survive a round trip. */
export function normalizeCodexCredentialData(raw: any): CodexCredentialData {
  const invalid = () => codexAdminError("codex_credential_invalid", 500);
  if (!raw || typeof raw !== "object" || raw.version !== 1 || raw.kind !== "codex-subscription") {
    throw invalid();
  }
  const a = raw.account;
  if (!a || typeof a !== "object") throw invalid();
  for (const key of ["accessToken", "refreshToken", "idToken"] as const) {
    if (!boundedString(a[key], 16_384)) throw invalid();
  }
  for (const key of ["accountId", "email", "plan"] as const) {
    if (typeof a[key] !== "string" || a[key].length > 320) throw invalid();
  }
  if (typeof a.connectedAt !== "string" || Number.isNaN(Date.parse(a.connectedAt))) {
    throw invalid();
  }
  if (a.accessExp !== null && !(typeof a.accessExp === "number" && Number.isFinite(a.accessExp))) {
    throw invalid();
  }
  let lastError: CodexAccountRecord["lastError"] = null;
  if (a.lastError !== null && a.lastError !== undefined) {
    if (!a.lastError || typeof a.lastError !== "object" || !LAST_ERROR_CODES.has(a.lastError.code)) {
      throw invalid();
    }
    lastError = { code: a.lastError.code };
  }
  const cooldown = (v: unknown) =>
    v === null || v === undefined ? null :
      typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : (() => { throw invalid(); })();
  const models: CodexStoredModel[] = [];
  if (Array.isArray(raw.models)) {
    if (raw.models.length > 256) throw invalid();
    for (const m of raw.models) {
      if (!m || typeof m !== "object" || !boundedString(m.slug, 256)) continue;
      const item: CodexStoredModel = {
        slug: m.slug,
        displayName: boundedString(m.displayName, 256) ? m.displayName : m.slug,
      };
      if (typeof m.instructions === "string" && m.instructions.length > 0 && m.instructions.length <= 65_536) {
        item.instructions = m.instructions;
      }
      models.push(item);
    }
  }
  const rateLimits = normalizeRateLimits(raw.rateLimits);
  // Blacklist normalization mirrors `models`: wrong-shaped entries are skipped
  // (a polluted entry may at worst make a model visible again — never crash
  // the whole credential), duplicates collapse, and the count is capped.
  const hiddenModels: string[] = [];
  if (Array.isArray(raw.hiddenModels)) {
    if (raw.hiddenModels.length > 256) throw invalid();
    for (const m of raw.hiddenModels) {
      if (!isCodexModelId(m) || hiddenModels.includes(m)) continue;
      hiddenModels.push(m);
    }
  }
  return {
    version: 1,
    kind: "codex-subscription",
    account: {
      accessToken: a.accessToken,
      refreshToken: a.refreshToken,
      idToken: a.idToken,
      accountId: a.accountId,
      email: a.email,
      plan: a.plan,
      connectedAt: a.connectedAt,
      accessExp: a.accessExp ?? null,
      lastError,
      cooldownUntil: cooldown(a.cooldownUntil),
      rateLimitCooldownUntil: cooldown(a.rateLimitCooldownUntil),
    },
    models,
    hiddenModels,
    rateLimits,
  };
}

export class CodexCredentialStore {
  constructor(readonly path: string) {}

  async load(): Promise<CodexCredentialData | null> {
    let file: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      file = await fs.open(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_CREDENTIAL_BYTES || (process.platform !== "win32" && stat.mode & 0o077)) {
        throw new Error("codex_credential_unreadable");
      }
      const text = await file.readFile("utf8");
      return normalizeCodexCredentialData(JSON.parse(text));
    } catch (error: any) {
      if (error?.code === "ENOENT") return null;
      throw codexAdminError("codex_credential_unreadable", 500);
    } finally {
      await file?.close();
    }
  }

  /** Atomic 0600 write: exclusive temp, fsync, rename, chmod. */
  async save(data: CodexCredentialData): Promise<void> {
    const safe = normalizeCodexCredentialData(data);
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
      throw codexAdminError("codex_config_write_failed", 500);
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
      throw codexAdminError("codex_config_write_failed", 500);
    }
  }
}

// ---------------------------------------------------------------------------
// Browser login state
// ---------------------------------------------------------------------------

interface PendingLogin {
  loginId: string;
  state: string;
  verifier: string;
  redirectUri: string;
  port: number | null;
  mode: "callback" | "paste";
  expiresAt: number;
  server: HttpServer | null;
  timer: NodeJS.Timeout | null;
  epoch: number;
  claimed: boolean;
  code: string | null;
  /** Rejects if the login is cancelled/expired before the code arrives. */
  waitForCode: Promise<string>;
  resolveCode: (code: string) => void;
  rejectCode: (error: Error) => void;
  result?: CodexLoginPoll;
  inFlight?: Promise<CodexLoginPoll>;
  lastPoll: number;
}

export interface CodexServiceLogger {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
}

export interface CodexAuthServiceOptions {
  configDir: string;
  host: PluginHostCapabilities;
  fetchImpl?: typeof fetch;
  now?: () => number;
  logger?: CodexServiceLogger;
  /** Test seam: credential path override. */
  store?: CodexCredentialStore;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class CodexAuthService {
  private readonly store: CodexCredentialStore;
  private mutationTail: Promise<unknown> = Promise.resolve();
  private epoch = 0;
  private pending: PendingLogin | null = null;
  private loginStarting = 0;
  /** Terminal poll results, kept briefly for late polls. */
  private readonly lastResult = new Map<string, CodexLoginPoll>();
  private data: CodexCredentialData | null = null;
  private loaded = false;
  private readonly instructions = new Map<string, string>();
  private refreshFlight: { key: string; promise: Promise<string> } | null = null;
  private forceRefreshRequested = false;
  private usageCache: { at: number; value: CodexUsage | null } | null = null;
  /** Reset-credit listing cache (same short-TTL shape as usage). */
  private resetCache: { at: number; value: CodexResetCredits | null } | null = null;
  /** Single-flight for reset consumption: a queued second consume could
   *  redeem a second credit — reject instead. Assigned SYNCHRONOUSLY before
   *  any await (no race window). Key = in-flight redeem id. */
  private resetFlight: { redeemRequest: string; promise: Promise<CodexResetConsumeResult> } | null = null;
  /** Pending confirmation state: the redeem key survives a transport failure
   *  so a user-initiated retry reuses the SAME idempotency key until a
   *  terminal outcome (upstream dedupes per key — a lost response therefore
   *  cannot double-spend). Cleared on terminal outcomes and disconnect. */
  private pendingReset: { redeemRequest: string; creditId?: string } | null = null;
  /** Locally marked spent credits: written only on a CONFIRMED terminal
   *  outcome; prevents re-consumption of a known-spent credit within this
   *  service lifetime. Upstream stays authoritative. */
  private readonly spentResetCredits = new Set<string>();

  constructor(private readonly options: CodexAuthServiceOptions) {
    this.store = options.store ?? new CodexCredentialStore(join(options.configDir, CODEX_CREDENTIAL_FILE));
  }

  private get now(): number { return (this.options.now ?? Date.now)(); }
  private get log(): Required<CodexServiceLogger> {
    const l = this.options.logger;
    return {
      info: (m) => { try { l?.info?.(m); } catch { /* a broken logger must never break the service */ } },
      warn: (m) => { try { l?.warn?.(m); } catch { /* a broken logger must never break the service */ } },
      error: (m) => { try { l?.error?.(m); } catch { /* a broken logger must never break the service */ } },
    };
  }

  private get fetchImpl(): CodexFetch {
    const injected = this.options.fetchImpl as CodexFetch | undefined;
    return injected ?? ((url, init) => fetch(url, init) as Promise<Response>);
  }

  /** Fixed OpenAI origins bypass configured CCR/proxy routing. */
  private directFetch(url: string, init: CodexFetchInit = {}): Promise<Response> {
    return this.fetchImpl(url, { ...init, dispatcher: this.options.host.getDirectDispatcher() });
  }

  private enqueueMutation<T>(action: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(action);
    this.mutationTail = result.catch(() => {});
    return result;
  }

  // ---------------------------------------------------------------- loading --

  private async ensureLoaded(force = false): Promise<CodexCredentialData | null> {
    if (this.loaded && !force) return this.data;
    const data = await this.store.load().catch((): CodexCredentialData | null => null);
    this.applyLoaded(data);
    this.loaded = true;
    return this.data;
  }

  private applyLoaded(data: CodexCredentialData | null): void {
    this.data = data;
    this.instructions.clear();
    for (const m of data?.models ?? []) {
      if (m.instructions) this.instructions.set(m.slug, m.instructions);
    }
  }

  private async saveData(data: CodexCredentialData): Promise<void> {
    await this.store.save(data);
    this.data = data;
    this.instructions.clear();
    for (const m of data.models) if (m.instructions) this.instructions.set(m.slug, m.instructions);
  }

  // ------------------------------------------------------------------ status -

  async getStatus(): Promise<CodexStatus> {
    const data = await this.ensureLoaded();
    // Read-time hidden filter (workbuddy auth-service parity): even if a stale
    // config still registers a hidden model, it must not surface as visible.
    const hidden = new Set(data?.hiddenModels ?? []);
    const models = (await this.configManagedModels()).filter((m) => !hidden.has(m));
    const account = data?.account;
    const now = this.now;
    if (!account) {
      return { status: "not_connected", providerName: CODEX_PROVIDER_NAME, models, modelCount: models.length, hiddenModels: [] };
    }
    const coolingUntil = this.latestCooldown(data);
    let status: CodexStatus["status"] = "connected";
    if (account.lastError) status = "error";
    else if (typeof account.accessExp === "number" && account.accessExp <= now) status = "expired";
    return {
      status,
      providerName: CODEX_PROVIDER_NAME,
      ...(account.accountId ? { accountId: account.accountId } : {}),
      ...(account.email ? { email: account.email } : {}),
      ...(account.plan ? { plan: account.plan } : {}),
      models,
      modelCount: models.length,
      hiddenModels: [...(data?.hiddenModels ?? [])],
      ...(coolingUntil ? { coolingUntil } : {}),
      lastError: account.lastError ? CODEX_SAFE_MESSAGES[account.lastError.code] ?? null : null,
    };
  }

  private latestCooldown(data: CodexCredentialData | null): number | undefined {
    const now = this.now;
    const a = data?.account;
    const candidates = [a?.cooldownUntil, a?.rateLimitCooldownUntil].filter((v): v is number => typeof v === "number" && v > now);
    return candidates.length ? Math.max(...candidates) : undefined;
  }

  // ------------------------------------------------------------- raw config --

  private async readRawConfig(): Promise<any> {
    try {
      if (this.options.host.readRawConfig) return await this.options.host.readRawConfig();
      return await this.options.host.readConfig();
    } catch {
      return {};
    }
  }

  private findManaged(config: any): any | undefined {
    for (const key of PROVIDER_KEYS) {
      const list = config?.[key];
      if (Array.isArray(list)) {
        const found = list.find((p: any) => isCodexManagedConfigProvider(p));
        if (found) return found;
      }
    }
    return undefined;
  }

  private async configManagedModels(): Promise<string[]> {
    try {
      const config = await this.readRawConfig();
      const provider = this.findManaged(config);
      return Array.isArray(provider?.models) ? provider.models.filter((m: any) => typeof m === "string") : [];
    } catch {
      return [];
    }
  }

  /**
   * Raw read → upsert the managed entry (plus explicit hide cleanup) → write →
   * reload. `protectCodexConfig` is defence in depth; unrelated providers are
   * never rewritten. With `create: false` (hide/restore path) a missing
   * managed entry is left alone — hiding a model must never resurrect a
   * provider the user removed; the store-only change still stands (workbuddy
   * parity: `if (providerIndex >= 0)`).
   */
  private async upsertManagedProvider(models: string[], opts: { create?: boolean; hidden?: ReadonlySet<string> } = {}): Promise<boolean> {
    const config = await this.options.host.readRawConfig?.().catch(() => null) ??
      await this.options.host.readConfig().catch(() => ({}));
    const previousConfig = structuredClone(config ?? {});
    let list: any[] = [];
    let usedKey: (typeof PROVIDER_KEYS)[number] = "Providers";
    let found = false;
    for (const key of PROVIDER_KEYS) {
      if (Array.isArray(config?.[key])) { usedKey = key; list = config[key]; found = true; break; }
    }
    if (!found) {
      if (opts.create === false) return false;
      if (!config || typeof config !== "object") throw codexAdminError("codex_config_write_failed", 500);
      config[usedKey] = list = [];
    }
    const index = list.findIndex((p: any) => isCodexManagedConfigProvider(p));
    if (index >= 0) {
      const existing = list[index];
      const enabled = existing.enabled !== false;
      list[index] = lockCodexProvider({ ...existing, models, enabled });
    } else {
      if (opts.create === false) return false;
      list.push(lockCodexProvider({ name: CODEX_PROVIDER_NAME, models, enabled: true }));
    }
    config[usedKey] = list;
    if (opts.hidden && "Router" in config) {
      config.Router = clearCodexRouterRefs(config.Router, opts.hidden, models[0] ?? null);
    }
    const expectedRouter = JSON.stringify(config.Router ?? null);
    try {
      protectCodexConfig(config, config);
      await this.options.host.writeConfig(config);
      if (JSON.stringify(config.Router ?? null) !== expectedRouter) {
        throw codexAdminError("codex_config_write_failed", 500);
      }
      await this.options.host.reloadRuntime?.(config);
    } catch {
      try {
        await this.options.host.writeConfig(previousConfig);
      } catch {
        this.log.error("[codex] configuration rollback write failed / 配置回滚写入失败");
      }
      try {
        await this.options.host.reloadRuntime?.(previousConfig);
      } catch {
        this.log.error("[codex] configuration rollback reload failed / 配置回滚重载失败");
      }
      throw codexAdminError("codex_config_write_failed", 500);
    }
    return true;
  }

  // ------------------------------------------------------- hide / restore ---

  /**
   * Persist the blacklist and remove hidden models from registration. Clear
   * matching Router refs and migrate default to the first visible model (or
   * empty when none remain), matching WorkBuddy. Roll back config/runtime
   * before credentials on failure. Repeated hides are idempotent.
   */
  async hideModel(model: string): Promise<CodexModelHideResult> {
    if (!isCodexModelId(model)) throw codexAdminError("codex_model_invalid", 422);
    return this.enqueueMutation(async () => {
      const data = await this.store.load().catch((): CodexCredentialData | null => null);
      if (!data?.account) throw codexAdminError("codex_not_connected", 409);
      const hidden = new Set<string>([...data.hiddenModels, model]);
      const visible = await this.computeVisibleModels(data.models.map((m) => m.slug), hidden);
      try {
        await this.saveData({ ...data, hiddenModels: [...hidden] });
        await this.upsertManagedProvider(visible, { create: false, hidden });
      } catch (error: any) {
        // Config write failed (upsertManagedProvider already restored the
        // previous config): roll the credential back so the store never shows
        // a hidden state whose provider-side effect did not land.
        await this.saveData(data).catch(() => this.log.error("[codex] hide credential rollback failed / 隐藏凭据回滚失败"));
        if (error?.code === "codex_config_write_failed") throw error;
        throw codexAdminError("codex_config_write_failed", 500);
      }
      return { success: true, model, models: visible, hiddenModels: [...hidden] };
    });
  }

  /**
   * Workbuddy-style restore: `model` omitted = restore ALL hidden models.
   * Updates the blacklist + registered provider models ONLY — never Router.
   * An unknown name is a successful no-op (idempotent), never an error.
   */
  async restoreModels(model?: string): Promise<CodexModelRestoreResult> {
    if (model !== undefined && !isCodexModelId(model)) throw codexAdminError("codex_model_invalid", 422);
    return this.enqueueMutation(async () => {
      const data = await this.store.load().catch((): CodexCredentialData | null => null);
      if (!data?.account) throw codexAdminError("codex_not_connected", 409);
      const hidden = new Set(data.hiddenModels);
      const restored: string[] = [];
      if (model === undefined) {
        restored.push(...hidden);
        hidden.clear();
      } else if (hidden.has(model)) {
        hidden.delete(model);
        restored.push(model);
      }
      const visible = await this.computeVisibleModels(data.models.map((m) => m.slug), hidden);
      try {
        await this.saveData({ ...data, hiddenModels: [...hidden] });
        await this.upsertManagedProvider(visible, { create: false });
      } catch (error: any) {
        await this.saveData(data).catch(() => this.log.error("[codex] restore credential rollback failed / 恢复凭据回滚失败"));
        if (error?.code === "codex_config_write_failed") throw error;
        throw codexAdminError("codex_config_write_failed", 500);
      }
      return { success: true, restored, models: visible, hiddenModels: [...hidden] };
    });
  }

  /**
   * Union of the stored credential models and whatever the managed provider
   * currently registers, minus the hidden set. The union is what makes a
   * restored model reappear even when the provider list was hand-edited.
   */
  private async computeVisibleModels(storedSlugs: string[], hidden: ReadonlySet<string>): Promise<string[]> {
    const config = await this.readRawConfig();
    const provider = this.findManaged(config);
    const registered: string[] = Array.isArray(provider?.models)
      ? provider.models.filter((m: any) => typeof m === "string") : [];
    const union = new Set<string>([...storedSlugs, ...registered]);
    return [...union].filter((m) => !hidden.has(m));
  }

  // ---------------------------------------------------------- browser login --

  async startLogin(): Promise<CodexLoginStart> {
    this.prunePending();
    if (this.pending || this.loginStarting > 0) {
      throw codexAdminError("codex_login_busy", 429);
    }
    this.loginStarting++;
    try {
      const start = await this.createPendingLogin();
      this.forgetResult(start.loginId);
      return start;
    } finally {
      this.loginStarting--;
    }
  }

  private async createPendingLogin(): Promise<CodexLoginStart> {
    const { verifier, challenge } = createCodexPkce();
    const state = randomToken(24);
    const loginId = randomBytes(16).toString("hex");
    const ttl = CODEX_LOGIN_TTL_MS;

    // Try the registered ports in official order. NEVER probe /cancel on a
    // listener another application owns: bind failure just moves us along.
    let server: HttpServer | null = null;
    let port: number | null = null;
    for (const candidate of CODEX_CALLBACK_PORTS) {
      const attempt = createServer();
      try {
        await new Promise<void>((resolve, reject) => {
          attempt.once("error", reject);
          attempt.listen(candidate, "127.0.0.1", resolve);
        });
        server = attempt;
        port = candidate;
        break;
      } catch (error: any) {
        await new Promise((r) => attempt.close(r));
        if (error?.code !== "EADDRINUSE") {
          // Unexpected bind error: do not pretend paste mode would help, but
          // paste still works without a socket — fall through with a warning.
          this.log.warn(`[codex] callback bind on port ${candidate} failed: ${error?.code ?? "error"}`);
        }
      }
    }

    // Paste fallback keeps the registered default redirect URI so the IdP
    // redirects to the allow-listed address; the user copies that final URL.
    const redirectPort = port ?? CODEX_CALLBACK_PORTS[0];
    const redirectUri = `http://127.0.0.1:${redirectPort}${CODEX_CALLBACK_PATH}`;
    const mode: "callback" | "paste" = server ? "callback" : "paste";
    const url = buildCodexAuthorizeUrl({ redirectUri, state, codeChallenge: challenge });
    const expiresAt = this.now + ttl;

    let resolveCode!: (code: string) => void;
    let rejectCode!: (error: Error) => void;
    const waitForCode = new Promise<string>((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });
    waitForCode.catch(() => {}); // never an unhandled rejection

    const job: PendingLogin = {
      loginId, state, verifier, redirectUri, port, mode, expiresAt,
      server, timer: null, epoch: this.epoch, claimed: false, code: null,
      waitForCode, resolveCode, rejectCode, lastPoll: 0,
    };
    job.timer = setTimeout(() => {
      this.terminalize(job, { status: "expired" });
      job.rejectCode(codexAdminError("codex_login_expired", 410));
    }, ttl);
    if (typeof job.timer.unref === "function") job.timer.unref();

    if (server) {
      server.on("request", (req, res) => {
        try { this.handleCallback(req, res, job); }
        catch { try { res.statusCode = 500; res.end(); } catch { /* best-effort error response; the socket may already be gone */ } }
      });
    }

    this.pending = job;
    return { loginId, url, expiresAt, mode, redirectUri };
  }

  /** Loopback request handler: GET, exact path, Host guard, one-use state. */
  private handleCallback(req: IncomingMessage, res: ServerResponse, job: PendingLogin): void {
    const page = (ok: boolean, heading: string, body: string, status = ok ? 200 : 400) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.end(`<!doctype html><meta charset="utf-8"><title>${heading}</title>` +
        `<body style="font-family:system-ui;padding:2rem"><h2>${heading}</h2><p>${body}</p></body>`);
    };
    if (req.method !== "GET") { res.statusCode = 405; res.end(); return; }
    let target: URL;
    try {
      target = new URL(req.url ?? "/", "http://127.0.0.1");
    } catch {
      res.statusCode = 400; res.end(); return;
    }
    if (target.pathname === "/favicon.ico") { res.statusCode = 204; res.end(); return; }
    if (target.pathname !== CODEX_CALLBACK_PATH) { res.statusCode = 404; res.end(); return; }

    const host = String(req.headers?.host ?? "");
    const allowedHosts = new Set([`127.0.0.1:${job.port}`, `localhost:${job.port}`, `[::1]:${job.port}`]);
    if (!allowedHosts.has(host)) {
      page(false, "Sign-in rejected", "This request did not come from the local sign-in page.");
      return;
    }
    const accept = (code: string) => {
      page(true, "Sign-in received", "You can close this page and return to CCR.");
      this.claimCallback(job, code);
    };
    this.consumeCallbackParams(job, target, {
      onCode: accept,
      onProviderError: () => {
        page(false, "Sign-in declined", "ChatGPT declined the authorization. Start it again from CCR.");
        this.terminalize(job, { status: "error", error: "codex_login_exchange_failed" });
        job.rejectCode(codexAdminError("codex_login_exchange_failed", 409));
      },
      onReject: () => {
        page(false, "This link isn't from CCR's sign-in", "Start it again from CCR.");
      },
    });
  }

  /**
   * Validate and one-time-consume callback query parameters. Shared by the
   * socket listener and paste mode (`submitCallback`); never logs the URL.
   */
  private consumeCallbackParams(
    job: PendingLogin,
    target: URL,
    hooks: { onCode: (code: string) => void; onProviderError: () => void; onReject: () => void }
  ): void {
    if (this.pending !== job || job.claimed || this.now >= job.expiresAt) {
      hooks.onReject();
      return;
    }
    const state = target.searchParams.get("state");
    if (typeof state !== "string" || !safeEqualState(state, job.state)) {
      hooks.onReject();
      return;
    }
    if (target.searchParams.get("error")) {
      hooks.onProviderError();
      return;
    }
    const code = target.searchParams.get("code");
    if (!code || code.length > 2048 || /[\x00-\x1f\x7f]/.test(code)) {
      hooks.onReject();
      return;
    }
    job.claimed = true; // one use: replays hit the guard above
    hooks.onCode(code);
  }

  /** Stop listening (one callback only); keep job until exchange finishes. */
  private claimCallback(job: PendingLogin, code: string): void {
    if (job.timer) { clearTimeout(job.timer); job.timer = null; }
    job.code = code;
    job.server?.close(() => {});
    job.resolveCode(code);
  }

  private terminalize(job: PendingLogin, result: CodexLoginPoll): void {
    job.result = result;
    // Remember the terminal outcome for a short while: polls that arrive just
    // after the login finished must still see it, not "state rejected".
    this.lastResult.set(job.loginId, result);
    if (job.timer) { clearTimeout(job.timer); job.timer = null; }
    job.server?.close(() => {});
    if (this.pending === job) this.pending = null;
  }

  /** Clear a stale terminal-result memo (called when a new login starts). */
  private forgetResult(loginId: string): void {
    this.lastResult.delete(loginId);
  }

  async cancelLogin(loginId: string): Promise<void> {
    const job = this.pending;
    if (job && (loginId === "*" || job.loginId === loginId)) {
      this.terminalize(job, { status: "cancelled" });
      job.rejectCode(codexAdminError("codex_login_cancelled", 409));
    }
  }

  /** Paste-mode completion: the user hands us the final browser URL. */
  async submitCallback(loginId: string, callbackUrl: string): Promise<CodexLoginPoll> {
    const job = this.pending;
    if (!job || job.loginId !== loginId) {
      return { status: "error", error: "codex_login_state_rejected" };
    }
    let target: URL;
    try {
      target = new URL(callbackUrl);
    } catch {
      return { status: "error", error: "codex_login_state_rejected" };
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      return { status: "error", error: "codex_login_state_rejected" };
    }
    if (target.pathname !== CODEX_CALLBACK_PATH) {
      return { status: "error", error: "codex_login_state_rejected" };
    }
    // The pasted URL must target the exact allow-listed redirect authority
    // we handed the IdP (bound port, or 1455 in paste mode). The host must be
    // loopback too: the redirect authority is always 127.0.0.1, so accepting a
    // foreign hostname would mean trusting a URL that could never have come
    // from the IdP's redirect (a mistyped or phished paste).
    const host = target.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (!CODEX_LOOPBACK_HOSTS.includes(host)) {
      return { status: "error", error: "codex_login_state_rejected" };
    }
    const expectedPort = new URL(job.redirectUri).port;
    if (target.port !== expectedPort) {
      return { status: "error", error: "codex_login_state_rejected" };
    }
    let outcome: CodexLoginPoll | undefined;
    this.consumeCallbackParams(job, target, {
      onCode: (code) => {
        this.claimCallback(job, code);
        outcome = { status: "pending" };
      },
      onProviderError: () => {
        this.terminalize(job, { status: "error", error: "codex_login_exchange_failed" });
        job.rejectCode(codexAdminError("codex_login_exchange_failed", 409));
        outcome = job.result;
      },
      onReject: () => {
        outcome = { status: "error", error: "codex_login_state_rejected" };
      },
    });
    if (!outcome) return { status: "error", error: "codex_login_state_rejected" };
    if (outcome.status === "pending") return this.pollLogin(loginId);
    return outcome;
  }

  async pollLogin(loginId: string): Promise<CodexLoginPoll> {
    if (typeof loginId !== "string" || !/^[a-f0-9]{32}$/.test(loginId)) {
      return { status: "error", error: "codex_login_state_rejected" };
    }
    const job = this.pending;
    if (!job || job.loginId !== loginId) {
      // A login that already reached a terminal state keeps reporting it, so
      // a UI polling slightly late still learns the outcome.
      const finished = this.lastResult.get(loginId);
      if (finished) return finished;
      return { status: "error", error: "codex_login_state_rejected" };
    }
    if (job.result) return job.result;
    if (this.now >= job.expiresAt) {
      this.terminalize(job, { status: "expired" });
      job.rejectCode(codexAdminError("codex_login_expired", 410));
      return job.result!;
    }
    // Exactly one exchange: never launch a duplicate from a concurrent poll.
    if (job.inFlight) return job.inFlight;
    if (!job.claimed) return { status: "pending" };
    if (this.now - job.lastPoll < 250) return { status: "pending" };
    job.lastPoll = this.now;
    job.inFlight = this.runLogin(job).finally(() => { job.inFlight = undefined; });
    return job.inFlight;
  }

  private prunePending(): void {
    const job = this.pending;
    if (job && !job.result && this.now >= job.expiresAt) {
      this.terminalize(job, { status: "expired" });
      job.rejectCode(codexAdminError("codex_login_expired", 410));
    }
  }

  /** Code → tokens → claims → models (best effort) → persist → config. */
  private async runLogin(job: PendingLogin): Promise<CodexLoginPoll> {
    const fail = (error: CodexAdminCode): CodexLoginPoll => {
      this.terminalize(job, { status: "error", error });
      return job.result!;
    };
    let code: string;
    try {
      code = await job.waitForCode;
    } catch {
      return job.result ?? { status: "expired" };
    }
    const epoch = job.epoch;

    let tokens: CodexTokens;
    try {
      tokens = await exchangeCodexCode({
        code,
        codeVerifier: job.verifier,
        redirectUri: job.redirectUri,
        fetchImpl: (url, init) => this.directFetch(url, init),
      });
    } catch (error: any) {
      // Diagnostics: status-only for HTTP responses; for transport failures
      // (status=none) the node error message (DNS/connect/TLS) — neither ever
      // contains credentials, bodies or headers.
      const detail = error?.statusCode !== undefined
        ? `status=${error.statusCode} ${String(error?.message ?? "").slice(0, 120)}`
        : `transport=${error?.cause?.code ?? error?.code ?? "?"} ${String(error?.message ?? "").slice(0, 120)}`;
      this.log.warn(`[codex] token exchange failed: ${error?.code === "codex_reauth_required" ? "rejected" : "upstream"} (${detail})`);
      return fail("codex_login_exchange_failed");
    }
    // Cancelled/disconnected, or already terminal (e.g. TTL expired while the
    // exchange was in flight): never persist over a newer identity.
    if (this.epoch !== epoch || (job.result && job.result.status !== "connected")) {
      return fail("codex_login_cancelled");
    }

    const claims = readCodexIdClaims(tokens.idToken, tokens.accessToken);
    const accessExp = accessTokenExpiryMs(tokens.accessToken) ?? null;

    // Model discovery never blocks login; no static fallback table exists.
    let models: CodexModelInfo[] = [];
    try {
      models = await fetchCodexModels({
        accessToken: tokens.accessToken,
        accountId: claims.accountId || undefined,
        fetchImpl: (url, init) => this.directFetch(url, init),
      });
    } catch (error: any) {
      const cause = error?.cause?.code ?? error?.cause?.message ?? "";
      this.log.warn(`[codex] model discovery after login failed: ${error?.code ?? error?.name ?? "upstream"} ${cause} ${String(error?.message ?? "").slice(0, 120)}`);
    }

    let registered: string[] = [];
    try {
      await this.enqueueMutation(async () => {
        if (this.epoch !== epoch) throw codexAdminError("codex_login_cancelled", 409);
        const previous = await this.store.load().catch((): CodexCredentialData | null => null);
        // A re-login keeps the previous blacklist: hidden models stay hidden
        // across re-authorization (workbuddy parity), while the stored model list
        // is rebuilt from the fresh discovery so restores keep working.
        const hidden = new Set(previous?.hiddenModels ?? []);
        const data: CodexCredentialData = {
          version: 1,
          kind: "codex-subscription",
          account: {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            idToken: tokens.idToken,
            accountId: claims.accountId,
            email: claims.email,
            plan: claims.plan,
            connectedAt: new Date(this.now).toISOString(),
            accessExp,
            lastError: null,
            cooldownUntil: null,
            rateLimitCooldownUntil: null,
          },
          models: models.map((m) => ({
            slug: m.slug,
            displayName: m.displayName,
            ...(m.instructions ? { instructions: m.instructions } : {}),
          })),
          hiddenModels: [...hidden],
          rateLimits: null,
        };
        const slugs = models.map((m) => m.slug);
        registered = slugs.filter((s) => !hidden.has(s));
        await this.saveData(data);
        if (this.epoch !== epoch) throw codexAdminError("codex_login_cancelled", 409);
        try {
          await this.upsertManagedProvider(registered);
        } catch (error) {
          // Half-connected account is impossible: roll the credential back.
          if (previous) await this.store.save(previous).catch(() => this.log.error("[codex] login credential rollback failed / 登录凭据回滚失败"));
          else await this.store.delete().catch(() => this.log.error("[codex] login credential rollback failed / 登录凭据回滚失败"));
          this.loaded = false;
          throw error;
        }
      });
    } catch (error: any) {
      if (error?.code === "codex_login_cancelled") return fail("codex_login_cancelled");
      this.log.error("[codex] login persist failed; credential rolled back");
      return fail("codex_login_persist_failed");
    }

    this.refreshFlight = null;
    this.forceRefreshRequested = false;
    this.usageCache = null;
    this.resetCache = null;          // account identity changed — never reuse
    this.spentResetCredits.clear();  // the previous account's reset state
    this.pendingReset = null;
    const result: CodexLoginPoll = { status: "connected", models: registered, modelCount: registered.length };
    job.result = result;
    this.lastResult.set(job.loginId, result);
    if (this.pending === job) this.pending = null;
    if (job.timer) { clearTimeout(job.timer); job.timer = null; }
    job.server?.close(() => {});
    return result;
  }

  // ------------------------------------------------------- data-plane tokens -

  /** Live access token; refreshes with a 5-minute lead, single-flight. */
  async getAccessToken(): Promise<string> {
    const data = await this.ensureLoaded();
    const account = data?.account;
    if (!account) throw codexAdminError("codex_not_connected", 409);

    // Fresh while the JWT has more than the 5-minute lead left; a missing exp
    // is treated as expired (same convention as the official client).
    const fresh = typeof account.accessExp === "number" &&
      account.accessExp - this.now > CODEX_REFRESH_LEAD_MS;
    if (fresh && !this.forceRefreshRequested) return account.accessToken;

    const key = `${account.refreshToken}|${account.connectedAt}`;
    if (this.refreshFlight?.key === key) return this.refreshFlight.promise;
    const epoch = this.epoch;
    // The flight is intentionally NOT tied to the caller: once the refresh
    // has been sent it always runs to persistence (rotation means the old
    // refresh token is already spent), even if every caller went away.
    const promise = this.performRefresh(account.refreshToken, epoch)
      .then((token) => {
        if (this.epoch !== epoch) throw codexAdminError("codex_not_connected", 409);
        return token;
      })
      .catch((error) => {
        if (this.refreshFlight?.key === key) this.refreshFlight = null;
        throw error;
      });
    this.refreshFlight = { key, promise };
    try {
      return await promise;
    } finally {
      if (this.refreshFlight?.key === key && this.refreshFlight.promise === promise) {
        this.refreshFlight = null;
      }
    }
  }

  /**
   * Refresh grant → persist rotated tokens BEFORE the new access token can be
   * used. Id-token account/plan claims are refreshed as well.
   */
  private performRefresh(oldRefreshToken: string, epoch: number): Promise<string> {
    return (async () => {
      let tokens: CodexTokens;
      try {
        tokens = await refreshCodexTokens({
          refreshToken: oldRefreshToken,
          fetchImpl: (url, init) => this.directFetch(url, init),
        });
      } catch (error) {
        // Caller cancellation must not reach here: there is no caller signal
        // wired into the fetch. A rejected refresh (400/401) is reauth.
        throw error;
      }
      const claims = readCodexIdClaims(tokens.idToken, tokens.accessToken);
      const accessExp = accessTokenExpiryMs(tokens.accessToken) ?? null;
      await this.enqueueMutation(async () => {
        const current = await this.store.load().catch((): CodexCredentialData | null => null);
        if (!current || this.epoch !== epoch || current.account.refreshToken !== oldRefreshToken) {
          throw codexAdminError("codex_not_connected", 409);
        }
        const next: CodexCredentialData = {
          ...current,
          account: {
            ...current.account,
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            idToken: tokens.idToken,
            accessExp,
            ...(claims.accountId ? { accountId: claims.accountId } : {}),
            ...(claims.plan ? { plan: claims.plan } : {}),
            ...(claims.email ? { email: claims.email } : {}),
          },
        };
        // Persist completes before the in-memory identity switches.
        await this.saveData(next);
      });
      this.forceRefreshRequested = false;
      return tokens.accessToken;
    })();
  }

  /** The 401 seam's one forced re-send: bypass the exp lead once. */
  async forceTokenRefresh(): Promise<void> {
    this.forceRefreshRequested = true;
    await this.getAccessToken();
  }

  async getAccountId(): Promise<string> {
    const data = await this.ensureLoaded();
    if (!data?.account) throw codexAdminError("codex_not_connected", 409);
    if (!data.account.accountId) throw codexAdminError("codex_not_connected", 409);
    return data.account.accountId;
  }

  // ------------------------------------------------------------------ models -

  async syncModels(): Promise<{ success: true; models: string[]; modelCount: number }> {
    const data = await this.ensureLoaded();
    if (!data?.account) throw codexAdminError("codex_not_connected", 409);
    const accessToken = await this.getAccessToken();
    const fresh = await this.ensureLoaded(true);
    const accountId = fresh?.account.accountId || undefined;
    let models: CodexModelInfo[];
    try {
      models = await fetchCodexModels({
        accessToken,
        accountId,
        fetchImpl: (url, init) => this.directFetch(url, init),
      });
    } catch (error: any) {
      if (error?.code === "codex_reauth_required") throw codexAdminError("codex_reauth_required", 401);
      throw codexAdminError("codex_models_fetch_failed", 502);
    }
    const visible = selectCodexModels(models);
    const slugs = visible.map((m) => m.slug);
    if (!slugs.length) throw codexAdminError("codex_models_fetch_failed", 502);
    let registered: string[] = slugs;
    await this.enqueueMutation(async () => {
      const current = await this.store.load().catch((): CodexCredentialData | null => null);
      if (!current) throw codexAdminError("codex_not_connected", 409);
      // The blacklist survives sync and is applied BEFORE registration:
      // sync never resurrects hidden models and never rewrites Router.
      const hidden = new Set(current.hiddenModels);
      registered = slugs.filter((s) => !hidden.has(s));
      await this.saveData({
        ...current,
        account: { ...current.account, lastError: null },
        models: visible.map((m) => ({
          slug: m.slug,
          displayName: m.displayName,
          ...(m.instructions ? { instructions: m.instructions } : {}),
        })),
      });
      await this.upsertManagedProvider(registered);
    });
    return { success: true, models: registered, modelCount: registered.length };
  }

  /** Stable synchronous getter over the in-memory per-model instruction cache. */
  getModelInstructions(model: string): string | undefined {
    return this.instructions.get(model);
  }

  // ------------------------------------------------------------------- usage -

  async getUsage(): Promise<CodexUsage | null> {
    const data = await this.ensureLoaded();
    if (!data?.account) return null;
    if (this.usageCache && this.now - this.usageCache.at < USAGE_CACHE_MS) {
      return this.usageCache.value;
    }
    const accessToken = await this.getAccessToken().catch(() => null);
    if (!accessToken) return null;
    const fresh = await this.ensureLoaded(true);
    const usage = await fetchCodexUsage({
      accessToken,
      accountId: fresh?.account.accountId || undefined,
      fetchImpl: (url, init) => this.directFetch(url, init),
    }).catch(() => null);
    this.usageCache = { at: this.now, value: usage };
    return usage;
  }

  // ------------------------------------------------------ reset credits -

  /**
   * Available gifted usage resets. Null = surface absent/unreadable or the
   * caller is not connected. Short-TTL cached like usage; locally marked
   * spent credits are excluded from the visible availability.
   */
  async getResetCredits(): Promise<CodexResetCredits | null> {
    const data = await this.ensureLoaded();
    if (!data?.account) return null;
    if (this.resetCache && this.now - this.resetCache.at < USAGE_CACHE_MS) {
      return this.resetCache.value;
    }
    const accessToken = await this.getAccessToken().catch(() => null);
    if (!accessToken) return null;
    const fresh = await this.ensureLoaded(true);
    const listing = await fetchCodexResetCredits({
      accessToken,
      accountId: fresh?.account.accountId || undefined,
      fetchImpl: (url, init) => this.directFetch(url, init),
    }).catch(() => null);
    const value = listing && listing.credits.length
      ? { ...listing, credits: listing.credits.filter((c) => !this.spentResetCredits.has(c.id)) }
      : listing;
    this.resetCache = { at: this.now, value };
    return value;
  }

  /**
   * Consume ONE gifted reset credit. Explicit user action only — never called
   * by mount/poll/refresh. Single-flight: a second concurrent consume is
   * rejected (two queued consumes could redeem two credits). The idempotency
   * key is minted here at confirmation time and retained across user-initiated
   * retries of the same confirmation (upstream dedupes on it), so a lost
   * response cannot double-spend. Outcomes map to the upstream taxonomy;
   * `reset`/`already_redeemed` clear the usage cache and locally mark the
   * credit spent, then the caller re-lists for the authoritative count.
   */
  async consumeResetCredit(creditId?: string): Promise<CodexResetConsumeResult & { availableCount?: number }> {
    // Synchronous busy latch: assigned BEFORE the first await so two
    // concurrent route calls can never both pass this check.
    if (this.resetFlight) throw codexAdminError("codex_reset_busy", 429);
    // A retried confirmation of the SAME credit reuses the pending redeem key
    // (idempotent upstream); a different/absent credit mints a fresh one.
    const redeemRequest = this.pendingReset && this.pendingReset.creditId === creditId
      ? this.pendingReset.redeemRequest
      : randomUUID();
    const promise = (async (): Promise<CodexResetConsumeResult> => {
      try {
        const data = await this.ensureLoaded();
        if (!data?.account) throw codexAdminError("codex_not_connected", 409);
        if (creditId && this.spentResetCredits.has(creditId)) {
          throw codexAdminError("codex_reset_no_credit", 409);
        }
        const accessToken = await this.getAccessToken();
        const fresh = await this.ensureLoaded(true);
        const accountId = fresh?.account.accountId || undefined;
        return await consumeCodexResetCredit({
          redeemRequest,
          ...(creditId ? { creditId } : {}),
          accessToken,
          accountId,
          fetchImpl: (url, init) => this.directFetch(url, init),
        });
      } catch (error: any) {
        if (error?.code === "codex_reauth_required") throw codexAdminError("codex_reauth_required", 422);
        if (error?.code === "codex_upstream_error") throw codexAdminError("codex_reset_unavailable", 502);
        throw error;
      }
    })();
    this.pendingReset = { redeemRequest, ...(creditId ? { creditId } : {}) };
    this.resetFlight = { redeemRequest, promise };
    try {
      const result = await this.resetFlight.promise;
      // Terminal outcome: the confirmation is settled — the pending key is
      // consumed, spent credits are marked (best-effort identity — when no
      // creditId was sent the backend picked one, so only the count can be
      // invalidated), and the authoritative listing is refreshed.
      if (result.outcome === "reset" || result.outcome === "already_redeemed") {
        if (creditId) this.spentResetCredits.add(creditId);
        this.usageCache = null;
        this.resetCache = null;
      } else if (result.outcome === "no_credit") {
        this.resetCache = { at: this.now, value: { credits: [], availableCount: 0 } };
      }
      this.pendingReset = null;
      let availableCount: number | undefined;
      if (result.outcome === "reset" || result.outcome === "already_redeemed") {
        const listing = await this.getResetCredits().catch(() => null);
        availableCount = listing?.availableCount;
      }
      return { ...result, ...(availableCount !== undefined ? { availableCount } : {}) };
    } finally {
      if (this.resetFlight?.redeemRequest === redeemRequest) this.resetFlight = null;
    }
  }

  // -------------------------------------------------------------- cooling/... -

  async isAccountCooling(): Promise<boolean> {
    const data = await this.ensureLoaded();
    return this.latestCooldown(data) !== undefined;
  }

  /**
   * Data-plane success channel: clears non-sticky failure residue once the
   * upstream produced real output. Without this a single rejected request
   * (e.g. a 400 on an unsupported payload) latches status="error" on the card
   * until the next re-login — users experience that as "the login keeps
   * dropping" even though the token was never invalid. The sticky reauth
   * marker survives: one good request cannot prove the saved sign-in healthy
   * again, so only a fresh login clears it. rateLimitCooldownUntil is a
   * separate quota-window truth with its own expiry and is left alone.
   * Serialized on the mutation queue like every account write; silently
   * ignored when disconnected or on a write failure (bookkeeping never breaks
   * the response path).
   */
  noteRequestSuccess(): Promise<void> {
    return this.enqueueMutation(async () => {
      const current = await this.store.load().catch((): CodexCredentialData | null => null);
      if (!current) return; // disconnected meanwhile — nothing to clear
      if (!current.account.lastError && !current.account.cooldownUntil) return; // no residue latched
      if (current.account.lastError?.code === "codex_reauth_required") return; // only a re-login clears it
      await this.saveData({
        ...current,
        account: { ...current.account, lastError: null, cooldownUntil: null },
      });
    }).catch(() => {
      // Bookkeeping must never break the response path.
    });
  }

  /** Data-plane error channel (usage_limit_reached, 401, …). Never throws. */
  noteUpstreamError(info: PluginClassifiedError): Promise<void> {
    return this.enqueueMutation(async () => {
      const current = await this.store.load().catch((): CodexCredentialData | null => null);
      if (!current) return;
      if (!info || typeof info.code !== "string" || !LAST_ERROR_CODES.has(info.code)) return;
      const cooldownUntil = typeof info.cooldownMs === "number" && info.cooldownMs > 0
        ? this.now + info.cooldownMs
        : null;
      await this.saveData({
        ...current,
        account: {
          ...current.account,
          lastError: { code: info.code as CodexErrorCode },
          ...(cooldownUntil ? { cooldownUntil } : {}),
        },
      });
    }).catch(() => {});
  }

  /**
   * Rate-limit observation channel (headers/SSE, parsed by the data plane).
   * Storage + cooling determination only; separate from noteUpstreamError.
   * Never throws.
   */
  noteRateLimits(limits: CodexRateLimits): Promise<void> {
    return (async () => {
      const clean = normalizeRateLimits(limits);
      if (!clean) return;
      await this.enqueueMutation(async () => {
        const current = await this.store.load().catch((): CodexCredentialData | null => null);
        if (!current) return;
        const now = this.now;
        const reset = Math.max(clean.primary?.resetAt ?? 0, clean.secondary?.resetAt ?? 0);
        const saturated = rateLimitsSaturated(clean, now);
        await this.saveData({
          ...current,
          rateLimits: clean,
          account: {
            ...current.account,
            // A saturated window parks the account until its reset; a fresh
            // benign observation clears a stale cooldown.
            rateLimitCooldownUntil: saturated && reset > now ? reset : null,
          },
        });
      });
    })().catch(() => {});
  }

  async getRateLimits(): Promise<CodexRateLimits | null> {
    const data = await this.ensureLoaded();
    return data?.rateLimits ?? null;
  }

  // -------------------------------------------------------------- disconnect -

  async disconnect(): Promise<{ success: true }> {
    const job = this.pending;
    this.epoch++;
    if (job) {
      this.terminalize(job, { status: "cancelled" });
      job.rejectCode(codexAdminError("codex_login_cancelled", 409));
    }
    return this.enqueueMutation(async () => {
      const config = await this.readRawConfig();
      const provider = this.findManaged(config);
      if (provider) {
        const previousConfig = structuredClone(config);
        let removed = false;
        for (const key of PROVIDER_KEYS) {
          if (!Array.isArray(config?.[key])) continue;
          const index = config[key].findIndex((p: any) => p === provider || isCodexManagedConfigProvider(p));
          if (index >= 0) {
            config[key].splice(index, 1);
            removed = true;
          }
        }
        if (removed) {
          // Router is deliberately untouched on disconnect.
          protectCodexConfig(config, config);
          try {
            await this.options.host.writeConfig(config);
            await this.options.host.reloadRuntime?.(config);
          } catch {
            try {
              await this.options.host.writeConfig(previousConfig);
              await this.options.host.reloadRuntime?.(previousConfig);
            } catch { /* best-effort rollback; the original failure is thrown below */ }
            throw codexAdminError("codex_config_write_failed", 500);
          }
        }
      }
      await this.store.delete().catch(() => {});
      this.applyLoaded(null);
      this.loaded = true;
      this.refreshFlight = null;
      this.forceRefreshRequested = false;
      this.usageCache = null;
      this.resetCache = null;
      this.spentResetCredits.clear();
      this.pendingReset = null;
      return { success: true as const };
    });
  }

  async dispose(): Promise<void> {
    const job = this.pending;
    if (job) {
      this.terminalize(job, { status: "cancelled" });
      job.rejectCode(codexAdminError("codex_login_cancelled", 409));
    }
    // An in-flight refresh is NOT aborted: rotation results must still land.
  }
}
