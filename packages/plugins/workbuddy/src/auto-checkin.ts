import type { WorkBuddyCheckinResult } from "./checkin";

export interface WorkBuddyAutoCheckinState {
  lastAttemptAt: string;
  lastAttemptDate: string;
  lastResult: { outcome: WorkBuddyCheckinResult["outcome"]; at: string };
  /** Retries already attempted after the first failure of this local day. */
  retryCount: number;
}

export function localCheckinDate(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Whitelist the non-secret state before it enters the store or admin payload. */
export function normalizeAutoCheckin(value: unknown): WorkBuddyAutoCheckinState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const s = value as WorkBuddyAutoCheckinState;
  if (typeof s.lastAttemptAt !== "string" || !Number.isFinite(Date.parse(s.lastAttemptAt)) ||
      typeof s.lastAttemptDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s.lastAttemptDate) ||
      !s.lastResult || !["claimed", "done", "inactive", "ineligible", "failed"].includes(s.lastResult.outcome) ||
      typeof s.lastResult.at !== "string" || !Number.isFinite(Date.parse(s.lastResult.at)) ||
      !Number.isInteger(s.retryCount) || s.retryCount < 0 || s.retryCount > 5) return undefined;
  return { lastAttemptAt: s.lastAttemptAt, lastAttemptDate: s.lastAttemptDate,
    lastResult: { outcome: s.lastResult.outcome, at: s.lastResult.at }, retryCount: s.retryCount };
}

interface AutoCheckinOptions {
  load(): Promise<WorkBuddyAutoCheckinState | undefined>;
  update(transform: (previous: WorkBuddyAutoCheckinState | undefined) => WorkBuddyAutoCheckinState): Promise<WorkBuddyAutoCheckinState>;
  attempt(): Promise<unknown>;
  logger: { warn(message: string): void };
  random?: () => number;
}

/** One timer per service. coreApi=1 has no dispose; disable/uninstall converges on restart. */
export class WorkBuddyAutoCheckin {
  private timer?: ReturnType<typeof setTimeout>;
  private enabled = false;
  private generation = 0;
  constructor(private readonly options: AutoCheckinOptions) {}

  stop(): void {
    this.enabled = false;
    this.generation++;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  async scheduleAutoCheckin(): Promise<void> {
    this.stop();
    this.enabled = true;
    const generation = this.generation;
    try {
      const state = await this.options.load();
      if (this.enabled && generation === this.generation) this.schedule(state);
    } catch {
      this.options.logger.warn("WorkBuddy automatic check-in state could not be loaded");
      if (this.enabled && generation === this.generation) this.arm(this.jitter(1, 10));
    }
  }

  /** Used by the manual service method too, including its offline failures. */
  async execute<T extends WorkBuddyCheckinResult>(attempt: () => Promise<T>): Promise<T> {
    let result: T;
    try { result = await attempt(); }
    catch (error) {
      await this.record("failed");
      throw error;
    }
    await this.record(result.outcome);
    return result;
  }

  private async record(outcome: WorkBuddyCheckinResult["outcome"]): Promise<void> {
    const now = new Date(), today = localCheckinDate(now), at = now.toISOString();
    try {
      const state = await this.options.update(previous => ({
        lastAttemptAt: at, lastAttemptDate: today, lastResult: { outcome, at },
        retryCount: previous?.lastAttemptDate === today && previous.lastResult.outcome === "failed"
          ? Math.min(5, previous.retryCount + 1) : 0,
      }));
      if (this.enabled) this.schedule(state);
    } catch {
      this.options.logger.warn("WorkBuddy automatic check-in state could not be saved");
      if (this.enabled) this.schedule({ lastAttemptAt: at, lastAttemptDate: today,
        lastResult: { outcome, at }, retryCount: 5 });
    }
  }

  private jitter(minMinutes: number, maxMinutes: number): number {
    return (minMinutes + (maxMinutes - minMinutes) * (this.options.random ?? Math.random)()) * 60_000;
  }

  private schedule(state?: WorkBuddyAutoCheckinState): void {
    const now = new Date();
    if (state?.lastAttemptDate !== localCheckinDate(now)) return this.arm(this.jitter(1, 10));
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
    const nextDay = midnight + this.jitter(0, 45);
    if (state.lastResult.outcome === "failed" && state.retryCount < 5) {
      const retryAt = Date.parse(state.lastAttemptAt) + this.jitter(25, 35);
      if (retryAt < midnight) return this.arm(Math.max(0, retryAt - now.getTime()));
    }
    this.arm(nextDay - now.getTime());
  }

  private arm(delay: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      this.timer = undefined;
      try { await this.options.attempt(); }
      catch { this.options.logger.warn("WorkBuddy automatic check-in failed"); }
    }, delay);
    this.timer.unref?.();
  }
}
