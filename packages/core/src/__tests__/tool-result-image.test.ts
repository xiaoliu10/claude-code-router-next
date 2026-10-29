import { describe, expect, it } from "vitest";
import { AnthropicTransformer } from "../transformer/anthropic.transformer";
import { OpenAIResponsesTransformer } from "../transformer/openai.responses.transformer";
import { TiktokenTokenizer } from "../tokenizer/tiktoken-tokenizer";
import { calculateTokenCount } from "../utils/router";

// Regression: tool_result image blocks were JSON.stringify'ed into the tool
// message as plain TEXT. A single 480KB screenshot became ~340k text tokens and
// a 10-screenshot session ~2.04M tokens, rejected upstream with
// context_length_exceeded (handoff /tmp/ccr-handoff-20261026.md).
// The fix must keep text in the tool message, move images into a following
// user message as image_url blocks (or a placeholder when the target model has
// no image input), and stop counting base64 as text tokens in BOTH tokenizers.

const BASE64 = "iVBORw0KGgo" + "A".repeat(60_000);
const TOOL_RESULT_WITH_IMAGE = {
  type: "tool_result",
  tool_use_id: "call_1",
  content: [
    { type: "text", text: "screenshot of the page" },
    {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: BASE64 },
    },
  ],
};

function anthropicRequest(model: string, toolResult: any = TOOL_RESULT_WITH_IMAGE) {
  return {
    model,
    max_tokens: 64,
    messages: [{ role: "user", content: [toolResult] }],
  } as any;
}

function toUnified(request: any): Promise<any> {
  return new AnthropicTransformer().transformRequestOut(request);
}

function toolMessage(unified: any): any {
  return unified.messages.find((m: any) => m.role === "tool");
}

describe("tool_result image extraction (anthropic endpoint)", () => {
  it("keeps text in the tool message and moves the image into a following user message for a vision model", async () => {
    const unified = await toUnified(anthropicRequest("claude-sonnet-4"));
    const tool = toolMessage(unified);

    // The base64 payload must never be sent as tool TEXT again.
    expect(JSON.stringify(tool.content)).not.toContain("iVBORw0KGgo");
    expect(tool.content).toContain("screenshot of the page");

    const toolIndex = unified.messages.indexOf(tool);
    const following = unified.messages[toolIndex + 1];
    expect(following?.role).toBe("user");
    const imagePart = following?.content?.find((p: any) => p.type === "image_url");
    expect(imagePart?.image_url?.url).toBe(`data:image/png;base64,${BASE64}`);
  });

  it("degrades to a placeholder instead of base64 when the target model has no image input", async () => {
    const unified = await toUnified(anthropicRequest("gpt-6.1-sol"));
    // No base64 anywhere in the outgoing unified request.
    expect(JSON.stringify(unified)).not.toContain("iVBORw0KGgo");
    expect(JSON.stringify(toolMessage(unified).content)).toContain("tool image omitted");
  });

  it("leaves tool_result without images byte-identical to the legacy behavior", async () => {
    const textOnly = {
      type: "tool_result",
      tool_use_id: "call_1",
      content: [{ type: "text", text: "plain result" }],
    };
    const unified = await toUnified(anthropicRequest("claude-sonnet-4", textOnly));
    expect(toolMessage(unified).content).toBe(JSON.stringify(textOnly.content));
  });
});

describe("tool_result image extraction (openai/responses path)", () => {
  it("function_call_output carries text only; the image becomes an input_image item", async () => {
    const unified = await toUnified(anthropicRequest("claude-sonnet-4"));
    const body: any = await new OpenAIResponsesTransformer().transformRequestIn(unified);
    const serialized = JSON.stringify(body.input);

    const output = body.input.find((item: any) => item.type === "function_call_output");
    expect(output).toBeDefined();
    expect(JSON.stringify(output.output)).not.toContain("iVBORw0KGgo");
    expect(serialized).toContain('"type":"input_image"');
  });

  it("sends no base64 at all for a model without image input", async () => {
    const unified = await toUnified(anthropicRequest("gpt-6.1-sol"));
    const body: any = await new OpenAIResponsesTransformer().transformRequestIn(unified);
    expect(JSON.stringify(body)).not.toContain("iVBORw0KGgo");
    expect(JSON.stringify(body)).toContain("tool image omitted");
  });
});

