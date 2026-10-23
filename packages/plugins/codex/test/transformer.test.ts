/**
 * CodexTransformer — request finalization, response-side termination and quota
 * observation (docs/design/provider-plugins.md §5.2; research §3).
 *
 * Every upstream interaction is an in-memory Response; no network, no real
 * account, no host runtime import. The service is a structural stub matching
 * `CodexServiceLike`.
 */
import { describe, expect, it, vi } from "vitest";
import {
  CODEX_RATE_LIMIT_SCAN_BYTES,
  CodexTransformer,
  codexStreamError,
  codexTerminalError,
  parseCodexRateLimitsEvent,
  readCodexRateLimitHeaders,
} from "../src/transformer";
import type { CodexRateLimits } from "../src/protocol-quota";
import type { CodexServiceLike } from "../src/protocol";

function stubService(over: Partial<CodexServiceLike> = {}) {
  const observed: CodexRateLimits[] = [];
  const errors: any[] = [];
  const service: CodexServiceLike & { observed: CodexRateLimits[]; errors: any[] } = {
    observed, errors,
    getAccessToken: async () => "token",
    getAccountId: async () => "acct",
    forceTokenRefresh: async () => {},
    isAccountCooling: async () => false,
    getModelInstructions: () => undefined,
    noteRateLimits: async (limits) => { observed.push(limits); },
    getRateLimits: async () => observed.at(-1) ?? null,
    noteUpstreamError: async (info) => { errors.push(info); },
    ...over,
  };
  return service;
}

const sse = (events: any[]) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
const sseResponse = (text: string, headers: Record<string, string> = {}) =>
  new Response(text, { status: 200, headers: { "content-type": "text/event-stream", ...headers } });

async function readAll(response: Response): Promise<string> {
  return await response.text();
}

describe("CodexTransformer — request phase", () => {
  it("finalizes the Responses body (store/stream/input) and never mutates the input", async () => {
    const t = new CodexTransformer({ service: stubService() });
    const request: any = {
      model: "gpt-5.1-codex",
      input: [{ type: "message", role: "system", content: [{ type: "input_text", text: "s" }] }],
      store: true, stream: false, temperature: 0.5,
    };
    const snapshot = JSON.stringify(request);
    const out = await t.transformRequestIn(request, undefined, {} as any);
    expect(JSON.stringify(request)).toBe(snapshot);
    expect(out.body).toMatchObject({ store: false, stream: true });
    expect(out.body).not.toHaveProperty("temperature");
    expect(out.body.input[0].role).toBe("developer");
  });

  it("injects the cached model instructions when the service has them", async () => {
    const service = stubService({ getModelInstructions: (m) => (m === "gpt-5.1-codex" ? "You are Codex." : undefined) });
    const t = new CodexTransformer({ service });
    const out = await t.transformRequestIn({ model: "gpt-5.1-codex", instructions: "client", input: [] } as any, undefined, {} as any);
    expect(out.body.instructions).toBe("You are Codex.");
    expect(out.body.input[0].content[0].text).toBe("client");
  });

  it("survives a throwing getModelInstructions (cache read must not fail the request)", async () => {
    const service = stubService({ getModelInstructions: () => { throw new Error("boom"); } });
    const t = new CodexTransformer({ service });
    const out = await t.transformRequestIn({ model: "m", input: [], instructions: "own" } as any, undefined, {} as any);
    expect(out.body.instructions).toBe("own");
  });

  it("derives a stable session key from the server-provided stable session id", async () => {
    const t = new CodexTransformer({ service: stubService() });
    const ctx: any = { req: { clientContext: { stableSessionId: "sess-1" } } };
    const a = await t.transformRequestIn({ model: "m", input: [{ type: "message", role: "user", content: [] }] } as any, undefined, ctx);
    const b = await t.transformRequestIn({ model: "m", input: [{ type: "message", role: "user", content: [] }] } as any, undefined, { ...ctx });
    expect(a.body.prompt_cache_key).toBe(b.body.prompt_cache_key);
    expect(ctx.codexSessionKey).toBe(a.body.prompt_cache_key);
  });

  it("requires a service at construction", () => {
    expect(() => new CodexTransformer({} as any)).toThrow();
  });
});

