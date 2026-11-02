// Unit tests for the framework-free provider health display helpers used by
// the home page failure banner (last-failure timestamp). The banner exists so
// an operator can tell "broken right now" from "stale residue": during the
// 2026-11-02 codex outage the circuit text alone looked like a live fault all
// day, when the proxy had already healed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatFailureTime } from "../src/utils/provider-health-display.ts";

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
