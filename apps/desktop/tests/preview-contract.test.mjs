// Contract and wiring tests:
// 1) The ?preview=1 mock covers every desktop IPC command with complete,
//    contract-shaped fixtures (docs/design/desktop-control-center.md).
// 2) quota.html/quota.js stay consistent: every id used from JS exists,
//    scripts are external only (CSP script-src 'self'), tabs and labels match.
// Run: node --test apps/desktop/tests/preview-contract.test.mjs
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import vm from "node:vm"

const here = path.dirname(fileURLToPath(import.meta.url))
const js = readFileSync(path.join(here, "..", "src", "quota.js"), "utf8")
const pluginsJs = readFileSync(path.join(here, "..", "src", "plugins.js"), "utf8")
const html = readFileSync(path.join(here, "..", "src", "quota.html"), "utf8")

const sandbox = { setTimeout, URL, TextEncoder }
vm.createContext(sandbox)
new vm.Script(pluginsJs, { filename: "plugins.js" }).runInContext(sandbox)
new vm.Script(js, { filename: "quota.js" }).runInContext(sandbox)
const Q = sandbox.QuotaUI
assert.ok(Q && typeof Q.createPreviewInvoke === "function", "QuotaUI.createPreviewInvoke must exist")

const ROUTE_KEYS = ["providers", "routes", "familyRouting", "fallbackEnabled", "revision"]
const ROUTE_ENTRY_KEYS = ["scope", "field", "target", "fallback"]
const USAGE_KEYS = [
  "period", "totalRequests", "successCount", "errorCount",
  "inputTokens", "effectiveInputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "estimatedCount",
  "avgTtftMs", "avgTokensPerSecond",
  "byModel", "byProvider", "byDay", "updatedAt",
]
const USAGE_ROW_KEYS = ["name", "requests", "inputTokens", "effectiveInputTokens", "outputTokens"]
const RECORDS_PAGE_KEYS = ["period", "page", "pageSize", "total", "records"]
const RECORD_KEYS = [
  "timestamp", "provider", "model", "originalModel", "upstreamModel",
  "clientType", "scenarioType", "inputTokens", "effectiveInputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens",
  "ttftMs", "tokensPerSecond", "durationMs", "status", "usageEstimated", "errorMessage",
]
const RECORDS_BANNED = ["responseBody", "sessionId", "apiKey", "secret"]
const CLIENT_KEYS = ["id", "name", "enabled", "managed", "exists", "activeModel", "modelAlias"]
const CLIENT_RESPONSE_KEYS = ["clients", "success", "message"]
const CLIENT_IDS = ["claudeCode", "codex", "pi", "qwenCode", "opencode"]
const SERVICE_KEYS = ["mode", "running", "message"]
const SERVICE_MODES = ["owned", "external", "stopped", "starting", "error"]
const FIVE_IDS = CLIENT_IDS

test('login startup reads the OS setting, confirms writes and recovers after failure', async () => {
  const preview = Q.createPreviewInvoke()
  const calls = []
  let fail = ''
  const invoke = async (command, args) => {
    calls.push(command)
    if (command === fail) throw Error('unavailable')
    return preview(command, args)
  }
  const toggle = { disabled: true, addEventListener(event, handler) { assert.equal(event, 'change'); this.change = handler } }
  const message = {}
  const refresh = Q.bindAutostart(invoke, toggle, message)
  await refresh()
  assert.deepEqual(calls, ['login_start_status'])
  assert.equal(toggle.checked, false)
  toggle.checked = true
  await toggle.change()
  assert.equal(toggle.checked, true)
  assert.equal(message.textContent, '')
  fail = 'login_start_set'
  toggle.checked = false
  await toggle.change()
  assert.equal(toggle.checked, true)
  assert.match(message.textContent, /未能更改/)
  fail = 'login_start_status'
  await refresh()
  assert.equal(toggle.disabled, true)
  assert.equal(toggle.indeterminate, true)
  fail = ''
  await refresh()
  assert.equal(toggle.disabled, false)
  toggle.checked = false
  await toggle.change()
  assert.equal(toggle.checked, false)
  assert.equal(toggle.indeterminate, false)
})

async function previewCall(invoke, cmd, args) {
  const r = invoke(cmd, args)
  assert.ok(r && typeof r.then === "function", `${cmd} must return a promise`)
  return r
}

