import { describe, it, expect } from "vitest";
import { isRealUpstreamModel } from "../ccr/request-pipeline";

describe("isRealUpstreamModel — upstream echo capture for usage rows", () => {
  it("accepts real model names", () => {
    expect(isRealUpstreamModel("gpt-6.1-sol")).toBe(true);
    expect(isRealUpstreamModel(" glm-5.3 ")).toBe(true);
  });
  it("rejects the converter placeholder and empties that produced 'unknown' rows", () => {
    // The Anthropic SSE converter initializes its label to "unknown" until the
    // first chat chunk names a model; a short stream could lock that placeholder
    // into req.upstreamModel (first-write-wins) and the usage third leg.
    expect(isRealUpstreamModel("unknown")).toBe(false);
    expect(isRealUpstreamModel("")).toBe(false);
    expect(isRealUpstreamModel("   ")).toBe(false);
    expect(isRealUpstreamModel(undefined)).toBe(false);
    expect(isRealUpstreamModel(null)).toBe(false);
    expect(isRealUpstreamModel(42)).toBe(false);
  });
});
