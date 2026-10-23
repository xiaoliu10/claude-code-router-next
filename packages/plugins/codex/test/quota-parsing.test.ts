/**
 * MANDATORY quota-parsing tests (supervisor ruling 2026-10-23, item D).
 *
 * The data lane owns quota PARSING; the auth lane owns storage/cooldown. These
 * four cases are the acceptance set:
 *   1. headers only
 *   2. SSE only
 *   3. both channels conflicting → later observedAt, further resetAt
 *   4. metered_limit_name !== "codex" ignored
 *
 * Plus the merge contract and the "never throws into the response path" rule.
 */
import { describe, expect, it } from "vitest";
import {
  parseCodexRateLimitsEvent,
  readCodexRateLimitHeaders,
} from "../src/transformer";
import { mergeCodexRateLimits } from "../src/protocol-quota";
import type { CodexRateLimits } from "../src/protocol-quota";

const NOW = 1_700_000_000_000;

describe("quota parsing — case 1: headers only", () => {
  it("reads primary and secondary from x-codex-* headers", () => {
    const limits = readCodexRateLimitHeaders(new Headers({
      "x-codex-primary-used-percent": "12.5",
      "x-codex-primary-window-minutes": "300",
      "x-codex-primary-reset-at": "1800000000",
      "x-codex-secondary-used-percent": "88",
      "x-codex-secondary-window-minutes": "10080",
      "x-codex-secondary-reset-after-seconds": "3600",
    }), NOW);
    expect(limits).toEqual({
      source: "headers",
      observedAt: NOW,
      primary: { usedPercent: 12.5, windowSeconds: 18000, resetAt: 1800000000000 },
      secondary: { usedPercent: 88, windowSeconds: 604800, resetAt: NOW + 3600_000 },
    });
  });

  it("returns undefined when no Codex header is present (never guesses)", () => {
    expect(readCodexRateLimitHeaders(new Headers({ "x-ratelimit-remaining": "3" }), NOW)).toBeUndefined();
    expect(readCodexRateLimitHeaders({}, NOW)).toBeUndefined();
  });
});

describe("quota parsing — case 2: SSE only", () => {
  it("reads the codex.rate_limits event", () => {
    const limits = parseCodexRateLimitsEvent({
      type: "codex.rate_limits",
      rate_limits: { primary: { used_percent: 61, window_minutes: 300, reset_at: 1800000000 } },
    }, NOW);
    expect(limits).toEqual({
      source: "sse",
      observedAt: NOW,
      primary: { usedPercent: 61, windowSeconds: 18000, resetAt: 1800000000000 },
    });
  });

  it("ignores non-quota events and malformed windows", () => {
    expect(parseCodexRateLimitsEvent({ type: "response.created" }, NOW)).toBeUndefined();
    expect(parseCodexRateLimitsEvent({ type: "codex.rate_limits", rate_limits: {} }, NOW)).toBeUndefined();
  });
});

describe("quota parsing — case 3: conflicting channels", () => {
  const headersAt = (at: number): CodexRateLimits => ({
    source: "headers", observedAt: at,
    primary: { usedPercent: 40, windowSeconds: 18000, resetAt: 1_900_000_000_000 },
  });
  const sseAt = (at: number): CodexRateLimits => ({
    source: "sse", observedAt: at,
    primary: { usedPercent: 95, windowSeconds: 18000, resetAt: 1_950_000_000_000 },
  });

  it("takes the LATER observedAt for attribution and percent", () => {
    expect(mergeCodexRateLimits(headersAt(NOW), sseAt(NOW + 5))).toMatchObject({
      observedAt: NOW + 5, source: "sse", primary: { usedPercent: 95 },
    });
  });

  it("takes the FURTHER resetAt regardless of arrival order", () => {
    const a = mergeCodexRateLimits(headersAt(NOW), sseAt(NOW + 5));
    const b = mergeCodexRateLimits(sseAt(NOW + 5), headersAt(NOW));
    expect(a.primary!.resetAt).toBe(1_950_000_000_000);
    expect(b.primary!.resetAt).toBe(1_950_000_000_000);
    expect(b.observedAt).toBe(NOW + 5);
    expect(b.source).toBe("sse");
  });

  it("keeps the EARLIER side's further reset when the LATER observation resets sooner", () => {
    // The later reading is authoritative for percent, but a window cannot free
    // up sooner than the furthest known reset says — so the further reset wins.
    const earlier = { source: "headers" as const, observedAt: NOW, primary: { usedPercent: 99, resetAt: 1_950_000_000_000 } };
    const later = { source: "sse" as const, observedAt: NOW + 10, primary: { usedPercent: 100, resetAt: 1_900_000_000_000 } };
    const merged = mergeCodexRateLimits(earlier, later);
    expect(merged.observedAt).toBe(NOW + 10);
    expect(merged.source).toBe("sse");
    expect(merged.primary!.usedPercent).toBe(100);       // later side's percent
    expect(merged.primary!.resetAt).toBe(1_950_000_000_000); // furthest reset, from the earlier side
  });

  it("keeps a window present on only one side", () => {
    const merged = mergeCodexRateLimits(
      { source: "headers", observedAt: NOW, secondary: { usedPercent: 10 } },
      { source: "sse", observedAt: NOW + 1, primary: { usedPercent: 20 } },
    );
    expect(merged.primary).toEqual({ usedPercent: 20 });
    expect(merged.secondary).toEqual({ usedPercent: 10 });
  });

  it("returns the next observation untouched when there is no previous", () => {
    const next = sseAt(NOW);
    expect(mergeCodexRateLimits(null, next)).toBe(next);
  });
});

describe("quota parsing — case 4: metered_limit_name !== codex ignored", () => {
  it("ignores a model-level limit event", () => {
    expect(parseCodexRateLimitsEvent({
      type: "codex.rate_limits",
      rate_limits: { metered_limit_name: "gpt-5.1-codex", primary: { used_percent: 100 } },
    }, NOW)).toBeUndefined();
  });

  it("accepts the account's own limit (metered_limit_name === codex or absent)", () => {
    expect(parseCodexRateLimitsEvent({
      type: "codex.rate_limits", rate_limits: { metered_limit_name: "codex", primary: { used_percent: 100 } },
    }, NOW)).toMatchObject({ primary: { usedPercent: 100 } });
    expect(parseCodexRateLimitsEvent({
      type: "codex.rate_limits", rate_limits: { primary: { used_percent: 100 } },
    }, NOW)).toMatchObject({ primary: { usedPercent: 100 } });
  });
});
