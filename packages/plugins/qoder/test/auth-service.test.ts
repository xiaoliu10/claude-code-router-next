import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QoderAuthService } from "../src/auth-service";
import type { PluginHostCapabilities } from "../src/core-types";
import { QODER_CHAT, QODER_MARKER, QODER_PROVIDER } from "../src/protocol";
import type { QoderCredential, QoderEngine } from "../src/vendor/engine.mjs";

const PAT = "pt-fixture-token";
const credential = (over: Partial<QoderCredential> = {}): QoderCredential => ({
  access: "job-token-1", refresh: "refresh-1", expires: Date.now() + 3_600_000, uid: "uid-1",
  email: "user@example.com", name: "User", accountId: "user@example.com", machineId: "machine-1", pat: PAT, ...over,
});
const listing = [
  { key: "claude-fast", name: "Fast", context: 128000, images: true, efforts: [], thinks: true, free: false, rate: 0.8, rateWas: 0, source: "app" },
  { key: "qoder-max", name: "Max", context: 256000, images: false, efforts: ["high"], thinks: true, free: true, rate: 1.1, rateWas: 0, source: "app" },
];

function fakeEngine(over: Partial<QoderEngine> = {}): QoderEngine & {
  connectPAT: ReturnType<typeof vi.fn>; refresh: ReturnType<typeof vi.fn>; models: ReturnType<typeof vi.fn>;
  chat: ReturnType<typeof vi.fn>; usage: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn>;
} {
  const engine = {
    connectPAT: vi.fn(async () => credential()),
    refresh: vi.fn(async (cred: QoderCredential) => ({ ...cred, access: "job-token-2", refresh: "refresh-2", expires: Date.now() + 3_600_000 })),
    models: vi.fn(async () => listing),
    chat: vi.fn(async (_cred: any, _body: any, _opts: any) => new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })),
    usage: vi.fn(async () => ({ windows: [{ name: "Credits", used: 12.5, display: "125 / 1000 credits" }], plan: "pro", signIn: "kept" as const })),
    dispose: vi.fn(),
    _internal: {},
    ...over,
  };
  return engine as any;
}

function fixture(engine = fakeEngine()) {
  const root = mkdtempSync(join(tmpdir(), "qoder-fixture-"));
  const configDir = join(root, "ccr");
  mkdirSync(configDir, { mode: 0o700 });
  let config: any = { Providers: [{ name: "other", api_key: "$KEEP_SECRET" }], Router: { default: "other" } };
  const direct = { fixture: "direct" }, subscription = { fixture: "subscription" };
  const host: PluginHostCapabilities = {
    configDir,
    readConfig: vi.fn(async () => { throw new Error("Interpolated config must never be read"); }),
    readRawConfig: vi.fn(async () => structuredClone(config)),
    writeConfig: vi.fn(async (c: any) => { config = structuredClone(c); }),
    reloadRuntime: vi.fn(async () => {}),
    getDirectDispatcher: () => direct, getSubscriptionDispatcher: () => subscription,
  };
  const service = new QoderAuthService({ host, engine });
  return {
    root, configDir, host, engine, service,
    config: () => config,
    managed: () => config.Providers.find((p: any) => p?.name === QODER_PROVIDER),
    file: service.file,
    cleanup: async () => { await service.disconnect().catch(() => {}); rmSync(root, { recursive: true, force: true }); },
  };
}

const fixtures: ReturnType<typeof fixture>[] = [];
const make = (engine?: QoderEngine) => { const f = fixture(engine as any); fixtures.push(f); return f; };
afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup(); });

