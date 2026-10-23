/**
 * Codex managed runtime — fixed origin, header hygiene, final-body session
 * headers, 401-once refresh wiring, cooling before network, error taxonomy
 * (docs/design/provider-plugins.md §5.2; contract "Data contract").
 *
 * No network: the service is a structural stub and `host.getDirectDispatcher`
 * returns a sentinel object compared by identity.
 */
import { describe, expect, it } from "vitest";
import {
  CODEX_STRIPPED_HEADERS,
  codexAccountHeaders,
  createCodexManagedRuntime,
} from "../src/managed-runtime";
import {
  CODEX_CLIENT_VERSION,
  CODEX_MARKER_API_KEY,
  CODEX_ORIGINATOR,
  CODEX_PROVIDER_NAME,
  CODEX_UPSTREAM_URL,
  classifyCodexError,
  codexError,
  isCodexRuntime,
} from "../src/protocol";
import type { CodexServiceLike } from "../src/protocol";

const DISPATCHER = { kind: "direct-dispatcher" };

function stubService(over: Partial<CodexServiceLike> = {}) {
  const notes: any[] = [];
  const service: CodexServiceLike & { notes: any[] } = {
    notes,
    getAccessToken: async () => "live-access-token",
    getAccountId: async () => "acct-123",
    forceTokenRefresh: async () => {},
    isAccountCooling: async () => false,
    getModelInstructions: () => undefined,
    noteRateLimits: async () => {},
    getRateLimits: async () => null,
    noteUpstreamError: async (info) => { notes.push(info); },
    ...over,
  };
  return service;
}

const build = (service: CodexServiceLike, log?: any) =>
  createCodexManagedRuntime({ service, host: { getDirectDispatcher: () => DISPATCHER }, log });

describe("createCodexManagedRuntime — identity", () => {
  it("registers under the fixed runtime name 'codex'", () => {
    expect(build(stubService()).name).toBe("codex");
  });

  it("isManaged claims only its own provider shapes", () => {
    const rt = build(stubService());
    expect(rt.isManaged({ name: CODEX_PROVIDER_NAME, apiKey: CODEX_MARKER_API_KEY } as any)).toBe(true);
    // Name+chain alone must NOT match (could be a user config); A's predicate
    // additionally requires the fixed Codex origin or the managed marker.
    expect(rt.isManaged({ name: CODEX_PROVIDER_NAME, transformer: { use: [{ name: "codex" }] } } as any)).toBe(false);
    expect(rt.isManaged({ name: CODEX_PROVIDER_NAME, api_base_url: "https://chatgpt.com/backend-api/codex", transformer: { use: [{ name: "codex" }] } } as any)).toBe(true);
    expect(rt.isManaged({ name: "openai", apiKey: "sk-real" } as any)).toBe(false);
    expect(rt.isManaged({ apiKey: "ccr-managed-gemini-oauth" } as any)).toBe(false);
  });

  it("requires a service", () => {
    expect(() => createCodexManagedRuntime({ service: undefined as any, host: { getDirectDispatcher: () => undefined } })).toThrow();
  });
});

describe("createCodexManagedRuntime — lockUpstream", () => {
  it("pins the fixed Codex origin, refuses redirects and uses the direct dispatcher", async () => {
    const rt = build(stubService());
    const config: any = { url: "https://evil.example.com/v1/responses", redirect: "follow" };
    await rt.lockUpstream!(config, {} as any);
    expect(config.url).toBe(CODEX_UPSTREAM_URL);
    expect(config.url.startsWith("https://")).toBe(true);
    expect(config.redirect).toBe("error");
    expect(config.dispatcher).toBe(DISPATCHER);
  });

  it("a config-supplied base_url can never win", async () => {
    const rt = build(stubService());
    const config: any = { baseUrl: "http://127.0.0.1:8080" };
    await rt.lockUpstream!(config, {} as any);
    expect(config.url).toBe(CODEX_UPSTREAM_URL);
  });
});

