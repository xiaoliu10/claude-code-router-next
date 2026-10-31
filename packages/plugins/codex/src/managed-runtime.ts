/**
 * Codex subscription managed runtime — fixed upstream, token/account header
 * injection, final-body session headers, 401-once refresh, cooling breaker and
 * error taxonomy for `chatgpt.com/backend-api/codex/responses`.
 *
 * Everything here is the runtime half of the data contract
 * (docs/design/provider-plugins.md §5.2):
 *  - fixed origin + redirect:error + direct dispatcher (never a config base_url,
 *    never CCR/proxy env routing);
 *  - strip EVERY case variant of client/upstream auth and session identity,
 *    then inject the account headers — the marker api_key never leaves;
 *  - `session-id` / `thread-id` from the FINAL body's `prompt_cache_key`
 *    (magpie #1473: without them the prompt cache misses);
 *  - `usage_limit_reached` + `resets_at` → a cooldown classification;
 *  - a cooling account is refused BEFORE any network touch (Gemini lesson:
 *    never spend a refresh/turn on a parked account).
 *
 * NOT in scope: zstd, WebSocket, multi-account pools, reset credits.
 */
import {
  CODEX_CLIENT_VERSION,
  CODEX_ORIGINATOR,
  CODEX_UPSTREAM_URL,
  classifyCodexError,
  codexError,
  isCodexRuntime,
  type CodexServiceLike,
} from "./protocol";
import type { ManagedRuntime, PluginClassifiedError } from "./core-types";

/** Header names carrying client or upstream identity that must never survive. */
export const CODEX_STRIPPED_HEADERS = [
  "authorization",
  "x-api-key",
  "api-key",
  "proxy-authorization",
  "host",
  "cookie",
  // Session/conversation identity: only the FINAL body may define it, and only
  // under the exact hyphenated names the backend reads.
  "session_id",
  "conversation_id",
  "session-id",
  "thread-id",
  "conversation-id",
  // Account identity is CONDITIONALLY injected (only when an account id is
  // known); strip a client value even on a call that does not re-inject it,
  // or it would ride through to the upstream verbatim.
  "chatgpt-account-id",
] as const;

const STRIPPED = new Set<string>(CODEX_STRIPPED_HEADERS);

/** platform/arch mapped the way a Rust CLI reports them (magpie codexUserAgent). */
function codexUserAgent(version = CODEX_CLIENT_VERSION): string {
  const os = process.platform === "darwin" ? "Mac OS" : process.platform === "win32" ? "Windows" : "Linux";
  const arch = process.arch === "x64" ? "x86_64" : process.arch;
  return `${CODEX_ORIGINATOR}/${version} (${os}; ${arch})`;
}

/**
 * The account headers for one upstream call. `requestBody` is the FINAL body
 * (after codexFinalizeBody), so `prompt_cache_key` is authoritative.
 */
