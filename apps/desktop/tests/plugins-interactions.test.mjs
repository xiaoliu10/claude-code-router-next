import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './control-center-interactions.test.mjs';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const pluginCalls = h => h.calls.filter(({ cmd }) => cmd === 'plugin_install' || cmd === 'plugin_action')
  .map(({ cmd, args }) => [cmd, structuredClone(args)]);
const serviceCalls = h => h.calls.filter(({ cmd }) => cmd === 'service_action').map(({ args }) => args.action);
const cards = h => h.id('plugins-list').querySelectorAll('.card');
const buttons = h => h.id('plugins-list').querySelectorAll('button');
const button = (h, label) => buttons(h).find(node => node.getAttribute('aria-label') === label);
const inventory = () => ({ plugins: [
  { id: 'codex', name: 'Codex <img src=x>', version: '1.0.0', loaded: true, actions: ['sync', 'usage', 'disconnect', 'login', '../file', 'usage'], connectionState: 'connected' },
  { id: 'local', name: 'Local', version: null, loaded: false, actions: ['disconnect'] },
  { id: 'kiro', name: 'Kiro', version: '1.2.3', loaded: true, actions: [], connectionState: 'disconnected' },
] });
const catalog = () => ({ partial: true, plugins: [
  { name: '@example/new', description: '<script>demo()</script>', version: '2.0.0', installed: false, installedVersion: null, updateAvailable: false, localOnly: false },
  { name: '@example/update', description: '', version: '3.0.0', installed: true, installedVersion: '2.0.0', installedName: 'update', updateAvailable: true, localOnly: false },
  { name: 'local', description: '', version: '0.4.0', installed: true, installedVersion: '0.4.0', updateAvailable: true, localOnly: true },
  { name: '/tmp/never', description: '', version: '0.4.0', installed: false, installedVersion: null, updateAvailable: false, localOnly: false },
] });

async function open(h, market = false) {
  h.id('tab-plugins').click();
  await flush();
  if (market) { h.id('plugins-market').click(); await flush(); }
}

function confirm(h, label, name) {
  button(h, `${label} ${name}`).click();
  assert.equal(h.id('plugins-confirm').hidden, false);
  assert.ok(h.id('plugins-confirm-text').textContent.includes(name));
  assert.equal(h.doc.activeElement, h.id('plugins-cancel'));
  h.id('plugins-confirm-button').click();
}

test('plugins: lazy mounted tab and advertised actions use manifest ID with explicit disconnect confirmation', async () => {
  const action = deferred();
  const h = harness({ plugin_inventory: inventory, plugin_action: () => action.promise });
  await flush();
  assert.equal(h.calls.some(({ cmd }) => cmd.startsWith('plugin_')), false);
  h.id('tab-quota').fire('keydown', { key: 'End' });
  await flush();
  assert.equal(h.doc.activeElement, h.id('tab-plugins'));
  assert.equal(h.id('panel-plugins').hidden, false);
  assert.equal(h.id('tab-plugins').getAttribute('aria-selected'), 'true');
  assert.match(cards(h)[0].textContent, /Codex <img src=x>.*已加载版本：1\.0\.0.*连接状态：已连接/);
  assert.equal(cards(h)[0].querySelector('img'), null);
  assert.match(cards(h)[1].textContent, /Local.*未加载.*连接状态：未知/);
  assert.match(cards(h)[2].textContent, /Kiro.*已加载.*连接状态：未连接.*没有可在桌面使用/);
  assert.match(h.id('plugins-advanced').textContent, /站点和账号管理.*请使用主窗口/);
  assert.deepEqual(buttons(h).map(node => node.textContent), ['同步模型', '刷新用量', '断开连接']);
  const disconnect = button(h, '断开连接 Codex <img src=x>');
  disconnect.click();
  assert.deepEqual(pluginCalls(h), []);
  h.windowEvents.keydown({ key: 'Escape', preventDefault() {} });
  assert.equal(h.doc.activeElement, disconnect);
  assert.equal(h.calls.some(({ cmd }) => cmd === 'quota_hide'), false);
  disconnect.click();
  h.id('tab-projects').click();
  h.id('tab-plugins').click();
  assert.equal(h.id('plugins-confirm').hidden, true);
  confirm(h, '断开连接', 'Codex <img src=x>');
  assert.equal(h.id('plugins-list').getAttribute('aria-busy'), 'true');
  assert.match(h.id('plugins-feedback').textContent, /正在断开连接/);
  assert.ok(buttons(h).every(node => node.disabled));
  h.id('plugins-confirm-button').click();
  assert.deepEqual(pluginCalls(h), [['plugin_action', { id: 'codex', action: 'disconnect' }]]);
  action.resolve({ success: false, raw: 'not-for-display' });
  await flush();
  assert.match(h.id('plugins-feedback').textContent, /断开连接失败/);
  assert.doesNotMatch(h.id('panel-plugins').textContent, /not-for-display/);
  assert.equal(disconnect.disabled, false);
});

