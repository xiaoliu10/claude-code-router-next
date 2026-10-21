/**
 * Gemini OAuth (Antigravity) data-plane tests — contract §1.1/§1.2/§1.6.
 *
 * Everything upstream is mocked; no real Google endpoint is ever contacted.
 * OAuth constants are only ever exercised through the assembled accessors, and
 * no full client credential literal appears in this file or in src.
 */
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiOauthTransformer } from "../transformer/gemini-oauth.transformer";
import {
  GEMINI_OAUTH_DATA_PLANE,
  GEMINI_OAUTH_SSE_PATH,
  SKIP_THOUGHT_SIGNATURE,
  antigravityEffortFamily,
  antigravitySessionId,
  antigravityUserAgent,
  applyAntigravityQuirks,
  applyThoughtSignatureSentinel,
  buildCodeAssistEnvelope,
  classifyGeminiOauthError,
  collapseAntigravityModels,
  detectClaudeIdentityMarkers,
  dropSecondAnswers,
  extractValidationUrl,
  fixHistoryEdges,
  pairFunctionTurns,
  splitAntigravityId,
  splitResponseTextTurns,
  stripToolNamespace,
  unwrapCodeAssistFrame,
  type GeminiOauthAuthServiceLike,
} from "../services/gemini-oauth";
import type { UnifiedChatRequest } from "../types/llm";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// No test may reach a real upstream.
vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network disabled in test"); }));

const stubService = (): GeminiOauthAuthServiceLike & { tokens: string[] } => {
  const svc: any = {
    tokens: [],
    getAccessToken: async () => "live-access-token",
    getProject: async () => "proj-123",
    noteUpstreamError: async (info: any) => { svc.last = info; },
  };
  return svc;
};

const transformer = () => new GeminiOauthTransformer({ authService: stubService() });

const baseRequest = (over: Partial<UnifiedChatRequest> = {}): UnifiedChatRequest =>
  ({
    model: "gemini-3-flash",
    messages: [
      { role: "user", content: "Hello there" },
    ],
    stream: true,
    ...over,
  }) as UnifiedChatRequest;

const sseResponse = (frames: unknown[], contentType = "text/event-stream"): Response => {
  const body = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "Content-Type": contentType } });
};

const geminiTextChunk = (text: string, extra: any = {}) => ({
  responseId: "resp-1",
  modelVersion: "gemini-3-flash",
  candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP", ...extra }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
});

async function readSseData(res: Response): Promise<any[]> {
  const text = await res.text();
  return text
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => JSON.parse(l.slice(5).trim()));
}

describe("gemini-oauth envelope shape (contract §1.1)", () => {
  it("wraps the Gemini body in the Code Assist envelope with agent fields", async () => {
    const result = await transformer().transformRequestIn(baseRequest(), {} as any, { req: { body: { stream: true } } } as any);
    const envelope = result.body;
    expect(envelope.model).toBe("gemini-3-flash");
    expect(envelope.project).toBe("proj-123");
    expect(envelope.userAgent).toBe("antigravity");
    expect(envelope.requestType).toBe("agent");
    expect(envelope.requestId).toMatch(/^agent-[A-Za-z0-9_-]{16}$/); // 12 bytes base64url
    expect(envelope.request.contents).toEqual([
      { role: "user", parts: [{ text: "Hello there" }] },
    ]);
    expect(typeof envelope.request.sessionId).toBe("string");
  });

  it("derives a stable sessionId from the first user text (SHA-256, first 8 bytes BE, '-' prefix)", async () => {
    const inner = (followUp: string) => ({
      contents: [
        { role: "user", parts: [{ text: "first user message" }] },
        { role: "model", parts: [{ text: "reply" }] },
        { role: "user", parts: [{ text: followUp }] },
      ],
    });
    const a = antigravitySessionId(inner("second turn"));
    const b = antigravitySessionId(inner("third different turn"));
    expect(a).toMatch(/^-\d+$/);
    expect(b).toMatch(/^-\d+$/);
    expect(a).toBe(b); // stable across the turns of one conversation
    const sum = createHash("sha256").update("first user message", "utf8").digest();
    const expected = `-${(sum.readBigUInt64BE(0) & 0x7fffffffffffffffn).toString()}`;
    expect(a).toBe(expected);
    // random fallback only when there is no user text at all
    expect(antigravitySessionId({ contents: [] })).toMatch(/^-\d+$/);
  });

  it("envelope sessionId uses the inner request's first user text", async () => {
    const envelope = buildCodeAssistEnvelope({
      geminiBody: { contents: [{ role: "user", parts: [{ text: "hello" }] }] },
      model: "gemini-3-flash",
      project: "p",
    });
    const sum = createHash("sha256").update("hello", "utf8").digest();
    expect(envelope.request.sessionId).toBe(`-${(sum.readBigUInt64BE(0) & 0x7fffffffffffffffn).toString()}`);
  });
});

