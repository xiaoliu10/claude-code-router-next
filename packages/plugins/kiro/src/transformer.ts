import { createHash, randomUUID } from "node:crypto";
import type { KiroAuthService } from "./auth-service";
import { kiroError } from "./protocol";

// Wire JSON is extensible vendor data. Keep dynamic fields at this boundary.
type Json = Record<string, any>;
const object = (v: unknown): Json => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Json : {};
const textOf = (v: unknown): string => typeof v === "string" ? v : Array.isArray(v) ? v.filter(p => p?.type === "text").map(p => p.text ?? "").join("\n\n") : "";
const join = (a: string, b: string) => [a, b].filter(Boolean).join("\n\n");
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
export const kiroToolName = (name: string): string => /^[a-zA-Z0-9_-]{1,64}$/.test(name) ? name : `${name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 51)}_${hash(name).slice(0, 12)}`;
const toolId = (id: string): string => /^[a-zA-Z0-9_.:-]{1,64}$/.test(id) ? id : `t_${hash(id).slice(0, 32)}`;

/** Normalize CCR unified messages without carrying reusable reasoning signatures. */
export function anthropicRequest(request: Json): Json {
  return { ...request, messages: (request.messages ?? []).map((m: Json) => {
    if (m.role === "tool") return { role: "user", content: [{ type: "tool_result", tool_use_id: m.tool_call_id, content: m.content, is_error: m.is_error }] };
    let content = typeof m.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m.content) ? m.content.map((p: Json) => {
      if (p.type !== "image_url") return p;
      const match = /^data:([^;]+);base64,(.*)$/s.exec(p.image_url?.url ?? "");
      return match ? { type: "image", source: { type: "base64", media_type: match[1], data: match[2] } } : p;
    }) : [];
    if (m.tool_calls) content = [...content, ...m.tool_calls.map((t: Json) => {
      let input: Json = {}; try { input = object(JSON.parse(t.function.arguments)); } catch { /* Interrupted arguments have no usable object. */ }
      return { type: "tool_use", id: t.id, name: t.function.name, input };
    })];
    return { ...m, content };
  }), tools: (request.tools ?? []).map((t: Json) => t.type === "function" ? { name: t.function.name, description: t.function.description, input_schema: t.function.parameters } : t) };
}

export interface KiroRequestState { model: string; stream: boolean; thinking: boolean; names: Map<string, string>; aliases: Map<string, string>; inputEstimate: number; contextWindow: number }
export function requestState(request: Json): KiroRequestState {
  if (typeof request.model !== "string" || !request.model.trim()) throw kiroError("kiro_model_unknown", 400);
  const names = new Map<string, string>(), aliases = new Map<string, string>();
  const add = (n: unknown) => {
    if (typeof n !== "string" || aliases.has(n)) return;
    let alias = kiroToolName(n);
    // Distinct originals can normalize to the same alias (e.g. a long name and
    // its own pre-aliased form). Silently deduping would drop a declared tool,
    // so disambiguate deterministically with a hash prefix and sequence suffix,
    // keeping the 64-char alias charset valid and the mapping reversible.
    if (names.has(alias) && names.get(alias) !== n) {
      const digest = hash(n);
      for (let seq = 2; names.has(alias); seq++) alias = `${kiroToolName(n).slice(0, 48 - String(seq).length)}_${digest.slice(0, 12)}_${seq}`;
    }
    aliases.set(n, alias); names.set(alias, n);
  };
  for (const t of request.tools ?? []) add(t.name ?? t.function?.name);
  for (const m of request.messages ?? []) for (const p of Array.isArray(m.content) ? m.content : []) if (p.type === "tool_use") add(p.name);
  return { model: request.model, stream: request.stream === true, thinking: request.thinking?.type === "disabled" || request.reasoning?.enabled === false ? false : ["enabled", "adaptive"].includes(request.thinking?.type) || request.reasoning?.enabled === true || (!!request.reasoning?.effort && request.reasoning.effort !== "none"), names, aliases,
    inputEstimate: Math.ceil(JSON.stringify({ system: request.system, messages: request.messages, tools: request.tools }).length / 4), contextWindow: 0 };
}

