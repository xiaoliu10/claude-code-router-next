/**
 * WorkBuddy §16 milestone C: the admin management API surface.
 *
 * Focus is the ROUTE layer (not the service, covered by
 * workbuddy-pool-service.test.ts): the local socket guard, strict
 * site/uid/model validation, sanitized allowlisted errors, the per-site pool
 * map with its legacy single-site mirror, the hide/restore seam the UI needs
 * (`clearedRefs` Router paths + `removedModelRefs` actual refs +
 * `defaultFallback`), site-specific disconnect, and the recoverable provider
 * migration that must run before the first pool/management call.
 *
 * No real credential file is read, no real upstream is contacted (fetch is
 * stubbed), and no config outside the temp dir is touched.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import Server from "../../../core/src/server";
import { registerWorkBuddyAdminRoutes } from "../src/admin-routes";
import { WorkBuddyAuthService } from "../src/auth-service";
import { protectWorkBuddyConfig, WorkBuddyCredentialStore, type WorkBuddyCredential } from "../src/protocol";
import * as configModule from "../../../core/src/ccr/config";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const CRED = (extra: Partial<WorkBuddyCredential> = {}): WorkBuddyCredential => ({
  version: 1,
  kind: "workbuddy",
  uid: "u-1",
  displayName: "Nick",
  domain: "",
  enterpriseId: "",
  accessToken: "secret-access-token",
  expiresAt: Date.now() + 3_600_000,
  importedAt: "2026-10-19T00:00:00.000Z",
  source: "desktop",
  tokenType: "",
  ...extra,
});

const CN_PROVIDER = (models: string[] = ["glm-5.3", "kimi-k3-1"]) => ({
  name: "workbuddy", ccr_managed: true, workbuddy_kind: "workbuddy",
  api_base_url: "https://copilot.tencent.com/v2/chat/completions",
  api_key: "ccr-managed-workbuddy", models, transformer: { use: ["workbuddy"] },
});

const AI_PROVIDER = (models: string[] = ["gpt-5.5"]) => ({
  name: "workbuddy-ai", ccr_managed: true, workbuddy_kind: "workbuddy-ai",
  api_base_url: "https://www.workbuddy.ai/v2/chat/completions",
  api_key: "ccr-managed-workbuddy-ai", models, transformer: { use: ["workbuddy"] },
});

/** No test may reach a real upstream: fetch always rejects unless a test overrides it. */
function offlineFetch() {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network disabled in test"); }));
}

