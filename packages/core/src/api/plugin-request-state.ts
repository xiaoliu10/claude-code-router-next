import type { ManagedRuntime } from "../provider-plugins/types";

interface PluginAttemptBudget {
  refreshUsed: boolean;
  terminalError?: Error;
}
interface PluginRequestState {
  budgets: Map<ManagedRuntime, PluginAttemptBudget>;
}

/** Install BEFORE any fallback {...req} copy: every copy shares this object. */
export function ensurePluginRequestState(req: any): PluginRequestState {
  return req.__ccrPluginRequestState ??= { budgets: new Map() };
}

export function pluginAttemptBudget(req: any, runtime: ManagedRuntime): PluginAttemptBudget {
  const state = ensurePluginRequestState(req);
  let budget = state.budgets.get(runtime);
  if (!budget) {
    budget = { refreshUsed: false };
    state.budgets.set(runtime, budget);
  }
  return budget;
}

/** A classified nonretryable error stops this account, not unrelated fallbacks. */
export function rememberPluginFailure(req: any, runtime: ManagedRuntime | undefined, error: any): boolean {
  if (!runtime || error?.nonRetryable !== true) return false;
  // Transformer-native errors may predate the generic host taxonomy marker.
  // Their owning runtime still defines the account boundary for this request.
  pluginAttemptBudget(req, runtime).terminalError = error;
  return true;
}
