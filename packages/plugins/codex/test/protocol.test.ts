/**
 * Codex subscription protocol tests — pure helpers, OAuth wire encoding,
 * JWT claims, dynamic models/usage parsing, error taxonomy, config
 * protection. All upstream calls go through an injected fake fetch:
 * NO network, NO real endpoints.
 */
import { describe, expect, it, vi } from "vitest";
import {
  CODEX_API_KEY,
  CODEX_BACKEND_BASE,
  CODEX_CALLBACK_PORTS,
  CODEX_DEFAULT_CLIENT_ID,
  CODEX_LOGIN_SCOPES,
  CODEX_PROVIDER_NAME,
  CODEX_REFRESH_SCOPE,
  CODEX_TRANSFORMER_NAME,
  classifyCodexError,
  buildCodexAuthorizeUrl,
  createCodexPkce,
  epochMs,
  exchangeCodexCode,
  fetchCodexModels,
  fetchCodexUsage,
  isCodexManagedConfigProvider,
  isCodexRuntime,
  lockCodexProvider,
  parseCodexModels,
  parseCodexUsage,
  protectCodexConfig,
  rateLimitsSaturated,
  readCodexIdClaims,
  refreshCodexTokens,
  safeEqualState,
  selectCodexModels,
} from "../src/protocol";

// --- JWT fixture (none of these tokens are real) ---
function jwt(claims: Record<string, any>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256", typ: "JWT" })}.${b64(claims)}.sig`;
}
const nowSec = Math.floor(Date.now() / 1000);
const idToken = jwt({
  email: "codex@example.invalid",
  "https://api.openai.com/auth": { chatgpt_account_id: "acct_123", chatgpt_plan_type: "pro" },
});
const accessToken = jwt({ exp: nowSec + 3600 });
const ACCESS_EXP = (nowSec + 3600) * 1000;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("pkce + authorize url", () => {
  it("creates an S256 pair from 48 random bytes with no base64 padding", () => {
    const { verifier, challenge } = createCodexPkce(() => "x".repeat(48));
    expect(verifier).toBe("x".repeat(48));
    const expected = require("node:crypto").createHash("sha256").update(verifier).digest("base64url");
    expect(challenge).toBe(expected);
    expect(challenge).not.toMatch(/=/);
    const real = createCodexPkce();
    expect(real.verifier.length).toBeGreaterThan(48);
    expect(real.verifier).not.toBe(createCodexPkce().verifier);
  });

  it("builds the official authorize URL on 127.0.0.1 with exact parameters", () => {
    const url = new URL(buildCodexAuthorizeUrl({
      redirectUri: "http://127.0.0.1:1455/auth/callback",
      state: "st-xyz",
      codeChallenge: "ch-abc",
    }));
    expect(url.origin + url.pathname).toBe("https://auth.openai.com/oauth/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(CODEX_DEFAULT_CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:1455/auth/callback");
    expect(url.searchParams.get("scope")).toBe(CODEX_LOGIN_SCOPES);
    expect(url.searchParams.get("state")).toBe("st-xyz");
    expect(url.searchParams.get("code_challenge")).toBe("ch-abc");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("id_token_add_organizations")).toBe("true");
    expect(url.searchParams.get("codex_cli_simplified_flow")).toBe("true");
    expect(url.searchParams.get("originator")).toBe("codex_cli_rs");
  });

  it("ports are exactly the official allow-listed pair in order", () => {
    expect([...CODEX_CALLBACK_PORTS]).toEqual([1455, 1457]);
  });
});

