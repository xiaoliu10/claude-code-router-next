/** WorkBuddy protocol (CN + international). Source: magpie-community/plugins@ab38da681af7716ea9a7609f045ca91d2ad9988a
 * packages/workbuddy/index.mjs (MIT); see ../../THIRD_PARTY_NOTICES.md.
 * No browser login, no prompt rewriting, no static model fallback, no source-file writes.
 * No daily check-in/reward task: free credits are server-side daily packages (D11).
 * Browser authorization (§15) does not require a desktop installation.
 */
import { createHash, randomBytes } from "node:crypto";
import { closeSync, fstatSync, openSync, readFileSync, constants } from "node:fs";
import fs from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { HOME_DIR } from "@wengine-ai/claude-code-router-shared";

/** Injected transport contract; implementations must enforce direct fixed-origin requests. */
export type WorkBuddyFetch = (url: string, init?: RequestInit) => Promise<Response>;

export const WORKBUDDY_PROVIDER_NAME = "workbuddy";
export const WORKBUDDY_AI_PROVIDER_NAME = "workbuddy-ai";
export const WORKBUDDY_API_KEY = "ccr-managed-workbuddy";
export const WORKBUDDY_AI_API_KEY = "ccr-managed-workbuddy-ai";
export const WORKBUDDY_PROVIDER_NAMES = [WORKBUDDY_PROVIDER_NAME, WORKBUDDY_AI_PROVIDER_NAME] as const;

/** Per-site managed provider identity (contract §16). */
export function managedProvider(site: WorkBuddySiteId | WorkBuddySite): { name: string; apiKey: string } {
  const id = typeof site === "string" ? site : site.id;
  return id === "workbuddy-ai"
    ? { name: WORKBUDDY_AI_PROVIDER_NAME, apiKey: WORKBUDDY_AI_API_KEY }
    : { name: WORKBUDDY_PROVIDER_NAME, apiKey: WORKBUDDY_API_KEY };
}

/** Derive the site from a managed provider's name, marker key or fixed base URL. */
export function workBuddySiteFromProvider(provider: any): WorkBuddySiteId {
  const name = typeof provider?.name === "string" ? provider.name : "";
  const key = typeof provider?.apiKey === "string" ? provider.apiKey
    : typeof provider?.api_key === "string" ? provider.api_key : "";
  const base = typeof provider?.baseUrl === "string" ? provider.baseUrl
    : typeof provider?.api_base_url === "string" ? provider.api_base_url : "";
  if (name === WORKBUDDY_AI_PROVIDER_NAME || key === WORKBUDDY_AI_API_KEY || /(^|\/\/)www\.workbuddy\.ai|www\.codebuddy\.ai/.test(base)) return "workbuddy-ai";
  return "workbuddy";
}
export const WORKBUDDY_UA_VERSION = "5.5.6";
export const WORKBUDDY_CHAT_UA = `WorkBuddy/${WORKBUDDY_UA_VERSION}`;
export const WORKBUDDY_CONFIG_UA = `CLI/2.0.0 WorkBuddy/${WORKBUDDY_UA_VERSION}`;
/** Refresh this long before the access token ends (magpie's LEAD_MS, P:L21). */
export const WORKBUDDY_REFRESH_LEAD_MS = 5 * 60 * 1000;
const MAX_SOURCE_BYTES = 1024 * 1024;
const SALT = randomBytes(16).toString("hex");

/**
 * The two WorkBuddy builds (magpie SITES, P:L62-84). Since contract §16 both
 * sites may be connected at once, each with its own account pool.
 */
export type WorkBuddySiteId = "workbuddy" | "workbuddy-ai";
export interface WorkBuddySite {
  id: WorkBuddySiteId;
  /** Desktop login file base name (without .info) — magpie's SITES.authID. */
  authId: string;
  origin: string;
  /** Hosts accepted in the X-Domain header (never used as a URL). */
  domains: readonly string[];
  /** magpie's SITES.noImages: models whose images the server drops anyway. */
  noImages?: RegExp;
}
export const WORKBUDDY_SITES: Record<WorkBuddySiteId, WorkBuddySite> = {
  workbuddy: {
    id: "workbuddy", authId: "workbuddy-desktop",
    origin: "https://copilot.tencent.com",
    domains: ["copilot.tencent.com", "www.codebuddy.cn"],
  },
  "workbuddy-ai": {
    id: "workbuddy-ai", authId: "workbuddy-desktop-ai",
    origin: "https://www.workbuddy.ai",
    domains: ["www.workbuddy.ai", "www.codebuddy.ai"],
    // International GLM models report supportsImages:true but the server strips images (P:L86-101).
    noImages: /^glm-/,
  },
};
export function workBuddySite(id: WorkBuddySiteId): WorkBuddySite {
  if (id !== "workbuddy" && id !== "workbuddy-ai") throw new Error("workbuddy_source_invalid");
  return WORKBUDDY_SITES[id];
}
export const workBuddyChatUrl = (site: WorkBuddySite): string => `${site.origin}/v2/chat/completions`;
export const workBuddyConfigUrl = (site: WorkBuddySite): string => `${site.origin}/v3/config`;
// CN defaults: the constants other modules already import keep their meaning.
export const WORKBUDDY_CHAT_ORIGIN = WORKBUDDY_SITES.workbuddy.origin;
export const WORKBUDDY_CHAT_URL = workBuddyChatUrl(WORKBUDDY_SITES.workbuddy);
export const WORKBUDDY_CONFIG_URL = workBuddyConfigUrl(WORKBUDDY_SITES.workbuddy);

