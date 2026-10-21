import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Shared build identity (dual-run window): the card the tests exercise must be
 * exactly the source the build ships as dist/card.js, and the card-local
 * helper copies must stay byte-identical (modulo the documented rewiring) to
 * the still-live UI sources, so the static React card and the plugin card
 * cannot drift before the hard cut removes the UI copies.
 */
const here = dirname(fileURLToPath(import.meta.url));
const repoUi = join(here, "..", "..", "..", "ui");
const read = (p: string) => readFileSync(join(here, "..", p), "utf8");

/**
 * Normalize a helper source for comparison: drop imports, block comments and
 * comment-only lines, drop the plugin-only injected type declarations, and map
 * the plugin's structural type names back to the UI originals.
 */
function normalize(source: string, isPlugin: boolean): string {
  let s = source;
  if (isPlugin) {
    s = s.slice(s.indexOf("import "));
    s = s.replace(/\/\*\* Structural config\/provider drafts[\s\S]*?export interface CardConfig \{[^\n]*\n\n/, "");
    s = s.replaceAll("CardProvider", "Provider").replaceAll("CardConfig", "Config");
  }
  s = s.replace(/^import[\s\S]*?from "[^"]+";$/gm, "");
  s = s.replace(/\/\*[\s\S]*?\*\//g, "");
  s = s.replace(/^\s*\/\/.*$/gm, "");
  // Documented rewiring: the plugin structural Router type is `any`, so the
  // UI's `as Config["Router"]` cast is dropped.
  s = s.replaceAll(' as Config["Router"]', "");
  return s.split("\n").map(l => l.trim()).filter(Boolean).join("\n");
}

describe("shared build identity", () => {
  it("the tested card entry is exactly the chunk the build ships as card.js", () => {
    const build = read("scripts/build.ts");
    expect(build).toContain('entryPoints: [join(root, "src/card-entry.ts")]');
    expect(build).toContain('outfile: join(dist, "card.js")');
  });

  it("card helpers stay identical to the live UI sources during the dual-run window", () => {
    for (const [uiPath, pluginPath] of [
      ["src/utils/workbuddy.ts", "src/card-shared.ts"],
      ["src/utils/workbuddy-login.ts", "src/card-login.ts"],
    ] as const) {
      const ui = normalize(readFileSync(join(repoUi, uiPath), "utf8"), false);
      const plugin = normalize(read(pluginPath), true);
      expect(plugin, `${pluginPath} drifted from ${uiPath}`).toBe(ui);
    }
  });

  it("the plugin locale bundle is byte-parity with the UI workbuddy sections in both languages", async () => {
    const { workbuddyLocales } = await import("../src/locales");
    for (const language of ["en", "zh"] as const) {
      const uiBundle = JSON.parse(readFileSync(join(repoUi, "src", "locales", `${language}.json`), "utf8")).workbuddy;
      expect((workbuddyLocales as any)[language].workbuddy).toEqual(uiBundle);
    }
  });

  it("the card consumes the shared host controller contract and its own moved helpers", () => {
    const card = read("src/card-entry.ts");
    expect(card).toContain('from "../../../ui/src/utils/plugin-card"');
    expect(card).toContain('from "./card-shared"');
    expect(card).toContain('from "./card-login"');
    expect(card).toContain('from "./card-types"');
    // The shared UI controller really exists where the import points.
    expect(readFileSync(join(repoUi, "src", "utils", "plugin-card.ts"), "utf8")).toContain("PluginCardMountProps");
  });
});
