import { defineConfig } from "vitest/config";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const home = mkdtempSync(join(tmpdir(), "ccr-grok-tests-"));
mkdirSync(join(home, "tmp"));
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], setupFiles: ["test/isolate.ts"], env: {
    HOME: home, USERPROFILE: home, CCR_CONFIG_DIR: home, XDG_CONFIG_HOME: home, TMPDIR: join(home, "tmp"),
    GROK_HOME: join(home, ".grok"), GROK_BIN_DIR: join(home, "missing-cli"),
    GROK_AUTH_PATH: "", GROK_AUTH_PROVIDER_COMMAND: "", GROK_AUTH_EXPIRED: "", PATH: "",
  } },
  resolve: { alias: { "@": resolve(__dirname, "../../core/src") } },
});
