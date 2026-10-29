/** Real composition-root gate. Physical Codex account UNTESTED: fixture tokens/fetch only. */
import { afterEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME_DIR } from "../../../shared/dist/index.js";
import { installPluginFromArchive } from "../../../shared/src/plugin-install";
import { createCcrServer } from "../../../core/src/ccr/create-server";
import * as configModule from "../../../core/src/ccr/config";
import * as activeProbe from "../../../core/src/services/active-probe";
import { getHealthStore } from "../../../core/src/services/provider-health";

const pkg = join(__dirname, "..");
const marker = "ccr-managed-codex";
const provider = { name: "codex-subscription", api_base_url: "https://chatgpt.com/backend-api/codex", api_key: marker,
  models: ["fixture-model"], transformer: { use: ["openai-responses", "codex"] } };
const jwt = (claims: any) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fixture`;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); activeProbe.resetActiveProbeService(); getHealthStore().clear();
  rmSync(join(HOME_DIR, "plugins"), { recursive: true, force: true }); });

it("real createCcrServer: tarball activation, admin auth/guards, both endpoint text/tool/error streams, marker secrecy and missing/disabled fail-closed", async () => {
  // HOME_DIR is captured at module import from the vitest sandbox, never the real profile.
  expect(HOME_DIR).toContain("ccr-codex-plugin-test-home");
  mkdirSync(HOME_DIR, { recursive: true });
  execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", HOME_DIR], { cwd: pkg, stdio: "pipe" });
  const { version } = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
  const archive = join(HOME_DIR, `wengine-ai-ccr-provider-codex-${version}.tgz`);
  await installPluginFromArchive(archive, { configDir: HOME_DIR });
  const config = { Providers: [provider], Router: { default: "codex-subscription,fixture-model", enableFallback: false },
    APIKEY: "fixture-admin-secret", HOST: "127.0.0.1", PORT: 0, LOG: false, ACTIVE_PROBE_ENABLED: false,
    CCR_SELF_PROVIDER_DELETED: true, plugins: [] };
  writeFileSync(join(HOME_DIR, "config.json"), JSON.stringify(config));
  vi.spyOn(configModule, "initConfig").mockResolvedValue(config);
  vi.spyOn(configModule, "writeConfigFile").mockImplementation(async next => {
    writeFileSync(join(HOME_DIR, "config.json"), JSON.stringify(next));
  });
  vi.spyOn(activeProbe, "startActiveProbe").mockReturnValue({ stop() {} } as any);
  const tokens = { accessToken: jwt({ exp: Math.floor(Date.now()/1000)+7200 }), refreshToken: "fixture-refresh", idToken: jwt({}) };
  writeFileSync(join(HOME_DIR, "codex-credentials.json"), JSON.stringify({ version: 1, kind: "codex-subscription",
    account: { ...tokens, accountId: "fixture-account", email: "fixture@example.invalid", plan: "fixture",
      connectedAt: new Date().toISOString(), accessExp: Date.now()+7200000, lastError: null, cooldownUntil: null, rateLimitCooldownUntil: null },
    models: [], rateLimits: null }), { mode: 0o600 });
  const calls: any[] = [];
  let mode = "text";
  const sse = (events: any[]) => new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } });
  vi.stubGlobal("fetch", vi.fn(async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    expect(String(url)).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(JSON.stringify(init.headers)).not.toContain(marker);
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${tokens.accessToken}`);
    expect(new Headers(init.headers).get("x-api-key")).toBeNull();
    expect(init.redirect).toBe("error");
    if (mode === "error") return sse([{ type: "error", error: { type: "server_error", message: "fixture private upstream detail" } }]);
    if (mode === "failed") return sse([{ type: "response.failed", response: {} }]);
    const item = mode === "tool"
      ? { type: "function_call", id: "fc_1", call_id: "call_1", name: "weather", arguments: "{}" }
      : { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "fixture healthy" }] };
    return sse([{ type: "response.created", response: { id: "r1" } },
      { type: "response.output_item.added", output_index: 0, item },
      ...(mode === "text" ? [{ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "fixture healthy" }] : []),
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: "r1", status: "completed", output: [item] } }]);
  }));
  for (const state of ["enabled", "disabled", "missing"]) {
    getHealthStore().clear();
    if (state === "disabled") writeFileSync(join(HOME_DIR, "plugins", "plugins.json"), JSON.stringify([{ name: "codex", enabled: false }]));
    if (state === "missing") rmSync(join(HOME_DIR, "plugins", "codex"), { recursive: true, force: true });
    const server = await createCcrServer({ port: 0, logger: false });
    try {
      await server.registerNamespace("/");
      await server.app.listen({ port: 0, host: "127.0.0.1" });
      const port = (server.app.server.address() as any).port;
      const authority = `127.0.0.1:${port}`;
      if (state === "enabled") {
        expect(server.pluginRegistry.listLoadedPlugins().map(p => p.name)).toEqual(["codex"]);
        const admin = (headers = {}, remoteAddress = "127.0.0.1") => server.app.inject({ method: "GET", url: "/api/codex/status",
          headers: { host: authority, ...headers }, remoteAddress });
        expect((await admin()).json().status).toBe("connected");
        // Real global API-key middleware covers plugin routes; local admin additionally enforces its guard.
        expect((await admin({}, "198.51.100.7")).statusCode).toBe(401);
        expect((await admin({ authorization: "Bearer fixture-admin-secret" }, "198.51.100.7")).statusCode).toBe(403);
        expect((await admin({ origin: "https://hostile.invalid" })).statusCode).toBe(403);
        expect((await admin({ host: "hostile.invalid" })).statusCode).toBe(403);
        const malformed = await server.app.inject({ method: "POST", url: "/api/codex/login/poll", headers: { host: authority }, payload: { loginId: "bad" } });
        expect(malformed.statusCode).toBe(422);
      } else expect(server.pluginRegistry.listLoadedPlugins()).toEqual([]);
      for (const endpoint of ["/v1/responses", "/v1/messages"]) {
        for (const scenario of state === "enabled" ? ["text", "tool", "error", "failed"] : ["text"]) {
          mode = scenario;
          getHealthStore().clear();
          const before = calls.length;
          const tool = { name: "weather", description: "fixture", input_schema: { type: "object" } };
          const payload = endpoint === "/v1/messages"
            ? { model: "codex-subscription,fixture-model", max_tokens: 32, stream: true, messages: [{ role: "user", content: "hello" }], ...(scenario === "tool" ? { tools: [tool] } : {}) }
            : { model: "codex-subscription,fixture-model", stream: true, input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }], ...(scenario === "tool" ? { tools: [{ type: "function", name: "weather", parameters: { type: "object" } }] } : {}) };
          const result = await server.app.inject({ method: "POST", url: endpoint, headers: { "user-agent": "codex_cli_rs/fixture",
            authorization: "Bearer spoof-client", "x-api-key": "spoof-client", host: authority }, payload });
          if (state !== "enabled") {
            expect(result.statusCode, result.body).toBe(503);
            expect(result.body).toContain("plugin_missing");
            expect(calls.length).toBe(before);
          } else if (scenario === "error" || scenario === "failed") {
            expect(result.statusCode, result.body).toBe(502);
            expect(result.body).toContain("codex_overloaded");
            expect(result.body).not.toContain("fixture private upstream detail");
          } else {
            expect(result.statusCode, result.body).toBe(200);
            if (endpoint === "/v1/messages") {
              // Known CORE double-conversion defect; not a successful semantic turn.
              expect(result.headers["x-codex-on-messages"]).toBe("true");
              expect(result.body).toContain('"output":[]');
            } else expect(result.body).toContain(scenario === "tool" ? "weather" : "fixture healthy");
            const body = JSON.parse(calls.at(-1).init.body);
            expect(body.store).toBe(false); expect(body.stream).toBe(true);
            if (scenario === "tool") expect(body.tools[0].name).toBe("weather");
          }
        }
      }
      expect(JSON.stringify(config.Router)).toBe(JSON.stringify({ default: "codex-subscription,fixture-model", enableFallback: false }));
    } finally { await server.app.close(); }
  }
}, 60_000);
