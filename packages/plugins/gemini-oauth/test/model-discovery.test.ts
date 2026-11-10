import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  fetchAvailableModelVariants,
  fetchAvailableModels,
  GEMINI_OAUTH_DATA_PLANE,
} from "../src/protocol";

// Antigravity marks a model it will not serve this account with the boolean
// `disabled` field on the fetchAvailableModels entry. On a real account the
// placeholder arrives as an id like gemini-4-argon-disabled WITH disabled:true,
// and addressing it 404s "Requested entity was not found". This mirrors magpie's
// upstream fix (commit a7ed2f61): a plain `if m.Disabled { continue }` at the
// discovery choke point — there is NO id-suffix check in magpie main, and a
// normal entry carrying disabled:false stays listed. Google clears the flag and
// a refresh brings the model back.

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("Antigravity model discovery", () => {
  beforeEach(() => {
    vi.stubEnv("GEMINI_OAUTH_CLIENT_ID", "dummy");
    vi.stubEnv("GEMINI_OAUTH_CLIENT_SECRET", "dummy");
    vi.stubEnv("GEMINI_OAUTH_ANTIGRAVITY_VERSION", "");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network disabled in test"); }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("leaves a disabled model out but keeps the enabled siblings", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith(":fetchAvailableModels")) {
        return json({
          models: {
            // Real-account shape (magpie TestAntigravityDisabledModelLeftOut):
            // a -disabled placeholder id carrying the boolean field.
            "gemini-4-argon-disabled": { displayName: "Gemini 4 Argon", disabled: true },
            // Negative control: an explicit false must NOT be filtered.
            "gpt-oss-120b-medium": { displayName: "GPT-OSS 120B", disabled: false },
            "gemini-3.8-flash-high": { displayName: "Gemini 3.8 Flash (High)" },
            "chat_20706": { displayName: "internal" },
            "tab_flash_lite_preview": { displayName: "internal" },
            "gemini-2.5-pro": { displayName: "Gemini 2.5 Pro" },
          },
        });
      }
      throw new Error("unexpected url " + String(url));
    });
    vi.stubGlobal("fetch", fetchMock);

    const ids = (await fetchAvailableModelVariants("access-token", "proj", "standard-tier", fetchMock as any))
      .map((m) => m.id);

    expect(ids).not.toContain("gemini-4-argon-disabled");
    expect(ids).toContain("gpt-oss-120b-medium"); // disabled:false is still offered
    expect(ids).toContain("gemini-3.8-flash-high");
    expect(ids).not.toContain("chat_20706");
    expect(ids).not.toContain("tab_flash_lite_preview");
    expect(ids).not.toContain("gemini-2.5-pro");
  });

  it("keys the filter on the boolean field, not an id suffix", async () => {
    // Isolate the two markers so the suite cannot pass on a suffix-only rule.
    const fetchMock = vi.fn(async () => json({
      models: {
        // A normal effort id (no -disabled suffix) carrying the field: must go.
        "gemini-4-argon-high": { displayName: "Gemini 4 Argon (High)", disabled: true },
        // A -disabled-suffixed id WITHOUT the field: magpie main keeps it too,
        // because neither implementation inspects the suffix. Pin that contract.
        "gemini-5-placeholder-disabled": { displayName: "Gemini 5 Placeholder" },
        "gemini-3-flash": { displayName: "Gemini 3 Flash" },
      },
    }));

    const ids = (await fetchAvailableModelVariants("t", "p", "", fetchMock)).map((m) => m.id);
    expect(ids).not.toContain("gemini-4-argon-high"); // field alone filters
    expect(ids).toContain("gemini-5-placeholder-disabled"); // suffix alone does not
    expect(ids).toContain("gemini-3-flash");
  });

  it("advertises the current client version so discovery includes enabled Gemini 4 variants", async () => {
    // Captured behavior: the same token, endpoint and proxy return Gemini 4
    // for a current hub (2.26.0+, pinned to 2.30.0 here), while hub/2.9.1 only
    // returns older models. The mock branches on the ACTUAL header sent, so this
    // locks the persona we emit rather than merely the constant's value.
    const seenUrls: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      seenUrls.push(String(url));
      const ua = new Headers(init?.headers).get("User-Agent");
      const current = ua?.startsWith("antigravity/hub/2.30.0 ");
      return json({
        models: {
          "gemini-3.8-flash-high": { displayName: "Gemini 3.8 Flash (High)" },
          ...(current ? {
            "gemini-4-argon-high": { displayName: "Gemini 4 Argon (High)", disabled: false },
            "gemini-4-argon-medium": { displayName: "Gemini 4 Argon (Medium)" },
            "gemini-4-argon-low": { displayName: "Gemini 4 Argon (Low)" },
          } : {}),
        },
        agentModelSorts: [{ groups: [{ modelIds: [
          "gemini-4-argon-medium", "gemini-4-argon-high", "gemini-4-argon-low",
          "gemini-3.8-flash-high",
        ] }] }],
      });
    });
    const variants = await fetchAvailableModelVariants("fixture-token", "proj", "standard-tier", fetchMock);
    expect(variants.map((m) => m.id)).toEqual([
      "gemini-4-argon-medium", "gemini-4-argon-high", "gemini-4-argon-low", "gemini-3.8-flash-high",
    ]);
    const collapsed = await fetchAvailableModels("fixture-token", "proj", "standard-tier", fetchMock);
    expect(collapsed.map((m) => m.id)).toContain("gemini-4-argon");

    // Reproduce the old-client failure without touching the stored account.
    vi.stubEnv("GEMINI_OAUTH_ANTIGRAVITY_VERSION", "2.9.1");
    const legacy = await fetchAvailableModelVariants("fixture-token", "proj", "standard-tier", fetchMock);
    expect(legacy.map((m) => m.id)).toEqual(["gemini-3.8-flash-high"]);
    // Every call targeted the data-plane discovery endpoint (asserted after,
    // not inside the mock, so a mismatch surfaces as a clean assertion diff).
    expect(seenUrls.every((u) => u === `${GEMINI_OAUTH_DATA_PLANE}/v1internal:fetchAvailableModels`)).toBe(true);
  });

  it("keeps an effort family alive when only one variant is disabled", async () => {
    const fetchMock = vi.fn(async () => json({
      models: {
        "gemini-4-argon-high": { displayName: "Gemini 4 Argon (High)", disabled: true },
        "gemini-4-argon-medium": { displayName: "Gemini 4 Argon (Medium)" },
        "gemini-4-argon-low": { displayName: "Gemini 4 Argon (Low)" },
      },
    }));

    const variants = (await fetchAvailableModelVariants("t", "p", "", fetchMock)).map((m) => m.id);
    expect(variants).not.toContain("gemini-4-argon-high");
    expect(variants).toContain("gemini-4-argon-medium");
    expect(variants).toContain("gemini-4-argon-low");

    // The family still folds to one selectable id — it does not vanish, and no
    // phantom disabled variant leaks through.
    const collapsed = (await fetchAvailableModels("t", "p", "", fetchMock)).map((m) => m.id);
    expect(collapsed).toEqual(["gemini-4-argon"]);
  });

  it("drops a family entirely when every variant is disabled", async () => {
    const fetchMock = vi.fn(async () => json({
      models: {
        "gemini-4-argon-high": { disabled: true },
        "gemini-4-argon-medium": { disabled: true },
        "gemini-3-flash": { displayName: "Gemini 3 Flash" },
      },
    }));
    const collapsed = (await fetchAvailableModels("t", "p", "", fetchMock)).map((m) => m.id);
    expect(collapsed).toEqual(["gemini-3-flash"]);
  });

  it("includes a model on refresh after the upstream clears its disabled flag", async () => {
    let disabled = true;
    const fetchMock = vi.fn(async () => json({ models: {
      "gemini-4-argon-high": { displayName: "Gemini 4 Argon (High)", disabled },
    } }));
    expect(await fetchAvailableModelVariants("fixture-token", "proj", "", fetchMock)).toEqual([]);
    disabled = false;
    const refreshed = await fetchAvailableModelVariants("fixture-token", "proj", "", fetchMock);
    expect(refreshed.map((m) => m.id)).toEqual(["gemini-4-argon-high"]);
  });
});
