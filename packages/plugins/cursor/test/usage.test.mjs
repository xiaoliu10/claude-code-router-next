// auth.usage tells what magpie's built-in Cursor account shows
// (internal/provider/cursor_usage.go), against Cursor's replies as its tests
// give them (cursor_usage_test.go).
import "./nonet.mjs" // first: no request leaves this machine
import { afterEach, expect, test } from "vitest"
import { CursorAuthPlugin, _internal } from "../src/vendor/engine.mjs"

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

// a token that runs out in an hour
const jwt = (exp) => ["e30", Buffer.from(JSON.stringify({ exp })).toString("base64url"), "sig"].join(".")
const tok = jwt(Math.floor(Date.now() / 1000) + 3600)
const auth = { type: "oauth", access: tok, refresh: "", expires: 0, accountId: "a@b.c" }
// a sign-in of its own, so no plan asked before is remembered for it
let n = 0
const fresh = () => ({ ...auth, access: jwt(Math.floor(Date.now() / 1000) + 7200 + ++n) })

const firstParty = ["grok-4.7@256k", "grok-4.7@500k", "grok-4.6", "grok-4.7-xhigh-fast", "cursor-grok-4.7-high-fast", "cursor-grok-4.6-high-fast", "grok-4.5-fast-high", "auto", "default", "composer-2.5", "COMPOSER-2.5-FAST", "composer"]
const bucketed = ["future-first-party", "grok-4.8-high", "cursor-grok-4.8-xhigh-fast"]
const others = ["claude-opus-5-5@300k", "claude-opus-5-5@1m", "claude-opus-5-5", "gpt-5.6-sol", "gemini-3.1-pro", "grok-3", "grok-4.70", "grok-4.80-high", "unknown-model"]
const provider = { models: Object.fromEntries([...firstParty, ...bucketed, ...others].map((id) => [id, { id }])) }

async function run(a, reply) {
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), method: init.method, headers: init.headers, body: init.body, ...(init.redirect ? { redirect: init.redirect } : {}) })
    const res = await reply(String(url))
    if (String(url) === BOT && res.status === 307 && res.headers.has("Location")) {
      if (init.redirect === "error") throw new TypeError("redirect refused")
      return Response.json(paidBot)
    }
    return res
  }
  const hooks = await CursorAuthPlugin()
  return { u: await hooks.auth.usage(async () => a, provider), seen }
}

// counts is whether a window counts model, as magpie reads the lists
// (internal/provider/plugin_usage.go)
function counts(w, model) {
  const m = model.toLowerCase()
  if (w.models?.length) return w.models.some((x) => x.toLowerCase() === m)
  if (w.notModels?.length) return !w.notModels.some((x) => x.toLowerCase() === m)
  return true
}

const PERIOD = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage"
const PLAN = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo"

test("the period's three windows, reset at the cycle's end", async () => {
  const { u, seen } = await run(auth, (url) =>
    url === PLAN
      ? Response.json({ planInfo: { planName: "Pro" } })
      : Response.json({ billingCycleEnd: "1792833042000", planUsage: { autoPercentUsed: 12.5, apiPercentUsed: 40, totalPercentUsed: 20 } }),
  )
  expect(seen.find((r) => r.url === PERIOD)).toEqual({
    url: PERIOD,
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json", "Connect-Protocol-Version": "1" },
    body: "{}",
  })
  const at = new Date(1792833042000).toISOString()
  expect(u.windows.map(({ models, notModels, ...w }) => w)).toEqual([
    { name: "Cursor Models", used: 12.5, resetsAt: at },
    { name: "Other Models", used: 40, resetsAt: at },
    { name: "Total", used: 20, resetsAt: at, aside: true },
  ])
  expect(u.error).toBeUndefined()
})

test("the card names the plan as cursor-agent about does (GetPlanInfo's planName), asked once an hour", async () => {
  const a = fresh()
  const reply = (url) =>
    url === PLAN ? Response.json({ planInfo: { planName: "Pro+" } }) : Response.json({ planUsage: { autoPercentUsed: 1, apiPercentUsed: 2, totalPercentUsed: 3 } })
  const first = await run(a, reply)
  expect(first.u.plan).toBe("Pro+")
  const plan = first.seen.find((r) => r.url === PLAN)
  expect(plan.method).toBe("POST")
  expect(plan.headers.Authorization).toBe(`Bearer ${a.access}`)
  const again = await run(a, reply)
  expect(again.u.plan).toBe("Pro+")
  expect(again.seen.map((r) => r.url)).not.toContain(PLAN)
})

