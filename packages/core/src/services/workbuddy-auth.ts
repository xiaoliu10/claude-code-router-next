/**
 * WorkBuddy (CN + international) managed-provider authorization service.
 *
 * Design contract: docs/design/workbuddy-provider-contract.md (§13 rulings win
 * over earlier sections). Key invariants implemented here:
 *  - Credentials live ONLY in a 0600 CCR-private file; they never enter
 *    config.json, /api/config, the browser, logs or error bodies.
 *  - GET status never reads the WorkBuddy desktop login source file. Only an
 *    explicit user-initiated import reads it once (read-only, fixed path).
 *  - Import validates the candidate credential AND discovers a non-empty model
 *    list BEFORE anything is persisted. A failure never overwrites the stored
 *    credential, provider or model list.
 *  - Import/sync/disconnect never touch config.Router (D6).
 *  - Sync preserves an existing `enabled: false` so a user-disabled provider is
 *    never silently re-enabled.
 *  - Browser sign-ins own their refresh credential (§15); desktop imports never
 *    copy/spend shared desktop refresh secrets (§14). No static models or plugins.
 */
import { createHash, randomBytes } from "node:crypto";
import { readConfigFileRaw, writeConfigFile } from "../ccr/config";
import { reconcileHealthStore } from "../ccr/health-reconcile";
import { ProviderService } from "./provider";
import { resolveProviderProxyUrl, getDirectDispatcher } from "./proxy";
import type { LLMProvider } from "../types/llm";
import {
  WORKBUDDY_AI_PROVIDER_NAME,
  WORKBUDDY_API_KEY,
  WORKBUDDY_CHAT_ORIGIN,
  WORKBUDDY_CHAT_URL,
  WORKBUDDY_CONFIG_UA,
  WORKBUDDY_PROVIDER_NAME,
  classifyWorkBuddyError,
  conversationHeaders,
  credentialHeaders,
  isManagedWorkBuddy,
  lockWorkBuddyProvider,
  managedProvider,
  parseWorkBuddyModels,
  protectWorkBuddyConfig,
  createWorkBuddyLoginState,
  fetchWorkBuddyLoginAccount,
  pollWorkBuddyLoginToken,
  readWorkBuddySource,
  refreshWorkBuddyToken,
  renewWorkBuddyFromDesktop,
  workBuddyChatUrl,
  workBuddyConfigUrl,
  workBuddyCredentialStore,
  workBuddyNeedsRenewal,
  workBuddySite,
  workBuddySiteFromProvider,
  type WorkBuddyAccount,
  type WorkBuddyCooldown,
  type WorkBuddyCredential,
  type WorkBuddyCredentialData,
  type WorkBuddyCredentialSource,
  type WorkBuddyModelCooldown,
  type WorkBuddySiteId,
  type WorkBuddySourceResult,
  type WorkBuddyStatus,
  type WorkBuddyCredentialStore,
} from "./workbuddy";

export type WorkBuddyFailureReason = "sealed" | "source_missing" | "source_invalid" | "models_fetch_failed";

export interface WorkBuddyStatusResult {
  status: WorkBuddyStatus;
  kind: WorkBuddySiteId;
  site: string;
  providerName: string;
  models: string[];
  modelCount: number;
  uid: string | null;
  displayName: string | null;
  domain: string | null;
  expiresAt: number | null;
  importedAt: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  source: WorkBuddyCredentialSource;
  /** desktop: bounded desktop-file re-read; browser: CCR-owned refresh token. */
  renewalMode: "desktop" | "browser";
  imagesUnsupportedModels: string[];
}

export interface WorkBuddyMutationResult {
  success: boolean;
  status: WorkBuddyStatus;
  models: string[];
  modelCount: number;
  displayName: string | null;
  message?: string | null;
  modelsUnchanged?: boolean;
  reason?: WorkBuddyFailureReason;
  error?: string;
}

/** Sanitized per-account line for the admin pool status (contract §16). Never carries tokens. */
export interface WorkBuddyAccountSummary {
  uid: string;
  displayName: string;
  source: WorkBuddyCredentialSource;
  active: boolean;
  /** Account-scoped cooldown (quota/restriction), epoch ms; absent when clear. */
  coolingUntil?: number;
  coolingCode?: number;
  /** Longest still-valid per-model cooldown, with the model that owns it. */
  modelCoolingUntil?: number;
  modelCoolingModel?: string;
  /** 11140-style restriction, surfaced separately for the UI badge. */
  restrictedUntil?: number;
  expiresAt: number;
  importedAt: string;
}
export interface WorkBuddySiteStatus {
  status: WorkBuddyStatus;
  site: WorkBuddySiteId;
  providerName: string;
  origin: string;
  accounts: WorkBuddyAccountSummary[];
  activeUid: string | null;
  models: string[];
  hiddenModels: string[];
  modelCount: number;
  lastSyncAt: string | null;
  lastError: string | null;
  renewalMode: "desktop" | "browser";
}
export interface WorkBuddyPoolStatus {
  sites: Partial<Record<WorkBuddySiteId, WorkBuddySiteStatus>>;
  connectedSites: WorkBuddySiteId[];
}
export interface WorkBuddyHideResult {
  success: boolean;
  /** Router FIELD PATHS that were rewritten (e.g. "default", "scenario:think", "models:alias"). */
  clearedRefs: string[];
  models: string[];
  /**
   * The actual `provider,model` references that disappeared from Router (usually
   * exactly one). clearedRefs tells the UI *where* it changed; this tells it
   * *which model ref* is gone, so it can reconcile its local Router draft.
   * Empty when nothing was routed through this provider/model.
   */
  removedModelRefs?: string[];
  /** `Router.default` as persisted after the hide ("" when it was cleared). */
  defaultFallback?: string | null;
  error?: string;
  message?: string | null;
}
export interface WorkBuddyRestoreResult {
  success: boolean;
  restored: string[];
  models: string[];
  error?: string;
  message?: string | null;
}
export interface WorkBuddyRemoveAccountResult {
  success: boolean;
  poolEmpty: boolean;
  removedProvider: boolean;
  deletedCredential: boolean;
  notice?: string | null;
  error?: string;
  /** Sanitized constant only (never a raw fs/upstream message). */
  message?: string | null;
}
export interface WorkBuddyMigrationResult {
  success: boolean;
  renamedProvider: boolean;
  renamedRefs: string[];
  error?: string;
  message?: string | null;
}

/** Injected so tests can stub fetch without touching a real upstream. */
export type { WorkBuddyFetch } from "./workbuddy";
import type { WorkBuddyFetch } from "./workbuddy";

export interface WorkBuddyServiceOptions {
  configService: any;
  logger?: any;
  fetch?: WorkBuddyFetch;
  /** Runtime handles, resolved lazily so a service built before readiness works. */
  getServer?: () => any;
  /** Credential store + source reader injection (tests only; production uses the
   *  fixed CCR-private path and the fixed desktop login path). */
  store?: WorkBuddyCredentialStore;
  readSource?: (site?: WorkBuddySiteId) => WorkBuddySourceResult;
}

const PROVIDER_KEYS = ["Providers", "providers"] as const;
const CONFIG_TIMEOUT_MS = 15000;

/** Split a `provider,model` routing reference; null when not that shape. */
function refProviderModel(value: string): [string, string] | null {
  const i = value.indexOf(",");
  if (i <= 0 || i === value.length - 1) return null;
  return [value.slice(0, i), value.slice(i + 1)];
}

/**
 * §16 Router auto-clean for hide: structural walk, never string replacement.
 * Covered reference kinds (verified against core/src/utils/router.ts):
 *  - `default`            → becomes `<provider>,<firstVisible>` (or "" when none visible)
 *  - scenario strings     → background/think/longContext/webSearch/image AND any
 *                           other own string value shaped `<provider>,<model>` → ""
 *  - `models` map entries → client-alias entries referencing the model are REMOVED entirely
 *  - `families.<f>.default` → cleared to "" (scenario reference; contract letter: only
 *                           the global default gets the first-visible substitution)
 * NOT covered (left byte-identical, reported to milestone C/UI): Router.fallback
 * stages, per-project Router configs and client-synced files; unrelated model
 * strings are never altered.
 */
