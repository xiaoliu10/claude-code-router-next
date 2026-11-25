# agy ACP 社区实现调研与设计

> 真实意图：对照社区（paseo / t3 / pi / opencode / Zed 等）的 agy（Antigravity CLI）ACP 接入实现，解决「真实 agy 在个人 OAuth（oauth-personal）下不向模型暴露调用方 MCP 工具」的问题，并借鉴代理/认证/工具桥接的成熟做法。
> 日期：2026-11-24 ｜ 状态：已落地（Phase 1 完成，插件 0.2.2；文末第 5 节为实现终态，与第 3 节草案推荐路线有偏离，以第 5 节为准）

## 0. 问题定义

- **真实意图**：不是「加功能」，而是「我们的 agy ACP 工具调用在真实 agy + 个人 OAuth 下不生效，别人是怎么让它生效的」。背后动机：190 桌面网关上对话已通，但调用方工具（MCP 桥接）不被模型看到。
- **本项目约束**：CCR provider 插件 `packages/plugins/gemini-agy-acp`（0.2.0）；ACP over stdio 驱动 `agy` 二进制；调用方工具经进程内 HTTP MCP 桥接（`agy-tool-bridge.mjs`）通过 `session/new.mcpServers`（type:http，loopback）交给 agy；认证 `oauth-personal`；桌面网关无代理 env，需注入 + NO_PROXY 环回排除。
- **好产出标准**：另一个 agent 能据此判断「工具不暴露是 agy 硬门控还是我们接法不对」，并给出落到具体文件的修复或绕过方向。

## 1. 现状与接入点（内部事实）

数据流（改动前）：
```
caller tools → declaredTools → AgyToolBridge(tools,onCall).start()
  → bridge.descriptor() {type:'http',url:'http://127.0.0.1:<port>/mcp',headers:[Authorization]}
  → transport.turn → session/new {mcpServers:[descriptor]}
  → agy 预加载 MCP（日志 "Preloading 1 MCP servers"）并 TCP 连接桥接
  → 但模型工具集只有 agy 原生工具（run_command），不含 ccr_calculator
  → stop=end_turn，无 tools/call，无 parked
```

关键文件：
- `src/transport.mjs`：`turn()` 构造 `mcpServers = hasTools ? [bridge.descriptor()] : []`；`oauthEnvironment`/`isolatedEnvironment` 注入代理 + NO_PROXY；worker 池 fingerprint 含 proxyUrl；`retireIdle`/`hasParked` 保护 parked 工具轮。
- `src/agy-tool-bridge.mjs`：进程内 `createServer` loopback MCP；`descriptor()` type:http；工具名加 `ccr_` 前缀；`pending` Map 记录 parked 调用。
- `src/plugin.mjs`：`dispatchRequest` 工具路径（declaresTools + toolChoiceShapeOk）；`applyTransport` 代理-only 换池在 hasParked 时推迟。
- `src/settings.mjs`：`authMethod` 默认/可选 `oauth-personal`（`OAUTH_METHOD`）。

已取证事实（190 真机）：
- agy 日志：`Not reloading plugin MCP servers: cannot get the signed-in user: You are not logged into Antigravity.`（事实，acp-server log）
- agy `Preloading 1 MCP servers of the session` + 桥接 TCP 连接计数=2（1 次自检 + 1 次 agy）→ agy 连接了桥接（事实）。
- 模型回复只见原生工具，不调用 ccr_calculator（事实）。
- **推断**：agy 把「向模型暴露 MCP 工具」门控在 Antigravity 登录态上；个人 OAuth 不足以解锁。需外部验证。

## 2. 外部调研（task-1/3/4 已回，task-2 paseo/t3 进行中）

### 2.0 重大纠正：之前的「Antigravity 登录门控」假设是错的

- issue **#1733**（google-antigravity/antigravity-cli）实测评论原文：*"Servers passed by the client in `session/new` `mcpServers` are available on prompt 1."*（个人 Google 账号 / keyring / 1.5.14）。`Not reloading plugin MCP servers: … You are not logged into Antigravity` 只影响 **plugin MCP**（`mcp_config.json`）加载路径，是启动期与登录读取的**竞态噪音**（12ms 后 keyring 认证成功），**不影响 session/new 传入的 server**。
- 官方 auth 文档：`oauth-personal`/`oauth-business`/`gemini-api-key`/`agent-platform`/`terminal-login` 并列合法，**无任何「MCP 需 Antigravity IDE 登录」表述**。

