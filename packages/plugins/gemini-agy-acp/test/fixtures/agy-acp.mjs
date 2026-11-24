import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const mode = readFileSync(join(fixtureDir, 'mode'), 'utf8');
// The authMethod file selects the transport mode under test: gemini-api-key
// workers run in the isolated environment, oauth-personal workers run with
// the whitelisted real environment and authenticate the fixture's own login.
let authMethod = 'gemini-api-key';
try { authMethod = readFileSync(join(fixtureDir, 'authMethod'), 'utf8').trim(); } catch { /* default */ }
const isolated = authMethod === 'gemini-api-key';
// The mcp-tool modes adopt the caller's MCP bridge; the -meta variants also
// advertise the official antigravity capability extension at initialize.
const mcpMode = mode === 'mcp-tool' || mode === 'mcp-tool-meta';
const antigravityMeta = mode === 'antigravity-meta' || mode === 'mcp-tool-meta';
const record = (event, data = {}) => appendFileSync(join(fixtureDir, 'events'), JSON.stringify({ event, pid: process.pid, ...data }) + '\n');
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const argv = process.argv.slice(2);
const root = dirname(process.env.HOME);
if (isolated) {
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
    'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'TMPDIR', 'TEMP', 'TMP']) {
    assert.equal(dirname(process.env[key]), root);
    assert.equal(statSync(process.env[key]).mode & 0o077, 0);
  }
  assert.equal(dirname(process.cwd()), realpathSync(root));
  assert.equal(process.env.AGY_TEST_PARENT_ONLY, undefined);
  assert.equal(process.env.GOOGLE_APPLICATION_CREDENTIALS, undefined);
} else {
  // oauth-personal: whitelisted real-user environment (real HOME for the
  // keyring login, asserted by the test against the parent's own HOME), no
  // blanket parent passthrough, no credential variables, and a fresh cwd
  // directly under the OS temp dir.
  assert.equal(process.env.GEMINI_API_KEY, undefined);
  assert.equal(process.env.AGY_TEST_PARENT_ONLY, undefined);
  assert.equal(process.env.GOOGLE_APPLICATION_CREDENTIALS, undefined);
  assert.notEqual(process.env.PATH, undefined);
  assert.notEqual(process.env.HOME, undefined);
  assert.equal(realpathSync(dirname(process.cwd())), realpathSync(tmpdir()));
}

