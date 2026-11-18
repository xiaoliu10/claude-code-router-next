#!/usr/bin/env node
// Integration fixtures use only temporary HOME/config, bundled Node and loopback.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
const runtime = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../runtime');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-runtime-lifecycle-'));
const children = [];
let blocker;
let socket;
async function port() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  assert.notEqual(value, 3456);
  return value;
}
async function until(check, label) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error(`Timed out: ${label}`);
}
function launch(dir) {
  const child = spawn(path.join(runtime, 'node'), [path.join(runtime, 'service/entry.cjs')], {
    env: { ...process.env, HOME: dir, CCR_CONFIG_DIR: path.join(dir, 'config'), PATH: '/usr/bin:/bin', CCR_DESKTOP_MANAGED: '1', SERVICE_PORT: String(globalThis.fixturePort), CCR_FIXTURE_PORT: String(globalThis.fixturePort), CCR_FIXTURE_KEY: 'test-key' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  return { child, output: () => output };
}
try {
  const listenPort = await port();
  globalThis.fixturePort = listenPort;
  const dir = path.join(root, 'active');
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  const client = path.join(dir, '.claude/settings.json');
  const original = { env: { ORIGINAL_FIXTURE: 'preserved' } };
  fs.writeFileSync(client, JSON.stringify(original));
  const config = { PORT: '$CCR_FIXTURE_PORT', APIKEY: '${CCR_FIXTURE_KEY}', HOST: '127.0.0.1', LOG: false, Providers: [{ name: 'ccr', api_base_url: 'http://example.com', api_key: 'test-key', models: [] }], Clients: { claudeCode: { enabled: true } }, Router: {} };
  const configPath = path.join(dir, 'config/config.json');
  fs.writeFileSync(configPath, JSON.stringify(config));
  const { child, output } = launch(dir);
  await until(() => {
    const value = JSON.parse(fs.readFileSync(client, 'utf8'));
    return value.env?.ANTHROPIC_BASE_URL === `http://127.0.0.1:${listenPort}`;
  }, 'resolved client endpoint');
  assert.equal(JSON.parse(fs.readFileSync(client)).env.ANTHROPIC_AUTH_TOKEN, 'test-key');
  const persisted = JSON.parse(fs.readFileSync(configPath));
  assert.equal(persisted.PORT, config.PORT);
  assert.equal(persisted.APIKEY, config.APIKEY);
  // An incomplete HTTP request keeps a real owned connection open during close.
  socket = net.connect(listenPort, '127.0.0.1');
  socket.on('error', () => {});
  await new Promise(resolve => socket.once('connect', resolve));
  socket.write('POST /v1/messages HTTP/1.1\r\nHost: localhost\r\nContent-Length: 999999\r\n\r\n{');
  await delay(100);
  const start = Date.now();
  child.kill('SIGTERM');
  await until(() => child.exitCode !== null || child.signalCode !== null, 'shutdown with active request');
  assert.equal(child.exitCode, 0, output().slice(-600));
  assert.ok(Date.now() - start < 4500);
  assert.deepEqual(JSON.parse(fs.readFileSync(client)), original);
  socket.destroy();

  // A failed bind must never disable or rewrite previously enabled clients.
  blocker = http.createServer((_req, res) => res.end('fixture'));
  await new Promise(resolve => blocker.listen(listenPort, '127.0.0.1', resolve));
  const failed = launch(dir);
  await until(() => failed.child.exitCode !== null, 'failed bind exit');
  assert.notEqual(failed.child.exitCode, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(client)), original);
  assert.equal(JSON.parse(fs.readFileSync(configPath)).Clients.claudeCode.enabled, true);
  await new Promise(resolve => blocker.close(resolve));
  console.log(JSON.stringify({ ok: true, checks: ['resolved-client-endpoint', 'resolved-client-auth', 'raw-placeholders-preserved', 'active-request-shutdown-bounded', 'client-restored', 'failed-bind-does-not-restore'] }));
} finally {
  socket?.destroy();
  if (blocker?.listening) await new Promise(resolve => blocker.close(resolve));
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise(resolve => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 1000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.kill('SIGTERM');
      });
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
}
