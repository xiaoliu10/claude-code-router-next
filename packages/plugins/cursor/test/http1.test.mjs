// Where HTTP/2 can't open a Run (a proxy or network that blocks it), the
// Run goes over HTTP/1.1 as Cursor's clients run it: RunSSE down, a
// BidiAppend for each client message up. Only a failure that says HTTP/2
// itself can't be had keeps the Runs after it on HTTP/1.1; a refused
// connection doesn't. Against a fake Cursor: its API, RunSSE and BidiAppend
// included, answered by a stand-in fetch, its agent API by an HTTP/2 server
// here, or a port nothing listens on. Nothing reaches Cursor.
import "./nonet.mjs" // first: no request leaves this machine
import { afterAll, afterEach, beforeEach, expect, test } from "vitest"
import http from "node:http"
import http2 from "node:http2"
import { CursorAuthPlugin, _internal } from "../src/vendor/engine.mjs"

const { fields, pb, frame, h2Blocked, open, openH1 } = _internal
const H2 = _internal.H2 ?? {}
const H1 = _internal.H1 ?? {}

const real = globalThis.fetch
const saved = { ...H2 }
const savedH1 = { ...H1 }
afterEach(() => {
  globalThis.fetch = real
  Object.assign(H2, saved)
  Object.assign(H1, savedH1)
})
beforeEach(() => _internal.resetH1())

// how many HTTP/2 sessions the plugin opened
let h2Tries = 0
const connect = http2.connect
http2.connect = (origin, ...rest) => {
  if (!String(origin).startsWith("http://127.0.0.1:")) throw new Error("the test connected to " + origin)
  h2Tries++
  return connect(origin, ...rest)
}
afterAll(() => {
  http2.connect = connect
  _internal.resetH1()
})

const jwt = (exp) => ["e30", Buffer.from(JSON.stringify({ exp, sub: "http1-" + Math.random() })).toString("base64url"), "sig"].join(".")
let n = 0
const fresh = () => ({ type: "oauth", access: jwt(Math.floor(Date.now() / 1000) + 7200 + ++n), refresh: "", expires: 0, accountId: "a@b.c" })

// a port nothing listens on, for now
async function freePort() {
  const server = http.createServer()
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  const { port } = server.address()
  await new Promise((r) => server.close(r))
  return port
}

const end = (body) => {
  const f = frame(Buffer.from(body))
  f[0] = 2
  return f
}
const update = (num, body) => frame(pb().bytes(1, pb().bytes(num, body)).done())

// the agent API over HTTP/2 on port: "answer" answers a Run "hi" and the
// turn's end, and counts it in runs once the Run's first message has come:
// a loaded machine can read a stalled Run's stream only after the test set
// "answer", and that stream, its client gone, never brings a message;
// "stall" takes the stream and never sends its head; "refuse" closes the
// stream with code (REFUSED_STREAM unless told) before its head.
// resets refuses that many streams first, whatever the mode.
async function agent(port, mode, { resets = 0, code = http2.constants.NGHTTP2_REFUSED_STREAM } = {}) {
  const a = { mode, runs: 0, resets, code }
  a.server = http2.createServer()
  a.server.on("stream", (stream) => {
    stream.on("error", () => {})
    if (a.resets > 0 || a.mode === "refuse") {
      a.resets--
      return stream.close(a.code)
    }
    // a stream read so late that its client is gone isn't answered
    if (a.mode === "stall" || stream.destroyed) return
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" })
    let buf = Buffer.alloc(0)
    let answered = false
    stream.on("data", (c) => {
      buf = Buffer.concat([buf, c])
      if (answered || buf.length < 5 || buf.length < 5 + buf.readUInt32BE(1)) return
      answered = true
      a.runs++
      stream.write(update(1, pb().str(1, "hi").done()))
      stream.write(update(14, pb().varint(1, 0).done()))
      stream.end(end("{}"))
    })
  })
  await new Promise((r) => a.server.listen(port, "127.0.0.1", r))
  return a
}

