# Step Plan 用量查询与 CCR 接入方案

> 2026-11-19 · 设计提案。中国站个人 Token Plan 已用现有套餐 Key 完成一次只读认证验证。

## 1. 现状与接入点

目标是让 CCR 的「额度」卡展示阶跃星辰给个人账户记账的套餐用量。当前供应商使用官方中国站的 `/step_plan/v1/chat/completions`。同一份套餐可以被多个客户端消费，因此卡片应读取上游账户快照。

当前数据流为 `ActiveProbeService.runQuotaProbe → getQuotaAdapter → storeQuotaResult → GET /api/providers/quota → 桌面 / Web 额度卡`。代码行号基于调研版本 `62e9497`。

| 现有模块 | 事实与设计接入点 |
|---|---|
| `packages/core/src/services/quota-adapters.ts:1386` | 已按框架或服务地址选适配器。参考火山套餐按主机和推理路径匹配的方式，增加 Step Plan 分支。 |
| `packages/core/src/services/active-probe.ts:632` | 写入有效样本后，5h/7d 的值还可能触发模型熔断或恢复。需要允许新适配器只报告展示数据。 |
| `packages/core/src/services/quota-store.ts:12` | 网关已有共享缓存及持久化。只保存脱敏后的套餐字段，供 Web 和桌面共同读取。 |
| `packages/core/src/ccr/admin-routes.ts:944` | `/api/providers/quota` 已有 5h、7d 和 30d 数字槽位。多个独立到期的加油包和精确 Credit 数量需要扩展响应契约。 |
| `apps/desktop/src-tauri/src/quota.rs:457`、`apps/desktop/src/quota.js:66`、`packages/ui/src/components/ProviderList.tsx:454` | 桌面从网关投影安全字段，Web 从额度响应生成进度条。两端均需支持 Credit 单位及到期文案。 |

## 2. 接口证据

**本机实测。** 向 `GET https://api.stepfun.com/step_plan/v1/usage` 发送现有套餐推理 Key，采用 Bearer 认证、HTTPS 和禁止重定向的客户端。一次请求返回 HTTP 200，`schema_version=1`、`scope=personal_account`、`plan.family=token`、`quota.state=known`、`quota.allowed=true`。响应有一个 `subscription` Credit 桶，`windows=[]`。`total` 和 `remaining` 为十进制字符串，`used_percent` 有值，`expires_at_ms` 有值，`resets_at_ms=null`。该结果确认此账户可直接接入。公开文档仅记录字段形状。

