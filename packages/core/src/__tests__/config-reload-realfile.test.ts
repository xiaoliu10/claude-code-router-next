import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Server from "../server";
import { registerAdminRoutes } from "../ccr/admin-routes";
import { resetActiveProbeService } from "../services/active-probe";
import { closeProxyDispatchers } from "../services/proxy";

// Exercise the REAL safe reader against real files. The mocked-reader suite
// (config-reload-route.test.ts) cannot catch the bootstrap reader's
// process.exit on parse errors or its ENOENT auto-create; this suite points
// CONFIG_FILE at a temp path and asserts the gateway stays alive, the runtime
// stays untouched on failure, and nothing is ever written to disk.
const { state } = vi.hoisted(() => ({ state: { configFile: "" } }));
vi.mock("@wengine-ai/claude-code-router-shared", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@wengine-ai/claude-code-router-shared")>();
  return {
    ...actual,
    get CONFIG_FILE() {
      return state.configFile;
    },
  };
});

let dir = "";
let server: any;

const initialProviders = [
  {
    name: "initial-provider",
    api_base_url: "https://initial.example.com/v1",
    api_key: "test-key",
    models: ["initial-model"],
  },
];

async function buildAdminRuntime(options: Record<string, unknown> = {}) {
  const runtime = new Server({
    logger: false,
    useJsonFile: false,
    initialConfig: {
      providers: initialProviders,
      Router: { default: "initial-provider,initial-model" },
      HOST: "127.0.0.1",
      PORT: 0,
      ACTIVE_PROBE_ENABLED: false,
    },
    ...options,
  });
  await runtime.ready();
  await registerAdminRoutes(runtime, {
    PORT: 0,
    APIKEY: "test-key",
    Providers: initialProviders,
    Router: {},
  });
  await runtime.registerNamespace("/");
  await runtime.app.ready();
  return runtime;
}

function writeConfig(text: string) {
  writeFileSync(state.configFile, text, "utf-8");
}

const validConfig = {
  Providers: [
    {
      name: "reloaded-provider",
      api_base_url: "https://reloaded.example.com/v1",
      api_key: "test-key",
      models: ["reloaded-model"],
    },
  ],
  Router: { default: "reloaded-provider,reloaded-model" },
  HOST: "127.0.0.1",
  PORT: 0,
  ACTIVE_PROBE_ENABLED: false,
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccr-reload-realfile-"));
  state.configFile = join(dir, "config.json");
});

afterEach(async () => {
  if (server) {
    await server.app.close();
    server = undefined;
  }
  resetActiveProbeService();
  await closeProxyDispatchers();
  delete process.env.CCR_RELOAD_TEST_TARGET;
  delete process.env.CCR_RELOAD_TEST_PROXY;
  rmSync(dir, { recursive: true, force: true });
});

describe("POST /api/config/reload with real files", () => {
  it("answers a fixed 500 on a parse error without exiting, writing, or mutating the runtime", async () => {
    server = await buildAdminRuntime();
    const before = server.configService.getAll();
    const broken = '{ "Providers": [oops';
    writeConfig(broken);

    const res = await server.app.inject({ method: "POST", url: "/api/config/reload" });

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ success: false, error: "config file unreadable" });
    expect(readFileSync(state.configFile, "utf-8")).toBe(broken);
    expect(server.configService.getAll()).toEqual(before);
    expect(server.providerService.getProviders().map((p: any) => p.name)).toEqual([
      "initial-provider",
    ]);
  });

  it("answers a fixed 500 on a missing file and never auto-creates one", async () => {
    server = await buildAdminRuntime();
    const before = server.configService.getAll();

    const res = await server.app.inject({ method: "POST", url: "/api/config/reload" });

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ success: false, error: "config file unreadable" });
    expect(existsSync(state.configFile)).toBe(false);
    expect(server.configService.getAll()).toEqual(before);
  });

  it("answers a fixed 500 when the file root is not an object", async () => {
    server = await buildAdminRuntime();
    const before = server.configService.getAll();
    writeConfig('["Providers"]');

    const res = await server.app.inject({ method: "POST", url: "/api/config/reload" });

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ success: false, error: "config file unreadable" });
    expect(server.configService.getAll()).toEqual(before);
  });

  it("hot-applies an interpolated $VAR Router target from disk", async () => {
    server = await buildAdminRuntime();
    process.env.CCR_RELOAD_TEST_TARGET = "reloaded-provider,reloaded-model";
    writeConfig(
      JSON.stringify({ ...validConfig, Router: { default: "$CCR_RELOAD_TEST_TARGET" } })
    );

    const res = await server.app.inject({ method: "POST", url: "/api/config/reload" });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ success: true, restartRequired: [] });
    expect(server.configService.get("Router")).toEqual({
      default: "reloaded-provider,reloaded-model",
    });
    expect(server.providerService.getProviders().map((p: any) => p.name)).toEqual([
      "reloaded-provider",
    ]);
  });

  it("reports a HOST-only file change in restartRequired", async () => {
    server = await buildAdminRuntime();
    writeConfig(JSON.stringify({ ...validConfig, HOST: "0.0.0.0" }));

    const res = await server.app.inject({ method: "POST", url: "/api/config/reload" });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ success: true, restartRequired: ["HOST"] });
  });

  it("overlays interpolated values even when the JSON source replays raw $VAR text", async () => {
    process.env.CCR_RELOAD_TEST_PROXY = "http://127.0.0.1:9";
    writeConfig(
      JSON.stringify({ ...validConfig, PROXY_URL: "$CCR_RELOAD_TEST_PROXY" })
    );
    server = await buildAdminRuntime({ useJsonFile: true, jsonPath: state.configFile });
    // The ConfigService source replays the raw file: the placeholder survives.
    expect(server.configService.get("PROXY_URL")).toBe("$CCR_RELOAD_TEST_PROXY");

    const res = await server.app.inject({ method: "POST", url: "/api/config/reload" });

    expect(res.statusCode).toBe(200);
    // The reload overlay commits the interpolated runtime value.
    expect(server.configService.get("PROXY_URL")).toBe("http://127.0.0.1:9");
  });
});