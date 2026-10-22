import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoUi = join(here, "..", "..", "..", "ui");
const read = (p: string) => readFileSync(join(here, "..", p), "utf8");

describe("shared build identity", () => {
  it("the tested card entry is exactly the chunk the build ships as card.js", () => {
    const build = read("scripts/build.ts");
    expect(build).toContain('entryPoints: [join(root, "src/card-entry.ts")]');
    expect(build).toContain('outfile: join(dist, "card.js")');
  });

  it("the build strips sourceMappingURL comments from both shipped bundles (F3)", () => {
    const build = read("scripts/build.ts");
    // Local .map files stay as debug aids; the reference line never ships.
    expect(build).toContain("stripSourcemapComment");
    expect(build).toContain("sourceMappingURL");
    expect(build).toContain('"plugin.js"');
    expect(build).toContain('"card.js"');
  });

  it("ships self-contained bundles with no core implementation imports", async () => {
    const { build } = await import("esbuild");
    for (const [entry, platform] of [["plugin", "node"], ["card-entry", "browser"]] as const) {
      const result = await build({ entryPoints: [join(here, "../src", `${entry}.ts`)], bundle: true,
        write: false, metafile: true, platform, format: "esm", logLevel: "silent" });
      expect(Object.keys(result.metafile!.inputs).filter(p => /core\/src\//.test(p))).toEqual([]);
      expect(result.metafile!.outputs).toBeTruthy();
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
