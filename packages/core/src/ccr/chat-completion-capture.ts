import { createParser } from "eventsource-parser";
import { mergeUsageCapture, normalizeUsagePayload } from "./usage-merge";
import { isRateLimitMessage } from "../services/rate-limit";
import type { Usage } from "../utils/cache";

export interface ChatCompletionCapture {
  usage?: Usage & { usage_estimated?: boolean };
  ttft?: number;
  finished?: boolean;
  streamError?: boolean;
  rateLimited?: boolean;
  // A stable, code-shaped error identifier from the SSE error frame, if it
  // carried one. Free-form upstream text is deliberately NOT kept: usage rows
  // and health messages must never echo upstream prose.
  streamErrorCode?: string;
  // The latest upstream response, shared by primary and fallback request copies.
  // Failover clears it once it books that provider.
  unbookedAttempt?: { provider: string; model: string };
  model?: string;
}

export function hasChatFinishReason(choice: { finish_reason?: unknown } | null): boolean {
  return typeof choice?.finish_reason === "string" && choice.finish_reason.trim().length > 0;
}

/** A stable error code, or undefined for anything that is not one. Upstream
 * prose, nested objects and unknown shapes all yield undefined: only a short
 * snake_case/lowercase identifier survives, so a provider's own code reaches
 * the usage row without its message. */
type ErrorFrame = { error?: { code?: unknown } } | undefined;

function safeParse(text: string): ErrorFrame {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? parsed as ErrorFrame : undefined;
  } catch {
    return undefined;
  }
}

function errorCodeOf(frame: ErrorFrame): string | undefined {
  const code = (frame as { error?: { code?: unknown } })?.error?.code;
  if (typeof code !== "string") return undefined;
  const trimmed = code.trim();
  return /^[a-z][a-z0-9_]{0,63}$/.test(trimmed) ? trimmed : undefined;
}

// Observe the bytes Fastify actually sends. A usage trailer may follow the
// finish choice, and [DONE] by itself does not finish a truncated answer.
export function captureChatStream(capture: ChatCompletionCapture, startTime: number) {
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
    if (event === "error") {
      capture.streamError = true;
      capture.streamErrorCode ??= errorCodeOf(safeParse(data));
      capture.rateLimited ||= isRateLimitMessage(200, data);
      return;
    }
    let frame;
    try {
      frame = JSON.parse(data);
    } catch {
      return;
    }
    if (frame?.error || frame?.type === "error") {
      capture.streamError = true;
      capture.streamErrorCode ??= errorCodeOf(frame);
      capture.rateLimited ||= isRateLimitMessage(200, data);
      return;
    }
    if (typeof frame?.model === "string" && frame.model.trim() && frame.model !== "unknown") {
      capture.model ??= frame.model;
    }
    if (frame?.usage) capture.usage = mergeUsageCapture(capture.usage, normalizeUsagePayload(frame.usage), false);
    if (!Array.isArray(frame?.choices)) return;
    for (const choice of frame.choices) {
      const index = choice?.index ?? 0;
      const finished = hasChatFinishReason(choice);
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
