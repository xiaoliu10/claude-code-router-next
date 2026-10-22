/** Self-contained WorkBuddy DOM card: no React, host imports or direct fetch.
 * All state/network/config interactions flow through the host card capabilities
 * (PluginCardMountProps). Framework-free port of the former React
 * `packages/ui/src/components/WorkBuddyProvider.tsx` (deleted at the hard
 * cut): two independent per-site §16 cards (CN + international), account rows
 * with per-account credits/switch/remove, model chips with hide, hidden-model
 * restore, browser authorization with cancel, explicit status reads only.
 *
 * Parity bar (same as the Gemini card): the management lease is held through
 * unmount until a deferred mutation and its reconciliation settle; failures
 * render as visible recovery notes; host changes re-render in place (never a
 * remount, never cancelling in-flight actions); the settle split keeps the
 * per-site status refresh and the settled message alive even when the config
 * draft reconciliation fails. The card never calls fetch() itself and never
 * renders token material — the admin API surface is summary-only.
 */
import type { PluginCardMountProps } from "../../../ui/src/utils/plugin-card";
import type {
  WorkBuddyAccountSummary, WorkBuddyKind, WorkBuddyLoginStartResponse,
  WorkBuddyMutationResponse, WorkBuddySiteStatus, WorkBuddyStatusResponse, WorkBuddyUsage,
} from "./card-types";
import { createWorkBuddyLogin, WORKBUDDY_POLL_TIMEOUT } from "./card-login";
import {
  formatWorkBuddyClock, isWorkBuddyConnected, labelWorkBuddyRouterPath, maskWorkBuddyUid,
  mergeWorkBuddyHiddenRefs, mergeWorkBuddyProvider, parseWorkBuddyUsage,
  sanitizeWorkBuddyModelRefs, sanitizeWorkBuddyRouterPaths, workBuddyAccountCooling,
  workBuddyAccountRestricted, workBuddyErrorKey, workBuddyImagesUnsupportedModels,
  workBuddyLoginOutcome, workBuddySettle, workBuddySiteStatus, workBuddyStateKey,
  workBuddyVisibleErrorKey,
} from "./card-shared";
import { workbuddyLocales } from "./locales";

type SiteActionKind = "login" | "sync" | "disconnect" | "usage" | "switch" | "remove" | "hide" | "restore";
interface SiteAction { kind: SiteActionKind; site: WorkBuddyKind; model?: string }
type ConfirmRequest = { kind: "disconnect"; site: WorkBuddyKind } | { kind: "remove"; site: WorkBuddyKind; uid: string };

const SITES: WorkBuddyKind[] = ["workbuddy", "workbuddy-ai"];

/** Generic host-locale fallbacks for the few non-workbuddy keys the card shows. */
const FALLBACKS: Record<string, { en: string; zh: string }> = {
  "app.cancel": { en: "Cancel", zh: "取消" },
  "router.background": { en: "Background", zh: "背景" },
  "router.think": { en: "Think", zh: "思考" },
  "router.longContext": { en: "Long Context", zh: "长文本" },
  "router.extendedContext": { en: "Extended Context (1M)", zh: "长文本（1M）" },
  "router.webSearch": { en: "Web Search", zh: "网络搜索" },
  "router.image": { en: "Image", zh: "图像" },
};

const mounted = new WeakMap<HTMLElement, () => void>();

// ---- session quota cache ---------------------------------------------------
// Per-tab (sessionStorage) cache of the last quota read per account, with a
// TTL. The card remounts on every page visit; the cache is what makes the
// auto-read "once" instead of "once per render" and keeps tab switches free.
// sessionStorage may be absent (tests, exotic embeds): the cache then simply
// stays empty and every mount auto-reads — same as a first visit.
const USAGE_CACHE_KEY = "wb-usage-cache-v1";
const USAGE_CACHE_TTL_MS = 10 * 60_000;
interface CachedUsage { value: WorkBuddyUsage | null; at: number }
interface UsageCacheShape { savedAt: number; entries: Partial<Record<WorkBuddyKind, Record<string, CachedUsage>>> }

function readUsageStore(): UsageCacheShape {
  try {
    const raw = (globalThis as any).sessionStorage?.getItem(USAGE_CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.entries && typeof parsed.entries === "object") {
        return parsed as UsageCacheShape;
      }
    }
  } catch { /* unavailable or corrupt */ }
  return { savedAt: 0, entries: {} };
}

function writeUsageStore(store: UsageCacheShape): void {
  try { (globalThis as any).sessionStorage?.setItem(USAGE_CACHE_KEY, JSON.stringify(store)); } catch { /* unavailable */ }
}

