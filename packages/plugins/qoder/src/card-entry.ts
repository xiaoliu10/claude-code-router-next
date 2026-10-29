import type { PluginCardMountProps } from "../../../ui/src/utils/plugin-card";
import { qoderLocales } from "./locales";
import { QODER_SITES, mergeQoderProvider, qoderCardPrefix, type QoderSiteDescriptor } from "./protocol";

/**
 * One card, one section per site. The sections share nothing but the DOM
 * container: their own status, quota, model list, busy state and management
 * lease, so a CN action never blocks or rewrites the international one.
 */
interface QoderCardSection {
  readonly site: QoderSiteDescriptor;
  /** Card-bridge path prefix of the site ("" intl, "/cn" for Qoder CN). */
  readonly prefix: string;
  status?: any;
  usage?: any;
  error: boolean;
  busy: boolean;
  /** Half-typed PAT, kept across re-renders so another section cannot wipe it. */
  draft: string;
  release?: () => void;
}

const mounted = new WeakMap<HTMLElement, () => void>();
export function mount(el: HTMLElement, props: PluginCardMountProps): void {
  unmount(el);
  const lang = props.locale.toLowerCase().startsWith("zh") ? "zh" : "en";
  const words = { ...qoderLocales[lang].qoder, ...((props.locales as any)?.[lang]?.qoder ?? {}) } as Record<string, string>;
  const sections: QoderCardSection[] = QODER_SITES.map(site =>
    ({ site, prefix: qoderCardPrefix(site.id), error: false, busy: false, draft: "" }));
  const panels = new Map<string, HTMLElement>();
  let disposed = false;
  const abort = new AbortController();
  const call = <T = any>(section: QoderCardSection, path: string, body?: any): Promise<T> => props.callApi<T>(`${section.prefix}${path}`, {
    method: body === undefined ? "GET" : "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: abort.signal, timeoutMs: 45000,
  });
  const node = (tag: string, text: string, cls = "") => { const n = document.createElement(tag); n.textContent = text; n.className = cls; return n; };
  const sectionWords = (section: QoderCardSection) => section.site.id === "qoder"
    ? { title: words.title, description: words.description }
    : { title: words.cnTitle, description: words.cnDescription };
  const finish = (section: QoderCardSection) => {
    section.busy = false; section.release?.(); section.release = undefined;
    // onBusy is a COUNTING semaphore on the host (increment/decrement), not a
    // boolean state, so the release must be the exact balancing `false`.
    props.onBusy?.(false);
    if (!disposed) render();
  };
  const refresh = async (section: QoderCardSection) => { section.status = await call(section, "/status"); if (!disposed) render(); };
  const reconcile = (section: QoderCardSection) =>
    props.refreshConfig?.((current: any, server: any) => mergeQoderProvider(current, server, section.site.id));
  const run = async (section: QoderCardSection, fn: () => Promise<void>) => {
    if (disposed || section.busy || props.disabled || !props.acquireManagement) return;
    const lease = props.acquireManagement(); if (!lease) return;
    section.release = lease; section.busy = true; section.error = false; props.onBusy?.(true); render();
    try { await fn(); } catch { section.error = true; }
    finally { finish(section); }
  };
  // Connect is synchronous server-side (PAT exchange): no login polling here.
  const connect = (section: QoderCardSection, input: HTMLInputElement) => void run(section, async () => {
    const pat = input.value;
    try {
      await call(section, "/connect", { pat });
      // The token never lingers: cleared immediately, never rendered or logged.
      input.value = ""; section.draft = "";
      await reconcile(section); await refresh(section);
    } catch (e) {
      input.value = ""; section.draft = "";
      throw e;
    }
  });
  const action = (section: QoderCardSection, label: string, fn: () => void) => {
    const button = node("button", words[label], "px-3 py-2 rounded-md bg-secondary text-secondary-foreground hover:bg-secondary/80 disabled:opacity-50") as HTMLButtonElement;
    // The management lease is a strict mutex across the whole card: while ANY
    // section is busy, this section's buttons must look disabled too, or a
    // click silently no-ops instead of explaining why.
    button.disabled = disposed || props.disabled || sections.some(s => s.busy);
    button.onclick = fn; return button;
  };
  const renderSection = (section: QoderCardSection): HTMLElement => {
    const panel = node("div", "", "space-y-3 border-t border-border pt-4 first:border-t-0 first:pt-0");
    panel.append(node("h3", sectionWords(section).title, "font-semibold text-lg"),
      node("p", sectionWords(section).description, "text-sm text-muted-foreground"));
    panel.append(node("p", section.status ? words[section.status.status] ?? words.error : words.loading));
    if (section.status?.expired) panel.append(node("p", words.expired, "text-destructive"));
    if (section.status?.account) panel.append(node("p", `${words.account}: ${section.status.account}`));
    if (section.error) panel.append(node("p", words.error, "text-destructive"));
    const buttons = node("div", "", "flex flex-wrap gap-2");
    if (section.status?.status === "not_connected") {
      // PAT form: password-typed input so the token never shows on screen.
      const input = node("input", "", "w-full rounded-md border border-input bg-background px-3 py-2 text-sm") as HTMLInputElement;
      input.type = "password"; input.placeholder = words.patPlaceholder; input.autocomplete = "off";
      input.setAttribute("aria-label", words.pat);
      // A render triggered by the OTHER section must not wipe a half-typed PAT.
      input.value = section.draft;
      input.oninput = () => { section.draft = input.value; };
      const connectButton = action(section, "connect", () => connect(section, input));
      input.onkeydown = e => { if (e.key === "Enter") connect(section, input); };
      panel.append(node("p", words.pat, "text-sm font-medium"), input);
      buttons.append(connectButton);
    } else if (section.status) {
      buttons.append(action(section, "sync", () => void run(section, async () => { await call(section, "/sync", {}); await reconcile(section); await refresh(section); })));
      buttons.append(action(section, "usage", () => void run(section, async () => { section.usage = await call(section, "/usage", {}); })));
      buttons.append(action(section, "disconnect", () => void run(section, async () => { await call(section, "/disconnect", {}); section.usage = undefined; await reconcile(section); await refresh(section); })));
    }
    buttons.append(action(section, "refresh", () => void run(section, () => refresh(section))));
    panel.append(buttons);
    // Usage windows: render defensively — shape comes from a remote payload.
    const usageLine = node("p", "", "text-sm text-muted-foreground");
    if (section.usage?.known && Array.isArray(section.usage.windows) && section.usage.windows.length) {
      usageLine.textContent = `${section.usage.stale ? words.stale : words.used}: ` +
        section.usage.windows.map((w: any) => {
          const name = typeof w?.name === "string" ? w.name.slice(0, 100) : "?";
          const detail = typeof w?.display === "string" && w.display
            ? w.display : Number.isFinite(w?.used) ? `${Math.round(w.used)}%` : "?";
          return `${name}: ${detail}`;
        }).join(" · ");
    } else usageLine.textContent = words.unknown;
    panel.append(usageLine);
    if (section.status?.coolingUntil > Date.now()) panel.append(node("p", `${words.cooling}: ${new Date(section.status.coolingUntil).toLocaleString()}`, "text-sm text-muted-foreground"));
    panel.append(node("h4", words.models, "font-medium"));
    if (!section.status?.models?.length) panel.append(node("p", words.noModels, "text-sm text-muted-foreground"));
    for (const model of section.status?.models ?? []) {
      const row = node("div", "", "flex items-center justify-between gap-2");
      const label = `${model.id}${model.context ? ` · ${model.context}` : ""}${model.free ? ` · ${words.free}` : ""}`;
      row.append(node("span", label, "text-sm"));
      row.append(action(section, model.hidden ? "restore" : "hide", () => void run(section, async () => {
        await call(section, "/models/visibility", { model: model.id, hidden: !model.hidden });
        await reconcile(section); await refresh(section);
      })));
      panel.append(row);
    }
    return panel;
  };
  const render = () => {
    if (disposed) return;
    el.replaceChildren();
    panels.clear();
    const card = node("section", "", "glass-card rounded-xl p-5 space-y-4");
    for (const section of sections) {
      const panel = renderSection(section);
      panels.set(section.site.id, panel);
      card.append(panel);
    }
    el.append(card);
  };
  // Deep-link focus is one-shot: it targets the section that owns the key and
  // leaves the other untouched.
  const focus = () => {
    const section = sections.find(s => props.focusKey === s.site.provider || props.focusKey === s.site.id);
    const panel = section && panels.get(section.site.id);
    if (!panel) return;
    panel.tabIndex = -1; panel.focus(); panel.scrollIntoView?.({ block: "nearest" });
  };
  const load = (section: QoderCardSection) => void refresh(section).catch(() => { section.error = true; if (!disposed) render(); });
  const off = props.onHostChange?.(render);
  mounted.set(el, () => { disposed = true; off?.(); abort.abort(); });
  render(); focus();
  for (const section of sections) load(section);
}
export function unmount(el: HTMLElement): void { mounted.get(el)?.(); mounted.delete(el); el.replaceChildren(); }
export default { mount, unmount };
