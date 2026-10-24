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
 *                       /plugins/codex/card.js (ESM, browser, no framework).
 *   dist/plugin.json  — the manifest.
 *   dist/package.json — {"type":"module"} so the ESM entry resolves once the
 *                       directory is installed under $CCR_CONFIG_DIR/plugins
 *                       (no package.json exists above it there).
 */
import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const dist = join(root, "dist");
mkdirSync(dist, { recursive: true });

/**
 * Shipped bundles keep their local .map files as debug aids but never
 * reference them — the tarball contract already excludes the maps, so a
 * dangling sourceMappingURL comment in dist would only leak local paths and
 * spam devtools with unresolvable map requests.
 */
const stripSourcemapComment = (file: string): void => {
  const source = readFileSync(file, "utf8");
  writeFileSync(file, source.replace(/\n?\/\/# sourceMappingURL=[^\n]*\n?$/, "\n"));
};

const nodeExternals: string[] = []; // fully self-contained: only node: builtins stay external

const pluginBundle = await esbuild.build({
  entryPoints: [join(root, "src/plugin.ts")],
  bundle: true,
  sourcemap: true,
  metafile: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: join(dist, "plugin.js"),
  external: nodeExternals,
  legalComments: "none",
  logLevel: "info",
});

const hostInputs = Object.keys(pluginBundle.metafile!.inputs).filter(input => /(?:^|\/)core\/src\//.test(input));
if (hostInputs.length) throw new Error(`Plugin must not bundle host runtime modules: ${hostInputs.join(", ")}`);

await esbuild.build({
  entryPoints: [join(root, "src/card-entry.ts")],
  bundle: true,
  sourcemap: true,
  platform: "browser",
  target: "es2020",
  format: "esm",
  outfile: join(dist, "card.js"),
  legalComments: "none",
  logLevel: "info",
});

// dist/plugin.json is DERIVED: the npm version comes from package.json (the
// only version npm publish reads), so a stale root plugin.json must never
// ship a mismatched install manifest. Also guard the runtime manifest const
// in src/plugin.ts so the two sources cannot drift again.
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const manifestJson = JSON.parse(readFileSync(join(root, "plugin.json"), "utf8"));
manifestJson.version = pkg.version;
writeFileSync(join(dist, "plugin.json"), JSON.stringify(manifestJson, null, 2) + "\n");
const declaredVersion = readFileSync(join(root, "src/plugin.ts"), "utf8").match(/version:\s*"([^"]+)"/)?.[1];
if (declaredVersion !== pkg.version) {
  throw new Error(`src/plugin.ts manifest version ${declaredVersion} != package.json ${pkg.version}; keep them in sync`);
}
for (const document of ["README.md", "THIRD_PARTY_NOTICES.md"]) {
  copyFileSync(join(root, document), join(dist, document));
}
writeFileSync(join(dist, "package.json"), JSON.stringify({ type: "module" }, null, 2) + "\n");

// Emit the shipped artifacts without the sourcemap reference comment.
for (const artifact of ["plugin.js", "card.js"]) stripSourcemapComment(join(dist, artifact));

console.log("codex plugin built into dist/");
