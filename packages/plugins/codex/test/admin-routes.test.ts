/** Codex admin routes — /models/hide and /models/restore wiring: local-only
 * guard, stable error mapping, payload gates and the success envelope. The
 * service is a fake: behaviour (persistence, filtering, idempotency) is
 * covered by auth-service.test.ts against the real store/config seams. */
import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { registerCodexAdminRoutes, type CodexAdminRouteDeps } from "../src/admin-routes";
import { codexAdminError } from "../src/protocol";

const localHeaders = { host: "localhost:3456" };

function app(service: any, serviceTier: CodexAdminRouteDeps["serviceTier"] = { tier: "follow", set: vi.fn() }) {
  const instance = Fastify({ trustProxy: true });
  registerCodexAdminRoutes(instance, { getService: () => service, serviceTier });
  return instance;
}

describe("POST /api/codex/reset-credits/consume-confirmed-v2", () => {
  const url = "/api/codex/reset-credits/consume-confirmed-v2";

  const accountRevision = "12345678-1234-4321-8765-001122334455";

  it("requires an account revision and specific, bounded creditId and uses the strict service path", async () => {
    const service = {
      consumeConfirmedResetCredit: vi.fn(async () => ({ outcome: "reset", windowsReset: 2 })),
      consumeResetCredit: vi.fn(async () => ({ outcome: "reset", windowsReset: 2, availableCount: 1 })),
    };
    const instance = app(service);
    try {
      for (const payload of [undefined, {}, { creditId: "gift" }, { creditId: "gift", accountRevision: "invalid" },
        { accountRevision }, ...[null, "", " ", 1, "id\u0000", "x".repeat(257)].map(creditId => ({ creditId, accountRevision }))]) {
        const res = await instance.inject({ method: "POST", url, payload, headers: localHeaders });
        expect(res.statusCode).toBe(422);
        expect(res.json()).toEqual({ ok: false, success: false, error: "codex_reset_invalid" });
      }
      expect(service.consumeConfirmedResetCredit).not.toHaveBeenCalled();
      const res = await instance.inject({ method: "POST", url, payload: { creditId: "gift", accountRevision }, headers: localHeaders });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, success: true, outcome: "reset", windowsReset: 2 });
      expect(service.consumeConfirmedResetCredit).toHaveBeenCalledExactlyOnceWith("gift", accountRevision);
      expect(service.consumeResetCredit).not.toHaveBeenCalled();
      const obsolete = await instance.inject({ method: "POST", url: "/api/codex/reset-credits/consume-confirmed", payload: { creditId: "gift", accountRevision }, headers: localHeaders });
      expect(obsolete.statusCode).toBe(404);
      expect(service.consumeConfirmedResetCredit).toHaveBeenCalledTimes(1);

      const legacy = await instance.inject({ method: "POST", url: "/api/codex/reset-credits/consume", payload: {}, headers: localHeaders });
      expect(legacy.statusCode).toBe(200);
      expect(legacy.json()).toEqual({ ok: true, success: true, outcome: "reset", windowsReset: 2, availableCount: 1 });
      expect(service.consumeResetCredit).toHaveBeenCalledExactlyOnceWith(undefined);
    } finally { await instance.close(); }
  });

  it("rejects remote requests and preserves the stable unknown-outcome code", async () => {
    const service = {
      consumeConfirmedResetCredit: vi.fn(async () => { throw codexAdminError("codex_reset_unavailable", 502); }),
    };
    const instance = app(service);
    try {
      const request = { method: "POST" as const, url, payload: { creditId: "gift", accountRevision }, headers: localHeaders };
      const remote = await instance.inject({ ...request, remoteAddress: "192.0.2.42" });
      expect(remote.statusCode).toBe(403);
      expect(service.consumeConfirmedResetCredit).not.toHaveBeenCalled();
      const local = await instance.inject(request);
      expect(local.statusCode).toBe(502);
      expect(local.json()).toEqual({ ok: false, success: false, error: "codex_reset_unavailable" });
    } finally { await instance.close(); }
  });
});

