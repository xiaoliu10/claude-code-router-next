/**
 * Rendered-behavior tests for the provider-plugin marketplace seam
 * (docs/design/provider-plugins.md §2.2): the framework-free controller +
 * renderer from utils/plugin-market.ts and the authenticated API-client lane
 * for /api/plugins/catalog + /api/plugins/install. Fully isolated env; no
 * network, no real config, no browser — fetch/document interactions are
 * stubbed.
 */
process.env.CCR_CONFIG_DIR = "/tmp/ccr-plugin-market-tests-home/market";
process.env.HOME = "/tmp/ccr-plugin-market-tests-home/market";
process.env.TMPDIR = "/tmp/ccr-plugin-market-tests-home/market/tmp";

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  createPluginMarketController, renderPluginMarketState, sanitizeMarketErrorCode,
  type PluginMarketBridge, type PluginMarketCatalogEntry,
} from "../src/utils/plugin-market.ts";

const ORIGIN = "http://127.0.0.1:3456";
(globalThis as any).location = { origin: ORIGIN };
const storage = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    removeItem: (key: string) => storage.delete(key),
    setItem: (key: string, value: string) => storage.set(key, value),
  },
  window: { location: { search: "" }, dispatchEvent: () => {} },
});

// ---------------------------------------------------------------------------
// Minimal DOM doubles (no framework): element tree with just what the
// renderer touches.
// ---------------------------------------------------------------------------
class El {
  tag: string;
  children: El[] = [];
  ownText = "";
  className = "";
  dataset: Record<string, string> = {};
  disabled = false;
  type = "";
  parent: El | null = null;
  removed = false;
  listeners = new Map<string, Array<() => void>>();
  constructor(tag: string) { this.tag = tag; }
  /** DOM semantics: textContent aggregates all descendants. */
  get textContent(): string {
    return this.ownText + this.children.map((c) => c.textContent).join("");
  }
  set textContent(value: string) {
    this.ownText = value;
    for (const c of this.children) { c.parent = null; c.removed = true; }
    this.children = [];
  }
  appendChild(child: El): El { child.parent = this; this.children.push(child); return child; }
  replaceChildren() { for (const c of this.children) { c.parent = null; c.removed = true; } this.children = []; }
  setAttribute(name: string, value: string) { this.dataset[name] = value; }
  addEventListener(kind: string, handler: () => void) {
    const list = this.listeners.get(kind) ?? [];
    list.push(handler);
    this.listeners.set(kind, list);
  }
  click() { for (const handler of this.listeners.get("click") ?? []) handler(); }
  querySelectorAll(selector: string): El[] {
    const out: El[] = [];
    const walk = (el: El) => {
      for (const child of el.children) {
        if (selector === "button" && child.tag === "button") out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  byTestId(name: string, root: El = this): El | null {
    if (root.dataset.testid === name) return root;
    for (const child of root.children) {
      const found = this.byTestId(name, child);
      if (found) return found;
    }
    return null;
  }
  allByTestId(name: string, root: El = this): El[] {
    const out: El[] = [];
    if (root.dataset.testid === name) out.push(root);
    for (const child of root.children) out.push(...this.allByTestId(name, child));
    return out;
  }
  remove() {
    if (this.parent) {
      const at = this.parent.children.indexOf(this);
      if (at >= 0) this.parent.children.splice(at, 1);
      this.parent = null;
    }
    this.removed = true;
  }
}

beforeEach(() => {
  (globalThis as any).document = { createElement: (tag: string) => new El(tag) };
});

const tickUntil = async (condition: () => boolean, maxLoops = 200) => {
  for (let i = 0; i < maxLoops; ++i) {
    if (condition()) return;
    await Promise.resolve();
  }
  throw new Error("condition not reached");
};

// ---------------------------------------------------------------------------
// Bridge fixture
// ---------------------------------------------------------------------------
interface LogCall { level: string; args: unknown[] }

function fixtureBridge(overrides: Partial<PluginMarketBridge> = {}) {
  const catalogEntry = (over: Partial<PluginMarketCatalogEntry> = {}): PluginMarketCatalogEntry => ({
    name: "ccr-provider-fixture", description: "A fixture plugin", version: "1.0.0",
    installed: false, installedVersion: null, ...over,
  });
  const catalog: PluginMarketCatalogEntry[] = [
    catalogEntry(),
    catalogEntry({ name: "ccr-provider-second", description: "Second", version: "2.0.0" }),
  ];
  const calls: LogCall[] = [];
  const log = {
    info: (...args: unknown[]) => calls.push({ level: "info", args }),
    warn: (...args: unknown[]) => calls.push({ level: "warn", args }),
    error: (...args: unknown[]) => calls.push({ level: "error", args }),
  };
  const bridge: PluginMarketBridge = {
    getCatalog: async () => ({ ok: true, plugins: catalog }),
    installPlugin: async (name: string) => {
      const entry = catalog.find((e) => e.name === name);
      if (entry) entry.installed = true;
      return { ok: true, name, version: "9.9.9", restartRequired: true };
    },
    log,
    ...overrides,
  };
  return { bridge, catalog, catalogEntry, calls };
}

const t = (key: string, params?: Record<string, unknown>) => {
  const table: Record<string, string> = {
    "pluginMarket.title": "Available plugins",
    "pluginMarket.subtitle": "npm provider plugins",
    "pluginMarket.loading": "Loading…",
    "pluginMarket.empty": "No installable provider plugins found.",
    "pluginMarket.empty_all_installed": "All installed ({{count}}).",
    "pluginMarket.registry_warning": "npm registry unavailable",
    "pluginMarket.install": "Install",
    "pluginMarket.installing": "Installing…",
    "pluginMarket.restart_notice": "{{name}} installed. Restart CCR to activate it.",
    "pluginMarket.restart_now": "Restart now",
    "pluginMarket.dismiss": "Dismiss",
    "pluginMarket.retry": "Retry",
    "pluginMarket.error_generic": "Installation failed ({{code}}).",
  };
  let out = table[key] ?? key;
  for (const [k, v] of Object.entries(params ?? {})) out = out.replace(`{{${k}}}`, String(v));
  return out;
};

// ---------------------------------------------------------------------------
// Renderer + controller
// ---------------------------------------------------------------------------

test("catalog renders installable entries with name, version, description and install buttons; installed entries are not listed", async () => {
  const fx = fixtureBridge();
  fx.catalog.push(fx.catalogEntry({ name: "ccr-provider-already", installed: true, installedVersion: "0.9.0" }));
  const controller = createPluginMarketController(fx.bridge);
  await controller.refresh();
  const host = new El("div");
  renderPluginMarketState(host, controller.getState(), t, {
    onInstall: () => {}, onRetry: () => {}, onRestart: () => {}, onDismissNotice: () => {},
  });

  const section = host.byTestId("plugin-market-section");
  assert.ok(section, "section rendered");
  const rows = host.allByTestId("plugin-market-entry");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.dataset.name), ["ccr-provider-fixture", "ccr-provider-second"]);
  const firstRow = rows[0];
  assert.ok(firstRow.textContent.includes("A fixture plugin"));
  assert.ok(firstRow.textContent.includes("v1.0.0"));
  assert.ok(firstRow.textContent.includes("ccr-provider-already") === false);
  const buttons = host.allByTestId("plugin-market-install");
  assert.equal(buttons.length, 2);
  for (const button of buttons) assert.equal(button.disabled, false);
  assert.ok(host.byTestId("plugin-market-restart-notice") === null);
});

test("loading and registry-unavailable states render their own safe surfaces", async () => {
  const fx = fixtureBridge();
  const controller = createPluginMarketController(fx.bridge);
  const host = new El("div");
  renderPluginMarketState(host, controller.getState(), t, {
    onInstall: () => {}, onRetry: () => {}, onRestart: () => {}, onDismissNotice: () => {},
  });
  assert.ok(host.byTestId("plugin-market-loading"), "loading surface before refresh");

  // Registry outage: empty list + warning + retry, never a thrown message.
  const failing = fixtureBridge({
    getCatalog: async () => { throw Object.assign(new Error("request failed"), { reason: "request_failed" }); },
  });
  const controller2 = createPluginMarketController(failing.bridge);
  await controller2.refresh();
  assert.equal(controller2.getState().status, "unavailable");
  const host2 = new El("div");
  renderPluginMarketState(host2, controller2.getState(), t, {
    onInstall: () => {}, onRetry: () => {}, onRestart: () => {}, onDismissNotice: () => {},
  });
  const warning = host2.byTestId("plugin-market-warning");
  assert.ok(warning, "warning surface");
  assert.equal(warning.textContent, "npm registry unavailable");
  assert.ok(host2.byTestId("plugin-market-list") === null);
});

test("install: buttons disabled while busy, success shows restart notice + refresh drops the entry, restart only on explicit click", async () => {
  let releaseInstall: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => { releaseInstall = resolve; });
  const fx = fixtureBridge({
    installPlugin: async (name: string) => {
      await gate;
      const entry = fx.catalog.find((e) => e.name === name);
      if (entry) entry.installed = true;
      return { ok: true, name, version: "9.9.9", restartRequired: true };
    },
  });
  const controller = createPluginMarketController(fx.bridge);
  await controller.refresh();

  let restartClicks = 0;
  const handlers = {
    onInstall: (name: string) => { void controller.install(name); },
    onRetry: () => {},
    onRestart: () => { restartClicks += 1; },
    onDismissNotice: () => controller.dismissNotice(),
  };
  const host = new El("div");
  const render = () => renderPluginMarketState(host, controller.getState(), t, handlers);
  render();

  const installButtons = () => host.allByTestId("plugin-market-install");
  // Click install on the first entry.
  const target = installButtons().find((b) => b.dataset.name === "ccr-provider-fixture")!;
  target.click();
  await tickUntil(() => controller.getState().busyName === "ccr-provider-fixture");
  render();

  // While in flight: that button shows "Installing…", ALL buttons disabled.
  const busyButton = installButtons().find((b) => b.dataset.name === "ccr-provider-fixture")!;
  assert.equal(busyButton.textContent, "Installing…");
  for (const button of installButtons()) assert.equal(button.disabled, true, "all install buttons disabled while busy");

  // No restart notice may appear before success.
  assert.ok(host.byTestId("plugin-market-restart-notice") === null);

  releaseInstall!();
  await tickUntil(() => controller.getState().justInstalled === "ccr-provider-fixture");
  await tickUntil(() => controller.getState().busyName === null);
  render();

  // Success: restart notice + the installed entry is gone from the list.
  const notice = host.byTestId("plugin-market-restart-notice");
  assert.ok(notice, "restart notice rendered");
  assert.ok(notice.textContent.includes("ccr-provider-fixture installed"));
  assert.ok(notice.textContent.includes("Restart CCR"));
  assert.deepEqual(
    host.allByTestId("plugin-market-entry").map((r) => r.dataset.name),
    ["ccr-provider-second"],
  );

  // Restart requires an explicit click on the notice button.
  assert.equal(restartClicks, 0);
  host.byTestId("plugin-market-restart")!.click();
  assert.equal(restartClicks, 1);

  // Dismiss clears the notice.
  host.byTestId("plugin-market-dismiss")!.click();
  await tickUntil(() => controller.getState().justInstalled === null);
  render();
  assert.ok(host.byTestId("plugin-market-restart-notice") === null);
});

