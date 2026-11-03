import type { ManagedRuntime, PluginHostCapabilities } from "./core-types";
import type { GrokAuthService } from "./auth-service";
import { GROK_UPSTREAM, classifyGrokError, isGrokManaged } from "./protocol";

export function createGrokManagedRuntime(service: GrokAuthService, host: PluginHostCapabilities): ManagedRuntime {
  const windows = new WeakMap<object, number>();
  return {
    name: "grok", isManaged: isGrokManaged,
    ensureUsable: () => service.ensureUsable(),
    async lockUpstream(config) {
      config.url = GROK_UPSTREAM; config.redirect = "error";
      config.dispatcher = host.getSubscriptionDispatcher?.() ?? host.getDirectDispatcher();
    },
    async signRequest({ headers, requestBody, config }) {
      const next = new Headers();
      for (const [key, value] of Object.entries(headers ?? {})) {
        if (/^(authorization|proxy-authorization|x-api-key|api-key|host|cookie|content-length|user-agent)$/i.test(key) || /^x-(grok|xai)-/i.test(key)) continue;
        next.set(key, value);
      }
      await service.signHeaders(next);
      if (requestBody?.model) next.set("x-grok-model-override", requestBody.model);
      if (requestBody && typeof requestBody === "object" && config?.grokContextWindow) windows.set(requestBody, config.grokContextWindow);
      const window = requestBody && typeof requestBody === "object" ? windows.get(requestBody) : undefined;
      if (window) next.set("x-grok-context-window", String(window));
      if (typeof requestBody?.prompt_cache_key === "string" && requestBody.prompt_cache_key) next.set("x-grok-conv-id", requestBody.prompt_cache_key);
      return Object.fromEntries(next.entries());
    },
    classifyError: status => classifyGrokError(status),
    // Secondary net for HTTP-200 hidden error envelopes (host contract types.ts).
    isErrorEnvelope: (body: unknown) => !!(body as any)?.error && (body as any)?.object !== "response",
    noteUpstreamError: info => service.noteUpstreamError(info),
    // The core owns exactly one data-plane 401 replay. No engine fetch wrapper.
    authRefresh: { forceRefresh: () => service.forceTokenRefresh() },
    suppressDebugLog: true,
  };
}
