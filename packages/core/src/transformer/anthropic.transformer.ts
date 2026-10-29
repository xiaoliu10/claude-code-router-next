import { ChatCompletion } from "openai/resources";
import {
  LLMProvider,
  UnifiedChatRequest,
  UnifiedMessage,
  UnifiedTool,
} from "@/types/llm";
import {
  Transformer,
  TransformerContext,
  TransformerOptions,
} from "@/types/transformer";
import { v4 as uuidv4 } from "uuid";
import { getThinkLevel, normalizeEffort } from "@/utils/thinking";
import { createApiError } from "@/api/middleware";
import {
  parseResponseJson,
  peekBodyForSSE,
  readBodyForSSE,
} from "./response-body";
import { formatBase64 } from "@/utils/image";
import { convertToAnthropic } from "@/utils/converter";
import { modelSupportsImages } from "@/utils/router";

/**
 * Read a client's thinking switch. "adaptive" and boolean true both mean the
 * model gets to decide (upstream treats them as enabled) — only an explicit
 * off value counts as disabled. Undefined means the client expressed no
 * preference, so the provider's configured default still applies.
 */
function isThinkingEnabled(type: unknown): boolean | undefined {
  if (type === true) return true;
  if (type === false) return false;
  if (typeof type !== "string") return undefined;
  const value = type.trim().toLowerCase();
  if (value === "enabled" || value === "adaptive" || value === "true") return true;
  if (value === "disabled" || value === "off" || value === "none" || value === "false") {
    return false;
  }
  return undefined;
}

export class AnthropicTransformer implements Transformer {
  name = "Anthropic";
  endPoint = "/v1/messages";
  private useBearer: boolean;
  logger?: any;

  constructor(private readonly options?: TransformerOptions) {
    this.useBearer = this.options?.UseBearer ?? false;
  }

  async auth(request: any, provider: LLMProvider): Promise<any> {
    const headers: Record<string, string | undefined> = {};

    if (this.useBearer) {
      headers["authorization"] = `Bearer ${provider.apiKey}`;
      headers["x-api-key"] = undefined;
    } else {
      headers["x-api-key"] = provider.apiKey;
      headers["authorization"] = undefined;
    }

    return {
      body: request,
      config: {
        headers,
      },
    };
  }

