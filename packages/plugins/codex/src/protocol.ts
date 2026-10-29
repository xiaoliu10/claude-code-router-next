/**
 * Codex subscription managed provider — protocol constants, pure helpers,
 * OAuth wire calls, dynamic model/usage discovery, error taxonomy and the
 * config-protection trio.
 *
 * First-hand protocol sources:
 *  - openai/codex login server (Rust), supplied at
 *    /tmp/ccr-codex/official-login-server.rs: issuer https://auth.openai.com,
 *    default port 1455, registered fallback 1457, redirect URI
 *    http://127.0.0.1:<port>/auth/callback, PKCE S256, authorize parameters
 *    (id_token_add_organizations / codex_cli_simplified_flow / originator),
 *    FORM-encoded authorization-code grant.
 *  - yetone/magpie codex provider (read first-hand, research log in the
 *    implementation contract): refresh grant is JSON-encoded with a reduced
 *    scope; account/plan live in the id_token's
 *    `https://api.openai.com/auth` claim; models come from
 *    /backend-api/codex/models?client_version=… (visibility filter, priority
 *    sort, per-model instructions), quota from /backend-api/wham/usage;
 *    there is NO static model table.
 *
 * Red lines (implementation contract §Validation and safety):
 *  - Tokens live ONLY in the plugin's 0600 codex-credentials.json; they never
 *    enter config.json, logs, errors or admin/status responses.
 *  - The managed provider name is `codex-subscription` — never hijack a
 *    user's own generic provider named `codex`.
 *  - Never read or import ~/.codex/auth.json (v1 is browser OAuth only).
 *  - Never send GET /cancel to another app's loopback listener.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { PluginClassifiedError } from "../../../core/src/provider-plugins/types";
import type { CodexRateLimits as QuotaCodexRateLimits } from "./protocol-quota";

/**
 * Rate-limit observation shape is single-sourced in protocol-quota.ts
 * (data-plane ownership). Re-exported so existing `from "./protocol"`
 * importers keep working.
 */
export type { CodexRateLimits, CodexRateLimitWindow } from "./protocol-quota";

// ---------------------------------------------------------------------------
// Provider identity
// ---------------------------------------------------------------------------

/** Managed provider name. A user-owned provider named `codex` stays theirs. */
export const CODEX_PROVIDER_NAME = "codex-subscription";
/** Transformer name registered by the data-plane lane. */
export const CODEX_TRANSFORMER_NAME = "codex";
/** The openai-responses transformer runs first, then the Codex finalizer. */
export const CODEX_TRANSFORMER_CHAIN = ["openai-responses", CODEX_TRANSFORMER_NAME] as const;
/** Constant marker api key stored in ordinary config; NEVER forwarded upstream. */
export const CODEX_API_KEY = "ccr-managed-codex";

// ---------------------------------------------------------------------------
// Endpoints and wire constants
// ---------------------------------------------------------------------------

export const CODEX_DEFAULT_ISSUER = "https://auth.openai.com";
/** Official Codex CLI public client id (installed app, no secret). */
export const CODEX_DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
/** Full scopes for the interactive authorization request. */
export const CODEX_LOGIN_SCOPES =
  "openid profile email offline_access api.connectors.read api.connectors.invoke";
/** Reduced scope the official client sends on refresh (magpie, verified). */
export const CODEX_REFRESH_SCOPE = "openid profile email";
export const CODEX_AUTHORIZE_PATH = "/oauth/authorize";
export const CODEX_TOKEN_PATH = "/oauth/token";

export const CODEX_BACKEND_BASE = "https://chatgpt.com/backend-api/codex";
export const CODEX_WHAM_USAGE_PATH = "/backend-api/wham/usage";

/**
 * UA/client_version gates which models the account list returns, so the
 * pinned default must stay reasonably new; env override exists for
 * maintenance without a code change.
 */
export const CODEX_DEFAULT_CLIENT_VERSION = "0.160.1";

/** Full Codex turn endpoint: backend base + /responses (pinned wire fact). */
export const CODEX_UPSTREAM_URL = `${CODEX_BACKEND_BASE}/responses`;
/** Data-plane alias for the pinned client version (A's value wins over bridge 0.159.0). */
export const CODEX_CLIENT_VERSION = CODEX_DEFAULT_CLIENT_VERSION;
/** Fixed originator header value for every data-plane request. */
export const CODEX_ORIGINATOR = "codex_cli_rs";
/** Alias used by the data plane for the managed marker; NEVER forwarded upstream. */
export const CODEX_MARKER_API_KEY = CODEX_API_KEY;

