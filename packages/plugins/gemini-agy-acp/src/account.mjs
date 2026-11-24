/** Bounded account-email helpers for the oauth-personal login verification.
 * The ONLY accepted provenance is the just-verified ACP handshake of the
 * selected binary: explicit ACP account metadata or the verifying child's own
 * captured diagnostics. Stale CLI log files, keychain/token stores and other
 * processes' state are never read; only a validated email string travels
 * onward — never tokens or raw diagnostics. */

const MAX_EMAIL_CHARS = 254;
// First pattern wins: the structured login line beats the plain success line,
// and within one text the first occurrence is used.
const EMAIL_PATTERNS = [
  /applyAuthResult: email=([^,\s"']+)/,
  /authenticated successfully as ([^\s,"']+)/,
];
const EMAIL_SHAPE = /^[^\s@,;:<>"']+@[^\s@,;:<>"']+$/;

/** A display-safe, bounded email-ish string (≤254 chars, exactly one @, no
 * whitespace or control characters). */
export function accountEmailShapeOk(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_EMAIL_CHARS &&
    EMAIL_SHAPE.test(value) && !/[\0-\x1f\x7f]/.test(value);
}

/** Scan captured handshake text for the account email; null when the text
 * carries no email-shaped login line. */
export function extractAccountEmail(text) {
  if (typeof text !== 'string') return null;
  for (const pattern of EMAIL_PATTERNS) {
    const email = pattern.exec(text)?.[1];
    if (accountEmailShapeOk(email)) return email;
  }
  return null;
}