export function codexAccountHeaders(input: {
  accessToken: string;
  accountId?: string;
  requestBody?: any;
  version?: string;
}): Record<string, string> {
  const version = input.version ?? CODEX_CLIENT_VERSION;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${input.accessToken}`,
    "OpenAI-Beta": "responses=experimental",
    originator: CODEX_ORIGINATOR,
    version,
    "User-Agent": codexUserAgent(version),
    Accept: "text/event-stream",
    // Same middlebox rationale as the OAuth/management calls: the direct
    // route's middlebox strips content-encoding while handing through the
    // compressed bytes, which undici cannot decode. identity = plain SSE,
    // parseable under any exit node.
    "Accept-Encoding": "identity",
  };
  if (input.accountId) headers["chatgpt-account-id"] = input.accountId;
  const sessionKey = input.requestBody?.prompt_cache_key;
  if (typeof sessionKey === "string" && sessionKey) {
    headers["session-id"] = sessionKey;
    headers["thread-id"] = sessionKey;
  }
  return headers;
}

export interface CodexRuntimeOptions {
  service: CodexServiceLike;
  /** ctx.host.getDirectDispatcher — fixed origins bypass CCR/proxy env routing. */
  host: { getDirectDispatcher: () => unknown };
  /** Activation logger (classifications only, never credentials). */
  log?: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
}

export function createCodexManagedRuntime(options: CodexRuntimeOptions): ManagedRuntime {
  const { service } = options;
  if (!service) throw new Error("createCodexManagedRuntime requires { service }");

  return {
    name: "codex",
    isManaged: (provider) => isCodexRuntime(provider),

    // Circuit breaker BEFORE any network touch — including a token refresh.
    ensureUsable: async () => {
      if (await service.isAccountCooling()) {
        throw codexError({
          code: "codex_account_cooling",
          message: "Codex 订阅额度已用尽，冷却中，请稍后再试。",
          httpStatus: 429,
          retryable: false,
        });
      }
    },

    /**
     * Level 1 of the background recovery probe: report the parked window so the
     * core skips the network call for an account that cannot answer yet.
     */
    probeAccountState: async () => {
      if (!(await service.isAccountCooling())) return { available: true };
      // Surface the reset epoch when the status carries one, so the core waits for
      // the real window instead of re-checking on a fixed interval.
      let parkedUntil: number | undefined;
      try {
        const status: any = await service.getStatus?.();
        const candidate = status?.cooldownUntil ?? status?.rateLimitCooldownUntil ?? status?.resetsAt;
        if (typeof candidate === "number" && candidate > Date.now()) parkedUntil = candidate;
      } catch {
        // Status is best-effort; parking without an epoch is still correct.
      }
      return { available: false, reason: "account_cooling", parkedUntil };
    },

    /**
     * Level 2: prove the account is alive AND reachable. `getUsage()` is the
     * cheapest authenticated call that exercises the same token path as a chat, so
     * a restored model is one the next real turn can actually use. A null answer
     * means "could not confirm", which must keep the circuit open rather than
     * restore a model on a guess.
     */
    probeLiveness: async () => {
      const usage = await service.getUsage?.();
      return new Response(JSON.stringify(usage ?? null), {
        status: usage ? 200 : 503,
        headers: { "content-type": "application/json" },
      });
    },

    // Pin the upstream: a config-supplied base_url can never win, a redirect
    // away from the fixed origin is an error, and the fixed origin ignores
    // CCR/proxy environment routing. Fixed subscription origins honor the
    // explicit SUBSCRIPTION_PROXY_URL opt-in: chatgpt.com answers through the
    // subscription dispatcher when one is configured. The plain direct agent
    // stays the fallback for hosts that predate the opt-in seam — and it is
    // also why tonight's direct-route middlebox could strip response headers
    // and hand the SSE parser undecodable bodies (every turn judged empty).
    lockUpstream: async (config: any) => {
      config.url = CODEX_UPSTREAM_URL;
      config.redirect = "error";
      config.dispatcher = options.host.getSubscriptionDispatcher?.() ?? options.host.getDirectDispatcher();
    },

    // Called AFTER the body is final: session headers derive from it.
    signRequest: async ({ headers, requestBody }) => {
      const accessToken = await service.getAccessToken();
      const accountId = await Promise.resolve().then(() => service.getAccountId()).catch(() => undefined);
      const injected = codexAccountHeaders({ accessToken, accountId, requestBody });
      const injectedNames = new Set(Object.keys(injected).map((k) => k.toLowerCase()));
      const next: Record<string, string> = {};
      for (const [key, value] of Object.entries(headers ?? {})) {
        const lower = key.toLowerCase();
        if (STRIPPED.has(lower)) continue;
        // The runtime returns "the headers object to send": a client-supplied
        // identity header under a different case must not survive as a second
        // entry, or any consumer building Headers/map from this object joins
        // both values into one field (spoof rides along).
        if (injectedNames.has(lower)) continue;
        next[key] = value;
      }
      return { ...next, ...injected };
    },

    classifyError: (status: number, body: unknown, systemText: string): PluginClassifiedError | null => {
      // Send-level failures (0) stay unclassified: the core's safe default is a
      // retryable one-shot retry for transient network faults.
      if (status === 0) return null;
      let parsed: any = body;
      if (typeof parsed === "string") {
        try { parsed = JSON.parse(parsed); } catch { /* keep raw */ }
      }
      // A's canonical classifier returns the exact core taxonomy accepted by
      // the service whitelist (codex_usage_limit/codex_overloaded/…). The only
      // normalisation is making the retryable decision explicit: an omitted
      // flag means non-retryable (quota/reauth/4xx), never a core default retry.
      const classified = classifyCodexError(status, parsed ?? body, systemText);
      return classified && { ...classified, retryable: classified.retryable === true };
    },

    noteUpstreamError: async (info: PluginClassifiedError) => {
      // Bookkeeping never throws into the response path.
      try {
        await service.noteUpstreamError({
          code: info.code,
          message: info.message,
          httpStatus: info.httpStatus,
          ...(info.cooldownMs !== undefined ? { cooldownMs: info.cooldownMs } : {}),
          ...(info.validationUrl ? { validationUrl: info.validationUrl } : {}),
          ...(info.retryable !== undefined ? { retryable: info.retryable } : {}),
        });
      } catch (error: any) {
        options.log?.warn(`codex noteUpstreamError failed (code=${info.code}): ${String(error?.message ?? "unknown")}`);
      }
    },

    // One forced refresh + one re-dispatch on 401; the core enforces the
    // exactly-once budget. The service persists a rotated refresh token before
    // switching the in-memory identity.
    authRefresh: {
      forceRefresh: async () => { await service.forceTokenRefresh(); },
    },

    // Token hygiene: never log Codex request/response bodies or headers.
    suppressDebugLog: true,
  };
}
