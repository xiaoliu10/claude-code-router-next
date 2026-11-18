#!/usr/bin/env node
/**
 * Isolated smoke test for the staged desktop runtime.
 *
 * Runs `runtime/node runtime/service/entry.cjs` with a fully isolated fixture:
 * HOME and CCR_CONFIG_DIR point at a fresh temp directory, the server binds an
 * ephemeral port (never 3456), and a fixture provider forces loopback binding
 * with auth. Verifies health/config APIs, the desktop-managed 409 masking, the
 * absence of any packaged Web UI, and a graceful SIGTERM exit. The user's real
 * HOME/config/live gateway are never touched.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const scriptDir = path.dirname(new URL(import.meta.url).pathname);
const desktopDir = path.resolve(scriptDir, "..");
const runtimeDir = path.join(desktopDir, "runtime");
const FORBIDDEN_PORT = 3456;

function fail(message) {
  throw new Error(`smoke-bundled-runtime: ${message}`);
}

function request(port, requestPath, headers = {}, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: requestPath, method, headers },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on("error", reject);
    req.setTimeout(4000, () => req.destroy(new Error("request timeout")));
    req.end();
  });
}

function freeEphemeralPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function main() {
  for (const required of ["runtime/node", "runtime/service/entry.cjs", "runtime/MANIFEST.json"]) {
    if (!fs.existsSync(path.join(runtimeDir, required.replace("runtime/", "")))) {
      fail(`missing ${required}; run: node apps/desktop/scripts/prepare-runtime.mjs`);
    }
  }

  // Ephemeral port, explicitly never the shared default 3456.
  const port = await freeEphemeralPort();
  if (port === FORBIDDEN_PORT) fail("ephemeral port collision with 3456");
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-runtime-smoke-"));
  const home = path.join(fixture, "home");
  const configDir = path.join(fixture, "config");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  // Fixture provider forces loopback bind + auth (an empty provider list makes
  // the core listen on 0.0.0.0 unauthenticated — unacceptable for a smoke run).
  const fixtureConfig = {
    PORT: port,
    HOST: "127.0.0.1",
    LOG: false,
    APIKEY: "smoke-fixture-key",
    Providers: [
      {
        name: "smoke-fixture",
        api_base_url: "http://127.0.0.1:9",
        api_key: "smoke-fixture-key",
        models: ["smoke-model"],
      },
    ],
    Router: { default: "smoke-fixture,smoke-model" },
  };
  fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify(fixtureConfig, null, 2));

  const child = spawn(path.join(runtimeDir, "node"), [path.join(runtimeDir, "service", "entry.cjs")], {
    env: {
      ...process.env,
      HOME: home,
      CCR_CONFIG_DIR: configDir,
      CCR_DESKTOP_MANAGED: "1",
      SERVICE_PORT: String(port),
      PATH: `${path.join(runtimeDir, "bin")}:${runtimeDir}:/usr/bin:/bin`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));

  const deadline = Date.now() + 20_000;
  let health = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) fail(`entry exited early (${child.exitCode}): ${output.slice(-400)}`);
    try {
      health = await request(port, "/health");
      if (health.status === 200) break;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!health || health.status !== 200) fail(`health never became ready: ${output.slice(-400)}`);

  const auth = { "X-API-Key": "smoke-fixture-key" };
  const config = await request(port, "/api/config", auth);
  if (config.status !== 200) fail(`/api/config returned ${config.status}`);

  // Desktop-managed masking: lifecycle and self-update routes are refused.
  const restart = await request(port, "/api/restart", auth, "POST");
  if (restart.status !== 409) fail(`/api/restart returned ${restart.status}, expected 409`);
  const update = await request(port, "/api/update/perform", auth, "POST");
  if (update.status !== 409) fail(`/api/update/perform returned ${update.status}, expected 409`);
  const updateCheck = await request(port, "/api/update/check");
  if (
    updateCheck.status !== 200 ||
    JSON.parse(updateCheck.body).desktopManaged !== true
  ) {
    fail(`/api/update/check did not report desktopManaged`);
  }

  // Web/desktop separation: no packaged UI, API keeps working.
  const ui = await request(port, "/ui/");
  if (ui.status !== 404) fail(`/ui/ returned ${ui.status}, expected 404 without a packaged UI`);

  // Graceful stop: SIGTERM → core closes → exit 0 → port released.
  const exitCode = await new Promise((resolve) => {
    child.on("exit", (code) => resolve(code));
    child.kill("SIGTERM");
    setTimeout(() => {
      child.kill("SIGKILL");
      resolve("timeout-sigkill");
    }, 8000).unref();
  });
  if (exitCode !== 0) fail(`SIGTERM shutdown exited ${exitCode}`);
  let portReleased = false;
  try {
    await request(port, "/health");
  } catch {
    portReleased = true;
  }
  if (!portReleased) fail("port was not released after shutdown");


  console.log(
    JSON.stringify({
      ok: true,
      port,
      forbiddenPortAvoided: port !== FORBIDDEN_PORT,
      checks: ["health", "config", "restart-409", "update-409", "desktopManaged", "ui-404", "graceful-sigterm", "port-released"],
    }),
  );
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
        child.kill("SIGTERM");
      });
    }
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error?.stack ?? String(error));
  process.exitCode = 1;
});
