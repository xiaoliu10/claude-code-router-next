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
 * The validated install core (manifest/record validation, archive caps,
 * staged atomic swap) lives in the shared package
 * (`@wengine-ai/claude-code-router-shared/plugin-install`) and is reused
 * verbatim by the host admin API (POST /api/plugins/install). This file only
 * adds CLI concerns: argument parsing, confirmation prompts, the human-facing
 * npm-pack error lane and the live-service list view.
 *
 * Import-graph rule: this module must not import core/server code (the CLI's
 * bundle already carries the runtime through src/cli.ts; the plugin command
 * itself stays independent so tests do not drag the server in).
 *
 * Credential files ($CCR_CONFIG_DIR/<name>-credentials.json etc.) live
 * OUTSIDE plugins/ and are never read, printed or removed here.
 */

import { execFileSync } from "child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import readline from "readline";
import { Readable, Writable } from "stream";
import JSON5 from "json5";
import {
  HOME_DIR,
  PLUGIN_ENTRY_FILE as ENTRY_FILE,
  PLUGIN_MANIFEST_FILE as MANIFEST_FILE,
  PLUGIN_NAME_PATTERN,
  assertArchiveWithinCaps,
  extractPluginArchive,
  readPluginRecords,
  readPluginRecordsChecked,
  removePluginRecord,
  resolvePluginPayloadDir,
  stagePluginInstall,
  validatePayload,
  validatePluginManifest,
  writePluginRecords,
  type PluginInstallRecord as InstallRecord,
} from "@wengine-ai/claude-code-router-shared";

// Re-exported for the unit tests (historical public surface of this module).
export { validatePluginManifest };

// ANSI color codes (same style as installCommand.ts)
const RESET = "\x1B[0m";
const GREEN = "\x1B[32m";
const YELLOW = "\x1B[33m";
const BOLDGREEN = "\x1B[1m\x1B[32m";
const BOLDYELLOW = "\x1B[1m\x1B[33m";
const BOLDCYAN = "\x1B[1m\x1B[36m";
const DIM = "\x1B[2m";

const NAME_PATTERN = PLUGIN_NAME_PATTERN;
const RECORDS_FILE = "plugins.json";

interface PluginCommandDeps {
  /** Override the config dir (tests). Defaults to the shared HOME_DIR rule:
   *  process.env.CCR_CONFIG_DIR || ~/.claude-code-router. */
  configDir?: string;
  /** stdin for confirmation prompts (tests); defaults to process.stdin. */
  input?: Readable;
  /** stdout sink for prompts (tests); defaults to process.stdout. */
  output?: Writable;
}

