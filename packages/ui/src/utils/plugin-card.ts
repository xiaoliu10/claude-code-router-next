/**
 * Provider-plugin card contract (docs/design/provider-plugins.md §2.3).
 *
 * A plugin ships a self-contained ES chunk (`card.js`) that default-exports:
 *   { mount(el, props): Promise<void>|void, unmount?(el): void }
 *
 * The host (PluginCardArea) supplies everything a card needs so the chunk can
 * stay free of host internals: an authenticated fetch bridge, the active
 * locale, its locale bundle and a busy signal for save-button gating.
 *
 * This module also hosts the framework-free card-area controller used by
 * PluginCardArea: entry triage (usable / unavailable / failed), the
 * authenticated card-source → Blob URL → dynamic import lane, lease/busy
 * accounting, host-change fan-out and the rendered issue list. Keeping it
 * here makes the whole host bridge testable without a DOM or React.
 */
import type { PluginInfo } from "../types";

export interface PluginCardMountProps {
  /** Authenticated, sanitized admin-API bridge — cards never call fetch() directly. */
  callApi: <T = unknown>(path: string, init?: RequestInit & { timeoutMs?: number }) => Promise<T>;
  /** "en" | "zh" — the host's active language. */
  locale: string;
  /** The plugin's locale bundle straight from /api/plugins. */
  locales: Record<string, Record<string, unknown>>;
  plugin: { name: string; version: string | null };
  disabled: boolean;
  /** Shared save/action mutex; null means a config write or managed action is active. */
  acquireManagement?: () => (() => void) | null;
  /** Reconcile server changes into the host draft without losing unrelated edits. */
  refreshConfig?: (merge: (current: any, server: any) => any) => Promise<void>;
  /** Cards should report transient UI-busy state (gates the page save buttons). */
  onBusy?: (busy: boolean) => void;
  /**
   * Subscribe to host state changes (e.g. the page Save gate). The listener
   * must only re-render the mounted card in place — never remount it, never
   * cancel in-flight actions and never release the management lease. Returns
   * an unsubscribe function that the card must call when it is torn down.
   */
  onHostChange?: (listener: () => void) => () => void;
  log: Pick<Console, "info" | "warn" | "error">;
  /**
   * One-shot deep-link focus key (the managed provider's name, or null). Cards
   * scroll to and focus the matching section, then treat it as consumed; a
   * card that does not own the key ignores it.
   */
  focusKey?: string | null;
}

export interface PluginCardModule {
  mount(el: HTMLElement, props: PluginCardMountProps): void | Promise<void>;
  unmount?(el: HTMLElement): void;
}

/**
 * Only a well-formed code token may cross the host boundary. Format check, not
 * a list check: plugins define their own codes, but an upstream sentence must
 * never ride through as one.
 */
export function sanitizePluginErrorCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) return null;
  return value;
}

/** Locale the host hands the card, derived from the active i18n language. */
export function pluginLocaleOf(language: string | undefined): "en" | "zh" {
  return (language ?? "").toLowerCase().startsWith("zh") ? "zh" : "en";
}

/**
 * A manifest-declared card URL is only loadable when it resolves to exactly
 * the UI's own origin over http(s). This rejects absolute cross-origin URLs,
 * protocol-relative hosts, embedded credentials and blob:/data:/javascript:
 * URLs alike, so the authenticated card fetch (and the admin API key it
 * carries) can never be pointed at a third-party host.
 */
