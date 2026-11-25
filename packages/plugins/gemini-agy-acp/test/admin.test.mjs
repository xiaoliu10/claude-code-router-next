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
const VISIBILITY_URL = `/api/${name}/models/visibility`;
const INSTALL_URL = `/api/${name}/install`;

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
async function fixtureBinary(t, mode = 'ok', authMethod = 'gemini-api-key') {
  const dir = await mkdtemp(join(tmpdir(), 'agy-admin-fixture-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binary = join(dir, 'fixture.mjs');
  const source = await readFile(new URL('./fixtures/agy-acp.mjs', import.meta.url), 'utf8');
  await writeFile(binary, `#!${process.execPath}\n${source}`, { mode: 0o700 });
  await writeFile(join(dir, 'mode'), mode);
  await writeFile(join(dir, 'authMethod'), authMethod);
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

async function activate(t, { local, fixtureMode, fixtureAuth, host, installer, preparePool } = {}) {
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
    await preparePool?.(options);
    const transport = {
      options,
      run: async () => ({ stopReason: 'end_turn' }),
      close: async () => { transport.closed = true; },
      retireExisting: async () => { transport.retired = (transport.retired ?? 0) + 1; },
    };
    transports.push(transport);
    return transport;
  }, { installer: installer ?? {
    // Default stub: no test may reach the network; the target path is absent
    // so detectedBinary stays null unless a test installs a real fixture.
    install: async () => { throw new Error('unexpected install in test'); },
    targetBinary: join(configDir, 'absent-agy'),
  } });
  assert.equal(registrars.length, 1);
  const { app, call } = stubApp();
  registrars[0](app);
  return {
    call,
    configDir,
    dispatch: (req = {}) => runtime.dispatchRequest({ requestBody: body, req: { body, ...req }, config: {}, provider }),
    transports,
    fixture: fixtureMode === undefined ? undefined : await fixtureBinary(t, fixtureMode, fixtureAuth),
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
    detectedBinary: null, installing: false, installError: null,
    version: null, lastError: null, authMethod: null, apiKeyConfigured: true, apiKeyFingerprint: fingerprint,
    hiddenModels: [] });
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
    ['POST', VISIBILITY_URL, { headers: { host: 'localhost:9999' } }],
    ['POST', INSTALL_URL, { ip: '10.1.2.3', headers: { host: '127.0.0.1:43781' } }],
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
    { binary, authMethod: 'gemini-api-key', maxWorkers: 4, timeoutMs: 60000, log: p.transports[0].options.log });
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
  // The fingerprint is derived from the stored sidecar key, never the env.
  assert.equal(statusBody.apiKeyFingerprint,
    createHash('sha256').update('sk-fixture-secret-1', 'utf8').digest('hex').slice(0, 10));
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

