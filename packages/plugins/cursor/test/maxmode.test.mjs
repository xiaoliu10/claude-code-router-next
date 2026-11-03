// A request goes to the agent API as the picker's model with the variant's
// parameters, in Max Mode when that variant is Max Mode's; and a model
// Cursor turns away for want of Max Mode ("Max Mode Required: The model
// "gpt-5.6-luna" requires Max Mode to be enabled", ARNO on Discord) is asked
// again in it — against a fake Cursor: its API a stand-in fetch, its agent
// API an HTTP/2 server here. Nothing reaches Cursor.
import "./nonet.mjs" // first: no request leaves this machine
import { afterAll, afterEach, beforeAll, expect, test } from "vitest"
import http2 from "node:http2"
import { CursorAuthPlugin, _internal } from "../src/vendor/engine.mjs"

const { fields, pb, frame, maxRequired } = _internal

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const jwt = (exp) => ["e30", Buffer.from(JSON.stringify({ exp })).toString("base64url"), "sig"].join(".")
let n = 0
// a sign-in of its own, so no list kept for another is used
const fresh = () => ({ type: "oauth", access: jwt(Math.floor(Date.now() / 1000) + 7200 + 50_000 + ++n), refresh: "", expires: 0, accountId: "a@b.c" })

const en = (...vs) => ({ enumParameter: { values: vs.map((value) => ({ value })) } })
const v = (pv, o = {}) => ({ parameterValues: Object.entries(pv).map(([id, value]) => ({ id, value })), ...o })
// Cursor's picker, as AvailableModels answers it in JSON
const PICKER = [
  {
    name: "claude-opus-5-5", clientDisplayName: "Claude Opus 5.5", contextTokenLimit: 300000, contextTokenLimitForMaxMode: 1000000, supportsNonMaxMode: true,
    parameterDefinitions: [{ id: "context", parameterType: en("300k", "1m") }, { id: "effort", parameterType: en("medium", "high") }],
    variants: [v({ context: "300k", effort: "medium" }, { isDefaultNonMaxConfig: true, legacySlug: "claude-opus-5-5-medium" }), v({ context: "1m", effort: "medium" }, { isMaxMode: true, legacySlug: "claude-opus-5-5-medium" })],
  },
  { name: "composer-2.5", clientDisplayName: "Composer 2.5", contextTokenLimit: 200000, supportsNonMaxMode: true, variants: [v({}, { isDefaultNonMaxConfig: true, legacySlug: "composer-2.5" })] },
  // Cursor says nothing of Max Mode for it, and refuses it without
  { name: "gpt-5.6-luna", clientDisplayName: "GPT-5.6 Luna", contextTokenLimit: 272000, supportsNonMaxMode: true, parameterDefinitions: [{ id: "reasoning", parameterType: en("low", "high") }], variants: [v({ reasoning: "high" }, { isDefaultNonMaxConfig: true, legacySlug: "gpt-5.6-luna-high" })] },
]

