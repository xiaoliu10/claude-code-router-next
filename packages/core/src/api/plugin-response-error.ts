import type { ManagedRuntime, PluginClassifiedError } from "../provider-plugins/types";
import { pluginErrorFrom } from "../provider-plugins/registry";

/** Bounded, safe transport diagnostics for a send-level (status 0) failure. */
export interface PluginTransportFailure {
  errorName?: string;
  /** Enum-like OS/undici connect code, e.g. ECONNREFUSED, ENOTFOUND, UND_ERR_CONNECT_TIMEOUT. */
  causeCode?: string;
  /** Own-config endpoint the connect failed on (address:port or hostname) — never upstream text. */
  causeDetail?: string;
}

/**
 * Extract bounded transport diagnostics from a thrown send-level error. Node's
 * fetch failures are `TypeError("fetch failed")` with a `cause` chain that
 * carries errno-style fields (code/address/port/hostname). Only enum-like codes
 * and endpoint atoms the core actually dialed survive sanitization — never
 * error messages or URLs. The dialed endpoint normally comes from provider
 * config, but a redirect-following dispatcher may have been pointed there by
 * an upstream 3xx; the strict charset/length caps keep the result safe to
 * embed in a client-visible message regardless.
 */
export function describeTransportFailure(error: unknown): PluginTransportFailure {
  if (!error || typeof error !== "object") return {};
  const out: PluginTransportFailure = {};
  // Every property read below is wrapped: a hostile error with a throwing
  // getter (name, cause, or any chain node's fields) must not replace the
  // classified plugin error with a raw throw at the routes.ts call site.
  let name: unknown;
  try { name = (error as any)?.name; } catch { /* unreadable */ }
  if (typeof name === "string" && /^[A-Za-z]{1,40}$/.test(name)) out.errorName = name;
  // The errno-shaped fields may sit on `cause` itself or one level deeper
  // (undici wraps connect failures in its own error objects).
  let node: any;
  try { node = (error as any)?.cause; } catch { node = undefined; }
  for (let depth = 0; node && typeof node === "object" && depth < 3; depth++) {
    try {
      const code = node.code;
      if (!out.causeCode && typeof code === "string" && /^[A-Z][A-Z0-9_]{1,40}$/.test(code)) {
        out.causeCode = code;
      }
      if (!out.causeDetail) {
        const address = typeof node.address === "string" ? node.address : "";
        const port = typeof node.port === "number" && Number.isInteger(node.port) && node.port > 0 && node.port <= 65535 ? node.port : undefined;
        if (address && /^[0-9A-Za-z.:%\[\]-]{1,60}$/.test(address)) {
          out.causeDetail = port !== undefined ? `${address}:${port}` : address;
        } else if (typeof node.hostname === "string" && /^[0-9A-Za-z.-]{1,120}$/.test(node.hostname)) {
          out.causeDetail = node.hostname;
        }
      }
    } catch { /* unreadable cause node — skip to the next link */ }
    if (out.causeCode && out.causeDetail) break;
    try { node = node?.cause; } catch { break; }
  }
  return out;
}

/** No unclassified plugin response or read exception may reach rawBody/logging. */
export async function pluginResponseError(
  runtime: ManagedRuntime,
  status: number,
  body: unknown,
  systemText: string,
  transport?: PluginTransportFailure,
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
  } : status === 0 ? networkFailureInfo(transport) : {
    code, message: "Provider plugin returned an invalid upstream response.",
    httpStatus: status >= 400 && status <= 599 ? status : 502,
    retryable: status >= 500,
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

/**
 * Client-safe classification for a send-level failure (no HTTP response at
 * all). The old fallback called this an "invalid upstream response" — but
 * there IS no upstream response; the usual cause is the subscription proxy
 * refusing or dropping the connection, which reads as an upstream defect and
 * misdirects diagnosis. The composed message carries only enum-like OS codes
 * and the own-config endpoint (e.g. ECONNREFUSED 127.0.0.1:7897), so the
 * proxy-vs-upstream distinction is visible without leaking any raw text.
 */
function networkFailureInfo(transport?: PluginTransportFailure): PluginClassifiedError {
  const detail = [transport?.causeCode, transport?.causeDetail].filter(Boolean).join(" ");
  const message = detail
    ? `Provider plugin network failure (${detail}).`
    : transport?.errorName
      ? `Provider plugin network failure (${transport.errorName}).`
      : "Provider plugin network failure.";
  return {
    code: "plugin_network_error",
    message,
    httpStatus: 502,
    retryable: true,
  };
}
