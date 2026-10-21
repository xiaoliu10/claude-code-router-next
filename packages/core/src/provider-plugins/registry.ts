import type { FastifyInstance } from "fastify";
import type {
  LoadedPluginInfo,
  ManagedRuntime,
  PluginClassifiedError,
  PluginContext,
  PluginHostCapabilities,
  PluginManifest,
} from "./types";
import { PLUGIN_CORE_API } from "./types";

/**
 * Registry of everything activated plugins contribute. The core reads from
 * here through narrow accessors — it never imports plugin code directly.
 */

interface RegisteredPlugin {
  manifest: PluginManifest;
  cardPath?: string;
  locales?: Record<string, Record<string, unknown>>;
  routeRegistrations: Array<(app: FastifyInstance) => void>;
}

const runtimes = new Map<string, ManagedRuntime>();
const plugins = new Map<string, RegisteredPlugin>();
const configProtectors: Array<(next: any, prev: any) => void> = [];

export function clearPluginRegistry(): void {
  runtimes.clear();
  plugins.clear();
  configProtectors.length = 0;
}

export function registerConfigProtector(fn: (next: any, prev: any) => void): void {
  configProtectors.push(fn);
}

/** Run every registered protector; a protector throws to veto/persist-over the save. */
export function applyPluginConfigProtectors(next: any, prev: any): void {
  for (const protect of configProtectors) protect(next, prev);
}

/** First runtime whose isManaged matches wins; registration order is plugin order. */
export function getManagedRuntimeFor(provider: any): ManagedRuntime | undefined {
  for (const runtime of runtimes.values()) {
    try {
      if (runtime.isManaged(provider)) return runtime;
    } catch {
      // A broken isManaged must not break routing for everyone else.
    }
  }
  return undefined;
}

export function getRegisteredRuntimes(): ManagedRuntime[] {
  return [...runtimes.values()];
}

export function listLoadedPlugins(): LoadedPluginInfo[] {
  return [...plugins.values()].map((p) => ({
    name: p.manifest.name,
    version: p.manifest.version,
    enabled: true,
    ...(p.cardPath ? { cardUrl: `/plugins/${p.manifest.name}/${p.cardPath}` } : {}),
    ...(p.locales ? { locales: p.locales } : {}),
  }));
}

export function getPluginDirectoryBasename(name: string): string | undefined {
  const plugin = plugins.get(name);
  return plugin ? name : undefined;
}

/** Build the activation context handed to one plugin. */
export function makePluginContext(
  manifest: PluginManifest,
  log: { info(msg: string): void; warn(msg: string): void; error(msg: string): void },
  host: PluginHostCapabilities
): PluginContext {
  const registered: RegisteredPlugin = {
    manifest,
    routeRegistrations: [],
  };
  plugins.set(manifest.name, registered);

  const guard = (fnName: string, fn: () => void): void => {
    try {
      fn();
    } catch (error: any) {
      log.error(`[plugin:${manifest.name}] ${fnName} failed: ${error?.message ?? String(error)}`);
    }
  };

  return {
    manifest,
    log,
    host,
    registerTransformer(cls) {
      guard("registerTransformer", () => {
        // Imported lazily to avoid a static cycle with the transformer registry.
        const { registerTransformerFromPlugin } = require("./transformer-hook") as {
          registerTransformerFromPlugin(cls: new () => any): void;
        };
        registerTransformerFromPlugin(cls);
      });
    },
    registerManagedRuntime(rt) {
      guard("registerManagedRuntime", () => {
        if (runtimes.has(rt.name)) {
          throw new Error(`managed runtime "${rt.name}" is already registered`);
        }
        runtimes.set(rt.name, rt);
      });
    },
    registerAdminRoutes(fn) {
      registered.routeRegistrations.push(fn);
    },
    registerConfigProtector(fn) {
      guard("registerConfigProtector", () => registerConfigProtector(fn));
    },
    registerUiCard(def) {
      registered.cardPath = def.cardPath;
    },
    registerLocales(bundle) {
      registered.locales = bundle;
    },
  };
}

/** Wire the routes plugins registered while activating. Called once, after loading. */
export function registerAllPluginRoutes(app: FastifyInstance): void {
  for (const plugin of plugins.values()) {
    for (const register of plugin.routeRegistrations) {
      try {
        register(app);
      } catch (error: any) {
        // Route registration failures are plugin-scoped: log and keep the rest.
        console.error(`[plugin:${plugin.manifest.name}] route registration failed: ${error?.message ?? String(error)}`);
      }
    }
  }
}

/** Build the core-side thrown error from a plugin classification. */
export function pluginErrorFrom(runtimeName: string, info: PluginClassifiedError): Error & Record<string, any> {
  const error: any = new Error(info.message);
  error.code = info.code;
  error.statusCode = info.httpStatus;
  if (info.cooldownMs) error.cooldownMs = info.cooldownMs;
  if (info.validationUrl) error.validationUrl = info.validationUrl;
  error.plugin = runtimeName;
  error.nonRetryable = !info.retryable;
  error.pluginClassified = true;
  return error;
}

/** Is this error one the plugin seam produced (so the outer generic retry logic can respect it)? */
export function isPluginClassifiedError(error: any): boolean {
  return error?.pluginClassified === true;
}

export { PLUGIN_CORE_API };
