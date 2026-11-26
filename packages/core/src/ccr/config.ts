/**
 * CCR configuration bootstrap — config file read/write with env-var interpolation.
 *
 * Extracted from the legacy server's utils/index.ts so the CCR runtime living in
 * packages/core has a single source of truth for config I/O. The CLI's own
 * utils/index.ts re-exports these via the core facade.
 */
import fs from "node:fs/promises";
import JSON5 from "json5";
import path from "node:path";
import {
  CONFIG_FILE,
  HOME_DIR,
  PLUGINS_DIR,
} from "@wengine-ai/claude-code-router-shared";

// Function to interpolate environment variables in config values
export const interpolateEnvVars = (obj: any): any => {
  if (typeof obj === "string") {
    // Replace $VAR_NAME or ${VAR_NAME} with environment variable values
    return obj.replace(/\$\{([^}]+)\}|\$([A-Z_][A-Z0-9_]*)/g, (match, braced, unbraced) => {
      const varName = braced || unbraced;
      return process.env[varName] || match; // Keep original if env var doesn't exist
    });
  } else if (Array.isArray(obj)) {
    return obj.map(interpolateEnvVars);
  } else if (obj !== null && typeof obj === "object") {
    const result: any = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = interpolateEnvVars(value);
    }
    return result;
  }
  return obj;
};

const ensureDir = async (dir_path: string) => {
  try {
    await fs.access(dir_path);
  } catch {
    await fs.mkdir(dir_path, { recursive: true });
  }
};

export const initDir = async () => {
  await ensureDir(HOME_DIR);
  await ensureDir(PLUGINS_DIR);
  await ensureDir(path.join(HOME_DIR, "logs"));
};

// Read config file without env-var interpolation.
// Used by the UI layer so that $VAR placeholders are preserved on round-trip.
export const readConfigFileRaw = async () => {
  const raw = await fs.readFile(CONFIG_FILE, "utf-8");
  return JSON5.parse(raw);
};

export const readConfigFile = async () => {
  try {
    const config = await fs.readFile(CONFIG_FILE, "utf-8");
    try {
      // Try to parse with JSON5 first (which also supports standard JSON)
      const parsedConfig = JSON5.parse(config);
      // Interpolate environment variables in the parsed config
      return interpolateEnvVars(parsedConfig);
    } catch (parseError) {
      console.error(`Failed to parse config file at ${CONFIG_FILE}`);
      console.error("Error details:", (parseError as Error).message);
      console.error("Please check your config file syntax.");
      process.exit(1);
    }
  } catch (readError: any) {
    if (readError.code === "ENOENT") {
      // Config file doesn't exist, prompt user for initial setup
      try {
        // Initialize directories
        await initDir();

        // Backup existing config file if it exists
        const backupPath = await backupConfigFile();
        if (backupPath) {
          console.log(
              `Backed up existing configuration file to ${backupPath}`
          );
        }
        const config = {
          PORT: 3456,
          Providers: [],
          Router: {},
        }
        // Create a minimal default config file
        await writeConfigFile(config);
        console.log(
            "Created minimal default configuration file at ~/.claude-code-router/config.json"
        );
        console.log(
            "Please edit this file with your actual configuration."
        );
        return config
      } catch (error: any) {
        console.error(
            "Failed to create default configuration:",
            error.message
        );
        process.exit(1);
      }
    } else {
      console.error(`Failed to read config file at ${CONFIG_FILE}`);
      console.error("Error details:", readError.message);
      process.exit(1);
    }
  }
};

// Non-exiting, non-writing, non-logging reader for the hot-reload route.
// The bootstrap reader (readConfigFile) exits the process on parse/read
// failure and auto-creates a default file on ENOENT — right for CLI startup,
// fatal for a live gateway. This variant throws on any failure so the caller
// can answer a fixed 500 with the runtime and the file untouched.
export const readConfigFileSafe = async (jsonPath: string = CONFIG_FILE) => {
  const raw = await fs.readFile(jsonPath, "utf-8");
  const parsed = JSON5.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("config root is not an object");
  }
  return interpolateEnvVars(parsed);
};

function assertNotTestEnv() {
  if (process.env.VITEST || process.env.CI) {
    throw new Error(
      "Config write attempted during test/CI. " +
      "Set CCR_CONFIG_DIR to a temp dir to isolate."
    );
  }
}

export const backupConfigFile = async () => {
  assertNotTestEnv();
  try {
    if (await fs.access(CONFIG_FILE).then(() => true).catch(() => false)) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = `${CONFIG_FILE}.${timestamp}.bak`;
      await fs.copyFile(CONFIG_FILE, backupPath);

      // Clean up old backups, keeping only the 3 most recent
      try {
        const configDir = path.dirname(CONFIG_FILE);
        const configFileName = path.basename(CONFIG_FILE);
        const files = await fs.readdir(configDir);

        // Find all backup files for this config
        const backupFiles = files
          .filter(file => file.startsWith(configFileName) && file.endsWith('.bak'))
          .sort()
          .reverse(); // Sort in descending order (newest first)

        // Delete all but the 3 most recent backups
        if (backupFiles.length > 3) {
          for (let i = 3; i < backupFiles.length; i++) {
            const oldBackupPath = path.join(configDir, backupFiles[i]);
            await fs.unlink(oldBackupPath);
          }
        }
      } catch (cleanupError) {
        console.warn("Failed to clean up old backups:", cleanupError);
      }

      return backupPath;
    }
  } catch (error) {
    console.error("Failed to backup config file:", error);
  }
  return null;
};

export const writeConfigFile = async (config: any) => {
  assertNotTestEnv();
  await ensureDir(HOME_DIR);

  // Before overwriting the live config, take a durable snapshot of the current
  // file into a non-rotating archive. Unlike the rolling .bak pool (which is
  // pruned to 3 and can be overwritten by the next save), this archive keeps
  // every pre-write state so a bad save can always be rolled back. A write
  // MUST NOT proceed without a backup — if the snapshot fails we refuse to
  // overwrite rather than risk losing the existing config.
  await snapshotConfigBeforeWrite();

  const configWithComment = `${JSON.stringify(config, null, 2)}`;
  await fs.writeFile(CONFIG_FILE, configWithComment);
};

/**
 * Copy the current config.json into ~/.claude-code-router/config-history/ with
 * a timestamped name before every write. Failures here throw so the caller
 * cannot overwrite the live config without a recoverable backup existing.
 */
export const snapshotConfigBeforeWrite = async () => {
  const exists = await fs.access(CONFIG_FILE).then(() => true).catch(() => false);
  if (!exists) {
    return; // nothing to snapshot on first write
  }

  const historyDir = path.join(HOME_DIR, "config-history");
  await ensureDir(historyDir);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const snapshotPath = path.join(historyDir, `config-${timestamp}.json`);
  await fs.copyFile(CONFIG_FILE, snapshotPath);

  // Keep the history bounded but generous: retain the last 50 snapshots so a
  // regression that spans many saves is still recoverable.
  try {
    const files = await fs.readdir(historyDir);
    const snapshots = files
      .filter((f) => f.startsWith("config-") && f.endsWith(".json"))
      .sort()
      .reverse();
    if (snapshots.length > 50) {
      for (const old of snapshots.slice(50)) {
        await fs.unlink(path.join(historyDir, old));
      }
    }
  } catch (cleanupError) {
    console.warn("Failed to prune config-history:", cleanupError);
  }
};

export const initConfig = async () => {
  const config = await readConfigFile();
  Object.assign(process.env, config);
  return config;
};