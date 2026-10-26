import { describe, it, expect, beforeEach } from "vitest";
import { ProviderHealthStore } from "../services/provider-health";

describe("ProviderHealthStore", () => {
  let store: ProviderHealthStore;

  beforeEach(() => {
    store = new ProviderHealthStore({ enabled: true });
  });

  // --- Empty provider/model guards (consolidated in getKey) ---

  describe("empty provider/model guards", () => {
    it("recordSuccess should be a no-op with empty provider", () => {
      store.recordSuccess("", "model-a");
      expect(store.getState("", "model-a")).toBeUndefined();
    });

    it("recordSuccess should be a no-op with empty model", () => {
      store.recordSuccess("provider-a", "");
      expect(store.getState("provider-a", "")).toBeUndefined();
    });

    it("recordFailure should be a no-op with empty provider", () => {
      store.recordFailure("", "model-a", "err");
      expect(store.getState("", "model-a")).toBeUndefined();
    });

    it("recordFailure should be a no-op with empty model", () => {
      store.recordFailure("provider-a", "", "err");
      expect(store.getState("provider-a", "")).toBeUndefined();
    });

    it("isAvailable should return false with empty provider", () => {
      expect(store.isAvailable("", "model-a")).toBe(false);
    });

    it("isAvailable should return false with empty model", () => {
      expect(store.isAvailable("provider-a", "")).toBe(false);
    });

    it("getState should return undefined with empty provider", () => {
      expect(store.getState("", "model-a")).toBeUndefined();
    });

    it("getState should return undefined with empty model", () => {
      expect(store.getState("provider-a", "")).toBeUndefined();
    });

    it("getPriority should return 2 (worst) with empty provider", () => {
      expect(store.getPriority("", "model-a")).toBe(2);
    });

    it("getPriority should return 2 (worst) with empty model", () => {
      expect(store.getPriority("provider-a", "")).toBe(2);
    });

    it("forceOpen should be a no-op with empty provider", () => {
      store.forceOpen("", "model-a");
      expect(store.getState("", "model-a")).toBeUndefined();
    });

    it("markRateLimited should be a no-op with empty provider", () => {
      store.markRateLimited("", "model-a");
      expect(store.getState("", "model-a")).toBeUndefined();
    });

    it("recover should be a no-op with empty provider", () => {
      // Should not throw
      store.recover("", "model-a");
    });

    it("restore should skip entries with empty provider", () => {
      store.restore({
        provider: "",
        model: "model-a",
        status: "open",
        failureCount: 3,
        successCount: 0,
        lastFailureTime: Date.now(),
        lastProbeTime: 0,
      });
      expect(store.getAllStates()).toHaveLength(0);
    });

    it("markProbeAttempt should be a no-op with empty provider", () => {
      // Should not throw
      store.markProbeAttempt("", "model-a");
    });
  });

  // --- Normal operation (ensure guards don't break valid inputs) ---

  describe("normal operation", () => {
    it("recordFailure should track state for valid provider/model", () => {
      store.recordFailure("provider-a", "model-a", "timeout");
      const state = store.getState("provider-a", "model-a");
      expect(state).toBeDefined();
      expect(state!.failureCount).toBe(1);
      expect(state!.status).toBe("closed");
    });

    it("recordFailure should transition to open after threshold", () => {
      store.recordFailure("provider-a", "model-a", "err");
      store.recordFailure("provider-a", "model-a", "err");
      store.recordFailure("provider-a", "model-a", "err");
      const state = store.getState("provider-a", "model-a");
      expect(state!.status).toBe("open");
    });

    it("isAvailable should return true for healthy models", () => {
      expect(store.isAvailable("provider-a", "model-a")).toBe(true);
    });

    it("isAvailable should return false for open (failed) models", () => {
      store.recordFailure("provider-a", "model-a", "err");
      store.recordFailure("provider-a", "model-a", "err");
      store.recordFailure("provider-a", "model-a", "err");
      expect(store.isAvailable("provider-a", "model-a")).toBe(false);
    });

    it("forceOpen should mark model as unavailable immediately", () => {
      store.forceOpen("provider-a", "model-a", "manual");
      expect(store.isAvailable("provider-a", "model-a")).toBe(false);
    });

    it("recordSuccess should recover half-open model", () => {
      store.forceOpen("provider-a", "model-a");
      // Manually set to half-open
      const state = store.getState("provider-a", "model-a")!;
      state.status = "half-open";
      state.successCount = 0;

      store.recordSuccess("provider-a", "model-a");
      store.recordSuccess("provider-a", "model-a");
      expect(store.getState("provider-a", "model-a")).toBeUndefined(); // deleted = fully recovered
    });
  });
});

