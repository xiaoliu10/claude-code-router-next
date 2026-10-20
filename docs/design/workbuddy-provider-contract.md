# WorkBuddy 内置供应商 — 实现契约（design-contract）

> 日期：2026-10-19；角色：Phoenix architect（只写文档，不改产品代码）。
> 上游依据：两篇调研（`protocol-report.md`、`risks-report.md`）+ CCR 已读代码点（本文 §11）。
> 本文是**实现契约**：后端/UI 各自在 `/tmp/ccr-workbuddy-backend` 与 `/tmp/ccr-workbuddy-frontend`
> 独立实现前，以此为准。未在本文锁定的细节，实现方应回到本文而非自行发明。
> 未读取任何真实用户登录文件、未调用真实认证/推理/额度接口、未启动/停止/重启真实 CCR。
> 本文所有"未证实"项**不得**在实现或 PR 描述里当作事实。

---

> **当前裁决以 §15 为准**：页面浏览器授权是主入口，无需安装 WorkBuddy 桌面端；§13–14 桌面导入约束仅适用于 desktop 来源。

## 0. 决策速查（实现方先读这页）

| # | 决策 | 状态 |
|---|---|---|
| D1 | 上游是 **OpenAI Chat Completions**（`/v2/chat/completions`），不是 Anthropic `/messages`。CCR 复用现有 Anthropic→Unified→OpenAI 管线，WorkBuddy 只做 Unified→OpenAI 的 quirk 层 + 固定 header/URL | 锁定 |
| D2 | ~~首期**只做 CN 站** `https://copilot.tencent.com`~~ → **双站支持**：CN `https://copilot.tencent.com` + 国际 `https://www.workbuddy.ai`。站点由**导入的登录文件自动判定**（`workbuddy-desktop.info` = CN，`workbuddy-desktop-ai.info` = 国际），一次只连一个站（单 provider + 单凭证文件），切换需断开重导 | 锁定（§14 修订） |
| D3 | **浏览器授权为主入口**，无需桌面安装；desktop 导入保留兼容 API。登录 URL 必须 HTTPS、站点对应域名族白名单、无 userinfo/非标准端口；详见 §15 | 用户修订（§15） |
| D4 | token 落 **CCR 私有 0600 文件**（`$CCR_CONFIG_DIR/workbuddy-credentials.json`），**不进 `config.json`、不进 `/api/config` 响应、不进浏览器** | 锁定 |
| D5 | 模型发现 = `GET /v3/config` 取 `agents[name=="cli"].models`，join `data.models` 元信息；**无静态兜底列表**，失败/空列表保留旧 models | 锁定 |
| D6 | **不动 Router**：导入/同步/断开都不改 `config.Router`、不自动设默认路由 | 锁定 |
| D7 | 普通 provider 编辑对话框不得把 WorkBuddy 托管 provider 变成"API key 输入框"或可改外网目标 | 锁定 |
| D8 | **desktop** 不保存/花费共享 refreshToken，临期同站同账号只读续期；**browser** 独享 refreshToken 仅存 0600 私有文件并轮换续期。status 均不读源文件 | 用户修订（§15） |
| D11 | **不做自动签到**：调研确认 magpie WorkBuddy 插件无任何 checkin/签到功能；WorkBuddy 免费额度是服务端每日自动发放的 slice package（`DAILY_CODE`，每天 0 点重置），无需客户端动作 | 锁定（§14 新增） |
| D9 | 不做 FLAGGED prompt 重写（对抗性适配，ban risk）；识别 `unapproved channel` 后给可执行错误 | 锁定 |
| D10 | 外部插件安装 / 额外网关进程 / Magpie 依赖：**零** | 锁定 |

### 方案对比（≥2 备选，任务要求）

| 方案 | 结论 |
|---|---|
| **A. CCR 内置直连（本契约）** | 复用 credential service + transformer + 既有 admin/provider 持久化。零新进程、零插件安装。工作量集中在 transformer、admin 导入/同步 API、UI 管理入口。**采纳为首期** |
| B. 外挂 Magpie 独立进程 | 协议最全（模型发现/用量/企业版/刷新），但违反"no extra gateway process"，且需额外管进程生命周期与端口。**不选** |
| C. 官方公开 API | 本次检索**未找到** WorkBuddy/CodeBuddy 面向第三方订阅桥接的公开 API 文档（无一手证据）。在拿到官方文档前不假设存在。**不选** |

---

## 1. 上游协议摘要（实现必须遵守的硬事实）

来源一律为社区 pin `magpie-community/plugins@ab38da681af7716ea9a7609f045ca91d2ad9988a`
`packages/workbuddy/index.mjs`（下称 **P**）与退休内置父版 `yetone/magpie@761556a0`（下称 **M-parent**）。
P 为 MIT；CCR 若复制 substantial 代码/tests，**必须保留 MIT 署名**（见 §10）。

### 1.1 站点与常量

| 常量 | 值 | 证据 |
|---|---|---|
| CN origin | `https://copilot.tencent.com` | P:L64-70 `SITES.workbuddy.endpoint` |
| CN chat path | `POST /v2/chat/completions` | P:L96 `api(site) = endpoint + "/v2"`；上游 chat 走 `baseURL + /chat/completions` |
| CN 模型发现 | `GET /v3/config` | P:L1467-1470 |
| CN 刷新 | `POST /v2/plugin/auth/token/refresh` | P:L188-196 |
| CN desktop 登录文件 | `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info` | P:L1033-1040 `desktopFile()` |
| chat UA | `WorkBuddy/5.5.6` | P:L17, L275 |
| **config UA（不同！）** | `CLI/2.0.0 WorkBuddy/5.5.6` | P:L17, L1467 |
| auth/plugin UA | `WorkBuddy/5.5.6` | P:L125 |

> **UA 是硬协议要求**：P:L8-9 原注释 `a request whose User-Agent isn't WorkBuddy/<version> is refused (error 10085)`。
> 且 chat 与 `/v3/config` 要的 UA **不同**：P:L1397-1401 注释说明裸 `WorkBuddy/<v>` 拿到的是 IDE config，**没有 cli agent**。

### 1.2 chat headers（P:L263-300 `sign()`）

```
Authorization: Bearer <accessToken>
X-User-Id: <uid>
X-Domain: <validated domain or origin host>
X-Product: SaaS
X-IDE-Type: WorkBuddy
User-Agent: WorkBuddy/5.5.6
X-Requested-With: XMLHttpRequest
X-Agent-Intent: craft
X-Agent-Purpose: conversation
X-IDE-Name: WorkBuddy
X-IDE-Version: 5.5.6
X-Agent-Type: main                       # 仅国际站
X-Enterprise-Id / X-Tenant-Id: <id>      # 仅企业账号
X-Conversation-ID: <32hex>
X-Conversation-Request-ID: <32hex>       # 同一用户 turn 的工具回合/重试不变
X-Conversation-Message-ID: <32hex>       # 每个 HTTP request 新值
X-Request-ID: <与 Message-ID 相同>
Content-Type: application/json
```

会话 ID 派生规则（P:L326-360、L443-451）：
- `X-Conversation-Message-ID` = 每请求新随机 32hex；`X-Request-ID` 同值。
- `X-Conversation-Request-ID`（turn）= `sha256(SALT|"turn"|conversationKey + "|" + turnKey)` 前 32hex，
  `turnKey` = 最后一条"用户自己说的" user message 的位置+签名（tool_result/assistant tool_calls 之后的消息不算）。
- `X-Conversation-ID` = `sha256(SALT|"conversation"|conversationKey)` 前 32hex；
  `conversationKey` = session id（若有）否则首条 user message 签名。
- 没有可签名内容时**不发**这两个头，不发明文。

### 1.3 请求体 quirk（P:L509-598）

- `max_completion_tokens` → `max_tokens`（已有 `max_tokens` 优先），删原字段。
- role `developer` → `system`。
- 首条消息不是 system 时前置 `{"role":"system","content":"You are a helpful assistant."}`。
- `tool_choice` 对象 → 字符串：`{type:"auto"|"required"}` → `"auto"|"required"`；
  `{type:"function",function:{name}}` → 工具名字符串；`none`（或 type none）→ **删 `tool_choice`/`tools`/`functions`**。
- 工具名仅 `[A-Za-z0-9_-]+`，其它字符替换为 `_`，碰撞加 `_2`；**请求历史与 tool_choice 同步改名；响应 tool_call name 必须改回客户端原名**（request-local map，禁全局共享）。
- `reasoning_effort` 原样发送；插件**不**把 budget 推测成 effort。无 `supportedEfforts` 的模型不要猜。
- **不做** FLAGGED 重写（P:L454-472 的 4 条规则是上游对抗性适配；#170 记录 Claude Desktop 不在覆盖范围，ban risk）。
- 未在首期契约内的 reasoning 细节（实现时按需补，不要自行加码）：CCR 的 `reasoning.effort`
  来自 `utils/thinking.ts` 的 `none|low|medium|high|max` 梯子；WorkBuddy 的 `supportedEfforts`
  可能含 `xhigh` 等梯外值。**冲突处理**：客户端请求的 effort 若不在该模型 `supportedEfforts` 里，
  发送前**不要**替换、也不要猜——照发并让上游给清晰错误（11150 正是这类），
  或按后续决策做保守降档；首期**不**做静默降档。

### 1.4 `/v3/config` 响应 schema（结构来自 P:L1465-1515 解析代码；**未见官方文档或真实响应样本**）

```json
{
  "code": 0,
  "msg": "ok",
  "data": {
    "agents": [{ "name": "cli", "models": ["<model-id>"] }],
    "models": [{
      "id": "<model-id>",
      "name": "Display Name",
      "maxInputTokens": 200000,
      "maxOutputTokens": 8192,
      "supportsImages": true,
      "onlyReasoning": false,
      "credits": "x0.34",
      "reasoning": { "supportedEfforts": ["low", "high"], "canDisableThinking": true }
    }],
    "modelPromotions": []
  }
}
```

