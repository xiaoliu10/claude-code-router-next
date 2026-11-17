// Dependency-free DOM harness: exercises actual event handlers and DOM updates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const js = readFileSync(new URL('../src/quota.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../src/quota.html', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

class Element {
  constructor(tag, doc) {
    this.tagName = tag.toUpperCase(); this.doc = doc;
    this.children = []; this.parentNode = null; this.attrs = {}; this.dataset = {};
    this.listeners = {}; this._text = ''; this.value = ''; this.hidden = false;
    this.disabled = false; this.selectionStart = 0; this.selectionEnd = 0;
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
function harness(overrides = {}) {
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
    ...overrides,
  };
  const win = { __TAURI__: { core: { invoke(cmd, args) {
    calls.push({ cmd, args });
    return Promise.resolve().then(() => responses[cmd]?.(args));
  } } }, addEventListener(type, fn) { windowEvents[type] = fn; } };
  vm.runInNewContext(js, { document: doc, window: win, location: { search: '?preview=1' }, setTimeout, setInterval, clearInterval });
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
  assert.equal(h.calls.length, before, 'focus on routing never refetches');
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
