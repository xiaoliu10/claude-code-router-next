import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createQoderManagedRuntime } from "../src/managed-runtime";
import { QODER_CHAT, QODER_SITES } from "../src/protocol";
import type { PluginHostCapabilities } from "../src/core-types";

function hostStub(): PluginHostCapabilities & { direct: any; subscription: any } {
  return {
    configDir: "/unused",
    readConfig: async () => ({}),
    writeConfig: async () => {},
    reloadRuntime: async () => {},
    getDirectDispatcher: () => ({ kind: "direct" }),
    getSubscriptionDispatcher: () => ({ kind: "subscription" }),
    direct: { kind: "direct" },
    subscription: { kind: "subscription" },
  } as any;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function fakeService(over: Partial<Record<"ensureUsable" | "dispatch" | "noteUpstreamError" | "forceTokenRefresh", any>> = {}) {
  return {
    ensureUsable: vi.fn(async () => {}),
    dispatch: vi.fn(async () => new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })),
    noteUpstreamError: vi.fn(async () => {}),
    forceTokenRefresh: vi.fn(async () => {}),
    ...over,
  } as any;
}

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const erroredResponse = (error: Error) => new Response(new ReadableStream({
  pull(controller) { controller.error(error); },
}), { status: 200, headers: { "content-type": "text/event-stream" } });

