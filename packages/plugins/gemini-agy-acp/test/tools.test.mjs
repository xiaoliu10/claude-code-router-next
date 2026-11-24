import test from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activateWithTransport } from '../src/plugin.mjs';

/**
 * Tool round trip through the plugin.
 *
 * The transport owns the MCP bridge and the parked-call bookkeeping. The fake
 * transport stands in for the ACP agent and performs the same three steps a
 * real agent does: discover the bridged tools over HTTP, call one, then
 * continue once the caller answers. The caller executes every tool — the fake
 * only records what was asked.
 */
const name = 'gemini-agy-acp';
const provider = { name, apiKey: `ccr-managed-${name}`, models: ['model-1', 'Gemini Model'] };
const settings = { enabled: true, binary: '/path/to/local/fixture', authMethod: 'gemini-api-key' };
const tool = { type: 'function', function: {
  name: 'lookup', description: 'Look up a value.',
  parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
} };
const messages = [{ role: 'user', content: 'find the answer' }];
// The ACP fixture advertises 'Gemini Model' as its model name, so a request
// against the real transport must ask for that name.
const toolBody = { model: 'model-1', messages, tools: [tool] };
const fixtureBody = { model: 'Gemini Model', messages, tools: [tool] };

/** One MCP request against the bridge the transport started. */
async function speakMcp(url, token, method, params) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await response.json();
  assert.equal(body.error, undefined, body.error?.message);
  return body.result;
}

/**
 * A fake ACP agent. It reaches the live bridge the transport created through
 * the `bridge` handle the transport hands to the run request — exactly the URL
 * and token a real agent receives in `session/new`.
 */
function makeAgent(observed) {
  // A real transport keeps the bridge on the worker for the warm session.
  const state = { bridge: null };
  return {
    toolBridge: () => state.bridge,
    async run(request) {
      const { onText, onToolCall, bridge, resume } = request;
      if (!bridge) { onText('no tools'); return { stopReason: 'end_turn' }; }
      if (resume) {
        // A resume turn runs after the caller's results already settled the
        // parked MCP request, so the agent relays what the call resolved to.
        for (const pending of observed.parked.values()) {
          const settled = await pending;
          const text = settled.content?.[0]?.text ?? '';
          onText(`result:${text}`);
          observed.texts.push(`result:${text}`);
        }
        return { stopReason: 'end_turn' };
      }
      const listed = await speakMcp(bridge.url, bridge.token, 'tools/list', {});
      observed.listed = listed.tools.map(entry => entry.name);
      // The call only resolves once the caller answers, so it is awaited after
      // the caller's second request — exactly as a real agent would block.
      const pending = speakMcp(bridge.url, bridge.token, 'tools/call', { name: observed.listed[0], arguments: { key: 'answer' } });
      // Keep the bridge on the worker, exactly as the real transport does.
      state.bridge = bridge;
      // A real agent reports the call only after the bridge has parked it, so
      // the turn cannot finish before the parked entry exists.
      for (let i = 0; i < 50 && bridge.pending.size === 0; i++) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      // A real transport rewrites the agent's ACP id onto the bridge's parked
      // id, so the caller quotes back an id that can actually be matched.
      const bridgeId = bridge.pending.keys().next().value;
      observed.parked.set(bridgeId, pending);
      onToolCall({ id: bridgeId, name: 'lookup', arguments: { key: 'answer' } });
      return { stopReason: 'end_turn', parked: [bridgeId] };
    },
  };
}

/** Open the real transport against the ACP fixture subprocess in `mode`. */
async function openTransport(t, mode, config = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'agy-fixture-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binary = join(dir, 'fixture.mjs');
  const source = await readFile(new URL('./fixtures/agy-acp.mjs', import.meta.url), 'utf8');
  await writeFile(binary, `#!${process.execPath}\n${source}`, { mode: 0o700 });
  await writeFile(join(dir, 'mode'), mode);
  await writeFile(join(dir, 'events'), '');
  process.env.GEMINI_API_KEY = 'fixture-value';
  t.after(() => { delete process.env.GEMINI_API_KEY; });
  const { createTransport } = await import('../src/transport.mjs');
  return { transport: createTransport({ binary, authMethod: 'gemini-api-key', ...config }), dir };
}

