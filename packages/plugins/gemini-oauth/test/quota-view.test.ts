import { describe, expect, it } from "vitest";
import {
  buildQuotaModelRows, buildQuotaPoolRows, formatQuotaPercent, parseQuotaSnapshot,
  quotaModelFamily, quotaPoolIdentity,
} from "../src/quota-view";

const NOW = Date.parse("2026-11-13T12:00:00.000Z");
const FUTURE = "2026-11-13T18:00:00.000Z";
const PAST = "2026-11-13T06:00:00.000Z";

describe("parseQuotaSnapshot — structural validation of an untrusted payload", () => {
  it("passes a well-formed snapshot through with normalized ISO resets", () => {
    const view = parseQuotaSnapshot({
      models: {
        "gemini-4-argon": { remaining: 0.4, resetAt: "2026-11-13T18:00:00Z" },
        "claude-sonnet-4-6": { remaining: 0.9 },
      },
      pools: [
        { pool: "Gemini", window: "5h", remaining: 0.25, resetAt: "2026-11-13T17:00:00Z" },
        { pool: "Claude & GPT", window: "weekly", remaining: 0.95 },
      ],
      // Backend may add metadata later: unknown fields are ignored safely.
      fetchedAt: "2026-11-13T12:00:00Z", ttlMs: 30000,
    }, NOW);
    expect(view).toEqual({
      models: {
        "gemini-4-argon": { remaining: 0.4, resetAt: FUTURE },
        "claude-sonnet-4-6": { remaining: 0.9 },
      },
      pools: [
        { pool: "Gemini", window: "5h", remaining: 0.25, resetAt: "2026-11-13T17:00:00.000Z" },
        { pool: "Claude & GPT", window: "weekly", remaining: 0.95 },
      ],
    });
  });

  it("treats an empty-but-well-formed snapshot as valid (no figures, not an error)", () => {
    expect(parseQuotaSnapshot({ models: {}, pools: [] }, NOW)).toEqual({ models: {}, pools: [] });
    expect(parseQuotaSnapshot({}, NOW)).toEqual({ models: {}, pools: [] });
  });

  it.each([null, undefined, 42, "snapshot", [], true])
    ("rejects non-object payload %p as null", (input) => {
      expect(parseQuotaSnapshot(input, NOW)).toBeNull();
    });

  it("rejects wrongly shaped collections", () => {
    expect(parseQuotaSnapshot({ models: [] }, NOW)).toBeNull();
    expect(parseQuotaSnapshot({ pools: {} }, NOW)).toBeNull();
    expect(parseQuotaSnapshot({ models: null, pools: 42 }, NOW)).toBeNull();
  });

  it("drops buckets with missing/non-numeric remaining instead of inventing zero", () => {
    const view = parseQuotaSnapshot({
      models: {
        "gemini-4-argon": { remaining: 0.5 },
        "gemini-4-hydrogen": { remaining: "0.2" }, // numeric string coerces
        "gemini-3-flash": {},
        "gemini-3-pro": { remaining: null },
        "gemini-2.5": { remaining: Number.NaN },
        "gemini-bool": { remaining: true },
      },
      pools: [
        { pool: "Gemini", window: "5h", remaining: 1 },
        { pool: "Gemini", window: "weekly" }, // no figure: dropped
      ],
    }, NOW);
    expect(Object.keys(view!.models).sort()).toEqual(["gemini-4-argon", "gemini-4-hydrogen"]);
    expect(view!.models).toEqual({
      "gemini-4-argon": { remaining: 0.5 },
      "gemini-4-hydrogen": { remaining: 0.2 },
    });
    expect(view!.pools).toEqual([{ pool: "Gemini", window: "5h", remaining: 1 }]);
  });

  it("keeps an explicit zero (exhausted) — unavailable never masquerades as full or empty", () => {
    const view = parseQuotaSnapshot({
      models: { "gemini-4-argon": { remaining: 0 } },
      pools: [{ pool: "Gemini", window: "5h", remaining: 0 }],
    }, NOW);
    expect(view!.models["gemini-4-argon"].remaining).toBe(0);
    expect(view!.pools[0].remaining).toBe(0);
  });

  it("drops expired or unparseable reset timestamps while keeping the figure", () => {
    const view = parseQuotaSnapshot({
      models: {
        "gemini-4-argon": { remaining: 0.4, resetAt: PAST },
        "gemini-4-hydrogen": { remaining: 0.7, resetAt: "not-a-date" },
      },
      pools: [
        { pool: "Gemini", window: "5h", remaining: 0.3, resetAt: PAST },
        { pool: "Gemini", window: "weekly", remaining: 0.8, resetAt: FUTURE },
      ],
    }, NOW);
    expect(view!.models["gemini-4-argon"]).toEqual({ remaining: 0.4 });
    expect(view!.models["gemini-4-hydrogen"]).toEqual({ remaining: 0.7 });
    expect(view!.pools[0]).toEqual({ pool: "Gemini", window: "5h", remaining: 0.3 });
    expect(view!.pools[1].resetAt).toBe(FUTURE);
  });

  it("rejects malformed ids/labels and non-object buckets without losing siblings", () => {
    const view = parseQuotaSnapshot({
      models: {
        "bad id": { remaining: 0.1 }, // whitespace: not a valid model id
        "": { remaining: 0.2 },
        [`a${"a".repeat(256)}`]: { remaining: 0.3 }, // 257 chars: over the service bound
        "gemini-4,argon": { remaining: 0.4 }, // comma is excluded from the model-id grammar
        "gemini-4-argon": "junk",
        "claude-opus-4-6": { remaining: 0.6 },
      },
      pools: [
        null,
        { pool: "", window: "5h", remaining: 0.1 },
        { pool: "Gemini", window: "", remaining: 0.1 },
        { pool: "Gemini", window: "5h", remaining: 0.2 },
      ],
    }, NOW);
    expect(Object.keys(view!.models)).toEqual(["claude-opus-4-6"]);
    expect(view!.pools).toEqual([{ pool: "Gemini", window: "5h", remaining: 0.2 }]);
  });
});

