import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Server from "../server";
import { build } from "esbuild";
import { pathToFileURL } from "node:url";
let activate: any, manifest: any, GeminiOauthAuthService: any, GeminiOauthCredentialStore: any;
const bundleDir = mkdtempSync(join(tmpdir(), "gemini-ownership-bundle-"));
beforeAll(async () => {
  const pkg = join(__dirname, "../../../plugins/gemini-oauth/src");
  const entry = join(bundleDir, "owned.mjs");
  await build({ stdin: { contents: `export * from '${pkg}/plugin.ts'; export * from '${pkg}/auth-service.ts';`, resolveDir: pkg }, bundle: true, platform: "node", format: "esm", outfile: entry, logLevel: "silent" });
  ({ activate, manifest, GeminiOauthAuthService, GeminiOauthCredentialStore } = await import(pathToFileURL(entry).href));
});
afterAll(() => rmSync(bundleDir, { recursive: true, force: true }));
import { getDirectDispatcher } from "../services/proxy";
const log = { info() {}, warn() {}, error() {} };
const cleanup: Array<() => any> = [];
beforeEach(() => {
  vi.stubEnv("GEMINI_OAUTH_CLIENT_ID", "fixture-client"); vi.stubEnv("GEMINI_OAUTH_CLIENT_SECRET", "fixture-secret");
  vi.stubGlobal("fetch", vi.fn(async () => { throw Error("network forbidden"); }));
});
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
});
async function makeHost(id: string, refresh = `REFRESH_${id}`) {
  const dir = mkdtempSync(join(tmpdir(), "gemini-owned-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const config: any = { Providers: [], Router: {} };
  const store = new GeminiOauthCredentialStore(join(dir, "gemini-oauth-credentials.json"));
  await store.save({ version: 2, kind: "antigravity", account: { email: `${id}@example.invalid`, refreshToken: refresh, projectId: `project-${id}`, tier: "paid", importedAt: "2026-01-01T00:00:00Z", lastError: null, cooldownUntil: null } });
  const host = { configDir: dir, readConfig: async () => config, readRawConfig: async () => config, writeConfig: async (next: any) => { Object.assign(config, next); }, reloadRuntime: async () => {}, getDirectDispatcher };
  const service = new GeminiOauthAuthService({ store, host, logger: log });
  return { dir, store, host, service };
}

describe("Gemini activate-owned credential lifetime", () => {
  it("does not share refresh flights or rotation callbacks even for identical refresh tokens", async () => {
    const a = await makeHost("a", "SAME_REFRESH"); const b = await makeHost("b", "SAME_REFRESH");
    const resolvers: Array<(r: Response) => void> = [];
    const fetch = vi.fn(async () => new Promise<Response>(resolve => resolvers.push(resolve)));
    vi.stubGlobal("fetch", fetch);
    const a1 = a.service.getAccessToken(); const a2 = a.service.getAccessToken();
    // Identify A's pending network operation before starting B; filesystem load
    // scheduling must not determine which fixture receives which response.
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const b1 = b.service.getAccessToken();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    resolvers[0](new Response('{"access_token":"ACCESS_A","refresh_token":"ROTATED_A"}'));
    resolvers[1](new Response('{"access_token":"ACCESS_B","refresh_token":"ROTATED_B"}'));
    expect(await Promise.all([a1, a2, b1])).toEqual(["ACCESS_A", "ACCESS_A", "ACCESS_B"]);
    expect((await a.store.load())?.account.refreshToken).toBe("ROTATED_A");
    expect((await b.store.load())?.account.refreshToken).toBe("ROTATED_B");
    await b.service.forceTokenRefresh(); await b.service.disconnect();
    expect(await a.service.getAccessToken()).toBe("ACCESS_A"); expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("late rotation cannot resurrect a disconnected account or write into another host", async () => {
    const a = await makeHost("a"); const b = await makeHost("b");
    let resolve!: (r: Response) => void;
    vi.stubGlobal("fetch", vi.fn(async () => new Promise<Response>(r => { resolve = r; })));
    const token = a.service.getAccessToken();
    // Attach the rejection observer before resolving the held network response.
    const rejected = expect(token).rejects.toMatchObject({ code: "gemini_oauth_not_connected" });
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    await a.service.disconnect();
    resolve(new Response('{"access_token":"LATE","refresh_token":"LATE_ROTATED"}'));
    await rejected;
    expect(await a.store.load()).toBeNull();
    expect((await b.store.load())?.account.refreshToken).toBe("REFRESH_b");
  });

  it("closing A during a refresh cannot redirect its late persisted rotation into B", async () => {
    const a = await makeHost("a"); const b = await makeHost("b");
    const s = new Server({ logger: false, useJsonFile: false, initialConfig: { providers: [], ACTIVE_PROBE_ENABLED: false } });
    cleanup.push(() => s.app.close()); await s.ready();
    const tx = s.pluginRegistry.beginActivation(manifest, log, a.host);
    await activate(tx.context); await tx.commit(undefined, s.app);
    const runtime = s.pluginRegistry.getManagedRuntimeFor({ name: "gemini-oauth", apiKey: "ccr-managed-gemini-oauth" })!;
    let resolve!: (r: Response) => void;
    vi.stubGlobal("fetch", vi.fn(async () => new Promise<Response>(r => { resolve = r; })));
    const signing = runtime.signRequest({ headers: {}, requestBody: {}, provider: {} as any });
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    await s.app.close();
    resolve(new Response('{"access_token":"LATE_A","refresh_token":"ROTATED_A"}'));
    expect((await signing).Authorization).toBe("Bearer LATE_A");
    expect((await a.store.load())?.account.refreshToken).toBe("ROTATED_A");
    expect((await b.store.load())?.account.refreshToken).toBe("REFRESH_b");
    expect(s.pluginRegistry.getRegisteredRuntimes()).toEqual([]);
  });

  it("two activations of the SAME module keep root/preset transformer and runtime services independent after close", async () => {
    const a = await makeHost("a"); const b = await makeHost("b");
    const build = async (fixture: typeof a) => {
      const s = new Server({ logger: false, useJsonFile: false, initialConfig: { providers: [], ACTIVE_PROBE_ENABLED: false } });
      cleanup.push(() => s.app.close()); await s.ready();
      const tx = s.pluginRegistry.beginActivation(manifest, log, fixture.host);
      await activate(tx.context); await tx.commit(undefined, s.app);
      return s;
    };
    const sa = await build(a); const sb = await build(b);
    const counts: Record<string, number> = {};
    vi.stubGlobal("fetch", vi.fn(async (_url: any, init: any) => {
      const refresh = new URLSearchParams(init.body).get("refresh_token")!;
      counts[refresh] = (counts[refresh] ?? 0) + 1;
      return new Response(JSON.stringify({ access_token: `ACCESS_${refresh}` }));
    }));
    const rtA = sa.pluginRegistry.getManagedRuntimeFor({ name: "gemini-oauth", apiKey: "ccr-managed-gemini-oauth" })!;
    const rtB = sb.pluginRegistry.getManagedRuntimeFor({ name: "gemini-oauth", apiKey: "ccr-managed-gemini-oauth" })!;
    const sign = (rt: typeof rtA) => rt.signRequest({ headers: {}, requestBody: {}, provider: {} as any });
    expect((await sign(rtA)).Authorization).toBe("Bearer ACCESS_REFRESH_a");
    expect((await sign(rtB)).Authorization).toBe("Bearer ACCESS_REFRESH_b");
    await rtB.authRefresh?.forceRefresh();
    await sb.app.close();
    expect((await sign(rtA)).Authorization).toBe("Bearer ACCESS_REFRESH_a");
    expect(counts).toEqual({ REFRESH_a: 1, REFRESH_b: 1 });
    const Constructor = sa.transformerService.getTransformer("gemini-oauth") as any;
    const transformer = new Constructor();
    const out = await transformer.transformRequestIn({ model: "gemini-3-flash", messages: [{ role: "user", content: "hello" }] }, {}, {});
    expect(out.body.project).toBe("project-a");
    expect(counts.REFRESH_a).toBe(1);
  });
});
