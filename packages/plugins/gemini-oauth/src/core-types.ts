/**
 * Minimal structural types for the surfaces the plugin shares with the core
 * (transformer contract, unified chat request). The plugin is
 * build-isolated on purpose: it must never import core runtime modules, and
 * keeping its own structural types means the bundle carries no core type
 * dependency. Shapes are behavioural subsets — core assigns these objects
 * role-free at runtime.
 */

/** The subset of core's UnifiedChatRequest the plugin reads or writes. */
export interface PluginUnifiedMessage {
  role: string;
  content: any;
  thinking?: any;
  tool_calls?: any[];
  [key: string]: any;
}

export interface PluginUnifiedChatRequest {
  model: string;
  messages: PluginUnifiedMessage[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  tool_choice?: any;
  tools?: any[];
  reasoning?: { effort?: string; max_tokens?: number };
  system?: any;
  [key: string]: any;
}

/** The transformer context slice the pipeline hands the plugin (open object). */
export interface PluginTransformerContext {
  req?: { body?: any; id?: string | number; [key: string]: any };
  [key: string]: any;
}

/**
 * Core transformer contract (structural subset of core's Transformer). The
 * plugin only contributes classes with a name and the two hooks it uses.
 */
export interface PluginTransformer {
  name: string;
  logger?: any;
  transformRequestIn?(
    request: PluginUnifiedChatRequest,
    provider: any,
    context?: PluginTransformerContext
  ): Promise<Record<string, any> | any>;
  transformResponseOut?(response: Response, context?: PluginTransformerContext): Promise<Response>;
}

// ---------------------------------------------------------------------------
// Structural mirrors of the provider-plugin API (packages/core/src/
// provider-plugins/types.ts). The plugin compiles without reaching into the
// core tree; these stay compatible by construction — the loader only calls
// the activate() signature and reads the manifest.
// ---------------------------------------------------------------------------

/** A classified upstream error, shared shape across providers (contract §1.6). */
export interface PluginClassifiedError {
  code: string;
  message: string;
  httpStatus: number;
  cooldownMs?: number;
  validationUrl?: string;
  retryable?: boolean;
}

/** Host capabilities handed to a plugin at activation (structural mirror). */
export interface PluginHostCapabilities {
  configDir: string;
  readConfig(): Promise<any>;
  writeConfig(next: any): Promise<void>;
  readRawConfig?(): Promise<any>;
  reloadRuntime(config?: any): Promise<void>;
  getDirectDispatcher(): unknown;
}

/** Managed-subscription semantics contributed by this plugin (structural mirror). */
export interface ManagedRuntime {
  name: string;
  isManaged(provider: any): boolean;
  ensureUsable?(): Promise<void>;
  lockUpstream?(config: any, provider: any): Promise<void>;
  signRequest(input: {
    headers: Record<string, string>;
    requestBody: any;
    provider: any;
  }): Promise<Record<string, string>>;
  classifyError?(status: number, body: unknown, systemText: string): PluginClassifiedError | null;
  noteUpstreamError?(info: PluginClassifiedError): Promise<void>;
  authRefresh?: {
    forceRefresh(): Promise<void>;
  };
  suppressDebugLog?: boolean;
}

/** The activation context (structural mirror of core's PluginContext). */
export interface PluginContext {
  readonly manifest: { name: string; version: string; coreApi: string; description?: string };
  readonly log: {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
  };
  readonly host: PluginHostCapabilities;
  registerTransformer(cls: new () => any): void;
  registerManagedRuntime(rt: ManagedRuntime): void;
  registerAdminRoutes(fn: (app: any) => void): void;
  registerConfigProtector(fn: (next: any, prev: any) => void): void;
  registerUiCard(def: { cardPath: string }): void;
  registerLocales(bundle: Record<string, Record<string, unknown>>): void;
}
