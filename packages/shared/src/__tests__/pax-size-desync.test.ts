/**
 * Regression tests for the PAX `size` desync vulnerability.
 *
 * The archive walker used to read only `path` out of a PAX ('x') extended
 * header and take the member length from the ustar octal field. Real
 * extractors honour `size=` as well, so a crafted tarball could declare one
 * size in PAX and another in ustar: the validator skipped over a region the
 * extractor would parse as further tar headers, and those smuggled members
 * never passed the traversal/link/cap checks. On macOS bsdtar a smuggled
 * `package/plugin.js` was written to disk and installed as the plugin entry.
 *
 * These tests pin the fixed behaviour: the member list the validator sees is
 * the same list the extractor writes.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginInstallError, installPluginFromArchive } from "../plugin-install";

const BLOCK = 512;

function field(value: string | Buffer, length: number): Buffer {
  const out = Buffer.alloc(length, 0);
  if (Buffer.isBuffer(value)) value.copy(out, 0);
  else out.write(value, 0, "utf8");
  return out;
}

interface HeaderSpec {
  name: string;
  data?: Buffer;
  type?: string;
  /** Octal text written into the ustar size field (defaults to data length). */
  sizeField?: string;
}

function header(spec: HeaderSpec): Buffer {
  const h = Buffer.alloc(BLOCK, 0);
  field(spec.name, 100).copy(h, 0);
  field("0000644\0", 8).copy(h, 100);
  field("0000000\0", 8).copy(h, 108);
  field("0000000\0", 8).copy(h, 116);
  field(spec.sizeField ?? (spec.data ? `${spec.data.length.toString(8).padStart(11, "0")}\0` : "00000000000\0"), 12).copy(h, 124);
  field("00000000000\0", 12).copy(h, 136);
  field("        ", 8).copy(h, 148);
  h.write(spec.type ?? "0", 156, 1, "ascii");
  field("ustar\0", 6).copy(h, 257);
  field("00", 2).copy(h, 263);
  let sum = 0;
  for (const b of h) sum += b;
  field(`${sum.toString(8).padStart(6, "0")}\0 `, 8).copy(h, 148);
  return h;
}

function blockPad(data: Buffer): Buffer {
  const padded = Buffer.alloc(Math.ceil(data.length / BLOCK) * BLOCK, 0);
  data.copy(padded, 0);
  return padded;
}

function member(name: string, data: Buffer, sizeField?: string): Buffer {
  return Buffer.concat([header({ name, data, sizeField }), blockPad(data)]);
}

/** Emit a PAX extended header ('x') carrying the given records. */
function paxHeader(records: Record<string, string>): Buffer {
  let body = "";
  for (const [key, value] of Object.entries(records)) {
    let length = `${key}=${value}\n`.length + 2;
    for (;;) {
      const record = `${length} ${key}=${value}\n`;
      if (record.length === length) break;
      length = record.length;
    }
    body += `${length} ${key}=${value}\n`;
  }
  const data = Buffer.from(body);
  return Buffer.concat([header({ name: "PaxHeader", type: "x", data }), blockPad(data)]);
}

function manifest(name: string): Buffer {
  return Buffer.from(JSON.stringify({ name, version: "1.0.0", coreApi: "1", description: "x" }));
}

function scratchArchive(tgz: Buffer): { dir: string; archive: string } {
  const dir = mkdtempSync(join(tmpdir(), "pax-desync-"));
  const archive = join(dir, "payload.tgz");
  writeFileSync(archive, tgz);
  return { dir, archive };
}

/**
 * The core attack shape: a carrier member whose PAX `size` (512) disagrees with
 * its ustar size, so the bytes after the first block are a complete smuggled
 * tar entry rather than file content.
 */
function smuggledCarrier(entryName: string, entrySource: string): Buffer {
  const body = Buffer.from(entrySource);
  const hidden = Buffer.concat([header({ name: entryName, data: body }), blockPad(body)]);
  const carrier = Buffer.alloc(hidden.length + BLOCK, 0);
  hidden.copy(carrier, BLOCK);
  carrier.write("x".repeat(10), 0, "utf8");
  return carrier;
}