export type WorkBuddyStatus = "not_connected" | "connected" | "expired" | "sealed" | "source_missing" | "source_changed" | "error";
/** Where the credential came from: the desktop login file or a browser sign-in. */
export type WorkBuddyCredentialSource = "desktop" | "browser";
export type WorkBuddyCooldownScope = "account" | "model";
/** Account-scoped cooldown slot (quota/restriction classes). */
export interface WorkBuddyCooldown {
  until: number;
  scope: WorkBuddyCooldownScope;
  model?: string;
  code: number;
}
/** Per-model cooldown slot; an account may hold MANY simultaneously (§16 review). */
export interface WorkBuddyModelCooldown { until: number; code: number }
/** One account in a site pool (contract §16 v2). */
export interface WorkBuddyAccount {
  uid: string;
  displayName: string;
  enterpriseId: string;
  domain: string;
  source: WorkBuddyCredentialSource;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  refreshExpiresAt?: number;
  importedAt: string;
  /** Non-secret token type only. */
  tokenType?: string;
  /** Account-scoped cooldown (quota/restriction). Still-valid state survives re-login. */
  cooldown?: WorkBuddyCooldown;
  /** Additive per-model rate-limit cooldowns (6004/429): one slot PER MODEL. */
  modelCooldowns?: Record<string, WorkBuddyModelCooldown>;
}
export interface WorkBuddySiteState {
  hiddenModels: string[];
  activeUid: string | null;
  accounts: WorkBuddyAccount[];
  /** Cumulative union of discovered model ids; hidden ones are filtered before registration. */
  discoveredModels?: string[];
  lastSyncAt?: string;
  lastError?: string | null;
}
export interface WorkBuddyCredentialData {
  version: 2;
  sites: Partial<Record<WorkBuddySiteId, WorkBuddySiteState>>;
}
/**
 * A single resolved credential (one pool account tagged with its site). This is
 * the v1-era shape still consumed by the protocol helpers and the data plane.
 */
export interface WorkBuddyCredential extends WorkBuddyAccount {
  version: 1;
  kind: WorkBuddySiteId;
  lastSyncAt?: string;
}
export type WorkBuddySourceResult = { ok: true; credential: WorkBuddyCredential } |
  { ok: false; reason: "sealed" | "source_missing" | "source_invalid"; /** Which site's file was examined (for a precise message). */ site?: WorkBuddySiteId };
export const isManagedWorkBuddy = (p: any): boolean =>
  (WORKBUDDY_PROVIDER_NAMES as readonly string[]).includes(p?.name) && p?.ccr_managed === true;
/**
 * Runtime (data-plane) detection. The managed flag is carried from the config
 * provider into the registered LLMProvider (ProviderService spreads the
 * request), and the marker api_key is the second signal: a managed provider is
 * always the one CCR registered, never a user-supplied "workbuddy" name with a
 * real key. A generic config save cannot create this combination by accident,
 * because protectWorkBuddyConfig re-locks the managed entry's fields.
 */
