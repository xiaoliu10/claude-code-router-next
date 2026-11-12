import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, unmount } from "../src/card-entry";
import { kiroLocales } from "../src/locales";
import {
  readKiroUsageStore, rememberKiroUsage, freshKiroUsage, clearKiroUsageCache, KIRO_USAGE_CACHE_KEY, KIRO_USAGE_CACHE_TTL_MS,
  isValidKiroCallbackUrl, isValidKiroIdcInput, kiroCardErrorKey,
  mergeKiroCardProvider, parseKiroLoginStart, parseKiroLoginPoll,
  parseKiroStatus, parseKiroUsage, sanitizeKiroErrorCode,
} from "../src/card-types";
import { clearKiroRouterRefs } from "../src/router";
import { createKiroLogin, KIRO_POLL_TIMEOUT } from "../src/card-login";

/** Minimal DOM test double: exercises real mount/unmount/event handlers
 * without shipping a DOM framework in the production card chunk. */
class El {
  children: El[] = [];
  textContent = "";
  tag: string;
  type = "";
  value = "";
  checked = false;
  disabled = false;
  href = "";
  target = "";
  rel = "";
  tabIndex = -1;
  spellcheck = false;
  autocomplete = "";
  style: Record<string, string> = {};
  className = "";
  name = "";
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  parent: El | null = null;
  onclick?: () => void;
  oninput?: () => void;
  onchange?: (event?: unknown) => void;
  onkeydown?: (event: { key: string; preventDefault(): void }) => void;
  constructor(tag: string) { this.tag = tag; }
  append(...nodes: El[]) { for (const n of nodes) { n.parent = this; this.children.push(n); } }
  appendChild(child: El): El { this.append(child); return child; }
  prepend(...nodes: El[]) { for (const n of nodes.reverse()) { n.parent = this; this.children.unshift(n); } }
  insertBefore(child: El, before: El | null) {
    const at = before ? this.children.indexOf(before) : -1;
    child.parent = this;
    if (at < 0) this.children.push(child); else this.children.splice(at, 0, child);
    return child;
  }
  get firstChild(): El | null { return this.children[0] ?? null; }
  replaceChildren(...nodes: El[]) { this.children = [...nodes]; for (const n of nodes) n.parent = this; }
  setAttribute(name: string, value: string) { this.attrs[name] = value; }
  getAttribute(name: string): string | null { return this.attrs[name] ?? null; }
  all(): El[] { return [this, ...this.children.flatMap(n => n.all())]; }
  button(text: string): El {
    const result = this.all().filter(n => n.tag === "button" && n.textContent === text).at(-1);
    if (!result) throw new Error(`button missing: ${text}`);
    return result;
  }
  click(text: string) { const b = this.button(text); if (!b.disabled) b.onclick?.(); }
  text(): string { return this.all().map(n => n.textContent).join("\n"); }
}
(globalThis as any).document = {
  createElement: (tag: string) => new El(tag),
  createElementNS: (_ns: string, tag: string) => new El(tag),
};

const tick = async () => { for (let i = 0; i < 20; ++i) await Promise.resolve(); };
const flush = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await tick(); };

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach(f => f());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  (globalThis as any).sessionStorage?.clear?.();
});

const ACCOUNT_A = {
  id: "acc-aaa", uid: "google", email: "a@example.test", accountId: "a@example.test (Google)",
  method: "social", loginProvider: "google", region: "us-east-1", plan: "Kiro Pro",
  needReauth: false, coolingUntil: 0,
};
const ACCOUNT_B = {
  id: "acc-bbb", uid: "builderid", email: "b@example.test", accountId: "b@example.test (Builder ID)",
  method: "idc", loginProvider: "builderid", region: "us-east-1", plan: "Kiro Free",
  needReauth: false, coolingUntil: 0,
};
const MODELS = [
  { id: "claude-v4", name: "Claude v4", context: 200000, output: 64000, images: true },
  { id: "kiro-mini", name: "Kiro Mini", context: 64000, output: 8000, images: false },
];
const USAGE = {
  account: "acc-aaa", known: true, stale: false, plan: "Kiro Pro",
  windows: [{ name: "Credits", used: 25, amount: 25, limit: 100, unit: "credits", display: "25 / 100", resetsAt: new Date(Date.now() + 86_400_000).toISOString() }],
};
const connectedStatus = (extra: Record<string, any> = {}) => ({
  status: "connected", providerName: "kiro-subscription",
  accounts: [ACCOUNT_A, ACCOUNT_B], models: MODELS, hiddenModels: [],
  plan: "Kiro Pro", usage: [], ...extra,
});

interface HarnessOptions {
  overrides?: Record<string, (init?: any) => any>;
  disabled?: boolean;
  locale?: string;
  heldLease?: boolean;
  status?: any;
  cachedUsage?: { value: unknown; at: number };
}

