#!/usr/bin/env node
/**
 * Standalone desktop app build for Windows (NSIS installer).
 *
 * Mirrors build-standalone.mjs macOS flow with the Windows-specific pieces:
 * - refuses to run on non-Windows hosts (the runtime staging gates execute the
 *   staged node.exe, so cross-building is not supported),
 * - requires a staged runtime (apps/desktop/runtime with MANIFEST.json,
 *   node.exe and service/entry.cjs) — there is no installed-CCR fallback,
 * - builds the NSIS bundle; the runtime tree ships through the resources
 *   mapping in tauri.windows.conf.json (structure-preserving), so the
 *   installer is self-contained without post-build copying.
 *
 * Prerequisites:
 *   pnpm build:shared && pnpm build:core  (repo root)
 *   node scripts/prepare-runtime.mjs --arch x64
 *   rustup stable-msvc + VS Build Tools C++ workload + cargo-tauri
 *
 * Usage (on Windows, in apps/desktop):
 *   node scripts/build-standalone-windows.mjs
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const runtimeDir = path.join(desktopDir, "runtime");
const srcTauriDir = path.join(desktopDir, "src-tauri");

if (process.platform !== "win32") {
  console.error("build-standalone-windows: run this on a Windows host (the staged runtime gates execute node.exe)");
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: "inherit", ...options });
  if (result.status !== 0) {
    console.error(`build-standalone-windows: ${command} failed (${result.status})`);
    process.exit(result.status ?? 1);
  }
}

const staged =
  fs.existsSync(path.join(runtimeDir, "MANIFEST.json")) &&
  fs.existsSync(path.join(runtimeDir, "node.exe")) &&
  fs.existsSync(path.join(runtimeDir, "service", "entry.cjs"));
if (!staged) {
  console.error(
    "build-standalone-windows: NO runtime staged — refusing to build a shell-only artifact. " +
      "Run `node scripts/prepare-runtime.mjs --arch x64` first.",
  );
  process.exit(1);
}

run("cargo", ["tauri", "build", "--bundles", "nsis", "--no-sign"], { cwd: srcTauriDir });

const bundleDir = path.join(srcTauriDir, "target", "release", "bundle", "nsis");
const installers = fs
  .readdirSync(bundleDir)
  .filter((name) => name.endsWith(".exe"))
  .map((name) => ({ name, file: path.join(bundleDir, name), size: fs.statSync(path.join(bundleDir, name)).size }));
if (installers.length === 0) {
  console.error("build-standalone-windows: no NSIS installer produced");
  process.exit(1);
}
// A self-contained installer must at least carry the staged runtime; a much
// smaller file means the resources mapping silently dropped the tree.
const runtimeBytes = fs.readdirSync(runtimeDir, { recursive: true }).reduce((total, entry) => {
  const file = path.join(runtimeDir, entry);
  try {
    return total + fs.statSync(file).size;
  } catch {
    return total;
  }
}, 0);
for (const installer of installers) {
  if (installer.size < runtimeBytes * 0.6) {
    console.error(
      `build-standalone-windows: ${installer.name} is ${installer.size} bytes but the staged runtime is ${runtimeBytes} — ` +
        "the resources mapping likely did not include the runtime tree",
    );
    process.exit(1);
  }
  console.log(`build-standalone-windows: ${installer.file} (${Math.round(installer.size / 1048576)} MiB)`);
}
