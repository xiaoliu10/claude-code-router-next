import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KiroAuthService } from "../src/auth-service";

/**
 * Credential-commit concurrency guarantees.
 *
 * These began life as the reviewer's round-3 probes and are kept as permanent
 * regressions because they cover the exact failures that slipped past the
 * behavioural suite: an unordered refresh-vs-disconnect race resurrecting a
 * removed account, two commit sections overlapping (so a rotated refresh token
 * could be rolled back), and deadlocks inside the exclusive lane.
 */

const services: KiroAuthService[] = [], dirs: string[] = [];
afterEach(async () => { services.splice(0).forEach(s => s.close()); await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });

type Failure = null | "identity" | "token-shape" | "config-write" | "persist-write";

async function setup(options: { profileArn?: string; profileRegion?: string } = {}) {
  const configDir = await mkdtemp(join(tmpdir(), "kiro-r3-")); dirs.push(configDir);
  const profileArn = options.profileArn ?? "arn:aws:codewhisperer:eu-central-1:123456789012:profile/REGIONTEST";
  const profileRegion = options.profileRegion ?? "eu-central-1";
  let cfg: any = { Providers: [{ name: "other", api_key: "$KEEP" }] };
  let now = 1_700_000_000_000;
  const requests: Array<{ url: string; body: any; init: RequestInit }> = [];
  let refreshStatus = 200, refreshBody: any = null;
  let failure: Failure = null;
  const network = vi.fn(async (input: any, init: any) => {
    const url = String(input), body = init.body ? JSON.parse(init.body) : undefined; requests.push({ url, body, init });
    if (url.includes("/client/register")) return Response.json({ clientId: "client", clientSecret: "client-secret" });
    if (url.includes("/refreshToken") || (body?.grantType === "refresh_token" && url.includes("/token"))) {
      if (refreshStatus !== 200) return Response.json(refreshBody ?? { error: "invalid_grant" }, { status: refreshStatus });
      return Response.json({ accessToken: "rotated-access", refreshToken: "rotated-refresh", expiresIn: 3600, profileArn });
    }
    if (url.includes("/oauth/token") || url.endsWith("/token")) {
      return Response.json({ accessToken: `access-${requests.length}`, refreshToken: `refresh-${requests.length}`, expiresIn: 3600, profileArn });
    }
    if (url.includes("Get-Usage-Limits")) {
      if (failure === "identity") return Response.json({ message: "unavailable" }, { status: 503 });
      return Response.json({ userInfo: { email: "same@example.com" }, subscriptionInfo: { subscriptionTitle: "KIRO PRO" },
        usageBreakdownList: [{ currentUsageWithPrecision: 5, usageLimitWithPrecision: 100, nextDateReset: 1_800_000_000 }] });
    }
    if (url.includes("List-Available-Profiles")) return Response.json({ profiles: [{ arn: `arn:aws:codewhisperer:${profileRegion}:123456789012:profile/REGIONTEST` }] });
    if (url.includes("List-Available-Models")) return Response.json({ models: [{ modelId: "claude", modelName: "Claude", tokenLimits: { maxInputTokens: 200000, maxOutputTokens: 8000 } }] });
    throw new Error(`Unexpected URL ${url}`);
  });
  const host: any = { configDir, readRawConfig: async () => cfg,
    writeConfig: vi.fn(async (c: any) => { if (failure === "config-write") throw new Error("config write failed"); cfg = structuredClone(c); }),
    reloadRuntime: vi.fn(async () => {}), getSubscriptionDispatcher: () => ({}), getDirectDispatcher: () => { throw new Error("wrong dispatcher"); } };
  const service = new KiroAuthService({ host, fetch: network as typeof fetch, now: () => now }); services.push(service);
  let next = 4600;
  (service as any).listen = async () => ({ server: { close() {}, on() {} } as any, port: next++ });
  return { service, host, network, requests, configDir, config: () => cfg,
    expire: () => { now += 3_500_000; }, setRefresh: (status: number, body?: any) => { refreshStatus = status; refreshBody = body ?? null; }, fail: (f: Failure) => { failure = f; } };
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
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const withTimeout = async <T>(p: Promise<T>, ms: number, label: string): Promise<T> => {
  let timer: any; const guard = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`DEADLOCK-GUARD ${label}: not settled in ${ms}ms`)), ms); });
  try { return await Promise.race([p, guard]); } finally { clearTimeout(timer); }
};