### 2.1 真正的根因（190 实测验证）

**官方 ACP 文档 Flags 表原文**：`--process-per-session` — *"Serve each session from an isolated worker process. **Required for HTTP MCP servers that your editor configures.**"*

190 A/B 取证（本项目 `transport.mjs:229` spawn 参数）：
| spawn 参数 | 工具调用结果 |
|---|---|
| `['acp','--sandbox']`（原） | ❌ 模型只见受限工具，不调用 calculator |
| `['acp','--sandbox','--process-per-session']` | ❌ 仍不暴露（模型：tools limited to file ops）|
| `['acp','--stdio','--process-per-session']`（goose 配方，去 sandbox） | ✅ **连续 3 次 `finish=tool_calls`，calculator `{"expr":"2+2"}`** |

**结论（事实）**：`--sandbox` 把 agent 限制在受限工具集，**排除了 session MCP 工具**；HTTP MCP 还需 `--process-per-session`。去掉 sandbox + 加 `--stdio --process-per-session` 后工具调用生效。首次 goose 参数测试失败、后续稳定成功，符合 **#1534**（首 prompt 间歇丢预加载工具）的冷启动竞态特征。

### 2.2 社区成熟配方（逐条 → 本项目接入点）

- **goose fork `aaif-goose/goose` PR #13587（agy-acp provider）**：*"wrapping `agy acp --stdio --process-per-session` (enabling `mcpCapabilities.http` so streamable-HTTP MCP extensions are forwarded rather than dropped)"* + server 名清洗 `^[a-zA-Z0-9_-]{1,64}$`（#1494）+ 用官方二进制原生 auth。→ **本项目 `transport.mjs:229` spawn 参数 + `agy-tool-bridge.mjs` server 名（已是 `ccr-caller-tools`，合规）**。
- **zed-industries/claude-code-acp `src/mcp-servers.ts`**：client http/sse/stdio 原样转 SDK 配置；`type:'acp'` 起 127.0.0.1 HTTP 端点把 MCP 请求转回 client（`McpOverAcpHttpBridge`，bearer 鉴权）——**与本项目 loopback 桥同构**，证明架构成立。
- **`Juliusolsson05/agent-code#1545`**：因 agy 不广告 HTTP MCP 能力，改用 **stdio MCP proxy** 携带内置 server，bearer 放 env 不放 argv；实测工具对模型可见（1.5.15 / personal AI Ultra）。→ 备选架构 B。
- **`get-bb/bb#7998`**：同样的 not-logged-in 日志对，结论 *"Antigravity accepts servers handed over that way"*——client 传入的桥可用，配置文件里的不行。
- **pi 本体**：不支持 ACP/agy（0.71.0 已移除内置 Gemini CLI/Antigravity provider，曾是直连 API 非 ACP）。**opencode**：仅 agent 侧命中，无原生 antigravity ACP client。

### 2.2b paseo / t3code 源码细节（task-2）

**Paseo（getpaseo/paseo，24.9k★）**：
- spawn：`["agy", "acp", "--disable-telemetry"]`——**无 sandbox、无 --process-per-session**，HTTP MCP loopback 仍可行（证明 sandbox 才是我们的主 blocker，--process-per-session 非所有版本必需）。
- 注入自己的 HTTP MCP：`{type:"http", url:".../mcp/agents?callerAgentId=...", headers:{Authorization:Bearer}}`；工具 wire 名 `mcp_<server>_<tool>`。
- auth：完全复用用户已有 agy 登录（keyring/SSH token），不做 ACP authenticate；显式管理 SSH_* env。
- **issue #10573（与本项目同症）**：agy 预载 2 server、tools/list 收 62 工具、模型只见 46，**16 个被 agy 静默丢弃**；同机 Kimi over ACP 全量可见 → 过滤在 agy 内部。

