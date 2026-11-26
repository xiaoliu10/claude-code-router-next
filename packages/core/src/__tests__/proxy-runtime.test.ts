import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Server from "../server";
import { registerRequestPipeline, createCcrPreHandlerCallbacks } from "../ccr/request-pipeline";
import { registerAdminRoutes } from "../ccr/admin-routes";
import { sessionUsageCache } from "../utils/cache";
import { closeProxyDispatchers } from "../services/proxy";

// End-to-end check that the main request path honours the per-provider proxy
// policy: sendRequestToProvider -> sendUnifiedRequest -> getProxyDispatcher.
// fetch is stubbed so no real network connection (or proxy) is opened.
async function buildRuntime(overrides: Record<string, any> = {}) {
  const config = {
    PORT: 0,
    APIKEY: "secret",
    PROXY_URL: "http://127.0.0.1:9",
    Providers: [
      {
        name: "demo",
        api_base_url: "https://upstream.example/v1/messages",
        api_key: "demo-key",
        models: ["default"],
      },
    ],
    Router: {
      enableFamilyRouting: true,
      families: { opus: { default: "demo,default" } },
    },
    ...overrides,
  };

  const initialConfig: Record<string, any> = {
    providers: config.Providers,
    Router: config.Router,
    HOST: "127.0.0.1",
    PORT: 0,
  };
  if (config.PROXY_URL !== undefined) initialConfig.PROXY_URL = config.PROXY_URL;
  if (config.PROXY_GLOBAL_ENABLED !== undefined) {
    initialConfig.PROXY_GLOBAL_ENABLED = config.PROXY_GLOBAL_ENABLED;
  }

  const server = new Server({ logger: false, useJsonFile: false, initialConfig });
  await server.ready();
  await registerAdminRoutes(server, config);
  registerRequestPipeline(server, config);
  server.ccrPreHandlerCallbacks = createCcrPreHandlerCallbacks(config);
  await server.registerNamespace("/");
  await server.app.ready();
  return { server, config };
}

const proxiedFetch = vi.hoisted(() => vi.fn());
vi.mock("undici", async (load) => ({ ...await load<typeof import("undici")>(), fetch: proxiedFetch }));

function nonStreamResponse() {
  return new Response(JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1700000000,
    model: "default",
    choices: [{
      index: 0,
      message: { role: "assistant", content: "ok" },
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("provider-level proxy on the request path", () => {
  let originalFetch: typeof globalThis.fetch;
  let dispatchers: unknown[];

  beforeEach(() => {
    proxiedFetch.mockReset().mockImplementation(async (_url, init) => {
      expect(init.dispatcher?.constructor.name).toBe("ProxyAgent");
      dispatchers.push(init.dispatcher);
      return nonStreamResponse();
    });
    originalFetch = globalThis.fetch;
    dispatchers = [];
    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      dispatchers.push(init?.dispatcher);
      return nonStreamResponse();
    }) as any;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    sessionUsageCache.delete("claude-code:session:proxy-session");
    await closeProxyDispatchers();
  });

  async function sendRequest(server: Server) {
    const response = await server.app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-anthropic-billing-header": "cc_version=9.9" },
      payload: {
        model: "ccr-opus",
        messages: [{ role: "user", content: "hello" }],
        metadata: { user_id: "user_x_session_proxy-session" },
        stream: false,
      },
    });
    if (dispatchers[0]) expect(proxiedFetch).toHaveBeenCalled();
    return response;
  }

  it("uses the proxy when the provider opts in while the global switch is off", async () => {
    const { server } = await buildRuntime({
      PROXY_GLOBAL_ENABLED: false,
      Providers: [
        {
          name: "demo",
          api_base_url: "https://upstream.example/v1/messages",
          api_key: "demo-key",
          models: ["default"],
          proxy_enabled: true,
        },
      ],
    });
    try {
      const res = await sendRequest(server);
      expect(res.statusCode).toBe(200);
      expect(dispatchers.length).toBeGreaterThan(0);
      expect(dispatchers[0]).toBeDefined();
    } finally {
      await server.app.close();
    }
  });

  it("connects directly when the provider has not opted in", async () => {
    const { server } = await buildRuntime({
      PROXY_GLOBAL_ENABLED: false,
      Providers: [
        {
          name: "demo",
          api_base_url: "https://upstream.example/v1/messages",
          api_key: "demo-key",
          models: ["default"],
        },
      ],
    });
    try {
      const res = await sendRequest(server);
      expect(res.statusCode).toBe(200);
      expect(dispatchers.length).toBeGreaterThan(0);
      expect(dispatchers[0]).toBeUndefined();
      expect(proxiedFetch).not.toHaveBeenCalled();
    } finally {
      await server.app.close();
    }
  });

  it("applies the proxy to every provider when the global switch is on (legacy default)", async () => {
    const { server } = await buildRuntime({
      Providers: [
        {
          name: "demo",
          api_base_url: "https://upstream.example/v1/messages",
          api_key: "demo-key",
          models: ["default"],
        },
      ],
    });
    try {
      const res = await sendRequest(server);
      expect(res.statusCode).toBe(200);
      expect(dispatchers.length).toBeGreaterThan(0);
      expect(dispatchers[0]).toBeDefined();
    } finally {
      await server.app.close();
    }
  });

  it("routes the count_tokens API tokenizer through the provider proxy", async () => {
    const { server } = await buildRuntime({
      PROXY_GLOBAL_ENABLED: false,
      Providers: [
        {
          name: "demo",
          api_base_url: "https://upstream.example/v1/messages",
          api_key: "demo-key",
          models: ["default"],
          proxy_enabled: true,
          tokenizer: {
            default: {
              type: "api",
              url: "https://tokenizer.example/count",
              apiKey: "tok-key",
            },
          },
        },
      ],
    });
    try {
      const res = await server.app.inject({
        method: "POST",
        url: "/v1/messages/count_tokens",
        payload: {
          model: "demo,default",
          messages: [{ role: "user", content: "hi" }],
        },
      });
      expect(res.statusCode).toBe(200);
      expect(dispatchers.length).toBeGreaterThan(0);
      expect(dispatchers[0]).toBeDefined();
    } finally {
      await server.app.close();
    }
  });
});
