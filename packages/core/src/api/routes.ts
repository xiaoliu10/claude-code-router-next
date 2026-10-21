import {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyRequest,
  FastifyReply,
} from "fastify";
import { RegisterProviderRequest, LLMProvider } from "@/types/llm";
import { sendUnifiedRequest } from "@/utils/request";
import { createApiError } from "./middleware";
import { classifyWorkBuddyError, credentialHeaders, getWorkBuddyAuthService, isWorkBuddyRuntime, workBuddySite, workBuddyChatUrl, workBuddySiteFromProvider, workBuddyFailoverCooldown, workBuddyPoolExhaustedError, workBuddyEnvelopeIsError } from "../services/workbuddy";
import {
  GEMINI_OAUTH_DATA_PLANE,
  GEMINI_OAUTH_SSE_PATH,
  classifyGeminiOauthError,
  geminiOauthError,
  getGeminiOauthAuthService,
  isGeminiOauthRuntime,
} from "../services/gemini-oauth";
import {
  isDebugLogEnabled,
  getDebugLogOptions,
  logProviderRequest,
  logProviderResponse,
  readStreamForDebug,
} from "@/utils/debug-log";
import { version } from "../../package.json";
import { ConfigService } from "@/services/config";
import { ProviderService } from "@/services/provider";
import { TransformerService } from "@/services/transformer";
import { Transformer } from "@/types/transformer";
import { getHealthStore } from "@/services/provider-health";
import { captureRateLimitHeaders } from "@/services/rate-limit";
import { getFallbackPromotionStore } from "@/utils/fallback-promotion";
import { rebindSessionModel } from "@/utils/concurrency-router";
import { OpenAIResponsesTransformer } from "../transformer/openai.responses.transformer";
import {
  isEventStreamResponse,
  looksLikeSSE,
  parseResponseJson,
  peekBodyForSSE,
  readBodyForSSE,
} from "../transformer/response-body";
import { router, findProviderModel, ProjectRoutingError } from "@/utils/router";
import { resolveProviderProxyUrl, getDirectDispatcher } from "@/services/proxy";

// Matches the CCR model-family aliases that CCR injects into managed clients
// (e.g. "ccr-opus", "ccr-sonnet[1m]"). Codex sends one of these as a bare model
// name to /v1/responses.
export const CCR_FAMILY_ALIAS = /^ccr-(opus|sonnet|haiku)(\[1m\])?$/i;

/**
 * Normalize a Responses API (Codex) request body into a unified chat request so
 * downstream transformers (and the family router) can process it.
 * Codex sends: { model, input: [...], instructions, tools, stream, ... }
 * We convert to: { model, messages: [...], system, tools, stream, ... }
 */
export function normalizeResponsesBody(body: any): void {
  const messages: any[] = [];
  const input = Array.isArray(body.input) ? body.input : [body.input];
  for (const item of input) {
    if (item.type === "function_call") {
      messages.push({
        role: "assistant",
        tool_calls: [{
          id: item.call_id,
          type: "function",
          function: { name: item.name, arguments: item.arguments || "{}" },
        }],
      });
    } else if (item.type === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: item.call_id,
        content: typeof item.output === "string" ? item.output : JSON.stringify(item.output),
      });
    } else if (item.type === "reasoning") {
      // Preserve reasoning items (thinking summaries from auto-compact) so the
      // downstream model can see compacted context. Convert to an assistant
      // message with thinking content so non-OpenAI providers can process it.
      const summaryText = Array.isArray(item.summary)
        ? item.summary
            .filter((s: any) => s.type === "summary_text" && s.text)
            .map((s: any) => s.text)
            .join("\n")
        : "";
      if (summaryText) {
        messages.push({
          role: "assistant",
          content: [{ type: "text", text: `[reasoning]\n${summaryText}` }],
          _reasoningItem: true,  // marker for transformRequestIn to restore
        });
      }
    } else if (item.role) {
      // user / assistant / system messages
      let content = item.content;
      // Convert Responses API content format to unified format
      if (Array.isArray(content)) {
        content = content.map((c: any) => {
          if (c.type === "input_text") return { type: "text", text: c.text };
          if (c.type === "output_text") return { type: "text", text: c.text };
          if (c.type === "input_image") return { type: "image_url", image_url: { url: c.image_url }, media_type: c.mime_type };
          return c;
        });
      }
      messages.push({ role: item.role, content });
    }
  }
  body.messages = messages;
  delete body.input;
  // Move instructions to system
  if (body.instructions && typeof body.instructions === "string") {
    body.system = body.instructions;
    delete body.instructions;
  }
  // Normalize tools from Responses API format to OpenAI format
  if (Array.isArray(body.tools)) {
    body.tools = body.tools
      .filter((tool: any) => tool && typeof tool === "object")
      .map((tool: any) => {
        // Responses API tools: { type: "function", name: "X", description: "...", parameters: {...} }
        if (tool.type === "function" && tool.name && !tool.function) {
          return {
            type: "function",
            function: {
              name: tool.name,
              description: tool.description || "",
              parameters: tool.parameters || { type: "object", properties: {} },
            },
          };
        }
        // Standard OpenAI format already
        if (tool.function?.name) {
          return tool;
        }
        // Codex web_search tool
        if (tool.type === "web_search") {
          return {
            type: "function",
            function: {
              name: "web_search",
              description: "Search the web",
              parameters: { type: "object", properties: { query: { type: "string" } } },
            },
          };
        }
        // Drop malformed tools rather than crashing downstream
        return null;
      })
      .filter(Boolean);
  }
  // Normalize reasoning
  if (body.reasoning && typeof body.reasoning === "object") {
    body.reasoning = { enabled: true, effort: body.reasoning.effort };
  }
  // Remove Responses API-specific fields that are meaningless for third-party
  // providers. CCR does not implement a conversation store, so:
  //   - store: OpenAI server-side conversation storage (not supported by CCR)
  //   - previous_response_id: references a stored response (CCR cannot resolve it)
  //   - include: requests extra data in response (not supported by third-party APIs)
  // Keeping these fields would either cause errors at third-party providers or
  // silently be ignored, breaking auto-compact context continuity.
  delete body.store;
  delete body.previous_response_id;
  delete body.include;
}

// Extend FastifyInstance to include custom services
declare module "fastify" {
  interface FastifyInstance {
    configService: ConfigService;
    providerService: ProviderService;
    transformerService: TransformerService;
    recordUsage?: (data: any) => void;
  }

  interface FastifyRequest {
    provider?: string;
  }
}

/**
 * Main handler for transformer endpoints
 * Coordinates the entire request processing flow: validate provider, handle request transformers,
 * send request, handle response transformers, format response
 */
