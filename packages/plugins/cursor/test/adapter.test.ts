import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureCursorEngine, _internal } from "../src/vendor/engine.mjs";
import { nativeSessions } from "../src/vendor/native-session.mjs";
import { registerCursorAdminRoutes } from "../src/admin-routes";
import { CursorAuthService, type CursorCredential } from "../src/auth-service";
import { CursorTransformer } from "../src/transformer";
import { createCursorManagedRuntime, dispatcherIsProxy, resolveCursorTransport } from "../src/managed-runtime";
import { classifyCursorError, isCursorManaged, lockCursorProvider, protectCursorConfig, CURSOR_MARKER, CURSOR_PROVIDER } from "../src/protocol";

/**
 * Adapter-seam tests for the CCR cursor plugin. The vendored engine has its
 * own ported suite (test/*.test.mjs); these pin the ADAPTER's own contracts —
 * the review lessons from the lost first implementation included:
 *   - activation/credential guards fail closed (missing, expired, disabled);
 *   - region refusals classify as their own code, never as auth failures;
 *   - an upstream 401 is auth-required, never a generic error or
 *     "login invalid";
 *   - inclusive prompt_tokens are NOT double-counted (the engine already
 *     rebuilds the inclusive prompt);
 *   - disconnect is fault-tolerant (double disconnect, disconnect during a
 *     pending login, corrupt credential file).
 */

// ---- fixtures -----------------------------------------------------------------

class FakeAuthError extends Error {
  status = 401;
  constructor(message: string) { super(message); }
}

/** The engine seams the adapter touches; everything else stays undefined. */
function fakeEngine(overrides: Partial<Record<string, any>> = {}) {
  const engine: any = {
    calls: { answer: 0, tokenOf: 0, usable: 0, browserSignIn: 0, cliSignIn: 0, keyToken: 0 },
    AuthError: FakeAuthError,
    CLI_MARK: "cursor-agent",
    API: "https://api2.cursor.sh",
    async tokenOf() { engine.calls.tokenOf++; return "tok"; },
    async usable() { engine.calls.usable++; return [{ id: "grok-4.7@256k", name: "Grok 4.7 @ 256k", context: 256000, run: "grok-4.7", title: "Grok 4.7" }]; },
    async answer() { engine.calls.answer++; return new Response("{}"); },
    async browserSignIn() { engine.calls.browserSignIn++; return { url: "", instructions: "", method: "auto", callback: async () => ({ type: "failed", error: "unused" }) }; },
    async cliSignIn() { engine.calls.cliSignIn++; return { url: "", instructions: "", method: "auto", callback: async () => ({ type: "failed", error: "unused" }) }; },
    async keyToken() { engine.calls.keyToken++; return "tok"; },
    async whoIs() { return { email: "", plan: "" }; },
    async planOf() { return ""; },
    async botUsage() { return []; },
    async usage() { return { windows: [] }; },
    async unary() { return {}; },
    resetCaches() {},
    ...overrides,
  };
  return engine;
}

function fakeHost(configDir: string, config: any = { providers: [] }) {
  return {
    configDir,
    readConfig: async () => JSON.parse(JSON.stringify(config)),
    readRawConfig: async () => JSON.parse(JSON.stringify(config)),
    writeConfig: async (next: any) => { Object.assign(config, next); },
    reloadRuntime: async () => {},
    getDirectDispatcher: () => ({ name: "agent" }),
  };
}

function serviceIn(engine = fakeEngine(), config: any = { providers: [] }) {
  const dir = mkdtempSync(join(tmpdir(), "ccr-cursor-adapter-"));
  const host = fakeHost(dir, config);
  const service = new CursorAuthService({ host, engine });
  return { dir, host, config, service, engine };
}

function writeCreds(dir: string, credential: CursorCredential, models: any[] = []) {
  writeFileSync(join(dir, "cursor-credentials.json"), JSON.stringify({ version: 1, credential, models }));
}

/** The real host invokes global fetch through config.dispatcher after its policy seams. */
function hostAttempt(runtime: any, config: any, requestBody: any = {}) {
  return async () => {
    await runtime.ensureUsable();
    await runtime.lockUpstream(config, {});
    const headers = await runtime.signRequest({ headers: { Authorization: `Bearer ${CURSOR_MARKER}` }, config, requestBody, provider: {} });
    return fetch(config.url, { method: "POST", body: JSON.stringify(requestBody), headers, signal: config.signal,
      dispatcher: config.dispatcher } as RequestInit);
  };
}

function deferred<T = any>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

const BROWSER_CREDS: CursorCredential = {
  type: "browser", access: "tok-browser", refresh: "none", expires: Date.now() + 30 * 24 * 3600 * 1000, accountId: "user@example.com",
};

afterEach(() => {
  vi.restoreAllMocks();
});

// ---- activation / credential guards fail closed ----------------------------------

describe("activation guard: missing/expired credentials fail closed", () => {
  it("a missing credential file parks dispatch and the engine is never touched", async () => {
    const { service, engine } = serviceIn();
    await expect(service.ensureUsable()).rejects.toMatchObject({ code: "cursor_not_connected" });
    await expect(service.dispatch({ model: "auto", messages: [] })).rejects.toMatchObject({ code: "cursor_not_connected" });
    expect(engine.calls.answer).toBe(0);
    expect(engine.calls.tokenOf).toBe(0);
  });

  it("an expired browser token fails closed with reauth-required — no refresh is pretended", async () => {
    const { service, engine } = serviceIn();
    writeCreds((service as any).options.host.configDir, {
      type: "browser", access: "tok-old", refresh: "none", expires: Date.now() - 1000,
    });
    await expect(service.ensureUsable()).rejects.toMatchObject({ code: "cursor_reauth_required" });
    expect(engine.calls.answer).toBe(0);
    const status = await service.getStatus();
    expect(status.expired).toBe(true);
    expect(status.status).toBe("connected"); // the account is kept; only re-login is required
  });

  it("a disabled managed entry survives the protector with its disabled flag intact", () => {
    const entry = lockCursorProvider({ name: CURSOR_PROVIDER, enabled: false });
    expect(entry.enabled).toBe(false);
    expect(entry.api_key).toBe(CURSOR_MARKER);
    const next: any = { providers: [entry] };
    protectCursorConfig(next, { providers: [] });
    expect(next.providers[0].enabled).toBe(false);
    expect(isCursorManaged(next.providers[0])).toBe(true);
  });
});

