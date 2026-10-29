/**
 * Detect an upstream answer that completed successfully (HTTP 200) but carried
 * no content blocks at all.
 *
 * The client shows such a turn as "no response" — a message is sent and nothing
 * happens. Because the wire response is an ordinary 200 with a normal
 * message_start / message_delta / message_stop sequence, nothing in the request
 * path throws, so neither the same-model retry nor the fallback chain runs, and
 * the empty turn is recorded as a provider success (which also keeps the
 * unhealthy model out of the fail pool).
 *
 * Judging the whole content-block set rather than the text keeps legitimate
 * turns alive: a tool_use-only turn, a stop_sequence hit, and a refusal (which
 * still emits a text block) all contain at least one content block.
 *
 * The probe is bounded by EMPTY_ANSWER_INSPECT_BYTES, so a healthy answer is
 * released right after its first content block and is never buffered further.
 */

/** Upper bound on the bytes inspected before a stream is forwarded untouched. */
export const EMPTY_ANSWER_INSPECT_BYTES = 64 * 1024;

/**
 * Upper bound on how long the probe may hold the response before forwarding.
 *
 * Long enough that a thinking model's first content block arrives well within it
 * on a healthy stream, short enough that a stalled upstream cannot pin the
 * request (and its connection) open.
 */
export const EMPTY_ANSWER_INSPECT_DEADLINE_MS = 10_000;

/**
 * SSE events that carry real model output.
 *
 * Only the Anthropic wire format is listed: this guard judges the response CCR
 * forwards to an Anthropic-shaped client, and empty `content` there is the
 * failure being detected. Responses-API conversion is deliberately NOT judged
 * here — the core's Responses→Anthropic bridge is known to emit an empty
 * `output` for some tool turns (a documented double-conversion defect that the
 * codex plugin's own tests pin), and flipping those to hard errors would break
 * turns the code already accepts.
 */
const CONTENT_MARKERS = [
  "content_block_start",
  "content_block_delta",
  "content_block_stop",
];

/** Terminal events; reaching one without content means "empty". */
const TERMINAL_MARKERS = ["message_stop", "response.completed", "response.incomplete", "[DONE]"];

/**
 * A Responses-API stream is out of scope for the empty-answer judgement.
 *
 * Detected from ANY Responses event name or type, not just the lifecycle events:
 * a turn may carry only `response.output_text.delta` before `[DONE]`, and
 * mistaking that for an Anthropic stream would classify a real answer as empty.
 *
 * This only matters for streams CCR forwards WITHOUT the Responses→Anthropic
 * conversion (native `/v1/responses` clients and the plugin tests that exercise
 * that bridge directly). A converted turn reaches here as ordinary
 * `message_start` / `content_block_*` events — which is why real Codex traffic
 * through `/v1/messages` is still judged normally and its empty answers are
 * still caught.
 */
function isResponsesStream(text: string): boolean {
  return /"type"\s*:\s*"response\.[A-Za-z0-9_.]+"/.test(text) ||
    /(^|\n)\s*(event:\s*)?response\.[A-Za-z0-9_.]+/.test(text);
}

/** `content` = real output; `empty` = finished with no block; `pending` = undecided. */
export type AnswerVerdict = "content" | "empty" | "pending";

/**
 * Judge the buffered prefix of an answer.
 *
 * Line-prefix scanning (rather than JSON parsing) is deliberate: Anthropic SSE
 * names each event on both `event:` and `data:` lines, and payloads may be split
 * across reads, so a marker scan stays correct and cheap on every chunk.
 */
export function inspectAnswerPrefix(text: string): AnswerVerdict {
  // Responses-API streams are out of scope (see CONTENT_MARKERS): the core's
  // Responses→Anthropic bridge may legitimately emit an empty output for tool
  // turns, so judging them here would turn a known defect into a hard error.
  if (isResponsesStream(text)) return "pending";

  let sawContent = false;
  let sawTerminal = false;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("data:") && !line.startsWith("event:")) continue;
    if (CONTENT_MARKERS.some((marker) => line.includes(marker))) {
      sawContent = true;
      break;
    }
    if (TERMINAL_MARKERS.some((marker) => line.includes(marker))) sawTerminal = true;
  }
  if (sawContent) return "content";
  return sawTerminal ? "empty" : "pending";
}

export interface AnswerProbeResult {
  verdict: AnswerVerdict;
  /** Chunks consumed while probing, in order, to be re-emitted verbatim. */
  chunks: Uint8Array[];
  /** Bytes consumed while probing. */
  bytes: number;
  /** Remaining upstream stream, or null when the answer ended / was cancelled. */
  rest: ReadableStream<Uint8Array> | null;
}

