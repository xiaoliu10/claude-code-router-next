import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  formatWorkBuddyClock, hasDiscoveredModels, isManagedWorkBuddy, isWorkBuddyConnected, isWorkBuddyKind,
  labelWorkBuddyRouterPath, maskWorkBuddyUid, mergeWorkBuddyHiddenRefs, mergeWorkBuddyProvider, parseWorkBuddyUsage,
  sanitizeWorkBuddyModelRefs, sanitizeWorkBuddyRouterPaths, workBuddyAccountCooling, workBuddyAccountRestricted, workBuddyErrorKey,
  workBuddyImagesUnsupportedModels, workBuddyKindOf, workBuddySiteStatus, workBuddyStateKey, workBuddyVisibleErrorKey,
} from "../src/utils/workbuddy.ts";
import type { Config, Provider, WorkBuddyAccountSummary, WorkBuddyMutationResponse, WorkBuddySiteStatus, WorkBuddyStatusResponse } from "../src/types.ts";

const managed: Provider = { name: "workbuddy", api_base_url: "https://copilot.tencent.com/v2/chat/completions", api_key: "ccr-managed-workbuddy", models: ["new-model"], ccr_managed: true, enabled: false };
const managedAi: Provider = { name: "workbuddy-ai", api_base_url: "https://copilot.tencent.com/v2/chat/completions", api_key: "ccr-managed-workbuddy-ai", models: ["kimi-k2"], ccr_managed: true, enabled: false };
const other: Provider = { name: "custom", api_base_url: "https://example.invalid", api_key: "mock", models: ["draft"] };
const config = (providers: Provider[]) => ({ Providers: providers, Router: { default: "local,draft", custom: { preserve: true } }, customDraft: "not saved" }) as unknown as Config;

