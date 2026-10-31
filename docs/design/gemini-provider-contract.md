# Gemini 订阅账号 Provider — 实施契约（冻结）

> 分支 `feat/gemini-oauth-provider`（基于 feat/workbuddy-provider @ 4901bc0）。设计依据：`docs/design/gemini-provider.md`。
> 本文是后端/UI 并行开发的对接契约，字段名、路由、locale key 一经冻结不得单方更改；发现冲突停下来报告，不要自行发明。
> v1 范围：**仅 antigravity kind、单账号**；gemini-cli kind / 多账号池 / refresh_token 导入均不做。

---

## 0. 一致性红线（两端共同遵守，违反即 review 打回）

1. **token 不落可见处**：refresh/access token 只存 0600 的 `$CCR_CONFIG_DIR/gemini-oauth-credentials.json`；绝不进 config.json、`/api/config` 响应、日志、错误消息、admin 响应体。config.json 里 provider 的 `api_key` 是常量标记 `"ccr-managed-gemini-oauth"`。
2. **不做内容混淆**：不改写任何系统提示词/身份行；只做错误识别与分类。
3. **错误分类是一等公民**（见 §1.6 表），错误码对外稳定。
4. 所有回归测试 **mutation-verified**（破坏实现→测试必须失败）；测试全 mock 上游，不触真实 Google。
5. commit 不带任何 AI trailer；里程碑必须 commit（子代理超时可从 commit 恢复）。

---

## 1. 协议常量与事实（后端实现依据，来源 magpie 一手源码）

```
authorize  https://accounts.google.com/o/oauth2/v2/auth
token      https://oauth2.googleapis.com/token
userinfo   https://www.googleapis.com/oauth2/v2/userinfo?alt=json
dataPlane  https://daily-cloudcode-pa.googleapis.com        (antigravity 数据面)
mgmtProd   https://cloudcode-pa.googleapis.com               (loadCodeAssist)
ssePath    /v1internal:streamGenerateContent?alt=sse
clientId   process.env.GEMINI_OAUTH_CLIENT_ID
clientSec  process.env.GEMINI_OAUTH_CLIENT_SECRET
scopes     cloud-platform, userinfo.email, userinfo.profile, cclog, experimentsandconfigs
redirect   http://localhost:<随机端口>/oauth-callback        (bind 127.0.0.1:0)
UA         antigravity/hub/2.9.1 <os>/<arch>   (os: darwin/win32/linux, arch: x64/arm64; 版本 v1 硬编码，可被 env GEMINI_OAUTH_ANTIGRAVITY_VERSION 覆盖)
authParams response_type=code, access_type=offline, prompt=consent, state=<rand24>, code_challenge(S256), code_challenge_method=S256
```

> M1 核实修订：OAuth client 参考来源为 magpie `google.go/antigravityApp`，本实现通过以上环境变量配置；缺失时返回稳定的配置未就绪错误，不回显值。禁止字符串拆分/编码绕过 GitHub Push Protection。未来若提交被拦截的公开常量，须由维护者走 GitHub 官方审查/allow 流程。M1 提交后暂停，独立审查通过再进入 M2。

