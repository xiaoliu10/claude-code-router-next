// Read-only management card: a self-contained ES chunk with no imports and no
// network access. It only explains the local opt-in contract; the operator's
// sidecar file and environment remain the single source of truth.
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

export default {
  mount(target, props) {
    const zh = props.locale === 'zh';
    const t = (en, cn) => (zh ? cn : en);
    const root = el('div', 'ccr-agy-acp-card');
    const style = root.style;
    style.font = '13px/1.6 -apple-system, "Segoe UI", sans-serif';
    style.color = 'inherit';

    const head = el('div', null, null);
    head.style.display = 'flex';
    head.style.alignItems = 'center';
    head.style.gap = '8px';
    const title = el('strong', null, t('Local Antigravity CLI (ACP) bridge', '本地 Antigravity CLI（ACP）桥'));
    const badge = el('span', null, props.disabled ? t('Disabled', '未启用') : t('Enabled', '已启用'));
    badge.style.padding = '1px 8px';
    badge.style.borderRadius = '999px';
    badge.style.fontSize = '12px';
    badge.style.border = '1px solid currentColor';
    if (!props.disabled) badge.style.opacity = '0.85'; else badge.style.opacity = '0.6';
    head.append(title, badge);
    root.append(head);

    if (props.plugin?.version) root.append(el('div', null, t('Version', '版本') + ': v' + props.plugin.version));

    for (const line of props.disabled ? [
      t('This prototype is off until the operator enables it. In the CCR config directory create gemini-agy-acp.json:',
        '原型在运维者显式启用前保持关闭。请在 CCR 配置目录创建 gemini-agy-acp.json：'),
    ] : [
      t('Workers start only for requests routed to this provider; API-key quotas and charges apply.',
        '仅路由到本供应商的请求会启动 worker；调用计入 API key 配额与费用。'),
      t('Rotate the key by updating the environment and restarting the isolated CCR host.',
        '更换密钥需更新环境变量并重启隔离的 CCR 实例。'),
    ]) root.append(el('p', null, line));

    const code = el('pre', null, JSON.stringify({
      enabled: true, binary: '/absolute/path/to/agy', authMethod: 'gemini-api-key', maxWorkers: 1, timeoutMs: 60000,
    }, null, 2));
    code.style.background = 'rgba(127,127,127,.12)';
    code.style.padding = '8px 10px';
    code.style.borderRadius = '6px';
    code.style.overflowX = 'auto';
    code.style.whiteSpace = 'pre-wrap';
    root.append(code);

    root.append(el('p', null, t(
      'Set GEMINI_API_KEY in the CCR process environment and route a primary model to gemini-agy-acp. Consumer OAuth and subscriptions are unsupported.',
      '在 CCR 进程环境设置 GEMINI_API_KEY，并把主路由模型指向 gemini-agy-acp。不支持个人订阅与浏览器 OAuth。')));

    target.append(root);
    this._root = root;
  },
  unmount(el) {
    this._root?.remove();
    this._root = null;
    el.replaceChildren();
  },
};