export const CODEX_CALLBACK_PORTS = [1455, 1457] as const;


/** Loopback hostnames a pasted callback URL is allowed to name. The redirect
 *  authority we hand the IdP is always 127.0.0.1, so any other host could not
 *  have come from a real redirect. */
export const CODEX_LOOPBACK_HOSTS: readonly string[] = ["127.0.0.1", "localhost", "::1"];

export const CODEX_CALLBACK_PATH = "/auth/callback";
/** Login lifetime: 30 minutes. Raised from the original 10: real users routinely
 *  exceed 10 minutes across password/2FA/org-SSO, and every TTL expiry looks
 *  identical to a broken callback (dead loopback listener → connection refused).
 *  Still bounded so a forgotten session cannot hold the single login slot. */
export const CODEX_LOGIN_TTL_MS = 30 * 60 * 1000;
/** Refresh lead time: refresh while at least 5 minutes of the JWT remain. */
export const CODEX_REFRESH_LEAD_MS = 5 * 60 * 1000;
/** Bound every auth/management-plane call; a hung upstream must not park login. */
export const CODEX_FETCH_TIMEOUT_MS = 30_000;

export function codexClientId(): string {
  return process.env.CODEX_OAUTH_CLIENT_ID?.trim() || CODEX_DEFAULT_CLIENT_ID;
}

export function codexIssuer(): string {
  return (process.env.CODEX_OAUTH_ISSUER?.trim() || CODEX_DEFAULT_ISSUER).replace(/\/+$/, "");
}

export function codexClientVersion(): string {
  return process.env.CODEX_CLIENT_VERSION?.trim() || CODEX_DEFAULT_CLIENT_VERSION;
}

export function codexUserAgent(
  version: string = codexClientVersion(),
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string {
  const osName = platform === "darwin" ? "Mac OS X" : platform === "win32" ? "Windows NT" : "Linux";
  return `codex_cli_rs/${version} (${osName}; ${arch})`;
}

/** Fixed management-plane headers (codex_request.go codexSign, management calls). */
export function codexManagementHeaders(accessToken: string, accountId: string | undefined): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    ...(accountId ? { "chatgpt-account-id": accountId } : {}),
    "OpenAI-Beta": "responses=experimental",
    originator: "codex_cli_rs",
    version: codexClientVersion(),
    "User-Agent": codexUserAgent(),
    Accept: "application/json",
    // Same rationale as the token exchange: a compressed body without
    // content-encoding hands undecodable bytes to text(); identity is plain.
    "Accept-Encoding": "identity",
  };
}

// ---------------------------------------------------------------------------
// Small primitives
// ---------------------------------------------------------------------------

export type CodexFetch = (url: string, init?: CodexFetchInit) => Promise<Response>;
export type CodexFetchInit = RequestInit & { dispatcher?: unknown };

export function randomToken(n: number): string {
  return randomBytes(n).toString("base64url");
}

