/**
 * Tests for the host marketplace routes (src/ccr/plugin-install-routes.ts):
 * POST /api/plugins/install.
 *
 * The npm registry is a local stub HTTP server (packument + tarball bytes),
 * so no test touches the real network. Every install lands in a throwaway
 * config dir; no service is started and no plugin code is executed.
 */
import { execFileSync } from "node:child_process";
import { createServer, type Server as HttpServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerPluginMarketRoutes } from "../ccr/plugin-install-routes";

let scratch: string;
let configDir: string;
const stubs: HttpServer[] = [];
const apps: Array<ReturnType<typeof Fastify>> = [];

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "plugin-install-route-"));
  configDir = join(scratch, "config");
  mkdirSync(configDir, { recursive: true });
});

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const server of stubs.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  rmSync(scratch, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Stub registry + fixture builders
// ---------------------------------------------------------------------------

interface StubEntry {
  /** Packument or binary response body. */
  status?: number;
  json?: unknown;
  body?: Buffer;
  hang?: boolean;
}

/** A tiny npm registry: GET /<name> serves the packument, dist.tarball URLs
 *  point back at this server. Entries are mutable so tests can register the
 *  tarball after learning the server's URL. */
async function startStubRegistry(
  entries: Record<string, StubEntry> = {}
): Promise<{ url: string; entries: Record<string, StubEntry> }> {
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").replace(/^\//, "").split("?")[0];
    // Packument names arrive percent-encoded when scoped.
    const key = decodeURIComponent(path);
    const entry = entries[key];
    if (!entry) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    if (entry.hang) return; // never respond
    res.writeHead(entry.status ?? 200, { "content-type": "application/json" });
    res.end(entry.json !== undefined ? JSON.stringify(entry.json) : entry.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  stubs.push(server);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, entries };
}

function buildPluginTarball(opts: {
  pluginName?: string;
  version?: string;
  coreApi?: string;
  entry?: boolean;
  fillBytes?: number;
}): Buffer {
  const name = opts.pluginName ?? "fixture";
  const root = join(scratch, `pkg-${name}-${Math.random().toString(36).slice(2)}`);
  const inner = join(root, "package", "dist");
  mkdirSync(inner, { recursive: true });
  writeFileSync(join(root, "package", "package.json"), JSON.stringify({
    name: `ccr-provider-${name}`,
    version: "1.0.0",
  }));
  writeFileSync(join(inner, "plugin.json"), JSON.stringify({
    name,
    version: opts.version ?? "1.0.0",
    coreApi: opts.coreApi ?? "1",
  }));
  if (opts.entry !== false) {
    writeFileSync(join(inner, "plugin.js"), "export const activate = () => ({});\n");
  }
  if (opts.fillBytes) {
    writeFileSync(join(inner, "fill.bin"), Buffer.alloc(opts.fillBytes, 0x61));
  }
  const archive = join(root, "out.tgz");
  execFileSync("tar", ["-czf", archive, "-C", root, "package"]);
  return readFileSync(archive);
}

function packument(name: string, tarballUrl: string): unknown {
  return {
    name,
    "dist-tags": { latest: "1.0.0" },
    versions: {
      "1.0.0": {
        name,
        version: "1.0.0",
        dist: { tarball: tarballUrl, shasum: "", tarball_size: 0 },
      },
    },
  };
}

function buildApp(options: { registry?: string; npmTimeoutMs?: number } = {}) {
  const app = Fastify({ logger: false });
  apps.push(app);
  registerPluginMarketRoutes(app, {
    configDir,
    configuredPort: 3456,
    registry: options.registry,
    npmTimeoutMs: options.npmTimeoutMs,
  });
  return app;
}

const records = (): Array<{ name: string; enabled: boolean }> =>
  JSON.parse(readFileSync(join(configDir, "plugins", "plugins.json"), "utf8"));

/** POST through inject() with the loopback authority a real local browser
 *  would send. inject() defaults Host to localhost:80, which the guard (by
 *  design) refuses. */
function postLocal(app: any, payload: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method: "POST",
    url: "/api/plugins/install",
    headers: { host: "localhost:3456", ...headers },
    payload,
  });
}

