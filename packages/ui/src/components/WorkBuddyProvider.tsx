import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Coins, RefreshCw, ShieldCheck } from "lucide-react";
import { api } from "@/lib/api";
import type { WorkBuddyLoginStartResponse, WorkBuddyKind, WorkBuddyStatusResponse, WorkBuddyUsage } from "@/types";
import { hasDiscoveredModels, isWorkBuddyKind, maskWorkBuddyUid, mergeWorkBuddyProvider, parseWorkBuddyUsage, workBuddyErrorKey, workBuddyImagesUnsupportedModels, workBuddyStateKey } from "@/utils/workbuddy";
import { createWorkBuddyLogin } from "@/utils/workbuddy-login";
import { useConfig } from "./ConfigProvider";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Card } from "./ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Toast } from "./ui/toast";

interface WorkBuddyProviderProps {
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
}

type Action = "login" | "sync" | "disconnect" | "usage";

const WORKBUDDY_SITES: WorkBuddyKind[] = ["workbuddy", "workbuddy-ai"];

export function WorkBuddyProvider({ disabled, onBusyChange }: WorkBuddyProviderProps) {
  const { t, i18n } = useTranslation();
  const { refreshConfig } = useConfig();
  const [status, setStatus] = useState<WorkBuddyStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<Action | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"disconnect" | null>(null);
  const [login, setLogin] = useState<WorkBuddyLoginStartResponse | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const loginSession = useRef<ReturnType<typeof createWorkBuddyLogin> | null>(null);
  const [site, setSite] = useState<WorkBuddyKind>("workbuddy");
  const [usage, setUsage] = useState<WorkBuddyUsage | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const mounted = useRef(false);
  const locked = useRef(false);
  const generation = useRef(0);
  const busyCallback = useRef(onBusyChange);
  busyCallback.current = onBusyChange;

  useEffect(() => {
    mounted.current = true;
    const id = ++generation.current;
    // Local status only: no polling, no automatic import/sync/source inspection.
    api.getWorkBuddyStatus().then(value => {
      if (mounted.current && generation.current === id) setStatus(value);
    }).catch(() => {
      if (mounted.current && generation.current === id) setErrorKey("request_failed");
    }).finally(() => {
      if (mounted.current && generation.current === id) setLoading(false);
    });
    return () => {
      mounted.current = false;
      ++generation.current;
      void loginSession.current?.cancel().catch(() => {});
    };
  }, []);

  const run = async (next: Action) => {
    if (locked.current || disabled || loading) return;
    if (next === "usage") {
      if (!canSync) return;
      // Same one-action-at-a-time mutex as mutations (review F2): while a credit
      // read is in flight, Import/Sync/Disconnect stay disabled.
      locked.current = true;
      setAction("usage");
      return void readUsage();
    }
    const release = api.acquireWorkBuddyManagement();
    if (!release) { setErrorKey("busy"); return; }
    locked.current = true;
    const id = ++generation.current;
    busyCallback.current(true);
    setAction(next);
    setErrorKey(null);
    setToast(null);
    try {
      let result;
      if (next === "login") {
        const session = createWorkBuddyLogin(api, site, value => {
          if (mounted.current && generation.current === id) setLogin(value);
        });
        loginSession.current = session;
        result = await session.done;
        loginSession.current = null;
        if (mounted.current && generation.current === id) setLogin(null);
        if (!result) return;
      } else {
        result = next === "sync" ? await api.syncWorkBuddyModels() : await api.disconnectWorkBuddy();
      }
      if (!mounted.current || generation.current !== id) return;
      if (!result.success) {
        if (mounted.current && generation.current === id) setErrorKey(workBuddyErrorKey(result));
        return;
      }
      if (next !== "disconnect" && !hasDiscoveredModels(result)) {
        if (mounted.current && generation.current === id) setErrorKey("models_fetch_failed");
        return;
      }
      // Backend owns persistence and model registration. Only merge its managed
      // provider into the latest local config; never replace Router or drafts.
      await refreshConfig(mergeWorkBuddyProvider);
      const updated = await api.getWorkBuddyStatus();
      if (!mounted.current || generation.current !== id) return;
      setStatus(updated);
      setConfirm(null);
      // Credits belong to the previous site/login state until explicitly re-read.
      setUsage(null);
      setToast(next === "disconnect" ? t("workbuddy.disconnected")
        : t("workbuddy.synced", { count: result.models?.length ?? 0 }));
    } catch (error) {
      if (mounted.current && generation.current === id) setErrorKey(workBuddyErrorKey(error));
    } finally {
      release();
      locked.current = false;
      busyCallback.current(false);
      loginSession.current = null;
      if (mounted.current && generation.current === id) {
        setAction(null);
        setLogin(null);
        setCancelling(false);
      }
    }
  };

  // Explicit read only; never polled. Failures are non-critical: quietly hide
  // the display instead of showing raw quota errors. The generation guard drops
  // results that arrive after a newer import/disconnect/re-read started.
  const readUsage = async () => {
    const id = ++generation.current;
    setErrorKey(null);
    busyCallback.current(true);
    try {
      const payload = await api.getWorkBuddyUsage();
      if (mounted.current && generation.current === id) setUsage(parseWorkBuddyUsage(payload));
    } catch {
      if (mounted.current && generation.current === id) setUsage(null);
    } finally {
      locked.current = false;
      busyCallback.current(false);
      if (mounted.current && generation.current === id) setAction(current => (current === "usage" ? null : current));
    }
  };

  // "usage" participates in the mutex: every action button disables while reading.
  const busy = loading || action !== null;
  const readingUsage = action === "usage";
  const state = loading ? "loading" : workBuddyStateKey(status);
  const models = status?.models || [];
  const canSync = status?.status === "connected";
  const canDisconnect = Boolean(status && (status.status !== "not_connected" || models.length > 0));
  const imageUnsupported = workBuddyImagesUnsupportedModels(models, status?.imagesUnsupportedModels);
  const date = (value: string | number | null | undefined) => {
    if (!value) return t("workbuddy.unknown");
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? t("workbuddy.unknown") : parsed.toLocaleString(i18n.resolvedLanguage);
  };
  const visibleError = errorKey || (status?.lastError ? workBuddyErrorKey(status) : null);

  return (
    <Card id="workbuddy-management" tabIndex={-1} className="glass-card mb-4" aria-busy={busy}>
      <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <ShieldCheck className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
            <p className="text-lg font-bold tracking-tight text-foreground">WorkBuddy</p>
            <Badge variant="outline">{t("workbuddy.builtin")}</Badge>
            {status && isWorkBuddyKind(status.kind) && status.status !== "not_connected" && (
              <Badge variant="outline" className="border-primary/40 text-primary">{t(`workbuddy.kind.${status.kind}`)}</Badge>
            )}
            <Badge variant="secondary" role="status">{t(`workbuddy.status.${state}`)}</Badge>
          </div>
          <p className="max-w-md truncate text-xs font-medium text-muted-foreground/60">
            {status && status.status !== "not_connected" && status.site ? status.site : t("workbuddy.description_short")}
          </p>
          {status && status.status !== "not_connected" && (
            <p className="text-xs text-muted-foreground">
              {t("workbuddy.account_line", { account: status.displayName || t("workbuddy.unknown"), uid: maskWorkBuddyUid(status.uid), expires: date(status.expiresAt) })}
            </p>
          )}
          {imageUnsupported.length > 0 && (
            <p role="note" className="max-w-md rounded-lg border border-yellow-500/25 bg-yellow-500/10 px-3 py-2 text-[11px] font-medium text-yellow-600">
              {t("workbuddy.images_unsupported", { models: imageUnsupported.join(", ") })}
            </p>
          )}
          {usage && status?.status === "connected" && (
            <p className="text-xs text-muted-foreground">{t("workbuddy.credits.line", { plan: usage.plan, used: usage.used, limit: usage.limit })}</p>
          )}
          {models.length > 0 && (
            <div className="flex flex-wrap gap-2 pt-1">
              {models.map(model => (
                <Badge key={model} variant="secondary" className="max-w-full break-all whitespace-normal rounded-lg border-white/5 bg-white/5 px-2 py-0.5 text-[10px] font-bold text-muted-foreground">{model}</Badge>
              ))}
            </div>
          )}
          {!loading && status && !["connected", "not_connected"].includes(status.status) && (
            <p className="text-xs text-yellow-600">{t(`workbuddy.help.${status.status}`)}</p>
          )}
          {visibleError && <p role="alert" className="max-w-md rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-[11px] font-medium text-red-500">{t(`workbuddy.errors.${visibleError}`)}</p>}
          {login && <div role="status" className="max-w-md space-y-1.5 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-xs">
            <p className="font-medium">{t("workbuddy.login_pending")}</p>
            {!cancelling && <a href={login.url} target="_blank" rel="noopener noreferrer" className="block break-all text-primary underline">{t("workbuddy.open_login", { site: t(`workbuddy.site.${login.site}`) })}</a>}
            <Button variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={cancelling} onClick={() => {
              setCancelling(true);
              void loginSession.current?.cancel().catch(() => { if (mounted.current) setErrorKey("request_failed"); });
            }}>{t(cancelling ? "workbuddy.working" : "app.cancel")}</Button>
          </div>}
          <details className="max-w-md text-xs text-muted-foreground">
            <summary className="cursor-pointer select-none font-medium">{t("workbuddy.about")}</summary>
            <div className="mt-2 space-y-1 leading-relaxed">
              <p>{t("workbuddy.description")}</p>
              <p>{t("workbuddy.server_host")}</p>
              <p>{t("workbuddy.privacy", { site: status?.site || t("workbuddy.privacy_selected") })}</p>
              <p>{t("workbuddy.backup_warning")}</p>
              <p>{t("workbuddy.browser_source")}</p>
              <p>{t("workbuddy.routing_note")}</p>
              {status && status.status !== "not_connected" && (
                <>
                  <p>{t(status.source === "browser" ? "workbuddy.source_browser" : status.source === "desktop" ? "workbuddy.source_desktop" : "workbuddy.source_unknown")}</p>
                  {status.renewalMode === "desktop" && <p>{t("workbuddy.renewal_desktop")}</p>}
                  {status.renewalMode === "browser" && <p>{t("workbuddy.renewal_browser")}</p>}
                </>
              )}
            </div>
          </details>
          {disabled && <p className="text-xs text-muted-foreground">{t("workbuddy.other_edit")}</p>}
        </div>
        <div className="flex shrink-0 flex-col gap-2 sm:w-[210px]">
          <div role="radiogroup" aria-label={t("workbuddy.site.label")} className="flex gap-2">
            {WORKBUDDY_SITES.map(value => (
              <button key={value} type="button" role="radio" aria-checked={site === value} disabled={busy || disabled}
                onClick={() => setSite(value)}
                className={`flex-1 rounded-lg border px-2 py-1.5 text-xs font-medium transition-colors ${site === value ? "border-primary bg-primary/10 text-primary" : "border-white/10 text-muted-foreground hover:bg-white/10"}`}>
                {t(`workbuddy.site.${value}`)}
              </button>
            ))}
          </div>
          <Button size="sm" className="h-8 w-full text-xs" disabled={busy || disabled} onClick={() => void run("login")}>
            {action === "login" ? t("workbuddy.working") : t("workbuddy.browser_login")}
          </Button>
          <div className="grid grid-cols-2 gap-2">
            <Button size="sm" variant="outline" className="h-8 text-xs" disabled={busy || disabled || !canSync} onClick={() => void run("sync")}>
              <RefreshCw className={`mr-1 h-3.5 w-3.5 ${action === "sync" ? "animate-spin" : ""}`} aria-hidden="true" />{t("workbuddy.sync")}
            </Button>
            <Button size="sm" variant="outline" className="h-8 text-xs" disabled={busy || disabled || !canSync} onClick={() => void run("usage")} aria-busy={readingUsage}>
              <Coins className={`mr-1 h-3.5 w-3.5 ${readingUsage ? "animate-pulse" : ""}`} aria-hidden="true" />{readingUsage ? t("workbuddy.credits.reading") : t("workbuddy.credits.action")}
            </Button>
            <Button size="sm" variant="outline" className="col-span-2 h-8 text-xs" disabled={busy || disabled || !canDisconnect} onClick={() => setConfirm("disconnect")}>{t("workbuddy.disconnect")}</Button>
          </div>
        </div>
      </div>
      <Dialog open={confirm !== null} onOpenChange={open => { if (!open && !action) setConfirm(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("workbuddy.disconnect_title")}</DialogTitle>
            <DialogDescription>{t("workbuddy.disconnect_warning")}</DialogDescription>
          </DialogHeader>
          {errorKey && <p role="alert" className="text-sm text-red-600">{t(`workbuddy.errors.${errorKey}`)}</p>}
          <DialogFooter>
            <Button variant="outline" disabled={!!action} onClick={() => setConfirm(null)}>{t("app.cancel")}</Button>
            <Button variant="destructive" disabled={busy || disabled} onClick={() => void run("disconnect")}>
              {action ? t("workbuddy.working") : t("workbuddy.disconnect")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {toast && <Toast message={toast} type="success" onClose={() => setToast(null)} />}
    </Card>
  );
}
