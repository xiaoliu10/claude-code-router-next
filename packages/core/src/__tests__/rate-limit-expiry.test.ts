import { describe, expect, it } from "vitest";
import { isQuotaWindowExpired, captureRateLimitHeaders, getAllRateLimitInfo } from "../services/rate-limit";

const NOW = Date.parse("2026-11-10T02:00:00.000Z");

describe("isQuotaWindowExpired", () => {
  it("a window whose reset has passed is expired", () => {
    const reset = Math.floor(NOW / 1000) - 60; // reset a minute ago
    expect(isQuotaWindowExpired(reset, NOW)).toBe(true);
  });

  it("a window still in the future is not expired", () => {
    const reset = Math.floor(NOW / 1000) + 3600; // an hour from now
    expect(isQuotaWindowExpired(reset, NOW)).toBe(false);
  });

  it("a reset exactly at now counts as expired", () => {
    const reset = Math.floor(NOW / 1000);
    expect(isQuotaWindowExpired(reset, NOW)).toBe(true);
  });

  it("a sample without a reset timestamp cannot be aged out", () => {
    expect(isQuotaWindowExpired(null, NOW)).toBe(false);
    expect(isQuotaWindowExpired(undefined, NOW)).toBe(false);
  });

  it("defaults to wall-clock now", () => {
    const past = Math.floor(Date.now() / 1000) - 120;
    expect(isQuotaWindowExpired(past)).toBe(true);
  });
});

describe("captureRateLimitHeaders stores samples the quota merge consumes", () => {
  it("captures x-ratelimit headers into the provider store", () => {
    captureRateLimitHeaders("quota-expiry-fixture", "https://example.invalid/v1/messages", {
      "x-ratelimit-remaining-tokens": "40",
      "x-ratelimit-limit-tokens": "100",
      "x-ratelimit-reset-tokens": String(Math.floor(NOW / 1000) + 600),
    });
    const info = getAllRateLimitInfo().find((r) => r.provider === "quota-expiry-fixture");
    expect(info).toBeDefined();
    expect(info?.limit).toBe(100);
    expect(info?.remaining).toBe(40);
    // The captured reset is in the future relative to NOW, so the quota merge
    // would present it; after the reset passes, isQuotaWindowExpired gates it.
    expect(isQuotaWindowExpired(info?.reset, NOW)).toBe(false);
    expect(isQuotaWindowExpired(info?.reset, NOW + 700_000)).toBe(true);
  });
});
