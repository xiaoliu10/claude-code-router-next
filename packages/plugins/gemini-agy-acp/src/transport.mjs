import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { configureSession, modelOptions, modelSelector } from './acp-config.mjs';
import { AcpError } from './acp-errors.mjs';
import { AcpStdio } from './acp-stdio.mjs';
import { accountEmailShapeOk, extractAccountEmail } from './account.mjs';
import { promptUsage } from './acp-usage.mjs';

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
// Startup auth race: right after spawn the CLI can reject authenticate or
// session/new with a transient "not logged in" style error while its login
// state is still loading (observed on the plugin-MCP path). Real credential
// failures and rate/quota errors are never retried.
const AUTH_RACE_MESSAGE = /authentication required|auth_required|not logged in|not signed in/i;
const AUTH_NO_RETRY_MESSAGE = /invalid_grant|api.?key|429|resource_exhausted|quota/i;

function clientVersion() {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch (error) {
    if (error.code === 'ENOENT') return '0.0.0'; // standalone transport
    throw new AcpError('invalid_config');
  }
}
const clientInfo = { name: 'ccr-gemini-agy-acp', version: clientVersion() };

/**
 * Scoped permission answer for agy's session/request_permission. Only a call
 * that names our own caller-tool bridge server is approved — the caller
 * declared those tools and executes them itself. Anything else (native agent
 * tools) stays cancelled, so the agent can never run host commands through
 * an approved permission.
 */
export function bridgePermissionOutcome(params) {
  let text;
  try { text = JSON.stringify(params ?? {}); } catch { return { outcome: 'cancelled' }; }
  if (!text.includes('ccr-caller-tools')) return { outcome: 'cancelled' };
  const options = Array.isArray(params?.options) ? params.options : [];
  const allow = options.find(option => option?.kind === 'allow_once') ??
    options.find(option => typeof option?.kind === 'string' && option.kind.startsWith('allow'));
  return allow && allow.optionId != null ? { outcome: 'selected', optionId: allow.optionId } : { outcome: 'cancelled' };
}

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

// Mirror the core proxy policy for the agy CLI's own upstream calls. The
// process environment always wins (it is what an operator set explicitly);
// otherwise the gateway's configured proxy — applied when the global proxy
// is enabled (the core default) or the managed provider opts in — fills the
// standard variables the CLI honors. A desktop-managed gateway typically
// inherits no proxy variables at all, which left the CLI dialing Google
// directly and every turn timing out behind a regional network.
export function proxyEnvOverlay(env, proxyUrl) {
  if (!proxyUrl) return undefined;
  // An explicit ALL_PROXY is the operator's chosen route for every protocol;
  // injecting protocol-specific variables would shadow it.
  if (env.ALL_PROXY || env.all_proxy) return undefined;
  const overlay = {};
  // Case variants are one setting: an explicit value in either case wins
  // for the whole pair, so the fallback never mixes two proxies.
  for (const [upper, lower] of [['HTTPS_PROXY', 'https_proxy'], ['HTTP_PROXY', 'http_proxy']]) {
    if (!env[upper] && !env[lower]) {
      overlay[upper] = proxyUrl;
      overlay[lower] = proxyUrl;
    }
  }
  if (Object.keys(overlay).length) {
    // The caller-tool MCP bridge is plain HTTP on loopback; without a
    // NO_PROXY exclusion the injected http_proxy could route the agent's
    // local tools/list and tools/call through the upstream proxy.
    const loopback = ['127.0.0.1', 'localhost', '::1'];
    const entries = (env.NO_PROXY || env.no_proxy || '').split(',').map(item => item.trim()).filter(Boolean);
    const missing = loopback.filter(host => !entries.includes(host));
    // Mirror both case variants so a lowercase-only client also exempts loopback.
    const merged = [...entries, ...missing].join(',');
    overlay.NO_PROXY = merged;
    overlay.no_proxy = merged;
  }
  return Object.keys(overlay).length ? overlay : undefined;
}

function withConfiguredProxy(env, proxyUrl) {
  return Object.assign(env, proxyEnvOverlay(env, proxyUrl) ?? {});
}

