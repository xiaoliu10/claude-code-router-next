/**
 * Codex auth service tests — credential file hardening (0600, atomic,
 * invalid payloads), browser login state machine (1455/1457/paste, state,
 * replay, expiry, cancel, busy ports), single-flight refresh with
 * persist-before-use, refresh rejection → reauth, id_token claims,
 * dynamic models/instructions, wham usage, config protection, disconnect.
 *
 * node:http and node:fs are deliberately NOT mocked: the loopback callback
 * socket and the 0600 credential file are the real attack surfaces. Only the
 * upstream fetch is faked — no network, no real endpoints, no real login.
 */
import { promises as fs } from "node:fs";
import { createServer, get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CodexAuthService, CodexCredentialStore,
  type CodexAccountRecord, type CodexCredentialData,
} from "../src/auth-service";
import {
  CODEX_CALLBACK_PORTS,
  CODEX_PROVIDER_NAME,
  CODEX_API_KEY,
  CODEX_TRANSFORMER_NAME,
} from "../src/protocol";

function jwt(claims: Record<string, any>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64(claims)}.sig`;
}
const nowSec = () => Math.floor(Date.now() / 1000);
const freshIdToken = (plan = "pro", acct = "acct_1") =>
  jwt({ email: "codex@example.invalid", "https://api.openai.com/auth": { chatgpt_account_id: acct, chatgpt_plan_type: plan } });
/** Access token that expires in `secs` seconds (default: comfortably fresh). */
const accessTokenFor = (secs = 3600) => jwt({ exp: nowSec() + secs });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});

const dirs: string[] = [];
const services: CodexAuthService[] = [];

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network disabled in test"); }));
});
afterEach(async () => {
  for (const s of services.splice(0)) await s.dispose();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

/** Harness with plain injected host fakes; credentials in a throwaway dir. */
async function harness(opts: { config?: any; accessSecs?: number } = {}) {
  const dir = await fs.mkdtemp(join(tmpdir(), "codex-auth-"));
  dirs.push(dir);
  const store = new CodexCredentialStore(join(dir, "codex-credentials.json"));
  const live = { current: structuredClone(opts.config ?? { Providers: [], Router: {} }) };
  const host = {
    readRawConfig: vi.fn(async () => structuredClone(live.current)),
    readConfig: vi.fn(async () => structuredClone(live.current)),
    writeConfig: vi.fn(async (next: any) => { live.current = structuredClone(next); }),
    reloadRuntime: vi.fn(async () => {}),
    getDirectDispatcher: vi.fn(() => ({ fake: "dispatcher" })),
  };
  const service = new CodexAuthService({
    configDir: dir,
    host: host as any,
    fetchImpl: vi.fn(async () => { throw new Error("network disabled in test"); }),
    store,
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  });
  services.push(service);
  return { store, service, host, dir, config: () => live.current };
}

const MODELS = {
  models: [
    { slug: "gpt-a", display_name: "A", visibility: "visible", priority: 10,
      model_messages: { instructions_template: "INSTRUCTIONS-A" } },
    { slug: "gpt-b", display_name: "B", visibility: "hide", priority: 5 },
    { slug: "gpt-c", display_name: "C", visibility: "visible", priority: 20, base_instructions: "INSTRUCTIONS-C" },
  ],
};

/** Deterministic fake upstream: exchange, refresh, models, usage. */
function fakeUpstream(opts: { refreshStatus?: number; accessSecs?: number } = {}) {
  const calls: string[] = [];
  const impl = vi.fn(async (url: string, init?: any) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.endsWith("/oauth/token")) {
      const body = init?.body ?? "";
      const isRefresh = typeof body === "string" && body.includes("refresh_token") && body.includes("grant_type");
      if (isRefresh && opts.refreshStatus === 400) return json({ error: "invalid_grant" }, 400);
      if (isRefresh) {
        return json({ id_token: freshIdToken(), access_token: accessTokenFor(), refresh_token: "rt-rotated" });
      }
      return json({
        id_token: freshIdToken(),
        access_token: accessTokenFor(opts.accessSecs),
        refresh_token: "rt-1",
      });
    }
    if (url.includes("/backend-api/codex/models")) return json(MODELS);
    if (url.includes("/wham/usage")) return json({ plan_type: "pro", rate_limit: { primary_window: {
      used_percent: 5, limit_window_seconds: 18000, reset_at: nowSec() + 18000,
    } } });
    throw new Error(`unexpected upstream call: ${url}`);
  });
  return { impl, calls };
}

/** Start a login and complete it with a valid callback (real socket or paste). */
async function loginWith(service: CodexAuthService, code: string) {
  const start = await service.startLogin();
  const state = new URL(start.url).searchParams.get("state")!;
  const poll = start.mode === "callback"
    ? await (async () => {
        const port = Number(new URL(start.redirectUri).port);
        const path = start.redirectUri.replace(`http://127.0.0.1:${port}`, "");
        await new Promise<string>((resolve, reject) => {
          const req = get({ host: "127.0.0.1", port, path: `${path}?state=${state}&code=${code}` }, (res) => {
            let text = ""; res.on("data", (d) => { text += d; }); res.on("end", () => resolve(text));
          });
          req.on("error", reject);
        });
        return service.pollLogin(start.loginId);
      })()
    : await service.submitCallback(start.loginId, `${start.redirectUri}?state=${state}&code=${code}`);
  return { start, poll };
}