test("a plan Cursor doesn't say leaves the card's plan out", async () => {
  const a = fresh()
  const { u } = await run(a, (url) => (url === PLAN ? new Response("no", { status: 500 }) : Response.json({ planUsage: { autoPercentUsed: 1 } })))
  expect(u.plan).toBeUndefined()
  expect(u.windows.length).toBe(3)
})

for (const bucket of [["default", "composer-2.5", "cursor-grok-4.5-high", "future-first-party", "Grok-4.8"], undefined]) {
  test(`each model counts in the pool magpie puts it in (autoBucketModels ${bucket ? "given" : "left out"})`, async () => {
    const { u } = await run(auth, () =>
      Response.json({ billingCycleEnd: "1792833042000", planUsage: { autoPercentUsed: 25, apiPercentUsed: 100, totalPercentUsed: 100 }, autoBucketModels: bucket }),
    )
    const [cursor, other, total] = u.windows
    const pool = bucket ? [...firstParty, ...bucketed] : firstParty
    const rest = bucket ? others : [...others, ...bucketed]
    for (const m of pool) expect([m, counts(cursor, m), counts(other, m)]).toEqual([m, true, false])
    for (const m of rest) expect([m, counts(cursor, m), counts(other, m)]).toEqual([m, false, true])
    expect(total.models).toBeUndefined()
    expect(total.notModels).toBeUndefined()
  })
}

// Will on Discord: the list has grok-4.7 only at its sizes, a routing group
// still asks for bare grok-4.7, and it was counted in Other Models (used up)
test("a model asked for by its bare name counts in the pool its sized ids are in", async () => {
  const { u } = await run(auth, () =>
    Response.json({ billingCycleEnd: "1792833042000", planUsage: { autoPercentUsed: 16, apiPercentUsed: 100, totalPercentUsed: 60 } }),
  )
  const [cursor, other] = u.windows
  for (const m of ["grok-4.7", "Grok-4.7"]) expect([m, counts(cursor, m), counts(other, m)]).toEqual([m, true, false])
  // a bare other model stays in Other Models
  expect(["claude-opus-5-5", counts(cursor, "claude-opus-5-5"), counts(other, "claude-opus-5-5")]).toEqual(["claude-opus-5-5", false, true])
})

test("an enterprise plan's spend is no window", async () => {
  expect((await run(fresh(), () => Response.json({ spendLimitUsage: {} }))).u).toEqual({ windows: [], signIn: "kept" })
})

test("a refused token is the status magpie says", async () => {
  expect((await run(fresh(), () => new Response("no", { status: 401 }))).u).toEqual({ error: "Unauthorized", windows: [], signIn: "kept" })
})

test("a run-out sign-in says so, and asks nothing", async () => {
  const { u, seen } = await run({ ...auth, access: jwt(1) }, () => Response.json({}))
  expect(u).toEqual({ error: "Cursor's sign-in has run out; sign in to Cursor again", windows: [], signIn: "kept" })
  expect(seen).toEqual([])
})

// the built-in's 401 for any "expired", a token's or a trial's, which marked
// no account (errorResponse says kept)
test("anything expired is the built-in's 401", () => {
  const { failure } = _internal
  const says = (msg) => failure(400, JSON.stringify({ code: "failed_precondition", message: msg }))
  for (const m of ["Your access token has expired", "Session expired, please log in again", "Your free trial has expired", "This link has expired"])
    expect(says(m)).toEqual({ status: 401, message: m + " — sign in to Cursor again in magpie" })
})

// The built-in's usage read neither marked nor cleared the account, so each
// read says kept, a clean one too.
test("a usage read keeps the account, clean or not", async () => {
  const PERIOD_OK = () => Response.json({ billingCycleEnd: "1792833042000", planUsage: { autoPercentUsed: 1, apiPercentUsed: 2, totalPercentUsed: 3 } })
  expect((await run(fresh(), PERIOD_OK)).u.signIn).toBe("kept")
  expect((await run(fresh(), () => new Response("no", { status: 401 }))).u.signIn).toBe("kept")
  expect((await run({ ...auth, access: jwt(1) }, PERIOD_OK)).u.signIn).toBe("kept")
})

