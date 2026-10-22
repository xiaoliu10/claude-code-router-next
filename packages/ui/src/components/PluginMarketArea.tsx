import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import {
  createPluginMarketController, renderPluginMarketState,
  type PluginMarketController, type PluginMarketState,
} from "../utils/plugin-market";

/**
 * "可安装插件 / Available plugins" section inside the Providers tab
 * (docs/design/provider-plugins.md §2.2). Lists npm catalog entries (marker
 * keyword) that are not installed yet, each with a one-click install button
 * backed by the local-only POST /api/plugins/install route.
 *
 * Installing never hot-loads and never auto-restarts: a successful install
 * shows a "restart to activate" notice whose Restart button calls the
 * existing POST /api/restart flow only on an explicit user click.
 */
/** Poll until the restarted service answers again, so the reload never lands
 *  on a closed port. Mirrors the update flow in App.tsx. */
async function waitForServiceBack(): Promise<void> {
  const intervalMs = 1500;
  const maxAttempts = 20;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    try {
      await api.checkForUpdates();
      return;
    } catch {
      // still restarting
    }
  }
  // Give up waiting but still reload; the caller surfaces nothing further.
}

export function PluginMarketArea({ disabled, onBusyChange }: { disabled: boolean; onBusyChange?: (busy: boolean) => void }) {
  const { t } = useTranslation();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [isRestarting, setIsRestarting] = useState(false);
  const [state, setState] = useState<PluginMarketState | null>(null);
  const currentProps = useRef({ disabled, onBusyChange });
  currentProps.current = { disabled, onBusyChange };
  const controllerRef = useRef<PluginMarketController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = createPluginMarketController({
      getCatalog: () => api.getPluginCatalog(),
      installPlugin: (name) => api.installPlugin(name),
      log: console,
    });
  }
  const controller = controllerRef.current;

  useEffect(() => {
    void controller.refresh();
    return controller.subscribe(setState);
  }, [controller]);

  // Install requests gate the page save buttons through the shared busy lane.
  useEffect(() => {
    currentProps.current.onBusyChange?.(state?.busyName !== null);
  }, [state?.busyName]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !state) return;
    renderPluginMarketState(host, state, t, {
      onInstall: (name) => { void controller.install(name); },
      onRetry: () => { void controller.refresh(); },
      onRestart: () => {
        // Explicit user click only — never automatic.
        setIsRestarting(true);
        api.restartService()
          .then(waitForServiceBack)
          .then(() => window.location.reload())
          .catch(() => {
            setIsRestarting(false);
          });
      },
      onDismissNotice: () => controller.dismissNotice(),
    });
    // Install buttons additionally honor the page-level disabled gate.
    if (disabled) {
      for (const button of Array.from(host.querySelectorAll("button"))) {
        (button as HTMLButtonElement).disabled = true;
      }
    }
  }, [controller, state, t, disabled]);

  return (
    <div className="plugin-market-host" data-disabled={disabled || isRestarting || undefined}>
      <div ref={hostRef} aria-label={t("pluginMarket.title")} />
    </div>
  );
}
