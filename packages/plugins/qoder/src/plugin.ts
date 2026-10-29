import type { PluginContext } from "./core-types";
import { QoderAuthService } from "./auth-service";
import { QoderTransformer } from "./transformer";
import { createQoderManagedRuntime } from "./managed-runtime";
import { registerQoderAdminRoutes } from "./admin-routes";
import { QODER_SITES, protectQoderConfig, type QoderSiteId } from "./protocol";
import { qoderLocales } from "./locales";

export const manifest = { name: "qoder", version: "0.1.0", coreApi: "1", description: "Qoder (qoder.com / qoder.cn) subscription provider with PAT sign-in, model management and usage." };

/**
 * The transformer is site-independent (same request/response protocol); only
 * its NAME differs, because that is what the site's locked `transformer.use`
 * chain references. Terminal SSE quota/auth evidence reaches the site's
 * service bookkeeping exactly like HTTP-level failures, without flattening
 * every failure to 502.
 */
function activatedTransformer(site: QoderSiteId, service: QoderAuthService) {
  return class ActivatedQoderTransformer extends QoderTransformer {
    static TransformerName: string = site;
    name = site;
    constructor() {
      super(service.engine, info => service.noteUpstreamError(info), () => service.noteUpstreamSuccess());
    }
  };
}

/**
 * Activation wires BOTH sites: one service, transformer, managed runtime and
 * admin route set per site, ONE config protector covering both managed
 * providers, and one card carrying two independent sections.
 */
export async function activate(ctx: PluginContext): Promise<void> {
  const services = new Map(QODER_SITES.map(site => [site.id, new QoderAuthService({ host: ctx.host, site: site.id })] as const));
  for (const site of QODER_SITES) {
    const service = services.get(site.id)!;
    ctx.registerTransformer(activatedTransformer(site.id, service));
    ctx.registerManagedRuntime(createQoderManagedRuntime(service, ctx.host, site.id));
    ctx.registerAdminRoutes(app => registerQoderAdminRoutes(app, service, site.id));
  }
  ctx.registerConfigProtector(protectQoderConfig);
  ctx.registerUiCard({ cardPath: "card.js" });
  ctx.registerLocales(qoderLocales);
  ctx.log.info("qoder plugin active");
}
export default { manifest, activate };
