# 火山方舟 Coding Plan（火山agent plan）用量查询 调研与设计

> 真实意图：CCR 桌面额度面板中「火山agent plan」显示"未提供可用额度数据（来源未声明查询能力）"，查明该订阅用量能否查询（官方 API 或其他途径），并给出可落地的接入方案。
> 日期：2026-11-17 · 状态：待评审

## 1. 现状与接入点

### 1.1 provider 事实（读自本机配置，密钥不入库）

| 项 | 值 |
|---|---|
| 名称 | 火山agent plan（**名称有误导，实为 Coding Plan 个人版**） |
| baseUrl | `https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions` |
| 模型 | `ark-code-latest` |
| 鉴权 | 推理 API key（数据面 Bearer），无 `quotaToken` |
| 性质 | 方舟 Coding Plan 订阅（`/api/coding/`），区别于按量付费 `/api/v3` 与 Agent Plan `/api/plan` |

官方命名原文（docs/82379/1925114、2373738）：Coding Plan=`/api/coding/v3`（Lite/Pro，5h/周/月限额）；Agent Plan=`/api/plan`（Small/Medium/Large/Max，AFP 积分制），**两者 Base URL、API Key、额度互不通用**。

### 1.2 数据流（改动前）

```
桌面额度页 → quota_snapshot IPC → GET /api/providers/quota
  → getQuotaAdapter(baseUrl)   [quota-adapters.ts:1014]
      hostname=ark.cn-beijing.volces.com → 无分支 → null
  → 无 quota 条目 → 桌面 status=unsupported → "未提供可用额度数据"  [quota.rs:317]
```

### 1.3 项目内同类实现

- `KimiCodingPlanQuotaAdapter`（quota-adapters.ts:831）：API-key Bearer 直查 usages——**火山没有等价物**（见 §2）。
- `AliyunCodingPlanQuotaAdapter`：console cookie（`quotaSecToken`）查控制台——火山 console cookie 途径存在但建议排除（§2.3）。
- `BaseQuotaAdapter.fetchJson`：统一 Bearer/timeout/`Accept-Encoding: identity`（ProxyAgent 不 gunzip 坑）。
- 插件 `fetchQuota` seam（plugin-quota.ts）：订阅型插件通道，可作为 arkcli 方案的挂载点。

### 1.4 已知约束与坑（项目内）

- ProxyAgent 不自动 gunzip → `Accept-Encoding: identity`。
- 缺失额度不显示为 0；失败保留 stale 数据（桌面已实现）。
- 桌面 owned 模式子进程 PATH 收窄（Finder 启动无 Homebrew）→ 依赖外部 CLI 的方案必须解析绝对路径。
- 凭据红线：AK/SK/cookie 只能用户自填配置，不入库、不投影到桌面 DTO。

## 2. 外部调研

### 2.1 官方接口（文档 + 官方 CLI 源码，均一手抓取）

1. **数据面（推理 key）没有任何用量端点**：`/api/coding/v3` 文档只定义推理协议；不存在 Kimi 式 `GET /coding/v1/usages`。（docs/82379/1298459、1928261）
2. **管控面 OpenAPI**（`POST https://ark.cn-beijing.volcengineapi.com/?Action=…&Version=2024-01-01`，Service=ark Region=cn-beijing，**仅 Access Key 鉴权**）：
   - `GetAFPUsage`/`GetUsageDetails`：**仅适用于 Agent Plan**（AFP 绝对值 5h/日/周/月）。docs/82379/2479847、2479849。
   - `GetPersonalPlan`：查个人版套餐档位/状态/起止（`Plan=CodingPlan` → Lite/Pro）。docs/82379/2546382。
   - **`GetCodingPlanUsage`（Coding Plan 个人版用量，官方 ark-cli 源码明确调用）：`POST https://open.volcengineapi.com/?Action=GetCodingPlanUsage&Version=2024-01-01`**。⚠️ 未列入公开 OpenAPI 目录（站内搜索 0 命中，文档 URL 重定向回 overview），属"官方工具在用、文档未收录"的半公开接口。
   - 费用中心资源包/余额 API（`ListResourcePackages`/`QueryBalanceAcct`）**不覆盖**订阅套餐（FAQ 原文：套餐"不会消耗其他资源包或账户余额"）。
