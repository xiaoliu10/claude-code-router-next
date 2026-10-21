/** Frozen UI/admin contract and the real routes.ts data-plane seam; Google is always mocked. */
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Server from "../server";
import ts from "typescript";
import { registerAdminRoutes } from "../ccr/admin-routes";
import * as configModule from "../ccr/config";
import * as activeProbe from "../services/active-probe";
import { GeminiOauthAuthService, GeminiOauthCredentialStore, geminiOauthAdminError } from "../services/gemini-oauth-auth";
import {
  GEMINI_OAUTH_API_KEY, GEMINI_OAUTH_DATA_PLANE, GEMINI_OAUTH_SSE_PATH,
  clearGeminiOauthTokenCaches, lockGeminiOauthProvider, scrubUpstreamMessage, setGeminiOauthRuntime,
} from "../services/gemini-oauth";
import { GeminiOauthTransformer } from "../transformer/gemini-oauth.transformer";


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

beforeEach(() => {
  vi.stubEnv("GEMINI_OAUTH_CLIENT_ID", "dummy-client-id"); vi.stubEnv("GEMINI_OAUTH_CLIENT_SECRET", "dummy-client-secret");
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network disabled in test"); }));
  clearGeminiOauthTokenCaches();
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  activeProbe.resetActiveProbeService();
  setGeminiOauthRuntime(null); clearGeminiOauthTokenCaches();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
});

