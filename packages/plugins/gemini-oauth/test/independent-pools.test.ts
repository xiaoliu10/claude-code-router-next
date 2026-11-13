import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GeminiOauthAuthService, GeminiOauthCredentialStore, normalizeGeminiOauthData, type GeminiOauthCredentialData } from "../src/auth-service";
import { classifyGeminiOauthError, type GeminiOauthFetch } from "../src/protocol";
import { geminiOauthPoolHasQuota, geminiOauthQuotaPool } from "../src/quota-pools";
import { GeminiOauthTransformer } from "../src/transformer";
import { activate } from "../src/plugin";

const dirs: string[] = [];
const ARGON = "gemini-4-argon";
const HYDROGEN = "gemini-4-hydrogen";
const CLAUDE = "claude-sonnet-4-6";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const credential = (): GeminiOauthCredentialData => ({
  version: 2, kind: "antigravity", account: {
    email: "fixture@example.invalid", refreshToken: "fixture-refresh", projectId: "fixture-project", tier: "fixture-tier",
    importedAt: "2026-01-01T00:00:00.000Z", lastError: null, cooldownUntil: null,
  },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.stubEnv("GEMINI_OAUTH_CLIENT_ID", "fixture-id");
  vi.stubEnv("GEMINI_OAUTH_CLIENT_SECRET", "fixture-secret");
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network disabled"); }));
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function harness(fetchImpl?: GeminiOauthFetch, seed = credential()) {
  const dir = await fs.mkdtemp(join(tmpdir(), "gemini-pools-")); dirs.push(dir);
  const store = new GeminiOauthCredentialStore(join(dir, "gemini-oauth-credentials.json"));
  await store.save(seed);
  const dispatcher = { fixture: "subscription-dispatcher" };
  const host = {
    configDir: dir,
    readRawConfig: async () => ({}), readConfig: async () => ({}), writeConfig: async () => {}, reloadRuntime: async () => {},
    getDirectDispatcher: () => dispatcher,
  };
  const options = { store, host, fetch: fetchImpl, logger: { warn() {}, error() {} } };
  const service = new GeminiOauthAuthService(options);
  return { dir, store, host, options, service, dispatcher };
}
const quotaError = () => classifyGeminiOauthError({ status: 429 });

async function runtimeHarness(seed = credential()) {
  const h = await harness(undefined, seed);
  let runtime: any;
  let Transformer: any;
  await activate({ host: h.host, log: { info() {}, warn() {}, error() {} }, registerManagedRuntime: (r: any) => { runtime = r; },
    registerTransformer: (t: any) => { Transformer = t; }, registerAdminRoutes() {}, registerConfigProtector() {}, registerUiCard() {}, registerLocales() {} } as any);
  return { ...h, runtime, Transformer };
}

describe("independent quota pool locks", () => {
  it("folds effort variants, preserves unknown families and never conflates Argon with Gemini or Hydrogen", () => {
    expect(geminiOauthQuotaPool(" GEMINI-4-ARGON-HIGH ")).toBe(ARGON);
    expect(geminiOauthQuotaPool(`${HYDROGEN}-low`)).toBe(HYDROGEN);
    expect(geminiOauthQuotaPool("claude-opus-4-6-thinking")).toBe("claude");
    expect(geminiOauthQuotaPool("gemini-4-high")).toBe("gemini-4");
    expect(geminiOauthQuotaPool("future-model-medium")).toBe("future-model");
    expect(geminiOauthQuotaPool("future-other-high")).toBe("future-other");
    expect(geminiOauthQuotaPool("gemini-4-argon-other-high")).toBe("gemini-4-argon-other");
    expect(geminiOauthQuotaPool(" ")).toBe("");
    expect(geminiOauthQuotaPool("bad,model")).toBe("");
  });

  it("any positive sibling bucket is headroom evidence; only zeroed buckets stay unproven", () => {
    expect(geminiOauthPoolHasQuota({ models: { [ARGON]: { remaining: 0 }, [`${ARGON}-high`]: { remaining: 0.5 } }, pools: [] }, ARGON)).toBe(true);
    expect(geminiOauthPoolHasQuota({ models: { [ARGON]: { remaining: 0 } }, pools: [] }, ARGON)).toBe(false);
    expect(geminiOauthPoolHasQuota({ models: {}, pools: [] }, ARGON)).toBe(false);
  });

  it.each([ARGON, HYDROGEN, CLAUDE, "future-model"])("parks only %s and its effort siblings across restart, then expires", async (model) => {
    const h = await harness();
    await h.service.noteUpstreamError(quotaError(), `${model}-high`);
    const lock = await h.service.getPoolCooldown(`${model}-low`);
    expect(lock).toEqual({ pool: geminiOauthQuotaPool(model), until: expect.any(Number) });
    expect(await h.service.isAccountCooling(model)).toBe(false);
    for (const sibling of [ARGON, HYDROGEN, CLAUDE, "future-model"].filter((m) => m !== model)) {
      expect(await h.service.getPoolCooldown(sibling)).toBeNull();
    }
    const reloaded = new GeminiOauthAuthService(h.options);
    expect(await reloaded.getPoolCooldown(model)).toEqual(lock);
    vi.spyOn(Date, "now").mockReturnValue(lock!.until + 1);
    expect(await reloaded.getPoolCooldown(model)).toBeNull();
  });

  it("retains fresh own-pool and sibling locks when older concurrent successes complete", async () => {
    const h = await harness();
    const oldRequest = await h.service.captureRequestIdentity();
    await h.service.noteUpstreamError(quotaError(), ARGON);
    await h.service.noteUpstreamError(quotaError(), HYDROGEN);
    const before = (await h.store.load())!.poolLocks;
    await Promise.all([h.service.noteRequestSuccess(ARGON, oldRequest), h.service.noteRequestSuccess(HYDROGEN, oldRequest), h.service.noteRequestSuccess(CLAUDE)]);
    expect((await h.store.load())!.poolLocks).toEqual(before);
    await h.service.noteUpstreamError({ ...quotaError(), cooldownMs: 1 }, ARGON);
    expect((await h.store.load())!.poolLocks?.[ARGON]).toBe(before![ARGON]);
  });

  it("unknown-model quota errors and gate rejections never invent an account lock or a bogus pool key", async () => {
    const h = await harness();
    await h.service.noteUpstreamError(quotaError());
    await h.service.noteUpstreamError(quotaError(), "   ");
    await h.service.noteUpstreamError({ ...quotaError(), code: "gemini_oauth_pool_cooling" }, ARGON);
    await h.service.noteUpstreamError({ ...quotaError(), code: "gemini_oauth_account_cooling" });
    const stored = await h.store.load();
    expect(await h.service.isAccountCooling()).toBe(false);
    expect(await h.service.getPoolCooldown(ARGON)).toBeNull();
    expect(stored.poolLocks ?? {}).toEqual({});
    expect(Object.keys(stored.poolLocks ?? {})).not.toContain("undefined");
    expect(stored.account.lastError).toBeNull();
    expect(stored.account.cooldownUntil).toBeNull();
    for (const model of [ARGON, HYDROGEN, CLAUDE]) expect(await h.service.getPoolCooldown(model)).toBeNull();
  });

  it.each([401, 403, 429])("account guard %s survives sibling success and quota refusal", async (status) => {
    const h = await harness();
    const info = status === 403
      ? classifyGeminiOauthError({ status, body: { error: { message: "verify your account" } } })
      : classifyGeminiOauthError({ status, message: "Resource has been exhausted", systemText: "x-anthropic-billing-header: fixture" });
    await h.service.noteUpstreamError(info, ARGON);
    await h.service.noteRequestSuccess(HYDROGEN);
    await h.service.noteUpstreamError(quotaError(), HYDROGEN);
    for (const model of [ARGON, HYDROGEN, CLAUDE]) expect(await h.service.isAccountCooling(model)).toBe(true);
    expect((await h.store.load())!.account.lastError?.code).toBe(info.code);
  });

  it("ignores unattributable legacy quota account locks for known-model gates", async () => {
    const seed = credential(); seed.account.lastError = { code: "gemini_oauth_quota_exceeded" }; seed.account.cooldownUntil = Date.now() + 600_000;
    const h = await runtimeHarness(seed);
    await expect(h.runtime.ensureUsable({ model: HYDROGEN })).resolves.toBeUndefined();
    await expect(h.runtime.ensureUsable()).rejects.toMatchObject({ code: "gemini_oauth_account_cooling" });
    expect(await h.runtime.probeAccountState({ model: ARGON })).toEqual({ available: true });
  });

  it("normalizes and bounds persisted advisory locks without losing valid credentials", () => {
    const raw = { ...credential(), poolLocks: { " GEMINI-4-ARGON-HIGH ": Date.now() + 500_000, [HYDROGEN]: "bad", "bad,model": Date.now(), ...Object.fromEntries(Array.from({ length: 80 }, (_, n) => [`future-${n}`, Date.now() + n])) } };
    const data = normalizeGeminiOauthData(raw);
    expect(Object.keys(data.poolLocks!)).toHaveLength(64);
    expect(data.poolLocks?.[ARGON]).toBeGreaterThan(Date.now());
    expect(data.poolLocks?.[HYDROGEN]).toBeUndefined();
    expect(data.account).toEqual(raw.account);
  });

  it("drops old-account errors and successes after disconnect and account replacement", async () => {
    const h = await harness();
    const identity = await h.service.captureRequestIdentity();
    await h.service.disconnect();
    const next = credential(); next.account.email = "other@example.invalid";
    await h.store.save(next);
    await h.service.noteUpstreamError(quotaError(), ARGON, identity);
    await h.service.noteUpstreamError(classifyGeminiOauthError({ status: 401 }), HYDROGEN, identity);
    await h.service.noteRequestSuccess(HYDROGEN, identity);
    expect((await h.store.load())!.poolLocks).toBeUndefined();
    expect((await h.store.load())!.account.lastError).toBeNull();
  });
});

describe("shared service quota cache", () => {
  it("single-flights concurrent reads, honors subscription dispatcher, caches until TTL or a written pool lock", async () => {
    const gate = deferred<Response>();
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      expect(init.dispatcher).toBe(h.dispatcher);
      if (url.includes("/token")) return json({ access_token: "fixture-access", expires_in: 3600 });
      if (url.endsWith(":retrieveUserQuota")) return gate.promise;
      return json({ groups: [{ displayName: "GEMINI 4 ARGON", buckets: [{ window: "weekly", remainingFraction: 0.3 }] }] });
    });
    const h = await harness(fetchImpl);
    const reads = [h.service.getQuota(), h.service.getQuota(), h.service.getQuota()];
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    gate.resolve(json({ buckets: [{ modelId: ARGON, remainingFraction: 0 }] }));
    const snapshots = await Promise.all(reads);
    expect(snapshots[0]).toEqual({ models: { [ARGON]: { remaining: 0 } }, pools: [{ pool: "GEMINI 4 ARGON", window: "weekly", remaining: 0.3 }] });
    expect(snapshots[1]).toEqual(snapshots[0]);
    await h.service.noteUpstreamError(quotaError(), ARGON);
    // A written pool lock invalidates the cached snapshot: the park is exactly
    // the event that makes the pre-park figures stale (+2 = bucket + summary;
    // the token stays cached).
    await h.service.getQuota();
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_001);
    await h.service.getQuota();
    expect(fetchImpl).toHaveBeenCalledTimes(7);
  });

  it("caches null failures and guards auth/verification parks without refreshing a token", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("fixture failure"); });
    const h = await harness(fetchImpl);
    expect(await h.service.getQuota()).toBeNull();
    expect(await h.service.getQuota()).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await h.service.noteUpstreamError(classifyGeminiOauthError({ status: 401 }));
    expect(await h.service.getQuota()).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("permits quota reads through legacy quota-only parks", async () => {
    const seed = credential(); seed.account.lastError = { code: "gemini_oauth_quota_exceeded" }; seed.account.cooldownUntil = Date.now() + 600_000;
    const fetchImpl = vi.fn(async (url: string) => url.includes("/token") ? json({ access_token: "fixture-access", expires_in: 3600 }) : json({ buckets: [{ modelId: HYDROGEN, remainingFraction: 0.7 }] }));
    const h = await harness(fetchImpl, seed);
    expect((await h.service.getQuota())?.models[HYDROGEN].remaining).toBe(0.7);
  });

  it("drops an in-flight old-account snapshot and does not poison the next account cache", async () => {
    const gate = deferred<Response>();
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/token")) return json({ access_token: "fixture-access", expires_in: 3600 });
      if (url.endsWith(":retrieveUserQuota")) { await gate.promise; return json({ buckets: [{ modelId: ARGON, remainingFraction: 0.8 }] }); }
      return json({ groups: [] });
    });
    const h = await harness(fetchImpl);
    const read = h.service.getQuota();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    await h.service.disconnect();
    const next = credential(); next.account.email = "next@example.invalid"; await h.store.save(next);
    gate.resolve(json({ buckets: [{ modelId: ARGON, remainingFraction: 0.8 }] }));
    expect(await read).toBeNull();
    expect((await h.service.getQuota())?.models[ARGON].remaining).toBe(0.8);
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it("drops an in-flight snapshot when verification parks the same account", async () => {
    const gate = deferred<Response>();
    const fetchImpl = vi.fn(async (url: string) => url.includes("/token") ? json({ access_token: "fixture-access", expires_in: 3600 }) : url.endsWith(":retrieveUserQuota") ? gate.promise : json({ groups: [] }));
    const h = await harness(fetchImpl);
    const read = h.service.getQuota();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    await h.service.noteUpstreamError(classifyGeminiOauthError({ status: 403, message: "verify your account" }));
    gate.resolve(json({ buckets: [{ modelId: ARGON, remainingFraction: 0.8 }] }));
    expect(await read).toBeNull();
    expect(await h.service.getQuota()).toBeNull();
  });
});

