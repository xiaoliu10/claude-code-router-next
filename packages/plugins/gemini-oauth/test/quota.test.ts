import { describe, expect, it } from "vitest";
import {
  fetchGeminiOauthQuota,
  geminiQuotaPoolName,
  geminiQuotaToProviderQuota,
  type GeminiOauthFetch,
} from "../src/protocol";

/** Route Code Assist calls by method name; unmatched calls throw. */
function upstream(routes: Record<string, any>): { impl: GeminiOauthFetch; calls: string[] } {
  const calls: string[] = [];
  const impl = (async (url: string, init: any) => {
    const method = String(url).split("v1internal:")[1] ?? "";
    calls.push(method);
    const body = routes[method];
    if (body === undefined) return new Response(JSON.stringify({ error: { message: "unsupported" } }), { status: 404 });
    if (body instanceof Error) throw body;
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as GeminiOauthFetch;
  return { impl, calls };
}

describe("gemini quota pool names", () => {
  it("strips the ' models' suffix and joins with an ampersand", () => {
    expect(geminiQuotaPoolName("Gemini Models")).toBe("Gemini");
    expect(geminiQuotaPoolName("Claude and GPT models")).toBe("Claude & GPT");
    expect(geminiQuotaPoolName("   ")).toBe("");
    expect(geminiQuotaPoolName(undefined)).toBe("");
  });
});

describe("fetchGeminiOauthQuota", () => {
  it("reads per-model buckets and grouped windows from the real endpoints", async () => {
    const { impl, calls } = upstream({
      retrieveUserQuota: {
        buckets: [
          { modelId: "gemini-3-flash", remainingFraction: 0.4, resetTime: "2026-10-26T10:00:00Z" },
          { modelId: "claude-sonnet-4-6", remainingFraction: 0.9 },
          { modelId: "gemini-3-flash_vertex", remainingFraction: 0.1 },
        ],
      },
      retrieveUserQuotaSummary: {
        groups: [
          { displayName: "Gemini Models", buckets: [
            { window: "5h", remainingFraction: 0.25, resetTime: "2026-10-26T09:00:00Z" },
            { window: "weekly", remainingFraction: 0.8, resetTime: "2026-11-02T00:00:00Z" },
          ] },
          { displayName: "Claude and GPT models", buckets: [
            { window: "5h", remainingFraction: 0.55 },
            { window: "weekly", remainingFraction: 0.95 },
            { window: "5h", remainingFraction: 0, disabled: true },
          ] },
        ],
      },
    });
    const quota = await fetchGeminiOauthQuota({ accessToken: "t", project: "p", fetchImpl: impl });
    expect(calls).toEqual(["retrieveUserQuota", "retrieveUserQuotaSummary"]);
    expect(quota.models).toEqual({
      "gemini-3-flash": { remaining: 0.4, resetAt: "2026-10-26T10:00:00.000Z" },
      "claude-sonnet-4-6": { remaining: 0.9 },
    });
    expect(quota.pools).toEqual([
      { pool: "Gemini Models", window: "5h", remaining: 0.25, resetAt: "2026-10-26T09:00:00.000Z" },
      { pool: "Gemini Models", window: "weekly", remaining: 0.8, resetAt: "2026-11-02T00:00:00.000Z" },
      { pool: "Claude and GPT models", window: "5h", remaining: 0.55 },
      { pool: "Claude and GPT models", window: "weekly", remaining: 0.95 },
    ]);
  });

  it("treats null/empty/non-numeric fractions as missing, not zero, and keeps original group names", async () => {
    const { impl } = upstream({
      retrieveUserQuota: { buckets: [
        { modelId: "gemini-4-argon", remainingFraction: null },
        { modelId: "gemini-4-argon-high", remainingFraction: "" },
        { modelId: "gemini-4-hydrogen", remainingFraction: "0.4" },
        { modelId: "gemini-4-hydrogen-low", remainingFraction: false },
        { modelId: "bad-fraction", remainingFraction: 1.5 },
      ] },
      retrieveUserQuotaSummary: { groups: [
        { displayName: "Gemini Models", buckets: [{ window: "5h", remainingFraction: null }] },
        { displayName: "GEMINI 4 ARGON", buckets: [{ window: "weekly", remainingFraction: "0.2" }] },
      ] },
    });
    const quota = await fetchGeminiOauthQuota({ accessToken: "t", project: "p", fetchImpl: impl });
    expect(quota.models).toEqual({ "gemini-4-hydrogen": { remaining: 0.4 } });
    expect(quota.pools).toEqual([
      { pool: "GEMINI 4 ARGON", window: "weekly", remaining: 0.2 },
    ]);
  });

  it("keeps working when the summary is unavailable", async () => {
    const { impl } = upstream({
      retrieveUserQuota: { buckets: [{ modelId: "gemini-3-flash", remainingFraction: 0.5 }] },
      retrieveUserQuotaSummary: new Error("boom"),
    });
    const quota = await fetchGeminiOauthQuota({ accessToken: "t", project: "p", fetchImpl: impl });
    expect(quota.models["gemini-3-flash"]).toEqual({ remaining: 0.5 });
    expect(quota.pools).toEqual([]);
  });

  it("never invents windows when both endpoints fail", async () => {
    const { impl } = upstream({ retrieveUserQuota: new Error("x"), retrieveUserQuotaSummary: new Error("y") });
    const quota = await fetchGeminiOauthQuota({ accessToken: "t", project: "p", fetchImpl: impl });
    expect(quota).toEqual({ models: {}, pools: [] });
  });
});

describe("geminiQuotaToProviderQuota", () => {
  it("maps the worst pool per window onto the 5h/7d contract", () => {
    const out = geminiQuotaToProviderQuota({
      models: {},
      pools: [
        { pool: "Gemini", window: "5h", remaining: 0.25, resetAt: "2026-10-26T09:00:00.000Z" },
        { pool: "Claude & GPT", window: "5h", remaining: 0.1 },
        { pool: "Gemini", window: "weekly", remaining: 0.8 },
        { pool: "Claude & GPT", window: "weekly", remaining: 0.95, resetAt: "2026-11-02T00:00:00.000Z" },
      ],
    });
    expect(out).toEqual({
      usedDailyBalance: 90,
      limitDaily: 100,
      resetTime: "2026-10-26T09:00:00.000Z",
      usedBalance: 20,
      totalBalance: 100,
      resetTime7d: "2026-11-02T00:00:00.000Z",
    });
  });

  it("falls back to per-model buckets for the 5h window only", () => {
    const out = geminiQuotaToProviderQuota({
      models: { a: { remaining: 0.5 }, b: { remaining: 0.2, resetAt: "2026-10-26T09:00:00.000Z" } },
      pools: [],
    });
    expect(out).toEqual({ usedDailyBalance: 80, limitDaily: 100, resetTime: "2026-10-26T09:00:00.000Z" });
    expect(out!.usedBalance).toBeUndefined();
  });

  it("returns null when upstream reported no figures at all", () => {
    expect(geminiQuotaToProviderQuota({ models: {}, pools: [] })).toBeNull();
    expect(geminiQuotaToProviderQuota({ models: { a: {} }, pools: [{ pool: "Gemini", window: "5h" }] })).toBeNull();
  });
});
