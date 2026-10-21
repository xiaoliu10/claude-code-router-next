import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, unmount } from "../src/card-entry";
import { workbuddyLocales } from "../src/locales";

/** Minimal DOM test double: exercise real mount/unmount/event handlers without
 * shipping or requiring a DOM framework in the production card chunk. */
class Element {
  children: Element[] = [];
  textContent = "";
  tag: string;
  type = "";
  disabled = false;
  href = "";
  target = "";
  rel = "";
  tabIndex = -1;
  style = { cssText: "" };
  dataset: Record<string, string> = {};
  onclick?: () => void;
  constructor(tag: string) { this.tag = tag; }
  append(...nodes: Element[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Element[]) { this.children = nodes; }
  setAttribute() {}
  all(): Element[] { return [this, ...this.children.flatMap(n => n.all())]; }
  button(text: string) {
    const result = this.all().filter(n => n.tag === "button" && n.textContent === text).at(-1);
    if (!result) throw new Error(`button missing: ${text}`);
    return result;
  }
  card(site: string) { return this.all().filter(n => n.dataset?.testid === `workbuddy-card-${site}`).at(-1)!; }
  click(text: string) { const b = this.button(text); if (!b.disabled) b.onclick?.(); }
  text(): string { return this.all().map(n => n.textContent).join("\n"); }
}
const tick = async () => { for (let i = 0; i < 15; ++i) await Promise.resolve(); };
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(f => f()); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const siteStatus = (extra: Record<string, any> = {}) => ({
  status: "connected", providerName: "workbuddy", activeUid: "u-1",
  accounts: [{ uid: "uid-123456789", displayName: "Nick", source: "browser", active: true, expiresAt: 0 }],
  models: ["glm-5.3"], hiddenModels: [], modelCount: 1, lastSyncAt: null, lastError: null,
  ...extra,
});
const status = { sites: { workbuddy: siteStatus(), "workbuddy-ai": siteStatus({ providerName: "workbuddy-ai", status: "not_connected", accounts: [], models: [] }) } };

function harness(overrides: Record<string, any> = {}, disabled = false, heldLease = false) {
  vi.stubGlobal("document", { createElement: (tag: string) => new Element(tag) });
  const host = new Element("div");
  const callApi = vi.fn(async (path: string, init?: any) => {
    if (overrides[path]) {
      const value = typeof overrides[path] === "function" ? await overrides[path](init) : overrides[path];
      if (value instanceof Error) throw value;
      return value;
    }
    if (path === "/status") return status;
    if (path === "/login/start") return { ok: true, site: "workbuddy", loginId: "a".repeat(48), url: "https://copilot.tencent.com/login", expiresAt: Date.now() + 60_000 };
    if (path === "/login/poll") return { status: "pending" };
    if (path === "/sync") return { success: true, status: "connected", models: ["glm-5.3", "kimi-k3-1"], modelCount: 2 };
    return { ok: true, success: true };
  });
  // Mirrors ApiClient.acquireProviderManagement: null while a managed action
  // or config write holds the shared lease; the release is a spy.
  let lock = false;
  const release = vi.fn(() => { lock = false; });
  const refreshConfig = vi.fn(async (_merge: (current: any, server: any) => any) => {});
  let hostListener: (() => void) | null = null;
  let unsubscribed = 0;
  const props = {
    callApi: callApi as any, locale: "en", locales: workbuddyLocales,
    disabled, plugin: { name: "workbuddy", version: "1" }, log: console,
    acquireManagement: () => (heldLease || lock ? null : (lock = true, release)), onBusy: vi.fn(), refreshConfig,
    onHostChange: (listener: () => void) => {
      hostListener = listener;
      return () => { if (hostListener === listener) hostListener = null; unsubscribed += 1; };
    },
  };
  mount(host as any, props);
  cleanups.push(() => unmount(host as any));
  return {
    host, callApi, release, onBusy: props.onBusy, refreshConfig,
    get lock() { return lock; },
    get unsubscribed() { return unsubscribed; },
    notify() { hostListener?.(); },
    statusReads() { return callApi.mock.calls.filter(([path]) => path === "/status").length; },
  };
}
const en = workbuddyLocales.en.workbuddy as any;
const CN = en.site.workbuddy as string;

describe("self-contained WorkBuddy plugin card", () => {
  it("mounts with a local status read only and renders both §16 site cards", async () => {
    const h = harness();
    await tick();
    expect(h.statusReads()).toBe(1);
    expect(h.callApi.mock.calls.every(([path]) => path !== "/sync" && !String(path).startsWith("/login"))).toBe(true);
    expect(h.host.card("workbuddy")).toBeTruthy();
    expect(h.host.card("workbuddy-ai")).toBeTruthy();
    expect(h.host.text()).toContain(CN);
    expect(h.host.card("workbuddy").text()).toContain(en.status.connected);
    // Account row: masked uid (first 3 + … + last 2), source badge, per-account actions.
    expect(h.host.card("workbuddy").text()).toContain("uid\u202689");
    expect(h.host.button(en["credits"].action)).toBeTruthy();
    expect(h.host.text()).toContain(en.source_badge.browser);
  });

  it("a failed status read renders a visible recovery note instead of an empty area", async () => {
    const h = harness({ "/status": new Error("down") });
    await tick();
    expect(h.host.text()).toContain(en.errors.request_failed);
    expect(h.host.text()).toContain(en.status.error);
  });

  it("sync runs through the lease, settles with a toast and re-reads status", async () => {
    const h = harness();
    await tick();
    h.host.card("workbuddy").click(en.sync);
    await tick();
    expect(h.callApi.mock.calls.some(([path, init]) => path === "/sync" && JSON.parse(init.body).site === "workbuddy")).toBe(true);
    expect(h.refreshConfig).toHaveBeenCalled();
    expect(h.statusReads()).toBeGreaterThanOrEqual(2);
    expect(h.host.text()).toContain(en.synced.replace("{{count}}", "2"));
    expect(h.release).toHaveBeenCalled();
  });

  it("model chips hide through the explicit endpoint and settle via the Router reconciliation merge", async () => {
    const h = harness({ "/models/hide": { ok: true, clearedRefs: ["default"], removedModelRefs: ["workbuddy,glm-5.3"], defaultFallback: "" } });
    await tick();
    const hide = h.host.card("workbuddy").all().find(n => n.tag === "button" && n.textContent === "×");
    hide!.onclick!();
    await tick();
    expect(h.callApi.mock.calls.some(([path, init]) => path === "/models/hide" && JSON.parse(init.body).model === "glm-5.3")).toBe(true);
    // The hide merge (not the default provider merge) reached the host.
    const merge = h.refreshConfig.mock.calls.at(-1)![0];
    const merged = merge({ Providers: [], Router: { default: "workbuddy,glm-5.3" } }, { Providers: [], Router: { default: "" } });
    expect(merged.Router.default).toBe("");
    expect(h.host.text()).toContain(en.cleared_refs.replace("{{refs}}", "Default route"));
  });

  it("switch and remove send exact per-site uid bodies and reconcile after successful routes", async () => {
    const uid = "backup-123456789";
    const h = harness({ "/status": { sites: { workbuddy: siteStatus({ accounts: [
      { uid, source: "desktop", active: false, displayName: "Backup" },
    ] }) } } });
    await tick();
    h.host.card("workbuddy").click(en.set_active); await tick();
    expect(h.callApi.mock.calls.some(([path, init]) => path === "/account/switch" && init.method === "POST" && init.body === JSON.stringify({ site: "workbuddy", uid }))).toBe(true);
    expect(h.refreshConfig).toHaveBeenCalled();
    h.host.card("workbuddy").click(en.remove);
    expect(h.host.text()).toContain(en.account_remove_warning);
    h.host.click(en.account_remove_confirm); await tick();
    expect(h.callApi.mock.calls.some(([path, init]) => path === "/account/remove" && init.body === JSON.stringify({ site: "workbuddy", uid }))).toBe(true);
  });
  it("hidden models restore singly or all with exact site bodies, never Router adoption", async () => {
    const h = harness({ "/status": { sites: { workbuddy: siteStatus({ hiddenModels: ["hidden"] }) } } });
    await tick();
    h.host.card("workbuddy").click(en.restore); await tick();
    h.host.card("workbuddy").click(en.restore_all); await tick();
    expect(h.callApi.mock.calls.filter(([path]) => path === "/models/restore").map(([, init]) => JSON.parse(init.body)))
      .toEqual([{ site: "workbuddy", model: "hidden" }, { site: "workbuddy" }]);
    const merge = h.refreshConfig.mock.calls.at(-1)![0];
    const router = { default: "local,draft" };
    expect(merge({ Providers: [], Router: router }, { Providers: [], Router: { default: "server,different" } }).Router).toBe(router);
  });
  it("credits are an explicit per-account read whose failure hides the line", async () => {
    const h = harness({ "/usage": { usage: { plan: "Pro", used: 1, limit: 10, unit: "credits" } } });
    await tick();
    h.host.card("workbuddy").click(en["credits"].action);
    await tick();
    expect(h.host.text()).toContain(en["credits"].line.replace("{{plan}}", "Pro").replace("{{used}}", "1").replace("{{limit}}", "10"));
    const failing = harness({ "/usage": new Error("quota") });
    await tick();
    failing.host.card("workbuddy").click(en["credits"].action);
    await tick();
    expect(failing.host.text()).not.toContain("quota");
  });

  it("browser authorization runs the sequential login helper and shows the pending link; cancel invalidates the job", async () => {
    const h = harness({
      "/login/poll": () => ({ status: "pending" }),
    });
    await tick();
    // CN is connected → the primary button is "add account"; it still starts a login.
    h.host.card("workbuddy").button(en.add_account).onclick!();
    await tick();
    expect(h.host.text()).toContain(en.login_pending);
    const link = h.host.card("workbuddy").all().find(n => n.tag === "a")!;
    expect(link.href).toContain("https://");
    expect(link.rel).toContain("noopener");
    h.host.card("workbuddy").click(en["app.cancel"] ?? "Cancel");
    await tick();
    expect(h.callApi.mock.calls.some(([path]) => path === "/login/cancel")).toBe(true);
  });

  it("local host poll timeouts retry within the authorization deadline, never expose raw text", async () => {
    vi.useFakeTimers();
    try {
      let polls = 0;
      const h = harness({ "/login/poll": () => {
        if (++polls === 1) throw Object.assign(new Error("private-marker"), { timedOut: true });
        return { status: "connected", success: true, models: ["m"], accountCount: 2, accountChange: "added" };
      } });
      await tick();
      h.host.card("workbuddy").button(en.add_account).onclick!();
      await tick();
      expect(polls).toBe(1); expect(h.host.text()).not.toContain("private-marker");
      await vi.advanceTimersByTimeAsync(1200); await tick();
      expect(polls).toBe(2);
      expect(h.host.text()).toContain(en.account_added.replace("{{count}}", "2"));
    } finally { vi.useRealTimers(); }
  });
  it("a connected login settles with the committed-upsert outcome message", async () => {
    const h = harness({
      "/login/start": { ok: true, site: "workbuddy-ai", loginId: "b".repeat(48), url: "https://www.workbuddy.ai/login", expiresAt: Date.now() + 60_000 },
      "/login/poll": { status: "connected", success: true, models: ["gpt-5.5"], accountChange: "added", accountCount: 2 },
    });
    await tick();
    // The AI site is offline → its primary button reads browser_login.
    h.host.card("workbuddy-ai").button(en.browser_login).onclick!();
    await tick();
    await tick();
    expect(h.host.text()).toContain(en.account_added.replace("{{count}}", "2"));
  });

  it("disconnect needs the explicit confirmation dialog; the remove flow names the account", async () => {
    const h = harness();
    await tick();
    h.host.card("workbuddy").click(en.disconnect);
    expect(h.host.text()).toContain(en.disconnect_warning);
    // Cancel keeps everything.
    h.host.click(en["app.cancel"] ?? "Cancel");
    h.host.card("workbuddy").click(en.disconnect);
    h.host.button(en.disconnect).onclick!();
    await tick();
    expect(h.callApi.mock.calls.some(([path, init]) => path === "/disconnect" && JSON.parse(init.body).site === "workbuddy")).toBe(true);
    expect(h.host.text()).toContain(en.disconnected);
  });

  it("host disable re-renders in place with the other-edit note; busy gate blocks actions", async () => {
    const h = harness({}, false);
    await tick();
    h.notify();
    expect(h.statusReads()).toBe(1); // in-place render, no remount
    const gated = harness({}, true);
    await tick();
    expect(gated.host.text()).toContain(en.other_edit);
    expect(gated.host.button(en.sync).disabled).toBe(true);
  });

  it("a busy lease shows the busy recovery note instead of starting a second action", async () => {
    // heldLease: acquireManagement returns null while a save is in flight —
    // the card must refuse the action visibly and POST nothing.
    const h = harness({}, false, true);
    await tick();
    const before = h.callApi.mock.calls.filter(([path]) => path === "/sync").length;
    h.host.card("workbuddy").click(en.sync);
    await tick();
    expect(h.host.text()).toContain(en.errors.busy);
    expect(h.callApi.mock.calls.filter(([path]) => path === "/sync").length).toBe(before);
  });

  it("unmount cancels a pending login session and unsubscribes from host changes", async () => {
    const h = harness({ "/login/poll": () => ({ status: "pending" }) });
    await tick();
    h.host.card("workbuddy").button(en.add_account).onclick!();
    await tick();
    expect(h.host.card("workbuddy").text()).toContain(en.login_pending);
    unmount(h.host as any);
    expect(h.callApi.mock.calls.some(([path]) => path === "/login/cancel")).toBe(true);
    expect(h.unsubscribed).toBe(1);
  });
});
