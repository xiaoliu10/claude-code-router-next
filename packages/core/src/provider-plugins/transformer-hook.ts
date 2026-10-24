import type { PluginContext } from "./types";

/** Explicit activation context; never a process-wide pointer to a live server. */
export function registerTransformerFromPlugin(context: PluginContext, cls: new () => any): void {
  context.registerTransformer(cls);
}
