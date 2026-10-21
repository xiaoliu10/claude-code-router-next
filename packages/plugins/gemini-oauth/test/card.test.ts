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
  dataset: Record<string, string> = {};
  onclick?: () => void;
  onchange?: () => void;
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
  click(text: string) { const b = this.button(text); if (!b.disabled) b.onclick?.(); }
  text(): string { return this.all().map(n => n.textContent).join("\n"); }
}
const tick = async () => { for (let i = 0; i < 15; ++i) await Promise.resolve(); };
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(f => f()); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function harness(overrides: Record<string, (init?: any) => any> = {}) {
  vi.stubGlobal("document", { createElement: (tag: string) => new Element(tag) });
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
  const release = vi.fn(), onBusy = vi.fn(), refreshConfig = vi.fn(async (_merge: (current: any, server: any) => any) => {});
  mount(host as any, { callApi: callApi as any, locale: "en", locales: geminiOauthLocales,
    disabled: false, plugin: { name: "gemini-oauth", version: "1" }, log: console,
    acquireManagement: () => release, onBusy, refreshConfig });
  cleanups.push(() => unmount(host as any));
  return { host, callApi, open, release, onBusy, refreshConfig };
}
const en = geminiOauthLocales.en.geminiOauth as any;
describe("self-contained Gemini plugin card", () => {
  it("mount performs only a status read; checkbox acknowledgement gates the ONLY login action", async () => {
    const h = harness(); await tick();
    expect(h.callApi.mock.calls.map(([path]) => path)).toEqual(["/status"]);
    expect(h.host.text()).toContain(en.status.connected);
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
});