/**
 * Activate the plugin against the real ACP fixture subprocess in `mode`. This
 * exercises the production transport (worker pool, stdio protocol, isolated
 * environment) rather than a fake.
 */
async function activateFixture(t, mode) {
  const dir = await mkdtemp(join(tmpdir(), 'agy-fixture-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binary = join(dir, 'fixture.mjs');
  // The plugin reads its own settings from the config dir, and the fixture
  // reads its mode and event log from the directory it is spawned in.
  await writeFile(join(dir, `${name}.json`), JSON.stringify({ ...settings, binary }));
  const source = await readFile(new URL('./fixtures/agy-acp.mjs', import.meta.url), 'utf8');
  await writeFile(binary, `#!${process.execPath}\n${source}`, { mode: 0o700 });
  await writeFile(join(dir, 'mode'), mode);
  await writeFile(join(dir, 'events'), '');
  process.env.GEMINI_API_KEY = 'fixture-value';
  t.after(() => { delete process.env.GEMINI_API_KEY; });
  const { activateWithTransport } = await import('../src/plugin.mjs');
  let runtime;
  await activateWithTransport({ host: { configDir: dir }, registerTransformer() {}, registerManagedRuntime(value) { runtime = value; } },
    async options => (await import('../src/transport.mjs')).createTransport({ ...options, binary }));
  const dispatch = (requestBody = toolBody, req = { body: requestBody }) =>
    runtime.dispatchRequest({ requestBody, req, config: {}, provider, attempt: () => { throw Error('unexpected HTTP'); } });
  return { dispatch, runtime, dir };
}

async function activateTool(t, agent) {
  const configDir = await mkdtemp(join(tmpdir(), 'agy-tool-'));
  t.after(() => rm(configDir, { recursive: true, force: true }));
  await writeFile(join(configDir, `${name}.json`), JSON.stringify(settings));
  let runtime;
  await activateWithTransport({ host: { configDir }, registerTransformer() {}, registerManagedRuntime(value) { runtime = value; } },
    () => ({ run: agent.run.bind(agent), toolBridge: agent.toolBridge?.bind(agent), async close() {} }));
  const dispatch = (requestBody = toolBody, req = { body: requestBody }) =>
    runtime.dispatchRequest({ requestBody, req, config: {}, provider, attempt: () => { throw Error('unexpected HTTP'); } });
  return { dispatch, runtime };
}

test('bridges the caller tools, parks the agent call and resumes with the result', async t => {
  const observed = { listed: [], texts: [], parked: new Map() };
  const agent = makeAgent(observed);
  const { dispatch } = await activateTool(t, agent);

  const first = await dispatch();
  assert.equal(first.status, 200);
  const body = await first.json();
  assert.equal(body.choices[0].finish_reason, 'tool_calls');
  const call = body.choices[0].message.tool_calls[0];
  assert.equal(call.type, 'function');
  assert.equal(call.function.name, 'lookup');
  assert.ok(call.id);
  assert.deepEqual(JSON.parse(call.function.arguments), { key: 'answer' });
  // The bridge advertised the projected MCP name, not the caller's raw name.
  assert.deepEqual(observed.listed, ['ccr_lookup']);

  const second = await dispatch({ model: 'Gemini Model', tools: [tool], messages: [
    ...messages,
    { role: 'assistant', content: null, tool_calls: [{ id: call.id, type: 'function', function: { name: 'lookup', arguments: call.function.arguments } }] },
    { role: 'tool', tool_call_id: call.id, content: '42' },
  ] });
  assert.equal(second.status, 200);
  const answered = await second.json();
  assert.equal(answered.choices[0].finish_reason, 'stop');
  assert.match(answered.choices[0].message.content, /result:42/);
  // The parked MCP request settled with the caller's own result. `isError` is
  // only present on a failure, matching the MCP result shape.
  const settled = await observed.parked.get(call.id);
  assert.deepEqual(settled, { content: [{ type: 'text', text: '42' }], isError: false });
});

test('a streaming tool request emits tool_calls as deltas and finishes once', async t => {
  const observed = { listed: [], texts: [], parked: new Map() };
  const { dispatch } = await activateTool(t, makeAgent(observed));

  const response = await dispatch({ ...toolBody, stream: true });
  assert.match(response.headers.get('content-type'), /event-stream/);
  const wire = await response.text();
  const frames = wire.split('\n\n').filter(Boolean)
    .filter(line => line.startsWith('data: ') && line.slice(6) !== '[DONE]')
    .map(line => JSON.parse(line.slice(6)));
  const toolFrames = frames.filter(frame => frame.choices[0]?.delta?.tool_calls?.length);
  assert.equal(toolFrames.length, 1);
  assert.equal(toolFrames[0].choices[0].delta.tool_calls[0].function.name, 'lookup');
  const callId = toolFrames[0].choices[0].delta.tool_calls[0].id;
  // The finish frame is the last JSON frame; [DONE] is a sentinel, not a
  // chunk, and is filtered out above.
  assert.equal(frames.at(-1).choices[0].finish_reason, 'tool_calls');
  assert.ok(wire.endsWith('data: [DONE]\n\n'));
  // The parked call is settled by the second request, so it must not leak.
  await dispatch({ model: 'model-1', tools: [tool], messages: [
    ...messages,
    { role: 'assistant', content: null, tool_calls: [{ id: callId, type: 'function', function: { name: 'lookup', arguments: '{"key":"answer"}' } }] },
    { role: 'tool', tool_call_id: callId, content: 'ok' },
  ] });
  assert.deepEqual(await observed.parked.get(callId), { content: [{ type: 'text', text: 'ok' }], isError: false });
});

test('a tool request the agent cannot serve is reported, not silently answered', async t => {
  const configDir = await mkdtemp(join(tmpdir(), 'agy-tool-'));
  t.after(() => rm(configDir, { recursive: true, force: true }));
  await writeFile(join(configDir, `${name}.json`), JSON.stringify(settings));
  let runtime;
  await activateWithTransport({ host: { configDir }, registerTransformer() {}, registerManagedRuntime(value) { runtime = value; } },
    () => ({ run: async () => { throw Object.assign(new Error('none'), { code: 'acp_invalid_request' }); }, async close() {} }));
  const response = await runtime.dispatchRequest({ requestBody: { ...toolBody, tools: [{ type: 'function', function: { name: 'x', parameters: { type: 'object', properties: { a: { type: 'nonsense' } } } } }] }, req: { body: toolBody }, config: {}, provider,
    attempt: () => { throw Error('unexpected HTTP'); } });
  // The caller must learn the tool could not be served rather than receive a
  // plain answer that looks like the agent simply declined to use a tool.
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'agy_tools_unsupported');
});

test('closing the transport releases the warm bridge and its parked call', async t => {
  // A parked call must never outlive the transport: the bridge owns the
  // listening socket, and a caller that never answers must not leak it.
  const { transport } = await openTransport(t, 'mcp-tool');
  const tool = { type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: { key: { type: 'string' } } } } };
  const { AgyToolBridge } = await import('../src/agy-tool-bridge.mjs');
  const bridge = new AgyToolBridge([tool], () => new Promise(() => {}));
  await bridge.start();
  const port = Number(new URL(bridge.url).port);
  const reachable = async () => new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
  });

  const parked = await transport.run({ model: 'Gemini Model', thinking: 'xhigh', prompt: 'go',
    onText() {}, onToolCall() {}, bridge });
  assert.equal(parked.parked.length, 1);
  assert.equal(bridge.pending.size, 1);
  assert.equal(await reachable(), true);

  await transport.close();
  // The parked call is settled as an error and the socket is gone.
  assert.equal(bridge.pending.size, 0);
  assert.equal(await reachable(), false);
});

