import Fastify, {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  FastifyPluginAsync,
  FastifyPluginCallback,
  FastifyPluginOptions,
  FastifyRegisterOptions,
  preHandlerHookHandler,
  onRequestHookHandler,
  preParsingHookHandler,
  preValidationHookHandler,
  preSerializationHookHandler,
  onSendHookHandler,
  onResponseHookHandler,
  onRequestAbortHookHandler,
  onTimeoutHookHandler,
  onErrorHookHandler,
  onRouteHookHandler,
  onRegisterHookHandler,
  onReadyHookHandler,
  onListenHookHandler,
  onCloseHookHandler,
  FastifyBaseLogger,
  FastifyLoggerOptions,
  FastifyServerOptions,
} from "fastify";
import cors from "@fastify/cors";
import { ConfigService, AppConfig, ConfigOptions } from "./services/config";
import { errorHandler } from "./api/middleware";
import { registerApiRoutes } from "./api/routes";
import { ProviderService } from "./services/provider";
import { TransformerService } from "./services/transformer";
import { TokenizerService } from "./services/tokenizer";
import { router, calculateTokenCount, searchProjectBySession } from "./utils/router";
import { sessionUsageCache } from "./utils/cache";
import { getActiveProbeService, startActiveProbe, stopActiveProbe, resetActiveProbeService, ActiveProbeService, ActiveProbeConfig } from "./services/active-probe";
import { initProviderHealthPersistence } from "./services/provider-health";
import { initRateLimitPersistence } from "./services/rate-limit";
import { initQuotaStorePersistence } from "./services/quota-store";
import { closeProxyDispatchers, resolveProviderProxyUrl } from "./services/proxy";
import { WorkBuddyAuthService } from "./services/workbuddy-auth";
import { setWorkBuddyRuntime } from "./services/workbuddy";
import { applyClientAdapter } from "./clients/adapters";
import { normalizeResponsesBody } from "./api/routes";
import { PluginRegistry } from "./provider-plugins/registry";
import type { CcrPreHandlerCallbacks } from "./ccr/request-pipeline";

// Extend FastifyRequest to include custom properties
declare module "fastify" {
  interface FastifyRequest {
    provider?: string;
    model?: string;
    scenarioType?: string;
  }
  interface FastifyInstance {
    _server?: Server;
  }
}

export interface ServerOptions extends FastifyServerOptions {
  initialConfig?: AppConfig;
  jsonPath?: string;
  envPath?: string;
  useEnvFile?: boolean;
  useJsonFile?: boolean;
  useEnvironmentVariables?: boolean;
}

// Application factory
function createApp(options: FastifyServerOptions = {}): FastifyInstance {
  const fastify = Fastify({
    bodyLimit: 50 * 1024 * 1024,
    ...options,
  });

  // Register error handler
  fastify.setErrorHandler(errorHandler);

  // Register CORS
  fastify.register(cors);
  return fastify;
}

// Server class
class Server {
  public app: FastifyInstance;
  readonly pluginRegistry = new PluginRegistry();
  private namespaceProviders: Array<{ name: string; config: ConfigService; providers: ProviderService }> = [];

  /** Reload in place: registered namespaces must not retain stale provider maps. */
  reloadProviders(config: any): void {
    const nextProviders = config?.Providers ?? config?.providers ?? [];
    this.configService.set("providers", nextProviders);
    this.providerService.reload();
    for (const namespace of this.namespaceProviders) {
      // Presets retain their own provider authority; only re-resolve their
      // transformer instances against this host's committed definitions.
      namespace.providers.reload();
    }
  }
  /** Explicit namespace-owned config update; never merge root provider authority. */
  reloadNamespaceProviders(name: string, providers: any[]): void {
    const namespace = this.namespaceProviders.find(item => item.name === name);
    if (!namespace) throw new Error(`unknown namespace ${name}`);
    namespace.config.set("providers", providers);
    namespace.providers.reload();
  }
  configService: ConfigService;
  providerService!: ProviderService;
  transformerService: TransformerService;
  tokenizerService: TokenizerService;
  activeProbeService?: ActiveProbeService;
  /** WorkBuddy managed-provider auth service (token never leaves this object). */
  workBuddyAuthService?: WorkBuddyAuthService;
  /** Gemini OAuth (Antigravity) managed-provider auth service. */
  recordUsage?: (data: any) => void;
  private readonly readiness: Promise<void>;
  private mainNamespaceRegistered = false;
  private signalHandlersRegistered = false;
  ccrPreHandlerCallbacks?: CcrPreHandlerCallbacks;

