import type { ManagedRuntime } from "../provider-plugins/types";

interface PluginAttemptBudget {
  refreshUsed: boolean;
  terminalError?: Error;
  /** Opt-in quota failures stop only this dispatched model within the request. */
  modelErrors?: Map<string, Error>;
}
interface PluginRequestState {
  budgets: Map<string, PluginAttemptBudget>;
}

/**
 * Budget key = runtime + managed provider name. One runtime may serve several
 * provider entries (e.g. a plugin exposing a CN and an international managed
 * provider with independent subscriptions/pools): their terminal failures and
 * 401-refresh budgets must stay independent. Models of the same provider
 * share the refresh budget and account failures. Opt-in independent pools
 * retain model-specific 429 terminal errors without blocking sibling fallback.
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
 * A classified nonretryable error stops this managed provider for the rest of
 * the request. An independent-pool runtime scopes quota 429s to the model,
 * while authentication failures and legacy providers remain account-scoped.
 */
export function rememberPluginFailure(req: any, runtime: ManagedRuntime | undefined, error: any, provider?: { name?: string } | null, model?: string): boolean {
  if (!runtime || error?.nonRetryable !== true) return false;
  // Transformer-native errors may predate the generic host taxonomy marker.
  // Their owning runtime still defines the account boundary for this request.
  const budget = pluginAttemptBudget(req, runtime, provider);
  if (runtime.modelScopedRecovery && error?.statusCode === 429 && model) {
    (budget.modelErrors ??= new Map()).set(model, error);
  } else {
    budget.terminalError = error;
  }
  return true;
}

/** Authentication stays provider-wide; quota exhaustion may be model-scoped. */
export function pluginTerminalFailure(req: any, runtime: ManagedRuntime, provider?: { name?: string } | null, model?: string): Error | undefined {
  const budget = pluginAttemptBudget(req, runtime, provider);
  return budget.terminalError ?? (model ? budget.modelErrors?.get(model) : undefined);
}
