# Provider 插件化架构（供应商插件系统 + Codex 首个插件）

> 日期：2026-10-21　状态：已获实施授权；决策已确认（§7），Gemini 样板迁移进行中。
> 决策背景：用户已拍板「先插件化，Codex 当第一个插件交付」。
> 依据：magpie 插件体系一手参照（magpie-community/plugins + `plugin add`）；Codex 调研两份（`~/.pi/.../codex/{codex-auth,codex-dataplane}.md`，含 openai/codex 官方源对照）；CCR 现有 WorkBuddy/Gemini 两套「受管订阅 provider」的重复模式。

---

## 0. 结论速览

1. **动机不止体积**：主包 12.3MB 中订阅 provider 自身只占 ~300-500KB（大头是依赖），但插件化同时买到：审计面收窄（企业可不装调用腾讯/Google 内部端点的代码）、风险隔离（某家被官方打击时可独立撤插件不发主包）、迭代解耦。
2. **架构**：core 定义 `ProviderPlugin` 接口（transformer / 受管运行时 / admin 路由 / config 锁 / UI 卡 / locale 六个注册点）；插件装在 `~/.claude-code-router/plugins/<name>/`，`plugins.json` 为安装事实源（magpie 同款）；`ccr plugin add` 安装；UI 卡由 core 静态服务 + 前端动态 import。
3. **首个新增供应商插件 = Codex**（§5）；Gemini 与 WorkBuddy 先作为迁移样板，P1 内全部迁出，主包不再捆绑。保留既有配置与凭证，不自动安装插件。
4. **三项已确认决策**（§7）：直接硬切外部安装；P1 一次迁两家；Codex v1 仅浏览器授权（含回调降级），不导入官方 CLI 登录。

---

## 1. 现状问题（为什么要做）

- `api/routes.ts` 里每接一个订阅 provider 就长一对 `xxxManaged` 分支（workbuddy/gemini 已两对，codex 会是第三对）——同一形状复制三遍。
- 订阅代码（~6200 行 + UI 卡 798 行）静态打进主包：不用的用户也背着（审计面），provider 被官方打击时撤下线要发主包版本。
- transformer 注册表 27 个静态 import，全部启动实例化。
- magpie 的解法（一手）：provider 在 `magpie-community/plugins` 独立包，`plugin add` 安装，`plugins.json` 是安装事实源，核心仓只留网关与注册接口。

---

## 2. 插件 API 设计（core 侧新增）

### 2.1 插件接口（`packages/core/src/provider-plugins/types.ts`）

`src/plugins/` 是既有输出插件体系（token-speed）；供应商插件使用独立命名空间。下列片段为最初概念草案，准确运行时类型以 `provider-plugins/types.ts` 为准：当前实现拆分为 `ensureUsable` / `lockUpstream` / `signRequest` / `classifyError`，并通过 `ctx.host` 注入配置读写、重载和 dispatcher，禁止打包宿主有状态模块。

```ts
export interface ProviderPlugin {
  manifest: { name: string; version: string; coreApi: string };  // coreApi=语义化兼容标记
  activate(ctx: PluginContext): void | Promise<void>;
}

export interface PluginContext {
  config: ConfigService;
  log: FastifyLogger;
  registerTransformer(cls: new () => Transformer): void;          // 参与现有注册表
  registerManagedRuntime(rt: ManagedRuntime): void;               // 受管订阅语义（§2.2）
  registerAdminRoutes(fn: (app: FastifyInstance) => void): void;  // /api/<name>/*
  registerConfigProtector(fn: (next: ConfigProvider[], prev: ConfigProvider[]) => void): void;
  registerUiCard(def: { cardPath: string }): void;                // 插件目录内相对路径
  registerLocales(bundle: Record<"en" | "zh", object>): void;     // 合并进 i18n 命名空间 <name>.*
}

export interface ManagedRuntime {
  name: string;                                    // "codex" —— marker/固定名识别用它
  isManaged(provider: LLMProvider): boolean;       // managed 标记 / 固定 host+transformer / 名字+marker
  prepareRequest(req: {
    provider: LLMProvider;
    config: any;                                   // 可改写 url/headers/dispatcher/redirect
    requestBody: any;                              // body 定稿后才调用（session 头依赖它）
  }): Promise<{ headers?: Record<string, string>; note?: (info: ClassifiedError) => Promise<void> }>;
  classifyError?(status: number, body: unknown, systemText: string): ClassifiedError | null;
  isCooling?(): Promise<boolean>;                  // 出网前熔断（Gemini 教训：transformer 前置）
}
```

