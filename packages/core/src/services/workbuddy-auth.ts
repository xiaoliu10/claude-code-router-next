/**
 * WorkBuddy (CN) managed-provider auth service.
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
 *  - No refresh (access-token only), no browser login flow, no static model
 *    fallback, no prompt rewriting, no extra process or plugin install.
 */
import { readConfigFileRaw, writeConfigFile } from "../ccr/config";
import { reconcileHealthStore } from "../ccr/health-reconcile";
import { ProviderService } from "./provider";
import { resolveProviderProxyUrl, getProxyDispatcher } from "./proxy";
import type { LLMProvider } from "../types/llm";
import {
  WORKBUDDY_API_KEY,
  WORKBUDDY_CHAT_ORIGIN,
  WORKBUDDY_CHAT_URL,
  WORKBUDDY_CONFIG_UA,
  WORKBUDDY_CONFIG_URL,
  WORKBUDDY_PROVIDER_NAME,
  classifyWorkBuddyError,
  conversationHeaders,
  credentialHeaders,
  isManagedWorkBuddy,
  lockWorkBuddyProvider,
  parseWorkBuddyModels,
  protectWorkBuddyConfig,
  readWorkBuddySource,
  workBuddyCredentialStore,
  type WorkBuddyCredential,
  type WorkBuddySourceResult,
  type WorkBuddyStatus,
  type WorkBuddyCredentialStore,
} from "./workbuddy";

export type WorkBuddyFailureReason = "sealed" | "source_missing" | "source_invalid" | "models_fetch_failed";

export interface WorkBuddyStatusResult {
  status: WorkBuddyStatus;
  kind: string;
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

/** Injected so tests can stub fetch without touching a real upstream. */
export type WorkBuddyFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface WorkBuddyServiceOptions {
  configService: any;
  logger?: any;
  fetch?: WorkBuddyFetch;
  /** Runtime handles, resolved lazily so a service built before readiness works. */
  getServer?: () => any;
  /** Credential store + source reader injection (tests only; production uses the
   *  fixed CCR-private path and the fixed desktop login path). */
  store?: WorkBuddyCredentialStore;
  readSource?: () => WorkBuddySourceResult;
}

const PROVIDER_KEYS = ["Providers", "providers"] as const;
const CONFIG_TIMEOUT_MS = 15000;
const UPSTREAM_ALLOWED_ORIGIN = new URL(WORKBUDDY_CHAT_ORIGIN);

function providerList(config: any): { key: "Providers" | "providers"; list: any[] } {
  const key = PROVIDER_KEYS.find((k) => Array.isArray(config?.[k])) ?? "Providers";
  return { key, list: Array.isArray(config?.[key]) ? config[key] : [] };
}

export class WorkBuddyAuthService {
  /** Single-flight guards: concurrent callers reuse one in-flight operation. */
  private importInFlight: Promise<WorkBuddyMutationResult> | null = null;
  private syncInFlight: Promise<WorkBuddyMutationResult> | null = null;

  constructor(private readonly options: WorkBuddyServiceOptions) {}

  private get log(): any {
    return this.options.logger ?? console;
  }

  private get fetchImpl(): WorkBuddyFetch {
    return this.options.fetch ?? ((url, init) => fetch(url, init));
  }

  private get configService(): any {
    return this.options.configService;
  }

  private get store(): WorkBuddyCredentialStore {
    return this.options.store ?? workBuddyCredentialStore;
  }

  private get readSource(): () => WorkBuddySourceResult {
    return this.options.readSource ?? readWorkBuddySource;
  }

  // ---------------------------------------------------------------- status ---