// the gateway names the provider before a plugin's error
test("an error doesn't name Cursor again", () => {
  const f = _internal.failure(429, JSON.stringify({ code: "resource_exhausted", message: "slow down" }))
  expect(f).toEqual({ status: 429, message: "usage limit reached: slow down" })
})

test("a model list Cursor couldn't give fails, not shrinks to the configured few", async () => {
  globalThis.fetch = async () => new Response("down", { status: 503 })
  const hooks = await CursorAuthPlugin()
  const configured = { models: { auto: { id: "auto" } } }
  await expect(hooks.provider.models(configured, { auth: fresh() })).rejects.toThrow()
})

const BOT = "https://cursor.com/api/dashboard/get-sand-usage-status"
const botAuth = () => ({ ...fresh(), access: ["e30", Buffer.from(JSON.stringify({ sub: "auth0|user_test", exp: Math.floor(Date.now() / 1000) + 7200 + ++n })).toString("base64url"), "sig"].join(".") })
const reset = "2030-01-08T00:00:00.000Z"
const paidBot = { includedLimitZero: false, usagePercent: 42, nextResetTimestampUtc: reset }
const period = { planUsage: { autoPercentUsed: 12, apiPercentUsed: 34, totalPercentUsed: 20 } }
const botRun = (data, monthly = period, account = botAuth()) => run(account, (url) => {
  if (url === PLAN) return Response.json({})
  if (url === BOT) {
    if (data instanceof Error) throw data
    return data instanceof Response ? data : Response.json(data)
  }
  return Response.json(monthly)
})

test("Bot uses the dashboard session and appears before Total without gating Cursor models", async () => {
  const a = botAuth()
  const { u, seen } = await botRun(paidBot, period, a)
  expect(u.windows.map((w) => w.name)).toEqual(["Cursor Models", "Other Models", "Grok Bot", "Total"])
  expect(u.windows[2]).toEqual({ name: "Grok Bot", used: 42, aside: true, resetsAt: reset, span: 604800 })
  expect(seen.find((r) => r.url === BOT)).toMatchObject({ method: "POST", body: "{}", headers: { Cookie: "WorkosCursorSessionToken=" + encodeURIComponent("user_test::" + a.access) } })
})

test("Bot grants work without Cursor monthly usage, with current or legacy allowance flags", async () => {
  expect((await botRun({ ...paidBot, hasNonZeroIncludedLimit: false }, {})).u.windows).toEqual([
    { name: "Grok Bot", used: 42, aside: true, resetsAt: reset, span: 604800 },
  ])
  expect((await botRun({ hasNonZeroIncludedLimit: true, usagePercent: 0 }, {})).u.windows).toEqual([{ name: "Grok Bot", used: 0, aside: true }])
})

test("an exhausted trial stays visible, without treating expiry as a reset", async () => {
  const trial = { includedLimitZero: true, sandTrialExpiresAt: "2099-01-01T00:00:00Z", usagePercent: 100, nextResetTimestampUtc: reset }
  expect((await botRun(trial)).u.windows[2]).toEqual({ name: "Grok Bot (trial)", used: 100, aside: true })
  expect((await botRun({ ...trial, sandTrialExpiresAt: "2000-01-01T00:00:00Z" })).u.windows.map((w) => w.name)).toEqual(["Cursor Models", "Other Models", "Total"])
})

test("absent or failed Bot readings preserve Cursor usage and sign-in", async () => {
  const normal = (await run(fresh(), (url) => Response.json(url === PLAN ? {} : period))).u
  for (const data of [null, {}, { ...paidBot, includedLimitZero: true, hasNonZeroIncludedLimit: true }, { ...paidBot, usagePercent: null }, new Response("", { status: 403 }), new Response("not JSON"), new Error("network unavailable")])
    expect((await botRun(data)).u).toEqual(normal)
})

test("Bot usage is clamped", async () => {
  for (const [usagePercent, used] of [[130, 100], [-5, 0]])
    expect((await botRun({ ...paidBot, usagePercent })).u.windows[2]).toEqual({ name: "Grok Bot", used, aside: true, resetsAt: reset, span: 604800 })
})

test("Bot login redirects are refused", async () => {
  const normal = (await run(botAuth(), (url) => Response.json(url === PLAN ? {} : period))).u
  const { u, seen } = await botRun(new Response(null, { status: 307, headers: { Location: "https://cursor.com/login?returnTo=dashboard" } }))
  expect(u).toEqual(normal)
  expect(seen.find((r) => r.url === BOT)).toMatchObject({ redirect: "error" })
})

