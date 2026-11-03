import "./nonet.mjs"
import { afterEach, expect, test } from "vitest"
import { createHash } from "node:crypto"
import { EventEmitter } from "node:events"
import { _internal } from "../src/vendor/engine.mjs"
import { NativeSessionPool, NATIVE_LIMITS, nativeFields } from "../src/vendor/native-session.mjs"
import { bin, text, uint, message, tool, update, setBlob, getBlob, checkpoint, end, readWire, nest, number, readResult } from "./native-test-wire.mjs"

const pools = []
afterEach(async () => { await Promise.all(pools.splice(0).map((p) => p.clear())) })
const registered = [{ name: "audit_echo", description: "synthetic", schema: { type: "object" }, schemaText: '{"type":"object"}' }]
const chat = (extra = {}) => ({ model: "synthetic-model", messages: [{ role: "user", content: "synthetic" }], ...extra })
function owner(extra = {}, overrides = {}) {
  const pool = new NativeSessionPool({ ...NATIVE_LIMITS, ...overrides })
  pools.push(pool)
  const request = chat(extra)
  const prepared = pool.prepare("synthetic-token", request, "synthetic-session", registered)
  const run = pool.create(prepared, { id: "synthetic-model", maxMode: false, params: [] }, _internal)
  run.chatTools = registered
  const writes = []
  let closed = 0
  run.bind({ send: (b) => writes.push(Buffer.from(b)), close: () => closed++ }, new Map(), 11)
  return { run, writes, pool, request, closed: () => closed }
}
const until = async (predicate) => {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("fixture did not reach its expected state")
    await new Promise((r) => setTimeout(r, 5))
  }
}
const frames = (wire) => wire.map((b) => ({ data: b.subarray(5), end: !!(b[0] & 2) }))

// H2 e2e covers the full lifecycle. These cases probe protocol fault/retention
// boundaries without depending on a network socket or the production codec.
test("native KV: failed storage replies with SetBlobResult.error, never success ACK", async () => {
  const { run, writes, closed } = owner({}, { blobBytes: 8 })
  await run.pump(frames([setBlob(31, Buffer.from("opaque"), Buffer.alloc(9))]))
  expect(run.error.status).toBe(503)
  expect(closed()).toBe(1)
  expect(writes).toHaveLength(1)
  const kv = nest(writes[0], 3)
  expect(number(kv, 1)).toBe(31)
  const response = nest(kv, 3)
  expect(readWire(response).map((f) => f.no)).toEqual([1])
  expect(run.blobs.size).toBe(0)
})

test("native KV: known bootstrap hashes are checked; opaque fixed-root IDs retain exact mutable bytes", async () => {
  const { run } = owner()
  const original = Buffer.from("synthetic original")
  const id = createHash("sha256").update(original).digest()
  run.knownHashes.add(id.toString("hex"))
  run.store(id, original)
  expect(() => run.store(id, Buffer.from("changed"))).toThrow("bootstrap blob changed")
  const opaque = Buffer.from("fixed-root")
  run.store(opaque, Buffer.from("first"))
  run.store(opaque, Buffer.from("second"))
  expect(run.blobs.get(opaque.toString("hex")).toString()).toBe("second")
})

test("native checkpoints: missing step/user/turn closure is never promoted, latest received state wins", () => {
  const { run } = owner()
  const user = Buffer.from("synthetic-user")
  const turn = Buffer.from("synthetic-turn")
  const step = Buffer.from("synthetic-step")
  const state = bin(8, turn)
  run.checkpointReceived(state)
  expect(run.checkpoint.status).toBe("incomplete")
  run.store(turn, bin(1, message(bin(1, user), bin(2, step))))
  expect(run.checkpoint.status).toBe("incomplete")
  run.store(user, text(1, "synthetic user"))
  expect(run.checkpoint.status).toBe("incomplete")
  run.store(step, bin(3, text(1, "native thinking")))
  expect(run.checkpoint.status).toBe("complete")
  run.checkpointReceived(bin(8, Buffer.from("new-missing-turn")))
  expect(run.checkpoint.sequence).toBe(2)
  expect(run.checkpoint.status).toBe("incomplete")
  run.store(Buffer.from("unrelated-late-blob"), text(1, "late"))
  expect(run.checkpoint.sequence).toBe(2)
  expect(run.checkpoint.status).toBe("incomplete")
})

