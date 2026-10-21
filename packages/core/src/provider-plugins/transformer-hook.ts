import { registerTransformerClass } from "../services/transformer";

/**
 * Bridge between plugin-contributed transformer classes and the live
 * TransformerService (set by server.ts). Kept in its own module so the plugin
 * registry can lazy-import it without a static cycle.
 */
export function registerTransformerFromPlugin(cls: new () => any): void {
  registerTransformerClass(cls);
}