async function build(config: any) {
  const dir = mkdtempSync(join(tmpdir(), "wb-routes-"));
  dirs.push(dir);
  offlineFetch();
  const store = new WorkBuddyCredentialStore(join(dir, "creds.json"));
  // Mutable config holder: writeConfigFile lands here so assertions see the
  // persisted state, and readConfigFileRaw always returns a fresh copy.
  const live = { current: structuredClone(config) };
  vi.spyOn(configModule, "readConfigFileRaw").mockImplementation(async () => structuredClone(live.current));
  vi.spyOn(configModule, "readConfigFile").mockImplementation(async () => structuredClone(live.current));
  vi.spyOn(configModule, "writeConfigFile").mockImplementation(async (next: any) => { live.current = structuredClone(next); });
  vi.spyOn(configModule, "backupConfigFile").mockResolvedValue(null);
  const server = new Server({
    logger: false,
    useJsonFile: false,
    initialConfig: { providers: config.Providers, Router: config.Router, HOST: "127.0.0.1", PORT: 0 },
  });
  await server.ready();
  // The plugin owns its route section; register ONLY it against the app (the
  // core's built-in section is gone once the migration hard-cut lands).
  registerWorkBuddyAdminRoutes(server.app as any, { getService: () => service });
  await server.registerNamespace("/");
  await server.app.ready();
  const service = new WorkBuddyAuthService({
    configService: {
      get: (key: string) => (live.current as any)?.[key],
      getAll: () => live.current,
      reload: vi.fn(),
      set: vi.fn(),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    store,
    readSource: () => ({ ok: false, reason: "source_missing" }),
    host: {
      readRawConfig: () => configModule.readConfigFileRaw(),
      writeConfig: (next: any) => configModule.writeConfigFile(next),
      reloadRuntime: () => {},
      getDirectDispatcher: () => undefined,
    },
  });
  const url = (path: string) => `http://localhost:3456${path}`;
  return { server, store, service, dir, url, config: () => live.current };
}

async function seedBothSites(store: WorkBuddyCredentialStore) {
  await store.upsertAccount(CRED({ uid: "cn-a", accessToken: "token-cn-a", importedAt: "2026-10-19T01:00:00.000Z" }));
  await store.upsertAccount(CRED({ uid: "cn-b", accessToken: "token-cn-b", importedAt: "2026-10-19T02:00:00.000Z" }));
  await store.upsertAccount(CRED({
    kind: "workbuddy-ai", uid: "ai-a", domain: "www.workbuddy.ai",
    accessToken: "token-ai-a", importedAt: "2026-10-19T03:00:00.000Z",
  }));
  await store.mergeDiscoveredModels("workbuddy", ["glm-5.3", "kimi-k3-1"]);
  await store.mergeDiscoveredModels("workbuddy-ai", ["gpt-5.5"]);
}

describe("WorkBuddy admin pool status routes", () => {
  it("GET /status returns the §16 sites map alongside the legacy flat mirror", async () => {
    const h = await build({ Providers: [CN_PROVIDER(), AI_PROVIDER()], Router: { default: "workbuddy,glm-5.3" } });
    await seedBothSites(h.store);
    const res = await h.server.app.inject({ method: "GET", url: h.url("/api/workbuddy/status") });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    // Legacy single-site mirror (existing UI keeps working unchanged).
    expect(json).toMatchObject({ status: "connected", kind: "workbuddy", providerName: "workbuddy", uid: "cn-a" });
    expect(Array.isArray(json.models)).toBe(true);
    // §16 sites map + connected list.
    expect(json.connectedSites).toEqual(["workbuddy", "workbuddy-ai"]);
    expect(json.sites.workbuddy).toMatchObject({ providerName: "workbuddy", activeUid: "cn-a" });
    expect(json.sites.workbuddy.accounts.map((a: any) => a.uid)).toEqual(["cn-a", "cn-b"]);
    expect(json.sites["workbuddy-ai"]).toMatchObject({ providerName: "workbuddy-ai", activeUid: "ai-a" });
    // Sanitized: no token material anywhere in the payload.
    expect(res.body).not.toContain("token-cn-a");
    expect(res.body).not.toContain("token-ai-a");
    expect(res.body).not.toContain("accessToken");
  });

  it("GET /pool exposes per-site pools and rejects a non-loopback caller", async () => {
    const h = await build({ Providers: [CN_PROVIDER()], Router: {} });
    await seedBothSites(h.store);
    const ok = await h.server.app.inject({ method: "GET", url: h.url("/api/workbuddy/pool") });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, connectedSites: ["workbuddy", "workbuddy-ai"] });
    expect(ok.json().sites.workbuddy.hiddenModels).toEqual([]);
    // The socket guard is the only identity: a routed (non-loopback) caller is
    // refused even with a perfectly matching Origin/Host header.
    const denied = await h.server.app.inject({
      method: "GET",
      url: h.url("/api/workbuddy/pool"),
      remoteAddress: "203.0.113.7",
      headers: { origin: "http://localhost:3456", host: "localhost:3456" },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ error: "workbuddy_unauthorized" });
  });

  it("GET /status and /pool carry imagesUnsupportedModels and a CLASSIFIED lastError, never persisted text", async () => {
    const h = await build({ Providers: [CN_PROVIDER(), AI_PROVIDER()], Router: { default: "workbuddy,glm-5.3" } });
    await seedBothSites(h.store);
    await h.store.mergeDiscoveredModels("workbuddy-ai", ["glm-5.3", "gpt-5.5"]);
    // Poison the vestigial persisted field exactly as a future writer could.
    const data = await h.store.loadData();
    data!.sites["workbuddy-ai"]!.lastError = "RAW-SENTINEL-<script>alert(1)</script> /Users/jason/secrets.json";
    await h.store.saveData(data!);
    for (const path of ["/api/workbuddy/status", "/api/workbuddy/pool"]) {
      const res = await h.server.app.inject({ method: "GET", url: h.url(path) });
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.sites["workbuddy-ai"]).toMatchObject({ lastError: "workbuddy_error", imagesUnsupportedModels: ["glm-5.3"] });
      expect(json.sites.workbuddy).toMatchObject({ lastError: null, imagesUnsupportedModels: [] });
      // No raw persisted text, path or HTML ever reaches an API body.
      expect(res.body).not.toContain("RAW-SENTINEL");
      expect(res.body).not.toContain("/Users/jason");
      expect(res.body).not.toContain("<script>");
    }
    // The legacy flat mirror stays classified too (it mirrors the CN site here).
    const flat = await h.server.app.inject({ method: "GET", url: h.url("/api/workbuddy/status") });
    expect(flat.json().lastError ?? null).toBeNull();
  });
});

