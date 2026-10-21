/**
 * The gemini-oauth provider plugin as the first real consumer of the
 * provider-plugin API: the core builds the plugin's prebuilt entry, installs
 * it into a temp config dir (plugins.json + plugin.json + plugin.js, exactly
 * the layout `ccr plugin add` produces) and loads it through the REAL loader.
 *
 * Proves that the six admin routes, the config protector, the managed runtime
 * and the UI card/locale registration all work THROUGH the plugin — nothing
 * here imports the plugin's internals; only public registry/loader surfaces.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import Server from "../server";
import * as configModule from "../ccr/config";
import * as activeProbe from "../services/active-probe";
import { reloadProviderRuntime } from "../provider-plugins/host";
import { registerAdminRoutes } from "../ccr/admin-routes";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import { clearPluginRegistry, getManagedRuntimeFor, applyPluginConfigProtectors, listLoadedPlugins, registerAllPluginRoutes } from "../provider-plugins/registry";
import { loadInstalledPlugins } from "../provider-plugins/loader";


const PLUGIN_PKG = join(__dirname, "../../../plugins/gemini-oauth");

// The client credentials are deployment-injected (never repo literals); tests
// exercise the accessors with dummy env values.
const log = { info: () => {}, warn: () => {}, error: () => {} };

let configDir = "";
let pluginDir = "";
let routeHost: ReturnType<typeof Fastify>;

beforeEach(() => {
  routeHost = Fastify();
  configDir = mkdtempSync(join(tmpdir(), "ccr-gemini-plugin-"));
  pluginDir = join(configDir, "plugins", "gemini-oauth");
  mkdirSync(pluginDir, { recursive: true });
  clearPluginRegistry();
});

afterEach(async () => {
  await routeHost.close();
  clearPluginRegistry();
  activeProbe.resetActiveProbeService();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  rmSync(configDir, { recursive: true, force: true });
  delete process.env.GEMINI_OAUTH_CLIENT_ID;
  delete process.env.GEMINI_OAUTH_CLIENT_SECRET;
});

/** Build the plugin's prebuilt entry exactly like `scripts/build.ts` does and
 *  lay it out as an installed plugin under the temp config dir. */
