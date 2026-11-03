import type { FastifyInstance } from "fastify";
import type { CursorAuthService } from "./auth-service";
import { CURSOR_ROUTE_BASE, CURSOR_SAFE_CODES } from "./protocol";

/** Socket identity wins over req.ip (which may honor X-Forwarded-For). */
export function assertLocalCursorRequest(req: any, app: Pick<FastifyInstance, "server">): void {
  const deny = () => { throw Object.assign(new Error("cursor_unauthorized"), { statusCode: 403 }); };
  const remote = req.raw?.socket?.remoteAddress ?? req.socket?.remoteAddress ?? req.connection?.remoteAddress ?? req.ip;
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote)) deny();
  const address = app.server.address();
  const port = address && typeof address === "object" ? address.port : 3456;
  const allowed = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
  if (typeof req.headers?.host !== "string" || !allowed.has(req.headers.host)) deny();
  if (req.headers.origin !== undefined) {
    try {
      const origin = new URL(req.headers.origin);
      if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password || !allowed.has(origin.host)) deny();
    } catch { deny(); }
  }
}

/**
 * Admin surface: loopback-only routes under /api/cursor. Login comes in the
 * three shapes Cursor accounts have — browser PKCE (start / poll / cancel),
 * the cursor-agent CLI import, and the API-key exchange. Codes are the shared
 * taxonomy: an upstream 401 reaches the card as cursor_reauth_required
 * (account kept — sign in again), NEVER as a "login invalid" verdict.
 */
export function registerCursorAdminRoutes(app: FastifyInstance, service: CursorAuthService): void {
  const routes: Array<["GET" | "POST", string, (body: any) => Promise<any>]> = [
    ["GET", "status", async () => service.getStatus()],
    ["POST", "login/browser", async () => service.startBrowserLogin()],
    ["GET", "login/state", async () => service.loginState()],
    ["POST", "login/cancel", async () => service.cancelLogin()],
    ["POST", "login/cli", async () => service.connectCli()],
    ["POST", "connect", body => {
      // Format gate here too: the service enforces it, the route owns the 422.
      if (typeof body?.apiKey !== "string" || !body.apiKey) throw Object.assign(new Error(), { code: "cursor_credential_invalid", statusCode: 422 });
      return service.connectApiKey(body.apiKey);
    }],
    ["POST", "sync", () => service.syncModels()],
    ["POST", "usage", () => service.getUsage()],
    ["POST", "disconnect", () => service.disconnect()],
  ];
  for (const [method, path, action] of routes) app.route({ method, url: `${CURSOR_ROUTE_BASE}/${path}`, handler: async (req, reply) => {
    try { assertLocalCursorRequest(req, app); return await action(req.body); }
    catch (e: any) {
      const unauthorized = e?.statusCode === 403;
      const code = unauthorized ? "cursor_unauthorized" : CURSOR_SAFE_CODES.has(e?.code) ? e.code : "cursor_request_failed";
      const status = unauthorized ? 403 : Number.isInteger(e?.statusCode) && e.statusCode !== 401 && e.statusCode >= 400 && e.statusCode <= 599 ? e.statusCode : 500;
      reply.status(status);
      return { success: false, error: code };
    }
  } });
}
