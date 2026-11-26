import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const home = mkdtempSync(join(tmpdir(), "ccr-effective-api-"));
process.env.CCR_CONFIG_DIR = home;
process.env.HOME = home;
process.env.USERPROFILE = home;
const { append, close } = await import("../ccr/usage-store");
const { default: Server } = await import("../server");
const { registerAdminRoutes } = await import("../ccr/admin-routes");

describe("usage API inclusive input", () => {
  it("exposes records, totals, and filtered buckets", async () => {
    append({ id: "api-effective", timestamp: "2026-08-01T10:00:00.000Z", sessionId: "api", provider: "api-provider",
      originalModel: "requested", model: "routed", modelFamily: "opus", scenarioType: "default", stream: false,
      inputTokens: 2, outputTokens: 3, cacheReadInputTokens: 60, cacheCreationInputTokens: 7,
      effectiveInputTokens: 69, ttft: null, tokensPerSecond: null, durationMs: 100, status: "success" });
    const server = new Server({ logger: false, useJsonFile: false, initialConfig: { providers: [], Router: {}, ACTIVE_PROBE_ENABLED: false } });
    await server.ready();
    await registerAdminRoutes(server, {});
    await server.app.ready();
    try {
      const records = await server.app.inject({ method: "GET", url: "/api/usage?provider=api-provider" });
      expect(records.statusCode).toBe(200);
      expect(records.json().records[0]).toMatchObject({ effectiveInputTokens: 69 });
      expect(records.json().summary.totalEffectiveInputTokens).toBe(69);
      expect(records.json().summary.byProvider["api-provider"].effectiveInputTokens).toBe(69);
      const summary = await server.app.inject({ method: "GET", url: "/api/usage/summary?status=success" });
      expect(summary.json().totalEffectiveInputTokens).toBe(69);
      expect(summary.json().byModel.routed.effectiveInputTokens).toBe(69);
    } finally { await server.app.close(); close(); }
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));
});
