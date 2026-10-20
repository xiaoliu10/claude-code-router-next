import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Coins, RefreshCw, ShieldCheck, X } from "lucide-react";
import { api } from "@/lib/api";
import type { WorkBuddyKind, WorkBuddyLoginStartResponse, WorkBuddySiteStatus, WorkBuddyStatusResponse, WorkBuddyUsage } from "@/types";
import {
  formatWorkBuddyClock, isWorkBuddyConnected, maskWorkBuddyUid, mergeWorkBuddyProvider, parseWorkBuddyUsage,
  sanitizeClearedRefs, workBuddyAccountCooling, workBuddyAccountRestricted, workBuddyErrorKey,
  workBuddyImagesUnsupportedModels, workBuddySiteStatus, workBuddyStateKey,
} from "@/utils/workbuddy";
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
  // §16: the dashboard's managed edit/delete navigates back to one site's card.
  focusSite?: WorkBuddyKind | null;
}

type SiteActionKind = "login" | "sync" | "disconnect" | "usage" | "switch" | "remove" | "hide" | "restore";

interface SiteAction {
  kind: SiteActionKind;
  site: WorkBuddyKind;
  model?: string;
}

type ConfirmRequest = { kind: "disconnect"; site: WorkBuddyKind } | { kind: "remove"; site: WorkBuddyKind; uid: string };

const WORKBUDDY_SITES: WorkBuddyKind[] = ["workbuddy", "workbuddy-ai"];