export function boundedFetchInit(init: CodexFetchInit = {}): CodexFetchInit {
  return {
    redirect: "error",
    ...init,
    signal: init.signal ?? AbortSignal.timeout(CODEX_FETCH_TIMEOUT_MS),
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type CodexErrorCode =
  | "codex_reauth_required"
  | "codex_usage_limit"
  | "codex_rate_limited"
  | "codex_overloaded"
  | "codex_request_rejected"
  | "codex_upstream_error";

/** Admin/login poll codes (kept distinct from the data-plane taxonomy). */
export type CodexAdminCode =
  | CodexErrorCode
  | "codex_not_connected"
  | "codex_login_busy"
  | "codex_login_cancelled"
  | "codex_login_expired"
  | "codex_login_state_rejected"
  | "codex_login_exchange_failed"
  | "codex_login_persist_failed"
  | "codex_models_fetch_failed"
  | "codex_credential_invalid"
  | "codex_credential_unreadable"
  | "codex_config_write_failed";

/** The managed runtime throws this before any network touch when the account is cooling. */
export type CodexThrownCode = CodexErrorCode | "codex_account_cooling";

export function codexError(info: {
  code: CodexThrownCode;
  message: string;
  httpStatus: number;
  cooldownMs?: number;
  retryable?: boolean;
}): Error & { code: CodexThrownCode; statusCode: number; cooldownMs?: number; codex: true; nonRetryable: boolean } {
  return Object.assign(new Error(info.message), {
    code: info.code,
    statusCode: info.httpStatus,
    ...(info.cooldownMs ? { cooldownMs: info.cooldownMs } : {}),
    codex: true as const,
    nonRetryable: !info.retryable,
  });
}

export function codexAdminError(
  code: CodexAdminCode,
  statusCode = 422
): Error & { code: CodexAdminCode; statusCode: number; codex: true } {
  return Object.assign(new Error(code), { code, statusCode, codex: true as const });
}

export const CODEX_SAFE_MESSAGES: Record<CodexErrorCode, string> = {
  codex_reauth_required: "The saved Codex sign-in was rejected; authorize again.",
  codex_usage_limit: "This Codex account has reached its usage limit; wait for the window to reset.",
  codex_rate_limited: "Codex is rate limiting this account temporarily.",
  codex_overloaded: "Codex upstream is temporarily unavailable.",
  codex_request_rejected: "Codex rejected the request.",
  codex_upstream_error: "Codex upstream request failed.",
};

function bodyText(body: unknown): string {
  if (typeof body === "string") return body;
  try { return JSON.stringify(body); } catch { return ""; }
}

function parseBody(body: unknown): any {
  if (typeof body === "string") {
    try { return JSON.parse(body); } catch { return null; }
  }
  return body;
}

/** Unix timestamps arrive in seconds; normalise to epoch milliseconds. */
export function epochMs(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return undefined;
  // Unix seconds (≈1.8e9) are widened to ms; anything already ms-scale stays.
  return n < 100_000_000_000 ? n * 1000 : n;
}

/**
 * Classify a data-plane failure (HTTP status + parsed/raw body) into the
 * shared taxonomy. `usage_limit_reached` envelopes carry a unix `resets_at`
 * and become a bounded cooldown. Returns null for nothing-we-recognise.
 */
/**
 * Data-plane name for the classified-error shape; structurally identical to
 * the canonical core PluginClassifiedError (single definition, single source).
 */
export type CodexClassifiedErrorInfo = PluginClassifiedError;

export function classifyCodexError(status: number, body: unknown, _systemText?: string): PluginClassifiedError | null {
  const json = parseBody(body) ?? (typeof body === "string" ? {} : body);
  const err = (json as any)?.error;
  const errType = typeof err?.type === "string" ? err.type : "";
  const message = typeof err?.message === "string" ? err.message : bodyText(body);
  const resetMs = epochMs(err?.resets_at ?? (json as any)?.resets_at);
  const resetInSeconds = Number(err?.resets_in_seconds ?? (json as any)?.resets_in_seconds);
  const resetInMs = Number.isFinite(resetInSeconds) && resetInSeconds > 0 ? resetInSeconds * 1000 : undefined;
  const quotaCooldown = (): number | undefined => {
    const now = Date.now();
    if (resetMs && resetMs > now) return Math.max(resetMs - now, 60_000);
    if (resetInMs) return Math.max(resetInMs, 60_000);
    return undefined;
  };
  const now = Date.now();

  if (/usage_limit_reached|RESOURCE_EXHAUSTED|limit reached/i.test(errType) ||
      (status === 429 && /usage_limit_reached|limit reached/i.test(message))) {
    return {
      code: "codex_usage_limit",
      message: CODEX_SAFE_MESSAGES.codex_usage_limit,
      httpStatus: 429,
      ...(quotaCooldown() ? { cooldownMs: quotaCooldown() } : {}),
    };
  }
  if (status === 401 || /invalid_grant|token.*(expired|revoked|invalid)|refresh_token/i.test(`${errType} ${message}`)) {
    return {
      code: "codex_reauth_required",
      message: CODEX_SAFE_MESSAGES.codex_reauth_required,
      httpStatus: 401,
    };
  }
  if (status === 429) {
    return {
      code: "codex_rate_limited",
      message: CODEX_SAFE_MESSAGES.codex_rate_limited,
      httpStatus: 429,
      retryable: true,
      ...(quotaCooldown() ? { cooldownMs: quotaCooldown() } : {}),
    };
  }
  if (status >= 500) {
    return {
      code: "codex_overloaded",
      message: CODEX_SAFE_MESSAGES.codex_overloaded,
      httpStatus: status,
      retryable: true,
    };
  }
  if (status >= 400) {
    return {
      code: "codex_request_rejected",
      message: CODEX_SAFE_MESSAGES.codex_request_rejected,
      httpStatus: status,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// OAuth: PKCE, authorize URL, code exchange, refresh
// ---------------------------------------------------------------------------

export interface CodexPkce { verifier: string; challenge: string }

/** S256 PKCE pair. Verifier is 48 random bytes, base64url (magpie randomToken). */
export function createCodexPkce(rand: (n: number) => string = randomToken): CodexPkce {
  const verifier = rand(48);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function buildCodexAuthorizeUrl(params: {
  issuer?: string;
  clientId?: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: params.clientId ?? codexClientId(),
    redirect_uri: params.redirectUri,
    scope: CODEX_LOGIN_SCOPES,
    state: params.state,
    code_challenge: params.codeChallenge,
    code_challenge_method: "S256",
    // Official login server extras, in its exact order.
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: "codex_cli_rs",
  });
  return `${params.issuer ?? codexIssuer()}${CODEX_AUTHORIZE_PATH}?${q.toString()}`;
}

export interface CodexTokens {
  idToken: string;
  accessToken: string;
  refreshToken: string;
}

/** FORM-encoded authorization-code exchange (official TokenEncoding::Form). */
export async function exchangeCodexCode(params: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  fetchImpl: CodexFetch;
  issuer?: string;
  clientId?: string;
}): Promise<CodexTokens> {
  const res = await params.fetchImpl(`${params.issuer ?? codexIssuer()}${CODEX_TOKEN_PATH}`, boundedFetchInit({
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      // Some paths (middleboxes on the TUN/direct route) answer with a binary
      // compressed body missing content-type/content-encoding, which fetch then
      // hands through undecoded. identity = plain JSON, always parseable.
      "Accept-Encoding": "identity",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: params.redirectUri,
      client_id: params.clientId ?? codexClientId(),
      code_verifier: params.codeVerifier,
    }).toString(),
  }));
  return readTokenResponse(res, "code exchange");
}

/**
 * Refresh grant — JSON body and the reduced `openid profile email` scope
 * (magpie codexRefresh; login stays form-encoded, refresh must not be).
 */
export async function refreshCodexTokens(params: {
  refreshToken: string;
  fetchImpl: CodexFetch;
  issuer?: string;
  clientId?: string;
}): Promise<CodexTokens> {
  const res = await params.fetchImpl(`${params.issuer ?? codexIssuer()}${CODEX_TOKEN_PATH}`, boundedFetchInit({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: params.clientId ?? codexClientId(),
      grant_type: "refresh_token",
      refresh_token: params.refreshToken,
      scope: CODEX_REFRESH_SCOPE,
    }),
  }));
  return readTokenResponse(res, "refresh");
}