async function build(config: any = { Providers: [provider(), ordinary], Router: {} }, admin = true) {
  const dir = mkdtempSync(join(tmpdir(), "gemini-routes-"));
  const store = new GeminiOauthCredentialStore(join(dir, "gemini-oauth-credentials.json"));
  const live = { current: structuredClone(config) };
  vi.spyOn(configModule, "readConfigFileRaw").mockImplementation(async () => structuredClone(live.current));
  vi.spyOn(configModule, "readConfigFile").mockImplementation(async () => structuredClone(live.current));
  vi.spyOn(configModule, "writeConfigFile").mockImplementation(async (next: any) => { live.current = structuredClone(next); });
  vi.spyOn(configModule, "backupConfigFile").mockResolvedValue(null);
  // POST /config may reload probing: no background network is allowed.
  vi.spyOn(activeProbe, "startActiveProbe").mockReturnValue({ stop: vi.fn() } as any);
  const server = new Server({ logger: false, useJsonFile: false, initialConfig: {
    providers: config.Providers, Router: config.Router, HOST: "127.0.0.1", PORT: 0, ACTIVE_PROBE_ENABLED: false,
    enableFallback: false,
  } });
  cleanups.push(async () => { await server.app.close(); rmSync(dir, { recursive: true, force: true }); });
  await server.ready();
  if (admin) await registerAdminRoutes(server, { ...config, PORT: 3456 });
  const service = new GeminiOauthAuthService({ store, configService: server.configService, logger: { warn: vi.fn(), error: vi.fn() } });
  server.geminiOauthAuthService = service; setGeminiOauthRuntime({ authService: service });
  await server.registerNamespace("/"); await server.app.ready();
  const noTokens = (body: string) => { expect(body).not.toContain(ACCESS); expect(body).not.toContain(REFRESH); };
  const request = async (path: string, payload?: any, extra: any = {}) => {
    const response = await server.app.inject({ method: path === "/status" ? "GET" : "POST",
      url: `http://localhost:3456/api/gemini-oauth${path}`, ...(payload === undefined ? {} : { payload }), ...extra });
    noTokens(response.body); return response;
  };
  const send = async (messages: any[] = [{ role: "user", content: "hello" }], extra: any = {}) => {
    const response = await server.app.inject({ method: "POST", url: "/v1/chat/completions", payload: {
      model: "gemini-oauth,gemini-3-flash", stream: false, messages, ...extra.payload,
    }, ...extra, });
    noTokens(response.body); return response;
  };
  return { server, store, service, request, send, noTokens, config: () => live.current };
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

describe("Gemini OAuth six admin routes: exact UI fields and no credentials", () => {
  it("pins UI type fields/optionality/types without importing files outside core rootDir", () => {
    // Parse the actual UI source: a renamed/added field or type drift must fail.
    const source = ts.createSourceFile("types.ts", readFileSync(join(__dirname, "../../../ui/src/types.ts"), "utf8"), ts.ScriptTarget.Latest, true);
    const expected: Record<string, Record<string, string>> = {
      GeminiOauthStatusResponse: { configured: "boolean", connected: "boolean", kind: "GeminiOauthKind", "email?": "string|null", "project?": "string|null", "tier?": "string|null", "modelsCount?": "number", "lastError?": "GeminiOauthError|null", "cooldownUntil?": "number|null" },
      GeminiOauthLoginStartResponse: { loginId: "string", url: "string", expiresAt: "number" },
      GeminiOauthSyncResponse: { ok: "boolean", "modelsCount?": "number", "clearedRefs?": "string[]", "error?": "GeminiOauthErrorCode|string|null" },
      GeminiOauthDisconnectResponse: { ok: "boolean", "removedModelRefs?": "string[]", "defaultFallback?": "string|null" },
      GeminiOauthError: { code: "GeminiOauthErrorCode", "message?": "string|null", "validationUrl?": "string|null" },
    };
    for (const [name, fields] of Object.entries(expected)) {
      const declaration = source.statements.find((node): node is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(node) && node.name.text === name);
      expect(declaration, name).toBeDefined();
      const actual = Object.fromEntries(declaration!.members.map(member => {
        const p = member as ts.PropertySignature;
        return [p.name!.getText(source) + (p.questionToken ? "?" : ""), p.type!.getText(source).replace(/\s/g, "")];
      }));
      expect(actual, name).toEqual(fields);
    }
    const poll = source.statements.find((node): node is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(node) && node.name.text === "GeminiOauthLoginPollResponse");
    expect(poll!.type.getText(source).replace(/\s/g, "")).toBe('|{status:"pending"}|{status:"success";email?:string|null}|{status:"failed";error?:GeminiOauthErrorCode|null}');
  });
  it("status includes every GeminiOauthStatusResponse field, with classified safe lastError", async () => {
    const h = await build(); const data = credential();
    await h.store.save(data);
    await h.service.noteUpstreamError({ code: "gemini_oauth_validation_required", httpStatus: 403, message: ACCESS,
      validationUrl: "https://accounts.google.com/verify", cooldownMs: 60_000 });
    const response = await h.request("/status"); expect(response.statusCode).toBe(200);
    const expected = {
      configured: true, connected: true, kind: "antigravity", email: data.account.email, project: data.account.projectId,
      tier: "paid-tier", modelsCount: 1, lastError: {
        code: "gemini_oauth_validation_required", message: "Google requires account verification before continuing.",
        validationUrl: "https://accounts.google.com/verify",
      }, cooldownUntil: (await h.store.load())!.account.cooldownUntil,
    };
    expect(response.json()).toEqual(expected);
  });
  it("disconnected status still supplies all nullable fields", async () => {
    const h = await build({ Providers: [], Router: {} });
    expect((await h.request("/status")).json()).toEqual({ configured: true, connected: false, kind: "antigravity",
      email: null, project: null, tier: null, modelsCount: 0, lastError: null, cooldownUntil: null });
  });
  it("start has exactly three typed fields; cancel is exactly {ok:true}", async () => {
    const h = await build(); const response = await h.request("/login/start"); expect(response.statusCode).toBe(200);
    const started = response.json();
    expect(Object.keys(started).sort()).toEqual(["expiresAt", "loginId", "url"]);
    expect(started.loginId).toMatch(/^[a-f0-9]{48}$/); expect(new URL(started.url).hostname).toBe("accounts.google.com");
    expect(started.expiresAt).toBeGreaterThan(Date.now());
    try {
      expect((await h.request("/login/cancel", { loginId: started.loginId })).json()).toEqual({ ok: true });
    } finally { h.service.cancelLogin(started.loginId); }
  });
  it.each([
    [{ status: "pending" }, 200],
    [{ status: "success", email: "fixture@example.invalid" }, 200],
    [{ status: "failed", error: "gemini_oauth_login_state_rejected" }, 422],
  ] as const)("poll preserves the %j discriminated union", async (result, status) => {
    const h = await build();
    const typed = result;
    vi.spyOn(h.service, "pollLogin").mockResolvedValue(typed as any);
    const response = await h.request("/login/poll", { loginId: "a".repeat(48) });
    expect(response.statusCode).toBe(status); expect(response.json()).toEqual(typed);
  });
  it.each(["/login/poll", "/login/cancel"])("%s rejects malformed ids before the service", async path => {
    const h = await build(); const spy = vi.spyOn(h.service, path.endsWith("poll") ? "pollLogin" : "cancelLogin");
    expect((await h.request(path, { loginId: "bad" })).statusCode).toBe(422); expect(spy).not.toHaveBeenCalled();
  });
  it("sync success writes discovered models and reports cleared Router paths", async () => {
    const h = await build({ Providers: [provider(["old-model"])], Router: { default: "gemini-oauth,old-model" } });
    await h.store.save(credential());
    vi.stubGlobal("fetch", vi.fn(async (url: any) => String(url).includes("/token")
      ? json({ access_token: ACCESS }) : json({ models: { "gemini-3-flash": { displayName: "Flash" } } })));
    const response = await h.request("/sync"); expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, modelsCount: 1, clearedRefs: ["default"] });
    expect(h.config().Providers[0].models).toEqual(["gemini-3-flash"]);
    expect(h.config().Router.default).toBe("gemini-oauth,gemini-3-flash");
  });
  it("model fetch failure returns 422 with old models/config retained", async () => {
    const h = await build(); await h.store.save(credential());
    vi.stubGlobal("fetch", vi.fn(async (url: any) => String(url).includes("/token")
      ? json({ access_token: ACCESS }) : json({ error: { message: `${ACCESS} ${REFRESH}` } }, 500)));
    const previous = structuredClone(h.config()); const response = await h.request("/sync"); expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ ok: false, modelsCount: 1, clearedRefs: [], error: "gemini_oauth_models_fetch_failed" });
    expect(h.config()).toEqual(previous);
  });
  it("disconnect reports actual removed refs and the persisted defaultFallback", async () => {
    const h = await build({ Providers: [provider(), ordinary], Router: { default: "gemini-oauth,gemini-3-flash", think: "ordinary,m" } });
    await h.store.save(credential()); const response = await h.request("/disconnect"); expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, removedModelRefs: ["gemini-oauth,gemini-3-flash"], defaultFallback: "" });
    expect(h.config().Providers).toEqual([ordinary]); expect(h.config().Router).toEqual({ default: "", think: "ordinary,m" });
    expect(await h.store.load()).toBeNull();
  });
  it("reauth errors are 422, NEVER 401 (the UI must not clear the CCR key)", async () => {
    const h = await build(); await h.store.save(credential());
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "invalid_grant", access_token: ACCESS, refresh_token: REFRESH }, 401)));
    const response = await h.request("/sync"); expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ ok: false, success: false, error: "gemini_oauth_reauth_required" });
    vi.spyOn(h.service, "syncModels").mockRejectedValue(geminiOauthAdminError("gemini_oauth_reauth_required", 401));
    expect((await h.request("/sync")).statusCode).toBe(422);
  });
  it("unexpected service errors never echo raw token/error messages", async () => {
    const h = await build(); vi.spyOn(h.service, "getStatus").mockRejectedValue(new Error(`${ACCESS} ${REFRESH}`));
    const response = await h.request("/status"); expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ ok: false, success: false, error: "gemini_oauth_status_failed" });
  });
});