export function WorkBuddyProvider({ disabled, onBusyChange, focusSite = null }: WorkBuddyProviderProps) {
  const { t } = useTranslation();
  const { refreshConfig } = useConfig();
  const [status, setStatus] = useState<WorkBuddyStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [action, setAction] = useState<SiteAction | null>(null);
  const [errors, setErrors] = useState<Partial<Record<WorkBuddyKind, string | null>>>({});
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [login, setLogin] = useState<WorkBuddyLoginStartResponse | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [usage, setUsage] = useState<Partial<Record<WorkBuddyKind, Record<string, WorkBuddyUsage | null>>>>({});
  const [toast, setToast] = useState<string | null>(null);
  const loginSession = useRef<ReturnType<typeof createWorkBuddyLogin> | null>(null);
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
      if (mounted.current && generation.current === id) {
        setLoadFailed(true);
        setErrors({ workbuddy: "request_failed", "workbuddy-ai": "request_failed" });
      }
    }).finally(() => {
      if (mounted.current && generation.current === id) setLoading(false);
    });
    return () => {
      mounted.current = false;
      ++generation.current;
      void loginSession.current?.cancel().catch(() => {});
    };
  }, []);

  // §16: arriving from the dashboard's managed edit/delete reveals that site's card.
  useEffect(() => {
    if (!focusSite) return;
    const target = document.getElementById(`workbuddy-management-${focusSite}`);
    if (!target) return;
    target.scrollIntoView({ block: "start" });
    if (target instanceof HTMLElement) target.focus({ preventScroll: true });
  }, [focusSite]);

  const setSiteError = (site: WorkBuddyKind, key: string | null) =>
    setErrors(current => ({ ...current, [site]: key }));

  // Success tail shared by the mutating actions: reconcile the managed
  // providers into the local config, re-read the per-site status, then show
  // the settled message. Guards drop stale completions.
  const finish = async (site: WorkBuddyKind, id: number, message: string, options: { clearUsage?: boolean; dropUsageUid?: string } = {}) => {
    await refreshConfig(mergeWorkBuddyProvider);
    const updated = await api.getWorkBuddyStatus();
    if (!mounted.current || generation.current !== id) return;
    setStatus(updated);
    setLoadFailed(false);
    setConfirm(null);
    // Credits belong to the previous account/site state until explicitly re-read.
    if (options.clearUsage || options.dropUsageUid) {
      setUsage(current => {
        const entries = current[site];
        if (!entries) return current;
        const next = { ...current };
        if (options.clearUsage) next[site] = {};
        else {
          const droppedUid = options.dropUsageUid as string;
          const rest: Record<string, WorkBuddyUsage | null> = {};
          for (const [uid, value] of Object.entries(entries)) if (uid !== droppedUid) rest[uid] = value;
          next[site] = rest;
        }
        return next;
      });
    }
    setToast(message);
  };

  const run = async (kind: SiteActionKind, site: WorkBuddyKind, argument?: string) => {
    if (locked.current || disabled || loading) return;
    if (kind === "usage") {
      if (!argument || siteStatuses[site]?.status !== "connected") return;
      // Same one-action-at-a-time mutex as mutations (review F2): while a
      // credit read is in flight, every action button stays disabled.
      // Read-only: no management lock, exactly like before §16.
      locked.current = true;
      setAction({ kind, site });
      return void readUsage(site, argument);
    }
    const release = api.acquireWorkBuddyManagement();
    if (!release) { setSiteError(site, "busy"); return; }
    locked.current = true;
    const id = ++generation.current;
    busyCallback.current(true);
    setAction({ kind, site, model: argument });
    setSiteError(site, null);
    setToast(null);
    try {
      if (kind === "login") {
        const session = createWorkBuddyLogin(api, site, value => {
          if (mounted.current && generation.current === id) setLogin(value);
        });
        loginSession.current = session;
        const connected = await session.done;
        loginSession.current = null;
        if (!mounted.current || generation.current !== id) return;
        setLogin(null);
        if (!connected) return; // cancelled or superseded by a newer action
        if (!isWorkBuddyConnected(connected)) { setSiteError(site, "models_fetch_failed"); return; }
        await finish(site, id, t("workbuddy.synced", { count: connected.models?.length ?? 0 }), { clearUsage: true });
        return;
      }
      if (kind === "sync") {
        const result = await api.syncWorkBuddyModels(site);
        if (!mounted.current || generation.current !== id) return;
        if (!result.success) { setSiteError(site, workBuddyErrorKey(result)); return; }
        if (!isWorkBuddyConnected(result)) { setSiteError(site, "models_fetch_failed"); return; }
        await finish(site, id, t("workbuddy.synced", { count: result.models?.length ?? 0 }), { clearUsage: true });
        return;
      }
      if (kind === "hide") {
        const model = argument ?? "";
        if (!model) return;
        const hidden = await api.hideWorkBuddyModel(site, model);
        if (!mounted.current || generation.current !== id) return;
        if (!hidden || hidden.ok !== true) { setSiteError(site, "request_failed"); return; }
        // §16: the toast lists exactly the Router references the server cleared.
        const refs = sanitizeClearedRefs(hidden.clearedRefs);
        await finish(site, id, refs.length > 0
          ? `${t("workbuddy.hidden_toast", { model })} ${t("workbuddy.cleared_refs", { refs: refs.join(", ") })}`
          : t("workbuddy.hidden_toast", { model }));
        return;
      }
      if (kind === "restore") {
        const hiddenCount = siteStatuses[site]?.hiddenModels.length ?? 0;
        const restored = await api.restoreWorkBuddyModel(site, argument || undefined);
        if (!mounted.current || generation.current !== id) return;
        if (!restored || restored.ok !== true) { setSiteError(site, "request_failed"); return; }
        await finish(site, id, argument
          ? t("workbuddy.restored_toast", { model: argument })
          : t("workbuddy.restored_all_toast", { count: hiddenCount }));
        return;
      }
      const result = kind === "switch" ? await api.switchWorkBuddyAccount(site, argument ?? "")
        : kind === "remove" ? await api.removeWorkBuddyAccount(site, argument ?? "")
        : await api.disconnectWorkBuddy(site);
      if (!mounted.current || generation.current !== id) return;
      if (!result.success) { setSiteError(site, workBuddyErrorKey(result)); return; }
      const message = kind === "disconnect" ? t("workbuddy.disconnected")
        : kind === "switch" ? t("workbuddy.account_switched")
        : t("workbuddy.account_removed", { uid: maskWorkBuddyUid(argument ?? null) });
      await finish(site, id, message, {
        clearUsage: kind === "disconnect",
        dropUsageUid: kind === "remove" ? argument : undefined,
      });
    } catch (error) {
      if (mounted.current && generation.current === id) setSiteError(site, workBuddyErrorKey(error));
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
  // results that arrive after a newer action started.
  const readUsage = async (site: WorkBuddyKind, uid: string) => {
    const id = ++generation.current;
    setSiteError(site, null);
    busyCallback.current(true);
    try {
      const payload = await api.getWorkBuddyUsage(site, uid);
      if (mounted.current && generation.current === id) {
        setUsage(current => ({ ...current, [site]: { ...(current[site] || {}), [uid]: parseWorkBuddyUsage(payload) } }));
      }
    } catch {
      if (mounted.current && generation.current === id) {
        setUsage(current => ({ ...current, [site]: { ...(current[site] || {}), [uid]: null } }));
      }
    } finally {
      locked.current = false;
      busyCallback.current(false);
      if (mounted.current && generation.current === id) setAction(current => (current?.kind === "usage" ? null : current));
    }
  };

  // §16 source of truth: the per-site map. A site missing from a successful
  // response simply renders as not connected — never as the other site's state.
  const siteStatuses: Partial<Record<WorkBuddyKind, WorkBuddySiteStatus | null>> = {
    workbuddy: workBuddySiteStatus(status, "workbuddy"),
    "workbuddy-ai": workBuddySiteStatus(status, "workbuddy-ai"),
  };
  const busy = loading || action !== null;

  return (
    <>
      {WORKBUDDY_SITES.map(site => (
        <WorkBuddySiteCard key={site} site={site} status={siteStatuses[site] ?? null}
          loading={loading} loadFailed={loadFailed} busy={busy} disabled={disabled}
          action={action} errorKey={errors[site] ?? null} usageByUid={usage[site]}
          login={login && login.site === site ? login : null} cancelling={cancelling}
          onAction={(kind, argument) => void run(kind, site, argument)}
          onCancelLogin={() => {
            setCancelling(true);
            void loginSession.current?.cancel().catch(() => { if (mounted.current) setSiteError(site, "request_failed"); });
          }}
          onConfirm={request => setConfirm(request)} />
      ))}
      <Dialog open={confirm !== null} onOpenChange={open => { if (!open && !action) setConfirm(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirm?.kind === "remove" ? t("workbuddy.account_remove_title") : t("workbuddy.disconnect_title")}</DialogTitle>
            <DialogDescription>{confirm?.kind === "remove" ? t("workbuddy.account_remove_warning") : t("workbuddy.disconnect_warning")}</DialogDescription>
          </DialogHeader>
          {confirm && (errors[confirm.site] ?? null) && (
            <p role="alert" className="text-sm text-red-600">{t(`workbuddy.errors.${errors[confirm.site]}`)}</p>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={!!action} onClick={() => setConfirm(null)}>{t("app.cancel")}</Button>
            <Button variant="destructive" disabled={busy || disabled}
              onClick={() => confirm && void run(confirm.kind === "remove" ? "remove" : "disconnect", confirm.site, confirm.kind === "remove" ? confirm.uid : undefined)}>
              {action ? t("workbuddy.working") : confirm?.kind === "remove" ? t("workbuddy.account_remove_confirm") : t("workbuddy.disconnect")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {toast && <Toast message={toast} type="success" onClose={() => setToast(null)} />}
    </>
  );
}

interface SiteCardProps {
  site: WorkBuddyKind;
  status: WorkBuddySiteStatus | null;
  loading: boolean;
  loadFailed: boolean;
  busy: boolean;
  disabled: boolean;
  action: SiteAction | null;
  errorKey: string | null;
  usageByUid: Record<string, WorkBuddyUsage | null> | undefined;
  login: WorkBuddyLoginStartResponse | null;
  cancelling: boolean;
  onAction: (kind: SiteActionKind, argument?: string) => void;
  onCancelLogin: () => void;
  onConfirm: (request: ConfirmRequest) => void;
}

/** One compact card per site (§16): CN and international are fully independent. */
function WorkBuddySiteCard({ site, status, loading, loadFailed, busy, disabled, action, errorKey, usageByUid, login, cancelling, onAction, onCancelLogin, onConfirm }: SiteCardProps) {
  const { t, i18n } = useTranslation();
  const state = loading ? "loading" : loadFailed ? "error" : workBuddyStateKey(status);
  const models = status?.models || [];
  const accounts = status?.accounts || [];
  const hiddenModels = status?.hiddenModels || [];
  const connected = status?.status === "connected";
  const canDisconnect = Boolean(status && (status.status !== "not_connected" || models.length > 0 || accounts.length > 0));
  const readingUsage = action?.kind === "usage" && action.site === site;
  const imageUnsupported = workBuddyImagesUnsupportedModels(models, status?.imagesUnsupportedModels);
  const visibleError = errorKey || (status?.lastError ? workBuddyErrorKey(status) : null);
  const pendingHide = (model: string) => action?.kind === "hide" && action.site === site && action.model === model;

  return (
    <Card id={`workbuddy-management-${site}`} tabIndex={-1} className="glass-card mb-4" aria-busy={busy}>
      <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <ShieldCheck className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
            <p className="text-lg font-bold tracking-tight text-foreground">{t(`workbuddy.site.${site}`)}</p>
            <Badge variant="outline">{t("workbuddy.builtin")}</Badge>
            {status && status.status !== "not_connected" && (
              <Badge variant="outline" className="border-primary/40 text-primary">{t(`workbuddy.kind.${site}`)}</Badge>
            )}
            <Badge variant="secondary" role="status">{t(`workbuddy.status.${state}`)}</Badge>
          </div>
          <p className="max-w-md truncate text-xs font-medium text-muted-foreground/60">
            {t("workbuddy.managed_provider", { name: status?.providerName || site })}
          </p>
          {accounts.length > 0 && (
            <div className="space-y-2" aria-label={t("workbuddy.accounts_label", { count: accounts.length })}>
              {accounts.map((account: WorkBuddySiteStatus["accounts"][number]) => {
                const cooling = workBuddyAccountCooling(account);
                const restricted = workBuddyAccountRestricted(account);
                const usageLine = usageByUid?.[account.uid] ?? undefined;
                return (
                  <div key={account.uid} className="rounded-lg border border-white/5 bg-white/5 px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${account.active ? "bg-green-500" : "bg-muted-foreground/30"}`} />
                      <span className="sr-only">{t(account.active ? "workbuddy.active_account" : "workbuddy.inactive_account")}</span>
                      <span className="font-mono text-xs text-foreground">{maskWorkBuddyUid(account.uid)}</span>
                      {account.displayName && <span className="max-w-[10rem] truncate text-xs text-muted-foreground">{account.displayName}</span>}
                      <Badge variant="outline" className="px-1.5 py-0 text-[10px]">{t(`workbuddy.source_badge.${account.source}`)}</Badge>
                      {account.active && <Badge variant="outline" className="border-primary/40 px-1.5 py-0 text-[10px] text-primary">{t("workbuddy.active_badge")}</Badge>}
                      {cooling !== null && <span className="text-[11px] font-medium text-yellow-600">{t("workbuddy.cooling_until", { time: formatWorkBuddyClock(cooling, i18n.resolvedLanguage) })}</span>}
                      {restricted !== null && <span className="text-[11px] font-medium text-red-500">{t("workbuddy.restricted_until", { time: formatWorkBuddyClock(restricted, i18n.resolvedLanguage) })}</span>}
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" aria-busy={readingUsage} disabled={busy || disabled}
                        onClick={() => onAction("usage", account.uid)}>
                        <Coins className={`mr-1 h-3 w-3 ${readingUsage ? "animate-pulse" : ""}`} aria-hidden="true" />{t("workbuddy.credits.action")}
                      </Button>
                      <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" disabled={busy || disabled || account.active}
                        onClick={() => onAction("switch", account.uid)}>{t("workbuddy.set_active")}</Button>
                      <Button size="sm" variant="outline" className="h-7 px-2 text-[11px] text-red-500" disabled={busy || disabled}
                        onClick={() => onConfirm({ kind: "remove", site, uid: account.uid })}>{t("workbuddy.remove")}</Button>
                    </div>
                    {usageLine && <p className="mt-1 text-[11px] text-muted-foreground">{t("workbuddy.credits.line", { plan: usageLine.plan, used: usageLine.used, limit: usageLine.limit })}</p>}
                  </div>
                );
              })}
            </div>
          )}
          {models.length > 0 && (
            <div className="flex flex-wrap gap-2 pt-1">
              {models.map(model => (
                <span key={model} className="inline-flex max-w-full items-center gap-1 break-all whitespace-normal rounded-lg border border-white/5 bg-white/5 px-2 py-0.5 text-[10px] font-bold text-muted-foreground">
                  {model}
                  <button type="button" aria-label={t("workbuddy.hide_model", { model })} aria-busy={pendingHide(model)} disabled={busy || disabled}
                    onClick={() => onAction("hide", model)}
                    className="rounded p-0.5 text-muted-foreground/60 transition-colors hover:bg-white/10 hover:text-foreground disabled:opacity-40">
                    <X className="h-3 w-3" aria-hidden="true" />
                  </button>
                </span>
              ))}
            </div>
          )}
          {hiddenModels.length > 0 && (
            <details className="max-w-md text-xs text-muted-foreground">
              <summary className="cursor-pointer select-none font-medium">{t("workbuddy.hidden_models", { count: hiddenModels.length })}</summary>
              <ul className="mt-2 space-y-1">
                {hiddenModels.map(model => (
                  <li key={model} className="flex items-center justify-between gap-2">
                    <span className="break-all font-mono">{model}</span>
                    <Button size="sm" variant="outline" className="h-6 shrink-0 px-2 text-[11px]" disabled={busy || disabled}
                      onClick={() => onAction("restore", model)}>{t("workbuddy.restore")}</Button>
                  </li>
                ))}
              </ul>
              <Button size="sm" variant="outline" className="mt-2 h-7 px-2 text-[11px]" disabled={busy || disabled}
                onClick={() => onAction("restore")}>{t("workbuddy.restore_all")}</Button>
            </details>
          )}
          {imageUnsupported.length > 0 && (
            <p role="note" className="max-w-md rounded-lg border border-yellow-500/25 bg-yellow-500/10 px-3 py-2 text-[11px] font-medium text-yellow-600">
              {t("workbuddy.images_unsupported", { models: imageUnsupported.join(", ") })}
            </p>
          )}
          {!loading && status && !["connected", "not_connected"].includes(status.status) && (
            <p className="text-xs text-yellow-600">{t(`workbuddy.help.${status.status}`)}</p>
          )}
          {visibleError && <p role="alert" className="max-w-md rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-[11px] font-medium text-red-500">{t(`workbuddy.errors.${visibleError}`)}</p>}
          {login && <div role="status" className="max-w-md space-y-1.5 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-xs">
            <p className="font-medium">{t("workbuddy.login_pending")}</p>
            {!cancelling && <a href={login.url} target="_blank" rel="noopener noreferrer" className="block break-all text-primary underline">{t("workbuddy.open_login", { site: t(`workbuddy.site.${login.site}`) })}</a>}
            <Button variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={cancelling} onClick={onCancelLogin}>{t(cancelling ? "workbuddy.working" : "app.cancel")}</Button>
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
              <p>{t("workbuddy.hidden_note")}</p>
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
          <Button size="sm" className="h-8 w-full text-xs" disabled={busy || disabled} onClick={() => onAction("login")}>
            {action?.kind === "login" && action.site === site ? t("workbuddy.working")
              : connected ? t("workbuddy.add_account") : t("workbuddy.browser_login")}
          </Button>
          <Button size="sm" variant="outline" className="h-8 w-full text-xs" disabled={busy || disabled || !connected} onClick={() => onAction("sync")}>
            <RefreshCw className={`mr-1 h-3.5 w-3.5 ${action?.kind === "sync" && action.site === site ? "animate-spin" : ""}`} aria-hidden="true" />{t("workbuddy.sync")}
          </Button>
          <Button size="sm" variant="outline" className="h-8 w-full text-xs" disabled={busy || disabled || !canDisconnect} onClick={() => onConfirm({ kind: "disconnect", site })}>
            {t("workbuddy.disconnect")}
          </Button>
        </div>
      </div>
    </Card>
  );
}
