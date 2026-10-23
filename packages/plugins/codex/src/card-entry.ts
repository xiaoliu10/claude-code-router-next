/** Self-contained Codex DOM card: no React, no host runtime imports, no
 * direct fetch, no Codex CLI code. Everything state/network/config related
 * flows through the host card capabilities (PluginCardMountProps, type-only).
 *
 * Visual contract: the card renders inside the host settings page and styles
 * itself exclusively with the host stylesheet's utilities — the same class
 * vocabulary as the Gemini/WorkBuddy plugin cards (glass card, host button/
 * badge hierarchies, inline lucide svg paths). No inline cssText, no raw
 * borders, no innerHTML — every dynamic string crosses via textContent and
 * every error is a stable, sanitized code.
 *
 * Lifecycle: one explicit user action at a time under the shared management
 * lease (login/sync/disconnect), quota auto-reads once per mount behind a
 * valid-only TTL cache with a manual refresh, host disabled flips re-render
 * in place (never a remount), and unmount cancels the login session and all
 * loops while a deferred mutation keeps the lease until it settles.
 */
import type { PluginCardMountProps } from "../../../ui/src/utils/plugin-card";
import type {
  CodexLoginPollView, CodexLoginStartView, CodexStatusView, CodexUsageView,
} from "./card-types";
import {
  CODEX_PROVIDER_NAME, clearCodexUsageCache, codexConnected, codexStateKey,
  codexWindowUnit, formatCodexClock, freshCodexUsage, isValidCodexCallbackUrl,
  maskCodexAccountId, mergeCodexProvider, parseCodexLoginPoll,
  parseCodexLoginStart, parseCodexMutation, parseCodexStatus, parseCodexUsage,
  rememberCodexUsage, sanitizeCodexErrorCode,
} from "./card-types";
import { codexLocales } from "./locales";

/** Stable local sentinel for a poll request that hit its transport timeout.
 * Not a server verdict and never rendered: the login loop retries within the
 * authorization deadline instead of aborting the whole login. */
const CODEX_POLL_TIMEOUT = "codex_poll_timeout";

function isCodexPollTimeout(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as { reason?: unknown }).reason === CODEX_POLL_TIMEOUT;
}

// ---------------------------------------------------------------------------
// Sequential browser login (callback poll + paste fallback), bounded
// ---------------------------------------------------------------------------

interface CodexLoginApi {
  start(): Promise<CodexLoginStartView>;
  poll(loginId: string, signal: AbortSignal): Promise<CodexLoginPollView>;
  complete(loginId: string, callbackUrl: string): Promise<CodexLoginPollView>;
  cancel(loginId: string): Promise<unknown>;
}

export interface CodexLoginSession {
  /** Resolves with the connected poll (or null when cancelled/superseded);
   * throws a stable-reason error on expiry or terminal server failure. */
  done: Promise<CodexLoginPollView | null>;
  /** Abort + invalidate the server job (idempotent, sequential). */
  cancel(): Promise<void>;
  /**
   * Submit a pasted callback URL. Executed BY the sequential loop as its next
   * step — never a second concurrent exchange. Resolves with the complete
   * response, or null when the session is already gone (the loop keeps
   * polling, so a callback that actually landed still heals via poll).
   */
  submitCallback(callbackUrl: string): Promise<CodexLoginPollView | null>;
}

/** One explicit login only. The poll loop is strictly sequential, bounded by
 * the server's expiresAt and a local hard cap, whichever is earlier. */
