/**
 * Desktop standalone service entry.
 *
 * Web/desktop separation (architecture decision 2026-11-17): the desktop app
 * embeds a portable Node runtime and starts the CCR core directly through
 * `getServer()` — it never invokes the `ccr` CLI, never depends on a global
 * Node/npm/ccr install, and never registers the CLI's self-update/restart
 * routes. The standalone CLI keeps its own entry and behavior unchanged.
 *
 * Client integration lifecycle (mirrors the CLI start/stop semantics):
 * - After the server successfully BINDS, restore the client integrations the
   * user previously enabled (shared logic only; never auto-enables clients the
   * user did not select). Uses `readConfigFileRaw` so environment placeholders
   * are never interpolated back into config.json, and `writeConfigFile` keeps
   * its forced history snapshot.
 * - Restore-on-stop runs only when a bind actually succeeded, is serialized
 *   with the start-phase apply, and does not re-run project takeover sync (the
 *   CLI stop path only disables + writes; a sync could re-takeover projects).
 * - Startup failure exits non-zero so the desktop reports the gateway as not
 *   ready instead of pretending it is.
 * - Desktop-managed route masking: `/api/restart` and `/api/update/perform`
 *   answer 409 and `/api/update/check` reports the desktop-managed state so a
 *   Web UI caller cannot replace or self-update the desktop-owned process.
 */
import {
  getServer,
  readConfigFileRaw,
  writeConfigFile,
} from "@wengine-ai/llms";
import {
  disableConfiguredClients,
  enableConfiguredClients,
  syncGlobalProjectTakeovers,
} from "@wengine-ai/claude-code-router-shared";

type RawConfig = Record<string, unknown>;
type AnyServer = { app: any; start: () => Promise<void> };

/** Fixed, non-sensitive messages; never echo config or credentials. */
const RESTART_REJECTED = {
  error: "desktop-managed: the gateway lifecycle is owned by the desktop app",
} as const;
const UPDATE_CHECK = { hasUpdate: false, desktopManaged: true } as const;

function registerDesktopManagedRoutes(app: any): void {
  app.post("/api/restart", async (_: unknown, reply: any) => {
    return reply.code(409).send(RESTART_REJECTED);
  });
  app.post("/api/update/perform", async (_: unknown, reply: any) => {
    return reply.code(409).send(RESTART_REJECTED);
  });
  app.get("/api/update/check", async () => UPDATE_CHECK);
}

/**
 * Applies one client selection phase against the raw config. An empty enabled
 * selection writes nothing. Only ids are logged on failure — never error
 * payloads, which could carry local paths or config fragments.
 */
async function applyClientSelections(
  apply: (config: RawConfig) => {
    results: { id: string; success: boolean }[];
    config: RawConfig;
  },
  action: string,
  syncTakeovers: boolean,
): Promise<boolean> {
  const config = await readConfigFileRaw();
  const result = apply(config);
  if (result.results.length === 0) {
    return false;
  }
  await writeConfigFile(result.config);
  const failures = result.results.filter((item) => !item.success);
  for (const failure of failures) {
    console.error(`desktop service: client integration ${action} failed (${failure.id})`);
  }
  if (syncTakeovers) {
    try {
      const sync = await syncGlobalProjectTakeovers(result.config);
      for (const failed of sync.failed) {
        console.error(`desktop service: ${action} takeover sync failed (${failed.id})`);
      }
    } catch {
      // Takeover sync is best-effort; the router keeps working without it.
    }
  }
  return failures.length === 0;
}

async function main(): Promise<void> {
  const server = (await getServer()) as AnyServer;
  registerDesktopManagedRoutes(server.app);

  // Lifecycle state: applies are serialized through one chain so the start
  // phase and the shutdown phase can never write config concurrently, and the
  // shutdown phase waits for any in-flight start apply before restoring.
  let shuttingDown = false;
  let bindSucceeded = false;
  let applying: Promise<void> = Promise.resolve();
  const serializeApply = (phase: () => Promise<void>): Promise<void> => {
    const run = applying.then(phase, phase);
    applying = run.catch(() => {});
    return run;
  };

  // Runs inside the core's graceful close. The bind gate guarantees a failed
  // startup (listen error closes the app without ever binding) never disables
  // the user's real client integrations.
  server.app.addHook("onClose", async () => {
    if (!bindSucceeded || shuttingDown) {
      return;
    }
    shuttingDown = true;
    await serializeApply(async () => {
      try {
        await applyClientSelections(disableConfiguredClients, "disable", false);
      } catch {
        console.error("desktop service: client integration restore failed during shutdown");
      }
    });
  });

  await server.start();
  bindSucceeded = true;
  if (shuttingDown) {
    // Shutdown began while binding; skip the start-phase apply entirely.
    return;
  }
  await serializeApply(async () => {
    try {
      const applied = await applyClientSelections(
        enableConfiguredClients,
        "enable",
        true,
      );
      if (applied) {
        console.log("desktop service: enabled client integrations restored");
      }
    } catch {
      // The router is already serving; a failed apply must not kill it, but it
      // must also never be reported as a success.
      console.error("desktop service: client integration restore on start failed");
    }
  });
}

main().catch((error: unknown) => {
  // Startup failure must surface honestly: exit non-zero so the desktop
  // reports the gateway as stopped/erroring instead of pretending ready.
  const message = error instanceof Error ? error.message : String(error);
  console.error("desktop service failed to start:", message);
  process.exit(1);
});
