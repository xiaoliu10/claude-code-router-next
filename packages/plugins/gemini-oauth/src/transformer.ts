/**
 * Gemini OAuth (Antigravity) transformer — the Code Assist data plane.
 *
 * MOVED VERBATIM from the former core module
 * `packages/core/src/transformer/gemini-oauth.transformer.ts` when the
 * provider became the first provider plugin; only import paths were rewired
 * to the plugin-local protocol/format modules.
 *
 * Deliberately NOT setting `endPoint` (same reason as workbuddy.transformer.ts:
 * registering a second route would conflict; the quirk layer rides the normal
 * pipeline via provider.transformer.use).
 *
 * Request side (contract §1.1):
 *  - `buildRequestBody` (gemini-format.ts, vendored from core's gemini.util)
 *    makes the Gemini-native inner body; antigravity quirks are applied on it;
 *    the whole thing is wrapped in the Code Assist envelope {model, project,
 *    request, userAgent, requestType, requestId} with a stable
 *    per-conversation sessionId.
 *  - Returns config {url, headers}: the fixed data-plane SSE URL plus
 *    Authorization (live Bearer token) and the antigravity User-Agent. The
 *    core writes the default `Authorization: Bearer provider.apiKey` first and
 *    spreads config.headers after, and the plugin runtime's signRequest strips
 *    and re-injects the live token last — the marker api_key never reaches the
 *    upstream.
 *
 * Response side (contract §1.2):
 *  - Code Assist is stream-only; SSE frames are `{"response":<gemini chunk>}` or
 *    `{"error":{"message"}}`. We unwrap the envelope and hand the plain Gemini
 *    SSE stream to the EXISTING Gemini conversion chain (only the envelope
 *    peeling is new); a non-stream client gets one aggregated chat.completion.
 *  - Error frames are classified by the shared contract §1.6 taxonomy; the
 *    classification is reported to the credential service (cooldown/lastError)
 *    and thrown so fallback engages (or surfaces on the stream, mid-stream).
 */
import {
  buildRequestBody,
  transformResponseOut as geminiTransformResponseOut,
} from "./gemini-format";
import {
  GEMINI_OAUTH_DATA_PLANE,
  GEMINI_OAUTH_SSE_PATH,
  antigravityUserAgent,
  buildCodeAssistEnvelope,
  applyAntigravityQuirks,
  classifyGeminiOauthError,
  geminiOauthError,
  getGeminiOauthAuthService,
  normalizeChunkToolNames,
  unwrapCodeAssistFrame,
  isStickyGeminiOauthError,
  type GeminiOauthAuthServiceLike,
  type GeminiOauthErrorInfo,
} from "./protocol";
import type { PluginTransformer, PluginTransformerContext, PluginUnifiedChatRequest } from "./core-types";

/**
 * A single-reader payload pump over the upstream SSE body: yields the non-empty
 * payloads of every `data:` line, exactly once, in order. The reader is created
 * once and shared between the peek phase and the streaming/aggregate phase.
 */
function createPayloadPump(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const readPayload = async (): Promise<string | null> => {
    while (true) {
      const idx = buffer.indexOf("\n");
      if (idx >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.startsWith("data:")) {
          const payload = line.slice(5).trim();
          if (payload) return payload;
        }
        continue;
      }
      const { done, value } = await reader.read();
      if (done) {
        const rest = buffer + decoder.decode();
        buffer = "";
        if (rest.startsWith("data:")) {
          const payload = rest.slice(5).trim();
          return payload || null;
        }
        return null;
      }
      buffer += decoder.decode(value, { stream: true });
    }
  };
  const cancel = () => { reader.cancel().catch(() => {}); };
  return { readPayload, cancel };
}

/**
 * Bounded content-type recovery window. A mislabeled Code Assist reply (the
 * undici ProxyAgent path intermittently drops Content-Type on a 200 SSE body)
 * is recognized from its first bytes alone; 4 KiB always covers the first SSE
 * frame and every hidden-error JSON body the upstream emits.
 */