describe("Codex admin routes — models hide/restore", () => {
  it("hide posts the model and returns the workbuddy-shaped success envelope", async () => {
    const service = {
      hideModel: vi.fn(async (model: string) => ({
        success: true as const, model, models: ["m2"], hiddenModels: [model],
      })),
    };
    const instance = app(service);
    try {
      const res = await instance.inject({ method: "POST", url: "/api/codex/models/hide", payload: { model: "m1" }, headers: localHeaders });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, success: true, model: "m1", models: ["m2"], hiddenModels: ["m1"] });
      expect(service.hideModel).toHaveBeenCalledTimes(1);
      expect(service.hideModel).toHaveBeenCalledWith("m1");
    } finally { await instance.close(); }
  });

  it("restore passes one model, or undefined for restore-all (empty/null model = all)", async () => {
    const service = {
      restoreModels: vi.fn(async () => ({ success: true as const, restored: ["m1"], models: ["m1"], hiddenModels: [] })),
    };
    const instance = app(service);
    try {
      const one = await instance.inject({ method: "POST", url: "/api/codex/models/restore", payload: { model: "m1" }, headers: localHeaders });
      expect(one.statusCode).toBe(200);
      expect(one.json()).toMatchObject({ ok: true, success: true, restored: ["m1"] });
      expect(service.restoreModels).toHaveBeenLastCalledWith("m1");

      const all = await instance.inject({ method: "POST", url: "/api/codex/models/restore", payload: {}, headers: localHeaders });
      expect(all.statusCode).toBe(200);
      expect(service.restoreModels).toHaveBeenLastCalledWith(undefined);

      // workbuddy parity: absent/null/"" all mean restore-ALL.
      await instance.inject({ method: "POST", url: "/api/codex/models/restore", payload: { model: null }, headers: localHeaders });
      expect(service.restoreModels).toHaveBeenLastCalledWith(undefined);
      await instance.inject({ method: "POST", url: "/api/codex/models/restore", payload: { model: "" }, headers: localHeaders });
      expect(service.restoreModels).toHaveBeenLastCalledWith(undefined);
      expect(service.restoreModels).toHaveBeenCalledTimes(4);
    } finally { await instance.close(); }
  });

  it("rejects malformed payloads with the stable 422 code (never echoes the value)", async () => {
    const service = { hideModel: vi.fn(), restoreModels: vi.fn() };
    const instance = app(service);
    try {
      for (const payload of [{}, { model: 42 }, { model: "" }, { model: "a,b" }, { model: "bad\x00id" }, { model: "x".repeat(257) }]) {
        const res = await instance.inject({ method: "POST", url: "/api/codex/models/hide", payload, headers: localHeaders });
        expect(res.statusCode, JSON.stringify(payload)).toBe(422);
        expect(res.json()).toEqual({ ok: false, success: false, error: "codex_model_invalid" });
      }
      for (const payload of [{ model: 42 }, { model: "a\x1fb" }, { model: "x".repeat(257) }]) {
        const res = await instance.inject({ method: "POST", url: "/api/codex/models/restore", payload, headers: localHeaders });
        expect(res.statusCode, JSON.stringify(payload)).toBe(422);
        expect(res.json().error).toBe("codex_model_invalid");
      }
      expect(service.hideModel).not.toHaveBeenCalled();
      expect(service.restoreModels).not.toHaveBeenCalled();
    } finally { await instance.close(); }
  });

  it("unknown names pass through unchanged: hide accepts any well-formed id, restore is the service's no-op", async () => {
    const service = {
      hideModel: vi.fn(async (model: string) => ({ success: true as const, model, models: [], hiddenModels: [model] })),
      restoreModels: vi.fn(async () => ({ success: true as const, restored: [], models: [], hiddenModels: ["still-hidden"] })),
    };
    const instance = app(service);
    try {
      const hide = await instance.inject({ method: "POST", url: "/api/codex/models/hide", payload: { model: "never-seen-model" }, headers: localHeaders });
      expect(hide.statusCode).toBe(200);
      expect(service.hideModel).toHaveBeenCalledWith("never-seen-model");

      const restore = await instance.inject({ method: "POST", url: "/api/codex/models/restore", payload: { model: "never-hidden" }, headers: localHeaders });
      expect(restore.statusCode).toBe(200);
      expect(restore.json()).toMatchObject({ ok: true, success: true, restored: [] });
    } finally { await instance.close(); }
  });

  it("maps service failures to stable statuses without echoing raw errors", async () => {
    const SECRET = "fixture-raw-upstream-secret";
    const service = {
      hideModel: vi.fn(async () => { throw codexAdminError("codex_not_connected", 409); }),
      restoreModels: vi.fn(async () => {
        throw Object.assign(new Error(SECRET), { code: "codex_config_write_failed", statusCode: 500 });
      }),
    };
    const instance = app(service);
    try {
      const notConnected = await instance.inject({ method: "POST", url: "/api/codex/models/hide", payload: { model: "m" }, headers: localHeaders });
      expect(notConnected.statusCode).toBe(409);
      expect(notConnected.json()).toEqual({ ok: false, success: false, error: "codex_not_connected" });

      const writeFailed = await instance.inject({ method: "POST", url: "/api/codex/models/restore", payload: {}, headers: localHeaders });
      expect(writeFailed.statusCode).toBe(500);
      expect(writeFailed.json().error).toBe("codex_config_write_failed");
      expect(writeFailed.body).not.toContain(SECRET);
    } finally { await instance.close(); }
  });

  it("enforces the local-only guard and the 503 missing-service rule on both routes", async () => {
    const service = { hideModel: vi.fn(), restoreModels: vi.fn() };
    const instance = app(service);
    try {
      const remote = { remoteAddress: "203.0.113.2" };
      expect((await instance.inject({ method: "POST", url: "/api/codex/models/hide", payload: { model: "m" }, headers: localHeaders, ...remote })).statusCode).toBe(403);
      expect((await instance.inject({ method: "POST", url: "/api/codex/models/restore", payload: {}, headers: localHeaders, ...remote })).statusCode).toBe(403);
      expect((await instance.inject({ method: "POST", url: "/api/codex/models/hide", payload: { model: "m" }, headers: { host: "evil.invalid" } })).statusCode).toBe(403);
      expect((await instance.inject({ method: "POST", url: "/api/codex/models/restore", payload: {}, headers: { ...localHeaders, origin: "https://hostile.invalid" } })).statusCode).toBe(403);
      expect(service.hideModel).not.toHaveBeenCalled();
      expect(service.restoreModels).not.toHaveBeenCalled();
    } finally { await instance.close(); }

    const missing = app(undefined);
    try {
      expect((await missing.inject({ method: "POST", url: "/api/codex/models/hide", payload: { model: "m" }, headers: localHeaders })).statusCode).toBe(503);
      expect((await missing.inject({ method: "POST", url: "/api/codex/models/restore", payload: {}, headers: localHeaders })).statusCode).toBe(503);
    } finally { await missing.close(); }
  });

  it("status passes the service payload through verbatim (filtered models + hiddenModels)", async () => {
    const service = {
      getStatus: vi.fn(async () => ({
        status: "connected", providerName: "codex-subscription",
        models: ["m2"], modelCount: 1, hiddenModels: ["m1"], lastError: null,
      })),
    };
    const instance = app(service);
    try {
      const res = await instance.inject({ url: "/api/codex/status", headers: localHeaders });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: "connected", models: ["m2"], hiddenModels: ["m1"] });
    } finally { await instance.close(); }
  });
});

