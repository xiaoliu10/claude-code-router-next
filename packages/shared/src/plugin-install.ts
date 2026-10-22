/**
 * Shared provider-plugin install core (docs/design/provider-plugins.md §2.2).
 *
 * This is the validated, pure copy/extract installer used by BOTH:
 *   - the CLI (`ccr plugin add`, packages/cli/src/utils/pluginCommand.ts)
 *   - the host admin API (`POST /api/plugins/install`)
 *
 * It never executes plugin code and never runs npm lifecycle scripts: npm
 * packages are fetched with `npm pack --ignore-scripts` inside a THROWAWAY
 * HOME/cache (so the user's ~/.npmrc credentials can never be read) and
 * extracted with the system tar only. Nothing from npm is trusted — the
 * payload manifest, entry, card declaration and every archive member are
 * validated before the staged payload is atomically swapped into
 * $CCR_CONFIG_DIR/plugins/<name>/.
 *
 * SERVER-SIDE / NODE-SIDE ONLY. This module uses node builtins
 * (child_process/fs/os/zlib) and must never be pulled into the UI import
 * graph.
 *
 * Credential files ($CCR_CONFIG_DIR/<name>-credentials.json etc.) live
 * OUTSIDE plugins/ and are never read, printed or removed here.
 */
import { execFile, execFileSync } from "child_process";
import {
  cpSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { basename, dirname, join, resolve, sep } from "path";
import { createGunzip } from "zlib";

/** Keep in sync with packages/core/src/provider-plugins/types.ts: the loader
 *  refuses plugins whose coreApi major differs from this. */
export const PLUGIN_CORE_API = "1";

export const PLUGIN_MANIFEST_FILE = "plugin.json";
export const PLUGIN_ENTRY_FILE = "plugin.js";
export const PLUGIN_RECORDS_FILE = "plugins.json";

/** Installed-plugin (manifest) name: same rule the loader uses for the
 *  install directory — unscoped, no dots/underscores. */
export const PLUGIN_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/i;

/** Allowlist for an npm package *request* (name only). Scoped names are
 *  permitted here; the installed plugin name still comes exclusively from the
 *  validated plugin.json, never from this string. A filesystem path or URL can
 *  never match (no leading /, ., ~, no protocol, no version spec). */
export const NPM_SPEC_PATTERN =
  /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/** Reject compressed/expanded archives above 25 MB. */
export const PLUGIN_ARCHIVE_MAX_BYTES = 25 * 1024 * 1024;
/** Reject payloads containing more than 2000 files. */
export const PLUGIN_ARCHIVE_MAX_FILES = 2000;
/** Bounded npm network wait for the host install lane (ms). */
export const PLUGIN_NPM_PACK_TIMEOUT_MS = 30_000;

export interface PluginManifest {
  name: string;
  version: string;
  coreApi: string;
  description?: string;
}

export interface PluginInstallRecord {
  name: string;
  enabled: boolean;
}

/** Manifest fields as they appear on disk, before validation. */
export interface RawPluginManifest {
  name?: unknown;
  version?: unknown;
  coreApi?: unknown;
  description?: unknown;
  card?: unknown;
  ui?: { card?: unknown };
}

/** Stable machine-readable failure codes for the host API. The CLI keeps
 *  printing its human-readable messages; callers may map these codes to HTTP
 *  status and safe UI text. */
export type PluginInstallErrorCode =
  | "invalid_spec"
  | "npm_pack_failed"
  | "npm_pack_timeout"
  | "archive_too_large"
  | "archive_too_many_files"
  | "unsafe_archive_member"
  | "extract_failed"
  | "invalid_manifest"
  | "already_installed"
  | "plugins_json_corrupted";

export class PluginInstallError extends Error {
  code: PluginInstallErrorCode;
  constructor(message: string, code: PluginInstallErrorCode) {
    super(message);
    this.name = "PluginInstallError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

/** Throw unless `spec` is a plain, allowlisted npm package name — never a
 *  filesystem path, URL, option flag or name@version spec. */
export function assertSafeNpmSpec(spec: unknown): asserts spec is string {
  if (
    typeof spec !== "string" ||
    spec.length === 0 ||
    spec.length > 214 ||
    spec.startsWith("-") ||
    !NPM_SPEC_PATTERN.test(spec)
  ) {
    throw new PluginInstallError(
      `invalid plugin package request ${JSON.stringify(String(spec ?? ""))} (only npm package names are allowed)`,
      "invalid_spec"
    );
  }
}

// ---------------------------------------------------------------------------
// Manifest / payload validation
// ---------------------------------------------------------------------------

/** Validate a manifest read from disk; when installName is given the manifest
 *  name must equal it (the loader makes the same check against the install
 *  directory name). Returns the normalized manifest. */
export function validatePluginManifest(
  raw: RawPluginManifest,
  installName?: string
): PluginManifest {
  const m = raw;
  if (typeof m.name !== "string" || m.name.length === 0) {
    throw new PluginInstallError(`${PLUGIN_MANIFEST_FILE} has no "name"`, "invalid_manifest");
  }
  if (!PLUGIN_NAME_PATTERN.test(m.name)) {
    throw new PluginInstallError(
      `invalid plugin name "${m.name}" (must match ${PLUGIN_NAME_PATTERN.toString()})`,
      "invalid_manifest"
    );
  }
  if (typeof m.version !== "string" || m.version.length === 0) {
    throw new PluginInstallError(
      `${PLUGIN_MANIFEST_FILE} for "${m.name}" has no "version"`,
      "invalid_manifest"
    );
  }
  const coreApi = String(m.coreApi ?? PLUGIN_CORE_API);
  if (coreApi.split(".")[0] !== PLUGIN_CORE_API) {
    throw new PluginInstallError(
      `plugin "${m.name}" declares coreApi ${coreApi}, incompatible with this CCR (core ${PLUGIN_CORE_API})`,
      "invalid_manifest"
    );
  }
  if (installName !== undefined && m.name !== installName) {
    throw new PluginInstallError(
      `manifest name "${m.name}" does not match install directory name "${installName}"`,
      "invalid_manifest"
    );
  }
  return {
    name: m.name,
    version: m.version,
    coreApi,
    description: typeof m.description === "string" ? m.description : undefined,
  };
}

/** Read and parse a payload manifest, returning the raw field record. */
export function readPluginManifest(payloadDir: string): RawPluginManifest {
  let raw: string;
  try {
    raw = readFileSync(join(payloadDir, PLUGIN_MANIFEST_FILE), "utf8");
  } catch {
    throw new PluginInstallError(`${PLUGIN_MANIFEST_FILE} not found in ${payloadDir}`, "invalid_manifest");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e: any) {
    throw new PluginInstallError(
      `${PLUGIN_MANIFEST_FILE} is not valid JSON: ${e.message}`,
      "invalid_manifest"
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PluginInstallError(`${PLUGIN_MANIFEST_FILE} is not a JSON object`, "invalid_manifest");
  }
  return parsed as RawPluginManifest;
}

/** The installable payload is either the directory itself (installed layout)
 *  or its built dist/ (package root layout). */
export function resolvePluginPayloadDir(dir: string): string | null {
  for (const candidate of [dir, join(dir, "dist")]) {
    if (
      existsSync(join(candidate, PLUGIN_MANIFEST_FILE)) &&
      existsSync(join(candidate, PLUGIN_ENTRY_FILE))
    ) {
      return candidate;
    }
  }
  return null;
}

/** Refuse payloads that carry symlinks: the loader only ever accepts real
 *  directories/files under plugins/<name>/, so a symlinked payload could
 *  never load and might point outside the install root. */
export function assertNoSymlinks(root: string): void {
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        throw new PluginInstallError(
          `refusing to install: payload contains a symlink "${join(dir, entry.name)}"`,
          "unsafe_archive_member"
        );
      }
      if (entry.isDirectory()) stack.push(join(dir, entry.name));
    }
  }
}

/** card.js is optional; but if the manifest declares a UI card file it must
 *  exist in the payload. The declared path must be a plain file name inside
 *  the payload — the same shape the core loader serves (no traversal). */
export function validateCardPayload(payloadDir: string, raw: RawPluginManifest): void {
  const declared =
    typeof raw.card === "string"
      ? raw.card
      : typeof raw.ui?.card === "string"
        ? raw.ui.card
        : undefined;
  if (typeof declared === "string" && declared.length > 0) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(declared)) {
      throw new PluginInstallError(
        `manifest declares an unsafe UI card path "${declared}" (must be a plain file inside the payload)`,
        "unsafe_archive_member"
      );
    }
    if (!existsSync(join(payloadDir, declared))) {
      throw new PluginInstallError(
        `manifest declares UI card "${declared}" but the file is missing from the payload`,
        "invalid_manifest"
      );
    }
  }
}

