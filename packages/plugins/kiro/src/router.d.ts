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
export declare function clearKiroRouterRefs(router: unknown, hidden: ReadonlySet<string>, firstVisible: string | null): unknown;
