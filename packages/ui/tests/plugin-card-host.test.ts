// Rendered-behavior tests for the provider-plugin card host seam: the
// framework-free controller from utils/plugin-card.ts and the authenticated
// card-source lane from lib/api.ts. Fully isolated env; no network, no real
// config, no browser — fetch/document/Blob interactions are stubbed.
process.env.CCR_CONFIG_DIR = "/tmp/ccr-plugin-card-tests-home/card-host";
process.env.HOME = "/tmp/ccr-plugin-card-tests-home/card-host";
process.env.TMPDIR = "/tmp/ccr-plugin-card-tests-home/card-host/tmp";

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  createPluginCardAreaController, isSameOriginCardUrl, pluginLocaleOf,
  type PluginCardAreaBridge, type PluginCardModule,
} from "../src/utils/plugin-card.ts";

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

const { default: ApiClient } = await import("../src/lib/api.ts");

// ---------------------------------------------------------------------------
// Minimal DOM doubles (no framework): container + card host elements.
// ---------------------------------------------------------------------------
class El {
  tag: string;
  children: El[] = [];
  textContent = "";
  className = "";
  dataset: Record<string, string> = {};
  parent: El | null = null;
  removed = false;
  constructor(tag: string) { this.tag = tag; }
  appendChild(child: El): El { child.parent = this; this.children.push(child); return child; }
  remove() {
    if (this.parent) {
      const at = this.parent.children.indexOf(this);
      if (at >= 0) this.parent.children.splice(at, 1);
      this.parent = null;
    }
    this.removed = true;
  }
}

// ---------------------------------------------------------------------------
// Controller fixtures
// ---------------------------------------------------------------------------
interface FakeCard {
  mod: PluginCardModule;
  mounts: Array<{ el: El; props: any }>;
  unmounts: number;
  mountError?: unknown;
  deferMount?: Promise<void> | null;
  resolveMount?: () => void;
}

function fakeCard(options: Pick<FakeCard, "mountError" | "deferMount"> = {}): FakeCard {
  const card: FakeCard = {
    mod: {
      mount(el, props) {
        card.mounts.push({ el, props });
        if (card.deferMount) return card.deferMount;
        if (card.mountError) throw card.mountError;
        el.appendChild(new El("section"));
        return;
      },
      unmount() { card.unmounts += 1; },
    },
    mounts: [],
    unmounts: 0,
    ...options,
  };
  return card;
}

function bridgeFixture(overrides: Partial<PluginCardAreaBridge> = {}) {
  const busyEvents: boolean[] = [];
  const errors: unknown[][] = [];
  let disabled = false;
  let busy = false;
  const blobs: string[] = [];
  const revoked: string[] = [];
  const fetches: string[] = [];
  const sources = new Map<string, string>();
  const modules = new Map<string, unknown>();
  let blobSeq = 0;
  const bridge: PluginCardAreaBridge = {
    origin: ORIGIN,
    getDisabled: () => disabled,
    callPluginApi: async <T,>(plugin: string, path: string): Promise<T> => ({ plugin, path }) as T,
    acquireManagement: () => () => {},
    refreshConfig: async () => {},
    onBusyChange: (value) => { busy = value; busyEvents.push(value); },
    log: { info() {}, warn() {}, error(...args: unknown[]) { errors.push(args); } },
    fetchCardSource: async (cardUrl: string) => {
      fetches.push(cardUrl);
      const source = sources.get(cardUrl);
      if (source === undefined) throw new Error(`no source for ${cardUrl}`);
      return source;
    },
    importModule: async (url: string) => {
      const mod = modules.get(url);
      if (!mod) throw new Error(`no module for ${url}`);
      return mod;
    },
    makeBlobUrl: (source: string) => {
      const url = `blob:${ORIGIN}/fixture-${++blobSeq}`;
      blobs.push(url);
      modules.set(url, JSON.parse(source) as unknown);
      return url;
    },
    revokeBlobUrl: (url: string) => revoked.push(url),
    ...overrides,
  };
  return {
    bridge, blobs, revoked, fetches, busyEvents, errors, sources, modules,
    setDisabled: (value: boolean) => { disabled = value; },
    get busy() { return busy; },
  };
}

