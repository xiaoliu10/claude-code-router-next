import { afterEach, expect, it, vi } from "vitest";
import { getQuotaAdapter } from "../services/quota-adapters";
import type { LLMProvider } from "../types/llm";
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });
const provider = { name: "fixture", baseUrl: "https://example.com", apiKey: "test-key", models: [] } as LLMProvider;
async function query(detail: Record<string, unknown>) {
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
    limits: [{ window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: { ...detail, resetTime: "2100-01-01T05:00:00Z" } }],
    usage: { limit: "100", used: "20", resetTime: "2100-01-08T00:00:00Z" },
  }))) as typeof fetch;
  return getQuotaAdapter("https://api.kimi.com/coding/v1")!.queryQuota(provider, 1000);
}
it("keeps the exhausted 5h window when remaining is omitted", async () => {
  expect(await query({ limit: "100", used: "100" })).toMatchObject({
    limitDaily: 100, usedDailyBalance: 100, totalBalance: 100, usedBalance: 20,
    resetTime: "2100-01-01T05:00:00.000Z", resetTime7d: "2100-01-08T00:00:00.000Z",
  });
});
it.each([0, 25, 120])("uses explicit short-window usage %i", async used => {
  expect(await query({ limit: "100", used: String(used), remaining: "90" })).toMatchObject({ limitDaily: 100, usedDailyBalance: used });
});
it("retains remaining-based compatibility", async () => {
  expect(await query({ limit: "100", remaining: "75" })).toMatchObject({ limitDaily: 100, usedDailyBalance: 25 });
});
it("does not invent usage when only the limit is known", async () => {
  const result = await query({ limit: "100" });
  expect(result?.limitDaily).toBe(100);
  expect(result?.usedDailyBalance).toBeUndefined();
});
