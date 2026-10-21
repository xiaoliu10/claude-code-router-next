import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Isolate the SQLite database inside a throwaway dir before the module resolves
// DATA_DIR (computed at import time). CCR_CONFIG_DIR must be overridden too:
// vitest.config.ts sets it for every worker and HOME_DIR prefers it over HOME,
// so overriding HOME alone left this suite reading/writing the SHARED test DB —
// any data-plane test scheduled before it (which appends usage rows through the
// request pipeline) then changed these aggregate counts, making the suite
// order-dependent/flaky.
const tempHome = mkdtempSync(join(tmpdir(), "ccr-usage-summary-"));
process.env.CCR_CONFIG_DIR = tempHome;
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

const { append, query, querySummary } = await import("../ccr/usage-store");

type AppendInput = Parameters<typeof append>[0];

function makeRecord(overrides: Partial<AppendInput>): AppendInput {
  return {
    id: `rec-${Math.random().toString(36).slice(2)}`,
    timestamp: "2026-08-01T10:00:00.000Z",
    sessionId: "session-1",
    provider: "providerA",
    originalModel: "ccr-opus",
    model: "m1",
    modelFamily: "opus",
    scenarioType: "default",
    clientType: "claude-code",
    stream: true,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    ttft: null,
    tokensPerSecond: null,
    durationMs: 1000,
    status: "success",
    ...overrides,
  } as AppendInput;
}

function seed(): void {
  // Success: full tokens + ttft + computable speed.
  append(makeRecord({
    id: "rec-1",
    inputTokens: 100,
    outputTokens: 50,
    cacheReadInputTokens: 10,
    cacheCreationInputTokens: 5,
    ttft: 100,
    durationMs: 3000,
  }));

  // Success in the image scenario, different client, zero output -> no speed.
  append(makeRecord({
    id: "rec-2",
    timestamp: "2026-08-02T09:30:00.000Z",
    model: "m1",
    scenarioType: "image",
    clientType: "codex",
    inputTokens: 200,
    outputTokens: 0,
    ttft: 300,
    durationMs: 1500,
  }));

  // Error: tokens must not be counted, empty family, missing client type.
  append(makeRecord({
    id: "rec-3",
    provider: "providerB",
    model: "m2",
    modelFamily: "",
    clientType: undefined,
    inputTokens: 999,
    outputTokens: 999,
    status: "error",
    errorMessage: "boom",
  }));

  // Success with empty client type -> grouped under "unknown".
  append(makeRecord({
    id: "rec-4",
    timestamp: "2026-08-02T11:00:00.000Z",
    inputTokens: 300,
    outputTokens: 40,
    cacheReadInputTokens: 20,
    ttft: 200,
    durationMs: 2000,
    clientType: "",
  }));
}

afterAll(() => {
  rmSync(tempHome, { recursive: true, force: true });
});

