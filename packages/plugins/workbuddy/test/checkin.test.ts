import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { checkinOf } from "../src/checkin";
import { WorkBuddyAuthService } from "../src/auth-service";
import { registerWorkBuddyAdminRoutes } from "../src/admin-routes";
import { WorkBuddyCredentialStore, type WorkBuddyCredential } from "../src/protocol";

const credential: WorkBuddyCredential = {
  version: 1, kind: "workbuddy", uid: "active", displayName: "A", source: "desktop",
  accessToken: "secret-token", domain: "", enterpriseId: "", expiresAt: 0, importedAt: "",
};
const env = (data: unknown, code = 0, status = 200) => new Response(JSON.stringify({ code, data, msg: "secret-token" }), { status });
const active = () => env({ active: true });
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const run = (responses: Array<Response | Error>, waits = [0, 0]) => {
  const fetch = vi.fn(async () => { const next = responses.shift(); if (next instanceof Error) throw next; if (!next) throw new Error("unexpected request"); return next; });
  return { fetch, result: checkinOf(credential, fetch, "dispatcher", { waits }) };
};

it("claims credits and streak via authenticated identity billing requests", async () => {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => fetch.mock.calls.length === 1 ? active() : env({ credit: 12, streak_days: 3, message: "secret-token" }));
  expect(await checkinOf(credential, fetch, "subscription", { waits: [0, 0] })).toEqual({ outcome: "claimed", credit: 12, streak: 3 });
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    "https://copilot.tencent.com/v2/billing/meter/checkin-activity-status",
    "https://copilot.tencent.com/v2/billing/meter/daily-checkin",
  ]);
  for (const [, init] of fetch.mock.calls) {
    expect(init).toMatchObject({ method: "POST", body: "{}", redirect: "error", dispatcher: "subscription" });
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer secret-token");
    expect(headers.get("accept-encoding")).toBe("identity");
    expect(headers.get("x-user-id")).toBe("active");
  }
});
it("done uses today_credit and never posts a claim", async () => {
  const h = run([env({ active: true, today_checked_in: true, today_credit: "8", daily_credit: 99 })]);
  expect(await h.result).toEqual({ outcome: "done", credit: 8 }); expect(h.fetch).toHaveBeenCalledTimes(1);
});
it("inactive status never posts a claim", async () => {
  const h = run([env({ active: false })]); expect(await h.result).toEqual({ outcome: "inactive" }); expect(h.fetch).toHaveBeenCalledTimes(1);
});
it.each([[1001, "done"], [1002, "ineligible"], [1003, "inactive"]] as const)("classifies code %s in status and claim replies", async (code, outcome) => {
  expect(await run([env(null, code)]).result).toEqual({ outcome });
  expect(await run([active(), env(null, code)]).result).toEqual({ outcome });
});
it.each([true, false])("401 probes a summary (at status: %s) and detects official-app eligibility", async atStatus => {
  const h = run([...(atStatus ? [] : [active()]), env(null, 0, 401), env({ Packages: [] })]);
  expect(await h.result).toMatchObject({ outcome: "ineligible" });
  expect(h.fetch.mock.calls.at(-1)?.[0]).toBe("https://copilot.tencent.com/billing/meter/get-user-resource-summary");
});
it.each([500, 200])("retries transient claim twice and gives up (HTTP %s)", async status => {
  const h = run([active(), ...Array.from({ length: 3 }, () => env(null, status === 200 ? 10000 : 0, status))]);
  const result = await h.result;
  expect(result.outcome).toBe("failed"); expect(h.fetch).toHaveBeenCalledTimes(4);
  expect(JSON.stringify(result)).not.toContain("secret-token");
});
it("recovers from a transient failure", async () => {
  const h = run([active(), env(null, 10000), env({ credit: 5 })]);
  expect(await h.result).toEqual({ outcome: "claimed", credit: 5 });
});
it("answered errors including unreadable bodies return failed, never raw text", async () => {
  for (const response of [env(null, 1234), new Response("secret-token"), new Response("secret-token", { status: 403 })]) {
    const result = await run([active(), response]).result;
    expect(result.outcome).toBe("failed"); expect(JSON.stringify(result)).not.toContain("secret-token");
  }
  const broken = new Response(new ReadableStream({ start(controller) { controller.error(new Error("secret-token")); } }));
  expect((await run([broken]).result).outcome).toBe("failed");
});
it("a refused or offline summary after a 401 is an answered failure", async () => {
  for (const probe of [env(null, 0, 401), new Error("secret-token")]) {
    expect((await run([active(), env(null, 0, 401), probe]).result).outcome).toBe("failed");
  }
});
it.each([true, false])("throws only when primary request receives no response (status: %s)", async atStatus => {
  await expect(run([...(atStatus ? [] : [active()]), new Error("secret-token")]).result).rejects.toThrow("received no response");
  await expect(run([new Error("secret-token")]).result).rejects.not.toThrow("secret-token");
});