test("native checkpoints: unknown/reference-bearing shapes stay retained and disable closure claims", () => {
  const { run } = owner()
  const state = message(bin(31, text(1, "synthetic subagent reference")), bin(99, text(1, "future state")))
  run.checkpointReceived(state)
  expect(run.checkpoint.bytes).toEqual(state)
  expect(run.checkpoint.status).toBe("unsupported")
})

test("native results: independent wire decoder sees exact text, image, explicit error flag and numeric/exec IDs", () => {
  const { run } = owner()
  const image = Buffer.from("89504e470d0a1a0a", "hex")
  const result = run.encodeResult({ role: "tool", tool_call_id: "synthetic_call", content: [{ type: "text", text: 'Error-looking JSON: {"error":"ordinary output"}\n精确' }, { type: "image_url", image_url: { url: "data:image/png;base64," + image.toString("base64") } }], is_error: true })
  const wire = _internal.pb().bytes(2, _internal.pb().varint(1, 41).str(15, "synthetic-exec").bytes(11, result)).done()
  expect(readResult(wire)).toEqual({ id: 41, execID: "synthetic-exec", isError: true,
    content: [{ type: "text", text: 'Error-looking JSON: {"error":"ordinary output"}\n精确' }, { type: "image", data: image, mimeType: "image/png" }] })
  expect(readResult(_internal.pb().bytes(2, _internal.pb().varint(1, 1).bytes(11, run.encodeResult({ role: "tool", tool_call_id: "synthetic_call", content: '{"error":"success text"}' }))).done()).isError).toBe(false)
})

test("native protocol: changed duplicate exec and inconsistent count fail before publishing calls", async () => {
  for (const kind of ["duplicate", "count"]) {
    const { run } = owner()
    const wire = kind === "duplicate" ? [tool(7, "synthetic-call", "first"), tool(7, "synthetic-call", "changed")]
      : [update(27, uint(1, 2)), update(27, uint(1, 1))]
    await run.pump(frames(wire))
    expect(run.error.status).toBe(502)
    expect(run.segment.events.some((e) => e.tool)).toBe(false)
  }
})

for (const kind of [10, 36]) test(`native protocol: repeated MCP envelopes validate before exec kind ${kind} can send a response`, () => {
  const writes = [], closes = []
  const malformed = Buffer.from("08075a0c2a0a61756469745f6563686f5a030a0561", "hex")
  let error
  try {
    _internal.exec(message(bin(kind, Buffer.alloc(0)), malformed), registered, (b) => writes.push(b), (id) => closes.push(id), null, true)
  } catch (e) { error = e }
  expect(error?.status).toBe(502)
  expect(error?.message).toContain("truncated")
  expect(writes).toEqual([])
  expect(closes).toEqual([])
})

test("native protocol: malformed message tails fail explicitly, including after partial display output", async () => {
  const { run } = owner()
  const iterator = run.segment.iterator()
  run.segment.emit({ reasoning: "synthetic partial display" })
  expect((await iterator.next()).value.reasoning).toBe("synthetic partial display")
  await run.pump([{ data: Buffer.from([0x0a, 0x05, 0x01]) }])
  expect((await iterator.next()).value.error.status).toBe(502)
  expect((await iterator.next()).done).toBe(true)
  expect(() => nativeFields(Buffer.from([0x80]))).toThrow("malformed")
})

test("native admission: competing initial requests cannot overwrite a session reservation", () => {
  const { pool, run, request } = owner()
  const competing = { ...pool.prepare("another-account", request, "synthetic-session", registered), account: run.account, controls: run.controls }
  expect(pool.create(competing, run.resolution, _internal)).toBeNull()
  expect(pool.selectors.get(run.account + ":" + run.selector)).toBe(run)
})

