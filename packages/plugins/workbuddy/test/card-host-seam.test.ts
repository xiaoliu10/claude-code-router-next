import { afterEach, describe, expect, it, vi } from "vitest";
import { mount as mountCard, unmount as unmountCard } from "../src/card-entry";
import { createPluginCardAreaController, type PluginCardAreaBridge } from "../../../ui/src/utils/plugin-card";
import { workbuddyLocales } from "../src/locales";

/**
 * End-to-end seam test: the REAL framework-free host controller (the same code
 * PluginCardArea runs in the browser, with fetch/Blob/import injected) drives
 * the REAL built card module, with deferred requests and a minimal DOM double.
 * Parity bar (same as the Gemini card seam): deferred mutations outliving
 * disposal, lease accounting across the seam (lease held through unmount until
 * reconciliation settles), in-place disabled transitions and visible failure
 * triage.
 */

class El {
  tag: string;
  children: El[] = [];
  textContent = "";
  className = "";
  dataset: Record<string, string> = {};
  parent: El | null = null;
  removed = false;
  type = "";
  style = { cssText: "" };
  onclick?: () => void;
  constructor(tag: string) { this.tag = tag; }
  append(...nodes: El[]) { for (const n of nodes) { n.parent = this; this.children.push(n); } }
  appendChild(child: El): El { child.parent = this; this.children.push(child); return child; }
  replaceChildren(...nodes: El[]) { this.children = [...nodes]; for (const n of nodes) n.parent = this; }
  setAttribute() {}
  remove() {
    if (this.parent) {
      const at = this.parent.children.indexOf(this);
      if (at >= 0) this.parent.children.splice(at, 1);
      this.parent = null;
    }
    this.removed = true;
  }
  all(): El[] { return [this, ...this.children.flatMap(n => n.all())]; }
  button(text: string): El {
    const found = this.all().filter(n => n.tag === "button" && n.textContent === text).at(-1);
    expect(found, `missing button ${text}`).toBeTruthy();
    return found!;
  }
  /** Scope to one §16 site card: both cards render per-site buttons and only
   *  the connected site's are enabled. */
  card(site: string): El {
    const found = this.all().filter(n => n.dataset?.testid === `workbuddy-card-${site}`).at(-1);
    expect(found, `missing card ${site}`).toBeTruthy();
    return found!;
  }
  click(text: string) { const b = this.button(text); if (!b.disabled) b.onclick?.(); }
  text(): string { return this.all().map(n => n.textContent).join("\n"); }
}

const tick = async () => { for (let i = 0; i < 50; ++i) await Promise.resolve(); };

const en = workbuddyLocales.en.workbuddy as any;

function deferred<T = any>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function seamHarness() {
  vi.stubGlobal("document", { createElement: (tag: string) => new El(tag) });
  const host = new El("div");
  const site = {
    status: "connected", providerName: "workbuddy", activeUid: "uid-123456789",
    accounts: [{ uid: "uid-123456789", displayName: "Nick", source: "browser", active: true, expiresAt: 0 }],
    models: ["glm-5.3"], hiddenModels: [], modelCount: 1, lastSyncAt: null, lastError: null,
  };
  const status = { sites: { workbuddy: site, "workbuddy-ai": { ...site, providerName: "workbuddy-ai", status: "not_connected", accounts: [], models: [] } } };
  const calls: string[] = [];
  let lock = false;
  let releaseCount = 0;
  const release = () => { lock = false; releaseCount += 1; };
  const disabled = { value: false };
  const refreshConfig = vi.fn(async (_merge: (current: any, server: any) => any) => {});
  const blobs: string[] = [];
  const revoked: string[] = [];
  const fetches: string[] = [];
  let imports = 0;
  let blobSeq = 0;
  const cardModule = { mount: mountCard, unmount: unmountCard };
  const defers = {
    sync: null as ReturnType<typeof deferred> | null,
    disconnect: null as ReturnType<typeof deferred> | null,
  };
  const bridge: PluginCardAreaBridge = {
    origin: "http://127.0.0.1:3456",
    getDisabled: () => disabled.value,
    callPluginApi: async <T,>(_plugin: string, path: string): Promise<T> => {
      calls.push(path);
      if (path === "/status") return status as T;
      if (path === "/sync") {
        return (defers.sync ? defers.sync.promise : Promise.resolve({ success: true, status: "connected", models: ["m1", "m2"], modelCount: 2 })) as T;
      }
      if (path === "/disconnect") {
        return (defers.disconnect ? defers.disconnect.promise : Promise.resolve({ ok: true, success: true })) as T;
      }
      return { ok: true, success: true } as T;
    },
    acquireManagement: () => (lock ? null : (lock = true, release)),
    refreshConfig: (merge) => refreshConfig(merge),
    onBusyChange: () => {},
    log: { info() {}, warn() {}, error() {} },
    fetchCardSource: async (cardUrl: string) => {
      fetches.push(cardUrl);
      return JSON.stringify({ staged: cardUrl });
    },
    importModule: async () => { imports += 1; return cardModule; },
    makeBlobUrl: (source: string) => { const url = `blob:seam-${++blobSeq}:${source}`; blobs.push(url); return url; },
    revokeBlobUrl: (url: string) => revoked.push(url),
  };
  const controller = createPluginCardAreaController(bridge);
  return {
    host, controller, calls, refreshConfig, disabled, fetches, blobs, revoked, defers,
    acquireManagement: () => (lock ? null : (lock = true, release)),
    get releases() { return releaseCount; },
    get imports() { return imports; },
  };
}