// ---- error taxonomy ---------------------------------------------------------------

describe("error taxonomy: region mapping and 401 narrowing", () => {
  const table: Array<[number, unknown, string, number]> = [
    // [httpStatus, body, expected code, expected httpStatus]
    [403, { error: { message: "Your team is only served in some regions and this request was turned away", type: "cursor_error", code: 403 } }, "cursor_region_restricted", 403],
    [200, { error: { message: "region not supported", type: "cursor_error", code: 403 } }, "cursor_region_restricted", 403],
    [200, { error: { code: 401, message: "Unauthorized" } }, "cursor_reauth_required", 401],
    [200, { error: { code: 429, message: "Error" } }, "cursor_rate_limited", 429],
    [502, { error: { code: 401, message: "Error" } }, "cursor_upstream_error", 502],
    [401, { error: { message: "Unauthorized", type: "cursor_error", code: 401 } }, "cursor_reauth_required", 401],
    [200, { error: { code: "unauthenticated", message: "Error" } }, "cursor_reauth_required", 401],
    [400, { error: { code: "failed_precondition", message: "Your free trial has expired" } }, "cursor_reauth_required", 401],
    [429, { error: { code: "resource_exhausted", message: "slow down" } }, "cursor_rate_limited", 429],
    [200, { error: { code: "unknown", message: "You've hit your usage limit" } }, "cursor_rate_limited", 429],
    [403, { error: { code: "permission_denied", message: "no" } }, "cursor_permission_denied", 403],
    [400, { error: { code: "invalid_argument", message: "prompt is too long" } }, "cursor_invalid_request", 400],
    [503, { error: { code: "unavailable", message: "busy" } }, "cursor_unavailable", 503],
    [502, { error: { code: "internal", message: "boom" } }, "cursor_upstream_error", 502],
  ];
  it.each(table)("maps HTTP %s → %s", (status, body, code, httpStatus) => {
    const info = classifyCursorError(status, body);
    expect(info.code).toBe(code);
    expect(info.httpStatus).toBe(httpStatus);
  });

  it("a region refusal is NEVER classified as an auth failure", () => {
    const info = classifyCursorError(403, { error: { message: "Cursor serves your team only in some regions" } });
    expect(info.code).not.toBe("cursor_reauth_required");
    expect(info.code).toBe("cursor_region_restricted");
  });

  it("an upstream 401 through the runtime classifies auth-required (not generic, not login-invalid)", async () => {
    const { service } = serviceIn(fakeEngine({
      async answer() {
        return new Response(JSON.stringify({ error: { message: "Unauthorized", type: "cursor_error", code: 401 } }),
          { status: 401, headers: { "content-type": "application/json" } });
      },
    }));
    writeCreds((service as any).options.host.configDir, BROWSER_CREDS);
    const runtime = createCursorManagedRuntime(service, (service as any).options.host);
    let thrown: any;
    const config = {};
    try { await runtime.dispatchRequest!({ attempt: hostAttempt(runtime, config), requestBody: { model: "auto", messages: [] }, config, provider: {} as any }); }
    catch (e) { thrown = e; }
    expect(thrown?.pluginClassified).toBe(true);
    expect(thrown?.code).toBe("cursor_reauth_required");
    expect(thrown?.statusCode).toBe(401);
    // The account is latched auth-required, still connected — never invalidated.
    const status = await service.getStatus();
    expect(status.expired).toBe(true);
    expect(status.lastError).toBe("cursor_reauth_required");
    expect(status.status).toBe("connected");
  });

  it("model sync against an upstream 401 reports reauth-required, not a credential-invalid verdict", async () => {
    const { service } = serviceIn(fakeEngine({
      async usable() { throw new FakeAuthError("Cursor's sign-in has run out"); },
    }));
    writeCreds((service as any).options.host.configDir, BROWSER_CREDS);
    await expect(service.syncModels()).rejects.toMatchObject({ code: "cursor_reauth_required" });
    const status = await service.getStatus();
    expect(status.expired).toBe(true);
    expect(status.status).toBe("connected");
  });
});

// ---- usage mapping ----------------------------------------------------------------

