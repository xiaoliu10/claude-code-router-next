/**
 * Codex subscription — ten local-only, explicit user-action admin routes
 * under the `/api/codex` namespace (the manifest name is `codex`, and the UI
 * bridge builds `/api` + `/codex${path}`).
 *
 *  GET  /status
 *  POST /login/start     {}
 *  POST /login/poll      {loginId}
 *  POST /login/complete  {loginId,callbackUrl}   (paste fallback)
 *  POST /login/cancel    {loginId}
 *  POST /sync            {}
 *  POST /usage           {}
 *  POST /disconnect      {}
 *  POST /models/hide     {model}            (blacklist one model)
 *  POST /models/restore  {model?}           (no model = restore ALL)
 *
 * Guard shape is identical to the gemini-oauth / workbuddy plugins: the loopback
 * socket address is the only trustworthy identity, plus a Host/Origin allowlist
 * pinned to the actual bound port. A browser Origin must match our authority;
 * an originless loopback request (local CLI) is allowed.
 *
 * The 401 rule: the UI's global fetch layer turns EVERY 401 into a CCR-api-key
 * logout, so Codex reauth travels as 422 and no route here ever answers 401.
 * Unknown failures collapse to a constant code; raw upstream messages and
 * tokens are never echoed.
 */
import type { FastifyInstance } from "fastify";
import type { CodexAuthService } from "./auth-service";
import { codexAdminError, isCodexModelId } from "./protocol";

export interface CodexAdminRouteDeps {
  /** Resolved per request so tests and late wiring stay race-free. */
  getService: () => CodexAuthService | undefined;
}

/** A loginId is randomBytes(16).toString("hex") — exactly 32 lowercase hex. */
const CODEX_LOGIN_ID_RE = /^[a-f0-9]{32}$/;