const cardEntry = () => ({
  name: "workbuddy", version: "1.0.0", enabled: true,
  cardUrl: "/plugins/workbuddy/card.js", locales: workbuddyLocales,
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("real host controller × real WorkBuddy card seam", () => {
  it("mounts the card through the bridge; disabled transitions update the DOM in place without remount or release", async () => {
    const seam = seamHarness();
    await seam.controller.sync([cardEntry()], "en", seam.host);
    await tick();
    expect(seam.fetches).toEqual(["/plugins/workbuddy/card.js"]);
    expect(seam.host.children).toHaveLength(1);
    const cardEl = seam.host.children[0];
    expect(seam.calls).toEqual(["/status"]);
    expect(cardEl.card("workbuddy").button(en.sync).disabled).toBe(false);

    seam.disabled.value = true;
    seam.controller.notifyHostChange();
    expect(cardEl.card("workbuddy").button(en.sync).disabled).toBe(true);
    expect(cardEl.card("workbuddy").button(en.disconnect).disabled).toBe(true);
    expect(cardEl.text()).toContain(en.other_edit);
    expect(seam.calls).toEqual(["/status"]); // no remount status read, nothing cancelled
    expect(seam.releases).toBe(0);
    expect(seam.imports).toBe(1);

    seam.disabled.value = false;
    seam.controller.notifyHostChange();
    expect(cardEl.card("workbuddy").button(en.sync).disabled).toBe(false);
    seam.controller.dispose();
    expect(seam.host.children).toHaveLength(0);
  });

  it("a deferred sync outlives dispose; the lease blocks saves until reconciliation finishes, then releases", async () => {
    const seam = seamHarness();
    await seam.controller.sync([cardEntry()], "en", seam.host);
    await tick();
    const cardEl = seam.host.children[0];
    seam.defers.sync = deferred();
    cardEl.card("workbuddy").click(en.sync);
    await tick();
    // The lease is held: a second acquire (an attempted save) gets null.
    expect(seam.acquireManagement()).toBeNull();

    // Settings navigation / locale change disposes the area mid-flight.
    seam.controller.dispose();
    expect(seam.host.children).toHaveLength(0);

    // An attempted full-config save must still be excluded by the lease…
    expect(seam.acquireManagement()).toBeNull();

    // …until the deferred mutation, its reconciliation and the status reread finish.
    seam.defers.sync.resolve({ success: true, status: "connected", models: ["m1"], modelCount: 1 });
    await tick();
    expect(seam.releases).toBe(1);
    expect(seam.refreshConfig).toHaveBeenCalledTimes(1);
    expect(seam.calls.filter(path => path === "/status")).toHaveLength(2);
    expect(typeof seam.acquireManagement()).toBe("function");
    expect(seam.revoked).toEqual(seam.blobs);
  });

  it("a deferred disconnect keeps the lease through dispose and reconciliation too", async () => {
    const seam = seamHarness();
    await seam.controller.sync([cardEntry()], "en", seam.host);
    await tick();
    const cardEl = seam.host.children[0];
    seam.defers.disconnect = deferred();
    cardEl.card("workbuddy").click(en.disconnect); // opens confirm dialog
    expect(seam.host.text()).toContain(en.disconnect_warning);
    seam.host.button(en.disconnect).onclick!(); // confirm dialog's button (host level)
    await tick();
    expect(seam.calls).toContain("/disconnect");
    // The lease is held: a second acquire (an attempted save) gets null.
    expect(seam.acquireManagement()).toBeNull();

    seam.controller.dispose();
    expect(seam.host.children).toHaveLength(0);
    expect(seam.acquireManagement()).toBeNull();

    seam.defers.disconnect.resolve({ ok: true, success: true });
    await tick();
    expect(seam.releases).toBe(1);
    expect(seam.refreshConfig).toHaveBeenCalledTimes(1);
    expect(seam.calls.filter(path => path === "/status")).toHaveLength(2);
    expect(typeof seam.acquireManagement()).toBe("function");
  });

  it("unavailable, broken and cross-origin entries render visible issues and are never fetched", async () => {
    const seam = seamHarness();
    await seam.controller.sync([
      { name: "disabled-plugin", version: null, enabled: false },
      { name: "broken-plugin", version: null, enabled: true, error: "plugin missing or failed to load — its providers are unavailable until it is reinstalled" },
      { name: "remote-plugin", version: "1.0.0", enabled: true, cardUrl: "https://evil.example/card.js" },
    ], "en", seam.host);
    expect(seam.host.children).toHaveLength(0);
    expect(seam.fetches).toEqual([]); // nothing fetched, least of all cross-origin
    expect(seam.controller.getIssues().map(i => [i.kind, i.plugin, i.reason ?? null])).toEqual([
      ["unavailable", "disabled-plugin", "disabled"],
      ["unavailable", "broken-plugin", "error"],
      ["card_failed", "remote-plugin", null],
    ]);
    await seam.controller.sync(null, "en", seam.host);
    expect(seam.controller.getIssues()).toEqual([{ kind: "manifest_failed", plugin: null }]);
  });

  it("the card module the controller imports is the real card-entry, and the bridge routes its API calls", async () => {
    const seam = seamHarness();
    await seam.controller.sync([cardEntry()], "en", seam.host);
    await tick();
    expect(seam.imports).toBe(1);
    // The card issued its initial status read through the bridge with the
    // plugin name attached (see callPluginApi in seamHarness).
    expect(seam.calls).toEqual(["/status"]);
    expect(seam.blobs.length).toBe(1);
    seam.controller.dispose();
    expect(seam.revoked).toEqual(seam.blobs);
  });
});