if (argv[0] === '--version') {
  assert.deepEqual(argv, ['--version']);
  assert.equal(process.env.GEMINI_API_KEY, undefined);
  record('version', isolated ? { root } : { cwd: process.cwd() });
  if (mode === 'version-email') process.stderr.write('applyAuthResult: email=probe@example.com, status=OK\n');
  if (mode === 'hang-version') setInterval(() => {}, 60_000);
  else if (mode === 'long-version') process.stdout.write('0'.repeat(4097));
  else console.log(`agy version ${mode === 'old' ? '1.5.0' : mode === 'prerelease' ? '1.5.1-rc1' : '1.5.1'}`);
} else {
  assert.deepEqual(argv, ['acp', '--process-per-session']);
  assert.equal(process.env.GEMINI_API_KEY, isolated ? 'fixture-value' : undefined);
  record('spawn', { args: argv, ...(isolated ? { root } : { cwd: process.cwd(), home: process.env.HOME }),
    httpsProxy: process.env.HTTPS_PROXY ?? null, noProxy: process.env.NO_PROXY ?? null });
  let authenticated = false;
  let authAttempts = 0;
  let sessionAttempts = 0;
  let sessionNumber = 0;
  let sessionId;
  let model;
  let thinking;
  let promptId;
  let denied = new Set();
  const mcpBySession = new Map();
  const toolSettledBySession = new Map();
  // The raised call of a session while its result is still travelling back
  // over the stdio bridge: sessionId → promise that settles once the result
  // is recorded.
  const callInFlightBySession = new Map();
  const mcpChildren = new Set();
  const killMcpChildren = () => { for (const child of mcpChildren) child.kill('SIGKILL'); };
  // Adopt the session's stdio MCP server exactly as the real agent does:
  // spawn the given command with the given env merged over a minimal env and
  // speak newline JSON-RPC over its stdin/stdout.
  const adoptMcp = async server => {
    assert.equal(server.name, 'ccr-caller-tools');
    assert.equal(typeof server.command, 'string');
    assert.ok(server.command.length > 0);
    assert.ok(Array.isArray(server.args));
    assert.ok(Array.isArray(server.env));
    const env = { PATH: process.env.PATH };
    for (const entry of server.env) {
      assert.equal(typeof entry.name, 'string');
      assert.equal(typeof entry.value, 'string');
      env[entry.name] = entry.value;
    }
    assert.ok(env.CCR_MCP_ENDPOINT);
    assert.ok(env.CCR_MCP_TOKEN);
    // The bearer token travels in env only, never on the command line.
    assert.ok(!server.args.some(arg => arg.includes(env.CCR_MCP_TOKEN)));
    const child = spawn(server.command, server.args, { env, stdio: ['pipe', 'pipe', 'ignore'] });
    mcpChildren.add(child);
    const pending = new Map();
    const settleAll = () => {
      for (const { reject } of pending.values()) reject(new Error('mcp server went away'));
      pending.clear();
    };
    child.on('exit', () => { mcpChildren.delete(child); settleAll(); });
    child.stdin.on('error', settleAll);
    createInterface({ input: child.stdout }).on('line', line => {
      const message = JSON.parse(line);
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      entry.resolve(message);
    });
    let nextId = 0;
    const request = (method, params) => new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    const notify = method => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
    const initialized = await request('initialize', { protocolVersion: '2025-11-25', capabilities: {},
      clientInfo: { name: 'agy-fixture', version: '1.5.1' } });
    assert.equal(initialized.result.protocolVersion, '2025-11-25');
    notify('notifications/initialized');
    return { request };
  };
  const mcp = async (method, params) => {
    const target = mcpBySession.get(sessionId);
    // A text-only session was given no bridge: a real agent would simply not
    // have this tool available, so report that instead of crashing.
    if (!target) throw new Error('no MCP bridge for this session');
    const response = await target.request(method, params);
    if (response.error) throw new Error(response.error.message);
    return response.result;
  };
  function configOptions() {
    const options = [{ id: mode === 'wrong-category' ? 'model' : 'agentModel', category: mode === 'wrong-category' ? 'mode' : 'model', type: 'select', currentValue: model, options: [
      { group: 'all', name: 'All', options: [{ value: 'm2', name: 'Gemini Model' }, { value: 'default', name: 'Default' }] },
    ] }];
    if (model === 'm2' && mode !== 'no-thinking') options.push({
      id: 'agentThinking', category: 'thought_level', type: 'select', currentValue: thinking,
      options: [{ value: 'effort/extra', name: 'Extra' }, { value: 'Med', name: 'Medium' }],
    });
    return options;
  }
  const chunk = (text, sid = sessionId) => send({ method: 'session/update', params: { sessionId: sid,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
  const input = createInterface({ input: process.stdin });
  if (mcpMode) {
    // Spawned forwarders never outlive the agent: session end (stdin close)
    // and any process exit kill them.
    process.on('exit', killMcpChildren);
    input.on('close', () => { killMcpChildren(); process.exit(0); });
  }
  input.on('line', async line => {
    const { id, method, params, result, error } = JSON.parse(line);
    assert.equal(JSON.parse(line).jsonrpc, '2.0');
    if (!method) {
      if (id === 'permission') assert.deepEqual(result, { outcome: { outcome: 'cancelled' } });
      else assert.equal(error.code, -32601);
      denied.add(id);
      if (denied.size === 4) send({ id: promptId, result: { stopReason: 'end_turn' } });
      return;
    }
    record(method, params?.cwd ? { cwd: params.cwd, ...(method === 'session/new' ? { meta: params._meta ?? null } : {}) } : {});
    const reply = result => send({ id, result });
    if (method === 'initialize') {
      assert.equal(params.protocolVersion, 1);
      assert.equal(params.clientInfo.name, 'ccr-gemini-agy-acp');
      assert.match(params.clientInfo.version, /^\d+\.\d+\.\d+/);
      assert.deepEqual(params.clientCapabilities, {});
      if (mode !== 'hang-init') reply({ protocolVersion: mode === 'v2' ? 2 : 1,
        agentCapabilities: antigravityMeta ? { _meta: { antigravity: { systemPrompt: { append: true } } } } : {},
        authMethods: [{ id: 'consumer' }, ...(mode === 'no-key-method' ? [] : [{ id: authMethod,
          ...(isolated && mode === 'terminal-auth' && { type: 'terminal' }),
          ...(isolated && mode === 'env-auth' && { type: 'env_var' }) }])],
        // Explicit ACP account metadata, only in the oauth modes that opt in.
        ...(authMethod === 'oauth-personal' && !['silent-login', 'stderr-login', 'version-email'].includes(mode) &&
          { accountInfo: { email: 'metadata-account@example.com' } }) });
    } else if (method === 'authenticate') {
      assert.deepEqual(params, { methodId: authMethod });
      authAttempts++;
      if (mode === 'auth-failure') {
        process.stderr.write('fixture-secret-diagnostic\n');
        send({ id, error: { code: -32000, message: 'fixture-secret-diagnostic' } });
      } else if ((mode === 'auth-race' && authAttempts === 1) || mode === 'auth-race-persistent') {
        // The transient startup auth race: the login state is still loading.
        send({ id, error: { code: -32000, message: 'Not logged into Antigravity' } });
      } else if (mode === 'auth-race-late' && authAttempts === 1) {
        // The same race message arriving after the 2s window must not be retried.
        setTimeout(() => send({ id, error: { code: -32000, message: 'Not logged into Antigravity' } }), 2100);
      } else if (mode === 'auth-quota-race') {
        send({ id, error: { code: -32000, message: 'authentication required: 429 RESOURCE_EXHAUSTED quota exceeded' } });
      } else if (mode === 'auth-invalid-grant') {
        send({ id, error: { code: -32000, message: 'authentication required: invalid_grant' } });
      } else {
        authenticated = true;
        // The verifying child's own login diagnostic, written to stderr so
        // the transport's bounded capture can scan it for the account email.
        if (authMethod === 'oauth-personal' && !['silent-login', 'version-email'].includes(mode)) {
          process.stderr.write('applyAuthResult: email=stderr-account@example.com, status=OK\n');
        }
        reply({});
      }
    } else if (method === 'session/new') {
      assert.equal(authenticated, true);
      assert.equal(dirname(params.cwd), isolated ? root : tmpdir());
      assert.deepEqual(readdirSync(params.cwd), []);
      sessionAttempts++;
      if (mode === 'session-auth-race' && sessionAttempts === 1) {
        send({ id, error: { code: -32000, message: 'Not logged into Antigravity' } });
        return;
      }
      sessionNumber++;
      sessionId = mode === 'duplicate-session' ? 'one' : `sess-${sessionNumber}`;
      if (mcpMode) {
        // The bridge is per session: two interleaved conversations must each
        // talk to the forwarder their own session was given. A text-only
        // session advertises nothing, which a real agent also serves without
        // tools.
        const [server] = params.mcpServers;
        if (server) mcpBySession.set(sessionId, await adoptMcp(server));
      } else {
        assert.deepEqual(params.mcpServers, []);
      }
      model = 'default';
      thinking = 'Med';
      reply({ sessionId, configOptions: configOptions() });
    } else if (method === 'session/set_config_option') {
      assert.equal(params.sessionId, sessionId);
      if (params.configId === 'agentModel') {
        assert.equal(params.value, 'm2');
        if (mode !== 'ignored-option') model = params.value;
      } else {
        assert.equal(params.configId, 'agentThinking');
        assert.equal(params.value, 'effort/extra');
        thinking = params.value;
      }
      reply({ configOptions: configOptions() });
    } else if (method === 'session/prompt') {
      assert.equal(params.sessionId, sessionId);
      assert.equal(model, 'm2');
      assert.equal(params.prompt.length, 1);
      assert.equal(params.prompt[0].type, 'text');
      promptId = id;
      if (mode === 'prompt-usage') {
        chunk('fixture response');
        reply({ stopReason: 'end_turn', ...JSON.parse(params.prompt[0].text) });
        return;
      }
      switch (params.prompt[0].text) {
        case 'echo this text':
          chunk(params.prompt[0].text);
          reply({ stopReason: 'end_turn', usage: {
            inputTokens: 16, outputTokens: 9, cachedReadTokens: 21,
            cachedWriteTokens: 2, thoughtTokens: 7, totalTokens: 48,
          } });
          break;
        case 'partial-error':
          chunk('partial fixture response');
          send({ id, error: { code: -32000, message: 'fixture-secret-diagnostic' } });
          break;
        case 'exit': process.exit(17); break;
        case 'hang': chunk('ready'); break;
        case 'bad-json': process.stdout.write('not-json\n'); break;
        case 'flood': process.stdout.write(Buffer.alloc(4 * 1024 * 1024 + 1, 'a')); break;
        case 'many-chunks': for (let i = 0; i < 18; i++) chunk('a'.repeat(1024 * 1024)); break;
        case 'unknown-stop': reply({ stopReason: 'fixture-secret-diagnostic' }); break;
        case 'callbacks':
          denied = new Set();
          for (const [key, callback] of [['permission', 'session/request_permission'], ['read', 'fs/read_text_file'],
            ['write', 'fs/write_text_file'], ['terminal', 'terminal/create']]) send({ id: key, method: callback, params: { sessionId } });
          break;
        default:
          if (mcpMode && !mcpBySession.has(sessionId)) {
            // Text-only session: answer plainly, exactly as the ok mode does.
            chunk('from previous turn', `sess-${sessionNumber - 1}`);
            reply({ stopReason: 'max_tokens' });
            return;
          }
          // A resume prompt can arrive while the parked call's result is still
          // travelling back over the stdio bridge. The real agent finishes its
          // in-flight turn before acting on a new prompt, so let the raised
          // call settle first instead of treating the resume as a fresh turn.
          if (callInFlightBySession.has(sessionId)) await callInFlightBySession.get(sessionId);
          if (mcpMode && !toolSettledBySession.has(sessionId)) {
            // Discover the caller's tools over MCP, then raise a call. The call
            // stays parked until the caller answers, so this prompt never
            // finishes until the follow-up request resolves it.
            const listed = await mcp('tools/list', {});
            record('mcp-list', { tools: listed.tools.map(entry => entry.name) });
            // A real agent starts the MCP call before it can report anything
            // about it: the call is what tells the caller a tool is in use.
            const call = mcp('tools/call', { name: listed.tools[0].name, arguments: { key: 'answer' } })
              // A bridge that goes away mid-call is a normal outcome: the turn
              // is abandoned, not a crash.
              .catch(() => ({ content: [{ type: 'text', text: 'bridge closed' }], isError: true }));
            send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call',
              toolCallId: 'agent-side-id', title: 'lookup', rawInput: { key: 'answer' } } } });
            const settling = (async () => {
              const settled = await call;
              record('mcp-call', { text: settled.content?.[0]?.text, isError: settled.isError === true });
              toolSettledBySession.set(sessionId, settled.content?.[0]?.text ?? '');
            })();
            callInFlightBySession.set(sessionId, settling);
            await settling;
            callInFlightBySession.delete(sessionId);
            chunk(toolSettledBySession.get(sessionId) ?? '');
            reply({ stopReason: 'end_turn' });
            return;
          }
          if (mcpMode) {
            // The follow-up turn carries the caller's result: relay it and end.
            chunk(`resumed with ${toolSettledBySession.get(sessionId) ?? ''}`);
            reply({ stopReason: 'end_turn' });
            return;
          }
          chunk('from previous turn', `sess-${sessionNumber - 1}`);
          for (const [sessionUpdate, content] of [ ['user_message_chunk', { type: 'text', text: 'user' }],
            ['agent_thought_chunk', { type: 'text', text: 'thought' }], ['agent_message_chunk', { type: 'image' }],
            ['tool_call', { type: 'text', text: 'tool' }] ]) {
            send({ method: 'session/update', params: { sessionId, update: { sessionUpdate, content } } });
          }
          chunk(params.prompt[0].text);
          reply({ stopReason: 'max_tokens' });
          chunk('after result');
          break;
      }
    }
  });
}
