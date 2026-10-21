# Gemini 订阅账号 Provider 设计（复刻 magpie 路线）

> 日期：2026-10-21　状态：用户已授权实施，M1 开发中；核实修订见实施契约
> 方法：auto-research 四阶段。Phase 1 本项目代码本地直读；Phase 2 三个并行调研子代理经 `gh api` 直读 `yetone/magpie`（Go）源码与 issue 一手原文（材料存档：
> `~/.pi/agent/sessions/desktop/subagent-artifacts/outputs/36a3d25a-1ca0-4929-9815-8179441b78fe/research/{magpie-gemini-oauth,magpie-gemini-risk,magpie-upstream-fit}.md`）；
> Phase 3 交叉验证时，关键接缝事实（`routes.ts:1281`、`routes.ts:1313-1319`、`provider.ts:106-108`）已由主 agent 二次亲自核对。
> 标注约定：`事实` = 一手直读的代码/原文；`推断` = 设计判断。前序文档：`docs/design/google-subscription-provider-ecosystem.md`（2026-10-14）。

---

## 0. 结论速览

1. **CCR 已有两条 Gemini 路线，但都不是用户要的**：`gemini.transformer.ts`（API key）与 `vertex-gemini.transformer.ts`（Vertex/ADC）。订阅 OAuth 是第三条完全独立的协议栈——`事实`：magpie 中两者零代码交集（`gemini_api.go` 仅是 API key 的 URL 工具，注释自证）。
2. **技术上可行性高**：CCR 的 transformer 已支持 `config.url` / `config.headers` 覆写与受管 provider 模式（WorkBuddy 全套先例），翻译层是「填空」不是「改造」。
3. **真正的成本在协议长尾与风控面，不在代码**：Code Assist 信封的 body 怪癖（thought-signature 哨兵、functionResponse 配平、首尾 model turn 补丁、UA 指纹）需要像 magpie 一样 issue 驱动逐步补齐；Google 已明文定性 ToS 违规并在数据面做主动客户端识别，执法梯度为「首次封禁 1–2 天可申诉恢复、二次永久、按账号信誉降权」。
4. **建议形态**：实验性 provider，仅支持 Antigravity 账号（个人号唯一活路，`事实`：Gemini CLI 个人池 2026-06-18 被官方关停），v1 单账号、无自动轮换、无任何内容混淆，风险文案强制明示，可一键整体禁用。
5. **红线（继承 magpie 自身立场）**：不做零宽空格/身份行改写等规避功能（magpie #2139 维护者原话拒绝入核心）；伪装 429 与真 429 必须分流；`VALIDATION_REQUIRED` 须保留恢复路径，validationUrl 经官方 HTTPS host 校验后独立返回，不转发整个错误体。

---

## 1. 问题定义与范围

**目标**：让 CCR 用户用 Google 订阅账号（Antigravity / Gemini CLI 登录态）作为供应商，跑 Gemini 系模型，复刻 magpie 的认证链与数据面协议。

**非目标（v1）**：多账号自动轮换池（执法加速面，见 §4.2）；Claude/GPT 等借道 Antigravity 的非 Gemini 模型（magpie 支持，但那正是身份识别重灾区，#666）；内容混淆/伪装中间件（§4.3 红线）。

**用户已拍板**：走「订阅 OAuth（复刻 magpie）」，不做 API key 路线（已有）。

---

## 2. 本项目已有能力与真实缺口（Phase 1 事实）

### 2.1 已有（沿用即可）

