import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { after, before, test } from 'node:test';
import { createTransport, isolatedEnvironment, probeVersion, syncModelOptions, verifyOauthHandshake } from '../src/transport.mjs';
import { chatResponse } from '../src/chat.mjs';

test('oauth-personal runs the whitelisted real environment, authenticates the CLI login and never creates an isolated root', async t => {
  const { transport, events } = await setup(t, 'ok', { authMethod: 'oauth-personal' });
  assert.deepEqual(await transport.run(input), { stopReason: 'max_tokens' });
  const log = await events();
  assert.deepEqual(log.map(record => record.event), ['version', 'spawn', 'initialize', 'authenticate',
    'session/new', 'session/set_config_option', 'session/set_config_option', 'session/prompt']);
  const spawn = log.find(record => record.event === 'spawn');
  assert.equal(spawn.root, undefined); // no isolated root was ever created
  assert.match(spawn.cwd, /ccr-agy-acp-/); // fresh cwd directly under the OS temp dir
  assert.equal(spawn.home, process.env.HOME); // the CLI sees the real user's home (keyring login)
  const session = log.find(record => record.event === 'session/new');
  assert.equal(dirname(session.cwd), tmpdir()); // per-turn session cwds under the OS temp dir
  await transport.close();
  assert.equal(existsSync(spawn.cwd), false);
  assert.throws(() => process.kill(spawn.pid, 0), { code: 'ESRCH' });
  assert.equal(existsSync(session.cwd), false);
});

test('oauth transport rejects an apiKey; gemini transport still requires a captured credential', async t => {
  assert.throws(() => createTransport({ binary: join('x', 'y'), authMethod: 'oauth-personal', apiKey: 'fixture-value' }),
    { code: 'acp_invalid_config' });
  delete process.env.GEMINI_API_KEY;
  try {
    const missing = await setup(t);
    await rejects(missing.transport.run(input), 'auth_required', 401);
    assert.deepEqual(await missing.events(), []);
  } finally { process.env.GEMINI_API_KEY = variables.GEMINI_API_KEY; }
});

test('oauth handshake verification returns only this handshake\'s account email', async t => {
  const metadata = await setup(t, 'ok', { authMethod: 'oauth-personal' });
  // Explicit ACP metadata wins over the child's own stderr login line.
  assert.deepEqual(await verifyOauthHandshake({ binary: metadata.binary }),
    { version: '1.5.1', accountEmail: 'metadata-account@example.com' });
  assert.deepEqual((await metadata.events()).map(record => record.event),
    ['version', 'spawn', 'initialize', 'authenticate', 'session/new']);
  const stderr = await setup(t, 'stderr-login', { authMethod: 'oauth-personal' });
  assert.deepEqual(await verifyOauthHandshake({ binary: stderr.binary }),
    { version: '1.5.1', accountEmail: 'stderr-account@example.com' });
  const silent = await setup(t, 'silent-login', { authMethod: 'oauth-personal' });
  assert.deepEqual(await verifyOauthHandshake({ binary: silent.binary }),
    { version: '1.5.1', accountEmail: null });
  const versionOnly = await setup(t, 'version-email', { authMethod: 'oauth-personal' });
  assert.deepEqual(await verifyOauthHandshake({ binary: versionOnly.binary }),
    { version: '1.5.1', accountEmail: null });
  for (const record of await versionOnly.events()) {
    if (record.cwd) assert.equal(existsSync(record.cwd), false);
  }
  // A rejected authenticate maps to auth_required without leaking diagnostics.
  const failing = await setup(t, 'auth-failure', { authMethod: 'oauth-personal' });
  await rejects(verifyOauthHandshake({ binary: failing.binary }), 'auth_required', 401);
  for (const record of await failing.events()) {
    if (record.cwd) assert.equal(existsSync(record.cwd), false);
  }
  for (const invalid of ['agy', '/x/\0y', 42]) {
    await assert.rejects(verifyOauthHandshake({ binary: invalid }), { code: 'acp_invalid_config' });
  }
});

