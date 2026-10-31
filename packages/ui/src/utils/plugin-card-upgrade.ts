import type { PluginMarketController, PluginMarketState } from "./plugin-market";

/** Render host actions in a sibling of the plugin-owned mount element. */
export function renderPluginCardUpgrade(
  host: HTMLElement,
  name: string,
  state: PluginMarketState,
  disabled: boolean,
  t: (key: string, params?: Record<string, unknown>) => string,
  onUpgrade: (packageName: string) => void,
): void {
  host.replaceChildren();
  // The API does not expose source-to-manifest identity. This UI-only feature
  // supports exact names and official packages; custom npm naming is intentionally
  // excluded until the catalog exposes that association.
  const entry = state.installedEntries.find((entry) => entry.name === name)
    ?? state.installedEntries.find((entry) => entry.name === `@wengine-ai/ccr-provider-${name}`);
  const packageName = entry?.name ?? name;
  if (entry?.updateAvailable === true) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.testid = "plugin-card-upgrade";
    button.dataset.name = name;
    button.className = "mb-2 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50";
    button.disabled = disabled || state.busyName !== null;
    button.textContent = t(state.busyName === packageName ? "pluginCards.upgrading" : "pluginCards.upgrade");
    button.addEventListener("click", () => { if (!button.disabled) onUpgrade(packageName); });
    host.appendChild(button);
  }
  if (state.error?.name === packageName || state.justInstalled === name) {
    const notice = document.createElement("p");
    notice.setAttribute("role", state.error?.name === packageName ? "alert" : "status");
    notice.className = "mb-2 text-xs text-muted-foreground";
    notice.textContent = state.error?.name === packageName
      ? t("pluginMarket.error_generic", { code: state.error.code })
      : t("pluginCards.upgraded_restart");
    host.appendChild(notice);
  }
}

/** Successful install responses identify the manifest, not the requested npm spec. */
export async function upgradePluginCard(
  market: PluginMarketController,
  packageName: string,
  manifestName: string,
  refreshCard: () => Promise<void>,
): Promise<void> {
  market.dismissNotice();
  await market.update(packageName);
  const state = market.getState();
  if (state.justInstalled === manifestName && !state.error) await refreshCard();
}
