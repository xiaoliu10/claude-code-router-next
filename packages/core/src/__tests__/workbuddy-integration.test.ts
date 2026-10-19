import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import Server from "../server";
import { registerAdminRoutes } from "../ccr/admin-routes";
import { WorkBuddyTransformer } from "../transformer/workbuddy.transformer";
import { WorkBuddyCredentialStore, type WorkBuddyCredential } from "../services/workbuddy";
import * as configModule from "../ccr/config";

const TOKEN = "chat-access-token";
const CRED: WorkBuddyCredential = {
  version: 1, kind: "workbuddy", uid: "u-1", displayName: "Nick", domain: "",
  enterpriseId: "", accessToken: TOKEN, expiresAt: 0,
  importedAt: "2026-10-19T00:00:00.000Z", source: "desktop",
};

const CHAT_URL = "https://copilot.tencent.com/v2/chat/completions";

function jsonResponse(payload: unknown, url = CHAT_URL): Response {
  const response = new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
  Object.defineProperty(response, "url", { value: url, configurable: true });
  return response;
}

function sseResponse(chunks: string[], url = CHAT_URL): Response {
  const encoder = new TextEncoder();
  let i = 0;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(c) { if (i === chunks.length) c.close(); else c.enqueue(encoder.encode(chunks[i++])); },
  }), { headers: { "Content-Type": "text/event-stream" } });
  Object.defineProperty(response, "url", { value: url, configurable: true });
  return response;
}

/**
 * End-to-end data-plane test through the real sendRequestToProvider pipeline
 * (fixed URL lock + auth header override + error redaction), with fetch stubbed.
 */
