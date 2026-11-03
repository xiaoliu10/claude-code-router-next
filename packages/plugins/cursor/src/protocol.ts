import type { PluginClassifiedError } from "./core-types";

/**
 * The one Cursor account per CCR process, the way upstream runs it. Everything
 * that names the managed entry, the private credential file and the admin
 * route base lives here so no call site spells the strings twice.
 */

/** Managed provider name in the CCR config (qoder parity: "<family>-subscription"). */
export const CURSOR_PROVIDER = "cursor-subscription";
/** Placeholder credential the managed provider carries instead of a key. */
export const CURSOR_MARKER = "ccr-managed-cursor";
/** Private credential file inside the host config dir (configDir root). */
export const CURSOR_CREDENTIAL_FILE = "cursor-credentials.json";
/** Admin route base; the card reaches it through the host's plugin bridge. */
export const CURSOR_ROUTE_BASE = "/api/cursor";
/** The single transformer name the managed entry locks into its use-chain. */
export const CURSOR_TRANSFORMER = "cursor";

/**
 * Safe error codes the admin surface may return verbatim. Anything else
 * collapses to cursor_request_failed; an upstream 401 NEVER becomes a
 * "login invalid" code — it is cursor_reauth_required (account kept, sign in
 * again), exactly like the data plane classifies it.
 */
export const CURSOR_SAFE_CODES = new Set([
  "cursor_unauthorized",
  "cursor_not_connected",
  "cursor_already_connected",
  "cursor_reauth_required",
  "cursor_login_busy",
  "cursor_login_pending",
  "cursor_login_cancelled",
  "cursor_login_failed",
  "cursor_credential_invalid",
  "cursor_credential_unreadable",
  "cursor_persist_failed",
  "cursor_config_write_failed",
  "cursor_provider_name_conflict",
  "cursor_rate_limited",
  "cursor_region_restricted",
  "cursor_permission_denied",
  "cursor_invalid_request",
  "cursor_unavailable",
  "cursor_upstream_error",
  "cursor_request_failed",
]);

export function cursorError(code: string, status = 422): Error & { code: string; statusCode: number } {
  return Object.assign(new Error(code), { code, statusCode: status, nonRetryable: true });
}

/** Managed-entry recognition: the locked name wins; legacy flag/marker forms count too. */
export function isCursorManaged(p: any): boolean {
  const name = p?.name;
  if (name === CURSOR_PROVIDER) {
    return p?.cursor_managed === true || p?.cursorManaged === true || (p?.api_key ?? p?.apiKey) === CURSOR_MARKER;
  }
  return p?.cursor_managed === true || p?.cursorManaged === true;
}

/** Re-lock ONE managed entry: pinned upstream marker, single-transformer chain. */
export function lockCursorProvider(p: any): any {
  return { ...p, name: CURSOR_PROVIDER, cursor_managed: true, cursorManaged: true,
    api_base_url: "https://api2.cursor.sh", api_key: CURSOR_MARKER, transformer: { use: [CURSOR_TRANSFORMER] } };
}

/**
 * The protector: every managed entry in the incoming config is re-locked in
 * place, and a managed entry that vanished is re-added from the previous
 * config. A hand-edited marker/URL can never send real credentials through
 * the ordinary-provider path.
 */
export function protectCursorConfig(next: any, previous: any): void {
  if (!next || typeof next !== "object") return;
  const key = Array.isArray(next?.providers) && !Array.isArray(next?.Providers) ? "providers" : "Providers";
  const old = (previous?.Providers ?? previous?.providers ?? []) as any[];
  const list: any[] = Array.isArray(next[key]) ? next[key] : [];
  next[key] = list.map((p: any) => (isCursorManaged(p) || p?.name === CURSOR_PROVIDER ? lockCursorProvider(p) : p));
  const previousEntry = old.find(o => isCursorManaged(o));
  if (previousEntry && !next[key].some((p: any) => isCursorManaged(p) || p?.name === CURSOR_PROVIDER)) {
    next[key].push(lockCursorProvider(previousEntry));
  }
}

