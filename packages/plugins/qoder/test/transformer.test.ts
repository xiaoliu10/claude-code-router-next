import { describe, expect, it, vi } from "vitest";
import { QoderTransformer } from "../src/transformer";

const sse = (events: any[], done = true): Response =>
  new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : ""),
    { headers: { "content-type": "text/event-stream" } });
const json = (body: any): Response => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

/** A fresh 3-byte-split stream per lane: exercises UTF-8/chunk-boundary reassembly. */
function chunked(wire: string): Response {
  const bytes = new TextEncoder().encode(wire);
  let offset = 0;
  return new Response(new ReadableStream({
    pull(c) { if (offset >= bytes.length) c.close(); else c.enqueue(bytes.slice(offset, offset += 3)); },
  }), { headers: { "content-type": "text/event-stream" } });
}
const streamed = async (response: Response): Promise<string> => await response.text();

describe("QoderTransformer request seam", () => {
  it("mirrors cursorRequest: system leading message, thinking mapping, session and effort", async () => {
    const transform = new QoderTransformer();
    const request = {
      model: "qoder-max",
      system: [{ type: "text", text: "be brief" }, { type: "image", url: "x" }],
      reasoning: { effort: "high", other: "dropped" },
      prompt_cache_key: "own-session",
      messages: [
        { role: "assistant", thinking: { content: "hmm" }, reasoning_content: null },
        { role: "assistant", reasoning_content: "" },
        { role: "assistant", reasoning_content: "kept" },
        { role: "user", content: "hello" },
      ],
    };
    const result = await transform.transformRequestIn(request, undefined, { req: { clientContext: { stableSessionId: "ctx-session" } } });
    const body = result.body;
    expect(body.messages[0]).toEqual({ role: "system", content: "be brief" });
    expect(body.messages[1].reasoning_content).toBe("hmm");
    expect(body.messages[1].thinking).toBeUndefined();
    expect(body.messages[2].reasoning_content).toBeUndefined();
    expect(body.messages[3].reasoning_content).toBe("kept");
    expect(body.prompt_cache_key).toBe("own-session");
    expect(body.reasoning_effort).toBe("high");
    expect(body.reasoning).toBeUndefined();
    expect(body.system).toBeUndefined();
    // structuredClone: the caller's request is never mutated
    expect(request.messages[0].reasoning_content).toBeNull();
    expect(request.reasoning.effort).toBe("high");
  });

  it("caps a caller-provided prompt_cache_key like a derived session id", async () => {
    const transform = new QoderTransformer();
    const tooLong = await transform.transformRequestIn({ model: "m", messages: [], prompt_cache_key: "k".repeat(1025) });
    expect(tooLong.body.prompt_cache_key).toBeUndefined();
    const edge = await transform.transformRequestIn({ model: "m", messages: [], prompt_cache_key: "k".repeat(1024) });
    expect(edge.body.prompt_cache_key).toHaveLength(1024);
  });

  it("session falls back to the stable client session id; the cap gates the derived id only", async () => {
    const transform = new QoderTransformer();
    const fromContext = await transform.transformRequestIn({ model: "m", messages: [] }, undefined, { req: { clientContext: { stableSessionId: "stable-1" } } });
    expect(fromContext.body.prompt_cache_key).toBe("stable-1");
    // an over-long derived session id is not installed as the cache key
    const tooLong = await transform.transformRequestIn({ model: "m", messages: [] }, undefined, { req: { clientContext: { stableSessionId: "x".repeat(1025) } } });
    expect(tooLong.body.prompt_cache_key).toBeUndefined();
    const edge = await transform.transformRequestIn({ model: "m", messages: [] }, undefined, { req: { clientContext: { stableSessionId: "x".repeat(1024) } } });
    expect(edge.body.prompt_cache_key).toHaveLength(1024);
  });
});

describe("QoderTransformer non-stream responses", () => {
  const completion = { id: "c1", object: "chat.completion", model: "qoder-max", choices: [
    { index: 0, message: { role: "assistant", content: "hi", reasoning_content: "thought" }, finish_reason: "stop" },
  ], usage: { prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 2 }, completion_tokens: 5 } };

  it("validates shape, maps thinking and usage, heals the latch once", async () => {
    const heal = vi.fn();
    const out = await new QoderTransformer(undefined, undefined, heal).transformResponseOut(json(completion));
    const event = await out.json();
    expect(event.choices[0].message.thinking).toEqual({ content: "thought" });
    expect(event.choices[0].message.reasoning_content).toBeUndefined();
    // inclusive prompt is identity; cache-write mirrors creation
    expect(event.usage.prompt_tokens).toBe(10);
    expect(event.usage.cache_creation_input_tokens).toBe(2);
    expect(heal).toHaveBeenCalledTimes(1);
  });

  it("restores inclusivity when a net-emitting vendor sits below its own cache detail", async () => {
    const net = { ...completion, usage: { prompt_tokens: 4, prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 2 } } };
    const event = await new (QoderTransformer as any)().transformResponseOut(json(net)).then((r: Response) => r.json());
    // net 4 + cached 4 + written 2 restores the inclusive 10
    expect(event.usage.prompt_tokens).toBe(10);
  });

  it("rejects empty choices and hidden error envelopes with classified codes", async () => {
    await expect(new QoderTransformer().transformResponseOut(json({ choices: [{ index: 0, message: { role: "assistant", content: "" } }] })))
      .rejects.toMatchObject({ code: "qoder_upstream_error", statusCode: 502 });
    await expect(new QoderTransformer().transformResponseOut(json({ error: { message: "quota", code: 429 } })))
      .rejects.toMatchObject({ code: "qoder_rate_limited", statusCode: 429 });
    await expect(new QoderTransformer().transformResponseOut(json({ error: { message: "token rejected", code: 401 } })))
      .rejects.toMatchObject({ code: "qoder_reauth_required", statusCode: 401 });
  });

  it("classifies non-OK responses through the shared taxonomy (body retry_after honored)", async () => {
    const transform = new QoderTransformer();
    await expect(transform.transformResponseOut(new Response(
      JSON.stringify({ error: { type: "qoder_error" }, retry_after: 45 }), { status: 429, headers: { "content-type": "application/json" } })))
      .rejects.toMatchObject({ code: "qoder_rate_limited", statusCode: 429, cooldownMs: 45_000 });
    await expect(transform.transformResponseOut(new Response("nope", { status: 503 })))
      .rejects.toMatchObject({ code: "qoder_upstream_error", statusCode: 503 });
  });
});

