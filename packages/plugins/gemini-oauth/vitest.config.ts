import { defineConfig } from "vitest/config";
import path from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// Isolated HOME for tests — mirrors packages/core/vitest.config.ts. Some tests
// import core sources (the data-plane seam runs against the real core Server),
// and core's config module derives its paths from CCR_CONFIG_DIR at import time.
const TEST_HOME = path.join(tmpdir(), "ccr-gemini-plugin-test-home");
rmSync(TEST_HOME, { recursive: true, force: true });
mkdirSync(TEST_HOME, { recursive: true });

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    env: {
      CCR_CONFIG_DIR: TEST_HOME,
    },

  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "../../core/src"),
    },
  },
});
