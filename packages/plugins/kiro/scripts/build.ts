/**
 * Build the prebuilt plugin artifacts (docs/design/provider-plugins.md §2.2):
 *
 *   dist/plugin.js    — the core loads this entry (ESM, self-contained bundle:
 *                       protocol, auth service, transformer/runtime, admin
 *                       routes and locales are all bundled; host modules are
 *                       NOT — they only enter through PluginContext.host; core
 *                       is referenced via TYPE-ONLY imports that esbuild
 *                       erases, so no packages/core/src input enters the graph).
 *   dist/card.js      — the UI card chunk the core serves at
 *                       /plugins/kiro/card.js (ESM, browser, no framework).
 *   dist/plugin.json  — the manifest.
 *   dist/package.json — {"type":"module"} so the ESM entry resolves once the
 *                       directory is installed under $CCR_CONFIG_DIR/plugins
 *                       (no package.json exists above it there).
 */
import { build } from "esbuild";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const dist = join(root, "dist");
// Validate identity before writing any artifacts. npm pack/publish runs this
// build through prepack, so stale dist/ cannot bypass the version guard.
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const declaredVersion = (await readFile(join(root, "src/plugin.ts"), "utf8")).match(/version:\s*"([^"]+)"/)?.[1];
if (declaredVersion !== pkg.version) {
  throw new Error(`src/plugin.ts manifest version ${declaredVersion} != package.json ${pkg.version}; keep them in sync`);
}
await mkdir(dist, { recursive: true });
const result = await build({ entryPoints: [join(root, "src/plugin.ts")], outfile: join(dist, "plugin.js"), bundle: true,
  platform: "node", format: "esm", target: "node20", sourcemap: "external", metafile: true, legalComments: "none" });
if (Object.keys(result.metafile!.inputs).some(p => /(?:^|\/)core\/src\//.test(p))) throw new Error("Plugin bundle contains host runtime code");
// The card chunk is browser-only: DOM + the host card capabilities (type-only
// import, erased at build). It must never pull node builtins into the graph.
const card = await build({ entryPoints: [join(root, "src/card-entry.ts")], outfile: join(dist, "card.js"), bundle: true,
  platform: "browser", format: "esm", target: "es2020", sourcemap: "external", metafile: true, legalComments: "none" });
if (Object.keys(card.metafile!.inputs).some(p => /(?:^|\/)core\/src\//.test(p))) throw new Error("Card bundle contains host runtime code");
await writeFile(join(dist, "plugin.json"), JSON.stringify({ name: "kiro", version: pkg.version, coreApi: "1", description: pkg.description }, null, 2) + "\n");
await writeFile(join(dist, "package.json"), '{"type":"module"}\n');
await copyFile(join(root, "README.md"), join(dist, "README.md"));
console.log("kiro authentication plugin built into dist/");
