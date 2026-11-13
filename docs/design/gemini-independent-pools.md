# Independent Antigravity quota pools

Status: implementation planning. Date: 2026-11-13.

## Intent and constraints

A quota error from Gemini Argon must not park Hydrogen or Claude; each independent pool must show its own remaining quota/reset. Keep token refresh, login/verification protection and other provider plugins compatible. Tests use fixture credentials/fake fetch only. Never change/restart the running CCR service or read its credentials. Deliver an OPEN PR, no release/deployment without new authorization.

## Current code evidence

- `packages/plugins/gemini-oauth/src/protocol.ts`: quota fetch returns per-model buckets and named summary groups; `geminiQuotaToProviderQuota` currently picks the worst pool per window for the legacy provider summary. Effort folding strips only effort suffixes, preserving argon/hydrogen model identity.
- `src/auth-service.ts:noteUpstreamError` persists every error into one `account.cooldownUntil`; `src/plugin.ts:ensureUsable` blocks the entire account.
- `packages/core/src/provider-plugins/types.ts`: ensureUsable/probeAccountState have no model argument; noteUpstreamError also loses the request model. `api/routes.ts` calls the breaker before transformation and before send; `api/plugin-response-error.ts` owns HTTP/hidden error bookkeeping. Transformer response errors and successes must carry their own request context (no shared instance last-model field).
- `services/active-probe.ts:runManagedRecoveryProbe` groups all open models by provider, probes only the first, then recovers every sibling. That incorrectly assumes every subscription has one quota pool.
- Plugin DOM card has no quota section; admin routes are local-guarded. Add a read-only, short-TTL shared quota snapshot route and render independent rows.

## External primary evidence

- Google collaborator response on `google-antigravity/antigravity-cli#1399` (2026-11-02): AI Pro has a distinct `GEMINI 4 ARGON` weekly group; Ultra may share the Gemini pool. Preserve upstream group names instead of assuming one pool layout across plans. Source: https://github.com/google-antigravity/antigravity-cli/issues/1399#issuecomment-6591444376 (exact comment URL verified using `gh api`; also verified by web search).
- CLIProxyAPI issue `#6643` describes concurrent older successes clearing a fresh quota cooldown: https://github.com/router-for-me/CLIProxyAPI/issues/6643. This supports preserving active quota locks across late successes. Issue `#5842` concerns trusted retry deadlines, not pool membership: https://github.com/router-for-me/CLIProxyAPI/issues/5842. These are first-party incident reports, not a normative API contract.
- Project decision: user confirmed independent Argon/Hydrogen/Claude pools for this account. Unknown future model families isolate conservatively; percentages alone never establish sharing.

## Implementation topology

Multi-seam; exclusive ownership in isolated worktrees:

1. Parent owns core seam/types/call sites/probe isolation and final integration, design doc, PR.
2. Backend child owns gemini protocol/auth-service/plugin/transformer plus backend tests; commits durable handoff.
3. UI child owns new quota-view helper, card-entry/locales/admin-routes and card/admin tests; commits durable handoff.
4. Independent read-only reviewer audits combined diff after integration.

No concurrent writers share a worktree. Backend owns shared pool/quota service contracts; UI consumes the contract below. Parent integrates only after child handoffs.

## Candidate approaches

A. Only change the plugin to skip global 429 cooling. Small but retries still hit exhausted pools, probes restore unrelated pools, display remains ambiguous. Rejected.
B. Add optional model context to the generic runtime seam, persist pool locks inside the gemini plugin, opt into per-model managed recovery, preserve pool rows in a dedicated quota route. Recommended; existing no-arg runtimes continue working.

## Shared contracts (implementation target)

Core optional context: `ManagedRequestContext { model?: string; provider?: LLMProvider; requestState?: object }`. A stable per-attempt requestState lets the plugin retain an account identity/epoch guard in a WeakMap, rejecting old-account late completions without giving credential details to core. `ensureUsable(context?)`, `noteUpstreamError(info, context?)`, `probeAccountState(context?)`. Core passes the selected model at both dispatch gates and HTTP/hidden-error bookkeeping. `ManagedRuntime.modelScopedRecovery?: boolean` opts into independent per-model recovery (do not restore every sibling). Existing providers keep account-group recovery.

