import type { PluginContext } from "./core-types";
import { KiroAuthService } from "./auth-service";
import { registerKiroAdminRoutes } from "./admin-routes";
import { protectKiroConfig } from "./protocol";
import { kiroLocales } from "./locales";

export const manifest = { name: "kiro", version: "0.1.0", coreApi: "1", description: "Kiro subscription authentication and account management" };
/** Auth-only activation. The data plane and browser card are separate contributions. */
export async function activate(ctx: PluginContext): Promise<void> {
  const service = new KiroAuthService({ host: ctx.host });
  ctx.registerAdminRoutes(app => registerKiroAdminRoutes(app, service));
  ctx.registerConfigProtector(protectKiroConfig);
  ctx.registerLocales(kiroLocales);
  ctx.log.info("kiro authentication plugin active");
}
export default { manifest, activate };
