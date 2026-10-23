import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, unmount, createCodexLogin } from "../src/card-entry";
import { codexLocales } from "../src/locales";
import {
  CODEX_PROVIDER_NAME, codexStateKey, codexWindowUnit, formatCodexClock,
  isValidCodexCallbackUrl, maskCodexAccountId, mergeCodexProvider,
  parseCodexLoginStart, parseCodexStatus, parseCodexUsage, sanitizeCodexErrorCode,
} from "../src/card-types";

/** Minimal DOM test double: exercises real mount/unmount/event handlers without
 * shipping or requiring a DOM framework in the production card chunk. */
class Element {
  children: Element[] = [];
  textContent = "";
  tag: string;
  type = "";
  value = "";
  checked = false;
  disabled = false;
  href = "";
  target = "";
  rel = "";
  tabIndex = 0;
  spellcheck = false;
  autocomplete = "";
  style = { cssText: "" };
  className = "";
  dataset: Record<string, string> = {};
  parent: Element | null = null;
  attrs: Record<string, string> = {};
  onclick?: () => void;
  oninput?: () => void;
  onchange?: () => void;
  onkeydown?: (event: { key: string; preventDefault(): void }) => void;
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
  replaceChildren(...nodes: Element[]) { this.children = [...nodes]; for (const n of nodes) n.parent = this; this.firstChild = nodes[0] ?? null; }
  setAttribute(name: string, value: string) { this.attrs[name] = value; }
  all(): Element[] { return [this, ...this.children.flatMap(n => (typeof n.all === "function" ? n.all() : [n]))]; }
  button(text: string) {
    const result = this.all().filter(n => n.tag === "button" && n.textContent === text).at(-1);
    if (!result) throw new Error(`button missing: ${text}`);
    return result;
  }
  click(text: string) { const b = this.button(text); if (!b.disabled) b.onclick?.(); }
  text(): string { return this.all().map(n => n.textContent).join("\n"); }
}
const tick = async () => { for (let i = 0; i < 25; ++i) await Promise.resolve(); };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(f => f()); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function memorySessionStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getLength: () => map.size,
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: () => null,
    removeItem: (k: string) => { map.delete(k); },
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
  } as unknown as Storage;
}

const NOT_CONNECTED = {
  status: "not_connected" as const, providerName: CODEX_PROVIDER_NAME,
  models: [], modelCount: 0, lastError: null,
};
const CONNECTED = {
  status: "connected" as const, providerName: CODEX_PROVIDER_NAME,
  accountId: "9f8e7d6c-1234-5678-90ab-cdef12345678",
  email: "user@example.test", plan: "pro",
  models: ["gpt-5.2", "gpt-5.2-codex"], modelCount: 2, lastError: null,
};
const USAGE = {
  plan: "pro",
  primary: { usedPercent: 33.4, windowSeconds: 18_000, resetAt: Date.now() + 3_600_000 },
  secondary: { usedPercent: 5, windowSeconds: 604_800, resetAt: Date.now() + 86_400_000 },
};
const LOGIN_START = {
  loginId: "a".repeat(48),
  url: "https://auth.openai.com/oauth/authorize?client_id=x",
  expiresAt: Date.now() + 300_000,
  mode: "callback" as const,
  redirectUri: "http://127.0.0.1:1455/auth/callback",
};