// ---------------------------------------------------------------------------
// plugins.json records (same file the core loader reads)
// ---------------------------------------------------------------------------

export function pluginRecordsFile(configDir: string): string {
  return join(configDir, "plugins", PLUGIN_RECORDS_FILE);
}

export interface ReadRecordsResult {
  records: PluginInstallRecord[];
  /** The file existed but could not be parsed — a rewrite would be lossy. */
  corrupted: boolean;
}

export function readPluginRecordsChecked(configDir: string): ReadRecordsResult {
  let raw: string;
  try {
    raw = readFileSync(pluginRecordsFile(configDir), "utf8");
  } catch {
    // Missing file is the normal first-run state, not corruption.
    return { records: [], corrupted: false };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { records: [], corrupted: true };
    // Mirror the loader's tolerance: any {name: string} entry counts, with
    // enabled !== false treated as enabled — so hand-tolerated records are
    // never silently dropped when the file is rewritten.
    return {
      records: parsed
        .filter((e: any): e is { name: string; enabled?: unknown } =>
          e && typeof e.name === "string")
        .map((e) => ({ name: e.name, enabled: e.enabled !== false })),
      corrupted: false,
    };
  } catch {
    return { records: [], corrupted: true };
  }
}

export function readPluginRecords(configDir: string): PluginInstallRecord[] {
  return readPluginRecordsChecked(configDir).records;
}

