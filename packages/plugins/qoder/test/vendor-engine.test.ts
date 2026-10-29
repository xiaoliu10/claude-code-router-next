import { afterEach, describe, expect, it, vi } from "vitest"
import { createHash } from "node:crypto"
import { createQoderEngine } from "../src/vendor/engine.mjs"

// Fix only randomness; encryption and hashing still use node:crypto.
vi.mock("node:crypto", async (original) => ({
  ...await original<typeof import("node:crypto")>(),
  randomUUID: vi.fn(() => "00112233-4455-6677-8899-aabbccddeeff"),
  publicEncrypt: vi.fn(() => Buffer.from("wrapped-test-key")),
}))

const NOW = 1_800_000_000_000
const OPENAPI = "https://openapi.qoder.sh"
const API = "https://api3.qoder.sh"
const CN_OPENAPI = "https://openapi.qoder.com.cn"
const CN_API = "https://gateway.qoder.com.cn"
const credential = (fields = {}) => ({ access: "test-access", refresh: "test-refresh", expires: NOW + 86_400_000,
  uid: "test-user", email: "example@example.invalid", name: "Example", accountId: "example@example.invalid",
  machineId: "test-machine", pat: "pt-test-fixture", ...fields })
const rawModel = { key: "test-model", display_name: "Test Model", enable: true, source: "system", is_vl: true,
  max_input_tokens: 200_000, price_factor: 0, thinking_config: { enabled: { efforts: { max: {}, low: { is_default: true }, high: {} } } } }
const listing = () => Response.json({ chat: [rawModel] })
const line = (body: unknown, status = 200) => `data:${JSON.stringify({ statusCodeValue: status, body: typeof body === "string" ? body : JSON.stringify(body) })}\n\n`
const successful = () => new Response(line({ choices: [{ delta: { content: "Hello", reasoning_content: "Reason" } }] })
  + line({ choices: [{ delta: {}, finish_reason: "stop" }] })
  + line({ choices: [], usage: { prompt_tokens: 40, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 20 }, completion_tokens_details: { reasoning_tokens: 5 } } })
  + line("[DONE]"))
const make = (fetch = vi.fn(async () => { throw new Error("Unexpected fetch") }), options = {}) => createQoderEngine({ fetch, now: () => NOW, ...options })
const input = (fields = {}) => ({ model: "test-model", messages: [{ role: "user", content: "Hi" }], stream: true, ...fields })

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); vi.unstubAllGlobals() })

describe("vendor engine codec and COSY envelope", () => {
  it("requires injected transport and never reads ambient fetch", async () => {
    expect(() => createQoderEngine({})).toThrow("injected fetch")
    const ambient = vi.fn(() => { throw new Error("Ambient fetch must not run") })
    vi.stubGlobal("fetch", ambient)
    const fetch = vi.fn(async () => listing())
    await make(fetch).models(credential())
    expect(ambient).not.toHaveBeenCalled()
    expect(fetch.mock.calls[0][1].redirect).toBe("error")
  })

  it("matches known codec vectors and roundtrips UTF-8 and padding", () => {
    const p = make()._internal
    // Known vector evaluated independently against the pinned upstream codec.
    expect(p.segmentEncode(Buffer.from("Hello"))).toBe(",HFruHq$")
    expect(p.encodeBody("Hello")).toBe("q$FruH,H")
    for (const text of ["", "a", "ab", "abc", "Hello", "中文 😀", JSON.stringify({ hello: [1, 2] })])
      expect(p.decodeBody(p.encodeBody(text))).toBe(text)
    expect(p.swapThirds("1234567890")).toBe("8904567123")
  })

  it("signs the exact wire body and stripped path with deterministic ts/uuid", () => {
    const p = make()._internal
    const headers = p.cosyHeaders(API + "/algo/api/v2/model/list?Encode=1", credential(), "wire-data", p.SITES.qoder, 1234)
    const [, payload, sig] = headers.Authorization.split(".")
    const decoded = JSON.parse(Buffer.from(payload, "base64").toString())
    expect(decoded).toMatchObject({ version: "v1", requestId: "00112233445566778899aabbccddeeff", cosyVersion: "1.1.69", ideVersion: "" })
    expect(decoded.info).toBe(p.userBlob(credential()).info)
    expect(headers["Cosy-Key"]).toBe(Buffer.from("wrapped-test-key").toString("base64"))
    expect(sig).toBe(createHash("md5").update(`${payload}\n${headers["Cosy-Key"]}\n1234\nwire-data\n/api/v2/model/list`).digest("hex"))
    expect(headers).toMatchObject({ Accept: "application/json", "Accept-Encoding": "identity", "Content-Type": "application/json",
      "Cosy-ClientType": "10", "Cosy-ClientIp": "test-machine", "Cosy-Date": "1234", "Cosy-User": "test-user",
      "Cosy-MachineToken": "test-machine", "Cosy-MachineType": "5", "Cosy-Version": "1.1.69", "Cosy-Scene": "app", "Login-Version": "v2" })
    expect(headers["Cosy-MachineOS"]).toBe(p.machineOS())
    expect(p.cosyHeaders(API + "/algo/api/v2/model/list?Encode=1", credential(), "wire-data", p.SITES.qoder, 1234)).toEqual(headers)
    expect(() => p.cosyHeaders(API, { uid: "u" }, "")).toThrow("machine id")
  })
})

