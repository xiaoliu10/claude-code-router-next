import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, KeyRound, Plug, RefreshCw, ShieldAlert } from "lucide-react";
import { api } from "@/lib/api";
import type { Config, GeminiOauthLoginStartResponse, GeminiOauthStatusResponse } from "@/types";
import {
  GEMINI_OAUTH_RISK_KEY, formatGeminiOauthClock, geminiOauthErrorKey, geminiOauthStateKey, geminiOauthStatusErrorKey,
  mergeGeminiOauthProvider, safeValidationUrl, GEMINI_OAUTH_PROVIDER_NAME,
} from "@/utils/gemini-oauth";
import { createGeminiOauthLogin } from "@/utils/gemini-oauth-login";
import { useConfig } from "./ConfigProvider";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Card } from "./ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Toast } from "./ui/toast";

interface GeminiOauthProviderProps {
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
}

type ActionKind = "login" | "sync" | "disconnect";

/**
 * Settings card for the Gemini subscription (Antigravity OAuth) provider.
 * Contract: `docs/design/gemini-provider-contract.md` §2.
 *
 * Three invariants the reviewer will check:
 *  1. `login/start` is only ever reachable through the risk-consent dialog —
 *     the button opens the dialog, the dialog's confirm starts the login.
 *  2. The poll loop is bounded (2s interval, 10min cap) and stoppable.
 *  3. Nothing rendered here can contain token material: the status payload has
 *     no token field and this component never reads credentials.
 */
