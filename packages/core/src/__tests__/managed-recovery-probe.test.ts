import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActiveProbeService } from "../services/active-probe";
import { getHealthStore } from "../services/provider-health";

/**
 * Managed (subscription) providers are skipped by the generic health probe
 * because their credentials belong to a plugin, so an unauthenticated
 * GET /v1/models would fail for reasons unrelated to health. Without a
 * dedicated path their circuit stayed open forever: the only "recovery" was a
 * real user request hitting the dead account again — the reported
 * "keeps failing and keeps being called" behaviour.
 *
 * These tests pin the recovery loop: a real minimal request through the plugin's
 * own dispatcher, then either restore the models or keep the circuit open.
 */
const managedProvider = {
  name: "sub",
  api_base_url: "https://sub.example/v1/messages",
  api_key: "ccr-managed-sub",
  models: ["s1", "s2"],
};

/** Build a service whose providers are the managed one and whose plugin is stubbed. */
function buildService(dispatchRequest: any) {
  return new ActiveProbeService(
    () => [managedProvider as any],
    { quotaProbeIntervalMinutes: 10 },
    undefined,
    { debug() {}, info() {}, warn() {} },
    undefined,
    (provider: any) => (provider?.name === "sub" ? { name: "sub", dispatchRequest } : undefined)
  );
}

/** Put the model in the fail pool as if real requests had exhausted it. */
function openCircuit(model: string) {
  const health = getHealthStore();
  health.forceOpen("sub", model, "quota exhausted");
  // forceOpen stamps lastFailureTime = now, which the interval gate would treat as
  // "just failed". Age it so the probe is allowed to run (this is what happens in
  // production once the interval elapses).
  const state: any = health.getState("sub", model);
  state.lastFailureTime = Date.now() - 60 * 60 * 1000;
  state.lastProbeTime = 0;
  return state;
}

