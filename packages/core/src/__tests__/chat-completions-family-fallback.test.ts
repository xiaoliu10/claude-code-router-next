import { CCR_SELF_PROVIDER_NAME } from "@wengine-ai/claude-code-router-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Server from "../server";
import { createCcrPreHandlerCallbacks, registerRequestPipeline } from "../ccr/request-pipeline";
import { getHealthStore } from "../services/provider-health";
import { resetFallbackPromotionStore } from "../utils/fallback-promotion";
import type { RouterFallbackConfig } from "../utils/router";

const CHAT = "/v1/chat/completions";
const API_KEY = "test-key";
const messages = [{ role: "user", content: "hello" }];
const providers = [
  { name: "primary", models: ["opus-model", "sonnet-model", "haiku-model", "extended-model", "direct-model", "default-model"] },
  { name: "family", models: ["family-first", "family-second"] },
  { name: "global", models: ["global-first", "global-second"] },
].map((provider) => ({
  ...provider,
  api_base_url: `https://${provider.name}.example.com${CHAT}`,
  api_key: API_KEY,
}));

// Mirror the CLI-managed preset with an example.com URL so accidental self-dispatch is observable.
const selfProvider = {
  name: CCR_SELF_PROVIDER_NAME,
  ccr_managed: true,
  api_base_url: "https://ccr.example.com/v1/messages",
  api_key: API_KEY,
  models: ["ccr-opus", "ccr-sonnet", "ccr-haiku"],
  transformer: { use: ["Anthropic"] },
};

const router = {
  enableFamilyRouting: true,
  enableFallback: true,
  default: "primary,default-model",
  families: {
    opus: { default: "primary,opus-model", extendedContext: "primary,extended-model" },
    sonnet: { default: "primary,sonnet-model" },
    haiku: { default: "primary,haiku-model" },
  },
};

const globalFallback = { default: ["global,global-second"] };
const serverInstances: Server[] = [];

type RouterOverrides = {
  default?: string;
  enableFallback?: boolean;
  fallback?: RouterFallbackConfig;
  families?: typeof router.families & { opus: { fallback?: RouterFallbackConfig } };
};

async function buildServer({
  routerOverrides,
  fallback,
  includeSelfProvider = false,
}: { routerOverrides?: RouterOverrides; fallback?: RouterFallbackConfig; includeSelfProvider?: boolean } = {}) {
  const config = {
    APIKEY: API_KEY,
    providers: includeSelfProvider ? [...providers, selfProvider] : providers,
    Router: { ...router, ...routerOverrides },
    fallback,
  };
  const server = new Server({ logger: false, useJsonFile: false, initialConfig: config });
  serverInstances.push(server);
  await server.ready();
  registerRequestPipeline(server, config);
  server.ccrPreHandlerCallbacks = createCcrPreHandlerCallbacks(config);
  await server.registerNamespace("/");
  return server;
}

function upstreamError(status: number, code: string, message: string) {
  return { status, body: { error: { code, message } } };
}

const unavailable = upstreamError(503, "service_unavailable", "upstream unavailable");
const rateLimited = upstreamError(429, "rate_limit_exceeded", "too many requests");
const callerError = upstreamError(400, "invalid_request_error", "invalid request parameter");
const channelDisabled = upstreamError(403, "channel_disabled", "channel is disabled");

function mockUpstreams(failures: Record<string, ReturnType<typeof upstreamError>> = {}) {
  const attempts: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: URL | string, init?: RequestInit) => {
    const url = new URL(input);
    const { model } = JSON.parse(String(init?.body));
    attempts.push(`${url.hostname}/${model}`);
    expect(providers.some((provider) => provider.api_base_url === url.href)).toBe(true);
    const failure = failures[model];
    if (failure) return Response.json(failure.body, { status: failure.status });
    return Response.json({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 1700000000,
      model,
      choices: [{ index: 0, message: { role: "assistant", content: `reply from ${model}` }, finish_reason: "stop" }],
      usage: { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 },
    });
  }));
  return attempts;
}

function sendChat(server: Server, model: string) {
  return server.app.inject({ method: "POST", url: CHAT, payload: { model, messages, stream: false } });
}

beforeEach(() => {
  getHealthStore().clear();
  resetFallbackPromotionStore();
});

afterEach(async () => {
  try {
    for (const server of serverInstances.splice(0)) await server.app.close();
  } finally {
    vi.unstubAllGlobals();
    getHealthStore().clear();
    resetFallbackPromotionStore();
  }
});

