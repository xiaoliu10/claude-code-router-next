/**
 * WorkBuddy (CN + international) — local-only, explicit-user-action admin
 * routes for the dual-site account pools, MOVED VERBATIM from the former
 * inline block in `packages/core/src/ccr/admin-routes.ts` when the provider
 * became a provider plugin (contract §1 item 7).
 *
 * Rewiring only:
 *  - the service resolves through an injected getter (plugin.ts hands the
 *    service it built from ctx.host) instead of `(_app)._server`;
 *  - the allowlist port falls back to 3456 instead of `config.PORT` (the
 *    plugin has no config access; the bound server address is authoritative
 *    at request time).
 *
 * Tokens live in the private 0600 credential file and never appear in any
 * response body or log. Every route keeps the local-only socket guard.
 */
import type { FastifyInstance } from "fastify";
import type { WorkBuddyAuthService } from "./auth-service";

export interface WorkBuddyAdminRouteDeps {
  /** Resolved per request so tests and late wiring stay race-free. */
  getService: () => WorkBuddyAuthService | undefined;
}

export function registerWorkBuddyAdminRoutes(app: FastifyInstance, deps: WorkBuddyAdminRouteDeps): void {
// ========== WorkBuddy built-in provider management API ==========
// All four routes are explicit user actions. They never read the WorkBuddy
// desktop login file except POST /import, and they never expose a token.

/**
 * Local-only guard for WorkBuddy management endpoints. These routes read a
 * local login file and mutate config, so the SOCKET address is the only
 * trustworthy identity: a non-loopback caller is rejected regardless of any
 * header it can spoof (Origin and X-Forwarded-Host are attacker-controlled
 * and must never widen the allowlist). For loopback callers an Origin
 * header, when present, must still match our own UI origin — that is what
 * stops a malicious page in a local browser (DNS rebinding / CSRF) from
 * driving the management API through the victim's own loopback socket.
 * Originless loopback requests (local CLI/tooling) are allowed.
 */
function assertLocalWorkBuddyRequest(req: any): void {
  const deny = (): never => {
    const err: any = new Error("workbuddy_unauthorized");
    err.statusCode = 403;
    throw err;
  };
  const ip = req.ip || (req as any).connection?.remoteAddress || "";
  const isLoopback = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
  if (!isLoopback) deny();
  const origin = req.headers?.origin;
  let host = "";
  try {
    if (origin !== undefined && origin !== "") {
      if (typeof origin !== "string") deny();
      const parsed = new URL(origin);
      if (!["http:", "https:"].includes(parsed.protocol)) deny();
      host = parsed.host;
    }
  } catch {
    deny();
  }
  // Prefer the real listening port (PORT:0 / ephemeral deployments); fall
  // back to the configured port when the server is not listening (tests
  // drive the app through inject() without a socket).
  const address: any = app.server?.address?.();
  const port = typeof address?.port === "number" && address.port > 0
    ? address.port
    : 3456;
  const allowed = new Set<string>([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
  ]);
  // Also pin Host for originless GETs (browsers omit Origin on same-origin GET).
  const authority = req.headers?.host;
  if (typeof authority === "string" && !allowed.has(authority)) deny();
  if (host && !allowed.has(host)) deny();
}

const workBuddyService = deps.getService;

function requireWorkBuddyService(): WorkBuddyAuthService {
  const service = workBuddyService();
  if (!service) throw new Error("WorkBuddy 服务未初始化");
  return service;
}

// ---- §16 multi-site pool management: validation + sanitized errors ----

const WORKBUDDY_SITE_IDS = ["workbuddy", "workbuddy-ai"] as const;
type WorkBuddySiteParam = (typeof WORKBUDDY_SITE_IDS)[number];

/** Strict allowlist: no arbitrary site string ever reaches the service or a URL. */
function parseWorkBuddySite(value: unknown): WorkBuddySiteParam | null {
  return typeof value === "string" && (WORKBUDDY_SITE_IDS as readonly string[]).includes(value)
    ? (value as WorkBuddySiteParam)
    : null;
}

/** Opaque upstream uid: bounded, no control characters. Never logged. */
function parseWorkBuddyUid(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 253 &&
    !/[\x00-\x1f\x7f]/.test(value) ? value : null;
}

/** Model id rules mirror the service's own validation (no comma, no control chars). */
function parseWorkBuddyModel(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    !/[\x00-\x1f\x7f,]/.test(value) ? value : null;
}

/** Allowlisted service error codes and the HTTP status each maps to. */
const WORKBUDDY_ERROR_STATUS: Record<string, number> = {
  workbuddy_unauthorized: 403,
  workbuddy_not_connected: 409,
  workbuddy_name_conflict: 409,
  workbuddy_login_cancelled: 409,
  workbuddy_account_not_found: 404,
  workbuddy_model_invalid: 422,
  workbuddy_login_busy: 429,
  workbuddy_config_write_failed: 500,
};

const isWorkBuddyErrorCode = (value: unknown): value is string =>
  typeof value === "string" && Object.prototype.hasOwnProperty.call(WORKBUDDY_ERROR_STATUS, value);

/**
 * A failed service result becomes an allowlisted code + our own constant
 * message. An unknown code is reported as the generic constant and its
 * message is DROPPED, so nothing upstream- or filesystem-derived leaks.
 */
function workBuddyFailure(reply: any, code: unknown, message?: string | null, fallbackStatus = 422) {
  const known = isWorkBuddyErrorCode(code);
  reply.status(known ? WORKBUDDY_ERROR_STATUS[code as string] : fallbackStatus);
  return {
    ok: false,
    success: false,
    error: known ? code : "workbuddy_request_failed",
    ...(known && typeof message === "string" && message ? { message } : {}),
  };
}

/** Shared catch: 403 for the socket guard, otherwise a constant label (no raw error). */
function workBuddyRouteError(error: any, reply: any, route: string, fallbackCode: string) {
  if (error?.statusCode === 403) {
    reply.status(403);
    return { error: "workbuddy_unauthorized" };
  }
  // An allowlisted code thrown by the service maps to its own status; anything
  // else is a constant 500 label (never the raw error).
  if (isWorkBuddyErrorCode(error?.message)) {
    reply.status(WORKBUDDY_ERROR_STATUS[error.message]);
    return { ok: false, success: false, error: error.message };
  }
  // Classification only: our own codes may be logged; anything else (which
  // could carry a local path or an upstream body) is logged as route name only.
  app.log?.warn?.(
    { route: `workbuddy/${route}`, code: isWorkBuddyErrorCode(error?.message) ? error.message : undefined },
    "WorkBuddy management route failed"
  );
  reply.status(500);
  return { error: fallbackCode };
}

/**
 * §16 recoverable migration gate: a legacy `workbuddy` provider that actually
 * holds international-site credentials must be renamed to `workbuddy-ai`
 * (with its Router refs rewritten) BEFORE the first pool status or management
 * call, otherwise the UI would show the AI pool under the CN provider.
 * Single-flight per process; the service is idempotent and rolls its config
 * write back on failure (no data loss), so a failed attempt is NOT cached and
 * the next call retries.
 */
let workBuddyMigrationGate: Promise<void> | null = null;
function ensureWorkBuddyMigration(): Promise<void> {
  const service = workBuddyService();
  if (!service) return Promise.resolve();
  if (!workBuddyMigrationGate) {
    workBuddyMigrationGate = service.migrateLegacyProviderNaming()
      .then((result) => {
        if (!result.success) {
          workBuddyMigrationGate = null;
          app.log?.warn?.(
            { code: isWorkBuddyErrorCode(result.error) ? result.error : "workbuddy_migration_deferred" },
            "WorkBuddy provider naming migration deferred"
          );
        }
      })
      .catch(() => { workBuddyMigrationGate = null; });
  }
  return workBuddyMigrationGate;
}

/** GET status: flat legacy payload (existing UI) + the §16 per-site pool map. */
app.get("/api/workbuddy/status", async (req: any, reply: any) => {
  try {
    assertLocalWorkBuddyRequest(req);
    const service = requireWorkBuddyService();
    await ensureWorkBuddyMigration();
    const [legacy, pool] = await Promise.all([service.getStatus(), service.getPoolStatus()]);
    return { ...legacy, sites: pool.sites, connectedSites: pool.connectedSites };
  } catch (error: any) {
    return workBuddyRouteError(error, reply, "status", "workbuddy_status_failed");
  }
});

/** §16 pool view: per-site account summaries, hidden models, cooldown badges. */
app.get("/api/workbuddy/pool", async (req: any, reply: any) => {
  try {
    assertLocalWorkBuddyRequest(req);
    const service = requireWorkBuddyService();
    await ensureWorkBuddyMigration();
    const pool = await service.getPoolStatus();
    return { ok: true, sites: pool.sites, connectedSites: pool.connectedSites };
  } catch (error: any) {
    return workBuddyRouteError(error, reply, "pool", "workbuddy_status_failed");
  }
});

/**
 * Quota for one account. `site`/`uid` are optional (legacy callers get the
 * first connected site's active account). Failures return `usage: null` and
 * never an upstream body.
 */
function parseUsageSelector(rawSite: unknown, rawUid: unknown): { site?: WorkBuddySiteParam; uid?: string } | null {
  if (rawSite !== undefined && rawSite !== null && rawSite !== "") {
    const site = parseWorkBuddySite(rawSite);
    if (!site) return null;
    if (rawUid !== undefined && rawUid !== null && rawUid !== "") {
      const uid = parseWorkBuddyUid(rawUid);
      if (!uid) return null;
      return { site, uid };
    }
    return { site };
  }
  if (rawUid !== undefined && rawUid !== null && rawUid !== "") {
    const uid = parseWorkBuddyUid(rawUid);
    if (!uid) return null;
    return { uid };
  }
  return {};
}

// Legacy GET (kept for the existing UI); site/uid may be passed as query args.
app.get("/api/workbuddy/usage", async (req: any, reply: any) => {
  try {
    assertLocalWorkBuddyRequest(req);
    const selector = parseUsageSelector(req.query?.site, req.query?.uid);
    if (!selector) { reply.status(422); return { error: "source_invalid" }; }
    await ensureWorkBuddyMigration();
    return { usage: await requireWorkBuddyService().getUsage(selector.site, selector.uid) };
  } catch (error: any) {
    if (error?.statusCode === 403) { reply.status(403); return { error: "workbuddy_unauthorized" }; }
    return { usage: null };
  }
});

app.post("/api/workbuddy/usage", async (req: any, reply: any) => {
  try {
    assertLocalWorkBuddyRequest(req);
    const selector = parseUsageSelector((req.body as any)?.site, (req.body as any)?.uid);
    if (!selector) { reply.status(422); return { ok: false, error: "source_invalid" }; }
    await ensureWorkBuddyMigration();
    const usage = await requireWorkBuddyService().getUsage(selector.site, selector.uid);
    return { ok: true, usage };
  } catch (error: any) {
    if (error?.statusCode === 403) { reply.status(403); return { error: "workbuddy_unauthorized" }; }
    return { ok: true, usage: null };
  }
});

app.post("/api/workbuddy/import", async (req: any, reply: any) => {
  try {
    assertLocalWorkBuddyRequest(req);
    const site = (req.body as any)?.site ?? "workbuddy";
    if (site !== "workbuddy" && site !== "workbuddy-ai") {
      reply.status(422);
      return { success: false, reason: "source_invalid", modelsUnchanged: true };
    }
    const result = await requireWorkBuddyService().importFromLocalDesktop(site);
    // §16: both sites' pools coexist — there is no cross-site conflict any more.
    if (!result.success && result.error === "workbuddy_name_conflict") {
      reply.status(409);
      return { success: false, error: result.error, message: result.message };
    }
    if (!result.success) {
      reply.status(422);
      return {
        success: false,
        reason: result.reason || "source_invalid",
        message: result.message || "WorkBuddy 导入失败；未改动任何文件",
        modelsUnchanged: true,
      };
    }
    return result;
  } catch (error: any) {
    if (error?.statusCode === 403) {
      reply.status(403);
      return { error: "workbuddy_unauthorized" };
    }
    reply.status(500);
    return { error: "workbuddy_import_failed" };
  }
});

app.post("/api/workbuddy/login/start", async (req: any, reply: any) => {
  try {
    assertLocalWorkBuddyRequest(req);
    const site = (req.body as any)?.site ?? "workbuddy";
    if (site !== "workbuddy" && site !== "workbuddy-ai") {
      reply.status(422);
      return { ok: false, error: "source_invalid" };
    }
    const started = await requireWorkBuddyService().startBrowserLogin(site);
    // §16: cross-site pools coexist, so the only rejection here is "too many
    // pending browser jobs" — never an other-site conflict.
    if (!started.ok) {
      return workBuddyFailure(reply, started.error, null, 429);
    }
    return { ok: true, site, loginId: started.loginId, url: started.url, expiresAt: started.expiresAt };
  } catch (error: any) {
    return workBuddyRouteError(error, reply, "login/start", "workbuddy_login_start_failed");
  }
});

app.post("/api/workbuddy/login/poll", async (req: any, reply: any) => {
  try {
    assertLocalWorkBuddyRequest(req);
    const site = (req.body as any)?.site ?? "workbuddy";
    if (site !== "workbuddy" && site !== "workbuddy-ai") {
      reply.status(422);
      return { status: "failed", reason: "source_invalid" };
    }
    const loginId = req.body?.loginId;
    if (typeof loginId !== "string" || !/^[a-f0-9]{48}$/.test(loginId)) { reply.status(422); return { status: "failed", reason: "source_invalid" }; }
    const result = await requireWorkBuddyService().pollBrowserLogin(site, loginId);
    if (result.status === "connected") {
      // Additive §16 outcome metadata (added vs updated row + committed pool
      // size). Absent when the service did not supply it, so existing
      // clients keep parsing this payload unchanged.
      return {
        status: "connected", success: true, models: result.result.models, modelCount: result.result.modelCount, displayName: result.result.displayName,
        ...(result.result.accountChange ? { accountChange: result.result.accountChange } : {}),
        ...(typeof result.result.accountCount === "number" ? { accountCount: result.result.accountCount } : {}),
      };
    }
    if (result.status === "failed") {
      reply.status(422);
      return { status: "failed", reason: result.reason, message: result.message ?? undefined };
    }
    return result;
  } catch (error: any) {
    if (error?.statusCode === 403) { reply.status(403); return { error: "workbuddy_unauthorized" }; }
    req.log?.warn("WorkBuddy browser sign-in poll failed");
    reply.status(500);
    return { error: "workbuddy_login_poll_failed" };
  }
});

app.post("/api/workbuddy/login/cancel", async (req: any, reply: any) => {
  try {
    assertLocalWorkBuddyRequest(req);
    const { site, loginId } = req.body ?? {};
    if ((site !== "workbuddy" && site !== "workbuddy-ai") || typeof loginId !== "string" || !/^[a-f0-9]{48}$/.test(loginId)) {
      reply.status(422); return { error: "source_invalid" };
    }
    return requireWorkBuddyService().cancelBrowserLogin(site, loginId);
  } catch (error: any) {
    reply.status(error?.statusCode === 403 ? 403 : 500);
    return { error: "workbuddy_login_cancel_failed" };
  }
});

app.post("/api/workbuddy/sync", async (req: any, reply: any) => {
  try {
    assertLocalWorkBuddyRequest(req);
    const rawSite = (req.body as any)?.site;
    let site: WorkBuddySiteParam | undefined;
    if (rawSite !== undefined && rawSite !== null && rawSite !== "") {
      const parsed = parseWorkBuddySite(rawSite);
      if (!parsed) { reply.status(422); return { success: false, reason: "source_invalid", modelsUnchanged: true }; }
      site = parsed;
    }
    await ensureWorkBuddyMigration();
    const result = await requireWorkBuddyService().syncModels(site);
    if (!result.success && result.error === "workbuddy_not_connected") {
      reply.status(409);
      return { success: false, error: "workbuddy_not_connected", message: result.message };
    }
    if (!result.success) {
      reply.status(422);
      return {
        success: false,
        reason: result.reason || "models_fetch_failed",
        message: result.message || "WorkBuddy 模型同步失败；保留原模型列表",
        modelsUnchanged: true,
      };
    }
    return result;
  } catch (error: any) {
    return workBuddyRouteError(error, reply, "sync", "workbuddy_sync_failed");
  }
});

/**
 * Per-site disconnect (§16). With `site` only THAT site's provider + pool are
 * removed (Router references retained); without it the legacy full reset runs
 * for every connected site.
 */
app.post("/api/workbuddy/disconnect", async (req: any, reply: any) => {
  try {
    assertLocalWorkBuddyRequest(req);
    const rawSite = (req.body as any)?.site;
    let site: WorkBuddySiteParam | undefined;
    if (rawSite !== undefined && rawSite !== null && rawSite !== "") {
      const parsed = parseWorkBuddySite(rawSite);
      if (!parsed) { reply.status(422); return { ok: false, error: "source_invalid" }; }
      site = parsed;
    }
    await ensureWorkBuddyMigration();
    const result = await requireWorkBuddyService().disconnect(site);
    return { ok: result.success, site: site ?? null, ...result };
  } catch (error: any) {
    return workBuddyRouteError(error, reply, "disconnect", "workbuddy_disconnect_failed");
  }
});

/**
 * Sticky active-account switch (§16). Store-only: Router, the provider entry
 * and the site epoch are untouched.
 */
app.post("/api/workbuddy/account/switch", async (req: any, reply: any) => {
  try {
    assertLocalWorkBuddyRequest(req);
    const site = parseWorkBuddySite((req.body as any)?.site);
    const uid = parseWorkBuddyUid((req.body as any)?.uid);
    if (!site || !uid) { reply.status(422); return { ok: false, error: "source_invalid" }; }
    await ensureWorkBuddyMigration();
    await requireWorkBuddyService().switchAccount(site, uid);
    // `success` is REQUIRED by the client contract
    // (WorkBuddyMutationResponse.success) and by every other mutating route
    // here (remove/disconnect/hide/restore/sync): without it the UI's
    // `!result.success` tail would report a performed switch as a failure.
    return { ok: true, success: true, site, uid };
  } catch (error: any) {
    return workBuddyRouteError(error, reply, "account/switch", "workbuddy_account_switch_failed");
  }
});

/**
 * Remove one pool account (§16). When the pool empties this performs the
 * SITE-SPECIFIC disconnect (that site's provider removed, its Router refs
 * retained) and never touches the other site.
 */
app.post("/api/workbuddy/account/remove", async (req: any, reply: any) => {
  try {
    assertLocalWorkBuddyRequest(req);
    const site = parseWorkBuddySite((req.body as any)?.site);
    const uid = parseWorkBuddyUid((req.body as any)?.uid);
    if (!site || !uid) { reply.status(422); return { ok: false, error: "source_invalid" }; }
    await ensureWorkBuddyMigration();
    const result = await requireWorkBuddyService().removeAccount(site, uid);
    if (!result.success) return workBuddyFailure(reply, result.error, result.message);
    return {
      ok: true,
      success: true,
      site,
      uid,
      poolEmpty: result.poolEmpty,
      removedProvider: result.removedProvider,
      deletedCredential: result.deletedCredential,
      notice: result.notice ?? null,
    };
  } catch (error: any) {
    return workBuddyRouteError(error, reply, "account/remove", "workbuddy_account_remove_failed");
  }
});

/**
 * Hide one model (§16): blacklists it (survives sync/re-login), removes it
 * from the managed provider and auto-cleans Router references.
 * Response fields:
 *  - `clearedRefs`      Router FIELD PATHS rewritten ("default", "scenario:think", "models:<alias>")
 *  - `removedModelRefs` the actual `provider,model` refs that left Router
 *  - `defaultFallback`  persisted `Router.default` after the rewrite
 */
app.post("/api/workbuddy/models/hide", async (req: any, reply: any) => {
  try {
    assertLocalWorkBuddyRequest(req);
    const site = parseWorkBuddySite((req.body as any)?.site);
    const model = parseWorkBuddyModel((req.body as any)?.model);
    if (!site || !model) { reply.status(422); return { ok: false, error: "source_invalid" }; }
    await ensureWorkBuddyMigration();
    const result = await requireWorkBuddyService().hideModel(site, model);
    if (!result.success) return workBuddyFailure(reply, result.error, result.message);
    return {
      ok: true,
      success: true,
      site,
      model,
      clearedRefs: result.clearedRefs,
      removedModelRefs: result.removedModelRefs ?? [],
      defaultFallback: result.defaultFallback ?? null,
      models: result.models,
    };
  } catch (error: any) {
    return workBuddyRouteError(error, reply, "models/hide", "workbuddy_model_hide_failed");
  }
});

/** Restore one hidden model, or ALL of them when `model` is omitted. Never rewrites Router. */
app.post("/api/workbuddy/models/restore", async (req: any, reply: any) => {
  try {
    assertLocalWorkBuddyRequest(req);
    const site = parseWorkBuddySite((req.body as any)?.site);
    if (!site) { reply.status(422); return { ok: false, error: "source_invalid" }; }
    const rawModel = (req.body as any)?.model;
    let model: string | undefined;
    if (rawModel !== undefined && rawModel !== null && rawModel !== "") {
      const parsed = parseWorkBuddyModel(rawModel);
      if (!parsed) { reply.status(422); return { ok: false, error: "source_invalid" }; }
      model = parsed;
    }
    await ensureWorkBuddyMigration();
    const result = await requireWorkBuddyService().restoreModels(site, model);
    if (!result.success) return workBuddyFailure(reply, result.error, result.message);
    return { ok: true, success: true, site, restored: result.restored, models: result.models };
  } catch (error: any) {
    return workBuddyRouteError(error, reply, "models/restore", "workbuddy_model_restore_failed");
  }
});

}
