// Pure-logic tests for quota.js: node:test + node:vm, no DOM, no new dependencies.
// Run: node --test apps/desktop/tests/quota-ui.test.mjs
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import vm from "node:vm"

const here = path.dirname(fileURLToPath(import.meta.url))
const code = readFileSync(path.join(here, "..", "src", "quota.js"), "utf8")
const sandbox = {}
vm.createContext(sandbox)
new vm.Script(code, { filename: "quota.js" }).runInContext(sandbox)
const Q = sandbox.QuotaUI
assert.ok(Q, "quota.js must export QuotaUI pure logic without DOM (boot must be document-guarded)")

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

// Scripted invoke: records calls and lets tests settle responses out of order.
function fakeInvoke() {
  const calls = []
  const pending = new Map()
  const fn = (cmd, args) => {
    calls.push({ cmd, args })
    return new Promise((resolve, reject) => { pending.set(calls.length - 1, { resolve, reject }) })
  }
  return {
    fn, calls,
    resolve: (i, v) => { pending.get(i).resolve(v) },
    reject: (i, e) => { pending.get(i).reject(e) },
  }
}

const snap = (providers, extra = {}) => ({ providers, updatedAt: 1731800000000, online: true, error: null, ...extra })
const prov = (name, extra = {}) => ({ name, enabled: true, plan: null, status: "ready", message: null, windows: [], updatedAt: null, ...extra })
const rowByName = (rows, name) => rows.find((r) => r.provider.name === name)
// vm-realm objects have a different prototype; compare plain JSON values instead
const plain = (v) => JSON.parse(JSON.stringify(v))

test("computePercent uses used/limit, derives from limit-remaining when used is null, null when not computable", () => {
  const v = Q.computePercent({ used: 12.3, limit: 45 })
  assert.equal(Math.round(v * 10) / 10, 27.3)
  assert.equal(Q.computePercent({ used: null, limit: 60, remaining: 18 }), 70)
  assert.equal(Q.computePercent({ limit: 0, used: 1 }), null)
  assert.equal(Q.computePercent({ used: 90, limit: 45 }), 100)
  assert.equal(Q.computePercent({ used: -5, limit: 45 }), 0)
  assert.equal(Q.computePercent({ used: null, limit: null, remaining: null }), null)
  assert.equal(Q.computePercent(null), null)
})

test("known total without usage stays visible without fabricating a remaining balance", () => {
  const window = { used: null, remaining: null, limit: 25, unit: "USD" };
  assert.equal(Q.describeWindow(window), "总额度 25 USD");
  assert.equal(Q.computePercent(window), null);
});

test("formatPercent floors and clamps to 0-100, null passes through", () => {
  assert.equal(Q.formatPercent(27.9), "27%")
  assert.equal(Q.formatPercent(99.9), "99%")
  assert.equal(Q.formatPercent(100), "100%")
  assert.equal(Q.formatPercent(null), null)
})

test("formatAmount keeps at most two decimals with grouping, never invents values", () => {
  assert.equal(Q.formatAmount(8), "8")
  assert.equal(Q.formatAmount(2.25), "2.25")
  assert.equal(Q.formatAmount(12.345), "12.35")
  assert.equal(Q.formatAmount(1234.5), "1,234.5")
  assert.equal(Q.formatAmount(-3.2), "-3.2")
  assert.equal(Q.formatAmount(0), "0")
  assert.equal(Q.formatAmount(0.004), "<0.01")
  assert.equal(Q.formatAmount(null), null)
})

test("formatResetTime returns absolute plus relative time; past times have no relative part", () => {
  const now = new Date(2026, 10, 17, 14, 0, 0).getTime()
  const future = new Date(2026, 10, 20, 14, 0, 0).getTime()
  assert.deepEqual(plain(Q.formatResetTime(new Date(future).toISOString(), now)), { absolute: "11月20日 14:00", relative: "3 天后" })
  assert.equal(Q.formatResetTime(new Date(now + 30 * 60000).toISOString(), now).relative, "30 分钟后")
  assert.equal(Q.formatResetTime(new Date(now - 60000).toISOString(), now).relative, null)
  assert.equal(Q.formatResetTime(null, now), null)
  assert.equal(Q.formatResetTime("not-a-date", now), null)
})

test("formatTimestamp renders local time in Chinese format, null passes through", () => {
  assert.equal(Q.formatTimestamp(new Date(2026, 10, 17, 14, 32, 5).getTime()), "11月17日 14:32:05")
  assert.equal(Q.formatTimestamp(null), null)
})

