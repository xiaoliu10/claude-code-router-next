# CCR Desktop（桌面控制中心 + 独立内置运行时）

CCR Desktop 是桌面控制中心：主窗口加载**本地** `quota.html` 控制中心页（不导航任何远程 Web UI），托盘保留原生路由/刷新菜单，四页签（配额/路由/用量/客户端）由父代理的 control 模块驱动。桌面拥有**显式的网关生命周期**：它启动的网关（owned）在退出时被优雅停止；已经在运行的外部网关（含 launchd 服务、终端 `ccr start`、别人的进程）**永远不会被桌面停止**。

## 生命周期与所有权（docs/design/desktop-control-center.md）

1. **Owned vs external**：桌面只把「本桌面实例 spawn 的 Child」视为 owned。启动成功判定 = child 仍存活 **且** health 通过。child 死亡而端口被其它进程接管时一律报告 external，绝不冒认 owned。
2. **自动启动**：仅当端口 connection refused 且本地 CCR 配置证明该端点（PORT/HOST/SERVICE_PORT）匹配时，才用**内置运行时**启动网关；端口被占用（含非 CCR 服务、hung gateway、鉴权失败）只显示状态，不抢占、不停止任何进程。
3. **优雅停止（仅 owned）**：`stop_owned_gateway` 先 `try_wait` 确认存活再发 SIGTERM（无 PID 复用误杀、无进程名扫描、无全局 `ccr stop`），有界等待（5s）后 SIGKILL 兜底。外部网关任何路径都不会被触碰。
4. **退出/关窗**：托盘 Quit、popup 退出、主窗口关闭都会退出桌面；退出钩子停止 owned 网关，菜单文案随所有权变化（`Quit Desktop (stops the gateway it started)` vs `(gateway stays running)`）。小弹窗失焦/关闭仍只是隐藏。
5. **启动/退出竞态**：spawn 后**同步**把 child 发布进共享 slot（无 await 间隔）；publish 在 slot 锁内做 cancel 检查——退出竞态时新 spawn 会自行终止自己并保持不发布，quit 路径的有界等待只覆盖 spawn 本身，正确性不依赖 async 任务 settle。
6. **`CCR_DESKTOP_MANAGED=1`**：注入所有 owned 启动。桌面 service entry 据此拒绝 `/api/restart`、`/api/update/perform`（409），`/api/update/check` 返回 `{hasUpdate:false,desktopManaged:true}`——CLI 自重启/自更新无法让网关脱离桌面归属。旧版全局 CLI 不识别该变量（文档层面知悉）；新桌面 bundle 始终受保护。
7. popup 窗口与主窗口都加载同一本地 `quota.html`；每个命令验证窗口 label + 精确本地 URL；拒绝远程导航与新窗口；凭据只留在 Rust。`Open Control Center` 打开本地主窗口。

## 独立内置运行时（standalone）

桌面**不调用 `ccr` CLI、不依赖全局 Node/npm/ccr**，也不打包/依赖 Web UI（网页端与桌面端完全独立；core 静态 UI 缺 index.html 时 API 正常启动，`/ui/` 404 已实测）。固定启动路径 `runtime/node runtime/service/entry.cjs`：

```
runtime/
  node                       便携 Node（官方发行版固定版本，SHA256 校验）
  LICENSE-node               Node 许可证
  bin/npm, bin/npx           自包含 wrapper（exec 内置 node）
  lib/node_modules/npm/**    内置 npm（插件安装不依赖全局 npm）
  service/entry.cjs          桌面 service entry（直接复用 core getServer()）
  service/tiktoken_bg.wasm   tokenizer wasm（entry 同级）
  service/node_modules/**    better-sqlite3（native）+ lru-cache + 全部传递依赖
  MANIFEST.json              固定版本 + SHA256（无时间戳，确定性内容）
```

entry 职责（`runtime-src/entry.ts`）：绑定**成功后**才恢复既有 enabled 客户端集成（shared 包现成逻辑 + `readConfigFileRaw`/`writeConfigFile` 原样写回 + 启动时 sync takeovers；空选择不写盘；失败只记 id 不假报成功）；SIGTERM 优雅关闭仅在已 bind 时反方向恢复（stop 阶段不做 takeover sync）；串行化 enable/disable 防并发写配置。启动失败以非零退出如实上报。

**禁止 installed-ccr fallback**：缺 runtime staging 是显式错误（提示准备命令）；开发模式下若外部网关已在运行仍可正常 attach（attach 先于 bundle 检查）。HOME/CCR_CONFIG_DIR 跟随用户环境。首次启动以独占创建、0600 权限初始化本地配置和随机管理 API key（显式空 key override 保留）；已有配置不覆盖。**bundle 不包含用户配置、凭据、插件或数据库**；测试一律隔离 HOME + 隔离 CCR_CONFIG_DIR + 临时端口（绝不占用 3456）。

