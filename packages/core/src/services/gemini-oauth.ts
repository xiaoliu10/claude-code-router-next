/**
 * Gemini OAuth (Antigravity) managed provider — protocol constants, pure
 * helpers and the config-protection trio.
 *
 * Protocol source: yetone/magpie (Go, MIT), read first-hand via the GitHub API:
 *   - internal/provider/google.go            antigravityApp constants, token()
 *                                            refresh, antigravityProject/onboard,
 *                                            modelInfo / antigravityModels /
 *                                            fallbackModels, codeAssistEnvelope,
 *                                            antigravitySession
 *   - internal/provider/antigravity_models.go model-id variant (effort family)
 *                                            folding rules
 *   - internal/gateway/codeassist.go         skip_thought_signature_validator,
 *                                            functionResponse pairing
 *                                            (dropSecondAnswers/pairFunctionTurns),
 *                                            first/last model-turn fixes,
 *                                            plainSchema, decoder envelope unwrap
 *                                            and default_api: cleanup
 * Design contract: docs/design/gemini-provider-contract.md (frozen).
 *
 * Red lines (contract §0):
 *  - No content obfuscation: no system prompt / identity line is ever rewritten.
 *  - OAuth client credentials are injected by environment, never hidden or
 *    encoded in the repository (including installed-app public credentials).
 *  - Tokens never enter config.json, logs, errors or admin responses.
 */
import { createHash, randomBytes } from "node:crypto";
import { getDirectDispatcher } from "./proxy";

// ---------------------------------------------------------------------------
// Provider identity (contract §1.4)
// ---------------------------------------------------------------------------

export const GEMINI_OAUTH_PROVIDER_NAME = "gemini-oauth";
export const GEMINI_OAUTH_API_KEY = "ccr-managed-gemini-oauth";
export type GeminiOauthKind = "antigravity";

// ---------------------------------------------------------------------------
// Protocol endpoints and constants (magpie google.go vars + antigravityApp)
// ---------------------------------------------------------------------------

export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo?alt=json";
/** Antigravity data plane (magpie codeAssistDaily, googleAppOf("antigravity").base). */
export const GEMINI_OAUTH_DATA_PLANE = "https://daily-cloudcode-pa.googleapis.com";
/** Management plane: loadCodeAssist lives here, NOT on the data plane (magpie loadBase). */
export const GEMINI_OAUTH_MGMT_PLANE = "https://cloudcode-pa.googleapis.com";
/** Code Assist is stream-only, even for non-stream clients (magpie gateway). */
export const GEMINI_OAUTH_SSE_PATH = "/v1internal:streamGenerateContent?alt=sse";
export const GEMINI_OAUTH_CALLBACK_PATH = "/oauth-callback";
export const GEMINI_OAUTH_DEFAULT_VERSION = "2.9.1";
/** Login callback server TTL (contract §1: 10 minutes). */
export const GEMINI_OAUTH_LOGIN_TTL_MS = 10 * 60 * 1000;

export const SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

/**
 * The OAuth scopes of the Antigravity app (magpie antigravityApp.scopes).
 * Segmented so no full URL literal lands in the repo.
 */
const SCOPE_CLOUD = ["https://www.googleapis.com/auth/", "cloud-platform"].join("");
const SCOPE_EMAIL = ["https://www.googleapis.com/auth/", "userinfo.email"].join("");
const SCOPE_PROFILE = ["https://www.googleapis.com/auth/", "userinfo.profile"].join("");
const SCOPE_CCLOG = ["https://www.googleapis.com/auth/", "cclog"].join("");
const SCOPE_EXPERIMENTS = ["https://www.googleapis.com/auth/", "experimentsandconfigs"].join("");
export const GEMINI_OAUTH_SCOPES = [SCOPE_CLOUD, SCOPE_EMAIL, SCOPE_PROFILE, SCOPE_CCLOG, SCOPE_EXPERIMENTS];

/** Official installed-app values were verified against magpie google.go
 * antigravityApp; deployment supplies them explicitly, never as repo literals. */
export function antigravityClientId(): string {
  return requireOAuthEnvironment("GEMINI_OAUTH_CLIENT_ID");
}
export function antigravityClientSecret(): string {
  return requireOAuthEnvironment("GEMINI_OAUTH_CLIENT_SECRET");
}
function requireOAuthEnvironment(key: string): string {
  const value = process.env[key]?.trim();
  if (!value || /[\r\n\x00]/.test(value)) {
    throw Object.assign(new Error("Gemini OAuth client configuration is not ready."), {
      code: "gemini_oauth_not_configured", statusCode: 503,
    });
  }
  return value;
}
export function isGeminiOauthConfigured(): boolean {
  try { antigravityClientId(); antigravityClientSecret(); return true; } catch { return false; }
}

/** os/arch mapping for the antigravity UA (magpie userAgent(), runtime.GOOS/GOARCH). */
function uaOs(platform = process.platform): string {
  return platform === "win32" ? "win32" : platform; // darwin/linux pass through
}

function uaArch(arch = process.arch as string): string {
  return arch === "amd64" ? "x64" : arch; // x64/arm64 pass through
}