describe("usage mapping: inclusive prompt tokens are not double-counted", () => {
  const transformer = new CursorTransformer();
  it("prompt_tokens pass through identically; cache_write mirrors to cache_creation_input_tokens", async () => {
    // The engine's decode.finish already rebuilds the INCLUSIVE prompt
    // (net rest + cacheRead + cacheWrite). The adapter must not add again.
    const event = {
      id: "chatcmpl-x", object: "chat.completion", created: 1, model: "auto",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 100, completion_tokens: 7, total_tokens: 107,
        prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: 20 },
      },
    };
    const response = new Response(JSON.stringify(event), { headers: { "content-type": "application/json" } });
    const out = await transformer.transformResponseOut(response);
    const mapped = await out.json();
    expect(mapped.usage.prompt_tokens).toBe(100); // NOT 150
    expect(mapped.usage.prompt_tokens_details.cached_tokens).toBe(30);
    expect(mapped.usage.cache_creation_input_tokens).toBe(20);
    expect(mapped.choices[0].message.thinking).toBeUndefined();
  });

  it("a net-emitting regression is restored instead of letting the core subtract below rest", async () => {
    const event = {
      id: "chatcmpl-y", object: "chat.completion", created: 1, model: "auto",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 40, completion_tokens: 2, total_tokens: 42, prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: 20 } },
    };
    const out = await transformer.transformResponseOut(new Response(JSON.stringify(event), { headers: { "content-type": "application/json" } }));
    const mapped = await out.json();
    expect(mapped.usage.prompt_tokens).toBe(90); // inclusivity restored
    expect(mapped.usage.cache_creation_input_tokens).toBe(20);
  });

  it("streamed usage and deferred/marker counts pass through without re-adding cache tokens", async () => {
    const chunks = [
      'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"auto","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n',
      'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"auto","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n',
      'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"auto","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":200,"completion_tokens":5,"total_tokens":205,"prompt_tokens_details":{"cached_tokens":150,"cache_write_tokens":0},"magpie_deferred":{"prompt_tokens":10,"completion_tokens":3,"cached_tokens":4,"cache_write_tokens":1}}}\n\n',
      "data: [DONE]\n\n",
    ];
    const body = new ReadableStream<Uint8Array>({
      start(controller) { for (const c of chunks) controller.enqueue(new TextEncoder().encode(c)); controller.close(); },
    });
    const response = new Response(body, { headers: { "content-type": "text/event-stream" } });
    const out = await transformer.transformResponseOut(response);
    expect(out.headers.get("content-type")).toContain("text/event-stream");
    const text = await out.text();
    const usageChunk = JSON.parse(text.split("\n").filter(l => l.startsWith("data:") && !l.includes("[DONE]")).at(-1)!.slice(5));
    expect(usageChunk.usage.prompt_tokens).toBe(200); // identity — NOT 350
    expect(usageChunk.usage.cache_creation_input_tokens).toBe(0);
    expect(usageChunk.usage.magpie_deferred).toEqual({ prompt_tokens: 10, completion_tokens: 3, cached_tokens: 4, cache_write_tokens: 1 });
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("an error frame inside a 200 stream notes the service and fails the stream", async () => {
    const { service } = serviceIn();
    writeCreds((service as any).options.host.configDir, BROWSER_CREDS);
    const noted: any[] = [];
    const notedTransformer = new CursorTransformer(undefined, info => noted.push(info));
    const chunks = [
      'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"auto","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n',
      'data: {"error":{"message":"usage limit reached: You\'ve hit your usage limit","code":429}}\n\n',
    ];
    const body = new ReadableStream<Uint8Array>({
      start(controller) { for (const c of chunks) controller.enqueue(new TextEncoder().encode(c)); controller.close(); },
    });
    const response = new Response(body, { headers: { "content-type": "text/event-stream" } });
    // The transformer re-streams lazily: transformResponseOut resolves with a
    // wrapper and the classified failure surfaces when the body is consumed.
    const out = await notedTransformer.transformResponseOut(response);
    await expect(out.text()).rejects.toMatchObject({ code: "cursor_rate_limited" });
    expect(noted).toHaveLength(1);
    expect(noted[0].code).toBe("cursor_rate_limited");
    await service.noteUpstreamError(noted[0]);
    expect((service as any).coolingUntil).toBeGreaterThan(Date.now());
  });
});

// ---- dispatch plumbing --------------------------------------------------------------

describe("dispatch plumbing: abort propagation and dead-local lock", () => {
  it("lockUpstream pins the attempt URL to a dead local address — the marker never rides an ordinary attempt", async () => {
    const { service } = serviceIn();
    const runtime = createCursorManagedRuntime(service, (service as any).options.host);
    const config: any = {};
    await runtime.lockUpstream!(config, {} as any);
    expect(config.url).toBe("http://127.0.0.1:65534/ccr-managed-cursor");
    expect(typeof config.dispatcher.dispatch).toBe("function");
    expect(await runtime.signRequest!({ headers: {}, requestBody: {}, provider: {} as any })).toEqual({});
    expect(runtime.isManaged({ name: CURSOR_PROVIDER, api_key: CURSOR_MARKER })).toBe(true);
    expect(runtime.isManaged({ name: "other", api_key: "sk-real" })).toBe(false);
  });

  it("a client abort reaches the engine signal and surfaces as AbortError", async () => {
    let observed: AbortSignal | undefined;
    const { service } = serviceIn(fakeEngine({
      async answer(_auth: any, _chat: any, signal: AbortSignal) {
        observed = signal;
        await new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
          setTimeout(resolve, 1000);
        });
        return new Response("{}");
      },
    }));
    writeCreds((service as any).options.host.configDir, BROWSER_CREDS);
    const runtime = createCursorManagedRuntime(service, (service as any).options.host);
    const controller = new AbortController();
    const config = {};
    const pending = runtime.dispatchRequest!({
      attempt: hostAttempt(runtime, config), requestBody: { model: "auto", messages: [] }, config, provider: {} as any,
      req: { signal: controller.signal },
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(observed?.aborted).toBe(true);
  });

  it("transport resolution: a ProxyAgent dispatcher disables HTTP/2, a direct agent keeps it", () => {
    class ProxyAgent { name = "proxy"; }
    const proxied = resolveCursorTransport(fakeHost("/tmp/unused").getDirectDispatcher && ({ getSubscriptionDispatcher: () => new ProxyAgent(), getDirectDispatcher: () => ({}) } as any));
    expect(proxied.h2).toBe(false);
    expect(dispatcherIsProxy(new ProxyAgent())).toBe(true);
    expect(dispatcherIsProxy({ constructor: { name: "Agent" } })).toBe(false);
    const direct = resolveCursorTransport({ getSubscriptionDispatcher: () => ({ constructor: { name: "Agent" } }), getDirectDispatcher: () => ({}) } as any);
    expect(direct.h2).toBe(true);
  });
});

