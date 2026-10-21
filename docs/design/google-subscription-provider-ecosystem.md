# 「官方订阅 OAuth 直连 Google」类插件生态调研

> **真实意图**：用户看到若干插件（pi-antigravity 等）宣称「走官方订阅 + 某种逻辑，Google 不封号，和普通代理不一样」，想弄清：① 这类插件到底有几个；② 它们走的是什么逻辑；③ 「不封号」的说法可信度如何。
> **日期**：2026-10-14　**状态**：已完成（三路调研：生态扫描 / 封号证据 / 上游官方面）
> **方法**：gh api 直读各仓库源码与 issue 原文 + playwright 直读 Google ToS 原文；引用均为一手原文。标注约定：`事实`=有原文出处；`推断`=本文作者判断。

---

## 0. 结论速览

1. **同类插件数量**：直连 OAuth 复刻路线（用 Google 官方桌面客户端的公开凭据 + 官方端点 + 用户自己的 Google 账号订阅配额）的活跃项目 **约 20 个**，横跨 pi / OpenCode / Zed-ACP / 独立 HTTP 代理四个形态；另有约 5 个走「官方进程桥」（ACP / 官方 CLI 驱动）的合规替代路线。详见 §2 矩阵。
2. **它们宣称的「逻辑」**：共用 Google 官方 CLI 的 installed-app 型公开 OAuth client（secret 本来就设计为可公开）→ 请求数据面与官方 CLI 同源；端点、UA、版本号、projectId 全套复刻官方 CLI 指纹；配额由服务端按账号订阅池管理（超额返回 429 而非封号）。
3. **「不封号」按字面是错的**（`事实`，见 §4）：2026-02-18 前后出现过大规模服务级封禁波，付费 Pro/Ultra 用户一样中招；pi、CLIProxyAPI 等多个项目的维护者因此下架了相关 provider。CLIProxyAPI 作者原话："Using these two products in other clients will inevitably violate the TOS, and a ban is certain."
4. **但「和普通代理不一样」有一个真实内核**（`事实`+`推断`，见 §5）：这条路线的执法几乎全部止步于 **AI 服务层**（403 VALIDATION_REQUIRED → 验证恢复，或 TOS_VIOLATION 服务禁用 → 申诉后 1–3 天自动解封），**一手报告里没有任何「Gmail 级整号封停」案例**；普通代理生态里真正危险的形态是**转售/共享号池与 API-key 农场**（8 小时封号、12 项目连坐的一手案例都出自那里）。

---

## 1. 这条路线的共同机制（「什么逻辑」）

所有「直连复刻」项目共享同一套机制，差异只在工程细节：

| 机制要素 | 内容 | 来源（事实） |
|---|---|---|
| **OAuth client** | 全行业共用 Google **官方 Antigravity 桌面客户端**的公开凭据：`1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com` + `GOCSPX-K58FWR486…`；Gemini CLI 路线则用官方 gemini-cli 的 `681255809395-oo8ft2…` + `GOCSPX-4uHgMPm-…`（源码注释明言 installed app 的 secret "obviously not treated as a secret"） | NoeFabris `src/constants.ts`、pi-antigravity `src/auth/oauth.ts`、google-gemini/gemini-cli `packages/core/src/code_assist/oauth2.ts:76-85`、CLIProxyAPI `internal/auth/antigravity/constants.go`、gcli2api `src/utils.py` |
| **授权流** | Authorization Code + PKCE，loopback 回调（`:51121/oauth-callback` 最常见），scopes：`aicode`/`cloud-platform`/`userinfo.*`/`cclog`/`experimentsandconfigs` | 同上 |
| **端点** | `daily-cloudcode-pa.googleapis.com`（及 sandbox/autopush 变体）→ `cloudcode-pa.googleapis.com` 多域回退；`/v1internal:listCloudAICompanionProjects`、`fetchAvailableModels`、`streamGenerateContent` | pi-antigravity、mastnacek/pi-google-cca、NoeFabris |
| **指纹策略** | UA 复刻官方 CLI（如 `antigravity/cli/1.2.4 (… auth_method=consumer)`）；版本号是**军备竞赛核心**——CLIProxyAPI 实证 Google 按 UA 语义版本**门控模型**（旧版 1.x 拿不到 `*-flash-high`，404），头部项目已改为动态探测版本或强制 ≥2.x persona；projectId 兜底策略有 email-hash、硬编码 `rising-fact-p41fc`、随机 ID + 自动 onboard 三种 | pi-antigravity `client.ts`、CLIProxyAPI issue #6185、NoeFabris README |
| **配额模型** | 账号订阅制共享池：Antigravity 池（Gemini+Claude+GPT-OSS）与 Gemini CLI 池（仅 Gemini）双池，5h + weekly 窗口，超额 429；**Gemini CLI 个人 OAuth 池已被 Google 官宣 2026-06-18 关停**（个人/AI Pro/Ultra 均失效，仅剩企业版），双池架构已成过渡形态 | NoeFabris README "Dual quota system"、jenslys/opencode-gemini-auth README 引 Google 弃用公告 |
| **宣称的安全逻辑** | "请求来自官方 client ID + 官方端点 + 你自己的订阅配额，服务端用 429 管理而不是封号"——这是各 README 的隐含主张；同时几乎所有 README 又都附带封禁警告（自相矛盾，见 §4） | 各项目 README |

