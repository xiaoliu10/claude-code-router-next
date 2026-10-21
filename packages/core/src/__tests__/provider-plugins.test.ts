import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { clearPluginRegistry, getManagedRuntimeFor, applyPluginConfigProtectors, listLoadedPlugins, registerAllPluginRoutes, pluginErrorFrom, isPluginClassifiedError } from "../provider-plugins/registry";
import { loadInstalledPlugins, describeInstalledPlugins, resolvePluginDir } from "../provider-plugins/loader";

// A minimal provider plugin as it ships prebuilt: manifest + entry activating
// one managed runtime, one admin route and one config protector.
const PLUGIN_ENTRY = `
const runtime = {
  name: "fake-sub",
  isManaged: (provider) => provider?.fakeManaged === true,
  ensureUsable: async () => {
    if (globalThis.__fakeCooling) {
      throw Object.assign(new Error("cooling"), { code: "fake_cooling", statusCode: 429 });
    }
  },
  lockUpstream: async (config) => {
    config.url = "https://fake.example/v1/turn";
    config.redirect = "error";
  },
  signRequest: async ({ headers, requestBody }) => {
    return { ...headers, Authorization: "Bearer live-token", "x-fake-session": String(requestBody?.prompt_cache_key ?? "none") };
  },
  classifyError: (status, body) => {
    const text = typeof body === "string" ? body : JSON.stringify(body ?? {});
    if (status === 429 && /exhausted/.test(text)) {
      return { code: "fake_quota", message: "quota", httpStatus: 429, cooldownMs: 60000 };
    }
    return null;
  },
  noteUpstreamError: async (info) => { globalThis.__fakeNoted = info.code; },
  authRefresh: { forceRefresh: async () => { globalThis.__fakeRefreshed = true; } },
  suppressDebugLog: true,
};
async function activate(ctx) {
  ctx.registerManagedRuntime(runtime);
  ctx.registerConfigProtector((next) => {
    const entry = (next.providers ?? []).find((p) => p?.name === "fake-sub");
    if (entry) { entry.api_key = "ccr-managed-fake-sub"; entry.fakeLocked = true; }
  });
  ctx.registerAdminRoutes((app) => {
    app.get("/api/fake-sub/ping", async () => ({ pong: true, plugin: "fake-sub" }));
  });
  ctx.registerUiCard({ cardPath: "card.js" });
  ctx.registerLocales({ en: { fake: { hello: "Hello" } }, zh: { fake: { hello: "你好" } } });
}
module.exports = { activate };
module.exports.default = { activate };
`;

function writePlugin(configDir: string, name: string, opts: { enabled?: boolean; coreApi?: string } = {}) {
  const dir = join(configDir, "plugins", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(configDir, "plugins", "plugins.json"), JSON.stringify([{ name, enabled: opts.enabled ?? true }]));
  writeFileSync(join(dir, "plugin.json"), JSON.stringify({ name, version: "1.0.0", coreApi: opts.coreApi ?? "1" }));
  writeFileSync(join(dir, "plugin.js"), PLUGIN_ENTRY);
  writeFileSync(join(dir, "card.js"), "export default {};");
}

// CJS entry via import(): tsx/vitest transform lets module.exports work; assert
// interop explicitly so the loader contract stays honest.
const log = { info: () => {}, warn: () => {}, error: () => {} };

