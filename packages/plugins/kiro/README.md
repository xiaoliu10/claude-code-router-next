# Kiro subscription authentication

This package provides Kiro subscription sign-in and account management for CCR. The authentication entry point can be built and loaded independently; the browser card and request transformer are supplied by separate integration work. Chat requests require that integration.

Run `npm test`, `npx tsc --noEmit -p tsconfig.json`, and `npm run build` from this directory.

Choose `portal` for Google/GitHub at https://app.kiro.dev/signin, `builderid` for personal AWS Builder ID, or `idc` with an organization's HTTPS Start URL and AWS region (default `us-east-1`). All flows use authorization codes with PKCE. The service tries the Kiro callback port pool and listens on 127.0.0.1. For a browser on another computer, paste the complete final callback URL; the page need not load in that browser. Sessions expire after ten minutes. Starting another login cancels the pending session.

Local admin endpoints use the `/api/kiro` prefix and require a loopback socket, a local Host authority and, when present, a local Origin:

| Method | Path | Body / response |
| --- | --- | --- |
| GET | `/status` | `{ connected, status, providerName, accounts, models, hiddenModels, plan, usage }` |
| POST | `/login/start` | `{ method: "portal" | "builderid" | "idc", startUrl?, region? }` → `{ loginId, url }` |
| POST | `/login/poll` | `{ loginId, callbackUrl? }` → `{ status, account?, url? }` |
| POST | `/login/complete` | `{ loginId, callbackUrl }` → `{ status, account?, url? }` |
| POST | `/login/cancel` | `{ loginId }` → `{ status }` |
| POST | `/sync` | `{ account? }` → `{ success: true, models }` |
| POST | `/usage` | `{ account? }` → normalized plan, user and credit windows |
| POST | `/disconnect` | `{ account? }` → `{ success: true }` (omission removes all accounts) |
| POST | `/models/visibility` | `{ model, hidden }` → `{ success: true }` |

Login status is `pending`, `complete`, `cancelled`, `expired`, or `failed`. Portal selection of an AWS method returns another `pending` URL for the AWS authorization stage. Errors return `{ success: false, error: "kiro_..." }`; raw upstream errors and tokens never enter responses. Upstream 401 is represented as an admin error code with HTTP 500, consistent with other subscription plugins and avoiding a router-login prompt.

Credentials are stored in the host config directory as `kiro-credentials.json` with mode 0600, bounded reads, no symlink traversal, exclusive temporary writes, fsync and atomic replacement. Version 1 contains `accounts`, shared `models`, and shared `hiddenModels`. The legacy `{ version: 1, credential, models, hiddenModels }` envelope and accessToken/refreshToken/expiresAt/profileArn aliases are accepted. Accounts use a durable random `id` and a login-provider `uid`; email plus uid determines replacement. A Google and GitHub account with the same email remain distinct. Public account records contain no credentials. Usage is cached in memory per account.

A token is fresh only when more than two minutes remain. Refresh is single-flight per account. The sign-in region (the AWS directory region or the portal region) reaches only the token endpoints: Google/GitHub use `prod.<signInRegion>.auth.desktop.kiro.dev/refreshToken`; AWS uses `oidc.<signInRegion>.amazonaws.com/token` with the registered client. Kiro's own API — management and runtime — is called in the region the account's profile ARN names (`management.<profileRegion>.kiro.dev`), never in the directory region; Builder ID's fixed `us-east-1` profile keeps it on `us-east-1`. A login with no profile ARN discovers one across Kiro's regions (`us-east-1`, `eu-central-1`) and adopts the region that ARN names. Explicit 401/403, and an OAuth token/refresh answer that is permanently refused (`400` with `invalid_grant`, `invalid_client`, `invalid_scope`, `unauthorized_client`, `invalid_token` or `access_denied`), marks that account as requiring reauthentication and sets a one-hour cooldown; the vendor's `error_description` is read at a bounded size and never surfaced. A transient refresh `400` or `5xx` stays `kiro_upstream_error` without marking the account. A rotated token from a refresh that loses a race with a concurrent cooldown/reauth update is merged into the current account record, keeping that metadata, and only a real disconnect or a new sign-in with different credentials refuses it. All requests use regional fixed origins, disable redirects, send `Accept-Encoding: identity`, and prefer the subscription dispatcher.

A login that trades an authorization code and then fails to look up the identity, build the token, write the config or persist the credentials ends as `failed` and releases its listener and timer: the code is single-use, so leaving it pending would strand the session with no retry. A callback rejected before a code is traded (wrong state, host or path) leaves the session pending.

Model sync follows pagination and puts the default model first. One managed config provider (`kiro-subscription`, marker `ccr-managed-kiro`) holds visible model IDs, never tokens. Account omission chooses the first usable account. Model visibility applies across accounts; syncing one account replaces the shared catalog.

Compared with the magpie reference, this implementation adds CCR managed config persistence, multi-account storage, local authenticated admin routes, paginated subscription model listing, and durable reauthentication/cooldown state. It does not import CLI/IDE credentials, handle API keys/external identity providers, or implement the chat protocol. The Kiro service region follows the profile ARN as the reference does; the sign-in region is kept separately for the token endpoints. Initial identity discovery must succeed so an email-less login cannot silently create duplicate accounts.