/** Login with the default fake upstream, then return the harness. */
async function connected(opts: { config?: any; refreshStatus?: number; accessSecs?: number } = {}) {
  const h = await harness({ config: opts.config, accessSecs: opts.accessSecs });
  (h.service as any).options.fetchImpl = fakeUpstream(opts).impl;
  const { poll } = await loginWith(h.service, "the-code");
  expect(poll.status).toBe("connected");
  return h;
}

// ---------------------------------------------------------------------------
// Credential file hardening
// ---------------------------------------------------------------------------

describe("credential store", () => {
  const valid = (): CodexCredentialData => ({
    version: 1, kind: "codex-subscription",
    account: {
      accessToken: "at", refreshToken: "rt", idToken: freshIdToken(),
      accountId: "acct_1", email: "codex@example.invalid", plan: "pro",
      connectedAt: "2026-01-01T00:00:00.000Z", accessExp: nowSec() * 1000 + 3600_000,
      lastError: null, cooldownUntil: null, rateLimitCooldownUntil: null,
    } satisfies CodexAccountRecord,
    models: [{ slug: "gpt-a", displayName: "A", instructions: "X" }],
    rateLimits: null,
  });

  it("round-trips and writes 0600", async () => {
    const { store, dir } = await harness();
    await store.save(valid());
    const stat = await fs.stat(join(dir, "codex-credentials.json"));
    expect(stat.mode & 0o777).toBe(0o600);
    const loaded = (await store.load())!;
    expect(loaded.account.accountId).toBe("acct_1");
    expect(loaded.models[0].instructions).toBe("X");
  });

  it("rejects a world/group-readable file", async () => {
    const { store, dir } = await harness();
    await store.save(valid());
    await fs.chmod(join(dir, "codex-credentials.json"), 0o644);
    await expect(store.load()).rejects.toMatchObject({ code: "codex_credential_unreadable" });
  });

  it("rejects invalid JSON, wrong kind, unknown error codes and bad timestamps", async () => {
    const { store, dir } = await harness();
    const path = join(dir, "codex-credentials.json");
    await fs.writeFile(path, "{not json", "utf8");
    await expect(store.load()).rejects.toMatchObject({ code: "codex_credential_unreadable" });

    await store.save(valid());
    const raw = JSON.parse(await fs.readFile(path, "utf8"));
    raw.account.lastError = { code: "not-a-code" };
    await fs.writeFile(path, JSON.stringify(raw), { mode: 0o600 });
    await expect(store.load()).rejects.toMatchObject({ code: "codex_credential_unreadable" });

    await expect(store.save({ ...valid(), kind: "codex" } as any))
      .rejects.toMatchObject({ code: "codex_credential_invalid" });
    await expect(store.save({ ...valid(), account: { ...valid().account, connectedAt: "nope" } } as any))
      .rejects.toMatchObject({ code: "codex_credential_invalid" });
  });

  it("leaves no temp file behind", async () => {
    const { store, dir } = await harness();
    await store.save(valid());
    expect(await fs.readdir(dir)).toEqual(["codex-credentials.json"]);
  });

  it("delete returns false when absent", async () => {
    const { store } = await harness();
    await expect(store.delete()).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Login: busy ports → 1457 → paste; state, replay, cancel, expiry
// ---------------------------------------------------------------------------

describe("browser login", () => {
  it("prefers the official default port and reports the official redirect URI", async () => {
    const { service } = await harness();
    const start = await service.startLogin();
    try {
      expect(start.redirectUri).toBe("http://127.0.0.1:1455/auth/callback");
      expect(start.mode).toBe("callback");
      expect(start.url).toContain(encodeURIComponent("http://127.0.0.1:1455/auth/callback"));
      expect(start.expiresAt).toBeGreaterThan(Date.now());
    } finally {
      await service.cancelLogin(start.loginId);
    }
  });

  it("falls back to the registered port 1457 when 1455 is busy", async () => {
    const busy = createServer();
    await new Promise<void>((r) => busy.listen(1455, "127.0.0.1", r));
    const { service } = await harness();
    try {
      const start = await service.startLogin();
      expect(start.redirectUri).toBe("http://127.0.0.1:1457/auth/callback");
      expect(start.mode).toBe("callback");
      await service.cancelLogin(start.loginId);
    } finally {
      await new Promise((r) => busy.close(r));
    }
  });

  it("moves to paste mode when BOTH registered ports are busy (never probes /cancel)", async () => {
    const a = createServer();
    const b = createServer();
    await new Promise<void>((r) => a.listen(1455, "127.0.0.1", r));
    await new Promise<void>((r) => b.listen(1457, "127.0.0.1", r));
    const { service } = await harness();
    (service as any).options.fetchImpl = fakeUpstream().impl;
    try {
      const start = await service.startLogin();
      expect(start.mode).toBe("paste");
      expect(start.redirectUri).toBe(`http://127.0.0.1:${CODEX_CALLBACK_PORTS[0]}/auth/callback`);
      // Paste mode binds no socket: nothing else could be cancelled.
      await service.cancelLogin(start.loginId);
    } finally {
      await new Promise((r) => a.close(r));
      await new Promise((r) => b.close(r));
    }
  });

  it("rejects a second concurrent login", async () => {
    const { service } = await harness();
    const start = await service.startLogin();
    try {
      await expect(service.startLogin()).rejects.toMatchObject({ code: "codex_login_busy" });
    } finally {
      await service.cancelLogin(start.loginId);
    }
  });

  it("rejects wrong state, missing state and non-callback paths on the real socket", async () => {
    const { service } = await harness();
    const up = fakeUpstream();
    (service as any).options.fetchImpl = up.impl;
    const start = await service.startLogin();
    const port = Number(new URL(start.redirectUri).port);
    const path = start.redirectUri.replace(`http://127.0.0.1:${port}`, "");
    const hit = (qs: string, p = path) => new Promise<number>((resolve, reject) => {
      const req = get({ host: "127.0.0.1", port, path: `${p}?${qs}` }, (res) => { res.resume(); resolve(res.statusCode!); });
      req.on("error", reject);
    });

    expect(await hit("state=wrong&code=c")).toBe(400);
    expect(await hit("code=c")).toBe(400);
    expect(await hit(`state=${"y".repeat(24)}&code=c`)).toBe(400);
    expect(await hit("state=x", "/other")).toBe(404);
    await service.cancelLogin(start.loginId);
    // No exchange was ever launched.
    expect(up.calls.filter((c) => c.includes("/oauth/token"))).toEqual([]);
  });

  it("one callback only: a replayed code never reaches the exchange", async () => {
    const { service } = await harness();
    const up = fakeUpstream();
    (service as any).options.fetchImpl = up.impl;
    const start = await service.startLogin();
    const port = Number(new URL(start.redirectUri).port);
    const path = start.redirectUri.replace(`http://127.0.0.1:${port}`, "");
    const state = new URL(start.url).searchParams.get("state")!;
    const hit = () => new Promise<number>((resolve, reject) => {
      const req = get({ host: "127.0.0.1", port, path: `${path}?state=${state}&code=the-code` }, (res) => {
        res.resume(); resolve(res.statusCode!);
      });
      req.on("error", reject);
    });
    expect(await hit()).toBe(200);
    expect(await hit()).toBe(400); // replay rejected
    const poll = await service.pollLogin(start.loginId);
    expect(poll.status).toBe("connected");
    const exchanges = up.calls.filter((c) => c.includes("/oauth/token"));
    expect(exchanges.length).toBe(1);
  });

  it("cancel is immediate, poll reports the cancelled terminal state, and a new login may start", async () => {
    const { service } = await harness();
    const start = await service.startLogin();
    await service.cancelLogin(start.loginId);
    expect((await service.pollLogin(start.loginId)).status).toBe("cancelled");
    const again = await service.startLogin();
    await service.cancelLogin(again.loginId);
  });

  it("expires on TTL and never starts an exchange", async () => {
    const clock = { t: Date.now() };
    const h = await harness();
    (h.service as any).options.now = () => clock.t;
    const up = fakeUpstream();
    (h.service as any).options.fetchImpl = up.impl;
    const start = await h.service.startLogin();
    clock.t += 11 * 60 * 1000; // past TTL
    const poll = await h.service.pollLogin(start.loginId);
    expect(poll.status).toBe("expired");
    expect(up.calls.filter((c) => c.includes("/oauth/token"))).toEqual([]);
  });

  it("rejects a pasted URL with the wrong path, wrong port or garbage", async () => {
    const busy = createServer();
    await new Promise<void>((r) => busy.listen(1455, "127.0.0.1", r));
    const busy2 = createServer();
    await new Promise<void>((r) => busy2.listen(1457, "127.0.0.1", r));
    const { service } = await harness();
    (service as any).options.fetchImpl = fakeUpstream().impl;
    try {
      const start = await service.startLogin();
      expect(start.mode).toBe("paste");
      const state = new URL(start.url).searchParams.get("state")!;
      expect((await service.submitCallback(start.loginId, "not-a-url")).status).toBe("error");
      expect((await service.submitCallback(start.loginId, `${start.redirectUri}?state=${state}&code=c`))
        .status).toBe("connected");
      const again = await service.startLogin();
      const s = new URL(again.url).searchParams.get("state")!;
      expect((await service.submitCallback(again.loginId, `http://127.0.0.1:9999/auth/callback?state=${s}&code=x`))
        .status).toBe("error");
      expect((await service.submitCallback(again.loginId, `http://127.0.0.1:1455/other?state=${s}&code=x`))
        .status).toBe("error");
      await service.cancelLogin(again.loginId);
    } finally {
      await new Promise((r) => busy.close(r));
      await new Promise((r) => busy2.close(r));
    }
  });
});

// ---------------------------------------------------------------------------
// Full login
// ---------------------------------------------------------------------------

describe("full login", () => {
  it("completes via the real loopback callback and persists 0600 + managed provider", async () => {
    const { service, host, dir } = await harness();
    const up = fakeUpstream();
    (service as any).options.fetchImpl = up.impl;
    const start = await service.startLogin();
    const port = Number(new URL(start.redirectUri).port);
    const path = start.redirectUri.replace(`http://127.0.0.1:${port}`, "");
    const state = new URL(start.url).searchParams.get("state")!;
    const body = await new Promise<string>((resolve, reject) => {
      const req = get({ host: "127.0.0.1", port, path: `${path}?state=${state}&code=the-code` }, (res) => {
        let text = ""; res.on("data", (d) => { text += d; }); res.on("end", () => resolve(text));
      });
      req.on("error", reject);
    });
    expect(body).toContain("Sign-in received");

    const poll = await service.pollLogin(start.loginId);
    expect(poll.status).toBe("connected");
    expect(poll.models).toEqual(["gpt-a", "gpt-c"]); // hide filtered, priority order
    expect(poll.modelCount).toBe(2);

    // Wire encoding: form exchange + client_version model discovery.
    expect(up.calls).toContain("POST https://auth.openai.com/oauth/token");
    expect(up.calls.some((c) => c.startsWith("GET https://chatgpt.com/backend-api/codex/models?client_version=")))
      .toBe(true);

    const data = (await (service as any).store.load())!;
    expect(data.account.accountId).toBe("acct_1");
    expect(data.account.plan).toBe("pro");
    expect(data.account.refreshToken).toBe("rt-1");
    const stat = await fs.stat(join(dir, "codex-credentials.json"));
    expect(stat.mode & 0o777).toBe(0o600);

    // Managed provider upsert; Router untouched.
    const cfg = host.writeConfig.mock.calls[0][0] as any;
    expect(cfg.Router).toEqual({});
    const managed = cfg.Providers.find((p: any) => p.name === CODEX_PROVIDER_NAME);
    expect(managed.api_key).toBe(CODEX_API_KEY);
    expect(managed.transformer.use).toContain(CODEX_TRANSFORMER_NAME);
    expect(managed.models).toEqual(["gpt-a", "gpt-c"]);

    // Redaction: no token material in status.
    const status = await service.getStatus();
    expect(JSON.stringify(status)).not.toContain("rt-1");
    expect(JSON.stringify(status)).not.toContain(data.account.idToken);
    expect(status.status).toBe("connected");
    expect(status.providerName).toBe("codex-subscription");
    expect(status.models).toEqual(["gpt-a", "gpt-c"]);
  });

  it("a failed exchange leaves no credential and no provider", async () => {
    const { service, host } = await harness();
    (service as any).options.fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/oauth/token")) return json({ error: "invalid_grant" }, 400);
      throw new Error("unreachable");
    });
    const start = await service.startLogin();
    const state = new URL(start.url).searchParams.get("state")!;
    await service.submitCallback(start.loginId, `${start.redirectUri}?state=${state}&code=c`);
    const poll = await service.pollLogin(start.loginId);
    expect(poll).toEqual({ status: "error", error: "codex_login_exchange_failed" });
    expect(host.writeConfig).not.toHaveBeenCalled();
    expect((await service.getStatus()).status).toBe("not_connected");
  });

  it("model discovery failure does not fail the login (no static table)", async () => {
    const { service } = await harness();
    (service as any).options.fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/oauth/token")) {
        return json({ id_token: freshIdToken(), access_token: accessTokenFor(), refresh_token: "rt-1" });
      }
      return new Response("boom", { status: 503 });
    });
    const start = await service.startLogin();
    const state = new URL(start.url).searchParams.get("state")!;
    await service.submitCallback(start.loginId, `${start.redirectUri}?state=${state}&code=c`);
    const poll = await service.pollLogin(start.loginId);
    expect(poll.status).toBe("connected");
    expect(poll.modelCount).toBe(0);
  });

  it("config writes keep Router and unrelated providers byte-identical", async () => {
    const h = await connected({ config: {
      Providers: [
        { name: "codex", api_key: "sk-user", models: ["user-model"], transformer: { use: ["openai"] } },
        { name: "anthropic", api_key: "sk-other" },
      ],
      Router: { default: "anthropic,claude-sonnet", think: "codex,user-model" },
    } });
    const cfg = h.config();
    expect(cfg.Providers[0]).toEqual({
      name: "codex", api_key: "sk-user", models: ["user-model"], transformer: { use: ["openai"] },
    });
    expect(cfg.Providers[1]).toEqual({ name: "anthropic", api_key: "sk-other" });
    expect(cfg.Router).toEqual({ default: "anthropic,claude-sonnet", think: "codex,user-model" });
    const managed = cfg.Providers.find((p: any) => p.name === CODEX_PROVIDER_NAME);
    expect(managed.models).toEqual(["gpt-a", "gpt-c"]);
    expect(JSON.stringify(cfg)).not.toContain("rt-1"); // no secrets in config
  });
});