test('a proxy-only drain never kills a parked tool turn', async t => {
  const { transport } = await openTransport(t, 'mcp-tool');
  const tool = { type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: { key: { type: 'string' } } } } };
  const { AgyToolBridge } = await import('../src/agy-tool-bridge.mjs');
  const bridge = new AgyToolBridge([tool], () => new Promise(() => {}));
  await bridge.start();
  const port = Number(new URL(bridge.url).port);
  const reachable = () => new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
  });
  const parked = await transport.run({ model: 'Gemini Model', thinking: 'xhigh', prompt: 'go',
    onText() {}, onToolCall() {}, bridge });
  assert.equal(parked.parked.length, 1);
  assert.equal(transport.hasParked(), true);
  await transport.retireIdle();
  assert.equal(bridge.pending.size, 1);
  assert.equal(await reachable(), true);
  assert.equal(transport.hasParked(), true);
  await transport.close();
  assert.equal(bridge.pending.size, 0);
});

test('an interleaved conversation does not steal another conversation\'s parked bridge', async t => {
  // The pool must hand back the bridge whose parked calls match the caller's
  // own tool_call ids. Matching on anything else lets a second conversation
  // resume — and corrupt — the first one's ACP session.
  const { transport } = await openTransport(t, 'mcp-tool');
  const { AgyToolBridge } = await import('../src/agy-tool-bridge.mjs');
  const make = () => {
    const bridge = new AgyToolBridge([{ type: 'function', function: { name: 'lookup',
      parameters: { type: 'object', properties: { key: { type: 'string' } } } } }], () => new Promise(() => {}));
    return bridge;
  };
  const run = (prompt, bridge, resume = false) => transport.run({ model: 'Gemini Model', thinking: 'xhigh', prompt,
    onText() {}, onToolCall() {}, bridge, resume });

  const first = make();
  await first.start();
  const a = await run('conversation A', first);
  assert.equal(a.parked.length, 1);

  // A second conversation must get its own bridge, not A's parked one: the
  // pool matches on the caller's own parked ids, so an unrelated request — or
  // an id this pool never issued — resolves to nothing.
  assert.equal(transport.toolBridge([]), undefined);
  assert.equal(transport.toolBridge(a.parked), first);
  assert.equal(transport.toolBridge(['call_never_issued']), undefined);

  // A's parked call is answered against A's own bridge and id, and the same
  // ACP turn resumes.
  const answer = [...first.pending.values()][0];
  answer({ content: [{ type: 'text', text: 'ANSWER-A' }] });
  const resumed = await run('the result is ANSWER-A', first, true);
  assert.equal(resumed.stopReason, 'end_turn');
});

