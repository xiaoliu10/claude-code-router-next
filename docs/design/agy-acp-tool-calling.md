# Agy ACP 工具调用 — 设计（对齐 pi-antigravity-acp-provider）

> 真实意图：让 CCR 的 Agy ACP provider 支持调用方（如 VE）的工具调用——
> 调用方声明 `tools[]`，Agy 通过本地 MCP 桥发起 `tools/call`，CCR 把调用
> 交回调用方执行，第二轮请求带回结果后继续同一个 ACP 回合。
>
> 参考实现：`zacbemis/pi-antigravity-acp-provider` @ `6d6135d`（下称 Pi 插件）。
> 状态：**已实现并通过测试**（46/46）。190 沙箱网络仍未实测。

## 1. 参考实现的核心机制（源码已核）

| 机制 | 参考实现 | 说明 |
|---|---|---|
| MCP 桥 | `src/mcp/bridge.ts` | 仅监听 `127.0.0.1` 随机端口，路径 `/mcp`，随机 Bearer token，`timingSafeEqual` 比较，1MB body 上限 |
| 工具投影 | `src/mcp/schema.ts` + `projectTools()` | `pi_<name>` 前缀、64 字符截断、去重；schema 白名单投影，**无法表示的整个工具被省略**，不静默放宽 |
| 能力探测 | `runtime.ts` `getBinding()` | 只在 `initialize.agentCapabilities.mcpCapabilities.http === true` 时建桥 |
| 挂起 | `runtime.ts:requestPiTool()` | `pendingTools.set(id, {resolve})`，MCP 请求不返回，直到调用方回填 |
| 跨请求续跑 | `runtime.ts:runQueued()` + `findContinuationKey()` | 进程内按「回合未完成 + 所有挂起调用都有结果」匹配；命中则**不重新 prompt**，直接 resolve 后 `awaitContinuation` |
| 结果回填 | `runtime.ts` `toMcpToolResult()` | 调用方 tool result → `CallToolResult`（text/image + isError） |
| 权限 | `runtime.ts:requestPermission()` | Agy 的 `session/request_permission` 映射成虚拟工具，120s 超时，默认 `cancelled` |

**关键架构事实**：Pi 插件是单进程内嵌 provider，`pendingTools` 活在同一个 runtime 对象里，
所以不需要磁盘会话存储。CCR 的插件同样是进程内常驻（worker 池 + 模块级状态），成立。

## 2. CCR 侧现状（`origin/main` @ `7acdb7f`）

- `transport.mjs`（233 行）：`Worker` 池 → `turn()` → `session/new` 写死 `mcpServers: []`；
  `session/prompt` 只收 `onText`。**无 OAuth、无 sidecar、无 installer**（当前 main 是精简版）。
- `chat.mjs`：`textTurns()` 对任何 `tools`/`tool_choice`/`tool` 角色/`functions` 一律抛
  `400 agy_unsupported_request`。
- `acp-stdio.mjs`：`session/update` 只处理 `agent_message_chunk`；`session/request_permission`
  一律 `cancelled`；未知方法 `-32601`。
- `plugin.mjs`（84 行）：`dispatchRequest` 调 `chatResponse(transport, toPrompt(...))`。
- 测试：`test/transport.test.mjs`、`test/plugin.test.mjs`、`test/build.test.mjs`，
  fixture `test/fixtures/agy-acp.mjs`（断言 `params.mcpServers` 为 `[]`）。

差距：① 无 MCP 桥；② 无挂起/回填；③ 无跨请求续跑；④ `chat.mjs` 直接拒绝；
⑤ ACP 侧不接工具/权限事件。

## 3. 设计决策

**采用**：进程内 binding 表（挂在 Worker 上），MCP HTTP 桥，`pendingTools` 挂起，
按 `tool_call_id` 匹配回填。

