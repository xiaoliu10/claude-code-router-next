/**
 * TTL-cached polling of the managed-runtime `fetchQuota` seam.
 *
 * Managed subscription plugins own authenticated quota endpoints (e.g. the
 * Gemini OAuth billing API). The core must not hit such an endpoint on every
 * UI refresh of /api/providers/quota, so each provider name keeps one entry
 * refreshed at most once per PLUGIN_QUOTA_TTL_MS. The cache is in-memory only:
 * quota figures are transient, and the periodic active-probe loop repopulates
 * it after a restart.
 *
 * The polling result is handed to the shared quota store, which makes the
 * plugin seam a single data source alongside the built-in quota adapters —
 * the admin route's existing stored-result merge is the only read path.
 */
import type { ProviderQuotaFigures } from "../provider-plugins/types";
import type { LLMProvider } from "../types/llm";
import { storeQuotaResult } from "./quota-store";

/** Per-provider refresh interval for the plugin quota seam. */
export const PLUGIN_QUOTA_TTL_MS = 60_000;

/**
 * Upper bound the /api/providers/quota route waits for an on-demand plugin
 * poll. A blackholed proxy must not hang the admin endpoint: when the budget
 * elapses the route serves the stored figures and the in-flight poll still
 * lands in the store for the next request.
 */
export const PLUGIN_QUOTA_INLINE_BUDGET_MS = 2_500;

interface CacheEntry {
  /** Epoch ms of the last settled (success, null or failed) poll. */
  fetchedAt: number;
  /** Serializes concurrent polls so only one upstream call is in flight. */
  pending?: Promise<void>;
}

const cache = new Map<string, CacheEntry>();

/** Test-only: drop every cached entry so timings stay deterministic. */
export function resetPluginQuotaCache(): void {
  cache.clear();
}

/** Whether the provider's entry is still inside its TTL window. */
export function hasFreshPluginQuota(providerName: string, now: number = Date.now()): boolean {
  const entry = cache.get(providerName);
  return !!entry && now - entry.fetchedAt < PLUGIN_QUOTA_TTL_MS;
}

/**
 * Poll a managed runtime's quota seam for one provider.
 *
 * Behaviour contract:
 * - an in-flight poll is joined instead of duplicated, and a fresh TTL entry
 *   resolves without another upstream call;
 * - a figures result is written through the shared quota store, so the admin
 *   route's 5h/7d mapping applies unchanged;
 * - a null result or a rejected seam call means "no data" — the entry is
 *   still stamped so the TTL backs off retries, and the error never escapes
 *   into the response path.
 */
export async function pollPluginQuota(
  providerName: string,
  provider: LLMProvider,
  runtime: { fetchQuota?(provider: LLMProvider): Promise<ProviderQuotaFigures | null> }
): Promise<void> {
  if (!providerName || typeof runtime.fetchQuota !== "function") return;

  const existing = cache.get(providerName);
  // A poll already in flight: join it instead of issuing a parallel one. This
  // check must run BEFORE the TTL check, whose freshness stamp is only written
  // when the in-flight poll settles.
  if (existing?.pending) return existing.pending;
  if (existing && Date.now() - existing.fetchedAt < PLUGIN_QUOTA_TTL_MS) return;

  const entry: CacheEntry = existing ?? { fetchedAt: 0 };
  entry.pending = (async () => {
    try {
      const figures = await runtime.fetchQuota!(provider);
      if (figures) {
        storeQuotaResult(providerName, figures);
      }
    } catch {
      // A failing quota endpoint must never break the quota route or the
      // active-probe loop; the next TTL window retries silently.
    } finally {
      entry.fetchedAt = Date.now();
      entry.pending = undefined;
    }
  })();

  cache.set(providerName, entry);
  return entry.pending;
}