// fottencity on Discord: a team that pays for on-demand usage once the
// included usage is gone. Cursor goes on serving it, so the spent pools must
// not read as the account used up; its on-demand spend is what runs out.
// The replies are GetCurrentPeriodUsage's and GetHardLimit's as
// cursor-agent 2026.10.01 decodes them (Connect JSON of
// GetCurrentPeriodUsageResponse.SpendLimitUsage: cents, pooled_limit an
// int64 string; GetHardLimitResponse: dollars), and its usage view's
// On-demand line is what is read from them.
const HARD = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetHardLimit"
const spent = { billingCycleEnd: "1792833042000", planUsage: { autoPercentUsed: 100, apiPercentUsed: 100, totalPercentUsed: 100 } }
const at = new Date(1792833042000).toISOString()
const onDemand = (period, hard) =>
  run(fresh(), (url) => {
    if (url === PLAN) return Response.json({})
    if (url === HARD) return hard instanceof Response ? hard : Response.json(hard)
    return Response.json(period)
  })
const shape = (u) => u.windows.map(({ models, notModels, ...w }) => w)

test("a team member's own on-demand limit: the spent pools are aside, the on-demand spend is the allowance", async () => {
  const { u, seen } = await onDemand({ ...spent, spendLimitUsage: { totalSpend: 52000, individualLimit: 50000, individualUsed: 12345, individualRemaining: 37655, limitType: "team", pooledLimit: "0" } }, {})
  expect(shape(u)).toEqual([
    { name: "Cursor Models", used: 100, resetsAt: at, aside: true },
    { name: "Other Models", used: 100, resetsAt: at, aside: true },
    { name: "On-demand", used: 24.69, display: "$123.45 / $500.00", resetsAt: at },
    { name: "Total", used: 100, resetsAt: at, aside: true },
  ])
  const period = seen.find((r) => r.url === PERIOD)
  expect(seen.find((r) => r.url === HARD)).toEqual({ ...period, url: HARD })
})

test("a team with no limit of the member's, a team hard limit and no pool: on-demand without end, every window aside", async () => {
  const { u } = await onDemand({ ...spent, spendLimitUsage: { individualUsed: 900, limitType: "team" } }, { hardLimit: 2000, perUserMonthlyLimitDollars: 0 })
  expect(u.windows.every((w) => w.aside)).toBe(true)
  expect(shape(u)[2]).toEqual({ name: "On-demand", used: 0, display: "$9.00", resetsAt: at, aside: true })
})

// magpie #1868 (PaSSw0rds, a real Team account whose on-demand is turned on
// for the whole organization): spendLimitUsage has no individualLimit at
// all, the pool's limit and remainder are int64 strings and its spend a
// number, and GetHardLimit answers the pool's limit in dollars with or
// without a team id. The pool is what runs out, for the whole team.
const teamPool = { totalSpend: 6334270, pooledLimit: "45120000", pooledUsed: 6334270, pooledRemaining: "38785730", individualUsed: 19855, limitType: "team" }
test("a team's org-wide on-demand pool is the allowance: its spend is shown, and the account is used up when it is", async () => {
  const period = { ...spent, planUsage: { totalSpend: 16151, includedSpend: 2000, bonusSpend: 14151, limit: 2000, autoPercentUsed: 57.81428571428572, apiPercentUsed: 100, totalPercentUsed: 64.604 }, spendLimitUsage: teamPool }
  for (const hard of [{ hardLimit: 451200 }, { hardLimit: 451200, isDynamicTeamLimit: true }, new Response("no", { status: 500 })]) {
    const { u } = await onDemand(period, hard)
    expect(shape(u)).toEqual([
      { name: "Cursor Models", used: 57.81428571428572, resetsAt: at, aside: true },
      { name: "Other Models", used: 100, resetsAt: at, aside: true },
      { name: "On-demand", used: (100 * 6334270) / 45120000, display: "$63,342.70 / $451,200.00 (you: $198.55)", resetsAt: at },
      { name: "Total", used: 64.604, resetsAt: at, aside: true },
    ])
  }
  // the pool spent: the account is used up, though the member spent little of it
  const out = (await onDemand({ ...spent, spendLimitUsage: { ...teamPool, pooledUsed: 45120000, pooledRemaining: "0" } }, { hardLimit: 451200 })).u
  expect(shape(out)[2]).toEqual({ name: "On-demand", used: 100, display: "$451,200.00 / $451,200.00 (you: $198.55)", resetsAt: at })
  // nothing spent from the pool yet: Connect JSON leaves pooledUsed out
  const none = (await onDemand({ ...spent, spendLimitUsage: { individualUsed: 900, limitType: "team", pooledLimit: "100000" } }, new Response("no", { status: 500 }))).u
  expect(shape(none)[2]).toEqual({ name: "On-demand", used: 0, display: "$0.00 / $1,000.00 (you: $9.00)", resetsAt: at })
})

