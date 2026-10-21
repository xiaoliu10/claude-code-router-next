import { constants, lstatSync, realpathSync, openSync, closeSync, fstatSync, readFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { PluginManifest } from "./types";
import { PLUGIN_CORE_API } from "./types";
import { getTestPluginRegistry, type PluginRegistry } from "./registry";
import { reloadProviderRuntime } from "./host";
import { readConfigFile, readConfigFileRaw, writeConfigFile } from "../ccr/config";
import { getDirectDispatcher } from "@/services/proxy";

interface PluginInstallRecord { name: string; enabled: boolean; }
export interface PluginLoadResult {
  loaded: string[];
  failed: Array<{ name: string; error: string }>;
  skipped: Array<{ name: string; reason: string }>;
}

const validName = (name: string) => /^[a-z0-9][a-z0-9-]*$/i.test(name);
const pluginsRoot = (configDir: string) => join(configDir, "plugins");
function readInstallRecords(configDir: string): PluginInstallRecord[] {
  try {
    const raw = JSON.parse(readFileSync(join(pluginsRoot(configDir), "plugins.json"), "utf8"));
    return Array.isArray(raw) ? raw.filter(e => e && typeof e.name === "string") : [];
  } catch { return []; }
}

/** Reject symlinked directories, not just lexical traversal. */
export function resolvePluginDir(configDir: string, name: string): string | null {
  if (!validName(name)) return null;
  try {
    const base = realpathSync(configDir);
    const root = join(base, "plugins");
    const dir = join(root, name);
    if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) return null;
    if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) return null;
    if (realpathSync(root) !== root || realpathSync(dir) !== dir || !dir.startsWith(root + sep)) return null;
    return dir;
  } catch { return null; }
}

/** Open only a direct regular file, compare the opened inode against the
 * no-symlink path checks, then read by descriptor. Cards are snapshotted at
 * activation; HTTP never reopens a potentially swapped filesystem path. */
function readPluginFile(configDir: string, name: string, file: string): Buffer {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(file)) throw new Error("invalid plugin file");
  const dir = resolvePluginDir(configDir, name);
  if (!dir) throw new Error("unsafe plugin directory");
  const target = join(dir, file);
  const before = lstatSync(target);
  if (before.isSymbolicLink() || !before.isFile() || realpathSync(target) !== target) throw new Error("unsafe plugin file");
  const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    const after = lstatSync(target);
    if (!opened.isFile() || after.isSymbolicLink() || opened.dev !== before.dev || opened.ino !== before.ino ||
        opened.dev !== after.dev || opened.ino !== after.ino || resolvePluginDir(configDir, name) !== dir || realpathSync(target) !== target) {
      throw new Error("plugin file changed while opening");
    }
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

export async function loadInstalledPlugins(deps: {
  configDir: string;
  log: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
  getServer: () => any;
  registry?: PluginRegistry;
}): Promise<PluginLoadResult> {
  const { configDir, log } = deps;
  const registry: PluginRegistry = deps.registry ?? deps.getServer()?.pluginRegistry ?? getTestPluginRegistry();
  const host = {
    configDir,
    readConfig: () => readConfigFile(),
    readRawConfig: () => readConfigFileRaw(),
    writeConfig: (next: any) => writeConfigFile(next),
    reloadRuntime: async (config?: any) => reloadProviderRuntime(deps.getServer(), config ?? (await readConfigFile()), log),
    getDirectDispatcher,
  };
  const result: PluginLoadResult = { loaded: [], failed: [], skipped: [] };
  const seen = new Set<string>();
  for (const record of readInstallRecords(configDir)) {
    let transaction: ReturnType<PluginRegistry["beginActivation"]> | undefined;
    try {
      if (!validName(record.name)) throw new Error("invalid plugin install name");
      if (seen.has(record.name)) throw new Error(`duplicate plugin install record "${record.name}"`);
      seen.add(record.name);
      if (record.enabled === false) {
        result.skipped.push({ name: record.name, reason: "disabled" });
        continue;
      }
      const pluginDir = resolvePluginDir(configDir, record.name);
      if (!pluginDir) {
        result.skipped.push({ name: record.name, reason: "directory missing or unsafe" });
        continue;
      }
      let manifest: PluginManifest;
      try {
        const raw = JSON.parse(readPluginFile(configDir, record.name, "plugin.json").toString("utf8"));
        if (!raw || typeof raw.name !== "string" || typeof raw.version !== "string") throw new Error();
        manifest = { name: raw.name, version: raw.version, coreApi: String(raw.coreApi ?? "1"), description: raw.description };
      } catch { throw new Error("plugin.json missing or malformed"); }
      if (manifest.name !== record.name) throw new Error("manifest name does not match install directory");
      if (manifest.coreApi.split(".")[0] !== PLUGIN_CORE_API.split(".")[0]) throw new Error(`coreApi ${manifest.coreApi} incompatible with core ${PLUGIN_CORE_API}`);
      const activation = registry.beginActivation(manifest, {
        info: msg => log.info(`[plugin:${manifest.name}] ${msg}`),
        warn: msg => log.warn(`[plugin:${manifest.name}] ${msg}`),
        error: msg => log.error(`[plugin:${manifest.name}] ${msg}`),
      }, host, pluginDir);
      transaction = activation;
      readPluginFile(configDir, record.name, "plugin.js"); // Validate entry before executing trusted plugin code.
      // Trusted plugin modules may be cached by Node. Mutable credential/service
      // state must be created inside activate(), never in a module singleton.
      const mod = await import(pathToFileURL(join(pluginDir, "plugin.js")).href);
      const activate = mod?.activate ?? mod?.default?.activate;
      if (typeof activate !== "function") throw new Error("entry exports no activate()");
      await activate(activation.context);
      const card = activation.cardPath ? readPluginFile(configDir, record.name, activation.cardPath) : undefined;
      await activation.commit(card, deps.getServer()?.app);
      result.loaded.push(manifest.name);
      log.info(`plugin loaded: ${manifest.name}@${manifest.version}`);
    } catch (error: any) {
      transaction?.abort();
      result.failed.push({ name: record.name, error: error?.message ?? String(error) });
      log.warn(`plugin ${record.name} failed to load: ${error?.message ?? String(error)}`);
    }
  }
  return result;
}

/** Production must pass the host registry; default retained only for isolated loader tests. */
export function describeInstalledPlugins(configDir: string, registry: PluginRegistry = getTestPluginRegistry()): Array<Record<string, unknown>> {
  const loaded = new Map(registry.listLoadedPlugins().map(p => [p.name, p]));
  return readInstallRecords(configDir).map(record => {
    const live = record.enabled !== false ? loaded.get(record.name) : undefined;
    return live ? { ...live, enabled: true } : {
      name: record.name, version: null, enabled: record.enabled !== false,
      error: "plugin missing or failed to load — its providers are unavailable until it is reinstalled",
    };
  });
}

export { dirname };