/** Kiro has no enabled systemPrompt field; prepend instructions to the first user turn. */
export function buildKiro(request: Json, model: string, profile = ""): Json {
  const req = anthropicRequest(request), entries: Json[] = [];
  // One shared alias mapping for history toolUses, offered tools and response
  // restoration; collision-disambiguated aliases stay reversible.
  const state = requestState(req);
  const aliasOf = (n: unknown): string => (typeof n === "string" ? state.aliases.get(n) ?? kiroToolName(n) : "");
  const user = (): Json => ({ content: "", modelId: model, origin: "KIRO_CLI", images: [], userInputMessageContext: { toolResults: [] } });
  const images = (parts: Json[]) => parts.filter(p => p.type === "image" && p.source?.type === "base64").map(p => ({ format: String(p.source.media_type ?? "image/png").replace("image/", "").replace(/^jpg$/, "jpeg"), source: { bytes: p.source.data } }));
  for (const m of req.messages ?? []) {
    const parts: Json[] = Array.isArray(m.content) ? m.content : [];
    if (m.role === "assistant") {
      const toolUses = parts.filter(p => p.type === "tool_use").map(p => ({ name: aliasOf(p.name), toolUseId: toolId(p.id), input: object(p.input) }));
      const content = textOf(parts);
      if (!content && !toolUses.length) continue;
      const prev = entries.at(-1)?.assistantResponseMessage;
      if (prev) { prev.content = join(prev.content, content); prev.toolUses.push(...toolUses); }
      else entries.push({ assistantResponseMessage: { content, toolUses } });
    } else {
      const u = user(); u.content = textOf(parts); u.images = images(parts);
      const results = parts.filter(p => p.type === "tool_result").map(p => {
        if (Array.isArray(p.content)) u.images.push(...images(p.content));
        return { toolUseId: toolId(p.tool_use_id), status: p.is_error ? "error" : "success", content: [{ text: textOf(p.content).slice(0, 250000) || "(no output)" }] };
      });
      u.userInputMessageContext = { toolResults: results };
      const prev = entries.at(-1)?.userInputMessage;
      if (prev) { prev.content = join(prev.content, u.content); prev.images.push(...u.images); prev.userInputMessageContext.toolResults.push(...results); }
      else entries.push({ userInputMessage: u });
    }
  }
  while (entries.length) {
    const first = entries[0].userInputMessage;
    if (first && (first.content || first.images.length || !first.userInputMessageContext.toolResults.length)) break;
    entries.shift();
  }
  if (!entries.at(-1)?.userInputMessage) entries.push({ userInputMessage: user() });
  let latestImage = -1;
  entries.forEach((e, i) => { if (e.userInputMessage?.images.length) latestImage = i; });
  entries.forEach((e, i) => {
    const u = e.userInputMessage;
    if (!u) return;
    const calls: Json[] = entries[i - 1]?.assistantResponseMessage?.toolUses ?? [];
    const supplied: Json[] = u.userInputMessageContext?.toolResults ?? [];
    const results = calls.map(c => supplied.find(r => r.toolUseId === c.toolUseId) ?? { toolUseId: c.toolUseId, status: "error", content: [{ text: "Tool use was interrupted and did not produce a result." }] });
    u.userInputMessageContext = results.length ? { toolResults: results } : {};
    if (!u.content && !results.length) u.content = "Please proceed with the task.";
    if (i !== latestImage || !u.images.length) delete u.images;
  });
  let system = textOf(req.system);
  const format = req.output_config?.format ?? req.output_format;
  if (format?.type === "json_schema") system = join(system, `Respond with a single JSON value matching this JSON schema:\n${JSON.stringify(format.schema)}`);
  if (state.thinking && (/claude/i.test(model) || model === "auto")) {
    const budgets: Record<string, number> = { low: 10000, medium: 20000, high: 30000, xhigh: 50000, max: 50000 };
    const budget = budgets[req.output_config?.effort ?? req.reasoning?.effort] ?? req.thinking?.budget_tokens ?? req.reasoning?.max_tokens ?? 20000;
    system = `<thinking_mode>enabled</thinking_mode><max_thinking_length>${budget}</max_thinking_length>\n${system}`;
  }
  entries[0].userInputMessage.content = join(system, entries[0].userInputMessage.content);
  const tools: Json[] = [], offered = new Set<string>();
  const offer = (name: string, description: string, schema: Json) => {
    const alias = aliasOf(name);
    if (!alias || offered.has(alias)) return; offered.add(alias);
    // Only collapse object/null unions to "object"; unions containing other
    // types (e.g. ["object","string"]) keep the caller's schema semantics.
    const type = schema.type === undefined || Array.isArray(schema.type) && schema.type.every((t: unknown) => t === "object" || t === "null") ? "object" : schema.type;
    tools.push({ toolSpecification: { name: alias, description: description || name, inputSchema: { json: { ...schema, type } } } });
  };
  for (const t of req.tools ?? []) {
    if (t.type && t.type !== "custom") throw Object.assign(kiroError("kiro_request_failed", 400), { message: "Kiro hosted tools are not supported / 暂不支持 Kiro 托管工具" });
    offer(t.name, t.description, Object.keys(object(t.input_schema)).length ? t.input_schema : { type: "object", properties: {} });
  }
  for (const e of entries) for (const t of e.assistantResponseMessage?.toolUses ?? []) offer(state.names.get(t.name) ?? t.name, "Tool", { type: "object", properties: {} });
  const current = entries.at(-1)!.userInputMessage;
  if (tools.length) current.userInputMessageContext.tools = tools;
  return { conversationState: { chatTriggerType: "MANUAL", agentTaskType: "vibe", conversationId: randomUUID(), currentMessage: { userInputMessage: current }, ...(entries.length > 1 ? { history: entries.slice(0, -1) } : {}) }, agentMode: "vibe", ...(profile ? { profileArn: profile } : {}) };
}