  constructor(options: ServerOptions = {}) {
    const {
      initialConfig,
      jsonPath,
      envPath,
      useEnvFile,
      useJsonFile,
      useEnvironmentVariables,
      ...fastifyOptions
    } = options;
    this.app = createApp({
      ...fastifyOptions,
      logger: fastifyOptions.logger ?? true,
    });
    this.app._server = this;
    this.app.addHook("onClose", async () => {
      this.pluginRegistry.dispose();
      this.tokenizerService?.dispose();
    });
    // Do not forward absent options as explicit `undefined` values. ConfigService
    // establishes defaults before spreading its input options, so an undefined
    // `useJsonFile` would otherwise overwrite the default `true` and silently
    // skip the Router/Clients stored in config.json.
    const configOptions: ConfigOptions = { initialConfig };
    if (jsonPath !== undefined) configOptions.jsonPath = jsonPath;
    if (envPath !== undefined) configOptions.envPath = envPath;
    if (useEnvFile !== undefined) configOptions.useEnvFile = useEnvFile;
    if (useJsonFile !== undefined) configOptions.useJsonFile = useJsonFile;
    if (useEnvironmentVariables !== undefined) {
      configOptions.useEnvironmentVariables = useEnvironmentVariables;
    }
    this.configService = new ConfigService(configOptions);
    this.transformerService = new TransformerService(
      this.configService,
      this.app.log
    );
    this.tokenizerService = new TokenizerService(
      this.configService,
      this.app.log
    );
    // WorkBuddy managed provider: credentials are only ever read from the CCR
    // private 0600 file inside this service, never from config.json.
    this.workBuddyAuthService = new WorkBuddyAuthService({
      configService: this.configService,
      logger: this.app.log,
      getServer: () => this,
    });
    // Let the transformer resolve this service without constructor options.
    setWorkBuddyRuntime({ authService: this.workBuddyAuthService });

    // Readiness is explicit and fail-fast: namespaces and listen must wait until
    // transformer, provider, and tokenizer initialization have all completed.
    const transformerService = this.transformerService;
    this.readiness = (async () => {
      await Promise.all([
        this.transformerService.initialize(),
        this.tokenizerService.initialize(),
      ]);
      this.pluginRegistry.attachTransformerService(transformerService);
      this.providerService = new ProviderService(
        this.configService,
        this.transformerService,
        this.app.log
      );
    })();
  }

  public async ready(): Promise<void> {
    await this.readiness;
  }

  async register<Options extends FastifyPluginOptions = FastifyPluginOptions>(
    plugin: FastifyPluginAsync<Options> | FastifyPluginCallback<Options>,
    options?: FastifyRegisterOptions<Options>
  ): Promise<void> {
    await (this.app as any).register(plugin, options);
  }

