/**
 * Provider-plugin card contract (docs/design/provider-plugins.md §2.3).
 *
 * A plugin ships a self-contained ES chunk (`card.js`) that default-exports:
 *   { mount(el, props): Promise<void>|void, unmount?(el): void }
 *
 * The host (PluginCardArea) supplies everything a card needs so the chunk can
 * stay free of host internals: an authenticated fetch bridge, the active
 * locale, its locale bundle and a busy signal for save-button gating.
 */

export interface PluginCardMountProps {
  /** Authenticated, sanitized admin-API bridge — cards never call fetch() directly. */
  callApi: <T = unknown>(path: string, init?: RequestInit & { timeoutMs?: number }) => Promise<T>;
  /** "en" | "zh" — the host's active language. */
  locale: string;
  /** The plugin's locale bundle straight from /api/plugins. */
  locales: Record<string, Record<string, unknown>>;
  plugin: { name: string; version: string | null };
  disabled: boolean;
  /** Cards should report transient UI-busy state (gates the page save buttons). */
  onBusy?: (busy: boolean) => void;
  log: Pick<Console, "info" | "warn" | "error">;
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
