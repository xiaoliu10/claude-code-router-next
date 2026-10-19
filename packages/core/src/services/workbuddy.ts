/** WorkBuddy CN protocol. Source: magpie-community/plugins@ab38da681af7716ea9a7609f045ca91d2ad9988a
 * packages/workbuddy/index.mjs (MIT); see ../../THIRD_PARTY_NOTICES.md.
 * No refresh, browser login, prompt rewriting, static model fallback or source-file writes.
 */
import { createHash, randomBytes } from "node:crypto";
import { closeSync, fstatSync, openSync, readFileSync, constants } from "node:fs";
import fs from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { HOME_DIR } from "@wengine-ai/claude-code-router-shared";

export const WORKBUDDY_PROVIDER_NAME = "workbuddy";
export const WORKBUDDY_CHAT_ORIGIN = "https://copilot.tencent.com";
export const WORKBUDDY_CHAT_URL = `${WORKBUDDY_CHAT_ORIGIN}/v2/chat/completions`;
export const WORKBUDDY_CONFIG_URL = `${WORKBUDDY_CHAT_ORIGIN}/v3/config`;
export const WORKBUDDY_API_KEY = "ccr-managed-workbuddy";
export const WORKBUDDY_CHAT_UA = "WorkBuddy/5.5.6";
export const WORKBUDDY_CONFIG_UA = "CLI/2.0.0 WorkBuddy/5.5.6";
const MAX_SOURCE_BYTES = 1024 * 1024;
const DOMAINS = new Set(["copilot.tencent.com", "www.codebuddy.cn"]);
const SALT = randomBytes(16).toString("hex");
export type WorkBuddyStatus = "not_connected" | "connected" | "expired" | "sealed" | "source_missing" | "source_changed" | "error";
export interface WorkBuddyCredential {
  version: 1; kind: "workbuddy"; uid: string; displayName: string; domain: string;
  enterpriseId: string; accessToken: string; expiresAt: number; importedAt: string; source: "desktop";
  lastSyncAt?: string;
}
export type WorkBuddySourceResult = { ok: true; credential: WorkBuddyCredential } |
  { ok: false; reason: "sealed" | "source_missing" | "source_invalid" };
export const isManagedWorkBuddy = (p: any): boolean => p?.name === WORKBUDDY_PROVIDER_NAME && p?.ccr_managed === true;
/**
 * Runtime (data-plane) detection. The managed flag is carried from the config
 * provider into the registered LLMProvider (ProviderService spreads the
 * request), and the marker api_key is the second signal: a managed provider is
 * always the one CCR registered, never a user-supplied "workbuddy" name with a
 * real key. A generic config save cannot create this combination by accident,
 * because protectWorkBuddyConfig re-locks the managed entry's fields.
 */
export const isWorkBuddyRuntime = (p: any): boolean =>
  p?.name === WORKBUDDY_PROVIDER_NAME &&
  (p?.workbuddyManaged === true || p?.apiKey === WORKBUDDY_API_KEY);
