import "./nonet.mjs"
import { afterEach, beforeEach, expect, test } from "vitest"
import http2 from "node:http2"
import { randomUUID } from "node:crypto"
import { CursorAuthPlugin, _internal } from "../src/vendor/engine.mjs"
import { NATIVE_LIMITS, nativeSessions } from "../src/vendor/native-session.mjs"
import { readWire, nest, number, string, message, uint, text, update, tool, end, readResult, setBlob, getBlob } from "./native-test-wire.mjs"

const savedFetch = globalThis.fetch
const servers = []
const limits = { ...NATIVE_LIMITS }
const usageWait = { ..._internal.STEP_WAIT }
const until = async (predicate) => {
  const deadline = Date.now() + 1200
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("fixture did not reach its expected state")
    await new Promise((r) => setTimeout(r, 5))
  }
}
beforeEach(async () => {
  await nativeSessions.clear()
  _internal.resetH1()
  // An abandoned native Run now owes dashboard usage. Scale that empty-event
  // wait with this fake rather than outlasting Bun's five-second test budget.
  Object.assign(_internal.STEP_WAIT, { first: 0, every: 5, until: 40, ask: 250, owedAt: 1000 })
})
afterEach(async () => {
  await nativeSessions.clear()
  for (const { server, sessions } of servers.splice(0)) {
    for (const session of sessions) session.destroy()
    await new Promise((r) => server.close(r))
  }
  globalThis.fetch = savedFetch
  _internal.resetH1()
  for (const key of Object.keys(NATIVE_LIMITS)) if (!(key in limits)) delete NATIVE_LIMITS[key]
  Object.assign(NATIVE_LIMITS, limits)
  Object.assign(_internal.STEP_WAIT, usageWait)
  for (const map of [_internal.owed, _internal.flights, _internal.misses, _internal.unreadable]) map.clear()
})