export function clearWorkBuddyRouterRefs(router: any, providerName: string, model: string, firstVisible: string | null): { router: any; clearedRefs: string[] } {
  const clearedRefs: string[] = [];
  if (!router || typeof router !== "object" || Array.isArray(router)) return { router, clearedRefs };
  const next = structuredClone(router);
  const hit = (v: string): boolean => {
    const pm = refProviderModel(v);
    return !!pm && pm[0] === providerName && pm[1] === model;
  };
  if (typeof next.default === "string" && hit(next.default)) {
    next.default = firstVisible ? `${providerName},${firstVisible}` : "";
    clearedRefs.push("default");
  }
  for (const [k, v] of Object.entries(next)) {
    if (["default", "models", "families", "fallback"].includes(k)) continue;
    if (typeof v === "string" && hit(v)) { next[k] = ""; clearedRefs.push(`scenario:${k}`); }
    // Scenario fields may also be arrays of refs (longContext): drop matching entries.
    else if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
      const kept = (v as string[]).filter((x) => !hit(x));
      if (kept.length !== (v as string[]).length) { next[k] = kept; clearedRefs.push(`scenario:${k}`); }
    }
  }
  if (next.models && typeof next.models === "object" && !Array.isArray(next.models)) {
    for (const [k, v] of Object.entries(next.models)) {
      if (typeof v === "string" && hit(v)) { delete next.models[k]; clearedRefs.push(`models:${k}`); }
    }
  }
  if (next.families && typeof next.families === "object" && !Array.isArray(next.families)) {
    for (const [f, fam] of Object.entries(next.families)) {
      if (fam && typeof fam === "object" && !Array.isArray(fam) && typeof (fam as any).default === "string" && hit((fam as any).default)) {
        (fam as any).default = "";
        clearedRefs.push(`families.${f}.default`);
      }
    }
  }
  return { router: next, clearedRefs };
}

/**
 * §16 migration rewrite: `workbuddy,<model>` → `workbuddy-ai,<model>` ONLY for
 * models in the migrated AI site's model set. Same covered kinds as the hide
 * cleanup, except `models` map VALUES are rewritten in place (keys kept) and
 * Router.fallback stays untouched.
 */
export function renameWorkBuddyAiRouterRefs(router: any, models: ReadonlySet<string>): { router: any; renamedRefs: string[] } {
  const renamedRefs: string[] = [];
  if (!router || typeof router !== "object" || Array.isArray(router)) return { router, renamedRefs };
  const next = structuredClone(router);
  const rewrite = (v: string): string | null => {
    const pm = refProviderModel(v);
    return pm && pm[0] === WORKBUDDY_PROVIDER_NAME && models.has(pm[1]) ? `${WORKBUDDY_AI_PROVIDER_NAME},${pm[1]}` : null;
  };
  for (const [k, v] of Object.entries(next)) {
    if (["models", "families", "fallback"].includes(k)) continue;
    if (typeof v === "string") {
      const r = rewrite(v);
      if (r) { next[k] = r; renamedRefs.push(k === "default" ? "default" : `scenario:${k}`); }
    } else if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
      const rewritten = (v as string[]).map((x) => rewrite(x) ?? x);
      if (rewritten.some((x, i) => x !== (v as string[])[i])) { next[k] = rewritten; renamedRefs.push(`scenario:${k}`); }
    }
  }
  if (next.models && typeof next.models === "object" && !Array.isArray(next.models)) {
    for (const [k, v] of Object.entries(next.models)) {
      if (typeof v === "string") {
        const r = rewrite(v);
        if (r) { next.models[k] = r; renamedRefs.push(`models:${k}`); }
      }
    }
  }
  if (next.families && typeof next.families === "object" && !Array.isArray(next.families)) {
    for (const [f, fam] of Object.entries(next.families)) {
      if (fam && typeof fam === "object" && !Array.isArray(fam) && typeof (fam as any).default === "string") {
        const r = rewrite((fam as any).default);
        if (r) { (fam as any).default = r; renamedRefs.push(`families.${f}.default`); }
      }
    }
  }
  return { router: next, renamedRefs };
}

function providerList(config: any): { key: "Providers" | "providers"; list: any[] } {
  const key = PROVIDER_KEYS.find((k) => Array.isArray(config?.[k])) ?? "Providers";
  return { key, list: Array.isArray(config?.[key]) ? config[key] : [] };
}

export class WorkBuddyAuthService {
  /** Single-flight guards: concurrent callers reuse one in-flight operation. */
  private importsInFlight = new Map<WorkBuddySiteId, Promise<WorkBuddyMutationResult>>();
  private mutationTail: Promise<unknown> = Promise.resolve();
  private credentialGeneration(c: WorkBuddyCredential): string {
    return createHash("sha256").update(JSON.stringify([c.kind, c.uid, c.enterpriseId, c.importedAt, c.accessToken])).digest("hex");
  }
  /** Tag a pool account with its site as a v1-shaped credential snapshot. */
  private withSite(site: WorkBuddySiteId, a: WorkBuddyAccount): WorkBuddyCredential {
    return { version: 1, kind: site, ...a };
  }
  /**
   * THE serialization boundary for every credential-store/config read-modify-write
   * (§16 review): import/poll persistence, sync, disconnect, switch, remove,
   * hide/restore, migration and the browser refresh save path all run here, so
   * concurrent mutations on DIFFERENT sites can never lose updates. Read-only
   * helpers (selection, status) and currentCredential's desktop renewal (memory
   * only) stay outside; currentCredential's browser refresh enqueues — never
   * call currentCredential from inside enqueueMutation.
   */
  private enqueueMutation<T>(action: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(action);
    this.mutationTail = result.catch(() => {});
    return result;
  }
  /** Per-site epochs (§16): disconnect/remove/import invalidate that site's poll/refresh/sync/persist checkpoints only. */
  private siteEpochs = new Map<WorkBuddySiteId, number>();
  private epochOf(site: WorkBuddySiteId): number { return this.siteEpochs.get(site) ?? 0; }
  private bumpEpoch(site: WorkBuddySiteId): void { this.siteEpochs.set(site, (this.siteEpochs.get(site) ?? 0) + 1); }
  /** In-browser sign-ins under way, by capability id (contract §15): state + deadline only. */
  private pendingLogins = new Map<string, { site: WorkBuddySiteId; state: string; url: string; expiresAt: number; epoch: number; lastPoll: number; token?: Extract<Awaited<ReturnType<typeof pollWorkBuddyLoginToken>>, { ok: true }>["token"]; result?: any; inFlight?: Promise<any> }>();
  private loginStarts = 0;
  /** Per-account browser refresh single-flight, keyed site|uid|token-generation. */
  private browserRefreshes = new Map<string, Promise<WorkBuddyCredential | null>>();
  /** Per-site sync single-flight. */
  private syncsInFlight = new Map<WorkBuddySiteId, Promise<WorkBuddyMutationResult>>();
  /** Memory-only renewed desktop credentials, keyed by snapshot generation. Never persisted. */
  private desktopRenewals = new Map<string, WorkBuddyCredential>();

  constructor(private readonly options: WorkBuddyServiceOptions) {}

  private get log(): any {
    return this.options.logger ?? console;
  }

  private get fetchImpl(): WorkBuddyFetch {
    return this.options.fetch ?? ((url, init) => fetch(url, init));
  }

  /** Fixed-origin discovery/billing calls bypass configured CCR proxies. */
  private directFetch(url: string, init: RequestInit = {}): ReturnType<WorkBuddyFetch> {
    return this.fetchImpl(url, { ...init, dispatcher: getDirectDispatcher() } as RequestInit);
  }

  private get configService(): any {
    return this.options.configService;
  }

  private get store(): WorkBuddyCredentialStore {
    return this.options.store ?? workBuddyCredentialStore;
  }

  private get readSource(): (site?: WorkBuddySiteId) => WorkBuddySourceResult {
    return this.options.readSource ?? readWorkBuddySource;
  }

  // ---------------------------------------------------------------- status ---

  /** Connected site ids from the private store only, CN-first for determinism. */
  private async connectedSites(): Promise<WorkBuddySiteId[]> {
    const data = await this.store.loadData().catch(() => null);
    if (!data) return [];
    const ids = Object.keys(data.sites) as WorkBuddySiteId[];
    return ids.includes("workbuddy") ? ["workbuddy", ...ids.filter((s) => s !== "workbuddy")] : ids;
  }

  /** Legacy no-arg default: the first connected site (§16 keeps flat mirrors only as compat). */
  private async firstConnectedSite(): Promise<WorkBuddySiteId | null> {
    return (await this.connectedSites())[0] ?? null;
  }

  /** Which site's managed provider is this config entry (kind flag first, name/marker/URL second). */
  private providerSite(p: any): WorkBuddySiteId | null {
    if (p?.workbuddy_kind === "workbuddy" || p?.workbuddy_kind === "workbuddy-ai") return p.workbuddy_kind;
    if (!isManagedWorkBuddy(p)) return null;
    return workBuddySiteFromProvider(p);
  }

