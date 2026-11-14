import { describe, it, expect, afterEach } from "vitest";
import { spawnSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

/**
 * Regression: `ccr restart` trusted the PID file alone. When a previous start
 * crashed on EADDRINUSE after writing its own PID (crash order: write PID →
 * bind port), the file recorded a corpse while the REAL listener kept serving
 * — every restart then killed nothing, spawned a new loser, and the old
 * version served forever (the 2026-11-14 "page update always fails" incident).
 *
 * End-to-end against the built dist/cli.js: a REAL CCR server (`cli.js start`)
 * holds the service port while the PID file names a corpse; `ccr restart` must
 * identify and stop the real listener (identity-checked — a NON-CCR port
 * holder is left alone), and never EADDRINUSE its own respawn.
 *
 * Requires lsof (macOS/Linux) and packages/cli/dist/cli.js (run pnpm build
 * first). NOTE: under vitest the spawned replacement server is reaped with the
 * worker's process group, so "port served again" is not asserted here; that
 * half was verified manually outside vitest.
 */

const repoRoot = join(__dirname, "../../../..");
const cliJs = join(repoRoot, "packages/cli/dist/cli.js");

/**
 * Spawned children must look like production: vitest sets VITEST/CI in the
 * worker env, and the core config writer refuses writes under those markers
 * (assertNotTestEnv) — the spawned CCR server would abort its own startup.
 */
function prodLikeEnv(home: string): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^(VITEST|CI|npm_lifecycle_event|npm_package_|NODE_ENV$)/.test(k)) env[k] = v;
  }
  return { ...env, NODE_ENV: "production", HOME: home, CCR_CONFIG_DIR: home };
}

interface Fixture {
  dir: string;
  home: string;
  port: number;
  cleanup: () => Promise<void>;
  extraProcs: ChildProcess[];
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function waitPortState(port: number, wantOpen: boolean, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await new Promise<boolean>(resolve => {
      const srv = createServer();
      srv.once("error", () => resolve(true)); // EADDRINUSE → someone listens
      srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(false)));
    });
    if (open === wantOpen) return true;
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

async function startCcrServer(home: string): Promise<ChildProcess> {
  const proc = spawn(process.execPath, [cliJs, "start"], {
    env: prodLikeEnv(home),
    stdio: "ignore",
    detached: true,
  });
  proc.unref();
  return proc;
}

async function setup(): Promise<Fixture> {
  if (!existsSync(cliJs)) throw new Error("packages/cli/dist/cli.js missing — run pnpm build first");
  const dir = mkdtempSync(join(tmpdir(), "ccr-restart-e2e-"));
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  const port = await freePort();
  writeFileSync(join(home, "config.json"), JSON.stringify({ PORT: port, Providers: [], Router: {} }));
  return { dir, home, port, extraProcs: [], cleanup: async () => {} };
}

async function setupFixture(): Promise<Fixture> {
  const f = await setup();
  f.cleanup = async () => {
    for (const p of f.extraProcs) p.kill("SIGKILL");
    try {
      const pid = parseInt(readFileSync(join(f.home, ".claude-code-router.pid"), "utf8"), 10);
      if (Number.isFinite(pid)) process.kill(pid, "SIGKILL");
    } catch { /* gone already */ }
    rmSync(f.dir, { recursive: true, force: true });
  };
  return f;
}

function runRestart(home: string): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [cliJs, "restart"], {
    encoding: "utf8",
    timeout: 45_000,
    env: prodLikeEnv(home),
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

describe("ccr restart with a stale PID file (real port takeover)", () => {
  let activeCleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (activeCleanup) { const c = activeCleanup; activeCleanup = null; await c(); } });

  it("kills the real CCR listener when the PID file points at a corpse", async () => {
    const f = await setupFixture();
    activeCleanup = f.cleanup;

    // The victim: a genuine CCR server holding the service port (the exact
    // incident state — old server alive, PID file about to go stale).
    const victim = await startCcrServer(f.home);
    f.extraProcs.push(victim);
    expect(await waitPortState(f.port, true)).toBe(true);
    // Now corrupt the PID file to a corpse (simulating the crashed-start state).
    writeFileSync(join(f.home, ".claude-code-router.pid"), "999999999");

    const res = runRestart(f.home);
    expect(`${res.stdout}${res.stderr}`).toMatch(/stopping the real listener|has been stopped/);
    expect(res.stderr).not.toContain("EADDRINUSE");

    // The victim (the REAL port holder) is dead — the regression's core: the
    // old code never killed it, so the old version served forever.
    const victimGone = await new Promise<boolean>(resolve => {
      if (victim.exitCode !== null || victim.signalCode) return resolve(true);
      victim.once("exit", () => resolve(true));
      setTimeout(() => resolve(false), 15_000);
    });
    expect(victimGone).toBe(true);
    // No stale-corpse PID file left behind (it may be legitimately removed).
    if (existsSync(join(f.home, ".claude-code-router.pid"))) {
      const pid = parseInt(readFileSync(join(f.home, ".claude-code-router.pid"), "utf8"), 10);
      if (Number.isFinite(pid)) expect(pid).not.toBe(999999999);
    }
  }, 60_000);

  it("leaves an unrelated non-CCR port holder alone", async () => {
    const f = await setupFixture();
    activeCleanup = f.cleanup;

    // A foreign dev server happens to hold the configured port.
    const foreign = spawn(process.execPath, ["-e", `require("http").createServer((q,s)=>s.end("x")).listen(${f.port},"127.0.0.1")`], { stdio: "ignore", detached: true });
    foreign.unref();
    f.extraProcs.push(foreign);
    expect(await waitPortState(f.port, true)).toBe(true);
    writeFileSync(join(f.home, ".claude-code-router.pid"), "999999999");

    const res = runRestart(f.home);
    expect(res.stdout).toContain("not CCR; leaving it alone");
    expect(res.stderr).not.toContain("EADDRINUSE");
    // The foreign process survived.
    expect(foreign.exitCode).toBeNull();
    expect(foreign.signalCode).toBeNull();
  }, 60_000);
});
