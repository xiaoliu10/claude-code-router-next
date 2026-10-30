/**
 * CCR request pipeline — explicit, ordered hooks for the CCR runtime.
 *
 * Hook order (enforced by namespace phases + sequential global registration):
 *   1. onRequest: request timing (requestStartTime)
 *   2. namespace preHandler: request normalize
 *   3. namespace preHandler: adapter
 *   4. global preHandler: auth/client context
 *   5. global preHandler: agent mutation
 *   6. namespace preHandler: router
 *   7. namespace preHandler: provider model normalization
 *   8. handler: routes.ts handleTransformerEndpoint
 *   9. onSend: agent tool rewrite + usage/upstream-model capture
 *  10. onResponse: TTFT/speed/health/final usage record
 *
 * Fastify runs ancestor preHandler hooks before child plugin hooks. To enforce
 * adapter → auth/client → agent → router without relying on registration timing,
 * the namespace registers a single ordered dispatcher (see Server.registerNamespace)
 * whose phases invoke the global callbacks between adapter and router.
 *
 * The pipeline is registered by createCcrServer AFTER admin routes and BEFORE
 * namespace registration + listen, so all hooks are in deterministic order.
 */
import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import JSON5 from "json5";
import { applyClientAdapter, detectClientType } from "../clients/adapters";
import { sessionUsageCache } from "../utils/cache";
import { releaseRequestLease } from "../utils/concurrency-router";
import { getHealthStore } from "../services/provider-health";
import { SSEParserTransform } from "../utils/sse/SSEParser.transform";
import { SSESerializerTransform } from "../utils/sse/SSESerializer.transform";
import { rewriteStream } from "../utils/sse/rewriteStream";
import { append as appendUsage, readTokenSpeedStats } from "./usage-store";
import {
  normalizeUsagePayload,
  mergeUsageCapture,
} from "./usage-merge";
import type { IAgent } from "./agents/type";
import agentsManager from "./agents";
import { apiKeyAuth } from "./auth";
import { normalizeResponsesBody } from "../api/routes";

/**
 * Longest `onResponse` waits for the background usage/TTFT readers before it
 * finalizes the record.
 *
 * The readers consume a tee'd branch of the response and normally finish as soon
 * as the client does, so this bound is not on the happy path — it exists so a
 * stalled upstream (or a tee branch that never drains) cannot hang the request's
 * completion hook, which would also leave the usage row forever unrecorded.
 */
const USAGE_CAPTURE_DRAIN_MS = 1500;

/**
 * Classify rate-limit responses from any upstream provider. Used to isolate
 * rate-limited models in the health store (time-based auto-recover) instead of
 * applying the generic 3-failure breaker threshold.
 */
export function isRateLimitMessage(statusCode: number, message?: string): boolean {
  return statusCode === 429 ||
    Boolean(message && /rate[\s_]limit|too many|限流|频率限制|qps_limit|token_limit|quota exhausted|usage limit|limit reached/i.test(message));
}

const event = new EventEmitter();

export function getPipelineEventEmitter(): EventEmitter {
  return event;
}

function ensureClientContext(req: any, config: Record<string, any>): void {
  if (!req.clientContext || !req.usageCacheKey || !req.usageSessionId) {
    applyClientAdapter(req, config);
  }
}

function getUsageSessionId(req: any): string {
  return req.usageSessionId || req.id;
}

function getUsageCacheKey(req: any): string {
  return req.usageCacheKey || `${req.clientType || "unknown"}:request:${getUsageSessionId(req)}`;
}

function getRequestModel(req: any): string {
  // Prefer req.body.model (routed model) over req.model (pre-routing model)
  if (req.body?.model) {
    if (Array.isArray(req.body.model)) return req.body.model.join(",");
    return req.body.model;
  }
  if (Array.isArray(req.model)) return req.model.join(",");
  return req.model || "";
}

