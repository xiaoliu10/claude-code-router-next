import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkBuddyAuthService } from "../services/workbuddy-auth";
import { WorkBuddyCredentialStore, createWorkBuddyLoginState, fetchWorkBuddyLoginAccount, pollWorkBuddyLoginToken, refreshWorkBuddyToken, type WorkBuddyCredential, type WorkBuddySiteId } from "../services/workbuddy";
import * as configModule from "../ccr/config";

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const credential = (extra: Partial<WorkBuddyCredential> = {}): WorkBuddyCredential => ({
  version: 1, kind: "workbuddy", uid: "browser-user", displayName: "Browser account", domain: "copilot.tencent.com", enterpriseId: "",
  accessToken: "browser-access", refreshToken: "browser-refresh", expiresAt: Date.now() + 60000,
  importedAt: new Date().toISOString(), source: "browser", ...extra,
});
const env = (data: any, url = "https://copilot.tencent.com/v3/config", code = 0, status = 200) => {
  const r = new Response(JSON.stringify({ code, data, msg: "secret-must-not-escape" }), { status, headers: { "content-type": "application/json" } });
  Object.defineProperty(r, "url", { value: url }); return r;
};
const discovery = () => env({ agents: [{ name: "cli", models: ["glm-5.3"] }], models: [{ id: "glm-5.3" }] });
function harness(fetch: any, reader = vi.fn(() => ({ ok: false, reason: "source_missing" }))) {
  const dir = mkdtempSync(join(tmpdir(), "wb-browser-")); dirs.push(dir);
  let config: any = { Providers: [], Router: { default: "other,model" } };
  vi.spyOn(configModule, "readConfigFileRaw").mockImplementation(async () => structuredClone(config));
  const write = vi.spyOn(configModule, "writeConfigFile").mockImplementation(async (next) => { config = structuredClone(next); });
  const store = new WorkBuddyCredentialStore(join(dir, "private.json"));
  const service = new WorkBuddyAuthService({ store, fetch, readSource: reader as any, logger: { warn: vi.fn(), error: vi.fn() }, configService: { getAll: () => config, get: (key: string) => config[key] } });
  return { service, store, write, reader, config: () => config };
}
const flowFetch = (site: WorkBuddySiteId = "workbuddy") => vi.fn(async (url: string, init: any) => {
  const origin = site === "workbuddy" ? "https://copilot.tencent.com" : "https://www.workbuddy.ai";
  expect(url.startsWith(origin + "/")).toBe(true); expect(init.redirect).toBe("error"); expect(init.dispatcher).toBeDefined();
  if (url.includes("auth/state")) return env({ state: "private-state", authUrl: origin + "/login" }, url);
  if (url.includes("auth/token?")) return env({ accessToken: "browser-access", refreshToken: "browser-refresh", expiresIn: 3600 }, url);
  if (url.includes("login/account")) return env({ uid: "browser-user", nickname: "Browser account", type: "personal" }, url);
  return env({ agents: [{ name: "cli", models: ["glm-5.3"] }], models: [{ id: "glm-5.3" }] }, url);
});

