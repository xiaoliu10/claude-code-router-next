/** CN daily check-in, adapted from magpie's meter/checkinOf. */
import {
  credentialHeaders, readWorkBuddyResponseText, workBuddySite,
  WORKBUDDY_CHECKIN_STATUS_PATH, WORKBUDDY_CHECKIN_CLAIM_PATH,
  WORKBUDDY_RESOURCE_SUMMARY_PATH,
  type WorkBuddyCredential, type WorkBuddyFetch,
} from "./protocol";

export interface WorkBuddyCheckinResult {
  outcome: "claimed" | "done" | "inactive" | "ineligible" | "failed";
  credit?: number;
  streak?: number;
  message?: string;
}

/** Identity captured with the credential used for this operation. */
export interface WorkBuddyCheckinResponse extends WorkBuddyCheckinResult {
  uid: string | null;
}

export class WorkBuddyActiveAccountChangedError extends Error {
  constructor() { super("workbuddy_active_account_changed"); }
}

class MeterError extends Error {
  constructor(readonly status: number, readonly code = 0) {
    // Never echo an upstream body: it can contain tokens or other secrets.
    super(`WorkBuddy check-in failed (HTTP ${status}${code ? `, code ${code}` : ""})`);
  }
}
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const positive = (value: unknown): number | undefined => {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/** Only fetch rejection means no response; body/JSON failures are read replies. */
export async function checkinOf(
  credential: WorkBuddyCredential,
  fetchImpl: WorkBuddyFetch,
  dispatcher: unknown,
  { waits = [2000, 4000] }: { waits?: readonly number[] } = {},
): Promise<WorkBuddyCheckinResult> {
  if (credential.kind !== "workbuddy") return { outcome: "inactive" };
  const meter = async (path: string): Promise<Record<string, unknown>> => {
    let response: Response;
    try {
      response = await fetchImpl(workBuddySite(credential.kind).origin + path, {
        method: "POST", body: "{}", redirect: "error", signal: AbortSignal.timeout(20_000),
        headers: { ...credentialHeaders(credential), Accept: "application/json", "Accept-Encoding": "identity" },
        ...{ dispatcher },
      });
    } catch {
      throw new Error("WorkBuddy check-in received no response");
    }
    let env: Record<string, unknown>;
    try { env = record(JSON.parse(await readWorkBuddyResponseText(response))); }
    catch { throw new MeterError(response.status); }
    // A response with an invalid envelope is an answered failure. Do not
    // coerce JSON objects: their toString/valueOf members may be non-callable.
    if (typeof env.code !== "number" && typeof env.code !== "string") throw new MeterError(response.status);
    const code = Number(env.code);
    if (!Number.isFinite(code) || (typeof env.code === "string" && !env.code.trim())) throw new MeterError(response.status);
    if (!response.ok || response.redirected || code) throw new MeterError(response.status, code);
    return record(env.data);
  };
  const classify = async (error: unknown): Promise<WorkBuddyCheckinResult> => {
    if (!(error instanceof MeterError)) throw error;
    if (error.code === 1001) return { outcome: "done" };
    if (error.code === 1002) return { outcome: "ineligible" };
    if (error.code === 1003) return { outcome: "inactive" };
    if (error.status === 401) {
      // A successful summary proves the token works, but this channel cannot
      // claim. A rejected summary is still a response, never an offline throw.
      try {
        await meter(WORKBUDDY_RESOURCE_SUMMARY_PATH);
        return { outcome: "ineligible", message: "Check-in requires the official WorkBuddy app" };
      } catch { /* Keep the original answered failure, including offline probes. */ }
    }
    return { outcome: "failed", message: error.message };
  };
  let status: Record<string, unknown>;
  try { status = await meter(WORKBUDDY_CHECKIN_STATUS_PATH); }
  catch (error) { return classify(error); }
  if (!status.active) return { outcome: "inactive" };
  if (status.today_checked_in ?? status.todayCheckedIn) {
    const credit = positive(status.today_credit ?? status.daily_credit);
    return { outcome: "done", ...(credit === undefined ? {} : { credit }) };
  }
  for (let attempt = 0; ; attempt++) {
    try {
      const got = await meter(WORKBUDDY_CHECKIN_CLAIM_PATH);
      const credit = positive(got.credit), streak = positive(got.streak_days);
      // Only derived numbers leave the service; even success messages may echo secrets.
      return { outcome: "claimed", ...(credit === undefined ? {} : { credit }), ...(streak === undefined ? {} : { streak }) };
    } catch (error) {
      if (error instanceof MeterError && (error.status >= 500 || error.code === 10000)
          && error.status !== 401 && ![1001, 1002, 1003].includes(error.code) && attempt < Math.min(2, waits.length)) {
        await new Promise(resolve => setTimeout(resolve, Math.max(0, waits[attempt])));
        continue;
      }
      return classify(error);
    }
  }
}
