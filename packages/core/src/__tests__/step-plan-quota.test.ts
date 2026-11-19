import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAdminRoutes } from "../ccr/admin-routes";
import { readConfigFile } from "../ccr/config";
import { getHealthStore } from "../services/provider-health";
import { getQuotaAdapter } from "../services/quota-adapters";
import { StepPlanQuotaCache } from "../services/step-plan-quota";
import { getProxyDispatcher } from "../services/proxy";

vi.mock("../ccr/config", async importOriginal => ({
  ...await importOriginal<typeof import("../ccr/config")>(), readConfigFile: vi.fn(),
}));

const proxyFetch = vi.hoisted(() => vi.fn());
vi.mock("undici", async load => ({ ...await load<typeof import("undici")>(), fetch: proxyFetch }));

const base = "https://api.stepfun.com/step_plan/v1";
const provider = { name: "sample", api_key: "fixture-key", api_base_url: `${base}/chat/completions` };
const unavailable = { state: "unavailable", family: "none", observedAt: null, name: null, allowed: null, windows: [], creditBuckets: [] };
const direct = { get: () => undefined };
const now = 1_800_000_000_000;
const bucket = { type: "subscription", total: "9007199254740993.125", remaining: "0", used_percent: 100, expires_at_ms: now + 8000, resets_at_ms: null };
const token = {
  schema_version: 1, scope: "personal_account", observed_at_ms: now, account: { id: "account-marker" },
  plan: { name: "Example", state: "known", family: "token", subscription: { id: "subscription-marker" } },
  quota: { state: "known", allowed: true, reason: "private-marker", windows: [], credit_buckets: [
    bucket,
    { ...bucket, type: "topup", total: "7.00", remaining: "7.00", used_percent: 0, expires_at_ms: now + 2000 },
    { ...bucket, type: "topup", total: "3", remaining: "1", used_percent: null, expires_at_ms: now + 40_000 },
  ] },
};
const coding = {
  ...token, plan: { name: null, state: "known", family: "coding" },
  quota: { state: "known", allowed: false, windows: [
    { id: "five_hour", limited: true, used_percent: 0, resets_at_ms: now + 125_000 },
    { id: "weekly", limited: false, used_percent: null, resets_at_ms: null },
  ], credit_buckets: [] },
};