describe("Gemini OAuth local guard and generic config protection", () => {
  it.each(["/status", "/login/start", "/login/poll", "/login/cancel", "/sync", "/disconnect"])("%s refuses non-loopback and hostile Origins", async path => {
    const h = await build();
    for (const extra of [{ remoteAddress: "203.0.113.7", headers: { origin: "http://localhost:3456", host: "localhost:3456" } },
      { remoteAddress: "127.0.0.1", headers: { origin: "https://attacker.invalid", host: "localhost:3456" } }]) {
      const response = await h.request(path, undefined, extra);
      expect(response.statusCode).toBe(403); expect(response.json()).toEqual({ ok: false, success: false, error: "gemini_oauth_unauthorized" });
    }
  });
  it("originless loopback CLI requests succeed", async () => {
    const h = await build(); expect((await h.request("/status", undefined, { remoteAddress: "127.0.0.1" })).statusCode).toBe(200);
  });
  it.each([false, true])("POST /api/config re-locks transport or restores omitted provider (omit=%s)", async omit => {
    const h = await build(); const response = await h.server.app.inject({ method: "POST", url: "/api/config", payload: {
      Providers: omit ? [ordinary] : [{ name: "gemini-oauth", api_base_url: "https://attacker.invalid", api_key: "attacker-key", transformer: { use: [] }, models: ["m"] }],
      Router: { default: "ordinary,m" },
    } });
    h.noTokens(response.body); expect(response.statusCode).toBe(200);
    const p = h.config().Providers.find((p: any) => p.name === "gemini-oauth");
    expect(p).toMatchObject({ api_base_url: GEMINI_OAUTH_DATA_PLANE, api_key: GEMINI_OAUTH_API_KEY,
      gemini_oauth_managed: true, gemini_oauth_kind: "antigravity", transformer: { use: ["gemini-oauth"] } });
    expect(JSON.stringify(h.config())).not.toContain("attacker");
    const get = await h.server.app.inject({ method: "GET", url: "/api/config" }); h.noTokens(get.body);
  });
});

