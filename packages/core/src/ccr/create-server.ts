/**
 * createCcrServer — the single CCR runtime entry point.
 *
 * This function:
 *   1. Initializes Claude config + CCR dirs + config
 *   2. Starts Codex token refresh scheduler
 *   3. Resolves HOST/PORT/listen config
 *   4. Configures pino logger (with retention)
 *   5. Creates the base Server (via registerAdminRoutes) with admin/management routes
 *   6. Sets up recordUsage callback for fallback failures
 *   7. Registers preset namespaces
 *   8. Registers plugins from config
 *   9. Reconciles health store
 *  10. Registers the explicit request pipeline (hooks in deterministic order)
 *  11. Adds global error handlers
 *  12. Returns the server instance (NOT started — caller calls .start())
 *
 * The CLI adds /api/restart, /api/update/* routes after this returns, then
 * calls server.start().
 */
import { homedir } from "os";
import { join } from "path";
import Server from "../server";
import { createStream } from "rotating-file-stream";
import {
  CONFIG_FILE,
  HOME_DIR,
  listPresets,
  ensureCcrSelfProvider,
} from "@wengine-ai/claude-code-router-shared";
import { initializeClaudeConfig } from "./claude-config-init";
import { initDir, initConfig, writeConfigFile } from "./config";
import { startPinoLogRetention } from "./pino-retention";
import { registerPluginsFromConfig } from "./plugin-registration";
import { registerAdminRoutes } from "./admin-routes";
import { registerRequestPipeline, createCcrPreHandlerCallbacks } from "./request-pipeline";
import { reconcileHealthStore } from "./health-reconcile";
import { append as appendUsage } from "./usage-store";
import { detectClientType } from "../clients/adapters";

export interface CcrRunOptions {
  port?: number;
  logger?: any;
}