export const isWorkBuddyRuntime = (p: any): boolean => {
  if (p?.workbuddyManaged === true && (WORKBUDDY_PROVIDER_NAMES as readonly string[]).includes(p?.name)) return true;
  return (WORKBUDDY_PROVIDER_NAMES as readonly string[]).includes(p?.name) &&
    (p?.apiKey === WORKBUDDY_API_KEY || p?.apiKey === WORKBUDDY_AI_API_KEY ||
     p?.api_key === WORKBUDDY_API_KEY || p?.api_key === WORKBUDDY_AI_API_KEY);
};
export function lockWorkBuddyProvider(p: any, siteId?: WorkBuddySiteId): any {
  const site = workBuddySite(siteId ?? (p?.workbuddy_kind === "workbuddy-ai" ? "workbuddy-ai" : "workbuddy"));
  const id = managedProvider(site);
  return { ...p, name: id.name, ccr_managed: true, workbuddy_kind: site.id,
    workbuddyManaged: true,
    api_base_url: workBuddyChatUrl(site), api_key: id.apiKey, transformer: { use: ["workbuddy"] } };
}
export function protectWorkBuddyConfig(config: any, previous?: any): void {
  for (const key of ["Providers", "providers"]) {
    if (!Array.isArray(config?.[key])) continue;
    const olds = (previous?.Providers || previous?.providers || []).filter((p: any) => isManagedWorkBuddy(p));
    config[key] = config[key].map((p: any) => {
      const old = olds.find((o: any) => o.workbuddy_kind === (p?.workbuddy_kind ?? (p?.name === WORKBUDDY_AI_PROVIDER_NAME ? "workbuddy-ai" : "workbuddy"))) ||
        olds.find((o: any) => o?.name === p?.name);
      if (isManagedWorkBuddy(p) || (old && (WORKBUDDY_PROVIDER_NAMES as readonly string[]).includes(p?.name))) {
        // Site derivation must survive a missing workbuddy_kind, otherwise a
        // generic save would re-lock the INTERNATIONAL entry onto the CN
        // origin/name (contract §16: protections cover both sites).
        const siteId = old?.workbuddy_kind ?? p?.workbuddy_kind ?? workBuddySiteFromProvider(p);
        return lockWorkBuddyProvider({ ...p, workbuddy_kind: siteId }, siteId);
      }
      return p;
    });
    // A generic full-config save must not delete a managed provider by omission;
    // removal is an explicit WorkBuddy disconnect (contract §13/§16).
    for (const old of olds) {
      if (!config[key].some((p: any) => p?.name === old.name)) {
        const siteId = old?.workbuddy_kind ?? workBuddySiteFromProvider(old);
        config[key].push(lockWorkBuddyProvider({ ...old, workbuddy_kind: siteId }, siteId));
      }
    }
  }
}
function headerValue(value: unknown, max = 253, required = false): value is string {
  return typeof value === "string" && value.length <= max && (!required || value.length > 0) && !/[\x00-\x1f\x7f]/.test(value);
}
export function validDomain(value: unknown, site: WorkBuddySite = WORKBUDDY_SITES.workbuddy): string {
  if (value === undefined || value === "") return site.origin ? new URL(site.origin).host : "";
  if (!headerValue(value) || !site.domains.includes(value)) throw new Error("workbuddy_source_invalid");
  return value;
}
export function workBuddyDesktopPath(site: WorkBuddySite, platform = process.platform, home = homedir()): string {
  const base = platform === "darwin" ? join(home, "Library", "Application Support", "CodeBuddyExtension")
    : platform === "win32" ? join(home, "AppData", "Local", "CodeBuddyExtension")
    : join(home, ".local", "share", "CodeBuddyExtension");
  return join(base, "Data", "Public", "auth", `${site.authId}.info`);
}
export function parseWorkBuddySource(text: string, now = Date.now(), siteId: WorkBuddySiteId = "workbuddy"): WorkBuddySourceResult {
  const site = workBuddySite(siteId);
  try {
    if (Buffer.byteLength(text) > MAX_SOURCE_BYTES) return { ok: false, reason: "source_invalid", site: site.id };
    const data = JSON.parse(text), a = data?.auth, account = data?.account;
    // Truthiness, not === 1: the marker's value is unspecified and other truthy values
    // must still read as "encrypted" rather than "unparseable" (magpie P:L1075).
    if (a?.accessToken?.$wbEncrypted || a?.refreshToken?.$wbEncrypted) return { ok: false, reason: "sealed", site: site.id };
    if (!headerValue(a?.accessToken, MAX_SOURCE_BYTES, true) || !headerValue(account?.uid, 253, true) ||
      (account.enterpriseId !== undefined && !headerValue(account.enterpriseId))) return { ok: false, reason: "source_invalid", site: site.id };
    if ([account.nickname, account.phoneNumber].some(v => v !== undefined && !headerValue(v, 253))) return { ok: false, reason: "source_invalid", site: site.id };
    // Never copy or spend the desktop app's refresh token.
    const tokenType = typeof a?.tokenType === "string" && headerValue(a.tokenType, 64) ? a.tokenType : "";
    const domain = validDomain(a.domain, site);
    const expiresAt = Number.isFinite(a.expiresAt) && a.expiresAt > 0 ? a.expiresAt :
      Number.isFinite(a.expiresIn) && a.expiresIn > 0 && Number.isFinite(now + a.expiresIn * 1000) ? now + a.expiresIn * 1000 : 0;
    const name = [account.nickname, account.phoneNumber, account.uid].find(v => headerValue(v, 253, true)) || "";
    return { ok: true, credential: { version: 1, kind: site.id, uid: account.uid,
      displayName: name, domain, enterpriseId: account.enterpriseId || "", accessToken: a.accessToken,
      tokenType,
      expiresAt, importedAt: new Date(now).toISOString(), source: "desktop" } };
  } catch { return { ok: false, reason: "source_invalid", site: site.id }; }
}
/** Only called by explicit import; bounded read, no symlinks, never writes the source. */
export function readWorkBuddySource(siteId: WorkBuddySiteId = "workbuddy"): WorkBuddySourceResult {
  let fd: number | undefined;
  try {
    fd = openSync(workBuddyDesktopPath(workBuddySite(siteId)), constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) return { ok: false, reason: "source_invalid", site: siteId };
    return parseWorkBuddySource(readFileSync(fd, "utf8"), Date.now(), siteId);
  } catch (error: any) {
    return { ok: false, reason: error?.code === "ENOENT" ? "source_missing" : "source_invalid", site: siteId };
  } finally { if (fd !== undefined) closeSync(fd); }
}
const MODEL_ID_OK = /^[^\x00-\x1f\x7f,]{1,256}$/;
function modelIdOk(value: unknown): value is string {
  return typeof value === "string" && MODEL_ID_OK.test(value) && !value.includes(",");
}
function normalizeAccount(c: any, siteId: WorkBuddySiteId, now = Date.now()): WorkBuddyAccount {
  if (!c || typeof c !== "object" ||
    !headerValue(c.accessToken, MAX_SOURCE_BYTES, true) || !headerValue(c.uid, 253, true) ||
    (c.source !== "desktop" && c.source !== "browser")) throw new Error();
  const site = workBuddySite(siteId);
  const account: WorkBuddyAccount = {
    uid: c.uid,
    displayName: headerValue(c.displayName, 253) ? c.displayName : "",
    enterpriseId: headerValue(c.enterpriseId, 253) ? c.enterpriseId : "",
    domain: validDomain(c.domain, site),
    source: c.source,
    accessToken: c.accessToken,
    expiresAt: Number.isFinite(c.expiresAt) && c.expiresAt >= 0 ? Math.floor(c.expiresAt) : 0,
    importedAt: typeof c.importedAt === "string" ? c.importedAt : "",
    tokenType: typeof c.tokenType === "string" && headerValue(c.tokenType, 64) ? c.tokenType : undefined,
  };
  if (c.source === "browser" && headerValue(c.refreshToken, MAX_SOURCE_BYTES)) {
    account.refreshToken = c.refreshToken;
    if (Number.isFinite(c.refreshExpiresAt) && c.refreshExpiresAt > 0) account.refreshExpiresAt = Math.floor(c.refreshExpiresAt);
  }
  // Cooldown normalization: expired entries may be dropped (§16 review); a
  // legacy model-scoped `cooldown` slot migrates into the additive map.
  const cooldown = c.cooldown && typeof c.cooldown === "object" ? c.cooldown : undefined;
  if (cooldown && Number.isFinite(cooldown.until) && cooldown.until > now &&
      Number.isSafeInteger(Number(cooldown.code))) {
    if (cooldown.scope === "account") {
      account.cooldown = { until: Math.floor(cooldown.until), scope: "account", code: Number(cooldown.code) };
    } else if (cooldown.scope === "model" && modelIdOk(cooldown.model)) {
      account.modelCooldowns = { [cooldown.model]: { until: Math.floor(cooldown.until), code: Number(cooldown.code) } };
    }
  }
  if (c.modelCooldowns && typeof c.modelCooldowns === "object") {
    const map: Record<string, WorkBuddyModelCooldown> = {};
    for (const [model, slot] of Object.entries(c.modelCooldowns)) {
      if (!modelIdOk(model) || !slot || typeof slot !== "object") continue;
      if (!Number.isFinite((slot as any).until) || (slot as any).until <= now || !Number.isSafeInteger(Number((slot as any).code))) continue;
      map[model] = { until: Math.floor((slot as any).until), code: Number((slot as any).code) };
      if (Object.keys(map).length >= 32) break;
    }
    if (Object.keys(map).length) account.modelCooldowns = map;
  }
  return account;
}

/** Atomic 0600 CCR-only copy. Test path injection is internal, never accepted by an HTTP API. */
export class WorkBuddyCredentialStore {
  constructor(readonly path = join(HOME_DIR, "workbuddy-credentials.json")) {}

  /** The v1 backup path created once before the v1→v2 migration (contract §16). */
  get backupV1Path(): string {
    return this.path.endsWith(".json") ? this.path.slice(0, -5) + ".v1.bak" : this.path + ".v1.bak";
  }

