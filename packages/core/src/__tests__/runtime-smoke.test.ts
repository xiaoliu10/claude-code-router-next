import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Server from "../server";
import { listAnthropicCompatibleModels } from "../ccr/models";
import { registerAdminRoutes } from "../ccr/admin-routes";
import { apiKeyAuth } from "../ccr/auth";

describe("CCR runtime management API", () => {
  it("lists aliases, configured models, and extended-context metadata", () => {
    const models = listAnthropicCompatibleModels({
      Providers: [{ name: "demo", models: ["model-a"] }],
    });

    expect(models.find((model) => model.id === "ccr-opus")?.context_window).toBe(200_000);
    expect(models.find((model) => model.id === "ccr-opus[1m]")?.context_window).toBe(1_000_000);
    expect(models.find((model) => model.id === "demo,model-a")?.display_name).toBe("demo/model-a");
  });

  it("waits for transformer/provider/tokenizer readiness before namespace registration", async () => {
    const server = new Server({
      logger: false,
      useJsonFile: false,
      initialConfig: { providers: [], Router: {} },
    });

    await server.ready();
    expect(server.providerService).toBeDefined();
    expect(server.transformerService.getAllTransformers().size).toBeGreaterThan(0);
    expect(server.tokenizerService).toBeDefined();

    await server.registerNamespace("/");
    await server.app.ready();
    const health = await server.app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json().status).toBe("ok");
    await server.app.close();
  });

  it("reports which registered transformers support tuple parameters", async () => {
    const config = { Providers: [], Router: {}, ACTIVE_PROBE_ENABLED: false };
    const server = new Server({ logger: false, useJsonFile: false, initialConfig: config });
    try {
      await server.ready();
      await registerAdminRoutes(server, config);
      const response = await server.app.inject({ method: "GET", url: "/api/transformers" });
      expect(response.statusCode).toBe(200);
      expect(response.json().transformers).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "OpenAI", supportsParameters: false }),
        expect.objectContaining({ name: "customparams", supportsParameters: true }),
      ]));
    } finally {
      await server.app.close();
    }
  });

  it("loads jsonPath by default when useJsonFile is omitted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ccr-config-default-"));
    const jsonPath = join(dir, "config.json");
    await writeFile(jsonPath, JSON.stringify({
      Router: { default: "demo,model-a" },
    }));

    const server = new Server({
      logger: false,
      jsonPath,
      initialConfig: { providers: [] },
    });

    try {
      await server.ready();
      expect(server.configService.get("Router")).toEqual({
        default: "demo,model-a",
      });
    } finally {
      await server.app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("registers shutdown cleanup before Fastify starts listening", async () => {
    const server = new Server({
      logger: false,
      useJsonFile: false,
      initialConfig: {
        providers: [],
        Router: {},
        HOST: "127.0.0.1",
        PORT: "0",
        ACTIVE_PROBE_ENABLED: false,
      },
    });
    await server.ready();

    const events: string[] = [];
    const app = server.app as any;
    const addHook = app.addHook.bind(app);
    app.addHook = (name: string, ...args: any[]) => {
      if (name === "onClose") events.push("onClose");
      return addHook(name, ...args);
    };
    app.listen = vi.fn(async () => {
      events.push("listen");
      return "http://127.0.0.1:0";
    });

    await server.start();

    expect(events).toContain("onClose");
    expect(events.indexOf("onClose")).toBeLessThan(events.indexOf("listen"));
    await app.close();
  });

  it("keeps public and local authentication behavior stable", async () => {
    const auth = apiKeyAuth({
      PORT: 3456,
      APIKEY: "secret",
      Providers: [{ name: "demo" }],
    });

    const done = vi.fn();
    const reply = {
      status: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
      header: vi.fn().mockReturnThis(),
      log: { warn: vi.fn() },
    } as any;

    await auth({ url: "/health", ip: "10.0.0.2", headers: {} } as any, reply, done);
    expect(done).toHaveBeenCalledOnce();

    done.mockClear();
    await auth({ url: "/api/config", ip: "127.0.0.1", headers: {} } as any, reply, done);
    expect(done).toHaveBeenCalledOnce();
  });
});