export function createCodexLogin(
  api: CodexLoginApi,
  onReady: (login: CodexLoginStartView) => void,
  timing = { intervalMs: 1_200, deadlineMs: 600_000 },
): CodexLoginSession {
  const controller = new AbortController();
  let job: CodexLoginStartView | null = null;
  let cancellation: Promise<unknown> | null = null;
  let expired = false;
  let pasteUrl: string | null = null;
  let pasteWaiter: ((result: CodexLoginPollView | null) => void) | null = null;
  let startedAt = 0;
  const wakeListeners = new Set<() => void>();

  const invalidate = (): Promise<unknown> => {
    if (!job) return Promise.resolve();
    return cancellation ??= api.cancel(job.loginId).catch(() => undefined);
  };
  const cancel = async (): Promise<void> => {
    controller.abort();
    resolvePasteWaiter(null);
    await invalidate();
  };
  /** Closure-narrowing-safe: resolve a pending pasted callback exactly once. */
  const resolvePasteWaiter = (result: CodexLoginPollView | null): void => {
    const waiter = pasteWaiter;
    pasteWaiter = null;
    waiter?.(result);
  };
  /** Paste submission rides the same loop: flag + wake, never a new request lane. */
  const submitCallback = (callbackUrl: string): Promise<CodexLoginPollView | null> => {
    if (!job || controller.signal.aborted) return Promise.resolve(null);
    return new Promise(resolve => {
      pasteUrl = callbackUrl;
      pasteWaiter?.(null); // a previous, unanswered paste is superseded
      pasteWaiter = resolve;
      for (const wake of [...wakeListeners]) wake(); // don't sit out the poll interval
    });
  };
  const hardDeadline = (login: CodexLoginStartView): number =>
    Math.min(login.expiresAt, startedAt + timing.deadlineMs);

  const done = (async (): Promise<CodexLoginPollView | null> => {
    let connected = false;
    try {
      startedAt = Date.now();
      const start = await api.start();
      const parsed = parseCodexLoginStart(start);
      if (!parsed) throw Object.assign(new Error("invalid login response"), { reason: "login_invalid_response" });
      job = parsed;
      // A cancel that raced the in-flight start must still invalidate the
      // freshly created server-side job — otherwise it parks in the server's
      // pending set until its full TTL and every retry gets login_busy.
      if (controller.signal.aborted) { await invalidate(); return null; }
      onReady(job);
      while (!controller.signal.aborted) {
        if (Date.now() >= hardDeadline(job)) { expired = true; break; }
        // Pop the paste pair BEFORE awaiting so a second paste submitted
        // mid-flight waits for the next iteration instead of stealing this
        // response — the loop stays the only request lane in existence.
        // Explicit annotation: TS cannot see closure-side assignments to
        // pasteWaiter and would otherwise narrow `waiter` to `null`.
        const paste: { url: string; waiter: ((result: CodexLoginPollView | null) => void) | null } | null =
          pasteUrl !== null ? { url: pasteUrl, waiter: pasteWaiter } : null;
        if (paste) { pasteUrl = null; pasteWaiter = null; }
        let result: CodexLoginPollView;
        try {
          result = paste
            ? await api.complete(job.loginId, paste.url)
            : await api.poll(job.loginId, controller.signal);
        } catch (error) {
          if (controller.signal.aborted) { paste?.waiter?.(null); break; }
          if (isCodexPollTimeout(error) || paste) {
            // A timed-out poll — or a paste whose request died in flight —
            // must not kill the authorization: keep polling and the server
            // verdict (connected/expired) still arrives. The paste waiter is
            // released so the UI can accept another paste.
            paste?.waiter?.(null);
            if (Date.now() >= hardDeadline(job)) { expired = true; break; }
            await wait(timing.intervalMs, controller.signal, wakeListeners);
            continue;
          }
          throw error;
        }
        if (controller.signal.aborted) { paste?.waiter?.(null); break; }
        // Fail closed on malformed payloads: an unparseable response is a
        // transient anomaly — retry within the deadline, never act on it.
        const validated = parseCodexLoginPoll(result);
        if (!validated) {
          paste?.waiter?.(null);
          if (Date.now() >= hardDeadline(job)) { expired = true; break; }
          await wait(timing.intervalMs, controller.signal, wakeListeners);
          continue;
        }
        result = validated;
        paste?.waiter?.(result); // the waiter already received the terminal poll view
        if (result.status === "connected") { connected = true; return result; }
        if (result.status === "cancelled") return null;
        if (result.status === "expired") { expired = true; break; }
        if (result.status === "error" && !paste) {
          // A terminal poll error is a server verdict (stable code only).
          throw Object.assign(new Error("login failed"), {
            reason: sanitizeCodexErrorCode(result.error) ?? "login_failed",
          });
        }
        // pending — or a rejected paste (the waiter already surfaced it; the
        // user may paste again while the session stays alive).
        await wait(timing.intervalMs, controller.signal, wakeListeners);
      }
      return null;
    } catch (error) {
      if (!controller.signal.aborted) throw error;
      return null;
    } finally {
      // Never leave a pasted callback hanging: expiry/cancel resolves it null.
      resolvePasteWaiter(null);
      if (!connected) await invalidate();
      if (expired) throw Object.assign(new Error("login expired"), { reason: "login_expired" });
    }
  })();
  return { done, cancel, submitCallback };
}