  /**
   * Status from the CCR-private credential copy + config only. The WorkBuddy
   * desktop login file is deliberately NOT read here (§13 ruling).
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
    };
    let credential: WorkBuddyCredential | null = null;
    try {
      credential = await this.store.load();
    } catch (error: any) {
      return { ...base, status: "error", lastError: error?.message || "WorkBuddy 登录态不可读" };
    }
    if (!credential) return base;

    const config = await this.readConfig();
    const managed = providerList(config).list.find((p: any) => isManagedWorkBuddy(p));
    const models = Array.isArray(managed?.models) ? managed.models.filter((m: any) => typeof m === "string") : [];
    return {
      ...base,
      status: credential.expiresAt > 0 && Date.now() >= credential.expiresAt ? "expired" : "connected",
      models,
      modelCount: models.length,
      uid: credential.uid,
      displayName: credential.displayName || null,
      domain: credential.domain || null,
      expiresAt: credential.expiresAt || null,
      importedAt: credential.importedAt || null,
      lastSyncAt: credential.lastSyncAt || null,
    };
  }

  // ------------------------------------------------------------ discovery ---

  /**
   * GET /v3/config with the CONFIG user agent (distinct from the chat UA).
   * Errors are classified and never carry a raw upstream body.
   */
  async fetchModels(credential: WorkBuddyCredential): Promise<{ id: string; name: string }[]> {
    const proxyUrl = this.resolveProxy({ name: WORKBUDDY_PROVIDER_NAME } as any);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.fetchImpl(WORKBUDDY_CONFIG_URL, {
        method: "GET",
        headers: credentialHeaders(credential, WORKBUDDY_CONFIG_UA),
        signal: controller.signal,
        ...(proxyUrl ? ({ dispatcher: getProxyDispatcher(proxyUrl) } as RequestInit) : {}),
      });
    } catch (error: any) {
      throw classifyWorkBuddyError(0, { msg: "WorkBuddy 模型发现请求失败" });
    } finally {
      clearTimeout(timer);
    }
    // Never trust a redirect: the upstream origin is fixed.
    if (response.redirected || new URL(response.url).origin !== UPSTREAM_ALLOWED_ORIGIN.origin) {
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
    const models = parseWorkBuddyModels(env);
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
  importFromLocalDesktop(): Promise<WorkBuddyMutationResult> {
    if (!this.importInFlight) {
      this.importInFlight = this.runImport().finally(() => { this.importInFlight = null; });
    }
    return this.importInFlight;
  }

  private async runImport(): Promise<WorkBuddyMutationResult> {
    const source = this.readSource();
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
    const candidate = source.credential;

    // Discovery must succeed with a non-empty list before anything is written.
    let discovered: { id: string; name: string }[];
    try {
      discovered = await this.fetchModels(candidate);
    } catch (error: any) {
      this.log.warn?.(`[workbuddy] import discovery failed: ${error?.code || error?.message}`);
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

    const models = discovered.map((m) => m.id);
    const conflict = await this.findNameConflict();
    if (conflict) {
      return {
        success: false,
        status: "error",
        models: [],
        modelCount: 0,
        displayName: candidate.displayName || null,
        error: "workbuddy_name_conflict",
        message: "已存在同名普通 provider「workbuddy」，请先改名或删除后再导入",
      };
    }

    try {
      await this.store.save(candidate);
      await this.upsertManagedProvider(models);
    } catch (error: any) {
      this.log.error?.({ err: error }, "[workbuddy] import persist failed");
      return {
        success: false,
        status: "error",
        models: [],
        modelCount: 0,
        displayName: candidate.displayName || null,
        message: "WorkBuddy 导入失败；未写入配置",
        modelsUnchanged: true,
      };
    }
    return this.mutation("connected", models, candidate.displayName, "已导入本机 WorkBuddy 登录并同步模型");
  }

  // ---------------------------------------------------------------- sync ----

  syncModels(): Promise<WorkBuddyMutationResult> {
    if (!this.syncInFlight) {
      this.syncInFlight = this.runSync().finally(() => { this.syncInFlight = null; });
    }
    return this.syncInFlight;
  }

  private async runSync(): Promise<WorkBuddyMutationResult> {
    let credential: WorkBuddyCredential | null;
    try {
      credential = await this.store.load();
    } catch {
      return { success: false, status: "error", models: [], modelCount: 0, displayName: null, message: "WorkBuddy 登录态不可读，请重新导入" };
    }
    if (!credential) {
      return { success: false, status: "not_connected", models: [], modelCount: 0, displayName: null, error: "workbuddy_not_connected", message: "尚未导入 WorkBuddy 登录" };
    }
    const config = await this.readConfig();
    const existing = providerList(config).list.find((p: any) => isManagedWorkBuddy(p));
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

    const models = discovered.map((m) => m.id);
    try {
      await this.upsertManagedProvider(models);
      const updated = await this.store.load();
      if (updated) await this.store.save({ ...updated, lastSyncAt: new Date().toISOString() });
    } catch (error: any) {
      this.log.error?.({ err: error }, "[workbuddy] sync persist failed");
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
   * Deletes the private credential and the managed provider only. Every other
   * provider and the whole Router object are left byte-identical (D6/Q3).
   */
  async disconnect(): Promise<{ success: boolean; removedProvider: boolean; deletedCredential: boolean }> {
    const config = await this.readConfig();
    const { key, list } = providerList(config);
    const index = list.findIndex((p: any) => isManagedWorkBuddy(p));
    const removedProvider = index >= 0;
    if (index >= 0) list.splice(index, 1);
    const routerBefore = JSON.stringify(config.Router ?? null);
    if (removedProvider) {
      config[key] = list;
      try {
        await writeConfigFile(config);
        this.reloadRuntime(config);
      } catch (error: any) {
        this.log.error?.({ err: error }, "[workbuddy] disconnect config write failed");
        throw new Error("WorkBuddy 断开失败；配置未写入");
      }
    }
    if (JSON.stringify(config.Router ?? null) !== routerBefore) {
      throw new Error("WorkBuddy 断开失败；Router 发生变化");
    }
    const deletedCredential = await this.store.delete();
    try { reconcileHealthStore(config, this.log); } catch {}
    return { success: true, removedProvider, deletedCredential };
  }

  // ------------------------------------------------------- config mutation ---

  private async findNameConflict(): Promise<boolean> {
    const config = await this.readConfig();
    const { list } = providerList(config);
    const managed = list.find((p: any) => isManagedWorkBuddy(p));
    if (managed) return false;
    return list.some((p: any) => p?.name === WORKBUDDY_PROVIDER_NAME);
  }

  /**
   * Fresh read of the raw config → targeted mutation → existing save semantics
   * (snapshot + .bak + runtime reload). Never a stale cached config object.
   */
  private async upsertManagedProvider(models: string[]): Promise<void> {
    const config = await readConfigFileRaw();
    const routerBefore = JSON.stringify(config.Router ?? null);
    const { key, list } = providerList(config);
    const index = list.findIndex((p: any) => isManagedWorkBuddy(p));

    if (index >= 0) {
      const existing = list[index];
      // Preserve a user-disabled provider (§13): only re-enable on first import.
      const enabled = existing.enabled !== false;
      list[index] = lockWorkBuddyProvider({ ...existing, models, enabled });
    } else {
      list.push(lockWorkBuddyProvider({ name: WORKBUDDY_PROVIDER_NAME, models, enabled: true }));
    }
    config[key] = list;

    // Defence in depth: a generic save must never redirect managed transport.
    protectWorkBuddyConfig(config, config);
    await writeConfigFile(config);
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

  // ------------------------------------------------------------- headers ----

  /**
   * Chat headers for the transformer's auth() hook. The token only ever exists
   * inside this service and the outgoing request; it is never logged.
   */
  async buildChatHeaders(provider: LLMProvider, body: any): Promise<Record<string, string>> {
    const credential = await this.store.load();
    if (!credential) throw new Error("WorkBuddy 未导入登录态，请先在管理页导入");
    const headers = credentialHeaders(credential);
    const session = typeof (provider as any)?.workbuddySession === "string" ? (provider as any).workbuddySession : undefined;
    return { ...headers, ...conversationHeaders(body, session) };
  }

  /** Exposed for the transformer registration path; not an HTTP surface. */
  get chatUrl(): string {
    return WORKBUDDY_CHAT_URL;
  }

  get apiKeyMarker(): string {
    return WORKBUDDY_API_KEY;
  }
}