describe("Gemini OAuth routes.ts upstream seam", () => {
  it("does not change ordinary provider URL, key or response", async () => {
    const h = await build(undefined, false); const service = stubDataService(h);
    const f = upstreamSequence(() => json({ choices: [{ message: { role: "assistant", content: "ordinary healthy" } }] }));
    const response = await h.server.app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model: "ordinary,m", messages: [{ role: "user", content: "hi" }] } });
    h.noTokens(response.body); expect(response.statusCode).toBe(200); expect(response.body).toContain("ordinary healthy");
    expect(f.fetch).toHaveBeenCalledTimes(1); expect(f.requests[0].url).toBe(ordinary.api_base_url);
    expect(f.requests[0].headers.get("authorization")).toBe("Bearer ordinary-key");
    expect(service.token).not.toHaveBeenCalled(); expect(service.note).not.toHaveBeenCalled();
  });
  it("401 → 200 forces one refresh and makes exactly two fixed-origin requests", async () => {
    const h = await build(undefined, false); const service = stubDataService(h);
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
    const h = await build(undefined, false); const service = stubDataService(h);
    const fail = () => json({ error: { message: "UNAUTHENTICATED" } }, 401); const f = upstreamSequence(fail, fail);
    const response = await h.send(); expect(response.statusCode).toBe(401); expect(response.body).toContain("gemini_oauth_reauth_required");
    expect(f.fetch).toHaveBeenCalledTimes(2); expect(service.refresh).toHaveBeenCalledTimes(1);
    expect(service.note).toHaveBeenCalledWith(expect.objectContaining({ code: "gemini_oauth_reauth_required" }));
  });
  it("429 + system identity + exact exhaustion text is identity_blocked (6h)", async () => {
    const h = await build(undefined, false); const { note } = stubDataService(h);
    const fail = () => json({ error: { message: "Resource has been exhausted" } }, 429); const f = upstreamSequence(fail, fail);
    const response = await h.send([{ role: "system", content: MARKER }, { role: "user", content: "hi" }]);
    expect(response.statusCode).toBe(400); expect(response.body).toContain("gemini_oauth_identity_blocked");
    expect(note).toHaveBeenCalledWith(expect.objectContaining({ code: "gemini_oauth_identity_blocked", cooldownMs: 6 * 60 * 60_000 }));
    expect(f.requests[0].body.request.systemInstruction.parts.some((p: any) => p.text.includes(MARKER))).toBe(true);
    expect(JSON.stringify(f.requests[0].body.request.contents)).not.toContain(MARKER);
  });
  it("moves ordered system text into native systemInstruction without changing conversation contents", async () => {
    const h = await build(undefined, false); stubDataService(h); const f = upstreamSequence(healthy);
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
    const h = await build(undefined, false); const { note } = stubDataService(h);
    const fail = () => json({ error: { message: "Too many requests" } }, 429); upstreamSequence(fail, fail);
    const response = await h.send([{ role: "system", content: MARKER }, { role: "user", content: "hi" }]);
    expect(response.statusCode).toBe(429); expect(response.body).toContain("gemini_oauth_quota_exceeded");
    expect(response.body).not.toContain("gemini_oauth_identity_blocked");
    expect(note).toHaveBeenCalledWith(expect.objectContaining({ code: "gemini_oauth_quota_exceeded", cooldownMs: 15 * 60_000 }));
    expect(note.mock.calls.every(([info]) => info.cooldownMs !== 6 * 60 * 60_000)).toBe(true);
  });
  it("NEGATIVE: marker only in USER text cannot turn genuine quota 429 into a 6h identity cooldown", async () => {
    const h = await build(undefined, false); const { note } = stubDataService(h);
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
    const h = await build(undefined, false); const { note } = stubDataService(h);
    const fail = () => json({ error: { message: `raw ${ACCESS} ${REFRESH}`, details: [
      { reason: "VALIDATION_REQUIRED", metadata: { validation_url: url, access_token: ACCESS } },
    ] } }, 403); upstreamSequence(fail, fail);
    const response = await h.send(); expect(response.statusCode).toBe(403); expect(response.body).toContain("gemini_oauth_validation_required");
    expect(note).toHaveBeenCalledWith(expect.objectContaining({ code: "gemini_oauth_validation_required", validationUrl: expected, cooldownMs: 30 * 60_000 }));
    expect(response.body).not.toContain("private-one"); expect(response.body).not.toContain("private-two"); expect(response.body).not.toContain("details");
  });
  it("strips client Authorization/x-api-key and marker credentials on EVERY upstream attempt", async () => {
    const h = await build(undefined, false); stubDataService(h);
    // Defense-in-depth: a transformer/passthrough config may carry client header
    // variants. Exercise the route's LAST boundary, not only earlier adapters.
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
    const h = await build(undefined, false); await h.store.save({ ...credential(), account: {
      ...credential().account, cooldownUntil: Date.now() + 60_000,
    } });
    const fetch = vi.fn(async () => healthy()); vi.stubGlobal("fetch", fetch);
    const response = await h.send(); expect(response.statusCode).toBe(429); expect(response.body).toContain("gemini_oauth_account_cooling");
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([false, true])("SSE first UNAUTHENTICATED frame is classified, never silent 200 (stream=%s)", async stream => {
    const h = await build(undefined, false); const { note } = stubDataService(h);
    const fail = () => sse({ error: { message: "UNAUTHENTICATED" } }); upstreamSequence(fail, fail);
    const response = await h.send(undefined, { payload: { model: "gemini-oauth,gemini-3-flash", messages: [{ role: "user", content: "hi" }], stream } });
    expect(response.statusCode).not.toBe(200); expect(response.body).toContain("gemini_oauth_reauth_required");
    expect(note).toHaveBeenCalledWith(expect.objectContaining({ code: "gemini_oauth_reauth_required" }));
  });
});

describe("scrubUpstreamMessage token shapes", () => {
  it.each([
    ["ya29.secret-access-token", "ya29.secret-access-token"],
    ["Bearer supersecretbearertoken", "supersecretbearertoken"],
    ['access_token="private-access-token"', "private-access-token"],
    ['refresh_token="1//0abcdefghijklmnopqrstuvwxyz1234567890"', "1//0abcdefghijklmnopqrstuvwxyz1234567890"],
    ["1//0abcdefghijklmnopqrstuvwxyz1234567890", "1//0abcdefghijklmnopqrstuvwxyz1234567890"],
  ])("redacts %s", (message, secret) => {
    const safe = scrubUpstreamMessage(`prefix ${message} suffix`);
    expect(safe).not.toContain(secret); expect(safe).toContain("[redacted]");
    expect(safe).toContain("prefix"); expect(safe).toContain("suffix");
  });
});