describe("Step Plan display quota", () => {
  let cache: StepPlanQuotaCache;
  const upstream = vi.fn<typeof fetch>();
  const read = async () => (await cache.poll([provider], direct)).get(provider.name);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    vi.stubGlobal("fetch", upstream.mockReset());
    proxyFetch.mockReset();
    cache = new StepPlanQuotaCache();
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("serves exact account figures through the admin route without changing model circuits", async () => {
    const app = Fastify();
    vi.mocked(readConfigFile).mockResolvedValue({ Providers: [provider] });
    const health = getHealthStore();
    health.forceOpen(provider.name, "open-model", "fixture failure");
    const openState = { ...health.getState(provider.name, "open-model") };
    try {
      await registerAdminRoutes({ app, pluginRegistry: { registerAllRoutes: () => {} } }, {});
      const getRow = async () => {
        const res = await app.inject({ method: "GET", url: "/api/providers/quota" });
        expect(res.statusCode).toBe(200);
        expect(res.body).not.toMatch(/account-marker|subscription-marker|private-marker|fixture-key/);
        return res.json().quotas.find((q: any) => q.provider === provider.name);
      };
      upstream.mockResolvedValueOnce(Response.json(token));
      expect((await getRow()).stepPlan).toEqual({
        state: "known", family: "token", name: "Example", allowed: true, observedAt: now, windows: [],
        creditBuckets: [
          { type: "subscription", total: "9007199254740993.125", remaining: "0", usedPercent: 100, resetsAt: null, expiresAt: now + 8000 },
          { type: "topup", total: "7.00", remaining: "7.00", usedPercent: 0, resetsAt: null, expiresAt: now + 2000 },
          { type: "topup", total: "3", remaining: "1", usedPercent: null, resetsAt: null, expiresAt: now + 40_000 },
        ],
      });
      const [url, options] = upstream.mock.calls[0];
      expect(url).toBe(`${base}/usage`);
      expect(options).toEqual({ method: "GET", redirect: "error", signal: expect.any(AbortSignal),
        headers: { Authorization: `Bearer ${provider.api_key}`, Accept: "application/json", "Accept-Encoding": "identity" } });
      vi.setSystemTime(now + 60_000);
      upstream.mockResolvedValueOnce(Response.json(coding));
      expect((await getRow()).stepPlan).toEqual({
        state: "known", family: "coding", name: null, allowed: false, observedAt: now, creditBuckets: [],
        windows: [{ id: "five_hour", limited: true, usedPercent: 0, resetsAt: now + 125_000 },
          { id: "weekly", limited: false, usedPercent: null, resetsAt: null }],
      });
      expect(getQuotaAdapter(provider.api_base_url)).toBeNull();
      expect(health.getState(provider.name, "open-model")).toEqual(openState);
      expect(health.getState(provider.name, "healthy-model")).toBeUndefined();
    } finally {
      health.recover(provider.name, "open-model");
      await app.close();
    }
  });

  it("drops expired and reset credit buckets during the cache TTL", async () => {
    upstream.mockResolvedValueOnce(Response.json(token));
    expect((await read())?.creditBuckets).toHaveLength(3);
    vi.setSystemTime(now + 2000);
    expect(await read()).toMatchObject({ state: "partial", allowed: null, creditBuckets: [
      { type: "subscription" }, { type: "topup", total: "3" },
    ] });
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("starts Step Plan while managed quota polling is still pending", async () => {
    const app = Fastify();
    vi.mocked(readConfigFile).mockResolvedValue({ Providers: [provider] });
    let completePlugin!: () => void;
    const managed = { name: "parallel-plugin" };
    const pluginRegistry = {
      registerAllRoutes: () => {},
      getManagedRuntimeFor: () => ({ fetchQuota: () => new Promise(resolve => {
        completePlugin = () => resolve(null);
      }) }),
    };
    Object.assign(app, { _server: { pluginRegistry, providerService: { getProviders: () => [managed] } } });
    try {
      await registerAdminRoutes({ app, pluginRegistry }, {});
      upstream.mockImplementationOnce(async () => {
        queueMicrotask(() => completePlugin());
        return Response.json(token);
      });
      const started = performance.now();
      const result = await app.inject({ method: "GET", url: "/api/providers/quota" });
      expect(performance.now() - started).toBeLessThan(2000);
      expect(result.statusCode).toBe(200);
      expect(result.json().quotas[0].stepPlan.family).toBe("token");
    } finally {
      await app.close();
    }
  });

  it("omits a completed Step Plan read if credentials rotate while the route waits for a plugin", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const app = Fastify();
    const poll = vi.spyOn(StepPlanQuotaCache.prototype, "poll");
    let startPlugin!: () => void;
    let finishPlugin!: () => void;
    const pluginStarted = new Promise<void>(resolve => { startPlugin = resolve; });
    const pluginPending = new Promise<null>(resolve => { finishPlugin = () => resolve(null); });
    const pluginRegistry = {
      registerAllRoutes: () => {},
      getManagedRuntimeFor: () => ({ fetchQuota: () => { startPlugin(); return pluginPending; } }),
    };
    const getProviders = vi.fn().mockReturnValueOnce([{ name: "held-plugin" }]).mockReturnValue([]);
    Object.assign(app, { _server: { pluginRegistry, providerService: { getProviders } } });
    vi.mocked(readConfigFile)
      .mockResolvedValueOnce({ Providers: [provider] })
      .mockResolvedValueOnce({ Providers: [{ ...provider, api_key: "replacement-fixture" }] });
    upstream.mockResolvedValueOnce(Response.json(token)).mockResolvedValueOnce(Response.json(coding));
    try {
      await registerAdminRoutes({ app, pluginRegistry }, {});
      const first = app.inject().get("/api/providers/quota").end();
      await pluginStarted;
      await poll.mock.results[0].value;

      const rotated = await app.inject({ method: "GET", url: "/api/providers/quota" });
      expect(rotated.statusCode).toBe(200);
      expect(rotated.json().quotas.find((q: any) => q.provider === provider.name).stepPlan.family).toBe("coding");
      finishPlugin();
      const initial = await first;
      expect(initial.statusCode).toBe(200);
      const row = initial.json().quotas.find((q: any) => q.provider === provider.name);
      expect(row).toBeDefined();
      expect(row).not.toHaveProperty("stepPlan");
    } finally {
      finishPlugin();
      poll.mockRestore();
      await app.close();
    }
  });

  it("limits requests to enabled CN inference endpoints", async () => {
    for (const url of [base.replace("https:", "http:"), base.replace(".com", ".example"), base.replace(".com", ".com.example"),
      base.replace(".com", ".com:8443"), base.replace("//", "//user@"), base.replace("/step_plan", ""), `${base}_other`,
      `${base}/usage`, `${base}/arbitrary`, `${base}?query=1`, `${base}#fragment`]) {
      expect((await cache.poll([{ ...provider, api_base_url: url }], direct)).get(provider.name)).toBeUndefined();
    }
    await cache.poll([{ ...provider, enabled: false }], direct);
    expect(upstream).not.toHaveBeenCalled();
    for (const api_base_url of [base, `${base}/`, provider.api_base_url]) {
      upstream.mockResolvedValueOnce(Response.json(token));
      expect((await cache.poll([{ ...provider, api_base_url }], direct)).get(provider.name)?.family).toBe("token");
    }
  });

  it("uses the provider's proxy opt-in policy", async () => {
    const proxy = "http://proxy.example:8080";
    const settings: Record<string, any> = { PROXY_URL: proxy, PROXY_GLOBAL_ENABLED: false };
    const config = { get: (key: string) => settings[key] };
    upstream.mockImplementation(async () => Response.json(token));
    await cache.poll([provider], config);
    expect(upstream.mock.calls[0][1]).not.toHaveProperty("dispatcher");
    proxyFetch.mockResolvedValueOnce(Response.json(token));
    expect((await cache.poll([{ ...provider, proxy_enabled: true }], config)).get(provider.name)?.family).toBe("token");
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(proxyFetch).toHaveBeenCalledWith(`${base}/usage`, expect.objectContaining({ dispatcher: getProxyDispatcher(proxy) }));
  });

  it("coalesces concurrent requests, reuses the settled result, and invalidates old in-flight identities", async () => {
    let finish!: (res: Response) => void;
    upstream.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = read();
    const second = read();
    expect(upstream).toHaveBeenCalledTimes(1);
    upstream.mockResolvedValueOnce(Response.json(coding));
    const changed = { ...provider, api_key: "replacement-fixture" };
    expect((await cache.poll([changed], direct)).get(provider.name)?.family).toBe("coding");
    finish(Response.json(token));
    expect(await first).toBeUndefined();
    expect(await second).toBeUndefined();
    expect((await cache.poll([changed], direct)).get(provider.name)?.family).toBe("coding");
    expect(upstream).toHaveBeenCalledTimes(2);
    await cache.poll([], direct);
    upstream.mockRejectedValueOnce(new Error());
    expect((await cache.poll([changed], direct)).get(provider.name)).toEqual(unavailable);
  });

  it.each([401, 403])("clears all account fields after HTTP %i", async status => {
    upstream.mockResolvedValueOnce(Response.json(token));
    await read();
    vi.setSystemTime(now + 60_000);
    upstream.mockResolvedValueOnce(new Response(null, { status }));
    expect(await read()).toEqual(unavailable);
    vi.setSystemTime(now + 120_000);
    upstream.mockRejectedValueOnce(new Error());
    expect(await read()).toEqual(unavailable);
  });

  it.each(["120", new Date(now + 180_000).toUTCString(), "99999999"])("bounds stale retention and honors Retry-After %s", async retryAfter => {
    upstream.mockResolvedValueOnce(Response.json(token));
    await read();
    vi.setSystemTime(now + 60_000);
    upstream.mockResolvedValueOnce(new Response(null, { status: 429, headers: { "Retry-After": retryAfter } }));
    expect(await read()).toMatchObject({ state: "stale", observedAt: now, creditBuckets: expect.any(Array) });
    const capped = retryAfter === "99999999";
    const retryAt = now + 60_000 + (capped ? 900_000 : 120_000);
    vi.setSystemTime(retryAt - 1);
    expect((await read())?.state).toBe(capped ? "unavailable" : "stale");
    expect(upstream).toHaveBeenCalledTimes(2);
    vi.setSystemTime(retryAt);
    upstream.mockResolvedValueOnce(Response.json(coding));
    expect((await read())?.family).toBe("coding");
  });

  it("aborts slow reads within the route deadline and serves the last observation as stale", async () => {
    upstream.mockResolvedValueOnce(Response.json(token));
    await read();
    vi.setSystemTime(now + 60_000);
    upstream.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", reject, { once: true });
    }));
    expect(await read()).toMatchObject({ state: "stale", observedAt: now });
  }, 4000);

  it("replaces prior buckets on partial or unsupported data and never coerces amounts", async () => {
    upstream.mockResolvedValueOnce(Response.json(token));
    await read();
    for (const credit_buckets of [null, [{ ...bucket, total: 15 }], [{ ...bucket, type: "other" }]]) {
      vi.setSystemTime(Date.now() + 60_000);
      upstream.mockResolvedValueOnce(Response.json({ ...token, quota: { ...token.quota, state: "partial", credit_buckets } }));
      expect(await read()).toMatchObject({ state: "partial", creditBuckets: [] });
    }
    vi.setSystemTime(Date.now() + 60_000);
    upstream.mockResolvedValueOnce(Response.json({ ...token, schema_version: 2 }));
    expect(await read()).toEqual(unavailable);
  });
});
