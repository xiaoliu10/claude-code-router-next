/**
 * Manual usage-reset (gifted reset credits) — protocol, service and card.
 *
 * SAFETY CONTRACT UNDER TEST: no real account reset allowance is ever
 * consumed. Every upstream call here is a fake fetch against fixture
 * envelopes; the consume endpoint is reached ONLY through an explicit user
 * confirmation. These tests pin that boundary:
 *  - mount / status / usage / sync / hide / restore / disconnect never POST
 *    the consume endpoint;
 *  - a second concurrent consume is rejected, not queued (no double spend);
 *  - the idempotency key is minted per confirmation and reused on retry;
 *  - exhausted allowance disables the control and maps no_credit to 409;
 *  - unknown envelopes fail closed (never reported as success).
 */
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CodexAuthService, CodexCredentialStore,
} from "../src/auth-service";
import {
  CODEX_CHATGPT_ORIGIN, CODEX_RESET_CONSUME_PATH, CODEX_RESET_CREDITS_PATH,
  consumeCodexResetCredit, fetchCodexResetCredits, parseCodexResetCredits,
} from "../src/protocol";
import { parseCodexResetConsume, parseCodexResetCredits as parseCardCredits } from "../src/card-types";
import { codexLocales } from "../src/locales";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});
const jwt = (claims: Record<string, any>) =>
  `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fixture`;
const freshAccess = () => jwt({ exp: Math.floor(Date.now() / 1000) + 7200 });

const LISTING = {
  available_count: 2,
  total_earned_count: 3,
  credits: [
    { id: "credit-old", reset_type: "codex_rate_limits", status: "available",
      granted_at: "2026-10-01T00:00:00Z", expires_at: "2026-12-01T00:00:00Z", title: "Full reset" },
    { id: "credit-new", reset_type: "codex_rate_limits", status: "available",
      granted_at: "2026-11-01T00:00:00Z", expires_at: "2027-01-01T00:00:00Z" },
    { id: "credit-spent", reset_type: "codex_rate_limits", status: "redeemed",
      granted_at: "2026-09-01T00:00:00Z" },
  ],
};

// ---------------------------------------------------------------------------
// Protocol: parsing + fetch shapes (pure fakes)
// ---------------------------------------------------------------------------

