import type { ManagedRuntime, PluginClassifiedError } from "../provider-plugins/types";
import { pluginErrorFrom } from "../provider-plugins/registry";

/** No unclassified plugin response or read exception may reach rawBody/logging. */
export async function pluginResponseError(
  runtime: ManagedRuntime,
  status: number,
  body: unknown,
  systemText: string,
  transport?: { errorName?: string },
): Promise<Error & Record<string, any>> {
  let classified: PluginClassifiedError | null | undefined;
  try { classified = runtime.classifyError?.(status, body, systemText); } catch { /* safe fallback */ }
  const code = classified && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(classified.code)
    ? classified.code : "plugin_upstream_error";
  const info: PluginClassifiedError = classified ? {
    ...classified,
    code,
    // The plugin receives the original body for classification, but the core
    // never trusts an arbitrary upstream sentence as client-visible text.
    message: `Provider plugin request failed (${code}).`,
  } : {
    code, message: "Provider plugin returned an invalid upstream response.",
    httpStatus: status >= 400 && status <= 599 ? status : 502,
    retryable: status === 0 || status >= 500,
  };
  try { await runtime.noteUpstreamError?.(info); } catch { /* bookkeeping cannot leak/mask the safe error */ }
  const error = pluginErrorFrom(runtime.name, info);
  error.isRateLimit = info.httpStatus === 429;
  // Transport classification for dispatch wrappers: status 0 marks a
  // send-level failure (no HTTP response at all) so a wrapper can run the
  // edge-reset probe; errorName preserves the AbortError/TimeoutException
  // distinction, which client-abort semantics depend on. Classification only —
  // never the raw error message.
  error.upstreamStatus = status;
  if (transport?.errorName) error.upstreamErrorName = transport.errorName;
  return error;
}