test("install failure renders the SAFE code only — raw upstream text never reaches the DOM", async () => {
  const fx = fixtureBridge({
    installPlugin: async () => {
      throw Object.assign(new Error("npm pack failed"), {
        // A hostile/leaky reason must be collapsed to the generic code.
        reason: "ECONNREFUSED 127.0.0.1:8080 // registry URL https://private.registry/token",
      });
    },
  });
  const controller = createPluginMarketController(fx.bridge);
  await controller.refresh();
  const handlers = {
    onInstall: (name: string) => { void controller.install(name); },
    onRetry: () => {}, onRestart: () => {}, onDismissNotice: () => {},
  };
  const host = new El("div");
  const render = () => renderPluginMarketState(host, controller.getState(), t, handlers);
  render();
  installFirst();
  await tickUntil(() => controller.getState().error !== null);
  render();

  const errorLine = host.byTestId("plugin-market-error")!;
  assert.ok(errorLine, "error surface rendered");
  assert.equal(errorLine.textContent, "Installation failed (install_failed).");
  assert.equal(errorLine.textContent.includes("ECONNREFUSED"), false);
  assert.equal(errorLine.textContent.includes("private.registry"), false);
  assert.ok(!host.textContent.includes("npm pack failed"));

  // Known codes pass through unchanged.
  assert.equal(sanitizeMarketErrorCode("npm_pack_timeout"), "npm_pack_timeout");
  assert.equal(sanitizeMarketErrorCode("plugins_json_corrupted"), "plugins_json_corrupted");
  assert.equal(sanitizeMarketErrorCode(undefined), "install_failed");
  assert.equal(sanitizeMarketErrorCode(42), "install_failed");

  function installFirst() {
    const buttons = host.allByTestId("plugin-market-install");
    buttons[0].click();
  }
});

