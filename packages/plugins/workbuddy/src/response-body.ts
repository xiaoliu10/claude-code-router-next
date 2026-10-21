/**
 * SSE-boundary body helpers, MOVED VERBATIM from the core module
 * `packages/core/src/transformer/response-body.ts` (only `parseResponseJson`
 * /`parseJsonText`/`isEventStreamResponse` were not needed by the plugin and
 * are omitted). The plugin must not import core runtime modules, so the three
 * helpers the WorkBuddy transformer uses travel with it; keep in sync by test
 * (the transformer suite pins the boundary behaviour on both copies' shared
 * semantics).
 */
export function looksLikeSSE(text: string): boolean {
  return /^\s*(event:|data:|:\s*[A-Z])/m.test(text) || text.startsWith("data:");
}

/**
 * Peek the first meaningful content of a response body without consuming it.
 *
 * The body is `tee()`d; we drain one tee'd branch with a short read loop and
 * cancel it, leaving the other branch untouched so the caller can still read
 * the full body. A single `read()` is not enough: upstream relays (e.g. the
 * Codex relay) can split the first event across multiple chunks, send an empty
 * leading buffer, or emit an SSE comment heartbeat (": ping") before the real
 * `event:`/`data:` line. We accumulate across a bounded number of reads until
 * we can classify the body as SSE or JSON, so a fragmented first event is
 * still detected as a stream instead of failing JSON parse downstream.
 *
 * Returns `{ body, isSSE }` where `body` is the unread tee'd branch (the
 * original full body, including the bytes we peeked) suitable for passing to a
 * fresh `Response`, or `null` when the body cannot be peeked (locked/absent).
 */
export async function peekBodyForSSE(
  response: Response
): Promise<{ body: ReadableStream<Uint8Array>; isSSE: boolean } | null> {
  if (!response.body || response.body.locked) {
    return null;
  }
  const [peek, body] = response.body.tee();
  const reader = peek.getReader();
  const decoder = new TextDecoder();
  let acc = "";
  try {
    for (let i = 0; i < 8; i++) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        acc += decoder.decode(value, { stream: true });
      }
      // Stop as soon as we can classify the body.
      if (looksLikeSSE(acc)) {
        break;
      }
      // A JSON body starts with "{" or "[" — once we have a non-whitespace
      // leading brace/bracket, stop accumulating: it is not SSE.
      if (/^\s*[\[{]/.test(acc)) {
        break;
      }
    }
    acc += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  peek.cancel().catch(() => {});
  return { body, isSSE: looksLikeSSE(acc) };
}

/**
 * Last-resort SSE detection that consumes the entire body as text.
 *
 * Used when `peekBodyForSSE` cannot run (body absent or locked by an earlier
 * reader): instead of failing, drain the body to text and classify it. If the
 * full text is an SSE stream, return it wrapped as a fresh `text/event-stream`
 * `Response` so the caller can stream it through; otherwise return a `Response`
 * over the same text so JSON parsing can proceed (and fail with a descriptive
 * preview if it is neither).
 *
 * Returns the (possibly rebuilt) Response, or the original response when the
 * body cannot be consumed at all.
 */
export async function readBodyForSSE(
  response: Response
): Promise<{ response: Response; isSSE: boolean }> {
  try {
    const text = await response.text();
    const isSSE = looksLikeSSE(text);
    if (isSSE) {
      const enc = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(enc.encode(text));
          controller.close();
        },
      });
      return {
        response: new Response(stream, {
          status: response.status,
          statusText: response.statusText,
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        }),
        isSSE: true,
      };
    }
    return {
      response: new Response(text, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      }),
      isSSE: false,
    };
  } catch {
    return { response, isSSE: false };
  }
}
