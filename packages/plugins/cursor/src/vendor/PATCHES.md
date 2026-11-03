# Vendor patches — src/vendor/engine.mjs

Upstream: [magpie-community/plugins](https://github.com/magpie-community/plugins)
`packages/cursor/index.mjs` @ `bace91473b4f113a719a49b7d8ce81fe1f5b5760`
(published as `@magpie-community/opencode-cursor-auth` 0.2.26, MIT).
`native-session.mjs` is copied **verbatim** — zero deviations.

Every deviation from upstream is listed here and marked with a `CCR:` comment
in the source. Nothing upstream exports or behavior changes when the host
does not call `configureCursorEngine` — that is the state every vendored
test runs in.

| # | Upstream line(s) | Deviation | Why |
|---|---|---|---|
| 0 | 1–4 | Added a 4-line MIT/provenance header comment. Comment only. | License attribution must ride the vendored file. |
| 1 | 41–60 (inserted after imports) | New module-level `injectedFetch` / `h2Enabled`, exported `configureCursorEngine({ fetch, h2 })`, and `netFetch()` helper. | Dependency injection: the host supplies its subscription-dispatcher fetch so fixed Cursor origins honor `SUBSCRIPTION_PROXY_URL`. |
| 1a | 289 (`unary`) | `fetch(` → `netFetch(`. | Transport injection (covers GetMe, GetPlanInfo, AvailableModels, GetUsableModels, GetServerConfig). |
| 1b | 343 (`keyToken` exchange) | `fetch(` → `netFetch(`. | Transport injection. |
| 1c | 393 (`browserSignIn` poll) | `fetch(` → `netFetch(`. | Transport injection. |
| 1d | 520 (`hardLimit`) | `fetch(` → `netFetch(`. | Transport injection. |
| 1e | 545 (`usage` GetCurrentPeriodUsage) | `fetch(` → `netFetch(`. | Transport injection. |
| 1f | 601 (`botUsage` get-sand-usage-status) | `fetch(` → `netFetch(`. | Transport injection. |
| 1g | 1732 (`usageEvents` GetFilteredUsageEvents) | `fetch(` → `netFetch(`. | Transport injection. |
| 1h | 2145 (`openH1` BidiAppend) | `fetch(` → `netFetch(`. | Transport injection (the whole HTTP/1.1 data plane must ride the dispatcher under a proxy). |
| 1i | 2172 (`openH1` RunSSE) | `fetch(` → `netFetch(`. | Transport injection. |
| 2 | 2001 (`open`) | Gate is now `h2Enabled && Date.now() >= h1Until`. | `node:http2.connect` opens direct sockets and cannot traverse an undici `ProxyAgent`; when the host configured a subscription proxy, every Run — including the region retry — must go HTTP/1.1 through the dispatcher. Default (`h2Enabled = true`) keeps upstream's H2-first behavior. |
| 3 | 373–393 (`browserSignIn`) | Function now takes an optional `AbortSignal`; each poll checks it and the poll fetch combines it with its 15 s timeout via `AbortSignal.any`; an aborted loop returns `{ type: "failed", error: "the sign-in was cancelled" }`. | The CCR admin surface exposes a Cancel button on a pending browser sign-in; upstream's loop could only be abandoned, not stopped. |
| 4 | 3109 (`_internal`) | Extended (nothing removed) with `answer, answerOf, browserSignIn, cliSignIn, keyToken, tokenOf, whoIs, planOf, botUsage, usage, runtimeModel, agentURL, unary, clientVersion, AuthError, CLI_MARK, API, WEBSITE, AGENT, ID`, and a `resetCaches()` that clears the per-token caches (`endpoints`, `lists`, `plans`, `exchanged`, `maxOnly`, `h1Until`, `versionSaid`). | The CCR adapter drives the engine directly (it does not use the OpenCode `CursorAuthPlugin` loader); `resetCaches` gives disconnect real teardown of account-scoped engine state. |

## Deliberately NOT patched

- The OpenCode plugin surface (`CursorAuthPlugin`, `chat.headers`, `config`,
  `provider` hooks) is kept intact — the vendored test suite exercises it and
  it documents upstream behavior.
- `native-session.mjs`: verbatim (0 deviations). Cancellation of retained
  native owners happens through its public `nativeSessions` pool.
- All module-level caches stay process-wide and token-keyed exactly as
  upstream; CCR runs one Cursor account per process, matching upstream's
  single-account assumption.
