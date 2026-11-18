import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './control-center-interactions.test.mjs';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const detail = { name: 'example.com', baseUrl: 'https://example.com/v1', models: ['one'], managed: false };
const plain = value => JSON.parse(JSON.stringify(value));
const rows = h => h.id('provider-transformer-rows').children;
const submit = h => h.id('provider-add-form').fire('submit');
const payload = (h, command) => h.calls.filter(c => c.cmd === command).at(-1).args.provider;
function transformerHarness(extra = {}, overrides = {}) {
  return harness({
    quota_snapshot: () => ({ online: true, providers: [{ name: detail.name }] }),
    provider_transformers: () => ({ names: ['first', 'second'] }),
    provider_get: () => ({ ...detail, ...extra }),
    provider_add: () => ({ name: detail.name }),
    provider_update: () => ({ name: detail.name }),
    ...overrides,
  });
}
async function edit(h) {
  await flush(); h.id('list').querySelector('.card-edit').click(); await flush();
}
const button = (node, text) => node.querySelectorAll('button').find(b => b.textContent === text);

test('add serializes ordered transformer names and tuples with text and JSON parameters', async () => {
  const h = transformerHarness();
  h.id('provider-add-open').click(); await flush();
  assert.equal(rows(h).length, 0);
  const add = h.id('provider-transformer-add'); add.click(); add.click();
  const field = rows(h)[0].querySelector('select');
  assert.deepEqual(field.children.map(o => o.value), ['first', 'second']);
  const row = rows(h)[1]; row.querySelector('.transformer-name').value = 'second';
  for (const [name, value, type] of [['mode', '123', '文本'], ['flags', '[true,42]', 'JSON']]) {
    button(row, '添加参数').click();
    const param = row.querySelectorAll('.transformer-param').at(-1);
    param.querySelector('.param-key').value = name;
    param.querySelector('.param-type').value = type;
    param.querySelector('.param-value').value = value;
  }
  h.id('provider-name').value = detail.name; h.id('provider-models').value = 'one';
  h.id('provider-base-url').value = detail.baseUrl; h.id('provider-api-key').value = 'test-key';
  submit(h); await flush();
  assert.deepEqual(plain(payload(h, 'provider_add').transformer), { use: ['first', ['second', { mode: '123', flags: [true, 42] }]] });
  assert.equal(h.calls.filter(c => c.cmd === 'provider_transformers').length, 1);
  assert.equal(rows(h).length, 0);
});

test('edit prefills known and foreign names, removes rows and sends null for an empty chain', async () => {
  const h = transformerHarness({ transformer: { use: ['first', 'custom'] }, transformerProtected: false });
  await edit(h);
  assert.equal(rows(h)[0].querySelector('select').value, 'first');
  assert.equal(rows(h)[1].querySelector('input').value, 'custom');
  while (rows(h).length) button(rows(h)[0], '移除').click();
  submit(h); await flush();
  assert.equal(payload(h, 'provider_update').transformer, null);
});

test('protected tuple parameters are kept by omission or explicitly replaced with a fresh chain', async () => {
  const h = transformerHarness({ transformer: { use: ['custom', 'second'] }, transformerProtected: true });
  await edit(h);
  assert.equal(rows(h).length, 0);
  assert.match(h.id('provider-transformer-summary').textContent, /custom → second/);
  assert.equal(h.id('provider-transformer-add').hidden, true);
  submit(h); await flush();
  assert.ok(!Object.hasOwn(payload(h, 'provider_update'), 'transformer'));
  await edit(h);
  h.id('provider-transformer-replace').click(); h.id('provider-transformer-add').click();
  submit(h); await flush();
  assert.deepEqual(plain(payload(h, 'provider_update').transformer), { use: ['first'] });
  await edit(h);
  h.id('provider-transformer-replace').click(); submit(h); await flush();
  assert.equal(payload(h, 'provider_update').transformer, null);
});

test('an unavailable transformer catalog falls back to free text and retries on the next open', async () => {
  const h = transformerHarness({}, { provider_transformers: () => Promise.reject(new Error('test-key')) });
  await edit(h); h.id('provider-transformer-add').click();
  const name = rows(h)[0].querySelector('input'); name.value = 'custom';
  assert.doesNotMatch(h.id('panel-quota').textContent, /test-key/);
  submit(h); await flush();
  assert.deepEqual(plain(payload(h, 'provider_update').transformer), { use: ['custom'] });
  await edit(h);
  assert.equal(h.calls.filter(c => c.cmd === 'provider_transformers').length, 2);
});
