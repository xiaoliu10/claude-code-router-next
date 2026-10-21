import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import {
  createPluginCardAreaController, pluginLocaleOf,
  type PluginCardAreaController, type PluginCardHostIssue,
} from "../utils/plugin-card";
import { useConfig } from "./ConfigProvider";
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
export function PluginCardArea({ disabled, onBusyChange }: { disabled: boolean; onBusyChange?: (busy: boolean) => void }) {
  const { i18n, t } = useTranslation();
  const { refreshConfig } = useConfig();
  const currentProps = useRef({ disabled, refreshConfig, onBusyChange });
  currentProps.current = { disabled, refreshConfig, onBusyChange };
  const [manifest, setManifest] = useState<ManifestState>({ status: "loading" });
  const [issues, setIssues] = useState<PluginCardHostIssue[]>([]);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<PluginCardAreaController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = createPluginCardAreaController({
      origin: (typeof location !== "undefined" && location && location.origin) || "",
      getDisabled: () => currentProps.current.disabled,
      callPluginApi: (plugin, path, init) => api.callPluginApi(plugin, path, init),
      acquireManagement: () => api.acquireWorkBuddyManagement(),
      refreshConfig: (merge) => currentProps.current.refreshConfig(merge),
      onBusyChange: (busy) => currentProps.current.onBusyChange?.(busy),
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
    void controller.sync(manifest.status === "failed" ? null : manifest.entries, locale, host);
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
