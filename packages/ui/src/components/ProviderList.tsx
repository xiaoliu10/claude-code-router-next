import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { DndProvider, useDrag, useDrop } from "react-dnd";
import { HTML5Backend } from "react-dnd-html5-backend";
import { Pencil, RefreshCw, Trash2, Network, TriangleAlert, GripVertical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { Provider, ProviderHealthState, ProviderProbeTelemetry, ProviderQuotaUsage } from "@/types";
import { formatFailureTime, isFailureStale } from "@/utils/provider-health-display";

interface ProviderListProps {
  providers: Provider[];
  healthStates?: ProviderHealthState[];
  quotaUsages?: ProviderQuotaUsage[];
  /** Latest reachability probe telemetry per provider (may be empty after restart). */
  probeTelemetry?: ProviderProbeTelemetry[];
  onEdit: (index: number) => void;
  onRemove: (index: number) => void;
  onToggle?: (index: number, enabled: boolean) => void;
  onProbe?: (providerName: string) => void;
  probingProviders?: Set<string>;
  // Global proxy URL from config (PROXY_URL)
  proxyUrl?: string;
  // Whether the global proxy switch is on (PROXY_GLOBAL_ENABLED)
  proxyGlobalEnabled?: boolean;
  // When true, enabled/proxy controls are disabled to prevent concurrent saves
  saving?: boolean;
  // Toggle per-provider proxy_enabled
  onProxyToggle?: (index: number, enabled: boolean) => void;
  /**
   * Row id per rendered provider, in the SAME order as `providers`. The list is
   * often a search-filtered subset, so only the caller can mint ids that line
   * up with the full config array (see providerDragId). Required whenever
   * reordering is enabled: a locally derived fallback would not match the ids
   * the reorder helper resolves against.
   */
  providerIds?: string[];
  /** Called with the dragged row id and the drop-target row id. */
  onReorder?: (draggedId: string, targetId: string) => void;
}

const PROVIDER_DND_TYPE = "provider-row";

interface ProviderCardProps {
  /** Row id minted by the list (see providerDragId); shared by both drag ends. */
  dragId: string;
  onReorder?: (draggedId: string, targetId: string) => void;
  saving?: boolean;
  children: React.ReactNode;
}

function ProviderCard({ dragId, onReorder, saving, children }: ProviderCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  // Both ends of the drag resolve through the same id, so a row is addressable
  // whether or not it has a name (see providerDragId).
  const [{ isOver }, drop] = useDrop({
    accept: PROVIDER_DND_TYPE,
    drop: (item: { id: string }) => onReorder?.(item.id, dragId),
    collect: (monitor) => ({ isOver: monitor.isOver({ shallow: true }) }),
  });
  const [{ isDragging }, drag] = useDrag({
    type: PROVIDER_DND_TYPE,
    item: { id: dragId },
    canDrag: !!onReorder && !saving,
    collect: (monitor) => ({ isDragging: monitor.isDragging() }),
  });
  drag(drop(ref));
  return (
    <div
      ref={ref}
      className={`transition-opacity ${onReorder ? "cursor-grab active:cursor-grabbing" : ""} ${isOver ? "ring-2 ring-primary/60 rounded-2xl" : ""} ${isDragging ? "opacity-40" : ""}`}
    >
      {children}
    </div>
  );
}

// Get health status for a provider
function getProviderHealth(providerName: string, healthStates?: ProviderHealthState[]): {
  status: 'closed' | 'open' | 'half-open' | 'unknown';
  hasFailure: boolean;
  lastError?: string;
  /** Epoch ms of the newest failure across the worst-state models; undefined when healthy. */
  lastFailureTime?: number;
} {
  if (!healthStates || healthStates.length === 0) {
    return { status: 'closed', hasFailure: false }; // No failures recorded = healthy
  }
  // Find all health states for this provider
  const providerStates = healthStates.filter(s => s.provider === providerName);

  if (providerStates.length === 0) {
    return { status: 'closed', hasFailure: false }; // No failures = healthy
  }

  // Check if any model is in open or half-open state
  const openStates = providerStates.filter(s => s.status === 'open');
  const halfOpenStates = providerStates.filter(s => s.status === 'half-open');

  // Check if any model is in open or half-open state. Failures that a later
  // success already recovered (stale residue) don't count: failure states are
  // never auto-cleared server-side, so without this filter an old red badge
  // and error banner would stick to the card forever.
  const activeOpenStates = openStates.filter(s => !isFailureStale(s));
  const activeHalfOpenStates = halfOpenStates.filter(s => !isFailureStale(s));

  if (activeOpenStates.length > 0) {
    return {
      status: 'open',
      hasFailure: true,
      lastError: activeOpenStates[0].lastError,
      // Newest stamp across the circuit-open models — the banner answers
      // "when did this provider last fail", not "which model failed first".
      lastFailureTime: Math.max(...activeOpenStates.map(s => s.lastFailureTime ?? 0)) || undefined,
    };
  }

  if (activeHalfOpenStates.length > 0) {
    return {
      status: 'half-open',
      hasFailure: true,
      lastError: activeHalfOpenStates[0].lastError,
      lastFailureTime: Math.max(...activeHalfOpenStates.map(s => s.lastFailureTime ?? 0)) || undefined,
    };
  }

  // All models are in closed state, or every recorded failure has since been
  // followed by a success (recovered) — the card returns to its normal state.
  return { status: 'closed', hasFailure: false };
}

// Combined card status derived from the circuit breaker (model level) and
// the latest reachability probe (provider level). Exported for unit testing.
export type ProviderCardLevel =
  | "disabled"
  | "failed"
  | "recovering"
  | "unreachable"
  | "slow"
  | "healthy";

export interface ProviderCardStatus {
  level: ProviderCardLevel;
  latencyMs?: number;
}

export function deriveProviderCardStatus(
  isEnabled: boolean,
  health: { status: "closed" | "open" | "half-open" | "unknown" },
  probe?: ProviderProbeTelemetry
): ProviderCardStatus {
  if (!isEnabled) return { level: "disabled" };
  // Circuit breaker states win: they reflect real request failures.
  if (health.status === "open") return { level: "failed" };
  if (health.status === "half-open") return { level: "recovering" };
  if (!probe) return { level: "healthy" };
  // Breaker healthy but the latest connectivity probe could not reach the
  // provider (timeout/network/http error).
  if (probe.status === "timeout" || probe.status === "error") {
    return { level: "unreachable", latencyMs: probe.latencyMs };
  }
  // Reachable but slow — warn without treating the provider as failed.
  if (probe.isSlow) return { level: "slow", latencyMs: probe.latencyMs };
  return { level: "healthy" };
}

// Health indicator component
function HealthIndicator({
  level,
  latencyMs,
  t,
}: {
  level: ProviderCardLevel;
  latencyMs?: number;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const dotColors: Record<ProviderCardLevel, string> = {
    healthy: "bg-green-500",
    failed: "bg-red-500",
    unreachable: "bg-red-500",
    recovering: "bg-yellow-500",
    slow: "bg-yellow-500",
    disabled: "bg-gray-400",
  };

  const labels: Record<ProviderCardLevel, string> = {
    healthy: t("providers.health_healthy"),
    failed: t("providers.health_failed"),
    unreachable: t("providers.health_unreachable"),
    recovering: t("providers.health_recovering"),
    slow: t("providers.health_slow", { latency: latencyMs ?? "?" }),
    disabled: t("providers.health_unknown"),
  };

  const showSlowIcon = level === "slow";

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center gap-1 cursor-default">
            {showSlowIcon ? (
              <TriangleAlert className="w-3.5 h-3.5 text-yellow-500" />
            ) : (
              <div className={`w-3 h-3 rounded-full ${dotColors[level]} animate-pulse`} />
            )}
            <span className="text-xs text-gray-500">{labels[level]}</span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs text-xs">
          {level === "slow" || level === "unreachable"
            ? t("providers.health_probe_tooltip")
            : labels[level]}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// Helper to format reset time ISO string into a local readable time
function formatResetTime(resetTimeStr: string): string {
  try {
    const date = new Date(resetTimeStr);
    if (isNaN(date.getTime())) return resetTimeStr;
    
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();
    
    const pad = (n: number) => String(n).padStart(2, '0');
    const hours = pad(date.getHours());
    const minutes = pad(date.getMinutes());
    
    if (isToday) {
      return `${hours}:${minutes}`;
    } else {
      const month = pad(date.getMonth() + 1);
      const day = pad(date.getDate());
      return `${month}-${day} ${hours}:${minutes}`;
    }
  } catch (e) {
    return resetTimeStr;
  }
}

// Quota progress bar component
function QuotaProgressBar({
  label,
  used,
  limit,
  resetTime,
  isBalance,
  currency,
  t,
}: {
  label: string;
  used: number;
  limit?: number;
  resetTime?: string;
  isBalance?: boolean;
  currency?: string;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  if (limit === undefined) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground/80">
        <span className="w-12 shrink-0 font-medium">{label}</span>
        <div className="flex-1 h-2 bg-white/5 rounded-full overflow-hidden">
          <div className="h-full rounded-full bg-white/5 w-0" />
        </div>
        <span className="shrink-0 min-w-[70px] text-right text-muted-foreground/40 tabular-nums">
          {t("providers.quota_no_data", { defaultValue: "--" })}
        </span>
      </div>
    );
  }

  if (!isBalance && limit <= 0) {
    return null;
  }

  if (isBalance) {
    const symbol = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : '';
    const balance = limit - used;

    let barColor = 'bg-emerald-400';
    let textColor = 'text-emerald-600';
    if (balance < 10) {
      barColor = 'bg-red-500';
      textColor = 'text-red-600';
    } else if (balance < 50) {
      barColor = 'bg-amber-400';
      textColor = 'text-amber-600';
    }

    const progressWidth = Math.min(100, Math.max(0, (balance / 50) * 100));

    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground/80">
        <span className="w-12 shrink-0 font-medium">{label}</span>
        <div className="flex-1 space-y-0.5">
          <div className="relative h-2 rounded-full bg-white/10 overflow-hidden">
            <div
              className={`h-full rounded-full ${barColor} transition-all duration-300 shadow-[0_0_8px_rgba(var(--primary),0.3)]`}
              style={{ width: `${progressWidth}%` }}
            />
          </div>
        </div>
        <div className="flex flex-col items-end shrink-0 min-w-[70px]">
          <span className={`text-right tabular-nums font-bold ${textColor}`}>
            {symbol}{balance.toFixed(2)}
          </span>
          {resetTime && (
            <span className="text-[9px] text-muted-foreground/50 leading-none mt-0.5">
              {t("providers.quota_reset", { time: formatResetTime(resetTime) })}
            </span>
          )}
        </div>
      </div>
    );
  }

  const percentage = Math.min(100, (used / limit) * 100);
  const barWidth = Math.max(2, percentage);

  // Determine bar and text color based on percentage
  let barColor = 'bg-emerald-500';
  let textColor = 'text-emerald-500';
  if (percentage >= 90) { barColor = 'bg-red-500'; textColor = 'text-red-500'; }
  else if (percentage >= 70) { barColor = 'bg-amber-500'; textColor = 'text-amber-500'; }
  else if (percentage >= 40) { barColor = 'bg-primary'; textColor = 'text-primary'; }

  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground/80">
      <span className="w-12 shrink-0 font-medium">{label}</span>
      <div className="flex-1 h-2 bg-white/10 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full ${barColor} transition-all duration-300 shadow-sm`}
          style={{ width: `${barWidth}%` }}
        />
      </div>
      <div className="flex flex-col items-end shrink-0 min-w-[70px]">
        <span className={`text-right tabular-nums font-bold ${textColor}`}>
          {`${percentage.toFixed(1)}%`}
        </span>
        {resetTime && (
          <span className="text-[9px] text-muted-foreground/50 leading-none mt-0.5">
            {t("providers.quota_reset", { time: formatResetTime(resetTime) })}
          </span>
        )}
      </div>
    </div>
  );
}