test('a resume prompt carries the caller\'s follow-up instruction, not just the tool results', async t => {
  // Regression: the resume prompt used to contain only the tool results, so a
  // user message sent alongside them was silently dropped.
  const calls = [{ id: 'call_1', name: 'lookup', arguments: { key: 'a' } }];
  const answered = [
    { role: 'user', content: 'find the answer' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"key":"a"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: '42' },
  ];

  const { toolResultPrompt } = await import('../src/agy-tools.mjs');
  // No trailing message: the prompt is just the completed calls.
  assert.equal(toolResultPrompt(calls, answered),
    'The following tool calls have completed. Use their results to continue; do not repeat completed actions.\n'
    + 'Tool: lookup\nArguments: {"key":"a"}\nResult: 42\n');

  // A follow-up user message must reach the agent.
  const withFollowUp = [...answered, { role: 'user', content: 'now summarize it' }];
  assert.match(toolResultPrompt(calls, withFollowUp), /now summarize it/);
  // The agent's own pre-parking assistant text is not replayed as an instruction.
  const withAssistant = [...answered, { role: 'assistant', content: 'let me look that up' }, { role: 'user', content: 'thanks' }];
  const prompt = toolResultPrompt(calls, withAssistant);
  assert.match(prompt, /thanks/);
  assert.doesNotMatch(prompt, /let me look that up/);
});

