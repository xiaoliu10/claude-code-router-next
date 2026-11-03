import type { PluginCardMountProps } from "../../../ui/src/utils/plugin-card";
import { grokLocales } from "./locales";
import { GROK_PROVIDER, mergeGrokProvider, validDeviceUrl } from "./protocol";
const mounted = new WeakMap<HTMLElement, () => void>();
export function mount(el: HTMLElement, props: PluginCardMountProps): void {
  unmount(el);
  const lang = props.locale.toLowerCase().startsWith("zh") ? "zh" : "en";
  const words = { ...grokLocales[lang].grok, ...((props.locales as any)?.[lang]?.grok ?? {}) } as Record<string, string>;
  let status: any, usage: any, error = false, disposed = false, busy = false, loginId: string | undefined, loginUrl = "", opened = false;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let release: (() => void) | undefined;
  const abort = new AbortController();
  const call = <T = any>(path: string, body?: any): Promise<T> => props.callApi<T>(path, {
    method: body === undefined ? "GET" : "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: abort.signal, timeoutMs: path === "/login/start" ? 35000 : 45000,
  });
  const node = (tag: string, text: string, cls = "") => { const n = document.createElement(tag); n.textContent = text; n.className = cls; return n; };
  const finish = () => { busy = false; release?.(); release = undefined; props.onBusy?.(false); if (!disposed) render(); };
  const refresh = async () => { status = await call("/status"); if (!disposed) render(); };
  const reconcile = () => props.refreshConfig?.(mergeGrokProvider);
  const run = async (fn: () => Promise<void>, hold = false) => {
    if (disposed || busy || props.disabled || !props.acquireManagement) return;
    const lease = props.acquireManagement(); if (!lease) return;
    release = lease; busy = true; error = false; props.onBusy?.(true); render();
    try { await fn(); } catch { error = true; }
    finally { if (!hold || !loginId || error) finish(); else if (!disposed) render(); }
  };
  const cancel = async () => {
    if (!loginId) return;
    const id = loginId; loginId = undefined;
    clearTimeout(pollTimer);
    try { await props.callApi("/login/cancel", { method: "POST", body: JSON.stringify({ loginId: id }), timeoutMs: 45000 }); }
    finally { finish(); }
  };
  const poll = async (expiresAt: number) => {
    if (disposed || !loginId) return;
    try {
      if (Date.now() >= expiresAt) { await cancel(); error = true; render(); return; }
      const result = await call("/login/poll", { loginId });
      if (disposed) return;
      if (result.status === "pending") pollTimer = setTimeout(() => void poll(expiresAt), 1000);
      else {
        loginId = undefined;
        if (result.status !== "connected") error = true;
        await reconcile(); await refresh(); finish();
      }
    } catch { error = true; await cancel().catch(() => {}); if (!disposed) render(); }
  };
  const action = (label: string, fn: () => void, canCancel = false) => {
    const button = node("button", words[label], "px-3 py-2 rounded-md bg-secondary text-secondary-foreground hover:bg-secondary/80 disabled:opacity-50") as HTMLButtonElement;
    button.disabled = disposed || props.disabled || (busy && !canCancel);
    button.onclick = fn; return button;
  };
  const render = () => {
    if (disposed) return;
    el.replaceChildren();
    const card = node("section", "", "glass-card rounded-xl p-5 space-y-3");
    card.append(node("h3", words.title, "font-semibold text-lg"), node("p", words.description, "text-sm text-muted-foreground"));
    card.append(node("p", status ? words[status.status] ?? words.error : words.loading));
    if (status?.account) card.append(node("p", `${words.account}: ${status.account}`));
    if (error) card.append(node("p", words.error, "text-destructive"));
    const buttons = node("div", "", "flex flex-wrap gap-2");
    if (status?.status === "not_connected") {
      buttons.append(action("import", () => void run(async () => { await call("/import", {}); await reconcile(); await refresh(); })));
      buttons.append(action("login", () => void run(async () => {
        const result = await call("/login/start", {});
        if (!validDeviceUrl(result.url) || !/^[a-f0-9]{32}$/.test(result.loginId) || !Number.isFinite(result.expiresAt)) throw 0;
        loginId = result.loginId; loginUrl = result.url; opened = result.opened === true;
        if (disposed) { await cancel(); return; }
        void poll(result.expiresAt);
      }, true)));
    } else if (status) {
      buttons.append(action("sync", () => void run(async () => { await call("/sync", {}); await reconcile(); await refresh(); })));
      buttons.append(action("usage", () => void run(async () => { usage = await call("/usage", {}); })));
      buttons.append(action("disconnect", () => void run(async () => { await call("/disconnect", {}); usage = undefined; await reconcile(); await refresh(); })));
    }
    buttons.append(action("refresh", () => void run(refresh)));
    if (loginId) {
      card.append(node("p", words.pending));
      if (opened) card.append(node("p", words.opened));
      const link = node("a", words.open, "text-primary underline") as HTMLAnchorElement;
      link.href = loginUrl; link.target = "_blank"; link.rel = "noopener noreferrer"; card.append(link);
      buttons.append(action("cancel", () => void cancel().catch(() => { error = true; render(); }), true));
    }
    card.append(buttons);
    card.append(node("p", usage?.known ? `${usage.stale ? words.stale : words.used}: ${usage.usedPercent}%` : words.unknown, "text-sm text-muted-foreground"));
    if (status?.coolingUntil > Date.now()) card.append(node("p", `${words.cooling}: ${new Date(status.coolingUntil).toLocaleString()}`));
    card.append(node("h4", words.models, "font-medium"));
    if (!status?.models?.length) card.append(node("p", words.noModels, "text-sm text-muted-foreground"));
    for (const model of status?.models ?? []) {
      const row = node("div", "", "flex items-center justify-between gap-2");
      row.append(node("span", `${model.id}${model.context ? ` · ${model.context}` : ""}`, "text-sm"));
      row.append(action(model.hidden ? "restore" : "hide", () => void run(async () => { await call("/models/visibility", { model: model.id, hidden: !model.hidden }); await reconcile(); await refresh(); })));
      card.append(row);
    }
    el.append(card);
  };
  const off = props.onHostChange?.(render);
  mounted.set(el, () => { disposed = true; off?.(); clearTimeout(pollTimer); abort.abort(); if (loginId) void cancel().catch(() => {}); });
  render(); void refresh().catch(() => { error = true; render(); });
  if (props.focusKey === GROK_PROVIDER) { el.tabIndex = -1; el.focus(); el.scrollIntoView?.({ block: "nearest" }); }
}
export function unmount(el: HTMLElement): void { mounted.get(el)?.(); mounted.delete(el); el.replaceChildren(); }
export default { mount, unmount };
