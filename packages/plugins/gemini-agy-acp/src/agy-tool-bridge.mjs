/**
 * Local MCP-over-HTTP bridge that advertises the caller's tools to an ACP agent.
 *
 * The agent calls tools/call; the bridge parks the invocation until the caller
 * (e.g. Pi) executes the tool and returns its result on the next request. The
 * bridge never executes a tool itself.
 *
 * This HTTP server is an internal backend: `session/new` advertises the stdio
 * forwarder (agy-mcp-stdio-bridge.mjs), which the agent spawns and which
 * relays its JSON-RPC here. The HTTP descriptor stays for internal callers.
 *
 * Security: listens on 127.0.0.1 only, on an ephemeral port, and requires a
 * random per-bridge bearer token compared with timingSafeEqual. Request bodies
 * and advertised schemas are bounded.
 */
import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { fitToolsToBudget } from './agy-tool-budget.mjs';

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_TOOLS = 64;
// The caller-facing cap and the bridge's own cap must agree: the caller cannot
// answer a call it was never told about, so a parked call beyond the caller's
// cap would hang forever.
export const MAX_CALLS_PER_TURN = 32;
const MAX_SCHEMA_BYTES = 64 * 1024;

/**
 * Project only representable constraints. A tool that cannot be represented is
 * omitted whole rather than silently widened — the caller must be told.
 */
function projectSchema(value, depth, budget) {
  if (depth > 8) return { reason: 'too_deep' };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { reason: 'not_object' };
  if (budget.work <= 0) return { reason: 'too_large' };
  budget.work -= 1;
  const output = {};
  for (const [key, candidate] of Object.entries(value)) {
    // Annotations carry no constraint; dropping them cannot widen the schema.
    if (['$schema', '$id', '$comment', 'title', 'description', 'examples', 'default', 'deprecated',
      'readOnly', 'writeOnly'].includes(key)) continue;
    if (key === 'properties') {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return { reason: 'invalid_keyword_value' };
      const properties = {};
      for (const [name, schema] of Object.entries(candidate)) {
        if (['__proto__', 'constructor', 'prototype'].includes(name)) return { reason: 'unsafe_property_name' };
        const projected = projectSchema(schema, depth + 1, budget);
        if ('reason' in projected) return projected;
        properties[name] = projected.schema;
      }
      output.properties = properties;
      continue;
    }
    if (key === 'items' || (key === 'additionalProperties' && typeof candidate !== 'boolean')) {
      const projected = projectSchema(candidate, depth + 1, budget);
      if ('reason' in projected) return projected;
      output[key] = projected.schema;
      continue;
    }
    if (['anyOf', 'oneOf', 'allOf'].includes(key)) {
      if (!Array.isArray(candidate) || !candidate.length) return { reason: 'invalid_keyword_value' };
      const variants = [];
      for (const item of candidate) {
        const projected = projectSchema(item, depth + 1, budget);
        if ('reason' in projected) return projected;
        variants.push(projected.schema);
      }
      output[key] = variants;
      continue;
    }
    if (['enum', 'required'].includes(key) || (key === 'type' && Array.isArray(candidate))) {
      if (!Array.isArray(candidate) || !candidate.length) return { reason: 'invalid_keyword_value' };
      if (key === 'required' && !candidate.every(item => typeof item === 'string')) return { reason: 'invalid_keyword_value' };
      output[key] = candidate.slice(0, 128);
      continue;
    }
    if (['type', 'format', 'pattern', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
      'minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties',
      'const', 'multipleOf'].includes(key)) {
      // `type` must name a JSON type; anything else cannot be projected and
      // would silently widen the advertised schema, so the tool is omitted.
      if (key === 'type' && !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(candidate)) {
        return { reason: 'unsupported_keyword' };
      }
      output[key] = candidate;
      continue;
    }
    if (['uniqueItems', 'additionalProperties'].includes(key) && typeof candidate === 'boolean') {
      output[key] = candidate;
      continue;
    }
    return { reason: 'unsupported_keyword' };
  }
  // Never infer a type: beside const/enum/combinators that could contradict a
  // valid typeless schema. An empty object schema legitimately allows anything.
  if (output.type === undefined && output.properties === undefined &&
      output.anyOf === undefined && output.oneOf === undefined && output.allOf === undefined) {
    output.type = 'object';
  }
  if (Buffer.byteLength(JSON.stringify(output), 'utf8') > MAX_SCHEMA_BYTES) return { reason: 'too_large' };
  return { schema: output };
}

