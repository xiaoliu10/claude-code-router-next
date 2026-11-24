import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Server from "../server";
import { registerAdminRoutes } from "../ccr/admin-routes";
import { resetActiveProbeService } from "../services/active-probe";
import { closeProxyDispatchers } from "../services/proxy";

const { readConfigFileMock, writeConfigFileMock, backupConfigFileMock } = vi.hoisted(() => ({
  readConfigFileMock: vi.fn(),
  writeConfigFileMock: vi.fn(),
  backupConfigFileMock: vi.fn(),
}));

// POST /api/config/reload reads ~/.claude-code-router/config.json through the
// interpolated request-path reader. Keep this suite hermetic: the read result
// is controlled per test, and the persistence spies prove the route never
// writes to (or rotates backups of) a developer's real configuration.
vi.mock("../ccr/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ccr/config")>();
  return {
    ...actual,
    backupConfigFile: backupConfigFileMock,
    readConfigFile: readConfigFileMock,
    writeConfigFile: writeConfigFileMock,
  };
});

const initialProviders = [
  {
    name: "initial-provider",
    api_base_url: "https://initial.example.com/v1",
    api_key: "test-key",
    models: ["initial-model"],
  },
];

async function buildAdminRuntime() {
  const server = new Server({
    logger: false,
    useJsonFile: false,
    initialConfig: {
      providers: initialProviders,
      Router: { default: "initial-provider,initial-model" },
      HOST: "127.0.0.1",
      PORT: 0,
      ACTIVE_PROBE_ENABLED: false,
    },
  });
  await server.ready();
  await registerAdminRoutes(server, {
    PORT: 0,
    APIKEY: "test-key",
    Providers: initialProviders,
    Router: {},
  });
  await server.registerNamespace("/");
  await server.app.ready();
  return server;
}

// A freshly read config that only changes provider + Router entries; the
// listener settings match the runtime so no restart is required.
function reloadedConfig(overrides: Record<string, unknown> = {}) {
  return {
    Providers: [
      {
        name: "reloaded-provider",
        api_base_url: "https://api.example.com/v1",
        api_key: "test-key",
        models: ["reloaded-model"],
      },
    ],
    Router: { default: "reloaded-provider,reloaded-model" },
    HOST: "127.0.0.1",
    PORT: 0,
    ACTIVE_PROBE_ENABLED: false,
    ...overrides,
  };
}

describe("POST /api/config/reload", () => {
  let server: Server | undefined;

  beforeEach(() => {
    writeConfigFileMock.mockResolvedValue(undefined);
    backupConfigFileMock.mockResolvedValue(null);
  });

  afterEach(async () => {
    readConfigFileMock.mockReset();
    writeConfigFileMock.mockReset();
    backupConfigFileMock.mockReset();
    resetActiveProbeService();
    await closeProxyDispatchers();
    if (server) {
      await server.app.close();
      server = undefined;
    }
  });

  it("hot-applies provider and Router changes from the config file", async () => {
    server = await buildAdminRuntime();
    const newConfig = reloadedConfig();
    readConfigFileMock.mockResolvedValue(newConfig);

    const res = await server.app.inject({ method: "POST", url: "/api/config/reload" });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ success: true, restartRequired: [] });
    expect(server.configService.get("Router")).toEqual(newConfig.Router);
    expect(server.providerService.getProviders().map((p) => p.name)).toEqual([
      "reloaded-provider",
    ]);
  });

  it("never writes or backs up the config file", async () => {
    server = await buildAdminRuntime();
    readConfigFileMock.mockResolvedValue(reloadedConfig());

    const res = await server.app.inject({ method: "POST", url: "/api/config/reload" });

    expect(res.statusCode).toBe(200);
    expect(writeConfigFileMock).not.toHaveBeenCalled();
    expect(backupConfigFileMock).not.toHaveBeenCalled();
  });

  it("reports a PORT change in restartRequired", async () => {
    server = await buildAdminRuntime();
    readConfigFileMock.mockResolvedValue(reloadedConfig({ PORT: 4567 }));

    const res = await server.app.inject({ method: "POST", url: "/api/config/reload" });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ success: true, restartRequired: ["PORT"] });
  });

  it("answers a fixed 500 and leaves the runtime untouched when the read fails", async () => {
    server = await buildAdminRuntime();
    const before = server.configService.getAll();
    readConfigFileMock.mockRejectedValue(new Error("secret parse detail"));

    const res = await server.app.inject({ method: "POST", url: "/api/config/reload" });

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ success: false, error: "config file unreadable" });
    expect(res.body).not.toContain("secret parse detail");
    expect(server.configService.getAll()).toEqual(before);
    expect(server.providerService.getProviders().map((p) => p.name)).toEqual([
      "initial-provider",
    ]);
    expect(writeConfigFileMock).not.toHaveBeenCalled();
    expect(backupConfigFileMock).not.toHaveBeenCalled();
  });

  it("answers a fixed 500 when the read result is not a plain object", async () => {
    server = await buildAdminRuntime();
    const before = server.configService.getAll();

    for (const invalid of ["not-an-object", null, ["Providers"]]) {
      readConfigFileMock.mockResolvedValue(invalid);

      const res = await server.app.inject({ method: "POST", url: "/api/config/reload" });

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body)).toEqual({ success: false, error: "config file invalid" });
      expect(server.configService.getAll()).toEqual(before);
    }
  });
});