// ---- disconnect fault tolerance ------------------------------------------------------

describe("disconnect fault tolerance", () => {
  it("double disconnect is idempotent and removes config entry + file", async () => {
    const { service, dir, config } = serviceIn();
    writeCreds(dir, BROWSER_CREDS);
    // First connect the managed entry the way the service does.
    await (service as any).updateConfig({ version: 1, credential: BROWSER_CREDS, models: [] });
    expect(config.providers.some((p: any) => isCursorManaged(p))).toBe(true);
    await expect(service.disconnect()).resolves.toEqual({ success: true });
    await expect(service.disconnect()).resolves.toEqual({ success: true });
    expect(existsSync(join(dir, "cursor-credentials.json"))).toBe(false);
    expect(config.providers.some((p: any) => isCursorManaged(p))).toBe(false);
  });

  it("a corrupt credential file still tears the managed entry down", async () => {
    const { service, dir, config } = serviceIn();
    writeFileSync(join(dir, "cursor-credentials.json"), "{ this is not json");
    await (service as any).updateConfig({ version: 1, credential: BROWSER_CREDS, models: [] });
    await expect(service.disconnect()).resolves.toEqual({ success: true });
    expect(existsSync(join(dir, "cursor-credentials.json"))).toBe(false);
    expect(config.providers.some((p: any) => isCursorManaged(p))).toBe(false);
  });

  it("disconnect during a pending browser sign-in cancels it and the late outcome never persists", async () => {
    let releaseLogin: (result: any) => void = () => {};
    const pendingLogin = new Promise<any>(resolve => { releaseLogin = resolve; });
    let observedSignal: AbortSignal | undefined;
    const { service, dir, config } = serviceIn(fakeEngine({
      browserSignIn(signal?: AbortSignal) {
        observedSignal = signal;
        return { url: "https://cursor.com/loginDeepControl?challenge=x", instructions: "", method: "auto", callback: () => pendingLogin };
      },
    }));
    await service.startBrowserLogin();
    expect(service.loginState().state).toBe("pending");
    expect(observedSignal).toBeDefined();
    await service.disconnect();
    // disconnect() tears the whole login record down (not just the pending
    // poll), so the state reads idle afterwards; the cancellation itself is
    // proven by the aborted signal and the discarded late outcome below.
    expect(service.loginState().state).toBe("idle");
    expect(observedSignal?.aborted).toBe(true);
    // The browser finishes signing in AFTER the disconnect: the late success
    // must not resurrect the account (generation guard).
    releaseLogin({ type: "success", access: "tok-late", refresh: "none", expires: Date.now() + 60_000 });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(existsSync(join(dir, "cursor-credentials.json"))).toBe(false);
    expect(config.providers.some((p: any) => isCursorManaged(p))).toBe(false);
    expect(await service.getStatus()).toMatchObject({ status: "not_connected" });
  });

  it("cancelLogin on an idle login is a harmless no-op", () => {
    const { service } = serviceIn();
    expect(service.cancelLogin()).toEqual({ success: true });
    expect(service.loginState().state).toBe("idle");
  });
});

// ---- login flows ------------------------------------------------------------------