describe("gemini-oauth request config: URL + header override order", () => {
  it("targets the fixed data-plane SSE URL and overrides the marker Authorization", async () => {
    const result = await transformer().transformRequestIn(baseRequest(), {} as any, {} as any);
    expect(result.config.url).toBe(`${GEMINI_OAUTH_DATA_PLANE}${GEMINI_OAUTH_SSE_PATH}`);
    expect(result.config.headers.Authorization).toBe("Bearer live-access-token");
    expect(result.config.headers["User-Agent"]).toMatch(/^antigravity\/hub\/\d+\.\d+\.\d+ (darwin|win32|linux)\/(x64|arm64)$/);
    // routes.ts merge order: default first, transformer config spread after → ours wins.
    const merged = { Authorization: "Bearer ccr-managed-gemini-oauth", ...result.config.headers };
    expect(merged.Authorization).toBe("Bearer live-access-token");
    expect(merged.Authorization).not.toContain("ccr-managed-gemini-oauth");
  });

  it("builds the antigravity UA with the documented os/arch mapping and env override", () => {
    expect(antigravityUserAgent()).toBe(`antigravity/hub/2.9.1 ${process.platform === "win32" ? "win32" : process.platform}/${(process.arch as string) === "amd64" ? "x64" : process.arch}`);
    const prev = process.env.GEMINI_OAUTH_ANTIGRAVITY_VERSION;
    process.env.GEMINI_OAUTH_ANTIGRAVITY_VERSION = "9.9.9";
    expect(antigravityUserAgent()).toContain("antigravity/hub/9.9.9 ");
    if (prev === undefined) delete process.env.GEMINI_OAUTH_ANTIGRAVITY_VERSION;
    else process.env.GEMINI_OAUTH_ANTIGRAVITY_VERSION = prev;
  });

  it("throws a clear error when no auth service is wired", async () => {
    const bare = new GeminiOauthTransformer();
    await expect(bare.transformRequestIn(baseRequest(), {} as any, {} as any)).rejects.toThrow(/未初始化/);
  });
});

