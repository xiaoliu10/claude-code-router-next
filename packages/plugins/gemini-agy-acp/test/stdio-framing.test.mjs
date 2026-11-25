import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const forwarderPath = fileURLToPath(new URL('../src/agy-mcp-stdio-bridge.mjs', import.meta.url));

/**
 * A minimal loopback JSON-RPC backend standing in for the internal HTTP
 * bridge. It records concurrency so tests can prove the forwarder does not
 * serialize, and honors a per-request delay to interleave responses.
 */
async function withBackend(t, { respondDelayMs = 0 } = {}) {
  let inFlight = 0;
  let maxInFlight = 0;
  const seenAuth = [];
  const server = createServer((request, response) => {
    seenAuth.push(request.headers.authorization);
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (respondDelayMs) await delay(respondDelayMs);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id ?? null, result: { echoed: message.method } }));
      } finally {
        inFlight -= 1;
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(() => resolve()); server.closeAllConnections?.(); }));
  const endpoint = `http://127.0.0.1:${server.address().port}/mcp`;
  return { endpoint, maxInFlight: () => maxInFlight, seenAuth: () => seenAuth };
}

/** Spawn the real forwarder and collect whole stdout lines as parsed JSON. */
function startForwarder(t, env) {
  const child = spawn(process.execPath, [forwarderPath], {
    env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { if (!child.killed) child.kill('SIGKILL'); });
  const lines = [];
  const rawChunks = [];
  const pending = new Map();
  child.stdout.on('data', chunk => rawChunks.push(chunk));
  createInterface({ input: child.stdout }).on('line', line => {
    // Framing invariant: every stdout line is a standalone, parseable JSON-RPC
    // message. If two responses ever interleaved inside a line this throws.
    const message = JSON.parse(line);
    lines.push(message);
    const waiter = pending.get(message.id);
    if (waiter) { pending.delete(message.id); waiter(message); }
  });
  let nextId = 0;
  return {
    child,
    lines,
    rawText: () => Buffer.concat(rawChunks).toString('utf8'),
    request(method) {
      return new Promise(resolve => {
        const id = ++nextId;
        pending.set(id, resolve);
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method }) + '\n');
      });
    },
    writeRaw(text) { child.stdin.write(text); },
    nextId: () => ++nextId,
    waitFor(predicate, timeoutMs = 3000) {
      const start = Date.now();
      return new Promise((resolve, reject) => {
        const tick = () => {
          if (predicate(lines)) return resolve();
          if (Date.now() - start > timeoutMs) return reject(new Error('timed out waiting for forwarder output'));
          setTimeout(tick, 10);
        };
        tick();
      });
    },
    exited: new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal }))),
  };
}

test('malformed and non-object lines produce fixed errors with null id and the forwarder recovers', async t => {
  const backend = await withBackend(t);
  const fwd = startForwarder(t, { CCR_MCP_ENDPOINT: backend.endpoint, CCR_MCP_TOKEN: 'fixture-token' });

  // Not JSON at all: -32700 parse error, never forwarded.
  fwd.writeRaw('this is not json\n');
  await fwd.waitFor(l => l.some(m => m.error?.code === -32700));
  const parseError = fwd.lines.find(m => m.error?.code === -32700);
  assert.deepEqual(parseError, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });

  // Valid JSON but the wrong shapes: array and primitives are invalid requests.
  fwd.writeRaw('[1, 2, 3]\n');
  fwd.writeRaw('"a string"\n');
  fwd.writeRaw('42\n');
  await fwd.waitFor(l => l.filter(m => m.error?.code === -32600).length === 3);
  for (const m of fwd.lines.filter(x => x.error?.code === -32600)) {
    assert.equal(m.id, null);
    assert.equal(m.error.message, 'invalid request');
  }

  // Recovery: a well-formed request after the bad lines still gets a normal
  // result, proving one framing error does not kill the process or desync it.
  const ok = await fwd.request('tools/list');
  assert.deepEqual(ok.result, { echoed: 'tools/list' });
  // Every malformed line was answered locally, so none reached the backend
  // (it only saw the single good request).
  assert.equal(backend.seenAuth().length, 1);
  assert.equal(backend.seenAuth()[0], 'Bearer fixture-token');

  fwd.child.stdin.end();
  assert.deepEqual(await fwd.exited, { code: 0, signal: null });
});

