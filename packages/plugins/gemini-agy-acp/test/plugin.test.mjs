import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { activateWithTransport, resolveProxyUrl } from '../src/plugin.mjs';

const name = 'gemini-agy-acp';
const provider = { name, apiKey: `ccr-managed-${name}`, models: ['model-1', 'model-high'] };
const settings = { enabled: true, binary: '/path/to/local/fixture', authMethod: 'gemini-api-key' };
const body = { model: 'model-1', messages: [{ role: 'user', content: 'hello' }] };
const end = { stopReason: 'end_turn' };

async function activate(t, local, run = t.mock.fn(async () => end)) {
  const configDir = await mkdtemp(join(tmpdir(), 'agy-plugin-'));
  t.after(() => rm(configDir, { recursive: true, force: true }));
  if (local !== undefined) await writeFile(join(configDir, `${name}.json`), JSON.stringify(local));
  let transformer, runtime;
  const registerUiCard = t.mock.fn();
  const registerAdminRoutes = t.mock.fn();
  const factory = t.mock.fn(() => ({ run, async close() {}, async retireExisting() {} }));
  await activateWithTransport({ host: { configDir }, registerTransformer(cls) { transformer = new cls(); },
    registerManagedRuntime(value) { runtime = value; }, registerUiCard, registerAdminRoutes }, factory);
  assert.equal(registerUiCard.mock.callCount(), 1);
  assert.deepEqual(registerUiCard.mock.calls[0].arguments, [{ cardPath: 'card.js' }]);
  assert.equal(registerAdminRoutes.mock.callCount(), 1);
  const attempt = t.mock.fn(() => { throw Error('Unexpected HTTP attempt'); });
  t.after(() => assert.equal(attempt.mock.callCount(), 0));
  const dispatch = (requestBody = body, req = { body: requestBody }, config = {}) =>
    runtime.dispatchRequest({ requestBody, req, config, provider, attempt });
  return { dispatch, factory, run, runtime, transformer };
}

test('proxy resolution mirrors the core policy: global default on, opt-in otherwise', async () => {
  const host = config => ({ readRawConfig: async () => config });
  const entry = { name: 'gemini-agy-acp' };
  assert.equal(await resolveProxyUrl(host({ PROXY_URL: 'http://127.0.0.1:7897' })), 'http://127.0.0.1:7897');
  assert.equal(await resolveProxyUrl(host({ httpsProxy: 'http://127.0.0.1:7897', PROXY_GLOBAL_ENABLED: 'false', Providers: [{ ...entry, proxy_enabled: true }] })), 'http://127.0.0.1:7897');
  assert.equal(await resolveProxyUrl(host({ PROXY_URL: 'http://127.0.0.1:7897', PROXY_GLOBAL_ENABLED: false, Providers: [entry] })), undefined);
  assert.equal(await resolveProxyUrl(host({ PROXY_URL: 'http://127.0.0.1:7897', PROXY_GLOBAL_ENABLED: '0', providers: [{ ...entry, proxyEnabled: true }] })), 'http://127.0.0.1:7897');
  assert.equal(await resolveProxyUrl(host({ PROXY_URL: 'socks5://127.0.0.1:1080' })), undefined);
  assert.equal(await resolveProxyUrl(host({})), undefined);
  assert.equal(await resolveProxyUrl({ readRawConfig: async () => { throw new Error('unreadable'); } }), undefined);
  assert.equal(await resolveProxyUrl(undefined), undefined);
  assert.equal(await resolveProxyUrl({ readConfig: async () => ({ PROXY_URL: 'http://127.0.0.1:7897' }) }), undefined);
  process.env.CCR_AGY_TEST_PROXY = 'http://127.0.0.1:7899';
  try {
    assert.equal(await resolveProxyUrl(host({ PROXY_URL: '$CCR_AGY_TEST_PROXY' })), 'http://127.0.0.1:7899');
  } finally { delete process.env.CCR_AGY_TEST_PROXY; }
  const warnings = [];
  const log = { warn: message => warnings.push(message) };
  assert.equal(await resolveProxyUrl(host({ PROXY_URL: 'socks5://127.0.0.1:1080' }), 'gemini-agy-acp', log), undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /socks5/);
  assert.ok(!warnings[0].includes('127.0.0.1'));
  assert.equal(await resolveProxyUrl(host({ PROXY_URL: '$CCR_AGY_MISSING_PROXY' }), 'gemini-agy-acp', log), undefined);
  assert.match(warnings[1], /placeholder/);
  const repeatHost = host({ PROXY_URL: 'socks5://127.0.0.1:1080' });
  await resolveProxyUrl(repeatHost, 'gemini-agy-acp', log);
  await resolveProxyUrl(repeatHost, 'gemini-agy-acp', log);
  assert.equal(warnings.length, 3);
  process.env.CCR_AGY_TEST_PAD = ' http://127.0.0.1:7899 ';
  try {
    assert.equal(await resolveProxyUrl(host({ PROXY_URL: '$CCR_AGY_TEST_PAD' })), 'http://127.0.0.1:7899');
  } finally { delete process.env.CCR_AGY_TEST_PAD; }
});

