// Coding Plan quota credentials: pure controller logic + dependency-free DOM
// interaction tests (panel open/close, save IPC args, explicit clear, the
// unconfigured note, and XSS-safe provider names).
// Run: node --test apps/desktop/tests/credentials-interactions.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { harness } from './control-center-interactions.test.mjs';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const VOLC = '火山agent plan';

// ---------------- pure controller logic (no DOM) ----------------

const code = readFileSync(new URL('../src/quota.js', import.meta.url), 'utf8');
const sandbox = {};
vm.createContext(sandbox);
new vm.Script(code, { filename: 'quota.js' }).runInContext(sandbox);
const Q = sandbox.QuotaUI;
const plain = v => JSON.parse(JSON.stringify(v));

function fakeInvoke() {
  const calls = [];
  const pending = new Map();
  const fn = (cmd, args) => {
    calls.push({ cmd, args });
    return new Promise((resolve, reject) => { pending.set(calls.length - 1, { resolve, reject }); });
  };
  return { fn, calls, resolve: (i, v) => pending.get(i).resolve(v), reject: (i, e) => pending.get(i).reject(e) };
}
const status = (providers) => ({ providers });

test('credentials normalize: whitelists {name, configured}, dedupes, drops secret-like fields', () => {
  const s = Q.normalizeCredentialsStatus({
    providers: [
      { name: 'volc', configured: true, accessKey: 'AK', secretKey: 'SK', apiKey: 'x' },
      { name: 'volc', configured: false },
      { name: 'partial', configured: 'yes' },
      { name: '', configured: true },
      null,
    ],
    accessKey: 'LEAK',
  });
  assert.deepEqual(plain(s), { providers: [{ name: 'volc', configured: true }, { name: 'partial', configured: false }] });
  assert.equal(JSON.stringify(s).includes('LEAK'), false);
  assert.deepEqual(plain(Q.normalizeCredentialsStatus(null)), { providers: [] });
});

test('credentials controller: open requires a known provider; blank save never calls IPC', async () => {
  const ipc = fakeInvoke();
  const c = Q.createCredentialsController({ invoke: ipc.fn });
  c.refresh(); await flush();
  ipc.resolve(0, status([{ name: 'volc', configured: true }])); await flush();
  assert.equal(c.open('unknown'), false);
  assert.equal(c.open('volc'), true);
  assert.equal(c.state().openName, 'volc');
  assert.equal(c.save('volc', { accessKey: '  ', secretKey: '' }), false);
  assert.match(c.state().saveError, /留空表示不修改/);
  assert.equal(ipc.calls.filter(x => x.cmd === 'quota_credentials_save').length, 0);
  assert.equal(c.close(), true);
  assert.equal(c.state().openName, null);
  assert.throws(() => Q.createCredentialsController({}));
});

test('credentials controller: save trims, omits blank fields, and adopts the returned status', async () => {
  const ipc = fakeInvoke();
  const c = Q.createCredentialsController({ invoke: ipc.fn });
  c.refresh(); await flush();
  ipc.resolve(0, status([{ name: 'volc', configured: false }])); await flush();
  c.open('volc');
  assert.equal(c.save('volc', { accessKey: ' AK ', secretKey: '' }), true);
  const call = ipc.calls.find(x => x.cmd === 'quota_credentials_save');
  assert.deepEqual(plain(call.args), { name: 'volc', accessKey: 'AK' });
  ipc.resolve(1, status([{ name: 'volc', configured: false }])); await flush();
  assert.equal(c.state().saving, false);
  assert.equal(c.state().savedFlash.name, 'volc');
  assert.equal(c.state().savedFlash.cleared, false);
  assert.equal(c.configured('volc'), false, 'one field alone is not configured');
});

test('credentials controller: clear requires configured and sends empty strings; removal closes the panel', async () => {
  const ipc = fakeInvoke();
  const c = Q.createCredentialsController({ invoke: ipc.fn });
  c.refresh(); await flush();
  ipc.resolve(0, status([{ name: 'volc', configured: false }])); await flush();
  c.open('volc');
  assert.equal(c.clear('volc'), false, 'cannot clear what is not configured');
  c.refresh(); await flush();
  ipc.resolve(1, status([{ name: 'volc', configured: true }])); await flush();
  assert.equal(c.clear('volc'), true);
  const call = ipc.calls.filter(x => x.cmd === 'quota_credentials_save').at(-1);
  assert.deepEqual(plain(call.args), { name: 'volc', accessKey: '', secretKey: '' });
  ipc.resolve(2, status([{ name: 'volc', configured: false }])); await flush();
  assert.equal(c.state().savedFlash.cleared, true);
  assert.equal(c.configured('volc'), false);
  c.refresh(); await flush();
  ipc.resolve(3, status([])); await flush();
  assert.equal(c.state().openName, null, 'a provider removed by a later status closes its panel');
});

