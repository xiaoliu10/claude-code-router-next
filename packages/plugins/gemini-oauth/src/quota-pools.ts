/**
 * Independent quota pools — which model shares which upstream allowance.
 *
 * Antigravity does NOT serve every model from one allowance: the account this
 * plugin was built against has separate Argon, Hydrogen and Claude pools, so a
 * quota refusal from one of them must park only that pool. Upstream sharing is
 * plan-dependent (antigravity-cli#1399: Google AI Pro reports a distinct
 * "GEMINI 4 ARGON" weekly group next to "GEMINI MODELS"), so nothing here
 * claims a universal layout: the three confirmed pools are named explicitly,
 * and every other model isolates conservatively under its own normalized
 * family id. Two models are never merged because their percentages match.
 *
 * The summary groups a quota snapshot carries are upstream-owned display
 * figures: they keep their own group identity and are NEVER reassigned to the
 * independent pools below (see protocol.geminiQuotaToProviderQuota for the
 * legacy worst-pool summary).
 *
 * Pure helpers only — the durable lock table lives in the credential file and
 * is read/written by GeminiOauthAuthService.
 */
import { splitAntigravityId, type GeminiOauthQuotaSnapshot } from "./protocol";

/** The confirmed independent pools. Claude variants share one Claude pool. */
export const GEMINI_OAUTH_ARGON_POOL = "gemini-4-argon";
export const GEMINI_OAUTH_HYDROGEN_POOL = "gemini-4-hydrogen";
export const GEMINI_OAUTH_CLAUDE_POOL = "claude";

/**
 * Locks are advisory derived state, so the table stays small enough that a
 * credential file can never grow without bound through error bookkeeping.
 */
export const GEMINI_OAUTH_MAX_POOL_LOCKS = 64;

/**
 * The pool a model spends from, or "" when the model cannot be attributed
 * (empty/blank/non-string). Effort variants fold into their family first, so
 * `gemini-4-argon-high` and `gemini-4-argon-low` share the Argon pool while
 * `gemini-4-hydrogen` and plain `gemini-4` stay separate.
 */
export function geminiOauthQuotaPool(model: unknown): string {
  if (typeof model !== "string") return "";
  const id = model.trim().toLowerCase();
  if (!isPoolKey(id)) return "";
  const { family } = splitAntigravityId(id);
  for (const pool of [GEMINI_OAUTH_ARGON_POOL, GEMINI_OAUTH_HYDROGEN_POOL]) {
    if (family === pool) return pool;
  }
  if (/^claude(?:-|$)/.test(family)) return GEMINI_OAUTH_CLAUDE_POOL;
  return family;
}

/** A pool key is a normalized model family id: bounded, no control chars, no
 *  comma (the credential file's model-id grammar). */
function isPoolKey(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f,]/.test(value);
}

/**
 * Whitelist the persisted lock table: pool id → epoch ms until which that pool
 * is parked. Unlike the user's hide preference, a malformed entry is DROPPED
 * rather than rejecting the whole credential — a corrupt lock must never
 * disconnect a working account. Overflow keeps the longest-lived locks (ties
 * by key) so the bound is deterministic.
 */
export function normalizeGeminiOauthPoolLocks(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const entries: Array<[string, number]> = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isPoolKey(key)) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue;
    const pool = geminiOauthQuotaPool(key);
    if (pool) entries.push([pool, Math.floor(value)]);
  }
  if (!entries.length) return undefined;
  entries.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const out: Record<string, number> = Object.create(null);
  for (const [pool, until] of entries) {
    if (Object.keys(out).length >= GEMINI_OAUTH_MAX_POOL_LOCKS) break;
    out[pool] = Math.max(out[pool] ?? 0, until);
  }
  return out;
}

/** Drop expired locks. A live lock is never shortened or removed here. */
export function pruneGeminiOauthPoolLocks(locks: Record<string, number>, now: number): Record<string, number> {
  const out: Record<string, number> = Object.create(null);
  for (const [pool, until] of Object.entries(locks)) {
    if (typeof until === "number" && until > now) out[pool] = until;
  }
  return out;
}

/**
 * Positive quota evidence for one model: a per-model bucket that resolves to
 * the SAME pool and still has headroom. Used by the recovery probe, where a
 * successful model-list call proves reachability but says nothing about the
 * allowance of the model being probed. Missing/unknown buckets are absence of
 * proof, never proof of headroom, and summary groups are not per-model evidence.
 */
export function geminiOauthPoolHasQuota(
  snapshot: GeminiOauthQuotaSnapshot | null | undefined,
  model: string
): boolean {
  const pool = geminiOauthQuotaPool(model);
  if (!pool || !snapshot) return false;
  for (const [id, bucket] of Object.entries(snapshot.models ?? {})) {
    if (geminiOauthQuotaPool(id) !== pool) continue;
    const remaining = bucket?.remaining;
    // Any bucket with headroom is positive evidence for this shared pool;
    // a zeroed variant alone is not proof that the whole pool recovered.
    if (typeof remaining === "number" && Number.isFinite(remaining) && remaining > 0) return true;
  }
  return false;
}
