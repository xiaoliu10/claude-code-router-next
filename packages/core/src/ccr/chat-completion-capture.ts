import { createParser } from "eventsource-parser";
import { mergeUsageCapture, normalizeUsagePayload } from "./usage-merge";
import type { Usage } from "../utils/cache";

export interface ChatCompletionCapture {
  usage?: Usage & { usage_estimated?: boolean };
  ttft?: number;
  stream?: boolean;
  finished?: boolean;
  error?: string;
  model?: string;
}

// Observe the bytes Fastify actually sends. A usage trailer may follow the
// finish choice, and [DONE] by itself does not finish a truncated answer.
export function captureChatStream(capture: ChatCompletionCapture, startTime: number) {
  capture.stream = true;
  const decoder = new TextDecoder();
  const choices = new Map<number, boolean>();
  let endsWithCR = false;
  let sawDone = false;
  const parser = createParser({ onEvent({ event, data }) {
    if (sawDone) return;
    if (data === "[DONE]") {
      sawDone = true;
      return;
    }
    if (event === "error") capture.error = "Chat stream returned an error";
    let frame;
    try {
      frame = JSON.parse(data);
    } catch {
      return;
    }
    if (frame?.error || frame?.type === "error") {
      const message = frame.error?.message;
      capture.error = typeof message === "string" && message ? message : "Chat stream returned an error";
      return;
    }
    if (typeof frame?.model === "string" && frame.model.trim() && frame.model !== "unknown") {
      capture.model ??= frame.model;
    }
    if (frame?.usage) capture.usage = mergeUsageCapture(capture.usage, normalizeUsagePayload(frame.usage), false);
    if (!Array.isArray(frame?.choices)) return;
    for (const choice of frame.choices) {
      const index = choice?.index ?? 0;
      const finished = typeof choice?.finish_reason === "string" && choice.finish_reason.trim().length > 0;
      if (!choices.get(index)) choices.set(index, finished);
      const delta = choice?.delta;
      if (delta?.content || delta?.reasoning_content || delta?.tool_calls?.length || delta?.function_call) {
        capture.ttft ??= Math.round(performance.now() - startTime);
      }
    }
  } });
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const text = decoder.decode(chunk, { stream: true });
      if (text) endsWithCR = text.endsWith("\r");
      parser.feed(text);
      controller.enqueue(chunk);
    },
    flush() {
      const tail = decoder.decode();
      // Resolve the parser's pending CR delimiter without terminating a partial data line.
      parser.feed(!tail && endsWithCR ? "\n" : tail);
      capture.finished = choices.size > 0 && [...choices.values()].every(Boolean);
    },
  });
}
