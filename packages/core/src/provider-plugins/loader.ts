import { existsSync, readFileSync } from "fs";
import { dirname, join, resolve, sep } from "path";
import { pathToFileURL } from "url";
import type { PluginManifest } from "./types";
import { PLUGIN_CORE_API } from "./types";
import { listLoadedPlugins, makePluginContext } from "./registry";
import { reloadProviderRuntime } from "./host";
import { readConfigFile, readConfigFileRaw, writeConfigFile } from "../ccr/config";
import { getDirectDispatcher } from "@/services/proxy";

/**
 * Plugin discovery and activation.
 *
 * Install layout (magpie-style, $CCR_CONFIG_DIR is the config dir):
 *   $CCR_CONFIG_DIR/plugins/plugins.json          — [{ name, enabled }] install record
 *   $CCR_CONFIG_DIR/plugins/<name>/plugin.json    — manifest
 *   $CCR_CONFIG_DIR/plugins/<name>/plugin.js      — prebuilt entry (ESM default-exporting
 *                                                    `{ manifest, activate }`)
 *   $CCR_CONFIG_DIR/plugins/<name>/card.js        — prebuilt UI card chunk (optional)
 *
 * The core NEVER imports provider code statically; a plugin that fails to load
 * is skipped with a warning so the router keeps working.
 */

interface PluginInstallRecord {
  name: string;
  enabled: boolean;
}

export interface PluginLoadResult {
  loaded: string[];
  failed: Array<{ name: string; error: string }>;
  skipped: Array<{ name: string; reason: string }>;
}

function pluginsRoot(configDir: string): string {
  return join(configDir, "plugins");
}

function readInstallRecords(configDir: string): PluginInstallRecord[] {
  const file = join(pluginsRoot(configDir), "plugins.json");
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw.filter((e: any) => e && typeof e.name === "string");
  } catch {
    return [];
  }
}

function readManifest(pluginDir: string): PluginManifest | null {
  const file = join(pluginDir, "plugin.json");
  if (!existsSync(file)) return null;
  try {
    const m = JSON.parse(readFileSync(file, "utf8"));
    if (m && typeof m.name === "string" && typeof m.version === "string") {
      return { name: m.name, version: m.version, coreApi: String(m.coreApi ?? "1"), description: m.description };
    }
  } catch {
    /* fallthrough */
  }
  return null;
}

/** Plugins dir for one name — validated, for the static card endpoint. */
export function resolvePluginDir(configDir: string, name: string): string | null {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(name)) return null;
  const dir = resolve(pluginsRoot(configDir), name);
  const root = resolve(pluginsRoot(configDir));
  if (dir !== root && !dir.startsWith(root + sep)) return null;
  return existsSync(dir) ? dir : null;
}

export async function loadInstalledPlugins(deps: {
  configDir: string;
  log: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
  getServer: () => any;
}): Promise<PluginLoadResult> {
  const { configDir, log } = deps;
  const host = {
    configDir,
    readConfig: () => readConfigFile(),
    // Interpolation-free read: managed providers round-trip $VAR placeholders
    // through read-modify-write, which readConfig() would bake in.
    readRawConfig: () => readConfigFileRaw(),
    writeConfig: (next: any) => writeConfigFile(next),
    reloadRuntime: async (config?: any) =>
      reloadProviderRuntime(deps.getServer(), config ?? (await readConfigFile()), log),
    getDirectDispatcher,
  };
  const result: PluginLoadResult = { loaded: [], failed: [], skipped: [] };
  const records = readInstallRecords(configDir);

  for (const record of records) {
    if (record.enabled === false) {
      result.skipped.push({ name: record.name, reason: "disabled" });
      continue;
    }
    const pluginDir = resolvePluginDir(configDir, record.name);
    if (!pluginDir) {
      // Installed in plugins.json but the directory is gone — visible in the UI, not fatal.
      result.skipped.push({ name: record.name, reason: "directory missing" });
      continue;
    }
    const manifest = readManifest(pluginDir);
    if (!manifest) {
      result.failed.push({ name: record.name, error: "plugin.json missing or malformed" });
      continue;
    }
    if (manifest.coreApi.split(".")[0] !== PLUGIN_CORE_API.split(".")[0]) {
      result.failed.push({
        name: record.name,
        error: `coreApi ${manifest.coreApi} incompatible with core ${PLUGIN_CORE_API}`,
      });
      continue;
    }

    const context = makePluginContext(manifest, {
      info: (msg) => log.info(`[plugin:${manifest.name}] ${msg}`),
      warn: (msg) => log.warn(`[plugin:${manifest.name}] ${msg}`),
      error: (msg) => log.error(`[plugin:${manifest.name}] ${msg}`),
    }, host);

    try {
      const entry = join(pluginDir, "plugin.js");
      if (!existsSync(entry)) throw new Error("plugin.js entry missing");
      const mod = await import(pathToFileURL(entry).href);
      const activate = mod?.activate ?? mod?.default?.activate;
      if (typeof activate !== "function") throw new Error("entry exports no activate()");
      await activate(context);
      result.loaded.push(manifest.name);
      log.info(`plugin loaded: ${manifest.name}@${manifest.version}`);
    } catch (error: any) {
      result.failed.push({ name: record.name, error: error?.message ?? String(error) });
      log.warn(`plugin ${record.name} failed to load: ${error?.message ?? String(error)}`);
    }
  }
  return result;
}

/** Everything the /api/plugins endpoint needs. */
export function describeInstalledPlugins(configDir: string): Array<Record<string, unknown>> {
  const loaded = new Map(listLoadedPlugins().map((p) => [p.name, p]));
  const out: Array<Record<string, unknown>> = [];
  for (const record of readInstallRecords(configDir)) {
    const live = loaded.get(record.name);
    if (live) {
      out.push({ ...live, enabled: record.enabled !== false });
    } else {
      out.push({
        name: record.name,
        version: null,
        enabled: record.enabled !== false,
        error: "plugin missing or failed to load — its providers are unavailable until it is reinstalled",
      });
    }
  }
  return out;
}

export { dirname };
