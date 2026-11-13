import type { PluginContext } from "./core-types";
import { KiroAuthService } from "./auth-service";
import { registerKiroAdminRoutes } from "./admin-routes";
import { protectKiroConfig } from "./protocol";
import { kiroLocales } from "./locales";
import { KiroTransformer } from "./transformer";
import { createKiroManagedRuntime } from "./managed-runtime";

export const manifest = {
  name: "kiro",
  version: "0.1.2",
  coreApi: "1",
  description:
    "Kiro subscription provider (AWS Builder ID, IAM Identity Center and the Kiro portal): sign-in, model management, usage and chat.",
};

/**
 * One activation owns one auth service: the admin routes, the data plane and
 * the managed runtime must share the same account state, or a sign-in made in
 * the card would not reach the chat path.
 */
export async function activate(ctx: PluginContext): Promise<void> {
  const service = new KiroAuthService({ host: ctx.host });
  ctx.registerTransformer(
    class ActivatedKiroTransformer extends KiroTransformer {
      constructor() {
        super(service);
      }
    }
  );
  ctx.registerManagedRuntime(createKiroManagedRuntime(service, ctx.host));
  ctx.registerAdminRoutes((app) => registerKiroAdminRoutes(app, service));
  ctx.registerConfigProtector(protectKiroConfig);
  ctx.registerLocales(kiroLocales);
  ctx.registerUiCard({ cardPath: "card.js" });
  ctx.log.info("kiro plugin active");
}

export default { manifest, activate };
