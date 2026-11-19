# Changelog

## 0.0.2 — 2026-11-19

Ship a read-only management card. The settings page reports a card load failure for every enabled plugin without one, so the previous release showed a misleading reinstall hint. The card explains the local opt-in contract and requires no network access.

新增只读管理卡片。设置页会把所有未提供卡片的已启用插件报告为「卡片加载失败」，因此上一版会显示误导性的重装提示。卡片仅说明本地启用方式，不访问网络。

## 0.0.1 — 2026-11-19

First public experimental release. Route text chat and streaming responses through a local Antigravity CLI worker using ACP and Gemini API-key authentication. The plugin requires explicit opt-in. Testing used simulated workers. Production CLI authentication remains to be verified.

首个公开实验版本。插件通过 ACP 和 Gemini API key 认证调用本地 Antigravity CLI，支持文本对话与流式响应，需显式启用。测试使用模拟进程，真实 CLI 的认证仍待验证。
