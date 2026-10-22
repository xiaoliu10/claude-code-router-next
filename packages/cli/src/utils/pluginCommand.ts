/**
 * Provider plugin management CLI (docs/design/provider-plugins.md §2.2).
 *
 *   ccr plugin add <npm-spec | local-dir | local-tgz> [--force] [--yes]
 *   ccr plugin list
 *   ccr plugin remove <name> [--yes]
 *   ccr plugin enable <name>
 *   ccr plugin disable <name>
 *
 * Pure copy/extract installer: it never executes plugin code and never runs
 * npm lifecycle scripts (npm pack --ignore-scripts + tar extraction only).
 * Installs into $CCR_CONFIG_DIR/plugins/<name>/ and registers the plugin in
 * plugins/plugins.json — the same source of truth the core loader reads
 * (packages/core/src/provider-plugins/loader.ts).
 *
 * Import-graph rule: this module must only use node builtins and the shared
 * package. It must not import core/server code (the CLI's bundle already
 * carries the runtime through src/cli.ts; the plugin command itself stays
 * independent so tests do not drag the server in).
 *
 * Credential files ($CCR_CONFIG_DIR/<name>-credentials.json etc.) live
 * OUTSIDE plugins/ and are never read, printed or removed here.
 */

import { execFileSync } from "child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import readline from "readline";
import JSON5 from "json5";
import { HOME_DIR } from "@wengine-ai/claude-code-router-shared";

// ANSI color codes (same style as installCommand.ts)
const RESET = "\x1B[0m";
const GREEN = "\x1B[32m";
const YELLOW = "\x1B[33m";
const BOLDGREEN = "\x1B[1m\x1B[32m";
const BOLDYELLOW = "\x1B[1m\x1B[33m";
const BOLDCYAN = "\x1B[1m\x1B[36m";
const DIM = "\x1B[2m";

/** Keep in sync with packages/core/src/provider-plugins/types.ts: the loader
 *  refuses plugins whose coreApi major differs from this. */
const PLUGIN_CORE_API = "1";

const MANIFEST_FILE = "plugin.json";
const ENTRY_FILE = "plugin.js";
const RECORDS_FILE = "plugins.json";
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/i;

export interface PluginManifest {
  name: string;
  version: string;
  coreApi: string;
  description?: string;
}

interface InstallRecord {
  name: string;
  enabled: boolean;
}

/** Manifest fields as they appear on disk, before validation. */
interface RawManifest {
  name?: unknown;
  version?: unknown;
  coreApi?: unknown;
  description?: unknown;
  card?: unknown;
  ui?: { card?: unknown };
}

interface PluginCommandDeps {
  /** Override the config dir (tests). Defaults to the shared HOME_DIR rule:
   *  process.env.CCR_CONFIG_DIR || ~/.claude-code-router. */
  configDir?: string;
}

class PluginCommandError extends Error {}

function usage(): string {
  return `
Usage: ccr plugin <subcommand> [options]

Subcommands:
  add <npm-spec | local-dir | local-tgz> [--force] [--yes]
      Install a provider plugin (pure copy/extract, no scripts are executed)
  list
      List installed plugins (disk view + running service when reachable)
  remove <name> [--yes]
      Uninstall a plugin (credential files are kept)
  enable <name>
      Enable an installed plugin
  disable <name>
      Disable an installed plugin

Options:
  --force   Replace an existing installation (staged, then renamed atomically)
  --yes     Skip the confirmation prompt

Examples:
  ccr plugin add @wengine-ai/ccr-provider-workbuddy
  ccr plugin add /path/to/plugin-package          # package root with dist/
  ccr plugin add /path/to/ccr-provider-x-1.0.0.tgz
  ccr plugin list
  ccr plugin disable workbuddy
  ccr plugin remove workbuddy --yes
`;
}

// ---------------------------------------------------------------------------
// Manifest / payload validation
// ---------------------------------------------------------------------------

/** Validate a manifest read from disk; when installName is given the manifest
 *  name must equal it (the loader makes the same check against the install
 *  directory name). Returns the normalized manifest. */