async function handleTransformerEndpoint(
  req: FastifyRequest,
  reply: FastifyReply,
  fastify: FastifyInstance,
  transformer: any
) {
  const body = req.body as any;
  ((req as any).ccrHookOrder ||= []).push("handler");

  // Normalize Responses API (Codex) format into a unified chat request BEFORE
  // provider resolution. This must happen first so that a CCR family alias can be
  // routed through the shared family router below, which needs messages/system/tools
  // to count tokens.
  if (transformer.endPoint === "/v1/responses" && body?.input && !body?.messages) {
    normalizeResponsesBody(body);
  }

  // Codex sends a bare CCR family alias (e.g. "ccr-opus") to /v1/responses. Run the
  // same family router used for /v1/messages so Codex is routed by the CCR model
  // family (default/think/longContext/webSearch) instead of falling back to
  // Router.default. The router rewrites body.model to "provider,model".
  if (
    transformer.endPoint === "/v1/responses" &&
    !req.provider &&
    typeof body?.model === "string" &&
    CCR_FAMILY_ALIAS.test(body.model)
  ) {
    await router(req, reply, {
      configService: fastify.configService,
      tokenizerService: (fastify as any).tokenizerService,
    });
  }

  // For /v1/responses (Codex) the modelProviderMiddleware does not run because
  // it only handles /v1/messages. Parse provider from body.model here.
  let providerName = req.provider as string | undefined;
  if (!providerName && body?.model) {
    const parts = body.model.split(",");
    if (parts.length > 1) {
      providerName = parts[0];
      body.model = parts.slice(1).join(",");
    }
  }
  // If still no provider (e.g. Codex sends a CCR alias without comma), try
  // resolving via the provider service's model routes which index by model name.
  let provider = providerName
    ? fastify.providerService.getProvider(providerName)
    : undefined;
  if (!provider && body?.model) {
    const route = fastify.providerService.resolveModelRoute(body.model);
    if (route) {
      provider = route.provider;
      body.model = route.targetModel;
    }
  }
  // Last resort: use the Router's default config to resolve the model.
  // This handles Codex-style aliases that don't match any registered model
  // directly but can be mapped via family/default routing.
  if (!provider && body?.model) {
    const routerConfig = fastify.configService.get("Router");
    const defaultRoute = routerConfig?.default;
    if (defaultRoute && defaultRoute.includes(",")) {
      const [pName, ...mParts] = defaultRoute.split(",");
      const p = fastify.providerService.getProvider(pName);
      if (p) {
        provider = p;
        body.model = mParts.join(",");
      }
    }
  }

  // Save original model BEFORE provider resolution mutates body.model (below).
  // modelProviderMiddleware may already have set req.originalModel for /v1/messages,
  // but for /v1/responses (Codex) the middleware doesn't run.
  if (!(req as any).originalModel) {
    (req as any).originalModel = body?.model;
  }

  // Validate provider exists
  if (!provider) {
    throw createApiError(
      `Provider '${providerName}' not found`,
      404,
      "provider_not_found"
    );
  }

  // Expose provider name on the request so downstream hooks (onResponse in
  // server/index.ts) can record it for usage stats and health tracking.
  // This is especially important for /v1/responses where modelProviderMiddleware
  // does not run.
  (req as any).provider = provider.name || providerName;

  // Detect if this is a codex client hitting /v1/messages. Codex sometimes
  // switches from /v1/responses to /v1/messages mid-session. When that happens
  // the Anthropic transformer runs (endpoint = /v1/messages), but the response
  // needs to be converted to Responses API format for codex to parse it.
  // We flag the request so processResponseTransformers can apply the conversion.
  const codexDetected = isCodexClient(req);
  const isCodexOnMessagesEndpoint =
    transformer.endPoint === "/v1/messages" &&
    codexDetected;

  // DEBUG: Set a response header to verify codex detection
  if (codexDetected) {
    reply.header("X-Codex-Detected", "true");
  }
  if (isCodexOnMessagesEndpoint) {
    reply.header("X-Codex-On-Messages", "true");
  }

  // Store codex flags on the request so handleFallback can propagate them
  (req as any).isCodexOnMessagesEndpoint = isCodexOnMessagesEndpoint;
  (req as any).codexDetected = codexDetected;

  try {
    // Safety net: convert any Responses API (Codex) body that was not already
    // normalized above (idempotent — the guard is false once converted).
    if (transformer.endPoint === "/v1/responses" && body.input && !body.messages) {
      normalizeResponsesBody(body);
    }

    // One shared transformer context per request. Provider transformers stash
    // request-phase state on it (e.g. the WorkBuddy tool-name map and the
    // client's original stream flag) that the response-phase transformers of
    // the SAME request must see; building a fresh object per phase silently
    // drops that state.
    const transformerContext: any = { req, isCodexOnMessagesEndpoint };

    // Process request transformer chain
    const { requestBody, config, bypass } = await processRequestTransformers(
      body,
      provider,
      transformer,
      req.headers,
      transformerContext
    );

    // Hoist system messages to the front of the messages array and dedupe exact
    // repeats. OpenAI-compatible providers (DeepSeek V4, GLM, vLLM) require the
    // [system, user, assistant] order; placing system after user/assistant can
    // produce garbled output. Deduping also keeps the leading prefix stable for
    // upstream prompt caching when Claude Code appends identical reminder system
    // messages every few turns. Note: a genuinely new (non-duplicate) system
    // reminder still shifts the front block and busts the cache — we mitigate that
    // separately by stripping Claude Code's dynamic attribution header on takeover.
    if (requestBody?.messages && !bypass && !(req as any).isTargetAnthropic) {
      const msgs = requestBody.messages;
      const seenSystem = new Set<string>();
      const systemMsgs: any[] = [];
      const otherMsgs: any[] = [];
      for (const message of msgs) {
        if (message?.role !== "system") {
          otherMsgs.push(message);
          continue;
        }
        const key = JSON.stringify(message.content ?? "");
        if (!seenSystem.has(key)) {
          seenSystem.add(key);
          systemMsgs.push(message);
        }
      }
      if (systemMsgs.length > 0 && otherMsgs.length > 0) {
        requestBody.messages = [...systemMsgs, ...otherMsgs];
      }
    }

    // Send request to LLM provider
    const response = await sendRequestToProvider(
      requestBody,
      config,
      provider,
      fastify,
      bypass,
      transformer,
      transformerContext
    );

    // Capture rate limit headers from upstream response
    try {
      if (provider?.baseUrl && response?.headers) {
        captureRateLimitHeaders(providerName, provider.baseUrl, response.headers);
      }
    } catch {}

    // Process response transformer chain
    let finalResponse = await processResponseTransformers(
      requestBody,
      response,
      provider,
      transformer,
      bypass,
      transformerContext
    );

    finalResponse = await validateStreamingResponse(body, finalResponse, provider.name || providerName);

    const result = formatResponse(finalResponse, reply, body, fastify);

    try {
      const model = body.model || (req as any).originalModel;
      if (providerName && model) {
        getHealthStore().recordSuccess(providerName, model);
      }
    } catch {}

    return result;
  } catch (error: any) {
    // ProjectRoutingError must propagate directly — it is a configuration
    // error, not a transient upstream failure. No retry, no fallback.
    if (error instanceof ProjectRoutingError) {
      throw error;
    }
    // Double-check: retry the same model once before falling back.
    // Transient provider errors (network jitter, momentary overload, empty SSE)
    // often resolve on a second attempt, avoiding unnecessary model switches.
    // WorkBuddy pool/terminal errors already exhausted their bounded account
    // budget; generic transient errors (5xx/empty stream/network) keep one retry.
    if (!(req as any).__retryAttempted && error?.code !== "workbuddy_reauth" && !isTerminalWorkBuddyError(error)) {
      (req as any).__retryAttempted = true;
      try {
        return await handleTransformerEndpoint(req, reply, fastify, transformer);
      } catch (retryError: any) {
        // If the recursive call already tried fallback and it failed,
        // re-throw immediately — don't try fallback a second time.
        if ((req as any).__fallbackExhausted) {
          throw retryError;
        }
        error = retryError;
      }
    }
    // Handle fallback for any request error (timeout, network, API errors)
    const fallbackResult = await handleFallback(req, reply, fastify, transformer, error);
    if (fallbackResult) {
      return fallbackResult;
    }
    (req as any).__fallbackExhausted = true;
    throw error;
  }
}

/**
 * Validate streaming responses have data before forwarding.
 * When GLM/Zhipu returns an empty 200 SSE (e.g. rate-limited or overloaded),
 * the Anthropic-transformed stream lacks message_start, causing Claude Code's
 * SDK to report "empty or malformed response". We detect this early and throw
 * so fallback can try the current model again or move to the next model.
 */
async function validateStreamingResponse(
  body: any,
  finalResponse: any,
  providerName?: string
): Promise<any> {
  if (!body?.stream || !finalResponse?.body) {
    return finalResponse;
  }

  const reader = finalResponse.body.getReader();
  const decoder = new TextDecoder();
  // Accumulate across chunks before judging: the first chunk may be empty, an
  // SSE comment heartbeat (": ping"), or a partial "ev" fragment of the first
  // event. A single read would misjudge a healthy stream as data-less.
  const firstChunks: Uint8Array[] = [];
  let accText = "";
  for (let i = 0; i < 8; i++) {
    const result = await reader.read();
    if (result.done) {
      break;
    }
    if (result.value) {
      firstChunks.push(result.value);
      accText += decoder.decode(result.value, { stream: true });
    }
    // Stop once we have a real data line to judge on.
    if (accText.split("\n").some((line) => line.startsWith("data:"))) {
      break;
    }
  }
  accText += decoder.decode();

  if (firstChunks.length === 0) {
    reader.releaseLock();
    throw createApiError(
      `Provider returned empty streaming response from ${providerName}`,
      400,
      "provider_response_error"
    );
  }

  if (accText.includes("event: error")) {
    reader.releaseLock();
    const errMsg = accText.length < 500 ? accText : accText.slice(0, 500);
    throw createApiError(
      `Provider ${providerName} returned error in SSE stream: ${errMsg}`,
      400,
      "provider_response_error"
    );
  }

  const dataLines = accText.split('\n').filter(
    (line: string) => line.startsWith('data:') && line.trim().length > 5
  );
  if (dataLines.length === 0) {
    reader.releaseLock();
    const preview = accText.length < 500 ? accText : accText.slice(0, 500);
    throw createApiError(
      `Provider ${providerName} returned streaming response with no SSE data lines: ${preview}`,
      400,
      "provider_response_error"
    );
  }

  const remainingStream = new ReadableStream({
    start: (controller) => {
      for (const chunk of firstChunks) {
        controller.enqueue(chunk);
      }
      const pump = () => {
        reader.read().then(({ done, value }) => {
          if (done) {
            controller.close();
          } else {
            controller.enqueue(value);
            pump();
          }
        }).catch((err) => controller.error(err));
      };
      pump();
    },
    cancel: () => {
      reader.cancel();
    },
  });

  return new Response(remainingStream, {
    headers: finalResponse.headers,
    status: finalResponse.status,
    statusText: finalResponse.statusText,
  });
}

