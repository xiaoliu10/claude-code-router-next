// A step that calls the caller's tools has no TurnEndedUpdate before the
// Run is closed, so its usage is the dashboard's usage event of the Run's
// conversation (yetone/magpie#676): read, not guessed with no cache.
import "./nonet.mjs" // first: no request leaves this machine
import { afterEach, expect, test } from "vitest"
import { _internal } from "../src/vendor/engine.mjs"

const { pb, decode, stepUsage, usageKey, STEP_WAIT } = _internal

const real = globalThis.fetch
const wait = { ...STEP_WAIT }
afterEach(() => {
  globalThis.fetch = real
  Object.assign(STEP_WAIT, wait)
  for (const map of [_internal.owed, _internal.flights, _internal.misses, _internal.unreadable]) map.clear()
})

const update = (num, body) => ({ data: pb().bytes(1, pb().bytes(num, body)).done() })
// the server's call of the caller's tool cache_probe, as Cursor sends it
const call = {
  data: pb()
    .bytes(2, pb().varint(1, 7).str(15, "x1").bytes(11, pb().str(1, "magpie-cache_probe").str(3, "call_1").str(5, "cache_probe").done()).done())
    .done(),
}
const listed = update(27, pb().varint(1, 1).done())

async function run(frames, opts) {
  const out = []
  for await (const p of decode(frames, { send() {}, blobs: new Map(), tools: [], estimate: 2395, ...opts })) out.push(p)
  return out
}

test("a step that calls tools takes the dashboard's count of its Run", async () => {
  const seen = []
  const out = await run([update(1, pb().str(1, "probing").done()), listed, call], {
    close: () => seen.push("close"),
    stepUsage: async () => (seen.push("usage"), { input: 41, output: 133, cacheRead: 4224, cacheWrite: 0, reasoning: 0 }),
  })
  // the Run closed before the count is asked for
  expect(seen).toEqual(["close", "usage"])
  expect(out.at(-1)).toEqual({
    stop: "tool_calls",
    usage: {
      prompt_tokens: 4265,
      completion_tokens: 133,
      total_tokens: 4398,
      prompt_tokens_details: { cached_tokens: 4224, cache_write_tokens: 0 },
    },
  })
})

test("a count Cursor gave, or none to be had, is as before", async () => {
  let asked = 0
  const stepUsage = async () => (asked++, null)
  // the turn ended with fewer calls than listed: its own count
  const two = update(27, pb().varint(1, 2).done())
  const end = { end: true, data: Buffer.from("{}") }
  let out = await run([two, call, update(14, pb().varint(1, 900).varint(2, 3).varint(3, 800).done()), end], { stepUsage })
  expect(asked).toBe(0)
  expect(out.at(-1).usage.prompt_tokens_details.cached_tokens).toBe(800)
  // no event in time: the guess
  out = await run([listed, call], { stepUsage })
  expect(asked).toBe(1)
  expect(out.at(-1).usage.prompt_tokens).toBe(2395)
  // a text turn never asks
  out = await run([update(1, pb().str(1, "READY").done()), update(14, pb().varint(1, 10).varint(2, 1).done())], { stepUsage })
  expect(asked).toBe(1)
  expect(out.at(-1).stop).toBe("stop")
})

test("stepUsage finds the Run's event by its conversation and time, once", async () => {
  Object.assign(STEP_WAIT, { first: 0, every: 10, until: 200 })
  const since = Date.now()
  const conv = "3ca0f6c1-b4a9-4991-9ae4-349bb3951caa"
  const ev = (dt, c, t) => ({ timestamp: String(since + dt), model: "grok-4.7-medium-fast", conversationId: c, tokenUsage: t })
  let shows = 2 // the event shows on the third ask
  const asks = []
  globalThis.fetch = async (url, init) => {
    asks.push({ url: String(url), body: JSON.parse(init.body), auth: init.headers.Authorization })
    return Response.json({
      usageEventsDisplay: [
        ev(2500, "another-conversation", { inputTokens: 9, outputTokens: 9 }),
        ev(-30_000, conv, { inputTokens: 8, outputTokens: 8 }), // an earlier Run of it
        ...(shows-- > 0 ? [] : [ev(2600, conv, { inputTokens: 41, outputTokens: 261, cacheReadTokens: 4224 })]),
      ],
    })
  }
  expect(await stepUsage("tok", conv, since)).toEqual({ input: 41, output: 261, cacheRead: 4224, cacheWrite: 0, reasoning: 0 })
  expect(asks.length).toBe(3)
  expect(asks[0].url).toBe("https://api2.cursor.sh/aiserver.v1.DashboardService/GetFilteredUsageEvents")
  expect(asks[0].auth).toBe("Bearer tok")
  expect(Number(asks[0].body.startDate)).toBeLessThan(since)
  // counted once: another step of the conversation doesn't take it again
  expect(await stepUsage("tok", conv, since)).toBe(null)
  // an account that can't read the events isn't asked again
  asks.length = 0
  globalThis.fetch = async () => (asks.push(1), new Response("{}", { status: 403 }))
  expect(await stepUsage("tok", conv, since)).toBe(null)
  expect(asks.length).toBe(1)
})

