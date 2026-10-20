import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorkBuddyLogin, WORKBUDDY_POLL_TIMEOUT } from "../src/utils/workbuddy-login.ts";
import type { WorkBuddyLoginPollResponse, WorkBuddyLoginStartResponse } from "../src/types.ts";

const job = (): WorkBuddyLoginStartResponse => ({ ok: true, site: "workbuddy-ai", loginId: "mock-job", url: "https://example.invalid/official-login", expiresAt: Date.now() + 60_000 });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const connected: WorkBuddyLoginPollResponse = { status: "connected", success: true, models: ["model-a"] };

test("explicit login publishes HTTPS link, polls sequentially, and stops on connection", async () => {
  let calls = 0; let active = 0; let maximum = 0; let cancels = 0;
  const ready: WorkBuddyLoginStartResponse[] = [];
  const session = createWorkBuddyLogin({
    startWorkBuddyLogin: async () => job(),
    pollWorkBuddyLogin: async (site, id) => {
      assert.equal(site, "workbuddy-ai"); assert.equal(id, "mock-job");
      maximum = Math.max(maximum, ++active);
      await new Promise(resolve => setTimeout(resolve, 2)); active--;
      return ++calls === 3 ? connected : { status: "pending" };
    },
    cancelWorkBuddyLogin: async () => { cancels++; return { success: true }; },
  }, "workbuddy-ai", value => ready.push(value), { intervalMs: 1, deadlineMs: 1_000 });
  assert.deepEqual(await session.done, connected);
  assert.equal(calls, 3); assert.equal(maximum, 1); assert.equal(cancels, 0);
  assert.equal(ready[0].url, job().url);
});

test("cancel during start invalidates the late job without showing link or polling", async () => {
  const start = deferred<WorkBuddyLoginStartResponse>(); let polls = 0; const cancelled: string[] = [];
  const session = createWorkBuddyLogin({
    startWorkBuddyLogin: () => start.promise,
    pollWorkBuddyLogin: async () => { polls++; return connected; },
    cancelWorkBuddyLogin: async (site, id) => { cancelled.push(`${site}:${id}`); return { success: true }; },
  }, "workbuddy-ai", () => assert.fail("late link displayed"));
  await session.cancel(); start.resolve(job());
  assert.equal(await session.done, null); assert.equal(polls, 0);
  assert.deepEqual(cancelled, ["workbuddy-ai:mock-job"]);
});

test("cancel aborts in-flight poll, invalidates once, and ignores late connected reply", async () => {
  const poll = deferred<WorkBuddyLoginPollResponse>(); const started = deferred<AbortSignal>(); let cancels = 0;
  const session = createWorkBuddyLogin({
    startWorkBuddyLogin: async () => job(),
    pollWorkBuddyLogin: async (_site, _id, signal) => { started.resolve(signal); return poll.promise; },
    cancelWorkBuddyLogin: async () => { cancels++; return { success: true }; },
  }, "workbuddy-ai", () => {});
  const signal = await started.promise;
  await session.cancel(); assert.equal(signal.aborted, true);
  poll.resolve(connected);
  assert.equal(await session.done, null); assert.equal(cancels, 1);
});

test("deadline aborts polling, cancels backend job, and returns safe expiry reason", async () => {
  let cancels = 0;
  const session = createWorkBuddyLogin({
    startWorkBuddyLogin: async () => job(),
    pollWorkBuddyLogin: async () => ({ status: "pending" }),
    cancelWorkBuddyLogin: async () => { cancels++; return { success: true }; },
  }, "workbuddy-ai", () => {}, { intervalMs: 1_000, deadlineMs: 15 });
  await assert.rejects(session.done, { reason: "login_expired" }); assert.equal(cancels, 1);
});

