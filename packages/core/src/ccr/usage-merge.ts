/**
 * Pure helpers for merging per-frame LLM usage into the per-request usage cache.
 *
 * Extracted from index.ts so the merge contract is unit-testable without
 * standing up the whole Fastify server.
 */

export function getUsageCacheReadInputTokens(usage: any): number {
  return (
    usage?.cache_read_input_tokens ??
    usage?.input_tokens_details?.cached_tokens ??
    usage?.prompt_tokens_details?.cached_tokens ??
    0
  );
}

export function getUsageCacheCreationInputTokens(usage: any): number {
  return (
    usage?.cache_creation_input_tokens ??
    usage?.input_tokens_details?.cache_creation_tokens ??
    usage?.input_tokens_details?.cache_write_tokens ??
    usage?.prompt_tokens_details?.cache_creation_tokens ??
    usage?.prompt_tokens_details?.cache_write_tokens ??
    0
  );
}

/**
 * Normalize a raw usage object (from Anthropic, OpenAI Chat Completions, or
 * OpenAI Responses APIs) into a common shape with input_tokens / output_tokens
 * / cache_read_input_tokens / cache_creation_input_tokens fields.
 */
export function normalizeUsagePayload(usage: any): any {
  if (!usage || typeof usage !== "object") return undefined;

  return {
    ...usage,
    ...(usage.kiro_estimated === true || usage.usage_estimated === true ? { usage_estimated: true } : {}),
    input_tokens: usage.input_tokens ?? usage.prompt_tokens ?? 0,
    output_tokens: usage.output_tokens ?? usage.completion_tokens ?? 0,
    cache_read_input_tokens: getUsageCacheReadInputTokens(usage),
    cache_creation_input_tokens: getUsageCacheCreationInputTokens(usage),
  };
}

/**
 * Merge an incoming usage frame into the previously captured usage for a
 * request. Fields are merged so that an all-zero frame canNOT overwrite a real
 * value captured earlier: each field is replaced only when the incoming value
 * is non-zero.
 *
 * Why this matters: some OpenAI-compatible upstreams (e.g. fireworks-hosted
 * GLM-5.2) report real usage on the first chunk (message_start /
 * response.created) but emit an all-zero usage object on the trailing
 * message_delta / response.completed. A plain `{...base, ...incoming}` spread
 * let those zeros clobber the real input_tokens/output_tokens, leaving the
 * whole request recorded as 0/0 in usage stats.
 *
 * `resetBase` should be true on the first frame of a new response
 * (message_start / response.completed) so stale fields from a previous request
 * in the same session don't leak in.
 */
export function mergeUsageCapture(existing: any, incoming: any, resetBase: boolean): any {
  const base = resetBase ? {} : (existing || {});
  const inc = incoming || {};
  return {
    ...base,
    ...(inc.usage_estimated === true || base.usage_estimated === true ? { usage_estimated: true } : {}),
    input_tokens: inc.input_tokens || base.input_tokens || 0,
    output_tokens: inc.output_tokens || base.output_tokens || 0,
    cache_read_input_tokens: inc.cache_read_input_tokens || base.cache_read_input_tokens || 0,
    cache_creation_input_tokens:
      inc.cache_creation_input_tokens || base.cache_creation_input_tokens || 0,
  };
}
