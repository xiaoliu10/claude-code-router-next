export interface ProviderTransformer {
  use: (string | (string | Record<string, unknown> | { max_tokens: number })[])[];
  [key: string]: any; // Allow for model-specific transformers
}

export interface Provider {
  name: string;
  api_base_url: string;
  api_key: string;
  models: string[];
  transformer?: ProviderTransformer;
  // Optional quota configuration for rate limiting display
  quota?: ProviderQuotaConfig;
  enabled?: boolean;
  // Opt this provider into PROXY_URL when PROXY_GLOBAL_ENABLED is false.
  proxy_enabled?: boolean;
  // Optional Cookie/token used to query provider quota usage (e.g. Aliyun/iFlytek Coding Plan).
  quota_token?: string;
  // Optional SEC_TOKEN used to query Aliyun MaaS Token Plan quota usage.
  quota_sec_token?: string;
  // Set by CCR for subscription providers managed by plugins.
  // A managed provider's api_base_url / api_key / transformer are fixed by CCR and
  // must not be edited through the generic provider dialog.
  ccr_managed?: boolean;
  // Google-subscription (Antigravity OAuth) managed provider: CCR fixes its
  // api_base_url / api_key marker / transformer, so the generic provider
  // dialog must never edit it (same rule as ccr_managed).
  gemini_oauth_managed?: boolean;
  // Which OAuth backend a managed Google provider belongs to. v1 is
  // antigravity only; the field exists so the UI never guesses.
  gemini_oauth_kind?: GeminiOauthKind;
  // Thinking level injected when the client sends no thinking config:
  // "low" | "medium" | "high", a custom token budget (number), a free-form
  // provider effort string (e.g. "minimal"), or unset/empty to follow the
  // client.
  default_thinking_level?: string | number;
  // Allow for additional custom fields
  [key: string]: any;
}

export const MODEL_FAMILIES = ["opus", "sonnet", "haiku"] as const;
export type ModelFamily = typeof MODEL_FAMILIES[number];

export interface ModelFamilyFallback {
    default?: string[];
    background?: string[];
    think?: string[];
    longContext?: string[];
    extendedContext?: string[];
    webSearch?: string[];
    image?: string[];
    [key: string]: string[] | undefined;
}

export interface ModelFamilyConfig {
    default: string;
    background?: string;
    think?: string;
    longContext?: string;
    longContextThreshold?: number;
    extendedContext?: string;
    enableExtendedContext?: boolean;
    webSearch?: string;
    image?: string;
    fallback?: ModelFamilyFallback;
}

export interface RouterConfig {
    default: string;
    background: string;
    think: string;
    longContext: string;
    longContextThreshold: number;
    extendedContext?: string;
    extendedContextThreshold?: number;
    enableFamilyRouting?: boolean;
    enableFallback?: boolean;
    // Concurrency-priority mode: overflow new sessions to the fallback
    // `default` list once the primary model's in-flight concurrency reaches
    // `concurrencyThreshold` (default 3). Sessions stick to their assigned
    // model unless it errors and error-fallback succeeds.
    enableConcurrencyPriority?: boolean;
    concurrencyThreshold?: number;
    webSearch: string;
    image: string;
    models?: Record<string, string>;
    families?: Record<string, ModelFamilyConfig>;
    custom?: any;
    [key: string]: any;
}

export interface Transformer {
    name?: string;
    path: string;
    options?: Record<string, any>;
}

export interface StatusLineModuleConfig {
  type: string;
  icon?: string;
  text: string;
  color?: string;
  background?: string;
  scriptPath?: string; // 用于script类型的模块，指定要执行的Node.js脚本文件路径
}

export interface StatusLineThemeConfig {
  modules: StatusLineModuleConfig[];
}

export interface StatusLineConfig {
  enabled: boolean;
  currentStyle: string;
  default: StatusLineThemeConfig;
  powerline: StatusLineThemeConfig;
  fontFamily?: string;
}

export type ClientId = 'claudeCode' | 'codex' | 'pi' | 'qwenCode' | 'opencode';