function harness(overrides: Record<string, (init?: any) => any> = {}, disabled = false, locale = "en") {
  vi.stubGlobal("document", {
    createElement: (tag: string) => new Element(tag),
    createElementNS: () => new Element("svg") as any,
    createTextNode: (text: string) => ({ tag: "#text", textContent: text }) as any,
  });
  const open = vi.fn(); vi.stubGlobal("window", { open });
  const store = memorySessionStorage();
  vi.stubGlobal("sessionStorage", store);
  const host = new Element("div");
  const callApi = vi.fn(async (path: string, init?: any) => {
    if (overrides[path]) return overrides[path](init);
    if (path === "/status") return CONNECTED;
    if (path === "/usage") return USAGE;
    if (path === "/login/start") return LOGIN_START;
    if (path === "/login/poll") return { status: "pending" };
    if (path === "/sync") return { success: true, models: ["m1", "m2", "m3"], modelCount: 3 };
    if (path === "/disconnect") return { success: true };
    return { success: true };
  });
  let lock = false;
  const release = vi.fn(() => { lock = false; });
  const refreshConfig = vi.fn(async (_merge: (current: any, server: any) => any) => {});
  let hostListener: (() => void) | null = null;
  let unsubscribed = 0;
  const props = {
    callApi: callApi as any, locale, locales: codexLocales,
    disabled, plugin: { name: "codex", version: "1.0.0" }, log: console,
    acquireManagement: () => (lock ? null : (lock = true, release)), onBusy: vi.fn(), refreshConfig,
    onHostChange: (listener: () => void) => {
      hostListener = listener;
      return () => { if (hostListener === listener) hostListener = null; unsubscribed += 1; };
    },
  };
  mount(host as any, props);
  cleanups.push(() => unmount(host as any));
  return {
    host, callApi, open, release, onBusy: props.onBusy, refreshConfig, props, store,
    get lock() { return lock; },
    get unsubscribed() { return unsubscribed; },
    notify() { hostListener?.(); },
    statusReads() { return callApi.mock.calls.filter(([path]) => path === "/status").length; },
    bodies(path: string) {
      return callApi.mock.calls.filter(([p]) => p === path).map(([, init]) => JSON.parse(init?.body ?? "{}"));
    },
  };
}
const en = codexLocales.en.codex as any;

