import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { harness } from './control-center-interactions.test.mjs';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const plain = value => JSON.parse(JSON.stringify(value));
const src = name => readFileSync(new URL('../src/' + name, import.meta.url), 'utf8');
const sandbox = { URL, setTimeout };
vm.runInNewContext(src('general-settings.js') + src('quota.js'), sandbox);
const defaults = {
  LOG: true, LOG_LEVEL: 'error', statusLineEnabled: false, tokenSpeedEnabled: false,
  disableAttributionHeader: true, enableConcurrencyPriority: false, concurrencyThreshold: 3,
  WAKEUP_ENABLED: false, WAKEUP_TIME: '06:00', CLAUDE_PATH: '', HOST: '', PORT: 3456,
  API_TIMEOUT_MS: 600000, PROBE_TIMEOUT_MS: 15000, PROBE_SLOW_THRESHOLD_MS: 3000,
  ContextWindow: 200000, PROXY_GLOBAL_ENABLED: true, CUSTOM_ROUTER_PATH: '',
};
const write = (h, id, value) => {
  const field = h.id(id);
  field.focus();
  if (typeof value === 'boolean') field.checked = value;
  else field.value = value;
  field.fire(field.tagName === 'SELECT' || typeof value === 'boolean' ? 'change' : 'input');
};
const saves = h => h.calls.filter(c => c.cmd === 'general_settings_save');
const reads = h => h.calls.filter(c => c.cmd === 'general_settings_snapshot');

function setup(overrides = {}) {
  const fixture = { revision: 'r1', values: { ...defaults }, portFromEnv: false, hostIsEmpty: false, apiKeyConfigured: true, proxyConfigured: true };
  const h = harness({
    general_settings_snapshot: () => plain(fixture),
    general_settings_save: ({ revision, changes }) => {
      if (revision !== fixture.revision) throw new Error('Settings draft is stale; refresh the panel and retry');
      for (const [key, value] of Object.entries(changes)) {
        if (key === 'APIKEY') fixture.apiKeyConfigured = value !== '';
        else if (key === 'PROXY_URL') fixture.proxyConfigured = value !== '';
        else {
          fixture.values[key] = value;
          if (key === 'PORT') fixture.portFromEnv = false;
          if (key === 'HOST') fixture.hostIsEmpty = false;
        }
      }
      fixture.revision += '+';
      return plain(fixture);
    }, ...overrides,
  });
  return { h, fixture };
}
async function open(h) {
  await flush();
  assert.equal(reads(h).length, 0);
  h.id('tab-quota').fire('keydown', { key: 'End' });
  await flush();
  assert.equal(h.doc.activeElement, h.id('tab-settings'));
  assert.equal(h.id('panel-settings').hidden, false);
  assert.equal(reads(h).length, 1);
}

test('settings: every supported scalar has a labeled control and a gateway default in the keyboard-accessible panel', async () => {
  const { h } = setup();
  await open(h);
  const body = h.id('settings-body');
  const fields = body.querySelectorAll('[data-setting]');
  assert.deepEqual(fields.map(n => n.dataset.setting).sort(), Object.keys(defaults).sort());
  const labels = body.querySelectorAll('label');
  for (const field of fields) {
    assert.ok(labels.some(label => label.contains(field) || label.getAttribute('for') === field.getAttribute('id')));
    const value = defaults[field.dataset.setting];
    assert.equal(typeof value === 'boolean' ? field.checked : field.value, typeof value === 'boolean' ? value : String(value));
  }
  assert.ok(body.querySelectorAll('.settings-group').every(n => n.getAttribute('aria-label')));
  h.id('tab-settings').fire('keydown', { key: 'ArrowRight' });
  assert.equal(h.doc.activeElement, h.id('tab-quota'));
  h.id('tab-quota').fire('keydown', { key: 'ArrowLeft' });
  assert.equal(h.doc.activeElement, h.id('tab-settings'));
  assert.equal(reads(h).length, 1);
});