/** Lets a downstream cancel() interrupt a pending upstream read immediately. */
export interface KiroCancelBus { interrupt(): void }

/** Parse fragmented AWS EventStream frames with bounded frame sizes. */
export async function* kiroFrames(body: ReadableStream<Uint8Array>, cancelBus?: KiroCancelBus): AsyncGenerator<{ kind: string; data: Json; exception: boolean }> {
  const reader = body.getReader(); let buffer = Buffer.alloc(0); let complete = false;
  // Cancel the reader directly, before queuing generator.return() behind next().
  if (cancelBus) cancelBus.interrupt = () => { void reader.cancel().catch(() => {}); };
  try {
    for (;;) {
      if (buffer.length >= 12) {
        const total = buffer.readUInt32BE(0), length = buffer.readUInt32BE(4);
        if (total < 16 || total > 16 * 1024 * 1024 || length > total - 16) throw kiroError("kiro_stream_invalid", 502);
        if (buffer.length >= total) {
          const headers: Record<string, string> = {}; let i = 12; const end = 12 + length;
          while (i < end) {
            const size = buffer[i++]; if (i + size + 1 > end) throw kiroError("kiro_stream_invalid", 502);
            const name = buffer.toString("utf8", i, i + size); i += size; const type = buffer[i++];
            if (type === 6 || type === 7) {
              if (i + 2 > end) throw kiroError("kiro_stream_invalid", 502);
              const n = buffer.readUInt16BE(i); i += 2; if (i + n > end) throw kiroError("kiro_stream_invalid", 502);
              if (type === 7) headers[name] = buffer.toString("utf8", i, i + n); i += n;
            } else { const n = ({ 0: 0, 1: 0, 2: 1, 3: 2, 4: 4, 5: 8, 8: 8, 9: 16 } as Record<number, number>)[type]; if (n === undefined || i + n > end) throw kiroError("kiro_stream_invalid", 502); i += n; }
          }
          let data: Json;
          try { data = object(JSON.parse(buffer.toString("utf8", end, total - 4))); } catch { throw kiroError("kiro_stream_invalid", 502); }
          buffer = buffer.subarray(total);
          yield { kind: headers[":event-type"] ?? headers[":exception-type"] ?? headers[":error-code"] ?? "", data, exception: ["exception", "error"].includes(headers[":message-type"]) };
          continue;
        }
      }
      const next = await reader.read();
      if (next.done) { if (buffer.length) throw kiroError("kiro_stream_truncated", 502); complete = true; return; }
      buffer = Buffer.concat([buffer, next.value]);
    }
  } finally { if (!complete) await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Split leading thinking tags even when the upstream splits a tag across frames. */
class ThinkingParser {
  buffer = ""; mode: "initial" | "thinking" | "text" = "initial";
  feed(text: string, end = false): Array<{ type: "text" | "thinking"; text: string }> {
    this.buffer += text; const out: Array<{ type: "text" | "thinking"; text: string }> = [];
    if (this.mode === "initial") {
      const t = this.buffer.trimStart();
      if (t.startsWith("<thinking>")) { this.mode = "thinking"; this.buffer = t.slice(10).replace(/^\r?\n/, ""); }
      else if (!end && "<thinking>".startsWith(t)) return out;
      else this.mode = "text";
    }
    if (this.mode === "thinking") {
      const index = this.buffer.indexOf("</thinking>");
      if (index >= 0) { if (index) out.push({ type: "thinking", text: this.buffer.slice(0, index) }); this.buffer = this.buffer.slice(index + 11).replace(/^\r?\n/, ""); this.mode = "text"; }
      else {
        let hold = 0;
        if (!end) for (let n = 1; n < 11 && n <= this.buffer.length; n++) if (this.buffer.endsWith("</thinking>".slice(0, n))) hold = n;
        const text = this.buffer.slice(0, this.buffer.length - hold); if (text) out.push({ type: "thinking", text }); this.buffer = this.buffer.slice(this.buffer.length - hold); return out;
      }
    }
    if (this.buffer) out.push({ type: "text", text: this.buffer }); this.buffer = ""; return out;
  }
}

export function kiroFailure(status: number, body: Json = {}): Error & { statusCode: number; code: string } {
  const reason = `${body.message ?? ""} ${body.reason ?? ""}`;
  if (/CONTENT_LENGTH_EXCEEDS_THRESHOLD|input is too long/i.test(reason)) status = 400;
  else if (/INSUFFICIENT_MODEL_CAPACITY/.test(reason)) status = 503;
  else if (/MONTHLY_REQUEST_COUNT|USAGE_LIMIT|throttl/i.test(reason)) status = 429;
  const code = [401, 403].includes(status) ? "kiro_reauth_required" : status === 429 ? "kiro_rate_limited" : "kiro_upstream_error";
  // Never reflect vendor bodies, credentials, or arbitrary error text to clients.
  return Object.assign(new Error(`Kiro request failed (${status}) / Kiro 请求失败（${status}）`), { code, statusCode: status, pluginClassified: true, nonRetryable: status < 500 && status !== 429 });
}

type Event = Json & { type: string };
/** Emit Anthropic Messages events; the provider adapter below converts these to unified Chat. */
export async function* kiroEvents(response: Response, state: KiroRequestState, cancelBus?: KiroCancelBus): AsyncGenerator<Event> {
  if (!response.ok) { let data: Json = {}; try { data = object(await response.json()); } catch { /* Status remains authoritative. */ } throw kiroFailure(response.status, data); }
  if (!response.body) throw kiroError("kiro_stream_truncated", 502);
  const id = `msg_${randomUUID()}`, think = new ThinkingParser();
  let started = false, index = -1, open = "", currentTool = "", hasTools = false, chars = 0, visible = false, stop = "end_turn", pct = 0, reported = false;
  const usage: Json = { input_tokens: 0, output_tokens: 0 };
  const start = function* (): Generator<Event> { if (!started) { started = true; yield { type: "message_start", message: { id, type: "message", role: "assistant", model: state.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } }; } };
  const close = function* (): Generator<Event> { if (open) yield { type: "content_block_stop", index }; open = ""; };
  const content = function* (type: "text" | "thinking", text: string): Generator<Event> {
    if (!text) return; visible = true; chars += text.length; yield* start();
    if (open !== type) { yield* close(); open = type; index++; yield { type: "content_block_start", index, content_block: type === "text" ? { type, text: "" } : { type, thinking: "", signature: "" } }; }
    yield { type: "content_block_delta", index, delta: { type: `${type}_delta`, [type]: text } };
  };
  for await (const frame of kiroFrames(response.body, cancelBus)) {
    const m = frame.data, kind = frame.kind;
    if (frame.exception || /error|exception/i.test(kind)) throw kiroFailure(/throttl/i.test(kind) ? 429 : 502, m);
    const model = m.model ?? m.modelId; if (typeof model === "string" && model.trim()) state.model = model;
    if (kind === "assistantResponseEvent") {
      const value = typeof m.content === "string" ? m.content : "";
      for (const part of state.thinking ? think.feed(value) : [{ type: "text" as const, text: value }]) yield* content(part.type, part.text);
    } else if (kind === "reasoningContentEvent") {
      if (typeof m.text === "string") yield* content("thinking", m.text);
      if (m.signature && open === "thinking") yield { type: "content_block_delta", index, delta: { type: "signature_delta", signature: m.signature } };
    } else if (kind === "toolUseEvent") {
      for (const part of think.feed("", true)) yield* content(part.type, part.text);
      if (m.toolUseId && m.toolUseId !== currentTool) {
        yield* start(); yield* close(); currentTool = m.toolUseId; hasTools = true; visible = true; open = "tool_use"; index++;
        yield { type: "content_block_start", index, content_block: { type: "tool_use", id: m.toolUseId, name: state.names.get(m.name) ?? m.name, input: {} } };
      }
      if (m.input !== undefined && m.input !== null && open === "tool_use") {
        const json = typeof m.input === "string" ? m.input : JSON.stringify(m.input);
        // Tool-use start events carry an empty-object placeholder. Serializing it
        // would corrupt the incremental JSON ("{}" + '{"path":' + '"a"}'), so the
        // serialized-empty case is skipped while string deltas stay verbatim.
        if (json && !(typeof m.input !== "string" && json === "{}")) { chars += json.length; yield { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json } }; }
      }
      if (m.stop) yield* close();
    } else if (kind === "metadataEvent" || kind === "messageMetadataEvent") {
      if (m.stopReason) stop = ({ max_tokens: "max_tokens", content_filtered: "refusal", tool_use: "tool_use" } as Record<string, string>)[String(m.stopReason).toLowerCase()] ?? "end_turn";
      const tu = m.tokenUsage;
      if (tu && typeof tu === "object") {
        reported ||= ["uncachedInputTokens", "inputTokens", "outputTokens", "cacheReadInputTokens", "cacheWriteInputTokens"].some(key => typeof tu[key] === "number" && Number.isFinite(tu[key]));
        const count = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
        usage.input_tokens += count(tu.uncachedInputTokens ?? tu.inputTokens); usage.output_tokens += count(tu.outputTokens);
        usage.cache_read_input_tokens = (usage.cache_read_input_tokens ?? 0) + count(tu.cacheReadInputTokens);
        usage.cache_creation_input_tokens = (usage.cache_creation_input_tokens ?? 0) + count(tu.cacheWriteInputTokens);
        pct = count(tu.contextUsagePercentage) || pct;
      }
    } else if (kind === "contextUsageEvent") pct = Number(m.contextUsagePercentage) || pct;
    // Supplementary links/metering are metadata, not assistant text or token counts.
  }
  for (const part of think.feed("", true)) yield* content(part.type, part.text);
  if (!visible) throw kiroError("kiro_stream_truncated", 502);
  yield* close();
  if (!reported) { usage.input_tokens = pct > 0 && state.contextWindow > 0 ? Math.floor(pct * state.contextWindow / 100) : state.inputEstimate; usage.output_tokens = Math.ceil(chars / 4); usage.kiro_estimated = true; }
  yield { type: "message_delta", model: state.model, delta: { stop_reason: hasTools ? "tool_use" : stop, stop_sequence: null }, usage };
  yield { type: "message_stop", usage, model: state.model };
}

/** Standalone Messages response and the CCR unified Chat adapter share one parser. */
export async function kiroResponse(response: Response, state: KiroRequestState, unified = false): Promise<Response> {
  const cancelBus: KiroCancelBus = { interrupt: () => {} };
  const iterator = kiroEvents(response, state, cancelBus);
  const first = await iterator.next();
  const events = async function* () { if (!first.done) yield first.value; yield* iterator; };
  const id = `chatcmpl_${randomUUID()}`, created = Math.floor(Date.now() / 1000);
  let toolIndex = -1;
  const chat = (e: Event): Json | undefined => {
    const delta: Json = {}; let finish: string | null = null;
    if (e.type === "message_start") delta.role = "assistant";
    else if (e.type === "content_block_start" && e.content_block.type === "tool_use") { toolIndex++; delta.tool_calls = [{ index: toolIndex, id: e.content_block.id, type: "function", function: { name: e.content_block.name, arguments: "" } }]; }
    else if (e.type === "content_block_delta") {
      if (e.delta.type === "text_delta") delta.content = e.delta.text;
      else if (e.delta.type === "thinking_delta") delta.thinking = { content: e.delta.thinking };
      else if (e.delta.type === "signature_delta") delta.thinking = { signature: e.delta.signature };
      else if (e.delta.type === "input_json_delta") delta.tool_calls = [{ index: toolIndex, function: { arguments: e.delta.partial_json } }];
      else return;
    } else if (e.type === "message_delta") finish = e.delta.stop_reason === "tool_use" ? "tool_calls" : e.delta.stop_reason === "max_tokens" ? "length" : e.delta.stop_reason === "refusal" ? "content_filter" : "stop";
    else return;
    const u = e.usage;
    return { id, object: "chat.completion.chunk", created, model: state.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(u ? { usage: { usage_source: "kiro", prompt_tokens: u.input_tokens + (u.cache_read_input_tokens ?? 0), completion_tokens: u.output_tokens, total_tokens: u.input_tokens + (u.cache_read_input_tokens ?? 0) + u.output_tokens, prompt_tokens_details: { cached_tokens: u.cache_read_input_tokens ?? 0 }, cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0, ...(u.kiro_estimated ? { kiro_estimated: true } : {}) } } : {}) };
  };
  if (!state.stream) {
    const blocks: Json[] = []; let usage: Json = {}, stop = "end_turn";
    for await (const e of events()) {
      if (e.type === "content_block_start") blocks[e.index] = { ...e.content_block };
      if (e.type === "content_block_delta") { const b = blocks[e.index]; if (e.delta.type === "input_json_delta") b.arguments = (b.arguments ?? "") + e.delta.partial_json; else if (e.delta.type === "signature_delta") b.signature += e.delta.signature; else b[b.type] += e.delta[b.type]; }
      if (e.type === "message_delta") { usage = e.usage; stop = e.delta.stop_reason; }
    }
    for (const b of blocks) if (b.type === "tool_use") { try { b.input = JSON.parse(b.arguments || "{}"); } catch { throw kiroError("kiro_stream_invalid", 502); } delete b.arguments; }
    if (!unified) return Response.json({ id, type: "message", role: "assistant", model: state.model, content: blocks, stop_reason: stop, stop_sequence: null, usage });
    const terminal = chat({ type: "message_delta", delta: { stop_reason: stop }, usage })!;
    return Response.json({ ...terminal, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: blocks.filter(b => b.type === "text").map(b => b.text).join(""), ...(blocks.some(b => b.type === "thinking") ? { thinking: { content: blocks.filter(b => b.type === "thinking").map(b => b.thinking).join("") } } : {}), ...(blocks.some(b => b.type === "tool_use") ? { tool_calls: blocks.filter(b => b.type === "tool_use").map(b => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input) } })) } : {}) }, finish_reason: terminal.choices[0].finish_reason }] });
  }
  const source = events(), encoder = new TextEncoder();
  // Reclaim is idempotent: a cancel can race with a failed pull.
  // The interrupt reaches the pending upstream read FIRST —
  // waiting for generator.return() alone would queue behind it indefinitely.
  let reclaim: Promise<void> | undefined;
  let cancelled = false;
  const cancel = () => reclaim ??= (async () => {
    cancelBus?.interrupt();
    try { await source.return(undefined); await iterator.return(undefined); } catch { /* generator already unwound by the interrupt */ }
  })();
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        for (;;) {
          const next = await source.next();
          if (cancelled) return;
          if (next.done) { if (unified) controller.enqueue(encoder.encode("data: [DONE]\n\n")); controller.close(); return; }
          const value = unified ? chat(next.value) : next.value;
          if (!value) continue;
          controller.enqueue(encoder.encode(`${unified ? "" : `event: ${value.type}\n`}data: ${JSON.stringify(value)}\n\n`)); return;
        }
      } catch (e) { await cancel(); if (!cancelled) controller.error(e); }
    }, async cancel() { cancelled = true; await cancel(); },
  }), { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
}

