import type { FastifyInstance } from "fastify";
import type { LLMProvider } from "../types/llm";

/**
 * Provider plugin API (docs/design/provider-plugins.md).
 *
 * A plugin ships subscription-provider code out of the main package: a
 * transformer, a managed runtime (upstream lock, token injection, error
 * taxonomy), admin routes, a config protector and a UI card. The core only
 * knows this interface — never the provider internals.
 *
 * Lives in `src/provider-plugins/` deliberately: `src/plugins/` is the older
 * output-plugin system (token-speed) and must not mix namespaces.
 *
 * `coreApi` is a semver-ish compatibility marker. The core refuses plugins
 * whose major does not match its own, so the public contract can evolve
 * without silently breaking third parties.
 */
export const PLUGIN_CORE_API = "1";

export interface PluginManifest {
  name: string;
  version: string;
  coreApi: string;
  description?: string;
}

/** A classified upstream error, shared shape across providers (contract §1.6). */
export interface PluginClassifiedError {
  code: string;
  message: string;
  httpStatus: number;
  cooldownMs?: number;
  validationUrl?: string;
  retryable?: boolean;
}

/**
 * Input for a runtime-owned bounded dispatch wrapper (`dispatchRequest`). The
 * core supplies its ordinary single-attempt dispatch as `attempt()` — every
 * generic seam (ensureUsable/lockUpstream/signRequest/classifyError/
 * noteUpstreamError, the 401-once refresh budget, response-error
 * confidentiality) runs INSIDE each attempt; the wrapper only owns the loop
 * around it (e.g. rotating local credentials). The generic same-model retry
 * and fallback chains stay in the core and are never re-implemented by a
 * wrapper.
 */
export interface PluginDispatchInput {
  /** One ordinary core dispatch attempt. May be called several times, always
   *  within the runtime's own hard bound (≤ its credential count and ≤ a
   *  constant cap). */
  attempt(): Promise<Response>;
  /** Finalized request body (body-derived account selection works). */
  requestBody: any;
  /** The per-provider request config; a wrapper may attach per-attempt state
   *  that lockUpstream/signRequest read back on the same object. */
  config: any;
  provider: LLMProvider;
  /** The originating request object (shared identity across retry/fallback
   *  spreads) for per-request wrapper state. */
  req?: any;
}

/**
 * Managed-subscription semantics for one provider family. Everything the data
 * plane needs to talk to a subscription upstream without the core knowing it:
 * fixed upstream, token injection, error taxonomy, cooling circuit breaker.
 */
export interface ManagedRuntime {
  /** Provider family name, e.g. "codex". Used for logging and 401 bookkeeping keys. */
  name: string;
  isManaged(provider: LLMProvider): boolean;
  /** Circuit breaker before any network touch (Gemini lesson: must run BEFORE token refresh). */
  ensureUsable?(): Promise<void>;
  /** Lock the upstream: mutate config.url / redirect / dispatcher. Runs once per attempt. */
  lockUpstream?(config: any, provider: LLMProvider): Promise<void>;
  /**
   * Final header injection — called AFTER the request body is finalized, so
   * body-derived headers (e.g. Codex session-id from prompt_cache_key) work.
   * Returns the headers object to send. `config` is the per-attempt request
   * config (optional for backward compatibility): a dispatch wrapper can
   * select per-attempt credential material on it and the final header
   * injection reads it back; hosts that predate the field leave wrappers to
   * their own lockUpstream-saved state.
   */
  signRequest(input: {
    headers: Record<string, string>;
    requestBody: any;
    provider: LLMProvider;
    config?: any;
  }): Promise<Record<string, string>>;
  /**
   * Classify an upstream failure into the shared taxonomy. Return null to let
   * the next handler (built-in branches, then generic) deal with it.
   */
  classifyError?(status: number, body: unknown, systemText: string): PluginClassifiedError | null;
  /** Persist a classified error (cooldown, lastError). Must never throw into the response path. */
  noteUpstreamError?(info: PluginClassifiedError): Promise<void>;
  /**
   * Generic HTTP-200 hidden-error-envelope detector. When present, the core
   * runs it against every parsed JSON 200 body and throws through the shared
   * classification seam when it returns true — BEFORE the generic `error`
   * field check, because some upstreams carry `{code,msg,data}` envelopes
   * without an `error` key. This is a SECONDARY safety net for runtimes with
   * a dispatch wrapper: rotation on such envelopes must happen inside the
   * wrapper (before the response is returned); this hook only catches bodies
   * a wrapper has already returned.
   */
  isErrorEnvelope?(body: unknown): boolean;
  /**
   * Optional bounded multi-attempt dispatcher (see PluginDispatchInput). When
   * present the core calls it instead of performing its single attempt and
   * forwards the returned response to the client. The wrapper MUST enforce a
   * hard attempt bound and must never swallow client aborts.
   */
  dispatchRequest?(input: PluginDispatchInput): Promise<Response>;
  /**
   * Opt-in 401 handling: when set, the core performs ONE forced refresh and
   * re-dispatch on 401 before classifying. `refresh` must persist rotated
   * refresh tokens before the in-memory identity switches.
   */
  authRefresh?: {
    forceRefresh(): Promise<void>;
  };
  /** Suppress the request/response debug logs for this provider (token hygiene). */
  suppressDebugLog?: boolean;
}

/**
 * Host capabilities handed to a plugin at activation. Plugins must use THESE
 * for anything stateful (config reads/writes, runtime reload, directories) —
 * bundling a copy of a core module would fork its in-process state.
 */
export interface PluginHostCapabilities {
  /** CCR config dir ($CCR_CONFIG_DIR), for the plugin's private credential file. */
  configDir: string;
  readConfig(): Promise<any>;
  writeConfig(next: any): Promise<void>;
  /**
   * Read config WITHOUT env-var interpolation. Managed providers must do their
   * read-modify-write against this: `readConfig` interpolates $VAR placeholders,
   * so writing it back would bake env values into config.json. Optional for
   * backward compatibility; hosts that predate it only offer `readConfig`.
   */
  readRawConfig?(): Promise<any>;
  /**
   * Re-resolve providers/transformers after a config write (server reload).
   * The config argument is the JUST-WRITTEN config; passing it avoids a reread
   * race between write and reload. Optional parameter for backward compat.
   */
  reloadRuntime(config?: any): Promise<void>;
  /** undici Agent that bypasses CCR/proxy env routing (for fixed subscription origins). */
  getDirectDispatcher(): unknown;
}

export interface PluginContext {
  readonly manifest: PluginManifest;
  readonly log: {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
  };
  readonly host: PluginHostCapabilities;
  registerTransformer(cls: new () => any): void;
  registerManagedRuntime(rt: ManagedRuntime): void;
  registerAdminRoutes(fn: (app: FastifyInstance) => void): void;
  registerConfigProtector(fn: (next: any, prev: any) => void): void;
  /** Path to the prebuilt card chunk, relative to the plugin directory. */
  registerUiCard(def: { cardPath: string }): void;
  registerLocales(bundle: Record<string, Record<string, unknown>>): void;
}

export interface LoadedPluginInfo {
  name: string;
  version: string;
  enabled: true;
  /** Served by the core at this URL for the UI to dynamic-import. */
  cardUrl?: string;
  locales?: Record<string, Record<string, unknown>>;
  error?: string;
}
