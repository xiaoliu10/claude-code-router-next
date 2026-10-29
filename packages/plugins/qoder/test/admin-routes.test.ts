import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { assertLocalQoderRequest, registerQoderAdminRoutes } from "../src/admin-routes";
import { qoderError } from "../src/protocol";

const localHeaders = { host: "localhost:3456" };

function app(service: any) {
  const instance = Fastify({ trustProxy: true });
  registerQoderAdminRoutes(instance, service);
  return instance;
}

describe("Qoder admin routes", () => {
  it("socket address wins over trusted-proxy req.ip; origin and authority are local", () => {
    const appStub: any = { server: { address: () => ({ port: 3456 }) } };
    const req = { ip: "127.0.0.1", raw: { socket: { remoteAddress: "203.0.113.10" } }, headers: { host: "localhost:3456" } };
    expect(() => assertLocalQoderRequest(req, appStub)).toThrow("qoder_unauthorized");
    req.raw.socket.remoteAddress = "127.0.0.1";
    expect(() => assertLocalQoderRequest(req, appStub)).not.toThrow();
    expect(() => assertLocalQoderRequest({ ...req, headers: { host: "localhost:3456", origin: "https://evil.invalid" } }, appStub)).toThrow();
    expect(() => assertLocalQoderRequest({ ...req, headers: { host: "localhost:3456", origin: "http://localhost:3456" } }, appStub)).not.toThrow();
    expect(() => assertLocalQoderRequest({ ...req, headers: { host: "evil.invalid" } }, appStub)).toThrow();
    expect(() => assertLocalQoderRequest({ ...req, headers: { host: "user:pass@localhost:3456", origin: "http://user:pass@localhost:3456" } }, appStub)).toThrow();
  });

  it("serves status and enforces the PAT format gate on connect", async () => {
    const service = { getStatus: vi.fn(async () => ({ status: "connected", providerName: "qoder-subscription", models: [] })),
      connectPAT: vi.fn(async () => ({ success: true })) };
    const instance = app(service);
    try {
      const status = await instance.inject({ url: "/api/qoder/status", headers: localHeaders });
      expect(status.statusCode).toBe(200);
      expect(status.json()).toMatchObject({ status: "connected" });

      const ok = await instance.inject({ method: "POST", url: "/api/qoder/connect", payload: { pat: "pt-abc" }, headers: localHeaders });
      expect(ok.statusCode).toBe(200);
      expect(service.connectPAT).toHaveBeenCalledWith("pt-abc");

      for (const pat of ["nope", "pt-" + "x".repeat(4097), 42, undefined]) {
        const bad = await instance.inject({ method: "POST", url: "/api/qoder/connect", payload: { pat }, headers: localHeaders });
        expect(bad.statusCode).toBe(422);
        expect(bad.json().error).toBe("qoder_pat_invalid");
      }
      expect(service.connectPAT).toHaveBeenCalledTimes(1);

      const visibility = await instance.inject({ method: "POST", url: "/api/qoder/models/visibility", payload: { model: "m", hidden: "yes" }, headers: localHeaders });
      expect(visibility.statusCode).toBe(422);
    } finally { await instance.close(); }
  });

  it("admin never echoes raw errors, never returns upstream 401, and maps only safe codes", async () => {
    const TOKEN = "fixture-upstream-secret";
    const service: any = {
      getStatus: vi.fn(async () => { throw Object.assign(new Error(TOKEN), { statusCode: 401, code: "qoder_reauth_required" }); }),
      syncModels: vi.fn(async () => { throw qoderError("qoder_upstream_error", 502); }),
      getUsage: vi.fn(async () => { throw Object.assign(new Error(TOKEN), { code: "not_in_safe_set" }); }),
      disconnect: vi.fn(async () => { throw qoderError("qoder_reauth_required", 401); }),
    };
    const instance = app(service);
    try {
      const auth = await instance.inject({ url: "/api/qoder/status", headers: localHeaders });
      expect(auth.statusCode).toBe(500);
      expect(auth.json().error).toBe("qoder_reauth_required");
      expect(auth.body).not.toContain(TOKEN);

      const upstream = await instance.inject({ method: "POST", url: "/api/qoder/sync", headers: localHeaders });
      expect(upstream.statusCode).toBe(502);
      expect(upstream.json().error).toBe("qoder_upstream_error");

      const unknown = await instance.inject({ method: "POST", url: "/api/qoder/usage", headers: localHeaders });
      expect(unknown.statusCode).toBe(500);
      expect(unknown.json().error).toBe("qoder_request_failed");
      expect(unknown.body).not.toContain(TOKEN);

      // a service 401 never surfaces as HTTP 401 to the UI
      const reauth = await instance.inject({ method: "POST", url: "/api/qoder/disconnect", headers: localHeaders });
      expect(reauth.statusCode).toBe(500);
      expect(reauth.json().error).toBe("qoder_reauth_required");

      const remote = await instance.inject({ url: "/api/qoder/status", remoteAddress: "203.0.113.2", headers: { ...localHeaders, "x-forwarded-for": "127.0.0.1" } });
      expect(remote.statusCode).toBe(403);
      expect(remote.json().error).toBe("qoder_unauthorized");
    } finally { await instance.close(); }
  });
});

