# Changelog

## [Unreleased]

## [2.3.2436] - 2026-11-24

### Added

- **Tool calling for the Agy ACP provider** (`@wengine-ai/ccr-provider-gemini-agy-acp` 0.2.0): a request that declares tools used to be rejected with `400 agy_unsupported_request`, so a caller routed to Agy for tool use fell back to another provider for that turn. It is now served. The plugin publishes the caller's tools to the agent through an MCP server bound to `127.0.0.1` (ephemeral port, random bearer token compared with `timingSafeEqual`, 1 MiB body / 64 tools / 64 KiB per schema caps); the agent raises a call, the caller receives it as `tool_calls`, and a follow-up request carrying the caller's results resumes the **same** ACP turn instead of starting a new conversation. The agent never executes anything — every tool result is one the caller returned, and a missing answer is reported back as an error rather than hanging the turn. The bridge descriptor, its token and the tool schemas travel only to the agent subprocess through `session/new`, never into a caller response, usage record or log. A tool set the agent cannot serve is an explicit `400` naming the reasons rather than a silent answer. Parked calls are keyed per caller (a resume only resumes the bridge whose parked calls are exactly the ones it answers, a strict bijection), any other turn avoids a worker holding a live parked call, and the default worker count is 2 because a parked call holds its worker warm. Tool requests are skipped for a family's text-only Agy candidate without booking an attempt or penalising health, so a tool request still reaches the family's capable providers.
- **Agy provider chain**: the management card drives the full opt-in flow (connect / disconnect / model sync / per-model hide) over loopback-only admin routes, with a non-reversible credential fingerprint instead of any key material; agy is auto-installed on first use when enabled (pinned vendor manifest, HTTPS-only, SHA-512 verified, payload allowlist), and installing never enables the provider — Connect stays the only enabling action. Google-account (OAuth personal) login is verified with a real bounded ACP handshake rather than `--version` alone, and the account email shown on the card comes exclusively from that handshake.

### Fixed

- **A stable upstream code survives a Chat stream error in the usage row.** A provider that reports a code-shaped error inside an HTTP 200 stream lost it, recording only `Chat stream returned an error`. The code is now kept; free-form upstream prose still is not, so usage rows and health messages never echo upstream text.
- **Usage accounting for Chat completions**: the final outcome is attributed to the provider that actually served it (including after failover), rejected and incomplete completions are recorded instead of silently dropped, and a terminal upstream 400 is booked once without a health penalty.
- **Codex rejection of streaming Chat requests that ask for token usage**: the Chat-only `include_usage` field is removed when converting to Responses.
- **Family routing with an empty default** resolves through its configured fallbacks instead of returning `404 provider_not_found` before reaching them.
- **Legacy Chat function calling** (`functions` / `function_call`) is recognised when deciding whether a route can serve a request.

## [2.3.2435] - 2026-11-23
