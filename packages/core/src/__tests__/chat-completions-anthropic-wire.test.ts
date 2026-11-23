import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Server from "../server";
import { createCcrPreHandlerCallbacks, registerRequestPipeline } from "../ccr/request-pipeline";
import { getHealthStore } from "../services/provider-health";
import { resetFallbackPromotionStore } from "../utils/fallback-promotion";

const providers = ["primary", "backup"].map((name) => ({
  name,
  api_base_url: `https://${name}.invalid/v1/messages`,
  api_key: "fixture-key",
  models: [`${name}-model`],
  transformer: { use: ["Anthropic"] },
}));
const config = {
  providers,
  Router: { enableFallback: true, fallback: { default: ["backup,backup-model"] } },
};
let server: Server;

beforeEach(async () => {
  getHealthStore().clear();
  resetFallbackPromotionStore();
  server = new Server({ logger: false, useJsonFile: false, initialConfig: config });
  await server.ready();
  registerRequestPipeline(server, config);
  server.ccrPreHandlerCallbacks = createCcrPreHandlerCallbacks(config);
  await server.registerNamespace("/");
});

afterEach(async () => {
  try {
    await server.app.close();
  } finally {
    vi.unstubAllGlobals();
    getHealthStore().clear();
    resetFallbackPromotionStore();
  }
});

async function injectChat(stream: boolean, upstream: (model: string) => Response, useBackup = false) {
  const attempts: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: URL | string, init: RequestInit) => {
    const url = new URL(input);
    const { model } = JSON.parse(String(init.body));
    attempts.push(`${url.href} ${model}`);
    if (useBackup && model === "primary-model") {
      return Response.json({ error: { message: "fixture unavailable" } }, { status: 503 });
    }
    return upstream(model);
  }));
  const response = await server.app.inject({
    method: "POST", url: "/v1/chat/completions",
    payload: {
      model: "primary,primary-model", messages: [{ role: "user", content: "hello" }],
      stream, ...(stream && { stream_options: { include_usage: true } }),
    },
  });
  const primary = `${providers[0].api_base_url} primary-model`;
  expect(attempts).toEqual(useBackup ? [primary, primary, `${providers[1].api_base_url} backup-model`] : [primary]);
  expect(response.statusCode).toBe(200);
  return response;
}

const nativeUsage = { input_tokens: 11, output_tokens: 4 };
const chatUsage = { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 };
function messageStart(model: string) {
  return { type: "message_start", message: {
    type: "message", id: "msg-fixture", model, role: "assistant", content: [],
    stop_reason: null, stop_sequence: null, usage: { input_tokens: 11, output_tokens: 0 },
  } };
}
function messageEnd(stop_reason: "end_turn" | "tool_use") {
  return [
    { type: "message_delta", delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: 4 } },
    { type: "message_stop" },
  ];
}
const textBlock = [
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
  { type: "content_block_stop", index: 0 },
];
function toolBlock(index: number, id: string, name: string, args: string[]) {
  return [
    { type: "content_block_start", index, content_block: { type: "tool_use", id, name, input: {} } },
    ...args.map((partial_json) => ({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json } })),
    { type: "content_block_stop", index },
  ];
}
function nativeStream(events: Array<{ type: string }>) {
  const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function chatChunks(body: string, complete = true) {
  expect(body).not.toMatch(/^event: (message_|content_block_)/m);
  const frames = body.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim());
  expect(frames.filter((frame) => frame === "[DONE]")).toHaveLength(complete ? 1 : 0);
  if (complete) expect(frames.pop()).toBe("[DONE]");
  const chunks = frames.map((frame) => JSON.parse(frame));
  for (const chunk of chunks) expect(chunk).toMatchObject({ object: "chat.completion.chunk", choices: expect.any(Array) });
  return chunks;
}

function expectFinish(chunks: ReturnType<typeof chatChunks>, reason: string) {
  const choices = chunks.flatMap((chunk) => chunk.choices);
  expect(choices.filter((choice) => choice.finish_reason != null)).toHaveLength(1);
  expect(choices.at(-1)).toMatchObject({ index: 0, finish_reason: reason });
  for (const chunk of chunks.filter((chunk) => chunk.choices.length)) expect(chunk.usage).toBeNull();
  expect(chunks.map((chunk) => chunk.usage)).toContainEqual(expect.objectContaining(chatUsage));
}

