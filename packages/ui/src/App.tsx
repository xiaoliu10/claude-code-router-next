import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Transformers } from "@/components/Transformers";
import { Providers } from "@/components/Providers";
import { Router } from "@/components/Router";
import { JsonEditor } from "@/components/JsonEditor";
import { LogViewer } from "@/components/LogViewer";
import { Button } from "@/components/ui/button";
import { useConfig } from "@/components/ConfigProvider";
import { api } from "@/lib/api";
import { Settings, Save, RefreshCw, LayoutDashboard, CircleArrowUp } from "lucide-react";
import { Toast } from "@/components/ui/toast";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Background } from "@/components/ui/Background";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import "@/styles/animations.css";

function App() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { config, saveDraft, error } = useConfig();
  const [isJsonEditorOpen, setIsJsonEditorOpen] = useState(false);
  const [isLogViewerOpen, setIsLogViewerOpen] = useState(false);
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'warning' } | null>(null);
  const [isNewVersionAvailable, setIsNewVersionAvailable] = useState(false);
  const [isUpdateDialogOpen, setIsUpdateDialogOpen] = useState(false);
  const [newVersionInfo, setNewVersionInfo] = useState<{ version: string; changelog: string } | null>(null);
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
  const [isPerformingUpdate, setIsPerformingUpdate] = useState(false);
  const [hasCheckedUpdate, setHasCheckedUpdate] = useState(false);
  const [isUpdateFeatureAvailable, setIsUpdateFeatureAvailable] = useState(true);
  const hasAutoCheckedUpdate = useRef(false);

  const saveConfig = async () => {
    if (!config) {
      setToast({ message: t('app.config_missing'), type: 'error' });
      return;
    }
    try {
      const response = await saveDraft(config);
      if (response.success) {
        setToast({ message: response.message || t('app.config_saved_success'), type: 'success' });
      } else {
        setToast({ message: response.message || t('app.config_saved_failed'), type: 'error' });
      }
    } catch (error) {
      console.error('Failed to save config:', error);
      setToast({ message: t('app.config_saved_failed') + ': ' + (error as Error).message, type: 'error' });
    }
  };

  const saveConfigAndRestart = async () => {
    if (!config) {
      setToast({ message: t('app.config_missing'), type: 'error' });
      return;
    }
    try {
      const response = await saveDraft(config);
      if (!response.success) {
        setToast({ message: response.message || t('app.config_saved_failed'), type: 'error' });
        return;
      }
      const restartResponse = await api.restartService();
      if (restartResponse && typeof restartResponse === 'object' && 'success' in restartResponse) {
        const apiResponse = restartResponse as { success: boolean; message?: string };
        if (apiResponse.success) {
          setToast({ message: apiResponse.message || t('app.config_saved_restart_success'), type: 'success' });
        }
      } else {
        setToast({ message: t('app.config_saved_restart_success'), type: 'success' });
      }
    } catch (error) {
      console.error('Failed to save config and restart:', error);
      setToast({ message: t('app.config_saved_restart_failed') + ': ' + (error as Error).message, type: 'error' });
    }
  };

  const checkForUpdates = useCallback(async (showDialog: boolean = true) => {
    if (hasCheckedUpdate && isNewVersionAvailable) {
      if (showDialog) setIsUpdateDialogOpen(true);
      return;
    }
    setIsCheckingUpdate(true);
    try {
      const updateInfo = await api.checkForUpdates();
      if (updateInfo.hasUpdate && updateInfo.latestVersion) {
        setIsNewVersionAvailable(true);
        setNewVersionInfo({ version: updateInfo.latestVersion, changelog: updateInfo.changelog || '' });
        if (showDialog) setIsUpdateDialogOpen(true);
      } else if (showDialog) {
        setToast({ message: t('app.no_updates_available'), type: 'success' });
      }
      setHasCheckedUpdate(true);
    } catch (error) {
      console.error('Failed to check for updates:', error);
      setIsUpdateFeatureAvailable(false);
      if (showDialog) {
        setToast({ message: t('app.update_check_failed') + ': ' + (error as Error).message, type: 'error' });
      }
    } finally {
      setIsCheckingUpdate(false);
    }
  }, [hasCheckedUpdate, isNewVersionAvailable, t]);

  useEffect(() => {
    const checkAuth = async () => {
      if (config) {
        setIsCheckingAuth(false);
        if (!hasCheckedUpdate && !hasAutoCheckedUpdate.current) {
          hasAutoCheckedUpdate.current = true;
          checkForUpdates(false);
        }
        return;
      }
      const apiKey = localStorage.getItem('apiKey');
      if (!apiKey) {
        setIsCheckingAuth(false);
        return;
      }
      try {
        await api.getConfig();
      } catch (err) {
        console.error('Error checking auth:', err);
        if ((err as Error).message === 'Unauthorized') {
          navigate('/login');
        }
      } finally {
        setIsCheckingAuth(false);
        if (!hasCheckedUpdate && !hasAutoCheckedUpdate.current) {
          hasAutoCheckedUpdate.current = true;
          checkForUpdates(false);
        }
      }
    };
    checkAuth();

    const handleUnauthorized = () => navigate('/login');
    window.addEventListener('unauthorized', handleUnauthorized);
    return () => window.removeEventListener('unauthorized', handleUnauthorized);
  }, [config, navigate, hasCheckedUpdate, checkForUpdates]);

  const performUpdate = async () => {
    if (!newVersionInfo || isPerformingUpdate) return;
    setIsPerformingUpdate(true);
    try {
      const result = await api.performUpdate();
      if (result.success) {
        setIsNewVersionAvailable(false);
        setIsUpdateDialogOpen(false);
        setHasCheckedUpdate(false);

        if (result.restarting) {
          // New package is on disk but this running process is still the old
          // code. The server self-restarts; poll checkForUpdates until the new
          // process is back and its version matches npm latest (hasUpdate:false),
          // then reload to load the new frontend bundle.
          setToast({ message: t('app.update_restarting'), type: 'success' });
          await waitForServiceBack();
        } else {
          setToast({ message: t('app.update_successful'), type: 'success' });
        }
      } else {
        setToast({ message: t('app.update_failed') + ': ' + result.message, type: 'error' });
      }
    } catch (error) {
      console.error('Failed to perform update:', error);
      const isTimeout = (error as Error)?.name === 'TimeoutError' || (error as Error)?.name === 'AbortError';
      const message = isTimeout ? t('app.update_timeout') : (error as Error).message;
      setToast({ message: t('app.update_failed') + ': ' + message, type: 'error' });
    } finally {
      setIsPerformingUpdate(false);
    }
  };

  // After an in-place update, the server self-restarts. Poll checkForUpdates
  // (which the new process serves once it's back up) until hasUpdate:false —
  // meaning the new code has loaded and its version matches npm latest — then
  // reload the page to pick up the new frontend bundle. Give up after ~30s and
  // ask the user to refresh manually.
  const waitForServiceBack = async () => {
    const intervalMs = 1500;
    const maxAttempts = 20;
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      try {
        const info = await api.checkForUpdates();
        if (!info.hasUpdate) {
          window.location.reload();
          return;
        }
      } catch {
        // Service is still down (old process killed, new one booting). Retry.
      }
    }
    setToast({ message: t('app.update_refresh_hint'), type: 'warning' });
  };

  if (isCheckingAuth) {
    return (
      <div className="h-screen bg-background flex items-center justify-center">
        <Background />
        <div className="flex flex-col items-center gap-4">
          <div className="h-10 w-10 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
          <div className="text-muted-foreground animate-pulse">{t('app.loading')}</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-screen bg-background flex items-center justify-center">
        <Background />
        <div className="glass-card p-8 text-destructive text-center max-w-md">
          <h2 className="text-2xl font-bold mb-2">System Error</h2>
          <p>{error.message}</p>
        </div>
      </div>
    );
  }

  if (!config) {
    return (
      <div className="h-screen bg-background flex items-center justify-center">
        <Background />
        <div className="text-muted-foreground animate-pulse">{t('app.loading_config')}</div>
      </div>
    );
  }

  return (
    <TooltipProvider>
      <div className="h-screen bg-background overflow-hidden flex flex-col">
        <Background />
        
        {/* Header */}
        <header className="flex h-16 items-center justify-between border-b border-white/10 bg-white/5 backdrop-blur-md px-8 z-10">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-primary/10 rounded-xl">
              <LayoutDashboard className="h-6 w-6 text-primary" />
            </div>
            <h1 className="text-2xl font-bold tracking-tight bg-gradient-to-r from-foreground to-foreground/70 bg-clip-text text-transparent">
              {t('app.title')}
            </h1>
          </div>
          
          <div className="flex items-center gap-3">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" onClick={() => navigate('/settings')} className="rounded-xl hover:bg-white/10">
                  <Settings className="h-5 w-5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>{t('app.settings')}</p>
              </TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <div className="relative">
                  <Button variant="ghost" size="icon" onClick={() => checkForUpdates()} disabled={isCheckingUpdate} className="rounded-xl hover:bg-white/10">
                    <CircleArrowUp className="h-5 w-5" />
                  </Button>
                  {isNewVersionAvailable && (
                    <span className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-red-500 ring-2 ring-background" />
                  )}
                </div>
              </TooltipTrigger>
              <TooltipContent>
                <p>{t('app.check_updates')}</p>
              </TooltipContent>
            </Tooltip>

            <div className="h-8 w-[1px] bg-white/10 mx-2" />
            
            <Button onClick={saveConfig} variant="outline" className="rounded-xl border-white/10 bg-white/5 hover:bg-white/10">
              <Save className="mr-2 h-4 w-4" />
              {t('app.save')}
            </Button>
            
            <Button onClick={saveConfigAndRestart} className="rounded-xl shadow-lg shadow-primary/20 bg-primary hover:bg-primary/90">
              <RefreshCw className="mr-2 h-4 w-4" />
              {t('app.save_and_restart')}
            </Button>
          </div>
        </header>

        {/* Main Content */}
        <main className="flex-1 p-6 overflow-hidden animate-in">
          <div className="flex gap-6 h-full">
            <section className="w-[60%] flex flex-col gap-6">
              <div className="flex-1 overflow-hidden glass-card rounded-2xl">
                <Providers />
              </div>
            </section>
            
            <section className="w-[40%] flex flex-col gap-6">
              <div className="h-[55%] glass-card rounded-2xl overflow-hidden">
                <Router />
              </div>
              <div className="flex-1 glass-card rounded-2xl overflow-hidden">
                <Transformers />
              </div>
            </section>
          </div>
        </main>

        {/* Overlays */}
        <JsonEditor
          open={isJsonEditorOpen}
          onOpenChange={setIsJsonEditorOpen}
          showToast={(message, type) => setToast({ message, type })}
        />
        <LogViewer
          open={isLogViewerOpen}
          onOpenChange={setIsLogViewerOpen}
          showToast={(message, type) => setToast({ message, type })}
        />
        
        {/* Update dialog */}
        <Dialog open={isUpdateDialogOpen} onOpenChange={setIsUpdateDialogOpen}>
          <DialogContent className="max-w-2xl glass border-white/10">
            <DialogHeader>
              <DialogTitle className="text-2xl font-bold flex items-center gap-2">
                {t('app.new_version_available')}
                {newVersionInfo && (
                  <span className="px-2 py-1 bg-primary/10 text-primary text-xs rounded-full">
                    v{newVersionInfo.version}
                  </span>
                )}
              </DialogTitle>
              <DialogDescription className="text-muted-foreground/80">
                {t('app.update_description')}
              </DialogDescription>
            </DialogHeader>
            <div className="max-h-96 overflow-y-auto py-4 px-2 custom-scrollbar">
              {newVersionInfo?.changelog ? (
                <div className="whitespace-pre-wrap text-sm leading-relaxed">
                  {newVersionInfo.changelog}
                </div>
              ) : (
                <div className="text-muted-foreground italic">
                  {t('app.no_changelog_available')}
                </div>
              )}
            </div>
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => setIsUpdateDialogOpen(false)} disabled={isPerformingUpdate} className="rounded-xl">
                {t('app.later')}
              </Button>
              <Button onClick={performUpdate} disabled={isPerformingUpdate} className="rounded-xl bg-primary hover:bg-primary/90">
                {isPerformingUpdate ? (
                  <>
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                    {t('app.updating')}…
                  </>
                ) : (
                  t('app.update_now')
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {toast && (
          <Toast
            message={toast.message}
            type={toast.type}
            onClose={() => setToast(null)}
          />
        )}
      </div>
    </TooltipProvider>
  );
}

export default App;
