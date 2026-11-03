import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, unmount } from "../src/card-entry";
import { grokLocales } from "../src/locales";
class Element {
  children: Element[] = []; textContent = ""; className = ""; disabled = false; onclick?: () => void; href = ""; rel = ""; target = "";
  setAttribute(_: string, _v: string) {}
  constructor(readonly tag: string) {}
  append(...children: Element[]) { this.children.push(...children); }
  appendChild(child: Element) { this.children.push(child); return child; }
  prepend(child: Element) { this.children.unshift(child); return child; }
  replaceChildren(...children: Element[]) { this.children = children; }
  all(): Element[] { return [this, ...this.children.flatMap(c => c.all())]; }
  button(text: string) { const b = this.all().find(c => c.tag === "button" && c.textContent === text); if (!b) throw new Error(`Missing ${text}`); return b; }
}
const tick = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };
const roots: Element[] = [];
afterEach(() => { for (const root of roots.splice(0)) unmount(root as any); });
function setup(state = "not_connected") {
  vi.stubGlobal("document", { createElement: (tag: string) => new Element(tag), createElementNS: () => new Element("svg") as any });
  const root = new Element("div"); roots.push(root);
  const release = vi.fn(); let listener: (() => void) | undefined;
  const props: any = {
    locale: "en", locales: grokLocales, disabled: false, plugin: { name: "grok", version: "0.1.0" },
    acquireManagement: vi.fn(() => release), refreshConfig: vi.fn(async () => {}), onBusy: vi.fn(),
    onHostChange: vi.fn((fn: () => void) => { listener = fn; return vi.fn(); }), log: { info() {}, warn() {}, error() {} },
    callApi: vi.fn(async (path: string) => {
      if (path === "/status") return { status: state, models: state === "connected" ? [{ id: "grok-fixture", hidden: false }] : [] };
      if (path === "/usage") return { known: false, stale: false };
      return { success: true };
    }),
  };
  mount(root as any, props);
  return { root, props, release, hostChange: () => listener?.() };
}
describe("Grok card host bridge", () => {
  it("uses only callApi, management lease and refreshConfig preserving drafts", async () => {
    const { root, props, release } = setup(); await tick();
    root.button("Use current CLI sign-in").onclick!(); await tick();
    expect(props.callApi).toHaveBeenCalledWith("/import", expect.objectContaining({ method: "POST" }));
    expect(props.acquireManagement).toHaveBeenCalledTimes(1); expect(release).toHaveBeenCalledTimes(1);
    expect(props.refreshConfig).toHaveBeenCalledTimes(1); expect(props.onBusy.mock.calls.map((c: any) => c[0])).toEqual([true, false]);
    const merge = props.refreshConfig.mock.calls[0][0];
    const local = { Router: { default: "draft,m" }, Providers: [{ name: "draft", models: ["m"] }] };
    const next = merge(local, { Providers: [{ name: "grok-subscription", grok_managed: true }] });
    expect(next.Router).toBe(local.Router); expect(next.Providers[0]).toEqual(local.Providers[0]);
  });
  it("host changes disable in place and unknown quota is displayed as unknown", async () => {
    const { root, props, hostChange } = setup("connected"); await tick();
    root.button("Refresh quota").onclick!(); await tick(); expect(root.all().some(c => c.textContent === "Quota unknown")).toBe(true);
    props.disabled = true; hostChange(); expect(root.button("Refresh models").disabled).toBe(true);
    expect(props.callApi.mock.calls.some((c: any) => c[0] === "/login/cancel")).toBe(false);
  });
  it("unmount holds a pending mutation's lease until it settles", async () => {
    const { root, props, release } = setup(); await tick();
    let settle!: (value: any) => void;
    props.callApi.mockImplementation((path: string) => path === "/import" ? new Promise(r => { settle = r; }) : Promise.resolve({ status: "connected", models: [] }));
    root.button("Use current CLI sign-in").onclick!(); await tick();
    unmount(root as any); expect(release).not.toHaveBeenCalled(); settle({ success: true }); await tick(); expect(release).toHaveBeenCalledTimes(1);
  });
  it("unmount holds the lease through persistence and reconcile until the whole mutation settles", async () => {
    const { root, props, release } = setup("connected"); await tick();
    let settleModels!: (value: any) => void, settled = false;
    props.callApi.mockImplementation(async (path: string) => {
      if (path === "/sync") return new Promise(r => { settleModels = (v: any) => { settled = true; r(v); }; });
      if (path === "/status") return { status: "connected", models: [{ id: "grok-fixture", hidden: false }] };
      return { success: true };
    });
    root.button("Refresh models").onclick!(); await tick();
    unmount(root as any); await tick();
    expect(release).not.toHaveBeenCalled(); expect(settled).toBe(false);
    settleModels({ success: true }); await tick();
    expect(settled).toBe(true); expect(release).toHaveBeenCalledTimes(1);
  });
  it("device login acquires one lease and unmount cancels pending job", async () => {
    const { root, props, release } = setup(); await tick();
    props.callApi.mockImplementation(async (path: string) => path === "/login/start" ? { loginId: "a".repeat(32), url: "https://accounts.x.ai/oauth2/device?user_code=AB12", expiresAt: Date.now() + 30000 } : path === "/login/poll" ? { status: "pending" } : { success: true });
    root.button("Device sign-in").onclick!(); await tick(); expect(release).not.toHaveBeenCalled();
    unmount(root as any); await tick(); expect(props.callApi).toHaveBeenCalledWith("/login/cancel", expect.objectContaining({ body: JSON.stringify({ loginId: "a".repeat(32) }) }));
    expect(release).toHaveBeenCalledTimes(1);
  });
  it("locale keys have parity", () => { expect(Object.keys(grokLocales.en.grok).sort()).toEqual(Object.keys(grokLocales.zh.grok).sort()); });
});