test("native admission: completed replay entries are bounded; active entries are preserved", () => {
  const { pool, run } = owner({}, { perAccount: 2, perProcess: 2 })
  run.terminalSeen(nativeFields(message(uint(1, 0), uint(2, 0))))
  run.complete()
  for (const session of ["second", "third"]) {
    const prepared = pool.prepare("synthetic-token", chat(), session, registered)
    const next = pool.create(prepared, run.resolution, _internal)
    if (session === "second") {
      next.chatTools = registered
      next.bind({ send() {}, close() {} }, new Map(), 1)
      next.terminalSeen(nativeFields(message(uint(1, 0), uint(2, 0))))
      next.complete()
    }
  }
  expect(pool.entries.size).toBe(2)
  expect(pool.entries.has(run)).toBe(false)
})

test("native finalization: transport errors after TurnEnded fail instead of converting partial output to success", async () => {
  const { run } = owner()
  const error = { end: true, data: Buffer.from('{"error":{"code":"unavailable","message":"synthetic transport failure"}}') }
  await run.pump([...frames([update(1, text(1, "partial final")), update(14, message(uint(1, 3), uint(2, 2)))]), error])
  expect(run.error.status).toBe(503)
  expect(run.segment.events.some((e) => e.stop)).toBe(false)
})

test("native transport: KV, Run heartbeat and exec heartbeat share queued/in-flight admission", async () => {
  const req = Object.assign(new EventEmitter(), { writable: true, destroyed: false })
  const writes = []
  req.write = (packet) => { writes.push(packet); return false }
  let closed = 0
  const transport = _internal.nativeTransport(req, () => closed++, () => { throw new Error("unexpected failure") }, { outboundBytes: 1024, outboundMessages: 3 })
  const { pb } = _internal
  const messages = [pb().bytes(7, Buffer.alloc(0)).done(), pb().bytes(5, pb().bytes(3, pb().varint(1, 7))).done(), pb().bytes(3, pb().varint(1, 4).bytes(2, pb().bytes(1, Buffer.from("blob")))).done()]
  for (const message of messages) transport.send(message)
  expect(writes).toHaveLength(1)
  expect(transport.outbound).toEqual({ bytes: messages.reduce((n, b) => n + b.length + 5, 0), messages: 3 })
  expect(() => transport.send(messages[0])).toThrow("outbound messages limit")
  transport.close()
  await Promise.resolve()
  expect(transport.outbound).toEqual({ bytes: 0, messages: 0 })
  expect(closed).toBe(1)
  expect(req.listenerCount("drain")).toBe(0)
  expect(req.listenerCount("close")).toBe(0)
})

test("native lifecycle: binding a transport after opening cancellation closes it exactly once", async () => {
  const pool = new NativeSessionPool()
  pools.push(pool)
  const prepared = pool.prepare("synthetic-token", chat(), "synthetic-session", registered)
  const run = pool.create(prepared, { id: "synthetic-model", maxMode: false, params: [] }, _internal)
  await run.cancel("synthetic opening cancellation")
  let closed = 0
  run.bind({ send() { throw new Error("cancelled owner wrote") }, close() { closed++ } }, new Map(), 1)
  expect(closed).toBe(1)
  expect(run.state).toBe("cancelled")
  expect(run.runHeartbeat).toBeUndefined()
  expect(run.execHeartbeat).toBeUndefined()
})

test("native lifecycle: absolute deadline terminates a Run even without a parked result deadline", async () => {
  const { run, closed } = owner({}, { lifetime: 35 })
  const event = await run.segment.iterator().next()
  expect(event.value.error.status).toBe(410)
  expect(run.state).toBe("expired")
  expect(closed()).toBe(1)
})


