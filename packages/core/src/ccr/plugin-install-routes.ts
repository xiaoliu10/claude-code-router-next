/**
 * Provider-plugin marketplace host routes (docs/design/provider-plugins.md §2.2).
 *
 * POST /api/plugins/install — one-click install from the npm registry using
 * the SAME validated install core as the CLI (`ccr plugin add`): strict
 * npm-name allowlist → npm pack (--ignore-scripts, bounded, throwaway
 * credential env) → archive caps → payload validation → staged atomic swap →
 * upsert plugins.json. Nothing hot-loads; callers restart via the existing
 * POST /api/restart flow.
 *
 * GET /api/plugins/catalog — npm registry search for installable provider
 * plugins (marker keyword), merged/deduped, with installed state. Registry
 * failures degrade to an empty list + warning, never a 500.
 *
 * Both routes are LOCAL-ONLY (socket-address identity + loopback Origin/Host
 * pinning, mirroring the workbuddy admin-route guard) on top of the normal
 * CCR auth pipeline. Responses never include npm stderr, registry URLs or any
 * credential material.
 */
import type { FastifyInstance } from "fastify";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  NPM_SPEC_PATTERN,
  PluginInstallError,
  installPluginFromNpm,
  readPluginRecords,
  type PluginInstallErrorCode,
} from "@wengine-ai/claude-code-router-shared";

/** npm search marker keywords: a package is only OFFERED when its
 *  package.json declares one of these (the search endpoint indexes exactly
 *  those package.json keywords). */
export const PLUGIN_MARKER_KEYWORDS = [
  "ccr-provider-plugin",
  "claude-code-router-plugin",
] as const;

/** Default registry searched by GET /api/plugins/catalog. */
export const PLUGIN_CATALOG_REGISTRY = "https://registry.npmjs.org";

export interface CatalogEntry {
  name: string;
  description: string;
  version: string;
  installed: boolean;
  installedVersion: string | null;
}

export interface CatalogResult {
  ok: true;
  plugins: CatalogEntry[];
  /** Stable code when the registry could not be reached at all. */
  warning?: "registry_unavailable";
}

interface NpmSearchObject {
  package?: {
    name?: unknown;
    version?: unknown;
    description?: unknown;
    keywords?: unknown;
  };
}

/** Query the npm search endpoint once and return the raw objects. Throws on
 *  any failure; the route turns that into the stable warning. */
async function searchNpm(
  base: string,
  keyword: string,
  timeoutMs: number
): Promise<NpmSearchObject[]> {
  const url = `${base}/-/v1/search?text=${encodeURIComponent(`keywords:${keyword}`)}&size=100`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`registry_status_${response.status}`);
  const body: any = await response.json();
  return Array.isArray(body?.objects) ? body.objects : [];
}

/** Build the marketplace catalog: npm registry search by marker keyword,
 *  merged/deduped by package name, annotated with installed state. A total
 *  registry outage degrades to an empty list + warning — never a 500 and
 *  never raw upstream error text. */
export async function buildPluginCatalog(
  configDir: string,
  options: { registryBase?: string; timeoutMs?: number } = {}
): Promise<CatalogResult> {
  const base = (options.registryBase ?? PLUGIN_CATALOG_REGISTRY).replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? 30_000;
  const searches = await Promise.allSettled(
    PLUGIN_MARKER_KEYWORDS.map((keyword) => searchNpm(base, keyword, timeoutMs))
  );
  const byName = new Map<string, { name: string; description: string; version: string }>();
  let anySettled = false;
  for (const search of searches) {
    if (search.status !== "fulfilled") continue;
    anySettled = true;
    for (const object of search.value) {
      const pkg = object?.package;
      const name = typeof pkg?.name === "string" ? pkg.name : "";
      if (!name || !NPM_SPEC_PATTERN.test(name)) continue;
      const keywords = Array.isArray(pkg?.keywords)
        ? pkg.keywords.filter((k): k is string => typeof k === "string")
        : [];
      // Defense in depth: the search index should only return keyword
      // matches, but never offer a package the marker keyword does not
      // vouch for.
      if (!keywords.some((k) => (PLUGIN_MARKER_KEYWORDS as readonly string[]).includes(k))) continue;
      const version = typeof pkg?.version === "string" ? pkg.version : "";
      if (!byName.has(name)) {
        byName.set(name, {
          name,
          version,
          description: typeof pkg?.description === "string" ? pkg.description : "",
        });
      }
    }
  }
  if (!anySettled) {
    return { ok: true, plugins: [], warning: "registry_unavailable" };
  }

  const records = readPluginRecords(configDir);
  const recordByName = new Map(records.map((r) => [r.name, r]));
  // Installed manifest version comes from the plugin payload, not npm.
  const installedVersion = (name: string): string | null => {
    try {
      const raw = JSON.parse(
        readFileSync(join(configDir, "plugins", name, "plugin.json"), "utf8")
      );
      return typeof raw?.version === "string" ? raw.version : null;
    } catch {
      return null;
    }
  };
  const plugins: CatalogEntry[] = [...byName.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => {
      const installed = recordByName.has(entry.name) || existsSync(join(configDir, "plugins", entry.name));
      return {
        ...entry,
        installed,
        installedVersion: installed ? installedVersion(entry.name) : null,
      };
    });
  return { ok: true, plugins };
}

