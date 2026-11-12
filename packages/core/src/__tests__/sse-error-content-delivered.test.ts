import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Server from "../server";
import { registerRequestPipeline, createCcrPreHandlerCallbacks } from "../ccr/request-pipeline";
import { registerAdminRoutes } from "../ccr/admin-routes";
import { getHealthStore } from "../services/provider-health";
import { resetFallbackPromotionStore } from "../utils/fallback-promotion";
import { AnthropicTransformer } from "../transformer/anthropic.transformer";

/**
 * Regression for the 2026-11-10 production diagnosis: a streaming answer that
 * the client fully received was still judged failed, keeping the provider card
 * permanently red.
 *
 * The upstream emits an error frame MID-stream (after real content). The
 * Anthropic transformer records it on req.sseError but keeps forwarding the
 * content, so the client gets a complete answer while the onResponse health
 * judgement saw `hasSseError && !hasOutputTokens` and called recordFailure —
 * on EVERY request, pushing failureCount up forever.
 *
 * The fix: the transformer stamps req.contentDelivered once a content block is
 * actually enqueued for the client, and an SSE error only counts as a failure
 * when nothing was delivered. The empty-answer boundary is pinned here too:
 * a stream with zero content blocks is still a failure.
 */

const enc = new TextEncoder();
const noopLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function makeTransformer(): AnthropicTransformer {
  const t = new AnthropicTransformer();
  t.logger = noopLogger as any;
  return t;
}

/** OpenAI chat-completions SSE body (optionally split across network chunks). */
function chatSse(chunks: object[], splitPerEvent = false): Response {
  const frames = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (splitPerEvent) {
        for (const frame of frames) controller.enqueue(enc.encode(frame));
      } else {
        controller.enqueue(enc.encode(frames.join("") + "data: [DONE]\n\n"));
      }
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

interface SseEvent {
  event: string;
  data: any;
}

async function collectSse(response: Response): Promise<SseEvent[]> {
  const out: SseEvent[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() || "";
    for (const block of blocks) {
      let event = "";
      let dataLine = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7).trim();
        else if (line.startsWith("data: ")) dataLine = line.slice(6);
      }
      if (event && dataLine) {
        try {
          out.push({ event, data: JSON.parse(dataLine) });
        } catch {
          // ignore non-JSON data lines
        }
      }
    }
  }
  return out;
}

describe("AnthropicTransformer content-delivery marker (unit)", () => {
  it("marks contentDelivered when text content is forwarded, even with a mid-stream error frame", async () => {
    const transformer = makeTransformer();
    const response = chatSse([
      { id: "c1", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
      { id: "c1", choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }] },
      { error: { type: "server_error", message: "upstream exploded mid-stream" } },
    ]);
    const req: any = { id: "req-1", tokenCount: 10 };

    const result = await transformer.transformResponseIn(response, { req } as any);
    const events = await collectSse(result);

    // The error is recorded for usage tracking...
    expect(req.sseError).toBeDefined();
    // ...but the content block that reached the client is recorded too.
    expect(req.contentDelivered).toBe(true);

    const texts = events
      .filter((e) => e.event === "content_block_delta")
      .map((e) => e.data.delta?.text)
      .join("");
    expect(texts).toBe("hello");
    expect(events.some((e) => e.event === "error")).toBe(true);
  });

  it("does NOT mark contentDelivered for an error-only stream (empty-answer boundary)", async () => {
    const transformer = makeTransformer();
    const response = chatSse([
      { error: { type: "server_error", message: "upstream exploded immediately" } },
    ]);
    const req: any = { id: "req-2", tokenCount: 10 };

    const result = await transformer.transformResponseIn(response, { req } as any);
    const events = await collectSse(result);

    expect(req.sseError).toBeDefined();
    expect(req.contentDelivered).not.toBe(true);
    // No content block was ever emitted.
    expect(events.some((e) => e.event.startsWith("content_block_"))).toBe(false);
  });

  it("does NOT mark contentDelivered for a 200 stream with zero content blocks", async () => {
    const transformer = makeTransformer();
    const response = chatSse([
      { id: "c3", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
      { id: "c3", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]);
    const req: any = { id: "req-3", tokenCount: 10 };

    const result = await transformer.transformResponseIn(response, { req } as any);
    const events = await collectSse(result);

    // Lifecycle frames were emitted (message_start/message_delta/message_stop),
    // but no content block: the empty-answer judgement must still see this as
    // an empty turn.
    expect(events.some((e) => e.event === "message_stop")).toBe(true);
    expect(req.contentDelivered).not.toBe(true);
    expect(req.sseError).toBeUndefined();
  });

  it("marks contentDelivered for tool_use-only output", async () => {
    const transformer = makeTransformer();
    const response = chatSse([
      {
        id: "c4",
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read", arguments: "" } }] },
          finish_reason: null,
        }],
      },
      {
        id: "c4",
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"x"}' } }] },
          finish_reason: null,
        }],
      },
      { error: { message: "late error after the tool call" } },
    ]);
    const req: any = { id: "req-4", tokenCount: 10 };

    const result = await transformer.transformResponseIn(response, { req } as any);
    const events = await collectSse(result);

    expect(req.contentDelivered).toBe(true);
    expect(events.some((e) => e.event === "content_block_start" && e.data.content_block?.type === "tool_use")).toBe(true);
  });
});