/** One OpenAI tool → its MCP projection, or the reason it must be omitted. */
export function projectTool(tool) {
  if (!tool || typeof tool !== 'object') return { reason: 'not_object' };
  const fn = tool.type === 'function' ? tool.function : tool;
  if (!fn || typeof fn !== 'object' || typeof fn.name !== 'string' || !fn.name.trim()) return { reason: 'missing_name' };
  const name = fn.name.trim();
  if (name.length > 128) return { reason: 'name_too_long' };
  const mcpName = `ccr_${name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  if (!mcpName) return { reason: 'invalid_name' };
  const projected = projectSchema(fn.parameters ?? { type: 'object', properties: {} }, 0, { work: 5000 });
  if ('reason' in projected) return { reason: projected.reason };
  return {
    mcpName,
    callerName: name,
    description: typeof fn.description === 'string' ? fn.description.slice(0, 1024) : name,
    inputSchema: projected.schema,
  };
}

/** Project a caller tool list; keeps order, drops duplicates and omissions. */
export function projectTools(tools) {
  if (!Array.isArray(tools) || tools.length > MAX_TOOLS) {
    return { tools: [], omitted: [{ name: '*', reason: 'too_many_tools' }] };
  }
  const projected = [];
  const omitted = [];
  const seen = new Set();
  for (const tool of tools) {
    const result = projectTool(tool);
    if ('reason' in result) {
      omitted.push({ name: String(tool?.function?.name ?? tool?.name ?? '?'), reason: result.reason });
      continue;
    }
    if (seen.has(result.mcpName)) {
      omitted.push({ name: result.callerName, reason: 'duplicate_name' });
      continue;
    }
    seen.add(result.mcpName);
    projected.push(result);
  }
  return { tools: projected, omitted };
}

function validToken(header, expected) {
  const actual = Buffer.from(typeof header === 'string' ? header : '');
  const wanted = Buffer.from(`Bearer ${expected}`);
  return actual.byteLength === wanted.byteLength && timingSafeEqual(actual, wanted);
}

function toolError(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

/**
 * Accept either an MCP result (`{content, isError}`) or the caller's own
 * `{text, isError}` shape, and normalise to the MCP result shape.
 */
function asMcpResult(value) {
  if (!value || typeof value !== 'object') return toolError('Invalid tool result');
  if (Array.isArray(value.content)) return value;
  if (typeof value.text === 'string') {
    return { content: [{ type: 'text', text: value.text }], isError: value.isError === true };
  }
  return toolError('Invalid tool result');
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('invalid json');
  }
}

/**
 * Bridge one caller tool set into an MCP HTTP server. `onCall` must return a
 * promise that resolves with the MCP result once the caller has executed it.
 */
export class AgyToolBridge {
  constructor(tools, onCall) {
    const { tools: projected, omitted } = projectTools(tools);
    this.tools = projected;
    this.omitted = omitted;
    this.onCall = onCall;
    this.token = randomUUID().replaceAll('-', '');
    this.server = undefined;
    this.url = undefined;
    this.calls = 0;
    this.closed = false;
    // Every invocation this bridge has started, in arrival order. The agent's
    // own ACP notification carries a different id, so the caller-visible id is
    // taken from here instead.
    this.invocations = [];
    // Notified when a call is parked, with the bridge's own invocation.
    this.onParked = null;
    // Parked calls: id → a function that answers the waiting MCP request.
    this.pending = new Map();
  }

  /** True when nothing can be advertised; the caller must be told, not ignored. */
  get empty() {
    return this.tools.length === 0;
  }

  /** MCP server descriptor for ACP `session/new`. Undefined when nothing to offer. */
  async start() {
    if (this.empty || this.closed) return undefined;
    if (this.server && this.url) return this.descriptor();
    this.server = createServer((request, response) => {
      this.handle(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'bridge error' } }));
      });
    });
    this.server.on('error', () => { this.server = undefined; this.url = undefined; });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', resolve);
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('bridge_bind_failed');
    this.url = `http://127.0.0.1:${address.port}/mcp`;
    return this.descriptor();
  }

  descriptor() {
    if (!this.url) throw new Error('bridge_not_listening');
    return {
      type: 'http',
      name: 'ccr-caller-tools',
      url: this.url,
      headers: [{ name: 'Authorization', value: `Bearer ${this.token}` }],
    };
  }

  /**
   * ACP stdio MCP server for `session/new`: the agent spawns the forwarder
   * with the current node runtime (no shell) and reaches this bridge through
   * it. The endpoint and bearer token travel in env, never on the command
   * line. The forwarder file sits next to this module in src and dist alike.
   */
  stdioDescriptor() {
    if (!this.url) throw new Error('bridge_not_listening');
    return {
      name: 'ccr-caller-tools',
      // The desktop shell may spawn us with a verbatim \\?\ executable path;
      // Go's exec.LookPath cannot resolve that form, so agy would silently
      // drop the server. Hand the agent a plain Win32 path instead.
      command: process.execPath.replace(/^\\\\\?\\/, ''),
      args: [fileURLToPath(new URL('./agy-mcp-stdio-bridge.mjs', import.meta.url))],
      env: [
        { name: 'CCR_MCP_ENDPOINT', value: this.url },
        { name: 'CCR_MCP_TOKEN', value: this.token },
      ],
    };
  }

  async close() {
    this.closed = true;
    // Settle anything still parked so a waiting MCP request cannot hang.
    for (const answer of this.pending.values()) {
      answer({ content: [{ type: 'text', text: 'The tool bridge closed before the caller returned this result' }], isError: true });
    }
    this.pending.clear();
    const server = this.server;
    this.server = undefined;
    this.url = undefined;
    if (!server) return;
    await new Promise(resolve => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  async handle(request, response) {
    if (this.closed) { response.writeHead(503).end(); return; }
    let url;
    try { url = new URL(request.url, 'http://127.0.0.1'); } catch { response.writeHead(400).end(); return; }
    if (url.pathname !== '/mcp' || request.method !== 'POST') { response.writeHead(405).end(); return; }
    if (!validToken(request.headers.authorization, this.token)) { response.writeHead(401).end(); return; }
    let body;
    try { body = await readJson(request); } catch { response.writeHead(400).end(); return; }
    if (!body || typeof body !== 'object' || Array.isArray(body) || body.jsonrpc !== '2.0') {
      response.writeHead(400).end();
      return;
    }
    const { id, method, params } = body;
    if (id === undefined || id === null || typeof method !== 'string') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } }));
      return;
    }
    const reply = result => {
      if (response.writableEnded) return;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    };
    const fail = (code, message) => {
      if (response.writableEnded) return;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }));
    };
    if (method === 'server/discover') {
      // MCP 2026-07-28 sessionless discovery (SEP-2575). agy probes this before
      // initialize; advertise the legacy revisions we serve so it negotiates
      // down to the initialize handshake instead of dropping the server.
      reply({
        resultType: 'complete',
        supportedVersions: ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
        capabilities: { tools: {} },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'ccr-caller-tools', version: '1.0.0' } },
        ttlMs: 0,
        cacheScope: 'private',
      });
      return;
    }
    if (method === 'initialize') {
      // MCP protocolVersion is a string date revision, not a number. Echo the
      // client's requested revision when it is one we serve; otherwise fall
      // back to the newest supported so the handshake never mismatches.
      const supported = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
      const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion : null;
      reply({
        protocolVersion: requested && supported.includes(requested) ? requested : '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'ccr-caller-tools', version: '1.0.0' },
      });
      return;
    }
    if (method === 'tools/list') {
      // alwaysLoad keeps each entry loaded even when agy's shared
      // customization budget would otherwise drop it; the fitter then trims
      // only description prose so every tool stays listed, schema intact.
      const listed = fitToolsToBudget(this.tools.map(tool => ({
        name: tool.mcpName, description: tool.description, inputSchema: tool.inputSchema,
        _meta: { ...(tool.meta || {}), 'antigravity/alwaysLoad': true },
      })));
      reply({ tools: listed });
      return;
    }
    if (method === 'tools/call') {
      if (this.calls >= MAX_CALLS_PER_TURN) { reply(toolError('Too many tool calls in one turn')); return; }
      const tool = this.tools.find(candidate => candidate.mcpName === params?.name);
      if (!tool) { reply(toolError('Unknown tool')); return; }
      this.calls += 1;
      // The bridge mints the caller-visible id, so the id the caller quotes
      // back on its follow-up always matches a parked entry even though the
      // agent reports its own ACP id separately.
      const invocation = {
        id: `call_${randomUUID().replaceAll('-', '').slice(0, 24)}`,
        name: tool.callerName,
        mcpName: tool.mcpName,
        arguments: params?.arguments ?? {},
      };
      this.invocations.push(invocation);
      // Register the parked entry BEFORE anyone is told about the call. A turn
      // that saw "a call was raised" while the entry did not exist yet would
      // close the bridge under a live call and leak the listening socket.
      // `answer` is how the caller delivers its result; the returned promise is
      // what keeps this MCP request — and the ACP turn — open until then.
      let answer;
      const delivered = new Promise(resolve => { answer = resolve; });
      this.pending.set(invocation.id, answer);
      this.onParked?.(invocation);
      let result;
      try {
        result = await Promise.race([delivered, this.onCall(invocation)]);
      } catch {
        result = toolError('The tool call could not be completed');
      }
      this.pending.delete(invocation.id);
      reply(asMcpResult(result));
      return;
    }
    if (method.startsWith('notifications/')) { response.writeHead(202).end(); return; }
    fail(-32601, 'Method not found');
  }
}
