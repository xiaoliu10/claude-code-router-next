import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActiveProbeService } from "../services/active-probe";
import { getHealthStore } from "../services/provider-health";

const provider = (name: string, apiKey: string) => ({
  name, apiKey, baseUrl: "https://configured.invalid/v1/chat/completions",
  models: ["m"], enabled: true, wakeupEnabled: true, wakeupTime: "00:00",
} as any);
const skipNames = ["missing", "disabled-plugin", "installed-plugin"];
const managed = skipNames.map(name => provider(name, "ccr-managed-gemini-oauth"));
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
function service(providers = managed) {
  return new ActiveProbeService(() => providers,
    { enabled: true, excludeProviders: [], initialDelayMs: 3_600_000 },
    undefined, log, key => key === "WAKEUP_ENABLED" ? true : undefined);
}

beforeEach(() => {
  getHealthStore().clear();
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("unexpected generic network call"); }));
});
afterEach(() => { getHealthStore().clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("managed marker providers never use generic health/quota/wakeup transports", () => {
  it("repeated health cycles do not open the circuit or add telemetry", async () => {
    const probe = service();
    for (let cycle = 0; cycle < 5; cycle++) await (probe as any).runHealthProbe();
    expect(fetch).not.toHaveBeenCalled();
    expect(probe.getProbeTelemetry()).toEqual([]);
    for (const p of managed) {
      expect(getHealthStore().isAvailable(p.name, "m")).toBe(true);
      expect(getHealthStore().getState(p.name, "m")).toBeUndefined();
    }
  });

  it("manual probe reports skipped, preserving healthy and open model states", async () => {
    const probe = service();
    getHealthStore().forceOpen(managed[1].name, "m", "existing failure");
    const before = structuredClone(getHealthStore().getAllStates());
    for (const p of managed) {
      expect(await probe.probeProviderManually(p.name)).toMatchObject({
        success: false, skipped: true, status: "skipped", isSlow: false,
      });
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(probe.getProbeTelemetry()).toEqual([]);
    expect(getHealthStore().getAllStates()).toEqual(before);
  });

  it("rate-limit recovery skips without spending marker credentials or altering cooldown", async () => {
    const probe = service();
    for (const p of managed) getHealthStore().markRateLimited(p.name, "m", 3600, "quota");
    const before = structuredClone(getHealthStore().getAllStates());
    await (probe as any).runRateLimitProbe();
    expect(fetch).not.toHaveBeenCalled();
    expect(getHealthStore().getAllStates()).toEqual(before);
  });

  it("scheduled wakeup skips markers and leaves ordinary-provider behavior intact", async () => {
    const ordinary = provider("ordinary", "real-synthetic-key");
    const calls = vi.fn(async (_url: any, init: any) => {
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer real-synthetic-key");
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", calls);
    const probe = service([...managed, ordinary]);
    await (probe as any).runScheduledWakeup();
    await Promise.resolve();
    expect(calls).toHaveBeenCalledTimes(1);
    expect(getHealthStore().getAllStates()).toEqual([]);
  });

  it("quota adapters/header probes also skip marker-only providers", async () => {
    const probe = service(managed.map(p => ({ ...p, baseUrl: "https://api.moonshot.cn/v1/chat/completions" })));
    await (probe as any).runQuotaProbe();
    expect(fetch).not.toHaveBeenCalled();
    expect(getHealthStore().getAllStates()).toEqual([]);
    expect(probe.getProbeTelemetry()).toEqual([]);
  });
});
