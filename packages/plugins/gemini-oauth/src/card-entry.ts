/** Self-contained DOM card: no React, host imports or direct fetch. All
 * state/network/config interactions flow through the host card capabilities. */
import type { PluginCardMountProps } from "../../../ui/src/utils/plugin-card";
import type { GeminiOauthStatusResponse, GeminiOauthLoginStartResponse } from "../../../ui/src/types";
import {
  geminiOauthStateKey, geminiOauthErrorKey, geminiOauthStatusErrorKey,
  formatGeminiOauthClock, safeValidationUrl, mergeGeminiOauthProvider,
  GEMINI_OAUTH_PROVIDER_NAME,
} from "../../../ui/src/utils/gemini-oauth";
import { createGeminiOauthLogin } from "../../../ui/src/utils/gemini-oauth-login";
import { geminiOauthLocales } from "./locales";

/**
 * Exact `gemini-oauth,<model>` references a hide reported as removed from
 * Router, and the Router PATH LABELS it rewrote. Mirrors the server's grammar
 * (a model id of 1-256 chars without control characters or a comma) so a
 * malformed payload can never steer the local draft cleanup. Values are only
 * ever compared verbatim, never parsed or rendered as markup.
 */
const MODEL_REF_PATTERN = /^gemini-oauth,[^\x00-\x1f\x7f,]{1,256}$/;
const ROUTER_PATH_PATTERN = /^(?:default|fallback|scenario:(?:background|think|longContext|extendedContext|webSearch|image)|models:[A-Za-z0-9_-]{1,80}|families\.[A-Za-z0-9_-]{1,80}\.default)$/;

export function sanitizeGeminiOauthModelRefs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const clean = value
    .map(item => (typeof item === "string" ? item : ""))
    .filter(item => MODEL_REF_PATTERN.test(item));
  return Array.from(new Set(clean)).slice(0, 8);
}

export function sanitizeGeminiOauthRouterPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const clean = value
    .map(item => (typeof item === "string" ? item : ""))
    .filter(item => ROUTER_PATH_PATTERN.test(item));
  return Array.from(new Set(clean)).slice(0, 8);
}

const ROUTER_REF_SLOTS = ["default", "background", "think", "longContext", "extendedContext", "webSearch", "image"] as const;

/**
 * Hide reconciliation for the SAVED-config draft. The mutation already committed
 * server-side; this narrow merge keeps every unrelated draft edit and only:
 *  - replaces the managed provider entry (mergeGeminiOauthProvider),
 *  - drops the exact refs the server reported from the local Router draft, so a
 *    later Save cannot re-arm the hidden model (default is replaced by the
 *    server-authoritative persisted fallback; scenarios clear/drop; aliases,
 *    family defaults and custom entries referencing a removed ref go away),
 *  - drops matching stages from a nested local `fallback` chain.
 * Router is never re-wired to the hidden model, and no old route is restored.
 */
