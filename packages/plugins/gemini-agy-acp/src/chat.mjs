import { randomUUID } from 'node:crypto';
import { MAX_CALLS_PER_TURN } from './agy-tool-bridge.mjs';

export function failure(code, statusCode, message = code) {
  return Object.assign(new Error(message), { code, statusCode, nonRetryable: true });
}

function unsupported(message) {
  throw failure('agy_unsupported_request', 400, message);
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content) && content.length && content.every(part =>
    part?.type === 'text' && typeof part.text === 'string')) {
    return content.map(part => part.text).join('\n');
  }
  unsupported('Only text message content is supported.');
}

/**
 * Text-only validation: the contract for a request that declares no tools.
 */
export function textTurns(body) {
  assertNoTools(body);
  return textTurnsOnly(body);
}

/** Reject tool declarations; used only by the text-only path. */
export function assertNoTools(body) {
  if ((body.tools !== undefined && !(Array.isArray(body.tools) && !body.tools.length)) ||
      body.tool_choice != null || body.functions != null || body.function_call != null ||
      body.parallel_tool_calls != null || body.audio != null ||
      (body.modalities != null && !(Array.isArray(body.modalities) && body.modalities.length === 1 && body.modalities[0] === 'text'))) {
    unsupported('Tools, function calling and non-text modalities are unsupported.');
  }
}

/**
 * Message and content validation shared by both paths.
 *
 * Tool-bearing messages are allowed here, but only when they actually carry a
 * call: an assistant turn with `tool_calls: []` and a `tool` role result have
 * no tool turn behind them, so they stay a text-only rejection. Their payload
 * is carried through, never executed.
 */
export function textTurnsOnly(body) {
  if (!Array.isArray(body.messages) || !body.messages.length) unsupported('Expected one or more messages.');
  const turns = [];
  if (body.system !== undefined) turns.push({ role: 'system', content: contentText(body.system) });
  for (const msg of body.messages) {
    if (!['system', 'user', 'assistant', 'tool', 'function'].includes(msg?.role)) unsupported('Unsupported message role.');
    if (['audio', 'refusal'].some(key => msg[key] != null)) unsupported('Only unnamed text messages are supported.');
    // A tool-bearing message is allowed here, but only when it actually carries
    // a call: `tool_calls: []` declares nothing, so it stays a text-only
    // rejection. A `tool` role message is itself the result, and its id is what
    // ties it back to the call, so that is not an unnamed-text violation either.
    const carriesCall = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
    const isToolResult = msg.role === 'tool';
    const toolKeys = ['tool_call_id', 'function_call', 'thinking', 'name'];
    if (!carriesCall && !isToolResult &&
        (toolKeys.some(key => msg[key] != null) || msg.tool_calls != null)) {
      unsupported('Only unnamed text messages are supported.');
    }
    // An assistant turn that only carries tool calls, and a tool result, have no
    // text of their own.
    const content = msg.content == null ? '' : contentText(msg.content);
    turns.push({ role: msg.role, content });
  }
  return turns;
}

export function toPrompt(body, provider, original) {
  const { model, reasoning, reasoning_effort } = body;
  if (typeof model !== 'string' || !model || !Array.isArray(provider.models) || !provider.models.includes(model)) {
    unsupported('Model is missing from the local provider catalog.');
  }
  // CCR normalizes Anthropic xhigh to max. The CLI advertises distinct Extra
  // and Max tiers, so retain the original explicit effort when present.
  const thinking = reasoning?.enabled === false ? 'none' : reasoning_effort ?? original?.output_config?.effort ?? reasoning?.effort;
  if (thinking !== undefined && !['none', 'low', 'medium', 'high', 'extra', 'xhigh', 'max'].includes(thinking)) {
    unsupported('Unsupported thinking effort.');
  }
  const turns = textTurnsOnly(body);
  return { model, thinking, prompt: turns.length === 1 && turns[0].role === 'user' ? turns[0].content :
    'Continue the following conversation as the assistant. Ordered text messages (JSON):\n' + JSON.stringify(turns) };
}

/**
 * Errors the plugin itself raises, whose message is safe to show the caller.
 * Everything else comes from the transport contract, which deliberately
 * exposes stable codes and status only — never a binary path, subprocess
 * stderr, a prompt or a credential value.
 */
const OWN_CODES = new Set(['agy_tools_unsupported', 'agy_invalid_delta', 'agy_output_limit']);

function safeFailure(error) {
  const code = typeof error?.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(error.code)
    ? error.code : 'agy_transport_error';
  const status = error?.statusCode;
  const safe = failure(code, Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502);
  if (OWN_CODES.has(safe.code) && typeof error?.message === 'string' && error.message && error.message !== safe.code) {
    safe.message = error.message;
  }
  return safe;
}

function finishReason(stopReason) {
  switch (stopReason) {
    case 'end_turn': return 'stop';
    case 'max_tokens': case 'max_turn_requests': return 'length';
    case 'refusal': return 'content_filter';
    case 'cancelled': throw failure('agy_cancelled', 499);
    default: throw failure('agy_unknown_stop_reason', 502);
  }
}

