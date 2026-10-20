/**
 * WorkBuddy §16 milestone B: multi-account pool service layer.
 * Status sanitization, per-site epochs, per-account refresh single-flight,
 * active-sticky selection with additive model cooldowns, pool mutations, and
 * the idempotent AI provider rename migration. Transport retry and admin
 * routes are milestone C and deliberately out of scope here.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkBuddyAuthService, clearWorkBuddyRouterRefs, renameWorkBuddyAiRouterRefs } from "../services/workbuddy-auth";
import { WorkBuddyCredentialStore, type WorkBuddyCredential } from "../services/workbuddy";
import * as configModule from "../ccr/config";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  configs.clear();
});

const CRED = (extra: Partial<WorkBuddyCredential> = {}): WorkBuddyCredential => ({
  version: 1,
  kind: "workbuddy",
  uid: "u-1",
  displayName: "Nick",
  domain: "",
  enterpriseId: "",
  accessToken: "token-u1",
  expiresAt: Date.now() + 3_600_000,
  importedAt: "2026-10-19T00:00:00.000Z",
  source: "desktop",
  tokenType: "",
  ...extra,
});

const configs = new Map<string, any>();

function harness(config: any = { Providers: [], Router: { default: "other,model" } }) {
  const dir = mkdtempSync(join(tmpdir(), "wb-pool-"));
  dirs.push(dir);
  configs.set("current", structuredClone(config));
  const write = vi.spyOn(configModule, "writeConfigFile").mockImplementation(async (next: any) => {
    configs.set("current", structuredClone(next));
  });
  vi.spyOn(configModule, "readConfigFileRaw").mockImplementation(async () => structuredClone(configs.get("current")));
  const store = new WorkBuddyCredentialStore(join(dir, "creds.json"));
  const service = new WorkBuddyAuthService({
    configService: { get: (k: string) => configs.get("current")?.[k], getAll: () => configs.get("current"), reload: vi.fn(), set: vi.fn() },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    store,
    readSource: () => ({ ok: false, reason: "source_missing" }),
    getServer: () => undefined,
  });
  return { dir, store, service, write, config: () => configs.get("current") };
}

/** Per-origin upstream: both sites' discovery, per-account token refresh. */
function multiSiteFetch(models: { cn: string[]; ai: string[] }) {
  return vi.fn(async (url: string, init?: any) => {
    const respond = (data: any, origin: string) => {
      const r = new Response(JSON.stringify({ code: 0, msg: "ok", data }), { status: 200, headers: { "content-type": "application/json" } });
      Object.defineProperty(r, "url", { value: url.startsWith("https://www.workbuddy.ai") ? origin + new URL(url).pathname : "https://copilot.tencent.com" + new URL(url).pathname });
      return r;
    };
    if (url.includes("auth/token/refresh")) {
      const prior = String(init?.headers?.["X-Refresh-Token"] ?? "");
      return respond({ accessToken: prior.replace("browser-refresh", "rotated"), refreshToken: prior.replace("browser-refresh", "rotated"), expiresIn: 3600 }, "https://copilot.tencent.com");
    }
    if (url.includes("auth/state")) return respond({ state: "private-state", authUrl: url.startsWith("https://www.workbuddy.ai") ? "https://www.workbuddy.ai/login" : "https://copilot.tencent.com/login" }, new URL(url).origin);
    if (url.includes("auth/token?")) return respond({ accessToken: "browser-access", refreshToken: "browser-refresh", expiresIn: 3600 }, new URL(url).origin);
    if (url.includes("login/account")) return respond({ uid: "browser-user", nickname: "Browser account", type: "personal" }, new URL(url).origin);
    const cn = url.startsWith("https://copilot.tencent.com");
    const list = cn ? models.cn : models.ai;
    return respond({ agents: [{ name: "cli", models: list }], models: list.map((id) => ({ id, name: id.toUpperCase() })) }, new URL(url).origin);
  });
}

async function seedTwoSitePools(h: ReturnType<typeof harness>) {
  await h.store.upsertAccount(CRED({ uid: "cn-a", accessToken: "token-cn-a", importedAt: "2026-10-19T01:00:00.000Z" }));
  await h.store.upsertAccount(CRED({ uid: "cn-b", accessToken: "token-cn-b", importedAt: "2026-10-19T02:00:00.000Z" }));
  await h.store.upsertAccount(CRED({ kind: "workbuddy-ai", uid: "ai-a", domain: "www.workbuddy.ai", accessToken: "token-ai-a" }));
}