解析规则（P:L1474-1515）：
- 只取 `agents[].name === "cli"` 的 `models`；用 id 在 `data.models` 里 join 元信息。
- context=`maxInputTokens`、output=`maxOutputTokens`、images=`supportsImages === true`（CN 无 textOnly 覆写）。
- `supportedEfforts` 存在时复制；仅当 `!onlyReasoning` 且 `canDisableThinking` 未给或 true 时前置 `"none"`。
- 同名显示名去歧义：id 是首个的 `<id>-<rest>` 时显示名加 ` (REST)`，否则加 ` (ID)`；**不改路由 id**。
- 错误：HTTP 非 2xx → `HTTP <status>`；`env.code` 非 0 → `<msg> (<code>)`。15s 超时（P:L1470）。
- **空/失败 → 同步失败，保留旧 models，不放静态兜底**（CCR 任务约束，与插件静态 fallback 相反，是对的）。

### 1.5 desktop 登录文件（P:L1031-1114）

固定路径（不可配置、不可由客户端提供）：

```
macOS:   ~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info
Windows: ~/AppData/Local/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info
Linux:   ~/.local/share/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info
```

JSON 形状：`{account:{uid,nickname?,phoneNumber?,enterpriseId?}, auth:{accessToken,refreshToken?,expiresAt?,expiresIn?,refreshExpiresAt?,refreshExpiresIn?,domain?,tokenType?}}`
- `expiresAt`/`refreshExpiresAt` = **Unix 毫秒**；`expiresIn`/`refreshExpiresIn` = **秒**。
- 合法必要条件：`typeof auth.accessToken === "string" && auth.accessToken && account.uid`（P:L1053）。
- **密封 token**：`accessToken`/`refreshToken` 为 `{"$wbEncrypted":1,"envelope":"..."}` 时**不可读**（P:L1075）；
  上游明确拒绝破解（plugins #18，yetone 决定原文：只有启动厂商 Electron + 私有 binding 才能取 at-rest key）。
- `domain` 只作 `X-Domain` 头值，**永不用于拼 URL**（P:L146-147 `domainOf`；M-parent 亦只作 header）。

### 1.6 失败矩阵（实现必须分类，禁止删）

| 上游表现 | 分类 | CCR 动作 | 证据 |
|---|---|---|---|
| UA 不对 → code **10085** | `workbuddy_protocol_error`（CCR 自身 bug） | 日志高亮，不进健康退避 | P:L8-9, L17, L125, L275 |
| 403 code **11140** `account has been restricted due to unusual activity` | 账号级终态 | 长冷却（≥2h）+ 明确文案"在 WorkBuddy 内 Submit feedback 申诉"；**不重试轰炸** | P:L1690-1701；M-parent `workbuddy.go:237-259`；magpie #1849 |
| code **6004** / HTTP 429 `您的使用量已超出频率限制，将在 … 重置` | `rate_limit`，**按 provider+model** | 复用 `healthStore.markRateLimited`；文本里的重置时刻可解析则用作到期，否则固定 15min。注意：`routes.ts:1647-1663` 的 `isRateLimitError` 已匹配 `频率限制`，所以 6004 会被**现有 fallback 分类**自动判为 rate limit（好事，不要破坏）；但 per-model 粒度要显式做 | magpie #1361（真实抓包，明说"账号积分没动"、只封了 kimi-k3-1 一个模型） |
| code **14018** `Credits exhausted` | `insufficient_quota` | 按模型冷却 + 提示需要有效套餐（0 费率模型也要） | P:L1704-1709；README；plugins #138 |
| `unapproved channel` / `Illegal API invocation` | `permission_error`（**请求内容问题，不熔断账号**） | 文案：WorkBuddy 拒绝 Claude Code/Codex 类客户端会话；换其他客户端或 provider | P:L1680-1687；magpie #182 |
| 400 code **11150** reasoning effort | 请求类错误 | 不硬编码猜 effort；报清晰模型错误 | plugins #125（open，未验证） |
| 400 code **11153** must end with a user message | 请求类错误 | 首期不实现空 assistant 插入；保留明确错误 | P:L1512-1545；plugins #113 |
| 400 code **11133** 工具 schema | 请求类错误 | 见 §4.3 最小集；其余为后续 | P:L586-646；plugins #122 |
| code **11128** | **未知** | 本次 `grep -rn 11128` 在插件（含全部 tests）、M-parent、issue 检索**零命中** → 走通用错误路径 + 原样 `code` 上报，**不编造语义** | risks-report §10.1 |
| 空 tool_call id（stream） | 请求类错误 | 见 §4.3 | magpie #2611 |
| HTTP 200 SSE `finish_reason:"error"` | 需检测/传递 | 见 §5.4 | magpie #2471 |
| ECONNRESET 且 body > 2MiB | 文案提示可能是登录态失效 | 见 §5.5 | P:L1151-1190（`EDGE_READS = 2*1024*1024`） |

---

## 2. 托管 WorkBuddy provider：marker 与配置形状（锁定）

### 2.1 托管标记

```ts
// packages/shared/src/workbuddy.ts（新增，shared 因 core 与 ui 都要用）
export const WORKBUDDY_PROVIDER_NAME = "workbuddy";      // config.Providers[].name
export const WORKBUDDY_MANAGED_FLAG = "ccr_managed";     // 复用现有 ccr_managed 布尔
export const WORKBUDDY_KIND_FLAG = "workbuddy_kind";     // "workbuddy" | "workbuddy-ai"
```

- **判定托管**：`provider.name === "workbuddy" && provider.ccr_managed === true`
  （与 `isCcrSelfProvider` 同型；避免再发明第二套 marker）。
- **provider name 固定** `"workbuddy"`：路由 id 就是 `workbuddy,<model-id>`，用户可直接写进 Router。
- `api_base_url` **完整固定**为 `https://copilot.tencent.com/v2/chat/completions`（任务要求"server URI target locked"）。
- `api_key` **永不为空但永不是真 token**：固定字面量 `"ccr-managed-workbuddy"`。
  理由：`ProviderService.initializeFromProvidersArray` 在 `!name || !api_base_url || !api_key` 时直接 return
  （`packages/core/src/services/provider.ts:36-40`），不填就无法注册。该 marker 不可当凭据使用。
- `transformer.use = ["workbuddy"]`。
- `models: string[]` 由同步写入。
- `enabled: true`。

**落盘后的 provider 对象（写进 config.json 的全部字段，无 token）**：

```json
{
  "name": "workbuddy",
  "api_base_url": "https://copilot.tencent.com/v2/chat/completions",
  "api_key": "ccr-managed-workbuddy",
  "models": ["glm-5.3", "kimi-k3-1"],
  "transformer": { "use": ["workbuddy"] },
  "enabled": true,
  "ccr_managed": true,
  "workbuddy_kind": "workbuddy"
}
```

### 2.2 私有凭证文件（不进 config.json）

路径：`$CCR_CONFIG_DIR/workbuddy-credentials.json`（`HOME_DIR` 已 honors `CCR_CONFIG_DIR`，测试天然隔离）。
权限：`fs.writeFile(path, json, { mode: 0o600 })`；目录 `HOME_DIR` 由 `initDir()` 已建。

```json
{
  "version": 1,
  "kind": "workbuddy",
  "uid": "<account.uid>",
  "displayName": "<nickname | phoneNumber | uid>",
  "domain": "<auth.domain or ''>",
  "enterpriseId": "<account.enterpriseId or ''>",
  "accessToken": "<opaque>",
  "refreshToken": "<opaque>",
  "expiresAt": 0,
  "refreshExpiresAt": 0,
  "importedAt": "2026-10-19T00:00:00.000Z",
  "source": "desktop"
}
```

约束：
- **`/api/config` 与 `readConfigFileRaw()` 不得包含该文件任何内容**（该文件在 `HOME_DIR` 而非 `CONFIG_FILE`，天然满足；实现时不得把它 merge 进 config 对象）。
- 备份/快照路径（`backupConfigFile`、`snapshotConfigBeforeWrite`）只拷 `CONFIG_FILE`，**不会**带上凭证文件。这是可接受且有意的：断开连接即删除凭证文件，重新导入即可。需在 UI 明示"配置备份不含 WorkBuddy 登录态"。
- 任何日志/错误/HTTP 响应**不得**出现 `accessToken`/`refreshToken` 原值。

### 2.3 状态枚举（UI/API 共用）

```ts
type WorkBuddyStatus =
  | "not_connected"   // 无凭证文件
  | "connected"       // 凭证可用，模型列表来自上次成功同步
  | "expired"         // expiresAt 已过（access token 过期）
  | "sealed"          // 源文件是 {$wbEncrypted:1}
  | "source_missing"  // 固定路径无文件（重新导入前，已保存的 provider/models 不动）
  | "source_changed"  // 源文件 uid 与已保存 uid 不同（桌面换账号）
  | "error";          // 其它，附 message（已脱敏）
```

---

## 3. 后端实现契约（worktree: `/tmp/ccr-workbuddy-backend`）

### 3.1 文件所有权（每个文件一个 owner，禁止跨界改）

