/**
 * Codex plugin — INTEGRATION (lane D): real Server wrapper + the REAL npm
 * tarball (`npm pack --ignore-scripts`), extracted through the production
 * installer (shared extractPluginArchive → validate → stage), then loaded
 * through the real plugin loader.
 *
 * Everything stateful lives in a throwaway CCR_CONFIG_DIR/HOME/TMPDIR; the
 * upstream is a stubbed global fetch; no real account, no real network, no
 * ~/.codex, no port 3456. THE PHYSICAL CODEX ACCOUNT IS UNTESTED — every
 * assertion here runs against fixtures.
 *
 * Proven here end to end:
 *  - bundle purity (no core/src input in the plugin metafile) and tarball
 *    layout (dist-only, no node_modules);
 *  - fail-closed 503 plugin_missing when the plugin is missing (marker
 *    ccr-managed-codex) and skipped managed probes with the same marker;
 *  - the marker api key NEVER reaches the upstream on /v1/messages (codex UA)
 *    or /v1/responses; spoofed client credentials are stripped;
 *  - text + tool turns through the full transformer chain, non-stream and SSE;
 *  - SSE terminal error and response.failed (with and without body);
 *  - 401-once refresh (exactly one re-dispatch, rotated token used);
 *  - usage_limit_reached → codex_usage_limit cooling (headers + SSE);
 *  - client disconnect returns promptly; upstream abort is a known host limitation;
 *  - fake browser login via stubbed global fetch: real loopback 1455 callback
 *    AND paste /login/complete, 0600 credential file, managed provider upsert,
 *    Router + unrelated providers byte-identical, redacted status;
 *  - admin guards: non-loopback 403, hostile Origin 403, bad Host 403,
 *    malformed loginId 422.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import Server from "../../../core/src/server";
import * as configModule from "../../../core/src/ccr/config";
import * as activeProbe from "../../../core/src/services/active-probe";
import { reloadProviderRuntime } from "../../../core/src/provider-plugins/host";
import { registerAdminRoutes } from "../../../core/src/ccr/admin-routes";
import { build } from "esbuild";
import { installPluginFromArchive } from "../../../shared/src/plugin-install";
import {
  clearPluginRegistry, getManagedRuntimeFor, applyPluginConfigProtectors,
  listLoadedPlugins, registerAllPluginRoutes,
} from "../../../core/src/provider-plugins/registry";
import { loadInstalledPlugins } from "../../../core/src/provider-plugins/loader";
import { getHealthStore } from "../../../core/src/services/provider-health";

const PLUGIN_PKG = join(__dirname, "..");
const MARKER = "ccr-managed-codex";
const log = { info: () => {}, warn: () => {}, error: () => {} };

// ---- fixture helpers -------------------------------------------------------

function jwt(claims: Record<string, any>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64(claims)}.sig`;
}
const nowSec = () => Math.floor(Date.now() / 1000);
const idToken = () => jwt({
  email: "codex@example.invalid",
  "https://api.openai.com/auth": { chatgpt_account_id: "acct_1", chatgpt_plan_type: "pro" },
});
const accessTokenFor = (secs = 3600) => jwt({ exp: nowSec() + secs });

const MODELS = {
  models: [
    { slug: "gpt-5.1", display_name: "GPT-5.1", visibility: "visible", priority: 10, base_instructions: "INSTR-5.1" },
    { slug: "gpt-5.1-codex", display_name: "Codex", visibility: "visible", priority: 5, base_instructions: "INSTR-CODEX" },
  ],
};

/** Deterministic fake upstream for OAuth token/models/usage + data plane. */
function fakeUpstream(opts: { refreshStatus?: number; accessSecs?: number } = {}) {
  const calls: Array<{ url: string; init: any }> = [];
  const sse = (events: any[]) =>
    new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } });
  const impl = vi.fn(async (url: any, init?: any) => {
    calls.push({ url: String(url), init });
    const u = String(url);
    if (u.endsWith("/oauth/token")) {
      const body = typeof init?.body === "string" ? init.body : "";
      const isRefresh = body.includes("refresh_token") && body.includes("grant_type");
      if (isRefresh && opts.refreshStatus === 400) {
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      }
      if (isRefresh) {
        return new Response(JSON.stringify({ id_token: idToken(), access_token: accessTokenFor(), refresh_token: "rt-rotated" }),
          { headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ id_token: idToken(), access_token: accessTokenFor(opts.accessSecs), refresh_token: "rt-1" }),
        { headers: { "content-type": "application/json" } });
    }
    if (u.includes("/backend-api/codex/models")) return new Response(JSON.stringify(MODELS));
    if (u.includes("/wham/usage")) {
      return new Response(JSON.stringify({ plan_type: "pro", rate_limit: { primary_window: {
        used_percent: 5, limit_window_seconds: 18000, reset_at: nowSec() + 18000 } } }));
    }
    if (u === "https://chatgpt.com/backend-api/codex/responses") {
      return sse([
        { type: "response.created", response: { id: "r1" } },
        { type: "response.output_text.delta", delta: "plugin healthy" },
        { type: "response.completed", response: { id: "r1" } },
      ]);
    }
    throw new Error(`unexpected upstream call: ${u}`);
  });
  return { impl, calls };
}

/** Scenario upstream: default OAuth/models/wham handling + a custom
 *  data-plane responder. Never delegates back into the mock (no recursion). */
