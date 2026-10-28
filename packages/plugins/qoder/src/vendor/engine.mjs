/*
MIT License

Copyright (c) 2026 magpie-community contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
// Extracted from magpie-community/plugins packages/qoder/index.mjs
// @ bace91473b4f113a719a49b7d8ce81fe1f5b5760
// (@magpie-community/opencode-qoder-auth 0.2.40), qoder.com + PAT subset.
// Locally modified for CCR: injected transport/clock, scoped caches and lifecycle.
import { createCipheriv, createHash, publicEncrypt, randomUUID, constants } from "node:crypto"

export function createQoderEngine(options) {
  if (typeof options?.fetch !== "function") throw new TypeError("Qoder requires an injected fetch")
  const now = options.now ?? (() => Date.now())
  const combine = (...signals) => AbortSignal.any([options.signal, ...signals].filter(Boolean))
  const checkAbort = (signal) => {
    const aborted = [signal, options.signal].find((s) => s?.aborted)
    if (aborted) throw aborted.reason ?? new DOMException("aborted", "AbortError")
  }
  const fetch = async (input, init = {}) => {
    const signal = combine(init.signal)
    checkAbort(signal)
    try {
      const res = await options.fetch(input, { ...init, signal, redirect: "error" })
      checkAbort(signal)
      return res
    } catch (e) {
      checkAbort(signal)
      throw e
    }
  }
  // node:http's standard reason phrases, kept local to avoid another runtime import.
  const STATUS_CODES = { 400: "Bad Request", 401: "Unauthorized", 402: "Payment Required", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 406: "Not Acceptable", 407: "Proxy Authentication Required", 408: "Request Timeout", 409: "Conflict", 410: "Gone", 411: "Length Required", 412: "Precondition Failed", 413: "Payload Too Large", 414: "URI Too Long", 415: "Unsupported Media Type", 416: "Range Not Satisfiable", 417: "Expectation Failed", 418: "I'm a Teapot", 421: "Misdirected Request", 422: "Unprocessable Entity", 423: "Locked", 424: "Failed Dependency", 425: "Too Early", 426: "Upgrade Required", 428: "Precondition Required", 429: "Too Many Requests", 431: "Request Header Fields Too Large", 451: "Unavailable For Legal Reasons", 500: "Internal Server Error", 501: "Not Implemented", 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout", 505: "HTTP Version Not Supported", 506: "Variant Also Negotiates", 507: "Insufficient Storage", 508: "Loop Detected", 509: "Bandwidth Limit Exceeded", 510: "Not Extended", 511: "Network Authentication Required" }
const CHAT_PATH = "/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1"
const MODELS_PATH = "/algo/api/v2/model/list?Encode=1"
// The build the envelope claims. It has to be the one Qoder's desktop app
// talks through — the worker runtime bundled in the app — because the
// envelope also says Cosy-ClientType: 10 (desktop) and carries that app's
// machine identity; the CLI's channel publishes a different, later number
// that no desktop build runs. Taken from app 0.4.8 (build 79743374,
// 2026-10-14), whose transport config names 1.1.69. Raise it when the app
// moves, not when the CLI does.
const COSY_VERSION = "1.1.69"
const REFRESH_LEAD = 5 * 60 * 1000 // a chat token this close to its end is refreshed before a request
const KEEP_SPENT_MS = 60 * 60 * 1000 // how long what a spent refresh token gave is remembered
const DAY = 24 * 60 * 60 * 1000
// Qoder's embedded 1024-bit RSA key (from the client's cosy source): it wraps
// the per-request AES key of the COSY Authorization header.
const RSA_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`

const QODER_SYS = "You are a Qoder agent. Use the instructions below and the tools available to you to assist the user."

const hexID = () => randomUUID().replaceAll("-", "")

// ---- the COSY envelope --------------------------------------------------------

// machineOS names the machine as Qoder's desktop clients do.
function machineOS() {
  const arch = { x64: "x86_64", ia32: "x86", arm64: "aarch64" }[process.arch] ?? process.arch
  return arch + "_" + process.platform
}

// userBlob is the account as the envelope carries it: AES-128-CBC under a
// fresh key that is its own IV, the key wrapped with Qoder's RSA key.
// userBlob and cosyHeaders take the site's own key and version when it has
// them (another QwenWork-like service on the same protocol), else Qoder's.
function userBlob(u, rsaKey = RSA_KEY) {
  const raw = JSON.stringify({ uid: u.uid, aid: "", name: u.name ?? "", email: u.email ?? "", security_oauth_token: u.access })
  const key = Buffer.from(hexID().slice(0, 16))
  const c = createCipheriv("aes-128-cbc", key, key)
  const info = Buffer.concat([c.update(raw, "utf8"), c.final()]).toString("base64")
  const wrapped = publicEncrypt({ key: rsaKey, padding: constants.RSA_PKCS1_PADDING }, key).toString("base64")
  return { info, key: wrapped }
}

// cosyHeaders signs a call to url whose body, in its wire form, is body.
function cosyHeaders(url, u, body, site, ts = Math.floor(now() / 1000)) {
  if (!u?.machineId) throw new Error(`${site?.name ?? "Qoder"}: the account has no machine id; sign in again`)
  const cosyVersion = site?.cosyVersion ?? COSY_VERSION
  const blob = userBlob(u, site?.rsaKey)
  const payload = Buffer.from(
    JSON.stringify({ version: "v1", requestId: hexID(), info: blob.info, cosyVersion, ideVersion: "" }),
  ).toString("base64")
  let path = new URL(url).pathname
  if (path.startsWith("/algo")) path = path.slice(5)
  const sig = createHash("md5").update(`${payload}\n${blob.key}\n${ts}\n${body}\n${path}`).digest("hex")
  const m = u.machineId
  return {
    Accept: "application/json",
    "Accept-Encoding": "identity",
    "Content-Type": "application/json",
    Authorization: `Bearer COSY.${payload}.${sig}`,
    "Cosy-Business-Product": site?.businessProduct ?? "app",
    "Cosy-Business-Type": "agent",
    "Cosy-ClientIp": m,
    "Cosy-ClientType": site?.clientType ?? "10",
    "Cosy-Data-Policy": "disagree",
    "Cosy-Date": String(ts),
    "Cosy-Key": blob.key,
    "Cosy-MachineId": m,
    "Cosy-MachineToken": m,
    "Cosy-MachineType": "5",
    "Cosy-MachineOS": machineOS(),
    "Cosy-Scene": site?.modelScene ?? "app",
    "Cosy-User": u.uid,
    "Cosy-Version": cosyVersion,
    "Login-Version": "v2",
  }
}

// ---- the body codec -----------------------------------------------------------

// Base64 through the client's shuffled alphabet ('$' pads), then the first
// and last thirds swapped.
const ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!"

function segmentEncode(bytes) {
  let s = ""
  let acc = 0
  let nb = 0
  for (const b of bytes) {
    acc = ((acc << 8) | b) & 0xffffff
    nb += 8
    while (nb >= 6) {
      nb -= 6
      s += ALPHABET[(acc >> nb) & 63]
    }
  }
  if (nb > 0) s += ALPHABET[(acc << (6 - nb)) & 63]
  while (s.length % 4) s += "$"
  return s
}

function swapThirds(s) {
  const t = Math.floor(s.length / 3)
  return t ? s.slice(s.length - t) + s.slice(t, s.length - t) + s.slice(0, t) : s
}

const encodeBody = (text) => swapThirds(segmentEncode(Buffer.from(text, "utf8")))

function decodeBody(wire) {
  const s = swapThirds(wire)
  const out = []
  for (let g = 0; g + 4 <= s.length; g += 4) {
    const vals = [...s.slice(g, g + 4)].filter((c) => c !== "$").map((c) => ALPHABET.indexOf(c))
    let x = 0
    for (const v of vals) x = x * 64 + v
    const n = Math.floor((6 * vals.length) / 8)
    for (let k = 0; k < n; k++) out.push(Math.floor(x / 2 ** (6 * vals.length - 8 * (k + 1))) & 255)
  }
  return Buffer.from(out).toString("utf8")
}

async function openapi(site, path, { method = "GET", token, body, query, signal } = {}) {
  const url = new URL(site.openapi + path)
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v)
  const headers = { Accept: "application/json" }
  if (body) headers["Content-Type"] = "application/json"
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: combine(signal, AbortSignal.timeout(20_000)) })
  const text = await res.text()
  checkAbort(signal)
  let json = null
  try {
    json = JSON.parse(text)
  } catch {}
  return { status: res.status, json, text }
}

// expiresAt is when a job token Qoder gave with expires_in (milliseconds)
// runs out; a day when it said none.
const expiresAt = (jt) => now() + (jt.expires_in > 0 ? jt.expires_in : DAY)

// exchangeExpiry is when a job token from /api/v1/jobToken/exchange runs
// out, as Qoder's own client reads it: expire_time or expires_at (a date)
// first, then expires_in (milliseconds), then a day.
function exchangeExpiry(jt) {
  for (const k of ["expire_time", "expires_at"]) {
    const at = Date.parse(String(jt?.[k] ?? "").trim())
    if (!isNaN(at)) return at
  }
  if (jt?.expires_in > 0) return now() + jt.expires_in
  return now() + DAY
}

// exchangeToken is the job token from an exchange response, as Qoder's
// client reads it: token, device_token or access_token.
function exchangeToken(jt) {
  return String(jt?.token ?? jt?.device_token ?? jt?.access_token ?? "").trim()
}

// patSignIn exchanges a Personal Access Token for a job token, bypassing
// the OAuth device flow. PATs are long-lived (up to 1 year): the PAT is
// kept on the credential, and when the job token's refresh lapses the PAT
// is exchanged again rather than asking the user to sign in once more.
async function patSignIn(site, pat, signal) {
  const machineId = randomUUID()
  const r = await openapi(site, "/api/v1/jobToken/exchange", { method: "POST", body: { personal_token: pat }, signal })
  if (r.status === 400 || r.status === 401 || r.status === 403)
    throw Object.assign(new Error(`${site.name} refused the PAT — check it is still valid`), { status: r.status })
  if (r.status !== 200) throw new Error(`${site.name} PAT exchange: status ${r.status}`)
  const token = exchangeToken(r.json)
  if (!token) throw new Error(`${site.name} PAT exchange: empty token in response`)
  const refresh = String(r.json?.refresh_token ?? r.json?.refreshToken ?? "").trim()
  const chat = { access: token, refresh, expires: exchangeExpiry(r.json) }
  let email = ""
  let name = ""
  let uid = ""
  try {
    const ui = await openapi(site, "/api/v1/userinfo", { token, signal })
    if (ui.status >= 200 && ui.status < 300) {
      ;[email, name] = [ui.json?.email ?? "", ui.json?.name ?? ""]
      uid = String(ui.json?.id ?? ui.json?.user_id ?? ui.json?.uid ?? "")
    }
  } catch (e) { checkAbort(signal) }
  if (!uid) throw new Error(`${site.name} PAT sign-in: could not determine user id`)
  return {
    ...chat,
    // The same name its browser sign-in takes: magpie's plugin host replaces
    // an account on a new sign-in when both the accountId and the uid match,
    // so a renewed PAT sign-in must keep naming the same account. A suffix
    // here would add a second row beside the lapsed one instead.
    accountId: email || uid,
    uid,
    email,
    name: name || "",
    machineId,
    pat,
  }
}

// SignInGone is a sign-in that can't sign a request: a 401. Only Qoder
// refusing the refresh token marks the account lapsed (expired), as the
// built-in's qoderRefreshFailed did; no refresh token, or no account,
// answered 401 there without marking one.
class SignInGone extends Error {
  constructor(message, expired = false) {
    super(message)
    this.expired = expired
  }
}

// refreshJob trades the job token's refresh token for a new pair; the old
// one is spent.
async function refreshJob(site, refresh, user, signal) {
  if (!String(refresh ?? "").trim()) throw new SignInGone(`${site.name}: the sign-in lapsed; sign in again`)
  const r = await openapi(site, "/api/v1/jobToken/refresh", { method: "POST", body: { refresh_token: refresh }, signal })
  if (r.status === 401 || r.status === 403)
    throw new SignInGone(`${user}'s ${site.name} sign-in has expired — sign in again (qoder job token refresh: status ${r.status})`, true)
  if (r.status !== 200) throw new Error(`qoder job token refresh: status ${r.status}`)
  if (!String(r.json?.token ?? "").trim() || !String(r.json?.refresh_token ?? "").trim())
    throw new Error("qoder job token refresh: incomplete token pair")
  return r.json
}

const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"]

// freeOf reads whether a model costs the plan no credits: a price_factor
// (the credits a request costs, as a multiple; priceFactor in camel case)
// of 0, the price Qoder's own client shows ("0×"). is_free is no word on
// that: Qoder's listing has it true on Qwen3.8-Max at 0.5×, an off-peak
// discount (错峰 4 折) on it, and Qoder's client shows the price, not it.
// It is taken only from a listing with no price at all. A price of 0 for
// the while an active promotion lasts, with a price before it, is a
// discount, not a free model; a limited-time free model (Qwen3.8-Flash:
// 0×, its original_price_factor 0.1 struck through) is free while it is.
function freeOf(raw) {
  const price = raw.price_factor ?? raw.priceFactor
  if (typeof price === "number" && Number.isFinite(price)) {
    if (price !== 0) return false
    const p = raw.promotion ?? raw.prommotion
    const before = p?.before_promotion_price_factor ?? p?.beforePromotionPriceFactor
    return !(p?.active === true && typeof before === "number" && before > 0)
  }
  return (raw.is_free ?? raw.isFree) === true
}

// rateOf reads a model's price as Qoder's client shows it beside the model
// (magpie shows it in its lists, so the cheap ones can be picked without
// opening Qoder): rate, the price_factor (0.5×), and rateWas, the price
// struck through beside it while a discount runs: an active promotion's
// before_promotion_price_factor, else an original_price_factor above the
// price (Qwen3.8-Flash: 0×, 0.1× struck through). A promotion's 0 that
// isn't free is its price before times its discount_factor. A listing with
// no price gives none (0). The same rule as magpie's built-in
// (internal/qoder/models.go, ModelInfo.free).
function rateOf(raw) {
  const price = raw.price_factor ?? raw.priceFactor
  if (typeof price !== "number" || !Number.isFinite(price)) return { rate: 0, rateWas: 0 }
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0)
  const p = raw.promotion ?? raw.prommotion
  const before = p?.before_promotion_price_factor ?? p?.beforePromotionPriceFactor
  const discount = num(p?.discount_factor) || num(p?.discountFactor)
  const discounted = p?.active === true && typeof before === "number" && before > 0
  let rate = Math.max(price, 0)
  let rateWas = Math.max(num(raw.original_price_factor), num(raw.originalPriceFactor))
  if (discounted) {
    rateWas = before
    if (rate === 0) rate = before * discount
  }
  if (rateWas <= rate) rateWas = 0
  return { rate, rateWas }
}

// windowsOf reads the context windows a listing entry offers, smallest
// first, and the one Qoder's client picks unless asked for another:
// context_config's entries ({"200k": {token_count: 200000, is_default:
// true}, "1m": {token_count: 1000000}, …}), else available_context_windows,
// as Qoder's client reads them (qodercli's catalog). Qoder's Context
// setting (200K / 400K / 1M) offers them on Qwen3.8-Flash and the rest;
// max_input_tokens (180K there) is only what a request that names none
// gets.
function windowsOf(raw) {
  const n = (v) => (Number.isInteger(v) && v > 0 ? v : 0)
  const windows = []
  let def = 0
  const cc = raw?.context_config ?? raw?.contextConfig
  if (cc && typeof cc === "object" && !Array.isArray(cc)) {
    for (const e of Object.values(cc)) {
      const t = n(e?.token_count)
      if (!t) continue
      if (!windows.includes(t)) windows.push(t)
      if (e.is_default === true || e.is_default === 1 || e.is_default === "1") def = t
    }
  }
  if (!windows.length) {
    const list = raw?.available_context_windows ?? raw?.availableContextWindows
    for (const v of Array.isArray(list) ? list : []) if (n(v) && !windows.includes(v)) windows.push(v)
    def = n(raw?.default_context_window ?? raw?.defaultContextWindow)
    if (!windows.includes(def)) def = 0
  }
  windows.sort((a, b) => a - b)
  return { windows, defaultWindow: def }
}

// modelInfo reads one entry of the listing's "chat" array: its efforts and
// default from thinking_config (is_reasoning alone when it has none), and
// its context: the largest window it offers (windowsOf), since a request
// that needs more than the default is sent a larger one (windowFor).
function modelInfo(raw) {
  const { windows, defaultWindow } = windowsOf(raw)
  const m = {
    key: raw.key,
    source: raw.source ?? "",
    name: raw.display_name || raw.key,
    images: !!raw.is_vl,
    context: windows.length ? windows[windows.length - 1] : raw.max_input_tokens || 0,
    windows,
    defaultWindow,
    thinks: !!raw.is_reasoning,
    alwaysThinks: false,
    efforts: Array.isArray(raw.reasoning_efforts) ? [...raw.reasoning_efforts] : [],
    defaultEffort: "",
    free: freeOf(raw),
    ...rateOf(raw),
    config: raw,
  }
  const tc = raw.thinking_config
  if (tc && typeof tc === "object") {
    m.thinks = tc.enabled != null
    m.alwaysThinks = m.thinks && tc.disabled == null
    m.efforts = []
    if (m.thinks) {
      for (const [name, e] of Object.entries(tc.enabled.efforts ?? {})) {
        m.efforts.push(name)
        if (e?.is_default) m.defaultEffort = name
      }
      const rank = (s) => (EFFORT_ORDER.includes(s) ? EFFORT_ORDER.indexOf(s) : EFFORT_ORDER.length)
      m.efforts.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))
    }
  }
  return m
}

// sceneModels is the models an agent can pick from the listing: the "app"
// scene's, which is what Qoder's app shows and what a request names
// (qoderBody's product and session_type "app"), in its order, then any
// "chat" model the app no longer lists, after the model it followed there,
// so a pick made before stays served. On 2026-10-12 the app listed Fast
// (fast, 0.8×) where Performance (1.1×) had been, and chat still listed
// Performance (magpie-community/plugins#97). A listing with only one scene
// gives that one. Each key once: the app's entry wins.
function sceneModels(listing) {
  const app = Array.isArray(listing?.app) ? listing.app : []
  const chat = Array.isArray(listing?.chat) ? listing.chat : []
  const out = [...app]
  let after = -1
  for (const m of chat) {
    const i = out.findIndex((x) => x?.key === m?.key)
    if (i >= 0) {
      after = i
      continue
    }
    out.splice(++after, 0, m)
  }
  return out
}

// modelInfos is the listing's enabled models an agent can pick: "auto"
// and "default" route inside Qoder and aren't one model. A site with its
// own scene reads that scene's list; one that lists all models keeps the
// disabled ones too (QwenWork's qwork scene carries its whole catalog).
function modelInfos(listing, site) {
  if (site?.modelScene) {
    return (Array.isArray(listing?.[site.modelScene]) ? listing[site.modelScene] : [])
      .filter((m) => (site.listAllModels || m?.enable) && !["", "auto", "default"].includes(String(m.key ?? "").trim()))
      .map(modelInfo)
  }
  return sceneModels(listing)
    .filter((m) => m?.enable && !["", "auto", "default"].includes(String(m.key ?? "").trim()))
    .map(modelInfo)
}

async function fetchListing(site, cred, signal) {
  const url = site.api + MODELS_PATH
  const res = await fetch(url, { headers: cosyHeaders(url, cred, "", site), signal: combine(signal, AbortSignal.timeout(15_000)) })
  const text = await res.text()
  checkAbort(signal)
  if (!res.ok) {
    throw new Error(`${site.name} models: HTTP ${res.status}: ${text.trim().slice(0, 512)}`)
  }
  return JSON.parse(text)
}

const EFFORT_RANK = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]

function fitEffort(want, levels) {
  if (want === "ultra" && !levels.includes(want)) want = "max"
  if (!levels.length || levels.includes(want)) return want
  const at = EFFORT_RANK.indexOf(want)
  if (at < 0) return want
  let best = want
  let dist = EFFORT_RANK.length
  for (const l of levels) {
    const i = EFFORT_RANK.indexOf(l)
    if (i < 0 || l === "none") continue
    const d = Math.abs(i - at)
    if (d < dist || (d === dist && i > at)) [best, dist] = [l, d]
  }
  return best
}

// effortFor is whether to think and at which of the model's efforts ("" for
// none): asked for none, a model that always thinks thinks at its lowest;
// asked for nothing, or a level Qoder doesn't name, at its own default.
function effortFor(asked, m) {
  let want = String(asked ?? "").toLowerCase()
  if (!EFFORT_RANK.includes(want)) want = ""
  if (!m.thinks || (want === "none" && !m.alwaysThinks)) return [false, ""]
  if (!m.efforts.length) return [true, ""]
  if (want === "") return [true, m.defaultEffort]
  if (want === "none") return [true, m.efforts[0]]
  return [true, fitEffort(want, m.efforts)]
}

function imageBlock(p) {
  const url = typeof p.image_url === "string" ? p.image_url : p.image_url?.url
  return url ? { type: "image_url", image_url: { url } } : null
}

function blocksOf(content) {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : []
  const out = []
  for (const p of content ?? []) {
    if (p?.type === "text" && p.text != null) out.push({ type: "text", text: p.text })
    else if (p?.type === "image_url") {
      const b = imageBlock(p)
      if (b) out.push(b)
    }
  }
  return out
}

const textOf = (c) => (typeof c === "string" ? c : blocksOf(c).filter((b) => b.type === "text").map((b) => b.text).join(""))

// qoderMessages is the chat's turns as Qoder takes them: text and image
// blocks, an assistant's tool calls as tool_calls, results as tool turns by
// tool_call_id. A tool turn holds text only, so the images a tool returned
// follow in a user turn — the start of the user's own when one comes next.
//
// Qoder turns the whole request away when a tool turn answers no call of the
// turn before it ("Messages with role 'tool' must be a response to a
// preceding message with 'tool_calls'"), where another API takes the same
// conversation. A client's history reaches here with such a turn because it
// dropped the id: either the call lost it, so the result names one no call
// has, or the result kept none. Both are filled in rather than dropped — a
// call without an id is given one, and the results after it take the ids it
// went out with in order, which is the pairing a dropped id means. Only a
// result with no call of its turn left to answer becomes text in the user's
// own turn, so the words the tool returned stay with the conversation.
// callID is the id a call the client sent without one goes out with: the
// same on every turn of the conversation (#290), made from where the call
// is and what it says, so the history Qoder sees doesn't change under a
// prompt cache from one request to the next.
function callID(at, k, c) {
  const args = c.function?.arguments
  const said = typeof args === "string" ? args : JSON.stringify(args ?? {})
  return "call_" + createHash("sha256").update(`${at}\0${k}\0${c.function?.name ?? ""}\0${said}`).digest("hex").slice(0, 32)
}

function qoderMessages(msgs) {
  const out = []
  const names = {}
  let seen = []
  const showSeen = () => {
    if (seen.length) out.push({ role: "user", content: seen })
    seen = []
  }
  // turn is the assistant turn being answered: the calls no result has
  // answered yet, in the order they were made, and the ones a result after
  // it names (kept), which a result whose id was lost must not take.
  let turn = null
  const asText = (txt, ims) => {
    const said = txt.trim()
    if (!said && !ims.length) return
    if (seen.length) seen.push({ type: "text", text: "\n\n" })
    if (said) seen.push({ type: "text", text: said })
    seen.push(...ims)
  }
  for (const [i, m] of msgs.entries()) {
    if (m.role === "system" || m.role === "developer") continue
    if (m.role === "user") turn = null
    if (m.role !== "user" && m.role !== "tool") showSeen()
    if (m.role === "tool") {
      let txt = textOf(m.content)
      const ims = Array.isArray(m.content) ? m.content.filter((p) => p?.type === "image_url").map(imageBlock).filter(Boolean) : []
      const named = String(m.tool_call_id ?? "").trim()
      // A result naming a call of this turn answers it; one whose id the
      // client lost — none, or one no call here has — answers the earliest
      // call still open that no other result names, which is the order the
      // calls were made in.
      const at = named ? turn?.open.findIndex((id) => id === named) ?? -1 : -1
      const pick = at >= 0 ? at : turn ? turn.open.findIndex((id) => !turn.kept.has(id)) : -1
      if (pick < 0) {
        asText(txt, ims)
        continue
      }
      const answered = turn.open.splice(pick, 1)[0]
      if (ims.length) {
        let of = "tool call " + answered
        const name = names[answered] || m.name
        if (name) of = `${name} (${of})`
        seen.push({ type: "text", text: `[From the result of ${of}:]` }, ...ims)
        const note = ims.length === 1 ? "[The tool returned an image; it follows in the next message.]" : `[The tool returned ${ims.length} images; they follow in the next message.]`
        txt = txt.trim() ? txt + "\n\n" + note : txt + note
      }
      out.push({ role: "tool", tool_call_id: answered, content: txt })
      continue
    }
    if (m.role === "assistant" && m.tool_calls?.length) {
      // a call the client sent without an id gets one, so its result can
      // answer it instead of being turned into text
      const calls = m.tool_calls.map((c, k) => {
        const id = String(c.id ?? "").trim() || callID(i, k, c)
        names[id] = c.function?.name
        const args = c.function?.arguments
        return { id, type: "function", function: { name: c.function?.name, arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}) } }
      })
      out.push({ role: "assistant", content: textOf(m.content), tool_calls: calls })
      const open = calls.map((c) => c.id)
      const kept = new Set()
      for (let j = i + 1; j < msgs.length && msgs[j].role === "tool"; j++) {
        const id = String(msgs[j].tool_call_id ?? "").trim()
        if (open.includes(id)) kept.add(id)
      }
      turn = { open, kept }
      continue
    }
    let blocks = blocksOf(m.content)
    if (m.role === "assistant") blocks = blocks.filter((b) => b.type === "text")
    if (!blocks.length) continue
    if (m.role === "user" && seen.length) [blocks, seen] = [[...seen, ...blocks], []]
    out.push({ role: m.role, content: blocks })
    // a result after the assistant's own words answers no call before it
    turn = null
  }
  showSeen()
  return out
}

// windowFor is the context window a request is sent (context_length) on a
// model that offers several: the one Qoder's client picks by default
// (max_input_tokens without one) while the request fits it, else the
// smallest that holds it, else the largest. A larger window may cost more
// (Qoder: changing the Context "may change the rate"), so it is asked for
// only when the conversation needs it. The request's size is counted
// generously, a token for every 3 bytes of its UTF-8 JSON, so a window is
// raised a little early rather than late, and the reply's max_tokens is
// counted in it: a window holds the prompt and the reply, so a
// conversation of 180K asking 32K for the reply is sent 400K, not the 200K
// it would overflow while magpie says the model takes 1M (yetone/magpie#700).
function windowFor(chat, m, reply = 0) {
  const base = m.defaultWindow || (m.config?.max_input_tokens > 0 ? m.config.max_input_tokens : 0) || m.context
  if (!m.windows?.length) return m.context
  const need = Math.ceil(Buffer.byteLength(JSON.stringify({ m: chat.messages ?? [], t: chat.tools ?? [] })) / 3) + Math.max(0, reply)
  if (base > 0 && need <= base) return base
  return m.windows.find((w) => w >= need) ?? m.windows[m.windows.length - 1]
}

// UNCACHED are the blocks Qoder's client never marks for the prompt cache.
const UNCACHED = new Set(["thinking", "redacted_thinking", "tool_use", "tool_result"])

// cacheMarked is the turns as Qoder's own client sends them for the prompt
// cache (#290): every user turn's blocks also as contents, and the last
// block of the last turn that isn't thinking or a tool's marked
// cache_control ephemeral. That is qoder-agent-sdk's (Qoder.app and
// qodercli 1.1.75 alike): the last message's last such block, and nothing
// when the last turn is a tool's. A model behind Qoder that caches only
// what is marked (Anthropic's) read none of a conversation without it,
// while one that caches on its own (Fast) did. The caller's turns are left
// as they were.
function cacheMarked(msgs) {
  const out = msgs.map((m) => (m.role === "user" && Array.isArray(m.content) ? { ...m, contents: m.content } : m))
  const last = out.at(-1)
  if (last?.role !== "user" || !Array.isArray(last.content)) return out
  const at = last.content.findLastIndex((b) => b?.type && !UNCACHED.has(b.type))
  if (at < 0) return out
  const blocks = last.content.slice()
  blocks[at] = { ...blocks[at], cache_control: { type: "ephemeral" } }
  out[out.length - 1] = { ...last, content: blocks, contents: blocks }
  return out
}

// sessionOf is the session_id a request goes out under: one for every turn
// of a conversation and another for each conversation, as Qoder's client
// sends its own session's (#290). Qoder can keep a conversation where its
// prompt is cached only when its turns say they are one. It is the session
// the agent named (named: DSH's x-deepseek-harness-session-id, OpenCode's
// session, as the chat.headers hook is told it, #330), else the client's
// prompt_cache_key (Codex's thread), else its user, else the
// conversation's opening (its system prompt and first user turn), hashed,
// so no key of the client's goes to Qoder as it is. DSH changes its system
// prompt mid-task (yetone/magpie#3298), so its own session is the one that
// holds for the whole task.
function sessionOf(chat, named = "") {
  let seed = named ? "session\0" + named : String(chat.prompt_cache_key ?? "").trim() ? "key\0" + chat.prompt_cache_key : String(chat.user ?? "").trim() ? "user\0" + chat.user : ""
  if (!seed) {
    const msgs = chat.messages ?? []
    const sys = msgs.filter((x) => x.role === "system" || x.role === "developer").map((x) => textOf(x.content))
    const first = msgs.find((x) => x.role === "user")
    seed = "chat\0" + JSON.stringify([sys, first?.content ?? ""])
  }
  const h = createHash("sha256").update(seed).digest("hex")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

// A task is what Qoder's client sends under one request_set_id and one
// business record (#330): every model call that answers one user prompt,
// the tool loop's turns included. qoder-agent-sdk (Qoder.app's
// qoder-worker-runtime, AgentLifecycle) makes the record once per prompt
// (business.id the prompt's requestSetId, begin_at when the prompt
// started, stage "start"), keeps it for each call of the loop, and moves
// stage to "processing" once a call is answered; only request_id and
// chat_record_id are new on every call. The plugin made a new record for
// every call, so a 265-call DSH task was 265 tasks to Qoder. A task here is
// a session's last user turn: the tool loop repeats it, and a new prompt
// is a new one. TASKS holds at most TASK_MAX of them, each for TASK_IDLE
// after its last call, so a long-running magpie doesn't grow with them.
const TASKS = new Map()
const TASK_MAX = 512
const TASK_IDLE = 2 * 60 * 60 * 1000

// taskName is the business record's name for a task whose prompt is
// prompt, as Qoder's client names an agent task: the prompt's first ten
// characters (qoder-agent-sdk's AgentLifecycle, hdr → C6s: type
// "code_review" takes the session id, every other the prompt, sliced to
// 10 when longer).
const taskName = (prompt) => (prompt.length > 10 ? prompt.slice(0, 10) : prompt)

// taskOf is the task chat's call belongs to, in session sid: made on its
// first call, the same one on every call after.
function taskOf(sid, chat, atTime = now()) {
  const msgs = chat.messages ?? []
  const at = msgs.findLastIndex((x) => x?.role === "user")
  const key = createHash("sha256").update(JSON.stringify([sid, at, at < 0 ? null : msgs[at].content ?? null])).digest("hex")
  for (const [k, t] of TASKS) {
    if (atTime - t.used <= TASK_IDLE) break
    TASKS.delete(k)
  }
  let t = TASKS.get(key)
  if (t && atTime - t.used > TASK_IDLE) t = undefined
  TASKS.delete(key)
  t ??= { id: randomUUID(), begin: atTime, answered: false, name: taskName(at < 0 ? "" : textOf(msgs[at].content)) }
  t.used = atTime
  TASKS.set(key, t)
  while (TASKS.size > TASK_MAX) TASKS.delete(TASKS.keys().next().value)
  return t
}

// Qoder CN's kmodel (Kimi K3.1 Pro) fails a chat whose tools hold a oneOf
// with no type, even of objects only, and takes it with "type": "object"
// beside it (congee949, #378: dsh's REA tools, a 502 here). typedUnions is
// the schema with each such oneOf typed object when each branch is typed
// object itself or through a chain of local $refs; nothing else changes,
// and the caller's own schema is not touched.
const SUB_ONE = ["items", "additionalItems", "unevaluatedItems", "contains", "not", "if", "then", "else", "propertyNames", "additionalProperties", "unevaluatedProperties"]
const SUB_LIST = ["anyOf", "oneOf", "allOf", "prefixItems"]
const SUB_MAP = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]
function typedUnions(schema) {
  if (!schema || typeof schema !== "object") return schema
  const root = structuredClone(schema)
  const isObj = (v) => v && typeof v === "object" && !Array.isArray(v)
  const target = (ref) => {
    if (!ref.startsWith("#/")) return undefined
    let at = root
    for (const k of ref.slice(2).split("/")) at = at?.[k.replaceAll("~1", "/").replaceAll("~0", "~")]
    return isObj(at) ? at : undefined
  }
  const object = (b, seen = []) => {
    if (!isObj(b)) return false
    if ("type" in b) return b.type === "object"
    if (typeof b.$ref !== "string" || seen.includes(b.$ref) || seen.length > 16) return false
    return object(target(b.$ref), [...seen, b.$ref])
  }
  const walk = (s, depth) => {
    if (!isObj(s) || depth > 64) return
    if (!("type" in s) && Array.isArray(s.oneOf) && s.oneOf.length && s.oneOf.every((b) => object(b))) s.type = "object"
    for (const k of SUB_ONE) walk(s[k], depth + 1)
    for (const k of SUB_LIST) for (const v of Array.isArray(s[k]) ? s[k] : []) walk(v, depth + 1)
    for (const k of SUB_MAP) if (isObj(s[k])) for (const v of Object.values(s[k])) walk(v, depth + 1)
  }
  walk(root, 0)
  return root
}

// qoderBody is the plaintext agent_chat_generation takes for a chat
// completion request, for model m, in the session the agent named (named,
// "" when none) and the task it is a call of (taskOf's, a new one when
// none is given). A site on this protocol with its own values (QwenWork)
// passes itself last.
function qoderBody(chat, m, named = "", task, site) {
  const system = (chat.messages ?? []).filter((x) => x.role === "system" || x.role === "developer").map((x) => textOf(x.content)).filter(Boolean).join("\n\n")
  const tools = chat.tool_choice !== "none" ? (chat.tools ?? []).filter((t) => t?.type === "function" && t.function?.name) : []
  const baseSystem = site?.systemPrompt ?? QODER_SYS
  let sysText = system ? baseSystem + "\n\n" + system : baseSystem
  if (chat.tool_choice === "required" && tools.length) sysText += "\nYou must call an available function in this response."
  const sys = { type: "text", text: sysText }
  const [thinking, effort] = effortFor(chat.reasoning_effort, m)
  const params = { enable_thinking: thinking, max_tokens: chat.max_completion_tokens || chat.max_tokens || 32000 }
  if (effort) params.reasoning_effort = effort
  const window = windowFor(chat, m, params.max_tokens)
  if (window > 0) params.context_length = window
  const request = randomUUID()
  const session = sessionOf(chat, named)
  task ??= taskOf(session, chat)
  const body = {
    request_id: request,
    request_set_id: task.id,
    chat_record_id: request,
    session_id: session,
    parameters: params,
    business: { product: site?.businessProduct ?? "app", version: site?.cosyVersion ?? COSY_VERSION, type: "agent", id: task.id, name: task.name ?? "", begin_at: task.begin, stage: task.answered ? "processing" : "start" },
    agent_id: "agent_common",
    task_id: "common",
    session_type: site?.sessionType ?? "app",
    model_config: m.config,
    system: [sys],
    messages: [{ role: "system", content: [sys] }, ...cacheMarked(qoderMessages(chat.messages ?? []))],
  }
  if (tools.length)
    body.tools = tools.map((t) => ({
      type: "function",
      function: { name: t.function.name, description: t.function.description ?? "", parameters: typedUnions(t.function.parameters) ?? { type: "object", properties: {} } },
    }))
  return body
}

// failure is the status and message for a Qoder failure. Qoder's own code
// says what it is, read as Qoder's client reads it (QoderErrorCode in the
// app's qoder-agent-sdk worker): only 105 (loginExpired) is a lapsed
// sign-in there, so a 401/403 that carries another code isn't one here
// either (#98: a queued 10605 came as a 403 and read as "sign in again").
// A refused chat with no code keeps the built-in's 401, and a quota is a
// 429.
const QUEUED = "10605"
// the codes Qoder's client counts as a plan's usage or credits used up
const QUOTA_CODES = new Set(["110", "112", "113", "114", "115", "116", "117", "118", "119", "122"])
// refusals of this request, not of the account: sensitive content, not
// supported, input too long, too many media, a custom model's service
const REQUEST_CODES = new Set(["406", "416", "430", "80411", "80412", "100400", "100401", "100403"])
const BUSY_WAIT = 30
// UPSTREAM_FAILED is Qoder saying the model's own vendor behind it failed:
// "Error in upstream response", which Qoder sends as a 400 (SlouchyQuill507
// on Discord, qoder-cn). Nothing is wrong with the request or the account,
// so it is a 502, which magpie asks again or of another account, not a
// 400 that ends the turn as the client's fault. A request too long for the
// model fails the same way, and magpie tells that one apart by its size
// (tooLongUnsaid), at 502 as at 400.
const UPSTREAM_FAILED = /\berror in upstream response\b/i

function failure(status, text) {
  if (status < 400 || status > 599) status = 502
  let msg = String(text ?? "").trim()
  let code = ""
  let queue
  try {
    let j = JSON.parse(msg)
    // #167: an HTTP/message wrapper can hold the actual 10605 body.
    // Unwrap only that known queue code; a real auth/credit/request code
    // on the outer body remains authoritative.
    const outerCode = j?.code == null ? "" : String(j.code)
    if (["", "401", "403"].includes(outerCode) && typeof j?.message === "string") {
      try {
        const inner = JSON.parse(j.message.trim())
        if (inner && !Array.isArray(inner) && String(inner.code) === QUEUED) j = inner
      } catch {}
    }
    code = j?.code == null ? "" : String(j.code)
    if (j?.message) msg = String(j.message)
    // details is a JSON string, or the object itself (gjson reads either)
    const d = typeof j?.details === "string" ? JSON.parse(j.details.trim()) : j?.details
    if (d?.error?.message) msg += ": " + d.error.message
    // the queue's state: the message itself, as a JSON string, or a field
    queue = j?.queue && typeof j.queue === "object" ? j.queue : undefined
    if (!queue && typeof j?.message === "string" && j.message.trim().startsWith("{")) {
      const q = JSON.parse(j.message.trim())
      if (q && typeof q === "object" && ("isQueued" in q || "serviceAvailable" in q || "retryAfterSeconds" in q)) queue = q
    }
  } catch {}
  msg ||= STATUS_CODES[status] ?? `HTTP ${status}`
  // Qoder's queue for the model: busy for now, with when to ask again. The
  // sign-in is fine (the same token reads the models and the usage), so it
  // is a 503 with Retry-After, which magpie asks again after, and never
  // touches the account's sign-in.
  if (code === QUEUED || queue?.isQueued === true || queue?.serviceAvailable === false) {
    const n = Number(queue?.retryAfterSeconds)
    const wait = Number.isFinite(n) && n > 0 ? Math.ceil(n) : BUSY_WAIT
    const model = queue?.modelKey ? ` for ${queue.modelKey}` : ""
    const ahead = Number(queue?.queueCount) > 0 ? `, ${Math.floor(Number(queue.queueCount))} ahead` : ""
    const tier = queue?.queueType ? ` (this plan's queue: ${queue.queueType}${ahead})` : ahead ? ` (${ahead.slice(2)})` : ""
    const what = queue?.isQueued === true ? "queued the request" : "is busy"
    return { status: 503, message: `Qoder ${what}${model}${tier}; try again in ${wait}s`, retryAfter: wait, signIn: "", queue: queue ?? {} }
  }
  if (QUOTA_CODES.has(code)) return { status: 429, message: "usage limit reached: " + msg, signIn: "" }
  if (REQUEST_CODES.has(code)) return { status: 400, message: `Qoder refused the request (${code}): ${msg}`, signIn: "" }
  if (UPSTREAM_FAILED.test(msg)) return { status: 502, message: msg, signIn: "" }
  // a refused chat is the built-in's 401, which never marked the account
  // lapsed: only a refused refresh did (errorResponse says kept). Qoder's
  // own words go with it: a 401 right after signing in isn't a lapsed
  // sign-in, and its reason is what says what is (Yayoi_no_yume on X).
  if (status === 401 || status === 403) {
    const said = msg && msg !== STATUS_CODES[status] ? ` (Qoder said ${status}: ${msg.slice(0, 300)})` : ""
    return { status: 401, message: "the sign-in lapsed — sign in again" + said }
  }
  if (status === 429 || msg.toLowerCase().includes("quota")) return { status: 429, message: "usage limit reached: " + msg }
  return { status, message: msg }
}

// errorResponse is a failure as OpenAI's API gives it. signIn is what it
// means for the account (magpie's X-Magpie-Sign-In): a 401 keeps it unless
// told expired, since the built-in marked only a refused refresh. retryAfter
// (seconds) is sent as Retry-After.
const errorResponse = ({ status, message, signIn = status === 401 ? "kept" : undefined, retryAfter }) =>
  new Response(JSON.stringify({ error: { message, type: "qoder_error", code: status }, ...(status === 503 && retryAfter > 0 ? { retry_after: Math.ceil(Number(retryAfter)) } : {}) }), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...(signIn ? { "X-Magpie-Sign-In": signIn } : {}),
      ...(retryAfter > 0 ? { "Retry-After": String(retryAfter) } : {}),
    },
  })

// ---- Qoder's queue -------------------------------------------------------------

// A chat Qoder answers with its queue code (10605) is waited out as Qoder's
// own client waits it (qoder-agent-sdk's worker in Qoder.app 0.4.3, its
// "[ModelQueue]" path): it asks GET /api/v2/service/ask/queue/status with
// the request's requestSetId, the model and the plan's queueType, at once
// and then every retryAfterSeconds (held to 0.5s..30s, 30s when unsaid),
// while the state says isQueued or serviceAvailable false. Once isQueued is
// false it waits that state's retryAfterSeconds, if any, and sends the
// request again in the same request_set_id under a new request_id and
// chat_record_id, up to 10 times; the refused call's stream is closed. Three failed asks
// in a row, a 404 (no queue there) or a state with neither field end the
// wait. Qoder's client waits up to an hour; here the whole of it is held
// under QUEUE.budget from the request's start, since nothing reaches the
// agent meanwhile: magpie keeps a stream's agent alive with comments for 5
// minutes of a vendor's silence, and then leaves it to the agent's own
// timeout. Past the budget it is the 503 with Retry-After it was before, so
// magpie may ask another account. Qoder's client also tells
// /api/v2/service/ask/finish when its turn ends; that is left out, and its
// own log says Qoder's TTL releases the lease when finish is not heard.
const QUEUE_STATUS_PATH = "/algo/api/v2/service/ask/queue/status"
const QUEUE = {
  budget: 4 * 60 * 1000, // the longest a request is held, its first answer's wait included
  shortest: 500,
  longest: 30_000,
  unsaid: 30_000, // a pause when the queue gives no retryAfterSeconds
  recoveries: 10, // the queue waited out this many times, at most, for one request
  failures: 3, // status asks failing in a row that end the wait
  ask: 30_000, // the longest one status ask may take
  now: () => now(),
  pause: (ms, signal) =>
    new Promise((ok, no) => {
      if (signal?.aborted) return no(signal.reason ?? new DOMException("aborted", "AbortError"))
      const t = setTimeout(() => {
        signal?.removeEventListener("abort", stop)
        ok()
      }, ms)
      const stop = () => {
        clearTimeout(t)
        no(signal.reason ?? new DOMException("aborted", "AbortError"))
      }
      signal?.addEventListener("abort", stop, { once: true })
    }),
}

// queuePause is how long to wait before asking the queue again: the
// queue's retryAfterSeconds held to 0.5s..30s, or 30s when it said none.
function queuePause(seconds) {
  const n = Number(seconds)
  const ms = Number.isFinite(n) ? n * 1000 : QUEUE.unsaid
  return Math.min(QUEUE.longest, Math.max(QUEUE.shortest, ms))
}

class QueueEnd extends Error {}

// queueState is the queue's state in a status reply, found as Qoder's
// client finds it: the object, or one under data/result/message/body, as
// an object or a JSON string, that says isQueued or serviceAvailable.
function queueState(text) {
  let root
  try {
    root = JSON.parse(text)
  } catch {
    return undefined
  }
  const todo = [root]
  const seen = new Set()
  while (todo.length) {
    const o = todo.shift()
    if (!o || typeof o !== "object" || Array.isArray(o) || seen.has(o)) continue
    seen.add(o)
    const flag = (v) => (typeof v === "boolean" ? v : v === "true" ? true : v === "false" ? false : undefined)
    const isQueued = flag(o.isQueued)
    const serviceAvailable = flag(o.serviceAvailable)
    if (isQueued !== undefined || serviceAvailable !== undefined) {
      const num = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? undefined : Number(v))
      const str = (v) => (typeof v === "string" && v ? v : undefined)
      return { isQueued, serviceAvailable, modelKey: str(o.modelKey), queueType: str(o.queueType), retryAfterSeconds: num(o.retryAfterSeconds) }
    }
    for (const k of ["data", "result", "message", "body"]) {
      const v = o[k]
      if (v && typeof v === "object") todo.push(v)
      else if (typeof v === "string")
        try {
          todo.push(JSON.parse(v))
        } catch {}
    }
  }
  return undefined
}

// queueStatus asks Qoder's queue where the request stands.
async function queueStatus(api, cred, { requestSetId, modelKey, queueType, requestId, sessionId }, signal, deadline, site) {
  const q = new URLSearchParams({ requestSetId, modelKey })
  if (queueType) q.set("queueType", queueType)
  const url = `${api}${QUEUE_STATUS_PATH}?${q}`
  const headers = { ...cosyHeaders(url, cred, "", site), "X-Request-ID": requestId, "X-Session-ID": sessionId }
  delete headers["Content-Type"]
  const left = Math.min(QUEUE.ask, deadline - QUEUE.now())
  if (left <= 0) throw new QueueEnd("the queue's wait ran out")
  const res = await fetch(url, { headers, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(left)]) : AbortSignal.timeout(left) })
  const text = await res.text()
  checkAbort(signal)
  if (res.status === 404) throw new QueueEnd("Qoder has no queue status here")
  if (!res.ok) throw new Error(`queue status: HTTP ${res.status}`)
  const st = queueState(text)
  if (!st) throw new QueueEnd("the queue status said nothing of the queue")
  return st
}

// queueWait waits in Qoder's queue for the request, from the state its
// refusal gave, until the queue lets it through (true) or the wait ends
// (false). A cancelled request throws.
async function queueWait(api, cred, ask, first, signal, deadline, site) {
  let q = first ?? {}
  let asked = false
  let failed = 0
  for (;;) {
    checkAbort(signal)
    if (QUEUE.now() >= deadline) return false
    if (asked) await QUEUE.pause(Math.min(queuePause(q.retryAfterSeconds), Math.max(0, deadline - QUEUE.now())), signal)
    asked = true
    if (QUEUE.now() >= deadline) return false
    let st
    try {
      st = await queueStatus(api, cred, { ...ask, modelKey: q.modelKey ?? ask.modelKey, queueType: q.queueType ?? ask.queueType }, signal, deadline, site)
    } catch (e) {
      checkAbort(signal)
      if (e instanceof QueueEnd) return false
      if (++failed >= QUEUE.failures) return false
      q = { ...q, retryAfterSeconds: undefined }
      continue
    }
    failed = 0
    q = { ...st, modelKey: st.modelKey ?? q.modelKey, queueType: st.queueType ?? q.queueType }
    if (st.isQueued === false) {
      if (st.retryAfterSeconds > 0) await QUEUE.pause(Math.min(queuePause(st.retryAfterSeconds), Math.max(0, deadline - QUEUE.now())), signal)
      return QUEUE.now() < deadline
    }
    if (st.serviceAvailable === false || st.isQueued === true) continue
    return false
  }
}

// ---- the reply ----------------------------------------------------------------

const CALL_OPEN = "\x3ctool_call\x3e"
const CALL_CLOSE = "\x3c/tool_call\x3e"
const FUNC = /\x3cfunction=([^>]+)\x3e([\s\S]*?)\x3c\/function\x3e/
const PARAM = /\x3cparameter=([^>]+)\x3e([\s\S]*?)\x3c\/parameter\x3e/g

// parseCall reads one tool-call block: JSON {name, arguments}, or the XML
// function/parameter form, its values typed as the tool's schema says
// (xmlArgs).
function parseCall(v, tools = []) {
  try {
    const f = JSON.parse(v.trim())
    if (String(f?.name ?? "").trim() && f.arguments && typeof f.arguments === "object" && !Array.isArray(f.arguments))
      return { name: f.name.trim(), args: JSON.stringify(f.arguments) }
  } catch {}
  const m = FUNC.exec(v)
  if (!m || !m[1].trim()) return null
  const name = m[1].trim()
  const props = propsOf(tools, name)
  const args = {}
  for (const pm of m[2].matchAll(PARAM)) {
    const key = pm[1].trim()
    if (!key) continue
    args[key] = valueOf(pm[2].trim(), props[key])
  }
  return { name, args: JSON.stringify(args) }
}

// propsOf is the parameters the request declared for tool name
const propsOf = (tools, name) => (tools.find((t) => (t.function ?? t)?.name === name)?.function ?? {}).parameters?.properties ?? {}

// valueOf is a parameter's value: its text where the tool's schema says
// string, else its JSON (an array a tool takes), else its text (#323: a
// string holding [1, 2] became an array)
function valueOf(v, prop) {
  if (prop?.type === "string") return v
  try {
    return JSON.parse(v.trim())
  } catch {
    return v
  }
}

// Anthropic's and Qwen's call tags, written bare (no <tool_call> around
// them), as Kimi, MiMo and Qwen models may (#323, as trae's since 0.2.19):
// where one starts, an opener still being written, the openers a wrapper
// is followed by, the next call's opener, a parameter's opener, and what
// is left after a call
const XML_AT = /<(?:antml:)?(?:function_calls>|invoke\s+name\s*=|function=)/
const XML_HOLD = /<(?:antml:)?(?:invoke\s[^<>]{0,300}|function=[^<>]{0,300})$/
const XML_STARTS = ["<invoke ", "<antml:invoke ", "<function="]
const XML_MARKS = ["<function_calls>", "<antml:function_calls>", ...XML_STARTS]
const XML_NEXT = /<(?:antml:)?invoke\s+name\s*=|<function=/
const XML_PARAM = /<(?:antml:)?parameter(?:\s+name\s*=\s*"([^"]+)"|=([^\s>]+))\s*>/g
const XML_CLOSES = ["</function_calls>", "</antml:function_calls>", "</invoke>", "</antml:invoke>", "</function>"]
const XML_LEFT = /^(?:\s+|<\/(?:antml:)?(?:function_calls|invoke|function)>)+/

// xmlArgs reads the parameters of an invoke or function body, typed by
// the tool's schema; closed is whether every one was closed
function xmlArgs(s, props) {
  const opens = [...s.matchAll(XML_PARAM)]
  const args = {}
  let closed = opens.length > 0
  opens.forEach((m, k) => {
    let v = s.slice(m.index + m[0].length, k + 1 < opens.length ? opens[k + 1].index : s.length)
    const c = v.search(/<\/(?:antml:)?parameter>/)
    if (c >= 0) v = v.slice(0, c)
    else closed = false
    args[m[1] ?? m[2]] = valueOf(v.replace(/^\r?\n|\r?\n$/g, ""), props[m[1] ?? m[2]])
  })
  return { args, closed }
}

// xmlCall reads a bare call in Anthropic's tags (<function_calls> around
// one or more <invoke name="…"><parameter name="k">v</parameter>
// </invoke>) or Qwen's (<function=…><parameter=k>v</parameter>
// </function>), s starting at its first tag: {call, rest}, {wait} while
// it may still become one, {text} when it is no call (a tool the request
// didn't declare, a tag named in prose), {error} for one cut short. Only
// a declared tool's call counts: these tags are common in prose.
function xmlCall(s, end, tools) {
  const w = s.match(/^<(?:antml:)?function_calls>/)
  if (w) {
    const rest = s.slice(w[0].length).replace(/^\s+/, "")
    if (!end && (!rest || XML_STARTS.some((k) => k.startsWith(rest)))) return { wait: true }
    s = rest
  }
  let m = s.match(/^<(?:antml:)?invoke\s+name\s*=\s*"([^"<>]+)"\s*>/)
  let closeRe = /<\/(?:antml:)?invoke\s*>/
  if (!m) {
    m = s.match(/^<function=([^\s<>]+?)\s*>/)
    closeRe = /<\/function\s*>/
  }
  if (!m) {
    if (!end && (XML_STARTS.some((k) => k.startsWith(s)) || /^<(?:antml:)?(?:invoke\s|function=)[^<>]{0,300}$/.test(s))) return { wait: true }
    return { text: true }
  }
  const name = m[1].trim()
  if (!tools.some((t) => (t.function ?? t)?.name === name)) return { text: true }
  const body = s.slice(m[0].length)
  const c = body.match(closeRe)
  const n = body.search(XML_NEXT)
  let stop = c ? c.index : -1
  if (n >= 0 && (stop < 0 || n < stop)) stop = n
  if (stop < 0) {
    if (!end) return { wait: true }
    stop = body.length
  }
  const whole = !!c && c.index === stop
  const p = xmlArgs(body.slice(0, stop), propsOf(tools, name))
  if (!whole && !p.closed) {
    // no parameter and no close: a tag named in passing; a parameter
    // left open: the call cut short
    if (!/<(?:antml:)?parameter\b/.test(body.slice(0, stop))) return { text: true }
    return { error: CUT_SHORT }
  }
  return { call: { name, args: JSON.stringify(p.args) }, rest: whole ? body.slice(stop + c[0].length) : body.slice(stop) }
}

// quoted says text ends inside a code fence or an inline code span: a
// <tool_call> there is prose about one, not a call
function quoted(text) {
  if ((text.match(/```/g)?.length ?? 0) % 2) return true
  const line = text.slice(text.lastIndexOf("\n") + 1).replace(/```/g, "")
  return (line.match(/`/g)?.length ?? 0) % 2 === 1
}

// callish says a block was on its way to being a call: its JSON began, or
// the XML function form
const callish = (v) => v.trimStart().startsWith("{") || v.includes("\x3cfunction=")

const CUT_SHORT = "the model's tool call, written as text, was cut short; it is not sent on as the answer"
const UNREADABLE = "the model's tool call, written as text, can't be read; it is not sent on as the answer"

// Splitter holds text until a whole tool-call block has come, then gives
// it as a call. A block on its way to being a call that can't be read, or
// that the stream ended inside, is an error, never the answer (plugins#132,
// as trae's since plugins#38): the turn fails so it can be tried again. A
// block whose JSON is whole when the stream ends without its close is still
// the call; one that is no call at all, or one in code, stays text. A bare
// call in Anthropic's or Qwen's tags (xmlCall) is a call too, for a tool
// the request declared (tools).
class Splitter {
  textBuf = ""
  callBuf = ""
  inCall = false
  sawTool = false
  after = false // a bare call just ended: the closes and blanks after it are dropped
  sent = "" // the text given out so far, to tell a block in code from a call
  constructor(tools = []) {
    this.tools = tools.filter((t) => (t?.function ?? t)?.name)
  }
  text(out, t) {
    this.sent += t
    out.push({ text: t })
  }
  // bare reads text that may hold a bare call, comb starting at its tag x:
  // the input left to read, null when comb is held for more, or false
  // when the turn ended in an error
  bare(out, comb, x, end) {
    const head = comb.slice(0, x)
    const at = comb.slice(x)
    const opener = at.match(/^<[^<>]*>?/)[0]
    if (quoted(this.sent + head)) {
      this.text(out, head + opener)
      return at.slice(opener.length)
    }
    const b = xmlCall(at, end, this.tools)
    if (b.wait) {
      if (head) this.text(out, head)
      this.textBuf = at
      return null
    }
    if (b.text) {
      this.text(out, head + opener)
      return at.slice(opener.length)
    }
    if (head) this.text(out, head)
    if (b.error) {
      out.push({ error: b.error })
      return false
    }
    this.sawTool = true
    out.push({ call: b.call })
    this.after = true
    return b.rest
  }
  // left drops what is left after a bare call; null while it may still be
  // one of its closes
  left(comb, end) {
    const rest = comb.replace(XML_LEFT, "")
    if (!end && (!rest || XML_CLOSES.some((c) => c.length > rest.length && c.startsWith(rest)))) return null
    this.after = false
    return rest
  }
  feed(input) {
    const out = []
    while (input) {
      if (!this.inCall) {
        let comb = this.textBuf + input
        this.textBuf = ""
        if (this.after) {
          const rest = this.left(comb, false)
          if (rest === null) {
            this.textBuf = comb
            break
          }
          comb = rest
          if (!comb) break
        }
        const i = comb.indexOf(CALL_OPEN)
        const x = this.tools.length ? comb.search(XML_AT) : -1
        if (x >= 0 && (i < 0 || x < i)) {
          const next = this.bare(out, comb, x, false)
          if (next === false) return out
          if (next === null) break
          input = next
          continue
        }
        if (i < 0) {
          let keep = 0
          for (const mark of this.tools.length ? [CALL_OPEN, ...XML_MARKS] : [CALL_OPEN])
            for (let n = Math.min(mark.length - 1, comb.length); n > keep; n--)
              if (comb.endsWith(mark.slice(0, n))) {
                keep = n
                break
              }
          const h = this.tools.length ? comb.search(XML_HOLD) : -1
          if (h >= 0) keep = Math.max(keep, comb.length - h)
          if (keep < comb.length) this.text(out, comb.slice(0, comb.length - keep))
          this.textBuf = comb.slice(comb.length - keep)
          break
        }
        if (i > 0) this.text(out, comb.slice(0, i))
        input = comb.slice(i + CALL_OPEN.length)
        this.inCall = true
        continue
      }
      const comb = this.callBuf + input
      this.callBuf = ""
      const j = comb.indexOf(CALL_CLOSE)
      if (j < 0) {
        this.callBuf = comb
        break
      }
      const body = comb.slice(0, j)
      const c = parseCall(body, this.tools)
      if (c) {
        this.sawTool = true
        out.push({ call: c })
      } else if (callish(body) && !quoted(this.sent)) {
        this.inCall = false
        out.push({ error: UNREADABLE })
        return out
      } else this.text(out, CALL_OPEN + body + CALL_CLOSE)
      input = comb.slice(j + CALL_CLOSE.length)
      this.inCall = false
    }
    return out
  }
  flush() {
    if (this.inCall) {
      const body = this.callBuf
      this.inCall = false
      this.callBuf = ""
      if (callish(body) && !quoted(this.sent)) {
        const c = parseCall(body, this.tools)
        if (!c) return [{ error: CUT_SHORT }]
        this.sawTool = true
        return [{ call: c }]
      }
      const t = CALL_OPEN + body
      this.sent += t
      return [{ text: t }]
    }
    if (this.textBuf) {
      let t = this.textBuf
      this.textBuf = ""
      if (this.after) t = this.left(t, true)
      // what was held for a bare call, read to its end: calls, then the
      // text left, or the error of one cut short
      const out = []
      while (t) {
        const x = this.tools.length ? t.search(XML_AT) : -1
        if (x < 0) {
          this.text(out, t)
          break
        }
        const next = this.bare(out, t, x, true)
        if (next === false) break
        t = this.after ? this.left(next, true) : next
      }
      return out
    }
    return []
  }
}

async function* sseLines(body, signal) {
  const dec = new TextDecoder()
  let buf = ""
  for await (const chunk of body) {
    checkAbort(signal)
    buf += dec.decode(chunk, { stream: true })
    let n
    while ((n = buf.indexOf("\n")) >= 0) {
      yield buf.slice(0, n).trim()
      buf = buf.slice(n + 1)
    }
  }
  checkAbort(signal)
  if (buf.trim()) yield buf.trim()
}

// events turns Qoder's SSE into chat completion pieces: each data line's
// envelope has a "body" that is an OpenAI chunk, whose content may hold
// tool calls to lift out.
async function* events(body, tools = [], signal) {
  const a = new Splitter(tools)
  let index = -1 // the tool call being given
  const native = new Map() // upstream index -> call and its output index
  // one piece of the split text as an event: a call, text, or a call that
  // can't be read, which ends the turn as a 502
  const piece = (f) =>
    f.call ? { tool: { index: ++index, id: "call_" + hexID(), name: f.call.name, args: f.call.args } } : f.error ? { error: { status: 502, message: f.error } } : { text: f.text }
  let usage
  let fr = ""
  let sawData = false
  let parsed = false
  let semantic = false
  for await (const line of sseLines(body, signal)) {
    if (!line.startsWith("data:")) continue
    sawData = true
    const payload = line.slice(5).trim()
    let env
    try {
      env = JSON.parse(payload)
    } catch {
      continue
    }
    const inner = typeof env?.body === "string" ? env.body : ""
    if (env?.statusCodeValue != null && env.statusCodeValue !== 200) {
      yield { error: failure(Number(env.statusCodeValue), inner || payload) }
      return
    }
    if (inner.trim() === "[DONE]") break
    let chunk
    try {
      chunk = JSON.parse(inner.trim())
    } catch {
      continue
    }
    parsed = true
    const delta = chunk?.choices?.[0]?.delta ?? {}
    const reasoning = delta.reasoning_content
    if (typeof reasoning === "string" && reasoning) {
      semantic = true
      yield { reasoning }
    }
    if (typeof delta.content === "string")
      for (const f of a.feed(delta.content)) {
        if (!f.call && !f.error && !f.text) continue
        const e = piece(f)
        if (e.text || e.tool) semantic = true
        yield e
        if (e.error) return
      }
    // tool calls served the OpenAI way keep Qoder's id: a result answers it
    for (const tc of delta.tool_calls ?? []) {
      const i = Number(tc.index ?? 0)
      const name = typeof tc.function?.name === "string" ? tc.function.name.trim() : ""
      const args = tc.function?.arguments ?? ""
      if (!tc.id && !name && !args) continue
      let call = native.get(i)
      if (!call) {
        call = { id: "", args: "" }
        native.set(i, call)
      }
      if (tc.id) call.id = tc.id
      if (call.index === undefined) {
        // An id or arguments can arrive before the name. Never emit an
        // unnamed tool: clients persist it and other providers reject it.
        call.args += args
        if (!name) continue
        for (const f of a.flush()) {
          const e = piece(f)
          yield e
          if (e.error) return
        }
        a.sawTool = true
        call.index = ++index
        semantic = true
        yield { tool: { index: call.index, id: call.id || "call_" + hexID(), name, args: call.args } }
      } else if (args) yield { args: { index: call.index, text: args } }
    }
    fr = chunk?.choices?.[0]?.finish_reason || fr
    // the usage comes in a chunk of its own after the finish, with no
    // choices, as the built-in read it (qoder.go): every request was
    // counted as 0 tokens when the finish ended the reading
    const u = chunk?.usage
    if (u) {
      usage = {
        prompt_tokens: u.prompt_tokens ?? 0,
        completion_tokens: u.completion_tokens ?? 0,
        total_tokens: (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0),
        ...(u.prompt_tokens_details?.cached_tokens ? { prompt_tokens_details: { cached_tokens: u.prompt_tokens_details.cached_tokens } } : {}),
        ...(u.completion_tokens_details?.reasoning_tokens ? { completion_tokens_details: { reasoning_tokens: u.completion_tokens_details.reasoning_tokens } } : {}),
      }
    }
  }
  for (const f of a.flush()) {
    const e = piece(f)
    if (e.text || e.tool) semantic = true
    yield e
    if (e.error) return
  }
  if ([...native.values()].some((call) => call.index === undefined)) {
    yield { error: { status: 502, message: "the model's native tool call has no name; it is not sent on as a tool" } }
    return
  }
  // Skip damaged individual lines as upstream does, but an entirely
  // unreadable/empty answer must not become a synthetic successful stop.
  if (!sawData) return
  if (!parsed || !semantic) {
    yield { error: { status: 502, message: "Qoder sent an unreadable answer" } }
    return
  }
  yield { stop: a.sawTool ? "tool_calls" : fr === "length" ? "length" : "stop", usage }
}

// answer turns Qoder's reply into the chat completion OpenAI's API gives.
// A failure before the answer keeps its status; one after it ends the
// stream with an error.
// opened is a chat reply's events and the first of them, read before
// anything is answered: a refusal in the stream (Qoder's queue among them)
// comes first.
async function opened(res, tools, signal) {
  const it = events(res.body, tools, signal)
  const first = await it.next()
  checkAbort(signal)
  return { it, first }
}

async function answer({ it, first }, chat, servedName = chat.model, signal) {
  const id = "chatcmpl-" + hexID()
  const created = Math.floor(now() / 1000)
  if (first.value?.error) return errorResponse(first.value.error)
  if (first.done) return errorResponse({ status: 502, message: "Qoder ended without an answer" })

  if (!chat.stream) {
    const msg = { role: "assistant", content: "" }
    let reasoning = ""
    const calls = []
    let stop = "stop"
    let usage
    for (let r = first; !r.done; r = await it.next()) {
      checkAbort(signal)
      const e = r.value
      if (e.error) return errorResponse(e.error)
      if (e.text) msg.content += e.text
      if (e.reasoning) reasoning += e.reasoning
      if (e.tool) calls.push({ id: e.tool.id, type: "function", function: { name: e.tool.name, arguments: e.tool.args } })
      if (e.args) calls[e.args.index].function.arguments += e.args.text
      if (e.stop) [stop, usage] = [e.stop, e.usage]
    }
    checkAbort(signal)
    if (reasoning) msg.reasoning_content = reasoning
    if (calls.length) msg.tool_calls = calls
    return Response.json({ id, object: "chat.completion", created, model: servedName, choices: [{ index: 0, message: msg, finish_reason: stop }], ...(usage ? { usage } : {}) })
  }

  const enc = new TextEncoder()
  const chunk = (delta, finish_reason = null, extra = {}) =>
    enc.encode(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: servedName, choices: [{ index: 0, delta, finish_reason }], ...extra })}\n\n`)
  let pending = first
  let began = false
  const stream = new ReadableStream({
    async pull(ctl) {
      const r = pending ?? (await it.next())
      checkAbort(signal)
      pending = null
      if (!began) {
        began = true
        ctl.enqueue(chunk({ role: "assistant", content: "" }))
      }
      if (r.done) {
        ctl.enqueue(enc.encode("data: [DONE]\n\n"))
        return ctl.close()
      }
      const e = r.value
      if (e.text) ctl.enqueue(chunk({ content: e.text }))
      else if (e.reasoning) ctl.enqueue(chunk({ reasoning_content: e.reasoning }))
      else if (e.tool) ctl.enqueue(chunk({ tool_calls: [{ index: e.tool.index, id: e.tool.id, type: "function", function: { name: e.tool.name, arguments: e.tool.args } }] }))
      else if (e.args) ctl.enqueue(chunk({ tool_calls: [{ index: e.args.index, function: { arguments: e.args.text } }] }))
      else if (e.stop) ctl.enqueue(chunk({}, e.stop, e.usage ? { usage: e.usage } : {}))
      else if (e.error) {
        ctl.enqueue(enc.encode(`data: ${JSON.stringify({ error: { message: e.error.message, code: e.error.status } })}\n\n`))
        ctl.close()
      }
    },
    cancel() {
      it.return?.()
    },
  })
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } })
}

class UsageStatus extends Error {
  constructor(status) {
    super(`qoder usage: upstream HTTP ${status}`)
    this.status = status
  }
}

// fetchUsage is the usage envelope, {displayMode, qoderUsage}; a site with
// its own usage path (QwenWork's account-context) is read by
// the usage hook's site.usagePath branch instead (parseAccountContext).
async function fetchUsage(site, deviceToken, signal) {
  if (!String(deviceToken ?? "").trim()) throw new Error("qoder usage: missing device token")
  let res
  try {
    res = await fetch(site.openapi + "/sash/api/v2/me/usage", {
      headers: { Accept: "application/json", Authorization: `Bearer ${deviceToken}`, "Cosy-ClientType": "10", "User-Agent": "Qoder" },
      signal: combine(signal, AbortSignal.timeout(20_000)),
    })
  } catch (e) {
    checkAbort(signal)
    throw new Error(`qoder usage: request failed: ${e?.message ?? e}`)
  }
  if (res.status !== 200) throw new UsageStatus(res.status)
  let env
  try {
    env = JSON.parse(await res.text())
  } catch (e) {
    checkAbort(signal)
    throw new Error(`qoder usage: decode response: ${e?.message ?? e}`)
  }
  checkAbort(signal)
  if (env?.displayMode !== "qoder" && env?.displayMode !== "enterprise") throw new Error("qoder usage: unknown display mode")
  if (env.displayMode === "qoder" && (env.qoderUsage === undefined || env.qoderUsage === null)) throw new Error("qoder usage: missing quota data")
  return env
}

// gfmt is a number as Go's %g writes it.
function gfmt(n) {
  const [m, e] = n.toExponential().split("e")
  const x = Number(e)
  if (x < -4 || x >= 6) return `${m}e${x < 0 ? "-" : "+"}${String(Math.abs(x)).padStart(2, "0")}`
  return String(n)
}

const RFC3339 = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/i

// when is a time Qoder gives: an RFC 3339 string, else seconds or
// milliseconds, as a number or its text.
function when(v) {
  if (typeof v === "string" && RFC3339.test(v) && !isNaN(Date.parse(v))) return new Date(v).toISOString()
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v.trim()) : NaN
  if (!isFinite(n) || n <= 0) return undefined
  return new Date(Math.trunc(n < 1e12 ? n * 1000 : n)).toISOString()
}

// parseUsage is the plan and each pool of credits the envelope tells.
function parseUsage(env) {
  if (env.displayMode === "enterprise") return { plan: "Enterprise" }
  const u = env.qoderUsage
  if (env.displayMode !== "qoder" || !u || typeof u !== "object" || Array.isArray(u)) return { error: "Qoder: missing quota data" }
  const field = (a, b) => (u[a] !== undefined ? u[a] : u[b])
  const out = { windows: [] }
  const plan = field("userType", "user_type")
  if (typeof plan === "string") out.plan = plan
  const until = when(field("expiresAt", "expires_at"))
  if (until) out.until = until
  const num = (v) => v === undefined || v === null || typeof v === "number"
  const str = (v) => v === undefined || v === null || typeof v === "string"
  const add = (b, name) => {
    if (b === null || typeof b !== "object" || Array.isArray(b)) return
    if (![b.total, b.cap, b.used, b.remaining].every(num) || !str(b.name) || !str(b.unit)) return
    const total = b.total ?? b.cap
    if (total == null || total <= 0 || (b.used == null && b.remaining == null)) return
    const used = b.used != null ? b.used : total - b.remaining
    if (used < 0) return
    out.windows.push({ name: b.name || name, used: Math.min(100, (100 * used) / total), display: `${gfmt(used)} / ${gfmt(total)} ${b.unit || "credits"}` })
  }
  add(field("userQuota", "user_quota"), "Credits")
  add(field("addOnQuota", "add_on_quota"), "Add-on credits")
  add(field("orgResourcePackage", "org_resource_package"), "Shared credits")
  const dedicated = field("dedicatedResourcePackages", "dedicated_resource_packages")
  for (const b of Array.isArray(dedicated) ? dedicated : []) add(b, "Dedicated credits")
  return out
}


const SITES_qoder = Object.freeze({
  id: "qoder", name: "Qoder", web: "https://qoder.com",
  openapi: "https://openapi.qoder.sh", api: "https://api3.qoder.sh",
})

// A spent refresh token can be presented again until the host has saved the
// new pair. Keep that rotation local to this credential lifetime.
let lock = Promise.resolve()
const locked = (fn) => {
  const run = lock.then(fn, fn)
  lock = run.catch(() => {})
  return run
}
const spent = new Map()
const pruneSpent = () => {
  for (const [key, value] of spent) if (now() - value.at > KEEP_SPENT_MS) spent.delete(key)
}
const latest = (cred) => {
  pruneSpent()
  for (let i = 0; i < 16 && cred?.refresh; i++) {
    const entry = spent.get(cred.refresh)
    if (!entry) break
    cred = { ...cred, ...entry.got }
  }
  return cred
}
const spend = (refresh, got) => {
  pruneSpent()
  spent.set(refresh, { got, at: now() })
  return got
}
const connectPAT = async (pat) => {
  if (typeof pat !== "string" || !pat.startsWith("pt-") || pat.length > 4096)
    throw new Error("PAT must start with pt- and be at most 4096 characters")
  const cred = await patSignIn(SITES_qoder, pat)
  checkAbort()
  return cred
}
const renew = async (cred, signal) => {
  let jt
  try {
    jt = await refreshJob(SITES_qoder, cred.refresh, cred.accountId || cred.email || cred.uid, signal)
    checkAbort(signal)
  } catch (e) {
    checkAbort(signal)
    if (!(e instanceof SignInGone) || !cred.pat) throw e
    let exchanged
    try {
      exchanged = await patSignIn(SITES_qoder, cred.pat, signal)
      checkAbort(signal)
    } catch (p) {
      checkAbort(signal)
      if (!p?.status) throw p
      throw new SignInGone("Qoder refused the PAT — sign in again with a new one", true)
    }
    return spend(cred.refresh, { access: exchanged.access, refresh: exchanged.refresh, expires: exchanged.expires })
  }
  return spend(cred.refresh, { access: jt.token, refresh: jt.refresh_token, expires: expiresAt(jt) })
}
const refresh = (cred) => locked(async () => {
  checkAbort()
  const current = latest(cred)
  // Returning a rotation already in memory prevents concurrent callers from
  // spending either the old token or its newly issued replacement twice.
  if (current !== cred && current.expires - now() > REFRESH_LEAD) return current
  const next = { ...current, ...(await renew(current)) }
  checkAbort()
  return next
})
// A caller can stop awaiting a rotation; the rotation itself must still
// commit its spent token and notify the host under the factory lifetime.
const abortable = (work, signal) => {
  checkAbort(signal)
  if (!signal) return work
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason ?? new DOMException("aborted", "AbortError"))
    signal.addEventListener("abort", stop, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop))
  })
}
const fresh = (cred, signal) => abortable(locked(async () => {
  checkAbort(signal)
  if (!cred?.access || !cred.uid) throw new SignInGone("Qoder: not signed in")
  const current = latest(cred)
  if (current.expires - now() >= REFRESH_LEAD) return current
  const next = { ...current, ...(await renew(current)) }
  // The host owns persistence. Notification does not hold up the request or
  // turn a successful rotation into a failed request if persistence rejects.
  try { Promise.resolve(options.onRefresh?.(next)).catch(() => {}) } catch {}
  return next
}), signal)

const listings = new Map()
const modelsFor = async (cred, again = false, signal) => {
  let listing = listings.get(cred.uid)
  if (!listing || again) {
    listing = modelInfos(await fetchListing(SITES_qoder, cred, signal), SITES_qoder)
    checkAbort(signal)
    listings.set(cred.uid, listing)
  }
  return listing
}
const models = async (cred, again = false) => {
  const current = await fresh(cred)
  checkAbort()
  return modelsFor(current, again)
}
const usage = async (cred) => {
  const current = await fresh(cred)
  checkAbort()
  const env = await fetchUsage(SITES_qoder, current.access)
  checkAbort()
  // parseUsage intentionally preserves an enterprise payload without credit
  // windows; normalize the public surface so callers always get an array
  // while retaining the plan marker when present.
  return { windows: [], ...parseUsage(env), signIn: "kept" }
}
const signedInError = (e) => errorResponse({
  status: e instanceof SignInGone || e?.expired ? 401 : 502,
  message: String(e?.message ?? e).replace(/^Qoder: /, ""),
  signIn: e?.expired ? "expired" : undefined,
})

const chat = async (credential, chatBody, { session = "", signal: requestSignal } = {}) => {
  const signal = combine(requestSignal)
  checkAbort(signal)
  try {
    const cred = await fresh(credential, signal)
    checkAbort(signal)
    const m = (await modelsFor(cred, false, signal)).find((x) => x.key === chatBody.model)
      ?? (await modelsFor(cred, true, signal)).find((x) => x.key === chatBody.model)
    checkAbort(signal)
    if (!m) return errorResponse({ status: 400, message: `unknown or disabled model "${chatBody.model}"` })
    const name = m.name?.trim()
    const servedName = name && name !== m.key ? name : chatBody.model
    const api = SITES_qoder.api
    const url = api + CHAT_PATH
    const task = taskOf(sessionOf(chatBody, session), chatBody)
    const body = qoderBody(chatBody, m, session, task, SITES_qoder)
    const deadline = QUEUE.now() + QUEUE.budget
    const ask = { requestSetId: body.request_set_id, requestId: body.request_id, sessionId: body.session_id, modelKey: m.key }
    for (let waited = 0; ; waited++) {
      checkAbort(signal)
      if (waited) {
        body.request_id = body.chat_record_id = randomUUID()
        ask.requestId = body.request_id
      }
      const wire = encodeBody(JSON.stringify(body))
      const headers = {
        ...cosyHeaders(url, cred, wire, SITES_qoder),
        Accept: "text/event-stream", "Cache-Control": "no-cache",
        "X-Model-Key": m.key, "X-Model-Source": m.source,
      }
      const call = new AbortController()
      const res = await fetch(url, { method: "POST", headers, body: wire, signal: combine(signal, call.signal) })
      checkAbort(signal)
      let open, f
      if (res.ok) {
        open = await opened(res, chatBody.tool_choice !== "none" ? (chatBody.tools ?? []).filter((t) => t?.type === "function") : [], signal)
        checkAbort(signal)
        f = open.first.value?.error
      } else {
        f = failure(res.status, (await res.text()).slice(0, 1 << 20))
        checkAbort(signal)
      }
      if (f) {
        call.abort()
        // Mock transports may not attach the signal to their response body.
        // Explicitly close the refused iterator/body before polling the queue.
        try {
          if (open) await open.it.return?.()
          else if (!res.bodyUsed) await res.body?.cancel()
        } catch (e) {
          // Cancelling the refused call can make iterator cleanup reject
          // with this exact reason. It must not replace the refusal.
          if (e !== call.signal.reason) throw e
        }
        checkAbort(signal)
      } else task.answered = true
      if (!f?.queue || waited >= QUEUE.recoveries) {
        const result = f ? errorResponse(f) : await answer(open, chatBody, servedName, signal)
        checkAbort(signal)
        return result
      }
      if (!(await queueWait(api, cred, ask, f.queue, signal, deadline, SITES_qoder))) {
        checkAbort(signal)
        return errorResponse(f)
      }
      checkAbort(signal)
    }
  } catch (e) {
    checkAbort(signal)
    return signedInError(e)
  }
}

return {
  connectPAT, refresh, models, chat, usage,
  dispose() { listings.clear(); spent.clear(); TASKS.clear() },
  _internal: { cosyHeaders, userBlob, machineOS, encodeBody, decodeBody, segmentEncode, swapThirds,
    qoderBody, qoderMessages, cacheMarked, sessionOf, taskOf, failure, errorResponse,
    parseUsage, modelInfo, typedUnions, events, QUEUE, SITES_qoder },
}
}