test('oauth-personal connect verifies the real handshake, persists no key and syncs without one', async t => {
  const p = await activate(t, { fixtureMode: 'ok', fixtureAuth: 'oauth-personal' });
  const { binary } = p.fixture;
  // An apiKey alongside oauth-personal is rejected before anything is probed.
  const keyed = await p.call('POST', CONNECT_URL, { body: { binary, authMethod: 'oauth-personal', apiKey: 'sk-fixture-secret' } });
  assert.equal(keyed.status, 400);
  assert.equal(keyed.body.error, 'acp_invalid_config');
  assert.equal(p.transports.length, 0);
  const { status, body: reported } = await p.call('POST', CONNECT_URL, { body: { binary, authMethod: 'oauth-personal' } });
  assert.equal(status, 200);
  assert.equal(reported.ok, true);
  assert.equal(reported.enabled, true);
  assert.equal(reported.loaded, true);
  assert.equal(reported.authMethod, 'oauth-personal');
  assert.equal(reported.accountEmail, 'metadata-account@example.com');
  assert.equal(reported.apiKeyFingerprint, null);
  assert.equal(reported.apiKeyConfigured, false);
  assert.doesNotMatch(JSON.stringify(reported), /fixture-value|fixture-secret/);
  // The stored apiKey of a previous gemini connect is evicted; no key ever
  // persists in oauth mode.
  const saved = await p.sidecar();
  assert.deepEqual(saved, { enabled: true, binary, authMethod: 'oauth-personal', version: '1.5.1',
    accountEmail: 'metadata-account@example.com' });
  assert.ok(!('apiKey' in saved));
  assert.equal((await stat(sidecarPath(p.configDir))).mode & 0o777, 0o600);
  assert.deepEqual(p.transports[0].options,
    { binary, authMethod: 'oauth-personal', maxWorkers: 4, timeoutMs: 60000, log: p.transports[0].options.log });
  assert.equal('apiKey' in p.transports[0].options, false);
  assert.doesNotReject(p.dispatch());
  // Model sync runs without any credential: the worker authenticates the
  // CLI's own login.
  const sync = await p.call('POST', SYNC_URL, { body: {} });
  assert.equal(sync.status, 200);
  assert.deepEqual(sync.body.models, [{ id: 'm2', name: 'Gemini Model' }, { id: 'default', name: 'Default' }]);
  // Connect: isolated --version probe, then the REAL oauth handshake worker
  // (probe, spawn, initialize, authenticate, session/new). Sync repeats the
  // same bounded temporary worker sequence.
  const events = await p.fixture.events();
  assert.deepEqual(events.map(record => record.event),
    ['version', 'version', 'spawn', 'initialize', 'authenticate', 'session/new',
     'version', 'spawn', 'initialize', 'authenticate', 'session/new']);
  assert.ok(events.every(record => record.root === undefined), 'no isolated root in oauth mode');
});

test('oauth-personal connect maps a failed handshake to auth_required and persists nothing', async t => {
  const p = await activate(t, { fixtureMode: 'auth-failure', fixtureAuth: 'oauth-personal' });
  const { status, body: reported } = await p.call('POST', CONNECT_URL,
    { body: { binary: p.fixture.binary, authMethod: 'oauth-personal' } });
  // Never 401 (the UI would treat it as a CCR logout) and never the fixture's
  // stderr diagnostic.
  assert.equal(status, 422);
  assert.equal(reported.error, 'acp_auth_required');
  assert.doesNotMatch(JSON.stringify(reported), /fixture-secret-diagnostic/);
  await assert.rejects(p.sidecar(), { code: 'ENOENT' });
  assert.equal(p.transports.length, 0);
  const { body: statusBody } = await p.call('GET', STATUS_URL);
  assert.equal(statusBody.lastError.code, 'acp_auth_required');
});

test('OAuth connect preserves saved credentials if validation or pool preparation fails', async t => {
  for (const maxWorkers of [0, 1]) {
    const p = await activate(t, { fixtureMode: 'ok', fixtureAuth: 'oauth-personal',
      preparePool: () => { throw new Error('fixture pool error'); } });
    const saved = { enabled: true, binary: p.fixture.binary, authMethod: 'gemini-api-key',
      apiKey: 'fixture-value', maxWorkers };
    await p.writeSidecar(saved);
    const response = await p.call('POST', CONNECT_URL,
      { body: { authMethod: 'oauth-personal' } });
    assert.ok(response.status >= 400);
    assert.deepEqual(await p.sidecar(), saved);
  }
});