test("managed detection requires exact managed name plus strict true (both sites)", () => {
  assert.equal(isManagedWorkBuddy(managed), true);
  assert.equal(isManagedWorkBuddy(managedAi), true);
  for (const value of [null, {}, { name: "workbuddy" }, { name: "workbuddy", ccr_managed: "true" }, { name: "other", ccr_managed: true }, { name: "workbuddy-ai", ccr_managed: false }]) assert.equal(isManagedWorkBuddy(value), false);
  assert.equal(workBuddyKindOf(managed), "workbuddy");
  assert.equal(workBuddyKindOf(managedAi), "workbuddy-ai");
  assert.equal(workBuddyKindOf({ name: "workbuddy" }), null);
});
test("import merges managed provider only, preserving local drafts and Router identity", () => {
  const local = config([other]); const server = config([managed]); server.Router.default = "server,old";
  const merged = mergeWorkBuddyProvider(local, server);
  assert.deepEqual(merged.Providers, [other, managed]); assert.equal(merged.Router, local.Router);
  assert.equal(merged.customDraft, "not saved"); assert.equal(merged.Providers[0], other);
  assert.deepEqual(local.Providers, [other]);
});
test("sync refreshes models but respects backend disabled state", () => {
  const old = { ...managed, models: ["old"], enabled: true };
  assert.deepEqual(mergeWorkBuddyProvider(config([old, other]), config([managed])).Providers, [managed, other]);
});
test("disconnect removes only owned provider, never Router refs or other fields", () => {
  const local = config([managed, other]);
  const result = mergeWorkBuddyProvider(local, config([]));
  assert.deepEqual(result.Providers, [other]); assert.equal(result.Router, local.Router);
});
test("ordinary same-name provider is never overwritten or removed", () => {
  const ordinary = { ...managed, ccr_managed: false };
  assert.deepEqual(mergeWorkBuddyProvider(config([ordinary]), config([managed])).Providers, [ordinary]);
  assert.deepEqual(mergeWorkBuddyProvider(config([ordinary]), config([])).Providers, [ordinary]);
});
test("§16 both sites merge independently; one site's disconnect never touches the other", () => {
  const both = mergeWorkBuddyProvider(config([other]), config([managed, managedAi]));
  assert.deepEqual(both.Providers, [other, managed, managedAi]);
  // AI disconnects: the CN provider stays byte-identical and no duplicate rows appear.
  const afterAiDisconnect = mergeWorkBuddyProvider(both, config([managed]));
  assert.deepEqual(afterAiDisconnect.Providers, [other, managed]);
  // AI re-login appends its own provider again without duplicating either site.
  const reconnected = mergeWorkBuddyProvider(afterAiDisconnect, config([managed, { ...managedAi, models: ["kimi-next"] }]));
  assert.deepEqual(reconnected.Providers, [other, managed, { ...managedAi, models: ["kimi-next"] }]);
  assert.equal(reconnected.Providers.filter(provider => provider.name === "workbuddy").length, 1);
  assert.equal(reconnected.Providers.filter(provider => provider.name === "workbuddy-ai").length, 1);
});
test("P1 hide reconciliation: save payload drops exactly the backend-cleared refs, keeps unrelated drafts", () => {
  const cleared = "workbuddy,glm-4.6";
  const unrelated = "custom-provider,draft-model";
  const local = {
    Providers: [other],
    Router: {
      default: cleared,                      // §16: default → first visible model
      background: cleared,                    // scenario cleared → ""
      think: unrelated,                       // unrelated local edit survives
      longContext: "other-provider,long-model",
      webSearch: cleared,
      image: "vision-provider,vision-model",
      models: { keep: unrelated, drop: cleared },
      // The checkpoint backend only rewrites families.<name>.default; family
      // fallback stages are outside the explicit cleanup contract.
      families: { balanced: { default: cleared, background: unrelated, fallback: { longContext: [unrelated] } } },
      custom: {
        "route-keep": { provider: "other-provider", model: "long-model" },
        "route-drop": { provider: "workbuddy", model: "glm-4.6" },  // §16: entry removed entirely
        "route-ref": "workbuddy,glm-4.6",                            // ref-shaped entry removed too
        "route-other": "custom-provider,other",
      },
    },
    customDraft: "not saved",
  } as unknown as Config;
  // Backend fetched after its own cleanup: its saved Router is already clean,
  // while the local draft still carries every cleared reference.
  const server = config([managed]); server.Router.default = "workbuddy,kimi-k2";
  const merged = mergeWorkBuddyHiddenRefs(local, server, [cleared], "workbuddy,kimi-k2");
  // The full-config Save payload is the merged config itself: it must contain
  // none of the removed references, across default/scenario/custom.
  assert.equal(merged.Router.default, "workbuddy,kimi-k2");
  assert.equal(merged.Router.background, "");
  assert.equal(merged.Router.webSearch, "");
  assert.doesNotMatch(JSON.stringify(merged.Router), new RegExp(cleared.replace(/[.*]/g, "\\$&")));
  // Unrelated references and local draft edits survive untouched.
  assert.equal(merged.Router.think, unrelated);
  assert.equal(merged.Router.longContext, "other-provider,long-model");
  assert.equal(merged.Router.image, "vision-provider,vision-model");
  assert.deepEqual(merged.Router.models, { keep: unrelated });
  const family = (merged.Router.families as Record<string, { default: string; background: string; fallback: { longContext: string[] } }>).balanced;
  assert.equal(family.default, "");
  assert.equal(family.background, unrelated);
  assert.deepEqual(family.fallback.longContext, [unrelated]);
  assert.deepEqual(Object.keys(merged.Router.custom as Record<string, unknown>).sort(), ["route-keep", "route-other"]);
  // Unrelated providers (merge) and non-Router drafts survive.
  assert.deepEqual(merged.Providers, [other, managed]);
  assert.equal((merged as { customDraft: string }).customDraft, "not saved");
});
test("P1 hide reconciliation is narrow: no refs reported → draft Router identity; all hidden → default cleared", () => {
  const local = { Providers: [other], Router: { default: "workbuddy,glm-4.6", think: "x,y" }, customDraft: "d" } as unknown as Config;
  const server = config([managed]);
  // Server reported no removed refs: the hide merge reduces to the ordinary
  // draft-preserving merge (Router identity kept byte-for-byte).
  const untouched = mergeWorkBuddyHiddenRefs(local, server, [], "workbuddy,kimi-k2");
  assert.equal(untouched.Router, local.Router);
  // All models hidden → authoritative null fallback clears default.
  const emptied = mergeWorkBuddyHiddenRefs(local, server, ["workbuddy,glm-4.6"], null);
  assert.equal(emptied.Router.default, "");
  assert.equal((emptied.Router as { think: string }).think, "x,y");
});
test("checkpoint hide seam: path labels drive toast only; removedModelRefs + defaultFallback drive cleanup", () => {
  // Actual response shape from backend checkpoint 844d203 for hiding m1.
  const local = {
    Providers: [other],
    Router: {
      default: "workbuddy,m1",
      think: "workbuddy,m1",
      background: "custom,keep",
      unrelatedDraft: "provider,model",
    },
    topLevelDraft: true,
  } as unknown as Config;
  const server = config([{ ...managed, models: ["m2"] }]);
  server.Router = { ...local.Router, default: "workbuddy,m2", think: "" } as Config["Router"];
  const merged = mergeWorkBuddyHiddenRefs(
    local,
    server,
    ["workbuddy,m1"],
    "workbuddy,m2",
  );
  assert.equal(merged.Router.default, "workbuddy,m2");
  assert.equal((merged.Router as { think: string }).think, "");
  assert.equal((merged.Router as { background: string }).background, "custom,keep");
  assert.equal((merged.Router as { unrelatedDraft: string }).unrelatedDraft, "provider,model");
  assert.equal((merged as { topLevelDraft: boolean }).topLevelDraft, true);
  assert.doesNotMatch(JSON.stringify(merged.Router), /workbuddy,m1/);
});
test("checkpoint labels default/scenario:think are never parsed as model references", () => {
  const local = { Providers: [other], Router: { default: "workbuddy,m1", think: "workbuddy,m1", customDraft: 1 } } as unknown as Config;
  const server = config([{ ...managed, models: ["m2"] }]);
  server.Router = { ...local.Router, default: "workbuddy,m2", think: "" } as Config["Router"];
  // removedModelRefs intentionally absent here; the component-derived single
  // ref would be supplied. Passing only toast labels must be a no-op cleanup.
  const merged = mergeWorkBuddyHiddenRefs(local, server, ["default", "scenario:think"], "workbuddy,m2");
  assert.equal(merged.Router, local.Router);
});
test("older hide payload without removedModelRefs/defaultFallback adopts fetched server default", () => {
  const local = { Providers: [other], Router: { default: "workbuddy,m1", think: "workbuddy,m1" } } as unknown as Config;
  const server = config([{ ...managed, models: ["m2", "m3"] }]);
  server.Router = { default: "workbuddy,m2", think: "" } as Config["Router"];
  const merged = mergeWorkBuddyHiddenRefs(local, server, ["workbuddy,m1"], undefined);
  assert.equal(merged.Router.default, "workbuddy,m2");
  assert.equal((merged.Router as { think: string }).think, "");
});
test("P1 login/sync/disconnect/restore merges never adopt the server Router — only hide does", () => {
  const local = config([managed, other]);
  (local.Router as { default: string }).default = "workbuddy,glm-4.6";
  const server = config([managed]);
  (server.Router as { default: string }).default = "workbuddy,kimi-k2";
  // The default merge used by login/sync/disconnect/restore keeps the local
  // draft Router identity — even when the server copy differs.
  assert.equal(mergeWorkBuddyProvider(local, server).Router, local.Router);
});
test("empty or failed discovery is never success", () => {
  for (const result of [{ success: false }, { success: true, status: "connected", models: [] }, { success: true, models: ["a"] }, { success: true, status: "error", models: ["a"] }, { success: true, status: "connected", models: [""] }]) {
    assert.equal(hasDiscoveredModels(result as Parameters<typeof hasDiscoveredModels>[0]), false);
  }
  assert.equal(hasDiscoveredModels({ success: true, status: "connected", models: ["a"] }), true);
});
test("§16 connected verdict tolerates a fully hidden (empty) model set, never failures", () => {
  assert.equal(isWorkBuddyConnected({ success: true, status: "connected", models: [] }), true);
  assert.equal(isWorkBuddyConnected({ success: true, status: "connected" }), true);
  assert.equal(isWorkBuddyConnected({ success: true, status: "connected", models: ["m"] }), true);
  for (const bad of [{ success: false, status: "connected", models: [] }, { success: true, status: "error", models: [] }, { success: true, status: "connected", models: [""] }, { success: true }]) {
    assert.equal(isWorkBuddyConnected(bad as WorkBuddyMutationResponse), false);
  }
});
test("errors only select allowlisted localised labels, never raw messages", () => {
  assert.equal(workBuddyErrorKey({ reason: "sealed", message: "secret" }), "sealed");
  assert.equal(workBuddyErrorKey({ error: "workbuddy_name_conflict" }), "workbuddy_name_conflict");
  assert.equal(workBuddyErrorKey(new Error("Bearer secret")), "request_failed");
  assert.equal(workBuddyErrorKey({ lastError: "11140 restricted secret" }), "restricted");
  assert.equal(workBuddyErrorKey({ lastError: "unapproved channel" }), "channel_rejected");
  assert.equal(workBuddyStateKey({ status: "error", lastError: "11140" } as WorkBuddySiteStatus), "restricted");
});
test("UID masked including short identifiers", () => {
  assert.equal(maskWorkBuddyUid("123456789"), "123…89"); assert.equal(maskWorkBuddyUid("123"), "•••"); assert.equal(maskWorkBuddyUid(null), "—");
});
test("site kind guard accepts only the two fixed sites", () => {
  assert.equal(isWorkBuddyKind("workbuddy"), true); assert.equal(isWorkBuddyKind("workbuddy-ai"), true);
  for (const value of [null, undefined, "", "copilot.tencent.com", "workbuddy-ai2", "WORKBUDDY"]) assert.equal(isWorkBuddyKind(value), false);
});
test("usage payload strictly validated; anything malformed quietly becomes null", () => {
  assert.deepEqual(parseWorkBuddyUsage({ usage: { plan: "Pro", used: 3, limit: 100, unit: "credits" } }), { plan: "Pro", used: 3, limit: 100, unit: "credits" });
  for (const value of [
    null, undefined, {}, { usage: null },
    { usage: {} },
    { usage: { plan: "", used: 0, limit: 1, unit: "credits" } },
    { usage: { plan: "Pro", used: -1, limit: 1, unit: "credits" } },
    { usage: { plan: "Pro", used: Number.POSITIVE_INFINITY, limit: 1, unit: "credits" } },
    { usage: { plan: "Pro", used: "3", limit: 1, unit: "credits" } },
    { usage: { plan: "Pro", used: 3, limit: 0, unit: "credits" } },
    { usage: { plan: "Pro", used: 3, limit: 1, unit: "tokens" } },
    { usage: { plan: "Pro", used: 3, limit: 1, unit: "credits", refreshToken: "leak" } }
  ]) assert.equal(parseWorkBuddyUsage(value), null);
});
test("image-unsupported warning lists only registered models (GLM line)", () => {
  assert.deepEqual(workBuddyImagesUnsupportedModels(["glm-4.6", "claude-x"], ["glm-4.6", "glm-air", ""]), ["glm-4.6"]);
  assert.deepEqual(workBuddyImagesUnsupportedModels(["glm-4.6"], null), []);
  assert.deepEqual(workBuddyImagesUnsupportedModels(["glm-4.6"], "glm-4.6"), []);
  assert.deepEqual(workBuddyImagesUnsupportedModels([], ["glm-4.6"]), []);
});
test("§16 status: the sites map is the source of truth, extracted per site", () => {
  const account: WorkBuddyAccountSummary = { uid: "u1", displayName: "A", source: "browser", active: true };
  const backup: WorkBuddyAccountSummary = { uid: "u2", displayName: null, source: "desktop", active: false, coolingUntil: Date.now() + 60_000 };
  const cn: WorkBuddySiteStatus = { status: "connected", providerName: "workbuddy", accounts: [account, backup], activeUid: "u1", models: ["m1"], hiddenModels: ["m2"], modelCount: 1, lastSyncAt: null, lastError: null };
  const response: WorkBuddyStatusResponse = {
    sites: {
      workbuddy: cn,
      "workbuddy-ai": { status: "not_connected", providerName: "workbuddy-ai", accounts: [], activeUid: null, models: [], hiddenModels: [], modelCount: 0, lastSyncAt: null, lastError: null },
    },
  };
  assert.equal(workBuddySiteStatus(response, "workbuddy")?.status, "connected");
  assert.equal(workBuddySiteStatus(response, "workbuddy")?.accounts.length, 2);
  assert.equal(workBuddySiteStatus(response, "workbuddy-ai")?.status, "not_connected");
  // Malformed account rows are dropped, never rendered.
  const dirty = { sites: { workbuddy: { ...cn, accounts: [account, { uid: 5 }, null] } } } as unknown as WorkBuddyStatusResponse;
  assert.equal(workBuddySiteStatus(dirty, "workbuddy")?.accounts.length, 1);
  // A missing site entry is null, never the other site's state.
  assert.equal(workBuddySiteStatus({ sites: {} }, "workbuddy-ai"), null);
  assert.equal(workBuddySiteStatus({ sites: { "workbuddy-ai": cn } }, "workbuddy"), null);
  assert.equal(workBuddySiteStatus(null, "workbuddy"), null);
});
test("§16 legacy flat status is only a one-version fallback for its own site", () => {
  const legacy = { status: "connected", kind: "workbuddy", providerName: "workbuddy", models: ["m1"], modelCount: 1, uid: "u9", displayName: "D", source: "browser", lastSyncAt: null, lastError: null } as unknown as WorkBuddyStatusResponse;
  const cn = workBuddySiteStatus(legacy, "workbuddy");
  assert.equal(cn?.status, "connected");
  assert.equal(cn?.activeUid, "u9");
  assert.equal(cn?.accounts[0]?.active, true);
  assert.deepEqual(cn?.hiddenModels, []);
  // The other site never inherits the legacy mirror.
  assert.equal(workBuddySiteStatus(legacy, "workbuddy-ai"), null);
});
test("per-site badge: cooling/restricted only when the whole pool is unavailable", () => {
  const now = 1_000_000_000;
  const account = (over: Partial<WorkBuddyAccountSummary> = {}): WorkBuddyAccountSummary =>
    ({ uid: "u", displayName: null, source: "browser", active: true, ...over });
  const site = (accounts: WorkBuddyAccountSummary[], over: Partial<WorkBuddySiteStatus> = {}): WorkBuddySiteStatus =>
    ({ status: "connected", providerName: "workbuddy", accounts, activeUid: "u", models: [], hiddenModels: [], modelCount: 0, lastSyncAt: null, lastError: null, ...over });
  assert.equal(workBuddyStateKey(site([account()]), now), "connected");
  assert.equal(workBuddyStateKey(site([account({ coolingUntil: now + 1 }), account({ coolingUntil: now + 2 })]), now), "cooling");
  assert.equal(workBuddyStateKey(site([account({ restrictedUntil: now + 1 })]), now), "restricted");
  // One usable account keeps the card "connected"; per-row labels show cooling.
  assert.equal(workBuddyStateKey(site([account(), account({ coolingUntil: now + 1 })]), now), "connected");
  // Expired cooldowns no longer count as unavailable.
  assert.equal(workBuddyStateKey(site([account({ coolingUntil: now - 1 })]), now), "connected");
  // P2 regression: a healthy account plus a stale site-level 11140 diagnostic
  // reads connected — the whole card must not be branded restricted.
  assert.equal(workBuddyStateKey(site([account()], { lastError: "11140 restricted secret" }), now), "connected");
  assert.equal(workBuddyAccountCooling(account({ coolingUntil: now + 5 }), now), now + 5);
  assert.equal(workBuddyAccountCooling(account({ coolingUntil: now - 5 }), now), null);
  assert.equal(workBuddyAccountRestricted(account({ restrictedUntil: now + 5 }), now), now + 5);
  assert.equal(workBuddyAccountRestricted(account()), null);
});
test("§16 pool truth beats a stale site-level restriction alert (P2)", () => {
  const now = 1_000_000_000;
  const account = (over: Partial<WorkBuddyAccountSummary> = {}): WorkBuddyAccountSummary =>
    ({ uid: "u", displayName: null, source: "browser", active: true, ...over });
  const site = (accounts: WorkBuddyAccountSummary[], over: Partial<WorkBuddySiteStatus> = {}): WorkBuddySiteStatus =>
    ({ status: "connected", providerName: "workbuddy", accounts, activeUid: "u", models: [], hiddenModels: [], modelCount: 0, lastSyncAt: null, lastError: null, ...over });
  // The false "entire site restricted" alert is suppressed while an account is usable...
  assert.equal(workBuddyVisibleErrorKey(null, site([account()], { lastError: "11140 restricted secret" }), now), null);
  // ...but still surfaces when the pool really has no usable account...
  assert.equal(workBuddyVisibleErrorKey(null, site([account({ restrictedUntil: now + 1 })], { lastError: "11140 restricted secret" }), now), "restricted");
  // ...or the site is not connected (non-restricted diagnostics always surface).
  assert.equal(workBuddyVisibleErrorKey(null, site([], { status: "expired", lastError: "unapproved channel" }), now), "channel_rejected");
  // Action errors always win over the derived diagnostic.
  assert.equal(workBuddyVisibleErrorKey("busy", site([account()], { lastError: "11140 restricted secret" }), now), "busy");
  assert.equal(workBuddyVisibleErrorKey(null, site([account()]), now), null);
});
test("hide path labels are sanitized structurally and never treated as model refs", () => {
  assert.deepEqual(
    sanitizeWorkBuddyRouterPaths(["  default ", "scenario:think", "models:a", "custom:r1", "families.f.default", "scenario:foo", 42, "<script>", "workbuddy,m1", "default\n", "x".repeat(121)]),
    ["default", "scenario:think", "models:a", "custom:r1", "families.f.default"],
  );
  assert.deepEqual(sanitizeWorkBuddyRouterPaths("nope"), []);
  assert.deepEqual(sanitizeWorkBuddyModelRefs(["default", "scenario:think", "custom:r1", "workbuddy,m1", "  workbuddy-ai,m2 ", "x,m3"]), ["workbuddy,m1", "workbuddy-ai,m2"]);
  assert.deepEqual(sanitizeWorkBuddyModelRefs("nope"), []);
  assert.equal(sanitizeWorkBuddyRouterPaths(Array.from({ length: 12 }, (_, index) => `models:alias-${index}`)).length, 8);
});
test("sanitized Router path labels map to localized safe text", () => {
  const labels = {
    default: "Default route",
    scenario: (name: string) => `scenario:${name}`,
    modelAlias: (name: string) => `alias:${name}`,
    familyDefault: (family: string) => `family:${family}`,
    customRoute: (name: string) => `custom:${name}`,
  };
  assert.equal(labelWorkBuddyRouterPath("default", labels), "Default route");
  assert.equal(labelWorkBuddyRouterPath("scenario:think", labels), "scenario:think");
  assert.equal(labelWorkBuddyRouterPath("models:a", labels), "alias:a");
  assert.equal(labelWorkBuddyRouterPath("custom:r-1", labels), "custom:r-1");
  assert.equal(labelWorkBuddyRouterPath("families.f.default", labels), "family:f");
  assert.equal(labelWorkBuddyRouterPath("workbuddy,m1", labels), null);
  assert.equal(labelWorkBuddyRouterPath("<img>", labels), null);
});
test("cooldown clock renders a localized hh:mm and never throws on bad input", () => {
  assert.match(formatWorkBuddyClock(new Date("2026-01-01T08:05:00").getTime()), /\d{1,2}:\d{2}/);
  assert.equal(formatWorkBuddyClock(Number.NaN), "");
});

