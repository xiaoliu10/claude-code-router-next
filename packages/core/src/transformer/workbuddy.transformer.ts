/**
 * WorkBuddy (CN) transformer — Unified → OpenAI Chat Completions quirk layer.
 *
 * Protocol source: magpie-community/plugins@ab38da681af7716ea9a7609f045ca91d2ad9988a
 * packages/workbuddy/index.mjs (MIT); see ../../THIRD_PARTY_NOTICES.md.
 *
 * Deliberately NOT setting `endPoint`: registering a second
 * /v1/chat/completions route would conflict with the existing OpenAI
 * transformer. Instead the WorkBuddy quirk layer rides the normal pipeline:
 *  - `auth()` injects the fixed upstream URL + WorkBuddy headers and overrides
 *    the default `Authorization: Bearer provider.apiKey` (routes.ts writes the
 *    default first and spreads auth.config.headers after, so ours wins).
 *    The marker api_key never reaches the upstream.
 *  - `transformRequestIn` applies the body quirks (max_completion_tokens,
 *    developer→system, default system, tool_choice normalization, safe tool
 *    names) for the non-bypass path (Anthropic `system` array forces the full
 *    chain, so both paths stay correct).
 *  - `transformResponseOut` restores the client's original tool names in JSON
 *    and SSE bodies, and flags upstream SSE errors instead of dropping them.
 */
import { UnifiedChatRequest } from "@/types/llm";
import { Transformer, TransformerContext } from "@/types/transformer";
import { peekBodyForSSE, readBodyForSSE } from "./response-body";
import type { WorkBuddyAuthService } from "@/services/workbuddy-auth";
import { workBuddyChatUrl, workBuddySite, credentialHeaders } from "@/services/workbuddy";
import { classifyWorkBuddyError, conversationHeaders, getWorkBuddyAuthService } from "@/services/workbuddy";

const NAME_OK = /^[A-Za-z0-9_-]+$/;
/** Max body size we are willing to rewrite in memory. */
const MAX_REWRITE_BYTES = 8 * 1024 * 1024;

/** Reverse lookup: the safe name the request body was rewritten to. */
function safeNameFor(names: Map<string, string>, original: string): string | undefined {
  for (const [safe, client] of names) {
    if (client === original) return safe;
  }
  return undefined;
}

function safeToolName(name: unknown, taken: Set<string>): string {
  const base = (typeof name === "string" ? name.replace(/[^A-Za-z0-9_-]/g, "_") : "") || "tool";
  let candidate = base;
  for (let i = 2; taken.has(candidate); i++) candidate = `${base}_${i}`;
  taken.add(candidate);
  return candidate;
}

export class WorkBuddyTransformer implements Transformer {
  static TransformerName = "workbuddy";
  name = "workbuddy";
  logger?: any;

  constructor(
    private readonly options?: {
      /** Injected in tests; the runtime resolves the shared service lazily. */
      authService?: WorkBuddyAuthService;
      getAuthService?: () => WorkBuddyAuthService | undefined;
    }
  ) {}

  private resolveAuthService(): WorkBuddyAuthService {
    const injected = this.options?.authService ?? this.options?.getAuthService?.() ?? getWorkBuddyAuthService();
    if (!injected) throw new Error("WorkBuddy 认证服务未初始化");
    return injected;
  }

  /**
   * Bypass-path hook (and non-bypass fallback): inject the fixed upstream URL,
   * WorkBuddy headers and the real access token. routes.ts merges
   * `{ Authorization: Bearer provider.apiKey, ...config.headers }`, so the
   * Authorization written here overrides the marker api_key.
   */
  async auth(request: any, provider: any): Promise<any> {
    const service = this.resolveAuthService();
    const credential = await service.currentCredential();
    const url = new URL(workBuddyChatUrl(workBuddySite(credential?.kind ?? "workbuddy")));
    if (url.protocol !== "https:") throw new Error("WorkBuddy 上游地址不合法");
    if (!credential) throw new Error("WorkBuddy 未导入登录态，请先在管理页导入");
    const headers = { ...credentialHeaders(credential), ...conversationHeaders(request) };
    return {
      body: request,
      config: {
        url: url.toString(),
        headers,
      },
    };
  }

