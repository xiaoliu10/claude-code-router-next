import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KiroAuthService } from "../src/auth-service";
import { BUILDER_ID_PROFILE } from "../src/protocol";

const services: KiroAuthService[] = [], dirs: string[] = [];
afterEach(async () => { services.splice(0).forEach(s => s.close()); await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });

type Failure = null | "identity" | "token-shape" | "config-write" | "persist-write";

async function setup(options: { profileArn?: string; profileRegion?: string } = {}) {
  const configDir = await mkdtemp(join(tmpdir(), "kiro-regress-")); dirs.push(configDir);
  const profileArn = options.profileArn ?? "arn:aws:codewhisperer:eu-central-1:123456789012:profile/REGIONTEST";
  const profileRegion = options.profileRegion ?? "eu-central-1";
  let cfg: any = { Providers: [{ name: "other", api_key: "$KEEP" }] };
  let now = 1_700_000_000_000;
  const requests: Array<{ url: string; body: any; init: RequestInit }> = [];
  let refreshStatus = 200, refreshCount = 0, refreshBody: any = null;
  let failure: Failure = null, discoveryGap: string | null = null, exchanges = 0;
  const network = vi.fn(async (input: any, init: any) => {
    const url = String(input), body = init.body ? JSON.parse(init.body) : undefined; requests.push({ url, body, init });
    if (url.includes("/client/register")) return Response.json({ clientId: "client", clientSecret: "client-secret" });
    if (url.includes("/refreshToken") || (body?.grantType === "refresh_token" && url.includes("/token"))) {
      refreshCount++;
      if (refreshStatus !== 200) return Response.json(refreshBody ?? { error: "invalid_grant", error_description: "super-secret-description" }, { status: refreshStatus });
      return Response.json({ accessToken: "rotated-access", refreshToken: "rotated-refresh", expiresIn: 3600, profileArn });
    }
    if (url.includes("/oauth/token") || url.endsWith("/token")) {
      if (failure === "token-shape") return Response.json({ accessToken: "", expiresIn: 3600 });
      // Each sign-in gets its own credentials, as a real authorization code exchange would.
      exchanges++;
      return Response.json({ accessToken: `access-${exchanges}`, refreshToken: `refresh-${exchanges}`, expiresIn: 3600, profileArn });
    }
    if (url.includes("Get-Usage-Limits")) {
      if (failure === "identity") return Response.json({ message: "unavailable" }, { status: 503 });
      return Response.json({ userInfo: { email: "same@example.com" }, subscriptionInfo: { subscriptionTitle: "KIRO PRO" },
        usageBreakdownList: [{ currentUsageWithPrecision: 5, usageLimitWithPrecision: 100, nextDateReset: 1_800_000_000 }] });
    }
    if (url.includes("List-Available-Profiles")) {
      // Simulate a profile that only one Kiro region knows about.
      if (discoveryGap && url.includes(`management.${discoveryGap}.`)) return Response.json({ message: "not found" }, { status: 404 });
      return Response.json({ profiles: [{ arn: `arn:aws:codewhisperer:${profileRegion}:123456789012:profile/REGIONTEST` }] });
    }
    if (url.includes("List-Available-Models")) return Response.json({ models: [{ modelId: "claude", modelName: "Claude", tokenLimits: { maxInputTokens: 200000, maxOutputTokens: 8000 } }] });
    throw new Error(`Unexpected URL ${url}`);
  });
  const dispatcher = {};
  const host: any = { configDir, readRawConfig: async () => cfg,
    writeConfig: vi.fn(async (c: any) => { if (failure === "config-write") throw new Error("config write failed"); cfg = structuredClone(c); }),
    reloadRuntime: vi.fn(async () => {}), getSubscriptionDispatcher: () => dispatcher, getDirectDispatcher: () => { throw new Error("wrong dispatcher"); } };
  const service = new KiroAuthService({ host, fetch: network as typeof fetch, now: () => now }); services.push(service);
  const api = noSockets({ service, host, network, requests, configDir, config: () => cfg, time: (n: number) => { now = n; },
    expire: () => { now += 3_500_000; }, setRefresh: (status: number, body?: any) => { refreshStatus = status; refreshBody = body ?? null; },
    refreshCount: () => refreshCount, fail: (f: Failure) => { failure = f; }, gap: (region: string | null) => { discoveryGap = region; } });
  return api;
}

