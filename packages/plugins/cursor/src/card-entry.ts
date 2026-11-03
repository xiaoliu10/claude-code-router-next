import type { PluginCardMountProps } from "../../../ui/src/utils/plugin-card";
import { cursorLocales } from "./locales";
import { mergeCursorProvider, CURSOR_PROVIDER } from "./protocol";

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

/**
 * The Cursor card. Not connected it offers the three sign-ins Cursor accounts
 * have — browser PKCE (start → poll → cancel), the cursor-agent CLI import,
 * and the API-key exchange; connected it shows account, quota windows
 * (UNKNOWN-tolerant), models and management. Quota evidence comes from a
 * remote payload and is rendered defensively: unknown shape renders as
 * "Quota unknown", never as fabricated numbers.
 *
 * Layout follows the family skeleton (codex/qoder/workbuddy): body left,
 * fixed-width action column right, shared button vocabulary.
 */

const mounted = new WeakMap<HTMLElement, () => void>();
export function mount(el: HTMLElement, props: PluginCardMountProps): void {
  unmount(el);
  const lang = props.locale.toLowerCase().startsWith("zh") ? "zh" : "en";
  const words = { ...cursorLocales[lang].cursor, ...((props.locales as any)?.[lang]?.cursor ?? {}) } as Record<string, string>;
  const prefix = "/cursor";
  let status: any, usage: any, error = false, busy = false, disposed = false;
  let draft = "";
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let release: (() => void) | undefined;
  const abort = new AbortController();
  const call = <T = any>(path: string, body?: any): Promise<T> => props.callApi<T>(`${prefix}${path}`, {
    method: body === undefined ? "GET" : "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: abort.signal, timeoutMs: 45000,
  });
  const node = (tag: string, text: string, cls = "") => { const n = document.createElement(tag); n.textContent = text; n.className = cls; return n; };
  const finish = () => {
    busy = false; release?.(); release = undefined;
    // onBusy is a COUNTING semaphore on the host (increment/decrement), not a
    // boolean state, so the release must be the exact balancing `false`.
    props.onBusy?.(false);
    if (!disposed) render();
  };
  const refresh = async () => { status = await call("/status"); if (!disposed) render(); };
  const reconcile = () => props.refreshConfig?.((current: any, server: any) => mergeCursorProvider(current, server));
  const run = async (fn: () => Promise<void>) => {
    if (disposed || busy || props.disabled || !props.acquireManagement) return;
    const lease = props.acquireManagement(); if (!lease) return;
    release = lease; busy = true; error = false; props.onBusy?.(true); render();
    try { await fn(); } catch { error = true; }
    finally { finish(); }
  };
  // The browser sign-in needs no management lease: it owns a long-running
  // poll of its own, and its state lives server-side.
  const login = () => void run(async () => {
    await call("/login/browser", {});
    await refresh();
    schedulePoll();
  });
  const schedulePoll = () => {
    if (disposed) return;
    clearTimeout(pollTimer);
    pollTimer = setTimeout(() => void (async () => {
      try {
        const state = await call<any>("/login/state");
        if (disposed) return;
        if (state?.state === "pending") { schedulePoll(); }
        else { await refresh(); }
      } catch { /* the next action re-renders */ }
    })(), 2000);
  };
  const cancelLogin = () => void run(async () => { await call("/login/cancel", {}); await refresh(); });
  const connectApiKey = (input: HTMLInputElement) => void run(async () => {
    const key = input.value;
    try {
      await call("/connect", { apiKey: key });
      // The key never lingers: cleared immediately, never rendered or logged.
      input.value = ""; draft = "";
      await reconcile(); await refresh();
    } catch (e) {
      input.value = ""; draft = "";
      throw e;
    }
  });
  // Family button builders: action-column rows (h-8 full width) — matching
  // codex/qoder/workbuddy exactly.
  const action = (label: string, fn: () => void, opts: { variant?: "primary" | "destructive"; icon?: SVGSVGElement } = {}) => {
    const button = node("button", words[label], `${BUTTON_BASE} ${opts.variant === "primary" ? BUTTON_PRIMARY : opts.variant === "destructive" ? BUTTON_DESTRUCTIVE : BUTTON_OUTLINE} h-8 w-full text-xs`) as HTMLButtonElement;
    if (opts.icon) button.prepend(opts.icon);
    button.disabled = disposed || props.disabled || busy;
    button.onclick = fn; return button;
  };
  const renderLoginPending = (panel: HTMLElement) => {
    const state = status?.login?.state;
    if (state !== "pending") return false;
    panel.append(node("p", words.browserWaiting, "text-sm text-muted-foreground"));
    if (status.login.url) {
      const link = node("a", words.openBrowser, "text-sm underline break-all text-primary") as HTMLAnchorElement;
      link.href = status.login.url; link.target = "_blank"; link.rel = "noopener noreferrer";
      panel.append(link, node("p", `${words.loginUrl} ${status.login.url}`, "text-xs text-muted-foreground break-all"));
    }
    return true;
  };
  const renderNotConnected = (panel: HTMLElement) => {
    const last = status?.login?.state;
    if (last === "failed" || last === "cancelled") {
      panel.append(node("p", last === "failed" ? `${words.loginFailed}${status.login.error ? `: ${status.login.error}` : ""}` : words.loginCancelled, "text-destructive text-sm"));
    }
    panel.append(node("p", words.cliHint, "text-xs text-muted-foreground"));
    // API-key form: password-typed input so the key never shows on screen.
    const input = node("input", "", "w-full rounded-xl border border-input bg-input/50 px-3 py-2 text-sm backdrop-blur-md") as HTMLInputElement;
    input.type = "password"; input.placeholder = words.apiKeyPlaceholder; input.autocomplete = "off";
    input.setAttribute("aria-label", words.apiKey);
    input.value = draft;
    input.oninput = () => { draft = input.value; };
    const connectButton = node("button", words.connect, `${BUTTON_BASE} ${BUTTON_OUTLINE} h-8 shrink-0 px-3 text-xs`) as HTMLButtonElement;
    connectButton.disabled = disposed || props.disabled || busy;
    const connect = () => connectApiKey(input);
    connectButton.onclick = connect;
    input.onkeydown = e => { if (e.key === "Enter") connect(); };
    const keyRow = node("div", "", "flex gap-2 items-center");
    keyRow.append(input, connectButton);
    panel.append(node("p", words.apiKey, "text-sm font-medium"), keyRow,
      node("p", words.apiKeyHint, "text-xs text-muted-foreground"));
  };
  const renderConnected = (panel: HTMLElement) => {
    if (status?.expired) panel.append(node("p", words.expired, "text-destructive text-sm"));
    if (status?.account) panel.append(node("p", `${words.account}: ${status.account}${status.plan ? ` · ${status.plan}` : ""}`, "text-sm text-muted-foreground"));
    // Usage windows: render defensively — shape comes from a remote payload.
    const usageLine = node("p", "", "text-sm text-muted-foreground");
    if (usage?.known && Array.isArray(usage.windows) && usage.windows.length) {
      usageLine.textContent = `${usage.stale ? words.stale : words.used}: ` +
        usage.windows.map((w: any) => {
          const name = typeof w?.name === "string" ? w.name.slice(0, 100) : "?";
          const detail = typeof w?.display === "string" && w.display
            ? w.display : Number.isFinite(w?.used) ? `${Math.round(w.used)}%` : "?";
          return `${name}: ${detail}`;
        }).join(" · ");
    } else usageLine.textContent = words.unknown;
    panel.append(usageLine);
    if (status?.coolingUntil > Date.now()) panel.append(node("p", `${words.cooling}: ${new Date(status.coolingUntil).toLocaleString()}`, "text-sm text-muted-foreground"));
    panel.append(node("h4", words.models, "mt-2 font-medium"));
    if (!status?.models?.length) panel.append(node("p", words.noModels, "text-sm text-muted-foreground"));
    for (const model of status?.models ?? []) {
      panel.append(node("div", `${model.id}${model.context ? ` · ${model.context}` : ""}`, "min-w-0 break-all text-sm"));
    }
  };
  const render = () => {
    if (disposed) return;
    el.replaceChildren();
    const card = node("section", "", "glass-card rounded-2xl overflow-hidden mb-4");
    const layout = node("div", "", "flex flex-col gap-4 p-5 sm:flex-row sm:items-start sm:justify-between");
    const body = node("div", "", "min-w-0 flex-1 space-y-3");
    const actions = node("div", "", "flex shrink-0 flex-col gap-2 sm:w-[210px]");
    body.append(node("h3", words.title, "font-semibold text-lg"),
      node("p", words.description, "text-sm text-muted-foreground"));
    body.append(node("p", status ? words[status.status] ?? words.error : words.loading));
    if (error) body.append(node("p", words.error, "text-destructive text-sm"));
    const pending = status ? renderLoginPending(body) : false;
    if (status?.status === "connected") renderConnected(body);
    else if (status && !pending) renderNotConnected(body);
    const isConnected = status?.status === "connected";
    if (pending) {
      actions.append(action("cancelLogin", cancelLogin, { icon: plugIcon("h-3.5 w-3.5 shrink-0") }));
    } else if (isConnected) {
      actions.append(action("sync", () => void run(async () => { await call("/sync", {}); await reconcile(); await refresh(); }), { icon: refreshCwIcon("h-3.5 w-3.5 shrink-0") }));
      actions.append(action("usage", () => void run(async () => { usage = await call("/usage", {}); }), { icon: coinsIcon("h-3.5 w-3.5 shrink-0") }));
      actions.append(action("disconnect", () => void run(async () => {
        await call("/disconnect", {}); usage = undefined; await reconcile(); await refresh();
      }), { variant: "destructive" }));
    } else if (status) {
      actions.append(action("browserLogin", login, { variant: "primary", icon: plugIcon("h-3.5 w-3.5 shrink-0") }));
      actions.append(action("cliLogin", () => void run(async () => { await call("/login/cli", {}); await reconcile(); await refresh(); })));
    }
    actions.append(action("refresh", () => void run(() => refresh()), { icon: refreshCwIcon("h-3.5 w-3.5 shrink-0") }));
    layout.append(body, actions);
    card.append(layout);
    el.append(card);
  };
  const load = () => void refresh().catch(() => { error = true; if (!disposed) render(); });
  const off = props.onHostChange?.(render);
  mounted.set(el, () => {
    disposed = true; clearTimeout(pollTimer); off?.(); abort.abort();
  });
  render();
  load();
}
export function unmount(el: HTMLElement): void { mounted.get(el)?.(); mounted.delete(el); el.replaceChildren(); }
export default { mount, unmount };
