import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Server from "../server";
import { registerRequestPipeline } from "../ccr/request-pipeline";
import * as usageStore from "../ccr/usage-store";
import { getHealthStore } from "../services/provider-health";
import { resetFallbackPromotionStore } from "../utils/fallback-promotion";

const agy = "gemini-agy-acp";
const model = "shared-model";
const tool = { type: "function", function: { name: "lookup" } };
const toolCall = { ...tool, id: "call-1", function: { name: "lookup", arguments: "{}" } };
const messages = [{ role: "user", content: "hello" }];
const providers = [agy, "relay", "primary", "backup"].map(name => ({
  name, models: [model], api_base_url: `https://${name}.invalid/v1/chat/completions`,
  api_key: name === agy ? `ccr-managed-${agy}` : "fixture-key",
  // One route is owned by the runtime alone, another uses only the transformer.
  ...(name === "relay" && { transformer: { [model]: { use: [agy] } } }),
}));
let server: Server;
let configDir: string;
const attemptFailure = vi.fn();
const run = vi.fn(async ({ onText }) => { onText("local answer"); return { stopReason: "end_turn" }; });

async function setup(primary: string, fallbacks: string[], failureStatus = 503) {
  const config = { providers, Router: { enableFamilyRouting: true, enableFallback: true,
    families: { opus: { default: primary ? `${primary},${model}` : "", fallback: { default: fallbacks.map(name => `${name},${model}`) } } } } };
  server = new Server({ logger: false, useJsonFile: false, initialConfig: config });
  await server.ready();
  await writeFile(join(configDir, `${agy}.json`), JSON.stringify({ enabled: true, binary: process.execPath, authMethod: "gemini-api-key" }));
  const activation = server.pluginRegistry.beginActivation({ name: agy, coreApi: "1", version: "1" }, server.app.log, {
    configDir, readConfig: vi.fn(), writeConfig: vi.fn(), reloadRuntime: vi.fn(), getDirectDispatcher: vi.fn(),
  });
  const plugin = await import(join(__dirname, "../../../plugins/gemini-agy-acp/src/plugin.mjs"));
  await plugin.activateWithTransport(activation.context, () => ({ run }));
  // The plugin registers admin routes, so commit needs a host app for them.
  await activation.commit(undefined, server.app);
  server.reloadProviders(config);
  server.recordUsage = attemptFailure;
  registerRequestPipeline(server, config);
  await server.registerNamespace("/");
  const attempts: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: URL) => {
    const provider = new URL(url).hostname.split(".")[0];
    attempts.push(provider);
    if (provider !== "backup") return Response.json({ error: { message: "fixture error" } }, { status: failureStatus });
    return Response.json({ model, choices: [{ message: { role: "assistant", content: "answer" }, finish_reason: "stop" }] });
  }));
  return attempts;
}

async function chat(extra: object, requestedModel = "ccr-opus") {
  return server.app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model: requestedModel, messages, ...extra } });
}

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "ccr-agy-tool-routing-"));
  getHealthStore().clear();
  resetFallbackPromotionStore();
  vi.clearAllMocks();
  vi.spyOn(usageStore, "append").mockImplementation(() => {});
});
afterEach(async () => {
  await server?.app.close();
  await rm(configDir, { recursive: true, force: true });
  getHealthStore().clear();
  resetFallbackPromotionStore();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  ["tools", { tools: [tool] }],
  ["legacy functions", { functions: [tool.function], function_call: "auto" }],
  ["legacy named function", { function_call: { name: "lookup" } }],
  ["tool choice", { tool_choice: "auto" }],
  ["assistant tool call", { messages: [...messages, { role: "assistant", tool_calls: [toolCall] }] }],
  ["tool result", { messages: [{ role: "tool", tool_call_id: "call-1", content: "result" }] }],
])("skips the Agy primary for %s and keeps it available for the next text request", async (_label, body) => {
  const attempts = await setup(agy, ["relay", "backup"]);
  const response = await chat(body);
  expect(response.statusCode, response.body).toBe(200);
  expect(attempts).toEqual(["backup"]);
  expect(attemptFailure).not.toHaveBeenCalled();
  expect(vi.mocked(usageStore.append).mock.calls.map(([row]) => [row.originalModel, row.provider])).toEqual([["ccr-opus", "backup"]]);
  expect(getHealthStore().getState(agy, model)).toBeUndefined();
  expect(getHealthStore().getState("relay", model)).toBeUndefined();
  expect(run).not.toHaveBeenCalled();
  expect((await chat({ tools: [] })).json().choices[0].message.content).toBe("local answer");
  expect(run).toHaveBeenCalledTimes(1);
});