test("controller never logs secret-bearing material — names and stable codes only", async () => {
  const SECRET = "super-secret-token-do-not-print";
  const fx = fixtureBridge({
    getCatalog: async () => ({ ok: true, plugins: [] }),
    installPlugin: async () => {
      throw Object.assign(new Error(`npm error bearer ${SECRET}`), { reason: "npm_pack_failed" });
    },
  });
  const controller = createPluginMarketController(fx.bridge);
  await controller.refresh();
  try {
    await controller.install("ccr-provider-fixture");
  } catch { /* controller swallows; state carries the code */ }
  await tickUntil(() => controller.getState().error?.code === "npm_pack_failed");

  for (const call of fx.calls) {
    const line = JSON.stringify(call.args);
    assert.equal(line.includes(SECRET), false, `secret leaked via ${call.level}: ${line}`);
  }
});

test("empty catalog renders the empty surface (with an all-installed variant)", async () => {
  const fx = fixtureBridge({
    getCatalog: async () => ({
      ok: true,
      plugins: [
        fx.catalogEntry({ name: "ccr-provider-one", installed: true, installedVersion: "1.0.0" }),
        fx.catalogEntry({ name: "ccr-provider-two", installed: true, installedVersion: "2.0.0" }),
      ],
    }),
  });
  const controller = createPluginMarketController(fx.bridge);
  await controller.refresh();
  const host = new El("div");
  renderPluginMarketState(host, controller.getState(), t, {
    onInstall: () => {}, onRetry: () => {}, onRestart: () => {}, onDismissNotice: () => {},
  });
  assert.equal(controller.getState().hiddenInstalled, 2);
  const empty = host.byTestId("plugin-market-empty")!;
  assert.ok(empty, "empty surface");
  assert.ok(empty.textContent.includes("2"));
  assert.ok(host.byTestId("plugin-market-install") === null);
});