export function mergeGeminiOauthHiddenRefs(
  local: any,
  server: any,
  removedModelRefs: unknown,
  defaultFallback?: string | null,
): any {
  const merged = mergeGeminiOauthProvider(local, server);
  const refs = sanitizeGeminiOauthModelRefs(removedModelRefs);
  if (refs.length === 0) return merged;
  const refSet = new Set(refs);
  // Custom routes may hold `{ provider, model }` objects; the backend reports
  // refs as `provider,model`, so the object form compares as that exact pair
  // (nested objects included).
  const entryModels = (value: unknown): string[] => {
    if (Array.isArray(value)) return value.flatMap(entryModels);
    if (!value || typeof value !== "object") return [];
    const record = value as Record<string, unknown>;
    const own = typeof record.provider === "string" && typeof record.model === "string"
      ? [`${record.provider},${record.model}`]
      : [];
    return [...own, ...Object.values(record).flatMap(entryModels)];
  };
  const source = (local?.Router ?? {}) as Record<string, unknown>;
  if (!source || typeof source !== "object") return merged;
  // The draft Router is REPLACED, never mutated in place: `source` is the caller's
  // live draft and a later Save must observe the cleaned references.
  const router: Record<string, unknown> = { ...source };
  for (const slot of ROUTER_REF_SLOTS) {
    const value = router[slot];
    if (typeof value === "string" && refSet.has(value)) {
      router[slot] = slot === "default"
        ? (defaultFallback === undefined
          ? (typeof server?.Router?.default === "string" ? server.Router.default : "")
          : (defaultFallback ?? ""))
        : "";
    } else if (Array.isArray(value) && value.every(item => typeof item === "string")) {
      router[slot] = value.filter(item => !refSet.has(item as string));
    }
  }
  if (source.models && typeof source.models === "object" && !Array.isArray(source.models)) {
    const kept: Record<string, unknown> = {};
    for (const [alias, target] of Object.entries(source.models as Record<string, unknown>)) {
      if (typeof target === "string" && refSet.has(target)) continue;
      kept[alias] = target;
    }
    router.models = kept;
  }
  if (source.families && typeof source.families === "object" && !Array.isArray(source.families)) {
    const families: Record<string, unknown> = {};
    for (const [family, config] of Object.entries(source.families as Record<string, unknown>)) {
      if (!config || typeof config !== "object" || Array.isArray(config)) { families[family] = config; continue; }
      const record = { ...(config as Record<string, unknown>) };
      if (typeof record.default === "string" && refSet.has(record.default)) record.default = "";
      families[family] = record;
    }
    router.families = families;
  }
  if (Array.isArray(source.fallback)) {
    const kept: unknown[] = [];
    for (const stage of source.fallback as unknown[]) {
      if (typeof stage === "string") { if (!refSet.has(stage)) kept.push(stage); continue; }
      if (Array.isArray(stage) && stage.every(item => typeof item === "string")) {
        const rest = (stage as string[]).filter(item => !refSet.has(item));
        if (rest.length) kept.push(rest);
        continue;
      }
      kept.push(stage);
    }
    router.fallback = kept;
  }
  // Custom routes hold a route OBJECT (a list of them, or a name→route map at
  // `custom.routes`). A route referencing a removed model is dropped whole; a
  // plain string alias elsewhere is handled by reference identity.
  const droppedRoute = (entry: unknown): boolean => entryModels(entry).some((ref) => refSet.has(ref));
  const customRoutes = router.custom;
  if (Array.isArray(customRoutes)) {
    router.custom = customRoutes.filter(entry => !droppedRoute(entry));
  } else if (customRoutes && typeof customRoutes === "object") {
    const next = { ...(customRoutes as Record<string, unknown>) };
    if (Array.isArray(next.routes)) {
      next.routes = (next.routes as unknown[]).filter(entry => !droppedRoute(entry));
    } else if (next.routes && typeof next.routes === "object") {
      const keptRoutes: Record<string, unknown> = {};
      for (const [name, entry] of Object.entries(next.routes as Record<string, unknown>)) {
        if (!droppedRoute(entry)) keptRoutes[name] = entry;
      }
      next.routes = keptRoutes;
    }
    router.custom = next;
  }
  return { ...merged, Router: router };
}

const mounted = new WeakMap<HTMLElement, () => void>();