function clientCancellation(req, config) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const raw = req?.raw;
  const socket = raw?.socket;
  // IncomingMessage 'close' also fires after a *successful* request upload.
  raw?.on?.('aborted', abort);
  socket?.on?.('close', abort);
  const signals = [req?.signal, config?.signal].filter(s => s instanceof AbortSignal);
  for (const signal of signals) signal.addEventListener('abort', abort, { once: true });
  if (raw?.aborted || socket?.destroyed || signals.some(s => s.aborted)) abort();
  return { controller, cleanup() {
    raw?.off?.('aborted', abort);
    socket?.off?.('close', abort);
    for (const signal of signals) signal.removeEventListener('abort', abort);
  } };
}

const MAX_TEXT_BYTES = 1 << 20;
const MAX_DELTAS = 8192;
// The caller is told about at most as many calls as the bridge will park. Using
// the bridge's own constant is what guarantees that: a parked call the caller is
// never told about could never be answered, so the turn would hang.
const MAX_TOOL_CALLS = MAX_CALLS_PER_TURN;

export async function chatResponse(transport, prompt, stream, req, config) {
  const { controller, cleanup } = clientCancellation(req, config);
  const { signal } = controller;
  const base = { id: `chatcmpl-${randomUUID()}`, created: Math.floor(Date.now() / 1000), model: prompt.model };
  let bytes = 0;
  let deltas = 0;
  let overflow;
  // Tool calls the agent raised this turn, in arrival order.
  const calls = [];
  async function run(emit) {
    try {
      signal.throwIfAborted();
      const turn = { ...prompt, signal, onText(text) {
        signal.throwIfAborted();
        if (typeof text !== 'string') throw failure('agy_invalid_delta', 502);
        if (!text.length) return;
        bytes += Buffer.byteLength(text);
        if (bytes > MAX_TEXT_BYTES || ++deltas > MAX_DELTAS) {
          overflow = failure('agy_output_limit', 502);
          controller.abort();
          throw overflow;
        }
        emit(text);
      } };
      // Only a tool-bearing request gains the tool-call sink, so a text-only
      // request keeps its exact original transport shape.
      if (prompt.tools?.length || prompt.bridge) {
        turn.onToolCall = call => {
          if (!call || calls.length >= MAX_TOOL_CALLS) return;
          calls.push(call);
        };
      }
      const result = await transport.run(turn);
      signal.throwIfAborted();
      // The agent parked at least one call: report it instead of a finish
      // reason so the caller does not mistake an unfinished turn for an answer.
      if (result?.parked?.length && calls.length) {
        return { tool_calls: calls.map((call, index) => ({
          index, id: call.id, type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
        })) };
      }
      return { finish_reason: finishReason(result?.stopReason), usage: result.usage };
    } catch (error) {
      throw overflow ?? (signal.aborted ? failure('agy_cancelled', 499) : safeFailure(error));
    } finally {
      cleanup();
    }
  }
  if (!stream) {
    const parts = [];
    const outcome = await run(text => parts.push(text));
    if (outcome.tool_calls) {
      return Response.json({ ...base, object: 'chat.completion', choices: [{ index: 0,
        message: { role: 'assistant', content: parts.join('') || null, tool_calls: outcome.tool_calls },
        finish_reason: 'tool_calls' }] });
    }
    return Response.json({ ...base, object: 'chat.completion', usage: outcome.usage, choices: [{ index: 0,
      message: { role: 'assistant', content: parts.join('') }, finish_reason: outcome.finish_reason }] });
  }

  // Wait for text (or a successful empty completion) before publishing headers,
  // so spawn/auth/selector failures retain their HTTP status on stream requests.
  let started = false;
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(output) {
      function event(data) { output.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); }
      function chunk(delta, finish_reason = null, usage) {
        event({ ...base, object: 'chat.completion.chunk', usage, choices: [{ index: 0, delta, finish_reason }] });
      }
      function toolChunk(call, index) {
        event({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, finish_reason: null,
          delta: { tool_calls: [{ index, id: call.id, type: 'function',
            function: { name: call.function.name, arguments: call.function.arguments } }] } }] });
      }
      function begin() {
        if (started) return;
        started = true;
        chunk({ role: 'assistant' });
        resolveReady();
      }
      run(text => { begin(); chunk({ content: text }); }).then(outcome => {
        begin();
        if (outcome.tool_calls) {
          outcome.tool_calls.forEach((call, index) => toolChunk(call, index));
          chunk({}, 'tool_calls', outcome.usage);
        } else {
          chunk({}, outcome.finish_reason, outcome.usage);
        }
        output.enqueue(encoder.encode('data: [DONE]\n\n'));
        output.close();
      }).catch(error => {
        if (!started) rejectReady(error);
        if (started && (!signal.aborted || overflow)) {
          event({ error: { code: error.code, message: error.message } });
          output.close();
        } else output.error(error);
      });
    },
    cancel() { controller.abort(); },
  });
  await ready;
  return new Response(body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } });
}
