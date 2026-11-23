import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Server from "../server";
import { registerRequestPipeline } from "../ccr/request-pipeline";
import * as usageStore from "../ccr/usage-store";
import { getHealthStore } from "../services/provider-health";
import { resetFallbackPromotionStore } from "../utils/fallback-promotion";
import { sessionUsageCache } from "../utils/cache";

const endpoint = "/v1/chat/completions";
const config = {
  providers: ["primary", "family", "backup"].map(name => ({
    name, models: [`${name}-model`], api_base_url: `https://${name}.invalid${endpoint}`, api_key: "fixture-key",
  })),
  Router: {
    enableFamilyRouting: true, enableFallback: true,
    families: { opus: { default: "primary,primary-model", fallback: { default: ["family,family-model"] } } },
    fallback: { default: ["backup,backup-model"] },
  },
};
const sessionId = "chat-capture-session";
const sessionKey = `claude-code:session:${sessionId}`;
const usage = { prompt_tokens: 17, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 4 } };
const text = { model: "upstream-echo", choices: [{ index: 0, delta: { content: "answer" }, finish_reason: null }] };
const finish = { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
const trailer = { choices: [], usage };
function sse(...frames: (object | string)[]) {
  const body = frames.map(frame => `data: ${typeof frame === "string" ? frame : JSON.stringify(frame)}\r\n\r\n`).join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}
function mockFallback(backup: () => Response) {
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const name = new URL(input).hostname;
    if (name === "backup.invalid") return backup();
    return Response.json({ error: { message: "fixture failure" } }, { status: name === "family.invalid" ? 429 : 503 });
  }));
}

let server: Server;
let settled: Promise<void>;
const attemptFailure = vi.fn();
const finalRows = () => vi.mocked(usageStore.append).mock.calls.map(([record]) => record);

beforeEach(async () => {
  getHealthStore().clear();
  resetFallbackPromotionStore();
  attemptFailure.mockClear();
  vi.spyOn(usageStore, "append").mockImplementation(() => {});
  server = new Server({ logger: false, useJsonFile: false, initialConfig: config });
  await server.ready();
  server.recordUsage = attemptFailure;
  registerRequestPipeline(server, config);
  settled = new Promise(resolve => server.app.addHook("onResponse", async () => resolve()));
  await server.registerNamespace("/");
});
afterEach(async () => {
  await server.app.close();
  sessionUsageCache.delete(sessionKey);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  getHealthStore().clear();
  resetFallbackPromotionStore();
});
async function send(stream: boolean, model = "ccr-opus") {
  const result = await server.app.inject({ method: "POST", url: endpoint, payload: {
    model, stream, messages: [{ role: "user", content: "hello" }], metadata: { user_id: JSON.stringify({ session_id: sessionId }) },
  } });
  await settled;
  return result;
}

