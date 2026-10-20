import { test } from "node:test";
import assert from "node:assert/strict";
import { WORKBUDDY_POLL_TIMEOUT } from "../src/utils/workbuddy-login.ts";

const storage = new Map<string, string>();
Object.assign(globalThis, { localStorage: { getItem: (key: string) => storage.get(key) || null, removeItem: (key: string) => storage.delete(key), setItem: (key: string, value: string) => storage.set(key, value) }, window: { location: { search: "" }, dispatchEvent: () => {} } });
const { default: ApiClient } = await import("../src/lib/api.ts");

test("exact endpoints, explicit import site body, management auth and safe failures (mock only)", async () => {
  const client = new ApiClient("/mock-api", "admin-mock");
  const calls: Array<{ url: string; options?: RequestInit }> = [];
  const original = globalThis.fetch;
  let response = { success: true };
  let httpStatus = 200;
  globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify(response), { status: httpStatus });
  }) as typeof fetch;
  try {
    await client.getWorkBuddyStatus(); await client.importWorkBuddy("workbuddy-ai"); await client.syncWorkBuddyModels("workbuddy"); await client.disconnectWorkBuddy("workbuddy-ai");
    assert.deepEqual(calls.map(call => call.url), ["/mock-api/workbuddy/status", "/mock-api/workbuddy/import", "/mock-api/workbuddy/sync", "/mock-api/workbuddy/disconnect"]);
    assert.equal(calls[0].options?.method, "GET");
    for (const call of calls.slice(1)) { assert.equal(call.options?.method, "POST"); }
    // Explicit site selector: the AI site must be importable even when both
    // desktop files exist, so the body carries the site — never an empty body.
    assert.deepEqual(JSON.parse(String(calls[1].options?.body)), { site: "workbuddy-ai" });
    // §16: sync/disconnect target exactly one site each.
    assert.deepEqual(JSON.parse(String(calls[2].options?.body)), { site: "workbuddy" });
    assert.deepEqual(JSON.parse(String(calls[3].options?.body)), { site: "workbuddy-ai" });
    assert.equal((calls[0].options?.headers as Record<string, string>)["X-API-Key"], "admin-mock");
    httpStatus = 422;
    response = { success: false, reason: "sealed", message: "private-auth-marker" } as typeof response;
    await assert.rejects(client.importWorkBuddy("workbuddy"), error => {
      assert.equal((error as { reason: string }).reason, "sealed"); assert.doesNotMatch(String(error), /private-auth-marker/); return true;
    });
    response = { error: "private-auth-marker", message: "private-auth-marker" } as unknown as typeof response;
    await assert.rejects(client.syncWorkBuddyModels(), error => { assert.equal((error as { reason: string }).reason, "request_failed"); return true; });
    globalThis.fetch = (async () => { throw new Error("private-auth-marker"); }) as typeof fetch;
    await assert.rejects(client.getWorkBuddyStatus(), error => { assert.doesNotMatch(String(error), /private-auth-marker/); return true; });
  } finally { globalThis.fetch = original; }
});

test("usage is an explicit per-site POST and safe failures stay allowlisted", async () => {
  const client = new ApiClient("/mock-api", "admin-mock");
  const original = globalThis.fetch;
  const calls: Array<{ url: string; options?: RequestInit }> = [];
  let httpStatus = 200;
  let payload: unknown = { usage: { plan: "Pro", used: 3, limit: 100, unit: "credits" } };
  globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify(payload), { status: httpStatus });
  }) as typeof fetch;
  try {
    assert.deepEqual(await client.getWorkBuddyUsage("workbuddy"), { usage: { plan: "Pro", used: 3, limit: 100, unit: "credits" } });
    // uid omitted = the site's active account server-side (§16).
    await client.getWorkBuddyUsage("workbuddy-ai", "uid-9");
    assert.deepEqual(calls.map(call => call.url), ["/mock-api/workbuddy/usage", "/mock-api/workbuddy/usage"]);
    assert.deepEqual(calls.map(call => JSON.parse(String(call.options?.body))), [{ site: "workbuddy" }, { site: "workbuddy-ai", uid: "uid-9" }]);
    httpStatus = 500;
    payload = { message: "private-quota-marker" };
    await assert.rejects(client.getWorkBuddyUsage("workbuddy"), error => {
      assert.equal((error as { reason: string }).reason, "request_failed");
      assert.doesNotMatch(String(error), /private-quota-marker/); return true;
    });
  } finally { globalThis.fetch = original; }
});

