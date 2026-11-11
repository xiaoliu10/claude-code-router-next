import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Server from "../server";
import { registerAdminRoutes } from "../ccr/admin-routes";
import { loadInstalledPlugins } from "../provider-plugins/loader";
import { ActiveProbeService } from "../services/active-probe";
import { clearQuotaStore, getAllQuotaResults, storeQuotaResult } from "../services/quota-store";
import {
  hasFreshPluginQuota,
  pollPluginQuota,
  resetPluginQuotaCache,
} from "../services/plugin-quota";

/**
 * The managed-runtime fetchQuota seam: figures returned by a plugin runtime
 * must reach /api/providers/quota through the SAME quota store and 5h/7d
 * mapping as the built-in adapters, with a per-provider 60s TTL so UI refreshes
 * cannot turn into upstream request storms.
 */

const log = { info() {}, warn() {}, error() {} };

// Minimal plugin entry: one managed runtime whose fetchQuota reports whatever
// the test parked on globalThis and counts every invocation. isManaged accepts
// both provider shapes (camelCase LLMProvider and snake_case config entry),
// exactly like the real gemini-oauth runtime detection does.
const PLUGIN_ENTRY = `
const runtime = {
  name: "fake-quota",
  isManaged: (p) => p?.apiKey === "ccr-managed-fake-quota" || p?.api_key === "ccr-managed-fake-quota",
  signRequest: async ({ headers }) => headers,
  fetchQuota: async () => {
    globalThis.__quotaCalls = (globalThis.__quotaCalls || 0) + 1;
    if (globalThis.__quotaThrow) throw new Error("upstream quota boom");
    if (globalThis.__quotaHang) return new Promise(() => {});
    return globalThis.__quotaFigures ?? null;
  },
};
async function activate(ctx) {
  ctx.registerManagedRuntime(runtime);
}
module.exports = { activate };
module.exports.default = { activate };
`;

const FUTURE_ISO = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const FUTURE_ISO_7D = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

const FULL_FIGURES = {
  usedDailyBalance: 30,
  limitDaily: 100,
  resetTime: FUTURE_ISO,
  usedBalance: 12.5,
  totalBalance: 50,
  resetTime7d: FUTURE_ISO_7D,
  currency: "USD",
};

function writePlugin(configDir: string) {
  const dir = join(configDir, "plugins", "fake-quota");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(configDir, "plugins", "plugins.json"),
    JSON.stringify([{ name: "fake-quota", enabled: true }])
  );
  writeFileSync(
    join(dir, "plugin.json"),
    JSON.stringify({ name: "fake-quota", version: "1.0.0", coreApi: "1" })
  );
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "commonjs" }));
  writeFileSync(join(dir, "plugin.js"), PLUGIN_ENTRY);
}

const { readConfigFileMock } = vi.hoisted(() => ({
  readConfigFileMock: vi.fn(),
}));

vi.mock("../ccr/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ccr/config")>();
  return { ...actual, readConfigFile: readConfigFileMock };
});

async function buildAdminRuntime(configDir: string) {
  const config = {
    PORT: 0,
    APIKEY: "secret",
    Providers: [
      {
        name: "fake-sub",
        api_base_url: "https://fake-quota.example/v1/messages",
        api_key: "ccr-managed-fake-quota",
        models: ["m1"],
      },
    ],
    Router: {},
  };

  const server: any = new Server({
    logger: false,
    useJsonFile: false,
    initialConfig: {
      providers: config.Providers,
      Router: {},
      HOST: "127.0.0.1",
      PORT: 0,
      ACTIVE_PROBE_ENABLED: false,
    },
  });
  await server.ready();
  await registerAdminRoutes(server, config);
  await server.registerNamespace("/");
  await server.app.ready();

  const result = await loadInstalledPlugins({
    configDir,
    log,
    getServer: () => server,
  });
  expect(result.loaded).toEqual(["fake-quota"]);
  expect(result.failed).toEqual([]);

  readConfigFileMock.mockResolvedValue({ Providers: config.Providers, Router: {} });
  return { server };
}