  /** Read without version coercion. Returns the raw normalized v1 credential or v2 data. */
  async readRaw(): Promise<WorkBuddyCredentialData | WorkBuddyCredential | null> {
    let file: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      file = await fs.open(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES || (process.platform !== "win32" && (stat.mode & 0o077))) throw new Error();
      const c = JSON.parse(await file.readFile("utf8"));
      if (c?.version === 2) return this.normalizeData(c);
      return this.normalizeV1(c);
    } catch (e: any) {
      if (e?.code === "ENOENT") return null;
      throw new Error("WorkBuddy 私有登录态不可读，请重新导入");
    } finally { await file?.close(); }
  }

  /**
   * Migration-only read: parses v1 bytes WITHOUT the mode check (a stray
   * permissive v1 file must be CONVERTED to a 0600 v2 file, not brick the
   * pool). Returns the exact bytes from the SAME validated O_NOFOLLOW handle —
   * the backup must never re-resolve the path (§16 review: TOCTOU race).
   */
  private async readV1Lenient(): Promise<{ credential: WorkBuddyCredential; bytes: Buffer } | null> {
    let file: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      file = await fs.open(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) return null;
      const bytes = await file.readFile();
      return { credential: this.normalizeV1(JSON.parse(bytes.toString("utf8"))), bytes };
    } catch {
      return null;
    } finally { await file?.close(); }
  }

  /**
   * Load normalized v2 data. A legacy v1 file is migrated IN MEMORY only;
   * use migrateV1() to back it up and convert the file on disk.
   */
  async loadData(): Promise<WorkBuddyCredentialData | null> {
    const raw = await this.readRaw();
    if (!raw) return null;
    return raw.version === 2 ? raw : this.migrateV1Data(raw);
  }

  /** Whitelist normalization of a v1 single-credential file. */
  private normalizeV1(c: any): WorkBuddyCredential {
    if (!c || typeof c !== "object" || c.version !== 1 ||
      !(c.kind === "workbuddy" || c.kind === "workbuddy-ai")) throw new Error();
    const account = normalizeAccount({ ...c, version: undefined }, c.kind);
    return { version: 1, ...account, kind: c.kind, lastSyncAt: typeof c.lastSyncAt === "string" ? c.lastSyncAt : undefined };
  }

  /** Whitelist normalization: unknown junk never survives a save/load round-trip. */
  private normalizeData(c: any): WorkBuddyCredentialData {
    if (!c || typeof c !== "object" || c.version !== 2 || !c.sites || typeof c.sites !== "object") throw new Error();
    const sites: WorkBuddyCredentialData["sites"] = {};
    for (const id of ["workbuddy", "workbuddy-ai"] as const) {
      const s = c.sites[id];
      if (!s) continue;
      if (typeof s !== "object" || !Array.isArray(s.accounts)) throw new Error();
      if (s.accounts.length === 0 || s.accounts.length > 64) throw new Error();
      const accounts: WorkBuddyAccount[] = s.accounts.map((a: any) => normalizeAccount(a, id));
      const uids = new Set(accounts.map((a) => a.uid));
      if (uids.size !== accounts.length) throw new Error();
      const hiddenRaw: unknown[] = Array.isArray(s.hiddenModels) ? s.hiddenModels : [];
      const hiddenModels = [...new Set(hiddenRaw.filter(modelIdOk))];
      const activeUid = s.activeUid === null ? null : (typeof s.activeUid === "string" && uids.has(s.activeUid) ? s.activeUid : accounts[0].uid);
      const discoveredRaw: unknown[] | undefined = Array.isArray(s.discoveredModels) ? s.discoveredModels : undefined;
      sites[id] = {
        hiddenModels,
        activeUid: accounts.some((a) => a.uid === activeUid) ? activeUid : null,
        accounts,
        discoveredModels: discoveredRaw ? [...new Set(discoveredRaw.filter(modelIdOk))] : undefined,
        lastSyncAt: typeof s.lastSyncAt === "string" ? s.lastSyncAt : undefined,
        lastError: typeof s.lastError === "string" && s.lastError.length <= 512 ? s.lastError : null,
      };
    }
    if (!Object.keys(sites).length) throw new Error();
    return { version: 2, sites };
  }

  private migrateV1Data(c: WorkBuddyCredential): WorkBuddyCredentialData {
    const { version: _v, kind, lastSyncAt, ...account } = c;
    return { version: 2, sites: { [kind]: { hiddenModels: [], activeUid: account.uid, accounts: [account], lastSyncAt: lastSyncAt ?? undefined } } };
  }

  /**
   * Create workbuddy-credentials.v1.bak (0600) from the current v1 bytes and
   * convert the file to v2. Called once, before any provider/Router migration
   * (contract §16). The backup keeps the EXACT on-disk v1 bytes and is never
   * overwritten on repeat calls.
   */
  async migrateV1(): Promise<{ data: WorkBuddyCredentialData; legacy: WorkBuddyCredential | null; backupCreated: boolean }> {
    // A permissive/unreadable file must still migrate: read bytes leniently,
    // back them up, then rewrite v2 at 0600 (which repairs the mode).
    let legacy: WorkBuddyCredential | null = null;
    let v1bytes: Buffer | null = null;
    const lenient = await this.readV1Lenient();
    if (lenient) { legacy = lenient.credential; v1bytes = lenient.bytes; }
    if (!legacy) {
      const raw = await this.readRaw();
      if (raw?.version === 2) return { data: raw, legacy: null, backupCreated: false };
      throw new Error("WorkBuddy 私有登录态迁移失败");
    }
    let backupCreated = false;
    try {
      await fs.access(this.backupV1Path, constants.O_RDONLY);
    } catch {
      // Exact bytes from the validated handle — never a second path lookup.
      await this.writePrivate(this.backupV1Path, v1bytes!);
      backupCreated = true;
    }
    const data = this.migrateV1Data(legacy);
    await this.saveData(data);
    return { data, legacy, backupCreated };
  }

  private async writePrivate(target: string, contents: Buffer | string): Promise<void> {
    await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const temp = `${target}.${randomBytes(12).toString("hex")}.tmp`;
    try {
      const file = await fs.open(temp, "wx", 0o600);
      try { await file.writeFile(contents); await file.sync(); } finally { await file.close(); }
      await fs.rename(temp, target);
      if (process.platform !== "win32") await fs.chmod(target, 0o600);
    } catch { throw new Error("WorkBuddy 私有登录态保存失败"); }
    finally { await fs.unlink(temp).catch(() => {}); }
  }

  async saveData(data: WorkBuddyCredentialData): Promise<void> {
    let safe: WorkBuddyCredentialData;
    try { safe = this.normalizeData(data); } catch { throw new Error("WorkBuddy 私有登录态保存失败"); }
    await this.writePrivate(this.path, JSON.stringify(safe));
  }

  /**
   * Upsert one account into its site pool: a repeated uid REPLACES that
   * account's credentials (contract §16). Other sites are untouched. Returns
   * the normalized v2 data written and whether the uid replaced an existing
   * account. A legacy v1 file is backed up + converted on first v2 write.
   */
  async upsertAccount(c: WorkBuddyCredential): Promise<{ data: WorkBuddyCredentialData; replaced: boolean }> {
    const migrated = await this.ensureV2OnDisk();
    const current = migrated?.data ?? (await this.loadData()) ?? { version: 2 as const, sites: {} };
    const { version: _v, kind, lastSyncAt, ...accountFields } = c;
    const account = normalizeAccount(accountFields, kind);
    const prev = current.sites[kind] ?? { hiddenModels: [], activeUid: null, accounts: [] };
    const idx = prev.accounts.findIndex((a) => a.uid === account.uid);
    const replaced = idx >= 0;
    if (replaced) {
      // Re-login keeps pool position, hidden list and the sticky active uid.
      // STILL-VALID cooldown state survives credential replacement (§16 review):
      // a fresh login is NOT evidence that quota/rate limits reset. Expired
      // entries are dropped.
      const prior = prev.accounts[idx];
      const now = Date.now();
      if (prior.cooldown && prior.cooldown.until > now) account.cooldown = prior.cooldown;
      if (prior.modelCooldowns) {
        const live: Record<string, WorkBuddyModelCooldown> = {};
        for (const [model, slot] of Object.entries(prior.modelCooldowns)) if (slot.until > now) live[model] = slot;
        if (Object.keys(live).length) account.modelCooldowns = live;
      }
      prev.accounts[idx] = account;
    } else {
      prev.accounts.push(account);
    }
    if (!prev.activeUid || !prev.accounts.some((a) => a.uid === prev.activeUid)) prev.activeUid = account.uid;
    if (lastSyncAt) prev.lastSyncAt = lastSyncAt;
    current.sites[kind] = prev;
    await this.saveData(current);
    return { data: current, replaced };
  }

  /** Sticky active selection. Rejects an unknown uid. */
  async setActiveUid(site: WorkBuddySiteId, uid: string): Promise<WorkBuddyCredentialData> {
    const current = await this.loadData();
    const state = current?.sites[site];
    if (!state || !state.accounts.some((a) => a.uid === uid)) throw new Error("workbuddy_account_not_found");
    state.activeUid = uid;
    await this.saveData(current!);
    return current!;
  }

  /**
   * Remove one pool account. Removing the active uid advances stickiness to
   * the earliest-imported remaining account; an emptied pool leaves NO site
   * state behind (the service then removes the provider but keeps Router).
   */
  async removeAccount(site: WorkBuddySiteId, uid: string): Promise<{ data: WorkBuddyCredentialData | null; removed: boolean; activeAdvancedTo: string | null }> {
    const current = await this.loadData();
    const state = current?.sites[site];
    if (!state || !state.accounts.some((a) => a.uid === uid)) return { data: current ?? null, removed: false, activeAdvancedTo: null };
    state.accounts = state.accounts.filter((a) => a.uid !== uid);
    let activeAdvancedTo: string | null = null;
    if (state.accounts.length === 0) {
      delete current!.sites[site];
      if (!Object.keys(current!.sites).length) { await this.delete(); return { data: null, removed: true, activeAdvancedTo: null }; }
    } else if (state.activeUid === uid || !state.accounts.some((a) => a.uid === state.activeUid)) {
      state.activeUid = [...state.accounts].sort((a, b) => (a.importedAt < b.importedAt ? -1 : a.importedAt > b.importedAt ? 1 : 0))[0].uid;
      activeAdvancedTo = state.activeUid;
    }
    await this.saveData(current!);
    return { data: current!, removed: true, activeAdvancedTo };
  }

  /** Merge a fresh discovered id set into the site's cumulative union. */
  async mergeDiscoveredModels(site: WorkBuddySiteId, models: readonly string[]): Promise<WorkBuddyCredentialData> {
    const current = await this.loadData();
    if (!current?.sites[site]) throw new Error("workbuddy_not_connected");
    const state = current.sites[site]!;
    const union = new Set([...(state.discoveredModels ?? []), ...models.filter(modelIdOk)]);
    state.discoveredModels = [...union];
    await this.saveData(current);
    return current;
  }

  /** Replace one site's hidden-model blacklist (values are validated/deduped). */
  async setHiddenModels(site: WorkBuddySiteId, hiddenModels: readonly string[]): Promise<WorkBuddyCredentialData> {
    const current = await this.loadData();
    if (!current?.sites[site]) throw new Error("workbuddy_not_connected");
    current.sites[site]!.hiddenModels = [...new Set(hiddenModels.filter(modelIdOk))];
    await this.saveData(current);
    return current;
  }

  /**
   * Set cooldown state on one pool account. Account scope fills the single
   * account slot; model scope ADDS to the per-model map (an account can be
   * limited on model A and model B at once — §16 review). `null` clears ALL
   * cooldown state (full reset). Values are validated; expired entries are
   * dropped.
   */
  async setAccountCooldown(site: WorkBuddySiteId, uid: string, cooldown: WorkBuddyCooldown | null): Promise<WorkBuddyCredentialData> {
    const current = await this.loadData();
    const account = current?.sites[site]?.accounts.find((a) => a.uid === uid);
    if (!account) throw new Error("workbuddy_account_not_found");
    if (cooldown === null) {
      delete account.cooldown;
      delete account.modelCooldowns;
    } else if (cooldown.scope === "account") {
      account.cooldown = { until: Math.floor(cooldown.until), scope: "account", code: cooldown.code };
    } else if (cooldown.scope === "model" && modelIdOk(cooldown.model)) {
      const map = { ...(account.modelCooldowns ?? {}) };
      map[cooldown.model!] = { until: Math.floor(cooldown.until), code: cooldown.code };
      account.modelCooldowns = map;
    }
    await this.saveData(current!);
    return current!;
  }

  /** Remove one site entirely (full disconnect). Deletes the file when no sites remain. */
  async deleteSite(site: WorkBuddySiteId): Promise<boolean> {
    const data = await this.loadData();
    if (!data?.sites[site]) return false;
    delete data.sites[site];
    if (!Object.keys(data.sites).length) return this.delete();
    await this.saveData(data);
    return true;
  }

  /**
   * If the on-disk file is still v1, perform the one-time backup + conversion
   * before the first v2 write. Returns null when no v1 file needed migration.
   */
  private async ensureV2OnDisk(): Promise<{ data: WorkBuddyCredentialData; legacy: WorkBuddyCredential | null; backupCreated: boolean } | null> {
    const lenient = await this.readV1Lenient();
    if (lenient) return this.migrateV1();
    const raw = await this.readRaw();
    if (!raw) return null;
    return raw.version === 2 ? { data: raw, legacy: null, backupCreated: false } : this.migrateV1();
  }

  async delete(): Promise<boolean> {
    try { await fs.unlink(this.path); return true; }
    catch (e: any) { if (e?.code === "ENOENT") return false; throw new Error("WorkBuddy 私有登录态删除失败"); }
  }

  // ----------------------------------------------------------------
  // Legacy single-credential compatibility shim — ONLY the still-single-site
  // WorkBuddyAuthService uses these. Milestone B rewrites that service to the
  // pool API (loadData/upsertAccount/...) and DELETES every method below.
  // ----------------------------------------------------------------

  /** @deprecated use loadData(); returns the active account when exactly one site is present. */
  async load(): Promise<WorkBuddyCredential | null> {
    const raw = await this.readRaw();
    if (!raw) return null;
    if (raw.version === 1) return raw;
    const ids = Object.keys(raw.sites) as WorkBuddySiteId[];
    if (!ids.length) return null;
    // CN-first deterministic pick; multi-site correctness arrives with milestone B.
    const id = (ids.includes("workbuddy") ? "workbuddy" : ids[0]) as WorkBuddySiteId;
    const state = raw.sites[id]!;
    const account = state.accounts.find((a) => a.uid === state.activeUid) ?? state.accounts[0];
    return { version: 1, kind: id, ...account, lastSyncAt: state.lastSyncAt };
  }

  /** @deprecated use upsertAccount(); retained for the pre-§16 service. */
  async save(c: WorkBuddyCredential): Promise<void> {
    await this.upsertAccount(c);
  }
}
export const workBuddyCredentialStore = new WorkBuddyCredentialStore();
export function credentialHeaders(c: WorkBuddyCredential, ua = WORKBUDDY_CHAT_UA): Record<string, string> {
  if (!headerValue(c.accessToken, MAX_SOURCE_BYTES, true) || !headerValue(c.uid, 253, true) || !headerValue(c.enterpriseId)) throw new Error("WorkBuddy 登录态无效，请重新导入");
  const site = workBuddySite(c.kind);
  const headers: Record<string, string> = { Authorization: `Bearer ${c.accessToken}`, "X-User-Id": c.uid,
    "X-Domain": validDomain(c.domain, site), "X-Product": "SaaS", "X-IDE-Type": "WorkBuddy", "User-Agent": ua,
    "X-Requested-With": "XMLHttpRequest", "X-Agent-Intent": "craft", "X-Agent-Purpose": "conversation",
    "X-IDE-Name": "WorkBuddy", "X-IDE-Version": WORKBUDDY_UA_VERSION, "Content-Type": "application/json" };
  // International build only (magpie SITES.ai, P:L281-282).
  if (site.id === "workbuddy-ai") headers["X-Agent-Type"] = "main";
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
  // The turn id is always sent when a conversation key exists: with no derivable turn key a
  // fresh one keeps the request attributed to a turn in WorkBuddy's usage detail (magpie P:L447-451).
  return { "X-Conversation-Message-ID": msg, "X-Request-ID": msg,
    ...(conv ? { "X-Conversation-ID": id("conversation", conv) } : {}),
    "X-Conversation-Request-ID": conv && turn ? id("turn", `${conv}|${turn}`) : randomBytes(16).toString("hex") };
}
export interface WorkBuddyModel { id: string; name: string; context?: number; output?: number; images?: boolean; efforts?: string[] }
/**
 * True when this site's build drops images for the model even though /v3/config says it
 * takes them (international GLM models, magpie P:L86-101). Surfaced to the UI only; the
 * request itself is never rewritten.
 */
