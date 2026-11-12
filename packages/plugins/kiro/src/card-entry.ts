/**
 * Self-contained Kiro DOM card: no React, no host runtime imports, no direct
 * fetch, no auth-service code. Every state/network/config interaction flows
 * through the host card capabilities (PluginCardMountProps, type-only) and
 * every rendered dynamic string crosses via textContent — never innerHTML.
 *
 * Visual contract: the card renders inside the host settings page using the
 * host stylesheet's utilities. Model chips, the hidden-model details/summary
 * list, per-model X buttons, dl/dt/dd count row, partial-completion notes and
 * the button/badge hierarchy are aligned with the WorkBuddy/Qoder/Codex
 * subscription cards.
 *
 * Lifecycle: one explicit user action at a time under the shared management
 * lease (login/sync/disconnect/remove/hide/restore), per-account quota reads
 * behind a valid-only TTL session cache, host disabled flips re-render in
 * place (never a remount), unmount cancels the login session, and a deferred
 * mutation keeps the lease until config reconciliation + status re-read
 * settle. Hiding a model additionally clears dangling Router references in
 * the local config draft (see ./router, Codex 1.0.9 parity).
 */
import type { PluginCardMountProps } from "../../../ui/src/utils/plugin-card";
import type {
  KiroAccountView, KiroLoginMethod, KiroLoginStartView, KiroStatusView, KiroUsageView, KiroUsageWindowView,
} from "./card-types";
import {
  KIRO_DEFAULT_REGION, KIRO_METHODS, KIRO_PROVIDER_NAME,
  clearKiroUsageCache, formatKiroClock, freshKiroUsage, isValidKiroCallbackUrl,
  isValidKiroIdcInput, kiroActiveAccount, kiroCardErrorKey, kiroConnected,
  kiroResetTime, kiroStateKey, mergeKiroCardProvider, parseKiroLoginPoll,
  parseKiroStatus, parseKiroUsage, readKiroUsageStore, rememberKiroUsage,
  writeKiroUsageStore,
} from "./card-types";
import { createKiroLogin, KIRO_POLL_TIMEOUT } from "./card-login";
import { clearKiroRouterRefs } from "./router";
import { kiroLocales } from "./locales";

type SiteActionKind =
  | "login" | "sync" | "disconnect" | "remove"
  | "usage" | "hide" | "restore";
interface SiteAction { kind: SiteActionKind; account?: string; model?: string }
type ConfirmRequest = { kind: "disconnect" } | { kind: "remove"; account: string };
type UsagePhase = "idle" | "reading" | "ready" | "unavailable";

const mounted = new WeakMap<HTMLElement, () => void>();