test('oauth-personal connect evicts a stored gemini apiKey; gemini connect clears the stale account', async t => {
  const oauth = await activate(t, { fixtureMode: 'ok', fixtureAuth: 'oauth-personal' });
  await oauth.writeSidecar({ enabled: true, binary: oauth.fixture.binary, authMethod: 'gemini-api-key',
    apiKey: 'sk-stored-secret' }, 1000);
  const switched = await oauth.call('POST', CONNECT_URL,
    { body: { binary: oauth.fixture.binary, authMethod: 'oauth-personal' } });
  assert.equal(switched.status, 200);
  const saved = await oauth.sidecar();
  assert.equal(saved.authMethod, 'oauth-personal');
  assert.ok(!('apiKey' in saved), 'stored gemini apiKey evicted on oauth connect');
  const oauthStatus = switched.body;
  assert.equal(oauthStatus.authMethod, 'oauth-personal');
  assert.equal(oauthStatus.apiKeyFingerprint, null);
  assert.equal(oauthStatus.apiKeyConfigured, false);

  const gemini = await activate(t, { fixtureMode: 'ok' });
  await gemini.writeSidecar({ enabled: false, binary: gemini.fixture.binary, authMethod: 'oauth-personal',
    version: '1.5.1', accountEmail: 'stale@example.com' }, 1000);
  const back = await gemini.call('POST', CONNECT_URL,
    { body: { binary: gemini.fixture.binary, apiKey: 'sk-next-secret' } });
  assert.equal(back.status, 200);
  const geminiSaved = await gemini.sidecar();
  assert.equal(geminiSaved.authMethod, 'gemini-api-key');
  assert.equal(geminiSaved.apiKey, 'sk-next-secret');
  assert.ok(!('accountEmail' in geminiSaved), 'stale oauth account email cleared on gemini connect');
  assert.equal(back.body.authMethod, 'gemini-api-key');
  assert.equal('accountEmail' in back.body, false);
  assert.equal(back.body.apiKeyFingerprint,
    createHash('sha256').update('sk-next-secret', 'utf8').digest('hex').slice(0, 10));
  // An unknown authMethod value is rejected like every other malformed input.
  const invalid = await gemini.call('POST', CONNECT_URL,
    { body: { binary: gemini.fixture.binary, authMethod: 'consumer-login' } });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error, 'acp_invalid_config');
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
  const writes = [];
  const p = await activate(t, { fixtureMode: 'ok', host: {
    readConfig: async () => config,
    writeConfig: async next => { writes.push(next); if (writes.length === 1) throw Error('disk full'); },
  } });
  await p.call('POST', CONNECT_URL, { body: { binary: p.fixture.binary } });
  const { status, body: reported } = await p.call('POST', SYNC_URL, { body: {} });
  assert.equal(status, 500);
  assert.equal(reported.error, 'agy_config_write_failed');
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0].Providers[0].models, ['m2', 'default']);
  assert.deepEqual(writes[1].Providers[0].models, ['stale-model']);
  assert.equal((await p.sidecar()).models, undefined);
});

const providerModels = (writes) => writes.at(-1)?.Providers.find(entry => entry.name === name)?.models;

