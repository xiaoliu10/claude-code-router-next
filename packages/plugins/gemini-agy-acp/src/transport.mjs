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

  async turn({ model, thinking, prompt, onText }, apiKey) {
    if (!this.rpc) await this.start(apiKey);
    this.check();
    const cwd = await mkdtemp(join(this.root, 'session-'));
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
    async run(request) {
      if (closed) throw new AcpError('closed');
      const { model, thinking, prompt, signal, onText } = request ?? {};
      if (signal != null && !(signal instanceof AbortSignal)) throw new AcpError('invalid_request');
      if (signal?.aborted) throw new AcpError('cancelled');
      if (typeof prompt !== 'string' || typeof model !== 'string' || !model || model.length > 1024 ||
          (thinking != null && (typeof thinking !== 'string' || !thinking || thinking.length > 128)) ||
          typeof onText !== 'function') throw new AcpError('invalid_request');
      if (Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) throw new AcpError('input_limit');
      if (!apiKey?.trim()) throw new AcpError('auth_required');
      let worker = [...workers].find(candidate => !candidate.task && !candidate.failure);
      if (!worker) {
        if (workers.size >= maxWorkers) throw new AcpError('busy');
        worker = new Worker(binary, retired => workers.delete(retired));
        workers.add(worker);
      }
      return worker.run({ model, thinking, prompt, signal, onText }, apiKey, timeoutMs);
    },
    async close() {
      closed = true;
      await Promise.all([...workers].map(worker => worker.retire(new AcpError('closed'))));
    },
  };
}
