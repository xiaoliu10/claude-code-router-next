// Read-only management card. It renders inside the host settings page, so the
// host's global stylesheet (Tailwind utilities + the custom .glass-card rule)
// is part of its runtime environment; class names mirror the gemini-oauth card
// conventions (ui/badge, ui/card lists inlined). Import-free, network-free,
// and all rendered strings go through textContent, never markup assignment.
const BADGE_BASE = 'inline-flex items-center rounded-lg border px-2.5 py-0.5 text-[10px] font-bold transition-colors';
const BADGE_OUTLINE = 'border-white/10 text-foreground bg-white/5';
const BADGE_SECONDARY = 'border-white/5 bg-white/5 text-muted-foreground';

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

export default {
  mount(target, props) {
    const zh = props.locale === 'zh';
    const t = (cn, en) => (zh ? cn : en);
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
      t('通过官方 agy 二进制以 ACP stdio 提供纯文本对话，走 Gemini API key 配额。', 'Text-only chat through the official agy binary over ACP stdio, billed to the Gemini API key.')));

    const section = el('details', 'max-w-md text-xs text-muted-foreground');
    section.append(el('summary', 'cursor-pointer select-none font-medium', t('配置说明', 'Setup instructions')));
    section.append(el('p', 'mt-2 text-xs text-muted-foreground',
      t('在 CCR 配置目录创建 gemini-agy-acp.json，将 binary 替换为本机 agy 的绝对路径。', 'Create gemini-agy-acp.json in the CCR config directory. Set binary to the absolute path of your agy executable.')));
    const code = el('pre', 'max-w-md overflow-x-auto rounded-lg bg-white/5 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground',
      JSON.stringify({ enabled: true, binary: '/absolute/path/to/agy', authMethod: 'gemini-api-key', maxWorkers: 1, timeoutMs: 60000 }, null, 2));
    section.append(code);
    section.append(el('p', 'text-[11px] text-muted-foreground', t('在 CCR 进程环境设置 GEMINI_API_KEY，然后重启隔离实例。', 'Set GEMINI_API_KEY in the CCR process environment, then restart the isolated instance.')));
    section.append(el('p', 'max-w-md text-[11px] text-muted-foreground/60',
      t('不支持个人订阅与浏览器 OAuth；请为主路由配置 enableFallback: false 的隔离实例。', 'Consumer OAuth and subscriptions are unsupported; run it as a primary route on an isolated instance with enableFallback: false.')));

    body.append(section);
    layout.append(body);
    card.append(layout);
    target.append(card);

  },
  unmount(el) {
    el.replaceChildren();
  },
};