async function readTokenResponse(res: Response, stage: string): Promise<CodexTokens> {
  const text = await res.text().catch(() => "");
  let json: any = null;
  try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
  const ok = res.ok && json && typeof json === "object";
  const t: CodexTokens | null = ok && json.id_token && json.access_token && json.refresh_token
    ? {
        idToken: String(json.id_token),
        accessToken: String(json.access_token),
        refreshToken: String(json.refresh_token),
      }
    : null;
  if (!t) {
    const errType = typeof json?.error === "string" ? json.error : json?.error?.type ?? "";
    const reauth = !res.ok && (res.status === 400 || res.status === 401 ||
      /invalid_grant|refresh_token_(reused|invalidated|expired)|token_revoked|invalidated/i.test(String(errType)));
    throw codexError({
      code: reauth ? "codex_reauth_required" : "codex_upstream_error",
      message: reauth
        ? CODEX_SAFE_MESSAGES.codex_reauth_required
        : `Codex OAuth ${stage} failed (HTTP ${res.status}, ct=${res.headers.get("content-type") ?? "?"}, body=${text.slice(0, 160)}).`,
      httpStatus: reauth ? 401 : 502,
    });
  }
  return t;
}

// ---------------------------------------------------------------------------
// JWT / id_token claims
// ---------------------------------------------------------------------------

export interface CodexIdClaims {
  accountId: string;
  plan: string;
  email: string;
  accessExp?: number;
}