test('plugins: confirmed disconnect refreshes the connection indicator while the plugin stays loaded', async () => {
  const data = inventory();
  const h = harness({ plugin_inventory: () => data, plugin_action: () => {
    data.plugins[0].connectionState = 'disconnected';
    return { success: true };
  } });
  await open(h);
  assert.match(cards(h)[0].textContent, /连接状态：已连接/);
  confirm(h, '断开连接', 'Codex <img src=x>'); await flush();
  assert.match(cards(h)[0].textContent, /已加载版本：1\.0\.0.*连接状态：未连接/);
});

test('plugins: usage feedback distinguishes current, cached, and unavailable readings', async () => {
  let reply;
  const h = harness({ plugin_inventory: inventory, plugin_action: () => reply });
  await open(h);
  for (const [outcome, message] of [['fresh', /已获取当前用量/], ['stale', /仅有上次读取/], ['unavailable', /暂无可用/]]) {
    reply = { usage: outcome, raw: 'private-result' };
    button(h, '刷新用量 Codex <img src=x>').click(); await flush();
    assert.match(h.id('plugins-feedback').textContent, message);
    assert.doesNotMatch(h.id('panel-plugins').textContent, /private-result/);
  }
});

test('plugins: reads recover from fixed errors and distinguish successful empty and partial states', async () => {
  const reading = deferred();
  let first = true;
  let current = { plugins: [] };
  const h = harness({ plugin_inventory: () => {
    if (first) { first = false; return reading.promise; }
    if (current instanceof Error) throw current;
    return current;
  }, plugin_catalog: () => ({ plugins: [], partial: true }) });
  h.id('tab-plugins').click();
  assert.match(h.id('plugins-read-status').textContent, /正在读取已安装/);
  assert.equal(h.id('plugins-refresh').disabled, true);
  assert.doesNotMatch(h.id('plugins-list').textContent, /暂无/);
  reading.reject(new Error('raw-body-token'));
  await flush();
  assert.match(h.id('plugins-read-status').textContent, /无法读取已安装插件/);
  assert.doesNotMatch(h.id('panel-plugins').textContent, /raw-body-token|暂无/);
  h.id('plugins-refresh').click(); await flush();
  assert.match(h.id('plugins-list').textContent, /暂无已安装/);
  h.id('plugins-market').click(); await flush();
  assert.equal(h.id('plugins-market').getAttribute('aria-pressed'), 'true');
  assert.match(h.id('plugins-read-status').textContent, /无法获取完整/);
  assert.match(h.id('plugins-list').textContent, /当前没有可显示/);
  h.id('plugins-installed').click();
  current = inventory();
  h.id('plugins-refresh').click(); await flush();
  assert.equal(buttons(h)[0].disabled, false);
  current = new Error('stale-token');
  h.id('plugins-refresh').click(); await flush();
  assert.equal(cards(h).length, 3);
  assert.ok(buttons(h).every(node => node.disabled));
  assert.match(h.id('plugins-read-status').textContent, /上次读取/);
  assert.doesNotMatch(h.id('panel-plugins').textContent, /stale-token/);
});

