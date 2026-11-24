// Official agy installer, in-process and proxy-aware. It mirrors the vendor
// bootstrappers (antigravity.google/cli/install.sh / install.ps1) step for
// step: query the pinned release manifest for THIS platform/architecture,
// download over HTTPS with curl (which honors the gateway's
// HTTPS_PROXY/HTTP_PROXY/NO_PROXY environment natively), verify the SHA-512
// checksum, extract the unix tarball member and place the binary at the
// official default location. No remote script is ever piped into a shell.
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { failure } from './chat.mjs';

const MANIFEST_BASE = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app';
// The manifest endpoint is pinned to the vendor updater; payloads may only
// come from the vendor's public bucket (or the updater itself), always HTTPS.
const PAYLOAD_HOSTS = new Set([
  'storage.googleapis.com',
  'antigravity-cli-auto-updater-974169037036.us-central1.run.app',
]);
const MAX_PAYLOAD_BYTES = 400 * 1024 * 1024;
const MANIFEST_TIMEOUT_MS = 20_000;
const DOWNLOAD_TIMEOUT_MS = 600_000;
const EXTRACT_TIMEOUT_MS = 120_000;
const HANDOFF_TIMEOUT_MS = 30_000;

/** The vendor manifest key for this OS/CPU, exactly like the bootstrappers'
 * uname/PROCESSOR_ARCHITECTURE detection (including the Linux musl builds). */
export function platformKey(platform = process.platform, arch = process.arch) {
  const cpu = { x64: 'amd64', arm64: 'arm64' }[arch];
  if (!cpu) throw failure('agy_install_unsupported_platform', 503);
  if (platform === 'darwin') return `darwin_${cpu}`;
  if (platform === 'win32') return `windows_${cpu}`;
  if (platform === 'linux') {
    const musl = arch === 'x64' ? '/lib/libc.musl-x86_64.so.1' : '/lib/libc.musl-aarch64.so.1';
    if (existsSync(musl)) return `linux_${cpu}_musl`;
    return `linux_${cpu}`;
  }
  throw failure('agy_install_unsupported_platform', 503);
}

/** The official default install location: ~/.local/bin/agy on unix,
 * %LOCALAPPDATA%\agy\bin\agy.exe on Windows (install.ps1's TARGET_DIR). */
export function defaultBinaryPath(platform = process.platform, env = process.env, home = homedir()) {
  if (platform === 'win32') {
    const local = typeof env.LOCALAPPDATA === 'string' && env.LOCALAPPDATA
      ? env.LOCALAPPDATA : join(home, 'AppData', 'Local');
    return join(local, 'agy', 'bin', 'agy.exe');
  }
  return join(home, '.local', 'bin', 'agy');
}

/** Manifest shape + provenance gate: a bounded version string, a 128-hex
 * SHA-512 and an HTTPS payload URL on the vendor allowlist. Anything else
 * fails closed before a single payload byte is fetched. */
export function validateManifest(text) {
  let manifest;
  try { manifest = JSON.parse(text); } catch { throw failure('agy_install_manifest_invalid', 502); }
  const { version, url, sha512 } = manifest ?? {};
  if (typeof version !== 'string' || !version || version.length > 64 || /[\0-\x1f\x7f]/.test(version)) {
    throw failure('agy_install_manifest_invalid', 502);
  }
  if (typeof sha512 !== 'string' || !/^[0-9a-fA-F]{128}$/.test(sha512)) {
    throw failure('agy_install_manifest_invalid', 502);
  }
  let parsed;
  try { parsed = new URL(url); } catch { throw failure('agy_install_manifest_invalid', 502); }
  if (parsed.protocol !== 'https:' || !PAYLOAD_HOSTS.has(parsed.hostname)) {
    throw failure('agy_install_manifest_invalid', 502);
  }
  return { version, url: parsed.href, sha512: sha512.toLowerCase() };
}

/** execFile wrapper: the inherited environment carries the gateway's proxy
 * variables and curl applies them itself; no shell is involved anywhere. */
function defaultRun(command, args, { timeoutMs, capture = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: capture ? 1024 * 1024 : 64 * 1024,
    }, (error, stdout) => {
      if (error) reject(error); else resolve(capture ? String(stdout) : '');
    });
  });
}

/** A single-flight-capable installer bound to one platform/target. `run` is
 * injectable so tests exercise the whole flow without network or real agy. */