export function oauthEnvironment(proxyUrl) {
  const env = {};
  for (const name of OAUTH_ENV_VARS) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return withConfiguredProxy(env, proxyUrl);
}

export async function isolatedEnvironment(root, proxyUrl) {
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
  return { env: withConfiguredProxy(env, proxyUrl), cwd: dirs.work };
}

class Worker {
  constructor(binary, authMethod, onRetired, log, { captureStderr = false, proxyUrl } = {}) {
    this.binary = binary;
    this.proxyUrl = proxyUrl;
    this.authMethod = authMethod;
    this.onRetired = onRetired;
    this.log = log;
    this.captureStderr = captureStderr;
    this.stderrChunks = [];
    this.stderrBytes = 0;
    this.sessions = new Set();
    // The warm ACP session kept alive while the caller executes a parked tool
    // call, so a follow-up request can resume the same turn.
    this.binding = null;
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
        this.spawnEnv = oauthEnvironment(this.proxyUrl);
      } else {
        const isolation = await isolatedEnvironment(this.root, this.proxyUrl);
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

    // --process-per-session is required for client HTTP MCP; --sandbox
    // restricts the agent toolset and excludes session MCP tools entirely.
    const child = this.spawnChild(['acp', '--process-per-session'],
      this.authMethod === OAUTH_METHOD ? this.spawnEnv : { ...this.spawnEnv, GEMINI_API_KEY: apiKey },
      this.captureStderr);
    child.once('exit', () => this.retire(new AcpError('worker_failed')));
    child.stdout.once('end', () => this.retire(new AcpError('worker_failed')));
    this.rpc = new AcpStdio(child, error => this.retire(error));
    // agy may ask permission before an MCP tool call. The caller already
    // sanctioned its own bridged tools by declaring them, and the caller —
    // never the agent — executes them, so approve only those; every native
    // agent tool stays denied.
    this.rpc.onPermission = bridgePermissionOutcome;
    const init = await this.rpc.request('initialize', { protocolVersion: 1, clientInfo, clientCapabilities: {} });
    if (init.protocolVersion !== 1) throw new AcpError('protocol_error');
    if (!Array.isArray(init.authMethods) || !init.authMethods.some(method => method?.id === this.authMethod &&
        (method.type == null || method.type === 'agent'))) throw new AcpError('auth_required');
    // The official `_meta.antigravity` session extensions are only valid when
    // the agent advertises the capability object at initialize; gate on it.
    const antigravity = init.agentCapabilities?._meta?.antigravity;
    this.antigravityMeta = antigravity && typeof antigravity === 'object' && !Array.isArray(antigravity) ? antigravity : null;
    await this.retryStartupAuthRace(() => this.rpc.request('authenticate', { methodId: this.authMethod }, 'auth_required'));
    // Explicit ACP account metadata of THIS handshake, when the CLI reports
    // it; verified against the bounded email shape before it is kept.
    this.initAccountEmail = accountEmailShapeOk(init.accountInfo?.email) ? init.accountInfo.email : null;
    // One bounded spawn log per worker start: binary path and CLI version only,
    // never key material or prompt content.
    this.log?.info?.(`gemini-agy-acp worker started (agy ${this.version}, binary: ${this.binary})`);
  }

  /**
   * One bounded retry for the startup auth race only: a transient "not logged
   * in" style rejection inside the first 2s of the attempt is retried once
   * after 250ms. Credential failures (invalid_grant, api key) and rate/quota
   * errors (429, RESOURCE_EXHAUSTED) are rethrown immediately, and a retired
   * worker never retries.
   */
  async retryStartupAuthRace(call) {
    // Monotonic clock: a wall-clock NTP step or suspend/resume must not widen the retry window.
    const started = performance.now();
    try {
      return await call();
    } catch (error) {
      const text = typeof error.agentMessage === 'string' ? error.agentMessage : error.message;
      if (this.failure || performance.now() - started >= 2000 ||
          !AUTH_RACE_MESSAGE.test(text) || AUTH_NO_RETRY_MESSAGE.test(text)) throw error;
      await delay(250, undefined, { ref: false });
      if (this.failure) throw error;
      return call();
    }
  }

