import type { PluginClassifiedError } from "./core-types";

export const KIRO_PROVIDER = "kiro-subscription";
export const KIRO_MARKER = "ccr-managed-kiro";
export const DEFAULT_REGION = "us-east-1";
export const CALLBACK_PORTS = [3128, 4649, 6588, 8008, 9091, 49153, 50153, 51153, 52153, 53153] as const;
export const BUILDER_ID_START = "https://view.awsapps.com/start";
export const BUILDER_ID_PROFILE = "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX";
/** Kiro's service regions, nearest first, for profile discovery in profile order. */
export const KIRO_REGIONS = ["us-east-1", "eu-central-1"] as const;
export const KIRO_SCOPES = ["codewhisperer:completions", "codewhisperer:analysis", "codewhisperer:conversations", "codewhisperer:transformations", "codewhisperer:taskassist"];
export const KIRO_SITE = Object.freeze({ id: "kiro", label: "Kiro", provider: KIRO_PROVIDER, marker: KIRO_MARKER,
  credentialFile: "kiro-credentials.json", routeBase: "/api/kiro", web: "https://app.kiro.dev", chatUrl: "https://runtime.us-east-1.kiro.dev/generateAssistantResponse" });
export const KIRO_CHAT = KIRO_SITE.chatUrl;
export const kiroSite = () => KIRO_SITE;
export const runtimeURL = (region: string) => `https://runtime.${region}.kiro.dev`;
export const managementURL = (region: string) => `https://management.${region}.kiro.dev`;
export const oidcURL = (region: string) => `https://oidc.${region}.amazonaws.com`;
export const authURL = (region: string) => `https://prod.${region}.auth.desktop.kiro.dev`;
export const refreshURL = (region: string) => `${authURL(region)}/refreshToken`;
export const validRegion = (v: unknown): v is string => typeof v === "string" && /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/.test(v);
/**
 * Kiro serves an account in the region its profile ARN names
 * (`arn:aws:codewhisperer:<region>:<account>:profile/<name>`), never in the
 * region that happened to route the sign-in. Falls back to Kiro's nearest
 * region only when no usable ARN region is present.
 */
export function regionOf(profile: unknown, signedIn?: unknown): string {
  const parts = String(profile ?? "").split(":");
  if (parts.length > 4 && validRegion(parts[3])) return parts[3];
  return String(signedIn ?? "").startsWith("eu-") ? "eu-central-1" : DEFAULT_REGION;
}
/** Permanent OAuth failures an authorization server reports at a token endpoint. */
const PERMANENT_OAUTH_ERRORS = new Set(["invalid_grant", "invalid_client", "invalid_scope", "unauthorized_client", "invalid_token", "access_denied"]);
/**
 * Decides whether a non-2xx token/refresh answer ends the sign-in. Bounded and
 * code-only: the vendor's `error_description` never leaves this function.
 */
export function isPermanentOAuthFailure(status: number, body?: unknown): boolean {
  if (status === 401 || status === 403) return true;
  if (status !== 400) return false;
  const error = (body as { error?: unknown } | undefined)?.error;
  return typeof error === "string" && PERMANENT_OAUTH_ERRORS.has(error.toLowerCase());
}
export function validStartUrl(value: unknown): value is string {
  try { const u = new URL(String(value)); return u.protocol === "https:" && !u.username && !u.password && String(value).length <= 2048; } catch { return false; }
}
export function kiroError(code: string, statusCode = 422): Error & { code: string; statusCode: number } {
  return Object.assign(new Error(code), { code, statusCode, nonRetryable: true, ...(code === "kiro_reauth_required" ? { gone: true } : {}) });
}
export const KIRO_ERROR_CODES = ["kiro_unauthorized", "kiro_login_invalid", "kiro_login_unknown", "kiro_login_expired", "kiro_login_busy", "kiro_callback_invalid", "kiro_callback_ports_busy", "kiro_login_cancelled", "kiro_login_failed", "kiro_not_connected", "kiro_reauth_required", "kiro_account_cooling", "kiro_persist_failed", "kiro_config_write_failed", "kiro_provider_name_conflict", "kiro_credential_invalid", "kiro_credential_unreadable", "kiro_raw_config_required", "kiro_upstream_error", "kiro_rate_limited", "kiro_request_failed", "kiro_model_unknown"] as const;
// Config is a host-owned extensible JSON object; preserve unknown provider fields.
type Config = Record<string, any>;
export function isKiroManaged(p: Config | undefined): boolean {
  return !!p && (p.kiro_managed === true || p.kiroManaged === true || (p.api_key ?? p.apiKey) === KIRO_MARKER);
}
export function lockKiroProvider(p: Config): Config {
  return { ...p, name: KIRO_PROVIDER, kiro_managed: true, kiroManaged: true, api_base_url: KIRO_CHAT, api_key: KIRO_MARKER, transformer: { use: ["kiro"] } };
}
export function protectKiroConfig(next: Config, previous: Config): void {
  if (!next || typeof next !== "object") return;
  const key = Array.isArray(next.providers) && !Array.isArray(next.Providers) ? "providers" : "Providers";
  const old = (previous?.Providers ?? previous?.providers ?? []).find(isKiroManaged);
  next[key] = (next[key] ?? []).map((p: Config) => isKiroManaged(p) || (old && p.name === KIRO_PROVIDER) ? lockKiroProvider(p) : p);
  if (old && !next[key].some(isKiroManaged)) next[key].push(lockKiroProvider(old));
}
export function mergeKiroProvider(current: Config, server: Config): Config {
  const next = { ...current }, key = Array.isArray(current.providers) && !Array.isArray(current.Providers) ? "providers" : "Providers";
  const managed = (server.Providers ?? server.providers ?? []).find(isKiroManaged);
  const list = [...(current[key] ?? [])], at = list.findIndex(isKiroManaged);
  if (at >= 0) { if (managed) list[at] = managed; else list.splice(at, 1); }
  else if (managed && !list.some(p => p.name === KIRO_PROVIDER)) list.push(managed);
  next[key] = list; return next;
}
export function classifyKiroError(status: number, _body?: unknown): PluginClassifiedError {
  const code = status === 401 || status === 403 ? "kiro_reauth_required" : status === 429 ? "kiro_rate_limited" : "kiro_upstream_error";
  return { code, message: code, httpStatus: status || 502, retryable: status === 0 || status >= 500,
    ...([401, 403].includes(status) ? { cooldownMs: 3_600_000 } : status === 429 ? { cooldownMs: 300_000 } : {}) };
}
export function isKiroErrorEnvelope(body: unknown): boolean { return (body as { error?: { type?: string } })?.error?.type === "kiro_error"; }
