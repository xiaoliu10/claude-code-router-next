import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Combobox } from "@/components/ui/combobox";
import { MultiCombobox } from "@/components/ui/multi-combobox";
import { useConfig } from "./ConfigProvider";
import { StatusLineConfigDialog } from "./StatusLineConfigDialog";
import { UsageStats } from "./UsageStats";
import { PluginCardArea } from "./PluginCardArea";
import { PluginMarketArea } from "./PluginMarketArea";
import { ProjectsPage } from "./ProjectsPage";
import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { LogViewer } from '@/components/LogViewer';
import type { ClientApplyResponse, ClientId, ClientStatus, StatusLineConfig, FallbackConfig } from "@/types";
import { FileJson, FileText, CircleArrowUp, FileCog, ArrowLeft, Save, RefreshCw } from "lucide-react";
import { Toast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import { getConfiguredProxyUrl, isGlobalProxyEnabled, findInvalidProxyUrls } from "@/utils/proxy";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { MODEL_FAMILIES } from "@/types";
import type { ModelFamilyConfig } from "@/types";

const FALLBACK_SCENARIOS = ["default", "think", "longContext", "extendedContext", "webSearch", "image"] as const;

export function SettingsPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { config, setConfig } = useConfig();
  const [isStatusLineConfigOpen, setIsStatusLineConfigOpen] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  // Managed subscription cards share one "a management action is running" gate
  // so a full Save cannot race an in-flight OAuth login or disconnect.
  const [managedProviderBusy, setManagedProviderBusy] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);
  const [isLogViewerOpen, setIsLogViewerOpen] = useState(false);
  const [isNewVersionAvailable, setIsNewVersionAvailable] = useState(false);
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
  const [expandedFamily, setExpandedFamily] = useState<string | null>(null);
  const [clients, setClients] = useState<ClientStatus[]>([]);
  const [selectedClientIds, setSelectedClientIds] = useState<ClientId[]>([]);
  const [isLoadingClients, setIsLoadingClients] = useState(false);
  const [isApplyingClients, setIsApplyingClients] = useState(false);
  const [restoringClientId, setRestoringClientId] = useState<ClientId | null>(null);
  const tabFromUrl = new URLSearchParams(location.search).get("tab");
  const initialTab = ["general", "providers", "clients", "router", "projects", "usage", "tools"].includes(tabFromUrl || "")
    ? tabFromUrl || "general"
    : "general";

  // Auto-expand first family on initial load so the section is not empty
  // Use useEffect without ref guard - React StrictMode runs effects twice in dev
  // but the state check ensures we only set once (null -> value)
  useEffect(() => {
    console.log('[SettingsPage] useEffect triggered', { 
      expandedFamily, 
      hasConfig: !!config, 
      hasRouter: !!config?.Router,
      familiesKeys: config?.Router?.families ? Object.keys(config.Router.families) : '(no families)'
    });
    // Skip if already expanded or config not loaded
    if (expandedFamily !== null || !config?.Router) {
      console.log('[SettingsPage] skipping', { expandedFamily, hasRouter: !!config?.Router });
      return;
    }
    
    const families = config.Router.families;
    console.log('[SettingsPage] families', families, Object.keys(families || {}));
    if (families && Object.keys(families).length > 0) {
      // Prefer opus, otherwise use first configured family
      const selected = families.opus ? "opus" : Object.keys(families)[0];
      console.log('[SettingsPage] setting expandedFamily to', selected);
      setExpandedFamily(selected);
    } else {
      // No families configured, default to opus for new config
      console.log('[SettingsPage] no families, defaulting to opus');
      setExpandedFamily("opus");
    }
  }, [config?.Router, expandedFamily]);

  const providers = useMemo(
    () => (Array.isArray(config?.Providers) ? config.Providers : []),
    [config?.Providers]
  );

  const modelOptions = useMemo(
    () =>
      providers.flatMap((provider) => {
        if (!provider) return [];

        // Skip disabled providers
        if (provider.enabled === false) return [];

        const models = Array.isArray(provider.models) ? provider.models : [];
        const providerName = provider.name || "Unknown Provider";
        return models.map((model) => ({
          value: `${providerName},${model || "Unknown Model"}`,
          label: `${providerName}, ${model || "Unknown Model"}`,
        }));
      }),
    [providers]
  );

  const syncClientResponse = useCallback((response: ClientApplyResponse) => {
    setClients(response.clients || []);
    setSelectedClientIds((response.clients || []).filter((client) => client.enabled || client.managed).map((client) => client.id));
    if (response.config) {
      setConfig((current) => {
        if (!current) return response.config;
        return {
          ...current,
          Clients: response.config.Clients,
          Router: {
            ...(current.Router || {}),
            models: {
              ...(current.Router?.models || {}),
              ...(response.config.Router?.models || {}),
            },
          },
        };
      });
    }
  }, [setConfig]);

  // Keep a ref to the latest translator so loadClients itself can have a
  // stable identity. Depending on `t` directly would recreate the callback on
  // re-renders (its identity is not stable), re-triggering the mount effect
  // and hammering /api/clients in a fetch → setState → re-render loop.
  const tRef = useRef(t);
  tRef.current = t;

  const loadClients = useCallback(async () => {
    setIsLoadingClients(true);
    try {
      const clientsResponse = await api.getClients();
      setClients(clientsResponse.clients || []);
      setSelectedClientIds((clientsResponse.clients || []).filter((client) => client.enabled || client.managed).map((client) => client.id));
    } catch (error) {
      setToast({ message: tRef.current("clients.load_failed") + ': ' + (error as Error).message, type: 'error' });
    } finally {
      setIsLoadingClients(false);
    }
  }, []);

  // Client takeover status loads once on mount. Enable/disable/restore
  // actions reuse their server responses, so no background polling or
  // visibility-based refetch is needed.
  useEffect(() => {
    loadClients();
  }, [loadClients]);

  if (!config) {
    return (
      <div className="h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-gray-500">Loading...</div>
      </div>
    );
  }

  const routerConfig = config.Router || {
    default: "",
    think: "",
    longContext: "",
    longContextThreshold: 60000,
    webSearch: "",
    image: "",
  };

  // Whether the model family Claude Code will actually use has extended context
  // (1M) enabled. The env model name only gets the [1m] suffix when the default
  // family (opus preferred) has enableExtendedContext=true; without it, Claude Code
  // caps CLAUDE_CODE_AUTO_COMPACT_WINDOW at 200000, so a ContextWindow above 200000
  // silently has no effect. Warn the user in that case.
  const routerFamilies = config.Router?.families as Record<string, any> | undefined;
  const defaultFamilyName = routerFamilies?.opus
    ? "opus"
    : routerFamilies && Object.keys(routerFamilies).length > 0
      ? Object.keys(routerFamilies)[0]
      : null;
  const extendedContextEnabled = defaultFamilyName
    ? routerFamilies![defaultFamilyName]?.enableExtendedContext === true
    : config.Router?.enableExtendedContext === true;
  const showContextWindowWarning = (config.ContextWindow ?? 200000) > 200000 && !extendedContextEnabled;

  const handleRouterChange = (field: string, value: string | number | boolean) => {
    const currentRouter = config.Router || {};
    setConfig({ ...config, Router: { ...currentRouter, [field]: value } });
  };

  const handleFallbackChange = (scenario: string, value: string[]) => {
    const currentFallback = config.fallback || {};
    const updated = { ...currentFallback, [scenario]: value };
    if (value.length === 0) {
      delete updated[scenario];
    }
    if (Object.keys(updated).length === 0) {
      const { fallback, ...rest } = config;
      setConfig(rest);
    } else {
      setConfig({ ...config, fallback: updated as FallbackConfig });
    }
  };

  const handleAddFamily = (familyName: string) => {
    const currentRouter = config.Router || {};
    const families = currentRouter.families || {};
    // Toggle expanded state: if already expanded, collapse; otherwise expand
    if (expandedFamily === familyName) {
      setExpandedFamily(null);
    } else {
      // If family doesn't exist, create it with first available model as default
      if (!families[familyName]) {
        const firstModel = modelOptions.length > 0 ? modelOptions[0].value : "";
        setConfig({
          ...config,
          Router: { ...currentRouter, families: { ...families, [familyName]: { default: firstModel } } },
        });
      }
      setExpandedFamily(familyName);
    }
  };

  const handleRemoveFamily = (familyName: string) => {
    const currentRouter = config.Router || {};
    const families = { ...(currentRouter.families || {}) };
    delete families[familyName];
    setConfig({ ...config, Router: { ...currentRouter, families } });
  };

  const handleFamilyChange = (familyName: string, field: string, value: string | boolean) => {
    const currentRouter = config.Router || {};
    const families = { ...(currentRouter.families || {}) };
    families[familyName] = { ...(families[familyName] || {}), [field]: value };
    setConfig({ ...config, Router: { ...currentRouter, families } });
  };

  const handleFamilyFallbackChange = (familyName: string, scenario: string, value: string[]) => {
    const currentRouter = config.Router || {};
    const families = { ...(currentRouter.families || {}) };
    const family = { ...(families[familyName] || {}) };
    const fallback = { ...(family.fallback || {}) };
    if (value.length === 0) {
      delete fallback[scenario];
    } else {
      fallback[scenario] = value;
    }
    family.fallback = fallback;
    families[familyName] = family;
    setConfig({ ...config, Router: { ...currentRouter, families } });
  };

  const handleStatusLineEnabledChange = (checked: boolean) => {
    const newStatusLineConfig: StatusLineConfig = {
      enabled: checked,
      currentStyle: config.StatusLine?.currentStyle || "default",
      default: config.StatusLine?.default || { modules: [] },
      powerline: config.StatusLine?.powerline || { modules: [] },
    };
    setConfig({ ...config, StatusLine: newStatusLineConfig });
  };

  const handleClientSelectionChange = (id: ClientId, checked: boolean) => {
    setSelectedClientIds((current) => {
      if (checked) {
        return current.includes(id) ? current : [...current, id];
      }
      return current.filter((clientId) => clientId !== id);
    });
  };

  const applyClientSelection = async () => {
    setIsApplyingClients(true);
    try {
      const response = await api.applyClients(selectedClientIds);
      syncClientResponse(response);
      if (response.success) {
        setToast({ message: t("clients.apply_success"), type: 'success' });
      } else {
        const failed = response.results
          .filter((result) => !result.success)
          .map((result) => `${result.id}: ${result.error || t("clients.operation_failed")}`)
          .join("; ");
        setToast({ message: `${t("clients.apply_failed")}: ${failed}`, type: 'error' });
      }
    } catch (error) {
      setToast({ message: t("clients.apply_failed") + ': ' + (error as Error).message, type: 'error' });
    } finally {
      setIsApplyingClients(false);
    }
  };

  const restoreClientOfficial = async (id: ClientId) => {
    setRestoringClientId(id);
    try {
      const response = await api.restoreClient(id);
      syncClientResponse(response);
      if (response.success) {
        setToast({ message: t("clients.restore_success"), type: 'success' });
      } else {
        const failure = response.results.find((result) => !result.success);
        setToast({ message: `${t("clients.restore_failed")}: ${failure?.error || t("clients.operation_failed")}`, type: 'error' });
      }
    } catch (error) {
      setToast({ message: t("clients.restore_failed") + ': ' + (error as Error).message, type: 'error' });
    } finally {
      setRestoringClientId(null);
    }
  };


  const checkForUpdates = useCallback(async () => {
    setIsCheckingUpdate(true);
    try {
      const updateInfo = await api.checkForUpdates();
      if (updateInfo.hasUpdate && updateInfo.latestVersion) {
        setIsNewVersionAvailable(true);
        setToast({ message: `${t('app.new_version_available')}: v${updateInfo.latestVersion}`, type: 'success' });
      } else {
        setToast({ message: t('app.no_updates_available'), type: 'success' });
      }
    } catch (error) {
      setToast({ message: t('app.update_check_failed') + ': ' + (error as Error).message, type: 'error' });
    } finally {
      setIsCheckingUpdate(false);
    }
  }, [t]);

  const [proxyValidationErrors, setProxyValidationErrors] = useState<Array<{ key: string; error: string }>>([]);
  const [pendingSaveAction, setPendingSaveAction] = useState<"save" | "saveAndRestart" | null>(null);

  // Pre-flight check: returns the list of invalid proxy URL entries in the
  // current config. When non-empty, a confirmation dialog is shown before the
  // request is sent. The server will reject the save with HTTP 400 regardless,
  // so the dialog is purely a UX affordance to avoid a round-trip.
  const runSaveWithProxyCheck = (action: "save" | "saveAndRestart") => {
    if (isSaving || isRestarting || managedProviderBusy) return;
    const errors = findInvalidProxyUrls((config || {}) as Record<string, unknown>);
    if (errors.length > 0) {
      setProxyValidationErrors(errors);
      setPendingSaveAction(action);
      return;
    }
    if (action === "save") {
      void saveConfig();
    } else {
      void saveAndRestart();
    }
  };

  const confirmProxyInvalidSave = () => {
    const action = pendingSaveAction;
    setProxyValidationErrors([]);
    setPendingSaveAction(null);
    if (action === "save") {
      void saveConfig();
    } else if (action === "saveAndRestart") {
      void saveAndRestart();
    }
  };

  const cancelProxyInvalidSave = () => {
    setProxyValidationErrors([]);
    setPendingSaveAction(null);
  };

  const saveConfig = async () => {
    if (managedProviderBusy) return;
    setIsSaving(true);
    try {
      const response = await api.updateConfig(config);
      if (response.success) {
        setToast({ message: response.message || t('app.config_saved_success'), type: 'success' });
      } else {
        setToast({ message: response.message || t('app.config_saved_failed'), type: 'error' });
      }
    } catch (error) {
      setToast({ message: t('app.config_saved_failed') + ': ' + (error as Error).message, type: 'error' });
    } finally {
      setIsSaving(false);
    }
  };

  const saveAndRestart = async () => {
    if (managedProviderBusy) return;
    setIsRestarting(true);
    try {
      const response = await api.updateConfig(config);
      if (!response.success) {
        setToast({ message: response.message || t('app.config_saved_failed'), type: 'error' });
        return;
      }
      const restartResponse = await api.restartService();
      if (restartResponse && typeof restartResponse === 'object' && 'success' in restartResponse) {
        setToast({ message: t('app.config_saved_restart_success'), type: 'success' });
      }
    } catch (error) {
      setToast({ message: t('app.config_saved_restart_failed'), type: 'error' });
    } finally {
      setIsRestarting(false);
    }
  };

  const tools: Array<{ icon: any; label: string; desc: string; href?: string; onClick?: () => void }> = [
    { icon: FileJson, label: t("settings.tools.json_editor"), desc: t("settings.tools.json_editor_desc"), href: "/debug" },
    // LogViewer opens via overlay
    { icon: FileText, label: t("settings.tools.log_viewer"), desc: t("settings.tools.log_viewer_desc"), onClick: () => setIsLogViewerOpen(true) },
    { icon: CircleArrowUp, label: t("settings.tools.check_updates"), desc: t("settings.tools.check_updates_desc"), onClick: checkForUpdates },
    { icon: FileCog, label: t("settings.tools.presets"), desc: t("settings.tools.presets_desc"), href: "/presets" },
  ];

  return (
    <div className="h-screen bg-transparent">
      <header className="flex h-20 items-center justify-between border-b border-white/10 bg-white/5 backdrop-blur-md px-8">
        <div className="flex items-center gap-6">
          <Button variant="ghost" size="sm" onClick={() => navigate('/dashboard')} className="rounded-xl hover:bg-white/10">
            <ArrowLeft className="mr-2 h-4 w-4" />
            {t('advanced_router.back')}
          </Button>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">{t('toplevel.title')}</h1>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="outline" onClick={() => runSaveWithProxyCheck("save")} disabled={isSaving || isRestarting || managedProviderBusy} className="rounded-xl border-white/10 bg-white/5 hover:bg-white/10 h-10 px-6">
            <Save className="mr-2 h-4 w-4" />
            {t('app.save')}
          </Button>
          <Button onClick={() => runSaveWithProxyCheck("saveAndRestart")} disabled={isSaving || isRestarting || managedProviderBusy} className="rounded-xl h-10 px-6 shadow-lg shadow-primary/20">
            <RefreshCw className="mr-2 h-4 w-4" />
            {t('app.save_and_restart')}
          </Button>
        </div>
      </header>

      <main className="h-[calc(100vh-4rem)] overflow-auto p-6">
        <div className="w-full">
          <Tabs value={initialTab} onValueChange={tab => navigate(`/settings?tab=${tab}`, { replace: true })} className="w-full">
            <TabsList className="w-full justify-start mb-4">
              <TabsTrigger value="general">{t("settings.tabs.general")}</TabsTrigger>
              <TabsTrigger value="providers">{t("settings.tabs.providers")}</TabsTrigger>
              <TabsTrigger value="clients">{t("settings.tabs.clients")}</TabsTrigger>
              <TabsTrigger value="router">{t("settings.tabs.router")}</TabsTrigger>
              <TabsTrigger value="projects">{t("settings.tabs.projects")}</TabsTrigger>
              <TabsTrigger value="usage">{t("settings.tabs.usage")}</TabsTrigger>
              <TabsTrigger value="tools">{t("settings.tabs.tools")}</TabsTrigger>
            </TabsList>

            <TabsContent value="providers" className="space-y-4">
              {location.state?.geminiOauthManagedNotice && <p role="note" className="rounded-lg border p-3 text-sm text-muted-foreground">{t("geminiOauth.managed_notice")}</p>}
              {/* Managed providers are contributed by installed plugin cards. A
                  row's managed navigation lands here with a generic notice and
                  a one-shot focus key the owning card consumes. */}
              {location.state?.managedProviderNotice && <p role="note" className="rounded-lg border p-3 text-sm text-muted-foreground">{t("pluginCards.managed_notice")}</p>}
              <PluginCardArea disabled={isSaving || isRestarting} onBusyChange={setManagedProviderBusy} focusKey={(location.state as { managedProviderFocus?: string | null } | null)?.managedProviderFocus ?? null} />
              {/* Marketplace: installable provider plugins from npm with the
                  marker keyword. Install is local-only + one click; activation
                  needs the explicit restart flow. */}
              <PluginMarketArea disabled={isSaving || isRestarting} onBusyChange={setManagedProviderBusy} />
            </TabsContent>

            {/* General Tab */}
            <TabsContent value="general" className="space-y-4">
              {/* Honeypot inputs: placed first so browser autofill targets these instead of real fields */}
              <div aria-hidden="true" style={{ position: 'absolute', left: '-9999px', width: 0, height: 0, overflow: 'hidden', opacity: 0 }}>
                <input type="text" tabIndex={-1} autoComplete="username" />
                <input type="password" tabIndex={-1} autoComplete="current-password" />
              </div>
              <div className="flex items-center space-x-2">
                <Switch
                  id="log"
                  checked={config.LOG ?? false}
                  onCheckedChange={(checked) => setConfig({ ...config, LOG: checked })}
                />
                <Label htmlFor="log">{t("toplevel.log")}</Label>
              </div>

              <div className="flex items-center justify-between border-t pt-4">
                <div className="flex items-center space-x-2">
                  <Switch
                    id="statusline"
                    checked={config.StatusLine?.enabled || false}
                    onCheckedChange={handleStatusLineEnabledChange}
                  />
                  <Label htmlFor="statusline">{t("statusline.title")}</Label>
                </div>
                <Button variant="outline" size="sm" onClick={() => setIsStatusLineConfigOpen(true)}>
                  {t("app.settings")}
                </Button>
              </div>

              <div className="flex items-center space-x-2 border-t pt-4">
                <Switch
                  id="token-speed"
                  checked={config.Plugins?.some((p: any) => p.name === 'token-speed' && p.enabled) ?? false}
                  onCheckedChange={(checked) => {
                    const plugins = [...(config.Plugins || [])];
                    const idx = plugins.findIndex((p: any) => p.name === 'token-speed');
                    if (idx >= 0) {
                      plugins[idx] = { ...plugins[idx], enabled: checked };
                    } else {
                      plugins.push({ name: 'token-speed', enabled: checked });
                    }
                    setConfig({ ...config, Plugins: plugins });
                  }}
                />
                <Label htmlFor="token-speed">{t("settings.token_speed")}</Label>
              </div>

              <div className="flex items-center space-x-2 border-t pt-4">
                <Switch
                  id="disable-attribution-header"
                  checked={config.disableAttributionHeader !== false}
                  onCheckedChange={(checked) =>
                    setConfig({ ...config, disableAttributionHeader: checked })
                  }
                />
                <Label htmlFor="disable-attribution-header">
                  {t("settings.disable_attribution_header")}
                </Label>
              </div>

              {/* Concurrency Priority (global switch; config lives in Router.*) */}
              <div className="border-t pt-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-2">
                    <Switch
                      id="enable-concurrency-priority"
                      checked={routerConfig.enableConcurrencyPriority ?? false}
                      onCheckedChange={(checked) => handleRouterChange("enableConcurrencyPriority", checked)}
                    />
                    <Label htmlFor="enable-concurrency-priority">{t("settings.concurrency_priority_title")}</Label>
                  </div>
                  <div className={`flex items-center gap-2 transition-opacity ${routerConfig.enableConcurrencyPriority ? "" : "opacity-50 pointer-events-none"}`}>
                    <Label htmlFor="concurrency-threshold" className="text-xs text-gray-600">{t("router.concurrency_threshold")}</Label>
                    <Input
                      id="concurrency-threshold"
                      type="number"
                      min={1}
                      value={routerConfig.concurrencyThreshold ?? 3}
                      onChange={(e) => handleRouterChange("concurrencyThreshold", Math.max(1, parseInt(e.target.value) || 3))}
                      className="h-7 w-20 text-xs px-2"
                    />
                  </div>
                </div>
                <p className="mt-1 text-xs text-gray-500">
                  {t("settings.concurrency_priority_description")}
                  <span className="ml-1 text-gray-400">{t("router.concurrency_threshold_hint")}</span>
                </p>
              </div>

              <div className="space-y-4 border-t pt-4">
                <div className="flex items-center space-x-2">
                  <Switch
                    id="wakeup-enabled-global"
                    checked={config.WAKEUP_ENABLED ?? false}
                    onCheckedChange={(checked) => setConfig({ ...config, WAKEUP_ENABLED: checked })}
                  />
                  <Label htmlFor="wakeup-enabled-global">{t("settings.wakeup_enabled_global")}</Label>
                </div>
                {config.WAKEUP_ENABLED && (
                  <div className="grid grid-cols-2 gap-4 pt-1 animate-in fade-in slide-in-from-top-1 duration-200">
                    <div className="space-y-2">
                      <Label htmlFor="wakeup-time-global">{t("settings.wakeup_time_global")}</Label>
                      <Input
                        id="wakeup-time-global"
                        type="time"
                        value={config.WAKEUP_TIME || "06:00"}
                        onChange={(e) => setConfig({ ...config, WAKEUP_TIME: e.target.value })}
                      />
                    </div>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="claude-path">{t("toplevel.claude_path")}</Label>
                  <Input
                    id="claude-path"
                    value={config.CLAUDE_PATH || ""}
                    onChange={(e) => setConfig({ ...config, CLAUDE_PATH: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="host">{t("toplevel.host")}</Label>
                  <Input
                    id="host"
                    value={config.HOST || ""}
                    onChange={(e) => setConfig({ ...config, HOST: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="port">{t("toplevel.port")}</Label>
                  <Input
                    id="port"
                    type="number"
                    value={config.PORT ?? 3456}
                    onChange={(e) => setConfig({ ...config, PORT: parseInt(e.target.value, 10) })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="timeout">{t("toplevel.timeout")}</Label>
                  <Input
                    id="timeout"
                    value={config.API_TIMEOUT_MS || "600000"}
                    onChange={(e) => setConfig({ ...config, API_TIMEOUT_MS: e.target.value })}
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="probe-timeout">{t("toplevel.probe_timeout")}</Label>
                    <Input
                      id="probe-timeout"
                      type="number"
                      value={config.PROBE_TIMEOUT_MS ?? 15000}
                      onChange={(e) =>
                        setConfig({ ...config, PROBE_TIMEOUT_MS: parseInt(e.target.value, 10) || 15000 })
                      }
                      placeholder="15000"
                    />
                    <p className="text-xs text-gray-500">{t("toplevel.probe_timeout_desc")}</p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="probe-slow">{t("toplevel.probe_slow_threshold")}</Label>
                    <Input
                      id="probe-slow"
                      type="number"
                      value={config.PROBE_SLOW_THRESHOLD_MS ?? 3000}
                      onChange={(e) =>
                        setConfig({ ...config, PROBE_SLOW_THRESHOLD_MS: parseInt(e.target.value, 10) || 3000 })
                      }
                      placeholder="3000"
                    />
                    <p className="text-xs text-gray-500">{t("toplevel.probe_slow_threshold_desc")}</p>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="context-window">{t("toplevel.context_window")}</Label>
                  <Input
                    id="context-window"
                    type="number"
                    value={config.ContextWindow ?? 200000}
                    onChange={(e) =>
                      setConfig({ ...config, ContextWindow: parseInt(e.target.value, 10) || 200000 })
                    }
                    placeholder="200000"
                  />
                  <p className="text-xs text-gray-500">{t("toplevel.context_window_desc")}</p>
                  {showContextWindowWarning && (
                    <p className="text-xs text-red-500 dark:text-red-400">{t("toplevel.context_window_warn")}</p>
                  )}
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="ccr-proxy-config">{t("toplevel.proxy_url")}</Label>
                    <div className="flex items-center gap-2">
                      <Switch
                        id="proxy-global-enabled"
                        checked={isGlobalProxyEnabled(config.PROXY_GLOBAL_ENABLED)}
                        onCheckedChange={(checked) =>
                          setConfig({ ...config, PROXY_GLOBAL_ENABLED: checked })
                        }
                      />
                      <Label htmlFor="proxy-global-enabled" className="text-xs cursor-pointer">
                        {t("settings.proxy_global_enabled")}
                      </Label>
                    </div>
                  </div>
                  <Input
                    id="ccr-proxy-config"
                    value={config.PROXY_URL || ""}
                    onChange={(e) => setConfig({ ...config, PROXY_URL: e.target.value })}
                    placeholder="http://127.0.0.1:7890"
                    disableAutofill
                  />
                  <p className="text-xs text-gray-500">
                    {getConfiguredProxyUrl(config)
                      ? isGlobalProxyEnabled(config.PROXY_GLOBAL_ENABLED)
                        ? t("settings.proxy_global_hint_on")
                        : t("settings.proxy_global_hint_off")
                      : t("settings.proxy_global_hint_empty")}
                  </p>
                  {(config.PROXY_URL || "").trim() !== getConfiguredProxyUrl(config) && (
                    <p className="text-xs text-amber-500 dark:text-amber-400">
                      {t("settings.proxy_alias_hint")}
                    </p>
                  )}
                  <p className="text-xs text-gray-500">
                    {t("settings.proxy_security_hint")}
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="log-level">{t("toplevel.log_level")}</Label>
                  <Combobox
                    options={[
                      { label: "fatal", value: "fatal" },
                      { label: "error", value: "error" },
                      { label: "warn", value: "warn" },
                      { label: "info", value: "info" },
                      { label: "debug", value: "debug" },
                      { label: "trace", value: "trace" },
                    ]}
                    value={config.LOG_LEVEL || "error"}
                    onChange={(value) => setConfig({ ...config, LOG_LEVEL: value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="apikey">{t("toplevel.apikey")}</Label>
                  <Input
                    id="apikey"
                    type="password"
                    value={config.APIKEY || ""}
                    onChange={(e) => setConfig({ ...config, APIKEY: e.target.value })}
                    disableAutofill
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="custom-router-path">{t("toplevel.custom_router_path")}</Label>
                <Input
                  id="custom-router-path"
                  value={config.CUSTOM_ROUTER_PATH || ""}
                  onChange={(e) => setConfig({ ...config, CUSTOM_ROUTER_PATH: e.target.value })}
                  placeholder={t("toplevel.custom_router_path_placeholder")}
                />
              </div>

              {/* Language */}
              <div className="space-y-2 border-t pt-4">
                <Label>{t("settings.language")}</Label>
                <div className="flex gap-2">
                  <Button
                    variant={i18n.language.startsWith("en") ? "default" : "outline"}
                    size="sm"
                    onClick={() => i18n.changeLanguage("en")}
                  >
                    English
                  </Button>
                  <Button
                    variant={i18n.language.startsWith("zh") ? "default" : "outline"}
                    size="sm"
                    onClick={() => i18n.changeLanguage("zh")}
                  >
                    中文
                  </Button>
                </div>
              </div>
            </TabsContent>

            {/* Clients Tab */}
            <TabsContent value="clients" className="space-y-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h3 className="text-sm font-medium text-gray-700">{t("clients.title")}</h3>
                  <p className="text-xs text-gray-500">{t("clients.description")}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={loadClients} disabled={isLoadingClients || isApplyingClients}>
                    <RefreshCw className="mr-2 h-4 w-4" />
                    {t("clients.refresh")}
                  </Button>
                  <Button size="sm" onClick={applyClientSelection} disabled={isLoadingClients || isApplyingClients}>
                    <Save className="mr-2 h-4 w-4" />
                    {t("clients.apply")}
                  </Button>
                </div>
              </div>

              <div className="space-y-3">
                {clients.length === 0 && (
                  <div className="rounded-lg border border-dashed p-6 text-sm text-gray-500">
                    {isLoadingClients ? t("clients.loading") : t("clients.empty")}
                  </div>
                )}
                {clients.map((client) => {
                  const selected = selectedClientIds.includes(client.id);
                  return (
                    <div key={client.id} className="rounded-lg border bg-white/40 p-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex items-start gap-3">
                          <Switch
                            id={`client-${client.id}`}
                            checked={selected}
                            onCheckedChange={(checked) => handleClientSelectionChange(client.id, checked)}
                          />
                          <div className="space-y-1">
                            <Label htmlFor={`client-${client.id}`} className="text-sm font-medium">
                              {client.name}
                            </Label>
                            <div className="flex flex-wrap items-center gap-2 text-xs">
                              <span className={(client.enabled || client.managed) ? "rounded-full bg-green-100 px-2 py-0.5 text-green-700" : "rounded-full bg-gray-100 px-2 py-0.5 text-gray-600"}>
                                {(client.enabled || client.managed) ? t("clients.enabled") : t("clients.disabled")}
                              </span>
                              <span className={client.managed ? "rounded-full bg-blue-100 px-2 py-0.5 text-blue-700" : "rounded-full bg-gray-100 px-2 py-0.5 text-gray-600"}>
                                {client.managed ? t("clients.managed") : t("clients.official")}
                              </span>
                            </div>
                          </div>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => restoreClientOfficial(client.id)}
                          disabled={restoringClientId === client.id || isApplyingClients}
                        >
                          <RefreshCw className="mr-2 h-4 w-4" />
                          {t("clients.restore_official")}
                        </Button>
                      </div>

                      <div className="mt-4 grid grid-cols-1 gap-3 text-xs text-gray-600 md:grid-cols-3">
                        <div>
                          <div className="font-medium text-gray-500">{t("clients.config_path")}</div>
                          <div className="break-all text-gray-800">{client.configPath}</div>
                        </div>
                        <div>
                          <div className="font-medium text-gray-500">{t("clients.active_model")}</div>
                          <div className="break-all text-gray-800">{client.activeModel || "-"}</div>
                        </div>
                        <div>
                          <div className="font-medium text-gray-500">{t("clients.model_alias")}</div>
                          <div className="break-all text-gray-800">{client.modelAlias || "-"}</div>
                        </div>
                      </div>
                      {client.details && (
                        <div className="mt-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                          {client.details}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </TabsContent>

            {/* Router Tab */}
            <TabsContent value="router" className="space-y-6">
              <div>
                <h3 className="text-sm font-medium text-gray-700 mb-3">{t("router.title")}</h3>
                <div className="grid grid-cols-2 gap-4">
                  {/* Default */}
                  <div className="space-y-1.5">
                    <Label>{t("router.default")}</Label>
                    <Combobox
                      options={modelOptions}
                      value={routerConfig.default || ""}
                      onChange={(v) => handleRouterChange("default", v)}
                      placeholder={t("router.selectModel")}
                      searchPlaceholder={t("router.searchModel")}
                      emptyPlaceholder={t("router.noModelFound")}
                    />
                  </div>

                  {/* Think */}
                  <div className="space-y-1.5">
                    <Label>{t("router.think")}</Label>
                    <Combobox
                      options={modelOptions}
                      value={routerConfig.think || ""}
                      onChange={(v) => handleRouterChange("think", v)}
                      placeholder={t("router.selectModel")}
                      searchPlaceholder={t("router.searchModel")}
                      emptyPlaceholder={t("router.noModelFound")}
                    />
                  </div>

                  {/* Long Context */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <Label>{t("router.longContext")}</Label>
                      <div className="flex items-center gap-1">
                        <span className="text-[10px] text-gray-400">{t("router.longContextThreshold")}:</span>
                        <Input
                          type="number"
                          value={routerConfig.longContextThreshold || 60000}
                          onChange={(e) => handleRouterChange("longContextThreshold", parseInt(e.target.value) || 60000)}
                          className="h-5 w-20 text-[10px] px-1 py-0"
                        />
                      </div>
                    </div>
                    <Combobox
                      options={modelOptions}
                      value={routerConfig.longContext || ""}
                      onChange={(v) => handleRouterChange("longContext", v)}
                      placeholder={t("router.selectModel")}
                      searchPlaceholder={t("router.searchModel")}
                      emptyPlaceholder={t("router.noModelFound")}
                    />
                  </div>

                  {/* Extended Context */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Switch
                          id="enable-extended-context"
                          checked={routerConfig.enableExtendedContext ?? false}
                          onCheckedChange={(checked) => handleRouterChange("enableExtendedContext", checked)}
                        />
                        <Label htmlFor="enable-extended-context" className="cursor-pointer">{t("router.extendedContext")}</Label>
                      </div>
                      {routerConfig.enableExtendedContext && (
                        <div className="flex items-center gap-1">
                          <span className="text-[10px] text-gray-400">{t("router.extendedContextThreshold")}:</span>
                          <Input
                            type="number"
                            value={routerConfig.extendedContextThreshold || 200000}
                            onChange={(e) => handleRouterChange("extendedContextThreshold", parseInt(e.target.value) || 200000)}
                            className="h-5 w-20 text-[10px] px-1 py-0"
                          />
                        </div>
                      )}
                    </div>
                    <div className={routerConfig.enableExtendedContext ? "" : "opacity-50 pointer-events-none"}>
                      <Combobox
                        options={modelOptions}
                        value={routerConfig.extendedContext || ""}
                        onChange={(v) => handleRouterChange("extendedContext", v)}
                        placeholder={t("router.selectModel")}
                        searchPlaceholder={t("router.searchModel")}
                        emptyPlaceholder={t("router.noModelFound")}
                      />
                    </div>
                  </div>

                  {/* Web Search */}
                  <div className="space-y-1.5">
                    <Label>{t("router.webSearch")}</Label>
                    <Combobox
                      options={modelOptions}
                      value={routerConfig.webSearch || ""}
                      onChange={(v) => handleRouterChange("webSearch", v)}
                      placeholder={t("router.selectModel")}
                      searchPlaceholder={t("router.searchModel")}
                      emptyPlaceholder={t("router.noModelFound")}
                    />
                  </div>

                  {/* Image */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <Label>{t("router.image_beta")}</Label>
                      <div className="flex items-center gap-1">
                        <span className="text-[10px] text-gray-400">{t("router.forceUseImageAgent")}:</span>
                        <select
                          id="forceUseImageAgent"
                          value={config.forceUseImageAgent ? "true" : "false"}
                          onChange={(e) => setConfig({ ...config, forceUseImageAgent: e.target.value === "true" })}
                          className="h-5 w-16 rounded border bg-background text-[10px] px-1 py-0 cursor-pointer"
                        >
                          <option value="false">{t("common.no")}</option>
                          <option value="true">{t("common.yes")}</option>
                        </select>
                      </div>
                    </div>
                    <Combobox
                      options={modelOptions}
                      value={routerConfig.image || ""}
                      onChange={(v) => handleRouterChange("image", v)}
                      placeholder={t("router.selectModel")}
                      searchPlaceholder={t("router.searchModel")}
                      emptyPlaceholder={t("router.noModelFound")}
                    />
                  </div>
                </div>
              </div>

              {/* Fallback Configuration */}
              <div className="border-t pt-4">
                <div className="flex items-center justify-between mb-1">
                  <div>
                    <h3 className="text-sm font-medium text-gray-700">{t("settings.fallback_title")}</h3>
                    <p className="text-xs text-gray-500">{t("settings.fallback_description")}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      id="enable-fallback"
                      checked={routerConfig.enableFallback ?? false}
                      onCheckedChange={(checked) => handleRouterChange("enableFallback", checked)}
                    />
                    <Label htmlFor="enable-fallback" className="text-xs text-gray-500">
                      {routerConfig.enableFallback ? t("router.enabled") : t("router.disabled")}
                    </Label>
                  </div>
                </div>
                <div className={`grid grid-cols-2 gap-4 mb-3 transition-opacity ${routerConfig.enableFallback ? "" : "opacity-50 pointer-events-none"}`}>
                  {FALLBACK_SCENARIOS.map((scenario) => (
                    <div key={scenario} className="space-y-1.5">
                      <Label>{t(`router.${scenario}`)}</Label>
                      <MultiCombobox
                        options={modelOptions}
                        value={config.fallback?.[scenario] || []}
                        onChange={(value) => handleFallbackChange(scenario, value)}
                        placeholder={t("router.selectModel")}
                        searchPlaceholder={t("router.searchModel")}
                        emptyPlaceholder={t("router.noModelFound")}
                      />
                    </div>
                  ))}
                </div>
              </div>

              {/* Model Family Routing */}
              <div className="border-t pt-4">
                <div className="flex items-center justify-between mb-1">
                  <div>
                    <h3 className="text-sm font-medium text-gray-700">{t("router.family_routing")}</h3>
                    <p className="text-xs text-gray-500">{t("router.family_routing_desc")}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      id="enable-family-routing"
                      checked={routerConfig.enableFamilyRouting ?? false}
                      onCheckedChange={(checked) => handleRouterChange("enableFamilyRouting", checked)}
                    />
                    <Label htmlFor="enable-family-routing" className="text-xs text-gray-500">
                      {routerConfig.enableFamilyRouting ? t("router.enabled") : t("router.disabled")}
                    </Label>
                  </div>
                </div>
                {/* Predefined family buttons */}
                <div className={`flex gap-2 mb-3 transition-opacity ${routerConfig.enableFamilyRouting ? "" : "opacity-50 pointer-events-none"}`}>
                  {MODEL_FAMILIES.map((family) => {
                    const isConfigured = config.Router?.families?.[family];
                    const isExpanded = expandedFamily === family;
                    // Use outline variant for all buttons, control colors via className
                    // This ensures Tailwind classes override default variant styles
                    return (
                      <Button
                        key={family}
                        variant="outline"
                        size="sm"
                        onClick={() => handleAddFamily(family)}
                        className={`capitalize ${
                          isExpanded 
                            ? "bg-blue-500 hover:bg-blue-600 text-white border-blue-500 ring-2 ring-blue-300 shadow-sm" 
                            : isConfigured 
                              ? "bg-blue-100 text-blue-700 border-blue-300 hover:bg-blue-200" 
                              : "text-gray-500 hover:text-gray-700"
                        }`}
                      >
                        {family}
                        {!isConfigured && !isExpanded && " +"}
                      </Button>
                    );
                  })}
                </div>
                {/* Expanded family configuration */}
                {expandedFamily && (
                  <div className="border rounded-lg p-4 mt-3 bg-blue-50/30">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-blue-600 capitalize">{expandedFamily}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        {config.Router?.families?.[expandedFamily] && (
                          <Button variant="ghost" size="sm" className="h-6 text-xs text-red-400 hover:text-red-600" onClick={() => { handleRemoveFamily(expandedFamily); setExpandedFamily(null); }}>
                            {t("router.remove_family")}
                          </Button>
                        )}
                      </div>
                    </div>
                    {(config.Router?.families?.[expandedFamily] as any) && (
                      <>
                        <div className="grid grid-cols-2 gap-3">
                          <div className="space-y-1.5">
                            <Label>{t("router.default")}</Label>
                            <Combobox
                              options={modelOptions}
                              value={(config.Router?.families?.[expandedFamily] as any)?.default || ""}
                              onChange={(v) => handleFamilyChange(expandedFamily, "default", v)}
                              placeholder={t("router.selectModel")}
                              searchPlaceholder={t("router.searchModel")}
                              emptyPlaceholder={t("router.noModelFound")}
                            />
                          </div>
                          <div className="space-y-1.5">
                            <Label>{t("router.longContext")}</Label>
                            <Combobox
                              options={modelOptions}
                              value={(config.Router?.families?.[expandedFamily] as any)?.longContext || ""}
                              onChange={(v) => handleFamilyChange(expandedFamily, "longContext", v)}
                              placeholder={t("router.selectModel")}
                              searchPlaceholder={t("router.searchModel")}
                              emptyPlaceholder={t("router.noModelFound")}
                            />
                          </div>
                          <div className="space-y-1.5 flex items-center gap-2">
                            <Switch
                              id={`${expandedFamily}-enableExtendedContext`}
                              checked={(config.Router?.families?.[expandedFamily] as any)?.enableExtendedContext ?? false}
                              onCheckedChange={(checked) => handleFamilyChange(expandedFamily, "enableExtendedContext", checked)}
                            />
                            <div className="flex flex-col">
                              <Label htmlFor={`${expandedFamily}-enableExtendedContext`} className="text-sm">
                                {t("router.enableExtendedContext")}
                              </Label>
                              <span className="text-xs text-gray-500">
                                {t("router.enableExtendedContextDesc")}
                              </span>
                            </div>
                          </div>
                          <div className="space-y-1.5">
                            <Label>{t("router.extendedContext")}</Label>
                            <Combobox
                              options={modelOptions}
                              value={(config.Router?.families?.[expandedFamily] as any)?.extendedContext || ""}
                              onChange={(v) => handleFamilyChange(expandedFamily, "extendedContext", v)}
                              placeholder={t("router.selectModel")}
                              searchPlaceholder={t("router.searchModel")}
                              emptyPlaceholder={t("router.noModelFound")}
                            />
                          </div>
                          <div className="space-y-1.5">
                            <Label>{t("router.think")}</Label>
                            <Combobox
                              options={modelOptions}
                              value={(config.Router?.families?.[expandedFamily] as any)?.think || ""}
                              onChange={(v) => handleFamilyChange(expandedFamily, "think", v)}
                              placeholder={t("router.selectModel")}
                              searchPlaceholder={t("router.searchModel")}
                              emptyPlaceholder={t("router.noModelFound")}
                            />
                          </div>
                          <div className="space-y-1.5">
                            <Label>{t("router.webSearch")}</Label>
                            <Combobox
                              options={modelOptions}
                              value={(config.Router?.families?.[expandedFamily] as any)?.webSearch || ""}
                              onChange={(v) => handleFamilyChange(expandedFamily, "webSearch", v)}
                              placeholder={t("router.selectModel")}
                              searchPlaceholder={t("router.searchModel")}
                              emptyPlaceholder={t("router.noModelFound")}
                            />
                          </div>
                          <div className="space-y-1.5">
                            <Label>{t("router.image")}</Label>
                            <Combobox
                              options={modelOptions}
                              value={(config.Router?.families?.[expandedFamily] as any)?.image || ""}
                              onChange={(v) => handleFamilyChange(expandedFamily, "image", v)}
                              placeholder={t("router.selectModel")}
                              searchPlaceholder={t("router.searchModel")}
                              emptyPlaceholder={t("router.noModelFound")}
                            />
                          </div>
                        </div>
                        {/* Family Fallback */}
                        <div className="border-t mt-3 pt-3">
                          <h4 className="text-xs font-medium text-gray-500 mb-2">{t("router.family_fallback_title")}</h4>
                          <div className="grid grid-cols-2 gap-3">
                            {FALLBACK_SCENARIOS.map((scenario) => (
                              <div key={`${expandedFamily}-${scenario}`} className="space-y-1">
                                <Label className="text-xs">{t(`router.${scenario}`)}</Label>
                                <MultiCombobox
                                  options={modelOptions}
                                  value={(config.Router?.families?.[expandedFamily] as any)?.fallback?.[scenario] || []}
                                  onChange={(value) => handleFamilyFallbackChange(expandedFamily, scenario, value)}
                                  placeholder={t("router.selectModel")}
                                  searchPlaceholder={t("router.searchModel")}
                                  emptyPlaceholder={t("router.noModelFound")}
                                />
                              </div>
                            ))}
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            </TabsContent>

            {/* Projects Tab */}
            <TabsContent value="projects" className="space-y-4">
              <ProjectsPage />
            </TabsContent>

            {/* Usage Tab */}
            <TabsContent value="usage" className="h-[calc(100vh-10rem)]">
              <UsageStats />
            </TabsContent>

            {/* Tools Tab */}
            <TabsContent value="tools" className="space-y-2">
              {tools.map((tool) => (
                <button
                  key={tool.label}
                  className="w-full flex items-center gap-3 rounded-lg border p-4 text-left hover:bg-gray-50 transition-colors"
                  onClick={() => tool.onClick ? tool.onClick() : navigate(tool.href || '/')}
                >
                  <tool.icon className="h-5 w-5 text-gray-500 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">{tool.label}</div>
                    <div className="text-xs text-gray-500">{tool.desc}</div>
                  </div>
                </button>
              ))}
            </TabsContent>
          </Tabs>
        </div>
      </main>

      <StatusLineConfigDialog
        isOpen={isStatusLineConfigOpen}
        onOpenChange={setIsStatusLineConfigOpen}
        data-testid="statusline-config-dialog"
      />

      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          onClose={() => setToast(null)}
        />
      )}

      <Dialog open={proxyValidationErrors.length > 0} onOpenChange={(open) => { if (!open) cancelProxyInvalidSave(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("settings.proxy_invalid_title")}</DialogTitle>
            <DialogDescription>
              {t("settings.proxy_invalid_message")}
            </DialogDescription>
          </DialogHeader>
          <ul className="text-xs text-red-600 dark:text-red-400 space-y-1 max-h-[40vh] overflow-auto">
            {proxyValidationErrors.map((entry) => (
              <li key={entry.key}>
                <span className="font-medium">{entry.key}</span>: {entry.error}
              </li>
            ))}
          </ul>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={cancelProxyInvalidSave}>
              {t("settings.proxy_invalid_cancel")}
            </Button>
            <Button variant="destructive" size="sm" onClick={confirmProxyInvalidSave}>
              {t("settings.proxy_invalid_confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    <LogViewer
      open={isLogViewerOpen}
      onOpenChange={setIsLogViewerOpen}
    />
    <LogViewer
      open={isLogViewerOpen}
      onOpenChange={setIsLogViewerOpen}
    />
    </div>
  );
}