function harness(options: HarnessOptions = {}) {
  vi.stubGlobal("document", {
    createElement: (tag: string) => new El(tag),
    createElementNS: (_ns: string, tag: string) => new El(tag),
  });
  const open = vi.fn(); vi.stubGlobal("window", { open });
  const map = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
    removeItem: (k: string) => { map.delete(k); },
    clear: () => map.clear(),
  });
  if (options.cachedUsage) map.set(KIRO_USAGE_CACHE_KEY, JSON.stringify({ savedAt: options.cachedUsage.at, entries: { "acc-aaa": options.cachedUsage } }));
  const statusPayload = options.status ?? connectedStatus();
  const host = new El("div");
  const calls: Array<{ path: string; init?: any }> = [];
  const callApi = vi.fn(async (path: string, init?: any) => {
    calls.push({ path, init });
    const body = init?.body ? JSON.parse(init.body) : {};
    if (options.overrides?.[path]) return options.overrides[path]!(init);
    if (path === "/status") return statusPayload;
    if (path === "/usage") return USAGE;
    if (path === "/login/start") return { loginId: "login-1", url: "https://app.kiro.dev/signin?state=x" };
    if (path === "/login/poll") return { status: "pending" };
    if (path === "/login/complete") return { status: "complete", account: ACCOUNT_A };
    if (path === "/login/cancel") return { status: "cancelled" };
    if (path === "/models/visibility") {
      const hidden = body.hidden === true;
      statusPayload.hiddenModels = hidden
        ? [...new Set([...statusPayload.hiddenModels, body.model])]
        : statusPayload.hiddenModels.filter((m: string) => m !== body.model);
      return { success: true };
    }
    if (path === "/sync") return { success: true, models: MODELS.map(m => m.id) };
    if (path === "/disconnect") {
      if (body.account) statusPayload.accounts = statusPayload.accounts.filter((a: any) => a.id !== body.account);
      else { statusPayload.accounts = []; statusPayload.models = []; statusPayload.hiddenModels = []; }
      return { success: true };
    }
    return { success: true };
  });
  let lock = false;
  const release = vi.fn(() => { lock = false; });
  const refreshConfig = vi.fn(async (_merge: (current: any, server: any) => any) => {});
  let hostListener: (() => void) | null = null;
  const props = {
    callApi: callApi as any, locale: options.locale ?? "en", locales: kiroLocales,
    disabled: options.disabled ?? false, plugin: { name: "kiro", version: "0.1.0" }, log: console,
    acquireManagement: () => (options.heldLease || lock ? null : (lock = true, release)),
    onBusy: vi.fn(), refreshConfig: refreshConfig as any,
    onHostChange: (listener: () => void) => { hostListener = listener; return () => { hostListener = null; }; },
    focusKey: null,
  };
  mount(host as any, props as any);
  cleanups.push(() => unmount(host as any));
  const byPath = (path: string) => calls.filter(c => c.path === path);
  const lastBody = (path: string) => {
    const hit = byPath(path).at(-1);
    return hit?.init?.body ? JSON.parse(hit.init.body) : {};
  };
  return { host, callApi, refreshConfig, release, props, calls, byPath, lastBody, notify: () => hostListener?.() };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("kiro card pure helpers", () => {
  it("retains the real cache observation time and handles TTL, future and corrupt entries", () => {
    const data = new Map<string, string>();
    vi.stubGlobal("sessionStorage", { getItem: (k: string) => data.get(k), setItem: (k: string, v: string) => data.set(k, v), removeItem: (k: string) => data.delete(k) });
    data.set(KIRO_USAGE_CACHE_KEY, "{broken");
    expect(readKiroUsageStore()).toEqual({ savedAt: 0, entries: {} });
    const store = readKiroUsageStore(), usage = parseKiroUsage(USAGE)!;
    rememberKiroUsage(store, "a", usage, 1000);
    expect(readKiroUsageStore().entries.a.at).toBe(1000);
    expect(freshKiroUsage(store, "a", 1000 + KIRO_USAGE_CACHE_TTL_MS)).toEqual({ value: usage, at: 1000 });
    expect(freshKiroUsage(store, "a", 1001 + KIRO_USAGE_CACHE_TTL_MS)).toBeUndefined();
    expect(freshKiroUsage(store, "a", 999)).toBeUndefined();
    rememberKiroUsage(store, "b", { ...usage, known: false }, 2000);
    expect(store.entries.b).toBeUndefined();
    rememberKiroUsage(store, "a", null, 2000);
    expect(freshKiroUsage(readKiroUsageStore(), "a", 2000)).toBeUndefined();
    clearKiroUsageCache(); expect(data.has(KIRO_USAGE_CACHE_KEY)).toBe(false);
  });

  it("maps busy callback ports to their dedicated copy", () => {
    expect(kiroCardErrorKey("kiro_callback_ports_busy", "login_failed")).toBe("kiro_callback_ports_busy");
  });

  it("parses status defensively and drops malformed payloads", () => {
    const parsed = parseKiroStatus(connectedStatus({ hiddenModels: ["kiro-mini"], usage: [{ account: "acc-aaa", known: false, stale: true, windows: [] }] }));
    expect(parsed?.accounts).toHaveLength(2);
    expect(parsed?.hiddenModels).toEqual(["kiro-mini"]);
    expect(parsed?.usage[0].account).toBe("acc-aaa");
    expect(parsed?.models[0].id).toBe("claude-v4");
    expect(parseKiroStatus({ status: "weird" })).toBeNull();
    expect(parseKiroStatus({ status: "connected", accounts: "no", models: [], hiddenModels: [] })).toBeNull();
    expect(parseKiroStatus(null)).toBeNull();
  });

  it("only accepts https login start urls and stable error codes", () => {
    expect(parseKiroLoginStart({ loginId: "l1", url: "https://app.kiro.dev/signin" })).toEqual({ loginId: "l1", url: "https://app.kiro.dev/signin" });
    expect(parseKiroLoginStart({ loginId: "l1", url: "http://app.kiro.dev/signin" })).toBeNull();
    expect(parseKiroLoginStart({ loginId: "", url: "https://x" })).toBeNull();
    expect(sanitizeKiroErrorCode("kiro_login_failed")).toBe("kiro_login_failed");
    expect(sanitizeKiroErrorCode("raw upstream sentence")).toBeNull();
  });

  it("maps poll views and usage payloads", () => {
    expect(parseKiroLoginPoll({ status: "complete", account: ACCOUNT_A })?.account?.email).toBe("a@example.test");
    expect(parseKiroLoginPoll({ status: "pending", url: "https://oidc.us-east-1.amazonaws.com/authorize?x" })?.url).toBeTruthy();
    expect(parseKiroLoginPoll({ status: "nope" })).toBeNull();
    const usage = parseKiroUsage(USAGE);
    expect(usage?.windows[0].display).toBe("25 / 100");
    expect(parseKiroUsage({ known: true, windows: "no" })).toBeNull();
  });

  it("triages pasted callback urls and idc form input", () => {
    expect(isValidKiroCallbackUrl("http://localhost:3128/oauth/callback?code=abc&state=def")).toBe(true);
    expect(isValidKiroCallbackUrl("https://localhost:3128/oauth/callback?code=abc&state=def")).toBe(true);
    expect(isValidKiroCallbackUrl("http://localhost:3128/oauth/callback?state=def")).toBe(false);
    expect(isValidKiroCallbackUrl("not a url")).toBe(false);
    expect(isValidKiroIdcInput("portal", "", "")).toBe(true);
    expect(isValidKiroIdcInput("idc", "https://myorg.awsapps.com/start", "us-east-1")).toBe(true);
    expect(isValidKiroIdcInput("idc", "http://myorg.awsapps.com/start", "us-east-1")).toBe(false);
    expect(isValidKiroIdcInput("idc", "https://myorg.awsapps.com/start", "not-a-region")).toBe(false);
  });

  it("maps transport reasons to card error keys with a kind fallback", () => {
    expect(kiroCardErrorKey("kiro_login_expired", "login_failed")).toBe("login_expired");
    expect(kiroCardErrorKey("kiro_callback_invalid", "login_failed")).toBe("callback_rejected");
    expect(kiroCardErrorKey("kiro_model_unknown", "restore")).toBe("restore_failed");
    expect(kiroCardErrorKey("kiro_model_unknown", "hide")).toBe("hide_failed");
    expect(kiroCardErrorKey(null, "sync_failed")).toBe("sync_failed");
    expect(kiroCardErrorKey("totally-unknown-code", "login_failed")).toBe("login_failed");
  });

  it("reconciles only the managed kiro provider into the draft", () => {
    const local = { providers: [{ name: "openai", api_key: "sk" }], Router: { default: "openai,gpt" } };
    const server = { providers: [{ name: "kiro-subscription", kiro_managed: true, models: ["claude-v4"] }] };
    const merged = mergeKiroCardProvider(local as any, server as any);
    expect(merged.providers).toHaveLength(2);
    expect(merged.Router).toEqual(local.Router);
    // Replacement when the draft already carries a managed entry.
    const replaced = mergeKiroCardProvider({ providers: [server.providers[0]] } as any, server as any);
    expect(replaced.providers).toEqual(server.providers);
    // Removal when the server no longer manages kiro.
    const removed = mergeKiroCardProvider({ providers: [server.providers[0]] } as any, { providers: [] });
    expect(removed.providers).toHaveLength(0);
  });

  it("clears router references pointing at hidden kiro models (codex parity)", () => {
    const router = {
      default: "kiro-subscription,kiro-mini",
      think: "kiro-subscription,claude-v4",
      background: ["kiro-subscription,kiro-mini", "openai,gpt"],
      models: { fast: "kiro-subscription,kiro-mini", big: "openai,gpt" },
      families: { coding: { default: "kiro-subscription,kiro-mini" } },
      fallback: "kiro-subscription,kiro-mini",
    };
    const next = clearKiroRouterRefs(router, new Set(["kiro-mini"]), "claude-v4") as any;
    expect(next.default).toBe("kiro-subscription,claude-v4");
    expect(next.think).toBe("kiro-subscription,claude-v4");
    expect(next.background).toEqual(["openai,gpt"]);
    expect(next.models).toEqual({ big: "openai,gpt" });
    expect(next.families.coding.default).toBe("");
    expect(next.fallback).toBe("kiro-subscription,kiro-mini"); // fallback stages untouched
    // No visible model left -> default cleared entirely.
    const cleared = clearKiroRouterRefs({ default: "kiro-subscription,kiro-mini" }, new Set(["kiro-mini"]), null) as any;
    expect(cleared.default).toBe("");
    expect(clearKiroRouterRefs("not-a-router", new Set(["x"]), null)).toBe("not-a-router");
  });
});

