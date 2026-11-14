/**
 * Gemini OAuth card — independent quota-pools surface.
 *
 * Drives the real mount/unmount/click handlers with the same minimal DOM
 * double as the other card tests: no framework, no fetch, every request goes
 * through the host `callApi` bridge. Fixtures use only example.test /
 * example.com identities and dummy tokens — never live credentials.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, unmount } from "../src/card-entry";
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
  click(text: string) { const b = this.button(text); if (!b.disabled) b.onclick?.(); }
  text(): string { return this.all().map(n => n.textContent).join("\n"); }
}

const tick = async () => { for (let i = 0; i < 25; ++i) await Promise.resolve(); };
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(f => f()); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const en = geminiOauthLocales.en.geminiOauth as any;
const zh = geminiOauthLocales.zh.geminiOauth as any;

// Unambiguous against the real clock the card uses: FUTURE days ahead,
// PAST days behind (same-day clock-time constants would flip twice a day).
const FUTURE = "2026-11-20T18:00:00.000Z";
const PAST = "2026-11-10T06:00:00.000Z";
const connected = (overrides: Record<string, unknown> = {}) => ({
  configured: true, connected: true, kind: "antigravity",
  email: "user@example.test", project: "project-example", tier: "paid",
  modelsCount: 2, models: ["gemini-4-argon", "gemini-4-hydrogen"], hiddenModels: [], ...overrides,
});
/** Independent Argon/Hydrogen/Claude buckets with their own counts and resets,
 *  plus grouped upstream windows that must never be reassigned to a model. */
const snapshot = () => ({
  models: {
    "gemini-4-argon": { remaining: 0, resetAt: FUTURE },
    "gemini-4-hydrogen": { remaining: 0.7, resetAt: FUTURE },
    "claude-sonnet-4-6": { remaining: 1 },
  },
  pools: [
    { pool: "Gemini", window: "5h", remaining: 0, resetAt: FUTURE },
    { pool: "Gemini", window: "weekly", remaining: 0.8, resetAt: FUTURE },
    { pool: "Claude & GPT", window: "5h", remaining: 0.55 },
  ],
});

interface HarnessOptions {
  status?: any;
  locale?: string;
  disabled?: boolean;
  routes?: Record<string, (init?: any) => any>;
}

function harness(options: HarnessOptions = {}) {
  vi.stubGlobal("document", { createElement: (tag: string) => new Element(tag), createElementNS: () => new Element("svg") as any });
  vi.stubGlobal("window", { open: vi.fn() });
  const host = new Element("div");
  const routes = options.routes ?? {};
  const calls: Array<{ path: string; init: any }> = [];
  const callApi = vi.fn(async (path: string, init?: any) => {
    calls.push({ path, init });
    if (routes[path]) return routes[path](init);
    if (path === "/status") return options.status ?? connected();
    if (path === "/quota") return snapshot();
    return { ok: true };
  });
  let lock = false;
  const release = vi.fn(() => { lock = false; });
  const refreshConfig = vi.fn(async () => {});
  let hostListener: (() => void) | null = null;
  const props: any = {
    callApi: callApi as any,
    locale: options.locale ?? "en",
    locales: geminiOauthLocales,
    disabled: options.disabled ?? false,
    plugin: { name: "gemini-oauth", version: "1" },
    log: console,
    acquireManagement: () => (lock ? null : (lock = true, release)),
    onBusy: vi.fn(),
    refreshConfig,
    onHostChange: (listener: () => void) => { hostListener = listener; return () => { hostListener = null; }; },
  };
  mount(host as any, props);
  cleanups.push(() => unmount(host as any));
  const quotaSection = () =>
    host.all().find(n => n.tag === "section" && n.children.some(c => c.tag === "div" && c.text().includes((options.locale ?? "en").startsWith("zh") ? zh.quota.title : en.quota.title))) as Element | undefined;
  return {
    host, props, calls, callApi, release, refreshConfig,
    get lock() { return lock; },
    notify() { hostListener?.(); },
    paths() { return calls.map(c => c.path); },
    quotaCalls() { return calls.filter(c => c.path === "/quota"); },
    quotaSection,
  };
}