> 运行期接口以 `provider-plugins/types.ts` 为准（上面是最初概念草案）。WorkBuddy
> 迁移（2026-10）新增了三个可选成员，`coreApi` 仍为 `"1"`（可选方法不升 major）：
>  - `dispatchRequest?(input: PluginDispatchInput): Promise<Response>` —— 有界多
>    次尝试的 dispatch 包装器。core 把"普通单次尝试"作为 `attempt()` 交给插件；
>    wrapper 只拥有循环（如本地凭据轮换），通用重试/fallback 链留在 core。循环
>    必须有硬上限（≤凭据数且 ≤ 常量上限），client abort 不得吞掉。
>  - `signRequest` 入参新增可选 `config` —— dispatch wrapper 为每次尝试选择的
>    凭据经 config 传给最终头注入；旧 host 不传时插件退回 lockUpstream 存的
>    状态（或 sticky 选择）。
>  - `isErrorEnvelope?(body: unknown): boolean` —— HTTP-200 隐藏错误信封检测。
>    对带 dispatch wrapper 的 runtime 这只是次级保险（wrapper 已返回的 body）；
>    §16 轮换必须在 wrapper 内、响应返回前发生。
> 另：`pluginResponseError`（core 内部）在错误对象上标注 `upstreamStatus`
> （0 = 发送层失败）与 `upstreamErrorName`（AbortError/TimeoutError 区分），
> 供 wrapper 实现大请求 edge-reset 探测等语义；不属于公共接口。

设计要点：
- `prepareRequest` 在 **body 定稿后**调用——Codex 的 `session-id/thread-id` 头要从最终 body 的 `prompt_cache_key` 算（magpie `codexSign(req, body)` 同构），这是现有两条内联分支做不到、泛化后才能做到的事。
- 错误分类从 routes.ts 的 per-provider if 块变为插件自带 `classifyError`；core 只保留通用顺序：**插件分类 → workbuddy/gemini 兼容期保留 → 通用分支**。
- WorkBuddy/Gemini 现有行为**原样保留**（兼容期内不动），新插件必须走接口。迁移第二阶段再把两者搬到插件实现上。

### 2.2 发现与安装

- 安装位置：`$CCR_CONFIG_DIR/plugins/<name>/`（含 `plugin.json` manifest + 预编译入口 `plugin.js` + `card.js`）。
- 事实源：`$CCR_CONFIG_DIR/plugins/plugins.json`（`[{name, enabled}]`）。
- CLI：`ccr plugin add <npm-spec|本地路径>`（npm pack 下载解包 / 直接拷贝）、`ccr plugin list`、`ccr plugin remove`、`ccr plugin enable/disable`。
- 启动加载：core 按 plugins.json 顺序 `await import(entry)`，失败只告警不炸主服务；`/api/plugins` 返回清单（含 UI 卡地址与 locale 包）。
- **不捆绑插件**（§7 已确认）：供应商分别构建为可安装包，主包不静态导入、不以依赖或 bundled-plugins 目录夹带。缺包/禁用时报告 plugin missing，禁止携带 marker api_key 出网；保留 Router 与凭证，重新安装后可恢复。

### 2.3 UI 卡加载

- core 增加静态端点 `GET /plugins/:name/*`（白名单校验后从插件目录读文件，拒绝路径穿越）。
- SettingsPage 供应商区渲染「插件卡区」，从 `/api/plugins` 拿清单，通过 `import(/* @vite-ignore */ cardUrl)` 加载自包含 `mount/unmount` 模块；宿主提供认证 API bridge、locale、disabled 与 busy 回调。迁移完成后不保留两家的静态卡，缺失/加载失败需明确显示。
- 无 JS 卡的插件可以只声明声明式描述（按钮/字段 JSON），由通用渲染器画——MVP 允许只用 JS 卡（三个订阅 provider 都需要富交互）。

### 2.4 安全边界（红线继承）

- 插件代码 = 本机任意代码执行，与 magpie 相同的信任模型：`plugin add` 时打印「即将安装与启用 <name>@<ver>，其代码将以你的用户权限运行」并要求确认。
- core 对插件只有接口约束，不做沙箱（Node 生态现实）；官方插件与主包同仓同审。
- 令牌红线不变：凭证只在 `$CCR_CONFIG_DIR/<name>-credentials.json`（0600），不进 config/日志/响应。

