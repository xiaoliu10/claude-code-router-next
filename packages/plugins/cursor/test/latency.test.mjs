// Far from Cursor (yetone/magpie#1053, plugins#33: Windows in mainland
// China) a GetFilteredUsageEvents round trip takes about 4.2 s and a Run's
// usage event shows 4–5 s after the Run is closed, so a tool step's event
// never showed inside STEP_WAIT: every tool step was counted as its whole
// prompt guessed, uncached (Claude Code on fable: 13 of 13 steps, 0%
// cached, where Cursor counted 95–99%). These run whole conversations
// through the plugin against a fake Cursor with that latency, every time
// scaled down twentyfold: its API by a stand-in fetch, its agent API by
// an HTTP/2 server here. Nothing reaches Cursor.
import "./nonet.mjs" // first: no request leaves this machine
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest"
import http2 from "node:http2"
import { CursorAuthPlugin, _internal } from "../src/vendor/engine.mjs"
import { NATIVE_LIMITS, nativeSessions } from "../src/vendor/native-session.mjs"

const { fields, pb, frame, STEP_WAIT } = _internal

// a twentieth of the reporter's times: the round trip, and how long after
// the Run is closed its event shows
const SCALE = 20
const RTT = 4200 / SCALE
const SHOWS = 4500 / SCALE

const real = globalThis.fetch
const wait = { ...STEP_WAIT }
const retained = NATIVE_LIMITS.perProcess
beforeEach(async () => {
  await nativeSessions.clear()
  // This server closes each tool Run to publish dashboard usage. Exercise the
  // production stateless fallback explicitly; native same-Run totals have
  // separate roundtrip coverage in native-e2e/native-http1.
  NATIVE_LIMITS.perProcess = 0
  // the times, not the counts; a debt is let go as before
  for (const k of ["first", "every", "until", "ask", "owedAt"]) if (k in wait) STEP_WAIT[k] = wait[k] / SCALE
  _internal.owed?.clear()
  _internal.misses?.clear()
  _internal.unreadable?.clear()
})
afterEach(() => {
  far = true
  NATIVE_LIMITS.perProcess = retained
  globalThis.fetch = real
  Object.assign(STEP_WAIT, wait)
})

const jwt = (exp) => ["e30", Buffer.from(JSON.stringify({ exp, sub: "latency-" + Math.random() })).toString("base64url"), "sig"].join(".")
let n = 0
const fresh = () => ({ type: "oauth", access: jwt(Math.floor(Date.now() / 1000) + 7200 + ++n), refresh: "", expires: 0, accountId: "a@b.c" })

// The reporter's three dashboard events (fable twice, opus), in the order
// of their Runs. Each step of a conversation here takes the next one: a
// tool step tells it only through the dashboard, a step that ends the
// turn in its TurnEndedUpdate too (whose input counts the cache in).
const CURSOR = [
  { inputTokens: 2, outputTokens: 621, cacheReadTokens: 63457, cacheWriteTokens: 3081 },
  { inputTokens: 2, outputTokens: 942, cacheReadTokens: 66538, cacheWriteTokens: 14756 },
  { inputTokens: 4, outputTokens: 151, cacheReadTokens: 67872, cacheWriteTokens: 2392 },
]

