import type { ManagedRuntime, PluginClassifiedError, PluginDispatchInput, PluginHostCapabilities, ManagedProbeInput } from "./core-types";
import type { CursorAuthService } from "./auth-service";
import { classifyCursorError, cursorError, isCursorManaged, CURSOR_MARKER, CURSOR_PROVIDER } from "./protocol";

/**
 * The engine folds every upstream failure into an errorResponse JSON whose
 * body carries the classification inputs ({error:{message,type:"cursor_error",
 * code:<status>}}). Build the client-facing classified error from that body —
 * the taxonomy lives in protocol.ts; an upstream 401 is auth-required here
 * too, never a generic 502 and never "login invalid".
 */
async function chatFailure(response: Response): Promise<Error & Record<string, any>> {
  let body: unknown;
  try { body = await response.json(); } catch { /* unparseable bodies classify on status alone */ }
  const info = classifyCursorError(response.status, body);
  return Object.assign(new Error(info.code), {
    code: info.code, message: info.code, statusCode: info.httpStatus,
    pluginClassified: true, nonRetryable: !info.retryable,
    ...(info.cooldownMs ? { cooldownMs: info.cooldownMs } : {}),
  });
}

function classifiedInfo(error: any): PluginClassifiedError | null {
  if (!error?.pluginClassified) return null;
  return {
    code: String(error.code ?? "cursor_upstream_error"),
    message: String(error.message ?? error.code ?? "cursor_upstream_error"),
    httpStatus: Number(error.statusCode) || 502,
    ...(Number.isFinite(error.cooldownMs) ? { cooldownMs: error.cooldownMs } : {}),
  };
}

/** Preserve the real AbortError identity; sanitize every other stream failure. */
function streamError(error: unknown, aborted: boolean): Error {
  if (aborted || (error instanceof Error && error.name === "AbortError")) {
    return Object.assign(new Error(error instanceof Error ? error.message : "aborted"), { name: "AbortError" });
  }
  return cursorError("cursor_upstream_error", 502);
}

/**
 * Whether the host handed us a PROXY dispatcher for the subscription origins
 * (SUBSCRIPTION_PROXY_URL set). The host capability is typed `unknown`
 * precisely so plugins cannot depend on undici internals; the one structural
 * marker that survives that contract is the dispatcher's class name — the
 * direct lane is an Agent, the opt-in lane a ProxyAgent.
 */
export function dispatcherIsProxy(dispatcher: unknown): boolean {
  try { return (dispatcher as any)?.constructor?.name === "ProxyAgent"; } catch { return false; }
}

/**
 * Transport resolution for the vendored engine (PATCHES.md §1): the host's
 * subscription dispatcher for every engine request, and HTTP/2 disabled
 * whenever that dispatcher is a proxy — node:http2 opens direct sockets and
 * cannot traverse it, so under SUBSCRIPTION_PROXY_URL the WHOLE data plane,
 * the engine's own region retry included, goes HTTP/1.1 through the proxy.
 * Default (no proxy configured): HTTP/2 first, upstream's H1 fallback intact.
 */
export function resolveCursorTransport(host: PluginHostCapabilities, override?: unknown): { fetch: typeof fetch; h2: boolean } {
  const dispatcher = override ?? host.getSubscriptionDispatcher?.() ?? host.getDirectDispatcher();
  const proxied = dispatcherIsProxy(dispatcher);
  const fetchImpl: typeof fetch = (input: any, init?: any) => fetch(input, {
    ...init, redirect: "error", dispatcher,
  } as RequestInit);
  return { fetch: fetchImpl, h2: !proxied };
}

export function createCursorManagedRuntime(service: CursorAuthService, host: PluginHostCapabilities, timeoutMs = 600_000): ManagedRuntime {
  return {
    // Name = provider family: the core keys runtimes (and 401 bookkeeping) by it.
    name: "cursor", isManaged: (provider: any) => isCursorManaged(provider), suppressDebugLog: true,
    ensureUsable: () => service.ensureUsable(),
    lockUpstream: async config => {
      // dispatchRequest NEVER calls attempt(): the marker credential is not a
      // Cursor credential and Cursor's data plane is the engine's Connect
      // transaction, not a chat-completions POST. Pin config.url to a dead
      // local address so a stray attempt could never send the marker upstream.
      config.url = "http://127.0.0.1:9/ccr-managed-cursor";
      config.redirect = "error";
    },
    // Signing happens inside the vendored engine's answer() (headersFor +
    // team headers + the Connect proto headers); the core's header chain
    // carries nothing provider-specific.
    signRequest: async () => ({}),
    classifyError: (status, body) => classifyCursorError(status, body),
    // Secondary net for HTTP-200 hidden error envelopes (host contract types.ts).
    isErrorEnvelope: (body: unknown) => (body as any)?.error?.type === "cursor_error",
    noteUpstreamError: info => service.noteUpstreamError(info),
    // Deliberately NO authRefresh: Cursor's browser sign-in has nothing to
    // renew its token with — expiry requires re-login, and the adapter never
    // pretends otherwise. The CLI/API-key credential paths re-resolve their
    // tokens per request inside the engine.
    // The engine owns exactly one bounded chat transaction (queue wait and
    // region/max-mode retries are its own, upstream-bounded); this wrapper
    // owns abort/deadline wiring and the classified-error fold.
    async dispatchRequest({ requestBody, config, req }: PluginDispatchInput) {
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
        const response = await send();
        if (!response.ok) {
          // The engine answered an errorResponse: classify, note, throw. The
          // core's shared seam turns this into the safe client error; a 401
          // lands as cursor_reauth_required (auth-required), never a generic
          // plugin failure and never "login invalid".
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
        throw error?.pluginClassified ? error : Object.assign(cursorError("cursor_upstream_error", 502), { pluginClassified: true });
      }
    },
    // Level 1: account state without a network call (the Gemini lesson — a
    // parked account must not spend a request).
    probeAccountState: async () => service.probeAccountState(),
    // Level 2: the cheapest call that proves Cursor answers for this account
    // (GetPlanInfo unary), never a real chat turn.
    async probeLiveness({ config }: ManagedProbeInput): Promise<Response> {
      const deadline = Number(config?.TIMEOUT ?? timeoutMs);
      try {
        return await service.probeLiveness(deadline > 0 ? AbortSignal.timeout(Math.min(deadline, 60_000)) : undefined);
      } catch (e: any) {
        if (e?.name === "AbortError") throw e;
        const status = Number(e?.status) >= 400 && Number(e?.status) <= 599 ? Number(e.status) : 502;
        return Response.json({ ok: false }, { status });
      }
    },
  };
}

// Re-exported so plugin.ts and the tests share one spelling of the identities.
export { CURSOR_MARKER, CURSOR_PROVIDER };
