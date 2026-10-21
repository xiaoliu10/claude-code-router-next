import type { ManagedRuntime } from "../provider-plugins/types";

interface PluginAttemptBudget {
  refreshUsed: boolean;
  terminalError?: Error;
}
interface PluginRequestState {
  budgets: Map<string, PluginAttemptBudget>;
}

/**
 * Budget key = runtime + managed provider name. One runtime may serve several
 * provider entries (e.g. a plugin exposing a CN and an international managed
 * provider with independent subscriptions/pools): their terminal failures and
 * 401-refresh budgets must stay independent, while every model of the SAME
 * provider still shares one budget so a terminal failure cannot be retried
 * through a sibling model of the same subscription.
 */
function budgetKey(runtime: ManagedRuntime, provider?: { name?: string } | null): string {
  return `${runtime.name}|${provider?.name ?? ""}`;
}

/** Install BEFORE any fallback {...req} copy: every copy shares this object. */
export function ensurePluginRequestState(req: any): PluginRequestState {
  return req.__ccrPluginRequestState ??= { budgets: new Map() };
}

export function pluginAttemptBudget(req: any, runtime: ManagedRuntime, provider?: { name?: string } | null): PluginAttemptBudget {
  const state = ensurePluginRequestState(req);
  const key = budgetKey(runtime, provider);
  let budget = state.budgets.get(key);
  if (!budget) {
    budget = { refreshUsed: false };
    state.budgets.set(key, budget);
  }
  return budget;
}

/**
 * A classified nonretryable error stops this managed provider's models for the
 * rest of the request — never an unrelated provider that happens to share the
 * runtime (different subscription/credential pool).
 */
export function rememberPluginFailure(req: any, runtime: ManagedRuntime | undefined, error: any, provider?: { name?: string } | null): boolean {
  if (!runtime || error?.nonRetryable !== true) return false;
  // Transformer-native errors may predate the generic host taxonomy marker.
  // Their owning runtime still defines the account boundary for this request.
  pluginAttemptBudget(req, runtime, provider).terminalError = error;
  return true;
}
