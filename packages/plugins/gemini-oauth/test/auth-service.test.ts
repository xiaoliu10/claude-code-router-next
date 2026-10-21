/**
 * Gemini OAuth (Antigravity) credential store + login state machine + token
 * lifecycle tests — contract §1.3–§1.6.
 *
 * MOVED from the former core test `gemini-oauth-auth-service.test.ts` when the
 * provider became a plugin. Adaptation: the service's host coupling (config
 * IO, reload, direct dispatcher) is now injected plain-object fakes instead of
 * core config-module spies. Everything upstream is mocked (never a real
 * Google endpoint); the loopback OAuth callback server and the 0600 credential
 * file are REAL (node:http + temp dirs), because they are the actual
 * attack/leak surfaces being tested.
 */
import { promises as fs } from "node:fs";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GeminiOauthAuthService, GeminiOauthCredentialStore, type GeminiOauthCredentialData,
} from "../src/auth-service";
import {
  GEMINI_OAUTH_API_KEY, GEMINI_OAUTH_DATA_PLANE, GEMINI_OAUTH_LOGIN_TTL_MS,
  clearGeminiOauthTokenCaches, classifyGeminiOauthError, lockGeminiOauthProvider,
  setGeminiOauthRuntime,
} from "../src/protocol";

const ACCESS = "ya29.fixture-access-token";
const REFRESH = "1//0fixture-refresh-token-abcdefghijklmnop";
const ROTATED = "1//0rotated-refresh-token-abcdefghijklmnop";
const dirs: string[] = [];
const jobs: Array<{ service: GeminiOauthAuthService; loginId: string }> = [];
const credential = (): GeminiOauthCredentialData => ({
  version: 2, kind: "antigravity",
  account: { email: "fixture@example.invalid", refreshToken: REFRESH, projectId: "project-fixture", tier: "paid-tier",
    importedAt: "2026-01-01T00:00:00.000Z", lastError: null, cooldownUntil: null },
  rawModelIds: ["gemini-3-flash-low", "gemini-3-flash-high"],
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});
const modelsReply = { models: {
  "gemini-3-flash-low": { displayName: "Gemini Flash (Low)" },
  "gemini-3-flash-high": { displayName: "Gemini Flash (High)" },
} };

beforeEach(() => {
  vi.stubEnv("GEMINI_OAUTH_CLIENT_ID", "dummy-client-id");
  vi.stubEnv("GEMINI_OAUTH_CLIENT_SECRET", "dummy-client-secret");
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network disabled in test"); }));
  clearGeminiOauthTokenCaches();
});
afterEach(async () => {
  for (const job of jobs.splice(0)) job.service.cancelLogin(job.loginId);
  setGeminiOauthRuntime(null);
  clearGeminiOauthTokenCaches();
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function harness(config: any = { Providers: [], Router: {} }) {
  const dir = await fs.mkdtemp(join(tmpdir(), "gemini-auth-")); dirs.push(dir);
  const store = new GeminiOauthCredentialStore(join(dir, "gemini-oauth-credentials.json"));
  const live = { current: structuredClone(config) };
  // The host capabilities are plain injected fakes — the service reads config
  // exclusively through them (was: vi.spyOn(configModule, ...) in core).
  const host = {
    readRawConfig: vi.fn(async () => structuredClone(live.current)),
    writeConfig: vi.fn(async (next: any) => { live.current = structuredClone(next); }),
    reloadRuntime: vi.fn(async () => {}),
    getDirectDispatcher: vi.fn(() => ({ fake: "dispatcher" })),
  };
  const options = { store, host, logger: { warn: vi.fn(), error: vi.fn() } };
  const service = new GeminiOauthAuthService(options);
  const start = async () => {
    const result = await service.startLogin(); jobs.push({ service, loginId: result.loginId }); return result;
  };
  return { store, service, start, write: host.writeConfig, options, config: () => live.current };
}

/** node:http is deliberately NOT mocked: exercise the actual bound callback socket. */
async function callback(start: { url: string }, stateOverride?: string) {
  const authorize = new URL(start.url);
  const redirect = new URL(authorize.searchParams.get("redirect_uri")!);
  expect(redirect.hostname).toBe("localhost");
  const url = new URL(`http://127.0.0.1:${redirect.port}/oauth-callback`);
  url.searchParams.set("code", "dummy-authorization-code");
  url.searchParams.set("state", stateOverride ?? authorize.searchParams.get("state")!);
  return new Promise<number>((resolve, reject) => {
    get(url, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode!)); }).on("error", reject);
  });
}