test('blank and whitespace-only lines are ignored without any output', async t => {
  const backend = await withBackend(t);
  const fwd = startForwarder(t, { CCR_MCP_ENDPOINT: backend.endpoint, CCR_MCP_TOKEN: 'fixture-token' });
  fwd.writeRaw('\n');
  fwd.writeRaw('   \n');
  fwd.writeRaw('\t\n');
  await delay(50);
  assert.equal(fwd.lines.length, 0);
  assert.equal(fwd.rawText(), '');
  const ok = await fwd.request('initialize');
  assert.ok(ok.result);
  fwd.child.stdin.end();
  assert.deepEqual(await fwd.exited, { code: 0, signal: null });
});

test('a single message split across multiple stdin chunks is reassembled by the newline framing', async t => {
  const backend = await withBackend(t);
  const fwd = startForwarder(t, { CCR_MCP_ENDPOINT: backend.endpoint, CCR_MCP_TOKEN: 'fixture-token' });
  const id = fwd.nextId();
  const full = JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'ccr_lookup' } });
  // Split at arbitrary byte boundaries, with the terminating newline only on
  // the final chunk. readline must buffer the partial line until it arrives.
  fwd.writeRaw(full.slice(0, 7));
  fwd.writeRaw(full.slice(7, 23));
  fwd.writeRaw(full.slice(23, full.length - 5));
  await delay(20);
  assert.equal(fwd.lines.length, 0, 'no newline yet, so nothing should be parsed');
  fwd.writeRaw(full.slice(full.length - 5) + '\n');
  await fwd.waitFor(l => l.some(m => m.id === id));
  const response = fwd.lines.find(m => m.id === id);
  assert.deepEqual(response.result, { echoed: 'tools/call' });
  assert.equal(fwd.lines.length, 1);
  fwd.child.stdin.end();
  assert.deepEqual(await fwd.exited, { code: 0, signal: null });
});

test('a burst of concurrent requests yields one whole JSON line each with no interleaving or serialization', async t => {
  // Variable delays force response order to differ from request order, and the
  // backend records overlap to prove requests were forwarded concurrently.
  const backend = await withBackend(t, { respondDelayMs: 25 });
  const fwd = startForwarder(t, { CCR_MCP_ENDPOINT: backend.endpoint, CCR_MCP_TOKEN: 'fixture-token' });

  const BURST = 12;
  const ids = [];
  let payload = '';
  for (let i = 0; i < BURST; i++) {
    const id = fwd.nextId();
    ids.push(id);
    payload += JSON.stringify({ jsonrpc: '2.0', id, method: `m${id}` }) + '\n';
  }
  fwd.writeRaw(payload); // all requests in a single stdin write

  await fwd.waitFor(l => l.length === BURST, 8000);
  assert.equal(fwd.lines.length, BURST);
  // Every stdout line was independently parseable (the line handler already
  // asserted this) and each id is answered exactly once.
  const answeredIds = fwd.lines.map(m => m.id).sort((a, b) => a - b);
  assert.deepEqual(answeredIds, ids);
  for (const m of fwd.lines) assert.ok(m.result && m.jsonrpc === '2.0');
  // Each line ends exactly at a newline boundary; no line contains two messages.
  for (const line of fwd.rawText().split('\n').filter(Boolean)) {
    const parsed = JSON.parse(line);
    assert.ok(ids.includes(parsed.id));
  }
  // Overlapping backend handling proves there was no per-request serialization.
  assert.ok(backend.maxInFlight() > 1, `expected concurrent backend calls, max was ${backend.maxInFlight()}`);

  fwd.child.stdin.end();
  assert.deepEqual(await fwd.exited, { code: 0, signal: null });
});

test('a notification (no id) gets no stdout line even while parked requests are in flight', async t => {
  const backend = await withBackend(t, { respondDelayMs: 40 });
  const fwd = startForwarder(t, { CCR_MCP_ENDPOINT: backend.endpoint, CCR_MCP_TOKEN: 'fixture-token' });
  const parked = fwd.request('tools/call');
  // A notification interleaved with a slow request must produce nothing.
  fwd.writeRaw(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: {} }) + '\n');
  const result = await parked;
  assert.ok(result.result);
  await delay(30);
  assert.equal(fwd.lines.length, 1, 'notification must not be answered');
  fwd.child.stdin.end();
  assert.deepEqual(await fwd.exited, { code: 0, signal: null });
});