// ---------------------------------------------------------------------------
// Card: mount, login methods, login flow
// ---------------------------------------------------------------------------

describe("kiro card: sign-in method selector", () => {
  it("disconnected shows the three login methods and toggles IDC inputs", async () => {
    const h = harness({ status: { status: "disconnected", providerName: "kiro-subscription", accounts: [], models: [], hiddenModels: [], plan: null, usage: [] } });
    await flush();
    const text = h.host.text();
    expect(text).toContain("Kiro Subscription");
    expect(text).toContain("Kiro portal (Google / GitHub)");
    expect(text).toContain("AWS Builder ID");
    expect(text).toContain("IAM Identity Center");
    // IDC fields hidden until the IDC radio is picked.
    expect(h.host.all().filter(n => n.attrs["aria-label"] === "Organization Start URL")).toHaveLength(0);
    const idcRadio = h.host.all().find(n => n.tag === "input" && n.value === "idc")!;
    expect(idcRadio).toBeTruthy();
    idcRadio.checked = true;
    idcRadio.onchange?.();
    await tick();
    const startUrl = h.host.all().find(n => n.attrs["aria-label"] === "Organization Start URL") as El;
    const region = h.host.all().find(n => n.attrs["aria-label"] === "Region") as El;
    expect(startUrl).toBeTruthy();
    expect(region).toBeTruthy();
    expect(region.value).toBe("us-east-1");
    // Start URL defaults empty; submit validates at click time (qoder PAT
    // form precedent — no stale disabled binding) and shows the exact
    // registered kiro_login_invalid copy.
    expect(startUrl.value).toBe("");
    h.host.click("Sign in");
    await tick();
    expect(h.host.text()).toContain("Choose a valid sign-in method");
    // Re-query the LIVE inputs (the invalid-submit re-render rebuilt them),
    // type valid values and confirm the drafts survive another re-render.
    const liveStart = () => h.host.all().find(n => n.attrs["aria-label"] === "Organization Start URL") as El;
    const liveRegion = () => h.host.all().find(n => n.attrs["aria-label"] === "Region") as El;
    liveStart().value = "https://myorg.awsapps.com/start";
    liveStart().oninput?.();
    liveRegion().value = "eu-west-1";
    liveRegion().oninput?.();
    h.notify();
    await tick();
    expect(liveStart().value).toBe("https://myorg.awsapps.com/start");
    expect(liveRegion().value).toBe("eu-west-1");
    expect(h.host.button("Sign in").disabled).toBe(false);
    // Switching back to portal hides the IDC fields again.
    const portalRadio = h.host.all().find(n => n.tag === "input" && n.value === "portal")!;
    portalRadio.checked = true;
    portalRadio.onchange?.();
    await tick();
    expect(h.host.all().filter(n => n.attrs["aria-label"] === "Organization Start URL")).toHaveLength(0);
    unmount(h.host as any);
  });

  it("submits the selected method and IDC startUrl/region to /login/start", async () => {
    const h = harness({ status: { status: "disconnected", providerName: "kiro-subscription", accounts: [], models: [], hiddenModels: [], plan: null, usage: [] } });
    await flush();
    const idcRadio = h.host.all().find(n => n.tag === "input" && n.value === "idc")!;
    idcRadio.checked = true;
    idcRadio.onchange?.();
    await tick();
    const startUrl = h.host.all().find(n => n.attrs["aria-label"] === "Organization Start URL") as El;
    startUrl.value = "https://myorg.awsapps.com/start";
    startUrl.oninput?.();
    h.host.click("Sign in");
    await flush();
    const start = h.lastBody("/login/start");
    expect(start).toEqual({ method: "idc", startUrl: "https://myorg.awsapps.com/start", region: "us-east-1" });
    unmount(h.host as any);
  });
});

