/**
 * Provider drag-and-drop reordering helpers.
 *
 * The UI may render a SEARCH-FILTERED subset of the full provider list. A drag
 * therefore identifies both endpoints by a stable row id rather than a filtered
 * index, and the resulting full list preserves the relative order of every
 * provider not involved in the move.
 *
 * The id for each row is derived ONCE per provider by the list component and
 * handed to both ends of the drag (see ProviderList). This module never invents
 * ids of its own: a counter here would drift from the component's counter and
 * silently make unnamed rows undroppable.
 */

export interface NamedProvider {
  name?: string;
}

/**
 * Prefix for the positional id of an unnamed provider. Named providers are
 * identified by their name verbatim, so the prefix must be a namespace a user
 * cannot collide with by naming a provider after it: a provider literally
 * called `__index_1` would otherwise share an id with the unnamed row at
 * index 1 and drags would move the wrong row. The NUL byte cannot appear in a
 * provider name.
 */
const UNNAMED_PREFIX = "\u0000index:";

/**
 * The row id the list uses for a provider. Named providers use their name;
 * unnamed ones use their position in the FULL config array, which is stable
 * across renders (the array only changes when the config does) and is the same
 * index space the reorder operates in.
 */
export function providerDragId(provider: NamedProvider | undefined, index: number): string {
  const name = provider?.name;
  return typeof name === "string" && name ? name : `${UNNAMED_PREFIX}${index}`;
}

/**
 * Move the row identified by `draggedId` to the position of `targetId` in
 * `full` (the unfiltered, config-backed array). Returns a new array; `full` is
 * not mutated. Identical/unknown ids return the same array reference so callers
 * can skip the save round-trip.
 *
 * `idFor` must be the same function the caller used to mint the ids, so both
 * ends of the drag resolve against the same index space.
 */
export function reorderProvidersById<T extends NamedProvider>(
  full: T[],
  draggedId: string,
  targetId: string,
  idFor: (provider: T, index: number) => string = providerDragId
): T[] {
  if (draggedId === targetId) return full;
  const from = full.findIndex((p, i) => idFor(p, i) === draggedId);
  const to = full.findIndex((p, i) => idFor(p, i) === targetId);
  if (from < 0 || to < 0) return full;
  const next = full.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}