describe("vendor engine request conversion", () => {
  it("keeps system, images, tool pairs, cache marking, effort and schema typing", () => {
    const p = make()._internal
    const messages = [
      { role: "system", content: "Follow these instructions" },
      { role: "developer", content: [{ type: "text", text: "Use tools" }] },
      { role: "user", content: [{ type: "text", text: "Inspect" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }] },
      { role: "assistant", content: "", tool_calls: [{ type: "function", function: { name: "inspect", arguments: { path: "x" } } }] },
      { role: "tool", content: "result" },
      { role: "user", content: "Continue" },
    ]
    const tools = [{ type: "function", function: { name: "inspect", parameters: { oneOf: [{ type: "object" }, { $ref: "#/$defs/obj" }], $defs: { obj: { type: "object" } } } } }]
    const chat = input({ messages, tools, tool_choice: "required", reasoning_effort: "medium" })
    const snapshot = structuredClone(chat)
    const task = { id: "task-id", begin: NOW, name: "Inspect", answered: false }
    const body = p.qoderBody(chat, p.modelInfo(rawModel), "session", task)
    expect(body).toMatchObject({ request_id: "00112233-4455-6677-8899-aabbccddeeff", chat_record_id: "00112233-4455-6677-8899-aabbccddeeff",
      request_set_id: "task-id", session_id: p.sessionOf(chat, "session"), agent_id: "agent_common", task_id: "common", session_type: "app",
      parameters: { enable_thinking: true, reasoning_effort: "high", max_tokens: 32000, context_length: 200000 },
      business: { product: "app", version: "1.1.69", type: "agent", id: "task-id", name: "Inspect", begin_at: NOW, stage: "start" } })
    expect(body.system[0].text).toBe("You are a Qoder agent. Use the instructions below and the tools available to you to assist the user.\n\nFollow these instructions\n\nUse tools\nYou must call an available function in this response.")
    expect(body.messages[0]).toEqual({ role: "system", content: body.system })
    expect(body.messages[1].content[1]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } })
    const call = body.messages[2].tool_calls[0]
    expect(call.id).toMatch(/^call_[a-f0-9]{32}$/)
    expect(call.function.arguments).toBe('{"path":"x"}')
    expect(body.messages[3]).toEqual({ role: "tool", tool_call_id: call.id, content: "result" })
    expect(body.messages.at(-1)).toMatchObject({ role: "user", content: [{ type: "text", text: "Continue", cache_control: { type: "ephemeral" } }] })
    expect(body.messages.at(-1).contents).toEqual(body.messages.at(-1).content)
    expect(body.tools[0].function.parameters.type).toBe("object")
    expect(chat).toEqual(snapshot)
    expect(p.qoderBody(chat, p.modelInfo(rawModel), "session", task).messages[2].tool_calls[0].id).toBe(call.id)
  })

  it("keeps tasks through tool loops and separates sessions and new user prompts", () => {
    const p = make()._internal
    const first = input()
    const sid = p.sessionOf(first, "named-session")
    const task = p.taskOf(sid, first)
    task.answered = true
    const loop = input({ messages: [...first.messages, { role: "assistant", content: "tool" }, { role: "tool", content: "result" }] })
    expect(p.taskOf(sid, loop)).toBe(task)
    expect(p.qoderBody(loop, p.modelInfo(rawModel), "named-session").business.stage).toBe("processing")
    expect(p.taskOf(sid, input({ messages: [...loop.messages, { role: "user", content: "Next" }] }))).not.toBe(task)
    expect(p.sessionOf(first, "other-session")).not.toBe(sid)
    expect(p.sessionOf({ ...first, prompt_cache_key: "key" })).not.toBe(p.sessionOf(first))
    p.taskOf(sid, first, NOW + 2 * 60 * 60 * 1000 + 1)
    expect(p.taskOf(sid, first, NOW + 2 * 60 * 60 * 1000 + 1)).not.toBe(task)
  })
})

