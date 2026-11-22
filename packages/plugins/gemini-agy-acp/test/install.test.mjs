import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInstaller, defaultBinaryPath, platformKey, validateManifest } from '../src/install.mjs';

const PAYLOAD = Buffer.from('fixture agy binary bytes');
const SHA512 = createHash('sha512').update(PAYLOAD).digest('hex');
const manifestOf = (url, overrides = {}) => JSON.stringify({
  version: '1.5.14', url, sha512: SHA512, ...overrides,
});
const UNIX_URL = 'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.14-1/darwin-arm/cli_mac_arm64.tar.gz';
const WIN_URL = 'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.14-1/windows-x64/cli_windows_x64.exe';

test('platformKey maps every supported OS/CPU and rejects the rest', () => {
  assert.equal(platformKey('darwin', 'arm64'), 'darwin_arm64');
  assert.equal(platformKey('darwin', 'x64'), 'darwin_amd64');
  assert.equal(platformKey('win32', 'x64'), 'windows_amd64');
  assert.equal(platformKey('win32', 'arm64'), 'windows_arm64');
  assert.match(platformKey('linux', 'x64'), /^linux_amd64(_musl)?$/);
  assert.match(platformKey('linux', 'arm64'), /^linux_arm64(_musl)?$/);
  for (const [platform, arch] of [['freebsd', 'x64'], ['darwin', 'ia32'], ['win32', 'ppc64']]) {
    assert.throws(() => platformKey(platform, arch), error => error.code === 'agy_install_unsupported_platform');
  }
});

