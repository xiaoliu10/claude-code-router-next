import { test } from "node:test";
import assert from "node:assert/strict";
import { usageTokens } from "../src/utils/usageTokens.ts";

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