**T3 Code（pingdotgg/t3code，76k★，个人 OAuth + 工具桥接最完整参照）**：
- spawn：`["acp", "--gemini-dir", profile.geminiHome, "--app-data-dir", "antigravity-acp"]`，`extendEnv:false`。
- **auth env trick**：oauth-personal 时伪造 `SSH_CONNECTION="127.0.0.1 0 127.0.0.1 0"` + `AGY_ACP_FORCE_FILE_STORAGE=1` + 隔离 `GEMINI_HOME` 强制文件态 token（绕开 keyring/「not logged in」）；`AGY_CLI_DISABLE_AUTO_UPDATE=1`；BROWSER 一行脚本把 OAuth URL 打 stderr；删除继承的 GEMINI_API_KEY 等。
- eager authenticate：`authMethodId:"oauth-personal"` + `authenticateEagerly:true`（注释：Antigravity 接受它不在 initialize 列出的 method）。
- clientInfo 伪装：旧版 `{name:"zed"}` 解锁非 Gemini 模型，≥1.5.1 用真名。
- **三形态桥**：按 `agentCapabilities.mcpCapabilities` 选 acp > http > stdio；**issue #40284 实测 agy 1.5.x 多数不广告能力，T3 实际走 stdio 桥**；HTTP opt-in per flavor。
- **防丢工具**：issue #38123 agy 按序列化字节截断 eager 工具（1.5.9 ~1280B、1.5.10 ~830B），超限丢且 `call_mcp_tool` 报 not enabled；`tool_search` 延迟暴露（deferred 模式先列 4 工具）；小 schema。

**tiezbro/paseo-agy-acp（71★，官方内核 .par）**：
- `mcp-protocol-bridge.ts` 把 agy 的 MCP initialize protocolVersion 从 `2026-07-28` 降级到 `2025-11-25`（证明 agy HTTP MCP client speaks 2026-07-28）。
- **官方能力档案 C136**：`_meta.antigravity.eagerMcpServers`（会话级名单）或单 server `forceAllToolsEager:true` → 工具**直接进 prompt**，不走 call_mcp_tool + 磁盘 schema；不持久化，load/resume 需重发。
- C42：`_meta.antigravity.enabledTools/disabledTools` 过滤原生工具（→ 可能用于抑制 agy 原生工具、缓解去 sandbox 的安全问题）。

**对本项目新增接入点**：`agy-tool-bridge.mjs` 工具 schema 压缩到 ~800B 内；`transport.mjs` session/new 可试 `_meta.antigravity.eagerMcpServers`/`forceAllToolsEager`；`_meta.antigravity.disabledTools` 抑制原生工具（待验证）；auth env 可仿 T3 SSH_CONNECTION+FORCE_FILE_STORAGE（但本项目用 keyring 已认证成功，非必需）。

### 2.2c pi 社区 ACP 插件源码（task-5，用户指定参考 zacbemis + SenCha）

**核心：高下载量 pi ACP 插件无一用 `--sandbox`/`--stdio`/`--disable-telemetry`。**

| | zacbemis pi-antigravity-acp-provider (110★/3806月) | SenCha omp-antigravity-acp-provider (6785月) | alphastorm omp-antigravity | Rahularya01 pi-antigravity (21436月) |
|---|---|---|---|---|
| spawn | 官方独立 `agy_acp_server.par` 直跑，args `[]`/Linux`["--uid="]`，不碰 agy CLI | CLI `agy acp --app_data_dir=antigravity-acp`；managed 同 zacbemis | `agy acp --process-per-session --gemini-dir <dir> --agent omp-host` | **非 ACP**，直连 cloudcode-pa API |
| 桥接 | loopback HTTP `pi-bridge` bearer stateless | 同左 `omp_` 前缀 | loopback HTTP `omp`（模型见 `mcp_omp_*`）| pi 本地执行无桥 |
| 防丢工具 | schema 投影 Gemini 子集+整工具剔除诊断 | **alwaysLoad + 18000-token 描述二分裁剪永不丢工具 + MAX_TOOLS=64 + eagerMcpServers** | alwaysLoad + excludeDefaultComponents 清空原生腾预算 | N/A |
| 原生工具抑制 | 无（yolo）| **`_meta.antigravity.enabledTools:[]` 禁全部原生（默认 disabled）** | 自有 agent profile excludeDefaultComponents+泄漏守卫 | N/A |
| auth | oauth-personal 文件优先；keychain 失配钉 FORCE_FILE_STORAGE；API key `_meta["api-key"]` | 同左+CLI token mtime 同步+**retryStartupAuthRace(2s/250ms)**+prompt-cloak 绕内容型429 | env allowlist 丢 GEMINI_API_KEY/GOOGLE_* | 自实现 OAuth+UA 伪装 |
| ToS | 仅 yolo 警告 | own risk/quota 泛警告 | 引用官方 ToS | **明确 §6+封号案例#154** |

