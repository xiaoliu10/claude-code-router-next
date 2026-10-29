import { defineConfig } from "vitest/config";
import path from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// Isolated HOME for tests — mirrors packages/plugins/*/vitest.config.ts and
// packages/core/vitest.config.ts. The plugin command resolves its config dir
// through the shared package (CCR_CONFIG_DIR || ~/.claude-code-router), which
// evaluates paths at import time, so HOME/CCR_CONFIG_DIR/TMPDIR are pinned
// into the same sandbox before any test module loads and nothing test-related
// can reach the developer's real profile or the shared /tmp root.
const TEST_HOME = path.join(tmpdir(), "ccr-cli-plugin-test-home");
rmSync(TEST_HOME, { recursive: true, force: true });
mkdirSync(TEST_HOME, { recursive: true });
const TEST_TMPDIR = path.join(TEST_HOME, "tmp");
mkdirSync(TEST_TMPDIR, { recursive: true });

export default defineConfig({
  test: {
    include: ["src/__tests__/**/*.test.ts"],
    env: {
      CCR_CONFIG_DIR: TEST_HOME,
      HOME: TEST_HOME,
      TMPDIR: TEST_TMPDIR,
    },
  },
});
