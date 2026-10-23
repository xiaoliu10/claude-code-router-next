/**
 * Tests for the `ccr plugin` command (packages/cli/src/utils/pluginCommand.ts).
 *
 * Every test runs against its own throwaway config dir (pinned under the
 * vitest-sandboxed TMPDIR) — the real profile is never touched. No test
 * starts a service, hits the network or executes plugin code.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  handlePluginCommand,
  validatePluginManifest,
} from "../utils/pluginCommand";

let scratch: string;
let configDir: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "plugin-cli-test-"));
  configDir = join(scratch, "config");
  mkdirSync(configDir, { recursive: true });
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(scratch, { recursive: true, force: true });
});

const output = (): string =>
  [...logSpy.mock.calls, ...errSpy.mock.calls].map((c) => c.join(" ")).join("\n");

/** An instantly-ending stream carrying `content` — confirmation prompts see
 *  exactly this input and EOF right after ("" → declined). */
function stdinFrom(content: string): Readable {
  const r = new Readable();
  r.push(content);
  r.push(null);
  return r;
}
const nullSink = (): Writable => new Writable({ write: (_c, _e, cb) => cb() });

const records = (): Array<{ name: string; enabled: boolean }> =>
  JSON.parse(readFileSync(join(configDir, "plugins", "plugins.json"), "utf8"));

/** Minimal installable plugin payload. */
function makePayload(
  dir: string,
  opts: {
    name?: string;
    version?: string;
    coreApi?: string;
    entry?: boolean;
    card?: boolean;
    layout?: "root" | "dist";
  } = {}
): string {
  const name = opts.name ?? "acme";
  const payloadDir = opts.layout === "dist" ? join(dir, "dist") : dir;
  mkdirSync(payloadDir, { recursive: true });
  writeFileSync(
    join(payloadDir, "plugin.json"),
    JSON.stringify({
      ...(opts.name === undefined ? {} : { name: opts.name }),
      name,
      version: opts.version ?? "1.0.0",
      coreApi: opts.coreApi ?? "1",
      description: "fixture",
    })
  );
  if (opts.entry !== false) writeFileSync(join(payloadDir, "plugin.js"), "export const activate = () => ({});\n");
  if (opts.card) writeFileSync(join(payloadDir, "card.js"), "export const mount = () => {};\n");
  return dir;
}

// ---------------------------------------------------------------------------
// add — happy path
// ---------------------------------------------------------------------------

it("add from a local payload dir: copies files, writes the record, validates the manifest", async () => {
  const payload = makePayload(join(scratch, "acme-payload"), { name: "acme", card: true });
  const code = await handlePluginCommand(["add", payload, "--yes"], { configDir });

  expect(code).toBe(0);
  const installed = join(configDir, "plugins", "acme");
  expect(existsSync(join(installed, "plugin.js"))).toBe(true);
  expect(existsSync(join(installed, "card.js"))).toBe(true);
  expect(existsSync(join(installed, "plugin.json"))).toBe(true);
  expect(records()).toEqual([{ name: "acme", enabled: true }]);
  expect(output()).toContain("acme@1.0.0");
  expect(output()).toContain("restart");
});

it("add from a package root resolves the built dist/ payload", async () => {
  const pkg = makePayload(join(scratch, "acme-pkg"), { name: "acme", layout: "dist" });
  const code = await handlePluginCommand(["add", pkg, "--yes"], { configDir });

  expect(code).toBe(0);
  expect(existsSync(join(configDir, "plugins", "acme", "plugin.js"))).toBe(true);
});

it("add preserves the order of other records and replaces in place", async () => {
  const pluginsDir = join(configDir, "plugins");
  mkdirSync(pluginsDir, { recursive: true });
  writeFileSync(join(pluginsDir, "plugins.json"), JSON.stringify([
    { name: "alpha", enabled: false },
    { name: "acme", enabled: false },
    { name: "zeta", enabled: true },
  ]));
  const payload = makePayload(join(scratch, "acme-payload"), { name: "acme" });

  const code = await handlePluginCommand(["add", payload, "--yes", "--force"], { configDir });

  expect(code).toBe(0);
  expect(records()).toEqual([
    { name: "alpha", enabled: false },
    { name: "acme", enabled: true },
    { name: "zeta", enabled: true },
  ]);
});

