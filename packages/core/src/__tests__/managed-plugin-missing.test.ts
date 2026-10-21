import { afterEach, expect, it, vi } from "vitest";
import Server from "../server";

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.app.close();
  vi.unstubAllGlobals();
});

it("a managed marker with no owning plugin fails closed before sending and preserves config/Router", async () => {
  const providers = [{ name: "managed-fixture", api_base_url: "https://untrusted.invalid/v1/chat/completions",
    api_key: "ccr-managed-fixture", ccr_managed: true, models: ["m"], transformer: { use: ["missing-plugin-fixture"] } }];
  const router = { default: "managed-fixture,m", enableFallback: false, background: "managed-fixture,m" };
  const original = structuredClone({ providers, Router: router });
  const fetch = vi.fn(async () => { throw new Error("must not send marker upstream"); }); vi.stubGlobal("fetch", fetch);
  const server = new Server({ logger: false, useJsonFile: false, initialConfig: { providers, Router: router } });
  servers.push(server); await server.ready(); await server.registerNamespace("/");
  const response = await server.app.inject({ method: "POST", url: "/v1/chat/completions", payload: {
    model: "managed-fixture,m", messages: [{ role: "user", content: "hi" }], stream: false,
  } });
  expect(response.statusCode).toBe(503); expect(response.body).toContain("plugin_missing");
  expect(fetch).not.toHaveBeenCalled();
  expect(server.configService.get("providers")).toEqual(original.providers);
  expect(server.configService.get("Router")).toEqual(original.Router);
});