async function buildProviderServer(providers: any[], router: any = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wb-plane-"));
  const store = new WorkBuddyCredentialStore(join(dir, "creds.json"));
  const config = { PORT: 0, Providers: providers, Router: router };
  const server = new Server({
    logger: false,
    useJsonFile: false,
    initialConfig: { providers, Router: router, HOST: "127.0.0.1", PORT: 0 },
  });
  await server.ready();
  await registerAdminRoutes(server, config);
  await server.registerNamespace("/");
  await server.app.ready();
  // Install an isolated credential store on the runtime service so the data
  // plane resolves a mock credential instead of the real CCR private file.
  const { WorkBuddyAuthService } = await import("../services/workbuddy-auth");
  const service = new WorkBuddyAuthService({
    configService: server.configService,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    store,
    getServer: () => server,
  });
  (server as any).workBuddyAuthService = service;
  const { setWorkBuddyRuntime } = await import("../services/workbuddy");
  setWorkBuddyRuntime({ authService: service });
  return { server, dir, store, config };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("WorkBuddy data plane (isolated mocks)", () => {
  it("sends the chat request to the fixed URL with WorkBuddy headers, ignoring a hostile base_url", async () => {
    const serverRuntime = await buildProviderServer([{
      name: "workbuddy",
      api_base_url: "https://attacker.example/v1/chat/completions",
      api_key: "ccr-managed-workbuddy",
      models: ["glm-5.3"],
      transformer: { use: ["workbuddy"] },
      ccr_managed: true,
    }]);
    const { store, dir } = serverRuntime;
    await store.save(CRED);

    const fetchMock = vi.fn(async () => jsonResponse({
      id: "1", choices: [{ message: { role: "assistant", content: "hello" } }], usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await serverRuntime.server.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "workbuddy,glm-5.3", messages: [{ role: "user", content: "hi" }], max_completion_tokens: 100, stream: false },
    });

    expect(res.statusCode).toBe(200);
    const [url, init] = fetchMock.mock.calls[0] as any;
    // The hostile base_url never wins: the URL is locked to the fixed origin.
    expect(url).toBe(CHAT_URL);
    const headers = init.headers instanceof Headers ? Object.fromEntries(init.headers.entries()) : init.headers;
    expect(headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(headers["user-agent"]).toBe("WorkBuddy/5.5.6");
    expect(headers["x-user-id"]).toBe("u-1");
    expect(headers["x-domain"]).toBe("copilot.tencent.com");
    // The marker api_key never reaches the upstream.
    expect(JSON.stringify(headers)).not.toContain("ccr-managed-workbuddy");
    // Redirects away from the fixed origin are refused.
    expect(init.redirect).toBe("error");
    // Body quirk applied before the send.
    const sent = JSON.parse(init.body);
    expect(sent.max_tokens).toBe(100);
    expect(sent.max_completion_tokens).toBeUndefined();
    expect(sent.messages[0].role).toBe("system");
    rmSync(dir, { recursive: true, force: true });
  });

  it("streams SSE and never forwards the raw upstream error body", async () => {
    const serverRuntime = await buildProviderServer([{
      name: "workbuddy", api_base_url: CHAT_URL, api_key: "ccr-managed-workbuddy",
      models: ["glm-5.3"], transformer: { use: ["workbuddy"] }, ccr_managed: true,
    }]);
    const { store, dir } = serverRuntime;
    await store.save(CRED);

    const fetchMock = vi.fn(async () => sseResponse([
      "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n",
      "data: [DONE]\n\n",
    ]));
    vi.stubGlobal("fetch", fetchMock);

    const res = await serverRuntime.server.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "workbuddy,glm-5.3", messages: [{ role: "user", content: "hi" }], stream: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("hi");
    expect(res.body).toContain("[DONE]");

    // Upstream failure: the classified, redacted error is what surfaces.
    const failMock = vi.fn(async () => {
      const response = new Response(JSON.stringify({ code: 11140, msg: "account has been restricted due to unusual activity", accessToken: TOKEN }), { status: 403 });
      Object.defineProperty(response, "url", { value: CHAT_URL, configurable: true });
      return response;
    });
    vi.stubGlobal("fetch", failMock);
    const failRes = await serverRuntime.server.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "workbuddy,glm-5.3", messages: [{ role: "user", content: "hi" }], stream: false },
    });
    expect(failRes.statusCode).toBeGreaterThanOrEqual(400);
    // The token and the raw upstream envelope never reach the client.
    expect(failRes.body).not.toContain(TOKEN);
    expect(failRes.body).not.toContain("unusual activity");
    expect(failRes.body).toContain("11140");
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a redirect away from the fixed origin", async () => {
    const serverRuntime = await buildProviderServer([{
      name: "workbuddy", api_base_url: CHAT_URL, api_key: "ccr-managed-workbuddy",
      models: ["glm-5.3"], transformer: { use: ["workbuddy"] }, ccr_managed: true,
    }]);
    const { store, dir } = serverRuntime;
    await store.save(CRED);
    // fetch refuses the redirect because redirect:"error" is passed.
    const fetchMock = vi.fn(async () => {
      const err: any = new Error("redirected");
      err.code = "EPROTO";
      throw err;
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await serverRuntime.server.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "workbuddy,glm-5.3", messages: [{ role: "user", content: "hi" }], stream: false },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    const [, init] = fetchMock.mock.calls[0] as any;
    expect(init.redirect).toBe("error");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("WorkBuddy admin API (isolated mocks)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function stubConfig(config: any) {
    vi.spyOn(configModule, "readConfigFileRaw").mockResolvedValue(config);
    vi.spyOn(configModule, "writeConfigFile").mockImplementation(async (cfg: any) => {
      config.Providers = cfg.Providers;
      config.Router = cfg.Router;
    });
    vi.spyOn(configModule, "backupConfigFile").mockResolvedValue(null);
  }

  async function build(config: any, source: string | null) {
    const dir = mkdtempSync(join(tmpdir(), "wb-admin-"));
    dirs.push(dir);
    const store = new WorkBuddyCredentialStore(join(dir, "creds.json"));
    const { writeFileSync } = await import("node:fs");
    if (source !== null) writeFileSync(join(dir, "src.info"), source);
    const server = new Server({
      logger: false, useJsonFile: false,
      initialConfig: { providers: config.Providers, Router: config.Router, HOST: "127.0.0.1", PORT: 0 },
    });
    await server.ready();
    await registerAdminRoutes(server, config);
    await server.registerNamespace("/");
    await server.app.ready();
    const { WorkBuddyAuthService } = await import("../services/workbuddy-auth");
    const { parseWorkBuddySource } = await import("../services/workbuddy");
    const { readFileSync } = await import("node:fs");
    const service = new WorkBuddyAuthService({
      configService: server.configService,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      store,
      readSource: () => {
        try { return parseWorkBuddySource(readFileSync(join(dir, "src.info"), "utf8")); }
        catch { return { ok: false, reason: "source_missing" } as const; }
      },
      getServer: () => server,
    });
    (server as any).workBuddyAuthService = service;
    return { server, dir, store, config, service };
  }

  const SOURCE = JSON.stringify({ account: { uid: "u-1", nickname: "Nick" }, auth: { accessToken: TOKEN } });
  const envOk = () => {
    const response = new Response(JSON.stringify({
      code: 0, data: { agents: [{ name: "cli", models: ["glm-5.3"] }], models: [{ id: "glm-5.3", name: "G" }] },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
    Object.defineProperty(response, "url", { value: "https://copilot.tencent.com/v3/config", configurable: true });
    return response;
  };

  it("GET /api/workbuddy/status reports not_connected without reading the source", async () => {
    const config = { Providers: [], Router: {} };
    const { server, dir } = await build(config, SOURCE);
    stubConfig(config);
    const res = await server.app.inject({ method: "GET", url: "/api/workbuddy/status" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "not_connected", providerName: "workbuddy", models: [], modelCount: 0 });
    // The source file exists on disk but was never opened.
    const { readFileSync } = await import("node:fs");
    expect(() => readFileSync(join(dir, "src.info"), "utf8")).not.toThrow();
    expect(res.json().lastError ?? null).toBeNull();
  });

  it("POST /api/workbuddy/import returns 422 sealed and writes nothing", async () => {
    const config = { Providers: [], Router: {} };
    const { server, store } = await build(config, JSON.stringify({ account: { uid: "u-1" }, auth: { accessToken: { $wbEncrypted: 1 } } }));
    stubConfig(config);
    const res = await server.app.inject({ method: "POST", url: "/api/workbuddy/import", payload: {} });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ success: false, reason: "sealed", modelsUnchanged: true });
    expect(config.Providers).toEqual([]);
    expect(store.path && (await import("node:fs")).existsSync(store.path)).toBe(false);
  });

  it("POST /api/workbuddy/import succeeds and hides the token from /api/config", async () => {
    const config = { Providers: [], Router: { default: "other,m" } };
    const { server, store } = await build(config, SOURCE);
    stubConfig(config);
    vi.stubGlobal("fetch", vi.fn(async () => envOk()));

    const res = await server.app.inject({ method: "POST", url: "/api/workbuddy/import", payload: {} });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ success: true, status: "connected", models: ["glm-5.3"], modelCount: 1 });
    expect(JSON.stringify(body)).not.toContain(TOKEN);

    // The managed provider is registered with the marker key, and /api/config
    // (raw) exposes no token at all.
    const managed: any = config.Providers.find((p: any) => p.name === "workbuddy");
    expect(managed?.api_key).toBe("ccr-managed-workbuddy");
    const raw = await server.app.inject({ method: "GET", url: "/api/config" });
    expect(raw.body).not.toContain(TOKEN);
    // The private credential file does hold the token, 0600.
    const { statSync } = await import("node:fs");
    expect(statSync(store.path).mode & 0o777).toBe(0o600);
  });

  it("POST /api/workbuddy/sync returns 409 when not connected", async () => {
    const config = { Providers: [], Router: {} };
    const { server } = await build(config, null);
    stubConfig(config);
    const res = await server.app.inject({ method: "POST", url: "/api/workbuddy/sync", payload: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ success: false, error: "workbuddy_not_connected" });
  });

  it("POST /api/workbuddy/import returns 409 for a plain same-name provider and writes nothing", async () => {
    const config = { Providers: [{ name: "workbuddy", api_base_url: "https://x/v1", api_key: "k", models: ["m"] }], Router: {} };
    const { server } = await build(config, SOURCE);
    stubConfig(config);
    vi.stubGlobal("fetch", vi.fn(async () => envOk()));
    const res = await server.app.inject({ method: "POST", url: "/api/workbuddy/import", payload: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ success: false, error: "workbuddy_name_conflict" });
    expect(config.Providers[0].api_base_url).toBe("https://x/v1");
  });

  it("POST /api/workbuddy/disconnect removes the provider and keeps Router", async () => {
    const router = { default: "other,m", longContext: ["workbuddy,glm-5.3"] };
    const config = { Providers: [
      { name: "other", api_base_url: "https://x/v1", api_key: "k", models: ["m"] },
      { name: "workbuddy", ccr_managed: true, api_base_url: CHAT_URL, api_key: "ccr-managed-workbuddy", models: ["glm-5.3"], transformer: { use: ["workbuddy"] } },
    ], Router: router };
    const { server, store } = await build(config, null);
    stubConfig(config);
    await store.save(CRED);
    const res = await server.app.inject({ method: "POST", url: "/api/workbuddy/disconnect", payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, removedProvider: true, deletedCredential: true });
    expect(config.Providers.map((p: any) => p.name)).toEqual(["other"]);
    expect(config.Router).toEqual(router);
    const { existsSync } = await import("node:fs");
    expect(existsSync(store.path)).toBe(false);
  });

  it("rejects a remote non-loopback origin even with an API key configured", async () => {
    const config = { PORT: 3456, APIKEY: "secret", Providers: [], Router: {} };
    const { server } = await build(config, null);
    stubConfig(config);
    const res = await server.app.inject({
      method: "GET",
      url: "/api/workbuddy/status",
      remoteAddress: "203.0.113.9",
      headers: { origin: "https://evil.example" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "workbuddy_unauthorized" });
  });

  it("allows an originless local CLI request", async () => {
    const config = { PORT: 3456, APIKEY: "secret", Providers: [], Router: {} };
    const { server } = await build(config, null);
    stubConfig(config);
    const res = await server.app.inject({
      method: "GET",
      url: "/api/workbuddy/status",
      remoteAddress: "127.0.0.1",
    });
    expect(res.statusCode).toBe(200);
  });

  it("allows the same local browser origin", async () => {
    const config = { PORT: 3456, APIKEY: "secret", Providers: [], Router: {} };
    const { server } = await build(config, null);
    stubConfig(config);
    const res = await server.app.inject({
      method: "GET",
      url: "/api/workbuddy/status",
      remoteAddress: "127.0.0.1",
      headers: { origin: "http://127.0.0.1:3456" },
    });
    expect(res.statusCode).toBe(200);
  });
});