---

## 3. 分阶段交付（对齐用户的 OPEN-PR 流程）

| 阶段 | 内容 | 交付物 |
|---|---|---|
| **P1-A 插件系统** | core API、加载器、宿主能力、数据面接缝、`/api/plugins`、动态卡区 | 分支 `feat/provider-plugins` |
| **P1-B/C 双迁移** | Gemini 先作为样板，接着迁 WorkBuddy；均为独立包，不捆绑 | P1 内完成两家迁移 |
| **P1-D 安装与体积验收** | `ccr plugin add/list/remove/enable/disable`、包布局、缺插件明确报错、主包不含两家实现与供应商专属依赖的检查 | 构建/tarball 实测，升级迁移说明 |
| **P1-E 审查交付** | 全量验证、独立审查、自动审查跟进 | PR OPEN，不自动合并/发布 |
| **P2 Codex 插件** | §5，首个新增的独立供应商插件，仅浏览器授权 | 依赖 P1 验证通过，独立 PR |

> 代码硬切不等于发布：用户数据和在线服务保持不动，合并、版本号与发布仍须明确授权。体积以同条件 tarball/产物实测，不以源码行数估算宣称达标。

---

## 4. 各阶段验收

- P1：Gemini/WorkBuddy 插件装、卸、禁用全链可用；迁移前后的 core+UI+插件用例行为等价。缺插件时 UI 与数据面明确报 plugin missing，不静默删除配置/Router/凭证，不拿 marker key 出网。
- tsc：保留无关历史诊断；按文件/错误码/内容对比准确基线，不只比总行数。插件包自身 tsc/build 必须通过。
- 包级集成：独立构建产物在临时目录安装后，验证动态加载→transformer 注册→admin 路由→请求数据面；不得只测 registry 孤立函数。
- P2 Codex：见 §5 验收清单。
- 通用：每个 PR 独立 review；主包版本号按 semver 纪律小步走。

---

## 5. Codex 插件规格（调研结论收敛，全部一手）

### 5.1 认证（OAuth = 官方 Codex CLI 身份）

- authorize `https://auth.openai.com/oauth/authorize`；client_id `app_EMoamEEZ73f0CkXaXp7hrann`（官方 CLI 内置公开值，env 可覆盖）；scopes `openid profile email offline_access api.connectors.read api.connectors.invoke`；PKCE S256；`originator=codex_cli_rs`；`codex_cli_simplified_flow=true`。
- **回调端口被 OpenAI 白名单钉死 1455**（官方兜底 1457）：CCR 监听 `127.0.0.1:1455`，占用时先 `GET /cancel` 清理残留的官方 `codex login` 监听（magpie 同款），仍失败→降级「粘贴回调 URL」模式。
- token 端点 `https://auth.openai.com/oauth/token`：**登录用 form 编码，刷新用 JSON body**（scope 缩为 `openid profile email`）——照抄，别混。
- 存储 = 官方 auth.json 形状（`{auth_mode:"chatgpt", tokens:{id_token,access_token,refresh_token,account_id}, last_refresh}`）存 0600 的 `codex-credentials.json`；过期从 access_token(JWT) `exp` 现算；**account_id/plan 取自 id_token 的 `https://api.openai.com/auth` claim**（`chatgpt_account_id`/`chatgpt_plan_type`），plan 透传不硬编码等级表。
- **刷新纪律（magpie 血泪三条）**：① 刷新一经发出必须等完并持久化（调用方取消也不能丢轮换结果——CCR 现有「先持久化再切内存」已对齐，保持）；② 5 分钟提前量之外，上游返回「要求刷新」的 401 时触发一次并发合并的强制刷新（官方 issue #2973 实锤）；③ 同一 refresh token 全机只允许一个刷新者——UI 明示「启用后官方 Codex CLI 的登录将由 CCR 接管刷新」。
- **导入官方登录**：从 `~/.codex/auth.json` 导入 = 「导入即接管」（刷新会使源工具掉线，OpenAI 轮换 token），UI 必须明示；不做「只读借用」（rotation 语义不允许）。

### 5.2 数据面（= Responses API + 伪装成 Codex CLI 的头 + 无状态 body 补丁）