test('the pool factory receives the resolved proxy and a proxy change rebuilds the pool', async t => {
  const configDir = await mkdtemp(join(tmpdir(), 'agy-proxy-'));
  t.after(() => rm(configDir, { recursive: true, force: true }));
  await writeFile(join(configDir, 'gemini-agy-acp.json'), JSON.stringify(settings));
  let config = { PROXY_URL: 'http://127.0.0.1:7897' };
  const pools = [];
  const factory = t.mock.fn(() => {
    const pool = { run: async () => end, async close() {}, retireExisting: t.mock.fn(async () => {}), retireIdle: t.mock.fn(async () => {}) };
    pools.push(pool);
    return pool;
  });
  let runtime;
  await activateWithTransport({ host: { configDir, readRawConfig: async () => config }, registerTransformer() {},
    registerManagedRuntime(value) { runtime = value; }, registerUiCard() {}, registerAdminRoutes() {} }, factory);
  await runtime.dispatchRequest({ requestBody: body, req: { body }, config: {}, provider, attempt: () => { throw Error('no http'); } });
  assert.equal(factory.mock.calls[0].arguments[0].proxyUrl, 'http://127.0.0.1:7897');
  config = { PROXY_URL: 'http://127.0.0.1:7898' };
  await runtime.dispatchRequest({ requestBody: body, req: { body }, config: {}, provider, attempt: () => { throw Error('no http'); } });
  assert.equal(factory.mock.callCount(), 2);
  assert.equal(factory.mock.calls[1].arguments[0].proxyUrl, 'http://127.0.0.1:7898');
  assert.equal(pools[0].retireIdle.mock.callCount(), 1);
  assert.equal(pools[0].retireExisting.mock.callCount(), 0);
  await writeFile(join(configDir, 'gemini-agy-acp.json'), JSON.stringify({ ...settings, binary: '/path/to/local/fixture-b' }));
  config = { PROXY_URL: 'http://127.0.0.1:7899' };
  await runtime.dispatchRequest({ requestBody: body, req: { body }, config: {}, provider, attempt: () => { throw Error('no http'); } });
  assert.equal(factory.mock.callCount(), 3);
  assert.equal(pools[1].retireExisting.mock.callCount(), 1);
  assert.equal(pools[1].retireIdle.mock.callCount(), 0);
});

test('a proxy-only swap is deferred while the live pool holds a parked tool call', async t => {
  const configDir = await mkdtemp(join(tmpdir(), 'agy-proxy-parked-'));
  t.after(() => rm(configDir, { recursive: true, force: true }));
  await writeFile(join(configDir, 'gemini-agy-acp.json'), JSON.stringify(settings));
  let config = { PROXY_URL: 'http://127.0.0.1:7897' };
  const pools = [];
  const factory = t.mock.fn(() => {
    const pool = { run: async () => end, async close() {}, retireExisting: t.mock.fn(async () => {}), retireIdle: t.mock.fn(async () => {}), hasParked: () => false };
    pools.push(pool);
    return pool;
  });
  let runtime;
  await activateWithTransport({ host: { configDir, readRawConfig: async () => config }, registerTransformer() {},
    registerManagedRuntime(value) { runtime = value; }, registerUiCard() {}, registerAdminRoutes() {} }, factory);
  const dispatch = () => runtime.dispatchRequest({ requestBody: body, req: { body }, config: {}, provider, attempt: () => { throw Error('no http'); } });
  await dispatch();
  assert.equal(factory.mock.callCount(), 1);
  pools[0].hasParked = () => true;
  config = { PROXY_URL: 'http://127.0.0.1:7898' };
  await dispatch();
  assert.equal(factory.mock.callCount(), 1);
  assert.equal(pools[0].retireIdle.mock.callCount(), 0);
  pools[0].hasParked = () => false;
  await dispatch();
  assert.equal(factory.mock.callCount(), 2);
  assert.equal(factory.mock.calls[1].arguments[0].proxyUrl, 'http://127.0.0.1:7898');
  assert.equal(pools[0].retireIdle.mock.callCount(), 1);
});

