import { describe, expect, it } from "vitest";
import { OpenAIResponsesTransformer } from "../transformer/openai.responses.transformer";

// Regression coverage for OpenAIResponsesTransformer.transformResponseOut:
// it peeked the first SSE chunk off a tee'd branch and then re-prepended that
// chunk to the other branch, so every byte of the first chunk was delivered
// twice — duplicating events, and (when the first chunk ended mid-JSON)
// producing a malformed event. The fix hands the untouched tee'd branch to the
// pass-through / converter paths instead.
//
// Every fixture is synthetic: no network, no upstream, no live config.

const encoder = new TextEncoder();

/** Build a Response whose body emits exactly `chunks`, byte for byte. */
function streamResponse(
  chunks: Array<string | Uint8Array>,
  contentType: string | null = "text/event-stream"
): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      }
      controller.close();
    },
  });
  const headers: Record<string, string> = {};
  if (contentType !== null) {
    headers["Content-Type"] = contentType;
  }
  return new Response(body, { status: 200, headers });
}

/** Read a whole body into a single string (stream mode decoding). */
async function readAllText(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

/** Read a whole body as a single Uint8Array so we can compare raw bytes. */
async function readAllBytes(response: Response): Promise<Uint8Array> {
  const reader = response.body!.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Split an SSE body into `data:` payloads, dropping [DONE]. */
function dataPayloads(text: string): string[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length).trim())
    .filter((payload) => payload.length > 0 && payload !== "[DONE]");
}

function anthropicStreamChunks(): string[] {
  const events: Array<[string, object]> = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4",
          content: [],
          usage: { input_tokens: 3, output_tokens: 1 },
        },
      },
    ],
    [
      "content_block_start",
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ],
    [
      "content_block_delta",
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "héllo" } },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } },
    ],
    ["message_stop", { type: "message_stop" }],
  ];
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function nativeResponsesStreamChunks(): string[] {
  return [
    `event: response.created\ndata: ${JSON.stringify({
      type: "response.created",
      response: { id: "resp_1", model: "gpt-5.4", output: [] },
    })}\n\n`,
    `event: response.output_item.added\ndata: ${JSON.stringify({
      type: "response.output_item.added",
      output_index: 0,
      item: { id: "item_1", type: "message", content: [] },
    })}\n\n`,
    `event: response.output_text.delta\ndata: ${JSON.stringify({
      type: "response.output_text.delta",
      item_id: "item_1",
      output_index: 0,
      delta: "hello",
    })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      response: { id: "resp_1", model: "gpt-5.4", output: [{ type: "message" }] },
    })}\n\n`,
  ];
}

function chatStreamChunks(): string[] {
  return [
    `data: ${JSON.stringify({
      id: "chatcmpl-1",
      object: "chat.completion.chunk",
      created: 1700000000,
      model: "gpt-4o-mini",
      choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null }],
    })}\n\n`,
    `data: ${JSON.stringify({
      id: "chatcmpl-1",
      object: "chat.completion.chunk",
      created: 1700000000,
      model: "gpt-4o-mini",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    })}\n\n`,
    "data: [DONE]\n\n",
  ];
}

const transformer = new OpenAIResponsesTransformer();

describe("OpenAIResponsesTransformer.transformResponseOut — Anthropic SSE passthrough", () => {
  it("delivers the first event exactly once", async () => {
    const chunks = anthropicStreamChunks();
    const original = chunks.join("");
    const out = await transformer.transformResponseOut(streamResponse(chunks));

    expect(out.headers.get("Content-Type") || "").toContain("text/event-stream");
    await expect(readAllText(out)).resolves.toBe(original);
  });

  it("emits each event name once", async () => {
    const out = await transformer.transformResponseOut(
      streamResponse(anthropicStreamChunks())
    );
    const text = await readAllText(out);
    const eventNames = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith("event: "))
      .map((line) => line.slice("event: ".length).trim());

    expect(eventNames).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
  });
});

describe("OpenAIResponsesTransformer.transformResponseOut — native Responses SSE passthrough", () => {
  it("delivers the first event exactly once", async () => {
    const chunks = nativeResponsesStreamChunks();
    const original = chunks.join("");
    const out = await transformer.transformResponseOut(streamResponse(chunks));

    expect(out.headers.get("Content-Type") || "").toContain("text/event-stream");
    await expect(readAllText(out)).resolves.toBe(original);
  });

  it("emits each native event exactly once", async () => {
    const out = await transformer.transformResponseOut(
      streamResponse(nativeResponsesStreamChunks())
    );
    const text = await readAllText(out);
    const types = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice("data: ".length).trim())
      .filter((payload) => payload !== "[DONE]")
      .map((payload) => JSON.parse(payload).type);

    expect(types).toEqual([
      "response.created",
      "response.output_item.added",
      "response.output_text.delta",
      "response.completed",
    ]);
  });
});

