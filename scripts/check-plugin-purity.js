#!/usr/bin/env node
/**
 * P1-D package-size / bundle purity acceptance (docs/design/provider-plugins.md
 * §2.2/§3, P1-D row). Run AFTER `pnpm build`:
 *
 *   node scripts/check-plugin-purity.js
 *
 * 1. PURITY — proves the shipped main-package artifacts contain neither
 *    provider-plugin implementation: scans the built core bundles
 *    (packages/core/dist/esm + cjs), the bundled CLI (packages/cli/dist) and
 *    the UI bundle (packages/ui/dist) for provider-specific markers
 *    (upstream hosts, plugin package names, provider auth services).
 *    Any hit fails with exit 1.
 *
 * 2. SIZES — measures `npm pack --json` tarballs of the main CLI package and
 *    both provider-plugin packages under the same node/pnpm conditions and
 *    prints the bytes for the acceptance report.
 *
 * No network access is required: local npm pack never resolves dependencies.
 */

const { execFileSync } = require("child_process");
const { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } = require("fs");
const { tmpdir } = require("os");
const { join, relative, extname } = require("path");

const ROOT = join(__dirname, "..");

const MARKERS = [
  "copilot.tencent.com",
  "daily-cloudcode-pa",
  "cloudcode-pa",
  "ccr-provider-workbuddy",
  "ccr-provider-gemini-oauth",
  "GeminiOauthAuthService",
  "WorkBuddyAuthService",
];

const SCAN_TARGETS = [
  "packages/core/dist/esm",
  "packages/core/dist/cjs",
  "packages/cli/dist",
  "packages/ui/dist",
];

const SCAN_EXTENSIONS = new Set([".js", ".cjs", ".mjs", ".html", ".css", ".json", ".map"]);

function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else if (SCAN_EXTENSIONS.has(extname(entry.name))) out.push(full);
  }
  return out;
}

function scanPurity() {
  console.log("== Purity scan (main package must not contain plugin implementations) ==");
  console.log(`Markers: ${MARKERS.join(", ")}\n`);
  let filesScanned = 0;
  let bytesScanned = 0;
  const hits = [];
  for (const target of SCAN_TARGETS) {
    const abs = join(ROOT, target);
    let files;
    try {
      files = listFiles(abs);
    } catch {
      console.error(`MISSING artifact directory: ${target} — run \`pnpm build\` first`);
      process.exit(1);
    }
    for (const file of files) {
      const buf = readFileSync(file);
      filesScanned += 1;
      bytesScanned += buf.length;
      for (const marker of MARKERS) {
        if (buf.includes(Buffer.from(marker, "utf8"))) {
          hits.push({ file: relative(ROOT, file), marker });
        }
      }
    }
  }
  console.log(
    `Scanned ${filesScanned} files, ${(bytesScanned / 1024 / 1024).toFixed(2)} MiB across:`
  );
  for (const target of SCAN_TARGETS) console.log(`  - ${target}`);
  if (hits.length > 0) {
    console.error(`\nFAIL: ${hits.length} purity hit(s):`);
    for (const hit of hits) console.error(`  ${hit.file}: contains "${hit.marker}"`);
    process.exit(1);
  }
  console.log("PASS: zero marker hits in shipped main-package artifacts.\n");
}

function measureSizes() {
  console.log("== Tarball sizes (same node/pnpm, `npm pack --json --ignore-scripts`) ==");
  const temp = mkdtempSync(join(tmpdir(), "ccr-purity-pack-"));
  const packages = [
    ["main CLI (@wengine-ai/claude-code-router-next)", "packages/cli"],
    ["workbuddy plugin (@wengine-ai/ccr-provider-workbuddy)", "packages/plugins/workbuddy"],
    ["gemini-oauth plugin (@wengine-ai/ccr-provider-gemini-oauth)", "packages/plugins/gemini-oauth"],
  ];
  const results = [];
  try {
    for (const [label, pkg] of packages) {
      const stdout = execFileSync(
        "npm",
        ["pack", "--json", "--ignore-scripts", "--no-audit", "--no-fund", "--pack-destination", temp],
        { cwd: join(ROOT, pkg), encoding: "utf8", stdio: "pipe", timeout: 120_000 }
      );
      const packed = JSON.parse(stdout)[0];
      const archive = join(temp, packed.filename);
      const bytes = statSync(archive).size;
      results.push({ label, pkg, filename: packed.filename, bytes, files: packed.files.length });
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  for (const r of results) {
    console.log(
      `  ${r.label}\n    ${r.filename}: ${r.bytes} bytes (${(r.bytes / 1024).toFixed(1)} KiB, ${r.files} files)`
    );
  }
  const main = results[0];
  const pluginBytes = results.slice(1).reduce((sum, r) => sum + r.bytes, 0);
  console.log(
    `  → plugin tarballs add ${pluginBytes} bytes (${((pluginBytes / main.bytes) * 100).toFixed(2)}% of the main tarball)\n`
  );
}

scanPurity();
measureSizes();
console.log("P1-D acceptance checks completed.");
