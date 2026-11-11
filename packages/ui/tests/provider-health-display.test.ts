// Unit tests for the framework-free provider health display helpers used by
// the home page failure banner (last-failure timestamp). The banner exists so
// an operator can tell "broken right now" from "stale residue": during the
// 2026-11-02 codex outage the circuit text alone looked like a live fault all
// day, when the proxy had already healed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatFailureTime, isFailureStale } from "../src/utils/provider-health-display.ts";

const NOW = new Date("2026-11-02T12:00:00");

test("same-day failures render as HH:mm", () => {
  const ms = new Date("2026-11-02T10:50:26").getTime();
  assert.equal(formatFailureTime(ms, NOW), "10:50");
});

test("older failures render with the full date", () => {
  const ms = new Date("2026-10-31T09:07:28").getTime();
  assert.equal(formatFailureTime(ms, NOW), "2026-10-31 09:07");
});

test("midnight boundaries stay on the same-day side correctly", () => {
  assert.equal(formatFailureTime(new Date("2026-11-02T00:05:00").getTime(), NOW), "00:05");
  assert.equal(formatFailureTime(new Date("2026-11-01T23:59:00").getTime(), NOW), "2026-11-01 23:59");
});

test("non-finite and NaN input render as empty so callers can skip the line", () => {
  assert.equal(formatFailureTime(Number.NaN, NOW), "");
  assert.equal(formatFailureTime(Infinity, NOW), "");
  // Epoch 0's wall-clock rendering is timezone-dependent — assert the shape,
  // not the value (repo lesson from the v2.3.2415 workbuddy TZ incident).
  assert.match(formatFailureTime(0, NOW), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

test("timestamps are formatted in local time (deterministic pads)", () => {
  // Epoch 0 against a far-future "now" must render the full local date shape;
  // the timezone-dependent value itself is never asserted.
  const stamp = formatFailureTime(0, new Date("2026-06-01T00:00:00"));
  assert.match(stamp, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

// The stale-failure rule: circuit-breaker failure states are never cleared
// server-side, so a provider that recovered keeps its red failed badge and
// error banner forever unless the UI ages the failure out once a later
// success has been recorded on the same provider/model entry.
const FAIL = Date.parse("2026-11-02T10:00:00");
const SUCCESS_BEFORE = Date.parse("2026-11-02T09:00:00");
const SUCCESS_AFTER = Date.parse("2026-11-02T11:00:00");

test("failure newer than the last success is still live (badge shown)", () => {
  assert.equal(isFailureStale({ lastFailureTime: FAIL, lastSuccessTime: SUCCESS_BEFORE }), false);
});

test("success recorded after the failure makes it stale (badge hidden)", () => {
  assert.equal(isFailureStale({ lastFailureTime: FAIL, lastSuccessTime: SUCCESS_AFTER }), true);
});

test("success at exactly the failure time counts as recovered", () => {
  assert.equal(isFailureStale({ lastFailureTime: FAIL, lastSuccessTime: FAIL }), true);
});

test("old payloads without lastSuccessTime keep failures visible (legacy)", () => {
  assert.equal(isFailureStale({ lastFailureTime: FAIL }), false);
});

test("entries without lastFailureTime keep legacy open-badge behavior", () => {
  assert.equal(isFailureStale({ lastSuccessTime: SUCCESS_AFTER }), false);
  assert.equal(isFailureStale({}), false);
});
