import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QoderAutoCheckin, localCheckinDate, type AutoCheckinState } from "../src/auto-checkin";
import type { QoderCheckinResult } from "../src/checkin";

const MINUTE = 60_000;
const schedulers: QoderAutoCheckin[] = [];
function fixture(outcome: QoderCheckinResult["outcome"] = "claimed", initial?: AutoCheckinState, rand = 0, key = "fixture") {
  let state = initial;
  const persist = vi.fn(async (next: AutoCheckinState) => { state = next; });
  const log = { warn: vi.fn() };
  const enabled = vi.fn(() => true);
  const checkin = vi.fn(async () => { await scheduler.recordResult({ outcome }); return { outcome }; });
  const scheduler = new QoderAutoCheckin(key, { enabled, state: () => state, persist, checkin, log, rand: () => rand });
  schedulers.push(scheduler);
  return { scheduler, checkin, persist, log, enabled, state: () => state };
}
const saved = (outcome: QoderCheckinResult["outcome"], date: Date, retryCount = 0): AutoCheckinState => ({
  lastAttemptAt: date.toISOString(), lastAttemptDate: localCheckinDate(date), retryCount,
  lastResult: { outcome, at: date.toISOString() },
});

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 5, 10, 8, 0)); });
afterEach(() => { for (const s of schedulers.splice(0)) s.stop(); vi.useRealTimers(); });

describe("QoderAutoCheckin", () => {
  it("starts stale accounts after injected startup jitter and unrefs its one timer", async () => {
    const f = fixture("claimed", saved("done", new Date(2026, 5, 9)), 1);
    const timers = vi.spyOn(globalThis, "setTimeout");
    f.scheduler.scheduleAutoCheckin();
    expect(timers.mock.results.at(-1)!.value.hasRef()).toBe(false);
    await vi.advanceTimersByTimeAsync(10 * MINUTE - 1);
    expect(f.checkin).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.checkin).toHaveBeenCalledOnce();
    expect(f.state()?.lastAttemptDate).toBe("2026-06-10");
    timers.mockRestore();
  });

  it.each(["claimed", "done", "inactive", "ineligible"] as const)("persists %s and schedules next local midnight plus jitter", async outcome => {
    const f = fixture(outcome, undefined, 0.5);
    f.scheduler.scheduleAutoCheckin();
    await vi.advanceTimersByTimeAsync(5.5 * MINUTE);
    expect(f.persist).toHaveBeenCalledOnce();
    expect(f.state()).toMatchObject({ retryCount: 0, lastResult: { outcome } });
    const next = new Date(2026, 5, 11).getTime() + 22.5 * MINUTE;
    await vi.advanceTimersByTimeAsync(next - Date.now() - 1);
    expect(f.checkin).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.checkin).toHaveBeenCalledTimes(2);
    expect(f.state()?.retryCount).toBe(0);
  });

  it("retries failures at 30 minutes with five retries per day, then waits for midnight", async () => {
    const f = fixture("failed", undefined, 0.5);
    f.scheduler.scheduleAutoCheckin();
    await vi.advanceTimersByTimeAsync(5.5 * MINUTE);
    for (let retry = 1; retry <= 5; retry++) {
      await vi.advanceTimersByTimeAsync(30 * MINUTE - 1);
      expect(f.checkin).toHaveBeenCalledTimes(retry);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.state()?.retryCount).toBe(retry);
    }
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(f.checkin).toHaveBeenCalledTimes(6);
    expect(f.log.warn).toHaveBeenCalled();
  });

  it("resumes a failed day's remaining budget after reload", async () => {
    const f = fixture("failed", saved("failed", new Date(), 4), 0.5);
    f.scheduler.scheduleAutoCheckin();
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(f.state()?.retryCount).toBe(5);
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(f.checkin).toHaveBeenCalledOnce();
  });

  it("resets the retry budget across a local date rollover", async () => {
    const f = fixture("failed", saved("failed", new Date(2026, 5, 9, 23, 59), 5));
    f.scheduler.scheduleAutoCheckin();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(f.state()?.retryCount).toBe(0);
  });

  it("uses the next day rather than scheduling an old day's retry past midnight", async () => {
    vi.setSystemTime(new Date(2026, 5, 10, 23, 50));
    const f = fixture("failed", saved("failed", new Date()), 0.5);
    f.scheduler.scheduleAutoCheckin();
    await vi.advanceTimersByTimeAsync(32.5 * MINUTE);
    expect(f.checkin).toHaveBeenCalledOnce();
    expect(f.state()?.retryCount).toBe(0);
  });

  it("repeated scheduling and replacement activation leave only one chain", async () => {
    const f = fixture();
    f.scheduler.scheduleAutoCheckin();
    f.scheduler.scheduleAutoCheckin();
    expect(vi.getTimerCount()).toBe(1);
    const second = fixture();
    second.scheduler.scheduleAutoCheckin();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(f.checkin).not.toHaveBeenCalled();
    expect(second.checkin).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
  });

  it("inherits an in-flight attempt on takeover and persists its success through the new owner", async () => {
    const first = fixture();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    first.checkin.mockImplementationOnce(async () => {
      await pending;
      await first.scheduler.recordResult({ outcome: "claimed" });
      return { outcome: "claimed" };
    });
    first.scheduler.scheduleAutoCheckin();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(first.checkin).toHaveBeenCalledOnce();

    const second = fixture();
    second.scheduler.scheduleAutoCheckin();
    // Advance past even the maximum replacement startup jitter while A waits.
    await vi.advanceTimersByTimeAsync(11 * MINUTE);
    expect(second.checkin).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(second.persist).toHaveBeenCalledOnce();
    expect(second.state()).toMatchObject({ retryCount: 0, lastResult: { outcome: "claimed" } });
    expect(vi.getTimerCount()).toBe(1);
    const midnight = new Date(2026, 5, 11).getTime();
    await vi.advanceTimersByTimeAsync(midnight - Date.now() - 1);
    expect(second.checkin).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(second.checkin).toHaveBeenCalledOnce();
  });

  it("routes a replaced service's manual result to the owner and cancels today's startup timer", async () => {
    const first = fixture();
    first.scheduler.scheduleAutoCheckin();
    const second = fixture();
    second.scheduler.scheduleAutoCheckin();
    await first.scheduler.recordResult({ outcome: "done" });
    expect(second.persist).toHaveBeenCalledOnce();
    expect(second.state()).toMatchObject({ lastResult: { outcome: "done" } });
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(11 * MINUTE);
    expect(first.checkin).not.toHaveBeenCalled();
    expect(second.checkin).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(new Date(2026, 5, 11).getTime() - Date.now());
    expect(second.checkin).toHaveBeenCalledOnce();
  });

  it("does not arm an ineligible site or disconnected service", () => {
    const f = fixture();
    f.enabled.mockReturnValue(false);
    f.scheduler.scheduleAutoCheckin();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("catches thrown attempts and disk failures without crashing or spinning", async () => {
    const f = fixture();
    f.checkin.mockRejectedValue(new Error("secret"));
    f.persist.mockRejectedValue(new Error("disk"));
    f.scheduler.scheduleAutoCheckin();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(f.log.warn).toHaveBeenCalledWith("Qoder auto check-in state could not be saved");
    expect(JSON.stringify(f.log.warn.mock.calls)).not.toContain("secret");
    await vi.advanceTimersByTimeAsync(24 * MINUTE);
    expect(f.checkin).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(f.checkin).toHaveBeenCalledTimes(2);
  });
});