describe("createCodexManagedRuntime — signRequest header hygiene", () => {
  it("strips every auth/host/session variant and injects the account headers", async () => {
    const rt = build(stubService());
    const headers: Record<string, string> = {};
    for (const name of ["Authorization", "x-api-key", "API-KEY", "Proxy-Authorization", "Host", "Cookie",
      "session_id", "conversation_id", "session-id", "thread-id", "conversation-id"]) {
      headers[name] = `spoofed-${name}`;
    }
    headers["x-custom"] = "kept";
    const next = await rt.signRequest!({ headers, requestBody: {}, provider: {} as any });
    const keys = Object.keys(next).map((k) => k.toLowerCase());
    // Every spoofed identity variant is gone...
    for (const name of ["x-api-key", "api-key", "proxy-authorization", "host", "cookie",
      "session_id", "conversation_id", "session-id", "thread-id", "conversation-id"]) {
      expect(keys).not.toContain(name);
    }
    // ...and the only Authorization is the re-injected live token, never a spoof.
    expect(keys.filter((k) => k === "authorization")).toHaveLength(1);
    expect(next.Authorization).toBe("Bearer live-access-token");
    expect(next["x-custom"]).toBe("kept");
    expect(next.Authorization).toBe("Bearer live-access-token");
    expect(next["chatgpt-account-id"]).toBe("acct-123");
    expect(next["OpenAI-Beta"]).toBe("responses=experimental");
    expect(next.originator).toBe(CODEX_ORIGINATOR);
    expect(next.version).toBe(CODEX_CLIENT_VERSION);
    expect(next["User-Agent"]).toContain(`${CODEX_ORIGINATOR}/${CODEX_CLIENT_VERSION}`);
    expect(next.Accept).toBe("text/event-stream");
  });

  it("never lets a differently-cased duplicate of an injected identity header join its value upstream", async () => {
    const rt = build(stubService());
    // A spoof under another case must not survive as a second object key:
    // Headers/map consumers join duplicate names into "spoof, real".
    const next = await rt.signRequest!({
      headers: { "ChatGPT-Account-ID": "spoof", ORIGINATOR: "spoof", "VERSION": "0.0.0", accept: "text/plain" },
      requestBody: {}, provider: {} as any,
    });
    const lowerKeys = Object.keys(next).map((k) => k.toLowerCase());
    expect(lowerKeys.filter((k) => k === "chatgpt-account-id")).toEqual(["chatgpt-account-id"]);
    expect(next["chatgpt-account-id"]).toBe("acct-123");
    expect(lowerKeys.filter((k) => k === "originator")).toHaveLength(1);
    expect(next.originator).toBe(CODEX_ORIGINATOR);
    expect(lowerKeys.filter((k) => k === "version")).toHaveLength(1);
    expect(next.version).toBe(CODEX_CLIENT_VERSION);
    expect(lowerKeys.filter((k) => k === "accept")).toHaveLength(1);
    expect(next.Accept).toBe("text/event-stream");
    expect(JSON.stringify(next)).not.toContain("spoof");
  });

  it("drops a client chatgpt-account-id even when no account id is (re)injected this call", async () => {
    // getAccountId absent/throwing means the header is not injected; it must
    // still be stripped, never forwarded verbatim (defense-in-depth).
    for (const over of [
      { getAccountId: async () => undefined as any },
      { getAccountId: (() => { throw new Error("account read failed"); }) as any },
    ]) {
      const rt = build(stubService(over));
      const next = await rt.signRequest!({
        headers: { "ChatGPT-Account-ID": "SPOOF-ACCT" },
        requestBody: {}, provider: {} as any,
      });
      expect(JSON.stringify(next)).not.toContain("SPOOF-ACCT");
      expect(Object.keys(next).map((k) => k.toLowerCase())).not.toContain("chatgpt-account-id");
    }
  });

  it("never forwards the marker api_key", async () => {
    const rt = build(stubService());
    const next = await rt.signRequest!({ headers: { Authorization: `Bearer ${CODEX_MARKER_API_KEY}` }, requestBody: {}, provider: {} as any });
    expect(next.Authorization).toBe("Bearer live-access-token");
    expect(JSON.stringify(next)).not.toContain(CODEX_MARKER_API_KEY);
  });

  it("derives session-id/thread-id from the FINAL body's prompt_cache_key", async () => {
    const rt = build(stubService());
    const next = await rt.signRequest!({ headers: {}, requestBody: { prompt_cache_key: "cache-key-7" }, provider: {} as any });
    expect(next["session-id"]).toBe("cache-key-7");
    expect(next["thread-id"]).toBe("cache-key-7");
  });

  it("sets no session headers when the body has no prompt_cache_key", async () => {
    const rt = build(stubService());
    const next = await rt.signRequest!({ headers: {}, requestBody: {}, provider: {} as any });
    expect(next).not.toHaveProperty("session-id");
    expect(next).not.toHaveProperty("thread-id");
  });

  it("tolerates an unavailable account id", async () => {
    const rt = build(stubService({ getAccountId: async () => { throw new Error("no account"); } }));
    const next = await rt.signRequest!({ headers: {}, requestBody: {}, provider: {} as any });
    expect(next).not.toHaveProperty("chatgpt-account-id");
    expect(next.Authorization).toBe("Bearer live-access-token");
  });

  it("codexAccountHeaders builds the same shape standalone", () => {
    const h = codexAccountHeaders({ accessToken: "t", accountId: "a", requestBody: { prompt_cache_key: "k" }, version: "1.2.3" });
    expect(h).toMatchObject({ Authorization: "Bearer t", "chatgpt-account-id": "a", version: "1.2.3", "session-id": "k" });
    expect(h["User-Agent"]).toContain("1.2.3");
  });
});

