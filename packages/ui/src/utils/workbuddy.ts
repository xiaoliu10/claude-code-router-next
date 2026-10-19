import type { Config, Provider, WorkBuddyKind, WorkBuddyMutationResponse, WorkBuddyStatusResponse, WorkBuddyUsage } from "../types";

export function isManagedWorkBuddy(provider: unknown): boolean {
  if (!provider || typeof provider !== "object") return false;
  const value = provider as Partial<Provider>;
  return value.name === "workbuddy" && value.ccr_managed === true;
}

export function isWorkBuddyKind(value: unknown): value is WorkBuddyKind {
  return value === "workbuddy" || value === "workbuddy-ai";
}

/** Refresh just this server-managed provider; Router and all local drafts survive. */
export function mergeWorkBuddyProvider(local: Config, server: Config): Config {
  const managed = (server.Providers || []).find(isManagedWorkBuddy);
  const providers = [...(local.Providers || [])];
  const index = providers.findIndex(isManagedWorkBuddy);
  if (index >= 0) {
    if (managed) providers[index] = managed;
    else providers.splice(index, 1);
  } else if (managed && !providers.some(provider => provider.name === "workbuddy")) {
    providers.push(managed);
  }
  return { ...local, Providers: providers };
}

// Use only localised allowlisted messages, never render / log upstream error text.
export function workBuddyErrorKey(value: unknown): string {
  const data = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const code = data.reason || data.error;
  const allowed = ["sealed", "source_missing", "source_invalid", "models_fetch_failed",
    "workbuddy_name_conflict", "workbuddy_site_conflict", "workbuddy_not_connected"];
  if (typeof code === "string" && allowed.includes(code)) return code;
  // GET status may contain a server-sanitised diagnostic. Classify, do not show it.
  const message = typeof data.lastError === "string" ? data.lastError : "";
  if (/11140|restricted|unusual activity/i.test(message)) return "restricted";
  if (/unapproved channel|Illegal API invocation/i.test(message)) return "channel_rejected";
  return "request_failed";
}

export function hasDiscoveredModels(result: WorkBuddyMutationResponse): boolean {
  return result.success === true && result.status === "connected" &&
    Array.isArray(result.models) && result.models.length > 0 &&
    result.models.every(model => typeof model === "string" && model.trim().length > 0);
}

export function maskWorkBuddyUid(uid: string | null): string {
  if (!uid) return "—";
  return uid.length > 5 ? `${uid.slice(0, 3)}…${uid.slice(-2)}` : "•••";
}

export function workBuddyStateKey(status: WorkBuddyStatusResponse | null): string {
  if (status?.lastError && workBuddyErrorKey(status) === "restricted") return "restricted";
  return status?.status || "error";
}

// Strict validation of the usage payload. Anything malformed becomes null so
// the card quietly hides credits instead of rendering garbage or raw errors.
export function parseWorkBuddyUsage(payload: unknown): WorkBuddyUsage | null {
  const usage = payload && typeof payload === "object" ? (payload as { usage?: unknown }).usage : undefined;
  if (!usage || typeof usage !== "object") return null;
  const record = usage as Record<string, unknown>;
  // Hard contract: no credential-refresh secret exists. A payload advertising
  // one is rejected outright rather than sanitised.
  if ("refreshToken" in record || "refresh_token" in record) return null;
  const { plan, used, limit, unit } = record;
  if (typeof plan !== "string" || plan.trim().length === 0) return null;
  if (typeof used !== "number" || !Number.isFinite(used) || used < 0) return null;
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) return null;
  if (unit !== "credits") return null;
  return { plan, used, limit, unit };
}

// Registered models that cannot accept image input (e.g. GLM series), for the
// warning line. Only models actually registered on this provider are listed.
export function workBuddyImagesUnsupportedModels(models: string[], unsupported: unknown): string[] {
  if (!Array.isArray(unsupported)) return [];
  const set = new Set(unsupported.filter((model): model is string => typeof model === "string" && model.length > 0));
  return models.filter(model => set.has(model));
}
