/**
 * Framework-free helpers for rendering provider health failures on the home
 * page. Kept out of the .tsx component so node --test can exercise them
 * directly (the UI test lane strips types but cannot import JSX).
 */

/**
 * The slice of a health-state entry needed to decide failure staleness.
 * Structural on purpose: keeps this helper importable by the node --test lane
 * (no path aliases, no JSX).
 */
export interface FailureTimestamps {
  lastFailureTime?: number;
  lastSuccessTime?: number;
}

/**
 * Whether a recorded failure is stale "recovered residue": the same
 * provider/model entry has a success timestamp at or after the failure, so the
 * failed badge and error banner must be hidden and the card returns to its
 * normal state. Failure states are never auto-cleared server-side, so the UI
 * has to age them out.
 *
 * Missing timestamps keep the legacy behavior (failure stays visible):
 * - no lastSuccessTime (older server payloads): nothing to compare against;
 * - no lastFailureTime: legacy open/half-open badge rendering, unchanged.
 */
export function isFailureStale(entry: FailureTimestamps): boolean {
  if (entry.lastSuccessTime === undefined || entry.lastFailureTime === undefined) {
    return false;
  }
  // Only a failure strictly newer than the last success is still live; a
  // success at exactly the failure time counts as recovered.
  return entry.lastFailureTime <= entry.lastSuccessTime;
}

/**
 * Human-readable "last failure" stamp: HH:mm for today, full date+time
 * otherwise. Locale-independent so tests and both UI languages stay stable.
 * Returns "" for non-finite input so callers can skip rendering.
 */
export function formatFailureTime(ms: number, now: Date = new Date()): string {
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return "";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const hm = `${hh}:${mm}`;
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return hm;
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${day} ${hm}`;
}