describe("login flows through the engine seams", () => {
  it("browser sign-in exposes the PKCE url and persists on success", async () => {
    const { service, dir, config } = serviceIn(fakeEngine({
      async browserSignIn() {
        await Promise.resolve();
        return {
          url: "https://cursor.com/loginDeepControl?challenge=abc", instructions: "", method: "auto",
          callback: async () => ({ type: "success", access: "tok-browser", refresh: "r1", expires: Date.now() + 60_000, accountId: "me@example.com", plan: "pro" }),
        };
      },
    }));
    const { url } = await service.startBrowserLogin();
    expect(url).toContain("loginDeepControl");
    expect(url).toContain("challenge=abc");
    // wait for the background job to finish persisting
    for (let i = 0; i < 50 && service.loginState().state === "pending"; i++) await new Promise(r => setTimeout(r, 10));
    expect(service.loginState().state).toBe("success");
    const saved = JSON.parse(readFileSync(join(dir, "cursor-credentials.json"), "utf8"));
    expect(saved.credential).toMatchObject({ type: "browser", access: "tok-browser", accountId: "me@example.com" });
    expect(config.providers.some((p: any) => isCursorManaged(p) && Array.isArray(p.models))).toBe(true);
    expect((config.providers.find((p: any) => isCursorManaged(p)).transformer.use)).toEqual(["cursor"]);
  });

  it("a second browser sign-in while one is pending is refused with login-busy", async () => {
    let release: (r: any) => void = () => {};
    const { service } = serviceIn(fakeEngine({
      browserSignIn() {
        return { url: "https://cursor.com/loginDeepControl", instructions: "", method: "auto", callback: () => new Promise(resolve => { release = resolve; }) };
      },
    }));
    await service.startBrowserLogin();
    await expect(service.startBrowserLogin()).rejects.toMatchObject({ code: "cursor_login_busy" });
    release({ type: "failed", error: "the sign-in timed out" });
  });

  it("CLI import stores the cursor-agent mark, never a fabricated token", async () => {
    const { service, dir } = serviceIn(fakeEngine({
      async cliSignIn() {
        await Promise.resolve();
        return { url: "", instructions: "", method: "auto", callback: async () => ({ type: "success", access: "", refresh: "cursor-agent", expires: 0, accountId: "cli@example.com" }) };
      },
    }));
    await expect(service.connectCli()).resolves.toEqual({ success: true });
    const saved = JSON.parse(readFileSync(join(dir, "cursor-credentials.json"), "utf8"));
    expect(saved.credential).toEqual({ type: "cli", accountId: "cli@example.com" });
  });

  it("a rejected API key reports login-failed without latching the account", async () => {
    const { service } = serviceIn(fakeEngine({
      async keyToken() { throw new FakeAuthError("Cursor didn't take this API key"); },
    }));
    await expect(service.connectApiKey("key-bad")).rejects.toMatchObject({ code: "cursor_login_failed" });
    const status = await service.getStatus();
    expect(status.status).toBe("not_connected");
    expect(status.expired).toBeUndefined();
  });

  it("usage reads are UNKNOWN-tolerant: a malformed quota body never becomes fake numbers", async () => {
    const { service } = serviceIn(fakeEngine({
      async usage() { return { error: "Service Unavailable", windows: [] }; },
    }));
    writeCreds((service as any).options.host.configDir, BROWSER_CREDS);
    const snapshot = await service.getUsage();
    expect(snapshot.known).toBe(false);
    expect(snapshot.windows).toEqual([]);
  });

  it("probeAccountState reports cooling with a parkedUntil and expiry without a network call", async () => {
    const { service, engine } = serviceIn();
    expect(await service.probeAccountState()).toMatchObject({ available: false, reason: "not_connected" });
    // A running service caches its load — the credential file only ever
    // changes through the service itself — so the "connected" checks run on
    // a fresh service that discovers the file written here.
    const { service: connected } = serviceIn(engine);
    writeCreds((connected as any).options.host.configDir, BROWSER_CREDS);
    expect(await connected.probeAccountState()).toMatchObject({ available: true });
    await connected.noteUpstreamError({ code: "cursor_rate_limited", cooldownMs: 60_000 });
    const verdict = await connected.probeAccountState();
    expect(verdict.available).toBe(false);
    expect(verdict.parkedUntil).toBeGreaterThan(Date.now());
    expect(engine.calls.tokenOf).toBe(0);
  });
});

// ---- review regressions -------------------------------------------------------------

describe("managed runtime host attempt bridge", () => {
  it("a rejecting host policy runs once and prevents any engine transaction", async () => {
    const { service, host, engine, dir } = serviceIn();
    writeCreds(dir, BROWSER_CREDS);
    const runtime = createCursorManagedRuntime(service, host);
    const failure = Object.assign(new Error("budget denied"), { code: "host_budget_denied", nonRetryable: true });
    const attempt = vi.fn(async () => { throw failure; });
    await expect(runtime.dispatchRequest!({ attempt, config: {}, provider: {} as any, requestBody: {} })).rejects.toBe(failure);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(engine.calls.answer).toBe(0);
  });

  it("a policy rejection after starting virtual fetch aborts that transaction", async () => {
    const began = deferred<AbortSignal>();
    const { service, host, dir } = serviceIn(fakeEngine({
      answer: async (_auth: any, _chat: any, signal: AbortSignal) => {
        began.resolve(signal);
        return new Response(new ReadableStream());
      },
    }));
    writeCreds(dir, BROWSER_CREDS);
    const runtime = createCursorManagedRuntime(service, host), config = {};
    const failure = new Error("host rejected execution");
    let response!: Response;
    await expect(runtime.dispatchRequest!({ config, provider: {} as any, requestBody: {}, attempt: async () => {
      response = await hostAttempt(runtime, config)();
      throw failure;
    } })).rejects.toBe(failure);
    expect((await began.promise).aborted).toBe(true);
    await response.body?.cancel().catch(() => {});
  });

  it("one host attempt wraps each dispatch and no marker/auth header reaches engine fetch", async () => {
    const bodies: any[] = [];
    const { service, host, dir } = serviceIn(fakeEngine({
      answer: async (_auth: any, body: any) => { bodies.push(body); return Response.json({ choices: [{ message: { content: "ok" } }] }); },
    }));
    writeCreds(dir, BROWSER_CREDS);
    const runtime = createCursorManagedRuntime(service, host);
    let hostAttempts = 0;
    for (const model of ["one", "two"]) {
      const config: any = {};
      const result = await runtime.dispatchRequest!({ config, provider: {} as any, requestBody: { model }, attempt: async () => {
        hostAttempts++;
        config.TIMEOUT = 200;
        return hostAttempt(runtime, config, { model })();
      } });
      expect(await result.json()).toHaveProperty("choices");
    }
    expect(hostAttempts).toBe(2);
    expect(bodies).toEqual([{ model: "one" }, { model: "two" }]);
    expect(JSON.stringify(bodies)).not.toContain(CURSOR_MARKER);
  });
});

