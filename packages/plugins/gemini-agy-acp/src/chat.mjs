import { randomUUID } from 'node:crypto';

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

// Check the original Fastify body too: endpoint normalization can drop unknown
// roles, tool details and non-text content before the provider transformer runs.
export function textTurns(body) {
  if ((body.tools !== undefined && !(Array.isArray(body.tools) && !body.tools.length)) ||
      body.tool_choice != null || body.functions != null || body.function_call != null ||
      body.parallel_tool_calls != null || body.audio != null ||
      (body.modalities != null && !(Array.isArray(body.modalities) && body.modalities.length === 1 && body.modalities[0] === 'text'))) {
    unsupported('Tools, function calling and non-text modalities are unsupported.');
  }
  if (!Array.isArray(body.messages) || !body.messages.length) unsupported('Expected one or more messages.');
  const turns = [];
  if (body.system !== undefined) turns.push({ role: 'system', content: contentText(body.system) });
  for (const msg of body.messages) {
    if (!['system', 'user', 'assistant'].includes(msg?.role)) unsupported('Unsupported message role.');
    if (['tool_calls', 'tool_call_id', 'function_call', 'audio', 'refusal', 'thinking', 'name'].some(key => msg[key] != null)) {
      unsupported('Only unnamed text messages are supported.');
    }
    turns.push({ role: msg.role, content: contentText(msg.content) });
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
  const turns = textTurns(body);
  return { model, thinking, prompt: turns.length === 1 && turns[0].role === 'user' ? turns[0].content :
    'Continue the following conversation as the assistant. Ordered text messages (JSON):\n' + JSON.stringify(turns) };
}

function safeFailure(error) {
  // The transport contract exposes stable codes/status only. Never surface a
  // binary path, subprocess stderr, prompts or credential values in messages.
  const code = typeof error?.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(error.code)
    ? error.code : 'agy_transport_error';
  const status = error?.statusCode;
  return failure(code, Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502);
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

export async function chatResponse(transport, prompt, stream, req, config) {
  const { controller, cleanup } = clientCancellation(req, config);
  const { signal } = controller;
  const base = { id: `chatcmpl-${randomUUID()}`, created: Math.floor(Date.now() / 1000), model: prompt.model };
  let bytes = 0;
  let deltas = 0;
  let overflow;
  async function run(emit) {
    try {
      signal.throwIfAborted();
      const result = await transport.run({ ...prompt, signal, onText(text) {
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
      } });
      signal.throwIfAborted();
      return finishReason(result?.stopReason);
    } catch (error) {
      throw overflow ?? (signal.aborted ? failure('agy_cancelled', 499) : safeFailure(error));
    } finally {
      cleanup();
    }
  }
  if (!stream) {
    const parts = [];
    const finish_reason = await run(text => parts.push(text));
    return Response.json({ ...base, object: 'chat.completion', choices: [{ index: 0,
      message: { role: 'assistant', content: parts.join('') }, finish_reason }] });
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
      function chunk(delta, finish_reason = null) {
        event({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] });
      }
      function begin() {
        if (started) return;
        started = true;
        chunk({ role: 'assistant' });
        resolveReady();
      }
      run(text => { begin(); chunk({ content: text }); }).then(reason => {
        begin();
        chunk({}, reason);
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