describe("/v1/chat/completions family routing and fallback", () => {
  it.each([
    ["ccr-opus", "opus-model"],
    ["ccr-sonnet", "sonnet-model"],
    ["ccr-haiku", "haiku-model"],
    ["ccr-opus[1m]", "extended-model"],
  ])("routes %s to %s", async (alias, model) => {
    const attempts = mockUpstreams();
    const server = await buildServer({ includeSelfProvider: true });
    const response = await sendChat(server, alias);

    expect(attempts).toEqual([`primary.example.com/${model}`]);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ model, choices: [{ message: { content: `reply from ${model}` } }] });
  });

  it("returns 404 without dispatching an unresolved alias to the managed self provider", async () => {
    const attempts = mockUpstreams();
    const server = await buildServer({
      includeSelfProvider: true,
      routerOverrides: { default: "", families: { ...router.families, opus: { default: "primary,missing-model" } } },
    });
    const response = await sendChat(server, "ccr-opus");

    expect(attempts).toEqual([]);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: "provider_not_found" } });
  });

  it("retries the primary but skips configured family and global fallbacks when disabled", async () => {
    const attempts = mockUpstreams({ "opus-model": unavailable });
    const server = await buildServer({
      routerOverrides: {
        enableFallback: false,
        families: {
          ...router.families,
          opus: { ...router.families.opus, fallback: { default: ["family,family-first"] } },
        },
        fallback: globalFallback,
      },
    });
    const response = await sendChat(server, "ccr-opus");

    expect(attempts).toEqual(["primary.example.com/opus-model", "primary.example.com/opus-model"]);
    expect(response.statusCode).toBe(unavailable.status);
    expect(response.json()).toEqual(unavailable.body);
  });

  it("retries family entries before global entries and deduplicates across the chain", async () => {
    const attempts = mockUpstreams({
      "opus-model": unavailable,
      "family-first": unavailable,
      "family-second": rateLimited,
      "global-first": unavailable,
    });
    const server = await buildServer({
      routerOverrides: {
        families: {
          ...router.families,
          opus: {
            ...router.families.opus,
            fallback: { default: ["primary,opus-model", "family,family-first", "family, family-first", "family,family-second"] },
          },
        },
        fallback: { default: ["family,family-second", "global,global-first", "global,global-second"] },
      },
    });
    const response = await sendChat(server, "ccr-opus");

    expect(attempts).toEqual([
      "primary.example.com/opus-model", "primary.example.com/opus-model",
      "family.example.com/family-first", "family.example.com/family-first",
      "family.example.com/family-second", "family.example.com/family-second",
      "global.example.com/global-first", "global.example.com/global-first",
      "global.example.com/global-second",
    ]);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ model: "global-second", choices: [{ message: { content: "reply from global-second" } }] });
  });

  describe.each(["primary,direct-model", "direct-model"])("direct chat model %s", (model) => {
    it.each([
      { location: "Router.fallback", routerOverrides: { fallback: globalFallback }, topLevelFallback: undefined, failure: unavailable },
      { location: "top-level fallback", routerOverrides: {}, topLevelFallback: globalFallback, failure: rateLimited },
    ])("retries HTTP $failure.status then uses $location", async ({ routerOverrides, topLevelFallback, failure }) => {
      const attempts = mockUpstreams({ "direct-model": failure });
      const response = await sendChat(await buildServer({ routerOverrides, fallback: topLevelFallback }), model);

      expect(attempts).toEqual([
        "primary.example.com/direct-model", "primary.example.com/direct-model", "global.example.com/global-second",
      ]);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ model: "global-second", choices: [{ message: { content: "reply from global-second" } }] });
    });
  });

  it.each([callerError, channelDisabled])("returns primary HTTP $status without retry or fallback", async (failure) => {
    const attempts = mockUpstreams({ "direct-model": failure });
    const response = await sendChat(await buildServer({ fallback: globalFallback }), "primary,direct-model");

    expect(attempts).toEqual(["primary.example.com/direct-model"]);
    expect(response.statusCode).toBe(failure.status);
    expect(response.json()).toEqual(failure.body);
  });

  it("returns a terminal fallback error without replaying the fallback chain", async () => {
    const attempts = mockUpstreams({ "direct-model": unavailable, "global-first": callerError });
    const server = await buildServer({ fallback: { default: ["global,global-first", "global,global-second"] } });
    const response = await sendChat(server, "direct-model");

    expect(attempts).toEqual([
      "primary.example.com/direct-model", "primary.example.com/direct-model", "global.example.com/global-first",
    ]);
    expect(response.statusCode).toBe(callerError.status);
    expect(response.json()).toEqual(callerError.body);
  });
});

describe("existing family fallback endpoints", () => {
  it.each([
    {
      url: "/v1/messages",
      payload: { messages, max_tokens: 64 },
      responseBody: { type: "message", content: [{ type: "text", text: "reply from family-first" }] },
    },
    {
      url: "/v1/responses",
      payload: { input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }] },
      responseBody: { object: "response", output: [{ type: "message", content: [{ type: "output_text", text: "reply from family-first" }] }] },
    },
  ])("keeps family fallback and native response formatting on $url", async ({ url, payload, responseBody }) => {
    const attempts = mockUpstreams({ "opus-model": callerError });
    const server = await buildServer({
      routerOverrides: {
        families: {
          ...router.families,
          opus: { ...router.families.opus, fallback: { default: ["family,family-first"] } },
        },
      },
    });
    const response = await server.app.inject({
      method: "POST",
      url,
      payload: { model: "ccr-opus", stream: false, ...payload },
    });

    expect(attempts).toEqual(["primary.example.com/opus-model", "primary.example.com/opus-model", "family.example.com/family-first"]);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ model: "family-first", ...responseBody });
  });
});
