import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const context = { setTimeout };
vm.runInNewContext(readFileSync(new URL('../src/projects.js', import.meta.url), 'utf8'), context);
const P = context.ProjectsUI;
const plain = v => JSON.parse(JSON.stringify(v));
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const snapshot = () => ({
  providers: [{ name: 'alpha', models: ['one', 'two'] }],
  globalRouter: { default: 'alpha,one', enableFallback: true, fallback: { default: ['alpha,two'] }, families: { opus: { think: 'alpha,two' } } },
  projects: [
    { id: 'a', path: '/work/Alpha', useGlobal: true, router: {}, revision: 'a1', takeoverClients: ['claudeCode'] },
    { id: 'b', path: '/work/Beta', useGlobal: false, router: { default: 'old,disabled', families: { sonnet: { think: 'old,disabled' } } }, revision: 'b1', takeoverClients: [] },
  ],
});
async function setup() {
  const calls = [];
  const controller = P.createProjectsController({ invoke(cmd, args) {
    return new Promise((resolve, reject) => calls.push({ cmd, args: plain(args || {}), resolve, reject }));
  } });
  controller.refresh(); calls[0].resolve(snapshot()); await flush();
  return { c: controller, calls };
}

test('projects projection excludes raw config and preserves absent optional flags', () => {
  const s = snapshot(); s.providers[0].APIKEY = 'secret'; s.projects[0].configPath = 'secret';
  s.globalRouter.secret = 'secret'; s.globalRouter.families.opus.models = { secret: 'secret' };
  const projected = plain(P.normalizeProjectsSnapshot(s));
  assert.equal(JSON.stringify(projected).includes('secret'), false);
  assert.equal(Object.hasOwn(projected.globalRouter, 'enableExtendedContext'), false);
  assert.deepEqual(plain(P.normalizeRouter({ enableFallback: false })), { enableFallback: false });
});

test('projects first load lists existing projects; custom copies current global including nested fallback and remains local', async () => {
  const { c, calls } = await setup();
  assert.equal(c.state().selectedId, 'a'); assert.equal(c.state().snapshot.projects.length, 2);
  c.setUseGlobal('a', false);
  assert.deepEqual(plain(c.state().effectiveRouter('a')), snapshot().globalRouter);
  c.setTarget('a', 'root', 'default', 'alpha,two');
  assert.equal(c.state().snapshot.globalRouter.default, 'alpha,one');
  assert.equal(calls.length, 1);
});

test('projects switching during save retains independent drafts and late response cannot change selection', async () => {
  const { c, calls } = await setup();
  c.setUseGlobal('a', false); c.setTarget('a', 'root', 'default', 'alpha,two'); c.save('a');
  c.select('b'); c.setTarget('b', 'root', 'think', 'alpha,one');
  c.setTarget('a', 'root', 'image', 'alpha,one');
  const response = snapshot(); response.projects[0] = { ...response.projects[0], useGlobal: false, router: calls[1].args.change.router, revision: 'a2' };
  calls[1].resolve(response); await flush();
  assert.equal(c.state().selectedId, 'b');
  assert.equal(c.state().effectiveRouter('a').image, 'alpha,one');
  assert.equal(c.state().effectiveRouter('b').think, 'alpha,one');
  assert.equal(calls[1].args.change.id, 'a');
  assert.equal(calls[1].args.change.router.image, undefined);
  assert.equal(c.state().draft('a').baseRev, 'a2');
});

test('projects refresh preserves dirty draft and original revision; stale save cannot overwrite', async () => {
  const { c, calls } = await setup(); c.setUseGlobal('a', false);
  c.refresh(); const newer = snapshot(); newer.projects[0].revision = 'a2'; newer.globalRouter.default = 'alpha,two';
  calls[1].resolve(newer); await flush();
  assert.equal(c.state().effectiveRouter('a').default, 'alpha,one');
  assert.ok(c.state().staleFor('a'));
  c.save('a'); assert.equal(calls[2].args.change.revision, 'a1');
  calls[2].reject(new Error('stale revision secret upstream')); await flush();
  assert.match(c.state().actionError.message, /已被其他程序修改/);
  assert.equal(c.state().actionError.message.includes('secret'), false);
  assert.equal(c.state().isRouterDirty('a'), true);
  c.resetDraft('a'); assert.equal(c.state().isClean('a'), true); assert.equal(c.state().actionError, null);
});