  async transformRequestIn(
    request: UnifiedChatRequest,
    provider: any,
    context: TransformerContext
  ): Promise<any> {
    const body: any = JSON.parse(JSON.stringify(request));

    // Contract §13 Q1: the WorkBuddy upstream is only guaranteed to speak SSE
    // (protocol source: "Non-stream chat request is currently not supported").
    // Always request a stream upstream and remember what the CLIENT asked for,
    // so transformResponseOut can aggregate back into one JSON completion for
    // non-stream clients instead of leaking raw SSE to them. The client's
    // original flag lives on req.body (normalized to a boolean by the server
    // preHandler); fall back to the unified body for direct/unit-test calls.
    if (context) {
      const rawClientStream = context.req?.body?.stream;
      context.workbuddyClientStream =
        rawClientStream !== undefined ? !!rawClientStream : !!(request as any)?.stream;
      context.workbuddyUpstreamStream = true; // set unconditionally: body.stream is forced to true below
    }
    body.stream = true;

    // max_completion_tokens → max_tokens (existing max_tokens wins), field dropped.
    if (body.max_completion_tokens !== undefined) {
      if (body.max_tokens === undefined) body.max_tokens = body.max_completion_tokens;
      delete body.max_completion_tokens;
    }
    // developer → system
    for (const message of Array.isArray(body.messages) ? body.messages : []) {
      if (message?.role === "developer") message.role = "system";
    }
    // Ensure a leading system message.
    if (Array.isArray(body.messages) && body.messages.length && body.messages[0]?.role !== "system") {
      body.messages.unshift({ role: "system", content: "You are a helpful assistant." });
    }
    // Tool names first (the upstream plugin normalizes tool_choice after
    // renaming, so a named choice must reference the safe name).
    const names = new Map<string, string>();
    const taken = new Set<string>((Array.isArray(body.tools) ? body.tools : []).map((tool: any) => tool?.function?.name).filter((name: any) => typeof name === "string" && NAME_OK.test(name)));
    for (const tool of Array.isArray(body.tools) ? body.tools : []) {
      const original = tool?.function?.name;
      if (typeof original !== "string") continue;
      const safe = NAME_OK.test(original) ? original : safeToolName(original, taken);
      if (safe !== original) {
        names.set(safe, original);
        tool.function.name = safe;
      }
    }
    if (names.size && context) context.workbuddyToolNames = names;
    // Tool calls in history must use the same renamed identifiers as declarations.
    for (const message of Array.isArray(body.messages) ? body.messages : []) {
      for (const call of Array.isArray(message?.tool_calls) ? message.tool_calls : []) {
        if (call?.function?.name) call.function.name = safeNameFor(names, call.function.name) ?? call.function.name;
      }
    }

    // tool_choice normalization
    if ("tool_choice" in body) {
      const choice: any = body.tool_choice;
      if (typeof choice === "string") {
        if (choice.trim().toLowerCase() === "none") {
          delete body.tool_choice;
          delete body.tools;
          delete body.functions;
        }
      } else if (!choice || typeof choice !== "object" || Array.isArray(choice)) {
        delete body.tool_choice;
      } else {
        const type = typeof choice.type === "string" ? choice.type.trim().toLowerCase() : "";
        if (type === "none") {
          delete body.tool_choice;
          delete body.tools;
          delete body.functions;
        } else if (type === "auto" || type === "required") {
          body.tool_choice = type;
        } else if (type === "function") {
          const fn = choice.function && typeof choice.function === "object" && !Array.isArray(choice.function) ? choice.function : undefined;
          const raw = typeof fn?.name === "string" ? fn.name.trim() : "";
          // A named choice must reference the renamed tool, not the client name.
          const safe = raw ? (safeNameFor(names, raw) ?? raw) : "";
          body.tool_choice = safe || "auto";
        } else {
          delete body.tool_choice;
        }
      }
    }
    // reasoning_effort is forwarded as-is; no silent downgrade, no guessing.

    // Inject the WorkBuddy auth headers here as well as in auth(): the
    // WorkBuddy transformer is NOT the endpoint transformer for
    // /v1/chat/completions (that stays OpenAI), so the bypass path that calls
    // auth() never runs for this provider. routes.ts merges the returned
    // config.headers after the default Authorization, so the real token wins
    // and the marker api_key never reaches the upstream.
    const credential = await this.resolveAuthService().currentCredential();
    if (!credential) throw new Error("WorkBuddy 未导入登录态，请先在管理页导入");
    const headers = { ...credentialHeaders(credential), ...conversationHeaders(body) };
    return { body, config: { headers, url: workBuddyChatUrl(workBuddySite(credential.kind)), workbuddyCredential: credential } };
  }