test('settings: drafts survive focus, tab changes and explicit reload, then save all scalar types in one request', async () => {
  const { h, fixture } = setup();
  await open(h);
  const changes = { LOG: false, LOG_LEVEL: 'trace', statusLineEnabled: true, tokenSpeedEnabled: true,
    disableAttributionHeader: false, enableConcurrencyPriority: true, concurrencyThreshold: 4, WAKEUP_ENABLED: true,
    WAKEUP_TIME: '07:45', CLAUDE_PATH: '/opt/tools/claude', HOST: 'localhost', PORT: 4100,
    API_TIMEOUT_MS: 80000, PROBE_TIMEOUT_MS: 16000, PROBE_SLOW_THRESHOLD_MS: 4000, ContextWindow: 180000,
    PROXY_GLOBAL_ENABLED: false, CUSTOM_ROUTER_PATH: '/example/router.js' };
  for (const field of h.id('settings-body').querySelectorAll('[data-setting]')) {
    const value = changes[field.dataset.setting];
    write(h, field.getAttribute('id'), typeof value === 'number' ? String(value) : value);
  }
  h.focusWindow();
  h.id('tab-quota').click(); h.id('tab-settings').click();
  fixture.revision = 'r2';
  h.id('settings-refresh').click(); await flush();
  assert.equal(h.id('set-port').value, '4100');
  assert.match(h.id('settings-msg').textContent, /保留草稿/);
  assert.equal(saves(h).length, 0);
  h.id('settings-save').click(); h.id('settings-save').click(); await flush();
  assert.deepEqual(saves(h).map(c => plain(c.args)), [{ revision: 'r2', changes }]);
  assert.equal(h.id('settings-save').disabled, true);
  assert.match(h.id('settings-msg').textContent, /已保存/);
  assert.ok(!h.calls.some(c => c.cmd === 'service_action'));
});

test('settings: invalid edits focus the field, stale saves retain the draft until reloaded', async () => {
  const { h, fixture } = setup();
  await open(h);
  for (const port of ['', '3.5', '65536']) {
    write(h, 'set-port', port); h.id('settings-save').click();
    assert.equal(h.id('set-port').getAttribute('aria-invalid'), 'true');
    assert.equal(h.doc.activeElement, h.id('set-port'));
    assert.equal(saves(h).length, 0);
  }
  write(h, 'set-port', '4000');
  fixture.values.LOG_LEVEL = 'debug'; fixture.revision = 'r2';
  h.id('settings-save').click(); await flush();
  assert.equal(h.id('settings-save').disabled, true);
  assert.match(h.id('settings-msg').textContent, /配置已在其他位置修改/);
  h.id('settings-refresh').click(); await flush();
  assert.equal(h.id('set-log-level').value, 'debug');
  assert.equal(h.id('set-port').value, '4000');
  h.id('settings-save').click(); await flush();
  assert.deepEqual(plain(saves(h)[1].args), { revision: 'r2', changes: { PORT: 4000 } });
});

test('settings: environment port is preserved on unrelated saves and can be replaced with 3456 after a conflict', async () => {
  const { h, fixture } = setup();
  delete fixture.values.PORT;
  fixture.portFromEnv = true;
  await open(h);
  const port = h.id('set-port'), status = h.id('settings-port-status'), save = h.id('settings-save');
  assert.equal(port.value, '');
  assert.equal(status.hidden, false);
  assert.match(status.textContent, /环境变量/);
  assert.equal(save.disabled, true);
  write(h, 'set-port', '3456');
  write(h, 'set-port', '');
  assert.equal(save.disabled, true);
  write(h, 'set-log', false); save.click(); await flush();
  assert.deepEqual(plain(saves(h)[0].args.changes), { LOG: false });
  assert.equal(port.value, '');
  assert.equal(status.hidden, false);

  write(h, 'set-port', '3456');
  fixture.revision = 'r2';
  save.click(); await flush();
  assert.match(h.id('settings-msg').textContent, /配置已在其他位置修改/);
  assert.equal(save.disabled, true);
  h.id('settings-refresh').click(); await flush();
  assert.equal(port.value, '3456');
  save.click(); await flush();
  assert.deepEqual(plain(saves(h)[2].args), { revision: 'r2', changes: { PORT: 3456 } });
  assert.equal(port.value, '3456');
  assert.equal(status.hidden, true);
  assert.equal(save.disabled, true);
});

test('settings: an existing empty HOST can be kept or explicitly repaired', async () => {
  const { h, fixture } = setup();
  fixture.hostIsEmpty = true;
  await open(h);
  const save = h.id('settings-save'), repair = h.id('set-host-repair');
  assert.equal(save.disabled, true);
  assert.equal(h.id('settings-host-repair').hidden, false);
  write(h, 'set-log', false); save.click(); await flush();
  assert.deepEqual(plain(saves(h)[0].args.changes), { LOG: false });
  write(h, 'set-host-repair', true);
  h.id('settings-refresh').click(); await flush();
  assert.equal(repair.checked, true);
  save.click(); await flush();
  assert.deepEqual(plain(saves(h)[1].args.changes), { HOST: '' });
  assert.equal(h.id('settings-host-repair').hidden, true);
  assert.equal(save.disabled, true);
});

