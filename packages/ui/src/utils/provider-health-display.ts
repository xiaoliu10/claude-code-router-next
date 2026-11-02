/**
 * Framework-free helpers for rendering provider health failures on the home
 * page. Kept out of the .tsx component so node --test can exercise them
 * directly (the UI test lane strips types but cannot import JSX).
 */

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