// Cursor's API over HTTP/1.1. RunSSE's stream answers once BidiAppend has
// brought the Run's first message: "hi" and the turn's end, or the error
// given in its end frame (refuse) or as an HTTP error (sseHttp). A
// BidiAppend answers, answers an HTTP error (appendHttp), or never answers
// (hangAppend). What each call carried is noted.
// an HTTP error: Connect's JSON, or a plain body as a proxy or load balancer sends
const httpError = (e) =>
  typeof e.body === "string"
    ? new Response(e.body, { status: e.status, headers: { "content-type": "text/plain" } })
    : new Response(JSON.stringify(e.body), { status: e.status, headers: { "content-type": "application/json" } })
function fakeAPI(base, { refuse, sseHttp, appendHttp, hangAppend } = {}) {
  const seen = { sse: [], appends: [] }
  const streams = new Map() // request id → RunSSE's controller
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    const h = new Headers(init.headers)
    if (u.endsWith("/aiserver.v1.ServerConfigService/GetServerConfig")) return Response.json({ agentUrlConfig: { agentUrl: base } })
    if (u.endsWith("/agent.v1.AgentService/GetUsableModels")) return Response.json({ models: [{ modelId: "grok-4.7-fast", displayName: "Grok 4.7 Fast" }] })
    if (u === "https://api2.cursor.sh/agent.v1.AgentService/RunSSE") {
      const id = fields(Buffer.from(init.body).subarray(5))[0].data.toString()
      seen.sse.push({ id, type: h.get("content-type"), auth: h.get("authorization"), encoding: h.get("accept-encoding") })
      if (sseHttp) return httpError(sseHttp)
      if (refuse) return new Response(end(JSON.stringify({ error: refuse })), { headers: { "content-type": "application/connect+proto" } })
      return new Response(new ReadableStream({ start: (c) => streams.set(id, c) }), { headers: { "content-type": "application/connect+proto" } })
    }
    if (u === "https://api2.cursor.sh/aiserver.v1.BidiService/BidiAppend") {
      const f = fields(Buffer.from(init.body))
      const id = fields(f.find((x) => x.num === 2).data)[0].data.toString()
      const seqno = f.find((x) => x.num === 3)?.n ?? 0
      const msg = Buffer.from(f.find((x) => x.num === 1).data.toString(), "hex")
      seen.appends.push({ id, seqno, type: h.get("content-type") })
      if (appendHttp) return httpError(appendHttp)
      if (hangAppend) return new Promise((_, no) => init.signal?.addEventListener("abort", () => no(init.signal.reason), { once: true }))
      const c = streams.get(id)
      if (c && seqno === 0 && fields(msg).some((x) => x.num === 1)) {
        c.enqueue(update(1, pb().str(1, "hi").done()))
        c.enqueue(update(14, pb().varint(1, 0).done()))
        c.enqueue(end("{}"))
        c.close()
      }
      return new Response(new Uint8Array(0), { headers: { "content-type": "application/proto" } })
    }
    throw new Error("the test asked " + u)
  }
  return seen
}

async function ask(auth, base) {
  const hooks = await CursorAuthPlugin()
  const l = await hooks.auth.loader(async () => auth)
  const res = await l.fetch(base + "/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "grok-4.7-fast", messages: [{ role: "user", content: "hello" }] }),
  })
  return { status: res.status, body: await res.json() }
}