async function login(s: KiroAuthService, method: "portal" | "builderid" | "idc" = "portal", provider = "google", region = "us-east-1") {
  const started = await s.startLogin({ method, region, ...(method === "idc" ? { startUrl: "https://org.awsapps.com/start" } : {}) });
  const u = new URL(started.url), redirect = u.searchParams.get("redirect_uri")!;
  const callback = new URL(method === "portal" ? `${redirect}/signin/callback` : redirect);
  callback.searchParams.set("state", u.searchParams.get("state")!); callback.searchParams.set("code", "code");
  if (method === "portal") callback.searchParams.set("login_option", provider);
  return { started, callback, result: await s.completeLogin(started.loginId, callback.href) };
}

const disk = async (file: string) => JSON.parse(await readFile(file, "utf8"));
const tick = () => new Promise(resolve => setImmediate(resolve));
/**
 * These regressions never need a real socket: the callback is handed to
 * `completeLogin` directly. Stubbing `listen` keeps the suite from holding
 * callback ports that the real-HTTP test binds.
 */
function noSockets<T extends { service: KiroAuthService }>(f: T) {
  let next = 3128;
  (f.service as any).listen = async () => ({ server: { close() {}, on() {} } as any, port: next++ });
  return f;
}

// ---- M1: refresh vs. concurrent error-state update -----------------------------