| 文件 | 归属 | 说明 |
|---|---|---|
| `packages/shared/src/workbuddy.ts`（新） | **后端** | 常量、类型、`readWorkBuddySource`（只读解析）、`loadWorkBuddyCredential`/`saveWorkBuddyCredential`/`deleteWorkBuddyCredential`、`sanitizeWorkBuddyError` |
| `packages/core/src/services/workbuddy-auth.ts`（新） | **后端** | 凭证服务：状态、导入、同步、断开；单飞；header 生成；UA 常量 |
| `packages/core/src/transformer/workbuddy.transformer.ts`（新） | **后端** | `static TransformerName = "workbuddy"`；`endPoint = "/v1/chat/completions"`（见 §3.5 说明）；请求/响应 quirk |
| `packages/core/src/transformer/index.ts` | **后端** | 仅加一行 export + 一处注册 |
| `packages/core/src/ccr/admin-routes.ts` | **后端** | 仅新增 `/api/workbuddy/*` 路由段（在 Provider Quota & Health API 附近），不改既有路由逻辑 |
| `packages/core/src/types/llm.ts` | **后端** | 仅给 `LLMProvider`/`ConfigProvider` 加可选 `workbuddy_kind?: string`（或直接用 `(providerConfig as any)`，见 §3.4） |
| `packages/core/src/__tests__/workbuddy-*.test.ts`（新） | **后端** | 见 §6 |
| `packages/ui/**` | **前端 worktree** | 后端**不改** |

> `ConfigProvider`/`LLMProvider` 已有 `[key: string]: any`（UI 侧）与显式字段（core 侧）。
> 为避免与前端 worktree 同时改 `types/llm.ts` 产生冲突，**后端优先用现有 `as any` 读取路径**
> （`provider.ts:104` 已有 `(providerConfig as any).quota_token` 先例），把 `workbuddy_kind`
> 作为透传字段即可；若确需类型声明，只加**一个可选字段**并在 PR 描述里注明。

### 3.2 服务 API（后端内部，供 admin-routes 调用）

```ts
// services/workbuddy-auth.ts
export const WORKBUDDY_CHAT_UA = "WorkBuddy/5.5.6";
export const WORKBUDDY_CONFIG_UA = "CLI/2.0.0 WorkBuddy/5.5.6";
export const WORKBUDDY_CHAT_ORIGIN = "https://copilot.tencent.com";

export class WorkBuddyAuthService {
  constructor(configService, logger)

  /** 只读解析固定路径源文件。绝不写、绝不接受外部路径。 */
  readSource(): WorkBuddySourceResult
  /** 显式导入：读源 → 校验 → 原子写 0600 私有文件 → 同步模型 → upsert provider */
  importFromLocalDesktop(): Promise<WorkBuddyMutationResult>
  /** 重新同步模型列表（用已保存凭证） */
  syncModels(): Promise<WorkBuddyMutationResult>
  /** 断开：删私有凭证文件 + 从 config 删托管 provider（保留其它 provider 与 Router 不动） */
  disconnect(): Promise<WorkBuddyMutationResult>
  /** 状态查询（不返回 token） */
  getStatus(): WorkBuddyStatusResult
  /** 供 transformer 生成 headers；token 只在服务内流转 */
  buildChatHeaders(provider: LLMProvider, body: any): Promise<Record<string, string>>
}
```

**单飞**：`importFromLocalDesktop` / `syncModels` 各持一个 in-flight Promise，并发调用复用同一次网络结果；
不做 refresh，所以不存在 refresh token 竞争（首期不做自有 refresh = 不花共享 refresh token）。

### 3.3 导入流程（严格顺序）

```
1. readSource()
   - 解析固定路径（按 process.platform 三选一）
   - ENOENT            → { ok:false, reason:"source_missing" }
   - JSON 解析失败      → { ok:false, reason:"source_invalid" }
   - accessToken/refreshToken 是 {$wbEncrypted:1}
                       → { ok:false, reason:"sealed" }
   - typeof accessToken !== "string" || !accessToken || !account.uid
                       → { ok:false, reason:"source_invalid" }
   - 文件 > 1 MiB       → { ok:false, reason:"source_invalid" }   // 防恶意大文件
   - domain 非字符串或含 CR/LF 或长度 > 253
                       → { ok:false, reason:"source_invalid" }   // 头注入防护
   - uid/enterpriseId 同上（CRLF + 长度校验）
   - expiresAt 非有限数 → 0（视为未知，不因此失败）
2. 归一化 expiresAt：>0 用原值；否则 expiresIn>0 → now + in*1000；否则 0
3. saveWorkBuddyCredential(...)  // 0600，先写临时文件再 rename（原子）
4. fetchModels()  // GET /v3/config，15s 超时，CONFIG UA
   - 失败 / 空列表 → 保留旧 models，返回 { ok:false, reason:"models_fetch_failed", modelsUnchanged:true }
   - 成功 → models = ids（去重、保序）
5. upsertManagedProvider(models)  // 见 §3.4
6. reconcileHealthStore 等价清理：删除已不存在模型的 health 条目（复用 admin-routes 已有函数）
7. 返回 { ok:true, status:"connected", models, displayName, uidMasked }
```

**失败不变量**：任一步失败都**不覆盖**已保存的凭证文件、已保存的 provider、已保存的 models。
`sealed`/`source_missing`/`source_invalid` 时 UI 状态停在 connected 之前，旧账户/旧模型一律不清空（对齐 plugins #18 的行为修正）。

**uid 变更保护**：导入时若已存在凭证且 `existing.uid !== source.uid` → 仍允许覆盖（用户显式点击了导入），
但 `getStatus()` 对"源文件 uid ≠ 已保存 uid"的情况报 `source_changed`（桌面换账号的可见信号），
**不**在同步时静默改写 CCR 身份。

### 3.4 provider upsert（不改 Router）

```
providersKey = Array.isArray(config.Providers) ? "Providers"
            : Array.isArray(config.providers) ? "providers" : "Providers"
list = [...config[providersKey]]
idx = list.findIndex(p => p?.name === "workbuddy")
if (idx >= 0) {
  if (list[idx].ccr_managed !== true) → 拒绝：409 name_conflict（同名普通 provider，禁止接管/覆盖）
  list[idx] = { ...list[idx], models, enabled: true, workbuddy_kind: "workbuddy" }  // 保留用户改过的 enabled 之外的字段
} else {
  list.push({ ...§2.1 的对象... })
}
config[providersKey] = list
await writeConfigFile(config)          // 既有路径：自带 snapshot + .bak
configService.reload()
configService.set('providers', list)
providerService = new ProviderService(configService, transformerService, log)
reconcileHealthStore(config, log)
resetActiveProbeService() + startActiveProbe(...)   // 与 POST /api/config 完全一致
```

- **绝不写 `config.Router`**（D6）。用户自己选 `workbuddy,<model>`。
- `writeConfigFile` 在 `VITEST`/`CI` 下会抛（`assertNotTestEnv`）——测试必须走注入 `initialConfig` 的
  runtime 或直接测 service 层，不得指望它写真实文件。

### 3.5 transformer（`transformer/workbuddy.transformer.ts`）

```ts
export class WorkBuddyTransformer implements Transformer {
  static TransformerName = "workbuddy";
  name = "workbuddy";
  endPoint = "/v1/chat/completions";   // 见下方说明
```

**`endPoint` 取值说明（重要，别改）**：`routes.ts:1041-1057` `shouldBypassTransformers()`
会因 `transformer.endPoint === "/v1/chat/completions" && Array.isArray(body.system)` 强制不走 bypass，
这正是我们要的（Anthropic 的 `system` 数组必须被转成 OpenAI messages）。同时 bypass 条件
`provider.transformer.use.length === 1 && use[0].name === transformer.name` 会成立 → 走 bypass 路径，
此时 `transformRequestIn` 不执行。因此 **URL 与 headers 必须在 `auth()` 里注入**
（`routes.ts:1078-1099`：bypass 且 `typeof transformer.auth === "function"` 时调用，
其返回 `{ body, config.headers }` 会合并进 `config.headers` 并 `delete headers.host`）。

```ts
  async auth(request: any, provider: LLMProvider): Promise<any> {
    const headers = await workBuddyAuth.buildChatHeaders(provider, request);
    // 强制覆盖 routes.ts:1104 的默认 Authorization: Bearer provider.apiKey
    return {
      body: request,
      config: {
        url: WORKBUDDY_CHAT_URL,                 // 常量，发送前再校验一次 origin
        headers: {
          Authorization: `Bearer ${access}`,     // 覆盖默认
          "X-User-Id": uid,
          ...attributionHeaders,
          ...enterpriseHeaders,
        },
      },
    };
  }
```

> **header 覆盖保证**：`routes.ts:1103-1106` 是 `{ Authorization: Bearer provider.apiKey, ...config.headers }`，
> `config.headers` 在后，**后写覆盖前写**，所以 `auth()` 返回的 `Authorization` 一定赢。
> 另外 `sendUnifiedRequest` 只 `headers.set` 非空值，`"undefined"` 字符串值会被 `routes.ts:1110-1119` 删除。
> 实现仍需在 service 内对最终 header 做一次"非空 + 无 CRLF"校验，不只依赖 UI 输入。

`transformRequestIn(request: UnifiedChatRequest, provider, context)`：§1.3 的 quirk
（`max_completion_tokens`→`max_tokens`、developer→system、补默认 system、tool_choice 归一、工具名安全化 + request-local 反向映射、`reasoning_effort` 原样）。
- 工具名反向映射存 **context**（`context.workbuddyToolNames: Map<safe, original>`）或
  WeakMap keyed by request 对象；**禁止模块级全局 Map**。
- `stream`：上游保守路径仍是 stream:true。见 §5.2 决策点（需 supervisor/用户在实现前确认）。

`transformResponseOut(response, context)`：tool_call name 还原（JSON 与 SSE 两条路径，逐行/整段，
保留 `[DONE]`、注释行、usage-only chunk、 malformed 行原样），以及 §5.4 的 SSE error 检测。
- 复用 `./response-body` 的 `peekBodyForSSE`/`readBodyForSSE`/`parseResponseJson`（amd.transformer 同款）。
- SSE 逐行改写照抄 amd.transformer 的 `drainLines` 结构（保留 CR/CRLF/空行、`final` 尾块），
  **这是 CCR 已验证过的边界安全写法**。