  /**
   * The live tool bridge of the warm binding, if a call is still parked. A
   * resume turn reuses it so the agent keeps seeing the same tools and the
   * parked call resolves inside its original MCP request.
   */
  toolBridge() {
    return this.binding?.bridge;
  }

  /**
   * One ACP turn.
   *
   * When the caller declared tools, `bridge` is the live MCP bridge the plugin
   * already started; its stdio descriptor goes into `session/new` so the agent
   * spawns the forwarder and discovers the tools through it (the agent's HTTP
   * MCP path does not surface bridged tools to the model), and the session
   * stays warm in `this.binding` while a call is parked, so a follow-up
   * request can resume the same ACP turn.
   */
  async turn({ model, thinking, prompt, onText, onToolCall, bridge, resume }, apiKey) {
    if (!this.rpc) await this.start(apiKey);
    this.check();
    const cwd = await mkdtemp(join(this.authMethod === OAUTH_METHOD ? tmpdir() : this.root, 'session-'));
    const hasTools = !!bridge && !bridge.empty;
    const descriptor = hasTools ? bridge.stdioDescriptor() : undefined;
    const mcpServers = descriptor ? [descriptor] : [];
    let sessionId;
    try {
      if (resume && this.binding?.sessionId && this.binding.bridge === bridge) {
        // The parked turn left its prompt in flight; drop it so this turn can
        // issue a fresh one on the same session.
        sessionId = this.binding.sessionId;
        this.rpc.abandon();
      } else {
        if (this.binding) await this.closeBinding();
        const params = { cwd, mcpServers };
        // Eager connect avoids the preload race where the first prompt runs
        // before the CLI has connected to the session's MCP server. Sent only
        // when initialize advertised the antigravity capability object.
        if (descriptor && this.antigravityMeta) {
          params._meta = { antigravity: { eagerMcpServers: [descriptor.name] } };
        }
        const session = await this.retryStartupAuthRace(() => this.rpc.request('session/new', params));
        sessionId = session.sessionId;
        if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 4096 || this.sessions.has(sessionId)) {
          throw new AcpError('protocol_error');
        }
        this.sessions.add(sessionId);
        await configureSession(this.rpc, session, model, thinking);
        this.binding = { sessionId, bridge };
      }
      this.rpc.sessionId = sessionId;
      this.rpc.onText = onText;
      // A raised tool call parks the turn: the agent is blocked inside its own
      // MCP request and will not answer the prompt until the caller does. Stop
      // waiting on the prompt and report the parked call instead. A resume turn
      // has already been answered, so the agent will finish on its own and no
      // parking race is needed.
      let parkedNow;
      const parked = new Promise(resolve => { parkedNow = resolve; });
      this.rpc.parked = resume ? null : parkedNow;
      // The bridge mints the caller-visible call when the agent starts it, so
      // that is the authoritative id; the agent's own ACP notification id is
      // ignored. A text-only turn has no bridge and keeps its exact shape.
      //
      // Parked ids are captured the moment each call is raised: reading the
      // bridge's map later is wrong, because the agent may finish a call
      // immediately and the entry is gone by then.
      const raised = [];
      // A turn that parks must still unwind if the worker is retired underneath
      // it (caller abort, idle reaping, pool close), or its `finally` — which
      // closes the bridge and drops the warm binding — would never run and the
      // listening socket would leak.
      let parkFailed;
      const parkDead = new Promise((_, reject) => { parkFailed = reject; });
      const unwind = () => parkFailed?.(this.failure ?? new AcpError('worker_failed'));
      this.unwind = unwind;
      if (bridge) bridge.onParked = invocation => {
        raised.push(invocation.id);
        if (typeof onToolCall === 'function') {
          onToolCall({ id: invocation.id, name: invocation.name, arguments: invocation.arguments });
        }
        // The agent is now blocked inside this MCP request, so the prompt will
        // not be answered until the caller returns a result.
        parkedNow?.();
      };
      const promptDone = this.rpc.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] });
      // A parked turn abandons its prompt; the agent answers it later, once the
      // caller's result unblocks its MCP request. Swallow that late answer so
      // it cannot surface as an unhandled rejection on the warm worker.
      promptDone.catch(() => {});
      const outcome = resume
        ? await promptDone
        : await Promise.race([promptDone, parked, parkDead]);
      // A turn that parked a tool call is not finished: keep the session warm
      // and report the parked ids so the caller knows to answer. The parked ids
      // — not the prompt's outcome — are what the caller acts on, so a turn that
      // parked has no stop reason to report.
      if (hasTools && raised.length) {
        return { parked: [...raised] };
      }
      if (outcome === undefined) throw new AcpError('protocol_error');
      const { stopReason } = outcome;
      if (!STOP_REASONS.has(stopReason)) throw new AcpError('protocol_error');
      const usage = promptUsage(outcome);
      return usage ? { stopReason, usage } : { stopReason };
    } finally {
      this.rpc.sessionId = null;
      this.rpc.onText = null;
      this.rpc.onToolCall = null;
      this.rpc.parked = null;
      this.unwind = null;
      if (bridge?.onParked) bridge.onParked = null;
      // A binding stays warm only while a tool call is parked. Every other
      // exit — including a session/new that threw before an id existed — must
      // drop it, or a later turn would reuse a dead session.
      if (this.binding && this.binding.bridge?.pending?.size === 0) await this.closeBinding();
      await rm(cwd, { recursive: true, force: true });
    }
  }

  /**
   * Drop the warm binding. The session id stays in `this.sessions` for the
   * worker's lifetime, so an agent that reuses an id is still rejected as a
   * protocol violation.
   */
  async closeBinding() {
    const binding = this.binding;
    this.binding = null;
    if (!binding) return;
    // The parked turn left its prompt in flight on this worker's rpc. Drop it
    // first, or the next turn's request would collide with it and the whole
    // worker would fail with a protocol error. A retired worker has already
    // settled it, so there is nothing to abandon.
    if (!this.failure) this.rpc?.abandon();
    await binding.bridge?.close().catch(() => {});
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
      // Retiring on session-count exhaustion would close the bridge of a call
      // the caller is still waiting to answer, so only reap an idle worker.
      if (!this.binding?.bridge?.pending?.size && this.sessions.size >= MAX_SESSIONS) {
        this.retire(new AcpError('closed'));
      }
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
    // Unwind a turn that is parked on a tool call, so its `finally` runs and
    // the bridge it holds is closed rather than left listening.
    this.unwind?.();
    clearTimeout(this.idleTimer);
    // A warm binding's parked calls must never outlive the worker: closing the
    // bridge settles them as errors so a waiting MCP request cannot hang the
    // caller.
    const binding = this.binding;
    this.binding = null;
    binding?.bridge?.close().catch(() => {});
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

function validProxyUrl(proxyUrl) {
  if (proxyUrl == null || proxyUrl === '') return undefined;
  if (typeof proxyUrl !== 'string' || !/^https?:\/\//i.test(proxyUrl)) throw new AcpError('invalid_config');
  return proxyUrl;
}

export function createTransport({ binary, authMethod = AUTH_METHOD, timeoutMs = 60_000, maxWorkers = 2, apiKey, log, proxyUrl } = {}) {
  const oauth = authMethod === OAUTH_METHOD;
  proxyUrl = validProxyUrl(proxyUrl);
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
    /**
     * The tool bridge whose parked calls are exactly the ones this caller is
     * answering. Matching on the ids keeps two interleaved conversations from
     * stealing each other's bridge — and therefore each other's ACP session.
     */
    toolBridge(ids) {
      const wanted = ids instanceof Set ? ids : new Set(ids ?? []);
      for (const worker of workers) {
        const bridge = worker.toolBridge?.();
        if (!bridge) continue;
        const parked = [...bridge.pending.keys()];
        // A strict bijection, not a subset: a caller that quotes more ids than
        // are parked — including ids borrowed from another conversation — must
        // not be able to resume a bridge it does not own.
        if (parked.length && parked.length === wanted.size && parked.every(id => wanted.has(id))) {
          return bridge;
        }
      }
      return undefined;
    },
    async run(request) {
      if (closed) throw new AcpError('closed');
      const { model, thinking, prompt, signal, onText, onToolCall, bridge, resume } = request ?? {};
      if (signal != null && !(signal instanceof AbortSignal)) throw new AcpError('invalid_request');
      if (signal?.aborted) throw new AcpError('cancelled');
      if (typeof prompt !== 'string' || typeof model !== 'string' || !model || model.length > 1024 ||
          (thinking != null && (typeof thinking !== 'string' || !thinking || thinking.length > 128)) ||
          typeof onText !== 'function') throw new AcpError('invalid_request');
      // A bridge is the plugin's own object; only shape is checked here. Both
      // descriptors are required: stdio for session/new, HTTP for internal use.
      if (bridge != null && (typeof bridge.descriptor !== 'function' || typeof bridge.stdioDescriptor !== 'function' ||
          !(bridge.pending instanceof Map))) {
        throw new AcpError('invalid_request');
      }
      if (Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) throw new AcpError('input_limit');
      if (!oauth && !credential?.trim()) throw new AcpError('auth_required');
      // A resume turn must land on the worker that holds its bridge: that is
      // where the parked call and the warm ACP session live.
      let worker = resume
        ? [...workers].find(candidate => candidate.binding?.bridge === bridge && !candidate.task && !candidate.failure)
        // Any other turn must avoid a worker holding a live parked call, which is
        // reserved for the resume that will answer it — taking it over would tear
        // that call down. A binding with nothing parked is not reserved.
        : [...workers].find(candidate => !candidate.task && !candidate.failure &&
            !(candidate.binding?.bridge?.pending?.size > 0));
      if (!worker) {
        if (workers.size >= maxWorkers) throw new AcpError('busy');
        worker = new Worker(binary, authMethod, retired => workers.delete(retired), log, { proxyUrl });
        workers.add(worker);
      }
      return worker.run({ model, thinking, prompt, signal, onText, onToolCall, bridge, resume }, credential, timeoutMs);
    },
    /** Pool reset without closing: every live or idle worker is retired so the
     * next run() respawns with fresh settings. Connect and disconnect use this
     * to drop stale billing identities immediately. */
    async retireExisting() {
      await Promise.all([...workers].map(worker => worker.retire(new AcpError('closed'))));
    },
    /** Drain only idle workers: busy turns keep their spawn environment and
     * finish on this pool, then idle-retire naturally. Used for proxy-only
     * pool swaps so a config edit never SIGKILLs an in-flight turn. */
    async retireIdle() {
      // A parked tool turn has no active task but reserves its worker and
      // bridge for the caller's resume; draining it would SIGKILL the turn.
      await Promise.all([...workers].filter(worker => !worker.task && !worker.failure &&
        !(worker.binding?.bridge?.pending?.size > 0)).map(worker => worker.retire(new AcpError('closed'))));
    },
    /** True while any worker holds a parked caller tool call. */
    hasParked() {
      return [...workers].some(worker => worker.binding?.bridge?.pending?.size > 0);
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
export async function probeVersion(binary, authMethod = AUTH_METHOD, proxyUrl) {
  if (typeof binary !== 'string' || !isAbsolute(binary) || binary.includes('\0') || !AUTH_METHODS.has(authMethod)) {
    throw new AcpError('invalid_config');
  }
  const worker = new Worker(binary, authMethod, () => {}, undefined, { proxyUrl });
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
export async function verifyOauthHandshake({ binary, log, proxyUrl } = {}) {
  if (typeof binary !== 'string' || !isAbsolute(binary) || binary.includes('\0')) throw new AcpError('invalid_config');
  const worker = new Worker(binary, OAUTH_METHOD, () => {}, log, { captureStderr: true, proxyUrl });
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
export async function syncModelOptions({ binary, authMethod = AUTH_METHOD, apiKey, log, proxyUrl } = {}) {
  const oauth = authMethod === OAUTH_METHOD;
  if (typeof binary !== 'string' || !isAbsolute(binary) || binary.includes('\0') || !AUTH_METHODS.has(authMethod) ||
      (oauth ? apiKey != null : typeof apiKey !== 'string' || !apiKey.trim())) throw new AcpError('invalid_config');
  const worker = new Worker(binary, authMethod, () => {}, log, { proxyUrl });
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
