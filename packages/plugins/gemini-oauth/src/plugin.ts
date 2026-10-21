/**
 * Gemini OAuth (Antigravity) provider plugin — the first consumer of the
 * provider-plugin API (docs/design/provider-plugins.md).
 *
 * activate() contributes all six registration points:
 *   - registerTransformer:      the Code Assist data-plane transformer;
 *   - registerManagedRuntime:   fixed upstream, token injection, error
 *                               taxonomy, 401-once-refresh, cooling breaker;
 *   - registerAdminRoutes:      the six local-only management routes;
 *   - registerConfigProtector:  the managed entry can neither be redirected
 *                               nor dropped by a generic config save;
 *   - registerUiCard:           the prebuilt card chunk (dist/card.js);
 *   - registerLocales:          the geminiOauth.* bundle (from the UI locale
 *                               files at build time).
 *
 * Everything stateful goes through ctx.host: config reads/writes, the runtime
 * reload sequence, the config dir for the private 0600 credential file and the
 * direct dispatcher for the fixed Google origins. The plugin bundles no core
 * module.
 */
import { join } from "node:path";
import { GeminiOauthTransformer } from "./transformer";
import { GeminiOauthAuthService, GeminiOauthCredentialStore } from "./auth-service";
import { registerGeminiOauthAdminRoutes } from "./admin-routes";
import { geminiOauthLocales } from "./locales";
import {
  GEMINI_OAUTH_DATA_PLANE,
  GEMINI_OAUTH_SSE_PATH,
  classifyGeminiOauthError,
  geminiOauthError,
  getGeminiOauthAuthService,
  isGeminiOauthRuntime,
  protectGeminiOauthConfig,
  setGeminiOauthDispatcherProvider,
  setGeminiOauthRuntime,
  type GeminiOauthAuthServiceLike,
  type GeminiOauthErrorInfo,
} from "./protocol";
import type {
  ManagedRuntime,
  PluginClassifiedError,
  PluginContext,
} from "./core-types";

export const manifest = {
  name: "gemini-oauth",
  version: "1.0.0",
  coreApi: "1",
  description: "Gemini OAuth (Antigravity) managed subscription provider: Code Assist data plane, browser OAuth login, model sync and admin routes.",
};

/** The service activate() built; the admin routes resolve through the shared
 *  runtime seam so tests can inject a stub the same way the former core
 *  routes resolved `server.geminiOauthAuthService`. */
function activeService(): GeminiOauthAuthService | undefined {
  return getGeminiOauthAuthService() as GeminiOauthAuthService | undefined;
}

async function activate(ctx: PluginContext): Promise<void> {
  // Fixed Google origins must bypass configured proxies: hand the injected
  // fetch the host's direct dispatcher.
  setGeminiOauthDispatcherProvider(() => ctx.host.getDirectDispatcher());

  // Tokens live ONLY in the plugin's private 0600 file under the CCR config
  // dir — never in config.json, logs, admin responses or this bundle.
  const store = new GeminiOauthCredentialStore(join(ctx.host.configDir, "gemini-oauth-credentials.json"));
  const service = new GeminiOauthAuthService({
    store,
    host: {
      readRawConfig: async () =>
        ctx.host.readRawConfig
          ? await ctx.host.readRawConfig()
          : await ctx.host.readConfig(),
      writeConfig: (next) => ctx.host.writeConfig(next),
      reloadRuntime: (config) => ctx.host.reloadRuntime(config),
      getDirectDispatcher: () => ctx.host.getDirectDispatcher(),
    },
    logger: ctx.log,
  });
  setGeminiOauthRuntime({ authService: service });

  const requireService = (): GeminiOauthAuthServiceLike => {
    const resolved = getGeminiOauthAuthService();
    if (!resolved) throw geminiOauthError({
      code: "gemini_oauth_upstream_error",
      message: "Gemini OAuth 认证服务未初始化",
      httpStatus: 503,
    });
    return resolved;
  };

  const runtime: ManagedRuntime = {
    name: "gemini-oauth",
    isManaged: (provider) => isGeminiOauthRuntime(provider),
    // Circuit breaker BEFORE any network touch — including token refresh
    // (the Gemini lesson: a parked account must not spend a refresh call).
    ensureUsable: async () => {
      const svc = requireService();
      if (await svc.isAccountCooling?.()) {
        throw geminiOauthError({
          code: "gemini_oauth_account_cooling",
          message: "Gemini OAuth 账号处于冷却期（配额/验证/风控拦截），请稍后再试或重新授权。",
          httpStatus: 429,
          retryable: false,
        });
      }
    },
    lockUpstream: async (config) => {
      // The upstream is Code Assist, never a config-supplied base_url.
      config.url = new URL(GEMINI_OAUTH_SSE_PATH, GEMINI_OAUTH_DATA_PLANE).toString();
      // Never follow a redirect away from the fixed origin.
      config.redirect = "error";
      // Fixed Google origins ignore configured CCR/proxy environment routing.
      (config as any).dispatcher = ctx.host.getDirectDispatcher();
    },
    signRequest: async ({ headers }) => {
      // The marker api_key must never reach Google, and a client-supplied
      // Authorization (bypass mode) must not survive either.
      const next: Record<string, string> = { ...headers };
      for (const key of Object.keys(next)) {
        if (["authorization", "x-api-key", "host", "proxy-authorization"].includes(key.toLowerCase())) delete next[key];
      }
      const svc = requireService();
      next.Authorization = `Bearer ${await svc.getAccessToken()}`;
      return next;
    },
    classifyError: (status, body, systemText) => {
      // Mirror the former inline branch: parse the raw upstream body before
      // classification so error.details / error.message keep their semantics.
      let parsed: any = body;
      if (typeof parsed === "string") { try { parsed = JSON.parse(parsed); } catch { /* keep raw */ } }
      const info = classifyGeminiOauthError({ status, body: parsed ?? body, systemText });
      return info as PluginClassifiedError;
    },
    noteUpstreamError: async (info: PluginClassifiedError) => {
      // Bookkeeping (cooldown/lastError) never throws into the response path.
      await (requireService().noteUpstreamError?.(info as GeminiOauthErrorInfo) ?? Promise.resolve());
    },
    // One forced refresh + one re-dispatch on 401; the core enforces the
    // exactly-once discipline around this hook.
    authRefresh: {
      forceRefresh: async () => { await requireService().forceTokenRefresh?.(); },
    },
    // Token hygiene: suppress request/response debug logs for this provider.
    suppressDebugLog: true,
  };

  ctx.registerTransformer(GeminiOauthTransformer as unknown as new () => any);
  ctx.registerManagedRuntime(runtime);
  ctx.registerAdminRoutes((app) => registerGeminiOauthAdminRoutes(app, { getService: () => activeService() }));
  ctx.registerConfigProtector((next, prev) => protectGeminiOauthConfig(next, prev));
  ctx.registerUiCard({ cardPath: "card.js" });
  ctx.registerLocales(geminiOauthLocales);

  ctx.log.info("gemini-oauth plugin active");
}

const plugin = { manifest, activate };
export default plugin;
export { activate };