describe("QoderAuthService isolated PAT lifecycle", () => {
  it("connect persists 0600, writes the managed entry, masks the account and redacts secrets", async () => {
    const f = make();
    expect((await f.service.getStatus()).status).toBe("not_connected");
    expect(existsSync(f.file)).toBe(false);
    // format gates are strict while not connected
    await expect(f.service.connectPAT("not-a-pat")).rejects.toMatchObject({ code: "qoder_pat_invalid", statusCode: 422 });
    await expect(f.service.connectPAT(undefined)).rejects.toMatchObject({ code: "qoder_pat_invalid" });
    await f.service.connectPAT(PAT);
    expect(f.engine.connectPAT).toHaveBeenCalledWith(PAT);
    expect(statSync(f.file).mode & 0o777).toBe(0o600);
    const managed = f.managed();
    expect(managed).toMatchObject({ qoder_managed: true, api_key: QODER_MARKER, api_base_url: QODER_CHAT, enabled: true, models: [] });
    expect(managed.transformer.use).toEqual(["qoder"]);
    expect(f.config().Providers[0].api_key).toBe("$KEEP_SECRET");
    expect(f.config().Router).toEqual({ default: "other" });
    const status = await f.service.getStatus();
    expect(status).toMatchObject({ status: "connected", account: "u***@example.com", modelCount: 0 });
    expect(JSON.stringify(status)).not.toContain(PAT);
    expect(JSON.stringify(status)).not.toContain("job-token-1");
    expect(readFileSync(f.file, "utf8")).not.toContain("\n");
    // a second connect is refused whatever the token looks like
    await expect(f.service.connectPAT(PAT)).rejects.toMatchObject({ code: "qoder_already_connected", statusCode: 409 });
    await expect(f.service.connectPAT("not-a-pat")).rejects.toMatchObject({ code: "qoder_already_connected", statusCode: 409 });
  });

  it("failed exchange writes nothing; failed config write rolls the persisted file back", async () => {
    const refused = make(fakeEngine({ connectPAT: vi.fn(async () => { throw new Error("refused"); }) }));
    await expect(refused.service.connectPAT(PAT)).rejects.toMatchObject({ code: "qoder_upstream_error", statusCode: 502 });
    expect(existsSync(refused.file)).toBe(false);
    expect(refused.config().Providers).toHaveLength(1);

    const f = make();
    f.host.writeConfig = vi.fn(async () => { throw new Error("disk full"); });
    await expect(f.service.connectPAT(PAT)).rejects.toMatchObject({ code: "qoder_config_write_failed" });
    expect(existsSync(f.file)).toBe(false);
  });

  it("coalesces forced refresh, persists the rotated credential, disk reload agrees", async () => {
    const f = make();
    await f.service.connectPAT(PAT);
    await Promise.all([f.service.forceTokenRefresh(), f.service.forceTokenRefresh(), f.service.forceTokenRefresh()]);
    expect(f.engine.refresh).toHaveBeenCalledTimes(1);
    expect(readFileSync(f.file, "utf8")).toContain("job-token-2");
    expect(readFileSync(f.file, "utf8")).toContain("refresh-2");
    const second = new QoderAuthService({ host: f.host, engine: f.engine });
    expect((await second.getStatus()).status).toBe("connected");
  });

  it("persists an engine-internal rotation via onRefresh without a config write, guarded by uid+pat and machineId", async () => {
    const f = make();
    await f.service.connectPAT(PAT);
    (f.host.writeConfig as any).mockClear();
    // internal auto-renewal: same identity, rotated token pair
    f.service.handleEngineRefresh(credential({ access: "job-token-9", refresh: "refresh-9", expires: Date.now() + 3_600_000 }));
    await vi.waitFor(() => expect(readFileSync(f.file, "utf8")).toContain("job-token-9"));
    expect(readFileSync(f.file, "utf8")).toContain("refresh-9");
    // credential-only rotation must not rewrite config (models/visibility unchanged)
    expect(f.host.writeConfig).not.toHaveBeenCalled();
    // a rotation for a DIFFERENT identity is ignored
    f.service.handleEngineRefresh(credential({ uid: "uid-other", pat: "pt-other", access: "job-x", refresh: "refresh-x" }));
    await new Promise(r => setTimeout(r, 10));
    expect(readFileSync(f.file, "utf8")).not.toContain("job-x");
    // a rotation carrying a DIFFERENT machineId (another connection) is ignored
    f.service.handleEngineRefresh(credential({ machineId: "machine-other", access: "job-y", refresh: "refresh-y" }));
    await new Promise(r => setTimeout(r, 10));
    expect(readFileSync(f.file, "utf8")).not.toContain("job-y");
    // after disconnect, a late rotation for the old identity is dropped
    await f.service.disconnect();
    f.service.handleEngineRefresh(credential({ access: "job-late", refresh: "refresh-late" }));
    await new Promise(r => setTimeout(r, 0));
    expect(existsSync(f.file)).toBe(false);
  });

  it("a PAT refused at refresh latches expired until a later refresh succeeds", async () => {
    const f = make();
    await f.service.connectPAT(PAT);
    f.engine.refresh.mockRejectedValueOnce(Object.assign(new Error("PAT refused"), { expired: true }));
    await expect(f.service.forceTokenRefresh()).rejects.toMatchObject({ code: "qoder_reauth_required", statusCode: 401 });
    let status = await f.service.getStatus();
    expect(status.expired).toBe(true);
    expect(status.lastError).toBe("qoder_reauth_required");
    await expect(f.service.ensureUsable()).rejects.toMatchObject({ code: "qoder_reauth_required" });
    // success evidence does NOT clear the expired latch (contract)
    f.service.noteUpstreamSuccess();
    expect((await f.service.getStatus()).expired).toBe(true);
    // but a successful refresh (engine PAT re-exchange) does
    await f.service.forceTokenRefresh();
    status = await f.service.getStatus();
    expect(status.expired).toBeUndefined();
    await f.service.ensureUsable();
  });

  it("a delayed rotation from a previous connection cannot overwrite a same-PAT reconnect", async () => {
    const f = make();
    await f.service.connectPAT(PAT);
    await f.service.disconnect();
    // reconnect with the SAME PAT: the engine issues a NEW machineId
    f.engine.connectPAT.mockResolvedValueOnce(credential({ machineId: "machine-2", access: "job-token-new" }));
    await f.service.connectPAT(PAT);
    expect(readFileSync(f.file, "utf8")).toContain("machine-2");
    // the old connection's rotation (old machineId) must NOT win
    f.service.handleEngineRefresh(credential({ access: "old-conn-rotation", machineId: "machine-1" }));
    await new Promise(r => setTimeout(r, 10));
    expect(readFileSync(f.file, "utf8")).not.toContain("old-conn-rotation");
    // the NEW connection's own rotation (matching machineId) DOES persist
    f.service.handleEngineRefresh(credential({ machineId: "machine-2", access: "job-token-rotated", refresh: "refresh-rotated" }));
    await vi.waitFor(() => expect(readFileSync(f.file, "utf8")).toContain("job-token-rotated"));
  });

  it("a transient refresh failure is qoder_upstream_error, not a reauth latch", async () => {
    const f = make();
    await f.service.connectPAT(PAT);
    f.engine.refresh.mockRejectedValueOnce(new Error("refresh: status 503"));
    await expect(f.service.forceTokenRefresh()).rejects.toMatchObject({ code: "qoder_upstream_error", statusCode: 502 });
    const status = await f.service.getStatus();
    expect(status.expired).toBeUndefined();
    expect(status.lastError).toBe("qoder_upstream_error");
    await f.service.ensureUsable(); // no expired latch: the next request may retry
  });

  it("preflight refresh is bounded by the request signal; the shared rotation still lands", async () => {
    const f = make();
    // connect with a credential already inside the 5-minute lead window
    f.engine.connectPAT.mockResolvedValueOnce(credential({ expires: Date.now() + 1000 }));
    await f.service.connectPAT(PAT);
    let release!: (c: QoderCredential) => void;
    f.engine.refresh.mockImplementationOnce(() => new Promise<QoderCredential>(r => { release = r; }));
    const controller = new AbortController();
    const pending = f.service.dispatch({ messages: [] }, controller.signal);
    await new Promise(r => setTimeout(r, 0));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    // the shared rotation was NOT cancelled: it still persists for the next caller
    release(credential({ access: "late-rotation", refresh: "late-refresh" }));
    await vi.waitFor(() => expect(readFileSync(f.file, "utf8")).toContain("late-rotation"));
  });

  it("connect accepts an exchange without a refresh token and reloads cleanly (PAT-only recovery)", async () => {
    const f = make();
    f.engine.connectPAT.mockResolvedValueOnce(credential({ refresh: "" }));
    await f.service.connectPAT(PAT);
    const second = new QoderAuthService({ host: f.host, engine: f.engine });
    expect((await second.getStatus()).status).toBe("connected");
  });

  it("sync caps the persisted listing to the loader's 512-record limit", async () => {
    const f = make();
    await f.service.connectPAT(PAT);
    f.engine.models.mockResolvedValueOnce(Array.from({ length: 600 }, (_, i) => ({
      key: `m${i}`, name: `M${i}`, context: 1000, images: false, efforts: [], thinks: false, free: false, rate: 0, rateWas: 0, source: "app",
    })));
    const synced = await f.service.syncModels();
    expect(synced.modelCount).toBe(512);
    // a fresh service must LOAD the synced state (loader caps agree)
    const second = new QoderAuthService({ host: f.host, engine: f.engine });
    expect((await second.getStatus()).modelCount).toBe(512);
  });

  it("a refresh landing after disconnect is discarded without latching and cannot resurrect credentials", async () => {
    const f = make();
    await f.service.connectPAT(PAT);
    let release!: (cred: QoderCredential) => void;
    f.engine.refresh.mockImplementationOnce(() => new Promise<QoderCredential>(resolve => { release = resolve; }));
    const refresh = f.service.forceTokenRefresh();
    // let load() settle so the engine refresh is actually in flight
    await new Promise(r => setTimeout(r, 0));
    const gone = f.service.disconnect();
    release(credential({ access: "post-disconnect-token" }));
    const results = await Promise.allSettled([refresh, gone]);
    expect(results.every(r => r.status === "fulfilled" || (r as PromiseRejectedResult).reason?.code === "qoder_not_connected")).toBe(true);
    expect(existsSync(f.file)).toBe(false);
    expect(f.managed()).toBeUndefined();
    expect(f.engine.dispose).toHaveBeenCalled();
  });

  it("cooling breaker runs before refresh; 429 cools, success heals cooling but not expiry", async () => {
    const f = make();
    await f.service.connectPAT(PAT);
    await f.service.noteUpstreamError({ code: "qoder_rate_limited", httpStatus: 429, cooldownMs: 30_000 });
    await expect(f.service.ensureUsable()).rejects.toMatchObject({ code: "qoder_rate_limited", statusCode: 429 });
    expect(f.engine.refresh).not.toHaveBeenCalled();
    expect((await f.service.getStatus()).coolingUntil).toBeGreaterThan(Date.now());
    // default cooldown is 5 minutes and the cap is one hour
    await f.service.noteUpstreamError({ code: "qoder_rate_limited", httpStatus: 429 });
    expect((await f.service.getStatus()).coolingUntil! - Date.now()).toBeLessThanOrEqual(300_500);
    await f.service.noteUpstreamError({ code: "qoder_rate_limited", httpStatus: 429, cooldownMs: 9_000_000 });
    expect((await f.service.getStatus()).coolingUntil! - Date.now()).toBeLessThanOrEqual(3_600_500);
    f.service.noteUpstreamSuccess();
    expect((await f.service.getStatus()).coolingUntil).toBeUndefined();
    await f.service.ensureUsable();
    // plain upstream errors only latch lastError
    await f.service.noteUpstreamError({ code: "qoder_upstream_error", httpStatus: 502 });
    expect((await f.service.getStatus()).lastError).toBe("qoder_upstream_error");
    expect((await f.service.getStatus()).status).toBe("connected");
    // HTTP-level 401 evidence marks expiry
    await f.service.noteUpstreamError({ code: "qoder_upstream_error", httpStatus: 401 });
    expect((await f.service.getStatus()).expired).toBe(true);
  });

  it("sync writes visible ids, hide/restore round-trips, empty or expired listings fail honestly", async () => {
    const f = make();
    await f.service.connectPAT(PAT);
    const synced = await f.service.syncModels();
    expect(synced).toMatchObject({ success: true, models: ["claude-fast", "qoder-max"], modelCount: 2 });
    expect(f.managed().models).toEqual(["claude-fast", "qoder-max"]);
    let status = await f.service.getStatus();
    expect(status.models).toEqual([
      { id: "claude-fast", name: "Fast", context: 128000, free: false, hidden: false },
      { id: "qoder-max", name: "Max", context: 256000, free: true, hidden: false },
    ]);
    await f.service.setModelHidden("claude-fast", true);
    expect(f.managed().models).toEqual(["qoder-max"]);
    expect((await f.service.getStatus()).models[0].hidden).toBe(true);
    expect(JSON.parse(readFileSync(f.file, "utf8")).hiddenModels).toEqual(["claude-fast"]);
    await f.service.setModelHidden("claude-fast", false);
    expect(f.managed().models).toEqual(["claude-fast", "qoder-max"]);
    await expect(f.service.setModelHidden("nope", true)).rejects.toMatchObject({ code: "qoder_model_unknown" });

    const before = f.config();
    f.engine.models.mockResolvedValueOnce([]);
    await expect(f.service.syncModels()).rejects.toMatchObject({ code: "qoder_upstream_error" });
    expect(f.config()).toEqual(before);
    // expired evidence at sync latches reauth like the refresh path
    f.engine.models.mockRejectedValueOnce(Object.assign(new Error("expired"), { expired: true }));
    await expect(f.service.syncModels()).rejects.toMatchObject({ code: "qoder_reauth_required" });
    expect((await f.service.getStatus()).expired).toBe(true);
  });

  it("usage caches for 60s, single-flights concurrent reads, and failures keep the stale snapshot and cooldown", async () => {
    const f = make();
    await f.service.connectPAT(PAT);
    const first = await f.service.getUsage();
    expect(first).toMatchObject({ known: true, stale: false, plan: "pro", windows: [{ name: "Credits", used: 12.5 }] });
    await f.service.getUsage();
    expect(f.engine.usage).toHaveBeenCalledTimes(1);
    // age past the 60s cache window without touching the real timers
    const t0 = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => t0 + 61_000);
    try {
      // concurrent callers share one job (microtask delay keeps the job in flight)
      f.engine.usage.mockImplementationOnce(async () => {
        await Promise.resolve();
        return { windows: [{ name: "Credits", used: 20, display: "200 / 1000 credits" }], signIn: "kept" as const };
      });
      const [a, b] = await Promise.all([f.service.getUsage(), f.service.getUsage()]);
      expect(f.engine.usage).toHaveBeenCalledTimes(2);
      expect(a.windows).toEqual(b.windows);
      expect(a.stale).toBe(false);
      // failed read: previous snapshot returned stale, cooldown RETAINED
      clock.mockImplementation(() => t0 + 122_000);
      await f.service.noteUpstreamError({ code: "qoder_rate_limited", httpStatus: 429, cooldownMs: 60_000 });
      f.engine.usage.mockRejectedValueOnce(new Error("down"));
      const failed = await f.service.getUsage();
      expect(failed).toMatchObject({ known: true, stale: true, coolingUntil: expect.any(Number) });
      await expect(f.service.ensureUsable()).rejects.toMatchObject({ code: "qoder_rate_limited" });
      // a malformed body is not validated success either
      clock.mockImplementation(() => t0 + 123_000);
      f.engine.usage.mockResolvedValueOnce({ windows: [], signIn: "kept", error: "missing quota data" });
      const unknown = await f.service.getUsage();
      expect(unknown.known).toBe(true);
      expect(unknown.stale).toBe(true);
      await expect(f.service.ensureUsable()).rejects.toMatchObject({ code: "qoder_rate_limited" });
    } finally { clock.mockRestore(); }
  });

  it("usage inside the refresh lead rotates the credential first", async () => {
    const f = make(fakeEngine({
      connectPAT: vi.fn(async () => credential({ expires: Date.now() + 60_000 })),
    }));
    await f.service.connectPAT(PAT);
    await f.service.getUsage();
    expect(f.engine.refresh).toHaveBeenCalledTimes(1);
    expect(f.engine.usage.mock.calls[0][0].access).toBe("job-token-2");
  });

  it("dispatch passes the session id and signal to the engine after the breaker", async () => {
    const f = make();
    await f.service.connectPAT(PAT);
    const controller = new AbortController();
    await f.service.dispatch({ model: "claude-fast", prompt_cache_key: "session-1" }, controller.signal);
    expect(f.engine.chat).toHaveBeenCalledTimes(1);
    const [cred, body, opts] = f.engine.chat.mock.calls[0];
    expect(cred.access).toBe("job-token-1");
    expect(body.prompt_cache_key).toBe("session-1");
    expect(opts).toEqual({ session: "session-1", signal: controller.signal });
    // cooling breaker applies to the data plane too
    await f.service.noteUpstreamError({ code: "qoder_rate_limited", httpStatus: 429 });
    await expect(f.service.dispatch({}, controller.signal)).rejects.toMatchObject({ code: "qoder_rate_limited" });
  });

  it("disconnect removes config and file, disposes the engine and refuses later work", async () => {
    const f = make();
    await f.service.connectPAT(PAT);
    await f.service.syncModels();
    await f.service.disconnect();
    expect(existsSync(f.file)).toBe(false);
    expect(f.managed()).toBeUndefined();
    expect(f.config().Providers).toHaveLength(1);
    expect(f.engine.dispose).toHaveBeenCalled();
    expect((await f.service.getStatus()).status).toBe("not_connected");
    await expect(f.service.forceTokenRefresh()).rejects.toMatchObject({ code: "qoder_not_connected" });
    await expect(f.service.getUsage()).rejects.toMatchObject({ code: "qoder_not_connected" });
    await expect(f.service.syncModels()).rejects.toMatchObject({ code: "qoder_not_connected" });
    // disconnect is idempotent on an already-clean state
    await expect(f.service.disconnect()).resolves.toMatchObject({ success: true });
  });

  it("a config write failure at disconnect keeps the credential file (rollback parity)", async () => {
    const f = make();
    await f.service.connectPAT(PAT);
    f.host.writeConfig = vi.fn(async () => { throw new Error("disk full"); });
    await expect(f.service.disconnect()).rejects.toMatchObject({ code: "qoder_config_write_failed" });
    expect(existsSync(f.file)).toBe(true);
    expect(f.engine.dispose).not.toHaveBeenCalled();
  });

  it("corrupt or oversized credential files fail closed as unreadable", async () => {
    const f = make();
    writeFileSync(f.file, "{}");
    await expect(f.service.getStatus()).rejects.toMatchObject({ code: "qoder_credential_unreadable", statusCode: 500 });
    writeFileSync(f.file, "x".repeat(1_048_577));
    await expect(f.service.getStatus()).rejects.toMatchObject({ code: "qoder_credential_unreadable" });
    // tampered credential fields fail validation too
    const saved = { version: 1, credential: credential({ pat: "forged" }), models: [], hiddenModels: [] };
    writeFileSync(f.file, JSON.stringify(saved));
    await expect(f.service.getStatus()).rejects.toMatchObject({ code: "qoder_credential_unreadable" });
    // a valid hand-written file loads (strict shape accepted)
    writeFileSync(f.file, JSON.stringify({ version: 1, credential: credential(), models: [], hiddenModels: [] }));
    expect((await f.service.getStatus()).status).toBe("connected");
  });

  it("readRawConfig absence never falls back to interpolated config", async () => {
    const f = make();
    delete (f.host as any).readRawConfig;
    await expect(f.service.connectPAT(PAT)).rejects.toMatchObject({ code: "qoder_raw_config_required" });
    expect(existsSync(f.file)).toBe(false);
    expect(f.host.readConfig).not.toHaveBeenCalled();
  });
});