export function decodeJwtPayload(token: string): Record<string, any> | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Account id / plan come from the id_token's nested
 * `https://api.openai.com/auth` claim (magpie claimString). The plan value is
 * passed through verbatim — never hard-code a plan tier table.
 */
export function readCodexIdClaims(idToken: string, accessToken?: string): CodexIdClaims {
  const id = decodeJwtPayload(idToken);
  const authClaim = id?.["https://api.openai.com/auth"];
  const accountId = typeof authClaim?.chatgpt_account_id === "string" ? authClaim.chatgpt_account_id : "";
  const plan = typeof authClaim?.chatgpt_plan_type === "string" ? authClaim.chatgpt_plan_type : "";
  const email = typeof id?.email === "string" ? id.email : "";
  const access = accessToken ? decodeJwtPayload(accessToken) : null;
  const accessExp = typeof access?.exp === "number" ? access.exp * 1000 : undefined;
  return { accountId, plan, email, accessExp };
}

export function accessTokenExpiryMs(accessToken: string): number | undefined {
  const claims = decodeJwtPayload(accessToken);
  return typeof claims?.exp === "number" ? claims.exp * 1000 : undefined;
}

export function safeEqualState(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// ---------------------------------------------------------------------------
// Models (dynamic, account-specific — NO static table)
// ---------------------------------------------------------------------------

export interface CodexModelInfo {
  slug: string;
  displayName: string;
  visibility: string;
  priority: number;
  /** base_instructions ?? model_messages.instructions_template. */
  instructions?: string;
}

/** Tolerant parse: top-level array, {models:[…]}, or {models:{slug:{…}}}. */
export function parseCodexModels(raw: unknown): CodexModelInfo[] {
  const source = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as any)?.models)
      ? (raw as any).models
      : (raw as any)?.models && typeof (raw as any).models === "object"
        ? Object.entries((raw as any).models).map(([slug, v]) => ({ slug, ...(v as object) }))
        : [];
  const out: CodexModelInfo[] = [];
  for (const m of source as any[]) {
    if (!m || typeof m !== "object") continue;
    const slug = typeof m.slug === "string" ? m.slug : typeof m.id === "string" ? m.id : "";
    if (!slug || slug.length > 256 || /[\x00-\x1f\x7f]/.test(slug)) continue;
    const visibility = typeof m.visibility === "string" ? m.visibility : "";
    const priority = Number.isFinite(m.priority) ? Number(m.priority) : Number.MAX_SAFE_INTEGER;
    const template =
      typeof m.base_instructions === "string" && m.base_instructions.trim()
        ? m.base_instructions
        : typeof m.model_messages?.instructions_template === "string" && m.model_messages.instructions_template.trim()
          ? m.model_messages.instructions_template
          : undefined;
    out.push({
      slug,
      displayName: typeof m.display_name === "string" ? m.display_name : typeof m.displayName === "string" ? m.displayName : slug,
      visibility,
      priority,
      ...(template ? { instructions: template } : {}),
    });
  }
  return out;
}

/**
 * Visibility filter (`hide` dropped) then priority order, stable on ties.
 */
export function selectCodexModels(models: CodexModelInfo[]): CodexModelInfo[] {
  return models
    .filter((m) => m.visibility !== "hide")
    .sort((a, b) => (a.priority - b.priority) || a.slug.localeCompare(b.slug));
}

export async function fetchCodexModels(params: {
  accessToken: string;
  accountId?: string;
  fetchImpl: CodexFetch;
  base?: string;
  version?: string;
}): Promise<CodexModelInfo[]> {
  const version = params.version ?? codexClientVersion();
  const url = `${params.base ?? CODEX_BACKEND_BASE}/models?client_version=${encodeURIComponent(version)}`;
  const res = await params.fetchImpl(url, boundedFetchInit({
    method: "GET",
    headers: codexManagementHeaders(params.accessToken, params.accountId),
  }));
  const text = await res.text().catch(() => "");
  let json: any = null;
  try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
  if (!res.ok) {
    const classified = classifyCodexError(res.status, json || text);
    throw codexError({
      code: classified?.code === "codex_reauth_required" ? "codex_reauth_required" : "codex_upstream_error",
      message: classified?.message ?? `Codex model list could not be loaded (HTTP ${res.status}, ct=${res.headers.get("content-type") ?? "?"}, body=${text.slice(0, 120)}).`,
      httpStatus: classified?.httpStatus ?? 502,
    });
  }
  return selectCodexModels(parseCodexModels(json));
}

