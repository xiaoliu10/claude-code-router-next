// One turn's parallel tool calls split over two consecutive assistant
// messages, answered together after (yetone/magpie#1275): both calls keep
// their real results, as magpie's built-in does since 7067fce5
// (internal/gateway/split_calls_test.go). This is the request magpie
// relays from a Chat client, and what OpenCode's AI SDK sends.
import "./nonet.mjs"
import { expect, test } from "vitest"
import { _internal } from "../src/vendor/engine.mjs"

const NO_RESULT = "Tool use was interrupted and did not produce a result."
const call = (id, path) => ({ id, type: "function", function: { name: "read", arguments: JSON.stringify({ path }) } })
const split = () => ({
  messages: [
    { role: "user", content: "read a and b" },
    { role: "assistant", content: null, tool_calls: [call("toolu_a", "a")] },
    { role: "assistant", content: null, tool_calls: [call("toolu_b", "b")] },
    { role: "tool", tool_call_id: "toolu_a", content: "A!" },
    { role: "tool", tool_call_id: "toolu_b", content: "B!" },
  ],
})

// trace is each message sent: its role, and the calls it makes or the
// results it carries.
const trace = (chat) =>
  _internal
    .conversation(chat, [])
    .msgs.map((b) => JSON.parse(b.toString()))
    .filter((m) => m.role !== "system")
    .map((m) => {
      if (typeof m.content === "string") return m.role
      const bits = m.content.map((p) =>
        p.type === "tool-call" ? "call:" + p.toolCallId : p.type === "tool-result" ? `result:${p.toolCallId}=${p.experimental_content[0].text}` : p.type + ":" + (p.text ?? ""),
      )
      return `${m.role}(${bits.join(",")})`
    })
    .join(" ")

test("a split turn's calls are answered by their real results", () => {
  const got = trace(split())
  expect(got).not.toContain(NO_RESULT)
  expect(got).toBe("user(text:read a and b) assistant(call:toolu_a,call:toolu_b) tool(result:toolu_a=A!,result:toolu_b=B!)")
})

test("a call of a split turn that went unanswered is still answered for", () => {
  const chat = split()
  chat.messages.splice(3, 1)
  expect(trace(chat)).toBe(`user(text:read a and b) assistant(call:toolu_a,call:toolu_b) tool(result:toolu_b=B!,result:toolu_a=${NO_RESULT})`)
})

test("text the turn said after its call, in a message of its own, joins it", () => {
  const chat = {
    messages: [
      { role: "user", content: "read a" },
      { role: "assistant", content: null, tool_calls: [call("toolu_a", "a")] },
      { role: "assistant", content: "reading" },
      { role: "tool", tool_call_id: "toolu_a", content: "1" },
    ],
  }
  expect(trace(chat)).toBe("user(text:read a) assistant(text:reading,call:toolu_a) tool(result:toolu_a=1)")
})

test("two assistant messages with no calls stay two", () => {
  const chat = {
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "one" },
      { role: "assistant", content: "two" },
    ],
  }
  expect(trace(chat)).toBe("user(text:hi) assistant(text:one) assistant(text:two)")
})

test("the caller's messages are left as they were", () => {
  const chat = split()
  _internal.conversation(chat, [])
  expect(chat.messages.length).toBe(5)
  expect(chat.messages[1].tool_calls.length).toBe(1)
})