export class KiroTransformer {
  static TransformerName = "kiro";
  name = "kiro";
  constructor(private readonly service?: KiroAuthService) {}
  async transformRequestIn(request: Json, _provider?: unknown, context: Json = {}): Promise<{ body: Json }> {
    context.kiro = requestState(anthropicRequest(request));
    if (this.service) {
      const status = await this.service.getStatus();
      context.kiro.contextWindow = status.models.find(m => m.id === request.model)?.context ?? 0;
    }
    return { body: buildKiro(request, request.model) };
  }
  async transformResponseOut(response: Response, context: Json = {}): Promise<Response> {
    if (!context.kiro) throw kiroError("kiro_model_unknown", 500);
    const account = response.headers.get("x-ccr-kiro-account") ?? undefined;
    const note = async (error: unknown) => {
      const status = Number((error as { statusCode?: number }).statusCode) || 502;
      const failure = kiroFailure(status);
      await this.service?.noteUpstreamError({ code: failure.code, message: failure.message, httpStatus: status, ...(status === 429 ? { cooldownMs: 300000 } : {}) }, account).catch(() => {});
    };
    let result: Response;
    try { result = await kiroResponse(response, context.kiro, true); }
    catch (error) { await note(error); throw error; }
    if (!result.body || !context.kiro.stream) return result;
    const reader = result.body.getReader();
    let cancelled = false;
    return new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        try { const next = await reader.read(); if (cancelled) return; if (next.done) controller.close(); else controller.enqueue(next.value); }
        catch (error) { if (!cancelled) { await note(error); controller.error(error); } }
      },
      cancel: reason => { cancelled = true; return reader.cancel(reason); },
    }), { headers: result.headers });
  }
}
