import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import { registerKiroAdminRoutes, assertLocalKiroRequest } from "../src/admin-routes";
import { kiroError } from "../src/protocol";
import type { KiroAuthService } from "../src/auth-service";
const headers = { host: "localhost:3456" };
const makeService = () => ({ getStatus: vi.fn(async () => ({ connected: true, accounts: [], models: [], plan: null, usage: [], hiddenModels: [] })),
  startLogin: vi.fn(async () => ({ loginId: "id", url: "https://app.kiro.dev/signin" })), pollLogin: vi.fn(async () => ({ status: "pending" })),
  completeLogin: vi.fn(async () => ({ status: "complete", account: { id: "a" } })), cancelLogin: vi.fn(async () => ({ status: "cancelled" })),
  syncModels: vi.fn(async () => ({ success: true })), getUsage: vi.fn(async () => ({ known: true, windows: [] })), disconnect: vi.fn(async () => ({ success: true })), setModelHidden: vi.fn(async () => ({ success: true })) });
function app(service: ReturnType<typeof makeService>) { const app = Fastify({ trustProxy: true }); registerKiroAdminRoutes(app, service as unknown as KiroAuthService); return app; }
describe("Kiro admin contract", () => {
  it("checks socket before forwarded IP, rejects hostile authorities and origins", () => {
    const stub: any = { server: { address: () => ({ port: 3456 }) } };
    const req: any = { raw: { socket: { remoteAddress: "203.0.113.1" } }, ip: "127.0.0.1", headers };
    expect(() => assertLocalKiroRequest(req, stub)).toThrow("kiro_unauthorized"); req.raw.socket.remoteAddress = "127.0.0.1";
    expect(() => assertLocalKiroRequest(req, stub)).not.toThrow();
    for (const h of [{ host: "evil.invalid" }, { ...headers, origin: "https://evil.invalid" }, { ...headers, origin: "http://user:pass@localhost:3456" }]) expect(() => assertLocalKiroRequest({ ...req, headers: h }, stub)).toThrow("kiro_unauthorized");
  });
  it("registers all endpoint actions and forwards account, method and pasted callback", async () => {
    const service = makeService(), instance = app(service);
    try {
      expect((await instance.inject({ url: "/api/kiro/status", headers })).json()).toMatchObject({ connected: true, accounts: [], hiddenModels: [] });
      for (const [path, payload] of [["login/start", { method: "idc", region: "eu-west-1", startUrl: "https://org.awsapps.com/start" }], ["login/poll", { loginId: "id", callbackUrl: "http://localhost:3128/oauth/callback" }], ["login/complete", { loginId: "id", callbackUrl: "http://localhost:3128/oauth/callback" }], ["login/cancel", { loginId: "id" }], ["sync", { account: "a" }], ["usage", { account: "a" }], ["disconnect", { account: "a" }], ["models/visibility", { model: "auto", hidden: true }]] as const) {
        const res = await instance.inject({ method: "POST", url: `/api/kiro/${path}`, headers, payload }); expect(res.statusCode).toBe(200);
      }
      expect(service.startLogin).toHaveBeenCalledWith({ method: "idc", region: "eu-west-1", startUrl: "https://org.awsapps.com/start" });
      expect(service.pollLogin).toHaveBeenCalledWith("id", "http://localhost:3128/oauth/callback"); expect(service.disconnect).toHaveBeenCalledWith("a");
    } finally { await instance.close(); }
  });
  it("validates inputs and returns safe English error keys without upstream secrets", async () => {
    const service = makeService(), instance = app(service);
    try {
      const invalid = await instance.inject({ method: "POST", url: "/api/kiro/login/complete", headers, payload: { loginId: "id" } }); expect(invalid.statusCode).toBe(422); expect(invalid.json().error).toBe("kiro_callback_invalid");
      const missingId = await instance.inject({ method: "POST", url: "/api/kiro/login/poll", headers, payload: {} }); expect(missingId.json().error).toBe("kiro_login_invalid");
      service.getStatus.mockRejectedValueOnce(kiroError("kiro_reauth_required", 401)); const expired = await instance.inject({ url: "/api/kiro/status", headers }); expect(expired.statusCode).toBe(500); expect(expired.json().error).toBe("kiro_reauth_required");
      service.getStatus.mockRejectedValueOnce(new Error("super-secret-token")); const failed = await instance.inject({ url: "/api/kiro/status", headers }); expect(failed.json()).toEqual({ success: false, error: "kiro_request_failed" }); expect(failed.body).not.toContain("super-secret");
      const denied = await instance.inject({ url: "/api/kiro/status", headers: { host: "evil.invalid" } }); expect(denied.statusCode).toBe(403); expect(denied.json().error).toBe("kiro_unauthorized");
    } finally { await instance.close(); }
  });
});
