import Fastify, { type FastifyInstance, type RouteOptions } from "fastify";
import type { TransformerService } from "../services/transformer";
import type {
  LoadedPluginInfo, ManagedRuntime, PluginClassifiedError, PluginContext,
  PluginHostCapabilities, PluginManifest,
} from "./types";
import { PLUGIN_CORE_API } from "./types";

interface RegisteredPlugin {
  manifest: PluginManifest;
  directory?: string;
  cardPath?: string;
  card?: Buffer;
  locales?: Record<string, Record<string, unknown>>;
  runtimes: Map<string, ManagedRuntime>;
  transformers: Map<string, new () => any>;
  protectors: Array<(next: any, prev: any) => void>;
  routes: Array<(app: FastifyInstance) => void>;
  preparedRoutes: RouteOptions[];
}

type PluginLog = PluginContext["log"];

/** One registry per Server. No production lookup falls back to the test registry. */
export class PluginRegistry {
  private plugins = new Map<string, RegisteredPlugin>();
  private transformerServices = new Set<TransformerService>();
  private disposed = false;
  private revision = 0;

  attachTransformerService(service: TransformerService): void {
    this.assertOpen();
    // Prepare all instances before touching the new service.
    const prepared = [...this.plugins.values()].flatMap(p => [...p.transformers].map(([name, cls]) => {
      if (service.hasTransformer(name)) throw new Error(`transformer "${name}" is already registered`);
      return [name, service.preparePluginTransformer(cls)] as const;
    }));
    const applied: string[] = [];
    try {
      for (const [name, value] of prepared) {
        applied.push(name);
        service.registerTransformer(name, value as any);
      }
      this.transformerServices.add(service);
    } catch (error) {
      for (const name of applied) service.removeTransformer(name);
      throw error;
    }
  }