describe("Qoder CN admin routes", () => {
  const local = { host: "localhost:3456" };

  it("registers under /api/qoder/cn only, with the same guard and safe codes", async () => {
    const service: any = {
      getStatus: vi.fn(async () => ({ status: "connected", providerName: "qoder-cn-subscription", models: [] })),
      connectPAT: vi.fn(async () => ({ success: true })),
      syncModels: vi.fn(async () => { throw qoderError("qoder_upstream_error", 502); }),
      getUsage: vi.fn(async () => { throw Object.assign(new Error("fixture-upstream-secret"), { code: "not_in_safe_set" }); }),
    };
    const instance = Fastify({ trustProxy: true });
    registerQoderAdminRoutes(instance, service, "qoder-cn");
    try {
      const status = await instance.inject({ url: "/api/qoder/cn/status", headers: local });
      expect(status.statusCode).toBe(200);
      expect(status.json()).toMatchObject({ status: "connected", providerName: "qoder-cn-subscription" });
      // the CN registration serves the CN prefix only
      expect((await instance.inject({ url: "/api/qoder/status", headers: local })).statusCode).toBe(404);

      const ok = await instance.inject({ method: "POST", url: "/api/qoder/cn/connect", payload: { pat: "pt-abc" }, headers: local });
      expect(ok.statusCode).toBe(200);
      expect(service.connectPAT).toHaveBeenCalledWith("pt-abc");
      const bad = await instance.inject({ method: "POST", url: "/api/qoder/cn/connect", payload: { pat: "nope" }, headers: local });
      expect(bad.statusCode).toBe(422);
      expect(bad.json().error).toBe("qoder_pat_invalid");

      const upstream = await instance.inject({ method: "POST", url: "/api/qoder/cn/sync", headers: local });
      expect(upstream.statusCode).toBe(502);
      expect(upstream.json().error).toBe("qoder_upstream_error");
      const unknown = await instance.inject({ method: "POST", url: "/api/qoder/cn/usage", headers: local });
      expect(unknown.statusCode).toBe(500);
      expect(unknown.json().error).toBe("qoder_request_failed");
      expect(unknown.body).not.toContain("fixture-upstream-secret");

      // same local-only guard on the CN prefix
      const remote = await instance.inject({ url: "/api/qoder/cn/status", remoteAddress: "203.0.113.2", headers: { ...local, "x-forwarded-for": "127.0.0.1" } });
      expect(remote.statusCode).toBe(403);
      expect(remote.json().error).toBe("qoder_unauthorized");
      expect((await instance.inject({ url: "/api/qoder/cn/status", headers: { host: "evil.invalid" } })).statusCode).toBe(403);
    } finally { await instance.close(); }
  });

  it("serves both sites' route sets on one app", async () => {
    const intl: any = { getStatus: vi.fn(async () => ({ providerName: "qoder-subscription", status: "not_connected" })), connectPAT: vi.fn() };
    const cn: any = { getStatus: vi.fn(async () => ({ providerName: "qoder-cn-subscription", status: "not_connected" })), connectPAT: vi.fn() };
    const instance = Fastify({ trustProxy: true });
    registerQoderAdminRoutes(instance, intl);
    registerQoderAdminRoutes(instance, cn, "qoder-cn");
    try {
      expect((await instance.inject({ url: "/api/qoder/status", headers: local })).json()).toMatchObject({ providerName: "qoder-subscription" });
      expect((await instance.inject({ url: "/api/qoder/cn/status", headers: local })).json()).toMatchObject({ providerName: "qoder-cn-subscription" });
      expect(intl.getStatus).toHaveBeenCalledTimes(1);
      expect(cn.getStatus).toHaveBeenCalledTimes(1);
    } finally { await instance.close(); }
  });
});
