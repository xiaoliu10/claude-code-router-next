import { UnifiedChatRequest, MessageContent } from "@/types/llm";
import { Transformer } from "@/types/transformer";
import {
  parseResponseJson,
  peekBodyForSSE,
  readBodyForSSE,
} from "./response-body";

interface ResponsesAPIOutputItem {
  type: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: Array<{
    type: string;
    text?: string;
    image_url?: string;
    mime_type?: string;
    image_base64?: string;
  }>;
  reasoning?: string;
}

interface ResponsesAPIPayload {
  id: string;
  object: string;
  model: string;
  created_at: number;
  output: ResponsesAPIOutputItem[];
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    input_tokens_details?: {
      cached_tokens?: number;
      cache_creation_tokens?: number;
      cache_write_tokens?: number;
    };
    output_tokens_details?: {
      reasoning_tokens?: number;
    };
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

interface ResponsesStreamEvent {
  type: string;
  item_id?: string;
  output_index?: number;
  summary_index?: number;
  annotation?: {
    url?: string;
    title?: string;
    start_index?: number;
    end_index?: number;
  };
  delta?:
    | string
    | {
        url?: string;
        b64_json?: string;
        mime_type?: string;
      };
  item?: {
    id?: string;
    type?: string;
    call_id?: string;
    name?: string;
    content?: Array<{
      type: string;
      text?: string;
      image_url?: string;
      mime_type?: string;
    }>;
    reasoning?: string; // 添加 reasoning 字段支持
  };
  response?: {
    id?: string;
    model?: string;
    status?: string;
    output?: Array<{
      type: string;
    }>;
    usage?: ResponsesAPIPayload["usage"];
    error?: { code?: string; message?: string } | null;
    incomplete_details?: { reason?: string } | null;
  };
  message?: string;
  error?: { code?: string; message?: string } | null;
  reasoning_summary?: string; // 添加推理摘要支持
}

/**
 * Response protocol the CLIENT expects for this attempt. Routes derive it from
 * the client (endpoint + user agent) so the transformer chain knows which wire
 * format to hand back instead of guessing from the upstream payload alone.
 */
export type ResponsesClientFormat = "responses" | "chat" | "anthropic";

/**
 * Detect which native Responses SSE event types are present in a (possibly
 * incomplete) peeked prefix. Point-name matching alone misclassifies streams
 * whose first meaningful frame is a reasoning / function-call event.
 */
function peekedResponsesEventTypes(prefix: string): Set<string> {
  const types = new Set<string>();
  for (const line of prefix.split(/\r?\n/)) {
    // Fold both a literal `"type":"x"` and a JSON-escaped `\"type\":\"x\"`
    // occurrence down to one spelling before matching.
    const normalized = line.replace(/\\"/g, '"');
    for (const match of normalized.matchAll(/"type"\s*:\s*"(response\.[A-Za-z0-9_.]+)"/g)) {
      types.add(match[1]);
    }
    const named = line.match(/^event:\s*(response\.[A-Za-z0-9_.]+)/);
    if (named) types.add(named[1]);
  }
  return types;
}

function looksLikeResponsesSSE(prefix: string): boolean {
  for (const type of peekedResponsesEventTypes(prefix)) {
    if (type.startsWith("response.")) return true;
  }
  return false;
}

export class OpenAIResponsesTransformer implements Transformer {
  name = "openai-responses";
  endPoint = "/v1/responses";

  private getCacheReadInputTokens(usage: any): number {
    return (
      usage?.cache_read_input_tokens ??
      usage?.input_tokens_details?.cached_tokens ??
      usage?.prompt_tokens_details?.cached_tokens ??
      0
    );
  }

  private getCacheCreationInputTokens(usage: any): number {
    return (
      usage?.cache_creation_input_tokens ??
      usage?.input_tokens_details?.cache_creation_tokens ??
      usage?.input_tokens_details?.cache_write_tokens ??
      usage?.prompt_tokens_details?.cache_creation_tokens ??
      usage?.prompt_tokens_details?.cache_write_tokens ??
      0
    );
  }

  private buildResponsesUsage(usage?: any): ResponsesAPIPayload["usage"] {
    const inputTokens =
      usage?.input_tokens ??
      usage?.prompt_tokens ??
      0;
    const outputTokens =
      usage?.output_tokens ??
      usage?.completion_tokens ??
      0;
    const cacheReadInputTokens = this.getCacheReadInputTokens(usage);
    const cacheCreationInputTokens = this.getCacheCreationInputTokens(usage);

    return {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens:
        usage?.total_tokens ??
        (inputTokens + outputTokens),
      input_tokens_details: {
        cached_tokens: cacheReadInputTokens,
        cache_creation_tokens: cacheCreationInputTokens,
      },
      output_tokens_details: {
        reasoning_tokens: usage?.output_tokens_details?.reasoning_tokens ?? 0,
      },
      cache_read_input_tokens: cacheReadInputTokens,
      cache_creation_input_tokens: cacheCreationInputTokens,
    };
  }

  async transformRequestIn(
    request: UnifiedChatRequest
  ): Promise<UnifiedChatRequest> {
    delete request.temperature;
    delete request.max_tokens;

    // Handle reasoning parameter — preserve the original summary level from Codex
    // instead of hardcoding "detailed". Codex may send "auto" or "concise" to
    // control reasoning summary verbosity, which affects auto-compact behavior.
    if (request.reasoning) {
      (request as any).reasoning = {
        effort: request.reasoning.effort,
        summary: request.reasoning.summary || "auto",
      };
    }

    const input: any[] = [];

    const systemMessages = request.messages.filter(
      (msg) => msg.role === "system"
    );
    if (systemMessages.length > 0) {
      const firstSystem = systemMessages[0];
      if (Array.isArray(firstSystem.content)) {
        firstSystem.content.forEach((item) => {
          let text = "";
          if (typeof item === "string") {
            text = item;
          } else if (item && typeof item === "object" && "text" in item) {
            text = (item as { text: string }).text;
          }
          input.push({
            role: "system",
            content: text,
          });
        });
      } else {
        (request as any).instructions = firstSystem.content;
      }
    }

    request.messages.forEach((message) => {
      if (message.role === "system") return;

      if (Array.isArray(message.content)) {
        const convertedContent = message.content
          .map((content) => this.normalizeRequestContent(content, message.role))
          .filter(
            (content): content is Record<string, unknown> => content !== null
          );

        if (convertedContent.length > 0) {
          (message as any).content = convertedContent;
        } else {
          delete (message as any).content;
        }
      }

      if (message.role === "tool") {
        const toolMessage: any = { ...message };
        toolMessage.type = "function_call_output";
        toolMessage.call_id = message.tool_call_id;
        toolMessage.output = message.content;
        delete toolMessage.cache_control;
        delete toolMessage.role;
        delete toolMessage.tool_call_id;
        delete toolMessage.content;
        input.push(toolMessage);
        return;
      }

      if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
        message.tool_calls.forEach((tool) => {
          input.push({
            type: "function_call",
            arguments: tool.function.arguments,
            name: tool.function.name,
            call_id: tool.id,
          });
        });
        return;
      }

      // The unified assistant shape carries an optional top-level `thinking`
      // field (anthropic.transformer extracts it from client thinking blocks
      // for OpenAI-compatible reasoning upstreams). The Responses API rejects
      // unknown top-level item fields — a second turn with carried-back
      // thinking history fails with 400 "Unknown parameter:
      // input[N].thinking" — so strip it here; the reasoning content itself
      // was already dropped from the content array by normalizeRequestContent.
      const { thinking: _strippedThinking, ...responsesItem } = message as any;
      input.push(responsesItem);
    });

    (request as any).input = input;
    delete (request as any).messages;

    if (Array.isArray(request.tools)) {
      const webSearch = request.tools.find(
        (tool) => tool.function.name === "web_search"
      );

      (request as any).tools = request.tools
        .filter((tool) => tool.function.name !== "web_search")
        .map((tool) => {
          if (tool.function.name === "WebSearch") {
            delete tool.function.parameters.properties.allowed_domains;
          }
          if (tool.function.name === "Edit") {
            return {
              type: tool.type,
              name: tool.function.name,
              description: tool.function.description,
              parameters: {
                ...tool.function.parameters,
                required: [
                  "file_path",
                  "old_string",
                  "new_string",
                  "replace_all",
                ],
              },
              strict: true,
            };
          }
          return {
            type: tool.type,
            name: tool.function.name,
            description: tool.function.description,
            parameters: tool.function.parameters,
          };
        });

      if (webSearch) {
        (request as any).tools.push({
          type: "web_search",
        });
      }
    }

    request.parallel_tool_calls = false;

    return request;
  }

  async transformResponseOut(
    response: Response,
    context?: any
  ): Promise<Response> {
    const contentType = response.headers.get("Content-Type") || "";

    // Some upstreams return SSE under an UNLABELED (or garbage) content-type —
    // the real chatgpt.com backend answers with no content-type at all, and
    // Clash/TUN middleboxes can strip it. Peek first: an SSE-shaped body is
    // rebuilt with the correct type and re-dispatched, so neither the JSON
    // branch nor the fall-through below can silently drop its content.
    if (!contentType.includes("text/event-stream") && !contentType.includes("application/json") && response.body) {
      const peeked = await peekBodyForSSE(response);
      if (peeked?.isSSE && peeked.body) {
        const rebuilt = new Response(peeked.body, {
          status: response.status,
          statusText: response.statusText,
          headers: new Headers({
            ...Object.fromEntries(response.headers.entries()),
            "content-type": "text/event-stream",
          }),
        });
        return this.transformResponseOut(rebuilt, context);
      }
      if (peeked?.body) {
        response = new Response(peeked.body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }
    }

    // Some upstreams (Codex relay) label an SSE body with an application/json
    // Content-Type. Peek the first meaningful content: when the body actually
    // looks like SSE, re-dispatch as a stream so the SSE pass-through below
    // handles it, instead of failing JSON parse with "Upstream returned a
    // non-JSON response". The peek accumulates across chunks because the first
    // event may be split, or preceded by an empty buffer / SSE heartbeat.
    if (contentType.includes("application/json")) {
      const peeked = await peekBodyForSSE(response);
      if (peeked?.isSSE && peeked.body) {
        // Body is SSE mislabeled as JSON — rebuild with the untouched tee'd
        // body (first chunk still in it) and a corrected Content-Type, then
        // recurse once into this method to take the SSE path.
        const rebuilt = new Response(peeked.body, {
          status: response.status,
          statusText: response.statusText,
          headers: new Headers({
            ...Object.fromEntries(response.headers.entries()),
            "content-type": "text/event-stream",
          }),
        });
        return this.transformResponseOut(rebuilt, context);
      }
      if (peeked?.body) {
        // Genuine JSON (or at least not SSE) — put the unread body back.
        response = new Response(peeked.body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } else if (peeked === null) {
        // Body absent or locked so tee-peek is impossible — drain as text and
        // reclassify; a locked-body SSE mislabel still needs the SSE path.
        const drained = await readBodyForSSE(response);
        if (drained.isSSE) {
          return this.transformResponseOut(drained.response, context);
        }
        response = drained.response;
      }
    }

    if (contentType.includes("application/json")) {
      const jsonResponse: any = await parseResponseJson(response);

      // Check if this is a Responses API format JSON response from an upstream
      // provider that natively speaks the Responses API (e.g. OpenAI o-series).
      // Convert to chat format so downstream transformers can process it.
      if (jsonResponse.object === "response" && jsonResponse.output) {
        const chatResponse = this.convertResponseToChat(jsonResponse);
        return new Response(JSON.stringify(chatResponse), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }

      // Anthropic JSON format — pass through unchanged. The downstream
      // transformResponseIn will handle Anthropic → Responses API conversion.
      // Without this guard, wrapChatInResponses would look for choices[0] which
      // doesn't exist in Anthropic JSON, producing an empty output array.
      if (jsonResponse.type === "message" && Array.isArray(jsonResponse.content)) {
        return new Response(JSON.stringify(jsonResponse), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }

      // Not a recognized format — pass through as-is
      return new Response(JSON.stringify(jsonResponse), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } else if (contentType.includes("text/event-stream")) {
      if (!response.body) {
        return response;
      }

      // Peek at the first chunk to detect the stream format before processing.
      // If the upstream returns Anthropic SSE (e.g. when the provider uses the
      // Anthropic transformer), we must pass it through unchanged — the downstream
      // transformResponseIn will convert Anthropic SSE → Responses API SSE.
      // Without this guard, the Responses-API → Chat → Responses-API round-trip
      // corrupts Anthropic events, causing Codex to receive malformed SSE.
      const [peekStream, bodyStream] = response.body.tee();
      const peekReader = peekStream.getReader();
      let firstChunk = "";
      const peekDecoder = new TextDecoder();
      try {
        // A single read is not enough: a heartbeat or a frame split before the
        // `response.*` token would misclassify a native Responses stream and
        // hand it raw to an Anthropic client. Accumulate a bounded prefix,
        // stopping as soon as the protocol is identifiable.
        for (let reads = 0; reads < 8 && firstChunk.length < 65536; reads++) {
          const { value, done } = await peekReader.read();
          if (done) break;
          if (value) firstChunk += peekDecoder.decode(value, { stream: true });
          if (
            looksLikeResponsesSSE(firstChunk) ||
            firstChunk.includes("message_start") ||
            firstChunk.includes("content_block_start") ||
            firstChunk.includes("chat.completion.chunk") ||
            /^\s*[{[]/.test(firstChunk)
          ) break;
        }
      } finally {
        peekReader.releaseLock();
      }
      peekStream.cancel().catch(() => {});

      const isAnthropic = firstChunk.includes("message_start") || firstChunk.includes("content_block_start");
      if (isAnthropic) {
        // bodyStream is the untouched tee'd branch — the peeked first chunk is
        // still in it, so it must be passed through directly. (Prepending the
        // peeked text here duplicated the first event, and when the first chunk
        // ended mid-JSON it produced malformed events.)
        return new Response(bodyStream, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }

      // Also handle upstream payloads that already speak the Responses API
      // natively. When the client expects the Responses protocol (or the caller
      // gave no hint at all) pass it through untouched. When the client needs the
      // unified Chat/Anthropic shape, hand it to the converter below — leaving it
      // untouched made the Anthropic transformer parse Responses events as Chat
      // chunks (no model, no choices): model "unknown", zero content, and a
      // synthesized empty success at EOF.
      if (looksLikeResponsesSSE(firstChunk)) {
        // EVERY non-Responses client needs the unified Chat shape: `chat` for
        // Chat clients, `anthropic` for /v1/messages (pi, Claude Code). Gating on
        // "chat" alone left the anthropic target on the pass-through path, so a
        // real pi request still received an empty "unknown" turn.
        if (this.getClientFormat(context) !== "responses") {
          return this.buildResponsesToChatStream(bodyStream, context);
        }
        return new Response(bodyStream, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }

      // Neither Anthropic nor native Responses SSE: an upstream that already
      // emits Chat chunks, or a payload of unknown shape, passes through
      // untouched. bodyStream still contains the peeked first chunk.
      return new Response(bodyStream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    return response;
  }

  private normalizeRequestContent(content: any, role: string | undefined) {
    // 克隆内容对象并删除缓存控制字段
    const clone = { ...content };
    delete clone.cache_control;

    if (content.type === "text") {
      return {
        type: role === "assistant" ? "output_text" : "input_text",
        text: content.text,
      };
    }

    if (content.type === "image_url") {
      const imagePayload: Record<string, unknown> = {
        type: role === "assistant" ? "output_image" : "input_image",
      };

      if (typeof content.image_url?.url === "string") {
        imagePayload.image_url = content.image_url.url;
      }

      return imagePayload;
    }

    return null;
  }

  /**
   * Resolve which protocol the client of THIS attempt expects. Routes set
   * `responseTargetFormat` per attempt (client, not upstream). An unset format
   * is backward compatible with the historical behavior: native Responses
   * streams pass through untouched.
   */
  private getClientFormat(context?: any): ResponsesClientFormat {
    const format = context?.responseTargetFormat;
    if (format === "responses" || format === "chat" || format === "anthropic") {
      return format;
    }
    return "responses";
  }

  /**
   * Convert a native Responses API SSE stream into Chat-completion chunks so a
   * Chat/Anthropic client can consume it. Model identity comes from the
   * `response` envelope of created/in_progress/completed events, terminal usage
   * from `response.completed`, and each function call keeps its own tool_call
   * index. A terminal failure is surfaced as an `error` event instead of an
   * empty successful completion, and a stream that ends before any terminal
   * event only reports `finish_reason` when it actually delivered content.
   */
  private buildResponsesToChatStream(
    bodyStream: ReadableStream<Uint8Array>,
    context?: any
  ): Response {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const messageId = "chatcmpl-" + Date.now();
    const model = context?.provider?.models?.[0];

    let buffer = "";
    let responseModel: string | undefined;
    let responseId: string | undefined;
    let terminalUsage: any;
    let currentTextItemId: string | undefined;
    let lastActivity = "";
    const toolIndexByCallKey = new Map<string, number>();
    const callIdByToolIndex = new Map<number, string>();
    let nextToolIndex = 0;
    let emittedError = false;
    let finished = false;
    let emittedDone = false;
    const self = this;

    const stream = new ReadableStream({
      start(controller) {
        const emitChunk = (delta: Record<string, any>, finishReason: string | null = null) => {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                id: responseId || messageId,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: responseModel || model,
                choices: [{ index: 0, delta, finish_reason: finishReason }],
              })}\n\n`
            )
          );
        };

        const emitUsageChunk = (usage: any) => {
          if (!usage) return;
          const cacheRead = self.getCacheReadInputTokens(usage);
          const rawInput =
            typeof usage.input_tokens === "number" ? usage.input_tokens : undefined;
          const cacheCreation = self.getCacheCreationInputTokens(usage);
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                id: responseId || messageId,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: responseModel || model,
                // Same key a Chat upstream uses, so downstream usage mapping
                // (prompt_tokens_to_input_tokens minus cached) stays exact.
                choices: [],
                usage: {
                  prompt_tokens: rawInput,
                  completion_tokens:
                    typeof usage.output_tokens === "number" ? usage.output_tokens : undefined,
                  total_tokens: usage.total_tokens,
                  prompt_tokens_details: {
                    cached_tokens: cacheRead,
                    cache_creation_tokens: cacheCreation,
                  },
                  cache_read_input_tokens: cacheRead,
                  cache_creation_input_tokens: cacheCreation,
                },
              })}\n\n`
            )
          );
        };

        /**
         * A terminal upstream failure. The same envelope as the Chat error path
         * so AnthropicTransformer turns it into `event: error` and the request
         * is recorded as failed instead of a clean, empty success.
         */
        const emitError = (message: string) => {
          if (emittedError) return;
          emittedError = true;
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                error: { message, type: "upstream_error" },
                choices: [{ index: 0, delta: {}, finish_reason: "error" }],
              })}\n\n`
            )
          );
        };

        const finishOnce = (finishReason: string) => {
          if (finished) return;
          finished = true;
          emitUsageChunk(terminalUsage);
          emitChunk({}, finishReason);
        };

        const emitDone = () => {
          if (emittedDone) return;
          emittedDone = true;
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        };

        const toolIndexFor = (item: any, outputIndex?: number) => {
          // Identity is the call id when the event carries one: relays sometimes
          // reuse output_index 0 for every tool call, and keying on position
          // first would then merge two distinct calls into one tool_use block.
          // Position is the fallback for `function_call_arguments.*` deltas,
          // which carry only item_id/output_index.
          const key =
            item?.call_id || item?.id ||
            (outputIndex !== undefined ? `idx_${outputIndex}` : undefined);
          if (!key) return nextToolIndex++;
          const existing = toolIndexByCallKey.get(key);
          if (existing !== undefined) return existing;
          const index = nextToolIndex++;
          toolIndexByCallKey.set(key, index);
          // Deltas address the call by item_id while `added` carries call_id:
          // alias BOTH so the deltas join the existing block instead of opening
          // a second (placeholder-id) block for the same call.
          if (item?.call_id && item?.id) {
            toolIndexByCallKey.set(item.id, index);
            if (outputIndex !== undefined) {
              toolIndexByCallKey.set(`idx_${outputIndex}`, index);
            }
          } else if (item?.id && outputIndex !== undefined) {
            toolIndexByCallKey.set(`idx_${outputIndex}`, index);
          }
          return index;
        };

        /**
         * Terminal frames may carry the WHOLE turn inline (non-streamed
         * upstreams): function_call items and message text with no prior delta
         * events. Emit them in upstream order — dropping them produced
         * tool-use finishes with no tool block, or zero-content turns the
         * empty-answer guard then 400s. Returns whether anything was emitted.
         */
        const emitInlineOutput = (output: any[]): boolean => {
          let emitted = false;
          for (const item of Array.isArray(output) ? output : []) {
            if (item?.type === "function_call") {
              lastActivity = "tool";
              const index = toolIndexFor(item, undefined);
              const id = item.call_id || item.id;
              if (id) callIdByToolIndex.set(index, id);
              emitChunk({
                role: "assistant",
                tool_calls: [
                  {
                    index,
                    id,
                    type: "function",
                    function: {
                      name: item.name || "",
                      arguments: typeof item.arguments === "string" ? item.arguments : "",
                    },
                  },
                ],
              });
              emitted = true;
            } else if (item?.type === "message") {
              for (const part of Array.isArray(item.content) ? item.content : []) {
                if (part?.type === "output_text" && typeof part.text === "string" && part.text.trim().length > 0) {
                  lastActivity = "text";
                  emitChunk({ role: "assistant", content: part.text });
                  emitted = true;
                }
              }
            }
          }
          return emitted;
        };

        const handleEvent = (data: ResponsesStreamEvent) => {
          if (data?.response?.model) responseModel = data.response.model;
          if (data?.response?.id) responseId = data.response.id;

          switch (data?.type) {
            case "response.output_item.added": {
              const item: any = data.item;
              if (item?.type !== "function_call") return;
              lastActivity = "tool";
              const index = toolIndexFor(item, data.output_index);
              const id = item.call_id || item.id;
              if (id) callIdByToolIndex.set(index, id);
              emitChunk({
                role: "assistant",
                tool_calls: [
                  {
                    index,
                    id,
                    type: "function",
                    function: { name: item.name || "", arguments: "" },
                  },
                ],
              });
              return;
            }
            case "response.function_call_arguments.delta": {
              // Each output item gets its own tool_call index; falling back to a
              // per-item key would allocate a new index for every delta.
              const index = toolIndexFor(
                { id: data.item_id },
                data.output_index
              );
              lastActivity = "tool";
              const knownCallId = callIdByToolIndex.get(index);
              emitChunk({
                tool_calls: [
                  {
                    index,
                    // Repeat the call id so a consumer that re-synthesizes a
                    // block for this index does not invent a placeholder id.
                    ...(knownCallId ? { id: knownCallId, type: "function" } : {}),
                    function: { arguments: typeof data.delta === "string" ? data.delta : "" },
                  },
                ],
              });
              return;
            }
            case "response.output_text.annotation.added": {
              // Web-search citations: forward as a Chat annotation delta so the
              // Anthropic transformer can emit a web_search_tool_result block.
              const annotation: any = data.annotation;
              if (!annotation) return;
              lastActivity = "annotation";
              emitChunk({
                annotations: [
                  {
                    type: "url_citation",
                    url_citation: {
                      url: annotation.url || "",
                      title: annotation.title || "",
                      content: "",
                      start_index: annotation.start_index || 0,
                      end_index: annotation.end_index || 0,
                    },
                  },
                ],
              });
              return;
            }
            case "response.reasoning_summary_text.delta":
            case "response.reasoning_text.delta": {
              if (typeof data.delta !== "string" || data.delta.length === 0) return;
              lastActivity = "thinking";
              emitChunk({ thinking: { content: data.delta } });
              return;
            }
            case "response.output_text.delta": {
              if (typeof data.delta !== "string" || data.delta.length === 0) return;
              lastActivity = "text";
              const firstDeltaForItem = currentTextItemId !== data.item_id;
              currentTextItemId = data.item_id;
              const delta: Record<string, any> = { content: data.delta };
              if (firstDeltaForItem) delta.role = "assistant";
              emitChunk(delta);
              return;
            }
            case "response.completed": {
              terminalUsage = data.response?.usage;
              const output: any[] = Array.isArray(data.response?.output) ? data.response.output : [];
              const hasToolCall = output.some((item: any) => item?.type === "function_call");
              // A terminal frame may carry the whole message inline (non-streamed
              // or summary-style upstreams): no text delta ever fired, yet the
              // answer is right there in output[]. Dropping it produced a clean
              // turn with zero content — emit it here, once, before finishing.
              if (lastActivity === "") emitInlineOutput(output);
              // A "completed" turn that never delivered text, thinking or a tool
              // call is NOT a success: reporting it as a clean finish is exactly
              // the silent empty turn this converter exists to prevent.
              if (!hasToolCall && lastActivity === "") {
                const reason = String(data.response?.incomplete_details?.reason ?? "");
                emitError(
                  output.length === 0 && !reason
                    ? "Upstream Responses stream completed with no output"
                    : `Upstream Responses stream produced no content (${reason || "empty"})`
                );
                return;
              }
              finishOnce(
                lastActivity === "tool" || hasToolCall ? "tool_calls" : "stop"
              );
              return;
            }
            case "response.incomplete": {
              terminalUsage = data.response?.usage;
              const reason = String(data.response?.incomplete_details?.reason ?? "");
              // Same inline-message case as response.completed: a truncated
              // non-delta stream still carries what it did produce.
              if (lastActivity === "") {
                emitInlineOutput(Array.isArray(data.response?.output) ? data.response.output : []);
              }
              const truncated =
                reason === "max_output_tokens" || reason === "max_tokens";
              if (lastActivity === "") {
                emitError(
                  `Upstream Responses stream produced no content (${reason || "incomplete"})`
                );
                return;
              }
              // `content_filter` must keep its signal: mapping it to `stop`
              // reports a filtered turn as a clean end_turn.
              finishOnce(
                truncated ? "length" : reason === "content_filter" ? "content_filter" : "stop"
              );
              return;
            }
            case "response.failed": {
              const failure =
                data.response?.error || data.error || undefined;
              emitError(
                failure?.message ||
                  "Upstream Responses stream failed before completing"
              );
              return;
            }
            case "error": {
              emitError(
                data.error?.message || data.message || "Upstream Responses stream error"
              );
              return;
            }
            default:
              return;
          }
        };

        const reader = bodyStream.getReader();

        (async () => {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split(/\r?\n/);
              buffer = lines.pop() || "";
              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith(":") || trimmed.startsWith("event:")) {
                  continue;
                }
                if (!trimmed.startsWith("data:")) continue;
                const raw = trimmed.slice(5).trim();
                if (!raw) continue;
                if (raw === "[DONE]") {
                  emitDone();
                  continue;
                }
                let data: ResponsesStreamEvent;
                try {
                  data = JSON.parse(raw);
                } catch {
                  continue;
                }
                handleEvent(data);
              }
            }

            buffer += decoder.decode();
            if (buffer.trim().startsWith("data:")) {
              const raw = buffer.trim().slice(5).trim();
              if (raw && raw !== "[DONE]") {
                try {
                  handleEvent(JSON.parse(raw));
                } catch {
                  // partial trailing frame — ignore
                }
              }
            }

            // Early EOF: an error frame already speaks for itself. A turn that
            // produced nothing gets an explicit error — never a clean finish,
            // and never a silent empty "success".
            if (!emittedError && !finished) {
              if (lastActivity === "") {
                emitError("Upstream Responses stream ended before any output");
              } else {
                finishOnce(lastActivity === "tool" ? "tool_calls" : "stop");
              }
            }
            if (!emittedError) emitDone();
          } catch (error) {
            console.error("Responses→Chat stream error:", error);
            try {
              controller.error(error);
            } catch {
              // Already closed (client cancel raced the failure) — nothing to
              // surface on a dead controller.
            }
            return;
          } finally {
            try {
              reader.releaseLock();
            } catch { /* best-effort: the reader may already be released */ }
          }
          try {
            controller.close();
          } catch {
            // A cancel or an earlier error closed the controller first.
          }
        })();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  async transformResponseIn(
    response: Response,
    context?: any
  ): Promise<Response> {
    const isStream = response.headers
      .get("Content-Type")
      ?.includes("text/event-stream");
    if (isStream && response.body) {
      // Peek at the first SSE event to detect the format (Anthropic vs OpenAI Chat)
      // and route to the appropriate converter.
      const [peekStream, bodyStream] = response.body.tee();
      const reader = peekStream.getReader();
      let firstChunk = "";
      try {
        // Same accumulate-until-classifiable rationale as transformResponseOut:
        // proxy exit nodes split the first SSE frame across small chunks, and a
        // single read missed every marker — routing a native Responses stream
        // into the wrong converter (the codex 0-output disease, 2463008).
        for (let reads = 0; reads < 8 && firstChunk.length < 65536; reads++) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) firstChunk += new TextDecoder().decode(value, { stream: true });
          if (
            looksLikeResponsesSSE(firstChunk) ||
            firstChunk.includes("message_start") ||
            firstChunk.includes("content_block_start") ||
            firstChunk.includes("chat.completion.chunk") ||
            /^\s*[{[]/.test(firstChunk)
          ) break;
        }
        firstChunk += new TextDecoder().decode();
      } finally {
        reader.releaseLock();
      }
      // Cancel the peek stream — we only need bodyStream
      peekStream.cancel().catch(() => {});

      // Detect Anthropic SSE by looking for "type":"message_start" or "type":"content_block_start"
      const isAnthropic = firstChunk.includes("message_start") || firstChunk.includes("content_block_start");
      // Detect OpenAI Chat SSE by looking for "object":"chat.completion.chunk"
      const isOpenAIChat = firstChunk.includes("chat.completion.chunk");
      // Detect native Responses API SSE — upstream already speaks the Responses API format.
      // Pass it through unchanged so Codex can parse it directly. The generic
      // detector (any response.* event name, even a split-frame partial that
      // truncated a specific marker like "response.created") is authoritative:
      // the accumulate loop can break on that partial, and the four point
      // checks alone would then misroute the stream to the wrong converter.
      const isResponsesAPI = firstChunk.includes("response.created") ||
        firstChunk.includes("response.output_text.delta") ||
        firstChunk.includes("response.in_progress") ||
        firstChunk.includes("response.output_item.added") ||
        looksLikeResponsesSSE(firstChunk);

      if (isResponsesAPI) {
        return new Response(bodyStream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      }

      if (isOpenAIChat && !isAnthropic) {
        // OpenAI Chat SSE → Responses API SSE
        const converted = this.convertOpenAIChatStreamToResponsesAPI(bodyStream, context);
        return new Response(converted, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      }

      // Default: treat as Anthropic SSE → Responses API SSE
      const converted = this.convertAnthropicStreamToResponsesAPI(bodyStream, context);
      return new Response(converted, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }
    // Non-stream: assume OpenAI Chat JSON → wrap in Responses API shape
    try {
      const json = await parseResponseJson(response);
      return new Response(JSON.stringify(this.wrapChatInResponses(json)), {
        headers: { "Content-Type": "application/json" },
      });
    } catch {
      return response;
    }
  }

  /**
   * Convert an OpenAI Chat SSE stream to Responses API SSE events.
   * Handles choices[0].delta.content, choices[0].delta.tool_calls, and finish_reason.
   */
  private convertOpenAIChatStreamToResponsesAPI(
    stream: ReadableStream,
    context?: any
  ): ReadableStream {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const model = (context?.provider?.models?.[0]) || "gpt-5.4";
    const responseId = `resp_${Date.now()}`;
    let outputIndex = 0;
    let sentCreated = false;
    let sentTextItemAdded = false;
    let currentToolCallId = "";
    let currentToolIndex = -1;
    const outputItems: any[] = [];

    // Emit a properly-formatted SSE event with both event: and data: lines.
    const emit = (type: string, payload: object) =>
      encoder.encode(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);

    // Build a base response object matching the official OpenAI Responses API shape.
    const baseResponse = (status: string, output: any[] = []) => ({
      id: responseId,
      object: "response" as const,
      created_at: Math.floor(Date.now() / 1000),
      status,
      model,
      output,
      usage: this.buildResponsesUsage(),
    });

    return new ReadableStream({
      async start(controller) {
        try {
          const reader = stream.getReader();
          let buffer = "";
          let completedEmitted = false;

          // Emit response.function_call_arguments.done + output_item.done for
          // each pending tool call, then emit response.completed.
          const finalizeResponse = (data: any) => {
            if (completedEmitted) return;
            completedEmitted = true;

            // Finalize each tool call: emit arguments.done + output_item.done
            for (const item of outputItems) {
              if (item.type === "function_call") {
                const idx = outputItems.indexOf(item);
                controller.enqueue(emit("response.function_call_arguments.done", {
                  type: "response.function_call_arguments.done",
                  item_id: item.call_id || item.id,
                  output_index: idx,
                  arguments: item.arguments || "",
                }));
                item.status = "completed";
                controller.enqueue(emit("response.output_item.done", {
                  type: "response.output_item.done",
                  output_index: idx,
                  item,
                }));
              }
            }

            // Finalize text item if present
            for (const item of outputItems) {
              if (item.type === "message") {
                const idx = outputItems.indexOf(item);
                item.status = "completed";
                controller.enqueue(emit("response.output_item.done", {
                  type: "response.output_item.done",
                  output_index: idx,
                  item,
                }));
              }
            }

            controller.enqueue(emit("response.completed", {
              type: "response.completed",
              response: {
                id: responseId,
                object: "response",
                created_at: Math.floor(Date.now() / 1000),
                status: "completed",
                model: data?.model || model,
                output: outputItems.slice(),
                usage: data?.usage ? {
                  ...this.buildResponsesUsage(data.usage),
                } : this.buildResponsesUsage(),
              },
            }));
          };

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || trimmed.startsWith("event:")) continue;
              if (!trimmed.startsWith("data:")) continue;

              const raw = trimmed.slice(5).trim();
              if (raw === "[DONE]") {
                // Ensure response.completed is emitted before [DONE].
                finalizeResponse({});
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                continue;
              }

              let data: any;
              try { data = JSON.parse(raw); } catch { continue; }

              // Emit response.created on first chunk
              if (!sentCreated) {
                sentCreated = true;
                controller.enqueue(emit("response.created", { type: "response.created", response: baseResponse("in_progress") }));
                controller.enqueue(emit("response.in_progress", { type: "response.in_progress", response: baseResponse("in_progress") }));
              }

              const choice = data.choices?.[0];
              if (!choice) continue;

              // Handle text content delta
              const delta = choice.delta;
              if (delta?.content) {
                if (!sentTextItemAdded) {
                  sentTextItemAdded = true;
                  const idx = outputIndex++;
                  const item = { id: `${responseId}_msg`, type: "message", status: "in_progress", role: "assistant", content: [] };
                  outputItems.push(item);
                  controller.enqueue(emit("response.output_item.added", { type: "response.output_item.added", output_index: idx, item }));
                }
                controller.enqueue(emit("response.output_text.delta", { type: "response.output_text.delta", item_id: `${responseId}_msg`, output_index: outputIndex - 1, content_index: 0, delta: delta.content }));
              }

              // Handle tool calls
              if (Array.isArray(delta?.tool_calls)) {
                for (const tc of delta.tool_calls) {
                  if (tc.id) {
                    currentToolCallId = tc.id;
                    currentToolIndex = outputIndex++;
                    const item = { id: tc.id, type: "function_call", status: "in_progress", call_id: tc.id, name: tc.function?.name || "", arguments: "" };
                    outputItems.push(item);
                    controller.enqueue(emit("response.output_item.added", { type: "response.output_item.added", output_index: currentToolIndex, item }));
                  }
                  if (tc.function?.arguments) {
                    controller.enqueue(emit("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", item_id: currentToolCallId, output_index: currentToolIndex, delta: tc.function.arguments }));
                    const existing = outputItems.find((o: any) => o.call_id === currentToolCallId);
                    if (existing) existing.arguments += tc.function.arguments;
                  }
                }
              }

              // Handle finish_reason → finalize tool calls and emit response.completed
              if (choice.finish_reason) {
                finalizeResponse(data);
              }
            }
          }

          // Stream ended without [DONE] — still emit response.completed
          if (!completedEmitted) {
            finalizeResponse({});
          }

          controller.close();
        } catch (e) {
          controller.error(e);
        }
      },
    });
  }

  private convertAnthropicStreamToResponsesAPI(
    stream: ReadableStream,
    context?: any
  ): ReadableStream {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const model = (context?.provider?.models?.[0]) || "gpt-5.4";
    let responseId = `resp_${Date.now()}`;
    let textContent = "";
    let textItemId = "";
    let textItemOutputIndex = -1;
    let toolCallId = "";
    let toolCallName = "";
    let toolCallArgs = "";
    let toolCallOutputIndex = -1;
    let thinkingContent = "";
    let thinkingItemId = "";
    let thinkingOutputIndex = -1;
    let outputIndex = 0;
    let sentCreated = false;
    let sentTextItemAdded = false;
    let sentThinkingItemAdded = false;
    let completedEmitted = false;
    let currentBlockType: "text" | "thinking" | "tool_use" | null = null;
    const outputItems: any[] = [];

    // Emit a properly-formatted SSE event with both event: and data: lines.
    // The OpenAI SDK dispatches on the named event type, so both lines are required.
    const emit = (type: string, payload: object) =>
      encoder.encode(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);

    // Build a base response object with all required fields matching the official
    // OpenAI Responses API shape. Codex SDK expects object, status, output, etc.
    const baseResponse = (status: string, output: any[] = []) => ({
      id: responseId,
      object: "response" as const,
      created_at: Math.floor(Date.now() / 1000),
      status,
      model,
      output,
      usage: this.buildResponsesUsage(),
    });

    // Emit response.created + response.in_progress if not yet done.
    const ensureCreated = () => {
      if (sentCreated) return;
      sentCreated = true;
      controller.enqueue(emit("response.created", { type: "response.created", response: baseResponse("in_progress") }));
      controller.enqueue(emit("response.in_progress", { type: "response.in_progress", response: baseResponse("in_progress") }));
    };

    // Emit response.output_item.done for a completed output item.
    const emitOutputItemDone = (outputIdx: number, item: any) => {
      controller.enqueue(emit("response.output_item.done", {
        type: "response.output_item.done",
        output_index: outputIdx,
        item: { ...item, status: "completed" },
      }));
    };

    // Helper: emit response.completed from current outputItems state if not yet emitted.
    const emitCompleted = (usage?: any) => {
      if (completedEmitted) return;
      completedEmitted = true;

      // Finalize any open text item
      if (sentTextItemAdded) {
        const textItem = outputItems.find((o: any) => o.type === "message");
        if (textItem) {
          textItem.content = [{ type: "output_text", text: textContent }];
          textItem.status = "completed";
        }
      }

      // Finalize any open tool items
      for (const item of outputItems) {
        if (item.type === "function_call") {
          item.status = "completed";
        }
      }

      return emit("response.completed", {
        type: "response.completed",
        response: {
          id: responseId,
          object: "response",
          created_at: Math.floor(Date.now() / 1000),
          status: "completed",
          model,
          output: outputItems,
          usage: usage ? {
            ...this.buildResponsesUsage(usage),
          } : this.buildResponsesUsage(),
        },
      });
    };

    let controller: ReadableStreamDefaultController;

    return new ReadableStream({
      async start(ctrl) {
        controller = ctrl;
        try {
          const reader = stream.getReader();
          let buffer = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || trimmed.startsWith("event:")) continue;
              if (!trimmed.startsWith("data:")) continue;

              const raw = trimmed.slice(5).trim();
              if (raw === "[DONE]") continue;

              let data: any;
              try { data = JSON.parse(raw); } catch { continue; }

              if (data.type === "message_start") {
                responseId = data.message?.id || responseId;
                ensureCreated();
              }

              if (data.type === "content_block_start") {
                const block = data.content_block;
                currentBlockType = block?.type || null;

                if (block?.type === "tool_use") {
                  toolCallId = block.id || "";
                  toolCallName = block.name || "";
                  toolCallArgs = "";
                  toolCallOutputIndex = outputIndex++;
                  const item = {
                    id: toolCallId,
                    type: "function_call",
                    status: "in_progress",
                    call_id: toolCallId,
                    name: toolCallName,
                    arguments: "",
                  };
                  outputItems.push(item);
                  controller.enqueue(emit("response.output_item.added", {
                    type: "response.output_item.added",
                    output_index: toolCallOutputIndex,
                    item,
                  }));
                }

                if (block?.type === "thinking") {
                  thinkingContent = block.thinking || "";
                  if (!sentThinkingItemAdded) {
                    sentThinkingItemAdded = true;
                    thinkingOutputIndex = outputIndex++;
                    thinkingItemId = `rs_${responseId}`;
                    const item = {
                      id: thinkingItemId,
                      type: "reasoning",
                      status: "in_progress",
                      summary: [],
                    };
                    outputItems.push(item);
                    controller.enqueue(emit("response.output_item.added", {
                      type: "response.output_item.added",
                      output_index: thinkingOutputIndex,
                      item,
                    }));
                  }
                }

                if (block?.type === "text") {
                  textContent = block?.text || "";
                  if (!sentTextItemAdded) {
                    sentTextItemAdded = true;
                    textItemOutputIndex = outputIndex++;
                    textItemId = `${responseId}_msg`;
                    const item = {
                      id: textItemId,
                      type: "message",
                      status: "in_progress",
                      role: "assistant",
                      content: [],
                    };
                    outputItems.push(item);
                    controller.enqueue(emit("response.output_item.added", {
                      type: "response.output_item.added",
                      output_index: textItemOutputIndex,
                      item,
                    }));
                  }
                }
              }

              if (data.type === "content_block_delta") {
                const delta = data.delta;

                if (delta?.type === "text_delta") {
                  if (!sentTextItemAdded) {
                    sentTextItemAdded = true;
                    textItemOutputIndex = outputIndex++;
                    textItemId = `${responseId}_msg`;
                    const item = {
                      id: textItemId,
                      type: "message",
                      status: "in_progress",
                      role: "assistant",
                      content: [],
                    };
                    outputItems.push(item);
                    controller.enqueue(emit("response.output_item.added", {
                      type: "response.output_item.added",
                      output_index: textItemOutputIndex,
                      item,
                    }));
                  }
                  textContent += delta.text || "";
                  controller.enqueue(emit("response.output_text.delta", {
                    type: "response.output_text.delta",
                    item_id: textItemId,
                    output_index: textItemOutputIndex,
                    content_index: 0,
                    delta: delta.text || "",
                  }));
                }

                if (delta?.type === "thinking_delta") {
                  thinkingContent += delta.thinking || "";
                  controller.enqueue(emit("response.reasoning_summary_text.delta", {
                    type: "response.reasoning_summary_text.delta",
                    item_id: thinkingItemId || `rs_${responseId}`,
                    output_index: thinkingOutputIndex >= 0 ? thinkingOutputIndex : 0,
                    summary_index: 0,
                    delta: delta.thinking || "",
                  }));
                }

                if (delta?.type === "input_json_delta") {
                  toolCallArgs += delta.partial_json || "";
                  controller.enqueue(emit("response.function_call_arguments.delta", {
                    type: "response.function_call_arguments.delta",
                    item_id: toolCallId || `call_0`,
                    output_index: toolCallOutputIndex >= 0 ? toolCallOutputIndex : 0,
                    delta: delta.partial_json || "",
                  }));
                }
              }

              if (data.type === "content_block_stop") {
                if (currentBlockType === "tool_use" && toolCallId) {
                  // Emit function_call_arguments.done with "arguments" field (not "delta")
                  // — the OpenAI Responses API spec uses "arguments" here.
                  controller.enqueue(emit("response.function_call_arguments.done", {
                    type: "response.function_call_arguments.done",
                    item_id: toolCallId,
                    output_index: toolCallOutputIndex,
                    arguments: toolCallArgs,
                  }));
                  const existingItem = outputItems.find((o: any) => o.call_id === toolCallId);
                  if (existingItem) {
                    existingItem.arguments = toolCallArgs;
                    existingItem.status = "completed";
                  }
                  // Emit output_item.done to signal the item is finalized.
                  if (existingItem) {
                    emitOutputItemDone(toolCallOutputIndex, existingItem);
                  }
                }

                if (currentBlockType === "text" && sentTextItemAdded) {
                  // Emit output_text.done and output_item.done for text block.
                  controller.enqueue(emit("response.output_text.done", {
                    type: "response.output_text.done",
                    item_id: textItemId,
                    output_index: textItemOutputIndex,
                    content_index: 0,
                    text: textContent,
                  }));
                  const textItem = outputItems.find((o: any) => o.type === "message");
                  if (textItem) {
                    textItem.content = [{ type: "output_text", text: textContent }];
                    emitOutputItemDone(textItemOutputIndex, textItem);
                  }
                }

                if (currentBlockType === "thinking" && sentThinkingItemAdded) {
                  const thinkItem = outputItems.find((o: any) => o.type === "reasoning");
                  if (thinkItem) {
                    thinkItem.summary = [{ type: "summary_text", text: thinkingContent }];
                    emitOutputItemDone(thinkingOutputIndex, thinkItem);
                  }
                }

                currentBlockType = null;
              }

              if (data.type === "message_delta") {
                const completedEvent = emitCompleted(data.usage);
                if (completedEvent) {
                  controller.enqueue(completedEvent);
                }
              }

              if (data.type === "message_stop") {
                // Ensure response.completed is always emitted before [DONE].
                const completedEvent = emitCompleted();
                if (completedEvent) {
                  controller.enqueue(completedEvent);
                }
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              }
            }
          }

          // Stream ended — if we never saw message_stop, still emit response.completed.
          ensureCreated();
          const finalCompleted = emitCompleted();
          if (finalCompleted) {
            controller.enqueue(finalCompleted);
          }

          buffer = "";
          controller.close();
        } catch (e) {
          controller.error(e);
        }
      },
    });
  }

  private wrapChatInResponses(chatJson: any): any {
    const choice = chatJson?.choices?.[0];
    const output: any[] = [];

    // Text message output
    const content: any[] = [];
    if (choice?.message?.content) {
      content.push({ type: "output_text", text: choice.message.content });
    }
    output.push({ type: "message", role: "assistant", content });

    // Function call outputs (tool_calls)
    if (Array.isArray(choice?.message?.tool_calls)) {
      for (const tc of choice.message.tool_calls) {
        output.push({
          type: "function_call",
          id: tc.id,
          call_id: tc.id,
          name: tc.function?.name || "",
          arguments: tc.function?.arguments || "{}",
        });
      }
    }

    return {
      id: chatJson.id || `resp_${Date.now()}`,
      object: "response",
      model: chatJson.model,
      output,
      usage: chatJson.usage ? {
        ...this.buildResponsesUsage(chatJson.usage),
      } : undefined,
    };
  }
  private convertResponseToChat(responseData: ResponsesAPIPayload): any {
    // 从output数组中提取不同类型的输出
    const messageOutput = responseData.output?.find(
      (item) => item.type === "message"
    );
    let annotations;
    if (
      messageOutput?.content?.length &&
      messageOutput?.content[0].annotations
    ) {
      annotations = messageOutput.content[0].annotations.map((item) => {
        return {
          type: "url_citation",
          url_citation: {
            url: item.url || "",
            title: item.title || "",
            content: "",
            start_index: item.start_index || 0,
            end_index: item.end_index || 0,
          },
        };
      });
    }

    this.logger.debug({
      data: annotations,
      type: "url_citation",
    });

    let messageContent: string | MessageContent[] | null = null;
    let toolCalls = null;
    let thinking = null;

    // 处理推理内容
    if (messageOutput && messageOutput.reasoning) {
      thinking = {
        content: messageOutput.reasoning,
      };
    }

    if (messageOutput && messageOutput.content) {
      // 分离文本和图片内容
      const textParts: string[] = [];
      const imageParts: MessageContent[] = [];

      messageOutput.content.forEach((item: any) => {
        if (item.type === "output_text") {
          textParts.push(item.text || "");
        } else if (item.type === "output_image") {
          const imageContent = this.buildImageContent({
            url: item.image_url,
            mime_type: item.mime_type,
          });
          if (imageContent) {
            imageParts.push(imageContent);
          }
        } else if (item.type === "output_image_base64") {
          const imageContent = this.buildImageContent({
            b64_json: item.image_base64,
            mime_type: item.mime_type,
          });
          if (imageContent) {
            imageParts.push(imageContent);
          }
        }
      });

      // 构建最终内容
      if (imageParts.length > 0) {
        // 如果有图片，将所有内容组合成数组
        const contentArray: MessageContent[] = [];
        if (textParts.length > 0) {
          contentArray.push({
            type: "text",
            text: textParts.join(""),
          });
        }
        contentArray.push(...imageParts);
        messageContent = contentArray;
      } else {
        // 如果只有文本，返回字符串
        messageContent = textParts.join("");
      }
    }

    // EVERY function call must survive, not only the first one: a Responses
    // turn routinely issues several parallel tool calls, and keeping just the
    // first silently dropped the rest of the work.
    const functionCallOutputs = (responseData.output ?? []).filter(
      (item: any) => item.type === "function_call"
    );
    if (functionCallOutputs.length > 0) {
      toolCalls = functionCallOutputs.map((call: any) => ({
        id: call.call_id || call.id,
        type: "function",
        function: {
          name: call.name,
          arguments: call.arguments,
        },
      }));
    }

    // 构建chat格式的响应
    const chatResponse = {
      id: responseData.id || "chatcmpl-" + Date.now(),
      object: "chat.completion",
      created: responseData.created_at,
      model: responseData.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: messageContent || null,
            tool_calls: toolCalls,
            thinking: thinking,
            annotations: annotations,
          },
          logprobs: null,
          finish_reason: toolCalls ? "tool_calls" : "stop",
        },
      ],
      usage: responseData.usage
        ? {
            prompt_tokens: responseData.usage.input_tokens || 0,
            completion_tokens: responseData.usage.output_tokens || 0,
            total_tokens: responseData.usage.total_tokens || 0,
            prompt_tokens_details: {
              cached_tokens: this.getCacheReadInputTokens(responseData.usage),
              cache_creation_tokens: this.getCacheCreationInputTokens(responseData.usage),
            },
            cache_read_input_tokens: this.getCacheReadInputTokens(responseData.usage),
            cache_creation_input_tokens: this.getCacheCreationInputTokens(responseData.usage),
          }
        : null,
    };

    return chatResponse;
  }

  private buildImageContent(source: {
    url?: string;
    b64_json?: string;
    mime_type?: string;
  }): MessageContent | null {
    if (!source) return null;

    if (source.url || source.b64_json) {
      return {
        type: "image_url",
        image_url: {
          url: source.url || "",
          b64_json: source.b64_json,
        },
        media_type: source.mime_type,
      } as MessageContent;
    }

    return null;
  }
}