// Deep shape validators: every contract field must be present with the right type.
function assertRoutingSnapshot(s, label) {
  for (const k of ROUTE_KEYS) assert.ok(k in s, `${label}: missing ${k}`)
  assert.ok(Array.isArray(s.providers) && s.providers.length > 0, `${label}: providers listed`)
  for (const p of s.providers) {
    assert.equal(typeof p.name, "string")
    assert.ok(Array.isArray(p.models), `${label}: provider.models array`)
    for (const m of p.models) assert.equal(typeof m, "string")
  }
  assert.ok(Array.isArray(s.routes), `${label}: routes array`)
  for (const r of s.routes) {
    for (const k of ROUTE_ENTRY_KEYS) assert.ok(k in r, `${label}: route missing ${k}`)
    assert.equal(typeof r.scope, "string")
    assert.equal(typeof r.field, "string")
    assert.ok(r.target === null || typeof r.target === "string", `${label}: target string|null`)
    assert.ok(Array.isArray(r.fallback), `${label}: fallback array`)
    for (const f of r.fallback) assert.equal(typeof f, "string")
  }
  assert.equal(typeof s.familyRouting, "boolean")
  assert.equal(typeof s.fallbackEnabled, "boolean")
  assert.equal(typeof s.revision, "string")
  assert.ok(s.revision.length > 0, `${label}: revision non-empty`)
}

