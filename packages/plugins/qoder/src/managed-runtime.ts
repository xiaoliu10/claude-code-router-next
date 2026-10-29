import type { ManagedRuntime, PluginClassifiedError, PluginHostCapabilities } from "./core-types";
import type { QoderAuthService } from "./auth-service";
import { classifyQoderError, isQoderErrorEnvelope, isQoderManaged, qoderError, qoderSite, type QoderSiteId } from "./protocol";

/**
 * The engine folds every upstream failure into an errorResponse JSON whose
 * body carries the classification inputs (type "qoder_error", retry_after).
 * Build the client-facing classified error from that body — the host cannot
 * see headers, so the cooldown hint rides in the body (contract).
 */
async function chatFailure(response: Response): Promise<Error & Record<string, any>> {
  let body: unknown;
  try { body = await response.json(); } catch { /* unparseable bodies classify on status alone */ }
  const info = classifyQoderError(response.status, body);
  return Object.assign(new Error(info.code), {
    code: info.code, message: info.code, statusCode: info.httpStatus,
    pluginClassified: true, nonRetryable: !info.retryable,
    ...(info.cooldownMs ? { cooldownMs: info.cooldownMs } : {}),
  });
}

function classifiedInfo(error: any): PluginClassifiedError | null {
  if (!error?.pluginClassified) return null;
  return {
    code: String(error.code ?? "qoder_upstream_error"),
    message: String(error.message ?? error.code ?? "qoder_upstream_error"),
    httpStatus: Number(error.statusCode) || 502,
    ...(Number.isFinite(error.cooldownMs) ? { cooldownMs: error.cooldownMs } : {}),
  };
}

/** Preserve the real AbortError identity; sanitize every other stream failure. */
function streamError(error: unknown, aborted: boolean): Error {
  if (aborted || (error instanceof Error && error.name === "AbortError")) {
    return Object.assign(new Error(error instanceof Error ? error.message : "aborted"), { name: "AbortError" });
  }
  return qoderError("qoder_upstream_error", 502);
}

export function createQoderManagedRuntime(service: QoderAuthService, host: PluginHostCapabilities, site: QoderSiteId = "qoder", timeoutMs = 600_000): ManagedRuntime {
  const managedBy = qoderSite(site);
  return {
    // Name = site id: the core keys runtimes (and 401 bookkeeping) by it.
    name: managedBy.id, isManaged: (provider: any) => isQoderManaged(provider, managedBy.id), suppressDebugLog: true,
    ensureUsable: () => service.ensureUsable(),
    lockUpstream: async config => {
      config.url = managedBy.chatUrl; config.redirect = "error";
      config.dispatcher = host.getSubscriptionDispatcher?.() ?? host.getDirectDispatcher();
    },
    // COSY signing happens inside the vendored engine's chat(); the core's
    // header chain carries nothing provider-specific.
    signRequest: async () => ({}),
    classifyError: (status, body) => classifyQoderError(status, body),
    // Secondary net for HTTP-200 hidden error envelopes (host contract types.ts).
    isErrorEnvelope: (body: unknown) => isQoderErrorEnvelope(body),
    noteUpstreamError: info => service.noteUpstreamError(info),
    // The core owns exactly one data-plane 401 replay; the engine owns the rest.
    authRefresh: { forceRefresh: () => service.forceTokenRefresh() },
    // No core attempt(): that would send the marker credential to the SSE API.
    // The vendored engine owns one bounded chat transaction (queue wait and
    // this wrapper owns exactly one bounded 401 force-refresh/replay).
    async dispatchRequest({ requestBody, config, req }) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      const socket = req?.raw?.socket;
      req?.raw?.on?.("aborted", abort); socket?.on?.("close", abort);
      if (req?.raw?.aborted) controller.abort();
      const deadline = Number(config?.TIMEOUT ?? timeoutMs);
      const signal = AbortSignal.any([controller.signal,
        AbortSignal.timeout(Number.isFinite(deadline) && deadline > 0 ? Math.min(deadline, 3_600_000) : timeoutMs),
        ...(config?.signal instanceof AbortSignal ? [config.signal] : []),
        ...(req?.signal instanceof AbortSignal ? [req.signal] : []),
      ]);
      const cleanup = () => { req?.raw?.off?.("aborted", abort); socket?.off?.("close", abort); };
      const send = async (): Promise<Response> => service.dispatch(requestBody, signal);
      const wrap = (response: Response): Response => {
        if (!response.body) { cleanup(); return response; }
        const reader = response.body.getReader();
        return new Response(new ReadableStream<Uint8Array>({
          async pull(ctl) {
            try {
              const next = await reader.read();
              if (next.done) { cleanup(); ctl.close(); } else ctl.enqueue(next.value);
            } catch (error) {
              cleanup();
              ctl.error(streamError(error, signal.aborted));
            }
          },
          async cancel(reason) { abort(); cleanup(); await reader.cancel(reason).catch(() => {}); },
        }), { status: response.status, statusText: response.statusText, headers: response.headers });
      };
      try {
        let response = await send();
        if (response.status === 401) {
          await response.body?.cancel().catch(() => {});
          // Exactly one data-plane replay, matching the core's generic budget.
          await service.forceTokenRefresh();
          response = await send();
        }
        if (!response.ok) {
          const error = await chatFailure(response);
          const info = classifiedInfo(error);
          if (info) await service.noteUpstreamError(info).catch(() => {});
          throw error;
        }
        return wrap(response);
      } catch (error: any) {
        cleanup();
        if (signal.aborted || error?.name === "AbortError") {
          throw Object.assign(new Error(error?.message ?? "aborted"), { name: "AbortError" });
        }
        const info = classifiedInfo(error);
        if (info) await service.noteUpstreamError(info).catch(() => {});
        throw error?.pluginClassified ? error : Object.assign(qoderError("qoder_upstream_error", 502), { pluginClassified: true });
      }
    },
  };
}