function loginFetch() {
  const stub = vi.fn(async (url: any, init: any) => {
    expect(init.redirect).toBe("error");
    expect(init.dispatcher).toBeDefined();
    const u = String(url);
    if (u === "https://oauth2.googleapis.com/token") return json({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600 });
    if (u === "https://www.googleapis.com/oauth2/v2/userinfo?alt=json") return json({ email: "fixture@example.invalid" });
    if (u === "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist") {
      expect(JSON.parse(init.body)).toEqual({ metadata: { ideType: "ANTIGRAVITY" } });
      return json({ cloudaicompanionProject: "project-fixture", currentTier: { id: "paid-tier" } });
    }
    if (u === `${GEMINI_OAUTH_DATA_PLANE}/v1internal:fetchAvailableModels`) return json(modelsReply);
    throw new Error("unexpected mocked endpoint");
  });
  vi.stubGlobal("fetch", stub); return stub;
}

describe("Gemini OAuth private credential store", () => {
  it("writes the version-2 schema atomically with mode 0600 and drops unknown fields", async () => {
    const h = await harness();
    await h.store.save({ ...credential(), accessToken: ACCESS, raw: "untrusted" } as any);
    expect((await fs.stat(h.store.path)).mode & 0o777).toBe(0o600);
    expect(await h.store.load()).toEqual(credential());
    expect(await fs.readdir(join(h.store.path, ".."))).toEqual(["gemini-oauth-credentials.json"]);
    expect(await fs.readFile(h.store.path, "utf8")).not.toContain(ACCESS);
  });
  it.each([0o640, 0o604, 0o644])("rejects group/other-readable mode %s with a stable safe error", async (mode) => {
    const h = await harness(); await h.store.save(credential()); await fs.chmod(h.store.path, mode);
    await expect(h.store.load()).rejects.toMatchObject({ code: "gemini_oauth_credential_unreadable", statusCode: 500 });
  });
  it("never echoes corrupt credential contents, tokens or filesystem paths", async () => {
    const h = await harness(); await fs.writeFile(h.store.path, `bad-json ${REFRESH} ${ACCESS}`, { mode: 0o600 });
    const error = await h.store.load().catch(e => e);
    expect(error.message).toBe("gemini_oauth_credential_unreadable");
    expect(JSON.stringify(error)).not.toContain(REFRESH);
    expect(JSON.stringify(error)).not.toContain(ACCESS);
    expect(error.message).not.toContain(h.store.path);
  });
  it("returns null for an absent file", async () => {
    const h = await harness(); expect(await h.store.load()).toBeNull();
  });
});