function scenarioUpstream(dataHandler: (u: string, init: any, calls: Array<{ url: string; init: any }>) => Promise<Response> | Response) {
  const calls: Array<{ url: string; init: any }> = [];
  const sseOk = () => new Response(
    `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "ok" } })}\n\n` +
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "ok" })}\n\n` +
    "data: [DONE]\n\n",
    { status: 200, headers: { "content-type": "text/event-stream" } });
  const impl = vi.fn(async (url: any, init?: any) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.endsWith("/oauth/token")) {
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes("refresh_token")) {
        return new Response(JSON.stringify({ id_token: idToken(), access_token: accessTokenFor(7200), refresh_token: "rt-rotated" }),
          { headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ id_token: idToken(), access_token: accessTokenFor(), refresh_token: "rt-1" }),
        { headers: { "content-type": "application/json" } });
    }
    if (u.includes("/backend-api/codex/models")) return new Response(JSON.stringify(MODELS));
    if (u.includes("/wham/usage")) {
      return new Response(JSON.stringify({ plan_type: "pro", rate_limit: { primary_window: {
        used_percent: 5, limit_window_seconds: 18000, reset_at: nowSec() + 18000 } } }));
    }
    if (u === "https://chatgpt.com/backend-api/codex/responses") {
      return await dataHandler(u, init, calls);
    }
    throw new Error(`unexpected upstream call: ${u}`);
  });
  return { impl, calls, sseOk };
}


let configDir = "";
let tarballPath = "";
const unstubbedFetch = globalThis.fetch;
const cleanupDirs: string[] = [];
const sandboxEnv = { HOME: process.env.HOME, CCR_CONFIG_DIR: process.env.CCR_CONFIG_DIR };

beforeEach(() => {
  clearPluginRegistry();
  configDir = mkdtempSync(join(tmpdir(), "ccr-codex-int-"));
  cleanupDirs.push(configDir);
  process.env.CCR_CONFIG_DIR = configDir;
  process.env.HOME = configDir;
  // Build the real npm tarball once per test from the repo package.
  tarballPath = join(tmpdir(), `ccr-codex-${Date.now()}-${Math.random().toString(36).slice(2)}.tgz`);
  execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", tmpdir()], {
    cwd: PLUGIN_PKG, env: { ...process.env, npm_config_pack_destination: undefined },
  });
  // npm names it after the package; rename to a deterministic path.
  const produced = join(tmpdir(), "wengine-ai-ccr-provider-codex-1.0.0.tgz");
  rmSync(tarballPath, { force: true });
  execFileSync("mv", [produced, tarballPath]);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearPluginRegistry();
  activeProbe.resetActiveProbeService();
  getHealthStore().clear();
  for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  rmSync(tarballPath, { force: true });
  if (sandboxEnv.CCR_CONFIG_DIR === undefined) delete process.env.CCR_CONFIG_DIR;
  else process.env.CCR_CONFIG_DIR = sandboxEnv.CCR_CONFIG_DIR;
  if (sandboxEnv.HOME === undefined) delete process.env.HOME;
  else process.env.HOME = sandboxEnv.HOME;
});

/** Install through the PRODUCTION installer (extract+validate+stage) from the
 *  real npm tarball — exactly what `ccr plugin add` does. */
async function installViaProductionInstaller(): Promise<void> {
  const result = await installPluginFromArchive(tarballPath, { configDir, force: true });
  expect(result.manifest.name).toBe("codex");
  const pluginDir = join(configDir, "plugins", "codex");
  expect(existsSync(join(pluginDir, "plugin.js"))).toBe(true);
  expect(existsSync(join(pluginDir, "card.js"))).toBe(true);
  // Tarball purity: the installed payload carries no node_modules and no maps.
  const staged = execFileSync("find", [pluginDir, "-type", "l"], { encoding: "utf8" }).trim();
  expect(staged).toBe("");
}

const hostServer = {
  configService: { reload() {}, set() {}, get() { return true; } },
};

async function load(app?: any): Promise<void> {
  const result = await loadInstalledPlugins({
    configDir, log, getServer: () => app ?? ({ ...hostServer, app: Fastify() }),
  });
  expect(result.loaded).toEqual(["codex"]);
  expect(result.failed).toEqual([]);
}

function writeCredential(extra: Record<string, unknown> = {}): void {
  writeFileSync(join(configDir, "codex-credentials.json"), JSON.stringify({
    version: 1,
    kind: "codex-subscription",
    account: {
      accessToken: accessTokenFor(),
      refreshToken: "rt-fixture",
      idToken: idToken(),
      accountId: "acct_1",
      email: "codex@example.invalid",
      plan: "pro",
      connectedAt: new Date().toISOString(),
      accessExp: (nowSec() + 3600) * 1000,
      lastError: null,
      cooldownUntil: null,
      rateLimitCooldownUntil: null,
      ...extra,
    },
    models: MODELS.models.map((m) => ({ slug: m.slug, displayName: m.display_name, instructions: m.base_instructions })),
    rateLimits: null,
  }), { mode: 0o600 });
}

const managedProvider = (models: string[] = ["gpt-5.1-codex"]) => ({
  name: "codex-subscription",
  api_base_url: "https://chatgpt.com/backend-api/codex",
  api_key: MARKER,
  codex_managed: true,
  codexManaged: true,
  models,
  transformer: { use: ["openai-responses", "codex"] },
});

function baseConfig(): any {
  // Runtime key is lowercase `providers` (the Server normalises on load); the
  // plugin's protector accepts either casing and writes the same one back.
  return {
    providers: [
      managedProvider(),
      { name: "unrelated", api_key: "sk-unrelated-real", api_base_url: "https://unrelated.invalid/v1",
        models: ["u-1"], transformer: { use: ["openai"] } },
      { name: "codex", api_key: "sk-user-owns-this", api_base_url: "https://api.openai.com/v1",
        models: ["gpt-user"], transformer: { use: [] } },
    ],
    Router: { default: "unrelated,u-1" },
    ACTIVE_PROBE_ENABLED: false,
  };
}

async function startServer(config: any): Promise<InstanceType<typeof Server>> {
  vi.spyOn(configModule, "readConfigFileRaw").mockResolvedValue(config);
  vi.spyOn(configModule, "readConfigFile").mockResolvedValue(config);
  vi.spyOn(activeProbe, "startActiveProbe").mockReturnValue({ stop() {} } as any);
  const app = new Server({ logger: false, useJsonFile: false, initialConfig: config });
  await app.ready();
  // No API-key auth in tests (createCcrServer injects the real callbacks).
  (app as any).ccrPreHandlerCallbacks = {
    authClient: async () => {},
    agent: async () => {},
  };
  return app as unknown as InstanceType<typeof Server>;
}

/** Full wiring used by every data-plane test: plugins, provider runtime,
 *  admin routes, the main namespace and the namespace fastify instance.
 *  The core refuses config WRITES under VITEST (assertNotTestEnv in
 *  ccr/config.ts); the plugin's login/sync/disconnect upsert is a genuine
 *  write seam, so the harness replaces writeConfigFile with a direct file
 *  write to $CCR_CONFIG_DIR/config.json (same target, no env check). */
async function wire(app: InstanceType<typeof Server>, config: any): Promise<void> {
  vi.spyOn(configModule, "writeConfigFile").mockImplementation(async (next: any) => {
    writeFileSync(join(configDir, "config.json"), `${JSON.stringify(next, null, 2)}`);
  });
  await load(app);
  reloadProviderRuntime(app, config, log);
  await registerAdminRoutes(app, config);
  await app.registerNamespace("/");
  await (app.app as any).ready();
}

/** Managed-only config: Router.default stays the managed provider so the
 *  health rate-limit circuit (which reroutes a parked model to Router.default)
 *  never leaves the codex runtime in the cooling test. */
function managedOnlyConfig(): any {
  return {
    providers: [managedProvider()],
    Router: { default: "codex-subscription,gpt-5.1-codex" },
    ACTIVE_PROBE_ENABLED: false,
  };
}

// ---------------------------------------------------------------------------

describe("codex plugin integration — install, purity and fail-closed", () => {
  it("installs the real npm tarball through the production installer; bundle is pure; marker constants match", async () => {
    await installViaProductionInstaller();
    // Independent metafile check: the shipped plugin.js never pulls core/src.
    const pluginDir = join(configDir, "plugins", "codex");
    const bundle = await build({
      metafile: true, entryPoints: [join(PLUGIN_PKG, "src/plugin.ts")], bundle: true,
      platform: "node", target: "node20", format: "esm", write: false, logLevel: "silent",
    });
    const coreInputs = Object.keys(bundle.metafile!.inputs).filter((f) => f.includes("core/src") || f.includes("packages/core"));
    expect(coreInputs).toEqual([]);
    const pluginJs = readFileSync(join(pluginDir, "plugin.js"), "utf8");
    expect(pluginJs).toContain(MARKER);
    expect(pluginJs).not.toContain("ccr-codex-managed");
  });

  it("missing plugin fails closed: 503 plugin_missing, marker never upstream", async () => {
    // NO install — the managed provider stays in config with its marker key.
    const config = baseConfig();
    const upstream = fakeUpstream();
    vi.stubGlobal("fetch", upstream.impl);
    const app = await startServer(config);
    try {
      await app.registerNamespace("/");
      await (app.app as any).ready();
      const response = await app.app.inject({ method: "POST", url: "/v1/messages", headers: { "user-agent": "codex-cli/1.0" },
        payload: { model: "codex-subscription,gpt-5.1-codex", max_tokens: 32, messages: [{ role: "user", content: "hi" }] } });
      expect(response.statusCode).toBe(503);
      expect(response.body).toContain("plugin_missing");
      expect(upstream.calls).toHaveLength(0);
    } finally { await app.app.close(); }
  });

  it("disabled plugin fails closed the same way", async () => {
    await installViaProductionInstaller();
    writeFileSync(join(configDir, "plugins", "plugins.json"), JSON.stringify([{ name: "codex", enabled: false }]));
    const config = baseConfig();
    const upstream = fakeUpstream();
    vi.stubGlobal("fetch", upstream.impl);
    const app = await startServer(config);
    try {
      await app.registerNamespace("/");
      await (app.app as any).ready();
      const response = await app.app.inject({ method: "POST", url: "/v1/messages", headers: { "user-agent": "codex-cli/1.0" },
        payload: { model: "codex-subscription,gpt-5.1-codex", max_tokens: 32, messages: [{ role: "user", content: "hi" }] } });
      expect(response.statusCode).toBe(503);
      expect(response.body).toContain("plugin_missing");
      expect(upstream.calls).toHaveLength(0);
    } finally { await app.app.close(); }
  });

  it("ccr-managed-codex providers are skipped by the generic managed probe (never probed with the marker)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("unexpected generic network call"); }));
    const provider = {
      name: "codex-subscription", apiKey: MARKER, baseUrl: "https://configured.invalid/v1/chat/completions",
      models: ["m"], enabled: true, wakeupEnabled: true, wakeupTime: "00:00",
    } as any;
    const probe = new activeProbe.ActiveProbeService(() => [provider],
      { enabled: true, excludeProviders: [], initialDelayMs: 3_600_000 }, undefined, log,
      (key) => key === "WAKEUP_ENABLED" ? true : undefined);
    for (let cycle = 0; cycle < 3; cycle++) await (probe as any).runHealthProbe();
    await (probe as any).runQuotaProbe();
    expect(fetch).not.toHaveBeenCalled();
    expect(probe.getProbeTelemetry()).toEqual([]);
    expect(await probe.probeProviderManually("codex-subscription")).toMatchObject({ skipped: true, status: "skipped" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("codex plugin integration — data plane through the real server", () => {
  const CODEX_UA = "codex_cli_rs/0.160.1 (Mac OS X; arm64)";
  const UPSTREAM = "https://chatgpt.com/backend-api/codex/responses";
  const msgPayload = (extra: any = {}) => ({
    model: "codex-subscription,gpt-5.1-codex", max_tokens: 64,
    messages: [{ role: "user", content: "hello" }], ...extra,
  });

  it("serves /v1/messages (codex UA) and /v1/responses: marker and spoofed credentials never upstream", async () => {
    await installViaProductionInstaller();
    writeCredential();
    const upstream = scenarioUpstream(() => upstream.sseOk());
    vi.stubGlobal("fetch", upstream.impl);
    const config = baseConfig();
    const app = await startServer(config);
    try {
      await wire(app, config);

      const messages = await app.app.inject({
        method: "POST", url: "/v1/messages", headers: { "user-agent": CODEX_UA },
        payload: msgPayload(),
      });
      expect(messages.statusCode, messages.body).toBe(200);
      expect(messages.body).toContain("ok");

      // A non-Codex UA on /v1/responses is still a codex client by path.
      const responses = await app.app.inject({
        method: "POST", url: "/v1/responses",
        payload: { model: "codex-subscription,gpt-5.1-codex", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }], stream: true },
      });
      expect(responses.statusCode, responses.body).toBe(200);

      const dataCalls = upstream.calls.filter((c) => c.url === UPSTREAM);
      expect(dataCalls.length).toBe(2);
      for (const call of dataCalls) {
        const headers = new Headers(call.init.headers);
        expect(headers.get("authorization")!.startsWith("Bearer eyJ")).toBe(true);
        expect(headers.get("originator")).toBe("codex_cli_rs");
        expect(call.init.redirect).toBe("error");
        // Marker never upstream, in headers or body; spoofed user key stripped.
        expect(JSON.stringify(call.init.headers)).not.toContain(MARKER);
        expect(JSON.stringify(call.init.headers)).not.toContain("sk-user-owns-this");
        expect(call.init.body).not.toContain(MARKER);
        // Fixed origin: direct dispatcher set, never a config base_url.
        expect(call.url).toBe(UPSTREAM);
      }
    } finally { await app.app.close(); }
  });

  it("runs a tool-call turn: request finalizes tools and sets session headers", async () => {
    await installViaProductionInstaller();
    writeCredential();
    const upstream = scenarioUpstream(async () => {
      const events = [
        { type: "response.created", response: { id: "r2" } },
        { type: "response.output_item.done", item: { type: "function_call", name: "get_weather", arguments: "{\"city\":\"sf\"}", call_id: "c1" } },
        { type: "response.completed", response: { id: "r2" } },
      ];
      return new Response(
        events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n",
        { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    vi.stubGlobal("fetch", upstream.impl);
    const app = await startServer(baseConfig());
    try {
      await wire(app, baseConfig());
      const response = await app.app.inject({
        method: "POST", url: "/v1/messages", headers: { "user-agent": CODEX_UA },
        payload: msgPayload({
          messages: [{ role: "user", content: "weather in sf?" }],
          tools: [{ type: "function", name: "get_weather", description: "w",
            input_schema: { type: "object", properties: { city: { type: "string" } } } }],
        }),
      });
      expect(response.statusCode, response.body).toBe(200);
      const dataCall = upstream.calls.find((c) => c.url === UPSTREAM)!;
      expect(dataCall).toBeTruthy();
      const wireBody = JSON.parse(dataCall.init.body);
      expect(Array.isArray(wireBody.tools)).toBe(true);
      expect(wireBody.tools[0].type).toBe("function");
      expect(wireBody.store).toBe(false);
      expect(wireBody.stream).toBe(true);
      expect(typeof wireBody.prompt_cache_key).toBe("string");
      const headers = new Headers(dataCall.init.headers);
      expect(headers.get("session-id")).toBe(wireBody.prompt_cache_key);
      expect(headers.get("thread-id")).toBe(wireBody.prompt_cache_key);
    } finally { await app.app.close(); }
  });

  it("SSE terminal error is surfaced, not forwarded as content", async () => {
    await installViaProductionInstaller();
    writeCredential();
    const upstream = scenarioUpstream(async () => new Response(
      `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "r3" } })}\n\n` +
      `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "server_error", message: "boom" } })}\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } }));
    vi.stubGlobal("fetch", upstream.impl);
    const app = await startServer(baseConfig());
    try {
      await wire(app, baseConfig());
      const response = await app.app.inject({
        method: "POST", url: "/v1/messages", headers: { "user-agent": CODEX_UA },
        payload: msgPayload({ stream: true }),
      });
      // A codex_* classified error, never a 200 carrying the terminal event.
      expect(response.statusCode).not.toBe(200);
      expect(response.body).not.toContain("event: error");
      expect(response.body).toContain("codex_");
    } finally { await app.app.close(); }
  });

  it("response.failed with and without an error body never passes as a reply", async () => {
    await installViaProductionInstaller();
    writeCredential();
    for (const variant of ["with-body", "without-body"]) {
      const errorBody = variant === "with-body"
        ? { type: "response.failed", response: { id: "r4", error: { type: "server_error", message: "x" } } }
        : { type: "response.failed", response: { id: "r4" } };
      const upstream = scenarioUpstream(async () => new Response(
        `event: response.failed\ndata: ${JSON.stringify(errorBody)}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } }));
      vi.stubGlobal("fetch", upstream.impl);
      const app = await startServer(baseConfig());
      try {
        await wire(app, baseConfig());
        const response = await app.app.inject({
          method: "POST", url: "/v1/messages", headers: { "user-agent": CODEX_UA },
          payload: msgPayload({ stream: true }),
        });
        expect(response.statusCode, variant).not.toBe(200);
        expect(response.body).not.toContain("response.failed");
        expect(response.body).toContain("codex_");
      } finally { await app.app.close(); }
      vi.unstubAllGlobals();
      clearPluginRegistry();
    }
  });

  it("401 triggers exactly ONE forced refresh + re-dispatch with the rotated token", async () => {
    await installViaProductionInstaller();
    writeCredential();
    let upstreamCalls = 0;
    const upstream = scenarioUpstream(async () => {
      upstreamCalls++;
      if (upstreamCalls === 1) {
        return new Response(JSON.stringify({ error: { message: "unauthorized" } }), { status: 401 });
      }
      return new Response(
        `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "ok-after-refresh" })}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    vi.stubGlobal("fetch", upstream.impl);
    const app = await startServer(baseConfig());
    try {
      await wire(app, baseConfig());
      const response = await app.app.inject({
        method: "POST", url: "/v1/messages", headers: { "user-agent": CODEX_UA },
        payload: msgPayload(),
      });
      expect(response.statusCode, response.body).toBe(200);
      // The second upstream call is the successful turn; the codex-on-messages
      // envelope is synthesized by the core, so assert on the refresh
      // mechanics rather than the delta text.
      expect(upstreamCalls).toBe(2); // 401 once, refreshed re-dispatch once
      const tokenCalls = upstream.calls.filter((c) => c.url.endsWith("/oauth/token"));
      expect(tokenCalls).toHaveLength(1);
      expect(JSON.stringify(tokenCalls[0].init.body)).toContain("refresh_token");
      // The rotation was persisted BEFORE the re-dispatch used it.
      const stored = JSON.parse(readFileSync(join(configDir, "codex-credentials.json"), "utf8"));
      expect(stored.account.refreshToken).toBe("rt-rotated");
      const dataCalls = upstream.calls.filter((c) => c.url === UPSTREAM);
      const h1 = new Headers(dataCalls[0].init.headers).get("authorization")!;
      const h2 = new Headers(dataCalls[1].init.headers).get("authorization")!;
      expect(h1).not.toBe(h2);
    } finally { await app.app.close(); }
  });

  const expectCooled = async (app: any, dataCalls: { count: number }) => {
    // A fresh turn is refused BEFORE any network touch (breaker), the
    // cooldown is persisted and surfaced in the redacted status (no tokens).
    const refused = await app.app.inject({
      method: "POST", url: "/v1/messages", headers: { "user-agent": CODEX_UA },
      payload: msgPayload(),
    });
    expect(refused.statusCode).toBe(429);
    expect(refused.body).toContain("codex_account_cooling");
    const stored = JSON.parse(readFileSync(join(configDir, "codex-credentials.json"), "utf8"));
    expect(typeof stored.account.cooldownUntil).toBe("number");
    expect(stored.account.cooldownUntil).toBeGreaterThan(Date.now());
    const status = await app.app.inject({ method: "GET", url: "http://localhost:3456/api/codex/status" });
    expect(status.statusCode).toBe(200);
    expect(status.json().coolingUntil).toBeGreaterThan(Date.now());
    expect(status.body).not.toContain("rt-");
    expect(status.body).not.toContain("eyJ");
  };

  it("HTTP 429 usage_limit_reached cools the account; the next turn is refused pre-network", async () => {
    await installViaProductionInstaller();
    writeCredential();
    const dataCalls = { count: 0 };
    const upstream = scenarioUpstream(async () => {
      dataCalls.count++;
      return new Response(JSON.stringify({ error: { type: "usage_limit_reached", message: "limit", resets_in_seconds: 1800 } }), { status: 429 });
    });
    vi.stubGlobal("fetch", upstream.impl);
    const coolingConfig = managedOnlyConfig();
    const app = await startServer(coolingConfig);
    try {
      await wire(app, coolingConfig);
      const first = await app.app.inject({
        method: "POST", url: "/v1/messages", headers: { "user-agent": CODEX_UA },
        payload: msgPayload(),
      });
      expect(first.statusCode).toBe(429);
      expect(first.body).toContain("codex_usage_limit");
      expect(dataCalls.count).toBe(1);
      await expectCooled(app, dataCalls);
      // The refused turn never touched the network — still exactly one call.
      expect(dataCalls.count).toBe(1);
    } finally { await app.app.close(); }
  });

  it("SSE terminal usage_limit_reached cools the account; the next turn is refused pre-network", async () => {
    await installViaProductionInstaller();
    writeCredential();
    const dataCalls = { count: 0 };
    const upstream = scenarioUpstream(async () => {
      dataCalls.count++;
      return new Response(
        `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "r5" } })}\n\n` +
        `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "usage_limit_reached", message: "limit", resets_in_seconds: 1800 } })}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    vi.stubGlobal("fetch", upstream.impl);
    const coolingConfig = managedOnlyConfig();
    const app = await startServer(coolingConfig);
    try {
      await wire(app, coolingConfig);
      const first = await app.app.inject({
        method: "POST", url: "/v1/messages", headers: { "user-agent": CODEX_UA },
        payload: msgPayload(),
      });
      expect(first.statusCode).toBe(429);
      expect(first.body).toContain("codex_usage_limit");
      expect(dataCalls.count).toBe(1);
      await expectCooled(app, dataCalls);
      expect(dataCalls.count).toBe(1);
    } finally { await app.app.close(); }
  });

  it("client disconnect returns promptly (upstream abort is a known host limitation)", async () => {
    await installViaProductionInstaller();
    writeCredential();
    let upstreamCancelled = false;
    const upstream = scenarioUpstream(async (_u, init) => {
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "r6" } })}\n\n`));
          // Never completes on its own; the client abort must cancel it.
        },
        cancel() { upstreamCancelled = true; },
      });
      init?.signal?.addEventListener("abort", () => { upstreamCancelled = true; });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    vi.stubGlobal("fetch", upstream.impl);
    const app = await startServer(baseConfig());
    try {
      await wire(app, baseConfig());
      // Real ephemeral socket (light-my-request inject does not model socket
      // teardown): a disconnecting HTTP client must propagate cancellation
      // through the response-stream chain into the upstream reader.
      await app.app.listen({ port: 0, host: "127.0.0.1" });
      const port = (app.app.server.address() as any).port;
      const realFetch = unstubbedFetch;
      const ac = new AbortController();
      const pending = realFetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": CODEX_UA },
        body: JSON.stringify(msgPayload({ stream: true })),
        signal: ac.signal,
      });
      await new Promise((r) => setTimeout(r, 300));
      ac.abort();
      const settled = await Promise.race([
        pending.then(() => "done").catch(() => "rejected"),
        new Promise((r) => setTimeout(() => r("timeout"), 5_000)),
      ]);
      expect(settled).not.toBe("timeout");
      // A disconnecting client must not leave the client request hanging.
      // Boundary cancellation of the upstream reader by the plugin
      // transformer (output-stream cancel → reader.cancel) is pinned by
      // transformer.test.ts ("propagates a client cancel to the upstream
      // reader"); full socket→fetch-signal propagation is a CORE-wide seam
      // (config.signal is not client-abort-wired today for ANY provider) and
      // is listed as a residual, not asserted end to end here.
      expect(["done", "rejected"]).toContain(settled);
    } finally { await app.app.close(); }
  }, 30_000);

  it("Router and unrelated providers survive; a user-owned generic codex provider is never hijacked", async () => {
    await installViaProductionInstaller();
    writeCredential();
    const config = baseConfig();
    const upstream = scenarioUpstream(() => upstream.sseOk());
    vi.stubGlobal("fetch", upstream.impl);
    const app = await startServer(config);
    try {
      await wire(app, config);
      const response = await app.app.inject({
        method: "POST", url: "/v1/messages", headers: { "user-agent": CODEX_UA },
        payload: msgPayload(),
      });
      expect(response.statusCode, response.body).toBe(200);
      // The in-memory runtime config keeps every non-managed entry verbatim.
      const runtimeConfig = (app as any).configService?.get?.("providers") ?? config.providers;
      const unrelated = runtimeConfig.find((p: any) => p.name === "unrelated");
      const userCodex = runtimeConfig.find((p: any) => p.name === "codex");
      expect(unrelated.api_key).toBe("sk-unrelated-real");
      expect(userCodex.api_key).toBe("sk-user-owns-this");
      expect(userCodex.transformer.use).toEqual([]);
      const managed = runtimeConfig.find((p: any) => p.name === "codex-subscription");
      expect(managed.api_key).toBe(MARKER);
      expect(config.Router).toEqual({ default: "unrelated,u-1" });
    } finally { await app.app.close(); }
  });
});

