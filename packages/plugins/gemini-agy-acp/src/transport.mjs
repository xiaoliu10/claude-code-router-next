import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { configureSession, modelOptions, modelSelector } from './acp-config.mjs';
import { AcpError } from './acp-errors.mjs';
import { AcpStdio } from './acp-stdio.mjs';
import { accountEmailShapeOk, extractAccountEmail } from './account.mjs';

const AUTH_METHOD = 'gemini-api-key';
const OAUTH_METHOD = 'oauth-personal';
const AUTH_METHODS = new Set([AUTH_METHOD, OAUTH_METHOD]);
const MAX_PROMPT_BYTES = 1024 * 1024;
const IDLE_MS = 30_000;
const MAX_SESSIONS = 64;
const PROBE_MS = 5000;
const MODEL_SYNC_MS = 5000;
const OAUTH_VERIFY_MS = 10_000;
const MAX_STDERR_TAIL_BYTES = 64 * 1024;
const STOP_REASONS = new Set(['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled']);

function clientVersion() {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch (error) {
    if (error.code === 'ENOENT') return '0.0.0'; // standalone transport
    throw new AcpError('invalid_config');
  }
}
const clientInfo = { name: 'ccr-gemini-agy-acp', version: clientVersion() };

function cliVersion(output) {
  const versions = [...output.matchAll(/(?:^|[\s:(])v?(\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?)(?=$|[\s,)])/gi)];
  return versions.length === 1 ? versions[0][1] : null;
}

function supportedVersion(version) {
  if (!version) return false;
  const [release, prerelease] = version.split('+')[0].split('-');
  const [major, minor, patch] = release.split('.').map(Number);
  return major > 1 || (major === 1 && (minor > 5 || (minor === 5 && (patch > 1 || (patch === 1 && !prerelease)))));
}

// The CLI honors the standard proxy variables for its own upstream calls;
// forward whichever are set in the CCR process (isolated otherwise).
const PROXY_ENV_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy'];

// An isolated runtime is NOT guaranteed to share the CLI's Google login, so
// oauth-personal workers run in the real user context with a whitelist of
// only what the child needs to run, reach its network endpoints and use the
// OS keyring/browser login: runtime paths, real HOME, temp dirs, platform
// config locations, GUI/DBus sessions and the standard proxy variables.
// Never a blanket process.env copy — credential variables such as
// GEMINI_API_KEY and GOOGLE_APPLICATION_CREDENTIALS are absent by design.
const OAUTH_ENV_VARS = ['PATH', 'HOME', 'USERPROFILE', 'LANG', 'TMPDIR', 'TEMP', 'TMP',
  'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'SystemRoot', 'COMSPEC', 'PATHEXT',
  'DBUS_SESSION_BUS_ADDRESS', 'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', ...PROXY_ENV_VARS];