**最高价值代码（SenCha，逐条对应我们的发现）**：
- 预算拟合：`TOOL_TOKEN_BUDGET=18000`，agy 按 `ceil(UTF-8 bytes/3)` 计每个序列化条目、超预算 largest-first 丢整工具；`fitToolsToBudget()` 超限时对**所有 description**（含 schema 嵌套）二分搜索字节上限统一裁剪（先删 Examples 块、再句子边界截断加…、<24B 删），**永不丢工具/永不动 schema 约束**。
- tools/list 每条 `_meta:{"antigravity/alwaysLoad":true}`。
- session/new `_meta.antigravity.eagerMcpServers:["pi-bridge"]`（解 preload 竞态）+ `enabledTools:[]`（禁全部原生工具，需官方≥1.4.1 且 advertise `agentCapabilities._meta.antigravity.systemPrompt.append===true`，否则拒弱化）；指令走 `systemPrompt.append`。
- `retryStartupAuthRace()`：2s 内出现 `not logged in|authentication required`（排除 invalid_grant/api-key）等 250ms 重试一次，包裹 newSession/loadSession/resumeSession。
- 1.5.3+ 官方不再 advertise mcpCapabilities.http，`normalizeInitializeResponse()` 按版本补 http:true。

**alphastorm 硬证据**：源码注释 *"Client HTTP MCP needs `--process-per-session`"* —— 与 190 实测吻合；`--agent omp-host` 自写 profile excludeDefaultComponents，守卫检测默认 agent 泄漏（*"agy does not fail when the omp-host agent is missing: it runs its default agent, native tools included"*）。

**zacbemis**：纯标准 ACP 字段（无 _meta.antigravity/eager/alwaysLoad），防丢仅 schema 投影+剔除诊断；`mcpCapabilities.http===true` 才建桥；`notifications/progress` 15s keepalive。

**Rahularya01 pi-antigravity（下载最高）确认非 ACP**：直连 API、pi 本地执行工具（无丢工具问题）；README 明确 §6 封号警告（案例 #154）——适用于所有 consumer OAuth 方案。

### 2.3 必须设防的 agy 已知 bug（open，截至调研无修复版）

| issue | 坑 | 本项目防护点 |
|---|---|---|
| #1530 | session MCP 强制 `ForceAllToolsEager` + ~20k token 预算，超预算工具**整条静默丢弃** | 裁剪 caller 工具 schema 总量；`agy-tools.mjs` 规范化时估算 token |
| #1746 | 共享 **10s 硬 preload deadline**，任一 server 超时丢全部 | 桥 initialize/tools/list 必须秒回（本项目进程内桥已满足）|
| #1534 | 首 prompt 间歇丢已 preload 工具 | 首 prompt 探测/重试或暖机 |
| #1603 | `--agent <name>` 丢全部 session mcpServers | 不传 `--agent`（本项目未传）|
| #1604 | initialize 漏广告 `mcpCapabilities.http`（runtime 支持）| 容忍偏差；`--process-per-session` 后 goose 实测会广告 |
| #1494 | server 名含空格/特殊字符 → 400 | 名匹配 `^[a-zA-Z0-9_-]{1,64}$`（已合规）|

### 2.4 ToS 生存性风险（独立于技术问题，必须上报）

- **#1493**（Google collaborator manirajc 正式答复）：*"What is not permitted under consumer sign-in (oauth-personal) is using agy acp as a backend worker inside a third-party coding agent, autonomous agent harness, or background orchestrator."* 单账号/个人使用**无豁免**；合规路径 `GEMINI_API_KEY`（gemini-api-key）或 ADC（agent-platform）。
- **#1701**：consumer OAuth 下 systemPrompt 含第三方 harness 工具名会被**故意** 429 RESOURCE_EXHAUSTED（与配额无关），官方确认 intentional，绕过威胁封号。
- **对本项目**：CCR provider 把 agy 当 router 后端 + oauth-personal，正是被点名形态。产品层应引导用户走 API key/ADC，或明确风险告知。

## 3. 方案对比与推荐