describe("vendor engine failures and quota", () => {
  it.each([
    [403, { code: "10605", message: JSON.stringify({ isQueued: true, modelKey: "test-model", queueType: "p3", queueCount: 2, retryAfterSeconds: 1.2 }) }, 503, "queued the request", 2],
    [400, { code: "110", message: "credits" }, 429, "usage limit reached", undefined],
    [403, { code: "80412", message: "too many media" }, 400, "refused the request", undefined],
    [400, { message: "Error in upstream response" }, 502, "Error in upstream response", undefined],
    [401, { message: "refused" }, 401, "sign-in lapsed", undefined],
    [403, { message: "refused" }, 401, "sign-in lapsed", undefined],
    [429, { message: "busy" }, 429, "usage limit reached", undefined],
    [500, { message: "quota is gone" }, 429, "usage limit reached", undefined],
  ])("classifies status %s with %j", (status, body, expected, message, retryAfter) => {
    const failure = make()._internal.failure(status, JSON.stringify(body))
    expect(failure.status).toBe(expected)
    expect(failure.message).toContain(message)
    expect(failure.retryAfter).toBe(retryAfter)
    if (expected === 503) expect(failure.queue).toMatchObject({ modelKey: "test-model" })
  })

  it("unwraps the queue code and preserves authoritative outer codes", () => {
    const p = make()._internal
    const inner = { code: "10605", queue: { isQueued: false, serviceAvailable: false } }
    expect(p.failure(403, JSON.stringify({ code: 403, message: JSON.stringify(inner) })).status).toBe(503)
    expect(p.failure(403, JSON.stringify({ code: 110, message: JSON.stringify(inner) })).status).toBe(429)
  })

  it("includes retry_after seconds in the error body and Retry-After header", async () => {
    const response = make()._internal.errorResponse({ status: 503, message: "queued", retryAfter: 30 })
    expect(response.headers.get("Retry-After")).toBe("30")
    expect(await response.json()).toEqual({ error: { message: "queued", type: "qoder_error", code: 503 }, retry_after: 30 })
    const auth = make()._internal.errorResponse({ status: 401, message: "refused" })
    expect(auth.headers.get("X-Magpie-Sign-In")).toBe("kept")
  })

  it("parses upstream usage pools, aliases, percentages and plan expiry verbatim", () => {
    const p = make()._internal
    expect(p.parseUsage({ displayMode: "qoder", qoderUsage: { user_type: "Pro", expires_at: 1_800_000_000,
      user_quota: { total: 100, used: 25 }, add_on_quota: { cap: 50, remaining: 40 },
      org_resource_package: { total: 20, used: 30, name: "Team", unit: "units" },
      dedicated_resource_packages: [{ total: 10, used: 1 }, { total: "bad", used: 1 }] } })).toEqual({
      plan: "Pro", until: new Date(NOW).toISOString(), windows: [
        { name: "Credits", used: 25, display: "25 / 100 credits" },
        { name: "Add-on credits", used: 20, display: "10 / 50 credits" },
        { name: "Team", used: 100, display: "30 / 20 units" },
        { name: "Dedicated credits", used: 10, display: "1 / 10 credits" },
      ],
    })
    expect(p.parseUsage({ displayMode: "enterprise" })).toEqual({ plan: "Enterprise" })
    expect(p.parseUsage({})).toEqual({ error: "Qoder: missing quota data" })
  })
})