// Parse a non-stream response payload once and return both the normalized
// usage and the upstream model. Fastify hands onSend a serialized string or
// Buffer, so callers must use this parsed body (not the raw payload) for any
// field lookup — otherwise non-stream responses never populate req.upstreamModel.
function extractNonStreamMeta(payload: any): { usage?: any; model?: string } | undefined {
  if (!payload) return undefined;

  let body = payload;
  if (Buffer.isBuffer(payload)) {
    body = payload.toString("utf8");
  }
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return undefined;
    }
  }

  if (typeof body !== "object") return undefined;

  // Anthropic /v1/messages non-stream response.
  const usage = body.usage
    ? normalizeUsagePayload(body.usage)
    : body.response?.usage
      ? normalizeUsagePayload(body.response.usage)
      : undefined;

  // Upstream-reported model (Anthropic payload.model, Responses payload.response.model).
  const model = body.model || body.response?.model;

  if (!usage && !model) return undefined;
  return { usage, model };
}

/**
 * Register all CCR request-pipeline hooks on the server instance.
 * Called by createCcrServer after admin routes are registered.
 */
export interface CcrPreHandlerCallbacks {
  authClient(req: any, reply: any): Promise<void>;
  agent(req: any, reply: any): Promise<void>;
}

function normalizeCcrRequest(req: any): void {
  const url = new URL(`http://127.0.0.1${req.url}`);
  req.pathname = url.pathname;
  const isMessages = url.pathname.endsWith("/v1/messages");
  const isResponses = url.pathname.endsWith("/v1/responses");
  if (!isMessages && !isResponses) return;
  if (!req.body || typeof req.body !== "object") return;

  if (isResponses && req.body.input && !req.body.messages) {
    normalizeResponsesBody(req.body);
  }
  if (req.body.stream === undefined) req.body.stream = false;
  if (!req.originalModel && req.body.model) req.originalModel = req.body.model;
}

async function runAuthClientPhase(req: any, reply: any, config: any): Promise<void> {
  // apiKeyAuth replies directly (reply.send) on auth-failure paths without
  // invoking the `done` callback. Relying solely on `done` to settle this
  // Promise would leave it pending forever on those paths, leaking the request
  // context in a real HTTP server. Also resolve when the async auth function
  // itself settles, then gate continuation on reply.sent.
  await new Promise<void>((resolve, reject) => {
    const done = (err?: Error) => err ? reject(err) : resolve();
    apiKeyAuth(config)(req, reply, done).then(() => resolve(), reject);
  });
  if (reply.sent) return;

  const url = new URL(`http://127.0.0.1${req.url}`);
  req.pathname = url.pathname;
  if (req.pathname.endsWith("/v1/messages") && req.pathname !== "/v1/messages") {
    req.preset = req.pathname.replace("/v1/messages", "").replace("/", "");
  }
  if (req.pathname.endsWith("/v1/responses") && req.pathname !== "/v1/responses") {
    req.preset = req.pathname.replace("/v1/responses", "").replace("/", "");
  }
  if (req.pathname.endsWith("/v1/messages") || req.pathname.endsWith("/v1/responses")) {
    ensureClientContext(req, config);
    const usageCacheKey = getUsageCacheKey(req);
    if (req.clientContext?.usageScope === "session") {
      req.previousUsage = sessionUsageCache.get(usageCacheKey);
    }
  }
}

async function runAgentPhase(req: any, _reply: any, config: any): Promise<void> {
  if (!req.pathname?.endsWith("/v1/messages")) return;
  const useAgents: string[] = [];
  for (const agent of agentsManager.getAllAgents()) {
    if (!agent.shouldHandle(req, config)) continue;
    useAgents.push(agent.name);
    agent.reqHandler(req, config);
    if (agent.tools.size) {
      if (!req.body?.tools?.length) req.body.tools = [];
      req.body.tools.unshift(...Array.from(agent.tools.values()).map(item => ({
        name: item.name,
        description: item.description,
        input_schema: item.input_schema,
      })));
    }
  }
  if (useAgents.length) req.agents = useAgents;
}

export function createCcrPreHandlerCallbacks(config: any): CcrPreHandlerCallbacks {
  return {
    authClient: (req, reply) => runAuthClientPhase(req, reply, config),
    agent: (req, reply) => runAgentPhase(req, reply, config),
  };
}

export { normalizeCcrRequest };