  private summarizeAccount(a: WorkBuddyAccount, activeUid: string | null, now: number): WorkBuddyAccountSummary {
    const modelSlots = Object.entries(a.modelCooldowns ?? {}).filter(([, s]) => s.until > now);
    const longestModel = modelSlots.sort(([, x], [, y]) => y.until - x.until)[0];
    const summary: WorkBuddyAccountSummary = {
      uid: a.uid,
      displayName: a.displayName || "",
      source: a.source,
      active: a.uid === activeUid,
      expiresAt: a.expiresAt || 0,
      importedAt: a.importedAt || "",
    };
    if (a.cooldown && a.cooldown.until > now) {
      summary.coolingUntil = a.cooldown.until;
      summary.coolingCode = a.cooldown.code;
      if (a.cooldown.code === 11140) summary.restrictedUntil = a.cooldown.until;
    }
    if (longestModel) {
      summary.modelCoolingUntil = longestModel[1].until;
      summary.modelCoolingModel = longestModel[0];
    }
    return summary;
  }

  /**
   * Per-site pool status (contract §16): sanitized account summaries, cooldown
   * badges, hidden models. Reads store + config only — never the desktop file,
   * never the upstream. Tokens never appear anywhere in the result.
   */
  async getPoolStatus(): Promise<WorkBuddyPoolStatus> {
    const now = Date.now();
    let data: WorkBuddyCredentialData | null = null;
    try {
      data = await this.store.loadData();
    } catch (error: any) {
      const lastError = error?.message || "WorkBuddy 登录态不可读";
      return { sites: { workbuddy: {
        status: "error", site: "workbuddy", providerName: WORKBUDDY_PROVIDER_NAME,
        origin: WORKBUDDY_CHAT_ORIGIN, accounts: [], activeUid: null, models: [], hiddenModels: [],
        modelCount: 0, lastSyncAt: null, lastError, renewalMode: "desktop",
      } }, connectedSites: [] };
    }
    if (!data) return { sites: {}, connectedSites: [] };
    const config = await this.readConfig();
    const sites: WorkBuddyPoolStatus["sites"] = {};
    for (const id of ["workbuddy", "workbuddy-ai"] as const) {
      const state = data.sites[id];
      if (!state) continue;
      const id2 = managedProvider(id);
      const managed = providerList(config).list.find((p: any) => this.providerSite(p) === id);
      const union = new Set<string>([...(state.discoveredModels ?? []), ...(Array.isArray(managed?.models) ? managed.models : []).filter((m: any) => typeof m === "string")]);
      const models = [...union].filter((m) => !state.hiddenModels.includes(m));
      const active = state.accounts.find((a) => a.uid === state.activeUid) ?? state.accounts[0];
      sites[id] = {
        status: active.expiresAt > 0 && now >= active.expiresAt ? "expired" : "connected",
        site: id,
        providerName: id2.name,
        origin: workBuddySite(id).origin,
        accounts: state.accounts.map((a) => this.summarizeAccount(a, state.activeUid, now)),
        activeUid: state.activeUid,
        models,
        hiddenModels: [...state.hiddenModels],
        modelCount: models.length,
        lastSyncAt: state.lastSyncAt ?? null,
        lastError: state.lastError ?? null,
        renewalMode: active.source === "browser" ? "browser" : "desktop",
      };
    }
    return { sites, connectedSites: (await this.connectedSites()) as WorkBuddySiteId[] };
  }

  /**
   * LEGACY flat status (pre-§16 shape), mirrored from the first connected site
   * (CN preferred). Milestone C's admin /status returns getPoolStatus(); this
   * wrapper stays until callers are converted.
   */
  async getStatus(): Promise<WorkBuddyStatusResult> {
    const base: WorkBuddyStatusResult = {
      status: "not_connected",
      kind: "workbuddy",
      site: WORKBUDDY_CHAT_ORIGIN,
      providerName: WORKBUDDY_PROVIDER_NAME,
      models: [],
      modelCount: 0,
      uid: null,
      displayName: null,
      domain: null,
      expiresAt: null,
      importedAt: null,
      lastSyncAt: null,
      lastError: null,
      source: "desktop",
      renewalMode: "desktop",
      imagesUnsupportedModels: [],
    };
    const pool = await this.getPoolStatus();
    const id = pool.connectedSites[0];
    const site = id ? pool.sites[id] : undefined;
    if (!site) return pool.sites.workbuddy?.status === "error"
      ? { ...base, status: "error", lastError: pool.sites.workbuddy.lastError }
      : base;
    const active = site.accounts.find((a) => a.active) ?? null;
    let domain: string | null = null;
    if (active) {
      const data = await this.store.loadData().catch(() => null);
      const account = data?.sites[site.site]?.accounts.find((a) => a.uid === active.uid);
      domain = account?.domain || null;
    }
    return {
      status: site.status,
      kind: site.site,
      site: site.origin,
      providerName: site.providerName,
      models: site.models,
      modelCount: site.modelCount,
      uid: active?.uid ?? null,
      displayName: active?.displayName || null,
      domain,
      expiresAt: active?.expiresAt ?? null,
      importedAt: active?.importedAt || null,
      lastSyncAt: site.lastSyncAt,
      lastError: site.lastError,
      source: active?.source ?? "desktop",
      renewalMode: site.renewalMode,
      imagesUnsupportedModels: site.site === "workbuddy-ai" ? site.models.filter((model) => /^glm-/.test(model)) : [],
    };
  }

  // ------------------------------------------------------------ discovery ---

  /**
   * GET /v3/config with the CONFIG user agent (distinct from the chat UA).
   * Errors are classified and never carry a raw upstream body.
   */
  async fetchModels(credential: WorkBuddyCredential): Promise<{ id: string; name: string }[]> {
    let response: Response;
    const site = workBuddySite(credential.kind);
    try {
      response = await this.directFetch(workBuddyConfigUrl(site), {
        method: "GET",
        headers: credentialHeaders(credential, WORKBUDDY_CONFIG_UA),
        signal: AbortSignal.timeout(CONFIG_TIMEOUT_MS),
        redirect: "error",
      });
    } catch (error: any) {
      throw classifyWorkBuddyError(0, { msg: "WorkBuddy 模型发现请求失败" });
    }
    // Never trust a redirect: the upstream origin is fixed.
    if (response.redirected || new URL(response.url).origin !== new URL(site.origin).origin) {
      throw classifyWorkBuddyError(0, { msg: "WorkBuddy 模型发现请求被重定向" });
    }
    const text = await response.text().catch(() => "");
    if (!response.ok) throw classifyWorkBuddyError(response.status, text);
    let env: any;
    try {
      env = JSON.parse(text);
    } catch {
      throw classifyWorkBuddyError(response.status, { msg: "WorkBuddy 模型发现响应无法解析" });
    }
    const models = parseWorkBuddyModels(env, credential.kind);
    return models.map((m) => ({ id: m.id, name: m.name }));
  }

  private resolveProxy(provider: Partial<LLMProvider>): string | undefined {
    try {
      return resolveProviderProxyUrl(this.configService, provider as any);
    } catch {
      return undefined;
    }
  }

  // -------------------------------------------------------------- import ----

  /**
   * Explicit import: read the fixed local login file once, validate, discover
   * models, and only then persist the credential + provider.
   */
  importFromLocalDesktop(site: WorkBuddySiteId = "workbuddy"): Promise<WorkBuddyMutationResult> {
    this.bumpEpoch(site);
    this.clearSitePendingLogins(site);
    workBuddySite(site); // Runtime validation: no arbitrary site or URL from HTTP.
    let running = this.importsInFlight.get(site);
    if (!running) {
      running = this.enqueueMutation(() => this.runImport(site)).finally(() => { this.importsInFlight.delete(site); });
      this.importsInFlight.set(site, running);
    }
    return running;
  }

  private async runImport(site: WorkBuddySiteId): Promise<WorkBuddyMutationResult> {
    const source = this.readSource(site);
    if (!source.ok) {
      return {
        success: false,
        status: source.reason === "sealed" ? "sealed" : source.reason === "source_missing" ? "source_missing" : "error",
        models: [],
        modelCount: 0,
        displayName: null,
        reason: source.reason,
        message: source.reason === "sealed"
          ? "WorkBuddy 5.6+ 已加密本地登录态，暂不支持导入；未改动任何文件"
          : source.reason === "source_missing"
            ? "未在本机固定路径找到 WorkBuddy 登录文件；请先在 WorkBuddy 客户端登录后重试"
            : "本机 WorkBuddy 登录文件无法解析；未改动任何文件",
        modelsUnchanged: true,
      };
    }
    return this.persistCandidate(source.credential, "已导入本机 WorkBuddy 登录并同步模型");
  }

