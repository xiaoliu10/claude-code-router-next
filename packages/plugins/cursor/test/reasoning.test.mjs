// Tool continuations replay the assistant's reasoning as AI SDK reasoning
// parts, rather than discarding it when a new Run is built. No request leaves
// this machine; fixtures contain no real conversation or account data.
import "./nonet.mjs"
import { expect, test } from "vitest"
import { _internal } from "../src/vendor/engine.mjs"

const call = (id) => ({ id, type: "function", function: { name: "read", arguments: '{"path":"a"}' } })
const messages = (assistant) => [
  { role: "user", content: "fix the bug" },
  { role: "assistant", content: null, tool_calls: [call("toolu_a")], ...assistant },
  { role: "tool", tool_call_id: "toolu_a", content: "the source" },
]
const convert = (msgs) => _internal.conversation({ messages: msgs }, [])
const parts = (conv) => conv.msgs.map((b) => JSON.parse(b.toString())).filter((m) => m.role === "assistant")

test("reasoning_content survives a tool continuation and the Run's transcript blobs", () => {
  const conv = convert(messages({ reasoning_content: "The branch needs a null check.", content: "Reading the source." }))
  expect(parts(conv)[0].content).toEqual([
    { type: "reasoning", text: "The branch needs a null check." },
    { type: "text", text: "Reading the source." },
    { type: "tool-call", toolCallId: "toolu_a", toolName: "CallDynamicTool", args: { namespace: "tools", toolName: "read", arguments: { path: "a" } } },
  ])
  const run = _internal.buildRun(conv.msgs, conv.last, [], "grok-4.7-fast")
  const transcript = [...run.blobs.values()].map((b) => b.toString())
  expect(transcript).toContain(JSON.stringify(parts(conv)[0]))
  expect(JSON.stringify(conv.msgs.map((b) => JSON.parse(b.toString())))).toContain("the source")
})

test("reasoning is accepted as the alternate Chat field, without duplicating both fields", () => {
  expect(parts(convert(messages({ reasoning: "Keep the existing interface." })))[0].content[0]).toEqual({ type: "reasoning", text: "Keep the existing interface." })
  expect(parts(convert(messages({ reasoning_content: "Canonical", reasoning: "Alias" })))[0].content.filter((p) => p.type === "reasoning")).toEqual([{ type: "reasoning", text: "Canonical" }])
})

test("split tool calls retain reasoning from both assistant messages in order", () => {
  const msgs = [
    { role: "user", content: "read a and b" },
    { role: "assistant", content: null, reasoning_content: "Check a first.", tool_calls: [call("toolu_a")] },
    { role: "assistant", content: "Reading both.", reasoning: "Then check b.", tool_calls: [call("toolu_b")] },
    { role: "tool", tool_call_id: "toolu_a", content: "A" },
    { role: "tool", tool_call_id: "toolu_b", content: "B" },
  ]
  const before = JSON.stringify(msgs)
  const conv = convert(msgs)
  expect(parts(conv)[0].content.filter((p) => p.type === "reasoning")).toEqual([{ type: "reasoning", text: "Check a first.\n\nThen check b." }])
  expect(parts(conv)[0].content.filter((p) => p.type === "tool-call")).toHaveLength(2)
  const results = conv.msgs.map((b) => JSON.parse(b.toString())).find((m) => m.role === "tool").content
  expect(results.map((p) => p.experimental_content[0].text)).toEqual(["A", "B"])
  expect(JSON.stringify(msgs)).toBe(before)
})

test("reasoning-only history is preserved as reasoning, not ordinary assistant text", () => {
  expect(parts(convert([{ role: "user", content: "continue" }, { role: "assistant", content: null, reasoning_content: "An unfinished plan." }]))).toEqual([
    { role: "assistant", content: [{ type: "reasoning", text: "An unfinished plan." }] },
  ])
})

test("blank or non-string reasoning fields do not create empty or invalid parts", () => {
  for (const value of [undefined, null, "", "   ", {}, [], 42]) {
    const got = parts(convert(messages({ reasoning_content: value })))[0].content
    expect(got.filter((p) => p.type === "reasoning")).toEqual([])
    expect(got.filter((p) => p.type === "tool-call")).toHaveLength(1)
  }
  expect(parts(convert(messages({ reasoning_content: "", reasoning: "Fallback" })))[0].content[0]).toEqual({ type: "reasoning", text: "Fallback" })
})

test("the input estimate includes replayed reasoning exactly once", () => {
  const baseline = convert(messages({}))
  const reasoning = "x".repeat(400)
  const conv = convert(messages({ reasoning_content: reasoning, reasoning }))
  expect(conv.estimate - baseline.estimate).toBe(100)
})
