# Desktop control center

Date: 2026-11-17. Status: research and implementation.

## Required separation (user clarification)

Desktop and CLI are independent entry points sharing the routing core. Desktop main and tray views load bundled local assets, never the server Web UI. The app embeds a portable Node runtime and starts a dedicated desktop service entry importing core `getServer()`; it must never execute installed or bundled `ccr start`, and must not fall back to a global CLI. CLI remains independently usable with `ccr start` and browser administration, without the desktop installed. Shared configuration is compatible, but runtime ownership is explicit and an existing external service is not stopped. Missing development runtime resources produce preparation instructions, not a CLI fallback. Distribution validation removes global Node/npm/ccr from PATH.

Local main and quota windows receive narrowly scoped IPC only when their exact bundled URL matches. A foreign URL is rejected even if loaded into a window named main. Main-window close exits the app and stops its owned service; popup dismissal merely hides the popup.

The earlier installed-CLI alternative below is historical context and is rejected by this clarification.

## Intent

Extend the all-provider tray quota panel into a practical desktop entry point for routing, usage, and client integrations. Add explicit desktop-owned gateway lifecycle, while retaining safe attachment to an already-running gateway. Keep the current live gateway untouched during implementation and verification.

## Internal findings

- `apps/desktop/src/quota.{html,css,js}` provides a local, privileged, CSP-constrained panel. `popup.rs` validates exact local URL and window label for every command.
- `src-tauri/src/api.rs` authenticates loopback requests without redirects or proxies and already performs routing read-modify-write/readback for the native menu.
- `packages/core/src/ccr/admin-routes.ts` exposes client discovery and individual enable/disable/restore operations, plus usage and summary APIs. `packages/ui/src/lib/api.ts:326` and following document current frontend callers.
- `packages/ui/src/components/SettingsPage.tsx` owns existing family/scenario routing and client configuration UX. `packages/ui/src/routes.tsx` uses a memory router, so simply adding URL hashes is not a dependable desktop deep-link implementation.
- `src-tauri/src/lifecycle.rs` currently starts an installed `ccr start` if a verified config matches a refused port, retains its Child handle, and deliberately leaves the gateway alive when exiting. `tray.rs` owns this launcher and stop hooks. Ownership must become explicit before adding shutdown.

Existing flow: local panel -> guarded Rust command -> AdminClient -> existing CCR admin API. New tabs should use narrow typed projections; raw configuration/credentials must not cross IPC.

Implementation seams: (1) local panel tabs/forms, (2) Rust routing/usage/client API contracts and command permissions, (3) lifecycle ownership and close/quit behavior. Node runtime bundling is a distinct packaging question; the current app requires installed Node and CCR.

## External findings and final contracts

Source: https://github.com/yetone/magpie/blob/main/docs/subsystems/agent-wiring.md explicitly describes connecting coding agents by editing their endpoint/key/model and restoring previous values when disconnecting. This maps to CCR Clients, not an autonomous agent runtime. Reuse CCR's existing enable/disable/restore handlers rather than implement a second config writer.

Source: https://github.com/yetone/magpie/blob/main/docs/subsystems/gui-shell.md describes an app that starts or attaches to a gateway; window-close hides, explicit Quit stops its own serving process. Here the requested desktop-owned behavior takes precedence: closing the main desktop window and explicit Quit end a gateway owned by this desktop, while closing the small popup only hides it. An external service is never stopped implicitly.

Source: https://v2.tauri.app/develop/sidecar/ supports embedding runtimes to avoid separate installation. Ship Node plus the routing core/dependencies and a dedicated desktop service entry as resources, launched by Rust with fixed arguments. Prefer resources and std::process over granting frontend shell permission. Never package local user configuration, credentials, plugins, or databases.

Alternatives: (A) launch an installed CCR only (small, but not standalone); (B) bundle runtime and track a real owned Child, attach safely to existing service (selected). Keep existing CLI operation and shared config compatibility. No broad process-name kill and no global ccr stop. Startup/exit races and replacement listeners must not confer ownership. Service mode is visible in the panel.

## IPC contract

All commands require the trusted local main-or-quota window guard. Errors are fixed safe messages; no config/key/raw upstream data crosses IPC.

- `routing_snapshot()` -> `{providers:[{name,models:[string]}],routes:[{scope,field,target:string|null,fallback:[string]}],familyRouting:boolean,fallbackEnabled:boolean,revision:string}`. Scopes global/opus/sonnet/haiku/models. Scenarios default/background/think/longContext/extendedContext/webSearch/image. Model aliases use scope models with alias as field.
- `routing_save({change:{revision,scope,field,target:string|null,fallback:[string]|null}})` -> updated routing snapshot. Null fallback preserves it. A null/empty target clears an override; validate available choices, allow clearing missing old choices. Preserve unrelated raw config fields. Serialize desktop writes and reject stale revisions; document that legacy external full-config writers are not atomic.
- `routing_flags({revision,familyRouting:boolean,fallbackEnabled:boolean})` -> updated routing snapshot.
- `usage_snapshot({period:'today'|'7d'|'30d'})` -> `{period,totalRequests,successCount,errorCount,inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,estimatedCount,byProvider:[{name,requests,inputTokens,outputTokens}],byDay:[{name,requests,inputTokens,outputTokens}],updatedAt}`. Derive from existing summary only; no fabricated currency/costs.
- `clients_snapshot()` -> `{clients:[{id,name,enabled,managed,exists,activeModel:string|null,modelAlias:string|null}],success:boolean,message:string|null}`.
- `clients_update({id,action:'enable'|'disable'|'restore'})` -> same projected response. No arbitrary IDs or URLs. Refresh live statuses after mutation and surface partial failure.
- `service_snapshot()` -> `{mode:'owned'|'external'|'stopped'|'starting'|'error',running:boolean,message:string}`.
- `service_action({action:'start'|'stop'})` -> same service state. Stop only owned Child; external mode disabled in UI and rejected natively.
- Existing quota commands remain compatible. `quota_quit` exits the desktop; lifecycle exit cleanup stops only owned service.
- Owned child sets `CCR_DESKTOP_MANAGED=1`. Desktop service routes `/api/restart` and `/api/update/perform` return a safe 409 without spawning global CLI/updating global packages. `/api/update/check` reports desktop management with no CLI upgrade offer. Plugin activation can use the panel stop/start controls. Portable runtime includes npm for plugin installation; the app itself is upgraded by replacing its bundle.

## UI and validation

Four tabs retain the compact light neutral/orange design: quota, routing, usage, clients. Routing supports global/family scenarios and ordered fallback choices with clear save feedback, family/fallback switches, and model aliases. Usage period picker and totals/provider breakdown; clients show connected state and explicit connect/disconnect/restore operations. Header service state/start-stop, footer exit wording reflects ownership. Keep edits while typing; avoid focus-triggered rerenders discarding route drafts. Keys stay in Rust.

Validate narrow IPC projections, routing validation/preservation/conflict, client partial failures, usage periods, frontend async races and draft retention. Lifecycle tests use fake executable + temporary homes/ports; standalone smoke uses isolated HOME, CCR_CONFIG_DIR and blocked real client writes. Verify ownership, occupied/unrelated port, quit cleanup, attach-only preservation, startup failure. Build final app, independently review combined changes, submit OPEN PR stacked on #140; no merge/release or live gateway change.