async function installPlugin(): Promise<void> {
  const bundle = await build({
    metafile: true,
    entryPoints: [join(PLUGIN_PKG, "src/plugin.ts")],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    outfile: join(pluginDir, "plugin.js"),
    logLevel: "silent",
  });
  expect(Object.keys(bundle.metafile!.inputs).some(file => /core\/src\//.test(file))).toBe(false);
  await build({
    entryPoints: [join(PLUGIN_PKG, "src/card-entry.ts")], bundle: true,
    platform: "browser", target: "es2020", format: "esm", outfile: join(pluginDir, "card.js"), logLevel: "silent",
  });
  writeFileSync(join(configDir, "plugins", "plugins.json"), JSON.stringify([{ name: "gemini-oauth", enabled: true }]));
  writeFileSync(join(pluginDir, "plugin.json"), JSON.stringify({ name: "gemini-oauth", version: "1.0.0", coreApi: "1" }));
  writeFileSync(join(pluginDir, "package.json"), JSON.stringify({ type: "module" }));
}

const hostServer = {
  configService: {
    reload() {},
    set() {},
    get() { return true; },
  },
};

async function load(): Promise<void> {
  const result = await loadInstalledPlugins({ configDir, log, getServer: () => ({ ...hostServer, app: routeHost }) });
  expect(result.loaded).toEqual(["gemini-oauth"]);
  expect(result.failed).toEqual([]);
}

describe("gemini-oauth provider plugin: discovery, runtime, protector and routes", () => {
  it("loads through the core loader and registers runtime, card and locales", async () => {
    await installPlugin();
    await load();
    expect(listLoadedPlugins().map((p) => p.name)).toEqual(["gemini-oauth"]);

    // Managed runtime: the triple managed-provider detection moved intact.
    const runtime = getManagedRuntimeFor({ geminiOauthManaged: true, name: "gemini-oauth" } as any);
    expect(runtime?.name).toBe("gemini-oauth");
    expect(getManagedRuntimeFor({ geminiOauthManaged: true, name: "gemini-oauth" } as any)?.suppressDebugLog).toBe(true);
    expect(getManagedRuntimeFor({ name: "ordinary", api_key: "sk" } as any)).toBeUndefined();
    // Runtime-shaped fallbacks (fixed host + transformer / marker key).
    expect(getManagedRuntimeFor({
      baseUrl: "https://daily-cloudcode-pa.googleapis.com",
      transformer: { use: ["gemini-oauth"] },
    } as any)?.name).toBe("gemini-oauth");
    expect(getManagedRuntimeFor({ name: "gemini-oauth", apiKey: "ccr-managed-gemini-oauth" } as any)?.name).toBe("gemini-oauth");

    // /api/plugins payload: card URL + the locale bundle from the plugin.
    const info = listLoadedPlugins()[0];
    expect(info.cardUrl).toBe("/plugins/gemini-oauth/card.js");
    expect((info.locales as any)?.en?.geminiOauth?.title).toBeTruthy();
    expect((info.locales as any)?.zh?.geminiOauth?.title).toBeTruthy();
    expect(existsSync(join(pluginDir, "plugin.js"))).toBe(true);
  });

  it("signRequest strips client credential headers and injects the live Bearer token", async () => {
    await installPlugin();
    await load();
    const runtime = getManagedRuntimeFor({ geminiOauthManaged: true, name: "gemini-oauth" } as any)!;
    // No connected account: the token fetch rejects — the marker must not leak.
    await expect(runtime.signRequest!({
      headers: { Authorization: "Bearer untrusted", "x-api-key": "untrusted-key", Host: "evil", "Proxy-Authorization": "x", "X-Kept": "yes" },
      requestBody: {},
      provider: {} as any,
    })).rejects.toThrow();
    // Even the rejection must not carry the marker api_key downstream; the
    // header-stripping contract is covered by the plugin's own suite — here we
    // pin that a disconnected account cannot mint a Bearer token at all.
  });

  it("classifyError parses the raw upstream body and classifies the taxonomy", async () => {
    await installPlugin();
    await load();
    const runtime = getManagedRuntimeFor({ geminiOauthManaged: true, name: "gemini-oauth" } as any)!;
    const quota = runtime.classifyError!(429, JSON.stringify({ error: { message: "Resource has been exhausted" } }), "neutral");
    expect(quota).toMatchObject({ code: "gemini_oauth_quota_exceeded", httpStatus: 429, cooldownMs: 15 * 60_000 });
    const identity = runtime.classifyError!(429, JSON.stringify({ error: { message: "Resource has been exhausted" } }), "x-anthropic-billing-header: 1");
    expect(identity).toMatchObject({ code: "gemini_oauth_identity_blocked", httpStatus: 400, cooldownMs: 6 * 60 * 60_000 });
    const reauth = runtime.classifyError!(401, '{"error":{"message":"UNAUTHENTICATED"}}', "");
    expect(reauth).toMatchObject({ code: "gemini_oauth_reauth_required", httpStatus: 401 });
  });

  it("ensureUsable is the cooling circuit breaker; lockUpstream pins the fixed origin", async () => {
    await installPlugin();
    await load();
    const runtime = getManagedRuntimeFor({ geminiOauthManaged: true, name: "gemini-oauth" } as any)!;
    // Disconnected: cooling is false, so the breaker lets the request pass and
    // the lock still pins the fixed data-plane SSE origin.
    await expect(runtime.ensureUsable!()).resolves.toBeUndefined();
    const config: any = { url: "https://attacker.invalid/v1", headers: {} };
    await runtime.lockUpstream!(config, {} as any);
    expect(config.url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse");
    expect(config.redirect).toBe("error");
    expect(config.dispatcher).toBeDefined();
  });

  it("the config protector re-locks and restores the managed entry through the registry", async () => {
    await installPlugin();
    await load();
    const next: any = { Providers: [
      { name: "gemini-oauth", api_base_url: "https://attacker.invalid", api_key: "attacker-key", transformer: { use: [] }, models: ["m"] },
    ], Router: {} };
    const previous: any = { Providers: [
      { name: "gemini-oauth", api_base_url: "https://daily-cloudcode-pa.googleapis.com", api_key: "ccr-managed-gemini-oauth", gemini_oauth_managed: true, models: ["m"] },
    ], Router: {} };
    applyPluginConfigProtectors(next, previous);
    expect(next.Providers[0]).toMatchObject({
      api_base_url: "https://daily-cloudcode-pa.googleapis.com",
      api_key: "ccr-managed-gemini-oauth",
      gemini_oauth_managed: true,
      gemini_oauth_kind: "antigravity",
      transformer: { use: ["gemini-oauth"] },
    });
    expect(JSON.stringify(next)).not.toContain("attacker");

    // Omission restores.
    const omitted: any = { Providers: [], Router: {} };
    applyPluginConfigProtectors(omitted, previous);
    expect(omitted.Providers[0].name).toBe("gemini-oauth");
    expect(omitted.Providers[0].api_key).toBe("ccr-managed-gemini-oauth");
  });

  it("the six admin routes respond through the plugin registration", async () => {
    await installPlugin();
    process.env.GEMINI_OAUTH_CLIENT_ID = "dummy-client-id";
    process.env.GEMINI_OAUTH_CLIENT_SECRET = "dummy-client-secret";
    try {
      await load();
      const app = Fastify({ logger: false });
      await registerAllPluginRoutes(app);
      // Inject against the default-port authority: the guard reads the bound
      // address (null pre-listen) and falls back to 3456.
      const base = "http://localhost:3456";
      const post = async (url: string, payload?: any) => app.inject({ method: "POST", url: `${base}${url}`, payload });
      const status = await app.inject({ method: "GET", url: `${base}/api/gemini-oauth/status` });
      expect(status.statusCode).toBe(200);
      expect(status.json()).toEqual({
        configured: true, connected: false, kind: "antigravity", email: null, project: null,
        tier: null, modelsCount: 0, lastError: null, cooldownUntil: null,
      });
      const started = await post("/api/gemini-oauth/login/start");
      expect(started.statusCode).toBe(200);
      const body = started.json();
      expect(Object.keys(body).sort()).toEqual(["expiresAt", "loginId", "url"]);
      expect(body.loginId).toMatch(/^[a-f0-9]{48}$/);
      // cancel/poll reject malformed ids BEFORE touching the service.
      expect((await post("/api/gemini-oauth/login/poll", { loginId: "bad" })).statusCode).toBe(422);
      expect((await post("/api/gemini-oauth/login/cancel", { loginId: "bad" })).statusCode).toBe(422);
      expect((await post("/api/gemini-oauth/login/cancel", { loginId: body.loginId })).json()).toEqual({ ok: true });
      expect((await post("/api/gemini-oauth/sync")).statusCode).toBe(409);
      expect((await post("/api/gemini-oauth/disconnect")).json()).toEqual({ ok: true, removedModelRefs: [], defaultFallback: null });
      await app.close();
    } finally {
      // The isolated loader registry is disposed by afterEach.
    }
  });
});

// This test installs the independent tarball, activates through the real
// loader, wires the root admin routes, re-resolves providers, and dispatches a
// real transformer request. It catches ordering/bundle/state-fork bugs that a
// fake plugin or a makePluginContext-only test cannot catch.
it("installs an independent tarball and routes admin + inference without core Gemini imports", async () => {
  await installPlugin();
  // Independent distribution: no node_modules or workspace files are included.
  execFileSync("tar", ["-czf", join(configDir, "plugin.tgz"), "-C", pluginDir, "."]);
  rmSync(pluginDir, { recursive: true, force: true }); mkdirSync(pluginDir);
  execFileSync("tar", ["-xzf", join(configDir, "plugin.tgz"), "-C", pluginDir]);
  process.env.GEMINI_OAUTH_CLIENT_ID = "dummy-client-id";
  process.env.GEMINI_OAUTH_CLIENT_SECRET = "dummy-client-secret";
  const provider = { name: "gemini-oauth", api_key: "ccr-managed-gemini-oauth",
    api_base_url: "https://daily-cloudcode-pa.googleapis.com", models: ["gemini-3-flash"],
    transformer: { use: ["gemini-oauth"] } };
  const config = { Providers: [provider], Router: {}, ACTIVE_PROBE_ENABLED: false };
  vi.spyOn(configModule, "readConfigFileRaw").mockResolvedValue(config);
  vi.spyOn(configModule, "readConfigFile").mockResolvedValue(config);
  vi.spyOn(activeProbe, "startActiveProbe").mockReturnValue({ stop() {} } as any);
  const app = new Server({ logger: false, useJsonFile: false, initialConfig: {
    providers: [provider], ACTIVE_PROBE_ENABLED: false,
  } });
  await app.ready();
  const calls: Array<{ url: string; init: any }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("/token")) return new Response(JSON.stringify({ access_token: "ya29.test-live" }));
    return new Response('data: {"response":{"candidates":[{"content":{"parts":[{"text":"plugin healthy"}]},"finishReason":"STOP"}]}}\n\n',
      { headers: { "content-type": "text/event-stream" } });
  }));
  writeFileSync(join(configDir, "gemini-oauth-credentials.json"), JSON.stringify({
    version: 2, kind: "antigravity", account: { email: "fixture@example.invalid", refreshToken: "fixture-refresh",
      projectId: "fixture-project", tier: "paid", importedAt: "2026-01-01T00:00:00Z", lastError: null, cooldownUntil: null },
  }), { mode: 0o600 });
  try {
    const loaded = await loadInstalledPlugins({ configDir, log, getServer: () => app });
    expect(loaded.failed).toEqual([]); expect(loaded.loaded).toEqual(["gemini-oauth"]);
    reloadProviderRuntime(app, config, log);
    await registerAdminRoutes(app, config);
    await app.registerNamespace("/");
    await app.registerNamespace("/preset/gemini", { Providers: [provider], Router: {}, ACTIVE_PROBE_ENABLED: false });
    const status = await app.app.inject({ method: "GET", url: "http://localhost:3456/api/gemini-oauth/status" });
    expect(status.statusCode).toBe(200); expect(status.json().connected).toBe(true);
    const started = await app.app.inject({ method: "POST", url: "http://localhost:3456/api/gemini-oauth/login/start" });
    expect(started.statusCode).toBe(200);
    try {
      for (const action of ["poll", "cancel"]) {
        const invalid = await app.app.inject({ method: "POST", url: `http://localhost:3456/api/gemini-oauth/login/${action}`, payload: { loginId: "bad" } });
        expect(invalid.statusCode).toBe(422);
      }
    } finally {
      const cancel = await app.app.inject({ method: "POST", url: "http://localhost:3456/api/gemini-oauth/login/cancel", payload: { loginId: started.json().loginId } });
      expect(cancel.json()).toEqual({ ok: true });
    }
    // Remaining mutation routes are real, but the local guard rejects a hostile
    // origin before any credential/model mutation or upstream call.
    for (const path of ["sync", "disconnect"]) {
      const rejected = await app.app.inject({ method: "POST", url: `http://localhost:3456/api/gemini-oauth/${path}`, headers: { origin: "https://hostile.invalid" } });
      expect(rejected.statusCode).toBe(403);
    }
    const response = await app.app.inject({ method: "POST", url: "/v1/chat/completions", payload: {
      model: "gemini-oauth,gemini-3-flash", messages: [{ role: "user", content: "hello" }], stream: false,
    } });
    expect(response.statusCode, response.body).toBe(200); expect(response.body).toContain("plugin healthy");
    expect(response.body).not.toContain("ya29."); expect(status.body).not.toContain("fixture-refresh");
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse");
    expect(new Headers(calls[1].init.headers).get("authorization")).toBe("Bearer ya29.test-live");
    expect(calls[1].init.redirect).toBe("error");
    const presetResponse = await app.app.inject({ method: "POST", url: "/preset/gemini/v1/chat/completions", payload: {
      model: "gemini-oauth,gemini-3-flash", messages: [{ role: "user", content: "preset hello" }], stream: false,
    } });
    expect(presetResponse.statusCode, presetResponse.body).toBe(200);
    expect(presetResponse.body).toContain("plugin healthy");
    const presetWire = JSON.parse(calls.at(-1)!.init.body);
    expect(presetWire.project).toBe("fixture-project");
    expect(presetWire.request.contents).toBeTruthy();
    expect(presetWire.messages).toBeUndefined();
    app.pluginRegistry.dispose();
    calls.length = 0;
    const missing = await app.app.inject({ method: "POST", url: "/v1/chat/completions", payload: {
      model: "gemini-oauth,gemini-3-flash", messages: [{ role: "user", content: "hello" }],
    } });
    expect(missing.statusCode).toBe(503); expect(missing.body).toContain("plugin_missing");
    expect(calls).toHaveLength(0);
    expect(existsSync(join(configDir, "gemini-oauth-credentials.json"))).toBe(true);
    const probe = new activeProbe.ActiveProbeService(() => [app.providerService.getProvider("gemini-oauth")!], { enabled: false });
    await probe.probeProviderManually("gemini-oauth");
    expect(calls).toHaveLength(0);
  } finally { await app.app.close(); }
});