- OAuth：授权码 + PKCE(S256)；code 换 token POST form（grant_type=authorization_code, client_id, client_secret, code_verifier, code, redirect_uri）。**登录回调服务器 30 分钟超时**（v1.0.3 起，原 10 分钟对真人密码/2FA 流程过紧）。
- token 刷新：内存缓存按 refresh_token 键；有效期 >2min 复用；否则 grant_type=refresh_token 刷新；单飞（并发请求共享同一次刷新）；刷新失败→错误码 `gemini_oauth_reauth_required`。未返回 refresh_token 时保留原值；若返回替换值须安全持久化后更新缓存身份，不能假设永不轮换。
- 项目发现：POST `{mgmtProd}/v1internal:loadCodeAssist`，body `{metadata:{ideType:"ANTIGRAVITY"}}`；读取回复顶层 `cloudaicompanionProject`（不从 currentTier 内读取）；否则取 `allowedTiers` default tier 调 `{dataPlane}/v1internal:onboardUser`（snake_case：`{tier_id, metadata:{ide_type, ide_name, ide_version}}`），LRO 轮询 2s×5 次。**实现前必须 gh api 读 magpie `internal/provider/google.go` 的 `geminiProject`/`antigravityProject`/`onboard`/`entitlements`（约 L600-742）核对细节**。
- 模型发现：`fetchAvailableModels`（同管理面）；失败回退静态表。**静态表必须从 magpie 源码抄真实模型 ID**（`google.go` `antigravityModels`/`fallbackModels` 约 L1145-1156 与 `antigravity_models.go` 全文——含模型 ID 变体折叠规则），禁止发明模型名。

## 1.1 数据面请求（transformer）

- 请求体：Gemini 原生体（复用 `packages/core/src/utils/gemini.util.ts` 的 `buildRequestBody`）外包信封：

```jsonc
{
  "model": "<wire model id>",
  "project": "<projectId>",
  "request": { /* gemini 原生体 + sessionId */ },
  "userAgent": "antigravity",
  "requestType": "agent",
  "requestId": "agent-<12字节随机token>"
}
```

- `sessionId`：首条 user 消息文本 SHA256 前 8 字节按大端读取，再经 `0x7fffffffffffffff` 掩码得到 63-bit 整数、前缀 `"-"`（会话内多轮稳定）。
- config.url = `{dataPlane}/v1internal:streamGenerateContent?alt=sse`；headers 只注入 `Authorization: Bearer <live access token>` 与 `User-Agent`（transformer 返回的 config.headers 会覆盖默认 Bearer，次序已验证 `routes.ts:1313-1319`）。
- **transformer 不设 endPoint**（`workbuddy.transformer.ts:7-11` 同因：避免端点撞车）。
- body 怪癖补丁（实现前必须 gh api 读 magpie `internal/gateway/codeassist.go` 对应行段，忠实移植 + 用其测试用例形状写单测）：
  - L35-38 `skip_thought_signature_validator` 哨兵：非 Gemini 3 模型的 functionCall 补 thoughtSignature 哨兵；
  - L417-462 functionResponse 与 functionCall 配平（未答补合成结果）；
  - L317-330 历史首/尾不得是 model turn 的修正；
  - L278-330 tools/generationConfig 细节；
  - 响应解码 L838-945：SSE data 行 `{"response":<gemini chunk>}` 剥壳 / `{"error":{"message"}}` 错误帧；`default_api:` 工具名命名空间清理。

## 1.2 响应 seam（关键，先读后写）

M1 修订：授权 `api/routes.ts` 最小 Gemini OAuth 专用接缝。HTTP 错误须在通用消费/日志之前分类、脱敏和更新状态；401 至多一次强制刷新后重发。发送前锁定 URL/header、拒绝重定向，令牌不得泄漏。响应已向客户端提交后不透明重试，SSE 错误不能静默吞掉；其他 provider 与 WorkBuddy 行为保持不变。

先完整读 `transformer/gemini.transformer.ts`、`utils/gemini.util.ts`、`api/routes.ts` 的响应路径（SSE 与非流式），**完全复用 gemini.transformer 的响应处理 seam**，只插入信封剥壳。SSE 逐帧 `data:` JSON → 剥 `response` → 交给与现有 gemini 相同的下游转换。WorkBuddy 的流式处理（`workbuddy.transformer.ts` 的 rewriteStream/aggregateSSE）可作为「transformer 内做流式改写」的先例参照。

## 1.3 凭证文件 schema（0600，`$CCR_CONFIG_DIR/gemini-oauth-credentials.json`）

```jsonc
{
  "version": 2,
  "kind": "antigravity",
  "account": {
    "email": "...", "refreshToken": "...", "projectId": "...",
    "tier": "...", "importedAt": "<ISO>", "lastError": null, "cooldownUntil": null
  }
}
```