describe("token counting must not price base64 as text", () => {
  const messages = anthropicRequest("claude-sonnet-4").messages;
  const textOnlyMessages = anthropicRequest("claude-sonnet-4", {
    type: "tool_result",
    tool_use_id: "call_1",
    content: [{ type: "text", text: "screenshot of the page" }],
  }).messages;

  it("router calculateTokenCount skips image blocks in tool_result", () => {
    const withImage = calculateTokenCount(messages, undefined, [] as any);
    const textOnly = calculateTokenCount(textOnlyMessages, undefined, [] as any);
    // Before the fix this was tens of thousands of tokens of base64 text.
    expect(withImage).toBeLessThan(1000);
    expect(withImage).toBe(textOnly);
  });

  it("TiktokenTokenizer.countTokens skips image blocks in tool_result", async () => {
    const tokenizer = new TiktokenTokenizer();
    const withImage = await tokenizer.countTokens({ messages } as any);
    const textOnly = await tokenizer.countTokens({ messages: textOnlyMessages } as any);
    expect(withImage).toBeLessThan(1000);
    expect(withImage).toBe(textOnly);
  });
});

describe("review findings: multi-tool ordering, empty output, logging", () => {
  it("keeps all tool messages adjacent and groups images into ONE following user message", async () => {
    const request = {
      model: "claude-sonnet-4",
      max_tokens: 64,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_1",
              content: [
                { type: "text", text: "shot one" },
                { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo-AAA1" } },
              ],
            },
            {
              type: "tool_result",
              tool_use_id: "call_2",
              content: [
                { type: "text", text: "shot two" },
                { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo-AAA2" } },
              ],
            },
          ],
        },
      ],
    };
    const unified: any = await toUnified(request);
    const roles = unified.messages.map((m: any) => m.role);
    // tool1, tool2, then ONE image user message — never interleaved.
    expect(roles).toEqual(["tool", "tool", "user"]);
    expect(unified.messages[0].content).toBe("shot one");
    expect(unified.messages[1].content).toBe("shot two");
    const images = unified.messages[2].content.filter((p: any) => p.type === "image_url");
    expect(images).toHaveLength(2);
    expect(images[0].image_url.url.endsWith("AAA1")).toBe(true);
    expect(images[1].image_url.url.endsWith("AAA2")).toBe(true);

    const body: any = await new OpenAIResponsesTransformer().transformRequestIn(unified);
    // function_call_output group stays contiguous; the images follow as ONE
    // user turn (a plain role-bearing item, no type field on the envelope).
    const outputs = body.input.filter((item: any) => item.type === "function_call_output");
    expect(outputs).toHaveLength(2);
    const imageTurn = body.input[body.input.length - 1];
    expect(imageTurn.role).toBe("user");
    expect(imageTurn.content.filter((p: any) => p.type === "input_image")).toHaveLength(2);
  });

  it("keeps a non-empty tool output for an image-only tool_result (vision model)", async () => {
    const imageOnly = {
      type: "tool_result",
      tool_use_id: "call_1",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: BASE64 } },
      ],
    };
    const unified: any = await toUnified(anthropicRequest("claude-sonnet-4", imageOnly));
    expect(toolMessage(unified).content).toBe("[tool image]");
    const following = unified.messages[1];
    expect(following.role).toBe("user");
    expect(following.content.some((p: any) => p.type === "image_url")).toBe(true);
  });

  it("does not print image payloads to stdout on the request path", async () => {
    const { vi } = await import("vitest");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const unified: any = await toUnified(anthropicRequest("claude-sonnet-4"));
      await new OpenAIResponsesTransformer().transformRequestIn(unified);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
