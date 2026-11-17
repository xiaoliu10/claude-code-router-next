#!/usr/bin/env node
/**
 * Deterministic runtime stager for the standalone desktop app.
 *
 * Stages apps/desktop/runtime/ with:
 *   runtime/node                       portable Node binary (pinned distro)
 *   runtime/LICENSE-node               Node license (bundled distribution)
 *   runtime/bin/npm, runtime/bin/npx   fixed wrappers into the bundled npm
 *   runtime/lib/node_modules/npm/**    npm package tree (self-contained)
 *   runtime/service/entry.cjs          desktop service entry (core runtime)
 *   runtime/service/tiktoken_bg.wasm   tokenizer wasm next to the entry
 *   runtime/service/node_modules/**    better-sqlite3 (native) + lru-cache
 *   runtime/MANIFEST.json              pinned versions + sha256, no timestamps
 *
 * The stage is wiped and rebuilt on every run: same workspace state produces
 * the same bytes. No user configuration, credentials, plugins, or databases
 * are ever copied into the stage, and the user's real HOME is never read.
 *
 * Usage:
 *   node scripts/prepare-runtime.mjs [--node-tarball <path>] [--arch arm64|x64]
 *
 * Prerequisites (built from the repo root; the script refuses to stage stale
 * or missing inputs):
 *   pnpm build:shared && pnpm build:core
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import https from "node:https";
import { Readable } from "node:stream";

// Pinned portable Node distribution. Must match the Node ABI the workspace's
// better-sqlite3 build was compiled for; the end-to-end require check below is
// the authoritative ABI gate.
const NODE_VERSION = process.env.CCR_DESKTOP_NODE_VERSION ?? "v26.4.0";
const NODE_DIST_BASE = "https://nodejs.org/dist";
const LAYOUT_VERSION = 1;
const DEP_SPECS = [
  { name: "better-sqlite3", packageDir: "packages/cli" },
  { name: "lru-cache", packageDir: "packages/cli" },
];

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(desktopDir, "..", "..");
const runtimeDir = path.join(desktopDir, "runtime");
const cacheDir = path.join(desktopDir, ".runtime-cache");

const args = process.argv.slice(2);
function argValue(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}
const nodeTarballOverride = argValue("--node-tarball");
const targetArch = argValue("--arch") ?? process.arch;
if (targetArch !== "arm64" && targetArch !== "x64") {
  fail(`Unsupported --arch ${targetArch}; use arm64 or x64`);
}

function fail(message) {
  console.error(`prepare-runtime: ${message}`);
  process.exit(1);
}
function sha256File(file) {
  return import("node:stream/promises").then(async ({ pipeline }) => {
    const hash = createHash("sha256");
    await pipeline(fs.createReadStream(file), hash);
    return hash.digest("hex");
  });
}

/**
 * Classifies `otool -L` output. A portable node binary may only depend on
 * system dylibs (/usr/lib/...). @rpath entries and absolute Homebrew/Cellar
 * paths make a copied binary unusable on machines without that exact install.
 * Exported for tests.
 */
export function classifyDylibDeps(otoolOutput) {
  // `otool -L` dependency lines are indented and start with the install name:
  //   "\t/usr/lib/libz.1.dylib (compatibility version 1.0.0, ...)"
  //   "\t@rpath/libnode.147.dylib (...)"
  // The first line ("file:") is not indented. Line tails are version text, so
  // parsing the leading token — not the tail — is the only reliable shape.
  const deps = otoolOutput
    .split("\n")
    .filter((line) => /^[ \t]+\S/.test(line))
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((dep) => dep.endsWith(".dylib") || dep.includes(".dylib (") || dep.startsWith("@"));
  const offending = deps.filter((dep) => !dep.startsWith("/usr/lib/"));
  return { portable: offending.length === 0, offending };
}

