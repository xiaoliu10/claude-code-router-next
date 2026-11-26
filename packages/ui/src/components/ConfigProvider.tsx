import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import type { ReactNode, Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import { openConfigDraft, refreshConfigDraft } from '@/utils/config-draft';
import type { ConfigDraft } from '@/utils/config-draft';
import { api } from '@/lib/api';
import type { Config } from '@/types';

interface ConfigContextType {
  config: Config | null;
  setConfig: Dispatch<SetStateAction<Config | null>>;
  revision: string | null;
  saveDraft: (config: Config, revision?: string | null) => ReturnType<typeof api.updateConfig>;
  error: Error | null;
  refreshConfig: (merge?: (current: Config, server: Config) => Config) => Promise<void>;
}

const ConfigContext = createContext<ConfigContextType | undefined>(undefined);

// eslint-disable-next-line react-refresh/only-export-components
export function useConfig() {
  const context = useContext(ConfigContext);
  if (context === undefined) {
    throw new Error('useConfig must be used within a ConfigProvider');
  }
  return context;
}

interface ConfigProviderProps {
  children: ReactNode;
}

export function ConfigProvider({ children }: ConfigProviderProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<ConfigDraft | null>(null);
  const base = draft?.base;
  const revision = base?.revision ?? null;
  const [error, setError] = useState<Error | null>(null);
  const [apiKey, setApiKey] = useState<string | null>(localStorage.getItem('apiKey'));

  // Listen for localStorage changes
  useEffect(() => {
    const handleStorageChange = () => {
      setApiKey(localStorage.getItem('apiKey'));
    };

    window.addEventListener('storage', handleStorageChange);
    return () => {
      window.removeEventListener('storage', handleStorageChange);
    };
  }, []);

  useEffect(() => {
    let active = true;
    setDraft(null);
    setError(null);
    api.getConfigSnapshot().then(snapshot => {
      if (active) setDraft(openConfigDraft(snapshot));
    }).catch(err => {
      if (active) setError(err as Error);
    });
    return () => { active = false; };
  }, [apiKey]);

  const setConfig: ConfigContextType['setConfig'] = useCallback(action => {
    setDraft(current => {
      if (!current || !base) return current;
      if (typeof action !== 'function') return action ? { base, config: action } : null;
      const config = action(current.config);
      return config ? { ...current, config } : null;
    });
  }, [base]);

  const saveDraft: ConfigContextType['saveDraft'] = async (config, expected = revision) => {
    if (!expected || !/^[a-f0-9]{64}$/.test(expected)) throw new Error(t('app.config_revision_missing'));
    if (expected !== revision) throw new Error(t('app.config_conflict'));
    try {
      const result = await api.updateConfig(config, expected);
      if (result.success) {
        // The server may add managed providers. Adopt the complete raw GET and
        // its revision together, only if no new edits arrived during the save.
        const snapshot = await api.getConfigSnapshot().catch(() => {
          throw new Error(t('app.config_saved_refresh_failed'));
        });
        setDraft(current => current === draft ? openConfigDraft(snapshot) : current);
      }
      return result;
    } catch (error) {
      if ((error as { status?: number }).status === 409) throw new Error(t('app.config_conflict'));
      throw error;
    }
  };

  const refreshConfig: ConfigContextType['refreshConfig'] = async merge => {
    try {
      const snapshot = await api.getConfigSnapshot();
      setDraft(current => current && current.base === draft?.base ? refreshConfigDraft(current, snapshot, merge) : current);
      setError(null);
    } catch (err) {
      console.error('Failed to refresh config:', err);
      if ((err as Error).message !== 'Unauthorized') {
        setError(err as Error);
      }
      // Narrow management refreshes must not report a successful action when
      // the UI could not reconcile the newly persisted provider.
      if (merge) throw new Error('Configuration refresh failed');
    }
  };

  return (
    <ConfigContext.Provider value={{ config: draft?.config ?? null, revision, setConfig, saveDraft, error, refreshConfig }}>
      {children}
    </ConfigContext.Provider>
  );
}