// #142: Cursor's tool_requests_listed (InteractionUpdate 27) counts every call
// of the model's step, and comes after them, including calls the bridge
// answers itself. Captured from real Cursor (model auto, 2026-10-15), frames
// without their envelopes:
// - steps: get_mcp_tools and a WebSearch the caller doesn't have in one step
//   (both answered here), Cursor's count 2, then read_file a.txt alone and
//   its count 1. 0.2.14 failed it with "inconsistent native tool count".
// - mixed: read_file a.txt, WebSearch (refused), read_file b.txt, count 3.
//   0.2.14 waited for a third call and failed after batchWait.
const captured = {
  steps: ["123f9a01360a2031633366376432386261313531653137303639616231343163626637316165651210653532623935616633363331663934321800a20200b80300","12f80108015a91010a106d61677069652d576562536561726368120b0a047061746812031a01781a5563616c6c2d35653434356466642d636438612d343238642d623561352d6562656137313838376435392d310a66635f61633833643337622d666536362d393964622d623036652d3736613663633562616564325f3122066d61677069652a095765625365617263684a066d61677069657a2462616465343834312d366230342d346464632d626330392d3936313763306635343666389a01360a2031633366376432386261313531653137303639616231343163626637316165651210333632323535313938666465653532321800b80301","0a05da01020802","12fc0108025a95010a106d61677069652d726561645f66696c65120f0a047061746812071a05612e7478741a5563616c6c2d63346339313634342d646332392d343835312d383365372d6261313430626363666361612d320a66635f64623930633334622d643361342d396532312d626336342d3032396231383363346462305f3022066d61677069652a09726561645f66696c654a066d61677069657a2434333165303535662d343234642d343336612d623365322d3464363964373162333066649a01360a2031633366376432386261313531653137303639616231343163626637316165651210333764623631343839646433646665661800b80301","0a05da01020801"],
  mixed: ["12fa015a95010a106d61677069652d726561645f66696c65120f0a047061746812071a05612e7478741a5563616c6c2d64376533623732652d343432312d343166332d623638652d3461386439393737343836352d300a66635f36333866613563312d623731652d393137352d623035372d6133373436613831663463305f3022066d61677069652a09726561645f66696c654a066d61677069657a2431663861373061622d643138302d346434392d386232652d3964343733386133343963669a01360a2062333264396133313831363939656338366462373134626663363735346135351210383739306264393462653165356366341800b80301","12f80108015a91010a106d61677069652d576562536561726368120b0a047061746812031a01781a5563616c6c2d64376533623732652d343432312d343166332d623638652d3461386439393737343836352d310a66635f36333866613563312d623731652d393137352d623035372d6133373436613831663463305f3122066d61677069652a095765625365617263684a066d61677069657a2435356536613234362d306564342d343836332d393733642d3332613234306634303761369a01360a2062333264396133313831363939656338366462373134626663363735346135351210316532363165363634346633643932371800b80301","12fc0108025a95010a106d61677069652d726561645f66696c65120f0a047061746812071a05622e7478741a5563616c6c2d64376533623732652d343432312d343166332d623638652d3461386439393737343836352d320a66635f36333866613563312d623731652d393137352d623035372d6133373436613831663463305f3222066d61677069652a09726561645f66696c654a066d61677069657a2435376434646662632d623532392d343537332d383537342d6238666530326335623766659a01360a2062333264396133313831363939656338366462373134626663363735346135351210376538343239303361646533313434341800b80301","0a05da01020803"],
}
const readFile = [{ name: "read_file", description: "Read a file from disk", schema: { type: "object" }, schemaText: '{"type":"object"}' }]
const capturedFrames = (name) => captured[name].map((h) => ({ data: Buffer.from(h, "hex") }))
// a stream that stays open after its frames, as Cursor's does while it waits
// for the results
async function* open(list) {
  yield* list
  await new Promise(() => {})
}
for (const [name, paths] of [["steps", ["a.txt"]], ["mixed", ["a.txt", "b.txt"]]]) test(`native protocol: calls the bridge answered count toward Cursor's tool count (#142, real ${name} capture)`, async () => {
  const { run, writes } = owner()
  run.chatTools = readFile
  run.pump(open(capturedFrames(name)))
  await until(() => run.error || run.state === "awaiting-results")
  expect(run.error).toBeUndefined()
  const calls = run.segment.events.filter((e) => e.tool).map((e) => e.tool)
  expect(calls.map((c) => [c.name, JSON.parse(c.args).path])).toEqual(paths.map((p) => ["read_file", p]))
  expect(run.segment.events.at(-1).stop).toBe("tool_calls")
  // the refusal (and the MCP tool list) went back to Cursor; no result was sent
  expect(writes.filter((w) => readWire(w).some((f) => f.no === 2))).toHaveLength(name === "steps" ? 1 : 0)
  expect(writes.filter((w) => readWire(w).some((f) => f.no === 5 && readWire(f.data).some((g) => g.no === 2)))).toHaveLength(1)
})

