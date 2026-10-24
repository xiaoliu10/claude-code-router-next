# Gemini OAuth provider plugin

This is an **external plugin**, not bundled into CCR. Build with
`pnpm --dir packages/plugins/gemini-oauth build`. The generated `dist/` contains
`plugin.js` (ESM), `card.js` (self-contained DOM UI), `plugin.json`, and
`package.json` (`type: module`). Publish/install only `dist/` contents.

Until the plugin installer CLI is available, copy the **contents** of `dist/`
into `$CCR_CONFIG_DIR/plugins/gemini-oauth/`, and include
`{"name":"gemini-oauth","enabled":true}` in the array stored at
`$CCR_CONFIG_DIR/plugins/plugins.json`. Activate on the next normal CCR start.
Do not copy source files into the install directory. Never move credentials
into the plugin directory: the existing `gemini-oauth-credentials.json` stays
at the config-dir root, with mode **0600**.

Disabling/removing the plugin does not delete config, credentials, or Router
references. Managed marker credentials fail closed (`plugin_missing`) until
it is installed and enabled again. Explicit Disconnect, not uninstall, is the
operation that deletes credentials and cleans the provider's Router references.

The OAuth client environment settings and the mandatory risk acknowledgement
are unchanged. The native DOM card delegates authenticated API calls, the shared
save/action mutex, and managed-provider draft reconciliation to the host. It
uses the existing UI pure login/state/merge helpers and exact EN/ZH risk copy.

Validation:
- `pnpm --dir packages/plugins/gemini-oauth test`
- `pnpm --dir packages/plugins/gemini-oauth exec tsc --noEmit`
- `pnpm --dir packages/plugins/gemini-oauth build`

Host modules are never bundled. The plugin consumes canonical core API **types**
only, erased by esbuild. The generic Gemini protocol conversion helper is
vendored from core (no state) so the installed plugin has no host import; only
strict-mode type annotations differ. Future shared protocol fixes must update
both copies and run the transformer suite.