  addHook(hookName: "onRequest", hookFunction: onRequestHookHandler): void;
  addHook(hookName: "preParsing", hookFunction: preParsingHookHandler): void;
  addHook(
    hookName: "preValidation",
    hookFunction: preValidationHookHandler
  ): void;
  addHook(hookName: "preHandler", hookFunction: preHandlerHookHandler): void;
  addHook(
    hookName: "preSerialization",
    hookFunction: preSerializationHookHandler
  ): void;
  addHook(hookName: "onSend", hookFunction: onSendHookHandler): void;
  addHook(hookName: "onResponse", hookFunction: onResponseHookHandler): void;
  addHook(
    hookName: "onRequestAbort",
    hookFunction: onRequestAbortHookHandler
  ): void;
  addHook(hookName: "onTimeout", hookFunction: onTimeoutHookHandler): void;
  addHook(hookName: "onError", hookFunction: onErrorHookHandler): void;
  addHook(hookName: "onRoute", hookFunction: onRouteHookHandler): void;
  addHook(hookName: "onRegister", hookFunction: onRegisterHookHandler): void;
  addHook(hookName: "onReady", hookFunction: onReadyHookHandler): void;
  addHook(hookName: "onListen", hookFunction: onListenHookHandler): void;
  addHook(hookName: "onClose", hookFunction: onCloseHookHandler): void;
  public addHook(hookName: string, hookFunction: any): void {
    this.app.addHook(hookName as any, hookFunction);
  }

  /**
   * Register one API namespace with an explicit request-phase pipeline.
   *
   * Namespace hook order is independent of external/global hook registration:
   * request normalize → adapter → router → provider model normalization → handler.
   */
  public async registerNamespace(name: string, options?: any) {
    if (!name) throw new Error("name is required");
    await this.ready();

    if (name === '/' && this.mainNamespaceRegistered) return;

    let configService = this.configService;
    let transformerService = this.transformerService;
    let providerService = this.providerService;
    let tokenizerService = this.tokenizerService;

    if (name !== '/') {
      if (!options) throw new Error("options is required");
      configService = new ConfigService({
        initialConfig: {
          ...options,
          providers: options.Providers || options.providers,
        }
      });
      transformerService = new TransformerService(configService, this.app.log);
      tokenizerService = new TokenizerService(configService, this.app.log);
      await Promise.all([
        transformerService.initialize(),
        tokenizerService.initialize(),
      ]);
      this.pluginRegistry.attachTransformerService(transformerService);
      providerService = new ProviderService(configService, transformerService, this.app.log);
      this.namespaceProviders.push({ name, config: configService, providers: providerService });
    }

    const registerNamespacePlugin = async (fastify: any) => {
      fastify.decorate('pluginRegistry', this.pluginRegistry);
      fastify.decorate('configService', configService);
      fastify.decorate('transformerService', transformerService);
      fastify.decorate('providerService', providerService);
      fastify.decorate('tokenizerService', tokenizerService);
      fastify.decorate('recordUsage', this.recordUsage || (() => {}));

      // Single ordered preHandler dispatcher: normalize → adapter → auth/Codex
      // → agent → router → provider model normalization. Each phase is guarded
      // by reply.sent so an early return (e.g. auth 401) skips the rest.
      fastify.addHook('preHandler', async (req: any, reply: any) => {
        const url = new URL(`http://127.0.0.1${req.url}`);
        req.pathname = url.pathname;
        const isMessages = url.pathname.endsWith("/v1/messages");
        const isResponses = url.pathname.endsWith("/v1/responses");
        if (!isMessages && !isResponses) return;
        if (!req.body || typeof req.body !== "object") return;

        const phaseTrace = (req.ccrHookOrder ||= []);

        // Phase 1: request normalize
        phaseTrace.push("request-normalize");
        if (isResponses && req.body.input && !req.body.messages) {
          normalizeResponsesBody(req.body);
        }
        if (req.body.stream === undefined) req.body.stream = false;
        req.log.info({ data: req.body, type: "request body" });

        // Phase 2: adapter
        phaseTrace.push("adapter");
        if (!req.originalModel && req.body.model) req.originalModel = req.body.model;
        applyClientAdapter(req, configService.getAll());

        // Phase 3: auth/client context (injected by createCcrServer via callbacks)
        phaseTrace.push("auth-client");
        if (this.ccrPreHandlerCallbacks) {
          await this.ccrPreHandlerCallbacks.authClient(req, reply);
          if (reply.sent) return;
        }

        // Phase 4: agent mutation
        phaseTrace.push("agent");
        if (this.ccrPreHandlerCallbacks) {
          await this.ccrPreHandlerCallbacks.agent(req, reply);
          if (reply.sent) return;
        }

        // Phase 5: router
        phaseTrace.push("router");
        if (req.body?.model) {
          await router(req, reply, { configService, tokenizerService });
        }
        // Router has consumed previousUsage for session-scoped threshold routing.
        // Clear the capture slot before the handler emits this request's usage.
        // This runs only after a successful routing decision: a ProjectRoutingError
        // (or any router throw) must NOT wipe the previous successful request's
        // session usage, otherwise the next request in this session loses its
        // longContext/extendedContext threshold baseline.
        if (req.usageCacheKey) {
          sessionUsageCache.put(req.usageCacheKey, {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          });
        }

        // Phase 6: provider model normalization
        phaseTrace.push("provider-model-normalize");
        try {
          const body = req.body as any;
          if (!body || !body.model) {
            return reply.code(400).send({ error: "Missing model in request body" });
          }
          const parts = body.model.split(",");
          let routedModel = body.model;
          if (parts.length > 1) {
            const [provider, ...model] = parts;
            routedModel = model.join(",");
            body.model = routedModel;
            req.provider = provider;
          }
          req.model = routedModel;
        } catch (err) {
          req.log.error({error: err}, "Error in modelProviderMiddleware:");
          return reply.code(500).send({ error: "Internal server error" });
        }
      });

      await registerApiRoutes(fastify);
    };

    if (name === '/') {
      await this.app.register(registerNamespacePlugin);
      this.mainNamespaceRegistered = true;
    } else {
      await this.app.register(registerNamespacePlugin, { prefix: name });
    }
  }