test('reserved provider name is exact and the plugin remains disabled until local opt-in', async t => {
  for (const local of [undefined, {}, { ...settings, enabled: 'true' }, { ...settings, enabled: false }]) {
    const p = await activate(t, local);
    assert.equal(p.runtime.isManaged(provider), true);
    for (const other of ['gemini-oauth', 'Gemini-agy-acp', 'gemini-agy-acp-2']) {
      assert.equal(p.runtime.isManaged({ ...provider, name: other }), false);
    }
    assert.equal(p.transformer.name, name);
    const req = { body, enableFallback: true };
    await assert.rejects(p.transformer.transformRequestIn(body, provider, { req }), { code: 'agy_disabled' });
    assert.equal(req.enableFallback, false);
    await assert.rejects(p.dispatch(), { code: 'agy_disabled' });
    assert.equal(p.factory.mock.callCount(), 0);
    assert.equal((await p.runtime.probeAccountState()).available, false);
    await assert.rejects(p.runtime.signRequest({}), { code: 'agy_http_disabled' });
  }
});

test('only absolute local binary, API-key auth and bounded worker settings are accepted', async t => {
  for (const overrides of [{ binary: 'agy' }, { authMethod: 'consumer-login' }, { timeoutMs: 0 }, { maxWorkers: 20 }]) {
    const p = await activate(t, { ...settings, ...overrides });
    const req = { enableFallback: true, body };
    await assert.rejects(p.dispatch(body, req), { code: 'agy_config_invalid' });
    assert.equal(req.enableFallback, false);
    assert.equal(p.factory.mock.callCount(), 0);
  }
});

test('aggregate passes ordered text, exact model and separate effort, disregards client process settings', async t => {
  const run = t.mock.fn(async ({ onText }) => { onText('first'); onText(' second'); return { stopReason: 'max_tokens' }; });
  const p = await activate(t, settings, run);
  const request = { model: 'model-high', binary: 'untrusted-binary', authMethod: 'consumer-login', api_key: 'test-key',
    reasoning_effort: 'high', messages: [{ role: 'system', content: 'Instruction' }, ...body.messages,
      { role: 'assistant', content: 'Previous' }, { role: 'user', content: [{ type: 'text', text: 'Next' }] }] };
  const req = { body: request, enableFallback: true };
  const transformed = await p.transformer.transformRequestIn(request, provider, { req });
  const response = await (await p.dispatch(transformed.body, req)).json();
  assert.deepEqual(response.choices, [{ index: 0, message: { role: 'assistant', content: 'first second' }, finish_reason: 'length' }]);
  assert.equal(response.model, request.model);
  assert.equal(response.object, 'chat.completion');
  const input = run.mock.calls[0].arguments[0];
  assert.equal(input.model, 'model-high');
  assert.equal(input.thinking, 'high');
  assert.deepEqual(JSON.parse(input.prompt.split('\n')[1]), [...request.messages.slice(0, 3), { role: 'user', content: 'Next' }]);
  assert.deepEqual(Object.keys(input).sort(), ['model', 'onText', 'prompt', 'signal', 'thinking']);
  assert.deepEqual(p.factory.mock.calls[0].arguments, [{ binary: settings.binary, authMethod: 'gemini-api-key', maxWorkers: 2, timeoutMs: 60000 }]);
  assert.equal(req.enableFallback, false);
  await p.dispatch({ ...body, reasoning: { effort: 'max' } }, { body: { ...body, output_config: { effort: 'xhigh' } } });
  assert.equal(run.mock.calls[1].arguments[0].thinking, 'xhigh');
});

test('rejects unsupported original/normalized content and out-of-catalog model before ACP', async t => {
  const p = await activate(t, settings);
  // Content and model errors stay terminal. Tool *declarations* are no longer
  // rejected here — they take the tool path, whose own rejections are asserted
  // by the tool-calling tests.
  for (const extra of [{ modalities: ['audio'] },
    { system: [{ type: 'image' }] }, { messages: [{ role: 'developer', content: 'x' }] },
    { messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }, { type: 'image_url' }] }] }]) {
    const invalid = { ...body, ...extra };
    await assert.rejects(p.transformer.transformRequestIn(body, provider, { req: { body: invalid } }), { code: 'agy_unsupported_request' });
    await assert.rejects(p.dispatch(invalid), { code: 'agy_unsupported_request' });
  }
  // A malformed tool entry (no name) is a request error, not a silent drop.
  for (const extra of [{ tools: [{}] }, { functions: [{}] }]) {
    await assert.rejects(p.dispatch({ ...body, ...extra }), { code: 'agy_unsupported_request' });
  }
  // A tool_choice with nothing to choose has no tool path either.
  await assert.rejects(p.dispatch({ ...body, tool_choice: 'auto' }), { code: 'agy_unsupported_request' });
  // A tool result without any declared tool is just an ignored message: the
  // request stays on the text-only path rather than becoming a tool turn.
  for (const extra of [{ model: 'model' }, { reasoning_effort: 'other' }]) {
    await assert.rejects(p.dispatch({ ...body, ...extra }), { statusCode: 400 });
  }
  await assert.rejects(p.transformer.transformRequestIn(body, { ...provider, apiKey: 'test-key' }, {}), { code: 'agy_provider_config_invalid' });
  assert.equal(p.run.mock.callCount(), 0);
});