// A bridge whose Blob URLs are deterministic so tests can stage modules.
function deterministicBridge(overrides: Partial<PluginCardAreaBridge> = {}) {
  const fixture = bridgeFixture({
    makeBlobUrl: (source: string) => {
      const parsed = JSON.parse(source) as { staged?: string };
      const url = `blob:${ORIGIN}${parsed.staged ?? `/anon-${fixture.blobs.length + 1}`}`;
      fixture.blobs.push(url);
      // Tests pre-stage real modules under the deterministic Blob URL; only
      // unstaged URLs get the parsed source as a (deliberately mount-less) module.
      if (!fixture.modules.has(url)) fixture.modules.set(url, parsed);
      return url;
    },
    ...overrides,
  });
  return fixture;
}

const entry = (over: Partial<{ name: string; enabled: boolean; error?: string; cardUrl?: string }> = {}) => ({
  name: "gemini-oauth", version: "1.0.0", enabled: true,
  cardUrl: "/plugins/gemini-oauth/card.js", locales: {},
  ...over,
});

const tickUntil = async (condition: () => boolean, maxLoops = 200) => {
  for (let i = 0; i < maxLoops; ++i) {
    if (condition()) return;
    await Promise.resolve();
  }
  throw new Error("condition not reached");
};

beforeEach(() => {
  (globalThis as any).document = { createElement: (tag: string) => new El(tag) };
});

test("controller mounts usable cards through the bridge and renders disabled/error/unusable entries as issues", async () => {
  const fx = deterministicBridge();
  const ok = fakeCard();
  fx.sources.set("/plugins/gemini-oauth/card.js", JSON.stringify({ staged: "/plugins/gemini-oauth/card.js" }));
  const cardUrl = "/plugins/gemini-oauth/card.js";
  fx.modules.set(`blob:${ORIGIN}${cardUrl}`, ok.mod);
  const controller = createPluginCardAreaController(fx.bridge);
  await controller.sync([
    entry(),
    entry({ name: "disabled-plugin", enabled: false, cardUrl: undefined }),
    entry({ name: "broken-plugin", error: "plugin missing or failed to load" }),
    entry({ name: "remote-plugin", cardUrl: "https://evil.example/card.js" }),
  ], "en", new El("div"));

  // Only the usable entry is mounted, with the full host bridge behind it.
  assert.deepEqual(fx.fetches, ["/plugins/gemini-oauth/card.js"]);
  assert.equal(ok.mounts.length, 1);
  const props = ok.mounts[0].props;
  assert.equal(props.plugin.name, "gemini-oauth");
  assert.equal(props.locale, "en");
  assert.deepEqual(await props.callApi("/status"), { plugin: "gemini-oauth", path: "/status" });
  fx.setDisabled(true);
  assert.equal(props.disabled, true);
  fx.setDisabled(false);

  // Host-change fan-out: listener registered once, unsubscribe works.
  let notified = 0;
  const unsubscribe = props.onHostChange?.(() => { notified += 1; });
  controller.notifyHostChange();
  assert.equal(notified, 1);
  unsubscribe?.();
  controller.notifyHostChange();
  assert.equal(notified, 1);

  // Installed-but-unavailable and unusable entries are visible issues.
  assert.deepEqual(controller.getIssues().map((i) => [i.kind, i.plugin, i.reason ?? null, i.detail ?? null]), [
    ["unavailable", "disabled-plugin", "disabled", null],
    ["unavailable", "broken-plugin", "error", "plugin missing or failed to load"],
    ["card_failed", "remote-plugin", null, null],
  ]);
});