- **方案 A（推荐，已验证）**：spawn 参数改 `['acp','--stdio','--process-per-session']`（去 `--sandbox`）。改动面：`transport.mjs:229` 一行 + 测试。风险：**去掉 sandbox 后 agy 原生工具（run_command 等）对模型可用且会在宿主机执行**——安全姿态变化，需用户拍板；且模型可能混用 agy 原生工具与桥接 caller 工具。190 实测工具调用 3 次稳定成功。
- **方案 B（备选）**：改 **stdio MCP 桥**替代 HTTP 桥（agent-code 配方），绕开 HTTP 能力广告/`--process-per-session` 依赖。改动面：`agy-tool-bridge.mjs` 重写为 stdio 子进程桥 + transport spawn 一个桥进程。侵入度大，但避免 HTTP 相关 bug；仍需处理 sandbox 与预算。
- **方案 C（备选）**：`--ide-mcp-port` NDJSON 桥（omp 配方），绕开 session/new 全部坑，但需 `nc` on PATH、工具名变 `mcp_ide-tools_<name>`。依赖外部工具，不推荐首选。
- **为什么不用更简单的替代**：仅加 `--process-per-session` 保留 sandbox 已实测无效（sandbox 是工具集排除的主因）；故 A 必须去 sandbox，安全取舍不可回避。

**推荐 A+（社区配方增强，安全顾虑有解）**：spawn 改 `['acp','--process-per-session']`（去 sandbox；--stdio 各插件均未用，可 A/B 是否多余）+ **session/new `_meta.antigravity.enabledTools:[]` 禁用全部 agy 原生工具**（SenCha 默认做法，需官方≥1.4.1 + systemPrompt.append 能力）——这正好解决「去 sandbox 后原生工具宿主执行」的安全顾虑：MCP 工具进来、原生工具关掉。再叠加 `eagerMcpServers:[server名]` + tools/list `alwaysLoad` + 18000-token 描述拟合 + 64 上限 + 2s/250ms auth-race 重试。改动面：`transport.mjs`（spawn + session/new _meta + initialize 能力检查）、`agy-tool-bridge.mjs`（alwaysLoad + 预算拟合）、`agy-tools.mjs`（schema 裁剪）。侵入度中等，但每块都有社区源码可拄。

## 4. 盲区与待拍板

### 4.1 封号机制深挖结论（2026-11-24，issue #1493/#1542/#1701/#1684/#1597/#927/Rahularya01#154）

- **根因是形态不是字段（事实）**：router 让 caller 跑 loop、agy 当后端 = §6 harness，consumer OAuth 下与字段无关地违规，无个人豁免。
- **层 A 低风险（事实/推断）**：mcpServers、良性 systemPrompt.append、eagerMcpServers、alwaysLoad、预算裁剪 = 第一方能力，thin client + agy 仍为 agent 时合规。
- **enabledTools:[] 是越线特征（事实 #1701）**：官方点名「关内置工具让外部 harness 跑 loop」，且不计划提供剥离模式。**本项目不得默认关原生工具**。
- **prompt-cloak 规避 = 仍违规且加险（事实 #1701）**：不得做指纹改写。
- **429 指纹只作用 systemPrompt.append（事实 #1684）**：句子级黑名单，user 通道不拦。
- **确证封号集中在直连 API wrapper（事实）**；ACP harness 路线未找到确证封号但仍被定性违规。
- **合规避风港（事实）**：gemini-api-key / ADC，五处官方推荐；坑：已 oauth 登录的机器仅设 GEMINI_API_KEY env 不切换，必须显式 authenticate。

### 4.2 最终方案

**Phase 1（立即，层 A 低风险，不依赖 auth 决策）**：spawn 去 sandbox + --process-per-session（A/B 验证 --stdio 是否多余）；eagerMcpServers（能力门控）；alwaysLoad；18k-token 只裁 description 的预算拟合；认证瞬态单次 250ms 重试（绝不重试 429/不切号）；硬禁 cloak/enabledTools:[]/clientInfo 伪装。

**Phase 2（待拍板，不阻塞）**：api-key/ADC 一等公民 + §6 披露；oauth-personal 降为 thin passthrough（原生工具保留、手动重试、不自动切号）。安全（宿主执行）与合规（保留原生工具）的冲突需用户决策。

### 4.3 未确认证据缺口

eagerMcpServers/alwaysLoad 是否被官方编辑器使用；enabledTools:[] 单独是否被机器检测；ACP harness 确证封号；T3 合规定性；auth-race 自动重试许可性；api-key 路径指纹过滤是否失效（推断不触发）。

## 5. 实现落地终态（2026-11-25，插件 0.2.1/0.2.2，PR #205）

调研后的实际实现与第 3 节草案有两处关键偏离，记录最终决策与原因。

### 5.1 工具桥：选 stdio MCP 桥（方案 B 变体），不用 HTTP 桥

