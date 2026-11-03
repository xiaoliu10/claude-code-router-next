import type { QoderCheckinResult } from "./checkin";

export interface AutoCheckinState {
  lastAttemptAt: string;
  lastAttemptDate: string;
  retryCount: number;
  lastResult: { outcome: QoderCheckinResult["outcome"]; at: string };
}
export interface AutoCheckinOptions {
  enabled: () => boolean;
  state: () => AutoCheckinState | undefined;
  persist: (state: AutoCheckinState) => Promise<void>;
  /** Calls the service's checkin(), which records manual and automatic results alike. */
  checkin: () => Promise<QoderCheckinResult>;
  log?: { warn(message: string): void };
  rand?: () => number;
}

export const localCheckinDate = (date = new Date()): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

/** Optional metadata is validated separately from the secret credential fields. */
export function validAutoCheckinState(value: any): value is AutoCheckinState {
  const iso = (v: unknown) => typeof v === "string" && /^\d{4}-\d\d-\d\dT/.test(v) && Number.isFinite(Date.parse(v));
  return value != null && iso(value.lastAttemptAt) &&
    typeof value.lastAttemptDate === "string" && /^\d{4}-\d\d-\d\d$/.test(value.lastAttemptDate) &&
    Number.isInteger(value.retryCount) && value.retryCount >= 0 && value.retryCount <= 5 &&
    iso(value.lastResult?.at) && value.lastResult.at === value.lastAttemptAt &&
    ["claimed", "done", "inactive", "ineligible", "failed"].includes(value.lastResult.outcome);
}

const MINUTE = 60_000;
// A repeated plugin activation replaces the previous owner's timer for this file.
// coreApi=1 has no dispose hook: disabling/uninstalling converges on restart.
interface AutoCheckinOwner {
  owner: QoderAutoCheckin;
  state?: AutoCheckinState;
  running?: Promise<void>;
}
const owners = new Map<string, AutoCheckinOwner>();

export class QoderAutoCheckin {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  constructor(private readonly key: string, private readonly options: AutoCheckinOptions) {}

  scheduleAutoCheckin(): void {
    if (this.stopped || !this.options.enabled()) return;
    let shared = owners.get(this.key);
    if (!shared) {
      shared = { owner: this, state: this.options.state() };
      owners.set(this.key, shared);
    } else if (shared.owner !== this) {
      shared.owner.stopped = true;
      shared.owner.clearTimer();
      shared.owner = this;
    }
    // Ownership includes the pending request and its result, not just the timer.
    if (this.timer || shared.running) return;
    const now = new Date();
    const state = shared.state;
    let at: number;
    if (state?.lastAttemptDate !== localCheckinDate(now)) {
      at = now.getTime() + this.jitter(1, 10) * MINUTE;
    } else {
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
      at = midnight + this.jitter(0, 45) * MINUTE;
      if (state.lastResult.outcome === "failed" && state.retryCount < 5) {
        const retry = Date.parse(state.lastAttemptAt) + this.jitter(25, 35) * MINUTE;
        // A retry belongs to its original local day; midnight starts a new budget.
        if (retry < midnight) at = Math.min(at, Math.max(now.getTime(), retry));
      }
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.attempt();
    }, Math.max(0, at - now.getTime()));
    this.timer.unref();
  }

  async recordResult(result: QoderCheckinResult): Promise<void> {
    if (!this.options.enabled()) return;
    this.scheduleAutoCheckin();
    const shared = owners.get(this.key);
    if (!shared || !shared.owner.options.enabled()) return;
    const now = new Date();
    const date = localCheckinDate(now);
    const previous = shared.state;
    const at = now.toISOString();
    const state: AutoCheckinState = {
      lastAttemptAt: at, lastAttemptDate: date,
      retryCount: previous?.lastAttemptDate === date ? Math.min(previous.retryCount + 1, 5) : 0,
      lastResult: { outcome: result.outcome, at },
    };
    // Keep the budget in memory even if disk writes fail, avoiding a tight retry loop.
    shared.state = state;
    shared.owner.clearTimer();
    // Old admin routes remain callable after activation replaces their service.
    // Persist through the current owner so its account/card state sees the result.
    let target: QoderAutoCheckin;
    do {
      target = shared.owner;
      try { await target.options.persist(state); }
      catch { target.options.log?.warn("Qoder auto check-in state could not be saved"); }
    } while (target !== shared.owner && owners.get(this.key) === shared);
    if (result.outcome === "failed") shared.owner.options.log?.warn("Qoder check-in failed");
    shared.owner.clearTimer();
    shared.owner.scheduleAutoCheckin();
  }

  cancel(): void {
    this.clearTimer();
    if (owners.get(this.key)?.owner === this) owners.delete(this.key);
  }

  stop(): void {
    this.stopped = true;
    this.cancel();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
  private jitter(min: number, max: number): number {
    return min + (this.options.rand ?? Math.random)() * (max - min);
  }
  private async attempt(): Promise<void> {
    const shared = owners.get(this.key);
    if (this.stopped || !this.options.enabled() || shared?.owner !== this || shared.running) return;
    shared.running = Promise.resolve().then(async () => {
      try { await this.options.checkin(); }
      catch { await this.recordResult({ outcome: "failed" }); }
    }).finally(() => {
      shared.running = undefined;
      if (owners.get(this.key) === shared) shared.owner.scheduleAutoCheckin();
    });
    await shared.running;
  }
}
