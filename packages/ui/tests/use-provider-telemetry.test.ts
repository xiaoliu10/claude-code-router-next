import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Config, Provider, ProviderQuotaResponse } from "../src/types.ts";

// The hook renders no DOM. React needs an event target to mount and commit it.
const document = Object.assign(new EventTarget(), { visibilityState: "hidden" });
Object.assign(globalThis, {
  document,
  window: { document, location: { search: "" }, HTMLIFrameElement: class {} },
  localStorage: { getItem: () => null },
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { useProviderTelemetry } = await import("../src/components/use-provider-telemetry.ts");
const { api } = await import("../src/lib/api.ts");

const original: Provider = { name: "step", models: [], api_base_url: "https://one.invalid", api_key: "fixture-a" };
function quota(name: string): ProviderQuotaResponse {
  return { timestamp: "", quotas: [{ provider: original.name, used5h: 0, used7d: 0, stepPlan: {
    name, family: "token", state: "known", observedAt: 1, allowed: true, windows: [], creditBuckets: [],
  } }] };
}

for (const change of ["key", "endpoint", "enabled", "save"] as const) {
  test(`a same-name ${change} change hides the old Step Plan on first render and rejects late telemetry`, async t => {
    const pending: ((response: ProviderQuotaResponse) => void)[] = [];
    t.mock.method(api, "getProviderQuota", () => new Promise(resolve => pending.push(resolve)));
    t.mock.method(api, "getProviderHealth", async () => ({ states: [], timestamp: "" }));
    const root = createRoot(Object.assign(new EventTarget(), {
      nodeType: 1, tagName: "DIV", ownerDocument: document,
    }) as unknown as HTMLElement);
    t.after(() => act(() => root.unmount()));

    const figures: (string | null | undefined)[] = [];
    let refresh!: () => Promise<void>;
    function Observer({ config, saving }: { config: Config; saving: boolean }) {
      const telemetry = useProviderTelemetry(config, saving);
      figures.push(telemetry.quotaUsages[0]?.stepPlan?.name);
      refresh = telemetry.refreshTelemetryRef.current;
      return null;
    }
    const render = (config: Config, saving = false) => act(() => {
      root.render(createElement(Observer, { config, saving }));
    });
    const initial = { Providers: [original] } as Config;
    await render(initial);
    await act(async () => pending[0](quota("old account")));
    assert.equal(figures.at(-1), "old account");
    void refresh();
    assert.equal(pending.length, 2);
    figures.length = 0;

    if (change === "save") {
      await render(initial, true);
      assert.deepEqual(figures, [undefined]);
      assert.equal(pending.length, 2);
      await render(initial);
    } else {
      const patch = change === "key" ? { api_key: "fixture-b" }
        : change === "endpoint" ? { api_base_url: "https://two.invalid" } : { enabled: false };
      await render({ ...initial, Providers: [{ ...original, ...patch }] });
    }
    assert.ok(figures.length > 0 && figures.every(name => name === undefined));
    assert.equal(pending.length, 3, "fresh request starts while the previous read is still pending");
    const fresh = change === "enabled" ? { timestamp: "", quotas: [] } : quota("new account");
    await act(async () => pending[2](fresh));
    await act(async () => pending[1](quota("late old account")));
    assert.equal(figures.at(-1), fresh.quotas[0]?.stepPlan?.name);
    assert.ok(!figures.includes("late old account"));
  });
}
