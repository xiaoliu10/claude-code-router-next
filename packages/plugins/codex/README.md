# Codex subscription provider plugin (experimental)

**Physical account UNTESTED.** Automated evidence uses synthetic OAuth tokens, fake upstream fetch and throwaway configuration directories. It does not establish real-account compatibility, model availability or subscription entitlement.

Package: `@wengine-ai/ccr-provider-codex`, plugin name `codex`, core API `1`.

## Install and sign in

Build this independent package (`npm run build`), then create a distribution with `npm pack --ignore-scripts`. Install that local tarball through CCR's provider-plugin installer and restart CCR. Nothing is published by this repository change.

In provider settings, open **Codex Subscription → Browser login**. Authorize in the browser. CCR creates its own PKCE login; it never reads `~/.codex`, imports the official CLI's credentials, shares its refresh token, or terminates another application's callback listener.

The callback binds `127.0.0.1:1455`, then registered fallback `1457`. If both are occupied, the card offers **Paste callback URL**: copy the full redirected browser address into the card. A failed browser load is expected in paste mode. The URL contains a one-use OAuth code and state: do not share it, log it, or paste it into chat. Cancel discards the pending login. Login expires after ten minutes.

After authorization, account-specific models are fetched dynamically. **Sync models** refreshes them. Login/model sync adds or updates only the `codex-subscription` managed provider; it never selects a Router default or changes unrelated providers (including a user-owned provider named `codex`). Choose routing explicitly in CCR. **Disconnect** removes this plugin's credential file and managed provider; Router references are intentionally not rewritten.

## Credentials and transport

Tokens live in `<CCR_CONFIG_DIR>/codex-credentials.json`, atomically written with POSIX mode `0600`. They are not stored in ordinary provider config or returned in admin/status payloads. Protect this directory and its backups. Windows permission semantics differ.

Ordinary config contains the identifier `ccr-managed-codex`, **not a credential**. Its `ccr-managed-` prefix makes core requests fail closed with `503 plugin_missing` if the plugin is missing/disabled and prevents generic probes from spending the marker. Never change this marker manually.

The runtime pins requests to `https://chatgpt.com/backend-api/codex/responses`, rejects redirects, uses the host direct dispatcher, strips client auth/session headers, and injects its live access token/account. The transformer chain is `['openai-responses', 'codex']`. A rejected access token receives one forced refresh and one re-dispatch; rotated refresh tokens are persisted before use.

Quota observations come from headers, bounded SSE observation and the explicit usage endpoint. A quota failure parks the account until its reported reset. No model table, WebSocket, zstd, account pool or CLI credential import is included.

## Supported path and known limitations

- `/v1/responses`: real `createCcrServer` integration proves text, tools, safe terminal errors and marker secrecy against fake upstreams. **Physical account UNTESTED**.
- **`/v1/messages` with Codex UA: text/tool semantics currently BLOCKED by existing core conversion defects.** On this branch a native Responses upstream is converted through Anthropic/Chat a second time, yielding empty output. Do not treat HTTP 200 as a successful turn. Independent draft branch `fix/codex-messages-idempotent` (tip `65f7ad1`, dependencies `1d5e6b2`, `350df68`, `1d871ea`) addresses native-shape preservation, tee replay and split usage. It is NOT included here and requires separate parent review/merge. Error and fail-closed behavior are tested on both endpoints.
- **Client disconnect does not stop upstream reading:** core has no socket→signal wiring, affecting all providers; this is pre-existing, not introduced here. The client returns promptly; plugin-level stream cancellation correctly cancels its reader when cancellation reaches that boundary. A host-wide abort fix is deferred.
- Admin actions are loopback-only with Host/Origin pinning, on top of core auth. Loopback callers are trusted by core; remote callers cannot use these management routes even with a valid API key.
- No real browser OAuth/account/model calls were performed. Upstream protocol changes may require maintenance.

## Validation

`test/create-server.test.ts` runs the real composition root with a real npm tarball installed through the production archive installer. `test/integration.ccr.test.ts` provides focused Server-wrapper regressions for fake callback/paste login, 0600 persistence, quota cooling, refresh and config preservation. Component suites cover auth, finalizer, runtime, transformer and host-card seams.

`scripts/screenshots.mjs` captures connected/not-connected/cooldown/paste using the built card, real host card controller and real built host stylesheet, served by an isolated fixture API. Set `CODEX_SCREENSHOT_DIR`, `PLAYWRIGHT_MODULE`, `ESBUILD_MODULE` and optionally `CHROME_EXECUTABLE` to existing absolute paths. Screenshots are fixture evidence only, not a physical account test.
