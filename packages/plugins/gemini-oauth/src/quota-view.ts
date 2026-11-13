/**
 * Structural view layer for the independent-pools quota card.
 *
 * The wire snapshot is the backend's `GeminiOauthQuotaSnapshot`
 * (`{ models: Record<string,{remaining,resetAt?}>, pools: Array<{pool,window,remaining,resetAt?}> }`),
 * but this module deliberately takes `unknown`: the route contract is the
 * boundary, and an older/newer host, a malformed payload or extra backend
 * metadata must never crash the card. Everything is validated here, and
 * anything unrecognized is dropped rather than guessed at.
 *
 * Display rules (docs/design/gemini-independent-pools.md):
 *  - per-model buckets carry NO window label of their own — the upstream 5h/
 *    weekly labels belong only to the grouped summary pools and are never
 *    reassigned to an individual model;
 *  - Argon, Hydrogen and Claude identities are kept distinct; unknown models
 *    are isolated by their own family instead of being merged via broad
 *    prefixes or equal percentages;
 *  - effort variants (…-low/-medium/-high/…) fold into their family ONLY when
 *    every member reports the same figure, and the row stays explicitly
 *    multi-variant;
 *  - missing/non-numeric/expired data is "unavailable", never zero usage or a
 *    full allowance.
 */

/** One validated per-model quota figure. */
export interface QuotaModelFigure {
  remaining: number;
  resetAt?: string;
}

/** One validated upstream summary group figure. */
export interface QuotaPoolFigure {
  pool: string;
  window: string;
  remaining: number;
  resetAt?: string;
}

/** The narrow shape the card consumes; extra backend fields stay tolerated. */
export interface QuotaSnapshotView {
  models: Record<string, QuotaModelFigure>;
  pools: QuotaPoolFigure[];
}

// Mirrors the service's model-id grammar (bounded string, no comma); ids are
// rendered via textContent only, so the remaining guard is just control
// characters and whitespace — never a stricter guess that could drop a valid
// future model id as "unavailable".
const MODEL_ID_PATTERN = /^[^\x00-\x1f\x7f,\s]{1,256}$/;
const LABEL_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}\s.&'()/+-]{0,99}$/u;
const WINDOW_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,31}$/;

/** A reset string is usable only when it parses to a finite, present-or-future
 *  instant. An expired reset means the upstream figure itself is stale. */
function liveResetAt(value: unknown, nowMs: number): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || ms <= nowMs) return undefined;
  return new Date(ms).toISOString();
}

function finiteFraction(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  // Strings coerce only when they actually encode a number: Number(null) and
  // Number("") are both 0, which would turn a missing figure into "exhausted".
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/**
 * Validate an untrusted route payload into the structural view, or return null
 * when it is not a snapshot at all. An empty-but-well-formed snapshot is a
 * valid answer ("no figures available"); a wrongly shaped payload is not.
 */
export function parseQuotaSnapshot(input: unknown, nowMs: number = Date.now()): QuotaSnapshotView | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const rawModels = record.models;
  const rawPools = record.pools;
  if ((rawModels !== undefined && (typeof rawModels !== "object" || rawModels === null || Array.isArray(rawModels)))
    || (rawPools !== undefined && !Array.isArray(rawPools))) {
    return null;
  }
  const models: Record<string, QuotaModelFigure> = {};
  for (const [id, bucket] of Object.entries((rawModels ?? {}) as Record<string, unknown>)) {
    if (!MODEL_ID_PATTERN.test(id) || !bucket || typeof bucket !== "object" || Array.isArray(bucket)) continue;
    const remaining = finiteFraction((bucket as Record<string, unknown>).remaining);
    if (remaining === undefined) continue; // missing/non-numeric: unavailable, not zero
    const resetAt = liveResetAt((bucket as Record<string, unknown>).resetAt, nowMs);
    models[id] = { remaining, ...(resetAt ? { resetAt } : {}) };
  }
  const pools: QuotaPoolFigure[] = [];
  for (const entry of rawPools ?? []) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const group = entry as Record<string, unknown>;
    const pool = typeof group.pool === "string" ? group.pool.trim() : "";
    const windowLabel = typeof group.window === "string" ? group.window.trim() : "";
    const remaining = finiteFraction(group.remaining);
    if (!pool || !LABEL_PATTERN.test(pool) || !windowLabel || !WINDOW_PATTERN.test(windowLabel) || remaining === undefined) continue;
    const resetAt = liveResetAt(group.resetAt, nowMs);
    pools.push({ pool, window: windowLabel, remaining, ...(resetAt ? { resetAt } : {}) });
  }
  return { models, pools };
}

