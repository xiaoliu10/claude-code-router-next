import type { PluginCardMountProps } from "../../../ui/src/utils/plugin-card";
import { grokLocales } from "./locales";
import { GROK_PROVIDER, mergeGrokProvider, validDeviceUrl } from "./protocol";

// Family card vocabulary, shared verbatim across plugin cards (codex/qoder/workbuddy).
const BUTTON_BASE = "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-semibold ring-offset-background transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 active:scale-95";
const BUTTON_PRIMARY = "bg-primary text-primary-foreground shadow-lg shadow-primary/20 hover:bg-primary/90 hover:shadow-xl hover:shadow-primary/30";
const BUTTON_OUTLINE = "border border-input bg-input/50 backdrop-blur-md shadow-sm hover:bg-input/80 hover:border-primary/50 hover:shadow-md hover:text-accent-foreground";
const BUTTON_DESTRUCTIVE = "border border-destructive/50 text-destructive hover:bg-destructive hover:text-destructive-foreground";


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
const refreshCwIcon = (className: string) => icon([
  "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8",
  "M21 3v5h-5",
  "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16",
  "M8 16H3v5",
], className);
const plugIcon = (className: string) => icon(["M12 22v-5", "M9 8V2", "M15 8V2", "M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"], className);
const coinsIcon = (className: string) => icon([
  "M18.09 10.37A6 6 0 1 1 10.34 18",
  "M7 6h1v4",
  "m16.71 13.88.7.71-2.82 2.82",
], className);

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
  // Family button builders: action-column rows (h-8 full width) and small list
  // row buttons (h-6), matching codex/qoder/workbuddy exactly.
  const action = (label: string, fn: () => void, opts: { variant?: "primary" | "destructive"; icon?: SVGSVGElement; canCancel?: boolean } = {}) => {
    const button = node("button", words[label], `${BUTTON_BASE} ${opts.variant === "primary" ? BUTTON_PRIMARY : opts.variant === "destructive" ? BUTTON_DESTRUCTIVE : BUTTON_OUTLINE} h-8 w-full text-xs`) as HTMLButtonElement;
    if (opts.icon) button.prepend(opts.icon);
    button.disabled = disposed || props.disabled || (busy && !opts.canCancel);
    button.onclick = fn; return button;
  };
  const rowButton = (label: string, fn: () => void) => {
    const button = node("button", words[label], `${BUTTON_BASE} ${BUTTON_OUTLINE} h-6 shrink-0 px-2 text-[11px]`) as HTMLButtonElement;
    button.disabled = disposed || props.disabled || busy;
    button.onclick = fn; return button;
  };
  const render = () => {
    if (disposed) return;
    el.replaceChildren();
    const card = node("section", "", "glass-card rounded-2xl overflow-hidden mb-4");
    const layout = node("div", "", "flex flex-col gap-4 p-5 sm:flex-row sm:items-start sm:justify-between");
    const body = node("div", "", "min-w-0 flex-1 space-y-3");
    const actions = node("div", "", "flex shrink-0 flex-col gap-2 sm:w-[210px]");
    body.append(node("h3", words.title, "font-semibold text-lg"), node("p", words.description, "text-sm text-muted-foreground"));
    body.append(node("p", status ? words[status.status] ?? words.error : words.loading));
    if (status?.account) body.append(node("p", `${words.account}: ${status.account}`, "text-sm text-muted-foreground"));
    if (error) body.append(node("p", words.error, "text-destructive text-sm"));
    if (loginId) {
      body.append(node("p", words.pending, "text-sm text-muted-foreground"));
      if (opened) body.append(node("p", words.opened, "text-sm text-muted-foreground"));
      const link = node("a", words.open, "text-sm underline break-all text-primary") as HTMLAnchorElement;
      link.href = loginUrl; link.target = "_blank"; link.rel = "noopener noreferrer"; body.append(link);
    }
    body.append(node("p", usage?.known ? `${usage.stale ? words.stale : words.used}: ${usage.usedPercent}%` : words.unknown, "text-sm text-muted-foreground"));
    if (status?.coolingUntil > Date.now()) body.append(node("p", `${words.cooling}: ${new Date(status.coolingUntil).toLocaleString()}`, "text-sm text-muted-foreground"));
    body.append(node("h4", words.models, "mt-2 font-medium"));
    if (!status?.models?.length) body.append(node("p", words.noModels, "text-sm text-muted-foreground"));
    for (const model of status?.models ?? []) {
      const row = node("div", "", "flex items-center justify-between gap-2");
      row.append(node("span", `${model.id}${model.context ? ` · ${model.context}` : ""}`, "min-w-0 break-all text-sm"));
      row.append(rowButton(model.hidden ? "restore" : "hide", () => void run(async () => { await call("/models/visibility", { model: model.id, hidden: !model.hidden }); await reconcile(); await refresh(); })));
      body.append(row);
    }
    if (status?.status === "not_connected") {
      actions.append(action("login", () => void run(async () => {
        const result = await call("/login/start", {});
        if (!validDeviceUrl(result.url) || !/^[a-f0-9]{32}$/.test(result.loginId) || !Number.isFinite(result.expiresAt)) throw 0;
        loginId = result.loginId; loginUrl = result.url; opened = result.opened === true;
        if (disposed) { await cancel(); return; }
        void poll(result.expiresAt);
      }, true), { variant: "primary", icon: plugIcon("h-3.5 w-3.5 shrink-0") }));
      actions.append(action("import", () => void run(async () => { await call("/import", {}); await reconcile(); await refresh(); })));
      if (loginId) actions.append(action("cancel", () => void cancel().catch(() => { error = true; render(); }), { canCancel: true }));
    } else if (status) {
      actions.append(action("sync", () => void run(async () => { await call("/sync", {}); await reconcile(); await refresh(); }), { icon: refreshCwIcon("h-3.5 w-3.5 shrink-0") }));
      actions.append(action("usage", () => void run(async () => { usage = await call("/usage", {}); }), { icon: coinsIcon("h-3.5 w-3.5 shrink-0") }));
      actions.append(action("disconnect", () => void run(async () => { await call("/disconnect", {}); usage = undefined; await reconcile(); await refresh(); }), { variant: "destructive" }));
    }
    actions.append(action("refresh", () => void run(refresh), { icon: refreshCwIcon("h-3.5 w-3.5 shrink-0") }));
    layout.append(body, actions);
    card.append(layout);
    el.append(card);
  };
  const off = props.onHostChange?.(render);
  mounted.set(el, () => { disposed = true; off?.(); clearTimeout(pollTimer); abort.abort(); if (loginId) void cancel().catch(() => {}); });
  render(); void refresh().catch(() => { error = true; render(); });
  if (props.focusKey === GROK_PROVIDER) { el.tabIndex = -1; el.focus(); el.scrollIntoView?.({ block: "nearest" }); }
}
export function unmount(el: HTMLElement): void { mounted.get(el)?.(); mounted.delete(el); el.replaceChildren(); }
export default { mount, unmount };