test('credentials controller: failed save keeps the panel open and surfaces the error', async () => {
  const ipc = fakeInvoke();
  const c = Q.createCredentialsController({ invoke: ipc.fn });
  c.refresh(); await flush();
  ipc.resolve(0, status([{ name: 'volc', configured: false }])); await flush();
  c.open('volc');
  c.save('volc', { accessKey: 'AK', secretKey: 'SK' });
  ipc.reject(1, new Error('网关离线')); await flush();
  assert.equal(c.state().openName, 'volc');
  assert.equal(c.state().saveError, '网关离线');
  assert.equal(c.state().savedFlash, null);
  assert.equal(c.state().saving, false);
});

// ---------------- DOM interactions ----------------

function fixture(configured = false, name = VOLC) {
  const keys = { accessKey: configured ? 'SAVED_AK' : '', secretKey: configured ? 'SAVED_SK' : '' };
  const state = { providers: [{ name, configured }] };
  const responses = {
    quota_snapshot: () => ({
      providers: [
        { name, enabled: true, plan: null, status: 'unavailable', message: '未提供可用额度数据（来源未声明查询能力）', windows: [], updatedAt: null },
        { name: 'plain.example.com', enabled: true, plan: null, status: 'ready', message: null, windows: [], updatedAt: 1 },
      ],
      online: true, error: null, updatedAt: 1,
    }),
    quota_credentials_status: () => structuredClone(state),
    quota_credentials_save: args => {
      const entry = state.providers.find(p => p.name === args.name);
      if (!entry) throw new Error('unknown provider');
      if (typeof args.accessKey === 'string') keys.accessKey = args.accessKey.trim();
      if (typeof args.secretKey === 'string') keys.secretKey = args.secretKey.trim();
      entry.configured = !!(keys.accessKey && keys.secretKey);
      return structuredClone(state);
    },
  };
  return { responses, state, keys };
}

async function start(configured = false, name = VOLC, extra = {}) {
  const f = fixture(configured, name);
  const h = harness({ ...f.responses, ...extra });
  await flush();
  const card = h.id('list').querySelectorAll('.card').find(n => n.dataset.provider === name);
  assert.ok(card, 'matching card rendered');
  return { h, f, card };
}
const panelOf = card => card.querySelector('.creds-panel');
const buttonOf = (card, attr) => card.querySelectorAll('button').find(n => n.getAttribute(attr) !== null);
const inputsOf = card => panelOf(card).querySelectorAll('input');
const saveCalls = h => h.calls.filter(c => c.cmd === 'quota_credentials_save');

test('credentials interaction: only matching cards get the button and unconfigured note; open/close sends no mutation', async () => {
  const { h, card } = await start();
  const plainCard = h.id('list').querySelectorAll('.card').find(n => n.dataset.provider === 'plain.example.com');
  assert.equal(buttonOf(plainCard, 'data-creds-open').hidden, true);
  assert.equal(plainCard.querySelector('.card-creds-note').hidden, true);
  const open = buttonOf(card, 'data-creds-open');
  assert.equal(open.hidden, false);
  assert.equal(open.textContent, '用量凭证');
  const note = card.querySelector('.card-creds-note');
  assert.equal(note.hidden, false);
  assert.match(note.textContent, /未配置 AK\/SK，无法查询套餐用量/);
  assert.equal(panelOf(card).hidden, true);
  open.click(); await flush();
  assert.equal(panelOf(card).hidden, false);
  const inputs = inputsOf(card);
  assert.equal(inputs.length, 2);
  assert.deepEqual(plain(inputs.map(n => n.type)), ['password', 'password']);
  assert.deepEqual(plain(inputs.map(n => n.getAttribute('aria-label'))), ['AccessKey ID', 'Secret AccessKey']);
  assert.deepEqual(plain(inputs.map(n => n.value)), ['', '']);
  assert.match(inputs[0].placeholder, /输入 AccessKey ID/);
  assert.equal(saveCalls(h).length, 0);
  buttonOf(card, 'data-creds-cancel').click(); await flush();
  assert.equal(panelOf(card).hidden, true);
  assert.equal(saveCalls(h).length, 0);
});