describe("oauth token wire calls", () => {
  it("exchanges the code with a FORM body and parses all three tokens", async () => {
    const seen: { url: string; init: any }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: any) => {
      seen.push({ url, init });
      return json({ id_token: idToken, access_token: accessToken, refresh_token: "rt-1" });
    });
    const tokens = await exchangeCodexCode({
      code: "auth-code", codeVerifier: "ver", redirectUri: "http://127.0.0.1:1455/auth/callback", fetchImpl,
    });
    expect(tokens).toEqual({ idToken, accessToken, refreshToken: "rt-1" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(seen[0].url).toBe("https://auth.openai.com/oauth/token");
    expect(seen[0].init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(seen[0].init.body);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("auth-code");
    expect(form.get("redirect_uri")).toBe("http://127.0.0.1:1455/auth/callback");
    expect(form.get("client_id")).toBe(CODEX_DEFAULT_CLIENT_ID);
    expect(form.get("code_verifier")).toBe("ver");
  });

  it("refreshes with a JSON body and the reduced scope", async () => {
    const seen: any[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: any) => {
      seen.push({ url, init });
      return json({ id_token: idToken, access_token: "at-2", refresh_token: "rt-2" });
    });
    const tokens = await refreshCodexTokens({ refreshToken: "rt-1", fetchImpl });
    expect(tokens.refreshToken).toBe("rt-2");
    expect(seen[0].init.headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(seen[0].init.body);
    expect(body).toEqual({
      client_id: CODEX_DEFAULT_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: "rt-1",
      scope: CODEX_REFRESH_SCOPE,
    });
  });

  it("classifies a 400 invalid_grant exchange as reauth, other failures as upstream error", async () => {
    const reauth = vi.fn(async () => json({ error: "invalid_grant" }, 400));
    await expect(exchangeCodexCode({
      code: "c", codeVerifier: "v", redirectUri: "r", fetchImpl: reauth,
    })).rejects.toMatchObject({ code: "codex_reauth_required", statusCode: 401 });

    const boom = vi.fn(async () => new Response("gateway timeout", { status: 502 }));
    await expect(exchangeCodexCode({
      code: "c", codeVerifier: "v", redirectUri: "r", fetchImpl: boom,
    })).rejects.toMatchObject({ code: "codex_upstream_error" });

    const reused = vi.fn(async () => json({ error: "refresh_token_reused" }, 401));
    await expect(refreshCodexTokens({ refreshToken: "x", fetchImpl: reused }))
      .rejects.toMatchObject({ code: "codex_reauth_required" });
  });
});

describe("id token claims / jwt", () => {
  it("reads account id and plan from the nested claim and plan passes through verbatim", () => {
    const claims = readCodexIdClaims(idToken, accessToken);
    expect(claims.accountId).toBe("acct_123");
    expect(claims.plan).toBe("pro");
    expect(claims.email).toBe("codex@example.invalid");
    expect(claims.accessExp).toBe(ACCESS_EXP);
  });

  it("tolerates malformed tokens without inventing values", () => {
    const claims = readCodexIdClaims("not-a-jwt", "also-not");
    expect(claims).toEqual({ accountId: "", plan: "", email: "", accessExp: undefined });
  });

  it("compares state timing-safe and rejects length mismatch", () => {
    expect(safeEqualState("abc", "abc")).toBe(true);
    expect(safeEqualState("abc", "abd")).toBe(false);
    expect(safeEqualState("abc", "abcd")).toBe(false);
  });
});

describe("dynamic models", () => {
  const raw = [
    { slug: "gpt-x", display_name: "X", visibility: "visible", priority: 20,
      model_messages: { instructions_template: "template x" } },
    { slug: "gpt-hidden", display_name: "Hidden", visibility: "hide", priority: 1 },
    { slug: "gpt-y", display_name: "Y", visibility: "listed", priority: 10, base_instructions: "base y" },
    { slug: "gpt-z" },
  ];

  it("filters hide and sorts by priority with stable tie handling", () => {
    const models = selectCodexModels(parseCodexModels(raw));
    expect(models.map((m) => m.slug)).toEqual(["gpt-y", "gpt-x", "gpt-z"]);
    expect(models[0].instructions).toBe("base y");
    expect(models[1].instructions).toBe("template x");
  });

  it("accepts {models:[…]} and {models:{slug:{…}}} envelopes and drops garbage slugs", () => {
    expect(parseCodexModels({ models: raw }).length).toBe(4);
    const object = parseCodexModels({ models: { "gpt-a": { visibility: "visible" }, "gpt-b": {} } });
    expect(object.map((m) => m.slug)).toEqual(["gpt-a", "gpt-b"]);
    expect(parseCodexModels(null)).toEqual([]);
    expect(parseCodexModels({ models: [{ slug: "bad\nslug" }] })).toEqual([]);
  });

  it("fetches with client_version + management headers and no static table", async () => {
    const seen: any[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: any) => {
      seen.push({ url, init });
      return json({ models: raw });
    });
    const models = await fetchCodexModels({
      accessToken: "at", accountId: "acct_1", fetchImpl, version: "9.9.9",
    });
    expect(seen[0].url).toBe(`${CODEX_BACKEND_BASE}/models?client_version=9.9.9`);
    expect(seen[0].init.headers.Authorization).toBe("Bearer at");
    expect(seen[0].init.headers["chatgpt-account-id"]).toBe("acct_1");
    expect(models.map((m) => m.slug)).toEqual(["gpt-y", "gpt-x", "gpt-z"]);
  });
});