## 脚本

```sh
pnpm build:shared && pnpm build:core                      # entry 依赖 core/shared dist
node apps/desktop/scripts/prepare-runtime.mjs             # 确定性 staging（校验 node 版本/架构/ABI/npm）
node apps/desktop/scripts/smoke-bundled-runtime.mjs       # 隔离冒烟（临时 HOME/config、临时端口、SIGTERM 优雅退出）
node apps/desktop/scripts/verify-runtime-lifecycle.mjs    # 环境占位符、活跃连接退出、绑定失败恢复验证
node apps/desktop/scripts/build-standalone.mjs            # 产出 .app 并把 runtime 复制进 Contents/Resources
node --test apps/desktop/tests/runtime-staging.test.mjs   # 脚本纯函数测试
```

`prepare-runtime.mjs`：便携 Node 发行版固定 `v26.4.0`（与本仓库 better-sqlite3 ABI 匹配；本地 Homebrew node 因 `/opt/homebrew` dylib 依赖被判 nonportable，禁止拷贝）；下载经 SHASUMS256.txt 校验；`--node-tarball` 本地包 SHA 不符即拒绝；otool 同时检查 Node 和 SQLite native addon，仅允许系统 dylib/framework；递归拷贝 native 依赖树并剥离外链 symlink；端到端 SQLite ABI require 校验；`MANIFEST.json` 双次运行字节一致。缓存目录 `apps/desktop/.runtime-cache/` 在 staging 之外。

`build-standalone.mjs`：先普通 `cargo tauri build --bundles app --no-sign`（tauri.conf.json 无 resources，CI 无需二进制），再把 `runtime/` 结构化复制进 `.app/Contents/Resources/runtime`（本版 tauri resources 会把目录树打平，故不走 bundle.resources），构建后断言必备文件存在且无配置泄漏。CI/无 staging 时产出 shell-only 产物并明确告警（运行时显式缺 bundle 错误，不会 fallback）。

## 项目配置

“项目”页读取现有项目配置，支持跟随全局、独立场景/家族路由、上下文阈值、有序回退、模型别名及项目客户端接管。路由修改需点击保存，客户端选择需单独应用；移除时会确认，只移除 CCR 项目配置，不删除项目源码。未保存草稿在切换项目、页签和刷新时保留，过期配置会提示重新加载。

用量中的 token 数统一显示为 K/M/B，最多两位小数；悬停保留完整数量。

## 供应商编辑

桌面编辑器使用供应商名称定位配置。为保留全局及项目路由对该名称的引用，现有供应商的名称只读。可修改地址、密钥、模型及供应商级转换器；留空密钥或保持转换器不变会保留最新配置。只有网关目录明确支持参数的转换器可配置参数。地址查询仅支持数字版本（如 `?version=1`）或日期版本（如 `?api-version=2024-10-21`，可带 `-preview`）。系统托管的供应商由对应插件管理。

## Coding Plan 用量凭证

额度页中 `api_base_url` 命中 `ark.cn-beijing.volces.com` 且路径含 `/api/coding/` 的提供方（与 core 火山 Coding Plan adapter 同一条件）会显示「用量凭证」按钮；未配置时卡片提示「未配置 AK/SK，无法查询套餐用量」。内联面板提供两个 password 输入（AccessKey ID / Secret AccessKey），已保存的凭证不回显：留空保存=不修改，「清除凭证」显式清空。

- `quota_credentials_status()` → `{providers:[{name,configured:boolean}]}`，仅含匹配提供方；configured=两字段均非空。
- `quota_credentials_save({name,accessKey?,secretKey?})` → 同结构。缺省字段=不修改，空字符串=清除该字段；走共享写锁：GET /api/config → 按 name 只改 `quotaAccessKey`/`quotaSecretKey` → POST /api/config → GET readback 校验。无实际变更时不 POST。
- 红线：AK/SK 只写入本地网关配置，绝不进入 IPC DTO、日志或错误信息；命令同样受 `popup::guard`（main/quota label + 精确本地 URL）与 capability 限制。

## service 命令

Rust 命令通过共享 `popup::guard` 验证 main/quota 窗口及精确本地 URL：