- 端点 `POST https://chatgpt.com/backend-api/codex/responses`；**复用内置 `openai-responses` transformer 做双向转换**（出站方向已存在），另做 ~100 行 `codexFinalizeBody` 终整器：`store:false`、`stream:true`、`tool_choice:"auto"`、`parallel_tool_calls` 默认 true、`text.verbosity` 缺省、`include:["reasoning.encrypted_content"]`、`reasoning.summary:"auto"`、**system→developer**（后端拒绝 system role）、call_id>64 sha256、孤儿 function_call_output 改写、删采样类字段（temperature/top_p/max_tokens/prompt_cache_options…）、`prompt_cache_key` 缺省时按会话哈希现算。
- **头全集**（缺一不可）：`Authorization: Bearer`、`chatgpt-account-id`、`OpenAI-Beta: responses=experimental`、`originator: codex_cli_rs`、`version` + `User-Agent: codex_cli_rs/<ver> (<os>; <arch>)`（**UA 版本决定新模型可见性**，内置足够新的常量如 `0.159.0+`）、`Accept: text/event-stream`、**`session-id`/`thread-id` = body 的 `prompt_cache_key`**（prompt 缓存命中的关键，必须 body 定稿后注入——这就是插件接口 `prepareRequest` 在 body 定稿后调用的原因）。
- SSE：`response.*` 事件族 + 顶层 `error` / `response.failed` 必须终止冒泡；`codex.rate_limits` 事件（回复前 64KB 内）+ `x-codex-primary/secondary-*` 头双通道读配额 → provider-health 冷却；`usage_limit_reached` + `resets_at` → 配额冷却分类。
- 模型：登录后 `GET /backend-api/codex/models?client_version=<ver>`，过滤 `visibility==="hide"`、按 priority 排序写回 provider.models；**响应携带每模型 `base_instructions`/`instructions_template` 必须缓存**——终整器要用它替换 `instructions`（客户端自己的 instructions 前置为 developer 消息）。无静态模型表（上游加新模型即失效），兜底用用户手填。
- 不做（MVP）：多账号池、重置卡（wham credits）、autoreset、zstd 压缩（超大 turn 才需要，二阶段）、WebSocket。

### 5.3 风险定位

官方 client 直连路径，**无 Antigravity 式红色横幅**；但按 magpie 维护者口径给「不能保证不判定违规」的普通免责文案；若未来提供 UA/instructions 定制开关，必须强制风险提示（那是主要风控信号面）。UI 卡定位为「实验性」档。

### 5.4 验收（P2 Codex）

- v1 仅浏览器授权全链（1455 占用→paste 降级）；不提供导入 `~/.codex/auth.json`，不接管官方 CLI 凭证。真实账号冒烟：流式回复、prompt 缓存命中、模型列表按 plan 拉取；未做真机验证则如实标注。
- 刷新三纪律各有测试；401-要求刷新、`usage_limit_reached`、流内 error 事件三类错误分类；mutation-verified。
- 全量 core/UI 绿 + 独立对抗审查（令牌零泄漏 / 其他 provider 不变 / 插件卸载行为）。

---

## 6. 风险与开放问题

1. **插件 API 是公共契约**：一旦有第三方写插件就难改。缓解：`coreApi` 语义化标记 + 官方插件先行一个版本周期再开放文档。
2. **UI 动态 import**：打包器需配 `webpackIgnore`/等价指令；dev 模式与 prod 行为都要验证。
3. **迁移期双轨**：兼容期内 workbuddy/gemini 的内联分支与插件实现并存，容易漂移——P2 完成后立即删内联分支，不留长双轨。
4. **Windows 路径/权限**：0600 语义在 Windows 上弱化（既有 WorkBuddy 同款问题，不新增）。

---

## 7. 已确认决策（替代原建议，作为实施依据）

1. **直接硬切外部安装**：不捆绑过渡；主包只提供路由与通用插件能力，订阅供应商按需安装。安装/启用/重启须显式执行，迁移开发不修改真实环境。
2. **P1 一次迁两家**：Gemini 先完成样板，随后 WorkBuddy；两家都迁出且独立产物验证通过才算 P1 完成。
3. **Codex v1 只浏览器授权**：保留回调降级路径，不导入、不接管官方 CLI 登录。调研里的凭证共管仅作参考，不是本次授权范围。