describe("managed runtime fetchQuota seam", () => {
  let configDir: string;
  let server: Server;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "ccr-plugin-quota-"));
    writePlugin(configDir);
    resetPluginQuotaCache();
    clearQuotaStore();
    (globalThis as any).__quotaCalls = 0;
    (globalThis as any).__quotaFigures = FULL_FIGURES;
    (globalThis as any).__quotaThrow = false;
    readConfigFileMock.mockReset();
  });

  afterEach(async () => {
    await server?.app.close();
    rmSync(configDir, { recursive: true, force: true });
    resetPluginQuotaCache();
    clearQuotaStore();
    delete (globalThis as any).__quotaCalls;
    delete (globalThis as any).__quotaFigures;
    delete (globalThis as any).__quotaThrow;
    delete (globalThis as any).__quotaHang;
  });

  it("merges plugin figures into /api/providers/quota 5h and 7d slots", async () => {
    ({ server } = await buildAdminRuntime(configDir));

    const res = await server.app.inject({
      method: "GET",
      url: "/api/providers/quota",
    });
    expect(res.statusCode).toBe(200);
    expect((globalThis as any).__quotaCalls).toBe(1);

    const quota = res.json().quotas.find((q: any) => q.provider === "fake-sub");
    expect(quota).toBeDefined();
    // Daily figures map to the short (5h) window.
    expect(quota.used5h).toBe(30);
    expect(quota.limit5h).toBe(100);
    expect(quota.reset5h).toBe(FUTURE_ISO);
    expect(quota.type5h).toBe("rateLimit");
    // Balance figures map to the 7d window.
    expect(quota.used7d).toBe(12.5);
    expect(quota.limit7d).toBe(50);
    expect(quota.reset7d).toBe(FUTURE_ISO_7D);
    expect(quota.currency).toBe("USD");
    expect(quota.type7d).toBe("balance");
  });

  it("serves the second UI request from the 60s TTL cache without polling again", async () => {
    ({ server } = await buildAdminRuntime(configDir));

    const first = await server.app.inject({ method: "GET", url: "/api/providers/quota" });
    expect(first.statusCode).toBe(200);
    const second = await server.app.inject({ method: "GET", url: "/api/providers/quota" });
    expect(second.statusCode).toBe(200);

    expect((globalThis as any).__quotaCalls).toBe(1);
    // Figures stay served from the quota store even on the cached request.
    const quota = second.json().quotas.find((q: any) => q.provider === "fake-sub");
    expect(quota.used5h).toBe(30);

    // After the cache is dropped (e.g. TTL expiry) the next request polls again.
    resetPluginQuotaCache();
    const third = await server.app.inject({ method: "GET", url: "/api/providers/quota" });
    expect(third.statusCode).toBe(200);
    expect((globalThis as any).__quotaCalls).toBe(2);
  });

  it("degrades to no data when the seam returns null or rejects, without failing the route", async () => {
    ({ server } = await buildAdminRuntime(configDir));

    (globalThis as any).__quotaFigures = null;
    const nullRes = await server.app.inject({ method: "GET", url: "/api/providers/quota" });
    expect(nullRes.statusCode).toBe(200);
    const nullQuota = nullRes.json().quotas.find((q: any) => q.provider === "fake-sub");
    // computeProviderQuota still lists the provider, but no plugin figures
    // leaked into the limit/reset slots.
    expect(nullQuota).toBeDefined();
    expect(nullQuota.limit5h).toBeUndefined();
    expect(nullQuota.reset5h).toBeUndefined();
    expect(nullQuota.limit7d).toBeUndefined();

    resetPluginQuotaCache();
    (globalThis as any).__quotaThrow = true;
    const throwRes = await server.app.inject({ method: "GET", url: "/api/providers/quota" });
    expect(throwRes.statusCode).toBe(200);
    const throwQuota = throwRes.json().quotas.find((q: any) => q.provider === "fake-sub");
    expect(throwQuota.limit5h).toBeUndefined();
    expect(throwQuota.limit7d).toBeUndefined();
  });

  it("polls the seam from the active-probe quota loop into the shared store", async () => {
    ({ server } = await buildAdminRuntime(configDir));

    // LLMProvider-shaped entry, exactly what providerService.getProviders()
    // hands the probe loop in production.
    const managedProvider = {
      name: "fake-sub",
      baseUrl: "https://fake-quota.example/v1/messages",
      apiKey: "ccr-managed-fake-quota",
      models: ["m1"],
    };
    const runtime = server.pluginRegistry.getManagedRuntimeFor(managedProvider);
    expect(runtime?.fetchQuota).toBeTypeOf("function");

    const service = new ActiveProbeService(
      () => [managedProvider as any],
      { enabled: true, quotaProbeIntervalMinutes: 10 },
      undefined,
      log,
      undefined,
      () => runtime
    );

    // runQuotaProbe is private by design; the periodic timer calls it, the test
    // drives one tick directly.
    await (service as any).runQuotaProbe();

    const stored = getAllQuotaResults().find((q) => q.provider === "fake-sub");
    expect(stored).toBeDefined();
    expect(stored?.usedDailyBalance).toBe(30);
    expect(stored?.totalBalance).toBe(50);
    expect((globalThis as any).__quotaCalls).toBe(1);

    // A second tick inside the TTL must not poll again.
    await (service as any).runQuotaProbe();
    expect((globalThis as any).__quotaCalls).toBe(1);
  });

  it("serves stored figures within the inline budget when the seam hangs", async () => {
    ({ server } = await buildAdminRuntime(configDir));

    // Seed the store so the budget path has figures to serve while the poll
    // is still in flight.
    storeQuotaResult("fake-sub", FULL_FIGURES);
    (globalThis as any).__quotaHang = true;
    resetPluginQuotaCache();

    const started = Date.now();
    const res = await server.app.inject({ method: "GET", url: "/api/providers/quota" });
    const elapsed = Date.now() - started;
    expect(res.statusCode).toBe(200);
    // The route must not wait out a hung seam: inline budget plus margin.
    expect(elapsed).toBeLessThan(4_000);
    const quota = res.json().quotas.find((q: any) => q.provider === "fake-sub");
    expect(quota.used5h).toBe(FULL_FIGURES.usedDailyBalance);
  });
});