describe("QoderTransformer SSE seam", () => {
  const frames = [
    { id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
    { id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { reasoning_content: "hmm" }, finish_reason: null }] },
    { id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "你好" }, finish_reason: null }] },
    { id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3 } },
  ];

  it("passes validated streams through byte-safely, maps thinking, heals on [DONE]", async () => {
    const heal = vi.fn();
    const wire = frames.map(e => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
    const out = await new QoderTransformer(undefined, undefined, heal).transformResponseOut(chunked(wire));
    const text = await streamed(out);
    expect(text).toContain("你好");
    expect(text).toContain("thinking");
    expect(text).toContain("[DONE]");
    expect(heal).toHaveBeenCalledTimes(1);
  });

  it("routes terminal error frames through the note callback and fails the stream", async () => {
    const notes: any[] = []; const heal = vi.fn();
    const transform = new QoderTransformer(undefined, info => { notes.push(info); }, heal);
    const limited = await transform.transformResponseOut(sse([
      { id: "c1", choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }] },
      { error: { message: "usage limit", code: 429, retry_after: 90 } },
    ]));
    await expect(streamed(limited)).rejects.toMatchObject({ code: "qoder_rate_limited", statusCode: 429 });
    expect(notes).toEqual([{ code: "qoder_rate_limited", httpStatus: 429, cooldownMs: 90_000 }]);
    expect(heal).not.toHaveBeenCalled();

    const auth = await new QoderTransformer(undefined, info => notes.push(info)).transformResponseOut(sse([{ error: { message: "sign in", code: 401 } }]));
    await expect(streamed(auth)).rejects.toMatchObject({ code: "qoder_reauth_required", statusCode: 401 });
    const other = await new QoderTransformer(undefined, info => notes.push(info)).transformResponseOut(sse([{ error: { message: "boom", code: 502 } }]));
    await expect(streamed(other)).rejects.toMatchObject({ code: "qoder_upstream_error", statusCode: 502 });
    // message-text ties break unknown codes toward quota/auth evidence
    const texty = await new QoderTransformer(undefined, info => notes.push(info)).transformResponseOut(sse([{ error: { message: "quota exhausted" } }]));
    await expect(streamed(texty)).rejects.toMatchObject({ code: "qoder_rate_limited" });
    expect(notes).toHaveLength(4);
  });

  it("[DONE] without visible content or without finish_reason is a truncation failure", async () => {
    const transform = new QoderTransformer();
    await expect(streamed(await transform.transformResponseOut(sse([{ id: "c", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }]))))
      .rejects.toMatchObject({ statusCode: 502 });
    await expect(streamed(await transform.transformResponseOut(sse([{ id: "c", choices: [{ index: 0, delta: { content: "words" }, finish_reason: null }] }]))))
      .rejects.toMatchObject({ statusCode: 502 });
  });

  it("early EOF and oversized pending buffers fail closed", async () => {
    const transform = new QoderTransformer();
    await expect(streamed(await transform.transformResponseOut(sse(frames, false))))
      .rejects.toMatchObject({ code: "qoder_stream_truncated", statusCode: 502 });
    await expect(streamed(await transform.transformResponseOut(sse([]))))
      .rejects.toMatchObject({ statusCode: 502 });
    const huge = new Response(new ReadableStream({
      pull(c) { c.enqueue(new TextEncoder().encode("x".repeat(1_048_577))); },
    }), { headers: { "content-type": "text/event-stream" } });
    await expect(streamed(await transform.transformResponseOut(huge)))
      .rejects.toMatchObject({ code: "qoder_stream_invalid", statusCode: 502 });
  });

  it("rejects a single delimited frame over the 1 MiB cap", async () => {
    const big = { id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "x".repeat(1_100_000) }, finish_reason: null }] };
    const wire = new TextEncoder().encode(`data: ${JSON.stringify(big)}\n\n`);
    // one whole chunk: the 3-byte slicer would need 360k pulls for 1.1 MB
    const response = await new QoderTransformer().transformResponseOut(new Response(new ReadableStream({
      pull(c) { c.enqueue(wire); c.close(); },
    }), { headers: { "content-type": "text/event-stream" } }));
    await expect(streamed(response)).rejects.toMatchObject({ code: "qoder_stream_invalid", statusCode: 502 });
  });

  it("propagates consumer cancellation to the upstream reader", async () => {
    const cancel = vi.fn();
    const response = await new QoderTransformer().transformResponseOut(new Response(new ReadableStream({ cancel }), { headers: { "content-type": "text/event-stream" } }));
    await response.body!.cancel("fixture-disconnect");
    expect(cancel).toHaveBeenCalledWith("fixture-disconnect");
  });
});
