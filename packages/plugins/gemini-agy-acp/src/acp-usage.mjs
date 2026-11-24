function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function chatUsage(prompt, completion) {
  const total = prompt + completion;
  if (!Number.isSafeInteger(total)) return undefined;
  return { usage_source: 'gemini-agy-acp', prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
}

// OpenAI prompt and completion counts include their respective detail counters.
export function promptUsage(result) {
  const standard = result.usage;
  const input = count(standard?.inputTokens);
  const output = count(standard?.outputTokens);
  if (input === undefined || output === undefined) {
    // Quota already reports gross counts. Do not mix them with standard ACP counters.
    const quota = result._meta?.quota?.token_count;
    const quotaInput = count(quota?.input_tokens);
    const quotaOutput = count(quota?.output_tokens);
    return quotaInput === undefined || quotaOutput === undefined ? undefined : chatUsage(quotaInput, quotaOutput);
  }

  const read = count(standard.cachedReadTokens);
  const write = count(standard.cachedWriteTokens);
  const thought = count(standard.thoughtTokens);
  const total = count(standard.totalTokens);
  const cache = (read ?? 0) + (write ?? 0);
  const thoughts = thought ?? 0;
  let prompt = input + cache;
  let completion = output >= thoughts ? output : output + thoughts;
  if (standard.totalTokens !== undefined) {
    if (total === undefined) return undefined;
    // Input can exclude both cache buckets, include reads only, or include both.
    // Output can include or exclude thoughts. The total must identify one split.
    const prompts = new Set([prompt, input + (write ?? 0), input]);
    const completions = new Set([completion, output + thoughts]);
    const matches = [];
    for (const candidate of prompts) {
      if (candidate < cache) continue;
      for (const candidateCompletion of completions) {
        if (candidate + candidateCompletion === total) matches.push([candidate, candidateCompletion]);
      }
    }
    if (matches.length !== 1) return undefined;
    [[prompt, completion]] = matches;
  }

  const usage = chatUsage(prompt, completion);
  if (!usage) return undefined;
  return {
    ...usage,
    ...(read !== undefined || write !== undefined ? { prompt_tokens_details: {
      cached_tokens: read, cache_write_tokens: write,
    } } : {}),
    ...(thought !== undefined ? { completion_tokens_details: { reasoning_tokens: thought } } : {}),
  };
}