  async start(): Promise<void> {
    try {
      await this.ready();
      await this.registerNamespace('/');
      // Fastify freezes its lifecycle hooks once listen() begins, so register
      // signal cleanup before ready()/listen(). Adding onClose afterwards makes
      // every otherwise-successful startup exit with INSTANCE_ALREADY_LISTENING.
      if (!this.signalHandlersRegistered) {
        this.signalHandlersRegistered = true;
        const shutdown = async (signal: string) => {
          this.app.log.info(`Received ${signal}, shutting down gracefully...`);
          try {
            stopActiveProbe();
          } catch {}
          await this.app.close();
          process.exit(0);
        };
        const handleSigint = () => void shutdown("SIGINT");
        const handleSigterm = () => void shutdown("SIGTERM");
        process.on("SIGINT", handleSigint);
        process.on("SIGTERM", handleSigterm);
        this.app.addHook("onClose", async () => {
          process.off("SIGINT", handleSigint);
          process.off("SIGTERM", handleSigterm);
          this.signalHandlersRegistered = false;
          try {
            this.tokenizerService.dispose();
          } catch {}
          await closeProxyDispatchers();
        });
      }

      await this.app.ready();

      const address = await this.app.listen({
        port: parseInt(this.configService.get("PORT") || "3000", 10),
        host: this.configService.get("HOST") || "127.0.0.1",
      });

      this.app.log.info(`🚀 LLMs API server listening on ${address}`);

      // Restore persisted runtime state before probes start.
      try {
        initRateLimitPersistence();
      } catch {}
      try {
        initQuotaStorePersistence();
      } catch {}
      try {
        initProviderHealthPersistence();
      } catch {}

      // Start active probe service after providers are initialized
      try {
        const probeConfig: ActiveProbeConfig = {
          enabled: this.configService.get('ACTIVE_PROBE_ENABLED') ?? true,
          quotaProbeIntervalMinutes: this.configService.get('QUOTA_PROBE_INTERVAL_MINUTES') ?? 10,
          probeTimeoutMs: this.configService.get('PROBE_TIMEOUT_MS') ?? 15000,
          slowThresholdMs: Number(this.configService.get('PROBE_SLOW_THRESHOLD_MS')) || 3000,
          initialDelayMs: this.configService.get('PROBE_INITIAL_DELAY_MS') ?? 5000,
          excludeProviders: this.configService.get('EXCLUDE_PROBE_PROVIDERS') ?? [],
        };

        this.activeProbeService = startActiveProbe(
          () => this.providerService.getProviders(),
          probeConfig,
          (provider) => resolveProviderProxyUrl(this.configService, provider),
          this.app.log,
          (key: string) => this.configService.get(key)
        );
      } catch (probeError: any) {
        this.app.log.warn?.(`Failed to start active probe service: ${probeError.message}`);
      }
    } catch (error) {
      this.app.log.error(`Error starting server: ${error}`);
      process.exit(1);
    }
  }
}

