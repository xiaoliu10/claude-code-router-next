// Nothing this plugin writes into what goes to Cursor names magpie: the
// prompt, the dynamic tool catalog in it, the calls in the history, the
// tool definitions and the MCP server it answers Cursor's mcp_state with.
// Text added to a vendor's prompt is a ban risk, as a header is (magpie's
// LESSONS.md, 5d33f060b / 3c4f8f9ae). A session begun before 0.2.20, when
// the server was named "magpie", still has its calls read back.
import "./nonet.mjs" // first: no request leaves this machine
import { expect, test } from "vitest"
import { _internal } from "../src/vendor/engine.mjs"

const { conversation, toolsOf, buildRun, catalog, exec, pb } = _internal

const chat = {
  model: "claude-4.6-sonnet",
  messages: [
    { role: "system", content: "You are a coding agent." },
    { role: "user", content: "read a" },
    { role: "assistant", content: "Reading.", tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"a"}' } }] },
    { role: "tool", tool_call_id: "call_1", content: "A" },
    { role: "user", content: "and b" },
  ],
  tools: [
    { type: "function", function: { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } } },
    { type: "function", function: { name: "bash", description: "Run a command", parameters: { type: "object", properties: { cmd: { type: "string" } } } } },
  ],
}

const named = (bytes) => /magpie/i.test(Buffer.from(bytes).toString("latin1"))

test("the prompt, the tool catalog, the calls and the tool definitions sent to Cursor never name magpie", () => {
  const tools = toolsOf(chat)
  expect(catalog(tools)).toContain("CallDynamicTool")
  expect(catalog(tools)).not.toMatch(/magpie/i)
  const conv = conversation(chat, tools)
  for (const m of conv.msgs) expect(m.toString()).not.toMatch(/magpie/i)
  const run = buildRun(conv.msgs, conv.last, tools, chat.model, "conv-1")
  expect(named(run.first)).toBe(false)
  for (const b of run.blobs.values()) expect(named(b)).toBe(false)
  // what the catalog promises is what the definitions and calls say
  const sys = JSON.parse(conv.msgs[0].toString()).content
  const ns = /The MCP namespace "([^"]+)"/.exec(sys)[1]
  expect(sys).toContain(`{"namespace":"${ns}","toolName":"read"`)
  const call = conv.msgs.map((b) => JSON.parse(b.toString())).find((m) => m.role === "assistant").content.find((p) => p.type === "tool-call")
  expect(call.args.namespace).toBe(ns)
  expect(Buffer.from(run.first).toString("latin1")).toContain(ns)
})

test("the MCP server Cursor is told of never names magpie", () => {
  const tools = toolsOf(chat)
  const sent = []
  const msg = pb().varint(1, 3).str(15, "x3").bytes(36, pb().done()).done()
  expect(exec(msg, tools, (b) => sent.push(b), () => {})).toBe(null)
  expect(sent.length).toBe(1)
  expect(named(sent[0])).toBe(false)
})

// a call Cursor returns, by the server name now and by the old one
const callOf = (full, bare) => {
  const a = pb().str(1, full).str(3, "call_9")
  if (bare) a.str(5, bare)
  return pb().varint(1, 7).str(15, "x1").bytes(11, a.done()).done()
}

test("a call is read back under the new server name and under magpie, from a session begun before", () => {
  const tools = toolsOf(chat)
  const ns = JSON.parse(conversation(chat, tools).msgs[0].toString()).content.match(/The MCP namespace "([^"]+)"/)[1]
  for (const full of [ns + "-read", "magpie-read"]) {
    expect(exec(callOf(full, "read"), tools, () => {}, () => {}).name).toBe("read")
    expect(exec(callOf(full), tools, () => {}, () => {}).name).toBe("read")
  }
})