test("statusMeta covers every contract status and downgrades unknown ones to muted", () => {
  assert.deepEqual(plain(Q.statusMeta("ready")), { label: "就绪", tone: "ok" })
  assert.deepEqual(plain(Q.statusMeta("unsupported")), { label: "不支持", tone: "muted" })
  assert.deepEqual(plain(Q.statusMeta("unavailable")), { label: "不可用", tone: "warn" })
  assert.deepEqual(plain(Q.statusMeta("reauth")), { label: "需重新登录", tone: "warn" })
  assert.deepEqual(plain(Q.statusMeta("cooling")), { label: "冷却中", tone: "warn" })
  assert.deepEqual(plain(Q.statusMeta("mystery")), { label: "mystery", tone: "muted" })
  assert.deepEqual(plain(Q.statusMeta(null)), { label: "未知", tone: "muted" })
})

test("describeWindow combines used/remaining/reset text and states missing data explicitly", () => {
  const base = { label: "五小时", unit: "次", used: 12.3, limit: 45, remaining: 32.7, resetAt: null }
  assert.ok(Q.describeWindow(base).includes("已用 12.3 / 45 次"))
  assert.ok(Q.describeWindow({ ...base, used: null }).includes("剩余 32.7 / 45 次"))
  const now = new Date(2026, 10, 17, 14, 0, 0).getTime()
  const withReset = Q.describeWindow({ ...base, resetAt: new Date(2026, 10, 18, 9, 0).toISOString() }, now)
  assert.ok(withReset.includes("重置 11月18日 09:00"))
  assert.ok(withReset.includes("19 小时后"))
  assert.equal(Q.describeWindow({ used: null, limit: null, remaining: null, unit: null, resetAt: null }, now), "暂无数据")
  assert.equal(Q.describeWindow(null), "暂无数据")
})

test("normalizeSnapshot whitelists fields: credential-like unknown fields never reach render data", () => {
  const s = Q.normalizeSnapshot({
    providers: [{
      name: "a", enabled: false, plan: "Pro", status: "ready", apiKey: "secret",
      windows: [{ label: "w", used: 1, limit: 2, resetAt: "x", apiKey: "secret" }],
    }],
    updatedAt: 1, online: false, error: "e",
  })
  // vm realm prototypes differ from the test realm, so compare JSON values
  assert.deepEqual(JSON.parse(JSON.stringify(s)), {
    providers: [{
      name: "a", enabled: false, plan: "Pro", status: "ready", message: null,
      windows: [{ label: "w", used: 1, limit: 2, remaining: null, unit: null, resetAt: "x" }],
      updatedAt: null,
    }],
    updatedAt: 1, online: false, error: "e",
  })
  assert.deepEqual(JSON.parse(JSON.stringify(Q.normalizeSnapshot(null))), { providers: [], updatedAt: null, online: true, error: null })
})

test("controller: initial full refresh emits loading state first, then lands rows and count", async () => {
  const ipc = fakeInvoke()
  const c = Q.createController({ invoke: ipc.fn })
  const seen = []
  c.subscribe((s) => seen.push(s.count))
  c.refreshAll()
  await flush()
  // vm realm objects differ in prototype, assert field by field
  assert.equal(ipc.calls.length, 1)
  assert.equal(ipc.calls[0].cmd, "quota_snapshot")
  assert.equal(ipc.calls[0].args.provider, null)
  assert.equal(seen[0], null)
  ipc.resolve(0, snap([prov("a"), prov("b", { enabled: false })]))
  await flush()
  const s = c.state()
  assert.equal(s.count, 2, "disabled providers still count as configured")
  assert.equal(s.loadingAll, false)
  assert.equal(s.rows[0].stale, false)
})

test("controller: only one in-flight request per provider", async () => {
  const ipc = fakeInvoke()
  const c = Q.createController({ invoke: ipc.fn })
  c.refreshAll(); await flush()
  ipc.resolve(0, snap([prov("a")])); await flush()
  c.refreshProvider("a"); c.refreshProvider("a"); c.refreshProvider("a")
  assert.equal(ipc.calls.filter((x) => x.args.provider === "a").length, 1)
  ipc.resolve(1, snap([prov("a", { windows: [{ label: "w", used: 1, limit: 4, remaining: 3, unit: null, resetAt: null }] })]))
  await flush()
  assert.equal(c.state().rows[0].provider.windows.length, 1)
  assert.equal(c.state().rows[0].loading, false)
})