function assertUsageSnapshot(u, period, label) {
  for (const k of USAGE_KEYS) assert.ok(k in u, `${label}: missing ${k}`)
  assert.equal(u.period, period)
  for (const k of ["totalRequests", "successCount", "errorCount", "inputTokens", "effectiveInputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "estimatedCount"]) {
    assert.equal(typeof u[k], "number", `${label}: ${k} numeric`)
  }
  assert.ok(Array.isArray(u.byProvider), `${label}: byProvider array`)
  assert.ok(Array.isArray(u.byDay), `${label}: byDay array`)
  assert.ok(Array.isArray(u.byModel) && u.byModel.length > 0, `${label}: byModel populated`);
  for (const row of [...u.byModel, ...u.byProvider, ...u.byDay]) {
    assert.equal(typeof row.cacheReadTokens, "number", `${label}: cache read numeric`);
    assert.equal(typeof row.cacheWriteTokens, "number", `${label}: cache write numeric`);
  }
  for (const row of [...u.byModel, ...u.byProvider, ...u.byDay]) {
    for (const k of USAGE_ROW_KEYS) assert.ok(k in row, `${label}: row missing ${k}`)
  }
  assert.equal(typeof u.updatedAt, "number")
  assert.equal(JSON.stringify(u).includes("cost"), false, `${label}: no fabricated costs`)
  assert.equal(JSON.stringify(u).includes("currency"), false, `${label}: no fabricated currency`)
}

test("preview: usage_records paginates with cross-page totals, error and estimated records", async () => {
  const invoke = Q.createPreviewInvoke()
  const first = await previewCall(invoke, "usage_records", { period: "today", page: 1, pageSize: 20 })
  for (const k of RECORDS_PAGE_KEYS) assert.ok(k in first, `records page: missing ${k}`)
  assert.equal(first.period, "today")
  assert.equal(first.page, 1)
  assert.equal(first.pageSize, 20)
  assert.equal(typeof first.total, "number")
  assert.ok(first.total > first.records.length, "cross-page total exceeds one page")
  assert.ok(Array.isArray(first.records) && first.records.length > 0, "records populated")
  for (const r of first.records) {
    for (const k of RECORD_KEYS) assert.ok(k in r, `record missing ${k}`)
    assert.ok(r.status === "success" || r.status === "error")
    assert.equal(typeof r.usageEstimated, "boolean")
    assert.ok(r.ttftMs === null || typeof r.ttftMs === "number")
    assert.ok(r.errorMessage === null || typeof r.errorMessage === "string")
  }
  const s = JSON.stringify(first)
  for (const banned of RECORDS_BANNED) assert.equal(s.includes(banned), false, `${banned} must never cross IPC`)
  assert.ok(first.records.some((r) => r.status === "error" && r.errorMessage), "an error record is present")
  assert.ok(first.records.some((r) => r.usageEstimated), "an estimated record is present")

  const second = await previewCall(invoke, "usage_records", { period: "today", page: 2, pageSize: 20 })
  assert.equal(second.page, 2)
  assert.notEqual(JSON.stringify(second.records), JSON.stringify(first.records), "page 2 serves different records")
  const empty = await previewCall(invoke, "usage_records", { period: "today", page: 99, pageSize: 20 })
  assert.equal(empty.records.length, 0, "out-of-range page yields no records")

  for (const period of ["7d", "30d", "all"]) {
    const page = await previewCall(invoke, "usage_records", { period })
    for (const k of RECORDS_PAGE_KEYS) assert.ok(k in page, `${period}: missing ${k}`)
    assert.equal(page.period, period)
    assert.ok(page.total > page.pageSize, `${period} total spans multiple pages`)
  }

  await assert.rejects(previewCall(invoke, "usage_records", { period: "bogus" }), /周期/)
  const clamped = await previewCall(invoke, "usage_records", { period: "today", page: -5, pageSize: 999 })
  assert.equal(clamped.page, 1, "page clamps to >= 1")
  assert.equal(clamped.pageSize, 50, "pageSize clamps to 50")
  const defaulted = await previewCall(invoke, "usage_records", { period: "today" })
  assert.equal(defaulted.page, 1)
  assert.equal(defaulted.pageSize, 20)
})

function assertClientsResponse(r, label) {
  for (const k of CLIENT_RESPONSE_KEYS) assert.ok(k in r, `${label}: missing ${k}`)
  assert.equal(typeof r.success, "boolean")
  assert.ok(r.message === null || typeof r.message === "string")
  assert.ok(Array.isArray(r.clients))
  const ids = r.clients.map((c) => c.id)
  for (const id of FIVE_IDS) assert.ok(ids.includes(id), `${label}: discovers ${id}`)
  assert.equal(ids.length, FIVE_IDS.length, `${label}: exactly the five known client ids`)
  for (const c of r.clients) {
    for (const k of CLIENT_KEYS) assert.ok(k in c, `${label}: client missing ${k}`)
    assert.equal(typeof c.enabled, "boolean")
    assert.equal(typeof c.managed, "boolean")
    assert.equal(typeof c.exists, "boolean")
    assert.ok(c.activeModel === null || typeof c.activeModel === "string")
    assert.ok(c.modelAlias === null || typeof c.modelAlias === "string")
  }
}

function assertServiceState(s, label) {
  for (const k of SERVICE_KEYS) assert.ok(k in s, `${label}: missing ${k}`)
  assert.ok(SERVICE_MODES.includes(s.mode), `${label}: mode in ${SERVICE_MODES.join("|")}`)
  assert.equal(typeof s.running, "boolean")
  assert.ok(s.message === null || typeof s.message === "string")
}

test("preview: quota_snapshot keeps the existing quota contract", async () => {
  const invoke = Q.createPreviewInvoke()
  const s = await previewCall(invoke, "quota_snapshot", { provider: null })
  assert.ok(Array.isArray(s.providers) && s.providers.length > 0)
  assert.equal(typeof s.updatedAt, "number")
  assert.equal(typeof s.online, "boolean")
})

test("preview: provider_add returns only the name and updates safe quota and routing projections", async () => {
  const invoke = Q.createPreviewInvoke()
  const provider = { name: 'example.com', baseUrl: 'https://example.com/v1', apiKey: 'test-key', models: ['one'] }
  const added = await previewCall(invoke, 'provider_add', { provider })
  assert.deepEqual(Object.keys(added), ['name'])
  assert.equal(added.name, provider.name)
  await assert.rejects(previewCall(invoke, 'provider_add', { provider: { ...provider, name: 'EXAMPLE.com' } }), /^(Error: )?PROVIDER_DUPLICATE$/)
  await assert.rejects(previewCall(invoke, 'provider_add', { provider: { ...provider, models: [] } }), /PROVIDER_INVALID/)
  const quota = await invoke('quota_snapshot', { provider: provider.name })
  const routing = await invoke('routing_snapshot')
  assert.equal(quota.providers.filter(p => p.name === provider.name).length, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(routing.providers.at(-1))), { name: provider.name, models: ['one'] })
  assert.doesNotMatch(JSON.stringify([added, quota, routing]), /test-key|https:\/\/example\.com/)
})

