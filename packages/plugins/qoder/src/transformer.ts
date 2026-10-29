import type { QoderEngine } from "./vendor/engine.mjs";
import { classifyQoderError, qoderError } from "./protocol";

/** Runs alone: the core's chat-completions pipeline is already unified→chat. */
/** Terminal quota/auth observations for the runtime's account bookkeeping. Never throws into the response path. */
export type QoderStreamNote = (info: { code: string; httpStatus: number; cooldownMs?: number }) => unknown;
export type QoderStreamHeal = () => unknown;

/**
 * Unified thinking has no reusable Qoder signature. Tool/result IDs stay
 * intact. Mirrors cursor's cursorRequest: system becomes a leading system
 * message, stringy thinking becomes reasoning_content (null/blank reasoning
 * never rides the wire), the stable session id becomes prompt_cache_key and
 * reasoning effort passes through as reasoning_effort.
 */
function qoderRequest(request: any, context?: any): any {
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
 * Usage boundary convention (copied from cursor's mapUsage, verified at the
 * engine emission sites): Chat `prompt_tokens` is INCLUSIVE of cached and
 * cache-written input, i.e. net rest + cacheRead + cacheWrite. The core's
 * usage normalization subtracts exactly `prompt_tokens_details.cached_tokens`
 * from an inclusive Chat prompt to reach Anthropic-style net input. The
 * mapping here is therefore deliberately IDENTITY on prompt counters:
 * re-adding the cache counts would double-count them after the core's
 * subtraction, and subtracting anything here would double-subtract.
 * `cache_write_tokens` is mirrored to `cache_creation_input_tokens`; deferred
 * counts pass through verbatim. A net-emitting vendor regression IS
 * detectable when prompt sits below its own cache detail: inclusivity is
 * restored by adding the cache counts instead of letting the core subtract
 * below the reported rest.
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
 * retry_after in the frame (errorResponse parity) feeds the 429 cooldown.
 */
function frameInfo(raw: any): { code: string; httpStatus: number; cooldownMs?: number } {
  const status = Number(raw?.code ?? raw?.status ?? 0);
  const text = `${raw?.message ?? ""} ${raw?.type ?? ""}`.toLowerCase();
  if (status === 429 || /rate.?limit|usage.?limit|quota/.test(text)) {
    const seconds = Number(raw?.retry_after);
    return { code: "qoder_rate_limited", httpStatus: 429,
      cooldownMs: Number.isFinite(seconds) && seconds > 0 ? Math.min(Math.max(seconds * 1000, 30_000), 30 * 60_000) : 300_000 };
  }
  if (status === 401 || /unauthorized|invalid.?token|authentication|sign.?in/.test(text)) {
    return { code: "qoder_reauth_required", httpStatus: 401 };
  }
  return { code: "qoder_upstream_error", httpStatus: status >= 400 && status <= 599 ? status : 502 };
}

function mapChunk(event: any) {
  if (event?.error) {
    const info = frameInfo(event.error);
    throw Object.assign(new Error(info.code), { code: info.code, statusCode: info.httpStatus, nonRetryable: true,
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
 * and that validated completion is the only stream shape that heals latched
 * account state.
 */
export async function qoderResponse(response: Response, note?: QoderStreamNote, heal?: QoderStreamHeal): Promise<Response> {
  if (!response.ok) {
    let body: unknown;
    try { body = await response.json(); } catch { /* classify on status alone */ }
    // Same taxonomy as the runtime's classifyError seam (retry_after honored).
    const info = classifyQoderError(response.status, body);
    await response.body?.cancel().catch(() => {});
    throw Object.assign(new Error(info.code), { code: info.code, statusCode: info.httpStatus,
      nonRetryable: !info.retryable, ...(info.cooldownMs ? { cooldownMs: info.cooldownMs } : {}) });
  }
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  if (!headers.get("content-type")?.includes("text/event-stream")) {
    let event: any;
    try { event = mapChunk(await response.json()); } catch (error: any) { throw error?.code ? error : qoderError("qoder_upstream_error", 502); }
    const message = event?.choices?.[0]?.message;
    if (!message || !(message.content || message.tool_calls?.length)) throw qoderError("qoder_upstream_error", 502);
    // A validated non-stream completion is whole evidence: heal the latch.
    fire(heal);
    return Response.json(event, { headers });
  }
  if (!response.body) throw qoderError("qoder_stream_truncated", 502);
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
            if (frameBytes > 1_048_576) throw qoderError("qoder_stream_invalid", 502);
            pending = pending.slice(boundary.index + boundary[0].length);
            pendingBytes -= frameBytes + boundary[0].length;
            const data = raw.split(/\r\n|\n|\r/).filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n");
            if (!data) continue;
            if (data === "[DONE]") {
              if (!finished || !visible) throw qoderError("qoder_stream_truncated", 502);
              done = true;
              if (!healed) { healed = true; fire(heal); }
              await reader.cancel(); controller.enqueue(encoder.encode("data: [DONE]\n\n")); controller.close(); return;
            }
            let event: any;
            try { event = mapChunk(JSON.parse(data)); }
            catch (error: any) {
              if (error?.code === "qoder_rate_limited" || error?.code === "qoder_reauth_required" || error?.code === "qoder_upstream_error") {
                // Classify from upstream evidence, never flatten (grok parity):
                // the note reaches the service exactly like an HTTP failure.
                fire(note, { code: error.code, httpStatus: error.statusCode,
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
          if (pending.length > 1_048_576) throw qoderError("qoder_stream_invalid", 502);
          const next = await reader.read();
          if (next.done) { pending += decoder.decode(); if (!done) throw qoderError("qoder_stream_truncated", 502); controller.close(); return; }
          pending += decoder.decode(next.value, { stream: true });
          pendingBytes += next.value.byteLength;
          if (pendingBytes > 2_097_152) throw qoderError("qoder_stream_invalid", 502);
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

/**
 * The transformer never rewrites bodies through the engine (no cursor engine
 * call here — signing/encoding is the engine lane's chat() transaction). The
 * engine parameter exists for activation parity with grok's transformer
 * wiring; all stream evidence flows through note/heal.
 */
export class QoderTransformer {
  static TransformerName = "qoder";
  name = "qoder";
  constructor(private readonly engine?: QoderEngine, private readonly note?: QoderStreamNote, private readonly heal?: QoderStreamHeal) {}
  async transformRequestIn(request: any, _provider?: any, context?: any): Promise<{ body: any }> {
    return { body: qoderRequest(request, context) };
  }
  async transformResponseOut(response: Response): Promise<Response> {
    return qoderResponse(response, this.note, this.heal);
  }
}
