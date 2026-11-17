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
const html = readFileSync(path.join(here, "..", "src", "quota.html"), "utf8")

const sandbox = { setTimeout }
vm.createContext(sandbox)
new vm.Script(js, { filename: "quota.js" }).runInContext(sandbox)
const Q = sandbox.QuotaUI
assert.ok(Q && typeof Q.createPreviewInvoke === "function", "QuotaUI.createPreviewInvoke must exist")

const ROUTE_KEYS = ["providers", "routes", "familyRouting", "fallbackEnabled", "revision"]
const ROUTE_ENTRY_KEYS = ["scope", "field", "target", "fallback"]
const USAGE_KEYS = [
  "period", "totalRequests", "successCount", "errorCount",
  "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "estimatedCount",
  "byModel", "byProvider", "byDay", "updatedAt",
]
const USAGE_ROW_KEYS = ["name", "requests", "inputTokens", "outputTokens"]
const CLIENT_KEYS = ["id", "name", "enabled", "managed", "exists", "activeModel", "modelAlias"]
const CLIENT_RESPONSE_KEYS = ["clients", "success", "message"]
const CLIENT_IDS = ["claudeCode", "codex", "pi", "qwenCode", "opencode"]
const SERVICE_KEYS = ["mode", "running", "message"]
const SERVICE_MODES = ["owned", "external", "stopped", "starting", "error"]
const FIVE_IDS = CLIENT_IDS

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
  for (const k of ["totalRequests", "successCount", "errorCount", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "estimatedCount"]) {
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

  // empty target clears the override
  const cleared = await previewCall(invoke, "routing_save", {
    change: { revision: again.revision, scope: "opus", field: "webSearch", target: null, fallback: null },
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
  for (const period of ["today", "7d", "30d"]) {
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

  // Error wording mirrors credentials.rs ERR_NOT_FOUND in both preview and production.
  await assert.rejects(previewCall(invoke, "quota_credentials_save", { name: "unknown", accessKey: "x" }), /no longer configured/)
})

test("preview: unknown commands resolve null (never fabricate responses)", async () => {
  const invoke = Q.createPreviewInvoke()
  assert.equal(await previewCall(invoke, "totally_unknown", {}), null)
})

// ---------------- HTML / JS wiring ----------------

const htmlIds = () => new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]))
const jsIds = () => new Set([...js.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]))

test("wiring: every id referenced from quota.js exists in quota.html", () => {
  const missing = [...jsIds()].filter((id) => !htmlIds().has(id))
  assert.deepEqual(missing, [], `ids used in JS but missing in HTML: ${missing.join(", ")}`)
})

test("wiring: scripts are external only and there are no inline handlers (CSP script-src 'self')", () => {
  for (const m of html.matchAll(/<script\b([^>]*)>/g)) {
    assert.match(m[1], /src="[^"]+"/, "script tags must reference an external file")
  }
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, "no inline on* handlers in HTML")
  assert.match(html, /<script src="quota\.js" defer><\/script>/)
})

test("wiring: stylesheet and tab structure are present", () => {
  assert.match(html, /<link rel="stylesheet" href="quota\.css">/)
  assert.ok(JSON.stringify(jsIds()).length > 0)
  const ids = htmlIds()
  for (const tab of ["quota", "routing", "usage", "clients"]) {
    assert.ok(ids.has(`tab-${tab}`), `tab-${tab} exists`)
    assert.ok(ids.has(`panel-${tab}`), `panel-${tab} exists`)
    assert.ok(new RegExp(`aria-controls="panel-${tab}"`).test(html), `tab-${tab} aria-controls wired`)
  }
})

test("wiring: product wording matches the approved labels", () => {
  const text = html.replace(/\s+/g, "")
  for (const label of ["额度", "路由", "用量", "客户端"]) {
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
  for (const id of ["service-chip", "service-text", "service-start", "service-stop", "service-refresh"]) {
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