describe("vendor engine PAT and refresh", () => {
  it.each([
    [{ token: "job", expire_time: "2030-01-01T00:00:00Z" }, Date.parse("2030-01-01T00:00:00Z")],
    [{ device_token: "job", expires_at: "2031-01-01T00:00:00Z" }, Date.parse("2031-01-01T00:00:00Z")],
    [{ access_token: "job", expires_in: 1000 }, NOW + 1000],
    [{ token: "job" }, NOW + 86400000],
  ])("exchanges PAT token and expiry aliases %j", async (pair, expiry) => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ ...pair, refreshToken: "refresh" }))
      .mockResolvedValueOnce(Response.json({ user_id: "uid", email: "example@example.invalid", name: "Example" }))
    const cred = await make(fetch).connectPAT("pt-fixture")
    expect(cred).toEqual({ access: "job", refresh: "refresh", expires: expiry, uid: "uid", email: "example@example.invalid", name: "Example",
      accountId: "example@example.invalid", machineId: "00112233-4455-6677-8899-aabbccddeeff", pat: "pt-fixture" })
    expect(String(fetch.mock.calls[0][0])).toBe(OPENAPI + "/api/v1/jobToken/exchange")
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ personal_token: "pt-fixture" })
    expect(fetch.mock.calls[1][1].headers.Authorization).toBe("Bearer job")
    expect(fetch.mock.calls.every(([, init]) => init.redirect === "error")).toBe(true)
  })

  it("validates PAT before fetch and requires a user id", async () => {
    const fetch = vi.fn()
    const engine = make(fetch)
    for (const bad of ["bad", "pt-" + "x".repeat(4094), null]) await expect(engine.connectPAT(bad)).rejects.toThrow("PAT must")
    expect(fetch).not.toHaveBeenCalled()
    fetch.mockResolvedValueOnce(Response.json({ token: "job" })).mockResolvedValueOnce(Response.json({ email: "x" }))
    await expect(engine.connectPAT("pt-fixture")).rejects.toThrow("user id")
  })

  it("serializes concurrent refresh and deduplicates spent tokens without mutating caller", async () => {
    const fetch = vi.fn(async () => Response.json({ token: "next-access", refresh_token: "next-refresh", expires_in: 999999 }))
    const onRefresh = vi.fn()
    const engine = make(fetch, { onRefresh })
    const cred = credential()
    const results = await Promise.all([engine.refresh(cred), engine.refresh(cred), engine.refresh(cred)])
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(results[0]).toEqual(credential({ access: "next-access", refresh: "next-refresh", expires: NOW + 999999 }))
    expect(results[1]).toEqual(results[0])
    expect(cred.access).toBe("test-access")
    expect(onRefresh).not.toHaveBeenCalled()
    expect(String(fetch.mock.calls[0][0])).toBe(OPENAPI + "/api/v1/jobToken/refresh")
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ refresh_token: "test-refresh" })
  })

  it("renews an expired mapped pair using its current refresh token", async () => {
    let clock = NOW
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ token: "short-access", refresh_token: "current-refresh", expires_in: 1000 }))
      .mockResolvedValueOnce(Response.json({ token: "long-access", refresh_token: "final-refresh", expires_in: 86400000 }))
    const engine = make(fetch, { now: () => clock })
    await engine.refresh(credential())
    clock += 2000
    expect((await engine.refresh(credential())).access).toBe("long-access")
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ refresh_token: "current-refresh" })
  })

  it("commits refresh rotation when the initiating chat aborts after response text", async () => {
    const controller = new AbortController()
    const rotated = Response.json({ token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 86400000 })
    const readText = rotated.text.bind(rotated)
    vi.spyOn(rotated, "text").mockImplementation(async () => {
      const text = await readText()
      controller.abort()
      return text
    })
    const fetch = vi.fn().mockResolvedValueOnce(rotated)
    const onRefresh = vi.fn()
    const engine = make(fetch, { onRefresh })
    const original = credential({ expires: NOW + 1000 })
    await expect(engine.chat(original, input(), { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" })
    const next = await engine.refresh(original)
    expect(next).toMatchObject({ access: "rotated-access", refresh: "rotated-refresh" })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(onRefresh).toHaveBeenCalledExactlyOnceWith(next)
  })

  it("forgets spent tokens after 60 minutes", async () => {
    let clock = NOW
    const fetch = vi.fn(async () => Response.json({ token: "next-access", refresh_token: "next-refresh" }))
    const engine = make(fetch, { now: () => clock })
    await engine.refresh(credential())
    clock += 60 * 60 * 1000 + 1
    await engine.refresh(credential())
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it.each([401, 403])("re-exchanges PAT after refresh %s and marks refused PAT expired", async (status) => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response("refused", { status }))
      .mockResolvedValueOnce(Response.json({ token: "re-exchanged", refresh_token: "new-refresh" }))
      .mockResolvedValueOnce(Response.json({ id: "test-user" }))
    const engine = make(fetch)
    expect((await engine.refresh(credential())).access).toBe("re-exchanged")
    expect(String(fetch.mock.calls[1][0])).toBe(OPENAPI + "/api/v1/jobToken/exchange")
    fetch.mockResolvedValueOnce(new Response("refused", { status })).mockResolvedValueOnce(new Response("refused", { status: 403 }))
    await expect(engine.refresh(credential({ refresh: "another-refresh" }))).rejects.toMatchObject({ expired: true })
  })

  it("does not re-exchange PAT on transient refresh failures", async () => {
    const fetch = vi.fn(async () => new Response("temporary", { status: 503 }))
    await expect(make(fetch).refresh(credential())).rejects.toThrow("status 503")
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("auto-refreshes once across models, usage and chat and notifies the host once", async () => {
    const fetch = vi.fn(async (url) => {
      if (String(url).endsWith("/refresh")) return Response.json({ token: "renewed", refresh_token: "rotated", expires_in: 86400000 })
      if (String(url).includes("/model/list")) return listing()
      if (String(url).endsWith("/usage")) return Response.json({ displayMode: "qoder", qoderUsage: {} })
      return successful()
    })
    const onRefresh = vi.fn()
    const engine = make(fetch, { onRefresh })
    const cred = credential({ expires: NOW + 1000 })
    await engine.models(cred)
    expect(await engine.usage(cred)).toEqual({ windows: [], signIn: "kept" })
    await (await engine.chat(cred, input())).text()
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/refresh"))).toHaveLength(1)
    expect(onRefresh).toHaveBeenCalledTimes(1)
    expect(onRefresh.mock.calls[0][0]).toMatchObject({ access: "renewed", refresh: "rotated" })
    expect(cred.access).toBe("test-access")
    expect(fetch.mock.calls.find(([url]) => String(url).endsWith("/usage"))?.[1].headers.Authorization).toBe("Bearer renewed")
  })
})

describe("vendor engine model listing", () => {
  it("reads plain JSON, merges scene order, caches per uid and forces on again/dispose", async () => {
    const fetch = vi.fn(async () => Response.json({ app: [rawModel], chat: [
      { ...rawModel, key: "disabled", enable: false }, { ...rawModel, key: "auto" }, { ...rawModel, key: "default" },
      { ...rawModel, display_name: "Chat duplicate loses" }, { ...rawModel, key: "legacy", price_factor: 0.5 },
    ] }))
    const engine = make(fetch)
    const first = await engine.models(credential())
    expect(first.map((m) => m.key)).toEqual(["test-model", "legacy"])
    expect(first[0]).toMatchObject({ name: "Test Model", context: 200000, images: true, efforts: ["low", "high", "max"], thinks: true, free: true, rate: 0, rateWas: 0, source: "system" })
    expect(first[1].free).toBe(false)
    await engine.models(credential())
    expect(fetch).toHaveBeenCalledTimes(1)
    await engine.models(credential({ uid: "other" }))
    await engine.models(credential(), true)
    engine.dispose()
    await engine.models(credential())
    expect(fetch).toHaveBeenCalledTimes(4)
    expect(String(fetch.mock.calls[0][0])).toBe(API + "/algo/api/v2/model/list?Encode=1")
  })

  it("uses largest advertised context and upstream promotion rules", () => {
    const p = make()._internal
    const info = p.modelInfo({ ...rawModel, context_config: { small: { token_count: 200000, is_default: true }, large: { token_count: 1000000 } },
      price_factor: 0, promotion: { active: true, before_promotion_price_factor: 2, discount_factor: 0.4 } })
    expect(info).toMatchObject({ context: 1000000, windows: [200000, 1000000], defaultWindow: 200000, free: false, rate: 0.8, rateWas: 2 })
  })
})

describe("vendor engine chat", () => {
  it("signs encoded request and returns verbatim upstream chat completion chunks", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(listing()).mockResolvedValueOnce(successful())
    const engine = make(fetch)
    const res = await engine.chat(credential(), input(), { session: "stable-session" })
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toBe("text/event-stream")
    const text = await res.text()
    const chunks = text.split("\n\n").filter(Boolean).map((s) => s.slice(6))
    expect(chunks.at(-1)).toBe("[DONE]")
    const frames = chunks.slice(0, -1).map(JSON.parse)
    expect(frames[0]).toEqual({ id: "chatcmpl-00112233445566778899aabbccddeeff", object: "chat.completion.chunk", created: Math.floor(NOW / 1000), model: "Test Model", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] })
    expect(frames.some((f) => f.choices[0].delta.reasoning_content === "Reason")).toBe(true)
    expect(frames.some((f) => f.choices[0].delta.content === "Hello")).toBe(true)
    expect(frames.at(-1).usage).toEqual({ prompt_tokens: 40, completion_tokens: 10, total_tokens: 50, prompt_tokens_details: { cached_tokens: 20 }, completion_tokens_details: { reasoning_tokens: 5 } })
    const [url, init] = fetch.mock.calls[1]
    expect(String(url)).toBe(API + "/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1")
    const body = JSON.parse(engine._internal.decodeBody(init.body))
    expect(body.session_id).toBe(engine._internal.sessionOf(input(), "stable-session"))
    expect(init.headers).toMatchObject({ Accept: "text/event-stream", "X-Model-Key": "test-model", "X-Model-Source": "system" })
    const [, payload, sig] = init.headers.Authorization.split(".")
    expect(sig).toBe(createHash("md5").update(`${payload}\n${init.headers["Cosy-Key"]}\n${Math.floor(NOW / 1000)}\n${init.body}\n/api/v2/service/pro/sse/agent_chat_generation`).digest("hex"))
  })

  it("supports nonstream completion and XML tool lifting", async () => {
    const sse = line({ choices: [{ delta: { content: '<tool_call>{"name":"run","arguments":{"x":1}}</tool_call>' } }] }) + line("[DONE]")
    const fetch = vi.fn().mockResolvedValueOnce(listing()).mockResolvedValueOnce(new Response(sse))
    const response = await make(fetch).chat(credential(), input({ stream: false, tools: [{ type: "function", function: { name: "run" } }] }))
    const json = await response.json()
    expect(json.choices[0]).toMatchObject({ finish_reason: "tool_calls", message: { role: "assistant", content: "", tool_calls: [{ type: "function", function: { name: "run", arguments: '{"x":1}' } }] } })
  })

  it("waits queue 10605, polls status and resends new request ids in same task", async () => {
    const { randomUUID } = await import("node:crypto")
    let serial = 0
    vi.mocked(randomUUID).mockImplementation(() => `00000000-0000-4000-8000-${String(++serial).padStart(12, "0")}`)
    const fetch = vi.fn().mockResolvedValueOnce(listing())
      .mockResolvedValueOnce(new Response(line({ code: "10605", queue: { isQueued: true, modelKey: "test-model", queueType: "p3" } }, 403)))
      .mockResolvedValueOnce(Response.json({ data: { isQueued: true, retryAfterSeconds: 0.1 } }))
      .mockResolvedValueOnce(Response.json({ result: JSON.stringify({ isQueued: false, retryAfterSeconds: 0 }) }))
      .mockResolvedValueOnce(successful())
    const engine = make(fetch)
    const pause = vi.fn(async () => {})
    engine._internal.QUEUE.pause = pause
    const response = await engine.chat(credential(), input())
    expect(response.status).toBe(200)
    await response.text()
    expect(pause).toHaveBeenCalledWith(500, expect.any(AbortSignal))
    const [statusURL, statusInit] = fetch.mock.calls[2]
    expect(new URL(statusURL).pathname).toBe("/algo/api/v2/service/ask/queue/status")
    expect(new URL(statusURL).searchParams.get("queueType")).toBe("p3")
    const first = JSON.parse(engine._internal.decodeBody(fetch.mock.calls[1][1].body))
    const resent = JSON.parse(engine._internal.decodeBody(fetch.mock.calls[4][1].body))
    expect(first.request_set_id).toBe(resent.request_set_id)
    expect(first.request_id).not.toBe(resent.request_id)
    expect(resent.request_id).toBe(resent.chat_record_id)
    expect(new URL(statusURL).searchParams.get("requestSetId")).toBe(first.request_set_id)
    expect(statusInit.headers["X-Request-ID"]).toBe(first.request_id)
    vi.mocked(randomUUID).mockImplementation(() => "00112233-4455-6677-8899-aabbccddeeff")
  })

  it("polls and resends after aborting an open queue frame attached to the call signal", async () => {
    let signalBody!: AbortSignal
    let posts = 0
    const fetch = vi.fn(async (url, init) => {
      if (String(url).includes("/model/list")) return listing()
      if (String(url).includes("/queue/status")) return Response.json({ isQueued: false })
      if (++posts > 1) return successful()
      signalBody = init.signal
      return new Response(new ReadableStream({ start(ctl) {
        ctl.enqueue(new TextEncoder().encode(line({ code: "10605", queue: { isQueued: true } }, 403)))
        init.signal.addEventListener("abort", () => ctl.error(init.signal.reason), { once: true })
      } }))
    })
    const engine = make(fetch)
    const response = await engine.chat(credential(), input())
    expect(signalBody.aborted).toBe(true)
    expect(fetch.mock.calls.some(([url]) => String(url).includes("/queue/status"))).toBe(true)
    expect(posts).toBe(2)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("Hello")
  })

  it.each(["budget", "three-failures", "missing-status"])("ends queue waiting on %s", async (kind) => {
    let asks = 0
    let clock = NOW
    const fetch = vi.fn(async (url) => {
      if (String(url).includes("/model/list")) return listing()
      if (String(url).includes("/queue/status")) {
        asks++
        if (kind === "three-failures") return new Response("temporary", { status: 503 })
        if (kind === "missing-status") return new Response("missing", { status: 404 })
        return Response.json({ isQueued: true, retryAfterSeconds: 30 })
      }
      return new Response(JSON.stringify({ code: "10605", queue: { isQueued: true, retryAfterSeconds: 30 } }), { status: 403 })
    })
    const engine = make(fetch, { now: () => clock })
    engine._internal.QUEUE.pause = vi.fn(async (ms) => { clock += ms })
    const response = await engine.chat(credential(), input())
    expect(response.status).toBe(503)
    expect(asks).toBe(kind === "three-failures" ? 3 : kind === "missing-status" ? 1 : 8)
    if (kind === "budget") expect(clock).toBe(NOW + 4 * 60 * 1000)
  })

  it("stops queue recovery after ten resends and returns retry_after", async () => {
    let posts = 0
    const fetch = vi.fn(async (url, init) => {
      if (String(url).includes("/model/list")) return listing()
      if (String(url).includes("/queue/status")) return Response.json({ isQueued: false })
      posts++
      return new Response(JSON.stringify({ code: "10605", queue: { isQueued: true, retryAfterSeconds: 30 } }), { status: 403 })
    })
    const engine = make(fetch)
    engine._internal.QUEUE.pause = vi.fn(async () => {})
    const response = await engine.chat(credential(), input())
    expect(posts).toBe(11)
    expect(response.status).toBe(503)
    expect((await response.json()).retry_after).toBe(30)
  })

  it.each(["http", "first-frame", "network", "listing-parse", "unknown-model"])("returns errorResponse for %s failures", async (kind) => {
    const fetch = vi.fn().mockResolvedValueOnce(kind === "listing-parse" ? new Response("bad json") : listing())
    if (kind === "http") fetch.mockResolvedValueOnce(new Response('{"code":"110","message":"credits"}', { status: 403 }))
    if (kind === "first-frame") fetch.mockResolvedValueOnce(new Response(line({ code: "416", message: "input" }, 400)))
    if (kind === "network") fetch.mockRejectedValueOnce(new Error("offline fixture"))
    if (kind === "unknown-model") fetch.mockResolvedValueOnce(listing())
    const res = await make(fetch).chat(credential(), input({ model: kind === "unknown-model" ? "unknown" : "test-model" }))
    expect(res.status).toBe(kind === "http" ? 429 : ["first-frame", "unknown-model"].includes(kind) ? 400 : 502)
    expect((await res.json()).error.type).toBe("qoder_error")
  })

  it.each(["data: not-json\n\n", line(""), line({ choices: [{ delta: {} }] }), ""])("rejects unreadable/empty whole answer %j", async (sse) => {
    const fetch = vi.fn().mockResolvedValueOnce(listing()).mockResolvedValueOnce(new Response(sse))
    const response = await make(fetch).chat(credential(), input({ stream: false }))
    expect(response.status).toBe(502)
    expect((await response.json()).error).toMatchObject({ type: "qoder_error", code: 502 })
  })

  it.each([true, false])("rejects finish-only and usage-only answers with stream=%s", async (stream) => {
    for (const metadata of [
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: {} },
    ]) {
      const fetch = vi.fn().mockResolvedValueOnce(listing()).mockResolvedValueOnce(new Response(line(metadata)))
      const response = await make(fetch).chat(credential(), input({ stream }))
      expect(response.status).toBe(502)
      expect((await response.json()).error).toMatchObject({ type: "qoder_error", code: 502, message: "Qoder sent an unreadable answer" })
    }
  })

  it.each([true, false])("rejects malformed non-string reasoning with stream=%s", async (stream) => {
    for (const bad of [{}, [], true]) {
      const sse = line({ choices: [{ delta: { reasoning_content: bad } }] }) + line("[DONE]")
      const fetch = vi.fn().mockResolvedValueOnce(listing()).mockResolvedValueOnce(new Response(sse))
      const response = await make(fetch).chat(credential(), input({ stream }))
      expect(response.status).toBe(502)
      const body = await response.json()
      expect(body.error).toMatchObject({ type: "qoder_error", code: 502, message: "Qoder sent an unreadable answer" })
    }
  })

  it("normalizes enterprise usage without credit windows to an empty array", async () => {
    const fetch = vi.fn(async (url) => {
      if (String(url).endsWith("/refresh")) return Response.json({ token: "renewed", refresh_token: "rotated", expires_in: 86400000 })
      return Response.json({ displayMode: "enterprise" })
    })
    await expect(make(fetch).usage(credential({ expires: NOW + 1000 })))
      .resolves.toEqual({ windows: [], plan: "Enterprise", signIn: "kept" })
  })

  it("skips malformed lines around valid answer text", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(listing()).mockResolvedValueOnce(new Response(
      "data: not-json\n\n" + line("not-inner-json") + line({ choices: [{ delta: { content: "valid" } }] }) + "data: broken\n\n"))
    const response = await make(fetch).chat(credential(), input({ stream: false }))
    expect(response.status).toBe(200)
    expect((await response.json()).choices[0].message.content).toBe("valid")
  })

  it("emits a terminal stream error after visible output", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(listing()).mockResolvedValueOnce(new Response(
      line({ choices: [{ delta: { content: "visible" } }] }) + line({ code: "110", message: "credits" }, 403)))
    const res = await make(fetch).chat(credential(), input())
    const text = await res.text()
    expect(text).toContain('"content":"visible"')
    expect(text).toContain('"code":429')
    expect(text).not.toContain("[DONE]")
  })
})