**不采用**：ACP `session/load` / `session/resume` 持久化恢复。理由：CCR 的 HTTP 请求
没有稳定会话 id，参考实现的 `findContinuationKey` 是内存匹配而非磁盘查询；磁盘会话库
会引入跨进程/重启一致性问题，超出本次范围。

**执行权归属**：**调用方执行工具，Agy 只发请求。** CCR 不做本地工具执行，
MCP 桥只做「转发 + 挂起」。

**会话键**：VE 的两次请求在同一会话内，用 `messages` 里 assistant 的 `tool_calls`
与挂起项按 `id` 匹配。这与参考实现 `findToolResult(context, id, name)` 同源。

**拒绝策略**：
- 调用方未声明工具 → 维持现状（纯文本路径不变）。
- Agy 未广告 `mcpCapabilities.http` → 该工具 omitted，对调用方**显式报 400**，
  不静默降级成纯文本（否则调用方会以为模型没用工具）。
- 工具 schema 无法投影 → 省略该工具；若调用方声明的工具全部被省略 → 报 400。
- 调用方两轮之间工具结果缺失/不匹配 → 取消挂起（`isError` 结果），ACP 那一轮拿到
  错误继续，不挂死。

## 4. 数据流（改后）

```
第 1 轮  POST /v1/chat/completions  {tools:[read_file], messages:[user]}
   └─ dispatchRequest 检出 tools → transport.run({tools, ...})
        ├─ initialize  → 读 mcpCapabilities.http
        ├─ 起 MCP 桥(127.0.0.1:0, token) ──► session/new {mcpServers:[bridge]}
        ├─ session/prompt
        ├─ Agy: MCP tools/list  → 桥返回 [ccr_read_file]
        ├─ Agy: MCP tools/call   → 桥挂起(pending)，MCP 请求不返回
        └─ 首轮响应：{finish_reason:"tool_calls", tool_calls:[{id,name,arguments}]}
             binding（含 sessionId + pending）保留在 Worker 上

第 2 轮  POST /v1/chat/completions  {messages:[..., assistant(tool_calls), tool(result)]}
   └─ 按 id 匹配 pending ──► resolve(CallToolResult)
        └─ 同一 session/prompt 继续 ──► agent_message_chunk ──► {finish_reason:"stop"}
```

## 5. 改动清单

| 文件 | 职责 |
|---|---|
| `src/agy-tool-bridge.mjs`（新） | MCP HTTP 桥：`/mcp`、Bearer、`tools/list`、`tools/call`、schema 投影、body/预算上限 |
| `src/agy-tools.mjs`（新） | OpenAI `tools[]` 声明归一、`tool_calls`/`role:"tool"` 提取与匹配、回填提示词 |
| `src/transport.mjs` | Worker 持有 binding；`turn()` 接受 `bridge`/`resume`；把桥描述符交给 `session/new`；挂起时放弃等待 prompt；续跑时 `abandon()` 旧 prompt；`toolBridge()` 供次轮取回同一座桥 |
| `src/acp-stdio.mjs` | `session/update` 透传 `tool_call`；`session/request_permission` 走回调（默认 cancelled） |
| `src/chat.mjs` | `textTurns` 拆成 `assertNoTools` + `textTurnsOnly`；`chatResponse` 输出 `tool_calls`（非流式 + SSE）；`safeFailure` 只对插件自有 code 保留 message |
| `src/plugin.mjs` | `dispatchRequest` 编排两轮流程；`withToolResults` 持有桥（次轮经 `transport.toolBridge()` 取回）；transformer 只对无工具请求做文本校验 |
| `test/*` | fixture 增加 MCP 客户端模式；新增工具往返、投影、挂起取消、缺结果等用例 |

## 6. 分阶段实施

1. **最小切片**：MCP 桥 + `tools/list`（只验证 Agy 能发现工具）。
2. 挂起 + 首轮 `tool_calls` 输出。
3. 次轮回填 + 续跑。
4. 错误路径（缺结果、schema 省略、无 http 能力、并发）。
5. 190 实测 + 发版。

