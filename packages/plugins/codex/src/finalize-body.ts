/**
 * Codex request-body finalizer — the outbound quirk layer that turns a
 * Responses request produced by the `openai-responses` transformer into the
 * exact body the ChatGPT Codex backend accepts.
 *
 * Protocol source (first-hand): yetone/magpie
 *   - internal/provider/codex_request.go  codexBody / codexInput /
 *     conversationKey / sessionHeaders
 *   - docs/design/provider-plugins.md §5.2 (approved product spec)
 *   - research: codex-dataplane.md §2 (research artefacts, quoted verbatim)
 *
 * PURE: no I/O, no clock, no randomness (an explicit `now` injection is used
 * for the synthesised session key so the same conversation hashes the same),
 * no mutation of the caller's body — always a structured clone. This is why it
 * lives in its own module: the transformer and the tests can call it without a
 * service, a network or a host.
 *
 * The finalize contract, in the order magpie applies it:
 *  1. drop sampling knobs, stored-response references and explicit cache
 *     options the backend rejects;
 *  2. force stateless streaming: store:false, stream:true;
 *  3. tool_choice:"auto", parallel_tool_calls default true, text.verbosity;
 *  4. reasoning: effort "ultra" → "max"; summary "auto";
 *     include "reasoning.encrypted_content" (cross-turn reasoning carry-back);
 *  5. input items: no `id`, system role → developer, item_reference dropped,
 *     call_id > 64 → sha256 hex, orphan function_call_output rewritten as an
 *     assistant text message;
 *  6. instructions: the Codex instructions replace the client's; the client's
 *     own instructions are prepended as a developer message (unless they ARE
 *     the Codex instructions);
 *  7. prompt_cache_key: kept when the client supplied one, otherwise derived
 *     from the conversation prefix.
 *
 * NOT in scope (approved MVP exclusions): web_search declaration injection,
 * additional_tools ("Responses Lite"), zstd compression.
 */

import { createHash } from "node:crypto";

export const CODEX_PARALLEL_TOOL_CALLS_DEFAULT = true;
export const CODEX_TEXT_VERBOSITY_DEFAULT = "medium";
export const CODEX_REASONING_SUMMARY_DEFAULT = "auto";
export const CODEX_ENCRYPTED_REASONING_INCLUDE = "reasoning.encrypted_content";
/** call_id ceiling the backend accepts (magpie BoundCallID). */
export const CODEX_MAX_CALL_ID = 64;
/** orphan function_call_output truncation (magpie orphanOutput). */
export const CODEX_MAX_ORPHAN_OUTPUT = 16000;

/** Fields the backend rejects outright; dropped unconditionally. */
const DROP_FIELDS = [
  "max_output_tokens",
  "max_completion_tokens",
  "temperature",
  "top_p",
  "previous_response_id",
  "user",
  "safety_identifier",
  "prompt_cache_options",
] as const;

/** service_tier survives only for Codex's own two tiers. */
const ALLOWED_SERVICE_TIERS = new Set(["priority", "ultrafast"]);

export interface CodexFinalizeOptions {
  /**
   * Codex's own instructions for THIS model (from the /models response's
   * base_instructions / instructions_template, cached by the auth service).
   * Absent: the client's own instructions stay in place.
   */
  modelInstructions?: string;
  /**
   * Stable per-conversation identity (thread/session id). When the body has no
   * prompt_cache_key, this hashes together with the conversation prefix so
   * every turn of one conversation resolves to the same key.
   */
  sessionId?: string;
}