describe("WorkBuddy pool status (sanitized)", () => {
  it("returns per-site summaries with cooldown badges and no token material", async () => {
    const h = harness();
    await seedTwoSitePools(h);
    await h.store.setAccountCooldown("workbuddy", "cn-a", { until: Date.now() + 60_000, scope: "account", code: 11140 });
    await h.store.setAccountCooldown("workbuddy", "cn-b", { until: Date.now() + 60_000, scope: "model", model: "glm-5.3", code: 6004 });
    const pool = await h.service.getPoolStatus();
    expect(pool.connectedSites).toEqual(["workbuddy", "workbuddy-ai"]);
    const cn = pool.sites.workbuddy!;
    expect(cn.providerName).toBe("workbuddy");
    expect(cn.accounts.map((a) => a.uid)).toEqual(["cn-a", "cn-b"]);
    expect(cn.accounts[0]).toMatchObject({ active: true, coolingCode: 11140 });
    expect(cn.accounts[0].restrictedUntil).toBe(cn.accounts[0].coolingUntil);
    expect(cn.accounts[1]).toMatchObject({ modelCoolingModel: "glm-5.3", active: false });
    expect(pool.sites["workbuddy-ai"]!.providerName).toBe("workbuddy-ai");
    const serialized = JSON.stringify(pool);
    expect(serialized).not.toContain("token-cn-a");
    expect(serialized).not.toContain("accessToken");
    // Legacy flat status mirrors the first connected site.
    const flat = await h.service.getStatus();
    expect(flat).toMatchObject({ status: "connected", kind: "workbuddy", uid: "cn-a", providerName: "workbuddy" });
  });
});

describe("WorkBuddy pool membership (add-or-replace, cross-site)", () => {
  it("imports CN and AI pools simultaneously without a site conflict", async () => {
    const fetch = multiSiteFetch({ cn: ["glm-5.3"], ai: ["gpt-5.5"] });
    const h = harness({ Providers: [], Router: {} });
    (h.service as any).options.fetch = fetch;
    (h.service as any).options.readSource = () => ({ ok: true, credential: CRED({ uid: "cn-desk", accessToken: "token-cn", importedAt: "2026-10-19T00:00:00.000Z" }) });
    const cn = await h.service.importFromLocalDesktop("workbuddy");
    (h.service as any).options.readSource = () => ({ ok: true, credential: CRED({ kind: "workbuddy-ai", uid: "ai-desk", domain: "www.workbuddy.ai", accessToken: "token-ai", importedAt: "2026-10-19T00:00:00.000Z" }) });
    const ai = await h.service.importFromLocalDesktop("workbuddy-ai");
    expect(cn.success).toBe(true);
    expect(ai.success).toBe(true);
    const data = await h.store.loadData();
    expect(data?.sites.workbuddy?.accounts).toHaveLength(1);
    expect(data?.sites["workbuddy-ai"]?.accounts).toHaveLength(1);
    expect(data?.sites["workbuddy-ai"]?.accounts[0].uid).toBe("ai-desk");
    const providers = h.config().Providers;
    expect(providers.map((p: any) => p.name).sort()).toEqual(["workbuddy", "workbuddy-ai"]);
    expect(providers.find((p: any) => p.name === "workbuddy-ai").api_key).toBe("ccr-managed-workbuddy-ai");
  });

  it("replaces same-uid credentials on re-login while keeping pool position and valid cooldowns", async () => {
    const fetch = multiSiteFetch({ cn: ["glm-5.3"], ai: [] });
    const h = harness({ Providers: [], Router: {} });
    (h.service as any).options.fetch = fetch;
    await h.store.upsertAccount(CRED({ uid: "cn-a", accessToken: "old-token" }));
    await h.store.setAccountCooldown("workbuddy", "cn-a", { until: Date.now() + 60_000, scope: "account", code: 14018 });
    // Desktop import re-reads the same uid with a fresh token.
    (h.service as any).options.readSource = () => ({ ok: true, credential: CRED({ uid: "cn-a", accessToken: "fresh-token" }) });
    const result = await h.service.importFromLocalDesktop("workbuddy");
    expect(result.success).toBe(true);
    const state = (await h.store.loadData())!.sites.workbuddy!;
    expect(state.accounts).toHaveLength(1);
    expect(state.accounts[0].accessToken).toBe("fresh-token");
    // Successful login is NOT evidence quota reset (review ruling).
    expect(state.accounts[0].cooldown).toMatchObject({ scope: "account", code: 14018 });
  });
});