// ---------------------------------------------------------------------------
// API-client lane (source contract): authenticated catalog + install requests
// ---------------------------------------------------------------------------
test("api client: getPluginCatalog/installPlugin hit the marketplace routes with the admin key and parse the bodies", async () => {
  const { default: ApiClient } = await import("../src/lib/api.ts");
  const client = new ApiClient("/api", "mock-key");
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/plugins/catalog")) {
      return new Response(JSON.stringify({ ok: true, plugins: [{ name: "ccr-provider-x", description: "", version: "1.0.0", installed: false, installedVersion: null }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, name: "ccr-provider-x", version: "1.0.0", restartRequired: true }), { status: 200 });
  }) as typeof fetch;
  try {
    const catalog = await client.getPluginCatalog();
    assert.equal(catalog.plugins[0].name, "ccr-provider-x");
    const install = await client.installPlugin("ccr-provider-x");
    assert.deepEqual(install, { ok: true, name: "ccr-provider-x", version: "1.0.0", restartRequired: true });

    const catalogCall = calls.find((c) => c.url.endsWith("/plugins/catalog"))!;
    assert.equal(catalogCall.init?.method, "GET");
    assert.equal((catalogCall.init?.headers as any)["X-API-Key"], "mock-key");
    const installCall = calls.find((c) => c.url.endsWith("/plugins/install"))!;
    assert.equal(installCall.init?.method, "POST");
    assert.deepEqual(JSON.parse(String(installCall.init?.body)), { name: "ccr-provider-x", force: false });
    // The admin key never appears in any URL.
    for (const call of calls) assert.equal(call.url.includes("mock-key"), false);
  } finally {
    globalThis.fetch = original;
  }
});