test("a Run whose HTTP/2 connection is refused goes as RunSSE + BidiAppend over HTTP/1.1, and the next tries HTTP/2 again", async () => {
  const base = `http://127.0.0.1:${await freePort()}`
  const seen = fakeAPI(base)
  const auth = fresh()
  h2Tries = 0
  const a = await ask(auth, base)
  expect(a.status).toBe(200)
  expect(a.body.choices[0].message.content).toBe("hi")
  expect(h2Tries).toBe(1)
  expect(seen.sse).toHaveLength(1)
  expect(seen.sse[0]).toMatchObject({ type: "application/connect+proto", encoding: "identity" })
  expect(seen.sse[0].auth).toBe(`Bearer ${auth.access}`)
  // the Run's first message, numbered 0, under RunSSE's request id
  expect(seen.appends[0]).toMatchObject({ id: seen.sse[0].id, seqno: 0, type: "application/proto" })
  const b = await ask(auth, base)
  expect(b.body.choices[0].message.content).toBe("hi")
  expect(h2Tries).toBe(2) // a refused connection says nothing of HTTP/2
  expect(seen.sse).toHaveLength(2)
})

test("refused once, then a working HTTP/2 agent: the next Run goes over HTTP/2", async () => {
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  const seen = fakeAPI(base)
  const auth = fresh()
  h2Tries = 0
  const a = await ask(auth, base)
  expect(a.body.choices[0].message.content).toBe("hi")
  expect(seen.sse).toHaveLength(1)
  const ag = await agent(port, "answer")
  try {
    const b = await ask(auth, base)
    expect(b.body.choices[0].message.content).toBe("hi")
    expect(h2Tries).toBe(2)
    expect(ag.runs).toBe(1)
    expect(seen.sse).toHaveLength(1)
  } finally {
    ag.server.close()
  }
})

test("no head over HTTP/2 in time keeps the Runs after it on HTTP/1.1", async () => {
  H2.wait = 200
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  const ag = await agent(port, "stall")
  try {
    const seen = fakeAPI(base)
    const auth = fresh()
    h2Tries = 0
    const a = await ask(auth, base)
    expect(a.body.choices[0].message.content).toBe("hi")
    expect(seen.sse).toHaveLength(1)
    const b = await ask(auth, base)
    expect(b.body.choices[0].message.content).toBe("hi")
    expect(h2Tries).toBe(1) // no second try over HTTP/2
    expect(seen.sse).toHaveLength(2)
  } finally {
    ag.server.close()
  }
})

test("a region error over HTTP/1.1 sends the Run back to HTTP/2 at the region's agent host", async () => {
  H2.wait = 200
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  const ag = await agent(port, "stall")
  try {
    const auth = fresh()
    fakeAPI(base)
    await ask(auth, base) // HTTP/2 found blocked: on HTTP/1.1 from now on
    ag.mode = "answer"
    const seen = fakeAPI(base, { refuse: { code: "permission_denied", message: "This team is served in its region only" } })
    h2Tries = 0
    const r = await ask(auth, base)
    expect(r.status).toBe(200)
    expect(r.body.choices[0].message.content).toBe("hi")
    expect(seen.sse).toHaveLength(1)
    expect(h2Tries).toBe(1)
    expect(ag.runs).toBe(1)
  } finally {
    ag.server.close()
  }
})

test("only a failure that says HTTP/2 itself can't be had counts as blocked", () => {
  expect(h2Blocked(Object.assign(new Error("no answer over HTTP/2 in 15s"), { h2Timeout: true }))).toBe(true)
  expect(h2Blocked(new Error("h2 is not supported"))).toBe(true)
  expect(h2Blocked(Object.assign(new Error("Protocol error"), { code: "ERR_HTTP2_ERROR" }))).toBe(true)
  expect(h2Blocked(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" }))).toBe(false)
  expect(h2Blocked(Object.assign(new Error("getaddrinfo ENOTFOUND agentn.global.api5.cursor.sh"), { code: "ENOTFOUND" }))).toBe(false)
  expect(h2Blocked(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }))).toBe(false)
  expect(h2Blocked(Object.assign(new Error("connect ENETUNREACH"), { code: "ENETUNREACH" }))).toBe(false)
  expect(h2Blocked(new Error("something else"))).toBe(false)
  // a connection reset that also says "protocol error" is still a connection's failure
  expect(h2Blocked(Object.assign(new Error("Protocol error: read ECONNRESET"), { code: "ECONNRESET" }))).toBe(false)
  // a stream the server refused: HTTP/2 itself got through
  expect(h2Blocked(Object.assign(new Error("Stream closed with error code NGHTTP2_REFUSED_STREAM"), { code: "ERR_HTTP2_STREAM_ERROR" }))).toBe(false)
})