test("a personal plan's hard limit is its on-demand limit; the top int32 is none", async () => {
  const { u } = await onDemand({ ...spent, spendLimitUsage: { individualUsed: 500, limitType: "user" } }, { hardLimit: 20 })
  expect(shape(u).slice(0, 3)).toEqual([
    { name: "Cursor Models", used: 100, resetsAt: at, aside: true },
    { name: "Other Models", used: 100, resetsAt: at, aside: true },
    { name: "On-demand", used: 25, display: "$5.00 / $20.00", resetsAt: at },
  ])
  const none = (await onDemand({ ...spent, spendLimitUsage: { individualUsed: 500, limitType: "user" } }, { hardLimit: 2147483647 })).u
  expect(none.windows.every((w) => w.aside)).toBe(true)
  // spent to its limit: the account is used up again
  const out = (await onDemand({ ...spent, spendLimitUsage: { individualUsed: 2500, limitType: "user" } }, { hardLimit: 20 })).u
  expect(shape(out)[2]).toEqual({ name: "On-demand", used: 100, display: "$25.00 / $20.00", resetsAt: at })
})

test("no on-demand allowed, none set or not known: the pools are the allowance, as before", async () => {
  const before = [
    { name: "Cursor Models", used: 100, resetsAt: at },
    { name: "Other Models", used: 100, resetsAt: at },
    { name: "Total", used: 100, resetsAt: at, aside: true },
  ]
  const cases = [
    [{ ...spent, spendLimitUsage: { individualUsed: 0, limitType: "user" } }, {}],
    [{ ...spent, spendLimitUsage: { individualUsed: 0, limitType: "user" } }, { hardLimit: 50, noUsageBasedAllowed: true }],
    [{ ...spent, spendLimitUsage: { individualLimit: 0, individualUsed: 0, limitType: "team" } }, { hardLimit: 2000 }],
    [{ ...spent, spendLimitUsage: { individualUsed: 0, limitType: "team" } }, { hardLimit: 2000, noUsageBasedAllowed: true }],
    [{ ...spent, spendLimitUsage: { individualUsed: 0, limitType: "team" } }, new Response("no", { status: 403 })],
    [spent, new Response("no", { status: 500 })],
  ]
  for (const [i, [period, hard]] of cases.entries()) expect([i, shape((await onDemand(period, hard)).u)]).toEqual([i, before])
})

// magpie #2213 (Morganwan90): the panel draws an account's first three
// windows, and an On-demand with no limit (a dollar figure on a ring that
// never fills) pushed Grok Bot to the fourth. One with a limit is what can
// stop the account, and keeps its place ahead of Bot.
const botOnDemand = (period, hard) =>
  run(botAuth(), (url) => {
    if (url === PLAN) return Response.json({})
    if (url === BOT) return Response.json(paidBot)
    if (url === HARD) return Response.json(hard)
    return Response.json(period)
  })
test("Bot is among the first three windows ahead of an On-demand with no limit, behind one with a limit", async () => {
  const open = (await botOnDemand({ ...spent, spendLimitUsage: { individualUsed: 900, limitType: "team" } }, { hardLimit: 2000, perUserMonthlyLimitDollars: 0 })).u
  expect(open.windows.map((w) => w.name)).toEqual(["Cursor Models", "Other Models", "Grok Bot", "On-demand", "Total"])
  const capped = (await botOnDemand({ ...spent, spendLimitUsage: { individualUsed: 500, limitType: "user" } }, { hardLimit: 20 })).u
  expect(capped.windows.map((w) => w.name)).toEqual(["Cursor Models", "Other Models", "On-demand", "Grok Bot", "Total"])
})
