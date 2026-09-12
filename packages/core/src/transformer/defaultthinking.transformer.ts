import { UnifiedChatRequest } from "@/types/llm";
import { Transformer, TransformerOptions } from "../types/transformer";

export type DefaultThinkingLevel = "none" | "low" | "medium" | "high";

type EndpointKind = "anthropic" | "responses" | "chat";

/**
 * Resolve the provider's upstream endpoint kind from its base URL so the
 * default thinking level can be expressed in the endpoint's native parameter.
 * Defaults to OpenAI-compatible chat completions, the most common shape.
 */
export function sniffEndpointKind(baseUrl?: string): EndpointKind {
  let pathname = "";
  try {
    pathname = new URL(String(baseUrl || "")).pathname.replace(/\/+$/, "");
  } catch {
    return "chat";
  }
  if (pathname.endsWith("/messages")) return "anthropic";
  if (pathname.endsWith("/responses")) return "responses";
  return "chat";
}

/**
 * DefaultThinkingTransformer
 *
 * Applies a provider-configured default thinking level when the client did
 * not express any thinking intent. Configured via the provider field
 * `default_thinking_level` (wired into the chain by ProviderService) or
 * directly as `["defaultthinking", { "level": "high" }]` in a transformer
 * `use` list.
 *
 * The level is converted to whatever parameter the provider's endpoint
 * speaks:
 * - Anthropic /v1/messages: unified `reasoning` (converted to the Anthropic
 *   `thinking` block by convertToAnthropic)
 * - OpenAI /v1/responses: unified `reasoning` (mapped to `reasoning.effort`
 *   by OpenAIResponsesTransformer)
 * - OpenAI-compatible /v1/chat/completions: `reasoning_effort`
 *
 * Client intent always wins: any defined `request.reasoning` — including an
 * explicit disabled — skips injection entirely. `level: "none"` (or an
 * unknown value) is a no-op, so the field can stay set in config while
 * effectively off.
 */
export class DefaultThinkingTransformer implements Transformer {
  static TransformerName = "defaultthinking";

  constructor(private readonly options?: TransformerOptions) {}

  async transformRequestIn(
    request: UnifiedChatRequest,
    provider?: any
  ): Promise<Record<string, any>> {
    const level = (this.options?.level ?? this.options?.value) as
      | DefaultThinkingLevel
      | undefined;
    if (!level || level === "none") return request;
    if (request.reasoning) return request;

    const kind = sniffEndpointKind(provider?.baseUrl);
    if (kind === "chat") {
      (request as any).reasoning_effort = level;
    } else {
      // anthropic and responses endpoints both consume the unified shape
      request.reasoning = { enabled: true, effort: level };
    }
    return request;
  }
}