## 7. 测试策略

- fixture `agy-acp.mjs` 增加模式：做一次真实 MCP HTTP 客户端（`tools/list` + `tools/call`），
  按脚本返回 `tool_calls` 语义；同时校验桥的 Bearer 与 405/401 行为。
- 覆盖：工具发现、单/并行调用、挂起后取消、结果回填、schema 省略、无 http 能力、
  调用方缺结果、两会话隔离、纯文本路径零变化。
- 复用现有全部测试，不得回归。

## 8. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 190 的 agy 沙箱不让访问 `127.0.0.1` HTTP | 阶段 1 先只验 `tools/list`；若不通，文档标注并放弃，不留半成品 |
| 挂起导致请求泄漏 | pending 有界（上限 + idle 回收），worker 退役/进程退出一律取消 |
| 工具名/参数被改写 | 桥按调用方原始 schema 校验参数，不符即 `isError` |
| 桥被同机其他进程访问 | 随机 token + `timingSafeEqual` + 仅监听 127.0.0.1 |
| 回归纯文本路径 | 无 `tools` 时完全不建桥，请求形状逐字段不变 |

回滚：整个特性是新增分支 + 新增文件；`transport.mjs` 的改动均为可选参数默认值，
纯文本路径行为不变；出问题可直接 revert。

## 9. 实现要点（与初版设计的差异）

- **桥由插件持有，不由 transport 创建**。`withToolResults` 建桥，`transport.run({bridge})`
  只消费；次轮通过 `transport.toolBridge()`（池级，遍历 worker 找有挂起的 binding）取回
  **同一座桥**。初版设计把桥放在 transport 内部，会导致次轮拿到新桥 → `bridge_not_listening`。
- **挂起时不能继续等 prompt**。Agy 的 `tools/call` 不返回，agent 就不会回
  `session/prompt` 的 result。因此 `acp-stdio.mjs` 的 `parked` 回调让 `turn()` 用
  `Promise.race([prompt, parked])` 提前返回 `{parked:[...]}`；被放弃的 prompt 加
  `.catch(() => {})` 吞掉迟到的答复。
- **续跑要先 `abandon()` 旧 prompt**，否则同一 rpc 上有两个在飞请求，
  `request()` 会抛 `protocol_error`。
- **调用方可见 id 由桥铸造**（`onParked` → `onToolCall`），不是 Agy 自己的
  `toolCallId`。初版按 ACP id 回写在竞态下不可靠（Agy 先发通知、后发 MCP 请求）。
- **上限必须一致**：`chat.mjs` 的 `MAX_TOOL_CALLS` 直接 import 桥的
  `MAX_CALLS_PER_TURN`，避免「挂起了但调用方没被告知」的永久挂起。
- **桥自己登记挂起项，再通知任何人**。若先通知后登记，`turn()` 的 `finally`
  会看到 `pending` 为空而提前关桥，把已发起的调用连 socket 一起泄漏。
- **`retire()` 必须能解开挂起的回合**。调用方 abort / idle 回收 / 关池时，
  `turn()` 还停在 `Promise.race([prompt, parked])` 上；不显式 reject 这条 race，
  `finally`（关桥、清 binding）永远不会执行。`parkDead` 就是为此加入的。
- **挂起 id 在 `onParked` 当时就地记录**，不能回头读桥的 map——agent 可能
  立刻跑完一次调用，那时条目已经没了。
- **transformer 不能拒绝工具请求**：初版 `transformRequestIn` 对所有含 `tools`
  的请求抛 400，工具路径在生产里根本走不到。现在只在无工具时做文本校验。
- **桥必须按调用方自己的挂起 id 取回**。池级 `toolBridge(ids)` 要求 worker 上挂起的
  id 全部命中调用方这一轮的 `tool_calls`，否则两个交错的会话会互相抢桥——抢到的那一
  方会拿着别人的 `sessionId` 继续 prompt，直接协议错。