  async transformRequestOut(
    request: Record<string, any>
  ): Promise<UnifiedChatRequest> {
    const messages: UnifiedMessage[] = [];

    if (request.system) {
      if (typeof request.system === "string") {
        messages.push({
          role: "system",
          content: request.system,
        });
      } else if (Array.isArray(request.system) && request.system.length) {
        const textParts = request.system
          .filter((item: any) => item.type === "text" && item.text)
          .map((item: any) => ({
            type: "text" as const,
            text: item.text,
            cache_control: item.cache_control,
          }));
        messages.push({
          role: "system",
          content: textParts,
        });
      }
    }

    const requestMessages = JSON.parse(JSON.stringify(request.messages || []));

    // First pass: push all system messages to ensure they come before user/assistant.
    // DeepSeek + vLLM require [system, user] order; wrong order causes garbled output.
    requestMessages?.forEach((msg: any) => {
      if (msg.role === "system") {
        messages.push({
          role: "system",
          content: msg.content,
        });
      }
    });

    // Second pass: push user/assistant/tool messages in original order
    requestMessages?.forEach((msg: any) => {
      if (msg.role === "system") {
        return; // Already handled in first pass
      }

      if (msg.role === "user" || msg.role === "assistant") {
        if (typeof msg.content === "string") {
          messages.push({
            role: msg.role,
            content: msg.content,
          });
          return;
        }

        if (Array.isArray(msg.content)) {
          if (msg.role === "user") {
            const toolParts = msg.content.filter(
              (c: any) => c.type === "tool_result" && c.tool_use_id
            );
            if (toolParts.length) {
              // Images inside tool_result are vision input, not text. Flattening
              // the whole content array with JSON.stringify turned every
              // screenshot's base64 into plain text (a 480KB PNG ≈ 340k tokens).
              const allowImages = modelSupportsImages(String(request.model ?? ""));
              const toolResultImages: any[] = [];
              toolParts.forEach((tool: any) => {
                const contentParts = Array.isArray(tool.content) ? tool.content : null;
                const imageParts = contentParts
                  ? contentParts.filter((part: any) => part?.type === "image" && part?.source)
                  : [];
                let toolContent: any =
                  typeof tool.content === "string"
                    ? tool.content
                    : JSON.stringify(tool.content);
                if (imageParts.length > 0) {
                  const remainingText = contentParts!
                    .filter((part: any) => !(part?.type === "image" && part?.source))
                    .map((part: any) =>
                      part?.type === "text" ? String(part.text ?? "") : JSON.stringify(part)
                    )
                    .filter((text: string) => text.length > 0)
                    .join("\n");
                  if (allowImages) {
                    // function_call_output.output is documented as the tool's
                    // output string — an empty string is fragile upstream.
                    toolContent = remainingText || "[tool image]";
                    toolResultImages.push(...imageParts);
                  } else {
                    toolContent = [
                      remainingText,
                      ...imageParts.map(
                        () => "(tool image omitted: target model does not support image input)"
                      ),
                    ]
                      .filter((text: string) => text.length > 0)
                      .join("\n");
                    this.logger?.debug?.({
                      type: "tool_image_omitted",
                      model: String(request.model ?? ""),
                      count: imageParts.length,
                    });
                  }
                }
                const toolMessage: UnifiedMessage = {
                  role: "tool",
                  content: toolContent,
                  tool_call_id: tool.tool_use_id,
                  cache_control: tool.cache_control,
                };
                messages.push(toolMessage);
              });
              // ONE image message after ALL tool messages: a per-tool user
              // message would split the tool-result group away from the
              // assistant tool_calls turn in the Responses/Chat wire shapes.
              if (toolResultImages.length > 0) {
                messages.push({
                  role: "user",
                  content: toolResultImages.map((part: any) => ({
                    type: "image_url",
                    image_url: {
                      url:
                        part.source?.type === "base64"
                          ? formatBase64(part.source.data, part.source.media_type)
                          : part.source.url,
                    },
                    media_type: part.source.media_type,
                  })),
                });
              }
            }

            const textAndMediaParts = msg.content.filter(
              (c: any) =>
                (c.type === "text" && c.text) ||
                (c.type === "image" && c.source)
            );
            if (textAndMediaParts.length) {
              messages.push({
                role: "user",
                content: textAndMediaParts.map((part: any) => {
                  if (part?.type === "image") {
                    return {
                      type: "image_url",
                      image_url: {
                        url:
                          part.source?.type === "base64"
                            ? formatBase64(
                                part.source.data,
                                part.source.media_type
                              )
                            : part.source.url,
                      },
                      media_type: part.source.media_type,
                    };
                  }
                  return part;
                }),
              });
            }
          } else if (msg.role === "assistant") {
            const assistantMessage: UnifiedMessage = {
              role: "assistant",
              content: "",
            };
            const textParts = msg.content.filter(
              (c: any) => c.type === "text" && c.text
            );
            if (textParts.length) {
              assistantMessage.content = textParts
                .map((text: any) => text.text)
                .join("\n");
            }

            const toolCallParts = msg.content.filter(
              (c: any) => c.type === "tool_use" && c.id
            );
            if (toolCallParts.length) {
              assistantMessage.tool_calls = toolCallParts.map((tool: any) => {
                return {
                  id: tool.id,
                  type: "function" as const,
                  function: {
                    name: tool.name,
                    arguments: JSON.stringify(tool.input || {}),
                  },
                };
              });
            }

            const thinkingPart = msg.content.find(
              (c: any) => c.type === "thinking"
            );
            if (thinkingPart) {
              assistantMessage.thinking = {
                content: thinkingPart.thinking,
                signature: thinkingPart.signature,
              };
            }

            messages.push(assistantMessage);
          }
          return;
        }
      }
    });

    const result: UnifiedChatRequest = {
      messages,
      model: request.model,
      max_tokens: request.max_tokens,
      temperature: request.temperature,
      stream: request.stream,
      tools: request.tools?.length
        ? this.convertAnthropicToolsToUnified(request.tools)
        : undefined,
      tool_choice: request.tool_choice,
    };
    // Thinking intent reaches us in three shapes: a token budget (budget-era
    // clients), `output_config.effort` (what current Claude Code sends), and
    // an adaptive thinking switch. All three are preserved — an explicit
    // effort wins over the budget, which wins over a bare switch — because
    // dropping the effort silently forced every provider onto its own default
    // tier. Recognition of "adaptive"/true also matters: a client that stopped
    // sending a budget used to parse as thinking-disabled and lose thinking
    // entirely on Anthropic-endpoint providers.
    const effortOverride = normalizeEffort(request.output_config?.effort);
    const budgetTokens =
      typeof request.thinking?.budget_tokens === "number"
        ? request.thinking.budget_tokens
        : undefined;
    if (request.thinking !== undefined || effortOverride !== undefined) {
      const reasoning: NonNullable<UnifiedChatRequest["reasoning"]> = {};
      const enabled = isThinkingEnabled(request.thinking?.type);
      const impliedEnabled =
        enabled ?? (effortOverride !== undefined || (budgetTokens ?? 0) > 0);
      if (impliedEnabled !== undefined) reasoning.enabled = impliedEnabled;
      if (effortOverride !== undefined) {
        reasoning.effort = effortOverride;
      } else if (budgetTokens !== undefined) {
        reasoning.effort = getThinkLevel(budgetTokens);
      }
      if (budgetTokens !== undefined && budgetTokens > 0) {
        reasoning.max_tokens = budgetTokens;
      }
      if (Object.keys(reasoning).length > 0) result.reasoning = reasoning;
    }
    if (request.tool_choice) {
      if (request.tool_choice.type === "tool") {
        result.tool_choice = {
          type: "function",
          function: { name: request.tool_choice.name },
        };
      } else {
        result.tool_choice = request.tool_choice.type;
      }
    }
    return result;
  }