describe("stream body owns the active request lifetime", () => {
  it.each(["client", "deadline", "disconnect", "cancel"])("%s after headers still aborts the engine", async cause => {
    const began = deferred<AbortSignal>();
    const cancelled = vi.fn();
    const { service, host, dir } = serviceIn(fakeEngine({ answer: async (_auth: any, _chat: any, signal: AbortSignal) => {
      began.resolve(signal);
      return new Response(new ReadableStream<Uint8Array>({
        start(ctl) { ctl.enqueue(new TextEncoder().encode("open")); }, cancel: cancelled,
      }));
    } }));
    writeCreds(dir, BROWSER_CREDS);
    const runtime = createCursorManagedRuntime(service, host);
    const client = new AbortController();
    const config: any = { ...(cause === "deadline" ? { TIMEOUT: 25 } : {}) };
    const response = await runtime.dispatchRequest!({ attempt: hostAttempt(runtime, config), config, requestBody: {}, provider: {} as any, req: { signal: client.signal } });
    const engineSignal = await began.promise;
    expect(engineSignal.aborted).toBe(false);
    if (cause === "cancel") await response.body!.cancel();
    else {
      const reader = response.body!.getReader();
      expect((await reader.read()).done).toBe(false);
      const pending = reader.read();
      const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
      if (cause === "client") client.abort();
      if (cause === "disconnect") await service.disconnect();
      await rejected;
    }
    expect(engineSignal.aborted).toBe(true);
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect((service as any).active.size).toBe(0);
  });

  it.each(["finish", "error"])("body %s releases the abort linkage and active tracking", async ending => {
    let body!: ReadableStreamDefaultController<Uint8Array>;
    let engineSignal!: AbortSignal;
    const { service, dir } = serviceIn(fakeEngine({ answer: async (_a: any, _b: any, signal: AbortSignal) => {
      engineSignal = signal;
      return new Response(new ReadableStream<Uint8Array>({ start(ctl) { body = ctl; } }));
    } }));
    writeCreds(dir, BROWSER_CREDS);
    const client = new AbortController();
    const response = await service.dispatch({}, client.signal);
    expect((service as any).active.size).toBe(1);
    const read = response.text();
    if (ending === "finish") { body.close(); expect(await read).toBe(""); }
    else { body.error(new Error("wire failed")); await expect(read).rejects.toThrow("wire failed"); }
    expect((service as any).active.size).toBe(0);
    client.abort();
    expect(engineSignal.aborted).toBe(ending === "error");
  });
});

describe("cancelled login cannot commit success", () => {
  it.each(["callback", "persist", "config"])("cancellation during %s rolls back file and config and keeps cancelled state", async phase => {
    const callback = deferred();
    const entered = deferred<void>(), release = deferred<void>();
    const { service, dir, config, host } = serviceIn(fakeEngine({ browserSignIn: () => ({
      url: "https://cursor.com/loginDeepControl", callback: () => callback.promise,
    }) }));
    if (phase === "persist") {
      const persist = (service as any).persist.bind(service);
      vi.spyOn(service as any, "persist").mockImplementation(async (next: any) => {
        await persist(next); entered.resolve(); await release.promise;
      });
    }
    if (phase === "config") {
      const write = host.writeConfig;
      vi.spyOn(host, "writeConfig").mockImplementation(async next => {
        await write(next);
        if (next.providers.some((p: any) => isCursorManaged(p))) { entered.resolve(); await release.promise; }
      });
    }
    await service.startBrowserLogin();
    const job = (service as any).login.job;
    if (phase === "callback") service.cancelLogin();
    callback.resolve({ type: "success", access: "late-secret", refresh: "none", expires: Date.now() + 60_000 });
    if (phase !== "callback") { await entered.promise; service.cancelLogin(); release.resolve(); }
    await job.catch(() => {});
    expect(await service.getStatus()).toMatchObject({ status: "not_connected", login: { state: "cancelled" } });
    expect(existsSync(join(dir, "cursor-credentials.json"))).toBe(false);
    expect(config.providers.some((p: any) => isCursorManaged(p))).toBe(false);
  });

  it("a late cancelled callback cannot replace a newer login", async () => {
    const old = deferred(), newer = deferred();
    const signin = vi.fn().mockReturnValueOnce({ url: "https://cursor.com/old", callback: () => old.promise })
      .mockReturnValueOnce({ url: "https://cursor.com/new", callback: () => newer.promise });
    const { service, dir } = serviceIn(fakeEngine({ browserSignIn: signin }));
    await service.startBrowserLogin();
    const oldJob = (service as any).login.job;
    service.cancelLogin();
    await service.startBrowserLogin();
    old.resolve({ type: "success", access: "old-secret", refresh: "none", expires: Date.now() + 60_000 });
    await oldJob;
    expect(service.loginState()).toMatchObject({ state: "pending", url: "https://cursor.com/new" });
    expect(existsSync(join(dir, "cursor-credentials.json"))).toBe(false);
    service.cancelLogin(); newer.resolve({ type: "failed", error: "cancelled" });
  });
});

