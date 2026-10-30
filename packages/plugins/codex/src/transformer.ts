/**
 * Codex subscription transformer — the request/response quirk layer that rides
 * the ordinary pipeline in front of the built-in `openai-responses`
 * transformer.
 *
 * Chain (provider config): `transformer.use = ["openai-responses", "codex"]`.
 * The core runs request transformers in array order and response transformers
 * in REVERSE order, so:
 *   request : unified chat → (openai-responses) Responses body → (codex) Codex
 *             wire body, finalized. This order is the verified one: the
 *             Responses body must exist before it can be finalized, and putting
 *             `codex` first would finalize a chat body.
 *   response: upstream Responses SSE/JSON → (codex: error/terminal + quota
 *             observation, byte-preserving) → (openai-responses) → client.
 *
 * Deliberately NO `endPoint`: registering a second /v1/responses route would
 * collide with the built-in transformer. The quirk layer therefore applies to
 * BOTH /v1/responses (Codex client) and /v1/messages (Claude Code clients) —
 * the core already normalizes the latter into a unified chat request upstream
 * and converts the response back downstream.
 *
 * Ownership split with the managed runtime (contract "Data contract"):
 *  - THIS module owns body finalization and response-side termination/quota
 *    observation;
 *  - the runtime owns the fixed origin, token/account headers, the session
 *    headers derived from the FINAL body, the 401-once refresh and error
 *    classification. Neither module repeats the other's work.
 *
 * It never imports host runtime modules; the canonical API types are type-only.
 */
import { codexFinalizeBody, codexSessionKey } from "./finalize-body";
import type { CodexRateLimitWindow, CodexRateLimits } from "./protocol-quota";
import { classifyCodexError, codexError, codexEmptyAnswerError, responseHasOutput } from "./protocol";
import type { CodexServiceLike } from "./protocol";
import type { PluginClassifiedError, PluginTransformer, PluginTransformerContext, PluginUnifiedChatRequest } from "./core-types";

/** Validated at transformer construction; the seam requires a service. */
export type CodexTransformerOptions = { service: CodexServiceLike };

/** Bounded prefix scan for the quota event (magpie codexLimitsScan = 64 KiB). */
export const CODEX_RATE_LIMIT_SCAN_BYTES = 64 * 1024;

/** Re-exported so transformer consumers share ONE quota shape (protocol-quota owns it). */
export type { CodexRateLimitWindow, CodexRateLimits };