export function writePluginRecords(configDir: string, records: PluginInstallRecord[]): void {
  mkdirSync(join(configDir, "plugins"), { recursive: true });
  writeFileSync(pluginRecordsFile(configDir), JSON.stringify(records, null, 2) + "\n");
}

function corruptedRecordsError(configDir: string): PluginInstallError {
  return new PluginInstallError(
    `${pluginRecordsFile(configDir)} is not valid JSON; refusing to overwrite it. Fix or remove the file (or pass --force to replace it with only the new record).`,
    "plugins_json_corrupted"
  );
}

/** Refuse an unparseable plugins.json up front (before any filesystem work):
 *  the later rewrite would silently and permanently drop records the loader
 *  would have tolerated after a manual fix. force is the escape hatch. */
export function assertRecordsWritable(configDir: string, force: boolean): void {
  if (force) return;
  if (readPluginRecordsChecked(configDir).corrupted) throw corruptedRecordsError(configDir);
}

/** Register or replace the record for name, preserving the order of all
 *  other records (the loader loads in plugins.json order). Refuses to
 *  overwrite an UNPARSEABLE plugins.json without force. A disabled record is
 *  re-enabled by reinstalling. */
export function upsertPluginRecord(configDir: string, name: string, force = false): void {
  const { records, corrupted } = readPluginRecordsChecked(configDir);
  if (corrupted && !force) throw corruptedRecordsError(configDir);
  const record: PluginInstallRecord = { name, enabled: true };
  const idx = records.findIndex((r) => r.name === name);
  if (idx >= 0) records[idx] = record;
  else records.push(record);
  writePluginRecords(configDir, records);
}

export function removePluginRecord(configDir: string, name: string): boolean {
  const { records, corrupted } = readPluginRecordsChecked(configDir);
  if (corrupted) return false;
  const next = records.filter((r) => r.name !== name);
  if (next.length === records.length) return false;
  writePluginRecords(configDir, next);
  return true;
}

// ---------------------------------------------------------------------------
// Tar archives — deterministic binary member walk (never trust tar text out)
// ---------------------------------------------------------------------------

interface RawArchiveMember {
  name: string;
  size: number;
  type: string;
  /** Symlink/hardlink destination when the archive declares one. */
  linkTarget?: string;
}

const BLOCK = 512;

function readOctal(buf: Buffer, offset: number, length: number): number {
  // NUL/space padded octal field. Base-256 fields (high bit set) never occur
  // in plugin payloads under our size cap; treat them as 0 rather than
  // misreading.
  if (buf[offset] & 0x80) return 0;
  let s = "";
  for (let i = 0; i < length; i++) {
    const c = buf[offset + i];
    if (c === 0 || c === 0x20) continue;
    s += String.fromCharCode(c);
  }
  if (!s) return 0;
  const n = parseInt(s.trim(), 8);
  return Number.isFinite(n) ? n : 0;
}

/** The stored header checksum is the sum of the header's bytes with the
 *  checksum field itself read as spaces. Real extractors use it to decide
 *  whether a block is a header at all, so a validator that ignores it can
 *  treat arbitrary payload bytes (non-zero padding left over from a PAX size
 *  mismatch) as a member the extractor never sees. Rejecting a mismatch keeps
 *  both sides aligned. */
function assertValidHeaderChecksum(header: Buffer, name: string): void {
  // A header whose checksum field is not octal digits is not a header at all:
  // real extractors reject it too, so we must not silently parse it as one.
  const checksumField = header.subarray(148, 156);
  const digits = cString(checksumField, 0, 8).replace(/[ \0]/g, "");
  if (!/^[0-7]+$/.test(digits)) {
    throw new PluginInstallError(
      `plugin archive has a corrupt tar header${name ? ` (near "${name}")` : ""}`,
      "unsafe_archive_member"
    );
  }
  const stored = parseInt(digits, 8);
  if (stored === 0) return; // legacy archive with no checksum: nothing to compare
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < BLOCK; i++) {
    const b = i >= 148 && i < 156 ? 0x20 : header[i];
    unsigned += b;
    signed += b > 127 ? b - 256 : b;
  }
  if (stored !== unsigned && stored !== signed) {
    throw new PluginInstallError(
      `plugin archive has a corrupt tar header${name ? ` (near "${name}")` : ""}`,
      "unsafe_archive_member"
    );
  }
}

function cString(buf: Buffer, offset: number, length: number): string {
  let end = offset;
  const limit = offset + length;
  while (end < limit && buf[end] !== 0) end++;
  return buf.toString("utf8", offset, end);
}

/** Parse PAX extended-header records (`%d %s=%s\n` — the decimal prefix is the
 *  record's own byte length) into key/value pairs. */
