// Pure-logic tests for the control-center controllers in quota.js:
// node:test + node:vm, no DOM, no new dependencies.
// Run: node --test apps/desktop/tests/control-center.test.mjs
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
const plain = (v) => JSON.parse(JSON.stringify(v))

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

const routingSnap = (overrides = {}) => ({
  providers: [
    { name: "alpha", models: ["a1", "a2"] },
    { name: "beta", models: ["b1"] },
  ],
  routes: [
    { scope: "global", field: "default", target: "alpha,a1", fallback: ["beta,b1"] },
    { scope: "global", field: "think", target: null, fallback: [] },
    { scope: "opus", field: "default", target: "alpha,a2", fallback: [] },
    { scope: "models", field: "glm-5", target: "beta,b1", fallback: [] },
  ],
  familyRouting: true,
  fallbackEnabled: true,
  revision: "rev-1",
  ...overrides,
})

// Server-side routing change: mirrors the contract (null target clears the
// override, null fallback preserves the current list, revision is required).
function applyRoutingChange(base, ch) {
  const keep = []
  let replaced = false
  for (const r of base.routes) {
    if (r.scope === ch.scope && r.field === ch.field) {
      replaced = true
      if (ch.target === null) continue // clear override removes the route
      keep.push({ scope: r.scope, field: r.field, target: ch.target, fallback: ch.fallback === null ? r.fallback.slice() : ch.fallback.slice() })
    } else keep.push(r)
  }
  if (!replaced && ch.target !== null) {
    keep.push({ scope: ch.scope, field: ch.field, target: ch.target, fallback: ch.fallback === null ? [] : ch.fallback.slice() })
  }
  return { ...base, routes: keep }
}
function bumpRev(base) {
  const n = parseInt(String(base.revision).replace(/^rev-/, ""), 10) || 0
  return { ...base, revision: "rev-" + (n + 1) }
}

// ---------------- routing ----------------

test("routing: normalizeRoutingSnapshot whitelists fields and coerces shapes", () => {
  const s = Q.normalizeRoutingSnapshot({
    providers: [{ name: "a", models: ["m1", 3, null], apiKey: "secret" }],
    routes: [{ scope: "global", field: "default", target: "a,m1", fallback: ["x", 5], extra: 1 }],
    familyRouting: 1, fallbackEnabled: "yes", revision: "r9", junk: true,
  })
  assert.deepEqual(plain(s), {
    providers: [{ name: "a", models: ["m1"] }],
    routes: [{ scope: "global", field: "default", target: "a,m1", fallback: ["x"] }],
    familyRouting: false, fallbackEnabled: false, revision: "r9",
  }, "only real booleans pass the projection")
  assert.equal(Q.normalizeRoutingSnapshot({ familyRouting: true, fallbackEnabled: true }).familyRouting, true)
  assert.deepEqual(plain(Q.normalizeRoutingSnapshot(null)), {
    providers: [], routes: [], familyRouting: false, fallbackEnabled: false, revision: "",
  })
})

test("routing: routeKey/splitKey/routeLabel round-trip and label scenarios/aliases", () => {
  const key = Q.routeKey("models", "glm-5")
  assert.deepEqual(plain(Q.splitKey(key)), { scope: "models", field: "glm-5" })
  assert.deepEqual(plain(Q.splitKey("global|webSearch")), { scope: "global", field: "webSearch" })
  assert.equal(Q.routeLabel("models", "glm-5"), "glm-5")
  assert.equal(Q.routeLabel("global", "think"), "思考")
  assert.equal(Q.routeLabel("opus", "longContext"), "长上下文")
  assert.equal(Q.routeLabel("global", "customField"), "customField")
  assert.ok(Q.ROUTING_SCOPES.includes("models"))
  assert.ok(Q.ROUTING_SCENARIOS.includes("extendedContext"))
})

test("routing: refresh lands snapshot; setTarget drafts without server calls", async () => {
  const ipc = fakeInvoke()
  const c = Q.createRoutingController({ invoke: ipc.fn })
  c.refresh()
  await flush()
  assert.equal(ipc.calls.length, 1)
  assert.equal(ipc.calls[0].cmd, "routing_snapshot")
  ipc.resolve(0, routingSnap())
  await flush()
  assert.equal(c.state().snapshot.revision, "rev-1")
  c.setTarget(Q.routeKey("global", "default"), "beta,b1")
  await flush()
  assert.equal(ipc.calls.length, 1, "editing must not hit IPC")
  assert.deepEqual(plain(c.state().dirtyKeys), [Q.routeKey("global", "default")])
  assert.equal(c.state().draft(Q.routeKey("global", "default")).target, "beta,b1")
})

