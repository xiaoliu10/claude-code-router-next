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
  errorMessage?: string;
  busy: boolean;
  /** Half-typed PAT, kept across re-renders so another section cannot wipe it. */
  draft: string;
  /** Model id whose hide/restore is in flight; drives the chip's aria-busy. */
  pendingModel?: string | null;
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
  // Model controls use the host stylesheet vocabulary from WorkBuddy/Codex.
  const CHIP = "inline-flex max-w-full items-center gap-1 break-all whitespace-normal rounded-lg border border-white/5 bg-white/5 px-2 py-0.5 text-[10px] font-bold text-muted-foreground";
  const CHIP_HIDE = "rounded p-0.5 text-muted-foreground/60 transition-colors hover:bg-white/10 hover:text-foreground disabled:opacity-40";
  const BUTTON_BASE = "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-semibold ring-offset-background transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 active:scale-95";
  const BUTTON_OUTLINE = "border border-input bg-input/50 backdrop-blur-md shadow-sm hover:bg-input/80 hover:border-primary/50 hover:shadow-md hover:text-accent-foreground";
  /** Inline copy of the lucide "x" svg markup (paths only; icons ship as code). */
  const xIcon = (className: string): SVGSVGElement => {
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
    for (const d of ["M18 6 6 18", "m6 6 12 12"]) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      svg.appendChild(path);
    }
    return svg;
  };
  /** Locale lookup with {{var}} interpolation; unknown keys render as-is. */
  const format = (key: string, vars: Record<string, unknown> = {}): string =>
    String(words[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_, name) => String(vars[name] ?? ""));
  /** One action at a time across the whole card: mirrors action()'s gate. */
  const sectionBusy = () => disposed || props.disabled || sections.some(s => s.busy);
  const sectionWords = (section: QoderCardSection) => section.site.id === "qoder"
    ? { title: words.title, description: words.description }
    : { title: words.cnTitle, description: words.cnDescription };
  const finish = (section: QoderCardSection) => {
    section.busy = false; section.pendingModel = null; section.release?.(); section.release = undefined;
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
    section.release = lease; section.busy = true; section.error = false; section.errorMessage = undefined; props.onBusy?.(true); render();
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
    button.disabled = sectionBusy();
    button.onclick = fn; return button;
  };
  /** Small outline button with the unified workbuddy/codex vocabulary. */
  const smallButton = (label: string, extra: string, fn: () => void): HTMLButtonElement => {
    const button = node("button", label, `${BUTTON_BASE} ${BUTTON_OUTLINE} ${extra}`) as HTMLButtonElement;
    button.type = "button";
    button.disabled = sectionBusy();
    button.onclick = fn; return button;
  };
  // Visibility changes are per-model; always re-read server state after a
  // batch, including when only some requests succeeded.
  const setModelVisibility = (section: QoderCardSection, ids: string[], hidden: boolean) =>
    void run(section, async () => {
      let completed = 0;
      try {
        for (const id of ids) {
          await call(section, "/models/visibility", { model: id, hidden });
          completed += 1;
        }
      } catch (error) {
        if (completed > 0) section.errorMessage = format(hidden ? "hide_partial" : "restore_partial", { count: completed, total: ids.length });
        throw error;
      } finally {
        // A reconciliation failure must not prevent the status refresh.
        try { await reconcile(section); } finally { await refresh(section); }
      }
    });
  const renderSection = (section: QoderCardSection): HTMLElement => {
    const panel = node("div", "", "space-y-3 border-t border-border pt-4 first:border-t-0 first:pt-0");
    panel.append(node("h3", sectionWords(section).title, "font-semibold text-lg"),
      node("p", sectionWords(section).description, "text-sm text-muted-foreground"));
    panel.append(node("p", section.status ? words[section.status.status] ?? words.error : words.loading));
    if (section.status?.expired) panel.append(node("p", words.expired, "text-destructive"));
    if (section.status?.account) panel.append(node("p", `${words.account}: ${section.status.account}`));
    if (section.error) panel.append(node("p", section.errorMessage ?? words.error, "text-destructive"));
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
    // Qoder's count includes hidden models; keep that status meaning while
    // matching Codex's count row and WorkBuddy's visibility controls.
    const models = Array.isArray(section.status?.models) ? section.status.models : [];
    const visible = models.filter((model: any) => !model.hidden);
    const hiddenModels = models.filter((model: any) => model.hidden);
    if (section.status?.status === "connected" || models.length) {
      const count = node("dl", "", "grid max-w-md grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs");
      count.append(node("dt", words.models, "text-muted-foreground"),
        node("dd", format("models_count", { count: section.status?.modelCount ?? models.length }), "break-all text-foreground"));
      panel.append(count);
    }
    if (!models.length) panel.append(node("p", words.noModels, "text-sm text-muted-foreground"));
    if (visible.length) {
      const chips = node("div", "", "flex flex-wrap gap-2 pt-1");
      for (const model of visible) {
        const id = String(model.id);
        const chip = node("span", id, CHIP);
        if (model.context) chip.append(node("span", String(model.context), "font-medium text-muted-foreground/60"));
        if (model.free) chip.append(node("span", words.free, "font-medium text-muted-foreground/60"));
        const hide = node("button", "", CHIP_HIDE) as HTMLButtonElement;
        hide.type = "button";
        hide.disabled = sectionBusy();
        hide.setAttribute("aria-label", format("hide_model", { model: id }));
        hide.setAttribute("aria-busy", String(section.busy && section.pendingModel === id));
        hide.append(xIcon("h-3 w-3"));
        hide.onclick = () => { section.pendingModel = id; setModelVisibility(section, [id], true); };
        chip.append(hide);
        chips.append(chip);
      }
      panel.append(chips);
    }
    if (hiddenModels.length) {
      const details = node("details", "", "max-w-md text-xs text-muted-foreground");
      details.append(node("summary", format("hidden_models", { count: hiddenModels.length }), "cursor-pointer select-none font-medium"));
      const list = node("ul", "", "mt-2 space-y-1");
      for (const model of hiddenModels) {
        const id = String(model.id);
        const item = node("li", "", "flex items-center justify-between gap-2");
        item.append(node("span", id, "break-all font-mono"));
        const restore = smallButton(words.restore, "h-6 shrink-0 px-2 text-[11px]",
          () => { section.pendingModel = id; setModelVisibility(section, [id], false); });
        restore.setAttribute("aria-label", format("restore_model", { model: id }));
        item.append(restore);
        list.append(item);
      }
      details.append(list);
      details.append(smallButton(words.restore_all, "mt-2 h-7 px-2 text-[11px]",
        () => setModelVisibility(section, hiddenModels.map((model: any) => String(model.id)), false)));
      panel.append(details);
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
