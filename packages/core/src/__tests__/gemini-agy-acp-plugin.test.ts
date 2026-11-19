import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import Server from '../server';
import { loadInstalledPlugins } from '../provider-plugins/loader';

// Exercise both wire formats through the real loader, router and stdio worker.
it.skipIf(process.platform === 'win32')('routes text chat through the installed ACP plugin with zero HTTP attempts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ccr-acp-route-'));
  const name = 'gemini-agy-acp';
  const source = join(__dirname, '../../../plugins', name);
  const provider = { name, api_base_url: 'https://example.com/unused', api_key: 'ccr-managed-' + name,
    models: ['m2'], transformer: { use: [name] } };
  const network = vi.fn(async () => { throw new Error('Unexpected upstream HTTP'); });
  vi.stubGlobal('fetch', network);
  vi.stubEnv('GEMINI_API_KEY', 'fixture-value');
  const server = new Server({ logger: false, useJsonFile: false, initialConfig: {
    providers: [provider, { name: 'backup', models: ['m2'], api_base_url: 'https://backup.example.com/unused', api_key: 'test-key' }],
    ACTIVE_PROBE_ENABLED: false, Router: { enableFallback: true }, fallback: { default: ['backup,m2'] },
  } });
  try {
    const pkg = join(dir, 'source');
    for (const file of ['scripts', 'src', 'package.json', 'plugin.json']) await cp(join(source, file), join(pkg, file), { recursive: true });
    execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: pkg });
    await mkdir(join(dir, 'plugins'));
    await cp(join(pkg, 'dist'), join(dir, 'plugins', name), { recursive: true });
    await writeFile(join(dir, 'plugins', 'plugins.json'), JSON.stringify([{ name, enabled: true }]));
    const binary = join(dir, 'fixture.mjs');
    await writeFile(binary, '#!' + process.execPath + '\n' + await readFile(join(source, 'test/fixtures/agy-acp.mjs'), 'utf8'), { mode: 0o700 });
    await writeFile(join(dir, 'mode'), 'ok');
    await writeFile(join(dir, name + '.json'), JSON.stringify({ enabled: true, binary, authMethod: 'gemini-api-key' }));
    await server.ready();
    const log = { info() {}, warn() {}, error() {} };
    const loaded = await loadInstalledPlugins({ configDir: dir, log, getServer: () => server });
    expect(loaded.loaded).toEqual([name]);
    await server.registerNamespace('/');
    const model = name + ',m2';
    const messages = [{ role: 'user', content: 'echo this text' }];
    const post = (url: string, extra: object = {}) => server.app.inject({ method: 'POST', url, payload: { model, messages, ...extra } });
    const chat = await post('/v1/chat/completions');
    expect(chat.statusCode, chat.body).toBe(200);
    expect(chat.json().choices[0].message.content).toBe(messages[0].content);
    const stream = await post('/v1/chat/completions', { stream: true });
    expect(stream.statusCode, stream.body).toBe(200);
    expect(stream.body).toContain('"content":"echo this text"');
    expect(stream.body).toContain('[DONE]');
    const anthropic = await post('/v1/messages', { max_tokens: 32 });
    expect(anthropic.statusCode, anthropic.body).toBe(200);
    expect(anthropic.json().content).toContainEqual({ type: 'text', text: messages[0].content });
    const failure = await post('/v1/chat/completions', { messages: [{ role: 'user', content: 'exit' }] });
    expect(failure.statusCode).toBe(502);
    expect(network).not.toHaveBeenCalled();
    const events = (await readFile(join(dir, 'events'), 'utf8')).trim().split('\n').map(line => JSON.parse(line).event);
    expect(events.filter(event => event === 'session/prompt')).toHaveLength(4);
    expect(events.filter(event => event === 'spawn')).toHaveLength(1);
  } finally {
    await server.app.close();
    vi.unstubAllGlobals(); vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  }
}, 20000);