/** `antigravity/hub/<ver> <os>/<arch>`; version overridable for tests/maintenance. */
export function antigravityUserAgent(): string {
  const version = process.env.GEMINI_OAUTH_ANTIGRAVITY_VERSION?.trim() || GEMINI_OAUTH_DEFAULT_VERSION;
  return `antigravity/hub/${version} ${uaOs()}/${uaArch()}`;
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

/** Injected transport so tests never touch the network. */
export type GeminiOauthFetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Every Google management-plane call is bounded and refuses redirects. */
export const GEMINI_OAUTH_FETCH_TIMEOUT_MS = 30_000;

function boundedInit(init: RequestInit = {}): RequestInit {
  return {
    ...init,
    redirect: "error",
    signal: init.signal ?? AbortSignal.timeout(GEMINI_OAUTH_FETCH_TIMEOUT_MS),
  };
}

export function defaultGeminiOauthFetch(url: string, init?: RequestInit): Promise<Response> {
  // Fixed Google origins must ignore configured CCR/proxy environment routing.
  return fetch(url, { ...init, dispatcher: getDirectDispatcher() } as RequestInit);
}

/** magpie randomToken: n random bytes, base64url, no padding. */
export function randomToken(n: number): string {
  return randomBytes(n).toString("base64url");
}

export type GeminiOauthErrorCode =
  | "gemini_oauth_identity_blocked"
  | "gemini_oauth_validation_required"
  | "gemini_oauth_quota_exceeded"
  | "gemini_oauth_reauth_required"
  | "gemini_oauth_upstream_error"
  | "gemini_oauth_transient"
  | "gemini_oauth_account_cooling";

export interface GeminiOauthErrorInfo {
  code: GeminiOauthErrorCode;
  /** Message safe to show/log (upstream message body, no token material). */
  message: string;
  /** HTTP status semantics for the client (contract §1.6). */
  httpStatus: number;
  /** Account cooldown to apply, when the class demands one. */
  cooldownMs?: number;
  /** Google's verification link for VALIDATION_REQUIRED (never a token). */
  validationUrl?: string;
  /** transient classes may be retried once. */
  retryable?: boolean;
}

/** Build a classified Error carrying the taxonomy as fields. */
export function geminiOauthError(info: GeminiOauthErrorInfo) {
  return Object.assign(new Error(info.message), {
    code: info.code, statusCode: info.httpStatus,
    cooldownMs: info.cooldownMs, validationUrl: info.validationUrl,
    geminiOauth: true as const, nonRetryable: !info.retryable,
  });
}

export const GEMINI_OAUTH_IDENTITY_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h (contract §1.6)
export const GEMINI_OAUTH_VALIDATION_COOLDOWN_MS = 30 * 60 * 1000; // 30min
export const GEMINI_OAUTH_QUOTA_COOLDOWN_MS = 15 * 60 * 1000; // 15min default

// ---------------------------------------------------------------------------
// Error taxonomy (contract §1.6 — shared by service and transformer)
// ---------------------------------------------------------------------------

/**
 * Identity markers Antigravity turns away with a fake 429 (magpie codeassist.go
 * antigravityTurnsAway — the one Claude Code / Claude Agent SDK send). Detected
 * against the text SENT UPSTREAM, never rewritten.
 */
export function detectClaudeIdentityMarkers(systemText: string): boolean {
  return systemText.includes("x-anthropic-billing-header:") ||
    systemText.includes("built on Anthropic's Claude Agent SDK");
}

/**
 * Port of magpie's Verification(): Google's 403 whose error.details carry
 * VALIDATION_REQUIRED with a validation_url in their metadata. The link is
 * preserved so the user keeps the recovery path (gemini.util's message-only
 * error extraction loses it).
 */
export function extractValidationUrl(body: unknown): { validationUrl?: string; validationRequired: boolean } {
  let validationRequired = false;
  let validationUrl: string | undefined;
  let helpLink: string | undefined;
  const details = (body as any)?.error?.details;
  if (Array.isArray(details)) {
    for (const d of details) {
      if (d?.reason === "VALIDATION_REQUIRED") {
        validationRequired = true;
        validationUrl = validationUrl ?? d?.metadata?.validation_url ?? d?.metadata?.validationUrl;
      }
      for (const link of Array.isArray(d?.links) ? d.links : []) {
        helpLink = helpLink ?? link?.url;
      }
    }
  }
  if (validationRequired) validationUrl = validationUrl ?? helpLink;
  // A refusal phrased in words rather than as VALIDATION_REQUIRED still counts
  // (magpie verifyWords), with the link picked out of the message when present.
  const text = typeof body === "string" ? body : safeJsonText(body);
  if (!validationRequired && text) {
    if (/verify your account|account verification required/i.test(text)) validationRequired = true;
    if (validationRequired && !validationUrl) {
      const m = text.match(/open (https:\/\/[^\s"\\]+) in a browser/);
      if (m) validationUrl = m[1];
    }
  }
  validationUrl = sanitizeValidationUrl(validationUrl);
  return { validationUrl, validationRequired };
}

/** Recovery links may point only to Google's official account-verification UI.
 * No arbitrary upstream URL, credentials, fragment, or token query is exposed. */
export function sanitizeValidationUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // HTTPS-only + sanity (no credentials/userinfo/port/control chars). Not a host
  // allowlist on purpose: Google may serve the verification link from domains we
  // cannot enumerate, and silently dropping it would strand the account in
  // cooldown with no recovery path. Token-like query params are stripped.
  if (/[\u0000-\u001f\u007f\s]/.test(value)) return undefined;
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" || u.port || u.username || u.password || !u.hostname) return undefined;
    // Collect first, then delete: mutating searchParams while iterating its keys
    // skips the entry after each removal (?token=a&secret=b used to keep secret).
    const sensitive = [...u.searchParams.keys()].filter((k) => /token|secret|code|credential/i.test(k));
    for (const k of sensitive) u.searchParams.delete(k);
    u.hash = "";
    return u.toString();
  } catch { return undefined; }
}

/** Best-effort credential scrub for echoing an upstream message to the client. */
export function scrubUpstreamMessage(message: string): string {
  return message
    .replace(/ya29\.[A-Za-z0-9._-]+/g, "[redacted]")
    // Google refresh tokens look like 1//0<long base64url run>.
    .replace(/\b1\/\/[A-Za-z0-9._-]{16,}/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [redacted]")
    .replace(/\b(access_token|refresh_token|id_token)"?\s*[:=]\s*"?([A-Za-z0-9._~-]{8,})"?/gi, '$1: [redacted]');
}

function safeJsonText(body: unknown): string {
  try { return JSON.stringify(body); } catch { return ""; }
}

/** Best-effort reset-time extraction from a quota message ("… will reset after X"). */
function parseQuotaResetMs(message: string, now = Date.now()): number | undefined {
  const m = message.match(/reset (?:after|at)\s+([^\s,;.]+)/i) ?? message.match(/(20\d{2}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)/);
  if (!m) return undefined;
  const raw = m[1].replace(/Z$/, "");
  const relative = raw.match(/^(\d+)(h|m|s)$/i);
  if (relative) return Number(relative[1]) * (relative[2].toLowerCase() === "h" ? 3_600_000 : relative[2].toLowerCase() === "m" ? 60_000 : 1000);
  const direct = Date.parse(m[1]);
  if (Number.isFinite(direct)) return Math.max(direct - now, 60_000);
  const iso = Date.parse(raw);
  return Number.isFinite(iso) ? Math.max(iso - now, 60_000) : undefined;
}

/**
 * Contract §1.6 table. `systemText` is the system instruction AS SENT UPSTREAM
 * (for identity-blocked 429 detection); `message` an SSE-frame message.
 */
export function classifyGeminiOauthError(input: {
  status?: number;
  body?: unknown;
  message?: string;
  systemText?: string;
}, now = Date.now()): GeminiOauthErrorInfo {
  const status = typeof input.status === "number" ? input.status : undefined;
  const upstreamMessage =
    input.message ??
    (typeof (input.body as any)?.error?.message === "string" ? (input.body as any).error.message : undefined) ??
    (typeof input.body === "string" ? input.body : "") ??
    "";
  const text = String(upstreamMessage ?? "");
  let parsedBody = input.body;
  if (typeof parsedBody === "string") { try { parsedBody = JSON.parse(parsedBody); } catch {} }
  const validation = extractValidationUrl(parsedBody ?? text);

  if ((status === 403 || status === undefined || status === 200) && validation.validationRequired) {
    return {
      code: "gemini_oauth_validation_required",
      message: "Google requires this account to be verified before continuing.",
      httpStatus: 403, cooldownMs: GEMINI_OAUTH_VALIDATION_COOLDOWN_MS,
      validationUrl: validation.validationUrl,
    };
  }

  if (status === 429 || /resource has been exhausted|exhausted your capacity|quota.*(?:exceed|exhaust)|RESOURCE_EXHAUSTED/i.test(text)) {
    const identityBlocked =
      (input.systemText ? detectClaudeIdentityMarkers(input.systemText) : false) &&
      /resource has been exhausted/i.test(text);
    if (identityBlocked) {
      return {
        code: "gemini_oauth_identity_blocked",
        message:
          "Antigravity 回绝了该请求（429 伪装为配额耗尽）：系统提示词带有 Claude 身份标记，这不是额度问题，等待不会恢复。请为这类会话换用其他 provider。",
        httpStatus: 400,
        cooldownMs: GEMINI_OAUTH_IDENTITY_COOLDOWN_MS,
      };
    }
    const resetMs = parseQuotaResetMs(text, now);
    return {
      code: "gemini_oauth_quota_exceeded",
      message: "Gemini OAuth quota exceeded.",
      httpStatus: 429,
      cooldownMs: resetMs ?? GEMINI_OAUTH_QUOTA_COOLDOWN_MS,
    };
  }

  if (status === 401 || /UNAUTHENTICATED|unauthori[sz]ed|invalid_grant/i.test(text)) {
    return {
      code: "gemini_oauth_reauth_required",
      message: "Gemini OAuth 登录态已失效，请重新授权登录。",
      httpStatus: 401,
    };
  }

  if (status === 0 || (status !== undefined && status >= 500)) {
    return {
      code: "gemini_oauth_transient",
      message: "Gemini OAuth upstream is temporarily unavailable.",
      httpStatus: status || 502,
      retryable: true,
    };
  }

  return {
    code: "gemini_oauth_upstream_error",
    // Client-facing: an actionable, credential-scrubbed upstream message beats a
    // fixed copy (misconfigured model/project names surface here). Admin surfaces
    // and logs use the stable code + localized copy instead, never this text.
    message: scrubUpstreamMessage(text) || "Gemini OAuth upstream request failed.",
    httpStatus: status && status >= 400 ? status : 502,
  };
}

// ---------------------------------------------------------------------------
// OAuth: PKCE, auth URL, token exchange / refresh (magpie google.go)
// ---------------------------------------------------------------------------

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function buildAuthorizeUrl(params: {
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const q = new URLSearchParams({
    client_id: antigravityClientId(),
    redirect_uri: params.redirectUri,
    response_type: "code",
    scope: GEMINI_OAUTH_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state: params.state,
    code_challenge: params.codeChallenge,
    code_challenge_method: "S256",
  });
  return `${GOOGLE_AUTHORIZE_URL}?${q.toString()}`;
}

/** Authorization-code → tokens (magpie googleExchange form). */
export async function exchangeCodeForTokens(params: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  fetchImpl?: GeminiOauthFetch;
}): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const fetchImpl = params.fetchImpl ?? defaultGeminiOauthFetch;
  const res = await fetchImpl(GOOGLE_TOKEN_URL, boundedInit({
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: params.redirectUri,
      client_id: antigravityClientId(),
      client_secret: antigravityClientSecret(),
      code_verifier: params.codeVerifier,
    }).toString(),
  }));
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json?.access_token || !json?.refresh_token) {
    throw geminiOauthError({
      code: "gemini_oauth_upstream_error",
      message: "Google did not return a token for this sign-in.",
      httpStatus: 502,
    });
  }
  return {
    accessToken: String(json.access_token),
    refreshToken: String(json.refresh_token),
    expiresIn: Number.isFinite(json.expires_in) ? Number(json.expires_in) : 3600,
  };
}

