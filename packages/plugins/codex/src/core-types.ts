/**
 * Minimal structural types for the surfaces the Codex plugin shares with the
 * core (transformer contract, unified chat request). Kept local and
 * build-isolated: the plugin must never import core runtime modules, so it
 * carries its own behavioural subsets and only TYPE-imports the canonical API.
 *
 * INTEGRATION NOTE (data lane → D): this file is a type-only seam authored by
 * the data lane because no scaffolding existed. D owns the package tsconfig and
 * may relocate/reuse it; the canonical API types below must stay type-only.
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
  reasoning?: { effort?: string; max_tokens?: number; summary?: string };
  system?: any;
  [key: string]: any;
}

/** The transformer context slice the pipeline hands the plugin (open object). */
export interface PluginTransformerContext {
  req?: { body?: any; headers?: any; id?: string | number; clientContext?: any; [key: string]: any };
  [key: string]: any;
}

/** Core transformer contract (structural subset of core's Transformer). */
export interface PluginTransformer {
  name: string;
  logger?: any;
  auth?(request: any, provider: any, context?: PluginTransformerContext): Promise<any>;
  transformRequestIn?(
    request: PluginUnifiedChatRequest,
    provider?: any,
    context?: PluginTransformerContext
  ): Promise<Record<string, any> | any>;
  transformResponseOut?(response: Response, context?: PluginTransformerContext): Promise<Response>;
}

// Canonical core API types are TYPE-ONLY (erased at build; no host runtime
// module enters the bundle). Do not fork this public contract.
export type {
  PluginContext, PluginHostCapabilities, ManagedRuntime, PluginClassifiedError,
} from "../../../core/src/provider-plugins/types";
