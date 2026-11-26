import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Server from "../server";
import { registerAdminRoutes } from "../ccr/admin-routes";
import * as configIO from "../ccr/config";

// Stand in for the guarded config store with a private synthetic file. Keep
// the production handlers, interpolation, provider registry and reload path.
vi.mock("../ccr/config", async (importOriginal) => ({
  ...await importOriginal<typeof configIO>(),
  readConfigFile: vi.fn(),
  readConfigFileRaw: vi.fn(),
  backupConfigFile: vi.fn(),
  writeConfigFile: vi.fn(),
}));

const initial = {
  LOG: false,
  CCR_SELF_PROVIDER_DELETED: true,
  Providers: [{ name: "sample", models: ["test"], api_key: "$CONFIG_TEST_KEY", api_base_url: "${CONFIG_TEST_URL}" }],
  Router: { default: "sample,test" },
  extra: { flags: ["keep"] },
};

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe("conditional /api/config save", () => {
  let dir: string;
  let file: string;
  let server: Server;
  const url = "/api/config";
  const readRaw = () => JSON.parse(readFileSync(file, "utf8"));

  beforeEach(async () => {
    vi.resetAllMocks();
    vi.stubEnv("CONFIG_TEST_KEY", "synthetic-key");
    vi.stubEnv("CONFIG_TEST_URL", "https://fixture.invalid/api");
    dir = mkdtempSync(join(tmpdir(), "ccr-conditional-save-"));
    file = join(dir, "config.json");
    writeFileSync(file, JSON.stringify(initial));
    vi.mocked(configIO.readConfigFileRaw).mockImplementation(async () => readRaw());
    vi.mocked(configIO.writeConfigFile).mockImplementation(async (raw) => { writeFileSync(file, JSON.stringify(raw)); });
    server = new Server({ logger: false, useJsonFile: false, initialConfig: { ACTIVE_PROBE_ENABLED: false } });
    await server.ready();
    await registerAdminRoutes(server, initial);
    await server.app.ready();
  });

  afterEach(async () => {
    await server.app.close();
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it.each(["Web", "Desktop"] as const)("orders concurrent saves when %s writes first", async (firstWriter) => {
    const get = await server.app.inject({ method: "GET", url });
    expect(get.json()).toEqual(initial);
    const revision = get.headers["x-ccr-config-revision"];
    expect(revision).toMatch(/^[a-f0-9]{64}$/);
    const webConfig = { ...initial, extra: { flags: ["web edit"] } };
    const desktopConfig = { ...initial, LOG: true };
    const web = () => server.app.inject({ method: "POST", url, payload: webConfig });
    const desktop = () => server.app.inject({ method: "PUT", url, payload: { revision, config: desktopConfig } });

    // Pause the first write before disk changes. Deliver the second request
    // while both writers would still see the original revision without a lock.
    const writing = latch();
    const proceed = latch();
    vi.mocked(configIO.writeConfigFile).mockImplementationOnce(async (raw) => {
      writing.release();
      await proceed.promise;
      writeFileSync(file, JSON.stringify(raw));
    });
    const reload = vi.spyOn(server, "reloadProviders");
    const webFirst = firstWriter === "Web";
    const first = webFirst ? web() : desktop();
    await writing.promise;
    const second = webFirst ? desktop() : web();
    await new Promise<void>((resolve) => setImmediate(resolve));
    proceed.release();
    expect((await first).statusCode).toBe(200);
    expect((await second).statusCode).toBe(webFirst ? 409 : 200);
    expect(configIO.backupConfigFile).toHaveBeenCalledTimes(webFirst ? 1 : 2);
    expect(configIO.writeConfigFile).toHaveBeenCalledTimes(webFirst ? 1 : 2);
    expect(reload.mock.calls.map(([config]) => config.LOG)).toEqual(webFirst ? [false] : [true, false]);
    for (const [config] of reload.mock.calls) {
      expect(config.Providers[0]).toMatchObject({ api_key: "synthetic-key", api_base_url: "https://fixture.invalid/api" });
    }
    expect(vi.mocked(configIO.writeConfigFile).mock.calls.map(([raw]) => raw)).toEqual(
      webFirst ? [webConfig] : [desktopConfig, webConfig],
    );
    expect(readRaw()).toEqual(webConfig);
    const final = await server.app.inject({ method: "GET", url });
    expect(final.json()).toEqual(webConfig);
    expect(final.headers["x-ccr-config-revision"]).not.toBe(revision);
    expect(server.providerService.getProvider("sample")).toMatchObject({ apiKey: "synthetic-key", baseUrl: "https://fixture.invalid/api" });
    expect(configIO.readConfigFile).not.toHaveBeenCalled();
  });

  it("requires a valid precondition and recovers after an unreadable current config", async () => {
    const get = await server.app.inject({ method: "GET", url });
    const revision = get.headers["x-ccr-config-revision"];
    for (const value of [undefined, "*", 1]) {
      const result = await server.app.inject({ method: "PUT", url, payload: { revision: value, config: initial } });
      expect(result.statusCode).toBe(400);
    }
    writeFileSync(file, "invalid JSON");
    const save = () => server.app.inject({ method: "PUT", url, payload: { revision, config: initial } });
    expect((await save()).statusCode).toBe(500);
    expect(configIO.readConfigFile).not.toHaveBeenCalled();
    expect(configIO.backupConfigFile).not.toHaveBeenCalled();
    expect(configIO.writeConfigFile).not.toHaveBeenCalled();
    writeFileSync(file, JSON.stringify(initial));
    expect((await save()).statusCode).toBe(200);
  });
});