describe("Chat final request accounting", () => {
  it.each([false, true])("books the final provider and reported usage after 503 and 429 (stream=%s)", async stream => {
    mockFallback(() => stream ? sse(text, finish, trailer, "[DONE]") : Response.json({
      model: text.model, choices: [{ message: { role: "assistant", content: "answer" }, finish_reason: "stop" }], usage,
    }));
    const success = vi.spyOn(getHealthStore(), "recordSuccess");
    const response = await send(stream);
    expect(response.statusCode).toBe(200);
    expect(attemptFailure.mock.calls.map(([row]) => row.provider)).toEqual(["primary", "family"]);
    expect(finalRows()).toHaveLength(1);
    expect(finalRows()[0]).toMatchObject({ provider: "backup", model: "backup-model", originalModel: "ccr-opus",
      modelFamily: "opus", upstreamModel: text.model, stream, status: "success", sessionId,
      inputTokens: 17, outputTokens: 5, cacheReadInputTokens: 4, ttft: stream ? expect.any(Number) : null });
    expect(success.mock.calls).toEqual([["backup", "backup-model"]]);
  });

  it.each([
    ["partial content", [text, trailer]],
    ["partial content followed by [DONE]", [text, trailer, "[DONE]"]],
    ["second unfinished choice", [text, { choices: [{ ...text.choices[0], index: 1 }] }, finish, "[DONE]"]],
    ["finish after [DONE]", [text, "[DONE]", finish]],
    ["error-only", [{ error: { message: "fixture SSE failure" }, usage }]],
  ] as const)("records %s as an error exactly once", async (_label, frames) => {
    vi.stubGlobal("fetch", vi.fn(() => sse(...frames)));
    const failure = vi.spyOn(getHealthStore(), "recordFailure");
    const success = vi.spyOn(getHealthStore(), "recordSuccess");
    expect((await send(true, "primary,primary-model")).statusCode).toBe(200);
    expect(finalRows()).toHaveLength(1);
    expect(finalRows()[0]).toMatchObject({ provider: "primary", model: "primary-model", originalModel: "primary,primary-model",
      status: "error", errorMessage: expect.any(String), ttft: null, outputTokens: 0 });
    expect(success).not.toHaveBeenCalled();
    expect(failure).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("redacts SSE error text in usage and health (rate limited=%s)", async limited => {
    const message = `private fixture ${limited ? "quota exhausted" : "upstream failure"}`;
    vi.stubGlobal("fetch", vi.fn(() => sse(text, { error: { message } }, "[DONE]")));
    const failure = vi.spyOn(getHealthStore(), "recordFailure");
    const rateLimit = vi.spyOn(getHealthStore(), "markRateLimited");
    const response = await send(true, "primary,primary-model");
    expect(response.body).toContain(message);
    expect(finalRows()).toHaveLength(1);
    expect(finalRows()[0]).toMatchObject({ status: "error", errorMessage: "Chat stream returned an error", responseBody: undefined });
    expect(JSON.stringify(finalRows())).not.toContain(message);
    expect(failure.mock.calls).toEqual(limited ? [] : [["primary", "primary-model", "Chat stream returned an error"]]);
    expect(rateLimit.mock.calls).toEqual(limited ? [["primary", "primary-model", 120, "Chat stream returned an error"]] : []);
  });

  it("redacts an SSE error caught before forwarding and retains its rate-limit classification", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Response('event: error\ndata: {"message":"private fixture quota exhausted"}\n\n',
      { headers: { "content-type": "text/event-stream" } })));
    const rateLimit = vi.spyOn(getHealthStore(), "markRateLimited");
    expect((await send(true, "primary,primary-model")).statusCode).toBe(400);
    expect(finalRows()).toHaveLength(1);
    expect(finalRows()[0]).toMatchObject({ status: "error", errorMessage: "Chat stream returned an error", responseBody: undefined });
    expect(rateLimit.mock.calls).toEqual([["primary", "primary-model", 120, "Chat stream returned an error"]]);
  });

  it.each([false, true])("books an upstream 400 once without a health penalty (after failover=%s)", async afterFailover => {
    const invalidRequest = () => Response.json({ error: { message: "private invalid request" } }, { status: 400 });
    if (afterFailover) mockFallback(invalidRequest);
    else vi.stubGlobal("fetch", vi.fn(invalidRequest));
    const provider = afterFailover ? "backup" : "primary";
    const failure = vi.spyOn(getHealthStore(), "recordFailure");
    const rateLimit = vi.spyOn(getHealthStore(), "markRateLimited");
    const success = vi.spyOn(getHealthStore(), "recordSuccess");
    const response = await send(false);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toBe("private invalid request");
    expect(attemptFailure.mock.calls.map(([row]) => row.provider)).toEqual(afterFailover ? ["primary", "family"] : []);
    expect(finalRows()).toHaveLength(1);
    expect(finalRows()[0]).toMatchObject({ status: "error", provider, model: `${provider}-model`, originalModel: "ccr-opus",
      sessionId, errorMessage: "Chat upstream request failed (HTTP 400)", inputTokens: 0, outputTokens: 0, responseBody: undefined });
    expect(failure.mock.calls.map(([name]) => name)).toEqual(afterFailover ? ["primary", "family"] : []);
    expect(rateLimit).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
  });

  it("redacts SSE bodies in HTTP failover accounting and health", async () => {
    const secret = "private failover fixture";
    vi.stubGlobal("fetch", vi.fn(() => new Response(`event: error\ndata: ${secret}\n\n`,
      { status: 503, headers: { "content-type": "text/event-stream" } })));
    expect((await send(true)).statusCode).toBe(503);
    expect(attemptFailure.mock.calls.map(([row]) => row.provider)).toEqual(["primary", "family", "backup"]);
    for (const [row] of attemptFailure.mock.calls) expect(row.errorMessage).not.toContain(secret);
    expect(JSON.stringify(getHealthStore().getAllStates())).not.toContain(secret);
    expect(finalRows()).toEqual([]);
  });

  it("skips an unresolved provider before dispatch", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect((await send(false, "missing,unknown")).statusCode).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
    expect(attemptFailure).not.toHaveBeenCalled();
    expect(finalRows()).toEqual([]);
    expect(getHealthStore().getAllStates()).toEqual([]);
  });

  it("records incomplete nonstream choices as a failure even with reported usage", async () => {
    const message = { role: "assistant", content: "partial answer" };
    const choices = [{ index: 0, message, finish_reason: "stop" }, { index: 1, message, finish_reason: null }];
    vi.stubGlobal("fetch", vi.fn(() => Response.json({ choices, usage })));
    const success = vi.spyOn(getHealthStore(), "recordSuccess");
    const failure = vi.spyOn(getHealthStore(), "recordFailure");
    const response = await send(false, "primary,primary-model");
    expect(response.statusCode).toBe(200);
    expect(response.json().choices).toEqual(choices);
    expect(finalRows()).toHaveLength(1);
    expect(finalRows()[0]).toMatchObject({ status: "error", outputTokens: 0, errorMessage: "Chat completion ended without a finish_reason" });
    expect(success).not.toHaveBeenCalled();
    expect(failure).toHaveBeenCalledTimes(1);
  });

  it("keeps counters empty when a completed stream has no usage, even with a session baseline and router estimate", async () => {
    const previous = { input_tokens: 120, output_tokens: 10, cache_read_input_tokens: 80, cache_creation_input_tokens: 20 };
    sessionUsageCache.put(sessionKey, previous);
    vi.stubGlobal("fetch", vi.fn(() => sse(text, finish, "[DONE]")));
    expect((await send(true)).statusCode).toBe(200);
    expect(finalRows()[0]).toMatchObject({ status: "success", inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
    expect(sessionUsageCache.get(sessionKey)).toEqual(previous);
  });

  it("leaves each exhausted HTTP attempt with its own single failure and health penalty", async () => {
    mockFallback(() => Response.json({ error: { message: "backup unavailable" } }, { status: 503 }));
    const failure = vi.spyOn(getHealthStore(), "recordFailure");
    expect((await send(false)).statusCode).toBe(503);
    expect(attemptFailure.mock.calls.map(([row]) => row.provider)).toEqual(["primary", "family", "backup"]);
    expect(failure.mock.calls.map(([provider]) => provider)).toEqual(["primary", "family", "backup"]);
    expect(finalRows()).toEqual([]);
  });
});