describe("Gemini OAuth browser login state machine", () => {
  it("admits only one pending login, including two starts in the same tick", async () => {
    const h = await harness();
    const first = h.start();
    await expect(h.service.startLogin()).rejects.toMatchObject({ code: "gemini_oauth_login_busy" });
    const started = await first;
    expect(started.loginId).toMatch(/^[a-f0-9]{48}$/);
    await expect(h.service.startLogin()).rejects.toMatchObject({ code: "gemini_oauth_login_busy", statusCode: 429 });
  });
  it.each(["", "bad-id", "a".repeat(48), null, 123])("rejects unknown/malformed login id %s", async (id) => {
    const h = await harness();
    expect(await h.service.pollLogin(id as any)).toEqual({ status: "failed", error: "gemini_oauth_login_state_rejected" });
  });
  it("cancel is idempotent and frees the slot for a new login", async () => {
    const h = await harness(); const first = await h.start();
    expect(h.service.cancelLogin(first.loginId)).toEqual({ ok: true });
    expect(h.service.cancelLogin(first.loginId)).toEqual({ ok: true });
    expect((await h.service.pollLogin(first.loginId)).status).toBe("failed");
    expect((await h.start()).loginId).not.toBe(first.loginId);
  });
  it("expires after ten minutes and releases the slot", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const h = await harness(); const now = Date.now(); const first = await h.start();
    expect(first.expiresAt).toBe(now + GEMINI_OAUTH_LOGIN_TTL_MS);
    await vi.advanceTimersByTimeAsync(GEMINI_OAUTH_LOGIN_TTL_MS + 1);
    expect(await h.service.pollLogin(first.loginId)).toEqual({ status: "failed", error: "gemini_oauth_login_state_rejected" });
    expect((await h.start()).loginId).not.toBe(first.loginId);
  });
  it("requires environment configuration without echoing injected secrets", async () => {
    const h = await harness(); vi.stubEnv("GEMINI_OAUTH_CLIENT_SECRET", "");
    await expect(h.service.startLogin()).rejects.toMatchObject({ code: "gemini_oauth_not_configured", statusCode: 503 });
  });
  it("runs PKCE callback → tokens → userinfo → project → models → locked provider persistence", async () => {
    const h = await harness(); const upstream = loginFetch(); const started = await h.start();
    const auth = new URL(started.url);
    expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
    expect(auth.searchParams.get("access_type")).toBe("offline");
    expect(auth.searchParams.get("state")).toBeTruthy();
    expect(await callback(started, "wrong-state")).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
    expect(await callback(started)).toBe(200);
    expect(await h.service.pollLogin(started.loginId)).toEqual({ status: "success", email: "fixture@example.invalid" });
    const form = new URLSearchParams(upstream.mock.calls[0][1].body);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("dummy-authorization-code");
    expect(form.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const data = (await h.store.load())!;
    expect(data).toMatchObject({ version: 2, kind: "antigravity", account: {
      email: "fixture@example.invalid", refreshToken: REFRESH, projectId: "project-fixture", tier: "paid-tier", lastError: null, cooldownUntil: null,
    } });
    expect(Number.isNaN(Date.parse(data.account.importedAt))).toBe(false);
    expect(data.rawModelIds).toEqual(["gemini-3-flash-high", "gemini-3-flash-low"]);
    expect(h.config().Providers).toEqual([{
      name: "gemini-oauth", models: ["gemini-3-flash"], enabled: true,
      gemini_oauth_managed: true, gemini_oauth_kind: "antigravity", geminiOauthManaged: true, geminiOauthKind: "antigravity",
      api_base_url: GEMINI_OAUTH_DATA_PLANE, api_key: GEMINI_OAUTH_API_KEY, transformer: { use: ["gemini-oauth"] },
    }]);
    expect(h.config().Router).toEqual({});
    expect(JSON.stringify(h.config())).not.toContain(ACCESS);
    expect(JSON.stringify(h.config())).not.toContain(REFRESH);
    expect((await fs.stat(h.store.path)).mode & 0o777).toBe(0o600);
    expect(await h.service.getProject()).toBe("project-fixture");
    expect(await h.service.resolveWireModel("gemini-3-flash", "low")).toBe("gemini-3-flash-low");
  });
});

describe("Gemini OAuth token/cache lifecycle", () => {
  it("single-flights concurrent access token refreshes and reuses the cached token", async () => {
    const h = await harness(); await h.store.save(credential());
    const upstream = vi.fn(async () => json({ access_token: ACCESS, expires_in: 3600 })); vi.stubGlobal("fetch", upstream);
    expect(await Promise.all([h.service.getAccessToken(), h.service.getAccessToken()])).toEqual([ACCESS, ACCESS]);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(await h.service.getAccessToken()).toBe(ACCESS); expect(upstream).toHaveBeenCalledTimes(1);
    await h.service.forceTokenRefresh(); expect(await h.service.getAccessToken()).toBe(ACCESS);
    expect(upstream).toHaveBeenCalledTimes(2);
  });
  it("persists rotated refresh token before resolving or switching cache identity", async () => {
    const h = await harness(); await h.store.save(credential()); await h.service.getProject();
    const upstream = vi.fn(async () => json({ access_token: ACCESS, refresh_token: ROTATED, expires_in: 3600 })); vi.stubGlobal("fetch", upstream);
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const saving = new Promise<void>(r => { entered = r; });
    const save = h.store.save.bind(h.store);
    vi.spyOn(h.store, "save").mockImplementation(async data => { entered(); await gate; await save(data); });
    let resolved = false;
    const token = h.service.getAccessToken().then(value => { resolved = true; return value; });
    await saving;
    expect((await h.store.load())!.account.refreshToken).toBe(REFRESH);
    expect(resolved).toBe(false);
    release(); expect(await token).toBe(ACCESS);
    expect((await h.store.load())!.account.refreshToken).toBe(ROTATED);
    // A new service must load the durable identity and hit the ROTATED cache.
    expect(await new GeminiOauthAuthService(h.options).getAccessToken()).toBe(ACCESS);
    expect(upstream).toHaveBeenCalledTimes(1);
  });
  it("fails rotation closed if the durable write fails, keeping the old identity", async () => {
    const h = await harness(); await h.store.save(credential()); await h.service.getProject();
    vi.stubGlobal("fetch", vi.fn(async () => json({ access_token: ACCESS, refresh_token: ROTATED })));
    vi.spyOn(h.store, "save").mockRejectedValue(new Error("disk unavailable"));
    await expect(h.service.getAccessToken()).rejects.toThrow("disk unavailable");
    expect((await h.store.load())!.account.refreshToken).toBe(REFRESH);
  });
});