test("controller reports manifest failure instead of rendering nothing", async () => {
  const fx = deterministicBridge();
  const controller = createPluginCardAreaController(fx.bridge);
  await controller.sync(null, "en", new El("div"));
  assert.deepEqual(controller.getIssues(), [{ kind: "manifest_failed", plugin: null }]);
});

test("controller: a card module that fails to import becomes a visible card_failed issue, Blob revoked, other card still mounted", async () => {
  const fx = deterministicBridge();
  const good = fakeCard();
  const bad = fakeCard();
  for (const [name, card] of [["good-plugin", good], ["bad-plugin", bad]] as const) {
    const cardUrl = `/plugins/${name}/card.js`;
    fx.sources.set(cardUrl, JSON.stringify({ staged: cardUrl }));
  }
  fx.modules.set(`blob:${ORIGIN}/plugins/good-plugin/card.js`, good.mod);
  // bad-plugin's module is intentionally missing → importModule throws.
  const controller = createPluginCardAreaController(fx.bridge);
  await controller.sync([
    entry({ name: "good-plugin", cardUrl: "/plugins/good-plugin/card.js" }),
    entry({ name: "bad-plugin", cardUrl: "/plugins/bad-plugin/card.js" }),
  ], "en", new El("div"));
  assert.deepEqual(controller.getIssues(), [{ kind: "card_failed", plugin: "bad-plugin" }]);
  assert.equal(good.mounts.length, 1);
  assert.equal(fx.revoked.some((url) => url.endsWith("/plugins/bad-plugin/card.js")), true);
  assert.equal(fx.errors.length >= 1, true); // console diagnostics still logged
});

test("controller: a card whose mount() throws is cleaned up and surfaced as an issue", async () => {
  const fx = deterministicBridge();
  const boom = fakeCard({ mountError: new Error("fixture mount failure") });
  const cardUrl = "/plugins/boom/card.js";
  fx.sources.set(cardUrl, JSON.stringify({ staged: cardUrl }));
  fx.modules.set(`blob:${ORIGIN}${cardUrl}`, boom.mod);
  const controller = createPluginCardAreaController(fx.bridge);
  const host = new El("div");
  await controller.sync([entry({ name: "boom", cardUrl })], "en", host);
  assert.deepEqual(controller.getIssues(), [{ kind: "card_failed", plugin: "boom" }]);
  assert.equal(host.children.length, 0);
  assert.equal(boom.mounts[0].el.removed, true);
  assert.equal(fx.revoked.length, 1);
});

test("controller: dispose mid-mount never registers the late card and revokes its Blob", async () => {
  const fx = deterministicBridge();
  const slow = fakeCard();
  let releaseImport: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => { releaseImport = resolve; });
  const cardUrl = "/plugins/slow/card.js";
  fx.sources.set(cardUrl, JSON.stringify({ staged: cardUrl }));
  fx.modules.set(`blob:${ORIGIN}${cardUrl}`, slow.mod);
  const controller = createPluginCardAreaController({
    ...fx.bridge,
    importModule: (url: string) => gate.then(() => {
      const mod = fx.modules.get(url);
      if (!mod) throw new Error(`no module for ${url}`);
      return mod;
    }),
  });
  const host = new El("div");
  const syncing = controller.sync([entry({ cardUrl })], "en", host);
  // Fetch resolves, Blob created, import gated → dispose (navigation/locale change).
  await tickUntil(() => fx.blobs.length === 1);
  controller.dispose();
  releaseImport!();
  await syncing;
  assert.equal(slow.mounts.length, 0);
  assert.deepEqual(fx.revoked, fx.blobs);
  assert.equal(host.children.length, 0);
});

