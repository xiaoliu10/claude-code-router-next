/**
 * Caller-side tool plumbing for the Agy ACP provider.
 *
 * Extracts an OpenAI-compatible tool declaration and its results from the
 * caller's request body, and matches a follow-up request's tool results against
 * the calls the ACP agent parked earlier.
 *
 * The caller executes every tool. This module only carries names, arguments
 * and results across the two HTTP requests.
 */

const MAX_TOOL_CALLS = 32;
const MAX_ARGUMENT_BYTES = 256 * 1024;

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const item of content) {
      if (typeof item === 'string') parts.push(item);
      else if (item && typeof item === 'object' && typeof item.text === 'string') parts.push(item.text);
    }
    return parts.join('\n');
  }
  return '';
}

/** True when the caller declared at least one usable tool. */
export function declaresTools(body) {
  if (!body || typeof body !== 'object') return false;
  if (Array.isArray(body.tools) && body.tools.some(tool => typeof tool?.function?.name === 'string' && tool.function.name.trim())) return true;
  return Array.isArray(body.functions) && body.functions.some(fn => typeof fn?.name === 'string' && fn.name.trim());
}

/** Normalize a caller tool declaration into the OpenAI shape. */
export function declaredTools(body) {
  const output = [];
  const push = tool => {
    if (!tool || typeof tool !== 'object') return;
    const fn = tool.type === 'function' ? tool.function : tool;
    if (!fn || typeof fn.name !== 'string' || !fn.name.trim()) return;
    output.push({ type: 'function', function: {
      name: fn.name.trim(),
      ...(typeof fn.description === 'string' ? { description: fn.description } : {}),
      ...(fn.parameters && typeof fn.parameters === 'object' ? { parameters: fn.parameters } : {}),
    } });
  };
  if (Array.isArray(body?.tools)) body.tools.forEach(push);
  if (Array.isArray(body?.functions)) body.functions.forEach(push);
  return output.slice(0, MAX_TOOL_CALLS);
}

/** Extract tool calls the caller's assistant turn already carries. */
export function historyToolCalls(messages) {
  const output = [];
  if (!Array.isArray(messages)) return output;
  for (const message of messages) {
    if (message?.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue;
    for (const call of message.tool_calls) {
      const fn = call?.function;
      if (typeof fn?.name !== 'string' || !fn.name.trim()) continue;
      let args = {};
      if (typeof fn.arguments === 'string' && fn.arguments) {
        try {
          const parsed = JSON.parse(fn.arguments);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed;
        } catch { /* keep empty */ }
      }
      output.push({
        id: typeof call.id === 'string' && call.id ? call.id : `call_${output.length}`,
        name: fn.name.trim(),
        arguments: args,
      });
    }
  }
  return output.slice(0, MAX_TOOL_CALLS);
}

/** Extract tool results the caller returned, keyed by tool_call_id. */
export function toolResults(messages) {
  const output = new Map();
  if (!Array.isArray(messages)) return output;
  for (const message of messages) {
    if (message?.role !== 'tool' || typeof message.tool_call_id !== 'string' || !message.tool_call_id) continue;
    output.set(message.tool_call_id, {
      text: textOf(message.content).slice(0, MAX_ARGUMENT_BYTES),
      isError: message.is_error === true,
    });
  }
  return output;
}

/** True when every carried call has a matching caller result. */
export function hasCompleteResults(calls, messages) {
  if (!calls.length) return false;
  const results = toolResults(messages);
  return calls.every(call => results.has(call.id));
}

/**
 * Build the ACP prompt text for a follow-up request that carries tool results.
 * The agent is told the actions completed so it does not repeat them.
 *
 * Any message the caller sent after the tool results — typically the user's next
 * instruction — is carried too: dropping it would silently discard what the
 * caller actually asked for on this turn.
 */
export function toolResultPrompt(calls, messages) {
  const results = toolResults(messages);
  const lines = ['The following tool calls have completed. Use their results to continue; do not repeat completed actions.'];
  for (const call of calls) {
    const result = results.get(call.id);
    if (!result) continue;
    lines.push(`Tool: ${call.name}`);
    lines.push(`Arguments: ${JSON.stringify(call.arguments)}`);
    lines.push(`Result: ${result.isError ? '(error) ' : ''}${result.text}`);
    lines.push('');
  }
  // Everything after the last tool result belongs to this turn. Assistant text
  // is skipped: it is what the agent itself produced before parking.
  const lastResult = messages.reduce((found, message, index) => message?.role === 'tool' ? index : found, -1);
  if (lastResult >= 0) {
    for (const message of messages.slice(lastResult + 1)) {
      if (message?.role !== 'user' && message?.role !== 'system') continue;
      const text = textOf(message.content);
      if (text) lines.push(text);
    }
  }
  return lines.join('\n');
}
