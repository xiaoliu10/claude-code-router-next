import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { AgyToolBridge } from '../src/agy-tool-bridge.mjs';

const forwarderPath = fileURLToPath(new URL('../src/agy-mcp-stdio-bridge.mjs', import.meta.url));
const tool = { type: 'function', function: { name: 'lookup', description: 'Look up a value.',
  parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } } };

/** Spawn the real forwarder script the way the agent would: node, no shell. */
function startForwarder(t, env) {
  const child = spawn(process.execPath, [forwarderPath], {
    env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));
  const output = [];
  const stderr = [];
  const pending = new Map();
  createInterface({ input: child.stdout }).on('line', line => {
    // stdout must carry only whole JSON-RPC lines, never logs.
    const message = JSON.parse(line);
    output.push(message);
    const resolve = pending.get(message.id);
    if (resolve) { pending.delete(message.id); resolve(message); }
  });
  child.stderr.on('data', chunk => stderr.push(chunk));
  let nextId = 0;
  return {
    child,
    output,
    stderrText: () => Buffer.concat(stderr).toString('utf8'),
    request(method, params) {
      return new Promise(resolve => {
        const id = ++nextId;
        pending.set(id, resolve);
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    },
    notify(method) { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n'); },
    exited: new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal }))),
  };
}

test('stdioDescriptor spawns the current node runtime with the token in env, never argv', async t => {
  const bridge = new AgyToolBridge([tool], () => new Promise(() => {}));
  assert.throws(() => bridge.stdioDescriptor(), /bridge_not_listening/);
  await bridge.start();
  t.after(() => bridge.close());
  const descriptor = bridge.stdioDescriptor();
  assert.equal(descriptor.name, 'ccr-caller-tools');
  assert.equal(descriptor.command, process.execPath);
  assert.deepEqual(descriptor.args, [forwarderPath]);
  assert.ok(existsSync(descriptor.args[0]));
  assert.deepEqual(descriptor.env, [
    { name: 'CCR_MCP_ENDPOINT', value: bridge.url },
    { name: 'CCR_MCP_TOKEN', value: bridge.token },
  ]);
  // The credential never appears on the command line, and the descriptor is
  // the ACP stdio shape — no http type, url or headers.
  assert.ok(!descriptor.args.some(arg => arg.includes(bridge.token)));
  assert.equal(descriptor.type, undefined);
  assert.equal(descriptor.url, undefined);
  assert.equal(descriptor.headers, undefined);
  // The eager-connect name and the internal HTTP name stay one server name.
  assert.equal(descriptor.name, bridge.descriptor().name);
});

test('the spawned forwarder handshakes, lists, parks a call and delivers the answer', async t => {
  const bridge = new AgyToolBridge([tool], () => new Promise(() => {}));
  await bridge.start();
  t.after(() => bridge.close());
  const forwarder = startForwarder(t, { CCR_MCP_ENDPOINT: bridge.url, CCR_MCP_TOKEN: bridge.token });
  const init = await forwarder.request('initialize', { protocolVersion: '2025-11-25', capabilities: {},
    clientInfo: { name: 'stdio-test', version: '1.0.0' } });
  assert.equal(init.result.protocolVersion, '2025-11-25');
  forwarder.notify('notifications/initialized');
  const listed = await forwarder.request('tools/list', {});
  assert.equal(listed.result.tools.length, 1);
  assert.equal(listed.result.tools[0].name, 'ccr_lookup');
  assert.equal(listed.result.tools[0]._meta['antigravity/alwaysLoad'], true);

  // The call parks until the caller answers; other requests must still flow
  // while it waits, so the forwarder must not serialize.
  const call = forwarder.request('tools/call', { name: 'ccr_lookup', arguments: { key: 'answer' } });
  for (let i = 0; i < 200 && bridge.pending.size === 0; i++) await delay(10);
  assert.equal(bridge.pending.size, 1);
  assert.equal(bridge.invocations[0].name, 'lookup');
  const concurrent = await forwarder.request('tools/list', {});
  assert.equal(concurrent.result.tools.length, 1);
  const answer = [...bridge.pending.values()][0];
  answer({ content: [{ type: 'text', text: '42' }], isError: false });
  const settled = await call;
  assert.deepEqual(settled.result, { content: [{ type: 'text', text: '42' }], isError: false });
  // Exactly one stdout line per request; the notification produced none.
  assert.equal(forwarder.output.length, 4);

  // stdin end is the agent's session end: the forwarder exits cleanly.
  forwarder.child.stdin.end();
  assert.deepEqual(await forwarder.exited, { code: 0, signal: null });
});

