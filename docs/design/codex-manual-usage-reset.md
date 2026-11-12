# Codex manual usage reset

Date: 2026-11-12. Status: implemented against the verified upstream contract (openai/codex `main` @ `c0cc9fc8`).

## Intent and constraints

Add an explicit manual usage-reset control to the Codex provider card, exposing and enforcing the account's reset-credit allowance. No real account reset allowance may be consumed during development or validation. Do not change/restart the running CCR service. Reset operations must only execute on an intentional user action; mount, polling, quota refresh and retries must never invoke them.

## Upstream contract (openai/codex backend-client, verified from source)

`codex-rs/backend-client/src/client/rate_limit_resets.rs` + `types.rs`:

- **GET** `{chatgpt.com/backend-api}/wham/rate-limit-reset-credits` →
  `{ credits: [{id, reset_type, status: "available"|"redeeming"|"redeemed", granted_at, expires_at?, title?, description?}], available_count, total_earned_count }`.
- **POST** `{base}/wham/rate-limit-reset-credits/consume` body
  `{ redeem_request_id: <uuid>, credit_id?: string }` →
  `{ code: "reset"|"nothing_to_reset"|"no_credit"|"already_redeemed", windows_reset }` (snake_case enum).
- The **usage** endpoint (`/wham/usage`) also carries optional `rate_limit_reset_credits: {available_count}`.
- Client identity: same management headers as other admin calls (Bearer, `chatgpt-account-id`, codex UA). The CLI consumes with a fresh UUID per confirmation; on transport failure it **retries the same idempotency key** and re-lists credits afterwards.
- Outcomes are backend-owned: `nothing_to_reset` (usage already fresh), `no_credit` (allowance exhausted), `already_redeemed` (this credit was spent), `reset` (success).

## Design

- **Service** (`auth-service.ts`):
  - `getResetCredits(): Promise<CodexResetCredits | null>` — GET details; normalized fail-closed (`parseCodexResetCredits`), non-fatal on upstream failure. Auth = `getAccessToken` (auto-refresh as usual). Caching: short TTL like usage, plus a **local spent marker** (see below).
  - `consumeResetCredit(creditId?: string): Promise<CodexResetConsumeResult>` — explicit-only. The busy latch is assigned synchronously before any await (a second concurrent call is rejected `codex_reset_busy`, never queued — two queued consumes could both redeem). The `redeem_request_id` idempotency key is minted per confirmation and RETAINED across retries of the same credit until a terminal outcome: upstream dedupes per key, so a lost response cannot double-spend. Maps outcome codes; terminal outcomes clear the local usage/reset caches, mark the credit spent locally and re-list for the authoritative count.
  - **Local spent marker**: after a confirmed `reset`/`already_redeemed` outcome the credit id is recorded in memory (cleared on disconnect/account switch), so a known-spent credit cannot be re-consumed within the service lifetime; the authoritative count always comes from upstream listing. Reset caches and the spent set are per-account identity: they are cleared on login completion and disconnect.
  - **Allowance enforcement is upstream-owned**: the card disables the control when `available_count <= 0` or unknown; `no_credit` outcome surfaces a stable error. We never fabricate counts, never retry automatically, and never consume on mount/poll/refresh.
- **Route** (`admin-routes.ts`): `GET /api/codex/reset-credits` + `POST /api/codex/reset-credits/consume` `{creditId?}` — same local-only guard, same error envelope, consume maps `codex_reset_busy`→429, `codex_reset_no_credit`→409, `codex_reset_unavailable`→502, reauth→422.
- **Card** (`card-entry.ts`/`card-types.ts`/`locales.ts`): a "Reset usage limits" row in the usage box (existing style): shows `available_count` ("N available"), confirmation dialog ("Use this reset?"), consumes only on explicit confirm; busy/disabled states; outcome toasts (`nothing to reset`, `no resets available`, success with remaining count); retry keeps the same idempotency key within one card session.

## Not covered / decisions

- Real-account consume was **not** executed (constraint). The mapping of `redeem_request_id` idempotency semantics is taken from upstream source, not probed live.
- The `luna reserve` opt-in header is irrelevant for plain usage/reset reading; not sent.
- The card keeps upstream `available_count` as the single source of truth; a stale local marker only prevents double-consume within one service lifetime.