describe("wham usage", () => {
  it("parses plan + primary/secondary windows, normalising unix-second reset_at to ms", () => {
    const usage = parseCodexUsage({
      plan_type: "pro",
      rate_limit: {
        primary_window: { used_percent: 42, limit_window_seconds: 18000, reset_at: nowSec + 18000 },
        secondary_window: { used_percent: 10, limit_window_seconds: 604800, reset_at: nowSec + 604800 },
      },
    })!;
    expect(usage.plan).toBe("pro");
    expect(usage.primary).toEqual({ usedPercent: 42, windowSeconds: 18000, resetAt: (nowSec + 18000) * 1000 });
    expect(usage.secondary!.usedPercent).toBe(10);
  });

  it("returns null for empty/garbage payloads", () => {
    expect(parseCodexUsage({})).toBeNull();
    expect(parseCodexUsage("nope")).toBeNull();
  });

  it("getUsage wire call never throws on non-200 and returns null", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 404 }));
    await expect(fetchCodexUsage({ accessToken: "at", fetchImpl })).resolves.toBeNull();
    const ok = vi.fn(async () => json({ plan_type: "free", rate_limit: {
      primary_window: { used_percent: 1, limit_window_seconds: 60, reset_at: nowSec + 60 },
    } }));
    const usage = await fetchCodexUsage({ accessToken: "at", fetchImpl: ok });
    expect(usage?.plan).toBe("free");
  });

  it("rateLimitsSaturated keys off 100% + a live reset", () => {
    const mk = (p: any): any => ({ observedAt: Date.now(), source: "headers", primary: p });
    expect(rateLimitsSaturated(mk({ usedPercent: 100, resetAt: Date.now() + 1000 }), Date.now())).toBe(true);
    expect(rateLimitsSaturated(mk({ usedPercent: 99, resetAt: Date.now() + 1000 }), Date.now())).toBe(false);
    expect(rateLimitsSaturated(mk({ usedPercent: 100, resetAt: Date.now() - 1 }), Date.now())).toBe(false);
  });
});

