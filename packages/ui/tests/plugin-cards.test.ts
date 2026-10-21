import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

import { sanitizePluginErrorCode, pluginLocaleOf } from "../src/utils/plugin-card.ts";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(here, "..", "src", p), "utf8");

test("sanitizePluginErrorCode passes well-formed code tokens only", () => {
  assert.equal(sanitizePluginErrorCode("codex_login_busy"), "codex_login_busy");
  assert.equal(sanitizePluginErrorCode("Fake-Code-9"), "Fake-Code-9");
  assert.equal(sanitizePluginErrorCode("a".repeat(64)), "a".repeat(64));
});

test("sanitizePluginErrorCode drops raw messages and hostile shapes", () => {
  for (const bad of [
    "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account",
    "refresh_token: 1//0abcDEF123",
    "has spaces",
    "", "  ", "-leading-dash", "x".repeat(65),
    42, null, undefined, {}, ["code"],
  ]) {
    assert.equal(sanitizePluginErrorCode(bad as any), null, JSON.stringify(bad));
  }
});

test("pluginLocaleOf maps zh family to zh, everything else to en", () => {
  assert.equal(pluginLocaleOf("zh-CN"), "zh");
  assert.equal(pluginLocaleOf("zh"), "zh");
  assert.equal(pluginLocaleOf("en-US"), "en");
  assert.equal(pluginLocaleOf(undefined), "en");
});

