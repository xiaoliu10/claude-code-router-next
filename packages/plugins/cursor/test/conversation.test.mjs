// A conversation's Runs keep one conversation_id and Cursor's usage counts
// the cache once, as the built-in's cursorConversation and cursorUsage do
// (magpie #498, internal/gateway/cursor_conversation_test.go), against a
// fake Cursor: its API answered by a stand-in fetch, its agent API by an
// HTTP/2 server here. Nothing reaches Cursor.
import "./nonet.mjs" // first: no request leaves this machine
import { afterAll, afterEach, beforeAll, expect, test } from "vitest"
import http2 from "node:http2"
import { CursorAuthPlugin, _internal } from "../src/vendor/engine.mjs"

const { fields, pb, frame, SESSION } = _internal

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))
// no Run leaves this machine: the agent API is the fake one here or none
const connect = http2.connect
http2.connect = (origin, ...rest) => {
  if (!String(origin).startsWith("http://127.0.0.1:")) throw new Error("the test connected to " + origin)
  return connect(origin, ...rest)
}
afterAll(() => (http2.connect = connect))

const jwt = (exp) => ["e30", Buffer.from(JSON.stringify({ exp })).toString("base64url"), "sig"].join(".")
let n = 0
// a sign-in of its own, so no list or endpoint kept for another is used
const fresh = () => ({ type: "oauth", access: jwt(Math.floor(Date.now() / 1000) + 7200 + ++n), refresh: "", expires: 0, accountId: "a@b.c" })

// the agent API: each Run's conversation_id noted, answered "hi" and the
// turn's usage
let server, base
const runs = []
let turnEnded = pb().varint(1, 0).done()
beforeAll(async () => {
  server = http2.createServer()
  server.on("stream", (stream, headers) => {
    // the headers first, as Cursor's do: the client sends the Run after them
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" })
    let buf = Buffer.alloc(0)
    let answered = false
    stream.on("data", (c) => {
      buf = Buffer.concat([buf, c])
      if (answered || buf.length < 5 || buf.length < 5 + buf.readUInt32BE(1)) return
      answered = true
      const msg = buf.subarray(5, 5 + buf.readUInt32BE(1))
      const rr = fields(fields(msg).find((f) => f.num === 1).data)
      runs.push({ path: headers[":path"], conv: rr.find((f) => f.num === 5)?.data.toString() })
      const update = (num, body) => frame(pb().bytes(1, pb().bytes(num, body)).done())
      stream.write(update(1, pb().str(1, "hi").done()))
      stream.write(update(14, turnEnded))
      const end = Buffer.from("{}")
      const head = Buffer.alloc(5)
      head[0] = 2
      head.writeUInt32BE(end.length, 1)
      stream.end(Buffer.concat([head, end]))
    })
    stream.on("error", () => {})
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  base = `http://127.0.0.1:${server.address().port}`
})
afterAll(() => server.close())

// Cursor's API: the server config naming the fake agent API, and a list
function fakeAPI() {
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u === "https://api2.cursor.sh/aiserver.v1.ServerConfigService/GetServerConfig") return Response.json({ agentUrlConfig: { agentUrl: base } })
    if (u === "https://api2.cursor.sh/agent.v1.AgentService/GetUsableModels") return Response.json({ models: [{ modelId: "grok-4.7-fast", displayName: "Grok 4.7 Fast" }] })
    throw new Error("the test asked " + u)
  }
}

// ask sends a chat completion as magpie's host does: the chat.headers hook
// told the session, then the loader's fetch with what it added
async function ask(auth, chat, { session = "", provider = "cursor" } = {}) {
  const hooks = await CursorAuthPlugin()
  const out = { headers: {} }
  await hooks["chat.headers"]({ sessionID: session, model: { providerID: provider, id: chat.model }, provider: { info: { id: provider } } }, out)
  const l = await hooks.auth.loader(async () => auth)
  const res = await l.fetch(base + "/v1/chat/completions", { method: "POST", headers: new Headers(out.headers), body: JSON.stringify(chat) })
  const j = await res.json()
  expect([res.status, j.error]).toEqual([200, undefined])
  expect(j.choices[0].message.content).toBe("hi")
  return { conv: runs.at(-1).conv, usage: j.usage, headers: out.headers }
}

const turn = (first, ...more) => ({
  model: "grok-4.7-fast",
  messages: [{ role: "system", content: "be brief" }, { role: "user", content: first }, ...more],
})
const later = (first) => turn(first, { role: "assistant", content: "hi" }, { role: "user", content: "and then?" })
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