describe("Gemini OAuth error bookkeeping and disconnect", () => {
  it("persists only lastError code/validated link and cooldown, never raw upstream text", async () => {
    const h = await harness(); await h.store.save(credential());
    const info = classifyGeminiOauthError({ status: 403, body: { error: {
      message: `RAW-UPSTREAM ${ACCESS} ${REFRESH} /Users/jason/private`, details: [{ reason: "VALIDATION_REQUIRED", metadata: {
        validation_url: "https://accounts.google.com/verify?token=secret&secret=another&safe=1#private",
      } }],
    } } });
    expect(info.message).toContain("Google requires this account to be verified"); // safe copy only
    const before = Date.now(); await h.service.noteUpstreamError(info);
    const account = (await h.store.load())!.account;
    expect(account.lastError).toEqual({ code: "gemini_oauth_validation_required", validationUrl: "https://accounts.google.com/verify?safe=1" });
    expect(Object.keys(account.lastError!).sort()).toEqual(["code", "validationUrl"]);
    expect(account.cooldownUntil).toBeGreaterThanOrEqual(before + 30 * 60_000);
    expect(account.cooldownUntil).toBeLessThanOrEqual(Date.now() + 30 * 60_000);
    const text = await fs.readFile(h.store.path, "utf8");
    expect(text).not.toContain("RAW-UPSTREAM"); expect(text).not.toContain(ACCESS); expect(text).not.toContain("/Users/jason");
    expect((await h.service.getStatus()).lastError).toEqual({
      code: "gemini_oauth_validation_required", message: "Google requires account verification before continuing.", validationUrl: "https://accounts.google.com/verify?safe=1",
    });
  });
  it("cooling is false initially, true until expiry, and automatically false afterwards", async () => {
    const h = await harness(); await h.store.save(credential());
    expect(await h.service.isAccountCooling()).toBe(false);
    await h.service.noteUpstreamError(classifyGeminiOauthError({ status: 429 }));
    expect(await h.service.isAccountCooling()).toBe(true);
    const until = (await h.store.load())!.account.cooldownUntil!;
    vi.spyOn(Date, "now").mockReturnValue(until + 1);
    expect(await h.service.isAccountCooling()).toBe(false);
    expect(await h.service.getStatus()).toMatchObject({ lastError: null, cooldownUntil: null });
  });
  it("disconnect removes the provider, all Router reference shapes, credential and token cache", async () => {
    const provider = lockGeminiOauthProvider({ models: ["m"] });
    const other = { name: "other", api_base_url: "https://other.invalid/v1", api_key: "dummy", models: ["x"] };
    const h = await harness({ Providers: [provider, other], Router: {
      default: "gemini-oauth,m", think: "gemini-oauth,m", longContext: ["gemini-oauth,m", "other,x"],
      models: { alias: "gemini-oauth,m", keep: "other,x" }, families: { f: { default: "gemini-oauth,m" } },
    } });
    await h.store.save(credential());
    const upstream = vi.fn(async () => json({ access_token: ACCESS })); vi.stubGlobal("fetch", upstream);
    await h.service.getAccessToken();
    expect(await h.service.disconnect()).toEqual({ ok: true, removedModelRefs: ["gemini-oauth,m"], defaultFallback: "" });
    expect(h.config().Providers).toEqual([other]);
    expect(h.config().Router).toEqual({ default: "", think: "", longContext: ["other,x"], models: { keep: "other,x" }, families: { f: { default: "" } } });
    expect(await h.store.load()).toBeNull();
    await expect(h.service.getAccessToken()).rejects.toMatchObject({ code: "gemini_oauth_not_connected" });
    expect(await h.service.getStatus()).toMatchObject({ connected: false, email: null, project: null, modelsCount: 0 });
    await h.store.save(credential());
    expect(await new GeminiOauthAuthService(h.options).getAccessToken()).toBe(ACCESS);
    expect(upstream).toHaveBeenCalledTimes(2);
  });
  it("a failed provider write leaves credentials/account intact and restores config", async () => {
    const config = { Providers: [lockGeminiOauthProvider({ models: ["m"] })], Router: { default: "gemini-oauth,m" } };
    const h = await harness(config); await h.store.save(credential()); await h.service.getStatus();
    h.write.mockRejectedValueOnce(new Error("private disk error"));
    await expect(h.service.disconnect()).rejects.toMatchObject({ code: "gemini_oauth_config_write_failed" });
    expect(await h.store.load()).toEqual(credential()); expect(h.config()).toEqual(config);
    expect((await h.service.getStatus()).connected).toBe(true);
  });
});
