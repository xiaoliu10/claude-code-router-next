import type { FastifyInstance } from "fastify";
import type { QoderAuthService } from "./auth-service";
import { validPAT } from "./protocol";

/** Socket identity wins over req.ip (which may honor X-Forwarded-For). */
export function assertLocalQoderRequest(req: any, app: Pick<FastifyInstance, "server">): void {
  const deny = () => { throw Object.assign(new Error("qoder_unauthorized"), { statusCode: 403 }); };
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

export function registerQoderAdminRoutes(app: FastifyInstance, service: QoderAuthService): void {
  const routes: Array<["GET" | "POST", string, (body: any) => Promise<any>]> = [
    ["GET", "status", () => service.getStatus()],
    ["POST", "connect", body => {
      // Format gate here too: the service enforces it, the route owns the 422.
      if (!validPAT(body?.pat)) throw Object.assign(new Error(), { code: "qoder_pat_invalid", statusCode: 422 });
      return service.connectPAT(body.pat);
    }],
    ["POST", "sync", () => service.syncModels()],
    ["POST", "usage", () => service.getUsage()],
    ["POST", "models/visibility", body => {
      if (typeof body?.model !== "string" || typeof body.hidden !== "boolean") throw Object.assign(new Error(), { code: "qoder_model_unknown", statusCode: 422 });
      return service.setModelHidden(body.model, body.hidden);
    }],
    ["POST", "disconnect", () => service.disconnect()],
  ];
  const safe = new Set(["qoder_unauthorized", "qoder_pat_invalid", "qoder_already_connected", "qoder_not_connected", "qoder_reauth_required", "qoder_persist_failed", "qoder_config_write_failed", "qoder_provider_name_conflict", "qoder_credential_invalid", "qoder_credential_unreadable", "qoder_raw_config_required", "qoder_proxy_invalid", "qoder_upstream_error", "qoder_rate_limited", "qoder_request_failed", "qoder_model_unknown"]);
  for (const [method, path, action] of routes) app.route({ method, url: `/api/qoder/${path}`, handler: async (req, reply) => {
    try { assertLocalQoderRequest(req, app); return await action(req.body); }
    catch (e: any) {
      const unauthorized = e?.statusCode === 403;
      const code = unauthorized ? "qoder_unauthorized" : safe.has(e?.code) ? e.code : "qoder_request_failed";
      const status = unauthorized ? 403 : Number.isInteger(e?.statusCode) && e.statusCode !== 401 && e.statusCode >= 400 && e.statusCode <= 599 ? e.statusCode : 500;
      reply.status(status); return { success: false, error: code };
    }
  } });
}
