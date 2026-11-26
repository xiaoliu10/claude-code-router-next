import type { ConfigSnapshot } from '../lib/api.ts';
import type { Config } from '@/types';

export interface ConfigDraft {
  base: ConfigSnapshot;
  config: Config;
}

export function openConfigDraft(base: ConfigSnapshot): ConfigDraft {
  return { base, config: base.config };
}

export function refreshConfigDraft(current: ConfigDraft, server: ConfigSnapshot, merge?: (current: Config, server: Config) => Config): ConfigDraft {
  if (current.config === current.base.config) return openConfigDraft(server);
  // A partial reconciliation preserves unrelated edits. It cannot vouch for
  // unrelated fields in the latest GET, so keep the original precondition.
  return merge ? { ...current, config: merge(current.config, server.config) } : current;
}

// Takeover actions update client settings and may add model aliases. Other
// fields still belong to the open draft until the user saves or reloads it.
export function mergeClientConfig(current: Config, server: Config): Config {
  return {
    ...current,
    Clients: server.Clients,
    Router: {
      ...current.Router,
      models: { ...current.Router?.models, ...server.Router?.models },
    },
  };
}