test("an error Cursor ends RunSSE with keeps its status", async () => {
  const base = `http://127.0.0.1:${await freePort()}`
  fakeAPI(base, {
    refuse: { code: "unauthenticated", message: "Error", details: [{ debug: { error: "ERROR_NOT_LOGGED_IN", details: { title: "Authentication error", detail: "If you are logged in, try logging out and back in." } } }] },
  })
  const r = await ask(fresh(), base)
  expect(r.status).toBe(401)
  expect(r.body.error.message).toContain("Authentication error")
})

const SIGNED_OUT = { code: "unauthenticated", message: "Error", details: [{ debug: { error: "ERROR_NOT_LOGGED_IN", details: { title: "Authentication error", detail: "If you are logged in, try logging out and back in." } } }] }

// REFUSED_STREAM comes as an error on the stream; CANCEL (and NO_ERROR)
// closes it with none, which only its close says
for (const [name, code] of [
  ["REFUSED_STREAM", http2.constants.NGHTTP2_REFUSED_STREAM],
  ["CANCEL", http2.constants.NGHTTP2_CANCEL],
]) {
  test(`a stream closed before its head (${name}) falls back at once, and the next Run tries HTTP/2 again`, async () => {
    H2.wait = 2000
    const port = await freePort()
    const base = `http://127.0.0.1:${port}`
    const ag = await agent(port, "refuse", { code })
    try {
      const seen = fakeAPI(base)
      const auth = fresh()
      h2Tries = 0
      const t = Date.now()
      const a = await ask(auth, base)
      expect(a.body.choices[0].message.content).toBe("hi")
      expect(Date.now() - t).toBeLessThan(1000) // not the head timer's 2 s
      expect(seen.sse).toHaveLength(1)
      expect(_internal.onH1()).toBe(false)
      ag.mode = "answer"
      const b = await ask(auth, base)
      expect(b.body.choices[0].message.content).toBe("hi")
      expect(h2Tries).toBe(2)
      expect(ag.runs).toBe(1)
      expect(seen.sse).toHaveLength(1)
    } finally {
      ag.server.close()
    }
  })
}

test("a BidiAppend that never answers ends the Run with deadline_exceeded", async () => {
  H1.appendWait = 200
  const base = `http://127.0.0.1:${await freePort()}`
  fakeAPI(base, { hangAppend: true })
  const t = Date.now()
  const r = await ask(fresh(), base)
  expect(r.status).toBe(502)
  expect(r.body.error.message).toContain("BidiAppend got no answer")
  expect(Date.now() - t).toBeLessThan(5000)
})

test("an HTTP error from RunSSE keeps its status", async () => {
  const base = `http://127.0.0.1:${await freePort()}`
  fakeAPI(base, { sseHttp: { status: 401, body: SIGNED_OUT } })
  const r = await ask(fresh(), base)
  expect(r.status).toBe(401)
  expect(r.body.error.message).toContain("Authentication error")
})

test("an HTTP error from BidiAppend keeps its status", async () => {
  const base = `http://127.0.0.1:${await freePort()}`
  fakeAPI(base, { appendHttp: { status: 401, body: SIGNED_OUT } })
  const r = await ask(fresh(), base)
  expect(r.status).toBe(401)
  expect(r.body.error.message).toContain("Authentication error")
})

