import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

test('build fails without destroying the previous dist when the card source is missing', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agy-card-guard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  await mkdir(join(source, 'src'), { recursive: true });
  for (const file of ['package.json', 'plugin.json', 'scripts', 'src/transport.mjs', 'src/card.mjs', 'src/chat.mjs', 'src/plugin.mjs']) {
    await cp(new URL(`../${file}`, import.meta.url), join(source, file), { recursive: true });
  }
  execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: source });
  const packaged = await readFile(join(source, 'dist', 'card.js'), 'utf8');
  await rm(join(source, 'src', 'card.mjs'));
  try {
    execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: source, encoding: 'utf8' });
    assert.fail('build must fail without the card source');
  } catch (error) {
    assert.match(String(error.stderr), /Missing management card source/);
  }
  assert.equal(await readFile(join(source, 'dist', 'card.js'), 'utf8'), packaged);
});

test('management card mounts from a DOM stub, localizes the surface and unmounts cleanly', async () => {
  const source = await readFile(new URL('../src/card.mjs', import.meta.url), 'utf8');
  // The card must stay free of imports and browser/network escape hatches.
  assert.doesNotMatch(source, /(^|[^\w.])import\s|fetch\(|XMLHttpRequest|innerHTML|eval\(|new Function/);
  const card = (await import('../src/card.mjs')).default;
  for (const locale of ['en', 'zh']) for (const disabled of [false, true]) {
    const zh = locale === 'zh';
    const status = { loaded: true, enabled: true, binary: '/fixture/agy', binaryFound: true, version: '1.5.1',
      lastError: null, apiKeyConfigured: true, apiKeyFingerprint: '0248f56577',
      models: [{ id: 'm2', name: 'Gemini Model' }, { id: 'default', name: 'Default' }],
      hiddenModels: ['default'], modelsSyncedAt: 1700000000000 };
    const calls = [];
    const busyEvents = [];
    // The first visibility call parks until released so the busy state of
    // every control can be observed mid-flight.
    let parked = null;
    let releaseVisibility;
    const callApi = async (path, init) => {
      calls.push([path, init]);
      if (path === '/models/visibility' && parked) { await parked; parked = null; }
      if (path === '/models/visibility') {
        const requested = JSON.parse(init.body);
        const hidden = new Set(status.hiddenModels ?? []);
        for (const id of requested.hide ?? []) hidden.add(id);
        for (const id of requested.restore ?? []) hidden.delete(id);
        status.hiddenModels = [...hidden];
      }
      if (path === '/status') return status;
      return { ok: true, success: true, ...status };
    };
    const events = [];
    const make = tag => ({ tag, className: '', textContent: '', children: [], value: '', type: '', disabled: false,
      onclick: null,
      setAttribute() {},
      append(...kids) { this.children.push(...kids); },
      remove() { events.push('remove'); },
      replaceChildren(...kids) { this.children.length = 0; this.children.push(...kids); events.push('clear'); } });
    const previous = globalThis.document;
    globalThis.document = { createElement: make };
    try {
      const host = make();
      await card.mount(host, { callApi, locale, disabled, plugin: { name: 'gemini-agy-acp', version: '0.1.0' }, onBusy: busy => busyEvents.push(busy) });
      assert.equal(host.children.length, 1);
      const root = host.children[0];
      // The card must opt into the host stylesheet like every other card.
      assert.match(root.className, /glass-card/);
      const surface = root.children[0].children[0];
      const header = surface.children[0];
      assert.match(header.children[0].className, /text-lg/);
      assert.equal(header.children[1].textContent, locale === 'zh' ? '实验原型' : 'Experimental');
      assert.equal(header.children[2].textContent, 'API key');
      // Status line, action buttons and inputs — the Connect-first flow.
      const all = [];
      const walk = node => { all.push(node); for (const kid of node.children) walk(kid); };
      walk(root);
      const buttonNodes = all.filter(node => node.tag === 'button');
      const inputNodes = all.filter(node => node.tag === 'input');
      // The three fixed actions, the (hidden) install button, the two
      // auth-mode toggle buttons, a per-row toggle for each of the two models
      // and one restore-all for the seeded hidden model.
      assert.equal(buttonNodes.length, 9);
      const installButton = buttonNodes.find(node => /安装 agy|Install agy/.test(node.textContent));
      assert.ok(installButton);
      assert.equal(installButton.hidden, true); // a binary is configured → no install offer
      const mainLabels = zh ? ['连接', '同步模型', '断开'] : ['Connect', 'Sync models', 'Disconnect'];
      const actionButtons = mainLabels.map(label => buttonNodes.find(node => node.textContent === label));
      assert.deepEqual(actionButtons.map(node => node.textContent), mainLabels);
      // The 登录方式 toggle: API key mode is the default/persisted mode here.
      const authLabels = zh ? ['API key', 'Google 账号'] : ['API key', 'Google account'];
      const authButtons = buttonNodes.filter(node => authLabels.includes(node.textContent));
      assert.equal(authButtons.length, 2);
      assert.equal(inputNodes.length, 2);
      assert.equal(inputNodes[1].type, 'password');
      assert.equal(inputNodes[0].value, '/fixture/agy'); // binary prefilled from status
      assert.equal(inputNodes[1].value, '');             // the apiKey is never rendered back
      assert.equal(inputNodes[1].hidden, false);         // API key mode keeps the key input visible
      const details = all.filter(node => node.tag === 'details').at(-1);
      assert.ok(details);
      assert.ok(!details.open);
      assert.equal(details.children[0].textContent, locale === 'zh' ? '配置说明' : 'Setup instructions');
      assert.doesNotMatch(JSON.stringify(details), /enabled|binary.*absolute.*JSON|api_key/);
      // The status line reflects the fetched status shape.
      const line = all.find(node => typeof node.textContent === 'string' && node.textContent.includes('1.5.1'));
      assert.ok(line);
      assert.match(line.textContent, zh ? /已连接/ : /Connected/);
      // The model count stays the TOTAL catalog size, with the hidden ones
      // reported separately, and the credential line names the AI Studio key.
      assert.match(line.textContent, zh ? /2 个模型（已隐藏 1）/ : /2 models \(1 hidden\)/);
      assert.match(line.textContent, zh ? /AI Studio key 凭据 0248f56577…/ : /AI Studio key credential 0248f56577…/);
      // The expandable model list: per-row visibility toggles, hidden rows
      // dimmed with a suffix, restore-all under the list.
      const modelsUl = all.find(node => node.tag === 'ul');
      assert.ok(modelsUl);
      assert.equal(modelsUl.children[0].textContent, 'Gemini Model · m2');
      assert.equal(modelsUl.children[0].className, '');
      assert.equal(modelsUl.children[1].textContent, zh ? 'Default · default 已隐藏' : 'Default · default hidden');
      assert.equal(modelsUl.children[1].className, 'text-muted-foreground/50');
      const rowToggles = () => modelsUl.children.map(li => li.children.find(node => node.tag === 'button'));
      assert.deepEqual(rowToggles().map(node => node.textContent), [zh ? '隐藏' : 'Hide', zh ? '恢复' : 'Restore']);
      const restoreAllButton = all.find(node => node.tag === 'button' && node.textContent === (zh ? '恢复全部' : 'Restore all'));
      assert.ok(restoreAllButton);
      assert.equal(restoreAllButton.disabled, false);
      assert.deepEqual(calls[0], ['/status', { timeoutMs: 15000 }]);
      // Connect sends the binary path, the chosen auth method, no key when
      // the field is empty, and clears the typed key after connecting.
      inputNodes[0].value = '/fixture/agy';
      inputNodes[1].value = 'typed-secret';
      await actionButtons[0].onclick();
      assert.deepEqual(calls[1], ['/connect', { method: 'POST',
        body: JSON.stringify({ binary: '/fixture/agy', authMethod: 'gemini-api-key', apiKey: 'typed-secret' }), timeoutMs: 30000 }]);
      assert.equal(inputNodes[1].value, '');
      assert.ok(calls.some(([path]) => path === '/status'));
      // Hiding parks the visibility POST: every control is disabled while
      // busy, then the refreshed status dims the row and flips the toggle.
      parked = new Promise(resolve => { releaseVisibility = resolve; });
      const pendingHide = rowToggles()[0].onclick();
      for (const node of [...actionButtons, ...authButtons, ...rowToggles(), restoreAllButton]) {
        assert.equal(node.disabled, true, node.textContent);
      }
      assert.deepEqual(busyEvents.slice(-1), [true]);
      releaseVisibility();
      await pendingHide;
      assert.deepEqual(calls.at(-2), ['/models/visibility', { method: 'POST', body: JSON.stringify({ hide: ['m2'] }), timeoutMs: 30000 }]);
      assert.equal(calls.at(-1)[0], '/status');
      assert.deepEqual(rowToggles().map(node => node.textContent), [zh ? '恢复' : 'Restore', zh ? '恢复' : 'Restore']);
      assert.equal(modelsUl.children.filter(li => li.className === 'text-muted-foreground/50').length, 2);
      assert.match(line.textContent, zh ? /（已隐藏 2）/ : /\(2 hidden\)/);
      assert.deepEqual(busyEvents.slice(-1), [false]);
      // Restore-all empties the hide set: rows undim, the suffix disappears
      // and the restore-all button hides itself.
      await restoreAllButton.onclick();
      assert.deepEqual(calls.at(-2), ['/models/visibility', { method: 'POST', body: JSON.stringify({ restore: ['default', 'm2'] }), timeoutMs: 30000 }]);
      assert.ok(modelsUl.children.every(li => li.className === ''));
      assert.deepEqual(rowToggles().map(node => node.textContent), [zh ? '隐藏' : 'Hide', zh ? '隐藏' : 'Hide']);
      assert.equal(restoreAllButton.hidden, true);
      assert.doesNotMatch(line.textContent, zh ? /已隐藏/ : /hidden/);
      assert.deepEqual(busyEvents.slice(-1), [false]);
      card.unmount(host);
      // Each mutation re-clears the model list and unmount clears the host:
      // five clear events, no removals.
      assert.deepEqual(events, ['clear', 'clear', 'clear', 'clear', 'clear']);
      assert.equal(host.children.length, 0);
    } finally { globalThis.document = previous; }
  }
});

test('management card oauth-personal mode hides the key input, reports the account and maps login failures to the terminal hint', async () => {
  const card = (await import('../src/card.mjs')).default;
  for (const locale of ['zh', 'en']) {
    const zh = locale === 'zh';
    const status = { loaded: true, enabled: true, binary: '/fixture/agy', binaryFound: true, version: '1.5.1',
      authMethod: 'oauth-personal', accountEmail: 'agy.user@example.com', lastError: null,
      apiKeyConfigured: false, apiKeyFingerprint: null,
      models: [{ id: 'm2', name: 'Gemini Model' }], hiddenModels: [] };
    const calls = [];
    let failNextConnect = false;
    const callApi = async (path, init) => {
      calls.push([path, init]);
      if (path === '/connect') {
        if (failNextConnect) {
          failNextConnect = false;
          throw Object.assign(new Error('acp_auth_required'), { code: 'acp_auth_required' });
        }
        const requested = JSON.parse(init.body);
        status.authMethod = requested.authMethod;
        if ('email' in requested) status.accountEmail = requested.email;
        return { ok: true, success: true, ...status };
      }
      if (path === '/status') return status;
      return { ok: true, success: true, ...status };
    };
    const make = tag => ({ tag, className: '', textContent: '', children: [], value: '', type: '', disabled: false,
      onclick: null,
      setAttribute() {},
      append(...kids) { this.children.push(...kids); },
      remove() {},
      replaceChildren(...kids) { this.children.length = 0; this.children.push(...kids); } });
    const previous = globalThis.document;
    globalThis.document = { createElement: make };
    try {
      const host = make();
      await card.mount(host, { callApi, locale, plugin: { name: 'gemini-agy-acp', version: '0.1.0' } });
      const all = [];
      const walk = node => { all.push(node); for (const kid of node.children) walk(kid); };
      walk(host);
      const buttonNodes = all.filter(node => node.tag === 'button');
      const inputNodes = all.filter(node => node.tag === 'input');
      const oauthLabel = zh ? 'Google 账号' : 'Google account';
      const keyModeButton = buttonNodes.find(node => node.textContent === 'API key');
      const oauthModeButton = buttonNodes.find(node => node.textContent === oauthLabel);
      const connectButton = buttonNodes.find(node => node.textContent === (zh ? '连接' : 'Connect'));
      assert.ok(keyModeButton && oauthModeButton && connectButton);
      const accountLine = all.find(node => typeof node.textContent === 'string' && node.textContent.startsWith(zh ? '账号：' : 'Account: '));
      const line = all.find(node => typeof node.textContent === 'string' && node.textContent.includes('1.5.1'));
      // Google-account mode: the key input is hidden and the handshake-verified
      // account email is shown prominently and in the status line.
      assert.equal(inputNodes[1].hidden, true);
      assert.deepEqual(accountLine.textContent, zh ? '账号：agy.user@example.com' : 'Account: agy.user@example.com');
      assert.match(line.textContent, zh ? /账号 agy\.user@example\.com/ : /account agy\.user@example\.com/);
      assert.doesNotMatch(line.textContent, zh ? /AI Studio key 凭据/ : /AI Studio key credential/);
      // Toggling back to API key mode reveals the key input and flips the
      // active segment styling.
      keyModeButton.onclick();
      assert.equal(inputNodes[1].hidden, false);
      assert.match(keyModeButton.className, /border-primary/);
      assert.match(oauthModeButton.className, /opacity-60/);
      oauthModeButton.onclick();
      assert.equal(inputNodes[1].hidden, true);
      assert.match(oauthModeButton.className, /border-primary/);
      // OAuth connect never sends credential material, even with a typed key.
      inputNodes[0].value = '/fixture/agy';
      inputNodes[1].value = 'typed-secret';
      await connectButton.onclick();
      assert.deepEqual(calls.at(-2), ['/connect', { method: 'POST',
        body: JSON.stringify({ binary: '/fixture/agy', authMethod: 'oauth-personal' }), timeoutMs: 30000 }]);
      assert.equal(inputNodes[1].value, '');
      // A failed oauth connect surfaces the terminal sign-in hint, not the
      // API-key hint.
      failNextConnect = true;
      await connectButton.onclick();
      const message = all.find(node => typeof node.textContent === 'string' &&
        node.textContent === (zh ? '请先在终端运行一次 agy 完成浏览器登录' : 'Run agy once in a terminal to complete the browser sign-in first'));
      assert.ok(message, 'terminal sign-in hint shown');
      // Without a handshake-provided email the card shows the explicit
      // not-provided placeholder.
      status.accountEmail = undefined;
      const host2 = make();
      await card.mount(host2, { callApi, locale, plugin: { name: 'gemini-agy-acp', version: '0.1.0' } });
      const all2 = [];
      const walk2 = node => { all2.push(node); for (const kid of node.children) walk2(kid); };
      walk2(host2);
      const line2 = all2.find(node => typeof node.textContent === 'string' && node.textContent.includes('1.5.1'));
      assert.match(line2.textContent, zh ? /账号邮箱未提供/ : /account email not provided/);
      card.unmount(host2);
      card.unmount(host);
    } finally { globalThis.document = previous; }
  }
});
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Run the built entry outside the source tree, in the exact layout used by
// `ccr plugin add`. A fake transport makes missing relative imports observable.
test('built plugin.js activates in a standalone Node process under a temporary HOME', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agy-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const configDir = join(root, 'config');
  const destination = join(configDir, 'plugins', 'gemini-agy-acp');
  await mkdir(source);
  await mkdir(join(source, 'src'));
  for (const file of ['package.json', 'plugin.json', 'scripts', 'src/account.mjs', 'src/chat.mjs', 'src/card.mjs', 'src/plugin.mjs',
    'src/settings.mjs', 'src/admin-routes.mjs', 'src/acp-errors.mjs', 'src/install.mjs']) {
    await cp(new URL(`../${file}`, import.meta.url), join(source, file), { recursive: true });
  }
  await writeFile(join(source, 'src', 'transport.mjs'), `
    export function createTransport({binary}) {
      if (binary !== '/test/fixture') throw new Error('wrong binary');
      return { async run({onText}) { onText('fixture reply'); return {stopReason:'end_turn'}; } };
    }
    export function proxyEnvOverlay() { return undefined; }
  `);
  const env = { HOME: root, USERPROFILE: root, CCR_CONFIG_DIR: configDir };
  execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: source, env });
  await cp(join(source, 'dist'), destination, { recursive: true });
  await rm(source, { recursive: true });
  const manifest = JSON.parse(await readFile(join(destination, 'plugin.json')));
  assert.equal(manifest.name, 'gemini-agy-acp');
  assert.equal(manifest.coreApi, '1');
  assert.equal((await readFile(join(destination, 'card.js'), 'utf8')).includes('export default'), true);
  await writeFile(join(configDir, 'gemini-agy-acp.json'), JSON.stringify({
    binary: '/test/fixture', enabled: true, authMethod: 'gemini-api-key',
  }));
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { activate } from './plugin.js';
    let runtime;
    await activate({host: {configDir: process.env.CCR_CONFIG_DIR}, registerTransformer() {},
      registerManagedRuntime(value) { runtime = value; }});
    const response = await runtime.dispatchRequest({
      provider: {name:'gemini-agy-acp', apiKey:'ccr-managed-gemini-agy-acp', models:['model-1']},
      requestBody: {model:'model-1',messages:[{role:'user',content:'test'}]}
    });
    console.log((await response.json()).choices[0].message.content);
  `], { cwd: destination, env, encoding: 'utf8' });
  assert.equal(output.trim(), 'fixture reply');
});

test('card auto-installs agy when none is detected, polls while installing and offers explicit retry after failure', async () => {
  const card = (await import('../src/card.mjs')).default;
  const make = tag => ({ tag, className: '', textContent: '', children: [], value: '', type: '', disabled: false,
    hidden: false, onclick: null, setAttribute() {},
    append(...kids) { this.children.push(...kids); },
    remove() {},
    replaceChildren(...kids) { this.children.length = 0; this.children.push(...kids); } });
  const walk = root => { const all = []; const visit = node => { all.push(node); for (const kid of node.children) visit(kid); }; visit(root); return all; };
  const baseStatus = { loaded: false, enabled: false, binary: null, binaryFound: false, detectedBinary: null,
    installing: false, installError: null, version: null, lastError: null, authMethod: null,
    apiKeyConfigured: false, apiKeyFingerprint: null, hiddenModels: [] };
  const previousDocument = globalThis.document;
  const previousSetInterval = globalThis.setInterval;
  globalThis.document = { createElement: make };
  try {
    // A: nothing detected → the first view kicks /install exactly once; the
    // completed refresh prefills the detected binary and re-hides the button.
    const statusA = { ...baseStatus };
    const callsA = [];
    const callApiA = async (path, init) => {
      callsA.push([path, init]);
      if (path === '/install') {
        statusA.detectedBinary = '/installed/agy';
        return { ok: true, success: true, ...statusA };
      }
      return { ...statusA };
    };
    const hostA = make();
    await card.mount(hostA, { callApi: callApiA, locale: 'zh', plugin: { name: 'gemini-agy-acp', version: '0.1.0' }, onBusy() {} });
    assert.deepEqual(callsA[0], ['/status', { timeoutMs: 15000 }]);
    assert.deepEqual(callsA[1], ['/install', { method: 'POST', body: JSON.stringify({}), timeoutMs: 30000 }]);
    assert.equal(callsA.filter(([path]) => path === '/install').length, 1);
    const allA = walk(hostA);
    assert.equal(allA.find(node => node.tag === 'input').value, '/installed/agy');
    assert.equal(allA.find(node => node.tag === 'button' && node.textContent === '安装 agy').hidden, true);
    assert.ok(allA.some(node => typeof node.textContent === 'string' && node.textContent.includes('已开始自动安装 agy')));
    card.unmount(hostA);

    // B: a running install locks every action, shows 安装中… and polls /status;
    // the poll tick that observes completion surfaces the success notice and
    // unmount clears the timer.
    // Models seeded while installing: the freshly rebuilt row toggles and
    // restore-all must be locked by the install too (P2-1 regression).
    const statusB = { ...baseStatus, installing: true,
      models: [{ id: 'm1', name: 'M1' }, { id: 'm2', name: 'M2' }], hiddenModels: ['m2'] };
    const callsB = [];
    const callApiB = async path => { callsB.push(path); return { ...statusB }; };
    let pollTick = null;
    globalThis.setInterval = fn => { pollTick = fn; return previousSetInterval(fn, 60000); };
    const hostB = make();
    await card.mount(hostB, { callApi: callApiB, locale: 'zh', plugin: { name: 'gemini-agy-acp', version: '0.1.0' }, onBusy() {} });
    assert.deepEqual(callsB, ['/status']); // no auto kick while already installing
    const allB = walk(hostB);
    const installingButton = allB.find(node => node.tag === 'button' && node.textContent === '安装中…');
    assert.ok(installingButton);
    assert.equal(installingButton.disabled, true);
    assert.equal(allB.find(node => node.tag === 'button' && node.textContent === '连接').disabled, true);
    assert.ok(allB.some(node => typeof node.textContent === 'string' && node.textContent.includes('正在自动安装 agy')));
    const rowTogglesB = allB.filter(node => node.tag === 'button' && (node.textContent === '隐藏' || node.textContent === '恢复'));
    assert.equal(rowTogglesB.length, 2);
    for (const toggle of rowTogglesB) assert.equal(toggle.disabled, true);
    const restoreAllB = allB.find(node => node.tag === 'button' && node.textContent === '恢复全部');
    assert.equal(restoreAllB.disabled, true);
    assert.ok(hostB.__agyPollTimer);
    assert.equal(typeof pollTick, 'function');
    // The background install finishes between polls.
    statusB.installing = false;
    statusB.detectedBinary = '/installed/agy';
    await pollTick();
    const afterB = walk(hostB);
    assert.ok(afterB.some(node => typeof node.textContent === 'string' && node.textContent.includes('agy 已安装，可直接连接')));
    assert.equal(afterB.find(node => node.tag === 'input').value, '/installed/agy');
    assert.equal(hostB.__agyPollTimer, null);
    card.unmount(hostB);
    assert.equal(hostB.__agyPollTimer, null);
    globalThis.setInterval = previousSetInterval;

    // C: a previous failure is never auto-retried; the Install button is the
    // explicit retry and the stable code maps to its recovery hint.
    const statusC = { ...baseStatus, installError: { code: 'agy_install_download_failed', at: 1 } };
    const callsC = [];
    const callApiC = async path => { callsC.push(path); return { ...statusC }; };
    const hostC = make();
    await card.mount(hostC, { callApi: callApiC, locale: 'zh', plugin: { name: 'gemini-agy-acp', version: '0.1.0' }, onBusy() {} });
    assert.deepEqual(callsC, ['/status']);
    const allC = walk(hostC);
    const retryButton = allC.find(node => node.tag === 'button' && node.textContent === '安装 agy');
    assert.equal(retryButton.hidden, false);
    assert.equal(retryButton.disabled, false);
    assert.ok(allC.some(node => typeof node.textContent === 'string' && node.textContent.includes('下载 agy 失败')));
    card.unmount(hostC);

    // D: a stale install failure is superseded once a binary is detected
    // (manual install after a failed auto-install): no hint, no retry button.
    const statusD = { ...baseStatus, detectedBinary: '/manual/agy', installError: { code: 'agy_install_download_failed', at: 1 } };
    const callApiD = async () => ({ ...statusD });
    const hostD = make();
    await card.mount(hostD, { callApi: callApiD, locale: 'zh', plugin: { name: 'gemini-agy-acp', version: '0.1.0' }, onBusy() {} });
    const allD = walk(hostD);
    assert.equal(allD.find(node => node.tag === 'button' && node.textContent === '安装 agy').hidden, true);
    assert.equal(allD.find(node => node.tag === 'input').value, '/manual/agy');
    assert.ok(!allD.some(node => typeof node.textContent === 'string' && node.textContent.includes('下载 agy 失败')));
    card.unmount(hostD);
  } finally {
    globalThis.document = previousDocument;
    globalThis.setInterval = previousSetInterval;
  }
});
