import type { PluginClassifiedError } from "./core-types";
export const GROK_BASE = "https://cli-chat-proxy.grok.com/v1";
export const GROK_UPSTREAM = `${GROK_BASE}/responses`;
export const GROK_PROVIDER = "grok-subscription";
export const GROK_MARKER = "ccr-managed-grok";
export function grokError(code: string, status = 422): Error & { code: string; statusCode: number } {
  return Object.assign(new Error(code), { code, statusCode: status, nonRetryable: true });
}
export function isGrokManaged(p: any): boolean {
  return p?.grok_managed === true || p?.grokManaged === true ||
    (p?.name === GROK_PROVIDER && (p.api_key ?? p.apiKey) === GROK_MARKER);
}
export function lockGrokProvider(p: any): any {
  return { ...p, name: GROK_PROVIDER, grok_managed: true, grokManaged: true,
    api_key: GROK_MARKER, api_base_url: GROK_UPSTREAM,
    transformer: { use: ["openai-responses", "grok"] } };
}
export function protectGrokConfig(next: any, previous: any): void {
  const old = (previous?.Providers ?? previous?.providers ?? []).find(isGrokManaged);
  const key = Array.isArray(next?.providers) && !Array.isArray(next?.Providers) ? "providers" : "Providers";
  if (!next || typeof next !== "object") return;
  const list = Array.isArray(next[key]) ? next[key] : [];
  next[key] = list.map((p: any) => isGrokManaged(p) || (old && p?.name === GROK_PROVIDER) ? lockGrokProvider(p) : p);
  if (old && !next[key].some(isGrokManaged)) next[key].push(lockGrokProvider(old));
}
export function classifyGrokError(status: number): PluginClassifiedError {
  // Send-level failures get a safe retryable 502 instead of null, so the core
  // never falls back to an account-invalid reading. 403 (network/region/permission)
  // is NOT automatically "expired": only upstream 401 evidence maps to reauth.
  if (status === 0) return { code: "grok_upstream_error", message: "grok_upstream_error", httpStatus: 502, retryable: true };
  const code = status === 401 ? "grok_reauth_required" : status === 429 ? "grok_rate_limited" : "grok_upstream_error";
  return { code, message: code, httpStatus: status, retryable: status >= 500,
    ...(status === 429 ? { cooldownMs: 300000 } : {}) };
}
export function validDeviceUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && u.hostname === "accounts.x.ai" && !u.username && !u.password && !u.port &&
      u.pathname === "/oauth2/device" && /^[\w/-]+$/.test(u.searchParams.get("user_code") ?? "") && !u.hash;
  } catch { return false; }
}
export function mergeGrokProvider(current: any, server: any): any {
  const next = { ...current };
  const key = Array.isArray(current?.providers) && !Array.isArray(current?.Providers) ? "providers" : "Providers";
  const managed = (server?.Providers ?? server?.providers ?? []).find(isGrokManaged);
  const list = [...(current?.[key] ?? [])];
  const at = list.findIndex(isGrokManaged);
  if (at >= 0) { if (managed) list[at] = managed; else list.splice(at, 1); }
  else if (managed && !list.some(p => p?.name === GROK_PROVIDER)) list.push(managed);
  next[key] = list;
  return next;
}
