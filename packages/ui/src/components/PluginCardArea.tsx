import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import {
  createPluginCardAreaController, createPluginFocusGate, pluginLocaleOf,
  type PluginCardAreaController, type PluginCardHostIssue, type PluginFocusGate,
} from "../utils/plugin-card";
import { useConfig } from "./ConfigProvider";
import { createMarketplaceBridge, createPluginMarketController, type PluginMarketController } from "../utils/plugin-market";
import { renderPluginCardUpgrade, upgradePluginCard } from "../utils/plugin-card-upgrade";
import type { PluginInfo } from "../types";

type ManifestState =
  | { status: "loading" }
  | { status: "ok"; entries: PluginInfo[] }
  | { status: "failed" };

/**
 * Renders one mounted card per installed provider plugin (docs/design/provider-plugins.md).
 *
 * Card chunks are self-contained ES modules served by the core at
 * /plugins/<name>/card.js. They are loaded through the authenticated host
 * lane (fetch with the admin API key → same-origin Blob URL → dynamic import;
 * the Blob URL is revoked on cleanup) so remote authenticated UIs work without
 * an API key in any URL and without loosening the server's auth middleware.
 *
 * Installed-but-unavailable entries (disabled or failed to load), manifest
 * failures and broken card modules are rendered as visible recovery notices —
 * a provider must never silently disappear from the settings page.
 */
export function PluginCardArea({ disabled, onBusyChange, focusKey }: { disabled: boolean; onBusyChange?: (busy: boolean) => void; focusKey?: string | null }) {
  const { i18n, t } = useTranslation();
  const { refreshConfig } = useConfig();
  const currentProps = useRef({ disabled, refreshConfig, onBusyChange, t });
  currentProps.current = { disabled, refreshConfig, onBusyChange, t };
  const actionsRef = useRef(new Map<HTMLElement, string>());
  const cardBusy = useRef(false);
  const upgradeBusy = useRef(false);
  const marketRef = useRef<PluginMarketController | null>(null);
  if (marketRef.current === null) marketRef.current = createPluginMarketController(createMarketplaceBridge(api));
  const market = marketRef.current;
  const renderActions = () => {
    for (const [host, name] of actionsRef.current) {
      renderPluginCardUpgrade(host, name, market.getState(), currentProps.current.disabled, currentProps.current.t, (packageName) => {
        if (currentProps.current.disabled || upgradeBusy.current) return;
        const release = api.acquireProviderManagement();
        if (!release) return;
        upgradeBusy.current = true;
        currentProps.current.onBusyChange?.(true);
        void upgradePluginCard(market, packageName, name, async () => {
          const data = await api.getPlugins();
          setManifest({ status: "ok", entries: data.plugins ?? [] });
        }).catch(() => {
          // Keep the restart notice if the manifest refresh fails after installation.
        }).finally(() => {
          release();
          upgradeBusy.current = false;
          currentProps.current.onBusyChange?.(cardBusy.current);
        });
      });
    }
  };
  const renderActionsRef = useRef(renderActions);
  renderActionsRef.current = renderActions;
  // F1: a deep-linked focus key is delivered exactly once per DISTINCT key.
  // location.state is persistent, so a locale switch or manifest re-sync
  // observes the same key again — the gate keeps it consumed; a NEW navigation
  // carrying a different key re-arms delivery (deep links also survive a hard
  // reload, which remounts the area with a fresh gate).
  const focusGate = useRef<PluginFocusGate | null>(null);
  if (focusGate.current === null) focusGate.current = createPluginFocusGate();
  focusGate.current.offer(focusKey);
  const [manifest, setManifest] = useState<ManifestState>({ status: "loading" });
  const [issues, setIssues] = useState<PluginCardHostIssue[]>([]);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<PluginCardAreaController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = createPluginCardAreaController({
      origin: (typeof location !== "undefined" && location && location.origin) || "",
      getDisabled: () => currentProps.current.disabled,
      callPluginApi: (plugin, path, init) => api.callPluginApi(plugin, path, init),
      acquireManagement: () => api.acquireProviderManagement(),
      refreshConfig: (merge) => currentProps.current.refreshConfig(merge),
      onBusyChange: (busy) => {
        cardBusy.current = busy;
        currentProps.current.onBusyChange?.(busy || upgradeBusy.current);
      },
      mountHostActions: (plugin, host) => {
        actionsRef.current.set(host, plugin.name);
        renderActionsRef.current();
        return () => { actionsRef.current.delete(host); };
      },
      log: console,
      fetchCardSource: (cardUrl) => api.fetchPluginCardSource(cardUrl),
      importModule: (url) => import(/* @vite-ignore */ url),
      makeBlobUrl: (source) => URL.createObjectURL(new Blob([source], { type: "text/javascript" })),
      revokeBlobUrl: (url) => URL.revokeObjectURL(url),
    });
  }
  const controller = controllerRef.current;
  const locale = pluginLocaleOf(i18n.language);

  useEffect(() => {
    const unsubscribe = market.subscribe(() => renderActionsRef.current());
    void market.refresh();
    return unsubscribe;
  }, [market]);

  useEffect(() => { renderActionsRef.current(); }, [disabled, t]);

  useEffect(() => {
    let cancelled = false;
    api.getPlugins()
      .then((data) => { if (!cancelled) setManifest({ status: "ok", entries: data.plugins ?? [] }); })
      .catch(() => { if (!cancelled) setManifest({ status: "failed" }); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (manifest.status === "loading") {
      controller.dispose();
      return;
    }
    const focus = focusGate.current?.take() ?? null;
    void controller.sync(manifest.status === "failed" ? null : manifest.entries, locale, host, focus);
    return () => { controller.dispose(); };
  }, [controller, manifest, locale]);

  // Host state changes (e.g. the page Save gate) reach mounted cards in place:
  // no remount, so no in-flight card action is ever cancelled by them.
  useEffect(() => {
    controller.notifyHostChange();
  }, [controller, disabled]);

  useEffect(() => {
    setIssues(controller.getIssues());
    return controller.subscribeIssues(setIssues);
  }, [controller]);

  return (
    <div className="plugin-card-area">
      <div ref={hostRef} aria-label={t("pluginCards.area_label")} />
      {issues.map((issue, index) => (
        <div
          key={`${issue.kind}:${issue.plugin ?? "manifest"}:${index}`}
          role="note"
          data-testid="plugin-card-issue"
          className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm"
        >
          {issue.kind === "manifest_failed" && <p>{t("pluginCards.manifest_failed")}</p>}
          {issue.kind === "unavailable" && (
            <>
              <p className="font-medium">{t("pluginCards.unavailable_title", { name: issue.plugin ?? "" })}</p>
              {issue.detail ? <p className="mt-1 text-xs opacity-80">{issue.detail}</p> : null}
              <p className="mt-1">
                {issue.reason === "disabled"
                  ? t("pluginCards.disabled_hint", { name: issue.plugin ?? "" })
                  : t("pluginCards.reinstall_hint")}
              </p>
            </>
          )}
          {issue.kind === "card_failed" && (
            <>
              <p className="font-medium">{t("pluginCards.card_failed_title", { name: issue.plugin ?? "" })}</p>
              <p className="mt-1">{t("pluginCards.reinstall_hint")}</p>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