function oauthEnvironment() {
  const env = {};
  for (const name of OAUTH_ENV_VARS) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

export async function isolatedEnvironment(root) {
  const dirs = Object.fromEntries(['home', 'config', 'data', 'cache', 'state', 'tmp', 'runtime', 'work']
    .map(name => [name, join(root, name)]));
  await Promise.all(Object.values(dirs).map(path => mkdir(path, { mode: 0o700 })));
  const env = {
    HOME: dirs.home, USERPROFILE: dirs.home, XDG_CONFIG_HOME: dirs.config, XDG_DATA_HOME: dirs.data,
    XDG_CACHE_HOME: dirs.cache, XDG_STATE_HOME: dirs.state, XDG_RUNTIME_DIR: dirs.runtime,
    APPDATA: dirs.config, LOCALAPPDATA: dirs.data, TMPDIR: dirs.tmp, TEMP: dirs.tmp, TMP: dirs.tmp,
    PATH: '/usr/bin:/bin', LANG: 'C',
  };
  for (const name of PROXY_ENV_VARS) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  if (process.platform === 'win32') {
    env.SystemRoot = process.env.SystemRoot;
    env.PATH = join(env.SystemRoot, 'System32');
  }
  return { env, cwd: dirs.work };
}

class Worker {
  constructor(binary, authMethod, onRetired, log, { captureStderr = false } = {}) {
    this.binary = binary;
    this.authMethod = authMethod;
    this.onRetired = onRetired;
    this.log = log;
    this.captureStderr = captureStderr;
    this.stderrChunks = [];
    this.stderrBytes = 0;
    this.sessions = new Set();
  }

  check() {
    if (this.failure) throw this.failure;
  }

  spawnChild(args, env, captureStderr = false) {
    this.check();
    const child = spawn(this.binary, args, {
      cwd: this.cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32',
      // Subprocess diagnostics may contain credentials or prompts; they are
      // captured only for the bounded oauth login verification below and are
      // never logged or returned raw.
      stdio: ['pipe', 'pipe', captureStderr ? 'pipe' : 'ignore'],
    });
    this.child = child;
    this.childClosed = new Promise(resolve => child.once('close', resolve));
    const fail = () => this.retire(new AcpError('worker_failed'));
    child.on('error', fail);
    child.stdin.on('error', fail);
    child.stdout.on('error', fail);
    child.stderr?.on('error', fail);
    if (captureStderr) {
      // Bounded rolling tail (last 64 KiB) of THIS child's diagnostics.
      child.stderr.on('data', chunk => {
        this.stderrChunks.push(chunk);
        this.stderrBytes += chunk.length;
        while (this.stderrBytes > MAX_STDERR_TAIL_BYTES && this.stderrChunks.length) {
          const drop = Math.min(this.stderrBytes - MAX_STDERR_TAIL_BYTES, this.stderrChunks[0].length);
          this.stderrChunks[0] = this.stderrChunks[0].subarray(drop);
          if (this.stderrChunks[0].length === 0) this.stderrChunks.shift();
          this.stderrBytes -= drop;
        }
      });
    }
    return child;
  }

  /** The captured diagnostics tail, scanned only for the account email. */
  stderrText() {
    return Buffer.concat(this.stderrChunks, this.stderrBytes).toString('utf8');
  }

  /** The bounded `--version` probe. Returns the advertised CLI version and
   * leaves the workspace in place for the ACP child that follows. OAuth
   * workers use a private temporary cwd and the whitelisted real environment
   * so the CLI can use its native login. */
  async probe() {
    this.rootReady = (async () => {
      this.root = await mkdtemp(join(tmpdir(), 'ccr-agy-acp-'));
      if (this.authMethod === OAUTH_METHOD) {
        this.cwd = this.root;
        this.spawnEnv = oauthEnvironment();
      } else {
        const isolation = await isolatedEnvironment(this.root);
        this.cwd = isolation.cwd;
        this.spawnEnv = isolation.env;
      }
    })();
    await this.rootReady;
    const probe = this.spawnChild(['--version'], this.spawnEnv);
    let output = '';
    let bytes = 0;
    probe.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 4096) this.retire(new AcpError('output_limit'));
      else output += chunk.toString('ascii');
    });
    probe.stdin.end();
    const probeTimeout = setTimeout(() => this.retire(new AcpError('timeout')), PROBE_MS);
    let exitCode;
    try { exitCode = await this.childClosed; } finally { clearTimeout(probeTimeout); }
    this.child = null;
    this.check();
    const version = cliVersion(output);
    if (exitCode !== 0 || !supportedVersion(version)) throw new AcpError('unsupported_version');
    this.version = version;
    return version;
  }

  async start(apiKey) {
    await this.probe();
    this.check();

    const child = this.spawnChild(['acp', '--sandbox'],
      this.authMethod === OAUTH_METHOD ? this.spawnEnv : { ...this.spawnEnv, GEMINI_API_KEY: apiKey },
      this.captureStderr);
    child.once('exit', () => this.retire(new AcpError('worker_failed')));
    child.stdout.once('end', () => this.retire(new AcpError('worker_failed')));
    this.rpc = new AcpStdio(child, error => this.retire(error));
    const init = await this.rpc.request('initialize', { protocolVersion: 1, clientInfo, clientCapabilities: {} });
    if (init.protocolVersion !== 1) throw new AcpError('protocol_error');
    if (!Array.isArray(init.authMethods) || !init.authMethods.some(method => method?.id === this.authMethod &&
        (method.type == null || method.type === 'agent'))) throw new AcpError('auth_required');
    await this.rpc.request('authenticate', { methodId: this.authMethod }, 'auth_required');
    // Explicit ACP account metadata of THIS handshake, when the CLI reports
    // it; verified against the bounded email shape before it is kept.
    this.initAccountEmail = accountEmailShapeOk(init.accountInfo?.email) ? init.accountInfo.email : null;
    // One bounded spawn log per worker start: binary path and CLI version only,
    // never key material or prompt content.
    this.log?.info?.(`gemini-agy-acp worker started (agy ${this.version}, binary: ${this.binary})`);
  }

  async turn({ model, thinking, prompt, onText }, apiKey) {
    if (!this.rpc) await this.start(apiKey);
    this.check();
    const cwd = await mkdtemp(join(this.authMethod === OAUTH_METHOD ? tmpdir() : this.root, 'session-'));
    try {
      const session = await this.rpc.request('session/new', { cwd, mcpServers: [] });
      const { sessionId } = session;
      if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 4096 || this.sessions.has(sessionId)) {
        throw new AcpError('protocol_error');
      }
      this.sessions.add(sessionId);
      await configureSession(this.rpc, session, model, thinking);
      this.rpc.sessionId = sessionId;
      this.rpc.onText = onText;
      const { stopReason } = await this.rpc.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] });
      if (!STOP_REASONS.has(stopReason)) throw new AcpError('protocol_error');
      return { stopReason };
    } finally {
      this.rpc.sessionId = null;
      this.rpc.onText = null;
      await rm(cwd, { recursive: true, force: true });
    }
  }

  async run(request, apiKey, timeoutMs) {
    clearTimeout(this.idleTimer);
    this.rpc?.resetBudget();
    // A caller's deadline is independent of the OS closing the child's pipes.
    let stopRequest;
    const interrupted = new Promise((_, reject) => { stopRequest = reject; });
    const interrupt = code => {
      const error = new AcpError(code);
      stopRequest(error);
      this.retire(error);
    };
    const abort = () => interrupt('cancelled');
    request.signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => interrupt('timeout'), timeoutMs);
    this.task = this.turn(request, apiKey);
    try {
      const result = await Promise.race([this.task, interrupted]);
      this.check();
      if (this.sessions.size >= MAX_SESSIONS) this.retire(new AcpError('closed'));
      else this.idleTimer = setTimeout(() => this.retire(new AcpError('closed')), IDLE_MS).unref();
      return result;
    } catch (error) {
      const reaped = this.retire(error instanceof AcpError ? error : new AcpError('worker_failed'));
      // Keep failed workers in the pool until retirement finishes. The caller
      // can still time out while waiting for cleanup of an earlier error.
      if (error?.code !== 'acp_timeout' && error?.code !== 'acp_cancelled') {
        await Promise.race([reaped, interrupted]);
      }
      throw this.failure;
    } finally {
      this.task = null;
      clearTimeout(timeout);
      request.signal?.removeEventListener('abort', abort);
    }
  }

  retire(error) {
    if (this.cleanup) return this.cleanup;
    this.failure = error;
    clearTimeout(this.idleTimer);
    this.rpc?.stop(error);
    const child = this.child;
    child?.stdin.destroy();
    child?.stdout.destroy();
    if (child?.pid) {
      // POSIX workers own a fresh process group, including any CLI helpers.
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch (killError) { if (killError.code !== 'ESRCH') child.kill('SIGKILL'); }
    }
    this.cleanup = (async () => {
      try {
        await this.task?.catch(() => {});
        await this.rootReady?.catch(() => {});
        await this.childClosed;
        if (this.root) await rm(this.root, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        throw new AcpError('worker_failed');
      } finally {
        this.onRetired(this);
      }
    })();
    // Retirement can be initiated from an idle child's exit event without a waiting run().
    this.cleanup.catch(() => {});
    return this.cleanup;
  }
}