describe("SQL usage summary", () => {
  beforeAll(() => {
    seed();
  });

  it("matches the legacy JS aggregation semantics", () => {
    const summary = querySummary();

    expect(summary.totalRequests).toBe(4);
    expect(summary.successCount).toBe(3);
    expect(summary.errorCount).toBe(1);

    // Tokens are counted for successful requests only.
    expect(summary.totalInputTokens).toBe(600);
    expect(summary.totalOutputTokens).toBe(90);
    expect(summary.totalCacheReadInputTokens).toBe(30);
    expect(summary.totalCacheCreationInputTokens).toBe(5);

    expect(summary.avgTtft).toBe(200); // (100 + 300 + 200) / 3
    // Normalized speeds: rec-1 -> 17 t/s, rec-4 -> 22 t/s; rec-2 has none.
    expect(summary.avgTokensPerSecond).toBe(20);

    expect(summary.byModel.m1).toEqual({
      count: 3,
      inputTokens: 600,
      outputTokens: 90,
      cacheReadInputTokens: 30,
      cacheCreationInputTokens: 5,
    });
    // Error row is counted in the model bucket but contributes no tokens.
    expect(summary.byModel.m2.count).toBe(1);
    expect(summary.byModel.m2.inputTokens).toBe(0);

    expect(summary.byProvider.providerA.count).toBe(3);
    expect(summary.byProvider.providerB.inputTokens).toBe(0);

    expect(summary.byScenario.default.count).toBe(3);
    expect(summary.byScenario.image.count).toBe(1);
    expect(summary.byScenario.image.inputTokens).toBe(200);

    // Family buckets use "<family>/<scenario>" keys and skip empty families.
    expect(summary.byFamily["opus/default"].count).toBe(2);
    expect(summary.byFamily["opus/image"].count).toBe(1);
    expect(Object.keys(summary.byFamily)).toHaveLength(2);

    expect(summary.byDay["2026-08-01"].count).toBe(2);
    expect(summary.byDay["2026-08-02"].count).toBe(2);

    // Null and empty client types both collapse into "unknown".
    expect(summary.byClient["claude-code"].count).toBe(1);
    expect(summary.byClient.codex.count).toBe(1);
    expect(summary.byClient.unknown.count).toBe(2);
  });

  it("applies time range and status filters", () => {
    const day2 = querySummary("2026-08-02T00:00:00.000Z", "2026-08-02T23:59:59.999Z");
    expect(day2.totalRequests).toBe(2);
    expect(day2.totalInputTokens).toBe(500);

    const successOnly = querySummary(undefined, undefined, "success");
    expect(successOnly.totalRequests).toBe(3);
    expect(successOnly.errorCount).toBe(0);

    const errorsOnly = querySummary(undefined, undefined, "error");
    expect(errorsOnly.totalRequests).toBe(1);
    expect(errorsOnly.totalInputTokens).toBe(0);
  });

  it("returns empty aggregates without matching rows", () => {
    const empty = querySummary("2030-01-01T00:00:00.000Z", "2030-01-02T00:00:00.000Z");
    expect(empty.totalRequests).toBe(0);
    expect(empty.successCount).toBe(0);
    expect(empty.errorCount).toBe(0);
    expect(empty.avgTtft).toBeNull();
    expect(empty.avgTokensPerSecond).toBeNull();
    expect(empty.byModel).toEqual({});
    expect(empty.byClient).toEqual({});
  });

  it("combines paged records with the SQL summary in query()", () => {
    const result = query({ provider: "providerA", page: 1, pageSize: 2 });
    expect(result.total).toBe(3);
    expect(result.records).toHaveLength(2);
    expect(result.summary.totalRequests).toBe(3);
    expect(result.summary.totalInputTokens).toBe(600);
    expect(result.summary.byProvider.providerA.count).toBe(3);
    expect(result.summary.byProvider.providerB).toBeUndefined();
  });
});

describe("non-stream ttft/tps semantics", () => {
  // Non-streaming responses arrive as one payload: TTFT is meaningless and
  // must stay null; speed is tokens over total duration (no decode-phase
  // subtraction, no 1s-clamp inflation).
  it("keeps ttft null for non-stream records and computes tps over total duration", () => {
    const records = query({ provider: "providerNS" });
    const before = records.total;
    const summaryBefore = querySummary();

    append(makeRecord({
      id: "ns-1",
      provider: "providerNS",
      stream: false,
      ttft: null,
      outputTokens: 100,
      durationMs: 50000,
    }));
    append(makeRecord({
      id: "ns-2",
      provider: "providerNS",
      stream: false,
      // Simulate a stale writer that still reports duration-as-TTFT for
      // non-stream requests — normalization must not let it clamp the
      // decode window to 1s and report 100 tok/s.
      ttft: 50000,
      outputTokens: 100,
      durationMs: 50000,
    }));

    const rows = query({ provider: "providerNS", page: 1, pageSize: 10 });
    expect(rows.total - before).toBe(2);
    expect(rows.records.filter((r: any) => r.id === "ns-1")[0].ttft).toBeNull();
    expect(rows.records.filter((r: any) => r.id === "ns-1")[0].tokensPerSecond).toBe(2);
    // Stale duration-as-TTFT input on a non-stream record is stripped to null.
    expect(rows.records.filter((r: any) => r.id === "ns-2")[0].ttft).toBeNull();
    expect(rows.records.filter((r: any) => r.id === "ns-2")[0].tokensPerSecond).toBe(2);

    // avgTtft ignores non-stream rows; only pre-seeded stream rows count.
    const after = querySummary();
    expect(after.avgTtft).toBe(summaryBefore.avgTtft);
  });
});
