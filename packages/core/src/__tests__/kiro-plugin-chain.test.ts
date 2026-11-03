import { describe, it, expect, vi } from "vitest";
const { appendUsage } = vi.hoisted(() => ({ appendUsage: vi.fn() }));
vi.mock("../ccr/usage-store", () => ({ append: appendUsage, readTokenSpeedStats: () => ({ ttft: null, tokensPerSecond: null }) }));
import { registerRequestPipeline } from "../ccr/request-pipeline";
import { sessionUsageCache } from "../utils/cache";
import { AnthropicTransformer } from "../transformer/anthropic.transformer";
import { normalizeUsagePayload, mergeUsageCapture } from "../ccr/usage-merge";
// Real kiro plugin data plane (not a mock adapter): request mapping, AWS
// EventStream parsing and the unified Chat conversion all run for real here.
import { KiroTransformer } from "../../../plugins/kiro/src/transformer";

// Minimal AWS EventStream frame builder (mirrors the kiro plugin test helper).
function frame(kind: string, payload: object, exception = false): Uint8Array {
  const headers = Object.entries({
    ":message-type": exception ? "exception" : "event",
    [exception ? ":exception-type" : ":event-type"]: kind,
  }).map(([name, value]) => {
    const n = Buffer.from(name);
    const v = Buffer.from(value);
    const length = Buffer.alloc(2);
    length.writeUInt16BE(v.length);
    return Buffer.concat([Buffer.from([n.length]), n, Buffer.from([7]), length, v]);
  });
  const h = Buffer.concat(headers);
  const p = Buffer.from(JSON.stringify(payload));
  const prelude = Buffer.alloc(12);
  prelude.writeUInt32BE(16 + h.length + p.length);
  prelude.writeUInt32BE(h.length, 4);
  return Buffer.concat([prelude, h, p, Buffer.alloc(4)]);
}

function upstream(events: Array<[string, object]>): Response {
  const bytes = Buffer.concat(events.map(([kind, data]) => frame(kind, data)));
  return new Response(new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.subarray(i, i + 7));
      c.close();
    },
  }));
}

const noopLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const unifiedRequest = (stream: boolean) => ({
  model: "claude-routed",
  stream,
  messages: [{ role: "user", content: "hello" }],
});

/**
 * Run the REAL production chain:
 * kiro upstream frames -> KiroTransformer.transformResponseOut (unified Chat)
 * -> AnthropicTransformer.transformResponseIn (Anthropic Messages for the client).
 */
async function runChain(events: Array<[string, object]>, stream: boolean): Promise<Response> {
  const kiro = new KiroTransformer();
  const ctx: any = {};
  await kiro.transformRequestIn(unifiedRequest(stream), {}, ctx);
  const unified = await kiro.transformResponseOut(upstream(events), ctx);
  const anthropic = new AnthropicTransformer();
  anthropic.logger = noopLogger;
  return anthropic.transformResponseIn(unified, {
    req: { id: "chain-test", body: { model: "claude-routed" } },
  } as any);
}

interface AnthropicSseEvent {
  event: string;
  data: any;
}

async function collectAnthropicSse(response: Response): Promise<AnthropicSseEvent[]> {
  const out: AnthropicSseEvent[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() || "";
    for (const block of blocks) {
      let event = "";
      let dataLine = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7).trim();
        else if (line.startsWith("data: ")) dataLine = line.slice(6);
      }
      if (event && dataLine) {
        try {
          out.push({ event, data: JSON.parse(dataLine) });
        } catch {
          // ignore non-JSON data lines
        }
      }
    }
  }
  return out;
}

const EXACT_USAGE = {
  uncachedInputTokens: 12,
  outputTokens: 8,
  cacheReadInputTokens: 30,
  cacheWriteInputTokens: 4,
};