| 能力 | 出处 |
|---|---|
| transformer 注册表：类即注册，按 `TransformerName`/`name` | `packages/core/src/transformer/index.ts:1-56`；`services/transformer.ts:125-157` |
| **数据面 URL 可被 transformer 覆写** | `packages/core/src/api/routes.ts:958-964`（`config = {...config, ...transformIn.config}`）→ `routes.ts:1281`（`const url = config.url || new URL(provider.baseUrl)`）【主 agent 已亲自核对】 |
| **请求头后写覆盖**（transformer 的 `config.headers` 覆盖默认 `Authorization: Bearer apiKey`） | `routes.ts:1313-1319`【主 agent 已亲自核对】 |
| 受管 provider 标记透传先例（`workbuddyManaged`） | `services/provider.ts:106-108`【主 agent 已亲自核对】 |
| 发送前二次锁定上游 URL + `redirect:"error"` + 直连 dispatcher 的加强模式 | `routes.ts:1270-1281`（WorkBuddy 分支，订阅 URL 同样固定，可直接套用） |
| 0600 私有凭证文件 + 登录三段式（start/poll/cancel）+ 管理路由本地守卫 + config 保护锁 | `services/workbuddy.ts`（CredentialStore/lockWorkBuddyProvider）；`ccr/admin-routes.ts:923-960, 1190-1258` |
| Gemini 原生请求体构造/响应解析 | `utils/gemini.util.ts`（`buildRequestBody`/`transformResponseOut`，含 thinkingConfig、thoughtSignature 透传） |
| 模型同步失败回滚、隐藏模型不复活 | `services/workbuddy-auth.ts:833-930, 1178-1222` |

### 2.2 缺口（全部要新建）

全仓库 grep `oauth|OAuth|PKCE|code_verifier` 零命中（`事实`）。要新建的协议层：

1. OAuth 授权码 + PKCE + loopback 本地回调（含降级「粘贴 URL」模式）；
2. token 内存刷新（2 分钟提前量，兼容 refresh token 替换并安全持久化）；
3. Code Assist 管理面：`loadCodeAssist` → `onboardUser`（项目/套餐发现）；
4. `{model, project, request}` 信封封装与 SSE `{response}` 剥壳；
5. UA persona（`GeminiCLI/0.61.0/<model> (platform; arch; terminal)` / `antigravity/hub/<ver>`）；
6. body 怪癖补丁集：`skip_thought_signature_validator` 哨兵、functionResponse 与 functionCall 配平、历史首尾 model turn 修正。

---

## 3. magpie 实现拆解（外部一手事实）

### 3.1 认证链（`internal/provider/google.go`、`signin.go`、`google_import.go`）

- **形态**：Authorization Code + PKCE(S256) + loopback 回调，`access_type=offline&prompt=consent`。**无 device flow**（`signin.go` 的 devicePoll 只用于 Copilot/Factory/ZCode）。回调端口 `127.0.0.1:0` 动态取；被占时降级为用户粘贴落地 URL。
- **两套借用的 installed-app OAuth client**（`事实`，`google.go` 包级常量）：
  - Gemini CLI：`681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j…` / `GOCSPX-4uHgMPm-…`，回调 `/oauth2callback`@127.0.0.1，scopes：`cloud-platform + userinfo.email + userinfo.profile`；
  - Antigravity：`1071006060591-tmhssin2h21lcre235vtolojh4g403ep…` / `GOCSPX-K58FWR486…`，回调 `/oauth-callback`@localhost，额外 scopes：`cclog`、`experimentsandconfigs`。
- **旁路入口**：① 导入第三方工具导出的 refresh_token（仅 antigravity，导入即验证，单批 ≤200、4 并发）；② 只读复用 `~/.gemini/oauth_creds.json`（经 id_token `azp` 校验 client 身份，绝不写回）。
- **存储**：refresh_token 持久化（magpie 存 `~/.config/magpie/logins.json`）；access token 只在内存按 refresh_token 缓存刷新（>2min 有效期复用），假设「Google refresh token 不轮换」（`google.go` googleState 注释原文）。
- **host 分工**：`codeAssistProd = cloudcode-pa.googleapis.com`、`codeAssistDaily = daily-cloudcode-pa.googleapis.com`；Gemini CLI 账号全走 prod；**Antigravity 账号数据面走 daily，`loadCodeAssist` 走 prod**（`googleAppOf()`）。

### 3.2 项目/套餐发现

`loadCodeAssist`（metadata 按 app 区分：`GEMINI` vs `ideType:"ANTIGRAVITY"`）→ 回复有 `currentTier` 取 `cloudaicompanionProject`；否则按 default tier 调 `onboardUser`（LRO，2s×5 次轮询）。`事实`：Gemini CLI 路线对个人号直接报错「个人账号不被服务，请用 Antigravity」。

### 3.3 数据面（`internal/gateway/codeassist.go`、`gateway.go`）

