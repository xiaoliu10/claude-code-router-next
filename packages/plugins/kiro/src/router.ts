import { KIRO_PROVIDER } from "./protocol";

type RouterRecord = Record<string, unknown>;
const record = (value: unknown): value is RouterRecord =>
  !!value && typeof value === "object" && !Array.isArray(value);

/**
 * Drop Router references that point at just-hidden Kiro models. Adapted from
 * the Codex 1.0.9 helper (same semantics, local copy — cards never import
 * across plugin packages):
 *  - `default` moves to the first still-visible model, or becomes empty;
 *  - scenario slots holding exactly a hidden ref become empty; array slots
 *    lose the matching entries;
 *  - per-model alias entries and family defaults are cleared likewise.
 * Fallback stages and per-project routers are outside this operation's scope.
 * Shared by the host config draft and the persisted service configuration.
 */
export function clearKiroRouterRefs(router: unknown, hidden: ReadonlySet<string>, firstVisible: string | null): unknown {
  if (!record(router)) return router;
  const next = structuredClone(router);
  const hit = (value: unknown): boolean => {
    if (typeof value !== "string") return false;
    const parts = value.split(",").map(part => part.trim());
    return parts.length === 2 && parts[0] === KIRO_PROVIDER && hidden.has(parts[1]);
  };
  if (hit(next.default)) next.default = firstVisible ? `${KIRO_PROVIDER},${firstVisible}` : "";
  for (const [key, value] of Object.entries(next)) {
    if (["default", "models", "families", "fallback"].includes(key)) continue;
    if (hit(value)) next[key] = "";
    else if (Array.isArray(value) && value.every(item => typeof item === "string")) {
      next[key] = value.filter(item => !hit(item));
    }
  }
  if (record(next.models)) {
    for (const [key, value] of Object.entries(next.models)) if (hit(value)) delete next.models[key];
  }
  if (record(next.families)) {
    for (const family of Object.values(next.families)) {
      if (record(family) && hit(family.default)) family.default = "";
    }
  }
  return next;
}
