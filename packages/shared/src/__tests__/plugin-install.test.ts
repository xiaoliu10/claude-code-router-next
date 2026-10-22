/**
 * Tests for the shared provider-plugin install core (src/plugin-install.ts).
 *
 * Fully hermetic: every install runs against a throwaway config/temp dir, no
 * service is started and no plugin code is executed. Archive fixtures are
 * produced two ways — the system tar (the npm artifact shape) and a tiny
 * in-test ustar writer for malicious members (symlinks, traversal,
 * truncation) that a friendly tar CLI refuses to create.
 */
import { execFileSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  NPM_SPEC_PATTERN,
  PLUGIN_ARCHIVE_MAX_BYTES,
  PLUGIN_ARCHIVE_MAX_FILES,
  PluginInstallError,
  assertArchiveWithinCaps,
  assertSafeNpmSpec,
  installPluginFromArchive,
  readPluginRecords,
  validatePluginManifest,
} from "../plugin-install";

let scratch: string;
let configDir: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "plugin-install-test-"));
  configDir = join(scratch, "config");
  mkdirSync(configDir, { recursive: true });
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

interface PayloadOpts {
  name?: string;
  version?: string;
  coreApi?: string;
  entry?: boolean;
  layout?: "root" | "dist";
  card?: string | null;
}

/** Build a plugin payload and return BOTH its package root (with a
 *  package/package.json npm shape) and the packed tgz path. */
function makePackedPlugin(
  label: string,
  opts: PayloadOpts = {}
): { root: string; archive: string } {
  const name = opts.name ?? "fixture";
  const root = join(scratch, `pkg-${label}`);
  const inner = join(root, "package", opts.layout === "root" ? "" : "dist");
  mkdirSync(inner, { recursive: true });
  writeFileSync(join(root, "package", "package.json"), JSON.stringify({
    name: `@scope/ccr-provider-${label}`,
    version: "1.0.0",
  }));
  writeFileSync(join(inner, "plugin.json"), JSON.stringify({
    name,
    version: opts.version ?? "1.0.0",
    coreApi: opts.coreApi ?? "1",
    description: "fixture plugin",
    ...(opts.card ? { card: opts.card } : {}),
  }));
  if (opts.entry !== false) {
    writeFileSync(join(inner, "plugin.js"), "export const activate = () => ({});\n");
  }
  const archive = join(scratch, `${label}.tgz`);
  execFileSync("tar", ["-czf", archive, "-C", root, "package"]);
  return { root, archive };
}

/** Minimal ustar writer (regular files, directories and symlinks) so the
 *  tests can create members the system tar refuses (traversal). */
function ustar(entries: Array<{ name: string; data?: Buffer; link?: string; type?: string }>): Buffer {
  const blocks: Buffer[] = [];
  const pad = (s: string, n: number) => {
    const b = Buffer.alloc(n, 0);
    b.write(s, 0, "utf8");
    return b;
  };
  const header = (name: string, size: number, type: string, link = ""): Buffer => {
    const h = Buffer.alloc(512, 0);
    let n = name;
    let prefix = "";
    if (n.length > 100) {
      const cut = n.lastIndexOf("/", n.length - 100);
      prefix = n.slice(0, cut);
      n = n.slice(cut + 1);
    }
    pad(n, 100).copy(h, 0);
    pad((size & 0o7777777).toString(8).padStart(11, "0") + "\0", 12).copy(h, 124);
    pad("0000000\0", 8).copy(h, 108); // mtime
    pad("        ", 8).copy(h, 136); // checksum placeholder (spaces)
    h.write(type, 156, 1, "ascii");
    pad(link, 100).copy(h, 157);
    pad("ustar\0", 6).copy(h, 257);
    pad("00", 2).copy(h, 263);
    pad(prefix, 155).copy(h, 345);
    let sum = 0;
    for (const byte of h) sum += byte;
    pad(sum.toString(8).padStart(6, "0") + "\0 ", 8).copy(h, 148);
    return h;
  };
  const dataBlock = (data: Buffer): Buffer => {
    const blocksNeeded = Math.ceil(data.length / 512);
    const b = Buffer.alloc(blocksNeeded * 512, 0);
    data.copy(b, 0);
    return b;
  };
  for (const e of entries) {
    if (e.type === "2") {
      blocks.push(header(e.name, 0, "2", e.link ?? ""));
    } else if (e.data) {
      blocks.push(header(e.name, e.data.length, "0"));
      blocks.push(dataBlock(e.data));
    } else {
      blocks.push(header(`${e.name.replace(/\/$/, "")}/`, 0, "5"));
    }
  }
  blocks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(blocks);
}