function wait(ms: number, signal: AbortSignal, wakeListeners?: Set<() => void>): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (wake) wakeListeners?.delete(wake);
    };
    const abort = () => { cleanup(); reject(new Error("cancelled")); };
    const wake = () => { cleanup(); resolve(); }; // a paste arrival ends the wait early
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
    wakeListeners?.add(wake);
    if (signal.aborted) { abort(); }
  });
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

const mounted = new WeakMap<HTMLElement, () => void>();

type UsagePhase = "idle" | "reading" | "ready" | "unavailable";
type ActionKind = "login" | "sync" | "disconnect" | "usage";

export function mount(el: HTMLElement, props: PluginCardMountProps): void {
  unmount(el);
  const locale = props.locale.startsWith("zh") ? "zh" : "en";
  const bundle = (props.locales[locale]?.codex ?? codexLocales[locale].codex) as Record<string, any>;
  const t = (key: string, vars: Record<string, unknown> = {}): string => {
    const text = key.split(".").reduce<any>((obj, k) => obj?.[k], bundle);
    return (typeof text === "string" ? text : key).replace(/\{\{(\w+)\}\}/g, (_, name) => String(vars[name] ?? ""));
  };
  /** Stable error code → localized text; unknown/polluted codes stay generic. */
  const errorText = (code: string | null | undefined): string => {
    const safe = sanitizeCodexErrorCode(code);
    if (safe) {
      const text = t(`errors.${safe}`);
      if (!text.startsWith("errors.")) return text;
    }
    return t("errors.request_failed");
  };

  let alive = true;
  let loading = true, loadFailed = false;
  let status: CodexStatusView | null = null;
  let locked = false;            // one action at a time (incl. read-only usage)
  let generation = 0;
  let action: ActionKind | null = null;
  let errorKey: string | null = null;
  let toast: string | null = null;
  let reconcileFailed = false;
  let confirmDisconnect = false;
  let login: CodexLoginStartView | null = null;
  let cancelling = false;
  let pasteField: HTMLInputElement | null = null;
  let pasteDraft = "";
  let session: ReturnType<typeof createCodexLogin> | null = null;
  let usage: CodexUsageView | null = null;
  let usagePhase: UsagePhase = "idle";
  let usageUpdatedAt: number | null = null;
  let release: (() => void) | null = null;
  let unsubscribeHost: (() => void) | null = null;
  // One-shot deep-link focus: the host navigates here with the managed
  // provider's name; unknown keys are ignored and stay unconsumed.
  let focusPending = props.focusKey === CODEX_PROVIDER_NAME;
  if (focusPending) props.focusKey = null;

  const post = <T,>(path: string, body: unknown = {}, signal?: AbortSignal, timeoutMs = 30_000): Promise<T> =>
    props.callApi<T>(path, { method: "POST", body: JSON.stringify(body), signal, timeoutMs });

  // ---- visual layer (host stylesheet vocabulary; see file header) -----------
  const BUTTON_BASE = "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-semibold ring-offset-background transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 active:scale-95";
  const BUTTON_PRIMARY = "bg-primary text-primary-foreground shadow-lg shadow-primary/20 hover:bg-primary/90 hover:shadow-xl hover:shadow-primary/30";
  const BUTTON_OUTLINE = "border border-input bg-input/50 backdrop-blur-md shadow-sm hover:bg-input/80 hover:border-primary/50 hover:shadow-md hover:text-accent-foreground";
  const BUTTON_DESTRUCTIVE = "border border-destructive/50 text-destructive hover:bg-destructive hover:text-destructive-foreground";
  const BADGE_BASE = "inline-flex items-center rounded-lg border px-2.5 py-0.5 text-[10px] font-bold transition-colors";
  const BADGE_OUTLINE = "border-white/10 text-foreground bg-white/5";
  const BADGE_SECONDARY = "border-white/5 bg-white/5 text-muted-foreground";

  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => {
    const result = document.createElement(tag);
    if (text !== undefined) result.textContent = text; // Never innerHTML/upstream text.
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
  const button = (parent: HTMLElement, text: string, action: () => void, disabled = false, variant: "primary" | "outline" | "destructive" = "outline", extra = "", iconNode?: SVGSVGElement): HTMLButtonElement => {
    const result = styled("button", `${BUTTON_BASE} ${variant === "primary" ? BUTTON_PRIMARY : variant === "destructive" ? BUTTON_DESTRUCTIVE : BUTTON_OUTLINE} ${extra}`, text) as HTMLButtonElement;
    result.type = "button";
    result.disabled = disabled;
    result.onclick = action;
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

  const readStatus = async (): Promise<CodexStatusView> => {
    const raw = await props.callApi<unknown>("/status", { timeoutMs: 10_000 });
    const parsed = parseCodexStatus(raw);
    if (!parsed) throw Object.assign(new Error("invalid status"), { reason: "request_failed" });
    return parsed;
  };

  /** Success tail shared by mutating actions: reconcile the managed provider
   * into the host draft (unrelated providers and Router survive untouched),
   * re-read status, then report. A failed draft reconciliation must not
   * suppress the status refresh or the toast — the mutation already persisted
   * server-side; the failure is surfaced separately instead. */
  const settle = async (id: number): Promise<{ fresh: CodexStatusView | null; reconcileFailed: boolean }> => {
    let failed = false;
    try {
      await props.refreshConfig?.((current: any, server: any) => mergeCodexProvider(current, server));
    } catch { failed = true; }
    const fresh = await readStatus().catch(() => null);
    if (!alive || generation !== id) return { fresh, reconcileFailed: failed };
    if (fresh) { status = fresh; loadFailed = false; }
    confirmDisconnect = false;
    return { fresh, reconcileFailed: failed };
  };

  const showUsage = (value: CodexUsageView | null, at: number | null) => {
    usage = value;
    usageUpdatedAt = at;
    usagePhase = value ? "ready" : "unavailable";
  };

  const readUsage = async (id: number, background = false) => {
    if (!background) props.onBusy?.(true);
    usagePhase = "reading";
    try {
      const raw = await post<unknown>("/usage", {});
      const parsed = parseCodexUsage(raw);
      rememberCodexUsage(parsed);
      if (alive && generation === id) showUsage(parsed, parsed ? Date.now() : null);
    } catch {
      // A failed read is non-critical: never cached, rendered as a quiet note.
      if (alive && generation === id) showUsage(null, null);
    } finally {
      // Every read balances its own busy signal; only the current generation
      // may reset card-local state (a stale auto-read must not end a manual
      // refresh the user started while it was in flight).
      if (!background) props.onBusy?.(false);
      if (alive && generation === id) {
        locked = false;
        if (action === "usage") action = null;
      }
      if (alive) render();
    }
  };

  // ---- quota auto-read ------------------------------------------------------
  // Quota is the first thing people look for, so a fresh connected mount reads
  // it ONCE without a click. Values live in a session-scoped TTL cache and
  // only VALID usage is cached — failures and "absent" never suppress a retry
  // on the next visit. The manual refresh button stays the explicit re-read.
  const autoReadUsage = async (): Promise<void> => {
    if (!alive || props.disabled || loading || usagePhase === "ready") return;
    const cached = freshCodexUsage();
    if (cached) { showUsage(cached.value, cached.at); render(); return; }
    // Read-only background read: no management lease, no page-busy signal.
    const id = generation;
    await readUsage(id, true);
  };

  const run = async (kind: ActionKind) => {
    if (!alive || locked || loading || props.disabled) return;
    if (kind === "usage") {
      locked = true;
      action = "usage";
      usagePhase = "reading";
      errorKey = null;
      render();
      return void readUsage(++generation);
    }
    if (props.acquireManagement) {
      release = props.acquireManagement();
      if (!release) { errorKey = "config_busy"; render(); return; }
    }
    locked = true;
    const id = ++generation;
    props.onBusy?.(true);
    action = kind;
    errorKey = null;
    toast = null;
    reconcileFailed = false;
    render();
    try {
      if (kind === "login") {
        const current = createCodexLogin({
          start: () => post<CodexLoginStartView>("/login/start", {}),
          poll: async (loginId, signal) => {
            try { return await post<CodexLoginPollView>("/login/poll", { loginId }, signal, 35_000); }
            catch (error: any) {
              // Timeout classification is generic in the host; the plugin owns
              // its sequential-login retry sentinel. Cancellation never retries.
              if (!signal.aborted && error?.timedOut === true) {
                throw Object.assign(new Error("Login poll timed out"), { reason: CODEX_POLL_TIMEOUT });
              }
              throw error;
            }
          },
          complete: (loginId, callbackUrl) => post<CodexLoginPollView>("/login/complete", { loginId, callbackUrl }, undefined, 35_000),
          cancel: loginId => post("/login/cancel", { loginId }, undefined, 10_000),
        }, value => {
          if (!alive || generation !== id) { void current.cancel().catch(() => {}); return; }
          login = value;
          // The explicit user action continues: the authorization page opens,
          // and the same URL stays reachable through the rendered action link.
          window.open(value.url, "_blank", "noopener,noreferrer");
          render();
        });
        session = current;
        const connected = await current.done;
        session = null;
        if (!alive || generation !== id) return;
        login = null;
        pasteField = null;
        if (!connected) return; // cancelled (or superseded) — close quietly
        pasteDraft = "";
        // A fresh login may be a DIFFERENT account: the per-page quota cache
        // (and any rendered windows) belong to the previous one. Reset so the
        // card re-reads instead of showing the old plan until the TTL lapses.
        clearCodexUsageCache();
        usage = null; usageUpdatedAt = null; usagePhase = "idle";
        const { fresh, reconcileFailed: failed } = await settle(id);
        if (!alive || generation !== id) return;
        reconcileFailed = failed;
        toast = fresh?.email ? t("login_success", { email: fresh.email }) : t("login_success_unknown");
        // Read the NEW account's quota in the background (cache was reset above).
        void readUsage(id, true);
      } else if (kind === "sync") {
        const result = parseCodexMutation(await post<unknown>("/sync", {}, undefined, 60_000));
        if (!result.success) {
          if (alive && generation === id) errorKey = result.error ?? "sync_failed";
          return;
        }
        const { fresh, reconcileFailed: failed } = await settle(id);
        if (!alive || generation !== id) return;
        reconcileFailed = failed;
        toast = t("synced", { count: result.modelCount ?? result.models?.length ?? 0 });
        if (fresh) usagePhase = "idle"; // plan may have changed; next visit re-reads
      } else {
        const result = parseCodexMutation(await post<unknown>("/disconnect", {}));
        if (!result.success) {
          if (alive && generation === id) errorKey = result.error ?? "disconnect_failed";
          return;
        }
        clearCodexUsageCache();
        const { fresh, reconcileFailed: failed } = await settle(id);
        if (!alive || generation !== id) return;
        reconcileFailed = failed;
        usage = null; usagePhase = "idle"; usageUpdatedAt = null;
        toast = t("disconnected");
      }
    } catch (error) {
      if (alive && generation === id) {
        const reason = (error as { reason?: unknown } | null)?.reason;
        errorKey = sanitizeCodexErrorCode(typeof reason === "string" ? reason : null)
          ?? (kind === "login" ? "login_failed" : kind === "sync" ? "sync_failed" : "disconnect_failed");
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

  const submitPaste = () => {
    // The paste rides the login loop, so the login's own lease/action must not
    // block it — only a torn-down card or a finished session may.
    if (!alive || !session) return;
    const value = pasteField?.value ?? "";
    if (!isValidCodexCallbackUrl(value)) { errorKey = "callback_invalid"; render(); return; }
    errorKey = null;
    pasteDraft = "";
    void session.submitCallback(value).then(result => {
      if (!alive || !result || result.status === "connected") return; // the loop settles connected
      if (result.status === "error") { errorKey = sanitizeCodexErrorCode(result.error) ?? "callback_rejected"; render(); return; }
      if (result.status === "expired") { errorKey = "login_expired"; render(); return; }
    }).catch(() => {
      if (alive) { errorKey = "callback_rejected"; render(); }
    });
  };

  const usageWindowLine = (label: string, window_: { usedPercent: number; windowSeconds: number; resetAt: number }): HTMLElement => {
    const line = styled("p", "text-[11px] text-muted-foreground");
    const { unit, count } = codexWindowUnit(window_.windowSeconds);
    const reset = formatCodexClock(window_.resetAt, locale) ?? t("unknown");
    line.append(
      styled("span", "font-medium text-foreground", t(label, { window: t(`window.${unit}`, { count }) })),
      document.createTextNode(` ${t("usage_line", { percent: String(Math.round(window_.usedPercent)), time: reset })}`),
    );
    return line;
  };

  // ---- rendering ------------------------------------------------------------
  const render = () => {
    if (!alive) return;
    el.replaceChildren();
    el.dataset.testid = "codex-card";
    const state = loading ? "loading" : loadFailed && !status ? "error" : codexStateKey(status);
    const connected = !loading && codexConnected(status);
    const canDisconnect = !!status && (status.status !== "not_connected" || status.models.length > 0);
    const busy = loading || action !== null;
    const disabled = busy || props.disabled;

    const card = styled("div", "glass-card rounded-2xl overflow-hidden mb-4");
    card.setAttribute("role", "group");
    card.setAttribute("aria-busy", String(busy));
    if (focusPending) {
      focusPending = false;
      queueMicrotask(() => { card.scrollIntoView?.({ block: "start" }); card.focus?.(); });
    }
    card.tabIndex = -1;

    const layout = styled("div", "flex flex-col gap-4 p-5 sm:flex-row sm:items-start sm:justify-between");
    const body = styled("div", "min-w-0 flex-1 space-y-3");

    const header = styled("div", "flex flex-wrap items-center gap-2");
    header.append(
      shieldCheckIcon("h-5 w-5 shrink-0 text-primary"),
      styled("p", "text-lg font-bold tracking-tight text-foreground", t("title")),
    );
    badge(header, t("builtin"), "outline");
    badge(header, t("experimental"), "outline", "border-amber-500/40 text-amber-600");
    badge(header, t(`status.${state}`), "secondary", "", "status");
    body.append(header);
    body.append(styled("p", "max-w-md truncate text-xs font-medium text-muted-foreground/60",
      t("managed_provider", { name: status?.providerName || CODEX_PROVIDER_NAME })));
    body.append(styled("p", "max-w-md text-xs text-muted-foreground", t("description")));

    if (connected && status) {
      const rows = styled("dl", "grid max-w-md grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs");
      const account = maskCodexAccountId(status.accountId) ?? t("unknown");
      for (const [label, value, mono] of [
        ["email", status.email ?? t("unknown"), true],
        ["account", account, true],
        ["plan", status.plan || t("unknown"), false],
        ["models", t("models_count", { count: status.modelCount }), false],
      ] as const) {
        rows.append(
          styled("dt", "text-muted-foreground", t(`labels.${label}`)),
          styled("dd", `break-all ${mono ? "font-mono " : ""}text-foreground`, value),
        );
      }
      body.append(rows);
      if (status.models.length > 0) {
        const chips = styled("div", "flex flex-wrap gap-2 pt-1");
        for (const model of status.models) {
          chips.append(styled("span", "inline-flex max-w-full items-center gap-1 break-all whitespace-normal rounded-lg border border-white/5 bg-white/5 px-2 py-0.5 text-[10px] font-bold text-muted-foreground", model));
        }
        body.append(chips);
      }
      const usageBox = styled("div", "max-w-md space-y-1 rounded-lg border border-white/5 bg-white/5 px-3 py-2 text-xs");
      const usageHeader = styled("div", "flex flex-wrap items-center justify-between gap-2");
      usageHeader.append(styled("p", "font-medium text-foreground", t("usage_title")));
      button(usageHeader, t("refresh_usage"), () => void run("usage"), disabled, "outline", "h-7 px-2 text-[11px]",
        coinsIcon(`mr-1 h-3 w-3 ${usagePhase === "reading" ? "animate-pulse" : ""}`));
      usageBox.append(usageHeader);
      if (usagePhase === "ready" && usage) {
        if (usage.plan) usageBox.append(styled("p", "text-[11px] text-muted-foreground", t("usage_plan", { plan: usage.plan })));
        if (usage.primary) usageBox.append(usageWindowLine("usage_primary", usage.primary));
        if (usage.secondary) usageBox.append(usageWindowLine("usage_secondary", usage.secondary));
        const updated = usageUpdatedAt !== null ? formatCodexClock(usageUpdatedAt, locale) : null;
        if (updated) usageBox.append(styled("p", "text-[10px] text-muted-foreground/60", t("usage_updated", { time: updated })));
      } else if (usagePhase === "unavailable") {
        usageBox.append(styled("p", "text-[11px] text-muted-foreground", t("usage_unavailable")));
      }
      body.append(usageBox);
    }

    const cooldown = status?.coolingUntil !== undefined && state === "cooldown"
      ? formatCodexClock(status.coolingUntil, locale) : null;
    if (cooldown) body.append(styled("p", "text-xs font-medium text-yellow-600", t("cooldown_until", { time: cooldown })));
    if (state === "needs_relogin") body.append(styled("p", "text-xs text-yellow-600", t("needs_relogin_help")));
    // The redacted lastError is a stable code — render it translated for every
    // non-connected state so the surface explains itself; polluted values
    // collapse to the generic failure inside errorText().
    if (!connected && status?.lastError) body.append(errorAlert(errorText(status.lastError)));
    if (errorKey) body.append(errorAlert(errorText(errorKey)));
    if (reconcileFailed) body.append(errorAlert(t("errors.reconciliation_failed")));

    if (login) {
      const box = styled("div", "max-w-md space-y-1.5 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-xs");
      box.setAttribute("role", "status");
      box.append(styled("p", "font-medium", cancelling ? t("working") : t("login_pending")));
      if (!cancelling) {
        const link = styled("a", "block break-all text-primary underline") as HTMLAnchorElement;
        link.href = login.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = t("open_login");
        box.append(link);
        if (login.mode === "paste") {
          box.append(styled("p", "leading-relaxed text-muted-foreground", t("paste_title")));
          box.append(styled("p", "leading-relaxed text-muted-foreground", t("paste_help")));
        } else {
          box.append(styled("p", "leading-relaxed text-muted-foreground", t("paste_hint")));
        }
        const field = styled("input", "w-full rounded-lg border border-input bg-input/50 px-3 py-1.5 font-mono text-xs text-foreground placeholder:text-muted-foreground/50") as HTMLInputElement;
        field.type = "text";
        field.spellcheck = false;
        field.setAttribute("placeholder", t("paste_placeholder"));
        field.setAttribute("aria-label", t("paste_title"));
        field.autocomplete = "off";
        field.value = pasteDraft; // survive in-place re-renders while polling
        field.oninput = () => { pasteDraft = field.value; };
        field.onkeydown = event => { if ((event as KeyboardEvent).key === "Enter") { event.preventDefault(); submitPaste(); } };
        pasteField = field;
        box.append(field);
        button(box, t("paste_submit"), submitPaste, false, "outline", "h-7 px-2 text-[11px]");
      }
      button(box, cancelling ? t("working") : t("cancel"), () => {
        cancelling = true;
        void session?.cancel().catch(() => { if (alive) { errorKey = "request_failed"; render(); } });
        if (alive) render();
      }, cancelling, "outline", "h-7 px-2 text-xs");
      body.append(box);
    }

    const about = styled("details", "max-w-md text-xs text-muted-foreground");
    about.append(styled("summary", "cursor-pointer select-none font-medium", t("about")));
    const aboutBody = styled("div", "mt-2 space-y-1 leading-relaxed");
    aboutBody.append(styled("p", "", t("about_body")));
    aboutBody.append(styled("p", "", t("disclaimer")));
    about.append(aboutBody);
    body.append(about);
    if (props.disabled) body.append(styled("p", "text-xs text-muted-foreground", t("other_edit")));

    const actions = styled("div", "flex shrink-0 flex-col gap-2 sm:w-[210px]");
    button(actions, action === "login" ? t("working") : connected || state === "needs_relogin" ? t("reconnect") : t("browser_login"),
      () => void run("login"), disabled, "primary", "h-8 w-full text-xs", plugIcon("mr-1 h-3.5 w-3.5"));
    button(actions, t("sync"), () => void run("sync"), disabled || !connected, "outline", "h-8 w-full text-xs",
      refreshCwIcon(`mr-1 h-3.5 w-3.5 ${action === "sync" ? "animate-spin" : ""}`));
    button(actions, t("disconnect"), () => { confirmDisconnect = true; render(); }, disabled || !canDisconnect, "outline", "h-8 w-full text-xs");

    layout.append(body, actions);
    card.append(layout);
    el.append(card);

    if (toast) {
      const message = styled("p", "flex max-w-md items-center gap-2 rounded-lg border border-green-500/25 bg-green-500/10 px-3 py-2 text-xs font-medium text-green-600", toast);
      message.setAttribute("role", "status");
      el.append(message);
    }

    if (confirmDisconnect) {
      const panel = styled("div", "glass-card mt-3 max-w-lg space-y-3 rounded-2xl p-5");
      panel.setAttribute("role", "dialog");
      panel.append(
        styled("h3", "text-sm font-semibold tracking-tight text-foreground", t("disconnect_title")),
        styled("p", "text-xs text-muted-foreground", t("disconnect_warning")),
      );
      const footer = styled("div", "flex justify-end gap-2");
      button(footer, t("cancel"), () => { if (!action) { confirmDisconnect = false; render(); } }, !!action, "outline", "h-8 text-xs");
      button(footer, action ? t("working") : t("disconnect"), () => { if (confirmDisconnect) void run("disconnect"); },
        loading || action !== null || props.disabled, "destructive", "h-8 text-xs");
      panel.append(footer);
      el.append(panel);
    }
  };

  mounted.set(el, () => {
    alive = false;
    confirmDisconnect = false;
    unsubscribeHost?.(); unsubscribeHost = null;
    void session?.cancel().catch(() => {});
    // Visual disposal only. The shared management lease deliberately stays
    // held while a deferred mutation (and its reconciliation) finishes:
    // run()'s finally releases it. Releasing here would let a full-config
    // save race the still-pending managed mutation after navigation/unmount.
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
    if (alive) { loadFailed = true; errorKey = "request_failed"; }
  }).finally(() => {
    if (alive) { loading = false; render(); if (codexConnected(status)) void autoReadUsage(); }
  });
}

export function unmount(el: HTMLElement): void {
  mounted.get(el)?.(); mounted.delete(el);
}
export default { mount, unmount };