/**
 * Client ids that can take over a project. ZCode keeps no project-scoped config
 * of its own, so unlike the others it is not a global Clients-page client; ccr
 * records its opt-in and routes ZCode sessions through the project Router.
 */
export type ProjectTakeoverClientId = ClientId | 'zcode';

export interface ClientConfig {
  enabled?: boolean;
  managed?: boolean;
  configPath?: string;
  modelAlias?: string;
  quota?: {
    limit5h?: number;
    limit7d?: number;
  };
}

export interface ClientStatus {
  id: ClientId;
  name: string;
  enabled: boolean;
  managed: boolean;
  configPath: string;
  exists: boolean;
  activeModel?: string;
  modelAlias?: string;
  details?: string;
}

export interface ClientOperationResult {
  id: ClientId;
  action: 'enable' | 'disable' | 'restore';
  success: boolean;
  status?: ClientStatus;
  error?: string;
}

export interface ClientApplyResponse {
  success: boolean;
  results: ClientOperationResult[];
  clients: ClientStatus[];
  config: Config;
}

export interface ProjectConfigEntry {
  id: string;
  path: string;
  configPath: string;
  Router: Record<string, any>;
  /** True when at least one client takes this project over through ccr. */
  ccrTakeover?: boolean;
  /** Which clients (Claude Code, pi, qwen-code, opencode, ZCode) currently route this project through ccr. */
  ccrTakeoverClients?: ProjectTakeoverClientId[];
}

export interface ProjectsResponse {
  projects: ProjectConfigEntry[];
}

export interface FallbackConfig {
  default?: string[];
  background?: string[];
  think?: string[];
  longContext?: string[];
  webSearch?: string[];
  modelMapping?: string[];
  image?: string[];
  [key: string]: string[] | undefined;
}

export interface Config {
  Providers: Provider[];
  Router: RouterConfig;
  transformers: Transformer[];
  StatusLine?: StatusLineConfig;
  Clients?: Partial<Record<ClientId, ClientConfig>>;
  forceUseImageAgent?: boolean;
  // Strip Claude Code's dynamic attribution header on takeover to keep the
  // upstream prompt-cache prefix stable. Defaults to true (enabled).
  disableAttributionHeader?: boolean;
  fallback?: FallbackConfig;
  // Top-level settings
  LOG: boolean;
  LOG_LEVEL: string;
  CLAUDE_PATH: string;
  HOST: string;
  PORT: number;
  APIKEY: string;
  API_TIMEOUT_MS: string;
  // Hard timeout (ms) for background provider reachability probes.
  PROBE_TIMEOUT_MS?: number;
  // Latency (ms) above which a provider probe shows a slow-network warning.
  PROBE_SLOW_THRESHOLD_MS?: number;
  PROXY_URL: string;
  // When true (or unset), PROXY_URL applies to all providers; when false,
  // only providers with proxy_enabled=true use the proxy.
  PROXY_GLOBAL_ENABLED?: boolean;
  CUSTOM_ROUTER_PATH?: string;
  // Default context window (tokens) for client takeover auto-compaction
  ContextWindow?: number;
  // Allow extra fields from config file
  [key: string]: any;
}

export type AccessLevel = 'restricted' | 'full';

// Provider health status
export interface ProviderHealthState {
  provider: string;
  model: string;
  status: 'closed' | 'open' | 'half-open';
  failureCount: number;
  successCount: number;
  lastFailureTime: number;
  lastError?: string;
  rateLimitUntil?: number | null;
}

// Latest reachability probe telemetry per provider (in-memory on the server;
// empty after a restart until the next probe runs). Latency reflects the
// lightweight /models connectivity probe, not model generation time.
export interface ProviderProbeTelemetry {
  provider: string;
  latencyMs: number;
  status: 'healthy' | 'slow' | 'error' | 'timeout';
  isSlow: boolean;
  errorKind?: 'timeout' | 'network' | 'http';
  errorMessage?: string;
  lastProbeAt: number;
  lastSuccessAt?: number;
  source: 'health' | 'manual' | 'rate-limit-headers';
}

export interface ProviderHealthResponse {
  states: ProviderHealthState[];
  /** Optional for backwards compatibility with older servers. */
  probes?: ProviderProbeTelemetry[];
  timestamp: string;
}

