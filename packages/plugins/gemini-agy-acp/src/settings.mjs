import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { failure } from './chat.mjs';

const NAME = 'gemini-agy-acp';
/** The two transport-level auth methods; oauth-personal carries no apiKey at
 * all — its credential is the CLI's own Google login. */
export const AUTH_METHODS = ['gemini-api-key', 'oauth-personal'];
const MAX_API_KEY_BYTES = 4096;
const MAX_HIDDEN_MODEL_CHARS = 128;
const MAX_HIDDEN_MODELS = 256;

export function settingsPath(configDir) {
  return join(configDir, `${NAME}.json`);
}

/** A hidden-model id is a bounded, non-control string (never a secret
 * carrier; C0 controls and DEL cannot appear in advertised model ids). */
function hiddenModelShapeOk(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= MAX_HIDDEN_MODEL_CHARS &&
    !/[\0-\x1f\x7f]/.test(id);
}

/** The sidecar's hidden-model blacklist, normalized: invalid entries are
 * dropped, duplicates collapse, order is preserved and the list is capped so
 * a hand-edited sidecar can never grow config.json unboundedly. Absent or
 * malformed containers normalize to []. */
export function hiddenModelsOf(raw) {
  const entries = Array.isArray(raw?.hiddenModels) ? raw.hiddenModels : [];
  const hidden = [];
  const seen = new Set();
  for (const id of entries) {
    if (!hiddenModelShapeOk(id) || seen.has(id)) continue;
    seen.add(id);
    hidden.push(id);
    if (hidden.length >= MAX_HIDDEN_MODELS) break;
  }
  return hidden;
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
 * apiKey. gemini-api-key mode keeps the optional key with the transport's
 * GEMINI_API_KEY process environment fallback (the pre-card behavior);
 * oauth-personal mode must NOT carry an apiKey at all (presence fails closed
 * — its credential is the CLI's own Google login). Any malformed enabled
 * field fails closed. The resolved apiKey never travels anywhere except into
 * the transport factory arguments. */
export function enabledSettings(raw) {
  if (raw?.enabled !== true) return null;
  const { binary, authMethod, timeoutMs = 60000, maxWorkers = 2, apiKey } = raw;
  if (typeof binary !== 'string' || !isAbsolute(binary) || binary.includes('\0') || !AUTH_METHODS.includes(authMethod) ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000 ||
      !Number.isSafeInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 8 ||
      (apiKey != null && (authMethod !== 'gemini-api-key' || !apiKeyShapeOk(apiKey)))) {
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
export async function writeSidecar(configDir, merge, prepare) {
  const { raw } = await readSidecar(configDir);
  const next = { ...(objectOrNothing(raw) ?? {}), ...merge };
  await prepare?.(next);
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