- **不要**复用 OpenCode transformer（它带自己的 session/cache/数值 tool id 策略）。

### 3.6 管理 API（新增，不改既有路由）

Base：`/api/workbuddy`。全部走 admin 中间件（与 `/api/providers/*` 同层级）。

| 方法 | 路径 | 请求体 | 成功 | 错误 |
|---|---|---|---|---|
| GET | `/api/workbuddy/status` | — | `200 WorkBuddyStatusResult` | `500 { error }` |
| POST | `/api/workbuddy/import` | `{}` | `200 WorkBuddyMutationResult` | `409 { error:"workbuddy_name_conflict" }`／`422 { error, reason }`／`500 { error }` |
| POST | `/api/workbuddy/sync` | `{}` | `200 WorkBuddyMutationResult` | `409 { error:"workbuddy_not_connected" }`／`422 { error, reason:"models_fetch_failed" }`／`500` |
| POST | `/api/workbuddy/disconnect` | `{}` | `200 { success:true }` | `409 { error:"workbuddy_name_conflict" }`／`500` |

**精确响应形状**（前后端都按这个写，不要加字段）：

```ts
// GET /api/workbuddy/status → 200
{
  "status": "not_connected",           // WorkBuddyStatus
  "kind": "workbuddy",                 // 站点；国际版未启用时恒为 "workbuddy"
  "site": "https://copilot.tencent.com",
  "providerName": "workbuddy",         // config 里的 provider name（未连接也可给）
  "models": [],                        // string[]，来自 config（无 token）
  "modelCount": 0,
  "uid": null,                         // string | null（账号 uid，非敏感）
  "displayName": null,                 // string | null（nickname/phone/uid）
  "domain": null,                      // string | null
  "expiresAt": null,                   // number | null（Unix ms）
  "importedAt": null,                  // ISO string | null
  "lastSyncAt": null,                  // ISO string | null
  "lastError": null                    // string | null（已脱敏，绝不含 token）
}

// POST /api/workbuddy/import|sync → 200
{
  "success": true,
  "status": "connected",               // 或 error 类状态
  "models": ["glm-5.3", "kimi-k3-1"],
  "modelCount": 2,
  "displayName": "…",
  "message": null                      // 可选提示（脱敏）
}

// POST /api/workbuddy/import|sync → 422
{
  "success": false,
  "reason": "sealed",                  // sealed | source_missing | source_invalid | models_fetch_failed
  "message": "WorkBuddy 5.6+ 已加密本地登录态，暂不支持导入；未改动任何文件",
  "modelsUnchanged": true              // 旧 models 是否被保留
}

// POST /api/workbuddy/import|sync → 409
{ "success": false, "error": "workbuddy_name_conflict",
  "message": "已存在同名普通 provider「workbuddy」，请先改名或删除后再导入" }

// POST /api/workbuddy/disconnect → 200
{ "success": true, "removedProvider": true, "deletedCredential": true }
```

**错误脱敏硬规则**（对应调研 §8.3/§3）：`routes.ts:1143-1150` 会把上游 `errorText` 原样记日志并包进
客户端错误。WorkBuddy 路径必须在到达那之前收敛：service 内的网络错误只返回
`"WorkBuddy 上游请求失败（HTTP <status>）"` 一类文案；`X-Refresh-Token` 不得进任何 logger
（`utils/debug-log.ts` 的 `maskHeaders` 只遮 authorization/x-api-key/cookie，**未遮 X-Refresh-Token**）。
首期不发 refresh，等于天然规避；但若后续加 refresh，必须先扩 `SENSITIVE_HEADERS`。

### 3.7 代理

完全复用 `resolveProviderProxyUrl(configService, provider)`（`routes.ts:1136` 已在用）：
托管 provider 走普通 per-provider 策略（`proxy_enabled`），**不新增任何代理逻辑**。
service 内自建 fetch（`/v3/config`）时也必须传 `httpsProxy`。

---

## 4. UI 实现契约（worktree: `/tmp/ccr-workbuddy-frontend`）

### 4.1 文件所有权

| 文件 | 说明 |
|---|---|
| `packages/ui/src/types.ts` | `Provider` 加 `workbuddy_kind?: string`（可选字段） |
| `packages/ui/src/lib/api.ts` | 加 4 个方法 + 响应类型（见 §4.3） |
| `packages/ui/src/components/WorkBuddyProvider.tsx`（新） | WorkBuddy 管理卡片 |
| `packages/ui/src/components/Providers.tsx` | **仅**在现有 Providers 区挂载 WorkBuddy 卡片；托管 provider 在编辑对话框里禁用 key/url 字段 |
| `packages/ui/src/locales/en.json`、`zh.json` | 新增 `workbuddy.*` 文案段 |
| `packages/ui/src/__tests__/**`（若该目录存在）或既有测试目录 | UI 交互测试（见 §6） |

**禁止**：改 `packages/ui/src/components/ProviderList.tsx` 的普通 provider 渲染契约去适配 WorkBuddy；
不改后端文件。

### 4.2 交互（全部显式用户动作）

WorkBuddy 卡片（置于 Providers 列表上方或同级 section）：

1. **隐私警告**（常驻，一次性 dismiss 不落盘也可）：
   - 中文：`导入只读取本机 WorkBuddy 登录文件的固定路径，只读、不修改、不外传；登录态保存在 CCR 私有文件（0600），不会进入浏览器或普通 provider 配置。`
   - 必须说明"配置备份不含 WorkBuddy 登录态"。
2. **状态行**：`not_connected` → 显示"导入本机 WorkBuddy 登录"主按钮；
   `connected` → 显示账号 displayName、`uid`（可脱敏为前 3 后 2）、`expiresAt`、模型数、上次同步时间；
   其余状态 → 对应说明 + 主按钮（重新导入）。
3. **Connect / 导入**：`POST /api/workbuddy/import`。loading → toast。
   - `sealed` → 错误卡片："WorkBuddy 5.6+ 已加密本地登录态，暂不支持导入；未改动任何文件"。
   - `source_missing` → "未在本机固定路径找到 WorkBuddy 登录文件；请先在 WorkBuddy 客户端登录后重试"。
   - `name_conflict`(409) → "已存在同名普通 provider「workbuddy」，请先改名或删除"。
4. **Sync / 同步模型**：`POST /api/workbuddy/sync`。成功 → `refreshConfig()` + toast"已同步 N 个模型"；
   失败 → 保留旧列表 + 错误提示（不得清空 UI 里的模型列表）。
5. **Disconnect / 断开**：二次确认对话框 → `POST /api/workbuddy/disconnect` → `refreshConfig()`。
   文案必须说明"只删除 CCR 内的登录态与托管 provider，不会修改 WorkBuddy 客户端登录"。
6. **Token 永不进 UI**：UI 不请求、不渲染、不缓存任何 token 字段；状态接口不返回 token（契约已保证）。
7. **国际版**：不在 UI 暴露。类型层留 `kind` 但不渲染入口（D2）。

### 4.3 api.ts 方法（精确签名）

```ts
// types
export type WorkBuddyStatus =
  | "not_connected" | "connected" | "expired"
  | "sealed" | "source_missing" | "source_changed" | "error";
export interface WorkBuddyStatusResponse {
  status: WorkBuddyStatus; kind: string; site: string; providerName: string;
  models: string[]; modelCount: number; uid: string | null; displayName: string | null;
  domain: string | null; expiresAt: number | null; importedAt: string | null;
  lastSyncAt: string | null; lastError: string | null;
}
export interface WorkBuddyMutationResponse {
  success: boolean; status?: WorkBuddyStatus; models?: string[]; modelCount?: number;
  displayName?: string | null; message?: string | null; modelsUnchanged?: boolean;
  reason?: "sealed" | "source_missing" | "source_invalid" | "models_fetch_failed";
  removedProvider?: boolean; deletedCredential?: boolean;
  error?: string;
}
// methods
getWorkBuddyStatus(): Promise<WorkBuddyStatusResponse>            // GET  /workbuddy/status
importWorkBuddy(): Promise<WorkBuddyMutationResponse>             // POST /workbuddy/import   body {}
syncWorkBuddyModels(): Promise<WorkBuddyMutationResponse>         // POST /workbuddy/sync     body {}
disconnectWorkBuddy(): Promise<WorkBuddyMutationResponse>         // POST /workbuddy/disconnect body {}
```

（`baseUrl` 已是 `/api`，所以路径写 `/workbuddy/status`，与既有 `/providers/probe` 同型。）

### 4.4 托管 provider 的编辑保护（D7，硬要求）

在 `Providers.tsx` 的编辑对话框里：

```ts
const isManagedWorkBuddy = editingProvider?.name === "workbuddy" && editingProvider?.ccr_managed === true;
```

- `isManagedWorkBuddy === true` 时：`api_key` 输入框改为**只读说明**
  （"WorkBuddy 为内置托管 provider，登录态由 CCR 私有保存，不在此处编辑"），
  `api_base_url` 只读（固定上游，不可改），`transformer` 选择器禁用（固定 `workbuddy`）。
- `name` 允许改名？**不允许**——改名即使 provider 变成普通 provider（`ccr_managed` 仍在但 name 不匹配判定），
  会造成"托管失效但 token 文件还在"的中间态。改为禁用 name 编辑，提示"内置 provider 名称固定"。
- 保存校验：`isManagedWorkBuddy` 时跳过 `api_key_required` 校验（它的值是 marker，不是用户输入）。
- 删除托管 provider 仍走既有删除路径（会清 Router 引用，`cleanUpConfigModels` 已有），
  但**不删凭证文件**；只有"断开连接"按钮删凭证。需在删除确认文案里补一句。

---

