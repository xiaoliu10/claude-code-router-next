// A tool step whose usage event shows only after its wait says 0 used,
// and the conversation's next step collects it. That step's own count is
// its usage; what it collected of the earlier step goes apart, as
// magpie_deferred: a client that reads prompt_tokens as how full the
// context is (pi, OpenCode) once saw an earlier step's prompt added to
// its own, the context twice its size (366940 = 181270 + 185670 on a
// 300k window, where 185670 was used).
import "./nonet.mjs"
import { afterEach, expect, test } from "vitest"
import { _internal } from "../src/vendor/engine.mjs"

const { pb, decode, ledger, owed, misses, STEP_WAIT } = _internal
const real = globalThis.fetch
const wait = { ...STEP_WAIT }
afterEach(() => {
  globalThis.fetch = real
  Object.assign(STEP_WAIT, wait)
  owed.clear()
  misses.clear()
})

const update = (num, body) => ({ data: pb().bytes(1, pb().bytes(num, body)).done() })
const listed = update(27, pb().varint(1, 1).done())
const call = {
  data: pb()
    .bytes(2, pb().varint(1, 7).str(15, "x1").bytes(11, pb().str(1, "magpie-bash").str(3, "call_1").str(5, "bash").done()).done())
    .done(),
}
async function step(book) {
  const out = []
  for await (const p of decode([listed, call], { send() {}, blobs: new Map(), tools: [], estimate: 1, stepUsage: book.own, owedUsage: book.owed })) out.push(p)
  book.done()
  return out.at(-1).usage
}

// the report's two tool steps of one pi session
const E1 = { inputTokens: 2, outputTokens: 1913, cacheReadTokens: 177533, cacheWriteTokens: 3735 } // 181270
const E2 = { inputTokens: 4, outputTokens: 2240, cacheReadTokens: 181266, cacheWriteTokens: 4400 } // 185670
const prompt = (e) => e.inputTokens + e.cacheReadTokens + e.cacheWriteTokens

test("a step's prompt_tokens is its own Run's; what it collected of an earlier step is magpie_deferred", async () => {
  Object.assign(STEP_WAIT, { first: 0, every: 10, until: 40, owedAt: 0 })
  const conv = "8a462df8-0000-4000-8000-000000000001"
  // step 1's Run began a while ago, as a tool step's did before its tool ran
  const since = Date.now() - 30_000
  const shown = []
  globalThis.fetch = async () => Response.json({ usageEventsDisplay: shown.map((e) => ({ ...e })) })

  // step 1: its event shows only after its wait, so it is owed and says 0
  const u1 = await step(ledger("tok", conv, since, undefined, true))
  expect(u1.prompt_tokens).toBe(0)
  expect(u1.magpie_deferred).toBeUndefined()

  // step 1's late event, then step 2's own
  // Cursor stamps a Run's event as the Run begins, a second or two in
  shown.push({ timestamp: String(since + 2000), conversationId: conv, tokenUsage: E1 })
  const since2 = Date.now()
  shown.push({ timestamp: String(since2 + 2000), conversationId: conv, tokenUsage: E2 })
  const u2 = await step(ledger("tok", conv, since2, undefined, true))

  // the context as it is: step 2's prompt alone (was 366940)
  expect(u2.prompt_tokens).toBe(prompt(E2))
  expect(u2.total_tokens).toBe(prompt(E2) + E2.outputTokens)
  expect(u2.prompt_tokens_details).toEqual({ cached_tokens: E2.cacheReadTokens, cache_write_tokens: E2.cacheWriteTokens })
  // and step 1's, which magpie still bills, apart
  expect(u2.magpie_deferred).toEqual({
    prompt_tokens: prompt(E1),
    completion_tokens: E1.outputTokens,
    cached_tokens: E1.cacheReadTokens,
    cache_write_tokens: E1.cacheWriteTokens,
  })
  // together, what Cursor counted
  expect(u1.prompt_tokens + u2.prompt_tokens + u2.magpie_deferred.prompt_tokens).toBe(prompt(E1) + prompt(E2))
})

test("distinct same-millisecond events in one response are billed together, not again on later fetches", async () => {
  Object.assign(STEP_WAIT, { first: 0, every: 1, until: 5, owedAt: 60_000 })
  const tok = "same-millisecond-account", conv = "same-millisecond-conversation"
  const since = Date.now() - 30_000
  let shown = []
  globalThis.fetch = async () => Response.json({ usageEventsDisplay: shown })
  const first = await step(ledger(tok, conv, since, undefined, true))
  const second = await step(ledger(tok, conv, since + 1, undefined, true))
  expect([first.prompt_tokens, second.prompt_tokens]).toEqual([0, 0])
  const timestamp = String(since + 2000)
  shown = [E1, E2].map((tokenUsage) => ({ timestamp, conversationId: conv, tokenUsage }))
  const final = ledger(tok, conv, Date.now(), undefined, true)
  const billed = await final.owed(true)
  final.done()
  expect(billed).toMatchObject({
    input: E1.inputTokens + E2.inputTokens,
    output: E1.outputTokens + E2.outputTokens,
    cacheRead: E1.cacheReadTokens + E2.cacheReadTokens,
    cacheWrite: E1.cacheWriteTokens + E2.cacheWriteTokens,
  })
  expect(owed.has(_internal.usageKey(tok, conv))).toBe(false)
  // The response was counted once. Another Run seeing that same response
  // must not bill either event again, even though both share a timestamp.
  const next = await step(ledger(tok, conv, since + 2, undefined, true))
  expect(next.prompt_tokens).toBe(0)
  expect(next.magpie_deferred).toBeUndefined()
})

test("a step that owed nothing has no magpie_deferred", async () => {
  Object.assign(STEP_WAIT, { first: 0, every: 10, until: 200, owedAt: 0 })
  const conv = "8a462df8-0000-4000-8000-000000000002"
  const since = Date.now()
  globalThis.fetch = async () => Response.json({ usageEventsDisplay: [{ timestamp: String(since + 2000), conversationId: conv, tokenUsage: E1 }] })
  const u = await step(ledger("tok", conv, since, undefined, true))
  expect(u.prompt_tokens).toBe(prompt(E1))
  expect(u.magpie_deferred).toBeUndefined()
})