it("add from a pre-seeded npm-layout tgz (package/dist payload) via tar", async () => {
  const pkgRoot = join(scratch, "tgz-src");
  makePayload(pkgRoot, { name: "tgzplug", layout: "dist" });
  mkdirSync(join(pkgRoot, "package"), { recursive: true });
  // Move dist under a package/ prefix like npm artifacts, plus a package.json.
  execFileSync("mv", [join(pkgRoot, "dist"), join(pkgRoot, "package", "dist")]);
  writeFileSync(join(pkgRoot, "package", "package.json"), JSON.stringify({ name: "ccr-provider-tgzplug", version: "1.0.0" }));
  const archive = join(scratch, "ccr-provider-tgzplug-1.0.0.tgz");
  execFileSync("tar", ["-czf", archive, "-C", pkgRoot, "package"]);

  const code = await handlePluginCommand(["add", archive, "--yes"], { configDir });

  expect(code).toBe(0);
  expect(existsSync(join(configDir, "plugins", "tgzplug", "plugin.js"))).toBe(true);
  expect(existsSync(join(configDir, "plugins", "tgzplug", "card.js"))).toBe(false);
  expect(records()).toEqual([{ name: "tgzplug", enabled: true }]);
});

it("add from an npm spec records the npm source on the plugin record", async () => {
  const pkgRoot = join(scratch, "npm-src");
  makePayload(pkgRoot, { name: "npmplug", layout: "dist" });
  mkdirSync(join(pkgRoot, "package"), { recursive: true });
  execFileSync("mv", [join(pkgRoot, "dist"), join(pkgRoot, "package", "dist")]);
  writeFileSync(join(pkgRoot, "package", "package.json"), JSON.stringify({ name: "@wengine-ai/ccr-provider-npmplug", version: "1.0.0" }));
  const archive = join(scratch, "wengine-ai-ccr-provider-npmplug-1.0.0.tgz");
  execFileSync("tar", ["-czf", archive, "-C", pkgRoot, "package"]);

  // The npm executor is stubbed (a pre-packed tarball plays the registry);
  // the lane under test is the real one: npmSpec → record `source`, which the
  // dashboard catalog uses to hide installed entries.
  const seen: string[] = [];
  const code = await handlePluginCommand(["add", "@wengine-ai/ccr-provider-npmplug", "--yes"], {
    configDir,
    npmPackImpl: (spec, destDir) => { seen.push(spec); mkdirSync(destDir, { recursive: true }); return archive; },
  });

  expect(code).toBe(0);
  expect(seen).toEqual(["@wengine-ai/ccr-provider-npmplug"]);
  expect(existsSync(join(configDir, "plugins", "npmplug", "plugin.js"))).toBe(true);
  expect(records()).toEqual([{ name: "npmplug", enabled: true, source: "@wengine-ai/ccr-provider-npmplug" }]);
});

// ---------------------------------------------------------------------------
// add — rejections
// ---------------------------------------------------------------------------

it("add rejects a manifest whose declared card file is missing", async () => {
  const payload = makePayload(join(scratch, "acme-payload"), { name: "acme" });
  // Rewrite the manifest to declare a card that does not exist.
  const payloadDir = join(payload);
  writeFileSync(
    join(payloadDir, "plugin.json"),
    JSON.stringify({ name: "acme", version: "1.0.0", coreApi: "1", card: "card.js" })
  );

  const code = await handlePluginCommand(["add", payload, "--yes"], { configDir });

  expect(code).toBe(1);
  expect(output()).toContain("declares UI card");
  expect(existsSync(join(configDir, "plugins", "acme"))).toBe(false);
});

it("add rejects a manifest that declares a traversing card path", async () => {
  const payload = makePayload(join(scratch, "acme-payload"), { name: "acme" });
  writeFileSync(
    join(payload, "plugin.json"),
    JSON.stringify({ name: "acme", version: "1.0.0", coreApi: "1", card: "../outside.js" })
  );
  writeFileSync(join(scratch, "outside.js"), "export {};\n");

  const code = await handlePluginCommand(["add", payload, "--yes"], { configDir });

  expect(code).toBe(1);
  expect(output()).toContain("unsafe UI card path");
  expect(existsSync(join(configDir, "plugins", "acme"))).toBe(false);
});