test("controller: duplicate refreshAll merges into one call and no per-card dispatch during loadingAll", async () => {
  const ipc = fakeInvoke()
  const c = Q.createController({ invoke: ipc.fn })
  const p1 = c.refreshAll()
  const p2 = c.refreshAll()
  assert.equal(p1, p2)
  c.refreshProvider("a")
  assert.equal(ipc.calls.length, 1)
  ipc.resolve(0, snap([]))
  await flush()
  assert.equal(c.state().count, 0)
})

test("controller: a landing full snapshot supersedes an in-flight per-card result", async () => {
  const ipc = fakeInvoke()
  const c = Q.createController({ invoke: ipc.fn })
  c.refreshAll(); await flush()
  ipc.resolve(0, snap([prov("a")])); await flush()
  c.refreshProvider("a"); await flush()          // card request in flight (call 1)
  c.refreshAll(); await flush()                  // focus triggers full refresh (call 2)
  ipc.resolve(2, snap([prov("a", { updatedAt: 2 })]))
  await flush()
  ipc.resolve(1, snap([prov("a", { updatedAt: 1 })])) // late, older card result
  await flush()
  assert.equal(c.state().rows[0].provider.updatedAt, 2)
  assert.equal(c.state().rows[0].loading, false, "card loading cleared once the full snapshot lands")
})

test("controller: full refresh failure keeps last known data flagged stale", async () => {
  const ipc = fakeInvoke()
  const c = Q.createController({ invoke: ipc.fn })
  c.refreshAll(); await flush()
  ipc.resolve(0, snap([prov("a")])); await flush()
  c.refreshAll(); await flush()
  ipc.reject(1, new Error("网关超时"))
  await flush()
  const s = c.state()
  assert.equal(s.rows.length, 1)
  assert.equal(s.rows[0].stale, true)
  assert.equal(s.fullError, "网关超时")
  assert.equal(s.loadingAll, false)
})

test("controller: offline full snapshot flags every row stale", async () => {
  const ipc = fakeInvoke()
  const c = Q.createController({ invoke: ipc.fn })
  c.refreshAll(); await flush()
  ipc.resolve(0, snap([prov("a"), prov("b")], { online: false }))
  await flush()
  for (const row of c.state().rows) assert.equal(row.stale, true)
})

test("controller: per-card failure only affects that card; data and metadata stay intact", async () => {
  const ipc = fakeInvoke()
  const c = Q.createController({ invoke: ipc.fn })
  c.refreshAll(); await flush()
  ipc.resolve(0, snap([prov("a", { windows: [{ label: "w", used: 1, limit: 2, remaining: 1, unit: null, resetAt: null }] })]))
  await flush()
  c.refreshProvider("a"); await flush()
  ipc.reject(1, "boom")
  await flush()
  const s = c.state()
  assert.equal(s.rows[0].cardError, "boom")
  assert.equal(s.rows[0].loading, false)
  assert.equal(s.rows[0].provider.windows.length, 1, "failed refresh keeps existing window data")
  assert.equal(s.rows[0].stale, false, "a card failure alone does not flip the offline/stale verdict")
})

test("controller: per-card merged response applies the full list and metadata (adds, offline, error)", async () => {
  const ipc = fakeInvoke()
  const c = Q.createController({ invoke: ipc.fn })
  c.refreshAll(); await flush()
  ipc.resolve(0, snap([prov("a")])); await flush()
  c.refreshProvider("a"); await flush()
  // backend answers per-card requests with a complete merged snapshot
  ipc.resolve(1, snap([prov("a", { updatedAt: 11 }), prov("b")], { online: false, error: "upstream quota api failed", updatedAt: 111 }))
  await flush()
  const s = c.state()
  assert.equal(s.count, 2, "providers added by the merged snapshot appear")
  assert.equal(s.snapshot.online, false, "offline metadata must land, not be ignored")
  assert.equal(s.snapshot.error, "upstream quota api failed")
  assert.ok(s.rows.every((r) => r.stale))
  // a later merged response recovers online and clears the error
  c.refreshProvider("b"); await flush()
  ipc.resolve(2, snap([prov("a"), prov("b")], { online: true, updatedAt: 222 }))
  await flush()
  const s2 = c.state()
  assert.equal(s2.snapshot.online, true)
  assert.equal(s2.snapshot.error, null)
  assert.ok(s2.rows.every((r) => !r.stale))
})

