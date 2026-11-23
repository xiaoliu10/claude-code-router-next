import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { chatResponse, failure, textTurns, textTurnsOnly, toPrompt } from './chat.mjs';
import { AgyToolBridge } from './agy-tool-bridge.mjs';
import { declaresTools, declaredTools, hasCompleteResults, historyToolCalls, toolResultPrompt, toolResults } from './agy-tools.mjs';

const NAME = 'gemini-agy-acp';
const MARKER = `ccr-managed-${NAME}`;

async function readSettings(configDir) {
  let settings;
  try {
    settings = JSON.parse(await readFile(join(configDir, `${NAME}.json`), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw failure('agy_config_invalid', 503);
  }
  if (settings?.enabled !== true) return null;
  // Two workers by default, matching the transport: a parked tool call holds its
  // worker warm, so a single worker would make a second conversation tear down
  // the first one's parked call.
  const { binary, authMethod, timeoutMs = 60000, maxWorkers = 2 } = settings;
  if (typeof binary !== 'string' || !isAbsolute(binary) || binary.includes('\0') || authMethod !== 'gemini-api-key' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000 ||
      !Number.isSafeInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 8) {
    throw failure('agy_config_invalid', 503);
  }
  return { binary, authMethod, timeoutMs, maxWorkers };
}

function assertProvider(provider) {
  if (provider?.name !== NAME || provider.apiKey !== MARKER || provider.enabled === false) {
    throw failure('agy_provider_config_invalid', 503);
  }
}

/**
 * Carry the caller's tools, and on a follow-up request its results, into the
 * transport.
 *
 * The plugin owns the MCP bridge. It starts before the turn so the agent can
 * discover the tools, and stays open while a call is parked, so a follow-up
 * request reuses the same bridge and resolves the parked call from the
 * caller's result.
 */
function withToolResults(transport, tools, answered, parkedIds) {
  // A resume turn reuses the bridge that parked exactly these calls. Matching
  // on the ids keeps two interleaved conversations from stealing each other's
  // bridge — and with it each other's ACP session.
  const bridge = transport.toolBridge?.(parkedIds) ?? new AgyToolBridge(tools, () => new Promise(() => {}));
  return {
    async run(request) {
      if (bridge.empty) {
        // Nothing representable: tell the caller instead of silently answering
        // as if the agent had simply chosen not to use a tool.
        await bridge.close();
        throw failure('agy_tools_unsupported', 400,
          `This Agy ACP agent cannot serve the requested tools (${bridge.omitted.map(entry => entry.reason).join(', ') || 'none projected'}).`);
      }
      if (!answered) await bridge.start();
      try {
        if (answered) {
          // Deliver the caller's results into the still-parked MCP requests.
          for (const [id, answer] of bridge.pending) {
            bridge.pending.delete(id);
            answer(answered.get(id) ?? { content: [{ type: 'text', text: 'The caller did not return a result for this tool call' }], isError: true });
          }
        }
        const result = await transport.run({ ...request, bridge, ...(answered ? { resume: true } : {}) });
        return result;
      } finally {
        // A bridge with nothing parked has served its purpose; leaving it
        // listening would keep the process alive and expose a needless port.
        if (bridge.pending.size === 0) await bridge.close();
      }
    },
  };
}

export async function activateWithTransport(ctx, createTransport) {
  let transport;
  let unavailable;
  try {
    const settings = await readSettings(ctx.host.configDir);
    if (settings) transport = await createTransport(settings);
  } catch {
    unavailable = failure('agy_config_invalid', 503);
  }
  function requireTransport() {
    if (!transport) throw unavailable ?? failure('agy_disabled', 503);
    return transport;
  }

  class AgyTransformer {
    static TransformerName = NAME;
    name = NAME;

    transformRequestIn(body, provider, context) {
      if (provider?.name === NAME && context?.req) context.req.enableFallback = false;
      assertProvider(provider);
      requireTransport();
      if (context?.req?.body) {
        // A tool-bearing request is served by the runtime's tool path, which
        // does its own validation; only a text-only request is rejected here.
        if (declaresTools(context.req.body)) textTurnsOnly(context.req.body);
        else textTurns(context.req.body);
      }
      return { body };
    }
  }
  ctx.registerTransformer(AgyTransformer);
  // Read-only management card; the UI renders a hard failure for enabled
  // plugins that ship none, so this prototype must always declare one.
  ctx.registerUiCard?.({ cardPath: 'card.js' });
  ctx.registerManagedRuntime({
    name: NAME,
    // Claim this exact reserved name even on a malformed entry, so it fails
    // closed instead of taking the ordinary OpenAI HTTP path.
    isManaged: provider => provider?.name === NAME,
    suppressDebugLog: true,
    async signRequest() { throw failure('agy_http_disabled', 503); },
    async probeAccountState() { return { available: false, reason: 'agy_probe_disabled' }; },
    async probeLiveness() { return new Response(null, { status: 503 }); },
    async dispatchRequest({ requestBody, req, config, provider }) {
      if (req) req.enableFallback = false;
      assertProvider(provider);
      const local = requireTransport();
      const tools = declaresTools(requestBody) ? declaredTools(requestBody) : [];
      if (!tools.length) {
        if (req?.body) textTurns(req.body);
        return chatResponse(local, toPrompt(requestBody, provider, req?.body), requestBody.stream === true, req, config);
      }
      // Tool path: the agent raises calls through the bridge and the caller
      // executes them. A follow-up request that answers every carried call
      // resumes the same ACP turn instead of starting a new one.
      const calls = historyToolCalls(requestBody?.messages);
      const answered = toolResults(requestBody?.messages);
      const resuming = hasCompleteResults(calls, requestBody?.messages);
      let prompt;
      // Only a bridge this pool is still holding is a resume. "The history
      // contains complete tool results" is not enough: a third turn of a tool
      // conversation also matches, and treating it as a resume would start a
      // fresh ACP session that has lost all real context and replays a growing
      // recap of every completed call on every turn.
      const held = resuming ? local.toolBridge?.(calls.map(call => call.id)) : undefined;
      const resumingTurn = !!held;
      let model = requestBody?.model;
      if (resumingTurn) {
        prompt = toolResultPrompt(calls, requestBody?.messages);
      } else {
        const base = toPrompt(requestBody, provider, req?.body);
        prompt = base.prompt;
        model = base.model;
      }
      try {
        return await chatResponse(withToolResults(local, tools, resumingTurn ? answered : undefined, resumingTurn ? calls.map(call => call.id) : []),
          { model, prompt, tools }, requestBody.stream === true, req, config);
      } catch (error) {
        // A tool set the agent cannot serve is a caller-visible rejection, not a
        // transport failure: the caller chose a model that cannot run its tools.
        if (error?.code === 'agy_tools_unsupported') {
          return new Response(JSON.stringify({ error: { type: error.code, code: error.code, message: error.message } }),
            { status: 400, headers: { 'content-type': 'application/json' } });
        }
        throw error;
      }
    },
  });
}

export function activate(ctx) {
  // Loading and installing this prototype alone cannot start a subprocess.
  return activateWithTransport(ctx, async options => (await import('./transport.mjs')).createTransport(options));
}