describe("quota identity and effort family grammar", () => {
  it("strips only known effort suffixes", () => {
    expect(quotaModelFamily("gemini-4-argon-high")).toBe("gemini-4-argon");
    expect(quotaModelFamily("gemini-4-argon-extra-low")).toBe("gemini-4-argon");
    expect(quotaModelFamily("gemini-4-argon")).toBe("gemini-4-argon");
    expect(quotaModelFamily("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
  });

  it("classifies only explicit Argon/Hydrogen/Claude tokens and never merges by a gemini prefix", () => {
    expect(quotaPoolIdentity("gemini-4-argon")).toBe("argon");
    expect(quotaPoolIdentity("gemini-4-hydrogen-low")).toBe("hydrogen");
    expect(quotaPoolIdentity("claude-sonnet-4-6")).toBe("claude");
    expect(quotaPoolIdentity("gemini-3-flash")).toBe("other");
    expect(quotaPoolIdentity("some-future-model")).toBe("other");
  });
});

describe("buildQuotaModelRows — independent buckets, conservative folding", () => {
  const view = (models: Record<string, { remaining: number; resetAt?: string }>) =>
    parseQuotaSnapshot({ models, pools: [] }, NOW)!;

  it("keeps Argon, Hydrogen and Claude rows distinct even at identical percentages", () => {
    const rows = buildQuotaModelRows(view({
      "gemini-4-argon": { remaining: 0.5 },
      "gemini-4-hydrogen": { remaining: 0.5 },
      "claude-sonnet-4-6": { remaining: 0.5 },
    }));
    expect(rows.map(r => [r.identity, r.family])).toEqual([
      ["argon", "gemini-4-argon"],
      ["hydrogen", "gemini-4-hydrogen"],
      ["claude", "claude-sonnet-4-6"],
    ]);
  });

  it("folds effort variants only while every figure is identical, naming every source id", () => {
    const rows = buildQuotaModelRows(view({
      "gemini-4-argon-low": { remaining: 0.2, resetAt: FUTURE },
      "gemini-4-argon-medium": { remaining: 0.2, resetAt: FUTURE },
      "gemini-4-argon-high": { remaining: 0.2, resetAt: FUTURE },
    }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ family: "gemini-4-argon", identity: "argon", remaining: 0.2 });
    expect(rows[0].variants).toEqual([
      "gemini-4-argon-high", "gemini-4-argon-low", "gemini-4-argon-medium",
    ]);
  });

  it("keeps originals when effort variants disagree; no aggregation hides a divergence", () => {
    const rows = buildQuotaModelRows(view({
      "gemini-4-argon-low": { remaining: 0.2 },
      "gemini-4-argon-high": { remaining: 0.8 },
    }));
    expect(rows.map(r => r.family).sort()).toEqual(["gemini-4-argon-high", "gemini-4-argon-low"]);
    expect(rows.every(r => r.variants.length === 0)).toBe(true);
  });

  it("an exhausted Argon bucket does not hide the healthy Hydrogen/Claude buckets", () => {
    const rows = buildQuotaModelRows(view({
      "gemini-4-argon": { remaining: 0, resetAt: FUTURE },
      "gemini-4-hydrogen": { remaining: 0.7 },
      "claude-sonnet-4-6": { remaining: 1 },
    }));
    expect(rows.map(r => [r.family, r.remaining])).toEqual([
      ["gemini-4-argon", 0],
      ["gemini-4-hydrogen", 0.7],
      ["claude-sonnet-4-6", 1],
    ]);
  });

  it("unknown models isolate by their own family instead of joining a broad Gemini group", () => {
    const rows = buildQuotaModelRows(view({
      "gemini-3-flash": { remaining: 0.3 },
      "gemini-3-pro": { remaining: 0.3 },
      "gemini-4-argon": { remaining: 0.3 },
    }));
    expect(rows.filter(r => r.identity === "other").map(r => r.family).sort())
      .toEqual(["gemini-3-flash", "gemini-3-pro"]);
  });
});

describe("buildQuotaPoolRows — upstream grouped windows keep their own labels", () => {
  it("preserves pool name and 5h/weekly window and never reassigns a figure to a model", () => {
    const snapshot = parseQuotaSnapshot({
      models: { "gemini-4-argon": { remaining: 0.4 } },
      pools: [
        { pool: "Gemini", window: "weekly", remaining: 0.8 },
        { pool: "Gemini", window: "5h", remaining: 0.25 },
        { pool: "Claude & GPT", window: "5h", remaining: 0.55 },
      ],
    }, NOW)!;
    expect(buildQuotaPoolRows(snapshot)).toEqual([
      { pool: "Claude & GPT", window: "5h", remaining: 0.55 },
      { pool: "Gemini", window: "5h", remaining: 0.25 },
      { pool: "Gemini", window: "weekly", remaining: 0.8 },
    ]);
    // The model bucket still carries no window label of any kind.
    expect(buildQuotaModelRows(snapshot)[0]).not.toHaveProperty("window");
  });
});

describe("formatQuotaPercent", () => {
  it("rounds to whole percents and clamps to the 0–100 range", () => {
    expect(formatQuotaPercent(0.254)).toBe("25%");
    expect(formatQuotaPercent(0)).toBe("0%");
    expect(formatQuotaPercent(1)).toBe("100%");
    expect(formatQuotaPercent(-0.2)).toBe("0%");
    expect(formatQuotaPercent(1.5)).toBe("100%");
  });
});