test('plugins: market install and update use names, preserve partial results and guide external activation', async () => {
  const install = deferred();
  const market = catalog();
  const h = harness({ plugin_inventory: inventory, plugin_catalog: () => market,
    plugin_install: args => {
      if (args.installed) throw new Error('private-upstream-detail');
      return install.promise;
    },
  });
  await open(h, true);
  assert.match(h.id('plugins-read-status').textContent, /无法获取完整/);
  assert.match(cards(h)[0].textContent, /<script>demo\(\)<\/script>/);
  assert.equal(cards(h)[0].querySelector('script'), null);
  assert.match(cards(h)[1].textContent, /有更新.*已安装版本：2\.0\.0.*市场版本：3\.0\.0/);
  assert.match(cards(h)[2].textContent, /仅本地/);
  assert.deepEqual(buttons(h).map(node => node.textContent), ['安装', '更新']);
  button(h, '安装 @example/new').click();
  assert.match(h.id('plugins-confirm-text').textContent, /@example\/new@2\.0\.0/);
  h.id('plugins-cancel').click();
  assert.deepEqual(pluginCalls(h), []);
  confirm(h, '安装', '@example/new');
  assert.match(h.id('plugins-feedback').textContent, /正在安装/);
  assert.equal(h.id('plugins-installed').disabled, true);
  assert.equal(h.id('plugins-restart').hidden, true);
  market.plugins[0].installed = true;
  market.plugins[0].installedVersion = '2.0.0';
  install.resolve({ restartRequired: true, id: 'new', version: '2.0.0' });
  await flush();
  assert.deepEqual(pluginCalls(h), [['plugin_install', { name: '@example/new', version: '2.0.0', installed: null }]]);
  assert.deepEqual(serviceCalls(h), []);
  assert.match(h.id('plugins-restart').textContent, /1 个插件变更待激活.*外部网关.*手动重启/);
  assert.match(cards(h)[0].textContent, /已安装 · 待激活/);
  assert.equal(h.id('service-stop').disabled, true);
  assert.equal(h.id('service-start').disabled, true);
  assert.equal(button(h, '安装 @example/new'), undefined);
  confirm(h, '更新', '@example/update');
  await flush();
  assert.deepEqual(pluginCalls(h).at(-1), ['plugin_install', { name: '@example/update', version: '3.0.0', installed: { name: 'update', version: '2.0.0' } }]);
  assert.match(h.id('plugins-read-status').textContent, /无法确认更新结果.*刷新/);
  assert.doesNotMatch(h.id('panel-plugins').textContent, /private-upstream-detail/);
  assert.match(h.id('plugins-restart').textContent, /外部网关/);
  assert.equal(button(h, '更新 @example/update').disabled, true);
  h.id('plugins-refresh').click(); await flush();
  assert.equal(button(h, '更新 @example/update').disabled, false);
});

test('plugins: a manual inventory refresh recognizes external activation by manifest id and version', async () => {
  const market = catalog(); let loadedVersion = '2.0.0';
  const h = harness({ plugin_catalog: () => market,
    plugin_inventory: () => ({ plugins: [{ id: 'update', name: 'Demo', loaded: true, version: loadedVersion, actions: [] }] }),
    plugin_install: () => ({ restartRequired: true, id: 'update', version: '3.0.0' }) });
  await open(h, true); confirm(h, '更新', '@example/update'); await flush();
  assert.equal(h.id('plugins-restart').hidden, false);
  loadedVersion = '3.0.0'; market.plugins[1].version = '4.0.0'; market.plugins[1].installedVersion = loadedVersion;
  h.id('plugins-installed').click(); h.id('plugins-refresh').click(); await flush();
  assert.equal(h.id('plugins-restart').hidden, true);
  h.id('plugins-market').click(); h.id('plugins-refresh').click(); await flush();
  assert.ok(button(h, '更新 @example/update'));
});