// ---------------------------------------------------------------------------
// Refresh discipline
// ---------------------------------------------------------------------------

describe("token refresh", () => {
  it("returns the cached access token while the 5-minute lead remains", async () => {
    const h = await connected();
    const before = (h.service as any).options.fetchImpl.mock.calls.length;
    const token = await h.service.getAccessToken();
    expect(token).toMatch(/^ey/);
    expect((h.service as any).options.fetchImpl.mock.calls.length).toBe(before);
  });

  it("refreshes inside the lead window and persists the rotated token before use", async () => {
    const h = await connected({ accessSecs: 240 }); // inside the 5-minute lead
    const token = await h.service.getAccessToken();
    expect(token).toMatch(/^ey/);
    // Rotation was durably persisted BEFORE the token could be used.
    const persisted = (await h.store.load())!;
    expect(persisted.account.refreshToken).toBe("rt-rotated");
  });

  it("single-flights concurrent refreshes (one token POST for many callers)", async () => {
    const h = await connected({ accessSecs: 240 });
    const impl = (h.service as any).options.fetchImpl;
    const before = impl.mock.calls.filter((c: any[]) => String(c[0]).endsWith("/oauth/token")).length;
    const results = await Promise.all([1, 2, 3, 4].map(() => h.service.getAccessToken()));
    expect(new Set(results).size).toBe(1);
    const after = impl.mock.calls.filter((c: any[]) => String(c[0]).endsWith("/oauth/token"));
    expect(after.length - before).toBe(1); // one refresh for four callers
  });

  it("forceTokenRefresh issues exactly one refresh for concurrent callers", async () => {
    const h = await connected();
    const impl = (h.service as any).options.fetchImpl;
    const before = impl.mock.calls.filter((c: any[]) => String(c[0]).endsWith("/oauth/token")).length;
    await Promise.all([h.service.forceTokenRefresh(), h.service.forceTokenRefresh()]);
    const after = impl.mock.calls.filter((c: any[]) => String(c[0]).endsWith("/oauth/token"));
    expect(after.length - before).toBe(1);
  });

  it("a rejected refresh becomes reauth-required, not a silent success", async () => {
    const h = await connected({ refreshStatus: 400, accessSecs: 240 });
    await expect(h.service.getAccessToken()).rejects.toMatchObject({ code: "codex_reauth_required" });
    // The stored refresh token is unchanged (nothing was rotated/lost).
    const persisted = (await h.store.load())!;
    expect(persisted.account.refreshToken).toBe("rt-1");
  });

  it("getAccessToken without a connection is a stable 409", async () => {
    const { service } = await harness();
    await expect(service.getAccessToken()).rejects.toMatchObject({ code: "codex_not_connected" });
  });
});