test('projects failed save retains all drafts and scopes errors to the original project', async () => {
  const { c, calls } = await setup(); c.setUseGlobal('a', false); c.save('a'); c.select('b');
  calls[1].reject(new Error('APIKEY=sensitive upstream body')); await flush();
  assert.equal(c.state().actionError.id, 'a'); assert.equal(c.state().selectedId, 'b');
  assert.equal(c.state().isRouterDirty('a'), true);
  assert.doesNotMatch(c.state().actionError.message, /sensitive|APIKEY/);
  assert.equal(c.state().actionError.stale, false);
});

test('projects restore global sends exactly empty router only after explicit Save', async () => {
  const { c, calls } = await setup(); c.select('b'); c.setUseGlobal('b', true);
  assert.equal(calls.length, 1); assert.equal(c.state().snapshot.projects[1].useGlobal, false);
  c.save('b'); assert.deepEqual(calls[1].args, { change: { id: 'b', revision: 'b1', useGlobal: true, router: {} } });
});

test('projects takeover explicit apply preserves routing and newer client drafts during request', async () => {
  const { c, calls } = await setup(); c.setUseGlobal('a', false);
  c.setTakeoverClient('a', 'pi', true); assert.equal(calls.length, 1);
  assert.equal(c.setTakeoverClient('a', 'codex', true), false);
  c.applyTakeover('a'); c.setTakeoverClient('a', 'zcode', true); c.select('b');
  const response = snapshot(); response.projects[0].takeoverClients.push('pi'); response.projects[0].revision = 'a2';
  calls[1].resolve(response); await flush();
  assert.deepEqual(calls[1].args, { id: 'a', revision: 'a1', clients: ['claudeCode', 'pi'] });
  assert.equal(c.state().isRouterDirty('a'), true);
  assert.deepEqual(plain(c.state().draft('a').clients), ['claudeCode', 'pi', 'zcode']);
  c.save('a'); assert.equal(calls[2].args.change.revision, 'a2');
});

test('projects deletion requires matching confirmation, cancels on switching, and late delete keeps selection', async () => {
  const { c, calls } = await setup();
  assert.equal(c.confirmDelete('a'), false); c.requestDelete('a'); c.cancelDelete(); assert.equal(calls.length, 1);
  c.requestDelete('a'); c.select('b'); assert.equal(c.confirmDelete('a'), false);
  c.requestDelete('a'); assert.equal(c.confirmDelete('b'), false); c.confirmDelete('a'); c.select('b');
  assert.deepEqual(calls[1].args, { id: 'a', revision: 'a1' });
  const response = snapshot(); response.projects.shift(); calls[1].resolve(response); await flush();
  assert.equal(c.state().selectedId, 'b');
});

test('projects add validates absolute paths and late add cannot override user selection', async () => {
  const { c, calls } = await setup();
  assert.equal(c.addProject('relative').ok, false); assert.equal(calls.length, 1);
  c.addProject('/work/Gamma'); c.select('b');
  const response = snapshot(); response.projects.push({ id: 'g', path: '/work/Gamma', revision: 'g1', useGlobal: true, router: {}, takeoverClients: ['claudeCode'] });
  calls[1].resolve(response); await flush(); assert.equal(c.state().selectedId, 'b');
  assert.deepEqual(calls[1].args, { path: '/work/Gamma' });
});

test('projects seven scenarios, ordered fallback, families, optional flags and thresholds serialize correctly', async () => {
  const { c, calls } = await setup(); c.setUseGlobal('a', false);
  for (const scenario of P.PROJECT_SCENARIOS) c.setTarget('a', 'root', scenario, 'alpha,one');
  c.addFallback('a', 'root', 'default', 'alpha,one'); c.moveFallback('a', 'root', 'default', 1, -1);
  c.removeFamily('a', 'opus'); c.addFamily('a', 'haiku');
  c.setThreshold('a', 'haiku', 'longContextThreshold', '123456');
  c.setThreshold('a', 'root', 'extendedContextThreshold', '-1'); assert.equal(c.save('a'), false);
  c.setThreshold('a', 'root', 'extendedContextThreshold', '200000');
  c.setFlag('a', 'root', 'enableFallback', null); c.save('a');
  const router = calls[1].args.change.router;
  assert.deepEqual(router.fallback.default, ['alpha,one', 'alpha,two']);
  for (const scenario of P.PROJECT_SCENARIOS) assert.equal(router[scenario], 'alpha,one');
  assert.equal(router.families.opus, undefined); assert.equal(router.families.haiku.longContextThreshold, 123456);
  assert.equal(Object.hasOwn(router, 'enableFallback'), false);
});

