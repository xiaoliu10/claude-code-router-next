import { randomUUID } from "node:crypto";
import type { KiroAuthService } from "./auth-service";
import type { ManagedRuntime, PluginHostCapabilities } from "./core-types";
import { classifyKiroError, isKiroManaged, runtimeURL, validRegion, kiroError } from "./protocol";
import { kiroFailure } from "./transformer";

/** Own the bounded auth replay and fixed regional origin; never send the config marker. */
export function createKiroManagedRuntime(service: KiroAuthService, host: PluginHostCapabilities, transport: typeof fetch = fetch): ManagedRuntime {
  return {
    name: "kiro", isManaged: isKiroManaged, suppressDebugLog: true,
    ensureUsable: () => service.ensureUsable(), signRequest: async () => ({}),
    classifyError: status => classifyKiroError(status),
    noteUpstreamError: info => service.noteUpstreamError(info),
    async dispatchRequest({ requestBody, config, req }) {
      let credential = await service.getCredential();
      const controller = new AbortController(), abort = () => controller.abort();
      req?.raw?.on?.("aborted", abort);
      if (req?.raw?.aborted) abort();
      const timeout = Number(config.TIMEOUT);
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, 3_600_000) : 600_000), ...(config.signal instanceof AbortSignal ? [config.signal] : []), ...(req?.signal instanceof AbortSignal ? [req.signal] : [])]);
      const cleanup = () => req?.raw?.off?.("aborted", abort);
      const send = async () => {
        const region = credential.profile.split(":")[3] || credential.region;
        if (!validRegion(region)) throw kiroError("kiro_credential_invalid", 500);
        const body = { ...requestBody, ...(credential.profile ? { profileArn: credential.profile } : {}) };
        const ua = `aws-sdk-rust/1.0.0 ua/2.1 os/other lang/rust api/codewhispererstreaming#1.28.3 m/E app/AmazonQ-For-CLI md/appVersion-1.28.3-${randomUUID().replaceAll("-", "")}`;
        return transport(`${runtimeURL(region)}/generateAssistantResponse`, {
          method: "POST", redirect: "error", signal, body: JSON.stringify(body),
          headers: { Authorization: `Bearer ${credential.access}`, "Accept-Encoding": "identity", "Content-Type": "application/json", Accept: "application/vnd.amazon.eventstream", "x-amzn-codewhisperer-optout": "true", "x-amzn-kiro-agent-mode": "vibe", "amz-sdk-invocation-id": randomUUID(), "amz-sdk-request": "attempt=1; max=1", "x-amz-user-agent": ua, "User-Agent": ua },
          dispatcher: host.getSubscriptionDispatcher?.() ?? host.getDirectDispatcher(),
        } as RequestInit);
      };
      try {
        let response = await send();
        if ([401, 403].includes(response.status)) { await response.body?.cancel(); credential = await service.forceTokenRefresh(credential.id); response = await send(); }
        if (!response.ok) {
          let body = {}; try { body = await response.json(); } catch { /* Classify by status when no JSON exists. */ }
          const error = kiroFailure(response.status, body);
          await service.noteUpstreamError(classifyKiroError(error.statusCode), credential.id);
          throw error;
        }
        if (!response.body) { cleanup(); return response; }
        const headers = new Headers(response.headers);
        headers.set("x-ccr-kiro-account", credential.id);
        const reader = response.body.getReader();
        return new Response(new ReadableStream<Uint8Array>({
          async pull(ctl) { try { const next = await reader.read(); if (next.done) { cleanup(); ctl.close(); } else ctl.enqueue(next.value); } catch (e) { cleanup(); ctl.error(e); } },
          async cancel(reason) { abort(); cleanup(); await reader.cancel(reason).catch(() => {}); },
        }), { status: response.status, headers });
      } catch (e) { cleanup(); if (signal.aborted || e instanceof Error && e.name === "AbortError") throw e; if ((e as { code?: string }).code) throw e; throw kiroError("kiro_upstream_error", 502); }
    },
  };
}
