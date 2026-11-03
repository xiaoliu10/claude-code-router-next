import { describe, it, expect, vi } from "vitest";
import { buildKiro, kiroResponse, requestState, KiroTransformer, kiroToolName } from "../src/transformer";
import { createKiroManagedRuntime } from "../src/managed-runtime";
import type { KiroAuthService } from "../src/auth-service";

function frame(kind: string, payload: object, exception = false) {
  const headers = Object.entries({ ":message-type": exception ? "exception" : "event", [exception ? ":exception-type" : ":event-type"]: kind }).map(([name, value]) => {
    const n = Buffer.from(name), v = Buffer.from(value), length = Buffer.alloc(2); length.writeUInt16BE(v.length);
    return Buffer.concat([Buffer.from([n.length]), n, Buffer.from([7]), length, v]);
  });
  const h = Buffer.concat(headers), p = Buffer.from(JSON.stringify(payload)), prelude = Buffer.alloc(12);
  prelude.writeUInt32BE(16 + h.length + p.length); prelude.writeUInt32BE(h.length, 4);
  return Buffer.concat([prelude, h, p, Buffer.alloc(4)]);
}
function upstream(events: Array<[string, object]>, split = 7) {
  const bytes = Buffer.concat(events.map(([kind, data]) => frame(kind, data)));
  return new Response(new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += split) c.enqueue(bytes.subarray(i, i + split)); c.close(); } }));
}
const req = { model: "claude-routed", stream: true, messages: [{ role: "user", content: "hello" }] };
function setup(region = "eu-central-1", statuses = [200]) {
  const credential = { id: "account", region, profile: "", access: "first" };
  const service = { getCredential: vi.fn(async () => credential), forceTokenRefresh: vi.fn(async () => ({ ...credential, access: "renewed" })), ensureUsable: vi.fn(), noteUpstreamError: vi.fn() };
  const dispatcher = {}, host: any = { getSubscriptionDispatcher: () => dispatcher, getDirectDispatcher: () => ({}) };
  const network = vi.fn(async () => Response.json({ reason: "failure" }, { status: statuses.shift() ?? 200 }));
  const rt = createKiroManagedRuntime(service as unknown as KiroAuthService, host, network as typeof fetch);
  const dispatch = () => rt.dispatchRequest!({ requestBody: buildKiro(req, req.model), config: {}, req: {}, provider: {} as any, attempt: vi.fn() });
  return { service, host, network, rt, dispatcher, dispatch };
}

describe("Kiro request mapping", () => {
  it("maps system, history, tools and tool results without changing caller data", () => {
    const request = { ...req, system: [{ type: "text", text: "instructions" }], tools: [{ name: "read", input_schema: {} }], messages: [req.messages[0], { role: "assistant", content: [{ type: "thinking", thinking: "private" }, { type: "tool_use", id: "call", name: "read", input: { path: "a" } }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "call", content: "result" }] }] };
    const before = structuredClone(request), body = buildKiro(request, "routed", "profile");
    expect(request).toEqual(before);
    expect(body.profileArn).toBe("profile");
    expect(body.conversationState.history[0].userInputMessage.content).toBe("instructions\n\nhello");
    expect(body.conversationState.history[1].assistantResponseMessage).toEqual({ content: "", toolUses: [{ name: "read", toolUseId: "call", input: { path: "a" } }] });
    expect(body.conversationState.currentMessage.userInputMessage).toMatchObject({ modelId: "routed", userInputMessageContext: { toolResults: [{ toolUseId: "call", status: "success", content: [{ text: "result" }] }], tools: [{ toolSpecification: { name: "read", inputSchema: { json: { type: "object", properties: {} } } } }] } });
  });
  it("repairs interrupted results and restores long tool names", async () => {
    const name = "mcp__" + "long".repeat(30), request = { ...req, tools: [{ name, input_schema: {} }], messages: [req.messages[0], { role: "assistant", content: [{ type: "tool_use", id: "call", name, input: {} }] }] };
    const body = buildKiro(request, req.model);
    expect(body.conversationState.currentMessage.userInputMessage.userInputMessageContext.toolResults[0].status).toBe("error");
    const response = await kiroResponse(upstream([["toolUseEvent", { toolUseId: "call", name: kiroToolName(name), input: "{}", stop: true }]]), requestState(request));
    expect(await response.text()).toContain(name);
  });
  it("accepts CCR unified tools/results and reasoning", async () => {
    const transformer = new KiroTransformer(), context: any = {};
    const result = await transformer.transformRequestIn({ ...req, reasoning: { enabled: true, max_tokens: 2000 }, tools: [{ type: "function", function: { name: "read", parameters: {} } }], messages: [req.messages[0], { role: "assistant", content: null, tool_calls: [{ id: "c", function: { name: "read", arguments: "{}" } }] }, { role: "tool", tool_call_id: "c", content: "ok" }] }, {}, context);
    expect(result.body.conversationState.history[0].userInputMessage.content).toContain("<max_thinking_length>2000");
    const response = await transformer.transformResponseOut(upstream([["assistantResponseEvent", { content: "ok" }]]), context);
    const text = await response.text(); expect(text).toContain('"finish_reason":"stop"'); expect(text).toContain('"prompt_tokens":'); expect(text).toContain("[DONE]");
  });
  it("rejects a missing routed model and unsupported hosted tools", () => {
    expect(() => requestState({ messages: [] })).toThrow();
    expect(() => buildKiro({ ...req, tools: [{ type: "web_search_20250305", name: "web_search" }] }, req.model)).toThrow();
  });
});

