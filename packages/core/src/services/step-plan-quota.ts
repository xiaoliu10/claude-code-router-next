import { createHash } from "node:crypto";
import type { ConfigProvider } from "../types/llm";
import { getProxyDispatcher, resolveProviderProxyUrl } from "./proxy";

const BASE = "https://api.stepfun.com/step_plan/v1";
const INFERENCE_URLS = new Set([BASE, `${BASE}/`, `${BASE}/chat/completions`, `${BASE}/chat/completions/`]);
const TTL_MS = 60_000;
const MAX_STALE_MS = 5 * TTL_MS;
const MAX_RETRY_MS = 15 * TTL_MS;
const TIMEOUT_MS = 2_500;

export interface StepPlanQuota {
  state: "known" | "partial" | "stale" | "unavailable";
  family: "token" | "coding" | "none";
  name: string | null;
  observedAt: number | null;
  allowed: boolean | null;
  windows: Array<{
    id: "five_hour" | "weekly";
    limited: boolean;
    usedPercent: number | null;
    resetsAt: number | null;
  }>;
  creditBuckets: Array<{
    type: "subscription" | "topup";
    total: string;
    remaining: string;
    usedPercent: number | null;
    resetsAt: number | null;
    expiresAt: number | null;
  }>;
}

function unavailable(): StepPlanQuota {
  return { state: "unavailable", family: "none", name: null, observedAt: null, allowed: null, windows: [], creditBuckets: [] };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function timestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 8.64e15 ? value : null;
}

function percent(value: unknown): number | null {
  return typeof value === "number" && value >= 0 && value <= 100 ? value : null;
}

function decimal(value: unknown): value is string {
  return typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value);
}

function decodeStepPlanQuota(value: unknown): StepPlanQuota {
  const raw = record(value);
  const plan = record(raw.plan);
  const quota = record(raw.quota);
  const observedAt = timestamp(raw.observed_at_ms);
  if (raw.schema_version !== 1 || raw.scope !== "personal_account" || !observedAt || observedAt > Date.now() + 120_000 ||
      (plan.family !== "coding" && plan.family !== "token" && plan.family !== "none") ||
      (quota.state !== "known" && quota.state !== "partial")) return unavailable();

  const snapshot: StepPlanQuota = {
    state: quota.state,
    family: plan.family,
    name: typeof plan.name === "string" ? plan.name.trim().slice(0, 256) || null : null,
    observedAt,
    allowed: typeof quota.allowed === "boolean" ? quota.allowed : null,
    windows: [],
    creditBuckets: [],
  };
  if (snapshot.allowed === null || plan.state === "unavailable") snapshot.state = "partial";

  if (plan.family === "coding") {
    for (const value of Array.isArray(quota.windows) ? quota.windows : []) {
      const w = record(value);
      if ((w.id !== "five_hour" && w.id !== "weekly") || typeof w.limited !== "boolean" ||
          snapshot.windows.some(window => window.id === w.id)) {
        snapshot.state = "partial";
        continue;
      }
      const usedPercent = w.limited ? percent(w.used_percent) : null;
      if (w.limited && usedPercent === null) snapshot.state = "partial";
      snapshot.windows.push({ id: w.id, limited: w.limited, usedPercent, resetsAt: timestamp(w.resets_at_ms) });
    }
    if (snapshot.windows.length !== 2) snapshot.state = "partial";
  }
  if (plan.family === "token") {
    if (!Array.isArray(quota.credit_buckets)) snapshot.state = "partial";
    for (const value of Array.isArray(quota.credit_buckets) ? quota.credit_buckets : []) {
      const b = record(value);
      if ((b.type !== "subscription" && b.type !== "topup") || !decimal(b.total) || !decimal(b.remaining)) {
        snapshot.state = "partial";
        continue;
      }
      snapshot.creditBuckets.push({
        type: b.type, total: b.total, remaining: b.remaining, usedPercent: percent(b.used_percent),
        resetsAt: timestamp(b.resets_at_ms), expiresAt: timestamp(b.expires_at_ms),
      });
    }
  }
  return snapshot;
}