test('a text-only request still succeeds while another conversation has a parked call', async t => {
  // A parked call reserves its worker, so an unrelated text-only request must be
  // served by another worker rather than tearing the parked call down.
  const { dispatch } = await activateFixture(t, 'mcp-tool');

  const first = await dispatch(fixtureBody);
  assert.equal(first.status, 200);
  const call = (await first.json()).choices[0].message.tool_calls[0];
  assert.ok(call.id);

  const plain = await dispatch({ model: 'Gemini Model', messages });
  assert.equal(plain.status, 200);
  assert.equal(typeof (await plain.json()).choices[0].message.content, 'string');

  // The parked call survives the interleaved text-only turn and still resumes.
  const second = await dispatch({ model: 'Gemini Model', tools: [tool], messages: [
    ...messages,
    { role: 'assistant', content: null, tool_calls: [{ id: call.id, type: 'function', function: { name: 'lookup', arguments: call.function.arguments } }] },
    { role: 'tool', tool_call_id: call.id, content: 'ANSWER-A' },
  ] });
  assert.equal(second.status, 200);
  assert.match((await second.json()).choices[0].message.content, /ANSWER-A/);
});

test('a third turn of a tool conversation is a fresh turn, not a stale resume', async t => {
  // Regression: "history contains complete tool results" also matches every
  // later turn of the conversation, which used to start a fresh ACP session
  // whose only context was a growing recap of already-completed calls.
  const { dispatch } = await activateFixture(t, 'mcp-tool');
  const first = await dispatch(fixtureBody);
  const call = (await first.json()).choices[0].message.tool_calls[0];
  const history = [
    ...messages,
    { role: 'assistant', content: null, tool_calls: [{ id: call.id, type: 'function', function: { name: 'lookup', arguments: call.function.arguments } }] },
    { role: 'tool', tool_call_id: call.id, content: '42' },
  ];

  // Round 2 answers the parked call: a real resume.
  const second = await dispatch({ model: 'Gemini Model', tools: [tool], messages: history });
  assert.equal(second.status, 200);
  assert.match((await second.json()).choices[0].message.content, /42/);

  // Round 3 carries the same completed history plus a new instruction. Nothing
  // is parked any more, so it must be a fresh turn rather than a resume.
  const third = await dispatch({ model: 'Gemini Model', tools: [tool], messages: [...history, { role: 'user', content: 'and now?' }] });
  assert.equal(third.status, 200);
  const answered = await third.json();
  // A fresh turn, not a resume: the fixture parks again, and the important part
  // is that it is a NEW parked call rather than a reply to the already-answered
  // one — i.e. the conversation carried on instead of replaying a stale recap.
  const parked = answered.choices[0].message.tool_calls?.[0]?.id;
  assert.ok(parked);
  assert.notEqual(parked, call.id);
});

test('a caller cannot resume a bridge with ids borrowed from another conversation', async t => {
  // Regression: a subset match let a caller that quoted a foreign parked id
  // resume — and prompt on — another conversation's ACP session.
  const { transport } = await openTransport(t, 'mcp-tool');
  const { AgyToolBridge } = await import('../src/agy-tool-bridge.mjs');
  const make = () => new AgyToolBridge([{ type: 'function', function: { name: 'lookup',
    parameters: { type: 'object', properties: { key: { type: 'string' } } } } }], () => new Promise(() => {}));
  const bridge = make();
  await bridge.start();
  const parked = await transport.run({ model: 'Gemini Model', thinking: 'xhigh', prompt: 'A',
    onText() {}, onToolCall() {}, bridge });
  assert.equal(parked.parked.length, 1);

  // Exactly the parked id matches.
  assert.equal(transport.toolBridge(parked.parked), bridge);
  // A superset — the real id plus a borrowed one — does not.
  assert.equal(transport.toolBridge([...parked.parked, 'call_borrowed']), undefined);
  // A subset of a longer parked set does not either.
  assert.equal(transport.toolBridge([]), undefined);
});