describe("gemini-oauth SSE unwrap (contract §1.2)", () => {
  it("peels {response} frames and converts them through the existing gemini chain", async () => {
    const upstream = sseResponse([
      { response: geminiTextChunk("Hel") },
      { response: geminiTextChunk("lo", { finishReason: undefined }) },
      { response: { ...geminiTextChunk(""), finishReason: "STOP" } },
    ]);
    const res = await transformer().transformResponseOut(upstream, { geminiOauthClientStream: true } as any);
    const chunks = await readSseData(res);
    const texts = chunks.map((c) => c.choices?.[0]?.delta?.content).filter(Boolean);
    expect(texts.join("")).toContain("Hel");
    expect(texts.join("")).toContain("lo");
  });

  it("throws a classified error when the first frame is an error envelope", async () => {
    const upstream = sseResponse([{ error: { message: "Resource has been exhausted" } }]);
    await expect(
      transformer().transformResponseOut(upstream, { geminiOauthClientStream: true } as any)
    ).rejects.toMatchObject({ code: "gemini_oauth_quota_exceeded" });
  });

  it("aggregates the always-streaming upstream into one completion for non-stream clients", async () => {
    const upstream = sseResponse([
      { response: geminiTextChunk("He") },
      { response: { responseId: "resp-1", modelVersion: "gemini-3-flash", candidates: [{ content: { parts: [{ text: "y" }] } }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 } } },
    ]);
    const res = await transformer().transformResponseOut(upstream, { geminiOauthClientStream: false } as any);
    const json: any = await res.json();
    expect(json.object).toBe("chat.completion");
    expect(json.choices[0].message.content).toBe("Hey");
    expect(json.choices[0].finish_reason).toBe("stop");
    expect(json.usage.prompt_tokens).toBe(3);
  });

  it("aggregated non-stream requests surface upstream error frames as classified throws", async () => {
    const upstream = sseResponse([
      { response: geminiTextChunk("par") },
      { error: { message: "Resource has been exhausted" } },
    ]);
    await expect(
      transformer().transformResponseOut(upstream, { geminiOauthClientStream: false } as any)
    ).rejects.toMatchObject({ code: "gemini_oauth_quota_exceeded" });
  });

  it("strips the default_api: namespace from function call names (magpie toolOfCall)", async () => {
    expect(stripToolNamespace("default_api:bash")).toBe("bash");
    expect(stripToolNamespace("default_api.read_file")).toBe("read_file");
    expect(stripToolNamespace("my_tool")).toBe("my_tool");
    const upstream = sseResponse([
      {
        response: {
          responseId: "resp-2",
          modelVersion: "gemini-3-flash",
          candidates: [{ content: { parts: [{ functionCall: { id: "c1", name: "default_api:bash", args: { command: "ls" } } }] } }],
        },
      },
    ]);
    const res = await transformer().transformResponseOut(upstream, { geminiOauthClientStream: false } as any);
    const json: any = await res.json();
    expect(json.choices[0].message.tool_calls[0].function.name).toBe("bash");
  });

  it("handles a 200 JSON hidden-error body by classifying it", async () => {
    const upstream = new Response(JSON.stringify({ error: { message: "Resource has been exhausted" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    await expect(transformer().transformResponseOut(upstream, {} as any)).rejects.toMatchObject({
      code: "gemini_oauth_quota_exceeded",
    });
  });

  it("treats an empty SSE body as an upstream error, not a success", async () => {
    const upstream = new Response("", { status: 200, headers: { "Content-Type": "text/event-stream" } });
    await expect(transformer().transformResponseOut(upstream, {} as any)).rejects.toMatchObject({
      code: "gemini_oauth_upstream_error",
    });
  });
});

describe("gemini-oauth body quirks (magpie codeassist.go, one test per patch)", () => {
  it("adds the skip_thought_signature_validator sentinel to unsigned function calls of non-Gemini-3 models", () => {
    const body = {
      contents: [
        { role: "model", parts: [{ functionCall: { id: "c1", name: "t", args: {} } }] },
      ],
    };
    applyThoughtSignatureSentinel(body, "gemini-2.5-pro");
    expect((body.contents[0].parts[0] as any).thoughtSignature).toBe(SKIP_THOUGHT_SIGNATURE);
    // ...and to a Claude model's calls (magpie case claude).
    const body2 = {
      contents: [
        { role: "model", parts: [{ functionCall: { id: "c1", name: "t", args: {} } }] },
      ],
    };
    applyThoughtSignatureSentinel(body2, "claude-sonnet-4-6");
    expect((body2.contents[0].parts[0] as any).thoughtSignature).toBe(SKIP_THOUGHT_SIGNATURE);
  });

  it("keeps real signatures on Gemini 3 models and does not sentinel them", () => {
    const body = {
      contents: [
        { role: "model", parts: [{ functionCall: { id: "c1", name: "t", args: {} }, thoughtSignature: "real-sig" }] },
        { role: "model", parts: [{ functionCall: { id: "c2", name: "t", args: {} } }] },
      ],
    };
    applyThoughtSignatureSentinel(body, "gemini-3-flash");
    expect((body.contents[0].parts[0] as any).thoughtSignature).toBe("real-sig");
    expect((body.contents[1].parts[0] as any).thoughtSignature).toBeUndefined();
  });

  it("pairs unanswered function calls with a synthetic result (magpie pairFunctionTurns)", () => {
    const contents = [
      { role: "user", parts: [{ text: "go" }] },
      { role: "model", parts: [{ functionCall: { id: "c1", name: "tool_a", args: {} } }, { functionCall: { id: "c2", name: "tool_b", args: {} } }] },
      { role: "user", parts: [{ functionResponse: { id: "c1", name: "tool_a", response: { result: "done" } } }, { text: "thanks" }] },
    ];
    const fixed = pairFunctionTurns(structuredClone(contents));
    // c2 was never answered: a synthetic response appears in the following user turn…
    const nextUser = fixed[2];
    expect(nextUser.parts[0].functionResponse.response.result).toBe("[The result of this tool call is unavailable: the turn was interrupted.]");
    expect(nextUser.parts[0].functionResponse.id).toBe("c2");
    // …or in a user turn of its own when the next turn holds no responses.
    const orphan = [
      { role: "model", parts: [{ functionCall: { id: "c9", name: "tool_x", args: {} } }] },
      { role: "user", parts: [{ text: "hi" }] },
    ];
    const fixedOrphan = pairFunctionTurns(structuredCopy(orphan));
    expect(fixedOrphan.length).toBe(3);
    expect(fixedOrphan[1].role).toBe("user");
    expect(fixedOrphan[1].parts[0].functionResponse.id).toBe("c9");
  });

  it("drops a second answer for the same call (magpie dropSecondAnswers)", () => {
    const contents = [
      { role: "model", parts: [{ functionCall: { id: "c1", name: "t", args: {} } }] },
      { role: "user", parts: [{ functionResponse: { id: "c1", name: "t", response: { result: "first" } } }] },
      { role: "user", parts: [{ functionResponse: { id: "c1", name: "t", response: { result: "dup" } } }] },
    ];
    const fixed = dropSecondAnswers(structuredCopy(contents));
    const responses = fixed.flatMap((t: any) => t.parts).filter((p: any) => p.functionResponse);
    expect(responses).toHaveLength(1);
    expect(responses[0].functionResponse.response.result).toBe("first");
  });

  it("lets a re-issued call take its own answer", () => {
    const contents = [
      { role: "model", parts: [{ functionCall: { id: "c1", name: "t", args: {} } }] },
      { role: "user", parts: [{ functionResponse: { id: "c1", name: "t", response: { result: "first" } } }] },
      { role: "model", parts: [{ functionCall: { id: "c1", name: "t", args: {} } }] },
      { role: "user", parts: [{ functionResponse: { id: "c1", name: "t", response: { result: "second" } } }] },
    ];
    const fixed = dropSecondAnswers(structuredCopy(contents));
    const responses = fixed.flatMap((t: any) => t.parts).filter((p: any) => p.functionResponse);
    expect(responses).toHaveLength(2);
  });

  it("splits user text out of a functionResponse turn (magpie L305-330)", () => {
    const contents = [
      { role: "user", parts: [{ functionResponse: { name: "t", response: { result: "r" } } }, { text: "and also" }] },
    ];
    const fixed = splitResponseTextTurns(structuredCopy(contents));
    expect(fixed).toHaveLength(2);
    expect(fixed[0].parts[0].functionResponse).toBeDefined();
    expect(fixed[1].parts[0].text).toBe("and also");
  });

  it("prepends a user turn when history opens with a model turn (magpie L317-323)", () => {
    const fixed = fixHistoryEdges([{ role: "model", parts: [{ text: "earlier" }] }, { role: "user", parts: [{ text: "hi" }] }]);
    expect(fixed[0].role).toBe("user");
    expect(fixed[0].parts[0].text).toBe("[Continuing from previous AI thoughts...]");
  });

  it("appends a user turn when history ends with a model turn (magpie L324-330)", () => {
    const fixed = fixHistoryEdges([{ role: "user", parts: [{ text: "hi" }] }, { role: "model", parts: [{ text: "cut off" }] }]);
    expect(fixed[fixed.length - 1].role).toBe("user");
    expect(fixed[fixed.length - 1].parts[0].text).toBe("Continue.");
  });

  it("converts function declarations to antigravity `parameters` with a plain schema", () => {
    const body: any = {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      tools: [
        {
          functionDeclarations: [
            {
              name: "write",
              description: "w",
              parametersJsonSchema: {
                type: "object",
                properties: { path: { type: "string" }, count: { type: ["integer", "null"] } },
                required: ["path", "missing"],
              },
            },
          ],
        },
      ],
      toolConfig: { functionCallingConfig: { mode: "auto" } },
    };
    applyAntigravityQuirks(body, "gemini-3-flash");
    const decl = body.tools[0].functionDeclarations[0];
    expect(decl.parametersJsonSchema).toBeUndefined();
    // magpie plainSchema passes type keywords through as sent and keeps the
    // required names that exist among the properties.
    expect(decl.parameters).toEqual({
      type: "object",
      properties: { path: { type: "string" }, count: { type: "integer", nullable: true } },
      required: ["path"],
    });
    expect(body.toolConfig.functionCallingConfig.mode).toBe("AUTO");
  });

  it("upgrades named/required tool choices and sets VALIDATED for Claude models", () => {
    const claude: any = {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      tools: [{ functionDeclarations: [{ name: "t", parametersJsonSchema: { type: "object", properties: {} } }] }],
      toolConfig: { functionCallingConfig: { mode: "any" } },
      generationConfig: {},
    };
    applyAntigravityQuirks(claude, "claude-sonnet-4-6", 4096);
    expect(claude.toolConfig.functionCallingConfig.mode).toBe("VALIDATED");
    expect(claude.generationConfig.maxOutputTokens).toBe(4096);
  });
});

describe("gemini-oauth SSE frame primitives", () => {
  it("unwrapCodeAssistFrame handles all three frame shapes", () => {
    expect(unwrapCodeAssistFrame('{"response":{"candidates":[]}}').response).toEqual({ candidates: [] });
    expect(unwrapCodeAssistFrame('{"error":{"message":"boom"}}').error?.message).toBe("boom");
    expect(unwrapCodeAssistFrame('{"candidates":[]}').response).toEqual({ candidates: [] }); // bare chunk passthrough
    expect(unwrapCodeAssistFrame("not json").malformed).toBeDefined();
  });
});

describe("gemini-oauth error taxonomy (contract §1.6, line by line)", () => {
  const identitySystem = "You are a Claude agent, built on Anthropic's Claude Agent SDK";

  it("classifies a 429 carrying Claude identity markers as identity-blocked (not a quota problem)", () => {
    expect(detectClaudeIdentityMarkers(identitySystem)).toBe(true);
    expect(detectClaudeIdentityMarkers("x-anthropic-billing-header: heavy")).toBe(true);
    expect(detectClaudeIdentityMarkers("harmless system prompt")).toBe(false);
    const info = classifyGeminiOauthError({
      status: 429,
      message: "Resource has been exhausted",
      systemText: identitySystem,
    });
    expect(info.code).toBe("gemini_oauth_identity_blocked");
    expect(info.httpStatus).toBe(400); // 400 semantics: agents must not retry as-is
    expect(info.cooldownMs).toBe(6 * 60 * 60 * 1000);
    expect(info.message).toMatch(/不是额度问题/);
  });

  it("classifies a 429 without identity markers as quota exceeded (15min default)", () => {
    const info = classifyGeminiOauthError({ status: 429, message: "Resource has been exhausted", systemText: "neutral" });
    expect(info.code).toBe("gemini_oauth_quota_exceeded");
    expect(info.cooldownMs).toBe(15 * 60 * 1000);
  });

  it("uses a parsed reset time for quota cooldowns when the message carries one", () => {
    const info = classifyGeminiOauthError({ status: 429, message: "Your quota will reset after 2h" });
    expect(info.code).toBe("gemini_oauth_quota_exceeded");
    expect(info.cooldownMs).toBe(2 * 60 * 60 * 1000);
  });

  it("classifies 403 VALIDATION_REQUIRED and preserves the validation_url", () => {
    const info = classifyGeminiOauthError({
      status: 403,
      body: {
        error: {
          message: "Verify your account to continue.",
          details: [{ reason: "VALIDATION_REQUIRED", metadata: { validation_url: "https://verify.example/abc" } }],
        },
      },
    });
    expect(info.code).toBe("gemini_oauth_validation_required");
    expect(info.cooldownMs).toBe(30 * 60 * 1000);
    expect(info.validationUrl).toBe("https://verify.example/abc");
    expect(JSON.stringify(info)).not.toMatch(/token/i);
  });

  it("accepts validationUrl spelled in camelCase and google.rpc.Help links", () => {
    expect(extractValidationUrl({ error: { details: [{ reason: "VALIDATION_REQUIRED", metadata: { validationUrl: "https://v.example/x" } }] } }).validationUrl).toBe("https://v.example/x");
    expect(extractValidationUrl({ error: { details: [{ reason: "VALIDATION_REQUIRED", links: [{ url: "https://help.example/y" }] }] } }).validationUrl).toBe("https://help.example/y");
    // A non-https link is dropped, never propagated.
    expect(extractValidationUrl({ error: { details: [{ reason: "VALIDATION_REQUIRED", metadata: { validation_url: "http://evil.example" } }] } }).validationUrl).toBeUndefined();
  });

  it("classifies a 401 (after one refresh retry) as reauth required", () => {
    const info = classifyGeminiOauthError({ status: 401, message: "Unauthorized" });
    expect(info.code).toBe("gemini_oauth_reauth_required");
    expect(info.cooldownMs).toBeUndefined();
  });

  it("classifies SSE error-frame text that matches no other row as upstream_error, message passed through", () => {
    const info = classifyGeminiOauthError({ message: "Something oddly specific went wrong" });
    expect(info.code).toBe("gemini_oauth_upstream_error");
    expect(info.message).toBe("Something oddly specific went wrong");
  });

  it("recognizes the fake-429 wording on an SSE error frame with identity context", () => {
    const info = classifyGeminiOauthError({
      message: "Resource has been exhausted (e.g. check quota).",
      systemText: "x-anthropic-billing-header: 1",
    });
    expect(info.code).toBe("gemini_oauth_identity_blocked");
  });

  it("marks network/5xx failures transient (single retry then rethrow is the caller's policy)", () => {
    expect(classifyGeminiOauthError({ status: 503, message: "upstream" }).code).toBe("gemini_oauth_transient");
    expect(classifyGeminiOauthError({ status: 503, message: "x" }).retryable).toBe(true);
    expect(classifyGeminiOauthError({ status: 500, message: "x" }).retryable).toBe(true);
  });

  it("model-family folding follows magpie antigravity_models.go", () => {
    expect(splitAntigravityId("gemini-3.7-flash-low")).toEqual({ family: "gemini-3.7-flash", effort: "low" });
    expect(splitAntigravityId("gemini-3.5-flash-extra-low")).toEqual({ family: "gemini-3.5-flash", effort: "minimal" });
    expect(splitAntigravityId("gemini-3-flash")).toEqual({ family: "gemini-3-flash", effort: "" });
    expect(antigravityEffortFamily("claude-opus-4-6-thinking")).toBe("claude-opus-4-6-thinking"); // "-thinking" is not an effort word
    const collapsed = collapseAntigravityModels([
      { id: "gemini-3.7-flash-low", name: "Gemini 3.7 Flash (Low)", picker: 1 },
      { id: "gemini-3.7-flash-high", name: "Gemini 3.7 Flash (High)", picker: 2 },
      { id: "gemini-3-flash", name: "Gemini 3 Flash", picker: 3 },
    ]);
    expect(collapsed.map((m) => m.id)).toEqual(["gemini-3.7-flash", "gemini-3-flash"]);
    const family = collapsed[0];
    expect(family.name).toBe("Gemini 3.7 Flash");
    expect(family.context).toBeUndefined();
  });
});

function structuredCopy<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}