test('plugins: owned activation requires separate stop and start clicks and refreshes the loaded inventory', async () => {
  let mode = 'owned';
  let activated = false;
  let inventoryReads = 0;
  const snapshot = () => ({ mode, running: mode !== 'stopped', message: '' });
  const market = catalog();
  const h = harness({ service_snapshot: snapshot, service_action: ({ action }) => {
    mode = action === 'stop' ? 'stopped' : 'starting';
    return snapshot();
  }, plugin_inventory: () => {
    inventoryReads += 1;
    return { plugins: [{ id: 'update', name: 'Demo plugin', version: activated ? '3.0.0' : '2.0.0', loaded: true, actions: [], connectionState: 'unknown' }] };
  }, plugin_catalog: () => market, plugin_install: () => {
    market.plugins[1].installedVersion = '3.0.0';
    market.plugins[1].updateAvailable = false;
    return { restartRequired: true, id: 'update', version: '3.0.0' };
  } });
  await open(h, true);
  confirm(h, '更新', '@example/update'); await flush();
  assert.match(cards(h)[1].textContent, /已更新 · 待激活.*已安装版本：3\.0\.0/);
  h.id('plugins-installed').click();
  assert.match(cards(h)[0].textContent, /已加载版本：2\.0\.0.*连接状态：未知/);
  h.id('plugins-market').click();
  assert.match(h.id('plugins-restart').textContent, /托管网关.*「停止」.*「启动」/);
  assert.deepEqual(serviceCalls(h), []);
  h.id('service-stop').click(); await flush();
  assert.deepEqual(serviceCalls(h), ['stop']);
  assert.match(h.id('plugins-restart').textContent, /手动点击「启动」/);
  h.id('service-start').click(); await flush();
  assert.deepEqual(serviceCalls(h), ['stop', 'start']);
  assert.equal(h.id('plugins-restart').hidden, false, 'starting is not yet activated');
  const previousReads = inventoryReads;
  mode = 'owned'; activated = true;
  h.id('service-refresh').click(); await flush();
  assert.equal(h.id('plugins-restart').hidden, true);
  assert.match(h.id('plugins-feedback').textContent, /托管网关已启动/);
  assert.equal(inventoryReads, previousReads + 1);
  assert.doesNotMatch(cards(h)[1].textContent, /待激活/);
  h.id('plugins-installed').click();
  assert.match(h.id('plugins-list').textContent, /Demo plugin.*已加载版本：3\.0\.0/);
});

test('plugins: sync and usage invoke only the selected operation, and stale reads cannot win after install', async () => {
  const stale = deferred();
  let first = true;
  const h = harness({ plugin_inventory: () => {
    if (first) { first = false; return stale.promise; }
    return inventory();
  }, plugin_catalog: catalog, plugin_install: () => ({ restartRequired: false }), plugin_action: () => ({ success: true }) });
  await open(h, true);
  confirm(h, '安装', '@example/new'); await flush();
  assert.equal(h.id('plugins-restart').hidden, true);
  stale.resolve({ plugins: [] });
  await flush();
  h.id('plugins-installed').click();
  button(h, '刷新用量 Codex <img src=x>').click(); await flush();
  button(h, '同步模型 Codex <img src=x>').click(); await flush();
  assert.deepEqual(pluginCalls(h).slice(-2), [
    ['plugin_action', { id: 'codex', action: 'usage' }],
    ['plugin_action', { id: 'codex', action: 'sync' }],
  ]);
  assert.match(h.id('plugins-feedback').textContent, /同步模型完成/);
  assert.deepEqual(serviceCalls(h), []);
});
