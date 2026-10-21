import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  formatWorkBuddyClock, hasDiscoveredModels, isManagedWorkBuddy, isWorkBuddyConnected, isWorkBuddyKind,
  labelWorkBuddyRouterPath, maskWorkBuddyUid, mergeWorkBuddyHiddenRefs, mergeWorkBuddyProvider, parseWorkBuddyUsage,
  sanitizeWorkBuddyModelRefs, sanitizeWorkBuddyRouterPaths, workBuddyAccountCooling, workBuddyAccountRestricted, workBuddyErrorKey,
  workBuddyImagesUnsupportedModels, workBuddyKindOf, workBuddyLoginOutcome, workBuddySettle, workBuddySiteStatus,
  workBuddyStateKey, workBuddyVisibleErrorKey,
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
test("managed detection also matches the CCR marker key and workbuddy_kind for both sites", () => {
  // A config persisted before `ccr_managed` existed is still ours: fixed name
  // plus CCR's own marker key (backend `isWorkBuddyRuntime` parity).
  const legacyCn = { name: "workbuddy", api_key: "ccr-managed-workbuddy", models: [] };
  const legacyAi = { name: "workbuddy-ai", api_key: "ccr-managed-workbuddy-ai", models: [] };
  assert.equal(isManagedWorkBuddy(legacyCn), true);
  assert.equal(isManagedWorkBuddy(legacyAi), true);
  assert.equal(workBuddyKindOf(legacyCn), "workbuddy");
  assert.equal(workBuddyKindOf(legacyAi), "workbuddy-ai");
  // workbuddy_kind alone (name not yet migrated) still identifies the site,
  // so a legacy international entry is never merged into the CN slot.
  const preMigrationAi: Provider = { name: "workbuddy", api_base_url: "https://copilot.tencent.com/v2/chat/completions", api_key: "ccr-managed-workbuddy-ai", workbuddy_kind: "workbuddy-ai", models: [] };
  assert.equal(isManagedWorkBuddy(preMigrationAi), true);
  assert.equal(workBuddyKindOf(preMigrationAi), "workbuddy-ai");
  assert.deepEqual(
    mergeWorkBuddyProvider(config([preMigrationAi]), config([{ ...managedAi, models: ["kimi-next"] }])).Providers,
    [{ ...managedAi, models: ["kimi-next"] }],
  );
  // A user-supplied "workbuddy" name with a real key is never taken over: no
  // marker, no kind, no managed flag. `ccr_managed: true` is authoritative
  // (backend parity) and the server re-locks that entry anyway.
  assert.equal(isManagedWorkBuddy({ name: "workbuddy", api_key: "sk-user-real-key", models: [] }), false);
  assert.equal(isManagedWorkBuddy({ name: "workbuddy", api_key: "sk-user-real-key", ccr_managed: true }), true);
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
  // A user's own "workbuddy" provider carries a real key: no marker, no kind,
  // no managed flag. (An entry holding CCR's marker key is never ordinary.)
  const ordinary = { ...managed, api_key: "sk-user-real-key", ccr_managed: false };
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
  // §16 dropped the cross-site conflict: it is no longer a displayable state.
  assert.equal(workBuddyErrorKey({ error: "workbuddy_site_conflict" }), "request_failed");
  assert.equal(workBuddyErrorKey({ reason: "workbuddy_site_conflict" }), "request_failed");
  assert.equal(workBuddyErrorKey(new Error("Bearer secret")), "request_failed");
  assert.equal(workBuddyErrorKey({ lastError: "11140 restricted secret" }), "restricted");
  assert.equal(workBuddyErrorKey({ lastError: "unapproved channel" }), "channel_rejected");
  assert.equal(workBuddyStateKey({ status: "error", lastError: "11140" } as WorkBuddySiteStatus), "restricted");
});
test("§16 server error codes are displayable, raw messages never are", () => {
  for (const code of ["workbuddy_account_not_found", "workbuddy_model_invalid", "workbuddy_config_write_failed", "workbuddy_login_busy"]) {
    assert.equal(workBuddyErrorKey({ reason: code, message: "RAW-SENTINEL" }), code);
    assert.equal(workBuddyErrorKey({ error: code, message: "RAW-SENTINEL" }), code);
  }
  // Anything outside the allowlist still collapses to the generic code.
  for (const code of ["workbuddy_login_cancelled", "workbuddy_request_failed", "raw upstream text", "<script>alert(1)</script>"]) {
    assert.equal(workBuddyErrorKey({ reason: code, message: "raw" }), "request_failed");
  }
  // The §16 status/pool seam publishes a FIXED diagnostic code instead of any
  // persisted text: classify it, never show it.
  assert.equal(workBuddyErrorKey({ lastError: "workbuddy_restricted" }), "restricted");
  assert.equal(workBuddyErrorKey({ lastError: "workbuddy_channel_rejected" }), "channel_rejected");
  assert.equal(workBuddyErrorKey({ lastError: "workbuddy_error" }), "request_failed");
  assert.equal(workBuddyErrorKey({ lastError: "RAW-SENTINEL-<script>alert(1)</script> /Users/jason/secrets.json" }), "request_failed");
  // The two meaningful classifications keep working against older raw strings.
  assert.equal(workBuddyErrorKey({ lastError: "11140 restricted secret" }), "restricted");
  assert.equal(workBuddyErrorKey({ lastError: "unapproved channel" }), "channel_rejected");
  assert.equal(workBuddyErrorKey({ lastError: "\u8d26\u53f7\u5b58\u5728\u5f02\u5e38\u884c\u4e3a" }), "restricted");
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
test("model ref sanitizer mirrors the server contract (256 chars, spaces/unicode) and stays separate from path labels", () => {
  // Server: `parseWorkBuddyModel` + discovery accept 1-256 chars, rejecting only
  // control characters and a comma. The client must accept exactly that set or
  // the local Router reconciliation silently no-ops for an exotic valid id.
  const long = `workbuddy,${"m".repeat(200)}`;
  const spaced = "workbuddy-ai,glm 5.3 turbo";
  const unicode = "workbuddy-ai,\u667a\u80fd\u4f53-\u00fcber";
  const dotted = "workbuddy,model:v1.2@tenant/region";
  assert.deepEqual(sanitizeWorkBuddyModelRefs([long, spaced, unicode, dotted]), [long, spaced, unicode, dotted]);
  // Exact-equality semantics preserved: trimming, dedupe and the 8-item cap.
  assert.deepEqual(sanitizeWorkBuddyModelRefs([`  ${long}  `, long]), [long]);
  assert.equal(sanitizeWorkBuddyModelRefs(Array.from({ length: 12 }, (_, index) => `workbuddy,m${index}`)).length, 8);
  // Still rejected: unknown provider, comma (would split into another ref),
  // control characters, over-length ids, non-strings.
  for (const bad of [
    "other,m1", "workbuddy", "workbuddy,", ",m1", "workbuddy,m1,m2", "workbuddy,m\n1", "workbuddy,m\u00001",
    // One char over the server's 256-char model bound (not the whole ref).
    `workbuddy,${"m".repeat(257)}`, 42, null, undefined, {}, ["workbuddy,m1"],
  ]) assert.equal(sanitizeWorkBuddyModelRefs([bad as unknown as string]).length, 0);
  // Exactly 256 model chars is accepted, matching the server exactly.
  assert.equal(sanitizeWorkBuddyModelRefs([`workbuddy,${"m".repeat(256)}`]).length, 1);
  // A long/space/unicode ref must actually DRIVE the Router reconciliation
  // (previously sanitized away, the hide cleanup silently no-opped).
  const local = { Providers: [other], Router: { default: spaced, think: spaced, unrelated: "custom,keep" } } as unknown as Config;
  const server = config([managed]);
  server.Router = { ...local.Router, default: "", think: "" } as Config["Router"];
  const merged = mergeWorkBuddyHiddenRefs(local, server, [spaced], "");
  assert.equal(merged.Router.default, "");
  assert.equal((merged.Router as { think: string }).think, "");
  assert.equal((merged.Router as { unrelated: string }).unrelated, "custom,keep");
  // The path-label sanitizer stays a separate, much stricter grammar: an
  // exotic-but-valid model ref is NOT a Router path label.
  assert.deepEqual(sanitizeWorkBuddyRouterPaths([spaced, long, unicode]), []);
  assert.deepEqual(sanitizeWorkBuddyRouterPaths(["default", "scenario:think", "models:a", "families.f.default"]), ["default", "scenario:think", "models:a", "families.f.default"]);
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
  assert.match(providers, /workBuddyKindOf\(config\.Providers\[actualIndex\]\)/);
  assert.match(providers, /workBuddyKindOf\(deletedProvider\)/);
  assert.match(providers, /workBuddyKindOf\(provider\)/);
  // The dashboard never fabricates or deduplicates managed rows itself.
  assert.doesNotMatch(providers, /name:\s*["']workbuddy/);
});
test("managed provider delete is a site-specific disconnect, never a global reset or omission save", () => {
  // §16: the delete path carries the site through the confirmation step...
  assert.match(providers, /setDeletingManagedSite\(managedSite\)/);
  assert.match(providers, /const managedSite = workBuddyKindOf\(deletedProvider\)/);
  // ...and the confirmed action calls the site-specific endpoint.
  assert.match(providers, /api\.disconnectWorkBuddy\(managedSite\)/);
  // A managed delete must never fall through to a full-config save that omits
  // the entry (the backend would resurrect it) and never calls a body-less reset.
  const managedBranch = providers.slice(providers.indexOf("const managedSite = workBuddyKindOf(deletedProvider)"), providers.indexOf("const deletedModels"));
  assert.doesNotMatch(managedBranch, /api\.updateConfig/);
  assert.match(providers, /deletingManagedSite \? t\("workbuddy\.disconnect_title"\)/);
  assert.match(providers, /deletingManagedSite \? t\("workbuddy\.disconnect_warning"\)/);
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
    // §16 login outcome messages: distinct added/updated copy, count interpolated, never duplicate-silent.
    assert.match(String(locale.account_added), /\{\{count\}\}/); assert.match(String(locale.account_updated), /\{\{count\}\}/);
    assert.match(String(locale.account_added), /not a duplicate|并非重复/);
    assert.match(String(locale.account_updated), /not a duplicate|并非重复/);
    assert.ok(locale.cleared_refs); assert.ok(locale.restore_all); assert.ok(locale.set_active); assert.ok(locale.remove);
    assert.ok(locale.source_badge.desktop); assert.ok(locale.source_badge.browser);
    assert.ok(locale.cooling_until); assert.ok(locale.restricted_until); assert.ok(locale.account_remove_warning);
    assert.match(String(locale.renewal_desktop), /desktop|桌面/i);
    // §16 management codes: every allowlisted route/service code has a
    // localised string, so the UI never falls back to a raw key or message.
    for (const code of ["workbuddy_account_not_found", "workbuddy_model_invalid", "workbuddy_config_write_failed", "workbuddy_login_busy"]) {
      assert.ok(locale.errors[code], `missing ${code}`);
      assert.doesNotMatch(locale.errors[code], /workbuddy_/);
    }
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
  // Both Save buttons honour the WorkBuddy gate (the Gemini card adds its own
  // busy flag to the same guard; gemini-oauth.test.ts asserts that pairing).
  assert.equal((settings.match(/disabled=\{isSaving \|\| isRestarting \|\| workBuddyBusy[ \}]/g) || []).length, 2);
  assert.match(settings, /workbuddy.managed_notice/);
});

test("login wiring uses the committed-upsert outcome and settle sequencing", () => {
  assert.match(component, /workBuddyLoginOutcome\(connected\)/);
  assert.match(component, /workBuddySettle\(/);
  assert.doesNotMatch(component, /t\("workbuddy\.synced", \{ count: connected/);
});

test("login completion message derives NEW row vs re-authorization from committed metadata, with a safe fallback", () => {
  // New second account: distinct key + committed pool count.
  assert.deepEqual(workBuddyLoginOutcome({ models: ["m"], accountChange: "added", accountCount: 2 }), { key: "workbuddy.account_added", values: { count: 2 } });
  // Same-uid re-login: explicit update wording, count stays the committed size.
  assert.deepEqual(workBuddyLoginOutcome({ models: ["m"], accountChange: "updated", accountCount: 1 }), { key: "workbuddy.account_updated", values: { count: 1 } });
  // Safe fallbacks: older server (no metadata) keeps the legacy model-sync message.
  assert.deepEqual(workBuddyLoginOutcome({ models: ["a", "b"] }), { key: "workbuddy.synced", values: { count: 2 } });
  assert.deepEqual(workBuddyLoginOutcome({ modelCount: 3 }), { key: "workbuddy.synced", values: { count: 3 } });
  assert.deepEqual(workBuddyLoginOutcome(null), { key: "workbuddy.synced", values: { count: 0 } });
  assert.deepEqual(workBuddyLoginOutcome(undefined), { key: "workbuddy.synced", values: { count: 0 } });
  // Implausible metadata never reaches the message: wrong type / non-integer /
  // out-of-bounds count degrades to the generic message instead of lying.
  for (const bad of [{ accountChange: "added", accountCount: "2" }, { accountChange: "added", accountCount: 2.5 }, { accountChange: "added", accountCount: 0 }, { accountChange: "added", accountCount: -1 }, { accountChange: "added", accountCount: 100_001 }, { accountChange: "added" }]) {
    assert.deepEqual(workBuddyLoginOutcome(bad), { key: "workbuddy.synced", values: { count: 0 } });
  }
  // No credential material is ever part of the outcome.
  const outcome = workBuddyLoginOutcome({ models: ["m"], accountChange: "added", accountCount: 1 });
  assert.equal(JSON.stringify(outcome).includes("token"), false);
});

test("post-action settle refreshes pool status even when the unrelated config draft refresh fails", async () => {
  let statusReads = 0;
  const ok = await workBuddySettle(async () => {}, async () => { statusReads++; return "status-ok"; });
  assert.deepEqual(ok, { status: "status-ok", configReconciled: true });
  assert.equal(statusReads, 1);
  // Config refresh failure (unrelated to the persisted WorkBuddy mutation)
  // must NOT suppress the status refresh; the failure stays surfaced as
  // configReconciled=false (ConfigProvider shows the config error itself).
  let readsAfterFailure = 0;
  const degraded = await workBuddySettle(async () => { throw new Error("Configuration refresh failed"); }, async () => { readsAfterFailure++; return "status-after-failure"; });
  assert.deepEqual(degraded, { status: "status-after-failure", configReconciled: false });
  assert.equal(readsAfterFailure, 1);
});