## 5. 数据面边界与必须覆盖的测试面（broad text tools streaming JSON usage error abort）

### 5.1 已证实的响应形态

- 标准 OpenAI SSE：`data: {...,choices:[{delta:{content|tool_calls|reasoning_content?},finish_reason}],usage?}` + `data: [DONE]`。
- 插件**只**做 tool name 还原，没有 provider-specific thinking/usage 转换（P:L903-960）。
- 测试 SSE 用 `choices[].delta.tool_calls[].function.name/arguments`，不是 Anthropic events。

### 5.2 stream / nonstream（实现前需确认，见 §9 决策点 Q1）

- 旧内置 M-parent `workbuddy.go:350-382` 原注释：`Non-stream chat request is currently not supported`，`Account.Stream:true`。
- 但当前社区 loader **没有强制 body.stream=true，也没有 JSON→SSE 聚合器**。
- **负证冲突**：magpie #2611 报告同一个空 tool id 请求在 `stream:false` 下 200、`stream:true` 失败。
  → 不能把"所有当前模型永不支持 nonstream"当可靠事实。
- **保守路径**：上游 stream:true；CCR 对 nonstream 客户端在内部聚合
  （**不能**把用户 `stream:false` 改成 true 后原样回 SSE）。
- 实现时若不确定：默认"上游恒 stream:true + 下游聚合"，并在文档/PR 里标注为**未真实验证**。

### 5.3 工具 schema 最小集（首期）

必做：① `max_completion_tokens`→`max_tokens`；② `developer`→`system`；
③ object 型 `tool_choice`→字符串（含 `none` 时删 tools）；④ 缺 system 首消息时补默认 system。
（= risks-report §5.2 的最小集判断。）

**明确不做（首期）**：`fitShape`/`fitEnum`/`objectRoot` 深整形（约 250 行）、
11153 空 assistant 插入、11150 归因、FLAGGED 重写、图片上传接口。
这些在 PR 里列为"后续"，不要偷偷做，也不要在 README 里宣称支持。

> 注意：P 的 root union 合并与"删除空 enum"**不是严格等价转换**（会改变 schema 约束）。
> 若后续移植，不能照抄其"完全无损"的注释宣称。

### 5.4 SSE error 与 HTTP 200

- HTTP 200 的 SSE 里可能出现 `finish_reason:"error"`（magpie #2471）。
  实现：`transformResponseOut` 流式路径检测到该信号时，**不得静默丢块**；
  至少原样透传并在日志记 `workbuddy_sse_error`（不带 token）。
- 上游 `{code,msg,data}` envelope 的非零 code 出现在 error body 时，走 §1.6 分类。

### 5.5 大 body ECONNRESET

- body > 2 MiB 且连接被重置时，客户端错误文案需提示"可能是登录态失效（上游对大 body 拒签会直接断连）"，
  不能只说"网络错误"。是否做 billing 探针判别列为后续（额外一次上游调用）。

### 5.6 abort

- `sendUnifiedRequest` 已合并 `config.signal` + 超时信号；body reader 取消由 `pipeThrough` 传播。
- 测试必须覆盖：下游取消 → 上游 fetch signal abort；不在流后半段重试推理（避免重复生成/计费）。

### 5.7 用法/计费

- `credits` ≠ token usage。不要把 billing credits 当 usage。
- 本次**未获**真实 token usage / cache reasoning SSE 全量 fixture → 不得宣称 usage 已验证。

---

## 6. 测试验收矩阵（隔离 mock，无真实上游）

测试环境纪律：`packages/core/vitest.config.ts` 已注入 `CCR_CONFIG_DIR=<tmpdir>/ccr-core-test-home`；
所有测试不得读真实 `~/.claude-code-router`、不得读真实 `~/Library/.../CodeBuddyExtension`、
不得访问 `copilot.tencent.com`。用 `vi.stubGlobal("fetch", ...)` + loopback 或纯函数 mock。

### 6.1 后端（`packages/core/src/__tests__/workbuddy-*.test.ts`）

| 测试文件 | 必覆盖 |
|---|---|
| `workbuddy-source.test.ts` | plain 合法导入；`sealed`（`$wbEncrypted`）→ `sealed` 且**不写凭证文件、不改 config**；missing → `source_missing`；JSON 坏 → `source_invalid`；`accessToken` 非 string → `source_invalid`；缺 `account.uid` → `source_invalid`；>1MiB → `source_invalid`；`domain`/`uid` 含 CRLF → `source_invalid`；`expiresIn` 秒 → ms 归一化 |
| `workbuddy-credential-store.test.ts` | 0600 落盘；原子 rename；读回；删除后 `getStatus()` → `not_connected`；**凭证不出现在任何 `configService.get("providers")` 快照里** |
| `workbuddy-config.test.ts` | upsert 新建托管 provider 形状（§2.1 全字段）；已存在托管 provider → 只更新 models/enabled/kind；同名**普通** provider → 409 `workbuddy_name_conflict` 且 config 未被写；`/api/config`（raw）响应里 `api_key === "ccr-managed-workbuddy"` 且不含任何 token 字段；Router 对象在 import/sync/disconnect 前后**深相等** |
| `workbuddy-models.test.ts` | `/v3/config` 合成 fixture：只取 `agents[name=="cli"]`；join 元信息；`supportedEfforts` + `canDisableThinking` 的 `none` 注入；同名显示名去歧义不改路由 id；HTTP 500 → `models_fetch_failed` 且**旧 models 保留**；`agents` 无 cli / `models` 空 → `models_fetch_failed` 且旧 models 保留；UA 断言：config 请求 UA **必须**是 `CLI/2.0.0 WorkBuddy/5.5.6`；`X-Domain` 存在且等于白名单值 |
| `workbuddy-transformer.test.ts` | `max_completion_tokens`→`max_tokens`；`developer`→`system`；补默认 system；`tool_choice` 三种形态 + none 删 tools；工具名安全化与**响应名还原**（request-local，两个并发请求不串味）；`auth()` 返回的 `Authorization` 覆盖默认 marker（模拟 `routes.ts:1103-1106` 的合并顺序）；`config.url` 恒为常量 |
| `workbuddy-headers.test.ts` | chat headers 全量断言（§1.2）；`X-Conversation-Message-ID`/`X-Request-ID` 每请求新值且相同；`X-Conversation-Request-ID` 在同一 turn 的工具回合间**不变**；`enterpriseId` 空时不发企业头、非空时发 |
| `workbuddy-stream.test.ts` | SSE 分片（含跨 chunk 断行的 UTF-8 多字节）、`[DONE]`、注释行、usage-only chunk、malformed 行原样透传；tool_call arguments 分片；`finish_reason:"error"` 检测；abort 传播 |
| `workbuddy-errors.test.ts` | 10085 / 11140 / 6004 / 14018 / `unapproved channel` / 未知 code 分类与文案；**任何错误字符串不含 token**；6004 冷却粒度为 provider+model |
| `workbuddy-admin-api.test.ts` | 4 个路由的 200/409/422/500；`GET /api/config` 不泄 token；disconnect 后 provider 消失、其它 provider 与 Router 不变 |
| `workbuddy-proxy.test.ts` | `proxy_enabled` true/false 下 `resolveProviderProxyUrl` 行为；service 自建 fetch 传 `httpsProxy` |

### 6.2 UI

- WorkBuddy 卡片：`not_connected` → 显示导入按钮与隐私警告；`connected` → 显示账号与模型数；
  `sealed`/`source_missing` → 对应错误卡；sync 成功后列表刷新；disconnect 有二次确认。
- 托管 provider 编辑对话框：`api_key`/`api_base_url`/`name`/`transformer` 禁用/只读，保存不报 api_key_required。
- **不出现任何 token 输入框**（grep 级断言：WorkBuddy 组件里不得有 `type="password"` 且 name 含 token 的输入）。

### 6.3 已知基线

`packages/core` `pnpm test` 现存失败/环境问题需先跑一次记录基线（本次未跑，见 §9 Q4）。

---

## 7. 安全红线（实现自检清单）

- [ ] 不读任意路径：源文件路径由 `process.platform` 三选一常量拼出，**无任何客户端可控路径输入**。
- [ ] 不写源文件：只用 `readFileSync`；无 `writeFile`/`chmod`/`unlink` 指向 WorkBuddy 目录。
- [ ] 不做 SSRF：网络目标只有两个常量 origin；`X-Domain` 只作 header 且白名单校验
      （`copilot.tencent.com` / `www.workbuddy.ai` / 空 → 默认 host），**绝不拼 URL**。
- [ ] 不解密：`$wbEncrypted` 直接判 sealed；不起厂商 Electron、不读 Keychain/DPAPI。
- [ ] token 不出现在：config.json、`/api/config` 响应、浏览器、错误正文、日志（含 debug log）。
- [ ] 不新增"自动登录"或"静默扫描源目录"：只有用户点导入才读一次固定文件。
- [ ] 不做浏览器登录 flow（首期）：没有 state job、没有轮询、没有 `authUrl` 打开。
- [ ] 不复制 FLAGGED prompt 重写。
- [ ] 不做自有 refresh（首期）：不花共享 refresh token，不改原端登录态。
- [ ] 不动真实 CCR 进程：实现/测试都用隔离 `CCR_CONFIG_DIR` 或 mock。

---

## 8. 权限与许可证

- `magpie-community/plugins` **MIT**（`gh api repos/magpie-community/plugins` → `license.spdx_id: "MIT"`；
  `packages/workbuddy/package.json` 亦 `"license": "MIT"`）。
- CCR 若复制 substantial 代码/tests：保留 `Copyright (c) 2026 magpie-community contributors`
  与 MIT permission/warranty notice；建议第三方 notices 文件。
