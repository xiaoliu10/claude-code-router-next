import { describe, expect, it } from "vitest";
import { GeminiTransformer } from "../transformer/gemini.transformer";
import { AnthropicTransformer } from "../transformer/anthropic.transformer";

function geminiSse(frames: unknown[]): Response {
  const body = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("");
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

async function collectAnthropicSse(response: Response): Promise<Array<{ event: string; data: any }>> {
  const out: Array<{ event: string; data: any }> = [];
  const text = await response.text();
  for (const block of text.split("\n\n")) {
    let event = "";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7).trim();
      else if (line.startsWith("data: ")) data = line.slice(6);
    }
    if (event && data) out.push({ event, data: JSON.parse(data) });
  }
  return out;
}

describe("GeminiTransformer streaming trailing usage & cache preservation", () => {
  it("preserves cachedContentTokenCount from trailing empty-text STOP frames through AnthropicTransformer", async () => {
    const gemini = new GeminiTransformer();
    const anthropic = new AnthropicTransformer();
    const noopLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
    gemini.logger = noopLogger;
    anthropic.logger = noopLogger;

    const upstream = geminiSse([
      {
        responseId: "resp-1",
        modelVersion: "gemini-4-argon-high",
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: { id: "tu-1", name: "read", args: { path: "a.ts" } },
                  thoughtSignature: "c2ln",
                },
              ],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 88817,
          candidatesTokenCount: 23,
          totalTokenCount: 88840,
        },
      },
      {
        responseId: "resp-1",
        modelVersion: "gemini-4-argon-high",
        candidates: [{ finishReason: "STOP", content: { parts: [{ text: "" }] } }],
        usageMetadata: {
          promptTokenCount: 93116,
          candidatesTokenCount: 29,
          totalTokenCount: 93145,
          cachedContentTokenCount: 91067,
          thoughtsTokenCount: 46,
        },
      },
    ]);

    const openaiStream = await gemini.transformResponseOut(upstream);
    const anthropicStream = await anthropic.transformResponseIn(openaiStream, {
      req: { id: "req-1", tokenCount: 88800, isTargetAnthropic: false },
    } as any);

    const events = await collectAnthropicSse(anthropicStream);
    const delta = events.find((e) => e.event === "message_delta");
    expect(delta).toBeDefined();
    expect(delta!.data.usage).toEqual({
      input_tokens: 2049,
      output_tokens: 29,
      cache_read_input_tokens: 91067,
    });
    expect(delta!.data.delta.stop_reason).toBe("end_turn");
  });

  it("preserves grounding citations and usage when finishReason arrives on an empty-text frame", async () => {
    const gemini = new GeminiTransformer();
    gemini.logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

    const upstream = geminiSse([
      {
        responseId: "resp-ground",
        modelVersion: "gemini-3-flash",
        candidates: [{ content: { parts: [{ text: "answer" }] } }],
      },
      {
        responseId: "resp-ground",
        modelVersion: "gemini-3-flash",
        candidates: [
          {
            finishReason: "STOP",
            content: { parts: [{ text: "" }] },
            groundingMetadata: {
              groundingChunks: [{ web: { uri: "https://example.com", title: "Example" } }],
              groundingSupports: [
                { groundingChunkIndices: [0], segment: { text: "cited", startIndex: 0, endIndex: 5 } },
              ],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 500,
          candidatesTokenCount: 10,
          cachedContentTokenCount: 400,
        },
      },
    ]);

    const out = await gemini.transformResponseOut(upstream);
    const chunks = (await out.text())
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice(6)));
    const tail = chunks.at(-1);
    expect(tail.choices[0].finish_reason).toBe("stop");
    expect(tail.choices[0].delta.annotations).toEqual([
      {
        type: "url_citation",
        url_citation: {
          url: "https://example.com",
          title: "Example",
          content: "cited",
          start_index: 0,
          end_index: 5,
        },
      },
    ]);
    expect(tail.usage.prompt_tokens_details.cached_tokens).toBe(400);
  });
});