interface ResolvedDeps {
  configDir: string;
  input: Readable;
  output: Writable;
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
  ccr plugin add @your-scope/ccr-provider-your-plugin
  ccr plugin add /path/to/plugin-package          # package root with dist/
  ccr plugin add /path/to/ccr-provider-x-1.0.0.tgz
  ccr plugin list
  ccr plugin disable my-plugin
`;
}

// ---------------------------------------------------------------------------
// plugins.json records (delegated to the shared install core)
// ---------------------------------------------------------------------------

function recordsFile(configDir: string): string {
  return join(configDir, "plugins", RECORDS_FILE);
}

function readRecords(configDir: string): InstallRecord[] {
  return readPluginRecords(configDir);
}

function writeRecords(configDir: string, records: InstallRecord[]): void {
  writePluginRecords(configDir, records);
}

// ---------------------------------------------------------------------------
// Source resolution: local dir / local tgz / npm spec
// ---------------------------------------------------------------------------

function looksLikeTgz(source: string): boolean {
  return source.endsWith(".tgz") || source.endsWith(".tar.gz");
}

/**
 * Human-facing npm pack lane (CLI only). It shares the command shape with the
 * host lane in the shared core — `npm pack`, offline-first, lifecycle scripts
 * disabled — but keeps the operator-oriented stderr tail and the longer
 * interactive timeout. The host route uses the stricter shared lane (30s
 * bound, no stderr leakage, throwaway credentials env).
 */
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

async function confirmPrompt(question: string, deps: ResolvedDeps): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const rl = readline.createInterface({ input: deps.input, output: deps.output });
    let settled = false;
    const done = (answer: string | null): void => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(answer !== null && /^\s*(y|yes)\s*$/i.test(answer));
    };
    // A closed stdin without an answer (EOF) declines instead of hanging.
    rl.on("close", () => done(null));
    rl.question(question, (answer: string) => done(answer));
  });
}

/** Resolve the user-supplied source into an installable payload directory.
 *  The returned payload may live inside temp (tgz/npm paths) — callers must
 *  not clean temp before the payload has been copied. */
async function resolveSourcePayload(source: string, temp: string): Promise<{ payloadDir: string; originDescription: string }> {
  if (source.startsWith("-")) {
    throw new PluginCommandError(`invalid plugin source "${source}"`);
  }
  if (existsSync(source)) {
    const st = statSync(source);
    if (st.isDirectory()) {
      const resolved = resolvePluginPayloadDir(source);
      if (!resolved) {
        throw new PluginCommandError(
          `"${source}" is not a plugin payload or plugin package: expected ${MANIFEST_FILE} + ${ENTRY_FILE} in the directory or in its dist/`
        );
      }
      return { payloadDir: resolved, originDescription: resolved === source ? source : join(source, "dist") };
    }
    if (st.isFile() && looksLikeTgz(source)) {
      return tgzPayload(source, temp, source);
    }
    throw new PluginCommandError(`unsupported plugin source file "${source}" (expected a directory or a .tgz)`);
  }
  if (looksLikeTgz(source)) {
    throw new PluginCommandError(`tarball not found: ${source}`);
  }
  console.log(`${BOLDCYAN}Resolving npm package:${RESET} ${source} (offline-first, scripts disabled)`);
  const archive = npmPack(source, join(temp, "pack"));
  return tgzPayload(archive, temp, source);
}

/** Enforce the shared archive caps, extract an npm-style tarball and locate
 *  its payload. Pure extract (system tar), no scripts. */
async function tgzPayload(archive: string, temp: string, originDescription: string): Promise<{ payloadDir: string; originDescription: string }> {
  await assertArchiveWithinCaps(archive);
  const packageRoot = await extractPluginArchive(archive, join(temp, "extract"));
  const payloadDir = resolvePluginPayloadDir(packageRoot);
  if (!payloadDir) {
    throw new PluginCommandError(`no ${MANIFEST_FILE} + ${ENTRY_FILE} found in ${archive}`);
  }
  return { payloadDir, originDescription };
}

async function pluginAdd(
  args: string[],
  deps: ResolvedDeps
): Promise<number> {
  const { configDir } = deps;
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
  try {
    const { payloadDir, originDescription } = await resolveSourcePayload(source, temp);

    const { manifest } = validatePayload(payloadDir);

    console.log(`\n${BOLDCYAN}About to install and enable${RESET} ${BOLDGREEN}${manifest.name}@${manifest.version}${RESET}`);
    console.log(`${DIM}Its code will run with your user permissions. Source: ${originDescription}${RESET}`);
    if (!assumeYes) {
      const ok = await confirmPrompt("Install this plugin? [y/N] ", deps);
      if (!ok) {
        console.log(`${DIM}Installation aborted.${RESET}`);
        return 0;
      }
    }

    const target = stagePluginInstall(payloadDir, manifest, configDir, force);

    console.log(`\n${BOLDGREEN}✓ Installed ${manifest.name}@${manifest.version}${RESET}`);
    console.log(`${DIM}Location: ${target}${RESET}`);
    console.log(`\n${GREEN}Next step:${RESET} restart CCR (ccr restart) to load the plugin.\n`);
    return 0;
  } finally {
    rmSync(temp, { recursive: true, force: true });
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

async function pluginRemove(args: string[], deps: ResolvedDeps): Promise<number> {
  const { configDir } = deps;
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
  const dirExistsSafe = (() => {
    try {
      lstatSync(pluginDir);
      return true;
    } catch {
      return false;
    }
  })();
  const recordExists = readRecords(configDir).some((r) => r.name === name);
  if (!dirExistsSafe && !recordExists) {
    console.error(`\n${BOLDYELLOW}Error:${RESET} plugin "${name}" is not installed\n`);
    return 1;
  }

  if (!assumeYes) {
    console.log(`\n${BOLDCYAN}About to remove${RESET} ${BOLDYELLOW}${name}${RESET}`);
    console.log(`${DIM}Its providers stop working until reinstalled; credential files outside plugins/ are kept.${RESET}`);
    const ok = await confirmPrompt("Remove this plugin? [y/N] ", deps);
    if (!ok) {
      console.log(`${DIM}Removal aborted.${RESET}`);
      return 0;
    }
  }

  if (dirExistsSafe) {
    // Never follow symlinks out of plugins/: unlink a symlinked entry, remove
    // real directories recursively. Credential files live outside plugins/
    // and are never touched here.
    if (lstatSync(pluginDir).isSymbolicLink()) unlinkSync(pluginDir);
    else rmSync(pluginDir, { recursive: true, force: true });
  }
  removePluginRecord(configDir, name);

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
  const { records, corrupted } = readPluginRecordsChecked(configDir);
  const record = records.find((r) => r.name === name);
  if (!record) {
    console.error(
      `\n${BOLDYELLOW}Error:${RESET} plugin "${name}" is not registered — install it first with ${GREEN}ccr plugin add${RESET}\n`
    );
    return 1;
  }
  if (corrupted) {
    // Defensive: readPluginRecordsChecked normalizes parseable arrays; an
    // unparseable file must not be silently rewritten by enable/disable.
    console.error(
      `\n${BOLDYELLOW}Error:${RESET} ${recordsFile(configDir)} is not valid JSON; refusing to overwrite it.\n`
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
  const resolved: ResolvedDeps = {
    configDir: deps?.configDir ?? HOME_DIR,
    input: deps?.input ?? process.stdin,
    output: deps?.output ?? process.stdout,
  };
  const [subcommand, ...rest] = args;
  try {
    switch (subcommand) {
      case "add":
        return await pluginAdd(rest, resolved);
      case "list":
        return await pluginList(rest, resolved.configDir);
      case "remove":
        return await pluginRemove(rest, resolved);
      case "enable":
        return await pluginSetEnabled(rest, resolved.configDir, true);
      case "disable":
        return await pluginSetEnabled(rest, resolved.configDir, false);
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
    // PluginInstallError from the shared core carries the same human-facing
    // wording this command always printed; render any error's message.
    const message = error instanceof PluginCommandError
      ? error.message
      : (error?.message ?? String(error));
    console.error(`\n${BOLDYELLOW}Error:${RESET} ${message}\n`);
    return 1;
  }
}