describe("Kiro eventstream", () => {
  it("converts fragmented text/thinking/tool deltas and attaches exact usage to terminal frames", async () => {
    const state = requestState({ ...req, thinking: { type: "enabled" } });
    const response = await kiroResponse(upstream([
      ["assistantResponseEvent", { modelId: "actual-model", content: "<thin" }], ["assistantResponseEvent", { content: "king>reason</think" }], ["assistantResponseEvent", { content: "ing>answer" }],
      ["toolUseEvent", { toolUseId: "call", name: "read", input: '{"path":' }], ["toolUseEvent", { input: '"a"}', stop: true }],
      ["messageMetadataEvent", { tokenUsage: { uncachedInputTokens: 12, outputTokens: 8, cacheReadInputTokens: 30, cacheWriteInputTokens: 4 } }],
    ]), state);
    const text = await response.text();
    expect(text).toContain('"model":"actual-model"'); expect(text).toContain('"thinking":"reason"'); expect(text).toContain('"text":"answer"'); expect(text).toContain("input_json_delta");
    const terminal = text.split("\n").filter(l => l.startsWith("data:")).map(l => JSON.parse(l.slice(5))).filter(e => e.type === "message_delta" || e.type === "message_stop");
    expect(terminal).toHaveLength(2);
    for (const e of terminal) expect(e.usage).toEqual({ input_tokens: 12, output_tokens: 8, cache_read_input_tokens: 30, cache_creation_input_tokens: 4 });
    expect(terminal[0].delta.stop_reason).toBe("tool_use");
  });
  it("uses routed model and estimates missing counters, using known context size when available", async () => {
    const state = requestState(req); state.contextWindow = 200000;
    const response = await kiroResponse(upstream([["assistantResponseEvent", { content: "hello" }], ["contextUsageEvent", { contextUsagePercentage: 5 }]]), state);
    const text = await response.text(); expect(text).toContain(req.model); expect(text).not.toContain("unknown"); expect(text).toContain('"input_tokens":10000,"output_tokens":2,"kiro_estimated":true');
  });
  it("assembles nonstream text, native reasoning, signatures and tools", async () => {
    const response = await kiroResponse(upstream([["reasoningContentEvent", { text: "reason" }], ["reasoningContentEvent", { signature: "sig" }], ["assistantResponseEvent", { content: "ok" }], ["supplementaryWebLinksEvent", { links: [{ url: "https://example.com" }] }], ["toolUseEvent", { toolUseId: "c", name: "read", input: { path: "a" } }]]), requestState({ ...req, stream: false }));
    expect(await response.json()).toMatchObject({ model: req.model, stop_reason: "tool_use", content: [{ type: "thinking", thinking: "reason", signature: "sig" }, { type: "text", text: "ok" }, { type: "tool_use", input: { path: "a" } }] });
  });
  it.each([[400, "CONTENT_LENGTH_EXCEEDS_THRESHOLD", 400], [400, "INSUFFICIENT_MODEL_CAPACITY", 503], [403, "USAGE_LIMIT", 429], [401, "invalid", 401]])("maps HTTP %s %s to %s", async (status, reason, expected) => {
    await expect(kiroResponse(Response.json({ reason }, { status }), requestState(req))).rejects.toMatchObject({ statusCode: expected });
  });
  it("estimates nullable upstream counters and respects explicit disabled thinking", async () => {
    const request = { ...req, thinking: { type: "disabled" }, reasoning: { effort: "high" } };
    expect(buildKiro(request, req.model).conversationState.currentMessage.userInputMessage.content).not.toContain("thinking_mode");
    const response = await kiroResponse(upstream([["assistantResponseEvent", { content: "hello" }], ["messageMetadataEvent", { tokenUsage: { inputTokens: null, outputTokens: null } }]]), requestState(request));
    expect(await response.text()).toContain('"kiro_estimated":true');
  });
  it("propagates downstream cancellation before the first response pull", async () => {
    const cancel = vi.fn();
    const bytes = frame("assistantResponseEvent", { content: "hello" });
    const response = new Response(new ReadableStream({ start(c) { c.enqueue(bytes); }, cancel }));
    const mapped = await kiroResponse(response, requestState(req));
    await mapped.body!.cancel();
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("rejects malformed/truncated frames and stream exceptions", async () => {
    await expect(kiroResponse(new Response(frame("throttlingException", {}, true)), requestState(req))).rejects.toMatchObject({ statusCode: 429 });
    await expect(kiroResponse(new Response(frame("assistantResponseEvent", { content: "ok" }).subarray(0, 20)), requestState(req))).rejects.toMatchObject({ code: "kiro_stream_truncated" });
    await expect(kiroResponse(new Response(Buffer.alloc(12)), requestState(req))).rejects.toMatchObject({ code: "kiro_stream_invalid" });
  });
});

describe("Kiro data-plane regressions", () => {
  it("ignores the empty-object tool placeholder so incremental JSON stays valid (nonstream)", async () => {
    const events: Array<[string, object]> = [
      ["toolUseEvent", { toolUseId: "c", name: "read", input: {} }],
      ["toolUseEvent", { input: '{"path":' }],
      ["toolUseEvent", { input: '"a"}', stop: true }],
    ];
    const response = await kiroResponse(upstream(events), requestState({ ...req, stream: false }));
    const json = await response.json();
    const tool = json.content.find((b: any) => b.type === "tool_use");
    expect(tool).toBeDefined();
    expect(tool.input).toEqual({ path: "a" });
  });
  it("keeps an empty arguments object parseable when the tool has no input", async () => {
    const response = await kiroResponse(upstream([
      ["toolUseEvent", { toolUseId: "c", name: "read", input: {} }],
      ["toolUseEvent", { stop: true }],
    ]), requestState({ ...req, stream: false }));
    const json = await response.json();
    expect(json.content.find((b: any) => b.type === "tool_use").input).toEqual({});
  });
  it("ignores the empty-object tool placeholder so streamed deltas reassemble the original arguments", async () => {
    const response = await kiroResponse(upstream([
      ["toolUseEvent", { toolUseId: "c", name: "read", input: {} }],
      ["toolUseEvent", { input: '{"path":' }],
      ["toolUseEvent", { input: '"a"}', stop: true }],
    ]), requestState(req));
    const events = (await response.text()).split("\n").filter(l => l.startsWith("data:")).map(l => JSON.parse(l.slice(5)));
    const partials = events.filter((e: any) => e.delta?.type === "input_json_delta").map((e: any) => e.delta.partial_json).join("");
    expect(JSON.parse(partials)).toEqual({ path: "a" });
  });
  it("cancels the upstream while a read is pending and does not penalize the account", async () => {
    let upstreamCancel = 0;
    const gated = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(frame("assistantResponseEvent", { content: "hello" })); },
      cancel() { upstreamCancel++; },
    });
    const service = { getStatus: vi.fn(async () => ({ models: [] })), noteUpstreamError: vi.fn() };
    const transformer = new KiroTransformer(service as unknown as KiroAuthService);
    const context: any = {};
    await transformer.transformRequestIn(req, {}, context);
    const mapped = await transformer.transformResponseOut(new Response(gated), context);
    const reader = mapped.body!.getReader();
    // Drain visible events until the mapped stream parks on the silent upstream read.
    for (;;) {
      const step = await Promise.race([reader.read(), new Promise(r => setTimeout(() => r("parked"), 50))]);
      if (step === "parked" || step.done) break;
    }
    const cancelled = await Promise.race([reader.cancel("client gone").then(() => "cancelled"), new Promise(r => setTimeout(() => r("cancel-stuck"), 300))]);
    expect(cancelled).toBe("cancelled");
    expect(upstreamCancel).toBe(1);
    expect(service.noteUpstreamError).not.toHaveBeenCalled();
  });
  it("disambiguates alias collisions instead of silently dropping one of two tools", async () => {
    const long = "mcp__" + "long".repeat(30), twin = kiroToolName(long);
    expect(twin).not.toBe(long);
    const request = { ...req, stream: false, tools: [{ name: long, input_schema: {} }, { name: twin, input_schema: {} }], messages: [req.messages[0], { role: "assistant", content: [{ type: "tool_use", id: "old1", name: long, input: {} }, { type: "tool_use", id: "old2", name: twin, input: {} }] }] };
    const state = requestState(request);
    const body = buildKiro(request, req.model);
    const offered = body.conversationState.currentMessage.userInputMessage.userInputMessageContext.tools.map((t: any) => t.toolSpecification.name);
    expect(offered).toHaveLength(2);
    expect(new Set(offered).size).toBe(2);
    expect(offered).toContain(twin);
    const alias2 = state.aliases.get(twin)!;
    expect(alias2).not.toBe(twin);
    expect(requestState(request).aliases).toEqual(state.aliases);
    expect(body.conversationState.history[1].assistantResponseMessage.toolUses.map((t: any) => t.name)).toEqual([twin, alias2]);
    for (const alias of offered) expect(alias).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    const response = await kiroResponse(upstream([
      ["toolUseEvent", { toolUseId: "c1", name: twin, input: '{"a":1}', stop: true }],
      ["toolUseEvent", { toolUseId: "c2", name: alias2, input: '{"b":2}', stop: true }],
    ]), state);
    const restored = (await response.json()).content.filter((b: any) => b.type === "tool_use").map((b: any) => b.name);
    expect(restored).toEqual([long, twin]);
  });
  it.each([
    [{ type: ["object", "null"], properties: {} }, "object"],
    [{ type: ["null", "object"], properties: {} }, "object"],
    [{ type: ["object", "string"], properties: {} }, ["object", "string"]],
    [{ type: ["string", "null"] }, ["string", "null"]],
    [{ type: "string" }, "string"],
    [{ properties: {} }, "object"],
  ])("narrows only object/null root unions: %j", (schema, expected) => {
    const body = buildKiro({ ...req, tools: [{ name: "t", input_schema: schema }] }, req.model);
    expect(body.conversationState.currentMessage.userInputMessage.userInputMessageContext.tools[0].toolSpecification.inputSchema.json.type).toEqual(expected);
  });
});