  /**
   * Shared persistence path for both credential sources (desktop import and
   * browser sign-in): pool add-or-replace (§16 — same uid REPLACES, cross-site
   * pools coexist with NO site-conflict 409), validate-then-persist discovery,
   * per-site name conflict, and full rollback (store snapshot + provider) on
   * failure.
   */
  private async persistCandidate(candidate: WorkBuddyCredential, connectedMessage: string, isCurrent: () => boolean = () => true): Promise<WorkBuddyMutationResult> {
    const cancelled = (): WorkBuddyMutationResult => ({ success: false, status: "error", models: [], modelCount: 0, displayName: null, message: "WorkBuddy 登录已取消", modelsUnchanged: true });
    if (!isCurrent()) return cancelled();
    const previousData = await this.store.loadData().catch((): WorkBuddyCredentialData | null => null);

    // Discovery must succeed with a non-empty list before anything is written.
    let discovered: { id: string; name: string }[];
    try {
      discovered = await this.fetchModels(candidate);
    } catch (error: any) {
      this.log.warn?.(`[workbuddy] discovery failed: ${error?.code || error?.message}`);
      return {
        success: false,
        status: "error",
        models: [],
        modelCount: 0,
        displayName: candidate.displayName || null,
        reason: "models_fetch_failed",
        message: "WorkBuddy 模型发现失败；保留原有配置与登录态",
        modelsUnchanged: true,
      };
    }
    if (!discovered.length) {
      return {
        success: false,
        status: "error",
        models: [],
        modelCount: 0,
        displayName: candidate.displayName || null,
        reason: "models_fetch_failed",
        message: "WorkBuddy 未返回 cli 模型；保留原有配置与登录态",
        modelsUnchanged: true,
      };
    }

    const hidden = new Set(previousData?.sites[candidate.kind]?.hiddenModels ?? []);
    const models = discovered.map((m) => m.id).filter((m) => !hidden.has(m));
    const conflict = await this.findNameConflict(candidate.kind);
    if (conflict) {
      return {
        success: false,
        status: "error",
        models: [],
        modelCount: 0,
        displayName: candidate.displayName || null,
        error: "workbuddy_name_conflict",
        message: `已存在同名普通 provider「${managedProvider(candidate.kind).name}」，请先改名或删除后再导入`,
      };
    }

    if (!isCurrent()) return cancelled();
    let wroteCredential = false;
    try {
      await this.store.upsertAccount(candidate);
      wroteCredential = true;
      if (!isCurrent()) throw new Error("workbuddy_login_cancelled");
      await this.upsertManagedProvider(models, candidate.kind, isCurrent);
    } catch (error: any) {
      if (wroteCredential) {
        if (previousData) await this.store.saveData(previousData);
        else await this.store.delete();
      }
      this.log.error?.("[workbuddy] persist failed; private credential rolled back");
      return {
        success: false,
        status: "error",
        models: [],
        modelCount: 0,
        displayName: candidate.displayName || null,
        message: "WorkBuddy 配置失败；未写入配置",
        modelsUnchanged: true,
      };
    }
    return this.mutation("connected", models, candidate.displayName, connectedMessage);
  }

  // ------------------------------------------------------- browser login ----

  /** Drop only this site's pending login jobs (per-site epoch isolation, §16). */
  private clearSitePendingLogins(site: WorkBuddySiteId): void {
    for (const [id, job] of this.pendingLogins) if (job.site === site) this.pendingLogins.delete(id);
  }

  /** Explicit browser authorization; upstream state never leaves this service. */
  startBrowserLogin(site: WorkBuddySiteId): Promise<any> {
    workBuddySite(site);
    for (const [id, job] of this.pendingLogins) if (Date.now() >= job.expiresAt) this.pendingLogins.delete(id);
    if (this.pendingLogins.size + this.loginStarts >= 8) return Promise.reject(new Error("workbuddy_login_busy"));
    this.loginStarts++;
    // §16: cross-site pools coexist — no other-site conflict check. The epoch is
    // THIS site's: a disconnect/import/remove on the same site invalidates the job.
    const epoch = this.epochOf(site);
    const task = (async () => {
      const started = await createWorkBuddyLoginState(site, (url, init) => this.directFetch(url, init));
      if (epoch !== this.epochOf(site)) throw new Error("workbuddy_login_cancelled");
      // A bounded number of pending browser jobs; each has a private random capability.
      for (const [id, job] of this.pendingLogins) if (Date.now() >= job.expiresAt) this.pendingLogins.delete(id);
      if (this.pendingLogins.size >= 8) throw new Error("workbuddy_login_busy");
      const loginId = randomBytes(24).toString("hex");
      this.pendingLogins.set(loginId, { ...started, site, epoch, lastPoll: 0 });
      return { ok: true, loginId, url: started.url, expiresAt: started.expiresAt };
    })().finally(() => { this.loginStarts--; });
    return task;
  }

  /**
   * Cancel removes exactly its own job (§15 "cancel only invalidates its own
   * job" — a second concurrent login on the same site keeps working). The site
   * epoch stays untouched here; disconnect/remove are the epoch bumps.
   */
  cancelBrowserLogin(site: WorkBuddySiteId, loginId: string): { success: true } {
    const job = this.pendingLogins.get(loginId);
    if (job?.site === site) this.pendingLogins.delete(loginId);
    return { success: true };
  }

  /** Single-flight poll; cancellation/disconnect invalidates every persistence checkpoint. */
  async pollBrowserLogin(site: WorkBuddySiteId, loginId: string): Promise<any> {
    workBuddySite(site);
    const job = this.pendingLogins.get(loginId);
    if (!job || job.site !== site) return { status: "none" };
    if (job.result) return job.result;
    if (Date.now() >= job.expiresAt) { this.pendingLogins.delete(loginId); return { status: "expired" }; }
    if (job.inFlight) return job.inFlight;
    if (Date.now() - job.lastPoll < 1000) return { status: "pending" };
    job.lastPoll = Date.now();
    const active = () => this.pendingLogins.get(loginId) === job && job.epoch === this.epochOf(site) && Date.now() < job.expiresAt;
    const task = (async () => {
      if (!job.token) {
        const poll = await pollWorkBuddyLoginToken(site, job.state, (url, init) => this.directFetch(url, init));
        if (!active()) return { status: "none" };
        if (poll.pending) return { status: "pending" };
        if (!poll.ok) return job.result = { status: "failed", reason: "login_state_rejected", message: null };
        job.token = poll.token;
      }
      const t = job.token;
      let account: { uid: string; displayName: string; enterpriseId: string } | null;
      try {
        account = await fetchWorkBuddyLoginAccount(site, job.state, t.accessToken, t.domain, (url, init) => this.directFetch(url, init));
      } catch { return job.result = { status: "failed", reason: "login_account_failed", message: null }; }
      if (!active()) return { status: "none" };
      if (!account) return { status: "pending" };
      if (!account.uid) return job.result = { status: "failed", reason: "login_account_failed", message: null };
      const candidate: WorkBuddyCredential = {
        version: 1, kind: site, uid: account.uid, displayName: account.displayName,
        domain: t.domain || "", enterpriseId: account.enterpriseId,
        accessToken: t.accessToken, expiresAt: t.expiresAt,
        importedAt: new Date().toISOString(), source: "browser", tokenType: t.tokenType,
        ...(t.refreshToken ? { refreshToken: t.refreshToken, ...(t.refreshExpiresAt ? { refreshExpiresAt: t.refreshExpiresAt } : {}) } : {}),
      };
      const result = await this.enqueueMutation(async () => {
        if (!active()) return null;
        return this.persistCandidate(candidate, "WorkBuddy 账号授权登录成功，已同步模型", active);
      });
      if (!result || !active()) return { status: "none" };
      if (!result.success) {
        const reason = result.error === "workbuddy_name_conflict"
          ? result.error : (result.reason === "models_fetch_failed" ? "models_fetch_failed" : "login_persist_failed");
        return job.result = { status: "failed", reason, message: null };
      }
      return job.result = { status: "connected", result };
    })().finally(() => { job.inFlight = undefined; });
    job.inFlight = task;
    return task;
  }

  // ---------------------------------------------------------------- sync ----