test('the forwarder exits 0 when stdin ends without any request', async t => {
  const bridge = new AgyToolBridge([tool], () => new Promise(() => {}));
  await bridge.start();
  t.after(() => bridge.close());
  const forwarder = startForwarder(t, { CCR_MCP_ENDPOINT: bridge.url, CCR_MCP_TOKEN: bridge.token });
  forwarder.child.stdin.end();
  assert.deepEqual(await forwarder.exited, { code: 0, signal: null });
  assert.deepEqual(forwarder.output, []);
});

test('an unreachable backend answers -32603 without crashing or leaking the endpoint or token', async t => {
  const bridge = new AgyToolBridge([tool], () => new Promise(() => {}));
  await bridge.start();
  const endpoint = bridge.url;
  const token = bridge.token;
  await bridge.close();
  const forwarder = startForwarder(t, { CCR_MCP_ENDPOINT: endpoint, CCR_MCP_TOKEN: token });
  // A notification with the backend down produces no output and no crash.
  forwarder.notify('notifications/initialized');
  const first = await forwarder.request('initialize', { protocolVersion: '2025-11-25' });
  assert.deepEqual(first.error, { code: -32603, message: 'bridge unavailable' });
  assert.equal(first.id, 1);
  // Still alive: a second request is answered the same way, not a crash loop.
  const second = await forwarder.request('tools/list', {});
  assert.deepEqual(second.error, { code: -32603, message: 'bridge unavailable' });
  assert.equal(forwarder.output.length, 2);
  assert.ok(!forwarder.stderrText().includes(token));
  assert.ok(!forwarder.stderrText().includes(endpoint));
  forwarder.child.stdin.end();
  assert.deepEqual(await forwarder.exited, { code: 0, signal: null });
});

test('a 5xx backend answers -32603 for requests and nothing for notifications', async t => {
  const server = createServer((request, response) => { response.writeHead(500).end('upstream broke'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(() => resolve()); server.closeAllConnections?.(); }));
  const endpoint = `http://127.0.0.1:${server.address().port}/mcp`;
  const forwarder = startForwarder(t, { CCR_MCP_ENDPOINT: endpoint, CCR_MCP_TOKEN: 'fixture-token' });
  forwarder.notify('notifications/initialized');
  const response = await forwarder.request('tools/list', {});
  assert.deepEqual(response.error, { code: -32603, message: 'bridge unavailable' });
  assert.equal(forwarder.output.length, 1);
  forwarder.child.stdin.end();
  assert.deepEqual(await forwarder.exited, { code: 0, signal: null });
});

test('missing endpoint or token exits 1 silently', async () => {
  for (const env of [{}, { CCR_MCP_ENDPOINT: 'http://127.0.0.1:1/mcp' }, { CCR_MCP_TOKEN: 'fixture-token' }]) {
    const child = spawn(process.execPath, [forwarderPath], {
      env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const chunks = [];
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.stderr.on('data', chunk => chunks.push(chunk));
    const code = await new Promise(resolve => child.once('exit', resolve));
    assert.equal(code, 1);
    assert.equal(Buffer.concat(chunks).toString('utf8'), '');
  }
});