describe("Gemini card quota surface — mount contract and independent rows", () => {
  it("reads quota once after the connected status read, with GET-only calls and no management lease", async () => {
    const h = harness(); await tick();
    expect(h.paths()).toEqual(["/status", "/quota"]);
    expect(h.quotaCalls()[0].init).toMatchObject({ method: "GET" });
    expect(h.release).not.toHaveBeenCalled();
    expect(h.props.onBusy).not.toHaveBeenCalled();
  });

  it("renders separate Argon, Hydrogen and Claude buckets even when figures differ, and keeps grouped windows labeled", async () => {
    const h = harness(); await tick();
    const text = h.host.text();
    // Independent identities, each with its own figure.
    expect(text).toContain(en.quota.identity.argon);
    expect(text).toContain(en.quota.identity.hydrogen);
    expect(text).toContain(en.quota.identity.claude);
    expect(text).toContain("gemini-4-argon");
    expect(text).toContain("gemini-4-hydrogen");
    expect(text).toContain("claude-sonnet-4-6");
    expect(text).toContain(en.quota.exhausted); // Argon at zero, not hidden
    expect(text).toContain("70%");
    expect(text).toContain("100%");
    // Reset timestamp rendered for buckets that carry one.
    expect(text).toContain(en.quota.reset_at.replace("{{time}}", "").trim());
    // Grouped upstream windows keep their own 5h/weekly labels.
    expect(text).toContain("5h");
    expect(text).toContain("weekly");
    expect(text).toContain("Gemini");
    expect(text).toContain("Claude & GPT");
    // Model buckets never borrow a window label: the window badges live in the
    // grouped section only, so no model row can be read as "5h" or "weekly".
    const section = h.quotaSection()!;
    const groups = section.children.filter(n => n.tag === "div");
    const modelGroup = groups.find(g => g.text().includes(en.quota.model_buckets))!;
    const poolGroup = groups.find(g => g.text().includes(en.quota.grouped_windows))!;
    expect(modelGroup.text()).not.toContain("5h");
    expect(modelGroup.text()).not.toContain("weekly");
    expect(poolGroup.text()).toContain("weekly");
    // The broad weekly Gemini number is never printed next to an individual model.
    expect(modelGroup.text()).not.toContain("80%");
  });

  it("an exhausted pool leaves every sibling bucket and the other grouped window visible", async () => {
    const h = harness(); await tick();
    const text = h.host.text();
    const exhaustedCount = text.split(en.quota.exhausted).length - 1;
    // Argon model bucket and the Gemini 5h group are exhausted; two occurrences.
    expect(exhaustedCount).toBe(2);
    // Hydrogen, Claude and the weekly window remain on screen.
    expect(text).toContain("70%");
    expect(text).toContain("100%");
    expect(text).toContain("55%");
    expect(text).toContain("80%");
  });

  it("renders the Chinese bundle with identical structure and its own copy", async () => {
    const h = harness({ locale: "zh-CN" }); await tick();
    const text = h.host.text();
    expect(text).toContain(zh.quota.title);
    expect(text).not.toContain(en.quota.title);
    expect(text).toContain(zh.quota.identity.argon);
    expect(text).toContain(zh.quota.identity.hydrogen);
    expect(text).toContain(zh.quota.identity.claude);
    expect(text).toContain(zh.quota.refresh);
    expect(text).toContain(zh.quota.exhausted);
    expect(text).toContain("5h"); // upstream window labels stay verbatim
    expect(text).toContain("weekly");
    expect(h.paths()).toEqual(["/status", "/quota"]);
  });
});