/**
 * Handle fallback logic when request fails
 * Tries each fallback model in sequence until one succeeds
 * Skips models in fail pool (open state), uses half-open models as lower priority
 */
async function handleFallback(
  req: FastifyRequest,
  reply: FastifyReply,
  fastify: FastifyInstance,
  transformer: any,
  error: any
): Promise<any> {
  const scenarioType = (req as any).scenarioType || 'default';
  const familyFallback = (req as any).familyFallback;
  const modelFamily = (req as any).modelFamily;
  // Prefer the project-aware fallback config resolved by router() so that
  // per-project Router.fallback overrides (and the enableFallback gate below)
  // are honored instead of always falling back to the global config.
  // In strict project mode, fallback must come ONLY from the project Router
  // (req.fallbackConfig). If the project has no fallback, req.fallbackConfig
  // is undefined and no fallback is available — global fallback must NOT be
  // inherited.
  const globalFallback = (req as any).strictProjectRouting
    ? (req as any).fallbackConfig
    : (req as any).fallbackConfig ?? fastify.configService.get<any>('fallback');
  const healthStore = getHealthStore();

  const originalProvider = req.provider || "";
  const originalModel = (req.body as any).model || "";
  const attemptedFallbacks = new Set<string>();

  // Hoisted so the fallback-success path below (which calls forceOpen) can skip
  // forceOpen for rate-limit errors — markRateLimited already set rateLimitUntil,
  // and forceOpen would delete it.
  const isRateLimit = error?.statusCode === 429 ||
    error?.isRateLimit === true ||
    (error?.rawBody && isRateLimitError(error.rawBody)) ||
    (error?.message && isRateLimitError(error.message));

  if (originalProvider && originalModel) {
    // WorkBuddy upstream errors carry their own classification and cooldown:
    // a 6004 rate limit is per provider+model (not the whole account), and a
    // 11140 account restriction is terminal for hours so it must not be retried
    // on every request.
    if (error?.workbuddy && (error.code === "rate_limit" || error.code === "insufficient_quota")) {
      healthStore.markRateLimited(originalProvider, originalModel, error.cooldownSeconds ?? 900, error.message);
      req.log.warn(`WorkBuddy model ${originalProvider},${originalModel} cooled down for ${error.cooldownSeconds ?? 900}s (${error.code})`);
    } else if (error?.workbuddy && error.code === "workbuddy_account_restricted") {
      healthStore.forceOpen(originalProvider, originalModel, error.message);
      req.log.warn(`WorkBuddy account restricted; ${originalProvider},${originalModel} parked for ${error.cooldownSeconds ?? 7200}s`);
    } else if (isRateLimit) {
      // Use markRateLimited for rate-limit errors instead of recordFailure
      // so the model is immediately isolated (bypassing the 3-failure threshold)
      // and auto-recovers after a cooldown period.
      healthStore.markRateLimited(originalProvider, originalModel, 120, error?.message);
      req.log.warn(`Primary model ${originalProvider},${originalModel} rate-limited, will try fallbacks`);
    } else {
      healthStore.recordFailure(originalProvider, originalModel, error?.message);
    }
    attemptedFallbacks.add(`${originalProvider},${originalModel}`);

    // Record failed primary model attempt in usage stats
    fastify.recordUsage?.({
      provider: originalProvider,
      model: originalModel,
      originalModel: (req as any).originalModel || originalModel,
      scenarioType,
      modelFamily: (req as any).modelFamily,
      errorMessage: error?.message || String(error),
      sessionId: (req as any).sessionId || (req as any).usageSessionId || req.id,
      stream: (req.body as any).stream,
      inputTokens: (req as any).tokenCount || 0,
      req,
    });
  }

  // Check if fallback is enabled (default: false - disabled when not set).
  // Use the project-aware flag set by router(); fall back to the global
  // config for requests that didn't go through router().
  const enableFallback = (req as any).enableFallback ?? (fastify.configService.get<any>('Router')?.enableFallback === true);
  if (!enableFallback) {
    req.log.info(`Fallback disabled by configuration, skipping fallback attempts`);
    return null;
  }

  const parseFallbackModel = (fallbackModel: string) => {
    const [provider, ...modelParts] = fallbackModel.split(',');
    const providerName = provider?.trim();
    const model = modelParts.join(',').trim();

    if (!providerName || !model) {
      return null;
    }

    return {
      provider: providerName,
      model,
      key: `${providerName},${model}`,
    };
  };

  const fallbackStages: Array<{ name: string; models: string[] }> = [];
  if (modelFamily) {
    const familyScenarioFallback = familyFallback?.[scenarioType];
    if (Array.isArray(familyScenarioFallback) && familyScenarioFallback.length > 0) {
      fallbackStages.push({
        name: `${modelFamily}/${scenarioType}`,
        models: familyScenarioFallback,
      });
    } else {
      // In strict project mode there is no global fallback to try.
      const strictProject = (req as any).strictProjectRouting;
      req.log.warn(
        `No ${modelFamily} fallback configured for ${scenarioType}; ${
          strictProject ? 'no project fallback available' : 'will try global fallback'
        }`
      );
    }
  }

  if (Array.isArray(globalFallback?.[scenarioType]) && globalFallback[scenarioType].length > 0) {
    fallbackStages.push({
      name: `global/${scenarioType}`,
      models: globalFallback[scenarioType],
    });
  }

  // Safety net: if request contains images but no fallback was found for the
  // current scenarioType, also try fallback.image. This covers edge cases
  // where scenarioType wasn't set to 'image' by the router.
  if (fallbackStages.length === 0 && scenarioType !== 'image') {
    const body = req.body as any;
    const hasImages = body?.messages?.some(
      (msg: any) =>
        msg.role === "user" &&
        Array.isArray(msg.content) &&
        msg.content.some(
          (item: any) =>
            item.type === "image" ||
            item.type === "image_url" ||
            (Array.isArray(item?.content) &&
              item.content.some(
                (sub: any) => sub.type === "image" || sub.type === "image_url"
              ))
        )
    );
    if (hasImages && Array.isArray(globalFallback?.image) && globalFallback.image.length > 0) {
      req.log.info(`No fallback for scenario '${scenarioType}', but request has images — trying fallback.image`);
      fallbackStages.push({
        name: 'global/image (auto-detected)',
        models: globalFallback.image,
      });
    }
  }

  if (fallbackStages.length === 0) {
    return null;
  }

  // Reauthentication failures are account-wide and terminal: probing fallback models
  // cannot renew the WorkBuddy sign-in and would multiply a rejected large request.
  const terminalWorkBuddyReauth = error?.workbuddy === true && error?.nonRetryable === true && error.code === "workbuddy_reauth";
  if (terminalWorkBuddyReauth) return null;

  const totalFallbacks = fallbackStages.reduce((total, stage) => total + stage.models.length, 0);
  req.log.warn(`Request failed for ${scenarioType}, trying ${totalFallbacks} fallback models across ${fallbackStages.length} fallback stage(s)`);

  for (const fallbackStage of fallbackStages) {
    req.log.info(`Trying ${fallbackStage.name} fallback stage with ${fallbackStage.models.length} models`);

    // Try each fallback model in configured order, skipping open (fail pool) models
    for (const fallbackModel of fallbackStage.models) {
      const fallbackRoute = parseFallbackModel(fallbackModel);
      if (!fallbackRoute) {
        req.log.warn(`Fallback model '${fallbackModel}' is invalid, skipping`);
        continue;
      }

      if (attemptedFallbacks.has(fallbackRoute.key)) {
        continue;
      }
      attemptedFallbacks.add(fallbackRoute.key);

      // Resolve the fallback model against the live provider registry early so
      // both the success and error paths use the same canonical values.
      // IMPORTANT: use providerService.getProviders() (registered LLMProvider[]
      // with the `baseUrl` field) rather than configService.get("providers")
      // (raw ConfigProvider[] with `api_base_url`). sendRequestToProvider below
      // reads provider.baseUrl to build the upstream URL — a ConfigProvider has
      // no baseUrl, so new URL(undefined) throws "Invalid URL" for every
      // fallback model. router.ts can use the raw array because it only reads
      // name/models/enabled, never baseUrl.
      const providers = fastify.providerService.getProviders();
      const configuredFallback = findProviderModel(
        providers,
        fallbackRoute.provider,
        fallbackRoute.model
      );
      if (!configuredFallback) {
        req.log.warn(`Fallback model ${fallbackModel} is not configured or provider is disabled, skipping`);
        continue;
      }

      // Shorthand aliases used throughout the try/catch
      const fbProviderName = configuredFallback.provider.name;
      const fbModel = configuredFallback.model;

      // Skip if model is in fail pool (open state)
      if (!healthStore.isAvailable(fbProviderName, fbModel)) {
        req.log.warn(`Fallback model ${fallbackModel} unavailable (fail pool), skipping`);
        continue;
      }

      let fallbackError: any;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          req.log.info(`Trying fallback model: ${fbProviderName},${fbModel}${attempt > 1 ? " (retry)" : ""}`);

          // Update request with fallback model
          const newBody = { ...(req.body as any) };
          newBody.model = fbModel;

          // Create new request object with updated provider and body
          const newReq = {
            ...req,
            provider: fbProviderName,
            body: newBody,
          };

          const provider = configuredFallback.provider;

          // One shared transformer context per fallback attempt (same reason
          // as the primary path): request-phase state must reach the
          // response-phase transformers of the same attempt.
          const fbContext: any = {
            req: newReq,
            isCodexOnMessagesEndpoint: (req as any).isCodexOnMessagesEndpoint || false,
          };

          // Process request transformer chain
          const { requestBody, config, bypass } = await processRequestTransformers(
            newBody,
            provider,
            transformer,
            req.headers,
            fbContext
          );

          // Send request to LLM provider
          const response = await sendRequestToProvider(
            requestBody,
            config,
            provider,
            fastify,
            bypass,
            transformer,
            fbContext
          );

          // Capture rate limit headers from upstream response
          try {
            if (provider?.baseUrl && response?.headers) {
              captureRateLimitHeaders(fbProviderName, provider.baseUrl, response.headers);
            }
          } catch {}

          // Process response transformer chain — propagate codex flags so the
          // fallback response also gets Responses API conversion when needed.
          let finalResponse = await processResponseTransformers(
            requestBody,
            response,
            provider,
            transformer,
            bypass,
            fbContext
          );
          finalResponse = await validateStreamingResponse(newBody, finalResponse, fbProviderName);

          req.log.info(`Fallback model ${fbProviderName},${fbModel} succeeded`);

          // Record success for the fallback model
          healthStore.recordSuccess(fbProviderName, fbModel);

          // Promote the fallback model globally for this primary + scenario
          // This ensures all clients skip the failing primary until TTL expires.
          // In strict project mode, skip global promotion so project requests
          // don't pollute the global promotion store and vice versa.
          if (originalProvider && originalModel && !(req as any).strictProjectRouting) {
            const fallbackPromotion = getFallbackPromotionStore();
            fallbackPromotion.promote(
              originalProvider,
              originalModel,
              scenarioType,
              fbProviderName,
              fbModel
            );
            req.log.info(`Promoted fallback model ${fbProviderName},${fbModel} for ${originalProvider},${originalModel}:${scenarioType}`);

            // Immediately mark the original model as unavailable so routing skips it
            // even when promotion TTL expires or is cleared.
            // SKIP forceOpen for rate-limit errors — markRateLimited was already called
            // above and set rateLimitUntil; forceOpen would delete that cooldown timestamp.
            if (!isRateLimit) {
              healthStore.forceOpen(originalProvider, originalModel, error?.message);
              req.log.info(`Marked original model ${originalProvider},${originalModel} as unavailable`);
            } else {
              req.log.info(`Rate-limited original model ${originalProvider},${originalModel} already marked unavailable with cooldown`);
            }
          }

          // Write back to original req so onResponse hook records correct provider/model
          req.provider = fbProviderName;
          req.body = newBody;

          // Concurrency-priority mode: rebind the session to the fallback model
          // that just succeeded, so subsequent requests in this session stick to
          // it (and the in-flight lease follows the new model). No-op when the
          // request did not participate in concurrency-priority routing.
          rebindSessionModel(req, `${fbProviderName},${fbModel}`);

          // Format and return response
          return formatResponse(finalResponse, reply, newBody, fastify);
        } catch (error: any) {
          fallbackError = error;
          // Never restart a terminal WorkBuddy account-pool attempt budget.
          if (error?.code === "workbuddy_reauth" || isTerminalWorkBuddyError(error)) break;
          if (attempt === 1) {
            req.log.warn(`Fallback model ${fbProviderName},${fbModel} failed, retrying once: ${error.message}`);
            continue;
          }
        }
      }

      healthStore.recordFailure(fbProviderName, fbModel, fallbackError?.message);
      req.log.warn(`Fallback model ${fbProviderName},${fbModel} failed after retry: ${fallbackError?.message}`);

      // Record failed fallback attempt in usage stats
      fastify.recordUsage?.({
        provider: fbProviderName,
        model: fbModel,
        originalModel: (req as any).originalModel || originalModel || (req.body as any).model,
        scenarioType,
        modelFamily: (req as any).modelFamily,
        errorMessage: fallbackError?.message || String(fallbackError),
        sessionId: (req as any).sessionId || (req as any).usageSessionId || req.id,
        stream: (req.body as any).stream,
        inputTokens: (req as any).tokenCount || 0,
        req,
      });

      continue;
    }
  }

  req.log.error(`All fallback models failed for ${scenarioType}`);
  return null;
}