export function registerCodexAdminRoutes(app: FastifyInstance, deps: CodexAdminRouteDeps): void {
  /**
   * Local-only guard: loopback socket + Host/Origin allowlist against the
   * real bound port. Any mismatch is a 403 carrying the stable code.
   */
  function assertLocalCodexRequest(req: any): void {
    const deny = (): never => {
      const err: any = new Error("codex_unauthorized");
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
    const port = typeof address?.port === "number" && address.port > 0 ? address.port : 3456;
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
   * Allowlisted admin error codes → HTTP status at the route boundary. Never
   * 401 (see file header). Data-plane codes can also appear on the account's
   * status surface and are accepted here for completeness.
   */
  const CODEX_ERROR_STATUS: Record<string, number> = {
    codex_unauthorized: 403,
    codex_not_connected: 409,
    codex_login_busy: 429,
    codex_login_cancelled: 409,
    codex_login_state_rejected: 422,
    codex_login_expired: 410,
    codex_login_exchange_failed: 422,
    codex_login_persist_failed: 500,
    codex_credential_invalid: 422,
    codex_credential_unreadable: 500,
    codex_config_write_failed: 500,
    codex_models_fetch_failed: 422,
    codex_reauth_required: 422,
    codex_model_invalid: 422,
    codex_reset_busy: 429,
    codex_reset_no_credit: 409,
    codex_reset_unavailable: 502,
    codex_reset_invalid: 422,
    codex_reset_failed: 500,
  };

  const isCodexErrorCode = (value: unknown): value is string =>
    typeof value === "string" && Object.prototype.hasOwnProperty.call(CODEX_ERROR_STATUS, value);

  /** Shared catch: 403 from the socket guard, otherwise the code's mapped
   *  status; unknown errors become a constant 500 label (raw message dropped). */
  function codexRouteError(error: any, reply: any, route: string, fallbackCode: string) {
    if (error?.statusCode === 403) {
      reply.status(403);
      return { ok: false, success: false, error: "codex_unauthorized" };
    }
    // The service throws codexAdminError with the stable code in error.code.
    if (isCodexErrorCode(error?.code)) {
      reply.status(CODEX_ERROR_STATUS[error.code]);
      return { ok: false, success: false, error: error.code };
    }
    app.log?.warn?.(
      { route: `codex/${route}`, code: isCodexErrorCode(error?.code) ? error.code : undefined },
      "Codex management route failed"
    );
    reply.status(500);
    return { ok: false, success: false, error: fallbackCode };
  }

  function requireLoginId(body: any): string | null {
    const loginId = body?.loginId;
    return typeof loginId === "string" && CODEX_LOGIN_ID_RE.test(loginId) ? loginId : null;
  }

  function invalidLoginId(reply: any) {
    reply.status(422);
    return { ok: false, success: false, error: "codex_login_state_rejected" };
  }

  app.get("/api/codex/status", async (req: any, reply: any) => {
    try {
      assertLocalCodexRequest(req);
      const service = deps.getService();
      if (!service) {
        reply.status(503);
        return { ok: false, success: false, error: "codex_request_failed" };
      }
      // CodexStatus verbatim: redacted shape the card parser requires.
      return await service.getStatus();
    } catch (error: any) {
      return codexRouteError(error, reply, "status", "codex_request_failed");
    }
  });

  app.post("/api/codex/login/start", async (req: any, reply: any) => {
    try {
      assertLocalCodexRequest(req);
      const service = deps.getService();
      if (!service) {
        reply.status(503);
        return { ok: false, success: false, error: "codex_request_failed" };
      }
      // Exactly the CodexLoginStart fields (loginId/url/expiresAt/mode/
      // redirectUri) — the card requires all five and fails closed otherwise.
      return await service.startLogin();
    } catch (error: any) {
      return codexRouteError(error, reply, "login/start", "codex_request_failed");
    }
  });

  app.post("/api/codex/login/poll", async (req: any, reply: any) => {
    try {
      assertLocalCodexRequest(req);
      const service = deps.getService();
      if (!service) {
        reply.status(503);
        return { ok: false, success: false, error: "codex_request_failed" };
      }
      const loginId = requireLoginId(req.body);
      if (!loginId) return invalidLoginId(reply);
      // CodexLoginPoll verbatim, 200 for every terminal state (pending/
      // connected/cancelled/expired/error) — the card loop keys off the body.
      return await service.pollLogin(loginId);
    } catch (error: any) {
      return codexRouteError(error, reply, "login/poll", "codex_request_failed");
    }
  });

  app.post("/api/codex/login/complete", async (req: any, reply: any) => {
    try {
      assertLocalCodexRequest(req);
      const service = deps.getService();
      if (!service) {
        reply.status(503);
        return { ok: false, success: false, error: "codex_request_failed" };
      }
      const loginId = requireLoginId(req.body);
      const callbackUrl = (req.body as any)?.callbackUrl;
      if (!loginId || typeof callbackUrl !== "string" || !callbackUrl) return invalidLoginId(reply);
      // The service validates the loopback callback URL, state and one-use
      // semantics; the rejected/terminal verdict rides the same poll shape.
      return await service.submitCallback(loginId, callbackUrl);
    } catch (error: any) {
      return codexRouteError(error, reply, "login/complete", "codex_request_failed");
    }
  });

  app.post("/api/codex/login/cancel", async (req: any, reply: any) => {
    try {
      assertLocalCodexRequest(req);
      const service = deps.getService();
      if (!service) {
        reply.status(503);
        return { ok: false, success: false, error: "codex_request_failed" };
      }
      const loginId = requireLoginId(req.body);
      if (!loginId) return invalidLoginId(reply);
      await service.cancelLogin(loginId);
      return { ok: true };
    } catch (error: any) {
      return codexRouteError(error, reply, "login/cancel", "codex_request_failed");
    }
  });

  app.post("/api/codex/sync", async (req: any, reply: any) => {
    try {
      assertLocalCodexRequest(req);
      const service = deps.getService();
      if (!service) {
        reply.status(503);
        return { ok: false, success: false, error: "codex_request_failed" };
      }
      // {success:true,models,modelCount}; a fetch failure throws a mapped
      // codex_models_fetch_failed (422) — no stale echo of upstream text.
      return await service.syncModels();
    } catch (error: any) {
      return codexRouteError(error, reply, "sync", "codex_request_failed");
    }
  });

  /**
   * Hide one model: blacklists it in codex-credentials.json (survives
   * sync/re-login), removes it from registration and clears matching Router
   * references, migrating default to the first visible model when available. Idempotent; hiding the last visible model is allowed.
   */
  app.post("/api/codex/models/hide", async (req: any, reply: any) => {
    try {
      assertLocalCodexRequest(req);
      const service = deps.getService();
      if (!service) {
        reply.status(503);
        return { ok: false, success: false, error: "codex_request_failed" };
      }
      // Format gate here (the service re-checks): stable 422 code, no echo.
      const model = (req.body as any)?.model;
      if (!isCodexModelId(model)) {
        reply.status(422);
        return { ok: false, success: false, error: "codex_model_invalid" };
      }
      const result = await service.hideModel(model);
      // `ok`+`success` mirror the workbuddy mutating-route contract: the card
      // keys off `success`, `ok` keeps the error-envelope shape symmetric.
      return { ok: true, ...result };
    } catch (error: any) {
      return codexRouteError(error, reply, "models/hide", "codex_model_hide_failed");
    }
  });

  /** Restore one hidden model, or ALL of them when `model` is omitted/empty. */
  app.post("/api/codex/models/restore", async (req: any, reply: any) => {
    try {
      assertLocalCodexRequest(req);
      const service = deps.getService();
      if (!service) {
        reply.status(503);
        return { ok: false, success: false, error: "codex_request_failed" };
      }
      // Absent, null or empty-string model means restore-ALL (workbuddy parity);
      // anything else must be a well-formed model id.
      const raw = (req.body as any)?.model;
      let model: string | undefined;
      if (raw !== undefined && raw !== null && raw !== "") {
        if (!isCodexModelId(raw)) {
          reply.status(422);
          return { ok: false, success: false, error: "codex_model_invalid" };
        }
        model = raw;
      }
      const result = await service.restoreModels(model);
      return { ok: true, ...result };
    } catch (error: any) {
      return codexRouteError(error, reply, "models/restore", "codex_model_restore_failed");
    }
  });

  app.post("/api/codex/usage", async (req: any, reply: any) => {
    try {
      assertLocalCodexRequest(req);
      const service = deps.getService();
      if (!service) {
        reply.status(503);
        return { ok: false, success: false, error: "codex_request_failed" };
      }
      // CodexUsage|null; windows carry epoch-ms resetAt. Absent quota surface
      // is null (the card treats that as "no quota info"), never fatal.
      const usage = await service.getUsage();
      reply.status(200);
      return usage;
    } catch (error: any) {
      return codexRouteError(error, reply, "usage", "codex_request_failed");
    }
  });

  /** Available gifted usage resets (read-only listing; upstream-owned count). */
  app.get("/api/codex/reset-credits", async (req: any, reply: any) => {
    try {
      assertLocalCodexRequest(req);
      const service = deps.getService();
      if (!service) {
        reply.status(503);
        return { ok: false, success: false, error: "codex_request_failed" };
      }
      reply.status(200);
      return await service.getResetCredits();
    } catch (error: any) {
      return codexRouteError(error, reply, "reset-credits", "codex_request_failed");
    }
  });

  /**
   * Consume ONE gifted reset credit — the only mutating reset path, invoked
   * exclusively from the card's confirmation dialog. Never called by mount,
   * polling or quota refresh.
   */
  app.post("/api/codex/reset-credits/consume", async (req: any, reply: any) => {
    try {
      assertLocalCodexRequest(req);
      const service = deps.getService();
      if (!service) {
        reply.status(503);
        return { ok: false, success: false, error: "codex_request_failed" };
      }
      const raw = (req.body as any)?.creditId;
      // Absent = backend picks the oldest credit (CLI parity). Anything else
      // must be a bounded opaque id.
      const creditId = raw === undefined || raw === null || raw === "" ? undefined
        : typeof raw === "string" && raw.length > 0 && raw.length <= 256 ? raw
        : (() => { throw codexAdminError("codex_reset_invalid", 422); })();
      const result = await service.consumeResetCredit(creditId);
      return { ok: true, success: true, ...result };
    } catch (error: any) {
      return codexRouteError(error, reply, "reset-credits/consume", "codex_reset_failed");
    }
  });

  app.post("/api/codex/disconnect", async (req: any, reply: any) => {
    try {
      assertLocalCodexRequest(req);
      const service = deps.getService();
      if (!service) {
        reply.status(503);
        return { ok: false, success: false, error: "codex_request_failed" };
      }
      return await service.disconnect(); // {success:true}
    } catch (error: any) {
      return codexRouteError(error, reply, "disconnect", "codex_request_failed");
    }
  });
}
