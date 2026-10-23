/**
 * Codex UI-card payload types and pure view helpers. SELF-CONTAINED: the card
 * never imports host runtime modules (only `type PluginCardMountProps`, which
 * is erased at build), never touches tokens — the admin API surface is
 * summary-only and every shape below is a redacted behavioural subset the
 * server assigns role-free (docs/design/provider-plugins.md §5/§7).
 *
 * Quota is expressed as plan + rate-limit WINDOWS (primary/secondary: percent
 * used, window length, epoch-ms reset) — never token counts.
 */

/** Fixed managed provider name (never a user's generic provider named codex). */
export const CODEX_PROVIDER_NAME = "codex-subscription";
/** CCR marker api_key; a managed entry never carries a real key. */
export const CODEX_MARKER_KEY = "ccr-codex-managed";

export type CodexConnectionState = "not_connected" | "connected" | "expired" | "error";

/** GET /status — redacted status (no tokens, no ids beyond the masked view). */
export interface CodexStatusView {
  status: CodexConnectionState;
  providerName: string;
  accountId?: string;
  email?: string;
  plan?: string;
  models: string[];
  modelCount: number;
  coolingUntil?: number;
  lastError?: string | null;
}

export type CodexLoginMode = "callback" | "paste";

/** POST /login/start. `mode:"paste"` means CCR does not own the callback
 * port and the user must paste the redirected callback URL back. */
export interface CodexLoginStartView {
  loginId: string;
  url: string;
  expiresAt: number;
  mode: CodexLoginMode;
  redirectUri: string;
}

/** POST /login/poll and POST /login/complete. `error` is a stable code. */
export interface CodexLoginPollView {
  status: "pending" | "connected" | "cancelled" | "expired" | "error";
  error?: string;
  models?: string[];
  modelCount?: number;
}

/** One rate-limit window (primary ≈ 5h, secondary ≈ weekly — data-driven). */
export interface CodexUsageWindowView {
  usedPercent: number;
  windowSeconds: number;
  resetAt: number;
}

/** POST /usage — plan + windows only; tokens never appear here or in cache. */
export interface CodexUsageView {
  plan: string;
  primary?: CodexUsageWindowView;
  secondary?: CodexUsageWindowView;
}

/** POST /sync and POST /disconnect. `error` is a stable code. */
export interface CodexMutationView {
  success: boolean;
  error?: string;
  models?: string[];
  modelCount?: number;
}

// ---------------------------------------------------------------------------
// Guards / parsers (fail closed to null — the card falls back to generic copy)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const models: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0 || item.length > 200) return null;
    models.push(item);
  }
  return models;
}

export function parseCodexStatus(value: unknown): CodexStatusView | null {
  if (!isRecord(value)) return null;
  const status = value.status;
  if (status !== "not_connected" && status !== "connected" && status !== "expired" && status !== "error") return null;
  const models = stringArray(value.models);
  if (!models) return null;
  const modelCount = finiteNumber(value.modelCount);
  const next: CodexStatusView = {
    status,
    providerName: typeof value.providerName === "string" && value.providerName ? value.providerName : CODEX_PROVIDER_NAME,
    models,
    modelCount: modelCount ?? models.length,
  };
  if (typeof value.accountId === "string" && value.accountId) next.accountId = value.accountId;
  if (typeof value.email === "string" && value.email) next.email = value.email;
  if (typeof value.plan === "string" && value.plan) next.plan = value.plan;
  const coolingUntil = finiteNumber(value.coolingUntil);
  if (coolingUntil !== null) next.coolingUntil = coolingUntil;
  if (typeof value.lastError === "string") next.lastError = value.lastError;
  return next;
}

export function parseCodexLoginStart(value: unknown): CodexLoginStartView | null {
  if (!isRecord(value)) return null;
  const { loginId, url, expiresAt, mode, redirectUri } = value as Partial<CodexLoginStartView>;
  if (typeof loginId !== "string" || !loginId || loginId.length > 256) return null;
  if (typeof url !== "string" || !url) return null;
  // The authorization page must be https — defence in depth against a
  // compromised start response redirecting the browser somewhere unsafe.
  try {
    if (new URL(url).protocol !== "https:") return null;
  } catch {
    return null;
  }
  const expiry = finiteNumber(expiresAt);
  if (expiry === null) return null;
  if (mode !== "callback" && mode !== "paste") return null;
  if (typeof redirectUri !== "string" || !redirectUri) return null;
  return { loginId, url, expiresAt: expiry, mode, redirectUri };
}

