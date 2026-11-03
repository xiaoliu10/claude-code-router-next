/**
 * Kiro UI-card payload types and pure view helpers. SELF-CONTAINED: the card
 * chunk never imports host runtime modules or the node-facing auth service
 * (only `type PluginCardMountProps`, erased at build, and ./protocol which is
 * platform-free). Tokens never appear here — the admin API surface is
 * summary-only (accounts, plans, credit windows, model ids).
 */
import { KIRO_PROVIDER, validRegion, validStartUrl } from "./protocol";

/** Card-facing alias matching the other subscription cards' naming. */
export const KIRO_PROVIDER_NAME = KIRO_PROVIDER;

export type KiroLoginMethod = "portal" | "builderid" | "idc";
export const KIRO_METHODS: readonly KiroLoginMethod[] = ["portal", "builderid", "idc"];
export const KIRO_DEFAULT_REGION = "us-east-1";

export type KiroConnectionState = "disconnected" | "connected";

/** One stored account, redacted (no tokens). */
export interface KiroAccountView {
  id: string;
  uid: string;
  email: string;
  /** Pre-formatted "email (Source)" display name from the service. */
  accountId: string;
  method: "social" | "idc";
  loginProvider: string;
  region: string;
  plan?: string;
  needReauth: boolean;
  coolingUntil: number;
}

export interface KiroModelView { id: string; name: string; context: number; output: number; images: boolean }

export interface KiroUsageWindowView {
  name: string;
  used: number;
  amount: number;
  limit: number;
  unit: string;
  display: string;
  resetsAt?: string;
}
export interface KiroUsageView {
  known: boolean;
  stale: boolean;
  plan?: string;
  windows: KiroUsageWindowView[];
}

/** GET /status — redacted pool status. */
export interface KiroStatusView {
  status: KiroConnectionState;
  providerName: string;
  accounts: KiroAccountView[];
  models: KiroModelView[];
  hiddenModels: string[];
  plan: string | null;
  usage: Array<KiroUsageView & { account: string }>;
  lastError?: string | null;
}

/** POST /login/start. */
export interface KiroLoginStartView { loginId: string; url: string }