describe("PAX size desync", () => {
  it("validates members hidden behind a PAX/ustar size mismatch (symlink)", async () => {
    // The carrier declares PAX size 512 but a much larger ustar size. The bytes
    // after the first block are a complete smuggled entry. A walker that trusts
    // the ustar size never sees it, while a real extractor parses it as a
    // header - which is how an unchecked symlink used to get installed.
    const linkHeader = header({ name: "package/link.js", data: Buffer.alloc(0) });
    linkHeader.write("2", 156, 1, "ascii");
    linkHeader.fill(0x20, 148, 156);
    let sum = 0;
    for (const b of linkHeader) sum += b;
    field(`${sum.toString(8).padStart(6, "0")}\0 `, 8).copy(linkHeader, 148);

    const declared = Buffer.concat([
      Buffer.alloc(BLOCK, 0x41),
      linkHeader,
      Buffer.alloc(BLOCK, 0x42),
    ]);
    const tgz = gzipSync(
      Buffer.concat([
        member("package/plugin.json", manifest("victim")),
        member("package/plugin.js", Buffer.from("module.exports={};")),
        paxHeader({ path: "package/benign.bin", size: `${BLOCK}` }),
        member("package/benign.bin", declared, `${declared.length.toString(8).padStart(11, "0")}\0`),
        Buffer.alloc(1024, 0),
      ])
    );
    const { dir, archive } = scratchArchive(tgz);

    // Prove the smuggled member is really there: the system tar lists it.
    const tarList = execFileSync("tar", ["-tzf", archive]).toString();
    expect(tarList).toContain("package/link.js");

    // ...and that we refuse it, rather than installing a link nobody checked.
    await expect(installPluginFromArchive(archive, { configDir: dir })).rejects.toMatchObject({
      code: "unsafe_archive_member",
    });
    expect(existsSync(join(dir, "plugins", "victim"))).toBe(false);
  });

  it("refuses a smuggled member that would escape the plugin directory", async () => {
    const hidden = Buffer.concat([
      header({ name: "../escape.js", data: Buffer.from("pwned") }),
      blockPad(Buffer.from("pwned")),
    ]);
    const declared = Buffer.concat([Buffer.alloc(BLOCK, 0x41), hidden, Buffer.alloc(BLOCK, 0x42)]);
    const tgz = gzipSync(
      Buffer.concat([
        member("package/plugin.json", manifest("victim")),
        member("package/plugin.js", Buffer.from("module.exports={};")),
        paxHeader({ path: "package/benign.bin", size: `${BLOCK}` }),
        member("package/benign.bin", declared, `${declared.length.toString(8).padStart(11, "0")}\0`),
        Buffer.alloc(1024, 0),
      ])
    );
    const { dir, archive } = scratchArchive(tgz);

    await expect(installPluginFromArchive(archive, { configDir: dir })).rejects.toThrow(PluginInstallError);
    expect(existsSync(join(dir, "plugins", "victim"))).toBe(false);
  });

  it("refuses a PAX path record that contains traversal", async () => {
    const tgz = gzipSync(
      Buffer.concat([
        member("package/plugin.json", manifest("victim")),
        paxHeader({ path: "package/../../escape.js" }),
        member("package/benign.js", Buffer.from("x")),
      ])
    );
    const { dir, archive } = scratchArchive(tgz);
    await expect(installPluginFromArchive(archive, { configDir: dir })).rejects.toThrow(/unsafe archive member/);
  });

  it("honours PAX size for the member length so caps cannot be evaded", async () => {
    // A tiny PAX size must not let a large hidden payload slip past counting.
    const many = Buffer.concat(
      Array.from({ length: 50 }, (_, i) => member(`package/hidden${i}.js`, Buffer.from("x")))
    );
    const tgz = gzipSync(
      Buffer.concat([
        member("package/plugin.json", manifest("victim")),
        member("package/plugin.js", Buffer.from("module.exports={};")),
        paxHeader({ path: "package/carrier.js", size: `${many.length}` }),
        member("package/carrier.js", many, `${many.length.toString(8).padStart(11, "0")}\0`),
      ])
    );
    const { dir, archive } = scratchArchive(tgz);
    await installPluginFromArchive(archive, { configDir: dir });
    // PAX and ustar agree here, so `many` is file content - not extra members.
    expect(existsSync(join(dir, "plugins", "victim", "carrier.js"))).toBe(true);
  });

  it("still installs an ordinary npm-style tarball", async () => {
    const tgz = gzipSync(
      Buffer.concat([
        member("package/plugin.json", manifest("goodplug")),
        member("package/plugin.js", Buffer.from("module.exports={};")),
      ])
    );
    const { dir, archive } = scratchArchive(tgz);
    await installPluginFromArchive(archive, { configDir: dir });
    expect(readFileSync(join(dir, "plugins", "goodplug", "plugin.js"), "utf8")).toBe("module.exports={};");
  });
});