describe("WorkBuddy admin account routes", () => {
  it("POST /account/switch moves the sticky active uid and validates its inputs", async () => {
    const h = await build({ Providers: [CN_PROVIDER()], Router: {} });
    await seedBothSites(h.store);
    const res = await h.server.app.inject({
      method: "POST", url: h.url("/api/workbuddy/account/switch"),
      payload: { site: "workbuddy", uid: "cn-b" },
    });
    expect(res.statusCode).toBe(200);
    // The UI's `run()` tail is `if (!result.success) setSiteError(...)` and the
    // client type declares `success: boolean` REQUIRED: an exact 200 body must
    // satisfy that predicate or a performed switch is reported as a failure
    // (and the status refresh is skipped). Mirrors the client helper.
    const body = res.json();
    expect(body).toEqual({ ok: true, success: true, site: "workbuddy", uid: "cn-b" });
    const uiSuccess = typeof body === "object" && body !== null && (body as { success?: unknown }).success === true;
    expect(uiSuccess).toBe(true);
    expect((await h.store.loadData())!.sites.workbuddy!.activeUid).toBe("cn-b");

    // Unknown site id: rejected before it can reach the service.
    const badSite = await h.server.app.inject({
      method: "POST", url: h.url("/api/workbuddy/account/switch"),
      payload: { site: "https://evil.example", uid: "cn-a" },
    });
    expect(badSite.statusCode).toBe(422);
    expect(badSite.json()).toEqual({ ok: false, error: "source_invalid" });

    // Missing uid.
    const noUid = await h.server.app.inject({
      method: "POST", url: h.url("/api/workbuddy/account/switch"), payload: { site: "workbuddy" },
    });
    expect(noUid.statusCode).toBe(422);

    // Unknown uid: allowlisted 404 code, no raw store error text.
    const unknown = await h.server.app.inject({
      method: "POST", url: h.url("/api/workbuddy/account/switch"),
      payload: { site: "workbuddy", uid: "nope" },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ ok: false, error: "workbuddy_account_not_found" });
  });

  it("POST /account/remove empties one site's pool with SITE-SPECIFIC disconnect semantics", async () => {
    const router = { default: "other,m", think: "workbuddy-ai,gpt-5.5" };
    const h = await build({ Providers: [{ name: "other", api_base_url: "https://x/v1", api_key: "k", models: ["m"] }, CN_PROVIDER(), AI_PROVIDER()], Router: router });
    await seedBothSites(h.store);
    const res = await h.server.app.inject({
      method: "POST", url: h.url("/api/workbuddy/account/remove"),
      payload: { site: "workbuddy-ai", uid: "ai-a" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, poolEmpty: true, removedProvider: true });
    expect(res.json().notice).toContain("Router");
    // Only the AI site was disconnected: the CN provider and pool survive.
    expect(h.config().Providers.map((p: any) => p.name)).toEqual(["other", "workbuddy"]);
    const data = (await h.store.loadData())!;
    expect(data.sites["workbuddy-ai"]).toBeUndefined();
    expect(data.sites.workbuddy!.accounts.map((a) => a.uid)).toEqual(["cn-a", "cn-b"]);
    // Router references are RETAINED on disconnect (never rewritten here).
    expect(h.config().Router).toEqual(router);

    // Removing a non-existent account is an allowlisted 404, not a 500.
    const again = await h.server.app.inject({
      method: "POST", url: h.url("/api/workbuddy/account/remove"),
      payload: { site: "workbuddy", uid: "ghost" },
    });
    expect(again.statusCode).toBe(404);
    expect(again.json()).toMatchObject({ ok: false, error: "workbuddy_account_not_found" });
  });
});

describe("WorkBuddy admin sync / disconnect / usage routes", () => {
  it("POST /disconnect with a site removes only that site, keeping the legacy global reset", async () => {
    const h = await build({ Providers: [CN_PROVIDER(), AI_PROVIDER()], Router: { default: "workbuddy,glm-5.3" } });
    await seedBothSites(h.store);
    const res = await h.server.app.inject({
      method: "POST", url: h.url("/api/workbuddy/disconnect"), payload: { site: "workbuddy-ai" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, site: "workbuddy-ai", success: true, removedProvider: true });
    expect(h.config().Providers.map((p: any) => p.name)).toEqual(["workbuddy"]);
    expect((await h.store.loadData())!.sites.workbuddy).toBeDefined();

    // An invalid site is rejected instead of silently falling back to a full reset.
    const bad = await h.server.app.inject({
      method: "POST", url: h.url("/api/workbuddy/disconnect"), payload: { site: "workbuddy2" },
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json()).toEqual({ ok: false, error: "source_invalid" });

    // Legacy body-less call still disconnects every connected site.
    const legacy = await h.server.app.inject({ method: "POST", url: h.url("/api/workbuddy/disconnect"), payload: {} });
    expect(legacy.statusCode).toBe(200);
    expect(legacy.json()).toMatchObject({ ok: true, site: null, success: true });
    expect(h.config().Providers).toEqual([]);
  });

  it("POST /sync accepts an optional site and rejects an invalid one", async () => {
    const h = await build({ Providers: [CN_PROVIDER()], Router: {} });
    await seedBothSites(h.store);
    const bad = await h.server.app.inject({ method: "POST", url: h.url("/api/workbuddy/sync"), payload: { site: "workbuddy-ai-evil" } });
    expect(bad.statusCode).toBe(422);
    expect(bad.json()).toMatchObject({ success: false, reason: "source_invalid", modelsUnchanged: true });
    // Offline discovery: sanitized failure, previous model list retained.
    const res = await h.server.app.inject({ method: "POST", url: h.url("/api/workbuddy/sync"), payload: { site: "workbuddy" } });
    expect(res.statusCode).toBe(422);
    const json = res.json();
    expect(json).toMatchObject({ success: false, reason: "models_fetch_failed", modelsUnchanged: true });
    expect(json.message).not.toContain("network disabled in test");
    expect(h.config().Providers[0].models).toEqual(["glm-5.3", "kimi-k3-1"]);
  });

  it("usage routes report only derived numbers for an optional site/uid selector", async () => {
    const h = await build({ Providers: [CN_PROVIDER()], Router: {} });
    await seedBothSites(h.store);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      code: 0,
      data: { IsPaidUser: false, Packages: [{ CycleUsedCapacity: 30, CycleTotalCapacity: 100, InternalId: "pkg-secret-id" }] },
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const res = await h.server.app.inject({
      method: "POST", url: h.url("/api/workbuddy/usage"), payload: { site: "workbuddy", uid: "cn-b" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, usage: { plan: "Free", used: 30, limit: 100, unit: "credits" } });
    expect(res.body).not.toContain("pkg-secret-id");
    // Legacy GET without a selector still works.
    const legacy = await h.server.app.inject({ method: "GET", url: h.url("/api/workbuddy/usage") });
    expect(legacy.statusCode).toBe(200);
    expect(legacy.json().usage).toMatchObject({ used: 30, limit: 100 });
    // GET with an invalid selector is a 422, never a silent global fallback.
    const bad = await h.server.app.inject({ method: "GET", url: h.url("/api/workbuddy/usage?site=evil") });
    expect(bad.statusCode).toBe(422);
    expect(bad.json()).toEqual({ error: "source_invalid" });
  });
});

describe("WorkBuddy admin model hide/restore seam (UI contract)", () => {
  it("POST /models/hide returns Router paths AND the actual removed provider,model refs", async () => {
    const router = {
      default: "workbuddy,glm-5.3",
      think: "workbuddy,glm-5.3",
      longContext: ["workbuddy,glm-5.3", "other,m"],
      models: { "alias-1": "workbuddy,glm-5.3", "alias-2": "other,m" },
    };
    const h = await build({ Providers: [CN_PROVIDER()], Router: router });
    await seedBothSites(h.store);
    const res = await h.server.app.inject({
      method: "POST", url: h.url("/api/workbuddy/models/hide"),
      payload: { site: "workbuddy", model: "glm-5.3" },
    });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json).toMatchObject({ ok: true, success: true, site: "workbuddy", model: "glm-5.3" });
    // clearedRefs are ROUTER FIELD PATHS (what the toast labels).
    expect(json.clearedRefs).toEqual(["default", "scenario:think", "scenario:longContext", "models:alias-1"]);
    // removedModelRefs are the ACTUAL refs the UI reconciles locally.
    expect(json.removedModelRefs).toEqual(["workbuddy,glm-5.3"]);
    // defaultFallback comes from the PERSISTED config after the rewrite.
    expect(json.defaultFallback).toBe("workbuddy,kimi-k3-1");
    expect(json.models).toEqual(["kimi-k3-1"]);
    // Persisted effects.
    expect(h.config().Router.default).toBe("workbuddy,kimi-k3-1");
    expect(h.config().Router.think).toBe("");
    expect(h.config().Router.longContext).toEqual(["other,m"]);
    expect(h.config().Router.models).toEqual({ "alias-2": "other,m" });
    expect((await h.store.loadData())!.sites.workbuddy!.hiddenModels).toEqual(["glm-5.3"]);
    // Sanitized payload: no credential material.
    expect(res.body).not.toContain("token-cn-a");
    expect(res.body).not.toContain("accessToken");
  });

  it("POST /models/hide validates site/model and reports a not-connected site as 409", async () => {
    const h = await build({ Providers: [CN_PROVIDER()], Router: { default: "workbuddy,glm-5.3" } });
    await seedBothSites(h.store);
    const badModel = await h.server.app.inject({
      method: "POST", url: h.url("/api/workbuddy/models/hide"),
      payload: { site: "workbuddy", model: "glm,5.3" },
    });
    expect(badModel.statusCode).toBe(422);
    expect(badModel.json()).toEqual({ ok: false, error: "source_invalid" });
    const badSite = await h.server.app.inject({
      method: "POST", url: h.url("/api/workbuddy/models/hide"), payload: { site: "workbuddyy", model: "glm-5.3" },
    });
    expect(badSite.statusCode).toBe(422);
    // A site with no pool: allowlisted 409 (not a raw service dump).
    await h.store.deleteSite("workbuddy-ai");
    const notConnected = await h.server.app.inject({
      method: "POST", url: h.url("/api/workbuddy/models/hide"),
      payload: { site: "workbuddy-ai", model: "gpt-5.5" },
    });
    expect(notConnected.statusCode).toBe(409);
    expect(notConnected.json()).toMatchObject({ ok: false, error: "workbuddy_not_connected" });
    // Nothing was written by the rejected calls.
    expect(h.config().Router).toEqual({ default: "workbuddy,glm-5.3" });
  });

  it("POST /models/restore restores one model or all, and never rewrites Router", async () => {
    const router = { default: "workbuddy,kimi-k3-1", think: "" };
    const h = await build({ Providers: [CN_PROVIDER(["kimi-k3-1"])], Router: router });
    await seedBothSites(h.store);
    await h.store.setHiddenModels("workbuddy", ["glm-5.3", "gone-model"]);
    const one = await h.server.app.inject({
      method: "POST", url: h.url("/api/workbuddy/models/restore"),
      payload: { site: "workbuddy", model: "glm-5.3" },
    });
    expect(one.statusCode).toBe(200);
    expect(one.json()).toMatchObject({ ok: true, restored: ["glm-5.3"] });
    expect(one.json().models).toContain("glm-5.3");
    expect(h.config().Router).toEqual(router); // restore never re-wires
    const all = await h.server.app.inject({
      method: "POST", url: h.url("/api/workbuddy/models/restore"), payload: { site: "workbuddy" },
    });
    expect(all.statusCode).toBe(200);
    expect(all.json()).toMatchObject({ ok: true, restored: ["gone-model"] });
    expect((await h.store.loadData())!.sites.workbuddy!.hiddenModels).toEqual([]);
    expect(h.config().Router).toEqual(router);
  });
});

describe("WorkBuddy §16 provider migration gate", () => {
  it("renames a legacy AI provider (and its Router refs) before the first pool call", async () => {
    // Pre-§16 shape: the INTERNATIONAL credential lived under the name "workbuddy".
    const h = await build({
      Providers: [{
        name: "workbuddy", ccr_managed: true, workbuddy_kind: "workbuddy-ai",
        api_base_url: "https://www.workbuddy.ai/v2/chat/completions",
        api_key: "ccr-managed-workbuddy-ai", models: ["gpt-5.5"], transformer: { use: ["workbuddy"] },
      }],
      Router: { default: "workbuddy,gpt-5.5", models: { "alias-1": "workbuddy,gpt-5.5" } },
    });
    await h.store.upsertAccount(CRED({
      kind: "workbuddy-ai", uid: "ai-a", domain: "www.workbuddy.ai", accessToken: "token-ai-a",
    }));
    await h.store.mergeDiscoveredModels("workbuddy-ai", ["gpt-5.5"]);

    const res = await h.server.app.inject({ method: "GET", url: h.url("/api/workbuddy/pool") });
    expect(res.statusCode).toBe(200);
    // Migration ran before the pool read: the provider is now the AI identity…
    const provider = h.config().Providers[0];
    expect(provider.name).toBe("workbuddy-ai");
    expect(provider.api_key).toBe("ccr-managed-workbuddy-ai");
    expect(provider.api_base_url).toBe("https://www.workbuddy.ai/v2/chat/completions");
    // …and its Router references were rewritten (no data loss).
    expect(h.config().Router).toEqual({ default: "workbuddy-ai,gpt-5.5", models: { "alias-1": "workbuddy-ai,gpt-5.5" } });
    expect(res.json().sites["workbuddy-ai"]).toMatchObject({ providerName: "workbuddy-ai", activeUid: "ai-a" });
    expect(res.body).not.toContain("token-ai-a");
  });

  it("fails closed (no rename, no write) when a plain provider squats the managed AI name", async () => {
    const h = await build({
      Providers: [
        { name: "workbuddy", ccr_managed: true, workbuddy_kind: "workbuddy-ai", api_base_url: "https://www.workbuddy.ai/v2/chat/completions", api_key: "ccr-managed-workbuddy-ai", models: ["gpt-5.5"], transformer: { use: ["workbuddy"] } },
        { name: "workbuddy-ai", api_base_url: "https://user.example/v1", api_key: "user-key", models: ["m"] },
      ],
      Router: { default: "workbuddy,gpt-5.5" },
    });
    await h.store.upsertAccount(CRED({ kind: "workbuddy-ai", uid: "ai-a", domain: "www.workbuddy.ai" }));
    const res = await h.server.app.inject({ method: "GET", url: h.url("/api/workbuddy/pool") });
    // Status still answers (the gate never blocks the read)…
    expect(res.statusCode).toBe(200);
    // …but nothing was renamed or rewritten.
    expect(h.config().Providers[0].name).toBe("workbuddy");
    expect(h.config().Router).toEqual({ default: "workbuddy,gpt-5.5" });
  });
});

describe("WorkBuddy generic config protections cover both sites", () => {
  it("a generic save cannot rewrite or drop either managed provider", async () => {
    const h = await build({ Providers: [CN_PROVIDER(), AI_PROVIDER()], Router: { default: "workbuddy,glm-5.3" } });
    await seedBothSites(h.store);
    // Hostile generic save: both managed entries redirected and omitted. The
    // core POST /api/config route invokes exactly this protector through the
    // plugin registry before writing; drive it directly here (the route
    // itself is core surface covered by the core suite).
    const next: any = {
      Providers: [{ name: "workbuddy", api_base_url: "https://attacker.example/v1", api_key: "attacker", models: ["evil"] }],
      Router: { default: "workbuddy,glm-5.3" },
    };
    protectWorkBuddyConfig(next, structuredClone(h.config()));
    h.config; // (config holder untouched: the protector mutates the draft only)
    const providers = next.Providers;
    const cn = providers.find((p: any) => p.name === "workbuddy");
    const ai = providers.find((p: any) => p.name === "workbuddy-ai");
    // CN entry re-locked to the fixed identity/origin, AI entry resurrected.
    expect(cn).toMatchObject({ ccr_managed: true, api_key: "ccr-managed-workbuddy", api_base_url: "https://copilot.tencent.com/v2/chat/completions" });
    expect(cn.transformer).toEqual({ use: ["workbuddy"] });
    expect(ai).toMatchObject({ ccr_managed: true, api_key: "ccr-managed-workbuddy-ai", api_base_url: "https://www.workbuddy.ai/v2/chat/completions" });
    expect(next.Providers.some((p: any) => p.api_base_url === "https://attacker.example/v1")).toBe(false);
  });
});

describe("WorkBuddy browser login through the real admin routes", () => {
  const AI_JOBS = [
    { state: "state-a", uid: "ai-a", displayName: "Account A", accessToken: "token-a" },
    { state: "state-b", uid: "ai-b", displayName: "Account B", accessToken: "token-b" },
  ];
  /** Real login flow fetch (state → token → account → discovery), distinct per started job. */
  const env = (data: any, url: string) => {
    const r = new Response(JSON.stringify({ code: 0, data, msg: "" }), { status: 200, headers: { "content-type": "application/json" } });
    Object.defineProperty(r, "url", { value: url });
    return r;
  };
  const aiLoginFetch = () => {
    let issued = 0;
    return vi.fn(async (url: any, init: any) => {
      const origin = "https://www.workbuddy.ai";
      const u = String(url);
      if (u.startsWith(origin) && u.includes("auth/state")) {
        const next = AI_JOBS[issued++];
        return env({ state: next.state, authUrl: "https://www.codebuddy.ai/login?state=" + next.state }, u);
      }
      if (u.startsWith(origin)) {
        const state = new URL(u).searchParams.get("state") ?? "";
        const account = AI_JOBS.find((j) => j.state === state) ?? AI_JOBS[0];
        if (u.includes("auth/token?")) return env({ accessToken: account.accessToken, refreshToken: "refresh-" + account.uid, expiresIn: 3600 }, u);
        if (u.includes("login/account")) return env({ uid: account.uid, nickname: account.displayName, type: "personal" }, u);
        return env({ agents: [{ name: "cli", models: ["gpt-5.5"] }], models: [{ id: "gpt-5.5" }] }, u);
      }
      throw new Error("unexpected fetch " + u);
    });
  };
  const browserLogin = async (h: Awaited<ReturnType<typeof build>>, site: string) => {
    const start = await h.server.app.inject({ method: "POST", url: h.url("/api/workbuddy/login/start"), payload: { site } });
    expect(start.statusCode).toBe(200);
    expect(start.json()).toMatchObject({ ok: true, site });
    const poll = await h.server.app.inject({ method: "POST", url: h.url("/api/workbuddy/login/poll"), payload: { site, loginId: start.json().loginId } });
    expect(poll.statusCode).toBe(200);
    return poll.json();
  };

  it("AI A then AI B through /login/start + /login/poll => GET /status sites[workbuddy-ai].accounts 2, poll carries outcome metadata", async () => {
    const h = await build({ Providers: [], Router: {} });
    vi.stubGlobal("fetch", aiLoginFetch());
    const a = await browserLogin(h, "workbuddy-ai");
    expect(a).toMatchObject({ status: "connected", success: true, accountChange: "added", accountCount: 1 });
    const b = await browserLogin(h, "workbuddy-ai");
    expect(b).toMatchObject({ status: "connected", success: true, accountChange: "added", accountCount: 2 });
    // The exact endpoint the UI refreshes after login reports BOTH rows.
    const status = await h.server.app.inject({ method: "GET", url: h.url("/api/workbuddy/status") });
    expect(status.statusCode).toBe(200);
    const accounts = status.json().sites["workbuddy-ai"].accounts;
    expect(accounts.map((x: any) => x.uid)).toEqual(["ai-a", "ai-b"]);
    // Tokens/refresh material never leak through the poll or status bodies.
    expect(status.body).not.toContain("token-a");
    expect(JSON.stringify([a, b])).not.toContain("refresh-");
  });
});