test('preview: provider_get projects editable fields and provider_update preserves its name', async () => {
  const invoke = Q.createPreviewInvoke()
  const provider = { name: 'example.com', baseUrl: 'https://example.com/v1', models: ['one'] }
  await invoke('provider_add', { provider: { ...provider, apiKey: 'test-key' } })
  const detail = await invoke('provider_get', { name: provider.name })
  assert.deepEqual(JSON.parse(JSON.stringify(detail)), { ...provider, managed: false, transformer: null, transformerProtected: false })
  await assert.rejects(invoke('provider_update', { name: provider.name, provider: { ...provider, name: 'Renamed' } }), /PROVIDER_INVALID/)
  const change = { ...provider, models: ['two'] }
  const updated = await invoke('provider_update', { name: provider.name, provider: change })
  assert.deepEqual({ ...updated }, { name: change.name })
  assert.deepEqual(JSON.parse(JSON.stringify(await invoke('provider_get', updated))), { ...change, managed: false, transformer: null, transformerProtected: false })
  const quota = await invoke('quota_snapshot')
  assert.ok(quota.providers.some(p => p.name === change.name))
  assert.equal(quota.providers.filter(p => p.name === provider.name).length, 1)
  const routes = await invoke('routing_snapshot')
  assert.deepEqual(JSON.parse(JSON.stringify(routes.providers.at(-1))), { name: change.name, models: change.models })
})

test('preview: provider_get summarizes protected tuples and omitted transformer keeps the chain', async () => {
  const invoke = Q.createPreviewInvoke()
  const { parameterizedNames } = await invoke('provider_transformers')
  assert.ok(parameterizedNames.includes('customparams'))
  const provider = { name: 'example.com', baseUrl: 'https://example.com', models: ['one'] }
  const transformer = { use: [[parameterizedNames[0], { value: 'test-key' }]] }
  const target = await invoke('provider_add', { provider: { ...provider, apiKey: 'test-key', transformer } })
  await invoke('provider_update', { ...target, provider })
  const summary = await invoke('provider_get', target)
  assert.equal(summary.transformerProtected, true)
  assert.deepEqual(JSON.parse(JSON.stringify(summary.transformer)), { use: [parameterizedNames[0]] })
  assert.doesNotMatch(JSON.stringify(summary), /test-key/)
})

test('preview: rejects unsafe URLs, instance-only tuples and managed edits', async () => {
  const invoke = Q.createPreviewInvoke()
  const provider = { name: 'safe', baseUrl: 'https://example.com/?version=1', apiKey: 'test-key', models: ['one'] }
  for (const query of ['api_key=test-secret', 'version=test-secret', 'api-version=2024-02-30', 'version=1&key=test-secret']) {
    await assert.rejects(invoke('provider_add', { provider: { ...provider, baseUrl: `https://example.com/?${query}` } }), /PROVIDER_INVALID/)
  }
  const transformer = { use: [['OpenAI', {}]] }
  for (const invalid of [transformer, { use: [['unknown', {}]] }, { use: [['customparams', []]] }, { use: [{}] }, { use: [] }, null]) {
    await assert.rejects(invoke('provider_add', { provider: { ...provider, transformer: invalid } }), /PROVIDER_INVALID/)
  }
  await invoke('provider_add', { provider })
  await assert.rejects(invoke('provider_update', { name: provider.name, provider: { ...provider, transformer } }), /PROVIDER_INVALID/)
  const managed = { ...provider, name: 'managed', apiKey: 'ccr-managed-test' }
  await invoke('provider_add', { provider: managed })
  await assert.rejects(invoke('provider_get', { name: managed.name }), /PROVIDER_MANAGED/)
  await assert.rejects(invoke('provider_update', { name: managed.name, provider: managed }), /PROVIDER_MANAGED/)
})

test("preview: routing_snapshot has the complete routing contract", async () => {
  const invoke = Q.createPreviewInvoke()
  assertRoutingSnapshot(await previewCall(invoke, "routing_snapshot", {}), "routing_snapshot")
})