async function harness(subscription?: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "wb-checkin-")); dirs.push(dir);
  const store = new WorkBuddyCredentialStore(join(dir, "credentials.json"));
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => fetch.mock.calls.length % 2 ? active() : env({ credit: 2 }));
  const direct = vi.fn(() => "direct");
  const service = new WorkBuddyAuthService({ store, fetch, host: {
    readRawConfig: async () => ({}), writeConfig: async () => {}, reloadRuntime: () => {},
    getDirectDispatcher: direct, getSubscriptionDispatcher: () => subscription,
  } });
  return { service, store, fetch, direct };
}
it("signed out returns failed without network access", async () => {
  const h = await harness(); expect(await h.service.checkin()).toEqual({ uid: null, outcome: "failed", message: "Not signed in" }); expect(h.fetch).not.toHaveBeenCalled();
});
it.each([undefined, "subscription"])("uses the active CN account even when cooling, dispatcher %s", async dispatcher => {
  const h = await harness(dispatcher);
  await h.store.upsertAccount({ ...credential, uid: "backup", accessToken: "backup-token" });
  await h.store.upsertAccount(credential);
  await h.store.setActiveUid("workbuddy", "active");
  await h.store.setAccountCooldown("workbuddy", "active", { scope: "account", code: 14018, until: Date.now() + 60_000 });
  expect((await h.service.checkin({ waits: [0, 0] })).outcome).toBe("claimed");
  for (const [, init] of h.fetch.mock.calls) {
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret-token");
    expect(init).toMatchObject({ dispatcher: dispatcher ?? "direct" });
  }
});
it("AI-only accounts do not receive CN requests", async () => {
  const h = await harness(); await h.store.upsertAccount({ ...credential, kind: "workbuddy-ai", domain: "" });
  expect((await h.service.checkin()).outcome).toBe("failed"); expect(h.fetch).not.toHaveBeenCalled();
});
it("route exposes outcomes, enforces local guard and rejects account/site overrides", async () => {
  const h = await harness(); const app = Fastify({ logger: false });
  registerWorkBuddyAdminRoutes(app, { getService: () => h.service });
  try {
    const request = (payload = {}, remoteAddress = "127.0.0.1") => app.inject({ method: "POST", url: "/api/workbuddy/checkin", headers: { host: "localhost:3456" }, payload, remoteAddress });
    expect((await request()).json()).toEqual({ uid: null, outcome: "failed", message: "Not signed in" });
    await h.store.upsertAccount(credential);
    expect((await request()).json()).toEqual({ uid: "active", outcome: "claimed", credit: 2 });
    expect((await request({}, "203.0.113.1")).statusCode).toBe(403);
    expect((await request({ uid: "backup" })).statusCode).toBe(422);
    expect((await request({ site: "workbuddy-ai" })).statusCode).toBe(422);
    h.fetch.mockRejectedValueOnce(new Error("secret-token"));
    const offline = await request(); expect(offline.statusCode).toBe(500); expect(offline.body).not.toContain("secret-token");
  } finally { await app.close(); }
});