// Refusing the local H2 stream exercises the existing RunSSE/BidiAppend path.
// All API calls are synthetic; unknown calls fail instead of leaving localhost.
async function fixture({ failResult = false, stallKv = false } = {}) {
  const sessions = new Set()
  const server = http2.createServer()
  server.on("session", (s) => { sessions.add(s); s.on("error", () => {}); s.on("close", () => sessions.delete(s)) })
  server.on("stream", (s) => { s.on("error", () => {}); s.close(http2.constants.NGHTTP2_REFUSED_STREAM) })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  servers.push({ server, sessions })
  const base = `http://127.0.0.1:${server.address().port}`
  const seen = { sse: 0, runs: 0, appends: [], results: [], closes: [], kv: [], histories: [], maxInFlight: 0, conversationId: "", dashboardRequests: 0 }
  let inFlight = 0
  let controller
  let ended = false
  let requestID
  let bootstrap = new Map(), imported = []
  const push = (b) => { if (!ended) controller.enqueue(b) }
  const finish = () => {
    if (ended) return
    push(end())
    ended = true
    controller.close()
  }
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    if (u.endsWith("/aiserver.v1.ServerConfigService/GetServerConfig")) return Response.json({ agentUrlConfig: { agentUrl: base } })
    if (u.endsWith("/agent.v1.AgentService/GetUsableModels")) return Response.json({ models: [{ modelId: "synthetic-h1-model", displayName: "Synthetic H1" }] })
    if (u.endsWith("/aiserver.v1.DashboardService/GetFilteredUsageEvents")) {
      seen.dashboardRequests++
      return Response.json({ usageEventsDisplay: [] })
    }
    if (u.endsWith("/agent.v1.AgentService/RunSSE")) {
      seen.sse++
      ended = false
      requestID = string(Buffer.from(init.body).subarray(5), 1)
      return new Response(new ReadableStream({
        start(c) {
          controller = c
          init.signal.addEventListener("abort", () => {
            if (ended) return
            ended = true
            c.close()
          }, { once: true })
        },
      }))
    }
    if (!u.endsWith("/aiserver.v1.BidiService/BidiAppend")) throw new Error("unexpected synthetic API call: " + u)
    const body = Buffer.from(init.body)
    expect(string(nest(body, 2), 1)).toBe(requestID)
    const seqno = number(body, 3)
    const wire = Buffer.from(string(body, 1), "hex")
    inFlight++
    seen.maxInFlight = Math.max(seen.maxInFlight, inFlight)
    seen.appends.push(seqno)
    try {
      const fs = readWire(wire)
      if (fs.some((f) => f.no === 1)) {
        seen.runs++
        seen.conversationId = string(nest(wire, 1), 5)
        if (seen.runs > 1) {
          imported = []
          seen.histories.push(imported)
          const refs = readWire(nest(nest(wire, 1), 1)).filter((f) => f.no === 1)
          bootstrap = new Map(refs.map((f, i) => [1000 + i, i]))
          for (const [i, ref] of refs.entries()) push(getBlob(1000 + i, ref.data))
          return new Response(new Uint8Array(0))
        }
        push(update(4, text(1, "synthetic native thinking one")))
        push(update(27, uint(1, 1)))
        push(tool(7, "h1-native-call-one"))
      } else if (fs.some((f) => f.no === 2)) {
        const result = readResult(wire)
        expect(result.execID).toBe("exec-" + result.id)
        expect(seen.results.some((r) => r.id === result.id)).toBe(false)
        seen.results.push(result)
        // Hold the result append so a premature/concurrent close is observable.
        await new Promise((r) => setTimeout(r, 25))
        if (failResult) return new Response('{"code":"unavailable","message":"synthetic append failed after receiving result"}', { status: 503 })
      } else if (fs.some((f) => f.no === 5)) {
        const control = nest(wire, 5)
        const close = readWire(control).find((f) => f.no === 1)
        if (close) {
          const id = number(close.data, 1)
          const result = seen.results.find((r) => r.id === id)
          expect(result).toBeDefined()
          expect(seen.closes).not.toContain(id)
          seen.closes.push(id)
          if (id === 7) {
            push(update(4, text(1, "synthetic native thinking two")))
            push(tool(8, "h1-native-call-two", result.content[0].text))
            push(update(27, uint(1, 1)))
          } else {
            push(update(1, text(1, result.content[0].text)))
            push(update(14, message(uint(1, 17), uint(2, 5), uint(3, 11))))
            finish()
          }
        }
      } else if (fs.some((f) => f.no === 3)) {
        const kv = nest(wire, 3)
        const id = number(kv, 1)
        seen.kv.push(id)
        if (bootstrap.has(id)) {
          imported[bootstrap.get(id)] = JSON.parse(nest(nest(kv, 2), 1).toString())
          bootstrap.delete(id)
          if (!bootstrap.size) {
            const marker = imported.filter((m) => m.role === "tool").flatMap((m) => m.content).flatMap((r) => r.experimental_content ?? []).map((r) => r.text).join("|")
            push(update(1, text(1, "rebuilt:" + marker)))
            push(update(14, message(uint(1, 13), uint(2, 4))))
            finish()
          }
        }
        if (stallKv && readWire(kv).some((f) => f.no === 2)) await new Promise((_, reject) => {
          if (init.signal.aborted) reject(init.signal.reason)
          else init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true })
        })
      }
      return new Response(new Uint8Array(0))
    } finally {
      inFlight--
    }
  }
  const account = {
    type: "oauth",
    access: `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 7200, sub: "synthetic-h1-" + randomUUID() })).toString("base64url")}.fixture`,
    refresh: "", accountId: "fixture@example.invalid",
  }
  const plugin = await CursorAuthPlugin()
  const loader = await plugin.auth.loader(async () => account)
  const ask = async (chat) => {
    const response = await loader.fetch(base + "/v1/chat/completions", {
      method: "POST", headers: { "x-magpie-cursor-session": "synthetic-h1-session" }, body: JSON.stringify(chat),
    })
    if (chat.stream) return response
    return { status: response.status, body: await response.json() }
  }
  return { seen, ask, account, push, ended: () => ended, inFlight: () => inFlight }
}
const initial = () => ({ model: "synthetic-h1-model", messages: [{ role: "user", content: "two synthetic calls" }],
  tools: [{ type: "function", function: { name: "audit_echo", parameters: { type: "object" } } }] })
const continuation = (chat, response, value) => ({ ...chat, messages: [...chat.messages, response.body.choices[0].message,
  { role: "tool", tool_call_id: response.body.choices[0].message.tool_calls[0].id, content: value }] })