describe("Gemini card quota surface — unavailable is never zero or full", () => {
  it("shows the quiet unavailable line for a null snapshot without raw errors or invented figures", async () => {
    const h = harness({ routes: { "/quota": () => null } }); await tick();
    const text = h.host.text();
    expect(text).toContain(en.quota.unavailable);
    expect(text).not.toContain("0%");
    expect(text).not.toContain("100%");
    expect(text).not.toContain("5h");
  });

  it("treats a route failure (older host without the route) as unavailable, never as an error card", async () => {
    const h = harness({ routes: { "/quota": () => { throw Object.assign(new Error("ya29.private-token"), { reason: "request_failed" }); } } });
    await tick();
    const text = h.host.text();
    expect(text).toContain(en.quota.unavailable);
    expect(text).not.toContain("ya29.private-token");
    expect(text).not.toContain("request_failed");
  });

  it("drops a malformed payload as unavailable while a later refresh can recover", async () => {
    let malformed = true;
    const h = harness({ routes: { "/quota": () => (malformed ? { models: [], pools: {} } : snapshot()) } });
    await tick();
    expect(h.host.text()).toContain(en.quota.unavailable);
    malformed = false;
    h.host.click(en.quota.refresh); await tick();
    expect(h.host.text()).toContain("gemini-4-argon");
    expect(h.quotaCalls()).toHaveLength(2);
  });

  it("keeps the figure but hides an expired reset rather than showing a stale timestamp", async () => {
    const h = harness({
      routes: {
        "/quota": () => ({
          models: { "gemini-4-argon": { remaining: 0.3, resetAt: PAST } },
          pools: [{ pool: "Gemini", window: "5h", remaining: 0.3, resetAt: PAST }],
        }),
      },
    });
    await tick();
    const text = h.host.text();
    expect(text).toContain("30%");
    expect(text).not.toContain(en.quota.reset_at.replace("{{time}}", "").trim());
  });

  it("non-numeric and missing figures render as unavailable rows only when nothing valid remains", async () => {
    // Status carries no model chips here so the assertion scopes to the quota surface.
    const h = harness({
      status: connected({ modelsCount: 0, models: [] }),
      routes: {
        "/quota": () => ({
          models: {
            "gemini-4-argon": { remaining: "not-a-number" },
            "gemini-4-hydrogen": {},
          },
          pools: [],
        }),
      },
    });
    await tick();
    const section = h.quotaSection()!;
    expect(section.text()).toContain(en.quota.unavailable);
    expect(section.text()).not.toContain("gemini-4-argon");
    expect(section.text()).not.toContain("0%");
  });
});