async function downloadTo(url, destination) {
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  const file = fs.createWriteStream(destination);
  await new Promise((resolve, reject) => {
    https
      .get(url, (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode} for ${url}`));
          response.resume();
          return;
        }
        pipeline(Readable.from(response), file).then(resolve, reject);
      })
      .on("error", reject);
  });
}

async function provisionNodeTarball() {
  const platform = process.platform === "darwin" ? "darwin" : process.platform;
  const filename = `node-${NODE_VERSION}-${platform}-${targetArch}.tar.gz`;
  const expectedUrl = `${NODE_DIST_BASE}/${NODE_VERSION}/${filename}`;
  const pinnedSha = await pinnedSha256(expectedUrl);
  const cached = path.join(cacheDir, filename);
  let tarball = cached;
  if (nodeTarballOverride) {
    tarball = path.resolve(nodeTarballOverride);
    if (!fs.existsSync(tarball)) fail(`--node-tarball not found: ${tarball}`);
  } else {
    const cachedValid =
      fs.existsSync(cached) && (await sha256File(cached)) === pinnedSha;
    if (!cachedValid) {
      console.log(`prepare-runtime: downloading ${expectedUrl}`);
      await downloadTo(expectedUrl, cached);
    }
    const actualSha = await sha256File(cached);
    if (actualSha !== pinnedSha) {
      fail(`Node tarball sha256 mismatch: ${actualSha} != ${pinnedSha}`);
    }
  }
  const recordedSha = await sha256File(tarball);
  if (recordedSha !== pinnedSha) {
    // A mismatching tarball must never be staged, and the manifest must record
    // the real hash — a forged "published" sha would defeat verification.
    fail(`Node tarball sha256 mismatch: ${recordedSha} != ${pinnedSha}`);
  }
  return { tarball, sha256: recordedSha, filename };
}

async function pinnedSha256(distUrl) {
  const base = distUrl.slice(0, distUrl.lastIndexOf("/"));
  const shasums = await fetchText(`${base}/SHASUMS256.txt`);
  const line = shasums.split("\n").find((l) => l.endsWith(path.basename(distUrl)));
  if (!line) fail(`SHASUMS256.txt has no entry for ${path.basename(distUrl)}`);
  return line.split(/\s+/)[0];
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode} for ${url}`));
          response.resume();
          return;
        }
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => resolve(body));
      })
      .on("error", reject);
  });
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0) {
    fail(
      `${path.basename(executable)} failed (${result.status}): ${
        (result.stderr || result.stdout || "").slice(-1800)
      }`,
    );
  }
  return result;
}

async function copyTree(source, destination) {
  await fs.promises.cp(source, destination, { recursive: true, verbatimSymlinks: true });
}

/** Minimal ^x.y.z / exact semver satisfaction for pinned workspace ranges. */
export function satisfiesRange(version, range) {
  // Minimal semver subset for staging: ^x.y.z, ~x.y.z, exact, and bare
  // major ("1") / major.minor ("1.2") ranges. Anything else fails loudly
  // instead of guessing.
  const [major, minor, patch] = version.split(".").map(Number);
  if (range.startsWith("^")) {
    const [minMajor, minMinor, minPatch] = range.slice(1).split(".").map(Number);
    if (major !== minMajor) return false;
    if (minor !== minMinor) return minor > minMinor;
    return patch >= minPatch;
  }
  if (range.startsWith("~")) {
    const [minMajor, minMinor] = range.slice(1).split(".").map(Number);
    return major === minMajor && minor === minMinor;
  }
  const bare = range.match(/^(\d+)(\.\d+)?(\.\d+)?$/);
  if (bare) {
    if (Number(bare[1]) !== major) return false;
    if (bare[2] !== undefined && Number(bare[2].slice(1)) !== minor) return false;
    if (bare[3] !== undefined && Number(bare[3].slice(1)) !== patch) return false;
    return true;
  }
  fail(`Unsupported dependency range "${range}" for precise staging`);
}

const storeDir = path.join(repoRoot, "node_modules", ".pnpm");

