
(function () {
  'use strict';

  function toNum(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }
  function toStr(v) { return typeof v === 'string' && v ? v : null; }
  function pad2(n) { return n < 10 ? '0' + n : String(n); }
  function group(s) { return s.replace(/\B(?=(\d{3})+(?!\d))/g, ','); }


  function normalizeWindow(w) {
    var s = w && typeof w === 'object' ? w : {};
    return { label: toStr(s.label), used: toNum(s.used), limit: toNum(s.limit), remaining: toNum(s.remaining), unit: toStr(s.unit), resetAt: toStr(s.resetAt) };
  }
  function normalizeProvider(p) {
    var s = p && typeof p === 'object' ? p : {};
    return {
      name: toStr(s.name) || '未命名提供方',
      enabled: s.enabled !== false,
      plan: toStr(s.plan),
      status: typeof s.status === 'string' ? s.status : null,
      message: toStr(s.message),
      windows: Array.isArray(s.windows) ? s.windows.map(normalizeWindow) : [],
      updatedAt: toNum(s.updatedAt),
    };
  }
  function normalizeSnapshot(r) {
    var s = r && typeof r === 'object' ? r : {};
    return {
      providers: Array.isArray(s.providers) ? s.providers.map(normalizeProvider) : [],
      updatedAt: toNum(s.updatedAt),
      online: s.online !== false,
      error: toStr(s.error),
    };
  }


  var STATUS_META = { ready: ['就绪', 'ok'], unsupported: ['不支持', 'muted'], unavailable: ['不可用', 'warn'], reauth: ['需重新登录', 'warn'], cooling: ['冷却中', 'warn'] };
  function statusMeta(status) {
    var m = STATUS_META[status];
    return m ? { label: m[0], tone: m[1] } : { label: status || '未知', tone: 'muted' };
  }

  function computePercent(w) {
    var used = toNum(w && w.used), limit = toNum(w && w.limit), remaining = toNum(w && w.remaining);
    if (limit === null || limit <= 0) return null;
    var ratio = used !== null ? used / limit : remaining !== null ? (limit - remaining) / limit : null;
    if (ratio === null || !Number.isFinite(ratio)) return null;
    return Math.min(100, Math.max(0, ratio * 100));
  }
  function formatPercent(pct) {
    var n = toNum(pct);
    return n === null ? null : Math.min(100, Math.max(0, Math.floor(n))) + '%';
  }
  function formatAmount(v) {
    var n = toNum(v);
    if (n === null) return null;
    if (n === 0) return '0';
    var abs = Math.abs(n);
    if (abs < 0.01) return n < 0 ? '-<0.01' : '<0.01';
    var parts = String(Math.round(abs * 100) / 100).split('.');
    return (n < 0 ? '-' : '') + group(parts[0]) + (parts[1] ? '.' + parts[1] : '');
  }
  function formatResetTime(resetAt, now) {
    var t = new Date(toStr(resetAt) || '');
    if (Number.isNaN(t.getTime())) return null;
    var base = typeof now === 'number' ? now : Date.now();
    var diff = t.getTime() - base;
    var relative = null;
    if (diff > 0) {
      var min = Math.ceil(diff / 60000);
      relative = min < 60 ? Math.max(1, min) + ' 分钟后' : min < 1440 ? Math.ceil(min / 60) + ' 小时后' : Math.ceil(min / 1440) + ' 天后';
    }
    return { absolute: (t.getMonth() + 1) + '月' + t.getDate() + '日 ' + pad2(t.getHours()) + ':' + pad2(t.getMinutes()), relative: relative };
  }
  function formatTimestamp(ms) {
    var n = toNum(ms);
    if (n === null) return null;
    var t = new Date(n);
    return (t.getMonth() + 1) + '月' + t.getDate() + '日 ' + pad2(t.getHours()) + ':' + pad2(t.getMinutes()) + ':' + pad2(t.getSeconds());
  }
  function describeWindow(w, now) {
    if (!w || typeof w !== 'object') return '暂无数据';
    var used = toNum(w.used), limit = toNum(w.limit), remaining = toNum(w.remaining);
    var suffix = toStr(w.unit) ? ' ' + toStr(w.unit) : '';
    var parts = [];
    if (used !== null && limit !== null) parts.push('已用 ' + formatAmount(used) + ' / ' + formatAmount(limit) + suffix);
    else if (remaining !== null && limit !== null) parts.push('剩余 ' + formatAmount(remaining) + ' / ' + formatAmount(limit) + suffix);
    else if (remaining !== null) parts.push('剩余 ' + formatAmount(remaining) + suffix);
    else if (used !== null) parts.push('已用 ' + formatAmount(used) + suffix);
    else if (limit !== null) parts.push('总额度 ' + formatAmount(limit) + suffix);
    var reset = formatResetTime(w.resetAt, now);
    if (reset) parts.push('重置 ' + reset.absolute + (reset.relative ? '（' + reset.relative + '）' : ''));
    return parts.length ? parts.join(' · ') : '暂无数据';
  }


  function errorMessage(err) {
    if (typeof err === 'string' && err) return err;
    if (err && typeof err.message === 'string' && err.message) return err.message;
    return '未知错误';
  }
  function createController(options) {
    var invoke = options && options.invoke;
    if (typeof invoke !== 'function') throw new TypeError('createController: 需要 invoke 函数');
    var snapshot = null, fullError = null, loadingAll = false, allPromise = null, epoch = 0;
    var seq = new Map();
    var flags = new Map(); // name -> { loading, error }
    var listeners = new Set();

    function state() {
      var rows = snapshot ? snapshot.providers.map(function (p) {
        var f = flags.get(p.name) || {};
        return { provider: p, stale: !snapshot.online || fullError !== null, loading: f.loading === true, cardError: toStr(f.error) };
      }) : [];
      return { snapshot: snapshot, rows: rows, count: snapshot ? snapshot.providers.length : null, loadingAll: loadingAll, fullError: fullError };
    }
    function emit() { var s = state(); listeners.forEach(function (fn) { try { fn(s); } catch { /* Rendering errors do not affect controller state. */ } }); }
    function subscribe(fn) { listeners.add(fn); return function () { listeners.delete(fn); }; }

    function findProvider(list, name) {
      for (var i = 0; i < list.length; i++) if (list[i].name === name) return list[i];
      return null;
    }
    function syncFlags(names) {
      Array.from(flags.keys()).forEach(function (k) {
        if (names.indexOf(k) === -1) {

          seq.delete(k);
          flags.delete(k);
        }
      });
    }

    function applyFull(result) {

      snapshot = normalizeSnapshot(result);
      fullError = null;
      var names = [];
      snapshot.providers.forEach(function (p) { names.push(p.name); });
      Array.from(flags.keys()).forEach(function (k) {
        if (names.indexOf(k) === -1) { seq.delete(k); flags.delete(k); }
        else flags.set(k, { loading: false, error: null });
      });
    }

    function applyMerged(result) {


      var next = normalizeSnapshot(result);
      var prev = snapshot;
      if (prev) {
        next.providers = next.providers.map(function (p) {
          var f = flags.get(p.name);

          return f && f.loading ? (findProvider(prev.providers, p.name) || p) : p;
        });
      }
      snapshot = next;
      fullError = null;
      var names = [];
      snapshot.providers.forEach(function (p) { names.push(p.name); });
      syncFlags(names);
    }

    function refreshAll() {
      if (loadingAll) return allPromise;
      loadingAll = true;
      fullError = null;
      var my = ++epoch;

      Array.from(seq.keys()).forEach(function (k) { seq.set(k, (seq.get(k) || 0) + 1); });
      flags.forEach(function (f, k) { if (f.loading) flags.set(k, { loading: false, error: null }); });
      emit();
      allPromise = invoke('quota_snapshot', { provider: null }).then(function (r) {
        if (my === epoch) applyFull(r);
      }, function (err) {
        if (my === epoch) fullError = errorMessage(err);
      }).then(function () {
        if (my === epoch) { loadingAll = false; allPromise = null; }
        emit();
      });
      return allPromise;
    }

    function refreshProvider(name) {
      if (!snapshot || loadingAll) return Promise.resolve();
      var f = flags.get(name);
      if (f && f.loading) return Promise.resolve();
      var my = (seq.get(name) || 0) + 1;
      seq.set(name, my);
      flags.set(name, { loading: true, error: null });
      emit();
      return invoke('quota_snapshot', { provider: name }).then(function (r) {
        if (seq.get(name) !== my) return;
        flags.set(name, { loading: false, error: null });
        applyMerged(r);
      }, function (err) {
        if (seq.get(name) !== my) return;
        flags.set(name, { loading: false, error: errorMessage(err) });
      }).then(emit);
    }

    return { subscribe: subscribe, state: state, refreshAll: refreshAll, refreshProvider: refreshProvider };
  }


  function createPreviewInvoke() {
    function snapshot(now) {
      var h = function (n) { return new Date(now + n * 3600e3).toISOString(); };
      var all = [
        { name: 'alpha.example.com', enabled: true, plan: 'Pro', status: 'ready', message: null, updatedAt: now - 5e3, windows: [
          { label: '五小时', used: 12.3, limit: 45, remaining: 32.7, unit: '次', resetAt: h(3) },
          { label: '每周', used: 210, limit: 1000, remaining: 790, unit: '次', resetAt: h(74) },
          { label: '余额', used: null, limit: null, remaining: 8.4, unit: 'USD', resetAt: null }] },
        { name: 'beta.example.com', enabled: true, plan: null, status: 'ready', message: null, updatedAt: now - 8e3, windows: [
          { label: '五小时', used: null, limit: 60, remaining: 18, unit: '次', resetAt: h(1.2) }] },
        { name: 'gamma.example.com', enabled: false, plan: 'Team', status: 'ready', message: null, updatedAt: now - 15e3, windows: [
          { label: '每月', used: 5, limit: 200, remaining: 195, unit: '次', resetAt: new Date(now - 3600e3).toISOString() }] },
        { name: 'delta.example.com', enabled: true, plan: null, status: 'unsupported', message: '该提供方未提供额度查询接口', windows: [], updatedAt: null },
        { name: 'epsilon.example.com', enabled: true, plan: null, status: 'reauth', message: '登录已过期，请重新授权后查看额度', windows: [], updatedAt: null },
        { name: 'zeta.example.com', enabled: true, plan: null, status: 'cooling', message: '触发限流，冷却中', updatedAt: now - 20e3, windows: [
          { label: '五小时', used: 58, limit: 60, remaining: 2, unit: '次', resetAt: h(0.5) }] },
        { name: 'eta.example.com', enabled: true, plan: null, status: 'ready', message: null, updatedAt: null, windows: [
          { label: '五小时', used: null, limit: null, remaining: null, unit: null, resetAt: null }] },
      ];
      return { providers: all, updatedAt: now - 2e3, online: true, error: null };
    }
    return function (cmd) {
      if (cmd !== 'quota_snapshot') return Promise.resolve(null);
      return new Promise(function (resolve) { setTimeout(function () { resolve(snapshot(Date.now())); }, 250); });
    };
  }


  var SVG_NS = 'http://www.w3.org/2000/svg';
  var REFRESH_PATHS = ['M13.3 8a5.3 5.3 0 1 1-1.55-3.75', 'M13.4 1.6v3h-3'];
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function icon(paths) {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'icon');
    paths.forEach(function (d) {
      var p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', d);
      svg.appendChild(p);
    });
    return svg;
  }

  function buildCard() {
    var li = el('li', 'card');
    var head = el('div', 'card-head');
    var title = el('div', 'card-title');
    var name = el('span', 'card-name');
    var badges = el('span', 'card-badges');
    title.appendChild(name);
    title.appendChild(badges);
    var actions = el('div', 'card-actions');
    var status = el('span', 'status');
    var refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.className = 'btn btn-icon card-refresh';
    refresh.dataset.refresh = '1';
    refresh.appendChild(icon(REFRESH_PATHS));
    actions.appendChild(status);
    actions.appendChild(refresh);
    head.appendChild(title);
    head.appendChild(actions);
    var message = el('p', 'card-message'); message.hidden = true;
    var error = el('p', 'card-error'); error.hidden = true;
    var windows = el('ul', 'windows');
    var loading = el('p', 'card-loading'); loading.hidden = true;
    li.appendChild(head); li.appendChild(message); li.appendChild(error); li.appendChild(windows); li.appendChild(loading);
    return { li: li, name: name, badges: badges, status: status, refresh: refresh, message: message, error: error, windows: windows, loading: loading };
  }

  function buildWindow(win) {
    var li = el('li', 'window');
    var label = toStr(win.label) || '用量';
    var pct = computePercent(win);
    var pctText = formatPercent(pct);
    var top = el('div', 'window-top');
    top.appendChild(el('span', 'window-label', label));
    top.appendChild(el('span', 'window-pct', pctText || ''));
    li.appendChild(top);
    if (pct !== null) {
      var meter = document.createElement('progress');
      meter.className = 'meter';
      meter.setAttribute('max', '100');
      meter.setAttribute('value', String(Math.round(pct * 100) / 100));
      meter.setAttribute('data-level', pct >= 90 ? 'high' : 'normal');
      meter.setAttribute('aria-label', label + ' 已用 ' + pctText);
      li.appendChild(meter);
    }
    var meta = describeWindow(win);
    if (meta) li.appendChild(el('div', 'window-meta', meta));
    return li;
  }

  function detectTauri() {
    var t = typeof window !== 'undefined' && window.__TAURI__;
    return t && t.core && typeof t.core.invoke === 'function' ? t : null;
  }

  function boot() {
    var previewWanted = typeof location !== 'undefined' && /[?&]preview=1/.test(location.search);
    if (detectTauri() || previewWanted) { run(detectTauri(), previewWanted); return; }

    var tries = 0;
    var timer = setInterval(function () {
      tries += 1;
      if (detectTauri() || tries >= 12) { clearInterval(timer); run(detectTauri(), previewWanted); }
    }, 120);
  }

  function run(tauri, previewWanted) {
    var mode = tauri ? 'tauri' : previewWanted ? 'preview' : 'missing';
    var invoke = tauri
      ? function (cmd, args) { return tauri.core.invoke(cmd, args); }
      : mode === 'preview' ? createPreviewInvoke() : null;
    var controller = mode === 'missing' ? null : createController({ invoke: invoke });
    var els = {
      list: document.getElementById('list'),
      empty: document.getElementById('empty'),
      banner: document.getElementById('banner'),
      count: document.getElementById('provider-count'),
      updatedAt: document.getElementById('updated-at'),
      refreshAll: document.getElementById('refresh-all'),
      openUi: document.getElementById('open-ui'),
      quit: document.getElementById('quit'),
    };
    var cards = new Map();

    function safeCommand(cmd) {
      if (!invoke) return;
      try {
        var r = invoke(cmd);
        if (r && typeof r.catch === 'function') r.catch(function () {});
      } catch { /* Never log command payloads. */ }
    }

    function renderBanner(state) {
      var tone = null, text = null;
      if (mode === 'missing') { tone = 'error'; text = '无法访问桌面 IPC（window.__TAURI__ 不可用），额度数据不可用。'; }
      else if (state.fullError) { tone = 'error'; text = '刷新失败，正在显示最后已知数据：' + state.fullError; }
      else if (state.snapshot && !state.snapshot.online) { tone = 'warn'; text = '网关离线 · 显示最后已知数据'; }
      else if (state.snapshot && state.snapshot.error) { tone = 'warn'; text = '部分数据获取失败：' + state.snapshot.error; }
      els.banner.hidden = !text;
      els.banner.textContent = text || '';
      if (tone) els.banner.setAttribute('data-tone', tone); else els.banner.removeAttribute('data-tone');
    }

    function updateCard(refs, row) {
      var p = row.provider;
      refs.li.dataset.provider = p.name;
      refs.li.dataset.disabled = String(!p.enabled);
      refs.li.dataset.stale = String(row.stale);
      refs.li.setAttribute('aria-busy', String(row.loading));
      if (refs.name.textContent !== p.name) refs.name.textContent = p.name;
      refs.badges.textContent = '';
      if (p.plan) refs.badges.appendChild(el('span', 'badge badge-plan', p.plan));
      if (!p.enabled) refs.badges.appendChild(el('span', 'badge badge-off', '已停用'));
      if (row.stale) refs.badges.appendChild(el('span', 'badge badge-stale', '可能过期'));
      var meta = statusMeta(p.status);
      refs.status.className = 'status tone-' + meta.tone;
      refs.status.textContent = meta.label;
      refs.message.hidden = !p.message;
      refs.message.textContent = p.message || '';
      refs.error.hidden = !row.cardError;
      refs.error.textContent = row.cardError ? '刷新失败：' + row.cardError : '';
      refs.windows.textContent = '';
      p.windows.forEach(function (w) { refs.windows.appendChild(buildWindow(w)); });
      refs.loading.hidden = !row.loading;
      refs.loading.textContent = row.loading ? '读取中…' : '';
      refs.refresh.disabled = row.loading || controller.state().loadingAll || mode === 'missing';
      refs.refresh.setAttribute('aria-label', '刷新 ' + p.name);
      refs.refresh.title = '刷新 ' + p.name;
    }

    function render(state) {
      els.refreshAll.classList.toggle('is-loading', !!state.loadingAll);
      els.refreshAll.setAttribute('aria-busy', String(!!state.loadingAll));
      els.refreshAll.disabled = !!state.loadingAll || mode === 'missing';
      els.openUi.disabled = mode === 'missing';
      els.quit.disabled = mode === 'missing';
      els.count.textContent = state.count === null ? (mode === 'missing' ? '不可用' : '正在读取…') : '已配置 ' + state.count + ' 个提供方';
      var ts = state.snapshot ? formatTimestamp(state.snapshot.updatedAt) : null;
      els.updatedAt.textContent = ts ? '更新于 ' + ts : '—';
      renderBanner(state);
      var seen = new Set();
      state.rows.forEach(function (row) {
        seen.add(row.provider.name);
        var refs = cards.get(row.provider.name);
        if (!refs) { refs = buildCard(); cards.set(row.provider.name, refs); }
        updateCard(refs, row);
      });
      cards.forEach(function (refs, name) {
        if (!seen.has(name)) { refs.li.remove(); cards.delete(name); }
      });

      state.rows.forEach(function (row) { els.list.insertBefore(cards.get(row.provider.name).li, els.empty); });
      els.empty.hidden = state.rows.length !== 0 || !state.snapshot || !state.snapshot.online;
      els.list.setAttribute('aria-busy', String(!!state.loadingAll));
    }

    if (controller) {
      controller.subscribe(render);
      render(controller.state());
      els.refreshAll.addEventListener('click', function () { controller.refreshAll(); });
      els.list.addEventListener('click', function (event) {
        var btn = event.target && event.target.closest ? event.target.closest('[data-refresh]') : null;
        if (!btn) return;
        var card = btn.closest('.card');
        if (card && card.dataset.provider) controller.refreshProvider(card.dataset.provider);
      });
      window.addEventListener('focus', function () { controller.refreshAll(); });
      controller.refreshAll();
    } else {
      render({ snapshot: null, rows: [], count: null, loadingAll: false, fullError: null });
    }
    els.openUi.addEventListener('click', function () { safeCommand('quota_open_ui'); });
    els.quit.addEventListener('click', function () { safeCommand('quota_quit'); });
    window.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') safeCommand('quota_hide');
    });
  }

  var QuotaUI = {
    normalizeSnapshot: normalizeSnapshot, normalizeProvider: normalizeProvider, normalizeWindow: normalizeWindow,
    statusMeta: statusMeta, computePercent: computePercent, formatPercent: formatPercent,
    formatAmount: formatAmount, formatResetTime: formatResetTime, formatTimestamp: formatTimestamp,
    describeWindow: describeWindow, createController: createController,
  };
  if (typeof globalThis !== 'undefined') globalThis.QuotaUI = QuotaUI;

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }
})();