test("controller: dispose unmounts cards, revokes Blob URLs, resets busy and clears subscriptions", async () => {
  const fx = deterministicBridge();
  const card = fakeCard();
  const cardUrl = "/plugins/gemini-oauth/card.js";
  fx.sources.set(cardUrl, JSON.stringify({ staged: cardUrl }));
  fx.modules.set(`blob:${ORIGIN}${cardUrl}`, card.mod);
  const controller = createPluginCardAreaController(fx.bridge);
  const host = new El("div");
  await controller.sync([entry()], "en", host);
  let notified = 0;
  card.mounts[0].props.onHostChange?.(() => { notified += 1; });
  card.mounts[0].props.onBusy?.(true);
  assert.equal(fx.busy, true);
  controller.dispose();
  assert.equal(card.unmounts, 1);
  assert.equal(fx.revoked.length, 1);
  assert.deepEqual(fx.busyEvents, [true, false]);
  assert.equal(fx.busy, false);
  assert.equal(host.children.length, 0);
  // A disposed generation must not see further host notifications.
  controller.notifyHostChange();
  assert.equal(notified, 0);
});

test("controller: a card-held management lease survives dispose (host never force-releases)", async () => {
  const fx = deterministicBridge();
  let released = 0;
  let leaseBusy = false;
  const card = fakeCard();
  const cardUrl = "/plugins/gemini-oauth/card.js";
  fx.sources.set(cardUrl, JSON.stringify({ staged: cardUrl }));
  fx.modules.set(`blob:${ORIGIN}${cardUrl}`, card.mod);
  const controller = createPluginCardAreaController({
    ...fx.bridge,
    acquireManagement: () => (leaseBusy ? null : (leaseBusy = true, () => { leaseBusy = false; released += 1; })),
  });
  await controller.sync([entry()], "en", new El("div"));
  // Card takes the shared lease like a managed mutation would.
  const release = card.mounts[0].props.acquireManagement?.();
  assert.ok(release);
  controller.dispose();
  assert.equal(released, 0);
  release!();
  assert.equal(released, 1);
});

// ---------------------------------------------------------------------------
// isSameOriginCardUrl
// ---------------------------------------------------------------------------
test("isSameOriginCardUrl accepts only same-origin http(s) declared card URLs", () => {
  assert.equal(isSameOriginCardUrl("/plugins/gemini-oauth/card.js", ORIGIN), true);
  assert.equal(isSameOriginCardUrl("/plugins/x/card.js?v=1#f", ORIGIN), true);
  for (const bad of [
    "https://evil.example/plugins/x/card.js",
    "//evil.example/plugins/x/card.js",
    "data:text/javascript,export default 1",
    `blob:${ORIGIN}/00000000-0000-0000-0000-000000000000`,
    "javascript:export default 1",
    "http://user:pass@127.0.0.1:3456/plugins/x/card.js",
    "", "   ", " /plugins/x/card.js", 42, null, undefined,
    "x".repeat(2049),
  ]) {
    assert.equal(isSameOriginCardUrl(bad, ORIGIN), false, JSON.stringify(String(bad).slice(0, 40)));
  }
  assert.equal(isSameOriginCardUrl("/plugins/x/card.js", ""), false);
});

