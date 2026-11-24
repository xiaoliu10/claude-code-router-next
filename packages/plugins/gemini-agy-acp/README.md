# gemini-agy-acp

Experimental local provider for CCR 2.3.2433 (provider plugin API 1). A text chat request starts or reuses a local Antigravity CLI worker over ACP stdio. This provider has its own name and configuration, separate from `gemini-oauth`.

**Opt-in and billing.** Use a trusted local `agy` executable and either a Gemini API key you are authorized to use or the CLI's own Google account login (oauth-personal). The CLI receives the prompt and may send it to Google's service. API key quotas, charges and terms apply; Google account usage follows the signed-in account's terms. The CLI runs with the CCR operating system user's permissions. Treat both the executable and the operator configuration as trusted. Consumer subscriptions and account rotation remain unsupported.

**启用与计费。** 本插件为实验原型，默认关闭。仅使用可信的本地 `agy` 程序，以及有权使用的 Gemini API 密钥或 CLI 自身的 Google 账号登录（oauth-personal）。CLI 会收到对话内容，并可能将其发送到 Google 服务。API 密钥受配额、计费和使用条款约束；Google 账号用量遵循所登录账号的条款。CLI 以 CCR 进程的系统用户身份运行。插件不支持个人订阅或账号轮换。测试仅使用模拟进程，尚未验证真实账号、费用或上游服务。

## Install from npm

Run the following in the isolated CCR instance described below. Installing the package leaves the transport disabled until the operator enables it.

```sh
ccr plugin add @wengine-ai/ccr-provider-gemini-agy-acp@0.1.0
```

## Build and install locally

Use Node 20+ and this checkout's `packages/cli/dist/cli.js` (build the host with `pnpm build:cli` in a development checkout if needed). From the repository root, install into a disposable CCR configuration directory. The CLI copies the `dist` payload and records the plugin in that directory's `plugins/plugins.json`. Installing alone leaves the ACP transport disabled.

```sh
plugin=packages/plugins/gemini-agy-acp
node "$plugin/scripts/build.mjs"
node --test "$plugin"/test/*.test.mjs
export CCR_CONFIG_DIR="$(mktemp -d)"
node packages/cli/dist/cli.js plugin add "$plugin" --yes
```

The loader expects `plugin.json` and `plugin.js` in the installed plugin directory. Copy the entire built payload if inspecting it outside the CLI. Its `package.json` establishes the ESM format and `src/` contains its local module dependencies.

## Configure an isolated primary route

Place this example in the disposable `$CCR_CONFIG_DIR/config.json`. Replace `model-1` with a model selector value available to your particular CLI account. Keep the exact managed marker in `api_key` so CCR refuses ordinary HTTP dispatch if the plugin is missing. The URL fills a required host field and the ACP runtime never calls it. `test-key` is a local client-auth example.

```json
{
  "HOST": "127.0.0.1",
  "PORT": 43781,
  "APIKEY": "test-key",
  "ACTIVE_PROBE_ENABLED": false,
  "Providers": [{
    "name": "gemini-agy-acp",
    "api_base_url": "https://example.com/unused",
    "api_key": "ccr-managed-gemini-agy-acp",
    "models": ["model-1"],
    "transformer": { "use": ["gemini-agy-acp"] }
  }],
  "Router": { "default": "gemini-agy-acp,model-1", "enableFallback": false }
}
```

Use ACP as a **primary route** in an isolated instance with effective `Router.enableFallback` set to `false` and no project or global fallback entries. ACP disables fallback on the primary request once its transformer or dispatcher receives it. Earlier host failures, including `plugin_missing`, occur before the plugin gets the request. CCR can also continue an outer fallback chain if it reached ACP as a fallback candidate. Neither path is controlled by the plugin. Background recovery probes are disabled for this prototype.

## Automatic agy install

For headless clients, the gateway operator can set `CCR_AGY_INSTALL_ON_USE=1` in the CCR process environment to permit installation on first local model use. With no sidecar or default binary, a direct loopback request starts the same background download and returns `agy_install_in_progress`. After installation, open the local card and connect the account. A saved disconnect is respected. Use the card to retry a failed download.

无界面客户端可在 CCR 网关进程环境设置 `CCR_AGY_INSTALL_ON_USE=1`。首次通过本机直接调用模型时，若尚无连接配置和默认 CLI，会启动后台下载并返回 `agy_install_in_progress`。安装完成后，在本机管理卡连接账号；下载失败可在卡片上重试。

