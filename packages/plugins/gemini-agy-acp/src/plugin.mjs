import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { chatResponse, failure, textTurns, toPrompt } from './chat.mjs';

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
  const { binary, authMethod, timeoutMs = 60000, maxWorkers = 1 } = settings;
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
      if (context?.req?.body) textTurns(context.req.body);
      return { body };
    }
  }
  ctx.registerTransformer(AgyTransformer);
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
      if (req?.body) textTurns(req.body);
      return chatResponse(local, toPrompt(requestBody, provider, req?.body), requestBody.stream === true, req, config);
    },
  });
}

export function activate(ctx) {
  // Loading and installing this prototype alone cannot start a subprocess.
  return activateWithTransport(ctx, async options => (await import('./transport.mjs')).createTransport(options));
}
