/**
 * Provider-plugin marketplace UI contract (docs/design/provider-plugins.md §2.2).
 *
 * Framework-free controller + DOM renderer for the "可安装插件 / Available
 * plugins" section inside the Providers tab. The React component
 * (PluginMarketArea) only wires this into the component tree; everything
 * testable lives here — catalog loading, per-entry install with busy state,
 * safe error mapping (stable server codes → localized text, never raw npm
 * output) and the explicit "restart to activate" notice (never auto-restart).
 *
 * Responses never contain credential material; the controller logs names and
 * stable codes only.
 */

// Single source of truth for the catalog DTO is the shared UI types module.
// A second declaration here previously let the two copies drift apart (a field
// the route emits but typed consumers cannot see), so it is re-exported.
export type { PluginMarketCatalogEntry } from "../types";
import type { PluginMarketCatalogEntry } from "../types";

export interface PluginMarketBridge {
  /** GET /api/plugins/catalog (already authenticated via the API client). */
  getCatalog(): Promise<{ ok: true; plugins: PluginMarketCatalogEntry[]; warning?: string }>;
  /** POST /api/plugins/install — resolves only on ok:true. With `force` the
   *  same staged atomic swap replaces an existing installation (update path). */
  installPlugin(name: string, force?: boolean): Promise<{ ok: true; name: string; version: string; restartRequired: boolean }>;
  log: Pick<Console, "info" | "warn" | "error">;
}

export interface PluginMarketState {
  status: "loading" | "ready" | "unavailable";
  /** Catalog entries that are NOT installed yet — the installable list. */
  entries: PluginMarketCatalogEntry[];
  /** Installed catalog entries. Shown with an update affordance when the
   *  npm version differs from the installed manifest version. */
  installedEntries: PluginMarketCatalogEntry[];
  /** Total catalog size (installed entries exist but are not listed). */
  hiddenInstalled: number;
  /** Stable warning code from the route ("registry_unavailable"). */
  warning: string | null;
  /** Entry an install is currently running for — disables all install buttons. */
  busyName: string | null;
  /** { name, code }: the failed entry and the SAFE server code. */
  error: { name: string | null; code: string } | null;
  /** Name of the last successful install in this session (drives the notice). */
  justInstalled: string | null;
}

export type PluginMarketErrorCode =
  | "invalid_spec"
  | "npm_pack_failed"
  | "npm_pack_timeout"
  | "archive_too_large"
  | "archive_too_many_files"
  | "unsafe_archive_member"
  | "extract_failed"
  | "invalid_manifest"
  | "already_installed"
  | "plugins_json_corrupted"
  | "local_only"
  | "install_failed"
  | "request_failed";

/**
 * Only a well-formed stable code may become rendered error state. Everything
 * else (npm stderr, upstream HTML, exception text) collapses to the generic
 * code — raw upstream text must never reach the DOM through this boundary.
 */
export function sanitizeMarketErrorCode(value: unknown): PluginMarketErrorCode {
  const known: PluginMarketErrorCode[] = [
    "invalid_spec", "npm_pack_failed", "npm_pack_timeout", "archive_too_large",
    "archive_too_many_files", "unsafe_archive_member", "extract_failed",
    "invalid_manifest", "already_installed", "plugins_json_corrupted",
    "local_only", "install_failed", "request_failed",
  ];
  if (typeof value === "string" && (known as string[]).includes(value)) {
    return value as PluginMarketErrorCode;
  }
  return "install_failed";
}

export interface PluginMarketHandlers {
  onInstall(name: string): void;
  onUpdate(name: string): void;
  onRetry(): void;
  onRestart(): void;
  onDismissNotice(): void;
}

/** Render the marketplace section from state. Pure DOM, no framework — the
 *  React host re-runs it on every state change (same pattern as the card
 *  area controller). */
