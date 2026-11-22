import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { activateWithTransport } from '../src/plugin.mjs';
import { registerAdminRoutes } from '../src/admin-routes.mjs';

const name = 'gemini-agy-acp';
const sidecarName = `${name}.json`;
const sidecarPath = configDir => join(configDir, sidecarName);
const provider = { name, apiKey: `ccr-managed-${name}`, models: ['m2'] };
const body = { model: 'm2', messages: [{ role: 'user', content: 'hello' }] };

const STATUS_URL = `/api/${name}/status`;
const CONNECT_URL = `/api/${name}/connect`;
const DISCONNECT_URL = `/api/${name}/disconnect`;
const SYNC_URL = `/api/${name}/models/sync`;

const variables = { GEMINI_API_KEY: 'fixture-value' };
const previous = new Map();
before(() => {
  for (const [key, value] of Object.entries(variables)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
});
after(() => {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

/** A mock executable built from the protocol fixture (no real agy, no network). */
async function fixtureBinary(t, mode = 'ok') {
  const dir = await mkdtemp(join(tmpdir(), 'agy-admin-fixture-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binary = join(dir, 'fixture.mjs');
  const source = await readFile(new URL('./fixtures/agy-acp.mjs', import.meta.url), 'utf8');
  await writeFile(binary, `#!${process.execPath}\n${source}`, { mode: 0o700 });
  await writeFile(join(dir, 'mode'), mode);
  await writeFile(join(dir, 'events'), '');
  return { binary, dir, events: async () => (await readFile(join(dir, 'events'), 'utf8'))
    .trim().split('\n').filter(Boolean).map(JSON.parse) };
}

/** Minimal Fastify stub: the routes may only rely on get/post + reply.status. */
function stubApp(port = 43781) {
  const routes = new Map();
  const app = {
    server: { address: () => ({ port }) },
    log: { warn() {} },
    get: (url, handler) => routes.set(`GET ${url}`, handler),
    post: (url, handler) => routes.set(`POST ${url}`, handler),
  };
  const call = async (method, url, request = {}) => {
    const handler = routes.get(`${method} ${url}`);
    assert.ok(handler, `missing route ${method} ${url}`);
    const reply = { statusCode: 200, status(code) { this.statusCode = code; return this; } };
    const responseBody = await handler({ ip: '127.0.0.1', headers: { host: `127.0.0.1:${port}` }, ...request }, reply);
    return { status: reply.statusCode, body: responseBody };
  };
  return { app, call };
}

async function activate(t, { local, fixtureMode, host } = {}) {
  const configDir = await mkdtemp(join(tmpdir(), 'agy-admin-'));
  t.after(() => rm(configDir, { recursive: true, force: true }));
  if (local !== undefined) await writeFile(sidecarPath(configDir), JSON.stringify(local));
  let runtime;
  const registrars = [];
  const transports = [];
  const ctx = {
    host: { configDir, ...host },
    log: { info() {}, warn() {} },
    registerTransformer() {},
    registerManagedRuntime(value) { runtime = value; },
    registerUiCard() {},
    registerAdminRoutes(fn) { registrars.push(fn); },
  };
  await activateWithTransport(ctx, async options => {
    const transport = {
      options,
      run: async () => ({ stopReason: 'end_turn' }),
      close: async () => { transport.closed = true; },
      retireExisting: async () => { transport.retired = (transport.retired ?? 0) + 1; },
    };
    transports.push(transport);
    return transport;
  });
  assert.equal(registrars.length, 1);
  const { app, call } = stubApp();
  registrars[0](app);
  return {
    call,
    configDir,
    dispatch: () => runtime.dispatchRequest({ requestBody: body, req: { body }, config: {}, provider }),
    transports,
    fixture: fixtureMode === undefined ? undefined : await fixtureBinary(t, fixtureMode),
    sidecar: () => readFile(sidecarPath(configDir), 'utf8').then(JSON.parse),
    writeSidecar: async (settings, mtimeOffsetMs = 0) => {
      await writeFile(sidecarPath(configDir), JSON.stringify(settings));
      const when = new Date(Date.now() + mtimeOffsetMs);
      await utimes(sidecarPath(configDir), when, when);
    },
  };
}

test('status shape when the plugin loaded before the sidecar existed', async t => {
  const p = await activate(t);
  const { status, body: reported } = await p.call('GET', STATUS_URL);
  assert.equal(status, 200);
  const fingerprint = createHash('sha256').update(variables.GEMINI_API_KEY, 'utf8').digest('hex').slice(0, 10);
  assert.deepEqual(reported, { loaded: false, enabled: false, binary: null, binaryFound: false,
    version: null, lastError: null, apiKeyConfigured: true, apiKeyFingerprint: fingerprint });
  assert.ok(!('apiKey' in reported));
  assert.ok(!('models' in reported) && !('modelsSyncedAt' in reported));
  delete process.env.GEMINI_API_KEY;
  try {
    const withoutEnv = await p.call('GET', STATUS_URL);
    assert.equal(withoutEnv.body.apiKeyConfigured, false);
    assert.equal(withoutEnv.body.apiKeyFingerprint, null);
  } finally {
    process.env.GEMINI_API_KEY = variables.GEMINI_API_KEY;
  }
});

test('route guard rejects non-loopback sockets, foreign origins and unknown hosts', async t => {
  const p = await activate(t);
  for (const [method, url, request] of [
    ['GET', STATUS_URL, { ip: '10.1.2.3', headers: { host: '127.0.0.1:43781' } }],
    ['POST', CONNECT_URL, { headers: { host: '127.0.0.1:43781', origin: 'http://evil.example:43781' } }],
    ['POST', DISCONNECT_URL, { headers: { host: 'localhost:9999' } }],
    ['POST', SYNC_URL, { headers: { host: '127.0.0.1:43781', origin: 'ftp://127.0.0.1:43781' } }],
  ]) {
    const { status, body: reported } = await p.call(method, url, request);
    assert.equal(status, 403, `${method} ${url}`);
    assert.deepEqual(reported, { ok: false, success: false, error: 'agy_unauthorized' });
  }
  // An originless loopback request (local CLI) passes.
  const { status } = await p.call('GET', STATUS_URL, { headers: {} });
  assert.equal(status, 200);
});

test('connect happy path with a mock executable persists 0600 settings and loads the pool', async t => {
  const p = await activate(t, { fixtureMode: 'ok' });
  const { binary } = p.fixture;
  const { status, body: reported } = await p.call('POST', CONNECT_URL, { body: { binary } });
  assert.equal(status, 200);
  assert.equal(reported.ok, true);
  assert.equal(reported.enabled, true);
  assert.equal(reported.loaded, true);
  assert.equal(reported.version, '1.5.1');
  assert.equal(reported.binaryFound, true);
  assert.equal(reported.binary, binary);
  assert.ok(!('apiKey' in reported));
  assert.deepEqual(await p.sidecar(), { enabled: true, binary, authMethod: 'gemini-api-key', version: '1.5.1' });
  assert.equal((await stat(sidecarPath(p.configDir))).mode & 0o777, 0o600);
  assert.equal(p.transports.length, 1);
  assert.deepEqual(p.transports[0].options,
    { binary, authMethod: 'gemini-api-key', maxWorkers: 1, timeoutMs: 60000, log: p.transports[0].options.log });
  assert.equal(typeof p.transports[0].options.log.info, 'function');
  // Chat requests run against the freshly connected settings without a restart.
  await assert.doesNotReject(p.dispatch());
  const { body: statusBody } = await p.call('GET', STATUS_URL);
  assert.equal(statusBody.loaded, true);
  assert.equal(statusBody.lastError, null);
  // Connect always retires the live pool, even for unchanged settings, so a
  // rotated environment key is picked up on the next request.
  await p.call('POST', CONNECT_URL, { body: { binary } });
  assert.equal(p.transports.length, 2);
  assert.equal(p.transports[0].retired, 1);
  assert.equal(p.transports[1].retired, undefined);
});

test('connect with an apiKey reaches the transport and is never serialized into responses', async t => {
  const p = await activate(t, { fixtureMode: 'ok' });
  const { binary } = p.fixture;
  const { status, body: reported } = await p.call('POST', CONNECT_URL,
    { body: { binary, apiKey: 'sk-fixture-secret-1' } });
  assert.equal(status, 200);
  assert.equal(p.transports[0].options.apiKey, 'sk-fixture-secret-1');
  assert.equal((await stat(sidecarPath(p.configDir))).mode & 0o777, 0o600);
  assert.equal((await p.sidecar()).apiKey, 'sk-fixture-secret-1');
  assert.doesNotMatch(JSON.stringify(reported), /sk-fixture-secret-1/);
  const { body: statusBody } = await p.call('GET', STATUS_URL);
  assert.equal(statusBody.apiKeyConfigured, true);
  assert.doesNotMatch(JSON.stringify(statusBody), /sk-fixture-secret-1/);
  // A later failing connect keeps both the new and the stored key out of the envelope.
  const failed = await p.call('POST', CONNECT_URL,
    { body: { binary: '/nonexistent/agy', apiKey: 'sk-fixture-secret-2' } });
  assert.equal(failed.status, 400);
  assert.doesNotMatch(JSON.stringify(failed.body), /sk-fixture-secret-1|sk-fixture-secret-2/);
  assert.equal((await p.sidecar()).apiKey, 'sk-fixture-secret-1');
});

test('connect with a missing, relative or unsupported binary maps to a stable error and persists nothing', async t => {
  const p = await activate(t);
  const unsupported = await fixtureBinary(t, 'old');
  for (const [input, code, status] of [
    [{ binary: '/nonexistent/agy' }, 'acp_invalid_config', 400],
    [{ binary: 'agy' }, 'acp_invalid_config', 400],
    [{ binary: 42 }, 'acp_invalid_config', 400],
    [{}, 'acp_invalid_config', 400],
    [{ binary: unsupported.binary }, 'acp_unsupported_version', 502],
  ]) {
    const { status: got, body: reported } = await p.call('POST', CONNECT_URL, { body: input });
    assert.equal(got, status, JSON.stringify(input));
    assert.equal(reported.error, code);
    assert.equal(reported.ok, false);
    await assert.rejects(p.sidecar(), { code: 'ENOENT' });
    assert.equal(p.transports.length, 0);
  }
  const { body: statusBody } = await p.call('GET', STATUS_URL);
  assert.equal(statusBody.lastError.code, 'acp_unsupported_version');
  assert.equal(typeof statusBody.lastError.at, 'number');
});

test('disconnect persists enabled:false, retires the pool and keeps other settings', async t => {
  const p = await activate(t, { local: { enabled: true, binary: '/test/fixture', authMethod: 'gemini-api-key' } });
  assert.equal(p.transports.length, 1);
  const { status, body: reported } = await p.call('POST', DISCONNECT_URL, { body: {} });
  assert.equal(status, 200);
  assert.equal(reported.ok, true);
  assert.equal(reported.enabled, false);
  assert.equal(reported.loaded, false);
  const saved = await p.sidecar();
  assert.equal(saved.enabled, false);
  assert.equal(saved.binary, '/test/fixture');
  assert.equal(p.transports[0].retired, 1);
  await assert.rejects(p.dispatch(), { code: 'agy_disabled' });
});

test('settings edits apply to the next request without a gateway restart', async t => {
  const p = await activate(t);
  await assert.rejects(p.dispatch(), { code: 'agy_disabled' });
  assert.equal(p.transports.length, 0);

  const first = await fixtureBinary(t, 'ok');
  await p.writeSidecar({ enabled: true, binary: first.binary, authMethod: 'gemini-api-key' }, 1000);
  await assert.doesNotReject(p.dispatch());
  assert.equal(p.transports.length, 1);
  assert.equal(p.transports[0].options.binary, first.binary);

  const second = await fixtureBinary(t, 'ok');
  await p.writeSidecar({ enabled: true, binary: second.binary, authMethod: 'gemini-api-key' }, 2000);
  await assert.doesNotReject(p.dispatch());
  assert.equal(p.transports.length, 2);
  assert.equal(p.transports[1].options.binary, second.binary);
  assert.equal(p.transports[0].retired, 1);

  await p.writeSidecar({ enabled: false }, 3000);
  await assert.rejects(p.dispatch(), { code: 'agy_disabled' });
  assert.equal(p.transports[1].retired, 1);
});

test('model sync parses the fixture configOptions, persists the catalog and reaps its temp worker', async t => {
  const p = await activate(t, { fixtureMode: 'ok' });
  await p.call('POST', CONNECT_URL, { body: { binary: p.fixture.binary } });
  const { status, body: reported } = await p.call('POST', SYNC_URL, { body: {} });
  assert.equal(status, 200);
  assert.equal(reported.ok, true);
  assert.deepEqual(reported.models, [{ id: 'm2', name: 'Gemini Model' }, { id: 'default', name: 'Default' }]);
  assert.equal(typeof reported.modelsSyncedAt, 'number');
  assert.equal(reported.version, '1.5.1');
  const saved = await p.sidecar();
  assert.deepEqual(saved.models, reported.models);
  assert.equal(saved.modelsSyncedAt, reported.modelsSyncedAt);
  assert.doesNotMatch(JSON.stringify(reported), /fixture-value/);
  const { body: statusBody } = await p.call('GET', STATUS_URL);
  assert.deepEqual(statusBody.models, reported.models);
  assert.equal(statusBody.modelsSyncedAt, reported.modelsSyncedAt);
  // ONE temporary worker per sync: probe, spawn, handshake, session/new — no
  // session configuration or prompt traffic — and the worker is reaped
  // afterwards. The leading 'version' entry is connect's own binary probe.
  const events = await p.fixture.events();
  assert.deepEqual(events.map(record => record.event),
    ['version', 'version', 'spawn', 'initialize', 'authenticate', 'session/new']);
  const { root, pid } = events.find(record => record.root);
  await delay(50);
  await assert.rejects(stat(root), { code: 'ENOENT' });
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('model sync failures map to stable non-401 codes', async t => {
  const disabled = await activate(t);
  {
    const { status, body: reported } = await disabled.call('POST', SYNC_URL, { body: {} });
    assert.equal(status, 503);
    assert.equal(reported.error, 'agy_disabled');
  }

  delete process.env.GEMINI_API_KEY;
  try {
    const noKey = await activate(t);
    const fixture = await fixtureBinary(t, 'ok');
    await noKey.writeSidecar({ enabled: true, binary: fixture.binary, authMethod: 'gemini-api-key' }, 1000);
    const { status, body: reported } = await noKey.call('POST', SYNC_URL, { body: {} });
    assert.equal(status, 422); // never 401: the UI would treat it as a CCR logout
    assert.equal(reported.error, 'acp_auth_required');
  } finally {
    process.env.GEMINI_API_KEY = variables.GEMINI_API_KEY;
  }

  const wrong = await activate(t);
  const fixture = await fixtureBinary(t, 'wrong-category');
  await wrong.writeSidecar({ enabled: true, binary: fixture.binary, authMethod: 'gemini-api-key' }, 1000);
  const { status, body: reported } = await wrong.call('POST', SYNC_URL, { body: {} });
  assert.equal(status, 400);
  assert.equal(reported.error, 'acp_unsupported_option');
});

test('model sync registers discovered models on the provider entry and leaves Router untouched', async t => {
  const writes = [];
  const reloaded = [];
  const config = { Providers: [{ name, api_key: `ccr-managed-${name}`, models: ['stale-model'] }, { name: 'other', models: ['keep'] }],
    Router: { default: `${name},stale-model`, enableFallback: false } };
  const p = await activate(t, { fixtureMode: 'ok', host: {
    readConfig: async () => JSON.parse(JSON.stringify(config)),
    writeConfig: async next => { writes.push(next); },
    reloadRuntime: async next => { reloaded.push(next); },
  } });
  await p.call('POST', CONNECT_URL, { body: { binary: p.fixture.binary } });
  const { status, body: reported } = await p.call('POST', SYNC_URL, { body: {} });
  assert.equal(status, 200);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].Providers[0].models, reported.models.map(model => model.id));
  assert.deepEqual(writes[0].Providers[1].models, ['keep']);
  assert.deepEqual(writes[0].Router, config.Router);
  assert.equal(writes[0].Providers[0].api_key, `ccr-managed-${name}`);
  assert.equal(reloaded.length, 1);
  assert.equal(reloaded[0], writes[0]);
});

test('model sync creates a missing provider entry with the managed marker and skips no-op writes', async t => {
  const writes = [];
  const config = { Providers: [{ name: 'other', models: ['keep'] }], Router: { default: 'other,keep' } };
  const p = await activate(t, { fixtureMode: 'ok', host: {
    readConfig: async () => JSON.parse(JSON.stringify(config)),
    writeConfig: async next => { writes.push(next); },
  } });
  await p.call('POST', CONNECT_URL, { body: { binary: p.fixture.binary } });
  const { status, body: reported } = await p.call('POST', SYNC_URL, { body: {} });
  assert.equal(status, 200);
  assert.equal(writes.length, 1);
  const created = writes[0].Providers.find(entry => entry.name === name);
  assert.ok(created, 'provider entry created');
  assert.equal(created.api_key, `ccr-managed-${name}`);
  assert.deepEqual(created.models, reported.models.map(model => model.id));
  assert.equal(created.api_base_url, 'https://example.com/unused');
  assert.deepEqual(created.transformer, { use: [name] });
  assert.deepEqual(writes[0].Providers.filter(entry => entry.name === 'other'), [{ name: 'other', models: ['keep'] }]);
  assert.deepEqual(writes[0].Router, config.Router);
  // A second sync over an already-correct entry performs no write at all.
  const stable = { ...config, Providers: [created, ...config.Providers] };
  const quiet = await activate(t, { fixtureMode: 'ok', host: {
    readConfig: async () => JSON.parse(JSON.stringify(stable)),
    writeConfig: async () => { throw Error('must not write'); },
  } });
  await quiet.call('POST', CONNECT_URL, { body: { binary: quiet.fixture.binary } });
  const again = await quiet.call('POST', SYNC_URL, { body: {} });
  assert.equal(again.status, 200);
});

test('model sync rolls back the provider entry when the config write fails', async t => {
  const config = { Providers: [{ name, models: ['stale-model'] }], Router: { default: `${name},stale-model` } };
  let writes = 0;
  const p = await activate(t, { fixtureMode: 'ok', host: {
    readConfig: async () => JSON.parse(JSON.stringify(config)),
    writeConfig: async () => { writes += 1; if (writes === 1) throw Error('disk full'); },
  } });
  await p.call('POST', CONNECT_URL, { body: { binary: p.fixture.binary } });
  const { status, body: reported } = await p.call('POST', SYNC_URL, { body: {} });
  assert.equal(status, 500);
  assert.equal(reported.error, 'agy_config_write_failed');
  assert.ok(writes >= 2, 'rollback write attempted after the failed write');
  const saved = await p.sidecar();
  assert.deepEqual(saved.models.map(model => model.id), ['m2', 'default'], 'sidecar keeps synced models for the next attempt');
});

test('admin routes answer a constant 503 envelope while no service is wired', async () => {
  const { app, call } = stubApp();
  registerAdminRoutes(app, { getService: () => undefined });
  for (const [method, url] of [['GET', STATUS_URL], ['POST', CONNECT_URL], ['POST', DISCONNECT_URL], ['POST', SYNC_URL]]) {
    const { status, body: reported } = await call(method, url, { body: {} });
    assert.equal(status, 503);
    assert.deepEqual(reported, { ok: false, success: false, error: 'agy_route_failed' });
  }
});
