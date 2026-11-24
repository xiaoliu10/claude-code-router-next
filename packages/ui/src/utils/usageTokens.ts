interface UsageTokenCounts {
  inputTokens: number;
  effectiveInputTokens?: number | null;
  outputTokens: number;
  cacheReadInputTokens?: number | null;
  cacheCreationInputTokens?: number | null;
}

export function usageTokens(row: UsageTokenCounts) {
  const read = row.cacheReadInputTokens ?? 0;
  const write = row.cacheCreationInputTokens ?? 0;
  // With no recorded cache activity both historical input conventions agree.
  const inclusive = row.effectiveInputTokens ?? (read === 0 && write === 0 ? row.inputTokens : null);
  return {
    cacheMissInput: inclusive === null ? null : inclusive - read,
    total: inclusive === null ? null : inclusive + row.outputTokens,
    hitRate: inclusive !== null && inclusive > 0 ? read / inclusive : null,
  };
}