export function workBuddyImagesDropped(siteId: WorkBuddySiteId, modelId: string): boolean {
  const site = workBuddySite(siteId);
  return !!site.noImages?.test(modelId);
}
export function parseWorkBuddyModels(env: any, siteId: WorkBuddySiteId = "workbuddy"): WorkBuddyModel[] {
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
        m.images = d.supportsImages === true && !workBuddyImagesDropped(siteId, id);
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

// ---- token renewal by re-reading the desktop file (contract §14.3) ---------

/**
 * A near-expiry access token is renewed by re-reading the desktop login file, never by
 * spending the app's refresh token: the upstream refresh reply rotates the refresh token
 * and we never write back, which would leave the user's WorkBuddy desktop app holding a
 * spent one (magpie P:L1081-1084). The file read result is held in memory only.
 */
const renewalInFlight = new Map<string, Promise<WorkBuddyCredential>>();
const renewalRecent = new Map<string, { credential: WorkBuddyCredential; at: number }>();
const KEEP_RENEWED_MS = 60 * 1000;

export const workBuddyNeedsRenewal = (c: WorkBuddyCredential, now = Date.now()): boolean =>
  c.expiresAt > 0 && c.expiresAt - now <= WORKBUDDY_REFRESH_LEAD_MS;

/**
 * Re-read the desktop login file for this credential's site and use it only when it carries a
 * NEWER access token than the stored snapshot (the app refreshed itself since the import).
 * Never throws and never writes to the CCR-private file or the desktop file.
 */
export async function renewWorkBuddyFromDesktop(
  c: WorkBuddyCredential,
  readSource: () => WorkBuddySourceResult = () => readWorkBuddySource(c.kind)
): Promise<WorkBuddyCredential> {
  const key = createHash("sha256").update(JSON.stringify([c.kind, c.uid, c.enterpriseId, c.importedAt, c.accessToken])).digest("hex");
  const recent = renewalRecent.get(key);
  if (recent && Date.now() - recent.at < KEEP_RENEWED_MS) return recent.credential;
  const running = renewalInFlight.get(key);
  if (running) return running;
  const task = (async () => {
    let next = c;
    try {
      const probe = readSource();
      // A different site's file must never replace this credential.
      if (probe.ok && probe.credential.kind === c.kind && probe.credential.uid === c.uid &&
          probe.credential.enterpriseId === c.enterpriseId &&
          probe.credential.accessToken !== c.accessToken && probe.credential.expiresAt > c.expiresAt) {
        next = { ...c, accessToken: probe.credential.accessToken, expiresAt: probe.credential.expiresAt,
          domain: probe.credential.domain, enterpriseId: probe.credential.enterpriseId,
          displayName: probe.credential.displayName || c.displayName };
      }
    } catch { /* unreadable file: keep the snapshot */ }
    if (renewalRecent.size >= 256) renewalRecent.delete(renewalRecent.keys().next().value!);
    renewalRecent.set(key, { credential: next, at: Date.now() });
    return next;
  })();
  renewalInFlight.set(key, task);
  try { return await task; } finally { renewalInFlight.delete(key); }
}

// ---- browser sign-in (contract §15; magpie browserSignIn) ------------------

/** The version WorkBuddy's sign-in page is opened with (magpie APP_VERSION). */
export const WORKBUDDY_APP_VERSION = "2.0.0";
export const WORKBUDDY_LOGIN_TTL_MS = 5 * 60 * 1000;

/** The opaque sign-in state must be a bounded, control-char-free string. */
function loginStateOk(state: unknown): state is string {
  return typeof state === "string" && state.length >= 1 && state.length <= 512 && !/[\x00-\x1f\x7f]/.test(state);
}

function tokenExpiryMs(d: any, at = Date.now()): number {
  if (Number.isFinite(d?.expiresAt) && d.expiresAt > 0) return d.expiresAt;
  if (Number.isFinite(d?.expiresIn) && d.expiresIn > 0) return at + d.expiresIn * 1000;
  return 0;
}
function refreshExpiryMs(d: any, at = Date.now()): number {
  if (Number.isFinite(d?.refreshExpiresAt) && d.refreshExpiresAt > 0) return d.refreshExpiresAt;
  if (Number.isFinite(d?.refreshExpiresIn) && d.refreshExpiresIn > 0) return at + d.refreshExpiresIn * 1000;
  return 0;
}

/** Drain bounded upstream envelopes without retaining/logging raw error bodies. */
export async function readWorkBuddyResponseText(response: Response, maxBytes = 1024 * 1024): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  let bytes = 0, text = "";
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) { await reader.cancel(); throw new Error("workbuddy_response_too_large"); }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}

