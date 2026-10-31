/**
 * Sequential browser-login session for the Kiro card: one explicit login at
 * a time, one request lane. The loop polls /login/poll on a short interval,
 * bounded by the server-side authorization deadline (10 min) mirrored as a
 * local hard cap. A pasted callback URL rides the SAME loop (never a second
 * concurrent exchange), and a transport-level poll timeout only retries
 * within the deadline — it never aborts an authorization the user may still
 * approve in the browser.
 *
 * Kiro wrinkle vs single-stage OAuth: a portal sign-in may advance to an AWS
 * OIDC stage (the user picks Builder ID / Identity Center inside the portal),
 * so a pending poll can carry a NEW authorization url. Every poll view is
 * forwarded through onUpdate so the card can refresh the rendered link.
 */
import type { KiroLoginMethod, KiroLoginPollView, KiroLoginStartView } from "./card-types";
import { parseKiroLoginPoll, parseKiroLoginStart, sanitizeKiroErrorCode } from "./card-types";

/** Stable local sentinel for a poll that hit its transport timeout. */
export const KIRO_POLL_TIMEOUT = "kiro_poll_timeout";

export interface KiroLoginInput {
  method: KiroLoginMethod;
  startUrl?: string;
  region?: string;
}

export interface KiroLoginApi {
  start(input: KiroLoginInput): Promise<unknown>;
  poll(loginId: string, signal: AbortSignal): Promise<unknown>;
  complete(loginId: string, callbackUrl: string): Promise<unknown>;
  cancel(loginId: string): Promise<unknown>;
}

export interface KiroLoginSession {
  /** Resolves with the connected poll view, or null when cancelled/superseded.
   * Throws a stable-reason error on expiry or terminal failure. */
  done: Promise<KiroLoginPollView | null>;
  /** Abort + invalidate the server job (idempotent). */
  cancel(): Promise<void>;
  /**
   * Submit a pasted callback URL as the loop's next step. Resolves with the
   * complete response, or null when the session is already gone; a rejected
   * paste releases the waiter so the user can paste again while polling.
   */
  submitCallback(callbackUrl: string): Promise<KiroLoginPollView | null>;
}

function isPollTimeout(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as { reason?: unknown }).reason === KIRO_POLL_TIMEOUT;
}

function wait(ms: number, signal: AbortSignal, wakeListeners?: Set<() => void>): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (wake) wakeListeners?.delete(wake);
    };
    const onAbort = () => { cleanup(); reject(new Error("cancelled")); };
    const wake = () => { cleanup(); resolve(); }; // a paste arrival ends the wait early
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
    wakeListeners?.add(wake);
    if (signal.aborted) onAbort();
  });
}

