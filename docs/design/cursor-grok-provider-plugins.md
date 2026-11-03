# Cursor / Grok provider 插件调研与设计

> 真实意图：将 magpie 已支持的 Cursor、Grok 订阅反代接入 CCR，复用现有插件生命周期、账户管理和工具链；2026-10-27；状态：已实现并通过离线审查与真实 CCR 加载冒烟；真实账号未验证，未提交/未建 PR。

## 1. 现状与接入点

### 数据流与已有参考

```text
plugins.json → provider-plugins/loader.ts → plugin.activate(ctx)
UI 插件卡 → /api/<plugin>/* 本地管理路由 → 私有 credentials + host.writeConfig/reloadRuntime
client → UnifiedChatRequest → plugin Transformer → ManagedRuntime → 固定上游
upstream stream → plugin Transformer → Unified Chat stream → Anthropic / Responses client
```

- 事实：`packages/core/src/provider-plugins/types.ts:23` 定义 coreApi=1，`:85` 的 ManagedRuntime 提供 fixed upstream、signRequest、classifyError、quota、401 单次刷新和有界 dispatchRequest。`:207` 的 PluginContext 提供 transformer/runtime/admin/config protector/card/locales 注册点。
- 事实：`packages/plugins/codex/src/plugin.ts:43` 的 activate 将 host 的 SUBSCRIPTION_PROXY_URL 显式代理用于订阅数据面和登录/模型/额度；六个注册点在同一实例闭包中共享服务。新插件沿用此形状，不能打包 core 的运行时状态。
- 事实：`packages/plugins/codex/src/core-types.ts:71` 仅 type-import canonical host types，插件内部自行处理协议；`scripts/build.ts:63` 用 metafile 阻止 core/src 被 bundle。
- 事实：`packages/core/src/ccr/plugin-install-routes.ts:34` 的插件市场按 npm marker keyword 搜索，无 provider 硬编码白名单；新包配置 marker 即可被发现，发布前支持本地路径安装。
- 事实：`packages/shared/src/plugin-install.ts:72` 的安装器验证 coreApi、manifest、card 和归档，私有凭据位于 plugins/ 之外，不由安装器读取/删除。
- 事实：`packages/plugins/codex/src/admin-routes.ts:43` 本地管理路由使用回环地址、Host/Origin 约束，避免把上游的 401 作为 CCR 登录失效返回给 UI；新增插件必须遵守同样边界，守卫优先 socket 地址。

### 拟接触文件与契约

- `packages/plugins/cursor/`：独立包、私有认证/状态服务、协议编码、Transformer、ManagedRuntime、本地管理路由、卡片与 locale、离线 fixture 测试、打包脚本。
- `packages/plugins/grok/`：同上；具体认证和 wire 协议取决于上游源码证据，不能按普通 OpenAI API 假设。
- 不预设 coreApi 变更；优先现有 extension points。若 Cursor duplex transport 无法通过现有 HTTP dispatch 表达，必须记录明确接缝和替代方案后再实现。
- `docs/design/cursor-grok-provider-plugins.md`：保留 upstream commit/path/URL、反面证据、选型、实施/验证状态。
- 规模判断：两个独立 provider 的完整生命周期，显著超过三文件小改；按插件隔离并行开发，父 agent 负责整合，独立 reviewer 审查最终代码。

### 约束与既有坑

- 当前 `feat/codex-subscription` 大量既有未提交修改，保护所有既有内容；本轮只新增插件目录和本设计，必要集成修改单独列明。不提交、不发新 PR、不发布 npm。
- 凭据只存私有 0600 文件，不写入 config.json/status/logs；配置写回读 raw config，避免把 $VAR 烘焙成明文。
- 固定订阅源只使用 SUBSCRIPTION_PROXY_URL 显式 opt-in；不能悄悄继承 PROXY_URL 或允许任意 credential-bearing URL。
- Gemini 经验：真实工具历史与短 API 请求不同；不得把 fallback 返回当成目标 provider 成功。无真实账户时明确验证界限，不伪造通过。
- 流式 parser 必须跨 chunk、UTF-8、错误/EOF、取消传播；空流不能伪装成功。

## 2. 外部调研

