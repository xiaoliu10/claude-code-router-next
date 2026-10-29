# WorkBuddy 内置供应商调研与首期设计

> 日期：2026-10-19；状态：调研与契约完成，首期实现中；真实账号尚未验证。
> 意图：在 CCR 配置页管理订阅代理来源，将 WorkBuddy 作为普通可路由供应商，自动发现/注册模型，无需用户安装额外插件。
> 约束：保留现有 HTTP provider/transformer 管线和普通供应商行为；不重启真实服务、不自动读取/外传用户真实凭据；独立分支 PR，未经授权不合并/发布。

## 1. 现状与接入点（Phase 1）

```text
Web UI Providers → POST /api/config → config.json → ConfigService.reload
  → ProviderService 初始化 providers/modelRoutes
客户端 /v1/messages、/v1/chat/completions → 统一请求
  → provider transformer.transformRequestIn → HTTP 上游
  → provider transformer.transformResponseOut → 客户端协议
```

- [代码事实] `packages/core/src/services/provider.ts:29-135` 从 config providers 生成供应商实例，现要求 name/api_base_url/api_key；模型注册使用字符串数组，`registerProvider` 建立 `provider,model` 路由。
- [代码事实] `packages/core/src/types/llm.ts` 定义 ConfigProvider/LLMProvider，`packages/core/src/types/transformer.ts` 定义请求转换、认证、响应转换契约；`packages/core/src/api/routes.ts:920-958` 支持转换器返回 body/config（可改 headers/url），现有 Anthropic transformer 可复用消息转换。
- [代码事实] `packages/core/src/ccr/admin-routes.ts:265-355` 已有保存、备份、运行时重建、健康状态清理和 probe 重载；新功能应复用而非另建无同步的配置写入路径。
- [代码事实] `packages/ui/src/components/Providers.tsx:300-445` 支持供应商 CRUD 与保存、刷新；`packages/ui/src/types.ts:6-29` 描述 UI Provider；`packages/ui/src/App.tsx` 已在配置界面渲染 Providers。因此优先在现有供应商区增加“内置/订阅来源”入口，而非重复建第二套配置列表。
- [代码事实] `packages/core/src/transformer/index.ts` 统一注册内置 transformer（含 AMD、Anthropic 等），无需第三方插件即可扩展供应商协议。

### 首期预计接触面

- Core：内置 WorkBuddy 认证/模型发现服务、管理 API、协议转换器及注册、provider 类型/初始化（按协议调研决定最小改动）。
- UI：Provider 类型、API 方法、WorkBuddy 供应商管理组件、现有配置页入口、中文/英文文案。
- Tests：隔离凭据/HTTP mock，模型发现与自动注册、JSON/SSE/tools/usage/errors/abort、安全边界，UI 交互与构建。
- 不改：普通 provider 默认行为、用户 Router 默认选择、项目 takeover/模型偏好；注册模型不等于自动替换用户路由。

### 已知约束/风险

1. Token 不得写入日志、错误正文或自动暴露给浏览器；凭据读取需用户显式触发，拒绝任意文件路径/任意凭据外传目标。
2. 首次连接/模型刷新必须原子更新或先验证再保存，失败保留旧模型，不用空列表覆盖；创建同名 provider 拒绝覆盖普通 provider。
3. 保存配置走既有流程保持运行时一致；避免新管理操作与全量配置保存造成丢字段。
4. 需要核实 WorkBuddy 当前数据面、登录/刷新凭据、模型列表协议；不能凭 Magpie README 宣称可用，也不照搬其完整账号池和反检测设计。
5. 规模不是 3 文件小改：Core/UI/测试可独立模块并行实现，整合后必须独立审查。

## 2. 外部调研

一手源：`magpie-community/plugins@ab38da681af7716ea9a7609f045ca91d2ad9988a`（MIT）`packages/workbuddy/index.mjs`；
旧内置对照 `yetone/magpie@b7ceb53` 的父提交 `761556a0`（`internal/provider/workbuddy*.go`）。
结论摘要（详见 `design-contract.md` 与 `/tmp/ccr-workbuddy-research/{protocol-report.md,risks-report.md}`）：