export function createKiroLogin(
  api: KiroLoginApi,
  input: KiroLoginInput,
  onUpdate: (login: KiroLoginStartView & { url: string }) => void,
  timing: { intervalMs?: number; deadlineMs?: number } = {},
): KiroLoginSession {
  const intervalMs = timing.intervalMs ?? 1_200;
  const deadlineMs = timing.deadlineMs ?? 600_000;
  const controller = new AbortController();
  let job: KiroLoginStartView | null = null;
  let cancellation: Promise<unknown> | null = null;
  let expired = false;
  let pasteUrl: string | null = null;
  let pasteWaiter: ((result: KiroLoginPollView | null) => void) | null = null;
  let startedAt = 0;
  let currentUrl = "";
  const wakeListeners = new Set<() => void>();

  const invalidate = (): Promise<unknown> => {
    if (!job) return Promise.resolve();
    return cancellation ??= api.cancel(job.loginId).catch(() => undefined);
  };
  const cancel = async (): Promise<void> => {
    controller.abort();
    resolvePasteWaiter(null);
    await invalidate();
  };
  /** Resolve a pending pasted callback exactly once (closure-narrowing safe). */
  const resolvePasteWaiter = (result: KiroLoginPollView | null): void => {
    const waiter = pasteWaiter;
    pasteWaiter = null;
    waiter?.(result);
  };
  const submitCallback = (callbackUrl: string): Promise<KiroLoginPollView | null> => {
    if (!job || controller.signal.aborted) return Promise.resolve(null);
    return new Promise(resolve => {
      pasteUrl = callbackUrl;
      pasteWaiter?.(null); // an earlier unanswered paste is superseded
      pasteWaiter = resolve;
      for (const wake of [...wakeListeners]) wake();
    });
  };
  const hardDeadline = (): number => startedAt + deadlineMs;

  const done = (async (): Promise<KiroLoginPollView | null> => {
    let connected = false;
    try {
      startedAt = Date.now();
      const start = parseKiroLoginStart(await api.start(input));
      if (!start) throw Object.assign(new Error("invalid login response"), { reason: "login_invalid_response" });
      job = start;
      currentUrl = start.url;
      // A cancel that raced the in-flight start must still invalidate the
      // freshly created server-side job.
      if (controller.signal.aborted) { await invalidate(); return null; }
      onUpdate({ ...start, url: currentUrl });
      while (!controller.signal.aborted) {
        if (Date.now() >= hardDeadline()) { expired = true; break; }
        // Pop the paste pair BEFORE awaiting so a second paste submitted
        // mid-flight waits for the following iteration instead of stealing
        // this response.
        const paste: { url: string; waiter: ((result: KiroLoginPollView | null) => void) | null } | null =
          pasteUrl !== null ? { url: pasteUrl, waiter: pasteWaiter } : null;
        if (paste) { pasteUrl = null; pasteWaiter = null; }
        let result: KiroLoginPollView;
        try {
          result = parseKiroLoginPoll(
            paste ? await api.complete(job.loginId, paste.url) : await api.poll(job.loginId, controller.signal),
          ) as KiroLoginPollView;
        } catch (error) {
          if (controller.signal.aborted) { paste?.waiter?.(null); break; }
          if (isPollTimeout(error) || paste) {
            // Keep polling: the server verdict still arrives; free the paste
            // waiter so another paste can be submitted.
            paste?.waiter?.(null);
            if (Date.now() >= hardDeadline()) { expired = true; break; }
            await wait(intervalMs, controller.signal, wakeListeners);
            continue;
          }
          throw error;
        }
        if (controller.signal.aborted) { paste?.waiter?.(null); break; }
        // Fail closed on malformed payloads: retry within the deadline.
        if (!result) {
          paste?.waiter?.(null);
          if (Date.now() >= hardDeadline()) { expired = true; break; }
          await wait(intervalMs, controller.signal, wakeListeners);
          continue;
        }
        // Portal → AWS stage advance: surface the fresh authorization url.
        if (result.status === "pending" && result.url && result.url !== currentUrl) {
          currentUrl = result.url;
          onUpdate({ ...job, url: currentUrl });
        }
        paste?.waiter?.(result);
        if (result.status === "complete") { connected = true; return result; }
        if (result.status === "cancelled") return null;
        if (result.status === "expired") { expired = true; break; }
        if (result.status === "failed" && !paste) {
          // A terminal poll failure is a server verdict (stable code only).
          // A REJECTED PASTE only surfaces to its waiter: the session stays
          // alive and the user may paste again while polling continues.
          throw Object.assign(new Error("login failed"), { reason: sanitizeKiroErrorCode(result.error) ?? "login_failed" });
        }
        await wait(intervalMs, controller.signal, wakeListeners);
      }
      return null;
    } catch (error) {
      if (!controller.signal.aborted) throw error;
      return null;
    } finally {
      resolvePasteWaiter(null);
      if (!connected) await invalidate();
      if (expired) throw Object.assign(new Error("login expired"), { reason: "login_expired" });
    }
  })();

  return { done, cancel, submitCallback };
}
