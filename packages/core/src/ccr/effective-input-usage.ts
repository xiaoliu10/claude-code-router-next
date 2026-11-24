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

/** Inclusive input: Chat/Responses prompts already contain cached tokens;
 * standard Anthropic counts add both cache buckets. Missing native cache reads
 * use the router estimate, explicitly marked as an estimate by the caller. */
export function effectiveInputUsage(capture: InputUsageCapture | undefined, routerEstimate = 0) {
  const { input = 0, read, write = 0, kiroChat, estimated } = capture?.usage ?? {};
  const reported = capture && (capture.usage.input !== undefined || read !== undefined || capture.usage.write !== undefined);
  const hasInput = input > 0 || (read ?? 0) + write > 0;
  let total = input;
  let inferred = false;
  if (!reported || (!hasInput && !estimated)) {
    total = routerEstimate;
    inferred = routerEstimate > 0;
  } else if (capture?.format === "anthropic") {
    total += (read ?? 0) + write;
    // When cache reads are omitted, the router estimates the whole prompt.
    // Both reported writes and net input already occupy part of that estimate.
    if (read === undefined && !estimated && routerEstimate > total) {
      total = routerEstimate;
      inferred = true;
    }
  } else if (kiroChat) {
    // Kiro Chat folds reads into prompt_tokens and reports writes separately.
    total += write;
  }
  return {
    effectiveInputTokens: total,
    ...(estimated || inferred ? { effectiveInputTokensSource: "estimated" as const } : {}),
  };
}