describe("kiro plugin -> core Anthropic transformer chain (usage integrity)", () => {
  it.each([true, false])("identifies exact Kiro usage independently of estimation (stream=%s)", async (stream) => {
    const kiro = new KiroTransformer();
    const ctx: any = {};
    await kiro.transformRequestIn(unifiedRequest(stream), {}, ctx);
    const unified = await kiro.transformResponseOut(upstream([
      ["assistantResponseEvent", { content: "ok" }],
      ["messageMetadataEvent", { tokenUsage: EXACT_USAGE }],
    ]), ctx);
    const payload = stream
      ? (await unified.text()).split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6))).find(chunk => chunk.usage)
      : await unified.json();
    expect(payload.usage.usage_source).toBe("kiro");
    expect(payload.usage.kiro_estimated).toBeUndefined();
  });
  it("carries cache_creation_input_tokens through the streaming chain (message_delta)", async () => {
    const response = await runChain([
      ["assistantResponseEvent", { content: "ok" }],
      ["messageMetadataEvent", { tokenUsage: EXACT_USAGE }],
    ], true);
    const events = await collectAnthropicSse(response);
    const delta = events.find((e) => e.event === "message_delta");
    expect(delta).toBeDefined();
    expect(delta!.data.usage).toMatchObject({
      input_tokens: 12,
      output_tokens: 8,
      cache_read_input_tokens: 30,
      // Was hardcoded to 0 before the fix: real cache-write counts vanished.
      cache_creation_input_tokens: 4,
    });
    expect(delta!.data.usage.usage_estimated).toBeUndefined();
  });

  it("carries cache_creation_input_tokens through the non-stream chain", async () => {
    const response = await runChain([
      ["assistantResponseEvent", { content: "ok" }],
      ["messageMetadataEvent", { tokenUsage: EXACT_USAGE }],
    ], false);
    const body = await response.json();
    expect(body.usage).toMatchObject({
      input_tokens: 12,
      output_tokens: 8,
      cache_read_input_tokens: 30,
      // Was hardcoded to 0 before the fix.
      cache_creation_input_tokens: 4,
    });
    expect(body.usage.usage_estimated).toBeUndefined();
  });

  it("marks estimated usage in the streaming chain so stats can tell estimates from metered values", async () => {
    // No tokenUsage from upstream: the plugin derives an estimate and tags it.
    const response = await runChain([
      ["assistantResponseEvent", { content: "hello" }],
    ], true);
    const events = await collectAnthropicSse(response);
    const delta = events.find((e) => e.event === "message_delta");
    expect(delta).toBeDefined();
    expect(delta!.data.usage.output_tokens).toBeGreaterThan(0);
    // The kiro_estimated marker previously died inside the core mapping.
    expect(delta!.data.usage.usage_estimated).toBe(true);
  });

  it("marks estimated usage in the non-stream chain", async () => {
    const response = await runChain([
      ["assistantResponseEvent", { content: "hello" }],
    ], false);
    const body = await response.json();
    expect(body.usage.usage_estimated).toBe(true);
  });

  it("keeps the estimated flag and cache-write counts intact through usage capture", async () => {
    const response = await runChain([
      ["assistantResponseEvent", { content: "hello" }],
    ], true);
    const events = await collectAnthropicSse(response);
    const delta = events.find((e) => e.event === "message_delta");
    const normalized = normalizeUsagePayload(delta!.data.usage);
    expect(normalized.usage_estimated).toBe(true);
    const merged = mergeUsageCapture({}, normalized, false);
    expect(merged.usage_estimated).toBe(true);

    // Exact (metered) usage must NOT be flagged.
    const exact = normalizeUsagePayload({
      input_tokens: 12,
      output_tokens: 8,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 4,
    });
    expect(exact.usage_estimated).toBeUndefined();
    expect(mergeUsageCapture({}, exact, false).usage_estimated).toBeUndefined();
  });

  it("keeps unreported cache creation at zero without marking exact Kiro usage estimated", async () => {
    // Backward compatibility: a provider that never reports cache creation or
    // an estimate must still produce the same usage shape as before.
    const kiro = new KiroTransformer();
    const ctx: any = {};
    await kiro.transformRequestIn(unifiedRequest(true), {}, ctx);
    const unified = await kiro.transformResponseOut(upstream([
      ["assistantResponseEvent", { content: "ok" }],
      ["messageMetadataEvent", { tokenUsage: { uncachedInputTokens: 5, outputTokens: 2 } }],
    ]), ctx);
    const anthropic = new AnthropicTransformer();
    anthropic.logger = noopLogger;
    const response = await anthropic.transformResponseIn(unified, {
      req: { id: "chain-test", body: { model: "claude-routed" } },
    } as any);
    const events = await collectAnthropicSse(response);
    const delta = events.find((e) => e.event === "message_delta");
    expect(delta!.data.usage).toEqual({
      input_tokens: 5,
      output_tokens: 2,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
  });
});


