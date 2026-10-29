import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Server from "../server";
import { registerRequestPipeline, createCcrPreHandlerCallbacks } from "../ccr/request-pipeline";
import { registerAdminRoutes } from "../ccr/admin-routes";
import { getHealthStore } from "../services/provider-health";
import { resetFallbackPromotionStore } from "../utils/fallback-promotion";

/**
 * End-to-end regression for the reported "message sent, nothing comes back" turn.
 *
 * The upstream returned HTTP 200 with `end_turn` and no content at all. The
 * request path never threw, so the fallback chain never ran and the empty answer
 * was even recorded as a provider success — every retry hit the same dead model.
 *
 * These tests assert the whole chain (not just the guard): an empty answer must
 * surface as a failed primary attempt and be served by the fallback model.
 */

const enc = new TextEncoder();

const sse = (...events: Array<[string, unknown]>): string =>
  events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");

/** Exactly what the reported turn looked like: 200, end_turn, no content block. */
const EMPTY_ANSWER = sse(
  ["message_start", { type: "message_start", message: { id: "msg_e", role: "assistant", content: [] } }],
  ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } }],
  ["message_stop", { type: "message_stop" }]
);

const TEXT_ANSWER = sse(
  ["message_start", { type: "message_start", message: { id: "msg_o", role: "assistant", content: [] } }],
  ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "recovered" } }],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }],
  ["message_stop", { type: "message_stop" }]
);

function streamOf(wire: string): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(enc.encode(wire));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );
}

async function buildRuntime(overrides: Record<string, any> = {}) {
  const config: any = {
    PORT: 0,
    APIKEY: "secret",
    Providers: [
      // A single native-Anthropic transformer keeps the upstream SSE byte-for-byte,
      // so these tests exercise the guard against the exact wire shape the client
      // receives (not a re-synthesis that would hide missing content).
      { name: "primary", api_base_url: "https://primary.example/v1/messages", api_key: "k1", models: ["dead"], transformer: { use: ["Anthropic"] } },
      { name: "backup", api_base_url: "https://backup.example/v1/messages", api_key: "k2", models: ["alive"], transformer: { use: ["Anthropic"] } },
    ],
    Router: {
      // Pin the family to the dead model the same way the runtime-integration
      // tests pin theirs, so the request provably reaches `primary` first and the
      // fallback chain (not the router's own ordering) is what serves the answer.
      enableFamilyRouting: true,
      enableFallback: true,
      families: {
        opus: { default: "primary,dead" },
      },
      fallback: { default: ["backup,alive"] },
    },
    ...overrides,
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
  await server.registerNamespace("/");
  await server.app.ready();
  return { server, config };
}

describe("empty answer triggers fallback (end-to-end)", () => {
  let originalFetch: typeof globalThis.fetch;
  let hits: string[];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    hits = [];
    // Two process singletons can leak state across tests: the health store
    // (circuit state) and the fallback-promotion store (which promotes a backup
    // after a primary failure). Either one left dirty would silently change
    // routing for the next test. clear() keeps the same health instance because
    // resetHealthStore() would hand the router a different object.
    getHealthStore().clear();
    resetFallbackPromotionStore();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    getHealthStore().clear();
    resetFallbackPromotionStore();
  });

  it("falls back when the primary model answers 200 with no content", async () => {
    globalThis.fetch = vi.fn(async (url: any) => {
      const target = String(url);
      hits.push(target);
      return streamOf(target.includes("primary.example") ? EMPTY_ANSWER : TEXT_ANSWER);
    }) as any;

    const { server } = await buildRuntime();
    const res = await server.app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-anthropic-billing-header": "cc_version=9.9" },
      payload: { model: "ccr-opus", max_tokens: 64, stream: true, messages: [{ role: "user", content: "hi" }] },
    });

    // The dead model must not be served to the client as an empty turn.
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain("recovered");
    // ...and the fallback must actually have been called.
    expect(hits.some((h) => h.includes("backup.example"))).toBe(true);
  });

  it("retries the dead model and then falls back (empty answer is not a success)", async () => {
    const callsByHost: Record<string, number> = {};
    globalThis.fetch = vi.fn(async (url: any) => {
      const target = String(url);
      const host = new URL(target).host;
      callsByHost[host] = (callsByHost[host] ?? 0) + 1;
      return streamOf(target.includes("primary.example") ? EMPTY_ANSWER : TEXT_ANSWER);
    }) as any;

    const { server } = await buildRuntime();
    const res = await server.app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-anthropic-billing-header": "cc_version=9.9" },
      payload: { model: "ccr-opus", max_tokens: 64, stream: true, messages: [{ role: "user", content: "hi" }] },
    });

    // The dead model's empty answer must not be served as a successful turn: the
    // request has to end up on the fallback model with real content. Before the
    // fix nothing threw, so the client saw an empty turn and the dead model was
    // even recorded as healthy.
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain("recovered");
    // The empty answer is treated as a transient failure, so the SAME model is
    // retried once before the chain moves on. Asserting the retry is what keeps
    // this test honest: skipping straight to fallback would also "pass" a test
    // that only looked at the backup host.
    // The empty answer is treated as transient, so the SAME model is retried once
    // before the chain moves on. Asserting the retry is what keeps this test
    // honest: skipping straight to fallback would also "pass" a test that only
    // looked at the backup host.
    expect(callsByHost["primary.example"]).toBe(2);
    expect(callsByHost["backup.example"] ?? 0).toBeGreaterThan(0);
    expect(callsByHost["backup.example"] ?? 0).toBeGreaterThan(0);
  });

  it("still serves a legitimate tool-only answer without falling back", async () => {
    const toolOnly = sse(
      ["message_start", { type: "message_start", message: { id: "msg_t", content: [] } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu", name: "read", input: {} } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["message_stop", { type: "message_stop" }]
    );
    const callsByHost: Record<string, number> = {};
    globalThis.fetch = vi.fn(async (url: any) => {
      const target = String(url);
      hits.push(target);
      const host = new URL(target).host;
      callsByHost[host] = (callsByHost[host] ?? 0) + 1;
      return streamOf(toolOnly);
    }) as any;

    // No fallback chain here on purpose: if a tool-only turn were misjudged as
    // empty, the request would surface as an error instead of being quietly
    // rescued by another provider.
    const { server } = await buildRuntime({ Router: { enableFamilyRouting: true, families: { opus: { default: "primary,dead" } } } });
    const res = await server.app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-anthropic-billing-header": "cc_version=9.9" },
      payload: { model: "ccr-opus", max_tokens: 64, stream: true, messages: [{ role: "user", content: "hi" }] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain("tool_use");
    // A tool-only turn is a real answer: no fallback.
    expect(callsByHost["backup.example"] ?? 0).toBe(0);
    expect(callsByHost["primary.example"] ?? 0).toBeGreaterThan(0);
  });
});