test("§16 per-site pool requests carry exact bodies; hide passes clearedRefs through", async () => {
  const client = new ApiClient("/mock-api", "mock-key");
  const original = globalThis.fetch;
  const calls: Array<{ url: string; options?: RequestInit }> = [];
  let payload: unknown = { success: true };
  let httpStatus = 200;
  globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify(payload), { status: httpStatus });
  }) as typeof fetch;
  try {
    // CN and AI requests are shaped identically but never leak into each other.
    await client.switchWorkBuddyAccount("workbuddy", "uid-cn-1");
    await client.removeWorkBuddyAccount("workbuddy-ai", "uid-ai-1");
    await client.hideWorkBuddyModel("workbuddy", "glm-4.6");
    await client.restoreWorkBuddyModel("workbuddy", "glm-4.6");
    await client.restoreWorkBuddyModel("workbuddy-ai");
    assert.deepEqual(calls.map(call => call.url), [
      "/mock-api/workbuddy/account/switch",
      "/mock-api/workbuddy/account/remove",
      "/mock-api/workbuddy/models/hide",
      "/mock-api/workbuddy/models/restore",
      "/mock-api/workbuddy/models/restore",
    ]);
    assert.ok(calls.every(call => call.options?.method === "POST"));
    assert.deepEqual(calls.map(call => JSON.parse(String(call.options?.body))), [
      { site: "workbuddy", uid: "uid-cn-1" },
      { site: "workbuddy-ai", uid: "uid-ai-1" },
      { site: "workbuddy", model: "glm-4.6" },
      { site: "workbuddy", model: "glm-4.6" },
      { site: "workbuddy-ai" },
    ]);
    payload = { ok: true, clearedRefs: ["workbuddy,glm-4.6", "scenarios.research"] };
    assert.deepEqual(await client.hideWorkBuddyModel("workbuddy", "glm-4.6"), { ok: true, clearedRefs: ["workbuddy,glm-4.6", "scenarios.research"] });
    // Failures keep the same sanitised allowlist as every other workbuddy route.
    httpStatus = 422;
    payload = { error: "raw upstream text", message: "raw upstream text" };
    await assert.rejects(client.removeWorkBuddyAccount("workbuddy", "uid"), error => {
      assert.equal((error as { reason: string }).reason, "request_failed");
      assert.doesNotMatch(String(error), /raw upstream text/); return true;
    });
    payload = { reason: "workbuddy_not_connected" };
    await assert.rejects(client.hideWorkBuddyModel("workbuddy-ai", "m"), { reason: "workbuddy_not_connected" });
  } finally { globalThis.fetch = original; }
});

test("full-config writes cannot overlap managed action and reconciliation", async () => {
  const client = new ApiClient("/mock-api"); const original = globalThis.fetch;
  let finish: ((value: Response) => void) | undefined;
  globalThis.fetch = (() => new Promise<Response>(resolve => { finish = resolve; })) as typeof fetch;
  try {
    const release = client.acquireWorkBuddyManagement(); assert.ok(release); assert.equal(client.acquireWorkBuddyManagement(), null);
    assert.deepEqual(await client.updateConfig({} as never), { success: false });
    release();
    const write = client.updateConfig({} as never);
    assert.equal(client.acquireWorkBuddyManagement(), null);
    finish!(new Response('{"success":true}')); await write;
    const next = client.acquireWorkBuddyManagement(); assert.ok(next); next();
  } finally { globalThis.fetch = original; }
});

test("browser login uses exact start/poll/cancel bodies and safe failure allowlist", async () => {
  const client = new ApiClient("/mock-api", "mock-key");
  const original = globalThis.fetch;
  const calls: Array<{ url: string; options?: RequestInit }> = [];
  let httpStatus = 200; let payload: unknown = { status: "pending" };
  globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify(payload), { status: httpStatus });
  }) as typeof fetch;
  try {
    await client.startWorkBuddyLogin("workbuddy-ai");
    const abort = new AbortController();
    await client.pollWorkBuddyLogin("workbuddy-ai", "mock-job", abort.signal);
    await client.cancelWorkBuddyLogin("workbuddy-ai", "mock-job");
    assert.deepEqual(calls.map(call => call.url), ["/mock-api/workbuddy/login/start", "/mock-api/workbuddy/login/poll", "/mock-api/workbuddy/login/cancel"]);
    assert.deepEqual(calls.map(call => JSON.parse(String(call.options?.body))), [{ site: "workbuddy-ai" }, { site: "workbuddy-ai", loginId: "mock-job" }, { site: "workbuddy-ai", loginId: "mock-job" }]);
    assert.ok(calls.every(call => call.options?.method === "POST"));
    httpStatus = 422;
    for (const reason of ["login_state_rejected", "login_account_failed", "login_persist_failed", "models_fetch_failed", "workbuddy_name_conflict", "workbuddy_site_conflict", "unsafe-raw-token"]) {
      payload = { reason, message: "private-marker" };
      await assert.rejects(client.pollWorkBuddyLogin("workbuddy-ai", "mock-job", abort.signal), error => {
        assert.equal((error as { reason: string }).reason, reason === "unsafe-raw-token" ? "request_failed" : reason);
        assert.doesNotMatch(String(error), /private-marker|unsafe-raw-token/); return true;
      });
    }
    httpStatus = 409; payload = { error: "workbuddy_site_conflict" };
    await assert.rejects(client.startWorkBuddyLogin("workbuddy"), { reason: "workbuddy_site_conflict" });
    httpStatus = 200;
    const pending = client.pollWorkBuddyLogin("workbuddy-ai", "mock-job", abort.signal);
    const signal = calls.at(-1)!.options!.signal!;
    abort.abort(); assert.equal(signal.aborted, true); await pending;
  } finally { globalThis.fetch = original; }
});

test("a local poll timeout is tagged for retry without leaking the raw error (P3)", async () => {
  const client = new ApiClient("/mock-api", "mock-key");
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new DOMException("The operation timed out. private-marker", "TimeoutError");
  }) as typeof fetch;
  try {
    await assert.rejects(client.pollWorkBuddyLogin("workbuddy", "mock-job", new AbortController().signal), error => {
      assert.equal((error as { reason: string }).reason, WORKBUDDY_POLL_TIMEOUT);
      // Sanitized boundary: the DOMException text never escapes apiFetch.
      assert.equal(String(error), "Error: WorkBuddy request failed");
      return true;
    });
  } finally { globalThis.fetch = original; }
});
