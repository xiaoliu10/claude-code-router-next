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

test("PluginCardArea fetches /api/plugins via the api client and mounts cards dynamically", () => {
  const src = read("components/PluginCardArea.tsx");
  assert.match(src, /api\.getPlugins\(\)/);
  // Dynamic import of the served chunk must stay out of the bundler's graph.
  assert.match(src, /import\(\/\* @vite-ignore \*\/ plugin\.cardUrl\)/);
  // Cards get the host bridge, never raw fetch.
  assert.match(src, /callApi:\s*<T,>\(path[\s\S]*?api\.callPluginApi<T>\(plugin\.name, path, init\)/);
  assert.ok(!/fetch\(/.test(src.replace(/callApi[^;]*api\.callPluginApi/g, "")));
  // Unmount cleanup exists — plugin cleanup must not break the host.
  assert.match(src, /unmount\?\.\(entry\.el\)/);
  assert.match(src, /busyCountRef/);
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

test("SettingsPage mounts the plugin card area after the built-in managed cards", () => {
  const src = read("components/SettingsPage.tsx");
  const gemini = src.indexOf("<WorkBuddyProvider");
  const pluginArea = src.indexOf("<PluginCardArea");
  assert.ok(gemini !== -1 && pluginArea !== -1 && pluginArea > gemini);
});