export async function createCcrServer(options: CcrRunOptions = {}) {
  await initializeClaudeConfig();
  await initDir();
  const config = await initConfig();

  // Preset the self-referential "ccr" provider for clients that configure a
  // custom endpoint directly (no takeover). Idempotent; a persisted tombstone
  // (user deleted it) keeps it away for good.
  const selfProviderResult = ensureCcrSelfProvider(config);
  if (selfProviderResult.changed) {
    await writeConfigFile(config);
    console.log("ℹ️  Added the preset \"ccr\" provider pointing at this server (delete it in the UI to remove it for good).");
  }

  // Check if Providers is configured
  const providers = config.Providers || config.providers || [];
  const hasProviders = providers && providers.length > 0;

  let HOST = config.HOST || "127.0.0.1";

  if (hasProviders) {
    HOST = config.HOST;
    if (!config.APIKEY) {
      HOST = "127.0.0.1";
    }
  } else {
    // When no providers are configured, listen on 0.0.0.0 without authentication
    HOST = "0.0.0.0";
    console.log("ℹ️  No providers configured. Listening on 0.0.0.0 without authentication.");
  }

  // Honor an explicit options.port override (e.g. tests embedding the runtime
  // with createCcrServer({ port: 0 })) before falling back to config/env.
  const port = options.port ?? config.PORT ?? 3456;

  // Use port from environment variable if set (for background process)
  const servicePort = process.env.SERVICE_PORT
    ? parseInt(process.env.SERVICE_PORT)
    : port;

  // Configure logger based on config settings or external options
  const pad = (num: number) => (num > 9 ? "" : "0") + num;
  const generator = (time: number | Date | undefined, index: number | undefined) => {
    let date: Date;
    if (!time) {
      date = new Date();
    } else if (typeof time === 'number') {
      date = new Date(time);
    } else {
      date = time;
    }

    const month = date.getFullYear() + "" + pad(date.getMonth() + 1);
    const day = pad(date.getDate());
    const hour = pad(date.getHours());
    const minute = pad(date.getMinutes());

    return `./logs/ccr-${month}${day}${hour}${minute}${pad(date.getSeconds())}${index ? `_${index}` : ''}.log`;
  };

  let loggerConfig: any;

  // Use external logger configuration if provided
  if (options.logger !== undefined) {
    loggerConfig = options.logger;
  } else {
    // Prune stale ccr-*.log regardless of whether new logging is enabled,
    // so disabling LOG still cleans up previously-written server logs.
    startPinoLogRetention();

    // Enable logger if not provided and config.LOG !== false
    if (config.LOG !== false) {
      // Set config.LOG to true (if not already set)
      if (config.LOG === undefined) {
        config.LOG = true;
      }
      // Rotation policy: rotate daily and when a single file exceeds 50M.
      // Retention is enforced solely by startPinoLogRetention() above (7 days
      // by mtime). We intentionally do NOT set rotating-file-stream's
      // maxFiles/maxSize, since those count rotated files / total size and
      // would delete logs that are still within the 7-day window.
      loggerConfig = {
        level: config.LOG_LEVEL || "error",
        stream: createStream(generator, {
          path: HOME_DIR,
          interval: "1d",
          size: "50M",
          compress: false,
        }),
      };
    } else {
      loggerConfig = false;
    }
  }

  const presets = await listPresets();

  // Create the base Server, wait for transformer/provider/tokenizer readiness,
  // then register admin routes. No namespace is registered before readiness.
  const serverInstance = new Server({
    jsonPath: CONFIG_FILE,
    initialConfig: {
      providers: config.Providers || config.providers,
      HOST: HOST,
      PORT: servicePort,
      LOG_FILE: join(
        homedir(),
        ".claude-code-router",
        "claude-code-router.log"
      ),
    },
    logger: loggerConfig,
  });
  await serverInstance.ready();
  await registerAdminRoutes(serverInstance, config);

  // Set up usage recording callback for fallback failures in core
  serverInstance.recordUsage = (data: any) => {
    try {
      const clientType = data.req ? (data.req.clientType || detectClientType(data.req)) : "unknown";
      appendUsage({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
        sessionId: data.sessionId || "",
        provider: data.provider || "",
        originalModel: data.originalModel || "",
        model: data.model || "",
        modelFamily: data.modelFamily || "",
        scenarioType: data.scenarioType || "default",
        clientType,
        stream: data.stream ?? false,
        inputTokens: data.inputTokens || 0,
        outputTokens: 0,
        cacheReadInputTokens: data.cacheReadInputTokens || 0,
        cacheCreationInputTokens: data.cacheCreationInputTokens || 0,
        ttft: null,
        tokensPerSecond: null,
        durationMs: 0,
        status: "error",
        errorMessage: data.errorMessage,
        responseBody: undefined,
      });
    } catch (e) {
      // Usage tracking must not affect the response
      console.error("Fallback usage tracking error:", e);
    }
  };

  // Register global timing/onSend/onResponse hooks before namespaces so the
  // same lifecycle applies to both main and preset routes.
  registerRequestPipeline(serverInstance, config);

  // Install explicit pre-handler callbacks before any namespace is registered.
  serverInstance.ccrPreHandlerCallbacks = createCcrPreHandlerCallbacks(config);

  // Register preset namespaces. Surface registration failures instead of
  // letting a malformed preset disappear silently while startup reports success.
  const presetResults = await Promise.allSettled(
    presets.map(async preset => await serverInstance.registerNamespace(`/preset/${preset.name}`, preset.config))
  );
  presetResults.forEach((result, i) => {
    if (result.status === "rejected") {
      const preset = presets[i];
      const msg = result.reason instanceof Error ? result.reason.message : String(result.reason);
      serverInstance.app?.log?.error?.(`Failed to register preset "${preset?.name}": ${msg}`);
    }
  });

  // Register and configure plugins from config
  await registerPluginsFromConfig(serverInstance, config);

  // Prune orphaned circuit-breaker entries (renamed/removed models or deleted
  // providers) so stale "failed" states don't linger across restarts.
  reconcileHealthStore(config, serverInstance.app?.log);

  // Add per-instance process handlers and remove them when the Fastify app closes.
  // This keeps repeated createCcrServer() calls from leaking handlers in tests,
  // embedding scenarios, and failed startup retries.
  const handleUncaughtException = (err: Error) => {
    serverInstance.app.log.error({ err }, "Uncaught exception");
  };
  const handleUnhandledRejection = (reason: unknown, promise: Promise<unknown>) => {
    serverInstance.app.log.error({ reason, promise }, "Unhandled rejection");
  };
  process.on("uncaughtException", handleUncaughtException);
  process.on("unhandledRejection", handleUnhandledRejection);
  serverInstance.app.addHook("onClose", async () => {
    process.off("uncaughtException", handleUncaughtException);
    process.off("unhandledRejection", handleUnhandledRejection);
  });

  return serverInstance;
}