function parsePaxRecords(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let pos = 0;
  while (pos < data.length) {
    let sep = pos;
    while (sep < data.length && data[sep] !== 0x20) sep++;
    if (sep >= data.length) break;
    const len = parseInt(data.toString("utf8", pos, sep), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const recordEnd = pos + len;
    const kvEnd = data.indexOf(0x0a, sep + 1);
    const lineEnd = kvEnd >= 0 && kvEnd < recordEnd ? kvEnd : recordEnd - 1;
    const line = data.toString("utf8", sep + 1, lineEnd);
    const eq = line.indexOf("=");
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
    pos = recordEnd;
  }
  return out;
}

/** PAX override fields that change how the FOLLOWING member must be parsed.
 *  Real extractors (GNU tar, bsdtar) apply these; if the validator ignores
 *  them the two sides walk two different archives. */
interface PaxOverrides {
  path?: string;
  size?: number;
  linkpath?: string;
}

function applyPaxOverrides(pax: Record<string, string>, target: PaxOverrides): void {
  if (pax.path !== undefined) target.path = pax.path;
  if (pax.linkpath !== undefined) target.linkpath = pax.linkpath;
  if (pax.size !== undefined) {
    if (!/^\d+$/.test(pax.size)) {
      throw new PluginInstallError(
        `plugin archive has a malformed PAX size record "${pax.size}"`,
        "unsafe_archive_member"
      );
    }
    const size = Number(pax.size);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new PluginInstallError(
        `plugin archive has an out-of-range PAX size record "${pax.size}"`,
        "unsafe_archive_member"
      );
    }
    target.size = size;
  }
}

/** Read and validate the whole archive in one pass, returning the resolved
 *  member list. This is the ONLY place that knows how the archive is laid
 *  out; extraction reuses these exact offsets, so the validated byte ranges
 *  and the written byte ranges can never disagree.
 *
 *  Extension records ('x'/'g' PAX, 'L'/'K' GNU) are honoured the way a real
 *  extractor honours them: 'x'/'L'/'K' apply to exactly the next member and
 *  are then cleared, 'g' sets defaults for every following member. The
 *  uncompressed stream is bounded while it is read, so a gzip bomb trips the
 *  size cap instead of exhausting memory, and a truncated tail (a live header
 *  whose data never arrived) is refused rather than silently under-counted. */
interface ResolvedArchiveMember extends RawArchiveMember {
  /** Byte offset of the member's data inside the uncompressed stream. */
  dataOffset: number;
}

async function readArchiveMembers(archive: string): Promise<ResolvedArchiveMember[]> {
  const members: ResolvedArchiveMember[] = [];
  let carry: Buffer = Buffer.alloc(0);
  let uncompressedBytes = 0;
  // Offsets are absolute within the decompressed stream, while `carry` shifts.
  let absoluteBase = 0;
  const globalPax: PaxOverrides = {};
  let pendingPax: PaxOverrides = {};
  let pendingGnuName: string | null = null;

  let fileCount = 0;
  let declaredBytes = 0;
  const consume = (buf: Buffer, allowPartialTail: boolean): { rest: Buffer; ended: boolean } => {
    let offset = 0;
    while (true) {
      if (buf.length - offset < BLOCK) break;
      const header = buf.subarray(offset, offset + BLOCK);
      // Two zero blocks terminate an archive; an all-zero header means no
      // more entries.
      if (header.every((b) => b === 0)) return { rest: Buffer.alloc(0), ended: true };

      const typeFlag = String.fromCharCode(header[156] ?? 0x30);
      const magic = cString(header, 257, 6);
      const prefix = magic.startsWith("ustar") ? cString(header, 345, 155) : "";
      const rawName = cString(header, 0, 100);

      // Decide whether this block really is a header before trusting any of
      // its fields. A block that carries neither a tar magic nor a plausible
      // name/size is payload padding, and the archive ends there - the same
      // judgement a real extractor makes. Anything that DOES look like a
      // header must then pass its checksum, so a smuggled block cannot pose
      // as a member the extractor ignores (or vice versa).
      const magicOk = magic.startsWith("ustar");
      const nameOk = rawName.length > 0 && /^[ -~]+$/.test(rawName);
      const sizeOk = /^[0-7]+$/.test(cString(header, 124, 12).replace(/[ \0]/g, "") || "0");
      if (!magicOk && !(nameOk && sizeOk)) {
        // Not a header. If the previous member already declared more data than
        // we can see, this is a truncated payload rather than a clean end.
        if (declaredBytes > absoluteBase + buf.length) {
          throw new PluginInstallError(
            "plugin archive is truncated (member data missing)",
            "extract_failed"
          );
        }
        return { rest: Buffer.alloc(0), ended: true };
      }
      assertValidHeaderChecksum(header, prefix ? `${prefix}/${rawName}` : rawName);
      const octalSize = readOctal(header, 124, 12);

      // 'g' defaults apply to every following member; a per-member 'x' record
      // wins over them (POSIX: the extended header overrides the standard one).
      const effectiveSize = pendingPax.size ?? octalSize;
      // Cap the declared payload before trusting the layout: a single member
      // that declares more than the whole budget is a bomb regardless of what
      // the following blocks look like.
      declaredBytes += effectiveSize;
      if (declaredBytes > PLUGIN_ARCHIVE_MAX_BYTES) {
        throw new PluginInstallError(
          `plugin payload exceeds ${PLUGIN_ARCHIVE_MAX_BYTES} bytes uncompressed`,
          "archive_too_large"
        );
      }
      const dataBlocks = Math.ceil(effectiveSize / BLOCK);
      const need = BLOCK + dataBlocks * BLOCK;
      if (buf.length - offset < need) {
        if (!allowPartialTail) {
          throw new PluginInstallError(
            `plugin archive is truncated (member data missing)`,
            "extract_failed"
          );
        }
        if (offset === 0) break;
        // Keep the unprocessed tail (it starts at this incomplete header).
        break;
      }

      const headerStart = absoluteBase + offset;
      const data = buf.subarray(offset + BLOCK, offset + BLOCK + effectiveSize);
      offset += need;

      // Extension records carry metadata only; they are never materialised.
      if (typeFlag === "x" || typeFlag === "g") {
        applyPaxOverrides(parsePaxRecords(data), typeFlag === "g" ? globalPax : pendingPax);
        continue;
      }
      if (typeFlag === "L") {
        pendingGnuName = cString(data, 0, data.length);
        continue;
      }
      if (typeFlag === "K") continue;

      // Long-name extensions (GNU 'L', PAX 'x' path) override the ustar name.
      let name =
        pendingGnuName ??
        pendingPax.path ??
        globalPax.path ??
        (prefix ? `${prefix}/${rawName}` : rawName);
      const linkTarget = pendingPax.linkpath ?? globalPax.linkpath;
      pendingGnuName = null;
      pendingPax = {};

      if (!name.replace(/\/$/, "")) {
        throw new PluginInstallError(
          "refusing archive member with an empty name",
          "unsafe_archive_member"
        );
      }
      members.push({
        name: name.replace(/\/$/, ""),
        size: effectiveSize,
        type: typeFlag,
        linkTarget,
        dataOffset: headerStart + BLOCK,
      });
      if (typeFlag === "0" || typeFlag === "\0" || typeFlag === "7") fileCount += 1;
      if (fileCount > PLUGIN_ARCHIVE_MAX_FILES) {
        throw new PluginInstallError(
          `plugin payload contains more than ${PLUGIN_ARCHIVE_MAX_FILES} files`,
          "archive_too_many_files"
        );
      }
    }
    return { rest: buf.subarray(offset) as Buffer, ended: false };
  };

  const stream = createReadStream(archive).pipe(createGunzip());
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      uncompressedBytes += chunk.length;
      if (uncompressedBytes > PLUGIN_ARCHIVE_MAX_BYTES) {
        stream.destroy();
        throw new PluginInstallError(
          `plugin payload exceeds ${PLUGIN_ARCHIVE_MAX_BYTES} bytes uncompressed`,
          "archive_too_large"
        );
      }
      carry = carry.length ? Buffer.concat([carry, chunk]) : Buffer.from(chunk);
      const before = carry.length;
      const r = consume(carry, true);
      absoluteBase += before - r.rest.length;
      carry = r.rest as Buffer;
      if (r.ended) return members;
    }
  } catch (e) {
    if (e instanceof PluginInstallError) throw e;
    throw new PluginInstallError(
      `failed to read plugin archive: ${(e as Error)?.message ?? e}`,
      "extract_failed"
    );
  }
  // Final pass: a leftover live header with truncated data must not be
  // ignored (it would under-count the caps).
  consume(carry, false);
  return members;
}