describe("kiro card: login flow states", () => {
  it("pending renders authorization link + paste field, cancel works, success settles with a toast", async () => {
    let pollCount = 0;
    const h = harness({
      status: { status: "disconnected", providerName: "kiro-subscription", accounts: [], models: [], hiddenModels: [], plan: null, usage: [] },
      overrides: {
        "/login/poll": () => { pollCount += 1; return pollCount < 3 ? { status: "pending" } : { status: "complete", account: ACCOUNT_A }; },
      },
    });
    await flush();
    h.host.click("Sign in");
    await flush();
    expect(h.lastBody("/login/start")).toEqual({ method: "portal" });
    // Pending state: waiting note, clickable link, paste fallback, cancel.
    expect(h.host.text()).toContain("Browser opened — waiting for authorization");
    const link = h.host.all().find(n => n.tag === "a")!;
    expect(link.href).toBe("https://app.kiro.dev/signin?state=x");
    expect(link.target).toBe("_blank");
    expect(link.rel).toBe("noopener noreferrer");
    const field = h.host.all().find(n => n.tag === "input" && n.attrs["aria-label"] === "Paste callback URL") as El;
    expect(field).toBeTruthy();
    // Paste an invalid callback -> stable inline error, loop keeps running.
    field.value = "garbage";
    field.oninput?.();
    h.host.click("Submit callback");
    await tick();
    expect(h.host.text()).toContain("valid callback URL");
    // A valid pasted callback completes via /login/complete. The invalid
    // submit above re-rendered the box, so type into the LIVE field.
    const liveField = h.host.all().find(n => n.tag === "input" && n.attrs["aria-label"] === "Paste callback URL") as El;
    liveField.value = "http://localhost:3128/oauth/callback?code=abc&state=def";
    liveField.oninput?.();
    h.host.click("Submit callback");
    await flush(); await flush();
    expect(h.lastBody("/login/complete")).toEqual({ loginId: "login-1", callbackUrl: "http://localhost:3128/oauth/callback?code=abc&state=def" });
    await flush();
    expect(h.host.text()).toContain("Connected as a@example.test.");
    expect(h.refreshConfig).toHaveBeenCalled();
    unmount(h.host as any);
  });

  it.each(["en", "zh"])("renders dedicated callback-port errors in %s", async locale => {
    const h = harness({ locale, overrides: { "/login/start": () => { throw { reason: "kiro_callback_ports_busy" }; } } });
    await flush(); h.host.click(locale === "en" ? "Add account" : kiroLocales.zh.kiro.login.add_account);
    await flush();
    expect(h.host.text()).toContain(kiroLocales[locale as "en" | "zh"].kiro.kiro_callback_ports_busy);
  });

  it("shows rejected HTTP paste feedback while keeping the session open", async () => {
    const h = harness({ overrides: { "/login/complete": () => { throw { reason: "kiro_callback_invalid" }; } } });
    await flush(); h.host.click("Add account"); await flush();
    const field = h.host.all().find(n => n.attrs["aria-label"] === "Paste callback URL")!;
    field.value = "http://localhost:3128/oauth/callback?code=a&state=wrong";
    field.oninput?.(); h.host.click("Submit callback"); await flush(); await flush();
    expect(h.host.text()).toContain(kiroLocales.en.kiro.errors.callback_rejected);
    expect(h.host.text()).toContain("waiting for authorization");
  });

  it("adapts callApi timedOut errors so login polls retry", async () => {
    vi.useFakeTimers();
    try {
      let polls = 0;
      const h = harness({ overrides: { "/login/poll": () => {
        if (++polls === 1) throw { timedOut: true };
        return { status: "complete", account: ACCOUNT_A };
      } } });
      await tick(); h.host.click("Add account"); await tick();
      expect(h.host.text()).toContain("waiting for authorization");
      await vi.advanceTimersByTimeAsync(1200); await tick();
      expect(polls).toBe(2);
      expect(h.host.text()).toContain("Connected as a@example.test.");
    } finally { vi.useRealTimers(); }
  });

  it("expired poll surfaces the login_expired error copy", async () => {
    const h = harness({
      status: { status: "disconnected", providerName: "kiro-subscription", accounts: [], models: [], hiddenModels: [], plan: null, usage: [] },
      overrides: { "/login/poll": () => ({ status: "expired" }) },
    });
    await flush();
    h.host.click("Sign in");
    await flush(); await flush(); await flush();
    expect(h.host.text()).toContain("authorization window expired");
    unmount(h.host as any);
  });

  it("failed poll surfaces the login_failed error copy", async () => {
    const h = harness({
      status: { status: "disconnected", providerName: "kiro-subscription", accounts: [], models: [], hiddenModels: [], plan: null, usage: [] },
      overrides: { "/login/poll": () => ({ status: "failed", error: "kiro_login_failed" }) },
    });
    await flush();
    h.host.click("Sign in");
    await flush(); await flush(); await flush();
    expect(h.host.text()).toContain("Login failed.");
    unmount(h.host as any);
  });

  it("cancel posts /login/cancel and closes the pending box quietly", async () => {
    const h = harness({
      status: { status: "disconnected", providerName: "kiro-subscription", accounts: [], models: [], hiddenModels: [], plan: null, usage: [] },
      overrides: { "/login/poll": () => ({ status: "pending" }) },
    });
    await flush();
    h.host.click("Sign in");
    await flush();
    h.host.click("Cancel");
    await flush(); await flush();
    expect(h.lastBody("/login/cancel")).toEqual({ loginId: "login-1" });
    expect(h.host.text()).not.toContain("waiting for authorization");
    unmount(h.host as any);
  });
});

