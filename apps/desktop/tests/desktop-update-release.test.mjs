import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { stageUpdate } from '../scripts/desktop-update-release.mjs';

test('staged feed selects the exact signed desktop installer under the project release tag', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ccr-desktop-update-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const outDir = join(root, 'release');
  const options = { version: '0.1.2', tag: 'v2.3.2438', notes: 'release notes', nsisDir: root, outDir };
  const base = join(root, 'CCR Desktop_0.1.2_x64-setup.exe');
  writeFileSync(base, 'fixture payload');
  assert.throws(() => stageUpdate(options), /ENOENT/);
  writeFileSync(base + '.sig', '');
  assert.throws(() => stageUpdate(options), /signature/);
  writeFileSync(base + '.sig', 'signature fixture');
  stageUpdate(options);
  const name = 'CCR-Desktop_0.1.2_x64-setup.exe';
  assert.deepEqual(JSON.parse(readFileSync(join(outDir, 'desktop-update.json'))), {
    version: '0.1.2', notes: 'release notes', platforms: { 'windows-x86_64-nsis': {
      signature: 'signature fixture', url: `https://github.com/xiaoliu10/claude-code-router-next/releases/download/v2.3.2438/${name}`,
    } },
  });
  assert.equal(readFileSync(join(outDir, name), 'utf8'), 'fixture payload');
  assert.equal(readFileSync(join(outDir, name + '.sig'), 'utf8'), 'signature fixture');
  assert.throws(() => stageUpdate({ ...options, tag: '../other' }), /tag/);
});
