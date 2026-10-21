import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Shared build identity: the card the tests exercise must be exactly the
 * source the build ships as dist/card.js, and the card must consume the shared
 * UI sources (contract, helpers, locale bundles) instead of a vendored copy —
 * so UI tests, plugin tests and the served bundle all verify one implementation.
 */
const here = dirname(fileURLToPath(import.meta.url));
const repoUi = join(here, "..", "..", "..", "ui");
const read = (p: string) => readFileSync(join(here, "..", p), "utf8");

describe("shared build identity", () => {
  it("the tested card entry is exactly the chunk the build ships as card.js", () => {
    const build = read("scripts/build.ts");
    expect(build).toContain('entryPoints: [join(root, "src/card-entry.ts")]');
    expect(build).toContain('outfile: join(dist, "card.js")');
  });

  it("card-entry consumes the shared UI contract and helpers — no vendored card copy", () => {
    const card = read("src/card-entry.ts");
    expect(card).toContain('from "../../../ui/src/utils/plugin-card"');
    expect(card).toContain('from "../../../ui/src/utils/gemini-oauth"');
    expect(card).toContain('from "../../../ui/src/utils/gemini-oauth-login"');
    expect(card).toContain('from "../../../ui/src/types"');
    // The shared UI source files really exist where the imports point.
    expect(readFileSync(join(repoUi, "src", "utils", "plugin-card.ts"), "utf8")).toContain("PluginCardMountProps");
    expect(readFileSync(join(repoUi, "src", "utils", "gemini-oauth.ts"), "utf8")).toContain("geminiOauthStateKey");
  });

  it("card copy is sourced from the shared UI locale bundles in both languages", () => {
    const locales = read("src/locales.ts");
    expect(locales).toContain('"../../../ui/src/locales/en.json"');
    expect(locales).toContain('"../../../ui/src/locales/zh.json"');
    const en = JSON.parse(readFileSync(join(repoUi, "src", "locales", "en.json"), "utf8"));
    const zh = JSON.parse(readFileSync(join(repoUi, "src", "locales", "zh.json"), "utf8"));
    for (const [language, bundle] of [["en", en], ["zh", zh]] as const) {
      expect(typeof bundle.geminiOauth.errors.reconciliation_failed).toBe("string");
      for (const key of ["area_label", "manifest_failed", "unavailable_title", "disabled_hint", "reinstall_hint", "card_failed_title"]) {
        expect(typeof bundle.pluginCards[key], `${language}.${key}`).toBe("string");
      }
    }
  });
});
