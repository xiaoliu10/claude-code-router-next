# CCR Desktop Windows x64 更新发布

Windows x64 NSIS 客户端读取本仓库最新正式 Release 的 `desktop-update.json`，按 Desktop semver 比较版本。`v2.3.2437` 随附的 Desktop 0.1.1 需手动安装首个支持更新的签名安装包。缺少清单时，客户端提示清单暂不可用。无公钥的开发构建和其他平台仍能使用控制中心，其 `supported` 为 `false`。

## 建立签名密钥

1. 在受信任的发布机安装与 CI 一致的 Tauri CLI 2.12.2。运行 `cargo tauri signer generate -w <仓库外的私钥路径>`，按提示设置口令。备份私钥及口令到发布团队的密码库。
2. 将生成的 `.pub` 文件的完整单行内容存入官方仓库的 Actions 变量 `DESKTOP_UPDATE_PUBLIC_KEY`。签名构建把该公钥固定在安装包中，上传前用同一构建配置校验产物签名。开发构建保持独立。
3. 在官方仓库配置 Actions secrets `TAURI_SIGNING_PRIVATE_KEY`（私钥文件内容）和 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。保护签名用的项目标签，只从已审查的提交构建。开发者和外部 PR 可直接运行测试。测试夹具仅包含一次性公钥和签名，私钥已销毁。

Tauri 更新签名覆盖安装包及其 Desktop 版本。Windows Authenticode 和 SmartScreen 声誉需要单独的代码签名证书。密钥丢失或轮换时，通过官方 Release 提供带新公钥的手动安装包及迁移说明。

## 发布安装包

1. 同步递增 `apps/desktop/src-tauri/{Cargo.toml,tauri.conf.json}` 的 Desktop 版本，更新 `Cargo.lock`。从这次提交创建项目正式标签（例如 `v2.3.2438`），为该标签建立草稿 Release。
2. 从**这个标签**手动运行 **Windows installer** 工作流，选择 `signed_release` 并填写 Desktop 更新说明。工作流在 Windows x64 构建完整 NSIS 包，生成绑定版本的 `.sig`，用客户端校验逻辑验证安装包、版本、公钥和清单后，依次上传 `.exe`、`.exe.sig` 和 `desktop-update.json` 到草稿。
3. 复核草稿的三个文件，在隔离 Windows 用户或 VM 安装测试版本并确认升级，再将草稿发布为 latest。发布后访问固定地址，检查 `version`、`notes` 和 `platforms.windows-x86_64-nsis`。安装包 URL 指向不可变的项目标签。失败重试前检查草稿中已上传的文件，工作流会拒绝覆盖同名资产。[桌面更新清单](https://github.com/xiaoliu10/claude-code-router-next/releases/latest/download/desktop-update.json)
4. 后续仅发布 CLI 时，将上个已验证 Desktop Release 的 `desktop-update.json` **原样**附到新草稿，再发布为 latest。保留原标签下的安装包和签名。这样旧桌面客户端仍可更新，已安装对应 Desktop 版本的客户端会显示已是最新。没有既有签名 Desktop 发布时，省略清单，客户端会提示清单暂不可用。不要用 CLI 版本生成 Desktop 清单。

## IPC 和网关交接

仅加载本地 `quota.html` 的 `main` 窗口可以调用下列命令。`desktop_update_status()` 返回 `{currentVersion, supported}`。`desktop_update_check()` 读取清单，返回 `{version, notes}`，两个字段为 `null` 表示该清单中没有更高版本。读取失败、清单损坏或服务器拒绝访问会返回错误。用户点击「立即更新」后，`desktop_update_install({version})` 消费本次检查保存的原生更新对象。`desktop-update-progress` 只发给主窗口，包含累计 `downloaded`、可空的 `total` 和 `downloading` 或 `installing` 阶段。

安装包通过 Tauri 签名和版本验证后，桌面持有网关启动锁并停止自己启动的子进程，然后交给 NSIS 安装并重启。外部网关继续运行。下载或验签失败保留网关；安装器启动失败时，控制中心报告错误，并尝试恢复其先前停止的托管网关。

本地可运行 `cargo test --locked --lib update::tests`（在 `src-tauri` 内）及 `node --test apps/desktop/tests/desktop-update-release.test.mjs`（仓库根目录）。测试使用临时 loopback 和签名夹具。[官方 Tauri updater 文档](https://v2.tauri.app/plugin/updater/)
