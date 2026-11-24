import { expect, it, vi } from "vitest";
import { normalizeUsagePayload } from "../ccr/usage-merge";
import { AnthropicTransformer } from "../transformer/anthropic.transformer";
// @ts-expect-error The standalone plugin ships JavaScript without declarations.
import { chatResponse } from "../../../plugins/gemini-agy-acp/src/chat.mjs";
// @ts-expect-error The standalone plugin ships JavaScript without declarations.
import { promptUsage } from "../../../plugins/gemini-agy-acp/src/acp-usage.mjs";

const prompt = { model: "gemini-fixture", prompt: "hello" };
const acpResult = {
  stopReason: "end_turn",
  usage: {
    inputTokens: 1600,
    outputTokens: 900,
    cachedReadTokens: 2100,
    cachedWriteTokens: 200,
    thoughtTokens: 700,
    totalTokens: 4800,
  },
};

const transport = {
  async run({ onText }: { onText: (text: string) => void }) {
    onText("ok");
    return { stopReason: acpResult.stopReason, usage: promptUsage(acpResult) };
  },
};

const accountingUsage = {
  input_tokens: 1600,
  output_tokens: 900,
  cache_read_input_tokens: 2100,
  cache_creation_input_tokens: 200,
};

async function jsonSseFrames(response: Response) {
  return (await response.text()).split("\n")
    .filter(line => line.startsWith("data: {"))
    .map(line => JSON.parse(line.slice(6)));
}

it.each([false, true])("normalizes ACP Chat usage while keeping the wire prompt inclusive (stream=%s)", async (stream) => {
  const response: Response = await chatResponse(transport, prompt, stream);
  const { usage } = stream ? (await jsonSseFrames(response)).at(-1) : await response.json();
  expect(usage).toMatchObject({
    prompt_tokens: 3900,
    completion_tokens: 900,
    total_tokens: 4800,
    prompt_tokens_details: { cached_tokens: 2100, cache_write_tokens: 200 },
    completion_tokens_details: { reasoning_tokens: 700 },
  });
  expect(usage).not.toHaveProperty("input_tokens");
  const normalized = normalizeUsagePayload(usage);
  expect(normalized).toMatchObject(accountingUsage);
  expect(normalized.input_tokens + normalized.cache_read_input_tokens + normalized.cache_creation_input_tokens)
    .toBe(usage.prompt_tokens);
  expect(usage.prompt_tokens).toBe(3900);
});

it.each([false, true])("maps ACP read and write buckets separately in Anthropic Messages (stream=%s)", async (stream) => {
  const transformer = new AnthropicTransformer();
  transformer.logger = { debug: vi.fn(), info: vi.fn() };
  const chat: Response = await chatResponse(transport, prompt, stream);
  const response = await transformer.transformResponseIn(chat, { req: { id: "acp-usage" } } as any);
  const message = stream
    ? (await jsonSseFrames(response)).find(frame => frame.type === "message_delta")
    : await response.json();
  expect(message?.usage).toMatchObject(accountingUsage);
  expect(normalizeUsagePayload(message.usage)).toMatchObject(accountingUsage);
});
