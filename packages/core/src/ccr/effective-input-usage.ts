export type UsageFormat = "chat" | "responses" | "anthropic" | "anthropic-inclusive";

type InputUsage = {
  input?: number;
  read?: number;
  write?: number;
  estimated?: boolean;
  kiroChat?: boolean;
};

export type InputUsageCapture = { format: UsageFormat; usage: InputUsage };

/** Keep the earliest source format when a request runs through multiple converters. */
export function startInputUsageCapture(request: { sourceInputUsage?: InputUsageCapture } | undefined, format: UsageFormat) {
  if (!request || request.sourceInputUsage) return undefined;
  return request.sourceInputUsage = { format, usage: {} };
}

function mergeCount(previous: number | undefined, incoming: unknown): number | undefined {
  if (typeof incoming !== "number" || !Number.isFinite(incoming) || incoming < 0) return previous;
  // A trailing all-zero usage frame must not erase a prior cumulative count.
  return incoming || previous || 0;
}

/** Observe original counters before normalization fills missing cache buckets with zero. */
export function captureInputUsage(capture: InputUsageCapture | undefined, frame: any): void {
  if (!capture || !frame) return;
  const { usage, format } = capture;
  usage.input = mergeCount(usage.input, format === "chat" ? frame.prompt_tokens : frame.input_tokens);
  usage.read = mergeCount(usage.read, frame.cache_read_input_tokens ?? frame.input_tokens_details?.cached_tokens ?? frame.prompt_tokens_details?.cached_tokens);
  usage.write = mergeCount(usage.write, frame.cache_creation_input_tokens ?? frame.input_tokens_details?.cache_creation_tokens ??
    frame.input_tokens_details?.cache_write_tokens ?? frame.prompt_tokens_details?.cache_creation_tokens ?? frame.prompt_tokens_details?.cache_write_tokens);
  usage.estimated ||= frame.usage_estimated === true || frame.kiro_estimated === true;
  usage.kiroChat ||= format === "chat" && frame.usage_source === "kiro";
}

/** Inclusive input for a request whose source protocol was captured.
 *
 * Chat/Responses prompts already contain cached tokens; standard Anthropic
 * counts add both cache buckets; Kiro Chat folds reads into prompt_tokens and
 * reports writes separately. The total is normalized strictly from the reported
 * counters (an omitted bucket is zero) — never padded with a router estimate.
 * When no usage counters were reported at all the inclusive input is unknown and
 * the result is null rather than an approximation. Provider-estimated counts keep
 * their known-protocol normalization and stay flagged as estimated. */
export function effectiveInputUsage(capture: InputUsageCapture | undefined): {
  effectiveInputTokens: number | null;
  effectiveInputTokensSource?: "estimated";
} {
  if (!capture) return { effectiveInputTokens: null };
  const { input, read, write, kiroChat, estimated } = capture.usage;
  const reported = input !== undefined || read !== undefined || write !== undefined;
  if (!reported) return { effectiveInputTokens: null };
  const uncached = input ?? 0;
  const cacheRead = read ?? 0;
  const cacheWrite = write ?? 0;
  let total: number;
  if (capture.format === "anthropic") {
    total = uncached + cacheRead + cacheWrite;
  } else if (kiroChat) {
    total = uncached + cacheWrite;
  } else {
    total = uncached;
  }
  return {
    effectiveInputTokens: total,
    ...(estimated ? { effectiveInputTokensSource: "estimated" as const } : {}),
  };
}