## 1.4 config.json provider 形状（受管，UI/CLI 不可改关键字段）

```jsonc
{
  "name": "gemini-oauth",
  "api_base_url": "https://daily-cloudcode-pa.googleapis.com",
  "api_key": "ccr-managed-gemini-oauth",
  "gemini_oauth_managed": true,
  "gemini_oauth_kind": "antigravity",
  "transformer": { "use": ["gemini-oauth"] },
  "models": ["<同步得到的模型 id>"]
}
```

`LLMProvider` 加 `geminiOauthManaged?: boolean`、`geminiOauthKind?: "antigravity"`；`ConfigProvider` 加对应 snake_case；`services/provider.ts` 透传（对齐 workbuddyManaged 先例 `provider.ts:106-108`）。保护锁三件套 `lockGeminiOauthProvider`/`protectGeminiOauthConfig`/`isGeminiOauthRuntime` 放 `services/gemini-oauth.ts`，**不进 workbuddy.ts**；config 保存处（`admin-routes.ts:298-302` 旁）追加调用。

## 1.5 admin 路由（全部挂现有本地守卫模式，复用/抽公共 `assertLocal*Request`）

| 方法路径 | 请求 → 响应 |
|---|---|
| `GET /api/gemini-oauth/status` | → `{configured, connected, kind, email, project, tier, modelsCount, lastError?: {code, message}, cooldownUntil?}`（无 token 字段） |
| `POST /api/gemini-oauth/login/start` | → `{loginId, url, expiresAt}`；内部起 loopback 回调 server（10min TTL）；同刻最多 1 个进行中登录 |
| `POST /api/gemini-oauth/login/poll` | `{loginId}` → `{status:"pending"\|"success"\|"failed", email?, error?}`（成功=token 换取+userinfo+project 全链完成且 provider 已落 config） |
| `POST /api/gemini-oauth/login/cancel` | `{loginId}` → `{ok:true}` |
| `POST /api/gemini-oauth/sync` | → `{ok, modelsCount, clearedRefs?, error?}`；失败保留旧模型列表 |
| `POST /api/gemini-oauth/disconnect` | → `{ok:true, removedModelRefs, defaultFallback}`（对齐 workbuddy disconnect 语义：删 provider + Router 清理，返回 Router 路径标签） |

错误码→HTTP 状态映射沿用 `WORKBUDDY_ERROR_STATUS` 模式新增表。

## 1.6 错误分类表（服务层 + transformer 共享判定函数，防漂移）

| 上游信号 | 分类码 | 行为 |
|---|---|---|
| HTTP 429 + 对应 `Resource has been exhausted` 错误文本 + 请求含 Claude 身份标记（`x-anthropic-billing-header:` 或 `You are a Claude agent, built on Anthropic's Claude Agent SDK`，对**发往上游的** system 文本做检测） | `gemini_oauth_identity_blocked` | 联合启发式识别，客户端 400 语义、提示疑似身份拦截；账号 cooldown 6h；不能只凭身份标记判定 |
| 403 + `error.details` 含 `VALIDATION_REQUIRED`（附 `validation_url`） | `gemini_oauth_validation_required` | 账号 cooldown 30min；只返回经官方 HTTPS host 校验的 validationUrl，不透传整个 details 或令牌 |
| 429（不满足身份拦截联合条件） | `gemini_oauth_quota_exceeded` | 账号 cooldown（能解析重置时间用之，否则 15min） |
| 401（刷新重试一次后仍 401） | `gemini_oauth_reauth_required` | 账号置 needs-relogin，不自动轮换；账号 cooldown 60min（只为限制后台探活的网络花费，不代表问题已恢复），该错误具粘性：cooldown 过期后仍持续上报，直到重新登录/同步模型/断开连接才清除 |
| refresh grant 被拒（`invalid_grant` 等，发生在任何数据面请求之前） | `gemini_oauth_reauth_required` | 同上；此路径无上游响应可分类，由 `getAccessToken` 的 catch 直接记入账号状态，否则账号不留任何状态、后台探活会每周期对失效令牌发起真实刷新 |
| SSE 帧 `{"error":{"message":...}}` | 按可用结构与文本分类，证据不足→`gemini_oauth_upstream_error`；使用固定安全文案，不透传任意原文、不静默成功 |
| 网络/5xx | transient | 仅在未提交响应前有界重试一次；耗尽返回脱敏错误，不输出 raw error 或令牌 |

