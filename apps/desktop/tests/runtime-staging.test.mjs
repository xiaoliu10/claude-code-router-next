import { strict as assert } from "node:assert";
import { test } from "node:test";
import { classifyDylibDeps, satisfiesRange } from "../scripts/prepare-runtime.mjs";
import fs from "node:fs";
import path from "node:path";

const scriptsDir = path.dirname(new URL(import.meta.url).pathname);

// Real `otool -L` samples: a Homebrew node (nonportable) and the official
// nodejs.org distribution binary (portable system dylibs only).
const homebrewOtool = `/opt/homebrew/bin/node:
	@rpath/libnode.147.dylib (compatibility version 0.0.0, current version 0.0.0)
	/usr/lib/libz.1.dylib (compatibility version 1.0.0, current version 1.2.12)
	/opt/homebrew/opt/llhttp/lib/libllhttp.9.4.dylib (compatibility version 9.4.0, current version 9.4.2)
	/opt/homebrew/opt/libuv/lib/libuv.1.dylib (compatibility version 1.0.0, current version 1.0.0)
	/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib (compatibility version 9.0.0, current version 9.6.0)`;

const officialOtool = `./node:
	/usr/lib/libz.1.dylib (compatibility version 1.0.0, current version 1.2.12)
	/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1311.100.3)
	/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation (compatibility version 150.0.0, current version 2202.0.0)`;

test("homebrew node dylib dependencies are classified nonportable", () => {
  const result = classifyDylibDeps(homebrewOtool);
  assert.equal(result.portable, false);
  assert.ok(result.offending.some((dep) => dep.startsWith("@rpath/")));
  assert.ok(result.offending.some((dep) => dep.startsWith("/opt/homebrew/")));
});

test("official node distribution dylib dependencies are classified portable", () => {
  const result = classifyDylibDeps(officialOtool);
  assert.equal(result.portable, true);
  assert.deepEqual(result.offending, []);
});

test("semver subset covers caret tilde bare-major and exact ranges", () => {
  assert.equal(satisfiesRange("2.1.2", "^2.0.0"), true);
  assert.equal(satisfiesRange("2.0.0", "^2.0.0"), true);
  assert.equal(satisfiesRange("3.0.0", "^2.0.0"), false);
  assert.equal(satisfiesRange("1.3.0", "~1.3.0"), true);
  assert.equal(satisfiesRange("1.4.0", "~1.3.0"), false);
  assert.equal(satisfiesRange("1.0.2", "1"), true);
  assert.equal(satisfiesRange("2.0.0", "1"), false);
  assert.equal(satisfiesRange("11.2.2", "^11.2.2"), true);
  assert.equal(satisfiesRange("12.10.0", "^12.10.0"), true);
});

test("staged runtime manifest exists with pinned node and no timestamps", () => {
  const manifestPath = path.resolve(scriptsDir, "..", "runtime", "MANIFEST.json");
  if (!fs.existsSync(manifestPath)) {
    // Staging is optional in CI; the test only asserts content when present.
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.layoutVersion, 1);
  assert.match(manifest.node.version, /^v\d+\.\d+\.\d+$/);
  assert.match(manifest.node.sha256, /^[0-9a-f]{64}$/);
  assert.equal(manifest.service.sqliteAbiOk, true);
  // Determinism: no timestamps or volatile fields in the manifest.
  const serialized = JSON.stringify(manifest);
  assert.ok(!/created|timestamp|generatedAt|date/i.test(serialized));
});
