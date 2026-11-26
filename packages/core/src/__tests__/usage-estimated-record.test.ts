import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Isolate the SQLite database inside a throwaway dir before the module resolves
// DATA_DIR (same pattern as usage-summary-sql.test.ts).
const tempHome = mkdtempSync(join(tmpdir(), "ccr-usage-estimated-"));
process.env.CCR_CONFIG_DIR = tempHome;
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

const { append, query, querySummary, clear, close } = await import("../ccr/usage-store");
const { openSqliteDatabase } = await import("@wengine-ai/claude-code-router-shared");

type AppendInput = Parameters<typeof append>[0];

function makeRecord(overrides: Partial<AppendInput>): AppendInput {
  return {
    id: `rec-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date().toISOString(),
    sessionId: "session-est",
    provider: "kiro-subscription",
    originalModel: "claude-routed",
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

describe("usage store estimated flag", () => {
  it("persists and returns the estimated marker on usage records and summary", () => {
    clear();
    append(makeRecord({ id: "est-1", usageEstimated: true, inputTokens: 12, outputTokens: 2 }));
    append(makeRecord({ id: "exact-1", inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 4 }));

    const result = query({ sessionId: "session-est" });
    const byId = new Map(result.records.map((r) => [r.id, r]));
    expect(byId.get("est-1")?.usageEstimated).toBe(true);
    // Untouched providers keep the flag undefined/false.
    expect(byId.get("exact-1")?.usageEstimated).toBeFalsy();

    const summary = querySummary();
    expect(summary.estimatedCount).toBe(1);
    expect(summary.totalInputTokens).toBe(112);
    expect(summary.totalOutputTokens).toBe(52);
    expect(summary.totalCacheCreationInputTokens).toBe(4);
    expect(byId.get("exact-1")?.cacheCreationInputTokens).toBe(4);
    // Reopen to exercise persisted provenance, not an in-memory object.
    close();
    expect(query({ sessionId: "session-est" }).records.find(r => r.id === "est-1")?.usageEstimated).toBe(true);
  });

  it("keeps ordinary records deeply equal across v2 -> v3 migration and reopen", () => {
    clear();
    append(makeRecord({ id: "ordinary-v2", provider: "ordinary", inputTokens: 50, outputTokens: 3, cacheCreationInputTokens: 7 }));
    const before = query({ sessionId: "session-est" });
    const { estimatedCount, ...summaryBefore } = querySummary();
    expect(estimatedCount).toBe(0);
    expect(before.records[0]).not.toHaveProperty("usageEstimated");
    close();
    // Recreate a genuine v2 table: no provenance column, user_version=2.
    const legacy = openSqliteDatabase(join(tempHome, "data", "usage.sqlite")).db;
    legacy.exec("ALTER TABLE usage_records DROP COLUMN effective_input_tokens");
    legacy.exec("ALTER TABLE usage_records DROP COLUMN effective_input_estimated");
    legacy.exec("ALTER TABLE usage_records DROP COLUMN usage_estimated");
    legacy.pragma("user_version = 2");
    legacy.close();

    expect(query({ sessionId: "session-est" })).toEqual(before);
    const { estimatedCount: migratedCount, ...summaryAfter } = querySummary();
    expect(migratedCount).toBe(0);
    expect(summaryAfter).toEqual(summaryBefore);
    append(makeRecord({ id: "ordinary-v3", provider: "ordinary", inputTokens: 50, outputTokens: 3, cacheCreationInputTokens: 7 }));
    const rows = query({ sessionId: "session-est" }).records;
    const oldRow = rows.find(record => record.id === "ordinary-v2")!;
    const newRow = rows.find(record => record.id === "ordinary-v3")!;
    expect({ ...newRow, id: oldRow.id, timestamp: oldRow.timestamp }).toEqual(oldRow);
    close();
    expect(query({ sessionId: "session-est" }).records).toEqual(rows);
    expect(querySummary().estimatedCount).toBe(0);
  });

  it("migrates v3 cached rows to a null inclusive count, never an approximation", () => {
    clear();
    append(makeRecord({ id: "v3", inputTokens: 3, cacheReadInputTokens: 60, cacheCreationInputTokens: 7, effectiveInputTokens: 70 }));
    append(makeRecord({ id: "v3-no-cache", inputTokens: 7 }));
    close();
    const db = openSqliteDatabase(join(tempHome, "data", "usage.sqlite")).db;
    db.exec("ALTER TABLE usage_records DROP COLUMN effective_input_tokens");
    db.exec("ALTER TABLE usage_records DROP COLUMN effective_input_estimated");
    db.pragma("user_version = 3");
    db.close();
    const { records } = query({ sessionId: "session-est" });
    expect(records.find(row => row.id === "v3-no-cache")?.effectiveInputTokens).toBe(7);
    const cached = records.find(row => row.id === "v3")!;
    expect(cached.effectiveInputTokens).toBeNull();
    expect(cached.effectiveInputTokensSource).toBeUndefined();
    expect(querySummary().totalEffectiveInputTokens).toBeNull();
    close();
    const reopened = openSqliteDatabase(join(tempHome, "data", "usage.sqlite")).db;
    expect(reopened.pragma("user_version", { simple: true })).toBe(4);
    reopened.close();
  });

  it("imports legacy cached JSONL rows as null inclusive counts", () => {
    clear(); close();
    mkdirSync(join(tempHome, "data"), { recursive: true });
    const fixtures = [
      makeRecord({ id: "jsonl-cached", inputTokens: 2, cacheReadInputTokens: 60, cacheCreationInputTokens: 7 }),
      makeRecord({ id: "jsonl-no-cache", inputTokens: 7 }),
      makeRecord({ id: "jsonl-unknown", inputTokens: 7, effectiveInputTokens: null }),
    ];
    writeFileSync(join(tempHome, "data", "usage.jsonl"), fixtures.map(row => JSON.stringify(row)).join("\n"));
    const { records } = query({ sessionId: "session-est" });
    expect(Object.fromEntries(records.map(row => [row.id, row.effectiveInputTokens]))).toEqual({
      "jsonl-cached": null, "jsonl-no-cache": 7, "jsonl-unknown": null,
    });
    expect(querySummary().totalEffectiveInputTokens).toBeNull();
  });

  afterAll(() => {
    close();
    rmSync(tempHome, { recursive: true, force: true });
  });
});