// Regression coverage for the independent check-in review.
it("MAJOR-2: HTTP401/code10000 probes eligibility instead of retrying claim", async () => {
  const h = run([active(), env(null, 10000, 401), env({ Packages: [] })]);
  expect((await h.result).outcome).toBe("ineligible");
  expect(h.fetch.mock.calls.map(call => call[0])).toEqual([
    "https://copilot.tencent.com/v2/billing/meter/checkin-activity-status",
    "https://copilot.tencent.com/v2/billing/meter/daily-checkin",
    "https://copilot.tencent.com/billing/meter/get-user-resource-summary",
  ]);
});
it.each([null, [], { toString: null }].map(value => [value]))("MINOR-1: malformed code %j is an answered failure", async code => {
  const response = new Response(JSON.stringify({ code, data: { active: true } }));
  expect(await run([response]).result).toMatchObject({ outcome: "failed" });
});
it.each(["credit", "streak_days", "today_credit"])("MINOR-1: malformed optional %s is ignored", async field => {
  const bad = { toString: null };
  const replies = field === "today_credit"
    ? [env({ active: true, today_checked_in: true, today_credit: bad })]
    : [active(), env({ [field]: bad })];
  expect(await run(replies).result).toEqual({ outcome: field === "today_credit" ? "done" : "claimed" });
});
it("MAJOR-1: endpoint returns actual snapshot UID B and rejects stale A without network", async () => {
  const h = await harness(); const app = Fastify({ logger: false });
  registerWorkBuddyAdminRoutes(app, { getService: () => h.service });
  const request = (payload = {}) => app.inject({ method: "POST", url: "/api/workbuddy/checkin", headers: { host: "localhost:3456" }, payload });
  try {
    await h.store.upsertAccount({ ...credential, uid: "A" });
    await h.store.upsertAccount({ ...credential, uid: "B" });
    await h.store.setActiveUid("workbuddy", "B");
    expect((await request()).json()).toMatchObject({ uid: "B", outcome: "claimed" });
    h.fetch.mockClear();
    const conflict = await request({ expectedActiveUid: "A" });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: "workbuddy_active_account_changed" });
    expect(h.fetch).not.toHaveBeenCalled();
    expect((await request({ expectedActiveUid: "B" })).json()).toMatchObject({ uid: "B", outcome: "claimed" });
  } finally { await app.close(); }
});
it("keeps snapshot UID and headers when active account changes during the operation", async () => {
  const h = await harness();
  await h.store.upsertAccount({ ...credential, uid: "A" });
  await h.store.upsertAccount({ ...credential, uid: "B" });
  await h.store.setActiveUid("workbuddy", "A");
  let release!: (response: Response) => void;
  let started!: () => void;
  const pending = new Promise<void>(resolve => { started = resolve; });
  h.fetch.mockImplementationOnce(async () => { started(); return new Promise<Response>(resolve => { release = resolve; }); });
  const result = h.service.checkin({ expectedActiveUid: "A", waits: [0, 0] });
  await pending;
  await h.store.setActiveUid("workbuddy", "B");
  release(active());
  expect(await result).toMatchObject({ uid: "A", outcome: "claimed" });
  for (const [, init] of h.fetch.mock.calls) expect(new Headers(init?.headers).get("x-user-id")).toBe("A");
});
it.each([[1001, "done"], [1002, "ineligible"], [1003, "inactive"]] as const)("HTTP401/code%s preserves explicit business outcome", async (code, outcome) => {
  const h = run([active(), env(null, code, 401)]);
  expect(await h.result).toEqual({ outcome });
  expect(h.fetch).toHaveBeenCalledTimes(2);
});
it.each([42, false, {}, []].map(value => [value]))("rejects invalid expectedActiveUid %j before accessing upstream", async expectedActiveUid => {
  const h = await harness(); const app = Fastify({ logger: false });
  registerWorkBuddyAdminRoutes(app, { getService: () => h.service });
  try {
    await h.store.upsertAccount(credential);
    const response = await app.inject({ method: "POST", url: "/api/workbuddy/checkin", headers: { host: "localhost:3456" }, payload: { expectedActiveUid } });
    expect(response.statusCode).toBe(422);
    expect(h.fetch).not.toHaveBeenCalled();
  } finally { await app.close(); }
});