  async transformResponseOut(response: Response, context?: TransformerContext): Promise<Response> {
    const names: Map<string, string> | undefined = context?.workbuddyToolNames;
    const contentType = response.headers.get("Content-Type") ?? "";

    if (contentType.includes("application/json")) {
      if (!response.body) return response;
      const peeked = await peekBodyForSSE(response);
      if (peeked) {
        const headers = new Headers(response.headers);
        if (peeked.isSSE) headers.set("Content-Type", "text/event-stream");
        response = new Response(peeked.body, { status: response.status, statusText: response.statusText, headers });
        if (peeked.isSSE) return this.dispatchSSE(response, names, context);
      } else {
        const drained = await readBodyForSSE(response);
        response = drained.response;
        if (drained.isSSE) return this.dispatchSSE(response, names, context);
      }
      // Read the body as text and always hand back a FRESH response: the
      // original body is consumed here, and routes.ts / the endpoint converter
      // still need to read it downstream ("Body has already been read").
      const text = await response.text();
      const json = this.parseOrNull(text);
      if (json !== null && this.restoreNames(json, names)) {
        const headers = new Headers(response.headers);
        headers.delete("content-length");
        return new Response(JSON.stringify(json), { status: response.status, statusText: response.statusText, headers });
      }
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      return new Response(text, { status: response.status, statusText: response.statusText, headers });
    }

    if (contentType.includes("stream") || contentType.includes("event-stream")) {
      if (!response.body) return response;
      return this.dispatchSSE(response, names, context);
    }
    return response;
  }

  /**
   * Route an SSE upstream response by what the CLIENT asked for: a stream
   * client gets the tool-name-restored stream; a non-stream client gets one
   * aggregated chat.completion JSON body (contract §13 Q1 — raw SSE must never
   * leak to a non-stream client). Absent the request-phase flag (direct unit
   * calls without transformRequestIn) the stream passes through unchanged.
   */
  private async dispatchSSE(
    response: Response,
    names: Map<string, string> | undefined,
    context?: TransformerContext
  ): Promise<Response> {
    // Only aggregate when the request phase recorded BOTH facts: the client
    // asked for non-stream AND the upstream request was actually forced to
    // stream. A hand-built context (unit tests, or any future caller that skips
    // transformRequestIn) must keep the existing stream passthrough rather than
    // silently collapsing a real stream into one buffered JSON body.
    const clientWantsJson =
      context?.workbuddyClientStream === false && context?.workbuddyUpstreamStream === true;
    if (!clientWantsJson) return this.rewriteStream(response, names);
    const aggregated = await this.aggregateSSE(response, names);
    return new Response(JSON.stringify(aggregated), {
      status: response.status,
      statusText: response.statusText,
      headers: { "Content-Type": "application/json" },
    });
  }