it("add preserves hand-written records that omit enabled", async () => {
  const pluginsDir = join(configDir, "plugins");
  mkdirSync(pluginsDir, { recursive: true });
  writeFileSync(join(pluginsDir, "plugins.json"), JSON.stringify([{ name: "manual" }]));
  const payload = makePayload(join(scratch, "acme-payload"), { name: "acme" });

  const code = await handlePluginCommand(["add", payload, "--yes"], { configDir });

  expect(code).toBe(0);
  // The loader treats enabled !== false as enabled; the rewrite must keep the
  // hand-written record (normalized), not silently drop it.
  expect(records()).toEqual([
    { name: "manual", enabled: true },
    { name: "acme", enabled: true },
  ]);
});

it("add refuses to silently rewrite a corrupted plugins.json", async () => {
  const pluginsDir = join(configDir, "plugins");
  mkdirSync(pluginsDir, { recursive: true });
  const original = "{{{CORRUPTED";
  writeFileSync(join(pluginsDir, "plugins.json"), original);
  const payload = makePayload(join(scratch, "acme-payload"), { name: "acme" });

  const code = await handlePluginCommand(["add", payload, "--yes"], { configDir });

  expect(code).toBe(1);
  expect(output()).toContain("not valid JSON");
  // The unparseable file is left untouched for manual repair.
  expect(readFileSync(join(pluginsDir, "plugins.json"), "utf8")).toBe(original);
  expect(existsSync(join(pluginsDir, "acme"))).toBe(false);

  // --force is the explicit escape hatch: replace the file (losing the
  // unreadable content is then the user's informed choice).
  const forced = await handlePluginCommand(["add", payload, "--yes", "--force"], { configDir });
  expect(forced).toBe(0);
  expect(records()).toEqual([{ name: "acme", enabled: true }]);
});

it("add rejects an existing install without --force and replaces with it", async () => {
  const payloadV1 = makePayload(join(scratch, "v1"), { name: "acme", version: "1.0.0" });
  const payloadV2 = makePayload(join(scratch, "v2"), { name: "acme", version: "2.0.0" });

  expect(await handlePluginCommand(["add", payloadV1, "--yes"], { configDir })).toBe(0);
  expect(await handlePluginCommand(["add", payloadV2, "--yes"], { configDir })).toBe(1);
  expect(output()).toContain("already installed");
  expect(output()).toContain("--force");
  // v1 must remain untouched after the refused install.
  expect(JSON.parse(readFileSync(join(configDir, "plugins", "acme", "plugin.json"), "utf8")).version).toBe("1.0.0");

  expect(await handlePluginCommand(["add", payloadV2, "--yes", "--force"], { configDir })).toBe(0);
  expect(JSON.parse(readFileSync(join(configDir, "plugins", "acme", "plugin.json"), "utf8")).version).toBe("2.0.0");
  // No staging leftovers.
  const leftovers = readdirSync(join(configDir, "plugins")).filter((n) => n.includes("staging"));
  expect(leftovers).toEqual([]);
});

it("add cleans up its staging dir when the copy fails", async () => {
  const payload = makePayload(join(scratch, "acme-payload"), { name: "acme" });
  // Simulate a mid-copy failure without chmod games: point the add at a
  // payload that disappears between validation and copy is impossible to
  // orchestrate from here, so instead corrupt the source AFTER a first add
  // succeeded — force-replace against a payload dir that becomes unreadable
  // is flaky across environments; the deterministic equivalent is a payload
  // whose plugin.js vanishes when handlePluginCommand re-reads the STAGED
  // copy... which the staging cleanup covers by construction. So drive the
  // failure through an unreadable source file (EACCES) with a root-skip.
  if (process.getuid?.() === 0) return; // chmod 000 is ineffective for root
  writeFileSync(join(payload, "secret.bin"), "x");
  const mode = 0o000;
  const target = join(payload, "secret.bin");
  const { chmodSync } = await import("node:fs");
  chmodSync(target, mode);
  try {
    const code = await handlePluginCommand(["add", payload, "--yes"], { configDir });
    expect(code).toBe(1);
    const leftovers = readdirSync(join(configDir, "plugins")).filter((n) => n.includes("staging"));
    expect(leftovers).toEqual([]);
    expect(existsSync(join(configDir, "plugins", "acme"))).toBe(false);
  } finally {
    chmodSync(target, 0o644);
  }
});