// ---------------------------------------------------------------------------
// Usage (/backend-api/wham/usage)
// ---------------------------------------------------------------------------

export interface CodexUsageWindow {
  usedPercent: number;
  windowSeconds: number;
  resetAt: number;
}

export interface CodexUsage {
  plan: string;
  primary?: CodexUsageWindow;
  secondary?: CodexUsageWindow;
}

function readUsageWindow(raw: any): CodexUsageWindow | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const usedPercent = typeof raw.used_percent === "number" ? raw.used_percent
    : typeof raw.usedPercent === "number" ? raw.usedPercent : undefined;
  const windowSeconds = typeof raw.limit_window_seconds === "number" ? raw.limit_window_seconds
    : typeof raw.windowSeconds === "number" ? raw.windowSeconds : undefined;
  const resetAt = epochMs(raw.reset_at ?? raw.resetAt);
  if (usedPercent === undefined || !windowSeconds || !resetAt) return undefined;
  return { usedPercent, windowSeconds, resetAt };
}

export function parseCodexUsage(raw: unknown): CodexUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as any;
  const plan = typeof r.plan_type === "string" ? r.plan_type
    : typeof r.planType === "string" ? r.planType : "";
  const rateLimit = r.rate_limit ?? r.rateLimit ?? {};
  const primary = readUsageWindow(rateLimit.primary_window ?? rateLimit.primaryWindow);
  const secondary = readUsageWindow(rateLimit.secondary_window ?? rateLimit.secondaryWindow);
  if (!plan && !primary && !secondary) return null;
  return {
    plan,
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
  };
}