describe("createCodexManagedRuntime — cooling breaker before network", () => {
  it("refuses a cooling account from ensureUsable", async () => {
    const rt = build(stubService({ isAccountCooling: async () => true }));
    await expect(rt.ensureUsable!()).rejects.toMatchObject({ code: "codex_account_cooling", statusCode: 429 });
  });

  it("passes a healthy account", async () => {
    await expect(build(stubService()).ensureUsable!()).resolves.toBeUndefined();
  });
});

describe("createCodexManagedRuntime — error classification", () => {
  it("leaves send-level failures (status 0) unclassified", () => {
    expect(build(stubService()).classifyError!(0, undefined, "")).toBeNull();
  });

  it("classifies usage_limit_reached from the body even on a 5xx", () => {
    const info = build(stubService()).classifyError!(500, JSON.stringify({ error: { type: "usage_limit_reached", resets_at: Math.floor(Date.now() / 1000) + 600 } }), "");
    expect(info).toMatchObject({ code: "codex_usage_limit", httpStatus: 429 });
    expect(info!.retryable).not.toBe(true);
    expect(info!.cooldownMs).toBeGreaterThan(0);
  });

  it("classifies 401 as reauth (not retryable) and 5xx as transient (retryable)", () => {
    const rt = build(stubService());
    expect(rt.classifyError!(401, { error: {} }, "")).toMatchObject({ code: "codex_reauth_required", retryable: false });
    expect(rt.classifyError!(503, "bad gateway", "")).toMatchObject({ code: "codex_overloaded", retryable: true });
  });

  it("classifies a 429 without the quota shape as a retryable rate limit", () => {
    expect(build(stubService()).classifyError!(429, { error: { message: "slow down" } }, "")).toMatchObject({
      code: "codex_rate_limited", httpStatus: 429, retryable: true,
    });
  });
});

describe("createCodexManagedRuntime — noteUpstreamError and authRefresh", () => {
  it("forwards a classification to the service and never throws into the response path", async () => {
    const service = stubService({ noteUpstreamError: (() => { throw new Error("store down"); }) as any });
    const warn = (msg: string) => { warnings.push(msg); };
    const warnings: string[] = [];
    const rt = build(service, { info() {}, warn, error() {} });
    await expect(rt.noteUpstreamError!({ code: "usage_limit_reached", message: "m", httpStatus: 429, cooldownMs: 1000 })).resolves.toBeUndefined();
    expect(warnings.some((w) => w.includes("usage_limit_reached"))).toBe(true);
  });

  it("delegates the 401-once refresh to the service", async () => {
    let refreshed = 0;
    const rt = build(stubService({ forceTokenRefresh: async () => { refreshed++; } }));
    await rt.authRefresh!.forceRefresh();
    expect(refreshed).toBe(1);
  });

  it("suppresses debug logs for the managed provider", () => {
    expect(build(stubService()).suppressDebugLog).toBe(true);
  });
});

describe("protocol shims (temporary bridge; reconciled by integration)", () => {
  it("codexError carries code/statusCode and nonRetryable semantics", () => {
    const e = codexError({ code: "codex_account_cooling", message: "m", httpStatus: 429, retryable: false });
    expect(e).toMatchObject({ code: "codex_account_cooling", statusCode: 429, nonRetryable: true, codex: true });
  });

  it("classifyCodexError prefers the quota shape over the status code", () => {
    expect(classifyCodexError(429, { error: { type: "usage_limit_reached", resets_in_seconds: 60 } })).toMatchObject({
      code: "codex_usage_limit", cooldownMs: 60000,
    });
  });

  it("isCodexRuntime never claims a generic provider named 'codex'", () => {
    expect(isCodexRuntime({ name: "codex", apiKey: "sk-user-key" })).toBe(false);
  });
});
