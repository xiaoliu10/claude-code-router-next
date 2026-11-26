import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './control-center-interactions.test.mjs';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const provider = { name: 'codex-subscription', codexResetEligible: true, enabled: true };
const firstExpiry = new Date(2030, 4, 2, 14, 30).getTime();
const listing = () => ({ availableCount: 4, credits: [
  { id: 'used', status: 'redeemed', expiresAt: firstExpiry - 1000 },
  { id: 'undated', status: 'available' },
  { id: 'later', status: 'available', expiresAt: firstExpiry + 86400e3 },
  { id: 'first', status: 'available', expiresAt: firstExpiry },
] });
const snapshot = (row = provider) => ({ online: true, providers: [row], updatedAt: Date.now() });
const button = (root, text) => root.querySelectorAll('button').find(n => n.textContent === text);
async function start(overrides = {}, label = 'main') {
  const h = harness({ quota_snapshot: () => snapshot(), codex_reset_credits: listing, ...overrides }, { windowLabel: label });
  await flush();
  return { ...h, panel: () => h.id('list').querySelector('.codex-reset'), callsFor: cmd => h.calls.filter(c => c.cmd === cmd) };
}

test('Codex reset controls require the main window and an enabled, explicitly eligible Codex subscription', async () => {
  for (const [row, label] of [[provider, 'quota'], [provider, 'unknown'],
    [{ ...provider, codexResetEligible: undefined }, 'main'], [{ ...provider, enabled: false }, 'main'],
    [{ ...provider, codexResetEligible: 'true' }, 'main'], [{ ...provider, name: 'custom' }, 'main']]) {
    const h = await start({ quota_snapshot: () => snapshot(row) }, label);
    assert.equal(h.panel(), null);
    assert.equal(h.callsFor('codex_reset_credits').length, 0);
    assert.equal(h.callsFor('codex_reset_consume').length, 0);
  }
});

test('Codex list errors, zero allowance and missing available targets disable consumption until rechecked', async () => {
  const results = [() => { throw Error('fixture-secret'); }, () => ({ ...listing(), availableCount: 0 }),
    () => ({ availableCount: 2, credits: [] }), listing];
  const h = await start({ codex_reset_credits: () => results.shift()() });
  const panel = h.panel();
  for (const text of [/无法读取/, /0 张/, /2 张.*暂无可选择/]) {
    assert.match(panel.textContent, text);
    assert.doesNotMatch(panel.textContent, /fixture-secret/);
    assert.equal(button(panel, '重置用量').disabled, true);
    button(panel, '重置用量').click();
    button(panel, '重查张数').click();
    await flush();
  }
  assert.match(panel.textContent, /4 张.*5月2日 14:30/);
  assert.equal(button(panel, '重置用量').disabled, false);
  assert.equal(h.callsFor('codex_reset_consume').length, 0);
});

test('Opening, cancelling, polling and leaving the quota tab cannot confirm a redemption', async () => {
  const h = await start();
  const panel = h.panel();
  const open = button(panel, '重置用量');
  open.click(); open.click();
  assert.equal(h.doc.activeElement, button(panel, '取消'));
  button(panel, '取消').click();
  open.click(); h.doc.activeElement.fire('keydown', { key: 'Escape' });
  assert.equal(h.doc.activeElement, open);
  open.click(); h.id('tab-usage').click();
  h.intervals.forEach(([poll]) => poll());
  h.id('tab-quota').click(); h.focusWindow();
  h.id('refresh-all').click(); await flush();
  assert.equal(panel.querySelector('.client-confirm').hidden, true);
  assert.equal(h.callsFor('codex_reset_consume').length, 0);
});

for (const [outcome, feedback] of [['reset', 'Codex 订阅额度已重置。'], ['already_redeemed', '这张重置卡此前已使用。'],
  ['no_credit', '没有可用的重置卡。'], ['nothing_to_reset', '当前订阅额度无需重置。']]) {
  test(`Confirmed ${outcome} shows its own verdict, using the earliest available credit once`, async () => {
    let resolveConsume, reads = 0;
    const h = await start({ codex_reset_credits: () => ++reads === 1 ? listing() : { availableCount: 0, credits: [] },
      codex_reset_consume: () => new Promise(resolve => { resolveConsume = resolve; }) });
    const panel = h.panel();
    button(panel, '重置用量').click();
    const confirm = button(panel, '确认使用 1 张');
    confirm.click(); confirm.fire('click'); await flush();
    assert.deepEqual(h.callsFor('codex_reset_consume').map(c => ({ ...c.args })), [{ creditId: 'first' }]);
    assert.equal(button(panel, '重查张数').disabled, true);
    resolveConsume({ outcome, windowsReset: outcome === 'reset' ? 2 : 0, availableCount: 3 }); await flush();
    assert.equal(panel.querySelectorAll('[role]').find(n => n.textContent === feedback)?.textContent, feedback);
    assert.match(panel.textContent, /0 张/);
    assert.equal(button(panel, '重置用量').disabled, true);
    if (outcome === 'reset' || outcome === 'already_redeemed') {
      assert.equal(reads, 2);
      assert.equal(h.callsFor('quota_snapshot').filter(c => c.args.provider === provider.name).length, 1);
    }
  });
}

test('An uncertain consume requires a fresh read and confirmation, without automatic retries', async () => {
  const h = await start({ codex_reset_consume: () => { throw Error('timeout'); } });
  const panel = h.panel();
  button(panel, '重置用量').click(); button(panel, '确认使用 1 张').click(); await flush();
  assert.match(panel.textContent, /无法确认是否已使用/);
  assert.equal(button(panel, '重置用量').disabled, true);
  h.focusWindow(); await flush();
  button(panel, '重查张数').click(); await flush();
  assert.equal(button(panel, '重置用量').disabled, false);
  assert.equal(panel.querySelector('.client-confirm').hidden, true);
  assert.equal(h.callsFor('codex_reset_consume').length, 1);
});

test('Removing eligibility invalidates an open confirmation even on a same-name row', async () => {
  let row = provider;
  const h = await start({ quota_snapshot: () => snapshot(row) });
  const panel = h.panel();
  button(panel, '重置用量').click();
  row = { ...provider, codexResetEligible: false };
  h.id('refresh-all').click(); await flush();
  assert.equal(h.panel(), null);
  button(panel, '确认使用 1 张').fire('click');
  assert.equal(h.callsFor('codex_reset_consume').length, 0);
});

test('A successful reset queues a fresh targeted quota read behind an older full snapshot', async () => {
  let quotaReads = 0, resolveFull, resolveConsume;
  const h = await start({
    quota_snapshot: () => ++quotaReads === 2 ? new Promise(resolve => { resolveFull = resolve; }) : snapshot(),
    codex_reset_consume: () => new Promise(resolve => { resolveConsume = resolve; }),
  });
  button(h.panel(), '重置用量').click(); button(h.panel(), '确认使用 1 张').click();
  h.id('refresh-all').click(); await flush();
  resolveConsume({ outcome: 'reset', windowsReset: 1 }); await flush();
  assert.equal(quotaReads, 2);
  resolveFull(snapshot()); await flush();
  assert.deepEqual(h.callsFor('quota_snapshot').map(c => c.args.provider), [null, null, provider.name]);
});