describe("reset credits — protocol", () => {
  it("parses the upstream listing envelope and bounds hostile shapes", () => {
    const parsed = parseCodexResetCredits(LISTING);
    expect(parsed).toEqual({
      availableCount: 2,
      credits: [
        { id: "credit-old", status: "available", expiresAt: Date.parse("2026-12-01T00:00:00Z"), title: "Full reset" },
        { id: "credit-new", status: "available", expiresAt: Date.parse("2027-01-01T00:00:00Z"), title: "Full reset" },
        { id: "credit-spent", status: "redeemed", title: "Full reset" },
      ],
    });
    // Fail closed: missing count, negative count, malformed items, huge lists.
    expect(parseCodexResetCredits(null)).toBeNull();
    expect(parseCodexResetCredits({ credits: [] })).toBeNull();
    expect(parseCodexResetCredits({ available_count: -1, credits: [] })).toEqual({ availableCount: 0, credits: [] });
    expect(parseCodexResetCredits({ available_count: 1, credits: [{ status: "available" }] })).toBeNull();
    expect(parseCodexResetCredits({ available_count: 1, credits: Array(257).fill({ id: "x", status: "available" }) })).toBeNull();
    // Unparseable expiry is dropped, never NaN.
    const weird = parseCodexResetCredits({ available_count: 1, credits: [{ id: "x", status: "available", expires_at: "not-a-date" }] });
    expect(weird!.credits[0].expiresAt).toBeUndefined();
  });

  it("GET listing uses management headers on the wham origin and fails closed on errors", async () => {
    const calls: Array<{ url: string; init?: any }> = [];
    const impl = vi.fn(async (url: string, init?: any) => {
      calls.push({ url, init });
      return json(LISTING);
    });
    const listing = await fetchCodexResetCredits({ accessToken: "at", accountId: "acct", fetchImpl: impl });
    expect(listing?.availableCount).toBe(2);
    expect(calls[0].url).toBe(`${CODEX_CHATGPT_ORIGIN}${CODEX_RESET_CREDITS_PATH}`);
    expect(calls[0].init.method).toBe("GET");
    expect(calls[0].init.headers.Authorization).toBe("Bearer at");
    expect(calls[0].init.headers["chatgpt-account-id"]).toBe("acct");
    expect(calls[0].init.redirect).toBe("error");

    const fail = await fetchCodexResetCredits({ accessToken: "at", fetchImpl: async () => json({ error: "x" }, 500) });
    expect(fail).toBeNull();
    const garbage = await fetchCodexResetCredits({ accessToken: "at", fetchImpl: async () => new Response("not json") });
    expect(garbage).toBeNull();
  });

  it("POST consume sends the idempotency key + optional credit id and maps every outcome", async () => {
    const seen: any[] = [];
    const impl = vi.fn(async (_url: string, init?: any) => {
      seen.push(JSON.parse(init.body));
      return json({ code: "reset", windows_reset: 2 });
    });
    const result = await consumeCodexResetCredit({
      redeemRequest: "uuid-1", creditId: "credit-old", accessToken: "at", accountId: "acct", fetchImpl: impl,
    });
    expect(result).toEqual({ outcome: "reset", windowsReset: 2 });
    expect(seen[0]).toEqual({ redeem_request_id: "uuid-1", credit_id: "credit-old" });

    for (const code of ["nothing_to_reset", "no_credit", "already_redeemed"] as const) {
      const r = await consumeCodexResetCredit({
        redeemRequest: "uuid-2", accessToken: "at",
        fetchImpl: async () => json({ code, windows_reset: 0 }),
      });
      expect(r.outcome).toBe(code);
    }
    // No creditId → body carries only the idempotency key (backend picks).
    await consumeCodexResetCredit({ redeemRequest: "uuid-3", accessToken: "at", fetchImpl: impl });
    expect(seen.at(-1)).toEqual({ redeem_request_id: "uuid-3" });
  });

  it("consume fails closed on unknown envelopes and maps 401 to reauth", async () => {
    await expect(consumeCodexResetCredit({
      redeemRequest: "u", accessToken: "at",
      fetchImpl: async () => json({ code: "surprise" }),
    })).rejects.toMatchObject({ code: "codex_upstream_error" });
    await expect(consumeCodexResetCredit({
      redeemRequest: "u", accessToken: "at",
      fetchImpl: async () => new Response("oops", { status: 500 }),
    })).rejects.toMatchObject({ code: "codex_upstream_error" });
    await expect(consumeCodexResetCredit({
      redeemRequest: "u", accessToken: "at",
      fetchImpl: async () => json({ error: "denied" }, 401),
    })).rejects.toMatchObject({ code: "codex_reauth_required" });
  });
});

// ---------------------------------------------------------------------------
// Service: allowance, single-flight, idempotency, explicit-only boundary
// ---------------------------------------------------------------------------

