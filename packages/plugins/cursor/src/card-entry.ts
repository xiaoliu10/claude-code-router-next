import type { PluginCardMountProps } from "../../../ui/src/utils/plugin-card";
import { cursorLocales } from "./locales";
import { mergeCursorProvider, CURSOR_PROVIDER } from "./protocol";

/**
 * The Cursor card. Not connected it offers the three sign-ins Cursor accounts
 * have — browser PKCE (start → poll → cancel), the cursor-agent CLI import,
 * and the API-key exchange; connected it shows account, quota windows
 * (UNKNOWN-tolerant), models and management. Quota evidence comes from a
 * remote payload and is rendered defensively: unknown shape renders as
 * "Quota unknown", never as fabricated numbers.
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
  const action = (label: string, fn: () => void, destructive = false) => {
    const button = node("button", words[label], `px-3 py-2 rounded-md ${destructive ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : "bg-secondary text-secondary-foreground hover:bg-secondary/80"} disabled:opacity-50`) as HTMLButtonElement;
    button.disabled = disposed || props.disabled || busy;
    button.onclick = fn; return button;
  };
  const renderLoginPending = (panel: HTMLElement) => {
    const state = status?.login?.state;
    if (state !== "pending") return false;
    panel.append(node("p", words.browserWaiting, "text-sm text-muted-foreground"));
    if (status.login.url) {
      const link = node("a", words.openBrowser, "text-sm underline break-all") as HTMLAnchorElement;
      link.href = status.login.url; link.target = "_blank"; link.rel = "noopener noreferrer";
      panel.append(link, node("p", `${words.loginUrl} ${status.login.url}`, "text-xs text-muted-foreground break-all"));
    }
    const cancelRow = node("div", "", "flex gap-2");
    cancelRow.append(action("cancelLogin", cancelLogin));
    panel.append(cancelRow);
    return true;
  };
  const renderNotConnected = (panel: HTMLElement) => {
    const last = status?.login?.state;
    if (last === "failed" || last === "cancelled") {
      panel.append(node("p", last === "failed" ? `${words.loginFailed}${status.login.error ? `: ${status.login.error}` : ""}` : words.loginCancelled, "text-destructive text-sm"));
    }
    panel.append(action("browserLogin", login));
    const cli = action("cliLogin", () => void run(async () => { await call("/login/cli", {}); await reconcile(); await refresh(); }));
    panel.append(cli, node("p", words.cliHint, "text-xs text-muted-foreground"));
    // API-key form: password-typed input so the key never shows on screen.
    const input = node("input", "", "w-full rounded-md border border-input bg-background px-3 py-2 text-sm") as HTMLInputElement;
    input.type = "password"; input.placeholder = words.apiKeyPlaceholder; input.autocomplete = "off";
    input.setAttribute("aria-label", words.apiKey);
    input.value = draft;
    input.oninput = () => { draft = input.value; };
    const connectButton = action("connect", () => connectApiKey(input));
    input.onkeydown = e => { if (e.key === "Enter") connectApiKey(input); };
    const keyRow = node("div", "", "flex gap-2 items-center");
    keyRow.append(input, connectButton);
    panel.append(node("p", words.apiKey, "text-sm font-medium"), keyRow,
      node("p", words.apiKeyHint, "text-xs text-muted-foreground"));
  };
  const renderConnected = (panel: HTMLElement) => {
    if (status?.expired) panel.append(node("p", words.expired, "text-destructive"));
    if (status?.account) panel.append(node("p", `${words.account}: ${status.account}${status.plan ? ` · ${status.plan}` : ""}`));
    panel.append(action("sync", () => void run(async () => { await call("/sync", {}); await reconcile(); await refresh(); })));
    panel.append(action("usage", () => void run(async () => { usage = await call("/usage", {}); })));
    panel.append(action("disconnect", () => void run(async () => {
      await call("/disconnect", {}); usage = undefined; await reconcile(); await refresh();
    }), true));
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
    panel.append(node("h4", words.models, "font-medium"));
    if (!status?.models?.length) panel.append(node("p", words.noModels, "text-sm text-muted-foreground"));
    for (const model of status?.models ?? []) {
      panel.append(node("div", `${model.id}${model.context ? ` · ${model.context}` : ""}`, "text-sm"));
    }
  };
  const render = () => {
    if (disposed) return;
    el.replaceChildren();
    const panel = node("section", "", "glass-card rounded-xl p-5 space-y-4");
    panel.append(node("h3", words.title, "font-semibold text-lg"),
      node("p", words.description, "text-sm text-muted-foreground"));
    panel.append(node("p", status ? words[status.status] ?? words.error : words.loading));
    if (error) panel.append(node("p", words.error, "text-destructive"));
    if (status?.status === "connected") renderConnected(panel);
    else if (status) { if (!renderLoginPending(panel)) renderNotConnected(panel); }
    panel.append(action("refresh", () => void run(() => refresh())));
    el.append(panel);
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