---

## 2. 项目清单与对比矩阵

### 2.1 直连 OAuth 复刻路线（≈20 个）

| 项目 | 形态 | 星标/活跃度 | 指纹/工程亮点 | 封禁相关证据 |
|---|---|---|---|---|
| **NoeFabris/opencode-antigravity-auth** | OpenCode 插件 | 10.9k★，2026-08 活跃 | 双配额池+多账号轮换+动态版本探测（fallback 1.18.3） | issue #335 VALIDATION_REQUIRED 验证后仍不恢复；#426 40+ 评论封禁报告（含 Ultra/老号）；#178 用户报告新号 OAuth 即收警告邮件 |
| **router-for-me/CLIProxyAPI** | Go 独立多协议代理 | 55k★，日更级（v8.0.28） | UA 版本门控实证、validation_url 透传、强制 ≥2.x persona | #1631/#1637 封禁波（4 pro 号 3 被封）；#1803 永久封禁截图（TOS_VIOLATION×4）；#266 团队共享 8h 封号；作者承认 "a ban is certain" |
| **su-kaka/gcli2api** | Python FastAPI+面板 | 5.2k★，活跃 | 双渠道（Antigravity+GeminiCLI）两套官方凭据按渠道选择 | #328 TOS_VIOLATION；#358 "填表等复活（2-3 天）"；PR #414 记录 2026-09-09 指纹封禁波 |
| **liuw1535/antigravity2api-nodejs** | Node+预编译二进制 | 815★，2026-06 后停 | 凭据字符串碎片拼接"避免扫描"；随机 projectId | 唯一无封禁警告的样本（已停更） |
| **badrisnarayanan/antigravity-claude-proxy** | npm/npx，Anthropic 兼容 | 4.0k★，活跃 | 直接读 Antigravity 本地数据库取 token | 首页 WARNING：建议 burner 账号 |
| **pi-antigravity**（Rahularya01） | pi provider | 本机已装 | 固定 UA 1.2.4（已显过时）、email-hash projectId | #73 VALIDATION_REQUIRED |
| **cortexkit/antigravity-auth** | monorepo（OpenCode V1/V2+Pi+CLI） | 2026-10-14 活跃 | 指纹/账号池/配额管理抽成 harness 无关 core | 同样明文封禁警告 |
| **mastnacek/pi-google-cca** | pi provider | 2026-09 活跃 | onboardUser 自动开通、双域回退、`skip_thought_signature_validator` 哨兵、proto schema 归一化 | — |
| jenslys/opencode-gemini-auth | OpenCode 插件 | 半废 | Gemini CLI 池路线 | 官宣弃用公告收录者 |
| qraxiss/pi-gemini-auth | pi provider | — | 还原 pi 上游删除的 CCA provider | Pi 上游曾内置后删除 |
| windowsrefundday/pi-antigravity-auth | pi provider | 2026-05 停 | NoeFabris 的 Pi 移植 | 预告 Gemini CLI 池停供 |
| qwen-code（QwenLM） | 独立 CLI（gemini-cli fork） | 28.5k★ | RFC 8628 device flow（同模式、不同厂商） | **Qwen 免费档 2026-04-15 被厂商关停**——免费 OAuth 档可被一键关停的先例 |
| JoshRob297/frieser/vibheksoni/rasyidrafi 各 fork | OpenCode 生态 | 不等 | 配额监控、headless 轮换、ACP 适配 | — |
| Heelc/vforvaick/nihar5hah 等 | pi 生态小包 | — | — | — |