- **原因（实证）**：HTTP MCP 路径在真实 agy 1.5.15 下命中 #1530/#1190 暴露缺陷——`tools/list` 成功返回但工具不进模型声明；T3 Code（issue #40284）与 agent-code（#1545）均实测回退 stdio。stdio 是社区验证可靠的形态。
- **实现**：新增 `src/agy-mcp-stdio-bridge.mjs` 行式 JSON-RPC 转发器（agy spawn 的子进程，node:http 回环连内部 HTTP 桥，无代理、无超时以支持 park、并发不序列化、backend 宕回 -32603、stdin end 即退出、token 走 env 不走 argv）。`AgyToolBridge.stdioDescriptor()` 产出 agy 的 stdio server 描述符；进程内 HTTP 桥保留作内部后端，parked 机制不动。
- **握手修复（前置）**：桥实现 SEP-2575 `server/discover`（supportedVersions `2025-11-25`/`2025-06-18`/`2025-03-26`/`2024-11-05`，ttlMs:0/cacheScope:private），`initialize` 回字符串日期 protocolVersion（原错回数字 `1` 致协商失败）。修复后 agy 完成 discover→initialize→notifications/initialized→tools/list 全握手。
- **Windows 适配**：stdio command 用 `process.execPath.replace(/^\\?\\/, '')` 剥 verbatim `\\?\` 前缀，否则 Go exec.LookPath 解析失败、agy 静默丢弃 stdio server。

### 5.2 原生工具边界：scoped permission，不用 enabledTools:[]

- **原因**：4.1 已确证 `enabledTools:[]` 是 #1701 点名的 harness 接管越线特征，封号红线明确禁止。
- **替代实现**：保留 agy 原生工具声明，但在 ACP `session/request_permission` 回调（`bridgePermissionOutcome(params)`，transport start 挂到 `rpc.onPermission`）只放行 params 含 `ccr-caller-tools` 的桥接请求（选 allow_once）；agy 原生工具（run_command 等）的权限请求一律 cancelled。agent 无法借权限在宿主执行命令，安全边界等价于禁用原生工具，但不碰 ToS 点名字段。

### 5.3 其余 Phase 1 项（与草案一致）

- spawn 改 `['acp','--process-per-session']`（去 `--sandbox`；未用 `--stdio`，stdio 指 MCP server 形态而非 agy 自身参数）。
- 能力门控 `eagerMcpServers:['ccr-caller-tools']`；tools/list 每条 `antigravity/alwaysLoad`。
- 新 `src/agy-tool-budget.mjs`：18000 token 预算，`ceil(UTF-8 bytes/3)` 估算，二分字节上限只裁 description，永不丢工具/不动 schema。
- `retryStartupAuthRace`：performance.now 2s 窗口、单次 250ms，仅认证瞬态；绝不重试 429/RESOURCE_EXHAUSTED/quota/invalid_grant，不自动切号。
- `acp-stdio.mjs` 错误文本用不可枚举 `agentMessage`，防内部细节泄漏到模型可见消息。
- clientInfo 保持诚实 `ccr-gemini-agy-acp`，不伪装 zed；不做 prompt-cloak/指纹改写。

### 5.4 worker 池与 acp_busy（0.2.2）

- `acp_busy` 定性为 **503**（`acp-errors.mjs` busy:[503]，workers.size>=maxWorkers），非 429 限流；parked 调用占 worker 到答复为止是设计行为。
- 默认 worker 池 2→4（上限 8）缓解交错工具轮的池耗尽，不改 busy 语义。

### 5.5 验证

- 插件测试 168/168（含真子进程 stdio fixture、预算拟合、权限 outcome、握手协议）。
- 190 真机（agy 1.5.15，oauth-personal）：模型工具清单出现 `mcp_ccr-caller-tools_ccr_calculator`；连续 6 次 `finish=tool_calls`（calculator `{"expr":"2+2"}`）；完整 park→resume 往返（回 4 后续跑答出结果）。
- npm 已发布 `@wengine-ai/ccr-provider-gemini-agy-acp` 0.2.1（stdio 桥）/0.2.2（默认 4 worker）。

### 5.6 仍待办

- Phase 2 合规立项（api-key/ADC 一等公民 + §6 披露；oauth-personal 降 thin passthrough）待拍板，不阻塞当前工具能力。
- stdio 转发器 framing 压力测试（分片/多消息/坏行）为 follow-up。