describe("Gemini card quota surface — refresh, host gate and lease isolation", () => {
  it("the refresh button issues exactly one more read-only quota GET", async () => {
    const h = harness(); await tick();
    h.host.click(en.quota.refresh); await tick();
    expect(h.quotaCalls()).toHaveLength(2);
    for (const call of h.quotaCalls()) expect(call.init).toMatchObject({ method: "GET" });
    expect(h.paths().filter(p => p !== "/status" && p !== "/quota")).toEqual([]);
  });

  it("disables refresh under the host gate without issuing extra reads on host changes", async () => {
    const h = harness({ disabled: true }); await tick();
    expect(h.quotaSection()!.button(en.quota.refresh).disabled).toBe(true);
    const reads = h.quotaCalls().length;
    h.notify(); await tick();
    expect(h.quotaCalls()).toHaveLength(reads);
    h.props.disabled = false; h.notify(); await tick();
    expect(h.quotaSection()!.button(en.quota.refresh).disabled).toBe(false);
    expect(h.quotaCalls()).toHaveLength(reads);
  });

  it("a background quota read cannot release a mutation's management lease", async () => {
    let resolveQuota!: (value: unknown) => void;
    const quotaPending = new Promise(done => { resolveQuota = done; });
    let resolveSync!: (value: unknown) => void;
    const syncPending = new Promise(done => { resolveSync = done; });
    const h = harness({ routes: { "/quota": () => quotaPending, "/sync": () => syncPending } });
    await tick();
    expect(h.quotaCalls()).toHaveLength(1); // still loading
    // A managed mutation starts while the read-only quota fetch is in flight.
    h.host.click(en.sync); await tick();
    expect(h.lock).toBe(true);
    resolveQuota(snapshot()); await tick();
    // The read settled and rendered, but the action lock is untouched.
    expect(h.lock).toBe(true);
    expect(h.release).not.toHaveBeenCalled();
    expect(h.host.text()).toContain("gemini-4-hydrogen");
    resolveSync({ ok: true, modelsCount: 3 }); await tick();
    expect(h.lock).toBe(false);
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it("never reads quota while disconnected and renders no quota section", async () => {
    const h = harness({ status: { configured: true, connected: false, kind: "antigravity", modelsCount: 0, models: [], hiddenModels: [] } });
    await tick();
    expect(h.quotaCalls()).toEqual([]);
    expect(h.quotaSection()).toBeUndefined();
  });
});

describe("Gemini card quota surface — identity races and disposal", () => {
  it("a quota response landing after unmount is dropped and never touches the DOM", async () => {
    let resolveQuota!: (value: unknown) => void;
    const quotaPending = new Promise(done => { resolveQuota = done; });
    const h = harness({ routes: { "/quota": () => quotaPending } });
    await tick();
    expect(h.host.text()).toContain(en.status.loading);
    unmount(h.host as any);
    expect(h.host.children).toEqual([]);
    resolveQuota(snapshot()); await tick();
    expect(h.host.children).toEqual([]);
  });

  it("disconnect drops the connected account's snapshot and never re-reads quota", async () => {
    const statuses = [connected(), { configured: true, connected: false, kind: "antigravity", modelsCount: 0, models: [], hiddenModels: [] }];
    let statusIndex = 0;
    const h = harness({ routes: { "/status": () => statuses[Math.min(statusIndex++, statuses.length - 1)] } });
    await tick();
    expect(h.host.text()).toContain("gemini-4-argon");
    h.host.click(en.disconnect); await tick();
    h.host.click(en.disconnect); await tick(); // confirm dialog
    expect(h.quotaSection()).toBeUndefined();
    // Only the single mount quota read: disconnect invalidated it, no refill.
    expect(h.quotaCalls()).toHaveLength(1);
    expect(h.host.text()).not.toContain("gemini-4-argon");
  });

  it("a login that switches identity drops the old-account response and reads quota for the new one", async () => {
    // First account: its quota response stays pending across the re-login.
    let resolveOldQuota!: (value: unknown) => void;
    const oldQuotaPending = new Promise(done => { resolveOldQuota = done; });
    const accountA = connected();
    const accountB = connected({ email: "other@example.test", project: "project-other" });
    let current = accountA;
    let statusCalls = 0;
    const h = harness({
      routes: {
        // Mount reads account A; every later status read (post-login settle) is B.
        "/status": () => (++statusCalls === 1 ? accountA : (current = accountB)),
        "/quota": () => (current === accountA ? oldQuotaPending : snapshot()),
        "/login/start": () => ({ loginId: "a".repeat(48), url: "https://accounts.example.com/oauth", expiresAt: Date.now() + 60_000 }),
        "/login/poll": () => ({ status: "success", email: "other@example.test" }),
      },
    });
    await tick();
    expect(h.quotaCalls()).toHaveLength(1); // account A read, pending
    // Complete the consent flow; poll succeeds and settle re-reads status as B.
    h.host.click(en.reconnect);
    const ack = h.host.all().find(n => n.tag === "input")!;
    ack.checked = true; ack.onchange?.();
    h.host.click(en.risk_continue); await tick();
    // A fresh quota read was issued for account B; the old read is now stale.
    expect(h.quotaCalls()).toHaveLength(2);
    resolveOldQuota({ models: { "gemini-4-argon": { remaining: 0.01 } }, pools: [] });
    await tick();
    const text = h.host.text();
    // The old account's distinctive 1% figure never made it onto the surface.
    expect(text).not.toContain("1%");
    // Account B's snapshot rendered through the second read.
    expect(text).toContain("gemini-4-hydrogen");
    expect(text).toContain("70%");
  });

  it("a failed re-login on the same account refills the quota surface once", async () => {
    const h = harness({
      routes: {
        "/login/start": () => { throw Object.assign(new Error("blocked"), { error: "gemini_oauth_login_busy" }); },
      },
    });
    await tick();
    expect(h.quotaCalls()).toHaveLength(1);
    h.host.click(en.reconnect);
    const ack = h.host.all().find(n => n.tag === "input")!;
    ack.checked = true; ack.onchange?.();
    h.host.click(en.risk_continue); await tick();
    // The action cleared the surface at start; the same-account finally refills.
    expect(h.quotaCalls()).toHaveLength(2);
    expect(h.host.text()).toContain("gemini-4-argon");
  });
});