- **worker 选取要分两种**。续跑必须落到持有自己桥的那个 worker 上（挂起的调用和温
  session 都在那儿）；其它回合则要避开「仍有挂起调用」的 worker——那个 worker 是留给
  来答复的续跑的，抢过来会把前一个调用连桥一起拆掉。只有空 binding 的 worker 可以复用。
- **`maxWorkers` 默认取 2**（与 transport 一致）。1 个 worker 时，第二个会话的工具请求
  会因为「避开占用的 worker」而新建 worker；若上限也是 1 就直接 `busy`。
- **`closeBinding()` 要先 `abandon()` 旧 prompt**。旧 prompt 还占着 rpc 的 `pending`，
  不先丢掉，下一个 `session/new` 之后的 `request()` 会撞车，整个 worker 报废。
- **续跑 prompt 必须带上调用方本轮的新消息**。只回放工具结果会把用户随结果一起发来的
  指令悄悄丢掉；assistant 的历史文本不 replay（那是 agent 自己停车前说的）。
- **agent 侧必须容忍桥中途消失**。关桥会把在飞的 `tools/call` 打断；真实 agent 应当
  把这当成一次失败的工具调用继续下去，而不是崩掉自己的进程。

## 10. 独立审查结论与修复

审查（子代理，冻结态）结论：**无 blocker**；文本路径逐字段不变；桥的生命周期在已测路径上
无泄漏。以下为审查发现并已修复的问题：

| # | 问题 | 修复 |
|---|---|---|
| S2 | 第三轮及以后的工具会话被误判为 resume：`session/new` 丢掉全部真实上下文，且每轮重复回放越来越长的「已完成调用」 recap | `resuming` 增加「本池仍持有该桥」的门槛（`plugin.mjs`），只有真续跑才走 resume |
| S3 | 调用方 quoting 别的会话的挂起 id 能抢桥并 prompt 到别人的 ACP session | `toolBridge(ids)` 改为严格双射（`parked.length === wanted.size`），超集/子集都不匹配 |
| S4 | `MAX_SESSIONS`(64) 打满时 retire worker，会把仍在等的挂起调用连桥一起关掉 | 仅在没有挂起调用时才按会话数 reap |
| S5 | （复核后确认不成立）挂起数超过告知数的泄漏 | 桥的 `MAX_CALLS_PER_TURN` 与 `chat.mjs` 的告知上限是同一个导入常量，超出部分的 `tools/call` 立即以 error 回复，不会挂着 |
| S1 | `closeBinding` 无幂等保护，`retire` 竞态下可能 reject 一个正要被 `stop()`  settle 的 prompt | worker 已 retired 时跳过 `abandon()` |
| — | 第三轮走 fresh 路径时，`textTurnsOnly` 拒绝 `content: null` 的 tool_calls 消息 | 允许 tool 轮的空 content（payload 透传，不执行） |
| N1 | `summarizeCall` 导出未用 | 删除 |
| N6 | `toolResultPrompt` 用反转下标切尾消息，易错 | 改为 `reduce` 求最后一个 tool 消息下标 |

## 11. 盲区

- **190 沙箱网络未验证**（上一轮 3 次超时无结论）。这是本设计最大的未知数。
- ACP `session/load`/`resume` 未实现，重启后无法续跑。
- 仅支持 text 工具结果；图片/资源块未接。
- `tool_choice: "required"` 与 `allowed_tools` 只透传，未做强制校验。
- 当前 main 的插件是精简版（无 OAuth/sidecar），本次不改这些。
- 190 沙箱能否访问 `127.0.0.1` HTTP MCP 仍未实测（本次仅本地 fixture 子进程验证）。
- 真实并发上限 = `maxWorkers`（默认 2）：同时挂起工具调用的会话数超过它时，后来的
  请求会拿到 `acp_busy`，而不是静默拆掉别人的挂起调用。