export function createInstaller(options = {}) {
  const {
    platform = process.platform,
    arch = process.arch,
    env = process.env,
    home = homedir(),
    run = defaultRun,
    maxPayloadBytes = MAX_PAYLOAD_BYTES,
    manifestTimeoutMs = MANIFEST_TIMEOUT_MS,
    downloadTimeoutMs = DOWNLOAD_TIMEOUT_MS,
  } = options;
  const targetBinary = defaultBinaryPath(platform, env, home);
  const curl = platform === 'win32' ? 'curl.exe' : 'curl';
  const tar = platform === 'win32' ? 'tar.exe' : 'tar';
  // Redirects may never downgrade to plain HTTP or leave the HTTPS scheme.
  const httpsOnly = ['--proto', '=https', '--proto-redir', '=https'];
  const seconds = ms => String(Math.ceil(ms / 1000));

  async function install() {
    const key = platformKey(platform, arch);
    let manifest;
    try {
      manifest = validateManifest(await run(curl,
        ['-fsSL', ...httpsOnly, '--retry', '2', '--max-time', seconds(manifestTimeoutMs),
          `${MANIFEST_BASE}/manifests/${key}.json`],
        { timeoutMs: manifestTimeoutMs, capture: true }));
    } catch (error) {
      if (typeof error?.code === 'string' && error.code.startsWith('agy_install_')) throw error;
      throw failure('agy_install_manifest_failed', 502);
    }
    const staging = await mkdtemp(join(tmpdir(), 'agy-install-'));
    try {
      const payload = join(staging, 'payload');
      try {
        await run(curl,
          ['-fsSL', ...httpsOnly, '--retry', '2', '--max-time', seconds(downloadTimeoutMs),
            '--max-filesize', String(maxPayloadBytes), '-o', payload, manifest.url],
          { timeoutMs: downloadTimeoutMs + 5000 });
      } catch { throw failure('agy_install_download_failed', 502); }
      // --max-filesize only bites when Content-Length is known; the post-download
      // stat is the unconditional byte cap.
      let size;
      try { size = (await stat(payload)).size; } catch { throw failure('agy_install_download_failed', 502); }
      if (size > maxPayloadBytes) throw failure('agy_install_too_large', 502);
      const hash = createHash('sha512');
      await new Promise((resolve, reject) => {
        createReadStream(payload).on('error', reject).on('data', chunk => hash.update(chunk)).on('end', resolve);
      });
      if (hash.digest('hex') !== manifest.sha512) throw failure('agy_install_checksum_mismatch', 502);
      // Unix releases are tar.gz with a single `antigravity` member (the
      // bootstrapper extracts exactly that name); Windows ships a raw .exe.
      let binarySource = payload;
      if (new URL(manifest.url).pathname.endsWith('.tar.gz')) {
        try {
          await run(tar, ['-xzf', payload, '-C', staging, 'antigravity'], { timeoutMs: EXTRACT_TIMEOUT_MS });
        } catch { throw failure('agy_install_extract_failed', 502); }
        binarySource = join(staging, 'antigravity');
      }
      // Atomic placement: copy to a temp name IN the target directory, chmod
      // there, then rename. A crash mid-copy can never leave a truncated file
      // at the official path (which status would report as detectedBinary),
      // and on unix the rename safely replaces a running executable.
      const temporary = join(dirname(targetBinary), `.agy-${randomUUID()}.tmp`);
      try {
        await mkdir(dirname(targetBinary), { recursive: true });
        await copyFile(binarySource, temporary);
        if (platform !== 'win32') await chmod(temporary, 0o755);
        await rename(temporary, targetBinary);
      } catch {
        await rm(temporary, { force: true }).catch(() => {});
        throw failure('agy_install_write_failed', 500);
      }
      // Best-effort vendor handoff, exactly like the bootstrappers' `|| true`
      // steps: clear macOS quarantine and let agy configure the shell PATH.
      if (platform === 'darwin') {
        await run('xattr', ['-d', 'com.apple.quarantine', targetBinary], { timeoutMs: 5000 }).catch(() => {});
      }
      await run(targetBinary, ['install'], { timeoutMs: HANDOFF_TIMEOUT_MS }).catch(() => {});
      return { version: manifest.version, binary: targetBinary };
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }

  return { install, targetBinary };
}