describe("Kiro transport", () => {
  it.each(["us-east-1", "eu-central-1", "eu-west-1"])("uses regional fixed origin and identity encoding: %s", async region => {
    const f = setup(region); const response = await f.dispatch(); await response.text();
    const [url, init] = f.network.mock.calls[0] as unknown as [string, any];
    expect(url).toBe(`https://runtime.${region}.kiro.dev/generateAssistantResponse`);
    expect(init.dispatcher).toBe(f.dispatcher); expect(init.redirect).toBe("error");
    expect(init.headers).toMatchObject({ Authorization: "Bearer first", "Accept-Encoding": "identity", "x-amzn-kiro-agent-mode": "vibe", "x-amzn-codewhisperer-optout": "true" });
    expect(init.headers["User-Agent"]).toBe(init.headers["x-amz-user-agent"]);
  });
  it.each([401, 403])("refreshes exactly once on %s and records repeated rejection", async status => {
    const f = setup("us-east-1", [status, status]);
    await expect(f.dispatch()).rejects.toMatchObject({ code: "kiro_reauth_required" });
    expect(f.network).toHaveBeenCalledTimes(2); expect(f.service.forceTokenRefresh).toHaveBeenCalledExactlyOnceWith("account");
    expect(f.service.noteUpstreamError).toHaveBeenCalledWith(expect.objectContaining({ code: "kiro_reauth_required" }), "account");
    expect((f.network.mock.calls[1] as unknown as [string, any])[1].headers.Authorization).toBe("Bearer renewed");
  });
  it("falls back to direct dispatcher and honors profile region", async () => {
    const f = setup(); delete f.host.getSubscriptionDispatcher;
    f.service.getCredential.mockResolvedValue({ id: "account", access: "first", region: "us-east-1", profile: "arn:aws:codewhisperer:eu-west-1:123:profile/test" });
    const response = await f.dispatch(); await response.text();
    expect(f.network.mock.calls[0][0]).toBe("https://runtime.eu-west-1.kiro.dev/generateAssistantResponse");
  });
});
