# Desktop quota panel

The user-provided Magpie screenshot is the visual reference: one scrolling card per configured provider, including disabled providers. This implementation reuses CCR's existing admin APIs and plugin routes. It does not clone Magpie or change gateway/core/CLI behavior.

Left-clicking the tray opens a local `quota.html` webview, nominally 440 × 620 logical pixels, centered below the tray icon. Native positioning selects the tray's monitor, scales physical coordinates and clamps the window to its work area; a smaller work area shrinks the panel. Losing focus, Escape (handled by the local frontend), closing the panel, or opening the full UI hides it. Each focus/open triggers the frontend's refresh, subject to the short native cache. Right-click retains the existing native routing/refresh/open/quit menu, including its existing menu item limits. Those limits do not apply to quota cards.

## IPC and isolation

The static frontend calls `window.__TAURI__.core.invoke` with four commands:

- `quota_snapshot({ provider: null })` refreshes all configured rows. A provider name refreshes that provider's adapter, then returns the complete merged provider list in current config order.
- `quota_hide()` hides the panel.
- `quota_open_ui()` hides the panel and shows the existing main webview.
- `quota_quit()` exits only the desktop. The existing exit hook stops desktop polling and reaps only already-exited launchers. It never stops the shared gateway.

Serde camelCase DTO:

```typescript
type QuotaWindow = {
  label: string; used: number | null; limit: number | null;
  remaining: number | null; unit: string | null; resetAt: string | null;
};
type ProviderQuota = {
  name: string; enabled: boolean; plan: string | null;
  status: 'ready' | 'unsupported' | 'unavailable' | 'reauth' | 'cooling';
  message: string | null; windows: QuotaWindow[]; updatedAt: number | null;
};
type QuotaSnapshot = {
  providers: ProviderQuota[]; updatedAt: number; online: boolean; error: string | null;
};
```

`updatedAt` is an epoch-millisecond desktop read time, **not an upstream observation time**. On transport failure the in-memory last-known windows and timestamps survive with explicit stale/error text; missing quota is never converted to zero. A provider failure does not fail other cards. No snapshot survives a desktop restart.

Tauri custom commands can otherwise be exposed independently of plugin permissions. The build generates an application command manifest and four explicit permissions, granted only to window `quota`; no remote capability is declared. Every command also checks the calling webview's label **and** its exact current URL: `tauri://localhost/quota.html` on macOS/Linux, `http://tauri.localhost/quota.html` on Windows. Queries, fragments, other paths, external URLs, and `main` are rejected. Popup navigation allows only that exact local URL and denies new windows. The external CCR main webview has no native permissions, including when it starts on the local connection-help page.

Global Tauri injection is enabled to supply the popup's invocation API; injection does not grant permissions. CSP allows packaged external JavaScript and CSS, with IPC origins only in `connect-src`; it has no unsafe-inline allowance. The existing help page uses external CSS and no inline script. The panel receives only the DTO above and fixed safe error messages. Raw config, API keys, base URLs, tokens, account identities, raw upstream errors and payloads remain native-only. There is no generic fetch, shell, config-write or lifecycle command.

## Sources and refresh scope

All native requests use `AdminClient`: numeric loopback endpoint, sensitive private X-API-Key header, no proxy, no redirects, five-second request timeout. Adapter response JSON is capped at 2 MiB. Configured rows are read from `/api/config`, preserving order, disabled/model-less rows and the first valid occurrence of a name; malformed, empty, control-containing, comma-containing and duplicate names are ignored. The native cache serializes refreshes and coalesces identical requests for three seconds, including failures. Up to four provider adapters run at once, each with at most two concurrent bounded requests. No arbitrary card truncation is applied.

Only explicit known managed-provider identities/markers select dedicated adapters; plugin names from config never become URL paths:

| Adapter | Read-only routes | Projection |
| --- | --- | --- |
| Codex | GET `/api/codex/status`, POST `/api/codex/usage` `{}` | Real plan, primary/secondary usedPercent, exact 5h/7d labels only when windowSeconds confirms them |
| Kiro | GET `/api/kiro/status`, POST `/api/kiro/usage` `{}` | Service-selected account; real plan, each credit/trial/bonus window using amount/limit, not the percentage field named used |
| Gemini OAuth | GET `/api/gemini-oauth/status`, GET `/api/gemini-oauth/quota` | Real tier, independent pool/window pairs and per-model fractions kept separate; no fabricated shared pool |
| WorkBuddy CN/AI | GET `/api/workbuddy/status?site=<fixed site>`, POST `/api/workbuddy/usage` with fixed `site` | Service-selected active account, real plan, credits used/limit |
| Other providers/plugins | GET `/api/providers/quota` once per refresh that needs it | Finite positive limits paired with finite nonnegative usage; no usage-only meter |

POST usage routes are existing read-only management queries. Refresh never invokes login, sync, reset, check-in, disconnect, model visibility or config saves. Dedicated adapter selection requires known managed flags/markers alongside fixed provider identities. Unknown plugins may still supply quota through CCR's aggregate seam.

For a dedicated single-card refresh, only that adapter's status/detail routes and fresh config are read. For an aggregate card, the existing API only exposes an all-provider endpoint: refreshing one such card reads that endpoint, which may refresh other plugins server-side, but merges only the chosen card into the desktop snapshot. CCR's plugin quota seam has a 60-second cache; Gemini also owns a short singleflight cache. Desktop refresh cannot force upstream freshness.

The aggregate endpoint combines locally recorded usage, configured limits, header observations and cached adapter results, with no source/freshness/capability metadata. Usage-only entries never establish upstream quota support. A local configured limit without upstream type evidence is omitted. Finite usage paired with a usable aggregate limit is displayed with the explicit message `服务端聚合统计，可能包含本地用量；读取时间不代表上游采样时间。单卡刷新仍读取聚合缓存`. This is the existing aggregate UI contract and must not be described as verified upstream available allowance. The ambiguous 5h/7d storage slots use `配额`; balance slots use `余额`, never invented weekly/monthly labels. A balance slot with zero usage may have been synthesized from total balance, so usage and remaining stay null in that case. Units/currency are included only when supplied by the source.

No finite limits or quota response does not prove a provider lacks support: use `unavailable` with `未提供可用额度数据（来源未声明查询能力）`, distinct from `配额暂不可用` on request failure. `unsupported` is reserved for future explicit capability evidence and is currently not emitted. Reauth/cooling comes only from known status/error codes or live account cooldown timestamps; raw error strings never supply visible copy. Expired or malformed reset-bound windows are omitted. Kiro bonus expiry is used to reject expired balances, not mislabeled as a reset.

## Validation and remaining manual checks

Targeted Rust tests use exact source-shaped fixtures and ephemeral loopback mocks. Coverage includes 25 configured rows (disabled/model-less included), usage-only suppression, aggregate usage preservation, synthetic balance ambiguity, Codex windows, Kiro credits, Gemini pools, partial failure/stale retention, scoped single-card reads/full-list merge, cache behavior, sanitized serialization, URL/label guards and monitor geometry boundaries. Existing routing/lifecycle tests continue to run without touching live config or services.

Run from `apps/desktop/src-tauri` after sourcing `~/.cargo/env`: `cargo fmt --check`, `cargo check --offline --locked`, `cargo test --offline --locked`, `cargo clippy --offline --locked --all-targets -- -D warnings`. The `time` dependency already exists in the checked-in lock and local cache. Native visual behavior, Escape/focus refresh integration, right-click menu, and remote main IPC denial need the integrated frontend plus GUI validation. Platform-specific tray positioning should be checked on real Windows/Linux displays as well as macOS. Do not stop or restart live CCR for validation.

Primary references: [Tauri tray documentation](https://v2.tauri.app/learn/system-tray/), [Tauri capabilities](https://v2.tauri.app/security/capabilities/). Installed Tauri 2.12.3 and tauri-build 2.7.2 Rust source/docs are authoritative for the APIs and generated application command ACL used here.
