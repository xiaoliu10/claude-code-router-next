import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const mode = readFileSync(join(fixtureDir, 'mode'), 'utf8');
const record = (event, data = {}) => appendFileSync(join(fixtureDir, 'events'), JSON.stringify({ event, pid: process.pid, ...data }) + '\n');
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const argv = process.argv.slice(2);
const root = dirname(process.env.HOME);
for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
  'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'TMPDIR', 'TEMP', 'TMP']) {
  assert.equal(dirname(process.env[key]), root);
  assert.equal(statSync(process.env[key]).mode & 0o077, 0);
}
assert.equal(dirname(process.cwd()), realpathSync(root));
assert.equal(process.env.AGY_TEST_PARENT_ONLY, undefined);
assert.equal(process.env.GOOGLE_APPLICATION_CREDENTIALS, undefined);

if (argv[0] === '--version') {
  assert.deepEqual(argv, ['--version']);
  assert.equal(process.env.GEMINI_API_KEY, undefined);
  record('version', { root });
  if (mode === 'hang-version') setInterval(() => {}, 60_000);
  else if (mode === 'long-version') process.stdout.write('0'.repeat(4097));
  else console.log(`agy version ${mode === 'old' ? '1.5.0' : mode === 'prerelease' ? '1.5.1-rc1' : '1.5.1'}`);
} else {
  assert.deepEqual(argv, ['acp', '--sandbox']);
  assert.equal(process.env.GEMINI_API_KEY, 'fixture-value');
  record('spawn', { root });
  let authenticated = false;
  let sessionNumber = 0;
  let sessionId;
  let model;
  let thinking;
  let promptId;
  let denied = new Set();
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
  input.on('line', line => {
    const { id, method, params, result, error } = JSON.parse(line);
    assert.equal(JSON.parse(line).jsonrpc, '2.0');
    if (!method) {
      if (id === 'permission') assert.deepEqual(result, { outcome: { outcome: 'cancelled' } });
      else assert.equal(error.code, -32601);
      denied.add(id);
      if (denied.size === 4) send({ id: promptId, result: { stopReason: 'end_turn' } });
      return;
    }
    record(method, params?.cwd ? { cwd: params.cwd } : {});
    const reply = result => send({ id, result });
    if (method === 'initialize') {
      assert.equal(params.protocolVersion, 1);
      assert.equal(params.clientInfo.name, 'ccr-gemini-agy-acp');
      assert.match(params.clientInfo.version, /^\d+\.\d+\.\d+/);
      assert.deepEqual(params.clientCapabilities, {});
      if (mode !== 'hang-init') reply({ protocolVersion: mode === 'v2' ? 2 : 1, agentCapabilities: {},
        authMethods: [{ id: 'consumer' }, ...(mode === 'no-key-method' ? [] : [{ id: 'gemini-api-key',
          ...(mode === 'terminal-auth' && { type: 'terminal' }),
          ...(mode === 'env-auth' && { type: 'env_var' }) }])] });
    } else if (method === 'authenticate') {
      assert.deepEqual(params, { methodId: 'gemini-api-key' });
      if (mode === 'auth-failure') {
        process.stderr.write('fixture-secret-diagnostic\n');
        send({ id, error: { code: -32000, message: 'fixture-secret-diagnostic' } });
      } else { authenticated = true; reply({}); }
    } else if (method === 'session/new') {
      assert.equal(authenticated, true);
      assert.equal(dirname(params.cwd), root);
      assert.deepEqual(readdirSync(params.cwd), []);
      assert.deepEqual(params.mcpServers, []);
      sessionNumber++;
      sessionId = mode === 'duplicate-session' ? 'one' : `sess-${sessionNumber}`;
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
      switch (params.prompt[0].text) {
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
