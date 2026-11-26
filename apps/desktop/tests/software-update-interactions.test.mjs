import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './control-center-interactions.test.mjs';

const AUTO = 'ccr.desktop.update.autoCheck';
const flush = () => new Promise(resolve => setImmediate(resolve));
const offer = { version: '0.1.2', notes: '改进桌面更新\n<img src=x>\n<script>demo()</script>' };
function setup(overrides = {}, options = {}) {
  const prefs = new Map();
  let progress, stops = 0;
  const h = harness({
    desktop_update_status: () => ({ currentVersion: '0.1.1', supported: true }),
    desktop_update_check: () => offer,
    ...overrides,
  }, {
    windowLabel: 'main',
    storage: { getItem: key => prefs.get(key) ?? null, setItem: (key, value) => prefs.set(key, value) },
    setInterval: () => 1,
    listen: async (name, fn, opts) => {
      assert.equal(name, 'desktop-update-progress');
      assert.deepEqual({ ...opts.target }, { kind: 'WebviewWindow', label: 'main' });
      progress = fn;
      return () => { stops++; };
    }, ...options,
  });
  return { ...h, prefs, emit: payload => progress({ payload }), stops: () => stops,
    count: cmd => h.calls.filter(call => call.cmd === cmd).length };
}

// magpie update-auto / update-check: the stable check button and timer share one in-flight request.
test('software update: auto-checks at startup and every six hours; stable button and isolated preference survive reload', async () => {
  let finish;
  const h = setup({ desktop_update_check: () => new Promise(resolve => { finish = resolve; }) });
  await flush();
  assert.equal(h.count('desktop_update_check'), 1);
  const button = h.id('update-check');
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, '检查更新');
  assert.equal(h.id('update-auto').checked, true);
  assert.deepEqual(h.intervals.map(([, ms]) => ms), [6 * 3600_000]);
  h.intervals[0][0](); button.fire('click');
  assert.equal(h.count('desktop_update_check'), 1);
  finish({ version: null, notes: null }); await flush();
  h.id('tab-settings').click(); await flush();
  assert.equal(h.id('settings-body').hidden, true, 'gateway settings read failed');
  assert.ok(h.id('update-card').offsetParent);
  assert.equal(h.id('update-current-version').textContent, '0.1.1');
  assert.equal(h.id('update-status').textContent, '已是最新版本');
  assert.equal(h.id('update-check'), button); assert.equal(button.disabled, false);
  h.intervals[0][0](); await flush(); assert.equal(h.count('desktop_update_check'), 2);
  finish(offer); await flush();
  const toggle = h.id('update-auto'); toggle.checked = false; toggle.fire('change');
  assert.equal(h.cleared.length, 1); assert.equal(h.prefs.get(AUTO), 'false');
  assert.equal(h.count('general_settings_save'), 0);
  const reopened = setup({}, { storage: h.win.localStorage }); await flush();
  assert.equal(reopened.id('update-auto').checked, false); assert.equal(reopened.intervals.length, 0);
  assert.equal(reopened.count('desktop_update_check'), 0);
  reopened.id('update-check').click(); await flush(); assert.equal(reopened.count('desktop_update_check'), 1);
  reopened.id('update-auto').checked = true; reopened.id('update-auto').fire('change');
  await flush(); assert.equal(reopened.intervals.length, 1); assert.equal(reopened.count('desktop_update_check'), 2);
});