// ---- P1: N1 refresh × disconnect unordered race, final state must be removed ----

describe("P1 N1 regression probe", () => {
  it("gated worst case ×60: refresh answer inside disconnect commit → removed, never resurrected", async () => {
    let refused = 0, memoryResurrect = 0, diskResurrect = 0;
    for (let round = 0; round < 60; round++) {
      const f = await setup(); await login(f.service); f.expire();
      const s = f.service as any;
      const originalPersist = s.persist.bind(s), originalConfig = s.config.bind(s);
      let releaseRefresh!: () => void; const refreshAnswer = new Promise<void>(r => { releaseRefresh = r; });
      let resolveSettled!: () => void; const disconnectSettled = new Promise<void>(r => { resolveSettled = r; });
      const originalNetwork = f.network.getMockImplementation()!;
      f.network.mockImplementation(async (input: any, init: any) => { if (String(input).includes("/refreshToken")) await refreshAnswer; return originalNetwork(input, init); });
      s.config = async (next: any) => { releaseRefresh(); return originalConfig(next); };
      s.persist = async (next: any) => { if (next.accounts.length) await disconnectSettled; return originalPersist(next); };
      const refreshing = f.service.getCredential(); await tick();
      await f.service.disconnect().then(() => resolveSettled(), () => resolveSettled());
      const outcome = await refreshing.then(() => "resolved" as const, (e: any) => (e?.code === "kiro_not_connected" ? "refused" : `other:${e?.code}` as const));
      if (outcome === "refused") refused++; // a resolved refresh alone is not a resurrection; final state decides
      await sleep(10); // let any late rename land
      if ((await f.service.getStatus()).accounts.length) memoryResurrect++;
      let diskBack = false; try { await readFile(f.service.file); diskBack = true; } catch (e: any) { if (e?.code !== "ENOENT") diskBack = true; }
      if (diskBack) diskResurrect++;
      expect(memoryResurrect, `round ${round}: memory resurrected`).toBe(0);
      expect(diskResurrect, `round ${round}: disk resurrected`).toBe(0);
    }
    expect({ refused, memoryResurrect, diskResurrect }).toEqual({ refused: 60, memoryResurrect: 0, diskResurrect: 0 });
    console.log(`N1-GATED-SUMMARY ${JSON.stringify({ rounds: 60, refused, memoryResurrect, diskResurrect })}`);
  }, 240_000);

  it("barrier-free ×60: getCredential and disconnect race with jitter → final state always removed", async () => {
    let memoryResurrect = 0, diskResurrect = 0, resolvedWhilePresent = 0;
    for (let round = 0; round < 60; round++) {
      const f = await setup(); await login(f.service); f.expire();
      const jitter = Math.round(Math.random() * 8);
      const refreshing = f.service.getCredential();
      await sleep(jitter);
      await withTimeout(f.service.disconnect(), 10_000, `N1-free round ${round} disconnect`);
      const outcome = await withTimeout(refreshing.then(() => "resolved" as const, (e: any) => `rejected:${e?.code}` as const), 10_000, `N1-free round ${round} refresh`);
      if (outcome === "resolved") resolvedWhilePresent++; // commit landed before disconnect; disconnect still must win last
      await sleep(5);
      if ((await f.service.getStatus()).accounts.length) memoryResurrect++;
      let diskBack = false; try { await readFile(f.service.file); diskBack = true; } catch (e: any) { if (e?.code !== "ENOENT") diskBack = true; }
      if (diskBack) diskResurrect++;
      expect(memoryResurrect, `round ${round}: memory resurrected (outcome=${outcome})`).toBe(0);
      expect(diskResurrect, `round ${round}: disk resurrected (outcome=${outcome})`).toBe(0);
    }
    console.log(`N1-FREE-SUMMARY ${JSON.stringify({ rounds: 60, memoryResurrect, diskResurrect, refreshResolvedBeforeDisconnect: resolvedWhilePresent })}`);
  }, 240_000);
});