/**
 * One WorkBuddy plugin-API call: fixed origin, JSON envelope {code,msg,data},
 * no redirects. Network failures carry network:true so the login poll can
 * distinguish "not yet" from a rejection.
 */
async function pluginEnvelope(fetchImpl: WorkBuddyFetch, url: string, init: RequestInit = {}): Promise<{ code: number; msg?: string; data: any }> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      ...init,
      headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": WORKBUDDY_CHAT_UA, ...(init.headers ?? {}) },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    } as RequestInit);
  } catch {
    throw Object.assign(new Error("workbuddy_plugin_network"), { network: true, code: 0, status: 0 });
  }
  const text = await readWorkBuddyResponseText(response);
  let env: any = {};
  try { env = JSON.parse(text); } catch { /* non-JSON */ }
  const code = Number.parseInt(env?.code, 10) || 0;
  if (!response.ok || response.redirected || code !== 0) {
    // Raw upstream strings may echo credentials. Expose classification only.
    throw Object.assign(new Error("workbuddy_plugin_error"), { code, status: response.status });
  }
  return { code: 0, data: env?.data };
}

export interface WorkBuddyLoginStart { state: string; url: string; expiresAt: number; }

/**
 * Ask WorkBuddy for a sign-in page (magpie browserSignIn step 1). The URL is
 * opened by the USER'S browser — CCR never fetches it. HTTPS and a site-specific
 * WorkBuddy/CodeBuddy domain-family allowlist prevent arbitrary authorization links.
 */