describe("WorkBuddy per-site epoch isolation", () => {
  it("a CN disconnect does not invalidate an AI login job; the AI job still completes", async () => {
    const fetch = multiSiteFetch({ cn: ["glm-5.3"], ai: ["gpt-5.5"] });
    const h = harness({ Providers: [], Router: {} });
    (h.service as any).options.fetch = fetch;
    // Connect CN first so disconnect has something to remove.
    await h.store.upsertAccount(CRED({ uid: "cn-a" }));
    await h.service.importFromLocalDesktop("workbuddy");
    const aiStart = await h.service.startBrowserLogin("workbuddy-ai");
    await h.service.disconnect("workbuddy");
    const poll = await h.service.pollBrowserLogin("workbuddy-ai", aiStart.loginId);
    expect(poll.status).toBe("connected");
    expect((await h.store.loadData())?.sites["workbuddy-ai"]?.accounts.map((a) => a.uid)).toEqual(["browser-user"]);
    expect(h.config().Providers.map((p: any) => p.name)).toEqual(["workbuddy-ai"]);
  });

  it("cancel removes exactly its own job; a same-site second login survives", async () => {
    const fetch = multiSiteFetch({ cn: ["glm-5.3"], ai: [] });
    const h = harness({ Providers: [], Router: {} });
    (h.service as any).options.fetch = fetch;
    const a = await h.service.startBrowserLogin("workbuddy");
    const b = await h.service.startBrowserLogin("workbuddy");
    h.service.cancelBrowserLogin("workbuddy", a.loginId);
    expect(await h.service.pollBrowserLogin("workbuddy", a.loginId)).toEqual({ status: "none" });
    expect(await h.service.pollBrowserLogin("workbuddy", b.loginId)).toMatchObject({ status: "connected" });
  });
});

describe("WorkBuddy per-account refresh and desktop renewal", () => {
  it("refreshes each browser account independently, once per account", async () => {
    const fetch = multiSiteFetch({ cn: ["glm-5.3"], ai: [] });
    const h = harness({ Providers: [], Router: {} });
    (h.service as any).options.fetch = fetch;
    await h.store.upsertAccount(CRED({
      uid: "cn-a", source: "browser", accessToken: "browser-access-a", refreshToken: "browser-refresh-a",
      expiresAt: Date.now() + 60_000, importedAt: new Date().toISOString(),
    }));
    await h.store.upsertAccount(CRED({
      uid: "cn-b", source: "browser", accessToken: "browser-access-b", refreshToken: "browser-refresh-b",
      expiresAt: Date.now() + 60_000, importedAt: new Date().toISOString(),
    }));
    await h.store.setActiveUid("workbuddy", "cn-b");
    const [b1, b1again] = await Promise.all([h.service.currentCredential("workbuddy"), h.service.currentCredential("workbuddy")]);
    expect(b1?.uid).toBe("cn-b");
    expect(b1?.accessToken).toBe("rotated-b");
    expect(b1again?.accessToken).toBe("rotated-b");
    const a1 = await h.service.currentCredential("workbuddy", undefined, ["cn-b"]);
    expect(a1?.uid).toBe("cn-a");
    expect(a1?.accessToken).toBe("rotated-a");
    const refreshCalls = fetch.mock.calls.filter(([u]: any) => String(u).includes("auth/token/refresh"));
    expect(refreshCalls).toHaveLength(2); // one per account, single-flighted
    const state = (await h.store.loadData())!.sites.workbuddy!;
    expect(state.accounts.find((a) => a.uid === "cn-a")?.refreshToken).toBe("rotated-a");
    expect(state.accounts.find((a) => a.uid === "cn-b")?.refreshToken).toBe("rotated-b");
  });

  it("renews desktop accounts in memory only, keyed per account, never persisting", async () => {
    const h = harness({ Providers: [], Router: {} });
    await h.store.upsertAccount(CRED({ uid: "cn-a", accessToken: "stale-a", expiresAt: Date.now() + 60_000 }));
    await h.store.upsertAccount(CRED({ uid: "cn-b", accessToken: "stale-b", expiresAt: Date.now() + 60_000 }));
    await h.store.setActiveUid("workbuddy", "cn-b");
    (h.service as any).options.readSource = vi.fn((site?: string) => ({
      ok: true,
      credential: CRED({ uid: "cn-b", accessToken: "fresh-desktop-b", expiresAt: Date.now() + 3_600_000 }),
    }));
    const renewed = await h.service.currentCredential("workbuddy");
    expect(renewed?.uid).toBe("cn-b");
    expect(renewed?.accessToken).toBe("fresh-desktop-b");
    // Memory only: the private file still holds the stale snapshot.
    const persisted = (await h.store.loadData())!.sites.workbuddy!.accounts;
    expect(persisted.find((a) => a.uid === "cn-b")?.accessToken).toBe("stale-b");
    // Second call hits the generation-keyed memory cache without re-reading.
    const calls = ((h.service as any).options.readSource as any).mock.calls.length;
    await h.service.currentCredential("workbuddy");
    expect(((h.service as any).options.readSource as any).mock.calls.length).toBe(calls);
  });
});