/**
 * Process request transformer chain
 * Sequentially execute transformRequestOut, provider transformers, model-specific transformers
 * Returns processed request body, config, and flag indicating whether to skip transformers
 */
async function processRequestTransformers(
  body: any,
  provider: any,
  transformer: any,
  headers: any,
  context: any
) {
  // Deep clone the request body to preserve original messages for caching
  // and to ensure thinking blocks are not lost when switching between models
  let requestBody = JSON.parse(JSON.stringify(body));

  // Normalize per-request "cch=xxx;" hash in billing header system messages.
  // Claude Code injects a rotating hash (cch=...) that changes every request,
  // breaking prompt cache prefix matching on upstream providers like GLM.
  // Keep the field shape but replace the value with a stable token.
  // Must run BEFORE transformers which may restructure system into messages.
  const sys = requestBody?.system;
  if (typeof sys === "string" && sys.includes("cch=")) {
    requestBody.system = sys.replace(/cch=[^;]+;?/g, "cch=ccr-stable;");
  } else if (Array.isArray(sys)) {
    for (let i = 0; i < sys.length; i++) {
      const item = sys[i];
      const t = typeof item === "string" ? item : (item?.text ?? "");
      if (t.includes("cch=")) {
        const cleaned = t.replace(/cch=[^;]+;?/g, "cch=ccr-stable;");
        if (typeof item === "string") {
          sys[i] = cleaned;
        } else if (typeof item?.text === "string") {
          item.text = cleaned;
        }
      }
    }
  }

  let config: any = {};
  let bypass = false;

  // Check if transformers should be bypassed (passthrough mode)
  bypass = shouldBypassTransformers(provider, transformer, body);

  if (bypass) {
    if (headers instanceof Headers) {
      headers.delete("content-length");
    } else {
      delete headers["content-length"];
    }
    config.headers = headers;
  }

  // Execute transformer's transformRequestOut method
  if (!bypass && typeof transformer.transformRequestOut === "function") {
    const transformOut = await transformer.transformRequestOut(requestBody);
    if (transformOut.body) {
      requestBody = transformOut.body;
      config = transformOut.config || {};
    } else {
      requestBody = transformOut;
    }
  }

  // Execute provider-level transformers
  if (!bypass && provider.transformer?.use?.length) {
    for (const providerTransformer of provider.transformer.use) {
      if (
        !providerTransformer ||
        typeof providerTransformer.transformRequestIn !== "function"
      ) {
        continue;
      }
      const transformIn = await providerTransformer.transformRequestIn(
        requestBody,
        provider,
        context
      );
      if (transformIn.body) {
        requestBody = transformIn.body;
        config = { ...config, ...transformIn.config };
      } else {
        requestBody = transformIn;
      }
    }
  }

  // Execute model-specific transformers
  if (!bypass && provider.transformer?.[body.model]?.use?.length) {
    for (const modelTransformer of provider.transformer[body.model].use) {
      if (
        !modelTransformer ||
        typeof modelTransformer.transformRequestIn !== "function"
      ) {
        continue;
      }
      requestBody = await modelTransformer.transformRequestIn(
        requestBody,
        provider,
        context
      );
    }
  }

  return { requestBody, config, bypass };
}

/**
 * Determine if transformers should be bypassed (passthrough mode)
 * Skip other transformers when provider only uses one transformer and it matches the current one
 */
