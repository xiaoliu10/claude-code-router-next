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
  // Thinking level injected when the client sends no thinking config
  // ("low" | "medium" | "high"; unset/empty = follow the client).
  default_thinking_level?: string;
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
  /** Which clients (Claude Code, pi) currently route this project through ccr. */
  ccrTakeoverClients?: ClientId[];
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
