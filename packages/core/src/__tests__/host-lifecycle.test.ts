import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import Server from "../server";
import { PluginRegistry } from "../provider-plugins/registry";
import { loadInstalledPlugins } from "../provider-plugins/loader";
import { reloadProviderRuntime } from "../provider-plugins/host";
import { registerAdminRoutes } from "../ccr/admin-routes";
import { registerRequestPipeline } from "../ccr/request-pipeline";
import { resetActiveProbeService } from "../services/active-probe";

const log = { info() {}, warn() {}, error() {} };
const cleanups: Array<() => any> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  resetActiveProbeService();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "host-lifecycle-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const records: any[] = [];
  const plugin = (name: string, entry: string, opts: { manifest?: string; enabled?: boolean; card?: string } = {}) => {
    const path = join(dir, "plugins", name);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "package.json"), '{"type":"module"}');
    writeFileSync(join(path, "plugin.json"), JSON.stringify({ name: opts.manifest ?? name, version: "1", coreApi: "1" }));
    writeFileSync(join(path, "plugin.js"), entry);
    if (opts.card !== undefined) writeFileSync(join(path, "card.js"), opts.card);
    records.push({ name, enabled: opts.enabled !== false });
    writeFileSync(join(dir, "plugins", "plugins.json"), JSON.stringify(records));
    return path;
  };
  return { dir, plugin };
}
const contributions = `
ctx.registerManagedRuntime({name:'shared-runtime',isManaged:p=>p?.apiKey==='ccr-managed-test',signRequest:async({headers})=>headers});
ctx.registerTransformer(class {static TransformerName='test-transformer'; name='test-transformer'});
ctx.registerConfigProtector(next=>{next.protected=true});
ctx.registerAdminRoutes(app=>app.get('/api/test-plugin',async()=>({ok:true})));
`;
async function server(providers: any[] = []) {
  const s = new Server({ logger: false, useJsonFile: false, initialConfig: {
    providers, Router: {}, ACTIVE_PROBE_ENABLED: false, enableFallback: false,
  } });
  cleanups.push(() => s.app.close());
  await s.ready();
  return s;
}
const provider = (name: string, url: string, model = "m") => ({ name, api_base_url: url, api_key: "DUMMY", models: [model] });
const send = (s: Server, model: string, prefix = "") => s.app.inject({ method: "POST", url: `${prefix}/v1/chat/completions`, payload: { model, messages: [{ role: "user", content: "hello" }] } });