function shouldBypassTransformers(
  provider: any,
  transformer: any,
  body: any
): boolean {
  // If the target API is OpenAI-compatible (/v1/chat/completions) but the system field
  // is an object array (Anthropic format), we must process the request through
  // transformers to convert system array into messages[0] with role=system.
  // Without this conversion, the system prompt is silently dropped by the
  // OpenAI-compatible API, which prevents prefix-based prompt caching.
  if (transformer.endPoint === "/v1/chat/completions" && Array.isArray(body?.system)) {
    return false;
  }

  return (
    provider.transformer?.use?.length === 1 &&
    provider.transformer.use[0].name === transformer.name &&
    (!provider.transformer?.[body.model]?.use.length ||
      (provider.transformer?.[body.model]?.use.length === 1 &&
        provider.transformer?.[body.model]?.use[0].name === transformer.name))
  );
}

/**
 * Stamp a canonical upstream session-affinity carrier from the client's
 * validated stableSessionId. LiteLLM reads x-litellm-session-id (its generic
 * x-<vendor>-session-id scan ignores x-session-affinity), so this is what
 * groups a whole conversation's spend logs under one session id instead of
 * a fresh trace id per request.
 *
 * Scoped to pi deliberately: only pi sessions advertise their id through the
 * managed session-affinity header, so only that value is safe to publish as a
 * conversation identity upstream. Claude Code/ZCode/Qwen session ids stay
 * internal (they are derived from transcripts and are not the client's own
 * advertised identity), and forwarding them would leak internal identifiers to
 * providers that have no relationship to the local session store.
 * applyClientAdapter already strips the client's raw carriers, so no passthrough
 * value can shadow this one; we still delete any conflicting case variants to
 * guarantee the stable id wins. Mutates headers in place.
 */
export function stampUpstreamSessionId(
  headers: Record<string, string>,
  req: any
): void {
  if (req?.clientType !== "pi") {
    return;
  }
  const stableSessionId = req?.clientContext?.stableSessionId;
  if (typeof stableSessionId !== "string" || !stableSessionId) {
    return;
  }
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === "x-litellm-session-id") {
      delete headers[key];
    }
  }
  headers["x-litellm-session-id"] = stableSessionId;
}

/**
 * Detect if the request comes from a codex (OpenAI Codex CLI) client.
 * Codex sometimes switches from /v1/responses to /v1/messages mid-session,
 * so we need to detect it regardless of which endpoint it hits.
 */
function isCodexClient(req: any): boolean {
  if (req.clientType) {
    return req.clientType === "codex";
  }

  const headers = req.headers || {};
  const billingHeader = headers["x-anthropic-billing-header"] || "";
  if (typeof billingHeader === "string" && billingHeader.includes("cc_version=")) {
    return false;
  }

  const userAgent = headers["user-agent"] || "";
  if (typeof userAgent === "string" && /codex/i.test(userAgent)) {
    return true;
  }

  const pathname = req.pathname || req.url || "";
  if (typeof pathname === "string" && pathname.split("?", 1)[0].endsWith("/v1/responses")) {
    return true;
  }

  const originalModel = req.originalModel || req.body?.model || "";
  return typeof originalModel === "string" &&
    originalModel.toLowerCase() === "ccr-codex";
}

/**
 * Send request to LLM provider
 * Handle authentication, build request config, send request and handle errors
 */
/**
 * WorkBuddy's front door resets the connection once a refused sign-in's request body passes
 * EDGE_READS bytes (measured on both builds, magpie P:L1152-1160). Above that size a bare
 * ECONNRESET says nothing about the cause, so the send failure is probed instead of guessed.
 */
const WORKBUDDY_EDGE_READS = 2 * 1024 * 1024;
function exceedsWorkBuddyEdgeReads(body: any): boolean {
  try { return Buffer.byteLength(JSON.stringify(body ?? {})) > WORKBUDDY_EDGE_READS; }
  catch { return false; }
}

/** Pool/terminal errors must not reset the per-request account budget. */
function isTerminalWorkBuddyError(error: any): boolean {
  return error?.workbuddy === true && error?.nonRetryable === true && (error?.workbuddyPoolAttempted === true || [
    "workbuddy_reauth", "workbuddy_protocol_error", "workbuddy_model_hidden",
    "workbuddy_not_connected", "rate_limit", "insufficient_quota", "workbuddy_account_restricted",
  ].includes(error.code));
}

/**
 * Inspect only the pre-content SSE prefix. No bytes have reached the client at
 * this point: a classified error may safely rotate accounts. After any useful
 * content/tool/reasoning delta (or the bounded inspection budget) we return a
 * byte-identical replay stream and NEVER inspect/replay a later error.
 */
