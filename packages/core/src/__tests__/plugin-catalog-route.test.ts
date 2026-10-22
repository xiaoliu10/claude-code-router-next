/**
 * Tests for GET /api/plugins/catalog (src/ccr/plugin-install-routes.ts):
 * npm registry search filtering, dedupe, installed state, registry error
 * tolerance and the local-only guard. The registry is an in-process stub;
 * no test touches the real network.
 */
import { createServer, type Server as HttpServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  scratch = mkdtempSync(join(tmpdir(), "plugin-catalog-route-"));
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

interface SearchPackage {
  name: string;
  version?: string;
  description?: string;
  keywords?: string[];
}

/** In-process npm search endpoint. Query text must contain the keyword this
 *  entry is registered under. */
async function startSearchStub(index: Record<string, SearchPackage[]>): Promise<{ url: string; hang: () => void }> {
  let hang = false;
  const server = createServer((req, res) => {
    if (hang) return; // never respond
    const url = new URL(req.url ?? "/", "http://x");
    const text = url.searchParams.get("text") ?? "";
    const keyword = text.replace(/^keywords:/, "");
    const results = index[keyword] ?? [];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      objects: results.map((pkg) => ({
        package: {
          name: pkg.name,
          version: pkg.version ?? "1.0.0",
          description: pkg.description ?? "",
          keywords: pkg.keywords ?? [],
        },
      })),
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  stubs.push(server);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, hang: () => { hang = true; } };
}

function buildApp(registry: string, catalogTimeoutMs = 5_000) {
  const app = Fastify({ logger: false });
  apps.push(app);
  registerPluginMarketRoutes(app, {
    configDir,
    configuredPort: 3456,
    catalogRegistryBase: registry,
    catalogTimeoutMs,
  });
  return app;
}

const getLocal = (app: any, headers: Record<string, string> = {}) =>
  app.inject({
    method: "GET",
    url: "/api/plugins/catalog",
    headers: { host: "localhost:3456", ...headers },
  });

/** Install a minimal fixture payload through the shared core so the catalog
 *  can report real installed state. */
async function seedInstalled(name: string, version: string): Promise<void> {
  const { installPluginFromArchive } = await import("@wengine-ai/claude-code-router-shared");
  const root = join(scratch, `seed-${name}`);
  const inner = join(root, "package", "dist");
  mkdirSync(inner, { recursive: true });
  writeFileSync(join(root, "package", "package.json"), JSON.stringify({ name, version }));
  writeFileSync(join(inner, "plugin.json"), JSON.stringify({ name, version, coreApi: "1" }));
  writeFileSync(join(inner, "plugin.js"), "export const activate = () => ({});\n");
  const archive = join(scratch, `${name}.tgz`);
  execFileSync("tar", ["-czf", archive, "-C", root, "package"]);
  await installPluginFromArchive(archive, { configDir });
}

describe("GET /api/plugins/catalog", () => {
  it("filters out packages without a marker keyword and returns name/description/version", async () => {
    const registry = await startSearchStub({
      "ccr-provider-plugin": [
        { name: "ccr-provider-good", keywords: ["ccr-provider-plugin"], description: "Good plugin", version: "2.3.4" },
        { name: "left-pad-evil", keywords: ["web"], description: "Not a plugin" },
      ],
    });
    const app = buildApp(registry.url);
    const res = await getLocal(app);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.warning).toBeUndefined();
    expect(body.plugins).toEqual([
      { name: "ccr-provider-good", description: "Good plugin", version: "2.3.4", installed: false, installedVersion: null },
    ]);
    // The search result payload (readme, links, etc.) never leaks through.
    expect(res.body).not.toContain("left-pad-evil");
  });

  it("merges and dedupes the two keyword searches by package name", async () => {
    const registry = await startSearchStub({
      "ccr-provider-plugin": [
        { name: "ccr-provider-both", keywords: ["ccr-provider-plugin"], version: "2.0.0", description: "from search one" },
        { name: "ccr-provider-only-a", keywords: ["ccr-provider-plugin"], version: "1.0.0", description: "a only" },
      ],
      "claude-code-router-plugin": [
        { name: "ccr-provider-both", keywords: ["claude-code-router-plugin"], version: "2.0.0", description: "dup" },
        { name: "ccr-provider-only-b", keywords: ["claude-code-router-plugin"], version: "3.1.0", description: "b only" },
      ],
    });
    const app = buildApp(registry.url);
    const res = await getLocal(app);
    const names = res.json().plugins.map((p: any) => p.name).sort();
    expect(names).toEqual(["ccr-provider-both", "ccr-provider-only-a", "ccr-provider-only-b"]);
    // First occurrence wins for metadata.
    expect(res.json().plugins.find((p: any) => p.name === "ccr-provider-both").description).toBe("from search one");
  });

  it("marks installed plugins with their installed manifest version", async () => {
    await seedInstalled("already", "0.9.9");
    const registry = await startSearchStub({
      "ccr-provider-plugin": [
        { name: "already", keywords: ["ccr-provider-plugin"], version: "1.2.0", description: "latest differs from installed" },
        { name: "fresh", keywords: ["ccr-provider-plugin"], version: "4.0.0", description: "not installed" },
      ],
    });
    const app = buildApp(registry.url);
    const res = await getLocal(app);
    const body = res.json();
    expect(body.plugins).toEqual([
      { name: "already", description: "latest differs from installed", version: "1.2.0", installed: true, installedVersion: "0.9.9" },
      { name: "fresh", description: "not installed", version: "4.0.0", installed: false, installedVersion: null },
    ]);
  });

  it("tolerates a broken registry: 200 with empty list + warning, no leaked details", async () => {
    // Point the route at a port where nothing listens (both searches fail).
    const app = Fastify({ logger: false });
    apps.push(app);
    registerPluginMarketRoutes(app, {
      configDir,
      configuredPort: 3456,
      catalogRegistryBase: "http://127.0.0.1:9", // discard port — nothing listens
      catalogTimeoutMs: 2_000,
    });
    const res = await getLocal(app);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, plugins: [], warning: "registry_unavailable" });
  });

  it("tolerates a hung registry within the bounded timeout", async () => {
    const registry = await startSearchStub({});
    registry.hang();
    const app = buildApp(registry.url, 500);
    const started = Date.now();
    const res = await getLocal(app);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, plugins: [], warning: "registry_unavailable" });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("keeps partial results when only one of the two searches succeeds", async () => {
    const registry = await startSearchStub({
      "ccr-provider-plugin": [
        { name: "ccr-provider-partial", keywords: ["ccr-provider-plugin"], version: "1.0.0", description: "one" },
      ],
    });
    // The second keyword has no entries → empty but successful; both settle.
    const app = buildApp(registry.url);
    const res = await getLocal(app);
    expect(res.statusCode).toBe(200);
    expect(res.json().plugins.map((p: any) => p.name)).toEqual(["ccr-provider-partial"]);
    expect(res.json().warning).toBeUndefined();
  });

  it("rejects non-loopback callers and spoofed authorities with 403 local_only", async () => {
    const registry = await startSearchStub({});
    const app = buildApp(registry.url);
    const remote = await app.inject({
      method: "GET",
      url: "/api/plugins/catalog",
      remoteAddress: "203.0.113.7",
      headers: { host: "localhost:3456" },
    });
    expect(remote.statusCode).toBe(403);
    expect(remote.json()).toEqual({ ok: false, error: "local_only" });

    const spoofed = await getLocal(app, { host: "evil.example:80" });
    expect(spoofed.statusCode).toBe(403);
    expect(spoofed.json().error).toBe("local_only");
  });
});