// ===== Gemini subscription (Antigravity OAuth) provider =====

// v1 supports the Antigravity installed-app OAuth only.
export type GeminiOauthKind = "antigravity";

/** Installed provider-plugin manifest entry (GET /api/plugins). */
export interface PluginInfo {
  name: string;
  version: string | null;
  enabled: boolean;
  cardUrl?: string;
  locales?: Record<string, Record<string, unknown>>;
  error?: string;
}

/** Installable catalog entry (GET /api/plugins/catalog). */
export interface PluginMarketCatalogEntry {
  name: string;
  description: string;
  version: string;
  installed: boolean;
  installedVersion: string | null;
}

/** Why the account cannot serve requests; codes are stable and localised. */
export type GeminiOauthErrorCode =
  | "gemini_oauth_identity_blocked"
  | "gemini_oauth_validation_required"
  | "gemini_oauth_quota_exceeded"
  | "gemini_oauth_reauth_required"
  | "gemini_oauth_upstream_error"
  | "gemini_oauth_not_connected"
  | "gemini_oauth_login_busy"
  | "gemini_oauth_name_conflict"
  | "gemini_oauth_login_state_rejected"
  | "gemini_oauth_login_account_failed"
  | "gemini_oauth_login_persist_failed"
  | "gemini_oauth_models_fetch_failed"
  | "gemini_oauth_config_write_failed"
  | "request_failed";

export interface GeminiOauthError {
  code: GeminiOauthErrorCode;
  // Server-side safe text only; token material never crosses this boundary.
  message?: string | null;
  // Present for VALIDATION_REQUIRED: the official appeal/verification link.
  validationUrl?: string | null;
}

/** GET /api/gemini-oauth/status — never carries token material. */
export interface GeminiOauthStatusResponse {
  configured: boolean;
  connected: boolean;
  kind: GeminiOauthKind;
  email?: string | null;
  project?: string | null;
  tier?: string | null;
  modelsCount?: number;
  lastError?: GeminiOauthError | null;
  // Epoch ms until which the account is parked after an upstream signal.
  cooldownUntil?: number | null;
}

/** POST /api/gemini-oauth/login/start */
export interface GeminiOauthLoginStartResponse {
  loginId: string;
  url: string;
  expiresAt: number;
}

/** POST /api/gemini-oauth/login/poll */
export type GeminiOauthLoginPollResponse =
  | { status: "pending" }
  | { status: "success"; email?: string | null }
  | { status: "failed"; error?: GeminiOauthErrorCode | null };

/** POST /api/gemini-oauth/sync — a failure keeps the previous model list. */
export interface GeminiOauthSyncResponse {
  ok: boolean;
  modelsCount?: number;
  clearedRefs?: string[];
  error?: GeminiOauthErrorCode | string | null;
}

/** POST /api/gemini-oauth/disconnect — Router paths are display labels only. */
export interface GeminiOauthDisconnectResponse {
  ok: boolean;
  removedModelRefs?: string[];
  defaultFallback?: string | null;
}

export interface ManualProbeResponse {
  provider: string;
  success: boolean;
  latencyMs?: number;
  status?: ProviderProbeTelemetry['status'];
  isSlow?: boolean;
  errorKind?: ProviderProbeTelemetry['errorKind'] | null;
  error?: string;
  timestamp: string;
}

// Provider quota configuration (optional)
export interface ProviderQuotaConfig {
  // Token limit for last 5 hours window
  limit5h?: number;
  // Token limit for last 7 days window
  limit7d?: number;
}

// Provider quota usage response from server
export interface ProviderQuotaUsage {
  provider: string;
  used5h: number;
  used7d: number;
  limit5h?: number;
  limit7d?: number;
  reset5h?: string;
  reset7d?: string;
  /** Display type for the 5h slot */
  type5h?: 'rateLimit' | 'balance';
  /** Display type for the 7d slot */
  type7d?: 'rateLimit' | 'balance';
  /** Currency for balance display (e.g. "CNY", "USD") */
  currency?: string;
}

export interface ProviderQuotaResponse {
  quotas: ProviderQuotaUsage[];
  timestamp: string;
}