describe("managed recovery probe", () => {
  beforeEach(() => getHealthStore().clear());

  it("restores every model of the provider after one successful probe", async () => {
    openCircuit("s1");
    openCircuit("s2");
    const dispatchRequest = vi.fn(async () => new Response("{}", { status: 200 }));
    const service = buildService(dispatchRequest);

    await service.runManagedRecoveryProbe();

    const health = getHealthStore();
    expect(health.isAvailable("sub", "s1")).toBe(true);
    expect(health.isAvailable("sub", "s2")).toBe(true);
    // One probe per provider: a shared account limit must not be spent per model.
    expect(dispatchRequest).toHaveBeenCalledTimes(1);
  });

  it("keeps the circuit open and spaces out retries when the probe fails", async () => {
    openCircuit("s1");
    const dispatchRequest = vi.fn(async () => new Response("nope", { status: 503 }));
    // Default probe interval (10 min): the failed probe's stamp must push the
    // next attempt out, not re-run on the very next tick.
    const service = buildService(dispatchRequest);

    await service.runManagedRecoveryProbe();
    expect(getHealthStore().isAvailable("sub", "s1")).toBe(false);

    // The failed probe stamps lastProbeTime, so the interval gate stops an
    // immediate second attempt.
    await service.runManagedRecoveryProbe();
    expect(dispatchRequest).toHaveBeenCalledTimes(1);
  });

  it("does not probe a provider whose quota lock is still active", async () => {
    const state = openCircuit("s1");
    state.rateLimitUntil = Date.now() + 10 * 60 * 1000;
    const dispatchRequest = vi.fn(async () => new Response("{}", { status: 200 }));
    const service = buildService(dispatchRequest);

    await service.runManagedRecoveryProbe();
    expect(dispatchRequest).not.toHaveBeenCalled();
    expect(getHealthStore().isAvailable("sub", "s1")).toBe(false);
  });

  it("does nothing when the provider has no plugin runtime", async () => {
    openCircuit("s1");
    const dispatchRequest = vi.fn();
    const service = new ActiveProbeService(
      () => [managedProvider as any],
      { quotaProbeIntervalMinutes: 10 },
      undefined,
      { debug() {}, info() {}, warn() {} },
      undefined,
      () => undefined
    );
    await service.runManagedRecoveryProbe();
    expect(dispatchRequest).not.toHaveBeenCalled();
  });

  it("treats a throwing dispatcher as a failed probe, not a crash", async () => {
    openCircuit("s1");
    const dispatchRequest = vi.fn(async () => {
      throw new Error("network down");
    });
    const service = buildService(dispatchRequest);
    await expect(service.runManagedRecoveryProbe()).resolves.toBeUndefined();
    expect(getHealthStore().isAvailable("sub", "s1")).toBe(false);
  });
  it("passes a real attempt() and config to the dispatcher (contract compliance)", async () => {
    openCircuit("s1");
    const dispatchRequest = vi.fn(async (input: any) => {
      // PluginDispatchInput requires attempt + config; omitting them made
      // wrappers that call attempt() fail unconditionally (workbuddy).
      expect(typeof input.attempt).toBe("function");
      expect(input.config).toBeTruthy();
      expect(input.requestBody).toBeTruthy();
      expect(input.provider).toBeTruthy();
      return new Response("{}", { status: 200 });
    });
    const service = buildService(dispatchRequest);
    await service.runManagedRecoveryProbe();
    expect(dispatchRequest).toHaveBeenCalledTimes(1);
    expect(getHealthStore().isAvailable("sub", "s1")).toBe(true);
  });

  it("skips the liveness call entirely when account state says parked", async () => {
    openCircuit("s1");
    const dispatchRequest = vi.fn(async () => new Response("{}", { status: 200 }));
    // Level 1 vetoes: an over-quota account must not spend a network call.
    const service = new ActiveProbeService(
      () => [managedProvider as any],
      { quotaProbeIntervalMinutes: 10 },
      undefined,
      { debug() {}, info() {}, warn() {} },
      undefined,
      () => ({ name: "sub", dispatchRequest, probeAccountState: async () => ({ available: false, reason: "over quota", parkedUntil: Date.now() + 600_000 }) })
    );
    await service.runManagedRecoveryProbe();
    expect(dispatchRequest).not.toHaveBeenCalled();
    expect(getHealthStore().isAvailable("sub", "s1")).toBe(false);
  });

  it("treats a throwing account-state check as unusable, without a network call", async () => {
    openCircuit("s1");
    const dispatchRequest = vi.fn(async () => new Response("{}", { status: 200 }));
    const service = new ActiveProbeService(
      () => [managedProvider as any],
      { quotaProbeIntervalMinutes: 10 },
      undefined,
      { debug() {}, info() {}, warn() {} },
      undefined,
      () => ({ name: "sub", dispatchRequest, ensureUsable: async () => { throw Object.assign(new Error("cooling"), { code: "acct_cooling" }); } })
    );
    await service.runManagedRecoveryProbe();
    expect(dispatchRequest).not.toHaveBeenCalled();
  });

  it("probes a runtime with only ensureUsable (no dispatchRequest) via the generic attempt", async () => {
    openCircuit("s1");
    // codex/gemini shapes: no dispatcher, only a circuit breaker. The probe must
    // still run instead of silently skipping them.
    const service = new ActiveProbeService(
      () => [managedProvider as any],
      { quotaProbeIntervalMinutes: 10 },
      undefined,
      { debug() {}, info() {}, warn() {} },
      undefined,
      () => ({ name: "sub", ensureUsable: async () => {} })
    );
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: any) => {
      calls.push(String(url));
      return new Response("{}", { status: 200 });
    }) as any;
    try {
      await service.runManagedRecoveryProbe();
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(calls.length).toBe(1);
    expect(getHealthStore().isAvailable("sub", "s1")).toBe(true);
  });
});