export function mount(el: HTMLElement, props: PluginCardMountProps): void {
  unmount(el);
  let alive = true, busy = false, loading = true, loadFailed = false;
  let status: GeminiOauthStatusResponse | null = null;
  let errorKey: string | null = null, toast: string | null = null;
  let consentOpen = false, consentAck = false, confirmDisconnect = false;
  let pending: { kind: "login" | "sync" | "disconnect" | "hide" | "restore"; argument: string | null } | null = null;
  let actionGeneration = 0;
  let login: GeminiOauthLoginStartResponse | null = null;
  let session: ReturnType<typeof createGeminiOauthLogin> | null = null;
  let consentGranted = false;
  let release: (() => void) | null = null;
  let reconcileFailed = false;
  let unsubscribeHost: (() => void) | null = null;
  const locale = props.locale.startsWith("zh") ? "zh" : "en";
  const bundle = props.locales[locale]?.geminiOauth ?? geminiOauthLocales[locale].geminiOauth;
  const t = (key: string, vars: Record<string, unknown> = {}): string => {
    const text = key.split(".").reduce<any>((obj, k) => obj?.[k], bundle);
    return (typeof text === "string" ? text : "").replace(/\{\{(\w+)\}\}/g, (_, name) => String(vars[name] ?? ""));
  };
  /**
   * Map an error-shaped value to a code the card can localize. The bundle's
   * `errors` section IS the whitelist: a code renders only when it carries
   * copy for it (this includes the plugin-local model-management codes the
   * shared UI allowlist does not know). Anything else — unknown codes, raw
   * upstream text — collapses to the shared mapping's generic failure; server
   * message text is never rendered.
   */
  const cardErrorKey = (error: unknown): string => {
    const raw = typeof error === "string"
      ? error
      : error && typeof error === "object"
        ? ((error as { reason?: unknown }).reason ?? (error as { error?: unknown }).error ?? (error as { code?: unknown }).code)
        : null;
    const errors = (bundle as { errors?: Record<string, unknown> }).errors;
    if (typeof raw === "string" && errors && typeof errors[raw] === "string") return raw;
    return geminiOauthErrorKey(error);
  };
  const cancelText = locale === "zh" ? "取消" : "Cancel";
  const post = <T,>(path: string, body: any = {}, signal?: AbortSignal) => props.callApi<T>(path, {
    method: "POST", body: JSON.stringify(body), signal,
    timeoutMs: path === "/sync" ? 60_000 : 30_000,
  });

  // ---- visual layer ---------------------------------------------------------
  // The card renders inside the host settings page, so the host's global
  // stylesheet (Tailwind utilities + the custom .glass-card rule) is part of
  // its runtime environment — same as document/props.callApi. Class names
  // below mirror the pre-migration React card EXACTLY (host ui/button,
  // ui/badge, ui/card and ui/dialog class lists inlined; no host imports,
  // no React).

  const BUTTON_BASE = "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-semibold ring-offset-background transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 active:scale-95";
  const BUTTON_PRIMARY = "bg-primary text-primary-foreground shadow-lg shadow-primary/20 hover:bg-primary/90 hover:shadow-xl hover:shadow-primary/30";
  const BUTTON_OUTLINE = "border border-input bg-input/50 backdrop-blur-md shadow-sm hover:bg-input/80 hover:border-primary/50 hover:shadow-md hover:text-accent-foreground";
  const BUTTON_DESTRUCTIVE = "border border-destructive/50 text-destructive hover:bg-destructive hover:text-destructive-foreground";
  const BADGE_BASE = "inline-flex items-center rounded-lg border px-2.5 py-0.5 text-[10px] font-bold transition-colors";
  const BADGE_OUTLINE = "border-white/10 text-foreground bg-white/5";
  const BADGE_SECONDARY = "border-white/5 bg-white/5 text-muted-foreground";

  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
    const result = document.createElement(tag);
    if (text !== undefined) result.textContent = text; // Never innerHTML/upstream error text.
    return result;
  };
  const styled = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
    const result = node(tag, text);
    if (className) result.className = className;
    return result;
  };
  /** Inline copy of the lucide svg markup (paths only; icons ship as code). */
  const icon = (paths: string[], className: string, circle?: { cx: string; cy: string; r: string; fill?: string }): SVGSVGElement => {
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
    if (circle) {
      const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      dot.setAttribute("cx", circle.cx); dot.setAttribute("cy", circle.cy); dot.setAttribute("r", circle.r);
      if (circle.fill) dot.setAttribute("fill", circle.fill);
      svg.appendChild(dot);
    }
    return svg;
  };
  const keyRoundIcon = (className: string) => icon([
    "M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z",
  ], className, { cx: "16.5", cy: "7.5", r: ".5", fill: "currentColor" });
  const refreshCwIcon = (className: string) => icon([
    "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8",
    "M21 3v5h-5",
    "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16",
    "M8 16H3v5",
  ], className);
  const plugIcon = (className: string) => icon(["M12 22v-5", "M9 8V2", "M15 8V2", "M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"], className);
  const shieldAlertIcon = (className: string) => icon([
    "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z",
    "M12 8v4", "M12 16h.01",
  ], className);
  const triangleAlertIcon = (className: string) => icon(["m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3", "M12 9v4", "M12 17h.01"], className);

  const badge = (parent: HTMLElement, text: string, variant: "outline" | "secondary", extra = "", role?: string): HTMLElement => {
    const result = styled("span", `${BADGE_BASE} ${variant === "outline" ? BADGE_OUTLINE : BADGE_SECONDARY} ${extra}`, text);
    if (role) result.setAttribute("role", role);
    parent.append(result);
    return result;
  };
  const button = (parent: HTMLElement, text: string, action: () => void, disabled = false, variant: "primary" | "outline" | "destructive" = "outline", extra = "", iconNode?: SVGSVGElement) => {
    const result = styled("button", `${BUTTON_BASE} ${variant === "primary" ? BUTTON_PRIMARY : variant === "destructive" ? BUTTON_DESTRUCTIVE : BUTTON_OUTLINE} ${extra}`, text);
    result.type = "button";
    result.disabled = disabled;
    result.onclick = action;
    if (iconNode) result.prepend(iconNode);
    parent.append(result);
    return result;
  };
  const errorAlert = (text: string, extra = "max-w-md rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-[11px] font-medium text-red-500"): HTMLElement => {
    const alert = styled("p", extra, text);
    alert.setAttribute("role", "alert");
    return alert;
  };
  const readStatus = async () => {
    const next = await props.callApi<GeminiOauthStatusResponse>("/status", { timeoutMs: 10_000 });
    if (alive) { status = next; loadFailed = false; }
  };
  /**
   * Post-commit tail shared by every mutation: reconcile the host config draft,
   * re-read status, then show the settled message. `merge` overrides the draft
   * reconciliation; hide passes its narrow Router cleanup, everything else keeps
   * the plain provider merge (Router and unrelated drafts preserved).
   */
  const settle = async (
    message: string,
    merge?: (current: any, server: any) => any,
  ) => {
    // Draft reconciliation is advisory: the managed mutation already committed
    // server-side, so a failed refresh must neither block the status reread nor
    // flip the confirmed success into a generic retry error. The reconciliation
    // failure is surfaced separately instead (baseline parity).
    let reconciliationFailed = false;
    try {
      // Preserve unrelated providers, Router and local drafts exactly as the old
      // card did. The server remains authoritative for managed entry mutations.
      await props.refreshConfig?.(merge ?? ((current, server) => mergeGeminiOauthProvider(current, server)));
    } catch {
      reconciliationFailed = true;
    }
    await readStatus();
    if (alive) { toast = message; reconcileFailed = reconciliationFailed; confirmDisconnect = false; }
  };
  const endBusy = () => {
    release?.(); release = null;
    if (busy) { busy = false; props.onBusy?.(false); }
  };
  /**
   * One mutation at a time behind the shared management lease (the same mutex
   * the page's Save uses). `pending` identifies the in-flight action for the
   * disabled/inflight UI; every completion is generation-guarded so a superseded
   * or disposed action can never overwrite newer state.
   */
  const run = async (kind: "login" | "sync" | "disconnect" | "hide" | "restore", argument?: string) => {
    if (!alive || busy || loading || props.disabled) return;
    if (props.acquireManagement) {
      release = props.acquireManagement();
      if (!release) { errorKey = "config_busy"; render(); return; }
    }
    busy = true; props.onBusy?.(true); errorKey = null; toast = null; reconcileFailed = false;
    pending = { kind, argument: argument ?? null };
    const generation = ++actionGeneration;
    render();
    try {
      if (kind === "login") {
        // Only the risk dialog's confirmed, acknowledged action reaches here.
        consentGranted = true;
        const current = createGeminiOauthLogin({
          startGeminiOauthLogin: () => post("/login/start"),
          pollGeminiOauthLogin: (loginId, signal) => post("/login/poll", { loginId }, signal),
          cancelGeminiOauthLogin: loginId => post("/login/cancel", { loginId }),
        }, value => {
          if (!alive || !consentGranted) { void current.cancel().catch(() => {}); return; }
          // A superseded login attempt must not surface its window on top of a
          // newer action (same generation guard the other mutations use).
          if (actionGeneration !== generation) { void current.cancel().catch(() => {}); return; }
          login = value;
          window.open(value.url, "_blank", "noopener,noreferrer");
          render();
        });
        session = current;
        const email = await current.done;
        if (!alive || email === null) return;
        if (actionGeneration !== generation) return;
        await settle(email ? t("login_success", { email }) : t("login_success_unknown"));
      } else if (kind === "sync") {
        const result = await post<any>("/sync");
        // A mutation that commits after the card was disposed still reconciles
        // and re-reads status: only the visual settlement is skipped when
        // !alive. The lease is released by the finally below, after all of it.
        if (result?.ok !== true) { if (actionGeneration === generation) errorKey = cardErrorKey(result?.error ?? "gemini_oauth_models_fetch_failed"); await readStatus(); return; }
        const count = result.modelsCount ?? 0;
        await settle(result.clearedRefs?.length
          ? t("synced_cleared", { count, refs: result.clearedRefs.join(", ") }) : t("synced", { count }));
      } else if (kind === "hide" || kind === "restore") {
        const model = argument ?? "";
        if (kind === "hide" && !model) return;
        if (kind === "restore" && model && !(status?.hiddenModels ?? []).includes(model)) return;
        const result = kind === "hide"
          ? await post<any>("/models/hide", { model })
          : await post<any>("/models/restore", model ? { model } : {});
        if (result?.ok !== true) { if (actionGeneration === generation) errorKey = cardErrorKey(result); return; }
        if (kind === "hide") {
          // clearedRefs are Router PATH LABELS for display only — never parsed as
          // provider/model references. Removed refs drive the draft cleanup.
          const paths = sanitizeGeminiOauthRouterPaths(result.clearedRefs)
            .map(path => labelRouterPath(path))
            .filter((label): label is string => label !== null);
          const refs = sanitizeGeminiOauthModelRefs(result.removedModelRefs);
          const removedRefs = refs.length > 0 ? refs : sanitizeGeminiOauthModelRefs([`${GEMINI_OAUTH_PROVIDER_NAME},${model}`]);
          const defaultFallback = typeof result.defaultFallback === "string" ? result.defaultFallback : result.defaultFallback === null ? null : undefined;
          await settle(paths.length
            ? `${t("hidden_toast", { model })} ${t("synced_cleared", { count: (result.models?.length ?? 0), refs: paths.join(", ") })}`
            : t("hidden_toast", { model }),
            (current, server) => mergeGeminiOauthHiddenRefs(current, server, removedRefs, defaultFallback));
        } else {
          const restored = Array.isArray(result.restored) ? result.restored.length : 0;
          await settle(model
            ? t("restored_toast", { model })
            : t("restored_all_toast", { count: restored }));
        }
      } else {
        const result = await post<any>("/disconnect");
        if (result?.ok !== true) { if (actionGeneration === generation) errorKey = cardErrorKey(result); return; }
        await settle(t("disconnected"));
      }
    } catch (error) {
      if (alive && actionGeneration === generation) errorKey = cardErrorKey(error);
    } finally {
      if (actionGeneration === generation) pending = null;
      endBusy(); session = null; login = null; consentGranted = false;
      consentOpen = false; consentAck = false;
      if (alive) render();
    }
  };
  /**
   * Localized display text for a sanitized Router path label reported by hide.
   * Scenario names reuse the existing host `router` labels (only the six known
   * slots carry copy); an unknown slot degrades to its raw (already sanitized)
   * name instead of inventing a translation.
   */
  const labelRouterPath = (path: string): string | null => {
    const [label] = sanitizeGeminiOauthRouterPaths([path]);
    if (!label) return null;
    if (label === "default") return t("router_path.default");
    if (label === "fallback") return t("router_path.scenario", { name: "fallback" });
    if (label.startsWith("scenario:")) {
      // The card bundle carries only the geminiOauth namespace; the host's
      // `router.*` labels are not available here, so the slot name is passed
      // through the localized template instead of a missing key.
      return t("router_path.scenario", { name: label.slice("scenario:".length) });
    }
    if (label.startsWith("models:")) return t("router_path.model_alias", { name: label.slice("models:".length) });
    const family = /^families\.([A-Za-z0-9_-]{1,80})\.default$/.exec(label);
    return family ? t("router_path.family_default", { family: family[1] }) : null;
  };
  /** Modal dialog mirroring the host ui/dialog look (overlay + centered panel). */
  const dialog = (title: string, warning: string, onClose: () => void, titleIcon?: SVGSVGElement): { panel: HTMLDivElement; body: HTMLDivElement; footer: HTMLDivElement } => {
    const overlay = styled("div", "fixed inset-0 z-50 bg-black/80");
    overlay.setAttribute("aria-hidden", "true");
    const panel = styled("div", "fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border bg-background p-6 shadow-lg sm:rounded-lg");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", title);
    const header = styled("div", "flex flex-col space-y-1.5 text-center sm:text-left");
    const heading = styled("h3", "flex items-center gap-2 text-lg font-semibold leading-none tracking-tight", title);
    if (titleIcon) heading.prepend(titleIcon);
    header.append(heading);
    const body = styled("div", "space-y-3");
    body.append(styled("p", "text-sm text-muted-foreground", warning));
    const footer = styled("div", "flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2");
    const close = styled("button", "absolute right-4 top-4 rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2") as HTMLButtonElement;
    close.type = "button";
    close.setAttribute("aria-label", locale === "zh" ? "关闭" : "Close");
    close.append(icon(["M18 6 6 18", "m6 6 12 12"], "h-4 w-4"));
    close.onclick = onClose;
    panel.append(header, body, footer, close);
    el.append(overlay, panel);
    return { panel, body, footer };
  };
  const render = () => {
    if (!alive) return;
    el.replaceChildren();
    el.dataset.testid = "gemini-oauth-card";
    el.setAttribute("aria-busy", String(busy || loading));
    const state = loading ? "loading" : loadFailed && !status ? "error" : geminiOauthStateKey(status);
    const connected = status?.connected === true;
    const disabled = busy || loading || props.disabled;

    const card = styled("div", "glass-card rounded-2xl overflow-hidden mb-4");
    card.setAttribute("aria-busy", String(busy || loading));
    const layout = styled("div", "flex flex-col gap-4 p-5 sm:flex-row sm:items-start sm:justify-between");
    const bodyCol = styled("div", "min-w-0 flex-1 space-y-3");

    const header = styled("div", "flex flex-wrap items-center gap-2");
    header.append(
      keyRoundIcon("h-5 w-5 shrink-0 text-primary"),
      styled("p", "text-lg font-bold tracking-tight text-foreground", t("title")),
    );
    badge(header, t("builtin"), "outline");
    badge(header, t("experimental"), "outline", "border-amber-500/40 text-amber-600");
    if (status) {
      badge(header, t(`kind.${status.kind || "antigravity"}`), "outline", "border-primary/40 text-primary");
    }
    badge(header, t(`status.${state}`), "secondary", "", "status");
    bodyCol.append(header);
    bodyCol.append(styled("p", "max-w-md truncate text-xs font-medium text-muted-foreground/60", t("managed_provider", { name: GEMINI_OAUTH_PROVIDER_NAME })));
    bodyCol.append(styled("p", "max-w-md text-xs text-muted-foreground", t("description")));
    if (connected) {
      const rows = styled("dl", "grid max-w-md grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs");
      for (const [label, value, mono] of [["email", status?.email, true], ["project", status?.project, true], ["tier", status?.tier, false],
        ["models", t("models_count", { count: status?.modelsCount ?? 0 }), false]] as const) {
        rows.append(styled("dt", "text-muted-foreground", t(`labels.${label}`)), styled("dd", `break-all ${mono ? "font-mono " : ""}text-foreground`, value || t("unknown")));
      }
      bodyCol.append(rows);
    }
    const cooldown = formatGeminiOauthClock(status?.cooldownUntil, locale);
    if (cooldown && state === "cooldown") bodyCol.append(styled("p", "text-xs font-medium text-yellow-600", t("cooldown_until", { time: cooldown })));
    if (state === "needs_relogin") bodyCol.append(styled("p", "text-xs text-yellow-600", t("needs_relogin_help")));
    // Model management: one chip per visible model with an accessible hide
    // button, plus a collapsible list of hidden models (restore one / all).
    // Ids are rendered with textContent only, never innerHTML.
    const models = Array.isArray(status?.models) ? status!.models.filter((m): m is string => typeof m === "string" && m.length > 0) : [];
    const hiddenModels = Array.isArray(status?.hiddenModels) ? status!.hiddenModels.filter((m): m is string => typeof m === "string" && m.length > 0) : [];
    if (connected && models.length > 0) {
      const chips = styled("div", "flex max-w-md flex-wrap gap-2 pt-1");
      chips.setAttribute("aria-label", t("labels.models"));
      for (const model of models) {
        const chip = styled("span", "inline-flex max-w-full items-center gap-1 break-all whitespace-normal rounded-lg border border-white/5 bg-white/5 px-2 py-0.5 text-[10px] font-bold text-muted-foreground", model);
        const hide = styled("button", "rounded p-0.5 text-muted-foreground/60 transition-colors hover:bg-white/10 hover:text-foreground disabled:pointer-events-none disabled:opacity-40") as HTMLButtonElement;
        hide.type = "button";
        hide.disabled = disabled;
        hide.setAttribute("aria-label", t("hide_model", { model }));
        hide.setAttribute("aria-busy", String(pending?.kind === "hide" && pending.argument === model));
        hide.append(icon(["M18 6 6 18", "m6 6 12 12"], "h-3 w-3"));
        hide.onclick = () => { void run("hide", model); };
        chip.append(hide);
        chips.append(chip);
      }
      bodyCol.append(chips);
    }
    if (connected && hiddenModels.length > 0) {
      const details = styled("details", "max-w-md text-xs text-muted-foreground");
      details.append(styled("summary", "cursor-pointer select-none font-medium", t("hidden_models", { count: hiddenModels.length })));
      const note = t("hidden_note");
      if (note) details.append(styled("p", "mt-1 text-[11px] text-muted-foreground/70", note));
      const list = styled("ul", "mt-2 space-y-1");
      for (const model of hiddenModels) {
        const item = styled("li", "flex items-center justify-between gap-2");
        item.append(styled("span", "break-all font-mono", model));
        button(item, t("restore"), () => { void run("restore", model); }, disabled || (pending !== null && pending.kind === "restore"), "outline", "h-6 shrink-0 px-2 text-[11px]");
        list.append(item);
      }
      details.append(list);
      button(details, t("restore_all"), () => { void run("restore"); }, disabled || (pending !== null && pending.kind === "restore"), "outline", "mt-2 h-7 px-2 text-[11px]");
      bodyCol.append(details);
    }
    for (const code of [geminiOauthStatusErrorKey(status), errorKey]) {
      if (code) bodyCol.append(errorAlert(t(`errors.${code}`) || t("errors.request_failed")));
    }
    if (reconcileFailed) bodyCol.append(errorAlert(t("errors.reconciliation_failed")));
    const validation = safeValidationUrl(status?.lastError?.validationUrl);
    if (validation) {
      const link = styled("a", "block max-w-md break-all text-xs text-primary underline", validation);
      link.href = validation; link.target = "_blank"; link.rel = "noopener noreferrer";
      bodyCol.append(link);
    }
    if (login) {
      const box = styled("div", "max-w-md space-y-1.5 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-xs");
      box.setAttribute("role", "status");
      box.append(styled("p", "font-medium", t("login_pending")));
      const link = styled("a", "block break-all text-primary underline", t("open_login"));
      link.href = login.url; link.target = "_blank"; link.rel = "noopener noreferrer";
      box.append(link);
      button(box, cancelText, () => { consentGranted = false; void session?.cancel().catch(() => {}); }, false, "outline", "h-7 px-2 text-xs");
      bodyCol.append(box);
    }
    const about = styled("details", "max-w-md text-xs text-muted-foreground");
    about.append(styled("summary", "cursor-pointer select-none font-medium", t("about")));
    const aboutBody = styled("div", "mt-2 space-y-1 leading-relaxed");
    for (const key of ["about_body", "no_content_obfuscation", "single_account"]) aboutBody.append(styled("p", "", t(key)));
    about.append(aboutBody);
    bodyCol.append(about);
    if (props.disabled) bodyCol.append(styled("p", "text-xs text-muted-foreground", t("other_edit")));

    const actions = styled("div", "flex shrink-0 flex-col gap-2 sm:w-[210px]");
    // Deliberately NOT a login: this button only opens the risk dialog.
    button(actions, t(connected ? "reconnect" : "connect"), () => { consentAck = false; consentOpen = true; render(); }, disabled, "primary", "h-8 w-full text-xs", plugIcon("mr-1 h-3.5 w-3.5"));
    button(actions, t("sync"), () => { void run("sync"); }, disabled || !connected, "outline", "h-8 w-full text-xs", refreshCwIcon("mr-1 h-3.5 w-3.5"));
    button(actions, t("disconnect"), () => { confirmDisconnect = true; render(); }, disabled || !status?.configured, "outline", "h-8 w-full text-xs");

    layout.append(bodyCol, actions);
    card.append(layout);
    el.append(card);
    if (toast) {
      const message = styled("p", "flex max-w-md items-center gap-2 rounded-lg border border-green-500/25 bg-green-500/10 px-3 py-2 text-xs font-medium text-green-600", toast);
      message.setAttribute("role", "status");
      el.append(message);
    }
    if (consentOpen) {
      const { body: consentBody, footer } = dialog(t("risk_title"), "", () => { if (!busy) { consentGranted = false; consentOpen = false; consentAck = false; render(); } }, shieldAlertIcon("h-5 w-5 text-red-500"));
      // The risk text is an emphasized alert, not muted description text.
      consentBody.replaceChildren();
      consentBody.append(errorAlert(t("risk"), "rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm font-medium text-red-600"));
      const label = styled("label", "flex items-start gap-2 text-xs text-muted-foreground");
      const ack = styled("input", "mt-0.5");
      ack.type = "checkbox"; ack.checked = consentAck;
      ack.disabled = busy;
      ack.onchange = () => { consentAck = ack.checked; render(); };
      label.append(ack, styled("span", "", t("risk_ack")));
      consentBody.append(label);
      button(footer, cancelText, () => { consentGranted = false; consentOpen = false; consentAck = false; render(); }, busy, "outline", "h-9 rounded-lg px-4");
      button(footer, t("risk_continue"), () => { if (consentAck) void run("login"); }, disabled || !consentAck, "destructive", "h-9 rounded-lg px-4", triangleAlertIcon("mr-1 h-3.5 w-3.5"));
    }
    if (confirmDisconnect) {
      const { footer } = dialog(t("disconnect_title"), t("disconnect_warning"), () => { if (!busy) { confirmDisconnect = false; render(); } });
      button(footer, cancelText, () => { confirmDisconnect = false; render(); }, busy, "outline", "h-9 rounded-lg px-4");
      button(footer, t("disconnect"), () => { void run("disconnect"); }, disabled, "destructive", "h-9 rounded-lg px-4");
    }
  };
  mounted.set(el, () => {
    alive = false; consentGranted = false; consentOpen = false; confirmDisconnect = false;
    unsubscribeHost?.(); unsubscribeHost = null;
    void session?.cancel().catch(() => {});
    // Visual disposal only. The shared management lease deliberately stays held
    // while a deferred sync/disconnect/login (and its config reconciliation)
    // finishes: run()'s finally releases it. Releasing here let a full-config
    // save race the still-pending managed mutation after navigation/unmount.
    busy = false;
    el.replaceChildren();
  });
  // Host state changes (e.g. the page Save gate) re-render the card in place —
  // never via a remount, which would cancel in-flight actions.
  unsubscribeHost = props.onHostChange?.(() => { if (alive) render(); }) ?? null;
  render();
  // Only local status on mount. Never start login, sync models or poll here.
  void readStatus().catch(() => { if (alive) { loadFailed = true; errorKey = "request_failed"; } })
    .finally(() => { if (alive) { loading = false; render(); } });
}

export function unmount(el: HTMLElement): void {
  mounted.get(el)?.(); mounted.delete(el);
}
export default { mount, unmount };
