import { defineConfig } from "vitest/config";
import path from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// Isolated HOME for tests — mirrors packages/plugins/codex/vitest.config.ts.
// The adapter writes its private credential file under CCR_CONFIG_DIR and the
// vendored engine reads cursor-agent CLI paths under HOME; both are pinned
// into one sandbox so nothing test-related reaches the developer's real
// profile (~/.cursor, the macOS keychain prompts) or /tmp root.
const TEST_HOME = path.join(tmpdir(), "ccr-cursor-plugin-test-home");
rmSync(TEST_HOME, { recursive: true, force: true });
mkdirSync(TEST_HOME, { recursive: true });
const TEST_TMPDIR = path.join(TEST_HOME, "tmp");
mkdirSync(TEST_TMPDIR, { recursive: true });

export default defineConfig({
  test: {
    // Ported upstream engine tests (.mjs, bun:test → vitest) and the adapter
    // tests (.ts) share one suite. The upstream suite leans on short fake-wire
    // timing; give it the same headroom bun gave it.
    include: ["test/**/*.test.ts", "test/**/*.test.mjs"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // bun test — the upstream runner — executes files sequentially in one
    // process. The ported fake-wire timing tests (NATIVE_LIMITS idle/quiet in
    // the low hundreds of ms) mis-time when vitest's parallel file workers
    // contend for the event loop, so run files serially like upstream.
    fileParallelism: false,
    // The vendored engine's retention tests port Bun.gc(true) as globalThis.gc();
    // expose it to the workers so the ported assertion checks the same thing.
    execArgv: ["--expose-gc"],
    env: {
      CCR_CONFIG_DIR: TEST_HOME,
      HOME: TEST_HOME,
      TMPDIR: TEST_TMPDIR,
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "../../core/src"),
    },
  },
});