export function mount(el: HTMLElement, props: PluginCardMountProps): void {
  unmount(el);
  const locale = props.locale.toLowerCase().startsWith("zh") ? "zh" : "en";
  const bundle = (props.locales?.[locale]?.kiro ?? kiroLocales[locale].kiro) as Record<string, any>;
  const t = (key: string, vars: Record<string, unknown> = {}): string => {
    const text = key.split(".").reduce<any>((obj, k) => obj?.[k], bundle);
    return (typeof text === "string" ? text : key).replace(/\{\{(\w+)\}\}/g, (_, name) => String(vars[name] ?? ""));
  };
  const errorText = (key: string | null | undefined): string => {
    if (key) {
      const text = key === "kiro_callback_ports_busy" ? t(key) : t(`errors.${key}`);
      // A lookup miss renders the key itself — fall back to the generic copy.
      if (text !== `errors.${key}` && text !== key) return text;
    }
    return t("errors.request_failed");
  };
  /** Stable localised identity label for an account row, e.g. "user@x.com (Google)". */
  const sourceLabel = (account: KiroAccountView): string => t(`source_${account.uid}`) === `source_${account.uid}`
    ? t("source_unknown") : t(`source_${account.uid}`);
  const accountName = (account: KiroAccountView): string =>
    account.email ? `${account.email} (${sourceLabel(account)})` : account.accountId;

  let alive = true;
  let loading = true;
  let loadFailed = false;
  let status: KiroStatusView | null = null;
  let locked = false;            // one explicit action at a time (incl. read-only usage)
  let generation = 0;
  let action: SiteAction | null = null;
  let errorKey: string | null = null;
  let toast: string | null = null;
  let reconcileFailed = false;
  let confirm: ConfirmRequest | null = null;

  // Login form draft (selector method + IDC inputs survive re-renders).
  let loginMethod: KiroLoginMethod = "portal";
  let idcStartUrl = "";
  let idcRegion = KIRO_DEFAULT_REGION;
  let login: KiroLoginStartView | null = null;
  let cancelling = false;
  let pasteField: HTMLInputElement | null = null;
  let pasteDraft = "";
  let session: ReturnType<typeof createKiroLogin> | null = null;

  // Per-account quota state (id -> view/phase).
  const usage = new Map<string, { phase: UsagePhase; value: KiroUsageView | null; at: number | null }>();
  const usageStore = readKiroUsageStore();
  let release: (() => void) | null = null;
  let unsubscribeHost: (() => void) | null = null;
  let autoUsageStopped = false;
  let focusPending = props.focusKey === KIRO_PROVIDER_NAME;
  if (focusPending) props.focusKey = null;

  const post = <T,>(path: string, body: unknown = {}, signal?: AbortSignal, timeoutMs = 30_000): Promise<T> =>
    props.callApi<T>(path, { method: "POST", body: JSON.stringify(body), signal, timeoutMs });

  // ---- visual layer (host stylesheet vocabulary only) ----------------------
  const BUTTON_BASE = "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-semibold ring-offset-background transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 active:scale-95";
  const BUTTON_PRIMARY = "bg-primary text-primary-foreground shadow-lg shadow-primary/20 hover:bg-primary/90 hover:shadow-xl hover:shadow-primary/30";
  const BUTTON_OUTLINE = "border border-input bg-input/50 backdrop-blur-md shadow-sm hover:bg-input/80 hover:border-primary/50 hover:shadow-md hover:text-accent-foreground";
  const BUTTON_DESTRUCTIVE = "border border-destructive/50 text-destructive hover:bg-destructive hover:text-destructive-foreground";
  const BADGE_BASE = "inline-flex items-center rounded-lg border px-2.5 py-0.5 text-[10px] font-bold transition-colors";
  const BADGE_OUTLINE = "border-white/10 text-foreground bg-white/5";
  const BADGE_SECONDARY = "border-white/5 bg-white/5 text-muted-foreground";
  const CHIP = "inline-flex max-w-full items-center gap-1 break-all whitespace-normal rounded-lg border border-white/5 bg-white/5 px-2 py-0.5 text-[10px] font-bold text-muted-foreground";
  const CHIP_HIDE = "rounded p-0.5 text-muted-foreground/60 transition-colors hover:bg-white/10 hover:text-foreground disabled:opacity-40";

  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => {
    const result = document.createElement(tag);
    if (text !== undefined) result.textContent = text; // Never innerHTML / upstream text.
    return result;
  };
  const styled = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
    const result = node(tag, text);
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
  const plugIcon = (className: string) => icon(["M12 22v-5", "M9 8V2", "M15 8V2", "M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"], className);
  const coinsIcon = (className: string) => {
    const svg = icon(["M18.09 10.37A6 6 0 1 1 10.34 18", "M7 6h1v4", "m16.71 13.88.7.71-2.82 2.82"], className);
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", "8"); circle.setAttribute("cy", "8"); circle.setAttribute("r", "6");
    svg.insertBefore(circle, svg.firstChild);
    return svg;
  };
  const xIcon = (className: string) => icon(["M18 6 6 18", "m6 6 12 12"], className);

  const badge = (parent: HTMLElement, text: string, variant: "outline" | "secondary", extra = "", role?: string): HTMLElement => {
    const result = styled("span", `${BADGE_BASE} ${variant === "outline" ? BADGE_OUTLINE : BADGE_SECONDARY} ${extra}`, text);
    if (role) result.setAttribute("role", role);
    parent.append(result);
    return result;
  };
  const button = (parent: HTMLElement, text: string, onClick: () => void, disabled = false,
    variant: "primary" | "outline" | "destructive" = "outline", extra = "", iconNode?: SVGSVGElement): HTMLButtonElement => {
    const result = styled("button", `${BUTTON_BASE} ${variant === "primary" ? BUTTON_PRIMARY : variant === "destructive" ? BUTTON_DESTRUCTIVE : BUTTON_OUTLINE} ${extra}`, text) as HTMLButtonElement;
    result.type = "button";
    result.disabled = disabled;
    result.onclick = onClick;
    if (iconNode) result.prepend(iconNode);
    parent.append(result);
    return result;
  };
  const errorAlert = (text: string): HTMLElement => {
    const alert = styled("p", "max-w-md rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-[11px] font-medium text-red-500", text);
    alert.setAttribute("role", "alert");
    return alert;
  };

  const endBusy = () => {
    release?.(); release = null;
    if (locked) { locked = false; props.onBusy?.(false); }
  };

  const readStatus = async (): Promise<KiroStatusView> => {
    const raw = await props.callApi<unknown>("/status", { timeoutMs: 10_000 });
    const parsed = parseKiroStatus(raw);
    if (!parsed) throw Object.assign(new Error("invalid status"), { reason: "request_failed" });
    return parsed;
  };

  /** Success tail shared by mutating actions: reconcile the managed provider
   * into the host draft (plus Router ref cleanup after a hide), re-read
   * status, then report. A failed draft reconciliation never suppresses the
   * status refresh or the toast — the mutation already persisted server-side. */
  const settle = async (id: number, opts: { hidden?: ReadonlySet<string>; visibleModels?: string[] } = {}) => {
    let failed = false;
    try {
      await props.refreshConfig?.((current: any, server: any) => {
        const merged = mergeKiroCardProvider(current, server);
        if (opts.hidden && (merged.Router || merged.router)) {
          // CCR stores the router under the capitalised Router key; lowercase
          // drafts are handled defensively.
          const firstVisible = opts.visibleModels?.find(m => !opts.hidden!.has(m)) ?? null;
          if (merged.Router) merged.Router = clearKiroRouterRefs(merged.Router, opts.hidden, firstVisible);
          if (merged.router) merged.router = clearKiroRouterRefs(merged.router, opts.hidden, firstVisible);
        }
        return merged;
      });
    } catch { failed = true; }
    const fresh = await readStatus().catch(() => null);
    if (!alive || generation !== id) return { reconcileFailed: failed };
    if (fresh) { status = fresh; loadFailed = false; }
    confirm = null;
    return { reconcileFailed: failed };
  };

  const showUsage = (accountId: string, value: KiroUsageView | null, at: number | null) => {
    usage.set(accountId, { phase: value ? "ready" : "unavailable", value, at });
  };

  const readUsage = async (accountId: string, id: number, background = false) => {
    if (!background) props.onBusy?.(true);
    usage.set(accountId, { ...(usage.get(accountId) ?? { value: null, at: null }), phase: "reading" });
    try {
      const parsed = parseKiroUsage(await post<unknown>("/usage", { account: accountId }));
      if (!parsed || !parsed.known) throw new Error("usage unavailable");
      rememberKiroUsage(usageStore, accountId, parsed);
      if (alive && generation === id) showUsage(accountId, parsed, Date.now());
    } catch {
      // A failed read is non-critical: never cached, rendered as a quiet note.
      if (alive && generation === id) showUsage(accountId, null, null);
    } finally {
      if (!background) props.onBusy?.(false);
      if (alive && generation === id) {
        if (locked && action?.kind === "usage") { locked = false; action = null; }
      }
      if (alive) render();
    }
  };

  // ---- credits auto-read ---------------------------------------------------
  // Same policy as the Codex/WorkBuddy cards: quota is what people look at
  // first, so a fresh connected mount reads every account once. The
  // session-scoped TTL cache keeps tab switches free; failures are not cached.
  const autoReadUsage = async (): Promise<void> => {
    if (!alive || props.disabled || loading || autoUsageStopped) return;
    for (const account of status?.accounts ?? []) {
      if (!alive || autoUsageStopped || props.disabled || locked || loading) return;
      if (usage.has(account.id)) continue;
      const cached = freshKiroUsage(usageStore, account.id);
      if (cached) { showUsage(account.id, cached.value, cached.at); render(); continue; }
      const requestGeneration = generation;
      const payload = await post<any>("/usage", { account: account.id }).catch(() => undefined);
      if (!alive || generation !== requestGeneration) return;
      if (payload === undefined) { showUsage(account.id, null, null); continue; }
      const parsed = parseKiroUsage(payload);
      if (parsed?.known) {
        rememberKiroUsage(usageStore, account.id, parsed);
        showUsage(account.id, parsed, Date.now());
      } else showUsage(account.id, null, null);
      render();
    }
  };

  const run = async (kind: SiteActionKind, argument?: string) => {
    if (!alive || locked || loading || props.disabled) return;
    if (kind === "usage") {
      if (!argument) return;
      // Read-only mutex slot (no management lease), like the Codex card.
      locked = true;
      action = { kind, account: argument };
      errorKey = null;
      render();
      return void readUsage(argument, ++generation);
    }
    if (props.acquireManagement) {
      release = props.acquireManagement();
      if (!release) { errorKey = "config_busy"; render(); return; }
    }
    locked = true;
    const id = ++generation;
    props.onBusy?.(true);
    action = { kind, account: kind === "remove" ? argument : undefined, model: kind === "hide" || kind === "restore" ? argument : undefined };
    errorKey = null;
    toast = null;
    reconcileFailed = false;
    render();
    try {
      if (kind === "login") {
        const current = createKiroLogin({
          start: input => post("/login/start", input, undefined, 30_000),
          poll: async (loginId, signal) => {
            try { return await post("/login/poll", { loginId }, signal, 35_000); }
            catch (error: any) {
              if (!signal.aborted && error?.timedOut === true) {
                throw Object.assign(new Error("Login poll timed out"), { reason: KIRO_POLL_TIMEOUT });
              }
              throw error;
            }
          },
          complete: (loginId, callbackUrl) => post("/login/complete", { loginId, callbackUrl }, undefined, 35_000),
          cancel: loginId => post("/login/cancel", { loginId }, undefined, 10_000),
        }, { method: loginMethod, ...(loginMethod === "idc" ? { startUrl: idcStartUrl, region: idcRegion } : {}) }, value => {
          if (!alive || generation !== id) { void current.cancel().catch(() => {}); return; }
          login = value;
          window.open(value.url, "_blank", "noopener,noreferrer");
          render();
        });
        session = current;
        const connected = await current.done;
        session = null;
        if (!alive || generation !== id) return;
        login = null;
        pasteField = null;
        if (!connected) return; // cancelled or superseded — close quietly
        pasteDraft = "";
        // A new identity may carry a different plan: reset the quota cache
        // (sessionStorage AND this mount's parsed store).
        clearKiroUsageCache();
        usageStore.entries = {}; usageStore.savedAt = 0; writeKiroUsageStore(usageStore);
        usage.clear();
        const { reconcileFailed: failed } = await settle(id);
        if (!alive || generation !== id) return;
        reconcileFailed = failed;
        const view = parseKiroLoginPoll(connected)?.account ?? null;
        toast = view?.email ? t("login.success", { email: view.email }) : t("login.success_unknown");
        void readAllUsageInBackground(id);
      } else if (kind === "sync") {
        const result = await post<any>("/sync", {}, undefined, 60_000);
        if (!result || result.success !== true) {
          if (alive && generation === id) errorKey = "sync_failed";
          return;
        }
        const { reconcileFailed: failed } = await settle(id);
        if (!alive || generation !== id) return;
        reconcileFailed = failed;
        // /sync returns the full reconciled catalog; status.models is now
        // visible-only, so prefer the sync result for the "synced N models" toast.
        toast = t("synced", { count: result.models?.length ?? status?.models.length ?? 0 });
      } else if (kind === "hide") {
        const model = argument ?? "";
        if (!model) return;
        const result = await post<any>("/models/visibility", { model, hidden: true });
        if (!result || result.success !== true) {
          if (alive && generation === id) errorKey = "hide_failed";
          return;
        }
        const hiddenSet = new Set([...(status?.hiddenModels ?? []), model]);
        const visibleModels = (status?.models ?? []).map(m => m.id).filter(m => !hiddenSet.has(m));
        const { reconcileFailed: failed } = await settle(id, { hidden: hiddenSet, visibleModels });
        if (!alive || generation !== id) return;
        reconcileFailed = failed;
        toast = t("hidden_toast", { model });
      } else if (kind === "restore") {
        const hiddenCount = status?.hiddenModels.length ?? 0;
        if (argument) {
          const result = await post<any>("/models/visibility", { model: argument, hidden: false });
          if (!result || result.success !== true) {
            if (alive && generation === id) errorKey = "restore_failed";
            return;
          }
        } else {
          // Restore-all: the server route flips one model per call, so issue
          // a bounded batch and keep a partial completion visible
          // ("restored N of M") when one request in the batch fails.
          const targets = [...(status?.hiddenModels ?? [])];
          let completed = 0;
          let failure: unknown = null;
          for (const hiddenModel of targets) {
            try {
              const one = await post<any>("/models/visibility", { model: hiddenModel, hidden: false });
              if (!one || one.success !== true) throw new Error("restore failed");
              completed += 1;
            } catch (e) { failure = e; break; }
          }
          if (failure !== null || completed < targets.length) {
            if (alive && generation === id) {
              errorKey = "restore_failed";
              if (completed > 0) toast = t("restore_partial", { count: completed, total: targets.length });
            }
            await settle(id);
            return;
          }
        }
        const { reconcileFailed: failed } = await settle(id);
        if (!alive || generation !== id) return;
        reconcileFailed = failed;
        toast = argument
          ? t("restored_toast", { model: argument })
          : t("restored_all_toast", { count: hiddenCount });
      } else if (kind === "remove") {
        const accountId = argument ?? "";
        const result = await post<any>("/disconnect", { account: accountId });
        if (!result || result.success !== true) {
          if (alive && generation === id) errorKey = "remove_failed";
          return;
        }
        usage.delete(accountId);
        const { reconcileFailed: failed } = await settle(id);
        if (!alive || generation !== id) return;
        reconcileFailed = failed;
        toast = t("account_removed");
      } else {
        const result = await post<any>("/disconnect", {});
        if (!result || result.success !== true) {
          if (alive && generation === id) errorKey = "disconnect_failed";
          return;
        }
        clearKiroUsageCache();
        usageStore.entries = {}; usageStore.savedAt = 0; writeKiroUsageStore(usageStore);
        usage.clear();
        const { reconcileFailed: failed } = await settle(id);
        if (!alive || generation !== id) return;
        reconcileFailed = failed;
        toast = t("disconnected");
      }
    } catch (error: any) {
      if (alive && generation === id) {
        const reason = error?.reason;
        errorKey = kiroCardErrorKey(typeof reason === "string" ? reason : null,
          kind === "login" ? "login_failed"
            : kind === "sync" ? "sync_failed"
            : kind === "hide" ? "hide_failed"
            : kind === "restore" ? "restore_failed"
            : kind === "remove" ? "remove_failed"
            : "disconnect_failed");
      }
    } finally {
      endBusy();
      session = null;
      if (alive && generation === id) {
        action = null; login = null; cancelling = false; pasteField = null;
        pasteDraft = "";
        render();
      }
    }
  };

  const readAllUsageInBackground = (id: number) => {
    for (const account of status?.accounts ?? []) {
      if (!alive || generation !== id) return;
      void readUsage(account.id, id, true);
    }
  };

  const submitPaste = () => {
    // The paste rides the login loop, so the login lease must not block it.
    if (!alive || !session) return;
    const value = pasteField?.value ?? "";
    if (!isValidKiroCallbackUrl(value)) { errorKey = "callback_invalid"; render(); return; }
    errorKey = null;
    pasteDraft = "";
    const current = session;
    void current.submitCallback(value).then(result => {
      if (!alive || session !== current || cancelling) return;
      if (!result) { errorKey = "callback_rejected"; render(); return; }
      if (result.status === "complete") return; // the loop settles
      if (result.status === "failed") { errorKey = "callback_rejected"; render(); return; }
      if (result.status === "expired") { errorKey = "login_expired"; render(); return; }
    }).catch(() => { if (alive) { errorKey = "callback_rejected"; render(); } });
  };

  // ---- rendering ------------------------------------------------------------

  /** One credit window: name, used/limit numbers and a percent progress bar. */
  const usageWindow = (parent: HTMLElement, window_: KiroUsageWindowView): void => {
    const percent = Number.isFinite(window_.used) ? Math.max(0, Math.min(100, Math.round(window_.used))) : 0;
    parent.append(styled("p", "text-[11px] text-muted-foreground",
      t("credits_line", { name: window_.name, display: window_.display, percent: String(percent) })));
    const track = styled("div", "h-1.5 w-full overflow-hidden rounded-full bg-white/10");
    track.setAttribute("role", "progressbar");
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", "100");
    track.setAttribute("aria-valuenow", String(percent));
    const fill = styled("div", "h-full rounded-full bg-primary transition-all");
    fill.style.width = `${percent}%`;
    track.append(fill);
    parent.append(track);
    const reset = kiroResetTime(window_.resetsAt, locale);
    if (reset) parent.append(styled("p", "text-[10px] text-muted-foreground/60", t("credits_reset", { time: reset })));
  };

  const renderLoginForm = (parent: HTMLElement, disabled: boolean): void => {
    const form = styled("div", "max-w-md space-y-2 rounded-lg border border-white/5 bg-white/5 px-3 py-2");
    form.setAttribute("aria-label", t("login.method"));
    form.append(styled("p", "text-xs font-medium text-foreground", t("login.method")));
    const choices = styled("div", "flex flex-col gap-1");
    choices.setAttribute("role", "radiogroup");
    for (const method of KIRO_METHODS) {
      const label = styled("label", "flex cursor-pointer items-center gap-2 text-xs text-muted-foreground");
      const radio = node("input") as HTMLInputElement;
      radio.type = "radio";
      radio.name = "kiro-login-method";
      radio.value = method;
      radio.checked = loginMethod === method;
      radio.disabled = disabled;
      radio.setAttribute("aria-label", t(`login.method_${method}`));
      radio.onchange = () => { loginMethod = method; errorKey = null; render(); };
      label.append(radio, node("span", t(`login.method_${method}`)));
      choices.append(label);
    }
    form.append(choices);
    if (loginMethod === "idc") {
      const startInput = styled("input", "w-full rounded-lg border border-input bg-input/50 px-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/50") as HTMLInputElement;
      startInput.type = "url";
      startInput.spellcheck = false;
      startInput.autocomplete = "off";
      startInput.placeholder = t("login.start_url_placeholder");
      startInput.setAttribute("aria-label", t("labels.start_url"));
      startInput.value = idcStartUrl;
      startInput.disabled = disabled;
      startInput.oninput = () => { idcStartUrl = startInput.value; };
      const regionInput = styled("input", "w-full rounded-lg border border-input bg-input/50 px-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/50") as HTMLInputElement;
      regionInput.type = "text";
      regionInput.spellcheck = false;
      regionInput.autocomplete = "off";
      regionInput.placeholder = t("login.region_placeholder");
      regionInput.setAttribute("aria-label", t("labels.region"));
      regionInput.value = idcRegion;
      regionInput.disabled = disabled;
      regionInput.oninput = () => { idcRegion = regionInput.value; };
      form.append(styled("label", "text-[11px] font-medium text-muted-foreground", t("labels.start_url")), startInput,
        styled("label", "text-[11px] font-medium text-muted-foreground", t("labels.region")), regionInput);
    }
    button(form, t("login.start"), () => {
      // Form validity is validated at click time (the qoder PAT form precedent):
      // a stale disabled binding would silently no-op after edits.
      if (loginMethod === "idc" && !isValidKiroIdcInput("idc", idcStartUrl, idcRegion)) {
        errorKey = "login_invalid"; render(); return;
      }
      void run("login");
    }, disabled, "primary", "h-8 w-full text-xs", plugIcon("mr-1 h-3.5 w-3.5"));
    parent.append(form);
  };

  const renderLoginPending = (parent: HTMLElement): void => {
    if (!login) return;
    const box = styled("div", "max-w-md space-y-1.5 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-xs");
    box.setAttribute("role", "status");
    box.append(styled("p", "font-medium", cancelling ? t("working") : t("login.pending")));
    if (!cancelling) {
      const link = styled("a", "block break-all text-primary underline", t("login.open")) as HTMLAnchorElement;
      link.href = login.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      box.append(link);
      box.append(styled("p", "leading-relaxed text-muted-foreground", t("login.paste_hint")));
      const field = styled("input", "w-full rounded-lg border border-input bg-input/50 px-3 py-1.5 font-mono text-xs text-foreground placeholder:text-muted-foreground/50") as HTMLInputElement;
      field.type = "text";
      field.spellcheck = false;
      field.setAttribute("placeholder", t("login.paste_placeholder"));
      field.setAttribute("aria-label", t("login.paste_title"));
      field.autocomplete = "off";
      field.value = pasteDraft; // survive in-place re-renders while polling
      field.oninput = () => { pasteDraft = field.value; };
      field.onkeydown = event => { if ((event as KeyboardEvent).key === "Enter") { event.preventDefault(); submitPaste(); } };
      pasteField = field;
      box.append(field);
      button(box, t("login.paste_submit"), submitPaste, false, "outline", "h-7 px-2 text-[11px]");
    }
    button(box, cancelling ? t("working") : t("cancel"), () => {
      cancelling = true;
      void session?.cancel().catch(() => { if (alive) { errorKey = "request_failed"; render(); } });
      if (alive) render();
    }, cancelling, "outline", "h-7 px-2 text-xs");
    parent.append(box);
  };

  const renderAccountRow = (account: KiroAccountView, active: boolean, disabled: boolean): HTMLElement => {
    const reading = action?.kind === "usage" && action.account === account.id;
    const state = usage.get(account.id);
    const row = styled("div", "rounded-lg border border-white/5 bg-white/5 px-3 py-2");
    const line = styled("div", "flex flex-wrap items-center gap-2");
    const dot = styled("span", `h-2 w-2 shrink-0 rounded-full ${active ? "bg-green-500" : "bg-muted-foreground/30"}`);
    dot.setAttribute("aria-hidden", "true");
    line.append(dot);
    line.append(styled("span", "sr-only", t(active ? "active_account" : "inactive_account")));
    // truncate keeps a very long email/name from breaking the row layout.
    line.append(styled("span", "min-w-0 max-w-[16rem] truncate font-mono text-xs text-foreground", accountName(account)));
    badge(line, sourceLabel(account), "outline", "px-1.5 py-0 text-[10px]");
    if (active) badge(line, t("active_account"), "outline", "border-primary/40 px-1.5 py-0 text-[10px] text-primary");
    if (account.plan) badge(line, account.plan, "secondary", "px-1.5 py-0 text-[10px]");
    if (account.needReauth) line.append(styled("span", "text-[11px] font-medium text-yellow-600", t("reauth_badge")));
    if (account.coolingUntil > Date.now()) {
      const until = formatKiroClock(account.coolingUntil, locale);
      line.append(styled("span", "text-[11px] font-medium text-yellow-600", t("cooling_until", { time: until ?? t("unknown") })));
    }
    row.append(line);
    const actions = styled("div", "mt-2 flex flex-wrap items-center gap-2");
    button(actions, t("credits"), () => void run("usage", account.id), disabled, "outline", "h-7 px-2 text-[11px]",
      coinsIcon(`mr-1 h-3 w-3 ${reading ? "animate-pulse" : ""}`));
    button(actions, t("remove"), () => { confirm = { kind: "remove", account: account.id }; render(); },
      disabled, "outline", "h-7 px-2 text-[11px] text-red-500");
    row.append(actions);
    if (state?.phase === "ready" && state.value) {
      const box = styled("div", "mt-2 space-y-1");
      if (state.value.plan) box.append(styled("p", "text-[11px] text-muted-foreground", `${t("labels.plan")}: ${state.value.plan}`));
      for (const window_ of state.value.windows) usageWindow(box, window_);
      if (state.value.stale) box.append(styled("p", "text-[10px] text-muted-foreground/60", t("credits_stale")));
      if (state.at !== null) box.append(styled("p", "text-[10px] text-muted-foreground/60", t("credits_updated", { time: formatKiroClock(state.at, locale) ?? t("unknown") })));
      row.append(box);
    } else if (state?.phase === "unavailable") {
      row.append(styled("p", "mt-1 text-[11px] text-muted-foreground", t("credits_unavailable")));
    }
    return row;
  };

  const render = () => {
    if (!alive) return;
    el.replaceChildren();
    el.dataset.testid = "kiro-card";
    const state = loading ? "loading" : loadFailed && !status ? "error" : kiroStateKey(status);
    const connected = !loading && kiroConnected(status);
    const accounts = status?.accounts ?? [];
    const models = status?.models ?? [];
    const hiddenModels = status?.hiddenModels ?? [];
    const active = kiroActiveAccount(status);
    const busy = loading || action !== null;
    const disabled = busy || props.disabled;
    const pendingHide = (model: string) => action?.kind === "hide" && action.model === model;
    const pendingRestore = (model: string) => action?.kind === "restore" && action.model === model;

    const card = styled("div", "glass-card rounded-2xl overflow-hidden mb-4");
    card.setAttribute("role", "group");
    card.setAttribute("aria-busy", String(busy));
    card.tabIndex = -1;
    if (focusPending) {
      // One-shot: consume at first delivery so the post-status re-render
      // (same synchronous mount) never scrolls again.
      focusPending = false;
      queueMicrotask(() => { card.scrollIntoView?.({ block: "start" }); card.focus?.(); });
    }

    const layout = styled("div", "flex flex-col gap-4 p-5 sm:flex-row sm:items-start sm:justify-between");
    const body = styled("div", "min-w-0 flex-1 space-y-3");

    const header = styled("div", "flex flex-wrap items-center gap-2");
    header.append(
      shieldCheckIcon("h-5 w-5 shrink-0 text-primary"),
      styled("p", "text-lg font-bold tracking-tight text-foreground", t("title")),
    );
    badge(header, t("builtin"), "outline");
    badge(header, t(`status.${state}`), "secondary", "", "status");
    body.append(header);
    body.append(styled("p", "max-w-md truncate text-xs font-medium text-muted-foreground/60",
      t("managed_provider", { name: status?.providerName || KIRO_PROVIDER_NAME })));
    body.append(styled("p", "max-w-md text-xs text-muted-foreground", t("description")));

    if (errorKey) {
      // login_invalid is a form-validation key: show the exact registered
      // kiro_login_invalid copy (flat namespace) instead of the generic one.
      body.append(errorAlert(errorKey === "login_invalid" ? (t("kiro_login_invalid") === "kiro_login_invalid" ? errorText("request_failed") : t("kiro_login_invalid")) : errorText(errorKey)));
    }
    if (reconcileFailed) body.append(errorAlert(t("errors.reconciliation_failed")));

    if (connected && status) {
      const count = styled("dl", "grid max-w-md grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs");
      const plan = accounts.find(a => a.id === active?.id)?.plan ?? status.plan ?? t("unknown");
      for (const [label, value] of [
        ["accounts", t("accounts_label", { count: accounts.length })],
        ["plan", plan || t("unknown")],
        ["models", t("models_count", { count: models.length })],
      ] as const) {
        count.append(styled("dt", "text-muted-foreground", t(`labels.${label}`)),
          styled("dd", "break-all text-foreground", value));
      }
      body.append(count);

      const pool = styled("div", "space-y-2");
      pool.setAttribute("aria-label", t("accounts_label", { count: accounts.length }));
      for (const account of accounts) pool.append(renderAccountRow(account, active?.id === account.id, disabled));
      body.append(pool);

      if (models.length > 0) {
        const chips = styled("div", "flex flex-wrap gap-2 pt-1");
        for (const model of models) {
          const chip = styled("span", CHIP, model.id);
          const hide = styled("button", CHIP_HIDE) as HTMLButtonElement;
          hide.type = "button";
          hide.disabled = disabled;
          hide.setAttribute("aria-label", t("hide_model", { model: model.id }));
          hide.setAttribute("aria-busy", String(pendingHide(model.id)));
          hide.append(xIcon("h-3 w-3"));
          hide.onclick = () => void run("hide", model.id);
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
          const restore = button(item, t("restore"), () => void run("restore", model),
            disabled || pendingRestore(model), "outline", "h-6 shrink-0 px-2 text-[11px]");
          restore.setAttribute("aria-label", t("restore_model", { model }));
          restore.setAttribute("aria-busy", String(pendingRestore(model)));
          list.append(item);
        }
        details.append(list);
        button(details, t("restore_all"), () => void run("restore"), disabled, "outline", "mt-2 h-7 px-2 text-[11px]");
        body.append(details);
      }
    }

    if (!connected && !loading) renderLoginForm(body, disabled);
    if (login) renderLoginPending(body);

    const about = styled("details", "max-w-md text-xs text-muted-foreground");
    about.append(styled("summary", "cursor-pointer select-none font-medium", t("about")));
    const aboutBody = styled("div", "mt-2 space-y-1 leading-relaxed");
    aboutBody.append(styled("p", "", t("about_body")));
    aboutBody.append(styled("p", "", t("hidden_note")));
    about.append(aboutBody);
    body.append(about);
    if (props.disabled) body.append(styled("p", "text-xs text-muted-foreground", t("other_edit")));

    const actions = styled("div", "flex shrink-0 flex-col gap-2 sm:w-[210px]");
    if (connected) {
      button(actions, t("login.add_account"), () => void run("login"), disabled, "primary", "h-8 w-full text-xs", plugIcon("mr-1 h-3.5 w-3.5"));
      button(actions, t("sync"), () => void run("sync"), disabled, "outline", "h-8 w-full text-xs",
        refreshCwIcon(`mr-1 h-3.5 w-3.5 ${action?.kind === "sync" ? "animate-spin" : ""}`));
      button(actions, t("disconnect"), () => { confirm = { kind: "disconnect" }; render(); }, disabled, "outline", "h-8 w-full text-xs");
    }

    layout.append(body, actions);
    card.append(layout);
    el.append(card);

    if (toast) {
      const message = styled("p", "flex max-w-md items-center gap-2 rounded-lg border border-green-500/25 bg-green-500/10 px-3 py-2 text-xs font-medium text-green-600", toast);
      message.setAttribute("role", "status");
      el.append(message);
    }
    if (confirm) {
      const panel = styled("div", "glass-card mt-3 max-w-lg space-y-3 rounded-2xl p-5");
      panel.setAttribute("role", "dialog");
      panel.append(
        styled("h3", "text-sm font-semibold tracking-tight text-foreground", confirm.kind === "remove" ? t("remove_title") : t("disconnect_title")),
        styled("p", "text-xs text-muted-foreground", confirm.kind === "remove" ? t("remove_warning") : t("disconnect_warning")),
      );
      if (errorKey) {
        const alert = styled("p", "text-sm text-red-600", errorText(errorKey));
        alert.setAttribute("role", "alert");
        panel.append(alert);
      }
      const footer = styled("div", "flex justify-end gap-2");
      button(footer, t("cancel"), () => { if (!action) { confirm = null; render(); } }, !!action, "outline", "h-8 text-xs");
      button(footer, action ? t("working") : confirm.kind === "remove" ? t("remove_confirm") : t("disconnect"),
        () => { if (confirm) void run(confirm.kind === "remove" ? "remove" : "disconnect", confirm.kind === "remove" ? confirm.account : undefined); },
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
    void session?.cancel().catch(() => {});
    // Visual disposal only: a deferred mutation keeps the management lease
    // until run()'s finally settles it (see codex/workbuddy parity).
    locked = false;
    el.replaceChildren();
  });
  // Host changes (e.g. the Save gate) re-render in place — never a remount.
  unsubscribeHost = props.onHostChange?.(() => { if (alive) render(); }) ?? null;
  render();
  readStatus().then(value => {
    if (alive) {
      status = value; loadFailed = false;
      for (const account of value.accounts) {
        const cached = freshKiroUsage(usageStore, account.id);
        if (cached) showUsage(account.id, cached.value, cached.at);
      }
    }
  }).catch(() => {
    if (alive) { loadFailed = true; errorKey = "request_failed"; }
  }).finally(() => {
    if (alive) {
      loading = false;
      render();
      if (kiroConnected(status)) void autoReadUsage();
    }
  });
}

export function unmount(el: HTMLElement): void {
  mounted.get(el)?.();
  mounted.delete(el);
}

export default { mount, unmount };