### 2.2 官方进程桥路线（合规替代，≈5 个）

| 项目 | 形态 | 机制 | 代价 |
|---|---|---|---|
| **zacbemis/pi-antigravity-acp-provider** | pi provider | 下载并校验**官方 agy_acp_server**（Ed25519 签名 catalog，约 1.8GB）；OAuth token 归官方二进制所有，pi 只存非密标记 | 运行时巨大；agent 会话粒度而非裸 API |
| **rynfar/meridian** | 本地 API 桥+面板 | 请求经官方 `agy` CLI 发出；验证组合 agy 1.2.7 / Pi 0.72.1 | 同上 |
| qazmaster/gemini-pipe-provider | OpenAI 兼容桥 | spawn `gemini --acp` 官方进程 | 单进程会话模型，并发受限 |
| shubzkothekar/antigravity-acp、simonepri/refined-antigravity-acp | agy ACP 包装 | 同上 | — |
| google-gemini/gemini-cli 内置 `--experimental-acp` | 官方 ACP server | Zed 等编辑器标准插槽 | experimental 期有 stdio bug（patch 仓有记录） |

**ACP 澄清**（回答用户上一问的遗留）：ACP（Agent Client Protocol）是**本地编辑器 ↔ 本地 agent 子进程**的 stdio JSON-RPC 协议，Google 完全看不见。ACP 路线「不容易被封」的真正原因不是 ACP 本身，而是**请求由 Google 签名的官方二进制发出**——凭证、UA、版本、指纹全部真实。

### 2.3 「普通代理」对照面

| 形态 | 代表 | 执法记录（一手） |
|---|---|---|
| Web-cookie 反代 | HanaokaYuzu/GeminiAPI | 频控型临时封禁为主："Sending requests too frequently will have your ip/account temporarily banned"（#268 维护者）；整库突发失效数小时（#261）；无 L4 一手案例 |
| AI Studio 网页反代 | AIstudioProxyAPI | 网页自动化本身样本内无封号一手报告；**API-key 农场**被硬封："banned from 12 projects and the account itself"（#221，GCP Policy Violation 邮件截图） |
| 共享/转售号池 | CLIProxyAPI #266 | "installed on a VPS and shared the API key with my team…After about 8 hours…my account was banned"——样本中唯一快速+疑似不可申诉处置 |

---

## 3. 「不封号」说法的证据判定

### 3.1 执法分级（一手报告归纳）

| 层级 | 特征 | 可恢复性 | OAuth 直连路线出现频率 |
|---|---|---|---|
| L1 验证挑战 | 403 `VALIDATION_REQUIRED` + validation_url | 验证即恢复，**不是 ban** | 高（但 opencode-antigravity-auth #335 有验证后仍不恢复的案例） |
| L2 AI 服务禁用 | 403 `TOS_VIOLATION` "disabled in this account for violation of ToS" + appeal_url | 申诉/表单后 **1–3 天自动解封**；二次违规永久 | **封禁波的主体形态** |
| L3 GCP 项目/API 限制 | "Policy Violation…restricted your use of the corresponding APIs" | 需项目主申诉 | 主要出现在 API-key 农场（AIstudioProxyAPI #221） |
| L4 整 Google 账号封停 | Gmail 级 | — | **一手报告中几乎不存在**（nollium："The google account itself remains functional, only Antigravity is disabled"；gcli2api #324 同） |

### 3.2 关键一手证据（全部 gh api / playwright 直读）

