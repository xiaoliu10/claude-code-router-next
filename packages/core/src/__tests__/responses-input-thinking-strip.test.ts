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

  it("keeps assistant turns whose content was only a thinking block (content dropped, item kept)", async () => {
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
    const assistant = result.input[1];
    expect(assistant.thinking).toBeUndefined();
    // normalizeRequestContent filtered the thinking block: content is gone.
    expect(assistant.content).toBeUndefined();
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