test("preview: routing_save applies target/fallback/clear and rejects stale revisions", async () => {
  const invoke = Q.createPreviewInvoke()
  const before = await previewCall(invoke, "routing_snapshot", {})
  assertRoutingSnapshot(before, "before save")

  // stale revision is rejected with the fixed safe message
  await assert.rejects(
    previewCall(invoke, "routing_save", { change: { revision: "rev-0", scope: "global", field: "default", target: "alpha,a1", fallback: null } }),
    /修改/,
  )

  const saved = await previewCall(invoke, "routing_save", {
    change: { revision: before.revision, scope: "opus", field: "webSearch", target: "beta,gemini-3-pro", fallback: ["alpha,claude-sonnet-4-5"] },
  })
  assertRoutingSnapshot(saved, "after save")
  assert.notEqual(saved.revision, before.revision, "save bumps the revision")
  const added = saved.routes.find((r) => r.scope === "opus" && r.field === "webSearch")
  assert.ok(added, "new override appears in the returned snapshot")
  assert.equal(added.target, "beta,gemini-3-pro")
  assert.deepEqual(Array.from(added.fallback), ["alpha,claude-sonnet-4-5"])

  // null fallback preserves the previous list
  const again = await previewCall(invoke, "routing_save", {
    change: { revision: saved.revision, scope: "opus", field: "webSearch", target: "beta,glm-5", fallback: null },
  })
  const updated = again.routes.find((r) => r.scope === "opus" && r.field === "webSearch")
  assert.equal(updated.target, "beta,glm-5")
  assert.deepEqual(Array.from(updated.fallback), ["alpha,claude-sonnet-4-5"], "null fallback preserved")

  // Clearing target and fallback removes the override.
  const cleared = await previewCall(invoke, "routing_save", {
    change: { revision: again.revision, scope: "opus", field: "webSearch", target: null, fallback: [] },
  })
  assert.equal(cleared.routes.find((r) => r.scope === "opus" && r.field === "webSearch"), undefined, "cleared override removed")

  // unknown scope and empty field are rejected
  const currentRev = cleared.revision
  await assert.rejects(
    previewCall(invoke, "routing_save", { change: { revision: currentRev, scope: "nope", field: "default", target: "a,b", fallback: null } }),
    /范围/,
  )
  await assert.rejects(
    previewCall(invoke, "routing_save", { change: { revision: currentRev, scope: "global", field: "", target: "a,b", fallback: null } }),
    /字段/,
  )
})

test("preview: group saves validate the whole batch and preserve fallback-only routes", async () => {
  const invoke = Q.createPreviewInvoke()
  const before = await previewCall(invoke, "routing_snapshot", {})
  const opus = { revision: before.revision, scope: "opus", field: "default", target: null, fallback: null }
  const sonnet = { revision: before.revision, scope: "sonnet", field: "think", target: "beta.example.com,glm-5", fallback: [] }
  for (const invalid of [[], [opus, { ...opus, field: " default " }], [opus, { ...sonnet, field: "background" }], [opus, { ...sonnet, revision: "stale" }]]) {
    await assert.rejects(previewCall(invoke, "routing_save_groups", { changes: invalid }))
  }
  const unchanged = await previewCall(invoke, "routing_snapshot", {})
  assert.equal(unchanged.revision, before.revision)
  assert.equal(unchanged.routes.find(r => r.scope === "opus" && r.field === "default").target,
    before.routes.find(r => r.scope === "opus" && r.field === "default").target)
  const after = await previewCall(invoke, "routing_save_groups", { changes: [opus, sonnet] })
  assert.notEqual(after.revision, before.revision)
  const fallbackOnly = after.routes.find(r => r.scope === "opus" && r.field === "default")
  assert.equal(fallbackOnly.target, null)
  assert.deepEqual(Array.from(fallbackOnly.fallback), Array.from(before.routes.find(r => r.scope === "opus" && r.field === "default").fallback))
  assert.equal(after.routes.find(r => r.scope === "sonnet" && r.field === "think").target, sonnet.target)
})

test("preview: routing_flags toggles both flags and returns a fresh snapshot", async () => {
  const invoke = Q.createPreviewInvoke()
  const before = await previewCall(invoke, "routing_snapshot", {})
  const after = await previewCall(invoke, "routing_flags", { revision: before.revision, familyRouting: false, fallbackEnabled: false })
  assertRoutingSnapshot(after, "after flags")
  assert.equal(after.familyRouting, false)
  assert.equal(after.fallbackEnabled, false)
  assert.notEqual(after.revision, before.revision)
  await assert.rejects(
    previewCall(invoke, "routing_flags", { revision: before.revision, familyRouting: true, fallbackEnabled: true }),
    /修改/,
  )
})

test("preview: usage_snapshot covers today/7d/30d with complete summaries", async () => {
  const invoke = Q.createPreviewInvoke()
  for (const period of ["today", "7d", "30d", "all"]) {
    assertUsageSnapshot(await previewCall(invoke, "usage_snapshot", { period }), period, period)
  }
  const fallback = await previewCall(invoke, "usage_snapshot", { period: "bogus" })
  assertUsageSnapshot(fallback, "today", "bogus period falls back to today")
})

