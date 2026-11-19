import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const dist = new URL('dist/', root);
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const manifest = JSON.parse(await readFile(new URL('plugin.json', root), 'utf8'));
if (pkg.version !== manifest.version) throw new Error('Plugin and package versions must match.');
const modules = (await readdir(new URL('src/', root))).filter(file => file.endsWith('.mjs'));
if (!modules.includes('transport.mjs')) throw new Error('Missing ACP transport source.');
if (!modules.includes('card.mjs')) throw new Error('Missing management card source.');
await rm(dist, { recursive: true, force: true });
await mkdir(new URL('src/', dist), { recursive: true });
for (const file of modules) {
  await copyFile(new URL(`src/${file}`, root), new URL(`src/${file}`, dist));
}
await copyFile(new URL('src/card.mjs', root), new URL('card.js', dist));
await writeFile(new URL('plugin.js', dist), "export { activate } from './src/plugin.mjs';\n");
await copyFile(new URL('plugin.json', root), new URL('plugin.json', dist));
// The installed directory has no module-typed package above plugin.js.
await writeFile(new URL('package.json', dist), JSON.stringify({ type: 'module', version: pkg.version }) + '\n');