test("routing: save sends null fallback when untouched and empty target becomes null", async () => {
  const ipc = fakeInvoke()
  const c = Q.createRoutingController({ invoke: ipc.fn })
  c.refresh(); await flush()
  ipc.resolve(0, routingSnap()); await flush()

  c.setTarget(Q.routeKey("global", "default"), "beta,b1")
  c.saveRow(Q.routeKey("global", "default"))
  await flush()
  assert.equal(ipc.calls[1].cmd, "routing_save")
  assert.deepEqual(plain(ipc.calls[1].args.change), {
    revision: "rev-1", scope: "global", field: "default", target: "beta,b1", fallback: null,
  }, "untouched fallback stays null so the server preserves it")
  // Server response reflects the applied change, like the real backend.
  ipc.resolve(1, bumpRev(applyRoutingChange(routingSnap(), plain(ipc.calls[1].args.change))))
  await flush()
  const s = c.state()
  assert.equal(s.snapshot.revision, "rev-2")
  assert.deepEqual(plain(s.dirtyKeys), [], "saved draft is dropped once it matches the server")
  assert.ok(s.savedFlash && s.savedFlash.key === Q.routeKey("global", "default"))

  // clearing: empty target -> null target (clear override)
  c.setTarget(Q.routeKey("global", "default"), "   ")
  c.saveRow(Q.routeKey("global", "default"))
  await flush()
  assert.equal(ipc.calls[2].args.change.target, null)
})

test("routing: edited fallback list is sent; untouched target keeps canonical value", async () => {
  const ipc = fakeInvoke()
  const c = Q.createRoutingController({ invoke: ipc.fn })
  c.refresh(); await flush()
  ipc.resolve(0, routingSnap()); await flush()
  const key = Q.routeKey("global", "default")

  const dup = c.addFallback(key, "beta,b1")
  assert.equal(dup.ok, false, "duplicate against canonical fallback rejected")
  const empty = c.addFallback(key, "   ")
  assert.equal(empty.ok, false, "empty fallback entry rejected")

  assert.ok(c.addFallback(key, "alpha,a2").ok)
  assert.equal(c.addFallback(key, "alpha,a2").ok, false, "duplicate against edited draft rejected")
  c.moveFallback(key, 1, -1) // move alpha,a2 up
  c.saveRow(key)
  await flush()
  assert.deepEqual(plain(ipc.calls[1].args.change), {
    revision: "rev-1", scope: "global", field: "default", target: "alpha,a1", fallback: ["alpha,a2", "beta,b1"],
  }, "fallback order follows the move; untouched target is sent as the canonical value")
})

test("routing: move/remove bounds are safe and undo restores canonical values", async () => {
  const ipc = fakeInvoke()
  const c = Q.createRoutingController({ invoke: ipc.fn })
  c.refresh(); await flush()
  ipc.resolve(0, routingSnap()); await flush()
  const key = Q.routeKey("global", "default")
  c.moveFallback(key, 0, -1)
  c.moveFallback(key, 5, 1)
  c.removeFallback(key, 9)
  assert.deepEqual(plain(c.state().dirtyKeys), [], "out-of-bounds ops are no-ops")
  assert.ok(c.addFallback(key, "alpha,a2").ok)
  c.moveFallback(key, 1, -1)
  assert.deepEqual(plain(c.state().draft(key).fallback), ["alpha,a2", "beta,b1"])
  c.removeFallback(key, 0)
  assert.deepEqual(plain(c.state().draft(key).fallback), ["beta,b1"])
  c.resetDraft(key)
  assert.deepEqual(plain(c.state().dirtyKeys), [])
  assert.deepEqual(plain(c.state().draftKeys), [], "reset removes the draft entirely")
})

test("routing: drafts survive refresh; clean drafts are dropped; conflict keeps draft and aborts queue", async () => {
  const ipc = fakeInvoke()
  const c = Q.createRoutingController({ invoke: ipc.fn })
  c.refresh(); await flush()
  ipc.resolve(0, routingSnap()); await flush()
  const def = Q.routeKey("global", "default")
  const think = Q.routeKey("global", "think")

  // dirty draft + clean draft (same value as server)
  c.setTarget(def, "beta,b1")
  c.setTarget(think, "alpha,a1") // think canonical target is null, so this is dirty
  c.setTarget(Q.routeKey("opus", "default"), "alpha,a2") // equals canonical -> clean
  c.refresh(); await flush()
  ipc.resolve(1, routingSnap({ revision: "rev-2" })); await flush()
  const s1 = c.state()
  assert.equal(s1.snapshot.revision, "rev-2")
  assert.deepEqual(plain(s1.dirtyKeys).sort(), [def, think].sort(), "dirty drafts survive refresh")
  assert.equal(plain(s1.dirtyKeys).includes(Q.routeKey("opus", "default")), false, "clean draft dropped on refresh")

  // save with stale revision -> conflict error, draft kept, queued sibling aborted
  c.setTarget(def, "alpha,a1x")
  c.setTarget(think, "beta,b1")
  c.saveRow(def)
  c.saveRow(think)
  await flush()
  assert.equal(ipc.calls.length, 3, "two snapshots + only the first queued save")
  assert.equal(ipc.calls[2].cmd, "routing_save")
  ipc.reject(2, new Error("路由配置已被其他程序修改，请刷新后重试"))
  await flush()
  const s2 = c.state()
  assert.equal(s2.saveError.key, def)
  assert.equal(s2.saveError.message, "路由配置已被其他程序修改，请刷新后重试")
  assert.deepEqual(plain(s2.dirtyKeys).sort(), [def, think].sort(), "conflict must not silently drop edits")
  assert.equal(s2.savingKey, null)
  assert.deepEqual(plain(s2.queued), [])
})