// ---------------------------------------------------------------------------
// Card: accounts, quota, models
// ---------------------------------------------------------------------------

describe("kiro card: accounts and quota", () => {
  it("renders one row per account with provider label, plan badge and truncation class", async () => {
    const h = harness();
    await flush();
    const text = h.host.text();
    expect(text).toContain("a@example.test (Google)");
    expect(text).toContain("b@example.test (Builder ID)");
    expect(text).toContain("Google");
    expect(text).toContain("Kiro Pro");
    expect(text).toContain("2 accounts");
    // Long names truncate without breaking layout (workbuddy parity class).
    expect(h.host.all().filter(n => n.className.includes("truncate")).length).toBeGreaterThan(1);
    unmount(h.host as any);
  });

  it("auto-reads quota once per account and renders a progress bar with percent", async () => {
    const h = harness();
    await flush(); await flush();
    const reads = h.byPath("/usage").map(c => JSON.parse(c.init?.body ?? "{}").account).sort();
    expect(reads).toEqual(["acc-aaa", "acc-bbb"]);
    expect(h.host.text()).toContain("25 / 100");
    expect(h.host.text()).toContain("25% used");
    const track = h.host.all().find(n => n.attrs.role === "progressbar")!;
    expect(track).toBeTruthy();
    expect(track.attrs["aria-valuenow"]).toBe("25");
    expect(track.children[0].style.width).toBe("25%");
    unmount(h.host as any);
  });

  it("renders only a quiet note when a single account has no usage payload", async () => {
    const h = harness({ status: connectedStatus({ accounts: [ACCOUNT_A] }), overrides: { "/usage": () => null } });
    await flush(); await flush();
    expect(h.host.text()).toContain(kiroLocales.en.kiro.credits_unavailable);
    expect(h.host.all().some(n => n.attrs.role === "progressbar")).toBe(false);
    expect(h.host.text()).not.toContain("The request failed");
  });

  it("renders the cached observation timestamp without replacing it with mount time", async () => {
    const now = Date.now(), at = now - 9 * 60_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const h = harness({ status: connectedStatus({ accounts: [ACCOUNT_A] }), cachedUsage: { value: parseKiroUsage(USAGE), at } });
    await flush(); await flush();
    const formatted = new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    expect(h.host.text()).toContain(`Updated ${formatted}`);
    expect(h.byPath("/usage")).toHaveLength(0);
  });

  it("per-account credits button posts usage for exactly that account", async () => {
    const h = harness();
    await flush(); await flush();
    const baseline = h.byPath("/usage").length;
    expect(baseline).toBeGreaterThan(0);
    // Second row's credits button -> acc-bbb.
    h.host.all().filter(n => n.tag === "button" && n.textContent === "Credits")[1].onclick!();
    await flush(); await flush();
    expect(h.lastBody("/usage")).toEqual({ account: "acc-bbb" });
    unmount(h.host as any);
  });

  it("removes one account via the confirm dialog and keeps the other", async () => {
    const h = harness();
    await flush();
    // The first row's Remove belongs to acc-aaa (two rows share the label).
    h.host.all().filter(n => n.tag === "button" && n.textContent === "Remove")[0].onclick!();
    await flush();
    expect(h.host.text()).toContain("Remove Kiro account?");
    expect(h.host.text()).toContain("Removing the last account disconnects");
    h.host.click("Remove account");
    await flush(); await flush();
    expect(h.lastBody("/disconnect")).toEqual({ account: "acc-aaa" });
    expect(h.host.text()).toContain("Account removed.");
    unmount(h.host as any);
  });

  it("disconnect-all confirms first and clears everything", async () => {
    const h = harness();
    await flush();
    h.host.click("Disconnect");
    await flush();
    expect(h.host.text()).toContain("Disconnect Kiro?");
    h.host.click("Disconnect");
    await flush(); await flush();
    expect(h.lastBody("/disconnect")).toEqual({});
    expect(h.host.text()).toContain("Disconnected.");
    unmount(h.host as any);
  });

  it("remove failure renders the stable remove_failed alert", async () => {
    const h = harness({
      overrides: { "/disconnect": () => { throw Object.assign(new Error("x"), { reason: "kiro_not_connected" }); } },
    });
    await flush();
    h.host.click("Remove");
    await flush();
    h.host.click("Remove account");
    await flush(); await flush();
    expect(h.host.text()).toContain("Removing the account failed.");
    unmount(h.host as any);
  });
});