export function registerRequestPipeline(serverInstance: any, config: any): void {
  // Hook 1: onRequest — request timing
  serverInstance.addHook("onRequest", async (req: any) => {
    const url = new URL(`http://127.0.0.1${req.url}`);
    req.pathname = url.pathname;
    if ((url.pathname.endsWith("/v1/messages") || url.pathname.endsWith("/v1/responses")) && !req.requestStartTime) {
      req.requestStartTime = performance.now();
    }
  });

  // Authenticate every route, including management/admin endpoints registered
  // before the API namespaces. Namespace requests are authenticated inside the
  // ordered dispatcher so adapter detection still runs before Codex handling.
  serverInstance.addHook("preHandler", async (req: any, reply: any) => {
    const pathname = req.pathname || new URL(`http://127.0.0.1${req.url}`).pathname;
    if (pathname.endsWith("/v1/messages") || pathname.endsWith("/v1/responses")) return;
    // See runAuthCodexPhase: resolve on the auth function's own settlement too,
    // because auth-failure paths call reply.send() without invoking `done`.
    await new Promise<void>((resolve, reject) => {
      const done = (err?: Error) => err ? reject(err) : resolve();
      apiKeyAuth(config)(req, reply, done).then(() => resolve(), reject);
    });
  });

  // Pre-handler phases are executed by the namespace's explicit dispatcher.
  // This preserves adapter → auth/Codex → agent → router ordering without
  // relying on Fastify's ancestor/child hook traversal details.

  // Hook 2: onError
  serverInstance.addHook("onError", async (request: any, reply: any, error: any) => {
    request.errorMessage = error?.message || error?.toString?.() || "Unknown error";
    event.emit('onError', request, reply, error);
  });

  // Hook 3: onSend — agent tool rewrite + SSE usage capture + upstream model capture
  serverInstance.addHook("onSend", (req: any, reply: any, payload: any, done: any) => {
    (req.ccrHookOrder ||= []).push("onSend");
    const isMessages = req.pathname?.endsWith("/v1/messages");
    const isResponses = req.pathname?.endsWith("/v1/responses");
    if (isMessages || isResponses) {
      ensureClientContext(req, config);
      const usageSessionId = getUsageSessionId(req);
      const usageCacheKey = getUsageCacheKey(req);
      if (payload instanceof ReadableStream) {
        // /v1/responses doesn't have agents — skip that branch
        if (isMessages && req.agents) {
          const abortController = new AbortController();
          const eventStream = payload.pipeThrough(new SSEParserTransform())
          let currentAgent: undefined | IAgent;
          let currentToolIndex = -1
          let currentToolName = ''
          let currentToolArgs = ''
          let currentToolId = ''
          const toolMessages: any[] = []
          const assistantMessages: any[] = []
          // Store Anthropic format message body, distinguishing text and tool types
          return done(null, rewriteStream(eventStream, async (data, controller) => {
            try {
              // Detect tool call start
              if (data.event === 'content_block_start' && data?.data?.content_block?.name) {
                const agent = req.agents.find((name: string) => agentsManager.getAgent(name)?.tools.get(data.data.content_block.name))
                if (agent) {
                  currentAgent = agentsManager.getAgent(agent)
                  currentToolIndex = data.data.index
                  currentToolName = data.data.content_block.name
                  currentToolId = data.data.content_block.id
                  return undefined;
                }
              }

              // Collect tool arguments
              if (currentToolIndex > -1 && data.data.index === currentToolIndex && data.data?.delta?.type === 'input_json_delta') {
                currentToolArgs += data.data?.delta?.partial_json;
                return undefined;
              }

              // Tool call completed, handle agent invocation
              if (currentToolIndex > -1 && data.data.index === currentToolIndex && data.data?.type === 'content_block_stop') {
                try {
                  const args = JSON5.parse(currentToolArgs);
                  assistantMessages.push({
                    type: "tool_use",
                    id: currentToolId,
                    name: currentToolName,
                    input: args
                  })
                  const toolResult = await currentAgent?.tools.get(currentToolName)?.handler(args, {
                    req,
                    config
                  });
                  toolMessages.push({
                    "tool_use_id": currentToolId,
                    "type": "tool_result",
                    "content": toolResult
                  })
                  currentAgent = undefined
                  currentToolIndex = -1
                  currentToolName = ''
                  currentToolArgs = ''
                  currentToolId = ''
                } catch (e) {
                  console.log(e);
                }
                return undefined;
              }

              if (data.event === 'message_delta' && toolMessages.length) {
                req.body.messages.push({
                  role: 'assistant',
                  content: assistantMessages
                })
                req.body.messages.push({
                  role: 'user',
                  content: toolMessages
                })
                const response = await fetch(`http://127.0.0.1:${config.PORT || 3456}/v1/messages`, {
                  method: "POST",
                  headers: {
                    'x-api-key': config.APIKEY,
                    'content-type': 'application/json',
                  },
                  body: JSON.stringify(req.body),
                })
                if (!response.ok) {
                  return undefined;
                }
                const stream = response.body!.pipeThrough(new SSEParserTransform() as any)
                const reader = stream.getReader()
                while (true) {
                  try {
                    const {value, done} = await reader.read();
                    if (done) {
                      break;
                    }
                    const eventData = value as any;
                    if (['message_start', 'message_stop'].includes(eventData.event)) {
                      continue
                    }

                    // Check if stream is still writable
                    if (!controller.desiredSize) {
                      break;
                    }

                    controller.enqueue(eventData)
                  }catch (readError: any) {
                    if (readError.name === 'AbortError' || readError.code === 'ERR_STREAM_PREMATURE_CLOSE') {
                      abortController.abort(); // Abort all related operations
                      break;
                    }
                    throw readError;
                  }

                }
                return undefined
              }
              return data
            }catch (error: any) {
              console.error('Unexpected error in stream processing:', error);

              // Handle premature stream closure error
              if (error.code === 'ERR_STREAM_PREMATURE_CLOSE') {
                abortController.abort();
                return undefined;
              }

              // Re-throw other errors
              throw error;
            }
          }).pipeThrough(new SSESerializerTransform()))
        }

        const [originalStream, clonedStream] = payload.tee();
        const read = async (stream: ReadableStream) => {
          const eventStream = stream
            .pipeThrough(new TextDecoderStream())
            .pipeThrough(new SSEParserTransform() as any);
          const reader = eventStream.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const event = (value as any).event;
              const data = (value as any).data;

              // Capture the model the upstream provider actually returned. Gateways may
              // silently swap the requested model (e.g. route glm-5 to a MiniMax backend),
              // so we surface the real upstream model in usage stats.
              if (event === 'message_start' && data?.message?.model) {
                req.upstreamModel = data.message.model;
              }
              if (event === 'response.completed' && data?.response?.model) {
                req.upstreamModel = data.response.model;
              }

              // Capture usage from Anthropic SSE (message_delta, message_start)
              if (data?.usage) {
                const existingUsage = sessionUsageCache.get(usageCacheKey) || {};
                const normalizedUsage = normalizeUsagePayload(data.usage);
                // Reset cache on message_start to avoid stale fields from previous requests
                // (e.g. cache_creation_input_tokens carried over from a different model).
                // mergeUsageCapture refuses to let an all-zero frame overwrite a
                // real value captured earlier (see its doc comment).
                const mergedUsage = mergeUsageCapture(existingUsage, normalizedUsage, event === 'message_start');
                req.log?.info?.({
                  debug_log: true,
                  reqId: req.id,
                  phase: "usage_capture_anthropic_sse",
                  event,
                  provider: req.provider,
                  model: getRequestModel(req),
                  usageSessionId,
                  capturedUsage: normalizedUsage,
                  mergedUsage,
                });

                // Debug log for cache tokens
                if (normalizedUsage?.cache_read_input_tokens || normalizedUsage?.cache_creation_input_tokens) {
                  console.log('[Usage] Cache tokens:', {
                    cache_read: normalizedUsage?.cache_read_input_tokens,
                    cache_creation: normalizedUsage?.cache_creation_input_tokens
                  });
                }
                sessionUsageCache.put(usageCacheKey, mergedUsage);
              }

              // Capture usage from Responses API SSE (response.usage)
              if (data?.response?.usage) {
                const respUsage = normalizeUsagePayload(data.response.usage);
                // Responses usage is emitted on the trailing response.completed
                // event, so it is NOT a "first event" sentinel like Anthropic's
                // message_start. Resetting the base here would discard fields
                // already captured for this request whenever the completed frame
                // carries zeros. The slot is already cleared by the router before
                // the handler runs, so a plain merge (with the all-zero guard in
                // mergeUsageCapture) is correct.
                const existingUsage = sessionUsageCache.get(usageCacheKey) || {};
                const mergedUsage = mergeUsageCapture(existingUsage, respUsage, false);
                req.log?.info?.({
                  debug_log: true,
                  reqId: req.id,
                  phase: "usage_capture_responses_sse",
                  event,
                  provider: req.provider,
                  model: getRequestModel(req),
                  usageSessionId,
                  capturedUsage: respUsage,
                  mergedUsage,
                });
                sessionUsageCache.put(usageCacheKey, mergedUsage);
              }
            }
          } catch (readError: any) {
            if (readError.name === 'AbortError' || readError.code === 'ERR_STREAM_PREMATURE_CLOSE') {
              console.error('Background read stream closed prematurely');
            } else {
              console.error('Error in background stream reading:', readError);
            }
          } finally {
            reader.releaseLock();
          }
        }
        req.usageCapturePromise = read(clonedStream);
        return done(null, originalStream)
      }
      // Streaming request WITHOUT agent tools — the common case (Codex, Pi, any
      // plain Claude Code turn). No usage reader ran on this path: the agent
      // branch above owns the only one, so a healthy streamed turn was recorded
      // with output_tokens 0. That zero is what made working subscription
      // responses look like empty answers in the usage UI. Read a tee'd branch so
      // the client still receives an untouched stream, and merge usage in stream
      // order so the trailing frame (message_delta / response.completed) stays
      // authoritative over the leading message_start zero.
      if (payload instanceof ReadableStream) {
        const [passthroughStream, usageStream] = payload.tee();
        req.usageCapturePromise = (async () => {
          const reader = usageStream
            .pipeThrough(new TextDecoderStream())
            .pipeThrough(new SSEParserTransform() as any)
            .getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const event = (value as any).event;
              const frdata = (value as any).data;
              if (event === 'message_start' && frdata?.message?.model) {
                req.upstreamModel = frdata.message.model;
              }
              if (event === 'response.completed' && frdata?.response?.model) {
                req.upstreamModel = frdata.response.model;
              }
              const frame = frdata?.usage ?? frdata?.response?.usage;
              if (frame) {
                const normalized = normalizeUsagePayload(frame);
                const existing = sessionUsageCache.get(usageCacheKey) || {};
                // message_start resets the base (it opens a new answer); every
                // other frame merges, so a trailing real count is never
                // overwritten by a leading zero.
                const merged = mergeUsageCapture(existing, normalized, event === 'message_start');
                sessionUsageCache.put(usageCacheKey, merged);
              }
            }
          } catch (readError: any) {
            if (readError?.name !== 'AbortError' && readError?.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
              req.log?.warn?.({ phase: 'usage_capture_plain_stream', err: String(readError) });
            }
          } finally {
            reader.releaseLock();
          }
        })();
        return done(null, passthroughStream);
      }

      const nonStreamMeta = extractNonStreamMeta(payload);
      if (nonStreamMeta?.usage) {
        sessionUsageCache.put(usageCacheKey, nonStreamMeta.usage);
      }
      // Capture upstream model for non-stream responses from the parsed body
      // (Anthropic payload.model, Responses API payload.response.model).
      if (nonStreamMeta?.model) {
        req.upstreamModel = nonStreamMeta.model;
      }
      if (typeof payload ==='object') {
        if (payload.error) {
          return done(payload.error, null)
        } else {
          return done(payload, null)
        }
      }
    }
    if (typeof payload ==='object' && payload.error) {
      return done(payload.error, null)
    }
    done(null, payload)
  });

  // Hook 4: onSend — error response body capture
  serverInstance.addHook("onSend", async (req: any, reply: any, payload: any) => {
    event.emit('onSend', req, reply, payload);
    // Capture error response body for usage stats
    if (reply.statusCode >= 400 && (req.pathname?.endsWith("/v1/messages") || req.pathname?.endsWith("/v1/responses"))) {
      try {
        if (typeof payload === 'string') {
          req.errorResponseBody = payload;
        } else if (payload && typeof payload === 'object') {
          req.errorResponseBody = JSON.stringify(payload);
        }
      } catch (e) {
        // Ignore serialization errors
      }
    }
    return payload;
  });

  // Hook: onRequestAbort — client disconnected mid-flight. Fastify does not
  // guarantee onResponse for aborted requests, so release the
  // concurrency-priority in-flight lease here too (idempotent; no-op when the
  // request holds no lease).
  serverInstance.addHook("onRequestAbort", async (req: any) => {
    releaseRequestLease(req);
  });

  // Hook 5: onResponse — final usage record (TTFT/speed/health/final record)
  serverInstance.addHook("onResponse", async (req: any, reply: any) => {
    (req.ccrHookOrder ||= []).push("onResponse");
    // Release the concurrency-priority in-flight lease (no-op when the request
    // did not go through concurrency-priority routing).
    releaseRequestLease(req);
    if (!req.pathname?.endsWith("/v1/messages") && !req.pathname?.endsWith("/v1/responses")) return;
    try {
      // Bounded drain: the usage/TTFT readers tee the response and normally end
      // with the client, but an upstream that stops mid-stream would otherwise
      // block this hook (and the usage record) forever.
      const drain = async (promise: Promise<any> | undefined) => {
        if (!promise) return;
        // Clear the deadline timer when the promise wins: leaving it armed leaks a
        // timer per request on the happy path.
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            promise,
            new Promise((resolve) => {
              timer = setTimeout(resolve, USAGE_CAPTURE_DRAIN_MS);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      };
      await drain(req.usageCapturePromise);
      await drain(req.tokenSpeedCapturePromise);
      const usageSessionId = getUsageSessionId(req);
      // Two distinct keys with different jobs:
      // - speedStatsKey: per-request stats-file key. It MUST equal the key the
      //   token-speed plugin names its file with (usageSessionId || req.id), so
      //   the TTFT/speed lookup joins THIS request's stats even when the
      //   conversation has parallel requests in flight.
      // - sessionId: grouping/display identity for the usage record. The stable
      //   conversation id when the client advertises one (Pi session-affinity
      //   headers, mirrored onto req.sessionId by the client adapter), so a
      //   conversation's records group together in the usage UI; falls back to
      //   the request-scoped id for clients without a stable session.
      const speedStatsKey = usageSessionId;
      const sessionId = (req as any).sessionId || usageSessionId;
      // A hard HTTP failure never reached a successful upstream exchange, so the
      // session slot still holds the PREVIOUS request's usage (we intentionally
      // keep it as the next request's routing baseline). Reading it here would
      // record this failure with the predecessor's input/cache tokens. Ignore the
      // slot on hard failure and fall back to the router's own token estimate.
      const hardFailed = reply.statusCode >= 400;
      const usage = hardFailed ? undefined : sessionUsageCache.get(getUsageCacheKey(req));
      const speedStats = readTokenSpeedStats(speedStatsKey);
      const healthStore = getHealthStore();

      // Extract error message if request failed
      let errorMessage: string | undefined;
      let errorResponseBody: string | undefined;
      // Check for SSE stream error (errors inside HTTP 200 response)
      const sseError = req.sseError;
      const hasSseError = sseError && (sseError.type || sseError.code || sseError.message);
      const hasOutputTokens = usage?.output_tokens && usage.output_tokens > 0;
      const isFailedRequest = hardFailed || (hasSseError && !hasOutputTokens);
      if (isFailedRequest) {
        errorMessage = req.errorMessage || reply.errorMessage || (req.error?.message || req.error?.toString?.() || undefined);
        if (hasSseError) {
          errorMessage = errorMessage || JSON.stringify(sseError);
          errorResponseBody = JSON.stringify(sseError);
        }
        errorResponseBody = errorResponseBody || req.errorResponseBody;
        // Record failure to health store
        const model = getRequestModel(req);
        // Classify rate-limit errors — use markRateLimited to immediately isolate
        // (bypasses the 3-failure threshold) with a time-based auto-recover.
        const isRateLimit = isRateLimitMessage(reply.statusCode, errorMessage);
        if (isRateLimit) {
          healthStore.markRateLimited(req.provider || "", model, 120, errorMessage);
        } else {
          healthStore.recordFailure(req.provider || "", model, errorMessage);
        }
      } else {
        // Record success to health store
        const model = getRequestModel(req);
        healthStore.recordSuccess(req.provider || "", model);
      }

      // Compute cache read input tokens.
      // Anthropic-compatible providers that don't expose cache_read_input_tokens
      // (e.g. GLM/Zhipu /v1/messages) still report net input_tokens after cache
      // deduction, so we infer the cache hit from the difference between the
      // pre-cache tokenCount (computed by the router) and the reported input_tokens.
      let cacheReadInputTokens = usage?.cache_read_input_tokens ?? 0;
      // input_tokens of 0 is not a valid "no data" sentinel (providers report real
      // zero only in degenerate cases). Use the router's tokenCount estimate when
      // usage.input_tokens is missing OR zero, so a zeroed usage frame can't wipe
      // out the input token count for the whole request.
      const reportedInputTokens = usage?.input_tokens || 0;
      const rawInputTokens = reportedInputTokens || req.tokenCount || 0;
      if (!cacheReadInputTokens && req.tokenCount && usage?.input_tokens && usage.input_tokens < req.tokenCount) {
        cacheReadInputTokens = req.tokenCount - usage.input_tokens;
        if (cacheReadInputTokens) {
          console.log('[Usage] Inferred cache tokens:', {
            tokenCount: req.tokenCount,
            netInput: usage.input_tokens,
            impliedCache: cacheReadInputTokens,
          });
        }
      }
      const outputTokens = isFailedRequest ? 0 : (usage?.output_tokens || 0);
      if (!isFailedRequest && req.body?.stream && rawInputTokens === 0 && outputTokens === 0) {
        req.log?.warn?.({
          debug_log: true,
          reqId: req.id,
          phase: "usage_zero_stream",
          provider: req.provider,
          originalModel: req.originalModel || req.body?.model || "",
          model: getRequestModel(req),
          usageSessionId: sessionId,
          tokenCount: req.tokenCount,
          cachedUsage: usage,
          note: "Successful streaming request ended with zero usage. Check provider_stream_chunk usage_monitor and usage_capture_* logs.",
        });
      }

      appendUsage({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
        sessionId,
        provider: req.provider || "",
        originalModel: req.originalModel || req.body?.model || "",
        model: getRequestModel(req),
        upstreamModel: req.upstreamModel,
        modelFamily: req.modelFamily || "",
        scenarioType: req.scenarioType || "default",
        clientType: req.clientType || detectClientType(req),
        stream: req.body?.stream ?? false,
        inputTokens: rawInputTokens,
        outputTokens,
        cacheReadInputTokens,
        cacheCreationInputTokens: usage?.cache_creation_input_tokens || 0,
        // TTFT is only meaningful for streaming requests — a non-streaming
        // response arrives as one payload, so "first token" equals total
        // duration. Keep non-stream TTFT null so it neither pollutes the
        // per-record display nor the avgTtft aggregate.
        ttft: isFailedRequest || !req.body?.stream ? null : speedStats.ttft,
        tokensPerSecond: isFailedRequest ? null : speedStats.tokensPerSecond,
        durationMs: req.requestStartTime
          ? Math.round(performance.now() - req.requestStartTime)
          : 0,
        status: isFailedRequest ? "error" : "success",
        errorMessage,
        responseBody: errorResponseBody,
      });
      if (req.clientContext?.usageScope !== "session") {
        sessionUsageCache.delete(getUsageCacheKey(req));
      }
    } catch (e) {
      // Usage tracking must not affect the response
      console.error("Usage tracking error:", e);
    }
  });
}