- 端点恒为 `{base}/v1internal:streamGenerateContent?alt=sse`（即使非流式请求也流式打再聚合）。
- 请求体 = Gemini 原生体（`contents/systemInstruction/tools/generationConfig`）包 `{model, project, request}` 信封；发送前账号侧补：Gemini 系 `user_prompt_id`（随机 12 字节）+ 实验旗标改写模型 id；Antigravity 系 `userAgent:"antigravity"` + `requestType:"agent"` + `requestId:"agent-<rand>"` + `request.sessionId`（首条 user 文本 SHA256 前 8 字节经 63-bit mask，会话内稳定）。
- 响应 SSE data 行 = `{response: <Gemini chunk>}` 或 `{error:{message}}`（**流式错误无 HTTP status，只能按消息文本分类**）。
- 怪癖集（magpie 已踩平，逐条有测试）：functionCall 必带 `thoughtSignature`（Gemini 3 的用真值，其余可填哨兵 `"skip_thought_signature_validator"`）；functionResponse 与 functionCall 数量必须配平（未答补合成结果）；历史不得以 model turn 开头/结尾；Antigravity 上 Claude 系 `maxOutputTokens` 必填；`default_api:` 工具名命名空间。

### 3.4 指纹

UA 数据面带本次模型 id（`GeminiCLI/0.61.0/gemini-2.5-pro (darwin; arm64; terminal)`，版本硬编码）；Antigravity UA `antigravity/hub/<ver> <os>/<arch>`，版本号每 6h 从其自动更新 manifest 探测，兜底 `2.9.1`。

---

## 4. 风险边界（一手证据汇总，细节见调研材料 magpie-gemini-risk.md）

| # | 风险 | 一手证据 | 对本设计的约束 |
|---|---|---|---|
| 4.1 | ToS 明文禁止 + 封禁梯度 | Gemini CLI ToS 页（2026-10-21 curl 直读）："Directly accessing the services powering Gemini CLI … using third-party software … is a violation … may be grounds for suspension or termination of your account"；官方公告 #20632：首次违规表单申诉 1–2 天自动解封，**二次永久**，且封禁横切 Antigravity/Gemini CLI/Code Assist 三面 | 添加账号时必须强制展示风险文案（可借 magpie `AntigravityRisk` 措辞强度：Google may suspend an account it sees used outside Antigravity. Use one you can afford to lose.）；文档写明「再犯永久」 |
| 4.2 | **多账号轮换是执法加速面** | magpie #1649：同类切号工具 aio-coding-hub 用户报告封了两个号；维护者承认池化功能无法担保 | v1 单账号，不内建自动轮换；后续如做多账号，默认关闭 + 独立风险确认 |
| 4.3 | **内容混淆红线** | magpie #2139 维护者原话拒绝做伪装网关（"违反对方的使用条款，也可能让您的账号被封"）；antigravity-cloak 插件自承 "Google can ban the account for it" | **CCR 不做任何零宽空格/身份行改写**；CCR 自身注入上游的身份文本（如有）保持中性并纳入回归测试 |
| 4.4 | 伪装 429（身份拦截冒充配额） | #666：Antigravity 对 systemInstruction 带 Claude Code 标记的请求恒回 429 "Resource has been exhausted"，与配额无关；Google 按提示词内容主动识别客户端 | 错误分类必须区分「身份拦截型 429」与真配额 429；前者账号级熔断 + 明示非额度问题，不走自动换号重试 |
| 4.5 | VALIDATION_REQUIRED 403 | #152：Google AI Pro 付费号 6 连 403 "Verify your account to continue"；magpie v0.1.304 起解析 `error.details` 的 `VALIDATION_REQUIRED` + `validation_url`，账号休息 30 分钟 | 仅提取 reason 与经官方 HTTPS host 校验的 validationUrl，不转发任意 details/原文；该信号视为账号熔断而非可重试错误 |
| 4.6 | 通道持续降权 | 官方公告 #22970：加强检测 + 按 account standing 优先级调度 + 免费档模型收紧 | 产品定位只能是「实验性、风险自担」，不得作为默认/推荐供应商 |

---

## 5. 方案：推荐架构与切片计划

### 5.1 新增文件（命名对齐 WorkBuddy 先例）