describe("Qoder managed runtime", () => {
  it("pins destination and dispatcher, signs nothing, classifies and detects envelopes", async () => {
    const host = hostStub();
    const runtime = createQoderManagedRuntime(fakeService(), host);
    expect(runtime.name).toBe("qoder");
    expect(runtime.isManaged({ name: "qoder-subscription", api_key: "ccr-managed-qoder" })).toBe(true);
    expect(runtime.suppressDebugLog).toBe(true);

    const config: any = { url: "https://evil.invalid", dispatcher: "ambient" };
    await runtime.lockUpstream!(config, {} as any);
    expect(config.url).toBe(QODER_CHAT);
    expect(config.redirect).toBe("error");
    expect(config.dispatcher).toEqual(host.subscription);

    await expect(runtime.signRequest!({ headers: { authorization: "Bearer x" }, requestBody: {}, provider: {} as any }))
      .resolves.toEqual({});

    expect(runtime.classifyError!(0, "", "")).toMatchObject({ code: "qoder_upstream_error", httpStatus: 502, retryable: true });
    expect(runtime.classifyError!(401, "", "")).toMatchObject({ code: "qoder_reauth_required", retryable: false });
    expect(runtime.classifyError!(429, { retry_after: 120 }, "")).toMatchObject({ code: "qoder_rate_limited", cooldownMs: 120_000 });
    expect(runtime.classifyError!(500, "", "")).toMatchObject({ code: "qoder_upstream_error", retryable: true });
    expect(runtime.isErrorEnvelope!({ error: { type: "qoder_error" } })).toBe(true);
    expect(runtime.isErrorEnvelope!({ choices: [] })).toBe(false);
  });

  it("propagates client aborts as AbortError and cancels the engine signal", async () => {
    let seen: AbortSignal | undefined;
    const service = fakeService({ dispatch: (_body: any, signal: AbortSignal) => new Promise<Response>((_, reject) => {
      seen = signal;
      signal.addEventListener("abort", () => reject(new Error("aborted engine work")));
    }) });
    const runtime = createQoderManagedRuntime(service, hostStub());
    const req: any = { raw: new EventEmitter() };
    req.raw.socket = new EventEmitter();
    const pending = runtime.dispatchRequest!({ attempt: async () => new Response(), requestBody: {}, config: {}, provider: {} as any, req });
    await sleep(5);
    req.raw.emit("aborted");
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(seen!.aborted).toBe(true);
  });

  it("an already-aborted request never reaches the engine and aborts fast", async () => {
    const service = fakeService({ dispatch: vi.fn(async (_b: any, signal: AbortSignal) => {
      if (signal.aborted) throw new Error("late engine");
      return new Response("x");
    }) });
    const runtime = createQoderManagedRuntime(service, hostStub());
    await expect(runtime.dispatchRequest!({ attempt: async () => new Response(), requestBody: {}, config: {}, provider: {} as any, req: { raw: { aborted: true } } }))
      .rejects.toMatchObject({ name: "AbortError" });
  });

  it("applies the request deadline from config.TIMEOUT with a floor back to the default", async () => {
    const hanging = fakeService({ dispatch: (_b: any, signal: AbortSignal) => new Promise<Response>((_, reject) =>
      signal.addEventListener("abort", () => reject(new Error("deadline")))) });
    const runtime = createQoderManagedRuntime(hanging, hostStub(), "qoder", 60);
    const started = Date.now();
    await expect(runtime.dispatchRequest!({ attempt: async () => new Response(), requestBody: {}, config: { TIMEOUT: 80 }, provider: {} as any, req: { raw: new EventEmitter() } }))
      .rejects.toMatchObject({ name: "AbortError" });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(60);
    expect(elapsed).toBeLessThan(2000);
    // invalid TIMEOUT falls back to the runtime default (60ms here)
    const started2 = Date.now();
    await expect(runtime.dispatchRequest!({ attempt: async () => new Response(), requestBody: {}, config: { TIMEOUT: -5 }, provider: {} as any, req: { raw: new EventEmitter() } }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - started2).toBeLessThan(2000);
  }, 10_000);

  it("engine HTTP failures classify from the body (retry_after in the body, not headers)", async () => {
    const service = fakeService({ dispatch: async () => new Response(
      JSON.stringify({ error: { message: "slow down", type: "qoder_error", code: 429 }, retry_after: 90 }),
      { status: 429, headers: { "content-type": "application/json" } }) });
    const runtime = createQoderManagedRuntime(service, hostStub());
    await expect(runtime.dispatchRequest!({ attempt: async () => new Response(), requestBody: {}, config: {}, provider: {} as any, req: { raw: new EventEmitter() } }))
      .rejects.toMatchObject({ code: "qoder_rate_limited", statusCode: 429, cooldownMs: 90_000, pluginClassified: true });
  });

  it("refreshes once and replays a data-plane 401; other terminal failures update bookkeeping", async () => {
    const calls = [
      jsonResponse(401, { error: { type: "qoder_error", code: 401 } }),
      new Response("ok", { status: 200, headers: { "content-type": "text/plain" } }),
    ];
    const service = fakeService({ dispatch: vi.fn(async () => calls.shift()) });
    const runtime = createQoderManagedRuntime(service, hostStub());
    const req: any = { raw: Object.assign(new EventEmitter(), { socket: new EventEmitter() }) };
    const response = await runtime.dispatchRequest!({ attempt: async () => new Response(), requestBody: {}, config: {}, provider: {} as any, req });
    expect(response.status).toBe(200);
    expect(service.dispatch).toHaveBeenCalledTimes(2);
    expect(service.forceTokenRefresh).toHaveBeenCalledTimes(1);
    expect(service.noteUpstreamError).not.toHaveBeenCalled();

    const limited = fakeService({ dispatch: vi.fn(async () => jsonResponse(429, {
      error: { message: "slow down", type: "qoder_error", code: 429 }, retry_after: 90,
    })) });
    const limitedRuntime = createQoderManagedRuntime(limited, hostStub());
    await expect(limitedRuntime.dispatchRequest!({ attempt: async () => new Response(), requestBody: {}, config: {}, provider: {} as any, req: { raw: new EventEmitter() } }))
      .rejects.toMatchObject({ code: "qoder_rate_limited", statusCode: 429 });
    expect(limited.noteUpstreamError).toHaveBeenCalledWith(expect.objectContaining({
      code: "qoder_rate_limited", httpStatus: 429, cooldownMs: 90_000,
    }));
  });

  it("preserves AbortError when the wrapped upstream stream fails after cancellation", async () => {
    const controller = new AbortController();
    const service = fakeService({ dispatch: vi.fn(async () => erroredResponse(Object.assign(new Error("cancel"), { name: "AbortError" }))) });
    const runtime = createQoderManagedRuntime(service, hostStub());
    const req: any = { raw: Object.assign(new EventEmitter(), { socket: new EventEmitter() }) };
    const response = await runtime.dispatchRequest!({ attempt: async () => new Response(), requestBody: {}, config: { signal: controller.signal }, provider: {} as any, req });
    controller.abort();
    const reader = response.body!.getReader();
    await expect(reader.read()).rejects.toMatchObject({ name: "AbortError" });
    expect(service.noteUpstreamError).not.toHaveBeenCalled();
  });

  it("classified engine errors pass through; unknown failures are wrapped as safe upstream errors", async () => {
    const boom = Object.assign(new Error("secret detail"), { pluginClassified: true, code: "qoder_upstream_error", statusCode: 502 });
    const runtime = createQoderManagedRuntime(fakeService({ dispatch: async () => { throw boom; } }), hostStub());
    await expect(runtime.dispatchRequest!({ attempt: async () => new Response(), requestBody: {}, config: {}, provider: {} as any, req: { raw: new EventEmitter() } }))
      .rejects.toThrow(boom);

    const rawRuntime = createQoderManagedRuntime(fakeService({ dispatch: async () => { throw new Error("engine stack leak"); } }), hostStub());
    await expect(rawRuntime.dispatchRequest!({ attempt: async () => new Response(), requestBody: {}, config: {}, provider: {} as any, req: { raw: new EventEmitter() } }))
      .rejects.toMatchObject({ code: "qoder_upstream_error", statusCode: 502, pluginClassified: true });
  });

  it("streams pass through chunk-wise and cleanup runs when the engine stream ends or is cancelled", async () => {
    const upstreamReaderCancel = vi.fn();
    // finite stream: one chunk then EOF, so text() terminates
    let sent = 0;
    const service = fakeService({ dispatch: async () => new Response(new ReadableStream({
        pull(c) { if (sent++ >= 1) c.close(); else c.enqueue(new TextEncoder().encode("data: x\n\n")); },
        cancel() { upstreamReaderCancel(); },
      }), { status: 200, headers: { "content-type": "text/event-stream" } }) });
    const runtime = createQoderManagedRuntime(service, hostStub());
    const req: any = { raw: Object.assign(new EventEmitter(), { socket: new EventEmitter() }) };
    const response = await runtime.dispatchRequest!({ attempt: async () => new Response(), requestBody: {}, config: {}, provider: {} as any, req });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toBe("data: x\n\n");
    expect(req.raw.listenerCount("aborted")).toBe(0);

    // consumer cancellation aborts the controller and the upstream reader
    const infiniteCancel = vi.fn();
    const cancelService = fakeService({ dispatch: async () => new Response(new ReadableStream({
        pull(c) { c.enqueue(new TextEncoder().encode("data: y\n\n")); },
        cancel() { infiniteCancel(); },
      }), { status: 200, headers: { "content-type": "text/event-stream" } }) });
    const cancelRuntime = createQoderManagedRuntime(cancelService, hostStub());
    const response2 = await cancelRuntime.dispatchRequest!({ attempt: async () => new Response(), requestBody: {}, config: {}, provider: {} as any, req: { raw: Object.assign(new EventEmitter(), { socket: new EventEmitter() }) } });
    const reader = response2.body!.getReader();
    await reader.read();
    await reader.cancel("client left");
    expect(infiniteCancel).toHaveBeenCalled();
    expect(req.raw.listenerCount("aborted")).toBe(0);
  });
});

describe("Qoder CN managed runtime", () => {
  it("replays CN's data-plane 401 once and records CN cooling through its own service", async () => {
    const responses = [
      jsonResponse(401, { error: { type: "qoder_error", code: 401 } }),
      new Response("ok", { status: 200, headers: { "content-type": "text/plain" } }),
    ];
    const replaying = fakeService({ dispatch: vi.fn(async () => responses.shift()) });
    const runtime = createQoderManagedRuntime(replaying, hostStub(), "qoder-cn");
    const response = await runtime.dispatchRequest!({ attempt: async () => new Response(), requestBody: { model: "m" },
      config: {}, provider: {} as any, req: { raw: Object.assign(new EventEmitter(), { socket: new EventEmitter() }) } });
    expect(response.status).toBe(200);
    expect(replaying.dispatch).toHaveBeenCalledTimes(2);
    expect(replaying.forceTokenRefresh).toHaveBeenCalledTimes(1);

    const limited = fakeService({ dispatch: vi.fn(async () => jsonResponse(429, {
      error: { message: "slow down", type: "qoder_error", code: 429 }, retry_after: 45,
    })) });
    const limitedRuntime = createQoderManagedRuntime(limited, hostStub(), "qoder-cn");
    await expect(limitedRuntime.dispatchRequest!({ attempt: async () => new Response(), requestBody: { model: "m" },
      config: {}, provider: {} as any, req: { raw: new EventEmitter() } }))
      .rejects.toMatchObject({ code: "qoder_rate_limited", statusCode: 429 });
    expect(limited.noteUpstreamError).toHaveBeenCalledWith(expect.objectContaining({
      code: "qoder_rate_limited", httpStatus: 429, cooldownMs: 45_000,
    }));
  });

  it("pins the CN chat upstream and claims only the CN provider", async () => {
    const host = hostStub();
    const service = fakeService();
    const runtime = createQoderManagedRuntime(service, host, "qoder-cn");
    const intlRuntime = createQoderManagedRuntime(fakeService(), host);
    expect(runtime.name).toBe("qoder-cn");
    expect(intlRuntime.name).toBe("qoder");
    expect(runtime.isManaged({ name: "qoder-cn-subscription", api_key: "ccr-managed-qoder-cn" })).toBe(true);
    expect(runtime.isManaged({ name: "qoder-subscription", api_key: "ccr-managed-qoder" })).toBe(false);
    expect(intlRuntime.isManaged({ name: "qoder-cn-subscription", api_key: "ccr-managed-qoder-cn" })).toBe(false);
    expect(intlRuntime.isManaged({ name: "qoder-subscription", api_key: "ccr-managed-qoder" })).toBe(true);

    const config: any = { url: "https://evil.invalid", dispatcher: "ambient" };
    await runtime.lockUpstream!(config, {} as any);
    expect(config.url).toBe(QODER_SITES[1].chatUrl);
    expect(config.url).toContain("https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation");
    expect(config.redirect).toBe("error");
    expect(config.dispatcher).toEqual(host.subscription);
    // classification is site-independent
    expect(runtime.classifyError!(429, { retry_after: 60 }, "")).toMatchObject({ code: "qoder_rate_limited", cooldownMs: 60_000 });

    // the wrapper dispatches through ITS OWN service (bookkeeping stays per site)
    const response = await runtime.dispatchRequest!({ attempt: async () => new Response(), requestBody: { model: "m" },
      config: {}, provider: {} as any, req: { raw: Object.assign(new EventEmitter(), { socket: new EventEmitter() }) } });
    expect(response.status).toBe(200);
    expect(service.dispatch).toHaveBeenCalledTimes(1);
  });
});