test('OpenAI SSE exposes incremental text before completion and finishes once', async t => {
  let finish;
  const p = await activate(t, settings, async ({ onText }) => {
    onText('first'); await new Promise(resolve => { finish = resolve; }); onText('second'); return end;
  });
  const response = await p.dispatch({ ...body, stream: true });
  const reader = response.body.getReader();
  const next = async () => new TextDecoder().decode((await reader.read()).value);
  const chunk = async () => JSON.parse((await next()).slice(6));
  assert.match(response.headers.get('content-type'), /event-stream/);
  const first = await chunk();
  assert.equal(first.object, 'chat.completion.chunk');
  assert.deepEqual(first.choices[0].delta, { role: 'assistant' });
  assert.deepEqual((await chunk()).choices[0].delta, { content: 'first' });
  finish();
  assert.deepEqual((await chunk()).choices[0].delta, { content: 'second' });
  assert.equal((await chunk()).choices[0].finish_reason, 'stop');
  assert.equal(await next(), 'data: [DONE]\n\n');
  assert.equal((await reader.read()).done, true);
});

test('early errors preserve safe codes/status and late failures end the stream explicitly', async t => {
  const failed = () => { throw Object.assign(new Error('secret stderr'), { statusCode: 401, code: 'auth_required' }); };
  const p = await activate(t, settings, failed);
  for (const stream of [false, true]) {
    await assert.rejects(p.dispatch({ ...body, stream }), { message: 'auth_required', code: 'auth_required', statusCode: 401, nonRetryable: true });
  }
  const late = await activate(t, settings, ({ onText }) => { onText('text'); failed(); });
  const sse = await (await late.dispatch({ ...body, stream: true })).text();
  assert.match(sse, /"error":\{"code":"auth_required"/);
  assert.doesNotMatch(sse, /secret stderr|\[DONE\]/);
});

test('aggregate AND stream bound both bytes and tiny-frame count', async t => {
  for (const oversize of [true, false]) {
    const p = await activate(t, settings, async ({ onText }) => {
      if (oversize) onText('x'.repeat(1024 * 1024 + 1));
      else for (let i = 0; i < 8193; i++) onText('x');
      return end;
    });
    await assert.rejects(p.dispatch(body), { code: 'agy_output_limit' });
    if (oversize) await assert.rejects(p.dispatch({ ...body, stream: true }), { code: 'agy_output_limit' });
    else assert.match(await (await p.dispatch({ ...body, stream: true })).text(), /"code":"agy_output_limit"/);
  }
});

test('Fastify socket disconnect, request abort and stream cancellation abort the same transport run', async t => {
  for (const source of ['socket', 'aborted', 'reader']) {
    const raw = Object.assign(new EventEmitter(), { socket: new EventEmitter() });
    let signal;
    const p = await activate(t, settings, t.mock.fn(async input => {
      signal = input.signal;
      input.onText('started');
      await new Promise((resolve, reject) => signal.addEventListener('abort', reject, { once: true }));
    }));
    const req = { body, raw };
    const result = p.dispatch({ ...body, stream: source === 'reader' }, req);
    // The dispatcher awaits its settings refresh before wiring cancellation,
    // so wait until the transport run has actually started.
    for (let i = 0; p.run.mock.callCount() === 0 && i < 100; i++) await delay(5);
    raw.emit('close');
    assert.equal(signal.aborted, false);
    if (source === 'reader') await (await result).body.cancel();
    else {
      if (source === 'socket') raw.socket.emit('close'); else raw.emit('aborted');
      await assert.rejects(result, { code: 'agy_cancelled' });
    }
    assert.equal(signal.aborted, true);
    assert.equal(raw.listenerCount('aborted'), 0);
    assert.equal(raw.socket.listenerCount('close'), 0);
  }
});
