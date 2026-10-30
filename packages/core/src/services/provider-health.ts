import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { HOME_DIR } from "@wengine-ai/claude-code-router-shared";

/**
 * Provider health state for circuit breaker pattern
 */
export interface ProviderHealthState {
  provider: string;
  model: string;
  status: 'closed' | 'open' | 'half-open';
  failureCount: number;
  successCount: number;
  lastFailureTime: number;
  lastProbeTime: number;
  lastError?: string;
  /** Epoch ms before which a rate-limited model should NOT be probed or used.
   *  Set by markRateLimited(); cleared on expiry (auto-recover) or on explicit recovery. */
  rateLimitUntil?: number;
}

interface PersistedProviderHealthState extends ProviderHealthState {
  updatedAt: number;
}

/** Default retry-after seconds for rate-limited models when no Retry-After header is present. */
const DEFAULT_RATE_LIMIT_RETRY_AFTER_SECONDS = 120;
/** Extend a still-rate-limited probe by this many additional seconds. */
const RATE_LIMIT_EXTEND_SECONDS = 120;


/**
 * Configuration for health pool behavior
 */
export interface HealthPoolConfig {
  enabled?: boolean;
  failureThreshold?: number;
  probeIntervalMinutes?: number;
  halfOpenSuccessThreshold?: number;
}

const DEFAULT_CONFIG: Required<HealthPoolConfig> = {
  enabled: true,
  failureThreshold: 3,
  probeIntervalMinutes: 5,
  halfOpenSuccessThreshold: 2,
};

/**
 * Provider health store implementing circuit breaker pattern
 * Tracks provider/model health and manages state transitions
 */
export class ProviderHealthStore {
  private states: Map<string, ProviderHealthState> = new Map();
  private config: Required<HealthPoolConfig>;
  private probeTimer?: NodeJS.Timeout;

