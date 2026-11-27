import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { partialSummary, usageTokens } from "@/utils/usageTokens";
import { api } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { BarChart3, Trash2, RefreshCw } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// Auto refresh cadence. Implemented as a serial self-scheduling loop, not a
// fixed setInterval, so the next refresh always waits for the previous one to
// settle (no overlapping /api/usage requests).
const USAGE_AUTO_REFRESH_MS = 30_000;

// Initial time range: last 7 days. Matches the "7d" quick preset. Keeping a
// bounded default prevents the 30s auto-refresh from issuing unbounded
// full-table scans against the usage database.
const DEFAULT_RANGE_HOURS = 168;

interface UsageRecord {
  id: string;
  timestamp: string;
  sessionId: string;
  provider: string;
  originalModel: string; // Original request model before routing
  model: string; // Actual routed model
  upstreamModel?: string; // Model returned by the upstream provider (may differ from routed model)
  modelFamily: string;
  scenarioType: string;
  clientType?: string; // "claude-code" | "codex" | "api" | "unknown"
  stream: boolean;
  usageEstimated?: boolean;
  inputTokens: number;
  effectiveInputTokens?: number | null;
  cacheReadInputTokens?: number | null;
  cacheCreationInputTokens?: number | null;
  outputTokens: number;
  ttft: number | null;
  tokensPerSecond: number | null;
  durationMs: number;
  status: "success" | "error";
  errorMessage?: string;
  responseBody?: string;
}

