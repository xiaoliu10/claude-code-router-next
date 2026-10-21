import { UnifiedChatRequest } from "../types/llm";
import { getProxyDispatcher } from "../services/proxy";
import { maskHeaders } from "./debug-log";

export function sendUnifiedRequest(
  url: URL | string,
  request: UnifiedChatRequest,
  config: any,
  context: any,
  logger?: any
): Promise<Response> {
  const headers = new Headers({
    "Content-Type": "application/json",
  });
  if (config.headers) {
    Object.entries(config.headers).forEach(([key, value]) => {
      if (value) {
        headers.set(key, value as string);
      }
    });
  }
  let combinedSignal: AbortSignal;
  const timeoutSignal = AbortSignal.timeout(config.TIMEOUT ?? 60 * 1000 * 60);

  if (config.signal) {
    const controller = new AbortController();
    const abortHandler = () => controller.abort();
    config.signal.addEventListener("abort", abortHandler);
    timeoutSignal.addEventListener("abort", abortHandler);
    combinedSignal = controller.signal;
  } else {
    combinedSignal = timeoutSignal;
  }

  const fetchOptions: RequestInit = {
    method: "POST",
    headers: headers,
    body: JSON.stringify(request),
    signal: combinedSignal,
    // Managed WorkBuddy requests set redirect:"error" so the fixed HTTPS origin
    // can never be bounced to another host.
    ...(config.redirect ? { redirect: config.redirect } : {}),
  };

  if (config.dispatcher) {
    (fetchOptions as any).dispatcher = config.dispatcher;
  } else if (config.httpsProxy) {
    (fetchOptions as any).dispatcher = getProxyDispatcher(config.httpsProxy);
  }
  logger?.debug(
    {
      reqId: context.req.id,
      method: "POST",
      headers: maskHeaders(Object.fromEntries(headers.entries())),
      requestUrl: typeof url === "string" ? url : url.toString(),
      useProxy: redactProxyUrl(config.httpsProxy),
    },
    "final request"
  );
  return fetch(typeof url === "string" ? url : url.toString(), fetchOptions);
}

// Strip credentials from a proxy URL before it lands in logs. Returns undefined
// when no proxy is configured so the log field stays honest about direct mode.
function redactProxyUrl(proxyUrl: unknown): string | undefined {
  if (typeof proxyUrl !== "string" || !proxyUrl.trim()) return undefined;
  try {
    const parsed = new URL(proxyUrl);
    if (parsed.username || parsed.password) {
      parsed.username = "";
      parsed.password = "";
      return `${parsed.toString()} (credentials redacted)`;
    }
    return parsed.toString();
  } catch {
    return "[invalid proxy URL]";
  }
}