test("a session's turns keep one conversation_id; another session, or another first message, has its own", async () => {
  fakeAPI()
  const auth = fresh()
  const a1 = await ask(auth, turn("fix the bug"), { session: "ses_claude_1" })
  expect(a1.headers).toEqual({ [SESSION]: "ses_claude_1" })
  expect(runs.at(-1).path).toBe("/agent.v1.AgentService/Run")
  expect(a1.conv).toMatch(UUID)
  const a2 = await ask(auth, later("fix the bug"), { session: "ses_claude_1" })
  expect(a2.conv).toBe(a1.conv)
  // a subagent under the same session: a conversation of its own
  const sub = await ask(auth, turn("search the repo"), { session: "ses_claude_1" })
  expect(sub.conv).not.toBe(a1.conv)
  // the same words in another session
  const other = await ask(auth, turn("fix the bug"), { session: "ses_claude_2" })
  expect(other.conv).not.toBe(a1.conv)
})

test("Codex's prompt_cache_key names the session before the host's", async () => {
  fakeAPI()
  const auth = fresh()
  const c1 = await ask(auth, { ...turn("hello"), prompt_cache_key: "thread-1" }, { session: "ses_x" })
  const c2 = await ask(auth, { ...later("hello"), prompt_cache_key: "thread-1" }, { session: "ses_y" })
  expect(c2.conv).toBe(c1.conv)
  const c3 = await ask(auth, { ...later("hello"), prompt_cache_key: "thread-2" }, { session: "ses_x" })
  expect(c3.conv).not.toBe(c1.conv)
  // with no session from the host at all
  const c4 = await ask(auth, { ...later("hello"), prompt_cache_key: "thread-1" })
  expect(c4.conv).toBe(c1.conv)
})

test("nothing naming the session: each Run a new id, as before", async () => {
  fakeAPI()
  const auth = fresh()
  // magpie's own, made of the first message when the agent names no session
  const m1 = await ask(auth, turn("hi"), { session: "magpie-0123456789abcdef01234567" })
  expect(m1.headers).toEqual({})
  const m2 = await ask(auth, turn("hi"), { session: "magpie-0123456789abcdef01234567" })
  const m3 = await ask(auth, turn("hi"))
  expect(new Set([m1.conv, m2.conv, m3.conv]).size).toBe(3)
  for (const c of [m1.conv, m2.conv, m3.conv]) expect(c).toMatch(UUID)
})

test("the hook leaves other providers' requests alone", async () => {
  const hooks = await CursorAuthPlugin()
  const out = { headers: {} }
  await hooks["chat.headers"]({ sessionID: "ses_1", model: { providerID: "grok" }, provider: { info: { id: "grok" } } }, out)
  expect(out.headers).toEqual({})
})

test("usage takes the cache out of input_tokens, and keeps reasoning", async () => {
  fakeAPI()
  const auth = fresh()
  // the issue's Opus turn: 15050 in, 15046 of it written to the cache
  turnEnded = pb().varint(1, 15050).varint(2, 12).varint(3, 0).varint(4, 15046).varint(5, 7).done()
  let { usage } = await ask(auth, turn("x"), { session: "s" })
  expect(usage).toEqual({
    prompt_tokens: 15050,
    completion_tokens: 12,
    total_tokens: 15062,
    prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 15046 },
    completion_tokens_details: { reasoning_tokens: 7 },
  })
  // read from the cache and some written
  turnEnded = pb().varint(1, 15119).varint(2, 3).varint(3, 15096).varint(4, 23).done()
  ;({ usage } = await ask(auth, turn("x"), { session: "s" }))
  expect(usage).toEqual({
    prompt_tokens: 15119,
    completion_tokens: 3,
    total_tokens: 15122,
    prompt_tokens_details: { cached_tokens: 15096, cache_write_tokens: 23 },
  })
  // all of it from the cache: no guess added
  turnEnded = pb().varint(1, 900).varint(2, 3).varint(3, 900).done()
  ;({ usage } = await ask(auth, turn("x"), { session: "s" }))
  expect(usage.prompt_tokens).toBe(900)
  expect(usage.prompt_tokens_details).toEqual({ cached_tokens: 900, cache_write_tokens: 0 })
  // Cursor counted nothing: the prompt is guessed, as before
  turnEnded = pb().varint(2, 3).done()
  ;({ usage } = await ask(auth, turn("x".repeat(400)), { session: "s" }))
  expect(usage.prompt_tokens).toBeGreaterThan(90)
  expect(usage.prompt_tokens_details).toEqual({ cached_tokens: 0, cache_write_tokens: 0 })
})