| 文件 | 职责 |
|---|---|
| `packages/core/src/services/gemini-oauth.ts` | 协议常量与纯函数：两个 app 常量（client/scopes/端点/回调路径）、PKCE 工具、`refreshAccessToken`、`loadCodeAssist`/`onboardUser`、`fetchAvailableModels`、`envelope()`（复用 `gemini.util.buildRequestBody` 造内层）、`unwrapSseChunk()`、怪癖补丁函数、错误分类（含 4.4/4.5 两类） |
| `packages/core/src/services/gemini-oauth-auth.ts` | 凭证服务（`WorkBuddyAuthService` 同构）：0600 凭证文件、login start（起 loopback http server 收 code，10min 超时，端口被占降级粘贴模式）/poll/cancel、token 内存刷新、`upsertManagedProvider`（模型同步→config→reloadRuntime）、`isGeminiOauthRuntime`/`lockGeminiOauthProvider`/`protectGeminiOauthConfig` 三件套 |
| `packages/core/src/transformer/gemini-oauth.transformer.ts` | 数据面：**不设 endPoint**（学 `workbuddy.transformer.ts:7-11` 避免端点撞车）；`transformRequestIn` 返回 `{body: 信封, config: {url, headers:{Authorization: Bearer <live token>}}}`；`transformResponseOut` 剥 `{response}` 壳后委托 `gemini.util.transformResponseOut` |
| `packages/core/src/__tests__/gemini-oauth-*.test.ts` | 信封形状、header 覆盖次序、SSE 剥壳、错误分类（伪装 429 / VALIDATION_REQUIRED / 真 429）、config 保护锁；全部 mock 上游，回归要求 mutation-verified |

### 5.2 修改文件

| 文件 | 改动 |
|---|---|
| `transformer/index.ts` | 导出新类（注册表纯增量） |
| `types/llm.ts` | `LLMProvider` + `geminiOauthManaged?: boolean`、`geminiOauthKind?: "antigravity" \| "gemini-cli"`；`ConfigProvider` 加对应 snake_case 字段（两接口**无索引签名，必须显式**） |
| `services/provider.ts` | `initializeFromProvidersArray` 透传新标记（对齐 `provider.ts:106-108`） |
| `ccr/admin-routes.ts` | ① config 保存处追加 `protectGeminiOauthConfig`；② 新增 `/api/gemini-oauth/{status,login/start,login/poll,login/cancel,sync,disconnect}`，复用本地守卫与错误码映射骨架（`assertLocalWorkBuddyRequest` 可抽公共） |
| `server.ts` | 实例化 + `setGeminiOauthRuntime({authService})`（对齐 `server.ts:136-144`） |
| `api/routes.ts` | **最小专用接缝必需**：HTTP 错误在 transformer 前已被通用分支消费；须提前分类/脱敏、更新状态，401 至多一次强制刷新重发；发送前锁定 URL/header、拒绝重定向。响应提交后不重试，其他 provider 行为不变 |
| UI 四件套 | `types.ts`（`GeminiOauthKind` + 状态/轮询类型，照 WorkBuddy 段抄形）、`lib/api.ts`（客户端方法）、新 `GeminiOauthProvider.tsx` 管理卡（挂 `SettingsPage.tsx` 供应商区）、`locales/{en,zh}.json`（`geminiOauth.*`，**含风险提示文案**） |

### 5.3 切片顺序（风险前置）

- **切片 A（数据面最小闭环，~4 文件，零 UI/零 OAuth 流程）**：瘦 `gemini-oauth.ts`（常量+refresh+project+信封+剥壳）→ transformer → 注册表 → 测试。手工验证：凭证文件临时放入外部工具导出的 refresh_token（对齐 magpie 导入语义）→ config 手写 provider → curl `/v1/chat/completions` 拿到真实流式回复。数据面是唯一无现成骨架的部分，必须最先验证。
- **切片 B（OAuth + 管理面）**：login 状态机 + admin 路由 + config 保护锁 + server 装配。全程套 WorkBuddy 同构骨架。
- **切片 C（UI 卡片 + 风险文案 + locale）**。
- **切片 D（可选，后议）**：gemini-cli kind（Standard/Enterprise）、配额适配器（注意 `getQuotaAdapter` 按 hostname 匹配，订阅 host 需 marker 分支）；HTTP 分类/脱敏接缝为 M1 必需项，不推迟到 D。