export function GeminiOauthProvider({ disabled, onBusyChange }: GeminiOauthProviderProps) {
  const { t, i18n } = useTranslation();
  const { refreshConfig } = useConfig();
  const [status, setStatus] = useState<GeminiOauthStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [action, setAction] = useState<ActionKind | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [consentOpen, setConsentOpen] = useState(false);
  const [consentAck, setConsentAck] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [login, setLogin] = useState<GeminiOauthLoginStartResponse | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const session = useRef<ReturnType<typeof createGeminiOauthLogin> | null>(null);
  // The consent dialog can close while `login/start` is still in flight; this
  // flag makes that race abort instead of opening a stray consent window.
  const consentGranted = useRef(false);
  const mounted = useRef(false);
  const locked = useRef(false);
  const generation = useRef(0);
  const busyCallback = useRef(onBusyChange);
  busyCallback.current = onBusyChange;

  useEffect(() => {
    mounted.current = true;
    const id = ++generation.current;
    // Local status only: no polling and no upstream call on mount.
    api.getGeminiOauthStatus().then(value => {
      if (mounted.current && generation.current === id) setStatus(value);
    }).catch(() => {
      if (mounted.current && generation.current === id) {
        setLoadFailed(true);
        setErrorKey("request_failed");
      }
    }).finally(() => {
      if (mounted.current && generation.current === id) setLoading(false);
    });
    return () => {
      mounted.current = false;
      ++generation.current;
      void session.current?.cancel().catch(() => {});
    };
  }, []);

  /** Reconcile the managed provider into the draft, then re-read the status. */
  const settle = async (id: number, message: string, merge: (local: Config, server: Config) => Config) => {
    let refreshFailed = false;
    try {
      await refreshConfig(merge);
    } catch {
      // The mutation already persisted server-side; a draft refresh failure is
      // surfaced by ConfigProvider, so the settled status/message still runs.
      refreshFailed = true;
    }
    const updated = await api.getGeminiOauthStatus().catch(() => null);
    if (!mounted.current || generation.current !== id) return;
    if (updated) setStatus(updated);
    if (!refreshFailed) setLoadFailed(false);
    setConfirmDisconnect(false);
    setToast(message);
  };

  const run = async (kind: ActionKind) => {
    if (locked.current || disabled || loading) return;
    const release = api.acquireWorkBuddyManagement();
    if (!release) { setErrorKey("config_busy"); return; }
    locked.current = true;
    const id = ++generation.current;
    busyCallback.current(true);
    setAction(kind);
    setErrorKey(null);
    setToast(null);
    try {
      if (kind === "login") {
        consentGranted.current = true;
        const current = createGeminiOauthLogin(api, value => {
          if (!consentGranted.current) {
            // Closed/cancelled while starting: never open a window the user
            // did not just ask for; the attempt is cancelled in the finally block.
            void current.cancel().catch(() => {});
            return;
          }
          if (mounted.current && generation.current === id) {
            setLogin(value);
            // The consent page is opened by this user gesture, never by a poll.
            window.open(value.url, "_blank", "noopener,noreferrer");
          }
        });
        session.current = current;
        const email = await current.done;
        session.current = null;
        if (!mounted.current || generation.current !== id) return;
        setLogin(null);
        if (email === null) return; // cancelled
        // The backend already ran token exchange + userinfo + project discovery
        // and wrote the managed provider; settle re-reads that status below.
        await settle(id, email && email.trim()
          ? t("geminiOauth.login_success", { email })
          : t("geminiOauth.login_success_unknown"),
          (local, server) => mergeGeminiOauthProvider(local, server));
        return;
      }
      if (kind === "sync") {
        const result = await api.syncGeminiOauthModels();
        if (!mounted.current || generation.current !== id) return;
        if (result?.ok !== true) { setErrorKey(geminiOauthErrorKey(result?.error ?? "gemini_oauth_models_fetch_failed")); await rereadStatus(id); return; }
        const count = result.modelsCount ?? 0;
        await settle(id, result.clearedRefs && result.clearedRefs.length > 0
          ? t("geminiOauth.synced_cleared", { count, refs: result.clearedRefs.join(", ") })
          : t("geminiOauth.synced", { count }),
          (local, server) => mergeGeminiOauthProvider(local, server));
        return;
      }
      const result = await api.disconnectGeminiOauth();
      if (!mounted.current || generation.current !== id) return;
      if (result?.ok !== true) { setErrorKey(geminiOauthErrorKey(result)); return; }
      setLogin(null);
      await settle(id, t("geminiOauth.disconnected"), (local, server) => mergeGeminiOauthProvider(local, server));
    } catch (error) {
      if (mounted.current && generation.current === id) {
        setLogin(null);
        setErrorKey(geminiOauthErrorKey(error));
      }
    } finally {
      release();
      locked.current = false;
      busyCallback.current(false);
      session.current = null;
      consentGranted.current = false;
      if (mounted.current && generation.current === id) {
        setAction(null);
        setConsentOpen(false);
        setConsentAck(false);
        setCancelling(false);
      }
    }
  };

  const rereadStatus = async (id: number) => {
    const updated = await api.getGeminiOauthStatus().catch(() => null);
    if (updated && mounted.current && generation.current === id) setStatus(updated);
  };

  const state = loading ? "loading" : loadFailed && !status ? "error" : geminiOauthStateKey(status);
  const connected = status?.connected === true;
  const cooldown = formatGeminiOauthClock(status?.cooldownUntil, i18n.resolvedLanguage);
  const statusError = geminiOauthStatusErrorKey(status);
  const visibleError = errorKey;
  const validationUrl = safeValidationUrl(status?.lastError?.validationUrl);
  const busy = loading || action !== null;
  const stateLabel = `geminiOauth.status.${state}`;

  return (
    <>
      <Card className="glass-card mb-4" aria-busy={busy} data-testid="gemini-oauth-card">
        <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <KeyRound className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
              <p className="text-lg font-bold tracking-tight text-foreground">{t("geminiOauth.title")}</p>
              <Badge variant="outline">{t("geminiOauth.builtin")}</Badge>
              {status && <Badge variant="outline" className="border-primary/40 text-primary">{t(`geminiOauth.kind.${status.kind || "antigravity"}`)}</Badge>}
              <Badge variant="secondary" role="status">{t(stateLabel)}</Badge>
            </div>
            <p className="max-w-md truncate text-xs font-medium text-muted-foreground/60">{t("geminiOauth.managed_provider", { name: GEMINI_OAUTH_PROVIDER_NAME })}</p>
            <p className="max-w-md text-xs text-muted-foreground">{t("geminiOauth.description")}</p>
            {connected && (
              <dl className="grid max-w-md grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                <dt className="text-muted-foreground">{t("geminiOauth.labels.email")}</dt>
                <dd className="break-all font-mono text-foreground">{status?.email || t("geminiOauth.unknown")}</dd>
                <dt className="text-muted-foreground">{t("geminiOauth.labels.project")}</dt>
                <dd className="break-all font-mono text-foreground">{status?.project || t("geminiOauth.unknown")}</dd>
                <dt className="text-muted-foreground">{t("geminiOauth.labels.tier")}</dt>
                <dd className="break-all text-foreground">{status?.tier || t("geminiOauth.unknown")}</dd>
                <dt className="text-muted-foreground">{t("geminiOauth.labels.models")}</dt>
                <dd className="text-foreground">{t("geminiOauth.models_count", { count: status?.modelsCount ?? 0 })}</dd>
              </dl>
            )}
            {cooldown && state === "cooldown" && (
              <p className="text-xs font-medium text-yellow-600">{t("geminiOauth.cooldown_until", { time: cooldown })}</p>
            )}
            {state === "needs_relogin" && (
              <p className="text-xs text-yellow-600">{t("geminiOauth.needs_relogin_help")}</p>
            )}
            {statusError && (
              <p role="alert" className="max-w-md rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-[11px] font-medium text-red-500">
                {t(`geminiOauth.errors.${statusError}`)}
              </p>
            )}
            {validationUrl && (
              <a href={validationUrl} target="_blank" rel="noopener noreferrer" className="block max-w-md break-all text-xs text-primary underline">
                {validationUrl}
              </a>
            )}
            {visibleError && (
              <p role="alert" className="max-w-md rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-[11px] font-medium text-red-500">
                {t(`geminiOauth.errors.${visibleError}`)}
              </p>
            )}
            {login && (
              <div role="status" className="max-w-md space-y-1.5 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-xs">
                <p className="font-medium">{t("geminiOauth.login_pending")}</p>
                {!cancelling && (
                  <a href={login.url} target="_blank" rel="noopener noreferrer" className="block break-all text-primary underline">
                    {t("geminiOauth.open_login")}
                  </a>
                )}
                <Button variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={cancelling} onClick={() => {
                  setCancelling(true);
                  void session.current?.cancel().catch(() => { if (mounted.current) setErrorKey("request_failed"); });
                }}>{t(cancelling ? "geminiOauth.working" : "app.cancel")}</Button>
              </div>
            )}
            <details className="max-w-md text-xs text-muted-foreground">
              <summary className="cursor-pointer select-none font-medium">{t("geminiOauth.about")}</summary>
              <div className="mt-2 space-y-1 leading-relaxed">
                <p>{t("geminiOauth.about_body")}</p>
                <p>{t("geminiOauth.no_content_obfuscation")}</p>
                <p>{t("geminiOauth.single_account")}</p>
              </div>
            </details>
            {disabled && <p className="text-xs text-muted-foreground">{t("geminiOauth.other_edit")}</p>}
          </div>
          <div className="flex shrink-0 flex-col gap-2 sm:w-[210px]">
            {/* Deliberately NOT a login: this button only opens the risk dialog. */}
            <Button size="sm" className="h-8 w-full text-xs" disabled={busy || disabled} onClick={() => { setConsentAck(false); setConsentOpen(true); }}>
              <Plug className="mr-1 h-3.5 w-3.5" aria-hidden="true" />{t(connected ? "geminiOauth.reconnect" : "geminiOauth.connect")}
            </Button>
            <Button size="sm" variant="outline" className="h-8 w-full text-xs" disabled={busy || disabled || !connected} onClick={() => void run("sync")}>
              <RefreshCw className={`mr-1 h-3.5 w-3.5 ${action === "sync" ? "animate-spin" : ""}`} aria-hidden="true" />{t("geminiOauth.sync")}
            </Button>
            <Button size="sm" variant="outline" className="h-8 w-full text-xs" disabled={busy || disabled || !status?.configured} onClick={() => setConfirmDisconnect(true)}>
              {t("geminiOauth.disconnect")}
            </Button>
          </div>
        </div>
      </Card>

      {/* Risk confirmation — mandatory gate in front of every login/start. */}
      <Dialog open={consentOpen} onOpenChange={open => { if (!open && !action) { setConsentOpen(false); setConsentAck(false); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 text-red-500" aria-hidden="true" />{t("geminiOauth.risk_title")}
            </DialogTitle>
            <DialogDescription asChild>
              <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm font-medium text-red-600">
                {t(GEMINI_OAUTH_RISK_KEY)}
              </p>
            </DialogDescription>
          </DialogHeader>
          <label className="flex items-start gap-2 text-xs text-muted-foreground">
            <input type="checkbox" className="mt-0.5" checked={consentAck} onChange={event => setConsentAck(event.target.checked)} />
            <span>{t("geminiOauth.risk_ack")}</span>
          </label>
          <DialogFooter>
            <Button variant="outline" disabled={!!action} onClick={() => { setConsentOpen(false); setConsentAck(false); }}>{t("app.cancel")}</Button>
            <Button variant="destructive" disabled={busy || disabled || !consentAck} onClick={() => { consentGranted.current = true; void run("login"); }}>
              <AlertTriangle className="mr-1 h-3.5 w-3.5" aria-hidden="true" />{action === "login" ? t("geminiOauth.working") : t("geminiOauth.risk_continue")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmDisconnect} onOpenChange={open => { if (!open && !action) setConfirmDisconnect(false); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("geminiOauth.disconnect_title")}</DialogTitle>
            <DialogDescription>{t("geminiOauth.disconnect_warning")}</DialogDescription>
          </DialogHeader>
          {visibleError && <p role="alert" className="text-sm text-red-600">{t(`geminiOauth.errors.${visibleError}`)}</p>}
          <DialogFooter>
            <Button variant="outline" disabled={!!action} onClick={() => setConfirmDisconnect(false)}>{t("app.cancel")}</Button>
            <Button variant="destructive" disabled={busy || disabled} onClick={() => void run("disconnect")}>
              {action === "disconnect" ? t("geminiOauth.working") : t("geminiOauth.disconnect")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {toast && <Toast message={toast} type="success" onClose={() => setToast(null)} />}
    </>
  );
}
