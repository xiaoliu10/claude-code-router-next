import type { PluginContext } from "./core-types";
import { QoderAuthService } from "./auth-service";
import { QoderTransformer } from "./transformer";
import { createQoderManagedRuntime } from "./managed-runtime";
import { registerQoderAdminRoutes } from "./admin-routes";
import { protectQoderConfig } from "./protocol";
import { qoderLocales } from "./locales";

export const manifest = { name: "qoder", version: "0.1.0", coreApi: "1", description: "Qoder (qoder.com) subscription provider with PAT sign-in, model management and usage." };

export async function activate(ctx: PluginContext): Promise<void> {
  const service = new QoderAuthService({ host: ctx.host });
  class ActivatedQoderTransformer extends QoderTransformer {
    constructor() {
      // Terminal SSE quota/auth evidence reaches the service bookkeeping exactly
      // like HTTP-level failures, without flattening every failure to 502.
      super(service.engine, info => service.noteUpstreamError(info), () => service.noteUpstreamSuccess());
    }
  }
  ctx.registerTransformer(ActivatedQoderTransformer);
  ctx.registerManagedRuntime(createQoderManagedRuntime(service, ctx.host));
  ctx.registerAdminRoutes(app => registerQoderAdminRoutes(app, service));
  ctx.registerConfigProtector(protectQoderConfig);
  ctx.registerUiCard({ cardPath: "card.js" });
  ctx.registerLocales(qoderLocales);
  ctx.log.info("qoder plugin active");
}
export default { manifest, activate };