test('defaultBinaryPath follows the official bootstrapper locations', () => {
  assert.equal(defaultBinaryPath('darwin', {}, '/home/u'), '/home/u/.local/bin/agy');
  assert.equal(defaultBinaryPath('linux', {}, '/home/u'), '/home/u/.local/bin/agy');
  assert.equal(defaultBinaryPath('win32', { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'C:\\Users\\u'),
    join('C:\\Users\\u\\AppData\\Local', 'agy', 'bin', 'agy.exe'));
  // Missing LOCALAPPDATA falls back to the home-relative profile path.
  assert.equal(defaultBinaryPath('win32', {}, '/home/u'), join('/home/u', 'AppData', 'Local', 'agy', 'bin', 'agy.exe'));
});

test('validateManifest gates shape, checksum format and payload provenance', () => {
  const ok = validateManifest(manifestOf(UNIX_URL));
  assert.equal(ok.version, '1.5.14');
  assert.equal(ok.sha512, SHA512);
  const invalid = [
    'not json',
    manifestOf(UNIX_URL, { version: '' }),
    manifestOf(UNIX_URL, { version: 'x'.repeat(65) }),
    manifestOf(UNIX_URL, { sha512: 'abc' }),
    manifestOf(UNIX_URL, { sha512: 'g'.repeat(128) }),
    manifestOf('http://storage.googleapis.com/x.tar.gz'),
    manifestOf('https://evil.example.com/x.tar.gz'),
    manifestOf('https://storage.googleapis.com.evil.example.com/x.tar.gz'),
    manifestOf('not a url'),
    manifestOf(UNIX_URL, { url: undefined }),
  ];
  for (const text of invalid) {
    assert.throws(() => validateManifest(text), error => error.code === 'agy_install_manifest_invalid', String(text).slice(0, 60));
  }
  // The updater host itself is also a legitimate payload origin.
  assert.ok(validateManifest(manifestOf('https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/bin/agy')));
});

/** A fake `run` that emulates curl/tar/handoff without network or real agy. */
function fakeRun({ manifestText, payload = PAYLOAD, failDownload = false, failExtract = false, calls = [] }) {
  return async (command, args, options = {}) => {
    calls.push({ command, args, options });
    if (command === 'curl' || command === 'curl.exe') {
      const out = args.indexOf('-o');
      if (out === -1) return manifestText; // manifest capture
      if (failDownload) throw new Error('network down');
      await writeFile(args[out + 1], payload);
      return '';
    }
    if (command === 'tar' || command === 'tar.exe') {
      if (failExtract) throw new Error('bad archive');
      // The unix member the official bootstrapper extracts.
      await writeFile(join(args[args.indexOf('-C') + 1], 'antigravity'), payload);
      return '';
    }
    return ''; // xattr / agy install handoff: best-effort no-ops
  };
}

async function installerHome(t) {
  const home = await mkdtemp(join(tmpdir(), 'agy-install-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

test('unix install downloads, verifies, extracts and places the binary at the official path', async t => {
  const home = await installerHome(t);
  const calls = [];
  const installer = createInstaller({
    platform: 'darwin', arch: 'arm64', home, env: {},
    run: fakeRun({ manifestText: manifestOf(UNIX_URL), calls }),
  });
  const result = await installer.install();
  assert.equal(result.version, '1.5.14');
  assert.equal(result.binary, join(home, '.local', 'bin', 'agy'));
  assert.deepEqual(await readFile(result.binary), PAYLOAD);
  if (process.platform !== 'win32') assert.equal((await stat(result.binary)).mode & 0o777, 0o755);
  // Atomic placement: the temp copy is renamed away, never left behind.
  assert.deepEqual(await readdir(join(home, '.local', 'bin')), ['agy']);
  // Manifest queried for THIS platform; payload fetched over https-only curl;
  // tar extracted the antigravity member; the vendor handoff ran best-effort.
  assert.ok(calls[0].args.at(-1).endsWith('/manifests/darwin_arm64.json'));
  assert.ok(calls[1].args.includes('--proto-redir'));
  assert.ok(calls.some(call => call.command === 'tar' && call.args.includes('antigravity')));
  assert.ok(calls.some(call => call.command === result.binary && call.args[0] === 'install'));
  assert.ok(calls.some(call => call.command === 'xattr'));
});

test('windows install places the raw exe without tar and uses curl.exe', async t => {
  const home = await installerHome(t);
  const calls = [];
  const installer = createInstaller({
    platform: 'win32', arch: 'x64', home, env: {},
    run: fakeRun({ manifestText: manifestOf(WIN_URL), calls }),
  });
  const result = await installer.install();
  assert.equal(result.binary, join(home, 'AppData', 'Local', 'agy', 'bin', 'agy.exe'));
  assert.deepEqual(await readFile(result.binary), PAYLOAD);
  assert.ok(calls.every(call => call.command !== 'tar' && call.command !== 'tar.exe'));
  assert.ok(calls.every(call => call.command !== 'xattr'));
  assert.ok(calls[0].command === 'curl.exe');
  assert.ok(calls[0].args.at(-1).endsWith('/manifests/windows_amd64.json'));
});

test('a checksum mismatch aborts before anything is placed', async t => {
  const home = await installerHome(t);
  const installer = createInstaller({
    platform: 'darwin', arch: 'arm64', home, env: {},
    run: fakeRun({ manifestText: manifestOf(UNIX_URL, { sha512: 'f'.repeat(128) }) }),
  });
  await assert.rejects(installer.install(), error => error.code === 'agy_install_checksum_mismatch');
  await assert.rejects(stat(join(home, '.local', 'bin', 'agy')), { code: 'ENOENT' });
});

test('download, extract and size failures map to stable codes and leave no binary', async t => {
  const home = await installerHome(t);
  const base = { platform: 'darwin', arch: 'arm64', home, env: {} };
  await assert.rejects(createInstaller({ ...base, run: fakeRun({ manifestText: manifestOf(UNIX_URL), failDownload: true }) }).install(),
    error => error.code === 'agy_install_download_failed');
  await assert.rejects(createInstaller({ ...base, run: fakeRun({ manifestText: manifestOf(UNIX_URL), failExtract: true }) }).install(),
    error => error.code === 'agy_install_extract_failed');
  await assert.rejects(createInstaller({ ...base, maxPayloadBytes: 4, run: fakeRun({ manifestText: manifestOf(UNIX_URL) }) }).install(),
    error => error.code === 'agy_install_too_large');
  await assert.rejects(createInstaller({ ...base, run: async () => { throw new Error('dns'); } }).install(),
    error => error.code === 'agy_install_manifest_failed');
  await assert.rejects(stat(join(home, '.local', 'bin', 'agy')), { code: 'ENOENT' });
});

test('an unsupported platform fails before any network call', async t => {
  const home = await installerHome(t);
  const calls = [];
  const installer = createInstaller({
    platform: 'freebsd', arch: 'x64', home, env: {},
    run: fakeRun({ manifestText: manifestOf(UNIX_URL), calls }),
  });
  await assert.rejects(installer.install(), error => error.code === 'agy_install_unsupported_platform');
  assert.equal(calls.length, 0);
});