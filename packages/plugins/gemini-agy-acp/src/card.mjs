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
      t('通过官方 agy 二进制以 ACP stdio 提供纯文本对话，走 Gemini API key 配额。',
        'Text-only chat through the official agy binary over ACP stdio, billed to the Gemini API key.')));

    const statusLine = el('p', 'max-w-md text-xs font-medium text-muted-foreground', '');
    body.append(statusLine);
    // Synced model list (collapsed by default) and credential fingerprint.
    const modelsBox = el('details', 'max-w-md text-xs text-muted-foreground');
    modelsBox.append(el('summary', null, t('模型列表', 'Model list')));
    const modelsList = el('ul', 'list-disc pl-5');
    modelsBox.append(modelsList);
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
    const form = el('div', 'max-w-md space-y-2');
    form.append(binaryInput, keyInput);
    body.append(form);

    const statusText = status => {
      if (!status || status.enabled !== true) {
        return t('未启用 — 填写 binary 后按连接', 'Not enabled — fill in the binary path and press Connect');
      }
      const parts = [status.loaded ? t('已连接', 'Connected') : t('已启用，等待首个请求', 'Enabled, waiting for the first request')];
      if (status.binaryFound === false) parts.push(t('binary 未找到', 'binary not found'));
      else if (status.version) parts.push(`agy ${status.version}`);
      if (Array.isArray(status.models) && status.models.length) {
        parts.push(t(`${status.models.length} 个模型`, `${status.models.length} models`));
      } else if (typeof status.modelsSyncedAt === 'number') {
        parts.push(t('0 个模型', '0 models'));
      }
      if (status.apiKeyFingerprint) parts.push(t(`凭据 ${status.apiKeyFingerprint}…`, `credential ${status.apiKeyFingerprint}…`));
      else if (status.apiKeyConfigured !== true) parts.push(t('缺少 API key', 'no API key'));
      if (status.lastError?.code) parts.push(t(`上次错误 ${status.lastError.code}`, `last error ${status.lastError.code}`));
      return parts.join(' · ');
    };

    const message = el('p', 'max-w-md text-xs text-destructive', '');
    const notice = el('p', 'max-w-md text-xs font-medium text-emerald-600', '');
    const setMessage = text => { message.textContent = text || ''; };
    const setNotice = text => { notice.textContent = text || ''; };
    const errorText = error => {
      const code = error?.reason ?? error?.code;
      const hint = typeof code === 'string' ? CODE_HINTS[code] : null;
      if (hint) return t(hint[0], hint[1]);
      return typeof code === 'string' ? `${t('操作失败', 'The action failed')} (${code})` : t('操作失败', 'The action failed');
    };

    const connect = el('button', BUTTON_BASE + ' ' + BUTTON_OUTLINE, t('连接', 'Connect'));
    const sync = el('button', BUTTON_BASE + ' ' + BUTTON_OUTLINE, t('同步模型', 'Sync models'));
    const disconnect = el('button', BUTTON_BASE + ' ' + BUTTON_DESTRUCTIVE, t('断开', 'Disconnect'));
    for (const button of [connect, sync, disconnect]) button.type = 'button';
    const controls = [connect, sync, disconnect];
    const buttons = el('div', 'flex flex-wrap items-center gap-2');
    buttons.append(connect, sync, disconnect);
    body.append(buttons, notice, message);

    let busyDepth = 0;
    const BUSY_LABELS = new Map([[connect, t('连接中…', 'Connecting…')], [sync, t('同步中…', 'Syncing…')], [disconnect, t('断开中…', 'Disconnecting…')]]);
    const setBusy = active => {
      busyDepth = Math.max(0, busyDepth + (active ? 1 : -1));
      const busy = busyDepth > 0;
      for (const button of controls) {
        button.disabled = busy || !call;
        if (busy) button.textContent = BUSY_LABELS.get(button);
      }
      if (!busy) {
        connect.textContent = t('连接', 'Connect');
        sync.textContent = t('同步模型', 'Sync models');
        disconnect.textContent = t('断开', 'Disconnect');
      }
      props.onBusy?.(busy);
    };

    const renderStatus = status => {
      statusLine.textContent = statusText(status);
      // ACP key auth exposes no account email; the fingerprint lets the
      // operator match WHICH key is connected without revealing it.
      statusLine.title = status?.apiKeyFingerprint
        ? t('凭据指纹 = Gemini API key 的 SHA-256 前 10 位', 'credential fingerprint = first 10 hex of the Gemini API key SHA-256')
        : '';
      const modelEntries = Array.isArray(status?.models) ? status.models : [];
      modelsList.replaceChildren(...modelEntries.map(model => {
        const li = el('li', null, (typeof model?.name === 'string' && model.name ? model.name + ' ' : '') + (model?.id ?? ''));
        return li;
      }));
      modelsBox.hidden = modelEntries.length === 0;
      // Prefill only the binary path (an operator setting, not a secret);
      // the key input is never populated from stored state.
      if (!binaryInput.value && typeof status?.binary === 'string') binaryInput.value = status.binary;
    };

    const refresh = async () => {
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
      ...(keyInput.value ? { apiKey: keyInput.value } : {}),
    }, response => {
      keyInput.value = ''; // never keep the typed key in the DOM
      return t(`已连接（agy ${response?.version ?? ''}）`, `Connected (agy ${response?.version ?? ''})`);
    });
    sync.onclick = () => runAction('/models/sync', {}, response =>
      t(`已同步 ${response?.models?.length ?? 0} 个模型`, `Synced ${response?.models?.length ?? 0} models`));
    disconnect.onclick = () => runAction('/disconnect', {}, () => t('已断开', 'Disconnected'));
    setBusy(false);

    const section = el('details', 'max-w-md text-xs text-muted-foreground');
    section.append(el('summary', 'cursor-pointer select-none font-medium', t('配置说明', 'Setup instructions')));
    section.append(el('p', 'mt-2 text-xs text-muted-foreground',
      t('在上方填入 agy 的绝对路径（可选 API key）并按连接，写入 CCR 配置目录的 gemini-agy-acp.json（API key 以 0600 权限保存）；断开仅停用，不删除配置。',
        'Enter the absolute agy path above (optionally an API key) and press Connect. This writes gemini-agy-acp.json in the CCR config directory (the API key is stored with 0600 permissions); Disconnect only disables, it does not delete settings.')));
    section.append(el('p', 'max-w-md text-[11px] text-muted-foreground/60',
      t('不支持个人订阅与浏览器 OAuth；请为主路由配置 enableFallback: false 的隔离实例。', 'Consumer OAuth and subscriptions are unsupported; run it as a primary route on an isolated instance with enableFallback: false.')));

    body.append(section);
    layout.append(body);
    card.append(layout);
    target.append(card);

    await refresh();
  },
  unmount(el) {
    el.replaceChildren();
  },
};