test('projects unchanged disabled choices roundtrip; changed choices and unsafe aliases rejected', async () => {
  const { c, calls } = await setup(); c.setThreshold('b', 'root', 'longContextThreshold', '60001');
  assert.equal(c.save('b'), true); assert.equal(calls[1].args.change.router.default, 'old,disabled');
  calls[1].reject(new Error('offline')); await flush();
  c.setTarget('b', 'root', 'default', 'new,unavailable'); assert.equal(c.save('b'), false);
  for (const alias of ['__proto__', 'a,b', '中文', 'a'.repeat(65)]) {
    assert.equal(c.addAlias('b', alias, 'alpha,one').ok, false);
  }
});

test('projects empty custom readback adopts inheritance without dropping hidden fields or newer edits', async () => {
  for (const [inherits, editDuringSave] of [[true, false], [false, false], [true, true]]) {
    const { c, calls } = await setup();
    c.setTarget('b', 'root', 'default', ''); c.removeFamily('b', 'sonnet');
    assert.equal(c.save('b'), true);
    assert.deepEqual(calls[1].args.change.router, {});
    assert.equal(calls[1].args.change.useGlobal, false);
    if (editDuringSave) c.setTarget('b', 'root', 'think', 'alpha,one');
    const response = snapshot(); response.projects[1] = { ...response.projects[1], router: {}, useGlobal: inherits, revision: 'b2' };
    calls[1].resolve(response); await flush();
    assert.equal(c.state().isClean('b'), !editDuringSave);
    if (editDuringSave) assert.equal(c.state().effectiveRouter('b').think, 'alpha,one');
    else assert.equal(c.state().snapshot.projects[1].useGlobal, inherits);
  }
});

test('projects pending mutation blocks refresh and duplicate writes', async () => {
  const { c, calls } = await setup(); c.setUseGlobal('a', false); c.save('a'); c.refresh(); c.save('a'); c.applyTakeover('a');
  assert.equal(calls.length, 2);
});

test('projects preview contract supports save, takeover, add and delete with revisions', async () => {
  const invoke = P.createPreviewProjects(); let s = await invoke('projects_snapshot'); const id = s.projects[0].id;
  s = await invoke('projects_save', { change: { id, revision: s.projects[0].revision, useGlobal: false, router: s.globalRouter } });
  assert.equal(s.projects[0].useGlobal, false); assert.ok(s.projects[0].router.fallback);
  await assert.rejects(invoke('projects_delete', { id, revision: 'old' }), /修改/);
  s = await invoke('projects_takeover', { id, revision: s.projects[0].revision, clients: [] }); assert.deepEqual(plain(s.projects[0].takeoverClients), []);
  s = await invoke('projects_delete', { id, revision: s.projects[0].revision }); assert.equal(s.projects.some(p => p.id === id), false);
  s = await invoke('projects_add', { path: '/preview/only' }); assert.deepEqual(plain(s.projects.at(-1).takeoverClients), ['claudeCode']);
});

test('projects browser wiring loads projects before quota and requires exact explicit preview query', () => {
  const html = readFileSync(new URL('../src/quota.html', import.meta.url), 'utf8');
  const js = readFileSync(new URL('../src/quota.js', import.meta.url), 'utf8');
  assert.ok(html.indexOf('src="projects.js"') < html.indexOf('src="quota.js"'));
  assert.match(html, /id="tab-projects"[^>]+aria-controls="panel-projects"/);

  const previewPattern = /(?:^|[?&])preview=1(?:&|$)/;
  assert.match(js, /preview=1\(\?:&\|\$\)/);
  assert.equal(previewPattern.test('?preview=1'), true);
  assert.equal(previewPattern.test('?preview=10'), false);
  assert.equal(previewPattern.test('?unrelated=1'), false);
  assert.match(js, /var mode = tauri \? 'tauri' : previewWanted \? 'preview' : 'missing'/);
});
