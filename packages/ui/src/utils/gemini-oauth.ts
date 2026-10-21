import type { GeminiOauthError, GeminiOauthKind, GeminiOauthStatusResponse, Provider } from "../types";

/** v1 provider name fixed by the contract (§1.4). */
export const GEMINI_OAUTH_PROVIDER_NAME = "gemini-oauth";
/** CCR's marker api_key; a managed entry never carries a real key. */
export const GEMINI_OAUTH_MARKER_KEY = "ccr-managed-gemini-oauth";
export const GEMINI_OAUTH_DEFAULT_KIND: GeminiOauthKind = "antigravity";

/**
 * Managed-provider detection for the Gemini subscription provider (contract
 * §1.4 + D7 parity with WorkBuddy). The strict `gemini_oauth_managed === true`
 * flag is authoritative; an entry persisted before the flag existed is still
 * ours when it carries CCR's own marker key, and a `gemini_oauth_kind` alone
 * proves ownership too. A user provider that merely reuses the name with a
 * real key matches none of these and stays user-owned.
 */
export function isManagedGeminiOauth(provider: unknown): boolean {
  if (!provider || typeof provider !== "object") return false;
  const value = provider as Partial<Provider> & Record<string, unknown>;
  const marker = value.api_key ?? value.apiKey;
  const kind = value.gemini_oauth_kind;
  if (value.gemini_oauth_managed === true) return true;
  if (value.name !== GEMINI_OAUTH_PROVIDER_NAME) return false;
  return marker === GEMINI_OAUTH_MARKER_KEY || isGeminiOauthKind(kind);
}

export function isGeminiOauthKind(value: unknown): value is GeminiOauthKind {
  return value === "antigravity";
}

/** Card state key: one of connected / cooldown / needs_relogin / error / not_connected. */
export type GeminiOauthStateKey = "not_connected" | "connected" | "cooldown" | "needs_relogin" | "error" | "loading";

/**
 * Cooldown wins over a stale error: the account is parked, not broken. A
 * reauth-required code always means needs_relogin whatever else arrived.
 */
export function geminiOauthStateKey(status: GeminiOauthStatusResponse | null, now: number = Date.now()): GeminiOauthStateKey {
  if (!status) return "loading";
  if (!status.connected) {
    if (status.lastError?.code === "gemini_oauth_reauth_required") return "needs_relogin";
    return status.lastError ? "error" : "not_connected";
  }
  if (typeof status.cooldownUntil === "number" && status.cooldownUntil > now) return "cooldown";
  if (status.lastError?.code === "gemini_oauth_reauth_required") return "needs_relogin";
  if (status.lastError) return "error";
  return "connected";
}

/** Whether the account currently has a usable session (connected and not parked). */
export function geminiOauthUsable(status: GeminiOauthStatusResponse | null, now: number = Date.now()): boolean {
  return geminiOauthStateKey(status, now) === "connected";
}

/** Localised clock for the cooldown line; null when nothing is parked. */
export function formatGeminiOauthClock(value: number | null | undefined, language: string | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  try {
    return new Date(value).toLocaleTimeString(language || undefined, { hour: "2-digit", minute: "2-digit" });
  } catch {
    return null;
  }
}

/** Codes the UI may render; anything else collapses to the generic failure. */
export const GEMINI_OAUTH_ERROR_CODES = [
  "gemini_oauth_identity_blocked",
  "gemini_oauth_validation_required",
  "gemini_oauth_quota_exceeded",
  "gemini_oauth_reauth_required",
  "gemini_oauth_upstream_error",
  "gemini_oauth_not_connected",
  "gemini_oauth_login_busy",
  "gemini_oauth_name_conflict",
  "gemini_oauth_login_state_rejected",
  "gemini_oauth_login_account_failed",
  "gemini_oauth_login_persist_failed",
  "gemini_oauth_models_fetch_failed",
  "gemini_oauth_config_write_failed",
] as const;

/** UI-only code for the local save/action mutex ("a save is running"). */
export type GeminiOauthUiErrorCode = "config_busy";

export type GeminiOauthErrorCodeSafe = (typeof GEMINI_OAUTH_ERROR_CODES)[number] | GeminiOauthUiErrorCode | "request_failed";

/**
 * Map any error-shaped value to a code the locale knows. Raw server text is
 * never rendered: unknown values (including token-bearing messages) collapse
 * to `request_failed`.
 */
export function geminiOauthErrorKey(error: unknown): GeminiOauthErrorCodeSafe {
  const candidate = typeof error === "string" ? error
    : error && typeof error === "object"
      ? (error as { reason?: unknown; error?: unknown; code?: unknown }).reason
        ?? (error as { error?: unknown }).error
        ?? (error as { code?: unknown }).code
      : null;
  return typeof candidate === "string" && (GEMINI_OAUTH_ERROR_CODES as readonly string[]).includes(candidate)
    ? candidate as GeminiOauthErrorCodeSafe
    : "request_failed";
}

/** Last error of a status payload, mapped to a renderable code. */
export function geminiOauthStatusErrorKey(status: GeminiOauthStatusResponse | null): GeminiOauthErrorCodeSafe | null {
  const error: GeminiOauthError | null | undefined = status?.lastError;
  if (!error) return null;
  return geminiOauthErrorKey(error);
}

/**
 * A validation URL is only rendered when it is a real https link (contract
 * §1.6: `validation_url` is forwarded, nothing else from the error body is).
 */
export function safeValidationUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * The frozen risk-consent copy lives in the locales (`geminiOauth.risk`);
 * this constant is the only key the dialog and the parity test use, so the
 * wording can never drift or be softened in one language.
 */
export const GEMINI_OAUTH_RISK_KEY = "geminiOauth.risk";

/**
 * Merge the managed provider into the local draft after a status/sync change,
 * mirroring `mergeWorkBuddyProvider`: only entries CCR manages are added,
 * replaced or removed; Router, drafts and ordinary providers always survive.
 */
export function mergeGeminiOauthProvider<C extends { Providers?: Provider[] }, S extends { Providers?: Provider[] }>(local: C, server: S): C {
  const providers = [...(local.Providers || [])];
  const managed = (server.Providers || []).find(provider => isManagedGeminiOauth(provider));
  const index = providers.findIndex(provider => isManagedGeminiOauth(provider));
  if (index >= 0) {
    if (managed) providers[index] = managed;
    else providers.splice(index, 1);
  } else if (managed && !providers.some(provider => provider.name === GEMINI_OAUTH_PROVIDER_NAME)) {
    providers.push(managed);
  }
  return { ...local, Providers: providers };
}