describe("WorkBuddy pool selection and cooldowns", () => {
  it("is active-sticky, skips cooled accounts, orders by least cooldown then earliest import", async () => {
    const h = harness({ Providers: [], Router: {} });
    await seedTwoSitePools(h);
    // Sticky: active cn-a usable → stays.
    expect((await h.service.selectAccount("workbuddy"))?.uid).toBe("cn-a");
    // cn-a account-cooled → cn-b (only other option; also earliest-imported ordering).
    await h.service.markAccountCooldown("workbuddy", "cn-a", { until: Date.now() + 60_000, scope: "account", code: 14018 });
    expect((await h.service.selectAccount("workbuddy"))?.uid).toBe("cn-b");
    // Model-scoped: cn-b limited ONLY on kimi-k3-1 → excluded for that model, fine for others.
    await h.service.markAccountCooldown("workbuddy", "cn-b", { until: Date.now() + 60_000, scope: "model", model: "kimi-k3-1", code: 6004 });
    expect((await h.service.selectAccount("workbuddy", "kimi-k3-1"))).toBeNull();
    expect((await h.service.selectAccount("workbuddy", "glm-5.3"))?.uid).toBe("cn-b");
    // Additive slots: cn-b keeps BOTH limits simultaneously.
    await h.service.markAccountCooldown("workbuddy", "cn-b", { until: Date.now() + 60_000, scope: "model", model: "glm-5.3", code: 6004 });
    // No model given: cn-a account-blocked, cn-b only model-limited → cn-b still usable.
    expect((await h.service.selectAccount("workbuddy"))?.uid).toBe("cn-b");
    // For glm-5.3: cn-a account-blocked AND cn-b model-blocked → nobody usable.
    expect((await h.service.selectAccount("workbuddy", "glm-5.3"))).toBeNull();
    // excludedUids (transport rotation): both excluded → null; excluded cn-b only for kimi → still null (cn-a cooled).
    expect((await h.service.selectAccount("workbuddy", "kimi-k3-1", ["cn-a", "cn-b"]))).toBeNull();
    expect((await h.service.selectAccount("workbuddy", "kimi-k3-1", ["cn-b"]))).toBeNull();
    // Clearing cn-a's account cooldown restores it despite cn-b's model limits.
    await h.service.markAccountCooldown("workbuddy", "cn-a", null);
    expect((await h.service.selectAccount("workbuddy", "glm-5.3"))?.uid).toBe("cn-a");
  });

  it("removes an account, advances the sticky active, and disconnects the site when the pool empties", async () => {
    const h = harness({
      Providers: [{ name: "workbuddy", ccr_managed: true, workbuddy_kind: "workbuddy", api_base_url: "https://copilot.tencent.com/v2/chat/completions", api_key: "ccr-managed-workbuddy", models: ["glm-5.3"], transformer: { use: ["workbuddy"] } }],
      Router: { default: "workbuddy,glm-5.3", longContext: ["workbuddy,glm-5.3"] },
    });
    await seedTwoSitePools(h);
    const removed = await h.service.removeAccount("workbuddy", "cn-a");
    expect(removed).toMatchObject({ success: true, poolEmpty: false, removedProvider: false });
    expect((await h.store.loadData())!.sites.workbuddy!.activeUid).toBe("cn-b"); // earliest-imported remaining
    const last = await h.service.removeAccount("workbuddy", "cn-b");
    expect(last).toMatchObject({ success: true, poolEmpty: true, removedProvider: true, deletedCredential: false });
    expect(last.notice).toContain("Router");
    // Full-site disconnect semantics: provider removed, Router refs RETAINED.
    expect(h.config().Providers).toEqual([]);
    expect(h.config().Router).toEqual({ default: "workbuddy,glm-5.3", longContext: ["workbuddy,glm-5.3"] });
    // The AI pool is untouched (per-site isolation).
    expect((await h.store.loadData())!.sites["workbuddy-ai"]).toBeDefined();
  });

  it("serializes concurrent different-site mutations without lost updates", async () => {
    const h = harness({
      Providers: [
        { name: "workbuddy", ccr_managed: true, workbuddy_kind: "workbuddy", api_base_url: "https://copilot.tencent.com/v2/chat/completions", api_key: "ccr-managed-workbuddy", models: ["m1", "cn-only"], transformer: { use: ["workbuddy"] } },
        { name: "workbuddy-ai", ccr_managed: true, workbuddy_kind: "workbuddy-ai", api_base_url: "https://www.workbuddy.ai/v2/chat/completions", api_key: "ccr-managed-workbuddy-ai", models: ["m2", "ai-only"], transformer: { use: ["workbuddy"] } },
      ],
      Router: { default: "other,m", think: "workbuddy,m1", webSearch: "workbuddy-ai,m2", models: { "alias-1": "workbuddy,m1", "alias-2": "workbuddy-ai,m2" } },
    });
    await seedTwoSitePools(h);
    const [hideCn, hideAi, switchResult] = await Promise.all([
      h.service.hideModel("workbuddy", "m1"),
      h.service.hideModel("workbuddy-ai", "m2"),
      h.service.switchAccount("workbuddy-ai", "ai-a"),
    ]);
    expect(hideCn.success && hideAi.success && switchResult === undefined).toBe(true);
    const router = h.config().Router;
    // BOTH hide operations survived (no lost update), each touching only its own refs.
    expect(router.think).toBe("");                       // CN m1 cleared
    expect(router.webSearch).toBe("");                   // AI m2 cleared
    expect(router.models).toEqual({});                   // both alias entries removed
    expect(router.default).toBe("other,m");              // unrelated default untouched
    const data = await h.store.loadData()!;
    expect(data.sites.workbuddy!.hiddenModels).toEqual(["m1"]);
    expect(data.sites["workbuddy-ai"]!.hiddenModels).toEqual(["m2"]);
  });
});