// the agent API: a Run answers a tool call (listed first, as Cursor does)
// and waits for the client to close it, or ends the turn with its usage.
// A closed Run's event shows on the dashboard SHOWS later, stamped then.
let server, base
let script = [] // per Run: "tool" or "end", with its CURSOR usage
const shown = [] // the dashboard's events
let far = true // a Run's event shows once its step has answered
let asking = null // the step being asked: its Runs' events held till it answers
beforeAll(async () => {
  server = http2.createServer()
  server.on("stream", (stream) => {
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" })
    let buf = Buffer.alloc(0)
    let step
    const by = asking // the step whose Run this is
    stream.on("data", (c) => {
      buf = Buffer.concat([buf, c])
      if (step || buf.length < 5 || buf.length < 5 + buf.readUInt32BE(1)) return
      const rr = fields(fields(buf.subarray(5, 5 + buf.readUInt32BE(1))).find((f) => f.num === 1).data)
      step = { conv: rr.find((f) => f.num === 5)?.data.toString(), ...script.shift() }
      const update = (num, body) => frame(pb().bytes(1, pb().bytes(num, body)).done())
      if (step.kind === "tool") {
        stream.write(update(1, pb().str(1, "probing").done()))
        stream.write(update(27, pb().varint(1, 1).done()))
        stream.write(
          frame(pb().bytes(2, pb().varint(1, 7).str(15, "x1").bytes(11, pb().str(1, "magpie-Read").str(3, "call_" + n++).str(5, "Read").done()).done()).done()),
        )
        return // the client closes it, to run the tool
      }
      const u = step.usage
      stream.write(update(1, pb().str(1, "done").done()))
      const whole = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens
      stream.write(update(14, pb().varint(1, whole).varint(2, u.outputTokens).varint(3, u.cacheReadTokens).varint(4, u.cacheWriteTokens).done()))
      const end = Buffer.from("{}")
      const head = Buffer.alloc(5)
      head[0] = 2
      head.writeUInt32BE(end.length, 1)
      stream.end(Buffer.concat([head, end]))
    })
    stream.on("close", () => {
      if (!step?.usage) return
      const show = () => shown.push({ timestamp: String(Date.now()), model: "claude-fable-5-thinking-max", conversationId: step.conv, tokenUsage: step.usage })
      // Far from Cursor a Run's event shows only once its step has answered,
      // never inside that step's wait. Not SHOWS after the Run closed: that
      // is 45 ms past the wait's last look, which a loaded machine eats
      // (plugins#159, #162).
      if (!far) setTimeout(show, SHOWS)
      else if (by?.done) show()
      else by?.held.push(show)
    })
    stream.on("error", () => {})
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  base = `http://127.0.0.1:${server.address().port}`
})
afterAll(() => server.close())

// Cursor's API, every answer RTT after it was asked: the dashboard's
// events as they stood when the question reached it (halfway)
let asks = 0
function fakeAPI() {
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    if (u === "https://api2.cursor.sh/aiserver.v1.ServerConfigService/GetServerConfig") return Response.json({ agentUrlConfig: { agentUrl: base } })
    if (u === "https://api2.cursor.sh/agent.v1.AgentService/GetUsableModels") return Response.json({ models: [{ modelId: "claude-fable-5-thinking", displayName: "Fable" }] })
    if (u === "https://api2.cursor.sh/aiserver.v1.DashboardService/GetFilteredUsageEvents") {
      asks++
      const timeout = init?.signal
      const sleep = (ms) =>
        new Promise((r, j) => {
          const t = setTimeout(r, ms)
          timeout?.addEventListener("abort", () => (clearTimeout(t), j(timeout.reason)), { once: true })
        })
      await sleep(RTT / 2)
      const evs = shown.map((e) => ({ ...e }))
      await sleep(RTT / 2)
      return Response.json({ usageEventsDisplay: evs.reverse() })
    }
    throw new Error("the test asked " + u)
  }
}

// one step of the conversation, as Claude Code sends it through magpie
async function ask(auth, chat, session) {
  const hooks = await CursorAuthPlugin()
  const out = { headers: {} }
  await hooks["chat.headers"]({ sessionID: session, model: { providerID: "cursor", id: chat.model }, provider: { info: { id: "cursor" } } }, out)
  const l = await hooks.auth.loader(async () => auth)
  const t0 = Date.now()
  const asked = asks
  const me = (asking = { done: false, held: [] })
  const res = await l.fetch(base + "/v1/chat/completions", { method: "POST", headers: new Headers(out.headers), body: JSON.stringify(chat) })
  const j = await res.json()
  me.done = true
  for (const show of me.held.splice(0)) show()
  expect([res.status, j.error]).toEqual([200, undefined])
  return { stop: j.choices[0].finish_reason, usage: j.usage, ms: Date.now() - t0, asks: asks - asked }
}

const chat = (steps) => {
  const messages = [{ role: "user", content: "read the repo and fix the bug " + "x".repeat(4000) }]
  for (let i = 0; i < steps; i++)
    messages.push(
      { role: "assistant", content: "", tool_calls: [{ id: "call_" + i, type: "function", function: { name: "Read", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_" + i, content: "file " + i + " " + "y".repeat(4000) },
    )
  return { model: "claude-fable-5-thinking", messages, tools: [{ type: "function", function: { name: "Read", parameters: { type: "object" } } }] }
}

// what magpie bills for the steps: each step's own, and what it collected
// of earlier steps' (magpie_deferred), which its prompt_tokens leaves out
const sum = (us) =>
  us.reduce(
    (a, u) => ({
      prompt: a.prompt + u.prompt_tokens + (u.magpie_deferred?.prompt_tokens ?? 0),
      cached: a.cached + u.prompt_tokens_details.cached_tokens + (u.magpie_deferred?.cached_tokens ?? 0),
      written: a.written + u.prompt_tokens_details.cache_write_tokens + (u.magpie_deferred?.cache_write_tokens ?? 0),
    }),
    { prompt: 0, cached: 0, written: 0 },
  )
const cursorSum = (evs) =>
  evs.reduce(
    (a, u) => ({
      prompt: a.prompt + u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens,
      cached: a.cached + u.cacheReadTokens,
      written: a.written + u.cacheWriteTokens,
    }),
    { prompt: 0, cached: 0, written: 0 },
  )

test("far from Cursor, a conversation's tool steps add up to what Cursor counted, cache and all", async () => {
  fakeAPI()
  shown.length = 0
  const auth = fresh()
  const session = "claude-code-session-1"
  script = [
    { kind: "tool", usage: CURSOR[0] },
    { kind: "tool", usage: CURSOR[1] },
    { kind: "end", usage: CURSOR[2] },
  ]
  const steps = []
  for (let i = 0; i < 3; i++) steps.push(await ask(auth, chat(i), session))
  expect(steps.map((s) => s.stop)).toEqual(["tool_calls", "tool_calls", "stop"])
  // Cursor counted 95–99% of it from the cache; so does the conversation
  expect(sum(steps.map((s) => s.usage))).toEqual(cursorSum(CURSOR))
  // and no step waited longer than it did before: one wait for its own
  // event, and at most one more for what earlier steps owe. Each wait asks
  // once (the round trip is most of it), so count asks, not milliseconds,
  // which a loaded machine stretches (plugins#165).
  for (const s of steps) expect(s.asks).toBeLessThanOrEqual(2)
})

test("an account whose events never show in time stops waiting for them, and the count still adds up", async () => {
  fakeAPI()
  shown.length = 0
  const auth = fresh()
  const session = "claude-code-session-2"
  const evs = Array.from({ length: 6 }, (_, i) => CURSOR[i % 2])
  script = [...evs.map((usage) => ({ kind: "tool", usage })), { kind: "end", usage: CURSOR[2] }]
  const steps = []
  for (let i = 0; i < 7; i++) steps.push(await ask(auth, chat(i), session))
  // after skipAfter misses in a row a tool step no longer waits
  const tools = steps.slice(0, 6)
  expect(Math.max(...tools.slice(STEP_WAIT.skipAfter).map((s) => s.ms))).toBeLessThan(STEP_WAIT.until / 2)
  expect(sum(steps.map((s) => s.usage))).toEqual(cursorSum([...evs, CURSOR[2]]))
})

test("with nothing naming the session a tool step is guessed, as before: nothing could collect it later", async () => {
  fakeAPI()
  shown.length = 0
  const auth = fresh()
  script = [{ kind: "tool", usage: CURSOR[0] }]
  const s = await ask(auth, chat(0), "")
  expect(s.stop).toBe("tool_calls")
  expect(s.usage.prompt_tokens).toBeGreaterThan(1000) // the estimate
  expect(s.usage.prompt_tokens_details).toEqual({ cached_tokens: 0, cache_write_tokens: 0 })
})

test("near Cursor a tool step still counts its own Run", async () => {
  fakeAPI()
  shown.length = 0
  const auth = fresh()
  // the event shows at once, the round trip short
  far = false
  const keep = STEP_WAIT.until
  script = [{ kind: "tool", usage: CURSOR[0] }]
  const fast = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("GetFilteredUsageEvents")) {
      await new Promise((r) => setTimeout(r, SHOWS + 5))
      return Response.json({ usageEventsDisplay: shown })
    }
    return fast(url, init)
  }
  const s = await ask(auth, chat(0), "near-session")
  expect(STEP_WAIT.until).toBe(keep)
  expect(s.usage).toEqual({
    prompt_tokens: 2 + 63457 + 3081,
    completion_tokens: 621,
    total_tokens: 2 + 63457 + 3081 + 621,
    prompt_tokens_details: { cached_tokens: 63457, cache_write_tokens: 3081 },
  })
})
