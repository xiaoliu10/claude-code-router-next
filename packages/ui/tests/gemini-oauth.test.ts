import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
const readJson = (lang: string) => JSON.parse(readFileSync(new URL(`../src/locales/${lang}.json`, import.meta.url), "utf8"));
const en = readJson("en");
const zh = readJson("zh");
const card = readFileSync(new URL("../../plugins/gemini-oauth/src/card-entry.ts", import.meta.url), "utf8");
const utils = root("utils/gemini-oauth.ts");
const settingsPage = root("components/SettingsPage.tsx");
const providers = root("components/Providers.tsx");

// Frozen consent copy from docs/design/gemini-provider-contract.md §2. Both
// translations are byte-for-byte the contract text: softening either one fails.
const RISK_EN = "Using a third-party tool with a Google subscription to reach Antigravity breaches its terms. Google may suspend the account (first offenses can be appealed via Google's form; a second violation is permanent). Only use an account you can afford to lose. Continue?";
const RISK_ZH = "「使用第三方工具以 Google 账号订阅访问 Antigravity 违反其服务条款，Google 可能封停该账号（首次可通过官方表单申诉恢复，再次违规将永久封禁）。请只使用你可以承受损失的账号。是否继续？」";

const storage = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => storage.get(key) || null,
    removeItem: (key: string) => storage.delete(key),
    setItem: (key: string, value: string) => storage.set(key, value),
  },
  window: { location: { search: "" }, dispatchEvent: () => {} },
});
const { default: ApiClient } = await import("../src/lib/api.ts");
const {
  GEMINI_OAUTH_MARKER_KEY, GEMINI_OAUTH_PROVIDER_NAME, formatGeminiOauthClock, geminiOauthErrorKey,
  geminiOauthStateKey, geminiOauthStatusErrorKey, geminiOauthUsable, isGeminiOauthKind, isManagedGeminiOauth,
  mergeGeminiOauthProvider, safeValidationUrl, GEMINI_OAUTH_RISK_KEY,
} = await import("../src/utils/gemini-oauth.ts");
const {
  GEMINI_OAUTH_LOGIN_DEADLINE_MS, GEMINI_OAUTH_POLL_INTERVAL_MS, createGeminiOauthLogin, isSafeConsentUrl,
} = await import("../src/utils/gemini-oauth-login.ts");

