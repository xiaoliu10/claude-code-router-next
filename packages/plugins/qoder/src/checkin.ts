import type { PluginHostCapabilities } from "./core-types";
import { qoderSite, type QoderSiteId } from "./protocol";

export interface QoderCheckinResult {
  outcome: "claimed" | "done" | "inactive" | "ineligible" | "failed";
  credit?: number;
  message?: string;
}
export interface CheckinCredential {
  access: string;
  deviceToken?: string;
}
export interface CheckinOptions {
  site: QoderSiteId;
  host: Pick<PluginHostCapabilities, "getSubscriptionDispatcher" | "getDirectDispatcher">;
  fetch?: typeof fetch;
  /** Only genuine runtime-info headers belong here; never fabricate identity. */
  machine?: Readonly<Record<string, string>>;
  /** The owner must serialize and persist device-token rotation. PATs never use it. */
  refreshDeviceToken?: () => Promise<string>;
  now?: () => number;
}

const CAMPAIGNS = "/sash/api/v1/me/campaigns";
const failed = (message: string): QoderCheckinResult => ({ outcome: "failed", message });
const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const creditOf = (benefit: unknown): { credit?: number } => {
  const amount = record(benefit).amount;
  const n = typeof amount === "number" || typeof amount === "string" ? Number(amount) : NaN;
  return Number.isFinite(n) && n > 0 ? { credit: n } : {};
};
/** Only RFC3339-shaped strings parse as dates (reference `when()`'s anchored
 *  regex); "0", "123", date-only text and other junk mean an open-ended
 *  window, not an absurd 1970/2000 timestamp. */
const RFC3339 = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/i;
const at = (v: unknown): number | undefined => {
  if (typeof v === "string" && RFC3339.test(v)) {
    const date = Date.parse(v);
    return Number.isFinite(date) ? date : undefined;
  }
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n < 1e12 ? n * 1000 : n : undefined;
};

/** Manual campaigns transaction; no scheduler, port pool or chat bookkeeping. */
export async function checkinQoder(credential: CheckinCredential, options: CheckinOptions): Promise<QoderCheckinResult> {
  const machine = options.machine ?? {};
  // International campaigns require the signed native identity. CN explicitly
  // permits an empty identity, including for PAT job-token accounts.
  if (options.site === "qoder" && (!machine["Cosy-MachineToken"] || !machine["Cosy-MachineType"])) {
    return { outcome: "ineligible", message: "International check-in requires Qoder desktop device identity" };
  }
  const origin = qoderSite(options.site).openapi;
  let token = credential.deviceToken || credential.access;
  if (!token) return failed("Check-in requires a connected account");
  let rotated = false;
  const network = options.fetch ?? fetch;
  const call = async (url: string, method: "GET" | "POST"): Promise<Response> => {
    const request = () => network(url, {
      method, redirect: "error", signal: AbortSignal.timeout(20_000),
      dispatcher: options.host.getSubscriptionDispatcher?.() ?? options.host.getDirectDispatcher(),
      headers: { ...machine, Accept: "application/json", "Accept-Encoding": "identity", "Content-Type": "application/json", Authorization: `Bearer ${token}`, "Cosy-ClientType": "10", "User-Agent": "Qoder" },
      ...(method === "POST" ? { body: "{}" } : {}),
    } as RequestInit);
    let response = await request();
    if ((response.status === 401 || response.status === 403) && credential.deviceToken && options.refreshDeviceToken && !rotated) {
      rotated = true;
      await response.body?.cancel();
      token = await options.refreshDeviceToken();
      if (!token) throw new Error("missing rotated token");
      response = await request();
    }
    return response;
  };
  try {
    const listResponse = await call(origin + CAMPAIGNS, "GET");
    if (listResponse.status !== 200) { await listResponse.body?.cancel(); return failed(`Campaigns: HTTP ${listResponse.status}`); }
    let list: Record<string, unknown>;
    try { list = record(await listResponse.json()); } catch { return failed("Campaigns: unreadable reply"); }
    if (!Array.isArray(list.campaigns)) return failed("Campaigns: invalid reply");
    const campaigns = list.campaigns.map(record).filter(c => c.actionType === "CLAIM_BENEFIT");
    const campaign = campaigns.find(c => c.claimStatus === "CLAIMABLE");
    if (!campaign) {
      const now = options.now?.() ?? Date.now();
      const done = campaigns.find(c => c.claimStatus === "CLAIMED" && (at(c.startAt) ?? -Infinity) <= now && now < (at(c.endAt) ?? Infinity));
      return done ? { outcome: "done", ...creditOf(done.benefit) } : { outcome: "inactive" };
    }
    if (typeof campaign.campaignId !== "string" || !campaign.campaignId || campaign.campaignId.length > 1024) return failed("Campaigns: missing campaign id");
    const claimResponse = await call(`${origin}${CAMPAIGNS}/${encodeURIComponent(campaign.campaignId)}/claim`, "POST");
    if (claimResponse.status !== 200) { await claimResponse.body?.cancel(); return failed(`Claim: HTTP ${claimResponse.status}`); }
    let claim: Record<string, unknown>;
    try { claim = record(await claimResponse.json()); } catch { return failed("Claim: unreadable reply"); }
    const data = record(claim.data);
    if ((claim.status ?? data.status) !== "CLAIMED") return failed("Claim: unexpected reply");
    return { outcome: "claimed", ...creditOf(claim.benefit ?? data.benefit ?? campaign.benefit) };
  } catch {
    // Neither transport errors nor upstream bodies may echo tokens to the UI.
    return failed("Check-in request failed");
  }
}