describe("CodexTransformer — response phase, happy path", () => {
  it("passes a Responses SSE stream through byte-identically after content commits", async () => {
    const t = new CodexTransformer({ service: stubService() });
    const text = sse([
      { type: "response.created", response: { id: "r" } },
      { type: "response.output_text.delta", delta: "hello" },
      { type: "response.output_text.delta", delta: " world" },
      { type: "response.completed", response: { id: "r" } },
    ]) + "data: [DONE]\n\n";
    const out = await t.transformResponseOut(sseResponse(text), {} as any);
    expect(await readAll(out)).toBe(text);
  });

  it("leaves a non-stream JSON body untouched", async () => {
    const t = new CodexTransformer({ service: stubService() });
    const body = JSON.stringify({ object: "response", output: [] });
    const res = new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    const out = await t.transformResponseOut(res, {} as any);
    expect(await out.text()).toBe(body);
  });

  it("drops content-length so the rewritten stream is not mis-sized", async () => {
    const t = new CodexTransformer({ service: stubService() });
    const res = sseResponse(sse([{ type: "response.output_text.delta", delta: "x" }]), { "content-length": "999" });
    const out = await t.transformResponseOut(res, {} as any);
    expect(out.headers.get("content-length")).toBeNull();
  });
});

describe("CodexTransformer — terminal stream errors", () => {
  it("throws on a top-level error event instead of forwarding a truncated reply", async () => {
    const service = stubService();
    const t = new CodexTransformer({ service });
    const text = sse([
      { type: "response.created", response: { id: "r" } },
      { type: "error", error: { type: "usage_limit_reached", message: "limit", resets_in_seconds: 120 } },
    ]);
    // The THROWN error is the CLASSIFIED plugin error: canonical whitelisted
    // code, semantic status, nonRetryable/pluginClassified and no rawBody —
    // so the core surfaces a safe codex_* error instead of forwarding the raw
    // upstream envelope.
    await expect(readAll(await t.transformResponseOut(sseResponse(text), {} as any))).rejects.toMatchObject({
      code: "codex_usage_limit",
      statusCode: 429,
      nonRetryable: true,
      pluginClassified: true,
    });
    // The failure is reported on the noteUpstreamError channel with the SAME
    // canonical code (ruling B: quota classification cools the account).
    expect(service.errors.at(-1)).toMatchObject({ code: "codex_usage_limit" });
    expect(service.errors.at(-1)!.cooldownMs).toBe(120_000);
  });

  it("throws a classified error on response.failed even without an error body", async () => {
    const t = new CodexTransformer({ service: stubService() });
    const text = sse([{ type: "response.failed", response: { id: "r" } }]);
    await expect(readAll(await t.transformResponseOut(sseResponse(text), {} as any))).rejects.toMatchObject({
      code: "codex_overloaded",
      statusCode: 502,
      nonRetryable: false,
      pluginClassified: true,
    });
  });

  it("cools the account on a quota failure nested under response.failed", async () => {
    const service = stubService();
    const t = new CodexTransformer({ service });
    const text = sse([
      { type: "response.created", response: { id: "r" } },
      { type: "response.failed", response: { id: "r", error: { type: "usage_limit_reached", resets_in_seconds: 300 } } },
    ]);
    await expect(readAll(await t.transformResponseOut(sseResponse(text), {} as any))).rejects.toMatchObject({
      code: "codex_usage_limit", statusCode: 429,
    });
    expect(service.errors.at(-1)).toMatchObject({ code: "codex_usage_limit", cooldownMs: 300_000 });
  });

  it("passes response.incomplete and response.completed as normal completions", async () => {
    const t = new CodexTransformer({ service: stubService() });
    const text = sse([{ type: "response.incomplete", response: { id: "r", status: "incomplete" } }]);
    const out = await t.transformResponseOut(sseResponse(text), {} as any);
    expect(await readAll(out)).toBe(text);
  });

  it("codexTerminalError ignores content deltas and created/in_progress", () => {
    expect(codexTerminalError({ type: "response.output_text.delta", delta: "x" })).toBeUndefined();
    expect(codexTerminalError({ type: "response.created" })).toBeUndefined();
    expect(codexTerminalError({ type: "error", error: { message: "m" } })).toEqual({ message: "m" });
  });

  it("codexStreamError marks usage_limit_reached as a rate-limit class", () => {
    const error = codexStreamError({ type: "error", error: { type: "usage_limit_reached" } }, 200);
    expect(error.isRateLimit).toBe(true);
    expect(error.statusCode).toBe(200);
  });
});

