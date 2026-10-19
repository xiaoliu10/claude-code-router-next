import { mkdtempSync, rmSync, readFileSync, statSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkBuddyCredentialStore, WORKBUDDY_CHAT_URL, parseWorkBuddySource, type WorkBuddyCredential } from "../services/workbuddy";
import { WorkBuddyAuthService } from "../services/workbuddy-auth";
import * as configModule from "../ccr/config";

const TOKEN = "super-secret-access-token";
const CRED: WorkBuddyCredential = {
  version: 1,
  kind: "workbuddy",
  tokenType: "",
  uid: "u-1",
  displayName: "Nick",
  domain: "",
  enterpriseId: "",
  accessToken: TOKEN,
  expiresAt: 0,
  importedAt: "2026-10-19T00:00:00.000Z",
  source: "desktop",
};

const SOURCE = JSON.stringify({
  account: { uid: "u-1", nickname: "Nick" },
  auth: { accessToken: TOKEN, refreshToken: "unused-refresh-token" },
});

const configEnv = (models: string[]) => ({
  code: 0,
  msg: "ok",
  data: {
    agents: [{ name: "ide", models: ["not-cli"] }, { name: "cli", models }],
    models: models.map((id) => ({ id, name: id.toUpperCase(), maxInputTokens: 1000, maxOutputTokens: 100, supportsImages: true })),
  },
});

/**
 * Synthetic Response objects have an empty `url`. Real fetch always reports the
 * final URL, and the production redirect check compares it against the fixed
 * upstream origin — so mocks must report the real URL to be faithful.
 */
function jsonEnv(payload: unknown, url = "https://copilot.tencent.com/v3/config"): Response {
  const response = new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
  Object.defineProperty(response, "url", { value: url, configurable: true });
  return response;
}

const noopLog = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

/**
 * Isolated harness: temp CCR config dir, temp credential file, temp source file.
 * Config I/O is spied so nothing ever touches a real config.json.
 */
function harness(options: { source?: string | null; fetch?: any; config?: any } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wb-"));
  const storePath = join(dir, "workbuddy-credentials.json");
  const sourcePath = join(dir, "workbuddy-desktop.info");
  if (options.source !== null && options.source !== undefined) writeFileSync(sourcePath, options.source);
  const config = options.config ?? { Providers: [], Router: { default: "other,model" } };
  const store = new WorkBuddyCredentialStore(storePath);
  const readSource = () => {
    try {
      return parseWorkBuddySource(readFileSync(sourcePath, "utf8"));
    } catch (e: any) {
      return { ok: false, reason: e?.code === "ENOENT" ? "source_missing" : "source_invalid" } as const;
    }
  };
  const service = new WorkBuddyAuthService({
    configService: { get: (k: string) => (config as any)[k], getAll: () => config, reload: vi.fn(), set: vi.fn() },
    logger: noopLog(),
    fetch: options.fetch,
    getServer: () => undefined,
    store,
    readSource,
  });
  return { dir, store, storePath, sourcePath, config, service };
}

beforeEach(() => {
  vi.spyOn(configModule, "readConfigFileRaw").mockImplementation(async () => structuredClone(configs.get("current")));
  vi.spyOn(configModule, "writeConfigFile").mockImplementation(async (cfg: any) => {
    configs.set("current", structuredClone(cfg));
  });
});

const configs = new Map<string, any>();