**官方契约。** Step-Code 的 Account 页面使用同一接口。`coding` 套餐返回 `five_hour` 和 `weekly` 百分比窗口。`token` 套餐按订阅与加油包分桶，保留精确十进制数量。中国站说明 Plus 每月发放 1,600M Credit，加油包有独立有效期。进度条使用字段 `used_percent`，文案明确写「已用」或将它转换为「剩余」。[官方客户端实现](https://github.com/stepfun-ai/Step-Code/blob/5309624e5deff3d8fee031f0853fe7e07bc68801/packages/coding-agent/src/step/usage/account.ts) · [官方 Account 文档](https://github.com/stepfun-ai/Step-Code/blob/5309624e5deff3d8fee031f0853fe7e07bc68801/packages/coding-agent/docs/account-usage.md) · [中国站套餐与计费](https://platform.stepfun.com/docs/zh/step-plan/pricing.md)

**同类实现与取舍。** OpenCode Quota 也使用套餐 Key 查询 `/usage`。CodexBar 的控制台方案需要浏览器 Cookie 和设备标识，并使用表示剩余比例的另一套字段。CCR 现有 Key 已通过实测，推荐采用官方套餐接口。若未来目标账户仅开放网页登录，再单独评估控制台方案。[OpenCode Quota](https://github.com/TuzelKO/opencode-quota/blob/c3f3674332f46b67e2627f20e59261af7833d9f1/probe.ts) · [CodexBar](https://github.com/steipete/CodexBar/blob/1f6da9bec44455288ddee5ef6f3617a803d8eb2a/docs/stepfun.md)

## 3. 推荐方案

1. **查询。** 新增 `StepFunPlanQuotaAdapter`。首版精确匹配 HTTPS 官方中国站和 `/step_plan/v1/` 套餐路径，沿用供应商的代理策略。请求固定同源用量端点，设置 `redirect: 'error'`、超时和 `Accept-Encoding: identity`。平台按量 Key、第三方同名供应商及国际站留在原流程。复用现有额度探测周期，同一供应商的并发刷新合并为一次。
2. **建模。** 给 `ProviderQuotaResult` 及网关响应增加可选的个人套餐快照，保留 `family`、套餐显示名、`observedAt`、`allowed` 以及窗口或额度桶列表。每个桶保存 `subscription/topup`、`total`、`remaining`、`usedPercent`、`resetAt`、`expiresAt`。Credit 数量按十进制字符串跨 JSON/IPC 传递，使用十进制定点运算计算已用。对整数 Credit 可直接用 `BigInt` 作差。`account.id`、订阅 ID、鉴权信息和原始响应均在解析边界舍弃。
3. **展示。** 对当前 Token Plan，桌面和 Web 都显示「月度订阅 Credit」，进度条展示已用百分比，同时给出剩余及总量。每个加油包单列，保留自己的到期时间。日期分别按「重置」和「到期」标注，仅显示上游提供的值。旧 Coding Plan 使用已有 5 小时、7 天标签，`limited=false` 显示「无限额」，合法的零用量显示 `0%`，缺值显示 `—`。每个账户快照按整体替换，套餐切换后旧窗口随之移除。
4. **路由与缓存。** 首版将 Step Plan 标为仅展示，存储快照后跳过现有配额熔断与恢复逻辑。订阅桶耗尽时，加油包仍可能有额度。`quota.allowed` 作账户状态展示。401/403 清除该凭据的旧展示，429 尊重 `Retry-After`，网络失败短时保留带观测时间的旧快照并标陈旧。供应商端点或 Key 变化时丢弃旧身份样本。`partial`、未知 schema 和过期桶不产生虚假的零余额或满额。

### 实施与验收

| 切片 | 改动 | 可验证结果 |
|---|---|---|
| 1 · 网关 | `quota-adapters.ts`、`active-probe.ts`、`quota-store.ts`、`ccr/admin-routes.ts` 与相应测试 | 用合成的月度订阅样本走到 `/api/providers/quota`。金额字符串和过期时间保持精确，响应仅含白名单字段。实机与同一份上游快照逐字段核对。 |
| 2 · 两端展示 | `packages/ui/src/types.ts`、`ProviderList.tsx`、中英文 locales、桌面 `quota.rs` 和 `quota.js` | 同一份快照在两端显示一致。窄屏可看见单位；悬停或详情可看精确数量。验证多加油包、不同到期日、缺百分比、零额度、仅到期无重置。 |
| 3 · 兼容与恢复 | 增加旧套餐、限流、换 Key、套餐切换与失败重试 fixture，并做隔离网关验收 | Coding 套餐显示实际窗口；不再属于当前套餐的卡片消失。模拟订阅耗尽且加油包可用、认证失败、超时、部分响应，断言均无模型健康状态副作用。 |

最短实现是把订阅桶压到现有 30d 数字槽。该方案改动少，但缺少 Credit 单位、独立加油包和到期语义。推荐增加可选快照，两端可分批升级；回滚时停用 Step Plan 适配器即可。该实现涉及核心契约和两个展示端，中等改动量。

## 4. 验证边界

已实测中国站个人 Token Plan 月度订阅桶。旧 Coding Plan、国际站、多加油包、跨月刷新及异常返回的语义来自上游实现和文档。首版可用 fixture 验证，后续遇到对应账户时补实测。公开方案基于官方客户端的 schema 1，上游调整时应以新版本契约和实际响应重新核对。
