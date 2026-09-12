import { CCR_DEFAULT_PORT } from "./constants";

/**
 * Preset self-referential provider for clients that can point at a custom
 * Anthropic-compatible endpoint directly (ZCode, IDE plugins, generic API
 * clients — anything that does not need CCR to rewrite its config files).
 *
 * The provider loops back to CCR's own /v1/messages endpoint with the CCR
 * family aliases, so a client only needs the base URL, the CCR API key, and a
 * model name (ccr-opus/ccr-sonnet/ccr-haiku) to get full family routing.
 */
export const CCR_SELF_PROVIDER_NAME = "ccr";

/** Config flag recording that the user deliberately deleted the preset. */
export const CCR_SELF_PROVIDER_DELETED_FLAG = "CCR_SELF_PROVIDER_DELETED";

export function isCcrSelfProvider(provider: unknown): boolean {
  return Boolean(
    provider &&
    typeof provider === "object" &&
    (provider as any).name === CCR_SELF_PROVIDER_NAME &&
    (provider as any).ccr_managed === true
  );
}

/**
 * Ensure the preset self provider exists in a config's Providers list.
 *
 * Semantics:
 * - An existing provider named "ccr" (managed or user-created) is never
 *   touched.
 * - Deleting the managed provider via a full-config save is respected: when
 *   oldConfig still had it and newConfig dropped it, the tombstone flag is set
 *   so the provider never comes back on later saves or restarts.
 * - With the tombstone set, nothing is injected ever again.
 *
 * Mutates and returns newConfig; `changed` reports whether the Providers list
 * or the tombstone was modified (i.e. the config needs persisting).
 */
export function ensureCcrSelfProvider<T extends Record<string, any>>(
  newConfig: T,
  oldConfig?: Record<string, any> | null
): { config: T; changed: boolean } {
  const providersKey =
    Array.isArray((newConfig as any).Providers) ? "Providers"
    : Array.isArray((newConfig as any).providers) ? "providers"
    : null;

  const list: any[] = providersKey
    ? [...(newConfig as any)[providersKey]]
    : [];

  const hasSelfProvider = list.some(
    (provider) => provider?.name === CCR_SELF_PROVIDER_NAME
  );

  if (!hasSelfProvider && oldConfig) {
    const oldProviders =
      (oldConfig as any).Providers || (oldConfig as any).providers || [];
    const hadManagedSelfProvider = (Array.isArray(oldProviders) ? oldProviders : []).some(
      isCcrSelfProvider
    );
    if (hadManagedSelfProvider) {
      // Deleted through a client that does not know the tombstone flag —
      // record it so the preset is not resurrected.
      (newConfig as any)[CCR_SELF_PROVIDER_DELETED_FLAG] = true;
    }
  }

  const deleted = (newConfig as any)[CCR_SELF_PROVIDER_DELETED_FLAG] === true;
  if (hasSelfProvider || deleted) {
    return { config: newConfig, changed: false };
  }

  const port = (newConfig as any).PORT || CCR_DEFAULT_PORT;
  const selfProvider = {
    name: CCR_SELF_PROVIDER_NAME,
    api_base_url: `http://127.0.0.1:${port}/v1/messages`,
    api_key: (newConfig as any).APIKEY || "test",
    models: ["ccr-opus", "ccr-sonnet", "ccr-haiku"],
    transformer: { use: ["Anthropic"] },
    enabled: true,
    ccr_managed: true,
  };

  // Append so user-ordered providers keep their positions.
  (newConfig as any)[providersKey || "Providers"] = [...list, selfProvider];
  return { config: newConfig, changed: true };
}