// GLM-5.3 called the catalog's <tool name=...> entries bare, as tools of
// their own (#11): each entry is the CallDynamicTool call itself
test("the tool catalog writes each tool as its CallDynamicTool call", () => {
  const tools = [
    { name: "Read", description: "read a file", schemaText: '{"type":"object"}' },
    { name: "Bash", description: "run a command", schemaText: '{"type":"object"}' },
  ]
  const s = _internal.catalog(tools)
  expect(s).not.toContain("<tool name=")
  for (const t of tools) {
    expect(s).toContain(`<call>CallDynamicTool({"namespace":"tools","toolName":"${t.name}","arguments":{...}})\n${t.description}\narguments schema: ${t.schemaText}\n</call>`)
  }
  expect(_internal.catalog([])).toBe("")
})

// a turn of thinking only is an empty reply, which the client asks again
test("a turn that ends with thinking only is an empty reply", async () => {
  const update = (num, body) => ({ data: pb().bytes(1, pb().bytes(num, body)).done() })
  const run = async (...frames) => {
    const out = []
    for await (const p of _internal.decode(frames, { send() {}, blobs: new Map(), tools: [], estimate: 1 })) out.push(p)
    return out
  }
  const empty = (why) => ({ error: { status: 502, message: `an empty reply (${why}; try again)` } })
  const thinking = update(4, pb().str(1, "hmm").done())
  const ended = update(14, pb().varint(2, 3).done())
  expect(await run(thinking, ended)).toEqual([
    { reasoning: "hmm" },
    empty("Cursor ended the turn; after 3 chars of thinking, no text and no tool call; Cursor counted 3 output tokens"),
  ])
  // and so at the stream's end
  expect(await run(thinking, { end: true, data: Buffer.from("{}") })).toEqual([
    { reasoning: "hmm" },
    empty("the Run's stream ended (an empty end frame); after 3 chars of thinking, no text and no tool call"),
  ])
  // with text it finishes
  const out = await run(thinking, update(1, pb().str(1, "hi").done()), ended)
  expect(out.at(-1).stop).toBe("stop")
})

// an empty reply names what the Run sent before it (#60): Cursor's own
// tools it asked for and was refused, updates and messages not read, and
// an end frame that said no error, so a report can tell the causes apart
test("an empty reply says what the Run sent before it", async () => {
  const sent = []
  const run = async (...frames) => {
    const out = []
    for await (const p of _internal.decode(frames, { send: (m) => sent.push(m), blobs: new Map(), tools: [], estimate: 1 })) out.push(p)
    return out
  }
  const update = (num, body) => ({ data: pb().bytes(1, pb().bytes(num, body)).done() })
  // exec_server_message asking for a tool of Cursor's own (field 14), twice
  const own = (id) => ({ data: pb().bytes(2, pb().varint(1, id).bytes(14, pb().str(1, "ls").done()).str(15, "e" + id).done()).done() })
  const unknownUpdate = update(7, pb().str(1, "x").done())
  const unknownMessage = { data: pb().bytes(9, pb().str(1, "y").done()).done() }
  const out = await run(own(1), own(2), unknownUpdate, unknownMessage, update(14, pb().done()))
  expect(out).toEqual([
    {
      error: {
        status: 502,
        message:
          "an empty reply (Cursor ended the turn; with no thinking, no text and no tool call; Cursor counted 0 output tokens; Cursor's own tools asked for and refused: #14 ×2; updates not read: #7; messages not read: #9; try again)",
      },
    },
  ])
  // each refused call was answered, as before
  expect(sent.length).toBe(4)
  // an end frame with an error that has no code: its words are kept
  const [e] = await run({ end: true, data: Buffer.from('{"error":{"message":"stream reset by upstream"}}') })
  expect(e.error.status).toBe(502)
  expect(e.error.message).toContain('end frame: {"error":{"message":"stream reset by upstream"}}')
  // a long end frame is cut short
  const [l] = await run({ end: true, data: Buffer.from(JSON.stringify({ metadata: "z".repeat(1000) })) })
  expect(l.error.message.length).toBeLessThan(420)
})
