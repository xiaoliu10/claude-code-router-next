(function () {
  'use strict';

  const tiers = new Map([['follow', '跟随请求'], ['standard', '标准'], ['priority', '快速（Fast）']]);

  function mount(invoke) {
    const root = document.createElement('div');
    root.className = 'codex-tier';
    const label = document.createElement('label');
    label.textContent = '服务层级';
    label.htmlFor = 'codex-tier-select';
    const select = document.createElement('select');
    select.id = label.htmlFor;
    select.className = 'btn';
    for (const [value, text] of tiers) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      select.appendChild(option);
    }
    const hint = document.createElement('span');
    hint.id = 'codex-tier-hint';
    hint.textContent = '快速模式可能消耗更多额度。';
    const status = document.createElement('span');
    status.setAttribute('role', 'status');
    for (const node of [label, select, hint, status]) root.appendChild(node);

    let host = null;
    let generation = 0;
    let confirmed = null;
    let saving = false;
    let readAfterSave = false;

    function paint(message, error = false) {
      select.value = confirmed || '';
      select.hidden = confirmed === null;
      select.disabled = select.hidden || saving;
      hint.hidden = confirmed !== 'priority';
      if (hint.hidden) select.removeAttribute('aria-describedby');
      else select.setAttribute('aria-describedby', hint.id);
      status.className = error ? 'inline-msg' : '';
      status.textContent = message;
    }

    function failure(err, fallback) {
      return (err?.message || err) === 'codex_tier_upgrade_required'
        ? '请更新 CCR 网关和 Codex 插件以使用服务层级。' : fallback;
    }

    async function read() {
      if (!host) return;
      if (saving) { readAfterSave = true; return; }
      const current = ++generation;
      confirmed = null;
      // Eligibility is confirmed by the bridge. A same-name ordinary provider
      // should never flash a selector or a default tier while this read runs.
      root.hidden = true;
      paint('');
      try {
        const result = await invoke('codex_service_tier_get');
        if (current !== generation || result === null) return;
        if (!tiers.has(result?.tier)) throw new Error();
        confirmed = result.tier;
        paint('');
      } catch (err) {
        if (current !== generation) return;
        paint(failure(err, '未能读取服务层级。'), true);
      }
      root.hidden = false;
    }

    select.addEventListener('change', async function () {
      const requested = select.value;
      select.value = confirmed || '';
      if (!host || !confirmed || saving || requested === confirmed || !tiers.has(requested)) return;
      const current = generation;
      const hadFocus = document.activeElement === select;
      saving = true;
      paint('保存中…');
      try {
        const result = await invoke('codex_service_tier_set', { tier: requested });
        if (current !== generation) return;
        if (result?.tier !== requested) throw new Error();
        confirmed = result.tier;
        paint('已保存');
      } catch (err) {
        if (current === generation) paint(failure(err, '未能确认保存结果。'), true);
      } finally {
        saving = false;
        select.disabled = confirmed === null;
        if (readAfterSave) { readAfterSave = false; read(); }
        else if (current === generation && hadFocus && document.activeElement === document.body && document.hasFocus()) {
          select.focus();
        }
      }
    });

    function sync(nextHost, refresh) {
      if (host === nextHost) {
        if (refresh) read();
        return;
      }
      ++generation;
      host = nextHost;
      confirmed = null;
      root.hidden = true;
      root.remove();
      if (!host) return;
      host.appendChild(root);
      read();
    }
    return { sync };
  }

  globalThis.CodexServiceTierUI = { mount };
})();
