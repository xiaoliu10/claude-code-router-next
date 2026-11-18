import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodexTokenMaintenance,
  CODEX_TOKEN_MAINTENANCE_INITIAL_MS,
  CODEX_TOKEN_MAINTENANCE_INTERVAL_MS,
  replaceCodexTokenMaintenance,
  resetCodexTokenMaintenanceForTests,
} from "../src/token-maintenance";

/** Deterministic timer harness: records every armed delay and fires manually. */
function fakeTimers() {
  const handles: Array<{ cb: () => void; fired: boolean; unref: ReturnType<typeof vi.fn> }> = [];
  const delays: number[] = [];
  const setTimer = vi.fn((cb: () => void, delayMs: number) => {
    const handle = { cb, fired: false, unref: vi.fn() };
    handles.push(handle);
    delays.push(delayMs);
    return handle as unknown as NodeJS.Timeout;
  });
  const clearTimer = vi.fn((handle: NodeJS.Timeout) => {
    (handle as unknown as { fired: boolean }).fired = true; // cleared handles are marked dead
  });
  return {
    setTimer,
    clearTimer,
    delays,
    handles,
    pending: () => handles.filter((h) => !h.fired),
    /** Fire a handle even when it was cleared — the stale-callback boundary. */
    fire: async (handle: { cb: () => void }) => { await handle.cb(); },
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

  it("stop() prevents a pending timer from running and a stale post-clear callback is swallowed", async () => {
    const t = fakeTimers();
    const cycle = vi.fn(async () => ({ refreshed: false }));
    const m = new CodexTokenMaintenance(cycle, logSafe(), { setTimer: t.setTimer, clearTimer: t.clearTimer });
    m.start();
    const armed = t.handles[0];
    m.stop();
    expect(t.clearTimer).toHaveBeenCalledWith(armed);
    // Platform quirk: the cleared timer's callback still fires. The running +
    // generation gate must swallow it — no cycle execution and no re-arm.
    await t.fire(armed);
    expect(cycle).not.toHaveBeenCalled();
    expect(t.pending()).toHaveLength(0);
    expect(t.setTimer).toHaveBeenCalledTimes(1); // never re-armed by the stale tick
  });

  it("start() is restart-safe: the previous generation's timers never fire", async () => {
    const t = fakeTimers();
    const cycle = vi.fn(async () => ({ refreshed: false }));
    const m = new CodexTokenMaintenance(cycle, logSafe(), { setTimer: t.setTimer, clearTimer: t.clearTimer });
    m.start();
    const first = t.handles[0];
    m.stop();
    m.start();
    expect(t.setTimer).toHaveBeenCalledTimes(2);
    expect(t.clearTimer).toHaveBeenCalledOnce();
    // The old generation's handle firing late must do nothing.
    await t.fire(first);
    expect(cycle).not.toHaveBeenCalled();
    // Only the live (new generation) callback runs the cycle.
    await t.fireLast();
    expect(cycle).toHaveBeenCalledOnce();
  });

  it("replaceCodexTokenMaintenance stops the previous owner's loop", () => {
    resetCodexTokenMaintenanceForTests();
    const t = fakeTimers();
    const make = () => new CodexTokenMaintenance(vi.fn(async () => ({ refreshed: false })), logSafe(),
      { setTimer: t.setTimer, clearTimer: t.clearTimer });
    const first = make();
    const second = make();
    first.start();
    replaceCodexTokenMaintenance(first);
    second.start();
    replaceCodexTokenMaintenance(second);
    expect(first.isRunning).toBe(false); // hot-reload replacement stops the stale loop
    expect(second.isRunning).toBe(true);
    resetCodexTokenMaintenanceForTests();
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
