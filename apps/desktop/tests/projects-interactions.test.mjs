import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './control-center-interactions.test.mjs';
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
function fixture() {
  const state = {
    providers: [{ name: 'alpha', models: ['one', 'two'] }],
    globalRouter: { default: 'alpha,one', fallback: { default: ['alpha,two'] }, enableFallback: true },
    projects: [
      { id: 'a', path: '/real/Alpha', revision: 'a1', useGlobal: true, router: {}, takeoverClients: ['claudeCode'] },
      { id: 'b', path: '/real/Beta', revision: 'b1', useGlobal: false, router: { default: 'alpha,two' }, takeoverClients: [] },
    ],
  };
  return state;
}
const byLabel = (h, label) => h.id('projects-body').querySelectorAll('input').find(n => n.getAttribute('aria-label') === label);
const button = (h, text) => h.id('projects-body').querySelectorAll('button').find(n => n.textContent === text);
function toggle(h, label, value) { const n = byLabel(h, label); n.checked = value; n.fire('change'); }
function type(h, label, value) { const n = byLabel(h, label); n.focus(); n.value = value; n.fire('input'); return n; }
function select(h, id) { h.id('projects-select').value = id; h.id('projects-select').fire('change'); }
async function start(overrides = {}) {
  const state = fixture();
  const h = harness({ projects_snapshot: () => structuredClone(state), ...overrides }); await flush();
  assert.equal(h.calls.some(c => c.cmd === 'projects_snapshot'), false);
  h.id('tab-projects').click(); await flush();
  return { h, state };
}

test('projects interaction: first activation lists real snapshot projects and global preview is readonly', async () => {
  const { h } = await start();
  assert.equal(h.id('projects-select').children.length, 2);
  assert.match(h.id('projects-count').textContent, /2/);
  assert.match(h.id('projects-body').textContent, /\/real\/Alpha/);
  assert.equal(byLabel(h, '默认 目标').disabled, true);
  assert.equal(byLabel(h, '默认 目标').value, 'alpha,one');
  assert.match(h.id('projects-body').textContent, /默认接管 Claude Code/);
  assert.equal(byLabel(h, 'Codex'), undefined);
});

test('projects interaction: local-only edits, refresh, focus and switching retain independent route and takeover drafts', async () => {
  const { h } = await start(); toggle(h, '使用全局路由', false);
  const input = type(h, '默认 目标', 'alpha,two'); input.setSelectionRange(3, 3);
  h.focusWindow(); await flush(); h.id('projects-refresh').click(); await flush();
  assert.equal(byLabel(h, '默认 目标').value, 'alpha,two');
  toggle(h, 'Pi', true); select(h, 'b'); type(h, '默认 目标', 'alpha,one'); select(h, 'a');
  assert.equal(byLabel(h, '默认 目标').value, 'alpha,two'); assert.equal(byLabel(h, 'Pi').checked, true);
  assert.equal(h.calls.some(c => ['projects_save', 'projects_takeover'].includes(c.cmd)), false);
  assert.equal(h.id('projects-body').querySelectorAll('.route').length, 7);
});

test('projects interaction: failed save retains draft; late save cannot select another project', async () => {
  let rejectSave;
  const { h } = await start({ projects_save: () => new Promise((_, reject) => { rejectSave = reject; }) });
  toggle(h, '使用全局路由', false); type(h, '默认 目标', 'alpha,two'); button(h, '保存项目路由').click(); await flush(); select(h, 'b');
  rejectSave(new Error('private upstream error')); await flush();
  assert.equal(h.id('projects-select').value, 'b'); assert.doesNotMatch(h.id('projects-msg').textContent, /private|失败/);
  select(h, 'a'); assert.match(h.id('projects-msg').textContent, /操作失败/); assert.equal(byLabel(h, '默认 目标').value, 'alpha,two');
});

