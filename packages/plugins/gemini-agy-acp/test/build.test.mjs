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

test('management card mounts from a DOM stub, localizes the badge and unmounts cleanly', async () => {
  const source = await readFile(new URL('../src/card.mjs', import.meta.url), 'utf8');
  // The card must stay free of imports and browser/network escape hatches.
  assert.doesNotMatch(source, /(^|[^\w.])import\s|fetch\(|XMLHttpRequest|innerHTML|eval\(|new Function/);
  const card = (await import('../src/card.mjs')).default;
  for (const locale of ['en', 'zh']) for (const disabled of [false, true]) {
    const events = [];
    const make = () => ({ style: {}, className: '', textContent: '', children: [],
      append(...kids) { this.children.push(...kids); },
      remove() { events.push('remove'); },
      replaceChildren() { this.children.length = 0; events.push('clear'); } });
    const previous = globalThis.document;
    globalThis.document = { createElement: () => make() };
    try {
      const host = make();
      card.mount(host, { locale, disabled, plugin: { name: 'gemini-agy-acp', version: '0.0.2' } });
      assert.equal(host.children.length, 1);
      const badge = host.children[0].children[0].children[1];
      assert.match(badge.textContent, disabled ? /Disabled|未启用/ : /Enabled|已启用/);
      card.unmount(host);
      assert.deepEqual(events, ['remove', 'clear']);
      assert.equal(host.children.length, 0);
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
  for (const file of ['package.json', 'plugin.json', 'scripts', 'src/chat.mjs', 'src/card.mjs', 'src/plugin.mjs']) {
    await cp(new URL(`../${file}`, import.meta.url), join(source, file), { recursive: true });
  }
  await writeFile(join(source, 'src', 'transport.mjs'), `
    export function createTransport({binary}) {
      if (binary !== '/test/fixture') throw new Error('wrong binary');
      return { async run({onText}) { onText('fixture reply'); return {stopReason:'end_turn'}; } };
    }
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