describe("WorkBuddy sync with hidden models (cumulative union)", () => {
  it("filters hidden models, accumulates the union, and never touches Router", async () => {
    const fetch = multiSiteFetch({ cn: ["glm-5.3", "kimi-k3-1"], ai: [] });
    const router = { default: "other,m", longContext: ["workbuddy,glm-5.3"] };
    const h = harness({
      Providers: [{ name: "workbuddy", ccr_managed: true, workbuddy_kind: "workbuddy", api_base_url: "https://copilot.tencent.com/v2/chat/completions", api_key: "ccr-managed-workbuddy", models: ["glm-5.3"], transformer: { use: ["workbuddy"] } }],
      Router: router,
    });
    (h.service as any).options.fetch = fetch;
    await h.store.upsertAccount(CRED({ uid: "cn-a" }));
    const hide = await h.service.hideModel("workbuddy", "glm-5.3");
    expect(hide.clearedRefs).toEqual(["scenario:longContext"]);
    // Hide rewrote the scenario ref; sync must NOT touch Router again.
    const afterHide = structuredClone(h.config().Router);
    const sync = await h.service.syncModels("workbuddy");
    expect(sync.success).toBe(true);
    expect(sync.models).toEqual(["kimi-k3-1"]);           // hidden glm-5.3 filtered
    expect(h.config().Router).toEqual(afterHide);          // sync doesn't rewrite Router
    // Cumulative union: a model that disappears upstream stays registered.
    (h.service as any).options.fetch = multiSiteFetch({ cn: ["kimi-k3-1"], ai: [] });
    const sync2 = await h.service.syncModels("workbuddy");
    expect(sync2.models).toEqual(["kimi-k3-1"]);
    const state = (await h.store.loadData())!.sites.workbuddy!;
    expect(state.discoveredModels).toEqual(["glm-5.3", "kimi-k3-1"]);
    expect(state.lastSyncAt).toBeTruthy();
    // Restore brings the model back (never resurrected before that), Router untouched.
    const restore = await h.service.restoreModels("workbuddy");
    expect(restore.restored).toEqual(["glm-5.3"]);
    expect(restore.models.sort()).toEqual(["glm-5.3", "kimi-k3-1"]);
    expect(h.config().Router).toEqual(afterHide);
    expect(h.write).toHaveBeenCalled(); // provider models updated via config writes
  });
});

