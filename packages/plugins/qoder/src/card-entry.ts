import type { PluginCardMountProps } from "../../../ui/src/utils/plugin-card";
import { qoderLocales } from "./locales";
import { QODER_PROVIDER, mergeQoderProvider } from "./protocol";

const mounted = new WeakMap<HTMLElement, () => void>();
export function mount(el: HTMLElement, props: PluginCardMountProps): void {
  unmount(el);
  const lang = props.locale.toLowerCase().startsWith("zh") ? "zh" : "en";
  const words = { ...qoderLocales[lang].qoder, ...((props.locales as any)?.[lang]?.qoder ?? {}) } as Record<string, string>;
  let status: any, usage: any, error = false, disposed = false, busy = false;
  let release: (() => void) | undefined;
  const abort = new AbortController();
  const call = <T = any>(path: string, body?: any): Promise<T> => props.callApi<T>(path, {
    method: body === undefined ? "GET" : "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: abort.signal, timeoutMs: 45000,
  });
  const node = (tag: string, text: string, cls = "") => { const n = document.createElement(tag); n.textContent = text; n.className = cls; return n; };
  const finish = () => { busy = false; release?.(); release = undefined; props.onBusy?.(false); if (!disposed) render(); };
  const refresh = async () => { status = await call("/status"); if (!disposed) render(); };
  const reconcile = () => props.refreshConfig?.(mergeQoderProvider);
  const run = async (fn: () => Promise<void>) => {
    if (disposed || busy || props.disabled || !props.acquireManagement) return;
    const lease = props.acquireManagement(); if (!lease) return;
    release = lease; busy = true; error = false; props.onBusy?.(true); render();
    try { await fn(); } catch { error = true; }
    finally { finish(); }
  };
  // Connect is synchronous server-side (PAT exchange): no login polling here.
  const connect = (input: HTMLInputElement) => void run(async () => {
    const pat = input.value;
    try {
      await call("/connect", { pat });
      // The token never lingers: cleared immediately, never rendered or logged.
      input.value = "";
      await reconcile(); await refresh();
    } catch (e) {
      input.value = "";
      throw e;
    }
  });
  const action = (label: string, fn: () => void) => {
    const button = node("button", words[label], "px-3 py-2 rounded-md bg-secondary text-secondary-foreground hover:bg-secondary/80 disabled:opacity-50") as HTMLButtonElement;
    button.disabled = disposed || props.disabled || busy;
    button.onclick = fn; return button;
  };
  const render = () => {
    if (disposed) return;
    el.replaceChildren();
    const card = node("section", "", "glass-card rounded-xl p-5 space-y-3");
    card.append(node("h3", words.title, "font-semibold text-lg"), node("p", words.description, "text-sm text-muted-foreground"));
    card.append(node("p", status ? words[status.status] ?? words.error : words.loading));
    if (status?.expired) card.append(node("p", words.expired, "text-destructive"));
    if (status?.account) card.append(node("p", `${words.account}: ${status.account}`));
    if (error) card.append(node("p", words.error, "text-destructive"));
    const buttons = node("div", "", "flex flex-wrap gap-2");
    if (status?.status === "not_connected") {
      // PAT form: password-typed input so the token never shows on screen.
      const input = node("input", "", "w-full rounded-md border border-input bg-background px-3 py-2 text-sm") as HTMLInputElement;
      input.type = "password"; input.placeholder = words.patPlaceholder; input.autocomplete = "off";
      input.setAttribute("aria-label", words.pat);
      const connectButton = action("connect", () => connect(input));
      input.onkeydown = e => { if (e.key === "Enter") connect(input); };
      card.append(node("p", words.pat, "text-sm font-medium"), input);
      buttons.append(connectButton);
    } else if (status) {
      buttons.append(action("sync", () => void run(async () => { await call("/sync", {}); await reconcile(); await refresh(); })));
      buttons.append(action("usage", () => void run(async () => { usage = await call("/usage", {}); })));
      buttons.append(action("disconnect", () => void run(async () => { await call("/disconnect", {}); usage = undefined; await reconcile(); await refresh(); })));
    }
    buttons.append(action("refresh", () => void run(refresh)));
    card.append(buttons);
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
    card.append(usageLine);
    if (status?.coolingUntil > Date.now()) card.append(node("p", `${words.cooling}: ${new Date(status.coolingUntil).toLocaleString()}`, "text-sm text-muted-foreground"));
    card.append(node("h4", words.models, "font-medium"));
    if (!status?.models?.length) card.append(node("p", words.noModels, "text-sm text-muted-foreground"));
    for (const model of status?.models ?? []) {
      const row = node("div", "", "flex items-center justify-between gap-2");
      const label = `${model.id}${model.context ? ` · ${model.context}` : ""}${model.free ? ` · ${words.free}` : ""}`;
      row.append(node("span", label, "text-sm"));
      row.append(action(model.hidden ? "restore" : "hide", () => void run(async () => { await call("/models/visibility", { model: model.id, hidden: !model.hidden }); await reconcile(); await refresh(); })));
      card.append(row);
    }
    el.append(card);
  };
  const off = props.onHostChange?.(render);
  mounted.set(el, () => { disposed = true; off?.(); abort.abort(); });
  render(); void refresh().catch(() => { error = true; render(); });
  if (props.focusKey === QODER_PROVIDER) { el.tabIndex = -1; el.focus(); el.scrollIntoView?.({ block: "nearest" }); }
}
export function unmount(el: HTMLElement): void { mounted.get(el)?.(); mounted.delete(el); el.replaceChildren(); }
export default { mount, unmount };