// magpie update-restart / update-download-percent: explicit click after the warning, then shared progress.
test('software update: from quota tab one warned click installs exactly the displayed version and tracks the same progress in Settings', async () => {
  let finish;
  const h = setup({ desktop_update_install: () => new Promise(resolve => { finish = resolve; }) });
  await flush();
  assert.equal(h.id('panel-settings').hidden, true);
  assert.equal(h.id('tab-settings-update').hidden, false);
  assert.ok(h.id('update-notice-install').offsetParent);
  assert.match(h.id('update-notice-warning').textContent, /短暂中断桌面托管的网关/);
  assert.equal(h.count('desktop_update_install'), 0);
  h.id('update-notice-install').click(); h.id('update-notice-install').fire('click'); await flush();
  assert.deepEqual(h.calls.filter(c => c.cmd === 'desktop_update_install').map(c => ({ ...c.args })), [{ version: '0.1.2' }]);
  assert.equal(h.id('update-notice-install').disabled, true);
  h.id('tab-settings').click(); await flush();
  assert.equal(h.id('update-notice').hidden, true);
  assert.equal(h.id('update-install').disabled, true); h.id('update-install').fire('click');
  assert.equal(h.id('update-notes-body').textContent, offer.notes);
  assert.equal(h.id('update-notes-body').children.length, 0);
  const meter = h.id('update-progress');
  for (const [downloaded, total, expected, value] of [[0, 100, /0%/, '0'], [1048576, null, /已下载 1.0 MB/, null], [50, 100, /50%/, '50']]) {
    h.emit({ phase: 'downloading', downloaded, total });
    assert.match(h.id('update-status').textContent, expected);
    if (value === null) assert.doesNotMatch(h.id('update-status').textContent, /%|NaN|Infinity/);
    assert.equal(meter.getAttribute('value'), value); assert.equal(meter.hidden, false);
    assert.equal(h.id('update-notice-status').textContent, h.id('update-status').textContent);
  }
  h.emit({ phase: 'installing', downloaded: 100, total: 100 });
  h.emit({ phase: 'downloading', downloaded: 50, total: 100 });
  assert.equal(h.id('update-status').textContent, '正在安装更新…');
  assert.equal(meter.hidden, true);
  finish(); await flush(); assert.match(h.id('update-status').textContent, /安装程序/);
  assert.equal(h.count('desktop_update_install'), 1); assert.equal(h.stops(), 1);
});

test('software update: native errors select Chinese retry instructions, clear invalid offers, and never echo internal details', async () => {
  let cause = 'UPDATE_CHECK_FAILED';
  const h = setup({ desktop_update_check: () => { if (cause) throw cause; return offer; } });
  await flush();
  for (const [code, hint] of [['UPDATE_CHECK_FAILED', /网络连接/], ['UPDATE_FEED_UNAVAILABLE', /尚未提供桌面更新清单/], ['private-detail', /无法确认最新版本/]]) {
    cause = code; h.id('update-check').click(); await flush();
    assert.match(h.id('update-status').textContent, hint); assert.doesNotMatch(h.id('update-status').textContent, /private-detail/);
    assert.equal(h.id('update-check').disabled, false);
  }
  cause = null; h.id('update-check').click(); await flush(); assert.match(h.id('update-status').textContent, /发现新版本/);
  for (const [code, hint] of [['UPDATE_SIGNATURE_INVALID', /签名无效/], ['UPDATE_INSTALL_FAILED', /安装失败/],
    ['UPDATE_DOWNLOAD_FAILED', /下载失败/], ['UPDATE_BUSY', /进行/]]) {
    const app = setup({ desktop_update_install: () => { throw code; } }); await flush();
    app.id('tab-settings').click(); await flush();
    assert.match(app.id('update-warning').textContent, /短暂中断/);
    app.id('update-install').click(); await flush();
    assert.match(app.id('update-status').textContent, hint);
    assert.equal(app.id('update-install').disabled, true);
    app.id('update-check').click(); await flush();
    assert.equal(app.count('desktop_update_install'), 1);
    assert.equal(app.id('update-install').disabled, false);
  }
});

test('software update: a changed candidate requires a new check and explicit click on the replacement', async () => {
  let release = offer;
  const h = setup({ desktop_update_check: () => release, desktop_update_install: () => {
    release = { version: '0.1.3', notes: '新版本' }; throw 'UPDATE_VERSION_CHANGED';
  } }); await flush();
  h.id('update-notice-install').click(); await flush();
  assert.equal(h.count('desktop_update_check'), 2);
  assert.equal(h.count('desktop_update_install'), 1);
  assert.match(h.id('update-notice-status').textContent, /0.1.3/);
});

test('software update: unsupported build stays readable; popup and unknown labels skip all update IPC even with preview query', async () => {
  const u = setup({ desktop_update_status: () => ({ currentVersion: '1.0', supported: false }) }); await flush();
  assert.equal(u.id('update-current-version').textContent, '1.0');
  assert.match(u.id('update-status').textContent, /不支持/);
  assert.equal(u.id('update-check').disabled, true); assert.equal(u.intervals.length, 0);
  for (const windowLabel of ['quota', 'other', null]) {
    const h = setup({}, { windowLabel }); h.id('tab-settings').click(); await flush();
    assert.equal(h.id('update-card').hidden, true); assert.equal(h.intervals.length, 0);
    assert.equal(h.calls.some(c => c.cmd.startsWith('desktop_update_')), false);
  }
});
