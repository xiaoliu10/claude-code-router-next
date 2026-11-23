# Changelog

## 0.0.3 — 2026-11-24

Tool calling. A request that declares tools used to be rejected with `400 agy_unsupported_request`; it is now served. The plugin publishes the caller's tools to the agent through an MCP server bound to `127.0.0.1` (ephemeral port, random bearer token), the agent raises a call, and the caller receives it as `tool_calls`. The ACP session and the MCP call stay warm, so a follow-up request that carries the caller's results resumes the same turn instead of starting a new conversation.

The agent never executes anything: every tool result is one the caller returned, and a missing answer is reported back as an error rather than hanging the turn. The bridge descriptor, its token and the tool schemas only ever travel to the agent subprocess through `session/new` — never into a response, usage record or log. A tool set the agent cannot serve produces an explicit `400` naming the reasons instead of a silent answer. The default worker count rises to 2 because a parked call holds its worker warm.

工具调用。此前声明了工具的请求会以 `400 agy_unsupported_request` 被拒绝，现在可以正常服务：插件把调用方的工具通过只监听 `127.0.0.1` 的 MCP 服务（随机端口、随机 Bearer token）发布给 agent，agent 发起调用，调用方收到 `tool_calls`。ACP 会话与 MCP 调用保持存活，因此带回执行结果的后续请求会续跑同一个回合，而不是新开一段对话。

agent 不执行任何工具：每个结果都来自调用方，缺失的结果以错误回传，不会让回合无限等待。桥的描述符、token 与工具 schema 只经 `session/new` 传给 agent 子进程，绝不进入响应、用量记录或日志。agent 无法服务的工具集会得到明确的 `400` 并说明原因，而不是静默作答。默认 worker 数提升为 2，因为挂起的调用需要占用 worker 保温。

## 0.0.2 — 2026-11-19

Ship a read-only management card. The settings page reports a card load failure for every enabled plugin without one, so the previous release showed a misleading reinstall hint. The card explains the local opt-in contract and requires no network access.

新增只读管理卡片。设置页会把所有未提供卡片的已启用插件报告为「卡片加载失败」，因此上一版会显示误导性的重装提示。卡片仅说明本地启用方式，不访问网络。

## 0.0.1 — 2026-11-19

First public experimental release. Route text chat and streaming responses through a local Antigravity CLI worker using ACP and Gemini API-key authentication. The plugin requires explicit opt-in. Testing used simulated workers. Production CLI authentication remains to be verified.

首个公开实验版本。插件通过 ACP 和 Gemini API key 认证调用本地 Antigravity CLI，支持文本对话与流式响应，需显式启用。测试使用模拟进程，真实 CLI 的认证仍待验证。