export function ProviderList({ providers, providerIds, healthStates, quotaUsages, probeTelemetry, onEdit, onRemove, onToggle, onProbe, probingProviders, proxyUrl, proxyGlobalEnabled, saving, onProxyToggle, onReorder }: ProviderListProps) {
  const { t } = useTranslation();
  const dragEnabled = !!onReorder;

  // Derive proxy state once for all cards
  const hasProxyUrl = (proxyUrl || "").trim() !== "";
  const globalEnabled = proxyGlobalEnabled !== false;
  const proxyEffective = globalEnabled && hasProxyUrl;

  if (!providers || !Array.isArray(providers)) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-center rounded-2xl border border-white/10 bg-white/5 p-12 text-muted-foreground animate-in">
          No providers configured
        </div>
      </div>
    );
  }

  const cards = providers.map((provider, index) => {
        if (!provider) return null;

        const providerName = provider.name || "Unnamed Provider";
        // Keys and drag ids share one identity: the row id minted against the
        // full array. Two unnamed providers would otherwise both key as the
        // display string "Unnamed Provider" and React would reuse the wrong DOM.
        // Without ids (reordering disabled) the index is a valid React key and
        // is never used as a drag id, because canDrag requires onReorder.
        const rowId = providerIds?.[index] ?? `__row_${index}`;
        const apiBaseUrl = provider.api_base_url || "No API URL";
        const models = Array.isArray(provider.models) ? provider.models : [];
        const health = getProviderHealth(providerName, healthStates);
        const quota = quotaUsages?.find(q => q.provider === providerName);
        const probe = probeTelemetry?.find(p => p.provider === providerName);
        const isProbing = probingProviders?.has(providerName) || false;
        const isEnabled = provider.enabled !== false;
        const cardStatus = deriveProviderCardStatus(isEnabled, health, probe);

        return (
          <ProviderCard key={rowId} dragId={rowId} onReorder={onReorder} saving={saving}>
          <div className="flex items-start justify-between rounded-2xl border border-white/10 bg-white/5 p-5 transition-all hover:bg-white/10 hover:border-primary/30 group animate-in shadow-lg shadow-black/5 glass-card">
            {dragEnabled && (
              <div
                className="mr-2 -ml-1 flex h-full cursor-grab items-center self-stretch text-muted-foreground/30 transition-colors hover:text-muted-foreground active:cursor-grabbing"
                title={t("providers.drag_hint", { defaultValue: "Drag to reorder" })}
              >
                <GripVertical className="h-4 w-4" />
              </div>
            )}
            <div className="flex-1 space-y-3">
                <div className="flex flex-col gap-1">
                  <p className="text-lg font-bold tracking-tight text-foreground">{providerName}</p>
                  <p className="text-xs font-medium text-muted-foreground/60 truncate max-w-md">{apiBaseUrl}</p>
                </div>
              
              {health.lastError && (
                <div className="p-2 px-3 bg-red-500/10 border border-red-500/20 rounded-lg text-[11px] text-red-500 font-medium max-w-md">
                  {health.lastFailureTime ? (
                    <div className="opacity-80 mb-0.5">
                      {t("providers.last_failure_at", { time: formatFailureTime(health.lastFailureTime) })}
                    </div>
                  ) : null}
                  <div className="truncate">{health.lastError}</div>
                </div>
              )}

              {/* Slow-network warning: reachable but the connectivity probe took
                  longer than the configured threshold. Informational only — it
                  does not affect routing or the circuit breaker. */}
              {cardStatus.level === "slow" && (
                <div className="flex items-center gap-1.5 p-2 px-3 bg-yellow-500/10 border border-yellow-500/25 rounded-lg text-[11px] text-yellow-600 font-medium max-w-md">
                  <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">
                    {t("providers.slow_network_warning", { latency: cardStatus.latencyMs ?? "?" })}
                  </span>
                </div>
              )}

              {cardStatus.level === "unreachable" && probe?.errorMessage && (
                <div className="p-2 px-3 bg-red-500/10 border border-red-500/20 rounded-lg text-[11px] text-red-500 font-medium truncate max-w-md">
                  {t("providers.unreachable_warning", { error: probe.errorMessage })}
                </div>
              )}
              
              {quota && (quota.used5h > 0 || quota.used7d > 0 || quota.limit5h !== undefined || quota.limit7d !== undefined) && (
                <div className="space-y-2 py-1 max-w-md">
                  <QuotaProgressBar
                    label={quota.type5h === 'balance' ? t("providers.quota_balance") : t("providers.quota_5h")}
                    used={quota.used5h}
                    limit={quota.limit5h}
                    resetTime={quota.limit5h ? quota.reset5h : undefined}
                    isBalance={quota.type5h === 'balance'}
                    currency={quota.currency}
                    t={t}
                  />
                  <QuotaProgressBar
                    label={quota.type7d === 'balance' ? t("providers.quota_balance") : t("providers.quota_7d")}
                    used={quota.used7d}
                    limit={quota.limit7d}
                    resetTime={quota.limit7d ? quota.reset7d : undefined}
                    isBalance={quota.type7d === 'balance'}
                    currency={quota.currency}
                    t={t}
                  />
                </div>
              )}
              
              <div className="flex flex-wrap gap-2 pt-1">
                {models.map((model, modelIndex) => (
                  <Badge key={modelIndex} variant="secondary" className="px-2 py-0.5 rounded-lg bg-white/5 border-white/5 text-[10px] font-bold text-muted-foreground group-hover:text-foreground transition-colors">
                    {model || "Unnamed Model"}
                  </Badge>
                ))}
              </div>
            </div>
            
            <div className="ml-4 flex w-[200px] shrink-0 flex-col items-end gap-3">
              <div className="flex items-center justify-end gap-1.5 flex-wrap">
                {/* Proxy toggle button */}
                {(() => {
                  const proxySelected = provider.proxy_enabled === true;
                  const proxyDisabled = !hasProxyUrl || proxyEffective || saving;
                  // Determine tooltip text based on state
                  let proxyTooltip: string;
                  if (!hasProxyUrl) {
                    proxyTooltip = t("providers.proxy_tooltip_no_url");
                  } else if (proxyEffective) {
                    proxyTooltip = t("providers.proxy_tooltip_global");
                  } else if (proxySelected) {
                    proxyTooltip = t("providers.proxy_tooltip_on");
                  } else {
                    proxyTooltip = t("providers.proxy_tooltip_off");
                  }
                  // Variant: highlighted when effective or selected; ghost otherwise
                  const proxyVariant = proxyEffective || proxySelected ? "secondary" : "ghost";
                  const proxyActiveClass = proxyEffective
                    ? "bg-blue-500/20 text-blue-600 border-blue-500/30"
                    : proxySelected
                      ? "bg-emerald-500/20 text-emerald-600 border-emerald-500/30"
                      : "";
                  return (
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="inline-flex" tabIndex={proxyDisabled ? 0 : undefined}>
                            <Button
                              variant={proxyVariant}
                              size="sm"
                              className={`h-8 px-2 text-xs gap-1 rounded-lg ${proxyActiveClass}`}
                              disabled={proxyDisabled}
                              aria-pressed={proxyEffective || proxySelected}
                              onClick={() => onProxyToggle?.(index, !proxySelected)}
                            >
                              <Network className="h-3.5 w-3.5" />
                              {t("providers.proxy")}
                            </Button>
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-xs text-xs">
                          {proxyTooltip}
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  );
                })()}
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => onProbe?.(providerName)}
                  disabled={!isEnabled || isProbing}
                  className="h-8 w-8 rounded-lg hover:bg-emerald-500/15 hover:text-emerald-600 disabled:opacity-40"
                  title={t("providers.probe_provider", { defaultValue: "Refresh provider" })}
                >
                  <RefreshCw className={`h-4 w-4 ${isProbing ? "animate-spin" : ""}`} />
                </Button>
                <span className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider">
                  {isEnabled ? t("providers.enabled", { defaultValue: "Active" }) : t("providers.disabled", { defaultValue: "Disabled" })}
                </span>
                <Switch
                  checked={isEnabled}
                  onCheckedChange={(checked) => onToggle?.(index, checked)}
                  disabled={saving}
                />
              </div>
              <HealthIndicator level={cardStatus.level} latencyMs={cardStatus.latencyMs} t={t} />
              <div className="grid grid-cols-2 gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => onEdit(index)}
                  className="h-8 w-8 rounded-lg hover:bg-primary/20 hover:text-primary"
                  title={t("common.edit", { defaultValue: "Edit" })}
                >
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  variant="destructive"
                  size="icon"
                  onClick={() => onRemove(index)}
                  disabled={saving}
                  className="h-8 w-8 rounded-lg opacity-80 hover:opacity-100"
                  title={t("common.delete", { defaultValue: "Delete" })}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
          </ProviderCard>
        );
      });

  return dragEnabled ? (
    <DndProvider backend={HTML5Backend}>
      <div className="space-y-4">{cards}</div>
    </DndProvider>
  ) : (
    <div className="space-y-4">{cards}</div>
  );
}