- 本契约只描述协议与行为，**未复制**插件源码；实现方若逐行移植 `fitShape` 等，必须带署名。
- **MIT ≠ WorkBuddy/腾讯 ToS 授权**：未找到官方第三方订阅转发许可，未验证 ToS。
  PR/README 不得表述为"官方授权"或承诺"免封号"。

---

## 9. 待决策（实现前需 supervisor/用户确认，不要自行决定）

| # | 问题 | 影响 |
|---|---|---|
| Q1 | 上游是否恒 `stream:true` + 下游聚合？还是首期直接拒绝 nonstream 客户端？ | 影响 transformer 与 5.2 测试 |
| Q2 | `api_key` marker 用 `"ccr-managed-workbuddy"` 是否可接受？（`provider.ts:36-40` 要求非空才能注册） | 影响 §2.1 |
| Q3 | 断开连接是否同时删除托管 provider？（本契约：是） | 影响 UX 与 Router 引用清理 |
| Q4 | 后端/UI 是否各自先跑一次既有测试基线并记录？ | 影响 acceptance |

---

## 10. 未证实 / 残余风险（禁止当事实）

1. 未使用真实账号：所有端点/模型/UA 的当日有效性未验证；`/v3/config` 完整 schema 仅从插件解析代码反推。
2. `authUrl` 真实允许 host 全集未知；`X-Domain` 各站点允许值未知（故首期不做浏览器登录、domain 白名单从严）。
3. 流式/非流式支持存在源码旧注释与新 issue 反证冲突。
4. 未获真实 token usage / cache reasoning SSE 全量 fixture。
5. Claude Code/Codex 上游渠道拒绝是**实际残余阻碍**：即使导入/发现成功，也可能不能推理；不做对抗性重写。
6. 6004 两级窗口数值、11150、11153、11128 均未验证/未取证。
7. 国际站区域限制、CN 账号跨站：无一手证据。
8. 官方公开 API 是否存在：无一手证据。

---

## 11. CCR 侧已核对的代码点（实现时直接对照）

| 位置 | 事实 |
|---|---|
| `packages/core/src/services/provider.ts:29-135` | 从 config providers 生成实例；`!name \|\| !api_base_url \|\| !api_key` 直接 return（L33-35）；模型注册为字符串数组；`registerProvider` 建 `provider,model` 路由 |
| `packages/core/src/services/provider.ts:104` | `(providerConfig as any).quota_token` 先例 → `workbuddy_kind` 可同样透传 |
| `packages/core/src/types/llm.ts` | `ConfigProvider`/`LLMProvider` 定义；无 `[key:string]:any`（core 侧需显式或 `as any`） |
| `packages/core/src/types/transformer.ts` | `transformRequestIn/Out`、`transformResponseIn/Out`、`auth`、`endPoint` 契约 |
| `packages/core/src/api/routes.ts:920-958` | transformer 可返回 body/config（headers/url 可改） |
| `packages/core/src/api/routes.ts:1041-1057` | `shouldBypassTransformers`：`endPoint==="/v1/chat/completions"` + Anthropic system 数组强制不 bypass |
| `packages/core/src/api/routes.ts:1058-1100` | `sendRequestToProvider`：bypass 时调 `transformer.auth(requestBody, provider)`，合并 `auth.config.headers` 并 `delete headers.host` |
| `packages/core/src/api/routes.ts:1103-1106` | `Authorization: Bearer provider.apiKey` 先写，`...config.headers` 后写 → 后者覆盖 |
| `packages/core/src/api/routes.ts:1143-1156` | 上游 `errorText` 原样记日志并进客户端错误 → 需 WorkBuddy sanitizer 在此之前收敛 |
| `packages/core/src/api/routes.ts:1651-1652` | 已有 `rate_limit` 文本识别（fallback 分类可用）。实际函数在 `routes.ts:1647-1663` `isRateLimitError()`，已含 `限流`/`频率限制`，**6004 的中文文案天然命中**；不要删这些词 |
| `packages/core/src/ccr/admin-routes.ts:247-249` | `GET /api/config` 返回 `readConfigFileRaw()`（不插值） |
| `packages/core/src/ccr/admin-routes.ts:265-355` | `POST /api/config`：backup → write → `configService.reload()` → `set('providers')` → 重建 `ProviderService` → `reconcileHealthStore` → `resetActiveProbeService` + `startActiveProbe`。**新写入路径必须复刻这段**（reload 段在 L306-350） |
| `packages/core/src/ccr/admin-routes.ts:820-855` | `POST /api/providers/probe` 手动探针已存在（导入/同步后可复用） |
| `packages/core/src/ccr/config.ts:105-120` | `writeConfigFile` 前 `snapshotConfigBeforeWrite`，失败即拒写 |
| `packages/core/src/ccr/config.ts:110-122` | `assertNotTestEnv()`：`VITEST`/`CI` 下写 config 抛错 → 测试隔离 |
| `packages/shared/src/constants.ts:4-13` | `HOME_DIR` honors `CCR_CONFIG_DIR`；`CONFIG_FILE`、`PLUGINS_DIR` 等 |
| `packages/core/src/server.ts:86,140` | `providerService` 由 `Server` readiness 构造（`new ProviderService(configService, transformerService, app.log)`）；admin-routes 通过 `(_app as any)._server.providerService/transformerService/configService` 访问 |
| `packages/shared/src/self-provider.ts` | `ccr_managed` marker 与 `ensureCcrSelfProvider` 先例（含 tombstone 语义） |
| `packages/core/src/services/provider-health.ts` | state key 为 `provider,model`（`getState(provider, model)`）；`rateLimitUntil` 到期自动恢复（`isAvailable` 191-205）；`markRateLimited(provider, model, retryAfterSeconds?, error?)`（296-333），默认 120s（`DEFAULT_RATE_LIMIT_RETRY_AFTER_SECONDS`，L27） |
| `packages/core/src/services/proxy.ts:139-155` | `resolveProviderProxyUrl`：per-provider 策略已就绪 |
| `packages/core/src/transformer/amd.transformer.ts` | SSE 逐行改写 + `drainLines` 边界安全写法 + `peekBodyForSSE` 复用范例 |
| `packages/core/src/transformer/index.ts` | 内置 transformer 统一注册；`static TransformerName` 约定 |
| `packages/ui/src/components/Providers.tsx` | provider CRUD/保存/刷新；`api_key_required` 校验在 `handleSaveProvider`；`cleanUpConfigModels` 清理 Router 引用 |
| `packages/ui/src/components/ProviderList.tsx` | 普通 provider 卡片渲染（**不改**） |
| `packages/ui/src/lib/api.ts` | `apiFetch` + `createHeaders`；`/providers/probe` 等同型方法 |
| `packages/ui/src/locales/{en,zh}.json` | 文案段；新增 `workbuddy.*` |
| `packages/core/vitest.config.ts` | `CCR_CONFIG_DIR=<tmpdir>/ccr-core-test-home` 已注入 |

---

## 12. 验收口径（给 reviewer）

1. 无外部进程/插件安装：`git diff` 不含新依赖、不含 spawn 厂商二进制。
2. token 不出现在 `config.json`、`GET /api/config`、任何日志断言、任何 UI 快照。
3. `import`/`sync`/`disconnect` 前后 `config.Router` 深相等（D6）。
4. 同名普通 provider 存在时 import 返回 409 且 config 未被写（字节级比对）。
5. `/v3/config` 失败或空列表 → 旧 models 保留、状态可见、无静态兜底模型写入。
6. chat UA 与 config UA 分别断言（两个常量，不许合并）。
7. `sealed` 时不写凭证文件、不改 config、UI 停在 connected 之前。
8. 全部测试用隔离 mock；无真实上游调用、无真实登录文件读取。
9. MIT 署名（若复制 substantial 代码）。
10. PR 描述里明确列出 §10 未证实项，不宣称"Claude Code 全兼容/所有模型 thinking/images/usage 已验证/免封号"。


## 13. 父代理裁决（2026-10-19，优先于前文冲突项）

- Q1：上游强制 stream:true，下游 nonstream 聚合成 JSON；必须有跨协议管线测试，不直接把 SSE 返回给 nonstream 客户端。
- Q2：非秘密 api_key marker 可接受，不能作为真实凭据发上游。
- Q3：disconnect 删除 CCR 私有凭据和托管 provider，Router 保持不变，界面提示引用需用户调整。普通 provider 删除入口必须转到 WorkBuddy 管理操作，禁止 generic cleanUpConfigModels 悄悄修改 Router。
- Q4：后端/UI 记录既有测试基线，再验证新增路径。
- 覆盖 §3.3 顺序矛盾：候选凭据先读/验证并成功发现非空模型，然后提交凭据+provider，失败恢复旧状态；不得在网络发现前持久覆盖旧凭据。
- 覆盖 §2.2：首期不刷新，因此只保存 accessToken 与必要账号元信息，不保存 unused refreshToken。
- 覆盖自动状态扫描：GET status 不读取 WorkBuddy 登录源文件，只有用户明确 import 才读取；私有副本到期需显式重新导入。
- 覆盖文件所有权：后端只改 packages/core，常量/类型放 core 内，无需新增 shared 导出；UI 自有同构契约。
- 覆盖 domain 白名单：除 copilot.tencent.com 外允许调研已见 www.codebuddy.cn（CN），仅用于 X-Domain header，不用作 URL。
- 同步保留 existing.enabled:false，不自动重启用用户禁用的供应商。
- Transformer 不注册已有 /v1/chat/completions 的重复 endPoint；认证和 quirk 接入已有 HTTP 管线，在 before-error-logging 处脱敏，不能只依赖响应转换器事后修补。
- 隐私文案不能写 token 不外传（上游认证需要发送腾讯）；应精确写不回传浏览器、不写普通配置、只发送固定可信 WorkBuddy 数据面。
- 已知新版 encrypted desktop 登录态不支持导入；不绕过加密，不用静态模型假装连接成功，不做客户端身份 prompt 改写。