const GEMINI_OAUTH_CONTENT_TYPE_PEEK_BYTES = 4 * 1024;

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}

type SniffedShape = "sse" | "json" | "unknown";

/**
 * Classify the trimmed head prefix of a body whose Content-Type cannot be
 * trusted. SSE comment heartbeats (`: ping`) and event-first frames are still
 * SSE — both the Code Assist pump and the core's shared peek helper tolerate
 * them, so the sniff must not fall through to the raw-replay branch on them
 * (that is exactly the wrapped-frame passthrough this defence exists to stop).
 */
function sniffHeadPrefix(text: string): SniffedShape {
  const head = text.trimStart();
  if (!head) return "unknown";
  if (head.startsWith("data:") || head.startsWith("event:") || head.startsWith(":")) return "sse";
  if (head.startsWith("{") || head.startsWith("[")) return "json";
  return "unknown";
}

/**
 * Read at most `maxBytes` from `body` for content sniffing while preserving
 * every byte: the returned `replay` stream re-emits the buffered chunks first
 * and then keeps pumping the SAME underlying reader, so no byte is consumed
 * twice or lost. The peek itself never cancels the upstream. `stopWhen` lets
 * the caller classify incrementally and stop buffering the moment the shape
 * is decided — a streaming client must not wait for the whole peek window on
 * a slow upstream.
 */
async function peekBodyBytes(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  stopWhen?: (text: string) => boolean
): Promise<{ head: Uint8Array; replay: ReadableStream<Uint8Array> }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const buffered: Uint8Array[] = [];
  let total = 0;
  let text = "";
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered.push(value);
    total += value.length;
    text += decoder.decode(value, { stream: true });
    if (stopWhen?.(text)) break;
  }
  const head = concatChunks(buffered);
  const replay = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of buffered) controller.enqueue(chunk);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) { controller.close(); return; }
      controller.enqueue(value);
    },
    cancel() { reader.cancel().catch(() => {}); },
  });
  return { head, replay };
}

