import { describe, expect, it, vi } from "vitest";
import { registerRequestPipeline } from "../ccr/request-pipeline";
import { OpenAIResponsesTransformer } from "../transformer/openai.responses.transformer";
import { AnthropicTransformer } from "../transformer/anthropic.transformer";
import * as usageStore from "../ccr/usage-store";

vi.mock("../ccr/usage-store", () => ({ append: vi.fn(), readTokenSpeedStats: () => ({ ttft: null }) }));
vi.mock("../services/provider-health", () => ({ getHealthStore: () => ({ recordSuccess() {} }) }));

function request(pathname: string) {
  return { pathname, id: "fixture", provider: "fixture", chatCompletionCapture: pathname === "/v1/chat/completions" ? {} : undefined, body: { model: "m" }, tokenCount: 1000,
    usageCacheKey: "fixture", usageSessionId: "fixture", clientContext: { usageScope: "request" }, clientType: "api" };
}
async function record(req: ReturnType<typeof request>, payload: string | ReadableStream, inclusiveProvider = false) {
  const hooks = new Map<string, Function>();
  registerRequestPipeline({ addHook(name: string, hook: Function) { if (!hooks.has(name)) hooks.set(name, hook); },
    providerService: { getProvider: () => ({ cacheMode: inclusiveProvider ? "inclusive" : "exclusive" }) } }, {});
  const reply = { statusCode: 200 };
  const sent = await new Promise<string | ReadableStream>((resolve, reject) => hooks.get("onSend")!(req, reply, payload,
    (err: unknown, result: string | ReadableStream) => err ? reject(err) : resolve(result)));
  if (sent instanceof ReadableStream) await new Response(sent).text();
  await hooks.get("onResponse")!(req, reply);
  return vi.mocked(usageStore.append).mock.lastCall![0];
}
function sse(frames: any[]) {
  return new Response(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""),
    { headers: { "Content-Type": "text/event-stream" } });
}

