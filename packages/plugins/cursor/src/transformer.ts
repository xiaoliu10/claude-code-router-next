import { classifyCursorError } from "./protocol";
import type { PluginClassifiedError } from "./core-types";

/** Runs alone: the core's chat-completions pipeline is already unified→chat. */

/** Terminal quota/auth observations for the runtime's account bookkeeping. Never throws into the response path. */
export type CursorStreamNote = (info: PluginClassifiedError) => unknown;
export type CursorStreamHeal = () => unknown;

/**
 * Unified request → the chat-completions body the vendored engine's answer()
 * speaks. Mirrors the engine's own conversation() conventions: system becomes
 * a leading system message, stringy thinking becomes reasoning_content
 * (null/blank reasoning never rides the wire), the stable session id becomes
 * prompt_cache_key — which the engine folds into a stable conversation_id so
 * Cursor keeps the conversation's cache on one machine — and reasoning effort
 * passes through as reasoning_effort. Remote-URL user images become placeholder
 * text (Cursor's transcript only carries data-URL images); data-URL user
 * images ride as-is. Tool-call/result graphs keep their ids: the engine's
 * native continuation resumes the same Run for them.
 */
function cursorRequest(request: any, context?: any): any {
  const body = structuredClone(request ?? {});
  const reasoning = body.reasoning;
  delete body.system;
  delete body.reasoning;
  // Apply the same cap to caller-provided keys and context-derived sessions.
  delete body.prompt_cache_key;
  body.messages = (request?.messages ?? []).map((message: any) => {
    const { thinking, ...next } = message;
    delete next.thinking;
    if (thinking && typeof thinking.content === "string" && thinking.content) next.reasoning_content = thinking.content;
    // Null/non-string/blank reasoning never rides the wire.
    else if (typeof next.reasoning_content !== "string" || !next.reasoning_content) delete next.reasoning_content;
    // Cursor transcripts carry data-URL images; a remote URL cannot be put
    // into one, so it becomes the same placeholder text the engine's own
    // conversation() would make of it.
    if (Array.isArray(next.content)) {
      next.content = next.content.map((part: any) => {
        if (part?.type !== "image_url") return part;
        const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url ?? "";
        if (/^data:[^;,]+;base64,/.test(url)) return part;
        return { type: "text", text: `[attachment image: ${url}]` };
      });
    }
    return next;
  });
  if (request?.system) {
    const text = typeof request.system === "string" ? request.system
      : Array.isArray(request.system) ? request.system.filter((p: any) => p?.type === "text").map((p: any) => p.text).join("\n") : "";
    if (text) body.messages.unshift({ role: "system", content: text });
  }
  const session = request?.prompt_cache_key ?? context?.req?.clientContext?.stableSessionId;
  if (typeof session === "string" && session && session.length <= 1024) body.prompt_cache_key = session;
  if (reasoning?.effort) body.reasoning_effort = reasoning.effort;
  return body;
}

function mapMessage(message: any) {
  if (!message || typeof message !== "object") return;
  if (typeof message.reasoning_content === "string") {
    message.thinking = { content: message.reasoning_content };
    delete message.reasoning_content;
  }
}
/**
 * Usage boundary convention (verified at the engine's emission sites,
 * decode.finish and NativeSession.complete): Chat `prompt_tokens` is
 * INCLUSIVE of cached and cache-written input, i.e. net rest + cacheRead +
 * cacheWrite — upstream already rebuilds the inclusive prompt. The core's
 * usage normalization subtracts exactly `prompt_tokens_details.cached_tokens`
 * from an inclusive Chat prompt to reach Anthropic-style net input. The
 * mapping here is therefore deliberately IDENTITY on prompt counters:
 * re-adding the cache counts would double-count them after the core's
 * subtraction, and subtracting anything here would double-subtract (the
 * review lesson from the lost first implementation). `cache_write_tokens` is
 * mirrored to `cache_creation_input_tokens`; deferred/marker counts
 * (magpie_deferred, magpie_native) pass through verbatim. A net-emitting
 * vendor regression IS detectable when prompt sits below its own cache
 * detail: inclusivity is restored by adding the cache counts instead of
 * letting the core subtract below the reported rest.
 */
function mapUsage(usage: any) {
  if (!usage || typeof usage !== "object") return;
  const cached = usage.prompt_tokens_details?.cached_tokens;
  const written = usage.prompt_tokens_details?.cache_write_tokens;
  if (Number.isFinite(usage.prompt_tokens) && Number.isFinite(cached) && Number.isFinite(written) &&
    usage.prompt_tokens < cached + written) usage.prompt_tokens += cached + written;
  if (Number.isFinite(written)) usage.cache_creation_input_tokens = written;
}

/**
 * Classify one SSE error frame ({error:{message,code}} as the engine's
 * answer() emits). The engine already folded upstream failures into HTTP
 * statuses, so the numeric code leads and message text only breaks ties;
 * the frame carries no retry_after, so the 429 cooldown is the default.
 */
function frameInfo(raw: any): PluginClassifiedError {
  return classifyCursorError(Number(raw?.code ?? raw?.status ?? 0), { error: raw });
}

function mapChunk(event: any) {
  if (event?.error) {
    const info = frameInfo(event.error);
    throw Object.assign(new Error(info.code), { code: info.code, statusCode: info.httpStatus, nonRetryable: !info.retryable,
      ...(info.cooldownMs ? { cooldownMs: info.cooldownMs } : {}) });
  }
  for (const c of event?.choices ?? []) { mapMessage(c.message); mapMessage(c.delta); }
  mapUsage(event?.usage);
  return event;
}

