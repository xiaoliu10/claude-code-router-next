/**
 * Gemini OAuth card — model management surface (chips, hide, hidden restore),
 * plus its draft/Router reconciliation and locale completeness.
 *
 * The card is driven through real mount/unmount/click handlers with a minimal
 * DOM double (no framework, no fetch: every request goes through the host
 * `callApi` bridge).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, unmount, mergeGeminiOauthHiddenRefs, sanitizeGeminiOauthModelRefs, sanitizeGeminiOauthRouterPaths } from "../src/card-entry";
import { geminiOauthLocales } from "../src/locales";

class Element {
  children: Element[] = [];
  textContent = "";
  tag: string;
  type = "";
  checked = false;
  disabled = false;
  href = "";
  target = "";
  rel = "";
  style = { cssText: "" };
  className = "";
  dataset: Record<string, string> = {};
  parent: Element | null = null;
  attrs: Record<string, string> = {};
  onclick?: () => void;
  onchange?: () => void;
  firstChild: Element | null = null;
  constructor(tag: string) { this.tag = tag; }
  append(...nodes: Element[]) { for (const n of nodes) { n.parent = this; this.children.push(n); } this.firstChild = this.children[0] ?? null; }
  appendChild(child: Element) { this.append(child); return child; }
  prepend(...nodes: Element[]) { for (const n of nodes.reverse()) { n.parent = this; this.children.unshift(n); } this.firstChild = this.children[0] ?? null; }
  insertBefore(child: Element, before: Element | null) {
    const at = before ? this.children.indexOf(before) : -1;
    child.parent = this;
    if (at < 0) this.children.push(child); else this.children.splice(at, 0, child);
    this.firstChild = this.children[0] ?? null;
    return child;
  }
  replaceChildren(...nodes: Element[]) { this.children = nodes; for (const n of nodes) n.parent = this; this.firstChild = nodes[0] ?? null; }
  setAttribute(name: string, value: string) { this.attrs[name] = value; }
  all(): Element[] { return [this, ...this.children.flatMap(n => n.all())]; }
  button(text: string) {
    const result = this.all().filter(n => n.tag === "button" && n.textContent === text).at(-1);
    if (!result) throw new Error(`button missing: ${text}`);
    return result;
  }
  nodesByLabel(label: string) { return this.all().filter(n => n.attrs?.["aria-label"] === label); }
  byLabel(label: string) {
    const result = this.nodesByLabel(label)[0];
    if (!result) throw new Error(`labelled node missing: ${label}`);
    return result;
  }
  clickLabel(label: string) { const b = this.byLabel(label); if (!b.disabled) b.onclick?.(); }
  click(text: string) { const b = this.button(text); if (!b.disabled) b.onclick?.(); }
  text(): string { return this.all().map(n => n.textContent).join("\n"); }
}

const tick = async () => { for (let i = 0; i < 20; ++i) await Promise.resolve(); };
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(f => f()); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const en = geminiOauthLocales.en.geminiOauth as any;
const zh = geminiOauthLocales.zh.geminiOauth as any;

interface HarnessOverrides {
  status?: any;
  routes?: Record<string, (init?: any) => any | Promise<any>>;
  refreshFail?: boolean;
}

function harness(overrides: HarnessOverrides = {}, options: { disabled?: boolean; locale?: string } = {}) {
  vi.stubGlobal("document", { createElement: (tag: string) => new Element(tag), createElementNS: () => new Element("svg") as any });
  vi.stubGlobal("window", { open: vi.fn() });
  const host = new Element("div");
  let status = overrides.status ?? {
    configured: true, connected: true, kind: "antigravity", email: "user@example.test", project: "p", tier: "paid",
    modelsCount: 2, models: ["gemini-3-flash", "gemini-3-pro"], hiddenModels: [],
  };
  const routes = overrides.routes ?? {};
  const callApi = vi.fn(async (path: string, init?: any) => {
    if (routes[path]) {
      const result = await routes[path](init);
      if (path === "/status" && result) status = result;
      return result;
    }
    if (path === "/status") return status;
    return { ok: true };
  });
  let lock = false;
  const release = vi.fn(() => { lock = false; });
  const refreshConfig = vi.fn(async (_merge: (current: any, server: any) => any) => {
    if (overrides.refreshFail) throw new Error("Configuration refresh failed");
  });
  let hostListener: (() => void) | null = null;
  const props: any = {
    onHostChange: (listener: () => void) => { hostListener = listener; return () => { if (hostListener === listener) hostListener = null; }; },
    callApi: callApi as any,
    locale: options.locale ?? "en",
    locales: geminiOauthLocales,
    disabled: options.disabled ?? false,
    plugin: { name: "gemini-oauth", version: "1" },
    log: console,
    acquireManagement: () => (lock ? null : (lock = true, release)),
    onBusy: vi.fn(),
    refreshConfig,
  };
  mount(host as any, props);
  cleanups.push(() => unmount(host as any));
  return {
    host, callApi, release, refreshConfig, props,
    get lock() { return lock; },
    notify() { hostListener?.(); },
    setStatus(next: any) { status = next; },
    paths() { return callApi.mock.calls.map(([path]) => path as string); },
  };
}

const t = (bundle: any, key: string, vars: Record<string, unknown> = {}): string => {
  const text = key.split(".").reduce<any>((obj, k) => obj?.[k], bundle);
  return String(text).replace(/\{\{(\w+)\}\}/g, (_, name) => String(vars[name] ?? ""));
};

describe("Gemini card model chips", () => {
  it("renders one chip per visible model with an accessible hide button and no innerHTML", async () => {
    const h = harness(); await tick();
    const text = h.host.text();
    expect(text).toContain("gemini-3-flash");
    expect(text).toContain("gemini-3-pro");
    // Accessible labels carry the model id (localized template, textContent only).
    expect(h.host.byLabel(t(en, "hide_model", { model: "gemini-3-flash" }))).toBeTruthy();
    expect(h.host.byLabel(t(en, "hide_model", { model: "gemini-3-pro" }))).toBeTruthy();
    // A hidden section renders only when something is hidden.
    expect(text).not.toContain(t(en, "hidden_models", { count: 1 }));
    // Mount reads are read-only: status plus the single quota snapshot fetch.
    expect(h.callApi.mock.calls.map(([path]) => path)).toEqual(["/status", "/quota"]);
    for (const [, init] of h.callApi.mock.calls) expect((init as any)?.method ?? "GET").toBe("GET");
  });

  it("hide posts only the model, reconciles the managed provider and reports the settled toast", async () => {
    const h = harness({
      routes: {
        "/models/hide": () => ({
          ok: true, success: true, model: "gemini-3-flash",
          clearedRefs: ["default", "scenario:think", "models:flash"],
          removedModelRefs: ["gemini-oauth,gemini-3-flash"],
          defaultFallback: "gemini-oauth,gemini-3-pro",
          models: ["gemini-3-pro"], hiddenModels: ["gemini-3-flash"],
        }),
      },
    });
    await tick();
    h.host.clickLabel(t(en, "hide_model", { model: "gemini-3-flash" })); await tick();
    const hideCall = h.callApi.mock.calls.find(([path]) => path === "/models/hide");
    expect(hideCall?.[1]?.body).toBe(JSON.stringify({ model: "gemini-3-flash" }));
    expect(h.paths()).toEqual(["/status", "/quota", "/models/hide", "/status"]);
    expect(h.refreshConfig).toHaveBeenCalledTimes(1);
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.props.onBusy.mock.calls.map(([busy]: [boolean]) => busy)).toEqual([true, false]);
    expect(h.host.text()).toContain(t(en, "hidden_toast", { model: "gemini-3-flash" }));
    // Localized Router path labels are shown, not raw "scenario:think" labels.
    expect(h.host.text()).toContain(t(en, "router_path.default"));
    expect(h.host.text()).toContain(t(en, "router_path.scenario", { name: "think" }));
    expect(h.host.text()).toContain(t(en, "router_path.model_alias", { name: "flash" }));
    expect(h.host.text()).not.toContain("scenario:");
  });

  it("hide reconciliation drops only the removed ref and keeps unrelated draft edits", async () => {
    const h = harness({
      routes: {
        "/models/hide": () => ({
          ok: true, model: "gemini-3-flash", clearedRefs: ["default"],
          removedModelRefs: ["gemini-oauth,gemini-3-flash"], defaultFallback: "gemini-oauth,gemini-3-pro",
          models: ["gemini-3-pro"], hiddenModels: ["gemini-3-flash"],
        }),
      },
    });
    await tick();
    h.host.clickLabel(t(en, "hide_model", { model: "gemini-3-flash" })); await tick();
    const merge = h.refreshConfig.mock.calls[0]?.[0] as any;
    const local = {
      Providers: [
        { name: "gemini-oauth", api_key: "ccr-managed-gemini-oauth", models: ["draft-model"] },
        { name: "draft", models: ["x"] },
      ],
      Router: {
        default: "gemini-oauth,gemini-3-flash",
        background: "gemini-oauth,gemini-3-flash",
        think: "draft,x",
        longContext: ["gemini-oauth,gemini-3-flash", "draft,x"],
        models: { flash: "gemini-oauth,gemini-3-flash", keep: "draft,x" },
        families: { flash: { default: "gemini-oauth,gemini-3-flash" }, keep: { default: "draft,x" } },
        fallback: ["gemini-oauth,gemini-3-flash", ["draft,x"]],
        custom: {
          type: "custom_router",
          routes: [
            { name: "route", provider: "gemini-oauth", model: "gemini-3-flash" },
            { name: "keep", provider: "draft", model: "x" },
          ],
        },
      },
      unrelatedDraft: "keep",
    };
    const server = { Providers: [{ name: "gemini-oauth", api_key: "ccr-managed-gemini-oauth", models: ["gemini-3-pro"] }], Router: { default: "gemini-oauth,gemini-3-pro" } };
    const merged = merge(local, server);
    expect(merged.Providers.map((p: any) => p.name)).toEqual(["gemini-oauth", "draft"]);
    expect(merged.Providers[0].models).toEqual(["gemini-3-pro"]);
    expect(merged.unrelatedDraft).toBe("keep");
    expect(merged.Router).toEqual({
      default: "gemini-oauth,gemini-3-pro",
      background: "",
      think: "draft,x",
      longContext: ["draft,x"],
      models: { keep: "draft,x" },
      families: { flash: { default: "" }, keep: { default: "draft,x" } },
      fallback: [["draft,x"]],
      custom: { type: "custom_router", routes: [{ name: "keep", provider: "draft", model: "x" }] },
    });
  });

  it("hidden models collapse into a restore area with single and restore-all actions", async () => {
    let restoreBody: any = null;
    const h = harness({
      status: {
        configured: true, connected: true, kind: "antigravity", email: "user@example.test", project: "p", tier: "paid",
        modelsCount: 1, models: ["gemini-3-pro"], hiddenModels: ["gemini-3-flash", "gemini-2.5-gone"],
      },
      routes: {
        "/models/restore": (init: any) => {
          restoreBody = JSON.parse(String(init?.body ?? "{}"));
          return { ok: true, success: true, restored: ["gemini-3-flash"], models: ["gemini-3-pro", "gemini-3-flash"], hiddenModels: ["gemini-2.5-gone"] };
        },
      },
    });
    await tick();
    const details = h.host.all().find(n => n.tag === "details" && n.children.some(c => c.tag === "summary" && c.textContent === t(en, "hidden_models", { count: 2 })));
    expect(details, "hidden models details").toBeTruthy();
    expect((details as Element).text()).toContain("gemini-3-flash");
    expect(h.host.button(t(en, "restore_all"))).toBeTruthy();

    // Single restore posts only that model.
    const single = h.host.all().filter(n => n.tag === "button" && n.textContent === t(en, "restore"));
    expect(single).toHaveLength(2);
    single[0].onclick?.(); await tick();
    expect(restoreBody).toEqual({ model: "gemini-3-flash" });
    expect(h.host.text()).toContain(t(en, "restored_toast", { model: "gemini-3-flash" }));
    expect(h.release).toHaveBeenCalledTimes(1);

    // Restore-all posts an empty body (all hidden models).
    h.host.click(t(en, "restore_all")); await tick();
    expect(restoreBody).toEqual({});
    expect(h.host.text()).toContain(t(en, "restored_all_toast", { count: 1 }));
  });

  it("disables every mutating control while a model action is in flight and under the host gate", async () => {
    let resolveHide!: (value: any) => void;
    const pending = new Promise(done => { resolveHide = done; });
    const h = harness({
      routes: { "/models/hide": () => pending },
      status: {
        configured: true, connected: true, kind: "antigravity", email: "user@example.test", project: "p", tier: "paid",
        modelsCount: 2, models: ["gemini-3-flash", "gemini-3-pro"], hiddenModels: ["gemini-2.5-gone"],
      },
    });
    await tick();
    h.host.clickLabel(t(en, "hide_model", { model: "gemini-3-flash" })); await tick();
    // The shared management lease is held for the whole action.
    expect(h.lock).toBe(true);
    expect(h.host.byLabel(t(en, "hide_model", { model: "gemini-3-pro" })).disabled).toBe(true);
    expect(h.host.button(t(en, "restore_all")).disabled).toBe(true);
    resolveHide({ ok: true, models: ["gemini-3-pro"], hiddenModels: ["gemini-2.5-gone"] }); await tick();
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.host.byLabel(t(en, "hide_model", { model: "gemini-3-pro" })).disabled).toBe(false);

    // A host state change (page Save gate) re-renders the SAME card in place and
    // re-disables the model controls — no remount, no extra status read.
    const readsBefore = h.paths().length;
    h.props.disabled = true;
    h.notify();
    const onHostChangeHarness = harness({
      status: {
        configured: true, connected: true, kind: "antigravity", email: "user@example.test", project: "p", tier: "paid",
        modelsCount: 1, models: ["gemini-3-flash"], hiddenModels: ["gemini-2.5-gone"],
      },
    }, { disabled: true });
    await tick();
    expect(onHostChangeHarness.host.byLabel(t(en, "hide_model", { model: "gemini-3-flash" })).disabled).toBe(true);
    expect(onHostChangeHarness.host.button(t(en, "restore_all")).disabled).toBe(true);
    expect(onHostChangeHarness.paths()).toEqual(["/status", "/quota"]);
    expect(h.paths().length).toBe(readsBefore);
  });

  it("surfaces a rejected hide as a localized, allowlisted error and releases the lease", async () => {
    const h = harness({
      routes: {
        "/models/hide": () => { throw Object.assign(new Error("rejected"), { error: "gemini_oauth_model_invalid" }); },
      },
    });
    await tick();
    h.host.clickLabel(t(en, "hide_model", { model: "gemini-3-flash" })); await tick();
    expect(h.host.text()).toContain(en.errors.gemini_oauth_model_invalid);
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.refreshConfig).not.toHaveBeenCalled();
  });

  it("reports a config-busy host mutex instead of sending the request", async () => {
    const h = harness();
    await tick();
    h.props.acquireManagement = () => null; // another save holds the lease
    h.host.clickLabel(t(en, "hide_model", { model: "gemini-3-flash" })); await tick();
    expect(h.paths()).toEqual(["/status", "/quota"]);
    expect(h.host.text()).toContain(en.errors.config_busy);
  });

  it("renders the Chinese surface for chips, hidden area and Router paths", async () => {
    const h = harness({
      status: {
        configured: true, connected: true, kind: "antigravity", email: "user@example.test", project: "p", tier: "paid",
        modelsCount: 1, models: ["gemini-3-pro"], hiddenModels: ["gemini-3-flash"],
      },
      routes: {
        "/models/hide": () => ({
          ok: true, model: "gemini-3-pro", clearedRefs: ["default", "families.flash.default"],
          removedModelRefs: ["gemini-oauth,gemini-3-pro"], defaultFallback: "", models: [], hiddenModels: ["gemini-3-flash", "gemini-3-pro"],
        }),
      },
    }, { locale: "zh-CN" });
    await tick();
    expect(h.host.byLabel(t(zh, "hide_model", { model: "gemini-3-pro" }))).toBeTruthy();
    expect(h.host.text()).toContain(t(zh, "hidden_models", { count: 1 }));
    expect(h.host.button(t(zh, "restore_all"))).toBeTruthy();
    h.host.clickLabel(t(zh, "hide_model", { model: "gemini-3-pro" })); await tick();
    expect(h.host.text()).toContain(t(zh, "hidden_toast", { model: "gemini-3-pro" }));
    expect(h.host.text()).toContain(t(zh, "router_path.default"));
    expect(h.host.text()).toContain(t(zh, "router_path.family_default", { family: "flash" }));
  });

  it("every-hidden status renders the restore area and no chips", async () => {
    const h = harness({
      status: {
        configured: true, connected: true, kind: "antigravity", email: "user@example.test", project: "p", tier: "paid",
        modelsCount: 0, models: [], hiddenModels: ["gemini-3-flash", "gemini-3-pro"],
      },
    });
    await tick();
    const details = h.host.all().find(n => n.tag === "details" && n.children.some(c => c.tag === "summary" && c.textContent === t(en, "hidden_models", { count: 2 })));
    expect(details, "hidden models details").toBeTruthy();
    expect(h.host.all().filter(n => n.tag === "button" && (n.attrs?.["aria-label"] ?? "").startsWith("Hide "))).toHaveLength(0);
    expect(h.host.button(t(en, "restore_all"))).toBeTruthy();
  });
});

describe("Gemini model-management locale coverage", () => {
  const MODEL_KEYS = ["hide_model", "hidden_models", "hidden_note", "restore", "restore_all", "hidden_toast", "restored_toast", "restored_all_toast"];

  it("defines every key the card uses in both languages", () => {
    for (const key of MODEL_KEYS) {
      expect(typeof en[key], `en ${key}`).toBe("string");
      expect(typeof zh[key], `zh ${key}`).toBe("string");
    }
    for (const key of ["default", "scenario", "model_alias", "family_default"]) {
      expect(typeof en.router_path[key], `en router_path.${key}`).toBe("string");
      expect(typeof zh.router_path[key], `zh router_path.${key}`).toBe("string");
    }
    expect(typeof en.errors.gemini_oauth_model_invalid).toBe("string");
    expect(typeof zh.errors.gemini_oauth_model_invalid).toBe("string");
  });

  it("keeps EN/ZH key trees identical with the same placeholder names", () => {
    const flatten = (value: Record<string, unknown>, prefix = ""): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const [key, item] of Object.entries(value)) {
        if (item && typeof item === "object" && !Array.isArray(item)) Object.assign(out, flatten(item as Record<string, unknown>, `${prefix}${key}.`));
        else out[`${prefix}${key}`] = String(item);
      }
      return out;
    };
    const flatEn = flatten(en);
    const flatZh = flatten(zh);
    expect(Object.keys(flatEn).sort()).toEqual(Object.keys(flatZh).sort());
    const placeholders = (text: string) => (text.match(/\{\{(\w+)\}\}/g) ?? []).sort();
    for (const key of Object.keys(flatEn)) expect(placeholders(flatEn[key]), key).toEqual(placeholders(flatZh[key]));
    // Copy is plain text: never markup or a raw Gemini error code.
    for (const key of MODEL_KEYS) {
      for (const bundle of [en, zh]) {
        expect(bundle[key]).not.toMatch(/[<>]/);
        expect(bundle[key]).not.toMatch(/gemini_oauth_/);
      }
    }
    for (const key of Object.keys(en.router_path)) {
      for (const bundle of [en, zh]) {
        expect(bundle.router_path[key]).not.toMatch(/[<>]/);
        expect(bundle.router_path[key]).not.toMatch(/gemini_oauth_/);
      }
    }
  });
});

describe("hide reconciliation helpers", () => {
  it("accepts only exact managed refs and known Router path labels", () => {
    expect(sanitizeGeminiOauthModelRefs(["gemini-oauth,gemini-3-flash", "gemini-oauth,gemini-3-flash", "other,m", "gemini-oauth,a,b", 42]))
      .toEqual(["gemini-oauth,gemini-3-flash"]);
    expect(sanitizeGeminiOauthRouterPaths(["default", "fallback", "scenario:think", "models:alias", "families.f.default", "scenario:evil;rm", "<script>"]))
      .toEqual(["default", "fallback", "scenario:think", "models:alias", "families.f.default"]);
  });

  it("without removed refs the merge is the plain provider merge (Router untouched)", () => {
    const local = { Providers: [{ name: "draft" }], Router: { default: "gemini-oauth,gemini-3-flash" } };
    const merged = mergeGeminiOauthHiddenRefs(local, { Providers: [] }, [], null);
    expect(merged.Router).toBe(local.Router);
  });

  it("null defaultFallback clears the default; absent adopts the server default", () => {
    const local = { Providers: [], Router: { default: "gemini-oauth,gemini-3-flash" } };
    const refs = ["gemini-oauth,gemini-3-flash"];
    expect(mergeGeminiOauthHiddenRefs(local, { Providers: [], Router: { default: "" } }, refs, null).Router.default).toBe("");
    expect(mergeGeminiOauthHiddenRefs(local, { Providers: [], Router: { default: "other,m" } }, refs, undefined).Router.default).toBe("other,m");
  });
});
