import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const releases = 'https://github.com/xiaoliu10/claude-code-router-next/releases';
const tauriDir = fileURLToPath(new URL('../src-tauri/', import.meta.url));

export function stageUpdate({ tag, version, notes, nsisDir, outDir }) {
  const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  if (!tag?.startsWith('v') || !stable.test(tag.slice(1)) || !stable.test(version)) {
    throw new Error('Expected a stable project tag and a Desktop semver');
  }
  const builtName = `CCR Desktop_${version}_x64-setup.exe`;
  const asset = `CCR-Desktop_${version}_x64-setup.exe`;
  const signature = readFileSync(join(nsisDir, `${builtName}.sig`), 'utf8').trim();
  if (!signature) throw new Error('Missing updater signature');
  const manifest = {
    version,
    notes,
    platforms: { 'windows-x86_64-nsis': { signature, url: `${releases}/download/${tag}/${asset}` } },
  };
  mkdirSync(outDir, { recursive: true });
  copyFileSync(join(nsisDir, builtName), join(outDir, asset));
  writeFileSync(join(outDir, `${asset}.sig`), signature);
  writeFileSync(join(outDir, 'desktop-update.json'), JSON.stringify(manifest, null, 2) + '\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { version } = JSON.parse(readFileSync(join(tauriDir, 'tauri.conf.json'), 'utf8'));
  stageUpdate({ version, tag: process.env.GITHUB_REF_NAME, notes: process.env.DESKTOP_NOTES || null,
    nsisDir: join(tauriDir, 'target/release/bundle/nsis'), outDir: join(tauriDir, 'target/desktop-release') });
}
