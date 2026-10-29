import { describe, expect, it } from "vitest";
import {
  EMPTY_ANSWER_INSPECT_BYTES,
  inspectAnswerPrefix,
  probeAnswer,
  rebuildAnswerStream,
} from "../api/empty-answer-guard";

/**
 * Regression coverage for "HTTP 200 with no content block" answers.
 *
 * The empty-but-successful turn is the failure the user reported (a message is
 * sent and nothing comes back), while the legitimate shapes below must keep
 * flowing untouched or the guard would break normal turns.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

const sse = (...events: Array<[string, unknown]>): string =>
  events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");

/** The exact shape Claude Code turns into `content: []`. */
const EMPTY_ANSWER = sse(
  ["message_start", { type: "message_start", message: { id: "msg_1", role: "assistant", content: [] } }],
  ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } }],
  ["message_stop", { type: "message_stop" }]
);

const TEXT_ANSWER = sse(
  ["message_start", { type: "message_start", message: { id: "msg_2", role: "assistant", content: [] } }],
  ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
  ["message_stop", { type: "message_stop" }]
);

/** A tool_use-only turn: empty text, but a real content block. */
const TOOL_ONLY_ANSWER = sse(
  ["message_start", { type: "message_start", message: { id: "msg_3", role: "assistant", content: [] } }],
  ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "read", input: {} } }],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  ["message_stop", { type: "message_stop" }]
);

/** Split a wire string into n-byte chunks, as a real socket delivers it. */
function chunked(wire: string, size: number): ReadableStream<Uint8Array> {
  const bytes = enc.encode(wire);
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, Math.min(offset + size, bytes.length)));
      offset += size;
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  let out = "";
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out += dec.decode(value, { stream: true });
  }
}

describe("inspectAnswerPrefix", () => {
  it("classifies the reported empty turn as empty", () => {
    expect(inspectAnswerPrefix(EMPTY_ANSWER)).toBe("empty");
  });

  it("classifies text and tool_use answers as content", () => {
    expect(inspectAnswerPrefix(TEXT_ANSWER)).toBe("content");
    expect(inspectAnswerPrefix(TOOL_ONLY_ANSWER)).toBe("content");
  });

  it("stays pending while the answer is still streaming", () => {
    const partial = sse(["message_start", { type: "message_start", message: { content: [] } }]);
    expect(inspectAnswerPrefix(partial)).toBe("pending");
  });

  it("recognises a bare [DONE] terminator", () => {
    expect(inspectAnswerPrefix("data: [DONE]\n\n")).toBe("empty");
  });

  it("ignores non-SSE lines such as comments and heartbeats", () => {
    expect(inspectAnswerPrefix(": ping\nevent: ping\n\n")).toBe("pending");
  });
});

/** The codex-subscription shape: Responses SSE that completes with no output. */
const RESPONSES_EMPTY = sse(
  ["response.created", { type: "response.created", response: { id: "resp_1", output: [] } }],
  ["response.completed", { type: "response.completed", response: { id: "resp_1", output: [], usage: { output_tokens: 0 } } }]
);

const RESPONSES_TEXT = sse(
  ["response.created", { type: "response.created", response: { id: "resp_2", output: [] } }],
  ["response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { type: "message" } }],
  ["response.output_text.delta", { type: "response.output_text.delta", output_index: 0, delta: "hi" }],
  ["response.completed", { type: "response.completed", response: { id: "resp_2", output: [{ type: "message" }] } }]
);

describe("Responses-format answers (codex-subscription)", () => {
  // Responses-API streams are deliberately OUT of scope: the core's
  // Responses→Anthropic bridge is known to emit an empty output for some tool
  // turns (pinned by the codex plugin's own tests), so judging them here would
  // turn that known defect into a hard error.
  it("does not judge a Responses stream, empty output or not", () => {
    expect(inspectAnswerPrefix(RESPONSES_EMPTY)).toBe("pending");
    expect(inspectAnswerPrefix(RESPONSES_TEXT)).toBe("pending");
  });

  it("never turns a Responses turn into a hard error", async () => {
    const probe = await probeAnswer(chunked(RESPONSES_EMPTY, 13));
    expect(probe.verdict).not.toBe("empty");
    expect(await drain(rebuildAnswerStream(probe.chunks, probe.rest))).toBe(RESPONSES_EMPTY);
  });

  it("passes a healthy Responses answer through byte-for-byte", async () => {
    const probe = await probeAnswer(chunked(RESPONSES_TEXT, 9));
    const forwarded = await drain(rebuildAnswerStream(probe.chunks, probe.rest));
    expect(forwarded).toBe(RESPONSES_TEXT);
  });
});

describe("chat-completions streams", () => {
  // `/v1/chat/completions` providers (WorkBuddy-style) answer with
  // `choices[].delta`; `[DONE]` alone is only a terminator. Missing this shape
  // made a real answer look like an empty turn.
  const CHAT_TEXT =
    'data: {"object":"chat.completion.chunk","choices":[{"delta":{"content":"hi"}}]}\n\n' +
    "data: [DONE]\n\n";
  const CHAT_EMPTY = 'data: {"object":"chat.completion.chunk","choices":[]}\n\ndata: [DONE]\n\n';

  it("accepts a chat stream that carries content", () => {
    expect(inspectAnswerPrefix(CHAT_TEXT)).toBe("content");
  });

  it("still flags a chat stream that ends with no content", () => {
    expect(inspectAnswerPrefix(CHAT_EMPTY)).toBe("empty");
  });

  it("accepts tool_calls-only chat deltas", () => {
    const tool = 'data: {"choices":[{"delta":{"tool_calls":[{"id":"c1"}]}}]}\n\ndata: [DONE]\n\n';
    expect(inspectAnswerPrefix(tool)).toBe("content");
  });
});

describe("probeAnswer deadline", () => {
  it("loses no bytes when the deadline fires mid-stream", async () => {
    // A stream that emits one chunk, then stalls past the deadline, then resumes.
    // The chunk that arrives right after the deadline must still be forwarded:
    // an abandoned read() would swallow it.
    const FIRST = "event: message_start\ndata: {}\n\n";
    const LATE = "event: content_block_start\ndata: {}\n\n";
    const tailText = "event: message_stop\ndata: {}\n\n";
    let sent = 0;
    const src = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode(FIRST));
        // Resume well after the probe deadline (150ms here).
        setTimeout(() => {
          controller.enqueue(enc.encode(LATE));
          sent = 2;
          setTimeout(() => {
            controller.enqueue(enc.encode(tailText));
            controller.close();
          }, 10);
        }, 250);
      },
    });

    const probe = await probeAnswer(src, EMPTY_ANSWER_INSPECT_BYTES, 150);
    expect(probe.verdict).toBe("pending");
    const forwarded = await drain(rebuildAnswerStream(probe.chunks, probe.rest));
    // Every byte must survive, including the one that arrived after the deadline.
    expect(forwarded).toBe(FIRST + LATE + tailText);
    expect(sent).toBe(2);
  });
});