/**
 * Copies a dependency tree into the service node_modules (flat layout),
 * resolving transitive deps from the pnpm store. better-sqlite3, for example,
 * needs `bindings` and `file-uri-to-path` at require time — copying a single
 * package directory is not enough, and workspace symlinks do not exist inside
 * the bundle. Symlinks pointing outside their own package are stripped.
 * Exported helpers are imported by tests.
 */
export function resolveWorkspaceDep(depName, range) {
  if (!fs.existsSync(storeDir)) fail("pnpm store not found; run pnpm install first");
  const versions = fs
    .readdirSync(storeDir)
    .filter((entry) => entry.startsWith(`${depName}@`))
    .map((entry) => entry.slice(depName.length + 1));
  const matching = versions
    .filter((version) => satisfiesRange(version.split("_")[0], range))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  if (matching.length === 0) {
    fail(`No installed version of ${depName} satisfies ${range}`);
  }
  const version = matching[0].split("_")[0];
  const realDir = path.join(storeDir, `${depName}@${matching[0]}`, "node_modules", depName);
  return { realDir, version };
}

function readManifest(packageDir) {
  return JSON.parse(
    fs.readFileSync(path.join(packageDir, "package.json"), "utf8"),
  );
}


export async function copyPackageTree(name, range, destination, visited) {
  if (visited.has(name)) {
    const already = visited.get(name);
    if (!satisfiesRange(already, range)) {
      fail(
        `Conflicting versions for ${name} (${already} vs ${range}); flat staging cannot express both`,
      );
    }
    return;
  }
  const { realDir, version } = resolveWorkspaceDep(name, range);
  visited.set(name, version);
  const manifest = readManifest(realDir);
  await copyTreeStripped(realDir, destination);
  const deps = manifest.dependencies ?? {};
  for (const [depName, depRange] of Object.entries(deps)) {
    await copyPackageTree(
      depName,
      depRange,
      path.join(serviceDirOf(destination), "node_modules", depName),
      visited,
    );
  }
}

// The staging service dir is the parent of node_modules; derive it per copy.
function serviceDirOf(destination) {
  return path.dirname(path.dirname(destination));
}

async function copyTreeStripped(source, destination) {
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  const entries = await fs.promises.readdir(source, { withFileTypes: true });
  await fs.promises.mkdir(destination, { recursive: true });
  for (const entry of entries) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) {
      // Strip symlinks: anything pointing outside its own package would break
      // or leak store paths inside the bundle.
      continue;
    }
    if (entry.isDirectory()) {
      await copyTreeStripped(from, to);
    } else {
      await fs.promises.copyFile(from, to);
      if (from === to) continue;
      const mode = fs.statSync(from).mode & 0o777;
      fs.chmodSync(to, mode);
    }
  }
}

function requireCliDist() {
  const coreDist = path.join(repoRoot, "packages", "core", "dist");
  const entrySource = path.join(desktopDir, "runtime-src", "entry.ts");
  const serverCjs = path.join(coreDist, "cjs", "server.cjs");
  const wasm = path.join(coreDist, "tiktoken_bg.wasm");
  for (const required of [entrySource, serverCjs, wasm]) {
    if (!fs.existsSync(required)) {
      fail(`Missing ${required}. Run: pnpm build:shared && pnpm build:core`);
    }
  }
  const sharedDist = path.join(repoRoot, "packages", "shared", "dist", "index.js");
  if (!fs.existsSync(sharedDist)) {
    fail(`Missing ${sharedDist}. Run: pnpm build:shared`);
  }
  return { entrySource, serverCjs, wasm, sharedDist };
}