When the settings card first opens and no `agy` is detected (no sidecar binary and nothing at the official default location), it starts the official install automatically for the current OS and CPU architecture — macOS/Linux/Windows on x64 or arm64, including the Linux musl builds. The flow mirrors the vendor bootstrappers step for step: the release manifest is queried from the pinned Antigravity updater, the payload downloads over HTTPS only (curl inherits the gateway's `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY` environment), the SHA-512 checksum is verified before anything is placed, and payload URLs are restricted to the vendor's own hosts. The binary lands at `~/.local/bin/agy` on unix and `%LOCALAPPDATA%\agy\bin\agy.exe` on Windows; no remote script is ever piped into a shell.

The install runs in the background (single-flight) while the card polls status; a failure shows a stable error code with an explicit **Install agy** retry button and is never retried automatically. Installing never writes the sidecar and never enables the provider — **Connect** remains the only action that persists settings and starts workers. `POST /api/gemini-agy-acp/install` triggers the same flow manually (local-only guard).

首次打开设置卡片时，若未检测到 `agy`（sidecar 未配置 binary，官方默认位置也没有），会按当前系统与 CPU 架构自动安装官方发布版——支持 macOS/Linux/Windows 的 x64 与 arm64（含 Linux musl 构建）。流程与官方引导脚本逐步一致：从固定的 Antigravity 更新器查询发布清单，仅经 HTTPS 下载（curl 继承网关的 `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY` 环境变量），放置任何文件前先校验 SHA-512，下载地址限定厂商自有域名。unix 安装到 `~/.local/bin/agy`，Windows 安装到 `%LOCALAPPDATA%\agy\bin\agy.exe`；绝不把远程脚本管道进 shell。

安装在后台单飞执行，卡片轮询状态；失败时显示稳定错误码与显式「安装 agy」重试按钮，不会自动重试。安装不写 sidecar、不启用供应商——**连接**仍是唯一持久化配置并启动 worker 的操作。`POST /api/gemini-agy-acp/install` 可手动触发同一流程（仅限本机守卫）。

## Enable from the settings card

Open the CCR settings page, find the **Local Antigravity CLI (ACP) bridge** card and:

1. Enter the absolute path of your local `agy` executable (CLI 1.5.1+ with ACP).
2. Pick the 登录方式 (login mode): **API key** (default) or **Google 账号** (oauth-personal). In API key mode you may optionally enter a Gemini API key — leave the field empty to keep an already stored key or to use the `GEMINI_API_KEY` process environment of the isolated CCR instance. Google-account mode has no key field at all.
3. Press **Connect**. The plugin validates that the path points to an executable, probes `agy --version` with a 5 second cap and requires CLI 1.5.1 or later. API-key mode then writes `$CCR_CONFIG_DIR/gemini-agy-acp.json` and respawns its worker pool. Google-account mode additionally verifies the real login with one bounded ACP handshake (authenticate + session/new) on a temporary worker of the selected binary — `--version` alone cannot prove the OS-keyring browser login works — and maps any handshake failure to a stable sign-in hint. Switching between modes evicts the other mode's stored credential or stale account email. The account email shown on the card comes exclusively from that verified handshake (explicit ACP account metadata, or the verifying child's own captured diagnostics) and is never read from stale log files or token stores; when the CLI provides none, the card shows 账号邮箱未提供.
4. Press **Sync models** to read the model catalog the CLI advertises over ACP (one temporary worker, bounded to 5 seconds, authenticating exactly like the request pool). The catalog is stored in the sidecar, shown on the card and written to the provider's `models` list in `config.json` (Router entries are left untouched), so synced models are routable immediately. If the provider entry does not exist yet, Sync models creates it with the managed marker and a placeholder URL — no manual `config.json` editing is needed.