  beginActivation(manifest: PluginManifest, log: PluginLog, host: PluginHostCapabilities, directory?: string) {
    this.assertOpen();
    if (this.plugins.has(manifest.name)) throw new Error(`plugin "${manifest.name}" is already registered`);
    const staged: RegisteredPlugin = {
      manifest: { ...manifest }, directory, runtimes: new Map(), transformers: new Map(),
      protectors: [], routes: [], preparedRoutes: [],
    };
    let state: "staging" | "committed" | "aborted" = "staging";
    let registrationError: unknown;
    const register = (fn: () => void) => {
      try {
        this.assertOpen();
        if (state !== "staging") throw new Error("plugin activation is no longer open");
        fn();
      } catch (error) {
        // Even a plugin catching its registration error cannot commit a hybrid.
        registrationError = error;
        throw error;
      }
    };
    const context: PluginContext = {
      manifest: staged.manifest, log, host,
      registerTransformer: cls => register(() => {
        const name = typeof (cls as any).TransformerName === "string"
          ? (cls as any).TransformerName : new cls().name;
        if (typeof name !== "string" || !name) throw new Error("plugin transformer has no name");
        if (staged.transformers.has(name)) throw new Error(`transformer "${name}" is already registered`);
        staged.transformers.set(name, cls);
      }),
      registerManagedRuntime: runtime => register(() => {
        if (!runtime.name || typeof runtime.isManaged !== "function" || typeof runtime.signRequest !== "function") {
          throw new Error("invalid managed runtime");
        }
        if (staged.runtimes.has(runtime.name)) throw new Error(`managed runtime "${runtime.name}" is already registered`);
        staged.runtimes.set(runtime.name, runtime);
      }),
      registerAdminRoutes: fn => register(() => { staged.routes.push(fn); }),
      registerConfigProtector: fn => register(() => { staged.protectors.push(fn); }),
      registerUiCard: def => register(() => {
        if (staged.cardPath) throw new Error("plugin card is already registered");
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.js$/.test(def.cardPath)) throw new Error("card must be a single JavaScript file");
        staged.cardPath = def.cardPath;
      }),
      registerLocales: bundle => register(() => { staged.locales = bundle; }),
    };
    return {
      context,
      commit: async (card?: Buffer, routeHost?: FastifyInstance) => {
        this.assertOpen();
        const revision = this.revision;
        if (staged.routes.length) {
          if (!routeHost) throw new Error("plugin admin routes require a host app");
          staged.preparedRoutes = await this.prepareRoutes(staged.routes, routeHost);
        }
        this.assertOpen();
        if (this.revision !== revision) throw new Error("plugin registry changed during activation; retry activation");
        if (state !== "staging") throw new Error("plugin activation is no longer open");
        if (registrationError) throw registrationError;
        if (this.plugins.has(manifest.name)) throw new Error(`plugin "${manifest.name}" is already registered`);
        for (const plugin of this.plugins.values()) {
          for (const name of staged.runtimes.keys()) if (plugin.runtimes.has(name)) throw new Error(`managed runtime "${name}" is already registered`);
          for (const name of staged.transformers.keys()) if (plugin.transformers.has(name)) throw new Error(`transformer "${name}" is already registered`);
        }
        const prepared = [...this.transformerServices].flatMap(service => [...staged.transformers].map(([name, cls]) => {
          if (service.hasTransformer(name)) throw new Error(`transformer "${name}" is already registered`);
          return { service, name, value: service.preparePluginTransformer(cls) };
        }));
        const applied: typeof prepared = [];
        try {
          for (const item of prepared) {
            applied.push(item);
            item.service.registerTransformer(item.name, item.value as any);
          }
          staged.card = card;
          this.plugins.set(manifest.name, staged);
          this.revision++;
          state = "committed";
        } catch (error) {
          for (const item of applied) item.service.removeTransformer(item.name);
          state = "aborted";
          throw error;
        }
      },
      get cardPath() { return staged.cardPath; },
      abort: () => { state = "aborted"; },
    };
  }

  getManagedRuntimeFor(provider: any): ManagedRuntime | undefined {
    for (const plugin of this.plugins.values()) for (const runtime of plugin.runtimes.values()) {
      try { if (runtime.isManaged(provider)) return runtime; } catch { /* Broken predicates do not own other providers. */ }
    }
    return undefined;
  }

  getRegisteredRuntimes(): ManagedRuntime[] {
    return [...this.plugins.values()].flatMap(p => [...p.runtimes.values()]);
  }

  applyConfigProtectors(next: any, prev: any): void {
    for (const plugin of this.plugins.values()) for (const protect of plugin.protectors) protect(next, prev);
  }

  listLoadedPlugins(): LoadedPluginInfo[] {
    return [...this.plugins.values()].map(p => ({
      name: p.manifest.name, version: p.manifest.version, enabled: true,
      ...(p.card ? { cardUrl: `/plugins/${p.manifest.name}/${p.cardPath}` } : {}),
      ...(p.locales ? { locales: p.locales } : {}),
    }));
  }

  getPublicCard(name: string, file: string): Buffer | undefined {
    const plugin = this.plugins.get(name);
    // Return only bytes validated at activation, never reopen an HTTP-supplied path.
    return plugin?.cardPath === file && plugin.card ? Buffer.from(plugin.card) : undefined;
  }

  private async prepareRoutes(registrations: RegisteredPlugin["routes"], app: FastifyInstance): Promise<RouteOptions[]> {
    const methods = new Set(["get", "post", "put", "patch", "delete", "head", "options", "all"]);
    const routes: RouteOptions[] = [];
    const facade: FastifyInstance = new Proxy(app, {
      get: (target, key) => {
        if (key === "route") return (options: RouteOptions) => { routes.push(options); return facade; };
        if (methods.has(String(key))) return (url: string, options: any, handler?: any) => {
          routes.push({ ...(typeof options === "function" ? {} : options), method: key === "all" ? ["DELETE", "GET", "HEAD", "PATCH", "POST", "PUT", "OPTIONS"] : String(key).toUpperCase(), url, handler: handler ?? options } as RouteOptions);
          return facade;
        };
        const value = Reflect.get(target, key);
        if (typeof value === "function") return () => { throw new Error(`plugin route registration cannot call ${String(key)}`); };
        return value;
      },
    });
    const validator = Fastify({ logger: false });
    try {
      for (const register of registrations) {
        const result: unknown = register(facade);
        // Route shorthand returns the facade (which must not be probed as a
        // thenable); actual async callbacks must settle before publication.
        if (result !== facade) await result;
      }
      for (const plugin of this.plugins.values()) for (const route of plugin.preparedRoutes) validator.route(route);
      for (const route of routes) {
        const methods = Array.isArray(route.method) ? route.method : [route.method];
        for (const method of methods) if (app.hasRoute({ method, url: route.url, constraints: route.constraints })) {
          throw new Error(`plugin route ${method} ${route.url} is already registered`);
        }
        validator.route(route);
      }
      await validator.ready();
      return routes;
    } finally { await validator.close(); }
  }

  async registerAllRoutes(app: FastifyInstance): Promise<void> {
    this.assertOpen();
    // All declarations were prepared before publication. A final collision with
    // subsequently registered core routes is a startup error, never swallowed.
    for (const plugin of this.plugins.values()) for (const route of plugin.preparedRoutes) app.route(route);
  }

  dispose(): void {
    if (this.disposed) return;
    for (const service of this.transformerServices) for (const plugin of this.plugins.values()) {
      for (const name of plugin.transformers.keys()) service.removeTransformer(name);
    }
    this.plugins.clear();
    this.transformerServices.clear();
    this.disposed = true;
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error("plugin host is disposed");
  }
}

/** Isolated legacy test helpers. Production always supplies its owned registry. */
let testRegistry = new PluginRegistry();
export const getTestPluginRegistry = () => testRegistry;
export function clearPluginRegistry(): void { testRegistry.dispose(); testRegistry = new PluginRegistry(); }
export const getManagedRuntimeFor = (provider: any, registry: PluginRegistry = testRegistry) => registry.getManagedRuntimeFor(provider);
export const getRegisteredRuntimes = () => testRegistry.getRegisteredRuntimes();
export const listLoadedPlugins = () => testRegistry.listLoadedPlugins();
export const applyPluginConfigProtectors = (next: any, prev: any) => testRegistry.applyConfigProtectors(next, prev);
export const registerAllPluginRoutes = (app: FastifyInstance) => testRegistry.registerAllRoutes(app);

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

export function isPluginClassifiedError(error: any): boolean { return error?.pluginClassified === true; }
export { PLUGIN_CORE_API };