// yetone/magpie#1053: a step's count can be owed to a later step of its
// conversation (ledger); latency.test.mjs runs whole conversations
test("an account that can't read its events is guessed as before, and owes nothing", async () => {
  const { ledger, owed, unreadable, misses } = _internal
  Object.assign(STEP_WAIT, { first: 0, every: 10, until: 60 })
  const conv = "6b5568d9-0000-4000-8000-000000000003"
  let asks = 0
  globalThis.fetch = async () => (asks++, new Response("{}", { status: 403 }))
  const out = await run([listed, call], { stepUsage: ledger("tok-403", conv, Date.now(), undefined, true).own })
  expect(out.at(-1).usage.prompt_tokens).toBe(2395)
  expect(owed.has(usageKey("tok-403", conv))).toBe(false)
  // nor asked again for a while
  expect(await ledger("tok-403", conv, Date.now(), undefined, true).own()).toBe(null)
  expect(asks).toBe(1)
  unreadable.clear()
  misses.clear()
})

test("what a Run collected and never gave out goes to the conversation's next step", async () => {
  const { ledger, owed } = _internal
  Object.assign(STEP_WAIT, { first: 0, every: 10, until: 60 })
  const conv = "6b5568d9-0000-4000-8000-000000000004"
  const since = Date.now()
  globalThis.fetch = async () =>
    Response.json({ usageEventsDisplay: [{ timestamp: String(since + 4000), conversationId: conv, tokenUsage: { inputTokens: 2, outputTokens: 621, cacheReadTokens: 63457, cacheWriteTokens: 3081 } }] })
  owed.set(usageKey("tok", conv), { since, n: 1, ready: since, carry: null })
  // the Run collects the debt, then fails before its step is counted
  const failed = ledger("tok", conv, Date.now(), undefined, true)
  await new Promise((r) => setTimeout(r, 30))
  failed.done()
  expect(owed.get(usageKey("tok", conv)).carry).toEqual({ input: 2, output: 621, cacheRead: 63457, cacheWrite: 3081, reasoning: 0 })
  // the next step that ends the turn has it, once
  const next = ledger("tok", conv, Date.now(), undefined, true)
  expect(await next.owed(true)).toEqual({ input: 2, output: 621, cacheRead: 63457, cacheWrite: 3081, reasoning: 0 })
  expect(owed.has(usageKey("tok", conv))).toBe(false)
  expect(await ledger("tok", conv, Date.now(), undefined, true).owed(true)).toBe(null)
})

test("usage events with the same conversation and time are counted once per account, including zero", async () => {
  Object.assign(STEP_WAIT, { first: 0, every: 5, until: 20 })
  const since = Date.now()
  const conv = "synthetic-account-claims"
  globalThis.fetch = async (_url, init) => Response.json({
    usageEventsDisplay: [{ timestamp: String(since + 2000), conversationId: conv,
      tokenUsage: init.headers.Authorization === "Bearer synthetic-claims-a"
        ? { inputTokens: 11, outputTokens: 3, cacheReadTokens: 100, cacheWriteTokens: 7 }
        : { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }],
  })
  expect(await stepUsage("synthetic-claims-a", conv, since)).toEqual({ input: 11, output: 3, cacheRead: 100, cacheWrite: 7, reasoning: 0 })
  const zero = await stepUsage("synthetic-claims-b", conv, since)
  expect(zero).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 })
  // A dashboard zero is authoritative, rather than missing usage to estimate.
  const out = await run([listed, call], { stepUsage: async () => zero })
  expect(out.at(-1).usage).toEqual({
    prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
    prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
  })
  expect(await stepUsage("synthetic-claims-a", conv, since)).toBe(null)
  expect(await stepUsage("synthetic-claims-b", conv, since)).toBe(null)
})