/** Reject absolute names, drive letters and any `..` component regardless of
 *  the platform tar's own defaults. */
function assertSafeMemberName(name: string): void {
  if (
    name.startsWith("/") ||
    name.startsWith("\\") ||
    /^[a-zA-Z]:/.test(name) ||
    name.split("/").some((part) => part === "..")
  ) {
    throw new PluginInstallError(
      `refusing to extract unsafe archive member "${name}"`,
      "unsafe_archive_member"
    );
  }
}

/** Enforce the payload caps (25 MB compressed AND uncompressed, 2000 files)
 *  and refuse links/specials/traversal BEFORE anything is extracted. */
export async function assertArchiveWithinCaps(archive: string): Promise<void> {
  const compressed = statSync(archive).size;
  if (compressed > PLUGIN_ARCHIVE_MAX_BYTES) {
    throw new PluginInstallError(
      `plugin archive is ${compressed} bytes (limit ${PLUGIN_ARCHIVE_MAX_BYTES} bytes)`,
      "archive_too_large"
    );
  }
  assertMembersWithinCaps(await readArchiveMembers(archive));
}

/** Caps + member safety for an already-resolved archive. Shared by the
 *  validate-only entry point and the extractor so both judge the same list. */
function assertMembersWithinCaps(members: ResolvedArchiveMember[]): void {
  let total = 0;
  let files = 0;
  for (const member of members) {
    assertSafeMemberName(member.name);
    if (member.type === "2" || member.type === "1") {
      throw new PluginInstallError(
        `refusing to extract archive link "${member.name}" (symlinks/hardlinks are not allowed in plugins)`,
        "unsafe_archive_member"
      );
    }
    if ("346".includes(member.type) || member.type === "S" || member.type === "V") {
      throw new PluginInstallError(
        `refusing to extract special archive member "${member.name}"`,
        "unsafe_archive_member"
      );
    }
    if (member.type === "0" || member.type === "\0" || member.type === "7") {
      total += member.size;
      files += 1;
    }
  }
  if (total > PLUGIN_ARCHIVE_MAX_BYTES) {
    throw new PluginInstallError(
      `plugin payload is ${total} bytes uncompressed (limit ${PLUGIN_ARCHIVE_MAX_BYTES} bytes)`,
      "archive_too_large"
    );
  }
  if (files > PLUGIN_ARCHIVE_MAX_FILES) {
    throw new PluginInstallError(
      `plugin payload contains ${files} files (limit ${PLUGIN_ARCHIVE_MAX_FILES})`,
      "archive_too_many_files"
    );
  }
}