test("server expiry, absent job, and failed jobs stop polling and invalidate", async () => {
  for (const status of ["none", "expired", "failed"] as const) {
    let calls = 0; let cancels = 0;
    const session = createWorkBuddyLogin({
      startWorkBuddyLogin: async () => job(),
      pollWorkBuddyLogin: async () => { calls++; return status === "failed" ? { status, reason: "login_state_rejected" } : { status }; },
      cancelWorkBuddyLogin: async () => { cancels++; return { success: true }; },
    }, "workbuddy-ai", () => {});
    await assert.rejects(session.done, { reason: status === "failed" ? "login_state_rejected" : "login_expired" });
    assert.equal(calls, 1); assert.equal(cancels, 1);
  }
});

test("unsafe login URL never reaches the UI and its job is invalidated", async () => {
  let cancels = 0;
  const session = createWorkBuddyLogin({
    startWorkBuddyLogin: async () => ({ ...job(), url: "javascript:alert(1)" }),
    pollWorkBuddyLogin: async () => assert.fail("unsafe job polled"),
    cancelWorkBuddyLogin: async () => { cancels++; return { success: true }; },
  }, "workbuddy-ai", () => assert.fail("unsafe link displayed"));
  await assert.rejects(session.done); assert.equal(cancels, 1);
});

test("P3 a timed-out poll retries within the deadline and still connects", async () => {
  let polls = 0;
  const session = createWorkBuddyLogin({
    startWorkBuddyLogin: async () => job(),
    pollWorkBuddyLogin: async () => {
      polls++;
      if (polls <= 2) throw Object.assign(new Error("WorkBuddy request failed"), { reason: WORKBUDDY_POLL_TIMEOUT });
      return connected;
    },
    cancelWorkBuddyLogin: async () => ({ success: true }),
  }, "workbuddy-ai", () => {}, { intervalMs: 1, deadlineMs: 1_000 });
  assert.deepEqual(await session.done, connected);
  assert.equal(polls, 3);
});

test("P3 persistent timeouts stay bounded by the server job expiry, never infinite", async () => {
  let polls = 0; let cancels = 0;
  const session = createWorkBuddyLogin({
    startWorkBuddyLogin: async () => ({ ...job(), expiresAt: Date.now() + 25 }),
    pollWorkBuddyLogin: async () => {
      polls++;
      throw Object.assign(new Error("WorkBuddy request failed"), { reason: WORKBUDDY_POLL_TIMEOUT });
    },
    cancelWorkBuddyLogin: async () => { cancels++; return { success: true }; },
  }, "workbuddy-ai", () => {}, { intervalMs: 1, deadlineMs: 30_000 });
  await assert.rejects(session.done, { reason: "login_expired" });
  assert.ok(polls > 0 && polls < 200, `polls bounded, got ${polls}`);
  assert.equal(cancels, 1);
});

test("P3 explicit server failure/security rejections are never retried as timeouts", async () => {
  let polls = 0;
  const session = createWorkBuddyLogin({
    startWorkBuddyLogin: async () => job(),
    pollWorkBuddyLogin: async () => {
      polls++;
      throw Object.assign(new Error("WorkBuddy request failed"), { reason: "login_state_rejected" });
    },
    cancelWorkBuddyLogin: async () => ({ success: true }),
  }, "workbuddy-ai", () => {}, { intervalMs: 1, deadlineMs: 1_000 });
  await assert.rejects(session.done, { reason: "login_state_rejected" });
  assert.equal(polls, 1);
});

test("P3 user cancellation during a timeout backoff still cancels cleanly", async () => {
  let polls = 0; let cancels = 0;
  const session = createWorkBuddyLogin({
    startWorkBuddyLogin: async () => job(),
    pollWorkBuddyLogin: async () => {
      polls++;
      throw Object.assign(new Error("WorkBuddy request failed"), { reason: WORKBUDDY_POLL_TIMEOUT });
    },
    cancelWorkBuddyLogin: async () => { cancels++; return { success: true }; },
  }, "workbuddy-ai", () => {}, { intervalMs: 30_000, deadlineMs: 30_000 });
  // Cancel while the helper is waiting out the post-timeout backoff interval.
  await new Promise(resolve => setTimeout(resolve, 5));
  await session.cancel();
  assert.equal(await session.done, null);
  assert.equal(polls, 1);
  assert.equal(cancels, 1);
});