test("routing: saves serialize; second save uses the revision from the first response", async () => {
  const ipc = fakeInvoke()
  const c = Q.createRoutingController({ invoke: ipc.fn })
  c.refresh(); await flush()
  ipc.resolve(0, routingSnap()); await flush()
  c.setTarget(Q.routeKey("global", "default"), "beta,b1")
  c.setTarget(Q.routeKey("opus", "default"), "beta,b1")
  c.saveRow(Q.routeKey("global", "default"))
  c.saveRow(Q.routeKey("opus", "default"))
  await flush()
  assert.equal(ipc.calls[1].args.change.revision, "rev-1")
  assert.equal(ipc.calls.length, 2, "second save waits for the first")
  ipc.resolve(1, bumpRev(applyRoutingChange(routingSnap(), plain(ipc.calls[1].args.change))))
  await flush()
  assert.equal(ipc.calls[2].args.change.revision, "rev-2", "queued save picked up the new revision")
  const afterFirst = applyRoutingChange(routingSnap(), plain(ipc.calls[1].args.change))
  ipc.resolve(2, bumpRev(bumpRev(applyRoutingChange(afterFirst, plain(ipc.calls[2].args.change)))))
  await flush()
  assert.deepEqual(plain(c.state().dirtyKeys), [])
  assert.equal(c.state().snapshot.revision, "rev-3")
})

test("routing: flags payload carries both flags and revision; failure keeps canonical state", async () => {
  const ipc = fakeInvoke()
  const c = Q.createRoutingController({ invoke: ipc.fn })
  c.refresh(); await flush()
  ipc.resolve(0, routingSnap()); await flush()
  assert.equal(c.setFlag("familyRouting", false), true)
  await flush()
  assert.deepEqual(plain(ipc.calls[1].args), { revision: "rev-1", familyRouting: false, fallbackEnabled: true })
  ipc.resolve(1, { ...routingSnap(), familyRouting: false, revision: "rev-2" })
  await flush()
  assert.equal(c.state().snapshot.familyRouting, false)
  assert.equal(c.state().snapshot.fallbackEnabled, true)

  assert.equal(c.setFlag("fallbackEnabled", false), true)
  await flush()
  ipc.reject(2, new Error("网关超时"))
  await flush()
  const s = c.state()
  assert.equal(s.flagsError, "网关超时")
  assert.equal(s.flagsSaving, false)
  assert.equal(s.snapshot.fallbackEnabled, true, "failed toggle did not mutate canonical state")
  assert.equal(c.setFlag("bogus", true), false)
  assert.equal(c.setFlag("familyRouting", "yes"), false)
})

test("routing: createAlias validates, drafts and saves; identical alias is rejected", async () => {
  const ipc = fakeInvoke()
  const c = Q.createRoutingController({ invoke: ipc.fn })
  c.refresh(); await flush()
  ipc.resolve(0, routingSnap()); await flush()
  assert.deepEqual(plain(c.createAlias("", "alpha,a1")), { ok: false, message: "请输入模型别名" })
  assert.equal(c.createAlias("a|b", "alpha,a1").ok, false)
  assert.deepEqual(plain(c.createAlias("glm-5", "beta,b1")), { ok: false, message: "该别名已是当前配置" })
  assert.equal(ipc.calls.length, 1, "rejections never hit IPC")
  assert.ok(c.createAlias("kimi", "beta,b1").ok)
  await flush()
  assert.equal(ipc.calls[1].cmd, "routing_save")
  assert.deepEqual(plain(ipc.calls[1].args.change), {
    revision: "rev-1", scope: "models", field: "kimi", target: "beta,b1", fallback: null,
  })
  ipc.resolve(1, bumpRev(applyRoutingChange(routingSnap(), plain(ipc.calls[1].args.change))))
  await flush()
  assert.deepEqual(plain(c.state().dirtyKeys), [])
  assert.ok(findIn(c.state().snapshot.routes, "models", "kimi"), "new alias exists on the adopted snapshot")
})
function findIn(routes, scope, field) {
  return routes.find((r) => r.scope === scope && r.field === field) || null
}

test("routing: editing a saved row clears its saved flash", async () => {
  const ipc = fakeInvoke()
  const c = Q.createRoutingController({ invoke: ipc.fn })
  c.refresh(); await flush()
  ipc.resolve(0, routingSnap()); await flush()
  const key = Q.routeKey("global", "default")
  c.setTarget(key, "beta,b1")
  c.saveRow(key); await flush()
  ipc.resolve(1, bumpRev(applyRoutingChange(routingSnap(), plain(ipc.calls[1].args.change)))); await flush()
  assert.ok(c.state().savedFlash)
  c.setTarget(key, "beta,b1 ")
  assert.equal(c.state().savedFlash, null)
})

test("routing: refresh failure keeps snapshot and surfaces error", async () => {
  const ipc = fakeInvoke()
  const c = Q.createRoutingController({ invoke: ipc.fn })
  c.refresh(); await flush()
  ipc.reject(0, new Error("网关离线"))
  await flush()
  const s = c.state()
  assert.equal(s.snapshot, null)
  assert.equal(s.error, "网关离线")
  assert.equal(s.loading, false)
})

