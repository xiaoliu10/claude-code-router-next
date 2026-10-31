import { CODEX_PROVIDER_NAME } from "./card-types";

type RouterRecord = Record<string, unknown>;
const record = (value: unknown): value is RouterRecord =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Match WorkBuddy hide semantics, shared by the persisted config and UI draft.
 * Fallback stages and per-project routers are outside this operation's scope.
 */
export function clearCodexRouterRefs(router: unknown, hidden: ReadonlySet<string>, firstVisible: string | null): unknown {
  if (!record(router)) return router;
  const next = structuredClone(router);
  const hit = (value: unknown): boolean => {
    if (typeof value !== "string") return false;
    const parts = value.split(",").map((part) => part.trim());
    return parts.length === 2 && parts[0] === CODEX_PROVIDER_NAME && hidden.has(parts[1]);
  };
  if (hit(next.default)) next.default = firstVisible ? `${CODEX_PROVIDER_NAME},${firstVisible}` : "";
  for (const [key, value] of Object.entries(next)) {
    if (["default", "models", "families", "fallback"].includes(key)) continue;
    if (hit(value)) next[key] = "";
    else if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      next[key] = value.filter((item) => !hit(item));
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