test('model visibility validates ids, persists the hide set and re-registers only visible models', async t => {
  const writes = [];
  const reloaded = [];
  let stored = { Providers: [{ name: 'other', models: ['keep'] }], Router: { default: 'other,keep' } };
  const p = await activate(t, { fixtureMode: 'ok', host: {
    readConfig: async () => JSON.parse(JSON.stringify(stored)),
    writeConfig: async next => { writes.push(next); stored = next; },
    reloadRuntime: async next => { reloaded.push(next); },
  } });
  await p.call('POST', CONNECT_URL, { body: { binary: p.fixture.binary } });
  // Without a synced catalog every request fails closed before persisting.
  for (const input of [{}, { hide: ['m2'] }, { restore: ['m2'] }]) {
    const early = await p.call('POST', VISIBILITY_URL, { body: input });
    assert.equal(early.status, 400, JSON.stringify(input));
    assert.equal(early.body.error, 'acp_unsupported_option');
  }
  assert.equal((await p.sidecar()).hiddenModels, undefined);
  const { body: synced } = await p.call('POST', SYNC_URL, { body: {} });
  assert.deepEqual(synced.models.map(model => model.id), ['m2', 'default']);
  assert.equal(writes.length, 1);
  assert.deepEqual(providerModels(writes), ['m2', 'default']);

  // Unknown ids, malformed shapes and non-object bodies are all rejected.
  for (const input of [{ hide: ['gone'] }, { restore: ['gone'] }, { hide: 'm2' }, { restore: 'm2' },
    { hide: [42] }, { hide: ['m2'], restore: ['gone'] }, 'nope', null, ['m2']]) {
    const rejection = await p.call('POST', VISIBILITY_URL, { body: input });
    assert.equal(rejection.status, 400, JSON.stringify(input));
    assert.deepEqual(rejection.body, { ok: false, success: false, error: 'acp_unsupported_option' });
  }
  // The rejections above persisted nothing: the sidecar still holds only the
  // empty hide set written by the sync itself.
  assert.deepEqual((await p.sidecar()).hiddenModels, []);

  // Hiding persists and the provider entry stops advertising hidden models.
  const hidden = await p.call('POST', VISIBILITY_URL, { body: { hide: ['m2'] } });
  assert.equal(hidden.status, 200);
  assert.equal(hidden.body.ok, true);
  assert.deepEqual(hidden.body.hiddenModels, ['m2']);
  assert.deepEqual(hidden.body.models.map(model => model.id), ['m2', 'default']);
  assert.deepEqual((await p.sidecar()).hiddenModels, ['m2']);
  assert.deepEqual(providerModels(writes), ['default']);
  assert.equal(reloaded.length, 2);

  // hide wins for ids present in both lists.
  const conflict = await p.call('POST', VISIBILITY_URL, { body: { hide: ['default'], restore: ['default'] } });
  assert.deepEqual(conflict.body.hiddenModels, ['m2', 'default']);
  assert.deepEqual(providerModels(writes), []);

  // Restoring one model re-registers it and keeps the other hidden.
  const restore = await p.call('POST', VISIBILITY_URL, { body: { restore: ['default'] } });
  assert.deepEqual(restore.body.hiddenModels, ['m2']);
  assert.deepEqual(providerModels(writes), ['default']);

  // Re-sync keeps the hide set and registers visible models only (already
  // registered → the write is skipped entirely).
  const writesAfterRestore = writes.length;
  const reloadsAfterRestore = reloaded.length;
  const again = await p.call('POST', SYNC_URL, { body: {} });
  assert.equal(again.status, 200);
  assert.deepEqual((await p.sidecar()).hiddenModels, ['m2']);
  assert.equal(writes.length, writesAfterRestore);
  assert.equal(reloaded.length, reloadsAfterRestore);
  const { body: statusBody } = await p.call('GET', STATUS_URL);
  assert.deepEqual(statusBody.models.map(model => model.id), ['m2', 'default']);
  assert.deepEqual(statusBody.hiddenModels, ['m2']);

  // A model that disappears upstream is dropped from the hide set silently.
  await p.writeSidecar({ ...(await p.sidecar()), models: [{ id: 'gone', name: 'Gone' }, { id: 'default', name: 'Default' }],
    hiddenModels: ['m2', 'gone'] }, 5000);
  const pruned = await p.call('POST', SYNC_URL, { body: {} });
  assert.equal(pruned.status, 200);
  assert.deepEqual((await p.sidecar()).hiddenModels, ['m2']);
  assert.deepEqual(providerModels(writes), ['default']);
});

test('concurrent sync and visibility changes preserve both hidden models', async t => {
  let stored = { Providers: [{ name, models: ['m2', 'default'] }] };
  const p = await activate(t, { fixtureMode: 'ok', host: {
    readConfig: async () => stored,
    writeConfig: async next => { stored = next; },
  } });
  await p.writeSidecar({ enabled: true, binary: p.fixture.binary, authMethod: 'gemini-api-key',
    models: [{ id: 'm2', name: 'Gemini Model' }, { id: 'default', name: 'Default' }] });
  const sync = p.call('POST', SYNC_URL, { body: {} });
  const results = await Promise.all([sync,
    p.call('POST', VISIBILITY_URL, { body: { hide: ['m2'] } }),
    p.call('POST', VISIBILITY_URL, { body: { hide: ['default'] } }),
  ]);
  assert.deepEqual(results.map(result => result.status), [200, 200, 200]);
  assert.deepEqual((await p.sidecar()).hiddenModels, ['m2', 'default']);
  assert.deepEqual(stored.Providers[0].models, []);
});

