import { describe, expect, it } from "vitest";
import { OpenAIResponsesTransformer } from "../transformer/openai.responses.transformer";

/**
 * The unified assistant shape carries a top-level `thinking` field extracted
 * by anthropic.transformer from client thinking blocks (consumed by
 * OpenAI-compatible reasoning upstreams). The Responses API rejects unknown
 * top-level item fields — a second conversation turn with carried-back
 * thinking history failed upstream with 400 "Unknown parameter:
 * input[127].thinking" (chatgpt.com backend-api/codex).
 */
describe("OpenAIResponsesTransformer — request input sanitation", () => {
  it.each([true, false])("removes the Chat usage option (%s) from the Responses payload only", async includeUsage => {
    const transformer = new OpenAIResponsesTransformer();
    const request = { stream: true, stream_options: { include_usage: includeUsage }, messages: [] };
    const result = await transformer.transformRequestIn(request as any);
    expect(result).not.toHaveProperty("stream_options");
    expect(request.stream_options.include_usage).toBe(includeUsage);
    expect(result.stream).toBe(true);
  });

  it("preserves Responses stream options alongside the Chat usage option", async () => {
    const result = await new OpenAIResponsesTransformer().transformRequestIn({
      messages: [], stream_options: { include_usage: true, include_obfuscation: false },
    } as any);
    expect(result.stream_options).toEqual({ include_obfuscation: false });
  });

  it("strips the top-level thinking field from assistant input items", async () => {
    const t = new OpenAIResponsesTransformer();
    const request: any = {
      messages: [
        { role: "user", content: [{ type: "text", text: "What is 2+2?" }] },
        {
          role: "assistant",
          content: [{ type: "text", text: "4" }],
          thinking: { content: "The user asks a simple sum.", signature: "sig123" },
        },
        { role: "user", content: [{ type: "text", text: "And doubled?" }] },
      ],
    };
    const result: any = await t.transformRequestIn(request, {} as any);
    expect(Array.isArray(result.input)).toBe(true);
    expect(result.input).toHaveLength(3);
    for (const item of result.input) {
      expect(item.thinking).toBeUndefined();
    }
    // The visible content survives: the assistant turn still carries its text.
    const assistant = result.input[1];
    expect(assistant.role).toBe("assistant");
    expect(assistant.content).toEqual([{ type: "output_text", text: "4" }]);
  });

  it("omits thinking-only assistant turns after content normalization", async () => {
    const t = new OpenAIResponsesTransformer();
    const request: any = {
      messages: [
        { role: "user", content: [{ type: "text", text: "go" }] },
        {
          role: "assistant",
          content: [{ type: "thinking", thinking: "silent", signature: "sig" }],
          thinking: { content: "silent", signature: "sig" },
        },
        { role: "user", content: [{ type: "text", text: "done" }] },
      ],
    };
    const result: any = await t.transformRequestIn(request, {} as any);
    expect(result.input).toHaveLength(2);
    expect(result.input.map((item: any) => item.role)).toEqual(["user", "user"]);
  });

  it("preserves tool-only history while omitting unsupported thinking", async () => {
    const t = new OpenAIResponsesTransformer();
    const result: any = await t.transformRequestIn({ messages: [
      { role: "assistant", thinking: { content: "plan" }, content: [{ type: "thinking", thinking: "plan" }], tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "done" },
    ] } as any);
    expect(result.input).toEqual([
      { type: "function_call", name: "lookup", arguments: "{}", call_id: "call_1" },
      { type: "function_call_output", call_id: "call_1", output: "done" },
    ]);
  });

  it("does not strip thinking-shaped fields inside item content (input_text items are untouched)", async () => {
    const t = new OpenAIResponsesTransformer();
    const request: any = {
      messages: [
        { role: "user", content: [{ type: "text", text: "say thinking out loud" }] },
      ],
    };
    const result: any = await t.transformRequestIn(request, {} as any);
    expect(result.input[0].content[0]).toEqual({ type: "input_text", text: "say thinking out loud" });
  });
});
