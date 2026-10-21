/**
 * Gemini OAuth (Antigravity) transformer — the Code Assist data plane.
 *
 * Deliberately NOT setting `endPoint` (same reason as workbuddy.transformer.ts:
 * registering a second route would conflict; the quirk layer rides the normal
 * pipeline via provider.transformer.use).
 *
 * Request side (contract §1.1):
 *  - `buildRequestBody` (utils/gemini.util.ts) makes the Gemini-native inner
 *    body; antigravity quirks are applied on it; the whole thing is wrapped in
 *    the Code Assist envelope {model, project, request, userAgent, requestType,
 *    requestId} with a stable per-conversation sessionId.
 *  - Returns config {url, headers}: the fixed data-plane SSE URL plus
 *    Authorization (live Bearer token) and the antigravity User-Agent. routes.ts
 *    writes the default `Authorization: Bearer provider.apiKey` first and
 *    spreads config.headers after (routes.ts:1313-1319), so ours wins and the
 *    marker api_key never reaches the upstream.
 *
 * Response side (contract §1.2):
 *  - Code Assist is stream-only; SSE frames are `{"response":<gemini chunk>}` or
 *    `{"error":{"message"}}`. We unwrap the envelope and hand the plain Gemini
 *    SSE stream to the EXISTING gemini.util response chain (only the envelope
 *    peeling is new); a non-stream client gets one aggregated chat.completion.
 *  - Error frames are classified by the shared contract §1.6 taxonomy; the
 *    classification is reported to the credential service (cooldown/lastError)
 *    and thrown so fallback engages (or surfaces on the stream, mid-stream).
 */
import { UnifiedChatRequest } from "@/types/llm";
import { Transformer, TransformerContext } from "@/types/transformer";
import {
  buildRequestBody,
  transformResponseOut as geminiTransformResponseOut,
} from "@/utils/gemini.util";
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
  type GeminiOauthAuthServiceLike,
  type GeminiOauthErrorInfo,
} from "@/services/gemini-oauth";

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

export class GeminiOauthTransformer implements Transformer {
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
    request: UnifiedChatRequest,
    provider: any,
    context?: TransformerContext
  ): Promise<Record<string, any>> {
    const service = this.resolveAuthService();
    const [token, project] = await Promise.all([service.getAccessToken(), service.getProject()]);

    const geminiBody = buildRequestBody(request);
    applyAntigravityQuirks(geminiBody, request.model, (request as any)?.max_tokens);
    const envelope = buildCodeAssistEnvelope({ geminiBody, model: request.model, project });

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
        },
      },
    };
  }

  async transformResponseOut(response: Response, context?: TransformerContext): Promise<Response> {
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

    if (!contentType.includes("stream") || !response.body) return response;

    // The pump is created once; the peek phase and the streaming/aggregate
    // phase share the same reader.
    const pump = createPayloadPump(response.body as ReadableStream<Uint8Array>);
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
      // through the EXISTING gemini.util conversion chain.
      return geminiTransformResponseOut(unwrapped, this.name, this.logger);
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