export function mount(el: HTMLElement, props: PluginCardMountProps): void {
  unmount(el);
  const locale = props.locale.startsWith("zh") ? "zh" : "en";
  const bundle = (props.locales[locale]?.workbuddy ?? workbuddyLocales[locale].workbuddy) as Record<string, any>;
  const t = (key: string, vars: Record<string, unknown> = {}): string => {
    // Bundle keys are stored WITHOUT the "workbuddy." namespace, but outcome
    // keys arrive namespace-prefixed (they mirror the i18n surface); resolve
    // through the prefix when the direct lookup misses.
    let text: any = key.split(".").reduce<any>((obj, k) => obj?.[k], bundle);
    if (typeof text !== "string" && key.startsWith("workbuddy.")) {
      text = key.slice("workbuddy.".length).split(".").reduce<any>((obj, k) => obj?.[k], bundle);
    }
    if (typeof text !== "string") {
      text = key.split(".").reduce<any>((obj, k) => obj?.[k], {
        app: { cancel: FALLBACKS["app.cancel"][locale] },
        router: Object.fromEntries(Object.entries(FALLBACKS).filter(([k]) => k.startsWith("router.")).map(([k, v]) => [k.slice(7), v[locale]])),
      });
    }
    return (typeof text === "string" ? text : key).replace(/\{\{(\w+)\}\}/g, (_, name) => String(vars[name] ?? ""));
  };

  let alive = true;
  let loading = true, loadFailed = false;
  let status: WorkBuddyStatusResponse | null = null;
  let action: SiteAction | null = null;
  let locked = false;
  let generation = 0;
  const errors: Partial<Record<WorkBuddyKind, string | null>> = {};
  let confirm: ConfirmRequest | null = null;
  let login: WorkBuddyLoginStartResponse | null = null;
  let cancelling = false;
  let loginSession: ReturnType<typeof createWorkBuddyLogin> | null = null;
  const usage: Partial<Record<WorkBuddyKind, Record<string, WorkBuddyUsage | null>>> = {};
  const usageStore = readUsageStore();
  const freshUsage = (site: WorkBuddyKind, uid: string): WorkBuddyUsage | null | undefined => {
    const hit = usageStore.entries[site]?.[uid];
    if (!hit || Date.now() - hit.at > USAGE_CACHE_TTL_MS) return undefined;
    return hit.value;
  };
  const rememberUsage = (site: WorkBuddyKind, uid: string, value: WorkBuddyUsage | null): void => {
    usageStore.savedAt = Date.now();
    usageStore.entries[site] = { ...(usageStore.entries[site] || {}), [uid]: { value, at: usageStore.savedAt } };
    writeUsageStore(usageStore);
  };
  let toast: string | null = null;
  let release: (() => void) | null = null;
  let unsubscribeHost: (() => void) | null = null;
  // One-shot deep-link focus: a host navigation carrying this plugin's managed
  // provider name ("workbuddy" / "workbuddy-ai") scrolls to and focuses that
  // site's section. Consumed on first render; unknown keys are ignored (and
  // remain unconsumed — other cards own them).
  let focusSite: WorkBuddyKind | null = (SITES as string[]).includes(String(props.focusKey ?? ""))
    ? (props.focusKey as WorkBuddyKind)
    : null;
  if (focusSite) props.focusKey = null;

  const post = <T,>(path: string, body: any = {}, signal?: AbortSignal, timeoutMs = 30_000) =>
    props.callApi<T>(path, { method: "POST", body: JSON.stringify(body), signal, timeoutMs });

  // ---- visual layer ---------------------------------------------------------
  // The card renders inside the host settings page, so the host's global
  // stylesheet (Tailwind utilities + the custom .glass-card rule) is part of
  // its runtime environment — same as document/props.callApi. Class names
  // below mirror the pre-migration React card EXACTLY (host ui/button,
  // ui/badge and ui/card class lists inlined; no host imports, no React).

  const BUTTON_BASE = "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-semibold ring-offset-background transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 active:scale-95";
  const BUTTON_PRIMARY = "bg-primary text-primary-foreground shadow-lg shadow-primary/20 hover:bg-primary/90 hover:shadow-xl hover:shadow-primary/30";
  const BUTTON_OUTLINE = "border border-input bg-input/50 backdrop-blur-md shadow-sm hover:bg-input/80 hover:border-primary/50 hover:shadow-md hover:text-accent-foreground";
  const BUTTON_DESTRUCTIVE = "border border-destructive/50 text-destructive hover:bg-destructive hover:text-destructive-foreground";
  const BADGE_BASE = "inline-flex items-center rounded-lg border px-2.5 py-0.5 text-[10px] font-bold transition-colors";
  const BADGE_OUTLINE = "border-white/10 text-foreground bg-white/5";
  const BADGE_SECONDARY = "border-white/5 bg-white/5 text-muted-foreground";
  const TOGGLE = "rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors";

  const node = (tag: string, text?: string): HTMLElement => {
    const result = document.createElement(tag);
    if (text !== undefined) result.textContent = text; // Never innerHTML/upstream error text.
    return result;
  };
  const styled = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
    const result = node(tag, text) as HTMLElementTagNameMap[K];
    if (className) result.className = className;
    return result;
  };
  /** Inline copy of the lucide svg markup (paths only; icons ship as code). */
  const icon = (paths: string[], className: string): SVGSVGElement => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    svg.setAttribute("width", "24");
    svg.setAttribute("height", "24");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("class", className);
    for (const d of paths) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      svg.appendChild(path);
    }
    return svg;
  };
  const coinsIcon = (className: string): SVGSVGElement => {
    const svg = icon(["M18.09 10.37A6 6 0 1 1 10.34 18", "M7 6h1v4", "m16.71 13.88.7.71-2.82 2.82"], className);
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", "8"); circle.setAttribute("cy", "8"); circle.setAttribute("r", "6");
    svg.insertBefore(circle, svg.firstChild);
    return svg;
  };
  const shieldCheckIcon = (className: string) => icon([
    "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z",
    "m9 12 2 2 4-4",
  ], className);
  const refreshCwIcon = (className: string) => icon([
    "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8",
    "M21 3v5h-5",
    "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16",
    "M8 16H3v5",
  ], className);
  const xIcon = (className: string) => icon(["M18 6 6 18", "m6 6 12 12"], className);

  const badge = (parent: HTMLElement, text: string, variant: "outline" | "secondary", extra = "", role?: string): HTMLElement => {
    const result = styled("span", `${BADGE_BASE} ${variant === "outline" ? BADGE_OUTLINE : BADGE_SECONDARY} ${extra}`, text);
    if (role) result.setAttribute("role", role);
    parent.append(result);
    return result;
  };
  const button = (parent: HTMLElement, text: string, action: () => void, disabled = false, variant: "primary" | "outline" | "destructive" = "outline", extra = "", iconNode?: SVGSVGElement): HTMLButtonElement => {
    const result = styled("button", `${BUTTON_BASE} ${variant === "primary" ? BUTTON_PRIMARY : variant === "destructive" ? BUTTON_DESTRUCTIVE : BUTTON_OUTLINE} ${extra}`, text) as HTMLButtonElement;
    result.type = "button";
    result.disabled = disabled;
    result.onclick = action;
    if (iconNode) result.prepend(iconNode);
    parent.append(result);
    return result;
  };

  const setSiteError = (site: WorkBuddyKind, key: string | null) => { errors[site] = key; };

  const endBusy = () => {
    release?.(); release = null;
    if (locked) { locked = false; props.onBusy?.(false); }
  };

  const readStatus = async (): Promise<WorkBuddyStatusResponse> => props.callApi<WorkBuddyStatusResponse>("/status", { timeoutMs: 10_000 });

  /**
   * Success tail shared by the mutating actions (settle split): reconcile the
   * managed providers into the host config draft, re-read the per-site status,
   * then show the settled message. Guards drop stale completions. A failed
   * draft reconciliation must not suppress the status refresh or the toast —
   * the mutation already persisted server-side.
   */
  const finish = async (site: WorkBuddyKind, id: number, message: string, opts: { clearUsage?: boolean; dropUsageUid?: string; merge?: (local: any, server: any) => any } = {}) => {
    const { status: updated } = await workBuddySettle(
      () => props.refreshConfig?.(opts.merge ?? mergeWorkBuddyProvider) ?? Promise.resolve(),
      readStatus,
    );
    if (!alive || generation !== id) return;
    status = updated; loadFailed = false; confirm = null;
    if (opts.clearUsage || opts.dropUsageUid) {
      const entries = usage[site];
      if (entries) {
        const next: Record<string, WorkBuddyUsage | null> = {};
        if (opts.clearUsage) usage[site] = next;
        else {
          for (const [uid, value] of Object.entries(entries)) if (uid !== opts.dropUsageUid) next[uid] = value;
          usage[site] = next;
        }
      }
    }
    toast = message;
  };

  const readUsage = async (site: WorkBuddyKind, uid: string) => {
    const id = ++generation;
    setSiteError(site, null);
    props.onBusy?.(true);
    try {
      const payload = await post<any>("/usage", { site, uid });
      if (alive && generation === id) {
        const parsed = parseWorkBuddyUsage(payload);
        usage[site] = { ...(usage[site] || {}), [uid]: parsed };
        rememberUsage(site, uid, parsed);
      }
    } catch {
      if (alive && generation === id) {
        usage[site] = { ...(usage[site] || {}), [uid]: null };
      }
    } finally {
      locked = false;
      props.onBusy?.(false);
      if (alive && generation === id && action?.kind === "usage") { action = null; render(); }
      else if (alive) render();
    }
  };

  // ---- credits auto-read ---------------------------------------------------
  // The page remounts this card on every visit and quota is the first thing
  // people look for, so a fresh mount reads every connected account once
  // without a click. Values live in a session-scoped cache with a TTL: tab
  // switches stay free and the upstream API is not hammered. The per-account
  // button stays as the explicit refresh. Failures are not cached — the next
  // mount (or a manual click) retries.
  let autoUsageStopped = false;
  const autoReadUsage = async (): Promise<void> => {
    if (!alive || props.disabled || loading) return;
    for (const site of SITES as WorkBuddyKind[]) {
      const siteStatus = workBuddySiteStatus(status, site);
      if (siteStatus?.status !== "connected") continue;
      for (const account of siteStatus.accounts) {
        // A user action (mutation or explicit read) takes precedence; stop
        // scheduling new reads, the in-flight one is read-only and harmless.
        if (!alive || autoUsageStopped || props.disabled || locked || loading) return;
        if (usage[site]?.[account.uid] !== undefined) continue;
        const payload = await post<any>("/usage", { site, uid: account.uid }).catch(() => undefined);
        if (!alive) return;
        if (payload === undefined) continue;
        const parsed = parseWorkBuddyUsage(payload);
        usage[site] = { ...(usage[site] || {}), [account.uid]: parsed };
        rememberUsage(site, account.uid, parsed);
        render();
      }
    }
  };

  const run = async (kind: SiteActionKind, site: WorkBuddyKind, argument?: string) => {
    if (!alive || locked || loading || props.disabled) return;
    const siteStatus = workBuddySiteStatus(status, site);
    if (kind === "usage") {
      if (!argument || siteStatus?.status !== "connected") return;
      // Same one-action-at-a-time mutex as mutations; read-only (no lease).
      locked = true;
      action = { kind, site };
      render();
      return void readUsage(site, argument);
    }
    if (props.acquireManagement) {
      release = props.acquireManagement();
      if (!release) { setSiteError(site, "busy"); render(); return; }
    }
    locked = true;
    const id = ++generation;
    props.onBusy?.(true);
    action = { kind, site, model: argument };
    setSiteError(site, null);
    toast = null;
    render();
    try {
      if (kind === "login") {
        const session = createWorkBuddyLogin({
          startWorkBuddyLogin: async (s) => post<WorkBuddyLoginStartResponse>("/login/start", { site: s }),
          pollWorkBuddyLogin: async (s, loginId, signal) => {
            try { return await post<any>("/login/poll", { site: s, loginId }, signal); }
            catch (error: any) {
              // Timeout classification is generic in the host; the plugin owns
              // its sequential-login retry sentinel. Cancellation never retries.
              if (!signal.aborted && error?.timedOut === true) {
                throw Object.assign(new Error("Login poll timed out"), { reason: WORKBUDDY_POLL_TIMEOUT });
              }
              throw error;
            }
          },
          cancelWorkBuddyLogin: async (s, loginId) => post<{ success: boolean }>("/login/cancel", { site: s, loginId }),
        }, site, value => {
          if (!alive || generation !== id) { void session.cancel().catch(() => {}); return; }
          login = value;
          render();
        });
        loginSession = session;
        const connected = await session.done;
        loginSession = null;
        if (!alive || generation !== id) return;
        login = null;
        if (!connected) return; // cancelled or superseded by a newer action
        if (!isWorkBuddyConnected(connected as WorkBuddyMutationResponse)) { setSiteError(site, "models_fetch_failed"); return; }
        const outcome = workBuddyLoginOutcome(connected as any);
        await finish(site, id, t(outcome.key, outcome.values), { clearUsage: true });
        return;
      }
      if (kind === "sync") {
        const result = await post<WorkBuddyMutationResponse>("/sync", { site }, undefined, 60_000);
        // A mutation that commits after the card was disposed still reconciles
        // and re-reads status: only the visual settlement (inside finish) is
        // skipped when !alive or superseded. Failure notes stay generation-
        // guarded so a superseded action cannot clobber the newer state.
        if (!result.success) { if (generation === id) setSiteError(site, workBuddyErrorKey(result)); return; }
        if (!isWorkBuddyConnected(result)) { if (generation === id) setSiteError(site, "models_fetch_failed"); return; }
        await finish(site, id, t("synced", { count: result.models?.length ?? 0 }), { clearUsage: true });
        return;
      }
      if (kind === "hide") {
        const model = argument ?? "";
        if (!model) return;
        const hidden = await post<any>("/models/hide", { site, model });
        if (!hidden || hidden.ok !== true) { if (generation === id) setSiteError(site, "request_failed"); return; }
        // clearedRefs are Router PATH LABELS for display only — never parsed as
        // provider/model references. Removed refs drive the draft cleanup.
        const paths = sanitizeWorkBuddyRouterPaths(hidden.clearedRefs)
          .map(pathLabel => labelWorkBuddyRouterPath(pathLabel, {
            default: t("router_path.default"),
            scenario: name => t(`router.${name}`),
            modelAlias: name => t("router_path.model_alias", { name }),
            familyDefault: family => t("router_path.family_default", { family }),
            customRoute: name => t("router_path.custom_route", { name }),
          }))
          .filter((pathLabel): pathLabel is string => pathLabel !== null);
        const refs = sanitizeWorkBuddyModelRefs(hidden.removedModelRefs);
        const removedRefs = refs.length > 0 ? refs : sanitizeWorkBuddyModelRefs([`${site},${model}`]);
        const toastRefs = paths.join(", ");
        await finish(site, id, toastRefs
          ? `${t("hidden_toast", { model })} ${t("cleared_refs", { refs: toastRefs })}`
          : t("hidden_toast", { model }),
          { merge: (local, server) => mergeWorkBuddyHiddenRefs(local, server, removedRefs, hidden.defaultFallback) });
        return;
      }
      if (kind === "restore") {
        const hiddenCount = siteStatus?.hiddenModels.length ?? 0;
        const restored = await post<any>("/models/restore", argument ? { site, model: argument } : { site });
        if (!restored || restored.ok !== true) { if (generation === id) setSiteError(site, "request_failed"); return; }
        await finish(site, id, argument
          ? t("restored_toast", { model: argument })
          : t("restored_all_toast", { count: hiddenCount }));
        return;
      }
      const result = kind === "switch" ? await post<WorkBuddyMutationResponse>("/account/switch", { site, uid: argument ?? "" })
        : kind === "remove" ? await post<WorkBuddyMutationResponse>("/account/remove", { site, uid: argument ?? "" })
        : await post<WorkBuddyMutationResponse>("/disconnect", { site });
      if (!result.success) { if (generation === id) setSiteError(site, workBuddyErrorKey(result)); return; }
      const message = kind === "disconnect" ? t("disconnected")
        : kind === "switch" ? t("account_switched")
        : t("account_removed", { uid: maskWorkBuddyUid(argument ?? null) });
      await finish(site, id, message, {
        clearUsage: kind === "disconnect",
        dropUsageUid: kind === "remove" ? argument : undefined,
      });
    } catch (error) {
      if (alive && generation === id) setSiteError(site, workBuddyErrorKey(error));
    } finally {
      endBusy();
      loginSession = null;
      if (alive && generation === id) {
        action = null; login = null; cancelling = false;
        render();
      }
    }
  };

  // ---- rendering ----------------------------------------------------------

  const renderSiteCard = (site: WorkBuddyKind): HTMLElement => {
    const siteStatus = workBuddySiteStatus(status, site);
    const state = loading ? "loading" : loadFailed ? "error" : workBuddyStateKey(siteStatus);
    const models = siteStatus?.models || [];
    const accounts = siteStatus?.accounts || [];
    const hiddenModels = siteStatus?.hiddenModels || [];
    const connected = siteStatus?.status === "connected";
    const canDisconnect = Boolean(siteStatus && (siteStatus.status !== "not_connected" || models.length > 0 || accounts.length > 0));
    const readingUsage = action?.kind === "usage" && action.site === site;
    const imageUnsupported = workBuddyImagesUnsupportedModels(models, siteStatus?.imagesUnsupportedModels);
    const visibleError = workBuddyVisibleErrorKey(errors[site] ?? null, siteStatus);
    const busy = loading || action !== null;
    const disabled = busy || props.disabled;
    const pendingHide = (model: string) => action?.kind === "hide" && action.site === site && action.model === model;

    const card = styled("div", "glass-card rounded-2xl overflow-hidden mb-4");
    card.dataset.testid = `workbuddy-card-${site}`;
    card.setAttribute("role", "group");
    if (site === focusSite) {
      // One-shot: consume the demand at first delivery so the post-status
      // re-render (same synchronous mount) never scrolls again.
      focusSite = null;
      queueMicrotask(() => { card.scrollIntoView?.({ block: "start" }); card.focus?.(); });
    }
    card.setAttribute("aria-busy", String(busy));
    card.tabIndex = -1;

    const layout = styled("div", "flex flex-col gap-4 p-5 sm:flex-row sm:items-start sm:justify-between");
    const body = styled("div", "min-w-0 flex-1 space-y-3");

    const header = styled("div", "flex flex-wrap items-center gap-2");
    header.append(
      shieldCheckIcon("h-5 w-5 shrink-0 text-primary"),
      styled("p", "text-lg font-bold tracking-tight text-foreground", t(`site.${site}`)),
    );
    badge(header, t("builtin"), "outline");
    if (siteStatus && siteStatus.status !== "not_connected") {
      badge(header, t(`kind.${site}`), "outline", "border-primary/40 text-primary");
    }
    badge(header, t(`status.${state}`), "secondary", "", "status");
    body.append(header);
    body.append(styled("p", "max-w-md truncate text-xs font-medium text-muted-foreground/60",
      t("managed_provider", { name: siteStatus?.providerName || site })));

    if (accounts.length > 0) {
      const pool = styled("div", "space-y-2");
      pool.setAttribute("aria-label", t("accounts_label", { count: accounts.length }));
      for (const account of accounts as WorkBuddyAccountSummary[]) {
        const cooling = workBuddyAccountCooling(account);
        const restricted = workBuddyAccountRestricted(account);
        const usageLine = usage[site]?.[account.uid];
        const row = styled("div", "rounded-lg border border-white/5 bg-white/5 px-3 py-2");
        const line = styled("div", "flex flex-wrap items-center gap-2");
        const dot = styled("span", `h-2 w-2 shrink-0 rounded-full ${account.active ? "bg-green-500" : "bg-muted-foreground/30"}`);
        dot.setAttribute("aria-hidden", "true");
        line.append(dot);
        line.append(styled("span", "sr-only", t(account.active ? "active_account" : "inactive_account")));
        line.append(styled("span", "font-mono text-xs text-foreground", maskWorkBuddyUid(account.uid)));
        if (account.displayName) {
          line.append(styled("span", "max-w-[10rem] truncate text-xs text-muted-foreground", account.displayName));
        }
        badge(line, t(`source_badge.${account.source}`), "outline", "px-1.5 py-0 text-[10px]");
        if (account.active) {
          badge(line, t("active_badge"), "outline", "border-primary/40 px-1.5 py-0 text-[10px] text-primary");
        }
        if (cooling !== null) {
          line.append(styled("span", "text-[11px] font-medium text-yellow-600", t("cooling_until", { time: formatWorkBuddyClock(cooling, locale) })));
        }
        if (restricted !== null) {
          line.append(styled("span", "text-[11px] font-medium text-red-500", t("restricted_until", { time: formatWorkBuddyClock(restricted, locale) })));
        }
        row.append(line);
        const accountActions = styled("div", "mt-2 flex flex-wrap items-center gap-2");
        button(accountActions, t("credits.action"), () => void run("usage", site, account.uid), disabled, "outline", "h-7 px-2 text-[11px]",
          coinsIcon(`mr-1 h-3 w-3 ${readingUsage ? "animate-pulse" : ""}`));
        button(accountActions, t("set_active"), () => void run("switch", site, account.uid), disabled || account.active, "outline", "h-7 px-2 text-[11px]");
        button(accountActions, t("remove"), () => { confirm = { kind: "remove", site, uid: account.uid }; render(); }, disabled, "outline", "h-7 px-2 text-[11px] text-red-500");
        row.append(accountActions);
        if (usageLine !== undefined && usageLine !== null) {
          row.append(styled("p", "mt-1 text-[11px] text-muted-foreground", t("credits.line", { plan: usageLine.plan, used: usageLine.used, limit: usageLine.limit })));
        } else if (usageLine === null) {
          // A failed credit read is non-critical: hide the value behind the
          // action label instead of rendering a raw quota error (baseline parity).
          row.append(styled("p", "mt-1 text-[11px] text-muted-foreground", t("credits.action")));
        }
        pool.append(row);
      }
      body.append(pool);
    }

    if (models.length > 0) {
      const chips = styled("div", "flex flex-wrap gap-2 pt-1");
      for (const model of models) {
        const chip = styled("span", "inline-flex max-w-full items-center gap-1 break-all whitespace-normal rounded-lg border border-white/5 bg-white/5 px-2 py-0.5 text-[10px] font-bold text-muted-foreground", model);
        const hide = styled("button", "rounded p-0.5 text-muted-foreground/60 transition-colors hover:bg-white/10 hover:text-foreground disabled:opacity-40") as HTMLButtonElement;
        hide.type = "button";
        hide.disabled = disabled;
        hide.setAttribute("aria-label", t("hide_model", { model }));
        hide.setAttribute("aria-busy", String(pendingHide(model)));
        hide.append(xIcon("h-3 w-3"));
        hide.onclick = () => void run("hide", site, model);
        chip.append(hide);
        chips.append(chip);
      }
      body.append(chips);
    }

    if (hiddenModels.length > 0) {
      const details = styled("details", "max-w-md text-xs text-muted-foreground");
      details.append(styled("summary", "cursor-pointer select-none font-medium", t("hidden_models", { count: hiddenModels.length })));
      const list = styled("ul", "mt-2 space-y-1");
      for (const model of hiddenModels) {
        const item = styled("li", "flex items-center justify-between gap-2");
        item.append(styled("span", "break-all font-mono", model));
        button(item, t("restore"), () => void run("restore", site, model), disabled, "outline", "h-6 shrink-0 px-2 text-[11px]");
        list.append(item);
      }
      details.append(list);
      button(details, t("restore_all"), () => void run("restore", site), disabled, "outline", "mt-2 h-7 px-2 text-[11px]");
      body.append(details);
    }

    if (imageUnsupported.length > 0) {
      const note = styled("p", "max-w-md rounded-lg border border-yellow-500/25 bg-yellow-500/10 px-3 py-2 text-[11px] font-medium text-yellow-600",
        t("images_unsupported", { models: imageUnsupported.join(", ") }));
      note.setAttribute("role", "note");
      body.append(note);
    }
    if (!loading && siteStatus && !["connected", "not_connected"].includes(siteStatus.status)) {
      body.append(styled("p", "text-xs text-yellow-600", t(`help.${siteStatus.status}`)));
    }
    if (visibleError) {
      const alert = styled("p", "max-w-md rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-[11px] font-medium text-red-500",
        t(`errors.${visibleError}`) || t("errors.request_failed"));
      alert.setAttribute("role", "alert");
      body.append(alert);
    }
    if (login && login.site === site) {
      const box = styled("div", "max-w-md space-y-1.5 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-xs");
      box.setAttribute("role", "status");
      box.append(styled("p", "font-medium", t("login_pending")));
      if (!cancelling) {
        const link = styled("a", "block break-all text-primary underline", t("open_login", { site: t(`site.${login.site}`) })) as HTMLAnchorElement;
        link.href = login.url; link.target = "_blank"; link.rel = "noopener noreferrer";
        box.append(link);
      }
      button(box, cancelling ? t("working") : t("app.cancel"), () => {
        cancelling = true;
        void loginSession?.cancel().catch(() => { if (alive) { setSiteError(site, "request_failed"); render(); } });
      }, cancelling, "outline", "h-7 px-2 text-xs");
      body.append(box);
    }

    const about = styled("details", "max-w-md text-xs text-muted-foreground");
    about.append(styled("summary", "cursor-pointer select-none font-medium", t("about")));
    const aboutBody = styled("div", "mt-2 space-y-1 leading-relaxed");
    for (const key of ["description", "server_host", "privacy_selected", "backup_warning", "browser_source", "routing_note", "hidden_note"]) {
      aboutBody.append(styled("p", "", key === "privacy_selected" ? t("privacy", { site: siteStatus?.site || t("privacy_selected") }) : t(key)));
    }
    if (siteStatus && siteStatus.status !== "not_connected") {
      aboutBody.append(styled("p", "", t(siteStatus.source === "browser" ? "source_browser" : siteStatus.source === "desktop" ? "source_desktop" : "source_unknown")));
      if (siteStatus.renewalMode === "desktop") aboutBody.append(styled("p", "", t("renewal_desktop")));
      if (siteStatus.renewalMode === "browser") aboutBody.append(styled("p", "", t("renewal_browser")));
    }
    about.append(aboutBody);
    body.append(about);
    if (props.disabled) body.append(styled("p", "text-xs text-muted-foreground", t("other_edit")));

    // Right action column (baseline kept a site switcher there too).
    const actions = styled("div", "flex shrink-0 flex-col gap-2 sm:w-[210px]");
    for (const other of SITES) {
      if (other === site) continue;
      const toggle = styled("button", `${TOGGLE} bg-white/5 text-muted-foreground hover:bg-white/10 hover:text-foreground`, t(`site.${other}`)) as HTMLButtonElement;
      toggle.type = "button";
      toggle.setAttribute("aria-label", t(`site.${other}`));
      toggle.onclick = () => {
        const target = el.querySelector?.(`[data-testid="workbuddy-card-${other}"]`) as HTMLElement | null;
        if (target) { target.scrollIntoView?.({ block: "start" }); target.focus?.(); }
      };
      actions.append(toggle);
    }
    button(actions, action?.kind === "login" && action.site === site ? t("working") : connected ? t("add_account") : t("browser_login"),
      () => void run("login", site), disabled, "primary", "h-8 w-full text-xs");
    button(actions, t("sync"), () => void run("sync", site), disabled || !connected, "outline", "h-8 w-full text-xs",
      refreshCwIcon(`mr-1 h-3.5 w-3.5 ${action?.kind === "sync" && action.site === site ? "animate-spin" : ""}`));
    button(actions, t("disconnect"), () => { confirm = { kind: "disconnect", site }; render(); }, disabled || !canDisconnect, "outline", "h-8 w-full text-xs");

    layout.append(body, actions);
    card.append(layout);
    return card;
  };

  const render = () => {
    if (!alive) return;
    el.replaceChildren();
    el.dataset.testid = "workbuddy-card";
    el.setAttribute("aria-busy", String(loading || action !== null));
    for (const site of SITES) el.append(renderSiteCard(site));
    if (toast) {
      const message = styled("p", "flex max-w-md items-center gap-2 rounded-lg border border-green-500/25 bg-green-500/10 px-3 py-2 text-xs font-medium text-green-600", toast);
      message.setAttribute("role", "status");
      el.append(message);
    }
    if (confirm) {
      const panel = styled("div", "glass-card mt-3 max-w-lg space-y-3 rounded-2xl p-5");
      panel.setAttribute("role", "dialog");
      panel.append(
        styled("h3", "text-sm font-semibold tracking-tight text-foreground", confirm.kind === "remove" ? t("account_remove_title") : t("disconnect_title")),
        styled("p", "text-xs text-muted-foreground", confirm.kind === "remove" ? t("account_remove_warning") : t("disconnect_warning")),
      );
      const err = errors[confirm.site] ?? null;
      if (err && action) { const alert = styled("p", "text-sm text-red-600", t(`errors.${err}`)); alert.setAttribute("role", "alert"); panel.append(alert); }
      const footer = styled("div", "flex justify-end gap-2");
      button(footer, t("app.cancel"), () => { if (!action) { confirm = null; render(); } }, !!action, "outline", "h-8 text-xs");
      button(footer, action ? t("working") : confirm.kind === "remove" ? t("account_remove_confirm") : t("disconnect"),
        () => { if (confirm) void run(confirm.kind === "remove" ? "remove" : "disconnect", confirm.site, confirm.kind === "remove" ? confirm.uid : undefined); },
        loading || action !== null || props.disabled, "destructive", "h-8 text-xs");
      panel.append(footer);
      el.append(panel);
    }
  };

  mounted.set(el, () => {
    alive = false;
    autoUsageStopped = true;
    confirm = null;
    unsubscribeHost?.(); unsubscribeHost = null;
    void loginSession?.cancel().catch(() => {});
    // Visual disposal only. The shared management lease deliberately stays
    // held while a deferred mutation (and its config reconciliation) finishes:
    // run()'s finally releases it. Releasing here would let a full-config save
    // race the still-pending managed mutation after navigation/unmount.
    locked = false;
    el.replaceChildren();
  });
  // Host state changes (e.g. the page Save gate) re-render the card in place —
  // never via a remount, which would cancel in-flight actions.
  unsubscribeHost = props.onHostChange?.(() => { if (alive) render(); }) ?? null;
  render();
  // Only local status on mount. Never start a login, sync models or poll here.
  readStatus().then(value => {
    if (alive) {
      status = value; loadFailed = false;
      // Seed recently-read quota values so the card shows them immediately;
      // the auto-read below only fills what the cache cannot provide.
      for (const site of SITES as WorkBuddyKind[]) {
        const siteStatus = workBuddySiteStatus(status, site);
        if (siteStatus?.status !== "connected") continue;
        for (const account of siteStatus.accounts) {
          const cached = freshUsage(site, account.uid);
          if (cached !== undefined) usage[site] = { ...(usage[site] || {}), [account.uid]: cached };
        }
      }
    }
  }).catch(() => {
    if (alive) {
      loadFailed = true;
      errors.workbuddy = "request_failed";
      errors["workbuddy-ai"] = "request_failed";
    }
  }).finally(() => {
    if (alive) { loading = false; render(); void autoReadUsage(); }
  });
}

export function unmount(el: HTMLElement): void {
  mounted.get(el)?.(); mounted.delete(el);
}
export default { mount, unmount };
