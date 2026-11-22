// Management card for the local ACP bridge. It renders inside the host
// settings page, so the host's global stylesheet (Tailwind utilities + the
// custom .glass-card rule) is part of its runtime environment; class names
// mirror the gemini-oauth / codex card conventions. Import-free,
// network-free, and all rendered strings go through textContent, never
// markup assignment. All traffic rides props.callApi, the host's
// authenticated, sanitized admin bridge (never the raw browser API).
const BADGE_BASE = 'inline-flex items-center rounded-lg border px-2.5 py-0.5 text-[10px] font-bold transition-colors';
const BADGE_OUTLINE = 'border-white/10 text-foreground bg-white/5';
const BADGE_SECONDARY = 'border-white/5 bg-white/5 text-muted-foreground';
const BUTTON_BASE = 'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl border px-3 py-1.5 text-xs font-semibold shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50';
const BUTTON_OUTLINE = 'border-input bg-input/50 hover:bg-input/80 hover:border-primary/50';
const BUTTON_DESTRUCTIVE = 'border-destructive/50 text-destructive hover:bg-destructive hover:text-destructive-foreground';
const INPUT_CLASS = 'max-w-md flex h-9 w-full rounded-lg border border-input bg-input/50 px-3 py-1 text-sm shadow-sm placeholder:text-muted-foreground/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

// Stable route-error codes → one-line localized recovery hints. Unknown codes
// fall back to the sanitized token itself (never an upstream message).
const CODE_HINTS = {
  acp_unsupported_version: ['需要 agy 1.5.1 或更新版本。', 'agy 1.5.1 or later is required.'],
  acp_invalid_config: ['请检查 binary 路径：必须指向本机存在的可执行文件。', 'Check the binary path: it must point to an executable on this machine.'],
  acp_auth_required: ['缺少可用的 Gemini API key。', 'No usable Gemini API key is configured.'],
  acp_timeout: ['agy 未在时限内响应。', 'agy did not respond in time.'],
  acp_busy: ['worker 池已满，请稍后重试。', 'Worker pool is busy, try again shortly.'],
  acp_worker_failed: ['agy 进程异常退出。', 'The agy process failed.'],
  acp_protocol_error: ['agy 返回了无法解析的协议响应。', 'agy returned an unparseable protocol response.'],
  acp_output_limit: ['agy 输出超出限制。', 'agy output exceeded the limit.'],
  acp_unsupported_option: ['该 CLI 未公开可选模型。', 'This CLI exposes no selectable model options.'],
  agy_disabled: ['尚未启用，请先连接。', 'Not enabled yet — connect first.'],
  agy_config_invalid: ['gemini-agy-acp.json 无效，可在 CCR 配置目录删除后重试。', 'gemini-agy-acp.json is invalid — delete it in the CCR config directory and retry.'],
  agy_config_write_failed: ['写入配置文件失败。', 'Writing the configuration file failed.'],
  agy_unauthorized: ['仅限本机访问。', 'Local access only.'],
  agy_route_failed: ['管理请求失败，请重试。', 'The management request failed, please retry.'],
  agy_install_unsupported_platform: ['当前系统/架构没有官方 agy 构建。', 'No official agy build exists for this OS/architecture.'],
  agy_install_manifest_failed: ['无法访问 agy 发布服务器，请检查网络或代理。', 'Cannot reach the agy release server — check the network or proxy.'],
  agy_install_manifest_invalid: ['agy 发布清单无效。', 'The agy release manifest is invalid.'],
  agy_install_download_failed: ['下载 agy 失败，请检查网络或代理后重试。', 'Downloading agy failed — check the network or proxy and retry.'],
  agy_install_too_large: ['agy 下载体积超出限制。', 'The agy download exceeded the size limit.'],
  agy_install_checksum_mismatch: ['agy 校验失败，已中止安装。', 'The agy checksum failed; installation was aborted.'],
  agy_install_extract_failed: ['解压 agy 失败。', 'Extracting agy failed.'],
  agy_install_write_failed: ['写入 agy 失败，请检查目录权限。', 'Writing agy failed — check directory permissions.'],
};