export function isSameOriginCardUrl(value: unknown, origin: string): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return false;
  if (typeof origin !== "string" || origin.length === 0) return false;
  // Whitespace-padded URLs resolve to the origin itself after trimming — reject them.
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed !== value) return false;
  let parsed: URL;
  try {
    parsed = new URL(value, origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  return parsed.origin === origin;
}

// ---------------------------------------------------------------------------
// Card-area controller (host side of the seam; framework-free)
// ---------------------------------------------------------------------------

/** Rendered diagnostics for the settings card area. Failures are visible UI, never console-only. */
export type PluginCardIssueKind = "manifest_failed" | "unavailable" | "card_failed";

export interface PluginCardHostIssue {
  kind: PluginCardIssueKind;
  /** Plugin name, or null for a manifest-level failure. */
  plugin: string | null;
  /** For unavailable entries: disabled by config, or failed to load. */
  reason?: "disabled" | "error";
  /** Safe detail text from the install manifest (rendered as plain text). */
  detail?: string | null;
}

/** Host-provided capabilities the controller needs; all injectable for tests. */
export interface PluginCardAreaBridge {
  /** The UI's own origin; card URLs must resolve to it (see isSameOriginCardUrl). */
  origin: string;
  getDisabled(): boolean;
  callPluginApi: <T = unknown>(plugin: string, path: string, init?: RequestInit & { timeoutMs?: number }) => Promise<T>;
  /** Shared save/action mutex handed to cards. */
  acquireManagement?: () => (() => void) | null;
  refreshConfig?: (merge: (current: any, server: any) => any) => Promise<void>;
  onBusyChange?: (busy: boolean) => void;
  log: Pick<Console, "info" | "warn" | "error">;
  /** Authenticated host lane: GET the declared same-origin card URL with admin credentials. */
  fetchCardSource(cardUrl: string): Promise<string>;
  /** Module loader (dynamic import of the Blob URL); injectable so tests need no browser. */
  importModule(url: string): Promise<unknown>;
  makeBlobUrl(source: string): string;
  revokeBlobUrl(url: string): void;
}

export interface PluginCardAreaController {
  /**
   * Tear down previous cards, triage manifest entries and mount the usable
   * ones. `entries === null` means the manifest itself failed and is reported
   * as a visible issue. Mounting is sequential; a disposed generation never
   * touches the DOM again.
   */
  sync(entries: PluginInfo[] | null, locale: string, host: HTMLElement, focusKey?: string | null): Promise<void>;
  /** Unmount cards, revoke Blob URLs, drop subscriptions and reset busy state. */
  dispose(): void;
  /** Fan a host state change (e.g. the Save gate) out to mounted cards, in place. */
  notifyHostChange(): void;
  getIssues(): PluginCardHostIssue[];
  subscribeIssues(listener: (issues: PluginCardHostIssue[]) => void): () => void;
}

/** Accepts either named `mount` exports or a default-exported card object. */
function extractCardModule(mod: unknown): PluginCardModule | null {
  if (!mod || typeof mod !== "object") return null;
  const candidate = mod as { mount?: unknown; unmount?: unknown; default?: { mount?: unknown; unmount?: unknown } };
  if (typeof candidate.mount === "function") return mod as PluginCardModule;
  if (candidate.default && typeof candidate.default.mount === "function") {
    return candidate.default as PluginCardModule;
  }
  return null;
}

export function createPluginCardAreaController(bridge: PluginCardAreaBridge): PluginCardAreaController {
  // Mounting generations: any dispose()/sync() invalidates in-flight mounts so
  // a torn-down generation can neither register cards nor leak Blob URLs.
  let generation = 0;
  let busyCount = 0;
  let issues: PluginCardHostIssue[] = [];
  const active: Array<{ el: HTMLElement; unmount?: (el: HTMLElement) => void; blobUrl: string | null }> = [];
  const hostListeners = new Set<() => void>();
  const issueListeners = new Set<(next: PluginCardHostIssue[]) => void>();

  const publishIssues = (next: PluginCardHostIssue[]) => {
    issues = next;
    for (const listener of [...issueListeners]) {
      try {
        listener(issues);
      } catch {
        /* a broken subscriber must not break the host */
      }
    }
  };

  const addIssue = (issue: PluginCardHostIssue) => publishIssues([...issues, issue]);

  const disposeCards = () => {
    generation += 1;
    for (const entry of active.splice(0)) {
      try {
        entry.unmount?.(entry.el);
      } catch {
        /* plugin cleanup must not break the host */
      }
      try {
        entry.el.remove();
      } catch {
        /* minimal DOM doubles may not implement remove() */
      }
      // Safe cleanup: the module is already evaluated and the card is gone, so
      // the Blob URL (and the card source it holds) can be released.
      if (entry.blobUrl) bridge.revokeBlobUrl(entry.blobUrl);
    }
    hostListeners.clear();
    if (busyCount > 0) {
      busyCount = 0;
      bridge.onBusyChange?.(false);
    }
  };

  const mountOne = async (host: HTMLElement, plugin: PluginInfo, cardUrl: string, locale: string, focusKey?: string | null) => {
    const gen = generation;
    // Host lane: authenticated fetch (admin key header) instead of a bare
    // import(cardUrl), which cannot authenticate on a non-loopback UI.
    const source = await bridge.fetchCardSource(cardUrl);
    if (gen !== generation) return;
    const blobUrl = bridge.makeBlobUrl(source);
    let mod: unknown;
    try {
      mod = await bridge.importModule(blobUrl);
    } catch (error) {
      bridge.revokeBlobUrl(blobUrl); // nothing mounted; release immediately
      throw error;
    }
    if (gen !== generation) {
      bridge.revokeBlobUrl(blobUrl);
      return;
    }
    const card = extractCardModule(mod);
    if (!card) {
      bridge.revokeBlobUrl(blobUrl);
      throw new Error("card exports no mount()");
    }
    const el = document.createElement("div");
    el.className = "plugin-card-host";
    el.dataset.plugin = plugin.name;
    host.appendChild(el);
    const props: PluginCardMountProps = {
      callApi: <T,>(path: string, init?: RequestInit & { timeoutMs?: number }) =>
        bridge.callPluginApi<T>(plugin.name, path, init),
      locale,
      locales: plugin.locales ?? {},
      plugin: { name: plugin.name, version: plugin.version },
      get disabled() {
        return bridge.getDisabled();
      },
      acquireManagement: bridge.acquireManagement,
      refreshConfig: async (merge) => { await bridge.refreshConfig?.(merge); },
      onBusy: (busy: boolean) => {
        busyCount = Math.max(0, busyCount + (busy ? 1 : -1));
        bridge.onBusyChange?.(busyCount > 0);
      },
      onHostChange: (listener) => {
        hostListeners.add(listener);
        return () => {
          hostListeners.delete(listener);
        };
      },
      log: bridge.log,
      focusKey: focusKey ?? null,
    };
    try {
      await card.mount(el, props);
    } catch (error) {
      try {
        el.remove();
      } catch {
        /* noop */
      }
      bridge.revokeBlobUrl(blobUrl);
      throw error;
    }
    if (gen !== generation) {
      // Torn down while mounting: finish the card's own cleanup, never register.
      try {
        card.unmount?.(el);
      } catch {
        /* plugin cleanup must not break the host */
      }
      try {
        el.remove();
      } catch {
        /* noop */
      }
      bridge.revokeBlobUrl(blobUrl);
      return;
    }
    active.push({ el, unmount: card.unmount, blobUrl });
  };

  return {
    async sync(entries, locale, host, focusKey) {
      disposeCards();
      const gen = generation;
      if (entries === null) {
        publishIssues([{ kind: "manifest_failed", plugin: null }]);
        return;
      }
      const pending: PluginCardHostIssue[] = [];
      const usable: Array<{ plugin: PluginInfo; cardUrl: string }> = [];
      for (const plugin of entries) {
        if (!plugin.enabled) {
          pending.push({ kind: "unavailable", plugin: plugin.name, reason: "disabled" });
        } else if (plugin.error) {
          pending.push({ kind: "unavailable", plugin: plugin.name, reason: "error", detail: plugin.error });
        } else if (!plugin.cardUrl || !isSameOriginCardUrl(plugin.cardUrl, bridge.origin)) {
          // A declared card that is not a same-origin http(s) URL is never
          // fetched — surfaced as a visible load failure instead.
          pending.push({ kind: "card_failed", plugin: plugin.name });
        } else {
          usable.push({ plugin, cardUrl: plugin.cardUrl });
        }
      }
      publishIssues(pending);
      for (const { plugin, cardUrl } of usable) {
        if (gen !== generation) return;
        try {
          await mountOne(host, plugin, cardUrl, locale, focusKey);
        } catch (error) {
          // A broken card must not take the settings page down — and must not
          // stay invisible either: it becomes a rendered recovery notice.
          bridge.log.error(`[plugin:${plugin.name}] card failed to mount:`, error);
          addIssue({ kind: "card_failed", plugin: plugin.name });
        }
      }
    },
    dispose: disposeCards,
    notifyHostChange() {
      for (const listener of [...hostListeners]) {
        try {
          listener();
        } catch (error) {
          bridge.log.error("plugin card host-change listener failed:", error);
        }
      }
    },
    getIssues: () => issues,
    subscribeIssues(listener) {
      issueListeners.add(listener);
      return () => {
        issueListeners.delete(listener);
      };
    },
  };
}
