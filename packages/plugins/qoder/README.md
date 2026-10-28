# @wengine-ai/ccr-provider-qoder

Qoder subscription provider plugin for [claude-code-router](https://github.com/wengine-ai/claude-code-router-next) (qoder.com international only).

## What it provides

- **Transformer** (`qoder`): unified → chat-completions request conversion (leading system message, thinking → `reasoning_content`, stable session id → `prompt_cache_key`, reasoning effort passthrough) and strict SSE/JSON response validation (error-frame classification, `[DONE]` integrity, usage mapping).
- **Managed runtime** (`qoder-subscription`): pins the fixed `api3.qoder.sh` chat upstream, routes through the host's subscription dispatcher, owns abort/deadline wiring and the error taxonomy (`qoder_reauth_required`, `qoder_rate_limited` with `retry_after`-derived cooldown, `qoder_upstream_error`).
- **Auth service**: PAT sign-in with the job-token engine, credential file `qoder-credentials.json` (0600, atomic, size-capped), model sync/visibility, usage reads with a 60s cache, cooling circuit breaker and reconnect.
- **Admin routes** (`/api/qoder/*`, loopback-only): status, connect, sync, usage, model visibility, disconnect.
- **UI card + locales** (en/zh): PAT connect form, status, quota windows, model management.

## PAT setup

1. Sign in at [qoder.com](https://qoder.com) and open **Account → Integrations** (`qoder.com/account/integrations`).
2. Create a personal access token (starts with `pt-`).
3. In the CCR settings page, open the Qoder card, paste the token and press **Connect**. The token is kept only in the plugin's private credential file and is cleared from the form immediately.
4. Press **Refresh models** to sync the model list.

## Scope limits

- qoder.com international ONLY (`openapi.qoder.sh` / `api3.qoder.sh`). No device flow, no campaigns/check-in, no VPC, no qoder.cn/QwenWork.
- Sign-in is PAT-only; the job token is refreshed from its refresh token when present, and a lapsed/absent refresh falls back to PAT re-exchange (a refused PAT marks the account expired until you reconnect). The PAT is kept in the plugin's private 0600 credential file.

## Development

```sh
pnpm install     # standalone package deps
pnpm vitest run  # fully offline tests (all fetch mocked/injected)
pnpm tsc --noEmit
pnpm build       # produces dist/ (self-contained plugin + UI card bundles)
```

Tests never touch the network: every engine is injected via `options.engine`, every fetch is mocked.
