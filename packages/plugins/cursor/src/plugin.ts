import type { PluginContext } from "./core-types";
import { CursorAuthService } from "./auth-service";
import { CursorTransformer } from "./transformer";
import { createCursorManagedRuntime, resolveCursorTransport } from "./managed-runtime";
import { registerCursorAdminRoutes } from "./admin-routes";
import { protectCursorConfig } from "./protocol";
import { configureCursorEngine } from "./vendor/engine.mjs";
import { cursorLocales } from "./locales";

export const manifest = { name: "cursor", version: "0.1.0", coreApi: "1", description: "Cursor (cursor.com) subscription provider: browser/CLI/API-key sign-in, agent-API data plane, model management and usage." };

/**
 * Activation wires the vendored engine's transport ONCE (process-wide, see
 * PATCHES.md §1): every engine request rides the host's subscription
 * dispatcher, and a proxy-configured host (SUBSCRIPTION_PROXY_URL) pins the
 * whole data plane — the engine's own region retry included — to HTTP/1.1,
 * because node:http2 cannot traverse the dispatcher. Without a proxy the
 * engine keeps upstream's HTTP/2-first behavior.
 */
export async function activate(ctx: PluginContext): Promise<void> {
  const transport = resolveCursorTransport(ctx.host);
  configureCursorEngine(transport);
  const service = new CursorAuthService({ host: ctx.host });
  const activatedTransformer = class ActivatedCursorTransformer extends CursorTransformer {
    static TransformerName: string = "cursor";
    name = "cursor";
    constructor() {
      super(undefined, info => service.noteUpstreamError(info), () => service.noteUpstreamSuccess());
    }
  };
  ctx.registerTransformer(activatedTransformer);
  ctx.registerManagedRuntime(createCursorManagedRuntime(service, ctx.host));
  ctx.registerAdminRoutes(app => registerCursorAdminRoutes(app, service));
  ctx.registerConfigProtector(protectCursorConfig);
  ctx.registerUiCard({ cardPath: "card.js" });
  ctx.registerLocales(cursorLocales);
  ctx.log.info("cursor plugin active");
}
export default { manifest, activate };