it("add rejects bad coreApi", async () => {
  const payload = makePayload(join(scratch, "p"), { name: "acme", coreApi: "2" });
  const code = await handlePluginCommand(["add", payload, "--yes"], { configDir });
  expect(code).toBe(1);
  expect(output()).toContain("coreApi");
  expect(existsSync(join(configDir, "plugins", "acme"))).toBe(false);
});

it("add rejects a payload without the plugin.js entry", async () => {
  const payload = makePayload(join(scratch, "p"), { name: "acme", entry: false });
  const code = await handlePluginCommand(["add", payload, "--yes"], { configDir });
  expect(code).toBe(1);
  expect(output()).toContain("plugin.js");
  expect(existsSync(join(configDir, "plugins", "acme"))).toBe(false);
});

it("add rejects unsafe manifest names via the name pattern", async () => {
  for (const bad of ["..", "../escape", "/absolute", "has/slash", "has space"]) {
    const payload = makePayload(join(scratch, `p-${bad.replace(/\W/g, "_")}`), { name: bad });
    const code = await handlePluginCommand(["add", payload, "--yes"], { configDir });
    expect(code).toBe(1);
    expect(output()).toContain("invalid plugin name");
    // Nothing may be created outside plugins/<valid-name>/.
    expect(existsSync(join(configDir, "plugins"))).toBe(false);
  }
});

it("validatePluginManifest enforces name == install directory name", () => {
  expect(() => validatePluginManifest({ name: "acme", version: "1.0.0", coreApi: "1" }, "other"))
    .toThrow(/does not match install directory name/);
  expect(validatePluginManifest({ name: "acme", version: "1.0.0", coreApi: "1" }, "acme").name).toBe("acme");
});

it("add rejects a missing source and a non-plugin directory", async () => {
  expect(await handlePluginCommand(["add", join(scratch, "nope"), "--yes"], { configDir })).toBe(1);
  expect(await handlePluginCommand(["add", scratch, "--yes"], { configDir })).toBe(1);
  expect(await handlePluginCommand(["add"], { configDir })).toBe(1);
  expect(existsSync(join(configDir, "plugins"))).toBe(false);
});

// ---------------------------------------------------------------------------
// remove — never touches credentials
// ---------------------------------------------------------------------------

it("remove deletes the plugin dir and record but keeps the credentials file", async () => {
  const payload = makePayload(join(scratch, "acme-payload"), { name: "acme" });
  await handlePluginCommand(["add", payload, "--yes"], { configDir });
  const credentials = join(configDir, "workbuddy-credentials.json");
  writeFileSync(credentials, JSON.stringify({ secret: "do-not-touch" }), { mode: 0o600 });

  const code = await handlePluginCommand(["remove", "acme", "--yes"], { configDir });

  expect(code).toBe(0);
  expect(existsSync(join(configDir, "plugins", "acme"))).toBe(false);
  expect(records()).toEqual([]);
  expect(readFileSync(credentials, "utf8")).toContain("do-not-touch");
});

it("remove without --yes declines on EOF stdin and keeps the plugin", async () => {
  const payload = makePayload(join(scratch, "acme-payload"), { name: "acme" });
  await handlePluginCommand(["add", payload, "--yes"], { configDir });

  const code = await handlePluginCommand(["remove", "acme"], {
    configDir,
    input: stdinFrom(""),
    output: nullSink(),
  });

  expect(code).toBe(0);
  expect(existsSync(join(configDir, "plugins", "acme"))).toBe(true);
  expect(output()).toContain("aborted");
});

