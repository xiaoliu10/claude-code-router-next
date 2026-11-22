import { access, stat } from 'node:fs/promises';
import { constants, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { AcpError } from './acp-errors.mjs';
import { registerAdminRoutes } from './admin-routes.mjs';
import { chatResponse, failure, textTurns, toPrompt } from './chat.mjs';
import { apiKeyShapeOk, enabledSettings, readSidecar, sidecarCache, writeSidecar } from './settings.mjs';

const NAME = 'gemini-agy-acp';
const MARKER = `ccr-managed-${NAME}`;
const SAFE_CODE = /^[a-z][a-z0-9_]{0,63}$/;

// Importing transport.mjs must not start a subprocess; loading and installing
// this prototype alone stays inert.
const loadTransportModule = () => import('./transport.mjs');

// Short non-reversible fingerprint of the configured credential so the card
// can show WHICH key is connected without ever serializing the key itself.
function credentialFingerprint(apiKey) {
  const key = apiKeyShapeOk(apiKey) ? apiKey : process.env.GEMINI_API_KEY;
  if (!apiKeyShapeOk(key)) return null;
  return createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 10);
}

function assertProvider(provider) {
  if (provider?.name !== NAME || provider.apiKey !== MARKER || provider.enabled === false) {
    throw failure('agy_provider_config_invalid', 503);
  }
}

function safeCode(error) {
  return typeof error?.code === 'string' && SAFE_CODE.test(error.code) ? error.code : 'agy_route_error';
}

/** The card-facing model list: ids/names only, deduplicated and bounded. */
function publicModels(value) {
  if (!Array.isArray(value)) return undefined;
  const models = [];
  const seen = new Set();
  for (const entry of value) {
    if (!entry || typeof entry.id !== 'string' || !entry.id || seen.has(entry.id)) continue;
    seen.add(entry.id);
    models.push({ id: entry.id, name: typeof entry.name === 'string' && entry.name ? entry.name : entry.id });
    if (models.length >= 256) break;
  }
  return models.length ? models : undefined;
}

function configuredBinary(raw) {
  return typeof raw?.binary === 'string' && isAbsolute(raw.binary) && !raw.binary.includes('\0') ? raw.binary : null;
}

async function assertExecutable(binary) {
  try {
    if (!(await stat(binary)).isFile()) throw new Error('not a file');
    await access(binary, constants.X_OK);
  } catch {
    throw new AcpError('invalid_config');
  }
}