describe("owned provider-plugin host", () => {
  it.each(["runtime", "transformer", "protector", "routes", "card", "locales"])("rolls back every contribution after %s activation failure", async point => {
    const { dir, plugin } = fixture();
    const steps = [
      `ctx.registerManagedRuntime({name:'shared-runtime',isManaged:()=>true,signRequest:async({headers})=>headers})`,
      `ctx.registerTransformer(class {static TransformerName='test-transformer'})`,
      `ctx.registerConfigProtector(next=>{next.protected=true})`,
      `ctx.registerAdminRoutes(app=>app.get('/failed',async()=>true))`,
      `ctx.registerUiCard({cardPath:'card.js'})`,
      `ctx.registerLocales({en:{title:'failed'}})`,
    ];
    const index = ["runtime", "transformer", "protector", "routes", "card", "locales"].indexOf(point);
    plugin("broken", `export function activate(ctx){${steps.slice(0, index + 1).join(";")}; throw Error('activation failed')}`, { card: "export default {}" });
    const s = await server();
    const result = await loadInstalledPlugins({ configDir: dir, log, getServer: () => s });
    expect(result.loaded).toEqual([]); expect(result.failed).toHaveLength(1);
    expect(s.pluginRegistry.listLoadedPlugins()).toEqual([]);
    expect(s.pluginRegistry.getManagedRuntimeFor({})).toBeUndefined();
    expect(s.transformerService.hasTransformer("test-transformer")).toBe(false);
    const next: any = {}; s.pluginRegistry.applyConfigProtectors(next, {}); expect(next).toEqual({});
    const app = Fastify(); await s.pluginRegistry.registerAllRoutes(app);
    expect((await app.inject({ url: "/failed" })).statusCode).toBe(404); await app.close();
  });

  it("rejects manifest aliases, duplicate runtime/transformer owners and caught registration errors", async () => {
    const { dir, plugin } = fixture();
    plugin("alias", `export function activate(){}`, { manifest: "victim" });
    plugin("owner", `export function activate(ctx){${contributions}}`);
    plugin("collision", `export function activate(ctx){${contributions}}`);
    plugin("caught", `export function activate(ctx){try {ctx.registerUiCard({cardPath:'../private.js'})}catch{};ctx.registerConfigProtector(next=>{next.bad=true})}`);
    plugin("missing", "export const invalid=true");
    const s = await server();
    const result = await loadInstalledPlugins({ configDir: dir, log, getServer: () => s });
    expect(result.loaded).toEqual(["owner"]); expect(result.failed.map(p => p.name)).toEqual(["alias", "collision", "caught", "missing"]);
    const next: any = {}; s.pluginRegistry.applyConfigProtectors(next, {}); expect(next).toEqual({ protected: true });
    expect(s.pluginRegistry.listLoadedPlugins().map(p => p.name)).toEqual(["owner"]);
  });

  it("does not overwrite a built-in transformer when commit collides", async () => {
    const { dir, plugin } = fixture();
    plugin("collision", `export function activate(ctx){${contributions}ctx.registerTransformer(class {static TransformerName='OpenAI'})}`);
    const s = await server(); const original = s.transformerService.getTransformer("OpenAI");
    expect(original).toBeTruthy();
    expect((await loadInstalledPlugins({ configDir: dir, log, getServer: () => s })).failed).toHaveLength(1);
    expect(s.transformerService.getTransformer("OpenAI")).toBe(original);
    expect(s.transformerService.hasTransformer("test-transformer")).toBe(false);
  });

  it("isolates overlapping hosts and disposes only the closed host, including disabled recreation", async () => {
    const { dir, plugin } = fixture(); plugin("owned", `export function activate(ctx){${contributions}}`);
    const a = await server(); const b = await server();
    for (const s of [a, b]) expect((await loadInstalledPlugins({ configDir: dir, log, getServer: () => s })).loaded).toEqual(["owned"]);
    expect(a.pluginRegistry.getManagedRuntimeFor({ apiKey: "ccr-managed-test" })).not.toBe(b.pluginRegistry.getManagedRuntimeFor({ apiKey: "ccr-managed-test" }));
    await a.app.close();
    expect(a.pluginRegistry.listLoadedPlugins()).toEqual([]);
    expect(b.pluginRegistry.listLoadedPlugins()).toHaveLength(1);
    expect(b.transformerService.hasTransformer("test-transformer")).toBe(true);
    writeFileSync(join(dir, "plugins", "plugins.json"), '[{"name":"owned","enabled":false}]');
    const c = await server(); await loadInstalledPlugins({ configDir: dir, log, getServer: () => c });
    expect(c.pluginRegistry.getManagedRuntimeFor({ apiKey: "ccr-managed-test" })).toBeUndefined();
    expect(c.transformerService.hasTransformer("test-transformer")).toBe(false);
    expect(b.pluginRegistry.listLoadedPlugins()).toHaveLength(1);
  });

  it("rolls back prepared transformer writes on an unexpected registration failure", async () => {
    const { dir, plugin } = fixture();
    plugin("atomic", `export function activate(ctx){${contributions}ctx.registerTransformer(class {static TransformerName='second-transformer'})}`);
    const s = await server();
    const register = s.transformerService.registerTransformer.bind(s.transformerService);
    vi.spyOn(s.transformerService, "registerTransformer").mockImplementation((name, value) => {
      register(name, value);
      if (name === "second-transformer") throw Error("synthetic registration failure");
    });
    const result = await loadInstalledPlugins({ configDir: dir, log, getServer: () => s });
    expect(result.failed[0].error).toContain("synthetic registration failure");
    expect(s.pluginRegistry.listLoadedPlugins()).toEqual([]);
    expect(s.transformerService.hasTransformer("test-transformer")).toBe(false);
    expect(s.transformerService.hasTransformer("second-transformer")).toBe(false);
  });

  it("validates duplicate runtime registration even if the plugin catches it", async () => {
    const { dir, plugin } = fixture();
    plugin("caught-runtime", `export function activate(ctx){const rt={name:'duplicate',isManaged:()=>true,signRequest:async({headers})=>headers};ctx.registerManagedRuntime(rt);try{ctx.registerManagedRuntime(rt)}catch{}}`);
    const s = await server();
    const result = await loadInstalledPlugins({ configDir: dir, log, getServer: () => s });
    expect(result.failed[0].error).toContain('already registered');
    expect(s.pluginRegistry.getRegisteredRuntimes()).toEqual([]);
  });

  it("propagates route registration failures without partial routes/contributions", async () => {
    const { dir, plugin } = fixture(); plugin("bad-routes", `export function activate(ctx){${contributions}ctx.registerAdminRoutes(app=>{app.get('/partial',async()=>true);throw Error('route failure')})}`);
    const s = await server();
    const result = await loadInstalledPlugins({ configDir: dir, log, getServer: () => s });
    expect(result.failed[0].error).toContain("route failure");
    expect(s.app.hasRoute({ method: "GET", url: "/partial" })).toBe(false);
    expect(s.pluginRegistry.listLoadedPlugins()).toEqual([]);
    expect(s.transformerService.hasTransformer("test-transformer")).toBe(false);
  });

  it("awaits async route callbacks and preserves earlier success when later callbacks reject/collide", async () => {
    const { dir, plugin } = fixture();
    plugin("success", `export function activate(ctx){${contributions}}`);
    plugin("async-failure", `export function activate(ctx){ctx.registerAdminRoutes(async app=>{app.get('/async-partial',async()=>true);await Promise.resolve();throw Error('async route rejected')});ctx.registerConfigProtector(next=>{next.bad=true})}`);
    plugin("duplicate", `export function activate(ctx){ctx.registerAdminRoutes(app=>app.get('/api/test-plugin',async()=>false))}`);
    plugin("core-conflict", `export function activate(ctx){ctx.registerAdminRoutes(app=>app.get('/existing',async()=>false))}`);
    const s = await server(); s.app.get("/existing", async () => ({ ordinary: true }));
    const result = await loadInstalledPlugins({ configDir: dir, log, getServer: () => s });
    expect(result.loaded).toEqual(["success"]);
    expect(result.failed.map(p => p.name)).toEqual(["async-failure", "duplicate", "core-conflict"]);
    expect(s.pluginRegistry.listLoadedPlugins().map(p => p.name)).toEqual(["success"]);
    const next: any = {}; s.pluginRegistry.applyConfigProtectors(next, {}); expect(next).toEqual({ protected: true });
    await s.pluginRegistry.registerAllRoutes(s.app);
    expect((await s.app.inject({ url: "/api/test-plugin" })).json()).toEqual({ ok: true });
    expect((await s.app.inject({ url: "/existing" })).json()).toEqual({ ordinary: true });
    expect((await s.app.inject({ url: "/async-partial" })).statusCode).toBe(404);
  });

  it("rejects route-bearing commits without a host and late commits after dispose", async () => {
    const registry = new PluginRegistry();
    const host = { configDir: "/unused", readConfig: async () => ({}), writeConfig: async () => {}, reloadRuntime: async () => {}, getDirectDispatcher() {} };
    const tx = registry.beginActivation({ name: "no-host", version: "1", coreApi: "1" }, log, host);
    tx.context.registerAdminRoutes(app => app.get("/no-host", async () => true));
    await expect(tx.commit()).rejects.toThrow("require a host app");
    expect(registry.listLoadedPlugins()).toEqual([]);
    const app = Fastify();
    let release!: () => void;
    const late = registry.beginActivation({ name: "late", version: "1", coreApi: "1" }, log, host);
    late.context.registerAdminRoutes(async () => { await new Promise<void>(resolve => { release = resolve; }); });
    const committing = late.commit(undefined, app);
    const rejected = expect(committing).rejects.toThrow("disposed");
    await vi.waitFor(() => expect(release).toBeTypeOf("function")); registry.dispose(); release();
    await rejected; await app.close(); expect(registry.listLoadedPlugins()).toEqual([]);
  });

  it("serves only committed JS card bytes with existing authentication and rejects private/disabled/symlink assets", async () => {
    const { dir, plugin } = fixture();
    const publicDir = plugin("public", `export function activate(ctx){ctx.registerUiCard({cardPath:'card.js'})}`, { card: "export default 'PUBLIC'" });
    writeFileSync(join(publicDir, "private.json"), '{"secret":"DUMMY_PRIVATE"}');
    const disabled = plugin("disabled", "export function activate(){}", { enabled: false, card: "DUMMY_DISABLED" });
    symlinkSync(disabled, join(dir, "plugins", "directory-link"));
    const outside = join(dir, "outside.js"); writeFileSync(outside, "DUMMY_OUTSIDE");
    const link = plugin("file-link", `export function activate(ctx){ctx.registerUiCard({cardPath:'card.js'})}`);
    symlinkSync(outside, join(link, "card.js"));
    const s = await server();
    const result = await loadInstalledPlugins({ configDir: dir, log, getServer: () => s });
    expect(result.loaded).toEqual(["public"]); expect(result.failed.map(p => p.name)).toEqual(["file-link"]);
    const config = { Providers: [provider("ordinary", "https://ordinary.invalid")], APIKEY: "fixture-api-key", Router: {} };
    await registerAdminRoutes(s, config); registerRequestPipeline(s, config);
    const get = (url: string, auth = true) => s.app.inject({ url, remoteAddress: "203.0.113.1", headers: auth ? { authorization: "Bearer fixture-api-key" } : {} });
    expect((await get("/plugins/public/card.js", false)).statusCode).toBe(401);
    expect((await get("/plugins/public/card.js?api_key=fixture-api-key", false)).statusCode).toBe(401);
    const card = await get("/plugins/public/card.js"); expect(card.statusCode).toBe(200); expect(card.body).toBe("export default 'PUBLIC'");
    for (const url of ["/plugins/public/private.json", "/plugins/disabled/card.js", "/plugins/file-link/card.js", "/plugins/directory-link/card.js", "/plugins/public/..%2foutside.js"]) expect((await get(url)).statusCode, url).toBe(404);
    // Swap after activation: HTTP only sees the validated public bytes.
    rmSync(join(publicDir, "card.js")); symlinkSync(outside, join(publicDir, "card.js"));
    expect((await get("/plugins/public/card.js")).body).toBe("export default 'PUBLIC'");
    expect(s.pluginRegistry.getPublicCard("disabled", "card.js")).toBeUndefined();
  });

  it("reloads live root add/edit/remove while preserving preset authority and explicit namespace reload", async () => {
    const original = provider("ordinary", "https://root.invalid/v1/chat/completions");
    const local = provider("ordinary", "https://preset.invalid/v1/chat/completions");
    const only = provider("preset-only", "https://only.invalid/v1/chat/completions", "only-model");
    const s = await server([original]);
    await s.registerNamespace("/"); await s.registerNamespace("/preset/demo", { Providers: [local, only], Router: {}, ACTIVE_PROBE_ENABLED: false });
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: any) => { calls.push(String(url)); return new Response('{"choices":[{"message":{"role":"assistant","content":"healthy"}}]}', { headers: { "content-type": "application/json" } }); }));
    const rootService = s.providerService;
    const edited = { ...original, api_base_url: "https://edited.invalid/v1/chat/completions" };
    const added = provider("added", "https://added.invalid/v1/chat/completions", "new-model");
    reloadProviderRuntime(s, { Providers: [edited, added], ACTIVE_PROBE_ENABLED: false }, log);
    expect(s.providerService).toBe(rootService);
    expect((await send(s, "ordinary,m")).statusCode).toBe(200); expect(calls.at(-1)).toContain("edited.invalid");
    expect((await send(s, "added,new-model")).statusCode).toBe(200); expect(calls.at(-1)).toContain("added.invalid");
    expect((await send(s, "ordinary,m", "/preset/demo")).statusCode).toBe(200); expect(calls.at(-1)).toContain("preset.invalid");
    expect((await send(s, "added,new-model", "/preset/demo")).statusCode).toBe(404);
    reloadProviderRuntime(s, { Providers: [], ACTIVE_PROBE_ENABLED: false }, log);
    expect((await send(s, "ordinary,m")).statusCode).toBe(404);
    expect((await send(s, "preset-only,only-model", "/preset/demo")).statusCode).toBe(200);
    s.reloadNamespaceProviders("/preset/demo", [{ ...local, api_base_url: "https://namespace-edit.invalid/v1/chat/completions" }]);
    expect((await send(s, "ordinary,m", "/preset/demo")).statusCode).toBe(200); expect(calls.at(-1)).toContain("namespace-edit.invalid");
    expect((await send(s, "preset-only,only-model", "/preset/demo")).statusCode).toBe(404);
  });
});