// Export for external use
export default Server;
export { sessionUsageCache };
export { router };
export { calculateTokenCount };
export { searchProjectBySession };
export { extractSessionIdFromUserId, normalizeSessionId } from "./utils/session-id";
export {
  applyClientAdapter,
  builtinClientAdapterRegistry,
  clearClientAdapterCaches,
  detectClientType,
  getClientAdapter,
  isClientType,
} from "./clients/adapters";
export type {
  ClientAdapter,
  ClientContext,
  ClientType,
  ClientUsageScope,
} from "./clients/adapters";
export type { RouterScenarioType, RouterFallbackConfig } from "./utils/router";
export { ProjectRoutingError, diagnoseResolutionFailure } from "./utils/router";
export { ConfigService } from "./services/config";
export { ProviderService } from "./services/provider";
export { TransformerService } from "./services/transformer";
export { TokenizerService } from "./services/tokenizer";
export { pluginManager, tokenSpeedPlugin } from "./plugins";
export type { CCRPlugin, CCRPluginOptions, PluginMetadata } from "./plugins";
export { SSEParserTransform, SSESerializerTransform, rewriteStream } from "./utils/sse";
export { getHealthStore, ProviderHealthStore } from "./services/provider-health";
export type { ProviderHealthState, HealthPoolConfig } from "./services/provider-health";
export { getAllRateLimitInfo, getRateLimitInfo, initRateLimitPersistence } from "./services/rate-limit";
export type { RateLimitInfo } from "./services/rate-limit";
export { getQuotaAdapter } from "./services/quota-adapters";
export type { QuotaAdapter, ProviderQuotaResult } from "./services/quota-adapters";
export { getAllQuotaResults, getQuotaResult, storeQuotaResult, initQuotaStorePersistence } from "./services/quota-store";
export { initProviderHealthPersistence } from "./services/provider-health";
export type { StoredQuotaResult } from "./services/quota-store";
export { getActiveProbeService, startActiveProbe, stopActiveProbe, resetActiveProbeService, ActiveProbeService } from "./services/active-probe";
export type { ActiveProbeConfig } from "./services/active-probe";
export { setRuntimeDebugLog, getRuntimeDebugLog } from "./utils/debug-log";
export { closeProxyDispatchers, getConfiguredProxyUrl, getProxyDispatcher, isGlobalProxyEnabled, resolveProviderProxyUrl } from "./services/proxy";

/**
 * Create the full CCR runtime. Loaded lazily to avoid a module cycle between
 * the base Server class and the CCR composition root.
 */
export async function createCcrServer(options: import("./ccr/create-server").CcrRunOptions = {}) {
  const runtime = await import("./ccr/create-server");
  return runtime.createCcrServer(options);
}

/** Backward-compatible name used by the CLI and the legacy server facade. */
export const getServer = createCcrServer;
export type { CcrRunOptions as RunOptions } from "./ccr/create-server";
export type { IAgent, ITool } from "./ccr/agents/type";
export { initDir, initConfig, readConfigFile, readConfigFileRaw, writeConfigFile, backupConfigFile } from "./ccr/config";
export { normalizeUsagePayload, mergeUsageCapture } from "./ccr/usage-merge";
export { collectReachableModelKeys, reconcileHealthStore, clearProviderHealth } from "./ccr/health-reconcile";
export { listAnthropicCompatibleModels } from "./ccr/models";
export { apiKeyAuth } from "./ccr/auth";
export * as usageStore from "./ccr/usage-store";