test("ledger debt for the same conversation is collected only by its account", async () => {
  const { ledger, owed } = _internal
  Object.assign(STEP_WAIT, { first: 0, every: 5, until: 20, owedAt: 60_000 })
  const since = Date.now() - 30_000
  const conv = "synthetic-account-debt"
  const keyA = usageKey("synthetic-debt-a", conv)
  const keyB = usageKey("synthetic-debt-b", conv)
  const usageA = { input: 11, output: 3, cacheRead: 100, cacheWrite: 7, reasoning: 0 }
  const usageB = { input: 22, output: 5, cacheRead: 200, cacheWrite: 9, reasoning: 0 }
  let shown = false
  globalThis.fetch = async (_url, init) => {
    const u = init.headers.Authorization === "Bearer synthetic-debt-a" ? usageA : usageB
    return Response.json({ usageEventsDisplay: shown ? [{ timestamp: String(since + 2000), conversationId: conv,
      tokenUsage: { inputTokens: u.input, outputTokens: u.output, cacheReadTokens: u.cacheRead, cacheWriteTokens: u.cacheWrite } }] : [] })
  }
  const a = ledger("synthetic-debt-a", conv, since, undefined, true)
  const b = ledger("synthetic-debt-b", conv, since, undefined, true)
  let nextA, nextB
  try {
    for (const book of [a, b]) {
      const out = await run([listed, call], { stepUsage: book.own, owedUsage: book.owed })
      // An unpaid Run reports zero now, then its own account collects it later.
      expect(out.at(-1).usage.total_tokens).toBe(0)
      book.done()
    }
    expect(owed.get(keyA)).toMatchObject({ since, n: 1, carry: null })
    expect(owed.get(keyB)).toMatchObject({ since, n: 1, carry: null })
    shown = true
    nextB = ledger("synthetic-debt-b", conv, Date.now(), undefined, true)
    expect(await nextB.owed(true)).toEqual(usageB)
    expect(owed.has(keyB)).toBe(false)
    expect(owed.get(keyA)).toMatchObject({ since, n: 1, carry: null })
    nextA = ledger("synthetic-debt-a", conv, Date.now(), undefined, true)
    expect(await nextA.owed(true)).toEqual(usageA)
    expect(owed.has(keyA)).toBe(false)
    expect(await nextA.owed(true)).toBe(null)
    expect(await nextB.owed(true)).toBe(null)
  } finally {
    for (const book of [a, b, nextA, nextB]) book?.done()
  }
})

test("ledger flights and late carry keep account and collection identity during cleanup", async () => {
  const { ledger, owed, flights } = _internal
  Object.assign(STEP_WAIT, { first: 0, every: 5, until: 20 })
  const since = Date.now() - 30_000
  const conv = "synthetic-account-flights"
  const keyA = usageKey("synthetic-flights-a", conv)
  const keyB = usageKey("synthetic-flights-b", conv)
  const usageA = { input: 11, output: 3, cacheRead: 100, cacheWrite: 7, reasoning: 0 }
  const usageB = { input: 22, output: 5, cacheRead: 200, cacheWrite: 9, reasoning: 0 }
  const response = (u) => Response.json({ usageEventsDisplay: [{ timestamp: String(since + 2000), conversationId: conv,
    tokenUsage: { inputTokens: u.input, outputTokens: u.output, cacheReadTokens: u.cacheRead, cacheWriteTokens: u.cacheWrite } }] })
  let startedA, startedB, releaseA, releaseB
  const askedA = new Promise((resolve) => { startedA = resolve })
  const askedB = new Promise((resolve) => { startedB = resolve })
  globalThis.fetch = async (_url, init) => new Promise((resolve) => {
    if (init.headers.Authorization === "Bearer synthetic-flights-a") { releaseA = resolve; startedA() }
    else { releaseB = resolve; startedB() }
  })
  const a = ledger("synthetic-flights-a", conv, since, undefined, true)
  const b = ledger("synthetic-flights-b", conv, since, undefined, true)
  const ownA = a.own(), ownB = b.own()
  let nextA, timeout
  try {
    await Promise.all([askedA, askedB])
    const inFlightA = flights.get(keyA), inFlightB = flights.get(keyB)
    expect(inFlightA?.size).toBe(1)
    expect(inFlightB?.size).toBe(1)
    expect(inFlightA).not.toBe(inFlightB)
    expect(owed.has(keyA)).toBe(false)
    expect(owed.has(keyB)).toBe(false)
    // A finishing collector must retain a replacement set under the same key.
    const replacement = new Set()
    flights.set(keyA, replacement)
    a.done()
    releaseA(response(usageA))
    expect(await ownA).toBe(false)
    expect(flights.get(keyA)).toBe(replacement)
    expect(flights.get(keyB)).toBe(inFlightB)
    expect(owed.get(keyA).carry).toEqual(usageA)
    flights.delete(keyA)
    nextA = ledger("synthetic-flights-a", conv, Date.now(), undefined, true)
    expect(await Promise.race([
      nextA.owed(true),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("waited for another account's collection")), 1000) }),
    ])).toEqual(usageA)
    clearTimeout(timeout)
    expect(owed.has(keyA)).toBe(false)
    expect(flights.has(keyA)).toBe(false)
    expect(flights.get(keyB)).toBe(inFlightB)
    releaseB(response(usageB))
    expect(await ownB).toEqual(usageB)
    expect(owed.has(keyB)).toBe(false)
    expect(flights.has(keyB)).toBe(false)
  } finally {
    clearTimeout(timeout)
    for (const book of [a, b, nextA]) book?.done()
    globalThis.fetch = async () => Response.json({ usageEventsDisplay: [] })
    releaseA?.(response(usageA))
    releaseB?.(response(usageB))
    await Promise.all([ownA, ownB])
  }
})