describe("WorkBuddy §16 Router helpers (structural, no string replacement)", () => {
  it("clears exactly the three reference kinds and substitutes the first visible default", () => {
    const router = {
      default: "workbuddy,glm-5.3",
      background: "workbuddy,glm-5.3",
      think: "workbuddy,other-model",
      longContextThreshold: 100000,
      webSearch: ["workbuddy,glm-5.3"],
      models: { "my-alias": "workbuddy,glm-5.3", keep: "other,m" },
      families: { opus: { default: "workbuddy,glm-5.3", enableExtendedContext: true } },
      fallback: { default: ["workbuddy,glm-5.3"] },
    };
    const { router: next, clearedRefs } = clearWorkBuddyRouterRefs(router, "workbuddy", "glm-5.3", "kimi-k3-1");
    expect(clearedRefs.sort()).toEqual(["default", "families.opus.default", "models:my-alias", "scenario:background", "scenario:webSearch"]);
    expect(next.default).toBe("workbuddy,kimi-k3-1");
    expect(next.background).toBe("");
    expect(next.think).toBe("workbuddy,other-model");       // unrelated model untouched
    expect(next.longContextThreshold).toBe(100000);
    expect(next.webSearch).toEqual([]);                     // matching array entries removed
    expect(next.models).toEqual({ keep: "other,m" });
    expect(next.families.opus.default).toBe("");
    expect(next.fallback).toEqual({ default: ["workbuddy,glm-5.3"] }); // NOT covered
    // All hidden → default becomes "".
    const emptied = clearWorkBuddyRouterRefs(router, "workbuddy", "glm-5.3", null);
    expect(emptied.router.default).toBe("");
    expect(router.default).toBe("workbuddy,glm-5.3"); // input never mutated
  });

  it("rewrites only workbuddy refs whose model is in the AI site's model set", () => {
    const router = {
      default: "workbuddy,gpt-5.5",
      think: "workbuddy,cn-only",
      models: { a: "workbuddy,gpt-5.5", b: "workbuddy,cn-only", c: "other,m" },
      families: { opus: { default: "workbuddy,gpt-5.5" } },
      fallback: { default: ["workbuddy,gpt-5.5"] },
    };
    const { router: next, renamedRefs } = renameWorkBuddyAiRouterRefs(router, new Set(["gpt-5.5"]));
    expect(renamedRefs.sort()).toEqual(["default", "families.opus.default", "models:a"]);
    expect(next.default).toBe("workbuddy-ai,gpt-5.5");
    expect(next.think).toBe("workbuddy,cn-only");          // model not in set → untouched
    expect(next.models.b).toBe("workbuddy,cn-only");
    expect(next.models.c).toBe("other,m");
    expect(next.fallback).toEqual({ default: ["workbuddy,gpt-5.5"] }); // NOT covered
  });
});