**`error.details` 只用于提取 reason 与经验证的 validationUrl，不原样透传**——现有 `gemini.util` 错误转换只取 message，不够用。

## 2. UI 契约（SettingsPage 供应商区新增卡片，参照 WorkBuddyProvider 卡）

- `packages/ui/src/types.ts`：`GeminiOauthKind`、`GeminiOauthStatusResponse`、`GeminiOauthLoginStartResponse`、`GeminiOauthLoginPollResponse`；Provider 类型加 `gemini_oauth_managed?: boolean`、`gemini_oauth_kind?: GeminiOauthKind`（对齐现有 `ccr_managed`/`workbuddy_kind`）。
- `packages/ui/src/lib/api.ts`：`geminiOauthStatus/StartLogin/PollLogin/CancelLogin/Sync/Disconnect`，带 busy 锁（照 WorkBuddy 方法段）。
- 卡片行为：状态行（邮箱/project/tier/模型数）→「授权登录」按钮**先弹风险确认对话框**（不可跳过）→ `window.open(url)` → poll 循环（2s 间隔，10min 上限）→ 成功 toast（`added`/`updated` 语义 v1 恒为 added/更新邮箱）→ 「同步模型」「断开」（断开需确认）。
- 编辑保护：受管 provider 不出现在通用编辑对话框（契约 D7 同款）。
- locale key 前缀 `geminiOauth.*`，中英齐全。**风险确认文案（冻结，两端不得弱化）**：
  - zh: `「使用第三方工具以 Google 账号订阅访问 Antigravity 违反其服务条款，Google 可能封停该账号（首次可通过官方表单申诉恢复，再次违规将永久封禁）。请只使用你可以承受损失的账号。是否继续？」`
  - en: `Using a third-party tool with a Google subscription to reach Antigravity breaches its terms. Google may suspend the account (first offenses can be appealed via Google's form; a second violation is permanent). Only use an account you can afford to lose. Continue?`
- UI 测试：`packages/ui/tests/gemini-oauth.test.ts`——风险确认必须先于 login/start（不确认不发请求）；poll 收敛；断开确认；文案插值；无 token 泄漏断言。

## 3. 后端里程碑（必须按序 commit）

- **M1 数据面**：`services/gemini-oauth.ts` 瘦版（常量+PKCE+refresh+project+信封+剥壳+分类纯函数）+ `transformer/gemini-oauth.transformer.ts` + 注册表 + `__tests__/gemini-oauth-transformer.test.ts`（信封形状/header 覆盖/SSE 剥壳/怪癖补丁/分类表）→ commit
- **M2 认证与管理**：`services/gemini-oauth-auth.ts`（凭证存储/login 状态机/loopback 回调/upsertManagedProvider/保护锁）+ admin 路由 + server 装配 + `__tests__/gemini-oauth-auth-service.test.ts`、`gemini-oauth-admin-routes.test.ts` → commit

## 4. 验收

core 新增测试全绿 + 全量 core 测试不回归（基线 679/679）+ `tsc --noEmit` 无新增 gemini-oauth 诊断 + 根目录 `CI=true pnpm build` 绿。UI：实际 node:test 套件全绿 + tsc 干净。风险：先读 magpie 源码段再写实现，禁止凭本文档臆测协议细节；文档与源码冲突时以源码为准并回报差异。
