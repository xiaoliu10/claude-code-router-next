/**
 * Gemini OAuth model management (hide / restore) service behaviour:
 *  - the hide preference (UI / collapsed-family ids) lives in the 0600 file and
 *    is carried by every other write path (token rotation, error bookkeeping,
 *    load, re-login, sync);
 *  - hide removes the model from the managed provider and structurally cleans
 *    only its Router references (default / scenarios / aliases / family defaults
 *    / nested fallback), leaving unrelated providers and models untouched;
 *  - restore re-registers only models the account still exposes and never
 *    rewrites Router;
 *  - credential + config writes are serialized and roll back together.
 *
 * Google is always mocked; the 0600 file is real (temp dir). No network, no
 * real account.
 */
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GeminiOauthAuthService, GeminiOauthCredentialStore, normalizeGeminiOauthData,
  type GeminiOauthCredentialData,
} from "../src/auth-service";
import {
  GEMINI_OAUTH_DATA_PLANE, classifyGeminiOauthError, clearGeminiOauthTokenCaches,
  collapseAntigravityModels, lockGeminiOauthProvider,
} from "../src/protocol";

const ACCESS = "ya29.fixture-management-access-token";
const REFRESH = "1//0fixture-management-refresh-token-abcdefghijklmnop";
const ROTATED = "1//0rotated-management-refresh-token-abcdefghijklmnop";
const OTHER = { name: "other", api_base_url: "https://other.invalid/v1", api_key: "dummy", models: ["other-model"] };

const dirs: string[] = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});

const credential = (overrides: Partial<GeminiOauthCredentialData> = {}): GeminiOauthCredentialData => ({
  version: 2,
  kind: "antigravity",
  account: {
    email: "fixture@example.invalid", refreshToken: REFRESH, projectId: "project-fixture", tier: "paid-tier",
    importedAt: "2026-01-01T00:00:00.000Z", lastError: null, cooldownUntil: null,
  },
  rawModelIds: ["gemini-3-flash-low", "gemini-3-flash-high", "gemini-3-pro-agent"],
  ...overrides,
});

/** Visible models after the effort-family collapse (the ids the UI shows). */
const FAMILY = collapseAntigravityModels(
  ["gemini-3-flash-low", "gemini-3-flash-high", "gemini-3-pro-agent"].map((id) => ({ id, picker: 0 }))
).map((m) => m.id);

