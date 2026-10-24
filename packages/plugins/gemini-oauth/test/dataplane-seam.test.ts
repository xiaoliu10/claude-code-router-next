/**
 * Gemini OAuth data-plane seam — behavior equivalence for the plugin runtime
 * path (docs/design/provider-plugins.md §2.2 ManagedRuntime).
 *
 * MOVED + ADAPTED from the former core test `gemini-oauth-admin-routes.test.ts`
 * ("Gemini OAuth routes.ts upstream seam" describe): the provider is now
 * dispatched through the plugin seam (ensureUsable/lockUpstream/signRequest/
 * classifyError/authRefresh), activated here through the core's REAL plugin
 * context/registry against a real core Server. Google is always mocked.
 *
 * Equivalence contract pinned here:
 *  - fixed data-plane origin + redirect:error + direct dispatcher
 *  - marker api_key / client credentials stripped on EVERY attempt
 *  - 401 → one forced refresh → exactly one re-dispatch; second 401 terminal
 *  - fake-429 identity block vs real quota classification (systemText only)
 *  - 403 VALIDATION_REQUIRED safe-link preservation
 *  - persisted cooldown short-circuits before any fetch
 *  - hidden HTTP-200 JSON errors classified through the plugin seam
 *  - zero token leakage in any response body
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Server from "../../../core/src/server";
import * as configModule from "../../../core/src/ccr/config";
import * as activeProbe from "../../../core/src/services/active-probe";
import { getDirectDispatcher } from "../../../core/src/services/proxy";
import { getHealthStore } from "../../../core/src/services/provider-health";
import { reloadProviderRuntime } from "../../../core/src/provider-plugins/host";
import { clearPluginRegistry } from "../../../core/src/provider-plugins/registry";
import { manifest, activate } from "../src/plugin";
import { GeminiOauthCredentialStore, type GeminiOauthAuthService } from "../src/auth-service";
import { getGeminiOauthAuthService } from "../src/protocol";
import { GeminiOauthTransformer } from "../src/transformer";
import {
  GEMINI_OAUTH_API_KEY, GEMINI_OAUTH_DATA_PLANE, GEMINI_OAUTH_SSE_PATH,
  clearGeminiOauthTokenCaches, lockGeminiOauthProvider,
} from "../src/protocol";

const ACCESS = "ya29.fixture-route-access-token";
const REFRESH = "1//0fixture-route-refresh-token-abcdefghijklmnop";
const CLIENT_AUTH = "Bearer untrusted-client-token";
const CLIENT_KEY = "untrusted-client-api-key";
const MARKER = "x-anthropic-billing-header: fixture";
const cleanups: Array<() => Promise<void>> = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const sse = (body: unknown) => new Response(`data: ${JSON.stringify(body)}\n\n`, { headers: { "content-type": "text/event-stream" } });
const healthy = () => sse({ response: {
  candidates: [{ content: { role: "model", parts: [{ text: "healthy" }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 },
} });
const provider = (models = ["gemini-3-flash"]) => lockGeminiOauthProvider({ name: "gemini-oauth", models });
const ordinary = { name: "ordinary", api_base_url: "https://ordinary.invalid/v1/chat/completions", api_key: "ordinary-key", models: ["m"] };
const credential = () => ({ version: 2 as const, kind: "antigravity" as const, account: {
  email: "fixture@example.invalid", refreshToken: REFRESH, projectId: "project-fixture", tier: "paid-tier",
  importedAt: "2026-01-01T00:00:00.000Z", lastError: null, cooldownUntil: null,
} });
const noopLog = { info: () => {}, warn: () => {}, error: () => {} };

beforeEach(() => {
  vi.stubEnv("GEMINI_OAUTH_CLIENT_ID", "dummy-client-id"); vi.stubEnv("GEMINI_OAUTH_CLIENT_SECRET", "dummy-client-secret");
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network disabled in test"); }));
  clearGeminiOauthTokenCaches();
  clearPluginRegistry();
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  activeProbe.resetActiveProbeService();
  clearPluginRegistry();
  clearGeminiOauthTokenCaches();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
});

async function build(config: any = { Providers: [provider(), ordinary], Router: {} }) {
  const dir = mkdtempSync(join(tmpdir(), "gemini-plugin-seam-"));
  const store = new GeminiOauthCredentialStore(join(dir, "gemini-oauth-credentials.json"));
  const live = { current: structuredClone(config) };
  vi.spyOn(configModule, "readConfigFileRaw").mockImplementation(async () => structuredClone(live.current));
  vi.spyOn(configModule, "readConfigFile").mockImplementation(async () => structuredClone(live.current));
  vi.spyOn(configModule, "writeConfigFile").mockImplementation(async (next: any) => { live.current = structuredClone(next); });
  vi.spyOn(configModule, "backupConfigFile").mockResolvedValue(null);
  // Runtime reload may restart probing: no background network is allowed.
  vi.spyOn(activeProbe, "startActiveProbe").mockReturnValue({ stop: vi.fn() } as any);

  const server = new Server({ logger: false, useJsonFile: false, initialConfig: {
    providers: config.Providers, Router: config.Router, HOST: "127.0.0.1", PORT: 0, ACTIVE_PROBE_ENABLED: false,
    enableFallback: false,
  } });
  cleanups.push(async () => { await server.app.close(); rmSync(dir, { recursive: true, force: true }); });
  await server.ready();

  // Activate the plugin through the core's REAL plugin context (the loader
  // uses exactly this context shape; bundle loading itself is covered by the
  // core-side gemini-oauth-plugin suite). The plugin then owns the managed
  // runtime, the transformer and the service.
  const tx = server.pluginRegistry.beginActivation(manifest, noopLog, {
    configDir: dir,
    readConfig: () => configModule.readConfigFile(),
    readRawConfig: () => configModule.readConfigFileRaw(),
    writeConfig: (next: any) => configModule.writeConfigFile(next),
    reloadRuntime: async (cfg?: any) => reloadProviderRuntime(server, cfg ?? (await configModule.readConfigFile()), noopLog),
    getDirectDispatcher,
  });
  const ctx = tx.context;
  await activate(ctx);
  await tx.commit(undefined, server.app);
  // Re-resolve provider transformer instances after plugin registration.
  await ctx.host.reloadRuntime(config);

  await server.registerNamespace("/"); await server.app.ready();
  const OwnedTransformer = server.transformerService.getTransformer("gemini-oauth") as any;
  const service = new OwnedTransformer().resolveAuthService() as GeminiOauthAuthService;
  const noTokens = (body: string) => { expect(body).not.toContain(ACCESS); expect(body).not.toContain(REFRESH); };
  const send = async (messages: any[] = [{ role: "user", content: "hello" }], extra: any = {}) => {
    const response = await server.app.inject({ method: "POST", url: "/v1/chat/completions", payload: {
      model: "gemini-oauth,gemini-3-flash", stream: false, messages, ...extra.payload,
    }, ...extra, });
    noTokens(response.body); return response;
  };
  return { server, store, service, send, noTokens, config: () => live.current };
}

function stubDataService(h: Awaited<ReturnType<typeof build>>) {
  const token = vi.spyOn(h.service, "getAccessToken").mockResolvedValue(ACCESS);
  vi.spyOn(h.service, "getProject").mockResolvedValue("project-fixture");
  const refresh = vi.spyOn(h.service, "forceTokenRefresh").mockResolvedValue();
  const note = vi.spyOn(h.service, "noteUpstreamError").mockResolvedValue();
  return { token, refresh, note };
}
function upstreamSequence(first: () => Response, second: () => Response = healthy) {
  const requests: Array<{ url: string; headers: Headers; body: any; init: any }> = [];
  const fetch = vi.fn(async (url: any, init: any) => {
    requests.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body), init });
    return requests.length === 1 ? first() : second();
  });
  vi.stubGlobal("fetch", fetch); return { fetch, requests };
}

describe("Gemini OAuth data plane through the plugin runtime", () => {
  it("does not change ordinary provider URL, key or response", async () => {
    const h = await build(); const service = stubDataService(h);
    const f = upstreamSequence(() => json({ choices: [{ message: { role: "assistant", content: "ordinary healthy" } }] }));
    const response = await h.server.app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model: "ordinary,m", messages: [{ role: "user", content: "hi" }] } });
    h.noTokens(response.body); expect(response.statusCode).toBe(200); expect(response.body).toContain("ordinary healthy");
    expect(f.fetch).toHaveBeenCalledTimes(1); expect(f.requests[0].url).toBe(ordinary.api_base_url);
    expect(f.requests[0].headers.get("authorization")).toBe("Bearer ordinary-key");
    expect(service.token).not.toHaveBeenCalled(); expect(service.note).not.toHaveBeenCalled();
  });
  it("401 → 200 forces one refresh and makes exactly two fixed-origin requests", async () => {
    const h = await build(); const service = stubDataService(h);
    const f = upstreamSequence(() => json({ error: { message: "UNAUTHENTICATED" } }, 401));
    const response = await h.send(); expect(response.statusCode).toBe(200); expect(response.body).toContain("healthy");
    expect(f.fetch).toHaveBeenCalledTimes(2); expect(service.refresh).toHaveBeenCalledTimes(1);
    for (const req of f.requests) {
      expect(req.url).toBe(`${GEMINI_OAUTH_DATA_PLANE}${GEMINI_OAUTH_SSE_PATH}`);
      expect(req.headers.get("authorization")).toBe(`Bearer ${ACCESS}`); expect(req.init.redirect).toBe("error");
      expect(req.init.dispatcher).toBeDefined(); expect(JSON.stringify(req)).not.toContain(GEMINI_OAUTH_API_KEY);
    }
  });
  it("two consecutive 401s classify reauth and NEVER let the outer retry make a third call", async () => {
    const h = await build(); const service = stubDataService(h);
    const fail = () => json({ error: { message: "UNAUTHENTICATED" } }, 401); const f = upstreamSequence(fail, fail);
    const response = await h.send(); expect(response.statusCode).toBe(401); expect(response.body).toContain("gemini_oauth_reauth_required");
    expect(f.fetch).toHaveBeenCalledTimes(2); expect(service.refresh).toHaveBeenCalledTimes(1);
    expect(service.note).toHaveBeenCalledWith(expect.objectContaining({ code: "gemini_oauth_reauth_required" }));
  });
  it("429 + system identity + exact exhaustion text is identity_blocked (6h)", async () => {
    const h = await build(); const { note } = stubDataService(h);
    const fail = () => json({ error: { message: "Resource has been exhausted" } }, 429); const f = upstreamSequence(fail, fail);
    const response = await h.send([{ role: "system", content: MARKER }, { role: "user", content: "hi" }]);
    expect(response.statusCode).toBe(400); expect(response.body).toContain("gemini_oauth_identity_blocked");
    expect(note).toHaveBeenCalledWith(expect.objectContaining({ code: "gemini_oauth_identity_blocked", cooldownMs: 6 * 60 * 60_000 }));
    expect(f.requests[0].body.request.systemInstruction.parts.some((p: any) => p.text.includes(MARKER))).toBe(true);
    expect(JSON.stringify(f.requests[0].body.request.contents)).not.toContain(MARKER);
  });
  it("moves ordered system text into native systemInstruction without changing conversation contents", async () => {
    const h = await build(); stubDataService(h); const f = upstreamSequence(healthy);
    const response = await h.send([
      { role: "system", content: "first system" },
      { role: "user", content: "first user" },
      { role: "assistant", content: "answer" },
      { role: "system", content: [{ type: "text", text: "second system" }, { type: "text", text: "third system" }] },
      { role: "user", content: "last user" },
    ]);
    expect(response.statusCode).toBe(200);
    expect(f.requests[0].body.request.systemInstruction).toEqual({ parts: [{ text: "first system\nsecond system\nthird system" }] });
    expect(f.requests[0].body.request.contents).toEqual([
      { role: "user", parts: [{ text: "first user" }] },
      { role: "model", parts: [{ text: "answer" }] },
      { role: "user", parts: [{ text: "last user" }] },
    ]);
  });
  it("NEGATIVE: system identity alone without exhaustion text remains quota_exceeded (15m)", async () => {
    const h = await build(); const { note } = stubDataService(h);
    const fail = () => json({ error: { message: "Too many requests" } }, 429); upstreamSequence(fail, fail);
    const response = await h.send([{ role: "system", content: MARKER }, { role: "user", content: "hi" }]);
    expect(response.statusCode).toBe(429); expect(response.body).toContain("gemini_oauth_quota_exceeded");
    expect(response.body).not.toContain("gemini_oauth_identity_blocked");
    expect(note).toHaveBeenCalledWith(expect.objectContaining({ code: "gemini_oauth_quota_exceeded", cooldownMs: 15 * 60_000 }));
    expect(note.mock.calls.every(([info]) => info.cooldownMs !== 6 * 60 * 60_000)).toBe(true);
  });
  it("NEGATIVE: marker only in USER text cannot turn genuine quota 429 into a 6h identity cooldown", async () => {
    const h = await build(); const { note } = stubDataService(h);
    const fail = () => json({ error: { message: "Resource has been exhausted" } }, 429); const f = upstreamSequence(fail, fail);
    const response = await h.send([{ role: "system", content: "A helpful assistant" }, { role: "user", content: MARKER }]);
    expect(response.statusCode).toBe(429); expect(response.body).toContain("gemini_oauth_quota_exceeded");
    expect(response.body).not.toContain("gemini_oauth_identity_blocked");
    expect(JSON.stringify(f.requests[0].body.request.contents)).toContain(MARKER);
    expect(JSON.stringify(f.requests[0].body.request.systemInstruction ?? {})).not.toContain(MARKER);
    expect(note).toHaveBeenCalledWith(expect.objectContaining({ code: "gemini_oauth_quota_exceeded", cooldownMs: 15 * 60_000 }));
    expect(note.mock.calls.every(([info]) => info.cooldownMs !== 6 * 60 * 60_000)).toBe(true);
  });
  it.each([
    ["https://accounts.google.com/verify?token=private-one&secret=private-two&safe=1#private", "https://accounts.google.com/verify?safe=1"],
    ["http://accounts.google.com/verify?token=private-one&secret=private-two", undefined],
  ])("403 VALIDATION_REQUIRED keeps only safe HTTPS link from %s", async (url, expected) => {
    const h = await build(); const { note } = stubDataService(h);
    const fail = () => json({ error: { message: `raw ${ACCESS} ${REFRESH}`, details: [
      { reason: "VALIDATION_REQUIRED", metadata: { validation_url: url, access_token: ACCESS } },
    ] } }, 403); upstreamSequence(fail, fail);
    const response = await h.send(); expect(response.statusCode).toBe(403); expect(response.body).toContain("gemini_oauth_validation_required");
    expect(note).toHaveBeenCalledWith(expect.objectContaining({ code: "gemini_oauth_validation_required", validationUrl: expected, cooldownMs: 30 * 60_000 }));
    expect(response.body).not.toContain("private-one"); expect(response.body).not.toContain("private-two"); expect(response.body).not.toContain("details");
  });
  it("strips client Authorization/x-api-key and marker credentials on EVERY upstream attempt", async () => {
    const h = await build(); stubDataService(h);
    // Defense-in-depth: a transformer/passthrough config may carry client header
    // variants. Exercise the plugin signRequest boundary (the route's LAST
    // stop before dispatch), not only earlier adapters.
    const original = GeminiOauthTransformer.prototype.transformRequestIn;
    vi.spyOn(GeminiOauthTransformer.prototype, "transformRequestIn").mockImplementation(async function(this: GeminiOauthTransformer, request, p, ctx) {
      const transformed = await original.call(this, request, p, ctx);
      transformed.config.headers.authorization = CLIENT_AUTH;
      transformed.config.headers["x-api-key"] = CLIENT_KEY;
      transformed.config.headers["Proxy-Authorization"] = "Bearer proxy-client-secret";
      transformed.config.headers.Authorization = `Bearer ${GEMINI_OAUTH_API_KEY}`;
      return transformed;
    });
    const f = upstreamSequence(() => json({ error: { message: "UNAUTHENTICATED" } }, 401));
    const response = await h.send(undefined, { headers: { authorization: CLIENT_AUTH, "x-api-key": CLIENT_KEY } });
    expect(response.statusCode).toBe(200); expect(f.fetch).toHaveBeenCalledTimes(2);
    for (const req of f.requests) {
      expect(req.headers.get("authorization")).toBe(`Bearer ${ACCESS}`);
      expect(req.headers.has("x-api-key")).toBe(false); expect(req.headers.has("proxy-authorization")).toBe(false);
      expect(JSON.stringify(req)).not.toContain(GEMINI_OAUTH_API_KEY);
      expect(JSON.stringify(req)).not.toContain(CLIENT_KEY); expect(JSON.stringify(req)).not.toContain("untrusted-client-token");
    }
  });
  it("a future persisted cooldown short-circuits before any fetch", async () => {
    const h = await build(); await h.store.save({ ...credential(), account: {
      ...credential().account, cooldownUntil: Date.now() + 60_000,
    } });
    const fetch = vi.fn(async () => healthy()); vi.stubGlobal("fetch", fetch);
    const response = await h.send(); expect(response.statusCode).toBe(429); expect(response.body).toContain("gemini_oauth_account_cooling");
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([false, true])("SSE first UNAUTHENTICATED frame is classified, never silent 200 (stream=%s)", async stream => {
    const h = await build(); const { note } = stubDataService(h);
    const fail = () => sse({ error: { message: "UNAUTHENTICATED" } }); upstreamSequence(fail, fail);
    const response = await h.send(undefined, { payload: { model: "gemini-oauth,gemini-3-flash", messages: [{ role: "user", content: "hi" }], stream } });
    expect(response.statusCode).not.toBe(200); expect(response.body).toContain("gemini_oauth_reauth_required");
    expect(note).toHaveBeenCalledWith(expect.objectContaining({ code: "gemini_oauth_reauth_required" }));
  });
  it("hidden HTTP-200 JSON errors classify through the plugin seam with bookkeeping", async () => {
    const h = await build(); const { note } = stubDataService(h);
    const fail = () => json({ error: { message: `boom ${ACCESS}` } }, 200);
    const f = upstreamSequence(fail, fail);
    const response = await h.send();
    expect(response.statusCode).toBe(502); expect(response.body).toContain("gemini_oauth_upstream_error");
    expect(response.body).not.toContain(ACCESS);
    // A classified terminal response is not re-sent to the same account.
    expect(note).toHaveBeenCalledTimes(1);
    expect(note.mock.calls[0][0].code).toBe("gemini_oauth_upstream_error");
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
});

it("the plugin runtime preserves configured ordinary-provider fallback", async () => {
  const h = await build(); stubDataService(h);
  h.server.configService.set("Router", { enableFallback: true });
  h.server.configService.set("fallback", { default: ["ordinary,m"] });
  vi.spyOn(getHealthStore(), "isAvailable").mockReturnValue(true);
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: any) => {
    urls.push(String(url));
    return String(url).includes("ordinary.invalid")
      ? json({ choices: [{ message: { role: "assistant", content: "fallback healthy" } }] })
      : json({ error: { message: "Resource has been exhausted" } }, 429);
  }));
  const response = await h.send();
  expect(response.statusCode).toBe(200); expect(response.body).toContain("fallback healthy");
  expect(urls.at(-1)).toBe(ordinary.api_base_url);
});
