# Changelog

## 0.1.0 — 2026-11-19

Ship the connect slice. The management card now drives the whole opt-in flow over new local-only admin routes (`/api/gemini-agy-acp/status`, `/connect`, `/disconnect`, `/models/sync`, guarded by the loopback + Origin allowlist shared with the other provider plugins): Connect validates the absolute binary path, probes `agy --version` (5 s cap, 1.5.1+ required), persists the sidecar with the optional API key at 0600 and respawns the worker pool; Disconnect disables the provider and retires the workers; Model sync runs one bounded (≤5 s) temporary worker through the ACP handshake and stores the advertised model catalog. Status reports loaded/enabled/binary/version/model count without ever serializing the key. Sidecar edits apply to the next request without a gateway restart, and an explicit sidecar `apiKey` now takes precedence over the `GEMINI_API_KEY` process environment. The hand-written JSON setup instructions are replaced by the card flow; the same sidecar file remains the source of truth.

新增连接闭环。管理卡片通过全新的仅限本地的管理路由（`/api/gemini-agy-acp/status`、`/connect`、`/disconnect`、`/models/sync`，沿用其他供应商插件的回环 + Origin 白名单守卫）驱动完整启用流程：连接会校验 binary 绝对路径、探测 `agy --version`（5 秒上限，要求 1.5.1+）、把可选 API key 以 0600 权限写入 sidecar 并重建 worker 池；断开停用供应商并回收 worker；同步模型以一个 ≤5 秒的临时 worker 完成 ACP 握手并保存 CLI 公布的模型目录。状态行展示 loaded/enabled/binary/version/模型数量，且从不序列化密钥。sidecar 修改无需重启网关即可在下一个请求生效；显式的 sidecar `apiKey` 优先于进程环境变量 `GEMINI_API_KEY`。手工 JSON 配置说明由卡片流程取代，sidecar 文件仍是唯一配置来源。

## 0.0.3 — 2026-11-19

Restyle the management card to match the other provider cards: the host settings page stylesheet (Tailwind utilities plus the custom glass-card rule) now drives the look, with the shared container, header, badge variants and section styling. Setup instructions are collapsed by default. The authentication badge identifies API-key billing.

管理卡片样式与其他供应商卡片对齐：改用宿主设置页样式表（Tailwind 工具类与自定义 glass-card 规则），容器、头部、徽章与分区样式保持一致。配置说明默认折叠，认证徽章标明使用 API key 计费。

## 0.0.2 — 2026-11-19

Ship a read-only management card. The settings page reports a card load failure for every enabled plugin without one, so the previous release showed a misleading reinstall hint. The card explains the local opt-in contract and requires no network access.

新增只读管理卡片。设置页会把所有未提供卡片的已启用插件报告为「卡片加载失败」，因此上一版会显示误导性的重装提示。卡片仅说明本地启用方式，不访问网络。

## 0.0.1 — 2026-11-19

First public experimental release. Route text chat and streaming responses through a local Antigravity CLI worker using ACP and Gemini API-key authentication. The plugin requires explicit opt-in. Testing used simulated workers. Production CLI authentication remains to be verified.

首个公开实验版本。插件通过 ACP 和 Gemini API key 认证调用本地 Antigravity CLI，支持文本对话与流式响应，需显式启用。测试使用模拟进程，真实 CLI 的认证仍待验证。
