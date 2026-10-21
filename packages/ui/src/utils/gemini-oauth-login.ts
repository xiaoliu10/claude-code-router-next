import type { GeminiOauthErrorCode, GeminiOauthLoginPollResponse, GeminiOauthLoginStartResponse } from "../types";

/**
 * Gemini subscription (Antigravity OAuth) login contract, UI side.
 *
 * Mirrors the backend's frozen login machine (`docs/design/gemini-provider-contract.md`
 * §1.5): `start` opens one loopback callback server with a 10 minute TTL, `poll`
 * reports pending/success/failed, `cancel` tears the pending attempt down.
 * Everything here is mockable — no network access of its own.
 */
export interface GeminiOauthLoginApi {
  startGeminiOauthLogin(): Promise<GeminiOauthLoginStartResponse>;
  pollGeminiOauthLogin(loginId: string, signal: AbortSignal): Promise<GeminiOauthLoginPollResponse>;
  cancelGeminiOauthLogin(loginId: string): Promise<{ ok?: boolean; success?: boolean }>;
}

/** Poll cadence and hard cap frozen by the contract (§2: 2s interval, 10min). */
export const GEMINI_OAUTH_POLL_INTERVAL_MS = 2_000;
export const GEMINI_OAUTH_LOGIN_DEADLINE_MS = 600_000;

/** Client-side sentinel: the attempt did not finish before the deadline. */
export const GEMINI_OAUTH_LOGIN_EXPIRED: GeminiOauthErrorCode = "gemini_oauth_login_state_rejected";

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new Error("cancelled")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { signal.removeEventListener("abort", abort); abort(); }
  });
}

/** Only an http(s) consent URL may ever reach `window.open`. */
export function isSafeConsentUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || (url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost"));
  } catch {
    return false;
  }
}

export function isGeminiOauthKindValue(value: unknown): boolean {
  return value === "antigravity";
}

export interface GeminiOauthLoginSession {
  /** Resolves with the authorized e-mail on success, null when cancelled. Rejects with `{ reason }` on failure. */
  done: Promise<string | null>;
  cancel: () => Promise<void>;
  /** The consent URL once `start` returned; null before that. */
  url: () => string | null;
}

/**
 * One explicit login only. The caller opens the consent page itself after the
 * risk confirmation; this helper never opens windows and never starts a login
 * on its own. Cancellation also invalidates a job returned by a late start.
 */
export function createGeminiOauthLogin(
  api: GeminiOauthLoginApi,
  onReady: (job: GeminiOauthLoginStartResponse) => void,
  timing = { intervalMs: GEMINI_OAUTH_POLL_INTERVAL_MS, deadlineMs: GEMINI_OAUTH_LOGIN_DEADLINE_MS },
): GeminiOauthLoginSession {
  const controller = new AbortController();
  let job: GeminiOauthLoginStartResponse | null = null;
  let cancellation: Promise<void> | null = null;
  let consentUrl: string | null = null;
  let settled = false;
  // A start scheduled on the next microtask but abandoned before it ran: its
  // promise is resolved with null so no request is ever issued.
  let voidScheduledStart: (() => void) | null = null;
  let expired = false;
  // Bumped by cancel() and by the deadline timer. A change while awaiting start
  // means the user gave up (or time ran out) before we could even poll.
  let cancelGeneration = 0;
  const invalidate = () => {
    if (!job) return Promise.resolve();
    return cancellation ??= api.cancelGeminiOauthLogin(job.loginId).then(() => undefined);
  };
  // Cancel is a no-op body-wise once the attempt settled (its own invalidation
  // already ran); it still aborts so an in-flight poll stops immediately.
  const cancel = async () => {
    ++cancelGeneration;
    controller.abort();
    // An attempt cancelled before it even started requests: void the pending
    // call outright, so `/login/start` is never reached.
    voidScheduledStart?.();
    if (!settled) await invalidate().catch(() => {});
  };
  const rejectExpired = (): never => { throw Object.assign(new Error("login expired"), { reason: GEMINI_OAUTH_LOGIN_EXPIRED }); };
  const deadline = setTimeout(() => { expired = true; ++cancelGeneration; controller.abort(); }, timing.deadlineMs);
  async function attempt(): Promise<string | null> {
    // Started on the next microtask turn (and not before), so an immediate
    // cancel() — the user dismissed the dialog — is observed before `start`
    // is requested. The scheduled start is recorded so cancel() can void it.
    await Promise.resolve();
    try {
      const generationAtStart = cancelGeneration;
      if (controller.signal.aborted || cancelGeneration !== generationAtStart) {
        if (expired) rejectExpired();
        return null;
      }
      const started = await new Promise<GeminiOauthLoginStartResponse | null>((resolve, reject) => {
        voidScheduledStart = () => resolve(null);
        api.startGeminiOauthLogin().then(resolve, reject).finally(() => { voidScheduledStart = null; });
      });
      const abandoned = controller.signal.aborted || cancelGeneration !== generationAtStart;
      if (started && typeof started.loginId === "string" && started.loginId) job = started;
      if (abandoned) {
        // Never poll, never show the link; invalidate a job that arrived late.
        if (expired) rejectExpired();
        return null;
      }
      // Defense in depth: the server validates the origin, the UI still refuses
      // anything that is not a web consent URL or a plausible job. The job above
      // is recorded FIRST so an invalid reply is still invalidated server-side
      // instead of leaving a live loopback server behind, and the consent URL
      // that reaches the component is only ever the re-validated one.
      if (!started || !started.loginId || !isSafeConsentUrl(started.url) || !Number.isFinite(started.expiresAt)) {
        throw Object.assign(new Error("invalid login response"), { reason: GEMINI_OAUTH_LOGIN_EXPIRED });
      }
      consentUrl = started.url;
      onReady(started);
      while (!controller.signal.aborted) {
        let result: GeminiOauthLoginPollResponse;
        try {
          result = await api.pollGeminiOauthLogin(started.loginId, controller.signal);
        } catch (error) {
          // An abort tears the poll down with the transport's own error; that
          // is not a server verdict, so the loop exits through the deadline /
          // cancel branch below instead of surfacing "cancelled".
          if (controller.signal.aborted) break;
          throw error;
        }
        if (controller.signal.aborted) break;
        if (result.status === "success") return result.email ?? "";
        if (result.status === "failed") throw Object.assign(new Error("login failed"), { reason: result.error || "request_failed" });
        if (Date.now() >= started.expiresAt) { expired = true; break; }
        try {
          await wait(timing.intervalMs, controller.signal);
        } catch (error) {
          if (controller.signal.aborted) break;
          throw error;
        }
      }
      if (controller.signal.aborted) {
        // Aborted by the deadline expiry (cancel already reports null itself).
        return expired ? rejectExpired() : null;
      }
      return rejectExpired();
    } finally {
      clearTimeout(deadline);
    }
  }
  const done = attempt().then(async result => {
    // Settled: a finished attempt never leaves a dangling loopback server
    // behind. An explicit cancel() owns the invalidation when it races us.
    settled = true;
    await invalidate().catch(() => {});
    return result;
  }, async error => {
    settled = true;
    await invalidate().catch(() => {});
    throw error;
  });
  // The component decides how to surface failures; this keeps an unhandled
  // rejection from escaping on unmount-time cancellation.
  done.catch(() => {});
  return { done, cancel, url: () => consentUrl };
}
