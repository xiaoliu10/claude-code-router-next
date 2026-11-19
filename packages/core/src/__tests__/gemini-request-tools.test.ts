import { describe, expect, it, vi } from "vitest";
import { normalizeResponsesBody } from "../api/routes";
import Server from "../server";
import { AnthropicTransformer } from "../transformer/anthropic.transformer";
import { buildRequestBody } from "../utils/gemini.util";

const searchSchema = {
  type: "object", properties: { terms: { type: "array", items: { type: "string" } } }, required: ["terms"],
};
const pathSchema = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
const search = { type: "function", name: "web_search", description: "Search my index", parameters: searchSchema };
const read = { type: "function", name: "read_file", description: "Read a file", parameters: pathSchema };
const builtin = { type: "web_search" };
const searchDeclaration = { name: search.name, description: search.description, parametersJsonSchema: searchSchema };
const readDeclaration = { name: read.name, description: read.description, parametersJsonSchema: pathSchema };
const mixedConfig = { includeServerSideToolInvocations: true, functionCallingConfig: { mode: "VALIDATED" } };

function responses(tools: unknown[], tool_choice?: unknown) {
  const body: any = { model: "gemini", input: [{ role: "user", content: "hi" }], tools, tool_choice };
  normalizeResponsesBody(body);
  return buildRequestBody(body);
}

describe("Gemini request tool ownership", () => {
  it("keeps both client function schemas, including a function named web_search", () => {
    const body = responses([search, read]);
    expect(body.tools).toEqual([{ functionDeclarations: [searchDeclaration, readDeclaration] }]);
    expect(body.toolConfig).toBeUndefined();
    expect(responses([search, read], "auto").toolConfig).toEqual({ functionCallingConfig: { mode: "AUTO" } });
  });

  it.each([undefined, "auto"])("converts only explicit builtin search for choice %s", choice => {
    const body = responses([builtin], choice);
    expect(body.tools).toEqual([{ googleSearch: {} }]);
    expect(body.toolConfig).toBeUndefined();
    const mixed = responses([builtin, read], choice);
    expect(mixed.tools).toEqual([{ functionDeclarations: [readDeclaration] }, { googleSearch: {} }]);
    expect(mixed.toolConfig).toEqual(mixedConfig);
  });

  it.each([
    ["none", { mode: "NONE" }],
    ["required", { mode: "ANY" }],
    [{ type: "function", name: "web_search" }, { mode: "ANY", allowedFunctionNames: ["web_search"] }],
  ])("honors restrictive choices without enabling independent builtin search", (choice, config) => {
    const body = responses([builtin, search, read], choice);
    expect(body.tools).toEqual([{ functionDeclarations: [searchDeclaration, readDeclaration] }]);
    expect(body.toolConfig).toEqual({ functionCallingConfig: config });
  });

  it("omits the builtin entirely when tool use is disabled", () => {
    const body = responses([builtin], "none");
    expect(body.tools).toBeUndefined();
    expect(body.toolConfig).toBeUndefined();
  });

  it.each(["required", { type: "function", name: "web_search" }, { type: "web_search" }])(
    "rejects a forced builtin choice locally", choice => {
      expect(() => responses([builtin], choice)).toThrow(expect.objectContaining({ statusCode: 400, code: "invalid_gemini_tool_choice" }));
    },
  );

  it("recognizes Anthropic's dated builtin, custom input_schema and any/named choices", async () => {
    const anthropic = new AnthropicTransformer();
    const request = { model: "gemini", messages: [], tools: [
      { type: "web_search_20250305", name: "web_search" },
      { name: search.name, description: search.description, input_schema: searchSchema },
      { name: read.name, description: read.description, input_schema: pathSchema },
    ] };
    const body = buildRequestBody(await anthropic.transformRequestOut(request));
    expect(body.tools).toEqual([{ functionDeclarations: [searchDeclaration, readDeclaration] }, { googleSearch: {} }]);
    expect(body.toolConfig).toEqual(mixedConfig);
    for (const choice of [{ type: "any" }, { type: "tool", name: read.name }]) {
      const forced = buildRequestBody(await anthropic.transformRequestOut({ ...request, tool_choice: choice }));
      expect(forced.tools).toEqual([{ functionDeclarations: [searchDeclaration, readDeclaration] }]);
      expect(forced.toolConfig.functionCallingConfig).toEqual(choice.name
        ? { mode: "ANY", allowedFunctionNames: [read.name] } : { mode: "ANY" });
    }
  });

  it("retains Responses ownership through routing and emits clean JSON for chat providers", async () => {
    const captured: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url, options) => {
      captured.push(JSON.parse(options.body));
      if (String(url).startsWith("https://gemini.invalid/")) {
        return Response.json({ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] });
      }
      return Response.json({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] });
    }));
    const server = new Server({ logger: false, useJsonFile: false, initialConfig: {
      ACTIVE_PROBE_ENABLED: false,
      providers: [
        { name: "gemini-fixture", api_base_url: "https://gemini.invalid/models/", api_key: "fixture", models: ["gemini-test"], transformer: { use: ["gemini"] } },
        { name: "chat-fixture", api_base_url: "https://chat.invalid/v1/chat/completions", api_key: "fixture", models: ["chat-test"] },
      ],
    } });
    try {
      await server.registerNamespace("/");
      for (const model of ["gemini-fixture,gemini-test", "chat-fixture,chat-test"]) {
        const result = await server.app.inject({ method: "POST", url: "/v1/responses", payload: {
          model, input: [{ role: "user", content: "hi" }], tools: [builtin, search, read],
        } });
        expect(result.statusCode, result.payload).toBe(200);
      }
      expect(captured).toHaveLength(2);
      expect(captured[0].tools).toEqual([{ functionDeclarations: [searchDeclaration, readDeclaration] }, { googleSearch: {} }]);
      expect(captured[0].toolConfig).toEqual(mixedConfig);
      expect(captured[1].tools[0]).toEqual({ type: "function", function: {
        name: "web_search", description: "Search the web", parameters: { type: "object", properties: { query: { type: "string" } } },
      } });
      const invalid = await server.app.inject({ method: "POST", url: "/v1/responses", payload: {
        model: "gemini-fixture,gemini-test", input: [{ role: "user", content: "hi" }], tools: [builtin], tool_choice: { type: "web_search" },
      } });
      expect(invalid.statusCode).toBe(400);
      expect(captured).toHaveLength(2);
      // The same deterministic validation error also terminates an existing fallback chain.
      server.configService.set("Router", { enableFallback: true });
      server.configService.set("fallback", { default: ["gemini-fixture,gemini-test", "chat-fixture,chat-test"] });
      const fetchMock = vi.mocked(fetch);
      fetchMock.mockClear();
      fetchMock.mockImplementation(async () => Response.json({error:{message:"fixture failure"}}, {status:503}));
      const fallback = await server.app.inject({ method: "POST", url: "/v1/responses", payload: {
        model: "chat-fixture,chat-test", input: [{ role: "user", content: "hi" }], tools: [builtin], tool_choice: { type: "web_search" },
      } });
      expect(fallback.statusCode).toBe(400);
      expect(fallback.body).toContain("invalid_gemini_tool_choice");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      await server.app.close();
      vi.unstubAllGlobals();
    }
  });
});
