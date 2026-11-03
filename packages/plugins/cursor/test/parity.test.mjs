// What magpie's built-in Cursor did that the plugin does too, ahead of the
// built-in's retirement: a failed tool result tells Cursor isError
// (internal/gateway/cursor.go, cursorResult), and the Keychain is read as
// cursorKeychainToken reads it (internal/provider/cursor.go; magpie #746,
// #2408).
import "./nonet.mjs" // first: no request leaves this machine
import { afterEach, expect, test } from "vitest"
import { _internal } from "../src/vendor/engine.mjs"

const { conversation, keychain, keychainToken } = _internal

const call = (id) => ({ role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name: "bash", arguments: "{}" } }] })
const results = (chat) =>
  conversation(chat, []).msgs.map((b) => JSON.parse(b.toString())).filter((m) => m.role === "tool").flatMap((m) => m.content)

test("a tool result marked is_error tells Cursor isError on the stateless path; a good one doesn't", () => {
  const got = results({
    messages: [
      { role: "user", content: "go" },
      call("call_a"),
      { role: "tool", tool_call_id: "call_a", content: "exit status 1", is_error: true },
      call("call_b"),
      { role: "tool", tool_call_id: "call_b", content: "ok" },
      { role: "user", content: "and?" },
    ],
  })
  expect(got.map((r) => [r.toolCallId, r.isError === true])).toEqual([["call_a", true], ["call_b", false]])
})

// a fake clock and `security`: each read counted, its answer set per test
let clock = 0
let reads = 0
let answer = { ok: true, out: "tok\n", code: 0 }
const real = { now: keychain.now, read: keychain.read }
const fake = () => {
  clock = 1_000_000
  reads = 0
  Object.assign(keychain, { tok: "", at: 0, ask: 0, busy: null, now: () => clock, read: async () => (reads++, answer) })
}
afterEach(() => Object.assign(keychain, { tok: "", at: 0, ask: 0, busy: null }, real))

test("a token read from the Keychain is taken as it for ten seconds, then read again", async () => {
  fake()
  answer = { ok: true, out: "tok\n", code: 0 }
  expect(await keychainToken()).toBe("tok")
  clock += 9_999
  expect(await keychainToken()).toBe("tok")
  expect(reads).toBe(1)
  clock += 2
  expect(await keychainToken()).toBe("tok")
  expect(reads).toBe(2)
})

test("callers at once share one `security` run", async () => {
  fake()
  answer = { ok: true, out: "tok", code: 0 }
  const got = await Promise.all([keychainToken(), keychainToken(), keychainToken()])
  expect(got).toEqual(["tok", "tok", "tok"])
  expect(reads).toBe(1)
})

test("a refused read is not asked again for ten minutes; a fresh read asks", async () => {
  fake()
  answer = { ok: false, out: "", code: 128 } // the user said no to the dialog
  expect(await keychainToken()).toBe("")
  clock += 9 * 60_000
  expect(await keychainToken()).toBe("")
  expect(reads).toBe(1)
  clock += 60_001
  answer = { ok: true, out: "tok", code: 0 }
  expect(await keychainToken()).toBe("tok")
  expect(reads).toBe(2)
  // after a refusal, a sign-in (fresh) still reads at once
  answer = { ok: false, out: "", code: 51 }
  expect(await keychainToken(true)).toBe("")
  answer = { ok: true, out: "tok2", code: 0 }
  expect(await keychainToken(true)).toBe("tok2")
  expect(reads).toBe(4)
})

test("no item (exit 44) is no refusal: asked again after ten seconds", async () => {
  fake()
  answer = { ok: false, out: "", code: 44 }
  expect(await keychainToken()).toBe("")
  clock += 10_001
  answer = { ok: true, out: "tok", code: 0 }
  expect(await keychainToken()).toBe("tok")
  expect(reads).toBe(2)
})
