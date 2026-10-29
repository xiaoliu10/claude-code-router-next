# @wengine-ai/ccr-provider-qoder

Qoder subscription provider plugin for [claude-code-router](https://github.com/wengine-ai/claude-code-router-next), covering both Qoder sites: **qoder.com** (international) and **qoder.cn** (Qoder CN).

## What it provides

Everything below exists once per site; the two sites are independent (own account, own credentials, own models, own quota):

| | international | Qoder CN |
|---|---|---|
| managed provider | `qoder-subscription` | `qoder-cn-subscription` |
| marker credential | `ccr-managed-qoder` | `ccr-managed-qoder-cn` |
| credential file | `qoder-credentials.json` | `qoder-cn-credentials.json` |
| fixed chat upstream | `api3.qoder.sh` | `gateway.qoder.com.cn` |
| admin routes | `/api/qoder/*` | `/api/qoder/cn/*` |
| transformer | `qoder` | `qoder-cn` |

- **Transformer** (`qoder` / `qoder-cn`): unified → chat-completions request conversion (leading system message, thinking → `reasoning_content`, stable session id → `prompt_cache_key`, reasoning effort passthrough) and strict SSE/JSON response validation (error-frame classification, `[DONE]` integrity, usage mapping). The conversion is site-independent; each managed provider locks its own transformer name.
- **Managed runtime** (`qoder` / `qoder-cn`): pins that site's fixed chat upstream, routes through the host's subscription dispatcher, owns abort/deadline wiring and the error taxonomy (`qoder_reauth_required`, `qoder_rate_limited` with `retry_after`-derived cooldown, `qoder_upstream_error`). A runtime claims only its own managed provider.
- **Auth service**: PAT sign-in with the job-token engine, per-site credential file (0600, atomic, size-capped), model sync/visibility, usage reads with a 60s cache, cooling circuit breaker and reconnect.
- **Admin routes** (loopback-only, per site): status, connect, sync, usage, model visibility, disconnect.
- **One config protector**: re-locks BOTH managed providers in a single pass and re-adds any of them that vanish from the config.
- **UI card + locales** (en/zh): one card with two independent sections (Qoder / Qoder CN) — PAT connect form, status, quota windows, model management.

## PAT setup

For the international site:

1. Sign in at [qoder.com](https://qoder.com) and open **Account → Integrations** (`qoder.com/account/integrations`).
2. Create a personal access token (starts with `pt-`).

For Qoder CN, do the same on [qoder.cn](https://qoder.cn) (the token exchange runs against `openapi.qoder.com.cn`).

Then, in the CCR settings page, open the Qoder card and use the matching section (**Qoder** or **Qoder CN**):

3. Paste the token and press **Connect**. The token is kept only in that site's private credential file and is cleared from the form immediately.
4. Press **Refresh models** to sync the model list.

Both sections can be connected at the same time; disconnecting one never touches the other.

## Scope limits

- Remote origins are fixed per site: `openapi.qoder.sh` / `api3.qoder.sh` for qoder.com and `openapi.qoder.com.cn` / `gateway.qoder.com.cn` for qoder.cn. No device flow, no campaigns/check-in, no VPC, no QwenWork.
- Sign-in is PAT-only; the job token is refreshed from its refresh token when present, and a lapsed/absent refresh falls back to PAT re-exchange (a refused PAT marks that site's account expired until you reconnect). The PAT is kept in the plugin's private 0600 credential file.

## Development

```sh
pnpm install     # standalone package deps
pnpm vitest run  # fully offline tests (all fetch mocked/injected)
pnpm tsc --noEmit
pnpm build       # produces dist/ (self-contained plugin + UI card bundles)
```

Tests never touch the network: every engine is injected via `options.engine`, every fetch is mocked.