function clone<T>(value: T): T {
  // structuredClone handles Uint8Array/Buffer and cyclic-free plain data; a
  // JSON round-trip would corrupt binary image payloads. Fall back to JSON for
  // exotic values older runtimes cannot clone.
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** magpie BoundCallID: a foreign provider may join ids past the backend limit. */
function boundCallId(callId: unknown): unknown {
  if (typeof callId !== "string" || callId.length <= CODEX_MAX_CALL_ID) return callId;
  return sha256Hex(callId);
}

/** Host-side module only (never the browser card chunk); node:crypto is fine. */
function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** magpie conversationKey shape: 8-4-4-4-12 hex groups from a sha256. */
function conversationKey(instructions: string, input: any[], sessionId: string): string {
  const parts: string[] = [];
  if (instructions) parts.push(instructions);
  for (const item of input) {
    parts.push(JSON.stringify(item));
    // The prefix through the first user turn identifies the thread; later turns
    // must not change it (magpie: "up to the first user message").
    if (item?.role === "user") break;
  }
  const digest = sha256Hex(sessionId + "\u0000" + parts.join("\u0000"));
  return [
    digest.slice(0, 8), digest.slice(8, 12), digest.slice(12, 16),
    digest.slice(16, 20), digest.slice(20, 32),
  ].join("-");
}

/** Input items may arrive as a bare string; the backend wants a user message. */
function normalizeInputShape(input: unknown): any[] {
  if (typeof input === "string") {
    return [{ type: "message", role: "user", content: [{ type: "input_text", text: input }] }];
  }
  return Array.isArray(input) ? input : [];
}

/** Rewrite one input item to the stateless shape Codex sends. */
function normalizeItem(item: any, boundCallIds: Map<unknown, unknown>): any | null {
  if (!isPlainObject(item)) return null;
  // item_reference points at a stored item; `store:false` keeps nothing.
  if (item.type === "item_reference") return null;
  const next: any = { ...item };
  // No id ever rides on an item of a stateless request.
  delete next.id;
  // The backend rejects role:"system"; developer carries the same meaning.
  if (next.role === "system") next.role = "developer";
  if (next.call_id !== undefined) {
    const bounded = boundCallId(next.call_id);
    if (bounded !== next.call_id) {
      boundCallIds.set(item.call_id, bounded);
      next.call_id = bounded;
    }
  }
  return next;
}

function textOfOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    return output
      .map((part) => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  if (isPlainObject(output) && typeof output.text === "string") return output.text;
  try { return JSON.stringify(output ?? ""); } catch { return String(output); }
}

/**
 * A function_call_output with no matching function_call in the same input is
 * rejected by the backend (a stateless request must carry the call). Rewrite
 * it as an assistant text message so the model still sees the tool result
 * (magpie orphanOutput, truncated to CODEX_MAX_ORPHAN_OUTPUT).
 */
function orphanOutputAsMessage(item: any): any {
  let text = textOfOutput(item.output);
  if (text.length > CODEX_MAX_ORPHAN_OUTPUT) text = text.slice(0, CODEX_MAX_ORPHAN_OUTPUT);
  return {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: `[tool output for ${String(item.call_id ?? "unknown")}]\n${text}` }],
  };
}

function finalizeInput(input: unknown): { input: any[]; callIds: Map<unknown, unknown> } {
  const raw = normalizeInputShape(clone(input));
  const boundCallIds = new Map<unknown, unknown>();
  const normalized = raw.map((item) => normalizeItem(item, boundCallIds)).filter((item) => item !== null);
  // Collect the calls that survive normalization — after call_id bounding.
  const calls = new Set<unknown>();
  for (const item of normalized) {
    if (item.type === "function_call") calls.add(item.call_id);
  }
  const out: any[] = [];
  for (const item of normalized) {
    if (item.type === "function_call_output" && !calls.has(item.call_id)) {
      out.push(orphanOutputAsMessage(item));
      continue;
    }
    out.push(item);
  }
  return { input: out, callIds: boundCallIds };
}

