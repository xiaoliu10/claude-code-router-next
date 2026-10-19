import type { WorkBuddyKind, WorkBuddyLoginPollResponse, WorkBuddyLoginStartResponse, WorkBuddyMutationResponse } from "../types";

interface LoginApi {
  startWorkBuddyLogin(site: WorkBuddyKind): Promise<WorkBuddyLoginStartResponse>;
  pollWorkBuddyLogin(site: WorkBuddyKind, loginId: string, signal: AbortSignal): Promise<WorkBuddyLoginPollResponse>;
  cancelWorkBuddyLogin(site: WorkBuddyKind, loginId: string): Promise<{ success: boolean }>;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new Error("cancelled")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { signal.removeEventListener("abort", abort); abort(); }
  });
}

/** One explicit login only. Cancellation also invalidates a job returned by a late start. */
export function createWorkBuddyLogin(
  api: LoginApi,
  site: WorkBuddyKind,
  onReady: (login: WorkBuddyLoginStartResponse) => void,
  timing = { intervalMs: 1_200, deadlineMs: 300_000 },
) {
  const controller = new AbortController();
  let job: WorkBuddyLoginStartResponse | null = null;
  let cancellation: Promise<void> | null = null;
  let expired = false;
  const invalidate = () => {
    if (!job) return Promise.resolve();
    return cancellation ??= api.cancelWorkBuddyLogin(site, job.loginId).then(result => {
      if (!result.success) throw new Error("cancel failed");
    });
  };
  const cancel = async () => {
    controller.abort();
    await invalidate();
  };
  const deadline = setTimeout(() => { expired = true; controller.abort(); }, timing.deadlineMs);
  const done = (async (): Promise<WorkBuddyMutationResponse | null> => {
    let connected = false;
    try {
      job = await api.startWorkBuddyLogin(site);
      if (controller.signal.aborted) return null;
      // The server validates the origin; defense in depth prevents unsafe href schemes.
      if (job.ok !== true || job.site !== site || !job.loginId || new URL(job.url).protocol !== "https:" || !Number.isFinite(job.expiresAt)) {
        throw new Error("invalid login response");
      }
      onReady(job);
      while (!controller.signal.aborted) {
        if (Date.now() >= job.expiresAt) { expired = true; break; }
        const result = await api.pollWorkBuddyLogin(site, job.loginId, controller.signal);
        if (controller.signal.aborted) break;
        if (result.status === "connected") { connected = true; return result; }
        if (result.status === "failed") throw Object.assign(new Error("login failed"), { reason: result.reason });
        if (result.status === "expired" || result.status === "none") { expired = true; break; }
        await wait(timing.intervalMs, controller.signal);
      }
      return null;
    } catch (error) {
      if (!controller.signal.aborted) throw error;
      return null;
    } finally {
      clearTimeout(deadline);
      if (!connected) await invalidate();
      if (expired) throw Object.assign(new Error("login expired"), { reason: "login_expired" });
    }
  })();
  return { done, cancel };
}
