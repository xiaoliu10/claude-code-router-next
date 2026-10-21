/** Core-level acceptance via the actual npm artifact and real composition root.
 * No source activation or runtime mocks: pack → install dist layout → real
 * createCcrServer/loader → inference (pool rotation), admin and authenticated
 * card; restart disabled/removed → fail closed with persisted state untouched.
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { createCcrServer } from "../../../core/src/ccr/create-server";
import { getHealthStore } from "../../../core/src/services/provider-health";
import { resetActiveProbeService } from "../../../core/src/services/active-probe";
import { closeProxyDispatchers } from "../../../core/src/services/proxy";
import { HOME_DIR, CONFIG_FILE } from "../../../shared/dist/index.js";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(pkg, "../../..");
const require = createRequire(import.meta.url);
const servers: Array<Awaited<ReturnType<typeof createCcrServer>>> = [];
const scratch: string[] = [];
const key = "fixture-admin-key";
const chat = "https://copilot.tencent.com/v2/chat/completions";
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.app.close();
    server.tokenizerService.dispose();
  }
  resetActiveProbeService(); getHealthStore().clear();
  await closeProxyDispatchers();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("npm tarball + real createCcrServer: rotation/admin/card, then disabled and removed fail closed without state loss", async () => {
  // Pin both sides of the integration to THIS worktree, not the main checkout
  // or a globally installed build. The shared package's workspace symlink must
  // resolve to its local built artifact (the real factory imports it too).
  expect(realpathSync(require.resolve("../../../core/src/ccr/create-server.ts")))
    .toBe(join(root, "packages/core/src/ccr/create-server.ts"));
  const coreRequire = createRequire(join(root, "packages/core/package.json"));
  expect(realpathSync(coreRequire.resolve("@wengine-ai/claude-code-router-shared")))
    .toBe(join(root, "packages/shared/dist/index.js"));
  expect(realpathSync(require.resolve("../../../shared/dist/index.js")))
    .toBe(join(root, "packages/shared/dist/index.js"));
  expect(HOME_DIR).toBe(process.env.CCR_CONFIG_DIR);
  expect(HOME_DIR).toContain("ccr-workbuddy-plugin-test-home");
  expect(HOME_DIR).toBe(process.env.HOME);

  const temp = mkdtempSync(join(tmpdir(), "workbuddy-pack-")); scratch.push(temp);
  execFileSync("pnpm", ["--filter", "@wengine-ai/ccr-provider-workbuddy", "build"], { cwd: root, stdio: "pipe", env: { ...process.env, CI: "true" } });
  const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", temp], { cwd: pkg, encoding: "utf8" }));
  const archive = join(temp, packed[0].filename);
  const contents = packed[0].files.map((f: { path: string }) => f.path);
  for (const file of ["dist/plugin.js", "dist/plugin.json", "dist/card.js", "dist/package.json", "dist/THIRD_PARTY_NOTICES.md"]) expect(contents).toContain(file);
  expect(contents.some((p: string) => /(?:core\/src|src\/|node_modules\/)/.test(p))).toBe(false);
  const installed = join(temp, "installed"); mkdirSync(installed);
  // Offline npm installation proves this is a self-contained package, not a
  // workspace-link fixture. No lifecycle scripts or registry access required.
  execFileSync("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", installed, archive], { encoding: "utf8" });
  const pluginDir = join(HOME_DIR, "plugins/workbuddy");
  mkdirSync(dirname(pluginDir), { recursive: true });
  cpSync(join(installed, "node_modules/@wengine-ai/ccr-provider-workbuddy/dist"), pluginDir, { recursive: true });
  const manifestPath = join(HOME_DIR, "plugins/plugins.json");
  writeFileSync(manifestPath, JSON.stringify([{ name: "workbuddy", enabled: true }]));

  const credentialPath = join(HOME_DIR, "workbuddy-credentials.json");
  const account = (uid: string) => ({ version: 1, kind: "workbuddy", uid, displayName: uid, domain: "", enterpriseId: "", accessToken: `fixture-token-${uid}`, tokenType: "", expiresAt: 0, source: "desktop", importedAt: "2026-10-19T00:00:00.000Z" });
  writeFileSync(credentialPath, JSON.stringify({ version: 2, sites: { workbuddy: {
    activeUid: "b", accounts: [account("a"), account("b")], hiddenModels: [], discoveredModels: ["m"],
  } } }), { mode: 0o600 });
  const config = { HOST: "127.0.0.1", PORT: 0, APIKEY: key, LOG: false, ACTIVE_PROBE_ENABLED: false,
    CCR_SELF_PROVIDER_DELETED: true,
    Providers: [{ name: "workbuddy", api_base_url: "https://hostile.invalid/turn", api_key: "ccr-managed-workbuddy", ccr_managed: true, workbuddy_kind: "workbuddy", models: ["m"], transformer: { use: ["workbuddy"] } }],
    Router: { default: "workbuddy,m", enableFallback: false } };
  writeFileSync(CONFIG_FILE, JSON.stringify(config));
  const boot = async () => {
    const server = await createCcrServer({ port: 0, logger: false }); servers.push(server);
    await server.registerNamespace("/"); await server.app.ready();
    // A genuine loopback socket/ephemeral port exercises the plugin guard's
    // live-port branch; inject requests still exercise remote auth/IP cases.
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    return server;
  };
  const send = (server: Awaited<ReturnType<typeof boot>>) => server.app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model: "workbuddy,m", stream: false, messages: [{ role: "user", content: "hi" }] } });
  let upstreamCalls = 0;
  const fetch = vi.fn(async (url: any, init: any) => {
    upstreamCalls++;
    expect(String(url)).toBe(chat); expect(init.redirect).toBe("error"); expect(init.dispatcher).toBeDefined();
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe(`Bearer fixture-token-${upstreamCalls === 1 ? "b" : "a"}`);
    expect(JSON.stringify(init.headers)).not.toContain("ccr-managed-");
    if (upstreamCalls === 1) return new Response(JSON.stringify({ code: 6004, msg: "private-upstream-marker" }), { status: 429, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "tarball healthy" }, finish_reason: "stop", index: 0 }] }), { headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetch);
  let server = await boot();
  expect(server.pluginRegistry.listLoadedPlugins().map(p => p.name)).toEqual(["workbuddy"]);
  const response = await send(server);
  expect(response.statusCode).toBe(200); expect(response.body).toContain("tarball healthy"); expect(fetch).toHaveBeenCalledTimes(2);
  expect(response.body).not.toMatch(/fixture-token|private-upstream-marker|ccr-managed-/);
  const stored = JSON.parse(readFileSync(credentialPath, "utf8"));
  expect(stored.sites.workbuddy.accounts.find((a: any) => a.uid === "b").modelCooldowns.m.code).toBe(6004);

  const address: any = server.app.server.address();
  const authority = `127.0.0.1:${address.port}`;
  const status = await server.app.inject({ url: "/api/workbuddy/status", headers: { host: authority, origin: `http://${authority}` } });
  expect(status.statusCode).toBe(200); expect(status.body).toContain("connected"); expect(status.body).not.toContain("fixture-token");
  const forbidden = await server.app.inject({ url: "/api/workbuddy/status", remoteAddress: "203.0.113.8", headers: { "x-api-key": key, origin: `http://${authority}`, host: authority } });
  expect(forbidden.statusCode).toBe(403);
  expect((await server.app.inject({ url: "/api/workbuddy/status", headers: { host: authority, origin: "https://evil.invalid" } })).statusCode).toBe(403);
  const cardPath = "/plugins/workbuddy/card.js";
  expect((await server.app.inject({ url: cardPath, remoteAddress: "203.0.113.8" })).statusCode).toBe(401);
  const card = await server.app.inject({ url: cardPath, remoteAddress: "203.0.113.8", headers: { "x-api-key": key } });
  expect(card.statusCode).toBe(200); expect(card.body).toBe(readFileSync(join(pluginDir, "card.js"), "utf8"));
  const plugins = await server.app.inject({ url: "/api/plugins" });
  expect(plugins.json().plugins[0]).toMatchObject({ name: "workbuddy", enabled: true, cardUrl: cardPath });
  expect(plugins.json().plugins[0].locales.en.workbuddy.browser_login).toBeTruthy();
  expect(fetch).toHaveBeenCalledTimes(2); // all management/card reads were local
  await server.app.close(); server.tokenizerService.dispose(); servers.pop();
  resetActiveProbeService(); getHealthStore().clear();

  // Snapshot AFTER the legitimate inference cooldown booking; restart must not
  // mutate even one byte of config, Router, or credentials in either mode.
  const savedConfig = readFileSync(CONFIG_FILE, "utf8");
  const savedCredentials = readFileSync(credentialPath, "utf8");
  for (const mode of ["disabled", "removed"]) {
    if (mode === "disabled") writeFileSync(manifestPath, JSON.stringify([{ name: "workbuddy", enabled: false }]));
    else { rmSync(pluginDir, { recursive: true }); expect(existsSync(credentialPath)).toBe(true); }
    fetch.mockClear();
    server = await boot();
    expect(server.pluginRegistry.listLoadedPlugins()).toEqual([]);
    const missing = await send(server);
    expect(missing.statusCode).toBe(503); expect(missing.body).toContain("plugin_missing"); expect(fetch).not.toHaveBeenCalled();
    expect((await server.app.inject({ url: "/api/workbuddy/status" })).statusCode).toBe(404);
    expect((await server.app.inject({ url: cardPath, remoteAddress: "203.0.113.8", headers: { "x-api-key": key } })).statusCode).toBe(404);
    expect(readFileSync(CONFIG_FILE, "utf8")).toBe(savedConfig);
    expect(readFileSync(credentialPath, "utf8")).toBe(savedCredentials);
    expect(JSON.parse(savedConfig).Router).toEqual(config.Router);
    await server.app.close(); server.tokenizerService.dispose(); servers.pop();
    resetActiveProbeService(); getHealthStore().clear();
  }
}, 120_000);