// Structural regression checks supplement helper tests; they are not rendered
// interaction tests. See WORKBUDDY-TESTING.md for isolated browser smoke steps.
const component = readFileSync(new URL("../src/components/WorkBuddyProvider.tsx", import.meta.url), "utf8");
const providers = readFileSync(new URL("../src/components/Providers.tsx", import.meta.url), "utf8");
const apiSource = readFileSync(new URL("../src/lib/api.ts", import.meta.url), "utf8");
test("WorkBuddy has no token/password/path input, no client takeover action", () => {
  assert.doesNotMatch(component, /<Input|type=["']password|localStorage|enableClient|restartService/);
  assert.match(component, /kind: "disconnect", site \}/);
  // Default merge stays draft-preserving; only hide passes its reconciliation.
  assert.match(component, /refreshConfig\(options\.merge \?\? mergeWorkBuddyProvider\)/);
  assert.match(component, /locked\.current/); assert.match(component, /generation\.current === id/);
  assert.doesNotMatch(component, /console\.|result\.message|status\.lastError\}/);
});
test("§16 one independent card per site with per-site state, never shared", () => {
  assert.match(component, /const WORKBUDDY_SITES: WorkBuddyKind\[\] = \["workbuddy", "workbuddy-ai"\];/);
  assert.match(component, /WORKBUDDY_SITES\.map\(site =>/);
  assert.match(component, /id=\{`workbuddy-management-\$\{site\}`\}/);
  // State lookups are keyed by site: CN actions can never render or clear AI state.
  assert.match(component, /siteStatuses\[site\]/);
  assert.match(component, /errors\[site\] \?\? null/);
  assert.match(component, /usage\[site\]/);
  assert.match(component, /login\.site === site/);
  assert.match(component, /void run\(kind, site, argument\)/);
  // Primary button flips per site state: authorize when offline, add account when connected.
  assert.match(component, /t\("workbuddy\.add_account"\)/);
  assert.match(component, /t\("workbuddy\.browser_login"\)/);
});
test("each site card starts the sequential login helper; credentials never reach UI", () => {
  assert.match(component, /createWorkBuddyLogin\(api, site,/);
  assert.match(component, /target="_blank" rel="noopener noreferrer"/);
  assert.doesNotMatch(component, /window\.open/);
  assert.match(component, /loginSession\.current\?\.cancel\(\)/);
  // Browser-owned refresh is backend-only; no credential handling in UI.
  assert.doesNotMatch(component, /refreshToken|refresh_token|canRefresh/i);
  assert.doesNotMatch(apiSource, /refreshToken|refresh_token|canRefresh|\/refresh/);
});
test("credits are an explicit per-account read that quietly hides failures", () => {
  assert.match(component, /getWorkBuddyUsage\(site, uid\)/);
  assert.match(component, /parseWorkBuddyUsage\(payload\)/);
  // No polling interval: usage read is bound to the explicit action only.
  assert.doesNotMatch(component, /setInterval|useInterval/);
  // Failure path sets null (hide), never renders a raw error from the quota response.
  assert.match(component, /catch \{[\s\S]*?\[uid\]: null/);
  // Stale generation guard also covers the usage read.
  assert.match(component, /readUsage[\s\S]*generation\.current === id/);
  // §16: usage moved to an explicit per-site POST body.
  assert.match(apiSource, /post<WorkBuddyUsageResponse>\(\s*'\/workbuddy\/usage'/);
});
test("status-derived warnings render from contract fields only", () => {
  assert.match(component, /imagesUnsupportedModels/);
  assert.match(component, /workBuddyImagesUnsupportedModels\(models/);
  assert.match(component, /renewalMode === "desktop"/);
  assert.match(component, /renewalMode === "browser"/);
  assert.match(component, /status\.source === "browser"/);
  assert.match(component, /status\?\.site/);
});
test("§16 account rows: per-account read/switch/remove with masked uid and cooldown labels", () => {
  assert.match(component, /maskWorkBuddyUid\(account\.uid\)/);
  assert.match(component, /onAction\("usage", account\.uid\)/);
  assert.match(component, /onAction\("switch", account\.uid\)/);
  assert.match(component, /onConfirm\(\{ kind: "remove", site, uid: account\.uid \}\)/);
  assert.match(component, /workBuddyAccountCooling\(account\)/);
  assert.match(component, /workBuddyAccountRestricted\(account\)/);
  assert.match(component, /workbuddy\.cooling_until/);
  assert.match(component, /workbuddy\.restricted_until/);
  assert.match(component, /source_badge\.\$\{account\.source\}/);
  assert.match(component, /workbuddy\.account_remove_warning/);
  // §16 request shapes live in the api client, per site.
  assert.match(apiSource, /'\/workbuddy\/account\/switch', body/);
  assert.match(apiSource, /'\/workbuddy\/account\/remove', body/);
});
test("§16 model chips hide with a pending lock; hidden models restore singly or all", () => {
  assert.match(component, /onAction\("hide", model\)/);
  assert.match(component, /aria-busy=\{pendingHide\(model\)\}/);
  assert.match(component, /onAction\("restore", model\)/);
  assert.match(component, /=> onAction\("restore"\)\}/);
  assert.match(component, /workbuddy\.hidden_models/);
  assert.match(component, /workbuddy\.cleared_refs/);
  assert.match(component, /sanitizeWorkBuddyRouterPaths\(hidden\.clearedRefs\)/);
  assert.match(apiSource, /'\/workbuddy\/models\/hide'/);
  assert.match(apiSource, /'\/workbuddy\/models\/restore'/);
});
test("hide seam reconciles removedModelRefs/defaultFallback and keeps path labels toast-only", () => {
  assert.match(component, /sanitizeWorkBuddyRouterPaths\(hidden\.clearedRefs\)/);
  assert.match(component, /labelWorkBuddyRouterPath\(pathLabel,/);
  assert.match(component, /workbuddy\.router_path\.default/);
  assert.match(component, /sanitizeWorkBuddyModelRefs\(hidden\.removedModelRefs\)/);
  assert.match(component, /mergeWorkBuddyHiddenRefs\(local, server, removedRefs, hidden\.defaultFallback\)/);
  assert.doesNotMatch(component, /sanitizeClearedRefs/);
  // Alerts use the pool-truth helper instead of the raw lastError derivation.
  assert.match(component, /workBuddyVisibleErrorKey\(errorKey, status\)/);
});
test("generic edit and both delete stages guard managed provider and name the site", () => {
  assert.match(providers, /isManagedWorkBuddy\(provider\).*showWorkBuddyManagement/);
  assert.match(providers, /isManagedWorkBuddy\(filteredProviders\[filteredIndex\]\)/);
  assert.match(providers, /isManagedWorkBuddy\(deletedProvider\)/);
  assert.match(providers, /workBuddyKindOf\(provider\)/);
  // The dashboard never fabricates or deduplicates managed rows itself.
  assert.doesNotMatch(providers, /name:\s*["']workbuddy/);
});
test("EN/ZH WorkBuddy locale parity covers statuses, sites, credits and safe errors", () => {
  const locales = ["en", "zh"].map(lang => JSON.parse(readFileSync(new URL(`../src/locales/${lang}.json`, import.meta.url), "utf8")).workbuddy);
  const keys = (value: Record<string, unknown>, prefix = ""): string[] => Object.entries(value).flatMap(([key, item]) => typeof item === "object" && item ? keys(item as Record<string, unknown>, `${prefix}${key}.`) : [`${prefix}${key}`]);
  assert.deepEqual(keys(locales[0]).sort(), keys(locales[1]).sort());
  for (const locale of locales) {
    for (const state of ["loading", "not_connected", "connected", "expired", "sealed", "source_missing", "source_changed", "error", "restricted", "cooling"]) assert.ok(locale.status[state]);
    assert.ok(locale.errors.models_fetch_failed); assert.ok(locale.server_host); assert.ok(locale.disconnect_warning);
    assert.equal(locale.kind["workbuddy"].length > 0, true); assert.equal(locale.kind["workbuddy-ai"].length > 0, true);
    assert.ok(locale.site.label); assert.ok(locale.site.workbuddy); assert.ok(locale.site["workbuddy-ai"]); assert.ok(locale.site.privacy);
    assert.ok(locale.credits.action); assert.ok(locale.credits.display); assert.ok(locale.renewal_desktop); assert.ok(locale.images_unsupported);
    // §16 additions.
    assert.ok(locale.add_account); assert.ok(locale.managed_provider); assert.ok(locale.hidden_models);
    assert.ok(locale.cleared_refs); assert.ok(locale.restore_all); assert.ok(locale.set_active); assert.ok(locale.remove);
    assert.ok(locale.source_badge.desktop); assert.ok(locale.source_badge.browser);
    assert.ok(locale.cooling_until); assert.ok(locale.restricted_until); assert.ok(locale.account_remove_warning);
    assert.match(String(locale.renewal_desktop), /desktop|桌面/i);
    assert.doesNotMatch(JSON.stringify(locale.credits), /refreshToken/i);
  }
});

const settings = readFileSync(new URL("../src/components/SettingsPage.tsx", import.meta.url), "utf8");
test("settings owns management; dashboard only navigates managed edit/delete", () => {
  assert.doesNotMatch(providers, /<WorkBuddyProvider|scrollIntoView|document.getElementById\(['"]workbuddy-management/);
  assert.match(providers, /navigate\('\/settings\?tab=providers'/);
  assert.match(providers, /workBuddySite: site \?\? undefined/);
  assert.match(settings, /TabsTrigger value="providers"/);
  assert.match(settings, /TabsContent value="providers"/);
  assert.match(settings, /<WorkBuddyProvider disabled=\{isSaving \|\| isRestarting\}/);
  assert.match(settings, /focusSite=\{isWorkBuddyKind\(location\.state\?\.workBuddySite\)/);
  assert.equal((settings.match(/disabled=\{isSaving \|\| isRestarting \|\| workBuddyBusy\}/g) || []).length, 2);
  assert.match(settings, /workbuddy.managed_notice/);
});