describe("reasoning-only completion", () => {
  it("mapped thinking plus finish and DONE is visible and heals the stream", async () => {
    const heal = vi.fn();
    const transformer = new CursorTransformer(undefined, undefined, heal);
    const frames = [{ choices: [{ delta: { reasoning_content: "thinking only" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] }];
    const response = await transformer.transformResponseOut(new Response(frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream" },
    }));
    const result = await response.text();
    expect(result).toContain('"thinking":{"content":"thinking only"}');
    expect(result).toContain("[DONE]"); expect(heal).toHaveBeenCalledTimes(1);
  });
});

describe("liveness host deadline", () => {
  it.each(["token", "unary"])("a pending %s cannot report success past the deadline", async phase => {
    const blocked = deferred();
    const { service, host, dir } = serviceIn(fakeEngine({
      ...(phase === "token" ? { tokenOf: () => blocked.promise } : { unary: () => blocked.promise }),
    }));
    writeCreds(dir, BROWSER_CREDS);
    const runtime = createCursorManagedRuntime(service, host);
    await expect(runtime.probeLiveness!({ config: { TIMEOUT: 10 } } as any)).rejects.toMatchObject({ name: "AbortError" });
    blocked.resolve({});
  });

  it.each(["token", "unary"])("the supplied signal reaches the real %s transport through engine injection", async phase => {
    const client = new AbortController();
    const started = deferred<AbortSignal>();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const signal = init!.signal!;
      started.resolve(signal);
      return new Promise<Response>((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
    });
    configureCursorEngine(resolveCursorTransport(fakeHost("/tmp/unused")));
    const { service, host, dir } = serviceIn(fakeEngine({
      tokenOf: phase === "token" ? () => _internal.keyToken(`probe-${Date.now()}`) : async () => "tok",
      unary: _internal.unary,
    }));
    writeCreds(dir, BROWSER_CREDS);
    const runtime = createCursorManagedRuntime(service, host);
    try {
      const pending = runtime.probeLiveness!({ config: { TIMEOUT: 1000, signal: client.signal } } as any);
      const assertion = expect(pending).rejects.toMatchObject({ name: "AbortError" });
      const upstreamSignal = await started.promise;
      client.abort(); await assertion;
      expect(upstreamSignal.aborted).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally { configureCursorEngine({ fetch: null as any }); }
  });
});

describe("admin confidentiality", () => {
  it.each(["cursor_login_failed", "cursor_reauth_required", "cursor_credential_invalid", "cursor_persist_failed", "upstream-secret-code"])("%s never reflects arbitrary detail", async code => {
    const routes: any[] = [];
    registerCursorAdminRoutes({ server: { address: () => ({ port: 3456 }) }, route: (r: any) => routes.push(r) } as any, {
      connectApiKey: async () => { throw Object.assign(new Error("Bearer secret-token"), { code, statusCode: 422, detail: "Authorization: Bearer secret-token" }); },
    } as any);
    const route = routes.find(r => r.url.endsWith("/connect"));
    const response = await route.handler({ body: { apiKey: "secret-token" }, raw: { socket: { remoteAddress: "127.0.0.1" } }, headers: { host: "localhost:3456" } }, { status: vi.fn() });
    expect(response).toEqual({ success: false, error: code === "upstream-secret-code" ? "cursor_request_failed" : code });
    expect(JSON.stringify(response)).not.toContain("secret-token");
  });

  it("browser callback errors become safe codes on both status and login state", async () => {
    const { service } = serviceIn(fakeEngine({ browserSignIn: () => ({ url: "https://cursor.com/login", callback: async () => ({ type: "failed", error: "Authorization: Bearer secret-token" }) }) }));
    await service.startBrowserLogin(); await (service as any).login.job; await Promise.resolve();
    expect(service.loginState()).toEqual({ state: "failed", error: "cursor_login_failed" });
    expect(JSON.stringify(await service.getStatus())).not.toContain("secret-token");
  });
});

describe("virtual dispatcher backpressure", () => {
  const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
  // Reproduces reviewer probe /tmp/cursor-review2-bridge.ts for both undici
  // handler generations: pause requested at the HEADER stage must stop the
  // bridge from reading or delivering ANY body data until resume; abort while
  // paused must still cancel the engine body exactly once and error once.
  const check = async (modern: boolean, atHeaders: boolean) => {
    const observed = { reads: 0, data: 0, cancels: 0, errors: 0 };
    const service: any = { dispatch: async () => new Response(new ReadableStream<Uint8Array>({
      pull(ctl) { observed.reads++; ctl.enqueue(new Uint8Array([1])); },
      cancel() { observed.cancels++; },
    }, { highWaterMark: 0 })) };
    const runtime = createCursorManagedRuntime(service, fakeHost("/tmp/unused") as any);
    const config: any = {};
    let control: any, resumeFn: (() => void) | undefined;
    await runtime.dispatchRequest!({
      config, requestBody: {}, provider: {} as any,
      attempt: async () => {
        const handler = modern ? {
          onRequestStart(c: any) { control = c; },
          onResponseStart(c: any) { if (atHeaders) c.pause(); },
          onResponseData() { observed.data++; control.pause(); },
          onResponseEnd() {},
          onResponseError() { observed.errors++; },
        } : {
          onConnect(abort: any) { control = { abort }; },
          onHeaders(_s: any, _h: any, resume: () => void) { resumeFn = resume; return !atHeaders; },
          onData() { observed.data++; return false; },
          onComplete() {},
          onError() { observed.errors++; },
        };
        config.dispatcher.dispatch({}, handler);
        await tick();
        if (atHeaders) {
          // Paused at headers: zero upstream reads and zero delivered data.
          expect(observed.reads).toBe(0);
          expect(observed.data).toBe(0);
        } else {
          // Data-stage pause: exactly one chunk was read/delivered before it.
          expect(observed.data).toBe(1);
        }
        expect(observed.errors).toBe(0);
        (modern ? control.resume : resumeFn!)(); // unblock the first body chunk
        await tick();
        expect(observed.data).toBeGreaterThan(0);
        return new Response(null);
      },
    });
    // Drain a few more chunks: every resume must deliver one more chunk
    // (the handler pauses after each onData/onResponseData).
    for (let i = 0; i < 3; i++) { (modern ? control.resume : resumeFn!)(); await tick(); }
    expect(observed.reads).toBeGreaterThan(1);
    control.abort(new DOMException("aborted", "AbortError"));
    await tick();
    expect(observed.cancels).toBe(1);
    expect(observed.errors).toBe(1);
  };

  it.each([["legacy", false], ["modern", false], ["legacy", true], ["modern", true]])("%s handler honors %s pause then drains and aborts cleanly", async (style, atHeaders) => {
    await check(style === "modern", atHeaders);
  });

  it("abort while header-paused cancels the engine before any read (both styles)", async () => {
    for (const modern of [false, true]) {
      const observed = { reads: 0, cancels: 0, errors: 0 };
      const service: any = { dispatch: async () => new Response(new ReadableStream<Uint8Array>({
        pull(ctl) { observed.reads++; ctl.enqueue(new Uint8Array([1])); },
        cancel() { observed.cancels++; },
      }, { highWaterMark: 0 })) };
      const runtime = createCursorManagedRuntime(service, fakeHost("/tmp/unused") as any);
      const config: any = {};
      let control: any;
      await runtime.dispatchRequest!({
        config, requestBody: {}, provider: {} as any,
        attempt: async () => {
          const handler = modern ? {
            onRequestStart(c: any) { control = c; },
            onResponseStart(c: any) { c.pause(); },
            onResponseData() {}, onResponseEnd() {}, onResponseError() { observed.errors++; },
          } : {
            onConnect(abort: any) { control = { abort }; },
            onHeaders() { return false; },
            onData() {}, onComplete() {}, onError() { observed.errors++; },
          };
          config.dispatcher.dispatch({}, handler);
          await tick();
          expect(observed.reads).toBe(0);
          control.abort(new DOMException("aborted", "AbortError"));
          await tick();
          expect(observed.cancels).toBe(1);
          expect(observed.errors).toBe(1);
          return new Response(null);
        },
      });
    }
  });
});

// ---- card mount smoke ---------------------------------------------------------------

class El {
  tag: string; children: El[] = []; textContent = ""; className = ""; type = "";
  attrs: Record<string, string> = {}; value = ""; disabled = false; href = "";
  onclick?: () => void; oninput?: () => void; onkeydown?: (e: any) => void;
  constructor(tag: string) { this.tag = tag; }
  append(...nodes: El[]) { this.children.push(...nodes); }
  appendChild(child: El): El { this.children.push(child); return child; }
  prepend(child: El): El { this.children.unshift(child); return child; }
  replaceChildren(...nodes: El[]) { this.children = [...nodes]; }
  remove() {}
  setAttribute(key: string, value: string) { this.attrs[key] = value; }
  getAttribute(key: string) { return this.attrs[key] ?? null; }
  addEventListener() {}
  removeEventListener() {}
  focus() {}
  scrollIntoView() {}
}

(globalThis as any).document = { createElement: (tag: string) => new El(tag), createElementNS: () => new El("svg") as any };

const walk = (node: El, visit: (el: El) => void): void => { visit(node); for (const child of node.children) walk(child, visit); };
const all = (root: El, predicate: (el: El) => boolean): El[] => {
  const out: El[] = []; walk(root, el => { if (predicate(el)) out.push(el); }); return out;
};
const text = (root: El): string => { let out = ""; walk(root, el => { out += el.textContent + " "; }); return out; };
const buttonNamed = (root: El, label: string): El | undefined =>
  all(root, el => el.tag === "button" && el.textContent === label)[0];
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe("card mount smoke", () => {
  it("renders the three sign-in affordances when not connected and never logs the key", async () => {
    const { mount, unmount } = await import("../src/card-entry");
    const calls: Array<{ path: string; body?: any }> = [];
    let status: any = { status: "not_connected", login: { state: "idle" } };
    const el: any = new El("div");
    mount(el, {
      callApi: async (path: string, init?: any) => {
        calls.push({ path, body: init?.body ? JSON.parse(init.body) : undefined });
        if (path === "/cursor/status") return status;
        if (path === "/cursor/login/browser") { status = { status: "not_connected", login: { state: "pending", url: "https://cursor.com/loginDeepControl?challenge=z" } }; return { url: status.login.url }; }
        if (path === "/cursor/login/state") return status.login;
        return { success: true };
      },
      locale: "en", locales: {}, plugin: { name: "cursor", version: "0.1.0" }, disabled: false,
      acquireManagement: () => () => {},
      onBusy: () => {},
    });
    await flush();
    expect(buttonNamed(el, "Sign in with browser")).toBeDefined();
    expect(buttonNamed(el, "Import cursor-agent sign-in")).toBeDefined();
    expect(all(el, n => n.tag === "input" && n.type === "password").length).toBe(1);
    // Start the browser sign-in: pending state shows the URL and a Cancel button.
    buttonNamed(el, "Sign in with browser")!.onclick!();
    await flush(); await flush();
    expect(calls.some(c => c.path === "/cursor/login/browser")).toBe(true);
    expect(text(el)).toContain("https://cursor.com/loginDeepControl?challenge=z");
    expect(buttonNamed(el, "Cancel sign-in")).toBeDefined();
    unmount(el);
  });

  it("renders connected management: sync/usage/disconnect and an unknown quota line", async () => {
    const { mount, unmount } = await import("../src/card-entry");
    let status: any = {
      status: "connected", account: "u***@example.com", plan: "pro",
      models: [{ id: "grok-4.7@256k", name: "Grok 4.7 @ 256k", context: 256000 }], login: { state: "idle" },
    };
    const el: any = new El("div");
    mount(el, {
      callApi: async (path: string) => {
        if (path === "/cursor/status") return status;
        if (path === "/cursor/usage") return { known: false, stale: false, windows: [] };
        if (path === "/cursor/disconnect") { status = { status: "not_connected", login: { state: "idle" } }; return { success: true }; }
        return { success: true };
      },
      locale: "en", locales: {}, plugin: { name: "cursor", version: "0.1.0" }, disabled: false,
      acquireManagement: () => () => {},
      onBusy: () => {},
    });
    await flush();
    expect(text(el)).toContain("u***@example.com");
    expect(text(el)).toContain("grok-4.7@256k");
    expect(text(el)).toContain("Quota unknown");
    expect(buttonNamed(el, "Disconnect")).toBeDefined();
    buttonNamed(el, "Disconnect")!.onclick!();
    await flush(); await flush();
    expect(buttonNamed(el, "Sign in with browser")).toBeDefined();
    unmount(el);
  });
});