---

## 14. 双站支持与功能对齐（2026-10-19 修订，优先于 D2/D8）

> 触发：用户要求"支持国际版账号、对齐 magpie 功能"。本节所有论断均有 magpie pin 的行号证据；
> 凡标注"未证实"的，不得在实现或 PR 中当作事实。**自动签到经调研确认不存在，不做（D11）。**

### 14.1 站点定义（证据：P:L62-84 `SITES`）

| 字段 | CN (`workbuddy`) | 国际 (`workbuddy-ai`) |
|---|---|---|
| endpoint | `https://copilot.tencent.com` | `https://www.workbuddy.ai` |
| desktop 登录文件名 | `workbuddy-desktop.info` | `workbuddy-desktop-ai.info` |
| 模型集 | `CN_MODELS`（glm/kimi/deepseek/minimax/hy） | `AI_MODELS`（gpt/gemini/glm/kimi/hy/minimax + `default/fast/balanced/primary/deep-model` 别名） |
| 图片能力 | glm-5.3-flash 等支持 | **`noImages: /^glm-/`**：国际站 GLM 模型配置说支持图片但服务端会丢掉（P:L86-101） |
| 额外 header | 无 | `X-Agent-Type: main`（P:L281-282） |
| domain 白名单 | `copilot.tencent.com`、`www.codebuddy.cn` | `www.workbuddy.ai`、`www.codebuddy.ai`（仅 X-Domain 值；请求 origin 固定为 www.workbuddy.ai） |

**站点选择**：管理页显式选择 CN / 国际站；POST import 只接受两个固定 site enum，缺省 CN。
只读取所选站点固定文件，不扫描另一站，不接受路径/任意 URL；两站都登录时也能明确选择国际站。
文件内容 shape 一致（P:L1043-1069 `readDesktop` 对两个站点同一套解析）；真实账号格式仍待用户验证。

**一次一站**：凭证文件仍是单个 `workbuddy-credentials.json`，`kind` 从 `"workbuddy"` 扩为
`"workbuddy" | "workbuddy-ai"`；provider name 仍固定 `"workbuddy"`（路由 id 不变，用户 Router 不受影响）。
切换站点 = 断开当前站 → 重新导入（显式动作，不做静默切换）。

### 14.2 凭证字段（证据：P:L1043-1069）

只保存 accessToken、expiresAt、kind、uid、enterpriseId、domain、tokenType 和导入时间。
**不保存 refreshToken/refreshExpiresAt**：按用户裁决不调用刷新接口，无需增加闲置秘密。旧凭证无新字段仍可读。
tokenType 不参与鉴权拼接（始终 Bearer）。

### 14.3 Token 续期：**按需重读桌面文件**（2026-10-19 用户裁决，覆盖 D8 早前修订）

**裁决：不实现自有 refresh，不花 refreshToken。** 理由（证据：P:L1081-1084、`:1098-1110`、`workbuddy-README.md:55-57`）：
上游 refresh 回复会**轮换** refreshToken，而我们不写回桌面文件 → 用户的 WorkBuddy 桌面端将持有已花掉的
refresh token；插件用「内存持有、绝不写回」规避，且加了 `h.expires >= d.expires` 偏好（应用自己续过就用它的）。
该规避能把频率降到很低但**不能消除**风险，且是否真会把桌面端登出在上游是「推断、未证实」。
CCR 选择零风险路径：**不保存、不使用 refreshToken 于任何请求路径**。

**实现规则**：
1. 仅保存 accessToken 与必要元信息；refreshToken/refreshExpiresAt 丢弃，任何请求路径不得调用 `/v2/plugin/auth/token/refresh`。
2. 凭证里的 `accessToken`/`expiresAt` 是**快照**。当快照 `expiresAt - now <= 300_000`（magpie `LEAD_MS`）或已过期时，
   `currentCredential()` **重新只读桌面登录文件**（固定路径、`O_NOFOLLOW`、1 MiB 上限、只读）：若文件里的 token 更新
   （`expiresAt` 更晚）则**仅在内存中**替换本次请求用的凭证，**不写回 CCR 私有凭证文件**（避免把应用轮换中的 token 固化）。
3. 重读失败/文件没有更新 → 用原快照继续（上游会给 401，走既有分类错误提示重新导入）。
4. 这条放宽了 §13「只有 import 才读源文件」——**但仅限访问 token 临期/已过期时**，且仍是固定路径只读，不构成新的读取面。
   `getStatus()` 仍然**不读**源文件（§13 不变）。
5. 按站点+uid+enterpriseId+导入代际+访问 token 摘要做单飞与 60s 有界缓存，避免换账号/重新导入后复用旧凭证；重读结果必须匹配同站点、uid、enterpriseId。status 可读当前代际已使用的内存快照，但不读源文件。

### 14.3b EDGE_READS 诊断（用户 2026-10-19 选中；证据：P:L1152-1160）

上游前置（APISIX，两站一致）对**被拒的登录态**只读请求体前 **2 MiB**（`EDGE_READS`）：超过即**直接 Reset 连接**，
客户端只看到 `ECONNRESET`，没有任何诊断。实测：2 097 152 字节 → 401；2 097 153 字节 → reset；有效 token 下 20 MB 正常。

**实现规则**：
1. 仅对 managed WorkBuddy provider：当上游请求失败且**不是**已分类的 WorkBuddy 错误时，若请求体字节数 > 2 MiB，
   用一次**小型** billing 请求（`POST {endpoint}/billing/meter/get-user-resource-summary`，body `{}`）确认登录态：
   - 401 → 抛分类错误「WorkBuddy 登录态已失效，请重新导入（大请求会被上游直接断开，故先探测）」，
     `code: "workbuddy_reauth"`、`nonRetryable: true`。
   - 非 401 → 原错误原样抛出（确实是网络/上游问题，不伪装成登录态问题）。
2. 探测本身 `redirect: "error"` + 固定 origin；**不得**重发原请求。
3. 探测结果按凭证代际缓存 60s（有界），并发单飞；响应体释放，15s 超时。不能跨站/账号复用。大型失败请求不因探测而重复发送；非 401 保留原错误分类。

### 14.3c 两个已确认缺陷修复（用户 2026-10-19 选中；证据：P:L1075、`:447-451`）

1. **sealed 检测过严**：我们用 `=== 1` 判定 `$wbEncrypted`，插件用**真值**判定（`:1075`）。
   `{$wbEncrypted: "1"}` 或其它真值会被我们判成 `source_invalid`（文案「无法解析」）而非 `sealed`（文案「5.6+ 已加密」）。
   → 改为真值判定（`!!a?.accessToken?.$wbEncrypted`）。
2. **`X-Conversation-Request-ID` 缺失**：插件在 turn key 为空时也发一个**新随机** hex（`:447-451`）；我们不发，
   导致该请求在 WorkBuddy 用量明细里归属不到任何 turn。
   → turn key 为空时补 `randomBytes(16).toString("hex")`（32hex，与 message id 同格式）。

   附带（同一处比对发现，低优先，首期不动）：我们的 11140/14018 文本正则缺少插件的 `(?![\d.])` 数字边界保护；
   且我们匹配了插件从未提及的 `11150`。记录备查。
### 14.4 用量/额度查询（可选展示，证据：P:L1139-1210 `meter`、L1228-1260）

- `POST {endpoint}/billing/meter/get-user-resource-summary` → `usageOf`：plan（Pro/Free）+ Credits 窗口（used/limit）。
- `POST {endpoint}/billing/meter/get-enterprise-user-usage` → 企业账号额度（个人账号返回空）。
- 请求体 `{}`；header 与 chat 同套 + `X-Product: SaaS`。
- **仅用于管理页只读展示**，不参与路由决策；失败静默（不弹错、不影响连接状态）。
- 不做 packages/price 明细（P:L1281-1360 需要 `PackageCodes` 硬编码商品码列表，脆且无用户价值）。

### 14.5 图片能力（证据：P:L86-101 `textOnly`）

- 国际站 GLM 模型（`/^glm-/`）：即使 `/v3/config` 说 `supportsImages: true`，请求带图片也会被服务端丢弃并回一条
  "[System reminder: the current model does not support images...]"。
- 实现：**不主动剥图片**（保持请求忠实），但在管理页模型列表对该组合标注"国际站 GLM 模型实际不支持图片"，
  避免用户困惑。这与 magpie 的做法一致（magpie 是让"图片描述模型"代读，CCR 无此设施，故只提示）。

### 14.6 待确认项（实现前必须由父代理/用户确认，或标注未证实）

1. 不调用 refresh 接口，因此不依赖 desktop refresh token 在真实上游的可用性；仅按需重读同站同账号的较新 accessToken。
2. 国际站 desktop 登录文件的真实存在性与 shape：证据只有插件的 `desktopFile(site)` 拼接逻辑，
   **未读真实文件**。导入失败时错误文案需同时覆盖"未登录/已加密/文件不存在"三种。
3. 国际站 `X-Agent-Type: main` 是否为硬要求（P:L281-282 只在 `site.ai` 时设置）——照发，未证实缺失后果。

### 14.7 明确不做

- 自动签到 / 积分任务（D11：不存在该功能）。
- 浏览器登录 flow（D3 不变）。
- packages/price 商品码明细（§14.4）。
- 账号池 / 多账号轮换（B 方案已否）。


## 15. 浏览器授权与配置管理供应商 tab（2026-10-19 用户修订，优先于 §13–14）

### 真实需求与入口
- 配置管理新增「供应商」tab（`/settings?tab=providers`），不是新侧栏页，也不是 localStorage 显隐开关。
- 开启=明确授权账号、非空模型发现并持久化托管 provider。首页只展示已配置 provider 的普通行和模型；未配置时不出现常驻 WorkBuddy 大卡片。托管 edit/delete 导航至此 tab。
- 浏览器授权不要求安装桌面端；保留 desktop 导入 API 兼容原有账号，不再作为 UI 主入口。