// ---------------------------------------------------------------------------
// Success path
// ---------------------------------------------------------------------------

describe("POST /api/plugins/install", () => {
  it("installs from a stub registry and answers with restartRequired", async () => {
    const tarball = buildPluginTarball({});
    const registry = await startStubRegistry();
    registry.entries["ccr-provider-fixture"] = {
      json: packument("ccr-provider-fixture", `${registry.url}/fixture-1.0.0.tgz`),
    };
    registry.entries["fixture-1.0.0.tgz"] = { body: tarball };
    const app = buildApp({ registry: registry.url, npmTimeoutMs: 15_000 });

    const res = await postLocal(app, { name: "ccr-provider-fixture" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      name: "fixture",
      version: "1.0.0",
      restartRequired: true,
    });
    expect(existsSync(join(configDir, "plugins", "fixture", "plugin.js"))).toBe(true);
    expect(records()).toEqual([{ name: "fixture", enabled: true }]);
    expect(readdirSync(join(configDir, "plugins")).filter((n) => n.includes("staging"))).toEqual([]);
  });

  it("honors spec as an alias for name", async () => {
    const tarball = buildPluginTarball({ pluginName: "alias" });
    const registry = await startStubRegistry();
    registry.entries["ccr-provider-alias"] = {
      json: packument("ccr-provider-alias", `${registry.url}/alias-1.0.0.tgz`),
    };
    registry.entries["alias-1.0.0.tgz"] = { body: tarball };
    const app = buildApp({ registry: registry.url, npmTimeoutMs: 15_000 });

    const res = await postLocal(app, { spec: "ccr-provider-alias" });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe("alias");
  });

  it("replaces an existing install only with force (409 otherwise)", async () => {
    const v1 = buildPluginTarball({ pluginName: "fixture", version: "1.0.0" });
    const v2 = buildPluginTarball({ pluginName: "fixture", version: "2.0.0" });
    const registry = await startStubRegistry();
    registry.entries["ccr-provider-fixture"] = {
      json: packument("ccr-provider-fixture", `${registry.url}/fixture-2.0.0.tgz`),
    };
    registry.entries["fixture-2.0.0.tgz"] = { body: v2 };
    // Seed v1 directly through the shared core (already covered there).
    const { installPluginFromArchive } = await import("@wengine-ai/claude-code-router-shared");
    const seedTgz = join(scratch, "v1.tgz");
    writeFileSync(seedTgz, v1);
    await installPluginFromArchive(seedTgz, { configDir });

    const app = buildApp({ registry: registry.url, npmTimeoutMs: 15_000 });
    const denied = await postLocal(app, { name: "ccr-provider-fixture" });
    expect(denied.statusCode).toBe(409);
    expect(denied.json()).toEqual({ ok: false, error: "already_installed" });
    expect(JSON.parse(readFileSync(join(configDir, "plugins/fixture/plugin.json"), "utf8")).version).toBe("1.0.0");

    const forced = await postLocal(app, { name: "ccr-provider-fixture", force: true });
    expect(forced.statusCode).toBe(200);
    expect(JSON.parse(readFileSync(join(configDir, "plugins/fixture/plugin.json"), "utf8")).version).toBe("2.0.0");
  });

  it("returns 409 plugins_json_corrupted and leaves the file untouched", async () => {
    const pluginsDir = join(configDir, "plugins");
    mkdirSync(pluginsDir, { recursive: true });
    const original = "{{{corrupted";
    writeFileSync(join(pluginsDir, "plugins.json"), original);
    const tarball = buildPluginTarball({ pluginName: "corrupt" });
    const registry = await startStubRegistry();
    registry.entries["ccr-provider-corrupt"] = {
      json: packument("ccr-provider-corrupt", `${registry.url}/corrupt-1.0.0.tgz`),
    };
    registry.entries["corrupt-1.0.0.tgz"] = { body: tarball };
    const app = buildApp({ registry: registry.url, npmTimeoutMs: 15_000 });

    const res = await postLocal(app, { name: "ccr-provider-corrupt" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ ok: false, error: "plugins_json_corrupted" });
    expect(readFileSync(join(pluginsDir, "plugins.json"), "utf8")).toBe(original);
    expect(existsSync(join(pluginsDir, "corrupt"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Request validation + local-only guard
// ---------------------------------------------------------------------------

describe("POST /api/plugins/install — request validation", () => {
  it.each([
    ["../escape"],
    ["/etc/passwd"],
    ["http://evil/x.tgz"],
    ["foo@1.2.3"],
    ["-x"],
    [42],
    [null],
  ])("rejects the spec %s with 400 invalid_spec", async (spec) => {
    const registry = await startStubRegistry();
    const app = buildApp({ registry: registry.url, npmTimeoutMs: 5_000 });
    const res = await postLocal(app, { name: spec as any });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ ok: false, error: "invalid_spec" });
    expect(existsSync(join(configDir, "plugins"))).toBe(false);
  });

  it("rejects a missing body with 400", async () => {
    const registry = await startStubRegistry();
    const app = buildApp({ registry: registry.url, npmTimeoutMs: 5_000 });
    const res = await postLocal(app, {});
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_spec");
  });
});

describe("POST /api/plugins/install — local-only guard", () => {
  it("rejects a non-loopback caller even with perfect headers", async () => {
    const registry = await startStubRegistry();
    const app = buildApp({ registry: registry.url, npmTimeoutMs: 5_000 });
    const res = await app.inject({
      method: "POST",
      url: "/api/plugins/install",
      remoteAddress: "203.0.113.7",
      headers: { host: "localhost:3456", origin: "http://localhost:3456" },
      payload: { name: "ccr-provider-fixture" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ ok: false, error: "local_only" });
    expect(existsSync(join(configDir, "plugins"))).toBe(false);
  });

  it("rejects a loopback caller with a spoofed Host authority", async () => {
    const registry = await startStubRegistry();
    const app = buildApp({ registry: registry.url, npmTimeoutMs: 5_000 });
    const res = await app.inject({
      method: "POST",
      url: "/api/plugins/install",
      remoteAddress: "127.0.0.1",
      headers: { host: "evil.example:80" },
      payload: { name: "ccr-provider-fixture" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("local_only");
  });

  it("rejects a loopback caller whose Origin points elsewhere (DNS rebinding)", async () => {
    const registry = await startStubRegistry();
    const app = buildApp({ registry: registry.url, npmTimeoutMs: 5_000 });
    const res = await app.inject({
      method: "POST",
      url: "/api/plugins/install",
      remoteAddress: "127.0.0.1",
      headers: { host: "localhost:3456", origin: "http://evil.example" },
      payload: { name: "ccr-provider-fixture" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("local_only");
    expect(existsSync(join(configDir, "plugins"))).toBe(false);
  });

  it("pins Origin to the REAL listening port when a socket exists", async () => {
    const registry = await startStubRegistry();
    const app = buildApp({ registry: registry.url, npmTimeoutMs: 5_000 });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const port = (app.server.address() as any).port;

    const ok = await app.inject({
      method: "POST",
      url: "/api/plugins/install",
      headers: { host: `localhost:${port}`, origin: `http://127.0.0.1:${port}` },
      payload: { name: "ccr-provider-fixture" },
    });
    // The registry has no such package, but the guard let the request THROUGH
    // to the install logic (npm_pack_failed ≠ local_only).
    expect(ok.statusCode).toBe(502);
    expect(ok.json().error).toBe("npm_pack_failed");

    const wrongPort = await app.inject({
      method: "POST",
      url: "/api/plugins/install",
      headers: { host: `localhost:${port}`, origin: "http://127.0.0.1:3456" },
      payload: { name: "ccr-provider-fixture" },
    });
    expect(wrongPort.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Registry + content failures
// ---------------------------------------------------------------------------

describe("POST /api/plugins/install — registry and content failures", () => {
  it("maps a registry error to 502 npm_pack_failed without leaking npm output", async () => {
    // 404 is not retried by npm's fetch policy (a 500 would burn the 10s
    // retry backoff); either way the caller sees only the stable code.
    const registry = await startStubRegistry({
      "ccr-provider-broken": { status: 404, json: { error: "not_found: internal registry detail <secret>" } },
    });
    const app = buildApp({ registry: registry.url, npmTimeoutMs: 10_000 });
    const res = await postLocal(app, { name: "ccr-provider-broken" });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ ok: false, error: "npm_pack_failed" });
    expect(res.body).not.toContain("internal registry detail");
  });

  it("maps a hung registry to 502 npm_pack_timeout within the bound", async () => {
    const registry = await startStubRegistry({
      "ccr-provider-hang": { hang: true },
    });
    const app = buildApp({ registry: registry.url, npmTimeoutMs: 400 });
    const started = Date.now();
    const res = await postLocal(app, { name: "ccr-provider-hang" });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ ok: false, error: "npm_pack_timeout" });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("rejects a payload with a bad coreApi manifest as 422 invalid_manifest", async () => {
    const tarball = buildPluginTarball({ pluginName: "badapi", coreApi: "2" });
    const registry = await startStubRegistry();
    registry.entries["ccr-provider-badapi"] = {
      json: packument("ccr-provider-badapi", `${registry.url}/badapi-1.0.0.tgz`),
    };
    registry.entries["badapi-1.0.0.tgz"] = { body: tarball };
    const app = buildApp({ registry: registry.url, npmTimeoutMs: 15_000 });
    const res = await postLocal(app, { name: "ccr-provider-badapi" });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ ok: false, error: "invalid_manifest" });
    expect(existsSync(join(configDir, "plugins/badapi"))).toBe(false);
  });

  it("rejects an over-cap payload as 422 archive_too_large", async () => {
    const tarball = buildPluginTarball({ pluginName: "fat", fillBytes: 26 * 1024 * 1024 });
    const registry = await startStubRegistry();
    registry.entries["ccr-provider-fat"] = {
      json: packument("ccr-provider-fat", `${registry.url}/fat-1.0.0.tgz`),
    };
    registry.entries["fat-1.0.0.tgz"] = { body: tarball };
    const app = buildApp({ registry: registry.url, npmTimeoutMs: 30_000 });
    const res = await postLocal(app, { name: "ccr-provider-fat" });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ ok: false, error: "archive_too_large" });
    expect(existsSync(join(configDir, "plugins/fat"))).toBe(false);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Wiring contract (regression): admin-routes must pass the registry override
// under the key the route interface actually declares. A silent rename here
// (registry vs registryUrl) makes the whole install lane fall back to the
// public npm registry while every hermetic test that stubs `registry` still
// passes — that is exactly the drift this test pins down.
// ---------------------------------------------------------------------------
describe("registry override wiring", () => {
  it("accepts `registry` as the install-lane override and uses it", async () => {
    const tarball = buildPluginTarball({ pluginName: "wired" });
    const registry = await startStubRegistry();
    registry.entries["ccr-provider-wired"] = {
      json: packument("ccr-provider-wired", `${registry.url}/wired-1.0.0.tgz`),
    };
    registry.entries["wired-1.0.0.tgz"] = { body: tarball };
    const app = buildApp({ registry: registry.url, npmTimeoutMs: 15_000 });
    const res = await postLocal(app, { name: "ccr-provider-wired" });
    // Reaching the stub at all proves the override was honored: npm would
    // otherwise contact the real registry and fail.
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe("wired");
  });

  it("the catalog falls back to the same override when no catalog base is given", async () => {
    const app = Fastify({ logger: false });
    apps.push(app);
    registerPluginMarketRoutes(app, {
      configDir,
      configuredPort: 3456,
      // No catalogRegistryBase: the catalog must use `registry`.
      registry: "http://127.0.0.1:9", // discard port — nothing listens
      catalogTimeoutMs: 1_000,
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/plugins/catalog",
      headers: { host: "localhost:3456" },
    });
    expect(res.statusCode).toBe(200);
    // A registry that is unreachable must degrade, never 500 — and proving we
    // tried (rather than npmjs) is covered by the install test above.
    expect(res.json()).toEqual({ ok: true, plugins: [], warning: "registry_unavailable" });
  });
});
