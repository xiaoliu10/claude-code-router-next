# @wengine-ai/ccr-provider-cursor

Cursor subscription provider plugin for [claude-code-router](https://github.com/wengine-ai/claude-code-router-next). Signs in to a [Cursor](https://cursor.com) subscription (Pro, Pro+, Ultra, Teams) and runs requests on the API `cursor-agent` talks to.

| | |
|---|---|
| managed provider | `cursor-subscription` |
| marker credential | `ccr-managed-cursor` |
| credential file | `cursor-credentials.json` (0600, config dir root) |
| admin routes | `/api/cursor/*` |
| transformer | `cursor` |

## What it provides

- **Transformer** (`cursor`): unified → chat-completions request conversion (leading system message, thinking → `reasoning_content`, stable session id → `prompt_cache_key`, reasoning effort passthrough, data-URL user images kept / remote-URL images → placeholder text) and strict SSE/JSON response validation (error-frame classification, `[DONE]` integrity, usage mapping).
- **Managed runtime** (`cursor`): owns the data plane through the vendored engine, abort/deadline wiring and the error taxonomy (`cursor_reauth_required`, `cursor_rate_limited`, `cursor_region_restricted`, `cursor_permission_denied`, `cursor_invalid_request`, `cursor_unavailable`, `cursor_upstream_error`).
- **Auth service**: the three sign-ins Cursor accounts have, model sync, usage reads with a 60s cache, cooling circuit breaker and reconnect.
- **Admin routes** (loopback-only): status, browser login start/poll/cancel, CLI import, API-key connect, sync, usage, disconnect.
- **Config protector**: re-locks the managed entry in place on every config write and re-adds it if it vanishes.
- **UI card + locales** (en/zh): sign-in flows, status, quota windows, model list.

## Signing in

One Cursor account per CCR instance; three ways to make it:

1. **Browser** — press *Sign in with browser*. The plugin starts the same PKCE sign-in `cursor-agent` does (`cursor.com/loginDeepControl`), you finish it in the browser, and `/auth/poll` hands the token over; the card polls until then and offers a Cancel button.
2. **CLI import** — press *Import cursor-agent sign-in* after running `cursor-agent login` on this machine. The token is read fresh from where cursor-agent keeps it (the macOS Keychain or its `auth.json`) on every request and never written by this plugin. cursor-agent renews its own token; nothing here pretends to.
3. **API key** — paste a key from `cursor.com/dashboard → Integrations`. It is exchanged for a token per request, the way the CLI does with `CURSOR_API_KEY`.

**Browser tokens are never renewed.** Cursor's browser sign-in has nothing to refresh it with; when the token expires the plugin latches `cursor_reauth_required` and the card asks for a fresh sign-in. This is honest, not a defect: renewing would require pretending the engine has a refresh path it does not have.

Then press **Refresh models** to sync the model list (Cursor's picker, one entry per context size).

## Data plane

Each CCR host attempt invokes a request-local virtual dispatcher, which runs exactly one engine dispatch without opening a socket or forwarding the marker credential. The host still runs its policy, signing, timeout initialization and error classification. A retained native tool Run can span attempts; every tool continuation still enters a fresh host attempt and attaches that attempt's signal until its response body finishes. Disconnect separately cancels retained owners.

Requests go to Cursor's agent API (`AgentService/Run`, a Connect stream both ways over **HTTP/2** by default). Where HTTP/2 can't open a Run, the engine falls back to its own HTTP/1.1 lane (`RunSSE` + `BidiAppend` on api2) exactly as upstream does.

**Caveat under a subscription proxy:** when `SUBSCRIPTION_PROXY_URL` is set, Node's `http2` cannot traverse the host's proxy dispatcher. The plugin then pins the **entire** data plane to HTTP/1.1 through the proxy — including the engine's own region retry — so no request bypasses the proxy. Without the proxy setting, HTTP/2 is used (fastest lane), with upstream's automatic H1 fallback on transport failures.

Conversations keep a stable `conversation_id` derived from the session's `prompt_cache_key`, so Cursor's backend keeps prompt caches on one machine. The caller's tools are served as Cursor MCP tools (`CallDynamicTool`); a live native Run continues across tool round-trips when ownership allows, else the history rebuilds a stateless Run. Nothing Cursor asks the client to run besides the caller's own tools (a shell, a file read) is ever run.

## Usage accounting

The engine counts usage from Cursor's dashboard events per conversation; `prompt_tokens` is inclusive of cached input (the core subtracts `cached_tokens`), `cache_write_tokens` is mirrored to `cache_creation_input_tokens`, and deferred counts ride through as-is. Quota windows come from the dashboard's billing period and the Grok Bot allowance; an unreadable window renders as *Quota unknown* — never as fabricated numbers.

## Honesty notes / limitations

- **H1 under proxy**: see above; HTTP/2 and the subscription proxy are mutually exclusive by platform constraint.
- **Upstream checkpoint test known-failing**: the vendored engine's own suite has one known-failing test (background checkpoint reference closure while a Run is parked). It is ported **skipped-with-comment**, not deleted and not fake-passed; see `test/native-e2e.test.mjs`.
- **Real account UNVERIFIED**: this build was validated against the upstream offline test suite and adapter tests only. No live Cursor account was used; sign-in flows, the H2/H1 lanes and quota windows against the real API are UNVERIFIED.
- **No host disposal hook (coreApi=1)**: disconnect aborts the plugin's own in-flight requests and cancels this account's retained native owners, and the host has no provider-disposal hook a plugin could use for process-shutdown cleanup. Request aborts and deadlines remain linked through the response body; retained tool Runs are bounded by the engine lifetime and cancelled on disconnect.
- **One account per process**: the engine keeps per-token caches process-wide, matching upstream's single-account design.

## Third-party

`src/vendor/engine.mjs` and `src/vendor/native-session.mjs` are vendored from [magpie-community/plugins](https://github.com/magpie-community/plugins) `packages/cursor` @ `bace91473b4f113a719a49b7d8ce81fe1f5b5760` (MIT), with the small dependency-injection patches listed in `src/vendor/PATCHES.md`. See `THIRD_PARTY_NOTICES.md` for the full license text.
