import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './control-center-interactions.test.mjs';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const entry = { name: 'example.com', baseUrl: 'https://example.com/v1', models: ['one', 'two'], managed: false };
const editButton = h => h.id('list').querySelector('.card-edit');
const submit = h => h.id('provider-add-form').fire('submit');
const updates = h => h.calls.filter(c => c.cmd === 'provider_update');
function editHarness(overrides) {
  return harness({
    quota_snapshot: () => ({ online: true, providers: [{ name: entry.name }] }),
    provider_get: () => entry,
    ...overrides,
  });
}
async function openEdit(h) {
  await flush(); editButton(h).click(); await flush();
}

test('provider_get opens a labeled, prefilled editor and clears the key on dismissal', async () => {
  const h = editHarness(); await openEdit(h);
  const edit = editButton(h), key = h.id('provider-api-key');
  assert.equal(edit.textContent, '编辑');
  assert.equal(edit.getAttribute('aria-label'), '编辑 example.com');
  assert.deepEqual({ ...h.calls.find(c => c.cmd === 'provider_get').args }, { name: entry.name });
  assert.equal(h.id('provider-add-form').hidden, false);
  assert.equal(h.id('provider-form-title').textContent, '编辑供应商');
  assert.equal(h.id('provider-add-save').textContent, '保存修改');
  assert.equal(h.id('provider-name').value, entry.name);
  assert.equal(h.id('provider-name').readOnly, true);
  assert.equal(h.id('provider-base-url').value, entry.baseUrl);
  assert.equal(h.id('provider-models').value, 'one\ntwo');
  assert.equal(key.value, '');
  assert.equal(key.placeholder, '已保存，留空则不修改');
  key.value = 'test-key'; h.id('provider-models').value = 'draft-model';
  h.windowEvents.blur?.(); h.doc.visibilityState = 'hidden'; h.doc.events.visibilitychange?.();
  h.doc.visibilityState = 'visible'; h.doc.events.visibilitychange?.(); h.windowEvents.focus(); await flush();
  assert.equal(key.value, 'test-key');
  assert.equal(h.id('provider-models').value, 'draft-model');
  assert.equal(h.id('provider-add-form').hidden, false);
  h.windowEvents.keydown({ key: 'Escape', preventDefault() {} });
  assert.equal(h.id('provider-add-form').hidden, true);
  assert.equal(h.doc.activeElement, edit);
  assert.equal(key.value, '');
  await openEdit(h); key.value = 'test-key'; h.id('tab-routing').click();
  assert.equal(key.value, '');
  assert.equal(updates(h).length, 0);
});

test('provider_get managed entry shows the plugin note and cannot submit', async () => {
  for (const provider_get of [() => Promise.reject('PROVIDER_MANAGED'), () => ({ ...entry, baseUrl: 'https://example.com/?token=test-secret', managed: true })]) {
    const h = editHarness({ provider_get }); await openEdit(h);
    assert.equal(h.id('provider-add-save').disabled, true);
    assert.equal(h.id('provider-base-url').value, '');
    assert.equal(h.id('provider-models').value, '');
    assert.equal(h.id('provider-add-error').textContent, '系统托管的供应商请在对应插件卡片中管理');
    submit(h); assert.equal(updates(h).length, 0);
  }
  const h = editHarness({ provider_get: () => Promise.reject('PROVIDER_MANAGED') }); await openEdit(h);
  h.id('provider-add-cancel').click(); h.id('provider-add-open').click();
  assert.equal(h.id('provider-name').value, '');
  assert.equal(h.id('provider-add-save').disabled, false);
  assert.equal(h.id('provider-form-title').textContent, '添加供应商');
});

test('unsafe endpoint details from an older bridge never populate the URL input', async () => {
  const h = editHarness({ provider_get: () => ({ ...entry, baseUrl: 'https://example.com/?version=test-secret' }) });
  await openEdit(h);
  assert.equal(h.id('provider-add-form').hidden, true);
  assert.equal(h.id('provider-base-url').value, '');
  assert.doesNotMatch(h.id('provider-add-status').textContent, /test-secret/);
});

test('provider_update omits a blank key and refreshes the card and routing choices while retaining drafts', async () => {
  let name = entry.name, models = entry.models, revision = '1';
  const h = editHarness({
    quota_snapshot: () => ({ online: true, providers: [{ name }] }),
    routing_snapshot: () => ({ revision, providers: [{ name, models }], routes: [] }),
    provider_update: ({ provider }) => { name = provider.name; models = provider.models; revision = '2'; return { name }; },
  });
  await flush(); h.id('tab-routing').click(); await flush();
  const draft = h.id('routing-body').querySelector('.route-input');
  draft.value = 'example.com,one'; draft.fire('input'); h.id('tab-quota').click();
  await openEdit(h);
  h.id('provider-name').value = 'Renamed'; h.id('provider-models').value = 'three';
  submit(h); submit(h); await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(updates(h))), [{ cmd: 'provider_update', args: {
    name: entry.name, provider: { name: entry.name, baseUrl: entry.baseUrl, models: ['three'] },
  } }]);
  assert.equal(h.calls.filter(c => c.cmd === 'quota_snapshot').at(-1).args.provider, entry.name);
  assert.equal(editButton(h).getAttribute('aria-label'), '编辑 example.com');
  assert.equal(h.id('list').querySelectorAll('.card-edit').length, 1);
  assert.equal(h.id('provider-add-status').textContent, '已更新供应商');
  assert.equal(h.id('provider-add-form').hidden, true);
  h.id('tab-routing').click();
  const choices = h.id('route-choices').children.map(option => option.value);
  assert.deepEqual(choices, ['example.com,three']);
  assert.equal(h.id('routing-body').querySelector('.route-input').value, 'example.com,one');
  assert.ok(!h.calls.some(c => c.cmd === 'routing_save'));
});

test('provider_update validates fields, reports duplicate names and sends a replacement key', async () => {
  let failure = 'PROVIDER_DUPLICATE';
  const h = editHarness({ provider_update: () => failure ? Promise.reject(failure) : { name: entry.name } }); await openEdit(h);
  const key = h.id('provider-api-key');
  key.value = '  '; submit(h);
  assert.equal(h.doc.activeElement, key);
  assert.equal(updates(h).length, 0);
  key.value = 'test-key'; submit(h); await flush();
  assert.match(h.id('provider-add-error').textContent, /名称已存在/);
  assert.equal(h.doc.activeElement, h.id('provider-add-save'));
  failure = 'PROVIDER_SAVE_UNCONFIRMED'; submit(h); await flush();
  assert.equal(h.id('provider-add-error').textContent, '暂时无法确认保存结果，请刷新后再决定是否重试');
  failure = new Error('test-key'); submit(h); await flush();
  assert.doesNotMatch(h.id('panel-quota').textContent, /test-key/);
  failure = null; submit(h); await flush();
  assert.equal(updates(h).at(-1).args.provider.apiKey, 'test-key');
  assert.equal(key.value, '');
});

test('a provider_get that finishes after cancel cannot reopen or refill the form', async () => {
  let finish;
  const h = editHarness({ provider_get: () => new Promise(resolve => { finish = resolve; }) });
  await openEdit(h);
  assert.equal(h.id('provider-add-save').disabled, true);
  h.id('provider-add-cancel').click(); h.id('provider-add-open').click();
  finish(entry); await flush();
  assert.equal(h.id('provider-name').value, '');
  assert.equal(h.id('provider-form-title').textContent, '添加供应商');
});
