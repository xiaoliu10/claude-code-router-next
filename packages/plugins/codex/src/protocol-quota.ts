/**
 * Codex quota types — the DATA-LANE source of truth for rate-limit shape.
 *
 * Supervisor ruling (2026-10-23): the parse helpers and these types live in the
 * data lane; the auth lane only implements bookkeeping. The auth lane's
 * `protocol.ts` therefore re-exports (or imports) these two interfaces rather
 * than redefining them — see `CodexServiceLike` in `./protocol.ts`.
 *
 * Wire evidence (research codex-dataplane.md §3.3, magpie
 * internal/gateway/codex_limits.go):
 *  - headers `x-codex-{primary,secondary}-used-percent`,
 *    `-window-minutes`, `-reset-at` (seconds) with `-reset-after-seconds` as
 *    the fallback;
 *  - a `codex.rate_limits` SSE event ahead of the reply with
 *    `{rate_limits:{primary:{used_percent,window_minutes,reset_at},secondary:…}}`,
 *    where `metered_limit_name` other than "codex" names a MODEL-level limit
 *    and must be ignored for account cooldown.
 *
 * Window widths are data-driven (seconds), never hard-coded 5h/weekly.
 */

export interface CodexRateLimitWindow {
  /** 0..100 (magpie reports percent, not a ratio). */
  usedPercent: number;
  /** Window width in seconds (`window_minutes * 60` when only minutes are given). */
  windowSeconds?: number;
  /** Absolute reset instant, epoch ms. */
  resetAt?: number;
}

export interface CodexRateLimits {
  primary?: CodexRateLimitWindow;
  secondary?: CodexRateLimitWindow;
  /** When the observation was made, epoch ms. Later wins on conflict. */
  observedAt: number;
  /** Which channel produced this observation. */
  source: "headers" | "sse";
}

/**
 * Merge two observations of the same account. Contract (ruling B):
 * "同一次响应里两者冲突时取 observedAt 更晚者、resetAt 更远者".
 *
 *  - the later `observedAt`/`source` wins for attribution;
 *  - for EACH window, a later `resetAt` wins (the pessimistic, longer park);
 *    when one side has no resetAt the defined one wins; `usedPercent` follows
 *    the same later-observed side so percent and reset never disagree.
 *
 * Exposed for the auth lane's bookkeeping and pinned by tests.
 */
export function mergeCodexRateLimits(previous: CodexRateLimits | null | undefined, next: CodexRateLimits): CodexRateLimits {
  if (!previous) return next;
  const later = next.observedAt >= previous.observedAt ? next : previous;
  const pick = (which: "primary" | "secondary"): CodexRateLimitWindow | undefined => {
    const latest = later[which];
    const other = later === next ? previous[which] : next[which];
    if (!latest) return other;
    if (!other) return latest;
    // usedPercent follows the LATER observation (current state); resetAt the
    // FURTHEST known (the window cannot free up sooner than the later side says).
    const furthestReset = Math.max(
      typeof latest.resetAt === "number" ? latest.resetAt : -Infinity,
      typeof other.resetAt === "number" ? other.resetAt : -Infinity,
    );
    const windowSeconds = latest.windowSeconds ?? other.windowSeconds;
    return {
      usedPercent: latest.usedPercent,
      ...(windowSeconds !== undefined ? { windowSeconds } : {}),
      ...(Number.isFinite(furthestReset) ? { resetAt: furthestReset } : {}),
    };
  };
  const primary = pick("primary");
  const secondary = pick("secondary");
  return {
    observedAt: later.observedAt,
    source: later.source,
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
  };
}
