import { Agent, ProxyAgent } from "undici";
import type { ConfigService } from "./config";

export interface ProxyAwareProvider {
  proxyEnabled?: boolean;
  proxy_enabled?: boolean;
}

export const PROXY_URL_KEYS = [
  "HTTPS_PROXY",
  "https_proxy",
  "httpsProxy",
  "PROXY_URL",
] as const;

// Matches environment-variable placeholders ($VAR or ${VAR}) used in raw config
// files. When a proxy URL contains such a placeholder we cannot statically
// validate the final URL (it is resolved at runtime via interpolateEnvVars),
// so we accept it and let getProxyDispatcher/normalizeProxyUrl enforce the
// http(s)-only contract once the value is concrete.
const ENV_VAR_PLACEHOLDER_PATTERN = /\$\{[^}]+\}|\$[A-Z_][A-Z0-9_]*/;

export type ProxyUrlValidation =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Validate a proxy URL config value *before* it is persisted.
 *
 * Acceptance rules:
 *   1. Empty / whitespace-only value is allowed (means "no proxy").
 *   2. Values containing an env-var placeholder ($VAR / ${VAR}) are allowed —
 *      they are raw config that gets interpolated at runtime; the final URL is
 *      still subject to normalizeProxyUrl's http(s)-only check at request time.
 *   3. Otherwise the value must parse as a URL with protocol http: or https:.
 *
 * This does NOT replace the runtime contract: getProxyDispatcher still throws
 * TypeError for unsupported protocols when a request actually uses the proxy.
 */
export function validateProxyUrl(rawUrl: unknown): ProxyUrlValidation {
  if (rawUrl === undefined || rawUrl === null) return { ok: true };

  const trimmed = String(rawUrl).trim();
  if (!trimmed) return { ok: true };

  if (ENV_VAR_PLACEHOLDER_PATTERN.test(trimmed)) return { ok: true };

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return {
        ok: false,
        error: `Unsupported proxy protocol: ${parsed.protocol}. Only http:// and https:// are allowed.`,
      };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: `Invalid proxy URL: ${trimmed}` };
  }
}

/**
 * Scan a config object for any proxy-related keys (PROXY_URL plus the
 * compatibility aliases) and return a list of human-readable validation
 * errors. Returns an empty array when every value is valid.
 */
export function findInvalidProxyUrls(
  config: Record<string, unknown>
): Array<{ key: string; error: string }> {
  const errors: Array<{ key: string; error: string }> = [];
  for (const key of PROXY_URL_KEYS) {
    const value = config[key];
    if (value === undefined || value === null) continue;
    const result = validateProxyUrl(value);
    if (!result.ok) {
      errors.push({ key, error: result.error });
    }
  }
  return errors;
}

const proxyDispatchers = new Map<string, ProxyAgent>();
let directDispatcher: Agent | undefined;

/** A process-wide direct dispatcher, used by fixed-origin providers that must ignore configured proxies. */
export function getDirectDispatcher(): Agent {
  if (!directDispatcher) directDispatcher = new Agent({ connect: { timeout: 15_000 } });
  return directDispatcher;
}

/**
 * Resolve the configured proxy URL using the compatibility key priority.
 */
export function getConfiguredProxyUrl(
  configService: Pick<ConfigService, "get">
): string | undefined {
  for (const key of PROXY_URL_KEYS) {
    const value = configService.get<unknown>(key);
    if (value === undefined || value === null) {
      continue;
    }

    const normalizedValue = String(value).trim();
    if (normalizedValue) {
      return normalizedValue;
    }
  }

  return undefined;
}

/**
 * Interpret the global proxy policy. Missing values keep the legacy behavior
 * where a configured proxy applies to every provider. Unknown values use
 * normal JavaScript truthiness after strings are trimmed.
 */
export function isGlobalProxyEnabled(value: unknown): boolean {
  if (value === undefined || value === null || value === "") {
    return true;
  }

  if (typeof value === "string") {
    const normalizedValue = value.trim().toLowerCase();
    if (normalizedValue === "false" || normalizedValue === "0") {
      return false;
    }
    if (normalizedValue === "true" || normalizedValue === "1") {
      return true;
    }
    return Boolean(normalizedValue);
  }

  if (value === false || value === 0) {
    return false;
  }
  if (value === true || value === 1) {
    return true;
  }

  return Boolean(value);
}

/**
 * Resolve whether a provider-specific request should use the configured proxy.
 */
export function resolveProviderProxyUrl(
  configService: Pick<ConfigService, "get">,
  provider?: ProxyAwareProvider
): string | undefined {
  const proxyUrl = getConfiguredProxyUrl(configService);
  if (!proxyUrl) {
    return undefined;
  }

  if (isGlobalProxyEnabled(configService.get("PROXY_GLOBAL_ENABLED"))) {
    return proxyUrl;
  }

  return provider?.proxyEnabled === true || provider?.proxy_enabled === true
    ? proxyUrl
    : undefined;
}

/**
 * Return a cached dispatcher for a normalized HTTP(S) proxy URL.
 */
export function getProxyDispatcher(proxyUrl: string): ProxyAgent {
  const normalizedProxyUrl = normalizeProxyUrl(proxyUrl);
  const cachedDispatcher = proxyDispatchers.get(normalizedProxyUrl);
  if (cachedDispatcher) {
    return cachedDispatcher;
  }

  const dispatcher = new ProxyAgent(normalizedProxyUrl);
  proxyDispatchers.set(normalizedProxyUrl, dispatcher);
  return dispatcher;
}

/**
 * Close and clear all cached proxy dispatchers.
 */
export async function closeProxyDispatchers(): Promise<void> {
  const dispatchers = Array.from(proxyDispatchers.values());
  proxyDispatchers.clear();
  await Promise.allSettled(dispatchers.map((dispatcher) => dispatcher.close()));
}

function normalizeProxyUrl(proxyUrl: string): string {
  const trimmedProxyUrl = proxyUrl.trim();
  if (!trimmedProxyUrl) {
    throw new TypeError("Proxy URL must not be empty");
  }

  const parsedProxyUrl = new URL(trimmedProxyUrl);
  if (parsedProxyUrl.protocol !== "http:" && parsedProxyUrl.protocol !== "https:") {
    throw new TypeError(`Unsupported proxy protocol: ${parsedProxyUrl.protocol}`);
  }

  return parsedProxyUrl.toString();
}