export function parseCodexLoginPoll(value: unknown): CodexLoginPollView | null {
  if (!isRecord(value)) return null;
  const status = value.status;
  if (status !== "pending" && status !== "connected" && status !== "cancelled" && status !== "expired" && status !== "error") return null;
  const next: CodexLoginPollView = { status };
  if (typeof value.error === "string") next.error = value.error;
  const models = stringArray(value.models);
  if (models) next.models = models;
  const modelCount = finiteNumber(value.modelCount);
  if (modelCount !== null) next.modelCount = modelCount;
  return next;
}

export function parseCodexUsage(value: unknown): CodexUsageView | null {
  if (!isRecord(value)) return null;
  const plan = typeof value.plan === "string" ? value.plan : "";
  const next: CodexUsageView = { plan };
  for (const key of ["primary", "secondary"] as const) {
    const raw = value[key];
    if (raw === undefined || raw === null) continue;
    if (!isRecord(raw)) return null;
    const usedPercent = finiteNumber(raw.usedPercent);
    const windowSeconds = finiteNumber(raw.windowSeconds);
    const resetAt = finiteNumber(raw.resetAt);
    if (usedPercent === null || windowSeconds === null || resetAt === null) return null;
    next[key] = { usedPercent, windowSeconds, resetAt };
  }
  // A payload with neither window carries no displayable quota.
  if (!next.primary && !next.secondary) return null;
  return next;
}

export function parseCodexMutation(value: unknown): CodexMutationView {
  if (!isRecord(value)) return { success: false };
  const next: CodexMutationView = { success: value.success === true };
  if (typeof value.error === "string") next.error = value.error;
  const models = stringArray(value.models);
  if (models) next.models = models;
  const modelCount = finiteNumber(value.modelCount);
  if (modelCount !== null) next.modelCount = modelCount;
  return next;
}

/**
 * Only a well-formed stable code may cross into the rendered error surface
 * (same contract as the host's sanitizePluginErrorCode). Anything else —
 * upstream sentences, markup, secrets — collapses to the generic failure.
 */
export function sanitizeCodexErrorCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) return null;
  return value;
}

/** Whether the value renders as a localized usage note (never an error). */
export function isCodexUsageFailure(value: unknown): boolean {
  return value === null;
}

// ---------------------------------------------------------------------------
// View state
// ---------------------------------------------------------------------------

export type CodexCardState = "loading" | "not_connected" | "connected" | "cooldown" | "needs_relogin" | "error";

/** Cooldown wins over a stale error: the account is parked, not broken.
 * An expired session always means needs_relogin. */
export function codexStateKey(status: CodexStatusView | null, now: number = Date.now()): CodexCardState {
  if (!status) return "loading";
  if (status.status === "expired") return "needs_relogin";
  if (typeof status.coolingUntil === "number" && status.coolingUntil > now) return "cooldown";
  if (status.status === "connected") return "connected";
  if (status.status === "error") return "error";
  return "not_connected";
}

/** Whether the account currently has a usable session. */
export function codexConnected(status: CodexStatusView | null, now: number = Date.now()): boolean {
  return codexStateKey(status, now) === "connected";
}