test("preview: clients_snapshot discovers the five known clients with complete fields", async () => {
  const invoke = Q.createPreviewInvoke()
  assertClientsResponse(await previewCall(invoke, "clients_snapshot", {}), "clients_snapshot")
})

test("preview: clients_update applies enable/disable/restore individually and rejects unknown ids", async () => {
  const invoke = Q.createPreviewInvoke()
  const before = await previewCall(invoke, "clients_snapshot", {})
  const pi = before.clients.find((c) => c.id === "pi")

  const enabled = await previewCall(invoke, "clients_update", { id: "pi", action: "enable" })
  assertClientsResponse(enabled, "after enable")
  assert.equal(enabled.clients.find((c) => c.id === "pi").enabled, true)

  const disabled = await previewCall(invoke, "clients_update", { id: "pi", action: "disable" })
  assert.equal(disabled.clients.find((c) => c.id === "pi").enabled, false)

  const restored = await previewCall(invoke, "clients_update", { id: "pi", action: "restore" })
  const piAfter = restored.clients.find((c) => c.id === "pi")
  assert.equal(piAfter.enabled, false, "restore does not auto-enable")
  assert.equal(piAfter.managed, false)
  assert.equal(piAfter.activeModel, null)
  void pi

  await assert.rejects(previewCall(invoke, "clients_update", { id: "unknown", action: "enable" }), /未知/)
  await assert.rejects(previewCall(invoke, "clients_update", { id: "pi", action: "uninstall" }), /无效/)
})

test("preview: service_snapshot/service_action follow the lifecycle contract", async () => {
  const invoke = Q.createPreviewInvoke()
  const initial = await previewCall(invoke, "service_snapshot", {})
  assertServiceState(initial, "service_snapshot")

  // start while running is rejected with a safe message
  if (initial.running) {
    await assert.rejects(previewCall(invoke, "service_action", { action: "start" }), /运行/)
    const stopped = await previewCall(invoke, "service_action", { action: "stop" })
    assertServiceState(stopped, "after stop")
    assert.equal(stopped.running, false)
    await assert.rejects(previewCall(invoke, "service_action", { action: "stop" }), /未在运行/)
  }
  const started = await previewCall(invoke, "service_action", { action: "start" })
  assertServiceState(started, "after start")
  assert.equal(started.running, true)
  await assert.rejects(previewCall(invoke, "service_action", { action: "reboot" }), /无效/)
})

test("preview: config_reload follows the {success, restartRequired} contract", async () => {
  const invoke = Q.createPreviewInvoke()
  const r = await previewCall(invoke, "config_reload", {})
  assert.equal(r.success, true)
  assert.ok(Array.isArray(r.restartRequired))
  for (const k of r.restartRequired) assert.ok(["PORT", "HOST"].includes(k), `restart key ${k} is a known contract key`)
})

test("preview: quota_credentials_status/save follow the {name, configured} contract without secrets", async () => {
  const invoke = Q.createPreviewInvoke()
  const assertStatus = (s, label) => {
    assert.ok(Array.isArray(s.providers) && s.providers.length > 0, `${label}: providers listed`)
    for (const p of s.providers) {
      assert.deepEqual(Object.keys(p).sort(), ["configured", "name"], `${label}: projection is name+configured only`)
      assert.equal(typeof p.name, "string")
      assert.equal(typeof p.configured, "boolean")
    }
    assert.equal(JSON.stringify(s).includes("secretKey"), false, `${label}: no secret fields`)
    assert.equal(JSON.stringify(s).includes("accessKey"), false, `${label}: no secret fields`)
  }
  const before = await previewCall(invoke, "quota_credentials_status", {})
  assertStatus(before, "status")
  const volc = before.providers.find((p) => p.name === "火山agent plan")
  assert.ok(volc, "preview lists the Coding Plan provider")
  assert.equal(volc.configured, false)
  // The preview quota snapshot renders the same provider, so the panel is demoable.
  const quota = await previewCall(invoke, "quota_snapshot", { provider: null })
  assert.ok(quota.providers.some((p) => p.name === volc.name))

  const saved = await previewCall(invoke, "quota_credentials_save", { name: volc.name, accessKey: "PREVIEW_AK", secretKey: "PREVIEW_SK" })
  assertStatus(saved, "after save")
  assert.equal(saved.providers.find((p) => p.name === volc.name).configured, true)
  assert.equal(JSON.stringify(saved).includes("PREVIEW_SK"), false, "submitted secrets never echo back")

  // Omitted fields keep the saved value; an empty string clears that field.
  const kept = await previewCall(invoke, "quota_credentials_save", { name: volc.name, secretKey: "OTHER_SK" })
  assert.equal(kept.providers.find((p) => p.name === volc.name).configured, true)
  const cleared = await previewCall(invoke, "quota_credentials_save", { name: volc.name, accessKey: "", secretKey: "" })
  assertStatus(cleared, "after clear")
  assert.equal(cleared.providers.find((p) => p.name === volc.name).configured, false)

  // Error wording mirrors credentials.rs ERR_NOT_FOUND exactly in both preview and production.
  await assert.rejects(
    previewCall(invoke, "quota_credentials_save", { name: "unknown", accessKey: "x" }),
    /^Error: Coding Plan provider is no longer configured; refresh the panel$/
  )
})