3. **官方 ark-cli**（github.com/volcengine/ark-cli）：`arkcli usage plan --product coding-plan --format json` → 底层即 `GetCodingPlanUsage`；输出 `periods[]:{label: session|weekly|monthly, percent, reset_at}` + `updated_at`。**鉴权：控制面只走 SSO 派生 STS（0.1.16 起 AK/SK 登录通道暂关），明确不消费数据面 API key。**
4. **响应契约（多项目实测一致，原文见 cc-switch/CodexBar 源码注释）**：
   ```
   Result: { Status: string?, UpdateTimestamp: epoch ms?, QuotaUsage: [
     { Level: "session"|"weekly"|"monthly", Percent: number(已用百分比),
       ResetTimestamp: epoch 秒（-1/0=无活跃窗口） } ] }
   ```
   **只有百分比、账号级粒度**：无绝对次数/token、无按模型/按 key 拆分。已回收套餐只返回 `Status` 不带 `QuotaUsage`。
5. **窗口规则**（FAQ/概览原文）：5h 按首次请求滚动；周限额每周一 00:00 重置；月限额订阅月第 1 日 00:00 重置。

### 2.2 开源实现（GitHub 一手源码）

| 项目 | 途径 | 要点 |
|---|---|---|
| farion1231/cc-switch（`src-tauri/src/services/coding_plan.rs`） | AK/SK 直签 `GetAFPUsage`→回落 `GetCodingPlanUsage` | ⚠️ 其顺序探测是 bug（#6070：双订阅用户永远只查到 Agent Plan）——**必须按 base_url 路由** |
| steipete/CodexBar（`DoubaoUsageFetcher.swift`） | 同上 + arkcli + 探针三路 | 精确 Decodable 契约；"回收套餐缺 QuotaUsage 不是错误" |
| Javis603/ccr-volcengine-coding-plan-usage（CCR 社区插件，issue musistudio/claude-code-router#1828） | spawn `arkcli usage plan`，`remaining=100-percent` | 已在 CCR 3.1.1 实测；**网关 PATH 收窄导致 shebang CLI exit 127 的坑** |
| wink-run/tokenbank、edison7009/EchoBird、Javis603/token-monitor | 同一结论 | 原文："推理 Key 无配额头，请填写 AccessKey"；"GetAFPUsage is OpenAPI-only" |

**火山签名 V4 变体坑（照搬标准 AWS SigV4 会失败，magpie#1427/cc-switch 原文）**：
canonical headers 与 SignedHeaders 用固定顺序（如 `host;x-date;x-content-sha256;content-type`，不按字母序；顺序自洽即可）；algorithm 串是 `HMAC-SHA256`（无 `AWS4` 前缀）；credential scope = `<date>/cn-beijing/ark/request`（date/region/service/request 顺序，结尾 `request` 而非 aws4_request）；kDate=HMAC(SK, date)（SK 不加前缀）。

**错误信封坑**：业务错误常为 **HTTP 200 + `ResponseMetadata.Error`**；鉴权错误常是 400 而非 401/403——必须解析信封 Code，不能只看状态码。

### 2.3 反面证据与坑

- **推理 API key 查不了订阅用量**（多方实测）：cc-switch 注释"复用推理 Bearer Key 被网关以 `400 InvalidAuthorization` 拒绝（格式层拒绝）"；oh-my-pi#16081："`ark-` API keys are data-plane only… control-plane OpenAPI rejects them too"；ark-cli auth-modes："控制面…不消费数据面 `--api-key`"。
- **数据形态限制**（oh-my-pi#16081 原文）："absolute used/quota numbers (percentage only), per-model breakdown, and token counts" 均不可得；配额账号级，无法按 key 拆分（magpie#1427）。
- **`GetCodingPlanUsage` 无公开文档承诺** → 存在变更风险（ai-quota-dashboard#1 的社区合规立场即因此把它标为 no public API；该立场相对 arkcli 证据偏保守）。
- **console cookie 逆向存在**（CNife/opencli-adapters#3：`POST console.volcengine.com/api/top/ark/cn-beijing/2024-01-01/GetCodingPlanUsage` + cookie + `X-CSRF-Token`），但：CCR 是 headless Node 无浏览器登录态；接口未公开随时可变；属会话风控灰区。
- **ToS 警告原文**（coding-plan-personal-plan-overview）："在非 AI 编程工具中使用方舟 Coding Plan…可能被识别为滥用/违规，会导致订阅停用或账号封禁"——约束的是**数据面推理 key 使用场景**，未发现针对控制面查用量的禁令或封号案例。