describe("/v1/chat/completions with a native Anthropic upstream", () => {
  it("streams a primary end_turn as Chat content, stop, usage and [DONE]", async () => {
    const response = await injectChat(true, (model) => nativeStream([messageStart(model), ...textBlock, ...messageEnd("end_turn")]));
    expect(response.headers["content-type"]).toContain("text/event-stream");
    const chunks = chatChunks(response.body);
    const choices = chunks.flatMap((chunk) => chunk.choices);
    expect(choices.map((choice) => choice.delta.content ?? "").join("")).toBe("hello");
    expectFinish(chunks, "stop");
  });

  it.each(["\r", "\r\n"])("accepts native SSE with delimiter %j across reads", async (delimiter) => {
    const response = await injectChat(true, (model) => {
      const frames = [messageStart(model), ...textBlock, ...messageEnd("end_turn")];
      const parts = frames.flatMap((frame) => ["event: " + frame.type, "data: " + JSON.stringify(frame), ""]);
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        for (const line of parts) {
          controller.enqueue(new TextEncoder().encode(line + "\r"));
          if (delimiter.length === 2) controller.enqueue(Uint8Array.of(10));
        }
        controller.close();
      } });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    });
    const chunks = chatChunks(response.body);
    expect(chunks.flatMap(chunk => chunk.choices.map((c: any) => c.delta.content ?? "")).join("")).toBe("hello");
    expectFinish(chunks, "stop");
  });

  it("streams backup tool_use blocks as distinct Chat calls with fragmented arguments", async () => {
    const response = await injectChat(true, (model) => nativeStream([
      messageStart(model), ...textBlock,
      ...toolBlock(1, "id-a", "lookup", ['{"q":', '"tea"}']),
      ...toolBlock(2, "id-b", "count", ['{"n":', '2}']),
      ...messageEnd("tool_use"),
    ]), true);
    const chunks = chatChunks(response.body);
    const deltas = chunks.flatMap((chunk) => chunk.choices.flatMap((choice: any) => choice.delta.tool_calls ?? []));
    expect([...new Set(deltas.map((delta) => delta.index))]).toEqual([0, 1]);
    for (const [index, id, name, args] of [[0, "id-a", "lookup", '{"q":"tea"}'], [1, "id-b", "count", '{"n":2}']] as const) {
      const call = deltas.filter((delta) => delta.index === index);
      expect(call[0]).toMatchObject({ type: "function", id, function: { name } });
      const fragments = call.map((delta) => delta.function?.arguments).filter(Boolean);
      expect(fragments.length).toBeGreaterThan(1);
      expect(fragments.join("")).toBe(args);
    }
    expectFinish(chunks, "tool_calls");
  });

  it("preserves nonstream thinking separately from visible text and returns Chat usage", async () => {
    const response = await injectChat(false, (model) => Response.json({
      type: "message", id: "msg-fixture", role: "assistant", model,
      content: [{ type: "thinking", thinking: "consider", signature: "sig" }, { type: "text", text: "answer" }],
      stop_reason: "end_turn", stop_sequence: null, usage: nativeUsage,
    }));
    const completion = response.json();
    expect(completion).toMatchObject({ object: "chat.completion", usage: chatUsage, choices: [{
      index: 0, finish_reason: "stop", message: { role: "assistant", content: "answer" },
    }] });
    const message = completion.choices[0].message;
    expect(message.reasoning_content ?? message.thinking?.content).toBe("consider");
  });

  it("returns a nonstream backup tool_use as a named Chat function call", async () => {
    const response = await injectChat(false, (model) => Response.json({
      type: "message", id: "msg-fixture", role: "assistant", model,
      content: [{ type: "tool_use", id: "id-a", name: "lookup", input: { q: "tea" } }],
      stop_reason: "tool_use", stop_sequence: null, usage: nativeUsage,
    }), true);
    const completion = response.json();
    expect(completion).toMatchObject({ object: "chat.completion", usage: chatUsage, choices: [{
      index: 0, finish_reason: "tool_calls", message: { role: "assistant", tool_calls: [{
        type: "function", id: "id-a", function: { name: "lookup" },
      }] },
    }] });
    expect(JSON.parse(completion.choices[0].message.tool_calls[0].function.arguments)).toEqual({ q: "tea" });
  });

  it("preserves partial text without fabricating a finish or [DONE] at upstream EOF", async () => {
    const response = await injectChat(true, (model) => nativeStream([messageStart(model), ...textBlock]));
    const choices = chatChunks(response.body, false).flatMap((chunk) => chunk.choices);
    expect(choices.map((choice) => choice.delta.content ?? "").join("")).toBe("hello");
    expect(choices.filter((choice) => choice.finish_reason != null)).toEqual([]);
  });
});