  async transformRequestIn(
    request: UnifiedChatRequest,
    provider: LLMProvider,
    context: TransformerContext
  ): Promise<any> {
    if (!this.isAnthropicMessagesEndpoint(provider.baseUrl)) {
      return request;
    }

    if (context && context.req) {
      context.req.isTargetAnthropic = true;
    }
    const body = convertToAnthropic(request);

    const headers: Record<string, string | undefined> = {};
    if (this.useBearer) {
      headers["authorization"] = `Bearer ${provider.apiKey}`;
      headers["x-api-key"] = undefined;
    } else {
      headers["x-api-key"] = provider.apiKey;
      headers["authorization"] = undefined;
    }
    headers["anthropic-version"] = "2023-06-01";
    headers["content-type"] = "application/json";

    return {
      body,
      config: {
        headers,
      },
    };
  }

  private isAnthropicMessagesEndpoint(baseUrl: string): boolean {
    try {
      const url = new URL(baseUrl.trim());
      const pathname = url.pathname.replace(/\/+$/, "");
      return pathname.endsWith("/messages");
    } catch {
      return false;
    }
  }

  async transformResponseIn(
    response: Response,
    context?: TransformerContext
  ): Promise<Response> {
    if (context?.req?.isTargetAnthropic) {
      return response;
    }
    const isStream = response.headers
      .get("Content-Type")
      ?.includes("text/event-stream");
    if (isStream) {
      if (!response.body) {
        throw new Error("Stream response body is null");
      }
      const convertedStream = await this.convertOpenAIStreamToAnthropic(
        response.body,
        context!
      );
      return new Response(convertedStream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    } else {
      // Some upstreams (Codex relay, OpenRouter error responses) label an SSE
      // body with an application/json Content-Type. Parse would throw on the
      // leading "event:" / ": OPENROUTER PROCESSING" line. Peek the body: if it
      // actually looks like an SSE stream, route it through the stream
      // converter instead of failing.
      const peeked = await peekBodyForSSE(response);
      const bodyIsSSE = peeked?.isSSE ?? false;
      if (bodyIsSSE && peeked?.body) {
        const convertedStream = await this.convertOpenAIStreamToAnthropic(
          peeked.body,
          context!
        );
        return new Response(convertedStream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      }
      // Reconstruct a Response with the unread body so parseResponseJson can
      // consume it (peek already drained the original body). When peek could
      // not run (body absent/locked), drain the full body as text and
      // reclassify — an SSE body mislabeled as JSON still needs the stream
      // path in that case.
      let textResponse: Response;
      if (peeked?.body) {
        textResponse = new Response(peeked.body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } else {
        const drained = await readBodyForSSE(response);
        if (drained.isSSE) {
          const convertedStream = await this.convertOpenAIStreamToAnthropic(
            drained.response.body!,
            context!
          );
          return new Response(convertedStream, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            },
          });
        }
        textResponse = drained.response;
      }
      const data = (await parseResponseJson(textResponse)) as any;
      const anthropicResponse = this.convertOpenAIResponseToAnthropic(
        data,
        context!
      );
      return new Response(JSON.stringify(anthropicResponse), {
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  private convertAnthropicToolsToUnified(tools: any[]): UnifiedTool[] {
    return tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description || "",
        parameters: tool.input_schema,
      },
    }));
  }

  private async convertOpenAIStreamToAnthropic(
    openaiStream: ReadableStream,
    context: TransformerContext
  ): Promise<ReadableStream> {
    const readable = new ReadableStream({
      start: async (controller) => {
        const encoder = new TextEncoder();
        const messageId = `msg_${Date.now()}`;
        let stopReasonMessageDelta: null | Record<string, any> = null;
        let model = "unknown";
        let hasStarted = false;
        let hasTextContentStarted = false;
        let hasFinished = false;
        const toolCalls = new Map<number, any>();
        const toolCallIndexToContentBlockIndex = new Map<number, number>();
        let totalChunks = 0;
        let contentChunks = 0;
        let toolCallChunks = 0;
        let isClosed = false;
        let isThinkingStarted = false;
        let contentIndex = 0;
        let currentContentBlockIndex = -1; // Track the current content block index

        // 原子性的content block index分配函数
        const assignContentBlockIndex = (): number => {
          const currentIndex = contentIndex;
          contentIndex++;
          return currentIndex;
        };

        const safeEnqueue = (data: Uint8Array) => {
          if (!isClosed) {
            try {
              controller.enqueue(data);
              const dataStr = new TextDecoder().decode(data);
              this.logger.debug({
                reqId: context.req.id,
                data: dataStr,
                type: "send data",
              });
            } catch (error) {
              if (
                error instanceof TypeError &&
                error.message.includes("Controller is already closed")
              ) {
                isClosed = true;
              } else {
                this.logger.debug({
                  reqId: context.req.id,
                  error: error instanceof Error ? error.message : String(error),
                  type: "send data error",
                });
                throw error;
              }
            }
          }
        };

        const safeClose = () => {
          if (!isClosed) {
            try {
              // If upstream produced no data (hasStarted is false), do NOT emit
              // partial/invalid SSE (message_delta + message_stop without message_start).
              // Instead, close silently so downstream detects done:true and triggers fallback.
              if (!hasStarted) {
                this.logger?.warn(
                  `[empty_stream] Upstream produced no data, closing silently`
                );
                controller.close();
                isClosed = true;
                return;
              }

              // Close any remaining open content block
              if (currentContentBlockIndex >= 0) {
                const contentBlockStop = {
                  type: "content_block_stop",
                  index: currentContentBlockIndex,
                };
                safeEnqueue(
                  encoder.encode(
                    `event: content_block_stop\ndata: ${JSON.stringify(
                      contentBlockStop
                    )}\n\n`
                  )
                );
                currentContentBlockIndex = -1;
              }

              if (stopReasonMessageDelta) {
                safeEnqueue(
                  encoder.encode(
                    `event: message_delta\ndata: ${JSON.stringify(
                      stopReasonMessageDelta
                    )}\n\n`
                  )
                );
                stopReasonMessageDelta = null;
              } else {
                // Fallback message_delta when upstream didn't provide usage data.
                // Use estimated input tokens so Claude Code context tracking isn't zeroed.
                const estimatedInputTokens = context?.req?.tokenCount || 0;
                safeEnqueue(
                  encoder.encode(
                    `event: message_delta\ndata: ${JSON.stringify({
                      type: "message_delta",
                      delta: {
                        stop_reason: "end_turn",
                        stop_sequence: null,
                      },
                      usage: {
                        input_tokens: estimatedInputTokens,
                        output_tokens: 0,
                        cache_read_input_tokens: 0,
                      },
                    })}\n\n`
                  )
                );
              }
              const messageStop = {
                type: "message_stop",
              };
              safeEnqueue(
                encoder.encode(
                  `event: message_stop\ndata: ${JSON.stringify(
                    messageStop
                  )}\n\n`
                )
              );
              controller.close();
              isClosed = true;
            } catch (error) {
              if (
                error instanceof TypeError &&
                error.message.includes("Controller is already closed")
              ) {
                isClosed = true;
              } else {
                throw error;
              }
            }
          }
        };

        let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

        try {
          reader = openaiStream.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          while (true) {
            if (isClosed) {
              break;
            }

            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              // NOTE: do NOT break on hasFinished here. Some OpenAI-compatible
              // upstreams (e.g. fireworks-hosted GLM-5.2) emit the real usage in
              // a `choices: []` chunk AFTER the finish_reason chunk. Breaking on
              // hasFinished would discard that trailing usage chunk. Content
              // generation paths below are individually guarded by `!hasFinished`,
              // so letting the loop continue only allows the `if (chunk.usage)`
              // merge to pick up the trailing usage — it cannot re-emit content.
              if (isClosed) break;

              if (!line.startsWith("data:")) continue;
              const data = line.slice(5).trim();
              this.logger.debug({
                reqId: context.req.id,
                type: "recieved data",
                data,
              });

              if (data === "[DONE]") {
                continue;
              }

              try {
                const chunk = JSON.parse(data);
                totalChunks++;
                this.logger.debug({
                  reqId: context.req.id,
                  response: chunk,
                  tppe: "Original Response",
                });
                if (chunk.error) {
                  // Mark SSE error on request for usage tracking
                  if (context?.req) {
                    context.req.sseError = chunk.error;
                  }
                  const errorMessage = {
                    type: "error",
                    message: {
                      type: "api_error",
                      message: JSON.stringify(chunk.error),
                    },
                  };

                  safeEnqueue(
                    encoder.encode(
                      `event: error\ndata: ${JSON.stringify(errorMessage)}\n\n`
                    )
                  );
                  continue;
                }

                model = chunk.model || model;

                if (!hasStarted && !isClosed && !hasFinished) {
                  hasStarted = true;

                  // Use pre-calculated token count from router (tiktoken estimate)
                  // so Claude Code can track context usage for auto-compression.
                  const estimatedInputTokens = context?.req?.tokenCount || 0;

                  const messageStart = {
                    type: "message_start",
                    message: {
                      id: messageId,
                      type: "message",
                      role: "assistant",
                      content: [],
                      model: model,
                      stop_reason: null,
                      stop_sequence: null,
                      usage: {
                        input_tokens: estimatedInputTokens,
                        output_tokens: 0,
                      },
                    },
                  };

                  safeEnqueue(
                    encoder.encode(
                      `event: message_start\ndata: ${JSON.stringify(
                        messageStart
                      )}\n\n`
                    )
                  );
                }

                const choice = chunk.choices?.[0];
                if (chunk.usage) {
                  // OpenAI-compatible upstreams report cache reads in either
                  // prompt_tokens_details.cached_tokens or the DeepSeek-style
                  // prompt_cache_hit_tokens; accept whichever is present.
                  const cachedTokens =
                    chunk.usage?.prompt_tokens_details?.cached_tokens ??
                    chunk.usage?.prompt_cache_hit_tokens ??
                    0;
                  const promptTokens = chunk.usage?.prompt_tokens || 0;
                  // Keep Anthropic protocol semantics for Claude Code: input_tokens is net of cache reads.
                  const inputTokens = promptTokens - cachedTokens;
                  const completionTokens = chunk.usage?.completion_tokens || 0;
                  this.logger?.info({
                    debug_log: true,
                    reqId: context.req.id,
                    phase: "anthropic_transformer_usage",
                    providerUsage: chunk.usage,
                    mappedUsage: {
                      input_tokens: inputTokens,
                      output_tokens: completionTokens,
                      cache_read_input_tokens: cachedTokens,
                    },
                    choicesLength: Array.isArray(chunk.choices) ? chunk.choices.length : undefined,
                    finishReason: choice?.finish_reason,
                  });
                  // Some OpenAI-compatible upstreams (e.g. fireworks-hosted GLM-5.2)
                  // report real usage on the first chunk but emit an all-zero usage
                  // object on the final/stop chunk. Overwriting the already-captured
                  // real usage with those zeros produced message_delta.usage of all
                  // zeros, which zeroed out the usage stats for the whole request.
                  // Merge field-by-field, only replacing a field when the incoming
                  // value is non-zero, so the real first-chunk usage survives a
                  // trailing all-zero usage frame.
                  const incomingUsage = {
                    input_tokens: inputTokens,
                    output_tokens: completionTokens,
                    cache_read_input_tokens: cachedTokens,
                  };
                  if (!stopReasonMessageDelta) {
                    stopReasonMessageDelta = {
                      type: "message_delta",
                      delta: {
                        stop_reason: "end_turn",
                        stop_sequence: null,
                      },
                      usage: { ...incomingUsage },
                    };
                  } else {
                    const prev = stopReasonMessageDelta.usage || {};
                    stopReasonMessageDelta.usage = {
                      input_tokens: incomingUsage.input_tokens || prev.input_tokens || 0,
                      output_tokens: incomingUsage.output_tokens || prev.output_tokens || 0,
                      cache_read_input_tokens:
                        incomingUsage.cache_read_input_tokens || prev.cache_read_input_tokens || 0,
                    };
                  }
                }
                if (!choice) {
                  continue;
                }

                if (choice?.delta?.thinking && !isClosed && !hasFinished) {
                  if (hasTextContentStarted) {
                    // Anthropic protocol requires thinking blocks to appear BEFORE any text blocks.
                    // Ignore late-arriving thinking blocks (e.g. from Gemini fake signatures).
                  } else {
                    if (!isThinkingStarted) {
                      const thinkingBlockIndex = assignContentBlockIndex();
                      const contentBlockStart = {
                        type: "content_block_start",
                        index: thinkingBlockIndex,
                        content_block: { type: "thinking", thinking: "" },
                      };
                      safeEnqueue(
                        encoder.encode(
                          `event: content_block_start\ndata: ${JSON.stringify(
                            contentBlockStart
                          )}\n\n`
                        )
                      );
                      currentContentBlockIndex = thinkingBlockIndex;
                      isThinkingStarted = true;
                    }
                    if (choice.delta.thinking.signature) {
                      const thinkingSignature = {
                        type: "content_block_delta",
                        index: currentContentBlockIndex,
                        delta: {
                          type: "signature_delta",
                          signature: choice.delta.thinking.signature,
                        },
                      };
                      safeEnqueue(
                        encoder.encode(
                          `event: content_block_delta\ndata: ${JSON.stringify(
                            thinkingSignature
                          )}\n\n`
                        )
                      );
                      const contentBlockStop = {
                        type: "content_block_stop",
                        index: currentContentBlockIndex,
                      };
                      safeEnqueue(
                        encoder.encode(
                          `event: content_block_stop\ndata: ${JSON.stringify(
                            contentBlockStop
                          )}\n\n`
                        )
                      );
                      currentContentBlockIndex = -1;
                    } else if (choice.delta.thinking.content) {
                      const thinkingChunk = {
                        type: "content_block_delta",
                        index: currentContentBlockIndex,
                        delta: {
                          type: "thinking_delta",
                          thinking: choice.delta.thinking.content || "",
                        },
                      };
                      safeEnqueue(
                        encoder.encode(
                          `event: content_block_delta\ndata: ${JSON.stringify(
                            thinkingChunk
                          )}\n\n`
                        )
                      );
                    }
                  }
                }

                if (choice?.delta?.content && !isClosed && !hasFinished) {
                  contentChunks++;

                  // Close any previous content block if open and it's not a text content block
                  if (currentContentBlockIndex >= 0) {
                    // Check if current content block is text type
                    const isCurrentTextBlock = hasTextContentStarted;
                    if (!isCurrentTextBlock) {
                      const contentBlockStop = {
                        type: "content_block_stop",
                        index: currentContentBlockIndex,
                      };
                      safeEnqueue(
                        encoder.encode(
                          `event: content_block_stop\ndata: ${JSON.stringify(
                            contentBlockStop
                          )}\n\n`
                        )
                      );
                      currentContentBlockIndex = -1;
                    }
                  }

                  if (!hasTextContentStarted && !hasFinished) {
                    hasTextContentStarted = true;
                    const textBlockIndex = assignContentBlockIndex();
                    const contentBlockStart = {
                      type: "content_block_start",
                      index: textBlockIndex,
                      content_block: {
                        type: "text",
                        text: "",
                      },
                    };
                    safeEnqueue(
                      encoder.encode(
                        `event: content_block_start\ndata: ${JSON.stringify(
                          contentBlockStart
                        )}\n\n`
                      )
                    );
                    currentContentBlockIndex = textBlockIndex;
                  }

                  if (!isClosed && !hasFinished) {
                    const anthropicChunk = {
                      type: "content_block_delta",
                      index: currentContentBlockIndex, // Use current content block index
                      delta: {
                        type: "text_delta",
                        text: choice.delta.content,
                      },
                    };
                    safeEnqueue(
                      encoder.encode(
                        `event: content_block_delta\ndata: ${JSON.stringify(
                          anthropicChunk
                        )}\n\n`
                      )
                    );
                  }
                }

                if (
                  choice?.delta?.annotations?.length &&
                  !isClosed &&
                  !hasFinished
                ) {
                  // Close text content block if open
                  if (currentContentBlockIndex >= 0 && hasTextContentStarted) {
                    const contentBlockStop = {
                      type: "content_block_stop",
                      index: currentContentBlockIndex,
                    };
                    safeEnqueue(
                      encoder.encode(
                        `event: content_block_stop\ndata: ${JSON.stringify(
                          contentBlockStop
                        )}\n\n`
                      )
                    );
                    currentContentBlockIndex = -1;
                    hasTextContentStarted = false;
                  }

                  choice?.delta?.annotations.forEach((annotation: any) => {
                    const annotationBlockIndex = assignContentBlockIndex();
                    const contentBlockStart = {
                      type: "content_block_start",
                      index: annotationBlockIndex,
                      content_block: {
                        type: "web_search_tool_result",
                        tool_use_id: `srvtoolu_${uuidv4()}`,
                        content: [
                          {
                            type: "web_search_result",
                            title: annotation.url_citation.title,
                            url: annotation.url_citation.url,
                          },
                        ],
                      },
                    };
                    safeEnqueue(
                      encoder.encode(
                        `event: content_block_start\ndata: ${JSON.stringify(
                          contentBlockStart
                        )}\n\n`
                      )
                    );

                    const contentBlockStop = {
                      type: "content_block_stop",
                      index: annotationBlockIndex,
                    };
                    safeEnqueue(
                      encoder.encode(
                        `event: content_block_stop\ndata: ${JSON.stringify(
                          contentBlockStop
                        )}\n\n`
                      )
                    );
                    currentContentBlockIndex = -1;
                  });
                }

                if (choice?.delta?.tool_calls && !isClosed && !hasFinished) {
                  toolCallChunks++;
                  const processedInThisChunk = new Set<number>();

                  for (const toolCall of choice.delta.tool_calls) {
                    if (isClosed) break;
                    const toolCallIndex = toolCall.index ?? 0;
                    if (processedInThisChunk.has(toolCallIndex)) {
                      continue;
                    }
                    processedInThisChunk.add(toolCallIndex);
                    const isUnknownIndex =
                      !toolCallIndexToContentBlockIndex.has(toolCallIndex);

                    if (isUnknownIndex) {
                      // Close any previous content block if open
                      if (currentContentBlockIndex >= 0) {
                        const contentBlockStop = {
                          type: "content_block_stop",
                          index: currentContentBlockIndex,
                        };
                        safeEnqueue(
                          encoder.encode(
                            `event: content_block_stop\ndata: ${JSON.stringify(
                              contentBlockStop
                            )}\n\n`
                          )
                        );
                        currentContentBlockIndex = -1;
                      }

                      const newContentBlockIndex = assignContentBlockIndex();
                      toolCallIndexToContentBlockIndex.set(
                        toolCallIndex,
                        newContentBlockIndex
                      );
                      const toolCallId =
                        toolCall.id || `call_ccr_${toolCallIndex}`;
                      const toolCallName =
                        toolCall.function?.name || `tool_${toolCallIndex}`;
                      const contentBlockStart = {
                        type: "content_block_start",
                        index: newContentBlockIndex,
                        content_block: {
                          type: "tool_use",
                          id: toolCallId,
                          name: toolCallName,
                          input: {},
                        },
                      };

                      safeEnqueue(
                        encoder.encode(
                          `event: content_block_start\ndata: ${JSON.stringify(
                            contentBlockStart
                          )}\n\n`
                        )
                      );
                      currentContentBlockIndex = newContentBlockIndex;

                      const toolCallInfo = {
                        id: toolCallId,
                        name: toolCallName,
                        arguments: "",
                        contentBlockIndex: newContentBlockIndex,
                      };
                      toolCalls.set(toolCallIndex, toolCallInfo);
                    } else if (toolCall.id && toolCall.function?.name) {
                      const existingToolCall = toolCalls.get(toolCallIndex)!;
                      const wasTemporary =
                        existingToolCall.id.startsWith("call_") &&
                        existingToolCall.name.startsWith("tool_");

                      if (wasTemporary) {
                        existingToolCall.id = toolCall.id;
                        existingToolCall.name = toolCall.function.name;
                      }
                    }

                    if (
                      toolCall.function?.arguments &&
                      !isClosed &&
                      !hasFinished
                    ) {
                      const blockIndex =
                        toolCallIndexToContentBlockIndex.get(toolCallIndex);
                      if (blockIndex === undefined) {
                        continue;
                      }
                      const currentToolCall = toolCalls.get(toolCallIndex);
                      if (currentToolCall) {
                        currentToolCall.arguments +=
                          toolCall.function.arguments;
                      }

                      try {
                        const anthropicChunk = {
                          type: "content_block_delta",
                          index: blockIndex,
                          delta: {
                            type: "input_json_delta",
                            partial_json: toolCall.function.arguments,
                          },
                        };
                        safeEnqueue(
                          encoder.encode(
                            `event: content_block_delta\ndata: ${JSON.stringify(
                              anthropicChunk
                            )}\n\n`
                          )
                        );
                      } catch {
                        try {
                          const fixedArgument = toolCall.function.arguments
                            .replace(/[\x00-\x1F\x7F-\x9F]/g, "")
                            .replace(/\\/g, "\\\\")
                            .replace(/"/g, '\\"');

                          const fixedChunk = {
                            type: "content_block_delta",
                            index: blockIndex, // Use the correct content block index
                            delta: {
                              type: "input_json_delta",
                              partial_json: fixedArgument,
                            },
                          };
                          safeEnqueue(
                            encoder.encode(
                              `event: content_block_delta\ndata: ${JSON.stringify(
                                fixedChunk
                              )}\n\n`
                            )
                          );
                        } catch (fixError) {
                          console.error(fixError);
                        }
                      }
                    }
                  }
                }

                if (choice?.finish_reason && !isClosed && !hasFinished) {
                  if (contentChunks === 0 && toolCallChunks === 0) {
                    console.error(
                      "Warning: No content in the stream response!"
                    );
                  }

                  // Close any remaining open content block
                  if (currentContentBlockIndex >= 0) {
                    const contentBlockStop = {
                      type: "content_block_stop",
                      index: currentContentBlockIndex,
                    };
                    safeEnqueue(
                      encoder.encode(
                        `event: content_block_stop\ndata: ${JSON.stringify(
                          contentBlockStop
                        )}\n\n`
                      )
                    );
                    currentContentBlockIndex = -1;
                  }

                  if (!isClosed) {
                    const stopReasonMapping: Record<string, string> = {
                      stop: "end_turn",
                      length: "max_tokens",
                      tool_calls: "tool_use",
                      content_filter: "stop_sequence",
                    };

                    const anthropicStopReason =
                      stopReasonMapping[choice.finish_reason] || "end_turn";

                    // Only set the stop_reason here; do NOT build/overwrite usage.
                    // Usage is owned by the `if (chunk.usage)` merge above (which runs
                    // first for the same chunk). Fireworks emits the real usage in a
                    // separate `choices: []` chunk AFTER this finish_reason chunk, and
                    // this finish chunk's own usage is null — overwriting here would
                    // zero out the already-merged real usage. If no usage has been
                    // seen yet, seed a zero placeholder that the trailing usage chunk
                    // (or the onResponse fallback) will fill in.
                    if (!stopReasonMessageDelta) {
                      stopReasonMessageDelta = {
                        type: "message_delta",
                        delta: {
                          stop_reason: anthropicStopReason,
                          stop_sequence: null,
                        },
                        usage: {
                          input_tokens: 0,
                          output_tokens: 0,
                          cache_read_input_tokens: 0,
                        },
                      };
                    } else {
                      stopReasonMessageDelta.delta = {
                        ...stopReasonMessageDelta.delta,
                        stop_reason: anthropicStopReason,
                        stop_sequence: null,
                      };
                    }
                  }

                  // Do not break: keep reading so the trailing usage chunk
                  // (choices: [] with real usage, emitted after finish_reason by
                  // fireworks) can be merged by the `if (chunk.usage)` branch.
                  // Content paths are guarded by `!hasFinished`, so no duplicate
                  // content is emitted.
                  hasFinished = true;
                }
              } catch (parseError: any) {
                this.logger?.error(
                  `parseError: ${parseError.name} message: ${parseError.message} stack: ${parseError.stack} data: ${data}`
                );
              }
            }
          }
          safeClose();
        } catch (error) {
          if (!isClosed) {
            try {
              controller.error(error);
            } catch (controllerError) {
              console.error(controllerError);
            }
          }
        } finally {
          if (reader) {
            try {
              reader.releaseLock();
            } catch (releaseError) {
              console.error(releaseError);
            }
          }
        }
      },
      cancel: (reason) => {
        this.logger.debug(
          {
            reqId: context.req.id,
          },
          `cancle stream: ${reason}`
        );
      },
    });

    return readable;
  }

  private convertOpenAIResponseToAnthropic(
    openaiResponse: ChatCompletion,
    context: TransformerContext
  ): any {
    this.logger.debug(
      {
        reqId: context.req.id,
        response: openaiResponse,
      },
      `Original OpenAI response`
    );
    try {
      const choice = openaiResponse.choices[0];
      if (!choice) {
        throw new Error("No choices found in OpenAI response");
      }
      const content: any[] = [];
      if (choice.message.annotations) {
        const id = `srvtoolu_${uuidv4()}`;
        content.push({
          type: "server_tool_use",
          id,
          name: "web_search",
          input: {
            query: "",
          },
        });
        content.push({
          type: "web_search_tool_result",
          tool_use_id: id,
          content: choice.message.annotations.map((item) => {
            return {
              type: "web_search_result",
              url: item.url_citation.url,
              title: item.url_citation.title,
            };
          }),
        });
      }
      if (choice.message.content) {
        content.push({
          type: "text",
          text: choice.message.content,
        });
      }
      if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
        choice.message.tool_calls.forEach((toolCall) => {
          let parsedInput = {};
          try {
            const argumentsStr = toolCall.function.arguments || "{}";

            if (typeof argumentsStr === "object") {
              parsedInput = argumentsStr;
            } else if (typeof argumentsStr === "string") {
              parsedInput = JSON.parse(argumentsStr);
            }
          } catch {
            parsedInput = { text: toolCall.function.arguments || "" };
          }

          content.push({
            type: "tool_use",
            id: toolCall.id,
            name: toolCall.function.name,
            input: parsedInput,
          });
        });
      }
      if ((choice.message as any)?.thinking?.content) {
        content.push({
          type: "thinking",
          thinking: (choice.message as any).thinking.content,
          signature: (choice.message as any).thinking.signature,
        });
      }
      const cachedTokens =
        openaiResponse.usage?.prompt_tokens_details?.cached_tokens ??
        openaiResponse.usage?.prompt_cache_hit_tokens ??
        0;
      const inputTokens =
        (openaiResponse.usage?.prompt_tokens || 0) - cachedTokens;
      const result = {
        id: openaiResponse.id?.startsWith("msg_")
          ? openaiResponse.id
          : `msg_${uuidv4().replace(/-/g, "")}`,
        type: "message",
        role: "assistant",
        model: openaiResponse.model,
        content: content,
        stop_reason:
          choice.finish_reason === "stop"
            ? "end_turn"
            : choice.finish_reason === "length"
            ? "max_tokens"
            : choice.finish_reason === "tool_calls"
            ? "tool_use"
            : choice.finish_reason === "content_filter"
            ? "stop_sequence"
            : "end_turn",
        stop_sequence: null,
        usage: {
          // Keep Anthropic protocol semantics for Claude Code: input_tokens is net of cache reads.
          input_tokens: inputTokens,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: cachedTokens,
          output_tokens: openaiResponse.usage?.completion_tokens || 0,
          server_tool_use: {
            web_search_requests: 0,
            web_fetch_requests: 0,
          },
          service_tier: "standard",
          cache_creation: {
            ephemeral_1h_input_tokens: 0,
            ephemeral_5m_input_tokens: 0,
          },
          inference_geo: "",
          iterations: [],
          speed: "standard",
        },
        stop_details: null,
        context_management: null,
      };
      this.logger.debug(
        {
          reqId: context.req.id,
          result,
        },
        `Conversion complete, final Anthropic response`
      );
      return result;
    } catch {
      throw createApiError(
        `Provider error: ${JSON.stringify(openaiResponse)}`,
        500,
        "provider_error"
      );
    }
  }
}