### 2.4 适配判断（外部做法 → 本项目接入点）

| 外部做法 | 本项目接入点 | 判断 |
|---|---|---|
| AK/SK 直签 `GetCodingPlanUsage` | `quota-adapters.ts` 新 adapter + 签名器；配置新增 AK/SK 字段 | **主方案**：进程内 HTTP、无外部依赖 |
| arkcli shell-out（SSO） | 插件 `fetchQuota` seam 或 adapter 子进程模式 | 备选：零凭据存储，但依赖 CLI 安装+SSO 登录+绝对路径 |
| console cookie + CSRF | 无 | **排除**（灰区、脆弱、CCR 无登录态） |
| x-ratelimit 头探针 | 无 | 排除（多数 Coding Plan key 无此头，只能验 key） |

## 3. 方案对比与推荐

**方案 A（推荐）：AK/SK V4 直签 adapter**
- 改动面：`quota-adapters.ts`（+签名器 ~120 行）、config schema（+2 可选字段）、测试；桌面/前端仅当百分比单位渲染需要时 +1 行读取逻辑。
- 风险：签名变体实现错误（有 4 个项目的字段级参考）；半公开接口变更风险。
- 侵入度：低（纯增量，无 core 链路变更）。

**方案 B：arkcli 子进程（SSO）**
- 改动面：adapter 子进程模式 + 绝对路径解析/配置项；或做成独立插件走 `fetchQuota`。
- 风险：用户需安装 ark-cli 并完成一次 SSO 登录；桌面 PATH 收窄坑；CLI 输出格式漂移（updated_at 单位已有 ms/s 漂移前科）。
- 侵入度：低-中。

**为什么不做更简单的替代**：仿 Kimi 用推理 key 直查——已被 3+ 项目实测证伪（400 InvalidAuthorization）；console cookie——技术上可行但合规与稳定性差，不作默认。

**推荐**：A 为主；B 作为可选凭证源后续加（同一 adapter 输出形状，凭证形态可插拔）。用户若不愿创建 AK/SK，可先用官方 arkcli 手动查看（现状不动）。

## 4. 详细设计（方案 A）

### 4.1 数据流（改动后）

```
quota 轮询 → VolcengineCodingPlanQuotaAdapter(baseUrl=…/api/coding/v3/…)
  → V4 变体签名 POST open.volcengineapi.com?Action=GetCodingPlanUsage
  → QuotaUsage[]: session/weekly/monthly Percent
  → ProviderQuotaResult{ limitDaily:100, usedDailyBalance:percent(session),
      usedBalance:percent(weekly), totalBalance:100, unit:'%',
      resetTime/resetTime7d（秒→ISO；-1/0 丢弃该窗口） }
  → admin-routes 现有 5h/7d 映射 + unit 投影 → 桌面卡片「已用 X% · 重置 …」
```

- 三个窗口的呈现：session→5h 槽（label 沿用"配额/5小时"），weekly→7d 槽；monthly 无槽位，暂不展示（盲区 §5）。数值语义=百分比：`limit=100、used=Percent、unit='%'`，是真实口径而非伪造额度。
- `monthly` 与绝对值：官方不提供，**不发明**。

### 4.2 文件级改动清单

