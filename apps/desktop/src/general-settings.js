(function () {
  'use strict';

  // Native snapshots contain effective scalar values. The preview uses the
  // same defaults as the General tab in SettingsPage.tsx.
  const defaults = {
    LOG: false, LOG_LEVEL: 'error', statusLineEnabled: false, tokenSpeedEnabled: false,
    disableAttributionHeader: true, enableConcurrencyPriority: false, concurrencyThreshold: 3,
    WAKEUP_ENABLED: false, WAKEUP_TIME: '06:00', CLAUDE_PATH: '', HOST: '', PORT: 3456,
    API_TIMEOUT_MS: 600000, PROBE_TIMEOUT_MS: 15000, PROBE_SLOW_THRESHOLD_MS: 3000,
    ContextWindow: 200000, PROXY_GLOBAL_ENABLED: true, CUSTOM_ROUTER_PATH: '',
  };
  const secretFlags = { APIKEY: 'apiKeyConfigured', PROXY_URL: 'proxyConfigured' };
  const owns = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

  function validationError(key, value) {
    if (typeof defaults[key] === 'number') {
      const max = key === 'PORT' ? 65535 : 2147483647;
      return Number.isInteger(value) && value >= 1 && value <= max ? '' : '请输入 1 到 ' + max + ' 之间的整数';
    }
    if (typeof value === 'string' && (value.length > 4096 || /[\x00-\x1f\x7f]/.test(value))) return '输入过长或包含控制字符';
    if (key === 'WAKEUP_TIME' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return '请使用 HH:MM 格式';
    if (key === 'LOG_LEVEL' && !['fatal', 'error', 'warn', 'info', 'debug', 'trace'].includes(value)) return '请选择日志级别';
    if (owns(secretFlags, key) && value !== value.trim()) return '请移除首尾空白';
    if (key === 'PROXY_URL' && value && !/\$\{[^}]+\}|\$[A-Z_]/.test(value)) {
      try { if (['http:', 'https:'].includes(new URL(value).protocol)) return ''; } catch { /* Fixed error avoids echoing proxy credentials. */ }
      return '请输入 HTTP(S) 代理地址或环境变量';
    }
    return '';
  }

  function preview() {
    const state = { values: { ...defaults }, portFromEnv: false, apiKeyConfigured: false, proxyConfigured: false };
    let revision = 1;
    const snapshot = () => ({ ...state, values: { ...state.values }, revision: String(revision) });
    return async function (command, args) {
      if (command === 'general_settings_snapshot') return snapshot();
      if (command !== 'general_settings_save') return null;
      if (args.revision !== String(revision)) throw new Error('Settings draft is stale; refresh the panel and retry');
      const changes = Object.entries(args.changes);
      for (const [key, value] of changes) {
        const type = owns(secretFlags, key) ? 'string' : typeof defaults[key];
        if ((!owns(defaults, key) && !owns(secretFlags, key)) || typeof value !== type || validationError(key, value)) {
          throw new Error('Invalid general settings changes');
        }
      }
      for (const [key, value] of changes) {
        if (owns(secretFlags, key)) state[secretFlags[key]] = value !== '';
        else state.values[key] = value;
      }
      revision++;
      return snapshot();
    };
  }

  function mount(doc, invoke) {
    const id = key => doc.getElementById(key);
    const form = id('settings-body'), saveButton = id('settings-save'), refreshButton = id('settings-refresh');
    const message = id('settings-msg');
    const fields = Array.from(form.querySelectorAll('[data-setting]'));
    const secrets = [['APIKEY', 'set-apikey', 'settings-key-status'], ['PROXY_URL', 'set-proxy-url', 'settings-proxy-status']].map(([key, inputId, status]) => ({
      key, input: id(inputId), action: id(inputId + '-action'), label: id(inputId + '-label'), status: id(status),
    }));
    let snapshot = null, busy = false, needsReload = false;

    function feedback(text, tone) {
      message.textContent = text;
      message.hidden = !text;
      message.setAttribute('data-tone', tone || '');
    }
    function valueOf(field) {
      const type = field.getAttribute('type');
      if (type === 'checkbox') return field.checked;
      if (field.dataset.setting === 'PORT' && snapshot.portFromEnv && field.value === '' && !field.validity?.badInput) return undefined;
      if (type === 'number') return field.value.trim() ? Number(field.value) : NaN;
      return field.value;
    }
    function dirtyFields() {
      return snapshot ? fields.filter(field => valueOf(field) !== snapshot.values[field.dataset.setting]) : [];
    }
    function updateControls() {
      const locked = !invoke || busy || !snapshot;
      form.hidden = !snapshot;
      form.setAttribute('aria-busy', String(busy));
      refreshButton.disabled = !invoke || busy;
      fields.forEach(field => { field.disabled = locked; });
      for (const {key, action, input, label, status} of secrets) {
        action.disabled = locked;
        input.hidden = label.hidden = action.value !== 'replace';
        input.disabled = locked || input.hidden;
        status.textContent = snapshot && snapshot[secretFlags[key]] ? '已配置' : '未配置';
        if (key === 'PROXY_URL' && snapshot && snapshot.proxyConfigured) status.textContent += '（其他代理配置也可能生效）';
      }
      const count = dirtyFields().length + secrets.filter(s => s.action.value !== 'keep').length;
      saveButton.hidden = !snapshot;
      saveButton.disabled = locked || needsReload || count === 0;
      saveButton.textContent = count ? '保存设置（' + count + ' 项）' : '保存设置';
    }
    function edited(event) {
      event.target.removeAttribute('aria-invalid');
      if (!needsReload) feedback('');
      updateControls();
    }
    function adopt(next, keep) {
      if (!next || typeof next.revision !== 'string' || !next.revision || !next.values ||
        typeof next.portFromEnv !== 'boolean' ||
        fields.some(({dataset: {setting}}) => setting === 'PORT' && next.portFromEnv
          ? owns(next.values, 'PORT') : typeof next.values[setting] !== typeof defaults[setting]) ||
        typeof next.apiKeyConfigured !== 'boolean' || typeof next.proxyConfigured !== 'boolean') throw new Error('Invalid projection');
      snapshot = next;
      id('settings-port-status').hidden = !next.portFromEnv;
      if (next.portFromEnv) id('set-port').setAttribute('aria-describedby', 'settings-port-status');
      else id('set-port').removeAttribute('aria-describedby');
      for (const field of fields) {
        if (keep.has(field)) continue;
        const value = next.values[field.dataset.setting];
        if (typeof value === 'boolean') field.checked = value;
        else field.value = value === undefined ? '' : String(value);
        field.removeAttribute('aria-invalid');
      }
      id('settings-revision').textContent = '修订 ' + next.revision;
    }
    async function reload() {
      if (!invoke || busy) return;
      const keep = new Set(dirtyFields());
      busy = true;
      feedback('正在读取设置…');
      updateControls();
      try {
        adopt(await invoke('general_settings_snapshot'), keep);
        needsReload = false;
        const dirty = dirtyFields().length || secrets.some(s => s.action.value !== 'keep');
        feedback(dirty ? '已刷新配置并保留草稿。请核对修改后保存。' : '已读取最新设置。');
      } catch { feedback('设置读取失败。请检查网关连接后刷新。', 'error'); }
      finally { busy = false; updateControls(); }
    }
    function invalid(field, text) {
      field.setAttribute('aria-invalid', 'true');
      feedback(text, 'error');
      field.focus();
    }
    async function save() {
      if (saveButton.disabled) return;
      const changes = {};
      for (const field of dirtyFields()) {
        const key = field.dataset.setting, value = valueOf(field), error = validationError(key, value);
        if (error) return invalid(field, key + '：' + error);
        changes[key] = value;
      }
      for (const {key, input, action} of secrets) {
        if (action.value === 'clear') changes[key] = '';
        if (action.value !== 'replace') continue;
        const error = input.value ? validationError(key, input.value) : '请输入替换值，或选择清除';
        if (error) return invalid(input, key + '：' + error);
        changes[key] = input.value;
      }
      busy = true;
      feedback('正在保存设置…');
      updateControls();
      try {
        adopt(await invoke('general_settings_save', { revision: snapshot.revision, changes }), new Set());
        secrets.forEach(({action, input}) => { action.value = 'keep'; input.value = ''; });
        feedback('设置已保存。服务继续运行。', 'ok');
      } catch (err) {
        const detail = String(err && err.message || err);
        if (/stale|conflict/i.test(detail)) {
          needsReload = true;
          feedback('配置已在其他位置修改。请刷新并核对保留的草稿，再次保存。', 'warn');
        } else if (/could not be confirmed/i.test(detail)) {
          needsReload = true;
          feedback('尚未确认写入结果。请检查网关连接并刷新，核对草稿后再保存。', 'warn');
        } else feedback('设置保存失败。请检查输入和网关连接。草稿已保留。', 'error');
      } finally { busy = false; updateControls(); }
    }
    for (const field of fields) {
      field.addEventListener('input', edited);
      field.addEventListener('change', edited);
    }
    for (const {input, action} of secrets) {
      action.value = 'keep';
      action.addEventListener('change', event => {
        input.value = '';
        input.removeAttribute('aria-invalid');
        edited(event);
      });
      input.addEventListener('input', edited);
    }
    saveButton.addEventListener('click', save);
    refreshButton.addEventListener('click', reload);
    if (!invoke) feedback('桌面 IPC 不可用。', 'error');
    updateControls();
    return { reload };
  }

  globalThis.GeneralSettingsUI = { mount, preview };
})();
