import type { Message, MessageStreamEvent, Usage } from "@anthropic-ai/sdk/resources/messages";
import type { LLMProvider } from "../types/llm";
import { mergeUsageCapture } from "../ccr/usage-merge";
import { isEventStreamResponse, parseResponseJson, peekBodyForSSE } from "./response-body";

type CacheMode = LLMProvider["cacheMode"];

function chatUsage(usage: Partial<Usage>, cacheMode: CacheMode) {
  const cached = usage.cache_read_input_tokens ?? 0;
  const written = usage.cache_creation_input_tokens ?? 0;
  const prompt = (usage.input_tokens ?? 0) + (cacheMode === "inclusive" ? 0 : cached + written);
  const completion = usage.output_tokens ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_tokens_details: { cached_tokens: cached, cache_creation_tokens: written },
  };
}

function finishReason(reason: string | null) {
  switch (reason) {
    case "tool_use": return "tool_calls";
    case "max_tokens":
    case "model_context_window_exceeded": return "length";
    case "refusal": return "content_filter";
    case "end_turn":
    case "pause_turn":
    case "stop_sequence": return "stop";
    default: throw new Error("Anthropic response has no recognized stop reason");
  }
}

function chatCompletion(message: Message, cacheMode: CacheMode) {
  if (message?.type !== "message" || !Array.isArray(message.content)) {
    throw new Error("Expected an Anthropic Messages response");
  }
  let content = "";
  let thinking = "";
  const tools = [];
  for (const block of message.content) {
    if (block.type === "text") content += block.text;
    if (block.type === "thinking") thinking += block.thinking;
    if (block.type === "tool_use") {
      tools.push({
        id: block.id,
        type: "function",
        function: { name: block.name, arguments: JSON.stringify(block.input) },
      });
    }
  }
  return {
    id: message.id,
    model: message.model,
    created: Math.floor(Date.now() / 1000),
    object: "chat.completion",
    choices: [{
      index: 0,
      finish_reason: finishReason(message.stop_reason),
      message: {
        role: "assistant",
        content: content || (tools.length ? null : ""),
        ...(thinking && { reasoning_content: thinking }),
        ...(tools.length && { tool_calls: tools }),
      },
    }],
    ...(message.usage && { usage: chatUsage(message.usage, cacheMode) }),
  };
}

function chatStream(body: ReadableStream<Uint8Array>, cacheMode: CacheMode, includeUsage: boolean) {
  const encoder = new TextEncoder();
  const envelope = { created: Math.floor(Date.now() / 1000), object: "chat.completion.chunk" };
  let identity: { id: string; model: string } | undefined;
  let usage: Partial<Usage> | undefined;
  let stopReason: string | null = null;
  let nextTool = 0;
  const tools = new Map<number, { index: number; hasArguments: boolean }>();
  let pendingLine = "";
  let previousEndedWithCR = false;
  let eventName = "";
  let dataLines: string[] = [];

  type Output = TransformStreamDefaultController<Uint8Array>;
  function emit(output: Output, data: unknown) {
    output.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
  }
  function chunk(output: Output, delta: Record<string, unknown>, finish: string | null = null) {
    if (!identity) throw new Error("Expected Anthropic message_start before a Chat chunk");
    emit(output, { ...identity, ...envelope, ...(includeUsage && { usage: null }), choices: [{ index: 0, delta, finish_reason: finish }] });
  }
  function handleEvent(event: MessageStreamEvent, output: Output) {
    switch (event.type) {
      case "message_start":
        identity = { id: event.message.id, model: event.message.model };
        usage = event.message.usage;
        chunk(output, { role: "assistant" });
        break;
      case "content_block_start": {
        const block = event.content_block;
        if (block.type === "text" && block.text) chunk(output, { content: block.text });
        if (block.type === "thinking" && block.thinking) chunk(output, { reasoning_content: block.thinking });
        if (block.type === "tool_use") {
          const index = nextTool++;
          // A native stream opens with input:{} and delivers the actual JSON in deltas.
          const args = block.input && Object.keys(block.input).length
            ? JSON.stringify(block.input)
            : "";
          tools.set(event.index, { index, hasArguments: !!args });
          chunk(output, { tool_calls: [{
            index, id: block.id, type: "function", function: { name: block.name, arguments: args },
          }] });
        }
        break;
      }
      case "content_block_delta": {
        const delta = event.delta;
        if (delta.type === "text_delta") chunk(output, { content: delta.text });
        if (delta.type === "thinking_delta") chunk(output, { reasoning_content: delta.thinking });
        if (delta.type === "input_json_delta") {
          const tool = tools.get(event.index);
          // Server-side tool blocks also carry input_json_delta. Only expose client tools.
          if (tool && delta.partial_json) {
            tool.hasArguments = true;
            chunk(output, { tool_calls: [{ index: tool.index, function: { arguments: delta.partial_json } }] });
          }
        }
        break;
      }
      case "content_block_stop": {
        const tool = tools.get(event.index);
        if (tool && !tool.hasArguments) {
          chunk(output, { tool_calls: [{ index: tool.index, function: { arguments: "{}" } }] });
        }
        tools.delete(event.index);
        break;
      }
      case "message_delta":
        stopReason = event.delta.stop_reason ?? stopReason;
        if (event.usage) usage = mergeUsageCapture(usage, event.usage, false);
        break;
      case "message_stop":
        chunk(output, {}, finishReason(stopReason));
        if (includeUsage && usage) {
          emit(output, { ...identity, ...envelope, choices: [], usage: chatUsage(usage, cacheMode) });
        }
        output.enqueue(encoder.encode("data: [DONE]\n\n"));
        output.terminate();
        return true;
    }
    return false;
  }

  return body.pipeThrough(new TextDecoderStream()).pipeThrough(new TransformStream<string, Uint8Array>({
    transform(text, output) {
      if (!text) return;
      // Consume CR immediately (it can delimit a complete final event). A
      // following LF belongs to the same delimiter, even across reads.
      if (previousEndedWithCR && text.startsWith("\n")) text = text.slice(1);
      previousEndedWithCR = text.endsWith("\r");
      const lines = (pendingLine + text).split(/\r\n|[\r\n]/);
      pendingLine = lines.pop()!;
      for (const line of lines) {
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
        if (line !== "") continue;
        if (dataLines.length) {
          const data = JSON.parse(dataLines.join("\n"));
          if (eventName === "error" || data.type === "error" || data.error) {
            emit(output, { error: data.error ?? { type: "upstream_error", message: "Anthropic stream failed" } });
            output.terminate();
            return;
          }
          if (handleEvent(data, output)) return;
        }
        dataLines = [];
        eventName = "";
      }
    },
    // Only a complete message_stop event commits the pending finish reason.
    // EOF (including a partial SSE frame) leaves the response incomplete.
  }));
}

export async function convertAnthropicChatResponse(
  response: Response,
  cacheMode: CacheMode,
  includeUsage: boolean
): Promise<Response> {
  const isStream = isEventStreamResponse(response);
  const peeked = isStream ? null : await peekBodyForSSE(response);
  if (isStream || peeked?.isSSE) {
    const body = peeked?.body ?? response.body;
    if (!body) throw new Error("Anthropic stream has no response body");
    return new Response(chatStream(body, cacheMode, includeUsage), {
      status: response.status,
      headers: { "content-type": "text/event-stream" },
    });
  }
  const message = await parseResponseJson(peeked ? new Response(peeked.body, { status: response.status }) : response);
  return Response.json(chatCompletion(message, cacheMode), { status: response.status });
}