// ---------------------------------------------------------------------------
// api.fetchPluginCardSource
// ---------------------------------------------------------------------------
test("fetchPluginCardSource refuses non same-origin URLs before any request", async () => {
  const client = new ApiClient("/api", "admin-mock");
  let fetches = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => { fetches += 1; return new Response(""); }) as typeof fetch;
  try {
    for (const bad of [
      "https://evil.example/plugins/x/card.js",
      "//evil.example/plugins/x/card.js",
      "data:text/javascript,export default 1",
      `blob:${ORIGIN}/00000000-0000-0000-0000-000000000000`,
      "http://user:pass@127.0.0.1:3456/plugins/x/card.js",
      "", "   ",
    ]) {
      await assert.rejects(client.fetchPluginCardSource(bad as string), /same-origin/);
    }
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchPluginCardSource fetches the declared path with admin headers and never puts the key in a URL", async () => {
  const client = new ApiClient("/api", "admin-mock");
  const calls: Array<{ url: string; options?: RequestInit }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
    calls.push({ url: String(url), options });
    if (calls.length === 1) return new Response("export default {mount(){}}", { status: 200 });
    return new Response("boom", { status: 500 });
  }) as typeof fetch;
  try {
    const source = await client.fetchPluginCardSource("/plugins/gemini-oauth/card.js");
    assert.equal(source, "export default {mount(){}}");
    assert.equal(calls[0].url, "/plugins/gemini-oauth/card.js");
    assert.equal((calls[0].options?.headers as Record<string, string>)["X-API-Key"], "admin-mock");
    assert.equal(calls[0].options?.credentials, "same-origin");
    // GET must not carry a request body content type.
    assert.equal((calls[0].options?.headers as Record<string, string>)["Content-Type"], undefined);
    await assert.rejects(client.fetchPluginCardSource("/plugins/gemini-oauth/card.js"), /500/);
    assert.ok(!calls.some((call) => call.url.includes("admin-mock")));
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchPluginCardSource traps 401 like the rest of the client", async () => {
  const client = new ApiClient("/api", "admin-mock");
  storage.set("apiKey", "admin-mock");
  const events: string[] = [];
  (globalThis as any).window = {
    location: { search: "" },
    dispatchEvent: (event: Event) => events.push(event.type),
  };
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response("", { status: 401 })) as typeof fetch;
  try {
    await assert.rejects(client.fetchPluginCardSource("/plugins/gemini-oauth/card.js"), /unauthorized/);
    assert.deepEqual(events, ["unauthorized"]);
    assert.equal(storage.has("apiKey"), false);
  } finally {
    globalThis.fetch = original;
  }
});

test("pluginLocaleOf stays in sync with the controller locale contract", () => {
  assert.equal(pluginLocaleOf("zh-CN"), "zh");
  assert.equal(pluginLocaleOf("en-US"), "en");
});

// Generic capabilities formerly covered only by one built-in provider's API.
test("provider management lease excludes full-config writes in both directions", async () => {
  const client = new ApiClient("/api"); const original = globalThis.fetch;
  let finish!: (response: Response) => void;
  globalThis.fetch = (() => new Promise<Response>(resolve => { finish = resolve; })) as typeof fetch;
  try {
    const release = client.acquireProviderManagement(); assert.ok(release);
    assert.equal(client.acquireProviderManagement(), null);
    assert.deepEqual(await client.updateConfig({} as never), { success: false });
    release();
    const pending = client.updateConfig({} as never);
    assert.equal(client.acquireProviderManagement(), null);
    finish(new Response('{"success":true}')); await pending;
    const next = client.acquireProviderManagement(); assert.ok(next); next();
  } finally { globalThis.fetch = original; }
});

test("plugin API sends authenticated exact bodies and carries only sanitized local timeout classification", async () => {
  const client = new ApiClient("/api", "mock-key"); const original = globalThis.fetch;
  const controller = new AbortController(); let sent: RequestInit | undefined;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(url, "/api/synthetic/login/poll"); sent = init;
    assert.equal((init?.headers as Record<string, string>)["X-API-Key"], "mock-key");
    assert.equal(init?.body, '{"loginId":"job"}');
    throw new DOMException("private-error-marker", "TimeoutError");
  }) as typeof fetch;
  try {
    await assert.rejects(client.callPluginApi("synthetic", "/login/poll", {
      method: "POST", body: '{"loginId":"job"}', signal: controller.signal, timeoutMs: 10000,
    }), error => {
      assert.equal((error as any).timedOut, true); assert.equal((error as any).reason, "request_failed");
      assert.doesNotMatch(String(error), /private-error-marker/); return true;
    });
    assert.notEqual(sent?.signal, controller.signal); // timeout + caller signal
    controller.abort(); assert.equal(sent?.signal?.aborted, true);
  } finally { globalThis.fetch = original; }
});
