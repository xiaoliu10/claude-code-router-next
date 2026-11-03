import type { PluginContext } from "./core-types";
import { GrokAuthService } from "./auth-service";
import { GrokTransformer } from "./transformer";
import { createGrokManagedRuntime } from "./managed-runtime";
import { registerGrokAdminRoutes } from "./admin-routes";
import { protectGrokConfig } from "./protocol";
import { grokLocales } from "./locales";
export const manifest = { name: "grok", version: "0.1.1", coreApi: "1", description: "Grok Build subscription provider with explicit CLI sign-in, model management and quota." };
export async function activate(ctx: PluginContext): Promise<void> {
  const service = new GrokAuthService({ host: ctx.host });
  class ActivatedGrokTransformer extends GrokTransformer {
    constructor() {
      // Terminal SSE quota/auth evidence reaches the service bookkeeping exactly
      // like HTTP-level failures, without flattening every failure to 502.
      super(service.engine, info => service.noteUpstreamError(info), () => service.noteUpstreamSuccess());
    }
  }
  ctx.registerTransformer(ActivatedGrokTransformer);
  ctx.registerManagedRuntime(createGrokManagedRuntime(service, ctx.host));
  ctx.registerAdminRoutes(app => registerGrokAdminRoutes(app, service));
  ctx.registerConfigProtector(protectGrokConfig);
  ctx.registerUiCard({ cardPath: "card.js" });
  ctx.registerLocales(grokLocales);
  ctx.log.info("grok plugin active");
}
export default { manifest, activate };