it("routes through a fallback-only family and skips its text-only candidate for tools", async () => {
  const attempts = await setup("", [agy, "backup"]);
  const response = await chat({ tools: [tool] });
  expect(response.statusCode, response.body).toBe(200);
  expect(attempts).toEqual(["backup"]);
  expect((await chat({})).json().choices[0].message.content).toBe("local answer");
});

it("skips Agy backups after a real primary failure and books only the attempted providers", async () => {
  const attempts = await setup("primary", ["relay", agy, "backup"]);
  const response = await chat({ tools: [tool], tool_choice: tool });
  expect(response.statusCode, response.body).toBe(200);
  expect(attempts).toEqual(["primary", "primary", "backup"]);
  expect(attemptFailure.mock.calls.map(([row]) => row.provider)).toEqual(["primary"]);
  expect(vi.mocked(usageStore.append).mock.calls.map(([row]) => row.provider)).toEqual(["backup"]);
  expect(getHealthStore().getState(agy, model)).toBeUndefined();
  expect(getHealthStore().getState("relay", model)).toBeUndefined();
});

it("preserves a terminal 400 from the next capable provider", async () => {
  const attempts = await setup(agy, ["primary", "backup"], 400);
  const response = await chat({ tools: [tool] });
  expect(response.statusCode).toBe(400);
  expect(response.json().error.message).toBe("fixture error");
  expect(attempts).toEqual(["primary"]);
  expect(attemptFailure).not.toHaveBeenCalled();
  expect(vi.mocked(usageStore.append).mock.calls.map(([row]) => row.provider)).toEqual(["primary"]);
});

// A tool request that Agy can actually serve is no longer a 400: the plugin
// bridges it to the agent. These cases stay rejections because they are not
// servable tool requests — no usable tool, a choice the bridge cannot honour,
// or an empty tool history that declares nothing.
it.each([
  ["malformed tools", "ccr-opus", { tools: [{ type: "function" }] }],
  ["invalid legacy choice", "ccr-opus", { functions: [tool.function], function_call: "invalid" }],
  ["invalid choice", "ccr-opus", { tools: [tool], tool_choice: "invalid" }],
  ["empty tool history", "ccr-opus", { messages: [{ role: "assistant", content: "hello", tool_calls: [] }] }],
] as const)("preserves the Agy 400 for %s", async (_label, target, body) => {
  const attempts = await setup(agy, ["backup"]);
  const response = await chat(body, target);
  expect(response.statusCode).toBe(400);
  expect(response.json().error.code).toBe("agy_unsupported_request");
  expect(attempts).toEqual([]);
  expect(run).not.toHaveBeenCalled();
});

// An explicitly targeted Agy request with a usable tool is served by Agy's tool
// path rather than rejected: the agent discovers the tool over the local MCP
// bridge and the caller executes it.
it("serves an explicitly targeted Agy tool request instead of rejecting it", async () => {
  const attempts = await setup(agy, ["backup"]);
  const response = await chat({ tools: [tool] }, `${agy},${model}`);
  expect(response.statusCode, response.body).toBe(200);
  expect(attempts).toEqual([]);
  expect(run).toHaveBeenCalledTimes(1);
});
