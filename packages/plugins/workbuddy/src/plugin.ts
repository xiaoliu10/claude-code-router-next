/**
 * WorkBuddy (CN + international) provider plugin — consumer of the
 * provider-plugin API (docs/design/provider-plugins.md).
 *
 * activate() contributes the registration points as this migration lands them
 * (contract §6 milestones):
 *   - M1: credential store + protocol + auth service (host-coupled only via
 *     ctx.host), config protector;
 *   - M2: managed runtime (dual-site §16 account pool, fixed-origin lock,
 *     error taxonomy) + transformer + admin routes;
 *   - M3: registerUiCard + registerLocales (self-contained card.js).
 *
 * Everything stateful goes through ctx.host: config reads/writes, the runtime
 * reload sequence, the config dir for the private 0600 credential file and the
 * direct dispatcher for the fixed WorkBuddy origins. The plugin bundles no
 * core module. Every activation owns its service and credential store, even
 * when Node reuses the plugin module.
 */
import { join } from "node:path";
import { WorkBuddyAuthService, type WorkBuddyAuthServiceLike } from "./auth-service";
import {
  protectWorkBuddyConfig,
  WorkBuddyCredentialStore,
  WORKBUDDY_AI_PROVIDER_NAME,
  WORKBUDDY_PROVIDER_NAME,
} from "./protocol";
import type { PluginContext } from "./core-types";

export const manifest = {
  name: "workbuddy",
  version: "1.0.0",
  coreApi: "1",
  description: "WorkBuddy (CN + international) managed subscription provider: dual-site account pools, browser login, desktop import, model sync, multi-account failover and admin routes.",
};

/** The service this activation owns (tests assert against the same instance). */
let activeService: WorkBuddyAuthService | null = null;

/** Test/inspection accessor for the current activation's service. */
export function getActivatedWorkBuddyService(): WorkBuddyAuthServiceLike | null {
  return activeService;
}

async function activate(ctx: PluginContext): Promise<void> {
  // Tokens live ONLY in the plugin's private 0600 file under the CCR config
  // dir — never in config.json, logs, admin responses or this bundle.
  const store = new WorkBuddyCredentialStore(join(ctx.host.configDir, "workbuddy-credentials.json"));
  const service = new WorkBuddyAuthService({
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
  activeService = service;

  ctx.registerConfigProtector((next, prev) => protectWorkBuddyConfig(next, prev));

  ctx.log.info(`workbuddy plugin active (${WORKBUDDY_PROVIDER_NAME}, ${WORKBUDDY_AI_PROVIDER_NAME})`);
}

const plugin = { manifest, activate };
export default plugin;
export { activate };
