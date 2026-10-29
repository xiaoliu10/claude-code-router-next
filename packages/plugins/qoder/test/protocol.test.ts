import { describe, expect, it } from "vitest";
import { createQoderEngine } from "../src/vendor/engine.mjs";
import {
  QODER_CHAT, QODER_MARKER, QODER_PROVIDER, QODER_SITES, classifyQoderError, isQoderErrorEnvelope,
  isQoderManaged, lockQoderProvider, mergeQoderProvider, protectQoderConfig, qoderCardPrefix, qoderSite, validPAT,
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

describe("Qoder sites", () => {
  const [intl, cn] = QODER_SITES;

  it("describes both sites side by side; the named exports stay the intl defaults", () => {
    expect(QODER_SITES.map(s => s.id)).toEqual(["qoder", "qoder-cn"]);
    expect(intl).toMatchObject({
      web: "https://qoder.com", openapi: "https://openapi.qoder.sh", api: "https://api3.qoder.sh",
      provider: "qoder-subscription", marker: "ccr-managed-qoder",
      credentialFile: "qoder-credentials.json", routeBase: "/api/qoder",
    });
    expect(cn).toMatchObject({
      web: "https://qoder.cn", openapi: "https://openapi.qoder.com.cn", api: "https://gateway.qoder.com.cn",
      provider: "qoder-cn-subscription", marker: "ccr-managed-qoder-cn",
      credentialFile: "qoder-cn-credentials.json", routeBase: "/api/qoder/cn",
    });
    // The host table and the vendored engine's table are independent copies;
    // this guard fails if either drifts (a CN host typo would otherwise only
    // surface as a runtime 404).
    const engineSites = (createQoderEngine as any)({ fetch: async () => new Response("") })._internal.SITES;
    for (const site of QODER_SITES) {
      expect(engineSites[site.id]).toMatchObject({ openapi: site.openapi, api: site.api, web: site.web });
      expect(site.chatUrl.startsWith(`${site.api}/algo/`)).toBe(true);
    }
    // same chat path on both sites, only the api host differs
    expect(cn.chatUrl).toBe("https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1");
    expect(intl.chatUrl).toBe(QODER_CHAT);
    expect(QODER_PROVIDER).toBe(intl.provider);
    expect(QODER_MARKER).toBe(intl.marker);
    expect(qoderSite()).toBe(intl);
    expect(qoderSite("qoder-cn")).toBe(cn);
    // an Array.prototype index leaked by a bare `find(isQoderManaged)` is not a site
    expect(qoderSite(1 as any)).toBe(intl);
    // the card reaches the admin routes through the plugin bridge
    expect(qoderCardPrefix("qoder")).toBe("");
    expect(qoderCardPrefix("qoder-cn")).toBe("/cn");
  });

  it("locks each site to its own provider, marker, chat upstream and transformer", () => {
    const lockedCn = lockQoderProvider({ models: ["c1"], enabled: true }, "qoder-cn");
    expect(lockedCn).toMatchObject({ name: "qoder-cn-subscription", qoder_managed: true, qoderManaged: true,
      api_key: "ccr-managed-qoder-cn", api_base_url: cn.chatUrl, models: ["c1"], enabled: true });
    expect(lockedCn.transformer.use).toEqual(["qoder-cn"]);
  });

  it("keeps the two managed providers independent", () => {
    const lockedIntl = lockQoderProvider({ models: ["m1"] });
    const lockedCn = lockQoderProvider({ models: ["c1"] }, "qoder-cn");
    expect(isQoderManaged(lockedIntl)).toBe(true);
    expect(isQoderManaged(lockedIntl, "qoder-cn")).toBe(false);
    expect(isQoderManaged(lockedCn, "qoder-cn")).toBe(true);
    expect(isQoderManaged(lockedCn)).toBe(false);
    // a flag without a name still belongs to the default site only
    expect(isQoderManaged({ qoder_managed: true })).toBe(true);
    expect(isQoderManaged({ qoder_managed: true }, "qoder-cn")).toBe(false);
  });

  it("one protector re-locks and re-adds both managed providers", () => {
    const old = { Providers: [lockQoderProvider({ models: ["m1"] }), lockQoderProvider({ models: ["c1"] }, "qoder-cn"), { name: "other", api_key: "$SECRET" }] };
    const router = { default: "other" };
    const next: any = { Providers: [
      { name: "qoder-cn-subscription", api_key: "spoof", api_base_url: "https://evil.invalid", transformer: { use: ["other"] } },
      old.Providers[2],
    ], Router: router };
    protectQoderConfig(next, old);
    // the tampered CN entry is re-locked in place, the intl one is re-added (descriptor order)
    expect(next.Providers[0]).toMatchObject({ name: "qoder-cn-subscription", api_key: "ccr-managed-qoder-cn", api_base_url: cn.chatUrl });
    expect(next.Providers[0].transformer.use).toEqual(["qoder-cn"]);
    expect(next.Providers[1]).toEqual(old.Providers[2]);
    expect(next.Providers[2]).toMatchObject({ name: "qoder-subscription", api_key: QODER_MARKER, api_base_url: QODER_CHAT, models: ["m1"] });
    expect(next.Router).toBe(router);

    // both dropped: both come back, intl first
    const cleared: any = { Providers: [{ name: "other" }] };
    protectQoderConfig(cleared, old);
    expect(cleared.Providers.map((p: any) => p.name)).toEqual(["other", "qoder-subscription", "qoder-cn-subscription"]);

    // an intl-only previous config keeps its old single-provider semantics
    const intlOnly: any = { Providers: [{ name: "other" }] };
    protectQoderConfig(intlOnly, { Providers: [lockQoderProvider({ models: ["m1"] })] });
    expect(intlOnly.Providers.map((p: any) => p.name)).toEqual(["other", "qoder-subscription"]);

    // a renamed managed entry is still restored (legacy intl semantics)
    const renamed: any = { Providers: [{ name: "renamed", qoder_managed: true, api_key: "x" }] };
    protectQoderConfig(renamed, { Providers: [lockQoderProvider({ models: ["m1"] })] });
    expect(renamed.Providers).toHaveLength(1);
    expect(renamed.Providers[0]).toMatchObject({ name: "qoder-subscription", api_key: QODER_MARKER, api_base_url: QODER_CHAT });

    // a CN entry is normalised as CN, never rewritten into the intl one
    const forged: any = { Providers: [{ name: "qoder-cn-subscription", qoder_managed: true, api_key: "x" }, { name: "other" }] };
    protectQoderConfig(forged, { Providers: [lockQoderProvider({ models: ["m1"] })] });
    expect(forged.Providers[0]).toMatchObject({ name: "qoder-cn-subscription", api_key: "ccr-managed-qoder-cn", api_base_url: cn.chatUrl });
    expect(forged.Providers[0].transformer.use).toEqual(["qoder-cn"]);
    expect(forged.Providers[1]).toEqual({ name: "other" });
    expect(forged.Providers[2]).toMatchObject({ name: "qoder-subscription", api_key: QODER_MARKER, models: ["m1"] });
  });

  it("merges one site without disturbing the other", () => {
    const lockedIntl = lockQoderProvider({ models: ["m1"] });
    const lockedCn = lockQoderProvider({ models: ["c1"] }, "qoder-cn");
    const current = { Providers: [lockedIntl, lockedCn, { name: "other" }] };
    const nextCn = lockQoderProvider({ models: ["c2"] }, "qoder-cn");
    const mergedCn = mergeQoderProvider(current, { Providers: [nextCn] }, "qoder-cn");
    expect(mergedCn.Providers[1]).toBe(nextCn);
    expect(mergedCn.Providers[0]).toBe(lockedIntl);
    expect(mergedCn.Providers[2]).toEqual({ name: "other" });

    // removing the CN entry leaves the intl entry alone
    const removedCn = mergeQoderProvider(current, { Providers: [lockedIntl] }, "qoder-cn");
    expect(removedCn.Providers.map((p: any) => p.name)).toEqual(["qoder-subscription", "other"]);

    // the intl merge never picks up (or overwrites) a CN entry
    const mergedIntl = mergeQoderProvider({ Providers: [{ name: "other" }] }, { Providers: [nextCn] });
    expect(mergedIntl.Providers).toEqual([{ name: "other" }]);
    // and a plain same-name CN provider is a conflict the merge never clobbers
    const conflict = mergeQoderProvider({ Providers: [{ name: "qoder-cn-subscription", api_key: "user" }] }, { Providers: [nextCn] }, "qoder-cn");
    expect(conflict.Providers).toEqual([{ name: "qoder-cn-subscription", api_key: "user" }]);
  });
});
