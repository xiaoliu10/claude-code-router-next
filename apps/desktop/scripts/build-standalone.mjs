#!/usr/bin/env node
/**
 * Standalone desktop app build (macOS).
 *
 * - With a staged runtime (apps/desktop/runtime/MANIFEST.json): builds the
 *   .app, then copies the runtime tree into Contents/Resources/runtime with
 *   plain structure-preserving copy. Tauri's `bundle.resources` flattens
 *   directory trees in this version, so the runtime is NOT declared there and
 *   the plain tauri.conf.json stays CI-safe (no binary required to build).
 * - Without staging: builds the shell app WITHOUT a runtime and says so
 *   loudly. There is no installed-CCR fallback at runtime; a shell-only
 *   artifact reports an explicit missing-bundle error instead of spawning.
 *
 * Usage: node scripts/build-standalone.mjs
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const runtimeDir = path.join(desktopDir, "runtime");
const srcTauriDir = path.join(desktopDir, "src-tauri");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: "inherit", ...options });
  if (result.status !== 0) {
    console.error(`build-standalone: ${command} failed (${result.status})`);
    process.exit(result.status ?? 1);
  }
}

const staged =
  fs.existsSync(path.join(runtimeDir, "MANIFEST.json")) &&
  fs.existsSync(path.join(runtimeDir, "node")) &&
  fs.existsSync(path.join(runtimeDir, "service", "entry.cjs"));

run("cargo", ["tauri", "build", "--bundles", "app", "--no-sign"], { cwd: srcTauriDir });

const bundlePath = path.join(srcTauriDir, "target", "release", "bundle", "macos", "CCR Desktop.app");
if (!staged) {
  console.warn(
    "build-standalone: NO runtime staged — shell-only artifact; it reports an explicit " +
      "missing-bundle error at runtime. Run `node apps/desktop/scripts/prepare-runtime.mjs` first.",
  );
} else {
  const resourcesRuntime = path.join(bundlePath, "Contents", "Resources", "runtime");
  fs.rmSync(resourcesRuntime, { recursive: true, force: true });
  // Structure-preserving copy of the deterministic staging; never user data,
  // credentials, plugins, or databases (.runtime-cache lives outside runtime/).
  fs.cpSync(runtimeDir, resourcesRuntime, { recursive: true });
  const required = [
    "node",
    "LICENSE-node",
    "bin/npm",
    "lib/node_modules/npm/package.json",
    "service/entry.cjs",
    "service/tiktoken_bg.wasm",
    "service/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
    "MANIFEST.json",
  ];
  for (const rel of required) {
    if (!fs.existsSync(path.join(resourcesRuntime, rel))) {
      console.error(`build-standalone: bundle missing runtime/${rel}`);
      process.exit(1);
    }
  }
  const leaked = ["config.json", ".claude-code-router", "logs"];
  for (const rel of leaked) {
    if (fs.existsSync(path.join(resourcesRuntime, rel))) {
      console.error(`build-standalone: bundle must not contain ${rel}`);
      process.exit(1);
    }
  }
  console.log("build-standalone: runtime bundled into Contents/Resources/runtime");
}

if (fs.existsSync(bundlePath)) {
  const du = spawnSync("du", ["-sh", bundlePath], { encoding: "utf8" });
  console.log(`build-standalone: ${bundlePath}`);
  console.log(`build-standalone: size ${du.stdout.trim()}`);
}