describe("vendor engine aborts", () => {
  const pending = (_url, init) => new Promise<Response>((_resolve, reject) => {
    if (init.signal.aborted) reject(init.signal.reason)
    else init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true })
  })

  it("propagates request AbortError during pending chat fetch", async () => {
    const controller = new AbortController()
    let started!: () => void
    const ready = new Promise<void>((resolve) => { started = resolve })
    const fetch = vi.fn().mockResolvedValueOnce(listing()).mockImplementation((url, init) => { started(); return pending(url, init) })
    const result = make(fetch).chat(credential(), input(), { signal: controller.signal })
    await ready
    controller.abort()
    await expect(result).rejects.toMatchObject({ name: "AbortError" })
  })

  it("propagates request AbortError during queue wait", async () => {
    const controller = new AbortController()
    let paused!: () => void
    const ready = new Promise<void>((resolve) => { paused = resolve })
    const fetch = vi.fn().mockResolvedValueOnce(listing())
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "10605", queue: { isQueued: true } }), { status: 403 }))
      .mockResolvedValueOnce(Response.json({ isQueued: true, retryAfterSeconds: 30 }))
    const engine = make(fetch)
    const pause = engine._internal.QUEUE.pause
    engine._internal.QUEUE.pause = (ms, signal) => { paused(); return pause(ms, signal) }
    const result = engine.chat(credential(), input(), { signal: controller.signal })
    await ready
    controller.abort()
    await expect(result).rejects.toMatchObject({ name: "AbortError" })
  })

  it("propagates AbortError from a returned stream after visible output", async () => {
    const controller = new AbortController()
    let enqueue!: ReadableStreamDefaultController<Uint8Array>
    const upstream = new ReadableStream<Uint8Array>({ start(ctl) { enqueue = ctl } })
    enqueue.enqueue(new TextEncoder().encode(line({ choices: [{ delta: { content: "visible" } }] })))
    const fetch = vi.fn().mockResolvedValueOnce(listing()).mockResolvedValueOnce(new Response(upstream))
    const response = await make(fetch).chat(credential(), input(), { signal: controller.signal })
    const reader = response.body.getReader()
    await reader.read() // Initial assistant role chunk.
    const visible = await reader.read()
    expect(new TextDecoder().decode(visible.value)).toContain("visible")
    controller.abort()
    enqueue.enqueue(new TextEncoder().encode(line({ choices: [{ delta: {}, finish_reason: "stop" }] })))
    await expect(reader.read()).rejects.toMatchObject({ name: "AbortError" })
  })

  it.each(["chat", "models", "usage", "refresh"])("propagates factory lifetime AbortError during %s", async (method) => {
    const controller = new AbortController()
    let started!: () => void
    const ready = new Promise<void>((resolve) => { started = resolve })
    const fetch = vi.fn((url, init) => { started(); return pending(url, init) })
    const engine = make(fetch, { signal: controller.signal })
    const result = method === "chat" ? engine.chat(credential(), input()) : engine[method](credential())
    await ready
    controller.abort()
    await expect(result).rejects.toMatchObject({ name: "AbortError" })
  })
})

