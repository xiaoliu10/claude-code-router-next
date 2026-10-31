import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { KiroAuthService } from "../src/auth-service";
import { BUILDER_ID_PROFILE, CALLBACK_PORTS } from "../src/protocol";

const services: KiroAuthService[] = [], dirs: string[] = [];
afterEach(async () => { services.splice(0).forEach(s => s.close()); await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
async function setup() {
  const configDir = await mkdtemp(join(tmpdir(), "kiro-auth-")); dirs.push(configDir);
  let cfg: any = { Providers: [{ name: "other", api_key: "$KEEP" }] }; let now = 1_700_000_000_000;
  const requests: Array<{ url: string; body: any; init: RequestInit }> = [];
  let refreshStatus = 200, refreshCount = 0;
  const network = vi.fn(async (input: any, init: any) => {
    const url = String(input), body = init.body ? JSON.parse(init.body) : undefined; requests.push({ url, body, init });
    let data: any;
    if (url.includes("/client/register")) data = { clientId: "client", clientSecret: "client-secret" };
    else if (url.includes("/refreshToken") || body?.grantType === "refresh_token") { refreshCount++; return Response.json({ accessToken: "rotated", expiresIn: 3600 }, { status: refreshStatus }); }
    else if (url.includes("/token")) data = { accessToken: "access", refreshToken: "refresh", expiresIn: 3600, profileArn: "arn:aws:codewhisperer:eu-west-1:123:profile/test" };
    else if (url.includes("Get-Usage-Limits")) data = { userInfo: { email: "same@example.com" }, subscriptionInfo: { subscriptionTitle: "KIRO PRO" }, usageBreakdownList: [{ currentUsageWithPrecision: 5, usageLimitWithPrecision: 100, nextDateReset: 1_800_000_000 }] };
    else if (url.includes("List-Available-Profiles")) data = { profiles: [{ arn: "arn:aws:codewhisperer:eu-west-1:123:profile/test" }] };
    else if (url.includes("List-Available-Models")) data = url.includes("nextToken") ? { models: [{ modelId: "auto", tokenLimits: { maxInputTokens: 1000 } }], defaultModel: { modelId: "auto" } } : { models: [{ modelId: "claude", modelName: "Claude", supportedInputTypes: ["IMAGE"], tokenLimits: { maxInputTokens: 200000, maxOutputTokens: 8000 } }], nextToken: "page2" };
    else throw new Error(`Unexpected URL ${url}`);
    return Response.json(data);
  });
  const dispatcher = {};
  const host: any = { configDir, readRawConfig: async () => cfg, writeConfig: vi.fn(async c => { cfg = structuredClone(c); }), reloadRuntime: vi.fn(async () => {}), getSubscriptionDispatcher: () => dispatcher, getDirectDispatcher: () => { throw new Error("wrong dispatcher"); } };
  const service = new KiroAuthService({ host, fetch: network as typeof fetch, now: () => now }); services.push(service);
  return { service, host, network, requests, configDir, dispatcher, config: () => cfg, time: (n: number) => { now = n; }, expire: () => { now += 3_500_000; }, setRefreshStatus: (s: number) => { refreshStatus = s; }, refreshCount: () => refreshCount };
}
async function login(s: KiroAuthService, method: "portal" | "builderid" | "idc" = "portal", provider = "google", region = "us-east-1") {
  const started = await s.startLogin({ method, region, ...(method === "idc" ? { startUrl: "https://org.awsapps.com/start" } : {}) });
  const u = new URL(started.url), redirect = u.searchParams.get("redirect_uri")!;
  const callback = new URL(method === "portal" ? `${redirect}/signin/callback` : redirect);
  callback.searchParams.set("state", u.searchParams.get("state")!); callback.searchParams.set("code", "code");
  if (method === "portal") callback.searchParams.set("login_option", provider);
  return { started, callback, result: await s.completeLogin(started.loginId, callback.href) };
}

describe("Kiro browser credentials", () => {
  it.each(["portal", "builderid", "idc"] as const)("completes %s with PKCE, private persistence and fixed-origin identity encoding", async method => {
    const f = await setup(); const { started, result } = await login(f.service, method, "google", "eu-west-1");
    expect(result.status).toBe("complete");
    // Builder ID's fixed profile lives in us-east-1, so its Kiro region is us-east-1 whatever directory region routes the sign-in.
    const expectedRegion = method === "builderid" ? "us-east-1" : "eu-west-1";
    expect(result.account).toMatchObject({ email: "same@example.com", region: expectedRegion, uid: method === "portal" ? "google" : method === "builderid" ? "builderid" : "enterprise" });
    const auth = new URL(started.url); expect(auth.searchParams.get("code_challenge_method")).toBe("S256"); expect(auth.searchParams.get("code_challenge")).toBeTruthy();
    const exchange = f.requests.find(r => r.url.endsWith("/token"))!;
    expect(exchange.url).toBe(method === "portal" ? "https://prod.eu-west-1.auth.desktop.kiro.dev/oauth/token" : "https://oidc.eu-west-1.amazonaws.com/token");
    expect(exchange.body[method === "portal" ? "code_verifier" : "codeVerifier"]).toBeTruthy();
    if (method !== "portal") { const reg = f.requests.find(r => r.url.endsWith("/client/register"))!; expect(reg.body.issuerUrl).toBe(method === "builderid" ? "https://view.awsapps.com/start" : "https://org.awsapps.com/start"); }
    expect(f.requests.every(r => r.init.headers["Accept-Encoding"] === "identity" && (r.init as any).dispatcher === f.dispatcher && r.init.redirect === "error")).toBe(true);
    expect((await stat(f.service.file)).mode & 0o777).toBe(0o600);
    const disk = JSON.parse(await readFile(f.service.file, "utf8")); expect(disk.accounts[0].refresh).toBe("refresh");
    expect(JSON.stringify(await f.service.getStatus())).not.toContain("client-secret"); expect(JSON.stringify(await f.service.getStatus())).not.toContain('"access"');
    expect(f.config().Providers[1]).toMatchObject({ name: "kiro-subscription", api_key: "ccr-managed-kiro" }); expect(f.config().Providers[0].api_key).toBe("$KEEP");
  });
  it("keeps same-email identities separate and replaces only matching email+uid", async () => {
    const f = await setup(); await login(f.service, "portal", "google"); await login(f.service, "portal", "github"); await login(f.service, "builderid"); await login(f.service, "idc");
    const before = await f.service.getStatus(); expect(before.accounts).toHaveLength(4);
    expect(before.accounts.map(a => a.name)).toEqual(["same@example.com (Google)", "same@example.com (GitHub)", "same@example.com (Builder ID)", "same@example.com (IAM Identity Center)"]);
    await login(f.service, "portal", "google"); const after = await f.service.getStatus(); expect(after.accounts).toHaveLength(4);
    expect(after.accounts.find(a => a.uid === "google")!.id).toBe(before.accounts[0].id);
    await f.service.disconnect(before.accounts[1].id); expect((await f.service.getStatus()).accounts.map(a => a.uid)).not.toContain("github");
    expect((await f.service.getStatus()).accounts).toHaveLength(3);
  });
  it("refreshes within two minutes once across concurrent consumers, preserving an omitted refresh token", async () => {
    const f = await setup(); await login(f.service); await f.service.getCredential(); expect(f.refreshCount()).toBe(0);
    f.expire(); const credentials = await Promise.all([f.service.getCredential(), f.service.getCredential(), f.service.getCredential()]);
    expect(f.refreshCount()).toBe(1); expect(credentials.every(c => c.access === "rotated" && c.refresh === "refresh")).toBe(true);
    expect(JSON.parse(await readFile(f.service.file, "utf8")).accounts[0].access).toBe("rotated");
  });
  it.each([401, 403])("latches reauth and one-hour cooldown on refresh %s without removing other accounts", async status => {
    const f = await setup(); await login(f.service); await login(f.service, "portal", "github"); const accounts = (await f.service.getStatus()).accounts;
    f.expire(); f.setRefreshStatus(status); await expect(f.service.getCredential(accounts[0].id)).rejects.toMatchObject({ code: "kiro_reauth_required" });
    const state = await f.service.getStatus(); expect(state.accounts[0]).toMatchObject({ needReauth: true, coolingUntil: 1_700_000_000_000 + 3_500_000 + 3_600_000 }); expect(state.accounts[1].needReauth).toBe(false);
    await expect(f.service.getCredential(accounts[0].id)).rejects.toMatchObject({ code: "kiro_reauth_required" }); expect(f.refreshCount()).toBe(1);
  });
  it("does not mark a transient refresh failure as reauthentication", async () => { const f = await setup(); await login(f.service); f.expire(); f.setRefreshStatus(503); await expect(f.service.getCredential()).rejects.toMatchObject({ code: "kiro_upstream_error" }); expect((await f.service.getStatus()).accounts[0].needReauth).toBe(false); });
  it("uses the directory region for AWS OIDC and the profile ARN region for management", async () => {
    const f = await setup(); await login(f.service, "idc", "", "ap-southeast-2"); f.expire(); await f.service.getCredential();
    // Token endpoints follow the sign-in (directory) region supplied by the user.
    expect(f.requests.find(r => r.body?.grantType === "refresh_token")!.url).toBe("https://oidc.ap-southeast-2.amazonaws.com/token");
    const synced = await f.service.syncModels(); expect(synced.models.map(m => m.id)).toEqual(["auto", "claude"]);
    // Kiro's API is where the profile ARN says (the fixture's eu-west-1 profile), not the directory region.
    expect(f.requests.filter(r => r.url.includes("List-Available-Models")).every(r => r.url.startsWith("https://management.eu-west-1.kiro.dev/"))).toBe(true);
    expect((await f.service.getUsage()).windows[0]).toMatchObject({ amount: 5, limit: 100, used: 5 });
    await f.service.setModelHidden("claude", true); expect(f.config().Providers[1].models).toEqual(["auto"]);
  });
  it("accepts a legacy single credential envelope and normalizes provider uid/name", async () => {
    const f = await setup(); await writeFile(f.service.file, JSON.stringify({ version: 1, credential: { access: "old", refresh: "r", expires: 1_800_000_000_000, email: "same@example.com", accountId: "same@example.com", loginProvider: "BuilderId", region: "us-east-1", method: "idc" }, models: [], hiddenModels: [] }));
    const status = await f.service.getStatus(); expect(status.accounts[0]).toMatchObject({ uid: "builderid", name: "same@example.com (Builder ID)" });
    expect((await f.service.getCredential()).profile).toBe(BUILDER_ID_PROFILE);
  });
  it("validates callback authority/path/state, supports poll paste, cancels sessions", async () => {
    const f = await setup(), started = await f.service.startLogin({ method: "portal" }), url = new URL(started.url);
    const callback = `${url.searchParams.get("redirect_uri")}/signin/callback?state=${url.searchParams.get("state")}&code=c&login_option=google`;
    for (const bad of [callback.replace("localhost", "evil.invalid"), callback.replace("state=", "state=wrong"), callback.replace("/signin/callback", "/other"), callback.replace("http:", "https:")]) await expect(f.service.completeLogin(started.loginId, bad)).rejects.toMatchObject({ code: "kiro_callback_invalid" });
    expect(f.requests).toHaveLength(0); expect((await f.service.pollLogin(started.loginId, callback)).status).toBe("complete");
    const next = await f.service.startLogin({ method: "portal" }); await f.service.cancelLogin(next.loginId); expect(await f.service.pollLogin(next.loginId)).toEqual({ status: "cancelled" });
    await expect(f.service.startLogin({ method: "idc", startUrl: "http://bad" })).rejects.toMatchObject({ code: "kiro_login_invalid" });
  });
  it("skips occupied callback ports and automatically accepts a local browser callback", async () => {
    const server = createServer(); await new Promise<void>(resolve => server.listen(CALLBACK_PORTS[0], "127.0.0.1", resolve));
    try { const f = await setup(), started = await f.service.startLogin({ method: "portal" }), u = new URL(started.url); const redirect = new URL(u.searchParams.get("redirect_uri")!);
      expect(redirect.port).not.toBe(String(CALLBACK_PORTS[0]));
      const callback = `http://127.0.0.1:${redirect.port}/signin/callback?state=${u.searchParams.get("state")}&code=x&login_option=github`;
      expect((await fetch(callback)).status).toBe(200); expect((await f.service.pollLogin(started.loginId)).status).toBe("complete");
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it("continues portal Builder ID choice into AWS PKCE", async () => {
    const f = await setup(), started = await f.service.startLogin({ method: "portal" }), u = new URL(started.url);
    const q = new URLSearchParams({ state: u.searchParams.get("state")!, login_option: "builderid", issuer_url: "https://view.awsapps.com/start", idc_region: "us-east-1" });
    const transition = await f.service.completeLogin(started.loginId, `${u.searchParams.get("redirect_uri")}/signin/callback?${q}`);
    expect(transition.status).toBe("pending"); const aws = new URL(transition.url!);
    expect(aws.searchParams.get("state")).not.toBe(u.searchParams.get("state"));
    const callback = new URL(aws.searchParams.get("redirect_uri")!); callback.searchParams.set("state", aws.searchParams.get("state")!); callback.searchParams.set("code", "aws-code");
    expect((await f.service.completeLogin(started.loginId, callback.href)).account?.uid).toBe("builderid");
  });
  it("refuses token resurrection when disconnect wins an in-flight refresh", async () => {
    const f = await setup(); await login(f.service); f.expire();
    let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
    const original = f.network.getMockImplementation()!;
    f.network.mockImplementation(async (input, init) => { if (String(input).endsWith("/refreshToken")) await barrier; return original(input, init); });
    const refreshing = f.service.getCredential();
    await new Promise(resolve => setImmediate(resolve));
    await f.service.disconnect(); release();
    await expect(refreshing).rejects.toMatchObject({ code: "kiro_not_connected" });
    expect((await f.service.getStatus()).accounts).toEqual([]);
    await expect(readFile(f.service.file)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("expires pending sessions after ten minutes and releases their port", async () => {
    const f = await setup(); const started = await f.service.startLogin({ method: "portal" });
    vi.useFakeTimers();
    try {
      // Start again under the virtual timer so the original listener is cancelled.
      const next = await f.service.startLogin({ method: "portal" });
      vi.advanceTimersByTime(600_000);
      expect(await f.service.pollLogin(next.loginId)).toEqual({ status: "expired" });
      expect(await f.service.pollLogin(started.loginId)).toEqual({ status: "cancelled" });
    } finally { vi.useRealTimers(); }
  });

});