| 文件 | 改动 |
|---|---|
| `packages/core/src/services/quota-adapters.ts` | 新增 `volcengineSigV4Sign()`（变体签名）+ `VolcengineCodingPlanQuotaAdapter` + hostname 分支（**仅** `hostname === "ark.cn-beijing.volces.com" 且 path 含 "/api/coding/"`；`/api/v3` 按量与 `/api/plan` Agent Plan 不匹配） |
| `packages/core/src/types/llm.ts`（或 provider 配置类型） | 可选字段 `quotaAccessKey?` / `quotaSecretKey?` |
| `packages/core/src/ccr/admin-routes.ts` | `ProviderQuotaResult.unit` 透传到 quota 条目（`unit5h`/`unit7d`），沿用 `type` 门控 |
| `apps/desktop/src-tauri/src/quota.rs` | `aggregate_windows` 单位读取：`unit{slot}` 优先于 `currency`（+1 处小改 + 测试） |
| `packages/core/src/__tests__/volcengine-quota.test.ts` | 新增 |

### 4.3 关键实现细则（来自调研的坑清单）

1. 签名：固定 header 顺序 `host;x-date;x-content-sha256;content-type`；`HMAC-SHA256` 无 AWS4 前缀；scope `.../ark/cn-beijing/request`；kDate=HMAC(SK,date)。单测用固定 AK/SK vector 断言各派生值。
2. 错误处理：先解析 `ResponseMetadata.Error`（200 也可能错）；鉴权失败归 `unavailable`，不误报 reauth。
3. `ResetTimestamp<=0` → 该窗口无活跃限额，跳过（不显示 0）。
4. `QuotaUsage` 缺失（已回收/未订阅）→ 返回 null，走现有"无数据"路径。
5. `Percent` 语义=已用，直接映射 `used`；`remaining` 不填（桌面已有 limit-only 展示路径）。
6. 凭据：从 provider 配置读 `quotaAccessKey/quotaSecretKey`；缺凭据 → adapter 返回 null（与阿里云 adapter 的 `quotaSecToken` 行为一致），面板仍显示"未声明查询能力"并提示可配置。
7. PATH：纯 HTTP 无子进程，桌面/CLI 天然一致。

### 4.4 分阶段实施

1. **切片 1（最小可验证）**：签名器 + adapter + 单测（mock fetch），`pnpm test` 绿。
2. **切片 2**：真实凭据验证——用户提供 AK/SK 后，对 `GetCodingPlanUsage` 做一次授权实测（隔离脚本，不落盘密钥），核对响应 schema 与文档假设。
3. **切片 3**：unit 透传 + 桌面 `%` 渲染 + 端到端验证 + PR（stacked，OPEN）。

### 4.5 测试策略

- 单测：签名向量、窗口映射（session/weekly/monthly）、`-1/0` reset 丢弃、`QuotaUsage` 缺失、200+Error 信封、非 coding 路径不匹配（`/api/v3`、`/api/plan`）。
- 集成：隔离 HOME/端口起 mock OpenTOP，验证 admin `/api/providers/quota` 全链路。
- 桌面：现有 aggregate 测试加 unit 断言；真实数据只读确认。

### 4.6 风险与回滚

- 接口无文档承诺 → 若上游变更，adapter 失败自然退回"无数据"展示，无破坏性。
- 回滚：移除 hostname 分支即完全回退；配置字段向后兼容（可选字段）。

## 5. 盲区与待拍板

- **未实测项**：AK/SK 直调 `GetCodingPlanUsage` 是否放行（调研红线禁止带凭证调用）——切片 2 需一次授权实测。
- **数据形态**：只有百分比+账号级粒度，无绝对次数/按 key 拆分——桌面只能显示"已用 X%"，如需绝对值只有 Agent Plan（`GetAFPUsage`）才有。
- **monthly 窗口**：现 UI 只有 5h/7d 两个槽，monthly 暂无展示位（可后续加第三窗口）。
- **产品命名**：建议把 provider 显示名改为「火山 Coding Plan」，避免与真正的 Agent Plan 混淆。
- **需用户拍板**：① 是否愿意创建账号 AK/SK（控制台 Access Key 管理）并填入 provider 配置；② 若不愿意，是否接受装 ark-cli + SSO 的方案 B；③ monthly 窗口是否需要展示位。
