import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import Server from "../../../core/src/server";
import { reloadProviderRuntime } from "../../../core/src/provider-plugins/host";
import * as configModule from "../../../core/src/ccr/config";
import * as activeProbe from "../../../core/src/services/active-probe";
import { activate, manifest } from "../src/plugin";
import { lockGrokProvider, GROK_UPSTREAM } from "../src/protocol";
import { fixture, completed, sse, TOKEN, ROTATED } from "./fixtures";
const log = { info() {}, warn() {}, error() {} };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.unstubAllEnvs(); });
async function server(connected = true) {
  const f = fixture(); cleanup.push(() => f.cleanup());
  for (const [key, value] of Object.entries(f.env)) vi.stubEnv(key, value);
  if (connected) await f.service.importCurrent();
  const config = { providers: [lockGrokProvider({ models: ["grok-fixture", "grok-fixture@500k"] })], Router: { default: "grok-subscription,grok-fixture", enableFallback: false }, ACTIVE_PROBE_ENABLED: false };
  vi.spyOn(configModule, "readConfigFileRaw").mockResolvedValue(config);
  vi.spyOn(configModule, "readConfigFile").mockResolvedValue(config);
  vi.spyOn(activeProbe, "startActiveProbe").mockReturnValue({ stop() {} } as any);
  const app = new Server({ logger: false, useJsonFile: false, initialConfig: config }); await app.ready();
  cleanup.push(() => app.app.close());
  (app as any).ccrPreHandlerCallbacks = { authClient: async () => {}, agent: async () => {} };
  const activation = app.pluginRegistry.beginActivation(manifest, log, f.host);
  await activate(activation.context); await activation.commit(Buffer.from("fixture card"), app.app);
  reloadProviderRuntime(app, config, log);
  // Production mount seam (ccr/admin-routes.ts:1271): plugin admin routes ride
  // the owning registry onto the server app.
  await app.pluginRegistry.registerAllRoutes(app.app);
  await app.registerNamespace("/"); await app.app.ready();
  return { f, app };
}
function responseEvents() {
  return [
    { type: "response.created", response: { id: "resp-fixture", model: "grok-fixture" } },
    { type: "response.output_text.delta", delta: "Hello fixture", output_index: 0 },
    { type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "fc1", call_id: "call_1", name: "read", arguments: "" } },
    { type: "response.function_call_arguments.delta", output_index: 1, item_id: "fc1", delta: '{"path":"/x"}' },
    { type: "response.output_item.done", output_index: 1, item: { type: "function_call", id: "fc1", call_id: "call_1", name: "read", arguments: '{"path":"/x"}' } },
    { ...completed, response: { ...completed.response, output: [...completed.response.output, { type: "function_call", id: "fc1", call_id: "call_1", name: "read", arguments: '{"path":"/x"}' }] } },
  ];
}
describe("actual current host routes + Grok plugin, no fallback", () => {
  it("unconnected plugin fails closed without upstream", async () => {
    const { app } = await server(false); const network = vi.fn(() => { throw new Error("must not fetch"); }); vi.stubGlobal("fetch", network);
    const response = await app.app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model: "grok-subscription,grok-fixture", messages: [{ role: "user", content: "hello" }] } });
    expect(response.statusCode).toBeGreaterThanOrEqual(400); expect(network).not.toHaveBeenCalled();
  });
  it("Chat and Anthropic SSE text/tool/usage retain current host conversion", async () => {
    const { app, f } = await server();
    const upstream = vi.fn(async (url: any, init: any) => {
      expect(String(url)).toBe(GROK_UPSTREAM); expect(init.redirect).toBe("error"); expect(init.dispatcher).toBe(f.subscription);
      expect(init.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
      const body = JSON.parse(init.body); expect(body.input).toBeDefined(); expect(body.model).toBe("grok-fixture");
      return sse(responseEvents());
    }); vi.stubGlobal("fetch", upstream);
    const chat = await app.app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model: "grok-subscription,grok-fixture", stream: true, messages: [{ role: "user", content: "hello" }] } });
    expect(chat.statusCode).toBe(200); expect(chat.body).toContain("chat.completion.chunk"); expect(chat.body).toContain("Hello fixture"); expect(chat.body).toContain("call_1"); expect(chat.body).toContain("read"); expect(chat.body).toContain("prompt_tokens");
    const anthropic = await app.app.inject({ method: "POST", url: "/v1/messages", payload: { model: "grok-subscription,grok-fixture", max_tokens: 100, stream: true, messages: [{ role: "user", content: "hello" }] } });
    expect(anthropic.statusCode).toBe(200); expect(anthropic.body).toContain("content_block_delta"); expect(anthropic.body).toContain("Hello fixture"); expect(anthropic.body).toContain("tool_use"); expect(anthropic.body).toContain("read"); expect(anthropic.body).toContain("output_tokens");
    expect(upstream).toHaveBeenCalledTimes(2);
  });
  it("401 refresh is owned once by core, context header survives retry; non-stream text/tools map", async () => {
    const { app, f } = await server();
    const upstream = vi.fn(async (_url: any, init: any) => {
      expect(init.headers.get("x-grok-context-window")).toBe("500000");
      if (upstream.mock.calls.length === 1) return new Response("denied", { status: 401 });
      expect(init.headers.get("authorization")).toBe(`Bearer ${ROTATED}`);
      return new Response(JSON.stringify({ ...completed.response, output: [...completed.response.output, { type: "function_call", id: "fc1", call_id: "call_1", name: "read", arguments: "{}" }] }), { headers: { "content-type": "application/json" } });
    }); vi.stubGlobal("fetch", upstream);
    const response = await app.app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model: "grok-subscription,grok-fixture@500k", stream: false, messages: [{ role: "user", content: "hello" }] } });
    expect(response.statusCode).toBe(200); expect(response.body).toContain("Hello fixture"); expect(response.body).toContain("read"); expect(upstream).toHaveBeenCalledTimes(2);
    expect(f.read("calls").trim().split("\n")).toHaveLength(1); expect(readFileSync(f.service.file, "utf8")).toContain(ROTATED);
  });
  it("a second 401 is terminal with exactly two sends and no fallback", async () => {
    const { app, f } = await server();
    const upstream = vi.fn(async () => new Response(JSON.stringify({ error: { message: TOKEN } }), { status: 401 })); vi.stubGlobal("fetch", upstream);
    const response = await app.app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model: "grok-subscription,grok-fixture", stream: false, messages: [{ role: "user", content: "hello" }] } });
    expect(response.statusCode).toBeGreaterThanOrEqual(400); expect(response.body).not.toContain(TOKEN);
    expect(upstream).toHaveBeenCalledTimes(2); expect(f.read("calls").trim().split("\n")).toHaveLength(1);
  });
  it("full host cross-endpoint: /v1/responses SSE tool roundtrip; output cap preserved; rate-limit stream cools account", async () => {
    const { app, f } = await server();
    const toolEvents = [
      { type: "response.created", response: { id: "resp-t", model: "grok-fixture" } },
      { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc9", call_id: "call_9", name: "read", arguments: "" } },
      { type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc9", delta: '{"path":' },
      { type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc9", delta: '"/x"}' },
      { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc9", call_id: "call_9", name: "read", arguments: '{"path":"/x"}' } },
      { ...completed, response: { ...completed.response, output: [{ type: "function_call", id: "fc9", call_id: "call_9", name: "read", arguments: '{"path":"/x"}' }] } },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => sse(toolEvents)));
    const native = await app.app.inject({ method: "POST", url: "/v1/responses", payload: { model: "grok-subscription,grok-fixture", stream: true, input: "read it" } });
    expect(native.statusCode).toBe(200); expect(native.body).toContain('"call_9"'); expect(native.body).toContain('"read"');
    // Pass-through must keep the SSE bytes verbatim, arguments JSON escaped in-band.
    expect(native.body).toContain('\\"path\\":\\"/x\\"');
    const cappedEvents = [
      { type: "response.created", response: { id: "resp-c", model: "grok-fixture" } },
      { type: "response.output_text.delta", delta: "capped", output_index: 0 },
      { type: "response.incomplete", response: { id: "resp-c", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, model: "grok-fixture", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "capped" }] }], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => sse(cappedEvents)));
    const capped = await app.app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model: "grok-subscription,grok-fixture", stream: true, messages: [{ role: "user", content: "hi" }] } });
    expect(capped.statusCode).toBe(200); expect(capped.body).toContain("capped"); expect(capped.body).toContain('"finish_reason":"length"');
    const limitedEvents = [{ type: "response.created", response: { id: "resp-l" } }, { type: "response.failed", response: { error: { code: "rate_limit_exceeded", message: "plan rate limit" } } }];
    vi.stubGlobal("fetch", vi.fn(async () => sse(limitedEvents)));
    const limited = await app.app.inject({ method: "POST", url: "/v1/messages", payload: { model: "grok-subscription,grok-fixture", max_tokens: 32, stream: true, messages: [{ role: "user", content: "hi" }] } });
    expect(limited.statusCode).toBeGreaterThanOrEqual(400);
    // The in-stream quota evidence must reach the ACTIVATED service (not the
    // seeding fixture instance) and park the account for the next request.
    const runtime = app.pluginRegistry.getRegisteredRuntimes().find(r => r.name === "grok");
    await expect(runtime?.ensureUsable()).rejects.toMatchObject({ code: "grok_rate_limited" });
    // Healing is validated-only: the failed stream above never clears the
    // cooldown; a validated service exchange (model sync, the card's own
    // refresh lane) does, and the next data-plane request then flows.
    // Healing must reach the ACTIVATED service, so drive its own admin lane
    // (exactly what the card's Refresh-models action does) with a valid list.
    // The activated service reads the GLOBAL fetch lane, unlike the fixture's.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "grok-fixture", context_window: 128000 }] }))));
    const synced = await app.app.inject({ method: "POST", url: "/api/grok/sync", headers: { host: "localhost:3456" } });
    expect(synced.statusCode, synced.body).toBe(200);
    await runtime?.ensureUsable();
    vi.stubGlobal("fetch", vi.fn(async () => sse([{ type: "response.created", response: { id: "resp-h" } }, completed])));
    const healed = await app.app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model: "grok-subscription,grok-fixture", stream: true, messages: [{ role: "user", content: "hello" }] } });
    expect(healed.statusCode, `HEALED-BODY: ${healed.body}`).toBe(200);
  });
  it("native Responses retains complete hosted tools metadata; terminal/truncated stream cannot pass", async () => {
    const { app } = await server();
    const final = { ...completed, response: { ...completed.response, tools: [{ type: "x_search" }], server_side_tool_usage_details: { x_search: 1 }, output: [...completed.response.output, { type: "custom_tool_call", name: "x_search", output: "fixture" }] } };
    vi.stubGlobal("fetch", vi.fn(async () => sse([{ type: "response.created", response: { id: "r" } }, final])));
    const response = await app.app.inject({ method: "POST", url: "/v1/responses", payload: { model: "grok-subscription,grok-fixture", stream: true, input: "hello" } });
    expect(response.statusCode).toBe(200); expect(response.body).toContain("custom_tool_call"); expect(response.body).toContain("server_side_tool_usage_details");
    vi.stubGlobal("fetch", vi.fn(async () => sse([])));
    const failed = await app.app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model: "grok-subscription,grok-fixture", stream: true, messages: [{ role: "user", content: "hello" }] } });
    expect(failed.statusCode).toBeGreaterThanOrEqual(400);
  });
});
