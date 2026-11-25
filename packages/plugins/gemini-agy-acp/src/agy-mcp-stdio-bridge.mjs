/**
 * Stdio MCP forwarder spawned by the ACP agent as a stdio MCP server.
 *
 * The agent's HTTP MCP path does not surface bridged tools to the model, so
 * `session/new` advertises this script instead: the agent spawns it with the
 * internal bridge's endpoint and bearer token in its environment, and every
 * newline-delimited JSON-RPC message on stdin is POSTed verbatim to that
 * loopback endpoint with node:http (never fetch, so no proxy is involved).
 * Request responses are written back as single stdout lines; notifications
 * produce no output. stdout carries JSON-RPC only — never logs.
 *
 * A tools/call can park for minutes while the caller executes the tool, so
 * requests are forwarded concurrently with no timeout, and a backend failure
 * answers the waiting request with a JSON-RPC error instead of exiting.
 */
import { request as httpRequest } from 'node:http';
import { createInterface } from 'node:readline';

const endpoint = process.env.CCR_MCP_ENDPOINT;
const token = process.env.CCR_MCP_TOKEN;
if (!endpoint || !token) process.exit(1);
try { new URL(endpoint); } catch { process.exit(1); }

// One whole line per response, in a single write, so concurrent responses
// cannot interleave inside a line.
const reply = message => { process.stdout.write(JSON.stringify(message) + '\n'); };

// The agent going away closes stdout; leave quietly instead of crashing.
process.stdout.on('error', () => process.exit(0));

const input = createInterface({ input: process.stdin });
input.on('line', line => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch {
    reply({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    return;
  }
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    reply({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } });
    return;
  }
  const hasId = message.id !== undefined && message.id !== null;
  let settled = false;
  const unavailable = () => {
    if (settled) return;
    settled = true;
    // Diagnostics must never carry the token or endpoint; the error message
    // is a fixed string and nothing is logged.
    if (hasId) reply({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'bridge unavailable' } });
  };
  const forwarded = httpRequest(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  });
  forwarded.on('error', unavailable);
  forwarded.on('response', response => {
    if (!hasId) { response.resume(); return; }
    const chunks = [];
    response.on('data', chunk => chunks.push(chunk));
    response.on('error', unavailable);
    response.on('end', () => {
      if (settled) return;
      settled = true;
      const body = Buffer.concat(chunks).toString('utf8');
      let parsed;
      try { parsed = JSON.parse(body); } catch { parsed = null; }
      if (response.statusCode !== 200 || !parsed || typeof parsed !== 'object') {
        reply({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'bridge unavailable' } });
        return;
      }
      reply(parsed);
    });
  });
  forwarded.end(line);
});
input.on('close', () => process.exit(0));