  /**
   * Per-site model sync (§16). No argument = legacy compat: the first connected
   * site (CN preferred). Discovery runs with the site's active account; the
   * site's model set is the CUMULATIVE union (models that vanish upstream stay
   * registered), filtered by hiddenModels BEFORE registration. Sync never
   * touches Router and never resurrects hidden models.
   */
  async syncModels(site?: WorkBuddySiteId): Promise<WorkBuddyMutationResult> {
    const target = site ?? (await this.firstConnectedSite());
    if (!target) return { success: false, status: "not_connected", models: [], modelCount: 0, displayName: null, error: "workbuddy_not_connected", message: "尚未导入 WorkBuddy 登录" };
    workBuddySite(target);
    let flight = this.syncsInFlight.get(target);
    if (!flight) {
      const epoch = this.epochOf(target);
      // Renewal/selection FIRST: currentCredential may enqueue its own mutation
      // (browser refresh) — it must never run inside the mutation queue.
      flight = this.currentCredential(target).then((credential) =>
        this.enqueueMutation(() => this.runSync(target, epoch, credential))
      ).finally(() => { this.syncsInFlight.delete(target); });
      this.syncsInFlight.set(target, flight);
    }
    return flight;
  }

  private async runSync(site: WorkBuddySiteId, epoch: number, credential: WorkBuddyCredential | null): Promise<WorkBuddyMutationResult> {
    if (epoch !== this.epochOf(site)) return { success: false, status: "not_connected", error: "workbuddy_not_connected", models: [], modelCount: 0, displayName: null };
    let data: WorkBuddyCredentialData | null = null;
    try {
      data = await this.store.loadData();
    } catch {
      return { success: false, status: "error", models: [], modelCount: 0, displayName: null, message: "WorkBuddy 登录态不可读，请重新导入" };
    }
    const state = data?.sites[site];
    if (!state || !credential) {
      return { success: false, status: "not_connected", models: [], modelCount: 0, displayName: null, error: "workbuddy_not_connected", message: "尚未导入 WorkBuddy 登录" };
    }
    const config = await this.readConfig();
    const existing = providerList(config).list.find((p: any) => this.providerSite(p) === site);
    const currentModels = Array.isArray(existing?.models) ? existing.models.filter((m: any) => typeof m === "string") : [];

    let discovered: { id: string; name: string }[];
    try {
      discovered = await this.fetchModels(credential);
    } catch (error: any) {
      this.log.warn?.(`[workbuddy] sync discovery failed: ${error?.code || error?.message}`);
      return {
        success: false,
        status: "error",
        models: currentModels,
        modelCount: currentModels.length,
        displayName: credential.displayName || null,
        reason: "models_fetch_failed",
        message: "WorkBuddy 模型发现失败；保留原模型列表",
        modelsUnchanged: true,
      };
    }
    if (!discovered.length) {
      return {
        success: false,
        status: "error",
        models: currentModels,
        modelCount: currentModels.length,
        displayName: credential.displayName || null,
        reason: "models_fetch_failed",
        message: "WorkBuddy 未返回 cli 模型；保留原模型列表",
        modelsUnchanged: true,
      };
    }

    // Cumulative union (§16), then hidden filter at registration time only.
    const union = new Set<string>([...(state.discoveredModels ?? []), ...currentModels, ...discovered.map((m) => m.id)]);
    const models = [...union].filter((m) => !state.hiddenModels.includes(m));
    try {
      await this.store.mergeDiscoveredModels(site, [...union]);
      await this.upsertManagedProvider(models, site);
      const updated = await this.store.loadData();
      const updatedState = updated?.sites[site];
      if (updated && updatedState) {
        updatedState.lastSyncAt = new Date().toISOString();
        await this.store.saveData(updated);
      }
    } catch {
      // Sanitized constant: a raw fs/config error may carry local paths.
      this.log.error?.("[workbuddy] sync persist failed");
      return {
        success: false,
        status: "error",
        models: currentModels,
        modelCount: currentModels.length,
        displayName: credential.displayName || null,
        reason: "models_fetch_failed",
        message: "WorkBuddy 同步失败；保留原模型列表",
        modelsUnchanged: true,
      };
    }
    return this.mutation("connected", models, credential.displayName, `已同步 ${models.length} 个模型`);
  }

  // ---------------------------------------------------------- disconnect ----

  /**
   * Per-site disconnect (§16): removes that site's provider + pool, keeps its
   * Router references and bumps only that site's epoch. No argument = legacy
   * full reset: every connected site (old single-site semantics). Router is
   * never modified here.
   */
  disconnect(site?: WorkBuddySiteId): Promise<{ success: boolean; removedProvider: boolean; deletedCredential: boolean }> {
    if (site) {
      workBuddySite(site);
      // Synchronous bump: in-flight polls/refreshes/syncs of THIS site must see
      // the invalidation immediately, not after the queue drains (§16).
      this.bumpEpoch(site);
      this.clearSitePendingLogins(site);
      return this.enqueueMutation(() => this.runDisconnectSite(site));
    }
    // Legacy full reset: invalidate EVERY site synchronously, then drain.
    for (const id of ["workbuddy", "workbuddy-ai"] as const) this.bumpEpoch(id);
    this.pendingLogins.clear();
    return this.enqueueMutation(() => this.runDisconnectAll());
  }

  private async runDisconnectAll(): Promise<{ success: boolean; removedProvider: boolean; deletedCredential: boolean }> {
    const sites = await this.connectedSites();
    let removedProvider = false;
    for (const id of sites) {
      this.bumpEpoch(id);
      this.clearSitePendingLogins(id);
      removedProvider = (await this.removeSiteProvider(id)) || removedProvider;
    }
    this.pendingLogins.clear();
    const deletedCredential = await this.store.delete();
    this.desktopRenewals.clear();
    this.reauthProbes.clear();
    return { success: true, removedProvider, deletedCredential };
  }

  private async runDisconnectSite(site: WorkBuddySiteId): Promise<{ success: boolean; removedProvider: boolean; deletedCredential: boolean }> {
    workBuddySite(site);
    const removedProvider = await this.removeSiteProvider(site);
    const deletedCredential = await this.store.deleteSite(site);
    for (const [key, task] of this.browserRefreshes) if (key.startsWith(site + "|")) { this.browserRefreshes.delete(key); task.catch(() => {}); }
    return { success: true, removedProvider, deletedCredential };
  }

  /** Remove ONE site's managed provider entry. Never touches Router (§14/§16). */
  private async removeSiteProvider(site: WorkBuddySiteId): Promise<boolean> {
    const config = await this.readConfig();
    const { key, list } = providerList(config);
    const index = list.findIndex((p: any) => this.providerSite(p) === site);
    const removedProvider = index >= 0;
    if (index >= 0) list.splice(index, 1);
    if (removedProvider) {
      const routerBefore = JSON.stringify(config.Router ?? null);
      config[key] = list;
      try {
        await writeConfigFile(config);
        this.reloadRuntime(config);
      } catch {
        this.log.error?.("[workbuddy] disconnect config write failed");
        throw new Error("WorkBuddy 断开失败；配置未写入");
      }
      if (JSON.stringify(config.Router ?? null) !== routerBefore) {
        throw new Error("WorkBuddy 断开失败；Router 发生变化");
      }
      try { reconcileHealthStore(config, this.log); } catch {}
    }
    return removedProvider;
  }

  // ------------------------------------------------- hide / restore models ---

