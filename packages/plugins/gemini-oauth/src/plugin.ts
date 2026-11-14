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
  geminiQuotaToProviderQuota,
  isGeminiOauthRuntime,
  protectGeminiOauthConfig,
  isStickyGeminiOauthError,
  geminiOauthPoolCoolingError,
  type GeminiOauthAuthServiceLike,
  type GeminiOauthErrorInfo,
  type GeminiOauthRequestIdentity,
  type GeminiOauthProviderQuota,
  geminiOauthStickyErrorCode,
} from "./protocol";
import { geminiOauthPoolHasQuota } from "./quota-pools";
import type {
  ManagedRuntime,
  PluginClassifiedError,
  PluginContext,
} from "./core-types";

export const manifest = {
  name: "gemini-oauth",
  version: "1.0.12",
  coreApi: "1",
  description: "Gemini OAuth (Antigravity) managed subscription provider: Code Assist data plane, browser OAuth login, model sync and admin routes.",
};

async function activate(ctx: PluginContext): Promise<void> {
  // Fixed subscription origins honor the host's explicit SUBSCRIPTION_PROXY_URL
  // opt-in when the running core provides it; older cores (and an unset value)
  // stay fully direct. One resolver covers every fixed-origin lane: the data
  // plane (lockUpstream), the auth/login exchange and model/project discovery.
  const upstreamDispatcher = (): unknown =>
    ctx.host.getSubscriptionDispatcher
      ? ctx.host.getSubscriptionDispatcher()
      : ctx.host.getDirectDispatcher();
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
      getDirectDispatcher: upstreamDispatcher,
    },
    logger: ctx.log,
  });
  // Every activation owns its service, transformer and token state even when
  // Node reuses the plugin module (CJS or a multi-module ESM dependency graph).
  class ActivatedGeminiTransformer extends GeminiOauthTransformer {
    constructor() { super({ authService: service }); }
  }

  const requireService = (): GeminiOauthAuthServiceLike => service;

  // Core preserves this opaque object across both gates and HTTP bookkeeping.
  // Keeping identities here avoids exposing account details to the host.
  const requests = new WeakMap<object, GeminiOauthRequestIdentity>();
  const checkIdentity = async (state?: object): Promise<GeminiOauthRequestIdentity | undefined> => {
    if (!state) return undefined; // Hosts predating request-local state.
    const svc = requireService();
    let identity = requests.get(state);
    if (!identity) {
      identity = await svc.captureRequestIdentity?.();
      if (identity) requests.set(state, identity);
    }
    if (identity && svc.isRequestIdentityCurrent && !(await svc.isRequestIdentityCurrent(identity))) {
      throw geminiOauthError({ code: "gemini_oauth_reauth_required", message: "Gemini OAuth account changed during the request.", httpStatus: 401, retryable: false });
    }
    return identity;
  };

  type GeminiOauthManagedRuntime = ManagedRuntime & {
    fetchQuota(): Promise<GeminiOauthProviderQuota | null>;
  };

  const runtime: GeminiOauthManagedRuntime = {
    name: "gemini-oauth",
    isManaged: (provider) => isGeminiOauthRuntime(provider),
    modelScopedRecovery: true,
    // Circuit breaker BEFORE any network touch — including token refresh
    // (the Gemini lesson: a parked account must not spend a refresh call).
    ensureUsable: async (context) => {
      await checkIdentity((context as any)?.requestState);
      const svc = requireService();
      if (await svc.isAccountCooling?.(context?.model)) {
        // This breaker runs BEFORE every real request, so its copy is what the
        // user actually sees. "Cooling" covers very different causes: quota,
        // verification and risk-control all clear on their own, an expired login
        // never does. Reporting the generic diagnosis for a dead token tells the
        // user to wait for something that cannot recover.
        const reauth = isStickyGeminiOauthError(await geminiOauthStickyErrorCode(svc));
        throw geminiOauthError({
          code: "gemini_oauth_account_cooling",
          message: reauth
            ? "Gemini OAuth 登录态已失效，请重新授权登录（等待无法恢复）。"
            : "Gemini OAuth 账号处于冷却期（配额/验证/风控拦截），请稍后再试或重新授权。",
          httpStatus: reauth ? 401 : 429,
          retryable: false,
        });
      }
      if (isStickyGeminiOauthError(await geminiOauthStickyErrorCode(svc))) {
        throw geminiOauthError({ code: "gemini_oauth_reauth_required", message: "Gemini OAuth 登录态已失效，请重新授权登录。", httpStatus: 401, retryable: false });
      }
      const lock = context?.model ? await svc.getPoolCooldown?.(context.model) : null;
      if (lock) throw geminiOauthPoolCoolingError(lock);
    },

    /**
     * Level 1 of the background recovery probe: skip the network call entirely
     * for a parked account (over quota / verification / risk-blocked). Testing
     * reachability for an account that cannot answer wastes calls and risks a
     * longer cooldown.
     */
    probeAccountState: async (context) => {
      const svc = requireService();
      if (!(await svc.isAccountCooling?.(context?.model))) {
        // Not cooling, but a login-class error is sticky: it survives its
        // cooldown on purpose (waiting cannot fix it, only re-auth can). Without
        // this check the probe treated an expired-token account as available
        // and spent a real request on it every interval.
        const status: any = await svc.getStatus?.().catch(() => null);
        const code = status?.lastError?.code;
        if (isStickyGeminiOauthError(code)) {
          return { available: false, reason: "reauth_required" };
        }
        const lock = context?.model ? await svc.getPoolCooldown?.(context.model) : null;
        if (lock) return { available: false, reason: "pool_cooling", parkedUntil: lock.until };
        return { available: true };
      }
      let parkedUntil: number | undefined;
      try {
        const status: any = await svc.getStatus?.();
        const candidate = status?.cooldownUntil ?? status?.cooldown?.until;
        if (typeof candidate === "number" && candidate > Date.now()) parkedUntil = candidate;
      } catch {
        // Status is best-effort; parking without an epoch is still correct.
      }
      return { available: false, reason: "account_cooling", parkedUntil };
    },

    // Model-list reachability is insufficient: only actual quota headroom for
    // the queried pool can restore it. This read never sends a chat request.
    probeLiveness: async ({ model }) => {
      const snapshot = await requireService().getQuota?.().catch(() => null);
      const ok = geminiOauthPoolHasQuota(snapshot, model);
      return new Response(JSON.stringify({ ok }), { status: ok ? 200 : 503, headers: { "content-type": "application/json" } });
    },
    lockUpstream: async (config) => {
      // The upstream is Code Assist, never a config-supplied base_url.
      config.url = new URL(GEMINI_OAUTH_SSE_PATH, GEMINI_OAUTH_DATA_PLANE).toString();
      // Never follow a redirect away from the fixed origin.
      config.redirect = "error";
      // Fixed Google origins bypass env routing; SUBSCRIPTION_PROXY_URL is the
      // only explicit way to place a proxy in front of them.
      (config as any).dispatcher = upstreamDispatcher();
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
    noteUpstreamError: async (info: PluginClassifiedError, context) => {
      // Bookkeeping (cooldown/lastError) never throws into the response path.
      await (requireService().noteUpstreamError?.(info as GeminiOauthErrorInfo, context?.model, (context as any)?.requestState ? requests.get((context as any).requestState) : undefined) ?? Promise.resolve());
    },
    // One forced refresh + one re-dispatch on 401; the core enforces the
    // exactly-once discipline around this hook.
    authRefresh: {
      forceRefresh: async () => { await requireService().forceTokenRefresh?.(); },
    },
    // Token hygiene: suppress request/response debug logs for this provider.
    suppressDebugLog: true,

    // Both the legacy provider summary and the detailed admin view share the
    // service's single-flight cache, dispatcher and account guards.
    fetchQuota: async (): Promise<GeminiOauthProviderQuota | null> =>
      geminiQuotaToProviderQuota(await requireService().getQuota?.().catch(() => null)),
  };

  ctx.registerTransformer(ActivatedGeminiTransformer as unknown as new () => any);
  ctx.registerManagedRuntime(runtime);
  ctx.registerAdminRoutes((app) => registerGeminiOauthAdminRoutes(app, { getService: () => service }));
  ctx.registerConfigProtector((next, prev) => protectGeminiOauthConfig(next, prev));
  ctx.registerUiCard({ cardPath: "card.js" });
  ctx.registerLocales(geminiOauthLocales);

  ctx.log.info("gemini-oauth plugin active");
}

const plugin = { manifest, activate };
export default plugin;
export { activate };
