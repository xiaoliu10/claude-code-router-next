import { test } from "node:test";
import assert from "node:assert/strict";
import { reorderProvidersById, providerDragId } from "../src/components/provider-order.ts";

const full = () => [
  { name: "kimi", models: [] },
  { name: "codex", models: [] },
  { name: "gemini-oauth", models: [] },
  { name: "workbuddy", models: [] },
];
const ids = (list: any[]) => list.map((p, i) => providerDragId(p, i));

test("moves the dragged provider onto the target and preserves the rest", () => {
  const list = full();
  const next = reorderProvidersById(list, "workbuddy", "kimi");
  assert.deepEqual(next.map((p) => p.name), ["workbuddy", "kimi", "codex", "gemini-oauth"]);
});

test("moving down inserts at the target position", () => {
  const list = full();
  const next = reorderProvidersById(list, "kimi", "gemini-oauth");
  assert.deepEqual(next.map((p) => p.name), ["codex", "gemini-oauth", "kimi", "workbuddy"]);
});

test("a no-op (same id) returns the same array reference", () => {
  const list = full();
  assert.equal(reorderProvidersById(list, "kimi", "kimi"), list);
});

test("unknown ids return the same array reference", () => {
  const list = full();
  assert.equal(reorderProvidersById(list, "nope", "kimi"), list);
});

test("does not mutate the input array", () => {
  const list = full();
  const before = list.map((p) => p.name);
  reorderProvidersById(list, "kimi", "workbuddy");
  assert.deepEqual(list.map((p) => p.name), before);
});

test("works when reordering within a search-filtered subset against the full list", () => {
  // The UI renders a filtered subset but reorders the full array by id.
  const list = full();
  const filtered = list.filter((p) => /codex|workbuddy/.test(p.name!));
  const filteredIds = filtered.map((p) => providerDragId(p, list.indexOf(p)));
  const next = reorderProvidersById(list, filteredIds[1], filteredIds[0]); // workbuddy onto codex
  assert.deepEqual(next.map((p) => p.name), ["kimi", "workbuddy", "codex", "gemini-oauth"]);
});

test("providerDragId uses the name and falls back to the array index", () => {
  assert.equal(providerDragId({ name: "kimi" }, 0), "kimi");
  assert.equal(providerDragId({}, 2), "\u0000index:2");
  assert.equal(providerDragId({ name: "" }, 3), "\u0000index:3");
});

test("a provider with no name can still be dragged", () => {
  // Regression: the id used by the list and the id used by the reorder helper
  // were minted by two different counters, so unnamed rows silently never moved.
  const list: any[] = [{ name: "kimi" }, { name: undefined }, { name: "codex" }];
  const unnamed = providerDragId(list[1], 1);
  const next = reorderProvidersById(list, unnamed, "kimi");
  assert.notEqual(next, list, "dragging an unnamed provider must change the order");
  assert.equal(next[0].name, undefined);
  assert.equal(next[1].name, "kimi");
  assert.equal(next[2].name, "codex");
});

test("two unnamed providers are addressed by position, not by a shared token", () => {
  const list: any[] = [{ name: "a" }, {}, {}];
  const idsOf = ids(list);
  assert.equal(idsOf[1], "\u0000index:1");
  assert.equal(idsOf[2], "\u0000index:2");
  assert.notEqual(idsOf[1], idsOf[2], "unnamed rows must not collide");
  const next = reorderProvidersById(list, idsOf[2], idsOf[1]);
  assert.deepEqual(next.map((p) => p.name), ["a", undefined, undefined]);
  assert.equal(next[2], list[1], "the moved row is the original object");
});

test("an id minted against the full array resolves even for a filtered subset", () => {
  // The rendered list is a subset, but ids were minted against the full array.
  const list = full();
  const fullIds = ids(list);
  const filteredPositions = [1, 2]; // codex, gemini-oauth
  const filteredIds = filteredPositions.map((i) => fullIds[i]);
  const next = reorderProvidersById(list, filteredIds[0], filteredIds[1]);
  assert.deepEqual(next.map((p) => p.name), ["kimi", "gemini-oauth", "codex", "workbuddy"]);
});

test("a provider named like the unnamed prefix cannot steal an unnamed row's id", () => {
  // Regression: named ids used to be the raw name and unnamed ids "__index_<n>",
  // so a provider literally called "__index_1" collided with the unnamed row at
  // index 1 and a drag moved the wrong row. The namespace is now unspellable.
  const list: any[] = [{ name: "alpha" }, {}, { name: "__index_1" }];
  const idsOf = ids(list);
  assert.equal(new Set(idsOf).size, idsOf.length, "ids must be unique");
  const next = reorderProvidersById(list, idsOf[1], idsOf[0]);
  assert.deepEqual(next.map((p) => p.name ?? "<unnamed>"), ["<unnamed>", "alpha", "__index_1"]);
  // And dragging the look-alike row moves it, not the unnamed one.
  const next2 = reorderProvidersById(list, idsOf[2], idsOf[0]);
  assert.deepEqual(next2.map((p) => p.name ?? "<unnamed>"), ["__index_1", "alpha", "<unnamed>"]);
});

test("ids stay unique across named, empty-named and look-alike rows", () => {
  // Namespace prefixes that a user could plausibly type into a provider name
  // must never be produced for unnamed rows either.
  const list: any[] = [
    { name: "a" }, {}, { name: "" }, { name: "__index_2" }, { name: "__provider_1" },
  ];
  const idsOf = ids(list);
  assert.equal(new Set(idsOf).size, list.length, `collision in ${JSON.stringify(idsOf)}`);
});