for (const [name, calls] of [["steps", ["WebSearch"]], ["mixed", ["read_file", "WebSearch", "read_file"]]]) test(`stateless decode: calls answered here count toward Cursor's tool count (#142, real ${name} capture)`, async () => {
  // the stream stays open after the count: the decoder must end the step on
  // the count alone
  const events = []
  const done = (async () => {
    for await (const e of _internal.decode(open(capturedFrames(name)), { send() {}, blobs: new Map(), tools: readFile, estimate: 1 })) {
      events.push(e)
      if (e.stop || e.error) return
    }
  })()
  const timer = new Promise((r) => setTimeout(() => r("open"), 1000))
  expect(await Promise.race([done.then(() => "ended"), timer])).toBe("ended")
  // the stateless path hands every MCP name to the caller; get_mcp_tools is
  // answered here
  expect(events.filter((e) => e.tool).map((e) => e.tool.name)).toEqual(calls)
  expect(events.at(-1).stop).toBe("tool_calls")
})

test("native transport: a burst of KV requests past the queue bound waits for writes instead of failing the Run (#142)", async () => {
  // Cursor asks for every history blob of a long conversation at once; on a
  // slow link the replies are written far slower than they are asked for
  const req = Object.assign(new EventEmitter(), { writable: true, destroyed: false })
  const written = []
  let inFlight = 0, most = 0
  req.write = (packet, callback) => {
    inFlight++
    most = Math.max(most, transport.outbound.messages)
    setTimeout(() => { written.push(packet); inFlight--; callback?.(); req.emit("drain") }, 1)
    return false
  }
  const limits = { ...NATIVE_LIMITS, outboundMessages: 16 }
  const transport = _internal.nativeTransport(req, () => {}, (e) => { throw e }, limits)
  const { run } = owner({}, { outboundMessages: 16 })
  run.transport = transport
  const blob = Buffer.from("synthetic history message")
  run.blobs.set(blob.toString("hex"), blob)
  run.pump(open(frames(Array.from({ length: 300 }, (_, i) => getBlob(1000 + i, blob)))))
  await until(() => run.error || written.length === 300)
  expect(run.error).toBeUndefined()
  expect(most).toBeLessThanOrEqual(16)
  expect(written.map((w) => number(nest(w.subarray(5), 3), 1))).toEqual(Array.from({ length: 300 }, (_, i) => 1000 + i))
})

// #155 (midmirror, Auto): a step of 13 calls, nine of them long-argument
// tools, failed after batchWait with no call delivered; the same step
// sealed on a retry that took 33s. Cursor sends each call once the model
// has written it, so the calls arrive spread over longer than batchWait
// with no single pause that long. 0.2.15 counted batchWait from the first.
test("native protocol: a step whose calls keep arriving seals past batchWait from its first call (#155)", async () => {
  const { run } = owner({}, { batchWait: 300 })
  const gap = () => new Promise((r) => setTimeout(r, 150))
  async function* spread() {
    for (const id of [7, 8, 9]) {
      yield* frames([tool(id, "call-" + id, "long arguments " + id)])
      await gap()
    }
    yield* frames([update(27, uint(1, 3))])
    await new Promise(() => {})
  }
  run.pump(spread())
  await until(() => run.error || run.state === "awaiting-results")
  expect(run.error).toBeUndefined()
  expect(run.segment.events.filter((e) => e.tool)).toHaveLength(3)
  expect(run.segment.events.at(-1).stop).toBe("tool_calls")
})

test("native protocol: a step that stops sending fails batchWait after its latest call (#155)", async () => {
  const { run } = owner({}, { batchWait: 300 })
  const started = Date.now()
  async function* stalled() {
    yield* frames([tool(7, "call-7", "one")])
    await new Promise((r) => setTimeout(r, 150))
    yield* frames([tool(8, "call-8", "two"), update(27, uint(1, 3))])
    await new Promise(() => {})
  }
  run.pump(stalled())
  await until(() => run.error)
  expect(run.error).toMatchObject({ status: 502, message: expect.stringMatching(/^Cursor did not complete its declared native tool batch: 2 of 3 calls came/) })
  expect(Date.now() - started).toBeGreaterThanOrEqual(440)
})

