import type { Config, Provider, WorkBuddyAccountSummary, WorkBuddyKind, WorkBuddyMutationResponse, WorkBuddySiteStatus, WorkBuddyStatus, WorkBuddyStatusResponse, WorkBuddyUsage } from "../types";

// §16: each connected site owns one managed provider with a fixed name.
const WORKBUDDY_PROVIDER_NAMES: readonly WorkBuddyKind[] = ["workbuddy", "workbuddy-ai"];

export function isManagedWorkBuddy(provider: unknown): boolean {
  if (!provider || typeof provider !== "object") return false;
  const value = provider as Partial<Provider>;
  return (value.name === "workbuddy" || value.name === "workbuddy-ai") && value.ccr_managed === true;
}

/** Which site's managed provider this is ("workbuddy" / "workbuddy-ai"), or null. */
export function workBuddyKindOf(provider: unknown): WorkBuddyKind | null {
  if (!isManagedWorkBuddy(provider)) return null;
  const name = (provider as Partial<Provider>).name;
  return name === "workbuddy" || name === "workbuddy-ai" ? name : null;
}

export function isWorkBuddyKind(value: unknown): value is WorkBuddyKind {
  return value === "workbuddy" || value === "workbuddy-ai";
}

/**
 * Refresh the server-managed providers for BOTH sites independently (§16):
 * only entries CCR actually manages (name + ccr_managed) are added, replaced
 * or removed; Router, drafts and ordinary providers always survive.
 */
export function mergeWorkBuddyProvider(local: Config, server: Config): Config {
  const providers = [...(local.Providers || [])];
  for (const name of WORKBUDDY_PROVIDER_NAMES) {
    const isSiteProvider = (provider: unknown): provider is Provider =>
      workBuddyKindOf(provider) === name;
    const managed = (server.Providers || []).find(isSiteProvider);
    const index = providers.findIndex(isSiteProvider);
    if (index >= 0) {
      if (managed) providers[index] = managed;
      else providers.splice(index, 1);
    } else if (managed && !providers.some(provider => provider.name === name)) {
      providers.push(managed);
    }
  }
  return { ...local, Providers: providers };
}

// Router slots that hold a single "<provider>,<model>" reference.
const ROUTER_REF_SLOTS = ["default", "background", "think", "longContext", "extendedContext", "webSearch", "image"] as const;

function customEntryReferencesRef(entry: unknown, provider: string, model: string, ref: string): boolean {
  if (typeof entry === "string") return entry === ref;
  if (!entry || typeof entry !== "object") return false;
  const record = entry as Record<string, unknown>;
  if (record.provider === provider && record.model === model) return true;
  return Object.values(record).some(value => customEntryReferencesRef(value, provider, model, ref));
}

/**
 * §16 hide reconciliation (explicitly authorized action): the backend just
 * rewrote its SAVED Router for the hidden model (references cleared, default
 * re-pointed at the first visible model, referencing custom routes removed).
 * The ordinary draft-preserving merge would keep the pre-clean local Router,
 * so the next full-config Save would silently resurrect exactly the
 * references the toast announced as cleared.
 *
 * This variant applies EXACTLY the reported cleanup to the local draft and
 * nothing else: a slot/alias/fallback is rewritten only when it still points
 * at one of the cleared refs, custom entries referencing a cleared model are
 * removed entirely, `default` gets the §16 first-visible-model fallback, and
 * every unrelated local edit (Router or otherwise) survives. With no cleared
 * refs it is byte-identical to the draft-preserving merge. Login / sync /
 * disconnect / restore keep using mergeWorkBuddyProvider (Router preserved).
 */
