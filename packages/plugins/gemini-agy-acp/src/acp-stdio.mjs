import { AcpError } from './acp-errors.mjs';

const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_TURN_BYTES = 16 * 1024 * 1024;
const MAX_TURN_FRAMES = 65536;
const decoder = new TextDecoder('utf-8', { fatal: true });

// ACP v1 uses one UTF-8 JSON-RPC message per line. Only one outgoing request is in flight.
export class AcpStdio {
  constructor(child, onFailure) {
    this.stdin = child.stdin;
    this.nextId = 1;
    this.partial = Buffer.alloc(0);
    this.partialBytes = 0;
    this.onText = null;
    this.onToolCall = null;
    this.onPermission = null;
    // Set for the duration of a prompt that may park on a tool call.
    this.parked = null;
    this.resetBudget();
    child.stdout.on('data', chunk => {
      if (this.failure) return;
      try {
        this.read(chunk);
      } catch (error) {
        onFailure(error instanceof AcpError ? error : new AcpError('protocol_error'));
      }
    });
  }

  resetBudget() {
    this.turnBytes = this.partialBytes;
    this.turnFrames = 0;
  }

  read(chunk) {
    this.turnBytes += chunk.length;
    if (this.turnBytes > MAX_TURN_BYTES) throw new AcpError('output_limit');
    for (let start = 0; start < chunk.length && !this.failure;) {
      const newline = chunk.indexOf(10, start);
      const part = chunk.subarray(start, newline === -1 ? chunk.length : newline);
      const length = this.partialBytes + part.length;
      if (length > MAX_FRAME_BYTES) throw new AcpError('output_limit');
      let line = part;
      if (newline === -1 || this.partialBytes) {
        if (length > this.partial.length) {
          const capacity = Math.min(MAX_FRAME_BYTES, Math.max(length, 4096, this.partial.length * 2));
          const grown = Buffer.allocUnsafe(capacity);
          this.partial.copy(grown, 0, 0, this.partialBytes);
          this.partial = grown;
        }
        part.copy(this.partial, this.partialBytes);
        this.partialBytes = length;
        if (newline === -1) return;
        line = this.partial.subarray(0, length);
        this.partialBytes = 0;
      }
      if (++this.turnFrames > MAX_TURN_FRAMES) throw new AcpError('output_limit');
      this.receive(JSON.parse(decoder.decode(line)));
      start = newline + 1;
    }
  }

  send(message) {
    if (this.failure) throw this.failure;
    const line = JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n';
    if (this.stdin.writableLength + Buffer.byteLength(line) > MAX_TURN_BYTES) throw new AcpError('output_limit');
    this.stdin.write(line);
  }

  async request(method, params, errorCode = 'worker_failed') {
    if (this.pending) throw new AcpError('protocol_error');
    const id = this.nextId++;
    this.send({ id, method, params });
    return new Promise((resolve, reject) => { this.pending = { id, method, resolve, reject, errorCode }; });
  }

  /**
   * Drop an in-flight request without failing the worker. Used when a turn
   * parks on a tool call: the agent will answer that prompt later, once the
   * caller's result unblocks its MCP request, and a resume turn then issues a
   * fresh prompt on the same session.
   */
  abandon() {
    if (this.pending?.method !== 'session/prompt') return;
    this.pending.reject(new AcpError('cancelled'));
    this.pending = null;
  }

  receive(frame) {
    if (frame?.jsonrpc !== '2.0' || Array.isArray(frame)) throw new AcpError('protocol_error');
    if (Object.hasOwn(frame, 'method')) {
      if (typeof frame.method !== 'string' || Object.hasOwn(frame, 'error') || Object.hasOwn(frame, 'result')) {
        throw new AcpError('protocol_error');
      }
      if (Object.hasOwn(frame, 'id')) {
        if (typeof frame.id !== 'string' && !Number.isSafeInteger(frame.id)) throw new AcpError('protocol_error');
        if (frame.method === 'session/request_permission') {
          // The caller owns every permission decision. No handler means deny,
          // which is also the safe default for an unsolicited request.
          const handler = this.onPermission;
          if (!handler) {
            this.send({ id: frame.id, result: { outcome: { outcome: 'cancelled' } } });
          } else {
            Promise.resolve(handler(frame.params)).then(outcome => {
              this.send({ id: frame.id, result: { outcome } });
            }).catch(() => {
              this.send({ id: frame.id, result: { outcome: { outcome: 'cancelled' } } });
            });
          }
        } else {
          this.send({ id: frame.id, error: { code: -32601, message: 'Method not supported' } });
        }
      } else if (frame.method === 'session/update' && this.pending?.method === 'session/prompt' &&
          frame.params?.sessionId === this.sessionId) {
        const update = frame.params.update;
        if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
          if (typeof update.content.text !== 'string') throw new AcpError('protocol_error');
          this.onText(update.content.text);
        } else if (update?.sessionUpdate === 'tool_call' && this.onToolCall) {
          // A raised call parks the turn: the agent is now blocked inside its
          // own MCP request and will not answer the prompt until the caller
          // does. Let the transport stop waiting on the prompt.
          this.parked?.();
          this.onToolCall(normalizeToolCall(update));
        }
      }
      return;
    }
    if (!Object.hasOwn(frame, 'id') || Object.hasOwn(frame, 'result') === Object.hasOwn(frame, 'error')) {
      throw new AcpError('protocol_error');
    }
    if (!this.pending || frame.id !== this.pending.id) return; // stale response
    const { resolve, reject, errorCode } = this.pending;
    this.pending = null;
    if (Object.hasOwn(frame, 'error')) {
      const failure = new AcpError(errorCode);
      // Keep the agent's own error text for internal classification only (the
      // startup auth-race retry). Non-enumerable and never copied into the
      // caller-facing `message`, so diagnostics cannot leak through responses
      // or serialization.
      if (typeof frame.error?.message === 'string') {
        Object.defineProperty(failure, 'agentMessage', { value: frame.error.message });
      }
      reject(failure);
    }
    else if (!frame.result || typeof frame.result !== 'object' || Array.isArray(frame.result)) {
      reject(new AcpError('protocol_error'));
    } else resolve(frame.result);
  }

  stop(error) {
    if (this.failure) return;
    if (this.sessionId && this.pending?.method === 'session/prompt') {
      try { this.send({ method: 'session/cancel', params: { sessionId: this.sessionId } }); } catch { /* closing */ }
    }
    this.failure = error;
    this.pending?.reject(error);
    this.pending = null;
    this.onText = null;
    this.onToolCall = null;
    this.onPermission = null;
    this.parked = null;
  }
}

/**
 * ACP tool_call update → the caller's tool-call shape. Only the fields the
 * caller needs are read; anything malformed is dropped rather than guessed.
 */
function normalizeToolCall(update) {
  const id = typeof update.toolCallId === 'string' && update.toolCallId ? update.toolCallId : undefined;
  const title = typeof update.title === 'string' ? update.title : '';
  if (!id || !title) return null;
  let args = {};
  const raw = update.rawInput;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) args = raw;
  else if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed;
    } catch { /* keep empty */ }
  }
  return { id, name: title, arguments: args };
}