// ---- P2: N2 commit-section exclusivity + two-account rotation retention ----

describe("P2 N2 regression probe", () => {
  it("mixed concurrent commit sections (markError ×3, setModelHidden ×2) → max concurrency 1", async () => {
    const f = await setup(); await login(f.service); await f.service.syncModels();
    const s = f.service as any;
    const originalPersist = s.persist.bind(s);
    let active = 0, max = 0;
    let release: Array<() => void> = [];
    s.persist = async (next: any) => {
      const hold = release.length === 0; // park exactly the first persist
      let gate: Promise<void> | null = null;
      if (hold) { gate = new Promise<void>(r => release.push(r)); }
      active++; max = Math.max(max, active);
      try { if (gate) await gate; await tick(); return await originalPersist(next); } finally { active--; }
    };
    const info = { code: "kiro_rate_limited", message: "kiro_rate_limited", httpStatus: 429, cooldownMs: 1_000 };
    const jobs = [f.service.noteUpstreamError(info), f.service.setModelHidden("claude", true), f.service.noteUpstreamError(info), f.service.setModelHidden("claude", false), f.service.noteUpstreamError(info)];
    for (let i = 0; i < 200; i++) await tick(); // give every job a chance to queue up
    const observed = max;
    for (const r of release) r();
    await withTimeout(Promise.all(jobs), 15_000, "P2a mixed sections");
    expect(observed, `max concurrent commit sections observed: ${observed}`).toBe(1);
    console.log(`SECTION-MIX-SUMMARY maxConcurrent=${observed}`);
  }, 30_000);

  it("gated two-account rotation ×30: both rotations always kept (lostA=0 lostB=0)", async () => {
    const arn = "arn:aws:codewhisperer:eu-central-1:123456789012:profile/REGIONTEST";
    let lostA = 0, lostB = 0, bothKept = 0;
    for (let round = 0; round < 30; round++) {
      const f = await setup();
      await login(f.service, "portal", "google"); await login(f.service, "portal", "github");
      const accounts = (await f.service.getStatus()).accounts;
      const [a, b] = accounts; f.expire();
      const s = f.service as any;
      const originalPersist = s.persist.bind(s);
      const originalNetwork = f.network.getMockImplementation()!;
      let releaseA!: () => void; const aAnswer = new Promise<void>(r => { releaseA = r; });
      let resolveBEntered!: () => void; const bEntered = new Promise<void>(r => { resolveBEntered = r; });
      let resolveAEntered!: () => void; const aEntered = new Promise<void>(r => { resolveAEntered = r; });
      let releaseBPersist!: () => void; const bPersist = new Promise<void>(r => { releaseBPersist = r; });
      let releaseAPersist!: () => void; const aPersist = new Promise<void>(r => { releaseAPersist = r; });
      f.network.mockImplementation(async (input: any, init: any) => {
        const body = init?.body ? JSON.parse(init.body) : undefined;
        if (String(input).includes("/refreshToken") || body?.grantType === "refresh_token") {
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
      await bEntered;
      releaseA();
      await tick(); await tick();
      releaseBPersist();
      await aEntered;
      releaseAPersist();
      await withTimeout(Promise.all([refreshingA, refreshingB]), 15_000, `N2 round ${round}`);
      const views: Array<[string, any]> = [["disk", await disk(f.service.file)], ["memory", s.saved]];
      let aOk = true, bOk = true;
      for (const [label, view] of views) {
        const ga = view.accounts.find((c: any) => c.uid === "google"), gb = view.accounts.find((c: any) => c.uid === "github");
        if (!ga || ga.access !== "rotated-A" || ga.refresh !== "rotated-refresh-A") aOk = false;
        if (!gb || gb.access !== "rotated-B" || gb.refresh !== "rotated-refresh-B") bOk = false;
      }
      if (!aOk) lostA++; if (!bOk) lostB++; if (aOk && bOk) bothKept++;
      expect(lostA, `round ${round}: A rotation lost`).toBe(0);
      expect(lostB, `round ${round}: B rotation lost`).toBe(0);
    }
    expect({ lostA, lostB, bothKept }).toEqual({ lostA: 0, lostB: 0, bothKept: 30 });
    console.log(`N2-GATED-SUMMARY ${JSON.stringify({ rounds: 30, lostA, lostB, bothKept })}`);
  }, 240_000);

  it("barrier-free two-account rotation ×30: both rotations always kept", async () => {
    const arn = "arn:aws:codewhisperer:eu-central-1:123456789012:profile/REGIONTEST";
    let lostA = 0, lostB = 0, bothKept = 0;
    for (let round = 0; round < 30; round++) {
      const f = await setup();
      await login(f.service, "portal", "google"); await login(f.service, "portal", "github");
      const accounts = (await f.service.getStatus()).accounts;
      const [a, b] = accounts; f.expire();
      const originalNetwork = f.network.getMockImplementation()!;
      f.network.mockImplementation(async (input: any, init: any) => {
        const body = init?.body ? JSON.parse(init.body) : undefined;
        if (String(input).includes("/refreshToken") || body?.grantType === "refresh_token") {
          const tag = body?.refreshToken === "refresh-1" ? "A" : "B";
          await sleep(Math.round(Math.random() * 6));
          return Response.json({ accessToken: `rotated-${tag}`, refreshToken: `rotated-refresh-${tag}`, expiresIn: 3600, profileArn: arn });
        }
        return originalNetwork(input, init);
      });
      const [ra, rb] = await withTimeout(Promise.all([
        f.service.getCredential(a.id).then(() => "ok" as const, (e: any) => `err:${e?.code}` as const),
        f.service.getCredential(b.id).then(() => "ok" as const, (e: any) => `err:${e?.code}` as const),
      ]), 15_000, `N2-free round ${round}`);
      const views: Array<[string, any]> = [["disk", await disk(f.service.file)], ["memory", (f.service as any).saved]];
      let aOk = true, bOk = true;
      for (const [, view] of views) {
        const ga = view.accounts.find((c: any) => c.uid === "google"), gb = view.accounts.find((c: any) => c.uid === "github");
        if (!ga || ga.access !== "rotated-A" || ga.refresh !== "rotated-refresh-A") aOk = false;
        if (!gb || gb.access !== "rotated-B" || gb.refresh !== "rotated-refresh-B") bOk = false;
      }
      if (!aOk) lostA++; if (!bOk) lostB++; if (aOk && bOk) bothKept++;
      expect([ra, rb]).toEqual(["ok", "ok"]);
      expect(lostA, `round ${round}: A rotation lost`).toBe(0);
      expect(lostB, `round ${round}: B rotation lost`).toBe(0);
    }
    expect({ lostA, lostB, bothKept }).toEqual({ lostA: 0, lostB: 0, bothKept: 30 });
    console.log(`N2-FREE-SUMMARY ${JSON.stringify({ rounds: 30, lostA, lostB, bothKept })}`);
  }, 240_000);
});

// ---- P3: deadlock battery — exclusive sections with in-section awaits on real fs ----

describe("P3 deadlock battery", () => {
  it("real-fs disconnect completes (load+validate+config+persist inside the section)", async () => {
    const f = await setup(); await login(f.service);
    await withTimeout(f.service.disconnect(), 10_000, "P3a real-fs disconnect");
    expect((await f.service.getStatus()).accounts).toEqual([]);
    await expect(readFile(f.service.file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("config write failure inside commit rolls back without deadlocking", async () => {
    const f = await setup(); await login(f.service); await f.service.syncModels(); f.fail("config-write");
    const err = await f.service.setModelHidden("claude", true).then(() => null, (e: any) => e);
    expect(err).toMatchObject({ code: "kiro_config_write_failed" });
    const status = await withTimeout(f.service.getStatus(), 10_000, "P3b post-failure status");
    expect(status.hiddenModels).toEqual([]); // rollback kept old state
    f.fail(null);
    await withTimeout(f.service.setModelHidden("claude", true), 10_000, "P3b recovery write");
    expect((await f.service.getStatus()).hiddenModels).toEqual(["claude"]); // lane still usable
  });

  it("persist failure inside disconnect rolls back without deadlocking", async () => {
    const f = await setup(); await login(f.service);
    (f.service as any).file = join(f.configDir, "missing-dir", "credentials.json");
    (f.host as any).configDir = (f.service as any).file;
    const err = await withTimeout(f.service.disconnect().then(() => null, (e: any) => e), 10_000, "P3c failing disconnect");
    expect(err).toMatchObject({ code: "kiro_persist_failed" });
    (f.host as any).configDir = f.configDir;
    (f.service as any).file = join(f.configDir, "credentials.json");
    const status = await withTimeout(f.service.getStatus(), 10_000, "P3c status after failure");
    expect(status.accounts).toHaveLength(1); // account survived: persist failed before rm
  });

  it("unreadable credential file fails load without poisoning the lane; recovers after repair", async () => {
    const f = await setup();
    await writeFile(f.service.file, "this is not json{{{");
    const err = await f.service.setModelHidden("claude", true).then(() => null, (e: any) => e);
    expect(err).toMatchObject({ code: "kiro_credential_unreadable" });
    // A second consumer must not hang on a poisoned cached load.
    const err2 = await withTimeout(f.service.getStatus().then(() => null, (e: any) => e), 10_000, "P3d second load");
    expect(err2).toMatchObject({ code: "kiro_credential_unreadable" });
    await writeFile(f.service.file, JSON.stringify({ version: 1, accounts: [], models: [], hiddenModels: [] }));
    const status = await withTimeout(f.service.getStatus(), 10_000, "P3d after repair");
    expect(status.connected).toBe(false);
  });

  it("concurrent mixed-ops torture: refresh/markError/setModelHidden/syncModels all settle, no deadlock", async () => {
    const f = await setup(); await login(f.service, "portal", "google"); await login(f.service, "portal", "github");
    const accounts = (await f.service.getStatus()).accounts;
    await f.service.syncModels(accounts[0].id); // seed models so setModelHidden in the mix has a target
    f.expire();
    const originalNetwork = f.network.getMockImplementation()!;
    f.network.mockImplementation(async (input: any, init: any) => {
      const body = init?.body ? JSON.parse(init.body) : undefined;
      if (String(input).includes("/refreshToken") || body?.grantType === "refresh_token") {
        await sleep(Math.round(Math.random() * 5));
        const tag = body?.refreshToken === "refresh-1" ? "A" : "B";
        return Response.json({ accessToken: `rotated-${tag}`, refreshToken: `rotated-refresh-${tag}`, expiresIn: 3600, profileArn: "arn:aws:codewhisperer:eu-central-1:123456789012:profile/REGIONTEST" });
      }
      await sleep(Math.round(Math.random() * 3));
      return originalNetwork(input, init);
    });
    const info = { code: "kiro_rate_limited", message: "kiro_rate_limited", httpStatus: 429, cooldownMs: 1_000 };
    const jobs: Array<Promise<unknown>> = [];
    for (let i = 0; i < 6; i++) jobs.push(f.service.getCredential(accounts[i % 2].id).catch((e: any) => `err:${e?.code}`));
    for (let i = 0; i < 3; i++) jobs.push(f.service.noteUpstreamError(info, accounts[i % 2].id));
    jobs.push(f.service.setModelHidden("claude", true).catch((e: any) => `err:${e?.code}`));
    jobs.push(f.service.syncModels(accounts[0].id).catch((e: any) => `err:${e?.code}`));
    jobs.push(f.service.syncModels(accounts[1].id).catch((e: any) => `err:${e?.code}`));
    jobs.push(f.service.getStatus());
    const results = await withTimeout(Promise.all(jobs), 20_000, "P3e torture");
    const settled = results.filter(r => typeof r === "string" && String(r).startsWith("err:"));
    // everything settled; rate-limit cooldowns may refuse some refreshes, that is allowed
    const saved = (f.service as any).saved;
    expect(saved.accounts).toHaveLength(2);
    for (const a of saved.accounts) expect(a.access).toMatch(/^rotated-[AB]$|^access-\d+$/);
    console.log(`TORTURE-SUMMARY jobs=${jobs.length} settledErrors=${settled.length} hiddenModels=${JSON.stringify(saved.hiddenModels)}`);
  });
});

// ---- P4: Minor b probes ----

describe("P4 Minor b probes", () => {
  it("legacy social file: management normalized before first refresh; refresh keeps stored directory region", async () => {
    const f = await setup();
    await writeFile(f.service.file, JSON.stringify({ version: 1, accounts: [
      { id: "legacy-social", uid: "google", loginProvider: "google", email: "same@example.com", accountId: "same@example.com",
        access: "old-a", refresh: "old-r", expires: 1_700_003_600_000, region: "ap-southeast-2",
        profile: "arn:aws:codewhisperer:eu-central-1:123456789012:profile/x", method: "social" },
    ], models: [], hiddenModels: [] }));
    // Management before ANY refresh: getUsage with unexpired token → no refresh call yet.
    const usage = await withTimeout(f.service.getUsage("legacy-social"), 10_000, "P4a getUsage");
    expect(usage.user).toBe("same@example.com");
    const mgmt = f.requests.find(r => r.url.includes("Get-Usage-Limits"))!;
    expect(mgmt.url.startsWith("https://management.eu-central-1.kiro.dev/"), mgmt.url).toBe(true);
    expect(f.requests.some(r => r.url.includes("/refreshToken"))).toBe(false); // no refresh happened yet
    // Now expire: refresh must route by the preserved sign-in region.
    f.expire();
    await f.service.getCredential("legacy-social");
    expect(f.requests.find(r => r.url.includes("/refreshToken"))!.url).toBe("https://prod.ap-southeast-2.auth.desktop.kiro.dev/refreshToken");
    const saved = (await disk(f.service.file)).accounts[0];
    expect(saved).toMatchObject({ region: "eu-central-1", signInRegion: "ap-southeast-2", access: "rotated-access" });
  });

  it("legacy idc file: oidc token endpoint keeps the stored directory region; management normalized", async () => {
    const f = await setup({ profileArn: "arn:aws:codewhisperer:eu-central-1:123456789012:profile/x" });
    await writeFile(f.service.file, JSON.stringify({ version: 1, accounts: [
      { id: "legacy-idc", uid: "awsidc", loginProvider: "awsidc", email: "same@example.com", accountId: "same@example.com",
        access: "old-a", refresh: "old-r", expires: 1_700_000_060_000, region: "us-west-2",
        profile: "arn:aws:codewhisperer:eu-central-1:123456789012:profile/x", method: "idc", clientId: "cid", clientSecret: "cs" },
    ], models: [], hiddenModels: [] }));
    f.expire();
    const c = await f.service.getCredential("legacy-idc");
    expect(c.region).toBe("eu-central-1");
    expect(f.requests.find(r => r.body?.grantType === "refresh_token")!.url).toBe("https://oidc.us-west-2.amazonaws.com/token");
    expect((await disk(f.service.file)).accounts[0]).toMatchObject({ region: "eu-central-1", signInRegion: "us-west-2" });
  });

  it.each([
    ["regionless profile, eu-west-1 stored", "", "eu-west-1", "eu-central-1"],
    ["regionless profile, us-west-2 stored", "", "us-west-2", "us-east-1"],
    ["ARN without region, eu-* stored", "arn:aws:codewhisperer::123456789012:profile/x", "eu-west-1", "eu-central-1"],
    ["ARN without region, ap-* stored", "arn:aws:codewhisperer::123456789012:profile/x", "ap-southeast-2", "us-east-1"],
    ["garbage ARN, us-* stored", "not-an-arn", "us-west-1", "us-east-1"],
  ] as const)("legacy %s → normalized region %s", async (_label, profile, stored, expected) => {
    const f = await setup();
    await writeFile(f.service.file, JSON.stringify({ version: 1, accounts: [
      { id: "legacy-x", uid: "google", loginProvider: "google", email: "same@example.com", accountId: "same@example.com",
        access: "old-a", refresh: "old-r", expires: 1_700_000_060_000, region: stored, profile, method: "social" },
    ], models: [], hiddenModels: [] }));
    const accounts = (await f.service.getStatus()).accounts;
    expect(accounts[0].region).toBe(expected);
    expect(accounts[0].needReauth).toBe(false);
  });

  it("modern file with explicit signInRegion survives load unchanged (no double normalization)", async () => {
    const f = await setup();
    await writeFile(f.service.file, JSON.stringify({ version: 1, accounts: [
      { id: "modern", uid: "google", loginProvider: "google", email: "same@example.com", accountId: "same@example.com",
        access: "old-a", refresh: "old-r", expires: 1_700_000_060_000, region: "eu-central-1", signInRegion: "ap-southeast-2",
        profile: "arn:aws:codewhisperer:eu-central-1:123456789012:profile/x", method: "social" },
    ], models: [], hiddenModels: [] }));
    f.expire();
    await f.service.getCredential("modern");
    expect(f.requests.find(r => r.url.includes("/refreshToken"))!.url).toBe("https://prod.ap-southeast-2.auth.desktop.kiro.dev/refreshToken");
    const saved = (await disk(f.service.file)).accounts[0];
    expect(saved).toMatchObject({ region: "eu-central-1", signInRegion: "ap-southeast-2" });
  });
});

// ---- P5: login flow under the exclusive lane ----

describe("P5 login flow under the exclusive queue", () => {
  it("startLogin queues behind a parked commit section and completes after release (no deadlock)", async () => {
    const f = await setup(); await login(f.service); await f.service.syncModels();
    const s = f.service as any;
    const originalPersist = s.persist.bind(s);
    let releasePersist!: () => void; const parked = new Promise<void>(r => { releasePersist = r; });
    s.persist = async (next: any) => { await parked; return originalPersist(next); };
    const hiding = f.service.setModelHidden("claude", true);
    await tick();
    const starting = f.service.startLogin({ method: "portal" });
    await tick(); await tick();
    let started = false; starting.then(() => { started = true; }, () => {});
    await tick();
    expect(started, "startLogin must not complete while a commit section is open").toBe(false);
    releasePersist();
    const startedOk = await withTimeout(starting, 10_000, "P5 startLogin");
    await withTimeout(hiding, 10_000, "P5 hide");
    expect(startedOk.loginId).toBeTruthy();
    const done = await login(f.service);
    expect(done.result.status).toBe("complete");
  });
});