interface ModelDayData {
  count: number;
  inputTokens: number;
  effectiveInputTokens?: number | null;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

interface UsageSummary {
  estimatedCount?: number;
  totalRequests: number;
  successCount: number;
  errorCount: number;
  totalInputTokens: number;
  totalEffectiveInputTokens?: number | null;
  totalOutputTokens: number;
  totalCacheReadInputTokens: number;
  totalCacheCreationInputTokens: number;
  avgTtft: number | null;
  avgTokensPerSecond: number | null;
  byModel: Record<string, ModelDayData>;
  byProvider: Record<string, ModelDayData>;
  byScenario: Record<string, ModelDayData>;
  byFamily: Record<string, ModelDayData>;
  byDay: Record<string, ModelDayData>;
  byClient: Record<string, ModelDayData>;
}

function formatTokens(n: number | null, estimated = false): string {
  if (n === null) return "—";
  return (estimated ? "≈" : "") + compactTokens(n);
}

function compactTokens(n: number): string {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + "B";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

function formatMs(ms: number | null): string {
  if (ms == null) return "-";
  if (ms >= 1000) return (ms / 1000).toFixed(1) + "s";
  return String(Math.round(ms)) + "ms";
}

function formatSpeed(speed: number | null): string {
  if (speed == null) return "-";
  return Math.min(speed, 999) + " t/s";
}

function formatDuration(ms: number): string {
  if (ms >= 60000) return (ms / 60000).toFixed(1) + "m";
  if (ms >= 1000) return (ms / 1000).toFixed(1) + "s";
  return ms + "ms";
}

function clientDisplayName(type: string | undefined, t: (key: string) => string): string {
  switch (type || "unknown") {
    case "claude-code": return t("usage.client_claude_code");
    case "zcode": return t("usage.client_zcode");
    case "codex": return t("usage.client_codex");
    case "pi": return t("usage.client_pi");
    case "qwen-code": return t("usage.client_qwen_code");
    case "opencode": return t("usage.client_opencode");
    case "api": return t("usage.client_api");
    default: return t("usage.client_unknown");
  }
}

function formatTime(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatDateInput(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function UsageStats() {
  const { t } = useTranslation();
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [records, setRecords] = useState<UsageRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  // Guards stale responses from out-of-order fetches when filters change.
  const generationRef = useRef(0);
  // Serial refresh handle assigned by the auto-refresh effect so manual
  // triggers (refresh button, clear) coalesce with the loop instead of racing it.
  const requestRefreshRef = useRef<() => void>(() => {});

  // Filters
  // Default to the last 7 days: an unbounded query scans the whole
  // usage table synchronously on the server's event loop, which stalls every
  // other management API while the auto-refresh loop polls every 30s. Users
  // can still opt into an unbounded scan via the "All" preset.
  const [startDate, setStartDate] = useState(() =>
    formatDateInput(new Date(Date.now() - DEFAULT_RANGE_HOURS * 60 * 60 * 1000)));
  const [endDate, setEndDate] = useState(() => formatDateInput(new Date()));
  const [activeRange, setActiveRange] = useState<number | null>(DEFAULT_RANGE_HOURS);
  const [filterModel, setFilterModel] = useState("");
  const [filterProvider, setFilterProvider] = useState("");
  const [filterScenario, setFilterScenario] = useState("");
  const [filterClient, setFilterClient] = useState("");
  const [filterStatus, setFilterStatus] = useState<"success" | "error" | "">("");

  const [chartView, setChartView] = useState<"daily" | "model">("daily");
  const [loadFailed, setLoadFailed] = useState(false);
  const pageSize = 20;

  const loadData = useCallback(async () => {
    // Capture the generation so a slow response from a previous filter set
    // can't overwrite the latest data once it resolves.
    const generation = generationRef.current;
    setLoading(true);
    try {
      const params: Record<string, any> = { page, pageSize };
      if (startDate) params.startDate = new Date(startDate).toISOString();
      if (endDate) params.endDate = new Date(endDate + "T23:59:59").toISOString();
      if (filterModel) params.model = filterModel;
      if (filterProvider) params.provider = filterProvider;
      if (filterScenario) params.scenario = filterScenario;
      if (filterClient) params.clientType = filterClient;
      if (filterStatus) params.status = filterStatus;

      const result = await api.getUsage(params);
      if (generation !== generationRef.current) return;
      setLoadFailed(false);
      setRecords(result.records || []);
      setSummary(result.summary);
      setTotal(result.total);
    } catch (e) {
      if (generation === generationRef.current) setLoadFailed(true);
      console.error("Failed to load usage:", e);
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, [page, startDate, endDate, filterModel, filterProvider, filterScenario, filterClient, filterStatus]);

  // Serial, queue-style auto refresh:
  // - at most one /api/usage request in flight at a time;
  // - the next refresh is armed 30s after the previous one settles;
  // - triggers that arrive mid-flight (filter change, manual button, tab
  //   visibility) collapse into a single follow-up refresh with the latest
  //   filters — they never run concurrently with the in-flight request;
  // - paused while the tab is hidden; resumed on return.
  useEffect(() => {
    const generation = ++generationRef.current;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;
    let pending = false;
    let disposed = false;

    const isOwner = () => !disposed && generation === generationRef.current;
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (!isOwner() || document.visibilityState !== "visible") return;
      timer = setTimeout(() => void run(), USAGE_AUTO_REFRESH_MS);
    };

    const run = async () => {
      if (inFlight) {
        pending = true;
        return;
      }
      inFlight = true;
      try {
        await loadData();
      } finally {
        inFlight = false;
        if (!isOwner()) return;
        if (pending) {
          pending = false;
          void run();
          return;
        }
        schedule();
      }
    };

    requestRefreshRef.current = () => void run();
    void run();

    const handleVisibility = () => {
      if (!isOwner()) return;
      if (document.visibilityState === "visible") {
        void run();
      } else if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [loadData]);

  const handleClear = async () => {
    if (!confirm(t("usage.clear_confirm"))) return;
    try {
      await api.clearUsage();
      requestRefreshRef.current();
    } catch (e) {
      console.error("Failed to clear usage:", e);
    }
  };

  const totalPages = Math.ceil(total / pageSize);

  // Extract unique values from summary for filter dropdowns
  const models = summary ? Object.keys(summary.byModel) : [];
  const providers = summary ? Object.keys(summary.byProvider) : [];
  const scenarios = summary ? Object.keys(summary.byScenario) : [];
  const clients = summary?.byClient ? Object.keys(summary.byClient) : [];

  // Daily chart data (respect the selected date range)
  const dailyData = summary?.byDay ? Object.entries(summary.byDay)
    .sort(([a], [b]) => a.localeCompare(b))
    : [];
  // Keep a single unit within each chart when historical totals are unknown.
  const dailyUsesOutput = dailyData.some(([, d]) => usageTokens(d).total === null);
  const maxDailyTokens = Math.max(1, ...dailyData.map(([, d]) =>
    dailyUsesOutput ? d.outputTokens : usageTokens(d).total!
  ));
  const modelUsesRecorded = Object.values(summary?.byModel ?? {}).some(d => usageTokens(d).total === null);

  const modelData = Object.entries(summary?.byModel ?? {})
    .map(([model, data]) => {
      const { cacheMissInput, total } = usageTokens(data);
      return { model, data, cacheMissInput, total, chartTokens: modelUsesRecorded ? (data.cacheReadInputTokens ?? 0) + data.outputTokens : total! };
    })
    .sort((a, b) => b.chartTokens - a.chartTokens)
    .slice(0, 10);
  const maxModelTokens = Math.max(1, ...modelData.map(p => p.chartTokens));

  return (
    <TooltipProvider>
    <Card className="h-full flex flex-col overflow-hidden">
      {/* Top Toolbar: time range + filters + actions (all conditions apply to summary, chart, and table) */}
      <div className="border-b bg-gradient-to-r from-slate-50/80 via-white to-blue-50/40 px-5 py-3 flex-shrink-0">
        <div className="flex items-center gap-2.5 flex-wrap">
          {/* Quick time range presets */}
          <div className="flex items-center gap-0.5 rounded-md bg-white border border-gray-200 p-0.5 shadow-sm">
            {[24, 168, 720].map((hours) => {
              const label = hours === 24 ? "24h" : hours === 168 ? "7d" : "30d";
              const isActive = activeRange === hours;
              return (
                <button
                  key={hours}
                  type="button"
                  aria-pressed={isActive}
                  className={`h-7 px-3 text-xs font-semibold rounded border transition-colors ${
                    isActive
                      ? "border-blue-700 bg-blue-600 text-white shadow-sm ring-2 ring-blue-200 hover:bg-blue-700"
                      : "border-transparent text-gray-600 hover:bg-gray-100"
                  }`}
                  onClick={() => {
                    const now = new Date();
                    const start = new Date(now.getTime() - hours * 60 * 60 * 1000);
                    setStartDate(formatDateInput(start));
                    setEndDate(formatDateInput(now));
                    setActiveRange(hours);
                    setPage(1);
                  }}
                >
                  {label}
                </button>
              );
            })}
            <button
              type="button"
              className={`h-7 px-3 text-xs font-medium rounded transition-colors ${
                !startDate && !endDate
                  ? "bg-blue-500 text-white shadow-sm"
                  : "text-gray-600 hover:bg-gray-50"
              }`}
              onClick={() => { setStartDate(""); setEndDate(""); setActiveRange(null); setPage(1); }}
            >
              {t("usage.all")}
            </button>
          </div>

          {/* Custom date range */}
          <div className="flex items-center gap-1.5 px-2 h-8 rounded-md bg-white border border-gray-200 shadow-sm">
            <Input
              type="date"
              className="h-6 text-xs w-[120px] border-0 px-1 focus-visible:ring-0 focus-visible:ring-offset-0"
              value={startDate}
              onChange={(e) => { setStartDate(e.target.value); setActiveRange(null); setPage(1); }}
              placeholder={t("usage.start_date")}
            />
            <span className="text-xs text-gray-400 select-none">→</span>
            <Input
              type="date"
              className="h-6 text-xs w-[120px] border-0 px-1 focus-visible:ring-0 focus-visible:ring-offset-0"
              value={endDate}
              onChange={(e) => { setEndDate(e.target.value); setActiveRange(null); setPage(1); }}
              placeholder={t("usage.end_date")}
            />
          </div>

          {/* Filter dropdowns */}
          <Select value={filterProvider || "__all__"} onValueChange={(v) => { setFilterProvider(v === "__all__" ? "" : v); setPage(1); }}>
            <SelectTrigger className="h-8 text-xs w-[120px] bg-white shadow-sm">
              <SelectValue placeholder={t("usage.provider")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">{t("usage.provider")}: {t("usage.all")}</SelectItem>
              {providers.filter(Boolean).map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={filterModel || "__all__"} onValueChange={(v) => { setFilterModel(v === "__all__" ? "" : v); setPage(1); }}>
            <SelectTrigger className="h-8 text-xs w-[150px] bg-white shadow-sm">
              <SelectValue placeholder={t("usage.model")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">{t("usage.model")}: {t("usage.all")}</SelectItem>
              {models.filter(Boolean).map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={filterScenario || "__all__"} onValueChange={(v) => { setFilterScenario(v === "__all__" ? "" : v); setPage(1); }}>
            <SelectTrigger className="h-8 text-xs w-[120px] bg-white shadow-sm">
              <SelectValue placeholder={t("usage.scenario")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">{t("usage.scenario")}: {t("usage.all")}</SelectItem>
              {scenarios.filter(Boolean).map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={filterClient || "__all__"} onValueChange={(v) => { setFilterClient(v === "__all__" ? "" : v); setPage(1); }}>
            <SelectTrigger className="h-8 text-xs w-[120px] bg-white shadow-sm">
              <SelectValue placeholder={t("usage.client")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">{t("usage.client")}: {t("usage.all")}</SelectItem>
              {clients.filter(Boolean).map((c) => <SelectItem key={c} value={c}>{clientDisplayName(c, t)}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={filterStatus || "__all__"} onValueChange={(v) => { setFilterStatus(v === "__all__" ? "" : v as "success" | "error"); setPage(1); }}>
            <SelectTrigger className="h-8 text-xs w-[100px] bg-white shadow-sm">
              <SelectValue placeholder={t("usage.status")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">{t("usage.status")}: {t("usage.all")}</SelectItem>
              <SelectItem value="success">{t("usage.success")}</SelectItem>
              <SelectItem value="error">{t("usage.error")}</SelectItem>
            </SelectContent>
          </Select>

          {/* Action buttons */}
          <div className="ml-auto flex items-center gap-1">
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => requestRefreshRef.current()} disabled={loading} title={t("usage.refresh")}>
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8 text-red-400 hover:text-red-600 hover:bg-red-50" onClick={handleClear} title={t("usage.clear")}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>

      <CardContent className="flex-1 overflow-auto pt-4">
          {loadFailed && <p role="alert" className="mb-2 text-sm text-red-600">{t("usage.fetch_failed")}</p>}
          {/* Summary Cards */}
          {summary && (() => {
            const tokens = usageTokens({
              inputTokens: summary.totalInputTokens,
              effectiveInputTokens: summary.totalEffectiveInputTokens,
              cacheReadInputTokens: summary.totalCacheReadInputTokens,
              cacheCreationInputTokens: summary.totalCacheCreationInputTokens,
              outputTokens: summary.totalOutputTokens,
            });
            const estimated = (summary.estimatedCount ?? 0) > 0;
            const partial = tokens.total === null ? partialSummary(summary) : null;
            const displayedTotal = partial ? partial.total : tokens.total;
            const displayedRate = partial ? partial.hitRate : tokens.hitRate;
            const markedEstimate = partial ? partial.estimated : estimated;
            const coverage = partial && (partial.requests !== null
              ? t("usage.covered_requests", { count: partial.requests, total: summary.successCount })
              : t("usage.covered_dates", { dates: partial.days.join(", ") }));
            return (
              <div className="grid grid-cols-5 gap-2 mb-3">
              <div className="rounded-lg border bg-blue-50 p-2 text-center">
                <div className="text-lg font-bold text-blue-600">{summary.totalRequests}</div>
                <div className="text-xs text-gray-500">{t("usage.total_requests")}{summary.estimatedCount ? ` · ${summary.estimatedCount} estimated / 估算` : ""}</div>
                <div className="text-xs text-green-500">{summary.successCount} ok / <span className="text-red-500">{summary.errorCount} err</span></div>
              </div>
              <div className="rounded-lg border bg-gray-50 p-2 text-center">
                <div className="text-lg font-bold text-gray-700">
                  {summary.totalRequests > 0 ? ((summary.successCount / summary.totalRequests) * 100).toFixed(1) + "%" : "-"}
                </div>
                <div className="text-xs text-gray-500">{t("usage.success_rate")}</div>
              </div>
              <div className="rounded-lg border bg-green-50 p-2 text-center">
                <div className="text-lg font-bold text-green-600">{formatTokens(tokens.cacheMissInput ?? summary.totalInputTokens, estimated)}</div>
                <div className="text-xs text-gray-500">{t(tokens.cacheMissInput === null ? "usage.reported_input" : "usage.total_input_tokens")}</div>
              </div>
              <div className="rounded-lg border bg-yellow-50 p-2 text-center">
                <div className="text-lg font-bold text-yellow-600">{formatTokens(summary.totalOutputTokens, estimated)}</div>
                <div className="text-xs text-gray-500">{t("usage.total_output_tokens")}</div>
              </div>
              <div className="rounded-lg border bg-indigo-50 p-2 text-center">
                <div className="text-lg font-bold text-indigo-600">{displayedTotal === null ? "—" : (markedEstimate ? "≈" : "") + displayedTotal.toLocaleString()}</div>
                <div className="text-xs text-gray-500">{t("usage.total_tokens")}</div>
                {coverage && <div className="text-xs text-gray-500">{coverage}</div>}
              </div>
              <div className="rounded-lg border bg-emerald-50 p-2 text-center">
                <div className="text-lg font-bold text-emerald-600">{formatTokens(summary.totalCacheReadInputTokens || 0)}</div>
                <div className="text-xs text-gray-500">{t("usage.cache_read")}</div>
              </div>
              <div className="rounded-lg border bg-teal-50 p-2 text-center">
                <div className="text-lg font-bold text-teal-600">{formatTokens(summary.totalCacheCreationInputTokens || 0)}</div>
                <div className="text-xs text-gray-500">{t("usage.cache_creation")}</div>
              </div>
              <div className="rounded-lg border bg-cyan-50 p-2 text-center">
                <div className="text-lg font-bold text-cyan-600">
                  {displayedRate === null ? "—" : (markedEstimate ? "≈" : "") + (displayedRate * 100).toFixed(2) + "%"}
                </div>
                <div className="text-xs text-gray-500">{t("usage.cache_hit_rate")}</div>
                {coverage && <div className="text-xs text-gray-500">{coverage}</div>}
              </div>
              <div className="rounded-lg border bg-purple-50 p-2 text-center">
                <div className="text-lg font-bold text-purple-600">{formatMs(summary.avgTtft)}</div>
                <div className="text-xs text-gray-500">{t("usage.avg_ttft")}</div>
              </div>
              <div className="rounded-lg border bg-pink-50 p-2 text-center">
                <div className="text-lg font-bold text-pink-600">{formatSpeed(summary.avgTokensPerSecond)}</div>
                <div className="text-xs text-gray-500">{t("usage.avg_speed")}</div>
              </div>
              <p className="col-span-full text-xs text-gray-500">{t("usage.token_accounting")}</p>
            </div>
            );
          })()}

          {/* Daily Chart */}
          <div className="mb-2 flex gap-1">
            {(["daily", "model"] as const).map(view => (
              <Button key={view} variant={chartView === view ? "secondary" : "ghost"} size="sm"
                aria-pressed={chartView === view} onClick={() => setChartView(view)}>
                {view === "daily" && <BarChart3 className="mr-1 h-3 w-3" aria-hidden="true" />}
                {t(view === "daily" ? "usage.daily_chart" : "usage.model_chart")}
              </Button>
            ))}
          </div>
          {chartView === "daily" && dailyData.length > 0 && (
            <div className="mb-3">
              <div className="flex items-center gap-1 text-xs text-gray-500 mb-1">
                <span>{t(dailyUsesOutput ? "usage.output_tokens" : "usage.total_tokens")}</span>
              </div>
              <div className="flex items-end gap-1 h-14">
                {dailyData.map(([day, data]) => {
                  const { cacheMissInput, total } = usageTokens(data);
                  const amount = dailyUsesOutput ? data.outputTokens : total!;
                  const height = amount > 0 ? Math.max(4, (amount / maxDailyTokens) * 100) : 0;
                  return (
                    <Tooltip key={day}>
                      <TooltipTrigger asChild>
                        <div className="flex-1 h-full flex items-end cursor-pointer">
                          <div className="w-full bg-blue-400 rounded-t hover:bg-blue-500 transition-colors" style={{ height: `${height}%` }} />
                        </div>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-xs">
                        <div className="font-medium mb-1">{day}</div>
                        <div>{t("usage.input_tokens")}: {formatTokens(cacheMissInput)}</div>
                        <div>{t("usage.cache_read")}: {formatTokens(data.cacheReadInputTokens ?? 0)}</div>
                        <div>{t("usage.output_tokens")}: {formatTokens(data.outputTokens)}</div>
                        <div className="font-medium border-t mt-1 pt-1">{t("usage.total_tokens")}: {formatTokens(total)}</div>
                      </TooltipContent>
                    </Tooltip>
                  );
                })}
              </div>
              <div className="flex gap-1 mt-0.5">
                {dailyData.map(([day]) => (
                  <div key={day} className="flex-1 text-center text-[8px] text-gray-400">
                    {day.slice(5)}
                  </div>
                ))}
              </div>
            </div>
          )}

          {chartView === "model" && summary && (
            <section className="mb-4">
              <h2 className="mb-2 text-sm font-semibold text-gray-700">{t(modelUsesRecorded ? "usage.recorded_model_ranking" : "usage.total_tokens")}</h2>
              {modelData.length > 0 ? (
                <div className="space-y-2">
                  {modelData.map(({ model, data, cacheMissInput, total, chartTokens }) => {
                    const width = chartTokens > 0 ? (chartTokens / maxModelTokens) * 100 : 0;
                    const displayModel = model.length > 30 ? model.slice(0, 30) + '...' : model;
                    return (
                      <Tooltip key={model}>
                        <TooltipTrigger asChild>
                          <div className="flex items-center gap-3 cursor-pointer group">
                            <div className="w-[180px] text-sm text-gray-700 truncate font-medium group-hover:text-gray-900" title={model}>
                              {displayModel}
                            </div>
                            <div className="flex-1 h-7 bg-gray-100 rounded overflow-hidden flex">
                              <div
                                className="h-full bg-blue-400 group-hover:bg-blue-500 transition-colors rounded"
                                style={{ width: `${width}%` }}
                              />
                            </div>
                            <div className="w-[70px] text-sm text-gray-500 text-right" title={chartTokens.toLocaleString()}>
                              {formatTokens(chartTokens)}
                            </div>
                          </div>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="text-xs">
                          <div className="font-medium mb-1">{model}</div>
                          <div>{t("usage.requests")}: {data.count}</div>
                          <div>{t("usage.input_tokens")}: {formatTokens(cacheMissInput)}</div>
                          <div>{t("usage.cache_read")}: {formatTokens(data.cacheReadInputTokens ?? 0)}</div>
                          <div>{t("usage.output_tokens")}: {formatTokens(data.outputTokens)}</div>
                          <div className="font-medium border-t mt-1 pt-1">{t("usage.total_tokens")}: {formatTokens(total)}</div>
                        </TooltipContent>
                      </Tooltip>
                    );
                  })}
                </div>
              ) : (
                <p className="text-sm text-gray-500">{t("usage.no_model_data")}</p>
              )}
            </section>
          )}

          <h2 className="mb-2 text-sm font-semibold text-gray-700">{t("usage.records_tab")}</h2>
          <div className="overflow-auto border rounded text-xs">
            <table className="w-full">
              <thead>
                <tr className="bg-gray-50 border-b">
                  <th className="text-left p-1.5">{t("usage.time")}</th>
                  <th className="text-left p-1.5">{t("usage.client")}</th>
                  <th className="text-left p-1.5">{t("usage.provider")}</th>
                  <th className="text-left p-1.5">{t("usage.model")}</th>
                  <th className="text-left p-1.5">{t("usage.route")}</th>
                  <th className="text-right p-1.5">{t("usage.input_tokens")}</th>
                  <th className="text-right p-1.5">{t("usage.output_tokens")}</th>
                  <th className="text-right p-1.5">{t("usage.cache_read")}</th>
                  <th className="text-right p-1.5">{t("usage.cache_creation")}</th>
                  <th className="text-right p-1.5">{t("usage.ttft")}</th>
                  <th className="text-right p-1.5">{t("usage.speed")}</th>
                  <th className="text-right p-1.5">{t("usage.duration")}</th>
                  <th className="text-center p-1.5">{t("usage.status")}</th>
                </tr>
              </thead>
              <tbody>
                {records.length === 0 ? (
                  <tr><td colSpan={13} className="text-center p-4 text-gray-400">{t("usage.no_data")}</td></tr>
                ) : records.map((r) => {
                  // Model column shows the routing chain:
                  //   请求模型 → ccr 路由模型 → 上游实际返回
                  // The provider sits in its own column to the left, so the
                  // middle leg only carries the model name. Adjacent equal legs
                  // are de-duplicated so a request routed unchanged doesn't read
                  // as "gpt-4o → gpt-4o". The route tag (family/scenario) lives
                  // in the route column; the full annotated chain is in the tooltip.
                  const requestModel = r.originalModel || r.model || "unknown";
                  const routedModel = r.model || "unknown";
                  const actualModel =
                    r.upstreamModel && r.upstreamModel !== r.model ? r.upstreamModel : null;
                  const modelDisplay = [requestModel, routedModel, actualModel]
                    .filter((leg, i, arr) => leg != null && leg !== arr[i - 1])
                    .join(" → ");
                  const familyTag = r.modelFamily
                    || (r.originalModel
                      ? (r.originalModel.includes(",") ? "explicit" : "direct")
                      : "unknown");
                  const routeTag = `${familyTag}/${r.scenarioType || "default"}`;
                  const fullChain = `${requestModel} [${routeTag}] → ${routedModel}${actualModel ? ` → ${actualModel}` : ""}`;
                  return (
                  <tr key={r.id} className="border-b hover:bg-gray-50">
                    <td className="p-1.5 whitespace-nowrap">{formatTime(r.timestamp)}</td>
                    <td className="p-1.5">{clientDisplayName(r.clientType, t)}</td>
                    <td className="p-1.5">{r.provider}</td>
                    <td className="p-1.5 max-w-[280px] truncate" title={fullChain}>{modelDisplay}</td>
                    <td className="p-1.5">{r.modelFamily ? `${r.modelFamily}/${r.scenarioType}` : r.scenarioType}</td>
                    <td className="text-right p-1.5">{formatTokens(usageTokens(r).cacheMissInput, r.usageEstimated)}</td>
                    <td className="text-right p-1.5">{r.usageEstimated ? "≈" : ""}{formatTokens(r.outputTokens)}</td>
                    <td className="text-right p-1.5">{formatTokens(r.cacheReadInputTokens ?? 0)}</td>
                    <td className="text-right p-1.5">{formatTokens(r.cacheCreationInputTokens ?? 0)}</td>
                    <td className="text-right p-1.5">{formatMs(r.ttft)}</td>
                    <td className="text-right p-1.5">{formatSpeed(r.tokensPerSecond)}</td>
                    <td className="text-right p-1.5">{formatDuration(r.durationMs)}</td>
                    <td className="text-center p-1.5">
                      {r.status === "error" && (r.errorMessage || r.responseBody) ? (
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="inline-block w-2 h-2 rounded-full bg-red-500 cursor-pointer" />
                            </TooltipTrigger>
                            <TooltipContent className="max-w-md text-xs whitespace-pre-wrap overflow-auto max-h-64">
                              {r.responseBody ? (
                                <div>
                                  <div className="font-semibold mb-1">Response Body:</div>
                                  <pre className="text-xs bg-gray-100 p-2 rounded overflow-auto">
                                    {r.responseBody}
                                  </pre>
                                </div>
                              ) : r.errorMessage}
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      ) : (
                        <span className={`inline-block w-2 h-2 rounded-full ${r.status === "success" ? "bg-green-500" : "bg-red-500"}`} />
                      )}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-2 text-xs text-gray-500">
              <span>{t("usage.page")} {page} / {totalPages} ({total} {t("usage.records")})</span>
              <div className="flex gap-1">
                <Button variant="outline" size="sm" className="h-6 text-xs px-2" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                  &lt;
                </Button>
                <Button variant="outline" size="sm" className="h-6 text-xs px-2" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
                  &gt;
                </Button>
              </div>
            </div>
          )}
        </CardContent>
    </Card>
    </TooltipProvider>
  );
}
