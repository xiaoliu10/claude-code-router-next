/**
 * Codex subscription provider plugin (docs/design/provider-plugins.md §5).
 *
 * activate() contributes all six registration points:
 *   - registerTransformer:      the Codex request/response quirk layer which
 *                               rides in front of built-in openai-responses
 *                               (chain ["openai-responses","codex"]);
 *   - registerManagedRuntime:   fixed chatgpt.com origin, token/account
 *                               injection, final-body session headers, error
 *                               taxonomy, 401-once refresh, cooling breaker;
 *   - registerAdminRoutes:      eight local-only management routes under
 *                               /api/codex (status, login x4, sync, usage,
 *                               disconnect);
 *   - registerConfigProtector:  the managed entry can neither be redirected
 *                               nor dropped by a generic config save;
 *   - registerUiCard:           the prebuilt card chunk (dist/card.js);
 *   - registerLocales:          the {en,zh}.codex locale bundle.
 *
 * Tokens live ONLY in the plugin's private 0600 codex-credentials.json under
 * ctx.host.configDir — never in config.json, logs, admin responses or this
 * bundle. The managed marker api key (`ccr-managed-codex`) is stripped on
 * every outbound request and must never leave the process. The plugin bundles
 * no core module; the canonical API surface enters through ctx.host and
 * type-only imports (erased at build time).
 */
import { CodexAuthService } from "./auth-service";
import { CodexTransformer } from "./transformer";
import { createCodexManagedRuntime } from "./managed-runtime";
import { registerCodexAdminRoutes } from "./admin-routes";
import { codexLocales } from "./locales";
import { protectCodexConfig } from "./protocol";
import type { PluginContext } from "./core-types";

export const manifest = {
  name: "codex",
  version: "1.0.4",
  coreApi: "1",
  description:
    "Codex subscription managed provider: chatgpt.com backend-api/codex data plane, browser OAuth login (PKCE, loopback 1455/1457 + paste), model sync, usage and admin routes.",
};

async function activate(ctx: PluginContext): Promise<void> {
  // Fixed subscription origins honor the host's explicit SUBSCRIPTION_PROXY_URL
  // opt-in when the running core provides it; older cores (and an unset value)
  // stay fully direct. One host override covers every fixed-origin lane: the
  // data plane (lockUpstream), the auth/login exchange and model/quota fetches.
  const upstreamHost: PluginContext["host"] = {
    ...ctx.host,
    getDirectDispatcher: (): unknown =>
      ctx.host.getSubscriptionDispatcher
        ? ctx.host.getSubscriptionDispatcher()
        : ctx.host.getDirectDispatcher(),
  };
  // The service reads raw config itself through host.readRawConfig (no wrapper
  // — interpolation must not be baked back into config.json) and keeps its
  // 0600 credential file directly under the host config dir.
  const service = new CodexAuthService({
    configDir: ctx.host.configDir,
    host: upstreamHost,
    logger: ctx.log,
  });

  // Static TransformerName ("codex") is inherited; the registry reads it
  // without instantiating. Each activation still owns its service-bound
  // instance when the core constructs it.
  class ActivatedCodexTransformer extends CodexTransformer {
    constructor() {
      super({ service });
    }
  }

  const runtime = createCodexManagedRuntime({ service, host: upstreamHost, log: ctx.log });

  ctx.registerTransformer(ActivatedCodexTransformer as unknown as new () => any);
  ctx.registerManagedRuntime(runtime);
  ctx.registerAdminRoutes((app) => registerCodexAdminRoutes(app, { getService: () => service }));
  ctx.registerConfigProtector((next, prev) => protectCodexConfig(next, prev));
  ctx.registerUiCard({ cardPath: "card.js" });
  ctx.registerLocales(codexLocales);

  ctx.log.info("codex plugin active");
}

const plugin = { manifest, activate };
export default plugin;
export { activate };