  /**
   * §16 models/hide as an explicit service operation: records the blacklist
   * (survives sync/re-login), updates the provider's registered models
   * immediately AND auto-cleans Router references. Returns the cleared
   * reference paths for the UI toast. Store+config rollback on write failure.
   */
  async hideModel(site: WorkBuddySiteId, model: string): Promise<WorkBuddyHideResult> {
    if (typeof model !== "string" || !model.length || model.length > 256 || /[\x00-\x1f\x7f,]/.test(model)) {
      return { success: false, clearedRefs: [], models: [], error: "workbuddy_model_invalid" };
    }
    return this.enqueueMutation(async () => {
      const data = await this.store.loadData().catch((): WorkBuddyCredentialData | null => null);
      const state = data?.sites[site];
      if (!data || !state) return { success: false, clearedRefs: [], models: [], error: "workbuddy_not_connected" };
      const config = await this.readConfig();
      const previousConfig = structuredClone(config);
      const { key, list } = providerList(config);
      const providerIndex = list.findIndex((p: any) => this.providerSite(p) === site);
      const provider = providerIndex >= 0 ? list[providerIndex] : undefined;
      const currentModels: string[] = Array.isArray(provider?.models) ? provider.models.filter((m: any) => typeof m === "string") : [];
      const union = new Set<string>([...currentModels, ...(state.discoveredModels ?? [])]);
      const hidden = new Set<string>([...state.hiddenModels, model]);
      const visible = [...union].filter((m) => !hidden.has(m));
      const firstVisible = visible[0] ?? null;
      const cleaned = clearWorkBuddyRouterRefs(config.Router, managedProvider(site).name, model, firstVisible);
      try {
        await this.store.setHiddenModels(site, [...hidden]);
        if (providerIndex >= 0) {
          list[providerIndex] = { ...list[providerIndex], models: visible };
          config[key] = list;
          if (cleaned.clearedRefs.length) config.Router = cleaned.router;
          await writeConfigFile(config);
          this.reloadRuntime(config);
        }
      } catch {
        try {
          await this.store.setHiddenModels(site, state.hiddenModels);
          if (providerIndex >= 0) { await writeConfigFile(previousConfig); this.reloadRuntime(previousConfig); }
        } catch { this.log.error?.("[workbuddy] hide rollback failed"); }
        // Sanitized: the raw error object is never logged or returned (it may
        // carry a filesystem path or an upstream body).
        this.log.error?.("[workbuddy] hide persist failed; rolled back");
        return { success: false, clearedRefs: [], models: currentModels, removedModelRefs: [], defaultFallback: null, error: "workbuddy_config_write_failed", message: "WorkBuddy 模型隐藏失败；已回滚" };
      }
      const clearedRefs = providerIndex >= 0 ? cleaned.clearedRefs : [];
      // Integration seam (UI): the ref that actually left Router, plus the
      // persisted Router.default so the caller can show/apply the new fallback.
      const removedModelRefs = clearedRefs.length ? [`${managedProvider(site).name},${model}`] : [];
      let defaultFallback: string | null = null;
      if (clearedRefs.length) {
        const persisted = await readConfigFileRaw().catch(() => null);
        const value = persisted?.Router?.default;
        defaultFallback = typeof value === "string" ? value : null;
      }
      return { success: true, clearedRefs, models: visible, removedModelRefs, defaultFallback };
    });
  }

  /**
   * §16 models/restore: `model` omitted = restore ALL hidden models. Updates
   * the blacklist + provider models ONLY — restore NEVER rewrites Router
   * (re-wiring is the user's explicit action).
   */
  async restoreModels(site: WorkBuddySiteId, model?: string): Promise<WorkBuddyRestoreResult> {
    return this.enqueueMutation(async () => {
      const data = await this.store.loadData().catch((): WorkBuddyCredentialData | null => null);
      const state = data?.sites[site];
      if (!data || !state) return { success: false, restored: [], models: [], error: "workbuddy_not_connected" };
      const hidden = new Set(state.hiddenModels);
      const restored: string[] = [];
      if (model === undefined) {
        restored.push(...hidden);
        hidden.clear();
      } else if (hidden.has(model)) {
        hidden.delete(model);
        restored.push(model);
      }
      const union = new Set<string>([...(state.discoveredModels ?? [])]);
      const config = await this.readConfig();
      const { key, list } = providerList(config);
      const providerIndex = list.findIndex((p: any) => this.providerSite(p) === site);
      if (providerIndex >= 0) for (const m of list[providerIndex].models ?? []) if (typeof m === "string") union.add(m);
      const visible = [...union].filter((m) => !hidden.has(m));
      try {
        await this.store.setHiddenModels(site, [...hidden]);
        if (providerIndex >= 0) {
          list[providerIndex] = { ...list[providerIndex], models: visible };
          config[key] = list;
          await writeConfigFile(config);
          this.reloadRuntime(config);
        }
      } catch {
        try {
          await this.store.setHiddenModels(site, state.hiddenModels);
          if (providerIndex >= 0) { await writeConfigFile(await this.readConfig()); }
        } catch { this.log.error?.("[workbuddy] restore rollback failed"); }
        this.log.error?.("[workbuddy] restore persist failed; rolled back");
        return { success: false, restored: [], models: [...union].filter((m) => state.hiddenModels.includes(m) === false), error: "workbuddy_config_write_failed", message: "WorkBuddy 模型恢复失败；已回滚" };
      }
      return { success: true, restored, models: visible };
    });
  }

  // ----------------------------------------------------- v1 → v2 migration ---

  /**
   * §16 provider migration: an AI-site credential carried by a legacy provider
   * named `workbuddy` is renamed to `workbuddy-ai` (name/marker/URL re-locked),
   * and Router references `workbuddy,<model>` are rewritten to
   * `workbuddy-ai,<model>` ONLY for models in that site's model set. CN keeps
   * its name. CRASH-SAFE: the on-disk v2 store file is the persisted migration
   * signal — after a crash between store migration and config rewrite, this
   * idempotent detection (v2 store + misnamed managed AI provider) re-applies
   * the config side. A plain provider squatting `workbuddy-ai` FAILS CLOSED.
   * Milestone C must invoke this at startup (and it runs before import/sync).
   */
  async migrateLegacyProviderNaming(): Promise<WorkBuddyMigrationResult> {
    return this.enqueueMutation(async () => {
      let data: WorkBuddyCredentialData | null = null;
      const raw = await this.store.readRaw().catch(() => null);
      if (raw && raw.version !== 2) data = (await this.store.migrateV1()).data;
      else data = raw as WorkBuddyCredentialData | null;
      if (!data) return { success: true, renamedProvider: false, renamedRefs: [] };
      const config = await readConfigFileRaw();
      const previousConfig = structuredClone(config);
      const { key, list } = providerList(config);
      const index = list.findIndex((p: any) => isManagedWorkBuddy(p) && this.providerSite(p) === "workbuddy-ai" && p.name !== WORKBUDDY_AI_PROVIDER_NAME);
      if (index < 0) return { success: true, renamedProvider: false, renamedRefs: [] };
      if (list.some((p: any, i: number) => i !== index && p?.name === WORKBUDDY_AI_PROVIDER_NAME && !isManagedWorkBuddy(p))) {
        return {
          success: false,
          renamedProvider: false,
          renamedRefs: [],
          error: "workbuddy_name_conflict",
          message: `已存在同名普通 provider「${WORKBUDDY_AI_PROVIDER_NAME}」，迁移中止；请先改名或删除后再重试`,
        };
      }
      const state = data.sites["workbuddy-ai"];
      const models = new Set<string>([
        ...(state?.discoveredModels ?? []),
        ...(Array.isArray(list[index].models) ? list[index].models.filter((m: any) => typeof m === "string") : []),
      ]);
      const renamed = renameWorkBuddyAiRouterRefs(config.Router, models);
      list[index] = lockWorkBuddyProvider({ ...list[index], workbuddy_kind: "workbuddy-ai" }, "workbuddy-ai");
      config[key] = list;
      if (renamed.renamedRefs.length) config.Router = renamed.router;
      try {
        await writeConfigFile(config);
        this.reloadRuntime(config);
      } catch {
        try { await writeConfigFile(previousConfig); this.reloadRuntime(previousConfig); } catch { this.log.error?.("[workbuddy] migration rollback failed"); }
        this.log.error?.("[workbuddy] migration config write failed");
        return { success: false, renamedProvider: false, renamedRefs: [], error: "workbuddy_config_write_failed", message: "WorkBuddy 迁移失败；已回滚" };
      }
      const expectedRouter = renamed.renamedRefs.length ? renamed.router : previousConfig.Router;
      if (JSON.stringify(config.Router ?? null) !== JSON.stringify(expectedRouter ?? null)) {
        throw new Error("WorkBuddy 迁移被拒绝：Router 发生意外变化");
      }
      return { success: true, renamedProvider: true, renamedRefs: renamed.renamedRefs };
    });
  }

  // ------------------------------------------------------- config mutation ---

  /** A plain (non-managed) provider owning THIS site's managed name blocks import. */
  private async findNameConflict(site: WorkBuddySiteId): Promise<boolean> {
    const config = await this.readConfig();
    const { list } = providerList(config);
    const name = managedProvider(site).name;
    if (list.some((p: any) => this.providerSite(p) === site && isManagedWorkBuddy(p))) return false;
    return list.some((p: any) => p?.name === name);
  }

