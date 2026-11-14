import fs from "node:fs/promises";
import readline from "node:readline";
import JSON5 from "json5";
import path from "node:path";
import { createHash } from "node:crypto";
import os from "node:os";
import {
  CONFIG_FILE,
  HOME_DIR, PID_FILE,
  PLUGINS_DIR,
  PRESETS_DIR,
  REFERENCE_COUNT_FILE,
  getDefaultClientsConfig,
  readPresetFile,
} from "@wengine-ai/claude-code-router-shared";
import { getServer } from "@wengine-ai/llms";
import { writeFileSync, existsSync, readFileSync, mkdirSync } from "fs";
import { checkForUpdates, performUpdate } from "./update";
import { version } from "../../package.json";
import { exec, spawn } from "child_process";
import { promisify } from "util";
import {cleanupPidFile, isServiceRunning} from "./processCheck";

// Function to interpolate environment variables in config values
const interpolateEnvVars = (obj: any): any => {
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
  await ensureDir(PRESETS_DIR);
  await ensureDir(path.join(HOME_DIR, "logs"));
};

const createReadline = () => {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
};

const question = (query: string): Promise<string> => {
  return new Promise((resolve) => {
    const rl = createReadline();
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
};

const confirm = async (query: string): Promise<boolean> => {
  const answer = await question(query);
  return answer.toLowerCase() !== "n";
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
          Clients: getDefaultClientsConfig(),
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

export const backupConfigFile = async () => {
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
  await ensureDir(HOME_DIR);

  // Before overwriting the live config, snapshot the current file into a
  // non-rotating archive (config-history/). A write MUST NOT proceed without a
  // backup — if the snapshot fails we refuse to overwrite rather than risk
  // losing the existing config. Mirrors packages/core/src/ccr/config.ts.
  const exists = await fs.access(CONFIG_FILE).then(() => true).catch(() => false);
  if (exists) {
    const historyDir = path.join(HOME_DIR, "config-history");
    await ensureDir(historyDir);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    await fs.copyFile(CONFIG_FILE, path.join(historyDir, `config-${timestamp}.json`));

    // Retain the last 50 snapshots so a regression spanning many saves is
    // still recoverable.
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
  }

  const configWithComment = `${JSON.stringify(config, null, 2)}`;
  await fs.writeFile(CONFIG_FILE, configWithComment);
};

export const initConfig = async () => {
  const config = await readConfigFile();
  Object.assign(process.env, config);
  return config;
};

export const run = async (args: string[] = []) => {
  const isRunning = isServiceRunning()
  if (isRunning) {
    console.log('claude-code-router server is running');
    return;
  }
  const server = await getServer();
  const app = server.app;

  app.post('/api/update/perform', async () => {
    return await performUpdate();
  })

  app.get('/api/update/check', async () => {
    return await checkForUpdates(version);
  })

  app.post("/api/restart", async () => {
    setTimeout(async () => {
      spawn("ccr", ["restart"], {
        detached: true,
        stdio: "ignore",
      }).unref();
    }, 100);

    return { success: true, message: "Service restart initiated" }
  });

  // await server.start() to ensure it starts successfully and keep process alive.
  // The PID file is written only AFTER a successful bind: a start that dies on
  // EADDRINUSE must not leave its own corpse PID behind overwriting the record
  // of the genuine listener (the root cause of the stale-PID restart loop).
  try {
    await server.start();
    writeFileSync(PID_FILE, process.pid.toString());
  } catch (startError) {
    cleanupPidFile();
    throw startError;
  }
}

/**
 * Find the PID actually LISTENING on the service port, so a stale PID file can
 * never leave the real server running behind `ccr restart`'s back. The stale
 * state happens when a previous start crashed on EADDRINUSE after writing its
 * own PID (crash order: write PID → bind port), overwriting the record of the
 * genuine listener — after that every restart killed nothing, spawned a new
 * loser, and the loop kept the OLD version serving forever (the 2026-11-14
 * "page update always fails" incident).
 */
const findListenerPids = async (): Promise<number[]> => {
  try {
    const config = await readConfigFile();
    const port = Number(config.PORT) || 3456;
    const { stdout } = await execPromise(`lsof -tiTCP:${port} -sTCP:LISTEN -n -P`, { timeout: 5000 });
    const pids = [...new Set(stdout.split("\n").map(s => parseInt(s.trim(), 10)).filter(Number.isFinite))];
    return pids;
  } catch {
    return [];
  }
};

/**
 * Only a process that actually IS this CLI may be killed by the port fallback:
 * an unrelated dev server that happens to hold the configured port must be
 * left alone (the respawn then fails loudly with EADDRINUSE, as before).
 */
const isCcrListener = async (pid: number): Promise<boolean> => {
  try {
    const { stdout } = await execPromise(`ps -p ${pid} -o command=`, { timeout: 5000 });
    return /claude-code-router|ccr.*cli\.js/i.test(stdout);
  } catch {
    return false;
  }
};

/** Wait until no CCR listener holds the port (or nothing does at all). */
const waitForPortRelease = async (pids: number[], timeoutMs = 8000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const listeners = await findListenerPids();
    if (!listeners.some(p => pids.includes(p))) return true;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return !(await findListenerPids()).some(p => pids.includes(p));
};

const execPromise = promisify(exec);

export const restartService = async () => {
  // Take a durable pre-restart backup of the current config before stopping
  // the old service. The standard 3-backup rolling pool can be overwritten
  // by the new version's first save, so this separate non-rotating snapshot
  // stays available for rollback even after the rolling backups are gone.
  try {
    const backupDir = path.join(HOME_DIR, "pre-upgrade-backups");
    mkdirSync(backupDir, { recursive: true });
    const backupName = `config-pre-restart-${Date.now()}.json`;
    await fs.copyFile(CONFIG_FILE, path.join(backupDir, backupName));
  } catch (backupError) {
    console.warn("Failed to create pre-restart config backup:", backupError);
  }

  // Stop the service. The PID file is the fast path, but it can be stale
  // (see findListenerPid): when killing it does not free the port, fall back to
  // the REAL port listener so the respawn below cannot die on EADDRINUSE.
  let stoppedPid: number | null = null;
  try {
    const pid = parseInt(readFileSync(PID_FILE, "utf-8"));
    process.kill(pid);
    stoppedPid = pid;
    cleanupPidFile();
    if (existsSync(REFERENCE_COUNT_FILE)) {
      try {
        await fs.unlink(REFERENCE_COUNT_FILE);
      } catch (e) {
        // Ignore cleanup errors
      }
    }
    console.log("claude code router service has been stopped.");
  } catch {
    console.log("Service was not running or failed to stop.");
    cleanupPidFile();
  }

  // Port still held after the PID-file kill? Kill the actual CCR listener(s) —
  // identity-checked so an unrelated process holding the port is never touched.
  const listeners = await findListenerPids();
  const ccrListeners: number[] = [];
  for (const pid of listeners) {
    if (pid === stoppedPid) continue; // already signalled via the PID file path
    if (!(await isCcrListener(pid))) {
      console.log(`Port held by PID ${pid}, which is not CCR; leaving it alone.`);
      continue;
    }
    console.log(`Port still held by CCR PID ${pid} (stale PID file); stopping the real listener.`);
    try { process.kill(pid); ccrListeners.push(pid); } catch { /* already gone */ }
  }
  if (ccrListeners.length) stoppedPid = ccrListeners[ccrListeners.length - 1];

  // Never respawn onto a busy port: wait for release, SIGKILL as last resort.
  if (stoppedPid !== null && !(await waitForPortRelease(ccrListeners.length ? ccrListeners : [stoppedPid]))) {
    const stubborn = (await findListenerPids()).filter(p => ccrListeners.includes(p));
    if (stubborn.length) {
      console.warn(`Port still held after 8s; sending SIGKILL to PIDs ${stubborn.join(", ")}.`);
      for (const pid of stubborn) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
      await waitForPortRelease(stubborn, 3000);
    }
  }
  cleanupPidFile();

  // Start the service again in the background
  console.log("Starting claude code router service...");
  const cliPath = path.join(__dirname, "cli.js");
  const startProcess = spawn("node", [cliPath, "start"], {
    detached: true,
    stdio: "ignore",
  });

  startProcess.on("error", (error) => {
    console.error("Failed to start service:", error);
    throw error;
  });

  startProcess.unref();
  console.log("✅ Service started successfully in the background.");
};


/**
 * Get a temporary path for the settings file
 * Hash the content and return the file path if it already exists in temp directory,
 * otherwise create a new file with the content
 * @param content Settings content string
 * @returns Full path to the temporary file
 */
export const getSettingsPath = async (content: string): Promise<string> => {
  // Hash the content using SHA256 algorithm
  const hash = createHash('sha256').update(content, 'utf-8').digest('hex');

  // Create claude-code-router directory in system temp folder
  const tempDir = path.join(os.tmpdir(), 'claude-code-router');
  const fileName = `ccr-settings-${hash}.json`;
  const tempFilePath = path.join(tempDir, fileName);

  // Ensure the directory exists
  try {
    await fs.access(tempDir);
  } catch {
    await fs.mkdir(tempDir, { recursive: true });
  }

  // Check if the file already exists
  try {
    await fs.access(tempFilePath);
    return tempFilePath;
  } catch {
    // File doesn't exist, create and write content
    await fs.writeFile(tempFilePath, content, 'utf-8');
    return tempFilePath;
  }
}