test('model visibility preserves prior state when provider registration fails', async t => {
  let writes = 0;
  const p = await activate(t, { fixtureMode: 'ok', host: {
    readConfig: async () => ({ Providers: [{ name, models: ['m2', 'default'] }] }),
    writeConfig: async () => { writes += 1; throw Error('disk full'); },
  } });
  await p.writeSidecar({ enabled: true, binary: p.fixture.binary, authMethod: 'gemini-api-key',
    models: [{ id: 'm2', name: 'Gemini Model' }, { id: 'default', name: 'Default' }], modelsSyncedAt: 1, version: '1.5.1' }, 1000);
  const failure = await p.call('POST', VISIBILITY_URL, { body: { hide: ['m2'] } });
  assert.equal(failure.status, 500);
  assert.equal(failure.body.error, 'agy_config_write_failed');
  assert.ok(writes >= 2, 'rollback write attempted after the failed write');
  assert.equal((await p.sidecar()).hiddenModels, undefined);
  const retried = await activate(t, { fixtureMode: 'ok', host: {
    readConfig: async () => ({ Providers: [{ name, models: ['m2', 'default'] }] }),
    writeConfig: async () => {},
  } });
  await retried.writeSidecar({ enabled: true, binary: retried.fixture.binary, authMethod: 'gemini-api-key',
    models: [{ id: 'm2', name: 'Gemini Model' }, { id: 'default', name: 'Default' }], modelsSyncedAt: 1, version: '1.5.1',
    hiddenModels: ['m2'] }, 1000);
  const recovered = await retried.call('POST', SYNC_URL, { body: {} });
  assert.equal(recovered.status, 200);
  assert.deepEqual((await retried.sidecar()).hiddenModels, ['m2'], 'sync keeps the persisted hide set across re-registration');
});

test('admin routes answer a constant 503 envelope while no service is wired', async () => {
  const { app, call } = stubApp();
  registerAdminRoutes(app, { getService: () => undefined });
  for (const [method, url] of [['GET', STATUS_URL], ['POST', CONNECT_URL], ['POST', DISCONNECT_URL], ['POST', SYNC_URL],
    ['POST', VISIBILITY_URL]]) {
    const { status, body: reported } = await call(method, url, { body: {} });
    assert.equal(status, 503);
    assert.deepEqual(reported, { ok: false, success: false, error: 'agy_route_failed' });
  }
});