export async function fetchCodexUsage(params: {
  accessToken: string;
  accountId?: string;
  fetchImpl: CodexFetch;
  origin?: string;
}): Promise<CodexUsage | null> {
  const origin = params.origin ?? "https://chatgpt.com";
  const res = await params.fetchImpl(`${origin}${CODEX_WHAM_USAGE_PATH}`, boundedFetchInit({
    method: "GET",
    headers: codexManagementHeaders(params.accessToken, params.accountId),
  }));
  if (!res.ok) return null; // unsupported/absent quota surface → null, never fatal
  const text = await res.text().catch(() => "");
  try {
    return parseCodexUsage(text ? JSON.parse(text) : {});
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Rate-limit observations (data plane → service; storage seam only)
// ---------------------------------------------------------------------------

/** True when a window says the account is at 100% with a live reset time. */
export function rateLimitsSaturated(limits: QuotaCodexRateLimits, now: number): boolean {
  for (const w of [limits.primary, limits.secondary]) {
    if (!w) continue;
    if (w.usedPercent >= 100 && typeof w.resetAt === "number" && w.resetAt > now) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Config protection trio
// ---------------------------------------------------------------------------

export function isCodexManagedConfigProvider(p: any): boolean {
  if (p?.codex_managed === true || p?.codexManaged === true) return true;
  const name = typeof p?.name === "string" ? p.name : "";
  const key = typeof p?.api_key === "string" ? p.api_key : typeof p?.apiKey === "string" ? p.apiKey : "";
  return name === CODEX_PROVIDER_NAME && key === CODEX_API_KEY;
}

/** Re-lock the managed entry onto its fixed identity/transport. Never touches Router. */
export function lockCodexProvider(p: any): any {
  return {
    ...p,
    name: CODEX_PROVIDER_NAME,
    codex_managed: true,
    codexManaged: true,
    api_base_url: CODEX_BACKEND_BASE,
    api_key: CODEX_API_KEY,
    transformer: { use: [...CODEX_TRANSFORMER_CHAIN] },
  };
}

/**
 * A generic config save may not rewrite the managed entry's URL/key/flags and
 * may not delete it by omission. Router is never touched; unrelated providers
 * are never touched.
 */
export function protectCodexConfig(next: any, prev?: any): void {
  for (const key of ["Providers", "providers"]) {
    if (!Array.isArray(next?.[key])) continue;
    const olds = ((prev?.Providers || prev?.providers || []) as any[]).filter((p: any) => isCodexManagedConfigProvider(p));
    next[key] = next[key].map((p: any) => {
      // Only entries that ARE the managed provider get re-locked. A name match
      // alone is not identity: the host calls protectors on every generic
      // config save, so re-locking by name would overwrite (and permanently
      // lose) a user provider that happens to share our name. A managed entry
      // whose markers were stripped is restored by the omission loop below.
      if (isCodexManagedConfigProvider(p)) {
        return lockCodexProvider({ ...p });
      }
      return p;
    });
    for (const old of olds) {
      if (!next[key].some((p: any) => p?.name === old.name)) {
        next[key].push(lockCodexProvider({ ...old }));
      }
    }
  }
}

/** Runtime (data-plane) detection on an LLMProvider-shaped object. */
export function isCodexRuntime(p: any): boolean {
  if (p?.codexManaged === true && p?.name === CODEX_PROVIDER_NAME) return true;
  const base = typeof p?.baseUrl === "string" ? p.baseUrl : typeof p?.api_base_url === "string" ? p.api_base_url : "";
  if (
    /(?:^|\/\/)chatgpt\.com\/backend-api\/codex(?:\/|$)/.test(base) &&
    Array.isArray(p?.transformer?.use) &&
    p.transformer.use.some((t: any) => (typeof t === "string" ? t : t?.name) === CODEX_TRANSFORMER_NAME)
  ) {
    return true;
  }
  return (
    p?.name === CODEX_PROVIDER_NAME &&
    (p?.apiKey === CODEX_API_KEY || p?.api_key === CODEX_API_KEY)
  );
}

// ---------------------------------------------------------------------------
// Redacted status / login / structural service contract
// ---------------------------------------------------------------------------

export type CodexConnectionStatus = "not_connected" | "connected" | "expired" | "error";

export interface CodexStatus {
  status: CodexConnectionStatus;
  providerName: typeof CODEX_PROVIDER_NAME;
  accountId?: string;
  email?: string;
  plan?: string;
  models: string[];
  modelCount: number;
  coolingUntil?: number;
  lastError?: string | null;
}

export interface CodexLoginStart {
  loginId: string;
  url: string;
  expiresAt: number;
  mode: "callback" | "paste";
  redirectUri: string;
}

export type CodexLoginPollStatus = "pending" | "connected" | "cancelled" | "expired" | "error";

export interface CodexLoginPoll {
  status: CodexLoginPollStatus;
  /** Stable code only (CodexAdminCode subset); never upstream text or tokens. */
  error?: string;
  models?: string[];
  modelCount?: number;
}

/**
 * Structural surface the data plane depends on. Class-independent so the
 * runtime never needs a runtime import of the service module.
 */
export interface CodexServiceLike {
  getAccessToken(): Promise<string>;
  getAccountId(): Promise<string>;
  forceTokenRefresh(): Promise<void>;
  noteUpstreamError(info: PluginClassifiedError): Promise<void> | void;
  isAccountCooling(): Promise<boolean>;
  getModelInstructions(model: string): string | undefined;
  /** Persist a data-plane rate-limit observation (storage/cooling only). Never throws. */
  noteRateLimits(limits: QuotaCodexRateLimits): Promise<void>;
  /** Latest stored rate-limit observation, if any. */
  getRateLimits(): Promise<QuotaCodexRateLimits | null>;
  /** Account status snapshot (used by the recovery probe to report the parked
   *  window). Optional so older hosts keep working. */
  getStatus?(): Promise<any>;
  /** Remote usage/windows — the cheapest authenticated liveness check. Optional
   *  so older hosts keep working. */
  getUsage?(): Promise<any>;
}

/**
 * True when a completed Responses turn actually carries output.
 *
 * Judged on the whole `output` array (not on text) so tool-only, reasoning-only
 * and refusal turns all count as real answers: they each contribute an output
 * item. An empty array is the "nothing happened" turn this check exists for.
 */
export function responseHasOutput(response: any): boolean {
  const output = response?.output;
  if (Array.isArray(output) && output.length > 0) return true;
  // Some upstreams report the answer only through counts.
  const usage = response?.usage;
  return typeof usage?.output_tokens === "number" && usage.output_tokens > 0;
}

/**
 * The upstream completed a turn without producing anything.
 *
 * Retryable on purpose: an empty turn is usually transient (upstream hiccup or a
 * model that dropped the answer), so the value is in letting the generic
 * same-model retry and fallback chain run instead of handing the client a 200
 * with no content.
 */
export function codexEmptyAnswerError(): Error {
  return codexError({
    code: "codex_upstream_error",
    message: "Codex returned an empty answer (completed with no output).",
    httpStatus: 502,
    retryable: true,
  });
}