export function createTransport({ binary, authMethod = AUTH_METHOD, timeoutMs = 60_000, maxWorkers = 2, apiKey, log } = {}) {
  const oauth = authMethod === OAUTH_METHOD;
  if (typeof binary !== 'string' || !isAbsolute(binary) || binary.includes('\0') || !AUTH_METHODS.has(authMethod) ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000 ||
      !Number.isInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 8 ||
      (apiKey != null && (oauth || typeof apiKey !== 'string' || !apiKey.trim()))) throw new AcpError('invalid_config');
  // The plugin resolves the sidecar apiKey against the process environment at
  // pool start; a standalone caller may omit it entirely and fall back to the
  // environment here. One capture boundary gives every worker in this pool a
  // single billing identity, immune to later environment edits. oauth-personal
  // pools carry no credential at all: the CLI uses its own OS-keyring login.
  const credential = oauth ? undefined
    : typeof apiKey === 'string' && apiKey.trim() ? apiKey : process.env.GEMINI_API_KEY;
  const workers = new Set();
  let closed = false;
  return {
    async run(request) {
      if (closed) throw new AcpError('closed');
      const { model, thinking, prompt, signal, onText } = request ?? {};
      if (signal != null && !(signal instanceof AbortSignal)) throw new AcpError('invalid_request');
      if (signal?.aborted) throw new AcpError('cancelled');
      if (typeof prompt !== 'string' || typeof model !== 'string' || !model || model.length > 1024 ||
          (thinking != null && (typeof thinking !== 'string' || !thinking || thinking.length > 128)) ||
          typeof onText !== 'function') throw new AcpError('invalid_request');
      if (Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) throw new AcpError('input_limit');
      if (!oauth && !credential?.trim()) throw new AcpError('auth_required');
      let worker = [...workers].find(candidate => !candidate.task && !candidate.failure);
      if (!worker) {
        if (workers.size >= maxWorkers) throw new AcpError('busy');
        worker = new Worker(binary, authMethod, retired => workers.delete(retired), log);
        workers.add(worker);
      }
      return worker.run({ model, thinking, prompt, signal, onText }, credential, timeoutMs);
    },
    /** Pool reset without closing: every live or idle worker is retired so the
     * next run() respawns with fresh settings. Connect and disconnect use this
     * to drop stale billing identities immediately. */
    async retireExisting() {
      await Promise.all([...workers].map(worker => worker.retire(new AcpError('closed'))));
    },
    async close() {
      closed = true;
      await Promise.all([...workers].map(worker => worker.retire(new AcpError('closed'))));
    },
  };
}

