// Extracted from magpie-community/plugins bace91473b4f113a719a49b7d8ce81fe1f5b5760 packages/grok/index.mjs.
// MIT notice: ../../THIRD_PARTY_NOTICES.md. Local changes: per-instance env/cache, bounded CLI output, explicit proxy environment.
import { execFile } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
const CLIENT_VERSION="1.0.41", REFRESH_MARGIN=300000, NO_CLI="Install Grok Build from https://x.ai/cli or configure GROK_BIN_DIR";
const ANSI=/\x1b\[[0-9;?]*[A-Za-z]/g;
const TOOLS=new Set(["function","web_search","x_search","image_generation","collections_search","file_search","code_execution","code_interpreter","mcp","shell","tool_search"]);
export function createGrokEngine({ env = process.env, userHome = homedir(), proxyUrl = "" } = {}) {
function cliHome() {
  return env.GROK_HOME || join(userHome, ".grok")
}

function isFile(p) {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

// isGrokBuild tells xAI's grok from any other program by that name: its
// installer keeps it under the grok home.
function isGrokBuild(p) {
  let real = p
  try {
    real = realpathSync(p)
  } catch {}
  return real.replaceAll("\\", "/").toLowerCase().includes("/.grok/")
}

// executable finds the CLI, first to last: the installer's bin
// (GROK_BIN_DIR, GROK_HOME/bin, ~/.grok/bin), each folder on PATH, then
// ~/.local/bin; those two only when it is really Grok Build.
function executable() {
  const name = process.platform === "win32" ? "grok.exe" : "grok"
  const home = userHome
  const seen = new Set()
  const out = []
  const add = (dir, own) => {
    if (!dir || !isAbsolute(dir)) return
    const p = join(dir, name)
    const k = process.platform === "win32" ? p.toLowerCase() : p
    if (seen.has(k)) return
    seen.add(k)
    out.push({ p, own })
  }
  add(env.GROK_BIN_DIR, true)
  add(join(cliHome(), "bin"), true)
  if (home) add(join(home, ".grok", "bin"), true)
  for (const d of (env.PATH ?? "").split(delimiter)) add(d.trim(), false)
  if (home) add(join(home, ".local", "bin"), false)
  for (const c of out) if (isFile(c.p) && (c.own || isGrokBuild(c.p))) return c.p
  return ""
}

// envFor runs the CLI as the user runs it, in the given home. GROK_AUTH_PATH
// goes too: grok 1.0.62 keeps its sign-in at that file instead of
// home/auth.json, where this plugin reads it, so a login with it set
// finished signed in and left nothing here.
function envFor(home) {
  const out = {}
  for (const [k, v] of Object.entries(env)) {
    if (["GROK_HOME", "GROK_AUTH_PATH", "GROK_AUTH_PROVIDER_COMMAND", "GROK_AUTH_EXPIRED"].includes(k.toUpperCase())) continue
    out[k] = v
  }
  out.GROK_HOME = home
  for (const key of Object.keys(out)) if (/^(https?_proxy|all_proxy|no_proxy)$/i.test(key)) delete out[key]
  if (proxyUrl) { out.HTTPS_PROXY = proxyUrl; out.HTTP_PROXY = proxyUrl; out.ALL_PROXY = proxyUrl }
  return out
}

// look reads the sign-in the CLI keeps in home: the first, by key, with a
// token. With none, why says what the file held instead.
//
// who is the account it is: its email, else its xAI user id (the token's
// subject when the file has none). grok 1.0.62 takes both from the
// sign-in's id_token and writes "email": null when that
// has no email claim (an xAI account signed in through X has none), and
// still says "✓ Signed in" (llllleo9 on 𝕏; seen with grok 1.0.62 in a
// sandbox, signed in against a stand-in auth.x.ai).
function look(home) {
  const file = join(home, "auth.json")
  let text
  try {
    text = readFileSync(file, "utf8")
  } catch (e) {
    return { c: null, why: e?.code === "ENOENT" ? `there is no ${file}` : `${file} can't be read (${e?.code ?? e?.message})` }
  }
  // an empty file, or one that isn't JSON, is most likely one the CLI is
  // writing as it is read (it rewrites auth.json when it renews): torn
  // says the read tells nothing, which read() tries again
  if (!text.trim()) return { c: null, why: `${file} is empty`, torn: true }
  let all
  try {
    all = JSON.parse(text)
  } catch {
    return { c: null, why: `${file} isn't JSON`, torn: true }
  }
  if (!all || typeof all !== "object" || Array.isArray(all)) return { c: null, why: `${file} holds no sign-in` }
  const keys = Object.keys(all).sort()
  for (const k of keys) {
    const c = all[k]
    if (c && typeof c.key === "string" && c.key) {
      const t = Date.parse(c.expires_at ?? "")
      const email = typeof c.email === "string" ? c.email : ""
      const sub = cpaClaims(c.key)?.sub
      const user = (typeof c.user_id === "string" && c.user_id) || (typeof sub === "string" ? sub : "")
      const got = { key: c.key, email, user, who: email || user, expires: Number.isFinite(t) ? t : 0, issuer: c.oidc_issuer ?? "" }
      lastGood.set(home, got)
      return { c: got, why: "" }
    }
  }
  return { c: null, why: keys.length ? `${file} has ${keys.join(", ")}, none with a token` : `${file} holds no sign-in` }
}

// lastGood is each home's last sign-in read whole.
const lastGood = new Map()
const TORN_TRIES = 6
const TORN_WAIT = 100

// read is look, a torn read (auth.json caught mid-write) tried again for
// about half a second; still torn, it is the last sign-in read whole there,
// as the CLI itself keeps its previous credentials when auth.json won't
// read ("auth reload: auth.json unreadable, keeping previous credentials").
// No lock is taken: the CLI's auth.json.lock is a flock it holds while it
// renews, which Node can't take, and a reader holding it could only hold a
// renewal back.
async function read(home) {
  let r = look(home)
  for (let i = 1; r.torn && i < TORN_TRIES; i++) {
    await new Promise((ok) => setTimeout(ok, TORN_WAIT))
    r = look(home)
  }
  if (r.torn && lastGood.has(home)) return { c: lastGood.get(home), why: "" }
  return r
}

// credential is the sign-in in home, null when there is none. A file that
// stays torn, with nothing read there before, is unknown, not "not signed
// in": that is an error saying so.
async function credential(home) {
  const r = await read(home)
  if (r.torn) throw new Error(`Grok Build's sign-in couldn't be read (${r.why}); it may be mid-write, try again in a moment`)
  return r.c
}

// shared is whether home is Grok Build's own, which opening Grok Build
// renews; a home of this plugin's (a second account, an imported one) only
// this plugin's runs of the CLI ever touch.
function shared(home) {
  return resolve(home) === resolve(cliHome())
}

// notSignedIn says a home holds no sign-in, and what makes one.
function notSignedIn(home) {
  return shared(home)
    ? "Grok is not signed in; run `grok login`"
    : "Grok is not signed in for this account any more; add the account in magpie again"
}

// cliSaid is what a `grok models` that renewed nothing said: how it ended
// and its last line.
function cliSaid(r) {
  if (!r) return ""
  const last = (r.stderr || r.stdout || "").replace(ANSI, "").split("\n").map((l) => l.trim()).filter(Boolean).at(-1)?.slice(0, 200)
  const how = !r.err ? "ran and left the same token" : r.err.killed ? "timed out" : `exited ${r.err.code ?? "with an error"}`
  return ` (grok models ${how}${last ? `: ${last}` : ""})`
}

// unrenewed is a token Grok turned away, or one past its end, that Grok
// Build, run in its home, didn't replace: the CLI couldn't renew it (xAI's renewal failing, or
// a refresh token used up elsewhere), which signing in with `grok login`
// in ~/.grok doesn't help where the account's home is the plugin's own.
function unrenewed(home, r) {
  const how = shared(home)
    ? "open Grok Build and send it a message, which renews the sign-in magpie reads"
    : "this account's sign-in is kept apart from Grok Build's own, so opening Grok Build doesn't renew it: add the account in magpie again"
  return Object.assign(new Error(`Grok Build couldn't renew the sign-in${cliSaid(r)}; ${how}`), { unrenewed: true })
}

// dead is a token Grok turned away even as Grok Build had just renewed it.
function dead(home) {
  return shared(home)
    ? "Grok turned away Grok Build's sign-in even after renewing it; run `grok login` to sign Grok Build in afresh"
    : "Grok turned away this account's sign-in even after renewing it; add the account in magpie again"
}

const children = new Set();
function cancelPending() { for (const child of children) child.kill("SIGKILL"); }
function run(file, args, opts) {
  return new Promise((resolve) => {
    const child = execFile(file, args, { timeout: 30000, maxBuffer: 65536, killSignal: "SIGKILL", ...opts }, (err, stdout, stderr) => {
      children.delete(child);
      resolve({ err, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
    children.add(child);
  })
}

// refreshing runs the CLI's renewals one after another; renewing is the one
// asked for each home, which those who come while it is due or running join
// rather than running the CLI there again.
let refreshing = Promise.resolve()
const renewing = new Map()

// renew has the CLI renew the sign-in in home: a `grok models` there renews
// it as any use of the CLI does.
function renew(exe, home) {
  let r = renewing.get(home)
  if (!r) {
    r = refreshing.then(() => run(exe, ["models"], { cwd: dirname(home), env: envFor(home) })).finally(() => renewing.delete(home))
    refreshing = r.catch(() => {})
    renewing.set(home, r)
  }
  return r
}

// token is the CLI's sign-in in home with a token still good. One about to
// expire is first renewed by the CLI in its own home, and so is one Grok
// turned away: rejected is that token (or true for whatever home holds).
// A token on disk other than the one turned away was renewed already and
// is taken as it is; one the CLI's run leaves as it was is unrenewed,
// never "not signed in" nor "expired".
async function token(home, rejected = false) {
  let c = await credential(home)
  const exe = executable()
  const refused = !!c && (rejected === true || (typeof rejected === "string" && c.key === rejected))
  let r
  if (c && exe && (refused || c.expires - Date.now() < REFRESH_MARGIN)) {
    const was = c.key
    r = await renew(exe, home)
    c = await credential(home)
    if (c && refused && c.key === was) throw unrenewed(home, r)
  }
  if (!c) throw new Error(notSignedIn(home))
  if (!exe && (refused || (c.expires && c.expires <= Date.now()))) throw new Error(`Grok turned the sign-in away and there is no Grok Build here to renew it; ${NO_CLI}`)
  if (c.expires && c.expires <= Date.now()) throw unrenewed(home, r)
  return c
}

let version = { v: CLIENT_VERSION, at: 0 }

// clientVersion is the CLI version the requests say they come from, unless
// the installed one is newer: without it the backend calls the CLI outdated.
async function clientVersion() {
  if (Date.now() - version.at < 10 * 60 * 1000) return version.v
  let v = CLIENT_VERSION
  const exe = executable()
  if (exe) {
    const { err, stdout } = await run(exe, ["--version"], { timeout: 5000, env: envFor(cliHome()) }) // "grok 1.0.41 (4220f3b224a6)"
    const got = !err && stdout.match(/\d+\.\d+\.\d+/)?.[0]
    if (got && newer(got, v)) v = got
  }
  version = { v, at: Date.now() }
  return v
}

function newer(a, b) {
  const x = a.split(".").map(Number), y = b.split(".").map(Number)
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]
  return false
}

// headers say a request comes from the Grok CLI.
async function sign(headers, key) {
  const v = await clientVersion()
  const os = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : process.platform
  const arch = { arm64: "aarch64", x64: "x86_64", ia32: "386" }[process.arch] ?? process.arch
  headers.set("Authorization", `Bearer ${key}`)
  headers.set("x-grok-client-version", v)
  headers.set("x-xai-token-auth", "xai-grok-cli")
  headers.set("x-grok-client-identifier", "grok-shell")
  headers.set("x-grok-client-mode", "headless")
  headers.set("User-Agent", `grok-shell/${v} (${os}; ${arch})`)
}

// bodyText is a request body handed over as bytes read as the text it
// is, so it can be reshaped; any other body is as it came.
function bodyText(body) {
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return new TextDecoder().decode(body)
  return body
}

// objectRoot is a tool's parameters as a plain object at the root, with no
// anyOf, oneOf or allOf there, folded as magpie's built-in folds them
// (provider.ObjectRoot): allOf's branches are all merged; of anyOf's and
// oneOf's object branches, a union itself folded first, the properties are
// merged, a field each of them requires stays required, and the other
// branches go. Branches may be local $refs. A schema already a plain object
// is returned as it came; the caller's own is never changed.
function objectRoot(ps) {
  return foldRoot(ps, ps, 0)
}

function foldRoot(root, ps, depth) {
  if (!isObj(ps)) return ps
  const has = (k) => Object.hasOwn(ps, k)
  if (ps.type === "object" && !has("anyOf") && !has("oneOf") && !has("allOf")) return ps
  const out = { ...ps }
  const props = { ...(isObj(ps.properties) ? ps.properties : {}) }
  let required = Array.isArray(ps.required) ? [...ps.required] : []
  const ref = (b) => {
    if (!isObj(b)) return null
    if (typeof b.$ref !== "string" || !b.$ref) return b
    for (const k of ["$defs", "definitions"]) {
      const pre = "#/" + k + "/"
      if (b.$ref.startsWith(pre)) {
        const d = root[k]?.[b.$ref.slice(pre.length)]
        return isObj(d) ? d : null
      }
    }
    return null
  }
  for (const b of Array.isArray(ps.allOf) ? ps.allOf : []) {
    const bm = ref(b)
    if (!bm) continue
    if (isObj(bm.properties)) for (const [k, v] of Object.entries(bm.properties)) if (!Object.hasOwn(props, k)) props[k] = v
    if (Array.isArray(bm.required)) required.push(...bm.required)
  }
  delete out.allOf
  const branches = []
  for (const k of ["anyOf", "oneOf"]) {
    for (const b of Array.isArray(ps[k]) ? ps[k] : []) {
      let bm = ref(b)
      if (!bm) continue
      // a branch that is itself a union (zod's discriminated create and
      // update in automation_update) is folded first, not dropped
      if (depth < 8 && ["anyOf", "oneOf", "allOf"].some((u) => Object.hasOwn(bm, u))) bm = foldRoot(root, bm, depth + 1)
      if (bm.type !== "object" && !Object.hasOwn(bm, "properties")) continue
      branches.push(bm)
    }
    delete out[k]
  }
  // a field every branch requires stays required, beside the root's and
  // allOf's own, which no branch can drop; a field the root doesn't define
  // takes each schema the branches give it, as anyOf when they differ
  let common = null
  const from = new Map()
  for (const b of branches) {
    for (const [k, v] of Object.entries(isObj(b.properties) ? b.properties : {})) {
      if (Object.hasOwn(props, k)) continue
      const vs = from.get(k) ?? []
      if (!vs.some((w) => JSON.stringify(w) === JSON.stringify(v))) vs.push(v)
      from.set(k, vs)
    }
    const br = Array.isArray(b.required) ? b.required : []
    common = common === null ? [...br] : common.filter((r) => br.includes(r))
  }
  for (const [k, vs] of from) props[k] = vs.length === 1 ? vs[0] : { anyOf: vs }
  for (const r of common ?? []) if (!required.includes(r)) required.push(r)
  required = [...new Set(required)]
  out.type = "object"
  out.properties = props
  if (required.length) out.required = required
  else delete out.required
  return out
}

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v)

// rewrite leaves out what Grok's backend doesn't take: tools of other
// types (a freeform apply_patch, a namespace of sub-agent tools), a web
// search's external_web_access, a tool_choice naming a dropped type or
// with no tools beside it (magpie sends "none" so when a client turned
// tools off, yetone/magpie#3110; Grok refuses it: "A tool_choice was set on
// the request but no tools were specified"), and a
// reasoning item's "content": null, beside which it can't read the
// encrypted reasoning. A function's parameters with a union at the root
// (Codex desktop's codex_app automation_update) are folded to an object,
// which Grok turns away otherwise: "tool parameter root must be an object
// type" (magpie#1271).
function rewrite(body, xSearch = false) {
  if (typeof body !== "string" || (!xSearch && !body.includes('"tools"') && !body.includes('"tool_choice"') && !body.includes('"reasoning"') && !body.includes('"agent_message"'))) return body
  let m
  try {
    m = JSON.parse(body)
  } catch {
    return body
  }
  if (!m || typeof m !== "object" || Array.isArray(m)) return body
  // Read the client's choice before dropping unsupported tools or choices.
  const search = xSearch && (m.tool_choice == null || m.tool_choice === "auto") &&
    (m.tools == null || Array.isArray(m.tools)) &&
    (m.tool_choice === "auto" || Array.isArray(m.tools) && m.tools.length > 0)
  let dirty = false
  if (Array.isArray(m.tools)) {
    m.tools = m.tools.filter((t) => {
      if (!t || typeof t !== "object") return true
      if (!TOOLS.has(t.type)) {
        dirty = true
        return false
      }
      if ("external_web_access" in t) {
        delete t.external_web_access
        dirty = true
      }
      if (t.type === "function") {
        const fn = isObj(t.function) ? t.function : t
        const ps = objectRoot(fn.parameters)
        if (ps !== fn.parameters) {
          fn.parameters = ps
          dirty = true
        }
      }
      return true
    })
    if (m.tool_choice && typeof m.tool_choice === "object" && !TOOLS.has(m.tool_choice.type)) {
      delete m.tool_choice
      dirty = true
    }
  }
  // No choice and no tools can mean a translated "none" on older gateways.
  if (search && (m.tool_choice === "auto" || m.tools?.length) && !m.tools?.some((t) => t?.type === "x_search")) {
    m.tools ??= []
    m.tools.push({ type: "x_search" })
    dirty = true
  }
  if (Object.hasOwn(m, "tool_choice") && !(Array.isArray(m.tools) && m.tools.length)) {
    delete m.tool_choice
    dirty = true
  }
  if (Array.isArray(m.input)) {
    m.input = m.input.map((it) => {
      if (!isObj(it) || it.type !== "agent_message" || Object.hasOwn(it, "encrypted_content") ||
          !Array.isArray(it.content) || !it.content.length ||
          !it.content.every((part) => isObj(part) && !Object.hasOwn(part, "encrypted_content") &&
            (part.type === "input_text" && typeof part.text === "string" ||
             part.type === "input_image" && typeof part.image_url === "string"))) return it
      // Grok takes ordinary messages, not Codex's collaboration item.
      // Sealed tasks remain untouched for the gateway's existing guard.
      const from = typeof it.author === "string" ? it.author : ""
      const to = typeof it.recipient === "string" ? it.recipient : ""
      const header = from && to ? `From ${from} to ${to}` : from ? `From ${from}` : to ? `To ${to}` : ""
      dirty = true
      return { type: "message", role: "user", content: header
        ? [{ type: "input_text", text: `${header}\n\n` }, ...it.content] : it.content }
    })
  }
  for (const it of Array.isArray(m.input) ? m.input : []) {
    if (it && it.type === "reasoning" && "content" in it && it.content === null) {
      delete it.content
      dirty = true
    }
  }
  return dirty ? JSON.stringify(m) : body
}

const labelOf = (n) => (n % 1000 === 0 ? `${n / 1000}k` : String(n))

// windowsOf is one model for each context window Grok lists. context_window
// is the default and keeps the plain id (grok-4.7), so a saved agent stays
// where it was. Each other size in context_windows is offered beside it
// (grok-4.7@500k), the way the CLI's /context-window offers it. A list with
// one size, or none, stays one model.
function windowsOf(d, efforts) {
  const name = d.name || d.id
  const fallback = Number(d.context_window) || 0
  const listed = (Array.isArray(d.context_windows) ? d.context_windows : [])
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0)
  const windows = [...new Set(listed.length ? listed : [fallback].filter(Boolean))]
  const base = windows.includes(fallback) ? fallback : windows[0] ?? 0
  const out = [{ id: d.id, apiId: d.id, name, context: base || fallback, window: base, efforts }]
  for (const w of windows) {
    if (w === base) continue
    out.push({ id: `${d.id}@${labelOf(w)}`, apiId: d.id, name: `${name} @ ${labelOf(w)}`, context: w, window: w, efforts })
  }
  return out
}

// modelOf splits a requested id into the model Grok lists and the window
// the id names. grok-4.7 is grok-4.7 at its default window (no header);
// grok-4.7@500k is grok-4.7 at 500000 tokens. The header is what the CLI
// sends as x-grok-context-window. The proxy serves up to its largest
// window either way and refuses past it; the header names the window the
// caller asked to compact against. A window no multiple of 1000 is named
// by its digits alone (grok-4.7@131072), as labelOf writes it.
function modelOf(id) {
  const at = typeof id === "string" ? id.match(/^(.+)@(\d+)(k?)$/) : null
  if (!at || !(Number(at[2]) > 0)) return { model: id, window: 0 }
  return { model: at[1], window: Number(at[2]) * (at[3] ? 1000 : 1) }
}

function cpaClaims(token) {
  try {
    const part = token.split(".")[1]
    if (!part) return null
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"))
  } catch {
    return null
  }
}

return { cancelPending, setProxyUrl: (value) => { proxyUrl = value }, cliHome, executable, envFor, credential, token, sign, rewrite, objectRoot, windowsOf, modelOf };
}