export function lockWorkBuddyProvider(p: any): any {
  return { ...p, name: WORKBUDDY_PROVIDER_NAME, ccr_managed: true, workbuddy_kind: "workbuddy",
    workbuddyManaged: true,
    api_base_url: WORKBUDDY_CHAT_URL, api_key: WORKBUDDY_API_KEY, transformer: { use: ["workbuddy"] } };
}
export function protectWorkBuddyConfig(config: any, previous?: any): void {
  for (const key of ["Providers", "providers"]) {
    if (!Array.isArray(config?.[key])) continue;
    config[key] = config[key].map((p: any) => {
      const old = (previous?.Providers || previous?.providers || []).find(isManagedWorkBuddy);
      if (isManagedWorkBuddy(p) || (old && p?.name === WORKBUDDY_PROVIDER_NAME)) return lockWorkBuddyProvider(p);
      return p;
    });
  }
}
function headerValue(value: unknown, max = 253, required = false): value is string {
  return typeof value === "string" && value.length <= max && (!required || value.length > 0) && !/[\x00-\x1f\x7f]/.test(value);
}
export function validDomain(value: unknown): string {
  if (value === undefined || value === "") return "copilot.tencent.com";
  if (!headerValue(value) || !DOMAINS.has(value)) throw new Error("workbuddy_source_invalid");
  return value;
}
export function workBuddyDesktopPath(platform = process.platform, home = homedir()): string {
  const base = platform === "darwin" ? join(home, "Library", "Application Support", "CodeBuddyExtension")
    : platform === "win32" ? join(home, "AppData", "Local", "CodeBuddyExtension")
    : join(home, ".local", "share", "CodeBuddyExtension");
  return join(base, "Data", "Public", "auth", "workbuddy-desktop.info");
}
export function parseWorkBuddySource(text: string, now = Date.now()): WorkBuddySourceResult {
  try {
    if (Buffer.byteLength(text) > MAX_SOURCE_BYTES) return { ok: false, reason: "source_invalid" };
    const data = JSON.parse(text), a = data?.auth, account = data?.account;
    if (a?.accessToken?.$wbEncrypted === 1 || a?.refreshToken?.$wbEncrypted === 1) return { ok: false, reason: "sealed" };
    if (!headerValue(a?.accessToken, MAX_SOURCE_BYTES, true) || !headerValue(account?.uid, 253, true) ||
      (account.enterpriseId !== undefined && !headerValue(account.enterpriseId))) return { ok: false, reason: "source_invalid" };
    if ([account.nickname, account.phoneNumber].some(v => v !== undefined && !headerValue(v, 253))) return { ok: false, reason: "source_invalid" };
    const domain = validDomain(a.domain);
    const expiresAt = Number.isFinite(a.expiresAt) && a.expiresAt > 0 ? a.expiresAt :
      Number.isFinite(a.expiresIn) && a.expiresIn > 0 && Number.isFinite(now + a.expiresIn * 1000) ? now + a.expiresIn * 1000 : 0;
    const name = [account.nickname, account.phoneNumber, account.uid].find(v => headerValue(v, 253, true)) || "";
    return { ok: true, credential: { version: 1, kind: "workbuddy", uid: account.uid,
      displayName: name, domain, enterpriseId: account.enterpriseId || "", accessToken: a.accessToken,
      expiresAt, importedAt: new Date(now).toISOString(), source: "desktop" } };
  } catch { return { ok: false, reason: "source_invalid" }; }
}
/** Only called by explicit import; bounded read, no symlinks, never writes the source. */
export function readWorkBuddySource(): WorkBuddySourceResult {
  let fd: number | undefined;
  try {
    fd = openSync(workBuddyDesktopPath(), constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) return { ok: false, reason: "source_invalid" };
    return parseWorkBuddySource(readFileSync(fd, "utf8"));
  } catch (e: any) { return { ok: false, reason: e?.code === "ENOENT" ? "source_missing" : "source_invalid" }; }
  finally { if (fd !== undefined) closeSync(fd); }
}
/** Atomic 0600 CCR-only copy. Test path injection is internal, never accepted by an HTTP API. */
export class WorkBuddyCredentialStore {
  constructor(readonly path = join(HOME_DIR, "workbuddy-credentials.json")) {}
  async load(): Promise<WorkBuddyCredential | null> {
    let file: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      file = await fs.open(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES || (process.platform !== "win32" && (stat.mode & 0o077))) throw new Error();
      const c = JSON.parse(await file.readFile("utf8"));
      const parsed = parseWorkBuddySource(JSON.stringify({ account: { uid: c.uid, nickname: c.displayName, enterpriseId: c.enterpriseId }, auth: c }));
      if (c.version !== 1 || c.kind !== "workbuddy" || !parsed.ok) throw new Error();
      return { ...parsed.credential, importedAt: typeof c.importedAt === "string" ? c.importedAt : "", lastSyncAt: typeof c.lastSyncAt === "string" ? c.lastSyncAt : undefined };
    } catch (e: any) {
      if (e?.code === "ENOENT") return null;
      throw new Error("WorkBuddy 私有登录态不可读，请重新导入");
    } finally { await file?.close(); }
  }
  async save(c: WorkBuddyCredential): Promise<void> {
    await fs.mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${randomBytes(12).toString("hex")}.tmp`;
    try {
      const file = await fs.open(temp, "wx", 0o600);
      try { await file.writeFile(JSON.stringify(c)); await file.sync(); } finally { await file.close(); }
      await fs.rename(temp, this.path);
    } catch { throw new Error("WorkBuddy 私有登录态保存失败"); }
    finally { await fs.unlink(temp).catch(() => {}); }
  }
  async delete(): Promise<boolean> {
    try { await fs.unlink(this.path); return true; }
    catch (e: any) { if (e?.code === "ENOENT") return false; throw new Error("WorkBuddy 私有登录态删除失败"); }
  }
}
export const workBuddyCredentialStore = new WorkBuddyCredentialStore();
export function credentialHeaders(c: WorkBuddyCredential, ua = WORKBUDDY_CHAT_UA): Record<string, string> {
  if (!headerValue(c.accessToken, MAX_SOURCE_BYTES, true) || !headerValue(c.uid, 253, true) || !headerValue(c.enterpriseId)) throw new Error("WorkBuddy 登录态无效，请重新导入");
  const headers: Record<string, string> = { Authorization: `Bearer ${c.accessToken}`, "X-User-Id": c.uid,
    "X-Domain": validDomain(c.domain), "X-Product": "SaaS", "X-IDE-Type": "WorkBuddy", "User-Agent": ua,
    "X-Requested-With": "XMLHttpRequest", "X-Agent-Intent": "craft", "X-Agent-Purpose": "conversation",
    "X-IDE-Name": "WorkBuddy", "X-IDE-Version": "5.5.6", "Content-Type": "application/json" };
  if (c.enterpriseId) { headers["X-Enterprise-Id"] = c.enterpriseId; headers["X-Tenant-Id"] = c.enterpriseId; }
  return headers;
}
function signature(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(p => !p || ["tool_result", "tool-result"].includes(p.type) ? "" :
    !p.type || p.type === "text" ? (typeof p.text === "string" ? p.text : "") :
    `[${p.type}:${createHash("sha256").update(JSON.stringify(p)).digest("hex").slice(0, 8)}]`).join("");
}
export function conversationHeaders(body: any, session?: string): Record<string, string> {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const first = messages.find((m: any) => m?.role === "user" && signature(m.content));
  const conv = session ? `session:${session.slice(0, 128)}` : first ? `first:${signature(first.content)}` : "";
  let turn = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const prev = messages[i - 1];
    if (messages[i]?.role !== "user" || prev?.role === "tool" || (prev?.role === "assistant" && prev?.tool_calls?.length)) continue;
    const sig = signature(messages[i].content); turn = sig ? `u${i}:${sig}` : ""; break;
  }
  const id = (kind: string, key: string) => createHash("sha256").update(`${SALT}|${kind}|${key}`).digest("hex").slice(0, 32);
  const msg = randomBytes(16).toString("hex");
  return { "X-Conversation-Message-ID": msg, "X-Request-ID": msg,
    ...(conv ? { "X-Conversation-ID": id("conversation", conv) } : {}),
    ...(conv && turn ? { "X-Conversation-Request-ID": id("turn", `${conv}|${turn}`) } : {}) };
}
export interface WorkBuddyModel { id: string; name: string; context?: number; output?: number; images?: boolean; efforts?: string[] }
export function parseWorkBuddyModels(env: any): WorkBuddyModel[] {
  if (!env || (env.code !== undefined && Number(env.code) !== 0)) throw classifyWorkBuddyError(200, env);
  const cfg = env.data, out: WorkBuddyModel[] = [], seen = new Set<string>(), names = new Map<string, string>();
  for (const agent of Array.isArray(cfg?.agents) ? cfg.agents : []) {
    if (agent?.name !== "cli") continue;
    for (const id of Array.isArray(agent.models) ? agent.models : []) {
      if (typeof id !== "string" || !id || id.length > 256 || /[\x00-\x1f\x7f,]/.test(id) || seen.has(id)) continue;
      seen.add(id);
      const d = (Array.isArray(cfg.models) ? cfg.models : []).find((x: any) => x?.id === id);
      const m: WorkBuddyModel = { id, name: typeof d?.name === "string" ? d.name : id };
      if (d) {
        if (Number.isFinite(d.maxInputTokens)) m.context = d.maxInputTokens;
        if (Number.isFinite(d.maxOutputTokens)) m.output = d.maxOutputTokens;
        m.images = d.supportsImages === true;
        const efforts = Array.isArray(d.reasoning?.supportedEfforts) ? d.reasoning.supportedEfforts.filter((e: any) => typeof e === "string") : [];
        if (efforts.length) m.efforts = [...new Set<string>([...(!d.onlyReasoning && d.reasoning?.canDisableThinking !== false ? ["none"] : []), ...efforts])];
      }
      const first = names.get(m.name);
      if (first) m.name += ` (${id.startsWith(first + "-") ? id.slice(first.length + 1).toUpperCase() : id})`;
      else names.set(m.name, id);
      out.push(m);
    }
  }
  if (!out.length) throw new Error("WorkBuddy 模型发现失败：未返回 cli 模型；保留原列表");
  return out;
}
/** Never copy raw upstream strings, request objects, causes or secret-bearing bodies into errors. */
export function classifyWorkBuddyError(status: number, body?: any): Error & { code: string; statusCode: number; nonRetryable: boolean; workbuddy: true; cooldownSeconds?: number; accountRestricted?: boolean; upstreamCode?: number } {
  let data: any = body;
  if (typeof body === "string") { try { data = JSON.parse(body); } catch { data = {}; } }
  const at = data?.error && typeof data.error === "object" ? data.error : data;
  const rawCode = at?.data?.code ?? at?.code ?? data?.code ?? data?.data?.code;
  const n = Number(rawCode), code = Number.isSafeInteger(n) && n > 0 ? n : undefined;
  const text = typeof body === "string" ? body : JSON.stringify(body ?? {});
  let kind = "provider_response_error", hint = `WorkBuddy 上游请求失败（HTTP ${status}${code ? `，code ${code}` : ""}）`;
  let cooldownSeconds: number | undefined, accountRestricted = false;
  if (code === 10085) { kind = "workbuddy_protocol_error"; hint = "WorkBuddy 协议版本不匹配（10085），请更新 CCR"; }
  else if (code === 11140 || /account has been restricted due to unusual activity|账号存在异常行为/i.test(text)) {
    kind = "workbuddy_account_restricted"; hint = "WorkBuddy 账号受限（11140），请在 WorkBuddy 内 Submit feedback 申诉"; cooldownSeconds = 7200; accountRestricted = true;
  } else if (code === 6004 || status === 429 || /频率限制|rate.?limit/i.test(text)) {
    kind = "rate_limit"; hint = "WorkBuddy 此模型频率限制，请等待重置（6004）"; cooldownSeconds = 900;
    const reset = /(?:将在|重置[于时间：:]*)\s*(\d{4}-\d\d-\d\d[ T]\d\d:\d\d(?::\d\d)?(?:Z|[+-]\d\d:\d\d)?)/.exec(text)?.[1];
    if (reset) { const ms = Date.parse(/[Zz]|[+-]\d\d:\d\d$/.test(reset) ? reset : reset.replace(" ", "T") + "+08:00"); if (ms > Date.now()) cooldownSeconds = Math.ceil((ms - Date.now()) / 1000); }
  } else if (code === 14018 || /credits exhausted/i.test(text)) { kind = "insufficient_quota"; hint = "WorkBuddy 套餐额度不足（14018），零费率模型也需要有效套餐"; cooldownSeconds = 900; }
  else if (/unapproved channel|illegal api invocation/i.test(text)) { kind = "permission_error"; hint = "WorkBuddy 拒绝 Claude Code/Codex 类客户端会话；请换其他客户端或 provider"; }
  else if ([11150, 11153, 11133].includes(code!)) { kind = "invalid_request_error"; hint = `WorkBuddy 模型请求参数不兼容（${code}），请检查 reasoning effort、消息或工具 schema`; }
  return Object.assign(new Error(hint), { code: kind, statusCode: status >= 400 && status < 600 ? status : 400,
    nonRetryable: true, workbuddy: true as const, cooldownSeconds, accountRestricted, upstreamCode: code });
}
export function sanitizeWorkBuddyError(_error: unknown): string { return "WorkBuddy 操作失败；请检查本机登录状态后重新导入"; }

/**
 * Runtime handle for the shared WorkBuddy auth service. There is exactly one
 * CCR runtime per process; the Server registers the service here so the
 * transformer (instantiated by ProviderService without options) can resolve it.
 * Tests replace it with an isolated service.
 */
let workBuddyRuntime: { authService: any } | null = null;
export function setWorkBuddyRuntime(runtime: { authService: any } | null): void {
  workBuddyRuntime = runtime;
}
export function getWorkBuddyAuthService(): any {
  return workBuddyRuntime?.authService;
}
