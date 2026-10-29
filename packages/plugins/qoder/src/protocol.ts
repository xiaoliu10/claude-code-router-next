import type { PluginClassifiedError } from "./core-types";

/** The one chat path Qoder's client uses; only the site's API host differs. */
const CHAT_PATH = "/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1";

export type QoderSiteId = "qoder" | "qoder-cn";

/**
 * Everything that differs between qoder.com (international) and qoder.cn
 * (Qoder CN): the fixed origins, the managed provider name, its marker
 * credential, the private credential file and the admin route base. The
 * protocol itself (PAT exchange, listing, chat, usage, error taxonomy) is the
 * same on both sites.
 */
export interface QoderSiteDescriptor {
  id: QoderSiteId;
  label: string;
  openapi: string;
  api: string;
  web: string;
  chatUrl: string;
  /** Managed provider name in the CCR config. */
  provider: string;
  /** Placeholder credential the managed provider carries instead of a key. */
  marker: string;
  /** Private credential file inside the host config dir. */
  credentialFile: string;
  /** Admin route base (the card reaches it through the host's plugin bridge). */
  routeBase: string;
}

export const QODER_SITES: readonly QoderSiteDescriptor[] = Object.freeze([
  {
    id: "qoder", label: "Qoder",
    openapi: "https://openapi.qoder.sh", api: "https://api3.qoder.sh", web: "https://qoder.com",
    chatUrl: `https://api3.qoder.sh${CHAT_PATH}`,
    provider: "qoder-subscription", marker: "ccr-managed-qoder",
    credentialFile: "qoder-credentials.json", routeBase: "/api/qoder",
  },
  {
    id: "qoder-cn", label: "Qoder CN",
    openapi: "https://openapi.qoder.com.cn", api: "https://gateway.qoder.com.cn", web: "https://qoder.cn",
    chatUrl: `https://gateway.qoder.com.cn${CHAT_PATH}`,
    provider: "qoder-cn-subscription", marker: "ccr-managed-qoder-cn",
    credentialFile: "qoder-cn-credentials.json", routeBase: "/api/qoder/cn",
  },
]);

/** International defaults, kept as named exports for the existing call sites. */
/** The one chat endpoint Qoder's client uses; locked into the managed config. */
export const QODER_CHAT = QODER_SITES[0].chatUrl;
export const QODER_PROVIDER = QODER_SITES[0].provider;
export const QODER_MARKER = QODER_SITES[0].marker;

/**
 * Resolve a site descriptor. Anything that is not a known site id (missing,
 * or an Array.prototype index leaked by a bare `find(isQoderManaged)` call)
 * falls back to the international site.
 */
export function qoderSite(site?: QoderSiteId): QoderSiteDescriptor {
  return QODER_SITES.find(s => s.id === site) ?? QODER_SITES[0];
}

/**
 * Path prefix the UI card uses for a site, relative to the host's plugin
 * bridge (which already prepends `/api/<plugin>`). Derived from the intl route
 * base so the two spellings cannot drift: "" for intl, "/cn" for Qoder CN.
 */
export function qoderCardPrefix(site: QoderSiteId): string {
  const base = QODER_SITES[0].routeBase;
  return qoderSite(site).routeBase.slice(base.length);
}

export function qoderError(code: string, status = 422): Error & { code: string; statusCode: number } {
  return Object.assign(new Error(code), { code, statusCode: status, nonRetryable: true });
}

/**
 * Managed-entry recognition. A provider named after a site belongs to exactly
 * that site, so the two managed runtimes can share the registry without
 * claiming each other's providers. Nameless or renamed entries can only mean
 * the default (international) site: pre-CN configs never had another owner,
 * and the legacy boolean flags stay honoured for them.
 */
export function isQoderManaged(p: any, site: QoderSiteId = "qoder"): boolean {
  const managedBy = qoderSite(site);
  const name = p?.name;
  const owner = typeof name === "string" ? QODER_SITES.find(s => s.provider === name) : undefined;
  if (owner) {
    return owner.id === managedBy.id &&
      (p?.qoder_managed === true || p?.qoderManaged === true || (p?.api_key ?? p?.apiKey) === managedBy.marker);
  }
  if (managedBy.id !== QODER_SITES[0].id) return false;
  return p?.qoder_managed === true || p?.qoderManaged === true;
}

export function lockQoderProvider(p: any, site: QoderSiteId = "qoder"): any {
  const managedBy = qoderSite(site);
  // Single-transformer chain, exactly cursor's lockProvider shape ("qoder" / "qoder-cn").
  return { ...p, name: managedBy.provider, qoder_managed: true, qoderManaged: true,
    api_base_url: managedBy.chatUrl, api_key: managedBy.marker, transformer: { use: [managedBy.id] } };
}

