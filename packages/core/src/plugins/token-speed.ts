import fp from 'fastify-plugin';
import { CCRPlugin, CCRPluginOptions } from './types';
import { SSEParserTransform } from '../utils/sse';
import { OutputHandlerConfig, OutputOptions, outputManager } from './output';
import { ITokenizer, TokenizerConfig } from '../types/tokenizer';
import { extractSessionIdFromUserId } from '../utils/session-id';
import { TOKEN_SPEED_TEMP_SUBDIRECTORY } from '@wengine-ai/claude-code-router-shared';

/**
 * Single source of truth for the temp-file handler config the token-speed
 * plugin registers. Both registration paths (plugin-registration.ts and the
 * default-reporter path below) MUST call this factory instead of inlining a
 * copy — divergent copies of this config are exactly what produced the
 * writer/reader drift behind the 3.23M-file temp directory incident.
 * The reader side (usage-store.readTokenSpeedStats, CLI statusline) reconstructs
 * the same path from TOKEN_SPEED_TEMP_SUBDIRECTORY + sanitizeTempFileKey.
 */
export function tokenSpeedTempFileHandlerConfig() {
  return {
    // v2 subdirectory: exact-name files live under
    // <tmpdir>/claude-code-router/token-speed-v2, so old CCR processes still
    // publishing timestamped files into the legacy flat root can never collide
    // with them.
    subdirectory: TOKEN_SPEED_TEMP_SUBDIRECTORY,
    extension: 'json',
    // The session key (usageSessionId -> user_id extraction -> x-request-id ->
    // requestId) already uniquely identifies one dataset. Overwriting the same
    // file means "latest write wins" and matches the reader, which
    // reconstructs this exact file name (session-<sanitized key>.json).
    // includeTimestamp: true produced a new file per request that the reader
    // could never find by exact name - it once accumulated 3.23M files in the
    // temp directory and stalled every stats read.
    includeTimestamp: false as const,
    prefix: 'session'
  };
}

/**
 * Token statistics interface
 */
interface TokenStats {
  requestId: string;
  sessionId?: string;
  /** Per-request stats-file key; equals readTokenSpeedStats() lookup key. */
  statsKey?: string;
  startTime: number;
  firstTokenTime?: number;
  lastTokenTime: number;
  tokenCount: number;
  tokensPerSecond: number;
  timeToFirstToken?: number;
  stream: boolean; // Whether this is a streaming request
}

/**
 * Plugin options
 */
interface TokenSpeedOptions extends CCRPluginOptions {
  /**
   * Reporter type(s) to use for output
   * Can be a single type or an array of types: 'console' | 'temp-file' | 'webhook'
   * Default: ['console', 'temp-file']
   */
  reporter?: string | string[];

  /**
   * Output handler configurations
   * Supports console, webhook, and other output handlers
   */
  outputHandlers?: OutputHandlerConfig[];

  /**
   * Default output options (format, prefix, etc.)
   */
  outputOptions?: OutputOptions;
}

// Store request-level statistics
const requestStats = new Map<string, TokenStats>();

// Cache tokenizers by provider and model to avoid repeated initialization
const tokenizerCache = new Map<string, ITokenizer>();

const MIN_DECODE_DURATION_SECONDS = 1;

/**
 * Token speed measurement plugin
 */
