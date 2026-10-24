/**
 * Wire-variant selection checks (magpie AntigravitySentID). MOVED from the
 * former core test `wire-check.test.ts`; only the import path changed.
 */
import { describe, expect, it } from "vitest";
import { antigravityWireModel, GEMINI_OAUTH_FALLBACK_MODELS } from "../src/protocol";

const RAW = [
  { id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)" },
  { id: "gemini-3-flash", name: "Gemini 3 Flash" },
  { id: "gemini-3-flash-agent", name: "Gemini 3.5 Flash (High)" },
  { id: "gemini-3.1-pro-high", name: "Gemini 3.1 Pro (High)" },
  { id: "gemini-3.1-pro-low", name: "Gemini 3.1 Pro (Low)" },
  { id: "gemini-3.5-flash-extra-low", name: "Gemini 3.5 Flash (Low)" },
  { id: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash Lite" },
  { id: "gemini-3.5-flash-low", name: "Gemini 3.5 Flash (Medium)" },
  { id: "gemini-3.7-flash-high", name: "Gemini 3.7 Flash (High)" },
  { id: "gemini-3.7-flash-low", name: "Gemini 3.7 Flash (Low)" },
  { id: "gemini-3.7-flash-medium", name: "Gemini 3.7 Flash (Medium)" },
  { id: "gemini-3.7-flash-tiered", name: undefined },
  { id: "gemini-pro-agent", name: "Gemini 3.1 Pro (High)" },
  { id: "gpt-oss-120b-medium", name: "Gpt oss 120B (Medium)" },
];

describe("wire mapping vs magpie 2026-09 fixture", () => {
  it("matches magpie antigravity_models_test.go byEffort values", () => {
    expect(antigravityWireModel(RAW, "gemini-3.7-flash", "")).toBe("gemini-3.7-flash-high");
    expect(antigravityWireModel(RAW, "gemini-3.7-flash", "high")).toBe("gemini-3.7-flash-high");
    expect(antigravityWireModel(RAW, "gemini-3.7-flash", "low")).toBe("gemini-3.7-flash-low");
    expect(antigravityWireModel(RAW, "gemini-3.7-flash", "medium")).toBe("gemini-3.7-flash-medium");
    expect(antigravityWireModel(RAW, "gemini-3.5-flash", "")).toBe("gemini-3.5-flash-low");
    expect(antigravityWireModel(RAW, "gemini-3.5-flash", "low")).toBe("gemini-3.5-flash-extra-low");
    expect(antigravityWireModel(RAW, "gemini-3.5-flash", "medium")).toBe("gemini-3.5-flash-low");
    expect(antigravityWireModel(RAW, "gemini-3.1-pro", "")).toBe("gemini-3.1-pro-high");
    expect(antigravityWireModel(RAW, "gemini-3.1-pro", "high")).toBe("gemini-3.1-pro-high");
    expect(antigravityWireModel(RAW, "gemini-3.1-pro", "low")).toBe("gemini-3.1-pro-low");
  });
  it("passes non-family ids through at every effort", () => {
    for (const id of ["gemini-3-flash", "gpt-oss-120b-medium", "gemini-3.7-flash-high", "gemini-pro-agent"]) {
      expect(antigravityWireModel(RAW, id, "")).toBe(id);
      expect(antigravityWireModel(RAW, id, "high")).toBe(id);
    }
  });
  it("maps a saved variant id at an effort to its family variant and nearest-levels otherwise", () => {
    expect(antigravityWireModel(RAW, "gemini-3.7-flash-low", "high")).toBe("gemini-3.7-flash-high");
    expect(antigravityWireModel(RAW, "gemini-3.1-pro", "max")).toBe("gemini-3.1-pro-high");
    expect(antigravityWireModel(RAW, "gemini-3.7-flash", "none")).toBe("gemini-3.7-flash-low");
    expect(antigravityWireModel(RAW, "gemini-3.7-flash", "xhigh")).toBe("gemini-3.7-flash-high");
    expect(antigravityWireModel(RAW, "gemini-3.7-flash", "minimal")).toBe("gemini-3.7-flash-low");
    expect(antigravityWireModel(RAW, "totally-unknown", "high")).toBe("totally-unknown");
  });
  it("works against the static fallback table (mixed effort words in names vs ids)", () => {
    expect(antigravityWireModel(GEMINI_OAUTH_FALLBACK_MODELS, "gemini-3.1-pro-low", "")).toBe("gemini-3.1-pro-low");
  });
});
