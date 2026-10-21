/** Frozen UI/admin contract and the real routes.ts data-plane seam; Google is always mocked. */
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Server from "../../../core/src/server";
import ts from "typescript";
import { activate, manifest } from "../src/plugin";
import { getGeminiOauthAuthService } from "../src/protocol";
import { makePluginContext, clearPluginRegistry } from "../../../core/src/provider-plugins/registry";
import { setTransformerRuntime } from "../../../core/src/services/transformer";
import { getDirectDispatcher } from "../../../core/src/services/proxy";
import { reloadProviderRuntime } from "../../../core/src/provider-plugins/host";
import { registerAdminRoutes } from "../../../core/src/ccr/admin-routes";
import * as configModule from "../../../core/src/ccr/config";
import * as activeProbe from "../../../core/src/services/active-probe";
import { GeminiOauthAuthService, GeminiOauthCredentialStore, geminiOauthAdminError } from "../src/auth-service";
import {
  GEMINI_OAUTH_API_KEY, GEMINI_OAUTH_DATA_PLANE, GEMINI_OAUTH_SSE_PATH,
  clearGeminiOauthTokenCaches, lockGeminiOauthProvider, scrubUpstreamMessage, setGeminiOauthRuntime,
} from "../src/protocol";
import { GeminiOauthTransformer } from "../src/transformer";


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
  clearPluginRegistry();
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  activeProbe.resetActiveProbeService();
  setGeminiOauthRuntime(null); clearGeminiOauthTokenCaches(); clearPluginRegistry();
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
  const log = { info: () => {}, warn: () => {}, error: () => {} };
  setTransformerRuntime(server.transformerService);
  const ctx = makePluginContext(manifest, log, {
    configDir: dir,
    readConfig: () => configModule.readConfigFile(),
    readRawConfig: () => configModule.readConfigFileRaw(),
    writeConfig: next => configModule.writeConfigFile(next),
    reloadRuntime: async cfg => reloadProviderRuntime(server, cfg ?? live.current, log),
    getDirectDispatcher,
  });
  await activate(ctx);
  await ctx.host.reloadRuntime(config);
  if (admin) await registerAdminRoutes(server, { ...config, PORT: 3456 });
  const service = getGeminiOauthAuthService() as GeminiOauthAuthService;
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