async function main() {
  const inputs = requireCliDist();
  const placeholderPath = path.join(runtimeDir, "README.md");
  const placeholder = fs.existsSync(placeholderPath) ? fs.readFileSync(placeholderPath) : null;
  await fs.promises.rm(runtimeDir, { recursive: true, force: true });
  if (placeholder) {
    await fs.promises.mkdir(runtimeDir, { recursive: true });
    fs.writeFileSync(placeholderPath, placeholder);
  }
  await fs.promises.mkdir(cacheDir, { recursive: true });

  // 1) Portable Node distribution (copying a Homebrew node is nonportable).
  const { tarball, sha256, filename } = await provisionNodeTarball();
  const extractDir = path.join(cacheDir, `extract-${process.pid}`);
  await fs.promises.mkdir(extractDir, { recursive: true });
  // System bsdtar (macOS/Linux): no extra npm dependency for staging.
  run("tar", ["-xzf", tarball, "-C", extractDir]);
  const distroRoot = fs
    .readdirSync(extractDir)
    .map((name) => path.join(extractDir, name))
    .find((candidate) => fs.statSync(candidate).isDirectory());
  if (!distroRoot) fail("Node tarball has no top-level directory");

  const serviceDir = path.join(runtimeDir, "service");
  await fs.promises.mkdir(path.join(runtimeDir, "bin"), { recursive: true });
  await fs.promises.mkdir(serviceDir, { recursive: true });

  await fs.promises.copyFile(path.join(distroRoot, "bin", "node"), path.join(runtimeDir, "node"));
  fs.chmodSync(path.join(runtimeDir, "node"), 0o755);
  if (fs.existsSync(path.join(distroRoot, "LICENSE"))) {
    await fs.promises.copyFile(
      path.join(distroRoot, "LICENSE"),
      path.join(runtimeDir, "LICENSE-node"),
    );
  }
  const nodeReal = path.join(runtimeDir, "node");

  // 2) Bundled npm so in-app plugin installs never need a global npm.
  const npmLib = path.join(runtimeDir, "lib", "node_modules", "npm");
  await copyTree(path.join(distroRoot, "lib", "node_modules", "npm"), npmLib);
  const runtimeRef = '"$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"';
  const npmWrapper = [
    "#!/bin/sh",
    "# Bundled npm wrapper (fixed paths, no user data). Generated by prepare-runtime.mjs.",
    `exec ${runtimeRef}/node ${runtimeRef}/lib/node_modules/npm/bin/npm-cli.js "$@"`,
    "",
  ].join("\n");
  const npxWrapper = [
    "#!/bin/sh",
    "# Bundled npx wrapper (fixed paths, no user data). Generated by prepare-runtime.mjs.",
    `exec ${runtimeRef}/node ${runtimeRef}/lib/node_modules/npm/bin/npx-cli.js "$@"`,
    "",
  ].join("\n");
  fs.writeFileSync(path.join(runtimeDir, "bin", "npm"), npmWrapper, { mode: 0o755 });
  fs.writeFileSync(path.join(runtimeDir, "bin", "npx"), npxWrapper, { mode: 0o755 });

  // 3) Portability gate on the staged binary (reject Homebrew-linked node).
  if (process.platform === "darwin") {
    const otool = run("otool", ["-L", nodeReal]);
    const { portable, offending } = classifyDylibDeps(otool.stdout);
    if (!portable) {
      fail(`Staged node is not portable; non-system dylibs: ${offending.join(", ")}`);
    }
  }

  // 4) Desktop service entry: core runtime bundled once, deterministic.
  const esbuild = path.join(repoRoot, "node_modules", ".bin", "esbuild");
  run(esbuild, [
    inputs.entrySource,
    "--bundle",
    "--platform=node",
    "--format=cjs",
    "--minify",
    "--tree-shaking=true",
    "--external:better-sqlite3",
    "--external:lru-cache",
    `--alias:@wengine-ai/llms=${inputs.serverCjs}`,
    `--alias:@wengine-ai/claude-code-router-shared=${inputs.sharedDist}`,
    `--outfile=${path.join(serviceDir, "entry.cjs")}`,
  ]);
  await fs.promises.copyFile(inputs.wasm, path.join(serviceDir, "tiktoken_bg.wasm"));

  // 5) External runtime deps (native better-sqlite3 + lru-cache) adjacent to
  //    the entry so bare `require()` resolves without any global install.
  const cliManifest = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "packages", "cli", "package.json"), "utf8"),
  );
  const deps = {};
  const visited = new Map();
  for (const dep of DEP_SPECS) {
    const range = cliManifest.dependencies?.[dep.name];
    if (!range) fail(`packages/cli does not declare ${dep.name}`);
    const { version } = resolveWorkspaceDep(dep.name, range);
    await copyPackageTree(
      dep.name,
      range,
      path.join(serviceDir, "node_modules", dep.name),
      visited,
    );
    deps[dep.name] = { version };
  }

  // 6) Deterministic validation gates (version, arch, SQLite ABI, npm, deps).
  const nodeVersion = run(nodeReal, ["--version"]).stdout.trim();
  if (nodeVersion !== NODE_VERSION) {
    fail(`Staged node version ${nodeVersion} != pinned ${NODE_VERSION}`);
  }
  const nodeArch = run(nodeReal, ["-p", "process.arch"]).stdout.trim();
  if (nodeArch !== targetArch) {
    fail(`Staged node arch ${nodeArch} != target ${targetArch}`);
  }
  const nodePlatform = run(nodeReal, ["-p", "process.platform"]).stdout.trim();
  const sqliteCheck = run(nodeReal, [
    "-e",
    `const db = require(${JSON.stringify(path.join(serviceDir, "node_modules", "better-sqlite3"))})(':memory:');` +
      "db.exec('create table t(a)');db.prepare('insert into t values (?)').run(41);" +
      "if (db.prepare('select a from t').get().a !== 41) throw new Error('sqlite roundtrip failed');",
  ]);
  run(nodeReal, [
    "-e",
    `const {LRUCache} = require(${JSON.stringify(path.join(serviceDir, "node_modules", "lru-cache"))});` +
      "const cache = new LRUCache({max: 1}); cache.set('k', 'v'); if (cache.get('k') !== 'v') throw new Error('lru failed');",
  ]);
  if (process.platform === "darwin") {
    const nativeAddon = path.join(serviceDir, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node");
    const { portable, offending } = classifyDylibDeps(run("otool", ["-L", nativeAddon]).stdout);
    if (!portable) fail("Native SQLite addon is not portable: " + offending.join(", "));
  }
  const npmVersion = run(path.join(runtimeDir, "bin", "npm"), ["--version"], {
    env: {
      ...process.env,
      PATH: `${path.join(runtimeDir, "bin")}:${runtimeDir}:${process.env.PATH}`,
      HOME: os.tmpdir(),
    },
  }).stdout.trim();
  const npmCli = path.join(npmLib, "bin", "npm-cli.js");
  if (!fs.existsSync(npmCli)) fail("Bundled npm is missing bin/npm-cli.js");

  // 7) Manifest: deterministic content, no timestamps, sorted keys.
  const manifest = {
    deps,
    layoutVersion: LAYOUT_VERSION,
    node: {
      arch: nodeArch,
      filename,
      platform: nodePlatform,
      sha256,
      source: nodeTarballOverride ? "local-override" : `${NODE_DIST_BASE}/${NODE_VERSION}`,
      version: nodeVersion,
    },
    npm: { version: npmVersion },
    service: {
      entrySha256: await sha256File(path.join(serviceDir, "entry.cjs")),
      sqliteAbiOk: sqliteCheck.status === 0,
      tiktokenWasmSha256: await sha256File(path.join(serviceDir, "tiktoken_bg.wasm")),
    },
  };
  fs.writeFileSync(
    path.join(runtimeDir, "MANIFEST.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  await fs.promises.rm(extractDir, { recursive: true, force: true });
  console.log(`prepare-runtime: staged ${runtimeDir}`);
  console.log(
    `prepare-runtime: node ${nodeVersion}/${nodeArch}, npm ${npmVersion}, deps ${Object.keys(deps).join(", ")}`,
  );
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  main().catch((error) => fail(error?.stack ?? String(error)));
}
