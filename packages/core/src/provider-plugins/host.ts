import { ProviderService } from "../services/provider";
import { reconcileHealthStore } from "../ccr/health-reconcile";
import * as activeProbe from "../services/active-probe";
import { resolveProviderProxyUrl } from "../services/proxy";


/**
 * The canonical POST-/api-config runtime reload sequence, owned by the core
 * and handed to plugins via PluginContext.host.reloadRuntime. Before this
 * existed, every managed provider (WorkBuddy, Gemini OAuth) carried its own
 * copy — the plugin API exists to end exactly that kind of duplication.
 */
export function reloadProviderRuntime(server: any, config: any, log: { info(msg: string): void; warn(msg: string): void; error(msg: string): void }): void {
  if (!server?.configService) return;
  try {
    server.configService.reload();
    const nextProviders = config?.Providers || config?.providers;
    if (Array.isArray(nextProviders)) server.configService.set("providers", nextProviders);
    if (server.transformerService) {
      // Re-resolve provider transformer instances after plugin activation or save.
      server.providerService = new ProviderService(server.configService, server.transformerService, log);
    }
    reconcileHealthStore(config, log);
    activeProbe.resetActiveProbeService();
    const probeConfig = {
      enabled: server.configService.get("ACTIVE_PROBE_ENABLED") ?? true,
      quotaProbeIntervalMinutes: server.configService.get("QUOTA_PROBE_INTERVAL_MINUTES") ?? 10,
      probeTimeoutMs: server.configService.get("PROBE_TIMEOUT_MS") ?? 15000,
      slowThresholdMs: Number(server.configService.get("PROBE_SLOW_THRESHOLD_MS")) || 3000,
      initialDelayMs: server.configService.get("PROBE_INITIAL_DELAY_MS") ?? 5000,
      excludeProviders: server.configService.get("EXCLUDE_PROBE_PROVIDERS") ?? [],
    };
    server.activeProbeService = activeProbe.startActiveProbe(
      () => server.providerService.getProviders(),
      probeConfig,
      (provider: any) => {
        return resolveProviderProxyUrl(server.configService, provider);
      },
      log,
      (key: string) => server.configService.get(key)
    );
  } catch (error: any) {
    log.warn(`Config saved but runtime reload failed: ${error?.message || error}`);
  }
}