test('settings: an older gateway keeps the draft and asks for an upgrade', async () => {
  const { h } = setup({ general_settings_save: () => { throw Error('Gateway does not support conditional settings saves'); } });
  await open(h);
  write(h, 'set-timeout', '720000'); h.id('settings-save').click(); await flush();
  assert.match(h.id('settings-msg').textContent, /升级网关后刷新/);
  assert.equal(h.id('set-timeout').value, '720000');
  assert.equal(h.id('settings-save').disabled, true);
});

test('settings: failed load has a retry and unconfirmed saves require an explicit reload', async () => {
  let failLoad = true;
  const { h, fixture } = setup({
    general_settings_snapshot: () => { if (failLoad) throw Error('unavailable'); return plain(fixture); },
    general_settings_save: () => { throw Error('Settings save could not be confirmed.'); },
  });
  await open(h);
  assert.match(h.id('settings-msg').textContent, /读取失败/);
  assert.equal(h.id('settings-body').hidden, true);
  failLoad = false;
  h.id('settings-refresh').click(); await flush();
  write(h, 'set-timeout', '720000'); h.id('settings-save').click(); await flush();
  assert.match(h.id('settings-msg').textContent, /尚未确认写入结果/);
  assert.equal(h.id('settings-save').disabled, true);
  assert.equal(h.id('set-timeout').value, '720000');
});

for (const [key, id, testValue] of [['APIKEY', 'set-apikey', 'fixture-value'], ['PROXY_URL', 'set-proxy-url', 'https://example.invalid']]) {
  test(`settings: ${key} requires an explicit keep, replace or clear action`, async () => {
    const { h } = setup(); await open(h);
    const field = h.id(id);
    assert.equal(field.hidden, true);
    assert.equal(field.value, '');
    assert.equal(field.getAttribute('type'), 'password');
    write(h, id + '-action', 'replace'); h.id('settings-save').click();
    assert.equal(saves(h).length, 0, 'empty replacement is distinct from a clear');
    if (key === 'APIKEY') {
      for (const value of ['$UNSET', 'prefix-${VAR}', '${broken', 'tail$', ' key', 'test\u0085', '示例口令', 'a'.repeat(4097)]) {
        write(h, id, value); h.id('settings-save').click();
        assert.equal(saves(h).length, 0);
        assert.match(h.id('settings-msg').textContent, /APIKEY.*ASCII/);
        assert.ok(!h.id('settings-msg').textContent.includes(value));
      }
    } else {
      write(h, id, 'socks://example.invalid'); h.id('settings-save').click();
      assert.equal(saves(h).length, 0);
      assert.ok(!h.id('settings-msg').textContent.includes('example.invalid'));
    }
    write(h, id, testValue); h.id('settings-refresh').click(); await flush();
    assert.equal(field.value, testValue);
    h.id('settings-save').click(); await flush();
    assert.deepEqual(plain(saves(h)[0].args.changes), { [key]: testValue });
    assert.equal(field.value, '');
    assert.equal(field.hidden, true);
    write(h, id + '-action', 'clear'); write(h, id + '-action', 'keep');
    assert.equal(h.id('settings-save').disabled, true);
    write(h, id + '-action', 'clear'); h.id('settings-save').click(); await flush();
    assert.deepEqual(plain(saves(h)[1].args.changes), { [key]: '' });
  });
}

test('settings: preview supports revisioned save and reload without returning write-only values', async () => {
  const invoke = sandbox.QuotaUI.createPreviewInvoke();
  const before = await invoke('general_settings_snapshot');
  assert.deepEqual(plain(before.values), defaults);
  await assert.rejects(invoke('general_settings_save', { revision: before.revision, changes: { APIKEY: '$UNSET' } }), /APIKEY.*ASCII/);
  const result = await invoke('general_settings_save', { revision: before.revision, changes: { PORT: 4567, APIKEY: 'fixture-value', PROXY_URL: '$PROXY' } });
  assert.deepEqual(plain(result.values), { ...defaults, PORT: 4567 });
  assert.equal(result.proxyConfigured, true); assert.equal(result.apiKeyConfigured, true);
  await assert.rejects(invoke('general_settings_save', { revision: before.revision, changes: { LOG: true } }), /stale/);
  assert.deepEqual(plain(await invoke('general_settings_snapshot')), plain(result));
});
