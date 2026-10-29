import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, unmount } from "../src/card-entry";
import { geminiOauthLocales } from "../src/locales";

/** Minimal DOM test double: exercise real mount/unmount/event handlers without
 * shipping or requiring a DOM framework in the production card chunk. */
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
const tick = async () => { for (let i = 0; i < 15; ++i) await Promise.resolve(); };
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(f => f()); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function harness(overrides: Record<string, (init?: any) => any> = {}, disabled = false) {
  vi.stubGlobal("document", { createElement: (tag: string) => new Element(tag), createElementNS: () => new Element("svg") as any });
  const open = vi.fn(); vi.stubGlobal("window", { open });
  const host = new Element("div");
  const status = { configured: true, connected: true, kind: "antigravity", email: "user@example.test", project: "p", tier: "paid", modelsCount: 2 };
  const callApi = vi.fn(async (path: string, init?: any) => {
    if (overrides[path]) return overrides[path](init);
    if (path === "/status") return status;
    if (path === "/login/start") return { loginId: "a".repeat(48), url: "https://accounts.google.com/oauth", expiresAt: Date.now() + 60_000 };
    if (path === "/login/poll") return { status: "success", email: "user@example.test" };
    if (path === "/sync") return { ok: true, modelsCount: 3, clearedRefs: ["default"] };
    return { ok: true };
  });
  // Mirrors ApiClient.acquireWorkBuddyManagement: null while a managed action
  // or config write holds the shared lease; the release is a spy.
  let lock = false;
  const release = vi.fn(() => { lock = false; });
  const refreshFail = overrides.refreshFail === true;
  const refreshConfig = vi.fn(async (_merge: (current: any, server: any) => any) => {
    if (refreshFail) throw new Error("Configuration refresh failed");
  });
  let hostListener: (() => void) | null = null;
  let unsubscribed = 0;
  const props = {
    callApi: callApi as any, locale: "en", locales: geminiOauthLocales,
    disabled, plugin: { name: "gemini-oauth", version: "1" }, log: console,
    acquireManagement: () => (lock ? null : (lock = true, release)), onBusy: vi.fn(), refreshConfig,
    onHostChange: (listener: () => void) => {
      hostListener = listener;
      return () => { if (hostListener === listener) hostListener = null; unsubscribed += 1; };
    },
  };
  mount(host as any, props);
  cleanups.push(() => unmount(host as any));
  return {
    host, callApi, open, release, onBusy: props.onBusy, refreshConfig, props,
    get lock() { return lock; },
    get unsubscribed() { return unsubscribed; },
    notify() { hostListener?.(); },
    statusReads() { return callApi.mock.calls.filter(([path]) => path === "/status").length; },
  };
}
const en = geminiOauthLocales.en.geminiOauth as any;
describe("self-contained Gemini plugin card", () => {
  it("mount performs only a status read; checkbox acknowledgement gates the ONLY login action", async () => {
    const h = harness(); await tick();
    expect(h.callApi.mock.calls.map(([path]) => path)).toEqual(["/status"]);
    expect(h.host.text()).toContain(en.status.connected);
    // Visual contract: the pre-migration look is expressed through host
    // stylesheet classes (glass card, badges, primary/outline button
    // hierarchy) — never inline cssText anymore.
    const card = h.host.all().find(n => n.className?.includes("glass-card"))!;
    expect(card, "glass card container").toBeTruthy();
    const authorize = h.host.button(en.reconnect);
    expect(authorize.className).toContain("bg-primary");
    expect(authorize.style.cssText).toBe("");
    expect(h.host.button(en.sync).className).toContain("border-input");
    expect(h.host.all().filter(n => n.tag === "svg").length).toBeGreaterThanOrEqual(3); // KeyRound + Plug + RefreshCw
    const statusBadge = h.host.all().find(n => n.textContent === en.status.connected && n.attrs?.role === "status")!;
    expect(statusBadge.className).toContain("bg-white/5");
    h.host.click(en.reconnect);
    expect(h.host.text()).toContain(en.risk);
    expect(h.host.button(en.risk_continue).disabled).toBe(true);
    h.host.click(en.risk_continue); await tick();
    expect(h.callApi).toHaveBeenCalledTimes(1);
    const ack = h.host.all().find(n => n.tag === "input")!;
    ack.checked = true; ack.onchange?.();
    h.host.click(en.risk_continue); await tick();
    expect(h.open).toHaveBeenCalledWith("https://accounts.google.com/oauth", "_blank", "noopener,noreferrer");
    expect(h.callApi.mock.calls.map(([path]) => path)).toContain("/login/poll");
    expect(h.refreshConfig).toHaveBeenCalledTimes(1);
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.onBusy.mock.calls.map(([busy]) => busy)).toEqual([true, false]);
  });

  it("host disabled transitions re-render the mounted card in place: no remount, no cancel, no release", async () => {
    const h = harness(); await tick();
    expect(h.statusReads()).toBe(1);
    expect(h.host.button(en.sync).disabled).toBe(false);
    // Open the consent dialog: its survival across a disabled flip proves the
    // same card instance re-rendered (a remount would reset to the loading view).
    h.host.click(en.reconnect);
    expect(h.host.text()).toContain(en.risk);
    h.props.disabled = true; h.notify();
    expect(h.host.button(en.sync).disabled).toBe(true);
    expect(h.host.button(en.reconnect).disabled).toBe(true);
    expect(h.host.text()).toContain(en.other_edit);
    expect(h.host.text()).toContain(en.risk);
    // In-place update only: no extra status read, no lease movement, no unmount.
    expect(h.statusReads()).toBe(1);
    expect(h.release).toHaveBeenCalledTimes(0);
    expect(h.unsubscribed).toBe(0);
    h.props.disabled = false; h.notify();
    expect(h.host.button(en.sync).disabled).toBe(false);
    expect(h.host.button(en.reconnect).disabled).toBe(false);
    expect(h.host.text()).toContain(en.risk);
    expect(h.statusReads()).toBe(1);
    unmount(h.host as any);
    expect(h.unsubscribed).toBe(1);
  });

  it("disabled-on-mount cards enable in place when the host gate lifts, still without a remount", async () => {
    const h = harness({}, true); await tick();
    expect(h.statusReads()).toBe(1);
    expect(h.host.button(en.sync).disabled).toBe(true);
    h.props.disabled = false; h.notify();
    expect(h.host.button(en.sync).disabled).toBe(false);
    expect(h.statusReads()).toBe(1); // the transition triggers no extra status read
    expect(h.release).toHaveBeenCalledTimes(0);
    unmount(h.host as any);
  });
  it("sync reconciles drafts and only reports server count/refs; disconnect is double-confirmed", async () => {
    const h = harness(); await tick();
    h.host.click(en.sync); await tick();
    expect(h.host.text()).toContain("Registered 3 Gemini models and cleared default from Router.");
    const merge = h.refreshConfig.mock.calls[0]?.[0] as any;
    // Host gets the exact merge function; unrelated local drafts survive.
    const local = { Providers: [{ name: "draft" }], Router: { default: "draft,m" } };
    expect(merge(local, { Providers: [] }).Router).toBe(local.Router);
    h.host.click(en.disconnect); await tick();
    expect(h.callApi.mock.calls.some(([path]) => path === "/disconnect")).toBe(false);
    expect(h.host.text()).toContain(en.disconnect_warning);
    h.host.click(en.disconnect); await tick();
    expect(h.callApi.mock.calls.filter(([path]) => path === "/disconnect")).toHaveLength(1);
  });
  it("unmount while login/start is pending cancels the late job and never opens a window", async () => {
    let resolve!: (value: any) => void;
    const pending = new Promise(done => { resolve = done; });
    const h = harness({ "/login/start": () => pending }); await tick();
    h.host.click(en.reconnect);
    const ack = h.host.all().find(n => n.tag === "input")!; ack.checked = true; ack.onchange?.();
    h.host.click(en.risk_continue); await tick();
    unmount(h.host as any);
    resolve({ loginId: "a".repeat(48), url: "https://accounts.google.com/oauth", expiresAt: Date.now() + 60_000 });
    await tick();
    expect(h.open).not.toHaveBeenCalled();
    expect(h.callApi.mock.calls.filter(([path]) => path === "/login/cancel")).toHaveLength(1);
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.host.children).toEqual([]);
  });
  it("raw upstream exceptions cannot enter the rendered error surface", async () => {
    const h = harness({ "/sync": () => { throw new Error("ya29.private-token"); } }); await tick();
    h.host.click(en.sync); await tick();
    expect(h.host.text()).toContain(en.errors.request_failed);
    expect(h.host.text()).not.toContain("ya29.");
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it("unmount during a deferred sync keeps the management lease; a config save stays blocked until reconciliation settles", async () => {
    let resolveSync!: (value: any) => void;
    const pending = new Promise(done => { resolveSync = done; });
    const h = harness({ "/sync": () => pending }); await tick();
    h.host.click(en.sync); await tick();
    expect(h.lock).toBe(true);
    // Settings navigation / locale change disposes the card mid-flight.
    unmount(h.host as any);
    expect(h.host.children).toEqual([]);
    expect(h.onBusy.mock.calls.map(([busy]) => busy)).toEqual([true]); // visual busy stays with the host
    // An attempted full-config save after unmount must still be excluded…
    expect(h.props.acquireManagement()).toBeNull();
    // …until the deferred mutation and its reconciliation finish.
    resolveSync({ ok: true, modelsCount: 2 }); await tick();
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.refreshConfig).toHaveBeenCalledTimes(1);
    expect(h.statusReads()).toBe(2); // initial + post-commit reread, even after unmount
    expect(h.props.acquireManagement()).not.toBeNull(); // saves allowed again
  });

  it("unmount during a deferred disconnect keeps the lease until the action settles", async () => {
    let resolveDisconnect!: (value: any) => void;
    const pending = new Promise(done => { resolveDisconnect = done; });
    const h = harness({ "/disconnect": () => pending }); await tick();
    h.host.click(en.disconnect); await tick();
    h.host.click(en.disconnect); await tick(); // dialog confirm
    expect(h.lock).toBe(true);
    unmount(h.host as any);
    expect(h.props.acquireManagement()).toBeNull();
    resolveDisconnect({ ok: true, removedModelRefs: ["default"] }); await tick();
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.refreshConfig).toHaveBeenCalledTimes(1);
    expect(h.statusReads()).toBe(2);
    expect(h.props.acquireManagement()).not.toBeNull();
  });

  it("a committed sync settles status even when draft reconciliation fails; the failure is reported separately", async () => {
    const h = harness({ refreshFail: true, "/sync": () => ({ ok: true, modelsCount: 2 }) }); await tick();
    h.host.click(en.sync); await tick();
    expect(h.refreshConfig).toHaveBeenCalledTimes(1);
    expect(h.statusReads()).toBe(2); // committed reread must not be skipped
    expect(h.host.text()).toContain("Registered 2 Gemini models. Router unchanged.");
    expect(h.host.text()).toContain(en.errors.reconciliation_failed);
    expect(h.host.text()).not.toContain(en.errors.request_failed);
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it("a committed disconnect settles status even when draft reconciliation fails", async () => {
    const h = harness({ refreshFail: true }); await tick();
    h.host.click(en.disconnect); await tick();
    h.host.click(en.disconnect); await tick();
    expect(h.refreshConfig).toHaveBeenCalledTimes(1);
    expect(h.statusReads()).toBe(2);
    expect(h.host.text()).toContain(en.disconnected);
    expect(h.host.text()).toContain(en.errors.reconciliation_failed);
    expect(h.host.text()).not.toContain(en.errors.request_failed);
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it("a successful action clears the reconciliation warning on the next attempt", async () => {
    let failRefresh = true;
    const h = harness({ refreshFail: true });
    // Flip the refresh outcome between actions.
    h.refreshConfig.mockImplementation(async () => { if (failRefresh) throw new Error("Configuration refresh failed"); });
    await tick();
    h.host.click(en.disconnect); await tick();
    h.host.click(en.disconnect); await tick();
    expect(h.host.text()).toContain(en.errors.reconciliation_failed);
    failRefresh = false;
    h.host.click(en.sync); await tick();
    expect(h.host.text()).not.toContain(en.errors.reconciliation_failed);
    expect(h.host.text()).toContain("Registered 3 Gemini models and cleared default from Router.");
  });
});