async function inspectWorkBuddySse(response: Response): Promise<Response> {
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) return response;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  const decoder = new TextDecoder();
  let pending = "", bytes = 0, done = false, committed = false;
  try {
    while (!done && !committed && bytes < 256 * 1024) {
      const next = await reader.read();
      done = next.done;
      if (next.value) {
        chunks.push(next.value);
        bytes += next.value.byteLength;
        pending += decoder.decode(next.value, { stream: true });
      }
      // SSE permits an unterminated final event; inspect it on EOF as well.
      if (done) pending += decoder.decode() + "\n\n";
      const events = pending.split(/\r\n\r\n|\n\n|\r\r/);
      pending = events.pop() ?? "";
      for (const event of events) {
        const data = event.split(/\r\n|\r|\n/).filter(line => line.startsWith("data:"))
          .map(line => line.slice(5).trimStart()).join("\n");
        if (!data) continue;
        if (data === "[DONE]") { committed = true; break; }
        let value: any;
        try { value = JSON.parse(data); } catch { committed = true; break; }
              if (workBuddyEnvelopeIsError(value)) throw classifyWorkBuddyError(response.status, value);
        committed = value?.choices?.some((choice: any) => {
          const delta = choice.delta ?? choice.message;
          return delta && Object.entries(delta).some(([key, v]) => key !== "role" && v != null && v !== "" && (!Array.isArray(v) || v.length > 0));
        }) || false;
        if (committed) break;
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index < chunks.length) { controller.enqueue(chunks[index++]); return; }
      if (done) { controller.close(); reader.releaseLock(); return; }
      try {
        const next = await reader.read();
        if (next.done) { done = true; controller.close(); reader.releaseLock(); }
        else controller.enqueue(next.value);
      } catch (error) { controller.error(error); }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/** §16: one request/model, sticky selection, each uid at most once. */
async function sendRequestToProvider(
  requestBody: any, config: any, provider: any, fastify: FastifyInstance,
  bypass: boolean, transformer: any, context: any
): Promise<Response> {
  if (!isWorkBuddyRuntime(provider)) return sendProviderAttempt(requestBody, config, provider, fastify, bypass, transformer, context);
  const service = getWorkBuddyAuthService();
  if (!service) throw new Error("WorkBuddy 认证服务未初始化");
  const site = workBuddySiteFromProvider(provider);
  const model = requestBody?.model;
  if (await service.isModelHidden(site, model)) {
    throw Object.assign(new Error("WorkBuddy 模型已隐藏，请在管理页恢复后重试"), {
      code: "workbuddy_model_hidden", statusCode: 422, workbuddy: true, nonRetryable: true,
    });
  }
  const poolSize = await service.poolAccountCount(site);
  // One request may retry (generic same-model retry, fallback's {...req} spread);
  // the ROTATION budget must survive those, so it lives on the request object.
  // A transient (non-rotatable) failure may still retry the SAME account once
  // via the outer retry — that is not an account rotation and stays within the
  // contract's per-request upstream-attempt bound (retry is one-shot).
  const state: any = ((context?.req as any).__workbuddyState ??= { attempted: new Map(), transient: new Set() });
  const attempted = state.attempted.get(site) ?? new Set<string>();
  state.attempted.set(site, attempted);
  let lastError: any;
  while (attempted.size < poolSize) {
    const credential = await service.currentCredential(site, model, [...attempted]);
    if (!credential || attempted.has(credential.uid)) break;
    attempted.add(credential.uid);
    try {
      const response = await sendProviderAttempt(requestBody, { ...config, headers: { ...config.headers }, workbuddyCredential: credential }, provider, fastify, bypass, transformer, context);
      return await inspectWorkBuddySse(response);
    } catch (error: any) {
      const cooldown = workBuddyFailoverCooldown(error, model);
      if (!cooldown) {
        // A transient failure after a prior rotation must not restart the pool
        // through the outer generic retry and exceed this request's budget.
        if (lastError) {
          const terminal = error?.workbuddy ? error : classifyWorkBuddyError(502, {});
          terminal.workbuddyPoolAttempted = true;
          throw terminal;
        }
        // Transient: the outer same-model retry may re-attempt this account.
        state.transient.add(site);
        throw error;
      }
      state.transient.delete(site);
      lastError = error;
      // Persist even for the last account: future requests must not hammer it.
      try { await service.markAccountCooldown(site, credential.uid, cooldown); }
      catch { throw error; } // preserve sanitized upstream error, never a raw filesystem error
      // Classifications only: no uid, body, token, or thrown store diagnostic.
      fastify.log.info({ code: error.code }, "WorkBuddy account cooldown recorded");
    }
  }
  if (lastError) { state.transient.delete(site); throw lastError; }
  if (attempted.size >= poolSize && poolSize > 0) {
    // Budget exhausted by earlier attempts of this same request. A pending
    // transient failure gets exactly one same-account retry (not a rotation);
    // anything else is the §16 terminal pool-exhausted error.
    if (state.transient.has(site)) {
      state.transient.delete(site);
      const credential = await service.currentCredential(site, model);
      if (credential) {
        try {
          const response = await sendProviderAttempt(requestBody, { ...config, headers: { ...config.headers }, workbuddyCredential: credential }, provider, fastify, bypass, transformer, context);
          return await inspectWorkBuddySse(response);
        } catch (retryError: any) {
          // Same cooldown bookkeeping as an in-loop attempt, so this account
          // cannot escape its cooldown for one later request.
          const cooldown = workBuddyFailoverCooldown(retryError, model);
          if (cooldown) {
            try { await service.markAccountCooldown(site, credential.uid, cooldown); }
            catch { throw retryError; }
          }
          throw retryError;
        }
      }
    }
    throw workBuddyPoolExhaustedError(await service.poolCooldownRemainingMs(site, model));
  }
  if (poolSize) throw workBuddyPoolExhaustedError(await service.poolCooldownRemainingMs(site, model));
  throw Object.assign(new Error("WorkBuddy 未导入登录态，请先在管理页导入"), { workbuddy: true, nonRetryable: true, statusCode: 409, code: "workbuddy_not_connected" });
}

async function sendProviderAttempt(
  requestBody: any,
  config: any,
  provider: any,
  fastify: FastifyInstance,
  bypass: boolean,
  transformer: any,
  context: any
) {
  // Managed WorkBuddy providers must always talk to the fixed HTTPS upstream.
  // The transformer auth() hook returns a config.url, but the URL is computed
  // above before the hook runs, so a config-supplied base_url could otherwise
  // win. Re-lock the URL for the managed provider immediately before the send.
  const workbuddyManaged = isWorkBuddyRuntime(provider);
  if (workbuddyManaged) {
    const service = getWorkBuddyAuthService();
    const credential = config.workbuddyCredential ?? await service?.currentCredential(workBuddySiteFromProvider(provider), requestBody?.model);
    if (!credential) throw new Error("WorkBuddy 未导入登录态，请先在管理页导入");
    config.workbuddyCredential = credential;
    const authTransformer = (provider.transformer?.use ?? []).find((item: any) => item?.name === "workbuddy" && typeof item.auth === "function");
    if (authTransformer && !bypass) {
      const auth = await authTransformer.auth(requestBody, provider, { ...context, config });
      config.headers = { ...config.headers, ...auth.config?.headers };
    }
    const fixed = new URL(workBuddyChatUrl(workBuddySite(credential.kind)));
    if (fixed.protocol !== "https:") throw new Error("WorkBuddy 上游地址不合法");
    config.url = fixed.toString();
    // Never follow a redirect away from the fixed origin.
    config.redirect = "error";
    // Fixed WorkBuddy origins must ignore configured CCR/proxy environment routing.
    config.dispatcher = getDirectDispatcher();
  }

  // Managed Gemini OAuth providers: the upstream is Code Assist, never a
  // config-supplied base_url, and the access token is the only credential.
  const geminiOauthManaged = isGeminiOauthRuntime(provider);
  let geminiOauthService: ReturnType<typeof getGeminiOauthAuthService>;
  if (geminiOauthManaged) {
    geminiOauthService = getGeminiOauthAuthService();
    if (!geminiOauthService) throw new Error("Gemini OAuth 服务未初始化");
    config.url = new URL(GEMINI_OAUTH_SSE_PATH, GEMINI_OAUTH_DATA_PLANE).toString();
    // Never follow a redirect away from the fixed origin.
    config.redirect = "error";
    config.dispatcher = getDirectDispatcher();
  }
  const url = config.url || new URL(provider.baseUrl);

  // Apply timeout from config
  if (!config.TIMEOUT) {
    const timeoutMs = fastify.configService.get<string | number>('API_TIMEOUT_MS');
    if (timeoutMs) {
      config.TIMEOUT = typeof timeoutMs === 'string' ? parseInt(timeoutMs, 10) : timeoutMs;
    }
  }

  // Handle authentication in passthrough mode
  if (bypass && typeof transformer.auth === "function") {
    const auth = await transformer.auth(requestBody, provider, workbuddyManaged ? { ...context, config } : context);
    if (auth.body) {
      requestBody = auth.body;
      let headers = config.headers || {};
      if (auth.config?.headers) {
        headers = {
          ...headers,
          ...auth.config.headers,
        };
        delete headers.host;
        delete auth.config.headers;
      }
      config = {
        ...config,
        ...auth.config,
        headers,
      };
    } else {
      requestBody = auth;
    }
  }

  // Send HTTP request
  // Prepare headers
  const requestHeaders: Record<string, string> = {
    Authorization: `Bearer ${provider.apiKey}`,
    ...(config?.headers || {}),
  };

  if (workbuddyManaged) {
    // A single credential snapshot supplies BOTH destination and auth, never config URL/key.
    for (const key of Object.keys(requestHeaders)) {
      if (["authorization", "x-api-key", "host", "x-user-id", "x-domain", "x-enterprise-id", "x-tenant-id"].includes(key.toLowerCase())) delete requestHeaders[key];
    }
    Object.assign(requestHeaders, credentialHeaders(config.workbuddyCredential));
  }
  if (geminiOauthManaged) {
    // The marker api_key must never reach Google, and a client-supplied
    // Authorization (bypass mode) must not survive either.
    for (const key of Object.keys(requestHeaders)) {
      if (["authorization", "x-api-key", "host", "proxy-authorization"].includes(key.toLowerCase())) delete requestHeaders[key];
    }
    requestHeaders.Authorization = `Bearer ${await geminiOauthService!.getAccessToken()}`;
  }
  stampUpstreamSessionId(requestHeaders, context?.req);

  for (const key in requestHeaders) {
    if (requestHeaders[key] === "undefined") {
      delete requestHeaders[key];
    } else if (
      ["authorization", "Authorization"].includes(key) &&
      requestHeaders[key]?.includes("undefined")
    ) {
      delete requestHeaders[key];
    }
  }

  // Debug: log outgoing request to provider
  if (!workbuddyManaged && !geminiOauthManaged && isDebugLogEnabled(fastify.configService)) {
    logProviderRequest(fastify.log, context.req.id, {
      url: String(url),
      headers: requestHeaders,
      body: requestBody,
    });
  }

  let response: Response;
  const dispatchUpstream = () => sendUnifiedRequest(
    url,
    requestBody,
    {
      ...config,
      headers: JSON.parse(JSON.stringify(requestHeaders)),
      httpsProxy: workbuddyManaged || geminiOauthManaged ? undefined : resolveProviderProxyUrl(fastify.configService, provider),
    },
    context,
    workbuddyManaged || geminiOauthManaged ? undefined : fastify.log
  );
  try {
    response = await dispatchUpstream();
  } catch (sendError: any) {
    // WorkBuddy's front door (APISIX) reads only the first EDGE_READS bytes of a request
    // whose sign-in it refuses, then resets the connection: a big Claude Code request on a
    // stale token fails as a bare ECONNRESET with no diagnostic (contract §14.3b). Probe the
    // billing API once with a tiny request to tell "sign-in expired" from a real network
    // fault; the original request is never re-sent.
    if (workbuddyManaged && exceedsWorkBuddyEdgeReads(requestBody)) {
      const reauth = sendError?.workbuddy !== true && !["AbortError", "TimeoutError"].includes(sendError?.name)
        ? await getWorkBuddyAuthService()?.diagnoseReset(config.workbuddyCredential) : null;
      if (reauth) throw reauth;
    }
    throw sendError;
  }

  // Managed Gemini OAuth: an expired access token surfaces as 401. Refresh once
  // and re-send exactly once — nothing has been committed to the client yet.
  // Only the forced-refresh resend is allowed; a second 401 is terminal so the
  // outer generic retry cannot produce a third upstream call.
  if (!response.ok && geminiOauthManaged && response.status === 401 && !(context.req as any)?.__geminiOauth401Retried) {
    (context.req as any).__geminiOauth401Retried = true;
    try {
      await geminiOauthService!.forceTokenRefresh?.();
      requestHeaders.Authorization = `Bearer ${await geminiOauthService!.getAccessToken()}`;
      response = await dispatchUpstream();
    } catch {
      // Refresh failed: fall through to classification of the original 401.
    }
    if (response.status === 401) (context.req as any).__retryAttempted = true;
  }

  // Handle request errors
  if (!response.ok) {
    const errorText = await response.text();
    // WorkBuddy managed providers: classify and redact the upstream body here,
    // BEFORE any log or client-facing error is built. A raw WorkBuddy envelope
    // must never reach the log stream, and a WorkBuddy access token must never
    // be recoverable from an error message.
    if (isWorkBuddyRuntime(provider)) {
      const wbError = classifyWorkBuddyError(response.status, errorText);
      fastify.log.error(
        `[provider_response_error] WorkBuddy provider(${provider.name},${requestBody.model}: ${response.status}) code=${(wbError as any).upstreamCode ?? "n/a"} kind=${wbError.code}`
      );
      (wbError as any).isRateLimit = wbError.code === "rate_limit";
      (wbError as any).workbuddy = true;
      (wbError as any).cooldownSeconds = (wbError as any).cooldownSeconds;
      throw wbError;
    }
    // Managed Gemini OAuth providers: classify HERE, before the generic branch
    // logs the raw body or hands it to a client-facing error.
    if (geminiOauthManaged) {
      let parsedError: any;
      try { parsedError = errorText ? JSON.parse(errorText) : undefined; } catch { parsedError = undefined; }
      const info = classifyGeminiOauthError({
        status: response.status,
        body: parsedError ?? errorText,
        systemText: JSON.stringify(requestBody ?? {}),
      });
      await geminiOauthService?.noteUpstreamError(info).catch(() => undefined);
      fastify.log.error(
        `[provider_response_error] Gemini OAuth provider(${provider.name},${requestBody.model}: ${response.status}) code=${info.code}`
      );
      const geminiError: any = geminiOauthError(info);
      geminiError.isRateLimit = info.code === "gemini_oauth_quota_exceeded";
      throw geminiError;
    }
    fastify.log.error(
      `[provider_response_error] Error from provider(${provider.name},${requestBody.model}: ${response.status}): ${errorText}`,
    );
    const error = createApiError(
      `Error from provider(${provider.name},${requestBody.model}: ${response.status}): ${errorText}`,
      response.status,
      "provider_response_error"
    );
    (error as any).isRateLimit = response.status === 429 || isRateLimitError(errorText);
    error.rawBody = errorText;
    throw error;
  }

  // Handle hidden errors in HTTP 200 OK responses (e.g. Zhipu rate limits, empty bodies)
  if (response.ok) {
    const contentType = response.headers.get("content-type") || "";
    const isStreamRequest = requestBody.stream === true;
    // DEBUG: log response metadata to diagnose why empty responses bypass checks
    fastify.log.info(
      `[hidden-error-check] provider=${provider.name} model=${requestBody.model} stream=${requestBody.stream} isStreamRequest=${isStreamRequest} contentType=${contentType} ok=${response.ok} status=${response.status} hasBody=${!!response.body}`
    );
    // For non-streaming requests, always validate the response body regardless
    // of content-type. Some providers return 200 with empty body or non-JSON
    // content-type (e.g. text/event-stream for non-streaming requests), which
    // would bypass the JSON-only hidden error check and forward garbage to the client.
    if (!isStreamRequest || contentType.includes("application/json")) {
      const cloned = response.clone();
      let bodyText = "";
      try {
        bodyText = await cloned.text();
        if (!bodyText || bodyText.trim() === "") {
          throw new SyntaxError("Empty JSON body");
        }
        // An SSE stream mislabeled as application/json (Codex relay) is not a
        // hidden error — JSON.parse below would throw SyntaxError and kill a
        // perfectly good streaming response. Let it flow: formatResponse's
        // peek reclassifies it as a stream downstream.
        if (looksLikeSSE(bodyText)) {
          fastify.log.info(
            `[hidden-error-check] body is SSE mislabeled as ${contentType}, skipping JSON validation`
          );
          return response;
        }
        const bodyJson = JSON.parse(bodyText);
        // Check if the response contains an error object
        if (workbuddyManaged && (Number(bodyJson?.code) > 0 || Number(bodyJson?.data?.code) > 0)) throw classifyWorkBuddyError(response.status, bodyJson);
        if (bodyJson && typeof bodyJson === 'object' && bodyJson.error) {
          // If error is null or explicitly empty, it might not be a real error
          const hasRealError =
            typeof bodyJson.error === 'string' ||
            (typeof bodyJson.error === 'object' && Object.keys(bodyJson.error).length > 0);

          if (hasRealError) {
            if (isWorkBuddyRuntime(provider)) {
              const wbError = classifyWorkBuddyError(response.status, bodyText);
              fastify.log.error(
                `[provider_response_error] WorkBuddy hidden error from provider(${provider.name},${requestBody.model}: ${response.status}) code=${(wbError as any).upstreamCode ?? "n/a"} kind=${wbError.code}`
              );
              (wbError as any).isRateLimit = wbError.code === "rate_limit";
              (wbError as any).workbuddy = true;
              throw wbError;
            }
            if (geminiOauthManaged) {
              const info = classifyGeminiOauthError({ status: response.status, body: bodyJson, systemText: JSON.stringify(requestBody ?? {}) });
              await geminiOauthService?.noteUpstreamError(info).catch(() => undefined);
              fastify.log.error(
                `[provider_response_error] Gemini OAuth hidden error from provider(${provider.name},${requestBody.model}: ${response.status}) code=${info.code}`
              );
              const geminiError: any = geminiOauthError(info);
              geminiError.isRateLimit = info.code === "gemini_oauth_quota_exceeded";
              throw geminiError;
            }
            fastify.log.error(
              `[provider_response_error] Hidden error from provider(${provider.name},${requestBody.model}: ${response.status}): ${bodyText}`,
            );
            // Classify as rate-limit when error text contains relevant keywords
            const isRateLimit = isRateLimitError(bodyText);
            const error = createApiError(
              `Error from provider(${provider.name},${requestBody.model}: ${response.status}): ${bodyText}`,
              // Promote to 400 to trigger fallback and correct usage logging
              400,
              "provider_response_error"
            );
            (error as any).isRateLimit = isRateLimit;
            error.rawBody = bodyText;
            throw error;
          }
        }
      } catch (e) {
        // Empty or malformed JSON body on HTTP 200 — the provider returned an
        // invalid response. Throw to trigger fallback instead of forwarding
        // the empty response to the client, which would cause a different error.
        if (e instanceof SyntaxError) {
          if (workbuddyManaged) throw classifyWorkBuddyError(response.status, {});
          fastify.log.warn(
            `[provider_response_error] Empty or malformed JSON response from provider(${provider.name},${requestBody.model}: 200): "${bodyText}"`
          );
          const error = createApiError(
            `API returned an empty or malformed response (HTTP 200) from ${provider.name} — check for a proxy or gateway intercepting the request`,
            400,
            "provider_response_error"
          );
          error.rawBody = bodyText;
          throw error;
        }
        // For non-SyntaxError exceptions (e.g. network issues reading cloned body),
        // re-throw so they propagate and trigger fallback too.
        throw e;
      }
    }
  }

  // Debug: log non-stream response from provider
  if (!workbuddyManaged && !requestBody.stream && isDebugLogEnabled(fastify.configService)) {
    const cloned = response.clone();
    const bodyText = await cloned.text();
    logProviderResponse(fastify.log, context.req.id, {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: bodyText,
    });
  }

  return response;
}

/**
 * Process response transformer chain
 * Sequentially execute provider transformers, model-specific transformers, transformer's transformResponseIn
 */
async function processResponseTransformers(
  requestBody: any,
  response: any,
  provider: any,
  transformer: any,
  bypass: boolean,
  context: any
) {
  let finalResponse = response;

  // Execute provider-level response transformers
  if (!bypass && provider.transformer?.use?.length) {
    for (const providerTransformer of Array.from(
      provider.transformer.use
    ).reverse() as Transformer[]) {
      if (
        !providerTransformer ||
        typeof providerTransformer.transformResponseOut !== "function"
      ) {
        continue;
      }
      finalResponse = await providerTransformer.transformResponseOut!(
        finalResponse,
        context
      );
    }
  }

  // Execute model-specific response transformers
  if (!bypass && provider.transformer?.[requestBody.model]?.use?.length) {
    for (const modelTransformer of Array.from(
      provider.transformer[requestBody.model].use
    ).reverse() as Transformer[]) {
      if (
        !modelTransformer ||
        typeof modelTransformer.transformResponseOut !== "function"
      ) {
        continue;
      }
      finalResponse = await modelTransformer.transformResponseOut!(
        finalResponse,
        context
      );
    }
  }

  // Execute transformer's transformResponseIn method
  if (!bypass && transformer.transformResponseIn) {
    // Expose provider to transformer so it can read cacheMode for usage translation
    if (!context.provider) context.provider = provider;
    finalResponse = await transformer.transformResponseIn(
      finalResponse,
      context
    );
  }

  // When a codex client sends requests to /v1/messages (instead of /v1/responses),
  // the response is in Anthropic SSE format which codex cannot parse. Apply the
  // Responses API conversion so codex can display the response correctly.
  if (context?.isCodexOnMessagesEndpoint) {
    try {
      const responsesTransformer = new OpenAIResponsesTransformer();
      finalResponse = await responsesTransformer.transformResponseIn(
        finalResponse,
        { ...context, provider }
      );
    } catch (e) {
      // If the conversion fails, fall through and return the original response
      console.error("Failed to apply Responses API conversion for codex client:", e);
    }
  }

  return finalResponse;
}

/**
 * Format and return response
 * Handle HTTP status codes, format streaming and regular responses
 */
async function formatResponse(response: any, reply: FastifyReply, _body: any, fastify?: FastifyInstance) {
  // Set HTTP status code
  if (!response.ok) {
    reply.code(response.status);
  }

  // Decide streaming from the upstream response's Content-Type, not the
  // request body: some providers answer a stream:true request with a JSON
  // error body, or answer a non-stream request with an SSE payload (e.g.
  // OpenRouter error responses starting with ": OPENROUTER PROCESSING").
  let isStream = isEventStreamResponse(response);

  // Bypass-mode providers skip the transformer chain entirely, so a body that
  // is actually SSE but mislabeled (Codex relay labels it application/json, and
  // some relays return a non-standard Content-Type like text/plain or an empty
  // one with an SSE body) reaches this point uncorrected and would fail JSON
  // parse below. Peek the first meaningful content for ANY non-stream
  // response: when it looks like SSE, stream it through instead. Restricting
  // the peek to application/json left non-standard Content-Types hitting the
  // JSON parse path and throwing "non-JSON response" on a healthy SSE body.
  // The peek accumulates across chunks because the first event may be split,
  // or preceded by an empty buffer / SSE heartbeat (": ping") before the real
  // "event:"/"data:" line — a single read would miss it and misclassify the
  // body as JSON.
  if (!isStream) {
    const peeked = await peekBodyForSSE(response);
    if (peeked) {
      if (peeked.isSSE) {
        isStream = true;
      }
      response = new Response(peeked.body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } else {
      // Body absent or already locked (e.g. consumed by an earlier reader),
      // so tee-based peek is impossible. Drain the full body as text and
      // reclassify: an SSE stream mislabeled as JSON still shows up here when
      // the body was null/locked when peekBodyForSSE ran. Wrap it as a stream
      // when it is SSE, otherwise leave it for JSON parsing below.
      const drained = await readBodyForSSE(response);
      response = drained.response;
      if (drained.isSSE) {
        isStream = true;
      }
    }
  }

  if (isStream) {
    reply.header("Content-Type", "text/event-stream");
    reply.header("Cache-Control", "no-cache");
    reply.header("Connection", "keep-alive");

    // Debug: tee stream to log SSE chunks
    if (fastify && isDebugLogEnabled(fastify.configService)) {
      const [debugStream, clientStream] = response.body.tee();
      const options = getDebugLogOptions(fastify.configService);
      readStreamForDebug(debugStream, fastify.log, reply.request.id, options);
      return reply.send(clientStream);
    }

    return reply.send(response.body);
  } else {
    // Handle regular JSON response. Parse leniently so a non-JSON upstream
    // body surfaces as a descriptive error instead of a raw SyntaxError.
    return parseResponseJson(response);
  }
}

export const registerApiRoutes = async (
  fastify: FastifyInstance
) => {
  // Health and info endpoints
  fastify.get("/", async () => {
    return { message: "LLMs API", version };
  });

  fastify.get("/health", async () => {
    return { status: "ok", timestamp: new Date().toISOString() };
  });

  // Provider health status endpoint
  fastify.get("/providers/health", async () => {
    const healthStore = getHealthStore();
    const states = healthStore.getAllStates();
    return {
      states: states.map(s => ({
        provider: s.provider,
        model: s.model,
        status: s.status,
        failureCount: s.failureCount,
        successCount: s.successCount,
        lastFailureTime: s.lastFailureTime,
        lastError: s.lastError,
        rateLimitUntil: s.rateLimitUntil ?? null,
      })),
      timestamp: new Date().toISOString(),
    };
  });

  const transformersWithEndpoint =
    fastify.transformerService.getTransformersWithEndpoint();

  for (const { transformer } of transformersWithEndpoint) {
    if (transformer.endPoint) {
      fastify.post(
        transformer.endPoint,
        async (req: FastifyRequest, reply: FastifyReply) => {
          return handleTransformerEndpoint(req, reply, fastify, transformer);
        }
      );
    }
  }

  fastify.post(
    "/providers",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            type: { type: "string", enum: ["openai", "anthropic"] },
            baseUrl: { type: "string" },
            apiKey: { type: "string" },
            models: { type: "array", items: { type: "string" } },
            proxyEnabled: { type: "boolean" },
          },
          required: ["id", "name", "type", "baseUrl", "apiKey", "models"],
        },
      },
    },
    async (
      request: FastifyRequest<{ Body: RegisterProviderRequest }>,
      reply: FastifyReply
    ) => {
      // Validation
      const { name, baseUrl, apiKey, models } = request.body;

      if (!name?.trim()) {
        throw createApiError(
          "Provider name is required",
          400,
          "invalid_request"
        );
      }

      if (!baseUrl || !isValidUrl(baseUrl)) {
        throw createApiError(
          "Valid base URL is required",
          400,
          "invalid_request"
        );
      }

      if (!apiKey?.trim()) {
        throw createApiError("API key is required", 400, "invalid_request");
      }

      if (!models || !Array.isArray(models) || models.length === 0) {
        throw createApiError(
          "At least one model is required",
          400,
          "invalid_request"
        );
      }

      // Check if provider already exists
      if (fastify.providerService.getProvider(request.body.name)) {
        throw createApiError(
          `Provider with name '${request.body.name}' already exists`,
          400,
          "provider_exists"
        );
      }

      return fastify.providerService.registerProvider(request.body);
    }
  );

  fastify.get("/providers", async () => {
    return fastify.providerService.getProviders();
  });

  fastify.get(
    "/providers/:id",
    {
      schema: {
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
    },
    async (request: FastifyRequest<{ Params: { id: string } }>) => {
      const provider = fastify.providerService.getProvider(
        request.params.id
      );
      if (!provider) {
        throw createApiError("Provider not found", 404, "provider_not_found");
      }
      return provider;
    }
  );

  fastify.put(
    "/providers/:id",
    {
      schema: {
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
        body: {
          type: "object",
          properties: {
            name: { type: "string" },
            type: { type: "string", enum: ["openai", "anthropic"] },
            baseUrl: { type: "string" },
            apiKey: { type: "string" },
            models: { type: "array", items: { type: "string" } },
            proxyEnabled: { type: "boolean" },
            enabled: { type: "boolean" },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: Partial<LLMProvider>;
      }>,
      reply
    ) => {
      const provider = fastify.providerService.updateProvider(
        request.params.id,
        request.body
      );
      if (!provider) {
        throw createApiError("Provider not found", 404, "provider_not_found");
      }
      return provider;
    }
  );

  fastify.delete(
    "/providers/:id",
    {
      schema: {
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
    },
    async (request: FastifyRequest<{ Params: { id: string } }>) => {
      const success = fastify.providerService.deleteProvider(
        request.params.id
      );
      if (!success) {
        throw createApiError("Provider not found", 404, "provider_not_found");
      }
      return { message: "Provider deleted successfully" };
    }
  );

  fastify.patch(
    "/providers/:id/toggle",
    {
      schema: {
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
        body: {
          type: "object",
          properties: { enabled: { type: "boolean" } },
          required: ["enabled"],
        },
      },
    },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: { enabled: boolean };
      }>,
      reply
    ) => {
      const success = fastify.providerService.toggleProvider(
        request.params.id,
        request.body.enabled
      );
      if (!success) {
        throw createApiError("Provider not found", 404, "provider_not_found");
      }
      return {
        message: `Provider ${
          request.body.enabled ? "enabled" : "disabled"
        } successfully`,
      };
    }
  );
};

/**
 * Check if an error message or response body indicates a rate-limit error.
 * Matches common patterns across providers (OpenAI, GLM/Zhipu, Anthropic, etc.).
 */
function isRateLimitError(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes('rate limit') ||
    lower.includes('rate_limit') ||
    lower.includes('rate_limit_error') ||
    lower.includes('too many requests') ||
    lower.includes('too many') ||
    lower.includes('quota exhausted') ||
    lower.includes('qps_limit') ||
    lower.includes('token_limit') ||
    lower.includes('限流') ||
    lower.includes('频率限制')
  );
}

// Helper function
function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}
