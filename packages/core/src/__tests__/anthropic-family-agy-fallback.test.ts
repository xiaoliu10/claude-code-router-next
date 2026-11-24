import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Server from "../server";
import { registerRequestPipeline } from "../ccr/request-pipeline";
import * as usageStore from "../ccr/usage-store";
import { getHealthStore } from "../services/provider-health";
import { resetFallbackPromotionStore } from "../utils/fallback-promotion";

// pi and other Anthropic clients address a family over /v1/messages, not Chat.
// The text-only Agy plugin must be skipped for their tool requests too, or its
// terminal 400 aborts the whole fallback chain (the live ccr-opus incident).
const agy = "gemini-agy-acp";
const model = "shared-model";
const anthropicTool = { name: "lookup", description: "look something up", input_schema: { type: "object" } };
const messages = [{ role: "user", content: "hello" }];
const providers = [agy, "relay", "primary", "backup"].map(name => ({
  name, models: [model], api_base_url: `https://${name}.invalid/v1/chat/completions`,
  api_key: name === agy ? `ccr-managed-${agy}` : "fixture-key",
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

async function anthropic(extra: object, requestedModel = "ccr-opus") {
  return server.app.inject({ method: "POST", url: "/v1/messages", payload: { model: requestedModel, max_tokens: 64, messages, ...extra } });
}

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "ccr-agy-anthropic-routing-"));
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
  ["named tools", { tools: [anthropicTool] }],
  ["tool_choice auto", { tools: [anthropicTool], tool_choice: { type: "auto" } }],
  ["tool_choice any", { tool_choice: { type: "any" } }],
  ["tool_choice named", { tool_choice: { type: "tool", name: "lookup" } }],
  ["tool_use history", { messages: [...messages, { role: "assistant", content: [{ type: "tool_use", id: "tu-1", name: "lookup", input: {} }] }] }],
  ["tool_result history", { messages: [...messages, { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-1", content: "result" }] }] }],
])("skips the Agy primary for Anthropic %s and keeps it for the next text request", async (_label, body) => {
  const attempts = await setup(agy, ["relay", "backup"]);
  const response = await anthropic(body);
  expect(response.statusCode, response.body).toBe(200);
  expect(attempts).toEqual(["backup"]);
  expect(run).not.toHaveBeenCalled();
  expect(getHealthStore().getState(agy, model)).toBeUndefined();
  expect(vi.mocked(usageStore.append).mock.calls.map(([row]) => [row.originalModel, row.provider])).toEqual([["ccr-opus", "backup"]]);
  expect((await anthropic({})).statusCode).toBe(200);
  expect(run).toHaveBeenCalledTimes(1);
});

it("routes through a fallback-only family and skips its text-only candidate for Anthropic tools", async () => {
  const attempts = await setup("", [agy, "backup"]);
  const response = await anthropic({ tools: [anthropicTool] });
  expect(response.statusCode, response.body).toBe(200);
  expect(attempts).toEqual(["backup"]);
  expect((await anthropic({})).statusCode).toBe(200);
});

it("skips Agy backups after a real primary failure on the Anthropic wire", async () => {
  const attempts = await setup("primary", ["relay", agy, "backup"]);
  const response = await anthropic({ tools: [anthropicTool] });
  expect(response.statusCode, response.body).toBe(200);
  expect(attempts).toEqual(["primary", "primary", "backup"]);
  expect(vi.mocked(usageStore.append).mock.calls.map(([row]) => row.provider)).toEqual(["backup"]);
  expect(getHealthStore().getState(agy, model)).toBeUndefined();
});

it("still serves a plain Anthropic text request through Agy", async () => {
  const attempts = await setup(agy, ["backup"]);
  const response = await anthropic({});
  expect(response.statusCode, response.body).toBe(200);
  expect(attempts).toEqual([]);
  expect(run).toHaveBeenCalledTimes(1);
});

it("serves an explicitly targeted Agy Anthropic tool request instead of skipping it", async () => {
  const attempts = await setup(agy, ["backup"]);
  const response = await anthropic({ tools: [anthropicTool] }, `${agy},${model}`);
  expect(response.statusCode, response.body).toBe(200);
  expect(attempts).toEqual([]);
  expect(run).toHaveBeenCalledTimes(1);
});