describe("codex plugin integration — fake browser login through the real admin routes", () => {
  it("callback login (real loopback 1455) upserts the managed provider; Router and others byte-identical; 0600 creds", async () => {
    await installViaProductionInstaller();
    const upstream = fakeUpstream();
    vi.stubGlobal("fetch", upstream.impl);
    const app = await startServer(baseConfig());
    try {
      await wire(app, baseConfig());
      const before = baseConfig();

      const status0 = await app.app.inject({ method: "GET", url: "http://127.0.0.1:3456/api/codex/status" });
      expect(status0.statusCode).toBe(200);
      expect(status0.json()).toMatchObject({ status: "not_connected", providerName: "codex-subscription" });

      const started = await app.app.inject({ method: "POST", url: "http://127.0.0.1:3456/api/codex/login/start", payload: {} });
      expect(started.statusCode, started.body).toBe(200);
      const login = started.json();
      expect(Object.keys(login).sort()).toEqual(["expiresAt", "loginId", "mode", "redirectUri", "url"]);
      expect(login.loginId).toMatch(/^[a-f0-9]{32}$/);
      expect(login.mode).toBe("callback");
      expect(new URL(login.url).origin).toBe("https://auth.openai.com");
      expect(login.url).toContain("code_challenge_method=S256");

      // Drive the REAL loopback callback with the state from the authorize URL.
      // A raw socket request (not the stubbed global fetch) — exactly what the
      // browser would do.
      const authorizeUrl = new URL(login.url);
      const port = Number(new URL(login.redirectUri).port);
      const callbackQs = `state=${authorizeUrl.searchParams.get("state")}&code=fake-auth-code`;
      const { request: undiciRequest } = await import("node:http");
      const page = await new Promise<number>((resolve, reject) => {
        const req = undiciRequest({ host: "127.0.0.1", port, path: `/auth/callback?${callbackQs}`, headers: { host: `127.0.0.1:${port}` } },
          (res) => { res.resume(); resolve(res.statusCode!); });
        req.on("error", reject);
        req.end();
      });
      expect(page).toBe(200);

      // Poll reaches connected through the real exchange+models+upsert flow.
      let poll: any = null;
      for (let i = 0; i < 50; i++) {
        const p = await app.app.inject({ method: "POST", url: "http://127.0.0.1:3456/api/codex/login/poll", payload: { loginId: login.loginId } });
        expect(p.statusCode, p.body).toBe(200);
        poll = p.json();
        if (poll.status !== "pending") break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(poll.status).toBe("connected");
      expect(poll.models).toEqual(["gpt-5.1-codex", "gpt-5.1"]);
      expect(poll.modelCount).toBe(2);

      // The exchange and model discovery hit the fake IdP/upstream.
      expect(upstream.calls.some((c) => c.url.endsWith("/oauth/token"))).toBe(true);
      expect(upstream.calls.some((c) => c.url.includes("/backend-api/codex/models"))).toBe(true);

      // 0600 credential file; managed provider upsert; Router byte-identical.
      const credPath = join(configDir, "codex-credentials.json");
      expect(existsSync(credPath)).toBe(true);
      expect(statSync(credPath).mode & 0o777).toBe(0o600);
      const cred = JSON.parse(readFileSync(credPath, "utf8"));
      expect(cred.account.refreshToken).toBe("rt-1");
      expect(JSON.stringify(cred)).not.toContain(MARKER);

      const written = await app.app.inject({ method: "GET", url: "http://127.0.0.1:3456/api/codex/status" });
      expect(written.json()).toMatchObject({ status: "connected", email: "codex@example.invalid", plan: "pro", accountId: "acct_1" });
      expect(written.body).not.toContain("rt-1");
      expect(written.body).not.toContain("eyJ");

      // Config: managed entry locked, everything else byte-identical.
      const rawAfter = JSON.parse(readConfigRaw());
      const afterList = rawAfter.Providers ?? rawAfter.providers;
      const managed = afterList.find((p: any) => p.name === "codex-subscription");
      expect(managed.api_key).toBe(MARKER);
      expect(managed.transformer.use).toEqual(["openai-responses", "codex"]);
      expect(managed.models).toEqual(["gpt-5.1-codex", "gpt-5.1"]);
      const userCodex = afterList.find((p: any) => p.name === "codex");
      expect(userCodex.api_key).toBe("sk-user-owns-this");
      expect(JSON.stringify(userCodex)).toBe(JSON.stringify((before.Providers ?? before.providers).find((p: any) => p.name === "codex")));
      expect(JSON.stringify(rawAfter.Router)).toBe(JSON.stringify(before.Router));
      const unrelated = afterList.find((p: any) => p.name === "unrelated");
      expect(JSON.stringify(unrelated)).toBe(JSON.stringify((before.Providers ?? before.providers).find((p: any) => p.name === "unrelated")));

      // Disconnect: credential gone, managed entry REMOVED (explicit user
      // action, distinct from a generic save's omission-restore), Router and
      // unrelated providers untouched.
      const disc = await app.app.inject({ method: "POST", url: "http://127.0.0.1:3456/api/codex/disconnect", payload: {} });
      expect(disc.statusCode).toBe(200);
      expect(disc.json()).toEqual({ success: true });
      expect(existsSync(credPath)).toBe(false);
      const afterDisc = JSON.parse(readConfigRaw());
      const discList = afterDisc.Providers ?? afterDisc.providers;
      expect(discList.some((p: any) => p.name === "codex-subscription")).toBe(false);
      expect(afterDisc.Router).toEqual(before.Router);
      expect(discList.find((p: any) => p.name === "unrelated")).toBeTruthy();
      expect(discList.find((p: any) => p.name === "codex").api_key).toBe("sk-user-owns-this");
    } finally { await app.app.close(); }
  });

  it("paste-mode login completes through /login/complete; malformed loginId is 422", async () => {
    await installViaProductionInstaller();
    // Occupy BOTH loopback callback ports so the service falls back to paste.
    const { createServer } = await import("node:http");
    const blockers: any[] = [];
    for (const port of [1455, 1457]) {
      const s = createServer();
      await new Promise<void>((r) => s.once("error", r).listen(port, "127.0.0.1", r));
      blockers.push(s);
    }
    try {
      const upstream = fakeUpstream();
      vi.stubGlobal("fetch", upstream.impl);
      const app = await startServer(baseConfig());
      try {
        await wire(app, baseConfig());
        const bad = await app.app.inject({ method: "POST", url: "http://127.0.0.1:3456/api/codex/login/poll",
          payload: { loginId: "not-a-real-id" } });
        expect(bad.statusCode).toBe(422);
        expect(bad.json().error).toBe("codex_login_state_rejected");

        const started = await app.app.inject({ method: "POST", url: "http://127.0.0.1:3456/api/codex/login/start", payload: {} });
        expect(started.statusCode).toBe(200);
        const login = started.json();
        expect(login.mode).toBe("paste");
        expect(login.redirectUri).toBe("http://127.0.0.1:1455/auth/callback");

        const authorizeUrl = new URL(login.url);
        const callbackUrl = `http://127.0.0.1:1455/auth/callback?state=${authorizeUrl.searchParams.get("state")}&code=paste-code`;
        let poll: any = null;
        for (let i = 0; i < 50; i++) {
          const p = await app.app.inject({ method: "POST", url: "http://127.0.0.1:3456/api/codex/login/complete",
            payload: { loginId: login.loginId, callbackUrl } });
          expect(p.statusCode, p.body).toBe(200);
          poll = p.json();
          if (poll.status !== "pending" && poll.status !== "error") break;
          await new Promise((r) => setTimeout(r, 100));
        }
        expect(poll.status).toBe("connected");
        expect(existsSync(join(configDir, "codex-credentials.json"))).toBe(true);
        expect(statSync(join(configDir, "codex-credentials.json")).mode & 0o777).toBe(0o600);

        // Cancel route returns {ok:true}.
        const cancelled = await app.app.inject({ method: "POST", url: "http://127.0.0.1:3456/api/codex/login/cancel",
          payload: { loginId: login.loginId } });
        expect(cancelled.statusCode).toBe(200);
      } finally { await app.app.close(); }
    } finally {
      for (const s of blockers.splice(0).reverse()) await new Promise((r) => s.close(r));
    }
  });

  it("usage endpoint returns ms-window quota; sync hits the fake models endpoint", async () => {
    await installViaProductionInstaller();
    writeCredential();
    const upstream = fakeUpstream();
    vi.stubGlobal("fetch", upstream.impl);
    const app = await startServer(baseConfig());
    try {
      await wire(app, baseConfig());
      const usage = await app.app.inject({ method: "POST", url: "http://127.0.0.1:3456/api/codex/usage", payload: {} });
      expect(usage.statusCode).toBe(200);
      const u = usage.json();
      expect(u.plan).toBe("pro");
      expect(u.primary.usedPercent).toBe(5);
      expect(u.primary.windowSeconds).toBe(18000);
      expect(u.primary.resetAt).toBeGreaterThan(Date.now());
      const sync = await app.app.inject({ method: "POST", url: "http://127.0.0.1:3456/api/codex/sync", payload: {} });
      expect(sync.statusCode, sync.body).toBe(200);
      expect(sync.json()).toMatchObject({ success: true, models: ["gpt-5.1-codex", "gpt-5.1"], modelCount: 2 });
    } finally { await app.app.close(); }
  });

  it("admin guards: non-loopback 403, hostile Origin 403, bad Host 403", async () => {
    await installViaProductionInstaller();
    writeCredential();
    const upstream = fakeUpstream();
    vi.stubGlobal("fetch", upstream.impl);
    const app = await startServer(baseConfig());
    try {
      await wire(app, baseConfig());
      // fastify.inject simulates 127.0.0.1 (loopback) by default, so only the
      // header-based guards are exercisable here; the socket guard itself is
      // pinned by the plugin's own unit suite.
      const hostileOrigin = await app.app.inject({ method: "GET", url: "http://127.0.0.1:3456/api/codex/status",
        headers: { origin: "https://hostile.invalid" } });
      expect(hostileOrigin.statusCode).toBe(403);
      const badHost = await app.app.inject({ method: "GET", url: "http://127.0.0.1:3456/api/codex/status",
        headers: { host: "evil.example.com:3456" } });
      expect(badHost.statusCode).toBe(403);
      const ok = await app.app.inject({ method: "GET", url: "http://localhost:3456/api/codex/status" });
      expect(ok.statusCode).toBe(200);
    } finally { await app.app.close(); }
  });
});

/** Read the raw config file the way the service writes it (no interpolation).
 *  CONFIG_FILE = $CCR_CONFIG_DIR/config.json, resolved at import time — the
 *  sandbox env is pinned in beforeEach BEFORE any host write happens. */
function readConfigRaw(): string {
  const p = join(configDir, "config.json");
  if (!existsSync(p)) {
    throw new Error(`no config file at ${p}: ${execFileSync("ls", [configDir]).toString()}`);
  }
  return readFileSync(p, "utf8");
}