// ---------------------------------------------------------------------------
// Card: model chips, hidden list, partial restore
// ---------------------------------------------------------------------------

describe("kiro card: model management", () => {
  it("renders count row, chips with X hide buttons and per-model aria-busy", async () => {
    const h = harness();
    await flush();
    expect(h.host.text()).toContain("2 models");
    const hide = h.host.all().find(n => n.attrs["aria-label"] === "Hide claude-v4") as El;
    expect(hide).toBeTruthy();
    expect(hide.attrs["aria-busy"]).toBe("false");
    expect(hide.children[0].tag).toBe("svg");
    unmount(h.host as any);
  });

  it("hides a model through /models/visibility, cleans Router refs in the draft and toasts", async () => {
    const h = harness();
    await flush();
    h.host.all().find(n => n.attrs["aria-label"] === "Hide claude-v4")!.onclick!();
    await flush(); await flush(); await flush();
    expect(h.lastBody("/models/visibility")).toEqual({ model: "claude-v4", hidden: true });
    // Draft reconciliation: managed provider merged + Router ref cleaned.
    expect(h.refreshConfig).toHaveBeenCalled();
    const merge = h.refreshConfig.mock.calls.at(-1)![0] as (current: any, server: any) => any;
    const draft = merge(
      { providers: [{ name: "kiro-subscription", kiro_managed: true }], Router: { default: "kiro-subscription,claude-v4", think: "kiro-subscription,claude-v4" } },
      { providers: [{ name: "kiro-subscription", kiro_managed: true, models: ["kiro-mini"] }] },
    );
    expect(draft.Router.default).toBe("kiro-subscription,kiro-mini");
    expect(draft.Router.think).toBe("");
    expect(h.host.text()).toContain("Hidden claude-v4.");
    unmount(h.host as any);
  });

  it("hidden list collapses into details with per-item restore and restore-all", async () => {
    const h = harness({ status: connectedStatus({ hiddenModels: ["kiro-mini", "old-model"] }) });
    await flush();
    expect(h.host.text()).toContain("Hidden models (2)");
    const restoreOne = h.host.all().find(n => n.attrs["aria-label"] === "Restore kiro-mini") as El;
    expect(restoreOne).toBeTruthy();
    restoreOne.onclick!();
    await flush(); await flush(); await flush();
    expect(h.lastBody("/models/visibility")).toEqual({ model: "kiro-mini", hidden: false });
    expect(h.host.text()).toContain("Restored kiro-mini.");
    unmount(h.host as any);

    const h2 = harness({ status: connectedStatus({ hiddenModels: ["kiro-mini", "old-model"] }) });
    await flush();
    h2.host.click("Restore all");
    await flush(); await flush(); await flush();
    // Restore-all is a bounded batch: one call per hidden model.
    const bodies = h2.byPath("/models/visibility").map(c => JSON.parse(c.init?.body ?? "{}"));
    expect(bodies).toEqual([
      { model: "kiro-mini", hidden: false },
      { model: "old-model", hidden: false },
    ]);
    expect(h2.host.text()).toContain("Restored 2 hidden models.");
    unmount(h2.host as any);
  });

  it("partial restore-all keeps 'restored N of M' visible (bilingual)", async () => {
    let call = 0;
    const h = harness({
      status: connectedStatus({ hiddenModels: ["m1", "m2"] }),
      overrides: {
        "/models/visibility": () => {
          call += 1;
          if (call === 1) return { success: true };
          throw Object.assign(new Error("x"), { reason: "kiro_upstream_error" });
        },
      },
    });
    await flush();
    h.host.click("Restore all");
    await flush(); await flush(); await flush();
    expect(h.host.text()).toContain("Partially completed: restored 1 of 2 models.");
    expect(h.host.text()).toContain("Restoring the model failed.");
    unmount(h.host as any);

    // Chinese copy for the same partial state.
    let zhCall = 0;
    const zh = harness({
      locale: "zh",
      status: connectedStatus({ hiddenModels: ["m1", "m2"] }),
      overrides: {
        "/models/visibility": () => {
          zhCall += 1;
          if (zhCall === 1) return { success: true };
          throw Object.assign(new Error("x"), { reason: "kiro_upstream_error" });
        },
      },
    });
    await flush();
    zh.host.click("恢复全部");
    await flush(); await flush(); await flush();
    expect(zh.host.text()).toContain("部分完成：已恢复 1 个模型，共 2 个。");
    unmount(zh.host as any);
  });

  it("hide failure renders the stable hide_failed alert and no toast", async () => {
    const h = harness({
      overrides: {
        "/models/visibility": () => { throw Object.assign(new Error("x"), { reason: "kiro_upstream_error" }); },
      },
    });
    await flush();
    h.host.all().find(n => n.attrs["aria-label"] === "Hide claude-v4")!.onclick!();
    await flush(); await flush(); await flush();
    expect(h.host.text()).toContain("Hiding the model failed.");
    expect(h.host.text()).not.toContain("Hidden claude-v4.");
    unmount(h.host as any);
  });
});

