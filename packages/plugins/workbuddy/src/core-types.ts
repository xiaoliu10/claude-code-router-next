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
 * plugin only contributes classes with a name and the hooks it uses.
 */
export interface PluginTransformer {
  name: string;
  logger?: any;
  auth?(request: any, provider: any, context?: PluginTransformerContext): Promise<any>;
  transformRequestIn?(
    request: PluginUnifiedChatRequest,
    provider: any,
    context?: PluginTransformerContext
  ): Promise<Record<string, any> | any>;
  transformResponseOut?(response: Response, context?: PluginTransformerContext): Promise<Response>;
}

// Consume the canonical core API types (erased by esbuild — no host runtime
// modules enter the plugin bundle). Do not fork this public contract.
export type {
  PluginContext, PluginHostCapabilities, ManagedRuntime, PluginClassifiedError,
} from "../../../core/src/provider-plugins/types";