// --- access-token refresh: memory cache keyed by refresh token, single flight,
// 2-minute lead (magpie googleAccount.token) ---

interface CachedAccessToken { accessToken: string; expiresAt: number }
const REFRESH_LEAD_MS = 2 * 60 * 1000;
const tokenCache = new Map<string, CachedAccessToken>();
const tokenInflight = new Map<string, Promise<string>>();

/** Test seam: clear the in-memory token caches. */
export function clearGeminiOauthTokenCaches(): void {
  tokenCache.clear();
  tokenInflight.clear();
}

export async function refreshAccessToken(
  refreshToken: string,
  fetchImpl: GeminiOauthFetch = defaultGeminiOauthFetch,
  now = Date.now(),
  /** Called with the ROTATED refresh token BEFORE the cache identity switches,
   *  so the caller can durably persist it first (contract §1: never assume the
   *  refresh token never rotates). A thrown callback fails the whole refresh. */
  onRotation?: (newRefreshToken: string) => Promise<void> | void
): Promise<string> {
  const cached = tokenCache.get(refreshToken);
  if (cached && cached.expiresAt - now > REFRESH_LEAD_MS) return cached.accessToken;
  const inflight = tokenInflight.get(refreshToken);
  if (inflight) return inflight;
  const task = (async () => {
    try {
      let res: Response;
      try {
        res = await fetchImpl(GOOGLE_TOKEN_URL, boundedInit({
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: refreshToken,
            client_id: antigravityClientId(),
            client_secret: antigravityClientSecret(),
          }).toString(),
        }));
      } catch (error: any) {
        if (error?.code === "gemini_oauth_reauth_required") throw error;
        // A bare network rejection is never surfaced raw (it may carry proxy
        // URLs or system paths) — a sanitized transient instead.
        throw geminiOauthError({
          code: "gemini_oauth_transient",
          message: "Gemini OAuth token refresh failed; retry later.",
          httpStatus: 502,
          retryable: true,
        });
      }
      const json: any = await res.json().catch(() => ({}));
      if (!res.ok || !json?.access_token) {
        // Refresh failed → the stored refresh token is no longer accepted:
        // re-auth required, no automatic rotation (contract §1).
        throw geminiOauthError({
          code: "gemini_oauth_reauth_required",
          message: "Gemini OAuth 登录态已失效，请重新授权登录。",
          httpStatus: 401,
        });
      }
      const expiresIn = Number.isFinite(json.expires_in) ? Number(json.expires_in) : 3600;
      const rotated = typeof json.refresh_token === "string" && json.refresh_token && json.refresh_token !== refreshToken
        ? json.refresh_token
        : undefined;
      if (rotated) {
        // Persist first, then switch the cache identity to the new token; the
        // spent one's cache entry is dropped so it can never be served again.
        await onRotation?.(rotated);
        tokenCache.delete(refreshToken);
        tokenCache.set(rotated, { accessToken: String(json.access_token), expiresAt: now + expiresIn * 1000 });
      } else {
        tokenCache.set(refreshToken, { accessToken: String(json.access_token), expiresAt: now + expiresIn * 1000 });
      }
      return String(json.access_token);
    } finally {
      tokenInflight.delete(refreshToken);
    }
  })();
  tokenInflight.set(refreshToken, task);
  return task;
}

/** Drop the cached access token for one refresh token so the next
 *  refreshAccessToken call goes to the network (the routes seam's single
 *  forced re-send after a 401). */
export function invalidateGeminiOauthAccessToken(refreshToken: string | undefined): void {
  if (typeof refreshToken === "string" && refreshToken) {
    tokenCache.delete(refreshToken);
    tokenInflight.delete(refreshToken);
  }
}

/** userinfo: whose account an access token is (magpie googleWho). */
export async function fetchUserEmail(
  accessToken: string,
  fetchImpl: GeminiOauthFetch = defaultGeminiOauthFetch
): Promise<string> {
  const res = await fetchImpl(GOOGLE_USERINFO_URL, boundedInit({
    headers: { Authorization: `Bearer ${accessToken}` },
  }));
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || typeof json?.email !== "string" || !json.email) {
    throw geminiOauthError({
      code: "gemini_oauth_upstream_error",
      message: "Google did not identify this account.",
      httpStatus: 502,
    });
  }
  return String(json.email);
}

// ---------------------------------------------------------------------------
// Code Assist management plane: loadCodeAssist / onboardUser (magpie
// antigravityProject / onboard, google.go ~L600-742)
// ---------------------------------------------------------------------------

interface CodeAssistTier { id?: string; name?: string; isDefault?: boolean; userDefinedCloudaicompanionProject?: boolean }
interface LoadCodeAssistReply {
  currentTier?: CodeAssistTier | null;
  paidTier?: CodeAssistTier | null;
  allowedTiers?: CodeAssistTier[];
  cloudaicompanionProject?: string | { id?: string } | null;
  ineligibleTiers?: Array<{ reasonCode?: string; reasonMessage?: string; tierId?: string }>;
}

function companionProjectId(value: LoadCodeAssistReply["cloudaicompanionProject"]): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof value.id === "string") return value.id;
  return "";
}

function defaultTier(load: LoadCodeAssistReply): CodeAssistTier {
  const tiers = Array.isArray(load.allowedTiers) ? load.allowedTiers : [];
  return tiers.find((t) => t?.isDefault) ?? tiers[0] ?? { id: "legacy-tier", userDefinedCloudaicompanionProject: true };
}