describe("WorkBuddy browser protocol", () => {
  it("builds platform-specific authorization URLs without exposing upstream state separately", async () => {
    const fetch = vi.fn(async (url: any, init: any) => {
      expect(url).toBe("https://www.workbuddy.ai/v2/plugin/auth/state?platform=workbuddy-ai");
      expect(init.headers["X-No-Authorization"]).toBe("true");
      return env({ state: "s", authUrl: "https://www.codebuddy.ai/login?state=s" });
    });
    const result = await createWorkBuddyLoginState("workbuddy-ai", fetch);
    expect(new URL(result.url).searchParams.get("version")).toBe("2.0.0");
    expect(new URL(result.url).searchParams.get("loginSessionId")).toMatch(/^[a-f0-9]{32}$/);
  });
  it("rejects unsafe or unrelated authorization destinations", async () => {
    for (const url of ["http://www.codebuddy.cn/login", "https://evil.example/login", "https://codebuddy.cn.evil.example/", "https://u:p@www.codebuddy.cn/", "https://www.codebuddy.cn:9443/"]) {
      await expect(createWorkBuddyLoginState("workbuddy", async () => env({ state: "s", authUrl: url }))).rejects.toThrow("workbuddy_login_state_failed");
    }
  });
  it("treats expected polling errors as pending but redacts upstream rejection", async () => {
    expect(await pollWorkBuddyLoginToken("workbuddy", "s", async () => env({}, undefined, 11217))).toEqual({ pending: true });
    expect(await pollWorkBuddyLoginToken("workbuddy", "s", async () => env({}, undefined, 999))).toEqual({ pending: false, ok: false });
  });
  it("resolves enterprise identities using account-type preference", async () => {
    const fetch = vi.fn(async (url: string) => url.includes("login/account") ? env({ uid: "u", type: "enterprise" }) : env({ accounts: [{ uid: "u", type: "enterprise", enterpriseId: "team" }, { uid: "u", type: "other", enterpriseId: "other" }] }));
    expect(await fetchWorkBuddyLoginAccount("workbuddy", "s", "a", undefined, fetch)).toMatchObject({ uid: "u", enterpriseId: "team" });
  });
});

