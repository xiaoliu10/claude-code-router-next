import { access, stat } from 'node:fs/promises';
import { constants, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { AcpError } from './acp-errors.mjs';
import { registerAdminRoutes } from './admin-routes.mjs';
import { accountEmailShapeOk } from './account.mjs';
import { chatResponse, failure, textTurns, toPrompt } from './chat.mjs';
import { createInstaller } from './install.mjs';
import { AUTH_METHODS, apiKeyShapeOk, enabledSettings, hiddenModelsOf, readSidecar, sidecarCache, writeSidecar } from './settings.mjs';

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

// Resolve the proxy the agy CLI must use for its own upstream calls, with the
// same semantics as the core's resolveProviderProxyUrl: the configured proxy
// (compatibility keys included) applies when the global proxy is enabled (the
// core default when unset) or when this managed provider entry opts in.
// Reads never throw: an unreadable config simply yields no proxy.
const PROXY_URL_KEYS = ['HTTPS_PROXY', 'https_proxy', 'httpsProxy', 'PROXY_URL'];

function globalProxyEnabled(value) {
  if (value === undefined || value === null || value === '') return true;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'false' || normalized === '0') return false;
    if (normalized === 'true' || normalized === '1') return true;
    return Boolean(normalized);
  }
  return Boolean(value);
}

// Same $VAR/${VAR} interpolation the core read path applies, limited to the
// few scalar values this resolver consumes.
function interpolateString(value) {
  return value.replace(/\$\{([^}]+)\}|\$([A-Z_][A-Z0-9_]*)/g,
    (match, braced, unbraced) => process.env[braced || unbraced] || match);
}

// mtime-gated snapshot cache: the request path must not re-read and re-parse
// the whole config on every turn. Keyed by host so tests stay isolated.
const configSnapshots = new WeakMap();
// Dedupe rejected-proxy diagnostics per host: a persistent bad value must
// not warn on every turn.
const proxyWarnState = new WeakMap();