describe("Codex admin routes — service tier", () => {
  const url = "/api/codex/service-tier";

  it("rejects invalid tier payloads and non-local GET/PUT before changing the setting", async () => {
    const setting = { tier: "priority" as const, set: vi.fn() };
    const instance = app(undefined, setting);
    try {
      for (const payload of [null, [], "fast", {}, { tier: "fast" }, { tier: "ultrafast" },
        { tier: 1 }, { tier: " follow " }, { tier: "standard", extra: true }]) {
        const res = await instance.inject({ method: "PUT", url, payload: JSON.stringify(payload),
          headers: { ...localHeaders, "content-type": "application/json" } });
        expect(res.statusCode).toBe(422);
        expect(res.json().error).toBe("codex_service_tier_invalid");
      }
      const text = await instance.inject({ method: "PUT", url, payload: '{"tier":"follow"}',
        headers: { ...localHeaders, "content-type": "text/plain" } });
      expect(text.statusCode).toBe(422);
      for (const method of ["GET", "PUT"] as const) {
        const payload = method === "PUT" ? { tier: "standard" } : undefined;
        for (const denied of [
          { remoteAddress: "203.0.113.2", headers: localHeaders },
          { headers: { host: "other.invalid" } },
          { headers: { ...localHeaders, origin: "https://other.invalid" } },
        ]) {
          const res = await instance.inject({ method, url, payload, ...denied });
          expect(res.statusCode).toBe(403);
        }
      }
      expect(setting.set).not.toHaveBeenCalled();
    } finally { await instance.close(); }
  });
});