test('first local model use shares one install with the card and still requires connect', async t => {
  const client = { raw: { socket: { remoteAddress: '::1', localPort: 43781 } }, headers: { host: 'localhost:43781' } };
  let finish;
  const dir = await mkdtemp(join(tmpdir(), 'agy-first-use-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binary = join(dir, 'agy.exe');
  const install = t.mock.fn(() => new Promise(resolve => { finish = resolve; }));
  const p = await activate(t, { installer: { targetBinary: binary, install } });
  const previousOptIn = process.env.CCR_AGY_INSTALL_ON_USE;
  t.after(() => {
    if (previousOptIn === undefined) delete process.env.CCR_AGY_INSTALL_ON_USE;
    else process.env.CCR_AGY_INSTALL_ON_USE = previousOptIn;
  });
  delete process.env.CCR_AGY_INSTALL_ON_USE;
  await assert.rejects(p.dispatch(client), { code: 'agy_disabled' });
  process.env.CCR_AGY_INSTALL_ON_USE = '1';
  for (const req of [{}, { ...client, headers: { ...client.headers, forwarded: 'for=external' } }, { ...client, raw: { socket: { remoteAddress: 'not-loopback', localPort: 43781 } } },
    { ...client, headers: { host: 'example.com:43781' } },
    { ...client, headers: { ...client.headers, origin: 'https://example.com' } }]) {
    await assert.rejects(p.dispatch(req), { code: 'agy_disabled' });
  }
  assert.equal(install.mock.callCount(), 0);
  await Promise.all([p.dispatch(client), p.dispatch(client)].map(result => assert.rejects(result, { code: 'agy_install_in_progress' })));
  await p.call('POST', INSTALL_URL, { body: {} });
  assert.equal(install.mock.callCount(), 1);
  await writeFile(binary, 'fixture');
  finish({ binary });
  await delay(0);
  await assert.rejects(p.dispatch(client), { code: 'agy_connect_required' });
  await assert.rejects(p.sidecar(), { code: 'ENOENT' });
  await p.writeSidecar({ enabled: false });
  await assert.rejects(p.dispatch(client), { code: 'agy_disabled' });
  assert.equal(install.mock.callCount(), 1);
});

test('install kicks off the single-flight background installer and never touches the sidecar', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'agy-installed-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const placed = join(dir, 'agy');
  let resolveInstall;
  let starts = 0;
  const installer = {
    targetBinary: placed,
    install: () => { starts += 1; return new Promise(resolve => { resolveInstall = resolve; }); },
  };
  const p = await activate(t, { installer });
  const first = await p.call('POST', INSTALL_URL, { body: {} });
  assert.equal(first.status, 200);
  assert.equal(first.body.installing, true);
  assert.equal(starts, 1);
  // Single-flight: a second kick while running starts no second download.
  const second = await p.call('POST', INSTALL_URL, { body: {} });
  assert.equal(second.body.installing, true);
  assert.equal(starts, 1);
  const mid = await p.call('GET', STATUS_URL);
  assert.equal(mid.body.installing, true);
  assert.equal(mid.body.detectedBinary, null); // nothing placed yet
  // The installer finishes: the binary appears at the official target path.
  await writeFile(placed, 'fixture agy');
  resolveInstall({ version: '1.5.14', binary: placed });
  await delay(20);
  const done = await p.call('GET', STATUS_URL);
  assert.equal(done.body.installing, false);
  assert.equal(done.body.installError, null);
  assert.equal(done.body.detectedBinary, placed);
  // Connect remains the only action that persists settings / enables.
  assert.equal(done.body.binary, null);
  assert.equal(done.body.enabled, false);
  await assert.rejects(readFile(sidecarPath(p.configDir)), { code: 'ENOENT' });
});

test('a failed install surfaces a stable code, never the raw message, and retries only explicitly', async t => {
  let calls = 0;
  const installer = {
    targetBinary: join(tmpdir(), 'agy-absent-target'),
    install: async () => {
      calls += 1;
      throw Object.assign(new Error('secret upstream detail'), { code: 'agy_install_download_failed' });
    },
  };
  const p = await activate(t, { installer });
  const kicked = await p.call('POST', INSTALL_URL, { body: {} });
  assert.equal(kicked.status, 200);
  await delay(20);
  const done = await p.call('GET', STATUS_URL);
  assert.equal(done.body.installing, false);
  assert.equal(done.body.installError.code, 'agy_install_download_failed');
  assert.doesNotMatch(JSON.stringify(done.body), /secret upstream detail/);
  // Status reads never retry: only an explicit POST starts another attempt.
  await p.call('GET', STATUS_URL);
  assert.equal(calls, 1);
  await p.call('POST', INSTALL_URL, { body: {} });
  await delay(20);
  assert.equal(calls, 2);
  // An unknown error collapses to the constant safe token.
  const plain = await activate(t, { installer: {
    targetBinary: join(tmpdir(), 'agy-absent-target-2'),
    install: async () => { throw new Error('raw internals'); },
  } });
  await plain.call('POST', INSTALL_URL, { body: {} });
  await delay(20);
  const collapsed = await plain.call('GET', STATUS_URL);
  assert.equal(collapsed.body.installError.code, 'agy_route_error');
  assert.doesNotMatch(JSON.stringify(collapsed.body), /raw internals/);
});