export async function createWorkBuddyLoginState(siteId: WorkBuddySiteId, fetchImpl: WorkBuddyFetch): Promise<WorkBuddyLoginStart> {
  const site = workBuddySite(siteId);
  const env = await pluginEnvelope(fetchImpl, site.origin + "/v2/plugin/auth/state?platform=" + encodeURIComponent(site.id), {
    method: "POST",
    headers: { "X-No-Authorization": "true", "X-No-User-Id": "true", "X-No-Enterprise-Id": "true", "X-No-Department-Info": "true" },
    body: "{}",
  });
  const state = env.data?.state;
  const authUrl = env.data?.authUrl;
  if (!loginStateOk(state) || typeof authUrl !== "string" || authUrl.length > 8192) throw new Error("workbuddy_login_state_failed");
  let url: URL;
  try { url = new URL(authUrl); } catch { throw new Error("workbuddy_login_state_failed"); }
  const domains = siteId === "workbuddy" ? ["copilot.tencent.com", "codebuddy.cn"] : ["workbuddy.ai", "codebuddy.ai"];
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") ||
      !domains.some((host) => url.hostname === host || url.hostname.endsWith("." + host))) {
    throw new Error("workbuddy_login_state_failed");
  }
  url.searchParams.set("version", WORKBUDDY_APP_VERSION);
  url.searchParams.set("loginSessionId", randomBytes(16).toString("hex"));
  return { state, url: url.toString(), expiresAt: Date.now() + WORKBUDDY_LOGIN_TTL_MS };
}

export type WorkBuddyLoginTokenPoll =
  | { pending: true }
  | { pending: false; ok: true; token: { accessToken: string; refreshToken?: string; expiresAt: number; domain?: string; tokenType?: string; refreshExpiresAt?: number } }
  | { pending: false; ok: false };

/**
 * One poll of the token endpoint (step 3). magpie retries code 11217 ("not
 * yet") plus 408/429/network — those read as pending; anything else means the
 * state was refused and the sign-in will not complete.
 */
export async function pollWorkBuddyLoginToken(siteId: WorkBuddySiteId, state: string, fetchImpl: WorkBuddyFetch): Promise<WorkBuddyLoginTokenPoll> {
  const site = workBuddySite(siteId);
  let env: { code: number; data: any };
  try {
    env = await pluginEnvelope(fetchImpl, site.origin + "/v2/plugin/auth/token?state=" + encodeURIComponent(state), { method: "GET" });
  } catch (error: any) {
    if (error?.code === 11217 || error?.status === 408 || error?.status === 429 || error?.network) return { pending: true };
    return { pending: false, ok: false };
  }
  const d = env.data ?? {};
  if (typeof d.accessToken === "string" && d.accessToken) {
    return { pending: false, ok: true, token: {
      accessToken: d.accessToken,
      refreshToken: typeof d.refreshToken === "string" && d.refreshToken ? d.refreshToken : undefined,
      expiresAt: tokenExpiryMs(d), domain: typeof d.domain === "string" && d.domain ? d.domain : undefined,
      tokenType: typeof d.tokenType === "string" && d.tokenType ? d.tokenType : undefined,
      refreshExpiresAt: refreshExpiryMs(d) || undefined,
    } };
  }
  return { pending: true };
}