/** POST /login/poll and /login/complete. `error` is a stable kiro_* code. */
export interface KiroLoginPollView {
  status: "pending" | "complete" | "cancelled" | "expired" | "failed";
  account?: KiroAccountView;
  /** Present while pending when the portal stage advances to an AWS OIDC url. */
  url?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Guards / parsers (fail closed: malformed remote payloads degrade the card
// to generic copy instead of acting on untrusted shapes).
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const text = (value: unknown, max = 2048): string =>
  typeof value === "string" && value.length <= max ? value : "";

export function parseKiroStatus(value: unknown): KiroStatusView | null {
  if (!isRecord(value)) return null;
  if (value.status !== "connected" && value.status !== "disconnected") return null;
  if (!Array.isArray(value.accounts) || !Array.isArray(value.models) || !Array.isArray(value.hiddenModels)) return null;
  const accounts: KiroAccountView[] = [];
  for (const raw of value.accounts) {
    if (!isRecord(raw)) return null;
    const id = text(raw.id, 128);
    const uid = text(raw.uid, 128);
    if (!id || !uid) return null;
    accounts.push({
      id, uid,
      email: text(raw.email, 1024),
      accountId: text(raw.accountId, 2048) || "Kiro account",
      method: raw.method === "idc" ? "idc" : "social",
      loginProvider: uid,
      region: validRegion(raw.region) ? raw.region : KIRO_DEFAULT_REGION,
      plan: text(raw.plan, 256) || undefined,
      needReauth: raw.needReauth === true,
      coolingUntil: Number.isFinite(raw.coolingUntil) ? Number(raw.coolingUntil) : 0,
    });
  }
  const models: KiroModelView[] = [];
  for (const raw of value.models) {
    if (!isRecord(raw)) return null;
    const id = text(raw.id, 256) || text(raw.key, 256);
    if (!id) return null;
    models.push({
      id,
      name: text(raw.name, 256) || id,
      context: Number.isFinite(raw.context) ? Number(raw.context) : 0,
      output: Number.isFinite(raw.output) ? Number(raw.output) : 0,
      images: raw.images === true,
    });
  }
  const hiddenModels: string[] = [];
  for (const raw of value.hiddenModels) {
    const id = text(raw, 256);
    if (!id) return null;
    hiddenModels.push(id);
  }
  const usage: Array<KiroUsageView & { account: string }> = [];
  if (Array.isArray(value.usage)) {
    for (const raw of value.usage) {
      const parsed = parseKiroUsage(isRecord(raw) ? { ...raw, account: undefined } : null);
      const account = isRecord(raw) ? text(raw.account, 128) : "";
      if (parsed && account) usage.push({ ...parsed, account });
    }
  }
  return {
    status: value.status,
    providerName: text(value.providerName, 128) || KIRO_PROVIDER,
    accounts, models, hiddenModels,
    plan: text(value.plan, 256) || null,
    usage,
    lastError: typeof value.lastError === "string" ? value.lastError : null,
  };
}

export function parseKiroLoginStart(value: unknown): KiroLoginStartView | null {
  if (!isRecord(value)) return null;
  const loginId = text(value.loginId, 128);
  const url = text(value.url, 4096);
  if (!loginId || !url) return null;
  // The authorization page must always be https (defence in depth).
  try { if (new URL(url).protocol !== "https:") return null; } catch { return null; }
  return { loginId, url };
}

export function parseKiroLoginPoll(value: unknown): KiroLoginPollView | null {
  if (!isRecord(value)) return null;
  const status = value.status;
  if (status !== "pending" && status !== "complete" && status !== "cancelled"
    && status !== "expired" && status !== "failed") return null;
  const next: KiroLoginPollView = { status };
  if (isRecord(value.account)) {
    const parsed = parseKiroStatus({ status: "connected", accounts: [value.account], models: [], hiddenModels: [], plan: null });
    if (parsed) next.account = parsed.accounts[0];
  }
  const url = text(value.url, 4096);
  if (url) { try { if (new URL(url).protocol === "https:") next.url = url; } catch { /* ignore */ } }
  if (typeof value.error === "string") next.error = value.error;
  return next;
}

export function parseKiroUsage(value: unknown): KiroUsageView | null {
  if (!isRecord(value)) return null;
  if (!Array.isArray(value.windows)) return null;
  const windows: KiroUsageWindowView[] = [];
  for (const raw of value.windows) {
    if (!isRecord(raw)) return null;
    const used = Number(raw.used);
    const amount = Number(raw.amount);
    const limit = Number(raw.limit);
    if (!Number.isFinite(used) || !Number.isFinite(amount) || !Number.isFinite(limit)) return null;
    windows.push({
      name: text(raw.name, 200) || "Credits",
      used, amount, limit,
      unit: text(raw.unit, 64) || "credits",
      display: text(raw.display, 200) || `${amount} / ${limit}`,
      ...(text(raw.resetsAt, 64) ? { resetsAt: text(raw.resetsAt, 64) } : {}),
    });
  }
  return {
    known: value.known === true,
    stale: value.stale === true,
    ...(text(value.plan, 256) ? { plan: text(value.plan, 256) } : {}),
    windows,
  };
}

/** Only well-formed stable codes cross into the rendered error surface. */
export function sanitizeKiroErrorCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) return null;
  return value;
}

// ---------------------------------------------------------------------------
// View state / small display helpers
// ---------------------------------------------------------------------------

export type KiroCardState = "loading" | "disconnected" | "connected" | "error";

export function kiroStateKey(status: KiroStatusView | null, now: number = Date.now()): KiroCardState {
  if (!status) return "loading";
  if (status.status === "connected") return "connected";
  return "disconnected";
}

export function kiroConnected(status: KiroStatusView | null): boolean {
  return kiroStateKey(status) === "connected";
}

/** The service selects the first usable account for traffic; mirror it. */
export function kiroActiveAccount(status: KiroStatusView | null, now: number = Date.now()): KiroAccountView | null {
  return status?.accounts.find(a => !a.needReauth && a.coolingUntil <= now) ?? status?.accounts[0] ?? null;
}