test("routing: missing invoke throws (no silent mock)", () => {
  assert.throws(() => Q.createRoutingController({}))
})

// ---------------- usage ----------------

test("usage: normalizeUsageSnapshot whitelists contract fields only", () => {
  const u = Q.normalizeUsageSnapshot({
    period: "7d", totalRequests: 10, successCount: 8, errorCount: 2,
    inputTokens: 100, outputTokens: 50, cacheReadTokens: 5, cacheWriteTokens: 6, estimatedCount: 1,
    avgTtftMs: 812, avgTokensPerSecond: 33.4,
    byModel: [{ name: "model-a", requests: 10, inputTokens: 100, outputTokens: 50, cacheReadTokens: 5, cacheWriteTokens: 6, secret: "sekret" }],
    byProvider: [{ name: "a", requests: 10, inputTokens: 100, outputTokens: 50, cost: 9.9 }],
    byDay: [{ name: "2026-11-17", requests: 10, inputTokens: 100, outputTokens: 50 }],
    updatedAt: 123, secret: "x",
  })
  assert.deepEqual(plain(u), {
    period: "7d", totalRequests: 10, successCount: 8, errorCount: 2,
    inputTokens: 100, outputTokens: 50, cacheReadTokens: 5, cacheWriteTokens: 6, estimatedCount: 1,
    avgTtftMs: 812, avgTokensPerSecond: 33.4,
    byModel: [{ name: "model-a", requests: 10, inputTokens: 100, outputTokens: 50, cacheReadTokens: 5, cacheWriteTokens: 6 }],
    byProvider: [{ name: "a", requests: 10, inputTokens: 100, outputTokens: 50, cacheReadTokens: null, cacheWriteTokens: null }],
    byDay: [{ name: "2026-11-17", requests: 10, inputTokens: 100, outputTokens: 50, cacheReadTokens: null, cacheWriteTokens: null }],
    updatedAt: 123,
  })
  assert.equal(JSON.stringify(u).includes("cost"), false, "no fabricated cost fields")
  assert.deepEqual(plain(Q.normalizeUsageSnapshot(null)).byProvider, [])
  // Older gateways without the optional TTFT/speed fields stay compatible.
  const legacy = Q.normalizeUsageSnapshot({ period: "today", totalRequests: 1 })
  assert.equal(legacy.avgTtftMs, null)
  assert.equal(legacy.avgTokensPerSecond, null)
})

test("usage: period picker loads the requested period; invalid ignored; latest period wins", async () => {
  const ipc = fakeInvoke()
  const c = Q.createUsageController({ invoke: ipc.fn })
  assert.throws(() => Q.createUsageController({}))
  c.setPeriod("bogus")
  assert.equal(ipc.calls.length, 0, "invalid period never hits IPC")
  c.refresh()
  await flush()
  assert.deepEqual(plain(ipc.calls[0]), { cmd: "usage_snapshot", args: { period: "today" } })
  ipc.resolve(0, { period: "today", totalRequests: 1 }); await flush()
  assert.equal(c.state().snapshot.totalRequests, 1)
  c.setPeriod("7d"); await flush()
  assert.deepEqual(plain(ipc.calls[1].args), { period: "7d" })
  c.setPeriod("30d"); await flush()
  ipc.reject(2, new Error("slow"))
  ipc.resolve(1, { period: "7d", totalRequests: 99 })
  await flush()
  assert.equal(c.state().snapshot.period, "today", "failed load keeps the last complete snapshot")
  assert.equal(c.state().error, "slow")
  assert.equal(c.state().period, "30d")
  assert.equal(JSON.stringify(c.state().snapshot).includes("99"), false, "stale period response must not land")
})

// ---------------- usage records ----------------

test("formatMs/formatSpeed/formatSuccessRate follow the summary-card contract", () => {
  assert.equal(Q.formatMs(820), "820ms")
  assert.equal(Q.formatMs(1200), "1.2s")
  assert.equal(Q.formatMs(30000), "30.0s")
  assert.equal(Q.formatMs(150000), "2.5m")
  assert.equal(Q.formatMs(0), "0ms")
  assert.equal(Q.formatMs(null), null)
  assert.equal(Q.formatSpeed(35.66), "35.7 t/s")
  assert.equal(Q.formatSpeed(33), "33.0 t/s")
  assert.equal(Q.formatSpeed(null), null)
  assert.equal(Q.formatSuccessRate(125, 128), "97.7%")
  assert.equal(Q.formatSuccessRate(8, 10), "80.0%")
  assert.equal(Q.formatSuccessRate(0, 0), null, "total=0 has no success rate")
  assert.equal(Q.formatSuccessRate(null, 10), null)
  assert.equal(Q.formatSuccessRate(5, null), null)
})

