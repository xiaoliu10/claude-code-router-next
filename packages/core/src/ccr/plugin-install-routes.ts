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
import {
  PluginInstallError,
  installPluginFromNpm,
  type PluginInstallErrorCode,
} from "@wengine-ai/claude-code-router-shared";

export interface PluginMarketRouteDeps {
  /** $CCR_CONFIG_DIR (the plugins/ root the loader reads). */
  configDir: string;
  /** Configured PORT fallback when the server is not listening (tests that
   *  inject() without a socket). */
  configuredPort?: number;
  /** Test seams. */
  registryUrl?: string;
  npmTimeoutMs?: number;
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
        registry: deps.registryUrl,
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