export default {
  async mount(target, props) {
    const zh = props.locale === 'zh';
    const t = (cn, en) => (zh ? cn : en);
    const call = typeof props.callApi === 'function' ? props.callApi : null;

    const card = el('div', 'glass-card rounded-2xl overflow-hidden mb-4');
    const layout = el('div', 'flex flex-col gap-4 p-5');
    const body = el('div', 'min-w-0 flex-1 space-y-3');

    const header = el('div', 'flex flex-wrap items-center gap-2');
    header.append(
      el('p', 'text-lg font-bold tracking-tight text-foreground', t('本地 Antigravity CLI（ACP）桥', 'Local Antigravity CLI (ACP) bridge')),
      el('span', BADGE_BASE + ' ' + BADGE_OUTLINE + ' border-amber-500/40 text-amber-600', t('实验原型', 'Experimental')),
      el('span', BADGE_BASE + ' ' + BADGE_SECONDARY, 'API key'),
    );
    body.append(header);

    body.append(el('p', 'max-w-md truncate text-xs font-medium text-muted-foreground/60', props.plugin?.version ? 'v' + props.plugin.version : ''));
    body.append(el('p', 'max-w-md text-xs text-muted-foreground',
      t('通过官方 agy 二进制以 ACP stdio 提供纯文本对话，走 Gemini API key 配额或已登录的 Google 账号。',
        'Text-only chat through the official agy binary over ACP stdio, billed to the Gemini API key or the signed-in Google account.')));

    const statusLine = el('p', 'max-w-md text-xs font-medium text-muted-foreground', '');
    body.append(statusLine);
    // Synced model list (collapsed by default) and credential fingerprint.
    const modelsBox = el('details', 'max-w-md text-xs text-muted-foreground');
    modelsBox.append(el('summary', null, t('模型列表', 'Model list')));
    const modelsList = el('ul', 'list-disc pl-5');
    modelsBox.append(modelsList);
    const restoreAll = el('button', BUTTON_BASE + ' ' + BUTTON_OUTLINE + ' mt-1 px-2 py-0.5 text-[10px]',
      t('恢复全部', 'Restore all'));
    restoreAll.type = 'button';
    restoreAll.hidden = true;
    modelsBox.append(restoreAll);
    modelsBox.hidden = true;
    body.append(modelsBox);

    const binaryInput = el('input', INPUT_CLASS);
    binaryInput.type = 'text';
    binaryInput.placeholder = t('/绝对路径/to/agy', '/absolute/path/to/agy');
    const keyInput = el('input', INPUT_CLASS);
    keyInput.type = 'password';
    keyInput.placeholder = t('Gemini API key（可选，留空沿用现有密钥或环境变量）',
      'Gemini API key (optional; leave empty to keep the stored key or environment variable)');
    keyInput.setAttribute('autocomplete', 'new-password');
    keyInput.value = ''; // the stored apiKey is never rendered back into the form
    // 登录方式 segmented toggle: the choice persists per connect call as the
    // sidecar's authMethod (reported back by /status). Google-account mode
    // hides the key input entirely — its credential is the CLI's own browser
    // login, verified by connect through one real ACP handshake. The account
    // email is shown only when that handshake explicitly provided one;
    // otherwise the explicit 账号邮箱未提供 placeholder is shown.
    let authMode = 'gemini-api-key';
    const OAUTH_LOGIN_HINT = ['请先在终端运行一次 agy 完成浏览器登录', 'Run agy once in a terminal to complete the browser sign-in first'];
    const authToggle = el('div', 'flex max-w-md items-center gap-2');
    const keyModeButton = el('button', BUTTON_BASE + ' ' + BUTTON_OUTLINE, t('API key', 'API key'));
    const oauthModeButton = el('button', BUTTON_BASE + ' ' + BUTTON_OUTLINE, t('Google 账号', 'Google account'));
    keyModeButton.type = oauthModeButton.type = 'button';
    authToggle.append(keyModeButton, oauthModeButton);
    const accountLine = el('p', 'max-w-md truncate text-xs font-semibold text-foreground', '');
    const form = el('div', 'max-w-md space-y-2');
    form.append(binaryInput, keyInput);
    body.append(authToggle, accountLine, form);

    const renderAuthMode = () => {
      const oauth = authMode === 'oauth-personal';
      keyInput.hidden = oauth;
      accountLine.hidden = !oauth || !accountLine.textContent;
      keyModeButton.className = BUTTON_BASE + ' ' + BUTTON_OUTLINE + (oauth ? ' opacity-60' : ' border-primary/60 bg-input/80');
      oauthModeButton.className = BUTTON_BASE + ' ' + BUTTON_OUTLINE + (oauth ? ' border-primary/60 bg-input/80' : ' opacity-60');
      keyModeButton.setAttribute('aria-pressed', String(!oauth));
      oauthModeButton.setAttribute('aria-pressed', String(oauth));
    };
    keyModeButton.onclick = () => { authMode = 'gemini-api-key'; renderAuthMode(); };
    oauthModeButton.onclick = () => { authMode = 'oauth-personal'; renderAuthMode(); };

    const statusText = status => {
      if (status?.installing) {
        return t('正在自动安装 agy（官方发布，SHA-512 校验）…', 'Installing agy automatically (official release, SHA-512 verified)…');
      }
      if (!status || status.enabled !== true) {
        return t('未启用 — 填写 binary 后按连接', 'Not enabled — fill in the binary path and press Connect');
      }
      const parts = [status.loaded ? t('已连接', 'Connected') : t('已启用，等待首个请求', 'Enabled, waiting for the first request')];
      if (status.binaryFound === false) parts.push(t('binary 未找到', 'binary not found'));
      else if (status.version) parts.push(`agy ${status.version}`);
      if (Array.isArray(status.models) && status.models.length) {
        // The count stays the TOTAL catalog size; hidden ones are extra info.
        const hiddenCount = Array.isArray(status.hiddenModels) ? status.hiddenModels.length : 0;
        parts.push(t(`${status.models.length} 个模型`, `${status.models.length} models`) +
          (hiddenCount > 0 ? t(`（已隐藏 ${hiddenCount}）`, ` (${hiddenCount} hidden)`) : ''));
      } else if (typeof status.modelsSyncedAt === 'number') {
        parts.push(t('0 个模型', '0 models'));
      }
      // Credential line: oauth pools report the handshake-verified account
      // (or the explicit not-provided placeholder); API-key pools keep the
      // fingerprint line.
      if (status?.authMethod === 'oauth-personal') {
        parts.push(status.accountEmail
          ? t(`账号 ${status.accountEmail}`, `account ${status.accountEmail}`)
          : t('账号邮箱未提供', 'account email not provided'));
      } else if (status.apiKeyFingerprint) {
        parts.push(t(`AI Studio key 凭据 ${status.apiKeyFingerprint}…`, `AI Studio key credential ${status.apiKeyFingerprint}…`));
      } else if (status.apiKeyConfigured !== true) parts.push(t('缺少 API key', 'no API key'));
      if (status.lastError?.code) parts.push(t(`上次错误 ${status.lastError.code}`, `last error ${status.lastError.code}`));
      return parts.join(' · ');
    };

    const message = el('p', 'max-w-md text-xs text-destructive', '');
    const notice = el('p', 'max-w-md text-xs font-medium text-emerald-600', '');
    const setMessage = text => { message.textContent = text || ''; };
    const setNotice = text => { notice.textContent = text || ''; };
    const errorText = error => {
      const code = error?.reason ?? error?.code;
      // OAuth login failures surface the terminal sign-in hint instead of the
      // API-key hint; every other code keeps its static mapping.
      if (code === 'acp_auth_required' && authMode === 'oauth-personal') return t(OAUTH_LOGIN_HINT[0], OAUTH_LOGIN_HINT[1]);
      const hint = typeof code === 'string' ? CODE_HINTS[code] : null;
      if (hint) return t(hint[0], hint[1]);
      return typeof code === 'string' ? `${t('操作失败', 'The action failed')} (${code})` : t('操作失败', 'The action failed');
    };

    const connect = el('button', BUTTON_BASE + ' ' + BUTTON_OUTLINE, t('连接', 'Connect'));
    const sync = el('button', BUTTON_BASE + ' ' + BUTTON_OUTLINE, t('同步模型', 'Sync models'));
    const disconnect = el('button', BUTTON_BASE + ' ' + BUTTON_DESTRUCTIVE, t('断开', 'Disconnect'));
    // Manual install / retry: shown only while no agy is detected anywhere or
    // the last auto-install failed. The first card view auto-starts it.
    const install = el('button', BUTTON_BASE + ' ' + BUTTON_OUTLINE, t('安装 agy', 'Install agy'));
    install.hidden = true;
    for (const button of [connect, sync, disconnect, install]) button.type = 'button';
    const controls = [connect, sync, disconnect, install];
    const buttons = el('div', 'flex flex-wrap items-center gap-2');
    buttons.append(connect, sync, disconnect, install);
    body.append(buttons, notice, message);

    let busyDepth = 0;
    let latestStatus = null;
    let installingNow = false;
    let wasInstalling = false;
    let pollTimer = null;
    const BUSY_LABELS = new Map([[connect, t('连接中…', 'Connecting…')], [sync, t('同步中…', 'Syncing…')], [disconnect, t('断开中…', 'Disconnecting…')], [install, t('安装中…', 'Installing…')]]);
    // Per-model visibility controls live inside the freshly rendered list;
    // setBusy keeps them disabled together with the three fixed actions and
    // the auth-mode toggle.
    let rowButtons = [];
    let currentHiddenIds = [];
    const applyDisabled = () => {
      const busy = busyDepth > 0;
      for (const button of [...controls, ...rowButtons, restoreAll, keyModeButton, oauthModeButton]) {
        // A running background install locks the actions too: connecting a
        // half-downloaded binary must not be possible from the card.
        button.disabled = busy || !call || installingNow;
        const busyLabel = BUSY_LABELS.get(button);
        if (busy && busyLabel) button.textContent = busyLabel;
      }
      if (!busy) {
        connect.textContent = t('连接', 'Connect');
        sync.textContent = t('同步模型', 'Sync models');
        disconnect.textContent = t('断开', 'Disconnect');
        install.textContent = installingNow ? t('安装中…', 'Installing…') : t('安装 agy', 'Install agy');
      }
    };
    const setBusy = active => {
      busyDepth = Math.max(0, busyDepth + (active ? 1 : -1));
      applyDisabled();
      props.onBusy?.(busyDepth > 0);
    };

    const renderStatus = status => {
      latestStatus = status;
      installingNow = Boolean(status?.installing);
      // Poll while the background download runs; surface the outcome once it
      // finishes (success prefills the detected binary, failure shows the hint).
      if (installingNow && !pollTimer && !target.__agyDisposed) {
        pollTimer = setInterval(() => { void refresh(); }, 3000);
        target.__agyPollTimer = pollTimer;
      } else if (!installingNow && pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
        target.__agyPollTimer = null;
      }
      // A detected binary supersedes any stale install failure: the operator
      // may have installed agy manually after a failed auto-install.
      const binaryPresent = Boolean(status?.binary || status?.detectedBinary);
      if (wasInstalling && !installingNow) {
        if (status?.detectedBinary) setNotice(t('agy 已安装，可直接连接', 'agy installed — press Connect'));
        else if (status?.installError && !binaryPresent) setMessage(errorText({ code: status.installError.code }));
      }
      wasInstalling = installingNow;
      install.hidden = binaryPresent;
      if (status?.installError && !installingNow && !binaryPresent) setMessage(errorText({ code: status.installError.code }));
      statusLine.textContent = statusText(status);
      // ACP key auth exposes no account email; the fingerprint lets the
      // operator match WHICH key is connected without revealing it.
      statusLine.title = status?.apiKeyFingerprint
        ? t('凭据指纹 = Gemini API key 的 SHA-256 前 10 位', 'credential fingerprint = first 10 hex of the Gemini API key SHA-256')
        : '';
      const modelEntries = Array.isArray(status?.models) ? status.models : [];
      currentHiddenIds = Array.isArray(status?.hiddenModels) ? status.hiddenModels.filter(id =>
        typeof id === 'string' && modelEntries.some(model => model?.id === id)) : [];
      const hiddenSet = new Set(currentHiddenIds);
      rowButtons = [];
      const busy = busyDepth > 0;
      modelsList.replaceChildren(...modelEntries.map(model => {
        const id = model?.id ?? '';
        const isHidden = hiddenSet.has(id);
        const li = el('li', isHidden ? 'text-muted-foreground/50' : null,
          (typeof model?.name === 'string' && model.name ? model.name + ' · ' : '') + id +
          (isHidden ? t(' 已隐藏', ' hidden') : ''));
        const toggle = el('button', BUTTON_BASE + ' ' + BUTTON_OUTLINE + ' ml-2 px-2 py-0.5 text-[10px]',
          isHidden ? t('恢复', 'Restore') : t('隐藏', 'Hide'));
        toggle.type = 'button';
        toggle.disabled = busy || !call || installingNow;
        toggle.onclick = () => runAction('/models/visibility', isHidden ? { restore: [id] } : { hide: [id] });
        rowButtons.push(toggle);
        li.append(toggle);
        return li;
      }));
      restoreAll.hidden = modelEntries.length === 0 || currentHiddenIds.length === 0;
      restoreAll.disabled = busy || !call || installingNow;
      restoreAll.onclick = () => runAction('/models/visibility', { restore: [...currentHiddenIds] });
      modelsBox.hidden = modelEntries.length === 0;
      // The persisted auth method wins after every status refresh (it is what
      // the last connect call stored), then the account line re-renders.
      if (status?.authMethod === 'oauth-personal' || status?.authMethod === 'gemini-api-key') authMode = status.authMethod;
      accountLine.textContent = status?.accountEmail ? t('账号：', 'Account: ') + status.accountEmail
        : status?.authMethod === 'oauth-personal' ? t('账号邮箱未提供', 'account email not provided') : '';
      renderAuthMode();
      // Prefill only the binary path (an operator setting, not a secret) —
      // the sidecar's configured path, or an agy detected at the official
      // default location; the key input is never populated from stored state.
      const prefill = typeof status?.binary === 'string' ? status.binary
        : typeof status?.detectedBinary === 'string' ? status.detectedBinary : null;
      if (!binaryInput.value && prefill) binaryInput.value = prefill;
      // Re-apply the lock AFTER the row buttons are rebuilt so a running
      // install disables the freshly created visibility toggles too.
      applyDisabled();
    };

    const refresh = async () => {
      if (target.__agyDisposed) return;
      if (!call) {
        renderStatus(null);
        return;
      }
      try {
        renderStatus(await call('/status', { timeoutMs: 15000 }));
      } catch (error) {
        setMessage(errorText(error));
      }
    };

    const runAction = async (path, requestBody, onDone) => {
      if (!call || busyDepth > 0) return;
      setMessage('');
      setNotice('');
      setBusy(true);
      try {
        const response = await call(path, {
          method: 'POST',
          body: JSON.stringify(requestBody ?? {}),
          timeoutMs: 30000,
        });
        const doneNotice = onDone?.(response);
        await refresh();
        // Explicit confirmation: these actions are idempotent, so without a
        // success notice a repeated click looks like it did nothing.
        const done = new Date();
        const at = `${String(done.getHours()).padStart(2, '0')}:${String(done.getMinutes()).padStart(2, '0')}:${String(done.getSeconds()).padStart(2, '0')}`;
        setNotice(`${doneNotice ?? t('已完成', 'Done')} · ${at}`);
      } catch (error) {
        setMessage(errorText(error));
      } finally {
        setBusy(false);
      }
    };

    connect.onclick = () => runAction('/connect', {
      ...(binaryInput.value.trim() ? { binary: binaryInput.value.trim() } : {}),
      authMethod: authMode,
      // The API key only ever travels in gemini-api-key mode; oauth-personal
      // mode never sends credential material.
      ...(authMode === 'gemini-api-key' && keyInput.value ? { apiKey: keyInput.value } : {}),
    }, response => {
      keyInput.value = ''; // never keep the typed key in the DOM
      return t(`已连接（agy ${response?.version ?? ''}）`, `Connected (agy ${response?.version ?? ''})`);
    });
    sync.onclick = () => runAction('/models/sync', {}, response =>
      t(`已同步 ${response?.models?.length ?? 0} 个模型`, `Synced ${response?.models?.length ?? 0} models`));
    disconnect.onclick = () => runAction('/disconnect', {}, () => t('已断开', 'Disconnected'));
    install.onclick = () => runAction('/install', {}, () => t('已开始安装 agy', 'agy install started'));
    setBusy(false);

    const section = el('details', 'max-w-md text-xs text-muted-foreground');
    section.append(el('summary', 'cursor-pointer select-none font-medium', t('配置说明', 'Setup instructions')));
    section.append(el('p', 'mt-2 text-xs text-muted-foreground',
      t('在上方填入 agy 的绝对路径（可选 API key）并按连接，写入 CCR 配置目录的 gemini-agy-acp.json（API key 以 0600 权限保存）；断开仅停用，不删除配置。',
        'Enter the absolute agy path above (optionally an API key) and press Connect. This writes gemini-agy-acp.json in the CCR config directory (the API key is stored with 0600 permissions); Disconnect only disables, it does not delete settings.')));
    section.append(el('p', 'max-w-md text-[11px] text-muted-foreground/60',
      t('Google 账号模式需先在终端运行一次 agy 完成浏览器登录；连接时通过一次真实 ACP 握手验证登录状态，账号邮箱仅在本次握手明确提供时显示。请为主路由配置 enableFallback: false 的隔离实例。',
        'Google account mode requires running agy once in a terminal to complete the browser sign-in first; Connect verifies the login with one real ACP handshake. The account email is shown only when that handshake explicitly provides it. Run it as a primary route on an isolated instance with enableFallback: false.')));

    body.append(section);
    layout.append(body);
    card.append(layout);
    target.append(card);

    await refresh();
    // First view with no agy anywhere: start the official install right away.
    // A previous failure is never retried automatically — the Install button
    // is the explicit retry, so a broken network cannot loop downloads.
    const first = latestStatus;
    if (call && first && !first.binary && !first.detectedBinary && !first.installing && !first.installError) {
      await runAction('/install', {}, () => t('已开始自动安装 agy', 'Automatic agy install started'));
    }
  },
  unmount(el) {
    el.__agyDisposed = true;
    if (el.__agyPollTimer) {
      clearInterval(el.__agyPollTimer);
      el.__agyPollTimer = null;
    }
    el.replaceChildren();
  },
};
