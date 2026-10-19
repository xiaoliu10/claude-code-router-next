import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isManagedWorkBuddy, mergeWorkBuddyProvider, workBuddyErrorKey, workBuddyStateKey, maskWorkBuddyUid, hasDiscoveredModels } from "../src/utils/workbuddy.ts";
import type { Config, Provider, WorkBuddyStatusResponse } from "../src/types.ts";

const managed: Provider = { name: "workbuddy", api_base_url: "https://copilot.tencent.com/v2/chat/completions", api_key: "ccr-managed-workbuddy", models: ["new-model"], ccr_managed: true, enabled: false };
const other: Provider = { name: "custom", api_base_url: "https://example.invalid", api_key: "mock", models: ["draft"] };
const config = (providers: Provider[]) => ({ Providers: providers, Router: { default: "local,draft", custom: { preserve: true } }, customDraft: "not saved" }) as unknown as Config;

test("managed detection requires exact name plus strict true", () => {
  assert.equal(isManagedWorkBuddy(managed), true);
  for (const value of [null, {}, { name: "workbuddy" }, { name: "workbuddy", ccr_managed: "true" }, { name: "other", ccr_managed: true }]) assert.equal(isManagedWorkBuddy(value), false);
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
test("empty or failed discovery is never success", () => {
  for (const result of [{ success: false }, { success: true, status: "connected", models: [] }, { success: true, models: ["a"] }, { success: true, status: "error", models: ["a"] }, { success: true, status: "connected", models: [""] }]) {
    assert.equal(hasDiscoveredModels(result as Parameters<typeof hasDiscoveredModels>[0]), false);
  }
  assert.equal(hasDiscoveredModels({ success: true, status: "connected", models: ["a"] }), true);
});
test("errors only select allowlisted localised labels, never raw messages", () => {
  assert.equal(workBuddyErrorKey({ reason: "sealed", message: "secret" }), "sealed");
  assert.equal(workBuddyErrorKey({ error: "workbuddy_name_conflict" }), "workbuddy_name_conflict");
  assert.equal(workBuddyErrorKey(new Error("Bearer secret")), "request_failed");
  assert.equal(workBuddyErrorKey({ lastError: "11140 restricted secret" }), "restricted");
  assert.equal(workBuddyErrorKey({ lastError: "unapproved channel" }), "channel_rejected");
  assert.equal(workBuddyStateKey({ status: "error", lastError: "11140" } as WorkBuddyStatusResponse), "restricted");
});
test("UID masked including short identifiers", () => {
  assert.equal(maskWorkBuddyUid("123456789"), "123…89"); assert.equal(maskWorkBuddyUid("123"), "•••"); assert.equal(maskWorkBuddyUid(null), "—");
});

// Structural regression checks supplement helper tests; they are not rendered
// interaction tests. See WORKBUDDY-TESTING.md for isolated browser smoke steps.
const component = readFileSync(new URL("../src/components/WorkBuddyProvider.tsx", import.meta.url), "utf8");
const providers = readFileSync(new URL("../src/components/Providers.tsx", import.meta.url), "utf8");
test("WorkBuddy has no token/password/path input, no client takeover action", () => {
  assert.doesNotMatch(component, /<Input|type=["']password|localStorage|enableClient|restartService/);
  assert.match(component, /workbuddy-consent/); assert.match(component, /setConfirm\("disconnect"\)/);
  assert.match(component, /refreshConfig\(mergeWorkBuddyProvider\)/);
  assert.match(component, /locked\.current/); assert.match(component, /generation\.current === id/);
  assert.doesNotMatch(component, /console\.|result\.message|status\.lastError\}/);
});
test("generic edit and both delete stages guard managed provider", () => {
  assert.match(providers, /isManagedWorkBuddy\(provider\).*showWorkBuddyManagement/);
  assert.match(providers, /isManagedWorkBuddy\(filteredProviders\[filteredIndex\]\)/);
  assert.match(providers, /isManagedWorkBuddy\(deletedProvider\)/);
});
test("EN/ZH WorkBuddy locale parity covers statuses and safe errors", () => {
  const locales = ["en", "zh"].map(lang => JSON.parse(readFileSync(new URL(`../src/locales/${lang}.json`, import.meta.url), "utf8")).workbuddy);
  const keys = (value: Record<string, unknown>, prefix = ""): string[] => Object.entries(value).flatMap(([key, item]) => typeof item === "object" && item ? keys(item as Record<string, unknown>, `${prefix}${key}.`) : [`${prefix}${key}`]);
  assert.deepEqual(keys(locales[0]).sort(), keys(locales[1]).sort());
  for (const locale of locales) {
    for (const state of ["loading", "not_connected", "connected", "expired", "sealed", "source_missing", "source_changed", "error", "restricted"]) assert.ok(locale.status[state]);
    assert.ok(locale.errors.models_fetch_failed); assert.ok(locale.server_host); assert.ok(locale.disconnect_warning);
  }
});