- `service_snapshot()` → `{mode:'owned'|'external'|'stopped'|'starting'|'error',running:boolean,message:string}`（camelCase 键 `mode/running/message`）。
- `service_action({action:'start'|'stop'})` → 同结构。stop 仅作用于 owned child；external/attach 状态原生拒绝（固定安全文案）。UI 中 external 的 start/stop 应禁用。
- handler、build manifest 与 capability 已接线；远程页面不能调用这些命令。启动超时会终止并回收 owned child，允许重新启动。

## 安装前提与环境

开发需要 Rust 1.90+（本机验证 1.99.0）、tauri-cli ^2、Node >= 20（构建脚本用）。运行 standalone 产物无需任何全局安装。staging 缺失时 dev 运行仍可连接已运行的外部网关；spawn 会显式报错。

| 环境变量 | 行为 |
|---|---|
| `CCR_CONFIG_DIR` | 配置目录，读取其 `config.json`；默认 `~/.claude-code-router` |
| `CCR_DESKTOP_PORT` | 仅桌面的 loopback 连接端口；优先于 config `PORT`，默认 3456。若与 CLI 实际端口不同，拒绝自动启动 |
| `CCR_DESKTOP_API_KEY` | 优先于 config `APIKEY`；空字符串表示不发送 key |
| `CCR_DESKTOP_NODE_VERSION` | staging Node 版本覆盖（默认 `v26.4.0`） |
| `SERVICE_PORT` | server runtime override；自动启动安全检查会考虑它 |

Config 支持 JSON5；端口/key 的 `$NAME`、`${NAME}` 用桌面进程环境展开。GUI 从 Finder 启动通常不继承 shell 变量，请确保 app 启动环境可用。

## 构建、检查

```sh
source "$HOME/.cargo/env"
cd apps/desktop/src-tauri
cargo fmt --check
cargo check
cargo test
cargo clippy --all-targets -- -D warnings
cd ../.. && node apps/desktop/scripts/build-standalone.mjs
```

macOS 输出：`apps/desktop/src-tauri/target/release/bundle/macos/CCR Desktop.app`。正式分发仍需独立签名/公证；无 auto-updater。Windows/Linux 未验证。

### 本次实际验证（2026-11-17）

- macOS arm64 / Rust 1.99.0 / tauri-cli 2.12.2 / staging Node v26.4.0 + npm 11.17.0。
- `cargo test`（73 passed）、`cargo fmt --check`、`cargo clippy --all-targets -- -D warnings` 全绿。新增测试覆盖：fake child 终止/已退出不再 signal/SIGTERM trap 先于 kill（ready marker 防竞态）、cancel-in-lock spawn 协议、occupied/unhealthy 不启动、取消启动、缺 bundle 显式错误、service DTO 全模式、bundle 检测与 PATH 前置。
- `prepare-runtime.mjs` 成功 staging（MANIFEST 两次运行 diff 为空；sqlite ABI roundtrip 通过；`otool -L` staged node 无 `/opt/homebrew` 依赖；`npm --version` 用隔离 HOME + 仅 runtime PATH 验证）。
- `smoke-bundled-runtime.mjs` 通过：隔离 HOME/CCR_CONFIG_DIR + fixture provider 强制 127.0.0.1 + 鉴权绑定，临时端口（≠3456）；health/config 200；`/api/restart`、`/api/update/perform` 409；`/api/update/check` desktopManaged；`/ui/` 404（无打包 Web UI）；SIGTERM 退出码 0 且端口释放。
- `build-standalone.mjs` 产出未签名 `.app`（182 MB，含完整 runtime；bundle 内断言必备文件 + 无 config.json/logs 泄漏）。entry bundle 约 17MB（core 运行时打包），node 发行版约 120MB，native deps 约 20MB。
- 77 项 Node UI/staging 测试通过。真实 App 使用隔离 HOME/config、临时端口和 `PATH=/usr/bin:/bin`；四页签 IPC、owned start/stop、main close 释放端口、external attach 后退出保留服务均通过。验收构建仅改 bundle identifier，避开已有桌面单实例；正式产物恢复标准 identifier。
- 客户端环境占位符与原配置保持、活跃 HTTP 请求时先恢复客户端再关闭连接、绑定失败不恢复客户端均通过；冲突的继承 `SERVICE_PORT` 不影响 fixture 隔离。
- 未重启或修改 live CCR、真实 HOME/client 配置；所有验证均隔离。

**限制**：`.app` 未签名/未公证；`prepare-runtime` 的便携 Node 下载需要网络（可用 `--node-tarball` 本地包，SHA 仍强制）；跨平台（Windows/Linux）runtime 布局与打包未实现；桌面与网页端共享同一份用户 config，非原子并发写仍需避免（服务端保存带自动备份）。