test('a worker holding a parked call is not reaped for session-count exhaustion', async t => {
  // Regression: retiring on MAX_SESSIONS closed the bridge of a call the caller
  // was still waiting to answer.
  const { transport } = await openTransport(t, 'mcp-tool', { maxWorkers: 8 });
  const { AgyToolBridge } = await import('../src/agy-tool-bridge.mjs');
  const bridge = new AgyToolBridge([{ type: 'function', function: { name: 'lookup',
    parameters: { type: 'object', properties: { key: { type: 'string' } } } } }], () => new Promise(() => {}));
  await bridge.start();
  const parked = await transport.run({ model: 'Gemini Model', thinking: 'xhigh', prompt: 'A',
    onText() {}, onToolCall() {}, bridge });
  assert.equal(parked.parked.length, 1);

  // Exceed MAX_SESSIONS with text-only turns on the other worker. The parked
  // worker is skipped for these, so the pool serves them from the free worker.
  for (let i = 0; i < 70; i++) {
    const result = await transport.run({ model: 'Gemini Model', thinking: 'xhigh', prompt: `text ${i}`, onText() {} });
    assert.equal(result.stopReason, 'max_tokens');
  }
  // The parked call is untouched and still answerable.
  assert.equal(bridge.pending.size, 1);
  const answer = [...bridge.pending.values()][0];
  answer({ content: [{ type: 'text', text: 'ANSWER-A' }] });
  const resumed = await transport.run({ model: 'Gemini Model', thinking: 'xhigh', prompt: 'done',
    onText() {}, onToolCall() {}, bridge, resume: true });
  assert.equal(resumed.stopReason, 'end_turn');
});

test('the transformer admits tool requests so the runtime tool path is reached', async t => {
  // Regression: the transformer used to reject every tool-bearing request, so
  // the runtime's tool path was unreachable in production. A tool whose schema
  // cannot be represented is still refused, but by the runtime, which tells the
  // caller why (see the agy_tools_unsupported test above).
  const configDir = await mkdtemp(join(tmpdir(), 'agy-tool-'));
  t.after(() => rm(configDir, { recursive: true, force: true }));
  await writeFile(join(configDir, `${name}.json`), JSON.stringify(settings));
  let transformer;
  let runtime;
  await activateWithTransport({ host: { configDir }, registerTransformer(cls) { transformer = new cls(); }, registerManagedRuntime(value) { runtime = value; } },
    () => ({ run: async request => { request.onText('a'); return { stopReason: 'end_turn' }; }, async close() {} }));

  const req = { body: toolBody };
  // The chain's transformer awaits its connection check, so this is async.
  assert.deepEqual(await transformer.transformRequestIn(toolBody, provider, { req }), { body: toolBody });
  assert.equal(req.enableFallback, false);
  // The runtime then serves the tools rather than the transformer refusing them.
  const response = await runtime.dispatchRequest({ requestBody: toolBody, req, config: {}, provider, attempt: () => { throw Error('unexpected HTTP'); } });
  assert.equal(response.status, 200);
});

test('a text-only request keeps its exact original transport shape', async t => {
  const seen = [];
  const { dispatch } = await activateTool(t, { async run(request) {
    seen.push(Object.keys(request).sort());
    request.onText('plain');
    return { stopReason: 'end_turn' };
  } });
  const response = await dispatch({ model: 'model-1', messages });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, 'plain');
  assert.deepEqual(seen, [['model', 'onText', 'prompt', 'signal', 'thinking']]);
});

test('a real ACP agent discovers the tool over MCP and the same turn resumes', async t => {
  // The fixture is a real subprocess speaking the ACP protocol over stdio, and
  // it reaches the bridge over HTTP exactly as the production agent would.
  const { dispatch } = await activateFixture(t, 'mcp-tool');

  const first = await dispatch(fixtureBody);
  assert.equal(first.status, 200);
  const body = await first.json();
  assert.equal(body.choices[0].finish_reason, 'tool_calls');
  const call = body.choices[0].message.tool_calls[0];
  assert.equal(call.function.name, 'lookup');
  assert.ok(call.id);

  const second = await dispatch({ model: 'Gemini Model', tools: [tool], messages: [
    ...messages,
    { role: 'assistant', content: null, tool_calls: [{ id: call.id, type: 'function', function: { name: 'lookup', arguments: call.function.arguments } }] },
    { role: 'tool', tool_call_id: call.id, content: '42' },
  ] });
  assert.equal(second.status, 200);
  const answered = await second.json();
  assert.equal(answered.choices[0].finish_reason, 'stop');
  // The agent relayed the caller's own result back as its answer text.
  assert.match(answered.choices[0].message.content, /^42resumed with 42$/);
});