describe("CodexTransformer — chunk-boundary inspection", () => {
  // Real upstreams split an SSE event across TCP/TLS/HTTP2 chunks routinely;
  // the parser carry-over must survive every boundary (B1 regression).
  const sseChunks = (events: any[], cutAt: (whole: string) => [string, string]): ReadableStream<Uint8Array> => {
    const whole = sse(events);
    const [a, b] = cutAt(whole);
    const enc = new TextEncoder();
    return new ReadableStream({
      start(controller) { controller.enqueue(enc.encode(a)); controller.enqueue(enc.encode(b)); controller.close(); },
    });
  };

  it("observes a codex.rate_limits event split across two chunks", async () => {
    const service = stubService();
    const t = new CodexTransformer({ service });
    const events = [
      { type: "codex.rate_limits", rate_limits: { primary: { used_percent: 91, window_minutes: 10080, reset_at: 1800000000 } } },
      { type: "response.output_text.delta", delta: "x" },
    ];
    const whole = sse(events);
    for (const cut of [10, Math.floor(whole.length / 2), whole.length - 14, whole.length - 1]) {
      service.observed.length = 0;
      const body = new ReadableStream({
        start(c) {
          const enc = new TextEncoder();
          c.enqueue(enc.encode(whole.slice(0, cut)));
          c.enqueue(enc.encode(whole.slice(cut)));
          c.close();
        },
      });
      const res = new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
      await readAll(await t.transformResponseOut(res, {} as any));
      expect(service.observed.some((o) => o.source === "sse"), `cut=${cut}`).toBe(true);
    }
  });

  it("throws (not truncates) on a terminal error event split across two chunks", async () => {
    const service = stubService();
    const t = new CodexTransformer({ service });
    const events = [
      { type: "response.created", response: { id: "r" } },
      { type: "error", error: { type: "usage_limit_reached", message: "limit", resets_in_seconds: 120 } },
    ];
    const whole = sse(events);
    const cut = whole.indexOf("usage_limit") - 3;
    const body = new ReadableStream({
      start(c) {
        const enc = new TextEncoder();
        c.enqueue(enc.encode(whole.slice(0, cut)));
        c.enqueue(enc.encode(whole.slice(cut)));
        c.close();
      },
    });
    const res = new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    await expect(readAll(await t.transformResponseOut(res, {} as any))).rejects.toMatchObject({
      code: "codex_usage_limit", pluginClassified: true,
    });
    expect(service.errors.at(-1)).toMatchObject({ code: "codex_usage_limit" });
  });

  it("forwards every byte verbatim even when an event straddles a boundary", async () => {
    const service = stubService();
    const t = new CodexTransformer({ service });
    const events = [
      { type: "codex.rate_limits", rate_limits: { primary: { used_percent: 10, window_minutes: 300, reset_at: 1800000000 } } },
      { type: "response.output_text.delta", delta: "hello world" },
    ];
    const whole = sse(events);
    const cut = Math.floor(whole.length / 2);
    const body = sseChunks(events, (w) => [w.slice(0, cut), w.slice(cut)]);
    const res = new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    expect(await readAll(await t.transformResponseOut(res, {} as any))).toBe(whole);
  });
});