/** Localised clock for cooldown/reset lines; null when nothing to show. */
export function formatCodexClock(value: number | null | undefined, language: string | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  try {
    return new Date(value).toLocaleString(language || undefined, {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return null;
  }
}

export type CodexWindowUnit = "minutes" | "hours" | "days";

/** Window length is data-driven (never hardcode 5h/weekly); name by division. */
export function codexWindowUnit(windowSeconds: number): { unit: CodexWindowUnit; count: number } {
  const seconds = Number.isFinite(windowSeconds) && windowSeconds > 0 ? windowSeconds : 0;
  if (seconds > 0 && seconds % 86_400 === 0) return { unit: "days", count: seconds / 86_400 };
  if (seconds > 0 && seconds % 3_600 === 0) return { unit: "hours", count: seconds / 3_600 };
  return { unit: "minutes", count: Math.max(1, Math.round(seconds / 60)) };
}

/** Display-only account id mask: never the full identifier. */
export function maskCodexAccountId(value: string | null | undefined): string | null {
  if (typeof value !== "string" || !value) return null;
  if (value.length <= 10) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

/**
 * A callback URL the user pasted is only worth submitting when it parses,
 * speaks http(s) and carries both code and state query parameters. The server
 * re-validates strictly (one-use state) — this is UX triage, not security.
 */
export function isValidCodexCallbackUrl(value: unknown): boolean {
  if (typeof value !== "string" || !value || value.length > 2048) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  return typeof parsed.searchParams.get("code") === "string"
    && typeof parsed.searchParams.get("state") === "string"
    && parsed.searchParams.get("code") !== ""
    && parsed.searchParams.get("state") !== "";
}

// ---------------------------------------------------------------------------
// Managed-provider reconciliation (mirror of the gemini/workbuddy card merge)
// ---------------------------------------------------------------------------

function isCodexManagedProvider(provider: unknown): boolean {
  if (!provider || typeof provider !== "object") return false;
  const value = provider as Record<string, unknown>;
  if (value.codex_managed === true) return true;
  if (value.name !== CODEX_PROVIDER_NAME) return false;
  const marker = value.api_key ?? value.apiKey;
  return marker === CODEX_MARKER_KEY;
}

/**
 * Reconcile the managed provider into the local draft after a status/sync/
 * login change: only the entry CCR manages is added, replaced or removed;
 * Router, drafts and ordinary providers always survive untouched.
 */
export function mergeCodexProvider<
  C extends { Providers?: unknown[] },
  S extends { Providers?: unknown[] },
>(local: C, server: S): C {
  const providers = [...(local.Providers || [])];
  const managed = (server.Providers || []).find(provider => isCodexManagedProvider(provider));
  const index = providers.findIndex(provider => isCodexManagedProvider(provider));
  if (index >= 0) {
    if (managed) providers[index] = managed;
    else providers.splice(index, 1);
  } else if (managed && !providers.some(provider =>
    (provider as Record<string, unknown> | null)?.name === CODEX_PROVIDER_NAME)) {
    providers.push(managed);
  }
  return { ...local, Providers: providers };
}

// ---------------------------------------------------------------------------
// Session quota cache (sessionStorage, valid values only, TTL)
// ---------------------------------------------------------------------------

export const CODEX_USAGE_CACHE_KEY = "codex-usage-cache-v1";
export const CODEX_USAGE_CACHE_TTL_MS = 10 * 60_000;

interface CachedUsage { value: CodexUsageView; at: number }
interface UsageCacheShape { savedAt: number; entry: CachedUsage | null }

function readUsageStore(): UsageCacheShape {
  try {
    const raw = (globalThis as any).sessionStorage?.getItem(CODEX_USAGE_CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && "entry" in parsed) return parsed as UsageCacheShape;
    }
  } catch { /* unavailable or corrupt */ }
  return { savedAt: 0, entry: null };
}

function writeUsageStore(store: UsageCacheShape): void {
  try { (globalThis as any).sessionStorage?.setItem(CODEX_USAGE_CACHE_KEY, JSON.stringify(store)); } catch { /* unavailable */ }
}

export interface FreshCodexUsage { value: CodexUsageView; at: number }

/** A fresh, structurally valid cached usage — or undefined (must re-read). */
export function freshCodexUsage(now: number = Date.now()): FreshCodexUsage | undefined {
  const hit = readUsageStore().entry;
  if (!hit || typeof hit.at !== "number" || !Number.isFinite(hit.at) || hit.at > now) return undefined;
  if (now - hit.at > CODEX_USAGE_CACHE_TTL_MS) return undefined;
  // Storage is untrusted; validate before trusting.
  const value = parseCodexUsage(hit.value);
  return value ? { value, at: hit.at } : undefined;
}

/** Only VALID usage is cached — failures and nulls never suppress a retry. */
export function rememberCodexUsage(value: CodexUsageView | null, now: number = Date.now()): void {
  if (!value) return;
  writeUsageStore({ savedAt: now, entry: { value, at: now } });
}

export function clearCodexUsageCache(): void {
  try { (globalThis as any).sessionStorage?.removeItem(CODEX_USAGE_CACHE_KEY); } catch { /* unavailable */ }
}