export function renderPluginMarketState(
  host: HTMLElement,
  state: PluginMarketState,
  t: (key: string, params?: Record<string, unknown>) => string,
  handlers: PluginMarketHandlers
): void {
  host.replaceChildren();

  const section = document.createElement("div");
  section.className = "plugin-market-area";
  section.dataset.testid = "plugin-market-section";
  const title = document.createElement("h3");
  title.className = "text-sm font-semibold tracking-wide text-muted-foreground uppercase";
  title.textContent = t("pluginMarket.title");
  section.appendChild(title);
  const subtitle = document.createElement("p");
  subtitle.className = "mt-1 text-xs text-muted-foreground";
  subtitle.textContent = t("pluginMarket.subtitle");
  section.appendChild(subtitle);

  if (state.justInstalled) {
    const notice = document.createElement("div");
    notice.className = "mt-3 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm";
    notice.dataset.testid = "plugin-market-restart-notice";
    notice.setAttribute("role", "note");
    const text = document.createElement("p");
    text.textContent = t("pluginMarket.restart_notice", { name: state.justInstalled });
    notice.appendChild(text);
    const actions = document.createElement("div");
    actions.className = "mt-2 flex gap-2";
    const restart = document.createElement("button");
    restart.type = "button";
    restart.dataset.testid = "plugin-market-restart";
    restart.className = "rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500";
    restart.textContent = t("pluginMarket.restart_now");
    restart.addEventListener("click", () => handlers.onRestart());
    actions.appendChild(restart);
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.dataset.testid = "plugin-market-dismiss";
    dismiss.className = "rounded-md border border-white/10 px-3 py-1.5 text-xs hover:bg-white/10";
    dismiss.textContent = t("pluginMarket.dismiss");
    dismiss.addEventListener("click", () => handlers.onDismissNotice());
    actions.appendChild(dismiss);
    notice.appendChild(actions);
    section.appendChild(notice);
  }

  if (state.status === "loading") {
    const loading = document.createElement("div");
    loading.className = "mt-3 text-sm text-muted-foreground";
    loading.dataset.testid = "plugin-market-loading";
    loading.textContent = t("pluginMarket.loading");
    section.appendChild(loading);
    host.appendChild(section);
    return;
  }

  if (state.status === "unavailable") {
    const warning = document.createElement("div");
    warning.className = "mt-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm";
    warning.dataset.testid = "plugin-market-warning";
    warning.setAttribute("role", "note");
    warning.textContent = t("pluginMarket.registry_warning");
    section.appendChild(warning);
    const retry = document.createElement("button");
    retry.type = "button";
    retry.dataset.testid = "plugin-market-retry";
    retry.className = "mt-2 rounded-md border border-white/10 px-3 py-1.5 text-xs hover:bg-white/10";
    retry.textContent = t("pluginMarket.retry");
    retry.addEventListener("click", () => handlers.onRetry());
    section.appendChild(retry);
    host.appendChild(section);
    return;
  }

  if (state.entries.length === 0 && state.installedEntries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "mt-3 text-sm text-muted-foreground";
    empty.dataset.testid = "plugin-market-empty";
    empty.textContent = t("pluginMarket.empty");
    section.appendChild(empty);
    host.appendChild(section);
    return;
  }

  // Installed plugins — so a marketplace user can see their version state and
  // update without reaching for the CLI. Rows with `updateAvailable` get the
  // prominent affordance; up-to-date and local-only rows render read-only.
  if (state.installedEntries.length > 0) {
    const installedTitle = document.createElement("h4");
    installedTitle.className = "mt-4 text-xs font-semibold tracking-wide text-muted-foreground uppercase";
    installedTitle.dataset.testid = "plugin-market-installed-title";
    installedTitle.textContent = t("pluginMarket.installed_title");
    section.appendChild(installedTitle);

    const installedList = document.createElement("ul");
    installedList.className = "mt-2 space-y-2";
    installedList.dataset.testid = "plugin-market-installed-list";
    for (const entry of state.installedEntries) {
      const row = document.createElement("li");
      row.className = "flex items-start justify-between gap-4 rounded-lg border border-white/10 bg-white/5 p-3";
      row.dataset.testid = "plugin-market-installed-entry";
      row.dataset.name = entry.name;

      const info = document.createElement("div");
      info.className = "min-w-0";
      const nameLine = document.createElement("div");
      nameLine.className = "text-sm font-medium";
      nameLine.textContent = entry.name;
      info.appendChild(nameLine);
      const meta = document.createElement("div");
      meta.className = "mt-0.5 text-xs text-muted-foreground";
      meta.textContent = entry.updateAvailable
        ? t("pluginMarket.version_outdated", {
            installed: entry.installedVersion ?? "?",
            latest: entry.version,
          })
        : t("pluginMarket.version_ok", { version: entry.installedVersion ?? entry.version });
      info.appendChild(meta);
      if (entry.description) {
        const description = document.createElement("div");
        description.className = "mt-1 text-xs text-muted-foreground";
        description.textContent = entry.description;
        info.appendChild(description);
      }
      row.appendChild(info);

      if (entry.updateAvailable) {
        const update = document.createElement("button");
        update.type = "button";
        update.dataset.testid = "plugin-market-update";
        update.dataset.name = entry.name;
        update.className = "shrink-0 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white shadow hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50";
        const busy = state.busyName !== null;
        update.disabled = busy;
        update.textContent = state.busyName === entry.name ? t("pluginMarket.updating") : t("pluginMarket.update");
        update.addEventListener("click", () => handlers.onUpdate(entry.name));
        row.appendChild(update);
      } else if (entry.localOnly) {
        const tag = document.createElement("span");
        tag.className = "shrink-0 rounded-md border border-white/10 px-2 py-1 text-xs text-muted-foreground";
        tag.dataset.testid = "plugin-market-local-only";
        tag.textContent = t("pluginMarket.local_only");
        row.appendChild(tag);
      }

      if (state.error && state.error.name === entry.name) {
        const errorLine = document.createElement("div");
        errorLine.className = "basis-full text-xs text-red-400";
        errorLine.dataset.testid = "plugin-market-installed-error";
        errorLine.setAttribute("role", "note");
        errorLine.textContent = t("pluginMarket.error_generic", { code: state.error.code });
        row.appendChild(errorLine);
      }

      installedList.appendChild(row);
    }
    section.appendChild(installedList);
  }

  if (state.entries.length > 0) {
    const availableTitle = document.createElement("h4");
    availableTitle.className = "mt-4 text-xs font-semibold tracking-wide text-muted-foreground uppercase";
    availableTitle.dataset.testid = "plugin-market-available-title";
    availableTitle.textContent = t("pluginMarket.available_title");
    section.appendChild(availableTitle);
  }

  if (state.entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "mt-3 text-sm text-muted-foreground";
    empty.dataset.testid = "plugin-market-empty-available";
    empty.textContent = t("pluginMarket.empty_available");
    section.appendChild(empty);
    host.appendChild(section);
    return;
  }

  const list = document.createElement("ul");
  list.className = "mt-3 space-y-2";
  list.dataset.testid = "plugin-market-list";
  for (const entry of state.entries) {
    const row = document.createElement("li");
    row.className = "flex items-start justify-between gap-4 rounded-lg border border-white/10 bg-white/5 p-3";
    row.dataset.testid = "plugin-market-entry";
    row.dataset.name = entry.name;

    const info = document.createElement("div");
    info.className = "min-w-0";
    const nameLine = document.createElement("div");
    nameLine.className = "text-sm font-medium";
    nameLine.textContent = entry.name;
    info.appendChild(nameLine);
    const meta = document.createElement("div");
    meta.className = "mt-0.5 text-xs text-muted-foreground";
    meta.textContent = `v${entry.version}`;
    info.appendChild(meta);
    if (entry.description) {
      const description = document.createElement("div");
      description.className = "mt-1 text-xs text-muted-foreground";
      description.textContent = entry.description;
      info.appendChild(description);
    }
    row.appendChild(info);

    const action = document.createElement("button");
    action.type = "button";
    action.dataset.testid = "plugin-market-install";
    action.dataset.name = entry.name;
    action.className = "shrink-0 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50";
    const busy = state.busyName !== null;
    action.disabled = busy;
    action.textContent = state.busyName === entry.name ? t("pluginMarket.installing") : t("pluginMarket.install");
    action.addEventListener("click", () => handlers.onInstall(entry.name));
    row.appendChild(action);

    if (state.error && state.error.name === entry.name) {
      const errorLine = document.createElement("div");
      errorLine.className = "basis-full text-xs text-red-400";
      errorLine.dataset.testid = "plugin-market-error";
      errorLine.setAttribute("role", "note");
      // Some codes have a dedicated, accurate explanation; the rest fall back
      // to the generic "check the code" copy.
      errorLine.textContent = state.error.code === "local_only"
        ? t("pluginMarket.error_local_only")
        : t("pluginMarket.error_generic", { code: state.error.code });
      row.appendChild(errorLine);
    }

    list.appendChild(row);
  }
  section.appendChild(list);
  host.appendChild(section);
}