/**
 * ONE protector for BOTH sites: every managed entry in the incoming config is
 * re-locked in place, and a site whose managed entry vanished is re-added from
 * the previous config (intl first, then CN — the descriptor order).
 */
export function protectQoderConfig(next: any, previous: any): void {
  if (!next || typeof next !== "object") return;
  const key = Array.isArray(next?.providers) && !Array.isArray(next?.Providers) ? "providers" : "Providers";
  const old = (previous?.Providers ?? previous?.providers ?? []) as any[];
  const list: any[] = Array.isArray(next[key]) ? next[key] : [];
  next[key] = list.map((p: any) => {
    for (const managedBy of QODER_SITES) {
      const previousEntry = old.find(o => isQoderManaged(o, managedBy.id));
      if (isQoderManaged(p, managedBy.id) || (previousEntry && p?.name === managedBy.provider)) {
        return lockQoderProvider(p, managedBy.id);
      }
    }
    return p;
  });
  for (const managedBy of QODER_SITES) {
    const previousEntry = old.find(o => isQoderManaged(o, managedBy.id));
    if (previousEntry && !next[key].some((p: any) => isQoderManaged(p, managedBy.id))) {
      next[key].push(lockQoderProvider(previousEntry, managedBy.id));
    }
  }
}

/** Reconcile ONE site's managed entry into the UI's config draft. */
export function mergeQoderProvider(current: any, server: any, site: QoderSiteId = "qoder"): any {
  const managedBy = qoderSite(site);
  const next = { ...current };
  const key = Array.isArray(current?.providers) && !Array.isArray(current?.Providers) ? "providers" : "Providers";
  const managed = (server?.Providers ?? server?.providers ?? []).find((p: any) => isQoderManaged(p, managedBy.id));
  const list = [...(current?.[key] ?? [])];
  const at = list.findIndex((p: any) => isQoderManaged(p, managedBy.id));
  if (at >= 0) { if (managed) list[at] = managed; else list.splice(at, 1); }
  else if (managed && !list.some(p => p?.name === managedBy.provider)) list.push(managed);
  next[key] = list;
  return next;
}

/**
 * Serialize whole-config read-modify-write ACROSS provider instances.
 *
 * The card hosts two Qoder services (intl + CN) in one process, and every
 * mutation rewrites the ENTIRE config.json. Per-instance queues cannot see
 * each other, so an intl sync racing a CN connect would drop the loser's
 * managed provider entry (its credential file stays, but routing 404s). One
 * queue per config dir closes that hole for every plugin instance sharing it.
 */
const configWriteQueues = new Map<string, Promise<unknown>>();
export function serializeQoderConfigWrite<T>(configDir: string, fn: () => Promise<T>): Promise<T> {
  const previous = configWriteQueues.get(configDir) ?? Promise.resolve();
  const job = previous.then(fn, fn);
  configWriteQueues.set(configDir, job.catch(() => {}));
  return job;
}

const RETRY_AFTER_MIN_MS = 30_000;
const RETRY_AFTER_MAX_MS = 30 * 60_000;
const DEFAULT_429_COOLDOWN_MS = 300_000;

/**
 * Shared taxonomy for Qoder's error bodies. The engine folds every upstream
 * failure into an errorResponse JSON whose body carries `retry_after` in
 * seconds (the host cannot see headers), so the 429 cooldown clamps that hint
 * into 30s..30min and falls back to 5 minutes. 403 is transport/permission
 * evidence, never "expired": only upstream 401 maps to reauth.
 */
export function classifyQoderError(status: number, body: unknown): PluginClassifiedError {
  if (status === 0) return { code: "qoder_upstream_error", message: "qoder_upstream_error", httpStatus: 502, retryable: true };
  let hint: any = body;
  if (typeof body === "string") { try { hint = JSON.parse(body); } catch { hint = undefined; } }
  if (status === 401) return { code: "qoder_reauth_required", message: "qoder_reauth_required", httpStatus: 401, retryable: false };
  if (status === 429) {
    const seconds = Number(hint?.retry_after);
    const cooldownMs = Number.isFinite(seconds) && seconds > 0
      ? Math.min(Math.max(seconds * 1000, RETRY_AFTER_MIN_MS), RETRY_AFTER_MAX_MS)
      : DEFAULT_429_COOLDOWN_MS;
    return { code: "qoder_rate_limited", message: "qoder_rate_limited", httpStatus: 429, cooldownMs, retryable: false };
  }
  return { code: "qoder_upstream_error", message: "qoder_upstream_error", httpStatus: status,
    retryable: status >= 500 };
}

/** HTTP-200 hidden-error-envelope detector for the engine's errorResponse shape. */
export function isQoderErrorEnvelope(body: unknown): boolean {
  return (body as any)?.error?.type === "qoder_error";
}

/** PAT format gate: `pt-` prefix, bounded length, no control characters. */
export function validPAT(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("pt-") && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value);
}