describe("kiro -> core transformer -> request pipeline statistics", () => {
  it.each([true, false])("captures cache creation and preserves estimated status in recorded stats (stream=%s)", async (stream) => {
    const hooks = new Map<string, Function[]>();
    registerRequestPipeline({ addHook(name: string, hook: Function) {
      hooks.set(name, [...(hooks.get(name) ?? []), hook]);
    } }, {});
    for (const estimated of [true, false]) {
      const response = await runChain([
        ["assistantResponseEvent", { content: "hello" }],
        ...(estimated ? [] : [["messageMetadataEvent", { tokenUsage: EXACT_USAGE }]] as Array<[string, object]>),
      ], stream);
      const key = `kiro-pipeline-${stream}-${estimated}`;
      const req = {
        id: key, pathname: "/v1/messages", body: unifiedRequest(stream), provider: "kiro",
        usageCacheKey: key, usageSessionId: key, clientContext: { usageScope: "request" },
        tokenCount: 1000, log: noopLogger,
      };
      const reply = { statusCode: 200 };
      const payload = stream ? response.body! : await response.text();
      const mapped = await new Promise<ReadableStream | string>((resolve, reject) => {
        hooks.get("onSend")![0](req, reply, payload, (error: unknown, result: ReadableStream | string) => error ? reject(error) : resolve(result));
      });
      if (mapped instanceof ReadableStream) await new Response(mapped).text();
      await (req as any).usageCapturePromise;
      const captured = sessionUsageCache.get(key);
      expect(captured.usage_estimated === true).toBe(estimated);
      expect(captured.cache_creation_input_tokens).toBe(estimated ? 0 : 4);
      await hooks.get("onResponse")![0](req, reply);
      expect(appendUsage).toHaveBeenLastCalledWith(expect.objectContaining(estimated ? {
        usageEstimated: true,
        inputTokens: captured.input_tokens,
        outputTokens: 2,
        // Do not invent cache hits by subtracting two independent estimates.
        cacheReadInputTokens: 0,
      } : {
        inputTokens: 12,
        outputTokens: 8,
        cacheReadInputTokens: 30,
        cacheCreationInputTokens: 4,
      }));
      if (!estimated) expect(appendUsage.mock.lastCall![0].usageEstimated).toBeUndefined();
    }
  });
});

const ordinaryUsageMatrix = [
  { prompt_tokens: 50, completion_tokens: 3 },
  { prompt_tokens: 50, completion_tokens: 3, cache_creation_input_tokens: 7 },
  { prompt_tokens: 50, completion_tokens: 3, prompt_tokens_details: { cache_creation_tokens: 7 } },
  { prompt_tokens: 50, completion_tokens: 3, input_tokens_details: { cache_write_tokens: 7 } },
];

describe("ordinary provider cache creation compatibility with the pre-M5 baseline", () => {
  it.each(ordinaryUsageMatrix)("preserves non-stream usage for %j", async (usage) => {
    const transformer = new AnthropicTransformer();
    transformer.logger = noopLogger;
    const response = await transformer.transformResponseIn(Response.json({
      id: "msg_ordinary", model: "ordinary-provider-model",
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage,
    }), { req: { id: "ordinary" } } as any);
    const body = await response.json();
    // Frozen complete usage from eb0db5b; non-stream always had creation=0.
    expect(body.usage).toEqual({
      input_tokens: 50, output_tokens: 3, cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
      service_tier: "standard",
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
      inference_geo: "", iterations: [], speed: "standard",
    });
  });

  it.each(ordinaryUsageMatrix)("preserves streaming usage, including trailing zeros, for %j", async (usage) => {
    const transformer = new AnthropicTransformer();
    transformer.logger = noopLogger;
    const chunks = [
      { id: "chatcmpl-ordinary", model: "ordinary-provider-model", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }], usage },
      { id: "chatcmpl-ordinary", model: "ordinary-provider-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 0, completion_tokens: 0 } },
    ];
    const upstream = new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream" },
    });
    const response = await transformer.transformResponseIn(upstream, { req: { id: "ordinary" } } as any);
    const delta = (await collectAnthropicSse(response)).find(event => event.event === "message_delta");
    // Streaming never emitted a creation field, including when merging frames.
    expect(delta?.data.usage).toEqual({ input_tokens: 50, output_tokens: 3, cache_read_input_tokens: 0 });
  });
});

it("preserves ordinary provider cache-read inference without an estimated marker", async () => {
  const hooks = new Map<string, Function[]>();
  registerRequestPipeline({ addHook(name: string, hook: Function) {
    hooks.set(name, [...(hooks.get(name) ?? []), hook]);
  } }, {});
  const key = "ordinary-inferred-cache";
  sessionUsageCache.put(key, { input_tokens: 50, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  const req = {
    id: key, pathname: "/v1/messages", body: unifiedRequest(false), provider: "ordinary",
    usageCacheKey: key, usageSessionId: key, clientContext: { usageScope: "request" },
    tokenCount: 100, log: noopLogger,
  };
  await hooks.get("onResponse")![0](req, { statusCode: 200 });
  expect(appendUsage).toHaveBeenLastCalledWith(expect.objectContaining({
    inputTokens: 50, outputTokens: 3, cacheReadInputTokens: 50, cacheCreationInputTokens: 0,
  }));
  expect(appendUsage.mock.lastCall![0]).not.toHaveProperty("usageEstimated");
});

it("preserves an ordinary OpenAI-compatible provider's usage semantics", async () => {
  const transformer = new AnthropicTransformer();
  transformer.logger = noopLogger;
  const response = await transformer.transformResponseIn(Response.json({
    id: "chatcmpl-plain", model: "plain", choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 50, completion_tokens: 3 },
  }), { req: { id: "plain" } } as any);
  const body = await response.json();
  expect(body.usage).toMatchObject({ input_tokens: 50, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
  expect(body.usage.usage_estimated).toBeUndefined();
});