export interface PluginMarketRouteDeps {
  /** $CCR_CONFIG_DIR (the plugins/ root the loader reads). */
  configDir: string;
  /** Configured PORT fallback when the server is not listening (tests that
   *  inject() without a socket). */
  configuredPort?: number;
  /** Test seams. */
  /** npm registry used by the install lane (defaults to npm's own registry).
   *  Also serves as the catalog base unless catalogRegistryBase is given. */
  registry?: string;
  npmTimeoutMs?: number;
  /** Registry base for catalog search (tests stub this). */
  catalogRegistryBase?: string;
  /** Bounded catalog network wait (tests use small values). */
  catalogTimeoutMs?: number;
}

/** HTTP status for a stable install error code. Only the contract-pinned
 *  mappings are load-bearing (corrupted → 409, bad name → 400); everything
 *  else follows "client fixable" vs "registry broke" vs "we broke". */
export function installErrorStatus(code: PluginInstallErrorCode | "install_failed"): number {
  switch (code) {
    case "invalid_spec":
      return 400;
    case "already_installed":
    case "plugins_json_corrupted":
      return 409;
    case "npm_pack_failed":
    case "npm_pack_timeout":
      return 502;
    case "archive_too_large":
    case "archive_too_many_files":
    case "unsafe_archive_member":
    case "extract_failed":
    case "invalid_manifest":
      return 422;
    default:
      return 500;
  }
}

/**
 * Local-only guard for the marketplace routes. The SOCKET address is the only
 * trustworthy identity: a non-loopback caller is rejected regardless of any
 * header it can spoof. For loopback callers an Origin header, when present,
 * must match this server's own loopback authority, and a Host header must do
 * the same — that is what stops a malicious local page (DNS rebinding / CSRF)
 * from driving installs through the victim's own loopback socket.
 * Originless loopback requests (local CLI/tooling) are allowed.
 */
export function assertLocalMarketplaceRequest(
  req: any,
  app: FastifyInstance,
  configuredPort: number
): boolean {
  const ip = req.ip || req.connection?.remoteAddress || "";
  const isLoopback = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
  if (!isLoopback) return false;

  // Prefer the real listening port (PORT:0 / ephemeral deployments); fall
  // back to the configured port when the server is not listening (tests drive
  // the app through inject() without a socket).
  const address: any = (app as any).server?.address?.();
  const port = typeof address?.port === "number" && address.port > 0
    ? address.port
    : configuredPort;
  const allowed = new Set<string>([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
  ]);
  const authority = req.headers?.host;
  if (typeof authority === "string" && !allowed.has(authority)) return false;

  const origin = req.headers?.origin;
  if (origin !== undefined && origin !== "") {
    if (typeof origin !== "string") return false;
    let host = "";
    try {
      const parsed = new URL(origin);
      if (!["http:", "https:"].includes(parsed.protocol)) return false;
      host = parsed.host;
    } catch {
      return false;
    }
    if (!allowed.has(host)) return false;
  }
  return true;
}

export function registerPluginMarketRoutes(
  app: FastifyInstance,
  deps: PluginMarketRouteDeps
): void {
  const configuredPort = deps.configuredPort ?? 3456;

  const deny = (reply: any, status: number, code: string) =>
    reply.status(status).send({ ok: false, error: code });

  app.get("/api/plugins/catalog", async (req: any, reply: any) => {
    if (!assertLocalMarketplaceRequest(req, app, configuredPort)) {
      return deny(reply, 403, "local_only");
    }
    try {
      return await buildPluginCatalog(deps.configDir, {
        registryBase: deps.catalogRegistryBase ?? deps.registry,
        timeoutMs: deps.catalogTimeoutMs,
      });
    } catch (error: any) {
      // buildPluginCatalog already tolerates registry failures; this is the
      // belt-and-braces branch so no upstream detail can ever leak as a 500.
      app.log?.warn?.(`plugin catalog failed: ${error?.code ?? error?.name ?? "error"}`);
      return { ok: true, plugins: [], warning: "registry_unavailable" };
    }
  });

  app.post("/api/plugins/install", async (req: any, reply: any) => {
    if (!assertLocalMarketplaceRequest(req, app, configuredPort)) {
      return deny(reply, 403, "local_only");
    }
    const body = (req.body ?? {}) as { name?: unknown; spec?: unknown; force?: unknown };
    const rawSpec = body.name ?? body.spec;
    const force = body.force === true;
    try {
      const result = await installPluginFromNpm({
        spec: rawSpec as string,
        configDir: deps.configDir,
        force,
        registry: deps.registry,
        timeoutMs: deps.npmTimeoutMs,
      });
      app.log?.info?.(
        `provider plugin installed via API: ${result.manifest.name}@${result.manifest.version} (restart to activate)`
      );
      return {
        ok: true,
        name: result.manifest.name,
        version: result.manifest.version,
        restartRequired: true,
      };
    } catch (error: any) {
      if (error instanceof PluginInstallError) {
        const status = installErrorStatus(error.code);
        if (status === 502) {
          // Registry-side failure: npm output may contain registry URLs,
          // config paths or token hints — log the stable shape only.
          app.log?.warn?.(`plugin install failed: ${error.code}`);
        } else {
          app.log?.warn?.(`plugin install rejected: ${error.code}: ${error.message}`);
        }
        return deny(reply, status, error.code);
      }
      app.log?.error?.(`plugin install crashed: ${error?.message ?? error}`);
      return deny(reply, 500, "install_failed");
    }
  });
}
