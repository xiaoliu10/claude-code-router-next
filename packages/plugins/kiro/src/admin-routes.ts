import type { PluginContext } from "./core-types";
type AdminApp = Parameters<Parameters<PluginContext["registerAdminRoutes"]>[0]>[0];
import type { KiroAuthService } from "./auth-service";
import { kiroError, KIRO_ERROR_CODES } from "./protocol";

/** Socket identity wins over req.ip (which may honor X-Forwarded-For). */
export function assertLocalKiroRequest(req: any, app: Pick<AdminApp, "server">): void {
  const deny = () => { throw Object.assign(new Error("kiro_unauthorized"), { statusCode: 403 }); };
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

/** Local administration for one Kiro site and all of its account identities. */
export function registerKiroAdminRoutes(app: AdminApp, service: KiroAuthService): void {
  const routeBase = "/api/kiro";
  const bodyRecord = (body: unknown): Record<string, unknown> => body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const loginId = (b: Record<string, unknown>): string => { if (typeof b.loginId !== "string" || !b.loginId || b.loginId.length > 128) throw kiroError("kiro_login_invalid"); return b.loginId; };
  const account = (b: Record<string, unknown>): string | undefined => { if (b.account !== undefined && (typeof b.account !== "string" || !b.account || b.account.length > 2048)) throw kiroError("kiro_login_invalid"); return b.account as string | undefined; };
  const routes: Array<["GET" | "POST", string, (body: Record<string, unknown>) => Promise<unknown>]> = [
    ["GET", "status", () => service.getStatus()],
    ["POST", "login/start", b => service.startLogin(b as unknown as Parameters<KiroAuthService["startLogin"]>[0])],
    ["POST", "login/poll", b => { if (b.callbackUrl !== undefined && typeof b.callbackUrl !== "string") throw kiroError("kiro_callback_invalid"); return service.pollLogin(loginId(b), b.callbackUrl as string | undefined); }],
    ["POST", "login/complete", b => { if (typeof b.callbackUrl !== "string") throw kiroError("kiro_callback_invalid"); return service.completeLogin(loginId(b), b.callbackUrl); }],
    ["POST", "login/cancel", b => service.cancelLogin(loginId(b))],
    ["POST", "sync", b => service.syncModels(account(b))],
    ["POST", "usage", b => service.getUsage(account(b))],
    ["POST", "disconnect", b => service.disconnect(account(b))],
    ["POST", "models/visibility", b => { if (typeof b.model !== "string" || typeof b.hidden !== "boolean") throw kiroError("kiro_model_unknown"); return service.setModelHidden(b.model, b.hidden); }],
  ];
  const safe = new Set<string>(KIRO_ERROR_CODES);
  for (const [method, path, action] of routes) app.route({ method, url: `${routeBase}/${path}`, handler: async (req, reply) => {
    try { assertLocalKiroRequest(req, app); return await action(bodyRecord(req.body)); }
    catch (e: any) {
      const unauthorized = e?.message === "kiro_unauthorized" || e?.code === "kiro_unauthorized";
      const code = unauthorized ? "kiro_unauthorized" : safe.has(e?.code) ? e.code : "kiro_request_failed";
      const status = unauthorized ? 403 : Number.isInteger(e?.statusCode) && e.statusCode !== 401 && e.statusCode >= 400 && e.statusCode <= 599 ? e.statusCode : 500;
      reply.status(status); return { success: false, error: code };
    }
  } });
}