export async function activateWithTransport(ctx, createTransport) {
  const configDir = ctx.host.configDir;
  const log = ctx.log;
  const cache = sidecarCache(configDir);
  let transport;
  // Fingerprint of the settings the live pool was built from; a changed
  // fingerprint (binary, apiKey, limits) is what actually swaps the pool, so
  // a models-sync write never retires healthy workers.
  let fingerprint;
  let rebuilding;
  let lastError;

  const note = error => {
    lastError = { code: safeCode(error), at: Date.now() };
    return error;
  };
  const fingerprintOf = settings => JSON.stringify([settings.binary, settings.apiKey ?? null, settings.timeoutMs, settings.maxWorkers]);

  async function applyTransport(force = false) {
    const snapshot = await cache.read();
    const settings = enabledSettings(snapshot.raw);
    const next = settings ? fingerprintOf(settings) : null;
    if (!force && next === fingerprint) return;
    const previous = transport;
    transport = settings ? await createTransport({ ...settings, ...(log ? { log } : {}) }) : undefined;
    fingerprint = next;
    await previous?.retireExisting();
  }

  /** Single-flight settings refresh; safe to await from every request. The
   * force variant re-swaps even an unchanged fingerprint so a connect always
   * retires the live pool (fresh environment capture included). */
  function requireTransport(force = false) {
    if (!rebuilding || force) rebuilding = applyTransport(force).finally(() => { rebuilding = null; });
    return rebuilding;
  }

  async function connected() {
    await requireTransport();
    if (!transport) throw failure('agy_disabled', 503);
    return transport;
  }

  async function status() {
    let raw = null;
    try {
      ({ raw } = await readSidecar(configDir));
    } catch (error) {
      note(error);
    }
    const binary = configuredBinary(raw);
    let binaryFound = false;
    if (binary) {
      try {
        binaryFound = statSync(binary).isFile();
      } catch { /* reported as not found */ }
    }
    const version = typeof raw?.version === 'string' && raw.version.length > 0 && raw.version.length <= 128
      ? raw.version : null;
    const models = publicModels(raw?.models);
    const modelsSyncedAt = typeof raw?.modelsSyncedAt === 'number' && Number.isSafeInteger(raw.modelsSyncedAt)
      ? raw.modelsSyncedAt : undefined;
    return {
      loaded: transport !== undefined,
      enabled: raw?.enabled === true,
      binary,
      binaryFound,
      version,
      lastError: lastError ?? null,
      // Both credential fields share one validation so a malformed env key
      // reports "no API key" instead of a fingerprint-less configured state.
      apiKeyConfigured: apiKeyShapeOk(raw?.apiKey) || apiKeyShapeOk(process.env.GEMINI_API_KEY),
      apiKeyFingerprint: credentialFingerprint(raw?.apiKey),
      ...(models ? { models } : {}),
      ...(modelsSyncedAt !== undefined ? { modelsSyncedAt } : {}),
    };
  }

  async function connect(body) {
    const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    const { raw } = await readSidecar(configDir);
    const merged = { ...(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) };
    if (input.binary !== undefined) {
      if (typeof input.binary !== 'string' || !isAbsolute(input.binary) || input.binary.includes('\0')) {
        throw new AcpError('invalid_config');
      }
      merged.binary = input.binary;
    }
    if (!configuredBinary(merged)) throw new AcpError('invalid_config');
    await assertExecutable(merged.binary);
    // Bounded version probe BEFORE anything is persisted: a failed connect
    // never enables a broken binary.
    const { probeVersion } = await loadTransportModule();
    const version = await probeVersion(merged.binary);
    merged.version = version;
    if (input.apiKey !== undefined) {
      if (!apiKeyShapeOk(input.apiKey) || !input.apiKey.trim()) throw new AcpError('invalid_config');
      merged.apiKey = input.apiKey;
    }
    // Full transport validation of the merged settings before the write.
    enabledSettings(merged);
    await writeSidecar(configDir, {
      enabled: true,
      binary: merged.binary,
      authMethod: 'gemini-api-key',
      version,
      ...(input.apiKey !== undefined ? { apiKey: merged.apiKey } : {}),
    });
    cache.invalidate();
    await requireTransport(true).catch(error => {
      note(error);
      log?.warn?.(`gemini-agy-acp connect could not refresh the worker pool (${safeCode(error)})`);
    });
    return status();
  }

  async function disconnect() {
    await writeSidecar(configDir, { enabled: false });
    cache.invalidate();
    await requireTransport(true).catch(error => {
      note(error);
      log?.warn?.(`gemini-agy-acp disconnect could not refresh the worker pool (${safeCode(error)})`);
    });
    return status();
  }

  // Register the managed provider entry and the discovered models so the
  // router accepts them, mirroring the codex plugin's sync semantics: Router
  // untouched, best-effort rollback on a failed write. A missing entry is
  // created with the managed marker and a placeholder URL (never dialed), so
  // the card alone is enough to go from install to first message.
  async function registerProviderModels(models) {
    const { readConfig, writeConfig, reloadRuntime } = ctx.host;
    if (typeof readConfig !== 'function' || typeof writeConfig !== 'function') return;
    const config = await readConfig();
    if (!Array.isArray(config?.Providers)) return;
    let provider = config.Providers.find(entry => entry?.name === NAME);
    const ids = models.map(model => model.id);
    if (!provider) {
      provider = { name: NAME, api_base_url: 'https://example.com/unused', api_key: MARKER, models: ids, transformer: { use: [NAME] } };
      config.Providers.push(provider);
    } else if (JSON.stringify(provider.models ?? []) === JSON.stringify(ids) &&
        provider.api_key === MARKER && Array.isArray(provider.transformer?.use) && provider.transformer.use.includes(NAME)) {
      return;
    } else {
      provider.models = ids;
    }
    const previous = JSON.stringify(config);
    try {
      await writeConfig(config);
      await reloadRuntime?.(config);
    } catch {
      try { await writeConfig(JSON.parse(previous)); } catch { /* original failure is reported below */ }
      throw failure('agy_config_write_failed', 500);
    }
  }

  async function syncModels() {
    const { raw } = await readSidecar(configDir);
    const settings = enabledSettings(raw);
    if (!settings) throw failure('agy_disabled', 503);
    const apiKey = settings.apiKey ?? process.env.GEMINI_API_KEY;
    if (!apiKey?.trim()) throw new AcpError('auth_required');
    const { syncModelOptions } = await loadTransportModule();
    const { models, version } = await syncModelOptions({ binary: settings.binary, apiKey, log });
    const modelsSyncedAt = Date.now();
    await writeSidecar(configDir, { models, modelsSyncedAt, version });
    cache.invalidate();
    await registerProviderModels(models);
    return { models, modelsSyncedAt, version };
  }

  // Eager load at activation: a valid sidecar starts the pool now; a missing
  // or malformed one stays a per-request failure until Connect fixes it — the
  // mtime-gated cache retries on every request without a gateway restart.
  try {
    await requireTransport();
  } catch (error) {
    note(error);
    log?.warn?.(`gemini-agy-acp starts disabled (${safeCode(error)})`);
  }

  const guarded = operation => async (...args) => {
    try {
      return await operation(...args);
    } catch (error) {
      throw note(error);
    }
  };

  class AgyTransformer {
    static TransformerName = NAME;
    name = NAME;

    async transformRequestIn(body, provider, context) {
      if (provider?.name === NAME && context?.req) context.req.enableFallback = false;
      assertProvider(provider);
      await connected();
      if (context?.req?.body) textTurns(context.req.body);
      return { body };
    }
  }
  ctx.registerTransformer(AgyTransformer);
  // Read-only management card; the UI renders a hard failure for enabled
  // plugins that ship none, so this prototype must always declare one.
  ctx.registerUiCard?.({ cardPath: 'card.js' });
  ctx.registerAdminRoutes?.(app => registerAdminRoutes(app, { getService: () => ({
    status: () => status(),
    connect: guarded(connect),
    disconnect: guarded(disconnect),
    syncModels: guarded(syncModels),
  }) }));
  ctx.registerManagedRuntime({
    name: NAME,
    // Claim this exact reserved name even on a malformed entry, so it fails
    // closed instead of taking the ordinary OpenAI HTTP path.
    isManaged: provider => provider?.name === NAME,
    suppressDebugLog: true,
    async signRequest() { throw failure('agy_http_disabled', 503); },
    async probeAccountState() { return { available: false, reason: 'agy_probe_disabled' }; },
    async probeLiveness() { return new Response(null, { status: 503 }); },
    async dispatchRequest({ requestBody, req, config, provider }) {
      if (req) req.enableFallback = false;
      assertProvider(provider);
      const local = await connected();
      if (req?.body) textTurns(req.body);
      return chatResponse(local, toPrompt(requestBody, provider, req?.body), requestBody.stream === true, req, config);
    },
  });
}

export function activate(ctx) {
  return activateWithTransport(ctx, async options => (await loadTransportModule()).createTransport(options));
}