describe("browser-owned credentials", () => {
  it("stores browser refresh privately but discards every desktop refresh secret", async () => {
    const h = harness(flowFetch());
    await h.store.save(credential());
    expect((await h.store.load())?.refreshToken).toBe("browser-refresh");
    expect(statSync(h.store.path).mode & 0o777).toBe(0o600);
    await h.store.save(credential({ source: "desktop" }));
    expect(readFileSync(h.store.path, "utf8")).not.toContain("browser-refresh");
    expect((await h.store.load())?.refreshToken).toBeUndefined();
  });
  it("renews once for concurrent requests and persists rotated browser credentials", async () => {
    const fetch = vi.fn(async (url: string, init: any) => {
      expect(url).toBe("https://copilot.tencent.com/v2/plugin/auth/token/refresh");
      expect(init.headers["X-Refresh-Token"]).toBe("browser-refresh");
      return env({ accessToken: "rotated-access", refreshToken: "rotated-refresh", expiresIn: 3600 });
    });
    const h = harness(fetch); await h.store.save(credential());
    const [a, b] = await Promise.all([h.service.currentCredential(), h.service.currentCredential()]);
    expect(a?.accessToken).toBe("rotated-access"); expect(b?.accessToken).toBe("rotated-access");
    expect(fetch).toHaveBeenCalledTimes(1); expect((await h.store.load())?.refreshToken).toBe("rotated-refresh");
    expect(h.reader).not.toHaveBeenCalled();
  });
  it("sync discovers with the in-memory renewed desktop token without persisting it", async () => {
    const old = credential({ source: "desktop", uid: "desktop-sync", expiresAt: Date.now() - 1000 });
    const reader = vi.fn(() => ({ ok: true, credential: { ...old, accessToken: "desktop-new", expiresAt: Date.now() + 3600000 } }));
    const fetch = vi.fn(async (_url: string, init: any) => { expect(init.headers.Authorization).toBe("Bearer desktop-new"); return discovery(); });
    const h = harness(fetch, reader as any); await h.store.save(old);
    expect((await h.service.syncModels()).success).toBe(true);
    expect((await h.store.load())?.accessToken).toBe(old.accessToken);
  });
  it("restores previous config and credential after a partially failed write", async () => {
    const h = harness(flowFetch()); let backing: any = null; let count = 0;
    h.write.mockImplementation(async (next) => { backing = structuredClone(next); if (++count === 1) throw new Error("partial-write"); });
    const start = await h.service.startBrowserLogin("workbuddy");
    expect((await h.service.pollBrowserLogin("workbuddy", start.loginId)).status).toBe("failed");
    expect(backing).toEqual({ Providers: [], Router: { default: "other,model" } });
    expect(await h.store.load()).toBeNull();
  });
  it("never refreshes a desktop credential or one whose refresh token expired", async () => {
    const fetch = vi.fn();
    expect(await refreshWorkBuddyToken(credential({ source: "desktop" }), fetch)).toMatchObject({ accessToken: "browser-access" });
    await refreshWorkBuddyToken(credential({ refreshExpiresAt: Date.now() - 1 }), fetch);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("re-evaluates expiry after an initially fresh snapshot", async () => {
    const fetch = vi.fn(async () => env({ accessToken: "later-access", expiresIn: 3600 }));
    const h = harness(fetch); await h.store.save(credential({ expiresAt: Date.now() + 600000 }));
    await h.service.currentCredential(); expect(fetch).not.toHaveBeenCalled();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 500000);
    expect((await h.service.currentCredential())?.accessToken).toBe("later-access");
  });
  it("does not resurrect a credential when disconnect races an in-flight refresh", async () => {
    let resolve!: (r: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>(r => { resolve = r; }));
    const h = harness(fetch); await h.store.save(credential());
    const pending = h.service.currentCredential();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const disconnect = h.service.disconnect();
    resolve(env({ accessToken: "stale-rotation", refreshToken: "stale-refresh", expiresIn: 3600 }));
    expect(await pending).toBeNull(); await disconnect; expect(await h.store.load()).toBeNull();
  });
});

describe("browser login jobs", () => {
  it.each(["workbuddy", "workbuddy-ai"] as const)("%s authenticates without desktop files, discovers models, never changes Router", async site => {
    const h = harness(flowFetch(site));
    const start = await h.service.startBrowserLogin(site);
    expect(start.loginId).toMatch(/^[a-f0-9]{48}$/); expect(JSON.stringify(start)).not.toContain("private-state");
    expect(await h.service.pollBrowserLogin(site, "bad-job")).toEqual({ status: "none" });
    const result = await h.service.pollBrowserLogin(site, start.loginId);
    expect(result).toMatchObject({ status: "connected", result: { models: ["glm-5.3"] } });
    expect(JSON.stringify(result)).not.toContain("browser-access"); expect(JSON.stringify(result)).not.toContain("browser-refresh");
    expect(h.config().Router).toEqual({ default: "other,model" }); expect(h.config().Providers).toHaveLength(1);
    expect((await h.store.load())?.kind).toBe(site); expect(h.reader).not.toHaveBeenCalled();
    expect(await h.service.getStatus()).toMatchObject({ source: "browser", renewalMode: "browser" });
  });
  it("isolates simultaneous browser clients and cancel only invalidates its own job", async () => {
    const h = harness(flowFetch());
    const [a, b] = await Promise.all([h.service.startBrowserLogin("workbuddy"), h.service.startBrowserLogin("workbuddy")]);
    expect(a.loginId).not.toBe(b.loginId);
    h.service.cancelBrowserLogin("workbuddy", a.loginId);
    expect(await h.service.pollBrowserLogin("workbuddy", a.loginId)).toEqual({ status: "none" });
    expect((await h.service.pollBrowserLogin("workbuddy", b.loginId)).status).toBe("connected");
  });
  it("keeps account-stage tokens private and makes one account attempt per poll", async () => {
    const base = flowFetch(); let accountCalls = 0;
    const fetch = vi.fn((url: string, init: any) => {
      if (url.includes("login/account") && ++accountCalls === 1) return Promise.resolve(env({}, url, 12151));
      return base(url, init);
    });
    const h = harness(fetch); const start = await h.service.startBrowserLogin("workbuddy");
    expect(await h.service.pollBrowserLogin("workbuddy", start.loginId)).toEqual({ status: "pending" });
    expect(accountCalls).toBe(1);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1300);
    expect((await h.service.pollBrowserLogin("workbuddy", start.loginId)).status).toBe("connected");
    expect(accountCalls).toBe(2);
    expect(fetch.mock.calls.filter(([url]) => url.includes("auth/token?"))).toHaveLength(1);
  });
  it("rolls back credentials and provider if canceled during the provider write", async () => {
    const h = harness(flowFetch()); let release!: () => void; let writes = 0;
    h.write.mockImplementation(async () => { if (++writes === 1) await new Promise<void>(r => { release = r; }); });
    const start = await h.service.startBrowserLogin("workbuddy");
    const pending = h.service.pollBrowserLogin("workbuddy", start.loginId);
    await vi.waitFor(() => expect(release).toBeDefined());
    h.service.cancelBrowserLogin("workbuddy", start.loginId); release();
    expect(await pending).toEqual({ status: "none" });
    expect(await h.store.load()).toBeNull();
    expect(h.write).toHaveBeenCalledTimes(2);
    expect(h.write.mock.calls[1][0]).toEqual({ Providers: [], Router: { default: "other,model" } });
  });
  it("does not recreate the provider if disconnect invalidates sync's initial load", async () => {
    const h = harness(flowFetch()); await h.store.save(credential({ expiresAt: Date.now() + 3600000 }));
    const read = h.store.load.bind(h.store); let release!: () => void; let first = true;
    vi.spyOn(h.store, "load").mockImplementation(async () => {
      const snapshot = await read();
      if (first) { first = false; await new Promise<void>(r => { release = r; }); }
      return snapshot;
    });
    const syncing = h.service.syncModels();
    await vi.waitFor(() => expect(release).toBeDefined());
    const disconnect = h.service.disconnect(); release(); await disconnect;
    expect((await syncing).success).toBe(false); expect(h.config().Providers).toEqual([]);
    expect(await h.store.load()).toBeNull();
  });
  it("single-flights token polling and returns the committed result idempotently", async () => {
    const fetch = flowFetch(); const h = harness(fetch); const start = await h.service.startBrowserLogin("workbuddy");
    const [a, b] = await Promise.all([h.service.pollBrowserLogin("workbuddy", start.loginId), h.service.pollBrowserLogin("workbuddy", start.loginId)]);
    expect(a.status).toBe("connected"); expect(b).toEqual(a); expect(h.write).toHaveBeenCalledTimes(1);
    expect(await h.service.pollBrowserLogin("workbuddy", start.loginId)).toEqual(a);
    expect(fetch.mock.calls.filter(([url]) => url.includes("auth/token?"))).toHaveLength(1);
  });
  it("cancellation while awaiting the token blocks all persistence", async () => {
    let resolve!: (r: Response) => void; const base = flowFetch();
    const fetch = vi.fn((url: string, init: any) => url.includes("auth/token?") ? new Promise<Response>(r => { resolve = r; }) : base(url, init));
    const h = harness(fetch); const start = await h.service.startBrowserLogin("workbuddy"); const pending = h.service.pollBrowserLogin("workbuddy", start.loginId);
    await vi.waitFor(() => expect(resolve).toBeDefined()); h.service.cancelBrowserLogin("workbuddy", start.loginId);
    resolve(env({ accessToken: "late-access", refreshToken: "late-refresh" }));
    expect(await pending).toEqual({ status: "none" }); expect(h.write).not.toHaveBeenCalled(); expect(await h.store.load()).toBeNull();
  });
  it("disconnect while discovery is in flight invalidates the login job", async () => {
    let resolve!: (r: Response) => void; const base = flowFetch();
    const fetch = vi.fn((url: string, init: any) => url.endsWith("/v3/config") ? new Promise<Response>(r => { resolve = r; }) : base(url, init));
    const h = harness(fetch); const start = await h.service.startBrowserLogin("workbuddy"); const pending = h.service.pollBrowserLogin("workbuddy", start.loginId);
    await vi.waitFor(() => expect(resolve).toBeDefined()); const disconnected = h.service.disconnect(); resolve(discovery());
    expect(await pending).toEqual({ status: "none" }); await disconnected;
    expect(await h.store.load()).toBeNull(); expect(h.config().Providers).toEqual([]);
  });
  it("expires authorization jobs and preserves old configuration on failed discovery", async () => {
    const fetch = flowFetch(); const h = harness(fetch); const start = await h.service.startBrowserLogin("workbuddy");
    vi.spyOn(Date, "now").mockReturnValue(start.expiresAt + 1);
    expect(await h.service.pollBrowserLogin("workbuddy", start.loginId)).toEqual({ status: "expired" });
    expect(h.write).not.toHaveBeenCalled();
  });
});
