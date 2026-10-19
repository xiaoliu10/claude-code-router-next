# WorkBuddy UI validation

## Local automated checks (no auth files or upstream requests)

Requires Node with native TypeScript stripping (Node 22.6+; tested on Node 26.4.0).
Existing UI dependencies only; no package installation or lockfile changes.

```sh
cd packages/ui
pnpm --config.verify-deps-before-run=false run test:workbuddy
pnpm --config.verify-deps-before-run=false exec tsc -b
pnpm --config.verify-deps-before-run=false run build
```

The pnpm option disables pnpm 11's pre-run dependency auto-install in symlinked
worktrees. Do not permit it to reinstall the main checkout's node_modules.

Tests cover the exact four endpoint paths/verbs/bodies, safe allowlisted errors,
configuration-write interlock, model-result success validation, exact managed
marker, preservation of local drafts/Router/ordinary providers, disconnected
provider reconciliation, masked UID and locale parity. Structural assertions
are **not** React-rendered interaction tests. No DOM test library is installed.

## Component API / refresh integration

`<WorkBuddyProvider disabled={boolean} onBusyChange={(busy) => ...} />` uses
`ConfigProvider` and i18next. Disable it while generic provider edit/delete/save
is pending. Its explicit actions lock generic config writes until both mutation
and reconciliation finish. `refreshConfig(mergeWorkBuddyProvider)` merges only
the backend-owned WorkBuddy provider into current config; Router/transformer
and unrelated provider drafts are not replaced. Existing no-argument callers
retain full-refresh behavior.

Generic managed edit/delete callbacks focus this card instead of opening the
ordinary dialog. Neither route calls generic deletion/model cleanup. Only the
confirmed disconnect action removes credentials/provider. Enabled/proxy toggles
remain ordinary controls; model sync must preserve the backend's disabled flag.

## Isolated browser smoke checklist (not yet executed)

Use a fresh browser profile and isolated mock admin server, never a live CCR
instance or real desktop login. Mock `/api/config`, `/api/transformers`, provider
telemetry and templates as well as all `/api/workbuddy/*` requests. Block external
requests. Do not press the existing app's Save and Restart against live CCR.

1. In both EN and ZH, open Providers: built-in section appears above ordinary
   providers. Status GET runs once per mount (StrictMode may mount twice), never
   import or sync. Privacy text explains **CCR server host**, fixed upstream,
   no browser/config token, backup exclusion, encrypted-file limitation.
2. `not_connected`: import opens a consent dialog; unchecked consent prevents
   POST. Check consent, submit; delay response and double-click: one POST `{}`.
   Close/unmount during a pending read and verify no stale status update.
3. Mock import success with nonempty models and connected status: config reload
   updates models, toast confirms count, Router default/draft and unrelated
   transformer/provider edits stay byte-for-byte unchanged.
4. Mock 422 sealed/source_missing/source_invalid/models_fetch_failed, 409
   name-conflict, 500, network failure and 200 success with empty models: safe
   localised visible errors, no success toast and no cleared previous model list.
   Put a synthetic secret in error.message: no secret in DOM or console.
5. Mock connected status with masked UID, count, expiry and sync timestamp. Sync
   refreshes backend models; provider `enabled:false` remains disabled. Expired
   status offers re-import, not refresh. Restriction diagnostic 11140 displays
   appeal guidance. No secret input/credential-file path selector exists.
6. Generic edit/delete of managed WorkBuddy focus management with explanation;
   no URL/key/name/transformer edit dialog and no generic delete/config POST.
   An ordinary provider named workbuddy remains ordinary and is not taken over.
7. Disconnect requires confirmation mentioning source login untouched and Router
   references retained/manual update. Confirm calls disconnect once, refreshes
   managed provider out of config, preserves all Router refs and other providers.
8. While import/sync/disconnect/reconciliation is pending, generic saves/toggles
   cannot overlap. While a top-level full-config save is pending, WorkBuddy shows
   a safe busy error instead of mutating. All WorkBuddy buttons prevent overlap.
9. Keyboard: tab/space consent, dialog focus and escape when idle, error alerts,
   model details disclosure; narrow-width wrapping and no horizontal overflow.

## Limits

No real account, upstream schema/model availability, inference/channel support,
rendered browser accessibility, or cross-tab/process config-write races have
been verified by UI tests. Same-page interlocking is not distributed locking;
backend must serialize/reject competing writes. The API must never send actual
credentials to the browser in any response, including successful payloads.
