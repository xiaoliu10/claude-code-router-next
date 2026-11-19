import { UnifiedChatRequest } from "../types/llm";
import { getProxyDispatcher } from "../services/proxy";
import { maskHeaders } from "./debug-log";
import { fetch as proxyFetch } from "undici";

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

  const fetchOptions = {
    method: "POST",
    headers: headers,
    body: JSON.stringify(request),
    signal: combinedSignal,
    // Managed subscription-plugin requests set redirect:"error" so the fixed
    // HTTPS origin can never be bounced to another host.
    ...(config.redirect ? { redirect: config.redirect } : {}),
  };

  const dispatcher = config.dispatcher ?? (config.httpsProxy ? getProxyDispatcher(config.httpsProxy) : undefined);
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
  const endpoint = url.toString();
  if (config.httpsProxy && !config.dispatcher) {
    // The npm ProxyAgent and Node's built-in fetch can speak different
    // dispatcher protocols. Pair the agent with its own fetch to retain
    // response headers (including Content-Type and Content-Encoding).
    // SAFETY: consumers use the standard Response headers, body and clone API.
    return proxyFetch(endpoint, { ...fetchOptions, headers: Object.fromEntries(headers), dispatcher }) as unknown as Promise<Response>;
  }
  return fetch(endpoint, { ...fetchOptions, dispatcher } as RequestInit);
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