// Bound bytes before parsing, including chunked responses without Content-Length.
async function readSnapshot(response: Response): Promise<StepPlanQuota> {
  if (!response.body) return unavailable();
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 256 * 1024) {
        void reader.cancel().catch(() => {});
        return unavailable();
      }
      chunks.push(Buffer.from(value));
    }
    return decodeStepPlanQuota(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } finally {
    reader.releaseLock();
  }
}

function retryDelay(header: string | null): number {
  if (!header) return TTL_MS;
  const delay = /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now();
  return Number.isNaN(delay) ? TTL_MS : Math.max(1000, Math.min(delay, MAX_RETRY_MS));
}

interface Entry {
  identity: string;
  snapshot: StepPlanQuota;
  retryAt: number;
  receivedAt: number;
  pending?: Promise<void>;
}

type Provider = Pick<ConfigProvider, "name" | "enabled" | "api_key" | "api_base_url" | "proxy_enabled">;

/** Route-local account snapshots. These must never enter the model quota/health store. */
export class StepPlanQuotaCache {
  private readonly entries = new Map<string, Entry>();

  async poll(providers: Provider[], config: Parameters<typeof resolveProviderProxyUrl>[0]): Promise<Map<string, StepPlanQuota>> {
    const eligible = providers.filter(p => p?.name && p.enabled !== false && INFERENCE_URLS.has(p.api_base_url));
    const names = new Set(eligible.map(p => p.name));
    for (const name of this.entries.keys()) {
      if (!names.has(name)) this.entries.delete(name);
    }
    const snapshots = new Map<string, StepPlanQuota>();
    await Promise.all(eligible.map(async provider => {
      const proxy = resolveProviderProxyUrl(config, provider);
      const identity = createHash("sha256").update(JSON.stringify([provider.api_base_url, provider.api_key, proxy])).digest("hex");
      let entry = this.entries.get(provider.name);
      if (!entry || entry.identity !== identity) {
        entry = { identity, snapshot: unavailable(), retryAt: 0, receivedAt: 0 };
        this.entries.set(provider.name, entry);
      }
      if (typeof provider.api_key === "string" && provider.api_key && !entry.pending && Date.now() >= entry.retryAt) {
        const current = entry;
        current.pending = this.refresh(current, provider.api_key, proxy).finally(() => { current.pending = undefined; });
      }
      await entry.pending;
      // A concurrent request may have removed this provider or changed its credentials.
      if (this.entries.get(provider.name) !== entry) return;
      const { snapshot } = entry;
      if (snapshot.state === "stale" && Date.now() - entry.receivedAt > MAX_STALE_MS) entry.snapshot = unavailable();
      snapshots.set(provider.name, entry.snapshot);
    }));
    return snapshots;
  }

  private async refresh(entry: Entry, key: string, proxy?: string): Promise<void> {
    let delay = TTL_MS;
    try {
      const response = await fetch(`${BASE}/usage`, {
        method: "GET", redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { Accept: "application/json", "Accept-Encoding": "identity", Authorization: `Bearer ${key}` },
        ...(proxy && { dispatcher: getProxyDispatcher(proxy) }),
      });
      if (response.ok) {
        entry.snapshot = await readSnapshot(response);
        entry.receivedAt = Date.now();
        return;
      }
      void response.body?.cancel().catch(() => {});
      if (response.status === 401 || response.status === 403) {
        entry.snapshot = unavailable();
        return;
      }
      if (response.status === 429) delay = retryDelay(response.headers.get("Retry-After"));
    } catch {
      // Network, proxy and JSON failures share the bounded stale fallback.
    } finally {
      entry.retryAt = Date.now() + delay;
    }
    if (entry.snapshot.observedAt !== null) entry.snapshot = { ...entry.snapshot, state: "stale" };
  }
}
