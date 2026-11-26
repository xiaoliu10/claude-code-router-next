import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './control-center-interactions.test.mjs';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const provider = { name: 'codex-subscription', enabled: true, status: 'ready' };
const quota = (providers = [provider]) => ({ providers, online: true });
const panel = h => h.id('list').querySelector('.codex-tier');
const select = h => panel(h).querySelector('select');
const gets = h => h.calls.filter(c => c.cmd === 'codex_service_tier_get');
const sets = h => h.calls.filter(c => c.cmd === 'codex_service_tier_set');
function change(h, tier) { select(h).value = tier; select(h).fire('change'); }

// Expose one resolver per IPC so reads and writes can be settled independently.
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('Codex tier probes only eligible main-window cards, including after focus', async () => {
  for (const [windowLabel, row] of [['quota', provider], ['main', { ...provider, enabled: false }], ['main', { ...provider, name: 'codex' }]]) {
    const h = harness({ quota_snapshot: () => quota([row]) }, { windowLabel });
    await flush(); h.focusWindow(); await flush();
    assert.equal(panel(h), null);
    assert.equal(gets(h).length, 0);
  }
});

test('Codex tier waits for bridge eligibility and caches null across quota refreshes', async () => {
  const get = deferred();
  const h = harness({ quota_snapshot: () => quota(), codex_service_tier_get: () => get.promise });
  await flush();
  assert.equal(panel(h).hidden, true);
  assert.equal(select(h).disabled, true);
  change(h, 'priority');
  assert.equal(sets(h).length, 0);
  get.resolve(null); await flush();
  assert.equal(panel(h).hidden, true, 'ordinary same-name provider has no control');
  h.id('refresh-all').click(); await flush();
  assert.equal(gets(h).length, 1);
  assert.equal(gets(h)[0].args, undefined);
});

test('Codex tier confirms single-flight writes, keeps standard on re-entry, and restores follow', async () => {
  let tier = 'follow', save = deferred();
  const h = harness({ quota_snapshot: () => quota(), codex_service_tier_get: () => ({ tier }),
    codex_service_tier_set: async args => { await save.promise; tier = args.tier; return { tier }; } });
  await flush();
  assert.equal(select(h).value, 'follow');
  assert.equal(panel(h).querySelector('label').htmlFor, select(h).id);
  assert.deepEqual(select(h).children.map(o => [o.textContent, o.value]),
    [['跟随请求', 'follow'], ['标准', 'standard'], ['快速（Fast）', 'priority']]);
  change(h, 'follow'); change(h, 'standard'); change(h, 'priority');
  assert.deepEqual(sets(h).map(c => c.args.tier), ['standard']);
  assert.equal(select(h).disabled, true);
  assert.equal(select(h).value, 'follow');
  assert.match(panel(h).textContent, /保存中/);
  save.resolve(); await flush();
  assert.equal(select(h).value, 'standard');
  assert.match(panel(h).textContent, /已保存/);
  h.id('refresh-all').click(); await flush();
  assert.equal(gets(h).length, 1);
  h.id('tab-routing').click(); h.id('tab-quota').click(); await flush();
  assert.equal(gets(h).length, 2);
  assert.equal(select(h).value, 'standard');
  save = deferred(); change(h, 'priority'); save.resolve(); await flush();
  const hint = panel(h).querySelector('span');
  assert.equal(hint.hidden, false); assert.match(hint.textContent, /消耗更多额度/);
  change(h, 'follow'); await flush();
  assert.equal(select(h).value, 'follow'); assert.equal(hint.hidden, true);
  assert.deepEqual(sets(h).map(c => c.args.tier), ['standard', 'priority', 'follow']);
});

test('Codex tier shows bridge upgrade guidance and never confirms failed or mismatched writes', async () => {
  let readError = 'codex_tier_upgrade_required', reply;
  const h = harness({ quota_snapshot: () => quota(),
    codex_service_tier_get: () => { if (readError) throw readError; return { tier: 'standard' }; },
    codex_service_tier_set: () => reply() });
  await flush();
  assert.equal(panel(h).hidden, false); assert.match(panel(h).textContent, /请更新/);
  assert.equal(select(h).disabled, true);
  readError = ''; h.focusWindow(); await flush();
  for (const [result, message] of [[() => { throw Error('codex_tier_upgrade_required'); }, /请更新/],
    [() => { throw 'failed'; }, /未能确认/], [() => ({ tier: 'follow' }), /未能确认/], [() => null, /未能确认/]]) {
    reply = result; change(h, 'priority'); await flush();
    assert.match(panel(h).textContent, message); assert.doesNotMatch(panel(h).textContent, /已保存/);
    assert.equal(select(h).disabled, false); assert.equal(select(h).value, 'standard');
  }
});

test('Codex tier discards superseded reads and waits for a pending write before reading a new card', async () => {
  let rows = [provider], get = deferred();
  const save = deferred();
  const h = harness({ quota_snapshot: () => quota(rows), codex_service_tier_get: () => get.promise,
    codex_service_tier_set: () => save.promise });
  await flush(); const first = get; get = deferred();
  h.focusWindow(); await flush();
  get.resolve({ tier: 'standard' }); await flush(); first.resolve(null); await flush();
  assert.equal(select(h).value, 'standard'); assert.equal(panel(h).hidden, false);
  change(h, 'priority'); h.focusWindow(); await flush();
  rows = []; h.id('refresh-all').click(); await flush(); assert.equal(panel(h), null);
  rows = [provider]; h.id('refresh-all').click(); await flush();
  assert.equal(panel(h).hidden, true); assert.equal(gets(h).length, 2);
  get = deferred(); save.resolve({ tier: 'priority' }); await flush();
  assert.equal(gets(h).length, 3); assert.equal(panel(h).hidden, true);
  get.resolve(null); await flush(); assert.equal(panel(h).hidden, true);
  change(h, 'priority'); assert.equal(sets(h).length, 1);
});