/** Reconcile the managed entry into the UI's config draft. */
export function mergeCursorProvider(current: any, server: any): any {
  const next = { ...current };
  const key = Array.isArray(current?.providers) && !Array.isArray(current?.Providers) ? "providers" : "Providers";
  const managed = (server?.Providers ?? server?.providers ?? []).find((p: any) => isCursorManaged(p));
  const list = [...(current?.[key] ?? [])];
  const at = list.findIndex((p: any) => isCursorManaged(p) || p?.name === CURSOR_PROVIDER);
  if (at >= 0) { if (managed) list[at] = managed; else list.splice(at, 1); }
  else if (managed && !list.some(p => p?.name === CURSOR_PROVIDER)) list.push(managed);
  next[key] = list;
  return next;
}

/**
 * Error taxonomy (shared with managed-runtime.classifyError and the
 * transformer's stream-frame classification). Input is the evidence the
 * engine's errorResponse carries: an HTTP status plus the JSON body
 * `{ error: { message, type: "cursor_error", code: <status> } }`, or a bare
 * SSE error frame `{ error: { message, code } }` inside a 200 stream.
 *
 * The wording rules mirror the vendored engine's statusOf/failure (its tests
 * pin them); the CODES are CCR's, so the core's shared taxonomy can act on
 * them. An upstream 401 is auth-required — never "credentials invalid", and
 * a team-region refusal is its own code, never auth.
 */
const DEFAULT_429_COOLDOWN_MS = 5 * 60_000;
const COOLDOWN_CAP_MS = 3_600_000;

export function classifyCursorError(status: number, body: unknown): PluginClassifiedError {
  let hint: any = body;
  let raw = "";
  if (typeof body === "string") {
    raw = body;
    try { hint = JSON.parse(body); } catch { hint = undefined; }
  }
  let message = "";
  let code = "";
  if (hint && typeof hint === "object") {
    const e = hint.error && typeof hint.error === "object" ? hint.error : hint;
    message = String(e?.message ?? "");
    code = String(e?.code ?? "");
  }
  const numeric = Number(code);
  if (Number.isFinite(numeric) && numeric >= 400 && numeric <= 599 && !status) status = numeric;
  const low = `${message} ${raw}`.toLowerCase();
  const out = (info: Partial<PluginClassifiedError> & { code: string; httpStatus: number }): PluginClassifiedError => ({
    retryable: false, ...info, message: info.code,
  });
  // Cursor serves some teams in specific regions only; signing in again
  // cannot change that, so it must never read as an auth failure.
  if (low.includes("region")) return out({ code: "cursor_region_restricted", httpStatus: 403 });
  if (status === 401 || code === "unauthenticated" || low.includes("expired")) {
    return out({ code: "cursor_reauth_required", httpStatus: 401 });
  }
  if (status === 429 || code === "resource_exhausted" || low.includes("quota") || low.includes("rate limit") || low.includes("usage limit")) {
    return out({ code: "cursor_rate_limited", httpStatus: 429, cooldownMs: DEFAULT_429_COOLDOWN_MS, retryable: false });
  }
  if (code === "permission_denied" || status === 403) return out({ code: "cursor_permission_denied", httpStatus: 403 });
  if (status === 400 || code === "invalid_argument" || low.includes("too long") || low.includes("context length") || low.includes("too many tokens")) {
    return out({ code: "cursor_invalid_request", httpStatus: 400 });
  }
  if (status === 503 || code === "unavailable") return out({ code: "cursor_unavailable", httpStatus: 503, retryable: true });
  const httpStatus = status >= 400 && status <= 599 ? status : 502;
  return out({ code: "cursor_upstream_error", httpStatus, retryable: httpStatus >= 500 });
}

/** Cooldowns are latched to one hour — the windows themselves reset upstream. */
export function clampCursorCooldown(ms: number | undefined): number {
  return Math.min(Math.max(Number(ms) || DEFAULT_429_COOLDOWN_MS, 0), COOLDOWN_CAP_MS);
}