describe("OpenAIResponsesTransformer.transformResponseOut — chunk boundaries", () => {
  it("does not duplicate bytes when the first chunk ends inside the JSON payload", async () => {
    // First upstream chunk carries the event line and the opening brace, i.e.
    // the peeked text is not parseable on its own. Re-prepending it to a body
    // that already contains it made the downstream event an invalid JSON
    // document ("Unexpected non-whitespace character after JSON").
    const payload = JSON.stringify({
      type: "response.output_text.delta",
      item_id: "item_1",
      output_index: 0,
      delta: "hello",
    });
    const full = `event: response.output_text.delta\ndata: ${payload}\n\n`;
    const splitAt = full.indexOf(payload) + 12;
    const chunks = [full.slice(0, splitAt), full.slice(splitAt)];

    const out = await transformer.transformResponseOut(streamResponse(chunks));
    const text = await readAllText(out);

    expect(text).toBe(full);
    const payloads = dataPayloads(text);
    expect(payloads).toHaveLength(1);
    expect(() => JSON.parse(payloads[0])).not.toThrow();
  });

  it("preserves bytes exactly when the first chunk splits a multi-byte character", async () => {
    // Anthropic SSE passthrough must not re-encode the peeked text: decoding a
    // chunk that ends mid-character yields U+FFFD, and re-encoding that (as the
    // old prependToStream did) corrupted the next event's bytes.
    const original = anthropicStreamChunks().join("");
    const bytes = encoder.encode(original);
    // Split three bytes into the UTF-8 encoding of "é" (0xC3 0xA9).
    const marker = encoder.encode("delta\":{\"type\":\"text_delta\",\"text\":\"h");
    const markerIndex = Buffer.from(bytes).indexOf(Buffer.from(marker));
    expect(markerIndex).toBeGreaterThan(-1);
    const splitAt = markerIndex + marker.length + 1; // between the two bytes of "é"

    const chunks = [bytes.slice(0, splitAt), bytes.slice(splitAt)];
    const out = await transformer.transformResponseOut(streamResponse(chunks));
    const received = await readAllBytes(out);

    // Byte-for-byte identity — a mangled U+FFFD round-trip fails here.
    expect(Buffer.from(received).equals(Buffer.from(bytes))).toBe(true);
    expect(new TextDecoder().decode(received)).toBe(original);
  });
});

describe("OpenAIResponsesTransformer.transformResponseOut — content-type handling", () => {
  it("keeps SSE passthrough intact when the upstream sends no Content-Type", async () => {
    const chunks = anthropicStreamChunks();
    const original = chunks.join("");
    const out = await transformer.transformResponseOut(streamResponse(chunks, null));

    expect(out.headers.get("Content-Type") || "").toContain("text/event-stream");
    await expect(readAllText(out)).resolves.toBe(original);
  });

  it("keeps SSE passthrough intact when SSE is mislabeled application/json", async () => {
    const chunks = anthropicStreamChunks();
    const original = chunks.join("");
    const out = await transformer.transformResponseOut(
      streamResponse(chunks, "application/json")
    );

    expect(out.headers.get("Content-Type") || "").toContain("text/event-stream");
    await expect(readAllText(out)).resolves.toBe(original);
  });
});

describe("OpenAIResponsesTransformer.transformResponseOut — Responses→Chat conversion", () => {
  it("feeds the first Responses event to the converter exactly once", async () => {
    // No response.created / response.output_text.delta / response.in_progress /
    // response.output_item.added in the first chunk, so format detection falls
    // through to the Responses→Chat converter. That converter must still see the
    // first chunk — once, not twice.
    const chunks = [
      `event: response.reasoning_summary_text.delta\ndata: ${JSON.stringify({
        type: "response.reasoning_summary_text.delta",
        item_id: "item_1",
        delta: "thinking",
        response: { model: "gpt-5.4" },
      })}\n\n`,
      `event: response.output_text.delta\ndata: ${JSON.stringify({
        type: "response.output_text.delta",
        item_id: "item_1",
        output_index: 0,
        delta: "hello",
        response: { model: "gpt-5.4" },
      })}\n\n`,
      `event: response.completed\ndata: ${JSON.stringify({
        type: "response.completed",
        response: { id: "resp_1", model: "gpt-5.4", output: [{ type: "message" }] },
      })}\n\n`,
    ];

    const out = await transformer.transformResponseOut(streamResponse(chunks));
    const text = await readAllText(out);
    const parsed = dataPayloads(text)
      .filter((payload) => payload !== "[DONE]")
      .map((payload) => JSON.parse(payload));

    // The converter only turns the first event into a chat chunk if it actually
    // received it (and only once, so no duplicate thinking delta).
    const thinkingDeltas = parsed.filter(
      (chunk) => chunk.choices?.[0]?.delta?.thinking?.content === "thinking"
    );
    expect(thinkingDeltas).toHaveLength(1);

    const contentDeltas = parsed.filter(
      (chunk) => chunk.choices?.[0]?.delta?.content === "hello"
    );
    expect(contentDeltas).toHaveLength(1);

    expect(parsed.some((chunk) => chunk.choices?.[0]?.finish_reason === "stop")).toBe(true);
  });
});

describe("OpenAIResponsesTransformer.transformResponseOut — cancellation and errors", () => {
  it("cancels the untouched source stream", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(`event: message_start\ndata: {"type":"message_start"}\n\n`)
        );
      },
      cancel() {
        cancelled = true;
      },
    });

    const out = await transformer.transformResponseOut(
      new Response(body, { headers: { "Content-Type": "text/event-stream" } })
    );
    await out.body!.cancel();

    expect(cancelled).toBe(true);
  });

  it("propagates the source stream error to the consumer", async () => {
    // Error is surfaced on the second pull (with an active reader waiting) so
    // the test exercises error delivery during consumption rather than a
    // pre-existing error that streams flag at construction time.
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) {
          controller.enqueue(
            encoder.encode(`event: message_start\ndata: {"type":"message_start"}\n\n`)
          );
        } else {
          controller.error(new Error("upstream reset"));
        }
      },
    });

    const out = await transformer.transformResponseOut(
      new Response(body, { headers: { "Content-Type": "text/event-stream" } })
    );

    await expect(readAllText(out)).rejects.toThrow("upstream reset");
  });
});