test("preview: plugin DTOs model partial catalog, install/update, safe actions and manual activation", async () => {
  const invoke = Q.createPreviewInvoke()
  const inventory = await previewCall(invoke, "plugin_inventory")
  assert.deepEqual(Object.keys(inventory), ["plugins"])
  for (const row of inventory.plugins) {
    const { connectionState, ...required } = row
    assert.deepEqual(Object.keys(required), ["id", "name", "version", "loaded", "actions"])
    assert.ok(Array.isArray(row.actions))
    assert.ok(connectionState === undefined || ["connected", "disconnected", "unknown"].includes(connectionState))
  }
  assert.equal(inventory.plugins.find(row => row.id === "codex").connectionState, "connected")
  assert.ok(inventory.plugins.some(row => row.loaded && row.actions.includes("usage")))
  assert.ok(inventory.plugins.some(row => !row.loaded && row.actions.length === 0))
  const catalog = await previewCall(invoke, "plugin_catalog")
  assert.equal(catalog.partial, true)
  for (const row of catalog.plugins) {
    assert.deepEqual(Object.keys(row), ["name", "description", "version", "installed", "installedVersion", ...(row.installed && !row.localOnly ? ["installedName"] : []), "updateAvailable", "localOnly"])
  }
  const offer = catalog.plugins.find(row => !row.installed)
  const update = catalog.plugins.find(row => row.updateAvailable)
  await assert.rejects(previewCall(invoke, "plugin_install", { name: catalog.plugins.find(row => row.localOnly).name, version: "0.1.0", installed: { name: "local-example", version: "0.1.0" } }), /PLUGIN_INSTALL_FAILED/)
  await assert.rejects(previewCall(invoke, "plugin_action", { id: "workbuddy", action: "disconnect" }), /PLUGIN_ACTION_FAILED/)
  const usage = await previewCall(invoke, "plugin_action", { id: "codex", action: "usage" })
  assert.deepEqual({ ...usage }, { usage: "fresh" })
  const disconnected = await previewCall(invoke, "plugin_action", { id: "codex", action: "disconnect" })
  assert.deepEqual({ ...disconnected }, { success: true })
  for (const [row, isUpdate] of [[offer, false], [update, true]]) {
    const result = await previewCall(invoke, "plugin_install", { name: row.name, version: row.version, installed: isUpdate ? { name: row.installedName, version: row.installedVersion } : null })
    assert.equal(result.restartRequired, true)
    assert.equal(result.version, row.version)
    assert.ok(result.id)
  }
  const installed = await previewCall(invoke, "plugin_catalog")
  assert.ok(installed.plugins.every(row => row.installed && !row.updateAvailable))
  const beforeStart = await previewCall(invoke, "plugin_inventory")
  assert.equal(beforeStart.plugins.find(row => row.id === "gemini-oauth").loaded, false)
  assert.equal(beforeStart.plugins.find(row => row.id === "codex").version, update.installedVersion)
  assert.equal(beforeStart.plugins.find(row => row.id === "codex").connectionState, "disconnected")
  await previewCall(invoke, "service_action", { action: "stop" })
  await previewCall(invoke, "service_action", { action: "start" })
  const afterStart = await previewCall(invoke, "plugin_inventory")
  assert.equal(afterStart.plugins.find(row => row.id === "gemini-oauth").loaded, true)
  assert.equal(afterStart.plugins.find(row => row.id === "codex").version, update.version)
})

test("preview: unknown commands resolve null (never fabricate responses)", async () => {
  const invoke = Q.createPreviewInvoke()
  assert.equal(await previewCall(invoke, "totally_unknown", {}), null)
})