describe("expired rateLimitUntil recovery (managed-provider stuck-open fix)", () => {
  let store: ProviderHealthStore;
  beforeEach(() => { store = new ProviderHealthStore({ enabled: true }); });

  it("a real success clears an EXPIRED cooldown and a second success closes the breaker", () => {
    store.forceOpen("workbuddy", "deepseek-v4.1-flash", "old failure");
    const state = store.getState("workbuddy", "deepseek-v4.1-flash")!;
    state.rateLimitUntil = Date.now() - 1000; // expired yesterday-style cooldown
    state.lastError = "Provider plugin returned an invalid upstream response.";

    // Success while cooldown expired: open → half-open (like a probe success).
    store.recordSuccess("workbuddy", "deepseek-v4.1-flash");
    let after = store.getState("workbuddy", "deepseek-v4.1-flash")!;
    expect(after.status).toBe("half-open");
    expect(after.rateLimitUntil).toBeUndefined();

    // Second success reaches halfOpenSuccessThreshold (2) → fully closed.
    store.recordSuccess("workbuddy", "deepseek-v4.1-flash");
    expect(store.getState("workbuddy", "deepseek-v4.1-flash")).toBeUndefined();
    expect(store.isAvailable("workbuddy", "deepseek-v4.1-flash")).toBe(true);
  });

  it("recovers an expired cooldown immediately when the success threshold is one", () => {
    const one = new ProviderHealthStore({ enabled: true, halfOpenSuccessThreshold: 1 });
    one.forceOpen("workbuddy", "m", "old failure");
    one.getState("workbuddy", "m")!.rateLimitUntil = Date.now() - 1000;
    one.recordSuccess("workbuddy", "m");
    expect(one.getState("workbuddy", "m")).toBeUndefined();
  });

  it("preserves no-cooldown recovery when the threshold is one", () => {
    const one = new ProviderHealthStore({ enabled: true, halfOpenSuccessThreshold: 1 });
    one.forceOpen("workbuddy", "m", "old failure");
    one.recordSuccess("workbuddy", "m");
    expect(one.getState("workbuddy", "m")?.status).toBe("half-open");
    one.recordSuccess("workbuddy", "m");
    expect(one.getState("workbuddy", "m")).toBeUndefined();
  });

  it("allows stale managed failures to recover through authenticated routed requests only", () => {
    store.forceOpen("workbuddy-ai", "m", "old network failure");
    const state = store.getState("workbuddy-ai", "m")!;
    state.lastFailureTime = Date.now() - 6 * 60_000;
    expect(store.isAvailable("workbuddy-ai", "m")).toBe(false);
    expect(store.isAvailable("workbuddy-ai", "m", true)).toBe(true);
    expect(state.status).toBe("half-open");
    store.recordSuccess("workbuddy-ai", "m");
    store.recordSuccess("workbuddy-ai", "m");
    expect(store.getState("workbuddy-ai", "m")).toBeUndefined();
  });

  it("keeps recent managed failures and active quota locks closed to recovery probes", () => {
    store.forceOpen("workbuddy-ai", "m", "recent failure");
    expect(store.isAvailable("workbuddy-ai", "m", true)).toBe(false);
    const state = store.getState("workbuddy-ai", "m")!;
    state.lastFailureTime = Date.now() - 6 * 60_000;
    state.rateLimitUntil = Date.now() + 60_000;
    expect(store.isAvailable("workbuddy-ai", "m", true)).toBe(false);
    expect(state.status).toBe("open");
  });

  it("an UNEXPIRED cooldown still blocks recovery (quota lock preserved)", () => {
    store.forceOpen("workbuddy", "m", "failure");
    const state = store.getState("workbuddy", "m")!;
    state.rateLimitUntil = Date.now() + 3_600_000;

    store.recordSuccess("workbuddy", "m");
    const after = store.getState("workbuddy", "m")!;
    expect(after.status).toBe("open");
    expect(after.rateLimitUntil).toBeGreaterThan(Date.now());
    expect(store.isAvailable("workbuddy", "m")).toBe(false);
  });
});
