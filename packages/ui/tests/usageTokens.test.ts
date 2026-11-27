import { test } from "node:test";
import assert from "node:assert/strict";
import { displayedUsageTotal, historicalWindowTotal, partialSummary, usageTokens } from "../src/utils/usageTokens.ts";

const row = { inputTokens: 100, cacheReadInputTokens: 40, cacheCreationInputTokens: 60, outputTokens: 10 };

test("identical raw counters use the gateway's inclusive count and retain cache writes in miss input", () => {
  assert.deepEqual(usageTokens({ ...row, effectiveInputTokens: 100 }), { cacheMissInput: 60, total: 110, hitRate: 0.4 });
  assert.deepEqual(usageTokens({ ...row, effectiveInputTokens: 200 }), { cacheMissInput: 160, total: 210, hitRate: 0.2 });
});

test("ambiguous legacy cache leaves derived metrics unavailable", () => {
  const unknown = { cacheMissInput: null, total: null, hitRate: null };
  assert.deepEqual(usageTokens(row), unknown);
  assert.deepEqual(usageTokens({ inputTokens: 1000, outputTokens: 5, effectiveInputTokens: null }), unknown);
  assert.deepEqual(usageTokens({ ...row, effectiveInputTokens: null }), unknown);
});

test("legacy counts without cached tokens are usable and zero input has no hit rate", () => {
  assert.deepEqual(usageTokens({ inputTokens: 100, outputTokens: 10 }), { cacheMissInput: 100, total: 110, hitRate: 0 });
  assert.deepEqual(usageTokens({ inputTokens: 0, effectiveInputTokens: 0, outputTokens: 10 }), { cacheMissInput: 0, total: 10, hitRate: null });
});

test("77k inclusive input with 76k cache reads displays 1k misses and a 98.7% hit rate", () => {
  const tokens = usageTokens({ inputTokens: 750, effectiveInputTokens: 77000, cacheReadInputTokens: 76000, cacheCreationInputTokens: 250, outputTokens: 200 });
  assert.equal(tokens.cacheMissInput, 1000);
  assert.equal(tokens.total, 77200);
  assert.equal(((tokens.hitRate ?? 0) * 100).toFixed(1), "98.7");
});

test("historical totals include the entire selected period even when the same date is fully accounted", () => {
  assert.equal(historicalWindowTotal(100, 200, 5, 10), 315);
  assert.equal(historicalWindowTotal(110, 300, 7, 20), 437);
  assert.equal(historicalWindowTotal(150, 500, 9, 45), 704);
  assert.equal(historicalWindowTotal(0, 0, 0, 0), 0);
  assert.equal(historicalWindowTotal(NaN, 0, 0, 0), null);
});

test("tooltip totals use the bucket's own counters and mark only historical fallbacks", () => {
  assert.deepEqual(displayedUsageTotal(row), { value: 210, estimated: true });
  assert.deepEqual(displayedUsageTotal({ ...row, effectiveInputTokens: 100 }), { value: 110, estimated: false });
  assert.deepEqual(displayedUsageTotal({ ...row, effectiveInputTokens: 0, outputTokens: 0 }), { value: 0, estimated: false });
  assert.deepEqual(displayedUsageTotal({ ...row, cacheCreationInputTokens: undefined }), { value: null, estimated: false });
});

test("mixed summaries use only matched request or date counters", () => {
  const s = { successCount: 4, byDay: {
    "day-a": { ...row, effectiveInputTokens: 80 }, "day-b": { ...row, inputTokens: 1000, effectiveInputTokens: null }
  } };
  assert.deepEqual(partialSummary(s), { total: 90, hitRate: 0.5, estimated: false, requests: null, days: ["day-a"] });
  assert.deepEqual(partialSummary({ ...s, coveredRequests: 2, coveredInputTokens: 100, coveredOutputTokens: 22,
    coveredCacheReadTokens: 75, coveredEstimatedCount: 0, estimatedCount: 1 }),
    { total: 122, hitRate: 0.75, estimated: false, requests: 2, days: [] });
  assert.equal(partialSummary({ ...s, byDay: { b: s.byDay["day-b"] } }), null);
  assert.deepEqual(partialSummary({ ...s, estimatedCount: 1, byDay: { b: s.byDay["day-b"],
    a: { inputTokens: 0, effectiveInputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 } } }),
    { total: 0, hitRate: null, estimated: false, requests: null, days: ["a"] });
});
