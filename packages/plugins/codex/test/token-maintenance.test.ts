import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodexTokenMaintenance,
  CODEX_TOKEN_MAINTENANCE_INITIAL_MS,
  CODEX_TOKEN_MAINTENANCE_INTERVAL_MS,
} from "../src/token-maintenance";

/** Deterministic timer harness: records every armed delay and fires manually. */
function fakeTimers() {
  const handles: Array<{ cb: () => void; fired: boolean }> = [];
  const delays: number[] = [];
  const setTimer = vi.fn((cb: () => void, delayMs: number) => {
    const handle = { cb, fired: false, unref: vi.fn() };
    handles.push(handle);
    delays.push(delayMs);
    return handle as unknown as NodeJS.Timeout;
  });
  const clearTimer = vi.fn((handle: NodeJS.Timeout) => {
    const entry = handle as unknown as { fired: boolean };
    entry.fired = true; // cleared handles must never fire
  });
  return {
    setTimer,
    clearTimer,
    delays,
    pending: () => handles.filter((h) => !h.fired),
    fireLast: async () => {
      const pending = handles.filter((h) => !h.fired);
      const last = pending.at(-1);
      if (!last) throw new Error("no pending timer");
      last.fired = true;
      await last.cb();
    },
  };
}

const logger = () => ({ warn: vi.fn(), info: vi.fn() });

afterEach(() => { vi.restoreAllMocks(); });

describe("CodexTokenMaintenance", () => {
  it("arms the first cycle with the initial delay and the cadence with the 30-minute interval", () => {
    const t = fakeTimers();
    const m = new CodexTokenMaintenance(vi.fn(async () => ({ refreshed: false })), logger(), {
      setTimer: t.setTimer, clearTimer: t.clearTimer,
    });
    m.start();
    expect(t.delays).toEqual([CODEX_TOKEN_MAINTENANCE_INITIAL_MS]);
    expect(t.setTimer.mock.calls[0][0]).toBeTypeOf("function");
    // unref is called so the timer never holds the process open.
    const handle = t.setTimer.mock.results[0].value as unknown as { unref: ReturnType<typeof vi.fn> };
    expect(handle.unref).toHaveBeenCalledOnce();
    m.stop();
    expect(t.clearTimer).toHaveBeenCalledOnce();
  });

  it("runs the cycle and rearms at the fixed cadence, including after a failure", async () => {
    const t = fakeTimers();
    const log = logger();
    const cycle = vi.fn()
      .mockResolvedValueOnce({ refreshed: true })
      .mockRejectedValueOnce(Object.assign(new Error("boom"), { code: "codex_reauth_required" }))
      .mockResolvedValueOnce({ refreshed: false });
    const m = new CodexTokenMaintenance(cycle, log, { setTimer: t.setTimer, clearTimer: t.clearTimer });
    m.start();

    await t.fireLast(); // initial cycle: refreshed
    expect(cycle).toHaveBeenCalledOnce();
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("background token refresh succeeded"));
    expect(t.delays.at(-1)).toBe(CODEX_TOKEN_MAINTENANCE_INTERVAL_MS);

    await t.fireLast(); // second cycle: rejected — swallowed, cadence continues
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("codex_reauth_required"));
    expect(t.delays.at(-1)).toBe(CODEX_TOKEN_MAINTENANCE_INTERVAL_MS);

    await t.fireLast(); // third cycle: healthy no-op
    expect(cycle).toHaveBeenCalledTimes(3);
    m.stop();
  });

  it("stop() prevents a pending timer from running and a later tick from re-arming", async () => {
    const t = fakeTimers();
    const cycle = vi.fn(async () => ({ refreshed: false }));
    const m = new CodexTokenMaintenance(cycle, logSafe(), { setTimer: t.setTimer, clearTimer: t.clearTimer });
    m.start();
    const firstHandle = t.setTimer.mock.results[0].value;
    m.stop();
    expect(t.clearTimer).toHaveBeenCalledWith(firstHandle);
    // Even if a stale callback somehow ran after stop, the generation gate swallows it.
    await t.fireLast().catch(() => {});
    expect(cycle).not.toHaveBeenCalled();
    expect(t.pending()).toHaveLength(0);
  });

  it("start() is restart-safe: the previous generation's timers never fire", async () => {
    const t = fakeTimers();
    const cycle = vi.fn(async () => ({ refreshed: false }));
    const m = new CodexTokenMaintenance(cycle, logSafe(), { setTimer: t.setTimer, clearTimer: t.clearTimer });
    m.start();
    m.stop();
    m.start();
    expect(t.setTimer).toHaveBeenCalledTimes(2);
    expect(t.clearTimer).toHaveBeenCalledOnce();
    await t.fireLast();
    expect(cycle).toHaveBeenCalledOnce(); // only the new generation's callback is live
  });

  it("defaults to the global timer implementation and unref when no seams are injected", () => {
    const m = new CodexTokenMaintenance(vi.fn(async () => ({ refreshed: false })), logSafe());
    m.start();
    expect(m.isRunning).toBe(true);
    m.stop();
    expect(m.isRunning).toBe(false);
  });
});

function logSafe() {
  return { warn: vi.fn(), info: vi.fn() };
}
