// Dependency-free DOM harness: exercises actual event handlers and DOM updates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const projectsJs = readFileSync(new URL('../src/projects.js', import.meta.url), 'utf8');
const js = readFileSync(new URL('../src/quota.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../src/quota.html', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

class Element {
  constructor(tag, doc) {
    this.tagName = tag.toUpperCase(); this.doc = doc;
    this.children = []; this.parentNode = null; this.attrs = {}; this.dataset = {};
    this.listeners = {}; this._text = ''; this.value = ''; this.hidden = false;
    this.disabled = false; this.selectionStart = 0; this.selectionEnd = 0;
    // CSSOM write target: quota.js sets chart bar sizes via el.style (CSP-safe).
    this.style = {};
    this.classList = { toggle: (name, on) => {
      const classes = new Set(this.className.split(/\s+/).filter(Boolean));
      if (on) classes.add(name); else classes.delete(name);
      this.className = [...classes].join(' ');
    } };
  }
  get className() { return this.attrs.class || ''; }
  set className(v) { this.attrs.class = v; }
  set textContent(v) { this._text = String(v ?? ''); this.children.forEach(n => { n.parentNode = null; }); this.children = []; }
  get textContent() { return this._text + this.children.map(n => n.textContent).join(''); }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
    if (k === 'hidden') this.hidden = true;
    if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(v);
    if (k === 'value') this.value = String(v);
  }
  getAttribute(k) { return this.attrs[k] ?? null; }
  removeAttribute(k) { delete this.attrs[k]; }
  appendChild(n) { if (n.parentNode) n.remove(); this.children.push(n); n.parentNode = this; return n; }
  insertBefore(n, before) {
    if (n.parentNode) n.remove();
    const i = this.children.indexOf(before);
    if (i < 0) this.children.push(n); else this.children.splice(i, 0, n);
    n.parentNode = this; return n;
  }
  remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  fire(type, extra = {}) {
    const e = { target: this, preventDefault() {}, ...extra };
    let n = this;
    while (n) { for (const fn of n.listeners[type] || []) fn(e); n = n.parentNode; }
  }
  click() { if (!this.disabled) { this.focus(); this.fire('click'); } }
  focus() { this.doc.activeElement = this; }
  setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; }
  contains(n) { return n === this || this.children.some(c => c.contains(n)); }
  matches(selector) {
    if (selector.includes(' > ')) {
      const [parent, child] = selector.split(' > ');
      return this.matches(child) && this.parentNode?.matches(parent);
    }
    if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1));
    if (selector.startsWith('[')) return this.getAttribute(selector.slice(1, -1)) !== null;
    return this.tagName === selector.toUpperCase();
  }
  closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest(selector) || null; }
  querySelectorAll(selector) {
    return this.children.flatMap(n => [...(n.matches(selector) ? [n] : []), ...n.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
export function harness(overrides = {}) {
  const doc = { readyState: 'loading', activeElement: null, events: {},
    addEventListener(type, fn) { this.events[type] = fn; },
    createElement(tag) { return new Element(tag, this); },
    createElementNS(_ns, tag) { return this.createElement(tag); },
  };
  const root = doc.createElement('root'); const stack = [root];
  for (const token of html.matchAll(/<!--[\s\S]*?-->|<![^>]*>|<\/?[a-z][^>]*>|[^<]+/gi)) {
    const text = token[0];
    if (text.startsWith('<!')) continue;
    if (text.startsWith('</')) { stack.pop(); continue; }
    if (text.startsWith('<')) {
      const tag = text.match(/^<([a-z0-9]+)/i)[1]; const n = doc.createElement(tag);
      for (const a of text.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) if (a[1] !== tag) n.setAttribute(a[1], a[2] ?? '');
      stack.at(-1).appendChild(n);
      if (!['meta', 'link', 'input'].includes(tag)) stack.push(n);
    } else stack.at(-1)._text += text;
  }
  doc.getElementById = id => [root, ...root.querySelectorAll('[id]')].find(n => n.getAttribute('id') === id) || null;
  const calls = []; const windowEvents = {};
  const route = { providers: [{ name: 'alpha', models: ['one', 'two'] }], routes: [{ scope: 'global', field: 'default', target: 'alpha,one', fallback: [] }], familyRouting: false, fallbackEnabled: true, revision: '1' };
  const clients = { clients: [{ id: 'pi', name: 'Pi', enabled: true, managed: true, exists: true, activeModel: 'one', modelAlias: null }], success: true, message: null };
  const responses = {
    quota_snapshot: () => ({ providers: [], online: false, error: null, updatedAt: null }),
    service_snapshot: () => ({ mode: 'external', running: true, message: '' }),
    routing_snapshot: () => structuredClone(route),
    routing_save: args => {
      const c = args.change; route.revision = String(+route.revision + 1);
      route.routes = route.routes.filter(r => !(r.scope === c.scope && r.field === c.field));
      if (c.target) route.routes.push({ scope: c.scope, field: c.field, target: c.target, fallback: c.fallback || [] });
      return structuredClone(route);
    },
    clients_snapshot: () => structuredClone(clients),
    clients_update: () => ({ ...clients, clients: [{ ...clients.clients[0], enabled: false, managed: false }] }),
    usage_snapshot: args => ({ period: args.period, totalRequests: 12, successCount: 10, errorCount: 2, inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCount: 1, byProvider: [{ name: '<img src=x>', requests: 12, inputTokens: 100, outputTokens: 50 }], byDay: [], updatedAt: 1 }),
    usage_records: args => ({ period: args.period || 'today', page: args.page || 1, pageSize: args.pageSize || 20, total: 0, records: [] }),
    ...overrides,
  };
  const win = { __TAURI__: { core: { invoke(cmd, args) {
    calls.push({ cmd, args });
    return Promise.resolve().then(() => responses[cmd]?.(args));
  } } }, addEventListener(type, fn) { windowEvents[type] = fn; } };
  vm.runInNewContext(projectsJs + js, { document: doc, window: win, location: { search: '?preview=1' }, setTimeout, setInterval, clearInterval });
  doc.events.DOMContentLoaded();
  return { doc, calls, route, id: id => doc.getElementById(id), focusWindow: () => windowEvents.focus() };
}

test('interaction: tab keyboard, external stop disabled, offline quota never shows fake empty state', async () => {
  const h = harness(); await flush();
  assert.equal(h.id('empty').hidden, true);
  assert.equal(h.id('service-stop').disabled, true);
  h.id('service-stop').click();
  assert.equal(h.calls.some(c => c.cmd === 'service_action'), false);
  h.id('tab-quota').fire('keydown', { key: 'ArrowRight' }); await flush();
  assert.equal(h.id('tab-routing').getAttribute('aria-selected'), 'true');
  assert.equal(h.doc.activeElement, h.id('tab-routing'));
  assert.equal(h.id('panel-routing').hidden, false);
});

test('interaction: typing, focus, explicit refresh and tab switch preserve drafts; save only on click', async () => {
  const h = harness(); await flush(); h.id('tab-routing').click(); await flush();
  const input = h.id('routing-body').querySelector('.route-input');
  input.focus(); input.value = 'alpha,two'; input.setSelectionRange(5, 5); input.fire('input');
  const before = h.calls.length; h.focusWindow(); await flush();
  assert.deepEqual(h.calls.slice(before).map(c => c.cmd), ['service_snapshot'], 'focus refreshes service state without refetching route drafts');
  h.id('routing-refresh').click(); await flush();
  assert.equal(h.id('routing-body').querySelector('.route-input'), input, 'refresh keeps input node');
  assert.equal(input.value, 'alpha,two');
  h.id('tab-usage').click(); await flush(); h.id('tab-routing').click();
  assert.equal(input.value, 'alpha,two');
  assert.equal(h.calls.filter(c => c.cmd === 'routing_save').length, 0);
  h.id('routing-body').querySelector('.route-save').click(); await flush();
  assert.equal(h.calls.filter(c => c.cmd === 'routing_save').length, 1);
  assert.match(h.id('routing-body').textContent, /已保存/);
});

test('interaction: fallback add fires once, keyboard add, move/remove and explicit save', async () => {
  const h = harness(); await flush(); h.id('tab-routing').click(); await flush();
  const card = h.id('routing-body').children[0];
  const add = card.querySelector('.fallback-add'); const input = add.querySelector('input');
  input.value = 'alpha,one'; add.querySelector('button').click();
  assert.equal(card.querySelectorAll('.fallback-item').length, 1);
  assert.equal(input.getAttribute('aria-invalid'), null);
  input.value = 'alpha,two'; input.fire('keydown', { key: 'Enter' });
  card.querySelectorAll('.fallback-item')[1].querySelector('button').click();
  assert.match(card.querySelector('.fallback-item').textContent, /alpha,two/);
  card.querySelectorAll('.fallback-item')[1].querySelectorAll('button')[2].click();
  card.querySelector('.route-save').click(); await flush();
  assert.deepEqual(Array.from(h.calls.find(c => c.cmd === 'routing_save').args.change.fallback), ['alpha,two']);
});

test('interaction: usage totals and model/provider/date cache preserve exact counts across periods', async () => {
  const h = harness({ usage_snapshot: args => ({ period: args.period, totalRequests: 3, inputTokens: args.period === '7d' ? 2000000 : 1000000, effectiveInputTokens: args.period === '7d' ? 10001250 : 9001250, outputTokens: 250000, cacheReadTokens: 8000000, cacheWriteTokens: 1250,
    byModel: [{ name: '<img src=model>', requests: 3, inputTokens: 1000000, effectiveInputTokens: 9001250, outputTokens: 250000, cacheReadTokens: 8000000, cacheWriteTokens: 1250 }, { name: 'zero-cache', requests: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, { name: 'unknown-input', outputTokens: 100 }],
    byProvider: [{ name: '<img src=provider>', requests: 3, inputTokens: args.period === '7d' ? 2000000 : 1000000, effectiveInputTokens: args.period === '7d' ? 10001250 : 9001250, outputTokens: 250000, cacheReadTokens: 8000000, cacheWriteTokens: 1250 }, { name: 'zero-cache', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, { name: 'unknown-output', inputTokens: 100 }],
    byDay: [{ name: '2026-11-17', requests: 3, inputTokens: args.period === '7d' ? 2000000 : 1000000, effectiveInputTokens: args.period === '7d' ? 10001250 : 9001250, outputTokens: 250000, cacheReadTokens: 8000000, cacheWriteTokens: 1250 }, { name: '2026-11-16', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, { name: '2026-11-15', outputTokens: 100 }], updatedAt: 1 }) });
  await flush(); h.id('tab-usage').click(); await flush();
  const body = h.id('usage-body');
  const total = body.querySelectorAll('.usage-cell').find(n => n.textContent.includes('总 tokens'));
  assert.match(total.textContent, /9.25M/);
  assert.equal(total.querySelector('.usage-num').title, '9,251,250');
  const cell = label => body.querySelectorAll('.usage-cell').find(n => n.textContent.includes(label)).querySelector('.usage-num');
  assert.equal(cell('缓存命中率').textContent, '88.9%');
  assert.equal(cell('输入（未命中）').title, '1,001,250');
  const models = body.querySelectorAll('.usage-card').find(n => n.textContent.includes('按模型'));
  assert.ok(models.querySelectorAll('th').some(n => n.textContent === '缓存读'));
  assert.equal(models.querySelectorAll('th').at(-1).textContent, '总 tokens');
  const modelRows = models.querySelectorAll('tbody')[0].children;
  assert.equal(modelRows[0].children.at(-1).textContent, '9.25M');
  assert.equal(modelRows[0].children.at(-1).title, '9,251,250');
  assert.equal(modelRows[1].children.at(-1).textContent, '0');
  assert.equal(modelRows[2].children.at(-1).textContent, '—');
  assert.equal(modelRows[0].children[4].textContent, '8M');
  assert.equal(modelRows[0].children[5].textContent, '1.25K');
  assert.equal(models.querySelectorAll('img').length, 0);
  assert.equal(modelRows[0].children[4].title, '8,000,000');
  const providers = body.querySelectorAll('.usage-card').find(n => n.textContent.includes('按提供方'));
  assert.deepEqual(providers.querySelectorAll('th').map(n => n.textContent), ['提供方', '请求', '输入（未命中）', '输出', '缓存读', '缓存写', '总 tokens']);
  const providerRows = providers.querySelectorAll('tbody')[0].children;
  assert.equal(providerRows[0].children.at(-1).textContent, '9.25M');
  assert.equal(providerRows[0].children.at(-1).title, '9,251,250');
  assert.equal(providerRows[0].children[2].title, '1,001,250');
  assert.equal(providerRows[0].children[4].textContent, '8M');
  assert.equal(providerRows[0].children[4].title, '8,000,000');
  assert.equal(providerRows[1].children.at(-1).textContent, '0');
  assert.equal(providerRows[1].children[4].textContent, '0');
  assert.equal(providerRows[2].children.at(-1).textContent, '—');
  assert.equal(providerRows[2].children[4].textContent, '—');
  assert.equal(providers.querySelectorAll('img').length, 0);
  const days = body.querySelectorAll('.usage-card').find(n => n.textContent.includes('按日期'));
  assert.deepEqual(days.querySelectorAll('th').map(n => n.textContent), ['日期', '请求', '输入（未命中）', '输出', '缓存读', '缓存写', '总 tokens']);
  const dayRows = days.querySelectorAll('tbody')[0].children;
  assert.equal(dayRows[0].children.at(-1).textContent, '9.25M');
  assert.equal(dayRows[0].children.at(-1).title, '9,251,250');
  assert.equal(dayRows[0].children[4].textContent, '8M');
  assert.equal(dayRows[0].children[4].title, '8,000,000');
  assert.equal(dayRows[1].children.at(-1).textContent, '0');
  assert.equal(dayRows[1].children[4].textContent, '0');
  assert.equal(dayRows[2].children.at(-1).textContent, '—');
  assert.equal(dayRows[2].children[4].textContent, '—');
  h.id('usage-periods').children[1].click(); await flush();
  assert.match(body.querySelectorAll('.usage-cell').find(n => n.textContent.includes('总 tokens')).textContent, /10.25M/);
  const refreshedProviders = body.querySelectorAll('.usage-card').find(n => n.textContent.includes('按提供方'));
  assert.equal(refreshedProviders.querySelectorAll('tbody')[0].children[0].children.at(-1).textContent, '10.25M');
  const refreshedDays = body.querySelectorAll('.usage-card').find(n => n.textContent.includes('按日期'));
  assert.equal(refreshedDays.querySelectorAll('tbody')[0].children[0].children.at(-1).textContent, '10.25M');
});

test('interaction: 77k inclusive input with 76k cache reads shows 1k misses and a 98.7% hit rate', async () => {
  const row = { inputTokens: 750, effectiveInputTokens: 77000, outputTokens: 200, cacheReadTokens: 76000, cacheWriteTokens: 250 };
  const h = harness({ usage_snapshot: () => ({ ...row, byModel: [], byProvider: [], byDay: [] }) });
  await openUsage(h);
  const cells = h.id('usage-body').querySelectorAll('.usage-cell');
  const value = label => cells.find(c => c.textContent.includes(label)).querySelector('.usage-num');
  assert.equal(value('输入（未命中）').title, '1,000');
  assert.equal(value('缓存读').title, '76,000');
  assert.equal(value('缓存命中率').textContent, '98.7%');
  assert.equal(value('总 tokens').title, '77,200');
});

test('interaction: ambiguous legacy cache leaves derived totals, inputs and hit rates unavailable', async () => {
  const row = { inputTokens: 100, outputTokens: 5, cacheReadTokens: 50, cacheWriteTokens: 30 };
  const h = harness({
    usage_snapshot: () => ({ ...row, byModel: [{ ...row, name: 'model' }], byDay: [{ ...row, name: '2026-11-17' }] }),
    usage_records: () => ({ records: [row, { ...row, effectiveInputTokens: 180, usageEstimated: true }] }),
  });
  await openUsage(h);
  const body = h.id('usage-body');
  const cell = label => body.querySelectorAll('.usage-cell').find(n => n.textContent.includes(label)).querySelector('.usage-num');
  assert.equal(cell('缓存命中率').textContent, '—');
  assert.equal(cell('输入（未命中）').textContent, '—');
  assert.equal(cell('总 tokens').textContent, '—');
  assert.equal(cell('缓存读').textContent, '50');
  assert.equal(body.querySelector('.usage-hbar-total').textContent, '—');
  const rows = recordsCard(body).querySelector('tbody').children;
  assert.equal(rows[0].children[4].textContent, '—');
  assert.equal(rows[1].children[4].textContent, '≈130');
});

test('interaction: restore is local confirmation then single individual IPC; usage uses safe text', async () => {
  const h = harness(); await flush(); h.id('tab-clients').click(); await flush();
  const list = h.id('clients-list');
  list.querySelector('.btn-danger-quiet').click();
  assert.match(list.textContent, /恢复会改写/);
  assert.equal(h.calls.some(c => c.cmd === 'clients_update'), false);
  list.querySelector('.btn-danger').click(); await flush();
  const updates = h.calls.filter(c => c.cmd === 'clients_update');
  assert.equal(updates.length, 1); assert.equal(updates[0].args.id, 'pi'); assert.equal(updates[0].args.action, 'restore');
  assert.match(list.textContent, /未接入/);
  h.id('tab-usage').click(); await flush();
  assert.match(h.id('usage-body').textContent, /<img src=x>/);
  assert.equal(h.id('usage-body').querySelectorAll('img').length, 0);
  h.id('usage-periods').children[1].click(); await flush();
  assert.equal(h.calls.filter(c => c.cmd === 'usage_snapshot').at(-1).args.period, '7d');
});

const recordFixture = (i, extra = {}) => ({
  timestamp: '2026-11-17T09:05:03Z', provider: '<img src=x onerror=alert(1)>',
  model: '<b>bold</b>-model', originalModel: null, upstreamModel: null,
  clientType: 'claude-code', scenarioType: 'default',
  inputTokens: 10 + i, outputTokens: 5 + i, cacheReadTokens: 0, cacheWriteTokens: 0,
  ttftMs: 300 + i, tokensPerSecond: 12.5, durationMs: 1500 + i,
  status: 'success', usageEstimated: false, errorMessage: null,
  // Never projected by the real backend; the render must not echo them.
  responseBody: 'SECRET-BODY', sessionId: 'session-1',
  ...extra,
});

function recordsHarness() {
  const all = Array.from({ length: 45 }, (_, i) => recordFixture(i,
    i === 2 ? { status: 'error', errorMessage: '上游提供方返回 429', ttftMs: null, tokensPerSecond: null } : {},
  ));
  all[3].usageEstimated = true;
  return harness({ usage_records: args => {
    const page = Math.max(1, args.page || 1);
    const size = Math.min(50, Math.max(1, args.pageSize || 20));
    const start = (page - 1) * size;
    return { period: args.period, page, pageSize: size, total: all.length, records: all.slice(start, start + size) };
  } });
}

function recordsCard(body) { return body.querySelectorAll('.records-card').at(-1); }
const plain = (v) => JSON.parse(JSON.stringify(v));

async function openUsage(h) { await flush(); h.id('tab-usage').click(); await flush(); }

test('interaction: records pager walks pages, resets on period switch, shows page/total info', async () => {
  const h = recordsHarness(); await openUsage(h);
  const body = h.id('usage-body');
  const card = recordsCard(body);
  assert.ok(card, 'records card renders inside usage-body');
  const info = card.querySelector('.records-info');
  const prev = card.querySelectorAll('.btn')[0];
  const next = card.querySelectorAll('.btn')[1];
  assert.match(info.textContent, /第 1 \/ 3 页 · 共 45 条/);
  assert.equal(prev.disabled, true, 'prev disabled on the first page');
  assert.equal(next.disabled, false);
  assert.equal(card.querySelectorAll('tbody')[0].children.length, 20);
  next.click(); await flush();
  assert.deepEqual(plain(h.calls.filter(c => c.cmd === 'usage_records').at(-1).args), { period: 'today', page: 2, pageSize: 20 });
  const card2 = recordsCard(body);
  assert.match(card2.querySelector('.records-info').textContent, /第 2 \/ 3 页/);
  assert.equal(card2.querySelectorAll('tbody')[0].children.length, 20);
  assert.equal(card2.querySelectorAll('.btn')[0].disabled, false, 'prev re-enabled on page 2');
  card2.querySelectorAll('.btn')[1].click(); await flush();
  const card3 = recordsCard(body);
  assert.match(card3.querySelector('.records-info').textContent, /第 3 \/ 3 页/);
  assert.equal(card3.querySelectorAll('tbody')[0].children.length, 5);
  assert.equal(card3.querySelectorAll('.btn')[1].disabled, true, 'next disabled on the last page');
  card3.querySelectorAll('.btn')[1].click(); await flush();
  assert.equal(h.calls.filter(c => c.cmd === 'usage_records').at(-1).args.page, 3, 'next on the last page never hits IPC');
  card3.querySelectorAll('.btn')[0].click(); await flush();
  assert.deepEqual(plain(h.calls.filter(c => c.cmd === 'usage_records').at(-1).args), { period: 'today', page: 2, pageSize: 20 });
  // Period switch resets to page 1 for both summary and records.
  h.id('usage-periods').children[1].click(); await flush();
  assert.deepEqual(plain(h.calls.filter(c => c.cmd === 'usage_records').at(-1).args), { period: '7d', page: 1, pageSize: 20 });
  assert.match(recordsCard(body).querySelector('.records-info').textContent, /第 1 \/ 3 页 · 共 45 条/);
});

test('interaction: records table never echoes responseBody/sessionId and keeps XSS as text', async () => {
  const h = recordsHarness(); await openUsage(h);
  const body = h.id('usage-body');
  const text = body.textContent;
  assert.equal(text.includes('SECRET-BODY'), false, 'responseBody never renders');
  assert.equal(text.includes('session-1'), false, 'sessionId never renders');
  assert.ok(text.includes('<img src=x onerror=alert(1)>'), 'provider renders as escaped text');
  assert.ok(text.includes('<b>bold</b>-model'), 'model renders as escaped text');
  assert.equal(body.querySelectorAll('img').length, 0);
  assert.equal(body.querySelectorAll('b').length, 0);
  // Error record: red dot with the message only as tooltip, not as text.
  const rows = recordsCard(body).querySelectorAll('tbody')[0].children;
  const statusCells = rows.map(r => r.children.at(-1));
  const errorCell = statusCells.find(td => td.querySelector('.record-dot').getAttribute('data-tone') === 'error');
  assert.ok(errorCell, 'an error record is present on page 1');
  assert.equal(errorCell.title, '上游提供方返回 429');
  assert.equal(errorCell.textContent.includes('上游提供方返回 429'), false, 'error message stays a tooltip');
  const successCell = statusCells.find(td => td.querySelector('.record-dot').getAttribute('data-tone') === 'ok');
  assert.equal(successCell.title, '成功');
  // Estimated record: ≈ prefix on cells and their tooltips.
  const estimatedRow = rows.find(r => r.children[4].textContent.startsWith('≈'));
  assert.ok(estimatedRow, 'estimated row carries the ≈ prefix');
  assert.equal(estimatedRow.children[5].textContent.startsWith('≈'), true);
  assert.match(estimatedRow.children[4].title, /^≈\d/, 'tooltip also marks the estimated count');
  // Model chain column: originalModel/routed model chain in text, full chain as title.
  const modelCell = rows[0].children[2];
  assert.equal(modelCell.className.includes('cell-truncate'), true);
  assert.equal(modelCell.title, '<b>bold</b>-model');
});

test('interaction: records empty period shows the shared empty note and disables both pager buttons', async () => {
  const h = harness({ usage_records: args => ({ period: args.period, page: args.page || 1, pageSize: args.pageSize || 20, total: 0, records: [] }) });
  await openUsage(h);
  const card = recordsCard(h.id('usage-body'));
  assert.match(card.textContent, /该周期暂无调用记录/);
  assert.match(card.querySelector('.records-info').textContent, /第 1 \/ 1 页 · 共 0 条/);
  const buttons = card.querySelectorAll('.btn');
  assert.equal(buttons[0].disabled, true);
  assert.equal(buttons[1].disabled, true);
});

test('interaction: records error surfaces a failed note while the usage summary stays intact', async () => {
  const h = harness({ usage_records: () => Promise.reject(new Error('网关超时')) });
  await openUsage(h);
  const card = recordsCard(h.id('usage-body'));
  const note = card.querySelector('.note');
  assert.match(note.textContent, /调用记录读取失败：网关超时/);
  assert.equal(note.getAttribute('data-tone'), 'error');
  const buttons = card.querySelectorAll('.btn');
  assert.equal(buttons[0].disabled, true);
  assert.equal(buttons[1].disabled, true);
  assert.match(h.id('usage-body').textContent, /汇总 · 今天/, 'summary rendering unaffected by records failure');
});

test('interaction: summary gains ttft/speed/success cells and css charts sort, floor and cap at 10', async () => {
  const models = Array.from({ length: 12 }, (_, i) => ({
    name: 'model-' + i, requests: i + 1,
    inputTokens: i === 11 ? 5000 : i * 100, effectiveInputTokens: i === 11 ? 5010 : i * 100 + 10, outputTokens: i === 11 ? 1000 : i * 10,
    cacheReadTokens: 7, cacheWriteTokens: 3,
  }));
  const h = harness({ usage_snapshot: args => ({ period: args.period, totalRequests: 10, successCount: 8, errorCount: 2,
    avgTtftMs: 812, avgTokensPerSecond: 33.42,
    inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCount: 0,
    byModel: models,
    byProvider: [],
    byDay: [
      { name: '2026-11-18', requests: 1, inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { name: '2026-11-16', requests: 1, inputTokens: 900, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { name: '2026-11-17', requests: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ], updatedAt: 1 }) });
  await openUsage(h);
  const body = h.id('usage-body');
  const numCell = label => body.querySelectorAll('.usage-cell').find(n => n.textContent.includes(label)).querySelector('.usage-num');
  assert.equal(numCell('成功率').textContent, '80.0%');
  assert.equal(numCell('平均 TTFT').textContent, '812ms');
  assert.equal(numCell('生成速度').textContent, '33.4 t/s');
  // Cards order: summary → charts → detail tables → records.
  const titles = body.querySelectorAll('.usage-card').map(c => c.querySelector('.usage-title').textContent);
  assert.deepEqual(titles.slice(0, 6), ['汇总 · 今天', '每日用量（有效输入 + 输出）', '模型 Top 10（按有效总量）', '按模型', '按提供方', '按日期']);
  // Daily chart: ascending dates, max day 100%, zero day floored at 4%.
  const dayCard = body.querySelectorAll('.usage-card').find(c => c.textContent.includes('每日用量'));
  const bars = dayCard.querySelectorAll('.usage-bar');
  assert.equal(bars.length, 3);
  assert.ok(bars[0].title.startsWith('2026-11-16'), 'bars ordered by date ascending');
  assert.equal(bars[0].style.height, '100%');
  assert.equal(bars[0].title.includes('输入（未命中） 900（900）'), true);
  assert.ok(bars[0].title.includes('总量 1.3K（1,300）'));
  assert.equal(bars[1].title.startsWith('2026-11-17'), true);
  assert.equal(bars[1].style.height, '4%', 'zero-token days floor at the minimum height');
  assert.equal(bars[2].title.startsWith('2026-11-18'), true);
  assert.equal(bars[2].style.height, '12%', 'smaller days scale relative to the max');
  assert.ok(dayCard.querySelector('.usage-chart-axis').textContent.includes('2026-11-16'));
  assert.ok(dayCard.querySelector('.usage-chart-axis').textContent.includes('2026-11-18'));
  // Model chart: ranked by effective (cache-aware) input+output desc, capped at 10, exact values in title.
  const modelCard = body.querySelectorAll('.usage-card').find(c => c.textContent.includes('模型 Top 10'));
  const rows = modelCard.querySelectorAll('.usage-hbar-row');
  assert.equal(rows.length, 10);
  assert.ok(rows[0].textContent.includes('model-11'), 'largest total ranks first');
  assert.ok(rows[1].textContent.includes('model-10'));
  assert.ok(!rows.some(r => r.textContent.includes('model-0')), 'smallest models are cut by the top-10 cap');
  assert.equal(rows[0].querySelector('.usage-hbar-fill').style.width, '100%');
  assert.ok(rows[0].querySelector('.usage-hbar-name').title.includes('请求 12 · 输入（未命中） 5,003 · 输出 1,000 · 缓存读 7 / 缓存写 3'));
  assert.ok(rows[0].querySelector('.usage-hbar-total').textContent.includes('6.01K'), 'model-11 effective total 6010');
  // Structural safeguards against horizontal overflow at 440px (visual check in preview browser).
  assert.ok(dayCard.querySelector('.usage-bars'));
  assert.ok(recordsCard(body).querySelector('.records-scroll'));
});

test('interaction: charts and records fall back to the shared empty note when a period has no data', async () => {
  const h = harness({ usage_snapshot: args => ({ period: args.period, totalRequests: 0, successCount: 0, errorCount: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCount: 0,
    avgTtftMs: null, avgTokensPerSecond: null,
    byModel: [], byProvider: [], byDay: [], updatedAt: 1 }) });
  await openUsage(h);
  const body = h.id('usage-body');
  const cards = body.querySelectorAll('.usage-card');
  const titledCard = (label) => cards.find(c => { const t = c.querySelector('.usage-title'); return t && t.textContent.includes(label); });
  const dayCard = titledCard('每日用量');
  const modelCard = titledCard('模型 Top 10');
  assert.ok(dayCard && dayCard.textContent.includes('该周期暂无调用记录'), 'daily chart renders the shared empty note');
  assert.ok(modelCard && modelCard.textContent.includes('该周期暂无调用记录'), 'model chart renders the shared empty note');
  const numCell = label => body.querySelectorAll('.usage-cell').find(n => n.textContent.includes(label)).querySelector('.usage-num');
  assert.equal(numCell('成功率').textContent, '—', 'total=0 keeps the success rate unset');
  assert.equal(numCell('平均 TTFT').textContent, '—');
  assert.equal(numCell('生成速度').textContent, '—');
});

test('Step Plan card preserves exact Credit and replaces account data on each refresh', async () => {
  const observedAt = new Date(2026, 9, 1, 8).getTime();
  const day = 86400000;
  const plan = {
    state: 'partial', family: 'token', name: 'Token Plus', observedAt, allowed: true, windows: [],
    creditBuckets: [
      { type: 'subscription', total: '9007199254740993.0100', remaining: '0', usedPercent: 100, expiresAt: observedAt + 30 * day },
      { type: 'topup', total: '100.00', remaining: '99.75', usedPercent: 0.25, resetsAt: observedAt + day, expiresAt: observedAt + 2 * day },
      { type: 'topup', total: '20', remaining: '20', usedPercent: null, expiresAt: observedAt + 4 * day },
    ],
  };
  let current = plan;
  const h = harness({ quota_snapshot: () => ({ providers: [{ name: 'step', status: current.state === 'unavailable' ? 'unavailable' : 'ready', stepPlan: current }], online: true }) });
  await flush();
  const card = h.id('list').querySelector('.card');
  const windows = () => card.querySelectorAll('.window');
  const refresh = async next => { current = next; h.id('refresh-all').click(); await flush(); };
  assert.match(card.textContent, /Token Plus.*部分数据.*账户可用.*观测于 10月1日/s);
  assert.equal(windows().length, 3);
  assert.match(windows()[0].textContent, /月度订阅 Credit.*已用 100%.*剩余 0 \/ 总量 9007199254740993\.0100 Credit.*到期 10月31日/);
  assert.doesNotMatch(windows()[0].textContent, /重置/);
  assert.match(windows()[1].textContent, /加油包 1 Credit.*已用 0\.25%.*99\.75.*100\.00.*重置 10月2日.*到期 10月3日/);
  assert.equal(windows()[1].querySelector('progress').value, '0.25');
  assert.match(windows()[2].textContent, /加油包 2 Credit—.*到期 10月5日/);
  assert.equal(windows()[2].querySelector('progress'), null);
  const coding = { state: 'stale', family: 'coding', name: 'Legacy', observedAt, allowed: false, windows: [
    { id: 'five_hour', limited: true, usedPercent: 0, resetsAt: observedAt + day },
    { id: 'weekly', limited: false, usedPercent: null },
  ] };
  await refresh(coding);
  assert.match(card.textContent, /Legacy.*数据已陈旧.*账户不可用.*5 小时已用 0%.*重置.*7 天无限额/s);
  assert.doesNotMatch(card.textContent, /Token Plus|Credit/);
  assert.equal(windows()[0].querySelector('progress').value, '0');
  assert.equal(windows()[1].querySelector('progress'), null);
  await refresh({ ...coding, windows: [{ id: 'weekly', limited: true, usedPercent: null }] });
  assert.equal(windows()[0].textContent, '7 天—');
  await refresh({ state: 'unavailable', family: 'none' });
  assert.match(card.textContent, /不可用/);
  assert.doesNotMatch(card.textContent, /Token Plus|Credit|Legacy|7 天|账户可用|观测于/);
  assert.equal(windows().length, 0);
});
