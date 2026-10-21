/** Self-contained DOM card: no React, host imports or direct fetch. All
 * state/network/config interactions flow through the host card capabilities. */
import type { PluginCardMountProps } from "../../../ui/src/utils/plugin-card";
import type { GeminiOauthStatusResponse, GeminiOauthLoginStartResponse } from "../../../ui/src/types";
import {
  geminiOauthStateKey, geminiOauthErrorKey, geminiOauthStatusErrorKey,
  formatGeminiOauthClock, safeValidationUrl, mergeGeminiOauthProvider,
} from "../../../ui/src/utils/gemini-oauth";
import { createGeminiOauthLogin } from "../../../ui/src/utils/gemini-oauth-login";
import { geminiOauthLocales } from "./locales";

const mounted = new WeakMap<HTMLElement, () => void>();

export function mount(el: HTMLElement, props: PluginCardMountProps): void {
  unmount(el);
  let alive = true, busy = false, loading = true, loadFailed = false;
  let status: GeminiOauthStatusResponse | null = null;
  let errorKey: string | null = null, toast: string | null = null;
  let consentOpen = false, consentAck = false, confirmDisconnect = false;
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
  const cancelText = locale === "zh" ? "取消" : "Cancel";
  const post = <T,>(path: string, body: any = {}, signal?: AbortSignal) => props.callApi<T>(path, {
    method: "POST", body: JSON.stringify(body), signal,
    timeoutMs: path === "/sync" ? 60_000 : 30_000,
  });
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
    const result = document.createElement(tag);
    if (text !== undefined) result.textContent = text; // Never innerHTML/upstream error text.
    return result;
  };
  const button = (parent: HTMLElement, text: string, action: () => void, disabled = false) => {
    const result = node("button", text);
    result.type = "button";
    result.disabled = disabled;
    result.onclick = action;
    result.style.cssText = "padding:6px 12px;border:1px solid currentColor;border-radius:6px;margin:4px;font:inherit;cursor:pointer";
    parent.append(result);
    return result;
  };
  const readStatus = async () => {
    const next = await props.callApi<GeminiOauthStatusResponse>("/status", { timeoutMs: 10_000 });
    if (alive) { status = next; loadFailed = false; }
  };
  const settle = async (message: string) => {
    // Draft reconciliation is advisory: the managed mutation already committed
    // server-side, so a failed refresh must neither block the status reread nor
    // flip the confirmed success into a generic retry error. The reconciliation
    // failure is surfaced separately instead (baseline parity).
    let reconciliationFailed = false;
    try {
      // Preserve unrelated providers, Router and local drafts exactly as the old
      // card did. The server remains authoritative for managed entry mutations.
      await props.refreshConfig?.((current, server) => mergeGeminiOauthProvider(current, server));
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
  const run = async (kind: "login" | "sync" | "disconnect") => {
    if (!alive || busy || loading || props.disabled) return;
    if (props.acquireManagement) {
      release = props.acquireManagement();
      if (!release) { errorKey = "config_busy"; render(); return; }
    }
    busy = true; props.onBusy?.(true); errorKey = null; toast = null; reconcileFailed = false;
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
          login = value;
          window.open(value.url, "_blank", "noopener,noreferrer");
          render();
        });
        session = current;
        const email = await current.done;
        if (!alive || email === null) return;
        await settle(email ? t("login_success", { email }) : t("login_success_unknown"));
      } else if (kind === "sync") {
        const result = await post<any>("/sync");
        // A mutation that commits after the card was disposed still reconciles
        // and re-reads status: only the visual settlement is skipped when
        // !alive. The lease is released by the finally below, after all of it.
        if (result?.ok !== true) { errorKey = geminiOauthErrorKey(result?.error ?? "gemini_oauth_models_fetch_failed"); await readStatus(); return; }
        const count = result.modelsCount ?? 0;
        await settle(result.clearedRefs?.length
          ? t("synced_cleared", { count, refs: result.clearedRefs.join(", ") }) : t("synced", { count }));
      } else {
        const result = await post<any>("/disconnect");
        if (result?.ok !== true) { errorKey = geminiOauthErrorKey(result); return; }
        await settle(t("disconnected"));
      }
    } catch (error) {
      if (alive) errorKey = geminiOauthErrorKey(error);
    } finally {
      endBusy(); session = null; login = null; consentGranted = false;
      consentOpen = false; consentAck = false;
      if (alive) render();
    }
  };
  const dialog = (title: string, warning: string): HTMLDivElement => {
    const panel = node("div");
    panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", title);
    panel.style.cssText = "padding:16px;margin-top:12px;border:2px solid #b45309;border-radius:8px";
    panel.append(node("h3", title), node("p", warning)); el.append(panel); return panel;
  };
  const render = () => {
    if (!alive) return;
    el.replaceChildren();
    el.style.cssText = "border:1px solid #8886;border-radius:12px;padding:20px;margin-bottom:16px;font-size:14px";
    el.dataset.testid = "gemini-oauth-card";
    el.setAttribute("aria-busy", String(busy || loading));
    const state = loading ? "loading" : loadFailed && !status ? "error" : geminiOauthStateKey(status);
    el.append(node("h2", `${t("title")} · ${t("experimental")}`));
    const stateLine = node("p", t(`status.${state}`)); stateLine.setAttribute("role", "status"); el.append(stateLine);
    el.append(node("p", t("description")));
    const connected = status?.connected === true;
    if (connected) {
      const rows = node("dl");
      for (const [label, value] of [["email", status?.email], ["project", status?.project], ["tier", status?.tier],
        ["models", t("models_count", { count: status?.modelsCount ?? 0 })]]) {
        rows.append(node("dt", t(`labels.${label}`)), node("dd", value || t("unknown")));
      }
      el.append(rows);
    }
    const cooldown = formatGeminiOauthClock(status?.cooldownUntil, locale);
    if (cooldown && state === "cooldown") el.append(node("p", t("cooldown_until", { time: cooldown })));
    if (state === "needs_relogin") el.append(node("p", t("needs_relogin_help")));
    for (const code of [geminiOauthStatusErrorKey(status), errorKey]) {
      if (code) { const alert = node("p", t(`errors.${code}`) || t("errors.request_failed")); alert.setAttribute("role", "alert"); el.append(alert); }
    }
    if (reconcileFailed) { const note = node("p", t("errors.reconciliation_failed")); note.setAttribute("role", "alert"); el.append(note); }
    const validation = safeValidationUrl(status?.lastError?.validationUrl);
    if (validation) { const link = node("a", validation); link.href = validation; link.target = "_blank"; link.rel = "noopener noreferrer"; el.append(link); }
    const disabled = busy || loading || props.disabled;
    button(el, t(connected ? "reconnect" : "connect"), () => { consentAck = false; consentOpen = true; render(); }, disabled);
    button(el, t("sync"), () => { void run("sync"); }, disabled || !connected);
    button(el, t("disconnect"), () => { confirmDisconnect = true; render(); }, disabled || !status?.configured);
    const about = node("details"); about.append(node("summary", t("about")));
    for (const key of ["about_body", "no_content_obfuscation", "single_account"]) about.append(node("p", t(key)));
    el.append(about);
    if (props.disabled) el.append(node("p", t("other_edit")));
    if (toast) { const message = node("p", toast); message.setAttribute("role", "status"); el.append(message); }
    if (consentOpen) {
      const panel = dialog(t("risk_title"), t("risk"));
      const label = node("label"); const ack = node("input"); ack.type = "checkbox"; ack.checked = consentAck;
      ack.disabled = busy;
      ack.onchange = () => { consentAck = ack.checked; render(); };
      label.append(ack, node("span", t("risk_ack"))); panel.append(label);
      button(panel, cancelText, () => { consentGranted = false; consentOpen = false; consentAck = false; render(); }, busy);
      button(panel, t("risk_continue"), () => { if (consentAck) void run("login"); }, disabled || !consentAck);
    }
    if (confirmDisconnect) {
      const panel = dialog(t("disconnect_title"), t("disconnect_warning"));
      button(panel, cancelText, () => { confirmDisconnect = false; render(); }, busy);
      button(panel, t("disconnect"), () => { void run("disconnect"); }, disabled);
    }
    if (login) {
      el.append(node("p", t("login_pending")));
      const link = node("a", t("open_login")); link.href = login.url; link.target = "_blank"; link.rel = "noopener noreferrer"; el.append(link);
      button(el, cancelText, () => { consentGranted = false; void session?.cancel().catch(() => {}); });
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