export function validatePluginManifest(raw: RawManifest, installName?: string): PluginManifest {
  const m = raw;
  if (typeof m.name !== "string" || m.name.length === 0) {
    throw new PluginCommandError(`${MANIFEST_FILE} has no "name"`);
  }
  if (!NAME_PATTERN.test(m.name)) {
    throw new PluginCommandError(
      `invalid plugin name "${m.name}" (must match ${NAME_PATTERN.toString()})`
    );
  }
  if (typeof m.version !== "string" || m.version.length === 0) {
    throw new PluginCommandError(`${MANIFEST_FILE} for "${m.name}" has no "version"`);
  }
  const coreApi = String(m.coreApi ?? PLUGIN_CORE_API);
  if (coreApi.split(".")[0] !== PLUGIN_CORE_API) {
    throw new PluginCommandError(
      `plugin "${m.name}" declares coreApi ${coreApi}, incompatible with this CCR (core ${PLUGIN_CORE_API})`
    );
  }
  if (installName !== undefined && m.name !== installName) {
    throw new PluginCommandError(
      `manifest name "${m.name}" does not match install directory name "${installName}"`
    );
  }
  return {
    name: m.name,
    version: m.version,
    coreApi,
    description: typeof m.description === "string" ? m.description : undefined,
  };
}

/** Read and parse a payload manifest, returning the raw field record. */
function readManifest(payloadDir: string): RawManifest {
  let raw: string;
  try {
    raw = readFileSync(join(payloadDir, MANIFEST_FILE), "utf8");
  } catch {
    throw new PluginCommandError(`${MANIFEST_FILE} not found in ${payloadDir}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e: any) {
    throw new PluginCommandError(`${MANIFEST_FILE} is not valid JSON: ${e.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PluginCommandError(`${MANIFEST_FILE} is not a JSON object`);
  }
  return parsed as RawManifest;
}

/** The installable payload is either the directory itself (installed layout)
 *  or its built dist/ (package root layout). */
function resolvePayloadDir(dir: string): string | null {
  for (const candidate of [dir, join(dir, "dist")]) {
    if (existsSync(join(candidate, MANIFEST_FILE)) && existsSync(join(candidate, ENTRY_FILE))) {
      return candidate;
    }
  }
  return null;
}

/** Refuse to install payloads that carry symlinks: the loader only ever
 *  accepts real directories/files under plugins/<name>/, so a symlinked
 *  payload could never load and might point outside the install root. */
function assertNoSymlinks(root: string): void {
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        throw new PluginCommandError(
          `refusing to install: payload contains a symlink "${join(dir, entry.name)}"`
        );
      }
      if (entry.isDirectory()) stack.push(join(dir, entry.name));
    }
  }
}

/** card.js is optional; but if the manifest declares a UI card file it must
 *  exist in the payload. */