test("an HTTP error with no Connect error of its own keeps its status: 401 from RunSSE, 429 from BidiAppend", async () => {
  const base = `http://127.0.0.1:${await freePort()}`
  fakeAPI(base, { sseHttp: { status: 401, body: "Unauthorized" } })
  expect((await ask(fresh(), base)).status).toBe(401)
  fakeAPI(base, { appendHttp: { status: 429, body: "<html>Too Many Requests</html>" } })
  expect((await ask(fresh(), base)).status).toBe(429)
})

test("appends go up one at a time, numbered in order, a slow one holding the rest", async () => {
  const got = []
  let inFlight = 0
  let most = 0
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    if (u.endsWith("/agent.v1.AgentService/RunSSE")) return new Response(new ReadableStream({}), { headers: { "content-type": "application/connect+proto" } })
    if (u.endsWith("/aiserver.v1.BidiService/BidiAppend")) {
      const f = fields(Buffer.from(init.body))
      const seqno = f.find((x) => x.num === 3)?.n ?? 0
      inFlight++
      most = Math.max(most, inFlight)
      if (seqno === 0) await new Promise((r) => setTimeout(r, 150)) // the first one slow
      got.push({ seqno, data: Buffer.from(f.find((x) => x.num === 1).data.toString(), "hex").toString() })
      inFlight--
      return new Response(new Uint8Array(0), { headers: { "content-type": "application/proto" } })
    }
    throw new Error("the test asked " + u)
  }
  const o = await openH1({ "x-request-id": "r-1", authorization: "Bearer t" })
  for (const m of ["first", "blob 1", "blob 2", "blob 3"]) o.req.write(frame(Buffer.from(m)))
  for (let i = 0; i < 100 && got.length < 4; i++) await new Promise((r) => setTimeout(r, 10))
  o.session.close()
  expect(got).toEqual([
    { seqno: 0, data: "first" },
    { seqno: 1, data: "blob 1" },
    { seqno: 2, data: "blob 2" },
    { seqno: 3, data: "blob 3" },
  ])
  expect(most).toBe(1)
})

test("a Run cancelled while HTTP/2 opens is not counted as HTTP/2 failing", async () => {
  H2.wait = 10_000
  const port = await freePort()
  const ag = await agent(port, "stall")
  try {
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 50)
    const t = Date.now()
    const o = await open(`http://127.0.0.1:${port}`, { "x-request-id": "r-2" }, ac.signal)
    expect(o.error?.message).toContain("cancelled")
    expect(Date.now() - t).toBeLessThan(2000)
    expect(_internal.onH1()).toBe(false)
  } finally {
    ag.server.close()
  }
})

test("Runs kept on HTTP/1.1 try HTTP/2 again once H2.retryAfter has passed", async () => {
  H2.wait = 200
  H2.retryAfter = 300
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  const ag = await agent(port, "stall")
  try {
    fakeAPI(base)
    const auth = fresh()
    h2Tries = 0
    await ask(auth, base)
    expect(_internal.onH1()).toBe(true)
    await new Promise((r) => setTimeout(r, 400))
    expect(_internal.onH1()).toBe(false)
    ag.mode = "answer"
    const b = await ask(auth, base)
    expect(b.body.choices[0].message.content).toBe("hi")
    expect(h2Tries).toBe(2)
    expect(ag.runs).toBe(1)
  } finally {
    ag.server.close()
  }
})

test("a region error on a Run that fell back for itself alone tries HTTP/2 again too", async () => {
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  const ag = await agent(port, "answer", { resets: 1 }) // the first stream refused: that Run alone falls back
  try {
    const seen = fakeAPI(base, { refuse: { code: "permission_denied", message: "This team is served in its region only" } })
    const r = await ask(fresh(), base)
    expect(r.status).toBe(200)
    expect(r.body.choices[0].message.content).toBe("hi")
    expect(seen.sse).toHaveLength(1)
    expect(ag.runs).toBe(1)
  } finally {
    ag.server.close()
  }
})