/** The effort suffixes the upstream Antigravity model grammar uses
 *  (mirrors splitAntigravityId; duplicated here to keep the card chunk free
 *  of the node-only protocol module). */
const EFFORT_SUFFIXES = ["-extra-high", "-extra-low", "-xhigh", "-minimal", "-low", "-medium", "-high"];

/** `gemini-4-argon-high` → `gemini-4-argon`; ids without an effort suffix stay
 *  themselves. Identity folding only — no cross-family inference. */
export function quotaModelFamily(id: string): string {
  for (const suffix of EFFORT_SUFFIXES) {
    if (id.endsWith(suffix) && id.length > suffix.length) return id.slice(0, -suffix.length);
  }
  return id;
}

export type QuotaPoolIdentity = "argon" | "hydrogen" | "claude" | "other";

/** Conservative identity: only an explicit token in the model id classifies a
 *  bucket. Everything else stays "other" and is never merged by a broad
 *  startsWith("gemini") rule. */
export function quotaPoolIdentity(id: string): QuotaPoolIdentity {
  const lower = id.toLowerCase();
  if (lower.includes("argon")) return "argon";
  if (lower.includes("hydrogen")) return "hydrogen";
  if (lower.includes("claude")) return "claude";
  return "other";
}

export interface QuotaModelRow {
  /** Family id rendered to the user (effort suffix stripped when folded). */
  family: string;
  /** Distinct Argon / Hydrogen / Claude / unknown grouping, never merged. */
  identity: QuotaPoolIdentity;
  remaining: number;
  resetAt?: string;
  /** Set when the row folds several effort variants with identical figures. */
  variants: string[];
}

function sameFigure(a: QuotaModelFigure, b: QuotaModelFigure): boolean {
  return a.remaining === b.remaining && (a.resetAt ?? null) === (b.resetAt ?? null);
}

/**
 * Build the render rows for per-model buckets. Effort variants fold into one
 * family row ONLY while every variant's figure is identical; the smallest
 * differing figure otherwise wins for the family and all original ids remain
 * visible as their own rows. A family id and its variant ids never split into
 * duplicate rows.
 */
export function buildQuotaModelRows(view: QuotaSnapshotView): QuotaModelRow[] {
  const groups = new Map<string, Array<{ id: string; figure: QuotaModelFigure }>>();
  for (const [id, figure] of Object.entries(view.models)) {
    const family = quotaModelFamily(id);
    const members = groups.get(family) ?? [];
    members.push({ id, figure });
    groups.set(family, members);
  }
  const rows: QuotaModelRow[] = [];
  for (const [family, members] of groups) {
    const reference = members[0].figure;
    const identical = members.length > 1 && members.every(member => sameFigure(member.figure, reference));
    if (identical) {
      rows.push({
        family,
        identity: quotaPoolIdentity(family),
        remaining: reference.remaining,
        ...(reference.resetAt ? { resetAt: reference.resetAt } : {}),
        variants: members.map(member => member.id).sort(),
      });
      continue;
    }
    // Diverging (or single) figures: keep every original id, and let the most
    // depleted figure represent the family ordering without hiding the rest.
    for (const member of members) {
      rows.push({
        family: member.id,
        identity: quotaPoolIdentity(family),
        remaining: member.figure.remaining,
        ...(member.figure.resetAt ? { resetAt: member.figure.resetAt } : {}),
        variants: [],
      });
    }
  }
  rows.sort((a, b) => {
    const rank: Record<QuotaPoolIdentity, number> = { argon: 0, hydrogen: 1, claude: 2, other: 3 };
    if (rank[a.identity] !== rank[b.identity]) return rank[a.identity] - rank[b.identity];
    if (a.remaining !== b.remaining) return a.remaining - b.remaining;
    return a.family.localeCompare(b.family);
  });
  return rows;
}

/** Summary groups in stable display order: upstream pool name, then window. */
export function buildQuotaPoolRows(view: QuotaSnapshotView): QuotaPoolFigure[] {
  return [...view.pools].sort((a, b) =>
    (a.pool.localeCompare(b.pool)) || (a.window.localeCompare(b.window)));
}

/** 0–100 whole-percent remaining for a fraction the upstream reported. */
export function formatQuotaPercent(remaining: number): string {
  const pct = Math.round(remaining * 100);
  return `${Math.min(100, Math.max(0, pct))}%`;
}
