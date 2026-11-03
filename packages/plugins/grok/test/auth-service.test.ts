import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GrokAuthService } from "../src/auth-service";
import { createGrokEngine } from "../src/vendor/engine.mjs";
import { fixture, auth, TOKEN, ROTATED } from "./fixtures";
const fixtures: ReturnType<typeof fixture>[] = [];
const make = (options?: Parameters<typeof fixture>[0]) => { const f = fixture(options); fixtures.push(f); return f; };
afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup(); });
describe("GrokAuthService isolated CLI lifecycle", () => {
  it("activation/status never import the existing CLI; explicit import writes 0600 and redacts", async () => {
    const f = make(); const before = readFileSync(join(f.cliHome, "auth.json"), "utf8");
    expect((await f.service.getStatus()).status).toBe("not_connected");
    expect(existsSync(f.service.file)).toBe(false);
    await f.service.importCurrent();
    expect(statSync(f.service.file).mode & 0o777).toBe(0o600);
    expect(await f.service.getAccessToken()).toBe(TOKEN);
    const status = await f.service.getStatus(); expect(status.account).toBe("use…");
    expect(JSON.stringify(status)).not.toContain(TOKEN); expect(JSON.stringify(status)).not.toContain(f.cliHome);
    expect(f.config().Providers[0].api_key).toBe("$KEEP_SECRET"); expect(f.config().Router).toEqual({ default: "other,other" });
    expect(f.config().Providers[1].transformer.use).toEqual(["openai-responses", "grok"]);
    await f.service.disconnect();
    expect(readFileSync(join(f.cliHome, "auth.json"), "utf8")).toBe(before);
    expect(existsSync(f.service.file)).toBe(false); expect(f.config().Providers).toHaveLength(1);
  });
  it("tightens a world-readable credential file to 0600 on load", async () => {
    const f = make(); await f.service.importCurrent();
    chmodSync(f.service.file, 0o644);
    expect(statSync(f.service.file).mode & 0o777).toBe(0o644);
    // A fresh service over the same file must tighten it on first use — the
    // write path is not the only place the mode is asserted.
    const reopened = new GrokAuthService({ host: f.host, env: f.env, userHome: f.home });
    await reopened.getAccessToken();
    expect(statSync(f.service.file).mode & 0o777).toBe(0o600);
  });
  it("coalesces forced refresh, rereads rotating credential, injects only explicit CLI proxy", async () => {
    const f = make({ proxy: "$FIXTURE_PROXY" }); await f.service.importCurrent();
    await Promise.all([f.service.forceTokenRefresh(), f.service.forceTokenRefresh(), f.service.forceTokenRefresh()]);
    expect(await f.service.getAccessToken()).toBe(ROTATED);
    expect(f.read("calls").trim().split("\n")).toHaveLength(1);
    expect(f.read("env")).toContain("|||http://fixture.invalid:9999|http://fixture.invalid:9999");
    expect(readFileSync(f.service.file, "utf8")).toContain(ROTATED);
    expect(readFileSync(f.service.file, "utf8")).not.toContain("cli-only-refresh-secret");
  });
  it("near expiry refreshes and unchanged rejected token fails without deleting credentials", async () => {
    const f = make({ expires: Date.now() + 1000 }); await f.service.importCurrent();
    expect(await f.service.getAccessToken()).toBe(ROTATED);
    writeFileSync(join(f.root, "unchanged"), "1");
    await expect(f.service.forceTokenRefresh()).rejects.toMatchObject({ code: "grok_reauth_required" });
    expect(existsSync(f.service.file)).toBe(true); expect((await f.service.getStatus()).status).toBe("expired");
  });
  it("renewed disk credential wins; torn reads retain only last whole credential", async () => {
    const f = make(); await f.service.importCurrent();
    writeFileSync(join(f.cliHome, "auth.json"), auth(ROTATED)); await f.service.forceTokenRefresh();
    expect(existsSync(join(f.root, "calls"))).toBe(false);
    const engine = createGrokEngine({ env: f.env, userHome: f.home });
    expect((await engine.credential(f.cliHome))!.key).toBe(ROTATED);
    writeFileSync(join(f.cliHome, "auth.json"), "{");
    expect((await engine.credential(f.cliHome))!.key).toBe(ROTATED);
    // Activation-local factory state: a second engine instance shares no torn-read
    // cache, renewal single-flight or version cache with the first (no module globals).
    const fresh = createGrokEngine({ env: f.env, userHome: f.home });
    expect(fresh).not.toBe(engine);
    await expect(fresh.credential(f.cliHome)).rejects.toThrow();
    expect((await engine.credential(f.cliHome))!.key).toBe(ROTATED);
    const second = new GrokAuthService({ host: f.host, env: f.env, userHome: f.home });
    expect(second.engine).not.toBe(f.service.engine);
  });
  it("device login preserves no-email identity in owned home and disconnect removes only owned home", async () => {
    const f = make({ login: "success" }); const result = await f.service.startLogin();
    expect(result.url).toBe("https://accounts.x.ai/oauth2/device?user_code=AB12-CD34");
    let poll;
    for (let n = 0; n < 20; n++) { poll = await f.service.pollLogin(result.loginId); if (poll.status !== "pending") break; await new Promise(r => setTimeout(r, 5)); }
    expect(poll.status).toBe("connected");
    const owned = JSON.parse(readFileSync(f.service.file, "utf8")); expect(owned.owned).toBe(true);
    expect(statSync(owned.home).mode & 0o777).toBe(0o700);
    await f.service.disconnect(); expect(existsSync(owned.home)).toBe(false); expect(existsSync(join(f.cliHome, "auth.json"))).toBe(true);
  });
  it("cancel kills pending CLI, cleans home; hostile login URL is rejected", async () => {
    const f = make({ login: "wait" }); const result = await f.service.startLogin();
    await f.service.cancelLogin(result.loginId); expect((await f.service.pollLogin(result.loginId)).status).toBe("cancelled");
    expect(existsSync(join(f.configDir, "grok-homes", result.loginId))).toBe(false);
    const bad = make({ login: "hostile" }); await expect(bad.service.startLogin()).rejects.toMatchObject({ code: "grok_login_failed" });
  }, 25000);
  it("private login without identity fails, persisted malformed state fails closed", async () => {
    const f = make({ login: "identityless" }); const result = await f.service.startLogin();
    let poll; for (let n = 0; n < 20; n++) { poll = await f.service.pollLogin(result.loginId); if (poll.status !== "pending") break; await new Promise(r => setTimeout(r, 5)); }
    expect(poll.status).toBe("error"); expect(existsSync(f.service.file)).toBe(false);
    writeFileSync(f.service.file, "{}");
    await expect(new GrokAuthService({ host: f.host, env: f.env, userHome: f.home }).getAccessToken()).rejects.toMatchObject({ code: "grok_credential_unreadable" });
  });
  it("discovery rejects arbitrary PATH programs and missing CLI cannot silently fall back", async () => {
    const f = make();
    const unrelated = join(f.root, "unrelated-bin"); mkdirSync(unrelated); writeFileSync(join(unrelated, "grok"), "#!/bin/sh\nexit 99\n"); chmodSync(join(unrelated, "grok"), 0o700);
    const arbitrary = createGrokEngine({ env: { HOME: f.configDir, PATH: unrelated }, userHome: f.configDir });
    expect(arbitrary.executable()).toBe("");
    const absent = new GrokAuthService({ host: { ...f.host, configDir: join(f.configDir, "absent") }, env: { HOME: f.configDir, PATH: "" }, userHome: f.configDir });
    await expect(absent.importCurrent()).rejects.toMatchObject({ code: "grok_cli_missing" });
  });
  it("raw config failure never falls back to interpolated config or persists an import", async () => {
    const f = make(); f.host.readRawConfig = async () => { throw new Error(TOKEN); };
    await expect(f.service.importCurrent()).rejects.toThrow(); expect(existsSync(f.service.file)).toBe(false);
    expect(f.host.readConfig).not.toHaveBeenCalled();
  });
  it("login expiry kills and cleans pending process on the bounded lifecycle", async () => {
    const f = make({ login: "wait" });
    const service = new GrokAuthService({ host: f.host, env: f.env, userHome: f.home, linkTimeoutMs: 15000, loginTimeoutMs: 1000 });
    const login = await service.startLogin();
    await new Promise(r => setTimeout(r, 1100));
    expect((await service.pollLogin(login.loginId)).status).toBe("expired");
    expect(existsSync(join(f.configDir, "grok-homes", login.loginId))).toBe(false);
  }, 20000);
  it("models retry once on 401 through host dispatcher; empty sync preserves catalog and hide/restore", async () => {
    const f = make(); await f.service.importCurrent();
    f.upstream.mockResolvedValueOnce(new Response("rejected", { status: 401 })).mockResolvedValueOnce(new Response(JSON.stringify({ data: [
      { id: "grok-fixture", context_window: 128000, context_windows: [128000, 500000], reasoning_efforts: [{ value: "high" }] },
      { id: "wrong-api", api_backend: "chat" },
    ] })));
    await f.service.syncModels();
    expect(f.upstream).toHaveBeenCalledTimes(2);
    expect(f.upstream.mock.calls[1][1].headers.get("authorization")).toBe(`Bearer ${ROTATED}`);
    expect(f.upstream.mock.calls[1][1].dispatcher).toBe(f.subscription);
    expect(f.upstream.mock.calls[1][1].redirect).toBe("error");
    expect(f.config().Providers[1].models).toEqual(["grok-fixture", "grok-fixture@500k"]);
    await f.service.setModelHidden("grok-fixture@500k", true); expect(f.config().Providers[1].models).toEqual(["grok-fixture"]);
    await f.service.setModelHidden("grok-fixture@500k", false);
    const before = f.config(); f.upstream.mockResolvedValueOnce(new Response('{"data":[]}'));
    await expect(f.service.syncModels()).rejects.toMatchObject({ code: "grok_models_empty" }); expect(f.config()).toEqual(before);
  });
  it("refresh racing model sync keeps rotated credential AND synced models; failed persist rolls config back and keeps shared CLI", async () => {
    const f = make(); await f.service.importCurrent();
    // models sync whose first upstream call is a 401: the core-style refresh path
    // persists the rotated credential through the same chain the model mutation uses.
    f.upstream.mockResolvedValueOnce(new Response("denied", { status: 401 })).mockResolvedValueOnce(new Response(JSON.stringify({ data: [
      { id: "grok-fixture", context_window: 128000 },
    ] })));
    await f.service.syncModels();
    const durable = JSON.parse(readFileSync(f.service.file, "utf8"));
    expect(durable.credential.key).toBe(ROTATED); expect(durable.models.map((m: any) => m.id)).toEqual(["grok-fixture"]);
    await f.service.setModelHidden("grok-fixture", true);
    expect(JSON.parse(readFileSync(f.service.file, "utf8"))).toMatchObject({ credential: { key: ROTATED }, hiddenModels: ["grok-fixture"] });
    // persist failure after a successful config write: managed entry rolls back,
    // the private file keeps its last whole state, shared CLI credentials untouched.
    const before = f.config(); const shared = readFileSync(join(f.cliHome, "auth.json"), "utf8");
    chmodSync(f.configDir, 0o500);
    try { await expect(f.service.setModelHidden("grok-fixture", false)).rejects.toMatchObject({ code: "grok_persist_failed" }); }
    finally { chmodSync(f.configDir, 0o700); }
    expect(f.config().Providers[1].models).toEqual(before.Providers[1].models);
    expect(JSON.parse(readFileSync(f.service.file, "utf8")).hiddenModels).toEqual(["grok-fixture"]);
    expect(readFileSync(join(f.cliHome, "auth.json"), "utf8")).toBe(shared);
  });
  it("concurrent refresh started before disconnect cannot resurrect credentials", async () => {
    const f = make({ expires: Date.now() + 1000 }); await f.service.importCurrent();
    const refresh = f.service.forceTokenRefresh();
    const gone = f.service.disconnect();
    await Promise.allSettled([refresh, gone]);
    expect(existsSync(f.service.file)).toBe(false);
    expect(f.config().Providers.some((p: any) => p?.name === "grok-subscription")).toBe(false);
  });
  it("classify 0/403 never impersonates expiry; only 401 does", async () => {
    const f = make(); await f.service.importCurrent();
    await f.service.noteUpstreamError({ code: "grok_upstream_error" });
    expect((await f.service.getStatus()).status).toBe("connected");
    f.upstream.mockResolvedValueOnce(new Response("forbidden", { status: 403 }));
    await expect(f.service.syncModels()).rejects.toMatchObject({ code: "grok_upstream_error" });
    expect((await f.service.getStatus()).status).toBe("connected");
    expect(existsSync(f.service.file)).toBe(true);
  });
  it("latched reauth/rate state heals only on validated success, never on quota failure", async () => {
    const f = make(); await f.service.importCurrent();
    await f.service.noteUpstreamError({ code: "grok_rate_limited" });
    await expect(f.service.ensureUsable()).rejects.toMatchObject({ code: "grok_rate_limited" });
    // Billing failure (missing quota fields): stale card, cooldown RETAINED, no healing.
    f.upstream.mockResolvedValueOnce(new Response('{"config":{}}'));
    expect((await f.service.getUsage()).known).toBe(false);
    await expect(f.service.ensureUsable()).rejects.toMatchObject({ code: "grok_rate_limited" });
    // And a data-plane reauth latch never heals from a FAILED exchange either.
    await f.service.noteUpstreamError({ code: "grok_reauth_required" });
    expect((await f.service.getStatus()).status).toBe("expired");
    // A well-formed zero-used reading is a validated success: heals both latches.
    f.upstream.mockResolvedValueOnce(new Response('{"config":{"creditUsagePercent":0}}'));
    expect(await f.service.getUsage()).toMatchObject({ known: true, usedPercent: 0, stale: false });
    expect((await f.service.getStatus()).status).toBe("connected");
    await f.service.ensureUsable();
    // Model sync heals the reauth latch as well.
    await f.service.noteUpstreamError({ code: "grok_reauth_required" });
    f.upstream.mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "grok-fixture", context_window: 1000 }] })));
    await f.service.syncModels();
    expect((await f.service.getStatus()).status).toBe("connected");
  });
  it("unknown billing is not zero; failed reads preserve explicitly stale snapshot and 429 state", async () => {
    const f = make(); await f.service.importCurrent();
    f.upstream.mockResolvedValueOnce(new Response('{"config":{}}'));
    expect((await f.service.getUsage()).known).toBe(false);
    f.upstream.mockResolvedValueOnce(new Response('{"config":{"creditUsagePercent":0}}'));
    expect(await f.service.getUsage()).toMatchObject({ known: true, usedPercent: 0, stale: false });
    await f.service.noteUpstreamError({ code: "grok_rate_limited" });
    f.upstream.mockRejectedValueOnce(new Error(TOKEN));
    expect(await f.service.getUsage()).toMatchObject({ known: true, usedPercent: 0, stale: true });
    await expect(f.service.ensureUsable()).rejects.toMatchObject({ code: "grok_rate_limited" });
  });
});