type Start = { loginId: string; url: string; expiresAt: number };
const job = (overrides: Partial<Start> = {}): Start => ({
  loginId: "mock-login",
  url: "https://accounts.google.com/o/oauth2/v2/auth?state=mock",
  expiresAt: Date.now() + 60_000,
  ...overrides,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

// ---------------------------------------------------------------------------
// 1. Consent gate — risk confirmation strictly precedes login/start
// ---------------------------------------------------------------------------

test("risk consent is frozen verbatim in both locales and carries the permanent wording", () => {
  assert.equal(en.geminiOauth.risk, RISK_EN);
  assert.equal(zh.geminiOauth.risk, RISK_ZH);
  // The two keywords the contract calls out explicitly.
  assert.match(zh.geminiOauth.risk, /永久/);
  assert.match(en.geminiOauth.risk, /permanent/);
  // Neither language may be softened away from a hard warning.
  assert.match(zh.geminiOauth.risk, /封停|封禁/);
  assert.match(en.geminiOauth.risk, /suspend/);
  assert.match(zh.geminiOauth.risk, /服务条款/);
  assert.match(en.geminiOauth.risk, /terms/);
  assert.equal(GEMINI_OAUTH_RISK_KEY, "geminiOauth.risk");
});

test("the plugin card risk gate is acknowledged before login, and never starts on mount", () => {
  assert.match(card, /dialog\(t\("risk_title"\), t\("risk"\)\)/);
  assert.match(card, /if \(consentAck\) void run\("login"\)/);
  assert.match(card, /disabled \|\| !consentAck/);
  assert.equal((card.match(/run\("login"\)/g) || []).length, 1);
  assert.match(card, /Only local status on mount/);
});

test("an attempt cancelled before start returns never issues a start request", async () => {
  // The card only instantiates a session inside run("login"), i.e. from the
  // confirmed dialog action; an already-cancelled attempt must not touch the
  // server at all (no start, no poll, no cancel).
  let starts = 0; let polls = 0; let cancels = 0;
  const session = createGeminiOauthLogin({
    startGeminiOauthLogin: async () => { starts++; return job(); },
    pollGeminiOauthLogin: async () => { polls++; return { status: "pending" }; },
    cancelGeminiOauthLogin: async () => { cancels++; return { ok: true }; },
  });
  await session.cancel();
  assert.equal(await session.done, null);
  assert.equal(starts, 0); assert.equal(polls, 0); assert.equal(cancels, 0);
  // And the component creates no session outside the confirmed action.
  assert.equal((card.match(/createGeminiOauthLogin\(/g) || []).length, 1, "exactly one session factory call site");
  assert.ok(card.indexOf('createGeminiOauthLogin(') > card.indexOf('const run = async (kind:'));
});

test("an unmounted or dismissed plugin card cannot open a late consent window", () => {
  assert.match(card, /consentGranted = true;/);
  assert.match(card, /if \(!alive \|\| !consentGranted\)/);
  assert.match(card, /void current\.cancel\(\)\.catch/);
  assert.match(card, /consentGranted = false;/);
  assert.deepEqual(card.match(/window\.open\([^)]*\)/g), ['window.open(value.url, "_blank", "noopener,noreferrer")']);
});

// ---------------------------------------------------------------------------
// 2. Poll loop — 2s interval, 10min cap, converges, stops on cancel
// ---------------------------------------------------------------------------

test("poll interval and hard cap match the frozen contract values", () => {
  assert.equal(GEMINI_OAUTH_POLL_INTERVAL_MS, 2_000);
  assert.equal(GEMINI_OAUTH_LOGIN_DEADLINE_MS, 600_000);
});

test("polling converges pending → success and stops issuing polls", async () => {
  let polls = 0;
  let gap = 0;
  const ready: Start[] = [];
  const session = createGeminiOauthLogin({
    startGeminiOauthLogin: async () => job(),
    pollGeminiOauthLogin: async (_id, signal) => {
      assert.equal(signal.aborted, false);
      polls++;
      if (polls < 3) { await new Promise(resolve => setTimeout(resolve, 2)); return { status: "pending" }; }
      return { status: "success", email: "user@example.test" };
    },
    cancelGeminiOauthLogin: async () => { gap++; return { ok: true }; },
  }, value => ready.push(value), { intervalMs: 1, deadlineMs: 5_000 });
  assert.equal(await session.done, "user@example.test");
  assert.equal(polls, 3);
  assert.equal(ready.length, 1);
  assert.equal(ready[0].url, job().url);
  assert.match(card, /setToast|toast/);
});

test("cancel stops polling immediately, aborts the signal and invalidates once", async () => {
  const pendingSignal = deferred<AbortSignal>();
  const inFlight = deferred<{ status: "success"; email: string }>();
  let polls = 0;
  let cancels = 0;
  const session = createGeminiOauthLogin({
    startGeminiOauthLogin: async () => job(),
    pollGeminiOauthLogin: async (_id, signal) => {
      polls++;
      pendingSignal.resolve(signal);
      return inFlight.promise;
    },
    cancelGeminiOauthLogin: async id => { assert.equal(id, "mock-login"); cancels++; return { ok: true }; },
  }, () => {}, { intervalMs: 1, deadlineMs: 60_000 });
  const signal = await pendingSignal.promise;
  await session.cancel();
  assert.equal(signal.aborted, true);
  inFlight.resolve({ status: "success", email: "late@example.test" });
  // A cancelled attempt reports null even if the late reply says success.
  assert.equal(await session.done, null);
  assert.equal(polls, 1, "no further poll after cancel");
  assert.equal(cancels, 1);
  // The card wires its Cancel button to the session's cancel.
  assert.match(card, /session\?\.cancel\(\)/);
});

test("the deadline caps an endless pending loop and the job is invalidated", async () => {
  let polls = 0;
  let cancels = 0;
  const session = createGeminiOauthLogin({
    startGeminiOauthLogin: async () => job({ expiresAt: Date.now() + 3_600_000 }),
    pollGeminiOauthLogin: async () => { polls++; return { status: "pending" }; },
    cancelGeminiOauthLogin: async () => { cancels++; return { ok: true }; },
  }, () => {}, { intervalMs: 1, deadlineMs: 25 });
  await assert.rejects(session.done, { reason: "gemini_oauth_login_state_rejected" });
  assert.ok(polls > 0, "polled at least once");
  assert.equal(cancels, 1);
});

test("a failed poll surfaces its code and stops looping", async () => {
  let polls = 0;
  const session = createGeminiOauthLogin({
    startGeminiOauthLogin: async () => job(),
    pollGeminiOauthLogin: async () => { polls++; return { status: "failed", error: "gemini_oauth_login_persist_failed" }; },
    cancelGeminiOauthLogin: async () => ({ ok: true }),
  }, () => {}, { intervalMs: 1, deadlineMs: 5_000 });
  await assert.rejects(session.done, { reason: "gemini_oauth_login_persist_failed" });
  assert.equal(polls, 1);
});

test("an unsafe or malformed consent URL never reaches the UI and its job is invalidated", async () => {
  for (const url of ["javascript:alert(1)", "data:text/html,<script>", "file:///etc/passwd", ""]) {
    let cancels = 0;
    const session = createGeminiOauthLogin({
      startGeminiOauthLogin: async () => job({ url }),
      pollGeminiOauthLogin: async () => assert.fail("unsafe job polled"),
      cancelGeminiOauthLogin: async () => { cancels++; return { ok: true }; },
    }, () => assert.fail("unsafe link displayed"), { intervalMs: 1, deadlineMs: 1_000 });
    await assert.rejects(session.done);
    assert.equal(cancels, 1);
  }
  assert.equal(isSafeConsentUrl("https://accounts.google.com/x"), true);
  assert.equal(isSafeConsentUrl("http://127.0.0.1:9999/oauth-callback"), true);
  assert.equal(isSafeConsentUrl("http://evil.example/x"), false);
});

// ---------------------------------------------------------------------------
// 3. Status rendering — one state per contract status shape
// ---------------------------------------------------------------------------

const base = { configured: true, connected: true, kind: "antigravity" as const, email: "a@b.c", project: "proj-1", tier: "free-tier", modelsCount: 3 };

test("status states map to distinct renderable keys", () => {
  const now = 1_000_000;
  assert.equal(geminiOauthStateKey(null), "loading");
  assert.equal(geminiOauthStateKey({ configured: false, connected: false, kind: "antigravity" }), "not_connected");
  assert.equal(geminiOauthStateKey(base, now), "connected");
  assert.equal(geminiOauthStateKey({ ...base, cooldownUntil: now + 60_000 }, now), "cooldown");
  assert.equal(geminiOauthStateKey({ ...base, cooldownUntil: now - 60_000 }, now), "connected");
  assert.equal(geminiOauthStateKey({ ...base, lastError: { code: "gemini_oauth_quota_exceeded" } }, now), "error");
  assert.equal(geminiOauthStateKey({ ...base, lastError: { code: "gemini_oauth_reauth_required" } }, now), "needs_relogin");
  assert.equal(geminiOauthStateKey({ configured: false, connected: false, kind: "antigravity", lastError: { code: "gemini_oauth_reauth_required" } }), "needs_relogin");
  assert.equal(geminiOauthUsable(base, now), true);
  assert.equal(geminiOauthUsable({ ...base, cooldownUntil: now + 1 }, now), false);
  // Every state has a locale string in both languages.
  for (const state of ["loading", "not_connected", "connected", "cooldown", "needs_relogin", "error"]) {
    assert.ok(en.geminiOauth.status[state], `en status.${state}`);
    assert.ok(zh.geminiOauth.status[state], `zh status.${state}`);
  }
  // The card renders the four data rows only when connected, and the badge always.
  assert.match(card, /const state = loading \? "loading"/);
  assert.match(card, /if \(connected\)/);
  for (const label of ["email", "project", "tier", "models"]) assert.ok(en.geminiOauth.labels[label]);
  assert.match(card, /t\("models_count", \{ count: status\?\.modelsCount \?\? 0 \}\)/);
  assert.match(card, /t\("cooldown_until", \{ time: cooldown \}\)/);
  assert.ok(formatGeminiOauthClock(null, "en") === null);
  assert.ok(typeof formatGeminiOauthClock(now, "en") === "string");
});

test("error codes are allowlisted, localised and never rendered raw", () => {
  assert.equal(geminiOauthErrorKey({ reason: "gemini_oauth_quota_exceeded" }), "gemini_oauth_quota_exceeded");
  assert.equal(geminiOauthErrorKey("gemini_oauth_reauth_required"), "gemini_oauth_reauth_required");
  assert.equal(geminiOauthErrorKey({ error: "gemini_oauth_not_connected" }), "gemini_oauth_not_connected");
  // Unknown/raw text (which could contain token material) collapses.
  assert.equal(geminiOauthErrorKey({ reason: "ya29.SECRET-ACCESS-TOKEN" }), "request_failed");
  assert.equal(geminiOauthErrorKey(new Error("boom ya29.SECRET")), "request_failed");
  assert.equal(geminiOauthStatusErrorKey({ ...base, lastError: { code: "gemini_oauth_identity_blocked" } }), "gemini_oauth_identity_blocked");
  assert.equal(geminiOauthStatusErrorKey(base), null);
  // The local save/action mutex has its own localised code too.
  assert.ok(en.geminiOauth.errors.config_busy); assert.ok(zh.geminiOauth.errors.config_busy);
  for (const code of ["gemini_oauth_identity_blocked", "gemini_oauth_validation_required", "gemini_oauth_quota_exceeded",
    "gemini_oauth_reauth_required", "gemini_oauth_upstream_error", "gemini_oauth_not_connected", "gemini_oauth_login_busy",
    "gemini_oauth_name_conflict", "gemini_oauth_login_state_rejected", "gemini_oauth_login_account_failed",
    "gemini_oauth_login_persist_failed", "gemini_oauth_models_fetch_failed", "gemini_oauth_config_write_failed", "request_failed"]) {
    assert.ok(en.geminiOauth.errors[code], `missing en errors.${code}`);
    assert.ok(zh.geminiOauth.errors[code], `missing zh errors.${code}`);
    // Localised copy, never the bare code.
    assert.doesNotMatch(en.geminiOauth.errors[code], /gemini_oauth_/);
    assert.doesNotMatch(zh.geminiOauth.errors[code], /gemini_oauth_/);
  }
  // The identity verdict must say it is not a quota problem (contract §1.6).
  assert.match(en.geminiOauth.errors.gemini_oauth_identity_blocked, /not a quota problem/i);
  assert.match(zh.geminiOauth.errors.gemini_oauth_identity_blocked, /并非额度问题/);
  // validation_url is forwarded but only as an https link.
  assert.equal(safeValidationUrl("https://accounts.google.com/verify?t=1"), "https://accounts.google.com/verify?t=1");
  assert.equal(safeValidationUrl("javascript:alert(1)"), null);
  assert.equal(safeValidationUrl(undefined), null);
});

test("the cooldown line outranks a stale error and the card offers no token surface", () => {
  // Cooldown state message exists and is interpolated.
  assert.match(en.geminiOauth.cooldown_until, /\{\{time\}\}/);
  assert.match(zh.geminiOauth.cooldown_until, /\{\{time\}\}/);
  // The contract guarantees no token field: nothing in either locale or the
  // card mentions token/refresh/access/bearer material.
  const serialized = JSON.stringify(en.geminiOauth) + JSON.stringify(zh.geminiOauth);
  assert.doesNotMatch(serialized, /refresh_?token/i);
  assert.doesNotMatch(serialized, /access_?token/i);
  assert.doesNotMatch(serialized, /ya29\./);
  assert.doesNotMatch(card, /refreshToken|accessToken|Bearer\s|api_key\s*[:=]\s*["'][^"']*token/i);
  // The managed marker key never appears as an editable value either.
  assert.doesNotMatch(card, /ccr-managed-gemini-oauth/);
});

// ---------------------------------------------------------------------------
// 4. Mutations — sync, disconnect double-confirm, no token in any output
// ---------------------------------------------------------------------------

test("disconnect requires a second confirmation and calls the dedicated plugin route", () => {
  assert.match(card, /confirmDisconnect = true/);
  assert.match(card, /if \(confirmDisconnect\)/);
  assert.match(card, /dialog\(t\("disconnect_title"\), t\("disconnect_warning"\)\)/);
  assert.equal((card.match(/run\("disconnect"\)/g) || []).length, 1);
  assert.match(card, /post<any>\("\/disconnect"\)/);
  assert.match(providers, /isManagedGeminiOauth\(config\.Providers\[actualIndex\]\)\) \{ showGeminiOauthManagement\(\); return; \}/);
});

test("sync uses the plugin bridge and reports only the server's model count and Router refs", () => {
  assert.match(card, /post<any>\("\/sync"\)/);
  assert.match(card, /t\("synced_cleared", \{ count, refs: result\.clearedRefs\.join\(", "\) \}\)/);
  assert.match(card, /t\("synced", \{ count \}\)/);
  assert.match(card, /result\?\.ok !== true/);
  assert.match(card, /await readStatus\(\)/);
  assert.match(en.geminiOauth.synced, /\{\{count\}\}/);
  assert.match(zh.geminiOauth.synced, /\{\{count\}\}/);
  assert.match(en.geminiOauth.synced_cleared, /\{\{refs\}\}/);
});

test("the managed provider is never editable through the generic dialog (contract D7)", () => {
  assert.equal(isManagedGeminiOauth({ name: GEMINI_OAUTH_PROVIDER_NAME, api_key: GEMINI_OAUTH_MARKER_KEY, models: [] }), true);
  assert.equal(isManagedGeminiOauth({ name: "gemini-oauth", api_key: GEMINI_OAUTH_MARKER_KEY, gemini_oauth_managed: true, models: [] }), true);
  assert.equal(isManagedGeminiOauth({ name: "gemini-oauth", api_key: "sk-real", gemini_oauth_kind: "antigravity", models: [] }), true);
  // A user provider reusing the name with a real key is not taken over.
  assert.equal(isManagedGeminiOauth({ name: "gemini-oauth", api_key: "sk-user-real-key", models: [] }), false);
  assert.equal(isManagedGeminiOauth({ name: "other", api_key: "sk", models: [] }), false);
  assert.equal(isManagedGeminiOauth(null), false);
  assert.equal(isGeminiOauthKind("antigravity"), true);
  assert.equal(isGeminiOauthKind("gemini-cli"), false, "v1 is antigravity only");
  // Both the edit entry point and the save guard bounce to the card.
  assert.match(providers, /if \(isManagedGeminiOauth\(provider\)\) \{ showGeminiOauthManagement\(\); return; \}/);
  assert.match(providers, /isManagedGeminiOauth\(editingProviderData\) \|\|/);
  assert.match(providers, /geminiOauthManagedNotice: true/);
  assert.match(settingsPage, /location\.state\?\.geminiOauthManagedNotice/);
  // Merging only ever touches the managed entry.
  const local = { Providers: [{ name: "custom", api_key: "sk", api_base_url: "https://x.invalid", models: ["draft"] }], Router: { default: "local,draft" }, customDraft: "keep" };
  const server = { Providers: [{ name: GEMINI_OAUTH_PROVIDER_NAME, api_key: GEMINI_OAUTH_MARKER_KEY, api_base_url: "https://daily-cloudcode-pa.googleapis.com", models: ["gemini-3-pro"], gemini_oauth_managed: true, gemini_oauth_kind: "antigravity" }] };
  const merged = mergeGeminiOauthProvider(local, server);
  assert.deepEqual(merged.Providers.map(provider => provider.name), ["custom", "gemini-oauth"]);
  assert.equal(merged.Router, local.Router);
  assert.equal(merged.customDraft, "keep");
  // Removing it from the server drops it locally, nothing else.
  assert.deepEqual(mergeGeminiOauthProvider(merged, { Providers: [] }).Providers.map(provider => provider.name), ["custom"]);
});

// ---------------------------------------------------------------------------
// 5. API surface — exact routes, bodies, safe failure mapping
// ---------------------------------------------------------------------------

test("api client uses the frozen routes with exact bodies", async () => {
  const client = new ApiClient("/mock-api", "mock-key");
  const original = globalThis.fetch;
  const calls: Array<{ url: string; options?: RequestInit }> = [];
  const payloads: unknown[] = [
    { configured: true, connected: true, kind: "antigravity", email: "a@b.c", project: "p", tier: "t", modelsCount: 2 },
    { loginId: "mock-login", url: "https://accounts.google.com/x", expiresAt: Date.now() + 1_000 },
    { status: "success", email: "a@b.c" },
    { ok: true },
    { ok: true, modelsCount: 4 },
    { ok: true, removedModelRefs: [], defaultFallback: "other,model" },
  ];
  let index = 0;
  globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify(payloads[index++]), { status: 200 });
  }) as typeof fetch;
  try {
    const abort = new AbortController();
    await client.getGeminiOauthStatus();
    await client.startGeminiOauthLogin();
    await client.pollGeminiOauthLogin("mock-login", abort.signal);
    await client.cancelGeminiOauthLogin("mock-login");
    await client.syncGeminiOauthModels();
    await client.disconnectGeminiOauth();
    assert.deepEqual(calls.map(call => call.url), [
      "/mock-api/gemini-oauth/status", "/mock-api/gemini-oauth/login/start", "/mock-api/gemini-oauth/login/poll",
      "/mock-api/gemini-oauth/login/cancel", "/mock-api/gemini-oauth/sync", "/mock-api/gemini-oauth/disconnect",
    ]);
    assert.equal(calls[0].options?.method, "GET");
    for (const call of calls.slice(1)) assert.equal(call.options?.method, "POST");
    assert.deepEqual(calls.slice(2, 4).map(call => JSON.parse(String(call.options?.body))), [{ loginId: "mock-login" }, { loginId: "mock-login" }]);
    assert.equal((calls[0].options?.headers as Record<string, string>)["X-API-Key"], "mock-key");
  } finally {
    globalThis.fetch = original;
  }
});

