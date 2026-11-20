import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { failure } from './chat.mjs';

const NAME = 'gemini-agy-acp';
const MAX_API_KEY_BYTES = 4096;

export function settingsPath(configDir) {
  return join(configDir, `${NAME}.json`);
}

/** A sidecar apiKey is configured only as a bounded, non-empty string. */
export function apiKeyShapeOk(apiKey) {
  return typeof apiKey === 'string' && apiKey.length > 0 && apiKey.length <= MAX_API_KEY_BYTES &&
    !apiKey.includes('\0');
}

function objectOrNothing(raw) {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
}

/** Validate the enabled transport settings, resolving the optional sidecar
 * apiKey. Absent or null apiKey keeps the transport's GEMINI_API_KEY process
 * environment fallback (the pre-card behavior). Any malformed enabled field
 * fails closed. The resolved apiKey never travels anywhere except into the
 * transport factory arguments. */
export function enabledSettings(raw) {
  if (raw?.enabled !== true) return null;
  const { binary, authMethod, timeoutMs = 60000, maxWorkers = 1, apiKey } = raw;
  if (typeof binary !== 'string' || !isAbsolute(binary) || binary.includes('\0') || authMethod !== 'gemini-api-key' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000 ||
      !Number.isSafeInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 8 ||
      (apiKey != null && !apiKeyShapeOk(apiKey))) {
    throw failure('agy_config_invalid', 503);
  }
  return { binary, authMethod, timeoutMs, maxWorkers, ...(apiKeyShapeOk(apiKey) ? { apiKey } : {}) };
}

/** Full sidecar read: {raw, mtimeMs, existed}. raw is the parsed JSON object
 * (null when the file is absent) and mtimeMs keys the mtime-gated cache.
 * Malformed JSON or an unexpected read error fails closed. */
export async function readSidecar(configDir) {
  let text;
  try {
    text = await readFile(settingsPath(configDir), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { raw: null, mtimeMs: null, existed: false };
    throw failure('agy_config_invalid', 503);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw failure('agy_config_invalid', 503);
  }
  let mtimeMs = null;
  try {
    mtimeMs = (await stat(settingsPath(configDir))).mtimeMs;
  } catch { /* raced removal: the parse result above still applies */ }
  return { raw, mtimeMs, existed: true };
}

/** Stat-gated sidecar cache: a full read+parse happens only when the file's
 * mtime changed, so every chat request can notice sidecar edits without a
 * gateway restart and without re-reading an unchanged file. */
export function sidecarCache(configDir) {
  let cached;
  return {
    async read() {
      let mtimeMs = null;
      try {
        mtimeMs = (await stat(settingsPath(configDir))).mtimeMs;
      } catch (error) {
        if (error.code !== 'ENOENT') throw failure('agy_config_invalid', 503);
      }
      if (cached && cached.mtimeMs === mtimeMs) return cached;
      const fresh = await readSidecar(configDir);
      cached = { mtimeMs: fresh.mtimeMs, raw: fresh.raw };
      return cached;
    },
    invalidate() { cached = undefined; },
  };
}

/** Merge fields into the sidecar atomically and keep it 0600. The apiKey is
 * intentionally persisted here (never in config.json, logs or responses);
 * the mode is enforced with chmod so an existing looser file is tightened. */
export async function writeSidecar(configDir, merge) {
  const { raw } = await readSidecar(configDir);
  const next = { ...(objectOrNothing(raw) ?? {}), ...merge };
  const path = settingsPath(configDir);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw failure('agy_config_write_failed', 500);
  }
}
