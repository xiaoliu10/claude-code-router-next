/**
 * Build the prebuilt plugin artifacts (docs/design/provider-plugins.md §2.2):
 *
 *   dist/plugin.js    — the core loads this entry (ESM, self-contained bundle:
 *                       protocol, auth service, transformer, managed runtime,
 *                       admin routes and locales are all bundled; host modules
 *                       are NOT — they only enter through PluginContext.host).
 *   dist/card.js      — the UI card chunk the core serves at
 *                       /plugins/<name>/card.js (ESM, browser, no framework).
 *   dist/plugin.json  — the manifest.
 *   dist/package.json — {"type":"module"} so the ESM entry resolves once the
 *                       directory is installed under $CCR_CONFIG_DIR/plugins
 *                       (no package.json exists above it there).
 */
import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const dist = join(root, "dist");
mkdirSync(dist, { recursive: true });

const nodeExternals = []; // fully self-contained: only node: builtins stay external

await esbuild.build({
  entryPoints: [join(root, "src/plugin.ts")],
  bundle: true,
  sourcemap: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: join(dist, "plugin.js"),
  external: nodeExternals,
  legalComments: "none",
  logLevel: "info",
});

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

copyFileSync(join(root, "plugin.json"), join(dist, "plugin.json"));
copyFileSync(join(root, "THIRD_PARTY_NOTICES.md"), join(dist, "THIRD_PARTY_NOTICES.md"));
writeFileSync(join(dist, "package.json"), JSON.stringify({ type: "module" }, null, 2) + "\n");

console.log("workbuddy plugin built into dist/");
