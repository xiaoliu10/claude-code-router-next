import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Config } from '../src/types.ts';
import { mergeClientConfig, openConfigDraft, refreshConfigDraft } from '../src/utils/config-draft.ts';

Object.assign(globalThis, {
  localStorage: { getItem: () => null },
  window: { location: { search: '' } },
});
const { default: ApiClient } = await import('../src/lib/api.ts');

const original = {
  HOST: '$BIND_HOST', Providers: [{ api_key: '${TEST_KEY}' }], extra: { flags: [1, 2] },
} as unknown as Config;
const revisionA = 'a'.repeat(64);
const revisionB = 'b'.repeat(64);

for (const first of ['web', 'desktop']) {
  test(`two drafts with the same revision, ${first} saves first`, async (t) => {
    let disk = original;
    let revision = revisionA;
    const writes: unknown[] = [];
    t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
      if (init.method === 'GET') return Response.json(disk, { headers: { 'X-CCR-Config-Revision': revision } });
      assert.equal(init.method, 'PUT');
      const body = JSON.parse(init.body as string);
      writes.push(body);
      if (body.revision !== revision) return Response.json({ success: false }, { status: 409 });
      disk = body.config;
      revision = revisionB;
      return Response.json({ success: true });
    });
    const client = new ApiClient();
    const base = await client.getConfigSnapshot();
    let web = { ...openConfigDraft(base), config: { ...base.config, LOG: true } };
    const desktop = { ...base.config, PORT: 5000 };
    const saveDesktop = () => client.updateConfig(desktop, base.revision);
    const saveWeb = () => client.updateConfig(web.config, web.base.revision);
    if (first === 'desktop') {
      await saveDesktop();
      // An auth check and a partial plugin reconciliation both see the new
      // revision, but neither replaces the raw config underlying web's edits.
      await client.getConfig();
      web = refreshConfigDraft(web, await client.getConfigSnapshot(), (current, server) => ({ ...current, Providers: server.Providers }));
      await assert.rejects(saveWeb, { status: 409 });
      assert.deepEqual(web.config, { ...original, LOG: true });
    } else {
      await saveWeb();
      await assert.rejects(saveDesktop, { status: 409 });
    }
    const webBody = { revision: revisionA, config: { ...original, LOG: true } };
    const desktopBody = { revision: revisionA, config: desktop };
    assert.deepEqual(writes, first === 'web' ? [webBody, desktopBody] : [desktopBody, webBody]);
    assert.deepEqual(disk, first === 'web' ? webBody.config : desktop);
  });
}

test('a missing or invalid GET revision never issues a write', async (t) => {
  for (const revision of [null, '*']) {
    const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json(original, {
      headers: revision ? { 'X-CCR-Config-Revision': revision } : {},
    }));
    const client = new ApiClient();
    const base = await client.getConfigSnapshot();
    await assert.rejects(client.updateConfig(base.config, base.revision), /revision/);
    assert.equal(fetch.mock.callCount(), 1);
    fetch.mock.restore();
  }
});

test('only a clean draft adopts a full background snapshot and its revision together', () => {
  const clean = openConfigDraft({ config: original, revision: revisionA });
  const latest = { config: { ...original, LOG: true }, revision: revisionB };
  assert.deepEqual(refreshConfigDraft(clean, latest), openConfigDraft(latest));
  const dirty = { ...clean, config: { ...original, PORT: 5000 } };
  assert.equal(refreshConfigDraft(dirty, latest), dirty);
});

for (const dirty of [false, true]) {
  test(`client takeover refresh reconciles a ${dirty ? 'dirty' : 'clean'} draft before ordinary save`, async (t) => {
    const base = openConfigDraft({ config: original, revision: revisionA });
    const server = {
      ...original, HOST: 'changed-on-server', Clients: { codex: { enabled: true } },
      Router: { default: 'server,default', models: { codex: 'server,alias' } },
    };
    const current = dirty ? {
      ...base, config: { ...original, PORT: 5000, Router: { default: 'local,default', models: { local: 'local,alias' } } },
    } : base;
    const client = new ApiClient();
    let writes = 0;
    t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
      if (init.method === 'GET') return Response.json(server, { headers: { 'X-CCR-Config-Revision': revisionB } });
      assert.equal(init.method, 'PUT');
      const { config, revision } = JSON.parse(init.body as string);
      assert.equal(config.LOG, true);
      assert.deepEqual(config.Clients, server.Clients);
      assert.equal(revision, dirty ? revisionA : revisionB);
      writes++;
      if (dirty) {
        assert.equal(config.PORT, 5000);
        assert.equal(config.HOST, original.HOST);
        assert.deepEqual(config.Router, { default: 'local,default', models: { local: 'local,alias', codex: 'server,alias' } });
        return Response.json({ success: false }, { status: 409 });
      }
      assert.deepEqual(config, { ...server, LOG: true });
      return Response.json({ success: true });
    });
    const refreshed = refreshConfigDraft(current, await client.getConfigSnapshot(), mergeClientConfig);
    const save = client.updateConfig({ ...refreshed.config, LOG: true }, refreshed.base.revision);
    if (dirty) await assert.rejects(save, { status: 409 });
    else assert.equal((await save).success, true);
    assert.equal(writes, 1);
  });
}