// #377 (Okxdd123, grok-4.7): a step that counted its batch, then thought,
// then wrote one long call's arguments for over batchWait, sending only
// heartbeats while it wrote, failed as a batch never completed. A
// heartbeat is Cursor still on the step; silence and a heartbeat-only
// stretch are bounded by idle and quiet (#2672).
test("native protocol: heartbeats while a counted call's arguments are written keep the batch open (#377)", async () => {
  const { run } = owner({}, { batchWait: 300 })
  async function* slow() {
    yield* frames([update(27, uint(1, 1)), update(4, text(1, "thinking"))])
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 100))
      yield* frames([update(13, Buffer.alloc(0))])
    }
    yield* frames([tool(7, "call-7", "long arguments")])
    await new Promise(() => {})
  }
  run.pump(slow())
  await until(() => run.error || run.state === "awaiting-results")
  expect(run.error).toBeUndefined()
  expect(run.segment.events.filter((e) => e.tool)).toHaveLength(1)
})

test("native protocol: a batch that never completes says how much of it came (#377)", async () => {
  const { run } = owner({}, { batchWait: 200 })
  run.pump((async function* () {
    yield* frames([tool(7, "call-7", "one"), update(27, uint(1, 3))])
    await new Promise(() => {})
  })())
  await until(() => run.error)
  expect(run.error.message).toMatch(/^Cursor did not complete its declared native tool batch: 1 of 3 calls came, 0 answered here, none since \d+ ms$/)
})

// #2672 bounds each wait on Cursor, not the step: calls that keep coming,
// each sooner than idle, seal however long the step takes in all.
test("native protocol: a step whose calls each come within idle outlasts idle in all (#2672)", async () => {
  const { run } = owner({}, { batchWait: 1000, idle: 200 })
  async function* spread() {
    for (const id of [7, 8, 9]) {
      yield* frames([tool(id, "call-" + id, "long arguments " + id)])
      await new Promise((r) => setTimeout(r, 150))
    }
    yield* frames([update(27, uint(1, 3))])
    await new Promise(() => {})
  }
  run.pump(spread())
  await until(() => run.error || run.state === "awaiting-results")
  expect(run.error).toBeUndefined()
  // parked for the caller: idle no longer counts
  await new Promise((r) => setTimeout(r, 400))
  expect(run.error).toBeUndefined()
  expect(run.state).toBe("awaiting-results")
})

test("native protocol: a step silent after its first call fails at idle, before batchWait (#2672)", async () => {
  const { run } = owner({}, { batchWait: 5000, idle: 150 })
  const started = Date.now()
  run.pump((async function* () {
    yield* frames([update(4, text(1, "thinking")), tool(7, "call-7", "one")])
    await new Promise(() => {})
  })())
  await until(() => run.error)
  expect(run.error).toMatchObject({ status: 502, message: "Cursor went quiet: no message for 0 s, its last message tool call (try again)" })
  expect(Date.now() - started).toBeLessThan(1000)
})

// Quiet.frames must not hold the frames it passed on while the stream stays
// open: a long turn streams many MB through one Run.
test("native protocol: frames already passed on are not kept while the Run streams on (#2672)", async () => {
  const { Quiet } = await import("../src/vendor/native-session.mjs")
  const refs = []
  let release
  const held = new Promise((r) => { release = r })
  async function* src() {
    for (let i = 0; i < 200; i++) {
      const f = { data: Buffer.alloc(64 * 1024, i & 255) }
      refs.push(new WeakRef(f))
      yield f
    }
    await held // the stream stays open
  }
  const it = new Quiet(NATIVE_LIMITS, () => {}).frames(src())
  for (let i = 0; i < 200; i++) await it.next()
  const pending = it.next()
  for (let i = 0; i < 5 && refs.some((r) => r.deref()); i++) {
    // Bun.gc(true) in upstream: a forced full GC. Node exposes gc() to
    // scripts only with --expose-gc (set in vitest.config.ts); without it
    // this loop degrades to a collect hint and the test may fail — the
    // retention contract itself is engine behavior, not GC timing.
    globalThis.gc?.()
    await new Promise((r) => setTimeout(r, 0))
  }
  // the last frame may still be held by the generator's own state
  expect(refs.filter((r) => r.deref()).length).toBeLessThanOrEqual(2)
  release()
  await pending
})
