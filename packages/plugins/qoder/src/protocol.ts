import type { PluginClassifiedError } from "./core-types";

export const QODER_OPENAPI = "https://openapi.qoder.sh";
export const QODER_API = "https://api3.qoder.sh";
/** The one chat endpoint Qoder's client uses; locked into the managed config. */
export const QODER_CHAT = `${QODER_API}/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`;
export const QODER_PROVIDER = "qoder-subscription";
export const QODER_MARKER = "ccr-managed-qoder";

export function qoderError(code: string, status = 422): Error & { code: string; statusCode: number } {
  return Object.assign(new Error(code), { code, statusCode: status, nonRetryable: true });
}

export function isQoderManaged(p: any): boolean {
  return p?.qoder_managed === true || p?.qoderManaged === true ||
    (p?.name === QODER_PROVIDER && (p.api_key ?? p.apiKey) === QODER_MARKER);
}

export function lockQoderProvider(p: any): any {
  // Single-transformer chain, exactly cursor's lockProvider shape ("qoder").
  return { ...p, name: QODER_PROVIDER, qoder_managed: true, qoderManaged: true,
    api_base_url: QODER_CHAT, api_key: QODER_MARKER, transformer: { use: ["qoder"] } };
}

export function protectQoderConfig(next: any, previous: any): void {
  const old = (previous?.Providers ?? previous?.providers ?? []).find(isQoderManaged);
  const key = Array.isArray(next?.providers) && !Array.isArray(next?.Providers) ? "providers" : "Providers";
  if (!next || typeof next !== "object") return;
  const list = Array.isArray(next[key]) ? next[key] : [];
  next[key] = list.map((p: any) => isQoderManaged(p) || (old && p?.name === QODER_PROVIDER) ? lockQoderProvider(p) : p);
  if (old && !next[key].some(isQoderManaged)) next[key].push(lockQoderProvider(old));
}

export function mergeQoderProvider(current: any, server: any): any {
  const next = { ...current };
  const key = Array.isArray(current?.providers) && !Array.isArray(current?.Providers) ? "providers" : "Providers";
  const managed = (server?.Providers ?? server?.providers ?? []).find(isQoderManaged);
  const list = [...(current?.[key] ?? [])];
  const at = list.findIndex(isQoderManaged);
  if (at >= 0) { if (managed) list[at] = managed; else list.splice(at, 1); }
  else if (managed && !list.some(p => p?.name === QODER_PROVIDER)) list.push(managed);
  next[key] = list;
  return next;
}

const RETRY_AFTER_MIN_MS = 30_000;
const RETRY_AFTER_MAX_MS = 30 * 60_000;
const DEFAULT_429_COOLDOWN_MS = 300_000;

/**
 * Shared taxonomy for Qoder's error bodies. The engine folds every upstream
 * failure into an errorResponse JSON whose body carries `retry_after` in
 * seconds (the host cannot see headers), so the 429 cooldown clamps that hint
 * into 30s..30min and falls back to 5 minutes. 403 is transport/permission
 * evidence, never "expired": only upstream 401 maps to reauth.
 */
export function classifyQoderError(status: number, body: unknown): PluginClassifiedError {
  if (status === 0) return { code: "qoder_upstream_error", message: "qoder_upstream_error", httpStatus: 502, retryable: true };
  let hint: any = body;
  if (typeof body === "string") { try { hint = JSON.parse(body); } catch { hint = undefined; } }
  if (status === 401) return { code: "qoder_reauth_required", message: "qoder_reauth_required", httpStatus: 401, retryable: false };
  if (status === 429) {
    const seconds = Number(hint?.retry_after);
    const cooldownMs = Number.isFinite(seconds) && seconds > 0
      ? Math.min(Math.max(seconds * 1000, RETRY_AFTER_MIN_MS), RETRY_AFTER_MAX_MS)
      : DEFAULT_429_COOLDOWN_MS;
    return { code: "qoder_rate_limited", message: "qoder_rate_limited", httpStatus: 429, cooldownMs, retryable: false };
  }
  return { code: "qoder_upstream_error", message: "qoder_upstream_error", httpStatus: status,
    retryable: status >= 500 };
}

/** HTTP-200 hidden-error-envelope detector for the engine's errorResponse shape. */
export function isQoderErrorEnvelope(body: unknown): boolean {
  return (body as any)?.error?.type === "qoder_error";
}

/** PAT format gate: `pt-` prefix, bounded length, no control characters. */
export function validPAT(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("pt-") && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value);
}