describe("error taxonomy", () => {
  it("usage_limit_reached with resets_at becomes a bounded cooldown", () => {
    const resetSec = nowSec + 3600;
    const info = classifyCodexError(429, { error: { type: "usage_limit_reached", resets_at: resetSec } })!;
    expect(info.code).toBe("codex_usage_limit");
    expect(info.httpStatus).toBe(429);
    expect(info.cooldownMs).toBeGreaterThan(3_500_000);
  });

  it("maps 401 / plain 429 / 5xx / 4xx", () => {
    expect(classifyCodexError(401, { error: { type: "invalid_request" } })!.code).toBe("codex_reauth_required");
    const rl = classifyCodexError(429, { error: { type: "too_many_requests" } })!;
    expect(rl.code).toBe("codex_rate_limited");
    expect(rl.retryable).toBe(true);
    expect(classifyCodexError(503, "")!.code).toBe("codex_overloaded");
    expect(classifyCodexError(400, { error: { type: "bad" } })!.code).toBe("codex_request_rejected");
    expect(classifyCodexError(200, {})).toBeNull();
  });

  it("accepts epoch-ms resets_at too", () => {
    const info = classifyCodexError(429, { error: { type: "usage_limit_reached", resets_at: (nowSec + 600) * 1000 } })!;
    expect(info.cooldownMs).toBeGreaterThan(500_000);
  });

  it("epochMs normalises seconds and ignores junk", () => {
    expect(epochMs(100)).toBe(100_000);
    expect(epochMs(100_000_000_000)).toBe(100_000_000_000);
    expect(epochMs("x")).toBeUndefined();
  });
});

describe("config protection", () => {
  const managed = () => ({
    name: CODEX_PROVIDER_NAME,
    api_key: CODEX_API_KEY,
    api_base_url: "https://attacker.example/v1",
    transformer: { use: ["other"] },
    models: ["gpt-y"],
  });

  it("detects and locks the managed entry without touching Router", () => {
    expect(isCodexManagedConfigProvider(managed())).toBe(true);
    expect(isCodexManagedConfigProvider({ name: "codex", api_key: "sk-user" })).toBe(false);
    const locked: any = lockCodexProvider(managed());
    expect(locked.api_base_url).toBe(CODEX_BACKEND_BASE);
    expect(locked.api_key).toBe(CODEX_API_KEY);
    expect(locked.transformer.use).toEqual(["openai-responses", CODEX_TRANSFORMER_NAME]);
  });

  it("protectCodexConfig re-locks, restores by omission, and preserves unrelated providers + Router", () => {
    const prev = {
      Providers: [managed(), { name: "codex", api_key: "sk-user", models: ["x"] }, { name: "anthropic" }],
      Router: { default: "anthropic,claude", think: "codex,gpt-x", models: { a: "codex,gpt-x" } },
    };
    const next = {
      Providers: [
        { ...managed(), api_base_url: "https://evil", models: ["gpt-y"] },
        { name: "codex", api_key: "sk-user", models: ["x"] },
        { name: "anthropic" },
      ],
      Router: structuredClone(prev.Router),
    };
    protectCodexConfig(next, prev);
    expect((next.Providers[0] as any).api_base_url).toBe(CODEX_BACKEND_BASE);
    expect(next.Providers[1]).toEqual({ name: "codex", api_key: "sk-user", models: ["x"] }); // user provider untouched
    expect(next.Providers[2]).toEqual({ name: "anthropic" });
    expect(next.Router).toEqual(prev.Router);

    // Deletion by omission is repaired.
    const stripped = { Providers: [{ name: "anthropic" }], Router: {} };
    protectCodexConfig(stripped, prev);
    expect(stripped.Providers.some((p: any) => p.name === CODEX_PROVIDER_NAME)).toBe(true);
    expect((stripped.Providers.find((p: any) => p.name === CODEX_PROVIDER_NAME) as any).api_base_url)
      .toBe(CODEX_BACKEND_BASE);
  });

  it("isCodexRuntime recognises managed runtime but never a plain user codex provider", () => {
    expect(isCodexRuntime({ name: CODEX_PROVIDER_NAME, apiKey: CODEX_API_KEY })).toBe(true);
    expect(isCodexRuntime({ name: "codex", apiKey: "sk-user" })).toBe(false);
    expect(isCodexRuntime({
      name: "whatever",
      baseUrl: `${CODEX_BACKEND_BASE}/v1`,
      transformer: { use: ["openai-responses", CODEX_TRANSFORMER_NAME] },
    })).toBe(true);
  });
});