describe("plugin quota TTL cache (unit)", () => {
  const provider = { name: "p", apiKey: "ccr-managed-p" } as any;

  beforeEach(() => {
    resetPluginQuotaCache();
    clearQuotaStore();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    resetPluginQuotaCache();
    clearQuotaStore();
  });

  it("reports freshness only inside the TTL window and stores figures on success", async () => {
    const fetchQuota = vi.fn(async () => ({ usedDailyBalance: 1, limitDaily: 2 }));
    const runtime = { fetchQuota };

    await pollPluginQuota("p", provider, runtime);
    expect(hasFreshPluginQuota("p")).toBe(true);
    vi.advanceTimersByTime(59_999);
    expect(hasFreshPluginQuota("p")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(hasFreshPluginQuota("p")).toBe(false);
    expect(fetchQuota).toHaveBeenCalledTimes(1);

    // Fresh entry: no second upstream call even when polled again.
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    await pollPluginQuota("p", provider, runtime);
    expect(fetchQuota).toHaveBeenCalledTimes(1);

    // Expired entry: polls again.
    vi.advanceTimersByTime(60_000);
    await pollPluginQuota("p", provider, runtime);
    expect(fetchQuota).toHaveBeenCalledTimes(2);

    const stored = getAllQuotaResults().find((q) => q.provider === "p");
    expect(stored?.usedDailyBalance).toBe(1);
    expect(stored?.limitDaily).toBe(2);
  });

  it("coalesces concurrent polls and backs off after a rejection", async () => {
    let resolveQuota: (value: any) => void = () => {};
    const fetchQuota = vi.fn(
      () => new Promise<any>((resolve) => { resolveQuota = resolve; })
    );
    const runtime = { fetchQuota };

    const first = pollPluginQuota("p", provider, runtime);
    const second = pollPluginQuota("p", provider, runtime);
    resolveQuota({ usedBalance: 5 });
    await Promise.all([first, second]);

    // One upstream call served both callers.
    expect(fetchQuota).toHaveBeenCalledTimes(1);
    expect(hasFreshPluginQuota("p")).toBe(true);
    expect(getAllQuotaResults().find((q) => q.provider === "p")?.usedBalance).toBe(5);

    // A rejected seam still stamps the TTL and never throws to the caller.
    resetPluginQuotaCache();
    const failing = { fetchQuota: vi.fn(async () => Promise.reject(new Error("boom"))) };
    await expect(pollPluginQuota("p", provider, failing)).resolves.toBeUndefined();
    expect(hasFreshPluginQuota("p")).toBe(true);
    await pollPluginQuota("p", provider, failing);
    expect(failing.fetchQuota).toHaveBeenCalledTimes(1);
  });

  it("ignores runtimes without the seam and empty provider names", async () => {
    const fetchQuota = vi.fn(async () => null);
    await pollPluginQuota("p", provider, {});
    expect(fetchQuota).not.toHaveBeenCalled();
    await pollPluginQuota("", provider, { fetchQuota });
    expect(fetchQuota).not.toHaveBeenCalled();
    // A null result stamps the TTL (failure/no-data backoff) but stores nothing.
    await pollPluginQuota("p", provider, { fetchQuota });
    expect(fetchQuota).toHaveBeenCalledTimes(1);
    expect(getAllQuotaResults().find((q) => q.provider === "p")).toBeUndefined();
    expect(hasFreshPluginQuota("p")).toBe(true);
  });
});