beforeEach(() => {
  vi.stubEnv("GEMINI_OAUTH_CLIENT_ID", "dummy-client-id");
  vi.stubEnv("GEMINI_OAUTH_CLIENT_SECRET", "dummy-client-secret");
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network disabled in test"); }));
  clearGeminiOauthTokenCaches();
});
afterEach(async () => {
  clearGeminiOauthTokenCaches();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

function router() {
  return {
    default: "gemini-oauth,gemini-3-flash",
    background: "gemini-oauth,gemini-3-pro-agent",
    think: "other,other-model",
    longContext: ["gemini-oauth,gemini-3-flash", "other,other-model"],
    models: { flash: "gemini-oauth,gemini-3-flash", keep: "other,other-model" },
    families: { flash: { default: "gemini-oauth,gemini-3-flash" }, other: { default: "other,other-model" } },
    fallback: ["gemini-oauth,gemini-3-flash", ["other,other-model", "gemini-oauth,gemini-3-pro-agent"], ["other,other-model"]],
  };
}

async function harness(config?: any) {
  const dir = await fs.mkdtemp(join(tmpdir(), "gemini-models-"));
  dirs.push(dir);
  const store = new GeminiOauthCredentialStore(join(dir, "gemini-oauth-credentials.json"));
  const live = {
    current: structuredClone(config ?? {
      Providers: [lockGeminiOauthProvider({ name: "gemini-oauth", models: [...FAMILY], enabled: true }), OTHER],
      Router: router(),
    }),
  };
  const host = {
    readRawConfig: vi.fn(async () => structuredClone(live.current)),
    writeConfig: vi.fn(async (next: any) => { live.current = structuredClone(next); }),
    reloadRuntime: vi.fn(async () => {}),
    getDirectDispatcher: vi.fn(() => ({ fake: "dispatcher" })),
  };
  const service = new GeminiOauthAuthService({ store, host, logger: { warn: vi.fn(), error: vi.fn() } } as any);
  return { dir, store, service, host, config: () => live.current };
}

describe("hidden-model persistence (backward compatible credential schema)", () => {
  it("accepts a credential file written before hiddenModels existed and keeps it absent", async () => {
    const h = await harness();
    await h.store.save(credential());
    const loaded = await h.store.load();
    expect(loaded).toEqual(credential());
    expect("hiddenModels" in loaded!).toBe(false);
    expect((await h.service.getStatus())).toMatchObject({ models: FAMILY, hiddenModels: [], modelsCount: FAMILY.length });
  });

  it("round-trips hiddenModels as deduplicated UI ids and drops it when empty", async () => {
    const h = await harness();
    const normalized = normalizeGeminiOauthData({ ...credential(), hiddenModels: [FAMILY[0]!, FAMILY[0]!, FAMILY[1]!] });
    expect(normalized.hiddenModels).toEqual([FAMILY[0], FAMILY[1]]);
    expect(normalizeGeminiOauthData({ ...credential(), hiddenModels: [] }).hiddenModels).toBeUndefined();
    await h.store.save(normalized);
    expect((await h.store.load())!.hiddenModels).toEqual([FAMILY[0], FAMILY[1]]);
  });

  it.each([
    ["a non-array", "gemini-3-flash"],
    ["an empty id", [""]],
    ["a comma id", ["a,b"]],
    ["a control-character id", ["a\u0001b"]],
    ["a non-string entry", [42]],
    ["an over-long id", ["x".repeat(257)]],
    ["more than 256 entries", Array.from({ length: 257 }, (_, i) => `m-${i}`)],
  ])("rejects %s in hiddenModels", (_label, value) => {
    expect(() => normalizeGeminiOauthData({ ...credential(), hiddenModels: value })).toThrow("gemini_oauth_credential_invalid");
  });

  it("keeps hiddenModels across a refresh-token rotation and error bookkeeping", async () => {
    const h = await harness();
    await h.store.save(credential({ hiddenModels: [FAMILY[0]] }));
    vi.stubGlobal("fetch", vi.fn(async () => json({ access_token: ACCESS, refresh_token: ROTATED, expires_in: 3600 })));
    expect(await h.service.getAccessToken()).toBe(ACCESS);
    let stored = (await h.store.load())!;
    expect(stored.account.refreshToken).toBe(ROTATED);
    expect(stored.hiddenModels).toEqual([FAMILY[0]]);

    await h.service.noteUpstreamError(classifyGeminiOauthError({ status: 429 }));
    stored = (await h.store.load())!;
    expect(stored.account.lastError).toEqual({ code: "gemini_oauth_quota_exceeded" });
    expect(stored.hiddenModels).toEqual([FAMILY[0]]);
    expect(stored.rawModelIds).toEqual(credential().rawModelIds);

    // A second service instance must read the same preference from disk.
    const reloaded = new GeminiOauthAuthService({ store: h.store, host: h.host, logger: { warn() {}, error() {} } } as any);
    expect((await reloaded.getStatus()).hiddenModels).toEqual([FAMILY[0]]);
  });
});

describe("hideModel", () => {
  it("removes the model from the provider, persists the blacklist and cleans only its Router refs", async () => {
    const h = await harness();
    await h.store.save(credential());
    const result = await h.service.hideModel("gemini-3-flash");

    expect(result.ok).toBe(true);
    expect(result.models).toEqual([FAMILY[1]]);
    expect(result.hiddenModels).toEqual(["gemini-3-flash"]);
    expect(result.removedModelRefs).toEqual(["gemini-oauth,gemini-3-flash"]);
    expect(result.clearedRefs.sort()).toEqual(
      ["default", "fallback", "families.flash.default", "models:flash", "scenario:longContext"].sort()
    );
    expect(result.defaultFallback).toBe("gemini-oauth,gemini-3-pro-agent");

    // Config: managed provider loses exactly the hidden model; the other
    // provider is byte-identical.
    const config = h.config();
    expect(config.Providers[0].models).toEqual([FAMILY[1]]);
    expect(config.Providers[1]).toEqual(OTHER);
    // Router: only refs of the hidden model move; the rest keeps order.
    expect(config.Router).toEqual({
      default: "gemini-oauth,gemini-3-pro-agent",
      background: "gemini-oauth,gemini-3-pro-agent",
      think: "other,other-model",
      longContext: ["other,other-model"],
      models: { keep: "other,other-model" },
      families: { flash: { default: "" }, other: { default: "other,other-model" } },
      // A stage of several refs loses only the hidden one; an emptied stage goes.
      fallback: [["other,other-model", "gemini-oauth,gemini-3-pro-agent"], ["other,other-model"]],
    });
    // Credential: the blacklist stores the UI id, the mapper keeps raw variants.
    const stored = (await h.store.load())!;
    expect(stored.hiddenModels).toEqual(["gemini-3-flash"]);
    expect(stored.rawModelIds).toEqual(credential().rawModelIds);
    expect(await h.service.resolveWireModel("gemini-3-flash", "low")).toBe("gemini-3-flash-low");
    // Status agrees with the config.
    expect(await h.service.getStatus()).toMatchObject({ models: [FAMILY[1]], hiddenModels: ["gemini-3-flash"], modelsCount: 1 });
  });

  it("allows hiding every model (empty provider list, no static fallback is re-added)", async () => {
    const h = await harness();
    await h.store.save(credential());
    for (const model of FAMILY) expect((await h.service.hideModel(model)).ok).toBe(true);
    expect(h.config().Providers[0].models).toEqual([]);
    expect(h.config().Router.default).toBe("");
    expect(await h.service.getStatus()).toMatchObject({ models: [], hiddenModels: FAMILY, modelsCount: 0 });
  });

  it.each([[""], ["a,b"], ["bad\u0000id"], ["x".repeat(257)], [42 as any], [null as any], [undefined as any]])(
    "rejects invalid model input %j before touching state",
    async (model) => {
      const h = await harness();
      await h.store.save(credential());
      const before = structuredClone(h.config());
      await expect(h.service.hideModel(model as any)).rejects.toMatchObject({ code: "gemini_oauth_model_invalid", statusCode: 422 });
      expect(h.host.writeConfig).not.toHaveBeenCalled();
      expect(h.config()).toEqual(before);
      expect((await h.store.load())!.hiddenModels).toBeUndefined();
    }
  );

  it("refuses a model the managed provider does not expose", async () => {
    const h = await harness();
    await h.store.save(credential());
    await expect(h.service.hideModel("not-a-managed-model")).rejects.toMatchObject({ code: "gemini_oauth_model_invalid" });
    expect(h.host.writeConfig).not.toHaveBeenCalled();
  });

  it("reports a disconnected account without touching config", async () => {
    const h = await harness();
    await expect(h.service.hideModel("gemini-3-flash")).rejects.toMatchObject({ code: "gemini_oauth_not_connected", statusCode: 409 });
    expect(h.host.writeConfig).not.toHaveBeenCalled();
  });

  it("rolls the credential file back when the config write fails and reloads the previous config", async () => {
    const h = await harness();
    await h.store.save(credential());
    const before = structuredClone(h.config());
    h.host.writeConfig.mockRejectedValueOnce(new Error("private disk error"));
    await expect(h.service.hideModel("gemini-3-flash")).rejects.toMatchObject({ code: "gemini_oauth_config_write_failed", statusCode: 500 });
    expect((await h.store.load())).toEqual(credential());
    expect(h.config()).toEqual(before);
    expect(h.host.reloadRuntime).toHaveBeenCalled();
    expect((await h.service.getStatus()).hiddenModels).toEqual([]);
  });

  it("serializes concurrent hides so both survive", async () => {
    const h = await harness();
    await h.store.save(credential());
    const results = await Promise.all([h.service.hideModel(FAMILY[0]), h.service.hideModel(FAMILY[1])]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect((await h.store.load())!.hiddenModels).toEqual([FAMILY[0], FAMILY[1]]);
    expect(h.config().Providers[0].models).toEqual([]);
    // Every write carried both hidden ids, so no interleaving lost one.
    const writes = h.host.writeConfig.mock.calls.map(([config]) => config.Providers[0].models as string[]);
    expect(writes.at(-1)).toEqual([]);
  });
});

describe("restoreModels", () => {
  it("restores one model and never rewrites Router", async () => {
    const h = await harness();
    await h.store.save(credential({ hiddenModels: ["gemini-3-flash"] }));
    h.config().Providers[0].models = [FAMILY[1]];
    const routerBefore = structuredClone(h.config().Router);
    const result = await h.service.restoreModels("gemini-3-flash");
    expect(result).toMatchObject({ ok: true, restored: ["gemini-3-flash"], hiddenModels: [] });
    expect(result.models).toEqual([FAMILY[1], "gemini-3-flash"]);
    expect(h.config().Router).toEqual(routerBefore);
    expect((await h.store.load())!.hiddenModels).toBeUndefined();
  });

  it("restore-all re-registers only models still available upstream", async () => {
    const h = await harness();
    await h.store.save(credential({ hiddenModels: ["gemini-3-flash", "gemini-2.5-gone"] }));
    h.config().Providers[0].models = [FAMILY[1]];
    const routerBefore = structuredClone(h.config().Router);
    const result = await h.service.restoreModels();
    expect(result.restored).toEqual(["gemini-3-flash"]);
    expect(result.hiddenModels).toEqual([]);
    expect(result.models).toEqual([FAMILY[1], "gemini-3-flash"]);
    expect(h.config().Providers[0].models).toEqual([FAMILY[1], "gemini-3-flash"]);
    expect(h.config().Router).toEqual(routerBefore);
  });

  it("rejects an invalid model id and rolls back on a config write failure", async () => {
    const h = await harness();
    await h.store.save(credential({ hiddenModels: ["gemini-3-flash"] }));
    h.config().Providers[0].models = [FAMILY[1]];
    await expect(h.service.restoreModels("a,b")).rejects.toMatchObject({ code: "gemini_oauth_model_invalid" });
    const before = structuredClone(h.config());
    h.host.writeConfig.mockRejectedValueOnce(new Error("disk"));
    await expect(h.service.restoreModels()).rejects.toMatchObject({ code: "gemini_oauth_config_write_failed" });
    expect((await h.store.load())!.hiddenModels).toEqual(["gemini-3-flash"]);
    expect(h.config()).toEqual(before);
  });
});

describe("sync and re-login keep the hide preference", () => {
  it("sync never resurrects a hidden model and keeps raw variants for the mapper", async () => {
    const h = await harness();
    await h.store.save(credential({ hiddenModels: ["gemini-3-flash"] }));
    h.config().Providers[0].models = [FAMILY[1]];
    vi.stubGlobal("fetch", vi.fn(async (url: any) => {
      const u = String(url);
      if (u.includes("/token")) return json({ access_token: ACCESS });
      if (u === `${GEMINI_OAUTH_DATA_PLANE}/v1internal:fetchAvailableModels`) {
        return json({ models: {
          "gemini-3-flash-low": { displayName: "Gemini Flash (Low)" },
          "gemini-3-flash-high": { displayName: "Gemini Flash (High)" },
          "gemini-3-pro-agent": { displayName: "Gemini 3.1 Pro (High)" },
        } });
      }
      throw new Error("unexpected endpoint");
    }));
    const result = await h.service.syncModels();
    expect(result.ok).toBe(true);
    expect(h.config().Providers[0].models).toEqual([FAMILY[1]]);
    expect((await h.store.load())!.hiddenModels).toEqual(["gemini-3-flash"]);
    expect([...(await h.store.load())!.rawModelIds!].sort()).toEqual(["gemini-3-flash-high", "gemini-3-flash-low", "gemini-3-pro-agent"]);
    expect(await h.service.getStatus()).toMatchObject({ models: [FAMILY[1]], hiddenModels: ["gemini-3-flash"] });
  });

  it("a re-login replaces the account but keeps the hidden set", async () => {
    const h = await harness({ Providers: [lockGeminiOauthProvider({ name: "gemini-oauth", models: [FAMILY[1]] })], Router: {} });
    await h.store.save(credential({ hiddenModels: ["gemini-3-flash"] }));
    // Token exchange → userinfo → project discovery are served locally; only the
    // model discovery + persistence chain of runLogin runs for real.
    vi.stubGlobal("fetch", vi.fn(async (url: any) => {
      const u = String(url);
      if (u === "https://oauth2.googleapis.com/token") return json({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600 });
      if (u === "https://www.googleapis.com/oauth2/v2/userinfo?alt=json") return json({ email: "fixture@example.invalid" });
      if (u.startsWith("https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist")) {
        return json({ cloudaicompanionProject: "project-fixture", currentTier: { id: "paid-tier" } });
      }
      throw new Error("unexpected endpoint");
    }));
    vi.spyOn(h.service as any, "discoverModels").mockResolvedValue({
      collapsed: [{ id: "gemini-3-flash", picker: 0 }, { id: FAMILY[1], picker: 1 }],
      rawIds: credential().rawModelIds,
    });
    const service = h.service as any;
    const job = {
      loginId: "a".repeat(48),
      verifier: "verifier",
      redirectUri: "http://localhost:1234/oauth-callback",
      expiresAt: Date.now() + 60_000,
      state: "state",
      server: { close: () => {} },
      timer: null,
      lastPoll: 0,
      epoch: service.epoch,
      callback: Promise.resolve({ code: "fixture-code" }),
      resolveCallback: () => {},
      rejectCallback: () => {},
    };
    service.pending = job;
    const result = await service.runLogin(job);
    expect(result).toEqual({ status: "success", email: "fixture@example.invalid" });
    const stored = (await h.store.load())!;
    expect(stored.hiddenModels).toEqual(["gemini-3-flash"]);
    expect(stored.account.refreshToken).toBe(REFRESH);
    // The provider is registered WITHOUT the hidden model.
    expect(h.config().Providers[0].models).toEqual([FAMILY[1]]);
    expect(await h.service.getStatus()).toMatchObject({ hiddenModels: ["gemini-3-flash"], models: [FAMILY[1]] });
    void job;
  });
});


describe("noteRequestSuccess clears stale account markers", () => {
  it("clears a stale validation cooldown+lastError after a completed exchange, keeps reauth", async () => {
    const h = await harness();
    const cred = credential();
    await h.store.save({
      ...cred,
      account: {
        ...cred.account,
        lastError: { code: "gemini_oauth_validation_required" },
        cooldownUntil: Date.now() + 600_000,
      },
    });
    await (h.service.noteRequestSuccess() as unknown as Promise<void>);
    const stored = (await h.store.load())!;
    expect(stored.account.lastError).toBeNull();
    expect(stored.account.cooldownUntil).toBeNull();

    // reauth is only cleared by the fresh-login flow.
    await h.service.noteUpstreamError({ code: "gemini_oauth_reauth_required" } as any);
    await (h.service.noteRequestSuccess() as unknown as Promise<void>);
    expect((await h.store.load())!.account.lastError!.code).toBe("gemini_oauth_reauth_required");
  });

  it("is a no-op when no marker is latched", async () => {
    const h = await harness();
    await h.store.save(credential());
    await (h.service.noteRequestSuccess() as unknown as Promise<void>);
    const stored = (await h.store.load())!;
    expect(stored.account.lastError).toBeNull();
    expect(stored.account.cooldownUntil ?? null).toBeNull();
  });
});