test("controller: merged apply protects other in-flight cards from a stale payload", async () => {
  const ipc = fakeInvoke()
  const c = Q.createController({ invoke: ipc.fn })
  c.refreshAll(); await flush()
  ipc.resolve(0, snap([prov("a"), prov("b")])); await flush()
  c.refreshProvider("a"); await flush()  // call 1 in flight
  c.refreshProvider("b"); await flush()  // call 2 in flight
  // a's merged payload carries an older snapshot of b, which is still in flight
  ipc.resolve(1, snap([prov("a", { updatedAt: 100 }), prov("b", { updatedAt: 50 })]))
  await flush()
  assert.equal(rowByName(c.state().rows, "a").provider.updatedAt, 100)
  assert.equal(rowByName(c.state().rows, "a").loading, false)
  assert.equal(rowByName(c.state().rows, "b").provider.updatedAt, null, "in-flight provider keeps its previous data")
  assert.equal(rowByName(c.state().rows, "b").loading, true, "in-flight provider stays in loading state")
  // b's own response lands afterwards and wins
  ipc.resolve(2, snap([prov("a", { updatedAt: 100 }), prov("b", { updatedAt: 200 })]))
  await flush()
  assert.equal(rowByName(c.state().rows, "b").provider.updatedAt, 200)
  assert.equal(rowByName(c.state().rows, "b").loading, false)
})

test("controller: provider removed by a merged snapshot is dropped and its in-flight response cannot resurrect it", async () => {
  const ipc = fakeInvoke()
  const c = Q.createController({ invoke: ipc.fn })
  c.refreshAll(); await flush()
  ipc.resolve(0, snap([prov("a"), prov("d")])); await flush()
  c.refreshProvider("d"); await flush()  // call 1 in flight
  c.refreshProvider("a"); await flush()  // call 2 in flight
  ipc.resolve(2, snap([prov("a", { updatedAt: 10 })]))  // merged view no longer has d
  await flush()
  assert.deepEqual(c.state().rows.map((r) => r.provider.name), ["a"])
  ipc.resolve(1, snap([prov("a"), prov("d", { updatedAt: 99 })]))  // late d response
  await flush()
  assert.deepEqual(c.state().rows.map((r) => r.provider.name), ["a"], "removed provider stays removed")
})

test("controller: starting a full refresh invalidates in-flight card requests, even when the full refresh fails", async () => {
  const ipc = fakeInvoke()
  const c = Q.createController({ invoke: ipc.fn })
  c.refreshAll(); await flush()
  ipc.resolve(0, snap([prov("a")])); await flush()
  c.refreshProvider("a"); await flush()  // call 1 in flight
  c.refreshAll(); await flush()          // call 2: start invalidates call 1
  assert.equal(c.state().rows[0].loading, false, "card loading cleared when the full refresh starts")
  ipc.reject(2, new Error("gateway down"))
  await flush()
  ipc.resolve(1, snap([prov("a", { updatedAt: 2 })]))  // late card result after failed full refresh
  await flush()
  const s = c.state()
  assert.equal(s.rows[0].provider.updatedAt, null, "old card result must not overwrite after full-refresh failure")
  assert.equal(s.fullError, "gateway down")
  assert.ok(s.rows[0].stale)
})

test("controller: a successful per-card apply clears fullError from an earlier failed full refresh", async () => {
  const ipc = fakeInvoke()
  const c = Q.createController({ invoke: ipc.fn })
  c.refreshAll(); await flush()
  ipc.resolve(0, snap([prov("a")])); await flush()
  c.refreshAll(); await flush()
  ipc.reject(1, "gateway down")
  await flush()
  assert.equal(c.state().fullError, "gateway down")
  assert.ok(c.state().rows[0].stale)
  c.refreshProvider("a"); await flush()
  ipc.resolve(2, snap([prov("a", { updatedAt: 5 })], { online: true, updatedAt: 6 }))
  await flush()
  const s = c.state()
  assert.equal(s.fullError, null, "fresh merged snapshot supersedes the earlier full-refresh failure")
  assert.ok(!s.rows[0].stale)
})

test("controller: missing invoke throws (production must not silently mock)", () => {
  assert.throws(() => Q.createController({}))
})

test('controller: refresh of another card clears a revoked Step Plan before an older result lands', async () => {
  const ipc = fakeInvoke()
  const c = Q.createController({ invoke: ipc.fn })
  const merged = (updatedAt, state) => snap([prov('step', { stepPlan: { state, family: 'token', name: 'Previous account' } }), prov('other')], { updatedAt })
  c.refreshAll(); ipc.resolve(0, merged(1, 'known')); await flush()
  c.refreshProvider('step'); c.refreshProvider('other')
  ipc.resolve(2, merged(3, 'unavailable')); await flush()
  const account = () => rowByName(c.state().rows, 'step').provider.stepPlan
  assert.equal(account().name, null)
  ipc.resolve(1, merged(2, 'known')); await flush()
  assert.equal(account().state, 'unavailable')
  assert.equal(account().name, null)
})