test("records: normalizeRecord whitelists fields; responseBody/sessionId never reach render data", () => {
  const r = Q.normalizeRecord({
    timestamp: "2026-11-17T09:05:03Z", provider: "alpha", model: "m1",
    originalModel: "m0", upstreamModel: "m2", clientType: "claude-code", scenarioType: "think",
    inputTokens: 10, outputTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 2,
    ttftMs: 300, tokensPerSecond: 42.5, durationMs: 1500,
    status: "error", usageEstimated: true, errorMessage: "boom",
    responseBody: "SECRET-BODY", sessionId: "session-1", apiKey: "k", id: "rec-1",
  })
  assert.deepEqual(plain(r), {
    timestamp: "2026-11-17T09:05:03Z", provider: "alpha", model: "m1",
    originalModel: "m0", upstreamModel: "m2", clientType: "claude-code", scenarioType: "think",
    inputTokens: 10, outputTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 2,
    ttftMs: 300, tokensPerSecond: 42.5, durationMs: 1500,
    status: "error", usageEstimated: true, errorMessage: "boom",
  })
  assert.equal(JSON.stringify(r).includes("SECRET-BODY"), false)
  assert.equal(JSON.stringify(r).includes("session-1"), false)
  assert.equal(Q.normalizeRecord(null).status, "success", "missing record never renders as error")
  assert.equal(Q.normalizeRecord({ status: "weird" }).status, "success", "unknown status downgrades to success")
  assert.equal(Q.normalizeRecord({}).provider, "—")
})

test("records: normalizeRecordsPage coerces the envelope; non-array records are dropped", () => {
  const p = Q.normalizeRecordsPage({ period: "7d", page: 2, pageSize: 20, total: 45, records: [{ model: "m1" }], junk: 1 })
  assert.equal(p.period, "7d")
  assert.equal(p.page, 2)
  assert.equal(p.pageSize, 20)
  assert.equal(p.total, 45)
  assert.equal(p.records.length, 1)
  assert.deepEqual(plain(Q.normalizeRecordsPage(null)), { period: null, page: null, pageSize: null, total: null, records: [] })
  assert.deepEqual(plain(Q.normalizeRecordsPage({ records: "nope" }).records), [])
})

test("records: modelChain dedupes adjacent legs and joins with arrows", () => {
  assert.equal(Q.modelChain({ originalModel: "a", model: "a", upstreamModel: "a" }), "a")
  assert.equal(Q.modelChain({ originalModel: "opus", model: "glm-5", upstreamModel: "glm-5-air" }), "opus → glm-5 → glm-5-air")
  assert.equal(Q.modelChain({ originalModel: "opus", model: "glm-5", upstreamModel: "glm-5" }), "opus → glm-5", "upstream equal to routed collapses")
  assert.equal(Q.modelChain({ originalModel: null, model: "m", upstreamModel: null }), "m")
  assert.equal(Q.modelChain({}), "—")
  assert.equal(Q.modelChain(null), "—")
})