test("native HTTP/1: two external roundtrips keep one RunSSE and serialize result-before-close BidiAppends", async () => {
  const { seen, ask } = await fixture()
  const chat = initial()
  const first = await ask(chat)
  expect(first.status).toBe(200)
  const marker = "synthetic-h1-result-" + randomUUID()
  const secondChat = continuation(chat, first, marker)
  const second = await ask(secondChat)
  expect(second.status).toBe(200)
  expect(JSON.parse(second.body.choices[0].message.tool_calls[0].function.arguments)).toEqual({ value: marker })
  const final = await ask(continuation(secondChat, second, marker))
  expect(final.status).toBe(200)
  expect(final.body.choices[0].message.content).toBe(marker)
  expect(final.body.choices[0].finish_reason).toBe("stop")
  expect(final.body.usage.prompt_tokens).toBe(17)
  expect(final.body.usage.completion_tokens).toBe(5)
  expect(seen).toMatchObject({ sse: 1, runs: 1, appends: [0, 1, 2, 3, 4], closes: [7, 8], maxInFlight: 1 })
  expect(seen.results.map((r) => r.id)).toEqual([7, 8])
})

for (const bound of ["bytes", "messages"]) test(`native loader HTTP/1: parked KV replies stalled past writeWait at the outbound ${bound} bound abort all transport work`, async () => {
  NATIVE_LIMITS.outboundBytes = 4 << 20
  NATIVE_LIMITS.writeWait = 100
  NATIVE_LIMITS.outboundMessages = bound === "messages" ? 4 : 256
  const a = await fixture({ stallKv: true })
  const chat = initial()
  const first = await a.ask(chat)
  expect(first.status).toBe(200)
  const owner = [...nativeSessions.entries][0]
  const blobID = Buffer.from("synthetic-queued-blob")
  a.push(setBlob(90, blobID, Buffer.alloc(bound === "bytes" ? 1 << 20 : 1)))
  await until(() => a.seen.kv.includes(90) && a.inFlight() === 0)
  a.push(getBlob(91, blobID))
  await until(() => a.seen.kv.includes(91))
  for (let i = 0; i < 8; i++) a.push(getBlob(92 + i, blobID))
  await until(() => !!owner.error)
  expect(owner.error).toMatchObject({ status: 503 })
  expect(owner.error.message).toContain("outbound")
  expect(owner.error.message).toContain(bound)
  await until(() => a.inFlight() === 0 && a.ended())
  expect(owner.transport.outbound).toEqual({ bytes: 0, messages: 0 })
  expect(owner.ac.signal.aborted).toBe(true)
  expect(a.seen.kv).toEqual([90, 91])
  expect(a.seen.maxInFlight).toBe(1)
  expect(a.seen.results).toEqual([])
  expect(a.seen.closes).toEqual([])
  // Retention overflow ends this owner. A later request is history input to
  // the stateless path, covered with a rebuilding server in native-e2e.
  expect(nativeSessions.prepare("unrelated-account", continuation(chat, first, "late after overflow"), "synthetic-selector", []).fallback).toBeTruthy()
})

for (const stream of [false, true]) test(`native HTTP/1: ${stream ? "streamed" : "JSON"} uncertain append is reported once; supplied history can rebuild`, async () => {
  const { seen, ask, account } = await fixture({ failResult: true })
  const chat = initial(), first = await ask(chat)
  const owner = [...nativeSessions.entries][0]
  const next = { ...continuation(chat, first, "synthetic uncertain result"), stream }
  const failed = await ask(next)
  expect(failed.status).toBe(503)
  const body = stream ? await failed.json() : failed.body
  expect(body.error.message).toContain("append failed")
  expect(seen.results).toHaveLength(1)
  expect(seen.closes).toEqual([])
  expect(owner.state).toBe("failed")
  const key = _internal.usageKey(account.access, seen.conversationId)
  expect(_internal.owed.get(key)?.n).toBe(1)
  // A missing owner is optional retention, including an uncertain prior append.
  // Reuse the provided result in imported history; never resubmit its native exec.
  const rebuilt = await ask({ ...next, stream: false })
  expect(rebuilt.status).toBe(200)
  expect(rebuilt.body.choices[0].message.content).toBe("rebuilt:synthetic uncertain result")
  expect(rebuilt.body.usage.magpie_deferred).toBeUndefined()
  expect(_internal.owed.get(key)?.n).toBe(1) // absent dashboard count stays unknown
  expect(seen.dashboardRequests).toBeGreaterThan(0)
  expect(seen.runs).toBe(2)
  expect(seen.sse).toBe(2)
  expect(seen.results).toHaveLength(1)
  expect(seen.closes).toEqual([])
  expect(seen.maxInFlight).toBe(1)
})
