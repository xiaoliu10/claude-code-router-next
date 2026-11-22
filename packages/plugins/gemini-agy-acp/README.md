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

Each request gets a fresh ACP session. A single user string is passed directly. Multiple turns become an ordered JSON text transcript in one ACP prompt. Role labels in that transcript do not establish separate privileged system instructions inside the CLI. The adapter accepts `system`, `user`, `assistant` and text blocks. Tool definitions, tool calls/results, named roles and non-text content fail explicitly. The model is matched against the provider catalog and passed intact to the transport. Optional OpenAI `reasoning_effort` or CCR-normalized Anthropic effort selects an advertised thinking option. `xhigh` can match an advertised Extra tier. An unavailable explicit selection fails. Omitting effort leaves the CLI's selection unchanged.

Non-streaming requests return one OpenAI chat completion. Streaming emits role and text deltas, a finish reason, then `[DONE]` on success. Failures before the first text use HTTP errors. A failure after partial output terminates the stream with an error. The host limits output to 1 MiB of text and 8192 nonempty deltas per response. Token usage, sampling controls, caller token limits, structured output and persistent multi-turn ACP sessions are unsupported. Do not depend on token accounting or these controls in this prototype.

The protocol fixture follows Google's documented ACP v1 invocation, API-key method ID, and session selectors. This prototype handles the protocol-driven authentication method (omitted type or `agent`) and rejects other method types before opening a session. The fixture is synthetic, including the `oauth-personal` method id, the `accountInfo` metadata and the stderr login line — the exact handshake and account-reporting shape of a production CLI build still needs verification.

Local tests use synthetic text, credentials and subprocess fixtures. Live CLI authentication, model availability, actual sandbox guarantees, provider billing, production load and compatibility with other CCR versions remain unverified. CCR 2.3.2433 has no plugin shutdown callback. The transport retires idle workers and bounds each request.

[Antigravity ACP documentation](https://antigravity.google/docs/ide/extensions/acp/) · [ACP session config options](https://agentclientprotocol.com/protocol/v1/session-config-options)