test("PluginCardArea loads cards via the authenticated host lane and renders failures", () => {
  const src = read("components/PluginCardArea.tsx");
  assert.match(src, /api\.getPlugins\(\)/);
  // Host lane: authenticated source fetch (admin key header) → same-origin
  // Blob URL → dynamic import kept out of the bundler's graph → revoke on cleanup.
  assert.match(src, /fetchCardSource:\s*\(cardUrl\)\s*=>\s*api\.fetchPluginCardSource\(cardUrl\)/);
  assert.match(src, /importModule:\s*\(url\)\s*=>\s*import\(\/\* @vite-ignore \*\/ url\)/);
  assert.match(src, /makeBlobUrl:\s*\(source\)\s*=>\s*URL\.createObjectURL/);
  assert.match(src, /revokeBlobUrl:\s*\(url\)\s*=>\s*URL\.revokeObjectURL\(url\)/);
  // A bare import of the manifest-declared URL can never authenticate remotely.
  assert.doesNotMatch(src, /import\(\/\* @vite-ignore \*\/ plugin\.cardUrl\)/);
  // Cards get the host bridge, never raw fetch.
  assert.match(src, /callPluginApi:\s*\(plugin,\s*path,\s*init\)\s*=>\s*api\.callPluginApi\(plugin,\s*path,\s*init\)/);
  const bridged = src
    .replace(/callPluginApi[^;]*api\.callPluginApi/g, "")
    .replace(/fetchCardSource[^;]*api\.fetchPluginCardSource/g, "");
  assert.ok(!/fetch\(/.test(bridged));
  // Host state changes reach cards in place (no remount).
  assert.match(src, /notifyHostChange\(\)/);
  // Unmount cleanup exists — plugin cleanup must not break the host.
  assert.match(src, /controller\.dispose\(\)/);
  // Missing/disabled/error plugins and broken cards render visible recovery notices.
  assert.match(src, /data-testid="plugin-card-issue"/);
  assert.match(src, /role="note"/);
  assert.match(src, /t\("pluginCards\.manifest_failed"\)/);
  assert.match(src, /t\("pluginCards\.reinstall_hint"\)/);
});

test("api.callPluginApi routes plugin paths with sanitization and format check", () => {
  const src = read("lib/api.ts");
  // Route: /api/<plugin><path> via the shared apiFetch boundary.
  assert.match(src, /callPluginApi<T = unknown>\(plugin: string, path: string/);
  assert.match(src, /this\.apiFetch<T>\(`\/\$\{plugin\}\$\{path\}`/);
  // Name format guard before any request.
  assert.match(src, /\/\^\[a-z0-9\]\[a-z0-9-\]\*\$\/i\.test\(plugin\)/);
  // Error boundary: code-token pass-through only, raw message never kept.
  assert.match(src, /sanitizePluginErrorCode\(data\.reason \?\? data\.error\)/);
  assert.match(src, /reason: code, plugin: pluginName/);
});

test("api.fetchPluginCardSource keeps the card lane authenticated and same-origin", () => {
  const src = read("lib/api.ts");
  assert.match(src, /async fetchPluginCardSource\(cardUrl: string\): Promise<string>/);
  // Same-origin guard runs BEFORE any request carries credentials.
  assert.match(src, /isSameOriginCardUrl\(cardUrl, origin\)/);
  assert.match(src, /headers: this\.createHeaders\(''\)/);
  assert.match(src, /credentials: 'same-origin'/);
  // The card URL itself must never be turned into a keyed URL.
  assert.doesNotMatch(src, new RegExp("cardUrl[^\\n]*apiKey"));
});

test("SettingsPage mounts only the generic plugin card area", () => {
  const src = read("components/SettingsPage.tsx");
  const pluginArea = src.indexOf("<PluginCardArea");
  assert.ok(pluginArea !== -1);
  assert.doesNotMatch(src, /<WorkBuddyProvider/);
});

test("generic managed provider edit/save/delete navigate to Settings, never omission-save or inline disconnect", () => {
  const providers = read("components/Providers.tsx");
  assert.match(providers, /provider\?\.ccr_managed === true/);
  assert.match(providers, /api_key\?\.startsWith\("ccr-managed-"\)/);
  assert.match(providers, /showManagedProviderManagement = \(providerName\?: string\) =>/);
  assert.match(providers, /navigate\('\/settings\?tab=providers', \{/);
  for (const [start, end] of [["const handleEditProvider", "const handleSaveProvider"],
    ["const handleSaveProvider", "// Validate name"],
    ["const handleSetDeletingProviderIndex", "const handleRemoveProvider"],
    ["const handleRemoveProvider", "const deletedModels"]]) {
    const body = providers.slice(providers.indexOf(start), providers.indexOf(end, providers.indexOf(start) + 1));
    assert.match(body, /isManagedProvider\(/); assert.match(body, /showManagedProviderManagement\(/);
  }
});

test("the CCR self provider stays editable/deletable; marker-managed rows keep the card guard", () => {
  const providers = read("components/Providers.tsx");
  // Mirror of shared isCcrSelfProvider: name==="ccr" + ccr_managed (real admin key).
  assert.match(providers, /const isCcrSelfProvider = \(provider: ProviderType \| null \| undefined\): boolean =>/);
  assert.match(providers, /provider\.name === "ccr" && provider\.ccr_managed === true/);
  assert.match(providers, /!isCcrSelfProvider\(provider\) &&/);
  // Marker-managed rows still navigate to the owning card.
  assert.match(providers, /provider\?\.ccr_managed === true \|\| provider\?\.api_key\?\.startsWith\("ccr-managed-"\) === true/);
});

test("managed row navigation carries a generic focus key and the area renders the generic notice", () => {
  const providers = read("components/Providers.tsx");
  assert.match(providers, /state: \{ managedProviderNotice: true, managedProviderFocus: providerName \?\? null \}/);
  const settings = read("components/SettingsPage.tsx");
  assert.match(settings, /location\.state\?\.managedProviderNotice && <p role="note"/);
  assert.match(settings, /t\("pluginCards\.managed_notice"\)/);
  assert.match(settings, /focusKey=\{\(location\.state as \{ managedProviderFocus\?: string \| null \} \| null\)\?\.managedProviderFocus \?\? null\}/);
  const area = read("components/PluginCardArea.tsx");
  assert.match(area, /focusKey\?: string \| null/);
  // One-shot: consumed before the sync hands it to cards, never re-triggered.
  assert.match(area, /pendingFocus\.current = null;/);
  const contract = read("utils/plugin-card.ts");
  assert.match(contract, /focusKey\?: string \| null;/);
  assert.match(contract, /sync\(entries: PluginInfo\[\] \| null, locale: string, host: HTMLElement, focusKey\?: string \| null\)/);
});