// the agent API: each Run's model noted; one asked for without Max Mode
// that only has it is refused as Cursor refuses it
let server, base
const runs = []
const maxOnly = new Set(["gpt-5.6-luna-high"])
const str = (fs, num) => fs.find((f) => f.num === num)?.data?.toString() ?? ""
const num = (fs, k) => fs.find((f) => f.num === k)?.n ?? 0
beforeAll(async () => {
  server = http2.createServer()
  server.on("stream", (stream) => {
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" })
    let buf = Buffer.alloc(0)
    let answered = false
    stream.on("data", (c) => {
      buf = Buffer.concat([buf, c])
      if (answered || buf.length < 5 || buf.length < 5 + buf.readUInt32BE(1)) return
      answered = true
      const rr = fields(fields(buf.subarray(5, 5 + buf.readUInt32BE(1))).find((f) => f.num === 1).data)
      const details = fields(rr.find((f) => f.num === 3).data)
      const requested = fields(rr.find((f) => f.num === 9).data)
      const run = {
        model: str(details, 1),
        detailsMax: num(details, 7),
        requested: str(requested, 1),
        requestedMax: num(requested, 2),
        params: requested.filter((f) => f.num === 3).map((f) => fields(f.data)).map((p) => [str(p, 1), str(p, 2)]),
      }
      runs.push(run)
      const end = (body) => {
        const b = Buffer.from(JSON.stringify(body))
        const head = Buffer.alloc(5)
        head[0] = 2
        head.writeUInt32BE(b.length, 1)
        stream.end(Buffer.concat([head, b]))
      }
      if (maxOnly.has(run.model) && !run.detailsMax) {
        const detail = `The model "${run.model}" requires Max Mode to be enabled. Please enable Max Mode and try again.`
        return end({ error: { code: "failed_precondition", message: "Error", details: [{ debug: { error: "ERROR_MAX_MODE_REQUIRED", details: { title: "Max Mode Required", detail } } }] } })
      }
      const update = (k, body) => frame(pb().bytes(1, pb().bytes(k, body)).done())
      stream.write(update(1, pb().str(1, "hi").done()))
      stream.write(update(14, pb().varint(1, 10).varint(2, 1).done()))
      end({})
    })
    stream.on("error", () => {})
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  base = `http://127.0.0.1:${server.address().port}`
})
afterAll(() => server.close())

function fakeAPI() {
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    if (u === "https://api2.cursor.sh/aiserver.v1.ServerConfigService/GetServerConfig") return Response.json({ agentUrlConfig: { agentUrl: base } })
    if (u === "https://api2.cursor.sh/aiserver.v1.AiService/AvailableModels") {
      expect(JSON.parse(init.body)).toEqual({ useModelParameters: true, doNotUseMarkdown: true })
      return Response.json({ models: PICKER })
    }
    throw new Error("the test asked " + u)
  }
}

async function ask(auth, model, effort) {
  const hooks = await CursorAuthPlugin()
  const l = await hooks.auth.loader(async () => auth)
  const chat = { model, messages: [{ role: "user", content: "hello" }], ...(effort ? { reasoning_effort: effort } : {}) }
  const res = await l.fetch(base + "/v1/chat/completions", { method: "POST", body: JSON.stringify(chat) })
  return { status: res.status, body: await res.json() }
}

test("Cursor's Max Mode refusal is recognised", () => {
  expect(maxRequired('Max Mode Required: The model "gpt-5.6-luna-low" requires Max Mode to be enabled. Please enable M')).toBe(true)
  expect(maxRequired("MAX_MODE_REQUIRED")).toBe(true)
  expect(maxRequired("usage limit reached: slow down")).toBe(false)
})

test("a request goes as the picker's model, with the size's parameters, in Max Mode for a Max Mode size", async () => {
  fakeAPI()
  const auth = fresh()
  runs.length = 0
  let r = await ask(auth, "claude-opus-5-5@300k")
  expect([r.status, r.body.error]).toEqual([200, undefined])
  expect(r.body.choices[0].message.content).toBe("hi")
  expect(runs).toEqual([{ model: "claude-opus-5-5-medium", detailsMax: 0, requested: "claude-opus-5-5-medium", requestedMax: 0, params: [["context", "300k"], ["effort", "medium"]] }])

  runs.length = 0
  r = await ask(auth, "claude-opus-5-5@1m", "medium")
  expect(r.status).toBe(200)
  expect(runs).toEqual([{ model: "claude-opus-5-5-medium", detailsMax: 1, requested: "claude-opus-5-5-medium", requestedMax: 1, params: [["context", "1m"], ["effort", "medium"]] }])

  // an id 0.1.11 listed: the variant it stood for, not the picker's bare
  // name, which Cursor answers 502 "AI Model Not Found"
  runs.length = 0
  r = await ask(auth, "claude-opus-5-5")
  expect(r.status).toBe(200)
  expect(runs).toEqual([{ model: "claude-opus-5-5-medium", detailsMax: 0, requested: "claude-opus-5-5-medium", requestedMax: 0, params: [["context", "300k"], ["effort", "medium"]] }])

  runs.length = 0
  r = await ask(auth, "composer-2.5")
  expect(r.status).toBe(200)
  expect(runs).toEqual([{ model: "composer-2.5", detailsMax: 0, requested: "composer-2.5", requestedMax: 0, params: [] }])
})

test("a model Cursor says needs Max Mode is asked again in Max Mode, and so from then on", async () => {
  fakeAPI()
  const auth = fresh()
  runs.length = 0
  let r = await ask(auth, "gpt-5.6-luna", "high")
  expect([r.status, r.body.error]).toEqual([200, undefined])
  expect(runs.map((x) => [x.model, x.detailsMax, x.requestedMax])).toEqual([["gpt-5.6-luna-high", 0, 0], ["gpt-5.6-luna-high", 1, 1]])
  runs.length = 0
  r = await ask(auth, "gpt-5.6-luna", "high")
  expect(r.status).toBe(200)
  expect(runs.map((x) => [x.model, x.detailsMax])).toEqual([["gpt-5.6-luna-high", 1]])
})