describe("runtime model gates and recovery evidence", () => {
  it("checks pool before token refresh and checks account before pool", async () => {
    const h = await runtimeHarness();
    await h.runtime.noteUpstreamError(quotaError(), { model: `${ARGON}-high` });
    expect(h.runtime.modelScopedRecovery).toBe(true);
    await expect(h.runtime.ensureUsable({ model: `${ARGON}-low`, requestState: {} })).rejects.toMatchObject({ code: "gemini_oauth_pool_cooling", statusCode: 429 });
    await expect(h.runtime.ensureUsable({ model: HYDROGEN })).resolves.toBeUndefined();
    expect(await h.runtime.probeAccountState({ model: ARGON })).toMatchObject({ available: false, reason: "pool_cooling", parkedUntil: expect.any(Number) });
    await h.runtime.noteUpstreamError(classifyGeminiOauthError({ status: 401 }), { model: HYDROGEN });
    await expect(h.runtime.ensureUsable({ model: ARGON })).rejects.toMatchObject({ code: "gemini_oauth_account_cooling", statusCode: 401 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("never overwrites the first-gate identity after an account switch, and drops old HTTP errors", async () => {
    const h = await runtimeHarness();
    const context = { model: ARGON, requestState: {} };
    await h.runtime.ensureUsable(context);
    // Use the activated transformer's injected service to disconnect it.
    const transformer = new h.Transformer();
    const service = (transformer as any).resolveAuthService() as GeminiOauthAuthService;
    await service.disconnect();
    const next = credential(); next.account.importedAt = "2026-02-01T00:00:00.000Z"; await h.store.save(next);
    await expect(h.runtime.ensureUsable(context)).rejects.toMatchObject({ statusCode: 401 });
    await h.runtime.noteUpstreamError(quotaError(), context);
    expect((await h.store.load())!.poolLocks).toBeUndefined();
  });

  it("requires positive quota for the queried pool; summary/model-list success is insufficient", async () => {
    expect(geminiOauthPoolHasQuota({ models: { [HYDROGEN]: { remaining: 1 } }, pools: [] }, ARGON)).toBe(false);
    expect(geminiOauthPoolHasQuota({ models: { [ARGON]: { remaining: 0 } }, pools: [{ pool: "Gemini Models", window: "weekly", remaining: 1 }] }, ARGON)).toBe(false);
    const h = await runtimeHarness();
    const service = (new h.Transformer() as any).resolveAuthService() as GeminiOauthAuthService;
    const quota = vi.spyOn(service, "getQuota").mockResolvedValue({ models: { [ARGON]: { remaining: 0 }, [HYDROGEN]: { remaining: 0.8 } }, pools: [] });
    expect((await h.runtime.probeLiveness({ model: ARGON })).status).toBe(503);
    expect((await h.runtime.probeLiveness({ model: HYDROGEN })).status).toBe(200);
    expect((await h.runtime.probeLiveness({ model: CLAUDE })).status).toBe(503);
    quota.mockResolvedValue(null);
    expect((await h.runtime.probeLiveness({ model: HYDROGEN })).status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
  });
});

const chunk = { response: { candidates: [{ content: { parts: [{ text: "fixture output" }] } }] } };
const errorFrame = { error: { message: "Resource has been exhausted" } };
const sse = (frames: unknown[]) => new Response(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });

describe("request-local transformer attribution", () => {
  it.each(["json", "first", "mid-stream", "aggregate"])("attributes concurrent %s errors to their dispatched pool", async (lane) => {
    const h = await harness();
    vi.spyOn(h.service, "getAccessToken").mockResolvedValue("fixture-access");
    const transformer = new GeminiOauthTransformer({ authService: h.service });
    const argon: any = { req: { body: { stream: lane !== "aggregate" } } };
    const hydrogen: any = { req: { body: { stream: false } } };
    await Promise.all([
      transformer.transformRequestIn({ model: `${ARGON}-high`, messages: [{ role: "user", content: "fixture" }] }, {}, argon),
      transformer.transformRequestIn({ model: HYDROGEN, messages: [{ role: "user", content: "fixture" }] }, {}, hydrogen),
    ]);
    const failedResponse = lane === "json" ? json(errorFrame) : sse(lane === "first" ? [errorFrame] : [chunk, errorFrame]);
    const failed = (async () => {
      const response = await transformer.transformResponseOut(failedResponse, argon);
      await response.text();
    })();
    const healthy = await transformer.transformResponseOut(sse([chunk]), hydrogen);
    expect((await healthy.json() as any).choices[0].message.content).toBe("fixture output");
    await expect(failed).rejects.toBeDefined();
    await vi.waitFor(async () => expect(await h.service.getPoolCooldown(ARGON)).not.toBeNull());
    expect(await h.service.getPoolCooldown(HYDROGEN)).toBeNull();
    expect(await h.service.isAccountCooling()).toBe(false);
  });

  it("retains request system identity markers for first-frame hidden account errors", async () => {
    const h = await harness(); vi.spyOn(h.service, "getAccessToken").mockResolvedValue("fixture-access");
    const transformer = new GeminiOauthTransformer({ authService: h.service });
    const context: any = {};
    await transformer.transformRequestIn({ model: ARGON, messages: [{ role: "system", content: "x-anthropic-billing-header: fixture" }] }, {}, context);
    await expect(transformer.transformResponseOut(sse([errorFrame]), context)).rejects.toMatchObject({ code: "gemini_oauth_identity_blocked" });
    await vi.waitFor(async () => expect(await h.service.isAccountCooling(HYDROGEN)).toBe(true));
    expect(await h.service.getPoolCooldown(ARGON)).toBeNull();
  });
});