export function formatKiroClock(value: number | null | undefined, language: string | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  try {
    return new Date(value).toLocaleString(language || undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch { return null; }
}

/** Parse the ISO reset stamp the service emits; null when absent/invalid. */
export function kiroResetTime(value: string | undefined, language: string): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? formatKiroClock(ms, language) : null;
}

/** A pasted callback is worth submitting only with code + state params. The
 * server re-validates port/state one-to-one; this is UX triage only. */
export function isValidKiroCallbackUrl(value: unknown): boolean {
  if (typeof value !== "string" || !value || value.length > 16384) return false;
  let parsed: URL;
  try { parsed = new URL(value); } catch { return false; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const code = parsed.searchParams.get("code");
  const state = parsed.searchParams.get("state");
  return !!code && !!state;
}

export function isValidKiroIdcInput(method: KiroLoginMethod, startUrl: string, region: string): boolean {
  if (method !== "idc") return true;
  return validStartUrl(startUrl) && validRegion(region);
}

/** Map a server kiro_* code (or transport reason) to a card error key.
 * Card-level sentinels from the login loop (login_expired etc.) pass through. */
export function kiroCardErrorKey(reason: unknown, fallback: string): string {
  const code = sanitizeKiroErrorCode(reason);
  switch (code) {
    case "login_expired":
    case "kiro_login_expired": return "login_expired";
    case "login_cancelled":
    case "kiro_login_cancelled": return "login_cancelled";
    case "kiro_login_failed":
    case "kiro_login_invalid":
    case "kiro_reauth_required": return "login_failed";
    case "kiro_callback_ports_busy": return "kiro_callback_ports_busy";
    case "kiro_callback_invalid": return "callback_rejected";
    case "kiro_model_unknown": return fallback === "restore" ? "restore_failed" : "hide_failed";
    default: return fallback;
  }
}

// ---------------------------------------------------------------------------
// Managed-provider reconciliation (draft-safe)
// ---------------------------------------------------------------------------

function isKiroManagedProvider(provider: unknown): boolean {
  if (!provider || typeof provider !== "object") return false;
  const value = provider as Record<string, unknown>;
  if (value.kiro_managed === true || value.kiroManaged === true) return true;
  if (value.name !== KIRO_PROVIDER) return false;
  return (value.api_key ?? value.apiKey) === "ccr-managed-kiro";
}

/** Reconcile only the CCR-managed Kiro entry; Router, drafts and ordinary
 * providers survive untouched. Mirrors protocol.mergeKiroProvider locally so
 * the card chunk imports neither the node auth service nor host internals. */
export function mergeKiroCardProvider(local: any, server: any): any {
  const key = Array.isArray(local.providers) && !Array.isArray(local.Providers) ? "providers" : "Providers";
  const list: unknown[] = [...(local[key] ?? [])];
  const managed = (server.Providers ?? server.providers ?? []).find(isKiroManagedProvider);
  const at = list.findIndex(isKiroManagedProvider);
  if (at >= 0) { if (managed) list[at] = managed; else list.splice(at, 1); }
  else if (managed && !list.some(p => (p as Record<string, unknown> | null)?.name === KIRO_PROVIDER)) list.push(managed);
  return { ...local, [key]: list };
}

// ---------------------------------------------------------------------------
// Session quota cache (sessionStorage, valid values only, TTL)
// ---------------------------------------------------------------------------

export const KIRO_USAGE_CACHE_KEY = "kiro-usage-cache-v1";
export const KIRO_USAGE_CACHE_TTL_MS = 10 * 60_000;

interface CachedUsage { value: KiroUsageView; at: number }
interface UsageCacheShape { savedAt: number; entries: Record<string, CachedUsage> }

export function readKiroUsageStore(): UsageCacheShape {
  try {
    const raw = (globalThis as any).sessionStorage?.getItem(KIRO_USAGE_CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.entries && typeof parsed.entries === "object") {
        return parsed as UsageCacheShape;
      }
    }
  } catch { /* unavailable or corrupt */ }
  return { savedAt: 0, entries: {} };
}

export function writeKiroUsageStore(store: UsageCacheShape): void {
  try { (globalThis as any).sessionStorage?.setItem(KIRO_USAGE_CACHE_KEY, JSON.stringify(store)); } catch { /* unavailable */ }
}

export function rememberKiroUsage(store: UsageCacheShape, accountId: string, value: KiroUsageView | null, now: number = Date.now()): void {
  const entries = { ...store.entries };
  if (value === null) delete entries[accountId];
  else if (value.known) entries[accountId] = { value, at: now };
  else return; // only valid usage is cached; failures never suppress retries
  store.entries = entries;
  store.savedAt = now;
  writeKiroUsageStore(store);
}

export function freshKiroUsage(store: UsageCacheShape, accountId: string, now: number = Date.now()): CachedUsage | undefined {
  const hit = store.entries[accountId];
  if (!hit || !Number.isFinite(hit.at) || hit.at > now || now - hit.at > KIRO_USAGE_CACHE_TTL_MS) return undefined;
  const value = parseKiroUsage(hit.value);
  return value ? { value, at: hit.at } : undefined;
}

export function clearKiroUsageCache(): void {
  try { (globalThis as any).sessionStorage?.removeItem(KIRO_USAGE_CACHE_KEY); } catch { /* unavailable */ }
}
