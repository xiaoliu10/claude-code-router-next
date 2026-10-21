import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { pluginLocaleOf, type PluginCardModule } from "../utils/plugin-card";
import type { PluginInfo } from "../types";

/**
 * Renders one mounted card per installed provider plugin (docs/design/provider-plugins.md).
 * Card chunks are self-contained ES modules served by the core at /plugins/<name>/card.js;
 * the host only bridges an authenticated API caller, the locale and the busy signal.
 */
export function PluginCardArea({ disabled, onBusyChange }: { disabled: boolean; onBusyChange?: (busy: boolean) => void }) {
  const { i18n } = useTranslation();
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [failed, setFailed] = useState(false);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mountedRef = useRef<Array<{ el: HTMLElement; unmount?: (el: HTMLElement) => void }>>([]);
  const busyCountRef = useRef(0);
  const locale = pluginLocaleOf(i18n.language);

  useEffect(() => {
    let cancelled = false;
    api.getPlugins()
      .then((data) => { if (!cancelled) setPlugins((data.plugins ?? []).filter((p) => p.enabled && !p.error)); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || plugins.length === 0) return;
    let cancelled = false;

    const mountOne = async (plugin: PluginInfo) => {
      if (!plugin.cardUrl) return;
      const mod = (await import(/* @vite-ignore */ plugin.cardUrl)) as Partial<PluginCardModule> & {
        default?: Partial<PluginCardModule>;
      };
      const card = (mod.mount ? mod : mod.default) as PluginCardModule | undefined;
      if (!card?.mount) throw new Error("card exports no mount()");
      const el = document.createElement("div");
      el.className = "plugin-card-host";
      el.dataset.plugin = plugin.name;
      host.appendChild(el);
      await card.mount(el, {
        callApi: <T,>(path: string, init?: RequestInit & { timeoutMs?: number }) =>
          api.callPluginApi<T>(plugin.name, path, init),
        locale,
        locales: plugin.locales ?? {},
        plugin: { name: plugin.name, version: plugin.version },
        disabled,
        onBusy: (busy: boolean) => {
          busyCountRef.current = Math.max(0, busyCountRef.current + (busy ? 1 : -1));
          onBusyChange?.(busyCountRef.current > 0);
        },
        log: console,
      });
      if (cancelled) {
        card.unmount?.(el);
        el.remove();
        return;
      }
      mountedRef.current.push({ el, unmount: card.unmount });
    };

    void (async () => {
      for (const plugin of plugins) {
        if (cancelled) return;
        try {
          await mountOne(plugin);
        } catch (error) {
          // A broken card must not take the settings page down.
          console.error(`[plugin:${plugin.name}] card failed to mount:`, error);
          setFailed(true);
        }
      }
    })();

    return () => {
      cancelled = true;
      for (const entry of mountedRef.current.splice(0)) {
        try { entry.unmount?.(entry.el); } catch { /* plugin cleanup must not break the host */ }
        entry.el.remove();
      }
      busyCountRef.current = 0;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plugins, locale]);

  if (plugins.length === 0) {
    return failed ? null : null; // No installed plugins (or manifest unavailable): render nothing.
  }
  return <div ref={hostRef} className="plugin-card-area" />;
}