test('external web takeover changes appear on focus, tab re-entry and refresh all', async () => {
  const { h, state } = await start();
  const pi = () => byLabel(h, 'Pi').checked;
  const external = enabled => { state.projects[0].takeoverClients = enabled ? ['claudeCode', 'pi'] : ['claudeCode']; };
  assert.equal(pi(), false);
  // A draft that the operator returned to its original state is clean.
  toggle(h, 'Pi', true); toggle(h, 'Pi', false);
  external(true); h.focusWindow(); await flush(); assert.equal(pi(), true);
  h.id('tab-routing').click(); external(false); h.id('tab-projects').click(); await flush(); assert.equal(pi(), false);
  external(true); h.id('refresh-all').click(); await flush(); assert.equal(pi(), true);
  assert.equal(h.calls.filter(c => ['projects_takeover', 'projects_save'].includes(c.cmd)).length, 0);
});

test('external takeover changes appear alongside a dirty route draft and preserve the conflict warning', async () => {
  const { h, state } = await start();
  toggle(h, '使用全局路由', false); type(h, '默认 目标', 'alpha,two');
  state.projects[0].takeoverClients.push('pi'); state.projects[0].revision = 'a2';
  h.focusWindow(); await flush();
  assert.equal(byLabel(h, 'Pi').checked, true);
  assert.equal(byLabel(h, '默认 目标').value, 'alpha,two');
  assert.match(h.id('projects-msg').textContent, /外部更新/);
});

test('projects interaction: restore global and takeover each require their explicit action', async () => {
  const state = fixture();
  const { h } = await start({
    projects_save: args => {
      const p = state.projects.find(p => p.id === args.change.id); Object.assign(p, args.change, { revision: 'saved' }); return structuredClone(state);
    },
    projects_takeover: args => {
      const p = state.projects.find(p => p.id === args.id); p.takeoverClients = args.clients; p.revision = 'clients'; return structuredClone(state);
    },
  });
  select(h, 'b'); toggle(h, '使用全局路由', true);
  assert.equal(h.calls.filter(c => c.cmd === 'projects_save').length, 0);
  button(h, '保存项目路由').click(); await flush();
  assert.equal(JSON.stringify(h.calls.find(c => c.cmd === 'projects_save').args.change.router), '{}');
  toggle(h, 'Pi', true); assert.equal(h.calls.filter(c => c.cmd === 'projects_takeover').length, 0);
  button(h, '应用所选客户端').click(); await flush();
  assert.equal(h.calls.find(c => c.cmd === 'projects_takeover').args.id, 'b');
});

test('projects interaction: fallback ordering, family thresholds and deletion confirmation', async () => {
  const state = fixture();
  const { h } = await start({ projects_delete: args => { state.projects = state.projects.filter(p => p.id !== args.id); return structuredClone(state); } });
  toggle(h, '使用全局路由', false);
  type(h, '默认 添加回退', 'alpha,one').fire('keydown', { key: 'Enter' });
  let first = h.id('projects-body').querySelector('.route');
  first.querySelectorAll('.fallback-item')[1].querySelector('button').click();
  first = h.id('projects-body').querySelector('.route'); assert.match(first.querySelector('.fallback-item').textContent, /alpha,one/);
  assert.ok(byLabel(h, '后台 目标'));
  button(h, 'Opus').click(); button(h, '添加家族配置').click();
  assert.ok(byLabel(h, '默认 目标'));
  assert.equal(byLabel(h, '后台 目标'), undefined);
  type(h, '长上下文阈值', '12345');
  button(h, '项目路由').click(); button(h, 'Opus').click(); assert.equal(byLabel(h, '长上下文阈值').value, '12345');
  button(h, '移除项目配置').click(); assert.match(h.id('projects-body').textContent, /移除 CCR 项目配置，不删除项目文件/);
  assert.equal(h.calls.some(c => c.cmd === 'projects_delete'), false); button(h, '取消').click();
  button(h, '移除项目配置').click(); button(h, '确认移除').click(); await flush();
  assert.equal(h.calls.filter(c => c.cmd === 'projects_delete').length, 1);
  assert.equal(h.id('projects-select').value, 'b');
});
