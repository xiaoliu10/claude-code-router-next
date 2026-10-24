# WorkBuddy browser authorization validation

## Automated checks

Run against existing dependencies; do not reinstall symlinked worktree modules:

```sh
cd packages/ui
node --experimental-strip-types --test tests/workbuddy*.test.ts
node node_modules/typescript/bin/tsc -b
```

28 mock/helper/API/structural tests cover explicit site selection, browser-login
start/poll/cancel request bodies, sequential polling, late-start/in-flight cancellation,
deadline cleanup, safe error allowlists, management/config-write mutex, managed-only
reconciliation, Router/draft preservation, and EN/ZH locale parity. Structural checks
are not mounted React tests.

Core tests additionally exercise browser-owned private refresh, desktop-refresh
exclusion, job capability isolation, cancellation across persistence, old-generation
sync/refresh versus disconnect, site locks, model discovery and route-level redaction.
No test calls the real WorkBuddy service or reads real desktop credentials.

## Current UI placement

Settings → Providers (`/settings?tab=providers`) owns `<WorkBuddyProvider>`.
The dashboard does not render the management card; successful authorization adds a
normal managed provider row and discovered models. Managed edit/delete navigates
back to the Settings tab with an explanation. An ordinary provider named `workbuddy`
remains ordinary. Enable is actual account authorization, not a visibility preference.

Browser authorization requires no WorkBuddy desktop installation. The user enters
passwords only on the upstream authorization page; CCR receives credentials only on
its backend. Browser-source refresh credentials are private to CCR; desktop-source
shared refresh credentials are never copied or spent. Desktop import API remains
compatible but is no longer the primary UI action.

## Isolated rendered browser smoke (executed)

2026-10-20 local validation used a fresh Playwright profile and a loopback mock server,
with all external traffic blocked. It did not access the live CCR instance or real
accounts. The font/template fetch errors in console are expected blocked resources.

Verified flow:

1. Dashboard has no WorkBuddy management card or unconfigured provider row.
2. Open Settings → Providers; select international site and start browser login.
3. Pending state displays explicit HTTPS authorization link, Cancel action, disabled
   Save/Save & Restart and other management actions. No token/path input exists.
4. Cancel clears pending state and unlocks controls; server cancel called once.
5. Restart authorization with a successful mock result; source/renewal become browser,
   discovered models and international GLM image warning appear.
6. Credits are requested only by pressing Read credits (one GET); failures are hidden.
7. Return to dashboard: one normal WorkBuddy row with the two discovered models,
   no duplicate management card. Edit navigates to the Settings Providers tab.
8. Request log: zero POST `/api/config`, unchanged Router default throughout, no actual
   secret returned to browser state. Screenshot: `output/playwright/workbuddy-browser-settings.png`.

## Remaining manual checks

Real CN/international authorization URLs, upstream model lists/inference, enterprise
accounts, remote deployment behavior and full keyboard/screen-reader audits still
need validation. If the actual upstream returns an unrecognized authorization host,
record only its hostname (no state/tokens) and extend the allowlist with evidence.
Do not restart the user's live CCR process without explicit approval.
