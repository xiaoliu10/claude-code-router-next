import { describe, it, expect } from "vitest";
import {
  normalizeUsagePayload,
  mergeUsageCapture,
} from "../ccr/usage-merge";

describe("normalizeUsagePayload", () => {
  it("maps Anthropic-style usage fields verbatim", () => {
    const u = normalizeUsagePayload({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 10,
    });
    expect(u.input_tokens).toBe(100);
    expect(u.output_tokens).toBe(50);
    expect(u.cache_read_input_tokens).toBe(30);
    expect(u.cache_creation_input_tokens).toBe(10);
  });

  it("maps OpenAI Chat Completions usage (prompt_tokens/completion_tokens)", () => {
    const u = normalizeUsagePayload({ prompt_tokens: 100, completion_tokens: 50 });
    expect(u.input_tokens).toBe(100);
    expect(u.output_tokens).toBe(50);
  });

  it("reads cached_tokens from OpenAI prompt_tokens_details", () => {
    const u = normalizeUsagePayload({
      prompt_tokens: 100,
      completion_tokens: 50,
      prompt_tokens_details: { cached_tokens: 80 },
    });
    expect(u.cache_read_input_tokens).toBe(80);
  });

  it("returns undefined for non-object usage", () => {
    expect(normalizeUsagePayload(null)).toBeUndefined();
    expect(normalizeUsagePayload(undefined)).toBeUndefined();
    expect(normalizeUsagePayload("nope")).toBeUndefined();
  });
});

describe("ordinary usage merge compatibility", () => {
  it.each([true, false])("keeps unmarked normalized and merged objects deeply equal to baseline (reset=%s)", (resetBase) => {
    const raw = { prompt_tokens: 50, completion_tokens: 3, cache_creation_input_tokens: 7 };
    const normalized = normalizeUsagePayload(raw);
    expect(normalized).toEqual({ ...raw, input_tokens: 50, output_tokens: 3, cache_read_input_tokens: 0 });
    const base = { input_tokens: 99, output_tokens: 8, cache_read_input_tokens: 30, cache_creation_input_tokens: 4 };
    expect(mergeUsageCapture(base, normalized, resetBase)).toEqual({
      input_tokens: 50, output_tokens: 3, cache_read_input_tokens: resetBase ? 0 : 30, cache_creation_input_tokens: 7,
    });
  });

  it("keeps true sticky but resets it at the next request", () => {
    const estimated = normalizeUsagePayload({ prompt_tokens: 50, completion_tokens: 3, kiro_estimated: true });
    const marked = mergeUsageCapture({}, estimated, true);
    expect(mergeUsageCapture(marked, { output_tokens: 4, usage_estimated: false }, false).usage_estimated).toBe(true);
    expect(mergeUsageCapture(marked, { input_tokens: 50, output_tokens: 3 }, true)).toEqual({
      input_tokens: 50, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    });
  });
});

describe("mergeUsageCapture", () => {
  it("preserves real usage captured on message_start against a trailing all-zero frame", () => {
    // Simulates the fireworks/GLM-5.2 bug: message_start reports real input,
    // message_delta emits all-zero usage on the stop chunk.
    const start = normalizeUsagePayload({ input_tokens: 60005, output_tokens: 0 });
    const afterStart = mergeUsageCapture({}, start, true); // message_start: reset base
    expect(afterStart.input_tokens).toBe(60005);

    const trailingZero = normalizeUsagePayload({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
    });
    const afterDelta = mergeUsageCapture(afterStart, trailingZero, false); // message_delta
    // The all-zero frame must NOT wipe out the real input captured at start.
    expect(afterDelta.input_tokens).toBe(60005);
    expect(afterDelta.output_tokens).toBe(0);
  });

  it("updates a field only when the incoming frame carries a non-zero value", () => {
    const base = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 };
    // A later frame reports the final output_tokens (cumulative) and a cache read.
    const merged = mergeUsageCapture(base, { input_tokens: 0, output_tokens: 87, cache_read_input_tokens: 12, cache_creation_input_tokens: 0 }, false);
    expect(merged.input_tokens).toBe(100); // unchanged (incoming 0)
    expect(merged.output_tokens).toBe(87); // updated (incoming non-zero)
    expect(merged.cache_read_input_tokens).toBe(12); // updated
  });

  it("resetBase=true discards stale fields from a previous request in the same session", () => {
    const stale = { input_tokens: 9999, output_tokens: 9999, cache_read_input_tokens: 9999, cache_creation_input_tokens: 9999 };
    const fresh = mergeUsageCapture(stale, { input_tokens: 10, output_tokens: 5 }, true);
    expect(fresh.input_tokens).toBe(10);
    expect(fresh.output_tokens).toBe(5);
    expect(fresh.cache_read_input_tokens).toBe(0); // stale value NOT carried over
    expect(fresh.cache_creation_input_tokens).toBe(0);
  });

  it("treats an all-zero first frame as zeros (no prior value to fall back to)", () => {
    const merged = mergeUsageCapture({}, { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, true);
    expect(merged.input_tokens).toBe(0);
    expect(merged.output_tokens).toBe(0);
  });

  it("handles missing/undefined inputs without throwing", () => {
    expect(mergeUsageCapture(undefined, undefined, true)).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
  });

  it("regression: the exact fireworks/GLM-5.2 sequence that produced 0/0 records", () => {
    // 1) message_start: real input reported, output 0
    const startUsage = normalizeUsagePayload({ input_tokens: 60005, output_tokens: 0 });
    let cache = mergeUsageCapture({}, startUsage, true);
    // 2) content deltas (no usage)
    // 3) message_delta: all-zero usage frame (the bug)
    const trailingZero = normalizeUsagePayload({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 });
    cache = mergeUsageCapture(cache, trailingZero, false);
    // Before the fix this collapsed to all zeros; input must survive.
    expect(cache.input_tokens).toBe(60005);
  });
});
