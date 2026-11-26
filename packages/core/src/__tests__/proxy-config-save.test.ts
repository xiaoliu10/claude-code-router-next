import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getClaudeProjectId,
  getClaudeSettingsLocalPath,
  getProjectConfigDir,
  setCcrTakeover,
  writeProjectConfig,
} from "@wengine-ai/claude-code-router-shared";
import Server from "../server";
import { registerAdminRoutes } from "../ccr/admin-routes";
import { sessionUsageCache } from "../utils/cache";
import { closeProxyDispatchers } from "../services/proxy";

const { readConfigFileMock } = vi.hoisted(() => ({
  readConfigFileMock: vi.fn(),
}));

// POST /api/config normally persists to ~/.claude-code-router/config.json.
// Keep this route test hermetic so accepted payloads can never overwrite a
// developer's real configuration or rotate its backups.
vi.mock("../ccr/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ccr/config")>();
  return {
    ...actual,
    backupConfigFile: vi.fn().mockResolvedValue(null),
    readConfigFile: readConfigFileMock,
    readConfigFileRaw: vi.fn().mockResolvedValue(null),
    writeConfigFile: vi.fn().mockResolvedValue(undefined),
  };
});

// Verifies the POST /api/config proxy-URL validation gate: an invalid proxy
// URL must yield HTTP 400 *before* any backup/write is attempted, regardless
// of which compatibility key (PROXY_URL, HTTPS_PROXY, https_proxy, httpsProxy)
// carries the bad value. Config persistence is mocked because this suite also
// verifies accepted values, which proceed through the save path.
async function buildAdminRuntime() {
  const config = {
    PORT: 0,
    APIKEY: "secret",
    Providers: [],
    Router: {},
  };

  const server = new Server({
    logger: false,
    useJsonFile: false,
    initialConfig: {
      providers: config.Providers,
      Router: config.Router,
      ACTIVE_PROBE_ENABLED: false,
      HOST: "127.0.0.1",
      PORT: 0,
    },
  });
  await server.ready();
  await registerAdminRoutes(server, config);
  await server.registerNamespace("/");
  await server.app.ready();
  return { server, config };
}

describe("POST /api/config proxy URL validation", () => {
  let server: Server;
  const projectPaths: string[] = [];

  afterEach(async () => {
    sessionUsageCache.delete("claude-code:session:proxy-config-save");
    readConfigFileMock.mockReset();
    for (const projectPath of projectPaths.splice(0)) {
      rmSync(getProjectConfigDir(projectPath), { recursive: true, force: true });
      rmSync(projectPath, { recursive: true, force: true });
    }
    await closeProxyDispatchers();
    if (server) {
      await server.app.close();
    }
  });

  it("rejects an unsupported protocol with 400 and surfaces the key", async () => {
    ({ server } = await buildAdminRuntime());

    const res = await server.app.inject({
      method: "POST",
      url: "/api/config",
      payload: {
        Providers: [],
        Router: {},
        PROXY_URL: "socks5://localhost:1080",
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.proxyErrors).toEqual([
      { key: "PROXY_URL", error: expect.stringContaining("socks5:") },
    ]);
  });

  it("rejects a malformed HTTPS_PROXY compatibility key", async () => {
    ({ server } = await buildAdminRuntime());

    const res = await server.app.inject({
      method: "POST",
      url: "/api/config",
      payload: {
        Providers: [],
        Router: {},
        HTTPS_PROXY: "not a url",
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.proxyErrors[0].key).toBe("HTTPS_PROXY");
    expect(body.message).toContain("HTTPS_PROXY");
  });

  it("aggregates errors from multiple bad keys", async () => {
    ({ server } = await buildAdminRuntime());

    const res = await server.app.inject({
      method: "POST",
      url: "/api/config",
      payload: {
        Providers: [],
        Router: {},
        PROXY_URL: "ftp://example",
        https_proxy: "bad value",
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    const keys = body.proxyErrors.map((e: any) => e.key).sort();
    expect(keys).toEqual(["PROXY_URL", "https_proxy"].sort());
    expect(body.proxyErrors.length).toBe(2);
  });

  it("accepts http(s) URLs, empty values, and $VAR placeholders", async () => {
    ({ server } = await buildAdminRuntime());

    for (const proxyUrl of [
      "http://127.0.0.1:7890",
      "https://proxy.corp:8443",
      "",
      "${PROXY_URL}",
      "$HTTPS_PROXY",
      "http://${PROXY_HOST}:8080",
    ]) {
      const res = await server.app.inject({
        method: "POST",
        url: "/api/config",
        payload: {
          Providers: [],
          Router: {},
          PROXY_URL: proxyUrl,
        },
      });

      expect(res.statusCode, `proxyUrl=${proxyUrl}`).toBe(200);
    }
  });

  it("refreshes Claude Code takeover after saving a non-empty project Router", async () => {
    ({ server } = await buildAdminRuntime());
    const projectPath = mkdtempSync(join(tmpdir(), "ccr-project-route-save-"));
    projectPaths.push(projectPath);
    const globalConfig = {
      APIKEY: "global-key",
      PORT: 4567,
      ContextWindow: 400000,
      Providers: [],
      Router: {
        families: {
          opus: {
            default: "provider,global-opus",
            extendedContext: "provider,global-extended",
            enableExtendedContext: true,
          },
        },
      },
    };
    readConfigFileMock.mockResolvedValue(globalConfig);

    await writeProjectConfig(projectPath, { Router: {} });
    await setCcrTakeover(projectPath, true, globalConfig);
    expect(
      JSON.parse(readFileSync(getClaudeSettingsLocalPath(projectPath), "utf8")).env
        .CLAUDE_CODE_AUTO_COMPACT_WINDOW
    ).toBe("400000");

    const projectRouter = {
      enableFamilyRouting: true,
      families: {
        opus: { default: "provider,project-opus" },
      },
    };
    const res = await server.app.inject({
      method: "PUT",
      url: `/api/projects/${getClaudeProjectId(projectPath)}`,
      payload: { Router: projectRouter },
    });

    expect(res.statusCode).toBe(200);
    const settings = JSON.parse(readFileSync(getClaudeSettingsLocalPath(projectPath), "utf8"));
    expect(settings.env.ANTHROPIC_MODEL).toBe("ccr-opus");
    expect(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("ccr-opus");
    expect(settings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("200000");
  });
});