Pool resolution: known independent pools `gemini-4-argon`, `gemini-4-hydrogen`, `claude` (Claude variants share the Claude pool); effort variants normalize to their family; other unknown models isolate conservatively by normalized family, never infer sharing from equal percentages. Include alias/version normalization only with evidence. Account-level reauth/verification/identity errors stay account-scoped. Quota errors without a model must NOT invent an all-account quota lock; pre-upgrade quota locks cannot be reliably assigned and must not strand healthy pools.

Backend service additions (optional on GeminiOauthAuthServiceLike for fixtures/backward compatibility):
- `getPoolCooldown(model: string): Promise<{ pool: string; until: number } | null>` (or equivalent) queried before any network call;
- `noteUpstreamError(info, model?: string)` and `noteRequestSuccess(model?: string)` keep sibling locks intact;
- `getQuota(): Promise<GeminiOauthQuotaSnapshot | null>` returns short-TTL single-flight snapshot, with auth/verification guards and account identity/epoch invalidation. Both runtime fetchQuota and admin route consume SAME cache.
- `GeminiOauthQuotaSnapshot` remains `{ models: Record<string,{remaining:number;resetAt?:string}>, pools:Array<{pool:string;window:string;remaining:number;resetAt?:string}> }`. Backend can add optional metadata, UI must tolerate absence. No invented weekly data from per-model buckets.

Admin/UI: `GET /api/gemini-oauth/quota` returns snapshot or null, same local guard/error envelope as status. UI reads once when connected/partially cooling and offers refresh; never sends chat. Separate Argon/Hydrogen/Claude rows show actual model buckets and their reset times; upstream summary windows remain explicitly grouped and must never be reassigned to independent models without mapping evidence. Unknown/missing is unavailable, not zero usage or full allowance. en/zh parity; DOM textContent only; host classes. Clear/drop stale account responses using generation counters on login/disconnect/unmount.

## Verification targets

- Argon 429 blocks Argon effort siblings before refresh/send; Hydrogen/Claude remain usable. Symmetric Hydrogen and Claude cases, restart persistence, expiry, success does not clear sibling lock.
- HTTP 429, hidden JSON-200 errors, first/mid-stream SSE errors all attribute the dispatched model correctly under concurrency/fallback.
- Account reauth/verification still gate all pools; old credentials load safely and old quota-only account locks do not park every pool.
- Probe success for Hydrogen cannot recover Argon; other provider behavior unchanged.
- Shared quota caching single-flight, failure degrade, account switch invalidation, local route guards, card disabled/unmount, unknown/expired quota.
- All validation isolated from live CCR. Public diff/history must contain no secrets, server IPs or business domains.

## Blind spots

Upstream pool sharing must not be inferred from model labels alone beyond the user's explicitly confirmed Argon/Hydrogen/Claude separation. Detailed quota summary may expose broader groups; retain original group identity rather than fabricate individual weekly limits. External research and exact verification evidence to be added.

## Follow-ups (from the integrated-diff review, 2026-11-13)

- Core scopes model-level failure budgets by bare `statusCode === 429`
  (`plugin-request-state.ts`). Safe today because the plugin's account gate
  rejects siblings of an account-wide 429 class (`gemini_oauth_identity_blocked`)
  before any network spend — pinned by the "account guard 403/401/429 survives
  sibling success and quota refusal" test. A future runtime opting into
  `modelScopedRecovery` without an equivalent account gate would retry every
  sibling against one blocked account. Plan: let the classifier mark quota
  errors explicitly (e.g. `info.modelScoped`) and gate `rememberPluginFailure`
  on that flag instead of the bare status code. Deferred: contract change
  across plugins, not required for this diff's behavior.
- `geminiQuotaPoolName` (protocol.ts) is production-unused after snapshot
  parsing switched to upstream `displayName` passthrough; kept as exported
  API with its tests — remove in a later cleanup if no external consumer.
- `quota-view.ts` intentionally duplicates the effort-suffix list from
  protocol `EFFORT_WORDS` (the card chunk must stay free of the node-only
  module); add a shared cross-check test if a new effort word is ever added.