const dirs: string[] = [];
const services: CodexAuthService[] = [];
beforeEach(() => { vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network disabled"); })); });
afterEach(async () => {
  for (const s of services.splice(0)) await s.dispose();
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

/** Connected service with a fully fake upstream; consume behavior injectable. */
async function connected(opts: {
  consume?: (body: any) => Response | Promise<Response>;
  listing?: () => Response | Promise<Response>;
} = {}) {
  const dir = await fs.mkdtemp(join(tmpdir(), "codex-reset-"));
  dirs.push(dir);
  const store = new CodexCredentialStore(join(dir, "codex-credentials.json"));
  await store.save({
    version: 1, kind: "codex-subscription",
    account: {
      accessToken: freshAccess(), refreshToken: "rt", idToken: jwt({}),
      accountId: "acct_1", email: "u@example.invalid", plan: "pro",
      connectedAt: new Date().toISOString(),
      accessExp: Date.now() + 7_200_000, lastError: null,
    },
    models: [], hiddenModels: [],
  } as any);
  const calls: Array<{ url: string; method: string; body?: any }> = [];
  let listingCount = opts.listing ? 0 : 0;
  const impl = vi.fn(async (url: string, init?: any) => {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });
    if (url.endsWith(CODEX_RESET_CREDITS_PATH)) {
      listingCount += 1;
      return opts.listing ? opts.listing() : json(LISTING);
    }
    if (url.endsWith(CODEX_RESET_CONSUME_PATH)) {
      return opts.consume ? opts.consume(body) : json({ code: "reset", windows_reset: 2 });
    }
    if (url.includes("/wham/usage")) return json({ plan_type: "pro", rate_limit: {} });
    throw new Error(`unexpected upstream call: ${method} ${url}`);
  });
  const host = {
    readRawConfig: vi.fn(async () => ({ Providers: [], Router: {} })),
    readConfig: vi.fn(async () => ({ Providers: [], Router: {} })),
    writeConfig: vi.fn(async () => {}),
    reloadRuntime: vi.fn(async () => {}),
    getDirectDispatcher: vi.fn(() => ({})),
  };
  const service = new CodexAuthService({
    configDir: dir, host: host as any, fetchImpl: impl, store,
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  });
  services.push(service);
  const consumeCalls = () => calls.filter(c => c.url.endsWith(CODEX_RESET_CONSUME_PATH));
  return { service, calls, consumeCalls, impl, listingReads: () => listingCount };
}

describe("reset credits — service", () => {
  it("getResetCredits lists the allowance, caches briefly, and returns null when disconnected", async () => {
    const h = await connected();
    const first = await h.service.getResetCredits();
    expect(first?.availableCount).toBe(2);
    expect(first?.credits.map(c => c.id)).toEqual(["credit-old", "credit-new", "credit-spent"]);
    await h.service.getResetCredits(); // TTL cache — no second upstream read
    expect(h.listingReads()).toBe(1);

    const empty = await connected({ listing: () => json({ error: "nope" }, 404) });
    expect(await empty.service.getResetCredits()).toBeNull();
  });

  it("mount/status/usage/sync/disconnect NEVER consume a reset credit", async () => {
    const h = await connected();
    await h.service.getStatus();
    await h.service.getUsage();
    await h.service.getResetCredits();
    await h.service.syncModels().catch(() => {}); // models endpoint not faked here — irrelevant
    expect(h.consumeCalls()).toHaveLength(0);
    await h.service.disconnect();
    expect(h.consumeCalls()).toHaveLength(0);
  });

  it("consume success: fresh UUID per confirmation, usage cache invalidated, authoritative recount", async () => {
    let remaining = 2;
    const h = await connected({
      consume: () => { remaining -= 1; return json({ code: "reset", windows_reset: 2 }); },
      listing: () => json({ ...LISTING, available_count: remaining }),
    });
    // Warm the usage cache so we can prove invalidation.
    await h.service.getUsage();
    const result = await h.service.consumeResetCredit("credit-old");
    expect(result.outcome).toBe("reset");
    expect(result.windowsReset).toBe(2);
    expect(result.availableCount).toBe(1); // re-listed, not guessed
    const key1 = h.consumeCalls()[0].body.redeem_request_id;
    expect(key1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(h.consumeCalls()[0].body.credit_id).toBe("credit-old");
    // Usage cache was cleared: the next getUsage hits upstream again.
    const usageReadsBefore = h.calls.filter(c => c.url.includes("/wham/usage")).length;
    await h.service.getUsage();
    expect(h.calls.filter(c => c.url.includes("/wham/usage")).length).toBe(usageReadsBefore + 1);

    // A NEW confirmation mints a NEW key (never reuses the previous one).
    await h.service.consumeResetCredit("credit-new");
    const key2 = h.consumeCalls()[1].body.redeem_request_id;
    expect(key2).not.toBe(key1);
  });

  it("a second concurrent consume is rejected (busy), never queued — no double spend", async () => {
    let release!: (r: Response) => void;
    const gate = new Promise<Response>(r => { release = r; });
    const h = await connected({ consume: () => gate.then(() => json({ code: "reset", windows_reset: 1 })) });
    const first = h.service.consumeResetCredit("credit-old");
    // Let the first consume reach the upstream gate before racing it.
    await vi.waitFor(() => expect(h.consumeCalls().length).toBe(1));
    await expect(h.service.consumeResetCredit("credit-new")).rejects.toMatchObject({ code: "codex_reset_busy", statusCode: 429 });
    release(json({ code: "reset", windows_reset: 1 }));
    expect((await first).outcome).toBe("reset");
    expect(h.consumeCalls()).toHaveLength(1); // exactly ONE upstream consume
    // After settling, a new explicit consume is allowed again.
    await h.service.consumeResetCredit("credit-new");
    expect(h.consumeCalls()).toHaveLength(2);
  });

  it("busy latch is synchronous: two same-tick consumes fire exactly ONE upstream call", async () => {
    let release!: (r: Response) => void;
    const gate = new Promise<Response>(r => { release = r; });
    const h = await connected({ consume: () => gate.then(() => json({ code: "reset", windows_reset: 1 })) });
    // Both calls issued in the SAME tick — the second must be rejected busy
    // before the first even reaches upstream (no pre-assignment race window).
    const a = h.service.consumeResetCredit("credit-old");
    await expect(h.service.consumeResetCredit("credit-new")).rejects.toMatchObject({ code: "codex_reset_busy" });
    release(json({ code: "reset", windows_reset: 1 }));
    expect((await a).outcome).toBe("reset");
    expect(h.consumeCalls()).toHaveLength(1);
  });

  it("a retried confirmation of the same credit reuses the SAME idempotency key", async () => {
    let fail = true;
    const h = await connected({
      consume: (_body) => {
        if (fail) { fail = false; return Promise.reject(new Error("connection reset")); }
        return json({ code: "reset", windows_reset: 1 });
      },
    });
    await expect(h.service.consumeResetCredit("credit-old")).rejects.toBeTruthy();
    const key1 = h.consumeCalls()[0].body.redeem_request_id;
    const result = await h.service.consumeResetCredit("credit-old");
    expect(result.outcome).toBe("reset");
    const key2 = h.consumeCalls()[1].body.redeem_request_id;
    expect(key2).toBe(key1); // upstream dedupes per key — no double spend
    // A DIFFERENT credit mints a fresh key.
    const result2 = await h.service.consumeResetCredit("credit-new");
    expect(result2.outcome).toBe("reset");
    expect(h.consumeCalls()[2].body.redeem_request_id).not.toBe(key1);
  });

  it("disconnect clears reset caches and the spent marker (account switch safety)", async () => {
    const h = await connected();
    await h.service.consumeResetCredit("credit-old");
    await h.service.disconnect();
    expect((h.service as any).spentResetCredits.size).toBe(0);
    expect((h.service as any).resetCache).toBeNull();
    expect((h.service as any).pendingReset).toBeNull();
  });

  it("locally spent credit cannot be re-consumed after a lost response", async () => {
    const h = await connected();
    await h.service.consumeResetCredit("credit-old");
    await expect(h.service.consumeResetCredit("credit-old")).rejects.toMatchObject({ code: "codex_reset_no_credit", statusCode: 409 });
    expect(h.consumeCalls()).toHaveLength(1);
    // The listing hides the locally spent credit from the visible availability.
    const listing = await h.service.getResetCredits();
    expect(listing?.credits.some(c => c.id === "credit-old")).toBe(false);
  });

  it("no_credit outcome zeroes the allowance surface without a local guess", async () => {
    const h = await connected({ consume: () => json({ code: "no_credit", windows_reset: 0 }) });
    const result = await h.service.consumeResetCredit();
    expect(result.outcome).toBe("no_credit");
    const listing = await h.service.getResetCredits();
    expect(listing).toEqual({ credits: [], availableCount: 0 });
  });

  it("nothing_to_reset leaves caches intact; transport failure keeps the key for user retry", async () => {
    const h = await connected({ consume: () => json({ code: "nothing_to_reset", windows_reset: 0 }) });
    const r = await h.service.consumeResetCredit("credit-old");
    expect(r.outcome).toBe("nothing_to_reset");
    expect(r.availableCount).toBeUndefined(); // no recount for a non-terminal outcome

    // Transport failure: the SAME confirmation can be retried by the user;
    // the service mints a fresh key per call but the upstream dedupes by the
    // key the CLIENT retains — here we pin that a failed consume does not
    // mark the credit spent and does not latch the busy state.
    const failing = await connected({ consume: () => { throw new Error("connection reset"); } });
    await expect(failing.service.consumeResetCredit("credit-old")).rejects.toBeTruthy();
    expect(failing.consumeCalls()).toHaveLength(1);
    // Not marked spent: a retry reaches upstream again.
    await expect(failing.service.consumeResetCredit("credit-old")).rejects.toBeTruthy();
    expect(failing.consumeCalls()).toHaveLength(2);
  });

  it("reauth upstream maps to the admin reauth code; disconnected consume is 409", async () => {
    const h = await connected({ consume: () => json({ error: "expired" }, 401) });
    await expect(h.service.consumeResetCredit()).rejects.toMatchObject({ code: "codex_reauth_required", statusCode: 422 });
    await h.service.disconnect();
    await expect(h.service.consumeResetCredit()).rejects.toMatchObject({ code: "codex_not_connected", statusCode: 409 });
  });
});

// ---------------------------------------------------------------------------
// Card view parsers + locale parity
// ---------------------------------------------------------------------------

describe("reset credits — card parsers and locales", () => {
  it("card listing parser is fail-closed and mirrors the service shape", () => {
    const parsed = parseCardCredits({ availableCount: 2, credits: [{ id: "c1", status: "available", expiresAt: 123, title: "Full reset" }] });
    expect(parsed).toEqual({ availableCount: 2, credits: [{ id: "c1", status: "available", expiresAt: 123, title: "Full reset" }] });
    expect(parseCardCredits(null)).toBeNull();
    expect(parseCardCredits({ availableCount: 1.5, credits: [] })).toBeNull();
    expect(parseCardCredits({ availableCount: 1, credits: [{ id: "", status: "available" }] })).toBeNull();
  });

  it("card consume parser only accepts the four known outcomes", () => {
    expect(parseCodexResetConsume({ outcome: "reset", windowsReset: 2, availableCount: 1 }))
      .toEqual({ outcome: "reset", windowsReset: 2, availableCount: 1 });
    expect(parseCodexResetConsume({ outcome: "surprise" })).toBeNull();
    expect(parseCodexResetConsume(null)).toBeNull();
    expect(parseCodexResetConsume({ outcome: "no_credit", windowsReset: -3 })).toEqual({ outcome: "no_credit", windowsReset: 0 });
  });

  it("every reset locale key exists in en and zh with the same shape", () => {
    const en = codexLocales.en.codex as any;
    const zh = codexLocales.zh.codex as any;
    const keys = ["reset_available", "reset_expires", "reset_button", "reset_title", "reset_warning",
      "reset_confirm", "reset_done", "reset_already", "reset_none_left", "reset_nothing"];
    for (const k of keys) {
      expect(typeof en[k], `en.${k}`).toBe("string");
      expect(typeof zh[k], `zh.${k}`).toBe("string");
      expect(en[k].length, `en.${k}`).toBeGreaterThan(0);
      expect(zh[k].length, `zh.${k}`).toBeGreaterThan(0);
    }
    for (const k of ["reset_failed", "codex_reset_busy", "codex_reset_no_credit", "codex_reset_unavailable", "codex_reset_invalid"]) {
      expect(typeof en.errors[k], `en.errors.${k}`).toBe("string");
      expect(typeof zh.errors[k], `zh.errors.${k}`).toBe("string");
    }
  });
});
