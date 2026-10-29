import { describe, expect, it } from "vitest";
import { mergeUsageCapture } from "../ccr/usage-merge";

/**
 * The reported shape: a healthy streamed turn was stored as
 * `status=success, output_tokens=0, ttft=null`, which made working subscription
 * responses look like empty answers in the usage UI.
 *
 * Anthropic streams carry `usage.output_tokens: 0` on message_start and the real
 * count on the trailing message_delta. The plain (non-agent) streaming path had
 * NO reader at all, so only the zero was ever recorded. These tests pin the merge
 * behaviour the new reader relies on: a leading zero must never win over a
 * trailing real value, in either arrival order.
 */
describe("streamed usage merge order", () => {
  it("keeps the trailing message_delta count over the leading message_start zero", () => {
    let cache: any = {};
    // message_start opens the answer: reset the base.
    cache = mergeUsageCapture(cache, { input_tokens: 6, output_tokens: 0 }, true);
    expect(cache.output_tokens).toBe(0);
    // message_delta carries the real count.
    cache = mergeUsageCapture(cache, { input_tokens: 52, output_tokens: 197 }, false);
    expect(cache.output_tokens).toBe(197);
    expect(cache.input_tokens).toBe(52);
  });

  it("keeps a real count even if a later frame reports zero", () => {
    let cache: any = mergeUsageCapture({}, { input_tokens: 10, output_tokens: 42 }, true);
    cache = mergeUsageCapture(cache, { input_tokens: 0, output_tokens: 0 }, false);
    expect(cache.output_tokens).toBe(42);
  });

  it("keeps cache counters that only the trailing frame carries", () => {
    let cache: any = mergeUsageCapture({}, { input_tokens: 10, output_tokens: 0 }, true);
    cache = mergeUsageCapture(cache, { output_tokens: 5, cache_read_input_tokens: 900 }, false);
    expect(cache.cache_read_input_tokens).toBe(900);
    expect(cache.output_tokens).toBe(5);
  });

  it("reports a genuinely empty answer as zero (must not invent output)", () => {
    let cache: any = mergeUsageCapture({}, { input_tokens: 6, output_tokens: 0 }, true);
    cache = mergeUsageCapture(cache, { input_tokens: 6, output_tokens: 0 }, false);
    expect(cache.output_tokens).toBe(0);
  });
});
