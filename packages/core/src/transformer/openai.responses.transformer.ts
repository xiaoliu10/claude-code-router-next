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
    output?: Array<{
      type: string;
    }>;
  };
  reasoning_summary?: string; // 添加推理摘要支持
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

      input.push(message);
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

  async transformResponseOut(response: Response): Promise<Response> {
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
        return this.transformResponseOut(rebuilt);
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
        return this.transformResponseOut(rebuilt);
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
          return this.transformResponseOut(drained.response);
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
      try {
        const { value, done } = await peekReader.read();
        if (!done && value) {
          firstChunk = new TextDecoder().decode(value);
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

      // Also pass through if the upstream already speaks Responses API natively.
      // The downstream transformResponseIn will detect and handle it.
      const isAlreadyResponsesAPI = firstChunk.includes("response.created") ||
        firstChunk.includes("response.output_text.delta") ||
        firstChunk.includes("response.in_progress") ||
        firstChunk.includes("response.output_item.added");
      if (isAlreadyResponsesAPI) {
        return new Response(bodyStream, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }

      // OpenAI Chat SSE — proceed with Responses API → Chat conversion below.
      // bodyStream still contains the peeked first chunk, so feed it straight
      // into the converter without re-prepending anything.

      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      let buffer = ""; // Buffer for incomplete lines
      let isStreamEnded = false;

      const transformer = this;
      const stream = new ReadableStream({
        async start(controller) {
          const reader = bodyStream.getReader();

          // Index tracking — only increments when event type changes
          let currentIndex = -1;
          let lastEventType = "";

          const getCurrentIndex = (eventType: string) => {
            if (eventType !== lastEventType) {
              currentIndex++;
              lastEventType = eventType;
            }
            return currentIndex;
          };

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                if (!isStreamEnded) {
                  // 发送结束标记
                  const doneChunk = `data: [DONE]\n\n`;
                  controller.enqueue(encoder.encode(doneChunk));
                }
                break;
              }

              const chunk = decoder.decode(value, { stream: true });
              buffer += chunk;

              // 处理缓冲区中完整的数据行
              let lines = buffer.split(/\r?\n/);
              buffer = lines.pop() || ""; // 最后一行可能不完整，保留在缓冲区

              for (const line of lines) {
                if (!line.trim()) continue;

                try {
                  if (line.startsWith("event: ")) {
                    // 处理事件行，暂存以便与下一行数据配对
                    continue;
                  } else if (line.startsWith("data: ")) {
                    const dataStr = line.slice(5).trim(); // 移除 "data: " 前缀
                    if (dataStr === "[DONE]") {
                      isStreamEnded = true;
                      controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
                      continue;
                    }

                    try {
                      const data: ResponsesStreamEvent = JSON.parse(dataStr);

                      // 根据不同的事件类型转换为chat格式
                      if (data.type === "response.output_text.delta") {
                        // 将output_text.delta转换为chat格式
                        const chatChunk = {
                          id: data.item_id || "chatcmpl-" + Date.now(),
                          object: "chat.completion.chunk",
                          created: Math.floor(Date.now() / 1000),
                          model: data.response?.model,
                          choices: [
                            {
                              index: getCurrentIndex(data.type),
                              delta: {
                                content: data.delta || "",
                              },
                              finish_reason: null,
                            },
                          ],
                        };

                        controller.enqueue(
                          encoder.encode(
                            `data: ${JSON.stringify(chatChunk)}\n\n`
                          )
                        );
                      } else if (
                        data.type === "response.output_item.added" &&
                        data.item?.type === "function_call"
                      ) {
                        // 处理function call开始 - 创建初始的tool call chunk
                        const functionCallChunk = {
                          id:
                            data.item.call_id ||
                            data.item.id ||
                            "chatcmpl-" + Date.now(),
                          object: "chat.completion.chunk",
                          created: Math.floor(Date.now() / 1000),
                          model: data.response?.model || "gpt-5-codex-",
                          choices: [
                            {
                              index: getCurrentIndex(data.type),
                              delta: {
                                role: "assistant",
                                tool_calls: [
                                  {
                                    index: 0,
                                    id: data.item.call_id || data.item.id,
                                    function: {
                                      name: data.item.name || "",
                                      arguments: "",
                                    },
                                    type: "function",
                                  },
                                ],
                              },
                              finish_reason: null,
                            },
                          ],
                        };

                        controller.enqueue(
                          encoder.encode(
                            `data: ${JSON.stringify(functionCallChunk)}\n\n`
                          )
                        );
                      } else if (
                        data.type === "response.output_item.added" &&
                        data.item?.type === "message"
                      ) {
                        // 处理message item added事件
                        const contentItems: MessageContent[] = [];
                        (data.item.content || []).forEach((item: any) => {
                          if (item.type === "output_text") {
                            contentItems.push({
                              type: "text",
                              text: item.text || "",
                            });
                          }
                        });

                        const delta: any = { role: "assistant" };
                        if (
                          contentItems.length === 1 &&
                          contentItems[0].type === "text"
                        ) {
                          delta.content = contentItems[0].text;
                        } else if (contentItems.length > 0) {
                          delta.content = contentItems;
                        }
                        if (delta.content) {
                          const messageChunk = {
                            id: data.item.id || "chatcmpl-" + Date.now(),
                            object: "chat.completion.chunk",
                            created: Math.floor(Date.now() / 1000),
                            model: data.response?.model,
                            choices: [
                              {
                                index: getCurrentIndex(data.type),
                                delta,
                                finish_reason: null,
                              },
                            ],
                          };

                          controller.enqueue(
                            encoder.encode(
                              `data: ${JSON.stringify(messageChunk)}\n\n`
                            )
                          );
                        }
                      } else if (
                        data.type === "response.output_text.annotation.added"
                      ) {
                        const annotationChunk = {
                          id: data.item_id || "chatcmpl-" + Date.now(),
                          object: "chat.completion.chunk",
                          created: Math.floor(Date.now() / 1000),
                          model: data.response?.model || "gpt-5-codex",
                          choices: [
                            {
                              index: getCurrentIndex(data.type),
                              delta: {
                                annotations: [
                                  {
                                    type: "url_citation",
                                    url_citation: {
                                      url: data.annotation?.url || "",
                                      title: data.annotation?.title || "",
                                      content: "",
                                      start_index:
                                        data.annotation?.start_index || 0,
                                      end_index:
                                        data.annotation?.end_index || 0,
                                    },
                                  },
                                ],
                              },
                              finish_reason: null,
                            },
                          ],
                        };

                        controller.enqueue(
                          encoder.encode(
                            `data: ${JSON.stringify(annotationChunk)}\n\n`
                          )
                        );
                      } else if (
                        data.type === "response.function_call_arguments.delta"
                      ) {
                        // 处理function call参数增量
                        const functionCallChunk = {
                          id: data.item_id || "chatcmpl-" + Date.now(),
                          object: "chat.completion.chunk",
                          created: Math.floor(Date.now() / 1000),
                          model: data.response?.model || "gpt-5-codex-",
                          choices: [
                            {
                              index: getCurrentIndex(data.type),
                              delta: {
                                tool_calls: [
                                  {
                                    index: 0,
                                    function: {
                                      arguments: data.delta || "",
                                    },
                                  },
                                ],
                              },
                              finish_reason: null,
                            },
                          ],
                        };

                        controller.enqueue(
                          encoder.encode(
                            `data: ${JSON.stringify(functionCallChunk)}\n\n`
                          )
                        );
                      } else if (data.type === "response.completed") {
                        // 发送结束标记 - 检查是否是tool_calls完成
                        const finishReason = data.response?.output?.some(
                          (item: any) => item.type === "function_call"
                        )
                          ? "tool_calls"
                          : "stop";

                        const endChunk = {
                          id: data.response?.id || "chatcmpl-" + Date.now(),
                          object: "chat.completion.chunk",
                          created: Math.floor(Date.now() / 1000),
                          model: data.response?.model || "gpt-5-codex-",
                          choices: [
                            {
                              index: 0,
                              delta: {},
                              finish_reason: finishReason,
                            },
                          ],
                        };

                        controller.enqueue(
                          encoder.encode(
                            `data: ${JSON.stringify(endChunk)}\n\n`
                          )
                        );
                        isStreamEnded = true;
                      } else if (
                        data.type === "response.reasoning_summary_text.delta"
                      ) {
                        // 处理推理文本，将其转换为 thinking delta 格式
                        const thinkingChunk = {
                          id: data.item_id || "chatcmpl-" + Date.now(),
                          object: "chat.completion.chunk",
                          created: Math.floor(Date.now() / 1000),
                          model: data.response?.model,
                          choices: [
                            {
                              index: getCurrentIndex(data.type),
                              delta: {
                                thinking: {
                                  content: data.delta || "",
                                },
                              },
                              finish_reason: null,
                            },
                          ],
                        };

                        controller.enqueue(
                          encoder.encode(
                            `data: ${JSON.stringify(thinkingChunk)}\n\n`
                          )
                        );
                      } else if (
                        data.type === "response.reasoning_summary_part.done" &&
                        data.part
                      ) {
                        const thinkingChunk = {
                          id: data.item_id || "chatcmpl-" + Date.now(),
                          object: "chat.completion.chunk",
                          created: Math.floor(Date.now() / 1000),
                          model: data.response?.model,
                          choices: [
                            {
                              index: currentIndex,
                              delta: {
                                thinking: {
                                  signature: data.item_id,
                                },
                              },
                              finish_reason: null,
                            },
                          ],
                        };

                        controller.enqueue(
                          encoder.encode(
                            `data: ${JSON.stringify(thinkingChunk)}\n\n`
                          )
                        );
                      }
                    } catch (e) {
                      // 如果JSON解析失败，传递原始行
                      controller.enqueue(encoder.encode(line + "\n"));
                    }
                  } else {
                    // 传递其他行
                    controller.enqueue(encoder.encode(line + "\n"));
                  }
                } catch (error) {
                  console.error("Error processing line:", line, error);
                  // 如果解析失败，直接传递原始行
                  controller.enqueue(encoder.encode(line + "\n"));
                }
              }
            }

            // 处理缓冲区中剩余的数据
            if (buffer.trim()) {
              controller.enqueue(encoder.encode(buffer + "\n"));
            }

            // 确保流结束时发送结束标记
            if (!isStreamEnded) {
              const doneChunk = `data: [DONE]\n\n`;
              controller.enqueue(encoder.encode(doneChunk));
            }
          } catch (error) {
            console.error("Stream error:", error);
            controller.error(error);
          } finally {
            try {
              reader.releaseLock();
            } catch (e) {
              console.error("Error releasing reader lock:", e);
            }
            controller.close();
          }
        },
      });

      return new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": "*",
        },
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
        const { value, done } = await reader.read();
        if (!done && value) {
          firstChunk = new TextDecoder().decode(value);
        }
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
      // Pass it through unchanged so Codex can parse it directly.
      const isResponsesAPI = firstChunk.includes("response.created") ||
        firstChunk.includes("response.output_text.delta") ||
        firstChunk.includes("response.in_progress") ||
        firstChunk.includes("response.output_item.added");

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
    const functionCallOutput = responseData.output?.find(
      (item) => item.type === "function_call"
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

    if (functionCallOutput) {
      // 处理function_call类型的输出
      toolCalls = [
        {
          id: functionCallOutput.call_id || functionCallOutput.id,
          function: {
            name: functionCallOutput.name,
            arguments: functionCallOutput.arguments,
          },
          type: "function",
        },
      ];
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