/** reasoning block: effort alias, summary default, encrypted-content include. */
function finalizeReasoning(body: Record<string, any>): void {
  const reasoning = isPlainObject(body.reasoning) ? body.reasoning : undefined;
  const effort = typeof reasoning?.effort === "string" ? reasoning.effort.trim().toLowerCase() : "";
  if (effort === "none") {
    // No reasoning at all: the encrypted-content include is meaningless, but a
    // client's OTHER include entries survive — drop only our own.
    if (Array.isArray(body.include)) {
      const kept = body.include.filter((v: unknown) => v !== CODEX_ENCRYPTED_REASONING_INCLUDE);
      if (kept.length) body.include = kept;
      else delete body.include;
    }
    if (reasoning) body.reasoning = reasoning;
    return;
  }
  if (reasoning && effort === "ultra") reasoning.effort = "max";
  if (reasoning && reasoning.summary === undefined) reasoning.summary = CODEX_REASONING_SUMMARY_DEFAULT;
  const include = Array.isArray(body.include) ? body.include.filter((v: unknown) => typeof v === "string") : [];
  if (!include.includes(CODEX_ENCRYPTED_REASONING_INCLUDE)) include.push(CODEX_ENCRYPTED_REASONING_INCLUDE);
  body.include = include;
}

function firstLine(text: string): string {
  return (text.split(/\r?\n/, 1)[0] ?? "").trim();
}

/**
 * Codex instructions replace the client's; the client's own instructions are
 * prepended as a developer message UNLESS they are the Codex instructions
 * themselves (the client already is Codex). magpie codexBody, verbatim order.
 */
function finalizeInstructions(body: Record<string, any>, input: any[], modelInstructions: string | undefined): any[] {
  const own = typeof body.instructions === "string" ? body.instructions : "";
  if (typeof modelInstructions !== "string" || modelInstructions.trim() === "") {
    // No Codex instructions cached (offline / not synced): keep the client's.
    return input;
  }
  let nextInput = input;
  if (own.trim() !== "" && firstLine(own) !== firstLine(modelInstructions)) {
    nextInput = [{
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: own }],
    }, ...input];
  }
  body.instructions = modelInstructions;
  return nextInput;
}

/**
 * Finalize a Responses body into the Codex wire body. Pure: the argument is
 * never mutated and the caller's shared object cannot be poisoned.
 */
export function codexFinalizeBody(body: any, options: CodexFinalizeOptions = {}): any {
  const source = isPlainObject(body) ? clone(body) : {};
  const out: Record<string, any> = { ...source };

  for (const key of DROP_FIELDS) delete out[key];
  if (typeof out.service_tier === "string" && !ALLOWED_SERVICE_TIERS.has(out.service_tier)) delete out.service_tier;

  // Stateless streaming is mandatory.
  out.store = false;
  out.stream = true;
  out.tool_choice = "auto";
  if (out.parallel_tool_calls === undefined) out.parallel_tool_calls = CODEX_PARALLEL_TOOL_CALLS_DEFAULT;
  if (!isPlainObject(out.text)) out.text = { verbosity: CODEX_TEXT_VERBOSITY_DEFAULT };

  finalizeReasoning(out);

  let { input } = finalizeInput(out.input);
  input = finalizeInstructions(out, input, options.modelInstructions);
  out.input = input;

  if (typeof out.prompt_cache_key !== "string" || out.prompt_cache_key.trim() === "") {
    const seed = typeof options.sessionId === "string" && options.sessionId
      ? options.sessionId
      : JSON.stringify([out.instructions ?? "", input[0] ?? null]);
    out.prompt_cache_key = conversationKey(
      typeof out.instructions === "string" ? out.instructions : "",
      input,
      seed,
    );
  }

  return out;
}

/**
 * The session header value for a finalized body: its prompt_cache_key. The
 * backend finds a conversation's cached prompt by the session-id/thread-id
 * HEADERS, not by the body key alone (magpie #1473: 0 cached tokens without
 * them). Exposed so the runtime and the transformer derive it identically.
 */
export function codexSessionKey(body: any): string | undefined {
  const key = body?.prompt_cache_key;
  return typeof key === "string" && key ? key : undefined;
}