describe("CodexTransformer — quota observation", () => {
  it("reports x-codex window headers on a response", async () => {
    const service = stubService();
    const t = new CodexTransformer({ service });
    const res = sseResponse(sse([{ type: "response.output_text.delta", delta: "x" }]), {
      "x-codex-primary-used-percent": "42",
      "x-codex-primary-window-minutes": "300",
      "x-codex-primary-reset-at": "1800000000",
    });
    await readAll(await t.transformResponseOut(res, {} as any));
    expect(service.observed.at(-1)).toMatchObject({ source: "headers", primary: { usedPercent: 42, windowSeconds: 18000 } });
  });

  it("reports the codex.rate_limits SSE event from the stream prefix", async () => {
    const service = stubService();
    const t = new CodexTransformer({ service });
    const text = sse([
      { type: "codex.rate_limits", rate_limits: { primary: { used_percent: 91, window_minutes: 10080, reset_at: 1800000000 } } },
      { type: "response.output_text.delta", delta: "x" },
    ]);
    // The SSE channel is observed lazily while the prefix is streamed: consume
    // the body before asserting (mirrors the real client reading the reply).
    await readAll(await t.transformResponseOut(sseResponse(text), {} as any));
    const observed = service.observed.find((o) => o.source === "sse");
    expect(observed).toMatchObject({ primary: { usedPercent: 91, windowSeconds: 604800 } });
  });

  it("ignores a codex.rate_limits event whose metered_limit_name is not codex", async () => {
    const service = stubService();
    const t = new CodexTransformer({ service });
    const text = sse([
      { type: "codex.rate_limits", rate_limits: { metered_limit_name: "gpt-5.1-codex", primary: { used_percent: 99 } } },
      { type: "response.output_text.delta", delta: "x" },
    ]);
    await readAll(await t.transformResponseOut(sseResponse(text), {} as any));
    expect(service.observed.some((o) => o.source === "sse")).toBe(false);
  });

  it("never lets a rejecting noteRateLimits break the response path", async () => {
    const service = stubService({ noteRateLimits: async () => { throw new Error("bookkeeper down"); } });
    const t = new CodexTransformer({ service });
    const res = sseResponse(sse([{ type: "response.output_text.delta", delta: "x" }]), { "x-codex-primary-used-percent": "5" });
    const out = await t.transformResponseOut(res, {} as any);
    await expect(readAll(out)).resolves.toContain("output_text.delta");
  });

  it("never lets a synchronously throwing noteRateLimits break the response path", async () => {
    const service = stubService({ noteRateLimits: (() => { throw new Error("sync boom"); }) as any });
    const t = new CodexTransformer({ service });
    const out = await t.transformResponseOut(sseResponse(sse([{ type: "response.output_text.delta", delta: "x" }]), { "x-codex-primary-used-percent": "5" }), {} as any);
    await expect(readAll(out)).resolves.toContain("output_text.delta");
  });
});

