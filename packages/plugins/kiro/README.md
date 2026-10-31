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

A token is fresh only when more than two minutes remain. Refresh is single-flight per account. Google/GitHub use `prod.<region>.auth.desktop.kiro.dev/refreshToken`; AWS uses `oidc.<region>.amazonaws.com/token` with the registered client. Explicit 401/403 marks that account as requiring reauthentication and sets a one-hour cooldown. All requests use regional fixed origins, disable redirects, send `Accept-Encoding: identity`, and prefer the subscription dispatcher.

Model sync follows pagination and puts the default model first. One managed config provider (`kiro-subscription`, marker `ccr-managed-kiro`) holds visible model IDs, never tokens. Account omission chooses the first usable account. Model visibility applies across accounts; syncing one account replaces the shared catalog.

Compared with the magpie reference, this implementation adds CCR managed config persistence, multi-account storage, local authenticated admin routes, paginated subscription model listing, and durable reauthentication/cooldown state. It does not import CLI/IDE credentials, handle API keys/external identity providers, or implement the chat protocol. Region is preserved exactly as supplied per account rather than collapsed to the reference's US/EU region heuristic. Initial identity discovery must succeed so an email-less login cannot silently create duplicate accounts.