/** Never throws into the response path; promise rejections are swallowed. */
function fire(callback: ((...args: any[]) => unknown) | undefined, ...args: any[]): void {
  try {
    const noted = callback?.(...args);
    if (noted && typeof (noted as Promise<void>).then === "function") (noted as Promise<void>).then(undefined, () => {});
  } catch { /* bookkeeping never masks the stream failure */ }
}

/**
 * Inspect the entire stream: late error frames and early EOF must fail, too.
 * [DONE] is only forwarded when a finish_reason AND visible content arrived —
 * for Cursor that is text, reasoning or tool_calls (a tool step ends with
 * tool_calls and no prose) — and that validated completion is the only stream
 * shape that heals latched account state.
 */
export async function cursorResponse(response: Response, note?: CursorStreamNote, heal?: CursorStreamHeal): Promise<Response> {
  if (!response.ok) {
    let body: unknown;
    try { body = await response.json(); } catch { /* classify on status alone */ }
    // Same taxonomy as the runtime's classifyError seam (contract).
    const info = classifyCursorError(response.status, body);
    await response.body?.cancel().catch(() => {});
    throw Object.assign(new Error(info.code), { code: info.code, statusCode: info.httpStatus,
      nonRetryable: !info.retryable, ...(info.cooldownMs ? { cooldownMs: info.cooldownMs } : {}) });
  }
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  if (!headers.get("content-type")?.includes("text/event-stream")) {
    let event: any;
    try { event = mapChunk(await response.json()); } catch (error: any) { throw error?.code ? error : classified("cursor_upstream_error", 502); }
    const message = event?.choices?.[0]?.message;
    if (!message || !(message.content || message.tool_calls?.length)) throw classified("cursor_upstream_error", 502);
    // A validated non-stream completion is whole evidence: heal the latch.
    fire(heal);
    return Response.json(event, { headers });
  }
  if (!response.body) throw classified("cursor_stream_truncated", 502);
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true }); const encoder = new TextEncoder();
  let pending = "", done = false, finished = false, visible = false, healed = false;
  // Running UTF-8 byte size of `pending`: incremented with each raw chunk
  // (decoded text re-encodes to exactly the consumed bytes) and decremented
  // with each consumed frame, so no per-read re-encode of the buffer is needed.
  let pendingBytes = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (true) {
          const boundary = /\r\n\r\n|\n\n|\r\r/.exec(pending);
          if (boundary) {
            // Bound every COMPLETE frame in bytes, before JSON.parse; the
            // running pending cap alone admits a single delimited 1.1 MB frame.
            const raw = pending.slice(0, boundary.index);
            const frameBytes = encoder.encode(raw).byteLength;
            if (frameBytes > 1_048_576) throw classified("cursor_stream_invalid", 502);
            pending = pending.slice(boundary.index + boundary[0].length);
            pendingBytes -= frameBytes + boundary[0].length;
            const data = raw.split(/\r\n|\n|\r/).filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n");
            if (!data) continue;
            if (data === "[DONE]") {
              if (!finished || !visible) throw classified("cursor_stream_truncated", 502);
              done = true;
              if (!healed) { healed = true; fire(heal); }
              await reader.cancel(); controller.enqueue(encoder.encode("data: [DONE]\n\n")); controller.close(); return;
            }
            let event: any;
            try { event = mapChunk(JSON.parse(data)); }
            catch (error: any) {
              if (typeof error?.code === "string" && error.code.startsWith("cursor_")) {
                // Classify from upstream evidence, never flatten (qoder parity):
                // the note reaches the service exactly like an HTTP failure.
                fire(note, { code: error.code, httpStatus: error.statusCode, retryable: !error.nonRetryable,
                  ...(error.cooldownMs ? { cooldownMs: error.cooldownMs } : {}) });
              }
              throw error;
            }
            for (const c of event.choices ?? []) {
              const reasoningVisible = typeof c.delta?.reasoning_content === "string" && c.delta.reasoning_content.length > 0;
              if (reasoningVisible || c.delta?.content || c.delta?.tool_calls?.length) visible = true;
              if (c.finish_reason) finished = true;
            }
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)); return;
          }
          if (pending.length > 1_048_576) throw classified("cursor_stream_invalid", 502);
          const next = await reader.read();
          if (next.done) { pending += decoder.decode(); if (!done) throw classified("cursor_stream_truncated", 502); controller.close(); return; }
          pending += decoder.decode(next.value, { stream: true });
          pendingBytes += next.value.byteLength;
          if (pendingBytes > 2_097_152) throw classified("cursor_stream_invalid", 502);
        }
      } catch (error) {
        await reader.cancel().catch(() => {});
        controller.error(error);
      }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  return new Response(stream, { headers });
}

function classified(code: string, status: number): Error {
  return Object.assign(new Error(code), { code, statusCode: status, nonRetryable: true });
}

/**
 * The transformer never rewrites bodies through the engine (no engine call
 * here — the data plane is the engine lane's answer() transaction, which the
 * managed runtime owns). The engine parameter exists for activation parity
 * with qoder's transformer wiring; all stream evidence flows through
 * note/heal.
 */
export class CursorTransformer {
  static TransformerName = "cursor";
  name = "cursor";
  constructor(private readonly engine?: unknown, private readonly note?: CursorStreamNote, private readonly heal?: CursorStreamHeal) {}
  async transformRequestIn(request: any, _provider?: any, context?: any): Promise<{ body: any }> {
    return { body: cursorRequest(request, context) };
  }
  async transformResponseOut(response: Response): Promise<Response> {
    return cursorResponse(response, this.note, this.heal);
  }
}
