import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Server from "../server";
import { clearPluginRegistry, makePluginContext } from "../provider-plugins/registry";
import { getHealthStore } from "../services/provider-health";
import type { ManagedRuntime } from "../provider-plugins/types";
import { ensurePluginRequestState, pluginAttemptBudget, rememberPluginFailure } from "../api/plugin-request-state";
import { pluginResponseError } from "../api/plugin-response-error";

const closed: Array<Server> = [];
const logs: string[] = [];
const SECRET = "ya29.DUMMY_ACCESS_TOKEN 1//DUMMY_REFRESH_TOKEN";
const log = { info: (s: string) => logs.push(s), warn: (s: string) => logs.push(s), error: (s: string) => logs.push(s) };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function runtime(): ManagedRuntime {
  return {
    name: "fake", isManaged: (p: any) => p.apiKey === "ccr-managed-fake",
    signRequest: async ({ headers }) => ({ ...headers, Authorization: "Bearer synthetic-access" }),
    classifyError: (status) => ({ code: status === 401 ? "fake_reauth" : "fake_upstream", message: SECRET,
      httpStatus: status >= 400 ? status : 502, retryable: status >= 500 }),
    authRefresh: { forceRefresh: vi.fn(async () => {}) }, suppressDebugLog: true,
  };
}
async function host(rt: ManagedRuntime, fallback = false) {
  const server = new Server({ logger: { level: "debug", stream: { write: (chunk: string) => { logs.push(String(chunk)); } } }, useJsonFile: false, initialConfig: {
    providers: [
      { name: "ordinary", api_base_url: "https://ordinary.invalid/v1/chat/completions", api_key: "synthetic-ordinary", models: ["m"] },
      { name: "sub", api_base_url: "https://sub.invalid/v1/chat/completions", api_key: "ccr-managed-fake", models: ["m", "other"] },
    ], Router: { enableFallback: fallback }, fallback: { default: ["sub,m", "sub,other"] },
  } });
  closed.push(server); await server.ready();
  makePluginContext({ name: "fake", version: "1.0.0", coreApi: "1" }, log, {
    configDir: "/unused-synthetic", readConfig: async () => ({}), writeConfig: async () => {},
    reloadRuntime: async () => {}, getDirectDispatcher: () => undefined,
  }).registerManagedRuntime(rt);
  await server.registerNamespace("/");
  return server;
}
const send = (server: Server, model: string) => server.app.inject({ method: "POST", url: "/v1/chat/completions", payload: {
  model, stream: false, messages: [{ role: "user", content: "hello" }],
} });
beforeEach(() => {
  clearPluginRegistry(); getHealthStore().clear(); logs.length = 0;
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network must be mocked"); }));
});
afterEach(async () => {
  for (const s of closed.splice(0)) await s.app.close();
  clearPluginRegistry(); getHealthStore().clear(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe("plugin response confidentiality and request-wide account budget", () => {
  it("fallback aliases/models share the refresh budget and terminal state", () => {
    const req: any = {}; const rt = runtime(); ensurePluginRequestState(req);
    const first = { ...req }, second = { ...req };
    pluginAttemptBudget(first, rt).refreshUsed = true;
    const error = Object.assign(new Error("reauth"), { nonRetryable: true });
    expect(rememberPluginFailure(first, rt, error)).toBe(true);
    expect(pluginAttemptBudget(second, rt)).toMatchObject({ refreshUsed: true, terminalError: error });
  });

  it("an ordinary primary falling back to repeated plugin 401 uses exactly 2 sends and 1 refresh", async () => {
    const rt = runtime(), server = await host(rt, true); let ordinaryCalls = 0, subCalls = 0;
    vi.spyOn(getHealthStore(), "isAvailable").mockReturnValue(true);
    vi.stubGlobal("fetch", vi.fn(async (url: any) => {
      if (String(url).includes("ordinary.invalid")) { ordinaryCalls++; return json({ error: { message: "ordinary failed" } }, 500); }
      subCalls++; return json({ error: { message: "UNAUTHENTICATED" } }, 401);
    }));
    const response = await send(server, "ordinary,m");
    expect(response.statusCode).toBe(500);
    expect(ordinaryCalls).toBe(2); expect(subCalls).toBe(2);
    expect(rt.authRefresh!.forceRefresh).toHaveBeenCalledTimes(1);
  });

  it.each(["application/json", "text/html", "text/plain"])("malformed HTTP200 %s is a safe failure, never rawBody", async contentType => {
    const rt = runtime(), server = await host(rt);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`upstream dump ${SECRET}`, { status: 200, headers: { "content-type": contentType } })));
    const response = await send(server, "sub,m");
    expect(response.statusCode).toBe(502);
    expect(response.body).toContain("fake_upstream");
    expect(response.body).not.toContain("DUMMY_ACCESS"); expect(response.body).not.toContain("DUMMY_REFRESH");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(logs.join("\n")).not.toContain("DUMMY_ACCESS");
    expect(logs.join("\n")).not.toContain("DUMMY_REFRESH");
  });

  it("body read errors with sensitive messages do not escape the plugin boundary", async () => {
    const rt = runtime(), server = await host(rt);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({
      start(controller) { controller.error(new Error(SECRET)); },
    }), { headers: { "content-type": "application/json" } })));
    const response = await send(server, "sub,m");
    expect(response.statusCode).toBe(502);
    expect(response.body).not.toContain("DUMMY");
    expect(logs.join("\n")).not.toContain("DUMMY");
  });

  it("unclassified and throwing classifiers cannot forward secrets to clients or bookkeeping", async () => {
    const rt = runtime(); rt.noteUpstreamError = vi.fn(async () => {});
    rt.classifyError = () => { throw new Error(SECRET); };
    const error = await pluginResponseError(rt, 200, SECRET, "");
    expect(error.code).toBe("plugin_upstream_error"); expect(error.rawBody).toBeUndefined();
    expect(error.message).not.toContain("DUMMY");
    expect(JSON.stringify((rt.noteUpstreamError as any).mock.calls)).not.toContain("DUMMY");
  });

  it("an explicitly classified error still gets a fixed safe client message", async () => {
    const rt = runtime(); const error = await pluginResponseError(rt, 400, SECRET, "");
    expect(error.code).toBe("fake_upstream"); expect(error.message).not.toContain("DUMMY");
    expect(error.rawBody).toBeUndefined(); expect(error.nonRetryable).toBe(true);
  });
});