  /**
   * Aggregate an OpenAI-style SSE stream into a single chat.completion body:
   * content/reasoning fragments are joined, tool_call fragments re-assembled
   * by index, the last usage object wins, and an upstream error chunk (or a
   * data-less stream) becomes a classified error so fallback engages instead
   * of the client receiving a truncated/empty completion.
   */
  private async aggregateSSE(response: Response, names?: Map<string, string>): Promise<any> {
    if (!response.body) throw classifyWorkBuddyError(200, {});
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "", bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_REWRITE_BYTES) {
          await reader.cancel();
          // Distinct upstream-size class (not a client 400): operators must be able
          // to tell "response too large to aggregate" from a bad request.
          const tooLarge = classifyWorkBuddyError(502, {});
          tooLarge.message = "WorkBuddy 上游响应超过聚合上限（8 MiB），非流式请求已中止；请改用流式输出";
          throw tooLarge;
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally { reader.releaseLock(); }
    let id: string | undefined;
    let created: number | undefined;
    let model: string | undefined;
    let finishReason: string | null = null;
    let usage: any;
    let sawData = false;
    let errorChunk: any = null;
    const content: string[] = [];
    const reasoning: string[] = [];
    const toolCalls = new Map<number, any>();

    for (const line of text.split(/\r\n|\r|\n/)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      const chunk = this.parseOrNull(payload);
      if (chunk === null) continue;
      sawData = true;
      if (chunk.error || (Number(chunk.code) > 0 && Number.isSafeInteger(Number(chunk.code)))) { errorChunk = chunk; continue; }
      if (chunk.id) id = chunk.id;
      if (chunk.created) created = chunk.created;
      if (chunk.model) model = chunk.model;
      if (chunk.usage) usage = chunk.usage;
      const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta ?? {};
      if (typeof delta.content === "string") content.push(delta.content);
      if (typeof delta.reasoning_content === "string") reasoning.push(delta.reasoning_content);
      for (const tc of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        const idx = typeof tc?.index === "number" ? tc.index : 0;
        let acc = toolCalls.get(idx);
        if (!acc) {
          acc = { type: "function", function: { arguments: "" } };
          toolCalls.set(idx, acc);
        }
        if (tc?.id) acc.id = tc.id;
        if (tc?.type) acc.type = tc.type;
        if (typeof tc?.function?.name === "string") acc.function.name = (acc.function.name ?? "") + tc.function.name;
        if (typeof tc?.function?.arguments === "string") acc.function.arguments += tc.function.arguments;
      }
    }

    if (errorChunk || finishReason === "error") {
      throw classifyWorkBuddyError(response.status, JSON.stringify(errorChunk ?? { msg: "workbuddy stream error" }));
    }
    if (!sawData) {
      // Mirror validateStreamingResponse's empty-stream protection: a data-less
      // upstream must trigger fallback, not a silent empty completion.
      throw classifyWorkBuddyError(response.status, JSON.stringify({ msg: "empty workbuddy stream" }));
    }

    const message: any = { role: "assistant", content: content.join("") };
    if (reasoning.length) message.reasoning_content = reasoning.join("");
    if (toolCalls.size) {
      message.tool_calls = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, tc]) => tc);
    }
    const completion: any = {
      id: id ?? `chatcmpl-workbuddy-${Date.now()}`,
      object: "chat.completion",
      created: created ?? Math.floor(Date.now() / 1000),
      model: model ?? "workbuddy",
      choices: [{ index: 0, message, finish_reason: finishReason ?? "stop" }],
    };
    if (usage) completion.usage = usage;
    this.restoreNames(completion, names);
    return completion;
  }

  private parseOrNull(text: string): any {
    try {
      return JSON.parse(text.replace(/^\uFEFF/, "").trim());
    } catch {
      return null;
    }
  }

  /** Restore the client's original tool names in one parsed chunk. */
  private restoreNames(data: any, names?: Map<string, string>): boolean {
    if (!names?.size || !Array.isArray(data?.choices)) return false;
    let changed = false;
    for (const choice of data.choices) {
      for (const holder of [choice?.message, choice?.delta]) {
        for (const call of Array.isArray(holder?.tool_calls) ? holder.tool_calls : []) {
          const original = names.get(call?.function?.name);
          if (original) {
            call.function.name = original;
            changed = true;
          }
        }
      }
    }
    return changed;
  }

  /**
   * SSE rewrite that preserves every boundary: CRLF/CR/LF, comment lines,
   * [DONE], usage-only chunks and malformed lines pass through verbatim.
   * `finish_reason: "error"` is detected and logged (never swallowed).
   */
  private rewriteStream(response: Response, names?: Map<string, string>): Response {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = "";

    const rewriteLine = (line: string): string => {
      if (!line.startsWith("data:")) return line;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") return line;
      let data: any;
      try {
        data = JSON.parse(payload);
      } catch {
        return line; // malformed JSON — preserve verbatim
      }
      if (data?.error || (Number(data?.code) > 0 && Number.isSafeInteger(Number(data?.code)))) {
        const error = classifyWorkBuddyError(200, data);
        return "data: " + JSON.stringify({ error: { code: error.code, message: error.message } });
      }
      for (const choice of Array.isArray(data?.choices) ? data.choices : []) {
        if (choice?.finish_reason === "error") {
          this.logger?.warn?.({ model: data?.model }, "[workbuddy_sse_error] upstream reported finish_reason=error");
        }
      }
      return this.restoreNames(data, names) ? `data: ${JSON.stringify(data)}` : line;
    };

    const drain = (controller: TransformStreamDefaultController<Uint8Array>, final = false) => {
      const endings = /\r\n|\r|\n/g;
      let start = 0;
      let output = "";
      let match: RegExpExecArray | null;
      while ((match = endings.exec(buffer)) !== null) {
        if (!final && match[0] === "\r" && endings.lastIndex === buffer.length) break;
        output += rewriteLine(buffer.slice(start, match.index)) + match[0];
        start = endings.lastIndex;
      }
      buffer = buffer.slice(start);
      if (final) {
        output += rewriteLine(buffer);
        buffer = "";
      }
      if (output) controller.enqueue(encoder.encode(output));
    };

    const stream = response.body!.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          buffer += decoder.decode(chunk, { stream: true });
          if (buffer.length > MAX_REWRITE_BYTES) {
            // Pass through untouched beyond the rewrite budget.
            controller.enqueue(encoder.encode(buffer));
            buffer = "";
            return;
          }
          drain(controller);
        },
        flush(controller) {
          buffer += decoder.decode();
          drain(controller, true);
        },
      })
    );

    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return new Response(stream, { status: response.status, statusText: response.statusText, headers });
  }

  /** Classify an upstream error body for the data-plane path (redacted). */
  classifyError(status: number, body: any): Error {
    return classifyWorkBuddyError(status, body);
  }

  /** Conversation headers for a raw request body (used by tests and the hook). */
  conversation(body: any, session?: string): Record<string, string> {
    return conversationHeaders(body, session);
  }
}
