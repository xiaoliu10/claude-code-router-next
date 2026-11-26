import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api.ts";
import type { Config, ProviderHealthState, ProviderProbeTelemetry, ProviderQuotaUsage } from "../types.ts";
import { getConfiguredProxyUrl, isGlobalProxyEnabled } from "../utils/proxy.ts";

export function useProviderTelemetry(config: Config | null, isSaving: boolean) {
  const providers = config?.Providers;
  const proxyUrl = config && getConfiguredProxyUrl(config);
  const globalProxyEnabled = isGlobalProxyEnabled(config?.PROXY_GLOBAL_ENABLED);
  // ConfigProvider replaces the providers array on edit/reload. An opaque scope
  // tags reads across those changes and saves without serializing credentials.
  const scope = useMemo(() => providers && !isSaving ? {} : null,
    [providers, isSaving, proxyUrl, globalProxyEnabled]);
  const [healthStates, setHealthStates] = useState<ProviderHealthState[]>([]);
  const [quota, setQuota] = useState<{ scope: object; rows: ProviderQuotaUsage[] } | null>(null);
  const [probeTelemetry, setProbeTelemetry] = useState<ProviderProbeTelemetry[]>([]);
  const refreshTelemetryRef = useRef<() => Promise<void>>(async () => {});

  // Provider telemetry refresh loop:
  // - self-scheduling: the next 60s refresh is armed only after the previous
  //   one settled, so slow responses never overlap;
  // - single-flight with a pending flag: concurrent triggers (timer, tab
  //   visibility, manual probe) collapse into one extra refresh;
  // - health/quota are independent: one failing keeps the other's last data;
  // - paused while the page is hidden; on return, refresh immediately when the
  //   last successful fetch is older than 30 seconds.
  useLayoutEffect(() => {
    if (!scope) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;
    let pending = false;
    let lastSuccessAt = 0;
    let disposed = false;

    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (disposed || document.visibilityState !== "visible") return;
      timer = setTimeout(() => void refresh(), 60_000);
    };

    const refresh = async () => {
      if (disposed) return;
      if (inFlight) {
        pending = true;
        return;
      }
      inFlight = true;
      try {
        const [healthResult, quotaResult] = await Promise.allSettled([
          api.getProviderHealth(),
          api.getProviderQuota(),
        ]);
        if (disposed) return;
        let anySuccess = false;
        if (healthResult.status === "fulfilled") {
          setHealthStates(healthResult.value.states || []);
          setProbeTelemetry(healthResult.value.probes || []);
          anySuccess = true;
        } else {
          console.error("Failed to fetch provider health:", healthResult.reason);
        }
        if (quotaResult.status === "fulfilled") {
          setQuota({ scope, rows: quotaResult.value.quotas || [] });
          anySuccess = true;
        } else {
          // Only the gateway can confirm which credential owns a cached snapshot.
          setQuota(last => last && { ...last, rows: last.rows.filter(row => !row.stepPlan) });
          console.error("Failed to fetch provider quota:", quotaResult.reason);
        }
        if (anySuccess) lastSuccessAt = Date.now();
      } finally {
        inFlight = false;
        if (disposed) return;
        if (pending) {
          pending = false;
          void refresh();
          return;
        }
        schedule();
      }
    };

    refreshTelemetryRef.current = refresh;
    void refresh();

    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        if (Date.now() - lastSuccessAt > 30_000) {
          void refresh();
        } else {
          schedule();
        }
      } else if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      disposed = true;
      refreshTelemetryRef.current = async () => {};
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [scope]);

  // Check ownership during render, before any effect or fresh response runs.
  const rows = quota?.rows ?? [];
  const quotaUsages = quota?.scope === scope ? rows : rows.filter(row => !row.stepPlan);
  return { healthStates, quotaUsages, probeTelemetry, refreshTelemetryRef };
}