function finiteNumber(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** Read one of `x-codex-{primary,secondary}-*` header triples. */
function windowFromHeaders(
  get: (name: string) => string | null,
  which: "primary" | "secondary",
  now: number,
): CodexRateLimitWindow | undefined {
  const used = finiteNumber(get(`x-codex-${which}-used-percent`));
  const minutes = finiteNumber(get(`x-codex-${which}-window-minutes`));
  const resetAtSeconds = finiteNumber(get(`x-codex-${which}-reset-at`));
  const resetAfterSeconds = finiteNumber(get(`x-codex-${which}-reset-after-seconds`));
  if (used === undefined && minutes === undefined && resetAtSeconds === undefined && resetAfterSeconds === undefined) {
    return undefined;
  }
  const window: CodexRateLimitWindow = { usedPercent: used ?? 0 };
  if (minutes !== undefined) window.windowSeconds = minutes * 60;
  if (resetAtSeconds !== undefined) window.resetAt = resetAtSeconds * 1000;
  else if (resetAfterSeconds !== undefined) window.resetAt = now + resetAfterSeconds * 1000;
  return window;
}

/**
 * Quota windows from the `x-codex-primary/secondary-*` response headers (the
 * second of magpie's two channels). Absent headers → undefined, never a guess.
 */
export function readCodexRateLimitHeaders(
  headers: Headers | Record<string, string>,
  now: number = Date.now(),
): CodexRateLimits | undefined {
  const get = (name: string): string | null => {
    if (headers instanceof Headers) return headers.get(name);
    const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
    return key ? (headers as Record<string, string>)[key] : null;
  };
  const primary = windowFromHeaders(get, "primary", now);
  const secondary = windowFromHeaders(get, "secondary", now);
  return primary || secondary
    ? { ...(primary ? { primary } : {}), ...(secondary ? { secondary } : {}), observedAt: now, source: "headers" }
    : undefined;
}

/**
 * Quota windows from a `codex.rate_limits` SSE event (magpie codexEventLimits).
 * `metered_limit_name` other than "codex" names a model-level limit, not the
 * account's own — ignored.
 */
export function parseCodexRateLimitsEvent(payload: any, now: number = Date.now()): CodexRateLimits | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const event = payload.type === "codex.rate_limits" ? payload : payload.rate_limits ? payload : undefined;
  if (!event) return undefined;
  const limits = event.rate_limits ?? event;
  if (!limits || typeof limits !== "object") return undefined;
  const metered = limits.metered_limit_name;
  if (typeof metered === "string" && metered !== "codex") return undefined;
  const readWindow = (raw: any): CodexRateLimitWindow | undefined => {
    if (!raw || typeof raw !== "object") return undefined;
    const used = finiteNumber(raw.used_percent);
    if (used === undefined) return undefined;
    const window: CodexRateLimitWindow = { usedPercent: used };
    const seconds = finiteNumber(raw.window_seconds) ?? (finiteNumber(raw.window_minutes) !== undefined ? finiteNumber(raw.window_minutes)! * 60 : undefined);
    if (seconds !== undefined) window.windowSeconds = seconds;
    const resetAt = finiteNumber(raw.reset_at);
    if (resetAt !== undefined) window.resetAt = resetAt * 1000;
    return window;
  };
  const primary = readWindow(limits.primary);
  const secondary = readWindow(limits.secondary);
  return primary || secondary
    ? { ...(primary ? { primary } : {}), ...(secondary ? { secondary } : {}), observedAt: now, source: "sse" }
    : undefined;
}

/**
 * Pick the error object out of a terminal SSE event. Handles:
 *  - a top-level `{"type":"error","error":{…}}` (or bare `{"error":{…}}`) event;
 *  - `response.failed` whose `response.error` carries the failure.
 * Returns undefined for every non-terminal event, including a NORMAL
 * `response.completed` / `response.incomplete`.
 */
export function codexTerminalError(event: any): Record<string, any> | undefined {
  if (!event || typeof event !== "object") return undefined;
  const type = typeof event.type === "string" ? event.type : "";
  if (type === "error") {
    const error = event.error ?? event;
    return typeof error === "object" && error !== null ? error : { message: String(event.message ?? "stream error") };
  }
  if (type === "response.failed") {
    const error = event.response?.error ?? event.error;
    // A failed response is an error with or without the words for it
    // (magpie #1933): never let it pass as a whole reply.
    return typeof error === "object" && error !== null
      ? error
      : { message: "response.failed without an error body", code: "response_failed" };
  }
  return undefined;
}

/**
 * The core calls `classifyError` through the runtime only for HTTP-level
 * failures; an in-stream terminal error has no such seam. The transformer
 * therefore surfaces it as a thrown error carrying the upstream status so the
 * core's generic retry/fallback and the runtime's classifier engage. The
 * thrown object is already redacted (no token material is ever in it).
 */
/**
 * Build the THROWN error for an in-stream terminal event. Unlike
 * `codexStreamError` (the raw provenance helper), this is classified through
 * the SAME canonical classifier as HTTP failures: a canonical whitelisted
 * code, the semantic httpStatus (429 quota / 502 other terminal),
 * `nonRetryable`, `pluginClassified` and NO rawBody — so the core's
 * rememberPluginFailure/error-handler surface a safe codex_* error instead of
 * forwarding the raw upstream envelope, and the service whitelist cools the
 * account. `upstreamStatus` preserves the real wire status (normally 200 for
 * an SSE terminal).
 */
