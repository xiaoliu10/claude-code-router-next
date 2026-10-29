import { afterEach, describe, expect, it, vi } from "vitest";
import { mount as mountCard, unmount as unmountCard } from "../src/card-entry";
import { createPluginCardAreaController, type PluginCardAreaBridge } from "../../../ui/src/utils/plugin-card";
import { codexLocales } from "../src/locales";
import { CODEX_PROVIDER_NAME } from "../src/card-types";

/**
 * End-to-end seam test: the REAL framework-free host controller (the same code
 * PluginCardArea runs in the browser, with fetch/Blob/import injected) drives
 * the REAL Codex card module, with deferred requests and a minimal DOM double.
 * Parity bar (same as the Gemini/WorkBuddy card seams): deferred mutations
 * outliving disposal, lease accounting across the seam (lease held through
 * unmount until reconciliation settles), in-place disabled transitions and
 * visible failure triage.
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
  value = "";
  disabled = false;
  style = { cssText: "" };
  attrs: Record<string, string> = {};
  onclick?: () => void;
  firstChild: El | null = null;
  constructor(tag: string) { this.tag = tag; }
  append(...nodes: El[]) { for (const n of nodes) { n.parent = this; this.children.push(n); } this.firstChild = this.children[0] ?? null; }
  appendChild(child: El): El { this.append(child); return child; }
  prepend(...nodes: El[]) { for (const n of nodes.reverse()) { n.parent = this; this.children.unshift(n); } this.firstChild = this.children[0] ?? null; }
  insertBefore(child: El, before: El | null) {
    const at = before ? this.children.indexOf(before) : -1;
    child.parent = this;
    if (at < 0) this.children.push(child); else this.children.splice(at, 0, child);
    this.firstChild = this.children[0] ?? null;
    return child;
  }
  querySelector(selector: string): El | null {
    const match = selector.match(/^\[data-testid="(.+)"\]$/);
    if (!match) return null;
    return this.all().find(n => n.dataset?.testid === match[1]) ?? null;
  }
  replaceChildren(...nodes: El[]) { this.children = [...nodes]; for (const n of nodes) n.parent = this; this.firstChild = nodes[0] ?? null; }
  setAttribute(name: string, value: string) { this.attrs[name] = value; }
  remove() {
    if (this.parent) {
      const at = this.parent.children.indexOf(this);
      if (at >= 0) this.parent.children.splice(at, 1);
      this.parent = null;
    }
    this.removed = true;
  }
  all(): El[] { return [this, ...this.children.flatMap(n => (typeof n.all === "function" ? n.all() : [n]))]; }
  button(text: string): El {
    const found = this.all().filter(n => n.tag === "button" && n.textContent === text).at(-1);
    expect(found, `missing button ${text}`).toBeTruthy();
    return found!;
  }
  click(text: string) { const b = this.button(text); if (!b.disabled) b.onclick?.(); }
  text(): string { return this.all().map(n => n.textContent).join("\n"); }
}

const tick = async () => { for (let i = 0; i < 50; ++i) await Promise.resolve(); };

const en = codexLocales.en.codex as any;

function deferred<T = any>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function seamHarness() {
  vi.stubGlobal("document", {
    createElement: (tag: string) => new El(tag),
    createElementNS: () => new El("svg") as any,
    createTextNode: (text: string) => ({ tag: "#text", textContent: text }) as any,
  });
  vi.stubGlobal("window", { open: vi.fn() });
  vi.stubGlobal("sessionStorage", {
    getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {},
  });
  const host = new El("div");
  const status = {
    status: "connected", providerName: CODEX_PROVIDER_NAME,
    accountId: "9f8e7d6c-1234-5678-90ab-cdef12345678", email: "user@example.test", plan: "pro",
    models: ["gpt-5.2"], modelCount: 1, lastError: null,
  };
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
      if (path === "/usage") return { plan: "pro", primary: { usedPercent: 10, windowSeconds: 3600, resetAt: Date.now() + 1_000_000 } } as T;
      if (path === "/sync") {
        return (defers.sync ? defers.sync.promise : Promise.resolve({ success: true, models: ["m1", "m2"], modelCount: 2 })) as T;
      }
      if (path === "/disconnect") {
        return (defers.disconnect ? defers.disconnect.promise : Promise.resolve({ success: true })) as T;
      }
      return { success: true } as T;
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
  name: "codex", version: "1.0.0", enabled: true,
  cardUrl: "/plugins/codex/card.js", locales: codexLocales,
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); (globalThis as any).sessionStorage?.clear?.(); });

describe("real host controller × real Codex card seam", () => {
  it("mounts the card through the bridge; disabled transitions update the DOM in place without remount or release", async () => {
    const seam = seamHarness();
    await seam.controller.sync([cardEntry()], "en", seam.host as any);
    await tick();
    expect(seam.fetches).toEqual(["/plugins/codex/card.js"]);
    expect(seam.host.children).toHaveLength(1);
    const cardEl = seam.host.children[0];
    expect(seam.calls).toEqual(["/status", "/usage"]); // mount status + one auto quota read
    expect(cardEl.button(en.sync).disabled).toBe(false);

    seam.disabled.value = true;
    seam.controller.notifyHostChange();
    expect(cardEl.button(en.sync).disabled).toBe(true);
    expect(cardEl.button(en.disconnect).disabled).toBe(true);
    expect(cardEl.text()).toContain(en.other_edit);
    expect(seam.calls).toEqual(["/status", "/usage"]); // no remount, no remount status read, nothing cancelled
    expect(seam.releases).toBe(0);
    expect(seam.imports).toBe(1);

    seam.disabled.value = false;
    seam.controller.notifyHostChange();
    expect(cardEl.button(en.sync).disabled).toBe(false);
    seam.controller.dispose();
    expect(seam.host.children).toHaveLength(0);
  });

  it("a deferred sync outlives dispose; the lease blocks saves until reconciliation finishes, then releases", async () => {
    const seam = seamHarness();
    await seam.controller.sync([cardEntry()], "en", seam.host as any);
    await tick();
    const cardEl = seam.host.children[0];
    seam.defers.sync = deferred();
    cardEl.click(en.sync);
    await tick();
    // The lease is held: a second acquire (an attempted save) gets null.
    expect(seam.acquireManagement()).toBeNull();

    // Settings navigation / locale change disposes the area mid-flight.
    seam.controller.dispose();
    expect(seam.host.children).toHaveLength(0);

    // An attempted full-config save must still be excluded by the lease…
    expect(seam.acquireManagement()).toBeNull();

    // …until the deferred mutation, its reconciliation and the status reread finish.
    seam.defers.sync.resolve({ success: true, models: ["m1"], modelCount: 1 });
    await tick();
    expect(seam.releases).toBe(1);
    expect(seam.refreshConfig).toHaveBeenCalledTimes(1);
    expect(seam.calls.filter(path => path === "/status")).toHaveLength(2);
    expect(typeof seam.acquireManagement()).toBe("function");
    expect(seam.revoked).toEqual(seam.blobs);
  });

  it("a deferred disconnect keeps the lease through dispose and reconciliation too", async () => {
    const seam = seamHarness();
    await seam.controller.sync([cardEntry()], "en", seam.host as any);
    await tick();
    const cardEl = seam.host.children[0];
    seam.defers.disconnect = deferred();
    cardEl.click(en.disconnect); // opens confirm dialog
    expect(seam.host.text()).toContain(en.disconnect_warning);
    seam.host.button(en.disconnect).onclick!(); // dialog confirm button (host level)
    await tick();
    expect(seam.calls).toContain("/disconnect");
    expect(seam.acquireManagement()).toBeNull();

    seam.controller.dispose();
    expect(seam.host.children).toHaveLength(0);
    expect(seam.acquireManagement()).toBeNull();

    seam.defers.disconnect.resolve({ success: true });
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
    ], "en", seam.host as any);
    expect(seam.host.children).toHaveLength(0);
    expect(seam.fetches).toEqual([]); // nothing fetched, least of all cross-origin
    expect(seam.controller.getIssues().map(i => [i.kind, i.plugin, i.reason ?? null])).toEqual([
      ["unavailable", "disabled-plugin", "disabled"],
      ["unavailable", "broken-plugin", "error"],
      ["card_failed", "remote-plugin", null],
    ]);
    await seam.controller.sync(null, "en", seam.host as any);
    expect(seam.controller.getIssues()).toEqual([{ kind: "manifest_failed", plugin: null }]);
  });

  it("the card module the controller imports is the real card-entry, and the bridge routes its API calls", async () => {
    const seam = seamHarness();
    await seam.controller.sync([cardEntry()], "en", seam.host as any);
    await tick();
    expect(seam.imports).toBe(1);
    // The card issued its initial status read plus the auto quota read, both
    // through the bridge with the plugin name attached.
    expect(seam.calls).toEqual(["/status", "/usage"]);
    expect(seam.blobs.length).toBe(1);
    // The deep-link focus key is the managed provider's name — consumed once.
    const seam2 = seamHarness();
    await seam2.controller.sync([cardEntry()], "en", seam2.host as any, CODEX_PROVIDER_NAME);
    await tick();
    expect(seam2.host.children).toHaveLength(1);
    seam2.controller.dispose();
    expect(seam2.revoked).toEqual(seam2.blobs);
  });
});