export const tokenSpeedPlugin: CCRPlugin = {
  name: 'token-speed',
  version: '1.0.0',
  description: 'Statistics for streaming response token generation speed',

  // Use fp() to break encapsulation and apply hooks globally
  register: fp(async (fastify, options: TokenSpeedOptions) => {
    const opts = {
      reporter: ['console', 'temp-file'],
      ...options
    };

    // Normalize reporter to array
    const reporters = Array.isArray(opts.reporter) ? opts.reporter : [opts.reporter];

    // Initialize output handlers based on reporters if not explicitly configured
    if (opts.outputHandlers && opts.outputHandlers.length > 0) {
      outputManager.registerHandlers(opts.outputHandlers);
    } else {
      // Auto-register handlers based on reporter types
      const handlersToRegister: OutputHandlerConfig[] = [];

      for (const reporter of reporters) {
        if (reporter === 'console') {
          handlersToRegister.push({
            type: 'console',
            enabled: true,
            config: {
              colors: true,
              level: 'log'
            }
          });
        } else if (reporter === 'temp-file') {
          handlersToRegister.push({
            type: 'temp-file',
            enabled: true,
            config: tokenSpeedTempFileHandlerConfig()
          });
        } else if (reporter === 'webhook') {
          // Webhook requires explicit config, skip auto-registration
          console.warn(`[TokenSpeedPlugin] Webhook reporter requires explicit configuration in outputHandlers`);
        }
      }

      if (handlersToRegister.length > 0) {
        outputManager.registerHandlers(handlersToRegister);
      }
    }

    // Set default output options
    if (opts.outputOptions) {
      outputManager.setDefaultOptions(opts.outputOptions);
    }

    /**
     * Get or create tokenizer for a specific provider and model
     */
    const getTokenizerForRequest = async (request: any): Promise<ITokenizer | null> => {
      const tokenizerService = (fastify as any).tokenizerService;
      if (!tokenizerService) {
        fastify.log?.warn('TokenizerService not available');
        return null;
      }

      // Extract provider and model from request
      // Format: "provider,model" or just "model"
      if (!request.provider || !request.model) {
        return null;
      }
      const providerName = request.provider;
      const modelName = request.model;

      // Create cache key
      const cacheKey = `${providerName}:${modelName}`;

      // Check cache first
      if (tokenizerCache.has(cacheKey)) {
        return tokenizerCache.get(cacheKey)!;
      }

      // Get tokenizer config for this model
      const tokenizerConfig = tokenizerService.getTokenizerConfigForModel(providerName, modelName);

      if (!tokenizerConfig) {
        // No specific config, use fallback
        fastify.log?.debug(`No tokenizer config for ${providerName}:${modelName}, using fallback`);
        return null;
      }

      try {
        // Create and cache tokenizer
        const tokenizer = await tokenizerService.getTokenizer(tokenizerConfig, providerName);
        tokenizerCache.set(cacheKey, tokenizer);
        fastify.log?.info(`Created tokenizer for ${providerName}:${modelName} - ${tokenizer.name}`);
        return tokenizer;
      } catch (error: any) {
        fastify.log?.warn(`Failed to create tokenizer for ${providerName}:${modelName}: ${error.message}`);
        return null;
      }
    };

    const shouldTrackTokenSpeed = (url: string) => {
      const pathname = new URL(`http://127.0.0.1${url}`).pathname;
      return pathname.endsWith("/v1/messages") || pathname.endsWith("/v1/responses");
    };

    // Add onRequest hook to capture actual request start time (before processing)
    fastify.addHook('onRequest', async (request) => {
      if (!shouldTrackTokenSpeed(request.url)) return;
      (request as any).requestStartTime = performance.now();
    });

    // Add onSend hook to intercept both streaming and non-streaming responses
    fastify.addHook('onSend', async (request, _reply, payload) => {
      if (!shouldTrackTokenSpeed(request.url)) return;
      const startTime = (request as any).requestStartTime;
      // Chat measures its own first delta in the final-response capture.
      if (!startTime || (request as any).chatCompletionCapture) return;
      const requestId = (request as any).id || Date.now().toString();

      // Two distinct keys with different jobs:
      // - statsKey: per-request file/request identity. It MUST match the key
      //   the usage pipeline reads back with readTokenSpeedStats() (request-
      //   pipeline.ts getUsageSessionId()), so TTFT/speed land on the right
      //   usage record. Using a per-request id keeps parallel requests inside
      //   one conversation (compaction, subagents) from overwriting each
      //   other's stats file.
      // - sessionId (display/grouping): the stable conversation id when the
      //   client advertises one (Pi session-affinity headers), falling back to
      //   the metadata.user_id heuristic and finally the request id — matching
      //   the historical behavior for clients without a stable session.
      const statsKey: string = (request as any).usageSessionId || requestId;
      let sessionId: string | undefined = (request as any).sessionId;
      if (!sessionId) {
        try {
          sessionId = extractSessionIdFromUserId((request.body as any)?.metadata?.user_id) || statsKey;
        } catch (error) {
          sessionId = statsKey;
        }
      }

      // Get tokenizer for this specific request
      const tokenizer = await getTokenizerForRequest(request);

      // Handle streaming responses
      if (payload instanceof ReadableStream) {
        // Mark this request as streaming
        requestStats.set(requestId, {
          requestId,
          sessionId,
          statsKey,
          startTime,
          lastTokenTime: startTime,
          tokenCount: 0,
          tokensPerSecond: 0,
          stream: true
        });

        // Tee the stream: one for stats, one for the client
        const [originalStream, statsStream] = payload.tee();

        // Process stats in background
        const processStats = async () => {
          let outputTimer: NodeJS.Timeout | null = null;

          // Output stats function - report the cumulative decode speed.
          // Both the periodic streaming updates and the final report use the
          // decode-speed formula (tokens over elapsed time minus TTFT), the same
          // mechanism the usage store records. A sliding "tokens in the last
          // second" window was previously used for interim updates, but SSE
          // deltas arrive in bursts (proxy/network buffering timestamps many
          // tokens at the same instant), so that window spiked to hundreds of
          // tokens/second and did not reflect the real sustained rate.
          const doOutput = async (isFinal: boolean) => {
            const stats = requestStats.get(requestId);
            if (!stats) return;

            const ttft = stats.firstTokenTime ? (stats.firstTokenTime - stats.startTime) : 0;
            // Interim updates use the current time as the end boundary so a
            // stall after an SSE burst lets the reported rate decay toward the
            // real sustained rate (lastTokenTime only advances on text deltas,
            // so it would otherwise freeze the burst-time average). The final
            // report uses the last-token time as the true decode end.
            const endTime = isFinal ? stats.lastTokenTime : performance.now();
            const totalDuration = endTime - stats.startTime;
            stats.tokensPerSecond = calculateFinalTokensPerSecond(stats.tokenCount, totalDuration, ttft);

            await outputStats(stats, reporters, opts.outputOptions, isFinal).catch(err => {
              fastify.log?.warn(`Failed to output streaming stats: ${err.message}`);
            });
          };

          try {
            // Decode byte stream to text, then parse SSE events
            const eventStream = statsStream
              .pipeThrough(new TextDecoderStream())
              .pipeThrough(new SSEParserTransform());
            const reader = eventStream.getReader();

            // Start timer immediately - output every 1 second
            outputTimer = setInterval(async () => {
              const stats = requestStats.get(requestId);
              if (stats) {
                await doOutput(false);
              }
            }, 1000);

            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              const data = value;
              const stats = requestStats.get(requestId);
              if (!stats) continue;

              const now = performance.now();

              const eventType = data.event || data.data?.type;

              // Record first token time when we receive any content/tool delta.
              // Claude/Anthropic uses content_block_*; Codex/OpenAI Responses uses
              // response.output_text.delta and response.function_call_arguments.delta.
              const isFirstTokenEvent =
                data.event === 'content_block_start' ||
                data.event === 'content_block_delta' ||
                data.event === 'text_block' ||
                data.event === 'content_block' ||
                eventType === 'response.output_text.delta' ||
                eventType === 'response.function_call_arguments.delta' ||
                eventType === 'response.reasoning_summary_text.delta';

              if (!stats.firstTokenTime && isFirstTokenEvent) {
                stats.firstTokenTime = now;
                stats.timeToFirstToken = Math.round(now - stats.startTime);
              }

              let text = '';

              // Detect Anthropic content_block_delta event (incremental tokens)
              if (data.event === 'content_block_delta' && data.data?.delta) {
                const deltaType = data.data.delta.type;

                // Extract text based on delta type
                if (deltaType === 'text_delta') {
                  text = data.data.delta.text || '';
                } else if (deltaType === 'input_json_delta') {
                  text = data.data.delta.partial_json || '';
                } else if (deltaType === 'thinking_delta') {
                  text = data.data.delta.thinking || '';
                }
              }

              // Detect Responses API delta events (Codex)
              if (
                eventType === 'response.output_text.delta' ||
                eventType === 'response.function_call_arguments.delta' ||
                eventType === 'response.reasoning_summary_text.delta'
              ) {
                text = typeof data.data?.delta === 'string' ? data.data.delta : '';
              }

              // Calculate tokens if we have text content
              if (text) {
                const tokenCount = tokenizer
                  ? (tokenizer.encodeText ? tokenizer.encodeText(text).length : estimateTokens(text))
                  : estimateTokens(text);

                stats.tokenCount += tokenCount;
                stats.lastTokenTime = now;
              }

              // Output final statistics when message/response ends
              if (data.event === 'message_stop' || eventType === 'response.completed' || eventType === 'response.failed') {
                // Clear timer
                if (outputTimer) {
                  clearInterval(outputTimer);
                  outputTimer = null;
                }

                await doOutput(true);

                requestStats.delete(requestId);
              }
            }
          } catch (error: any) {
            // Clean up timer on error
            if (outputTimer) {
              clearInterval(outputTimer);
            }
            if (error.name !== 'AbortError' && error.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
              fastify.log?.warn(`Error processing token stats: ${error.message}`);
            }
          }
        };

        // Keep the capture promise on the request so the final usage hook can
        // wait for the TTFT/speed file without delaying stream delivery.
        (request as any).tokenSpeedCapturePromise = processStats().catch((error) => {
          console.log(error);
          fastify.log?.warn(`Background stats processing failed: ${error.message}`);
        });

        // Return original stream to client
        return originalStream;
      }

      // Handle non-streaming responses
      // Try to extract token count from the response payload
      const endTime = performance.now();
      let tokenCount = 0;
      let hasTokenCount = false;

      // Payload should be a string or object for non-streaming responses
      if (payload && typeof payload === 'string') {
        try {
          const response = JSON.parse(payload);

          // Prefer usage.output_tokens if available (most accurate)
          if (typeof response.usage?.output_tokens === 'number') {
            tokenCount = response.usage.output_tokens;
            hasTokenCount = true;
          } else {
            // Fallback: calculate from content
            const content = response.content ?? response.message?.content;

            if (content !== undefined) {
              hasTokenCount = true;
              if (tokenizer) {
                if (Array.isArray(content)) {
                  tokenCount = content.reduce((sum: number, block: any) => {
                    if (block.type === 'text') {
                      const text = block.text || '';
                      return sum + (tokenizer.encodeText ? tokenizer.encodeText(text).length : estimateTokens(text));
                    }
                    return sum;
                  }, 0);
                } else if (typeof content === 'string') {
                  tokenCount = tokenizer.encodeText ? tokenizer.encodeText(content).length : estimateTokens(content);
                }
              } else {
                const text = Array.isArray(content) ? content.map((c: any) => c.text).join('') : (typeof content === 'string' ? content : '');
                tokenCount = estimateTokens(text);
              }
            }
          }
        } catch (error) {
          // Could not parse or extract tokens
        }
      }

      // Only output stats if token count was available
      if (hasTokenCount) {
        const totalDuration = endTime - startTime;

        // Non-streaming responses deliver the whole payload at once, so there
        // is no observable first-token moment — reporting total duration as
        // TTFT would be misleading. Leave TTFT unset; compute speed as
        // tokens over total duration (no decode-phase subtraction).
        const stats: TokenStats = {
          requestId,
          sessionId,
          statsKey,
          startTime,
          lastTokenTime: endTime,
          tokenCount,
          tokensPerSecond: calculateFinalTokensPerSecond(tokenCount, totalDuration),
          stream: false
        };

        await outputStats(stats, reporters, opts.outputOptions, true);
      }

      // Return payload as-is
      return payload;
    });
  }),
};

