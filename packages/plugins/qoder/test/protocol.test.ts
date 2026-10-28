import { describe, expect, it } from "vitest";
import {
  QODER_CHAT, QODER_MARKER, QODER_PROVIDER, classifyQoderError, isQoderErrorEnvelope,
  isQoderManaged, lockQoderProvider, mergeQoderProvider, protectQoderConfig, validPAT,
} from "../src/protocol";

describe("Qoder managed boundary", () => {
  it("marker recognition covers both spellings and the name+marker pair", () => {
    expect(isQoderManaged({ qoder_managed: true })).toBe(true);
    expect(isQoderManaged({ qoderManaged: true })).toBe(true);
    expect(isQoderManaged({ name: QODER_PROVIDER, api_key: QODER_MARKER })).toBe(true);
    expect(isQoderManaged({ name: QODER_PROVIDER, apiKey: QODER_MARKER })).toBe(true);
    expect(isQoderManaged({ name: QODER_PROVIDER, api_key: "spoof" })).toBe(false);
    expect(isQoderManaged({ qoder_managed: false })).toBe(false);
    expect(isQoderManaged(null)).toBe(false);
  });

  it("locks the fixed chat upstream, marker credential and the qoder transformer chain", () => {
    const locked = lockQoderProvider({ models: ["m1"], enabled: true });
    expect(locked).toMatchObject({ name: QODER_PROVIDER, qoder_managed: true, qoderManaged: true,
      api_key: QODER_MARKER, api_base_url: QODER_CHAT, models: ["m1"], enabled: true });
    expect(locked.transformer.use).toEqual(["qoder"]);
    expect(QODER_CHAT).toBe("https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1");
  });

  it("protects omitted and tampered managed config while preserving unrelated providers/router", () => {
    const old = { Providers: [lockQoderProvider({ models: ["m1"] }), { name: "other", api_key: "$SECRET" }], Router: { default: "other,m1" } };
    const next = { Providers: [{ name: QODER_PROVIDER, api_key: "spoof", api_base_url: "https://evil.invalid" }, old.Providers[1]], Router: old.Router };
    protectQoderConfig(next, old);
    expect(next.Providers[0].api_key).toBe(QODER_MARKER);
    expect(next.Providers[0].api_base_url).toBe(QODER_CHAT);
    expect(next.Providers[0].transformer.use).toEqual(["qoder"]);
    expect(next.Providers[1]).toEqual(old.Providers[1]);
    expect(next.Router).toBe(old.Router);
    const omitted: any = { Router: old.Router };
    protectQoderConfig(omitted, old);
    expect(omitted.Providers[0].api_key).toBe(QODER_MARKER);
    // lowercase providers key round-trip
    const lower = { providers: [{ name: "other" }] };
    protectQoderConfig(lower, { providers: [lockQoderProvider({})] });
    expect(lower.providers).toHaveLength(2);
    expect(isQoderManaged(lower.providers[1])).toBe(true);
  });

  it("merges the server's managed entry in place, removes stale ones, never clobbers a name conflict", () => {
    const managed = lockQoderProvider({ models: ["m2"] });
    const current = { Providers: [{ name: "other" }, lockQoderProvider({ models: ["m1"] })] };
    const replaced = mergeQoderProvider(current, { Providers: [{ name: "other" }, managed] });
    expect(replaced.Providers[1]).toBe(managed);
    expect(replaced.Providers[0]).toEqual({ name: "other" });
    const removed = mergeQoderProvider(current, { Providers: [{ name: "other" }] });
    expect(removed.Providers.map((p: any) => p.name)).toEqual(["other"]);
    const added = mergeQoderProvider({ Providers: [{ name: "other" }] }, { Providers: [managed] });
    expect(added.Providers).toHaveLength(2);
    // a plain same-name provider must not be treated as the managed slot
    const conflict = mergeQoderProvider({ Providers: [{ name: QODER_PROVIDER, api_key: "user" }] }, { Providers: [managed] });
    expect(conflict.Providers).toHaveLength(1);
    expect(conflict.Providers[0].api_key).toBe("user");
  });

  it("classifies transport/reauth/rate/upstream into the shared taxonomy with retry_after cooldown", () => {
    expect(classifyQoderError(0, undefined)).toMatchObject({ code: "qoder_upstream_error", httpStatus: 502, retryable: true });
    expect(classifyQoderError(401, undefined)).toMatchObject({ code: "qoder_reauth_required", httpStatus: 401, retryable: false });
    expect(classifyQoderError(500, undefined)).toMatchObject({ code: "qoder_upstream_error", httpStatus: 500, retryable: true });
    expect(classifyQoderError(403, undefined)).toMatchObject({ code: "qoder_upstream_error", httpStatus: 403, retryable: false });
    // no hint → 5 minute default
    expect(classifyQoderError(429, undefined)).toMatchObject({ code: "qoder_rate_limited", httpStatus: 429, cooldownMs: 300000 });
    // seconds → ms, clamped to 30s..30min
    expect(classifyQoderError(429, { retry_after: 2 }).cooldownMs).toBe(30_000);
    expect(classifyQoderError(429, { retry_after: 100000 }).cooldownMs).toBe(1_800_000);
    expect(classifyQoderError(429, { retry_after: 120 }).cooldownMs).toBe(120_000);
    // the engine's errorResponse shape arrives parsed or as raw text
    const envelope = JSON.stringify({ error: { type: "qoder_error", message: "x" }, retry_after: 45 });
    expect(classifyQoderError(429, envelope).cooldownMs).toBe(45_000);
    // non-numeric hint falls back to the default
    expect(classifyQoderError(429, { retry_after: "soon" }).cooldownMs).toBe(300_000);
  });

  it("detects the engine's hidden 200 error envelope and gates PAT format", () => {
    expect(isQoderErrorEnvelope({ error: { type: "qoder_error" } })).toBe(true);
    expect(isQoderErrorEnvelope({ error: { type: "other" } })).toBe(false);
    expect(isQoderErrorEnvelope({})).toBe(false);
    expect(isQoderErrorEnvelope(null)).toBe(false);

    expect(validPAT("pt-abc123")).toBe(true);
    expect(validPAT("tok")).toBe(false);
    expect(validPAT("pt-" + "a".repeat(4097))).toBe(false);
    expect(validPAT("pt-a\nb")).toBe(false);
    expect(validPAT(42)).toBe(false);
    expect(validPAT(undefined)).toBe(false);
  });
});
