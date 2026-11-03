import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import Server from "../../../core/src/server";
import { CursorAuthService } from "../src/auth-service";
import { createCursorManagedRuntime } from "../src/managed-runtime";
import { CursorTransformer } from "../src/transformer";
import { _internal } from "../src/vendor/engine.mjs";

const dir = await mkdtemp(join(tmpdir(), "cursor-host-smoke-"));
const provider = { name: "cursor-subscription", api_base_url: "https://api2.cursor.sh", api_key: "ccr-managed-cursor", models: ["auto"], transformer: { use: ["cursor"] } };
const host = { configDir: dir, readRawConfig: async () => ({ providers: [provider] }), readConfig: async () => ({ providers: [provider] }), writeConfig: async () => {}, reloadRuntime: async () => {}, getDirectDispatcher: () => undefined };
const log = { info: () => {}, warn: () => {}, error: () => {} };
const server = new Server({ logger: false, useJsonFile: false, initialConfig: { providers: [provider], Router: { enableFallback: false } } });
try {
  await server.ready();
  // Import and activate the shipped bundle through the canonical host registry.
  const plugin = await import("../dist/plugin.js");
  assert.equal(plugin.manifest.version, "0.1.0");
  const tx = server.pluginRegistry.beginActivation(plugin.manifest, log, host);
  await plugin.activate(tx.context); await tx.commit(undefined, server.app);
  await server.registerNamespace("/");
  const offline = await server.app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model: "cursor-subscription,auto", stream: false, messages: [{ role: "user", content: "hello" }] } });
  assert.equal(offline.statusCode, 409);
  assert.match(offline.body, /cursor_not_connected/);
  console.log("Built cursor@0.1.0 activated in CCR; missing account fails closed with 409.");
} finally { await server.app.close(); }

// Use the actual core sendProviderAttempt and fetch, with an offline engine seam.
const connected = new Server({ logger: false, useJsonFile: false, initialConfig: { providers: [provider], Router: { enableFallback: false } } });
try {
  await writeFile(join(dir, "cursor-credentials.json"), JSON.stringify({ version: 1, credential: { type: "browser", access: "synthetic", refresh: "none", expires: Date.now() + 60_000 }, models: [] }));
  let engineCalls = 0;
  const service = new CursorAuthService({ host, engine: { ..._internal, answer: async () => {
    engineCalls++;
    return Response.json({ id: "fixture", object: "chat.completion", model: "auto", choices: [{ index: 0, message: { role: "assistant", content: "host bridge ok" }, finish_reason: "stop" }] });
  } } });
  await connected.ready();
  const tx = connected.pluginRegistry.beginActivation({ name: "cursor", version: "0.1.0", coreApi: "1" }, log, host);
  tx.context.registerManagedRuntime(createCursorManagedRuntime(service, host));
  tx.context.registerTransformer(CursorTransformer);
  await tx.commit(); await connected.registerNamespace("/");
  const response = await connected.app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model: "cursor-subscription,auto", stream: false, messages: [{ role: "user", content: "hello" }] } });
  assert.equal(response.statusCode, 200, response.body);
  assert.match(response.body, /host bridge ok/); assert.equal(engineCalls, 1);
  console.log("Actual CCR host attempt -> virtual fetch -> engine -> transformer returned 200 (one engine dispatch).");
  // Exercise the original undici handler API as well as Node's built-in fetch API.
  const requireCore = createRequire(new URL("../../../core/package.json", import.meta.url));
  const { fetch: undiciFetch } = requireCore("undici");
  const runtime = createCursorManagedRuntime(service, host), config: any = {};
  const result = await runtime.dispatchRequest!({ config, provider: {} as any, requestBody: {}, attempt: async () => {
    await runtime.lockUpstream!(config, {} as any);
    return undiciFetch(config.url, { dispatcher: config.dispatcher });
  } });
  assert.match(await result.text(), /host bridge ok/);
  console.log("Standalone undici dispatcher handler compatibility passed.");
} finally { await connected.app.close(); await rm(dir, { recursive: true, force: true }); }
