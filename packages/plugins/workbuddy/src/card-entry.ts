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
  let toast: string | null = null;
  let release: (() => void) | null = null;
  let unsubscribeHost: (() => void) | null = null;

  const post = <T,>(path: string, body: any = {}, signal?: AbortSignal, timeoutMs = 30_000) =>
    props.callApi<T>(path, { method: "POST", body: JSON.stringify(body), signal, timeoutMs });

  const node = (tag: string, text?: string): HTMLElement => {
    const result = document.createElement(tag);
    if (text !== undefined) result.textContent = text; // Never innerHTML/upstream error text.
    return result;
  };
  const button = (parent: HTMLElement, text: string, action: () => void, disabled = false, style = ""): HTMLButtonElement => {
    const result = node("button", text) as HTMLButtonElement;
    result.type = "button";
    result.disabled = disabled;
    result.onclick = action;
    result.style.cssText = `padding:4px 10px;border:1px solid currentColor;border-radius:6px;margin:2px;font:inherit;cursor:pointer;font-size:11px;${style}`;
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
        usage[site] = { ...(usage[site] || {}), [uid]: parseWorkBuddyUsage(payload) };
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

    const card = node("div");
    (card as HTMLElement).dataset.testid = `workbuddy-card-${site}`;
    card.setAttribute("role", "group");
    card.setAttribute("aria-busy", String(busy));
    card.style.cssText = "border:1px solid #8886;border-radius:12px;padding:20px;margin-bottom:16px;font-size:14px";
    card.tabIndex = -1;

    const header = node("div");
    header.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;align-items:center";
    const title = node("h2", `${t(`site.${site}`)} · ${t("builtin")}`);
    title.style.cssText = "margin:0;font-size:16px";
    header.append(title, node("span", t(`kind.${site}`)), node("span", t(`status.${state}`)));
    card.append(header);
    card.append(node("p", t("managed_provider", { name: siteStatus?.providerName || site })));

    if (accounts.length > 0) {
      for (const account of accounts as WorkBuddyAccountSummary[]) {
        const cooling = workBuddyAccountCooling(account);
        const restricted = workBuddyAccountRestricted(account);
        const usageLine = usage[site]?.[account.uid];
        const row = node("div");
        row.style.cssText = "border:1px solid #8883;border-radius:8px;padding:8px;margin:6px 0";
        const line = node("div");
        line.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;align-items:center";
        line.append(
          node("span", `${account.active ? "●" : "○"} ${maskWorkBuddyUid(account.uid)}`),
          account.displayName ? node("span", account.displayName) : node("span"),
          node("span", t(`source_badge.${account.source}`)),
          account.active ? node("span", t("active_badge")) : node("span"),
          cooling !== null ? node("span", t("cooling_until", { time: formatWorkBuddyClock(cooling, locale) })) : node("span"),
          restricted !== null ? node("span", t("restricted_until", { time: formatWorkBuddyClock(restricted, locale) })) : node("span"),
        );
        row.append(line);
        const actions = node("div");
        button(actions, t("credits.action"), () => void run("usage", site, account.uid), disabled);
        button(actions, t("set_active"), () => void run("switch", site, account.uid), disabled || account.active);
        button(actions, t("remove"), () => { confirm = { kind: "remove", site, uid: account.uid }; render(); }, disabled, "color:#ef4444");
        row.append(actions);
        if (usageLine !== undefined && usageLine !== null) {
          row.append(node("p", t("credits.line", { plan: usageLine.plan, used: usageLine.used, limit: usageLine.limit })));
        } else if (usageLine === null) {
          row.append(node("p", t("credits.action")));
        }
        card.append(row);
      }
    }

    if (models.length > 0) {
      const chips = node("div");
      chips.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;padding-top:4px";
      for (const model of models) {
        const chip = node("span", model);
        chip.style.cssText = "border:1px solid #8883;border-radius:6px;padding:1px 6px;font-size:10px;font-weight:700;display:inline-flex;gap:3px;align-items:center";
        const hide = node("button", "×") as HTMLButtonElement;
        hide.type = "button";
        hide.disabled = disabled;
        hide.setAttribute("aria-label", t("hide_model", { model }));
        hide.style.cssText = "border:0;background:none;color:inherit;cursor:pointer;font-size:11px;padding:0 2px";
        hide.onclick = () => void run("hide", site, model);
        chip.append(hide);
        chips.append(chip);
      }
      card.append(chips);
    }

    if (hiddenModels.length > 0) {
      const details = node("details");
      details.append(node("summary", t("hidden_models", { count: hiddenModels.length })));
      for (const model of hiddenModels) {
        const line = node("div");
        line.append(node("span", model), button(line, t("restore"), () => void run("restore", site, model), disabled));
        details.append(line);
      }
      button(details, t("restore_all"), () => void run("restore", site), disabled);
      card.append(details);
    }

    if (imageUnsupported.length > 0) {
      const note = node("p", t("images_unsupported", { models: imageUnsupported.join(", ") }));
      note.setAttribute("role", "note");
      card.append(note);
    }
    if (!loading && siteStatus && !["connected", "not_connected"].includes(siteStatus.status)) {
      card.append(node("p", t(`help.${siteStatus.status}`)));
    }
    if (visibleError) {
      const alert = node("p", t(`errors.${visibleError}`) || t("errors.request_failed"));
      alert.setAttribute("role", "alert");
      card.append(alert);
    }
    if (login && login.site === site) {
      const box = node("div");
      box.setAttribute("role", "status");
      box.append(node("p", t("login_pending")));
      if (!cancelling) {
        const link = node("a", t("open_login", { site: t(`site.${login.site}`) })) as HTMLAnchorElement;
        link.href = login.url; link.target = "_blank"; link.rel = "noopener noreferrer";
        box.append(link);
      }
      button(box, cancelling ? t("working") : t("app.cancel"), () => {
        cancelling = true;
        void loginSession?.cancel().catch(() => { if (alive) { setSiteError(site, "request_failed"); render(); } });
      }, cancelling);
      card.append(box);
    }

    const about = node("details");
    about.append(node("summary", t("about")));
    for (const key of ["description", "server_host", "privacy_selected", "backup_warning", "browser_source", "routing_note", "hidden_note"]) {
      about.append(node("p", key === "privacy_selected" ? t("privacy", { site: siteStatus?.site || t("privacy_selected") }) : t(key)));
    }
    if (siteStatus && siteStatus.status !== "not_connected") {
      about.append(node("p", t(siteStatus.source === "browser" ? "source_browser" : siteStatus.source === "desktop" ? "source_desktop" : "source_unknown")));
      if (siteStatus.renewalMode === "desktop") about.append(node("p", t("renewal_desktop")));
      if (siteStatus.renewalMode === "browser") about.append(node("p", t("renewal_browser")));
    }
    card.append(about);
    if (props.disabled) card.append(node("p", t("other_edit")));

    const actions = node("div");
    actions.style.cssText = "display:flex;flex-direction:column;gap:6px;margin-top:8px";
    button(actions, action?.kind === "login" && action.site === site ? t("working") : connected ? t("add_account") : t("browser_login"),
      () => void run("login", site), disabled);
    button(actions, t("sync"), () => void run("sync", site), disabled || !connected);
    button(actions, t("disconnect"), () => { confirm = { kind: "disconnect", site }; render(); }, disabled || !canDisconnect);
    card.append(actions);
    return card;
  };

  const render = () => {
    if (!alive) return;
    el.replaceChildren();
    el.style.cssText = "font-size:14px";
    el.dataset.testid = "workbuddy-card";
    el.setAttribute("aria-busy", String(loading || action !== null));
    for (const site of SITES) el.append(renderSiteCard(site));
    if (toast) { const message = node("p", toast); message.setAttribute("role", "status"); el.append(message); }
    if (confirm) {
      const panel = node("div");
      panel.setAttribute("role", "dialog");
      panel.style.cssText = "padding:16px;margin-top:12px;border:2px solid #b45309;border-radius:8px";
      panel.append(
        node("h3", confirm.kind === "remove" ? t("account_remove_title") : t("disconnect_title")),
        node("p", confirm.kind === "remove" ? t("account_remove_warning") : t("disconnect_warning")),
      );
      const err = errors[confirm.site] ?? null;
      if (err && action) { const alert = node("p", t(`errors.${err}`)); alert.setAttribute("role", "alert"); panel.append(alert); }
      button(panel, t("app.cancel"), () => { if (!action) { confirm = null; render(); } }, !!action);
      button(panel, action ? t("working") : confirm.kind === "remove" ? t("account_remove_confirm") : t("disconnect"),
        () => { if (confirm) void run(confirm.kind === "remove" ? "remove" : "disconnect", confirm.site, confirm.kind === "remove" ? confirm.uid : undefined); },
        loading || action !== null || props.disabled);
      el.append(panel);
    }
  };

  mounted.set(el, () => {
    alive = false;
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
    if (alive) { status = value; loadFailed = false; }
  }).catch(() => {
    if (alive) {
      loadFailed = true;
      errors.workbuddy = "request_failed";
      errors["workbuddy-ai"] = "request_failed";
    }
  }).finally(() => {
    if (alive) { loading = false; render(); }
  });
}

export function unmount(el: HTMLElement): void {
  mounted.get(el)?.(); mounted.delete(el);
}
export default { mount, unmount };
