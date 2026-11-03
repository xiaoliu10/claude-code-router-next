import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { assertLocalGrokRequest, registerGrokAdminRoutes } from "../src/admin-routes";
import { GROK_UPSTREAM, GROK_MARKER, lockGrokProvider, protectGrokConfig, mergeGrokProvider, validDeviceUrl } from "../src/protocol";
import { createGrokManagedRuntime } from "../src/managed-runtime";
import { GrokTransformer } from "../src/transformer";
import { fixture, TOKEN } from "./fixtures";

describe("Grok managed boundary", () => {
  it("protects omitted and tampered managed config while preserving unrelated providers/router", () => {
    const old = { Providers: [lockGrokProvider({ models: ["grok-fixture"] }), { name: "other", api_key: "$SECRET" }], Router: { default: "other,m" } };
    const next = { Providers: [{ name: "grok-subscription", api_key: "spoof", api_base_url: "https://evil.invalid" }, old.Providers[1]], Router: old.Router };
    protectGrokConfig(next, old);
    expect(next.Providers[0].api_key).toBe(GROK_MARKER); expect(next.Providers[0].api_base_url).toBe(GROK_UPSTREAM);
    expect(next.Providers[1]).toEqual(old.Providers[1]); expect(next.Router).toBe(old.Router);
    const omitted: any = { Router: old.Router }; protectGrokConfig(omitted, old); expect(omitted.Providers[0].api_key).toBe(GROK_MARKER);
    expect(mergeGrokProvider(old, { Providers: [old.Providers[1]] }).Providers).toEqual([old.Providers[1]]);
  });
  it("socket address wins over trusted-proxy req.ip; origin and authority are local", () => {
    const app: any = { server: { address: () => ({ port: 3456 }) } };
    const req = { ip: "127.0.0.1", raw: { socket: { remoteAddress: "203.0.113.10" } }, headers: { host: "localhost:3456" } };
    expect(() => assertLocalGrokRequest(req, app)).toThrow("grok_unauthorized");
    req.raw.socket.remoteAddress = "127.0.0.1"; expect(() => assertLocalGrokRequest(req, app)).not.toThrow();
    expect(() => assertLocalGrokRequest({ ...req, headers: { host: "localhost:3456", origin: "https://evil.invalid" } }, app)).toThrow();
    expect(() => assertLocalGrokRequest({ ...req, headers: { host: "evil.invalid" } }, app)).toThrow();
  });
  it("admin never echoes raw errors or returns upstream 401", async () => {
    const app = Fastify({ trustProxy: true });
    const service: any = { getStatus: vi.fn(async () => { throw Object.assign(new Error(TOKEN), { statusCode: 401 }); }) };
    registerGrokAdminRoutes(app, service);
    try {
      const response = await app.inject({ url: "/api/grok/status", headers: { host: "localhost:3456" } });
      expect(response.statusCode).toBe(500); expect(response.body).not.toContain(TOKEN);
      const remote = await app.inject({ url: "/api/grok/status", remoteAddress: "203.0.113.2", headers: { host: "localhost:3456", "x-forwarded-for": "127.0.0.1" } });
      expect(remote.statusCode).toBe(403);
      const bad = await app.inject({ method: "POST", url: "/api/grok/login/poll", payload: { loginId: "../../auth" }, headers: { host: "localhost:3456" } });
      expect(bad.statusCode).toBe(422);
    } finally { await app.close(); }
  });
  it("runtime pins destination and dispatcher, strips spoofed identities, preserves context on 401 re-sign", async () => {
    const f = fixture();
    try {
      const runtime = createGrokManagedRuntime(f.service, f.host);
      await expect(runtime.ensureUsable!()).rejects.toMatchObject({ code: "grok_not_connected" }); expect(f.upstream).not.toHaveBeenCalled();
      await f.service.importCurrent();
      const config: any = { url: "https://evil.invalid", dispatcher: "ambient" };
      await runtime.lockUpstream!(config, {} as any); expect(config.url).toBe(GROK_UPSTREAM); expect(config.redirect).toBe("error"); expect(config.dispatcher).toBe(f.subscription);
      const transformed = await new GrokTransformer(f.service.engine).transformRequestIn({ model: "grok-fixture@500k", input: [], prompt_cache_key: "session" });
      const headers = { AUTHORIZATION: "attacker", Cookie: TOKEN, "X-Api-Key": GROK_MARKER, "X-Grok-Conv-Id": "spoof", "X-Grok-Context-Window": "1", "x-xai-token-auth": "spoof", "Content-Length": "1" };
      const signed = await runtime.signRequest({ headers, requestBody: transformed.body, config: transformed.config, provider: {} as any });
      expect(signed.authorization).toBe(`Bearer ${TOKEN}`); expect(signed.cookie).toBeUndefined(); expect(signed["x-api-key"]).toBeUndefined();
      expect(signed["x-grok-context-window"]).toBe("500000"); expect(signed["x-grok-model-override"]).toBe("grok-fixture"); expect(signed["x-grok-conv-id"]).toBe("session");
      expect(signed["x-grok-client-version"]).toBe("1.0.62");
      expect((await runtime.signRequest({ headers: signed, requestBody: transformed.body, provider: {} as any }))["x-grok-context-window"]).toBe("500000");
      expect(runtime.classifyError!(401, TOKEN, "")).toMatchObject({ code: "grok_reauth_required", retryable: false });
      expect(runtime.classifyError!(0, "", "")).toMatchObject({ code: "grok_upstream_error", httpStatus: 502, retryable: true });
      expect(runtime.classifyError!(403, "", "")).toMatchObject({ code: "grok_upstream_error", retryable: false });
      expect(runtime.classifyError!(429, "", "")).toMatchObject({ code: "grok_rate_limited" });
    } finally { await f.cleanup(); }
  });
  it("device URL rejects credential-bearing, wrong host and non-device links", () => {
    for (const u of ["https://accounts.x.ai.evil.invalid/oauth2/device?user_code=AB", "https://user@accounts.x.ai/oauth2/device?user_code=AB", "https://auth.x.ai/oauth2/device/code", "http://accounts.x.ai/oauth2/device?user_code=AB"]) expect(validDeviceUrl(u)).toBe(false);
  });
});