function validateCardPayload(payloadDir: string, raw: RawManifest): void {
  const declared = typeof raw.card === "string"
    ? raw.card
    : typeof raw.ui?.card === "string" ? raw.ui.card : undefined;
  if (typeof declared === "string" && declared.length > 0) {
    if (!existsSync(join(payloadDir, declared))) {
      throw new PluginCommandError(
        `manifest declares UI card "${declared}" but the file is missing from the payload`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// plugins.json records (same file the core loader reads)
// ---------------------------------------------------------------------------

function recordsFile(configDir: string): string {
  return join(configDir, "plugins", RECORDS_FILE);
}

function readRecords(configDir: string): InstallRecord[] {
  try {
    const raw = JSON.parse(readFileSync(recordsFile(configDir), "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (e: any): e is InstallRecord =>
        e && typeof e.name === "string" && typeof e.enabled === "boolean"
    );
  } catch {
    return [];
  }
}

function writeRecords(configDir: string, records: InstallRecord[]): void {
  writeFileSync(recordsFile(configDir), JSON.stringify(records, null, 2) + "\n");
}

/** Register or replace the record for name, preserving the order of all
 *  other records (the loader loads in plugins.json order). */
function upsertRecord(configDir: string, name: string): void {
  const records = readRecords(configDir);
  const record: InstallRecord = { name, enabled: true };
  const idx = records.findIndex((r) => r.name === name);
  if (idx >= 0) records[idx] = record;
  else records.push(record);
  writeRecords(configDir, records);
}

function removeRecord(configDir: string, name: string): boolean {
  const records = readRecords(configDir);
  const next = records.filter((r) => r.name !== name);
  if (next.length === records.length) return false;
  writeRecords(configDir, next);
  return true;
}

// ---------------------------------------------------------------------------
// Source resolution: local dir / local tgz / npm spec
// ---------------------------------------------------------------------------

function looksLikeTgz(source: string): boolean {
  return source.endsWith(".tgz") || source.endsWith(".tar.gz");
}

/** Extract a plugin tarball with the system tar (pure extract, no scripts).
 *  Returns the extracted package root ("package" for npm artifacts). */
function extractTgz(archive: string, destDir: string): string {
  mkdirSync(destDir, { recursive: true });
  try {
    execFileSync("tar", ["-xzf", archive, "-C", destDir], { stdio: "pipe", timeout: 60_000 });
  } catch (e: any) {
    throw new PluginCommandError(`failed to extract ${basename(archive)}: ${e.message}`);
  }
  // Post-extract safety: tar itself refuses absolute paths and ".." traversal
  // on extraction; additionally refuse any symlinked member so nothing in the
  // extracted tree can point outside the extraction root.
  assertNoSymlinks(destDir);
  const packageRoot = join(destDir, "package");
  if (existsSync(packageRoot) && statSync(packageRoot).isDirectory()) return packageRoot;
  return destDir;
}

/** Download an npm spec with npm pack (offline-first) WITHOUT running any
 *  lifecycle scripts, and return the packed archive path. */
function npmPack(spec: string, destDir: string): string {
  mkdirSync(destDir, { recursive: true });
  let stdout: string;
  try {
    stdout = execFileSync(
      "npm",
      [
        "pack",
        "--json",
        "--prefer-offline",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--pack-destination",
        destDir,
        spec,
      ],
      { cwd: destDir, encoding: "utf8", stdio: "pipe", timeout: 180_000 }
    );
  } catch (e: any) {
    const stderr = String(e.stderr || e.message || "").trim().split("\n").slice(-3).join("\n");
    throw new PluginCommandError(`npm pack failed for "${spec}":\n${stderr}`);
  }
  let packed: Array<{ filename?: string }>;
  try {
    packed = JSON.parse(stdout);
  } catch {
    throw new PluginCommandError(`npm pack returned unexpected output for "${spec}"`);
  }
  const filename = packed?.[0]?.filename;
  if (!filename) throw new PluginCommandError(`npm pack produced no archive for "${spec}"`);
  return join(destDir, filename);
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function confirmPrompt(question: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    // Callback form: an EOF without an answer yields "" → declined.
    rl.question(question, (answer: string) => {
      rl.close();
      resolve(/^\s*(y|yes)\s*$/i.test(answer));
    });
  });
}

async function pluginAdd(
  args: string[],
  configDir: string
): Promise<number> {
  const force = args.includes("--force");
  const assumeYes = args.includes("--yes");
  const positional = args.filter((a) => !a.startsWith("--"));
  const source = positional[0];

  if (!source) {
    console.error(`\n${BOLDYELLOW}Error:${RESET} plugin source is required\n`);
    console.error("Usage: ccr plugin add <npm-spec | local-dir | local-tgz> [--force] [--yes]\n");
    return 1;
  }
  if (positional.length > 1) {
    console.error(`\n${BOLDYELLOW}Error:${RESET} unexpected extra argument "${positional[1]}"\n`);
    return 1;
  }

  const temp = mkdtempSync(join(tmpdir(), "ccr-plugin-add-"));
  let payloadDir: string;
  let originDescription: string;
  try {
    if (source.startsWith("-")) {
      throw new PluginCommandError(`invalid plugin source "${source}"`);
    }
    if (existsSync(source)) {
      const st = statSync(source);
      if (st.isDirectory()) {
        const resolved = resolvePayloadDir(source);
        if (!resolved) {
          throw new PluginCommandError(
            `"${source}" is not a plugin payload or plugin package: expected ${MANIFEST_FILE} + ${ENTRY_FILE} in the directory or in its dist/`
          );
        }
        payloadDir = resolved;
        originDescription = resolved === source ? source : join(source, "dist");
      } else if (st.isFile() && looksLikeTgz(source)) {
        const fromTgz = resolvePayloadDir(extractTgz(source, join(temp, "extract")));
        if (!fromTgz) throw new PluginCommandError(`no ${MANIFEST_FILE} + ${ENTRY_FILE} found in ${source}`);
        payloadDir = fromTgz;
        originDescription = source;
      } else {
        throw new PluginCommandError(`unsupported plugin source file "${source}" (expected a directory or a .tgz)`);
      }
    } else if (looksLikeTgz(source)) {
      throw new PluginCommandError(`tarball not found: ${source}`);
    } else {
      console.log(`${BOLDCYAN}Resolving npm package:${RESET} ${source} (offline-first, scripts disabled)`);
      const archive = npmPack(source, join(temp, "pack"));
      const fromPack = resolvePayloadDir(extractTgz(archive, join(temp, "extract")));
      if (!fromPack) throw new PluginCommandError(`no ${MANIFEST_FILE} + ${ENTRY_FILE} found in ${source}`);
      payloadDir = fromPack;
      originDescription = source;
    }

    const rawManifest = readManifest(payloadDir);
    const manifest = validatePluginManifest(rawManifest);
    if (!existsSync(join(payloadDir, ENTRY_FILE))) {
      throw new PluginCommandError(`plugin entry ${ENTRY_FILE} is missing from the payload`);
    }
    validateCardPayload(payloadDir, rawManifest);
    assertNoSymlinks(payloadDir);

    console.log(`\n${BOLDCYAN}About to install and enable${RESET} ${BOLDGREEN}${manifest.name}@${manifest.version}${RESET}`);
    console.log(`${DIM}Its code will run with your user permissions. Source: ${originDescription}${RESET}`);
    if (!assumeYes) {
      const ok = await confirmPrompt("Install this plugin? [y/N] ");
      if (!ok) {
        console.log(`${DIM}Installation aborted.${RESET}`);
        return 0;
      }
    }

    const pluginsDir = join(configDir, "plugins");
    mkdirSync(pluginsDir, { recursive: true });
    if (lstatSync(pluginsDir).isSymbolicLink() || !lstatSync(pluginsDir).isDirectory()) {
      throw new PluginCommandError(`plugins directory is not a real directory: ${pluginsDir}`);
    }
    const target = join(pluginsDir, manifest.name);
    if (existsSync(target) && !force) {
      throw new PluginCommandError(
        `plugin "${manifest.name}" is already installed at ${target} (use --force to replace it)`
      );
    }

    // Stage → validate the staged copy → swap. rename() inside the same
    // directory is atomic; the pre-swap removal window is minimized.
    const stage = join(pluginsDir, `.${manifest.name}.staging-${process.pid}-${Date.now()}`);
    mkdirSync(stage, { recursive: true });
    cpSync(payloadDir, stage, { recursive: true });
    const stagedManifest = validatePluginManifest(readManifest(stage), manifest.name);
    if (!existsSync(join(stage, ENTRY_FILE))) {
      throw new PluginCommandError(`staged payload is missing its entry ${ENTRY_FILE}`);
    }
    if (existsSync(target) || lstatSyncSafe(target)) {
      rmSync(target, { recursive: true, force: true });
    }
    renameSync(stage, target);

    upsertRecord(configDir, stagedManifest.name);

    console.log(`\n${BOLDGREEN}✓ Installed ${stagedManifest.name}@${stagedManifest.version}${RESET}`);
    console.log(`${DIM}Location: ${target}${RESET}`);
    console.log(`\n${GREEN}Next step:${RESET} restart CCR (ccr restart) to load the plugin.\n`);
    return 0;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function lstatSyncSafe(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

interface LivePluginInfo {
  name: string;
  version: string | null;
  enabled?: boolean;
  error?: string;
}

/** Ask the running service for its loader view; null when unreachable. */
async function fetchLivePlugins(port: number): Promise<LivePluginInfo[] | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/plugins`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    const body: any = await res.json();
    return Array.isArray(body?.plugins) ? body.plugins : null;
  } catch {
    return null;
  }
}

function readConfiguredPort(configDir: string): number {
  try {
    const config = JSON5.parse(readFileSync(join(configDir, "config.json"), "utf8"));
    const port = Number(config?.PORT);
    return Number.isInteger(port) && port > 0 ? port : 3456;
  } catch {
    return 3456;
  }
}

function manifestVersion(configDir: string, name: string): string | null {
  if (!NAME_PATTERN.test(name)) return null;
  try {
    const raw = JSON.parse(readFileSync(join(configDir, "plugins", name, MANIFEST_FILE), "utf8"));
    return typeof raw?.version === "string" ? raw.version : null;
  } catch {
    return null;
  }
}

interface PluginRow {
  name: string;
  version: string;
  enabled: string;
  status: string;
}

interface PluginListView {
  rows: PluginRow[];
  serviceReachable: boolean;
  port: number;
}

/** Disk view (records + payload manifests) combined with the running
 *  service's loader view when it is reachable. Contains no credential
 *  material — only names, versions and enablement/status. */
async function collectPluginListView(configDir: string): Promise<PluginListView> {
  const records = readRecords(configDir);
  const pluginsDir = join(configDir, "plugins");
  const diskDirs = existsSync(pluginsDir)
    ? readdirSync(pluginsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => e.name)
    : [];

  const port = readConfiguredPort(configDir);
  const live = await fetchLivePlugins(port);
  const liveByName = new Map((live ?? []).map((p) => [p.name, p]));

  const rows: PluginRow[] = records.map((record) => {
    let status: string;
    if (!record.enabled) {
      status = "disabled";
    } else if (live === null) {
      status = "on disk (service not reachable)";
    } else {
      const info = liveByName.get(record.name);
      if (!info) status = "not loaded (restart to load?)";
      else if (info.version) status = "loaded";
      else status = info.error ? `load failed: ${info.error}` : "load failed";
    }
    return {
      name: record.name,
      version: manifestVersion(configDir, record.name) ?? "?",
      enabled: record.enabled ? "yes" : "no",
      status,
    };
  });
  for (const dir of diskDirs) {
    if (records.some((r) => r.name === dir)) continue;
    rows.push({
      name: dir,
      version: manifestVersion(configDir, dir) ?? "?",
      enabled: "-",
      status: "unregistered (not in plugins.json)",
    });
  }
  return { rows, serviceReachable: live !== null, port };
}

function renderPluginTable(view: PluginListView): void {
  const { rows } = view;
  console.log(`\n${BOLDCYAN}Installed provider plugins:${RESET}`);
  if (rows.length === 0) {
    console.log(`\nNone installed. Install one with: ${GREEN}ccr plugin add <npm-spec | local-dir | local-tgz>${RESET}\n`);
    return;
  }
  const width = (header: string, values: string[]) =>
    Math.max(header.length, ...values.map((v) => v.length));
  const columns: Array<{ title: string; value: (r: PluginRow) => string }> = [
    { title: "Name", value: (r) => r.name },
    { title: "Version", value: (r) => r.version },
    { title: "Enabled", value: (r) => r.enabled },
    { title: "Status", value: (r) => r.status },
  ];
  const widths = columns.map((c) => width(c.title, rows.map(c.value)));
  const line = (cells: string[]): string =>
    cells.map((v, i) => `  ${v.padEnd(widths[i])}`).join("");
  console.log(line(columns.map((c) => c.title)));
  for (const row of rows) {
    console.log(line(columns.map((c) => c.value(row))));
  }
  if (!view.serviceReachable) {
    console.log(`\n${DIM}Note: service not reachable on port ${view.port} — status shown from disk only.${RESET}`);
  }
  console.log("");
}

async function pluginList(args: string[], configDir: string): Promise<number> {
  renderPluginTable(await collectPluginListView(configDir));
  return 0;
}

async function pluginRemove(args: string[], configDir: string): Promise<number> {
  const assumeYes = args.includes("--yes");
  const positional = args.filter((a) => !a.startsWith("--"));
  const name = positional[0];
  if (!name) {
    console.error(`\n${BOLDYELLOW}Error:${RESET} plugin name is required\n`);
    console.error("Usage: ccr plugin remove <name> [--yes]\n");
    return 1;
  }
  if (!NAME_PATTERN.test(name)) {
    console.error(`\n${BOLDYELLOW}Error:${RESET} invalid plugin name "${name}"\n`);
    return 1;
  }

  const pluginDir = join(configDir, "plugins", name);
  const dirExists = lstatSyncSafe(pluginDir);
  const recordExists = readRecords(configDir).some((r) => r.name === name);
  if (!dirExists && !recordExists) {
    console.error(`\n${BOLDYELLOW}Error:${RESET} plugin "${name}" is not installed\n`);
    return 1;
  }

  if (!assumeYes) {
    console.log(`\n${BOLDCYAN}About to remove${RESET} ${BOLDYELLOW}${name}${RESET}`);
    console.log(`${DIM}Its providers stop working until reinstalled; credential files outside plugins/ are kept.${RESET}`);
    const ok = await confirmPrompt("Remove this plugin? [y/N] ");
    if (!ok) {
      console.log(`${DIM}Removal aborted.${RESET}`);
      return 0;
    }
  }

  if (dirExists) {
    // Never follow symlinks out of plugins/: unlink a symlinked entry, remove
    // real directories recursively. Credential files live outside plugins/
    // and are never touched here.
    if (lstatSync(pluginDir).isSymbolicLink()) unlinkSync(pluginDir);
    else rmSync(pluginDir, { recursive: true, force: true });
  }
  removeRecord(configDir, name);

  console.log(`\n${BOLDGREEN}✓ Removed ${name}${RESET}`);
  console.log(`${DIM}Restart CCR (ccr restart) to apply. Credential files were left untouched.${RESET}\n`);
  return 0;
}

async function pluginSetEnabled(
  args: string[],
  configDir: string,
  enabled: boolean
): Promise<number> {
  const verb = enabled ? "enable" : "disable";
  const positional = args.filter((a) => !a.startsWith("--"));
  const name = positional[0];
  if (!name) {
    console.error(`\n${BOLDYELLOW}Error:${RESET} plugin name is required\n`);
    console.error(`Usage: ccr plugin ${verb} <name>\n`);
    return 1;
  }
  if (!NAME_PATTERN.test(name)) {
    console.error(`\n${BOLDYELLOW}Error:${RESET} invalid plugin name "${name}"\n`);
    return 1;
  }
  const records = readRecords(configDir);
  const record = records.find((r) => r.name === name);
  if (!record) {
    console.error(
      `\n${BOLDYELLOW}Error:${RESET} plugin "${name}" is not registered — install it first with ${GREEN}ccr plugin add${RESET}\n`
    );
    return 1;
  }
  if (record.enabled !== enabled) {
    record.enabled = enabled;
    writeRecords(configDir, records);
  }
  console.log(`\n${BOLDGREEN}✓ ${enabled ? "Enabled" : "Disabled"} ${name}${RESET}`);
  console.log(`${DIM}Restart CCR (ccr restart) to apply.${RESET}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Handle `ccr plugin <subcommand> ...`. Returns the process exit code:
 *  0 ok, 1 usage/validation failure. Expected failures (bad manifest, unsafe
 *  name, missing plugin …) are reported on stderr and surfaced through the
 *  returned exit code — the CLI entry in cli.ts turns it into process.exit. */
export async function handlePluginCommand(
  args: string[],
  deps?: PluginCommandDeps
): Promise<number> {
  const configDir = deps?.configDir ?? HOME_DIR;
  const [subcommand, ...rest] = args;
  try {
    switch (subcommand) {
      case "add":
        return await pluginAdd(rest, configDir);
      case "list":
        return await pluginList(rest, configDir);
      case "remove":
        return await pluginRemove(rest, configDir);
      case "enable":
        return await pluginSetEnabled(rest, configDir, true);
      case "disable":
        return await pluginSetEnabled(rest, configDir, false);
      default:
        if (subcommand === undefined) {
          console.error(`\n${BOLDYELLOW}Error:${RESET} a subcommand is required\n`);
        } else {
          console.error(`\n${BOLDYELLOW}Error:${RESET} unknown plugin subcommand "${subcommand}"\n`);
        }
        console.log(usage());
        return 1;
    }
  } catch (error: any) {
    const message = error instanceof PluginCommandError
      ? error.message
      : (error?.message ?? String(error));
    console.error(`\n${BOLDYELLOW}Error:${RESET} ${message}\n`);
    return 1;
  }
}