describe("effective input capture", () => {
  it.each([false, true])("counts native Responses input including both cache buckets (stream=%s)", async stream => {
    const req = request("/v1/responses");
    const usage = { input_tokens: 30, input_tokens_details: { cached_tokens: 15, cache_write_tokens: 5 } };
    const response = { object: "response", usage };
    const row = await record(req, stream ? sse([{ type: "response.completed", response }]).body! : JSON.stringify(response));
    expect(row).toMatchObject({ inputTokens: 30, cacheReadInputTokens: 15, cacheCreationInputTokens: 5, effectiveInputTokens: 30 });
    expect(row.effectiveInputTokensSource).toBeUndefined();
  });

  it("keeps inclusive total and cache reads separate so the UI can subtract (77000 total, 76000 read => 1000 uncached)", async () => {
    const req = request("/v1/responses");
    const usage = { input_tokens: 77000, input_tokens_details: { cached_tokens: 76000 } };
    const row = await record(req, JSON.stringify({ object: "response", usage }));
    // Core stores the inclusive total and the read bucket independently; the
    // page derives uncached input as total - read, never double-subtracting.
    expect(row.effectiveInputTokens).toBe(77000);
    expect(row.cacheReadInputTokens).toBe(76000);
    expect(row.effectiveInputTokens! - row.cacheReadInputTokens).toBe(1000);
    expect(row.effectiveInputTokensSource).toBeUndefined();
  });

  it.each([
    { input_tokens: 0, cache_read_input_tokens: 50, cache_creation_input_tokens: 5, expected: 55 },
    { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 5, expected: 15 },
    { input_tokens: 10, cache_creation_input_tokens: 5, expected: 15 },
    { input_tokens: 0, expected: 0 },
    { input_tokens: 10, usage_estimated: true, expected: 10, source: "estimated" },
    { input_tokens: 0, usage_estimated: true, expected: 0, source: "estimated" },
  ])("preserves zero and missing Anthropic cache counts in $expected", async ({ expected, source, ...usage }) => {
    const row = await record(request("/v1/messages"), JSON.stringify({ type: "message", usage }));
    expect(row.effectiveInputTokens).toBe(expected);
    expect(row.effectiveInputTokensSource).toBe(source);
  });

  it("records inclusive Chat prompt and separate Kiro writes", async () => {
    const usage = { usage_source: "kiro", prompt_tokens: 42, completion_tokens: 3,
      prompt_tokens_details: { cached_tokens: 30 }, cache_creation_input_tokens: 4 };
    const payload = JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage });
    const row = await record(request("/v1/chat/completions"), payload);
    expect(row).toMatchObject({ inputTokens: 42, effectiveInputTokens: 46 });
    expect(row.effectiveInputTokensSource).toBeUndefined();
  });

  it.each([false, true])("captures Chat source counters without double-counting reads (stream=%s)", async stream => {
    const req = request("/v1/chat/completions");
    const usage = { prompt_tokens: 40, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 15, cache_write_tokens: 5 } };
    const body = stream ? `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage })}\n\ndata: [DONE]\n\n` :
      JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage });
    const row = await record(req, stream ? new Response(body, { headers: { "Content-Type": "text/event-stream" } }).body! : body);
    expect(row.effectiveInputTokens).toBe(40);
    expect(row.effectiveInputTokensSource).toBeUndefined();
  });

  it("honors a provider's inclusive Messages mode", async () => {
    const usage = { input_tokens: 40, cache_read_input_tokens: 15, cache_creation_input_tokens: 5 };
    expect((await record(request("/v1/messages"), JSON.stringify({ usage }), true)).effectiveInputTokens).toBe(40);
  });

  it.each([false, true])("captures first and final Anthropic SSE counters (converted to Responses=%s)", async converted => {
    const req = request(converted ? "/v1/responses" : "/v1/messages");
    const start = { input_tokens: 12, cache_read_input_tokens: 18 };
    const final = { output_tokens: 3, cache_creation_input_tokens: 5 };
    const upstream = sse([{ type: "message_start", message: { usage: start } }, { type: "message_delta", usage: final }, { type: "message_stop" }]);
    const response = converted ? await new OpenAIResponsesTransformer().transformResponseIn(upstream, { req }) : upstream;
    const row = await record(req, response.body!);
    expect(row.effectiveInputTokens).toBe(35);
    expect(row.effectiveInputTokensSource).toBeUndefined();
  });

  it("retains Kiro source semantics through streamed Chat-to-Anthropic conversion", async () => {
    const req = request("/v1/messages");
    const usage = { usage_source: "kiro", prompt_tokens: 42, completion_tokens: 3,
      prompt_tokens_details: { cached_tokens: 30 }, cache_creation_input_tokens: 4 };
    const body = `data: ${JSON.stringify({ object: "chat.completion.chunk", choices: [{ delta: {}, finish_reason: "stop" }], usage })}\n\ndata: [DONE]\n\n`;
    const converter = new AnthropicTransformer(); converter.logger = { debug() {}, info() {} };
    const response = await converter.transformResponseIn(new Response(body, { headers: { "Content-Type": "text/event-stream" } }), { req });
    const row = await record(req, response.body!);
    expect(row.effectiveInputTokens).toBe(46);
    expect(row.effectiveInputTokensSource).toBeUndefined();
  });

  it.each(["/v1/messages", "/v1/responses"])("preserves Kiro Chat reads and separate writes through %s", async path => {
    const req = request(path);
    const chat = Response.json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: { usage_source: "kiro", prompt_tokens: 42, completion_tokens: 3,
        prompt_tokens_details: { cached_tokens: 30 }, cache_creation_input_tokens: 4 } });
    const converter = path === "/v1/messages" ? new AnthropicTransformer() : new OpenAIResponsesTransformer();
    if (converter instanceof AnthropicTransformer) converter.logger = { debug() {} };
    const response = await converter.transformResponseIn(chat, { req });
    expect((await record(req, await response.text())).effectiveInputTokens).toBe(46);
  });

  it.each([false, true])("retains Kiro source semantics through a streamed Chat-to-Responses conversion (stream=%s)", async stream => {
    const req = request("/v1/responses");
    const usage = { usage_source: "kiro", prompt_tokens: 42, completion_tokens: 3,
      prompt_tokens_details: { cached_tokens: 30 }, cache_creation_input_tokens: 4 };
    const body = `data: ${JSON.stringify({ object: "chat.completion.chunk", choices: [{ delta: {}, finish_reason: "stop" }], usage })}

data: [DONE]

`;
    const upstream = stream ? new Response(body, { headers: { "Content-Type": "text/event-stream" } }) :
      Response.json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage });
    const response = await new OpenAIResponsesTransformer().transformResponseIn(upstream, { req, responseTargetFormat: "responses" });
    const row = await record(req, stream ? response.body! : await response.text());
    expect(row.effectiveInputTokens).toBe(46);
    expect(row.effectiveInputTokensSource).toBeUndefined();
  });
});