/**
 * Calculate final decode speed using total duration minus TTFT.
 */
function calculateFinalTokensPerSecond(tokenCount: number, totalDurationMs: number, timeToFirstTokenMs = 0): number {
  if (tokenCount <= 0) {
    return 0;
  }

  const decodeDurationSeconds = Math.max(
    (totalDurationMs - timeToFirstTokenMs) / 1000,
    MIN_DECODE_DURATION_SECONDS
  );
  return Math.round(tokenCount / decodeDurationSeconds);
}

/**
 * Estimate token count (fallback method)
 */
function estimateTokens(text: string): number {
  // Rough estimation: English ~4 chars/token, Chinese ~1.5 chars/token
  const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const otherChars = text.length - chineseChars;
  return Math.ceil(chineseChars / 1.5 + otherChars / 4);
}

/**
 * Output single request statistics
 */
async function outputStats(
  stats: TokenStats,
  reporters: string[],
  options?: OutputOptions,
  isFinal = false
) {
  const prefix = isFinal ? '[Token Speed Final]' : '[Token Speed]';

  const logData = {
    requestId: stats.requestId.substring(0, 8),
    sessionId: stats.sessionId,
    stream: stats.stream,
    tokenCount: stats.tokenCount,
    tokensPerSecond: stats.tokensPerSecond,
    timeToFirstToken: stats.timeToFirstToken ? `${stats.timeToFirstToken}ms` : 'N/A',
    duration: `${((stats.lastTokenTime - stats.startTime) / 1000).toFixed(2)}s`,
    timestamp: Date.now()
  };

  const outputOptions = {
    prefix,
    metadata: {
      sessionId: stats.sessionId,
      // Per-request file key: readTokenSpeedStats() in request-pipeline.ts
      // reads back the exact same key (req.sessionId || usageSessionId), so
      // each parallel request in a conversation joins its own stats file
      // instead of racing on one session-named file.
      statsKey: stats.statsKey
    },
    ...options
  };

  // Output to each specified reporter type
  for (const reporter of reporters) {
    try {
      await outputManager.outputToType(reporter, logData, outputOptions);
    } catch (error) {
      console.error(`[TokenSpeedPlugin] Failed to output to ${reporter}:`, error);
    }
  }
}