- **官方 ToS 原文**（antigravity.google/terms）："Using third party software, tools, or services to access the Service (e.g. using OpenClaw with Antigravity OAuth) is a breach of this Agreement. Such actions may be grounds for **suspension or termination of your Antigravity and/or Gemini CLI accounts**."——注意措辞范围是 AI 产品面，未提整个 Google 账号。
- **官方公告 #20632**（2026-02-27，Google 员工）："a series of Antigravity bans…specifically the use of 3rd party tools or proxies…bans for Antigravity usage also blocked access to Gemini CLI and Gemini Code Assist"；处置流程：邮件 + 表单 recertification → "Automatic unban…within a day or two" → **二次违规永久禁用**。
- **官方公告 #22970**（2026-03-18）："We're implementing more robust detection for policy-violating use cases (e.g. using Gemini CLI oAuth with third-party software)."
- **封禁波**：2026-02-18 前后（opencode-antigravity-auth #426、CLIProxyAPI #1631/#1637、gcli2api #328 同期大量报告，含 Pro/Ultra 付费用户）；2026-09-09 指纹封禁波（gcli2api PR #414）。
- **pi 上游的回应**：#2361、#4017 用户报告封号后，**pi 维护者直接从 main 下架了 antigravity 和 gemini-cli 两个 provider**。
- **触发因素相关性**（证据强度排序，`推断`基于样本）：① 非官方客户端指纹/UA（Google 官方点名 + 指纹封禁波实证）；② 多账号轮换/同机多号（4 号同机 3 被封、5/12 需验证）；③ 异常用量（"agent teams…consumed a lot of tokens" 一周后被封）；④ 共享/转售（8h 封号）；⑤ 新账号（README 宣称高风险，但老号/验证号实测照样中招——新号只是更容易被频控）。

### 3.3 判定

> **「官方订阅 OAuth 直连 = 不封号，普通代理 = 封号」按字面是错的。** 真实图景：
> 1. 这条路线**已被反复、大规模地服务级封禁过**（L2 为主），付费订阅不提供豁免，官方明文将其列为打击对象，且 pi 上游已因此下架 provider。
> 2. 它与普通代理的真实差别是**执法深度与可恢复性**：OAuth 直连几乎都是 L1/L2（验证/服务禁用，可申诉，1–3 天恢复，Gmail 不受影响，无 L4 一手案例）；web-cookie 反代主要是临时频控；真正出现 L3/L4 重处置的是**API-key 农场与共享/转售号池**——那才是"普通代理"里真正危险的子集。
> 3. `推断`：各项目 README 一边复刻官方指纹一边附封禁警告的自相矛盾，说明社区普遍知道这是「举报式执法下的灰色共存」——Google 用指纹波 + 配额 + 申诉通道做成本管理，而非一刀切。**任何时候都不应向用户承诺"不会被封"。**

---

## 4. 对 CCR 的适配判断（若未来做同类 provider）

1. **机制无壁垒，不建议从零重造**：provider 机制（公开 client ID + PKCE + 双配额池 + 多账号）已是行业公共知识。可参照的工程结晶：CLIProxyAPI（UA 版本门控、validation_url 透传）、NoeFabris（双池轮换、OpenCode 插件结构）、mastnacek/pi-google-cca（onboardUser、schema 归一化、`skip_thought_signature_validator`）。落到本项目即：新增一个 provider + transformer（`packages/core/src/transformers/` 模式，参照已合并的 AMD transformer PR #66 的结构与测试方式）。
2. **必须实现的三条防护**（证据驱动）：① 动态 UA/版本指纹（固定版本号会被模型门控 404 与指纹波淘汰）；② `VALIDATION_REQUIRED` 识别为**账号级熔断 + 向用户透传 validation_url**，而非可重试错误；③ 429/配额池语义与 Anthropic 式 5xx 重试分开处理。
3. **产品定位建议**：即便实现，也应作为「实验性、风险自担」档位并提供官方 agy/ACP 桥作为高安全替代；文档必须如实写明 §3.3 的执法图景与 ToS 原文，不承诺"不封号"。**多账号轮换是执法加速器，不建议内建。**
4. **时机判断**（`推断`）：Gemini CLI 个人池已死、Antigravity 池处于官方明文打击 + 指纹军备竞赛期，投入产出比偏低；除非用户强需求，优先级应低于正式 API/企业渠道 provider。

---

## 5. 盲区与未覆盖

- Reddit/linux.do 等社区的一手封号帖未系统取证（搜索通道受限，仅有 GitHub 一手材料）；样本偏向 GitHub 活跃用户，沉默用户（未被封的多数）不可见，封禁**基率**无法量化。
- Google 内部检测逻辑（哪些信号触发、阈值）纯靠外部归因，`推断`成分高。
- 未验证各项目最新版本的具体行为差异（以各自 repo 为准）；本地安装的 pi-antigravity npm 包 src 不完整（缺子模块），若要复现实验需从 git 源安装。
- Vertex AI Express 模式的具体限额未逐项核实（quota 表见 gemini-cli `docs/resources/quota-and-pricing.md`，Express 行标注 "Varies"）。