describe("CodexTransformer — quota parsing: the four required cases", () => {
  it("1) headers only", () => {
    const limits = readCodexRateLimitHeaders(new Headers({
      "x-codex-primary-used-percent": "10",
      "x-codex-primary-window-minutes": "300",
      "x-codex-primary-reset-at": "1800000000",
      "x-codex-secondary-used-percent": "20",
      "x-codex-secondary-window-minutes": "10080",
    }), 111);
    expect(limits).toEqual({
      source: "headers", observedAt: 111,
      primary: { usedPercent: 10, windowSeconds: 18000, resetAt: 1800000000000 },
      secondary: { usedPercent: 20, windowSeconds: 604800 },
    });
    expect(readCodexRateLimitHeaders(new Headers({ "x-ratelimit-remaining": "1" }))).toBeUndefined();
  });

  it("2) SSE only (and -reset-after-seconds fallback)", () => {
    const limits = parseCodexRateLimitsEvent({
      type: "codex.rate_limits",
      rate_limits: { primary: { used_percent: 55, window_minutes: 300, reset_at: 1700000000 } },
    }, 222);
    expect(limits).toMatchObject({ source: "sse", observedAt: 222, primary: { usedPercent: 55, windowSeconds: 18000, resetAt: 1700000000000 } });
    expect(parseCodexRateLimitsEvent({ type: "other" })).toBeUndefined();
  });

  it("3) both channels conflict: mergeCodexRateLimits takes the later observedAt and the further resetAt", async () => {
    const { mergeCodexRateLimits } = await import("../src/protocol-quota");
    const headers = readCodexRateLimitHeaders(new Headers({
      "x-codex-primary-used-percent": "70", "x-codex-primary-reset-at": "1800000000",
    }), 1000)!;
    const fromSse = parseCodexRateLimitsEvent({
      type: "codex.rate_limits", rate_limits: { primary: { used_percent: 75, reset_at: 1800000600 } },
    }, 2000)!;
    const merged = mergeCodexRateLimits(headers, fromSse);
    expect(merged.observedAt).toBe(2000);            // later observation
    expect(merged.source).toBe("sse");
    expect(merged.primary!.usedPercent).toBe(75);     // percent from the later side
    expect(merged.primary!.resetAt).toBe(1800000600000); // further of the two resets
    // Order independence for the reset choice:
    const reversed = mergeCodexRateLimits(fromSse, headers);
    expect(reversed.primary!.resetAt).toBe(1800000600000);
    expect(reversed.source).toBe("sse");             // still the later observedAt
  });

  it("4) metered_limit_name other than codex is ignored", () => {
    expect(parseCodexRateLimitsEvent({
      type: "codex.rate_limits",
      rate_limits: { metered_limit_name: "gpt-6-codex", primary: { used_percent: 100 } },
    })).toBeUndefined();
    // and "codex" is accepted
    expect(parseCodexRateLimitsEvent({
      type: "codex.rate_limits",
      rate_limits: { metered_limit_name: "codex", primary: { used_percent: 100 } },
    })).toMatchObject({ primary: { usedPercent: 100 } });
  });
});

describe("CodexTransformer — bounded scan and cancellation", () => {
  it("stops inspecting after the bounded window and then passes bytes through unbuffered", async () => {
    // A stream with no content-committing event until far past the scan budget.
    const filler = "event: response.created\ndata: {\"type\":\"response.created\"}\n\n";
    const repeat = Math.ceil((CODEX_RATE_LIMIT_SCAN_BYTES * 2) / filler.length);
    const text = filler.repeat(repeat) + "data: [DONE]\n\n";
    const service = stubService();
    const t = new CodexTransformer({ service });
    const out = await t.transformResponseOut(sseResponse(text), {} as any);
    const received = await readAll(out);
    expect(received).toBe(text);
  });

  it("propagates a client cancel to the upstream reader", async () => {
    let cancelled = false;
    const encoder = new TextEncoder();
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("event: response.created\ndata: {\"type\":\"response.created\"}\n\n"));
      },
      cancel() { cancelled = true; },
    });
    const res = new Response(upstream, { status: 200, headers: { "content-type": "text/event-stream" } });
    const t = new CodexTransformer({ service: stubService() });
    const out = await t.transformResponseOut(res, {} as any);
    const reader = out.body!.getReader();
    await reader.read();
    await reader.cancel("client gone");
    expect(cancelled).toBe(true);
  });

  it("does not accumulate the whole response in memory before emitting (streams incrementally)", async () => {
    // Verify the FIRST content chunk is delivered before the stream closes.
    let closeUpstream!: () => void;
    const encoder = new TextEncoder();
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("event: response.created\ndata: {\"type\":\"response.created\"}\n\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"a\"}\n\n"));
        closeUpstream = () => { controller.enqueue(encoder.encode("data: {\"type\":\"response.output_text.delta\",\"delta\":\"b\"}\n\n")); controller.close(); };
      },
    });
    const t = new CodexTransformer({ service: stubService() });
    const out = await t.transformResponseOut(new Response(upstream, { status: 200, headers: { "content-type": "text/event-stream" } }), {} as any);
    const reader = out.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("output_text.delta");
    closeUpstream();
    let rest = "";
    while (true) { const n = await reader.read(); if (n.done) break; rest += new TextDecoder().decode(n.value); }
    expect(rest).toContain("\"delta\":\"b\"");
  });
});