### 上游证据与安全边界
- 一手源 `magpie-community/plugins@ab38da681af7716ea9a7609f045ca91d2ad9988a`，`packages/workbuddy/index.mjs:979–1032`：state→浏览器 authUrl→token poll→account，enterpriseOf `:302–323`。源码只能证明社区插件实现，不能声称官方推荐或已实测上游。
- 固定站点 POST `/v2/plugin/auth/state?platform=<site>`；浏览器访问 HTTPS authUrl，带 version=2.0.0/loginSessionId。CCR 不代理登录页面或处理密码。
- authUrl 允许 CN copilot.tencent.com / codebuddy.cn、AI workbuddy.ai / codebuddy.ai 域名族；拒绝非 HTTPS、userinfo、非 443 端口。不支持的真实登录 host 需用户反馈后基于证据调整，不接受任意目标。
- token/account/refresh/发现均 fixed-origin、redirect:error、直连 dispatcher、15s 超时、1 MiB envelope 上限。上游原始错误不得进入日志或浏览器。

### API 与生命周期
- POST login/start `{site}`→`{ok,site,loginId,url,expiresAt}`，每次独立 48hex capability；upstream state 仅驻内存。最多 8 个 pending+starting 任务，5min TTL。
- POST login/poll `{site,loginId}`→pending/expired/none/failed/connected。每任务单飞+1s 最小间隔，account 返回 12151 时保留 token 阶段供下次尝试，不重复兑换 token、不内部循环重试。
- POST login/cancel `{site,loginId}` 只失效该任务；disconnect/import epoch 失效旧工作，提交前后检查并回滚取消时写入；浏览器 cancel/unmount/timeout 调用 cancel。
- 成功前必须非空 `/v3/config`；发现失败/空、写入失败保留旧账号/provider/Router。token+refresh 仅 CCR 0600 私有凭证文件，不进 `/api/config` 或浏览器。

### refresh 所有权（覆盖 D8 的 blanket 禁止）
- `source:desktop` 仍绝不保存或花费共享桌面 refreshToken，只读更新 access 快照（§14.3）。
- `source:browser` 的授权由 CCR 创建，refreshToken 仅存私有文件；临期单飞刷新并持久化轮换结果。不读取桌面文件。刷新和 mutation 队列/epoch 防止 disconnect/reimport 后旧结果复活。
- status 返回 source/renewalMode，不做源文件读取或上游调用。

### 验证与已知边界
- WorkBuddy/debug 131/131；core 全量 596/596（本次未复现既有 usage 污染），UI 28/28；UI tsc 通过，core 基线110无新增；独立审查 SHIP。
- 隔离 mock 浏览器：无常驻卡片→供应商tab→国际授权待定→取消→重新授权成功→手动额度→首页模型行→edit回管理tab。0 full-config POST、1 cancel、1 usage GET、Router 保持。
- 真实 CN/AI 授权/host/模型推理尚待用户登录验证；不宣称 live 通过。
- P2：提交完整成功后的极窄取消窗口可能让 UI 显示取消但连接已提交，重新进入 status 可见；不涉及秘密泄漏或半提交复活，独立审查定为非阻塞。


## 16. 跨站点 + 多账号池 + 模型隐藏（2026-10-20 用户修订，优先于 §13–15 的单账号限制）

### 用户裁决
1. **跨站点同时连接**：CN 与国际站可同时在线，各自一个托管 provider：CN=`workbuddy`，国际站=`workbuddy-ai`。站点间互不冲突（原 409 workbuddy_site_conflict 仅在"同站点重新授权另一个账号"之外不再出现）。
2. **同站点多账号**：每站点账号池（1..N）。登录/导入=向该站点池添加账号；同 uid 重复登录=替换该账号凭证。
3. **请求中自动故障转移**：上游额度/限流/封禁类错误时，把该账号按错误类冷却，透明换号重试同一请求（次数≤池大小），全部不可用才把最后一个已分类错误返回给客户端。
4. **模型隐藏**：hiddenModels 黑名单按站点存储；隐藏=从 provider.models 移除且同步/重登不复活，可随时恢复；提供"恢复全部"。
5. **自动清理 Router**：隐藏模型时自动把 Router 中引用 `<provider>,<model>` 的场景清空；若 default 被清，则置为 `<provider>,<首个可见模型>`；custom routes 中引用该模型的条目整条移除。返回 clearedRefs 供 UI toast。同步导致的模型消失不做 Router 改写（只有显式 hide 才改）。断开整站仍保留 Router 引用+提示（不变）。

### 错误→冷却分类（复用 §"错误分类"，账号粒度）
- **14018** insufficient_quota：账号级，冷却到下个本地 00:05（slice 每日重置），上限 24h。
- **6004 / HTTP429** rate_limit：账号+模型粒度；上游"将在 … 重置"可解析则用之，否则 15min。
- **11140** workbuddy_account_restricted：账号级 7200s 起长冷却；全部受限时返回申诉文案（不重试轰炸）。
- 10085（CCR 自身协议错误）与 workbuddy_reauth 非重试类**不触发换号**；换号重试只对上三类，且每请求总上游尝试次数 ≤ 池大小。

### 存储（workbuddy-credentials.json v2，仍 0600，仍不入 config/备份）
```
{ version: 2, sites: { "<site>": { hiddenModels: string[], activeUid: string|null,
    accounts: [ { uid, displayName, enterpriseId, domain, source: desktop|browser,
      accessToken, refreshToken?, expiresAt, refreshExpiresAt?, importedAt, tokenType?,
      cooldown?: { until: number, scope: "account"|"model", model?: string, code: number } } ] } } }
```
- v1 单对象迁移：进入 `sites[kind].accounts[0]` 并设为 activeUid；迁移前写 `workbuddy-credentials.v1.bak`（0600）。
- provider 迁移：kind=workbuddy-ai 且旧 provider 名为 `workbuddy` → 改名为 `workbuddy-ai`，并把 Router 中模型 ∈ 该站模型列表的 `workbuddy,<model>` 引用改写为 `workbuddy-ai,<model>`；其余引用不动。CN 凭证沿用 `workbuddy` 名，无需改写。
- marker：CN 沿用 `ccr-managed-workbuddy`；国际站新增 `ccr-managed-workbuddy-ai`。isWorkBuddyRuntime 同时识别两者；transformer 由 provider 名/api_base_url 判站点。
- epoch 改为**按站点**；disconnect/account remove/取消登录使该站 epoch+1，失效该站的 poll/refresh/sync/persist 检查点，回滚语义同 §15。
- refresh：browser 账号各存各的 refreshToken，仅存本文件并按 uid 单飞轮换；desktop 账号仍绝不保存/花费共享刷新态，临期同站+同 uid+同 enterprise 有界内存续期。

### 账号选择与换号
- 选择：activeUid 可用（无覆盖该请求模型的冷却）则沿用（粘滞）；否则按「冷却剩余最少、importedAt 最早」选可用账号；无可用→返回最后一个已分类错误。
- 变更账号（登录入池/移除/切换/冷却）不修改 Router、不改 provider 名称/URL；移除 active 账号时 activeUid 顺延到剩余最早账号；池空=该站断开（provider 移除，Router 引用保留+提示，同 §14 语义）。
- 模型发现仍按站点、用当时 active 账号执行；站点模型集=并集累计，注册前过滤 hiddenModels。

### API（全部本机校验 + 脱敏，路径均在 /api/workbuddy 下）
- GET `status` → `{ sites: { "<site>": { status, providerName, accounts: [{ uid, displayName, source, active, coolingUntil?, restrictedUntil?, expiresAt }], activeUid, models, hiddenModels, modelCount, lastSyncAt, lastError } } }`；顶层旧扁平字段保留为"唯一已连站点"的镜像（仅向后兼容一版）。
- POST `login/start|poll|cancel` `{site,...}` 不变；persist 成功=入池（新 uid 追加，旧 uid 替换凭证）。
- POST `account/switch` `{site, uid}`；POST `account/remove` `{site, uid}`；POST `sync` `{site}`；POST `disconnect` `{site}`（整站断开）。
- POST `usage` `{site, uid?}`（uid 缺省=active；仍只在点击时调用）。
- POST `models/hide` `{site, model}`（含 Router 自动清理，返回 `{ok, clearedRefs}`）；POST `models/restore` `{site, model?}`（缺 model=全部恢复，恢复不自动回写 Router）。

### UI（设置→供应商）
- 每站点一张卡（CN/国际站各自独立，互不互斥）；卡内：账号列表行（脱敏 uid、来源徽章、active/冷却中(至 hh:mm)/受限 徽章、每账号「读取额度」「设为当前」「移除」）、「浏览器授权 / 添加账号」按钮、模型 chips 带 × 隐藏、折叠「已隐藏模型 (n)」可恢复、Router 自动清理 toast（列出 clearedRefs）。
- 首页：每个已连站点一行普通 provider（workbuddy / workbuddy-ai）+ 各自模型；edit/delete 导航回设置对应站点卡。

### 测试要求
- store v1→v2 迁移（含 provider 改名 + Router 改写 + .bak）；池 rotation/冷却（fake timers）；换号仅对 14018/6004/11140、上限=池大小、reauth 不换；hiddenModels 过滤同步/注册、hide 的 Router 自动清理（default/场景/custom 三种引用）、恢复不回写 Router；per-site epoch 隔离（CN 断开不影响 AI 的 poll/refresh）；browser 多账号各自单飞刷新；本地校验/脱敏不变；UI mock 双卡、账号行操作、隐藏/恢复、toast。