describe("vendor engine CN site", () => {
  it("defaults to the qoder site and refuses an unknown one", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ token: "job", refresh_token: "refresh" }))
      .mockResolvedValueOnce(Response.json({ id: "uid" }))
    const engine = make(fetch)
    expect(engine._internal.site).toBe(engine._internal.SITES.qoder)
    await engine.connectPAT("pt-fixture")
    expect(fetch.mock.calls.map(([url]) => String(url)))
      .toEqual([OPENAPI + "/api/v1/jobToken/exchange", OPENAPI + "/api/v1/userinfo"])
    expect(() => createQoderEngine({ fetch: vi.fn(), site: "qoder-us" })).toThrow('unknown site "qoder-us"')
  })

  it("exchanges a PAT and reads userinfo on the CN openapi", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ token: "cn-job", expire_time: "2030-01-01T00:00:00Z" }))
      .mockResolvedValueOnce(Response.json({ user_id: "cn-uid", email: "cn@example.invalid", name: "CN" }))
    const engine = make(fetch, { site: "qoder-cn" })
    expect(engine._internal.site).toBe(engine._internal.SITES["qoder-cn"])
    const cred = await engine.connectPAT("pt-fixture")
    expect(cred).toMatchObject({ access: "cn-job", uid: "cn-uid", accountId: "cn@example.invalid", machineId: "00112233-4455-6677-8899-aabbccddeeff", pat: "pt-fixture" })
    expect(fetch.mock.calls.map(([url]) => String(url)))
      .toEqual([CN_OPENAPI + "/api/v1/jobToken/exchange", CN_OPENAPI + "/api/v1/userinfo"])
    expect(fetch.mock.calls[1][1].headers.Authorization).toBe("Bearer cn-job")
  })

  it("refreshes and re-exchanges a refused PAT on the CN openapi", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ token: "next-access", refresh_token: "next-refresh", expires_in: 999999 }))
    const engine = make(fetch, { site: "qoder-cn" })
    expect((await engine.refresh(credential({ refresh: "cn-refresh-1" }))).access).toBe("next-access")
    expect(String(fetch.mock.calls[0][0])).toBe(CN_OPENAPI + "/api/v1/jobToken/refresh")
    fetch.mockReset()
    fetch.mockResolvedValueOnce(new Response("refused", { status: 401 }))
      .mockResolvedValueOnce(Response.json({ token: "re-exchanged", refresh_token: "re-exchanged-refresh" }))
      .mockResolvedValueOnce(Response.json({ id: "cn-uid" }))
    expect((await engine.refresh(credential({ refresh: "cn-refresh-2" }))).access).toBe("re-exchanged")
    expect(fetch.mock.calls.map(([url]) => String(url)))
      .toEqual([CN_OPENAPI + "/api/v1/jobToken/refresh", CN_OPENAPI + "/api/v1/jobToken/exchange", CN_OPENAPI + "/api/v1/userinfo"])
  })

  it("lists CN models with the same COSY envelope as intl", async () => {
    const fetch = vi.fn(async () => listing())
    const engine = make(fetch, { site: "qoder-cn" })
    const models = await engine.models(credential({ refresh: "cn-refresh-3" }))
    expect(models.map((m) => m.key)).toEqual(["test-model"])
    expect(String(fetch.mock.calls[0][0])).toBe(CN_API + "/algo/api/v2/model/list?Encode=1")
    const cn = fetch.mock.calls[0][1].headers
    const intl = engine._internal.cosyHeaders(API + "/algo/api/v2/model/list?Encode=1", credential(), "", engine._internal.SITES.qoder)
    expect(cn).toMatchObject({ "Cosy-ClientType": "10", "Cosy-Business-Product": "app", "Cosy-Scene": "app", "Cosy-Business-Type": "agent" })
    expect(Object.keys(cn)).toEqual(Object.keys(intl))
    expect(cn).toEqual(engine._internal.cosyHeaders(CN_API + "/algo/api/v2/model/list?Encode=1", credential(), "", engine._internal.SITES["qoder-cn"]))
  })

  it("reads CN usage from the CN openapi", async () => {
    const fetch = vi.fn(async () => Response.json({ displayMode: "qoder", qoderUsage: { user_type: "Pro", user_quota: { total: 100, used: 25 } } }))
    const usage = await make(fetch, { site: "qoder-cn" }).usage(credential({ refresh: "cn-refresh-4" }))
    expect(String(fetch.mock.calls[0][0])).toBe(CN_OPENAPI + "/sash/api/v2/me/usage")
    expect(fetch.mock.calls[0][1].headers).toMatchObject({ Authorization: "Bearer test-access", "Cosy-ClientType": "10" })
    expect(usage).toMatchObject({ plan: "Pro", signIn: "kept", windows: [{ name: "Credits", used: 25, display: "25 / 100 credits" }] })
  })

  it("chats on the CN gateway with the same COSY envelope and body defaults", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(listing()).mockResolvedValueOnce(successful())
    const engine = make(fetch, { site: "qoder-cn" })
    const response = await engine.chat(credential({ refresh: "cn-refresh-5" }), input())
    expect(response.status).toBe(200)
    await response.text()
    expect(String(fetch.mock.calls[0][0])).toBe(CN_API + "/algo/api/v2/model/list?Encode=1")
    const [url, init] = fetch.mock.calls[1]
    expect(String(url)).toBe(CN_API + "/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1")
    const intl = engine._internal.cosyHeaders(String(url).replace(CN_API, API), credential(), init.body, engine._internal.SITES.qoder)
    // Chat sets Accept back to text/event-stream over the envelope's
    // application/json and adds Cache-Control and the model's own headers,
    // so every other envelope header is compared by name and value.
    for (const [name, value] of Object.entries(intl)) if (name !== "Accept") expect(init.headers[name]).toBe(value)
    expect(init.headers).toMatchObject({ Accept: "text/event-stream", "X-Model-Key": "test-model", "X-Model-Source": "system" })
    const [, payload, sig] = init.headers.Authorization.split(".")
    expect(sig).toBe(createHash("md5").update(`${payload}\n${init.headers["Cosy-Key"]}\n${Math.floor(NOW / 1000)}\n${init.body}\n/api/v2/service/pro/sse/agent_chat_generation`).digest("hex"))
    const body = JSON.parse(engine._internal.decodeBody(init.body))
    expect(body).toMatchObject({ session_type: "app", agent_id: "agent_common", task_id: "common",
      business: { product: "app", version: "1.1.69", type: "agent" } })
  })
})