// --- End-to-end: the onResponse health judgement ---

/**
 * inject() resolves as soon as the client received the full response, but the
 * onResponse hooks (usage record + health judgement) run AFTER that. Tests
 * must await this sentinel hook — registered last, so it fires once every
 * earlier onResponse hook settled — before asserting health-store effects.
 */
function onResponseSentinel(server: any) {
  let resolveDone: (() => void) | undefined;
  server.app.addHook("onResponse", async () => {
    resolveDone?.();
  });
  return {
    arm() {
      return new Promise<void>((resolve) => {
        resolveDone = resolve;
      });
    },
  };
}

async function buildRuntime() {
  const config: any = {
    PORT: 0,
    APIKEY: "secret",
    Providers: [
      {
        name: "primary",
        api_base_url: "https://primary.example/v1/messages",
        api_key: "k1",
        models: ["model-a"],
      },
    ],
    Router: { default: "primary,model-a" },
  };

  const server: any = new Server({
    logger: false,
    useJsonFile: false,
    initialConfig: {
      providers: config.Providers,
      Router: config.Router,
      HOST: "127.0.0.1",
      PORT: 0,
    },
  });
  await server.ready();
  await registerAdminRoutes(server, config);
  registerRequestPipeline(server, config);
  server.ccrPreHandlerCallbacks = createCcrPreHandlerCallbacks(config);
  // Registered AFTER the pipeline hook (so it fires last) but BEFORE ready()
  // (Fastify forbids addHook on a listening instance).
  const sentinel = onResponseSentinel(server);
  await server.registerNamespace("/");
  await server.app.ready();
  return { server, config, sentinel };
}

describe("streaming SSE error after delivered content (end-to-end)", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    getHealthStore().clear();
    resetFallbackPromotionStore();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    getHealthStore().clear();
    resetFallbackPromotionStore();
  });

  it("records SUCCESS when the client received the full content despite a mid-stream error frame", async () => {
    let fetchCalls = 0;
    // Split per SSE event so the shape matches production: the first network
    // chunk carries message_start, the content follows, and the error frame
    // arrives only after the answer was already on the wire.
    globalThis.fetch = vi.fn(async () => {
      fetchCalls++;
      return chatSse(
        [
          { id: "c1", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
          { id: "c1", choices: [{ index: 0, delta: { content: "hello world" }, finish_reason: null }] },
          { error: { type: "server_error", message: "upstream exploded mid-stream" } },
        ],
        true
      );
    }) as any;

    const { server, sentinel } = await buildRuntime();
    const hooksDone = sentinel.arm();
    const res = await server.app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-anthropic-billing-header": "cc_version=9.9" },
      payload: { model: "ccr-opus", max_tokens: 64, stream: true, messages: [{ role: "user", content: "hi" }] },
    });
    await hooksDone;

    // The client received the complete answer.
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain("hello world");

    // The production bug: this request was ALSO recorded as a failure, so the
    // provider card stayed red and failureCount climbed on every single turn.
    const state = getHealthStore().getState("primary", "model-a");
    expect(state).toBeUndefined();

    // No retry was paid for a delivered answer.
    expect(fetchCalls).toBe(1);
  });

  it("still records FAILURE when the stream carries an error and no content at all", async () => {
    globalThis.fetch = vi.fn(async () =>
      chatSse([{ error: { type: "server_error", message: "upstream exploded immediately" } }], true)
    ) as any;

    const { server, sentinel } = await buildRuntime();
    const hooksDone = sentinel.arm();
    const res = await server.app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-anthropic-billing-header": "cc_version=9.9" },
      payload: { model: "ccr-opus", max_tokens: 64, stream: true, messages: [{ role: "user", content: "hi" }] },
    });
    await hooksDone;

    // Nothing was delivered: the request must surface as a failure and book it
    // in the health store (the sseError-only path stays intact).
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    const state = getHealthStore().getState("primary", "model-a");
    expect(state).toBeDefined();
    expect(state!.failureCount).toBeGreaterThan(0);
  });
});