一手源码固定为 [magpie-community/plugins@bace91473b4f113a719a49b7d8ce81fe1f5b5760](https://github.com/magpie-community/plugins/tree/bace91473b4f113a719a49b7d8ce81fe1f5b5760)，本地只读克隆 /tmp/ccr-magpie-cursor-grok-upstream。许可证 MIT，复制 substantial 代码必须带完整 notice。

### Cursor

- 事实：[index.mjs:3017](https://github.com/magpie-community/plugins/blob/bace91473b4f113a719a49b7d8ce81fe1f5b5760/packages/cursor/index.mjs#L3017) 的 CursorAuthPlugin 提供虚拟 Chat Completions fetch；内部 AgentService/Run 为双向 HTTP/2 Connect，HTTP/1.1 使用 RunSSE + BidiAppend（二进制帧，并非普通文本 SSE）。对应 CCR 的 ManagedRuntime.dispatchRequest，不扩 coreApi。
- 事实：同文件 :373 browser PKCE + auth/poll，:428 显式导入 CLI 登录，:339 API-key exchange；browser token 到期需要重新登录，不能承诺自动 refresh。对应新插件 auth-service 与 admin login/start/poll/cancel/import。
- 事实：:1999 open、:2042 openH2 使用原始 http2.connect，ambient fetch 不等于 CCR subscription dispatcher。代理开启时明确 H1-only，包括 region retry；其代价是部分区域团队可能不兼容。对应 vendor 的依赖注入与插件 transport。
- 事实：[native-session.mjs](https://github.com/magpie-community/plugins/blob/bace91473b4f113a719a49b7d8ce81fe1f5b5760/packages/cursor/native-session.mjs) 维护工具结果提交、uncertain write 禁止重放、120s result wait/15min lifetime、账户与进程容量上限。保留状态机，插件负责账号生命周期清理。
- 反面证据：[magpie #2672](https://github.com/yetone/magpie/issues/2672) thinking 后只剩心跳导致请求不结束；固定版本已有 idle/quiet deadline。[plugins #377](https://github.com/magpie-community/plugins/issues/377) 工具批次超时；保留上游计时修正。上游本地套件 310 passed / 1 failed，native-e2e background checkpoint 测试可复现失败，尚未确定原因，不能标记全部通过。
- 能力边界：远程 URL 图片仅转占位文本；data URL 用户图支持，工具图依赖 native continuation；quota empty windows 是未知，不能当作 0%。

### Grok

- 事实：[index.mjs:18](https://github.com/magpie-community/plugins/blob/bace91473b4f113a719a49b7d8ce81fe1f5b5760/packages/grok/index.mjs#L18) 固定 cli-chat-proxy.grok.com/v1，使用 Responses API，与 api.x.ai API-key 计费不同。:303 sign、:410 rewrite、:507 listModels、:804 usage 是插件内部接入点。
- 事实：:577 device login 运行 grok login --device-auth；:748 current 导入现有 CLI home；token 接近到期或被 401 拒绝时运行 grok models，单飞后重读 auth.json。refresh 字段是 home 路径，并非 refresh token。对应 CCR 私有状态、显式 CLI import、一次强制续期；断开只解绑 CCR，不删除共享 CLI 登录。
- 事实：上游 loader 仅处理签名和 Responses body，未转换 SSE/JSON；CCR 应采用 transformer 链 [openai-responses, grok]，保留现有 Responses/Chat/Anthropic client 分流。
- 反面证据：[plugins #324](https://github.com/magpie-community/plugins/issues/324) 官方 CLI models 有时不能续期；不能承诺永久自动恢复。[magpie #3871](https://github.com/yetone/magpie/issues/3871) include output.encrypted_content 被拒，应规范为 reasoning.encrypted_content。[magpie #3110](https://github.com/yetone/magpie/issues/3110) 与 [#3153](https://github.com/yetone/magpie/issues/3153) 工具限制翻译丢失，因此首版不自动注入 Native X search。
- 事实：上游离线 Bun 测试 82 passed / 0 failed，尚未验证 CCR/真实账号。模型只信 /models，保留 @window 映射；usage credit percent 与 rate limit 分开，失败未知不冒充剩余充足。

## 3. 方案对比与推荐

| 方向 | 改动/维护成本 | 协议覆盖与风险 | 判断 |
| --- | --- | --- | --- |
| A：从零 TypeScript 重写 | Cursor 最大，需重做二进制会话与所有恢复边界 | 容易丢失工具提交/缓存/超时语义 | 不选 |
| B：固定 MIT engine + CCR adapter | 两个私有 vendor 模块，少量注入补丁；跟踪上游升级 | 保留有测试的状态机，仍需 CCR 边界验证 | 推荐 |
| C：外部 magpie 进程二次反代 | 表面较小但引入独立服务、账号和端口运维 | CCR 插件依赖另一个网关，UI/错误/额度两层状态 | 不选 |

推荐 B。推断：既有 dispatchRequest 能直接承接 Cursor virtual fetch，Grok 使用正常 HTTP runtime；无需扩 coreApi 或引入通用共享框架。复杂 wire 协议留在插件私有模块，生命周期由 CCR adapter 显式掌控。

## 4. 详细设计

### 最小切片与验收

1. 先证明两个插件可独立 build/load，未连接状态 fail closed；fixture 跑通文本与工具轮，认证持久化与本地管理守卫。
2. 完成 browser/CLI/API-key（Cursor）及 device/CLI（Grok）的显式用户操作，模型同步失败保留旧目录，disconnect 不碰外部 CLI 文件；UI 卡走 host callApi/acquireManagement/refreshConfig。
3. 完成 SSE 错误/早 EOF、取消、代理、模型窗口和额度未知状态测试；实际 host loader/transformer seam 验证。
4. 合并两个隔离目录到主工作区，独立 reviewer 检查最终 diff；干净构建本地安装，未连接状态可见；有效账号另行真实验证，不启用 fallback 伪证。

### 生命周期与文件职责

每个插件含 src/plugin.ts（六个注册点）、auth-service.ts（0600 持久化与账号生命周期）、protocol/vendor（固定 wire 实现及 notices）、transformer.ts（CCR 请求/响应适配）、managed-runtime.ts（固定源/分类/代理）、admin-routes.ts（本地管理）、card-entry.ts/locales.ts（管理 UI）、scripts/build.ts、fixture tests。

Cursor：Unified Chat → reasoning/session 映射 → engine virtual fetch → Connect Run → Chat SSE → CCR client 转换。显式 subscription proxy 时所有 HTTP 注入 host dispatcher，禁止直连 H2；无代理保留原 H2。断开取消 active work/native owners。Grok：Unified Chat → core openai-responses → grok rewrite/sign → 固定 Responses 源 → core Responses client 分流。

### 隔离开发 lane board

本次为 multi-seam：两个 provider 可独立验证，父 agent 只整合。

| Lane | cwd / 独占文件 | 权限 | gate / handoff |
| --- | --- | --- | --- |
| Cursor | /tmp/ccr-cursor-plugin-lane，packages/plugins/cursor/** | 本地编辑/构建/测试；不提交/推送/发布/读真实账号 | fixture tests + tsc + bundle；目录与报告 |
| Grok | /tmp/ccr-grok-plugin-lane，packages/plugins/grok/** | 同上 | fixture tests + tsc + bundle；目录与报告 |
| Integration | 主工作区，仅导入两个新目录、文档与必要 lockfile | 父 agent 在 writer handoff 后整合 | host seam + fresh review + 本地加载 |

两 lane 基于 c32e02d，canonical host type 与 UI contract 已复制当前版本；node_modules 仅链接使用。禁止 lane 修改共享 core 或其他插件。凭据不自动导入，不运行上游安装脚本。测试无网络、无真实 CLI 访问。

### 风险与回滚

不改变现有 provider；新插件本地 disable/卸载可回滚，私有凭据与 payload 分离。无真实账号时保留未验证标签。Cursor 上游 checkpoint 测试失败与区域 H1 限制必须披露；Grok CLI 是否成功续期取决于官方 CLI。暂不发布 npm、不创建新 PR，沿用户既有暂停要求。

## 5. 盲区与待拍板

## 5. 盲区与待拍板

- 审查结论：Cursor「BLOCK→已修」，唯一 P0（测试文件重复 import）修复后 183/183 重跑通过，checkpoint 专项 bun 测试 1/1；其余 P2（disconnect 容错、region 映射测试、激活守卫、401 误标收窄）已同批修复。Grok「OK with notes」，P1（load 失败缓存导致 disconnect 死锁）已修，另加 isErrorEnvelope、登录 URL 去尾码、刷新错误分类，41/41 通过。
- 真实账号未验证：Cursor 登录/模型/额度/代理下 H1、区域团队兼容性；Grok 官方 CLI 续期、托管工具、图像推理、计费。发布前需各做一次授权实盘冒烟。
- 集成水位：两目录已复制进主工作区并通过 createCcrServer 冒烟（安装器+loader+卡片+offline 守卫）；`pnpm-lock.yaml` 尚未登记两个新 workspace 包，PR 前需一次 `pnpm install` 生成 lockfile 条目。
- 宿主限制保留：coreApi=1 无 dispose 回调，插件禁用/Server 销毁不能即时取消进行中请求，靠有界计时器与重启收敛（两个 README 已如实写明）。

现有 coreApi=1 没有 plugin dispose hook；PluginRegistry.dispose() 只清注册项。新插件必须自行约束 login/request 生命周期、disconnect 清理；禁用按现有重启语义，进程内多 Server dispose 不保证立即取消全部插件任务。不得声称已拥有 host 不提供的关闭契约。

事实核对：Cursor 内部 usage.input 是扣除 cache 的余量，但固定源码 index.mjs:2579–2587 在输出 Chat 时已用 input+cacheRead+cacheWrite 重建 inclusive prompt_tokens；适配层不可再次加缓存。README 对内部计数的简述不能代替最终 wire 证据。cache_write_tokens alias 和 deferred accounting 仍需明确测试，累计账单不能当作当前上下文 token。