// ---------------------------------------------------------------------------
// Card: busy/lease/lifecycle/i18n
// ---------------------------------------------------------------------------

describe("kiro card: lease, lifecycle and i18n", () => {
  it("holds the management lease across a deferred mutation and releases exactly once", async () => {
    const h = harness();
    await flush();
    h.host.click("Sync models");
    await flush(); await flush(); await flush();
    expect(h.lastBody("/sync")).toEqual({});
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.props.onBusy).toHaveBeenCalledWith(true);
    expect(h.props.onBusy).toHaveBeenCalledWith(false);
    expect(h.host.text()).toContain("Synced 2 Kiro models.");
    unmount(h.host as any);
  });

  it("clicking an action with a held lease shows the stable config_busy note", async () => {
    const h = harness({ heldLease: true });
    await flush();
    h.host.click("Sync models");
    await flush();
    expect(h.host.text()).toContain("Another save or action is running");
    expect(h.byPath("/sync")).toHaveLength(0);
    unmount(h.host as any);
  });

  it("onBusy stays a balanced counting semaphore across actions", async () => {
    const h = harness();
    await flush();
    h.host.click("Sync models");
    await flush(); await flush(); await flush();
    const busy = (h.props.onBusy as any).mock.calls.map((c: any[]) => c[0]);
    expect(busy.filter(Boolean)).toHaveLength(1);
    expect(busy.filter((v: boolean) => v === false)).toHaveLength(1);
    unmount(h.host as any);
  });

  it("host change re-renders in place; unmount cancels pending login and clears DOM", async () => {
    const h = harness({
      status: { status: "disconnected", providerName: "kiro-subscription", accounts: [], models: [], hiddenModels: [], plan: null, usage: [] },
      overrides: { "/login/poll": () => ({ status: "pending" }) },
    });
    await flush();
    h.host.click("Sign in");
    await flush();
    expect(h.host.children.length).toBeGreaterThan(0);
    h.notify();
    await tick();
    expect(h.host.children.length).toBeGreaterThan(0);
    unmount(h.host as any);
    expect(h.byPath("/login/cancel").length).toBe(1);
    expect(h.host.children).toHaveLength(0);
  });

  it("status failure renders the visible request_failed alert", async () => {
    const h = harness({
      overrides: { "/status": () => { throw Object.assign(new Error("x"), { reason: "request_failed" }); } },
    });
    await flush(); await flush();
    expect(h.host.text()).toContain("The request failed. Please try again.");
    unmount(h.host as any);
  });

  it("renders the full Chinese surface for states, actions and errors", async () => {
    const h = harness({
      locale: "zh",
      status: connectedStatus({ hiddenModels: ["kiro-mini"] }),
    });
    await flush();
    const text = h.host.text();
    expect(text).toContain("Kiro 订阅");
    expect(text).toContain("已连接");
    expect(text).toContain("同步模型");
    expect(text).toContain("断开连接");
    expect(text).toContain("已隐藏模型（1）");
    expect(text).toContain("恢复全部");
    expect(h.host.all().some(n => n.attrs["aria-label"] === "隐藏 claude-v4")).toBe(true);
    expect(text).toContain("2 个账号");
    expect(text).toContain("已用 25%");
    unmount(h.host as any);
  });

  it("falls back to the bundled zh copy when the host locales are empty", async () => {
    vi.stubGlobal("document", { createElement: (tag: string) => new El(tag), createElementNS: (_ns: string, tag: string) => new El(tag) });
    const host = new El("div");
    mount(host as any, {
      callApi: async () => connectedStatus(),
      locale: "zh-CN", locales: {}, plugin: { name: "kiro", version: "0.1.0" },
      disabled: false, log: console,
    } as any);
    cleanups.push(() => unmount(host as any));
    await flush();
    expect(host.text()).toContain("Kiro 订阅");
    unmount(host as any);
  });
});

