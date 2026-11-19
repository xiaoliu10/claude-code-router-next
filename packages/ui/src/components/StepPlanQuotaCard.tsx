import { useTranslation } from "react-i18next";
import type { StepPlanQuotaSnapshot } from "@/types";

function DecimalCredit({ value }: { value: string }) {
  // Keep the wire representation, including precision beyond JavaScript's safe integer range.
  return typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value) ? <bdi>{value}</bdi> : "—";
}

function StepPlanUsage({ usedPercent, unlimited = false }: { usedPercent: number | null; unlimited?: boolean }) {
  const { t } = useTranslation();
  if (unlimited) return <span>{t("providers.step_plan.unlimited")}</span>;
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent) || usedPercent < 0) {
    return <span>—</span>;
  }

  const usage = t("providers.step_plan.used_percent", { percent: usedPercent });
  return (
    <div className="space-y-1">
      <div className="tabular-nums">{usage}</div>
      <div className="h-2 overflow-hidden rounded-full bg-white/10" aria-hidden="true">
        <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, usedPercent)}%` }} />
      </div>
    </div>
  );
}

type StepPlanTimeLabel = "providers.quota_reset" | "providers.step_plan.expires" | "providers.step_plan.observed";

function StepPlanTime({ label, value }: { label: StepPlanTimeLabel; value: number | null }) {
  const { t, i18n } = useTranslation();
  if (typeof value !== "number") return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;

  const time = date.toLocaleString(i18n.resolvedLanguage, { dateStyle: "medium", timeStyle: "medium" });
  const isoTime = date.toISOString();
  return <div><time dateTime={isoTime} title={isoTime}>{t(label, { time })}</time></div>;
}

export function StepPlanQuotaCard({ snapshot }: { snapshot: StepPlanQuotaSnapshot }) {
  const { t } = useTranslation();
  const { state, family, name, observedAt, allowed, windows, creditBuckets } = snapshot;
  const renderUsage = state === "known" || state === "partial" || state === "stale";
  const stateLabel = state === "stale" ? t("providers.step_plan.stale")
    : state === "partial" ? t("providers.step_plan.partial")
    : !renderUsage ? t("providers.step_plan.unavailable") : null;
  const title = t("providers.step_plan.title");

  return (
    <section aria-label={title} className="w-full space-y-2 rounded-xl border border-white/10 p-3 text-xs [overflow-wrap:anywhere]">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-semibold text-foreground">{title}</span>
        {typeof name === "string" && name && <bdi className="text-muted-foreground">{name}</bdi>}
      </div>
      <div className="space-y-1 text-muted-foreground">
        {stateLabel && <div className="font-medium text-foreground">{stateLabel}</div>}
        {renderUsage && typeof allowed === "boolean" && (
          <div>{allowed ? t("providers.step_plan.allowed") : t("providers.step_plan.blocked")}</div>
        )}
        <StepPlanTime label="providers.step_plan.observed" value={observedAt} />
      </div>
      {renderUsage && family === "token" && Array.isArray(creditBuckets) && creditBuckets.map((bucket, index) => {
        if (bucket?.type !== "subscription" && bucket?.type !== "topup") return null;
        const label = bucket.type === "subscription" ? t("providers.step_plan.subscription") : t("providers.step_plan.topup");
        return (
          <div key={index} className="space-y-1 border-t border-white/10 pt-2 text-muted-foreground">
            <div className="font-medium text-foreground">{label}</div>
            <StepPlanUsage usedPercent={bucket.usedPercent} />
            <div className="tabular-nums">
              {t("providers.step_plan.remaining_credit")} <DecimalCredit value={bucket.remaining} /> <span>{t("providers.step_plan.credit_unit")}</span>
            </div>
            <div className="tabular-nums">
              {t("providers.step_plan.total_credit")} <DecimalCredit value={bucket.total} /> <span>{t("providers.step_plan.credit_unit")}</span>
            </div>
            <StepPlanTime label="providers.quota_reset" value={bucket.resetsAt} />
            <StepPlanTime label="providers.step_plan.expires" value={bucket.expiresAt} />
          </div>
        );
      })}
      {renderUsage && family === "coding" && Array.isArray(windows) && windows.map(window => {
        if (window?.id !== "five_hour" && window?.id !== "weekly") return null;
        return (
          <div key={window.id} className="space-y-1 border-t border-white/10 pt-2 text-muted-foreground">
            <div className="font-medium text-foreground">
              {window.id === "five_hour" ? t("providers.quota_5h") : t("providers.quota_7d")}
            </div>
            <StepPlanUsage usedPercent={window.limited === true ? window.usedPercent : null} unlimited={window.limited === false} />
            <StepPlanTime label="providers.quota_reset" value={window.resetsAt} />
          </div>
        );
      })}
    </section>
  );
}
