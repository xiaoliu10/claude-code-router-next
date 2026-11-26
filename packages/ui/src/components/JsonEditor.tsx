import { useState, useEffect, useRef } from 'react';
import Editor from '@monaco-editor/react';
import { Button } from '@/components/ui/button';
import { useConfig } from '@/components/ConfigProvider';
import { api } from '@/lib/api';
import { useTranslation } from 'react-i18next';
import { Save, X, RefreshCw, ArrowLeft } from 'lucide-react';
import { findInvalidProxyUrls } from '@/utils/proxy';
import type { Config } from '@/types';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';

interface JsonEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  showToast?: (message: string, type: 'success' | 'error' | 'warning') => void;
}

export function JsonEditor({ open, onOpenChange, showToast }: JsonEditorProps) {
  const { t } = useTranslation();
  const { config } = useConfig();
  const [jsonValue, setJsonValue] = useState<string>('');
  const [isSaving, setIsSaving] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const [isAnimating, setIsAnimating] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [proxyValidationErrors, setProxyValidationErrors] = useState<Array<{ key: string; error: string }>>([]);
  const [pendingAction, setPendingAction] = useState<"save" | "saveAndRestart" | null>(null);

  // Shared pre-save gate: if any proxy URL in the parsed config is invalid,
  // surface a confirmation dialog. Server will still reject with 400.
  const runWithProxyCheck = (
    parsedConfig: Record<string, unknown>,
    action: "save" | "saveAndRestart",
    proceed: () => void | Promise<void>,
  ) => {
    const errors = findInvalidProxyUrls(parsedConfig);
    if (errors.length > 0) {
      setProxyValidationErrors(errors);
      setPendingAction(action);
      return;
    }
    void proceed();
  };

  useEffect(() => {
    if (config && open) {
      setJsonValue(JSON.stringify(config, null, 2));
    }
  }, [config, open]);

  // Handle open/close animations
  useEffect(() => {
    if (open) {
      setIsVisible(true);
      // Trigger the animation after a small delay to ensure the element is rendered
      requestAnimationFrame(() => {
        setIsAnimating(true);
      });
    } else {
      setIsAnimating(false);
      // Wait for the animation to complete before hiding
      const timer = setTimeout(() => {
        setIsVisible(false);
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [open]);

  const handleSaveResponse = (response: unknown, successMessage: string, errorMessage: string) => {
    // 根据响应信息进行提示
    if (response && typeof response === 'object' && 'success' in response) {
      const apiResponse = response as { success: boolean; message?: string };
      if (apiResponse.success) {
        if (showToast) {
          showToast(apiResponse.message || successMessage, 'success');
        }
        return true;
      } else {
        if (showToast) {
          showToast(apiResponse.message || errorMessage, 'error');
        }
        return false;
      }
    } else {
      // 默认成功提示
      if (showToast) {
        showToast(successMessage, 'success');
      }
      return true;
    }
  };

  const performSave = async (parsedConfig: Config) => {
    try {
      setIsSaving(true);
      const response = await api.updateConfig(parsedConfig, "raw");

      const success = handleSaveResponse(
        response,
        t('app.config_saved_success'),
        t('app.config_saved_failed')
      );

      if (success) {
        onOpenChange(false);
      }
    } catch (error) {
      console.error('Failed to save config:', error);
      if (showToast) {
        showToast(t('app.config_saved_failed') + ': ' + (error as Error).message, 'error');
      }
    } finally {
      setIsSaving(false);
    }
  };

  const performSaveAndRestart = async (parsedConfig: Config) => {
    try {
      setIsSaving(true);
      // Save config first
      const saveResponse = await api.updateConfig(parsedConfig, "raw");
      const saveSuccessful = handleSaveResponse(
        saveResponse,
        t('app.config_saved_success'),
        t('app.config_saved_failed')
      );

      // Only restart if save was successful
      if (saveSuccessful) {
        // Restart service
        const restartResponse = await api.restartService();

        handleSaveResponse(
          restartResponse,
          t('app.config_saved_restart_success'),
          t('app.config_saved_restart_failed')
        );

        onOpenChange(false);
      }
    } catch (error) {
      console.error('Failed to save config and restart:', error);
      if (showToast) {
        showToast(t('app.config_saved_restart_failed') + ': ' + (error as Error).message, 'error');
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleSave = async () => {
    if (!jsonValue) return;

    let parsedConfig: Config;
    try {
      parsedConfig = JSON.parse(jsonValue) as Config;
    } catch (error) {
      if (showToast) {
        showToast(t('app.config_saved_failed') + ': ' + (error as Error).message, 'error');
      }
      return;
    }

    runWithProxyCheck(parsedConfig as Record<string, unknown>, "save", async () => performSave(parsedConfig));
  };

  const handleSaveAndRestart = async () => {
    if (!jsonValue) return;

    let parsedConfig: Config;
    try {
      parsedConfig = JSON.parse(jsonValue) as Config;
    } catch (error) {
      if (showToast) {
        showToast(t('app.config_saved_restart_failed') + ': ' + (error as Error).message, 'error');
      }
      return;
    }

    runWithProxyCheck(parsedConfig as Record<string, unknown>, "saveAndRestart", async () => performSaveAndRestart(parsedConfig));
  };

  const confirmProxyInvalidSave = async () => {
    // Snapshot the JSON before clearing the dialog so the user's edits are
    // preserved; re-parse and execute the inner save (bypassing the check).
    const snapshot = jsonValue;
    const action = pendingAction;
    setProxyValidationErrors([]);
    setPendingAction(null);

    let parsedConfig: Config;
    try {
      parsedConfig = JSON.parse(snapshot) as Config;
    } catch (error) {
      if (showToast) {
        showToast(t('app.config_saved_failed') + ': ' + (error as Error).message, 'error');
      }
      return;
    }

    if (action === "save") {
      await performSave(parsedConfig);
    } else if (action === "saveAndRestart") {
      await performSaveAndRestart(parsedConfig);
    }
  };

  const cancelProxyInvalidSave = () => {
    setProxyValidationErrors([]);
    setPendingAction(null);
  };

  if (!isVisible && !open) {
    return null;
  }

  return (
    <>
      {(isVisible || open) && (
        <div 
          className={`fixed inset-0 z-50 transition-all duration-300 ease-out ${
            isAnimating && open ? 'bg-black/50 opacity-100' : 'bg-black/0 opacity-0 pointer-events-none'
          }`}
          onClick={() => onOpenChange(false)}
        />
      )}
      
      <div 
        ref={containerRef}
        className={`fixed bottom-0 left-0 right-0 z-50 flex flex-col bg-white shadow-2xl transition-all duration-300 ease-out transform ${
          isAnimating && open ? 'translate-y-0' : 'translate-y-full'
        }`}
        style={{ 
          height: '100vh',
          maxHeight: '100vh'
        }}
      >
        <div className="flex items-center justify-between border-b p-4">
          <div className="flex items-center gap-4">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={isSaving}
            >
              <ArrowLeft className="h-4 w-4 mr-2" />
              {t('json_editor.cancel')}
            </Button>
            <h2 className="text-lg font-semibold">{t('json_editor.title')}</h2>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleSave}
              disabled={isSaving}
            >
              <Save className="h-4 w-4 mr-2" />
              {isSaving ? t('json_editor.saving') : t('json_editor.save')}
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={handleSaveAndRestart}
              disabled={isSaving}
            >
              <RefreshCw className="h-4 w-4 mr-2" />
              {isSaving ? t('json_editor.saving') : t('json_editor.save_and_restart')}
            </Button>
          </div>
        </div>
        
        <div className="flex-1 min-h-0 bg-gray-50">
          <Editor
            height="100%"
            defaultLanguage="json"
            value={jsonValue}
            onChange={(value) => setJsonValue(value || '')}
            theme="vs"
            options={{
              minimap: { enabled: true },
              fontSize: 14,
              scrollBeyondLastLine: false,
              automaticLayout: true,
              wordWrap: 'on',
              formatOnPaste: true,
              formatOnType: true,
              suggest: {
                showKeywords: true,
                showSnippets: true,
              },
            }}
          />
        </div>
      </div>

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
    </>
  );
}