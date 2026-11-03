import { createGrokEngine, type GrokEngine } from "./vendor/engine.mjs";

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}
import { grokError } from "./protocol";

/** Runs after core openai-responses; core owns Chat/Anthropic conversion. */
/** Quota/terminal observations for the runtime's account bookkeeping. Never throws into the response path. */
export type GrokStreamNote = (info: { code: string; httpStatus: number; cooldownMs?: number }) => unknown;
export type GrokStreamHeal = () => unknown;

export class GrokTransformer {
  static TransformerName = "grok";
  name = "grok";
  constructor(private readonly engine: GrokEngine = createGrokEngine(), private readonly note?: GrokStreamNote, private readonly heal?: GrokStreamHeal) {}
  async transformRequestIn(request: any, _provider?: any, context?: any): Promise<any> {
    if (!request || !Array.isArray(request.input) && typeof request.input !== "string") throw grokError("grok_responses_body_required");
    const choice = request.tool_choice;
    const allowed = new Set(["function", "web_search", "x_search", "image_generation", "collections_search", "file_search", "code_execution", "code_interpreter", "mcp", "shell", "tool_search"]);
    // Unsupported explicit restrictions must fail closed, never silently become auto.
    if (choice && typeof choice === "object" && !allowed.has(choice.type)) throw grokError("grok_tool_choice_unsupported");
    if (choice && choice !== "auto" && choice !== "none" && Array.isArray(request.tools) && request.tools.some((t: any) => !allowed.has(t?.type))) throw grokError("grok_tool_choice_unsupported");
    if (choice && choice !== "auto" && choice !== "none" && !request.tools?.length) throw grokError("grok_tool_choice_unsupported");
    const normalized = structuredClone(request);
    if (choice === "any") normalized.tool_choice = "required";
    if (choice?.type === "function") {
      const name = choice.name ?? choice.function?.name;
      if (typeof name !== "string" || !request.tools?.some((t: any) => t.type === "function" && (t.name ?? t.function?.name) === name)) throw grokError("grok_tool_choice_unsupported");
      normalized.tool_choice = { type: "function", name };
    }
    const body = JSON.parse(this.engine.rewrite(JSON.stringify(normalized)));
    if (Array.isArray(body.include)) body.include = [...new Set(body.include.map((v: any) => v === "output.encrypted_content" ? "reasoning.encrypted_content" : v))];
    const model = this.engine.modelOf(body.model);
    body.model = model.model;
    // Keep selected context on request-scoped config; signer sees the normalized model.
    const session = context?.req?.clientContext?.stableSessionId;
    if (!body.prompt_cache_key && typeof session === "string" && session) body.prompt_cache_key = session;
    return { body, config: { grokContextWindow: model.window } };
  }
  /**
   * Bounded non-stream validation: a 200 JSON body that is actually a Responses
   * object clears latched account state. Anything unrecognizable stays a no-op —
   * neither healing nor latching — and bytes are requeued untouched.
   */
  private async validatedNonStream(response: Response): Promise<Response> {
    const reader = response.body!.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0, done = false;
    while (size < 16384) {
      const next = await reader.read();
      if (next.done) { done = true; break; }
      chunks.push(next.value); size += next.value.byteLength;
    }
    const prefix = new TextDecoder().decode(...chunks.length ? [concat(chunks, size)] : []);
    if (/"object"\s*:\s*"response"/.test(prefix)) {
      try {
        const healed = this.heal?.();
        if (healed && typeof (healed as Promise<void>).then === "function") (healed as Promise<void>).then(undefined, () => {});
      } catch { /* never breaks the response path */ }
    }
    const head = new ReadableStream<Uint8Array>({
      start(controller) { for (const chunk of chunks) controller.enqueue(chunk); if (done) controller.close(); },
      async pull(controller) {
        try { const next = await reader.read(); if (next.done) controller.close(); else controller.enqueue(next.value); }
        catch (error) { controller.error(error); }
      },
      cancel(reason) { return reader.cancel(reason); },
    });
    return new Response(head, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
  async transformResponseOut(response: Response): Promise<Response> {
    const contentType = response.headers.get("content-type") ?? "";
    if (response.ok && contentType.includes("application/json") && response.body) return this.validatedNonStream(response);
    if (!response.ok || !contentType.includes("text/event-stream")) return response;
    if (!response.body) throw grokError("grok_stream_truncated", 502);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "", terminal = false, firstEvent = false;
    let prefix: Uint8Array[] = [];
    let prefixSize = 0;
    const inspect = (raw: string) => {
      const data = raw.split(/\r\n|\n|\r/).filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n");
      if (!data || data === "[DONE]") return;
      let event: any;
      try { event = JSON.parse(data); } catch { throw grokError("grok_stream_invalid", 502); }
      if (event.type === "error" || event.type === "response.failed") {
        // Classify from upstream evidence, never flatten: quota signals cool the
        // account (429), auth signals mark relogin, everything else is a 502.
        const error = event.error ?? event.response?.error ?? event;
        const text = `${error.code ?? ""} ${error.type ?? ""} ${error.message ?? ""}`.toLowerCase();
        const status = Number(error.httpStatus ?? error.status ?? 0);
        let info: { code: string; httpStatus: number; cooldownMs?: number };
        if (status === 429 || /rate.?limit|usage.?limit/.test(text)) info = { code: "grok_rate_limited", httpStatus: 429, cooldownMs: 300000 };
        // Keyword evidence latches reauth only when the upstream did NOT name a
        // different status: a 500 whose message happens to say "authentication"
        // is an upstream outage, not an expired sign-in.
        else if (status === 401 || ((status === 0 || status === undefined) && /unauthorized|invalid.?token|authentication|sign.?in/.test(text))) info = { code: "grok_reauth_required", httpStatus: 401 };
        else info = { code: "grok_upstream_error", httpStatus: 502 };
        try {
          const noted = this.note?.(info);
          if (noted && typeof (noted as Promise<void>).then === "function") (noted as Promise<void>).then(undefined, () => {});
        } catch { /* bookkeeping never masks the stream failure */ }
        throw Object.assign(new Error(info.code), { code: info.code, statusCode: info.httpStatus, nonRetryable: true });
      }
      // A legitimate output cap is a whole reply (the host maps it to a length
      // finish reason); only a missing terminal at EOF is a truncation failure.
      if (event.type === "response.completed" || event.type === "response.incomplete") {
        terminal = true;
        // A validated terminal is the only stream shape that clears latched
        // reauth/cooldown state; a 200 stream carrying a failure never heals.
        try {
          const healed = this.heal?.();
          if (healed && typeof (healed as Promise<void>).then === "function") (healed as Promise<void>).then(undefined, () => {});
        } catch { /* healing never breaks the response path */ }
      }
    };
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          let chunk = await reader.read();
          while (!chunk.done && !firstEvent) {
            prefix.push(chunk.value); prefixSize += chunk.value.byteLength;
            if (prefixSize > 8 * 1024 * 1024) throw grokError("grok_stream_event_too_large", 502);
            pending += decoder.decode(chunk.value, { stream: true });
            if (pending.split(/\r\n\r\n|\n\n|\r\r/).slice(0, -1).some(frame => /data:\s*\{/.test(frame))) {
              firstEvent = true;
              const combined = new Uint8Array(prefixSize); let offset = 0;
              for (const bytes of prefix) { combined.set(bytes, offset); offset += bytes.byteLength; }
              prefix = []; prefixSize = 0;
              // Decode below exactly once, with all first-event bytes available to the host peeker.
              pending = ""; decoder.decode();
              chunk = { done: false, value: combined };
              break;
            }
            chunk = await reader.read();
          }
          if (chunk.done) {
            pending += decoder.decode();
            if (pending.trim()) inspect(pending);
            if (!terminal) throw grokError("grok_stream_truncated", 502);
            reader.releaseLock(); controller.close(); return;
          }
          pending += decoder.decode(chunk.value, { stream: true });
          const events = pending.split(/\r\n\r\n|\n\n|\r\r/); pending = events.pop() ?? "";
          for (const event of events) inspect(event);
          if (pending.length > 8 * 1024 * 1024) throw grokError("grok_stream_event_too_large", 502);
          controller.enqueue(chunk.value);
        } catch (e) { await reader.cancel(e).catch(() => {}); controller.error(e); }
      },
      async cancel(reason) { await reader.cancel(reason); },
    });
    const headers = new Headers(response.headers); headers.delete("content-length"); headers.delete("content-encoding");
    return new Response(stream, { status: response.status, headers });
  }
}