/** Extract a plugin tarball.
 *
 *  The archive is re-parsed with the same parser used for validation and the
 *  validated byte ranges are written directly, instead of shelling out to the
 *  system tar. That removes the class of bug where the validator and the
 *  extractor disagree about the archive layout (a PAX `size` record, an
 *  unusual extension header, a different tar implementation) and a member the
 *  validator never saw gets written anyway.
 *
 *  Returns the extracted package root ("package" for npm artifacts). */
export async function extractPluginArchive(archive: string, destDir: string): Promise<string> {
  mkdirSync(destDir, { recursive: true });
  const members = await readArchiveMembers(archive);
  // Re-check on the very list we are about to write: never trust an earlier
  // validation pass to describe this archive.
  assertMembersWithinCaps(members);

  const root = resolve(destDir);
  const ensureInside = (target: string): string => {
    const full = resolve(target);
    if (full !== root && !full.startsWith(root + sep)) {
      throw new PluginInstallError(
        `refusing to extract "${target}" outside the target directory`,
        "unsafe_archive_member"
      );
    }
    return full;
  };

  const stream = createReadStream(archive).pipe(createGunzip());
  const chunks: Uint8Array[] = [];
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      chunks.push(chunk);
      if (chunks.reduce((n, c) => n + c.length, 0) > PLUGIN_ARCHIVE_MAX_BYTES) {
        stream.destroy();
        throw new PluginInstallError(
          `plugin payload exceeds ${PLUGIN_ARCHIVE_MAX_BYTES} bytes uncompressed`,
          "archive_too_large"
        );
      }
    }
  } catch (e) {
    if (e instanceof PluginInstallError) throw e;
    throw new PluginInstallError(
      `failed to extract ${basename(archive)}: ${(e as Error)?.message ?? e}`,
      "extract_failed"
    );
  }
  const raw = Buffer.concat(chunks.map((c) => Buffer.from(c)));

  for (const member of members) {
    const full = ensureInside(join(destDir, member.name));
    if (member.type === "5") {
      mkdirSync(full, { recursive: true });
      continue;
    }
    if (member.type !== "0" && member.type !== "\0" && member.type !== "7") {
      // Links/specials were already rejected; anything else is metadata we
      // deliberately do not materialise.
      continue;
    }
    if (!member.name) {
      throw new PluginInstallError(
        "refusing to extract archive member with an empty name",
        "unsafe_archive_member"
      );
    }
    const end = member.dataOffset + member.size;
    if (end > raw.length) {
      throw new PluginInstallError(
        `plugin archive is truncated (member "${member.name}" data missing)`,
        "extract_failed"
      );
    }
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, raw.subarray(member.dataOffset, end), { mode: 0o644 });
  }

  // Post-extract safety: refuse any symlinked member so nothing in the
  // extracted tree can point outside the extraction root.
  assertNoSymlinks(destDir);
  const packageRoot = join(destDir, "package");
  if (existsSync(packageRoot) && statSync(packageRoot).isDirectory()) return packageRoot;
  return destDir;
}

// ---------------------------------------------------------------------------
// npm pack (never npm install, never lifecycle scripts, never user creds)
// ---------------------------------------------------------------------------

export interface NpmPackOptions {
  /** Override the registry (tests / hermetic evidence). */
  registry?: string;
  /** Isolate npm's cache from the user profile. */
  cacheDir?: string;
  /** Isolate HOME so the user's ~/.npmrc can never be read. */
  homeDir?: string;
  /** Kill a hung/offline registry after this many ms. */
  timeoutMs?: number;
}

/** Build a stripped environment for the npm child: PATH/TZ only, with a
 *  throwaway HOME, TMPDIR and empty user/global config so no registry token
 *  from the operator's profile can ever be read or sent. Proxy settings are
 *  forwarded (they may be required on corporate networks) but npm stderr —
 *  the only place they could reappear — is discarded. */
function isolatedNpmEnv(homeDir: string, cacheDir: string): NodeJS.ProcessEnv {
  const passthrough = new Set([
    "PATH", "Path", "path", "TZ", "LANG", "LC_ALL",
    "SYSTEMROOT", "COMSPEC", "APPDATA", "LOCALAPPDATA",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  ]);
  const env: NodeJS.ProcessEnv = {};
  for (const key of Object.keys(process.env)) {
    if (passthrough.has(key)) env[key] = process.env[key];
  }
  env.HOME = homeDir;
  env.USERPROFILE = homeDir;
  env.TMPDIR = homeDir;
  env.TEMP = homeDir;
  env.TMP = homeDir;
  env.CCR_CONFIG_DIR = process.env.CCR_CONFIG_DIR;
  // Empty config files: npm treats an absent/empty userconfig the same, but
  // pinning the paths guarantees the profile ones are never opened.
  const userConfig = join(homeDir, "npmrc");
  const globalConfig = join(homeDir, "npmrc-global");
  writeFileSync(userConfig, "", { mode: 0o600 });
  writeFileSync(globalConfig, "", { mode: 0o600 });
  env.npm_config_userconfig = userConfig;
  env.npm_config_globalconfig = globalConfig;
  env.npm_config_cache = cacheDir;
  return env;
}

