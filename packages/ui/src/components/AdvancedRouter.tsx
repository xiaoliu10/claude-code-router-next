import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Plus, Trash2, Settings2, Save, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Combobox } from "@/components/ui/combobox";
import { Toast } from "@/components/ui/toast";
import { useConfig } from "@/components/ConfigProvider";
import { api } from "@/lib/api";

interface MappingRow {
  source: string;
  target: string;
}

export function AdvancedRouter() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { config, saveDraft, revision, error } = useConfig();
  const [editorRevision, setEditorRevision] = useState<string | null | undefined>(undefined);
  const [rows, setRows] = useState<MappingRow[]>([{ source: "", target: "" }]);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'warning' } | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);

  const providers = Array.isArray(config?.Providers) ? config.Providers : [];
  const modelOptions = useMemo(
    () => providers.flatMap((provider) => {
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

  useEffect(() => {
    if (!config || editorRevision !== undefined) return;
    setEditorRevision(revision);
    const models = config.Router?.models || {};
    const entries = Object.entries(models).map(([source, target]) => ({ source, target }));
    setRows(entries.length > 0 ? entries : [{ source: "", target: "" }]);
  }, [config, revision, editorRevision]);

  const buildModels = (entries: MappingRow[]) => {
    return entries.reduce<Record<string, string>>((acc, item) => {
      const source = item.source.trim();
      const target = item.target.trim();
      if (source && target) {
        acc[source] = target;
      }
      return acc;
    }, {});
  };

  const syncConfig = () => {
    if (!config) return null;
    const nextConfig = {
      ...config,
      Router: {
        ...(config.Router || {}),
        models: buildModels(rows),
      },
    };
    return nextConfig;
  };

  const handleRowChange = (index: number, field: keyof MappingRow, value: string) => {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, [field]: value } : row)));
  };

  const handleAddRow = () => {
    setRows((current) => [...current, { source: "", target: "" }]);
  };

  const handleRemoveRow = (index: number) => {
    setRows((current) => {
      const next = current.filter((_, i) => i !== index);
      return next.length > 0 ? next : [{ source: "", target: "" }];
    });
  };

  const saveConfig = async () => {
    if (!config) return;
    setIsSaving(true);
    try {
      const nextConfig = syncConfig();
      if (!nextConfig) return;
      const response = await saveDraft(nextConfig, editorRevision ?? null);
      if (response.success) {
        setEditorRevision(undefined);
        setToast({ message: response.message || t("app.config_saved_success"), type: "success" });
      } else {
        setToast({ message: response.message || t("app.config_saved_failed"), type: "error" });
      }
    } catch (error) {
      setToast({ message: `${t("app.config_saved_failed")}: ${(error as Error).message}`, type: "error" });
    } finally {
      setIsSaving(false);
    }
  };

  const saveConfigAndRestart = async () => {
    if (!config) return;
    setIsRestarting(true);
    try {
      const nextConfig = syncConfig();
      if (!nextConfig) return;
      const response = await saveDraft(nextConfig, editorRevision ?? null);
      if (!response.success) {
        setToast({ message: response.message || t("app.config_saved_failed"), type: "error" });
        return;
      }

      setEditorRevision(undefined);
      const restartResponse = await api.restartService();
      if (restartResponse && typeof restartResponse === "object" && "success" in restartResponse) {
        const apiResponse = restartResponse as { success: boolean; message?: string };
        setToast({
          message: apiResponse.message || (apiResponse.success ? t("app.config_saved_restart_success") : t("app.config_saved_restart_failed")),
          type: apiResponse.success ? "success" : "error",
        });
      } else {
        setToast({ message: t("app.config_saved_restart_success"), type: "success" });
      }
    } catch (error) {
      setToast({ message: `${t("app.config_saved_restart_failed")}: ${(error as Error).message}`, type: "error" });
    } finally {
      setIsRestarting(false);
    }
  };

  if (!config) {
    return (
      <div className="h-screen bg-gray-50 font-sans flex items-center justify-center">
        <div className="text-gray-500">Loading advanced router configuration...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-screen bg-gray-50 font-sans flex items-center justify-center">
        <div className="text-red-500">Error: {error.message}</div>
      </div>
    );
  }

  return (
    <div className="h-screen bg-gray-50 font-sans">
      <header className="flex h-16 items-center justify-between border-b bg-white px-6">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="sm" onClick={() => navigate('/dashboard')}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            {t('advanced_router.back')}
          </Button>
          <div className="flex items-center gap-3">
            <Settings2 className="h-5 w-5 text-gray-600" />
            <div>
              <h1 className="text-xl font-semibold text-gray-800">{t('advanced_router.title')}</h1>
              <p className="text-sm text-gray-500">{t('advanced_router.subtitle')}</p>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={saveConfig} disabled={isSaving || isRestarting} variant="outline" className="transition-all-ease hover:scale-[1.02] active:scale-[0.98]">
            <Save className="mr-2 h-4 w-4" />
            {t('app.save')}
          </Button>
          <Button onClick={saveConfigAndRestart} disabled={isSaving || isRestarting} className="transition-all-ease hover:scale-[1.02] active:scale-[0.98]">
            <RefreshCw className="mr-2 h-4 w-4" />
            {t('app.save_and_restart')}
          </Button>
        </div>
      </header>

      <main className="h-[calc(100vh-4rem)] overflow-auto p-4">
        <div className="mx-auto flex max-w-6xl flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>{t('advanced_router.model_mappings')}</CardTitle>
              <CardDescription>{t('advanced_router.model_mappings_help')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-3">
                {rows.map((row, index) => (
                  <div key={`${index}-${row.source}-${row.target}`} className="grid grid-cols-12 gap-3 rounded-lg border p-3">
                    <div className="col-span-4 space-y-2">
                      <Label>{t('advanced_router.source_model')}</Label>
                      <Input
                        value={row.source}
                        onChange={(e) => handleRowChange(index, 'source', e.target.value)}
                        placeholder={t('advanced_router.source_placeholder')}
                      />
                    </div>
                    <div className="col-span-7 space-y-2">
                      <Label>{t('advanced_router.target_model')}</Label>
                      <Combobox
                        options={modelOptions}
                        value={row.target}
                        onChange={(value) => handleRowChange(index, 'target', value)}
                        placeholder={t('router.selectModel')}
                        searchPlaceholder={t('router.searchModel')}
                        emptyPlaceholder={t('router.noModelFound')}
                      />
                    </div>
                    <div className="col-span-1 flex items-end justify-end">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleRemoveRow(index)}
                        className="text-red-500 hover:text-red-600"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>

              <div className="rounded-lg border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground">
                {t('advanced_router.source_placeholder')}
              </div>

              <Button variant="outline" onClick={handleAddRow}>
                <Plus className="mr-2 h-4 w-4" />
                {t('advanced_router.add_mapping')}
              </Button>
            </CardContent>
          </Card>
        </div>
      </main>

      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          onClose={() => setToast(null)}
        />
      )}
    </div>
  );
}