async function readConfigSnapshot(host) {
  // Non-fatal raw read only: readConfigFile exits the process on parse errors
  // and auto-creates a default on ENOENT — never call it from the request path.
  if (typeof host?.readRawConfig !== 'function') return undefined;
  let cacheKey = null;
  try {
    const info = await stat(join(host.configDir, 'config.json'));
    cacheKey = `${info.mtimeMs}:${info.size}`;
    const cached = configSnapshots.get(host);
    if (cached && cached.key === cacheKey) return cached.raw;
  } catch { /* no usable stat: read uncached */ }
  // One retry softens the torn-read window of the core's non-atomic save.
  let raw;
  try {
    raw = await host.readRawConfig();
  } catch {
    try {
      raw = await host.readRawConfig();
    } catch {
      return undefined;
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  if (cacheKey) configSnapshots.set(host, { key: cacheKey, raw });
  return raw;
}

export async function resolveProxyUrl(host, providerName = 'gemini-agy-acp', log) {
  let raw;
  try {
    raw = await readConfigSnapshot(host);
  } catch {
    return undefined;
  }
  if (!raw) return undefined;
  let proxyUrl;
  for (const key of PROXY_URL_KEYS) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    // Interpolate before trimming, matching the core read-then-normalize order.
    const normalized = interpolateString(String(value)).trim();
    if (normalized) { proxyUrl = normalized; break; }
  }
  if (!proxyUrl) return undefined;
  if (!/^https?:\/\//i.test(proxyUrl)) {
    // Diagnostics carry the scheme or the placeholder fact only — never the
    // value, which can embed credentials.
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(proxyUrl)?.[1];
    const kind = scheme ? 'scheme:' + scheme : proxyUrl.startsWith('$') ? 'placeholder' : null;
    if (kind) {
      const last = host && typeof host === 'object' ? proxyWarnState.get(host) : undefined;
      if (last !== kind) {
        if (host && typeof host === 'object') proxyWarnState.set(host, kind);
        log?.warn?.(scheme
          ? 'gemini-agy-acp ignored a configured proxy with unsupported scheme (' + scheme + ')'
          : 'gemini-agy-acp ignored a configured proxy with an unresolved environment placeholder');
      }
    }
    return undefined;
  }
  const flag = typeof raw.PROXY_GLOBAL_ENABLED === 'string' ? interpolateString(raw.PROXY_GLOBAL_ENABLED) : raw.PROXY_GLOBAL_ENABLED;
  if (globalProxyEnabled(flag)) return proxyUrl;
  const providers = Array.isArray(raw.Providers) ? raw.Providers : Array.isArray(raw.providers) ? raw.providers : [];
  const entry = providers.find(item => item?.name === providerName);
  return entry?.proxyEnabled === true || entry?.proxy_enabled === true ? proxyUrl : undefined;
}

export async function activateWithTransport(ctx, createTransport, options = {}) {
  const configDir = ctx.host.configDir;
  const log = ctx.log;
  // Metadata-only default instance (targetBinary for status); the install
  // kick below builds a proxy-aware instance per attempt.
  const installer = options.installer ?? createInstaller();
  const cache = sidecarCache(configDir);
  let transport;
  // Fingerprint of the settings the live pool was built from; a changed
  // fingerprint (binary, auth method, apiKey, limits) is what actually swaps
  // the pool, so a models-sync write never retires healthy workers.
  let fingerprint;
  let rebuilding;
  let adminMutation = Promise.resolve();
  let lastError;
  // Background install state: single-flight promise while the official agy
  // download runs, the last failure token, and the path placed by a successful
  // install (reported as detectedBinary until Connect persists it).
  let installing = null;
  let installError = null;
  let installedBinary = null;

  const note = error => {
    lastError = { code: safeCode(error), at: Date.now() };
    return error;
  };
  const baseKeyOf = settings => JSON.stringify([settings.binary, settings.authMethod, settings.apiKey ?? null, settings.timeoutMs, settings.maxWorkers]);
  const fingerprintOf = settings => JSON.stringify([settings.binary, settings.authMethod, settings.apiKey ?? null, settings.timeoutMs, settings.maxWorkers, settings.proxyUrl ?? null]);
  let lastBaseKey = null;

  async function applyTransport(force = false) {
    const snapshot = await cache.read();
    const base = enabledSettings(snapshot.raw);
    // Re-resolve on every (re)build so a proxy config change swaps the pool.
    const proxyUrl = base ? await resolveProxyUrl(ctx.host, 'gemini-agy-acp', log) : undefined;
    const settings = base ? { ...base, ...(proxyUrl ? { proxyUrl } : {}) } : undefined;
    const next = settings ? fingerprintOf(settings) : null;
    if (!force && next === fingerprint) return;
    const previous = transport;
    transport = settings ? await createTransport({ ...settings, ...(log ? { log } : {}) }) : undefined;
    // A proxy-only change drains idle workers instead of killing in-flight
    // turns; busy workers finish on the old pool and idle-retire naturally.
    const proxyOnly = previous && base && baseKeyOf(base) === lastBaseKey;
    fingerprint = next;
    lastBaseKey = base ? baseKeyOf(base) : null;
    await (proxyOnly ? previous.retireIdle() : previous?.retireExisting());
  }

  function queueTransportUpdate(update) {
    const next = Promise.resolve(rebuilding).catch(() => {}).then(update).finally(() => {
      if (rebuilding === next) rebuilding = null;
    });
    rebuilding = next;
    return next;
  }

  /** Single-flight settings refresh; safe to await from every request. */
  function requireTransport(force = false) {
    return !rebuilding || force ? queueTransportUpdate(() => applyTransport(force)) : rebuilding;
  }

  async function connected() {
    await requireTransport();
    if (!transport) throw failure('agy_disabled', 503);
    return transport;
  }

  // Single-flight background install of the official agy binary for this
  // platform/architecture. The route kicks it off and answers immediately;
  // the card polls /status until the download finishes. Success never touches
  // the sidecar — Connect remains the only action that persists settings and
  // enables the provider.
  function startInstall() {
    if (installing) return installing;
    installError = null;
    installing = (async () => {
      const proxyUrl = await resolveProxyUrl(ctx.host, 'gemini-agy-acp', log);
      return (options.installer ?? createInstaller({ proxyUrl })).install();
    })()
      .then(result => { installedBinary = result.binary; })
      .catch(error => { installError = { code: safeCode(error), at: Date.now() }; })
      .finally(() => { installing = null; });
    return installing;
  }

  async function install() {
    void startInstall();
    return status();
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
    // With no sidecar binary, surface an agy found at the official default
    // location (or placed by the background install) so the card can prefill
    // it without any config write.
    let detectedBinary = null;
    if (!binary) {
      const candidate = installedBinary ?? installer.targetBinary;
      try { if (statSync(candidate).isFile()) detectedBinary = candidate; } catch { /* not installed */ }
    }
    const version = typeof raw?.version === 'string' && raw.version.length > 0 && raw.version.length <= 128
      ? raw.version : null;
    const models = publicModels(raw?.models);
    const modelsSyncedAt = typeof raw?.modelsSyncedAt === 'number' && Number.isSafeInteger(raw.modelsSyncedAt)
      ? raw.modelsSyncedAt : undefined;
    const authMethod = AUTH_METHODS.includes(raw?.authMethod) ? raw.authMethod : null;
    const oauth = authMethod === 'oauth-personal';
    // The account email is only ever the one persisted from connect's verified
    // handshake of the selected binary — never discovered from stale logs.
    const accountEmail = oauth && accountEmailShapeOk(raw?.accountEmail) ? raw.accountEmail : null;
    return {
      loaded: transport !== undefined,
      enabled: raw?.enabled === true,
      binary,
      binaryFound,
      detectedBinary,
      installing: installing !== null,
      installError: installError ?? null,
      version,
      lastError: lastError ?? null,
      authMethod,
      // oauth-personal pools carry no API key credential at all: the CLI uses
      // its own OS-keyring Google login, so the key fields stay empty.
      apiKeyConfigured: !oauth && (apiKeyShapeOk(raw?.apiKey) || apiKeyShapeOk(process.env.GEMINI_API_KEY)),
      apiKeyFingerprint: oauth ? null : credentialFingerprint(raw?.apiKey),
      ...(accountEmail ? { accountEmail } : {}),
      ...(models ? { models } : {}),
      ...(modelsSyncedAt !== undefined ? { modelsSyncedAt } : {}),
      hiddenModels: hiddenModelsOf(raw).filter(id => models?.some(model => model.id === id)),
    };
  }

  async function connect(body) {
    const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    const { raw } = await readSidecar(configDir);
    const merged = { ...(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) };
    const authMethod = input.authMethod === undefined ? AUTH_METHODS[0]
      : AUTH_METHODS.includes(input.authMethod) ? input.authMethod : null;
    if (!authMethod) throw new AcpError('invalid_config');
    const oauth = authMethod === 'oauth-personal';
    // oauth-personal must not carry an apiKey: its credential is the CLI's
    // own Google login, and a stored key would poison the pool settings.
    if (oauth && input.apiKey !== undefined) throw new AcpError('invalid_config');
    if (input.binary !== undefined) {
      if (typeof input.binary !== 'string' || !isAbsolute(input.binary) || input.binary.includes('\0')) {
        throw new AcpError('invalid_config');
      }
      merged.binary = input.binary;
    }
    if (!configuredBinary(merged)) throw new AcpError('invalid_config');
    await assertExecutable(merged.binary);
    // Bounded version probe BEFORE anything is persisted: a failed connect
    // never enables a broken binary. The probe runs in the same auth mode as
    // the pool that follows.
    const { probeVersion } = await loadTransportModule();
    const version = await probeVersion(merged.binary, authMethod, await resolveProxyUrl(ctx.host, 'gemini-agy-acp', log));
    let accountEmail = null;
    if (oauth) {
      // A `--version` probe cannot prove the OS-keyring Google login works:
      // verify with one real bounded ACP handshake (authenticate + session/new)
      // on a temporary worker of the selected binary. Any handshake failure
      // maps to auth_required so the card surfaces the terminal-login hint.
      const { verifyOauthHandshake } = await loadTransportModule();
      try {
        ({ accountEmail } = await verifyOauthHandshake({ binary: merged.binary, log, proxyUrl: await resolveProxyUrl(ctx.host, 'gemini-agy-acp', log) }));
      } catch (error) {
        log?.warn?.(`gemini-agy-acp oauth handshake failed (${safeCode(error)})`);
        throw new AcpError('auth_required');
      }
    } else if (input.apiKey !== undefined) {
      if (!apiKeyShapeOk(input.apiKey) || !input.apiKey.trim()) throw new AcpError('invalid_config');
      merged.apiKey = input.apiKey;
    }
    // Write payload (not the merged view): switching to oauth evicts any
    // stored apiKey, and switching back to gemini-api-key evicts the stale
    // account email. `undefined` merge values delete the persisted keys.
    const payload = oauth
      ? { enabled: true, binary: merged.binary, authMethod, version,
          apiKey: undefined, ...(accountEmail ? { accountEmail } : { accountEmail: undefined }) }
      : { enabled: true, binary: merged.binary, authMethod, version,
          ...(input.apiKey !== undefined ? { apiKey: merged.apiKey } : {}),
          ...(typeof raw?.accountEmail === 'string' ? { accountEmail: undefined } : {}) };
    await queueTransportUpdate(async () => {
      let replacement;
      let settings;
      let proxyUrl;
      try {
        // Validate the complete merged settings and prepare the new pool before
        // replacing the saved credentials or the live pool.
        await writeSidecar(configDir, payload, async next => {
          settings = enabledSettings(next);
          proxyUrl = await resolveProxyUrl(ctx.host, 'gemini-agy-acp', log);
          replacement = await createTransport({ ...settings, ...(proxyUrl ? { proxyUrl } : {}), ...(log ? { log } : {}) });
          if (!replacement) throw failure('agy_config_invalid', 503);
        });
      } catch (error) {
        await replacement?.close()?.catch(() => {});
        throw error;
      }
      cache.invalidate();
      const previous = transport;
      transport = replacement;
      fingerprint = fingerprintOf({ ...settings, ...(proxyUrl ? { proxyUrl } : {}) });
      lastBaseKey = baseKeyOf(settings);
      lastError = undefined;
      await previous?.retireExisting().catch(error => {
        log?.warn?.(`gemini-agy-acp could not retire the previous worker pool (${safeCode(error)})`);
      });
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
    const previous = await readConfig();
    if (!Array.isArray(previous?.Providers)) return;
    const config = structuredClone(previous);
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
    const rollback = async () => {
      try {
        await writeConfig(previous);
        await reloadRuntime?.(previous);
      } catch {
        log?.warn?.('gemini-agy-acp could not restore the previous provider catalog');
      }
    };
    try {
      await writeConfig(config);
      await reloadRuntime?.(config);
      return rollback;
    } catch {
      await rollback();
      throw failure('agy_config_write_failed', 500);
    }
  }

  async function updateCatalog(visibleModels, sidecarPatch) {
    const rollback = await registerProviderModels(visibleModels);
    try {
      await writeSidecar(configDir, sidecarPatch);
      cache.invalidate();
    } catch (error) {
      await rollback?.();
      throw error;
    }
  }

  async function syncModels() {
    const { raw } = await readSidecar(configDir);
    const settings = enabledSettings(raw);
    if (!settings) throw failure('agy_disabled', 503);
    const { syncModelOptions } = await loadTransportModule();
    const oauth = settings.authMethod === 'oauth-personal';
    // oauth-personal pools have no credential: the sync worker authenticates
    // the CLI's own login, exactly like the request pool.
    const apiKey = oauth ? undefined : settings.apiKey ?? process.env.GEMINI_API_KEY;
    if (!oauth && !apiKey?.trim()) throw new AcpError('auth_required');
    const proxyUrl = await resolveProxyUrl(ctx.host, 'gemini-agy-acp', log);
    const { models, version } = await syncModelOptions(oauth
      ? { binary: settings.binary, authMethod: 'oauth-personal', log, proxyUrl }
      : { binary: settings.binary, apiKey, log, proxyUrl });
    const modelsSyncedAt = Date.now();
    // The operator's hide set survives re-syncs; ids that disappeared
    // upstream are dropped from it silently (always persisted so a pruned
    // empty set actually replaces the stale list).
    const hiddenModels = hiddenModelsOf(raw).filter(id => models.some(model => model.id === id));
    await updateCatalog(models.filter(model => !hiddenModels.includes(model.id)),
      { models, modelsSyncedAt, version, hiddenModels });
    return { models, modelsSyncedAt, version };
  }

  // Hide/restore synced models: every id is validated against the synced
  // catalog (unknown → unsupported_option), the merged set persists in the
  // sidecar (hide wins for ids in both lists) and the provider entry is
  // re-registered with the visible models only. Hiding never retires
  // workers — the pool fingerprint does not include models.
  async function hideModels(input) {
    const body = input && typeof input === 'object' && !Array.isArray(input) ? input : null;
    if (!body) throw new AcpError('unsupported_option');
    const { raw } = await readSidecar(configDir);
    const synced = publicModels(raw?.models);
    if (!synced) throw new AcpError('unsupported_option');
    const known = new Set(synced.map(model => model.id));
    const requested = value => {
      if (value === undefined) return [];
      if (!Array.isArray(value)) throw new AcpError('unsupported_option');
      return value;
    };
    for (const id of [...requested(body.hide), ...requested(body.restore)]) {
      if (!known.has(id)) throw new AcpError('unsupported_option');
    }
    // hide wins for ids present in both lists: restores apply first.
    const hidden = new Set(hiddenModelsOf(raw).filter(id => known.has(id)));
    for (const id of requested(body.restore)) hidden.delete(id);
    for (const id of requested(body.hide)) hidden.add(id);
    const hiddenModels = [...hidden];
    await updateCatalog(synced.filter(model => !hidden.has(model.id)), { hiddenModels });
    return status();
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

  // Serialize admin updates that read and write both the sidecar and catalog.
  // A failed mutation must not prevent the next admin operation from running.
  const serialized = operation => (...args) => {
    const next = adminMutation.then(() => operation(...args));
    adminMutation = next.catch(() => {});
    return next;
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
    install: guarded(install),
    connect: guarded(serialized(connect)),
    disconnect: guarded(serialized(disconnect)),
    syncModels: guarded(serialized(syncModels)),
    hideModels: guarded(serialized(hideModels)),
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