it("remove without --yes accepts a piped y answer and removes", async () => {
  const payload = makePayload(join(scratch, "acme-payload"), { name: "acme" });
  await handlePluginCommand(["add", payload, "--yes"], { configDir });

  const code = await handlePluginCommand(["remove", "acme"], {
    configDir,
    input: stdinFrom("y\n"),
    output: nullSink(),
  });

  expect(code).toBe(0);
  expect(existsSync(join(configDir, "plugins", "acme"))).toBe(false);
  expect(records()).toEqual([]);
});

it("remove errors for unknown and invalid names", async () => {
  expect(await handlePluginCommand(["remove", "ghost"], { configDir })).toBe(1);
  expect(output()).toContain("not installed");
  expect(await handlePluginCommand(["remove", "../escape"], { configDir })).toBe(1);
  expect(await handlePluginCommand(["remove"], { configDir })).toBe(1);
});

// ---------------------------------------------------------------------------
// enable / disable
// ---------------------------------------------------------------------------

it("enable and disable flip the record in place", async () => {
  const payload = makePayload(join(scratch, "acme-payload"), { name: "acme" });
  await handlePluginCommand(["add", payload, "--yes"], { configDir });

  expect(await handlePluginCommand(["disable", "acme"], { configDir })).toBe(0);
  expect(records()).toEqual([{ name: "acme", enabled: false }]);
  expect(await handlePluginCommand(["enable", "acme"], { configDir })).toBe(0);
  expect(records()).toEqual([{ name: "acme", enabled: true }]);
  expect(output()).toContain("restart");
});

it("enable/disable error with an actionable hint for unregistered plugins", async () => {
  expect(await handlePluginCommand(["disable", "ghost"], { configDir })).toBe(1);
  expect(output()).toContain("ccr plugin add");
  expect(await handlePluginCommand(["enable", "ghost"], { configDir })).toBe(1);
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

it("list shows disk-only status with a note when the service is unreachable", async () => {
  const payload = makePayload(join(scratch, "acme-payload"), { name: "acme", version: "3.1.0" });
  await handlePluginCommand(["add", payload, "--yes"], { configDir });
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("connection refused");
  }));

  const code = await handlePluginCommand(["list"], { configDir });

  expect(code).toBe(0);
  expect(output()).toContain("acme");
  expect(output()).toContain("3.1.0");
  expect(output()).toContain("yes");
  expect(output()).toContain("service not reachable");
});

it("list combines the running service's loader view and prints unregistered dirs", async () => {
  const payload = makePayload(join(scratch, "acme-payload"), { name: "acme", version: "3.1.0" });
  await handlePluginCommand(["add", payload, "--yes"], { configDir });
  // A stray unregistered directory on disk.
  mkdirSync(join(configDir, "plugins", "stray"), { recursive: true });
  writeFileSync(join(configDir, "plugins", "stray", "plugin.json"), JSON.stringify({ name: "stray", version: "0.9.0" }));
  writeFileSync(join(configDir, "plugins", "stray", "plugin.js"), "export {};\n");
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    json: async () => ({
      plugins: [
        { name: "acme", version: "3.1.0", enabled: true },
        { name: "ghost", version: null, enabled: true, error: "plugin missing or failed to load" },
      ],
    }),
  })));

  const code = await handlePluginCommand(["list"], { configDir });

  expect(code).toBe(0);
  expect(output()).toContain("loaded");
  expect(output()).toContain("unregistered (not in plugins.json)");
  // Only names present on disk are resolved against the service — the live
  // service's unrelated entries must never be printed.
  expect(output()).not.toContain("ghost");
  // No credential material in output.
  expect(output()).not.toContain("secret");
});

it("list on an empty config prints a hint instead of a table", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("connection refused");
  }));
  const code = await handlePluginCommand(["list"], { configDir });
  expect(code).toBe(0);
  expect(output()).toContain("None installed");
  expect(output()).toContain("ccr plugin add");
});

// ---------------------------------------------------------------------------
// usage / unknown subcommands
// ---------------------------------------------------------------------------

it("unknown or missing subcommand prints usage and exits 1", async () => {
  expect(await handlePluginCommand([], { configDir })).toBe(1);
  expect(output()).toContain("Usage: ccr plugin");
  expect(await handlePluginCommand(["frobnicate"], { configDir })).toBe(1);
  expect(output()).toContain("unknown plugin subcommand");
});
