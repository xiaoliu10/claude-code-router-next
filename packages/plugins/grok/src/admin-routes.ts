import type { FastifyInstance } from "fastify";
import type { GrokAuthService } from "./auth-service";

/** Socket identity wins over req.ip (which may honor X-Forwarded-For). */
export function assertLocalGrokRequest(req: any, app: Pick<FastifyInstance, "server">): void {
  const deny = () => { throw Object.assign(new Error("grok_unauthorized"), { statusCode: 403 }); };
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
export function registerGrokAdminRoutes(app: FastifyInstance, service: GrokAuthService): void {
  const id = (body: any) => {
    if (typeof body?.loginId !== "string" || !/^[a-f0-9]{32}$/.test(body.loginId)) throw Object.assign(new Error(), { code: "grok_login_unknown", statusCode: 422 });
    return body.loginId;
  };
  const routes: Array<["GET" | "POST", string, (body: any) => Promise<any>]> = [
    ["GET", "status", () => service.getStatus()],
    ["POST", "import", () => service.importCurrent()],
    ["POST", "login/start", () => service.startLogin()],
    ["POST", "login/poll", body => service.pollLogin(id(body))],
    ["POST", "login/cancel", body => service.cancelLogin(id(body))],
    ["POST", "sync", () => service.syncModels()],
    ["POST", "usage", () => service.getUsage()],
    ["POST", "models/visibility", body => {
      if (typeof body?.model !== "string" || typeof body.hidden !== "boolean") throw Object.assign(new Error(), { code: "grok_model_unknown", statusCode: 422 });
      return service.setModelHidden(body.model, body.hidden);
    }],
    ["POST", "disconnect", () => service.disconnect()],
  ];
  const safe = new Set(["grok_cli_missing", "grok_login_unknown", "grok_login_busy", "grok_login_failed", "grok_already_connected", "grok_identity_missing", "grok_not_connected", "grok_reauth_required", "grok_models_empty", "grok_model_unknown", "grok_provider_name_conflict", "grok_config_write_failed", "grok_persist_failed", "grok_credential_invalid", "grok_credential_unreadable", "grok_raw_config_required", "grok_proxy_invalid", "grok_upstream_error"]);
  for (const [method, path, action] of routes) app.route({ method, url: `/api/grok/${path}`, handler: async (req, reply) => {
    try { assertLocalGrokRequest(req, app); return await action(req.body); }
    catch (e: any) {
      const unauthorized = e?.statusCode === 403;
      const code = unauthorized ? "grok_unauthorized" : safe.has(e?.code) ? e.code : "grok_request_failed";
      const status = unauthorized ? 403 : Number.isInteger(e?.statusCode) && e.statusCode !== 401 && e.statusCode >= 400 && e.statusCode <= 599 ? e.statusCode : 500;
      reply.status(status); return { success: false, error: code };
    }
  } });
}