describe("self-contained Codex plugin card", () => {
  it("mount performs only a status read; visual contract uses host classes, never inline styles", async () => {
    const h = harness({ "/status": () => NOT_CONNECTED });
    await tick();
    expect(h.callApi.mock.calls.map(([path]) => path)).toEqual(["/status"]);
    expect(h.host.text()).toContain(en.status.not_connected);
    const card = h.host.all().find(n => n.className?.includes("glass-card"))!;
    expect(card, "glass card container").toBeTruthy();
    expect(card.className).toContain("rounded-2xl");
    const login = h.host.button(en.browser_login);
    expect(login.className).toContain("bg-primary");
    expect(login.style.cssText).toBe("");
    expect(h.host.button(en.sync).className).toContain("border-input");
    expect(h.host.button(en.disconnect).disabled).toBe(true);
    // Icon parity: shield + plug + refresh icons ship as inline svg paths.
    expect(h.host.all().filter(n => n.tag === "svg").length).toBeGreaterThanOrEqual(3);
    const statusBadge = h.host.all().find(n => n.textContent === en.status.not_connected && n.attrs?.role === "status")!;
    expect(statusBadge.className).toContain("bg-white/5");
    expect(h.host.text()).toContain(en.experimental);
    expect(h.host.text()).toContain(en.disclaimer);
    // No ugly inline borders/styles anywhere in the rendered tree.
    expect(h.host.all().every(n => !n.style?.cssText)).toBe(true);
  });

  it("connected shows account/plan/models; quota auto-reads exactly once with window lines, never tokens", async () => {
    const h = harness(); await tick();
    expect(h.callApi.mock.calls.map(([path]) => path)).toEqual(["/status", "/usage"]);
    expect(h.host.text()).toContain("user@example.test");
    expect(h.host.text()).toContain("9f8e7d…5678"); // masked account id, never the full uuid
    expect(h.host.text()).not.toContain("9f8e7d6c-1234-5678-90ab-cdef12345678");
    expect(h.host.text()).toContain("pro");
    expect(h.host.text()).toContain("gpt-5.2-codex");
    // Windows are named from data (18000s → 5 h, 604800s → 7 d), percent rounded.
    expect(h.host.text()).toContain(en.usage_primary.replace("{{window}}", "5 h"));
    expect(h.host.text()).toContain(en.usage_secondary.replace("{{window}}", "7 d"));
    expect(h.host.text()).toContain("33% used");
    // Quota shows windows/percent/reset only — never token counts.
    expect(h.host.text().toLowerCase()).not.toContain("token");
    // Manual refresh re-reads exactly once and keeps valid values only.
    h.host.click(en.refresh_usage); await tick();
    expect(h.callApi.mock.calls.filter(([path]) => path === "/usage")).toHaveLength(2);
    expect(JSON.parse(h.store.getItem("codex-usage-cache-v1")!).entry.value.plan).toBe("pro");
  });

  it("quota cache is TTL-scoped, valid-only: cache hit skips the read; expiry/failure/null never suppress a retry", async () => {
    // A FRESH cache entry: the mount must not re-read usage.
    {
      const h = harness();
      h.store.setItem("codex-usage-cache-v1", JSON.stringify({
        savedAt: Date.now(), entry: { value: USAGE, at: Date.now() },
      }));
      await tick();
      expect(h.callApi.mock.calls.map(([path]) => path)).toEqual(["/status"]);
      expect(h.host.text()).toContain("5 h");
      expect(h.host.text()).toContain(en.usage_updated.slice(0, 8));
      unmount(h.host as any);
      cleanups.pop();
    }
    // A STALE entry (older than the TTL) must re-read.
    {
      const h = harness();
      h.store.setItem("codex-usage-cache-v1", JSON.stringify({
        savedAt: Date.now() - 11 * 60_000, entry: { value: USAGE, at: Date.now() - 11 * 60_000 },
      }));
      await tick();
      expect(h.callApi.mock.calls.filter(([path]) => path === "/usage")).toHaveLength(1);
      unmount(h.host as any);
      cleanups.pop();
    }
    // A failed read is NOT cached; the next mount retries.
    {
      const h = harness({ "/usage": () => { throw new Error("quota down"); } });
      await tick();
      expect(h.callApi.mock.calls.filter(([path]) => path === "/usage")).toHaveLength(1);
      expect(h.store.getItem("codex-usage-cache-v1")).toBeNull();
      expect(h.host.text()).toContain(en.usage_unavailable);
      unmount(h.host as any);
      cleanups.pop();
    }
    // An "absent" (null) quota is also never cached.
    {
      const h = harness({ "/usage": () => null });
      await tick();
      expect(h.host.text()).toContain(en.usage_unavailable);
      expect(h.store.getItem("codex-usage-cache-v1")).toBeNull();
    }
  });

  it("browser login: explicit start, window.open, rendered action link, sequential poll to connected, reconcile + settle", async () => {
    let polls = 0;
    let authorized = false;
    const h = harness({
      "/status": () => (authorized ? CONNECTED : NOT_CONNECTED),
      "/login/poll": () => {
        polls += 1;
        if (polls >= 2) { authorized = true; return { status: "connected", models: ["m1"], modelCount: 1 }; }
        return { status: "pending" };
      },
      "/login/start": () => LOGIN_START,
    });
    await tick();
    h.host.click(en.browser_login); await tick();
    expect(h.open).toHaveBeenCalledWith(LOGIN_START.url, "_blank", "noopener,noreferrer");
    const link = h.host.all().find(n => n.tag === "a" && n.textContent === en.open_login) as any;
    expect(link.href).toBe(LOGIN_START.url);
    expect(link.rel).toContain("noopener");
    expect(h.bodies("/login/poll")[0]).toEqual({ loginId: LOGIN_START.loginId });
    // The second poll happens after one sequential-interval wait.
    await pause(1_400); await tick();
    expect(h.bodies("/login/cancel")).toHaveLength(0); // connected, never invalidated
    expect(h.refreshConfig).toHaveBeenCalledTimes(1);
    const merge = h.refreshConfig.mock.calls[0]?.[0] as any;
    const local = { Providers: [{ name: "draft" }], Router: { default: "draft,m" } };
    const managed = { name: CODEX_PROVIDER_NAME, api_key: "ccr-codex-managed" };
    const out = merge(local, { Providers: [managed] });
    expect(out.Router).toBe(local.Router); // unrelated draft + Router survive
    expect(out.Providers).toEqual([{ name: "draft" }, managed]);
    expect(h.statusReads()).toBe(2); // settle re-reads the committed status
    expect(h.host.text()).toContain(en.login_success.replace("{{email}}", "user@example.test"));
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.onBusy.mock.calls.map(([busy]) => busy)).toEqual([true, false]);
  });

  it("paste mode: help copy renders; invalid paste is rejected locally; valid paste rides the SAME sequential loop", async () => {
    const h = harness({
      "/status": () => NOT_CONNECTED,
      "/login/start": () => ({ ...LOGIN_START, mode: "paste" as const }),
      "/login/poll": () => ({ status: "pending" }),
      "/login/complete": () => ({ status: "pending" }),
    });
    await tick();
    h.host.click(en.browser_login); await tick();
    expect(h.host.text()).toContain(en.paste_help);
    const field = h.host.all().find(n => n.tag === "input")! as any;
    expect(field.attrs["aria-label"]).toBe(en.paste_title);
    // Invalid paste: local validation only, no network exchange.
    field.value = "not a url";
    field.oninput?.();
    h.host.click(en.paste_submit); await tick();
    expect(h.host.text()).toContain(en.errors.callback_invalid);
    expect(h.bodies("/login/complete")).toHaveLength(0);
    // Valid paste: submitted through the loop as /login/complete. The invalid
    // attempt re-rendered the box, so re-query the LIVE input first.
    const live = h.host.all().find(n => n.tag === "input")! as any;
    live.value = "http://127.0.0.1:1455/auth/callback?code=abc&state=xyz";
    live.oninput?.();
    h.host.click(en.paste_submit); await tick();
    expect(h.bodies("/login/complete")).toEqual([
      { loginId: LOGIN_START.loginId, callbackUrl: "http://127.0.0.1:1455/auth/callback?code=abc&state=xyz" },
    ]);
  });

  it("cancel during login invalidates the server job and closes the box quietly", async () => {
    const h = harness({ "/status": () => NOT_CONNECTED, "/login/poll": () => ({ status: "pending" }) });
    await tick();
    h.host.click(en.browser_login); await tick();
    expect(h.host.text()).toContain(en.login_pending);
    h.host.click(en.cancel);
    await tick(); await tick();
    expect(h.bodies("/login/cancel")).toEqual([{ loginId: LOGIN_START.loginId }]);
    expect(h.host.text()).not.toContain(en.login_pending);
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.host.text()).not.toContain(en.errors.login_cancelled); // silent close
  });

  it("an already-expired authorization window ends the loop bounded, with the stable expiry error", async () => {
    const h = harness({
      "/status": () => NOT_CONNECTED,
      "/login/start": () => ({ ...LOGIN_START, expiresAt: Date.now() - 1_000 }),
    });
    await tick();
    h.host.click(en.browser_login);
    await tick(); await tick(); await tick();
    expect(h.host.text()).toContain(en.errors.login_expired);
    expect(h.bodies("/login/cancel")).toHaveLength(1); // best-effort invalidation
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.callApi.mock.calls.filter(([path]) => path === "/login/poll")).toHaveLength(0);
  });

  it("unmount while login/start is in flight opens no window and releases the lease after settle", async () => {
    let resolveStart!: (value: unknown) => void;
    const h = harness({ "/status": () => NOT_CONNECTED, "/login/start": () => new Promise(done => { resolveStart = done; }) });
    await tick();
    h.host.click(en.browser_login);
    await tick();
    expect(h.lock).toBe(true);
    unmount(h.host as any);
    expect(h.host.children).toEqual([]);
    resolveStart(LOGIN_START);
    await tick(); await tick();
    expect(h.open).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.lock).toBe(false);
  });

  it("raw upstream exceptions and polluted error fields can never enter the rendered surface; no innerHTML anywhere", async () => {
    // Polluted status.lastError collapses to the generic copy; markup never appears.
    const bad = harness({
      "/status": () => ({ ...NOT_CONNECTED, lastError: "<img src=x onerror=alert(1)>" }),
    });
    await tick();
    expect(bad.host.text()).not.toContain("<img");
    expect(bad.host.text()).toContain(en.errors.request_failed);
    unmount(bad.host as any);
    cleanups.pop();
    // A thrown raw upstream error on sync never leaks token material.
    const h = harness({ "/sync": () => { throw new Error("ya29.private-token-value"); } });
    await tick();
    h.host.click(en.sync); await tick();
    expect(h.host.text()).toContain(en.errors.sync_failed);
    expect(h.host.text()).not.toContain("ya29.");
    expect(h.release).toHaveBeenCalledTimes(1);
    // The card never assigns innerHTML (the double has no such pre-set field).
    expect(h.host.all().every(n => (n as any).innerHTML === undefined)).toBe(true);
  });

  it("host disabled transitions re-render the mounted card in place: no remount, no cancel, no release", async () => {
    const h = harness(); await tick();
    expect(h.statusReads()).toBe(1);
    expect(h.host.button(en.sync).disabled).toBe(false);
    h.props.disabled = true; h.notify();
    expect(h.host.button(en.sync).disabled).toBe(true);
    expect(h.host.button(en.disconnect).disabled).toBe(true);
    expect(h.host.text()).toContain(en.other_edit);
    expect(h.statusReads()).toBe(1);
    expect(h.release).toHaveBeenCalledTimes(0);
    expect(h.unsubscribed).toBe(0);
    h.props.disabled = false; h.notify();
    expect(h.host.button(en.sync).disabled).toBe(false);
    expect(h.statusReads()).toBe(1);
    unmount(h.host as any);
    expect(h.unsubscribed).toBe(1);
  });

  it("disconnect is double-confirmed, clears the quota cache and settles status", async () => {
    const h = harness(); await tick(); // connected mount caches usage
    expect(h.store.getItem("codex-usage-cache-v1")).not.toBeNull();
    h.host.click(en.disconnect); await tick();
    expect(h.callApi.mock.calls.some(([path]) => path === "/disconnect")).toBe(false);
    expect(h.host.text()).toContain(en.disconnect_warning);
    h.host.click(en.cancel); // dialog cancel
    expect(h.callApi.mock.calls.some(([path]) => path === "/disconnect")).toBe(false);
    h.host.click(en.disconnect);
    h.host.click(en.disconnect); await tick(); await tick();
    expect(h.bodies("/disconnect")).toEqual([{}]);
    expect(h.store.getItem("codex-usage-cache-v1")).toBeNull();
    expect(h.host.text()).toContain(en.disconnected);
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it("sync reconciles and reports the server count; a failed draft reconciliation is surfaced separately without losing the toast", async () => {
    const h = harness({ refreshFail: true } as any);
    h.refreshConfig.mockImplementation(async () => { throw new Error("Configuration refresh failed"); });
    await tick();
    h.host.click(en.sync); await tick();
    expect(h.bodies("/sync")).toEqual([{}]);
    expect(h.statusReads()).toBe(2); // committed reread must not be skipped
    expect(h.host.text()).toContain(en.synced.replace("{{count}}", "3"));
    expect(h.host.text()).toContain(en.errors.reconciliation_failed);
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it("expired status shows the re-login help; a connected cooldown shows the localized reset line", async () => {
    const h = harness({
      "/status": () => ({ ...CONNECTED, status: "expired" }),
    });
    await tick();
    expect(h.host.text()).toContain(en.needs_relogin_help);
    expect(h.host.button(en.reconnect).disabled).toBe(false);
    expect(h.host.button(en.disconnect).disabled).toBe(false);
    unmount(h.host as any);
    cleanups.pop();
    const cooling = harness({
      "/status": () => ({ ...CONNECTED, coolingUntil: Date.now() + 60_000 }),
    });
    await tick();
    expect(cooling.host.text()).toContain(en.status.cooldown);
    expect(cooling.host.text()).toContain(en.cooldown_until.split("{{time}}")[0]);
  });

  it("a held shared lease turns the action into the stable config_busy note", async () => {
    const h = harness({ "/status": () => NOT_CONNECTED });
    await tick();
    h.props.acquireManagement = () => null; // foreign save/action owns the mutex
    h.host.click(en.browser_login);
    expect(h.host.text()).toContain(en.errors.config_busy);
  });

  it("zh locale renders every visible state in Chinese", async () => {
    const zh = codexLocales.zh.codex as any;
    const h = harness({ "/status": () => NOT_CONNECTED }, false, "zh");
    await tick();
    expect(h.host.text()).toContain(zh.title);
    expect(h.host.text()).toContain(zh.status.not_connected);
    expect(h.host.button(zh.browser_login).className).toContain("bg-primary");
    expect(h.host.text()).toContain(zh.experimental);
    h.host.click(zh.browser_login); await tick();
    expect(h.host.text()).toContain(zh.login_pending);
    expect(h.host.button(zh.cancel)).toBeTruthy();
  });

  it("locale bundles are complete: identical key trees, no empty strings in either language", () => {
    const walk = (node: any, path: string[], into: Map<string, string>) => {
      expect(node, `missing node at ${path.join(".")}`).toBeTruthy();
      if (typeof node === "string") {
        expect(node.length, `empty string at ${path.join(".")}`).toBeGreaterThan(0);
        into.set(path.join("."), node);
        return;
      }
      for (const key of Object.keys(node)) walk(node[key], [...path, key], into);
    };
    const enMap = new Map<string, string>(), zhMap = new Map<string, string>();
    walk(codexLocales.en.codex, [], enMap);
    walk(codexLocales.zh.codex, [], zhMap);
    expect([...enMap.keys()].sort()).toEqual([...zhMap.keys()].sort());
  });

  it("deep-link focus with the managed provider name is consumed once; the card scrolls and focuses", async () => {
    const scrolled: Element[] = [];
    let focused = false;
    vi.stubGlobal("document", {
      createElement: (tag: string) => {
        const el = new Element(tag);
        if (tag === "div") { (el as any).scrollIntoView = () => scrolled.push(el); (el as any).focus = () => { focused = true; }; }
        return el;
      },
      createElementNS: () => new Element("svg") as any,
      createTextNode: (text: string) => ({ tag: "#text", textContent: text }) as any,
    });
    vi.stubGlobal("window", { open: vi.fn() });
    vi.stubGlobal("sessionStorage", memorySessionStorage());
    const host = new Element("div");
    mount(host as any, {
      callApi: (async () => NOT_CONNECTED) as any, locale: "en", locales: codexLocales,
      disabled: false, plugin: { name: "codex", version: "1.0.0" }, log: console,
      focusKey: CODEX_PROVIDER_NAME,
      onHostChange: () => () => {},
    } as any);
    await tick();
    expect(scrolled.length).toBe(1); // one-shot: consumed on first delivery
    expect(focused).toBe(true);
    unmount(host as any);
  });

  // ---- pure helpers (card-types) -------------------------------------------

  it("pure helpers: parse guards fail closed; window naming is data-driven; callbacks validated", () => {
    expect(parseCodexStatus({ status: "bogus", models: [] })).toBeNull();
    expect(parseCodexStatus({ status: "connected" })).toBeNull(); // models required
    expect(parseCodexStatus({ ...CONNECTED })!.email).toBe("user@example.test");
    expect(parseCodexLoginStart({ ...LOGIN_START, url: "http://auth.openai.com/x" })).toBeNull();
    expect(parseCodexLoginStart({ ...LOGIN_START, mode: "magic" })).toBeNull();
    expect(parseCodexLoginStart(LOGIN_START)?.loginId).toBe(LOGIN_START.loginId);
    expect(parseCodexUsage({ plan: "pro" })).toBeNull(); // no windows → nothing to show
    expect(parseCodexUsage({ plan: "pro", primary: { usedPercent: 1, windowSeconds: 2 } })).toBeNull();
    expect(parseCodexUsage(USAGE)?.secondary?.windowSeconds).toBe(604_800);
    expect(codexWindowUnit(18_000)).toEqual({ unit: "hours", count: 5 });
    expect(codexWindowUnit(604_800)).toEqual({ unit: "days", count: 7 });
    expect(codexWindowUnit(3600)).toEqual({ unit: "hours", count: 1 });
    expect(codexWindowUnit(90).unit).toBe("minutes");
    expect(isValidCodexCallbackUrl("http://127.0.0.1:1455/auth/callback?code=a&state=b")).toBe(true);
    expect(isValidCodexCallbackUrl("https://evil.test/?code=a&state=b")).toBe(true); // server re-validates
    expect(isValidCodexCallbackUrl("javascript:alert(1)")).toBe(false);
    expect(isValidCodexCallbackUrl("http://127.0.0.1:1455/auth/callback?state=b")).toBe(false);
    expect(sanitizeCodexErrorCode("login_expired")).toBe("login_expired");
    expect(sanitizeCodexErrorCode("<img>")).toBeNull();
    expect(maskCodexAccountId("short")).toBe("short");
    expect(maskCodexAccountId("9f8e7d6c-1234-5678-90ab-cdef12345678")).toBe("9f8e7d…5678");
    expect(codexStateKey({ ...CONNECTED, status: "expired" })).toBe("needs_relogin");
    expect(codexStateKey({ ...CONNECTED, coolingUntil: Date.now() + 60_000 })).toBe("cooldown");
    expect(formatCodexClock(Number.NaN, "en")).toBeNull();
  });

  it("login session: a paste submitted while another complete is in flight waits its turn — no stolen responses", async () => {
    let completeCount = 0;
    let resolveFirstComplete!: (value: any) => void;
    const session = createCodexLogin({
      start: async () => ({ ...LOGIN_START }),
      poll: async () => ({ status: "pending" }),
      complete: async (_loginId, callbackUrl) => {
        completeCount += 1;
        if (completeCount === 1) {
          return await new Promise(resolve => { resolveFirstComplete = resolve; });
        }
        expect(callbackUrl).toContain("code=2");
        return { status: "connected", models: [], modelCount: 0 };
      },
      cancel: async () => {},
    }, () => {}, { intervalMs: 1, deadlineMs: 5_000 });
    await tick();
    const first = session.submitCallback("http://127.0.0.1:1455/auth/callback?code=1&state=s");
    await pause(20); await tick();
    expect(completeCount).toBe(1); // the sequential loop owns the only exchange
    // A second paste while the first complete is still in flight must WAIT —
    // it may not steal the first response nor start a parallel exchange.
    const second = session.submitCallback("http://127.0.0.1:1455/auth/callback?code=2&state=s");
    await pause(20); await tick();
    expect(completeCount).toBe(1);
    resolveFirstComplete({ status: "error", error: "callback_rejected" });
    expect(await first).toEqual({ status: "error", error: "callback_rejected" }); // its OWN response
    await pause(20);
    await vi.waitFor(async () => { expect(completeCount).toBe(2); }, { timeout: 2_000 });
    expect(await second).toEqual({ status: "connected", models: [], modelCount: 0 });
    await session.cancel().catch(() => {});
  });
});