describe("codex-subscription (Responses upstream, Anthropic client)", () => {
  // Real Codex traffic through /v1/messages is converted to Anthropic events
  // before it reaches the client — verified against a live request, which
  // returned message_start/content_block_* and zero `response.*` events. So an
  // empty Codex turn arrives here in the SAME empty-Anthropic shape as any other
  // provider, and must still be caught.
  const CODEX_EMPTY_AS_ANTHROPIC = sse(
    ["message_start", { type: "message_start", message: { id: "msg_c", role: "assistant", content: [], model: "auto" } }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } }],
    ["message_stop", { type: "message_stop" }]
  );

  it("flags a converted Codex turn that produced no content block", () => {
    expect(inspectAnswerPrefix(CODEX_EMPTY_AS_ANTHROPIC)).toBe("empty");
  });

  it("accepts a converted Codex turn that produced text", () => {
    expect(inspectAnswerPrefix(TEXT_ANSWER)).toBe("content");
  });
});

describe("probeAnswer / rebuildAnswerStream", () => {
  it("flags an empty answer and cancels the upstream stream", async () => {
    const probe = await probeAnswer(chunked(EMPTY_ANSWER, 16));
    expect(probe.verdict).toBe("empty");
    expect(probe.rest).toBeNull();
  });

  it("passes a text answer through byte-for-byte", async () => {
    const probe = await probeAnswer(chunked(TEXT_ANSWER, 7));
    expect(probe.verdict).toBe("content");
    const forwarded = await drain(rebuildAnswerStream(probe.chunks, probe.rest));
    expect(forwarded).toBe(TEXT_ANSWER);
  });

  it("passes a tool_use-only answer through (empty text is legitimate)", async () => {
    const probe = await probeAnswer(chunked(TOOL_ONLY_ANSWER, 11));
    expect(probe.verdict).toBe("content");
    const forwarded = await drain(rebuildAnswerStream(probe.chunks, probe.rest));
    expect(forwarded).toBe(TOOL_ONLY_ANSWER);
    expect(forwarded).toContain("tool_use");
  });

  it("releases a long healthy answer at its first content block", async () => {
    // 200 KiB of text deltas after the first block: the probe must stop at the
    // first content_block_start, so the consumed prefix stays small.
    const big = sse(
      ["message_start", { type: "message_start", message: { content: [] } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ...Array.from({ length: 400 }, (_, i) => ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x".repeat(500) } }] as [string, unknown])
    );
    const probe = await probeAnswer(chunked(big, 1024));
    expect(probe.verdict).toBe("content");
    expect(probe.bytes).toBeLessThan(4096);
    const forwarded = await drain(rebuildAnswerStream(probe.chunks, probe.rest));
    expect(forwarded).toBe(big);
  });

  it("forwards an unclassifiable stream after the inspect budget instead of guessing", async () => {
    const noise = "event: message_start\n".repeat(Math.ceil(EMPTY_ANSWER_INSPECT_BYTES / 20) + 50);
    const probe = await probeAnswer(chunked(noise, 4096));
    expect(probe.verdict).toBe("pending");
    expect(probe.bytes).toBeGreaterThanOrEqual(EMPTY_ANSWER_INSPECT_BYTES);
    const forwarded = await drain(rebuildAnswerStream(probe.chunks, probe.rest));
    expect(forwarded).toBe(noise);
  });

  it("treats EOF without a terminal event as pending (existing truncation path keeps it)", async () => {
    const truncated = sse(["message_start", { type: "message_start", message: { content: [] } }]);
    const probe = await probeAnswer(chunked(truncated, 32));
    expect(probe.verdict).toBe("pending");
    expect(await drain(rebuildAnswerStream(probe.chunks, probe.rest))).toBe(truncated);
  });
});
