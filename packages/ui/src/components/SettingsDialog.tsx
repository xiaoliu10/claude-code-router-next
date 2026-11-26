import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Combobox } from "@/components/ui/combobox";
import { MultiCombobox } from "@/components/ui/multi-combobox";
import { useConfig } from "./ConfigProvider";
import { StatusLineConfigDialog } from "./StatusLineConfigDialog";
import { useState, useMemo } from "react";
import type { StatusLineConfig, FallbackConfig } from "@/types";
import { FileJson, FileText, BarChart3, CircleArrowUp, FileCog, Languages } from "lucide-react";

interface SettingsDialogProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  onOpenJsonEditor?: () => void;
  onOpenLogViewer?: () => void;
  onOpenUsageStats?: () => void;
  onCheckUpdates?: () => void;
  isCheckingUpdate?: boolean;
  onUpdateAvailable?: boolean;
}

const FALLBACK_SCENARIOS = ["default", "think", "longContext", "webSearch", "image"] as const;

export function SettingsDialog({
  isOpen,
  onOpenChange,
  onOpenJsonEditor,
  onOpenLogViewer,
  onOpenUsageStats,
  onCheckUpdates,
  isCheckingUpdate,
  onUpdateAvailable,
}: SettingsDialogProps) {
  const { t, i18n } = useTranslation();
  const { config, setConfig } = useConfig();
  const [isStatusLineConfigOpen, setIsStatusLineConfigOpen] = useState(false);

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

  if (!config) {
    return null;
  }

  const routerConfig = config.Router || {
    default: "",
    think: "",
    longContext: "",
    longContextThreshold: 60000,
    webSearch: "",
    image: "",
  };

  const handleRouterChange = (field: string, value: string | number | boolean) => {
    const currentRouter = config.Router || {};
    setConfig({ ...config, Router: { ...currentRouter, [field]: value } });
  };

  const handleFallbackChange = (scenario: string, value: string[]) => {
    const currentFallback = config.fallback || {};
    const updated = { ...currentFallback, [scenario]: value };
    // Remove empty arrays to keep config clean
    if (value.length === 0) {
      delete updated[scenario];
    }
    // Only set fallback if there's at least one scenario configured
    if (Object.keys(updated).length === 0) {
      const { fallback, ...rest } = config;
      setConfig(rest);
    } else {
      setConfig({ ...config, fallback: updated as FallbackConfig });
    }
  };

  const handleStatusLineEnabledChange = (checked: boolean) => {
    const newStatusLineConfig: StatusLineConfig = {
      ...config.StatusLine,
      enabled: checked,
      currentStyle: config.StatusLine?.currentStyle || "default",
      default: config.StatusLine?.default || { modules: [] },
      powerline: config.StatusLine?.powerline || { modules: [] },
    };
    setConfig({ ...config, StatusLine: newStatusLineConfig });
  };

  // Tools list for Tools tab
  const tools = [
    {
      icon: FileJson,
      label: t("settings.tools.json_editor"),
      desc: t("settings.tools.json_editor_desc"),
      action: onOpenJsonEditor,
    },
    {
      icon: FileText,
      label: t("settings.tools.log_viewer"),
      desc: t("settings.tools.log_viewer_desc"),
      action: onOpenLogViewer,
    },
    {
      icon: BarChart3,
      label: t("settings.tools.usage_stats"),
      desc: t("settings.tools.usage_stats_desc"),
      action: onOpenUsageStats,
    },
    {
      icon: CircleArrowUp,
      label: t("settings.tools.check_updates"),
      desc: t("settings.tools.check_updates_desc"),
      action: onCheckUpdates,
      badge: onUpdateAvailable ? "!" : undefined,
      disabled: isCheckingUpdate,
    },
    {
      icon: FileCog,
      label: t("settings.tools.presets"),
      desc: t("settings.tools.presets_desc"),
      href: "/presets",
    },
  ];

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent data-testid="settings-dialog" className="max-w-2xl max-h-[80vh] flex flex-col p-0 glass-card border-white/10 shadow-2xl overflow-hidden bg-background/80 backdrop-blur-xl">
        <DialogHeader className="p-6 pb-2">
          <DialogTitle className="text-xl font-bold tracking-tight text-foreground">{t("toplevel.title")}</DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="general" className="flex-1 flex flex-col min-h-0">
          <TabsList className="mx-6 w-auto justify-start bg-white/5 border border-white/10 p-1 rounded-xl">
            <TabsTrigger value="general" className="rounded-lg data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">{t("settings.tabs.general")}</TabsTrigger>
            <TabsTrigger value="router" className="rounded-lg data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">{t("settings.tabs.router")}</TabsTrigger>
            <TabsTrigger value="tools" className="rounded-lg data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">{t("settings.tabs.tools")}</TabsTrigger>
          </TabsList>

          {/* General Tab */}
          <TabsContent value="general" className="overflow-y-auto flex-1 px-8 py-4 space-y-4">
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

            {/* StatusLine */}
            <div className="space-y-2 border-t pt-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <Switch
                    id="statusline"
                    checked={config.StatusLine?.enabled || false}
                    onCheckedChange={handleStatusLineEnabledChange}
                  />
                  <Label htmlFor="statusline">{t("statusline.title")}</Label>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setIsStatusLineConfigOpen(true)}
                  data-testid="statusline-config-button"
                >
                  {t("app.settings")}
                </Button>
              </div>
            </div>

            <div className="space-y-4 border-t pt-4">
              <div className="flex items-center space-x-2">
                <Switch
                  id="wakeup-enabled-global-dialog"
                  checked={config.WAKEUP_ENABLED ?? false}
                  onCheckedChange={(checked) => setConfig({ ...config, WAKEUP_ENABLED: checked })}
                />
                <Label htmlFor="wakeup-enabled-global-dialog">{t("settings.wakeup_enabled_global")}</Label>
              </div>
              {config.WAKEUP_ENABLED && (
                <div className="grid grid-cols-2 gap-4 pt-1 animate-in fade-in slide-in-from-top-1 duration-200">
                  <div className="space-y-2">
                    <Label htmlFor="wakeup-time-global-dialog">{t("settings.wakeup_time_global")}</Label>
                    <Input
                      id="wakeup-time-global-dialog"
                      type="time"
                      value={config.WAKEUP_TIME || "06:00"}
                      onChange={(e) => setConfig({ ...config, WAKEUP_TIME: e.target.value })}
                    />
                  </div>
                </div>
              )}
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

            <div className="space-y-2">
              <Label htmlFor="ccr-proxy-config">{t("toplevel.proxy_url")}</Label>
              <Input
                id="ccr-proxy-config"
                value={config.PROXY_URL || ""}
                onChange={(e) => setConfig({ ...config, PROXY_URL: e.target.value })}
                placeholder="http://127.0.0.1:7890"
                disableAutofill
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

          {/* Router Tab */}
          <TabsContent value="router" className="overflow-y-auto flex-1 px-8 py-4 space-y-6">
            {/* Scenario Model Mapping */}
            <div>
              <h3 className="text-sm font-medium text-gray-700 mb-3">{t("router.title")}</h3>
              <div className="space-y-3">
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
                <div className="space-y-1.5">
                  <div className="flex items-end gap-3">
                    <div className="flex-1">
                      <Label>{t("router.longContext")}</Label>
                      <Combobox
                        options={modelOptions}
                        value={routerConfig.longContext || ""}
                        onChange={(v) => handleRouterChange("longContext", v)}
                        placeholder={t("router.selectModel")}
                        searchPlaceholder={t("router.searchModel")}
                        emptyPlaceholder={t("router.noModelFound")}
                      />
                    </div>
                    <div className="w-36">
                      <Label>{t("router.longContextThreshold")}</Label>
                      <Input
                        type="number"
                        value={routerConfig.longContextThreshold || 60000}
                        onChange={(e) => handleRouterChange("longContextThreshold", parseInt(e.target.value) || 60000)}
                      />
                    </div>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <Switch
                      id="enable-extended-context"
                      checked={routerConfig.enableExtendedContext ?? false}
                      onCheckedChange={(checked) => handleRouterChange("enableExtendedContext", checked)}
                    />
                    <div className="flex flex-col">
                      <Label htmlFor="enable-extended-context" className="text-sm">
                        {t("router.enableExtendedContext")}
                      </Label>
                      <span className="text-xs text-gray-500">
                        {t("router.enableExtendedContextDesc")}
                      </span>
                    </div>
                  </div>
                  {routerConfig.enableExtendedContext && (
                    <div className="flex items-end gap-3 ml-6">
                      <div className="flex-1">
                        <Label>{t("router.extendedContext")}</Label>
                        <Combobox
                          options={modelOptions}
                          value={routerConfig.extendedContext || ""}
                          onChange={(v) => handleRouterChange("extendedContext", v)}
                          placeholder={t("router.selectModel")}
                          searchPlaceholder={t("router.searchModel")}
                          emptyPlaceholder={t("router.noModelFound")}
                        />
                      </div>
                      <div className="w-36">
                        <Label>{t("router.extendedContextThreshold")}</Label>
                        <Input
                          type="number"
                          value={routerConfig.extendedContextThreshold || 200000}
                          onChange={(e) => handleRouterChange("extendedContextThreshold", parseInt(e.target.value) || 200000)}
                        />
                      </div>
                    </div>
                  )}
                </div>
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
                <div className="space-y-1.5">
                  <div className="flex items-end gap-3">
                    <div className="flex-1">
                      <Label>{t("router.image_beta")}</Label>
                      <Combobox
                        options={modelOptions}
                        value={routerConfig.image || ""}
                        onChange={(v) => handleRouterChange("image", v)}
                        placeholder={t("router.selectModel")}
                        searchPlaceholder={t("router.searchModel")}
                        emptyPlaceholder={t("router.noModelFound")}
                      />
                    </div>
                    <div className="w-36">
                      <Label htmlFor="forceUseImageAgent">{t("router.forceUseImageAgent")}</Label>
                      <select
                        id="forceUseImageAgent"
                        value={config.forceUseImageAgent ? "true" : "false"}
                        onChange={(e) => setConfig({ ...config, forceUseImageAgent: e.target.value === "true" })}
                        className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                      >
                        <option value="false">{t("common.no")}</option>
                        <option value="true">{t("common.yes")}</option>
                      </select>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Fallback Configuration */}
            <div className="border-t pt-4">
              <h3 className="text-sm font-medium text-gray-700 mb-1">{t("settings.fallback_title")}</h3>
              <p className="text-xs text-gray-500 mb-3">{t("settings.fallback_description")}</p>
              <div className="space-y-3">
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
          </TabsContent>

          {/* Tools Tab */}
          <TabsContent value="tools" className="overflow-y-auto flex-1 px-8 py-4 space-y-2">
            {tools.map((tool) => (
              <button
                key={tool.label}
                className="w-full flex items-center gap-3 rounded-lg border p-3 text-left hover:bg-gray-50 transition-colors disabled:opacity-50"
                onClick={() => {
                  if (tool.href) {
                    onOpenChange(false);
                    window.location.hash = tool.href;
                  } else {
                    tool.action?.();
                    onOpenChange(false);
                  }
                }}
                disabled={tool.disabled}
              >
                <tool.icon className="h-5 w-5 text-gray-500 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium flex items-center gap-2">
                    {tool.label}
                    {tool.badge && (
                      <span className="inline-block w-2 h-2 bg-red-500 rounded-full" />
                    )}
                  </div>
                  <div className="text-xs text-gray-500">{tool.desc}</div>
                </div>
              </button>
            ))}
          </TabsContent>
        </Tabs>
      </DialogContent>

      <StatusLineConfigDialog
        isOpen={isStatusLineConfigOpen}
        onOpenChange={setIsStatusLineConfigOpen}
        data-testid="statusline-config-dialog"
      />
    </Dialog>
  );
}
