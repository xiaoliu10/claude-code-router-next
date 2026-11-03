import { describe, expect, it, vi } from "vitest";
import { GrokTransformer } from "../src/transformer";
import { createGrokEngine } from "../src/vendor/engine.mjs";
import { completed, sse } from "./fixtures";
import { OpenAIResponsesTransformer } from "../../../core/src/transformer/openai.responses.transformer";
import { AnthropicTransformer } from "../../../core/src/transformer/anthropic.transformer";

describe("GrokTransformer Responses seam", () => {
  it("normalizes include/schema/reasoning and session without injecting X search", async () => {
    const transform = new GrokTransformer();
    const input = { model: "grok-fixture", input: [{ type: "reasoning", content: null, encrypted_content: "opaque" }],
      include: ["output.encrypted_content", "reasoning.encrypted_content"], tool_choice: "none", tools: [
        { type: "function", name: "read", parameters: { anyOf: [{ type: "object", properties: { path: { type: "string" } }, required: ["path"] }, { type: "object", properties: { url: { type: "string" } } }] } },
        { type: "web_search", external_web_access: true }, { type: "unsupported" },
      ] };
    await expect(transform.transformRequestIn({ model: "m", input: [], tool_choice: "required" })).rejects.toMatchObject({ code: "grok_tool_choice_unsupported" });
    const result = await transform.transformRequestIn(input, undefined, { req: { clientContext: { stableSessionId: "fixture-session" } } });
    expect(result.body.include).toEqual(["reasoning.encrypted_content"]); expect(result.body.input[0]).toEqual({ type: "reasoning", encrypted_content: "opaque" });
    expect(result.body.tools.map((t: any) => t.type)).toEqual(["function", "web_search"]); expect(result.body.tools[0].parameters.type).toBe("object");
    expect(result.body.tool_choice).toBe("none"); expect(result.body.prompt_cache_key).toBe("fixture-session");
    expect(input.input[0].content).toBeNull();
    await expect(transform.transformRequestIn({ model: "m", input: [], tools: [{ type: "function", name: "safe" }], tool_choice: { type: "allowed_tools", tools: [] } })).rejects.toMatchObject({ code: "grok_tool_choice_unsupported" });
  });
  it("retains multimodal collaboration history and opaque reasoning", async () => {
    const result = await new GrokTransformer().transformRequestIn({ model: "m", input: [
      { type: "agent_message", author: "a", recipient: "b", content: [{ type: "input_text", text: "look" }, { type: "input_image", image_url: "data:image/png;base64,fixture" }] },
      { type: "reasoning", encrypted_content: "opaque" }, { type: "function_call", call_id: "call_1", name: "read", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "content" },
    ] });
    expect(result.body.input[0]).toMatchObject({ type: "message", role: "user" });
    expect(result.body.input[0].content[2].image_url).toBe("data:image/png;base64,fixture");
    expect(result.body.input[1].encrypted_content).toBe("opaque"); expect(result.body.input[3].call_id).toBe("call_1");
  });
  it("actual Anthropic→host Responses→Grok preserves image, effort, tool history", async () => {
    const anthropic = new AnthropicTransformer(); const host = new OpenAIResponsesTransformer();
    const unified = await anthropic.transformRequestOut({ model: "grok-fixture", max_tokens: 100, stream: false,
      thinking: { type: "enabled", budget_tokens: 2048 }, messages: [
        { role: "user", content: [{ type: "text", text: "look" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "fixture" } }] },
        { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "read", input: { path: "/x" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "file" }] },
      ], tools: [{ name: "read", input_schema: { type: "object", properties: { path: { type: "string" } } } }], tool_choice: { type: "tool", name: "read" } });
    unified.reasoning = { effort: "high" };
    const body = (await new GrokTransformer().transformRequestIn(await host.transformRequestIn(unified))).body;
    expect(body.reasoning.effort).toBe("high"); expect(body.input[0].content[1]).toMatchObject({ type: "input_image", image_url: "data:image/png;base64,fixture" });
    expect(body.input).toContainEqual(expect.objectContaining({ type: "function_call", call_id: "call_1", name: "read" }));
    expect(body.input).toContainEqual(expect.objectContaining({ type: "function_call_output", call_id: "call_1", output: "file" }));
    expect(body.tools[0].name).toBe("read"); expect(body.tool_choice).toEqual({ type: "function", name: "read" });
  });
  it("preserves complete SSE bytes across UTF-8/chunk boundaries and hosted envelope", async () => {
    const wire = await sse([{ type: "response.created", response: { id: "r" } },
      { type: "response.output_text.delta", delta: "你好" },
      { type: "response.function_call_arguments.delta", item_id: "fc1", delta: '{"x":1}' },
      { ...completed, response: { ...completed.response, tools: [{ type: "x_search" }], server_side_tool_usage_details: { x_search: 1 }, output: [...completed.response.output, { type: "custom_tool_call", name: "x_search", output: "fixture" }] } },
    ]).text();
    const bytes = new TextEncoder().encode(wire);
    // A fresh 3-byte-split stream per lane: streams are single-use, and the
    // split is what exercises UTF-8/chunk-boundary reassembly.
    const sseStream = () => { let offset = 0; return new ReadableStream({ pull(c) { if (offset >= bytes.length) c.close(); else c.enqueue(bytes.slice(offset, offset += 3)); } }); };
    const grok = () => new GrokTransformer().transformResponseOut(new Response(sseStream(), { headers: { "content-type": "text/event-stream" } }));
    const host = new OpenAIResponsesTransformer();
    // Accurate converter contract: undefined (and "responses") pass native
    // Responses through byte-for-byte; "chat" converts for chat clients.
    const passthrough = await host.transformResponseOut(new Response(sseStream(), { headers: { "content-type": "text/event-stream" } }));
    expect(await passthrough.text()).toBe(wire);
    const native = await host.transformResponseOut(await grok(), { responseTargetFormat: "responses" } as any);
    expect(await native.text()).toBe(wire);
    const chat = await host.transformResponseOut(await grok(), { responseTargetFormat: "chat" } as any);
    const chatWire = await chat.text();
    expect(chatWire).toContain('"finish_reason":"tool_calls"'); expect(chatWire).toContain('你好'); expect(chatWire).toContain('[DONE]'); expect(chatWire).toContain('prompt_tokens');
  });
  it("non-stream Responses final JSON and usage pass through to actual host conversion", async () => {
    const response = new Response(JSON.stringify(completed.response), { headers: { "content-type": "application/json" } });
    const converter = new OpenAIResponsesTransformer(); converter.logger = { debug() {} };
    const host = await converter.transformResponseOut(await new GrokTransformer().transformResponseOut(response));
    const chat = await host.json() as any; expect(chat.choices[0].message.content).toBe("Hello fixture"); expect(chat.usage.prompt_tokens).toBe(11);
  });
  it("response.incomplete output caps pass through; terminal errors classify quota/reauth into the service", async () => {
    const notes: any[] = [];
    const transform = new GrokTransformer(createGrokEngine(), info => { notes.push(info); });
    const capped = await transform.transformResponseOut(sse([
      { type: "response.output_text.delta", delta: "partial answer" },
      { type: "response.incomplete", response: { id: "r", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "partial answer" }] }], usage: { input_tokens: 5, output_tokens: 9 } } },
    ]));
    expect((await capped.text())).toContain("max_output_tokens");
    const failed = await transform.transformResponseOut(sse([{ type: "response.failed", response: { error: { code: "rate_limit_exceeded", message: "slow down" } } }]));
    await expect(failed.text()).rejects.toMatchObject({ code: "grok_rate_limited", statusCode: 429 });
    const auth = await transform.transformResponseOut(sse([{ type: "error", code: "invalid_token", message: "token rejected" }]));
    await expect(auth.text()).rejects.toMatchObject({ code: "grok_reauth_required", statusCode: 401 });
    await expect(notes).toEqual([{ code: "grok_rate_limited", httpStatus: 429, cooldownMs: 300000 }, { code: "grok_reauth_required", httpStatus: 401 }]);
  });
  it("rejects empty/truncated/failed SSE and propagates consumer cancellation", async () => {
    const transform = new GrokTransformer();
    for (const events of [[], [{ type: "response.output_text.delta", delta: "partial" }], [{ type: "response.failed", response: { error: { message: "fixture-secret" } } }]]) {
      const response = await transform.transformResponseOut(sse(events));
      await expect(response.text()).rejects.toMatchObject({ statusCode: 502 });
    }
    const cancel = vi.fn(); const response = await transform.transformResponseOut(new Response(new ReadableStream({ cancel }), { headers: { "content-type": "text/event-stream" } }));
    await response.body!.cancel("fixture-disconnect"); expect(cancel).toHaveBeenCalledWith("fixture-disconnect");
  });
});
