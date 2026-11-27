interface UsageTokenCounts {
  inputTokens: number;
  effectiveInputTokens?: number | null;
  historicalInputTokens?: number | null;
  outputTokens: number;
  cacheReadInputTokens?: number | null;
  cacheCreationInputTokens?: number | null;
}

export function usageTokens(row: UsageTokenCounts) {
  const read = row.cacheReadInputTokens ?? 0;
  const write = row.cacheCreationInputTokens ?? 0;
  // With no recorded cache activity both historical input conventions agree.
  const inclusive = row.effectiveInputTokens === undefined && read === 0 && write === 0
    ? row.inputTokens : row.effectiveInputTokens;
  return {
    cacheMissInput: inclusive == null ? null : inclusive - read,
    total: inclusive == null ? null : inclusive + row.outputTokens,
    hitRate: inclusive != null && inclusive > 0 ? read / inclusive : null,
  };
}

interface SummaryCoverage {
  successCount: number;
  coveredRequests?: number;
  coveredInputTokens?: number;
  coveredOutputTokens?: number;
  coveredCacheReadTokens?: number;
  coveredEstimatedCount?: number;
  estimatedCount?: number;
  byDay: Record<string, UsageTokenCounts>;
}

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

// Only the gateway can distinguish inclusive and net input within a mixed bucket.
export function displayedUsageTotal(row: UsageTokenCounts) {
  const { total } = usageTokens(row);
  if (total !== null) return total;
  if (!isCount(row.historicalInputTokens) || !isCount(row.outputTokens)) return null;
  const historicalTotal = row.historicalInputTokens + row.outputTokens;
  return isCount(historicalTotal) ? historicalTotal : null;
}

// Legacy gateways only expose a normalized sum for fully accounted day buckets.
// Use the same subset for output, cache reads and the hit-rate denominator.
export function partialSummary(s: SummaryCoverage) {
  const { coveredRequests: n, coveredInputTokens: input, coveredOutputTokens: output, coveredCacheReadTokens: read } = s;
  if (isCount(n) && n > 0 && n < s.successCount && isCount(input) && isCount(output) && isCount(read) && read <= input) {
    return { total: input + output, hitRate: input > 0 ? read / input : null,
      estimated: (s.coveredEstimatedCount ?? s.estimatedCount ?? 0) > 0, requests: n, days: [] as string[] };
  }
  let inputs = 0, outputs = 0, reads = 0;
  const days: string[] = [];
  for (const [day, row] of Object.entries(s.byDay || {}).sort(([a], [b]) => a.localeCompare(b))) {
    const effective = row.effectiveInputTokens;
    const cached = row.cacheReadInputTokens;
    if (!isCount(effective) || !isCount(row.outputTokens) || !isCount(cached) || cached > effective) continue;
    days.push(day);
    inputs += effective;
    outputs += row.outputTokens;
    reads += cached;
  }
  if (!days.length) return null;
  return { total: inputs + outputs, hitRate: inputs > 0 ? reads / inputs : null,
    estimated: false, requests: null, days };
}
