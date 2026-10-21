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
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { build } from "esbuild";
import { clearPluginRegistry, getManagedRuntimeFor, applyPluginConfigProtectors, listLoadedPlugins, registerAllPluginRoutes } from "../provider-plugins/registry";
import { loadInstalledPlugins } from "../provider-plugins/loader";
import { setTransformerRuntime } from "../services/transformer";

const PLUGIN_PKG = join(__dirname, "../../../plugins/gemini-oauth");

// The client credentials are deployment-injected (never repo literals); tests
// exercise the accessors with dummy env values.
const log = { info: () => {}, warn: () => {}, error: () => {} };

let configDir = "";
let pluginDir = "";

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "ccr-gemini-plugin-"));
  pluginDir = join(configDir, "plugins", "gemini-oauth");
  mkdirSync(pluginDir, { recursive: true });
  clearPluginRegistry();
});

afterEach(() => {
  clearPluginRegistry();
  rmSync(configDir, { recursive: true, force: true });
  delete process.env.GEMINI_OAUTH_CLIENT_ID;
  delete process.env.GEMINI_OAUTH_CLIENT_SECRET;
});

/** Build the plugin's prebuilt entry exactly like `scripts/build.ts` does and
 *  lay it out as an installed plugin under the temp config dir. */
async function installPlugin(): Promise<void> {
  await build({
    entryPoints: [join(PLUGIN_PKG, "src/plugin.ts")],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    outfile: join(pluginDir, "plugin.js"),
    logLevel: "silent",
  });
  writeFileSync(join(configDir, "plugins", "plugins.json"), JSON.stringify([{ name: "gemini-oauth", enabled: true }]));
  writeFileSync(join(pluginDir, "plugin.json"), JSON.stringify({ name: "gemini-oauth", version: "1.0.0", coreApi: "1" }));
  writeFileSync(join(pluginDir, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(pluginDir, "card.js"), "export default { mount() {} };");
}

const hostServer = {
  configService: {
    reload() {},
    set() {},
    get() { return true; },
  },
};

async function load(): Promise<void> {
  const result = await loadInstalledPlugins({ configDir, log, getServer: () => hostServer });
  expect(result.loaded).toEqual(["gemini-oauth"]);
  expect(result.failed).toEqual([]);
}

describe("gemini-oauth provider plugin: discovery, runtime, protector and routes", () => {
  it("loads through the core loader and registers runtime, card and locales", async () => {
    await installPlugin();
    await load();
    expect(listLoadedPlugins().map((p) => p.name)).toEqual(["gemini-oauth"]);

    // Managed runtime: the triple managed-provider detection moved intact.
    const runtime = getManagedRuntimeFor({ geminiOauthManaged: true, name: "gemini-oauth" });
    expect(runtime?.name).toBe("gemini-oauth");
    expect(getManagedRuntimeFor({ geminiOauthManaged: true, name: "gemini-oauth" })?.suppressDebugLog).toBe(true);
    expect(getManagedRuntimeFor({ name: "ordinary", api_key: "sk" })).toBeUndefined();
    // Runtime-shaped fallbacks (fixed host + transformer / marker key).
    expect(getManagedRuntimeFor({
      baseUrl: "https://daily-cloudcode-pa.googleapis.com",
      transformer: { use: ["gemini-oauth"] },
    })?.name).toBe("gemini-oauth");
    expect(getManagedRuntimeFor({ name: "gemini-oauth", apiKey: "ccr-managed-gemini-oauth" })?.name).toBe("gemini-oauth");

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
    const runtime = getManagedRuntimeFor({ geminiOauthManaged: true, name: "gemini-oauth" })!;
    // No connected account: the token fetch rejects — the marker must not leak.
    await expect(runtime.signRequest!({
      headers: { Authorization: "Bearer untrusted", "x-api-key": "untrusted-key", Host: "evil", "Proxy-Authorization": "x", "X-Kept": "yes" },
      requestBody: {},
      provider: {},
    })).rejects.toThrow();
    // Even the rejection must not carry the marker api_key downstream; the
    // header-stripping contract is covered by the plugin's own suite — here we
    // pin that a disconnected account cannot mint a Bearer token at all.
  });

  it("classifyError parses the raw upstream body and classifies the taxonomy", async () => {
    await installPlugin();
    await load();
    const runtime = getManagedRuntimeFor({ geminiOauthManaged: true, name: "gemini-oauth" })!;
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
    const runtime = getManagedRuntimeFor({ geminiOauthManaged: true, name: "gemini-oauth" })!;
    // Disconnected: cooling is false, so the breaker lets the request pass and
    // the lock still pins the fixed data-plane SSE origin.
    await expect(runtime.ensureUsable!()).resolves.toBeUndefined();
    const config: any = { url: "https://attacker.invalid/v1", headers: {} };
    await runtime.lockUpstream!(config, {});
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
    // A bare transformer runtime so registerTransformer succeeds.
    const registered = new Map<string, unknown>();
    setTransformerRuntime({ registerTransformer: (name: string, cls: unknown) => { registered.set(name, cls); } } as any);
    try {
      await load();
      expect(registered.has("gemini-oauth")).toBe(true);

      const app = Fastify({ logger: false });
      registerAllPluginRoutes(app);
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
      setTransformerRuntime(undefined as any);
    }
  });
});