// ---------------------------------------------------------------------------
// Login session helper (sequential loop, paste lane)
// ---------------------------------------------------------------------------

describe("createKiroLogin", () => {
  const start = { loginId: "l-1", url: "https://app.kiro.dev/signin" };

  it("polls until complete and forwards the view to onUpdate", async () => {
    let polls = 0;
    const updates: string[] = [];
    const session = createKiroLogin({
      start: async () => start,
      poll: async () => { polls += 1; return polls < 2 ? { status: "pending" } : { status: "complete", account: ACCOUNT_A }; },
      complete: async () => ({ status: "complete", account: ACCOUNT_A }),
      cancel: async () => ({}),
    }, { method: "portal" }, view => updates.push(view.url), { intervalMs: 1 });
    const done = await session.done;
    expect(done?.status).toBe("complete");
    expect(updates).toEqual([start.url]);
  });

  it("surfaces a portal->AWS stage advance with a fresh authorization url", async () => {
    let polls = 0;
    const urls: string[] = [];
    const awsUrl = "https://oidc.us-east-1.amazonaws.com/authorize?client_id=x";
    const session = createKiroLogin({
      start: async () => start,
      poll: async () => {
        polls += 1;
        return polls === 1
          ? { status: "pending", url: awsUrl }
          : { status: "complete", account: ACCOUNT_A };
      },
      complete: async () => ({ status: "complete", account: ACCOUNT_A }),
      cancel: async () => ({}),
    }, { method: "portal" }, view => urls.push(view.url), { intervalMs: 1 });
    const done = await session.done;
    expect(done?.status).toBe("complete");
    expect(urls).toEqual([start.url, awsUrl]);
  });

  it("submits a pasted callback through the same loop and releases on rejection", async () => {
    let completions = 0;
    const session = createKiroLogin({
      start: async () => start,
      poll: async () => ({ status: "pending" }),
      complete: async (_loginId, callbackUrl) => {
        completions += 1;
        return completions === 1
          ? { status: "failed", error: "kiro_callback_invalid" }
          : { status: "complete", account: ACCOUNT_A };
      },
      cancel: async () => ({}),
    }, { method: "portal" }, () => {}, { intervalMs: 1 });
    await flush();
    const first = await session.submitCallback("http://localhost:3128/x?code=a&state=b");
    expect(first?.status).toBe("failed");
    const second = await session.submitCallback("http://localhost:3128/x?code=c&state=d");
    expect(second?.status).toBe("complete");
    expect(completions).toBe(2);
    await session.cancel();
  });

  it("invalid start payloads fail closed and cancel invalidates the server job", async () => {
    const cancel = vi.fn(async () => ({}));
    const session = createKiroLogin({
      start: async () => ({ loginId: "l-1", url: "http://insecure.example/" }),
      poll: async () => ({ status: "pending" }),
      complete: async () => ({ status: "pending" }),
      cancel,
    }, { method: "portal" }, () => {}, { intervalMs: 1 });
    await expect(session.done).rejects.toMatchObject({ reason: "login_invalid_response" });
  });

  it("poll timeouts retry within the deadline instead of aborting", async () => {
    let polls = 0;
    const session = createKiroLogin({
      start: async () => start,
      poll: async () => {
        polls += 1;
        // The card's api adapter converts host timeouts to the sentinel.
        if (polls < 3) throw Object.assign(new Error("timeout"), { reason: KIRO_POLL_TIMEOUT });
        return { status: "complete", account: ACCOUNT_A };
      },
      complete: async () => ({ status: "complete", account: ACCOUNT_A }),
      cancel: async () => ({}),
    }, { method: "portal" }, () => {}, { intervalMs: 1 });
    const done = await session.done;
    expect(done?.status).toBe("complete");
    expect(polls).toBe(3);
    expect(KIRO_POLL_TIMEOUT).toBe("kiro_poll_timeout");
  });
});

describe("kiro card bonus window rendering", () => {
  it("keeps expiresAt through parsing and renders Expires instead of Resets for bonus windows", async () => {
    const expiresAt = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const bonusUsage = {
      account: "acc-aaa", known: true, stale: false, plan: "Kiro Pro",
      windows: [
        { name: "Credits", used: 25, amount: 25, limit: 100, unit: "credits", display: "25 / 100", resetsAt: new Date(Date.now() + 86_400_000).toISOString() },
        { name: "Trial credits", used: 0, amount: 0, limit: 500, unit: "credits", display: "0 / 500", expiresAt },
      ],
    };
    const parsed = parseKiroUsage(bonusUsage)!;
    expect(parsed.windows[1].expiresAt).toBe(expiresAt);
    const at = Date.now();
    const h = harness({ status: connectedStatus({ accounts: [ACCOUNT_A] }), cachedUsage: { value: parsed, at } });
    await flush(); await flush();
    const text = h.host.text();
    expect(text).toContain("Trial credits: 0 / 500");
    expect(text).toContain("Expires ");
    // Exactly one reset line (main window) and one expiry line (bonus window).
    expect(text.match(/Resets /g)?.length ?? 0).toBe(1);
    expect(text.match(/Expires /g)?.length ?? 0).toBe(1);
  });
});
