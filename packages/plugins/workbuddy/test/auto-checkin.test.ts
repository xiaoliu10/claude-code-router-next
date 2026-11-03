import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { localCheckinDate, WorkBuddyAutoCheckin, type WorkBuddyAutoCheckinState } from "../src/auto-checkin";
import { WorkBuddyAuthService } from "../src/auth-service";
import { WorkBuddyCredentialStore } from "../src/protocol";
import { activate, getActivatedWorkBuddyService } from "../src/plugin";

const dirs: string[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 5, 4, 9, 0)); });
afterEach(() => {
  vi.clearAllTimers(); vi.useRealTimers();
  dirs.splice(0).forEach(dir => rmSync(dir, { force: true, recursive: true }));
});
function state(outcome: WorkBuddyAutoCheckinState["lastResult"]["outcome"], retryCount = 0): WorkBuddyAutoCheckinState {
  const at = new Date().toISOString();
  return { lastAttemptAt: at, lastAttemptDate: localCheckinDate(), lastResult: { outcome, at }, retryCount };
}
function harness(initial?: WorkBuddyAutoCheckinState, outcome: WorkBuddyAutoCheckinState["lastResult"]["outcome"] = "claimed") {
  let saved = initial;
  const update = vi.fn(async (transform: (s: typeof saved) => WorkBuddyAutoCheckinState) => saved = transform(saved));
  const logger = { warn: vi.fn() };
  const operation = vi.fn(async () => ({ outcome }));
  const attempt = vi.fn(() => scheduler.execute(operation));
  const scheduler = new WorkBuddyAutoCheckin({ load: async () => saved, update, attempt, logger, random: () => 0.5 });
  return { scheduler, attempt, operation, update, logger, saved: () => saved };
}
it("stale local date starts once after 1–10 minute jitter and unrefs its timer", async () => {
  const stale = state("done"); stale.lastAttemptDate = "2026-06-03";
  const h = harness(stale);
  const timers = vi.spyOn(globalThis, "setTimeout");
  await h.scheduler.scheduleAutoCheckin();
  expect((timers.mock.results.at(-1)!.value as NodeJS.Timeout).hasRef()).toBe(false);
  await vi.advanceTimersByTimeAsync(329_999); expect(h.attempt).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect(h.attempt).toHaveBeenCalledTimes(1);
  expect(h.saved()).toMatchObject({ lastAttemptDate: "2026-06-04", retryCount: 0, lastResult: { outcome: "claimed" } });
  expect(vi.getTimerCount()).toBe(1);
});
it.each(["claimed", "done", "inactive", "ineligible"] as const)("%s persists then waits until next local midnight plus jitter", async outcome => {
  const h = harness(undefined, outcome); await h.scheduler.scheduleAutoCheckin();
  await vi.advanceTimersByTimeAsync(330_000);
  expect(h.saved()?.lastResult.outcome).toBe(outcome);
  const target = new Date(2026, 5, 5, 0, 22, 30).getTime();
  await vi.advanceTimersByTimeAsync(target - Date.now() - 1); expect(h.attempt).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(h.attempt).toHaveBeenCalledTimes(2);
});
it("failed attempts retry at thirty minutes, capped at five retries per local day", async () => {
  const h = harness(undefined, "failed"); await h.scheduler.scheduleAutoCheckin();
  await vi.advanceTimersByTimeAsync(330_000);
  expect(h.saved()?.retryCount).toBe(0);
  for (let n = 1; n <= 5; n++) {
    await vi.advanceTimersByTimeAsync(30 * 60_000 - 1); expect(h.attempt).toHaveBeenCalledTimes(n);
    await vi.advanceTimersByTimeAsync(1); expect(h.saved()?.retryCount).toBe(n);
  }
  await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);
  expect(h.attempt).toHaveBeenCalledTimes(6);
});
it("rollover resets the retry budget, including after restart", async () => {
  const old = state("failed", 5); old.lastAttemptDate = "2026-06-03";
  const h = harness(old, "failed"); await h.scheduler.scheduleAutoCheckin();
  await vi.advanceTimersByTimeAsync(330_000); expect(h.saved()?.retryCount).toBe(0);
});
it("a late-night failure waits for tomorrow rather than retrying across midnight", async () => {
  vi.setSystemTime(new Date(2026, 5, 4, 23, 50));
  const h = harness(state("failed"), "failed"); await h.scheduler.scheduleAutoCheckin();
  await vi.advanceTimersByTimeAsync(32 * 60_000 + 29_999); expect(h.attempt).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect(h.attempt).toHaveBeenCalledTimes(1); expect(h.saved()?.retryCount).toBe(0);
});
it("repeated scheduling replaces the timer and stop cancels it", async () => {
  const h = harness(); await Promise.all([h.scheduler.scheduleAutoCheckin(), h.scheduler.scheduleAutoCheckin()]);
  expect(vi.getTimerCount()).toBe(1); h.scheduler.stop(); expect(vi.getTimerCount()).toBe(0);
});
it("offline exceptions persist failed state, log a fixed message and keep retrying", async () => {
  const h = harness(); h.operation.mockRejectedValue(new Error("secret"));
  await h.scheduler.scheduleAutoCheckin(); await vi.advanceTimersByTimeAsync(330_000);
  expect(h.saved()?.lastResult.outcome).toBe("failed"); expect(h.logger.warn).toHaveBeenCalledWith("WorkBuddy automatic check-in failed");
  expect(JSON.stringify(h.logger.warn.mock.calls)).not.toContain("secret"); expect(vi.getTimerCount()).toBe(1);
});
it("persistence failures never escape the host timer and still schedule tomorrow", async () => {
  const h = harness(); h.update.mockRejectedValue(new Error("secret"));
  await h.scheduler.scheduleAutoCheckin(); await vi.advanceTimersByTimeAsync(330_000);
  expect(h.logger.warn).toHaveBeenCalledWith("WorkBuddy automatic check-in state could not be saved"); expect(vi.getTimerCount()).toBe(1);
});
function storeHarness() {
  const dir = mkdtempSync(join(tmpdir(), "wb-auto-")); dirs.push(dir);
  const store = new WorkBuddyCredentialStore(join(dir, "workbuddy-credentials.json"));
  const fetch = vi.fn(async (url: string) => new Response(JSON.stringify({ code: 0, data:
    url.endsWith("checkin-activity-status") ? { active: true } : { credit: 4 } })));
  const host = { readRawConfig: async () => ({}), writeConfig: async () => {}, reloadRuntime: () => {}, getDirectDispatcher: () => undefined };
  const service = new WorkBuddyAuthService({ store, host, fetch, autoCheckinRandom: () => 0.5 });
  return { dir, store, service, host, fetch };
}
it("manual success feeds shared state, survives a 0600 round trip and disarms today's pending attempt", async () => {
  const h = storeHarness();
  await h.store.upsertAccount({ version: 1, kind: "workbuddy", uid: "active", displayName: "", source: "desktop", accessToken: "secret", domain: "", enterpriseId: "", expiresAt: 0, importedAt: "" });
  await h.service.scheduleAutoCheckin();
  expect((await h.service.checkin()).outcome).toBe("claimed");
  const roundTrip = await new WorkBuddyCredentialStore(h.store.path).loadData();
  expect(roundTrip?.autoCheckin).toEqual(state("claimed"));
  expect((await h.service.getPoolStatus()).autoCheckin).toEqual(state("claimed"));
  if (process.platform !== "win32") expect(statSync(h.store.path).mode & 0o777).toBe(0o600);
  await vi.advanceTimersByTimeAsync(60 * 60_000); expect(h.fetch).toHaveBeenCalledTimes(2);
});
it("state-only files preserve signed-out accounting without credentials, connectivity or a usable data plane", async () => {
  const h = storeHarness();
  expect(await h.service.checkin()).toMatchObject({ outcome: "failed", uid: null });
  expect(await h.store.load()).toBeNull();
  expect(await h.service.getPoolStatus()).toMatchObject({ connectedSites: [], sites: {}, autoCheckin: { lastResult: { outcome: "failed" } } });
  expect((await h.service.getStatus()).status).toBe("not_connected");
  expect(await h.service.currentCredential()).toBeNull();
  expect(h.fetch).not.toHaveBeenCalled();
});
it("same-configDir activation replaces its chain while different configDirs stay independent", async () => {
  const a = storeHarness(), b = storeHarness();
  const context = (h: ReturnType<typeof storeHarness>) => ({ host: { ...h.host, configDir: h.dir }, log: { info() {}, warn() {} },
    registerTransformer() {}, registerManagedRuntime() {}, registerAdminRoutes() {}, registerConfigProtector() {}, registerUiCard() {}, registerLocales() {} });
  await activate(context(a) as any); const first = getActivatedWorkBuddyService();
  expect(vi.getTimerCount()).toBe(1);
  await activate(context(a) as any); expect(getActivatedWorkBuddyService()).not.toBe(first); expect(vi.getTimerCount()).toBe(1);
  await activate(context(b) as any); expect(vi.getTimerCount()).toBe(2);
});