export function mergeWorkBuddyHiddenRefs(local: Config, server: Config, clearedRefs: string[] | undefined, defaultFallback: string | null): Config {
  const merged = mergeWorkBuddyProvider(local, server);
  const refs = sanitizeClearedRefs(clearedRefs);
  if (refs.length === 0) return merged;
  const refSet = new Set(refs);
  const parsed = refs.map(ref => {
    const index = ref.indexOf(",");
    return index > 0
      ? { ref, provider: ref.slice(0, index), model: ref.slice(index + 1) }
      : { ref, provider: "", model: ref };
  });
  const source = (local.Router || {}) as Record<string, unknown>;
  const router: Record<string, unknown> = { ...source };
  // Scenario slots: only a slot still pointing exactly at a cleared ref moves.
  for (const slot of ROUTER_REF_SLOTS) {
    const value = router[slot];
    if (typeof value === "string" && refSet.has(value)) {
      router[slot] = slot === "default" && defaultFallback ? defaultFallback : "";
    }
  }
  // Model alias map: drop entries whose target was cleared.
  if (source.models && typeof source.models === "object") {
    const kept: Record<string, unknown> = {};
    for (const [alias, target] of Object.entries(source.models as Record<string, unknown>)) {
      if (typeof target === "string" && refSet.has(target)) continue;
      kept[alias] = target;
    }
    router.models = kept;
  }
  // Family routing configs carry the same reference semantics.
  if (source.families && typeof source.families === "object") {
    const keptFamilies: Record<string, unknown> = {};
    for (const [family, familyConfig] of Object.entries(source.families as Record<string, unknown>)) {
      if (!familyConfig || typeof familyConfig !== "object") { keptFamilies[family] = familyConfig; continue; }
      const record = { ...(familyConfig as Record<string, unknown>) };
      for (const slot of ROUTER_REF_SLOTS) {
        const value = record[slot];
        if (typeof value === "string" && refSet.has(value)) record[slot] = "";
      }
      if (record.fallback && typeof record.fallback === "object") {
        const keptFallback: Record<string, unknown> = {};
        for (const [key, list] of Object.entries(record.fallback as Record<string, unknown>)) {
          keptFallback[key] = Array.isArray(list)
            ? list.filter(item => !(typeof item === "string" && refSet.has(item)))
            : list;
        }
        record.fallback = keptFallback;
      }
      keptFamilies[family] = record;
    }
    router.families = keptFamilies;
  }
  // Custom routes: an entry referencing a cleared model is removed entirely (§16).
  const referencesCleared = (entry: unknown) =>
    parsed.some(({ ref, provider, model }) => customEntryReferencesRef(entry, provider, model, ref));
  if (Array.isArray(source.custom)) {
    router.custom = source.custom.filter(entry => !referencesCleared(entry));
  } else if (source.custom && typeof source.custom === "object") {
    const keptCustom: Record<string, unknown> = {};
    for (const [name, entry] of Object.entries(source.custom as Record<string, unknown>)) {
      if (!referencesCleared(entry)) keptCustom[name] = entry;
    }
    router.custom = keptCustom;
  }
  return { ...merged, Router: router as Config["Router"] };
}