/**
 * The account behind a finished sign-in (step 4). magpie retries code 12151
 * while WorkBuddy finalizes the session; the enterprise follows /login/account,
 * else — for a non-personal account type — the account list, exactly like
 * WorkBuddy's own client picks it (enterpriseOf).
 */
export async function fetchWorkBuddyLoginAccount(
  siteId: WorkBuddySiteId, state: string, accessToken: string, domain: string | undefined,
  fetchImpl: WorkBuddyFetch
): Promise<{ uid: string; displayName: string; enterpriseId: string } | null> {
  const site = workBuddySite(siteId);
  const headers: Record<string, string> = {
    Authorization: "Bearer " + accessToken,
    "X-Domain": domain || new URL(site.origin).host,
    "X-No-User-Id": "true", "X-No-Enterprise-Id": "true",
  };
  let who: any;
  try {
    who = (await pluginEnvelope(fetchImpl, site.origin + "/v2/plugin/login/account?state=" + encodeURIComponent(state), { method: "GET", headers })).data ?? {};
  } catch (error: any) {
    if (error?.code === 12151 || error?.status === 408 || error?.status === 429 || error?.network) return null;
    throw new Error("workbuddy_login_account_failed");
  }
  const uid = typeof who?.uid === "string" ? who.uid : "";
  const displayName = [who?.nickname, who?.phoneNumber, uid].find((v: any) => typeof v === "string" && v) || uid;
  let enterpriseId = typeof who?.enterpriseId === "string" ? who.enterpriseId.trim() : "";
  const type = String(who?.type ?? "").trim().toLowerCase();
  if (!enterpriseId && type && type !== "personal") {
    try {
      const list = (await pluginEnvelope(fetchImpl, site.origin + "/v2/plugin/accounts", {
        method: "GET", headers: { Authorization: "Bearer " + accessToken, "X-Domain": headers["X-Domain"] },
      })).data;
      const mine = (Array.isArray(list?.accounts) ? list.accounts : []).filter((x: any) => x?.uid === uid && typeof x.enterpriseId === "string" && x.enterpriseId.trim());
      const same = mine.filter((x: any) => String(x.type ?? "").trim().toLowerCase() === type);
      const last = mine.filter((x: any) => x.lastLogin);
      const pick = same.length === 1 ? same[0] : last.length === 1 ? last[0] : mine.length === 1 ? mine[0] : undefined;
      enterpriseId = pick ? pick.enterpriseId.trim() : "";
    } catch { enterpriseId = ""; }
  }
  return { uid, displayName, enterpriseId };
}

// ---- refresh for browser-owned credentials (contract §15) ------------------
//
// A browser sign-in's refresh token belongs to CCR alone — nothing else holds
// it — so unlike the desktop file's shared refresh token (§14.3: never stored,
// never spent) it is persisted and spent on near-expiry renewal, exactly like
// magpie does for its browser sign-ins. Single-flight per refresh token, and a
// 60s answer cache: a request that reads the old token after it was spent takes
// the renewed one instead of spending it again.

const refreshInFlight = new Map<string, Promise<WorkBuddyCredential>>();
const refreshedCache = new Map<string, { credential: WorkBuddyCredential; at: number }>();

export const workBuddyRefreshable = (c: WorkBuddyCredential): boolean =>
  c.source === "browser" && typeof c.refreshToken === "string" && c.refreshToken.length > 0 &&
  !(c.refreshExpiresAt && Date.now() >= c.refreshExpiresAt);

export async function refreshWorkBuddyToken(
  c: WorkBuddyCredential, fetchImpl: WorkBuddyFetch, save?: (next: WorkBuddyCredential) => Promise<void>
): Promise<WorkBuddyCredential> {
  if (!workBuddyRefreshable(c)) return c;
  const key = createHash("sha256").update(JSON.stringify([c.kind, c.uid, c.enterpriseId, c.importedAt, c.accessToken, c.refreshToken])).digest("hex");
  const done = refreshedCache.get(key);
  if (done && Date.now() - done.at < 60_000) {
    await save?.(done.credential);
    return { ...c, ...done.credential };
  }
  let running = refreshInFlight.get(key);
  if (!running) {
    running = (async () => {
      const site = workBuddySite(c.kind);
      const headers: Record<string, string> = {
        "X-Refresh-Token": c.refreshToken!, "X-Auth-Refresh-Source": "plugin", "X-Domain": validDomain(c.domain, site),
      };
      if (c.enterpriseId) { headers["X-Enterprise-Id"] = c.enterpriseId; headers["X-Tenant-Id"] = c.enterpriseId; }
      const env = await pluginEnvelope(fetchImpl, site.origin + "/v2/plugin/auth/token/refresh", { method: "POST", headers, body: "{}" });
      const d = env.data ?? {};
      if (typeof d.accessToken !== "string" || !d.accessToken) throw new Error("workbuddy_refresh_no_token");
      const next: WorkBuddyCredential = {
        ...c,
        accessToken: d.accessToken,
        refreshToken: typeof d.refreshToken === "string" && d.refreshToken ? d.refreshToken : c.refreshToken,
        expiresAt: tokenExpiryMs(d) || c.expiresAt,
        refreshExpiresAt: refreshExpiryMs(d) || c.refreshExpiresAt,
        domain: validDomain(typeof d.domain === "string" && d.domain ? d.domain : c.domain, site),
        tokenType: typeof d.tokenType === "string" && d.tokenType ? d.tokenType : c.tokenType,
      };
      if (refreshedCache.size >= 64) refreshedCache.delete(refreshedCache.keys().next().value!);
      refreshedCache.set(key, { credential: next, at: Date.now() });
      await save?.(next);
      return next;
    })().finally(() => refreshInFlight.delete(key));
    refreshInFlight.set(key, running);
  }
  return running;
}

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