  /**
   * Fresh read of the raw config → targeted mutation → existing save semantics
   * (snapshot + .bak + runtime reload). Never a stale cached config object.
   * `siteId` is the site of the credential being imported/synced, so the managed
   * provider's locked URL matches the site that owns the token (contract §14.1).
   */
  private async upsertManagedProvider(models: string[], siteId: WorkBuddySiteId = "workbuddy", isCurrent: () => boolean = () => true): Promise<void> {
    const config = await readConfigFileRaw();
    const previousConfig = structuredClone(config);
    const routerBefore = JSON.stringify(config.Router ?? null);
    const { key, list } = providerList(config);
    const wanted = managedProvider(siteId);
    const index = list.findIndex((p: any) => this.providerSite(p) === siteId);

    if (index >= 0) {
      const existing = list[index];
      // Preserve a user-disabled provider (§13): only re-enable on first import.
      const enabled = existing.enabled !== false;
      list[index] = lockWorkBuddyProvider({ ...existing, models, enabled, workbuddy_kind: siteId }, siteId);
    } else {
      // A plain provider squatting the managed name must have been rejected by
      // findNameConflict before this point.
      list.push(lockWorkBuddyProvider({ name: wanted.name, models, enabled: true, workbuddy_kind: siteId }, siteId));
    }
    config[key] = list;

    // Defence in depth: a generic save must never redirect managed transport.
    protectWorkBuddyConfig(config, config);
    if (!isCurrent()) throw new Error("workbuddy_login_cancelled");
    try {
      await writeConfigFile(config);
      if (!isCurrent()) throw new Error("workbuddy_login_cancelled");
    } catch {
      try {
        await writeConfigFile(previousConfig);
        this.reloadRuntime(previousConfig);
      } catch { this.log.error?.("[workbuddy] previous configuration restoration failed"); }
      throw new Error("workbuddy_config_write_failed");
    }
    if (JSON.stringify(config.Router ?? null) !== routerBefore) {
      throw new Error("WorkBuddy 配置写入被拒绝：Router 发生变化");
    }
    this.reloadRuntime(config);
  }

  /**
   * Reuse the exact POST /api/config reload sequence (reload → set providers →
   * rebuild ProviderService → reconcile health → reset + start active probe).
   * The namespace's closed-over providerService is replaced in place so live
   * routes see the new registry immediately.
   */
  private reloadRuntime(config: any): void {
    const server = this.options.getServer?.() ?? (this.configService as any)?.__server;
    if (!server?.configService) return;
    try {
      server.configService.reload();
      const nextProviders = config?.Providers || config?.providers;
      if (Array.isArray(nextProviders)) server.configService.set("providers", nextProviders);
      if (server.transformerService) {
        server.providerService = new ProviderService(server.configService, server.transformerService, this.log);
      }
      reconcileHealthStore(config, this.log);
      const activeProbe = require("../services/active-probe") as typeof import("./active-probe");
      try { activeProbe.resetActiveProbeService(); } catch {}
      const probeConfig = {
        enabled: server.configService.get("ACTIVE_PROBE_ENABLED") ?? true,
        quotaProbeIntervalMinutes: server.configService.get("QUOTA_PROBE_INTERVAL_MINUTES") ?? 10,
        probeTimeoutMs: server.configService.get("PROBE_TIMEOUT_MS") ?? 15000,
        slowThresholdMs: Number(server.configService.get("PROBE_SLOW_THRESHOLD_MS")) || 3000,
        initialDelayMs: server.configService.get("PROBE_INITIAL_DELAY_MS") ?? 5000,
        excludeProviders: server.configService.get("EXCLUDE_PROBE_PROVIDERS") ?? [],
      };
      server.activeProbeService = activeProbe.startActiveProbe(
        () => server.providerService.getProviders(),
        probeConfig,
        (provider: any) => resolveProviderProxyUrl(server.configService, provider),
        this.log,
        (key: string) => server.configService.get(key)
      );
    } catch (error: any) {
      this.log.warn?.(`WorkBuddy config saved but runtime reload failed: ${error?.message || error}`);
    }
  }

  private async readConfig(): Promise<any> {
    try {
      return await readConfigFileRaw();
    } catch {
      const fromService = this.configService?.getAll?.() ?? {};
      return { Providers: Array.isArray(fromService.providers) ? fromService.providers : [], ...fromService };
    }
  }

  private mutation(status: WorkBuddyStatus, models: string[], displayName: string | undefined, message: string): WorkBuddyMutationResult {
    return {
      success: true,
      status,
      models,
      modelCount: models.length,
      displayName: displayName || null,
      message,
      modelsUnchanged: false,
    };
  }

  // -------------------------------------------------------------- credits ---

  /**
   * Read-only credits summary for the admin UI (contract §14.4/§16: usage
   * {site, uid?} — uid defaults to the site's active account; no argument =
   * legacy first-connected-site active). Never throws and never affects the
   * connection status: a failure returns null. Only derived numbers are
   * returned — never the raw meter envelope.
   */
  async getUsage(site?: WorkBuddySiteId, uid?: string): Promise<{ plan: string; used: number; limit: number; unit: string } | null> {
    try {
      const target = site ?? (await this.firstConnectedSite());
      if (!target) return null;
      const data = await this.store.loadData();
      const state = data?.sites[target];
      if (!state) return null;
      const account = uid ? state.accounts.find((a) => a.uid === uid) : (state.accounts.find((a) => a.uid === state.activeUid) ?? state.accounts[0]);
      if (!account) return null;
      const credential = this.withSite(target, account);
      const read = async (path: string): Promise<any> => {
        const res = await this.directFetch(workBuddySite(target).origin + path, {
          method: "POST", headers: credentialHeaders(credential), body: "{}",
          redirect: "error", signal: AbortSignal.timeout(CONFIG_TIMEOUT_MS),
        });
        try {
          if (!res.ok || res.redirected) return null;
          const env: any = await res.json();
          return Number(env?.code) === 0 ? env.data : null;
        } finally { await res.body?.cancel().catch(() => {}); }
      };
      const sum = await read("/billing/meter/get-user-resource-summary");
      let used = 0, limit = 0;
      for (const p of Array.isArray(sum?.Packages) ? sum.Packages : []) {
        const u = Number(p?.CycleUsedCapacity), t = Number(p?.CycleTotalCapacity);
        if (Number.isFinite(u) && u >= 0) used += u;
        if (Number.isFinite(t) && t > 0) limit += t;
      }
      if (limit > 0 && Number.isFinite(used) && Number.isFinite(limit)) {
        return { plan: sum.IsPaidUser ? "Pro" : "Free", used, limit, unit: "credits" };
      }
      if (credential.enterpriseId) {
        const enterprise = await read("/billing/meter/get-enterprise-user-usage");
        const used = Number(enterprise?.credit), limit = Number(enterprise?.limitNum);
        if (Number.isFinite(used) && used >= 0 && Number.isFinite(limit) && limit > 0) {
          return { plan: "Enterprise", used, limit, unit: "credits" };
        }
      }
      return null;
    } catch { return null; }
  }

  /** One short-lived reauth-probe result per credential generation, never shared across imports. */
  private reauthProbes = new Map<string, { at: number; result: Promise<Error | null> }>();
  async diagnoseReset(credential: WorkBuddyCredential): Promise<Error | null> {
    const key = createHash("sha256").update(JSON.stringify([credential.kind, credential.uid, credential.enterpriseId, credential.accessToken])).digest("hex");
    const previous = this.reauthProbes.get(key);
    if (previous && Date.now() - previous.at < 60_000) return previous.result;
    const result = (async () => {
      try {
        const res = await this.directFetch(workBuddySite(credential.kind).origin + "/billing/meter/get-user-resource-summary", {
          method: "POST", headers: credentialHeaders(credential), body: "{}",
          redirect: "error", signal: AbortSignal.timeout(CONFIG_TIMEOUT_MS),
        });
        try {
          if (res.status !== 401) return null;
          return Object.assign(new Error("WorkBuddy 登录态已失效，请在桌面端登录后重新导入（上游会直接断开被拒的大请求）"), {
            code: "workbuddy_reauth", statusCode: 401, workbuddy: true, nonRetryable: true,
          });
        } finally { await res.body?.cancel().catch(() => {}); }
      } catch { return null; }
    })();
    if (this.reauthProbes.size >= 64) this.reauthProbes.delete(this.reauthProbes.keys().next().value!);
    this.reauthProbes.set(key, { at: Date.now(), result });
    return result;
  }

  // ------------------------------------------------------------- headers ----

  /**
   * Chat headers for a managed provider (legacy helper). The site comes from
   * the provider (name/marker/base URL — §16); the account is selected with
   * active-sticky + cooldown filtering for the requested model when given.
   */
  async buildChatHeaders(provider: LLMProvider, body: any, model?: string): Promise<Record<string, string>> {
    const credential = await this.currentCredential(workBuddySiteFromProvider(provider), model);
    if (!credential) throw new Error("WorkBuddy 未导入登录态，请先在管理页导入");
    const headers = credentialHeaders(credential);
    const session = typeof (provider as any)?.workbuddySession === "string" ? (provider as any).workbuddySession : undefined;
    return { ...headers, ...conversationHeaders(body, session) };
  }

  // ------------------------------------------------- account pool selection --