test("records: topModelsByTotal ranks by input+output descending and truncates", () => {
  const rows = [
    { name: "small", requests: 99, inputTokens: 10, outputTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 1 },
    { name: "big", requests: 1, inputTokens: 800, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 },
    { name: "mid", requests: 50, inputTokens: 100, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
  ]
  assert.deepEqual(Q.topModelsByTotal(rows, 2).map((m) => m.name), ["big", "mid"])
  assert.equal(Q.topModelsByTotal(rows).length, 3)
  assert.equal(Q.topModelsByTotal(rows, 10).length, 3)
  assert.equal(Q.topModelsByTotal([], 10).length, 0)
  assert.equal(Q.topModelsByTotal(null, 10).length, 0)
})

test("records: clientLabel maps known client types and passes unknown through", () => {
  assert.equal(Q.clientLabel("claude-code"), "Claude Code")
  assert.equal(Q.clientLabel("codex"), "Codex")
  assert.equal(Q.clientLabel("mystery-client"), "mystery-client")
  assert.equal(Q.clientLabel(null), "未知")
  assert.equal(Q.clientLabel(""), "未知")
})

test("records: first load sends page 1 with fixed pageSize; invalid period and missing invoke rejected", async () => {
  const ipc = fakeInvoke()
  const c = Q.createRecordsController({ invoke: ipc.fn })
  assert.throws(() => Q.createRecordsController({}))
  c.setPeriod("bogus")
  c.prev()
  c.next()
  assert.equal(ipc.calls.length, 0, "invalid period and empty data never hit IPC")
  c.refresh()
  await flush()
  assert.deepEqual(plain(ipc.calls[0]), { cmd: "usage_records", args: { period: "today", page: 1, pageSize: 20 } })
  ipc.resolve(0, { period: "today", page: 1, pageSize: 20, total: 45, records: [{ model: "m1" }] })
  await flush()
  const s = c.state()
  assert.equal(s.data.total, 45)
  assert.equal(s.totalPages, 3)
  assert.equal(s.canPrev, false)
  assert.equal(s.canNext, true)
})

test("records: next/prev walk pages, bounds are no-ops, period switch resets to page 1", async () => {
  const ipc = fakeInvoke()
  const c = Q.createRecordsController({ invoke: ipc.fn })
  c.refresh(); await flush()
  ipc.resolve(0, { period: "today", page: 1, pageSize: 20, total: 45, records: [] }); await flush()

  c.prev(); await flush()
  assert.equal(ipc.calls.length, 1, "prev on the first page is a local no-op")
  c.next(); await flush()
  assert.deepEqual(plain(ipc.calls.at(-1).args), { period: "today", page: 2, pageSize: 20 })
  ipc.resolve(1, { period: "today", page: 2, pageSize: 20, total: 45, records: [] }); await flush()
  assert.equal(c.state().page, 2)
  c.next(); await flush()
  ipc.resolve(2, { period: "today", page: 3, pageSize: 20, total: 45, records: [] }); await flush()
  assert.equal(c.state().canNext, false, "last page disables next")
  const callsBefore = ipc.calls.length
  c.next(); await flush()
  assert.equal(ipc.calls.length, callsBefore, "next past the last page is a local no-op")

  c.setPeriod("7d"); await flush()
  assert.deepEqual(plain(ipc.calls.at(-1).args), { period: "7d", page: 1, pageSize: 20 }, "period switch resets to page 1")
  ipc.resolve(3, { period: "7d", page: 1, pageSize: 20, total: 3, records: [{ model: "m2" }] }); await flush()
  assert.equal(c.state().totalPages, 1)
  assert.equal(c.state().canNext, false)

  // A superseded response (older epoch) must never land.
  c.setPeriod("30d"); await flush()
  const staleIndex = ipc.calls.length - 1
  c.refresh()
  const freshIndex = ipc.calls.length - 1
  ipc.resolve(freshIndex, { period: "30d", page: 1, pageSize: 20, total: 9, records: [{ model: "fresh" }] })
  await flush()
  ipc.resolve(staleIndex, { period: "30d", page: 1, pageSize: 20, total: 999, records: [{ model: "stale" }] })
  await flush()
  const s = c.state()
  assert.equal(s.data.total, 9)
  assert.equal(s.data.records[0].model, "fresh")
})

test("records: transport failure keeps the previous page and surfaces the error", async () => {
  const ipc = fakeInvoke()
  const c = Q.createRecordsController({ invoke: ipc.fn })
  c.refresh(); await flush()
  ipc.resolve(0, { period: "today", page: 1, pageSize: 20, total: 45, records: [{ model: "m1" }] }); await flush()
  c.next(); await flush()
  ipc.reject(1, new Error("网关超时"))
  await flush()
  const s = c.state()
  assert.equal(s.error, "网关超时")
  assert.equal(s.loading, false)
  assert.equal(s.data.records[0].model, "m1", "failed load keeps the last complete page")
  assert.equal(s.canPrev, true)
})

// ---------------- clients ----------------

test("clients: normalizeClientsResponse defaults enabled=false, exists=true, success=true", () => {
  const r = Q.normalizeClientsResponse({
    clients: [{ id: "codex", name: "Codex", enabled: true, managed: true, activeModel: "gpt-5", junk: 1 }],
    message: "partial", success: false,
  })
  assert.deepEqual(plain(r), {
    clients: [{ id: "codex", name: "Codex", enabled: true, managed: true, exists: true, activeModel: "gpt-5", modelAlias: null }],
    success: false, message: "partial",
  })
  assert.deepEqual(plain(Q.normalizeClientsResponse(null)), { clients: [], success: true, message: null })
})

test("clients: snapshot loads the five known ids and surfaces partial failure message", async () => {
  const ipc = fakeInvoke()
  const c = Q.createClientsController({ invoke: ipc.fn })
  c.refresh(); await flush()
  assert.equal(ipc.calls[0].cmd, "clients_snapshot")
  const five = ["claudeCode", "codex", "pi", "qwenCode", "opencode"]
  ipc.resolve(0, { clients: five.map((id) => ({ id, name: id, enabled: false, managed: true, exists: true })), success: false, message: "pi 状态读取失败" })
  await flush()
  const s = c.state()
  assert.deepEqual(plain(s.snapshot.clients.map((x) => x.id)), five)
  assert.equal(s.snapshot.success, false)
})

test("clients: connect/disconnect are individual updates with pending guard", async () => {
  const ipc = fakeInvoke()
  const c = Q.createClientsController({ invoke: ipc.fn })
  c.refresh(); await flush()
  ipc.resolve(0, { clients: [
    { id: "claudeCode", name: "Claude Code", enabled: false, managed: true, exists: true },
    { id: "codex", name: "Codex", enabled: true, managed: true, exists: true },
  ] }); await flush()

  assert.ok(c.connect("claudeCode"))
  assert.equal(c.connect("codex"), false, "one operation at a time")
  await flush()
  assert.deepEqual(plain(ipc.calls[1].args), { id: "claudeCode", action: "enable" })
  ipc.resolve(1, { clients: [{ id: "claudeCode", name: "Claude Code", enabled: true, managed: true, exists: true }] })
  await flush()
  assert.equal(c.state().pending, null)
  assert.equal(c.state().snapshot.clients[0].enabled, true)

  assert.ok(c.disconnect("claudeCode"))
  await flush()
  assert.deepEqual(plain(ipc.calls[2].args), { id: "claudeCode", action: "disable" })
  ipc.resolve(2, { clients: [{ id: "claudeCode", name: "Claude Code", enabled: false, managed: true, exists: true }] })
  await flush()
  assert.equal(c.state().snapshot.clients[0].enabled, false)
})

test("clients: restore requires explicit confirmation and never auto-enables", async () => {
  const ipc = fakeInvoke()
  const c = Q.createClientsController({ invoke: ipc.fn })
  c.refresh(); await flush()
  ipc.resolve(0, { clients: [{ id: "pi", name: "Pi", enabled: true, managed: true, exists: true }] }); await flush()

  assert.equal(c.confirmRestore("pi"), false, "no restore without requestRestore")
  assert.ok(c.requestRestore("pi"))
  assert.equal(c.state().confirmId, "pi")
  assert.equal(c.connect("pi"), false, "open confirmation blocks other operations")
  assert.ok(c.cancelRestore(), "cancel clears")
  assert.equal(c.state().confirmId, null)
  assert.equal(ipc.calls.length, 1, "cancel never invokes")

  assert.ok(c.requestRestore("pi"))
  assert.ok(c.confirmRestore("pi"))
  await flush()
  assert.deepEqual(plain(ipc.calls[1].args), { id: "pi", action: "restore" })
  ipc.resolve(1, { clients: [{ id: "pi", name: "Pi", enabled: false, managed: false, exists: true }] })
  await flush()
  const restored = c.state().snapshot.clients[0]
  assert.equal(restored.enabled, false, "restore does not auto-enable")
  assert.equal(restored.managed, false)
})

test("clients: unknown ids and unmanaged restore are rejected locally without IPC", async () => {
  const ipc = fakeInvoke()
  const c = Q.createClientsController({ invoke: ipc.fn })
  c.refresh(); await flush()
  ipc.resolve(0, { clients: [{ id: "codex", name: "Codex", enabled: false, managed: false, exists: true }] }); await flush()
  assert.equal(c.connect("randomClient"), false)
  assert.equal(c.requestRestore("codex"), false, "restore requires managed state")
  assert.equal(ipc.calls.length, 1)
})

test("clients: transport failure keeps the previous list and marks the row error", async () => {
  const ipc = fakeInvoke()
  const c = Q.createClientsController({ invoke: ipc.fn })
  c.refresh(); await flush()
  ipc.resolve(0, { clients: [{ id: "codex", name: "Codex", enabled: true, managed: true, exists: true }] }); await flush()
  c.disconnect("codex"); await flush()
  ipc.reject(1, new Error("写入失败"))
  await flush()
  const s = c.state()
  assert.equal(s.rowError.id, "codex")
  assert.equal(s.rowError.message, "写入失败")
  assert.equal(s.pending, null)
  assert.equal(s.snapshot.clients[0].enabled, true, "previous state retained")
  assert.equal(s.error, null)
})

test("clients: success=false response surfaces the message as row error", async () => {
  const ipc = fakeInvoke()
  const c = Q.createClientsController({ invoke: ipc.fn })
  c.refresh(); await flush()
  ipc.resolve(0, { clients: [{ id: "pi", name: "Pi", enabled: false, managed: true, exists: true }] }); await flush()
  c.connect("pi"); await flush()
  ipc.resolve(1, { clients: [{ id: "pi", name: "Pi", enabled: true, managed: true, exists: true }], success: false, message: "pi 配置写入被拒绝" })
  await flush()
  assert.equal(c.state().rowError.message, "pi 配置写入被拒绝")
})

// ---------------- service ----------------

test("service: normalizeServiceState whitelists modes", () => {
  assert.deepEqual(plain(Q.normalizeServiceState({ mode: "owned", running: true, message: "" })), { mode: "owned", running: true, message: null })
  assert.equal(Q.normalizeServiceState({ mode: "possessed" }).mode, null)
  assert.deepEqual(plain(Q.normalizeServiceState(null)), { mode: null, running: false, message: null })
})

test("service: serviceView gates start/stop per mode (external stop never offered)", () => {
  const ownedRunning = Q.serviceView({ mode: "owned", running: true, message: "" })
  assert.equal(ownedRunning.canStart, false)
  assert.equal(ownedRunning.canStop, true)
  const external = Q.serviceView({ mode: "external", running: true, message: "" })
  assert.equal(external.canStop, false, "external services are never stoppable from the UI")
  assert.equal(external.canStart, false)
  assert.ok(external.stopTitle.includes("外部"))
  const stopped = Q.serviceView({ mode: "stopped", running: false, message: "" })
  assert.equal(stopped.canStart, true)
  assert.equal(stopped.canStop, false)
  const starting = Q.serviceView({ mode: "starting", running: false, message: "" })
  assert.equal(starting.canStart, false)
  assert.equal(starting.canStop, false)
  const errored = Q.serviceView({ mode: "error", running: false, message: "boom" })
  assert.equal(errored.canStart, true, "error state allows a retry start")
  assert.equal(errored.canStop, false)
  const unknown = Q.serviceView(null)
  assert.equal(unknown.canStart, false)
  assert.equal(unknown.canStop, false)
})

test("service: quit wording reflects ownership (external unaffected, owned stopped)", () => {
  assert.ok(Q.quitTitleFor({ mode: "external", running: true, message: "" }).includes("不受影响"))
  assert.ok(Q.quitTitleFor({ mode: "owned", running: true, message: "" }).includes("一并停止"))
  assert.ok(Q.quitTitleFor(null).includes("一并停止"))
})

test("service: action pending guard, success adopts response, failure keeps state + error", async () => {
  const ipc = fakeInvoke()
  const c = Q.createServiceController({ invoke: ipc.fn })
  assert.throws(() => Q.createServiceController({}))
  c.refresh(); await flush()
  ipc.resolve(0, { mode: "owned", running: true, message: "" }); await flush()
  assert.ok(c.action("stop"))
  assert.equal(c.action("start"), false, "no second action while pending")
  assert.equal(c.action("reboot"), false)
  await flush()
  assert.deepEqual(plain(ipc.calls[1].args), { action: "stop" })
  ipc.resolve(1, { mode: "stopped", running: false, message: "" })
  await flush()
  assert.equal(c.state().service.mode, "stopped")
  assert.ok(c.action("start")); await flush()
  ipc.reject(2, new Error("启动失败：端口被占用"))
  await flush()
  const s = c.state()
  assert.equal(s.pending, null)
  assert.equal(s.error, "启动失败：端口被占用")
  assert.equal(s.service.mode, "stopped", "failed start keeps the previous state")
})

test("service: refresh failure surfaces error without fabricating state", async () => {
  const ipc = fakeInvoke()
  const c = Q.createServiceController({ invoke: ipc.fn })
  c.refresh(); await flush()
  ipc.reject(0, new Error("IPC 不可用"))
  await flush()
  const s = c.state()
  assert.equal(s.service, null, "no fake state on failure")
  assert.equal(s.error, "IPC 不可用")
})

// ---------------- shared formatting ----------------

test("format helpers: formatInt/formatCompact/formatClock stay pure", () => {
  assert.equal(Q.formatInt(1234567), "1,234,567")
  assert.equal(Q.formatInt(null), null)
  assert.equal(Q.formatCompact(123456789), "123.46M")
  assert.equal(Q.formatCompact(12345), "12.35K")
  assert.equal(Q.formatCompact(90205000), "90.21M")
  assert.equal(Q.formatCompact(380000000), "380M")
  assert.equal(Q.formatCompact(1234567890), "1.23B")
  assert.equal(Q.formatCompact(999994), "999.99K")
  assert.equal(Q.formatCompact(999995), "1M")
  assert.equal(Q.formatCompact(999995000), "1B")
  assert.equal(Q.formatCompact(1000), "1K")
  assert.equal(Q.formatCompact(1005), "1.01K")
  assert.equal(Q.formatCompact(1005000), "1.01M")
  assert.equal(Q.formatCompact(1005000000), "1.01B")
  assert.equal(Q.formatCompact(0), "0")
  assert.equal(Q.formatCompact(NaN), null)
  assert.equal(Q.formatCompact(999), "999")
  assert.equal(Q.formatCompact(null), null)
  const t = new Date(2026, 10, 17, 9, 5, 3).getTime()
  assert.equal(Q.formatClock(t), "09:05:03")
  assert.equal(Q.formatClock(null), null)
})

test('routing: refresh and flags cannot invalidate an active save; edits during save survive', async () => {
  const ipc = fakeInvoke(); const c = Q.createRoutingController({ invoke: ipc.fn });
  c.refresh(); ipc.resolve(0, routingSnap()); await flush();
  const key = Q.routeKey('global', 'default');
  c.setTarget(key, 'beta,b1'); c.saveRow(key);
  c.refresh(); assert.equal(c.setFlag('familyRouting', false), false);
  assert.equal(ipc.calls.length, 2);
  c.setTarget(key, 'alpha,a2');
  ipc.resolve(1, bumpRev(applyRoutingChange(routingSnap(), plain(ipc.calls[1].args.change)))); await flush();
  assert.equal(c.state().savingKey, null);
  assert.equal(c.state().draft(key).target, 'alpha,a2');
  assert.equal(c.state().isClean(key), false);
});

test('clients and service: refresh cannot supersede mutation; external stop never invokes', async () => {
  const ipc = fakeInvoke(); const c = Q.createClientsController({ invoke: ipc.fn });
  c.refresh(); ipc.resolve(0, { clients: [{ id: 'pi', enabled: false, managed: true, exists: true }] }); await flush();
  c.connect('pi'); c.refresh(); assert.equal(ipc.calls.length, 2);
  ipc.resolve(1, { clients: [{ id: 'pi', enabled: true, managed: true, exists: true }] }); await flush();
  assert.equal(c.state().pending, null);
  const svc = fakeInvoke(); const s = Q.createServiceController({ invoke: svc.fn });
  s.refresh(); svc.resolve(0, { mode: 'external', running: true, message: '' }); await flush();
  assert.equal(s.action('stop'), false); assert.equal(svc.calls.length, 1);
  s.refresh(); svc.resolve(1, { mode: 'owned', running: true, message: '' }); await flush();
  assert.equal(s.action('stop'), true); s.refresh(); assert.equal(svc.calls.length, 3);
  svc.resolve(2, { mode: 'stopped', running: false, message: '' }); await flush();
  assert.equal(s.state().pending, null);
});