test('model sync supports oauth-personal without any credential', async t => {
  const { binary, events } = await setup(t, 'ok', { authMethod: 'oauth-personal' });
  assert.deepEqual(await syncModelOptions({ binary, authMethod: 'oauth-personal' }),
    { models: [{ id: 'm2', name: 'Gemini Model' }, { id: 'default', name: 'Default' }], version: '1.5.1' });
  assert.deepEqual((await events()).map(record => record.event),
    ['version', 'spawn', 'initialize', 'authenticate', 'session/new']);
  await rejects(syncModelOptions({ binary, authMethod: 'oauth-personal', apiKey: 'fixture-value' }), 'invalid_config', 400);
  assert.deepEqual((await events()).map(record => record.event),
    ['version', 'spawn', 'initialize', 'authenticate', 'session/new']);
});

const input = { model: 'Gemini Model', thinking: 'xhigh', prompt: '你好', onText() {} };
const variables = { GEMINI_API_KEY: 'fixture-value', AGY_TEST_PARENT_ONLY: 'not-for-child',
  GOOGLE_APPLICATION_CREDENTIALS: '/nonexistent-fixture' };
const previous = new Map();
before(() => {
  for (const [name, value] of Object.entries(variables)) {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  }
});
after(() => {
  for (const [name, value] of previous) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

async function setup(t, mode = 'ok', config = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'acp-fixture-'));
  const binary = join(dir, 'fixture.mjs');
  const source = await readFile(new URL('./fixtures/agy-acp.mjs', import.meta.url), 'utf8');
  await writeFile(binary, `#!${process.execPath}\n${source}`, { mode: 0o700 });
  await writeFile(join(dir, 'mode'), mode);
  await writeFile(join(dir, 'authMethod'), config.authMethod === 'oauth-personal' ? 'oauth-personal' : 'gemini-api-key');
  await writeFile(join(dir, 'events'), '');
  const transport = createTransport({ binary, authMethod: 'gemini-api-key', ...config });
  const events = async () => (await readFile(join(dir, 'events'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  t.after(async () => {
    try {
      await transport.close();
      for (const event of await events()) if (event.root) {
        assert.equal(existsSync(event.root), false);
        assert.throws(() => process.kill(event.pid, 0), { code: 'ESRCH' });
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  return { transport, events, binary, dir };
}

function rejects(promise, code, statusCode) {
  return assert.rejects(promise, error => {
    assert.equal(error.code, `acp_${code}`);
    assert.equal(error.statusCode, statusCode);
    assert.doesNotMatch(error.message, /fixture|你好/);
    return true;
  });
}

async function waitForEvent(events, name) {
  for (let i = 0; i < 200; i++) {
    if ((await events()).some(event => event.event === name)) return;
    await delay(10);
  }
  assert.fail(`Missing fixture event ${name}`);
}

test('reuses an authenticated worker, creates fresh sessions, and forwards only current assistant text', async t => {
  const { transport, events } = await setup(t);
  const chunks = [];
  for (const prompt of ['你好', 'second']) {
    assert.deepEqual(await transport.run({ ...input, prompt, onText: text => chunks.push(text) }), { stopReason: 'max_tokens' });
  }
  assert.deepEqual(chunks, ['你好', 'second']);
  const log = await events();
  assert.deepEqual(log.map(record => record.event), ['version', 'spawn', 'initialize', 'authenticate',
    ...Array(2).fill(['session/new', 'session/set_config_option', 'session/set_config_option', 'session/prompt']).flat()]);
  const dirs = log.filter(record => record.cwd).map(record => record.cwd);
  assert.equal(new Set(dirs).size, 2);
  assert.ok(dirs.every(cwd => !existsSync(cwd)));
});

test('prompt usage reaches chat completions and only the terminal stream chunk', async t => {
  const { transport } = await setup(t, 'prompt-usage');
  const quota = { quota: { token_count: { input_tokens: 81, output_tokens: 11 }, remaining: 'private' } };
  const detailed = { usage_source: 'gemini-agy-acp', prompt_tokens: 39, completion_tokens: 9, total_tokens: 48,
    prompt_tokens_details: { cached_tokens: 21, cache_write_tokens: 2 },
    completion_tokens_details: { reasoning_tokens: 7 } };
  const detailCounts = { cachedReadTokens: 21, cachedWriteTokens: 2, thoughtTokens: 7, totalTokens: 48 };
  for (const [name, fields, expected] of [
    ['current net input', { usage: { ...detailCounts, inputTokens: 16, outputTokens: 9 }, _meta: quota }, detailed],
    ['legacy gross input and exclusive output', { usage: { ...detailCounts, inputTokens: 39, outputTokens: 2 } }, detailed],
    ['gross input and inclusive output', { usage: { ...detailCounts, inputTokens: 39, outputTokens: 9 } }, detailed],
    ['input includes reads only', { usage: { ...detailCounts, inputTokens: 37, outputTokens: 2 } }, detailed],
    ['missing total uses current layout', { usage: { inputTokens: 16, outputTokens: 9,
      cachedReadTokens: 21, cachedWriteTokens: 2, thoughtTokens: 7 } }, detailed],
    ['legacy quota', { _meta: quota },
      { usage_source: 'gemini-agy-acp', prompt_tokens: 81, completion_tokens: 11, total_tokens: 92 }],
    ['quota fallback uses the whole pair when standard output is invalid',
      { usage: { inputTokens: 0, outputTokens: -1, cachedReadTokens: 1.5 }, _meta: quota },
      { usage_source: 'gemini-agy-acp', prompt_tokens: 81, completion_tokens: 11, total_tokens: 92 }],
    ['quota input is already gross, even with partial standard cache details',
      { usage: { inputTokens: -1, outputTokens: 9, cachedReadTokens: 21, cachedWriteTokens: 2 },
        _meta: { quota: { token_count: { input_tokens: 39, output_tokens: 9 } } } },
      { usage_source: 'gemini-agy-acp', prompt_tokens: 39, completion_tokens: 9, total_tokens: 48 }],
    ['standard and quota fields cannot make a mixed pair',
      { usage: { inputTokens: 16 }, _meta: { quota: { token_count: { output_tokens: 9 } } } }, undefined],
    ['distinct splits matching the same total',
      { usage: { ...detailCounts, inputTokens: 37, outputTokens: 9, thoughtTokens: 2 }, _meta: quota }, undefined],
    ['distinct splits even when the current layout matches',
      { usage: { ...detailCounts, inputTokens: 37, outputTokens: 25, thoughtTokens: 21, totalTokens: 85 } }, undefined],
    ['no split matches the reported total',
      { usage: { ...detailCounts, inputTokens: 16, outputTokens: 9, totalTokens: 49 }, _meta: quota }, undefined],
    ['invalid reported total', { usage: { inputTokens: 16, outputTokens: 9, totalTokens: -1 } }, undefined],
    ['explicit zeros and equivalent layouts', { usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
      { usage_source: 'gemini-agy-acp', prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }],
    ['absent', {}, undefined],
    ['malformed', { usage: { inputTokens: '3', outputTokens: 2.5 }, _meta: { quota: { token_count: {
      input_tokens: -1, output_tokens: Number.MAX_SAFE_INTEGER + 1,
    } } } }, undefined],
    ['missing output', { usage: { inputTokens: 7, thoughtTokens: 3 } }, undefined],
    ['unsafe sum', { usage: { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 } }, undefined],
  ]) await t.test(name, async () => {
    const prompt = { ...input, prompt: JSON.stringify(fields) };
    const json = await (await chatResponse(transport, prompt, false)).text();
    assert.doesNotMatch(json, /_meta|private/);
    const completion = JSON.parse(json);
    assert.deepEqual(completion.usage, expected);
    assert.equal(completion.choices[0].message.content, 'fixture response');
    const sse = await (await chatResponse(transport, prompt, true)).text();
    assert.doesNotMatch(sse, /_meta|private/);
    const frames = sse.trimEnd().split('\n\n').map(frame => frame.slice('data: '.length));
    assert.equal(frames.pop(), '[DONE]');
    const [role, text, finish] = frames.map(JSON.parse);
    assert.equal(frames.length, 3);
    assert.equal(role.usage, undefined);
    assert.equal(text.usage, undefined);
    assert.equal(text.choices[0].delta.content, 'fixture response');
    assert.equal(finish.choices[0].finish_reason, 'stop');
    assert.deepEqual(finish.usage, expected);
  });
});

test('denies permission, read/write and terminal callbacks with protocol responses', async t => {
  const { transport } = await setup(t);
  assert.deepEqual(await transport.run({ ...input, prompt: 'callbacks' }), { stopReason: 'end_turn' });
});

test('fails closed during version, initialization, auth, and option negotiation', async t => {
  for (const [mode, code, statusCode, forbidden] of [
    ['old', 'unsupported_version', 502, 'spawn'], ['prerelease', 'unsupported_version', 502, 'spawn'],
    ['long-version', 'output_limit', 502, 'spawn'], ['v2', 'protocol_error', 502, 'authenticate'],
    ['no-key-method', 'auth_required', 401, 'authenticate'], ['terminal-auth', 'auth_required', 401, 'authenticate'],
    ['env-auth', 'auth_required', 401, 'session/new'],
    ['auth-failure', 'auth_required', 401, 'session/new'], ['no-thinking', 'unsupported_option', 400, 'session/prompt'],
    ['ignored-option', 'unsupported_option', 400, 'session/prompt'],
    ['wrong-category', 'unsupported_option', 400, 'session/set_config_option'],
  ]) await t.test(mode, async t => {
    const { transport, events } = await setup(t, mode);
    await rejects(transport.run(input), code, statusCode);
    assert.ok(!(await events()).some(record => record.event === forbidden));
  });
});

test('rejects missing key, oversized prompt, unsupported model and effort', async t => {
  const { transport, events } = await setup(t);
  delete process.env.GEMINI_API_KEY;
  try {
    const missing = await setup(t);
    await rejects(missing.transport.run(input), 'auth_required', 401);
    assert.deepEqual(await missing.events(), []);
  } finally { process.env.GEMINI_API_KEY = variables.GEMINI_API_KEY; }
  await rejects(transport.run({ ...input, prompt: 'あ'.repeat(350000) }), 'input_limit', 413);
  assert.deepEqual(await events(), []);
  for (const overrides of [{ model: 'unavailable' }, { thinking: 'max' }]) {
    await rejects(transport.run({ ...input, ...overrides }), 'unsupported_option', 400);
  }
  assert.ok(!(await events()).some(record => record.event === 'session/prompt'));
});

test('pool grants two leases by default, rejects overload and replaces cancelled workers', async t => {
  const { transport, events } = await setup(t);
  const controllers = [new AbortController(), new AbortController()];
  const pending = controllers.map(c => rejects(transport.run({ ...input, prompt: 'hang', signal: c.signal }), 'cancelled', 499));
  await rejects(transport.run(input), 'busy', 503);
  await waitForEvent(events, 'session/prompt');
  controllers.forEach(c => c.abort());
  await Promise.all(pending);
  // Cancellation settles before the OS has necessarily reaped the workers.
  const deadline = Date.now() + 3000;
  for (;;) {
    try {
      assert.deepEqual(await transport.run(input), { stopReason: 'max_tokens' });
      break;
    } catch (error) {
      if (error.code !== 'acp_busy' || Date.now() >= deadline) throw error;
      await delay(10);
    }
  }
  await transport.close();
  await rejects(transport.run(input), 'closed', 503);
});

test('reaps a probe aborted during startup and never spawns ACP', async t => {
  const { transport, events } = await setup(t, 'hang-version');
  const controller = new AbortController();
  const pending = rejects(transport.run({ ...input, signal: controller.signal }), 'cancelled', 499);
  await waitForEvent(events, 'version');
  controller.abort();
  await pending;
  assert.deepEqual((await events()).map(record => record.event), ['version']);
});

test('deadline settles even if an exited version probe has not emitted close', async t => {
  const { transport } = await setup(t, 'ok', { timeoutMs: 20000, maxWorkers: 1 });
  const emit = ChildProcess.prototype.emit;
  const schedule = globalThis.setTimeout;
  let expire, releaseClose, intercepted = true;
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => {
    if (ms === 20000) expire = fn;
    return schedule(fn, ms, ...args);
  });
  t.mock.method(ChildProcess.prototype, 'emit', function(event, ...args) {
    if (intercepted && event === 'close' && this.spawnargs.includes('--version')) {
      releaseClose = () => emit.call(this, event, ...args);
      queueMicrotask(expire);
      return true;
    }
    return emit.call(this, event, ...args);
  });
  const safeguard = AbortSignal.timeout(4000);
  try {
    await Promise.race([rejects(transport.run(input), 'timeout', 504), new Promise((_, reject) =>
      safeguard.addEventListener('abort', () => reject(new Error('Deadline waited for close')), { once: true }))]);
    assert.equal(typeof releaseClose, 'function');
    await rejects(transport.run(input), 'busy', 503);
  } finally { intercepted = false; releaseClose?.(); }
});

test('all workers use the key captured at provider activation', async t => {
  const { transport } = await setup(t);
  process.env.GEMINI_API_KEY = 'test-key';
  try {
    await Promise.all([transport.run(input), transport.run(input)]);
  } finally { process.env.GEMINI_API_KEY = variables.GEMINI_API_KEY; }
});

test('request deadline covers startup and active prompt', async t => {
  for (const mode of ['hang-init', 'ok']) await t.test(mode, async t => {
    const { transport, events } = await setup(t, mode, { timeoutMs: 2000 });
    await rejects(transport.run({ ...input, prompt: 'hang' }), 'timeout', 504);
    assert.ok((await events()).some(record => record.event === (mode === 'ok' ? 'session/prompt' : 'initialize')));
  });
});

test('handles unexpected exit, invalid frames, large partial frames, aggregate limit and unsafe stop reasons', async t => {
  const { transport } = await setup(t, 'ok', { maxWorkers: 1 });
  for (const [prompt, code] of [['exit', 'worker_failed'], ['bad-json', 'protocol_error'], ['flood', 'output_limit'],
    ['many-chunks', 'output_limit'], ['unknown-stop', 'protocol_error']]) {
    await rejects(transport.run({ ...input, prompt }), code, 502);
  }
  assert.deepEqual(await transport.run(input), { stopReason: 'max_tokens' });
});

test('rejects repeated session IDs before a second prompt', async t => {
  const { transport, events } = await setup(t, 'duplicate-session');
  await transport.run(input);
  await rejects(transport.run(input), 'protocol_error', 502);
  assert.equal((await events()).filter(record => record.event === 'session/prompt').length, 1);
});

test('idle deadline reaps the worker and allows its replacement', async t => {
  const { transport, events } = await setup(t, 'ok', { maxWorkers: 1 });
  const schedule = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) =>
    schedule(callback, ms === 30_000 ? 20 : ms, ...args));
  await transport.run(input);
  const { root } = (await events()).find(event => event.event === 'spawn');
  for (let i = 0; existsSync(root) && i < 100; i++) await delay(10);
  assert.equal(existsSync(root), false);
  await transport.run(input);
  assert.equal((await events()).filter(event => event.event === 'spawn').length, 2);
});

test('close waits for active startup, cancels a prompt, and reaps idle children', async t => {
  for (const stage of ['early', 'active', 'idle']) await t.test(stage, async t => {
    const { transport, events } = await setup(t);
    if (stage === 'idle') await transport.run(input);
    else {
      const pending = rejects(transport.run({ ...input, prompt: 'hang' }), 'closed', 503);
      if (stage === 'active') await waitForEvent(events, 'session/prompt');
      await Promise.all([pending, transport.close(), transport.close()]);
    }
    await transport.close();
    for (const { root } of await events()) if (root) assert.equal(existsSync(root), false);
  });
});

test('retireExisting drops pooled workers and the next run respawns fresh', async t => {
  const { transport, events } = await setup(t, 'ok', { maxWorkers: 1 });
  await transport.run(input);
  await transport.retireExisting();
  await transport.run(input);
  assert.equal((await events()).filter(record => record.event === 'spawn').length, 2);
  assert.deepEqual(await transport.run(input), { stopReason: 'max_tokens' });
});

test('worker start logs one bounded line with binary path and CLI version only', async t => {
  const lines = [];
  const { transport } = await setup(t, 'ok', { log: { info: message => lines.push(message) } });
  await transport.run(input);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /agy 1\.5\.1/);
  assert.match(lines[0], /binary: /);
  assert.doesNotMatch(lines[0], /fixture-value|你好|prompt/);
});

test('an explicit pool apiKey overrides the environment capture at start', async t => {
  process.env.GEMINI_API_KEY = 'test-key';
  const { transport } = await setup(t, 'ok', { apiKey: 'fixture-value' });
  try {
    await transport.run(input);
  } finally { process.env.GEMINI_API_KEY = variables.GEMINI_API_KEY; }
  assert.throws(() => createTransport({ binary: join('x', 'y'), authMethod: 'gemini-api-key', apiKey: '  ' }),
    { code: 'acp_invalid_config' });
  assert.throws(() => createTransport({ binary: join('x', 'y'), authMethod: 'gemini-api-key', apiKey: 5 }),
    { code: 'acp_invalid_config' });
});

test('probeVersion validates one binary in isolation without spawning ACP', async t => {
  const { binary, events } = await setup(t);
  assert.equal(await probeVersion(binary), '1.5.1');
  assert.deepEqual((await events()).map(record => record.event), ['version']);
  for (const invalid of ['agy', '/x/\0y', 42]) {
    await assert.rejects(probeVersion(invalid), { code: 'acp_invalid_config' });
  }
  assert.deepEqual((await events()).map(record => record.event), ['version']);
});

test('model sync spawns one bounded temp worker and reads the advertised model options', async t => {
  const { binary, events } = await setup(t);
  assert.deepEqual(await syncModelOptions({ binary, apiKey: 'fixture-value' }),
    { models: [{ id: 'm2', name: 'Gemini Model' }, { id: 'default', name: 'Default' }], version: '1.5.1' });
  assert.deepEqual((await events()).map(record => record.event),
    ['version', 'spawn', 'initialize', 'authenticate', 'session/new']);
  await rejects(syncModelOptions({ binary, apiKey: 'fixture-value', authMethod: 'consumer-login' }),
    'invalid_config', 400);
  await rejects(syncModelOptions({ binary, apiKey: ' ' }), 'invalid_config', 400);
  assert.deepEqual((await events()).map(record => record.event),
    ['version', 'spawn', 'initialize', 'authenticate', 'session/new']);
});

test('the isolated worker environment forwards only standard proxy variables', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agy-env-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previous = new Map(['HTTPS_PROXY', 'GEMINI_API_KEY', 'AWS_SECRET_ACCESS_KEY'].map(key => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  process.env.HTTPS_PROXY = 'http://127.0.0.1:7897';
  process.env.GEMINI_API_KEY = 'fixture-value';
  process.env.AWS_SECRET_ACCESS_KEY = 'fixture-value';
  const { env } = await isolatedEnvironment(root);
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7897');
  assert.equal(env.GEMINI_API_KEY, undefined);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.HOME, join(root, 'home'));
});

test('model sync is bounded and fails closed on protocol deviations', async t => {
  const hanging = await setup(t, 'hang-version');
  await rejects(syncModelOptions({ binary: hanging.binary, apiKey: 'fixture-value' }), 'timeout', 504);
  const wrong = await setup(t, 'wrong-category');
  await rejects(syncModelOptions({ binary: wrong.binary, apiKey: 'fixture-value' }), 'unsupported_option', 400);
  const old = await setup(t, 'old');
  await rejects(probeVersion(old.binary), 'unsupported_version', 502);
});