// ---------------- HTML / JS wiring ----------------

const htmlIds = () => new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]))
const jsIds = () => new Set([...(js + pluginsJs).matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]))

test("wiring: every id referenced from quota.js and plugins.js exists in quota.html", () => {
  const missing = [...jsIds()].filter((id) => !htmlIds().has(id))
  assert.deepEqual(missing, [], `ids used in JS but missing in HTML: ${missing.join(", ")}`)
})

test("wiring: scripts are external only and there are no inline handlers (CSP script-src 'self')", () => {
  for (const m of html.matchAll(/<script\b([^>]*)>/g)) {
    assert.match(m[1], /src="[^"]+"/, "script tags must reference an external file")
  }
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, "no inline on* handlers in HTML")
  assert.match(html, /<script src="quota\.js" defer><\/script>/)
  assert.ok(html.indexOf('src="plugins.js" defer') > 0 && html.indexOf('src="plugins.js" defer') < html.indexOf('src="quota.js" defer'))
})

test("wiring: stylesheet and tab structure are present", () => {
  assert.match(html, /<link rel="stylesheet" href="quota\.css">/)
  assert.ok(JSON.stringify(jsIds()).length > 0)
  const ids = htmlIds()
  for (const tab of ["quota", "routing", "usage", "clients", "plugins"]) {
    assert.ok(ids.has(`tab-${tab}`), `tab-${tab} exists`)
    assert.ok(ids.has(`panel-${tab}`), `panel-${tab} exists`)
    assert.ok(new RegExp(`aria-controls="panel-${tab}"`).test(html), `tab-${tab} aria-controls wired`)
  }
})

test("wiring: product wording matches the approved labels", () => {
  const text = html.replace(/\s+/g, "")
  for (const label of ["额度", "路由", "用量", "客户端", "插件", "已安装", "插件市场"]) {
    assert.ok(text.includes(`>${label}</button>`), `tab label ${label} present`)
  }
  assert.ok(html.includes("将 Claude Code、Codex、Pi 等接入 CCR"), "clients tab description present")
  assert.ok(html.includes("打开主窗口"), "open button opens the local main window (not the web UI)")
  assert.ok(!html.includes("Web UI"), "no remote web-UI wording left")
  assert.ok(html.includes("退出桌面"), "quit button keeps its label")
  assert.ok(html.includes("由本应用启动的网关服务会一并停止"), "quit wording states owned-service shutdown")
})

test("wiring: routing scope buttons and service controls exist", () => {
  const ids = htmlIds()
  for (const id of ["routing-scopes", "flag-family", "flag-fallback", "routing-body", "alias-add", "route-choices"]) {
    assert.ok(ids.has(id), `${id} exists`)
  }
  for (const scope of Q.ROUTING_SCOPES) {
    assert.ok(html.includes(`data-scope="${scope}"`), `scope button ${scope} present`)
  }
  for (const id of ["service-chip", "service-text", "service-start", "service-stop", "service-reload", "service-reload-msg", "service-refresh"]) {
    assert.ok(ids.has(id), `${id} exists`)
  }
})

test("wiring: usage period buttons cover the contract periods", () => {
  for (const period of Q.USAGE_PERIODS) {
    assert.ok(html.includes(`data-period="${period}"`), `period button ${period} present`)
  }
})

test("wiring: quota tab keeps its original contract surface", () => {
  const ids = htmlIds()
  for (const id of ["list", "empty", "banner", "provider-count", "updated-at", "refresh-all", "open-ui", "quit"]) {
    assert.ok(ids.has(id), `legacy quota id ${id} preserved`)
  }
  assert.ok(js.includes("quota_open_ui"), "open button still calls quota_open_ui")
  assert.ok(js.includes("quota_quit"), "quit still calls quota_quit")
  assert.ok(js.includes("quota_hide"), "escape still hides the popup")
  assert.ok(js.includes("quota_snapshot"), "quota snapshot command unchanged")
})

test("wiring: focus-triggered refresh is quota-only (drafts must survive focus changes)", () => {
  assert.match(js, /if \(activeTab === 'quota' && controller\) controller\.refreshAll\(\);/)
  const syncRouteRow = js.slice(js.indexOf("function syncRouteRow"), js.indexOf("function buildRouteRow"))
  assert.match(syncRouteRow, /document\.activeElement !== refs\.target/, "focused routing inputs are never rewritten")
})
