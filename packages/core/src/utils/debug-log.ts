import { FastifyInstance } from "fastify";

const SENSITIVE_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "x-goog-api-key",
  "cookie",
  "set-cookie",
]);

// Defence in depth: mask ANY header whose name looks credential-bearing, so a
// future provider-specific secret header can never reach the debug log even
// if the explicit set above is not updated.
const SENSITIVE_HEADER_PATTERN = /token|secret|credential|passwd|password/i;

interface DebugLogOptions {
  maxBodyLength: number;
  maxStreamChunks: number;
}

const DEFAULT_OPTIONS: DebugLogOptions = {
  maxBodyLength: 4096,
  maxStreamChunks: 100,
};

// Runtime toggle — defaults to false, resets on server restart
let runtimeDebugEnabled = false;

export function setRuntimeDebugLog(enabled: boolean) {
  runtimeDebugEnabled = enabled;
}

export function getRuntimeDebugLog(): boolean {
  return runtimeDebugEnabled;
}

export function isDebugLogEnabled(configService: any): boolean {
  return runtimeDebugEnabled || configService.get<boolean>("DEBUG_LOG") === true;
}

export function getDebugLogOptions(configService: any): DebugLogOptions {
  const opts = configService.get<any>("DEBUG_LOG_OPTIONS");
  if (!opts || typeof opts !== "object") return DEFAULT_OPTIONS;
  return {
    maxBodyLength: opts.maxBodyLength ?? DEFAULT_OPTIONS.maxBodyLength,
    maxStreamChunks: opts.maxStreamChunks ?? DEFAULT_OPTIONS.maxStreamChunks,
  };
}

export function maskHeaders(
  headers: Record<string, string>
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (SENSITIVE_HEADERS.has(lower) || SENSITIVE_HEADER_PATTERN.test(lower)) {
      result[key] = "***MASKED***";
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function truncateBody(body: string, maxLen: number): string {
  if (body.length <= maxLen) return body;
  return body.slice(0, maxLen) + `...[truncated, total ${body.length} bytes]`;
}

export function logProviderRequest(
  logger: any,
  reqId: string,
  data: { url: string; headers: Record<string, string>; body: any }
) {
  const bodyStr =
    typeof data.body === "string" ? data.body : JSON.stringify(data.body);
  logger.info({
    debug_log: true,
    reqId,
    phase: "provider_request",
    url: data.url,
    headers: maskHeaders(data.headers),
    body: truncateBody(bodyStr, DEFAULT_OPTIONS.maxBodyLength),
  });
}

export function logProviderResponse(
  logger: any,
  reqId: string,
  data: { status: number; headers: Record<string, string>; body?: string }
) {
  logger.info({
    debug_log: true,
    reqId,
    phase: "provider_response",
    status: data.status,
    headers: maskHeaders(data.headers),
    ...(data.body !== undefined
      ? { body: truncateBody(data.body, DEFAULT_OPTIONS.maxBodyLength) }
      : {}),
  });
}

export function logStreamChunk(
  logger: any,
  reqId: string,
  chunkIndex: number,
  chunkStr: string
) {
  const usageSummary = extractStreamUsageSummary(chunkStr);
  logger.info({
    debug_log: true,
    reqId,
    phase: "provider_stream_chunk",
    chunkIndex,
    ...(usageSummary ? { usage_monitor: usageSummary } : {}),
    data: truncateBody(chunkStr, DEFAULT_OPTIONS.maxBodyLength),
  });
}

function extractStreamUsageSummary(chunkStr: string) {
  const summaries: any[] = [];
  for (const line of chunkStr.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;

    try {
      const parsed = JSON.parse(data);
      const usage = parsed?.usage || parsed?.response?.usage;
      if (usage) {
        summaries.push({
          path: parsed?.usage ? "usage" : "response.usage",
          usage,
          choicesLength: Array.isArray(parsed?.choices) ? parsed.choices.length : undefined,
          finishReason: parsed?.choices?.[0]?.finish_reason,
        });
      }
    } catch {
      summaries.push({ parseError: true, data: truncateBody(data, 512) });
    }
  }

  if (!summaries.length) return undefined;
  return summaries.length === 1 ? summaries[0] : summaries;
}

export function logStreamEnd(logger: any, reqId: string, totalChunks: number) {
  logger.info({
    debug_log: true,
    reqId,
    phase: "provider_stream_end",
    totalChunks,
  });
}

export function readStreamForDebug(
  stream: ReadableStream<Uint8Array>,
  logger: any,
  reqId: string,
  options: DebugLogOptions
) {
  // Read in background — must never throw or affect client stream
  (async () => {
    const reader = stream
      .pipeThrough(new TextDecoderStream())
      .getReader();
    let chunkIndex = 0;
    try {
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += value;
        // Split on SSE boundaries (double newline)
        const parts = buffer.split("\n\n");
        // Keep last incomplete part in buffer
        buffer = parts.pop() || "";

        for (const part of parts) {
          if (!part.trim()) continue;
          if (chunkIndex < options.maxStreamChunks) {
            logStreamChunk(logger, reqId, chunkIndex, part);
          } else if (chunkIndex === options.maxStreamChunks) {
            logger.info({
              debug_log: true,
              reqId,
              phase: "provider_stream_chunk_omitted",
              message: `[chunks after #${chunkIndex} omitted, maxStreamChunks=${options.maxStreamChunks}]`,
            });
          }
          chunkIndex++;
        }
      }
      // Flush remaining buffer
      if (buffer.trim()) {
        if (chunkIndex < options.maxStreamChunks) {
          logStreamChunk(logger, reqId, chunkIndex, buffer.trim());
        }
        chunkIndex++;
      }
      logStreamEnd(logger, reqId, chunkIndex);
    } catch (err: any) {
      console.error(`[debug_log] Error reading debug stream for reqId=${reqId}:`, err);
      logStreamEnd(logger, reqId, chunkIndex);
    } finally {
      reader.releaseLock();
    }
  })();
}