  constructor(config?: HealthPoolConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Build the composite key used to index provider/model state.
   * Returns null when either part is empty, which signals the caller to
   * short-circuit (skip the operation) instead of creating a bogus entry like
   * ",model" or "provider," that would pollute the health pool.
   */
  private getKey(provider: string, model: string): string | null {
    if (!provider || !model) return null;
    return `${provider},${model}`;
  }

  /**
   * Record a successful request
   * Transitions: open -> half-open (if probe), half-open -> closed (if threshold reached)
   */
  recordSuccess(provider: string, model: string): void {
    if (!this.config.enabled) return;

    const key = this.getKey(provider, model);
    if (!key) return;
    let state = this.states.get(key);

    if (!state) {
      return; // No state means model is healthy (closed)
    }

    state.successCount++;

    // Rate-limited models must NOT be recovered by a generic models-endpoint probe.
    // They can only be recovered by the dedicated rate-limit recovery probe
    // (runRateLimitProbe) which sends real chat requests.
    // An EXPIRED cooldown no longer gates recovery: while still open, a real
    // success transitions open → half-open exactly like a probe success, so a
    // subsequent success closes the breaker. Without this, an expired
    // rateLimitUntil (presence-only check) left the model stuck "open" forever
    // for managed providers that generic probes skip (workbuddy/codex/gemini).
    if (state.rateLimitUntil && state.rateLimitUntil > Date.now()) {
      return;
    }
    const expiredCooldown = !!state.rateLimitUntil;
    state.rateLimitUntil = undefined;

    if (state.status === 'half-open') {
      if (state.successCount >= this.config.halfOpenSuccessThreshold) {
        // Transition to closed (fully healthy)
        // Clear any fallback promotions that were created because this primary failed
        this.clearPromotionsForPrimary(provider, model);
        this.states.delete(key);
      }
    } else if (state.status === 'open') {
      // This is a probe success
      state.status = 'half-open';
      state.successCount = 1;
      state.failureCount = 0;
    }
    // half-open → closed for a model whose cooldown had expired: a second real
    // success fully recovers it (same threshold semantics as probe recovery).
    if (expiredCooldown && state.status === 'half-open' && state.successCount >= this.config.halfOpenSuccessThreshold) {
      this.clearPromotionsForPrimary(provider, model);
      this.states.delete(key);
    }
  }

  /**
   * Clear fallback promotions when a primary model recovers to healthy state
   * Uses dynamic import to avoid circular dependency
   */
  private clearPromotionsForPrimary(provider: string, model: string): void {
    try {
      // Dynamic require to avoid circular dependency at module load time
      // fallback-promotion.ts imports from this file
      const { getFallbackPromotionStore } = require('../utils/fallback-promotion');
      getFallbackPromotionStore().clearByPrimary(provider, model);
    } catch {
      // Ignore if promotion store not available
    }
  }

  /**
   * Record a failed request
   * Transitions: closed -> open (if threshold), half-open -> open (immediate)
   */
  recordFailure(provider: string, model: string, error?: string): void {
    if (!this.config.enabled) return;

    const key = this.getKey(provider, model);
    if (!key) return;
    let state = this.states.get(key);

    if (!state) {
      // New failure tracking - start from closed state
      state = {
        provider,
        model,
        status: 'closed',
        failureCount: 0,
        successCount: 0,
        lastFailureTime: 0,
        lastProbeTime: 0,
      };
      this.states.set(key, state);
    }

    state.failureCount++;
    state.lastFailureTime = Date.now();
    state.lastError = error;

    if (state.status === 'half-open') {
      // Immediate transition back to open on any failure in half-open
      state.status = 'open';
      state.successCount = 0;
      state.lastProbeTime = 0;
    } else if (state.status === 'closed' && state.failureCount >= this.config.failureThreshold) {
      // Transition to open (fail pool)
      state.status = 'open';
      state.lastProbeTime = 0;
    }
  }

  /**
   * Get current health state for a provider/model
   */
  getState(provider: string, model: string): ProviderHealthState | undefined {
    const key = this.getKey(provider, model);
    if (!key) return undefined;
    return this.states.get(key);
  }

  /**
   * Check if a provider/model is available for routing
   * closed = available, half-open = available (lower priority), open = unavailable
   */
  isAvailable(provider: string, model: string, allowRecoveryProbe = false): boolean {
    if (!this.config.enabled) return true;

    const key = this.getKey(provider, model);
    if (!key) return false;

    const state = this.getState(provider, model);
    if (!state) return true; // No state = closed (healthy)

    // Rate-limited model: check if cooldown has expired → auto-recover
    if (state.status === 'open' && state.rateLimitUntil) {
      if (Date.now() < state.rateLimitUntil) {
        return false; // Still rate-limited
      }
      // Cooldown expired — model is now available.
      // Do NOT delete the state entry here — the quota probe guard
      // (active-probe.ts) checks s?.rateLimitUntil before calling forceOpen,
      // and if we delete it the guard would miss, causing forceOpen to
      // overwrite with failureCount=3, rateLimitUntil=null.
      // Cleanup is handled by runRateLimitProbe (every 2 min).
      return true;
    }

    // Managed subscriptions cannot use unauthenticated background probes.
    // After the normal retry interval, let one real routed request probe the
    // original model. Never bypass an active quota lock (handled above).
    if (state.status === 'open' && allowRecoveryProbe &&
        Date.now() - Math.max(state.lastFailureTime, state.lastProbeTime) >= this.config.probeIntervalMinutes * 60_000) {
      state.status = 'half-open';
      state.successCount = 0;
      state.lastProbeTime = Date.now();
      return true;
    }
    return state.status !== 'open';
  }

  /**
   * Get health status priority for sorting
   * Returns: 0 = closed (best), 1 = half-open (ok), 2 = open (worst)
   */
  getPriority(provider: string, model: string): number {
    if (!this.config.enabled) return 0;

    const key = this.getKey(provider, model);
    if (!key) return 2;

    const state = this.getState(provider, model);
    if (!state) return 0;
    switch (state.status) {
      case 'closed': return 0;
      case 'half-open': return 1;
      case 'open': return 2;
    }
  }

  /**
   * Get all models that are healthy (closed status)
   */
  getHealthyModels(): string[] {
    const healthy: string[] = [];
    // Models without state entry are healthy
    // We can't enumerate all models, so this returns empty
    // Router should check isAvailable() for each candidate instead
    return healthy;
  }

  /**
   * Get all models in fail pool (open status)
   */
  getFailPoolModels(): string[] {
    const failed: string[] = [];
    for (const [key, state] of this.states) {
      if (state.status === 'open') {
        failed.push(key);
      }
    }
    return failed;
  }

  /**
   * Stamp a background probe attempt without changing circuit state.
   *
   * Recovery probes need this: a failed probe must keep the model circuit-open
   * but move `lastProbeTime` forward, otherwise the interval gate in
   * isAvailable()/the probe loop would re-probe on every tick.
   */
  recordProbeAttempt(provider: string, model: string): void {
    if (!this.config.enabled) return;
    const key = this.getKey(provider, model);
    if (!key) return;
    const state = this.states.get(key);
    if (!state) return;
    state.lastProbeTime = Date.now();
  }

  /**
   * Park a model until the account's own reset epoch.
   *
   * A plugin that reports its quota window (e.g. `resets_at`) knows better than
   * a fixed probe interval when the account can answer again. Setting
   * `rateLimitUntil` keeps the model hidden from the list AND stops the recovery
   * probe from spending network calls on a known-parked account.
   */
  markParkedUntil(provider: string, model: string, until: number): void {
    if (!this.config.enabled) return;
    const key = this.getKey(provider, model);
    if (!key) return;
    const state = this.states.get(key);
    if (!state) return;
    if (!Number.isFinite(until) || until <= Date.now()) return;
    // Never shorten an existing lock.
    if (state.rateLimitUntil && state.rateLimitUntil >= until) return;
    state.rateLimitUntil = until;
  }

  /**
   * Get all models in half-open state
   */
  getHalfOpenModels(): string[] {
    const halfOpen: string[] = [];
    for (const [key, state] of this.states) {
      if (state.status === 'half-open') {
        halfOpen.push(key);
      }
    }
    return halfOpen;
  }

  /**
   * Immediately mark a provider/model as open (unavailable)
   * Used when fallback succeeds to prevent further requests to a failing primary
   */
  forceOpen(provider: string, model: string, error?: string): void {
    if (!this.config.enabled) return;

    const key = this.getKey(provider, model);
    if (!key) return;
    let state = this.states.get(key);

    if (!state) {
      state = {
        provider,
        model,
        status: 'open',
        failureCount: this.config.failureThreshold,
        successCount: 0,
        lastFailureTime: Date.now(),
        lastProbeTime: 0,
        lastError: error,
      };
      this.states.set(key, state);
    } else {
      state.status = 'open';
      state.failureCount = Math.max(state.failureCount, this.config.failureThreshold);
      state.lastFailureTime = Date.now();
      state.lastError = error;
      state.lastProbeTime = 0;
    }
    // forceOpen supersedes any rate-limit cooldown — e.g. when quota probe detects
    // exhaustion with a known reset time, we don't want auto-recover from a stale
    // rateLimitUntil to bypass the quota-probe recovery path.
  }

  /**
   * Immediately mark a provider/model as rate-limited (unavailable).
   * Sets a rateLimitUntil timestamp after which the model auto-recovers.
   * Does NOT increment failureCount so the generic circuit-breaker threshold
   * (used for network / unreachable failures) is preserved separately.
   */
  markRateLimited(provider: string, model: string, retryAfterSeconds?: number, error?: string): void {
    if (!this.config.enabled) return;

    const key = this.getKey(provider, model);
    if (!key) return;
    let state = this.states.get(key);

    if (!state) {
      state = {
        provider,
        model,
        status: 'open',
        failureCount: 0,
        successCount: 0,
        lastFailureTime: Date.now(),
        lastProbeTime: 0,
        lastError: error || 'rate-limited',
      };
      this.states.set(key, state);
    } else {
      state.status = 'open';
      state.lastFailureTime = Date.now();
      state.lastError = error || 'rate-limited';
      state.lastProbeTime = 0;
      // Do NOT increment failureCount — keep generic circuit-breaker separate
    }

    const retryAfterMs = (retryAfterSeconds ?? DEFAULT_RATE_LIMIT_RETRY_AFTER_SECONDS) * 1000;
    state.rateLimitUntil = Date.now() + retryAfterMs;
  }

  /**
   * Get all models currently in rate-limited state.
   * Returns keys in "provider,model" format.
   */
  getRateLimitedModels(): string[] {
    const result: string[] = [];
    for (const [key, state] of this.states) {
      if (state.status === 'open' && state.rateLimitUntil) {
        result.push(key);
      }
    }
    return result;
  }

  /**
   * Check if probe is needed for an open state
   * Returns true if probeInterval has elapsed since last probe
   */
  needsProbe(state: ProviderHealthState): boolean {
    const elapsed = Date.now() - state.lastProbeTime;
    return elapsed >= this.config.probeIntervalMinutes * 60 * 1000;
  }

  /**
   * Mark that a probe attempt has been made
   */
  markProbeAttempt(provider: string, model: string): void {
    const key = this.getKey(provider, model);
    if (!key) return;
    const state = this.states.get(key);
    if (state && state.status === 'open') {
      state.lastProbeTime = Date.now();
    }
  }

  /**
   * Clear all health state (for testing or manual reset)
   */
  clear(): void {
    this.states.clear();
  }

  /**
   * Recover a provider/model from health fail pool
   */
  recover(provider: string, model: string): void {
    const key = this.getKey(provider, model);
    if (!key) return;
    this.states.delete(key);
  }

  /**
   * Get all states for debugging/monitoring
   */
  getAllStates(): ProviderHealthState[] {
    return Array.from(this.states.values());
  }

  /**
   * Restore a previously persisted health state.
   */
  restore(state: ProviderHealthState): void {
    const key = this.getKey(state.provider, state.model);
    if (!key) return;
    this.states.set(key, { ...state });
  }

  /**
   * Stop probe timer
   */
  stopProbeTimer(): void {
    if (this.probeTimer) {
      clearInterval(this.probeTimer);
      this.probeTimer = undefined;
    }
  }
}

// --- Persistence ---

const RUNTIME_DIR = join(HOME_DIR, "runtime");
const PERSIST_FILE = join(RUNTIME_DIR, "provider-health.json");

let persistenceInitialized = false;
let saveTimer: ReturnType<typeof setInterval> | null = null;

function loadFromDisk(store: ProviderHealthStore): void {
  try {
    if (!existsSync(PERSIST_FILE)) return;
    const data = JSON.parse(readFileSync(PERSIST_FILE, "utf-8"));
    if (!Array.isArray(data)) return;

    const now = Date.now();
    for (const item of data as PersistedProviderHealthState[]) {
      if (!item || !item.provider || !item.model) continue;

      // Skip obviously stale entries so we do not resurrect old circuit-breaker
      // state forever after a long downtime.
      const ageSource = item.updatedAt || item.lastFailureTime || 0;
      if (ageSource && now - ageSource > 24 * 60 * 60 * 1000) continue;

      store.restore({
        provider: item.provider,
        model: item.model,
        status: item.status,
        failureCount: item.failureCount ?? 0,
        successCount: item.successCount ?? 0,
        lastFailureTime: item.lastFailureTime ?? 0,
        lastProbeTime: item.lastProbeTime ?? 0,
        lastError: item.lastError,
        rateLimitUntil: item.rateLimitUntil,
      });
    }
  } catch {
    // Corrupted file — start fresh
  }
}

function saveToDisk(store: ProviderHealthStore): void {
  try {
    const states = store.getAllStates();
    if (states.length === 0) return;

    if (!existsSync(RUNTIME_DIR)) {
      mkdirSync(RUNTIME_DIR, { recursive: true });
    }

    const payload: PersistedProviderHealthState[] = states.map((state) => ({
      ...state,
      updatedAt: Date.now(),
    }));

    writeFileSync(PERSIST_FILE, JSON.stringify(payload, null, 2), "utf-8");
  } catch {
    // Best-effort persistence
  }
}

/**
 * Initialize persistence: load from disk and set up periodic save.
 */
export function initProviderHealthPersistence(): void {
  if (persistenceInitialized) return;
  persistenceInitialized = true;

  const store = getHealthStore();
  loadFromDisk(store);

  saveTimer = setInterval(() => saveToDisk(store), 60_000);
  process.on("exit", () => saveToDisk(store));
}

// Singleton instance
let globalHealthStore: ProviderHealthStore | null = null;

export function getHealthStore(config?: HealthPoolConfig): ProviderHealthStore {
  if (!globalHealthStore) {
    globalHealthStore = new ProviderHealthStore(config);
  }
  return globalHealthStore;
}

export function resetHealthStore(): void {
  if (globalHealthStore) {
    globalHealthStore.stopProbeTimer();
    globalHealthStore = null;
  }
}