describe("WorkBuddy AI provider rename migration (§16, crash-safe)", () => {
  const legacyConfig = (extra: any[] = [], router: any = {}) => ({
    Providers: [
      { name: "workbuddy", ccr_managed: true, workbuddy_kind: "workbuddy-ai", api_base_url: "https://www.workbuddy.ai/v2/chat/completions", api_key: "ccr-managed-workbuddy", models: ["gpt-5.5", "glm-5.3"], transformer: { use: ["workbuddy"] }, enabled: true },
      ...extra,
    ],
    Router: router,
  });

  it("renames the provider, rewrites Router refs for site models, and is idempotent", async () => {
    const h = harness(legacyConfig([], { default: "workbuddy,gpt-5.5", think: "workbuddy,glm-5.3", models: { a: "workbuddy,gpt-5.5" } }));
    writeFileSync(h.store.path, JSON.stringify(CRED({ kind: "workbuddy-ai", uid: "ai-a", domain: "www.workbuddy.ai", source: "browser", refreshToken: "r" })), { mode: 0o600 });
    const result = await h.service.migrateLegacyProviderNaming();
    expect(result).toMatchObject({ success: true, renamedProvider: true });
    expect(result.renamedRefs.sort()).toEqual(["default", "models:a", "scenario:think"]);
    const provider = h.config().Providers[0];
    expect(provider).toMatchObject({ name: "workbuddy-ai", api_key: "ccr-managed-workbuddy-ai", workbuddy_kind: "workbuddy-ai" });
    expect(h.config().Router).toEqual({ default: "workbuddy-ai,gpt-5.5", think: "workbuddy-ai,glm-5.3", models: { a: "workbuddy-ai,gpt-5.5" } });
    // Idempotent: second run is a no-op.
    const again = await h.service.migrateLegacyProviderNaming();
    expect(again).toMatchObject({ success: true, renamedProvider: false, renamedRefs: [] });
  });

  it("recovers after a crash between store migration and config rewrite", async () => {
    const h = harness(legacyConfig([], { default: "workbuddy,gpt-5.5" }));
    writeFileSync(h.store.path, JSON.stringify(CRED({ kind: "workbuddy-ai", uid: "ai-a", domain: "www.workbuddy.ai" })), { mode: 0o600 });
    // Simulate the crash: store migrated (v2 + backup) but config still legacy.
    const migrated = await h.store.migrateV1();
    expect(migrated.backupCreated).toBe(true);
    expect(h.config().Providers[0].name).toBe("workbuddy");
    // Restart path: the v2 store file is the persisted signal; the idempotent
    // detection (v2 store + misnamed managed AI provider) re-applies the config side.
    const result = await h.service.migrateLegacyProviderNaming();
    expect(result).toMatchObject({ success: true, renamedProvider: true });
    expect(h.config().Providers[0].name).toBe("workbuddy-ai");
    expect(h.config().Router.default).toBe("workbuddy-ai,gpt-5.5");
    // The backup stays private 0600 with the exact v1 bytes.
    expect(statSync(h.store.path.replace(/\.json$/, ".v1.bak")).mode & 0o777).toBe(0o600);
  });

  it("fails closed when a plain provider owns the workbuddy-ai name", async () => {
    const plain = { name: "workbuddy-ai", api_base_url: "https://x.example/v1", api_key: "k", models: ["m"] };
    const router = { default: "workbuddy,gpt-5.5" };
    const h = harness(legacyConfig([plain], router));
    writeFileSync(h.store.path, JSON.stringify(CRED({ kind: "workbuddy-ai", uid: "ai-a", domain: "www.workbuddy.ai" })), { mode: 0o600 });
    const result = await h.service.migrateLegacyProviderNaming();
    expect(result).toMatchObject({ success: false, error: "workbuddy_name_conflict" });
    // Byte-identical config: rename refused, Router untouched.
    expect(h.config().Providers[0].name).toBe("workbuddy");
    expect(h.config().Providers[1]).toEqual(plain);
    expect(h.config().Router).toEqual(router);
  });

  it("keeps a single provider after rename followed by sync (no double-registration)", async () => {
    const fetch = multiSiteFetch({ cn: [], ai: ["gpt-5.5"] });
    const h = harness(legacyConfig([], { default: "workbuddy,gpt-5.5" }));
    writeFileSync(h.store.path, JSON.stringify(CRED({ kind: "workbuddy-ai", uid: "ai-a", domain: "www.workbuddy.ai" })), { mode: 0o600 });
    (h.service as any).options.fetch = fetch;
    const migrated = await h.service.migrateLegacyProviderNaming();
    expect(migrated).toMatchObject({ success: true, renamedProvider: true });
    const sync = await h.service.syncModels("workbuddy-ai");
    expect(sync.success).toBe(true);
    const providers = h.config().Providers;
    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({ name: "workbuddy-ai", api_key: "ccr-managed-workbuddy-ai" });
    expect(h.config().Router.default).toBe("workbuddy-ai,gpt-5.5");
  });
});