test('credentials interaction: save sends trimmed args once, clears inputs, flips note/placeholder and flashes', async () => {
  const { h, card } = await start();
  buttonOf(card, 'data-creds-open').click(); await flush();
  const [ak, sk] = inputsOf(card);
  ak.value = '  AK123  '; sk.value = ' SK456 ';
  buttonOf(card, 'data-creds-save').click(); await flush();
  const calls = saveCalls(h);
  assert.equal(calls.length, 1);
  assert.deepEqual(plain(calls[0].args), { name: VOLC, accessKey: 'AK123', secretKey: 'SK456' });
  assert.deepEqual(plain(inputsOf(card).map(n => n.value)), ['', ''], 'secrets are never kept in the inputs after save');
  assert.equal(card.querySelector('.card-creds-note').hidden, true);
  assert.match(panelOf(card).querySelector('.creds-msg').textContent, /已保存/);
  assert.deepEqual(plain(inputsOf(card).map(n => n.placeholder)), ['已保存，留空则不修改', '已保存，留空则不修改']);
  assert.equal(buttonOf(card, 'data-creds-clear').hidden, false);
  assert.equal(JSON.stringify(h.calls).includes('SK456'), true, 'submitted values only appear in the request args');
  assert.equal(panelOf(card).textContent.includes('SK456'), false, 'secret never rendered');
});

test('credentials interaction: configured blank save is a no-op with guidance; partial input sends only that field', async () => {
  const { h, card } = await start(true);
  assert.equal(card.querySelector('.card-creds-note').hidden, true);
  buttonOf(card, 'data-creds-open').click(); await flush();
  assert.deepEqual(plain(inputsOf(card).map(n => n.value)), ['', ''], 'saved secrets are never echoed');
  buttonOf(card, 'data-creds-save').click(); await flush();
  assert.equal(saveCalls(h).length, 0);
  assert.match(panelOf(card).querySelector('.creds-msg').textContent, /留空表示不修改/);
  const [ak, sk] = inputsOf(card);
  sk.value = 'NEWSK';
  buttonOf(card, 'data-creds-save').click(); await flush();
  const calls = saveCalls(h);
  assert.equal(calls.length, 1);
  assert.deepEqual(plain(calls[0].args), { name: VOLC, secretKey: 'NEWSK' }, 'blank AccessKey input keeps the saved field');
  assert.equal(ak.value, '');
});

test('credentials interaction: clear sends empty strings and restores the unconfigured note', async () => {
  const { h, card } = await start(true);
  buttonOf(card, 'data-creds-open').click(); await flush();
  const clear = buttonOf(card, 'data-creds-clear');
  assert.equal(clear.hidden, false);
  clear.click(); await flush();
  const calls = saveCalls(h);
  assert.equal(calls.length, 1);
  assert.deepEqual(plain(calls[0].args), { name: VOLC, accessKey: '', secretKey: '' });
  assert.equal(card.querySelector('.card-creds-note').hidden, false);
  assert.match(panelOf(card).querySelector('.creds-msg').textContent, /已清除/);
  assert.equal(buttonOf(card, 'data-creds-clear').hidden, true);
  assert.deepEqual(plain(inputsOf(card).map(n => n.placeholder)), ['输入 AccessKey ID', '输入 Secret AccessKey']);
});

test('credentials interaction: failed save keeps the panel open with typed values and the error', async () => {
  const { h, card } = await start(false, VOLC, { quota_credentials_save: () => Promise.reject(new Error('网关连接不可用')) });
  buttonOf(card, 'data-creds-open').click(); await flush();
  const [ak, sk] = inputsOf(card);
  ak.value = 'AK123'; sk.value = 'SK456';
  buttonOf(card, 'data-creds-save').click(); await flush();
  assert.equal(panelOf(card).hidden, false);
  assert.deepEqual(plain(inputsOf(card).map(n => n.value)), ['AK123', 'SK456']);
  assert.match(panelOf(card).querySelector('.creds-msg').textContent, /网关连接不可用/);
  assert.equal(card.querySelector('.card-creds-note').hidden, false, 'still unconfigured after the failure');
});

test('credentials interaction: XSS provider names stay text and round-trip through save args', async () => {
  const name = '<img src=x onerror=alert(1)>';
  const { h, card } = await start(false, name);
  assert.equal(card.querySelector('.card-name').textContent, name);
  assert.equal(h.id('list').querySelectorAll('img').length, 0);
  buttonOf(card, 'data-creds-open').click(); await flush();
  const [ak, sk] = inputsOf(card);
  ak.value = 'AK'; sk.value = 'SK';
  buttonOf(card, 'data-creds-save').click(); await flush();
  assert.equal(saveCalls(h)[0].args.name, name);
  assert.equal(h.id('list').querySelectorAll('img').length, 0);
  assert.equal(panelOf(card).querySelectorAll('img').length, 0);
});

test('credentials interaction: unconfigured blank save asks for both keys without IPC', async () => {
  const { h, card } = await start();
  buttonOf(card, 'data-creds-open').click(); await flush();
  buttonOf(card, 'data-creds-save').click(); await flush();
  assert.equal(saveCalls(h).length, 0);
  assert.match(panelOf(card).querySelector('.creds-msg').textContent, /请输入 AccessKey ID 和 Secret AccessKey/);
});
