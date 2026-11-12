import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Server from "../server";
import { registerAdminRoutes } from "../ccr/admin-routes";
import { getHealthStore, resetHealthStore } from "../services/provider-health";

/**
 * /api/providers/health must expose lastSuccessTime on every state entry so
 * the UI can tell a stale failure (a later success already recovered the
 * model) from an active one. Purely additive: entries without the field
 * serialize it as null.
 */
async function buildAdminRuntime() {
  const config = { PORT: 0, APIKEY: "secret", Providers: [], Router: {} };
  const server: any = new Server({
    logger: false,
    useJsonFile: false,
    initialConfig: { providers: [], Router: {}, HOST: "127.0.0.1", PORT: 0, ACTIVE_PROBE_ENABLED: false },
  });
  await server.ready();
  await registerAdminRoutes(server, config);
  await server.app.ready();
  return { server };
}

describe("/api/providers/health lastSuccessTime exposure", () => {
  let server: Server;

  beforeEach(() => {
    getHealthStore().clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await server?.app.close();
    getHealthStore().clear();
    resetHealthStore();
  });

  it("exposes lastSuccessTime alongside lastFailureTime for recovered states", async () => {
    const health = getHealthStore();
    health.forceOpen("provider-a", "model-a", "upstream boom");
    const failedAt = Date.now();
    vi.advanceTimersByTime(30_000);
    health.recordSuccess("provider-a", "model-a"); // open → half-open keeps the entry
    const succeededAt = Date.now();

    ({ server } = await buildAdminRuntime());
    const res = await server.app.inject({ method: "GET", url: "/api/providers/health" });
    expect(res.statusCode).toBe(200);

    const entry = res.json().states.find((s: any) => s.provider === "provider-a");
    expect(entry).toBeDefined();
    expect(entry.lastFailureTime).toBe(failedAt);
    expect(entry.lastSuccessTime).toBe(succeededAt);
    // The UI staleness rule now evaluates to "stale" (recovered).
    expect(entry.lastFailureTime > entry.lastSuccessTime).toBe(false);
  });

  it("serializes lastSuccessTime as null when no success was recorded yet", async () => {
    getHealthStore().forceOpen("provider-b", "model-b", "still failing");
    ({ server } = await buildAdminRuntime());

    const res = await server.app.inject({ method: "GET", url: "/api/providers/health" });
    expect(res.statusCode).toBe(200);
    const entry = res.json().states.find((s: any) => s.provider === "provider-b");
    expect(entry.status).toBe("open");
    expect(entry.lastSuccessTime).toBeNull();
  });
});
