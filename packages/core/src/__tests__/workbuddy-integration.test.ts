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
  enterpriseId: "", accessToken: TOKEN, expiresAt: 0, tokenType: "",
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
    // Fixed-origin WorkBuddy traffic explicitly ignores configured CCR proxies.
    expect(init.dispatcher).toBeDefined();
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

  it("international credentials use the international chat origin even with a hostile config", async () => {
    const { server, store, dir } = await buildProviderServer([{
      name: "workbuddy", ccr_managed: true, api_base_url: "https://evil.example/chat",
      api_key: "ccr-managed-workbuddy", models: ["gpt-5.5"], transformer: { use: ["workbuddy"] },
    }]);
    await store.save({ ...CRED, kind: "workbuddy-ai", domain: "www.codebuddy.ai" });
    const fetchMock = vi.fn(async () => jsonResponse({ choices: [{ message: { role: "assistant", content: "ai" } }] }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await server.app.inject({ method: "POST", url: "/v1/chat/completions", payload: {
      model: "workbuddy,gpt-5.5", stream: false, messages: [{ role: "user", content: "hi" }],
    } });
    expect(res.statusCode).toBe(200);
    const [url, init] = fetchMock.mock.calls[0] as any;
    expect(url).toBe("https://www.workbuddy.ai/v2/chat/completions");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer " + TOKEN);
    expect(headers.get("x-agent-type")).toBe("main");
    expect(headers.get("x-domain")).toBe("www.codebuddy.ai");
    expect(init.redirect).toBe("error");
    rmSync(dir, { recursive: true, force: true });
    await server.app.close();
  });

  it("diagnoses a refused large request without repeating generation or trying fallback models", async () => {
    const { server, store, dir } = await buildProviderServer([{
      name: "workbuddy", ccr_managed: true, api_base_url: CHAT_URL,
      api_key: "ccr-managed-workbuddy", models: ["glm-5.3"], transformer: { use: ["workbuddy"] },
    }, {
      name: "fallback-provider", api_base_url: "https://fallback.example/v1/chat/completions",
      api_key: "fallback-key", models: ["backup"],
    }], { enableFallback: true, default: "workbuddy,glm-5.3", fallback: { default: ["fallback-provider,backup"] } });
    await store.save(CRED);
    let generations = 0;
    const fetchMock = vi.fn(async (url: any, init: any) => {
      if (String(url).endsWith("/chat/completions")) {
        generations++;
        throw Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
      }
      expect(String(url)).toBe("https://copilot.tencent.com/billing/meter/get-user-resource-summary");
      expect(init.body).toBe("{}");
      expect(init.redirect).toBe("error");
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return new Response("denied", { status: 401 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await server.app.inject({ method: "POST", url: "/v1/chat/completions", payload: {
      model: "workbuddy,glm-5.3", stream: false,
      messages: [{ role: "user", content: "x".repeat(2 * 1024 * 1024 + 1) }],
    } });
    expect(res.statusCode).toBe(401);
    expect(res.body).toContain("workbuddy_reauth");
    expect(res.body).not.toContain(TOKEN);
    expect(generations).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.some(([url]: any) => String(url).includes("fallback.example"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
    await server.app.close();
  });

  it("keeps the single same-model retry for non-terminal WorkBuddy errors (review F1)", async () => {
    const serverRuntime = await buildProviderServer([{
      name: "workbuddy", api_base_url: CHAT_URL, api_key: "ccr-managed-workbuddy",
      models: ["glm-5.3"], transformer: { use: ["workbuddy"] }, ccr_managed: true,
    }]);
    const { store, dir } = serverRuntime;
    await store.save(CRED);
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ code: 6004, msg: "频率限制" }), { status: 429, headers: { "Content-Type": "application/json" } });
      }
      return jsonResponse({ choices: [{ message: { role: "assistant", content: "ok" } }] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await serverRuntime.server.app.inject({
      method: "POST", url: "/v1/chat/completions",
      payload: { model: "workbuddy,glm-5.3", messages: [{ role: "user", content: "hi" }], stream: false },
    });
    expect(res.statusCode).toBe(200);
    expect(calls).toBe(2);
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

  it("aggregates upstream SSE into JSON for a non-stream client (real pipeline)", async () => {
    const serverRuntime = await buildProviderServer([{
      name: "workbuddy", api_base_url: CHAT_URL, api_key: "ccr-managed-workbuddy",
      models: ["glm-5.3"], transformer: { use: ["workbuddy"] }, ccr_managed: true,
    }]);
    const { store, dir } = serverRuntime;
    await store.save(CRED);
    const fetchMock = vi.fn(async () => sseResponse([
      "data: {\"id\":\"c1\",\"created\":1700000000,\"model\":\"glm-5.3\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\"}}]}\n\n",
      "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"你好\"}}]}\n\n",
      "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\" world\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2,\"total_tokens\":5}}\n\n",
      "data: [DONE]\n\n",
    ]));
    vi.stubGlobal("fetch", fetchMock);

    const res = await serverRuntime.server.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "workbuddy,glm-5.3", messages: [{ role: "user", content: "hi" }], stream: false },
    });

    expect(res.statusCode).toBe(200);
    // Contract §13 Q1: the upstream is always asked for a stream...
    const sent = JSON.parse((fetchMock.mock.calls[0] as any)[1].body);
    expect(sent.stream).toBe(true);
    // ...but the non-stream client receives ONE aggregated JSON completion,
    // never raw SSE.
    expect(res.headers["content-type"]).toContain("application/json");
    const json = res.json();
    expect(json.object).toBe("chat.completion");
    expect(json.choices[0].message.content).toBe("你好 world");
    expect(json.usage.total_tokens).toBe(5);
    expect(res.body).not.toContain("data:");
    rmSync(dir, { recursive: true, force: true });
  });

  it("aggregates then converts to an Anthropic message on /v1/messages (non-stream)", async () => {
    // Claude Code's primary entry point: an Anthropic non-stream client must
    // receive one valid Anthropic message JSON, never raw SSE.
    const dir = mkdtempSync(join(tmpdir(), "wb-msg-"));
    const store = new WorkBuddyCredentialStore(join(dir, "creds.json"));
    await store.save(CRED);
    const providers = [{
      name: "workbuddy", api_base_url: CHAT_URL, api_key: "ccr-managed-workbuddy",
      models: ["glm-5.3"], transformer: { use: ["workbuddy"] }, ccr_managed: true,
    }];
    const server = new Server({
      logger: false, useJsonFile: false,
      initialConfig: { providers, Router: { default: "workbuddy,glm-5.3" }, HOST: "127.0.0.1", PORT: 0 },
    });
    await server.ready();
    await registerAdminRoutes(server, { PORT: 0, Providers: providers, Router: {} });
    await server.registerNamespace("/");
    await server.app.ready();
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
    vi.spyOn(configModule, "readConfigFileRaw").mockResolvedValue({ Providers: providers, Router: {} });

    const fetchMock = vi.fn(async () => sseResponse([
      "data: {\"id\":\"c1\",\"created\":1700000000,\"model\":\"glm-5.3\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\"}}]}\n\n",
      "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Hello from WorkBuddy\"}}]}\n\n",
      "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":4,\"total_tokens\":7}}\n\n",
      "data: [DONE]\n\n",
    ]));
    vi.stubGlobal("fetch", fetchMock);

    const res = await server.app.inject({
      method: "POST",
      url: "/v1/messages",
      payload: { model: "workbuddy,glm-5.3", max_tokens: 100, stream: false, messages: [{ role: "user", content: "hi" }] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    const json = res.json();
    expect(json.type).toBe("message");
    expect(json.role).toBe("assistant");
    expect(json.content).toEqual([{ type: "text", text: "Hello from WorkBuddy" }]);
    expect(json.stop_reason).toBe("end_turn");
    expect(json.usage.input_tokens).toBe(3);
    expect(json.usage.output_tokens).toBe(4);
    // No raw SSE frames leak to an Anthropic client.
    expect(res.body).not.toContain("data:");
    rmSync(dir, { recursive: true, force: true });
  });

  it("restores client tool names end-to-end (shared transformer context)", async () => {
    const serverRuntime = await buildProviderServer([{
      name: "workbuddy", api_base_url: CHAT_URL, api_key: "ccr-managed-workbuddy",
      models: ["glm-5.3"], transformer: { use: ["workbuddy"] }, ccr_managed: true,
    }]);
    const { store, dir } = serverRuntime;
    await store.save(CRED);
    const fetchMock = vi.fn(async () => sseResponse([
      "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{\\\"p\\\":1}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
      "data: [DONE]\n\n",
    ]));
    vi.stubGlobal("fetch", fetchMock);

    const res = await serverRuntime.server.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "workbuddy,glm-5.3",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
        tools: [{ type: "function", function: { name: "read.file", description: "r", parameters: { type: "object", properties: {} } } }],
        tool_choice: { type: "function", function: { name: "read.file" } },
      },
    });

    expect(res.statusCode).toBe(200);
    // The upstream saw the SAFE (renamed) tool...
    const sent = JSON.parse((fetchMock.mock.calls[0] as any)[1].body);
    expect(sent.tools[0].function.name).toBe("read_file");
    expect(sent.tool_choice).toBe("read_file");
    // ...and the client gets its ORIGINAL name back in the aggregated JSON —
    // only possible when the request- and response-phase transformers of one
    // request share a single context object.
    const json = res.json();
    expect(json.choices[0].message.tool_calls[0].function.name).toBe("read.file");
    expect(json.choices[0].message.tool_calls[0].function.arguments).toBe("{\"p\":1}");
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
      readSource: (site) => {
        try { return parseWorkBuddySource(readFileSync(join(dir, "src.info"), "utf8"), Date.now(), site); }
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
    const res = await server.app.inject({ method: "GET", url: "http://localhost:3456/api/workbuddy/status" });
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
    const res = await server.app.inject({ method: "POST", url: "http://localhost:3456/api/workbuddy/import", payload: {} });
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

    const res = await server.app.inject({ method: "POST", url: "http://localhost:3456/api/workbuddy/import", payload: {} });
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

  it("imports an explicitly selected international account and guards usage without reading source", async () => {
    const config: any = { PORT: 3456, Providers: [], Router: { default: "other,m" } };
    const { server, service, store } = await build(config, SOURCE);
    stubConfig(config);
    const sourceSpy = vi.spyOn((service as any).options, "readSource");
    const fetchMock = vi.fn(async (url: any, init: any) => {
      expect(String(url).startsWith("https://www.workbuddy.ai/")).toBe(true);
      expect(init.redirect).toBe("error");
      if (String(url).endsWith("/v3/config")) return jsonResponse({ code: 0, data: {
        agents: [{ name: "cli", models: ["glm-5.3"] }], models: [{ id: "glm-5.3", supportsImages: true }],
      } }, String(url));
      return jsonResponse({ code: 0, data: { IsPaidUser: true, Packages: [{ CycleUsedCapacity: "2", CycleTotalCapacity: "20" }] } }, String(url));
    });
    vi.stubGlobal("fetch", fetchMock);
    const imported = await server.app.inject({ method: "POST", url: "http://localhost:3456/api/workbuddy/import", payload: { site: "workbuddy-ai" } });
    expect(imported.statusCode).toBe(200);
    expect(sourceSpy).toHaveBeenCalledWith("workbuddy-ai");
    expect((await store.load())?.kind).toBe("workbuddy-ai");
    expect(config.Providers[0].api_base_url).toBe("https://www.workbuddy.ai/v2/chat/completions");
    expect(config.Router).toEqual({ default: "other,m" });
    sourceSpy.mockClear();
    const status = await server.app.inject({ method: "GET", url: "http://localhost:3456/api/workbuddy/status" });
    expect(status.json()).toMatchObject({ kind: "workbuddy-ai", renewalMode: "desktop", imagesUnsupportedModels: ["glm-5.3"] });
    expect(sourceSpy).not.toHaveBeenCalled();
    const usage = await server.app.inject({ method: "GET", url: "http://localhost:3456/api/workbuddy/usage" });
    expect(usage.json()).toEqual({ usage: { plan: "Pro", used: 2, limit: 20, unit: "credits" } });
    expect(usage.body).not.toContain(TOKEN);
    const remote = await server.app.inject({ method: "GET", remoteAddress: "203.0.113.9", url: "http://localhost:3456/api/workbuddy/usage" });
    expect(remote.statusCode).toBe(403);
    const invalid = await server.app.inject({ method: "POST", url: "http://localhost:3456/api/workbuddy/import", payload: { site: "https://evil.example" } });
    expect(invalid.statusCode).toBe(422);
    expect(sourceSpy).not.toHaveBeenCalled();
  });

  it("POST /api/workbuddy/sync returns 409 when not connected", async () => {
    const config = { Providers: [], Router: {} };
    const { server } = await build(config, null);
    stubConfig(config);
    const res = await server.app.inject({ method: "POST", url: "http://localhost:3456/api/workbuddy/sync", payload: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ success: false, error: "workbuddy_not_connected" });
  });

  it("POST /api/workbuddy/import returns 409 for a plain same-name provider and writes nothing", async () => {
    const config = { Providers: [{ name: "workbuddy", api_base_url: "https://x/v1", api_key: "k", models: ["m"] }], Router: {} };
    const { server } = await build(config, SOURCE);
    stubConfig(config);
    vi.stubGlobal("fetch", vi.fn(async () => envOk()));
    const res = await server.app.inject({ method: "POST", url: "http://localhost:3456/api/workbuddy/import", payload: {} });
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
    const res = await server.app.inject({ method: "POST", url: "http://localhost:3456/api/workbuddy/disconnect", payload: {} });
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
      url: "http://localhost:3456/api/workbuddy/status",
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
      url: "http://localhost:3456/api/workbuddy/status",
      remoteAddress: "127.0.0.1",
    });
    expect(res.statusCode).toBe(200);
  });

  it("rejects hostile local browser origins, malformed origins and rebound Host on status", async () => {
    const { server, service } = await build({ PORT: 3456, Providers: [], Router: {} }, SOURCE);
    const importSpy = vi.spyOn(service, "importFromLocalDesktop");
    for (const origin of ["http://evil.example:3456", "null", "http://", "http://localhost:9999"]) {
      const res = await server.app.inject({ method: "POST", url: "http://localhost:3456/api/workbuddy/import",
        remoteAddress: "127.0.0.1", headers: { origin }, payload: {} });
      expect(res.statusCode).toBe(403);
    }
    expect(importSpy).not.toHaveBeenCalled();
    const rebound = await server.app.inject({ method: "GET", url: "http://evil.example:3456/api/workbuddy/status", remoteAddress: "127.0.0.1" });
    expect(rebound.statusCode).toBe(403);
  });

  it("uses the live listening port for browser management with PORT zero", async () => {
    const { server } = await build({ PORT: 0, Providers: [], Router: {} }, null);
    try {
      await server.app.listen({ host: "127.0.0.1", port: 0 });
      const address = server.app.server.address() as { port: number };
      const res = await server.app.inject({ method: "GET", url: "http://localhost:" + address.port + "/api/workbuddy/status",
        remoteAddress: "::1", headers: { origin: "http://[::1]:" + address.port } });
      expect(res.statusCode).toBe(200);
    } finally { await server.app.close(); }
  });

  it("allows the same local browser origin", async () => {
    const config = { PORT: 3456, APIKEY: "secret", Providers: [], Router: {} };
    const { server } = await build(config, null);
    stubConfig(config);
    const res = await server.app.inject({
      method: "GET",
      url: "http://localhost:3456/api/workbuddy/status",
      remoteAddress: "127.0.0.1",
      headers: { origin: "http://127.0.0.1:3456" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("rejects a remote caller that spoofs X-Forwarded-Host to match its Origin", async () => {
    const config = { PORT: 3456, APIKEY: "secret", Providers: [], Router: {} };
    const { server } = await build(config, null);
    stubConfig(config);
    const res = await server.app.inject({
      method: "GET",
      url: "http://localhost:3456/api/workbuddy/status",
      remoteAddress: "203.0.113.9",
      headers: { origin: "http://evil.example:3456", "x-forwarded-host": "evil.example:3456" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "workbuddy_unauthorized" });
  });

  it("rejects a remote caller that spoofs a loopback Origin", async () => {
    const config = { PORT: 3456, APIKEY: "secret", Providers: [], Router: {} };
    const { server } = await build(config, null);
    stubConfig(config);
    const res = await server.app.inject({
      method: "POST",
      url: "http://localhost:3456/api/workbuddy/import",
      remoteAddress: "10.1.2.3",
      headers: { origin: "http://127.0.0.1:3456" },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "workbuddy_unauthorized" });
  });

  it("re-locks a managed WorkBuddy entry rewritten by a generic config save", async () => {
    const config = {
      PORT: 3456, APIKEY: "secret",
      Providers: [
        { name: "workbuddy", ccr_managed: true, workbuddy_kind: "workbuddy", api_base_url: CHAT_URL, api_key: "ccr-managed-workbuddy", models: ["glm-5.3"], transformer: { use: ["workbuddy"] }, enabled: true },
        { name: "other", api_base_url: "https://x/v1", api_key: "k", models: ["m"] },
      ],
      Router: { default: "other,m" },
    };
    const { server } = await build(config, null);
    stubConfig(config);
    // POST /api/config reads the previous config through readConfigFile.
    vi.spyOn(configModule, "readConfigFile").mockResolvedValue(JSON.parse(JSON.stringify(config)));

    const hostile = JSON.parse(JSON.stringify(config));
    hostile.Providers[0].api_base_url = "https://evil.example/v1/chat/completions";
    hostile.Providers[0].api_key = "attacker-value";
    hostile.Providers[0].transformer = { use: ["openai"] };
    hostile.Providers[0].ccr_managed = false;

    const res = await server.app.inject({
      method: "POST",
      url: "/api/config",
      remoteAddress: "127.0.0.1",
      payload: hostile,
    });
    expect(res.statusCode).toBe(200);

    // The persisted managed entry is re-locked to the fixed identity.
    const managed: any = config.Providers.find((p: any) => p.name === "workbuddy");
    expect(managed.api_base_url).toBe(CHAT_URL);
    expect(managed.api_key).toBe("ccr-managed-workbuddy");
    expect(managed.transformer).toEqual({ use: ["workbuddy"] });
    expect(managed.ccr_managed).toBe(true);
    // Router untouched; ordinary providers untouched.
    expect(config.Router).toEqual({ default: "other,m" });
    expect(config.Providers.find((p: any) => p.name === "other")).toMatchObject({ api_base_url: "https://x/v1", api_key: "k" });
  });
});
