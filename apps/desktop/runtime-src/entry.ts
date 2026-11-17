/**
 * Desktop standalone service entry.
 *
 * Web/desktop separation (architecture decision 2026-11-17): the desktop app
 * embeds a portable Node runtime and starts the CCR core directly through
 * `getServer()` — it never invokes the `ccr` CLI, never depends on a global
 * Node/npm/ccr install, and never registers the CLI's self-update/restart
 * routes. The standalone CLI keeps its own entry and behavior unchanged.
 *
 * Responsibilities beyond a plain `getServer().start()`:
 * - Client integration hook: after the server successfully binds, restore the
 *   client integrations the user previously enabled (shared logic only; never
 *   auto-enables clients the user did not select). Uses `readConfigFileRaw` so
 *   environment placeholders are never interpolated back into config.json,
 *   and `writeConfigFile` keeps its forced history snapshot.
 * - Restore hook: on SIGINT/SIGTERM the same integrations are restored before
 *   the core's own graceful close finishes, mirroring the CLI stop semantics
 *   without touching global `ccr stop`.
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

type RawConfig = Record<string, unknown>;

async function applyClientSelections(
  apply: (config: RawConfig) => { config: RawConfig },
  action: string,
): Promise<void> {
  // Raw config: never write environment-interpolated values back to disk.
  const config = await readConfigFileRaw();
  const result = apply(config);
  await writeConfigFile(result.config);
  try {
    const sync = await syncGlobalProjectTakeovers(result.config);
    if (sync.failed.length > 0) {
      for (const failure of sync.failed) {
        console.error(`desktop service: ${action} takeover sync failed (${failure.id})`);
      }
    }
  } catch {
    // Takeover sync is best-effort; the router keeps working without it.
  }
}

async function restoreClientSelectionsOnStart(): Promise<void> {
  await applyClientSelections(enableConfiguredClients, "enable");
}

async function restoreClientSelectionsOnStop(): Promise<void> {
  await applyClientSelections(disableConfiguredClients, "disable");
}

async function main(): Promise<void> {
  const server = (await getServer()) as AnyServer;
  registerDesktopManagedRoutes(server.app);

  let shuttingDown = false;
  // Runs inside the core's graceful close (registered before listen, so the
  // hook is not frozen out), restoring client integrations before exit.
  server.app.addHook("onClose", async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await restoreClientSelectionsOnStop();
    } catch {
      console.error("desktop service: client integration restore failed during shutdown");
    }
  });

  await server.start();
  // Only after a successful bind may the desktop touch client integrations.
  // A failed startup exits non-zero without writing any client config.
  try {
    await restoreClientSelectionsOnStart();
  } catch {
    console.error("desktop service: client integration restore on start failed");
  }
}

main().catch((error: unknown) => {
  // Startup failure must surface honestly: exit non-zero so the desktop
  // reports the gateway as stopped/erroring instead of pretending ready.
  const message = error instanceof Error ? error.message : String(error);
  console.error("desktop service failed to start:", message);
  process.exit(1);
});