- 上游为 **OpenAI Chat Completions**：CN `POST https://copilot.tencent.com/v2/chat/completions`；不是 Anthropic `/messages`。
- 模型发现 = `GET /v3/config`（UA 必须是 `CLI/2.0.0 WorkBuddy/5.5.6`，与 chat 的 `WorkBuddy/5.5.6` 不同，P:L8-9/L17/L1467），
  取 `agents[name=="cli"].models` 并 join `data.models` 元信息。
- 本地登录复用：固定路径 `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info`（只读，明文）；
  WorkBuddy 5.6+ 的 `{$wbEncrypted:1}` 上游明确拒绝破解（plugins #18）。
- 失败矩阵已取证：10085（UA）、11140（账号受限，终态）、6004（模型级频限，≠积分耗尽）、
  14018（积分/套餐）、`unapproved channel`（Claude Code/Codex 客户端身份，magpie #182）、
  11133/11150/11153（请求整形）、ECONNRESET>2MiB（伪装成网络错误）。
- **未取证**：code 11128（grep 零命中）、11150、6004 窗口数值、`authUrl` host 全集、国际站区域限制、官方公开 API。

## 3. 方案对比与推荐

| 方案 | 结论 |
|---|---|
| **A. CCR 内置直连** | 复用 credential service + transformer + 既有 admin/provider 持久化；零新进程、零插件安装。**采纳为首期** |
| B. 外挂 Magpie 进程 | 违反"no extra gateway process"，且需再管进程生命周期与端口。**不选** |
| C. 官方公开 API | 未找到面向第三方订阅桥接的公开 API 文档（无一手证据）。**不选** |

首期范围（锁定）：只做 CN 站；只做"用户显式导入本机登录"（固定路径、只读、仅明文）；
模型发现同步注册；**不做**浏览器登录 flow、**不做**自有 refresh、**不做** FLAGGED prompt 重写、
**不做**积分/签到/账号池、**无**静态兜底模型。

## 4. 详细设计与验收

完整契约（配置形状、0600 私有凭证文件、状态枚举、4 个管理端点的精确请求/响应、
transformer header/URL 注入点、文件所有权划分、测试矩阵、安全红线、验收口径）见：

- 完整持久化契约：`docs/design/workbuddy-provider-contract.md`。其中第 13 节父代理裁决优先于前文冲突项；`/tmp/ccr-workbuddy-research/` 只保存本次工具证据，不作为交付依赖。

实现分工：后端 `/tmp/ccr-workbuddy-backend`，UI `/tmp/ccr-workbuddy-frontend`（两者均不得互改对方文件）。

关键锁定项：provider name 固定 `workbuddy`；`api_base_url` 固定 `https://copilot.tencent.com/v2/chat/completions`；
`api_key` 为不可当凭据的 marker（`provider.ts:33-35` 要求非空才能注册）；
token 存 `$CCR_CONFIG_DIR/workbuddy-credentials.json`（0600），**不进 config.json、不进 `/api/config`、不进浏览器**；
import/sync/disconnect **绝不改 `config.Router`**。

## 5. 盲区

未授权真实账号登录/推理测试；不承诺第三方订阅接入免封号；调研不自动意味着 upstream 许可或 ToS 授权。
具体未证实项（禁止在 PR 里当事实）：`/v3/config` 完整 schema（仅从插件解析代码反推）、
`authUrl` host 全集、`X-Domain` 各站点允许值、流式/非流式支持（源码旧注释与 magpie #2611 反证冲突）、
真实 token usage / cache reasoning SSE fixture、code 11128/11150、6004 窗口数值、国际站区域限制、官方公开 API。
上游对 Claude Code/Codex 类客户端有"unapproved channel"拒绝机制，**即使导入成功也可能不能推理**。

> 许可证：`magpie-community/plugins` 为 MIT。若复制 substantial 代码/tests，须保留
> `Copyright (c) 2026 magpie-community contributors` 与 MIT notice。MIT ≠ WorkBuddy/腾讯 ToS 授权。
