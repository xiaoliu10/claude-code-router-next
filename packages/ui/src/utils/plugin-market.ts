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

export interface PluginMarketCatalogEntry {
  name: string;
  description: string;
  version: string;
  installed: boolean;
  installedVersion: string | null;
}

export interface PluginMarketBridge {
  /** GET /api/plugins/catalog (already authenticated via the API client). */
  getCatalog(): Promise<{ ok: true; plugins: PluginMarketCatalogEntry[]; warning?: string }>;
  /** POST /api/plugins/install — resolves only on ok:true. */
  installPlugin(name: string): Promise<{ ok: true; name: string; version: string; restartRequired: boolean }>;
  log: Pick<Console, "info" | "warn" | "error">;
}

export interface PluginMarketState {
  status: "loading" | "ready" | "unavailable";
  /** Catalog entries that are NOT installed yet — the installable list. */
  entries: PluginMarketCatalogEntry[];
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
    "install_failed", "request_failed",
  ];
  if (typeof value === "string" && (known as string[]).includes(value)) {
    return value as PluginMarketErrorCode;
  }
  return "install_failed";
}

export interface PluginMarketHandlers {
  onInstall(name: string): void;
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

  if (state.entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "mt-3 text-sm text-muted-foreground";
    empty.dataset.testid = "plugin-market-empty";
    empty.textContent = state.hiddenInstalled > 0
      ? t("pluginMarket.empty_all_installed", { count: state.hiddenInstalled })
      : t("pluginMarket.empty");
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
      errorLine.textContent = t("pluginMarket.error_generic", { code: state.error.code });
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
  /** Install one catalog entry; refreshes the catalog on success. */
  install(name: string): Promise<void>;
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
        const installed = catalog.plugins.filter((entry) => entry.installed);
        // The section lists installable entries only; installed ones are
        // visible through their plugin cards / recovery notices above.
        const entries = catalog.plugins
          .filter((entry) => !entry.installed)
          .sort((a, b) => a.name.localeCompare(b.name));
        publish({
          status: warning ? "unavailable" : "ready",
          entries,
          hiddenInstalled: installed.length,
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
          hiddenInstalled: 0,
          warning: "registry_unavailable",
          busyName: null,
          error: null,
          justInstalled: state.justInstalled,
        });
      }
    },
    async install(name) {
      if (disposed || state.busyName !== null) return;
      publish({ ...state, busyName: name, error: null });
      try {
        const result = await bridge.installPlugin(name);
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