export function codexClassifiedStreamError(event: any, upstreamStatus = 200): Error & Record<string, any> {
  const probe = codexStreamError(event, upstreamStatus);
  const terminal = codexTerminalError(event);
  const effectiveStatus =
    probe.statusCode >= 400 ? probe.statusCode : probe.isRateLimit ? 429 : 502;
  const classified: PluginClassifiedError =
    classifyCodexError(effectiveStatus, terminal ? { ...event, error: terminal } : event) ??
    { code: "codex_upstream_error", message: "Codex upstream stream failed.", httpStatus: 502, retryable: true };
  const error = codexError({
    code: classified.code as any,
    message: classified.message,
    httpStatus: classified.httpStatus,
    ...(classified.cooldownMs !== undefined ? { cooldownMs: classified.cooldownMs } : {}),
    retryable: classified.retryable === true,
  });
  return Object.assign(error, {
    pluginClassified: true as const,
    upstreamStatus,
    isRateLimit: classified.httpStatus === 429,
  });
}

export function codexStreamError(event: any, status = 200): Error & Record<string, any> {
  const error = codexTerminalError(event) ?? {};
  const code = typeof error.code === "string" ? error.code : typeof error.type === "string" ? error.type : "codex_stream_error";
  const message = typeof error.message === "string" && error.message ? error.message : "Codex upstream stream failed";
  return Object.assign(new Error(message), {
    code,
    statusCode: status,
    upstreamStatus: status,
    isRateLimit: code === "usage_limit_reached" || error.type === "usage_limit_reached",
    rawBody: JSON.stringify({ error }),
  });
}

export class CodexTransformer implements PluginTransformer {
  static TransformerName = "codex";
  name = "codex";
  logger?: any;

  private readonly service: CodexServiceLike;

  constructor(options: CodexTransformerOptions) {
    if (!options?.service) throw new Error("CodexTransformer requires { service }");
    this.service = options.service;
  }

  /**
   * Request phase: finalize the Responses body produced by the preceding
   * `openai-responses` transformer. The runtime performs auth injection later
   * (after the body is final), so no token is touched here.
   */
  async transformRequestIn(
    request: PluginUnifiedChatRequest,
    _provider?: any,
    context?: PluginTransformerContext
  ): Promise<{ body: any; config?: Record<string, any> }> {
    const model = typeof (request as any)?.model === "string" ? (request as any).model : "";
    let modelInstructions: string | undefined;
    try {
      modelInstructions = model ? this.service.getModelInstructions?.(model) : undefined;
    } catch {
      // A cache read must never fail the request.
      modelInstructions = undefined;
    }
    const sessionId = this.sessionIdFor(request, context);
    const body = codexFinalizeBody(request, { modelInstructions, sessionId });
    // Remember the finalized session key so the response phase can attribute
    // quota observations to the same conversation without touching the body.
    if (context) context.codexSessionKey = codexSessionKey(body);
    return { body };
  }

  /**
   * Stable conversation identity for the derived prompt_cache_key: the client
   * session when the server provides one, otherwise a hash of the first user
   * turn (which is what the finalizer falls back to when this is absent).
   */
  private sessionIdFor(request: any, context?: PluginTransformerContext): string | undefined {
    const fromReq = context?.req?.clientContext?.stableSessionId;
    if (typeof fromReq === "string" && fromReq) return fromReq;
    const header = context?.req?.headers?.["x-session-id"] ?? context?.req?.headers?.["x-session-affinity"];
    if (typeof header === "string" && header) return header;
    return undefined;
  }