test("api failures only expose allowlisted codes and never leak server text", async () => {
  const client = new ApiClient("/mock-api", "mock-key");
  const original = globalThis.fetch;
  let payload: unknown = {};
  let status = 200;
  globalThis.fetch = (async () => new Response(JSON.stringify(payload), { status })) as typeof fetch;
  try {
    status = 429;
    payload = { reason: "gemini_oauth_login_busy", message: "ya29.private-token" };
    await assert.rejects(client.startGeminiOauthLogin(), error => {
      assert.equal((error as { reason: string }).reason, "gemini_oauth_login_busy");
      assert.doesNotMatch(String(error), /ya29|private-token/);
      return true;
    });
    // Plugin owns codes; host validates token shape, card allowlists copy.
    payload = { reason: "gemini_oauth_models_fetch_failed", message: "ya29.private-token" };
    await assert.rejects(client.startGeminiOauthLogin(), { reason: "gemini_oauth_models_fetch_failed" });
    // Raw upstream text never becomes a code.
    payload = { error: "ya29.private-token", message: "ya29.private-token" };
    await assert.rejects(client.syncGeminiOauthModels(), { reason: "request_failed" });
    // A network exception is sanitised too.
    globalThis.fetch = (async () => { throw new Error("boom ya29.private-token"); }) as typeof fetch;
    await assert.rejects(client.getGeminiOauthStatus(), error => {
      assert.equal((error as { reason: string }).reason, "request_failed");
      assert.doesNotMatch(String(error), /ya29|private-token/);
      return true;
    });
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// 6. Locale parity + mount point
// ---------------------------------------------------------------------------

test("EN/ZH geminiOauth locale parity", () => {
  const keys = (value: Record<string, unknown>, prefix = ""): string[] =>
    Object.entries(value).flatMap(([key, item]) => (typeof item === "object" && item ? keys(item as Record<string, unknown>, `${prefix}${key}.`) : [`${prefix}${key}`]));
  const enKeys = keys(en.geminiOauth).sort();
  const zhKeys = keys(zh.geminiOauth).sort();
  assert.deepEqual(enKeys, zhKeys);
  for (const key of ["title", "builtin", "experimental", "description", "managed_provider", "managed_notice", "disconnect",
    "disconnect_title", "disconnect_warning", "risk", "risk_title", "risk_ack", "risk_continue", "about", "about_body",
    "no_content_obfuscation", "single_account", "synced", "login_pending", "open_login", "working", "sync", "connect", "reconnect"]) {
    assert.ok(en.geminiOauth[key], `missing en ${key}`);
    assert.ok(zh.geminiOauth[key], `missing zh ${key}`);
  }
  // Disconnect copy must state the Router consequence, never promise safety.
  assert.match(en.geminiOauth.disconnect_warning, /Router/);
  assert.match(zh.geminiOauth.disconnect_warning, /Router/);
  // No-obfuscation stance is stated to the user (design §0.5 red line).
  assert.match(en.geminiOauth.no_content_obfuscation, /never rewrites/i);
  assert.match(zh.geminiOauth.no_content_obfuscation, /不会改写/);
});

test("Settings uses PluginCardArea only and the chunk receives the shared mutex/draft bridge", () => {
  assert.doesNotMatch(settingsPage, /<GeminiOauthProvider/);
  assert.match(settingsPage, /<PluginCardArea disabled=\{isSaving \|\| isRestarting\} onBusyChange=\{setManagedProviderBusy\} focusKey=/);
  assert.equal((settingsPage.match(/\|\| managedProviderBusy\}/g) || []).length, 2);
  assert.match(card, /props\.acquireManagement\(\)/);
  assert.match(card, /props\.refreshConfig/);
  assert.match(card, /mergeGeminiOauthProvider\(current, server\)/);
  assert.match(utils, /export function isManagedGeminiOauth/);
});