// ---------------------------------------------------------------------------
// Models / usage / rate limits / cooling / disconnect
// ---------------------------------------------------------------------------

describe("models, usage, rate limits", () => {
  it("getModelInstructions is a stable synchronous cache read", async () => {
    const { service } = await connected();
    expect(service.getModelInstructions("gpt-a")).toBe("INSTRUCTIONS-A");
    expect(service.getModelInstructions("gpt-c")).toBe("INSTRUCTIONS-C");
    expect(service.getModelInstructions("gpt-b")).toBeUndefined(); // hidden upstream
    expect(service.getModelInstructions("gpt-a")).toBe("INSTRUCTIONS-A"); // same again
    expect(service.getModelInstructions("nope")).toBeUndefined();
  });

  it("syncModels rewrites the model list and clears lastError", async () => {
    const h = await connected();
    (h.service as any).options.fetchImpl = fakeUpstream().impl;
    const result = await h.service.syncModels();
    expect(result).toEqual({ success: true, models: ["gpt-a", "gpt-c"], modelCount: 2 });
    const last = h.host.writeConfig.mock.calls.at(-1)![0] as any;
    expect(last.Providers.find((p: any) => p.name === CODEX_PROVIDER_NAME).models).toEqual(["gpt-a", "gpt-c"]);
  });

  it("syncModels without a connection is a stable 409", async () => {
    const { service } = await harness();
    await expect(service.syncModels()).rejects.toMatchObject({ code: "codex_not_connected" });
  });

  it("getUsage reads wham once a minute and returns null when not connected", async () => {
    const { service } = await connected();
    const usage = await service.getUsage();
    expect(usage).toEqual({
      plan: "pro", primary: { usedPercent: 5, windowSeconds: 18000, resetAt: expect.any(Number) },
    });
    const fresh = await harness();
    expect(await fresh.service.getUsage()).toBeNull();
  });

  it("noteRateLimits stores, cools on saturation and clears a benign observation", async () => {
    const { service } = await connected();
    const resetAt = Date.now() + 3_600_000;
    await service.noteRateLimits({
      primary: { usedPercent: 100, windowSeconds: 18000, resetAt },
      observedAt: Date.now(), source: "sse",
    });
    const stored = await service.getRateLimits();
    expect(stored!.primary!.resetAt).toBe(resetAt);
    expect(stored!.source).toBe("sse");
    expect(await service.isAccountCooling()).toBe(true);
    expect((await service.getStatus()).coolingUntil).toBe(resetAt);

    await service.noteRateLimits({
      primary: { usedPercent: 10, windowSeconds: 18000, resetAt: Date.now() + 1000 },
      observedAt: Date.now(), source: "headers",
    });
    expect(await service.isAccountCooling()).toBe(false);

    // Garbage never throws and never overwrites the last good observation.
    await service.noteRateLimits({ observedAt: Date.now(), source: "nope" } as any);
    const still = await service.getRateLimits();
    expect(still!.source).toBe("headers");
  });

  it("noteUpstreamError persists a stable code and cooling, kept separate from rate limits", async () => {
    const { service } = await connected();
    await service.noteUpstreamError({
      code: "codex_usage_limit", message: "x", httpStatus: 429, cooldownMs: 60_000,
    });
    const data = (await (service as any).store.load())!;
    expect(data.account.lastError).toEqual({ code: "codex_usage_limit" });
    expect(data.account.rateLimitCooldownUntil).toBeNull(); // channels not merged
    expect(await service.isAccountCooling()).toBe(true);
    expect((await service.getStatus()).lastError).toContain("usage limit");

    // Unknown codes are ignored rather than persisted.
    await service.noteUpstreamError({ code: "whatever", message: "x", httpStatus: 500 });
    expect((await (service as any).store.load())!.account.lastError!.code).toBe("codex_usage_limit");
  });

  it("disconnect removes the provider + credentials but leaves Router and user providers alone", async () => {
    const h = await connected({ config: {
      Providers: [{ name: CODEX_PROVIDER_NAME, api_key: CODEX_API_KEY }],
      Router: { default: "codex-subscription,gpt-a" },
    } });
    await h.service.disconnect();
    expect(await h.store.load()).toBeNull();
    const last = h.host.writeConfig.mock.calls.at(-1)![0] as any;
    expect(last.Providers.some((p: any) => p.name === CODEX_PROVIDER_NAME)).toBe(false);
    expect(last.Router).toEqual({ default: "codex-subscription,gpt-a" }); // untouched
    expect((await h.service.getStatus()).status).toBe("not_connected");
  });

  it("status is not_connected and redacted with no account", async () => {
    const { service } = await harness();
    const status = await service.getStatus();
    expect(status).toMatchObject({ status: "not_connected", providerName: "codex-subscription", models: [] });
  });

  it("pollLogin rejects an unknown or malformed loginId", async () => {
    const { service } = await harness();
    expect(await service.pollLogin("nope")).toEqual({ status: "error", error: "codex_login_state_rejected" });
    expect(await service.pollLogin("z".repeat(32))).toEqual({ status: "error", error: "codex_login_state_rejected" });
  });

  it("dispose frees the login slot without a hang", async () => {
    const { service } = await harness();
    const start = await service.startLogin();
    await service.dispose();
    expect((await service.pollLogin(start.loginId)).status).toBe("cancelled");
  });
});