describe("M1 refresh races with concurrent account-state updates", () => {
  it.each([
    ["rate-limit (429) cooldown", { code: "kiro_rate_limited", message: "kiro_rate_limited", httpStatus: 429, cooldownMs: 300_000 }, false, 1_700_000_000_000 + 3_500_000 + 300_000],
    ["reauth (401)", { code: "kiro_reauth_required", message: "kiro_reauth_required", httpStatus: 401, cooldownMs: 3_600_000 }, true, 1_700_000_000_000 + 3_500_000 + 3_600_000],
  ] as const)("keeps rotated tokens through a concurrent %s update", async (_label, info, needReauth, coolingUntil) => {
    const f = await setup(); await login(f.service); const id = (await f.service.getStatus()).accounts[0].id; f.expire();
    let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
    const original = f.network.getMockImplementation()!;
    f.network.mockImplementation(async (input: any, init: any) => { if (String(input).includes("/refreshToken")) await barrier; return original(input, init); });
    const refreshing = f.service.getCredential(id);
    await tick();
    await f.service.noteUpstreamError(info as any, id);
    release();
    const credential = await refreshing;
    expect(credential.access).toBe("rotated-access"); expect(credential.refresh).toBe("rotated-refresh");
    const saved = (await disk(f.service.file)).accounts[0];
    expect(saved).toMatchObject({ access: "rotated-access", refresh: "rotated-refresh", needReauth, coolingUntil });
    expect((await f.service.getStatus()).accounts[0]).toMatchObject({ id, needReauth, coolingUntil });
  });

  it("still refuses to resurrect an account removed by disconnect during a refresh", async () => {
    const f = await setup(); await login(f.service); f.expire();
    let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
    const original = f.network.getMockImplementation()!;
    f.network.mockImplementation(async (input: any, init: any) => { if (String(input).includes("/refreshToken")) await barrier; return original(input, init); });
    const refreshing = f.service.getCredential(); await tick();
    await f.service.disconnect(); release();
    await expect(refreshing).rejects.toMatchObject({ code: "kiro_not_connected" });
    expect((await f.service.getStatus()).accounts).toEqual([]);
    await expect(readFile(f.service.file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to overwrite an account that signed in again with different credentials", async () => {
    const f = await setup(); await login(f.service); f.expire();
    let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
    const original = f.network.getMockImplementation()!;
    f.network.mockImplementation(async (input: any, init: any) => { if (String(input).includes("/refreshToken")) await barrier; return original(input, init); });
    const refreshing = f.service.getCredential(); await tick();
    // A fresh sign-in of the same identity replaces the stored credentials.
    await login(f.service); release();
    await expect(refreshing).rejects.toMatchObject({ code: "kiro_not_connected" });
    const saved = (await disk(f.service.file)).accounts[0];
    expect(saved.access).toBe("access-2"); expect(saved.refresh).toBe("refresh-2");
  });
});

// ---- M2: profile ARN region drives the Kiro service region --------------------

describe("M2 Kiro service region comes from the profile ARN", () => {
  it("uses the profile ARN region for management calls and credentials, not the login region", async () => {
    const f = await setup({ profileArn: "arn:aws:codewhisperer:eu-central-1:123456789012:profile/x", profileRegion: "eu-central-1" });
    const { result } = await login(f.service, "idc", "", "us-west-2");
    expect(result.status).toBe("complete");
    expect(result.account?.region).toBe("eu-central-1");
    expect(f.requests.filter(r => r.url.includes("management.")).every(r => r.url.startsWith("https://management.eu-central-1.kiro.dev/"))).toBe(true);
    // The AWS OIDC login keeps using the directory region the user supplied.
    expect(f.requests.find(r => r.url.includes("/client/register"))!.url).toBe("https://oidc.us-west-2.amazonaws.com/client/register");
    expect(f.requests.find(r => r.url.endsWith("/token"))!.url).toBe("https://oidc.us-west-2.amazonaws.com/token");
  });

  it("discovers a missing profile across Kiro service regions and keeps the directory region for OIDC", async () => {
    const f = await setup({ profileArn: "", profileRegion: "eu-central-1" });
    f.gap("us-east-1");
    const { result } = await login(f.service, "idc", "", "eu-west-1");
    expect(result.status).toBe("complete"); expect(result.account?.region).toBe("eu-central-1");
    const discovery = f.requests.filter(r => r.url.includes("List-Available-Profiles"));
    expect(discovery.map(r => new URL(r.url).host)).toEqual(["management.us-east-1.kiro.dev", "management.eu-central-1.kiro.dev"]);
    expect(f.requests.find(r => r.url.endsWith("/token"))!.url).toBe("https://oidc.eu-west-1.amazonaws.com/token");
  });

  it("keeps Builder ID on its fixed us-east-1 profile region when a user region is supplied", async () => {
    const f = await setup();
    const { result } = await login(f.service, "builderid", "", "ap-southeast-2");
    expect(result.account?.region).toBe("us-east-1");
    expect(f.requests.filter(r => r.url.includes("management.")).every(r => r.url.startsWith("https://management.us-east-1.kiro.dev/"))).toBe(true);
    expect(f.requests.filter(r => r.url.includes("List-Available-Profiles"))).toHaveLength(0);
  });

  it("still refreshes through the regional endpoints and keeps the refreshed profile region", async () => {
    const f = await setup({ profileArn: "arn:aws:codewhisperer:eu-central-1:123456789012:profile/x", profileRegion: "eu-central-1" });
    await login(f.service, "idc", "", "us-west-2"); f.expire(); await f.service.getCredential();
    expect(f.requests.find(r => r.body?.grantType === "refresh_token")!.url).toBe("https://oidc.us-west-2.amazonaws.com/token");
    f.expire();
    expect((await f.service.getCredential()).region).toBe("eu-central-1");
  });
});

// ---- M3: permanent OAuth 400 invalid_grant becomes reauth, without echoing -----

describe("M3 permanent OAuth failures at the refresh boundary require reauthentication", () => {
  it.each(["portal", "idc"] as const)("marks reauth once for a 400 invalid_grant on the %s refresh endpoint", async method => {
    const f = await setup(); await login(f.service, method); f.expire();
    f.setRefresh(400, { error: "invalid_grant", error_description: "super-secret-description" });
    const error = await f.service.getCredential().then(() => null, (e: any) => e);
    expect(error).toMatchObject({ code: "kiro_reauth_required" });
    expect(JSON.stringify({ message: error.message, ...error })).not.toContain("super-secret");
    expect((await f.service.getStatus()).accounts[0]).toMatchObject({ needReauth: true, coolingUntil: 1_700_000_000_000 + 3_500_000 + 3_600_000 });
    await expect(f.service.getCredential()).rejects.toMatchObject({ code: "kiro_reauth_required" });
    expect(f.refreshCount()).toBe(1);
  });

  it("treats an OAuth 400 invalid_client as a permanent sign-in failure without echoing it", async () => {
    const f = await setup(); await login(f.service, "idc"); f.expire();
    f.setRefresh(400, { error: "invalid_client", error_description: "client-secret-value" });
    const error = await f.service.getCredential().then(() => null, (e: any) => e);
    expect(error).toMatchObject({ code: "kiro_reauth_required" });
    expect(String(error.message)).not.toContain("client-secret-value");
    expect((await f.service.getStatus()).accounts[0].needReauth).toBe(true);
  });

  it("keeps a transient refresh 400 without an OAuth error code distinguishable", async () => {
    const f = await setup(); await login(f.service); f.expire();
    f.setRefresh(400, { message: "Bad Request" });
    await expect(f.service.getCredential()).rejects.toMatchObject({ code: "kiro_upstream_error" });
    expect((await f.service.getStatus()).accounts[0].needReauth).toBe(false);
  });
});

// ---- M4: terminal login failures after the code was spent --------------------

describe("M4 terminal login failures after a successful code exchange end the session", () => {
  const startPortal = async (f: Awaited<ReturnType<typeof setup>>) => {
    const started = await f.service.startLogin({ method: "portal" }), u = new URL(started.url);
    const callback = `${u.searchParams.get("redirect_uri")}/signin/callback?state=${u.searchParams.get("state")}&code=c&login_option=google`;
    return { started, callback };
  };

  it.each([
    ["identity lookup", "identity", "kiro_upstream_error"],
    ["token response shape", "token-shape", "kiro_login_failed"],
    ["config write", "config-write", "kiro_config_write_failed"],
    ["credential write", "persist-write", "kiro_persist_failed"],
  ] as const)("marks the session failed and releases the listener on %s failure", async (_label, failure, code) => {
    const f = await setup(); f.fail(failure as Failure);
    if (failure === "persist-write") { f.service.file = join(f.configDir, "missing-dir", "credentials.json"); f.host.configDir = f.service.file; }
    const { started, callback } = await startPortal(f);
    await expect(f.service.completeLogin(started.loginId, callback)).rejects.toMatchObject({ code });
    const polled = await f.service.pollLogin(started.loginId);
    expect(polled).toEqual({ status: "failed" });
    // The session is terminal and its listener/timer are released, so no pending session is left.
    const logins = [...(f.service["logins"] as Map<string, { status: string }>).values()];
    expect(logins.some(l => l.status === "pending")).toBe(false);
  });

  it("keeps an unrelated callback validation failure pending", async () => {
    const f = await setup(); const { started, callback } = await startPortal(f);
    await expect(f.service.completeLogin(started.loginId, callback.replace("state=", "state=wrong"))).rejects.toMatchObject({ code: "kiro_callback_invalid" });
    expect((await f.service.pollLogin(started.loginId)).status).toBe("pending");
  });

  it("leaves no pending session behind for a poll to show after the callback failed", async () => {
    const f = await setup(); f.fail("identity"); const { started, callback } = await startPortal(f);
    await expect(f.service.completeLogin(started.loginId, callback)).rejects.toMatchObject({ code: "kiro_upstream_error" });
    // A second paste of the same (now spent) code reports the ended session instead of re-trading it.
    await expect(f.service.completeLogin(started.loginId, callback)).rejects.toMatchObject({ code: "kiro_login_cancelled" });
    expect(await f.service.pollLogin(started.loginId)).toEqual({ status: "failed" });
  });
});

// ---- m1: concurrent startLogin keeps a single pending session ----------------

describe("m1 concurrent sign-in starts keep one pending listener", () => {
  it("cancels the older session when two starts race and leaves a single pending listener", async () => {
    const f = await setup();
    const [a, b] = await Promise.all([f.service.startLogin({ method: "portal" }), f.service.startLogin({ method: "portal" })]);
    const statuses = await Promise.all([a, b].map(s => f.service.pollLogin(s.loginId).then(r => r.status, (e: any) => e.code)));
    expect(statuses.filter(s => s === "pending")).toHaveLength(1);
    expect(statuses.filter(s => s === "cancelled")).toHaveLength(1);
    const pending = f.service["logins"].get(statuses[0] === "pending" ? a.loginId : b.loginId)!;
    expect(pending.status).toBe("pending");
    const cancelled = statuses[0] === "pending" ? b.loginId : a.loginId;
    expect(f.service["logins"].get(cancelled)?.status).toBe("cancelled");
  });

  it("keeps one pending listener when many starts race", async () => {
    const f = await setup();
    const started = await Promise.all(Array.from({ length: 5 }, () => f.service.startLogin({ method: "portal" })));
    const statuses = await Promise.all(started.map(s => f.service.pollLogin(s.loginId).then(r => r.status)));
    expect(statuses.filter(s => s === "pending")).toHaveLength(1);
  });
});

// ---- N1: a refresh answer landing inside a disconnect must never resurrect ----

describe("N1 refresh × disconnect unordered race always ends removed", () => {
  it("ends removed in every round of a barrier-free race", async () => {
    for (let round = 0; round < 12; round++) {
      const f = await setup(); await login(f.service); f.expire();
      const s = f.service as any;
      const originalPersist = s.persist.bind(s), originalConfig = s.config.bind(s);
      let releaseRefresh!: () => void; const refreshAnswer = new Promise<void>(r => { releaseRefresh = r; });
      let resolveSettled!: () => void; const disconnectSettled = new Promise<void>(r => { resolveSettled = r; });
      const originalNetwork = f.network.getMockImplementation()!;
      f.network.mockImplementation(async (input: any, init: any) => { if (String(input).includes("/refreshToken")) await refreshAnswer; return originalNetwork(input, init); });
      // The refresh answer lands while the disconnect is inside its commit (no barrier orders them).
      s.config = async (next: any) => { releaseRefresh(); return originalConfig(next); };
      // Held until the disconnect fully settles: a resurrecting rename would land after `rm`.
      s.persist = async (next: any) => { if (next.accounts.length) await disconnectSettled; return originalPersist(next); };
      const refreshing = f.service.getCredential(); await tick();
      await f.service.disconnect().then(() => resolveSettled(), () => resolveSettled());
      await expect(refreshing, `round ${round}: refresh must be refused`).rejects.toMatchObject({ code: "kiro_not_connected" });
      expect((await f.service.getStatus()).accounts, `round ${round}: account resurrected in memory`).toEqual([]);
      await expect(readFile(f.service.file), `round ${round}: credentials resurrected on disk`).rejects.toMatchObject({ code: "ENOENT" });
    }
  }, 60_000);
});

// ---- N2: concurrent commit sections serialize; rotations are never rolled back ----

describe("N2 concurrent refreshes of two accounts keep both rotations", () => {
  it("persists both rotated credentials when two accounts refresh at once", async () => {
    const f = await setup();
    await login(f.service, "portal", "google"); await login(f.service, "portal", "github");
    const accounts = (await f.service.getStatus()).accounts;
    expect(accounts.map(a => a.uid)).toEqual(["google", "github"]);
    const [a, b] = accounts; f.expire();
    const s = f.service as any;
    const originalPersist = s.persist.bind(s);
    const arn = "arn:aws:codewhisperer:eu-central-1:123456789012:profile/REGIONTEST";
    let releaseA!: () => void; const aAnswer = new Promise<void>(r => { releaseA = r; });
    let resolveBEntered!: () => void; const bEntered = new Promise<void>(r => { resolveBEntered = r; });
    let resolveAEntered!: () => void; const aEntered = new Promise<void>(r => { resolveAEntered = r; });
    let releaseBPersist!: () => void; const bPersist = new Promise<void>(r => { releaseBPersist = r; });
    let releaseAPersist!: () => void; const aPersist = new Promise<void>(r => { releaseAPersist = r; });
    const originalNetwork = f.network.getMockImplementation()!;
    f.network.mockImplementation(async (input: any, init: any) => {
      const body = init?.body ? JSON.parse(init.body) : undefined;
      if (String(input).includes("/refreshToken") || body?.grantType === "refresh_token") {
        // Account A's rotation answer lands only once B's commit section is holding.
        if (body?.refreshToken === "refresh-1") await aAnswer;
        const tag = body?.refreshToken === "refresh-1" ? "A" : "B";
        return Response.json({ accessToken: `rotated-${tag}`, refreshToken: `rotated-refresh-${tag}`, expiresIn: 3600, profileArn: arn });
      }
      return originalNetwork(input, init);
    });
    let persistCalls = 0;
    s.persist = async (next: any) => {
      const nth = ++persistCalls;
      if (nth === 1) { resolveBEntered(); await bPersist; } else { resolveAEntered(); await aPersist; }
      return originalPersist(next);
    };
    const refreshingA = f.service.getCredential(a.id);
    const refreshingB = f.service.getCredential(b.id);
    await bEntered;      // B holds the commit section with its persist parked.
    releaseA();          // A's rotation answer lands while B's section is open.
    await tick(); await tick();
    releaseBPersist();   // B's persist lands.
    await aEntered;      // A's upsert/persist must run strictly after B's whole section.
    releaseAPersist();
    await Promise.all([refreshingA, refreshingB]);
    // Both the file and the in-memory state must carry each account's own rotation.
    for (const [label, view] of [["disk", await disk(f.service.file)], ["memory", s.saved]] as const) {
      expect(view.accounts.find((c: any) => c.uid === "google"), `${label}: google rotation`).toMatchObject({ access: "rotated-A", refresh: "rotated-refresh-A" });
      expect(view.accounts.find((c: any) => c.uid === "github"), `${label}: github rotation`).toMatchObject({ access: "rotated-B", refresh: "rotated-refresh-B" });
    }
  }, 30_000);
});

describe("commit sections are mutually exclusive", () => {
  it("runs concurrent commit sections one at a time (max concurrency 1)", async () => {
    const f = await setup(); await login(f.service);
    const s = f.service as any;
    const originalPersist = s.persist.bind(s);
    let active = 0, max = 0, first = true;
    let releaseFirst!: () => void; const firstGate = new Promise<void>(r => { releaseFirst = r; });
    s.persist = async (next: any) => {
      const hold = first; first = false;
      active++; max = Math.max(max, active);
      try { if (hold) await firstGate; await tick(); return await originalPersist(next); } finally { active--; }
    };
    const info = { code: "kiro_rate_limited", message: "kiro_rate_limited", httpStatus: 429, cooldownMs: 1_000 };
    const jobs = Array.from({ length: 4 }, () => f.service.noteUpstreamError(info));
    for (let i = 0; i < 20 && max < 2; i++) await tick();
    const observed = max;
    releaseFirst();
    await Promise.all(jobs);
    expect(observed, `max concurrent commit sections observed: ${observed}`).toBe(1);
  });

  it("keeps the exclusive lane as the only commit-section primitive", async () => {
    const f = await setup();
    const s = f.service as any;
    expect(typeof s.exclusive).toBe("function");
    expect(s.within, "within() must be gone").toBeUndefined();
    expect("holders" in s, "holders must be gone").toBe(false);
    expect("depth" in s, "depth must be gone").toBe(false);
  });
});

// ---- Minor b: legacy files normalize the region from the profile ARN at load ----

describe("Minor b legacy credential files normalize the service region", () => {
  it("maps the stored directory region to the profile region before the first refresh", async () => {
    const f = await setup();
    await writeFile(f.service.file, JSON.stringify({ version: 1, accounts: [
      { id: "legacy-arn", uid: "google", loginProvider: "google", email: "same@example.com", accountId: "same@example.com",
        access: "old-a", refresh: "old-r", expires: 1_700_000_060_000, region: "ap-southeast-2",
        profile: "arn:aws:codewhisperer:eu-central-1:123456789012:profile/x", method: "social" },
      { id: "legacy-plain", uid: "github", loginProvider: "github", email: "other@example.com", accountId: "other@example.com",
        access: "old-a2", refresh: "old-r2", expires: 1_700_000_060_000, region: "eu-west-1", profile: "", method: "social" },
    ], models: [], hiddenModels: [] }));
    const accounts = (await f.service.getStatus()).accounts;
    // Management region is where the profile says (or Kiro's eu region for a regionless profile).
    expect(accounts.find(a => a.id === "legacy-arn")!.region).toBe("eu-central-1");
    expect(accounts.find(a => a.id === "legacy-plain")!.region).toBe("eu-central-1");
    f.expire();
    await f.service.getCredential("legacy-arn");
    // The stored directory region still routes the token refresh...
    expect(f.requests.find(r => r.url.includes("/refreshToken"))!.url).toBe("https://prod.ap-southeast-2.auth.desktop.kiro.dev/refreshToken");
    // ...while management and the persisted file use the normalized region.
    await f.service.getUsage("legacy-arn");
    expect(f.requests.find(r => r.url.includes("Get-Usage-Limits"))!.url.startsWith("https://management.eu-central-1.kiro.dev/")).toBe(true);
    expect((await disk(f.service.file)).accounts.find((c: any) => c.id === "legacy-arn")).toMatchObject({ region: "eu-central-1", signInRegion: "ap-southeast-2" });
  });
});

// Keep BUILDER_ID_PROFILE referenced so the fixture stays honest about Builder ID.
void BUILDER_ID_PROFILE;
