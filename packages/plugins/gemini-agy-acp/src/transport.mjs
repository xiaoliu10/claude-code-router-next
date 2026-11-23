import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { configureSession } from './acp-config.mjs';
import { AcpError } from './acp-errors.mjs';
import { AcpStdio } from './acp-stdio.mjs';

const AUTH_METHOD = 'gemini-api-key';
const MAX_PROMPT_BYTES = 1024 * 1024;
const IDLE_MS = 30_000;
const MAX_SESSIONS = 64;
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

function supportedVersion(output) {
  const versions = [...output.matchAll(/(?:^|[\s:(])v?(\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?)(?=$|[\s,)])/gi)];
  if (versions.length !== 1) return false;
  const [release, prerelease] = versions[0][1].split('+')[0].split('-');
  const [major, minor, patch] = release.split('.').map(Number);
  return major > 1 || (major === 1 && (minor > 5 || (minor === 5 && (patch > 1 || (patch === 1 && !prerelease)))));
}

async function isolatedEnvironment(root) {
  const dirs = Object.fromEntries(['home', 'config', 'data', 'cache', 'state', 'tmp', 'runtime', 'work']
    .map(name => [name, join(root, name)]));
  await Promise.all(Object.values(dirs).map(path => mkdir(path, { mode: 0o700 })));
  const env = {
    HOME: dirs.home, USERPROFILE: dirs.home, XDG_CONFIG_HOME: dirs.config, XDG_DATA_HOME: dirs.data,
    XDG_CACHE_HOME: dirs.cache, XDG_STATE_HOME: dirs.state, XDG_RUNTIME_DIR: dirs.runtime,
    APPDATA: dirs.config, LOCALAPPDATA: dirs.data, TMPDIR: dirs.tmp, TEMP: dirs.tmp, TMP: dirs.tmp,
    PATH: '/usr/bin:/bin', LANG: 'C',
  };
  if (process.platform === 'win32') {
    env.SystemRoot = process.env.SystemRoot;
    env.PATH = join(env.SystemRoot, 'System32');
  }
  return { env, cwd: dirs.work };
}

class Worker {
  constructor(binary, onRetired) {
    this.binary = binary;
    this.onRetired = onRetired;
    this.sessions = new Set();
    // The warm ACP session kept alive while the caller executes a parked tool
    // call, so a follow-up request can resume the same turn.
    this.binding = null;
  }

  check() {
    if (this.failure) throw this.failure;
  }

  spawnChild(args, env) {
    this.check();
    const child = spawn(this.binary, args, {
      cwd: this.cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'ignore'], // subprocess diagnostics may contain credentials or prompts
    });
    this.child = child;
    this.childClosed = new Promise(resolve => child.once('close', resolve));
    const fail = () => this.retire(new AcpError('worker_failed'));
    child.on('error', fail);
    child.stdin.on('error', fail);
    child.stdout.on('error', fail);
    return child;
  }

  async start(apiKey) {
    this.root = await mkdtemp(join(tmpdir(), 'ccr-agy-acp-'));
    const isolation = await isolatedEnvironment(this.root);
    this.cwd = isolation.cwd;
    const probe = this.spawnChild(['--version'], isolation.env);
    let output = '';
    let bytes = 0;
    probe.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 4096) this.retire(new AcpError('output_limit'));
      else output += chunk.toString('ascii');
    });
    probe.stdin.end();
    const probeTimeout = setTimeout(() => this.retire(new AcpError('timeout')), 5000);
    let exitCode;
    try { exitCode = await this.childClosed; } finally { clearTimeout(probeTimeout); }
    this.child = null;
    this.check();
    if (exitCode !== 0 || !supportedVersion(output)) throw new AcpError('unsupported_version');

    const child = this.spawnChild(['acp', '--sandbox'], { ...isolation.env, GEMINI_API_KEY: apiKey });
    child.once('exit', () => this.retire(new AcpError('worker_failed')));
    child.stdout.once('end', () => this.retire(new AcpError('worker_failed')));
    this.rpc = new AcpStdio(child, error => this.retire(error));
    const init = await this.rpc.request('initialize', { protocolVersion: 1, clientInfo, clientCapabilities: {} });
    if (init.protocolVersion !== 1) throw new AcpError('protocol_error');
    if (!Array.isArray(init.authMethods) || !init.authMethods.some(method => method?.id === AUTH_METHOD &&
        (method.type == null || method.type === 'agent'))) throw new AcpError('auth_required');
    await this.rpc.request('authenticate', { methodId: AUTH_METHOD }, 'auth_required');
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
   * already started; its descriptor goes into `session/new` so the agent can
   * discover the tools, and the session stays warm in `this.binding` while a
   * call is parked, so a follow-up request can resume the same ACP turn.
   */
  async turn({ model, thinking, prompt, onText, onToolCall, bridge, resume }, apiKey) {
    if (!this.rpc) await this.start(apiKey);
    this.check();
    const cwd = await mkdtemp(join(this.root, 'session-'));
    const hasTools = !!bridge && !bridge.empty;
    const mcpServers = hasTools ? [bridge.descriptor()] : [];
    let sessionId;
    try {
      if (resume && this.binding?.sessionId && this.binding.bridge === bridge) {
        // The parked turn left its prompt in flight; drop it so this turn can
        // issue a fresh one on the same session.
        sessionId = this.binding.sessionId;
        this.rpc.abandon();
      } else {
        if (this.binding) await this.closeBinding();
        const session = await this.rpc.request('session/new', { cwd, mcpServers });
  
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
      if (!STOP_REASONS.has(outcome.stopReason)) throw new AcpError('protocol_error');
      return { stopReason: outcome.stopReason };
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
      // Retiring on session-count exhaustion would close the bridge of a call the
      // caller is still waiting to answer, so only reap an idle worker.
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

export function createTransport({ binary, authMethod, timeoutMs = 60_000, maxWorkers = 2 } = {}) {
  if (typeof binary !== 'string' || !isAbsolute(binary) || binary.includes('\0') || authMethod !== AUTH_METHOD ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000 ||
      !Number.isInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 8) throw new AcpError('invalid_config');
  // The host reads settings once per activation. Capture credentials at the
  // same boundary so every worker in this pool has one billing identity.
  const apiKey = process.env.GEMINI_API_KEY;
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
      if (Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) throw new AcpError('input_limit');
      // A bridge is the plugin's own object; only shape is checked here.
      if (bridge != null && (typeof bridge.descriptor !== 'function' || !(bridge.pending instanceof Map))) {
        throw new AcpError('invalid_request');
      }
      if (!apiKey?.trim()) throw new AcpError('auth_required');
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
        worker = new Worker(binary, retired => workers.delete(retired));
        workers.add(worker);
      }
      return worker.run({ model, thinking, prompt, signal, onText, onToolCall, bridge, resume }, apiKey, timeoutMs);
    },
    async close() {
      closed = true;
      await Promise.all([...workers].map(worker => worker.retire(new AcpError('closed'))));
    },
  };
}
