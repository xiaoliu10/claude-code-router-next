/**
 * Gemini OAuth (Antigravity) — the six local-only, explicit user-action admin
 * routes, MOVED VERBATIM from the former inline block in
 * `packages/core/src/ccr/admin-routes.ts` when the provider became the first
 * provider plugin.
 *
 * Rewiring only:
 *  - the service resolves through an injected getter (plugin.ts hands the
 *    service it built from ctx.host) instead of `(_app)._server`;
 *  - the allowlist port falls back to 3456 instead of `config.PORT` (the
 *    plugin has no config access; the bound server address is authoritative
 *    at request time).
 *
 * Tokens live in the private 0600 credential file and are never present in
 * any response body or log.
 */
import type { FastifyInstance } from "fastify";
import { GeminiOauthAuthService } from "./auth-service";

export interface GeminiOauthAdminRouteDeps {
  /** Resolved per request so tests and late wiring stay race-free. */
  getService: () => GeminiOauthAuthService | undefined;
}

export function registerGeminiOauthAdminRoutes(app: FastifyInstance, deps: GeminiOauthAdminRouteDeps): void {
  /**
   * Local-only guard, identical in shape to the WorkBuddy one: the socket
   * address is the only trustworthy identity; a browser Origin, when present,
   * must match our own authority. Originless loopback (local CLI) is allowed.
   */
  function assertLocalGeminiOauthRequest(req: any): void {
    const deny = (): never => {
      const err: any = new Error("gemini_oauth_unauthorized");
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
    const address: any = (app as any).server?.address?.();
    const port = typeof address?.port === "number" && address.port > 0
      ? address.port
      : 3456;
    const allowed = new Set<string>([
      `127.0.0.1:${port}`,
      `localhost:${port}`,
      `[::1]:${port}`,
    ]);
    const authority = req.headers?.host;
    if (typeof authority === "string" && !allowed.has(authority)) deny();
    if (host && !allowed.has(host)) deny();
  }

  /**
   * Allowlisted admin error codes and the HTTP status each maps to at the ROUTE
   * boundary. Note: gemini_oauth_reauth_required is deliberately 422 here even
   * though the service stamps it 401 — the UI's global fetch layer intercepts
   * every 401 as an expired CCR api key (wipe + redirect), so the code must
   * travel on a non-401 status to be surfaced as the localized account error.
   */
  const GEMINI_OAUTH_ERROR_STATUS: Record<string, number> = {
    gemini_oauth_unauthorized: 403,
    gemini_oauth_not_configured: 503,
    gemini_oauth_login_busy: 429,
    gemini_oauth_not_connected: 409,
    gemini_oauth_name_conflict: 409,
    gemini_oauth_login_cancelled: 409,
    gemini_oauth_login_state_rejected: 422,
    gemini_oauth_login_account_failed: 422,
    gemini_oauth_models_fetch_failed: 422,
    gemini_oauth_reauth_required: 422,
    gemini_oauth_login_persist_failed: 500,
    gemini_oauth_config_write_failed: 500,
  };

  const isGeminiOauthErrorCode = (value: unknown): value is string =>
    typeof value === "string" && Object.prototype.hasOwnProperty.call(GEMINI_OAUTH_ERROR_STATUS, value);

  function geminiOauthFailure(reply: any, code: unknown, fallbackStatus = 422) {
    const known = isGeminiOauthErrorCode(code);
    reply.status(known ? GEMINI_OAUTH_ERROR_STATUS[code as string] : fallbackStatus);
    return { ok: false, success: false, error: known ? code : "gemini_oauth_request_failed" };
  }

  /** Shared catch: 403 from the socket guard, otherwise the code's mapped
   *  status; unknown errors become a constant 500 label (raw message dropped). */
  function geminiOauthRouteError(error: any, reply: any, route: string, fallbackCode: string) {
    if (error?.statusCode === 403) {
      reply.status(403);
      return { ok: false, success: false, error: "gemini_oauth_unauthorized" };
    }
    // The service throws geminiOauthAdminError with the stable code in error.code
    // (NOT error.message as WorkBuddy does).
    if (isGeminiOauthErrorCode(error?.code)) {
      reply.status(GEMINI_OAUTH_ERROR_STATUS[error.code]);
      return { ok: false, success: false, error: error.code };
    }
    app.log?.warn?.(
      { route: `gemini-oauth/${route}`, code: isGeminiOauthErrorCode(error?.code) ? error.code : undefined },
      "Gemini OAuth management route failed"
    );
    reply.status(500);
    return { ok: false, success: false, error: fallbackCode };
  }

  const GEMINI_OAUTH_LOGIN_ID_RE = /^[a-f0-9]{48}$/;

  app.get("/api/gemini-oauth/status", async (req: any, reply: any) => {
    try {
      assertLocalGeminiOauthRequest(req);
      const service = deps.getService();
      if (!service) return geminiOauthFailure(reply, "gemini_oauth_not_configured", 503);
      return await service.getStatus();
    } catch (error: any) {
      return geminiOauthRouteError(error, reply, "status", "gemini_oauth_status_failed");
    }
  });

  app.post("/api/gemini-oauth/login/start", async (req: any, reply: any) => {
    try {
      assertLocalGeminiOauthRequest(req);
      const service = deps.getService();
      if (!service) return geminiOauthFailure(reply, "gemini_oauth_not_configured", 503);
      const started = await service.startLogin();
      // Exactly the three fields the UI type declares (no ok/success wrapper).
      return { loginId: started.loginId, url: started.url, expiresAt: started.expiresAt };
    } catch (error: any) {
      return geminiOauthRouteError(error, reply, "login/start", "gemini_oauth_login_start_failed");
    }
  });

  app.post("/api/gemini-oauth/login/poll", async (req: any, reply: any) => {
    try {
      assertLocalGeminiOauthRequest(req);
      const service = deps.getService();
      if (!service) return geminiOauthFailure(reply, "gemini_oauth_not_configured", 503);
      const loginId = (req.body as any)?.loginId;
      if (typeof loginId !== "string" || !GEMINI_OAUTH_LOGIN_ID_RE.test(loginId)) {
        reply.status(422);
        return { status: "failed", error: "gemini_oauth_login_state_rejected" };
      }
      const result = await service.pollLogin(loginId);
      if (result.status === "failed") {
        reply.status(422);
        return { status: "failed", error: result.error };
      }
      // 200 for both {status:"pending"} and {status:"success",email}.
      return result;
    } catch (error: any) {
      return geminiOauthRouteError(error, reply, "login/poll", "gemini_oauth_login_poll_failed");
    }
  });

  app.post("/api/gemini-oauth/login/cancel", async (req: any, reply: any) => {
    try {
      assertLocalGeminiOauthRequest(req);
      const service = deps.getService();
      if (!service) return geminiOauthFailure(reply, "gemini_oauth_not_configured", 503);
      const loginId = (req.body as any)?.loginId;
      if (typeof loginId !== "string" || !GEMINI_OAUTH_LOGIN_ID_RE.test(loginId)) {
        reply.status(422);
        return { ok: false, success: false, error: "gemini_oauth_login_state_rejected" };
      }
      return service.cancelLogin(loginId);
    } catch (error: any) {
      return geminiOauthRouteError(error, reply, "login/cancel", "gemini_oauth_login_cancel_failed");
    }
  });

  app.post("/api/gemini-oauth/sync", async (req: any, reply: any) => {
    try {
      assertLocalGeminiOauthRequest(req);
      const service = deps.getService();
      if (!service) return geminiOauthFailure(reply, "gemini_oauth_not_configured", 503);
      const result = await service.syncModels();
      if (!result.ok) {
        // Fetch failure keeps the previous model list — returned, not thrown.
        reply.status(422);
        return result;
      }
      return result;
    } catch (error: any) {
      return geminiOauthRouteError(error, reply, "sync", "gemini_oauth_sync_failed");
    }
  });

  app.post("/api/gemini-oauth/disconnect", async (req: any, reply: any) => {
    try {
      assertLocalGeminiOauthRequest(req);
      const service = deps.getService();
      if (!service) return geminiOauthFailure(reply, "gemini_oauth_not_configured", 503);
      return await service.disconnect();
    } catch (error: any) {
      return geminiOauthRouteError(error, reply, "disconnect", "gemini_oauth_disconnect_failed");
    }
  });
}