  /** Still-valid account-scoped cooldown? */
  private accountCooldownBlocked(a: WorkBuddyAccount, now: number): boolean {
    return !!a.cooldown && a.cooldown.until > now;
  }
  /** Still-valid cooldown covering THIS model (additive per-model slots)? */
  private modelCooldownBlocked(a: WorkBuddyAccount, model: string | undefined, now: number): WorkBuddyModelCooldown | undefined {
    if (!model) return undefined;
    const slot = a.modelCooldowns?.[model];
    return slot && slot.until > now ? slot : undefined;
  }

  /**
   * Usable for this request: no account-scoped cooldown and (when a model is
   * given) no still-valid cooldown for that exact model.
   */
  private usableFor(a: WorkBuddyAccount, model: string | undefined, now: number): boolean {
    return !this.accountCooldownBlocked(a, now) && !this.modelCooldownBlocked(a, model, now);
  }

  /** Longest still-valid remaining cooldown for this request, ms (ordering key). */
  private remainingCooldownMs(a: WorkBuddyAccount, model: string | undefined, now: number): number {
    let until = a.cooldown && a.cooldown.until > now ? a.cooldown.until : now;
    const slot = this.modelCooldownBlocked(a, model, now);
    if (slot && slot.until > until) until = slot.until;
    return until - now;
  }

  /**
   * Pick a pool account (§16): active-sticky when usable; otherwise least
   * remaining cooldown, then earliest importedAt. `excludedUids` lets the
   * transport layer (milestone C) skip accounts already attempted in-request.
   * Returns a site-tagged credential snapshot, or null when nothing is usable.
   */
  async selectAccount(site: WorkBuddySiteId, model?: string, excludedUids?: readonly string[]): Promise<WorkBuddyCredential | null> {
    const data = await this.store.loadData().catch(() => null);
    const state = data?.sites[site];
    if (!state || !state.accounts.length) return null;
    const now = Date.now();
    const excluded = new Set(excludedUids ?? []);
    const pool = state.accounts.filter((a) => !excluded.has(a.uid) && this.usableFor(a, model, now));
    if (!pool.length) return null;
    const active = state.activeUid ? pool.find((a) => a.uid === state.activeUid) : undefined;
    const pick = active ?? [...pool].sort((a, b) =>
      this.remainingCooldownMs(a, model, now) - this.remainingCooldownMs(b, model, now) ||
      (a.importedAt < b.importedAt ? -1 : a.importedAt > b.importedAt ? 1 : 0)
    )[0];
    return this.withSite(site, pick);
  }

  /**
   * The credential a request should use. Signature (§16/milestone C contract):
   * currentCredential(site?, model?, excludedUids?, readSource?). The no-arg
   * legacy call resolves the first connected site (CN preferred) with no model
   * filter — behavior the pre-§16 transformer/tests rely on.
   */
  async currentCredential(site?: WorkBuddySiteId, model?: string, excludedUids?: readonly string[], readSource?: () => WorkBuddySourceResult): Promise<WorkBuddyCredential | null> {
    const target = site ?? (await this.firstConnectedSite());
    if (!target) return null;
    const selected = await this.selectAccount(target, model, excludedUids);
    if (!selected) return null;
    if (!workBuddyNeedsRenewal(selected)) return selected;
    if (selected.source === "browser") {
      // Per-ACCOUNT single-flight (§16): each browser account owns its refresh
      // token and rotates independently.
      const generation = this.credentialGeneration(selected);
      const key = `${target}|${selected.uid}|${generation}`;
      const existing = this.browserRefreshes.get(key);
      if (existing) return existing;
      const epoch = this.epochOf(target);
      const task = this.enqueueMutation(async (): Promise<WorkBuddyCredential | null> => {
        const data = await this.store.loadData();
        const live = data?.sites[target]?.accounts.find((a) => a.uid === selected.uid);
        if (!live || this.credentialGeneration(this.withSite(target, live)) !== generation) {
          return live ? this.withSite(target, live) : null;
        }
        try {
          const renewed = await refreshWorkBuddyToken(this.withSite(target, live), (url, init) => this.directFetch(url, init), async (next) => {
            if (epoch !== this.epochOf(target)) return;
            const current = await this.store.loadData();
            const currentLive = current?.sites[target]?.accounts.find((a) => a.uid === selected.uid);
            if (current && currentLive && this.credentialGeneration(this.withSite(target, currentLive)) === generation) {
              // Cooldown state rides along: upsertAccount preserves still-valid slots.
              await this.store.upsertAccount({ ...next, cooldown: currentLive.cooldown, modelCooldowns: currentLive.modelCooldowns });
            }
          });
          return epoch === this.epochOf(target) ? renewed : null;
        } catch { return this.withSite(target, live); }
      }).finally(() => this.browserRefreshes.delete(key));
      this.browserRefreshes.set(key, task);
      return task;
    }
    // Desktop: bounded in-memory renewal, keyed by site+uid+snapshot generation.
    // NEVER persisted and never spends the app's refresh token (§14.3).
    const generation = this.credentialGeneration(selected);
    const cached = this.desktopRenewals.get(generation);
    if (cached) return cached;
    const renewed = await renewWorkBuddyFromDesktop(selected, readSource ?? (() => this.readSource(target)));
    if (this.desktopRenewals.size >= 256) this.desktopRenewals.delete(this.desktopRenewals.keys().next().value!);
    this.desktopRenewals.set(generation, renewed);
    return renewed;
  }

  /**
   * Record a failover cooldown (§16): 14018 → account-scoped, 6004/429 →
   * model-scoped (additive per model), 11140 → account-scoped long cooldown.
   * Runs inside the mutation queue; safe next to concurrent site mutations.
   */
  async markAccountCooldown(site: WorkBuddySiteId, uid: string, cooldown: WorkBuddyCooldown | null): Promise<void> {
    await this.enqueueMutation(() => this.store.setAccountCooldown(site, uid, cooldown));
  }

  /**
   * Explicit sticky switch (§16 account/switch). Does NOT touch Router, the
   * provider entry, or any epoch — only the store's activeUid.
   */
  async switchAccount(site: WorkBuddySiteId, uid: string): Promise<void> {
    await this.enqueueMutation(() => this.store.setActiveUid(site, uid));
  }

  /**
   * Remove one pool account (§16 account/remove): bumps the site epoch,
   * rolls the sticky active to the earliest-imported remaining account, and —
   * when the pool empties — performs the FULL site disconnect semantics:
   * provider removed, Router references RETAINED (+ notice). Store rollback
   * if the provider write fails.
   */
  async removeAccount(site: WorkBuddySiteId, uid: string): Promise<WorkBuddyRemoveAccountResult> {
    workBuddySite(site);
    // Synchronous epoch bump: in-flight refreshes/syncs/polls of this site are
    // invalidated immediately (§16); the store/config work follows in the queue.
    this.bumpEpoch(site);
    return this.enqueueMutation(async () => {
      const snapshot = await this.store.loadData().catch((): WorkBuddyCredentialData | null => null);
      const removed = await this.store.removeAccount(site, uid);
      if (!removed.removed) return { success: false, poolEmpty: false, removedProvider: false, deletedCredential: false, error: "workbuddy_account_not_found" };
      let removedProvider = false;
      let deletedCredential = false;
      const poolEmpty = !removed.data?.sites[site];
      if (poolEmpty) {
        try {
          removedProvider = await this.removeSiteProvider(site);
          deletedCredential = removed.data === null;
        } catch {
          if (snapshot) await this.store.saveData(snapshot);
          this.log.error?.("[workbuddy] account-remove provider write failed; pool restored");
          // Sanitized constant: the raw write error may carry a local path.
          return { success: false, poolEmpty: false, removedProvider: false, deletedCredential: false, error: "workbuddy_config_write_failed", message: "WorkBuddy 账号移除失败；已回滚" };
        }
      }
      return {
        success: true,
        poolEmpty,
        removedProvider,
        deletedCredential,
        notice: poolEmpty ? `WorkBuddy ${site === "workbuddy-ai" ? "国际站" : "CN"} 账号池已清空；该站点已断开，Router 引用已保留` : null,
      };
    });
  }

  /** Exposed for the transformer registration path; not an HTTP surface. */
  /**
   * Chat URL for the credential's site. The transformer and routes.ts both re-lock
   * the URL, so a config-supplied base_url never wins (contract D7).
   */
  async chatUrlFor(credential: WorkBuddyCredential): Promise<string> {
    return workBuddyChatUrl(workBuddySite(credential.kind));
  }
  get chatUrl(): string {
    return WORKBUDDY_CHAT_URL;
  }

  get apiKeyMarker(): string {
    return WORKBUDDY_API_KEY;
  }
}