The CLI makes its own upstream calls to Google. API-key workers run in an isolated environment that forwards the standard proxy variables (`HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, `NO_PROXY`) from the CCR process. Google-account workers must see the CLI's own login state, which an isolated runtime does not guarantee — they run on a fresh temporary working directory with a whitelist of only the runtime/login-required environment (real `HOME`/user profile, `PATH`, temp dirs, platform config locations, GUI/DBus session, proxy variables) and never a blanket copy of `process.env`; credential variables such as `GEMINI_API_KEY` or `GOOGLE_APPLICATION_CREDENTIALS` are never forwarded. Key validity is not verified at Connect time in API-key mode (authentication is a local ACP handshake); an invalid key surfaces the CLI's own upstream error text on the first request — never another account's figures.

**Disconnect** disables the provider and retires the workers without deleting the stored settings. The status line reports loaded/enabled state, whether the binary was found, the last probed CLI version and the synced model count, plus the credential line: a non-reversible fingerprint for API-key mode, or the handshake-verified account email (or 账号邮箱未提供) for oauth-personal mode. The card and its routes are local-only: they run under the same loopback + Origin allowlist as the other provider plugins and never return the API key — the status shape carries `apiKeyConfigured` only.

Connect writes the sidecar `$CCR_CONFIG_DIR/gemini-agy-acp.json` (mode 0600). The file remains the source of truth, and editing it takes effect on the next request without a gateway restart:

```json
{
  "enabled": true,
  "binary": "/absolute/path/to/agy",
  "authMethod": "gemini-api-key",
  "timeoutMs": 60000,
  "maxWorkers": 1
}
```

An `apiKey` written by Connect is stored inside this file with 0600 permissions and never appears in logs, config.json, transcripts or responses; oauth-personal mode persists no `apiKey` at all. Worker limit is 1–8 (default 1) and timeout is 1–300000 ms (default 60000). Choose an unused test port and restrict access to these files and the process environment.

Supply `GEMINI_API_KEY` through the isolated CCR process environment (together with your proxy variables), or store the key once via Connect. An explicit sidecar `apiKey` takes precedence; without one the transport captures the environment key at pool start. Keep the key out of request headers, JSON files other than the 0600 sidecar, transcripts and source control. Supported `authMethod` values are `gemini-api-key` (optional key with environment fallback) and `oauth-personal` (no key allowed; any key alongside it fails closed). A missing key in API-key mode or an unsupported auth method fails the request.

## Text chat

Use `/v1/chat/completions` or CCR's `/v1/messages` endpoint. CCR handles Anthropic conversion. Example OpenAI request body (synthetic model ID):

```json
{
  "model": "gemini-agy-acp,model-1",
  "reasoning_effort": "high",
  "messages": [
    { "role": "system", "content": "Answer in one sentence." },
    { "role": "user", "content": "Name a primary color." },
    { "role": "assistant", "content": "Blue." },
    { "role": "user", "content": "Name another." }
  ],
  "stream": true
}
```

Each request gets a fresh ACP session. A single user string is passed directly. Multiple turns become an ordered JSON text transcript in one ACP prompt. Role labels in that transcript do not establish separate privileged system instructions inside the CLI. The adapter accepts `system`, `user`, `assistant` and text blocks. Named roles and non-text content fail explicitly. Tool requests are served: the plugin publishes the caller's tools to the agent through an MCP server bound to `127.0.0.1` with a random bearer token, the agent's raised call is reported as `tool_calls`, and the next request carrying the caller's results resumes the same turn. The agent never executes a tool, a missing answer is an error rather than a hang, and the bridge descriptor, token and tool schemas only travel to the agent subprocess. The model is matched against the provider catalog and passed intact to the transport. Optional OpenAI `reasoning_effort` or CCR-normalized Anthropic effort selects an advertised thinking option. `xhigh` can match an advertised Extra tier. An unavailable explicit selection fails. Omitting effort leaves the CLI's selection unchanged.

Non-streaming requests return one OpenAI chat completion. Streaming emits role and text deltas, a finish reason, then `[DONE]` on success. Failures before the first text use HTTP errors. A failure after partial output terminates the stream with an error. The host limits output to 1 MiB of text and 8192 nonempty deltas per response. When ACP reports a complete, consistent token count, the completion or final finish-reason chunk includes OpenAI-style `usage`. Prompt tokens include cache reads and writes, and completion tokens include reasoning. The `usage_source` field identifies these counts to CCR. If either standard input or output count is unavailable, the plugin uses the complete pair from `_meta.quota.token_count` when available. Usage is omitted when a reported total cannot identify a unique prompt/completion split. Sampling controls, caller token limits, structured output and persistent multi-turn ACP sessions are unsupported.

The protocol fixture follows Google's documented ACP v1 invocation, API-key method ID, and session selectors. This prototype handles the protocol-driven authentication method (omitted type or `agent`) and rejects other method types before opening a session. The fixture is synthetic, including the `oauth-personal` method id, the `accountInfo` metadata and the stderr login line — the exact handshake and account-reporting shape of a production CLI build still needs verification.

Local tests use synthetic text, credentials and subprocess fixtures. Live CLI authentication, model availability, provider billing, production load and compatibility with other CCR versions remain unverified. The plugin spawns `agy acp --process-per-session` without a sandbox flag, so it does not confine the agent's own built-in tools; only the caller-provided MCP tools are bridged, and every raised call is executed by the caller, not by the agent. CCR 2.3.2433 has no plugin shutdown callback. The transport retires idle workers and bounds each request.

[Antigravity ACP documentation](https://antigravity.google/docs/ide/extensions/acp/) · [ACP session config options](https://agentclientprotocol.com/protocol/v1/session-config-options)