---

## 6. 备选方向对比

| 方向 | 内容 | 优势 | 代价/风险 | 结论 |
|---|---|---|---|---|
| **A. 实验档 Antigravity 订阅 provider（推荐）** | §5 全案，v1 单账号、仅 antigravity kind、含风险文案与错误分类 | 个人号唯一可用路线；WorkBuddy 骨架降低 60% 工程量（`事实`：等价物清单见调研材料 §3） | ToS 风险由用户自担；协议怪癖长尾需 issue 驱动维护 | 采纳 |
| B. 不做订阅路线，补文档（API key + Vertex 已够） | 零代码，仅完善现有两路线文档 | 零风险 | 不满足用户明确需求（订阅 OAuth） | 否决（用户已拍板 A 方向） |
| C. 完整复刻 magpie（含多账号池 + 借道 Claude/GPT 模型 + cloak） | 全量移植 | 功能对齐 magpie | 池化=执法加速面（#1649 封号先例）；Claude 系=身份识别重灾区（#666）；混淆入核心违背红线（#2139） | 否决；池化留作 D 切片另议且默认关闭 |

---

## 7. 测试与验收标准（v1）

1. 单测全绿（core + UI），新增用例 mutation-verified（破坏信封/剥壳/分类逻辑 → 测试必须失败）。
2. 数据面闭环（切片 A 手工验收）：真实账号流式回复 + 非流式聚合正确。
3. OAuth 闭环：浏览器授权 → 本地回调收 code → project 自动发现 → 模型列表同步进 config；凭证仅存 0600 文件，`/api/config`、日志、错误信息中无 token（WorkBuddy 同款红线）。
4. 错误分类验收：mock 伪装 429 / VALIDATION_REQUIRED / 真 429 / 过期 refresh token 四类，分类与文案正确，token 不泄。
5. 保护锁验收：通用 config 保存无法改掉受管 provider 的 URL/key/managed 标记。
6. UI 验收：添加账号可见风险文案并需确认；断开/禁用后 provider 从列表与 Router 消失。

---

## 8. 盲区与待拍板点

**盲区（如实告知）**：
- `antigravity.google/terms` 本次调研网络不可达，其 ToS 措辞沿用 2026-10-14 直读版本，未二次复核；但 Gemini CLI ToS 页与两份官方公告为本次一手直读，结论不受影响。
- Code Assist 怪癖集是移动目标（Google 可随时改），magpie 也是 issue 驱动跟进；本设计列出的是当前快照，实施时以真实验证为准。
- UA 版本探测（antigravity updater manifest）涉及伪装 `electron-builder` UA 的外部请求，是否移植待定（v1 可硬编码版本号 + 手动更新）。

**待拍板**：
1. **是否接受「实验性、风险自担」定位与 §4 的红线（不做混淆、v1 不做池化）？** —— 这是产品立场问题，不只是工程问题（magpie #2139 同题）。
2. **风险文案的措辞强度**：直接采用 magpie `AntigravityRisk` 级别（"Use one you can afford to lose"）还是更缓和？
3. **v1 是否包含「导入既有 refresh_token」入口**（magpie google_import.go 同款，仅 antigravity）？有真实 token 的用户可跳过 OAuth；代价是多一条验证与错误分支。
4. **gemini-cli kind 是否 v1 就做**？仅 Standard/Enterprise 账号可用（`事实`），个人用户无效，建议推迟到 D 切片。
5. **实施排期**：切片 A→B→C 是否按 WorkBuddy 模式（多子代理并行 + 里程碑检查点）执行？

---

## 附：与 2026-10-14 生态调研的结论差异说明

前序文档判定「投入产出比偏低，优先级应低于正式 API」；本次在用户明确选择订阅路线的前提下完成落地设计。两者不矛盾：本设计的 §4 红线与「实验档」定位正是对该判断的吸收——**做，但收窄到风险最低的形态，并把执法信号（伪装 429 / VALIDATION_REQUIRED / 封禁梯度）当作一等公民处理**。