describe("WorkBuddy credential store", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  function store(): WorkBuddyCredentialStore {
    const dir = mkdtempSync(join(tmpdir(), "wb-store-"));
    dirs.push(dir);
    return new WorkBuddyCredentialStore(join(dir, "workbuddy-credentials.json"));
  }

  it("writes the credential 0600 and reads it back", async () => {
    const s = store();
    await s.save(CRED);
    expect(statSync(s.path).mode & 0o777).toBe(0o600);
    expect((await s.load())?.accessToken).toBe(TOKEN);
  });

  it("never stores or spends a refresh token", async () => {
    // Contract §14.3: only access credentials are stored, never unused refresh secrets.
    const s = store();
    await s.save({ ...CRED, tokenType: "Bearer" });
    const raw = readFileSync(s.path, "utf8");
    expect(raw).not.toContain("refreshToken");
    const loaded = await s.load();
    expect((loaded as any)?.refreshToken).toBeUndefined();
    expect(loaded?.tokenType).toBe("Bearer");
    // currentCredential must not call the network for a token that is not near expiry.
    const service = new WorkBuddyAuthService({ configService: { get: () => undefined, getAll: () => ({}) }, logger: { info() {}, warn() {}, error() {} }, store: s, fetch: (async () => { throw new Error("no upstream call allowed"); }) as any });
    expect(await service.currentCredential()).toMatchObject({ accessToken: CRED.accessToken });
  });

  it("deletes the credential and then reports not connected", async () => {
    const s = store();
    await s.save(CRED);
    expect(await s.load()).not.toBeNull();
    expect(await s.delete()).toBe(true);
    expect(await s.load()).toBeNull();
    expect(await s.delete()).toBe(false);
  });

  it("rejects a credential file with permissive permissions", async () => {
    const s = store();
    await s.save(CRED);
    const { chmodSync } = await import("node:fs");
    chmodSync(s.path, 0o644);
    await expect(s.load()).rejects.toThrow(/重新导入/);
  });

  it("leaves no temp file behind", async () => {
    const s = store();
    await s.save(CRED);
    expect(readdirSync(join(s.path, "..")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("WorkBuddy import flow", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    configs.clear();
    vi.restoreAllMocks();
  });

  it("imports a plain desktop login, discovers models and writes the managed provider", async () => {
    const h = harness({ source: SOURCE, fetch: vi.fn(async () => jsonEnv(configEnv(["glm-5.3", "kimi-k3-1"]))) });
    dirs.push(h.dir);
    configs.set("current", h.config);

    const result = await h.service.importFromLocalDesktop();

    expect(result.success).toBe(true);
    expect(result.status).toBe("connected");
    expect(result.models).toEqual(["glm-5.3", "kimi-k3-1"]);

    // Discovery request: CONFIG UA, fixed origin, allowlisted X-Domain.
    const [url, init] = (h.service as any).options.fetch.mock.calls[0];
    expect(url).toBe("https://copilot.tencent.com/v3/config");
    expect(init.headers["User-Agent"]).toBe("CLI/2.0.0 WorkBuddy/5.5.6");
    expect(init.headers["X-Domain"]).toBe("copilot.tencent.com");
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);

    const written = configs.get("current");
    const managed = written.Providers.find((p: any) => p.name === "workbuddy");
    expect(managed).toMatchObject({
      name: "workbuddy",
      api_base_url: WORKBUDDY_CHAT_URL,
      api_key: "ccr-managed-workbuddy",
      ccr_managed: true,
      workbuddy_kind: "workbuddy",
      transformer: { use: ["workbuddy"] },
      models: ["glm-5.3", "kimi-k3-1"],
    });
    expect(JSON.stringify(written)).not.toContain(TOKEN);
    expect(written.Router).toEqual({ default: "other,model" });
    // Credential persisted privately.
    expect((await h.store.load())?.accessToken).toBe(TOKEN);
  });

  it("keeps the stored credential and models when discovery fails", async () => {
    const existing = { name: "workbuddy", ccr_managed: true, api_base_url: WORKBUDDY_CHAT_URL, api_key: "ccr-managed-workbuddy", models: ["glm-5.3"], transformer: { use: ["workbuddy"] } };
    const h = harness({
      source: SOURCE,
      fetch: vi.fn(async () => new Response("upstream exploded", { status: 500 })),
      config: { Providers: [existing], Router: {} },
    });
    dirs.push(h.dir);
    configs.set("current", h.config);
    await h.store.save(CRED);

    const result = await h.service.importFromLocalDesktop();

    expect(result.success).toBe(false);
    expect(result.reason).toBe("models_fetch_failed");
    expect(result.modelsUnchanged).toBe(true);
    // Nothing was written: the pre-existing provider and credential survive.
    expect(configs.get("current").Providers[0].models).toEqual(["glm-5.3"]);
    expect((await h.store.load())?.accessToken).toBe(TOKEN);
  });

  it("refuses a sealed source without writing anything", async () => {
    const sealed = JSON.stringify({ account: { uid: "u-1" }, auth: { accessToken: { $wbEncrypted: 1, envelope: "x" } } });
    const h = harness({ source: sealed, fetch: vi.fn() });
    dirs.push(h.dir);
    configs.set("current", h.config);

    const result = await h.service.importFromLocalDesktop();
    expect(result).toMatchObject({ success: false, reason: "sealed" });
    expect(existsSync(h.storePath)).toBe(false);
    expect(configs.get("current").Providers).toEqual([]);
  });

  it("reports source_missing without touching config", async () => {
    const h = harness({ source: null, fetch: vi.fn() });
    dirs.push(h.dir);
    configs.set("current", h.config);

    const result = await h.service.importFromLocalDesktop();
    expect(result).toMatchObject({ success: false, reason: "source_missing", modelsUnchanged: true });
    expect(configs.get("current").Providers).toEqual([]);
  });

  it("rejects import when a plain provider already owns the name", async () => {
    const h = harness({
      source: SOURCE,
      fetch: vi.fn(async () => jsonEnv(configEnv(["glm-5.3"]))),
      config: { Providers: [{ name: "workbuddy", api_base_url: "https://other.example/v1", api_key: "k", models: ["x"] }], Router: {} },
    });
    dirs.push(h.dir);
    configs.set("current", h.config);

    const result = await h.service.importFromLocalDesktop();
    expect(result).toMatchObject({ success: false, error: "workbuddy_name_conflict" });
    // Byte-level: config untouched, credential not written.
    expect(configs.get("current").Providers[0].api_base_url).toBe("https://other.example/v1");
    expect(existsSync(h.storePath)).toBe(false);
  });

  it("preserves enabled:false on sync", async () => {
    const h = harness({
      fetch: vi.fn(async () => jsonEnv(configEnv(["glm-5.3", "kimi-k3-1"]))),
      config: { Providers: [{ name: "workbuddy", ccr_managed: true, api_base_url: WORKBUDDY_CHAT_URL, api_key: "ccr-managed-workbuddy", models: ["glm-5.3"], enabled: false, transformer: { use: ["workbuddy"] } }], Router: {} },
    });
    dirs.push(h.dir);
    configs.set("current", h.config);
    await h.store.save(CRED);

    const result = await h.service.syncModels();
    expect(result.success).toBe(true);
    const managed = configs.get("current").Providers.find((p: any) => p.name === "workbuddy");
    expect(managed.enabled).toBe(false);
    expect(managed.models).toEqual(["glm-5.3", "kimi-k3-1"]);
  });

  it("keeps the old model list when a sync discovers nothing", async () => {
    const h = harness({
      fetch: vi.fn(async () => jsonEnv({ code: 0, data: { agents: [{ name: "cli", models: [] }] } })),
      config: { Providers: [{ name: "workbuddy", ccr_managed: true, models: ["glm-5.3"], transformer: { use: ["workbuddy"] } }], Router: {} },
    });
    dirs.push(h.dir);
    configs.set("current", h.config);
    await h.store.save(CRED);

    const result = await h.service.syncModels();
    expect(result).toMatchObject({ success: false, reason: "models_fetch_failed", modelsUnchanged: true });
    expect(configs.get("current").Providers[0].models).toEqual(["glm-5.3"]);
  });

  it("status never reads the desktop source file and reports the private state only", async () => {
    const h = harness({ source: SOURCE, config: { Providers: [{ name: "workbuddy", ccr_managed: true, models: ["glm-5.3"], enabled: true }], Router: {} } });
    dirs.push(h.dir);
    configs.set("current", h.config);
    await h.store.save(CRED);

    const status = await h.service.getStatus();
    expect(status.status).toBe("connected");
    expect(status.models).toEqual(["glm-5.3"]);
    expect(status.modelCount).toBe(1);
    expect(status.uid).toBe("u-1");
    expect(status.providerName).toBe("workbuddy");
    expect(status.site).toBe("https://copilot.tencent.com");
    expect(JSON.stringify(status)).not.toContain(TOKEN);
  });

  it("status reports expired for a lapsed access token and not_connected with no file", async () => {
    const h = harness({ source: null });
    dirs.push(h.dir);
    expect((await h.service.getStatus()).status).toBe("not_connected");
    await h.store.save({ ...CRED, expiresAt: Date.now() - 1000 });
    expect((await h.service.getStatus()).status).toBe("expired");
  });

  it("disconnect removes the provider and credential but leaves Router identical", async () => {
    const router = { default: "other,model", longContext: ["workbuddy,glm-5.3"] };
    const h = harness({
      source: null,
      config: { Providers: [
        { name: "other", api_base_url: "https://x", api_key: "k", models: ["m"] },
        { name: "workbuddy", ccr_managed: true, api_base_url: WORKBUDDY_CHAT_URL, api_key: "ccr-managed-workbuddy", models: ["glm-5.3"], transformer: { use: ["workbuddy"] } },
      ], Router: router },
    });
    dirs.push(h.dir);
    configs.set("current", h.config);
    await h.store.save(CRED);

    const result = await h.service.disconnect();

    expect(result).toEqual({ success: true, removedProvider: true, deletedCredential: true });
    const written = configs.get("current");
    expect(written.Providers.map((p: any) => p.name)).toEqual(["other"]);
    expect(written.Router).toEqual(router);
    expect(JSON.stringify(written)).not.toContain(TOKEN);
    expect(existsSync(h.storePath)).toBe(false);
  });

  it("coalesces concurrent syncs into one upstream call", async () => {
    const h = harness({ source: null, fetch: vi.fn(async () => jsonEnv(configEnv(["glm-5.3"]))) });
    dirs.push(h.dir);
    configs.set("current", h.config);
    await h.store.save(CRED);

    const [a, b] = await Promise.all([h.service.syncModels(), h.service.syncModels()]);
    expect((h.service as any).options.fetch).toHaveBeenCalledTimes(1);
    expect(a.success && b.success).toBe(true);
  });
});

describe("WorkBuddy credits summary (contract §14.4)", () => {
  it("uses the enterprise meter when the summary grants no personal packages", async () => {
    const fetchMock = vi.fn(async (url: any, init: any) => {
      expect(init.headers["X-Enterprise-Id"]).toBe("team");
      expect(init.headers["User-Agent"]).toBe("WorkBuddy/5.5.6");
      return jsonEnv(String(url).endsWith("get-user-resource-summary")
        ? { code: 0, data: { Packages: [] } }
        : { code: 0, data: { credit: "7.5", limitNum: "100" } });
    });
    const h = harness({ fetch: fetchMock });
    dirs.push(h.dir);
    await h.store.save({ ...CRED, enterpriseId: "team" });
    expect(await h.service.getUsage()).toEqual({ plan: "Enterprise", used: 7.5, limit: 100, unit: "credits" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  it("returns derived credits numbers for a personal account", async () => {
    const fetchMock = vi.fn(async () => jsonEnv({
      code: 0, data: { IsPaidUser: true, Packages: [
        { CycleUsedCapacity: "12.5", CycleTotalCapacity: "100" },
        { CycleUsedCapacity: "0", CycleTotalCapacity: "0" },
      ] },
    }, "https://copilot.tencent.com/billing/meter/get-user-resource-summary"));
    const h = harness({ source: null, fetch: fetchMock });
    dirs.push(h.dir);
    await h.store.save(CRED);

    const usage = await h.service.getUsage();
    expect(usage).toEqual({ plan: "Pro", used: 12.5, limit: 100, unit: "credits" });
    // The request is a tiny POST to the fixed origin, never the chat endpoint.
    const [url, init] = fetchMock.mock.calls[0] as any;
    expect(url).toBe("https://copilot.tencent.com/billing/meter/get-user-resource-summary");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(String(init.body)).toBe("{}");
  });

  it("reports Free for an unpaid account", async () => {
    const h = harness({ source: null, fetch: vi.fn(async () => jsonEnv({
      code: 0, data: { IsPaidUser: false, Packages: [{ CycleUsedCapacity: "1", CycleTotalCapacity: "10" }] },
    })) });
    dirs.push(h.dir);
    await h.store.save(CRED);
    expect(await h.service.getUsage()).toEqual({ plan: "Free", used: 1, limit: 10, unit: "credits" });
  });

  it("returns null (never throws) when the meter fails, is refused or grants nothing", async () => {
    const cases: Array<[string, any]> = [
      ["network failure", vi.fn(async () => { throw new Error("ECONNRESET"); })],
      ["http 500", vi.fn(async () => new Response("{}", { status: 500 }))],
      ["upstream code", vi.fn(async () => jsonEnv({ code: 401, msg: "token invalid" }))],
      ["no packages", vi.fn(async () => jsonEnv({ code: 0, data: { IsPaidUser: false, Packages: [] } }))],
      ["non-json body", vi.fn(async () => new Response("<html>", { status: 200, headers: { "Content-Type": "text/html" } }))],
    ];
    for (const [label, fetchMock] of cases) {
      const h = harness({ source: null, fetch: fetchMock });
      dirs.push(h.dir);
      await h.store.save(CRED);
      expect(await h.service.getUsage(), label).toBeNull();
    }
  });

  it("returns null when no credential is stored", async () => {
    const h = harness({ source: null, fetch: vi.fn(async () => jsonEnv({ code: 0, data: {} })) });
    dirs.push(h.dir);
    expect(await h.service.getUsage()).toBeNull();
    expect((h.service as any).options.fetch).not.toHaveBeenCalled();
  });

  it("asks the international site's meter for an international credential", async () => {
    const fetchMock = vi.fn(async () => jsonEnv({
      code: 0, data: { IsPaidUser: false, Packages: [{ CycleUsedCapacity: "2", CycleTotalCapacity: "20" }] },
    }, "https://www.workbuddy.ai/billing/meter/get-user-resource-summary"));
    const h = harness({ source: null, fetch: fetchMock });
    dirs.push(h.dir);
    await h.store.save({ ...CRED, kind: "workbuddy-ai", domain: "www.workbuddy.ai" });
    expect(await h.service.getUsage()).toEqual({ plan: "Free", used: 2, limit: 20, unit: "credits" });
    expect((fetchMock.mock.calls[0] as any)[0]).toBe("https://www.workbuddy.ai/billing/meter/get-user-resource-summary");
    // The international build's attribution header rides along.
    const headers = (fetchMock.mock.calls[0] as any)[1].headers;
    expect(headers["X-Agent-Type"]).toBe("main");
    expect(headers["X-Domain"]).toBe("www.workbuddy.ai");
  });
});