describe("provider plugin loader & registry", () => {
  let configDir: string;
  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "ccr-plugins-"));
    clearPluginRegistry();
    (globalThis as any).__fakeCooling = false;
    (globalThis as any).__fakeNoted = undefined;
    (globalThis as any).__fakeRefreshed = false;
  });
  afterEach(() => {
    clearPluginRegistry();
    rmSync(configDir, { recursive: true, force: true });
    delete (globalThis as any).__fakeCooling;
    delete (globalThis as any).__fakeNoted;
    delete (globalThis as any).__fakeRefreshed;
  });

  it("loads an installed plugin: runtime, protector, routes, card and locales", async () => {
    writePlugin(configDir, "fake-sub");
    const result = await loadInstalledPlugins({ configDir, log, getServer: () => ({ configService: { reload() {}, set() {}, get() { return true; } } }) });
    expect(result.loaded).toEqual(["fake-sub"]);
    expect(listLoadedPlugins()).toHaveLength(1);

    const runtime = getManagedRuntimeFor({ fakeManaged: true });
    expect(runtime?.name).toBe("fake-sub");
    expect(getManagedRuntimeFor({ fakeManaged: false })).toBeUndefined();

    // Config protector re-locks the managed entry.
    const next: any = { providers: [{ name: "fake-sub", api_key: "sk-attacker" }] };
    applyPluginConfigProtectors(next, undefined);
    expect(next.providers[0].api_key).toBe("ccr-managed-fake-sub");
    expect(next.providers[0].fakeLocked).toBe(true);

    // describeInstalledPlugins feeds /api/plugins (card + locales).
    const described = describeInstalledPlugins(configDir) as any[];
    expect(described[0].cardUrl).toBe("/plugins/fake-sub/card.js");
    expect(described[0].locales?.en?.fake?.hello).toBe("Hello");
  });

  it("skips disabled and missing plugins without failing the rest", async () => {
    writePlugin(configDir, "fake-sub", { enabled: false });
    const dir2 = join(configDir, "plugins", "ghost");
    mkdirSync(dir2, { recursive: true });
    writeFileSync(join(configDir, "plugins", "plugins.json"), JSON.stringify([
      { name: "fake-sub", enabled: false },
      { name: "ghost", enabled: true },
    ]));
    const result = await loadInstalledPlugins({ configDir, log, getServer: () => ({ configService: { reload() {}, set() {}, get() { return true; } } }) });
    expect(result.loaded).toEqual([]);
    expect(result.skipped.map((s) => s.name)).toEqual(["fake-sub"]);
    expect(result.failed).toEqual([{ name: "ghost", error: "plugin.json missing or malformed" }]);
    expect(listLoadedPlugins()).toHaveLength(0);
  });

  it("rejects incompatible coreApi majors", async () => {
    writePlugin(configDir, "fake-sub", { coreApi: "2" });
    const result = await loadInstalledPlugins({ configDir, log, getServer: () => ({ configService: { reload() {}, set() {}, get() { return true; } } }) });
    expect(result.loaded).toEqual([]);
    expect(result.failed[0].error).toContain("incompatible");
  });

  it("resolvePluginDir refuses traversal and unknown names", () => {
    expect(resolvePluginDir(configDir, "..")).toBeNull();
    expect(resolvePluginDir(configDir, "fake-sub")).toBeNull(); // not installed yet
    writePlugin(configDir, "fake-sub");
    expect(resolvePluginDir(configDir, "fake-sub")).toContain(join("plugins", "fake-sub"));
  });

  it("registerAllPluginRoutes is a no-op-safe loop over activated routes", async () => {
    writePlugin(configDir, "fake-sub");
    await loadInstalledPlugins({ configDir, log, getServer: () => undefined });
    const registered: string[] = [];
    const fakeApp = { get: (path: string) => registered.push(path) } as any;
    registerAllPluginRoutes(fakeApp);
    expect(registered).toEqual(["/api/fake-sub/ping"]);
  });

  it("plugin error helpers mark and carry the taxonomy", () => {
    const error = pluginErrorFrom("fake-sub", { code: "fake_quota", message: "quota", httpStatus: 429, cooldownMs: 60000 });
    expect(isPluginClassifiedError(error)).toBe(true);
    expect((error as any).statusCode).toBe(429);
    expect((error as any).nonRetryable).toBe(true);
    expect(isPluginClassifiedError(new Error("x"))).toBe(false);
  });
});