/** A fresh Response carrying `body` with one header overridden. */
function responseWithHeader(response: Response, body: BodyInit, name: string, value: string): Response {
  const headers = new Headers(response.headers);
  headers.set(name, value);
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

export class GeminiOauthTransformer implements PluginTransformer {
  static TransformerName = "gemini-oauth";
  name = "gemini-oauth";
  logger?: any;

  constructor(
    private readonly options?: {
      /** Injected in tests; the runtime resolves the shared service lazily. */
      authService?: GeminiOauthAuthServiceLike;
      getAuthService?: () => GeminiOauthAuthServiceLike | undefined;
    }
  ) {}

  private resolveAuthService(): GeminiOauthAuthServiceLike {
    const injected = this.options?.authService ?? this.options?.getAuthService?.() ?? getGeminiOauthAuthService();
    if (!injected) throw new Error("Gemini OAuth 认证服务未初始化");
    return injected;
  }

  private noteUpstreamError(info: GeminiOauthErrorInfo): void {
    try {
      const service = this.options?.authService ?? this.options?.getAuthService?.() ?? getGeminiOauthAuthService();
      void service?.noteUpstreamError?.(info);
    } catch {
      // Never let bookkeeping break the response path.
    }
  }

  /**
   * Clear non-sticky failure residue once the upstream produced real output:
   * a recovered account must not keep reporting its last quota/validation
   * marker while requests succeed. Fire-and-forget; bookkeeping never blocks
   * or breaks the response path.
   */
  private noteRequestSuccess(): void {
    try {
      const service = this.options?.authService ?? this.options?.getAuthService?.() ?? getGeminiOauthAuthService();
      void service?.noteRequestSuccess?.();
    } catch {
      // Never let bookkeeping break the response path.
    }
  }

  /** Stream error frames carry no HTTP status — classify by message text. */
  private classifyFrame(message: string): GeminiOauthErrorInfo {
    return classifyGeminiOauthError({ message });
  }

  private classifiedFrameError(message: string): Error {
    const info = this.classifyFrame(message);
    this.noteUpstreamError(info);
    return geminiOauthError(info);
  }

  async transformRequestIn(
    request: PluginUnifiedChatRequest,
    provider: any,
    context?: PluginTransformerContext
  ): Promise<Record<string, any>> {
    const service = this.resolveAuthService();
    // Check before refreshing credentials: the route's later send guard alone
    // cannot stop a token-endpoint request initiated by this transformer.
    if (await service.isAccountCooling?.()) {
      // A cooling account is parked for one of several reasons, and they demand
      // different user action: quota/validation clears on its own, an expired
      // login never does. Say which one instead of a blanket "try later",
      // which for a dead token is advice that cannot work.
      const status: any = await service.getStatus?.().catch(() => null);
      const reauth = isStickyGeminiOauthError(status?.lastError?.code);
      throw geminiOauthError({
        code: "gemini_oauth_account_cooling",
        message: reauth
          ? "Gemini OAuth 登录态已失效，请重新授权登录（等待无法恢复）。"
          : "Gemini OAuth 账号处于冷却期（配额/验证/风控拦截），请稍后再试或重新授权。",
        httpStatus: reauth ? 401 : 429,
        retryable: false,
      });
    }
    // The shared API-key Gemini builder flattens system messages into user
    // turns. Antigravity needs the original system instruction structurally
    // separate, both for its semantics and the system-only identity classifier.
    // Move text without rewriting it; never scan user turns for identity words.
    const systemText = request.messages
      .filter((message) => message.role === "system")
      .map((message) => typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content.filter((part) => part.type === "text").map((part: any) => part.text ?? "").join("\n")
          : "")
      .join("\n");
    const geminiBody = buildRequestBody({
      ...request,
      messages: request.messages.filter((message) => message.role !== "system"),
    });
    if (systemText) geminiBody.systemInstruction = { parts: [{ text: systemText }] };
    const [token, project] = await Promise.all([service.getAccessToken(), service.getProject()]);

    applyAntigravityQuirks(geminiBody, request.model, (request as any)?.max_tokens);
    // The provider's model list holds collapsed family ids (gemini-3.7-flash);
    // the wire wants a concrete variant (gemini-3.7-flash-high). resolveWireModel
    // maps family -> variant using the raw ids saved at sync time.
    let wireModel = request.model;
    try {
      wireModel = (await service.resolveWireModel?.(request.model, (request as any)?.reasoning_effort)) ?? request.model;
    } catch {
      // Fall back to the requested id rather than failing the request.
    }
    const envelope = buildCodeAssistEnvelope({ geminiBody, model: wireModel, project });

    // Remember what the CLIENT asked for so transformResponseOut can aggregate
    // the always-streaming upstream back into one JSON completion (contract §1.2).
    if (context) {
      const rawClientStream = context.req?.body?.stream;
      context.geminiOauthClientStream =
        rawClientStream !== undefined ? !!rawClientStream : !!(request as any)?.stream;
    }

    const url = new URL(GEMINI_OAUTH_SSE_PATH, GEMINI_OAUTH_DATA_PLANE);
    return {
      body: envelope,
      config: {
        url: url.toString(),
        headers: {
          Authorization: `Bearer ${token}`,
          "User-Agent": antigravityUserAgent(),
          // The token endpoint came back as stripped-header compressed garbage
          // through the subscription proxy tonight; ask every upstream lane for
          // an identity response so a broken exit node has nothing to mangle.
          "Accept-Encoding": "identity",
        },
      },
    };
  }

  async transformResponseOut(response: Response, context?: PluginTransformerContext): Promise<Response> {
    const contentType = response.headers.get("Content-Type") ?? "";

    // A 200 JSON body from Code Assist is a hidden error (or a stray envelope).
    if (contentType.includes("application/json") && response.body) {
      const text = await response.text();
      let json: any = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }
      if (json?.error) throw this.classifiedFrameError(json.error?.message ?? text);
      // Not an error: hand a fresh body back (the original is consumed).
      return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
    }

    if (contentType.includes("stream")) {
      if (!response.body) return response;
      return this.transformCodeAssistStream(response, response.body as ReadableStream<Uint8Array>, context);
    }

    // Unknown or missing Content-Type. The undici ProxyAgent path intermittently
    // strips Content-Type from a 200 SSE reply (production-confirmed): without a
    // sniff the wrapped Code Assist frames pass through untouched and the core's
    // empty-answer guard fails every non-stream request. Peek the first bytes
    // WITHOUT consuming them, then dispatch by what the body actually is.
    if (response.body) {
      const { head, replay } = await peekBodyBytes(
        response.body as ReadableStream<Uint8Array>,
        GEMINI_OAUTH_CONTENT_TYPE_PEEK_BYTES,
        (seen) => sniffHeadPrefix(seen) !== "unknown"
      );
      const shape = sniffHeadPrefix(new TextDecoder().decode(head));
      if (shape === "sse") {
        const replayResponse = responseWithHeader(response, replay, "Content-Type", "text/event-stream");
        return this.transformCodeAssistStream(replayResponse, replay, context);
      }
      if (shape === "json") {
        // The head only proves the shape: parse the COMPLETE replayed body so a
        // document larger than the peek window is still recognized.
        const jsonText = await new Response(replay).text();
        let json: any = null;
        try { json = jsonText ? JSON.parse(jsonText) : null; } catch { json = null; }
        if (json?.error) throw this.classifiedFrameError(json.error?.message ?? jsonText);
        const headers = new Headers(response.headers);
        headers.set("Content-Type", "application/json");
        return new Response(jsonText, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }
      // Neither SSE nor JSON: replay the exact original bytes with the original
      // headers (the peek buffered only; no byte is dropped or rewritten).
      return new Response(replay, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }
    return response;
  }

  /**
   * The Code Assist SSE lane, shared by the Content-Type branch and the
   * content-sniff fallback: unwrap the envelope and split by what the CLIENT
   * asked for (stream conversion or one aggregated completion).
   */
  private async transformCodeAssistStream(
    response: Response,
    body: ReadableStream<Uint8Array>,
    context?: PluginTransformerContext
  ): Promise<Response> {
    // The pump is created once; the peek phase and the streaming/aggregate
    // phase share the same reader.
    const pump = createPayloadPump(body);
    let firstPayload = await pump.readPayload();
    if (!firstPayload) {
      throw geminiOauthError(classifyGeminiOauthError({ message: "empty Code Assist stream" }));
    }
    const firstFrame = unwrapCodeAssistFrame(firstPayload);
    if (firstFrame.error) throw this.classifiedFrameError(firstFrame.error.message);

    const clientWantsStream = context ? context.geminiOauthClientStream !== false : true;
    if (clientWantsStream) {
      const unwrapped = this.replayUnwrapped(pump, firstPayload, response);
      // Only the envelope peeling is new: the plain Gemini SSE stream goes
      // through the EXISTING Gemini conversion chain.
      // Managed credentials/errors must not reach protocol-level debug logging.
      return geminiTransformResponseOut(unwrapped, this.name);
    }
    const unwrapped = this.replayUnwrapped(pump, firstPayload, response);
    return this.aggregateCompletion(unwrapped);
  }

  /** A fresh SSE response replaying the peeked first frame + the pumped rest. */
  private replayUnwrapped(
    pump: ReturnType<typeof createPayloadPump>,
    firstPayload: string,
    response: Response
  ): Response {
    const self = this;
    const encoder = new TextEncoder();
    const firstFrame = unwrapCodeAssistFrame(firstPayload);
    const firstChunk = normalizeChunkToolNames(firstFrame.response ?? {});
    // Note account recovery on the first frame that carries real output
    // (text or a function call; thinking-only frames do not count). Covers
    // both the streaming lane and the aggregate lane, which both read this
    // replayed stream.
    let successNoted = false;
    const noteSuccessOnce = (chunk: any) => {
      if (successNoted) return;
      const parts = chunk?.candidates?.[0]?.content?.parts;
      if (!Array.isArray(parts)) return;
      if (parts.some((part: any) => (part?.text && part?.thought !== true) || part?.functionCall)) {
        successNoted = true;
        self.noteRequestSuccess();
      }
    };
    noteSuccessOnce(firstChunk);
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(firstChunk)}\n\n`));
        try {
          while (true) {
            const payload = await pump.readPayload();
            if (payload === null) break;
            const frame = unwrapCodeAssistFrame(payload);
            if (frame.error) {
              const info = self.classifyFrame(frame.error.message);
              self.noteUpstreamError(info);
              controller.error(geminiOauthError(info));
              return;
            }
            if (frame.malformed) continue;
            const chunk = normalizeChunkToolNames(frame.response ?? {});
            noteSuccessOnce(chunk);
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          }
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
      cancel() {
        pump.cancel();
      },
    });
    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  /**
   * Aggregate an unwrapped Gemini SSE stream into one chat.completion JSON for
   * a non-stream client (Code Assist has no non-stream endpoint). An error
   * frame throws classified BEFORE the Response is returned, so fallback
   * engages.
   */
  private async aggregateCompletion(response: Response): Promise<Response> {
    const pump = createPayloadPump(response.body!);
    const text: string[] = [];
    const thinking: string[] = [];
    const toolCalls: any[] = [];
    let signature: string | undefined;
    let finishReason: string | null = null;
    let usage: any;
    let id = "";
    let model = "";

    while (true) {
      const payload = await pump.readPayload();
      if (payload === null) break;
      const frame = unwrapCodeAssistFrame(payload);
      if (frame.error) throw this.classifiedFrameError(frame.error.message);
      if (frame.malformed) continue;
      const chunk = normalizeChunkToolNames(frame.response ?? {});
      if (chunk?.responseId) id = chunk.responseId;
      if (chunk?.modelVersion) model = chunk.modelVersion;
      if (chunk?.usageMetadata) usage = chunk.usageMetadata;
      const candidate = (Array.isArray(chunk?.candidates) ? chunk.candidates : [])[0];
      const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
      for (const part of parts) {
        if (part?.thought === true && part.text) thinking.push(part.text);
        else if (part?.text) text.push(part.text);
        if (!signature && typeof part?.thoughtSignature === "string" && part.thoughtSignature) {
          signature = part.thoughtSignature;
        }
        if (part?.functionCall) {
          toolCalls.push({
            id: part.functionCall.id || `tool_${Math.random().toString(36).substring(2, 15)}`,
            type: "function",
            function: {
              name: part.functionCall.name,
              arguments: JSON.stringify(part.functionCall.args ?? {}),
            },
          });
        }
      }
      if (candidate?.finishReason) finishReason = String(candidate.finishReason).toLowerCase();
    }

    if (!id && !model && !text.length && !toolCalls.length && !thinking.length && !usage) {
      throw geminiOauthError(classifyGeminiOauthError({ message: "empty Code Assist stream" }));
    }

    const message: any = { content: text.join(""), role: "assistant" };
    if (toolCalls.length) message.tool_calls = toolCalls;
    if (signature) {
      message.thinking = { content: thinking.join("\n") || "(no content)", signature };
    }
    const completion = {
      id,
      choices: [
        {
          finish_reason: finishReason,
          index: 0,
          message,
        },
      ],
      created: parseInt(new Date().getTime() / 1000 + "", 10),
      model,
      object: "chat.completion",
      usage: {
        completion_tokens: usage?.candidatesTokenCount || 0,
        prompt_tokens: usage?.promptTokenCount || 0,
        prompt_tokens_details: { cached_tokens: usage?.cachedContentTokenCount || 0 },
        total_tokens: usage?.totalTokenCount || 0,
        output_tokens_details: { reasoning_tokens: usage?.thoughtsTokenCount || 0 },
      },
    };
    return new Response(JSON.stringify(completion), {
      status: response.status,
      statusText: response.statusText,
      headers: { "Content-Type": "application/json" },
    });
  }
}