const manifest = (over: Record<string, unknown> = {}) => ({
  name: "fixture",
  version: "1.0.0",
  coreApi: "1",
  ...over,
});

// ---------------------------------------------------------------------------
// Request allowlist
// ---------------------------------------------------------------------------

describe("assertSafeNpmSpec", () => {
  it.each([
    ["ccr-provider-x"],
    ["@scope/ccr-provider-x"],
    ["a"],
    ["@a/b"],
  ])("accepts the package name %s", (spec) => {
    expect(() => assertSafeNpmSpec(spec)).not.toThrow();
  });

  it.each([
    [""],
    ["../escape"],
    ["./local"],
    ["/abs/path"],
    ["foo/bar/baz"],
    ["http://evil/x.tgz"],
    ["https://evil/x"],
    ["foo@1.2.3"],
    ["foo@latest"],
    ["-x"],
    ["foo;rm -rf /"],
    ["foo bar"],
    [42],
    [null],
    [undefined],
  ])("rejects %s", (spec) => {
    expect(() => assertSafeNpmSpec(spec)).toThrow(PluginInstallError);
    try {
      assertSafeNpmSpec(spec);
    } catch (e: any) {
      expect(e.code).toBe("invalid_spec");
    }
  });

  it("pattern source sanity", () => {
    // The contract regex verbatim: npm names may contain dots/hyphens/~
    // (e.g. "x.tgz" is a legal npm NAME); paths, URLs, @version specs and
    // leading dots/slashes never match.
    expect(NPM_SPEC_PATTERN.test("ccr-provider-x")).toBe(true);
    expect(NPM_SPEC_PATTERN.test("./x.tgz")).toBe(false);
    expect(NPM_SPEC_PATTERN.test("/tmp/x.tgz")).toBe(false);
    expect(NPM_SPEC_PATTERN.test("x@1.0.0")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Manifest validation
// ---------------------------------------------------------------------------

describe("validatePluginManifest", () => {
  it("accepts coreApi major 1 (1, 1.5) and defaults a missing coreApi to 1", () => {
    expect(validatePluginManifest(manifest()).coreApi).toBe("1");
    expect(validatePluginManifest(manifest({ coreApi: undefined })).coreApi).toBe("1");
    expect(validatePluginManifest(manifest({ coreApi: "1.9.2" })).coreApi).toBe("1.9.2");
  });

  it.each([
    ["bad name", manifest({ name: "../x" })],
    ["empty name", manifest({ name: "" })],
    ["missing version", manifest({ version: "" })],
    ["bad coreApi", manifest({ coreApi: "2" })],
    ["bad coreApi string", manifest({ coreApi: "abc" })],
  ])("rejects %s", (_label, raw) => {
    expect(() => validatePluginManifest(raw as any)).toThrow(PluginInstallError);
  });

  it("requires the manifest name to match the install directory", () => {
    expect(() => validatePluginManifest(manifest(), "other")).toThrow(/does not match/);
  });
});

// ---------------------------------------------------------------------------
// Archive caps
// ---------------------------------------------------------------------------

describe("assertArchiveWithinCaps", () => {
  it("accepts a normal npm-shaped tarball", async () => {
    const { archive } = makePackedPlugin("ok");
    await expect(assertArchiveWithinCaps(archive)).resolves.toBeUndefined();
  });

  it("rejects an archive over 25MB compressed", async () => {
    const file = join(scratch, "big.tgz");
    writeFileSync(file, Buffer.alloc(PLUGIN_ARCHIVE_MAX_BYTES + 1024, 0xff));
    await expect(assertArchiveWithinCaps(file)).rejects.toMatchObject({ code: "archive_too_large" });
  });

  it("rejects a gzip payload that unpacks over 25MB even when tiny compressed", async () => {
    const payload = ustar([
      { name: "package/plugin.json", data: Buffer.from(JSON.stringify(manifest())) },
      { name: "package/plugin.js", data: Buffer.alloc(PLUGIN_ARCHIVE_MAX_BYTES + 1024, 0x78) },
    ]);
    const file = join(scratch, "bomb.tgz");
    writeFileSync(file, gzipSync(payload));
    expect(statSize(file)).toBeLessThan(PLUGIN_ARCHIVE_MAX_BYTES);
    await expect(assertArchiveWithinCaps(file)).rejects.toMatchObject({ code: "archive_too_large" });
  });

  it("rejects payloads with more than 2000 files", async () => {
    const entries: any[] = [{ name: "package/plugin.json", data: Buffer.from(JSON.stringify(manifest())) }];
    for (let i = 0; i < PLUGIN_ARCHIVE_MAX_FILES + 1; i++) {
      entries.push({ name: `package/f/${i}.js`, data: Buffer.from(`//${i}`) });
    }
    const file = join(scratch, "many.tgz");
    writeFileSync(file, gzipSync(ustar(entries)));
    await expect(assertArchiveWithinCaps(file)).rejects.toMatchObject({ code: "archive_too_many_files" });
  }, 60_000);

  it("rejects symlink members before extraction", async () => {
    const { archive } = makePackedPlugin("link");
    // Add a symlink the npm way (system tar on macOS emits a type-2 header).
    const root = join(scratch, "pkg-link2");
    mkdirSync(join(root, "package"), { recursive: true });
    writeFileSync(join(root, "package", "plugin.json"), JSON.stringify(manifest()));
    writeFileSync(join(root, "package", "plugin.js"), "export {};\n");
    symlinkSync("../../etc/passwd", join(root, "package", "evil-link"));
    const withLink = join(scratch, "with-link.tgz");
    execFileSync("tar", ["-czf", withLink, "-C", root, "package"]);
    await expect(assertArchiveWithinCaps(withLink)).rejects.toMatchObject({ code: "unsafe_archive_member" });
    void archive;
  });

  it("rejects traversal member names even when the extractor would allow them", async () => {
    const evil = gzipSync(ustar([
      { name: "package/plugin.json", data: Buffer.from(JSON.stringify(manifest())) },
      { name: "package/plugin.js", data: Buffer.from("export {};") },
      { name: "package/../../escape.js", data: Buffer.from("pwned") },
    ]));
    const file = join(scratch, "traversal.tgz");
    writeFileSync(file, evil);
    await expect(assertArchiveWithinCaps(file)).rejects.toMatchObject({ code: "unsafe_archive_member" });
  });

  it("rejects absolute member names", async () => {
    const evil = gzipSync(ustar([
      { name: "package/plugin.json", data: Buffer.from(JSON.stringify(manifest())) },
      { name: "/tmp/ccr-evil.js", data: Buffer.from("pwned") },
    ]));
    const file = join(scratch, "absolute.tgz");
    writeFileSync(file, evil);
    await expect(assertArchiveWithinCaps(file)).rejects.toMatchObject({ code: "unsafe_archive_member" });
  });

  it("rejects a truncated archive instead of silently under-counting", async () => {
    const full = gzipSync(ustar([
      { name: "package/plugin.json", data: Buffer.from(JSON.stringify(manifest())) },
    ]));
    const file = join(scratch, "trunc.tgz");
    writeFileSync(file, full.subarray(0, Math.floor(full.length / 2)));
    await expect(assertArchiveWithinCaps(file)).rejects.toThrow(PluginInstallError);
  });
});

function statSize(p: string): number {
  return statSync(p).size;
}

// ---------------------------------------------------------------------------
// End-to-end install from an archive
// ---------------------------------------------------------------------------

describe("installPluginFromArchive", () => {
  it("installs a packed npm tarball into the exact CLI layout", async () => {
    const { archive } = makePackedPlugin("good");
    const { target, manifest: m } = await installPluginFromArchive(archive, { configDir });

    expect(m.name).toBe("fixture"); // installed name comes from plugin.json, not the npm package
    expect(target.replace(/\\/g, "/")).toContain("/plugins/fixture");
    expect(existsSync(join(target, "plugin.json"))).toBe(true);
    expect(existsSync(join(target, "plugin.js"))).toBe(true);
    expect(readPluginRecords(configDir)).toEqual([{ name: "fixture", enabled: true }]);
    // No staging leftovers.
    expect(readdirSync(join(configDir, "plugins")).filter((n) => n.includes("staging"))).toEqual([]);
  });

  it("refuses an existing install without force and replaces with force", async () => {
    const v1 = makePackedPlugin("v1", { version: "1.0.0" }).archive;
    const v2 = makePackedPlugin("v2", { version: "2.0.0" }).archive;
    await installPluginFromArchive(v1, { configDir });
    await expect(installPluginFromArchive(v2, { configDir })).rejects.toMatchObject({
      code: "already_installed",
    });
    expect(JSON.parse(readFileSync(join(configDir, "plugins/fixture/plugin.json"), "utf8")).version).toBe("1.0.0");
    await installPluginFromArchive(v2, { configDir, force: true });
    expect(JSON.parse(readFileSync(join(configDir, "plugins/fixture/plugin.json"), "utf8")).version).toBe("2.0.0");
  });

  it("rejects missing entry, bad name and bad coreApi payloads", async () => {
    for (const [label, opts] of [
      ["noentry", { entry: false }],
      ["badname", { name: "../nope" }],
      ["badapi", { coreApi: "2" }],
    ] as const) {
      const { archive } = makePackedPlugin(label, opts as PayloadOpts);
      await expect(installPluginFromArchive(archive, { configDir })).rejects.toThrow(PluginInstallError);
      expect(existsSync(join(configDir, "plugins"))).toBe(false);
    }
  });

  it("rejects a declared card file that is missing", async () => {
    const { archive } = makePackedPlugin("card-missing", { card: "card.js" });
    await expect(installPluginFromArchive(archive, { configDir })).rejects.toThrow(/declares UI card/);
    expect(existsSync(join(configDir, "plugins/fixture"))).toBe(false);
  });

  it("never rewrites a corrupted plugins.json (409-shaped error); force replaces it", async () => {
    const pluginsDir = join(configDir, "plugins");
    mkdirSync(pluginsDir, { recursive: true });
    const original = "{{{nope";
    writeFileSync(join(pluginsDir, "plugins.json"), original);
    const { archive } = makePackedPlugin("corrupt");

    await expect(installPluginFromArchive(archive, { configDir })).rejects.toMatchObject({
      code: "plugins_json_corrupted",
    });
    expect(readFileSync(join(pluginsDir, "plugins.json"), "utf8")).toBe(original);
    expect(existsSync(join(pluginsDir, "fixture"))).toBe(false);

    await installPluginFromArchive(archive, { configDir, force: true });
    expect(readPluginRecords(configDir)).toEqual([{ name: "fixture", enabled: true }]);
  });

  it("reinstall re-enables a disabled record and preserves sibling order", async () => {
    const pluginsDir = join(configDir, "plugins");
    mkdirSync(pluginsDir, { recursive: true });
    writeFileSync(join(pluginsDir, "plugins.json"), JSON.stringify([
      { name: "alpha", enabled: true },
      { name: "fixture", enabled: false },
    ]));
    const { archive } = makePackedPlugin("reenable");
    await installPluginFromArchive(archive, { configDir, force: true });
    expect(readPluginRecords(configDir)).toEqual([
      { name: "alpha", enabled: true },
      { name: "fixture", enabled: true },
    ]);
  });

  it("leaves credential files outside plugins/ untouched", async () => {
    const credentials = join(configDir, "workbuddy-credentials.json");
    const secret = JSON.stringify({ token: "do-not-read-or-print" });
    writeFileSync(credentials, secret, { mode: 0o600 });
    const { archive } = makePackedPlugin("cred");
    await installPluginFromArchive(archive, { configDir });
    expect(readFileSync(credentials, "utf8")).toBe(secret);
  });

  it("does not create anything outside the config dir for a rejected archive", async () => {
    const evil = gzipSync(ustar([
      { name: "package/plugin.json", data: Buffer.from(JSON.stringify(manifest({ name: "bad/name" }))) },
      { name: "package/plugin.js", data: Buffer.from("export {};") },
      { name: "package/../../escape.js", data: Buffer.from("x") },
    ]));
    const file = join(scratch, "evil.tgz");
    writeFileSync(file, evil);
    await expect(installPluginFromArchive(file, { configDir })).rejects.toThrow(PluginInstallError);
    expect(existsSync(join(configDir, "plugins"))).toBe(false);
    expect(existsSync(join(scratch, "escape.js"))).toBe(false);
  });
});