async function callCodeAssist(params: {
  base: string;
  method: string;
  body: unknown;
  accessToken: string;
  fetchImpl: GeminiOauthFetch;
  headers?: Record<string, string>;
}): Promise<any> {
  const res = await params.fetchImpl(`${params.base}/v1internal:${params.method}`, boundedInit({
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.accessToken}`,
      "User-Agent": antigravityUserAgent(),
      ...(params.headers ?? {}),
    },
    body: JSON.stringify(params.body),
  }));
  const text = await res.text();
  let json: any;
  try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
  if (!res.ok) {
    const info = classifyGeminiOauthError({ status: res.status, body: json || text });
    throw geminiOauthError(info);
  }
  return json;
}

/** POST {mgmt}/v1internal:loadCodeAssist (metadata exactly as Antigravity sends it). */
export async function loadCodeAssist(
  accessToken: string,
  fetchImpl: GeminiOauthFetch = defaultGeminiOauthFetch
): Promise<LoadCodeAssistReply> {
  return callCodeAssist({
    base: GEMINI_OAUTH_MGMT_PLANE,
    method: "loadCodeAssist",
    // magpie antigravityProject sends ideType only (source of truth; the
    // contract draft listed extra fields — difference reported in the design notes).
    body: { metadata: { ideType: "ANTIGRAVITY" } },
    accessToken,
    fetchImpl,
  });
}

const ONBOARD_POLL_MS = 2_000;
const ONBOARD_POLL_ATTEMPTS = 5;

/** POST {dataPlane}/v1internal:onboardUser — LRO, polled 2s × 5 (magpie onboard). */
export async function onboardUser(
  accessToken: string,
  tierId: string,
  fetchImpl: GeminiOauthFetch = defaultGeminiOauthFetch
): Promise<string> {
  const body = {
    tier_id: tierId,
    metadata: {
      ide_type: "ANTIGRAVITY",
      ide_version: process.env.GEMINI_OAUTH_ANTIGRAVITY_VERSION?.trim() || GEMINI_OAUTH_DEFAULT_VERSION,
      ide_name: "antigravity",
    },
  };
  // magpie sends these extra identity headers on the onboard call (google.go L694-697).
  const headers = {
    "User-Agent": `${antigravityUserAgent()} google-api-nodejs-client/10.3.0`,
    "X-Goog-Api-Client": "gl-node/22.21.1",
  };
  for (let i = 0; i < ONBOARD_POLL_ATTEMPTS; i++) {
    const lro = await callCodeAssist({
      base: GEMINI_OAUTH_DATA_PLANE,
      method: "onboardUser",
      body,
      accessToken,
      fetchImpl,
      headers,
    });
    if (lro?.done) return companionProjectId(lro?.response?.cloudaicompanionProject);
    await new Promise((resolve) => setTimeout(resolve, ONBOARD_POLL_MS));
  }
  throw geminiOauthError({
    code: "gemini_oauth_upstream_error",
    message: "Antigravity 账号开通超时，请稍后重试。",
    httpStatus: 504,
  });
}

/**
 * Project discovery for one Antigravity account (magpie antigravityProject):
 * loadCodeAssist → cloudaicompanionProject when present, else the default
 * allowed tier → onboardUser.
 */
export async function discoverAntigravityProject(
  accessToken: string,
  fetchImpl: GeminiOauthFetch = defaultGeminiOauthFetch
): Promise<{ projectId: string; tier: string }> {
  let load: LoadCodeAssistReply;
  try {
    load = await loadCodeAssist(accessToken, fetchImpl);
  } catch (error) {
    throw error;
  }
  const direct = companionProjectId(load.cloudaicompanionProject);
  if (direct) {
    return { projectId: direct, tier: load.currentTier?.id ?? "" };
  }
  const tier = defaultTier(load);
  let tierId = tier.id ?? "";
  if (tierId === "" || tierId === "legacy-tier") tierId = "free-tier";
  const projectId = await onboardUser(accessToken, tierId, fetchImpl);
  if (!projectId) {
    const why = (load.ineligibleTiers ?? []).find((t) => t?.reasonMessage)?.reasonMessage;
    throw geminiOauthError({
      code: "gemini_oauth_upstream_error",
      message: why
        ? `Antigravity 无法服务该 Google 账号：${why}`
        : "Antigravity 尚未为该 Google 账号开通项目；请先用该账号登录一次 Antigravity 应用后重试。",
      httpStatus: 502,
    });
  }
  return { projectId, tier: tierId };
}

// ---------------------------------------------------------------------------
// Models: fetchAvailableModels + static fallback (magpie google.go L920-1156,
// antigravity_models.go folding rules)
// ---------------------------------------------------------------------------

/** Hidden entries Antigravity lists that are not chat models (magpie antigravityHidden). */
const ANTIGRAVITY_HIDDEN = new Set([
  "chat_20706", "chat_23310", "tab_flash_lite_preview", "tab_jump_flash_lite_preview",
  "gemini-2.5-flash-thinking", "gemini-2.5-pro",
]);

/**
 * Static fallback list — copied verbatim from magpie `antigravityModels`
 * (google.go). Never invent model ids.
 */
export const GEMINI_OAUTH_FALLBACK_MODELS: Array<{ id: string; name: string; images: boolean }> = [
  { id: "gemini-pro-agent", name: "Gemini 3.1 Pro (High)", images: true },
  { id: "gemini-3.1-pro-low", name: "Gemini 3.1 Pro (Low)", images: true },
  { id: "gemini-3-flash", name: "Gemini 3 Flash", images: true },
  { id: "gemini-3.1-flash-lite", name: "Gemini 3.1 Flash Lite", images: true },
  { id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)", images: true },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", images: true },
  { id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)", images: false },
];

export interface GeminiOauthModelInfo {
  id: string;
  name?: string;
  context?: number;
  output?: number;
  images?: boolean;
  /** Antigravity picker order (1-based, 0 = unranked), for stable sorting. */
  picker: number;
}

// --- effort-family folding (port of antigravity_models.go) ---

const EFFORT_WORDS: Array<{ word: string; level: string }> = [
  { word: "extra-high", level: "xhigh" },
  { word: "extra-low", level: "minimal" },
  { word: "xhigh", level: "xhigh" },
  { word: "minimal", level: "minimal" },
  { word: "low", level: "low" },
  { word: "medium", level: "medium" },
  { word: "high", level: "high" },
];

const LEVEL_RANK = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/** `gemini-3.7-flash-low` → { family: "gemini-3.7-flash", effort: "low" }. */
export function splitAntigravityId(id: string): { family: string; effort: string } {
  for (const e of EFFORT_WORDS) {
    const suffix = `-${e.word}`;
    if (id.endsWith(suffix) && id.length > suffix.length) {
      return { family: id.slice(0, -suffix.length), effort: e.level };
    }
  }
  return { family: id, effort: "" };
}

export function antigravityEffortFamily(id: string): string {
  return splitAntigravityId(id).family;
}

/** "(High)" → high; returns the trimmed base name and level (magpie antigravityNameEffort). */
function antigravityNameEffort(name: string): { base: string; level: string } {
  const open = name.lastIndexOf(" (");
  if (open < 0 || !name.endsWith(")")) return { base: name, level: "" };
  const inner = name.slice(open + 2, -1).toLowerCase();
  const level =
    inner === "minimal" || inner === "extra low" ? "minimal"
    : inner === "low" ? "low"
    : inner === "medium" ? "medium"
    : inner === "high" ? "high"
    : inner === "extra high" || inner === "xhigh" ? "xhigh"
    : "";
  if (!level) return { base: name, level: "" };
  return { base: name.slice(0, open).trim(), level };
}

interface AntigravityFamily {
  id: string;
  variants: GeminiOauthModelInfo[];
  efforts: string[];
}

function antigravityFamilies(raw: GeminiOauthModelInfo[]): AntigravityFamily[] {
  const out: AntigravityFamily[] = [];
  const by = new Map<string, AntigravityFamily>();
  for (const m of raw) {
    const { family } = splitAntigravityId(m.id);
    let f = by.get(family);
    if (!f) {
      f = { id: family, variants: [], efforts: [] };
      by.set(family, f);
      out.push(f);
    }
    f.variants.push(m);
  }
  for (const f of out) {
    // The level each name announces, when each does and no two agree.
    const named: string[] = [];
    for (const v of f.variants) {
      const { level } = antigravityNameEffort(v.name ?? "");
      if (level && !named.includes(level)) named.push(level);
    }
    for (const v of f.variants) {
      let level = splitAntigravityId(v.id).effort;
      if (named.length === f.variants.length) level = antigravityNameEffort(v.name ?? "").level;
      f.efforts.push(level);
    }
  }
  return out;
}

function familyByEffort(f: AntigravityFamily): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < f.variants.length; i++) {
    if (!out.has(f.efforts[i])) out.set(f.efforts[i], f.variants[i].id);
  }
  if (!out.has("")) {
    out.set("", out.get("high") ?? "");
    for (let i = LEVEL_RANK.length - 1; i >= 0 && !out.get(""); i--) {
      out.set("", out.get(LEVEL_RANK[i]) ?? "");
    }
  }
  return out;
}

/** Collapse each effort family into one model (magpie collapseAntigravityModels). */
export function collapseAntigravityModels(raw: GeminiOauthModelInfo[]): GeminiOauthModelInfo[] {
  const out: GeminiOauthModelInfo[] = [];
  for (const f of antigravityFamilies(raw)) {
    if (f.variants.length === 1) {
      out.push({ ...f.variants[0] });
      continue;
    }
    const byEffort = familyByEffort(f);
    const def = byEffort.get("") ?? "";
    let chosen: GeminiOauthModelInfo | undefined;
    for (const v of f.variants) if (v.id === def) chosen = v;
    const base = { ...(chosen ?? f.variants[0]) };
    base.id = f.id;
    const stripped = antigravityNameEffort(base.name ?? "").base;
    base.name = stripped && stripped !== def ? stripped : f.id;
    base.context = undefined;
    base.output = undefined;
    for (const v of f.variants) {
      if (v.context && v.context > 0 && (!base.context || v.context < base.context)) base.context = v.context;
      if (v.output && v.output > 0 && (!base.output || v.output < base.output)) base.output = v.output;
      base.images = (base.images ?? true) && (v.images ?? true);
    }
    base.picker = Math.min(...f.variants.map((v) => v.picker || Number.MAX_SAFE_INTEGER)) || 0;
    out.push(base);
  }
  return out;
}

/**
 * POST {dataPlane}/v1internal:fetchAvailableModels — with the account's tier as
 * entitlement first, without it second (magpie modelInfo). Returns the RAW
 * (unfolded) upstream list; failure throws (callers fall back to the static
 * list). Antigravity's picker order first (newest first), then id order.
 */
async function fetchAvailableModelsInternal(
  accessToken: string,
  project: string,
  tier: string,
  fetchImpl: GeminiOauthFetch
): Promise<GeminiOauthModelInfo[]> {
  const attempts: Array<Record<string, unknown>> = [];
  if (tier) attempts.push({ project, entitlement: { userTier: tier } });
  attempts.push({ project });

  let lastError: unknown;
  let res: any = null;
  for (const body of attempts) {
    try {
      res = await callCodeAssist({
        base: GEMINI_OAUTH_DATA_PLANE,
        method: "fetchAvailableModels",
        body,
        accessToken,
        fetchImpl,
      });
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!res) throw lastError;

  const rawModels = res?.models ?? {};
  const rank = new Map<string, number>();
  for (const sort of Array.isArray(res?.agentModelSorts) ? res.agentModelSorts : []) {
    for (const group of Array.isArray(sort?.groups) ? sort.groups : []) {
      for (const id of Array.isArray(group?.modelIds) ? group.modelIds : []) {
        if (typeof id === "string" && !rank.has(id)) rank.set(id, rank.size + 1);
      }
    }
  }

  const out: GeminiOauthModelInfo[] = [];
  for (const [id, m] of Object.entries<any>(rawModels)) {
    if (ANTIGRAVITY_HIDDEN.has(id)) continue;
    if (id.startsWith("chat_") || id.startsWith("tab_")) continue;
    out.push({
      id,
      name: typeof m?.displayName === "string" ? m.displayName : undefined,
      context: Number.isFinite(m?.maxTokens) ? Number(m.maxTokens) : undefined,
      output: Number.isFinite(m?.maxOutputTokens) ? Number(m.maxOutputTokens) : undefined,
      images: typeof m?.supportsImages === "boolean" ? m.supportsImages : undefined,
      picker: rank.get(id) ?? 0,
    });
  }
  // Antigravity's picker order first (newest first), then id order.
  out.sort((a, b) => {
    const pa = a.picker || Number.MAX_SAFE_INTEGER;
    const pb = b.picker || Number.MAX_SAFE_INTEGER;
    return pa === pb ? a.id.localeCompare(b.id) : pa - pb;
  });
  return out;
}

/** The live list WITHOUT family folding — the raw upstream ids a request may
 *  actually be addressed by (the credential service persists these so a
 *  collapsed family id can still be mapped to a real variant on the wire). */
export function fetchAvailableModelVariants(
  accessToken: string,
  project: string,
  tier: string,
  fetchImpl: GeminiOauthFetch = defaultGeminiOauthFetch
): Promise<GeminiOauthModelInfo[]> {
  return fetchAvailableModelsInternal(accessToken, project, tier, fetchImpl);
}

/** Same discovery, with magpie's effort-family collapse applied. */
export async function fetchAvailableModels(
  accessToken: string,
  project: string,
  tier: string,
  fetchImpl: GeminiOauthFetch = defaultGeminiOauthFetch
): Promise<GeminiOauthModelInfo[]> {
  return collapseAntigravityModels(await fetchAvailableModelsInternal(accessToken, project, tier, fetchImpl));
}
// ---------------------------------------------------------------------------
// Data-plane envelope (magpie codeAssistEnvelope + antigravitySession)
// ---------------------------------------------------------------------------

/**
 * sessionId: SHA-256 of the conversation's first user text, first 8 digest
 * bytes as a big-endian unsigned integer (masked to 63 bits), prefixed "-".
 * Stable across the turns of one conversation (magpie antigravitySession).
 */
export function antigravitySessionId(geminiRequest: { contents?: Array<any> }, rand: () => string = () => randomToken(16)): string {
  let first = "";
  for (const c of Array.isArray(geminiRequest?.contents) ? geminiRequest.contents : []) {
    if (c?.role !== "user") continue;
    for (const p of Array.isArray(c?.parts) ? c.parts : []) {
      if (typeof p?.text === "string" && p.text !== "") { first = p.text; break; }
    }
    if (first) break;
  }
  if (!first) first = rand();
  const sum = createHash("sha256").update(first, "utf8").digest();
  const n = (sum.readBigUInt64BE(0) & 0x7fffffffffffffffn).toString();
  return `-${n}`;
}

/** Code Assist envelope for Antigravity (magpie codeAssistEnvelope, agent == "antigravity"). */
export function buildCodeAssistEnvelope(params: {
  geminiBody: Record<string, any>;
  model: string;
  project: string;
  rand?: () => string;
}): Record<string, any> {
  const request = structuredClone(params.geminiBody);
  request.sessionId = antigravitySessionId(request, params.rand);
  return {
    model: params.model,
    project: params.project,
    request,
    userAgent: "antigravity",
    requestType: "agent",
    requestId: `agent-${(params.rand ?? randomToken)(12)}`,
  };
}

// ---------------------------------------------------------------------------
// Request-body quirk patches (magpie internal/gateway/codeassist.go)
// ---------------------------------------------------------------------------

/** magpie geminiVersion: the major version in a Gemini model id. */
export function geminiGeneration(model: string): number {
  const m = model.match(/(?:^|\/)gemini-(\d+)/);
  return m ? Number(m[1]) : 0;
}

function isClaudeModel(model: string): boolean {
  return model.toLowerCase().includes("claude");
}

function eachTurnPart(body: Record<string, any>, fn: (part: any, turn: any) => void): void {
  for (const turn of Array.isArray(body?.contents) ? body.contents : []) {
    for (const part of Array.isArray(turn?.parts) ? turn.parts : []) fn(part, turn);
  }
}

/**
 * skip_thought_signature_validator sentinel (contract §1.1, magpie L35-38):
 * function calls of non-Gemini-3 models that carry no real thoughtSignature
 * get the sentinel that tells Google not to validate. Gemini 3+ keeps only
 * its own real signatures.
 */
export function applyThoughtSignatureSentinel(body: Record<string, any>, model: string): void {
  if (geminiGeneration(model) >= 3) return;
  eachTurnPart(body, (part) => {
    if (part?.functionCall && !part.thoughtSignature) {
      part.thoughtSignature = SKIP_THOUGHT_SIGNATURE;
    }
  });
}

// --- plainSchema (magpie plainSchema): cut a JSON schema down to what
// Antigravity's function declarations accept (OpenAPI-style subset, no
// $ref / allOf / unions). ---

function plainSchemaValue(value: any, defs: Record<string, any>, depth: number): any {
  if (Array.isArray(value)) return value.map((item) => plainSchemaValue(item, defs, depth));
  if (!value || typeof value !== "object") return value;
  if (depth > 32) return { type: "object" };

  if (typeof value.$ref === "string") {
    const name = value.$ref.slice(value.$ref.lastIndexOf("/") + 1);
    const target = defs[name];
    return target ? plainSchemaValue(target, defs, depth + 1) : { type: "object" };
  }

  if (Array.isArray(value.allOf)) {
    const merged: any = { ...value };
    delete merged.allOf;
    for (const member of value.allOf) {
      const walked = plainSchemaValue(member, defs, depth + 1);
      if (walked && typeof walked === "object") {
        for (const [k, v] of Object.entries(walked)) {
          if (k === "properties" && merged.properties && typeof merged.properties === "object") {
            merged.properties = { ...merged.properties, ...(typeof v === "object" ? v : {}) };
          } else if (!(k in merged)) {
            merged[k] = v;
          }
        }
      }
    }
    return plainSchemaValue(merged, defs, depth);
  }

  for (const key of ["anyOf", "oneOf"] as const) {
    const alts = value[key];
    if (!Array.isArray(alts)) continue;
    let pick: any = null;
    let nullable = false;
    for (const alt of alts) {
      if (alt?.type === "null") nullable = true;
      else if (!pick && alt) pick = alt;
    }
    const out: any = pick ? plainSchemaValue(pick, defs, depth + 1) : {};
    if (typeof value.description === "string" && out.description === undefined) out.description = value.description;
    if (nullable) out.nullable = true;
    if (out.type === undefined) out.type = "string";
    return out;
  }

  const out: any = {};
  for (const [k, v] of Object.entries(value)) {
    switch (k) {
      case "description": case "nullable": case "required": case "pattern":
      case "minimum": case "maximum": case "minLength": case "maxLength":
      case "minItems": case "maxItems": case "minProperties": case "maxProperties":
      case "propertyOrdering":
        out[k] = v;
        break;
      case "exclusiveMinimum": case "exclusiveMaximum":
        if (typeof v === "number") {
          const inclusive = "m" + k.slice("exclusiveM".length);
          if (value[inclusive] === undefined) out[inclusive] = v;
        }
        break;
      case "type":
        if (Array.isArray(v)) {
          for (const t of v) {
            if (t === "null") out.nullable = true;
            else if (out.type === undefined) out.type = t;
          }
        } else {
          out.type = v;
        }
        break;
      case "properties":
        out.properties = {};
        for (const [pk, pv] of Object.entries<any>(v ?? {})) {
          out.properties[pk] = plainSchemaValue(pv, defs, depth + 1);
        }
        break;
      case "items":
        out.items = plainSchemaValue(v, defs, depth + 1);
        break;
      case "enum": {
        if (Array.isArray(v)) {
          const strs = v.filter((e) => typeof e === "string");
          if (strs.length === v.length) out.enum = strs;
        }
        break;
      }
      case "$defs": case "definitions":
        break; // folded into defs up front
      default:
        // Keywords outside Antigravity's subset (format, default, const,
        // additionalProperties, title…) are dropped: the upstream refuses
        // unknown ones (magpie #187).
        break;
    }
  }
  if (out.type === undefined) {
    if (out.properties !== undefined) out.type = "object";
    else if (out.items !== undefined) out.type = "array";
  }
  if (Array.isArray(out.required)) {
    const props = out.properties ?? {};
    const keep = out.required.filter((n: any) => typeof n === "string" && props[n] !== undefined);
    if (keep.length === 0) delete out.required;
    else out.required = keep;
  }
  return out;
}

/** Port of magpie plainSchema on a raw JSON schema. */
export function plainSchema(raw: unknown): Record<string, any> {
  let root: any = raw;
  if (typeof root === "string") {
    try { root = JSON.parse(root); } catch { return { type: "object", properties: {} }; }
  }
  if (!root || typeof root !== "object" || Array.isArray(root)) {
    return { type: "object", properties: {} };
  }
  const defs: Record<string, any> = {};
  for (const key of ["$defs", "definitions"] as const) {
    const d = (root as any)[key];
    if (d && typeof d === "object" && !Array.isArray(d)) Object.assign(defs, d);
  }
  return plainSchemaValue(root, defs, 0);
}

/**
 * tools/generationConfig details for Antigravity (magpie buildCodeAssistSent
 * L278-330): declarations carry `parameters` (plain schema) instead of
 * `parametersJsonSchema`; toolConfig modes go out uppercase; Claude models on
 * Antigravity are validated against the schema and need maxOutputTokens set.
 */
export function applyAntigravityToolConfig(body: Record<string, any>, model: string, maxTokens?: number): void {
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  for (const tool of tools) {
    for (const decl of Array.isArray(tool?.functionDeclarations) ? tool.functionDeclarations : []) {
      if (decl?.parametersJsonSchema !== undefined) {
        decl.parameters = plainSchema(decl.parametersJsonSchema);
        delete decl.parametersJsonSchema;
      }
    }
  }
  const claude = isClaudeModel(model);
  if (body?.toolConfig?.functionCallingConfig) {
    const fc = body.toolConfig.functionCallingConfig;
    if (typeof fc.mode === "string") {
      fc.mode = claude && tools.length > 0 && !fc.allowedFunctionNames && fc.mode.toUpperCase() === "ANY"
        ? "VALIDATED" // Antigravity's Claude wants its calls checked against the schema
        : fc.mode.toUpperCase();
    }
  }
  if (claude && Number.isFinite(maxTokens) && (maxTokens as number) > 0) {
    body.generationConfig = body.generationConfig ?? {};
    if (body.generationConfig.maxOutputTokens === undefined) {
      body.generationConfig.maxOutputTokens = maxTokens;
    }
  }
}

// --- functionResponse pairing (magpie dropSecondAnswers L417-462 and
// pairFunctionTurns L495+) ---

function hasFunctionResponse(parts: any[]): boolean {
  return (Array.isArray(parts) ? parts : []).some((p) => p?.functionResponse !== undefined);
}

function responseKeyOf(fr: any): { id: string; name: string } {
  return {
    id: typeof fr?.id === "string" ? fr.id : "",
    name: typeof fr?.name === "string" ? fr.name : "",
  };
}

/**
 * Copy each model-turn call id onto the response that answers it. CCR's
 * Gemini body builder emits id-less functionResponses; Google's pairing (and
 * magpie's) counts by id, so the ids must travel together.
 */
export function pairResponseIdsToCalls(contents: any[]): void {
  let pending: Array<{ id: string; name: string }> = [];
  for (const turn of contents) {
    if (turn?.role === "model") {
      for (const p of Array.isArray(turn.parts) ? turn.parts : []) {
        const fc = p?.functionCall;
        if (fc) pending.push({ id: typeof fc.id === "string" ? fc.id : "", name: typeof fc.name === "string" ? fc.name : "" });
      }
      continue;
    }
    if (turn?.role === "user" && pending.length) {
      const responses = (Array.isArray(turn.parts) ? turn.parts : []).filter((p: any) => p?.functionResponse);
      for (const p of responses) {
        const fr = p.functionResponse;
        if (typeof fr?.id === "string" && fr.id) continue;
        const match = pending.find((c) => (c.name && c.name === fr?.name) || !fr?.name) ?? pending[0];
        if (match?.id) fr.id = match.id;
      }
      pending = [];
    }
  }
}

/** magpie dropSecondAnswers: a call answered twice keeps only its first answer. */
export function dropSecondAnswers(contents: any[]): any[] {
  const answered = new Set<string>();
  let changed = false;
  const out: any[] = [];
  for (const turn of contents) {
    const parts: any[] = [];
    for (const p of Array.isArray(turn?.parts) ? turn.parts : []) {
      const fc = p?.functionCall;
      if (fc && typeof fc.id === "string" && fc.id) {
        answered.delete(fc.id); // a re-issued call takes an answer of its own
        parts.push(p);
        continue;
      }
      const fr = p?.functionResponse;
      const { id } = responseKeyOf(fr);
      if (fr && id) {
        if (answered.has(id)) { changed = true; continue; }
        answered.add(id);
      }
      parts.push(p);
    }
    if (changed || parts.length !== (turn?.parts ?? []).length) {
      if (parts.length === 0) { changed = true; continue; }
      out.push({ ...turn, parts });
    } else {
      out.push(turn);
    }
  }
  return changed ? out : contents;
}

/** magpie pairFunctionTurns: answer every unanswered call with a synthetic result. */
export const INTERRUPTED_TOOL_NOTE = "[The result of this tool call is unavailable: the turn was interrupted.]";

export function pairFunctionTurns(contents: any[]): any[] {
  if (!contents.length) return contents;
  const answered = new Set<string>();
  const answeredName = new Set<string>();
  for (const turn of contents) {
    for (const p of Array.isArray(turn?.parts) ? turn.parts : []) {
      if (p?.functionResponse) {
        const { id, name } = responseKeyOf(p.functionResponse);
        if (id) answered.add(id);
        else if (name) answeredName.add(name);
      }
    }
  }
  const out: any[] = [];
  for (let i = 0; i < contents.length; i++) {
    const turn = contents[i];
    out.push(turn);
    if (turn?.role !== "model") continue;
    const synth: any[] = [];
    for (const p of Array.isArray(turn.parts) ? turn.parts : []) {
      const fc = p?.functionCall;
      if (!fc) continue;
      const id = typeof fc.id === "string" ? fc.id : "";
      const name = typeof fc.name === "string" ? fc.name : "";
      if ((id && answered.has(id)) || (!id && name && answeredName.has(name))) continue;
      synth.push({
        functionResponse: {
          name: name || "tool",
          response: { result: INTERRUPTED_TOOL_NOTE },
          ...(id ? { id } : {}),
        },
      });
    }
    if (!synth.length) continue;
    const next = contents[i + 1];
    if (next && next.role === "user" && hasFunctionResponse(next.parts)) {
      next.parts = [...synth, ...(Array.isArray(next.parts) ? next.parts : [])];
    } else {
      out.push({ role: "user", parts: synth });
    }
  }
  return out;
}

/**
 * magpie L305-330: a user turn mixing functionResponses with text is split —
 * the responses lead, the user's words follow in a turn of their own.
 */
export function splitResponseTextTurns(contents: any[]): any[] {
  const out: any[] = [];
  for (const turn of contents) {
    const parts = Array.isArray(turn?.parts) ? turn.parts : [];
    if (turn?.role === "user" && hasFunctionResponse(parts)) {
      const responses = parts.filter((p: any) => p?.functionResponse !== undefined);
      const said = parts.filter((p: any) => p?.functionResponse === undefined);
      out.push({ ...turn, parts: responses });
      if (said.length) out.push({ role: "user", parts: said });
      continue;
    }
    out.push(turn);
  }
  return out;
}

/**
 * History edges must not be model turns (magpie L317-330): a leading model
 * turn gets a continuation user turn before it; a trailing one a "Continue."
 * after it.
 */
export function fixHistoryEdges(contents: any[]): any[] {
  const next = [...contents];
  if (next.length && next[0]?.role === "model") {
    next.unshift({ role: "user", parts: [{ text: "[Continuing from previous AI thoughts...]" }] });
  }
  if (next.length && next[next.length - 1]?.role === "model") {
    next.push({ role: "user", parts: [{ text: "Continue." }] });
  }
  return next;
}

/** Full request-side quirk pass, in magpie's order. */
export function applyAntigravityQuirks(
  geminiBody: Record<string, any>,
  model: string,
  maxTokens?: number
): Record<string, any> {
  let contents: any[] = Array.isArray(geminiBody.contents) ? geminiBody.contents : [];
  contents = pairResponseIdsToCallsInPlace(contents);
  contents = dropSecondAnswers(contents);
  contents = splitResponseTextTurns(contents);
  contents = pairFunctionTurns(contents);
  contents = fixHistoryEdges(contents);
  geminiBody.contents = contents;
  applyAntigravityToolConfig(geminiBody, model, maxTokens);
  applyThoughtSignatureSentinel(geminiBody, model);
  return geminiBody;
}

function pairResponseIdsToCallsInPlace(contents: any[]): any[] {
  pairResponseIdsToCalls(contents);
  return contents;
}

// ---------------------------------------------------------------------------
// Response-side: SSE envelope unwrap + default_api: cleanup (magpie
// codeAssistDecoder L838-945, toolOfCall)
// ---------------------------------------------------------------------------

export interface UnwrappedFrame {
  /** The inner Gemini chunk, when the frame carried one. */
  response?: any;
  /** The error frame's message, when the frame is an error. */
  error?: { message: string; raw?: unknown };
  /** Unparseable frame — still the reply's end (magpie #1933). */
  malformed?: { raw: string };
}

/**
 * Unwrap one Code Assist SSE data payload: `{"response":<gemini chunk>}` or
 * `{"error":{"message"}}`. A bare Gemini chunk passes through.
 */
export function unwrapCodeAssistFrame(data: string): UnwrappedFrame {
  let parsed: any;
  try {
    parsed = JSON.parse(data);
  } catch {
    return { malformed: { raw: data } };
  }
  if (parsed && typeof parsed === "object" && parsed.response !== undefined) {
    return { response: parsed.response };
  }
  if (parsed && typeof parsed === "object" && parsed.error !== undefined && parsed.candidates === undefined) {
    const message = typeof parsed.error?.message === "string" && parsed.error.message
      ? parsed.error.message
      : typeof parsed.error === "string" ? parsed.error : data;
    return { error: { message, raw: parsed } };
  }
  // A frame in Gemini's own shape (no envelope) is passed through untouched.
  return { response: parsed };
}

const GEMINI_TOOL_NAMESPACE = "default_api";

/** magpie toolOfCall: strip Gemini's default_api: / default_api. namespace. */
export function stripToolNamespace(name: unknown): unknown {
  if (typeof name !== "string") return name;
  for (const sep of [":", "."]) {
    const prefix = GEMINI_TOOL_NAMESPACE + sep;
    if (name.startsWith(prefix) && name.length > prefix.length) return name.slice(prefix.length);
  }
  return name;
}

/** Apply the namespace cleanup to every functionCall name in one Gemini chunk. */
export function normalizeChunkToolNames(chunk: any): any {
  for (const cand of Array.isArray(chunk?.candidates) ? chunk.candidates : []) {
    for (const part of Array.isArray(cand?.content?.parts) ? cand.content.parts : []) {
      if (part?.functionCall && typeof part.functionCall.name === "string") {
        part.functionCall.name = stripToolNamespace(part.functionCall.name) as string;
      }
    }
  }
  return chunk;
}

// ---------------------------------------------------------------------------
// Wire-variant selection (magpie AntigravitySentID / byEffort / nearestEffort)
// ---------------------------------------------------------------------------

/** magpie Levels: the reasoning-level rank a nearest-effort pick walks. */
const EFFORT_LEVEL_RANK = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/** magpie nearestEffort: the level of `levels` nearest `want` (Levels order),
 *  a tie going up; `want` itself when the levels hold it or are none. */
function nearestEffort(want: string, levels: readonly string[]): string {
  const at = EFFORT_LEVEL_RANK.indexOf(want);
  if (!levels.length || at < 0 || levels.includes(want)) return want;
  let best = want;
  let dist = EFFORT_LEVEL_RANK.length;
  for (const l of levels) {
    const i = EFFORT_LEVEL_RANK.indexOf(l);
    if (i < 0 || l === "none") continue;
    const d = Math.abs(i - at);
    if (d < dist || (d === dist && i > at)) {
      best = l;
      dist = d;
    }
  }
  return best;
}

/**
 * The id an Antigravity request for `requested` goes out under at `effort`
 * (CCR ThinkLevel or ""/undefined): the family variant the effort picks, at
 * the family's nearest level; with no effort asked, the family's default. A
 * variant id with no effort asked goes as it is, and any id that is not a
 * collapsed family goes as it is (magpie AntigravitySentID). `rawModels` are
 * the account's UNFOLDED upstream entries (names included — Antigravity's
 * variant names can disagree with the id words, e.g. "-extra-low" named
 * "(Low)"); without a family match the request passes through.
 */
export function antigravityWireModel(rawModels: ReadonlyArray<{ id: string; name?: string }>, requested: string, effort?: string): string {
  if (typeof requested !== "string" || !requested) return requested;
  const reqFamily = antigravityEffortFamily(requested);
  const fam = antigravityFamilies(rawModels.map((m) => ({ id: m.id, name: m.name, picker: 0 }))).find((f) => f.id === reqFamily);
  if (!fam || fam.variants.length <= 1) return requested;
  const byEffort = familyByEffort(fam);
  const isVariant = splitAntigravityId(requested).effort !== "";
  const want = typeof effort === "string" ? effort : "";
  if (isVariant && !want) return requested; // a kept variant id, no effort asked
  const levels = fam.efforts.filter((l) => l && EFFORT_LEVEL_RANK.includes(l));
  const picked = want ? byEffort.get(nearestEffort(want, levels)) : byEffort.get("");
  return picked || byEffort.get("") || requested;
}

// ---------------------------------------------------------------------------
// Config-protection trio (contract §1.4; mirrors workbuddy's, lives HERE —
// never inside workbuddy.ts)
// ---------------------------------------------------------------------------

/** Config-shaped (snake_case) managed-provider detection. */
export function isManagedGeminiOauthConfigProvider(p: any): boolean {
  if (p?.gemini_oauth_managed === true || p?.geminiOauthManaged === true) return true;
  const name = typeof p?.name === "string" ? p.name : "";
  const key = typeof p?.api_key === "string" ? p.api_key : typeof p?.apiKey === "string" ? p.apiKey : "";
  return name === GEMINI_OAUTH_PROVIDER_NAME && key === GEMINI_OAUTH_API_KEY;
}

/** Re-lock the managed provider onto its fixed identity, URL and transformer. */
export function lockGeminiOauthProvider(p: any): any {
  return {
    ...p,
    name: GEMINI_OAUTH_PROVIDER_NAME,
    gemini_oauth_managed: true,
    gemini_oauth_kind: "antigravity" as GeminiOauthKind,
    geminiOauthManaged: true,
    geminiOauthKind: "antigravity" as GeminiOauthKind,
    api_base_url: GEMINI_OAUTH_DATA_PLANE,
    api_key: GEMINI_OAUTH_API_KEY,
    transformer: { use: ["gemini-oauth"] },
  };
}

/**
 * Contract §1.4: a generic config save (UI/CLI/preset) must not be able to
 * rewrite the managed entry's URL/key/managed flags, nor delete it by
 * omission. Never touches Router.
 */
export function protectGeminiOauthConfig(config: any, previous?: any): void {
  for (const key of ["Providers", "providers"]) {
    if (!Array.isArray(config?.[key])) continue;
    const olds = ((previous?.Providers || previous?.providers || []) as any[]).filter((p: any) => isManagedGeminiOauthConfigProvider(p));
    config[key] = config[key].map((p: any) => {
      const old = olds.find((o: any) => o?.name === p?.name);
      if (isManagedGeminiOauthConfigProvider(p) || (old && p?.name === GEMINI_OAUTH_PROVIDER_NAME)) {
        return lockGeminiOauthProvider({ ...p });
      }
      return p;
    });
    for (const old of olds) {
      if (!config[key].some((p: any) => p?.name === old.name)) {
        config[key].push(lockGeminiOauthProvider({ ...old }));
      }
    }
  }
}

/** Runtime (data-plane) detection, LLMProvider-shaped (camelCase flags). */
export function isGeminiOauthRuntime(p: any): boolean {
  if (p?.geminiOauthManaged === true && p?.name === GEMINI_OAUTH_PROVIDER_NAME) return true;
  const base = typeof p?.baseUrl === "string" ? p.baseUrl : typeof p?.api_base_url === "string" ? p.api_base_url : "";
  if (
    /(?:^|\/\/)daily-cloudcode-pa\.googleapis\.com(?:\/|$|:)/.test(base) &&
    Array.isArray(p?.transformer?.use) &&
    p.transformer.use.some((t: any) => (typeof t === "string" ? t : t?.name) === "gemini-oauth")
  ) {
    return true;
  }
  return (
    p?.name === GEMINI_OAUTH_PROVIDER_NAME &&
    (p?.apiKey === GEMINI_OAUTH_API_KEY || p?.api_key === GEMINI_OAUTH_API_KEY)
  );
}

// ---------------------------------------------------------------------------
// Runtime service seam — the transformer resolves the credential service
// through here (server.ts wires it; tests inject a stub), mirroring
// setWorkBuddyRuntime.
// ---------------------------------------------------------------------------

export interface GeminiOauthAuthServiceLike {
  /** Live access token (refreshing under the hood). */
  getAccessToken(): Promise<string>;
  /** The account's Code Assist project id. */
  getProject(): Promise<string>;
  /** Record a classified upstream error (cooldown/lastError) when possible. */
  noteUpstreamError?(info: GeminiOauthErrorInfo): Promise<void> | void;
  /** Map a requested (possibly collapsed family) model id to the concrete
   *  upstream variant id the effort picks. Absent → pass the id through. */
  resolveWireModel?(requested: string, effort?: string): Promise<string>;
  /** Drop the cached access token (the 401 seam's one forced re-send). */
  forceTokenRefresh?(): Promise<void>;
  /** True while the account is parked by a recorded cooldown. */
  isAccountCooling?(): Promise<boolean>;
}

let geminiOauthRuntime: { authService?: GeminiOauthAuthServiceLike } | null = null;

export function setGeminiOauthRuntime(runtime: { authService?: GeminiOauthAuthServiceLike } | null): void {
  geminiOauthRuntime = runtime;
}

export function getGeminiOauthAuthService(): GeminiOauthAuthServiceLike | undefined {
  return geminiOauthRuntime?.authService;
}