  /**
   * Response phase. Byte-preserving for the happy path: the downstream
   * `openai-responses` transformer needs the original Responses SSE/JSON.
   *  - terminal in-stream events (`error`, `response.failed`) become thrown
   *    errors so fallback/classification engage instead of a truncated reply;
   *  - quota channels (headers + a bounded `codex.rate_limits` SSE scan) are
   *    observed out-of-band for the runtime's cooldown bookkeeping.
   * Nothing is buffered beyond the bounded scan window; a cancelled client
   * cancels the upstream reader and never accumulates the whole response.
   */
  async transformResponseOut(response: Response, context?: PluginTransformerContext): Promise<Response> {
    this.observeHeaderRateLimits(response);
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream") || !response.body) {
      // Non-stream body: a Responses JSON error envelope (HTTP 200) is handled
      // by the core's hidden-error path against the runtime classifier; here we
      // only make sure a `{"error":{…}}` 200 does not slip through as content.
      return response;
    }
    return this.inspectStream(response, context);
  }

  /**
   * Report an observation to the service. Ruling B: `noteRateLimits` must never
   * throw into the response path — the transformer swallows both a synchronous
   * throw and an async rejection so a broken bookkeeper cannot break a reply.
   */
  private reportRateLimits(limits: CodexRateLimits): void {
    try {
      const result: any = this.service.noteRateLimits(limits);
      if (result && typeof result.then === "function") result.then(undefined, () => {});
    } catch {
      // Observation must never fail the response path.
    }
  }

  private observeHeaderRateLimits(response: Response): void {
    const limits = readCodexRateLimitHeaders(response.headers);
    if (limits) this.reportRateLimits(limits);
  }

  /**
   * Inspect only the PREFIX of the stream (bounded by CODEX_RATE_LIMIT_SCAN_BYTES
   * and ending at the first content-bearing event). Errors that arrive later —
   * after content has been committed to the client — are not re-classified
   * (rotating/falling back after bytes are on the wire would duplicate text).
   * After the prefix, bytes pass through untouched, including [DONE] and
   * comments; a client cancel propagates to the upstream reader.
   */
  private inspectStream(response: Response, context?: PluginTransformerContext): Response {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const chunks: Uint8Array[] = [];
    let pending = "";
    let scanned = 0;
    let committed = false;
    let finished = false;
    let rateLimitsSeen = false;
    // Set when the upstream emitted any real output. A terminal event without it
    // is an empty turn, not a successful one.
    let sawOutput = false;

    const handleEvent = async (data: string): Promise<boolean> => {
      // true => commit (stop inspecting)
      if (data === "[DONE]") return true;
      let event: any;
      try {
        event = JSON.parse(data);
      } catch {
        return true; // unparseable payload: stop inspecting, pass through
      }
      if (!rateLimitsSeen && event?.type === "codex.rate_limits") {
        const limits = parseCodexRateLimitsEvent(event);
        if (limits) {
          rateLimitsSeen = true;
          this.reportRateLimits(limits);
        }
        return false;
      }
      const terminal = codexTerminalError(event);
      if (terminal) {
        const error = codexStreamError(event, response.status);
        // Report the classified failure to the runtime BEFORE throwing so a
        // quota cooldown is recorded exactly once, then surface the error.
        try {
          // Map the raw upstream SSE code (e.g. "usage_limit_reached") through
          // the SAME canonical classifier as HTTP failures, so the service
          // whitelist recognises it (codex_usage_limit) and the account cools.
          // Same taxonomy channel as an HTTP-level failure (ruling B: quota
          // classification stays on noteUpstreamError, never merged with
          // noteRateLimits). Never throws into the response path.
          // A stream error rides an HTTP-200 SSE response: infer the effective
          // status from the terminal kind (quota → 429, anything else → 502).
          const effectiveStatus =
            error.statusCode >= 400 ? error.statusCode : (error as any).isRateLimit ? 429 : 502;
          // Classify the UNWRAPPED terminal error: for response.failed the
          // failure object lives at event.response.error, which the classifier
          // (reading .error off the body) would otherwise never see. MERGE over
          // the event rather than replacing it: a top-level error event may
          // carry resets_at/resets_in_seconds as event-level siblings, and the
          // classifier's body-level fallback must keep seeing those.
          const classified =
            classifyCodexError(effectiveStatus, terminal ? { ...event, error: terminal } : event) ??
            ({
              code: "codex_upstream_error",
              message: "Codex upstream stream failed.",
              httpStatus: 502,
              retryable: true,
            } satisfies PluginClassifiedError);
          await this.service.noteUpstreamError?.({
            code: classified.code,
            message: classified.message,
            httpStatus: classified.httpStatus,
            ...(classified.cooldownMs !== undefined ? { cooldownMs: classified.cooldownMs } : {}),
            ...(classified.retryable !== undefined ? { retryable: classified.retryable } : {}),
          });
        } catch { /* bookkeeping never masks the error */ }
        throw codexClassifiedStreamError(event, response.status);
      }
      // Content-bearing events commit the stream: after this point a failure is
      // the client's problem, not a retry decision.
      if (typeof event?.type === "string" && (
        event.type.startsWith("response.output_text") ||
        event.type.startsWith("response.function_call_arguments") ||
        event.type.startsWith("response.reasoning") ||
        event.type === "response.output_item.done"
      )) {
        sawOutput = true;
        return true;
      }
      // A `response.completed` only commits the stream if the turn actually
      // produced output. An empty completed turn is the upstream failure this
      // transformer has to surface: committing it would hand the client a 200
      // with nothing in it — the "message sent, nothing happens" symptom.
      //
      // `response.incomplete` is deliberately NOT judged: it means the answer was
      // cut short, which is a legitimate terminal state the client must see.
      if (event.type === "response.completed") {
        if (sawOutput || responseHasOutput(event.response)) {
          sawOutput = true;
          return true;
        }
        throw codexEmptyAnswerError();
      }
      if (event.type === "response.incomplete") return true;
      return false;
    };

    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          while (true) {
            // Drain already-received RAW chunks first, whatever the phase. This
            // is what keeps memory bounded to the scan window (never the whole
            // response) and what makes commit ordering lossless: the chunk whose
            // event committed the stream is still in the queue and is emitted
            // verbatim, not re-derived from the decoder buffer.
            if (chunks.length) { controller.enqueue(chunks.shift()!); return; }
            // Committed: forward raw upstream chunks with no transcription at
            // all, so bytes are never duplicated by the decode buffer.
            if (committed) {
              const next = await reader.read();
              if (next.done) { controller.close(); reader.releaseLock(); return; }
              controller.enqueue(next.value);
              return;
            }
            const next = await reader.read();
            if (next.done) {
              // EOF during inspection: the pending tail's bytes were already
              // forwarded verbatim with its raw chunk — re-encoding them here
              // would emit them twice, so just drop the decoded copy.
              pending = "";
              committed = true;
              controller.close();
              reader.releaseLock();
              return;
            }
            if (next.value?.byteLength) {
              chunks.push(next.value);
              scanned += next.value.byteLength;
              pending += decoder.decode(next.value, { stream: true });
              // Parse complete events out of the buffer; a partial tail stays
              // in `pending` as the carry-over for the NEXT chunk — an event
              // split across a chunk boundary is routine on real networks and
              // must still be seen (quota observation, terminal errors).
              const events = pending.split(/\r\n\r\n|\n\n|\r\r/);
              pending = events.pop() ?? "";
              for (const raw of events) {
                const data = raw
                  .split(/\r\n|\r|\n/)
                  .filter((line) => line.startsWith("data:"))
                  .map((line) => line.slice(5).trimStart())
                  .join("\n");
                if (!data) continue;
                if (await handleEvent(data)) { committed = true; break; }
              }
              if (scanned >= CODEX_RATE_LIMIT_SCAN_BYTES) committed = true;
              // Only once committed may the decoded copy be dropped: the raw
              // chunk(s) queued in `chunks` now own the bytes. While still
              // inspecting, `pending` is the only parse carry-over there is.
              if (committed) pending = "";
            }
          }
        } catch (error: any) {
          await reader.cancel(error).catch(() => {});
          controller.error(error);
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });

    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return new Response(stream, { status: response.status, statusText: response.statusText, headers });
  }
}
