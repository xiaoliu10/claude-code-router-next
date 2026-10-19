import { test } from "node:test";
import assert from "node:assert/strict";

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
    await client.getWorkBuddyStatus(); await client.importWorkBuddy("workbuddy-ai"); await client.syncWorkBuddyModels(); await client.disconnectWorkBuddy();
    assert.deepEqual(calls.map(call => call.url), ["/mock-api/workbuddy/status", "/mock-api/workbuddy/import", "/mock-api/workbuddy/sync", "/mock-api/workbuddy/disconnect"]);
    assert.equal(calls[0].options?.method, "GET");
    for (const call of calls.slice(1)) { assert.equal(call.options?.method, "POST"); }
    // Explicit site selector: the AI site must be importable even when both
    // desktop files exist, so the body carries the site — never an empty body.
    assert.deepEqual(JSON.parse(String(calls[1].options?.body)), { site: "workbuddy-ai" });
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

test("usage is a plain GET endpoint and safe failures stay allowlisted", async () => {
  const client = new ApiClient("/mock-api", "admin-mock");
  const original = globalThis.fetch;
  const calls: string[] = [];
  let httpStatus = 200;
  let payload: unknown = { usage: { plan: "Pro", used: 3, limit: 100, unit: "credits" } };
  globalThis.fetch = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(JSON.stringify(payload), { status: httpStatus });
  }) as typeof fetch;
  try {
    assert.deepEqual(await client.getWorkBuddyUsage(), { usage: { plan: "Pro", used: 3, limit: 100, unit: "credits" } });
    assert.deepEqual(calls, ["/mock-api/workbuddy/usage"]);
    httpStatus = 500;
    payload = { message: "private-quota-marker" };
    await assert.rejects(client.getWorkBuddyUsage(), error => {
      assert.equal((error as { reason: string }).reason, "request_failed");
      assert.doesNotMatch(String(error), /private-quota-marker/); return true;
    });
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