// Use only localised allowlisted messages, never render / log upstream error text.
export function workBuddyErrorKey(value: unknown): string {
  const data = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const code = data.reason || data.error;
  const allowed = ["sealed", "source_missing", "source_invalid", "models_fetch_failed",
    "workbuddy_name_conflict", "workbuddy_site_conflict", "workbuddy_not_connected",
    "workbuddy_unauthorized", "login_state_rejected", "login_account_failed", "login_persist_failed", "login_expired"];
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

/**
 * Success verdict for §16 mutations whose provider may legitimately expose
 * zero visible models (the whole set can be hidden). `success: connected` is
 * the authoritative signal; an empty models array is only accepted when it is
 * a clean array, never a malformed payload.
 */
export function isWorkBuddyConnected(result: WorkBuddyMutationResponse): boolean {
  return result.success === true && result.status === "connected" &&
    (result.models === undefined ||
      (Array.isArray(result.models) && result.models.every(model => typeof model === "string" && model.trim().length > 0)));
}

export function maskWorkBuddyUid(uid: string | null): string {
  if (!uid) return "—";
  return uid.length > 5 ? `${uid.slice(0, 3)}…${uid.slice(-2)}` : "•••";
}

/** Card badge key for one site. Pool truth first (§16): a stale site-level
 * 11140 diagnostic must never brand a connected card with usable accounts as
 * restricted — per-account truth lives in the row badges. */
export function workBuddyStateKey(site: WorkBuddySiteStatus | null, now = Date.now()): string {
  if (!site) return "not_connected";
  if (site.status === "connected") {
    return workBuddyPoolState(site, now) ?? "connected";
  }
  if (site.lastError && workBuddyErrorKey(site) === "restricted") return "restricted";
  return site.status;
}

export function workBuddyAccountCooling(account: WorkBuddyAccountSummary, now = Date.now()): number | null {
  return typeof account.coolingUntil === "number" && Number.isFinite(account.coolingUntil) && account.coolingUntil > now
    ? account.coolingUntil : null;
}

export function workBuddyAccountRestricted(account: WorkBuddyAccountSummary, now = Date.now()): number | null {
  return typeof account.restrictedUntil === "number" && Number.isFinite(account.restrictedUntil) && account.restrictedUntil > now
    ? account.restrictedUntil : null;
}

/** "cooling" / "restricted" when the connected site has no usable account right now. */
export function workBuddyPoolState(site: WorkBuddySiteStatus, now = Date.now()): "cooling" | "restricted" | null {
  if (site.status !== "connected" || site.accounts.length === 0) return null;
  if (site.accounts.every(account => workBuddyAccountRestricted(account, now) !== null)) return "restricted";
  if (site.accounts.every(account =>
    workBuddyAccountCooling(account, now) !== null || workBuddyAccountRestricted(account, now) !== null)) return "cooling";
  return null;
}

/**
 * Alert key for one card. Action errors always win. A server-sanitised site
 * diagnostic is shown only while it is still meaningful: a stale 11140
 * "restricted" claim is suppressed while a connected pool still has a usable
 * account (the rows carry the per-account truth) instead of falsely telling
 * the user the entire site is restricted.
 */
export function workBuddyVisibleErrorKey(actionErrorKey: string | null, site: WorkBuddySiteStatus | null, now = Date.now()): string | null {
  if (actionErrorKey) return actionErrorKey;
  const derived = site?.lastError ? workBuddyErrorKey(site) : null;
  if (derived === "restricted" && site?.status === "connected" && workBuddyPoolState(site, now) === null) return null;
  return derived;
}

/** Compact clock ("hh:mm") for 冷却中(至 hh:mm) / 受限(至 hh:mm) account labels. */
export function formatWorkBuddyClock(until: number, locale?: string): string {
  const date = new Date(until);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
}

function isWorkBuddyAccountSummary(value: unknown): value is WorkBuddyAccountSummary {
  if (!value || typeof value !== "object") return false;
  const account = value as Record<string, unknown>;
  return typeof account.uid === "string" && account.uid.length > 0
    && (account.source === "desktop" || account.source === "browser")
    && typeof account.active === "boolean";
}

function isWorkBuddySiteStatus(value: unknown): value is WorkBuddySiteStatus {
  if (!value || typeof value !== "object") return false;
  const site = value as Record<string, unknown>;
  return typeof site.status === "string" && typeof site.providerName === "string"
    && Array.isArray(site.accounts) && Array.isArray(site.models) && Array.isArray(site.hiddenModels);
}

/**
 * Per-site status for one card. §16: `sites` is the source of truth; the
 * legacy flat fields (mirror of the only connected site) are used only as a
 * one-version fallback. Malformed shapes degrade to "not connected" instead
 * of crashing or leaking anything.
 */
export function workBuddySiteStatus(response: WorkBuddyStatusResponse | null | undefined, site: WorkBuddyKind): WorkBuddySiteStatus | null {
  if (!response) return null;
  const sites = (response as { sites?: unknown }).sites;
  if (sites && typeof sites === "object") {
    const candidate = (sites as Record<string, unknown>)[site];
    if (isWorkBuddySiteStatus(candidate)) {
      return { ...candidate, accounts: candidate.accounts.filter(isWorkBuddyAccountSummary) };
    }
  }
  const legacy = response as { kind?: unknown; status?: unknown; uid?: unknown; source?: unknown };
  if (legacy.kind === site && typeof legacy.status === "string" && legacy.status !== "not_connected") {
    const uid = typeof legacy.uid === "string" && legacy.uid ? legacy.uid : null;
    const source = legacy.source === "browser" || legacy.source === "desktop" ? legacy.source : "desktop";
    const status = legacy.status as WorkBuddyStatus;
    return {
      status,
      providerName: typeof response.providerName === "string" ? response.providerName : site,
      accounts: uid ? [{ uid, displayName: response.displayName ?? null, source, active: true }] : [],
      activeUid: uid,
      models: Array.isArray(response.models) ? response.models : [],
      hiddenModels: [],
      modelCount: typeof response.modelCount === "number" ? response.modelCount : (Array.isArray(response.models) ? response.models.length : 0),
      lastSyncAt: response.lastSyncAt ?? null,
      lastError: response.lastError ?? null,
      site: response.site,
      source,
      renewalMode: response.renewalMode,
      imagesUnsupportedModels: response.imagesUnsupportedModels,
    };
  }
  return null;
}

/**
 * Toast-safe Router references from a successful hide. Only plain reference
 * strings ("<provider>,<model>") are shown, capped to keep the toast small.
 */
export function sanitizeClearedRefs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => (typeof item === "string" ? item.trim() : ""))
    .filter(item => /^[\w.,:@/-]{1,120}$/.test(item))
    .slice(0, 8);
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