/** Download an npm spec with npm pack (offline-first) WITHOUT running any
 *  lifecycle scripts and WITHOUT access to the operator's npm credentials,
 *  and return the packed archive path. Never uses `npm install` on the
 *  target: a pack is a pure download of the published tarball with no install
 *  scripts. npm stderr/stdout beyond the JSON line is discarded so registry
 *  URLs and config hints can never surface to callers.
 *
 *  ASYNC on purpose: the host route calls this from the Fastify event loop,
 *  and a synchronous 30s npm wait would freeze the whole CCR service (and
 *  deadlock anything trying to serve the npm child from the same process). */
export async function npmPackPlugin(spec: string, destDir: string, options: NpmPackOptions = {}): Promise<string> {
  assertSafeNpmSpec(spec);
  mkdirSync(destDir, { recursive: true });
  const homeDir = options.homeDir ?? join(destDir, "npm-home");
  const cacheDir = options.cacheDir ?? join(destDir, "npm-cache");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });
  const args = [
    "pack",
    "--json",
    "--prefer-offline",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
  ];
  if (options.registry) args.push("--registry", options.registry);
  args.push("--pack-destination", destDir, spec);
  let stdout: string;
  try {
    stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile("npm", args, {
        cwd: destDir,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: options.timeoutMs ?? PLUGIN_NPM_PACK_TIMEOUT_MS,
        // SIGTERM alone leaves a wedged npm (and any helper it spawned) alive;
        // escalate so the request is genuinely bounded.
        killSignal: "SIGKILL",
        env: isolatedNpmEnv(homeDir, cacheDir),
      }, (error: any, standardOutput: any) => {
        if (error) reject(error);
        else resolve(String(standardOutput ?? ""));
      });
      // npm never reads stdin; a closed stdin also makes prompts impossible.
      child.stdin?.end();
    });
  } catch (e: any) {
    // Never surface npm stderr: it can include registry URLs, config paths or
    // token-bearing advice. Callers only get the stable code + spec.
    if (e?.killed || e?.signal === "SIGTERM" || e?.code === "ETIMEDOUT") {
      throw new PluginInstallError(`npm pack timed out for "${spec}"`, "npm_pack_timeout");
    }
    throw new PluginInstallError(`npm pack failed for "${spec}"`, "npm_pack_failed");
  }
  let packed: Array<{ filename?: string }>;
  try {
    packed = JSON.parse(stdout);
  } catch {
    throw new PluginInstallError(`npm pack returned unexpected output for "${spec}"`, "npm_pack_failed");
  }
  const filename = packed?.[0]?.filename;
  if (!filename || filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
    throw new PluginInstallError(`npm pack produced no archive for "${spec}"`, "npm_pack_failed");
  }
  return join(destDir, filename);
}

// ---------------------------------------------------------------------------
// Staged install
// ---------------------------------------------------------------------------

