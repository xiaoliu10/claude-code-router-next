/**
 * Background access-token maintenance.
 *
 * The v2.3.9 core used to run a 30-minute `startCodexTokenRefreshScheduler`;
 * the plugin migration (commit a38ff63) removed it together with the legacy
 * account manager, leaving on-demand refresh as the only renewal path. A
 * machine with no Codex traffic therefore never rotated its tokens until the
 * next request, and any renewal hiccup was first discovered by the user on
 * that request — experienced as "the login keeps dropping".
 *
 * This scheduler restores proactive renewal inside the plugin:
 *  - first cycle shortly after activation (so a restart converges quickly),
 *    then a fixed 30-minute cadence, both timers `unref()`ed so they never
 *    keep the process alive on their own;
 *  - every cycle delegates to `CodexAuthService.runTokenMaintenanceCycle`,
 *    which reuses the 5-minute lead + single-flight refresh: a healthy token
 *    costs no network at all;
 *  - a failed cycle is logged and swallowed. Maintenance must NEVER write
 *    lastError/cooldown — account health is owned exclusively by the data
 *    plane, and a sticky `codex_reauth_required` still surfaces on the next
 *    real request or card status read;
 *  - the cadence survives a transient rejection (the next cycle still arms);
 *  - `stop()` is idempotent and generation-checked, so a stale timer callback
 *    from a previous start cannot run a cycle after stop/restart.
 *
 * Timers are injectable so tests stay deterministic without relying on the
 * global fake clock interacting with the service's own timeouts.
 */

export const CODEX_TOKEN_MAINTENANCE_INITIAL_MS = 60_000;
export const CODEX_TOKEN_MAINTENANCE_INTERVAL_MS = 30 * 60_000;

export interface CodexTokenMaintenanceResult {
  refreshed: boolean;
}

export interface CodexTokenMaintenanceLogger {
  warn(message: string): void;
  info?(message: string): void;
}

export interface CodexTokenMaintenanceOptions {
  initialDelayMs?: number;
  intervalMs?: number;
  /** Test seam: defaults to global setTimeout. */
  setTimer?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  /** Test seam: defaults to global clearTimeout. */
  clearTimer?: (handle: NodeJS.Timeout) => void;
}

export class CodexTokenMaintenance {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private generation = 0;

  private readonly setTimer: NonNullable<CodexTokenMaintenanceOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<CodexTokenMaintenanceOptions["clearTimer"]>;
  private readonly initialDelayMs: number;
  private readonly intervalMs: number;

  constructor(
    private readonly cycle: () => Promise<CodexTokenMaintenanceResult>,
    private readonly logger: CodexTokenMaintenanceLogger,
    options: CodexTokenMaintenanceOptions = {},
  ) {
    this.setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
    this.initialDelayMs = options.initialDelayMs ?? CODEX_TOKEN_MAINTENANCE_INITIAL_MS;
    this.intervalMs = options.intervalMs ?? CODEX_TOKEN_MAINTENANCE_INTERVAL_MS;
  }

  start(): void {
    this.stop();
    this.running = true;
    const generation = this.generation;
    this.arm(this.initialDelayMs, generation);
  }

  stop(): void {
    this.running = false;
    this.generation++;
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
  }

  get isRunning(): boolean {
    return this.running;
  }

  private arm(delayMs: number, generation: number): void {
    const handle = this.setTimer(() => {
      this.timer = undefined;
      void this.tick(generation);
    }, delayMs);
    // A maintenance timer must never hold the process open by itself.
    (handle as { unref?: () => void }).unref?.();
    this.timer = handle;
  }

  private async tick(generation: number): Promise<void> {
    if (!this.running || generation !== this.generation) return;
    try {
      const result = await this.cycle();
      if (result?.refreshed) {
        this.logger.info?.("[codex] background token refresh succeeded");
      }
    } catch (error: any) {
      // Deliberately does NOT touch lastError/cooldown: bookkeeping health is
      // the data plane's job, and the next real request retries on demand.
      this.logger.warn(
        `[codex] background token maintenance failed: ${error?.code ?? error?.message ?? "unknown"}`,
      );
    } finally {
      if (this.running && generation === this.generation) {
        this.arm(this.intervalMs, generation);
      }
    }
  }
}

/**
 * Module-level owner for the single live maintenance loop.
 *
 * coreApi=1 has no deactivate/dispose hook, and the production registry
 * already rejects a duplicate activation, so double activation is unreachable
 * today. The singleton nevertheless makes a future hot reload / same-process
 * reinstall safe: the previous activation's loop (holding a stale service
 * closure) is stopped instead of two unref'ed 30-minute timers running side by
 * side. Same constraint and pattern as qoder's module-level owners Map.
 */
let currentMaintenance: CodexTokenMaintenance | undefined;

export function replaceCodexTokenMaintenance(next: CodexTokenMaintenance): void {
  if (currentMaintenance && currentMaintenance !== next) currentMaintenance.stop();
  currentMaintenance = next;
}

/** Test seam: drop the module-level owner without touching a running loop. */
export function resetCodexTokenMaintenanceForTests(): void {
  currentMaintenance = undefined;
}