/** Validate one binary in isolation: a bounded `--version` probe with the
 * supported-version gate. Returns the advertised CLI version string. This is
 * the connect route's only look at the binary — no ACP child is spawned. The
 * probe runs in the same auth mode as the pool that follows (oauth probes
 * use the whitelisted real environment; gemini probes the isolated one). */
export async function probeVersion(binary, authMethod = AUTH_METHOD) {
  if (typeof binary !== 'string' || !isAbsolute(binary) || binary.includes('\0') || !AUTH_METHODS.has(authMethod)) {
    throw new AcpError('invalid_config');
  }
  const worker = new Worker(binary, authMethod, () => {});
  const deadline = setTimeout(() => worker.retire(new AcpError('timeout')), PROBE_MS);
  try {
    return await worker.probe();
  } finally {
    clearTimeout(deadline);
    await worker.retire(worker.failure ?? new AcpError('closed')).catch(() => {});
  }
}

/** One bounded temporary oauth-personal worker that proves the selected
 * binary's real login: version probe, ACP handshake authenticating the CLI's
 * own OS-keyring Google account, then one session/new. A `--version` probe
 * cannot prove the keyring login works. Returns { version, accountEmail }
 * where the email — when the CLI provides one at all — comes exclusively from
 * THIS handshake's explicit ACP account metadata or this child's own bounded
 * diagnostics tail; never from stale logs, other processes or token stores,
 * and only the validated email ever leaves this function. */
export async function verifyOauthHandshake({ binary, log } = {}) {
  if (typeof binary !== 'string' || !isAbsolute(binary) || binary.includes('\0')) throw new AcpError('invalid_config');
  const worker = new Worker(binary, OAUTH_METHOD, () => {}, log, { captureStderr: true });
  const deadline = setTimeout(() => worker.retire(new AcpError('timeout')), OAUTH_VERIFY_MS);
  try {
    await worker.start();
    worker.check();
    const cwd = await mkdtemp(join(tmpdir(), 'session-'));
    try {
      const session = await worker.rpc.request('session/new', { cwd, mcpServers: [] });
      if (typeof session?.sessionId !== 'string' || !session.sessionId || session.sessionId.length > 4096) {
        throw new AcpError('protocol_error');
      }
      return {
        version: worker.version ?? null,
        // Explicit ACP metadata wins over the child's own login diagnostics.
        accountEmail: worker.initAccountEmail ?? extractAccountEmail(worker.stderrText()),
      };
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  } finally {
    clearTimeout(deadline);
    await worker.retire(worker.failure ?? new AcpError('closed')).catch(() => {});
  }
}

/** One bounded temporary worker for catalog discovery: version probe, ACP
 * handshake with the resolved key, session/new, then the advertised model
 * selector options from the session config. Never touches the request pool.
 * oauth-personal syncs authenticate the CLI's own login without any key. */
export async function syncModelOptions({ binary, authMethod = AUTH_METHOD, apiKey, log } = {}) {
  const oauth = authMethod === OAUTH_METHOD;
  if (typeof binary !== 'string' || !isAbsolute(binary) || binary.includes('\0') || !AUTH_METHODS.has(authMethod) ||
      (oauth ? apiKey != null : typeof apiKey !== 'string' || !apiKey.trim())) throw new AcpError('invalid_config');
  const worker = new Worker(binary, authMethod, () => {}, log);
  const deadline = setTimeout(() => worker.retire(new AcpError('timeout')), MODEL_SYNC_MS);
  try {
    await worker.start(oauth ? undefined : apiKey);
    worker.check();
    const cwd = await mkdtemp(join(oauth ? tmpdir() : worker.root, 'session-'));
    try {
      const session = await worker.rpc.request('session/new', { cwd, mcpServers: [] });
      const models = modelOptions(modelSelector(session.configOptions));
      return { models, version: worker.version ?? null };
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  } finally {
    clearTimeout(deadline);
    await worker.retire(worker.failure ?? new AcpError('closed')).catch(() => {});
  }
}
