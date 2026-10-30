![](blog/images/claude-code-router-img.png)

**[🇨🇳 中文文档](README.md)**  |  **[🇬🇧 English](README_en.md)**  |  [![npm version](https://badge.fury.io/js/@wengine-ai_claude-code-router-next.svg)](https://www.npmjs.com/package/@wengine-ai/claude-code-router-next)

> **说明**：本项目 fork 自 [claude-code-router](https://github.com/musistudio/claude-code-router)（2026-05 建仓，当时上游自 2026-01-04 起已 4 个月未发版、自 2026-03-04 起无提交；上游其后已恢复活跃）。本项目持续维护自己的发布线，并在其基础上开发按项目路由、多客户端接管、ZCode 支持等特性。

<hr>

> [从CLI工具风格看工具渐进式披露](/blog/zh/从CLI工具风格看工具渐进式披露.md)

> 一款强大的工具，可将 Claude Code 和 Codex 请求路由到不同的模型，并自定义任何请求。 

![](blog/images/claude-code.png)


## ✨ 功能

-   **模型路由**: 根据您的需求将请求路由到不同的模型（例如，后台任务、思考、长上下文）。
-   **多提供商支持**: 支持 OpenRouter、DeepSeek、Ollama、Gemini、Volcengine 和 SiliconFlow 等各种模型提供商。
-   **Codex CLI 支持**: 通过 Responses API 协议转换，支持 Codex CLI 接入任意 LLM 提供商（Anthropic、DeepSeek、GLM 等），实现工具调用、文件修改等完整功能。
-   **请求/响应转换**: 使用转换器为不同的提供商自定义请求和响应。
-   **动态模型切换**: 在 Claude Code 中使用 `/model` 命令动态切换模型。
-   **GitHub Actions 集成**: 在您的 GitHub 工作流程中触发 Claude Code 任务。
-   **用量统计与限额监控**: 追踪请求的 Token 数、缓存命中率、首 Token 延迟 (TTFT) 和生成速度，并实时展示主流服务商（如智谱、Qwen 等）的限额使用情况。
-   **插件系统**: 使用自定义转换器扩展功能。

## 🚀 快速入门

### 1. 安装

您可以从 npm 官方仓库安装 Claude Code Router，或者直接从本 GitHub 仓库安装以获取最新的开发版本。

#### 选项 A：从 npm 官方仓库安装（稳定版）

首先，请确保您已安装 [Claude Code](https://docs.anthropic.com/en/docs/claude-code/quickstart)：

```shell
npm install -g @anthropic-ai/claude-code
```

然后，安装 Claude Code Router：

```shell
npm install -g @wengine-ai/claude-code-router-next
```

#### 选项 B：从 GitHub 安装（最新开发版）

如果您想直接使用源码中的最新功能和修复：

1. **先卸载已安装的全局版本**（以避免指令冲突）：
   ```shell
   npm uninstall -g @wengine-ai/claude-code-router-next @musistudio/claude-code-router @wengine-ai/claude-code-router
   ```

2. **克隆本仓库并在本地进行 Link**（推荐开发者使用）：
   ```shell
   git clone https://github.com/xiaoliu10/claude-code-router-next.git
   cd claude-code-router-next
   pnpm install
   pnpm build
   npm link
   ```

   *或者直接从 GitHub 进行全局安装：*
   ```shell
   npm install -g github:xiaoliu10/claude-code-router-next
   ```

#### 🔄 从官方原版社区版迁移 (@musistudio/claude-code-router)

如果您当前正在使用官方原版社区版本 `@musistudio/claude-code-router` 或之前的版本 `@wengine-ai/claude-code-router`，希望切换到 `@wengine-ai/claude-code-router-next`：

1. **先卸载旧版本**：
   ```shell
   npm uninstall -g @musistudio/claude-code-router @wengine-ai/claude-code-router
   ```

2. **安装本仓库增强版本**：
   ```shell
   npm install -g @wengine-ai/claude-code-router-next
   ```

> **说明**：卸载旧包**不会影响**您已有的配置文件 `~/.claude-code-router/config.json`，新版本会自动读取原有配置。

### 升级

```shell
npm install -g @wengine-ai/claude-code-router-next@latest && ccr restart
```

### 📅 升级功能列表 (Changelog)

| 版本 | 发布内容 |
| --- | --- |
| **v2.3.2417** | <ul><li>**空回复现在会重试并降级**：上游返回 200 且 `content` 为空时不再被记成成功，改为触发同模型重试与 fallback；判据是 content 集合为空（tool_use-only 等合法回合不受影响），探测有字节与时间上限，慢速流不丢字节；Codex 侧同样拦住空 `response.completed`。</li><li>**流式回合不再记录 `output_tokens: 0`**：普通流式请求此前没有 usage 读取器，健康回复被记成全零且无 TTFT；现从 tee 分支采集并按流序合并。</li><li>**不健康 provider 从模型列表降级剔除**：熔断模型对所有 provider 类型生效隐藏，恢复后自动放回；订阅类 provider 新增两级后台探活（先查账号状态，再发真实最小请求），不再依赖真实请求反复撞死账号。</li></ul> |
| **v2.3.2415** | <ul><li>**新增 Qoder 订阅 provider（qoder.com + qoder.cn）**: 同一插件同引擎支持国际站与国内站 PAT 订阅，双 managed provider + 卡片双区块（中英双语）；含整配置写串行化、401 单次刷新重放、每帧 1MiB 上限等健壮性修复。</li><li>**修复 WorkBuddy 6004 重置时间戳时区**: 测试改用 Asia/Shanghai 渲染，UTC CI 不再挂。</li><li>**修复 tool_result 图片按 base64 文本发送**: 图片改为视觉块发送，避免 200 万+ token 膨胀与上游拒绝。</li></ul> |
| **v2.3.2414** | <ul><li>**CCR Desktop（可选 Tauri 客户端）与 Pi 配置生命周期修复**: 新增可选 Tauri 桌面壳（托盘快速切换全局默认模型、quota 摘要、单实例；生命周期伴侣化、退出不杀 gateway）；修复 `ccr restart` 的 disable→enable 与 legacy 项目 provider 改名迁移丢失 Pi 自定义模型字段（thinkingLevelMap/modelOverrides）。</li></ul> |
| **v2.3.2413** | <ul><li>**修复 TTFT 永久为空**: #65（pi 会话粘连）与 #67（temp-file 重写）合并冲突解决时丢失了 #65 的 \`statsKey\` 文件名优先逻辑，handler 用会话 UUID 命名临时文件而 reader 用 requestId 查找 → 永久不匹配 → 所有流式请求的 TTFT 都是 null、tokens_per_second 退化为按完整时长重算。修复后 handler 优先用 \`metadata.statsKey\` 命名文件（对齐 reader），TTFT 与真实速度恢复。</li></ul> |
| **v2.3.2412** | <ul><li>**修复用量/套餐接口在 node 版本不匹配时全部失效**: 当运行时 Node 的 ABI 与安装 better-sqlite3 时不同（如桌面应用注入自带 node），`ERR_DLOPEN_FAILED` 导致 `/api/usage*`、`/api/providers/quota` 全部 500，UI 用量页与套餐限额条消失。现在优先加载 better-sqlite3，加载失败自动回退 Node 内置 `node:sqlite`（Node ≥ 22.5），任意 node 版本下均可工作；CLI statusline 同步受益；回退时输出一次性显眼日志。</li><li>**修复 pi 模型条目自定义字段被刷新抹除**: `ensurePiCcrProvider` 此前整组替换 `models[]`，pi 的 `thinkingLevelMap` 等条目级自定义字段每次 CCR 启动/项目接管都被静默清掉（#69）。现在模型集合仍由 CCR 管理，但每个生成条目按同 id 与旧条目合并——受管字段以 CCR 为准，条目级自定义字段跨刷新保留。</li></ul> |
| **v2.3.2411** | <ul><li>**AMD Radeon Cloud 转换器**: 新增 `amd` 转换器：统一 reasoning 意图按目标模型族映射为 AMD 端点支持的 `reasoning_effort` 档位（GLM/Qwen/DeepSeek 分别适配，禁用拼写正确透传），响应侧把 `reasoning` 内容提升为 `thinking`（含 SSE 误标 JSON 边界处理）；推荐 provider 链 `use:["OpenAI","amd"]`。</li><li>**Pi 会话粘连**: 识别 `x-session-affinity` 等会话标识头生成稳定会话 ID：并发优先模式的会话槽位跨请求稳定粘附，token-speed 统计与用量记录按稳定会话 ID 分组，兼容 LiteLLM `x-litellm-session-id`，接管刷新后自动写入 pi 配置。</li><li>**修复 token-speed 临时文件堆积导致服务卡死**: 修复按请求写时间戳临时文件且永不清理的问题（单机曾累积 323 万文件，每次请求全目录扫描阻塞事件循环约 33 秒）。写入改为精确文件名原子覆盖并迁移到 `token-speed-v2` 子目录（新旧版本可并存），读取 O(1)；新增默认 1 小时保留期自动清理；升级后服务启动自愈，仅清理旧目录中文件名时间戳与修改时间均超过 1 小时的历史文件，不触碰用量库与配置。</li></ul> |
| **v2.3.2410** | <ul><li>**并发优先模式开关移至通用配置**: 开关从 Router 配置区移到全局设置页「通用配置」区（「去除 Claude Code Attribution 动态头」下方），作为全局开关；配置仍存于 Router 节点，项目 Router 可通过 JSON 覆盖；项目级编辑器不再展示该开关。</li></ul> |
| **v2.3.2409** | <ul><li>**并发优先模式（会话粘连 + 场景级溢出分流）**: 多项目共用一个 CCR 实例时，大量并发打到同一个模型会导致排队变慢。新增 `Router.enableConcurrencyPriority`（默认关闭）与 `Router.concurrencyThreshold`（默认 3），叠加在现有路由结果之上：路由选中模型（default/think/longContext/extendedContext/webSearch/image/background/模型族默认值）在途并发达到阈值后，新会话直接分流到该场景 fallback 列表（模型族优先于全局）中负载最低的健康模型；会话按槽位（session+模型族+场景）粘连首配模型保持 prompt 缓存命中，仅报错走 fallback 成功才切换；`provider,model` 显式路由与 `&lt;CCR-SUBAGENT-MODEL&gt;` 子代理覆盖不受影响。UI 全局设置页「通用配置」新增「并发优先模式」全局开关与阈值（中英文）。</li></ul> |
| **v2.3.2408** | <ul><li>**Pi 项目 provider 自动换成可读名**: 2.3.2405 之前接管的项目仍是 `ccr-project-&lt;hash&gt;` 旧名且刷新不迁移；现在自动改为 `ccr-project-&lt;项目名&gt;-&lt;hash&gt;` 并删除孤儿条目，关闭接管也能清掉旧名。</li><li>**修复测试数据污染真实用量库**: 测试写的假请求（demo/global/project 等）此前会写进真实 `usage.sqlite`，已隔离；历史假记录已提供清理方案。</li><li>**npm 包页面补上仓库链接**（repository/homepage/bugs 与作者信息）。</li></ul> |
| **v2.3.2407** | <ul><li>**ZCode 会话发现器**: ZCode 请求不带任何项目标识，项目级 Router 对 ZCode 无效；现在按会话回查 ZCode 本地任务索引（`~/.zcode/v2/tasks-index.sqlite`，会话 JSON 的 `meta.workspacePath` 兜底）得到运行目录并映射到项目 id，`ccr model --project`/UI 配置的项目 Router 对 ZCode 生效；索引晚写有一次短重试，异常一律退化为全局 Router。</li><li>**ZCode 项目接管开关（opt-in）**: 项目「接管的客户端」下拉新增 ZCode，且接管状态就是路由开关——只有勾选 ZCode 的项目走项目 Router，未勾选的项目保持全局 Router，避免会话发现把个人项目改道到项目/公司模型。ZCode 无可写的项目级配置文件，标记记录在 `~/.claude-code-router/<project-id>/takeover-clients.json`，取消勾选或删除项目时清除。</li></ul> |
| **v2.3.2406** | <ul><li>**默认思考等级支持自定义值**: 除枚举外可填 token 预算或供应商私有字符串（如 `minimal`/`off`）；数字在 Anthropic 端点按精确预算注入、OpenAI 系端点折叠为最接近档位，非枚举字符串在 OpenAI 系端点原样透传、Anthropic 端点按别名归一（min/minimal/light→low、xhigh/maximum/ultra→max）；UI 新增「自定义」自由输入。</li><li>**思考深度按 effort 下发**: `convertToAnthropic` 现在同时下发 `output_config.effort`（当前 Anthropic 模型与 GLM 等兼容端点真正读取的字段），`thinking.budget_tokens` 保留以兼容旧模型与中转；客户端原始 effort 不再被丢弃、`thinking.type=adaptive` 不再被误判为关闭思考、预算不再被四舍五入到档位。</li><li>**ZCode 独立客户端归属**: 此前 ZCode 用 `ccr-*` 别名 + Claude Code 兼容 metadata 调用，日志一律记为 claude-code；现按请求头（`User-Agent: ZCode/…`、`X-ZCode-*`）识别并单独计入用量。</li><li>**release.sh 发布中断可续跑**: 重跑自动跳过已发布的包，只发剩余包。</li></ul> |
| **v2.3.2405** | <ul><li>**供应商级默认思考等级**: 客户端未携带思考配置时按供应商配置的默认等级注入，并按端点类型自动转义——Anthropic `/v1/messages` → `thinking.budget_tokens`、OpenAI `/v1/responses` → `reasoning.effort`、OpenAI 兼容 chat → `reasoning_effort`；客户端显式设置始终优先。附带修复客户端显式 thinking 在 Anthropic 端点被丢弃的问题。</li><li>**预置自引用 `ccr` 供应商（免接管）**: ZCode 等自配端点客户端不再需要接管——CCR 启动/保存配置时自动确保存在指向自身的 `ccr` 供应商（ccr-opus/sonnet/haiku）；删除后记 tombstone 不复活。</li><li>**pi 项目 provider 命名可读化**: `ccr-project-<hash>` → `ccr-project-<项目名>-<hash>`，旧格式无需迁移。</li></ul> |

> 仅保留最近 10 个版本，更早版本的发布摘要见 [CHANGELOG-archive.md](./CHANGELOG-archive.md)，完整详细变更记录见 [CHANGELOG.md](./CHANGELOG.md)。

### 2. 配置

创建并配置您的 `~/.claude-code-router/config.json` 文件。有关更多详细信息，您可以参考 `config.example.json`。

> [!IMPORTANT]
> **重要提示**：手动修改 `config.json` 配置文件（如更新 API Key、百炼 Cookie 等）后，**必须重启后台服务才能使新配置生效**。请在保存文件后，在终端运行以下命令：
> ```shell
> ccr restart
> ```

`config.json` 文件有几个关键部分：
- **`PROXY_URL`** (可选): 您可以为 API 请求设置代理，例如：`"PROXY_URL": "http://127.0.0.1:7890"`。CCR 进程自身通过此地址连接代理端口，无需开启系统代理、TUN 或代理软件的全局模式。
- **`PROXY_GLOBAL_ENABLED`** (可选): 控制代理的作用范围。未配置或设为 `true`（默认）时，所有 provider 的出站请求均走代理，保持与旧配置的兼容性。设为 `false` 时，仅标记了 `proxy_enabled: true` 的 provider 走代理，其余 provider 直连。所有 provider 共用顶层 `PROXY_URL`，不支持为每个 provider 单独设置代理地址。如果 `PROXY_URL` 未设置（空地址），则所有代理开关均不生效，全部直连。provider 专属的出站请求（推理、fallback、健康探测、额度查询、wakeup 唤醒、provider API tokenizer 等）均遵循同一 provider 代理策略。
  > [!WARNING]
  > 代理可看到 API key 和请求内容，请仅配置可信代理。
- **`LOG`** (可选): 您可以通过将其设置为 `true` 来启用日志记录。当设置为 `false` 时，将不会创建日志文件。默认值为 `true`。
- **`LOG_LEVEL`** (可选): 设置日志级别。可用选项包括：`"fatal"`、`"error"`、`"warn"`、`"info"`、`"debug"`、`"trace"`。默认值为 `"error"`；仅在显式配置为 `"info"`、`"debug"` 或 `"trace"` 时输出详细日志。
- **日志系统**: Claude Code Router 使用两个独立的日志系统：
  - **服务器级别日志**: HTTP 请求、API 调用和服务器事件使用 pino 记录在 `~/.claude-code-router/logs/` 目录中，文件名类似于 `ccr-*.log`
  - **应用程序级别日志**: 路由决策和业务逻辑事件记录在 `~/.claude-code-router/claude-code-router.log` 文件中
- **`APIKEY`** (可选): 您可以设置一个密钥来进行身份验证。设置后，客户端请求必须在 `Authorization` 请求头 (例如, `Bearer your-secret-key`) 或 `x-api-key` 请求头中提供此密钥。例如：`"APIKEY": "your-secret-key"`。
- **`HOST`** (可选): 您可以设置服务的主机地址。如果未设置 `APIKEY`，出于安全考虑，主机地址将强制设置为 `127.0.0.1`，以防止未经授权的访问。例如：`"HOST": "0.0.0.0"`。
- **`NON_INTERACTIVE_MODE`** (可选): 当设置为 `true` 时，启用与非交互式环境（如 GitHub Actions、Docker 容器或其他 CI/CD 系统）的兼容性。这会设置适当的环境变量（`CI=true`、`FORCE_COLOR=0` 等）并配置 stdin 处理，以防止进程在自动化环境中挂起。例如：`"NON_INTERACTIVE_MODE": true`。
- **`Providers`**: 用于配置不同的模型提供商。
- **`Router`**: 用于设置路由规则。`default` 指定默认模型，如果未配置其他路由，则该模型将用于所有请求。
- **`API_TIMEOUT_MS`**: API 请求超时时间，单位为毫秒。

这是一个综合示例：

```json
{
  "APIKEY": "your-secret-key",
  "PROXY_URL": "http://127.0.0.1:7890",
  "PROXY_GLOBAL_ENABLED": false,
  "LOG": true,
  "LOG_LEVEL": "error",
  "API_TIMEOUT_MS": 600000,
  "NON_INTERACTIVE_MODE": false,
  "Providers": [
    {
      "name": "openrouter",
      "api_base_url": "https://openrouter.ai/api/v1/chat/completions",
      "api_key": "sk-xxx",
      "models": [
        "google/gemini-2.5-pro-preview",
        "anthropic/claude-sonnet-4",
        "anthropic/claude-3.5-sonnet",
        "anthropic/claude-3.7-sonnet:thinking"
      ],
      "transformer": {
        "use": ["openrouter"]
      },
      "proxy_enabled": true
    },
    {
      "name": "deepseek",
      "api_base_url": "https://api.deepseek.com/chat/completions",
      "api_key": "sk-xxx",
      "models": ["deepseek-chat", "deepseek-reasoner"],
      "transformer": {
        "use": ["deepseek"],
        "deepseek-chat": {
          "use": ["tooluse"]
        }
      }
    },
    {
      "name": "ollama",
      "api_base_url": "http://localhost:11434/v1/chat/completions",
      "api_key": "ollama",
      "models": ["qwen2.5-coder:latest"]
    },
    {
      "name": "gemini",
      "api_base_url": "https://generativelanguage.googleapis.com/v1beta/models/",
      "api_key": "sk-xxx",
      "models": ["gemini-2.5-flash", "gemini-2.5-pro"],
      "transformer": {
        "use": ["gemini"]
      }
    },
    {
      "name": "volcengine",
      "api_base_url": "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
      "api_key": "sk-xxx",
      "models": ["deepseek-v3-250324", "deepseek-r1-250528"],
      "transformer": {
        "use": ["deepseek"]
      }
    },
    {
      "name": "modelscope",
      "api_base_url": "https://api-inference.modelscope.cn/v1/chat/completions",
      "api_key": "",
      "models": ["Qwen/Qwen3-Coder-480B-A35B-Instruct", "Qwen/Qwen3-235B-A22B-Thinking-2507"],
      "transformer": {
        "use": [
          [
            "maxtoken",
            {
              "max_tokens": 65536
            }
          ],
          "enhancetool"
        ],
        "Qwen/Qwen3-235B-A22B-Thinking-2507": {
          "use": ["reasoning"]
        }
      }
    },
    {
      "name": "dashscope",
      "api_base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
      "api_key": "",
      "models": ["qwen3-coder-plus"],
      "transformer": {
        "use": [
          [
            "maxtoken",
            {
              "max_tokens": 65536
            }
          ],
          "enhancetool"
        ]
      }
    },
    {
      "name": "aihubmix",
      "api_base_url": "https://aihubmix.com/v1/chat/completions",
      "api_key": "sk-",
      "models": [
        "Z/glm-4.5",
        "claude-opus-4-20250514",
        "gemini-2.5-pro"
      ]
    }
  ],
  "Router": {
    "default": "deepseek,deepseek-chat",
    "background": "ollama,qwen2.5-coder:latest",
    "think": "deepseek,deepseek-reasoner",
    "longContext": "openrouter,google/gemini-2.5-pro-preview",
    "longContextThreshold": 60000,
    "webSearch": "gemini,gemini-2.5-flash"
  }
}
```

### 🔑 阿里云百炼用量 Token (Cookie) 获取引导

如果您想让 Claude Code Router 的后台 Web UI 实时拉取并可视化展示您的 **Qwen Coding Plan（Qwen 编程时限套餐）** 剩余用量额度条，您需要获取控制台的浏览器 `Cookie` 作为 `quotaToken` 填入配置：

1. 登录 [阿里云百炼控制台](https://bailian.console.aliyun.com/)。
2. 按键盘 `F12` 打开浏览器开发者工具，并切换到 **Network (网络)** 标签页。
3. 点击页面用量模块右上角的 **用量刷新**（旋转循环箭头）按钮。
4. 在左侧网络请求列表中，找到一个以 `api.json?action=BroadScope...` 开头的接口调用请求并点击。
5. 在右侧 **Headers (标头)** 的 **Request Headers (请求头)** 中找到 **`Cookie`** 这一项，将其右侧的完整超长内容复制下来。
6. 在您的 `config.json` 中，将这个 cookie 填入阿里云 provider 下的 **`quotaToken`** 属性中即可！

配置成功后，Web UI 的 Provider 列表中将会实时展示您的套餐剩余用量额度条与刷新状态：

![阿里云用量 Cookie 获取方式](blog/images/aliyun-quota-auth.png)

![阿里云用量额度条展示](blog/images/aliyun-quota-display.png)

### 🔑 讯飞 Coding Plan 用量 Token (Cookie) 获取引导

如果您想让 Claude Code Router 的后台 Web UI 实时拉取并可视化展示您的 **讯飞 Coding Plan** 剩余用量额度条，您需要进入讯飞 Coding Plan 订阅查询页面，打开浏览器开发者工具的 Network 面板，刷新页面后复制请求中的 `Cookie` 作为 `quotaToken` 填入配置：

1. 登录讯飞 Coding Plan 订阅查询页面。
2. 按键盘 `F12` 打开浏览器开发者工具，并切换到 **Network (网络)** 标签页。
3. 刷新页面。
4. 在左侧网络请求列表中，找到订阅查询页面对应的用量查询请求并点击。
5. 在右侧 **Headers (标头)** 的 **Request Headers (请求头)** 中找到 **`Cookie`** 这一项，将其右侧的完整内容复制下来。
6. 在您的 `config.json` 中，将这个 cookie 填入讯飞 provider 下的 **`quotaToken`** 属性中，或者粘贴到 UI 的 **限额查询 Token** 输入框中即可。

> **注意**: 这个 token 不是长期有效的，可能会过期；过期后需要重新手动添加。

### 3. 使用 Router 运行 Claude Code

使用 router 启动 Claude Code：

```shell
ccr code
```

> **注意**: 修改配置文件后，需要重启服务使配置生效：
> ```shell
> ccr restart
> ```

### 4. UI 模式

为了获得更直观的体验，您可以使用 UI 模式来管理您的配置：

```shell
ccr ui
```

这将打开一个基于 Web 的界面，您可以在其中轻松查看和编辑您的 `config.json` 文件。

![UI](/blog/images/ui.png)

#### 用量统计

仪表盘在主页面底部内置了**用量统计**面板。当您的请求通过 Claude Code Router 进行路由时，系统会自动收集用量记录并在 UI 界面中展示。

您可以使用它来查看：

- 总请求数
- 输入和输出 Token 数
- 平均首 Token 延迟 (TTFT)
- 平均生成速度 (Tokens/秒)
- 请求成功率
- 每日用量图表
- 支持筛选和分页的详细请求历史记录

![用量统计](/blog/images/usage-statistics.png)

如何使用：

1. 使用 `ccr start` 启动路由器服务
2. 使用 `ccr ui` 打开 Web 界面
3. 通过 Claude Code Router 发送请求（例如使用 `ccr code`）
4. 返回主仪表盘，查看**用量统计**面板

用量数据保存在：

```shell
~/.claude-code-router/data/usage.jsonl
```

### 5. CLI 模型管理

对于偏好终端工作流的用户，可以使用交互式 CLI 模型选择器：

```shell
ccr model
```

该命令提供交互式界面来：

- 查看当前配置
- 查看所有配置的模型（default、background、think、longContext、webSearch、image）
- 切换模型：快速更改每个路由器类型使用的模型
- 添加新模型：向现有提供商添加模型
- 创建新提供商：设置完整的提供商配置，包括：
   - 提供商名称和 API 端点
   - API 密钥
   - 可用模型
   - Transformer 配置，支持：
     - 多个转换器（openrouter、deepseek、gemini 等）
     - Transformer 选项（例如，带自定义限制的 maxtoken）
     - 特定于提供商的路由（例如，OpenRouter 提供商偏好）

CLI 工具验证所有输入并提供有用的提示来引导您完成配置过程，使管理复杂的设置变得容易，无需手动编辑 JSON 文件。

### 6. 预设管理

预设允许您轻松保存、共享和重用配置。您可以将当前配置导出为预设，并从文件或 URL 安装预设。

```shell
# 将当前配置导出为预设
ccr preset export my-preset

# 使用元数据导出
ccr preset export my-preset --description "我的 OpenAI 配置" --author "您的名字" --tags "openai,生产环境"

# 从本地目录安装预设
ccr preset install /path/to/preset

# 列出所有已安装的预设
ccr preset list

# 显示预设信息
ccr preset info my-preset

# 删除预设
ccr preset delete my-preset
```

**预设功能：**
- **导出**：将当前配置保存为预设目录（包含 manifest.json）
- **安装**：从本地目录安装预设
- **敏感数据处理**：导出期间自动清理 API 密钥和其他敏感数据（标记为 `{{field}}` 占位符）
- **动态配置**：预设可以包含输入架构，用于在安装期间收集所需信息
- **版本控制**：每个预设包含版本元数据，用于跟踪更新

**预设文件结构：**
```
~/.claude-code-router/presets/
├── my-preset/
│   └── manifest.json    # 包含配置和元数据
```

### 7. Activate 命令（环境变量设置）

`activate` 命令允许您在 shell 中全局设置环境变量，使您能够直接使用 `claude` 命令或将 Claude Code Router 与使用 Agent SDK 构建的应用程序集成。

要激活环境变量，请运行：

```shell
eval "$(ccr activate)"
```

此命令会以 shell 友好的格式输出必要的环境变量，这些变量将在当前的 shell 会话中设置。激活后，您可以：

- **直接使用 `claude` 命令**：无需使用 `ccr code` 即可运行 `claude` 命令。`claude` 命令将自动通过 Claude Code Router 路由请求。
- **与 Agent SDK 应用程序集成**：使用 Anthropic Agent SDK 构建的应用程序将自动使用配置的路由器和模型。

`activate` 命令设置以下环境变量：

- `ANTHROPIC_AUTH_TOKEN`: 来自配置的 API 密钥
- `ANTHROPIC_BASE_URL`: 本地路由器端点（默认：`http://127.0.0.1:3456`）
- `NO_PROXY`: 设置为 `127.0.0.1` 以防止代理干扰
- `DISABLE_TELEMETRY`: 禁用遥测
- `DISABLE_COST_WARNINGS`: 禁用成本警告
- `API_TIMEOUT_MS`: 来自配置的 API 超时时间

> **注意**：在使用激活的环境变量之前，请确保 Claude Code Router 服务正在运行（`ccr start`）。环境变量仅在当前 shell 会话中有效。要使其持久化，您可以将 `eval "$(ccr activate)"` 添加到您的 shell 配置文件（例如 `~/.zshrc` 或 `~/.bashrc`）中。

#### Providers

`Providers` 数组是您定义要使用的不同模型提供商的地方。每个提供商对象都需要：

-   `name`: 提供商的唯一名称。
-   `api_base_url`: 聊天补全的完整 API 端点。
-   `api_key`: 您提供商的 API 密钥。
-   `models`: 此提供商可用的模型名称列表。
-   `transformer` (可选): 指定用于处理请求和响应的转换器。

#### Transformers

Transformers 允许您修改请求和响应负载，以确保与不同提供商 API 的兼容性。

-   **全局 Transformer**: 将转换器应用于提供商的所有模型。在此示例中，`openrouter` 转换器将应用于 `openrouter` 提供商下的所有模型。
    ```json
     {
       "name": "openrouter",
       "api_base_url": "https://openrouter.ai/api/v1/chat/completions",
       "api_key": "sk-xxx",
       "models": [
         "google/gemini-2.5-pro-preview",
         "anthropic/claude-sonnet-4",
         "anthropic/claude-3.5-sonnet"
       ],
       "transformer": { "use": ["openrouter"] }
     }
    ```
-   **特定于模型的 Transformer**: 将转换器应用于特定模型。在此示例中，`deepseek` 转换器应用于所有模型，而额外的 `tooluse` 转换器仅应用于 `deepseek-chat` 模型。
    ```json
     {
       "name": "deepseek",
       "api_base_url": "https://api.deepseek.com/chat/completions",
       "api_key": "sk-xxx",
       "models": ["deepseek-chat", "deepseek-reasoner"],
       "transformer": {
         "use": ["deepseek"],
         "deepseek-chat": { "use": ["tooluse"] }
       }
     }
    ```

-   **向 Transformer 传递选项**: 某些转换器（如 `maxtoken`）接受选项。要传递选项，请使用嵌套数组，其中第一个元素是转换器名称，第二个元素是选项对象。
    ```json
    {
      "name": "siliconflow",
      "api_base_url": "https://api.siliconflow.cn/v1/chat/completions",
      "api_key": "sk-xxx",
      "models": ["moonshotai/Kimi-K2-Instruct"],
      "transformer": {
        "use": [
          [
            "maxtoken",
            {
              "max_tokens": 16384
            }
          ]
        ]
      }
    }
    ```

**可用的内置 Transformer：**

-   `Anthropic`: 如果你只使用这一个转换器，则会直接透传请求和响应(你可以用它来接入其他支持Anthropic端点的服务商)。
-   `deepseek`: 适配 DeepSeek API 的请求/响应。
-   `gemini`: 适配 Gemini API 的请求/响应。
-   `openrouter`: 适配 OpenRouter API 的请求/响应。它还可以接受一个 `provider` 路由参数，以指定 OpenRouter 应使用哪些底层提供商。有关更多详细信息，请参阅 [OpenRouter 文档](https://openrouter.ai/docs/features/provider-routing)。请参阅下面的示例：
    ```json
      "transformer": {
        "use": ["openrouter"],
        "moonshotai/kimi-k2": {
          "use": [
            [
              "openrouter",
              {
                "provider": {
                  "only": ["moonshotai/fp8"]
                }
              }
            ]
          ]
        }
      }
    ```
-   `groq`: 适配 groq API 的请求/响应
-   `maxtoken`: 设置特定的 `max_tokens` 值。
-   `tooluse`: 优化某些模型的工具使用(通过`tool_choice`参数)。
-   `gemini-cli` (实验性): 通过 Gemini CLI [gemini-cli.js](https://gist.github.com/musistudio/1c13a65f35916a7ab690649d3df8d1cd) 对 Gemini 的非官方支持。
-   `reasoning`: 用于处理 `reasoning_content` 字段。
-   `sampling`: 用于处理采样信息字段，如 `temperature`、`top_p`、`top_k` 和 `repetition_penalty`。
-   `enhancetool`: 对 LLM 返回的工具调用参数增加一层容错处理（这会导致不再流式返回工具调用信息）。
-   `cleancache`: 清除请求中的 `cache_control` 字段。
-   `vertex-gemini`: 处理使用 vertex 鉴权的 gemini api。
-   `qwen-cli` (实验性): 通过 Qwen CLI [qwen-cli.js](https://gist.github.com/musistudio/f5a67841ced39912fd99e42200d5ca8b) 对 qwen3-coder-plus 的非官方支持。
-   `rovo-cli` (experimental): 通过 Atlassian Rovo Dev CLI [rovo-cli.js](https://gist.github.com/SaseQ/c2a20a38b11276537ec5332d1f7a5e53) 对 GPT-5 的非官方支持。

**自定义 Transformer:**

您还可以创建自己的转换器，并通过 `config.json` 中的 `transformers` 字段加载它们。

```json
{
  "transformers": [
      {
        "path": "/User/xxx/.claude-code-router/plugins/gemini-cli.js",
        "options": {
          "project": "xxx"
        }
      }
  ]
}
```

#### Router

`Router` 对象定义了在不同场景下使用哪个模型：

-   `default`: 用于常规任务的默认模型。
-   `background`: 用于后台任务的模型。这可以是一个较小的本地模型以节省成本。
-   `think`: 用于推理密集型任务（如计划模式）的模型。
-   `longContext`: 用于处理长上下文（例如，> 60K 令牌）的模型。
-   `longContextThreshold` (可选): 触发长上下文模型的令牌数阈值。如果未指定，默认为 60000。
-   `webSearch`: 用于处理网络搜索任务，需要模型本身支持。如果使用`openrouter`需要在模型后面加上`:online`后缀。
-   `image`(测试版): 用于处理图片类任务（采用CCR内置的agent支持），如果该模型不支持工具调用，需要将`config.forceUseImageAgent`属性设置为`true`。

您还可以使用 `/model` 命令在 Claude Code 中动态切换模型：
`/model provider_name,model_name`
示例: `/model openrouter,anthropic/claude-3.5-sonnet`

#### 自定义路由器

对于更高级的路由逻辑，您可以在 `config.json` 中通过 `CUSTOM_ROUTER_PATH` 字段指定一个自定义路由器脚本。这允许您实现超出默认场景的复杂路由规则。

在您的 `config.json` 中配置:

```json
{
  "CUSTOM_ROUTER_PATH": "/User/xxx/.claude-code-router/custom-router.js"
}
```

自定义路由器文件必须是一个导出 `async` 函数的 JavaScript 模块。该函数接收请求对象和配置对象作为参数，并应返回提供商和模型名称的字符串（例如 `"provider_name,model_name"`），如果返回 `null` 则回退到默认路由。

这是一个基于 `custom-router.example.js` 的 `custom-router.js` 示例：

```javascript
// /User/xxx/.claude-code-router/custom-router.js

/**
 * 一个自定义路由函数，用于根据请求确定使用哪个模型。
 *
 * @param {object} req - 来自 Claude Code 的请求对象，包含请求体。
 * @param {object} config - 应用程序的配置对象。
 * @returns {Promise<string|null>} - 一个解析为 "provider,model_name" 字符串的 Promise，如果返回 null，则使用默认路由。
 */
module.exports = async function router(req, config) {
  const userMessage = req.body.messages.find(m => m.role === 'user')?.content;

  if (userMessage && userMessage.includes('解释这段代码')) {
    // 为代码解释任务使用更强大的模型
    return 'openrouter,anthropic/claude-3.5-sonnet';
  }

  // 回退到默认的路由配置
  return null;
};
```

##### 子代理路由

对于子代理内的路由，您必须在子代理提示词的**开头**包含 `<CCR-SUBAGENT-MODEL>provider,model</CCR-SUBAGENT-MODEL>` 来指定特定的提供商和模型。这样可以将特定的子代理任务定向到指定的模型。

**示例：**

```
<CCR-SUBAGENT-MODEL>openrouter,anthropic/claude-3.5-sonnet</CCR-SUBAGENT-MODEL>
请帮我分析这段代码是否存在潜在的优化空间...
```

## Status Line (Beta)
为了在运行时更好的查看claude-code-router的状态，claude-code-router在v1.0.40内置了一个statusline工具，你可以在UI中启用它，
![statusline-config.png](/blog/images/statusline-config.png)

效果如下（包含全新的彩色渐变 Context 上下文占用进度条）：
![statusline](/blog/images/statusline-v2.png)

## 🤖 GitHub Actions

将 Claude Code Router 集成到您的 CI/CD 管道中。在设置 [Claude Code Actions](https://docs.anthropic.com/en/docs/claude-code/github-actions) 后，修改您的 `.github/workflows/claude.yaml` 以使用路由器：

```yaml
name: Claude Code

on:
  issue_comment:
    types: [created]
  # ... other triggers

jobs:
  claude:
    if: |
      (github.event_name == 'issue_comment' && contains(github.event.comment.body, '@claude')) ||
      # ... other conditions
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: read
      issues: read
      id-token: write
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 1

      - name: Prepare Environment
        run: |
          curl -fsSL https://bun.sh/install | bash
          mkdir -p $HOME/.claude-code-router
          cat << 'EOF' > $HOME/.claude-code-router/config.json
          {
            "log": true,
            "NON_INTERACTIVE_MODE": true,
            "OPENAI_API_KEY": "${{ secrets.OPENAI_API_KEY }}",
            "OPENAI_BASE_URL": "https://api.deepseek.com",
            "OPENAI_MODEL": "deepseek-chat"
          }
          EOF
        shell: bash

      - name: Start Claude Code Router
        run: |
          nohup ~/.bun/bin/bunx @wengine-ai/claude-code-router-next@latest start &
        shell: bash

      - name: Run Claude Code
        id: claude
        uses: anthropics/claude-code-action@beta
        env:
          ANTHROPIC_BASE_URL: http://localhost:3456
        with:
          anthropic_api_key: "any-string-is-ok"
```

这种设置可以实现有趣的自动化，例如在非高峰时段运行任务以降低 API 成本。

## 🎯 高级功能

### 模型族映射 (Family Routing)

Claude Code Router 支持**模型族映射**，将 Claude Code 的模型分级（opus/sonnet/haiku）映射到不同服务商的模型。这实现了智能成本控制：主进程保持相同模型以最大化缓存命中，子代理可自动降级。

#### 配置示例

```json
{
  "Router": {
    "enableFamilyRouting": true,
    "families": {
      "opus": {
        "default": "智谱 Coding Plan,glm-5",
        "think": "DeepSeek,deepseek-reasoner",
        "longContext": "阿里云,qwen3-plus",
        "webSearch": "Gemini,gemini-2.5-flash",
        "fallback": {
          "default": ["阿里云,glm-4", "DeepSeek,deepseek-chat"],
          "think": ["阿里云,qwen-plus", "DeepSeek,deepseek-reasoner"]
        }
      },
      "sonnet": {
        "default": "OpenRouter,deepseek/deepseek-v3",
        "think": "DeepSeek,deepseek-reasoner",
        "fallback": {
          "default": ["阿里云,qwen-turbo", "Gemini,gemini-2.0-flash"]
        }
      },
      "haiku": {
        "default": "阿里云,qwen-turbo",
        "fallback": {
          "default": ["Gemini,gemini-2.0-flash-lite"]
        }
      }
    }
  }
}
```

#### 场景说明

| 场景 | 触发条件 | 说明 |
|------|----------|------|
| `default` | 默认 | 日常对话和代码生成 |
| `think` | Plan Mode | 复杂推理、架构设计 |
| `longContext` | token > 60000 | 大文件分析 |
| `webSearch` | web_search tool | 网络搜索任务 |
| `background` | 后台任务 | 自动提交、简单检查 |

### Fallback 机制

当主模型失败时，Router 会自动尝试 fallback 链中的备用模型，确保请求不中断。

#### 工作流程

1. **健康检查**：每个 provider/model 维护健康状态
   - `closed`（健康）→ 绿色指示器
   - `open`（失败池）→ 红色指示器，自动跳过
   - `half-open`（恢复中）→ 黄色指示器

2. **供应商主开关 (Master Toggle)**：在管理面板中，每个供应商都拥有独立的开启/关闭开关：
   - **最高优先级**：当供应商关闭时，旗下所有模型将强制失效且不可选中，健康指示器置灰。
   - **智能 Fallback**：若主模型路由被关闭，系统立刻发起重试并直接进入 fallback 链；若 fallback 列表中的某备用模型所对应的供应商处于关闭状态，则系统自动跳过该模型。
   - **防冗余探测**：关闭的供应商会完全**免除**主动探测和健康恢复检查，避免无谓的网络调用和资源占用，直至开关重新开启。
   - **智能预警提示**：如果当前设置的某项主模型路由（如 `default` 等）所属的供应商已被关闭，控制台界面会实时显示醒目的警示红字，提醒及时更换模型配置。

3. **失败判定**：连续 3 次失败后进入 `open` 状态

4. **拖动排序**：UI 支持拖动 fallback 模型调整优先级，排序越靠前越先尝试

5. **Fallback Promotion**：当主模型失败且 fallback 成功时，临时"晋升" fallback 模型（TTL 10 分钟），后续请求直接使用晋升模型，避免重复尝试失败的主模型

6. **自动恢复**：每 5 分钟探测失败模型，成功后恢复为 `half-open`，再成功 2 次后恢复为 `closed`

![Provider 健康状态](/blog/images/provider-health-healthy.png)

#### Fallback 配置层级

```
family fallback → global fallback
```

优先使用模型族专属的 fallback 配置，其次使用全局 fallback。

```json
{
  "Router": {
    "enableFallback": true,
    "families": {
      "opus": {
        "fallback": {
          "default": ["阿里云,glm-4", "DeepSeek,deepseek-chat"]
        }
      }
    }
  },
  "fallback": {
    "default": ["OpenRouter,deepseek/deepseek-v3", "Gemini,gemini-2.5-flash"],
    "think": ["DeepSeek,deepseek-reasoner"]
  }
}
```

### 用量统计

Router 提供完善的用量统计功能：

#### Quota 监控

UI 界面实时显示各服务商的额度使用情况：

- **5h 额度**：短窗口限额（5 小时重置）
- **7d 额度**：周度限额（7 天重置）
- **重置时间**：显示下次额度重置时间

![Quota 用量条](/blog/images/provider-quota-usage.png)

支持的服务商：
- 智谱 GLM Coding Plan
- 阿里云 Qwen Coding Plan
- Kimi Coding Plan
- MiniMax Coding Plan
- DeepSeek
- OpenRouter
- SiliconFlow

#### Usage 记录

每次请求都会记录详细统计信息：

| 字段 | 说明 |
|------|------|
| `inputTokens` | 输入 token 数 |
| `outputTokens` | 输出 token 数 |
| `cacheReadInputTokens` | 缓存读取 token |
| `cacheCreationInputTokens` | 缓存创建 token |
| `ttft` | 首 token 时间 (ms) |
| `tokensPerSecond` | 输出速度 |
| `durationMs` | 请求耗时 |
| `status` | success / error |

数据存储位置：`~/.claude-code-router/data/usage.jsonl`

## 交流群
<img src="/blog/images/wechat_group.jpg" width="200" alt="wechat_group" />
