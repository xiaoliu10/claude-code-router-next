import { describe, expect, it, vi } from "vitest";
import { mount as mountCard, unmount as unmountCard } from "../src/card-entry";

/**
 * Card seam test for the two-site layout. The host bridge is a double, but the
 * card module under test is the real one: this pins the things the CN change
 * actually introduced —
 *   1. each section calls its OWN bridge prefix (`/…` vs `/cn/…`),
 *   2. `onBusy` stays a balanced counting semaphore across sections,
 *   3. a re-render triggered by the other section never wipes a half-typed PAT.
 */

class El {
  tag: string; children: El[] = []; textContent = ""; className = ""; type = "";
  attrs: Record<string, string> = {}; value = ""; disabled = false;
  onclick?: () => void; oninput?: () => void; onkeydown?: (e: any) => void; onchange?: () => void;
  constructor(tag: string) { this.tag = tag; }
  append(...nodes: El[]) { this.children.push(...nodes); }
  appendChild(child: El): El { this.children.push(child); return child; }
  prepend(...nodes: El[]) { this.children.unshift(...nodes); }
  replaceChildren(...nodes: El[]) { this.children = [...nodes]; }
  remove() {}
  setAttribute(key: string, value: string) { this.attrs[key] = value; }
  getAttribute(key: string) { return this.attrs[key] ?? null; }
  addEventListener() {}
  removeEventListener() {}
  querySelector(): El | null { return null; }
  focus() {}
  scrollIntoView() {}
  get firstChild(): El | null { return this.children[0] ?? null; }
  get lastChild(): El | null { return this.children.at(-1) ?? null; }
  set innerHTML(_value: string) {}
}

// The card builds elements through the global document factory; give the test
// a double that returns the recording El above.
(globalThis as any).document = { createElement: (tag: string) => new El(tag) };

const walk = (node: El, visit: (el: El) => void): void => { visit(node); for (const child of node.children) walk(child, visit); };
const all = (root: El, predicate: (el: El) => boolean): El[] => {
  const out: El[] = []; walk(root, el => { if (predicate(el)) out.push(el); }); return out;
};
const text = (root: El): string => { let out = ""; walk(root, el => { out += el.textContent + " "; }); return out; };
const buttonNamed = (root: El, label: string): El | undefined =>
  all(root, el => el.tag === "button" && el.textContent === label)[0];
const passwordInputs = (root: El): El[] => all(root, el => el.tag === "input" && el.type === "password");

function mountCardIn(props: any) {
  const el: any = new El("div");
  mountCard(el, props);
  return el as El;
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe("Qoder card: two independent site sections", () => {
  it("calls each site's own bridge prefix and never crosses them", async () => {
    const calls: string[] = [];
    const busy: boolean[] = [];
    const el = mountCardIn({
      callApi: async (path: string) => {
        calls.push(path);
        return path.endsWith("/status") ? { status: "not_connected", models: [] } : {};
      },
      locale: "en", locales: {}, plugin: { name: "qoder", version: "0.1.0" },
      disabled: false, acquireManagement: () => () => {}, onBusy: (b: boolean) => busy.push(b),
      log: console,
    });
    await flush(); await flush();

    expect(calls).toContain("/status");
    expect(calls).toContain("/cn/status");
    // No CN section ever used an intl path and vice versa.
    for (const path of calls) expect(path === "/status" || path.startsWith("/cn/")).toBe(true);
    const body = text(el);
    expect(body).toContain("Qoder Subscription");
    expect(body).toContain("Qoder CN");
    unmountCard(el);
  });

  it("keeps onBusy balanced and disables both sections while one is acting", async () => {
    let resolveSync!: () => void;
    const gate = new Promise<void>(resolve => { resolveSync = resolve; });
    const busy: boolean[] = [];
    const el = mountCardIn({
      callApi: async (path: string) => {
        if (path === "/sync") { await gate; return {}; }
        return { status: "connected", models: [{ id: "m1", context: 1000, hidden: false }] };
      },
      locale: "en", locales: {}, plugin: { name: "qoder", version: "0.1.0" },
      disabled: false, acquireManagement: () => () => {}, onBusy: (b: boolean) => busy.push(b),
      log: console,
    });
    await flush(); await flush();

    const sync = buttonNamed(el, "Refresh models");
    expect(sync).toBeTruthy();
    sync!.onclick!();
    await flush();

    // true was reported once; while the action is in flight BOTH sections' buttons are disabled
    expect(busy.filter(Boolean)).toHaveLength(1);
    // The host's onBusy is a COUNTING semaphore (+1 on true, -1 on false), so
    // the release must emit `false` — emitting a "current busy state" instead
    // would unbalance the counter. The mutual-exclusion lease means the two
    // sections are never busy together, which is why asserting the sequence is
    // a contract guard rather than a repro of an observable double-count.
    expect(busy).toEqual([true]);
    const disabledButtons = all(el, item => item.tag === "button" && item.disabled);
    expect(disabledButtons.length).toBeGreaterThan(1);

    resolveSync();
    await flush(); await flush();
    // balanced: the release must emit exactly one `false`
    expect(busy.filter(value => value === false)).toHaveLength(1);
    unmountCard(el);
  });

  it("does not wipe a half-typed PAT when the other section re-renders", async () => {
    // Both statuses resolve normally; the CN section is held back on its SECOND
    // read so its landing lands mid-typing.
    let cnCalls = 0;
    let resolveCn!: (value: any) => void;
    const heldCn = new Promise<any>(resolve => { resolveCn = resolve; });
    const el = mountCardIn({
      callApi: async (path: string) => {
        if (path === "/cn/status") {
          cnCalls += 1;
          return cnCalls === 1 ? { status: "not_connected", models: [] } : heldCn;
        }
        return { status: "not_connected", models: [] };
      },
      locale: "en", locales: {}, plugin: { name: "qoder", version: "0.1.0" },
      disabled: false, acquireManagement: () => () => {}, onBusy: () => {},
      log: console,
    });
    await flush(); await flush();

    let inputs = passwordInputs(el);
    expect(inputs).toHaveLength(2);
    inputs[0].value = "pt-typing";
    inputs[0].oninput?.();

    // A CN action re-reads /cn/status and re-renders the whole card.
    const refreshCn = all(el, item => item.tag === "button" && item.textContent === "Refresh status").at(-1);
    expect(refreshCn).toBeTruthy();
    refreshCn!.onclick?.();
    await flush();
    resolveCn({ status: "not_connected", models: [] });
    await flush(); await flush();

    inputs = passwordInputs(el);
    expect(inputs).toHaveLength(2);
    // The draft survives its section's re-render and never leaks into CN's form.
    expect(inputs[0].value).toBe("pt-typing");
    expect(inputs[1].value).toBe("");
    unmountCard(el);
  });
});