// ---------------------------------------------------------------------------
// Controller (state + actions; framework-free)
// ---------------------------------------------------------------------------

export interface PluginMarketController {
  /** Load the catalog. Safe to call repeatedly (retry / post-install refresh). */
  refresh(): Promise<void>;
  /** Install one catalog entry; refreshes the catalog on success. With force
   *  (update path) an existing installation is replaced in place. */
  install(name: string, force?: boolean): Promise<void>;
  /** Update an installed entry (same install seam with force semantics). */
  update(name: string): Promise<void>;
  /** Clear the restart notice (dismiss button). */
  dismissNotice(): void;
  getState(): PluginMarketState;
  subscribe(listener: (state: PluginMarketState) => void): () => void;
  /** Release listeners; in-flight installs finish but publish to nobody. */
  dispose(): void;
}

export function createPluginMarketController(bridge: PluginMarketBridge): PluginMarketController {
  let disposed = false;
  let state: PluginMarketState = {
    status: "loading",
    entries: [],
    installedEntries: [],
    hiddenInstalled: 0,
    warning: null,
    busyName: null,
    error: null,
    justInstalled: null,
  };
  const listeners = new Set<(state: PluginMarketState) => void>();

  const publish = (next: PluginMarketState) => {
    state = next;
    for (const listener of [...listeners]) {
      try {
        listener(state);
      } catch {
        /* a broken subscriber must not break the host */
      }
    }
  };

  return {
    async refresh() {
      if (disposed) return;
      publish({ ...state, status: state.status === "ready" ? "ready" : "loading" });
      try {
        const catalog = await bridge.getCatalog();
        if (disposed) return;
        const warning = typeof catalog.warning === "string" ? catalog.warning : null;
        const byName = [...catalog.plugins].sort((a, b) => a.name.localeCompare(b.name));
        const entries = byName.filter((entry) => !entry.installed);
        // Installed rows are listed alongside the installable ones so the
        // marketplace is also where an update is discovered and triggered;
        // updateAvailable is computed by the route from the manifest version.
        const installedEntries = byName.filter((entry) => entry.installed);
        publish({
          status: warning ? "unavailable" : "ready",
          entries,
          installedEntries,
          hiddenInstalled: installedEntries.length,
          warning,
          busyName: null,
          error: null,
          // A just-installed name must survive the post-install refresh so the
          // restart notice stays visible until dismissed.
          justInstalled: state.justInstalled,
        });
      } catch (error: any) {
        if (disposed) return;
        bridge.log.warn(`plugin catalog load failed: ${sanitizeMarketErrorCode(error?.reason ?? error?.code)}`);
        publish({
          status: "unavailable",
          entries: [],
          installedEntries: [],
          hiddenInstalled: 0,
          warning: "registry_unavailable",
          busyName: null,
          error: null,
          justInstalled: state.justInstalled,
        });
      }
    },
    async install(name, force = false) {
      if (disposed || state.busyName !== null) return;
      publish({ ...state, busyName: name, error: null });
      try {
        const result = await bridge.installPlugin(name, force);
        if (disposed) return;
        bridge.log.info(`plugin installed via marketplace: ${result.name}@${result.version}`);
        publish({
          ...state,
          busyName: null,
          justInstalled: result.name,
        });
        await this.refresh();
      } catch (error: any) {
        if (disposed) return;
        const code = sanitizeMarketErrorCode(error?.reason ?? error?.code ?? error?.message);
        bridge.log.warn(`plugin install failed: ${code}`);
        publish({ ...state, busyName: null, error: { name, code } });
      }
    },
    // An update is the same install call with force semantics, so credentials
    // survive and the swap is the same staged atomic rename.
    async update(name) {
      await this.install(name, true);
    },
    dismissNotice() {
      if (disposed) return;
      publish({ ...state, justInstalled: null });
    },
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      disposed = true;
      listeners.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Production bridge factory
// ---------------------------------------------------------------------------

/** The subset of the API client the bridge needs (keeps the factory testable
 *  with a plain double instead of the whole client). */
export interface MarketplaceApiLike {
  getPluginCatalog(): Promise<{ ok: true; plugins: PluginMarketCatalogEntry[]; warning?: string }>;
  installPlugin(name: string, force?: boolean): Promise<{ ok: true; name: string; version: string; restartRequired: boolean }>;
}

/**
 * Build the marketplace bridge over the real API client.
 *
 * Exported so a test can assert argument forwarding: the update path depends
 * on `force` reaching POST /api/plugins/install. A wrapper that drops it (TS
 * allows a fewer-params function where a two-param signature is expected)
 * silently sends every update down the plain install lane, where an existing
 * directory is rejected with already_installed — the button would appear to
 * work while never replacing the plugin.
 */
export function createMarketplaceBridge(apiClient: MarketplaceApiLike): PluginMarketBridge {
  return {
    getCatalog: () => apiClient.getPluginCatalog(),
    installPlugin: (name, force) => apiClient.installPlugin(name, force),
    log: console,
  };
}
