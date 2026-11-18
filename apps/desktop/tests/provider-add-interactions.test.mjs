import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './control-center-interactions.test.mjs';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const name = 'example.com';
const baseUrl = 'https://example.com/v1/chat/completions';
const addCalls = h => h.calls.filter(c => c.cmd === 'provider_add');
function fill(h) {
  h.id('provider-name').value = ' ' + name + ' ';
  h.id('provider-base-url').value = baseUrl;
  h.id('provider-api-key').value = 'test-key';
  h.id('provider-models').value = ' one, two\none\n,  ';
}
const submit = h => h.id('provider-add-form').fire('submit');
const escape = h => h.windowEvents.keydown({ key: 'Escape', preventDefault() {} });

test('provider_add: discoverable action, password field, cancel, Escape and dismissal clean up', async () => {
  const h = harness(); await flush();
  const open = h.id('provider-add-open');
  const form = h.id('provider-add-form');
  const key = h.id('provider-api-key');
  assert.equal(open.textContent, '添加供应商');
  assert.equal(h.id('panel-quota').contains(open), true);
  assert.equal(key.getAttribute('type'), 'password');
  assert.equal(h.id('provider-add-save').getAttribute('type'), 'submit');
  assert.equal(form.hidden, true);
  open.click(); fill(h);
  assert.equal(h.doc.activeElement, h.id('provider-name'));
  escape(h);
  assert.equal(form.hidden, true);
  assert.equal(h.doc.activeElement, open);
  assert.equal(h.calls.some(c => c.cmd === 'quota_hide'), false);
  assert.equal(key.value, '');
  open.click(); fill(h); h.id('provider-add-cancel').click();
  assert.equal(key.value, '');
  open.click(); fill(h); h.id('tab-routing').click();
  assert.equal(form.hidden, true);
  assert.equal(key.value, '');
  h.id('tab-quota').click(); open.click(); fill(h); h.windowEvents.blur();
  assert.equal(key.value, '');
  fill(h); h.doc.visibilityState = 'hidden'; h.doc.events.visibilitychange();
  assert.equal(form.hidden, true);
  assert.equal(key.value, '');
  assert.equal(addCalls(h).length, 0);
});

test('provider_add: invalid fields focus and explain the correction before IPC', async () => {
  const h = harness(); await flush(); h.id('provider-add-open').click();
  for (const [field, value] of [
    ['provider-name', '  '], ['provider-name', 'example.com,one'], ['provider-name', 'a\u0000b'],
    ['provider-base-url', '/relative'], ['provider-base-url', 'ftp://example.com'],
    ['provider-base-url', 'https://test-key@example.com'], ['provider-base-url', 'https://example.com/#'],
    ['provider-api-key', '  '], ['provider-models', ' ,\n '],
  ]) {
    fill(h); h.id(field).value = value; submit(h);
    assert.equal(h.doc.activeElement, h.id(field));
    assert.ok(h.id('provider-add-error').textContent);
    assert.equal(addCalls(h).length, 0);
  }
});

test('provider_add: one IPC per save, refresh quota and routing choices, preserve unsaved route', async () => {
  let saved = false, finish;
  const h = harness({
    provider_add: () => new Promise(resolve => { finish = () => { saved = true; resolve({ name }); }; }),
    quota_snapshot: () => ({ online: true, providers: saved ? [{ name, enabled: true, windows: [] }] : [] }),
  });
  await flush(); h.id('tab-routing').click(); await flush();
  const target = h.id('routing-body').querySelector('.route-input');
  target.value = 'example.com,two'; target.fire('input');
  h.id('tab-quota').click(); h.id('provider-add-open').click(); fill(h);
  submit(h); submit(h); escape(h); await flush();
  assert.equal(h.id('provider-add-form').hidden, false);
  assert.equal(h.id('provider-add-save').disabled, true);
  assert.deepEqual(JSON.parse(JSON.stringify(addCalls(h))), [{ cmd: 'provider_add', args: {
    provider: { name, baseUrl, apiKey: 'test-key', models: ['one', 'two'] },
  } }]);
  h.route.providers.push({ name, models: ['one', 'two'] }); h.route.revision = '2';
  finish(); await flush();
  assert.equal(h.id('provider-add-form').hidden, true);
  assert.equal(h.id('provider-api-key').value, '');
  assert.match(h.id('provider-add-status').textContent, /已添加/);
  assert.equal(h.id('list').querySelector('.card-name').textContent, name);
  assert.equal(h.calls.filter(c => c.cmd === 'quota_snapshot').at(-1).args.provider, name);
  h.id('tab-routing').click();
  assert.ok(h.id('route-choices').children.some(option => option.value === 'example.com,one'));
  assert.equal(h.id('routing-body').querySelector('.route-input').value, 'example.com,two');
  assert.equal(h.calls.some(c => c.cmd === 'routing_save' || c.cmd === 'service_action'), false);
});

test('provider_add: duplicate and unknown errors are fixed, safe and retryable', async () => {
  let failure = 'PROVIDER_DUPLICATE';
  const h = harness({ provider_add: () => Promise.reject(failure) });
  await flush(); h.id('provider-add-open').click(); fill(h); submit(h); await flush();
  assert.match(h.id('provider-add-error').textContent, /名称已存在/);
  assert.equal(h.doc.activeElement, h.id('provider-name'));
  failure = new Error('test-key'); submit(h); await flush();
  assert.equal(addCalls(h).length, 2);
  assert.match(h.id('provider-add-error').textContent, /添加供应商失败/);
  assert.doesNotMatch(h.id('panel-quota').textContent, /test-key/);
  assert.equal(h.id('provider-add-form').hidden, false);
  assert.equal(h.id('provider-add-save').disabled, false);
  assert.equal(h.calls.filter(c => c.cmd === 'quota_snapshot').length, 1);
  h.id('provider-add-cancel').click();
  assert.equal(h.id('provider-api-key').value, '');
});

test('provider_add: pending initial snapshots cannot mask the post-save refresh', async () => {
  let finishQuota, finishRouting, quotaReads = 0, routingReads = 0;
  const h = harness({
    provider_add: () => ({ name }),
    quota_snapshot: () => ++quotaReads === 1 ? new Promise(resolve => { finishQuota = resolve; }) : { online: true, providers: [{ name }] },
    routing_snapshot: () => ++routingReads === 1 ? new Promise(resolve => { finishRouting = resolve; }) : { revision: '2', providers: [{ name, models: ['one'] }] },
  });
  h.id('tab-routing').click(); h.id('tab-quota').click(); h.id('provider-add-open').click();
  fill(h); submit(h); await flush();
  assert.equal(h.id('provider-add-form').hidden, true);
  finishQuota({ online: true, providers: [] }); finishRouting({ revision: '1', providers: [] }); await flush();
  assert.equal(h.id('list').querySelector('.card-name').textContent, name);
  assert.ok(h.id('route-choices').children.some(option => option.value === 'example.com,one'));
});
