import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw, ShieldCheck } from "lucide-react";
import { api } from "@/lib/api";
import type { WorkBuddyStatusResponse } from "@/types";
import { hasDiscoveredModels, maskWorkBuddyUid, mergeWorkBuddyProvider, workBuddyErrorKey, workBuddyStateKey } from "@/utils/workbuddy";
import { useConfig } from "./ConfigProvider";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Checkbox } from "./ui/checkbox";
import { Label } from "./ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Toast } from "./ui/toast";

interface WorkBuddyProviderProps {
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
}

type Action = "import" | "sync" | "disconnect";

export function WorkBuddyProvider({ disabled, onBusyChange }: WorkBuddyProviderProps) {
  const { t, i18n } = useTranslation();
  const { refreshConfig } = useConfig();
  const [status, setStatus] = useState<WorkBuddyStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<Action | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"import" | "disconnect" | null>(null);
  const [consent, setConsent] = useState(false);
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
    return () => { mounted.current = false; };
  }, []);

  const run = async (next: Action) => {
    if (locked.current || disabled || loading) return;
    const release = api.acquireWorkBuddyManagement();
    if (!release) { setErrorKey("busy"); return; }
    locked.current = true;
    const id = ++generation.current;
    busyCallback.current(true);
    setAction(next);
    setErrorKey(null);
    setToast(null);
    try {
      const result = next === "import" ? await api.importWorkBuddy()
        : next === "sync" ? await api.syncWorkBuddyModels() : await api.disconnectWorkBuddy();
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
      setConsent(false);
      setToast(next === "disconnect" ? t("workbuddy.disconnected")
        : t("workbuddy.synced", { count: result.models?.length ?? 0 }));
    } catch (error) {
      if (mounted.current && generation.current === id) setErrorKey(workBuddyErrorKey(error));
    } finally {
      release();
      locked.current = false;
      busyCallback.current(false);
      if (mounted.current && generation.current === id) setAction(null);
    }
  };

  const busy = loading || action !== null;
  const state = loading ? "loading" : workBuddyStateKey(status);
  const models = status?.models || [];
  const canSync = status?.status === "connected";
  const canDisconnect = Boolean(status && (status.status !== "not_connected" || models.length > 0));
  const date = (value: string | number | null | undefined) => {
    if (!value) return t("workbuddy.unknown");
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? t("workbuddy.unknown") : parsed.toLocaleString(i18n.resolvedLanguage);
  };
  const visibleError = errorKey || (status?.lastError ? workBuddyErrorKey(status) : null);

  return (
    <Card id="workbuddy-management" tabIndex={-1} className="mb-6 border-primary/25 bg-primary/5" aria-busy={busy}>
      <CardHeader className="p-4 pb-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("workbuddy.section")}</p>
        <CardTitle className="flex flex-wrap items-center gap-2 text-lg">
          <ShieldCheck className="h-5 w-5" aria-hidden="true" /> WorkBuddy
          <Badge variant="outline">{t("workbuddy.builtin")}</Badge>
          <Badge variant="secondary" role="status">{t(`workbuddy.status.${state}`)}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 p-4 pt-2">
        <p className="text-sm text-muted-foreground">{t("workbuddy.description")}</p>
        <div className="space-y-1 rounded-lg border border-amber-500/25 bg-amber-500/5 p-3 text-xs leading-relaxed">
          <p className="font-semibold">{t("workbuddy.server_host")}</p>
          <p>{t("workbuddy.privacy")}</p>
          <p>{t("workbuddy.backup_warning")}</p>
          <p>{t("workbuddy.encrypted_warning")}</p>
        </div>
        <p className="text-xs text-muted-foreground">{t("workbuddy.routing_note")}</p>
        {status && status.status !== "not_connected" && (
          <dl className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
            <div><dt className="text-muted-foreground">{t("workbuddy.account")}</dt><dd className="break-all">{status.displayName || t("workbuddy.unknown")} ({maskWorkBuddyUid(status.uid)})</dd></div>
            <div><dt className="text-muted-foreground">{t("workbuddy.expires")}</dt><dd>{date(status.expiresAt)}</dd></div>
            <div><dt className="text-muted-foreground">{t("workbuddy.model_count")}</dt><dd>{models.length}</dd></div>
            <div><dt className="text-muted-foreground">{t("workbuddy.last_sync")}</dt><dd>{date(status.lastSyncAt)}</dd></div>
          </dl>
        )}
        {models.length > 0 && (
          <details className="text-xs"><summary className="cursor-pointer">{t("workbuddy.models", { count: models.length })}</summary>
            <div className="mt-2 flex max-h-40 flex-wrap gap-1 overflow-auto">{models.map(model => <Badge className="max-w-full break-all whitespace-normal" key={model} variant="outline">{model}</Badge>)}</div>
          </details>
        )}
        {!loading && status && !["connected", "not_connected"].includes(status.status) && (
          <p className="text-sm text-amber-600">{t(`workbuddy.help.${status.status}`)}</p>
        )}
        {visibleError && <p role="alert" className="rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-sm text-red-600">{t(`workbuddy.errors.${visibleError}`)}</p>}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={busy || disabled} onClick={() => { setConsent(false); setConfirm("import"); }}>
            {action === "import" ? t("workbuddy.importing") : status?.status === "connected" ? t("workbuddy.reimport") : t("workbuddy.connect")}
          </Button>
          <Button size="sm" variant="outline" disabled={busy || disabled || !canSync} onClick={() => void run("sync")}>
            <RefreshCw className={`mr-1 h-3.5 w-3.5 ${action === "sync" ? "animate-spin" : ""}`} aria-hidden="true" />{t("workbuddy.sync")}
          </Button>
          <Button size="sm" variant="outline" disabled={busy || disabled || !canDisconnect} onClick={() => setConfirm("disconnect")}>{t("workbuddy.disconnect")}</Button>
        </div>
        {disabled && <p className="text-xs text-muted-foreground">{t("workbuddy.other_edit")}</p>}
      </CardContent>
      <Dialog open={confirm !== null} onOpenChange={open => { if (!open && !action) setConfirm(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t(confirm === "disconnect" ? "workbuddy.disconnect_title" : "workbuddy.import_title")}</DialogTitle>
            <DialogDescription>{t(confirm === "disconnect" ? "workbuddy.disconnect_warning" : "workbuddy.import_warning")}</DialogDescription>
          </DialogHeader>
          {confirm === "import" && <div className="flex items-start gap-2"><Checkbox id="workbuddy-consent" checked={consent} disabled={busy} onCheckedChange={checked => setConsent(checked === true)} /><Label htmlFor="workbuddy-consent" className="text-sm leading-relaxed">{t("workbuddy.consent")}</Label></div>}
          {errorKey && <p role="alert" className="text-sm text-red-600">{t(`workbuddy.errors.${errorKey}`)}</p>}
          <DialogFooter>
            <Button variant="outline" disabled={!!action} onClick={() => setConfirm(null)}>{t("app.cancel")}</Button>
            <Button variant={confirm === "disconnect" ? "destructive" : "default"} disabled={busy || disabled || (confirm === "import" && !consent)} onClick={() => void run(confirm === "disconnect" ? "disconnect" : "import")}>
              {action ? t("workbuddy.working") : t(confirm === "disconnect" ? "workbuddy.disconnect" : "workbuddy.import_confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {toast && <Toast message={toast} type="success" onClose={() => setToast(null)} />}
    </Card>
  );
}
