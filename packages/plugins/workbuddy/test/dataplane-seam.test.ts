import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
/**
 * WorkBuddy §16 request account rotation — MOVED + ADAPTED from the former
 * core test `workbuddy-failover.test.ts`: the pool orchestration lives in the
 * plugin's managed runtime and is dispatched through the core's GENERIC
 * `dispatchRequest` seam (real registry, real core Server, FULL plugin
 * activation — runtime + transformer + admin routes; upstream always a stub).
 * Equivalence contract pinned here (migration contract §1 items 1–5):
 * rotation bound, cooldown booking order, per-site isolation, terminal
 * classes (10085/reauth/model-hidden), transient semantics, SSE envelope
 * inspection, edge-reset probe, ordinary-provider immunity.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import Server from "../../../core/src/server";
import { getHealthStore } from "../../../core/src/services/provider-health";
import { reloadProviderRuntime } from "../../../core/src/provider-plugins/host";
import { WorkBuddyTransformer } from "../src/transformer";
import {
  WorkBuddyCredentialStore, classifyWorkBuddyError,
  workBuddyFailoverCooldown, nextWorkBuddyQuotaReset, type WorkBuddyCredential,
} from "../src/protocol";
import { WORKBUDDY_TERMINAL_CODES, workBuddyFailoverCooldownFromInfo } from "../src/managed-runtime";
import { activate, getActivatedWorkBuddyService, manifest } from "../src/plugin";
import { clearPluginRegistry } from "../../../core/src/provider-plugins/registry";

const CN = "https://copilot.tencent.com/v2/chat/completions";
const AI = "https://www.workbuddy.ai/v2/chat/completions";
const cleanups: Array<() => Promise<void>> = [];
const noopLog = { info: () => {}, warn: () => {}, error: () => {} };
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  clearPluginRegistry();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
const credential = (uid: string, kind: "workbuddy" | "workbuddy-ai" = "workbuddy"): WorkBuddyCredential => ({
  version: 1, kind, uid, displayName: "Fixture", enterpriseId: "", domain: "",
  accessToken: `secret-${uid}`, source: "desktop", expiresAt: 0,
  importedAt: uid === "a" ? "2026-10-18T00:00:00.000Z" : "2026-10-19T00:00:00.000Z",
});
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}
const success = () => json({ choices: [{ message: { role: "assistant", content: "healthy" } }] });
function sse(chunks: string[]) {
  return new Response(new ReadableStream({
    start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); },
  }), { headers: { "content-type": "text/event-stream" } });
}
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
async function harness(hiddenModels: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "wb-failover-"));
  // Same path the plugin activation chose (ctx.host.configDir): the harness
  // seeds the pool through its own store handle; the service reads from disk.
  const store = new WorkBuddyCredentialStore(join(dir, "workbuddy-credentials.json"));
  await store.saveData({ version: 2, sites: {
    workbuddy: { activeUid: "b", hiddenModels, discoveredModels: ["m", "hidden"], accounts: [credential("a"), credential("b")] },
    "workbuddy-ai": { activeUid: "ai", hiddenModels: [], accounts: [credential("ai", "workbuddy-ai")] },
  } });
  const providers = [
    { name: "workbuddy", api_base_url: CN, api_key: "ccr-managed-workbuddy", models: ["m", "hidden"], ccr_managed: true, transformer: { use: ["workbuddy"] } },
    { name: "workbuddy-ai", api_base_url: AI, api_key: "ccr-managed-workbuddy-ai", models: ["m"], ccr_managed: true, transformer: { use: ["workbuddy"] } },
    { name: "ordinary", api_base_url: "https://ordinary.invalid/v1/chat/completions", api_key: "fixture", models: ["m"] },
  ];
  const server = new Server({ logger: false, useJsonFile: false, initialConfig: { providers, HOST: "127.0.0.1", PORT: 0 } });
  await server.ready();
  // FULL plugin activation through the core's REAL registry: the managed
  // runtime (dispatch wrapper: account pool + SSE inspection + edge guard),
  // the plugin transformer and the admin routes all come from the plugin.
  const tx = server.pluginRegistry.beginActivation(manifest, noopLog, {
    configDir: dir,
    readConfig: async () => { throw new Error("unused by the data plane"); },
    writeConfig: async () => { throw new Error("unused by the data plane"); },
    reloadRuntime: async (cfg?: any) => reloadProviderRuntime(server, cfg ?? { Providers: providers }, noopLog),
    getDirectDispatcher: () => undefined,
  } as any);
  await activate(tx.context);
  await tx.commit(undefined, server.app);
  const service = getActivatedWorkBuddyService()!;
  const runtime = server.pluginRegistry.getManagedRuntimeFor({ name: "workbuddy", apiKey: "ccr-managed-workbuddy" } as any)!;
  // Re-resolve provider transformer instances after plugin registration.
  await reloadProviderRuntime(server, { Providers: providers }, noopLog);
  await server.registerNamespace("/"); await server.app.ready();
  cleanups.push(async () => { await server.app.close(); rmSync(dir, { recursive: true, force: true }); });
  const send = (provider = "workbuddy", model = "m", stream = false, content = "hi") => server.app.inject({
    method: "POST", url: "/v1/chat/completions",
    payload: { model: `${provider},${model}`, messages: [{ role: "user", content }], stream },
  });
  return { store, dir, service, server, runtime, send };
}
function stubSequence(first: () => Response, second: () => Response = success) {
  const headers: Headers[] = [], urls: string[] = [];
  const fetch = vi.fn(async (url: any, init: any) => {
    urls.push(String(url)); headers.push(new Headers(init.headers));
    return headers.length === 1 ? first() : second();
  });
  vi.stubGlobal("fetch", fetch);
  return { fetch, headers, urls };
}

describe("WorkBuddy §16 request account rotation (temp store, stub fetch)", () => {
  it("active-sticky b receives 6004; a succeeds with fresh auth; model cooldown persisted", async () => {
    const h = await harness();
    // The per-attempt credential reaches the final header injection through
    // the runtime's signRequest — the generic seam's channel of record (the
    // former inline branch used the transformer auth() hook). The uid is
    // captured at call time: the wrapper reuses one shared config object, so
    // inspecting recorded args after the fact would only see the last value.
    const seenUids: (string | undefined)[] = [];
    const originalSign = h.runtime.signRequest.bind(h.runtime);
    (h.runtime as any).signRequest = async (input: any) => {
      seenUids.push(input.config?.workbuddyCredential?.uid);
      return originalSign(input);
    };
    const f = stubSequence(() => json({ code: 6004, msg: "private-upstream-body" }, 429));
    const before = Date.now();
    const recordCooldown = vi.spyOn(h.service, "markAccountCooldown");
    const response = await h.send();
    expect(response.statusCode).toBe(200); expect(response.body).toContain("healthy");
    expect(recordCooldown.mock.invocationCallOrder[0]).toBeLessThan(f.fetch.mock.invocationCallOrder[1]);
    expect(f.headers.map(headers => headers.get("x-user-id"))).toEqual(["b", "a"]);
    expect(f.headers.map(headers => headers.get("authorization"))).toEqual(["Bearer secret-b", "Bearer secret-a"]);
    expect(seenUids).toEqual(["b", "a"]);
    const state = (await h.store.loadData())!.sites.workbuddy!;
    expect(state.activeUid).toBe("b");
    expect(state.accounts.find(a => a.uid === "b")!.modelCooldowns!.m.until).toBeGreaterThanOrEqual(before + 900_000);
    expect(state.accounts.find(a => a.uid === "b")!.cooldown).toBeUndefined();
    expect(await h.service.poolCooldownRemainingMs("workbuddy", "m")).toBe(0);
    expect((await h.store.loadData())!.sites["workbuddy-ai"]!.accounts[0].cooldown).toBeUndefined();
  });
  it.each([14018, 11140])("%s cools the account before switching", async (code) => {
    const h = await harness();
    stubSequence(() => json({ code, accessToken: "private-upstream-body" }, 403));
    const before = Date.now();
    const response = await h.send(); expect(response.statusCode).toBe(200);
    const cooldown = (await h.store.loadData())!.sites.workbuddy!.accounts.find(a => a.uid === "b")!.cooldown!;
    expect(cooldown).toMatchObject({ code, scope: "account" });
    if (code === 14018) {
      expect(cooldown.until).toBe(nextWorkBuddyQuotaReset(before));
      expect(cooldown.until).toBeLessThanOrEqual(before + 86_400_000);
      expect(new Date(cooldown.until).getHours()).toBe(0);
      expect(new Date(cooldown.until).getMinutes()).toBe(5);
    } else expect(cooldown.until).toBeGreaterThanOrEqual(before + 7_200_000);
  });
  it.each([
    [10085, "workbuddy_protocol_error", false], [6004, "rate_limit", false],
    [14018, "insufficient_quota", false], [11140, "workbuddy_account_restricted", false],
    [11150, "invalid_request_error", true], [11153, "invalid_request_error", true],
    [11133, "invalid_request_error", true], [99999, "provider_response_error", true],
  ])("classifier code %s maps to %s with retryable=%s", async (upstreamCode, code, retryable) => {
    const h = await harness();
    expect(h.runtime.classifyError!(400, { code: upstreamCode }, "")).toMatchObject({ code, retryable });
  });
  it("the complete former terminal list is pinned, including wrapper-only errors", () => {
    expect([...WORKBUDDY_TERMINAL_CODES]).toEqual([
      "workbuddy_reauth", "workbuddy_protocol_error", "workbuddy_model_hidden",
      "workbuddy_not_connected", "rate_limit", "insufficient_quota", "workbuddy_account_restricted",
    ]);
  });
  it("pre-content SSE protocol terminal cannot be retried by the generic host", async () => {
    const h = await harness();
    const f = stubSequence(() => sse([event({ code: 10085 })]));
    const response = await h.send();
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("workbuddy_protocol_error");
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it("pre-content SSE exhaustion cannot restart the pool on a fallback model", async () => {
    const h = await harness();
    h.server.configService.set("Router", { enableFallback: true });
    h.server.configService.set("fallback", { default: ["workbuddy,hidden", "ordinary,m"] });
    vi.spyOn(getHealthStore(), "isAvailable").mockReturnValue(true);
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: any) => {
      urls.push(String(url));
      return String(url).includes("ordinary.invalid") ? success() : sse([event({ code: 6004 })]);
    }));
    expect((await h.send()).statusCode).toBe(200);
    expect(urls).toEqual([CN, CN, "https://ordinary.invalid/v1/chat/completions"]);
  });
  it("empty pool returns the original not-connected surface without any fetch", async () => {
    const h = await harness();
    await h.store.delete();
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const response = await h.send();
    expect(response.statusCode).toBe(409); expect(response.body).toContain("workbuddy_not_connected");
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["AbortError", "TimeoutError"])("%s cannot trigger the large-body diagnostic probe", async name => {
    const h = await harness();
    const fetch = vi.fn(async () => { throw new DOMException("private-body", name); });
    vi.stubGlobal("fetch", fetch);
    const response = await h.send("workbuddy", "m", false, "x".repeat(2 * 1024 * 1024 + 1));
    expect(response.body).not.toContain("private-body");
    // Generic transient retry remains allowed, but neither attempt probes billing.
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(2);
    expect(fetch.mock.calls.every(args => String(args[0]).includes("chat/completions"))).toBe(true);
  });
  it("10085 is terminal, no retry and no cooldown", async () => {
    const h = await harness();
    const f = stubSequence(() => json({ code: 10085, accessToken: "secret-b" }, 400));
    const response = await h.send(); expect(response.statusCode).toBe(400);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    // Plugin-seam surface: the client sees the fixed safe message carrying the
    // CLASS code, never the raw upstream body or numeric code.
    expect(response.body).toContain("workbuddy_protocol_error");
    expect(response.body).not.toContain("secret-");
    expect((await h.store.loadData())!.sites.workbuddy!.accounts.every(a => !a.cooldown && !a.modelCooldowns)).toBe(true);
  });
  it("reauth from a large-request reset is terminal and never rotates", async () => {
    const h = await harness();
    const fetch = vi.fn(async (url: any) => {
      if (String(url).includes("chat/completions")) throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
      return new Response("private-upstream-body", { status: 401 });
    });
    vi.stubGlobal("fetch", fetch);
    const response = await h.send("workbuddy", "m", false, "x".repeat(2 * 1024 * 1024 + 1));
    expect(response.statusCode).toBe(401); expect(response.body).toContain("workbuddy_reauth");
    expect(fetch).toHaveBeenCalledTimes(2); // generation + tiny diagnostic, never another generation
    expect(response.body).not.toMatch(/private-upstream-body|secret-/);
  });
  it("all accounts exhausted: exactly pool size attempts and one sanitized terminal error", async () => {
    const h = await harness();
    const fetch = vi.fn(async () => json({ code: 6004, msg: "private-upstream-body", accessToken: "secret-b" }, 429));
    vi.stubGlobal("fetch", fetch);
    const response = await h.send(); expect(response.statusCode).toBe(429);
    expect(fetch).toHaveBeenCalledTimes(2); expect(response.body).not.toMatch(/private-upstream-body|secret-/);
    expect((await h.store.loadData())!.sites.workbuddy!.accounts.every(a => a.modelCooldowns?.m)).toBe(true);
    const again = await h.send(); expect(again.statusCode).toBe(429); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("a large pool never exceeds the constant cap of 8 and never reuses a uid", async () => {
    const h = await harness();
    const accounts = Array.from({ length: 12 }, (_, i) => credential(`pool-${i}`));
    await h.store.saveData({ version: 2, sites: { workbuddy: { activeUid: "pool-11", accounts } } });
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: any, init: any) => {
      seen.push(new Headers(init.headers).get("x-user-id")!);
      return json({ code: 6004 }, 429);
    }));
    expect((await h.send()).statusCode).toBe(429);
    expect(seen).toHaveLength(8); expect(new Set(seen).size).toBe(8);
    expect(seen[0]).toBe("pool-11");
  });
  it("a misbehaving selection service cannot re-use an already attempted uid", async () => {
    const h = await harness();
    vi.spyOn(h.service as any, "currentCredential").mockResolvedValue(credential("b"));
    const fetch = vi.fn(async () => json({ code: 6004 }, 429)); vi.stubGlobal("fetch", fetch);
    expect((await h.send()).statusCode).toBe(429);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("transient failure after rotation cannot reset the account attempt cap", async () => {
    const h = await harness();
    const f = stubSequence(() => json({ code: 6004 }, 429), () => json({ msg: "temporary" }, 503));
    const response = await h.send(); expect(response.statusCode).toBe(503);
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });
  it("network failure after rotation is sanitized and cannot restart the pool", async () => {
    const h = await harness();
    let count = 0;
    const fetch = vi.fn(async () => {
      if (++count === 1) return json({ code: 6004 }, 429);
      throw new Error("private-upstream-body secret-a");
    });
    vi.stubGlobal("fetch", fetch);
    const response = await h.send(); expect(response.statusCode).toBe(502);
    expect(response.body).not.toMatch(/private-upstream-body|secret-a/);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("hidden direct send is rejected site-wide without fetch or rotation", async () => {
    const h = await harness(["hidden"]);
    const fetch = vi.fn(async () => success()); vi.stubGlobal("fetch", fetch);
    const response = await h.send("workbuddy", "hidden");
    expect(response.statusCode).toBe(422); expect(response.body).toContain("workbuddy_model_hidden");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("AI request resolves only AI credentials, including transformer auth fallback", async () => {
    const h = await harness(); const f = stubSequence(success);
    const response = await h.send("workbuddy-ai"); expect(response.statusCode).toBe(200);
    expect(f.urls).toEqual([AI]); expect(f.headers[0].get("x-user-id")).toBe("ai");
    const auth = await new WorkBuddyTransformer({ authService: h.service }).auth({ model: "m" }, { name: "workbuddy-ai" });
    expect(auth.config.headers.Authorization).toBe("Bearer secret-ai");
  });
  it("code-only 200 JSON envelopes (no error key) rotate through the generic envelope hook", async () => {
    // The plugin's isErrorEnvelope is what makes the core hidden-error check
    // fire for {code,msg,data} envelopes; the wrapper still performs the
    // rotation because the classified throw happens INSIDE attempt().
    const h = await harness();
    const f = stubSequence(() => json({ code: 6004, msg: "private-upstream-body" }), () => success());
    const response = await h.send();
    expect(response.statusCode).toBe(200); expect(response.body).toContain("healthy");
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(response.body).not.toContain("private-upstream-body");
  });
  it("200 JSON error envelopes rotate exactly like ordinary HTTP errors", async () => {
    const h = await harness(); const f = stubSequence(() => json({ error: { code: 6004, message: "private-upstream-body" } }));
    const response = await h.send(); expect(response.statusCode).toBe(200); expect(f.fetch).toHaveBeenCalledTimes(2);
  });
  it("a CN terminal failure falls through to the independent international subscription", async () => {
    // d1afba6 baseline behavior (review probe): CN 10085/6004 → AI origin still
    // requested and answers. Cross-site independence must survive the generic
    // provider-scoped request budget.
    const h = await harness();
    h.server.configService.set("Router", { enableFallback: true });
    h.server.configService.set("fallback", { default: ["workbuddy-ai,m"] });
    vi.spyOn(getHealthStore(), "isAvailable").mockReturnValue(true);
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: any) => {
      urls.push(String(url));
      return String(url).includes("workbuddy.ai") ? success() : json({ code: 10085 }, 400);
    }));
    expect((await h.send()).statusCode).toBe(200);
    expect(urls).toEqual([CN, AI]);
  });
  it("a CN terminal failure does not consume the international provider's refresh budget", async () => {
    // Per-provider 401-once refresh budget: two sites keep separate budgets.
    const h = await harness();
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: any) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ error: { message: "unauthenticated" } }), { status: 401, headers: { "content-type": "application/json" } });
    }));
    expect((await h.send("workbuddy-ai")).statusCode).toBe(401);
    expect((await h.send("workbuddy-ai")).statusCode).toBe(401);
    // Fresh request: a CN-only budget would have suppressed nothing here; pin
    // the two sites each get their own single retry via their own credentials.
    expect(seen.filter(u => u.startsWith("https://www.workbuddy.ai")).length).toBeGreaterThanOrEqual(2);
  });
  it("an international terminal failure still allows the CN provider as a fallback entry", async () => {
    const h = await harness();
    h.server.configService.set("Router", { enableFallback: true });
    h.server.configService.set("fallback", { default: ["workbuddy,m"] });
    vi.spyOn(getHealthStore(), "isAvailable").mockReturnValue(true);
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: any) => {
      urls.push(String(url));
      return String(url).includes("workbuddy.ai") ? json({ code: 11140 }, 403) : success();
    }));
    expect((await h.send("workbuddy-ai")).statusCode).toBe(200);
    expect(urls).toEqual([AI, CN]);
  });
  it("rotation finishes before switching to a different configured fallback provider", async () => {
    const h = await harness();
    h.server.configService.set("Router", { enableFallback: true });
    h.server.configService.set("fallback", { default: ["ordinary,m"] });
    vi.spyOn(getHealthStore(), "isAvailable").mockReturnValue(true);
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: any) => {
      urls.push(String(url));
      return String(url).includes("ordinary.invalid") ? success() : json({ code: 6004 }, 429);
    }));
    const response = await h.send();
    expect(response.statusCode).toBe(200); expect(response.body).toContain("healthy");
    expect(urls).toEqual([CN, CN, "https://ordinary.invalid/v1/chat/completions"]);
  });
  it("a future cooldown for m does not abandon the active account for another model", async () => {
    const h = await harness();
    await h.service.markAccountCooldown("workbuddy", "b", { scope: "model", model: "hidden", until: Date.now() + 900_000, code: 6004 });
    const f = stubSequence(success);
    expect((await h.send()).statusCode).toBe(200);
    expect(f.headers.map(headers => headers.get("x-user-id"))).toEqual(["b"]);
  });
  it.each([
    ["short window honored", 5.5 * 60_000, (elapsed: number) => elapsed > 4 * 60_000 && elapsed < 10 * 60_000],
    ["window longer than the default is respected", 20 * 60_000, (elapsed: number) => elapsed > 15 * 60_000],
  ])("SSE 6004 books the upstream reset window, not a flat 15 minutes (%s)", async (_name, windowMs, within) => {
    const h = await harness();
    const reset = new Date(Date.now() + windowMs);
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${reset.getFullYear()}-${pad(reset.getMonth() + 1)}-${pad(reset.getDate())} ${pad(reset.getHours())}:${pad(reset.getMinutes())}`;
    stubSequence(() => sse([event({ code: 6004, msg: `您的使用量已超出频率限制，将在 ${stamp} 重置` })]), () => sse([event({ code: 6004, msg: "频率限制" })]));
    const before = Date.now();
    expect((await h.send()).statusCode).toBe(400);
    const until = (await h.store.loadData())!.sites.workbuddy!.accounts.find((a: any) => a.uid === "b")!.modelCooldowns!.m.until;
    const elapsed = until - before;
    expect(within(elapsed), `booked ${Math.round(elapsed / 1000)}s, expected ~${Math.round(windowMs / 1000)}s`).toBe(true);
  });
  it("SSE 6004 without a parseable reset still books the 15 minute default", async () => {
    const h = await harness();
    stubSequence(() => sse([event({ code: 6004, msg: "rate limited" })]), () => sse([event({ code: 6004, msg: "频率限制" })]));
    const before = Date.now();
    expect((await h.send()).statusCode).toBe(400);
    const until = (await h.store.loadData())!.sites.workbuddy!.accounts.find((a: any) => a.uid === "b")!.modelCooldowns!.m.until;
    expect(until - before).toBeGreaterThanOrEqual(899_000);
  });
  it("HTTP 6004 with a reset window keeps booking the exact window (unchanged path)", async () => {
    const h = await harness();
    const reset = new Date(Date.now() + 5.5 * 60_000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${reset.getFullYear()}-${pad(reset.getMonth() + 1)}-${pad(reset.getDate())} ${pad(reset.getHours())}:${pad(reset.getMinutes())}`;
    stubSequence(() => json({ code: 6004, msg: `频率限制，将在 ${stamp} 重置` }, 429), () => success());
    const before = Date.now();
    expect((await h.send()).statusCode).toBe(200);
    const cooldown = (await h.store.loadData())!.sites.workbuddy!.accounts.find((a: any) => a.uid === "b")!.modelCooldowns!.m;
    const elapsed = cooldown.until - before;
    expect(elapsed > 4 * 60_000 && elapsed < 10 * 60_000).toBe(true);
  });
  it("pre-content SSE error split across chunks rotates after role-only preamble", async () => {
    const h = await harness();
    const error = event({ code: 6004, message: "private-upstream-body" });
    const f = stubSequence(() => sse([event({ choices: [{ delta: { role: "assistant" } }] }), error.slice(0, 10), error.slice(10)]), () => sse([event({ choices: [{ delta: { content: "healthy" } }] }), "data: [DONE]\n\n"]));
    const response = await h.send("workbuddy", "m", true);
    expect(response.statusCode).toBe(200); expect(response.body).toContain("healthy"); expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(response.body).not.toContain("private-upstream-body");
  });
  it("pre-content SSE error without a final event delimiter still rotates", async () => {
    const h = await harness();
    const f = stubSequence(() => sse([`data: {"code":6004}`]));
    expect((await h.send()).statusCode).toBe(200);
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });
  it("pre-content SSE CRLF error boundaries rotate without losing bytes", async () => {
    const h = await harness();
    const f = stubSequence(() => sse([`data: {"code":6004}\r`, "\n\r\n"]));
    expect((await h.send()).statusCode).toBe(200);
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });
  it("bounded pre-content inspection commits after 256KiB; later errors never replay", async () => {
    const h = await harness();
    const f = stubSequence(() => sse([":" + " ".repeat(256 * 1024) + "\n\n", event({ choices: [{ delta: { content: "visible" } }] }), event({ code: 6004, msg: "private-upstream-body" }), "data: [DONE]\n\n"]));
    const response = await h.send("workbuddy", "m", true);
    expect(response.body).toContain("visible"); expect(response.body).not.toContain("private-upstream-body");
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it("SSE error after content never replays, even within the same fetch chunk", async () => {
    const h = await harness();
    const f = stubSequence(() => sse([event({ choices: [{ delta: { content: "visible" } }] }) + event({ code: 6004, message: "private-upstream-body" }) + "data: [DONE]\n\n"]));
    const response = await h.send("workbuddy", "m", true);
    expect(response.body).toContain("visible"); expect(response.body).not.toContain("private-upstream-body");
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it("nested data.code SSE error rotates exactly like the JSON envelope", async () => {
    const h = await harness();
    const f = stubSequence(() => sse([event({ data: { code: 6004, msg: "private-upstream-body", accessToken: "secret-b" } })]), () => sse([event({ choices: [{ delta: { content: "healthy" } }] }), "data: [DONE]\n\n"]));
    const response = await h.send("workbuddy", "m", true);
    expect(response.statusCode).toBe(200); expect(response.body).toContain("healthy");
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(response.body).not.toMatch(/private-upstream-body|secret-/);
  });
  it("post-content nested data.code is redacted in the rewritten stream", async () => {
    const h = await harness();
    const f = stubSequence(() => sse([event({ choices: [{ delta: { content: "visible" } }] }) + event({ data: { code: 6004, msg: "private-upstream-body", accessToken: "secret-a" } }) + "data: [DONE]\n\n"]));
    const response = await h.send("workbuddy", "m", true);
    expect(response.body).toContain("visible");
    expect(response.body).not.toMatch(/private-upstream-body|secret-a/);
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it("a request never exceeds pool-size upstream attempts across the outer retry", async () => {
    const h = await harness();
    // First attempt: transient 503 (keeps the outer same-model retry alive).
    // Second attempt: 6004 rotates. The retry must NOT reset the account budget.
    const f = stubSequence(() => json({ msg: "temporary" }, 503), () => json({ code: 6004 }, 429));
    const response = await h.send();
    expect(response.statusCode).toBe(429);
    expect(f.fetch.mock.calls.length).toBeLessThanOrEqual(2);
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.headers.map(headers => headers.get("authorization"))).toEqual(["Bearer secret-b", "Bearer secret-a"]);
  });
  it("single-account pool makes exactly one upstream attempt per request", async () => {
    const h = await harness();
    await h.service.removeAccount("workbuddy", "a");
    const f = stubSequence(() => json({ code: 6004 }, 429));
    expect((await h.send()).statusCode).toBe(429);
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it("an alias provider pointing at a managed origin is still subject to the site denylist", async () => {
    // The alias must be registered at construction (ProviderService registers
    // in its constructor only) and target the CN origin, so resolution cannot
    // fall back to the canonical provider's own denylist.
    const h = await harness(["hidden"]);
    // registerProvider() stores the transformer as given (it does not resolve
    // string names), so pass a real instance — exactly what the managed provider
    // carries at runtime.
    const alias = { name: "evil-alias", baseUrl: CN, apiKey: "attacker", models: ["m", "hidden"], transformer: { use: [new WorkBuddyTransformer({ authService: h.service })] } };
    (h.server as any).providerService.registerProvider(alias);
    const fetch = vi.fn(async () => success()); vi.stubGlobal("fetch", fetch);
    const response = await h.send("evil-alias", "hidden");
    expect(response.statusCode).toBe(422); expect(response.body).toContain("workbuddy_model_hidden");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("an ordinary provider on a managed origin without the workbuddy transformer is not captured", async () => {
    const h = await harness(["hidden"]);
    const proxy = { name: "plain-proxy", baseUrl: CN, apiKey: "attacker", models: ["m"] };
    (h.server as any).providerService.registerProvider(proxy);
    const f = stubSequence(success);
    const response = await h.send("plain-proxy", "m");
    expect(response.statusCode).toBe(200); expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it("ordinary provider still receives its one same-model retry", async () => {
    const h = await harness(); const f = stubSequence(() => json({ error: "temporary" }, 503));
    const response = await h.send("ordinary"); expect(response.statusCode).toBe(200); expect(f.fetch).toHaveBeenCalledTimes(2);
  });
  it("classified-surface cooldown mapper matches the protocol mapper class-by-class", () => {
    const now = Date.now();
    // rotate classes
    for (const [status, body] of [[429, { code: 6004 }], [403, { code: 14018 }], [403, { code: 11140 }]] as const) {
      const inline = workBuddyFailoverCooldown(classifyWorkBuddyError(status, body), "m", now);
      const upstreamCode = (body as any).code;
      const classCode = upstreamCode === 6004 ? "rate_limit" : upstreamCode === 14018 ? "insufficient_quota" : "workbuddy_account_restricted";
      const cooldownMs = (classifyWorkBuddyError(status, body) as any).cooldownSeconds * 1000;
      const seam = workBuddyFailoverCooldownFromInfo({ code: classCode, cooldownMs, statusCode: status }, "m", now);
      expect(seam).toEqual(inline);
      if (classCode === "rate_limit") expect(seam).toMatchObject({ scope: "model", model: "m", code: 6004 });
      if (classCode === "insufficient_quota") expect(seam!.until).toBe(inline!.until);
      if (classCode === "workbuddy_account_restricted") expect(seam!.until).toBe(now + 7_200_000);
    }
    // terminal/transient classes never rotate on either surface
    for (const code of ["workbuddy_reauth", "workbuddy_protocol_error", "permission_error", "invalid_request_error", "provider_response_error"]) {
      expect(workBuddyFailoverCooldownFromInfo({ code, statusCode: 500 }, "m", now)).toBeNull();
    }
    // rate limit without a model falls back to the account scope, like inline
    const inlineNoModel = workBuddyFailoverCooldown(classifyWorkBuddyError(429, { code: 6004 }));
    const seamNoModel = workBuddyFailoverCooldownFromInfo({ code: "rate_limit", cooldownMs: 900_000, statusCode: 429 });
    expect(seamNoModel).toMatchObject({ scope: "account" });
    expect(inlineNoModel).toMatchObject({ scope: "account" });
  });
  it("HTTP429 without known numeric code rotates, explicit terminal identities always win", () => {
    expect(workBuddyFailoverCooldown(classifyWorkBuddyError(429, { code: 99999 }), "m")).toMatchObject({ scope: "model", model: "m", code: 6004 });
    expect(workBuddyFailoverCooldown(classifyWorkBuddyError(400, { code: 99999, msg: "rate limit" }), "m")).toBeNull();
    expect(workBuddyFailoverCooldown({ workbuddy: true, code: "workbuddy_reauth", upstreamCode: 6004, statusCode: 429 }, "m")).toBeNull();
    expect(workBuddyFailoverCooldown({ workbuddy: true, code: "rate_limit", upstreamCode: 10085, statusCode: 429 }, "m")).toBeNull();
    const now = Date.now();
    const until = now + 1_800_000;
    const classified = classifyWorkBuddyError(429, { code: 6004, msg: `将在 ${new Date(until).toISOString().replace(/\.\d{3}Z$/, "Z")} 重置` });
    expect(workBuddyFailoverCooldown(classified, "m", now)!.until).toBeGreaterThan(now + 1_700_000);
  });
});