/**
 * Read enough of `body` to decide whether the answer carries any content.
 *
 * Consumed bytes are returned in `chunks` so a healthy stream can be rebuilt
 * byte-for-byte. Reading stops at the first content block (fast, non-blocking
 * for real answers), at the byte budget (forwarded untouched — an unknown shape
 * is never second-guessed), at the terminal event (verdict `empty`), or when
 * `deadlineMs` elapses.
 *
 * The deadline matters: before this guard, the first SSE event was forwarded as
 * soon as it arrived. Waiting for a content block is open-ended by nature (a
 * thinking model may emit nothing but heartbeats for a long time), so an
 * upstream that stalls after `message_start` would hold the response — and the
 * whole request — forever. On timeout the answer is treated as `pending` and
 * forwarded as-is, which preserves the old behaviour for slow-but-alive streams.
 */
export async function probeAnswer(
  body: ReadableStream<Uint8Array>,
  limitBytes = EMPTY_ANSWER_INSPECT_BYTES,
  deadlineMs = EMPTY_ANSWER_INSPECT_DEADLINE_MS
): Promise<AnswerProbeResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const chunks: Uint8Array[] = [];
  let text = "";
  let bytes = 0;
  const deadline = Date.now() + deadlineMs;

  const finish = (verdict: AnswerVerdict, rest: ReadableStream<Uint8Array> | null): AnswerProbeResult =>
    ({ verdict, chunks, bytes, rest });

  try {
    for (;;) {
      // Race the read against the remaining budget so a stalled upstream cannot
      // hold the response open indefinitely.
      const remaining = deadline - Date.now();
      const timedOut = Symbol("timeout");
      let timer: ReturnType<typeof setTimeout> | undefined;
      // The read MUST be kept: if the deadline wins, this promise is still
      // pending and will resolve with the next chunk. Handing it to tail() keeps
      // a single read in flight — issuing a second read() would let this one
      // swallow the first chunk that arrives and silently drop it.
      const pendingRead = reader.read();
      const next = remaining <= 0
        ? timedOut
        : await Promise.race([
            pendingRead,
            new Promise<typeof timedOut>((resolve) => {
              timer = setTimeout(() => resolve(timedOut), remaining);
            }),
          ]);
      // Clear the deadline timer on every path: leaving it armed leaks a timer
      // per read iteration on healthy streams.
      if (timer) clearTimeout(timer);
      if (next === timedOut) {
        // Still streaming, just slower than the budget: forward untouched, with
        // the in-flight read carried over so no bytes are lost.
        return finish(
          inspectAnswerPrefix(text) === "content" ? "content" : "pending",
          tail(reader, pendingRead)
        );
      }
      if (next.done) {
        text += decoder.decode();
        const verdict = inspectAnswerPrefix(text);
        return finish(verdict === "empty" ? "empty" : "pending", null);
      }
      if (!next.value) continue;
      chunks.push(next.value);
      bytes += next.value.byteLength;
      text += decoder.decode(next.value, { stream: true });

      const verdict = inspectAnswerPrefix(text);
      if (verdict === "content") return finish("content", tail(reader));
      if (verdict === "empty") {
        await reader.cancel().catch(() => {});
        return finish("empty", null);
      }
      // A Responses-API stream is never judged (see CONTENT_MARKERS): release it
      // immediately instead of holding it to the byte/time budget, so proxied
      // Responses traffic pays no latency for a check that cannot apply to it.
      if (isResponsesStream(text)) {
        return finish("pending", tail(reader));
      }
      if (bytes >= limitBytes) return finish("pending", tail(reader));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
}

/** Detach the still-open reader into a fresh stream. */
/**
 * Detach the still-open reader into a fresh stream.
 *
 * `pendingRead` is a read that was already issued (the deadline raced it and
 * lost) — it MUST be consumed here first. `ReadableStreamDefaultReader` fulfills
 * its reads FIFO, so issuing another `read()` while one is outstanding would let
 * the outstanding one swallow the next chunk and drop it from the forwarded
 * stream.
 */
function tail(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  pendingRead?: Promise<ReadableStreamReadResult<Uint8Array>>
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let first = pendingRead;
      const pump = () => {
        const current = first ?? reader.read();
        first = undefined;
        current
          .then(({ done, value }) => {
            if (done) controller.close();
            else {
              controller.enqueue(value);
              pump();
            }
          })
          .catch((err) => controller.error(err));
      };
      pump();
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/** Re-emit probed chunks, then continue with `rest`. */
export function rebuildAnswerStream(
  chunks: Uint8Array[],
  rest: ReadableStream<Uint8Array> | null
): ReadableStream<Uint8Array> {
  const reader = rest?.getReader();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      if (!reader) {
        controller.close();
        return;
      }
      const pump = () => {
        reader
          .read()
          .then(({ done, value }) => {
            if (done) controller.close();
            else {
              controller.enqueue(value);
              pump();
            }
          })
          .catch((err) => controller.error(err));
      };
      pump();
    },
    cancel(reason) {
      return reader?.cancel(reason);
    },
  });
}