function lstatSyncSafe(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Stage the payload under plugins/, validate the staged copy, then swap it
 *  into place (refusing an existing install unless force). rename() inside
 *  the same directory is atomic; the pre-swap removal window is minimized.
 *  Returns the install target path. */
export function stagePluginInstall(
  payloadDir: string,
  manifest: PluginManifest,
  configDir: string,
  force: boolean
): string {
  const pluginsDir = join(configDir, "plugins");
  mkdirSync(pluginsDir, { recursive: true });
  if (lstatSync(pluginsDir).isSymbolicLink() || !lstatSync(pluginsDir).isDirectory()) {
    throw new PluginInstallError(`plugins directory is not a real directory: ${pluginsDir}`, "unsafe_archive_member");
  }
  const target = join(pluginsDir, manifest.name);
  if (existsSync(target) && !force) {
    throw new PluginInstallError(
      `plugin "${manifest.name}" is already installed at ${target} (use --force to replace it)`,
      "already_installed"
    );
  }
  // Refuse a lossy record rewrite BEFORE staging/payload work.
  assertRecordsWritable(configDir, force);

  const stage = join(pluginsDir, `.${manifest.name}.staging-${process.pid}-${Date.now()}`);
  mkdirSync(stage, { recursive: true });
  try {
    cpSync(payloadDir, stage, { recursive: true });
    const stagedManifest = validatePluginManifest(readPluginManifest(stage), manifest.name);
    if (!existsSync(join(stage, PLUGIN_ENTRY_FILE))) {
      throw new PluginInstallError(
        `staged payload is missing its entry ${PLUGIN_ENTRY_FILE}`,
        "invalid_manifest"
      );
    }
    if (lstatSyncSafe(target)) {
      rmSync(target, { recursive: true, force: true });
    }
    renameSync(stage, target);
    upsertPluginRecord(configDir, stagedManifest.name, force);
  } catch (error) {
    // Never orphan the staging dir on a failed copy/validate.
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
  return target;
}

/** Validate an unpacked payload directory exactly the way the CLI add command
 *  does. Returns the normalized manifest. */
export function validatePayload(payloadDir: string): {
  manifest: PluginManifest;
  raw: RawPluginManifest;
} {
  const raw = readPluginManifest(payloadDir);
  const manifest = validatePluginManifest(raw);
  if (!existsSync(join(payloadDir, PLUGIN_ENTRY_FILE))) {
    throw new PluginInstallError(
      `plugin entry ${PLUGIN_ENTRY_FILE} is missing from the payload`,
      "invalid_manifest"
    );
  }
  validateCardPayload(payloadDir, raw);
  assertNoSymlinks(payloadDir);
  return { manifest, raw };
}

export interface InstallFromArchiveOptions {
  configDir: string;
  force?: boolean;
  /** Working area; a fresh mkdtemp under TMPDIR is created when omitted. */
  tempRoot?: string;
}

/** Extract + validate + stage a local tarball (CLI local .tgz and the
 *  npm-packed host lane share this). The temp area is always removed when
 *  this call owns it. */
export async function installPluginFromArchive(
  archive: string,
  options: InstallFromArchiveOptions
): Promise<{ target: string; manifest: PluginManifest }> {
  // Extract outside the lock (it can be slow), then take the lock for the
  // read-modify-write of plugins.json plus the staged directory swap.
  return withInstallLock(options.configDir, () => installPluginFromArchiveUnlocked(archive, options));
}

async function installPluginFromArchiveUnlocked(
  archive: string,
  options: InstallFromArchiveOptions
): Promise<{ target: string; manifest: PluginManifest }> {
  const temp = options.tempRoot ?? mkdtempSync(join(tmpdir(), "ccr-plugin-add-"));
  const ownsTemp = options.tempRoot === undefined;
  try {
    await assertArchiveWithinCaps(archive);
    const packageRoot = await extractPluginArchive(archive, join(temp, "extract"));
    const payloadDir = resolvePluginPayloadDir(packageRoot);
    if (!payloadDir) {
      throw new PluginInstallError(
        `no ${PLUGIN_MANIFEST_FILE} + ${PLUGIN_ENTRY_FILE} found in ${archive}`,
        "invalid_manifest"
      );
    }
    const { manifest } = validatePayload(payloadDir);
    const target = stagePluginInstall(payloadDir, manifest, options.configDir, options.force ?? false);
    return { target, manifest };
  } finally {
    if (ownsTemp) rmSync(temp, { recursive: true, force: true });
  }
}

export interface InstallFromNpmOptions extends InstallFromArchiveOptions {
  /** npm spec (allowlisted); the installed plugin name comes from plugin.json. */
  spec: string;
  registry?: string;
  cacheDir?: string;
  homeDir?: string;
  timeoutMs?: number;
}

/** Host/CLI lane: npm pack (offline-first, scripts disabled, bounded,
 *  credential-isolated) → cap/validate → staged atomic swap → upsert
 *  plugins.json. */
/** Serialise installs per config directory.
 *
 *  Every install is a read-modify-write over plugins.json plus a staged
 *  directory rename, so two overlapping requests can otherwise lose a record
 *  or have one request's cleanup delete the other's freshly staged payload.
 *  The marketplace UI makes overlapping installs easy (double click, retry
 *  while a 30s npm fetch is still running), so this is an in-process lock
 *  rather than a best-effort guard. */
const installLocks = new Map<string, Promise<void>>();

async function withInstallLock<T>(configDir: string, run: () => Promise<T>): Promise<T> {
  const key = resolve(configDir);
  const previous = installLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const tail = previous.then(() => gate);
  installLocks.set(key, tail);
  await previous;
  try {
    return await run();
  } finally {
    release();
    // Drop the entry once we are the last waiter so the map cannot grow.
    if (installLocks.get(key) === tail) installLocks.delete(key);
  }
}

export async function installPluginFromNpm(options: InstallFromNpmOptions): Promise<{
  target: string;
  manifest: PluginManifest;
}> {
  assertSafeNpmSpec(options.spec);
  const temp = options.tempRoot ?? mkdtempSync(join(tmpdir(), "ccr-plugin-add-"));
  const ownsTemp = options.tempRoot === undefined;
  try {
    const archive = await npmPackPlugin(options.spec, join(temp, "pack"), {
      registry: options.registry,
      cacheDir: options.cacheDir ?? join(temp, "npm-cache"),
      homeDir: options.homeDir ?? join(temp, "npm-home"),
      timeoutMs: options.timeoutMs,
    });
    return await installPluginFromArchive(archive, {
      configDir: options.configDir,
      force: options.force,
      tempRoot: temp,
    });
  } finally {
    if (ownsTemp) rmSync(temp, { recursive: true, force: true });
  }
}

// Removal of symlinked installs is a CLI/host responsibility; the shared
// surface re-exports the node API both callers need.
export { unlinkSync };
