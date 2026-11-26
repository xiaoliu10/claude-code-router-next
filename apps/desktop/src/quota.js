(function () {
  'use strict';

  function toNum(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }
  function toStr(v) { return typeof v === 'string' && v ? v : null; }
  function pad2(n) { return n < 10 ? '0' + n : String(n); }
  function group(s) { return s.replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function errorMessage(err) {
    if (typeof err === 'string' && err) return err;
    if (err && typeof err.message === 'string' && err.message) return err.message;
    return '未知错误';
  }
  function formatInt(v) {
    var n = toNum(v);
    if (n === null) return null;
    return group(String(Math.round(n)));
  }
  // Compact token counts for the narrow panel; the exact value stays available via title.
  function formatCompact(v) {
    var n = toNum(v);
    if (n === null) return null;
    var abs = Math.abs(n);
    var units = [{ scale: 1e9, suffix: 'B' }, { scale: 1e6, suffix: 'M' }, { scale: 1e3, suffix: 'K' }];
    for (var i = 0; i < units.length; i++) {
      var unit = units[i];
      // Promote values whose two-decimal rounding reaches the next unit.
      if (abs >= unit.scale || (i < units.length - 1 && abs >= unit.scale - unit.scale / 200000)) {
        return String(Math.round(n / (unit.scale / 100)) / 100) + unit.suffix;
      }
    }
    return formatInt(n);
  }
  // Friendly millisecond durations for TTFT/latency cells: 820ms / 1.2s / 2.5m.
  function formatMs(ms) {
    var n = toNum(ms);
    if (n === null) return null;
    if (n < 1000) return Math.round(n) + 'ms';
    if (n < 60000) return (n / 1000).toFixed(1) + 's';
    return (n / 60000).toFixed(1) + 'm';
  }
  // Generation speed in tokens per second with one decimal: 35.7 t/s.
  function formatSpeed(tokensPerSecond) {
    var n = toNum(tokensPerSecond);
    if (n === null) return null;
    return n.toFixed(1) + ' t/s';
  }
  // Success rate to one decimal; null while there are no requests to divide by.
  function formatSuccessRate(successCount, totalRequests) {
    var s = toNum(successCount), t = toNum(totalRequests);
    if (s === null || t === null || t <= 0) return null;
    return ((s / t) * 100).toFixed(1) + '%';
  }
  function formatClock(ms) {
    var n = toNum(ms);
    if (n === null) return null;
    var t = new Date(n);
    return pad2(t.getHours()) + ':' + pad2(t.getMinutes()) + ':' + pad2(t.getSeconds());
  }
  function arrayEq(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }


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

    function refreshProvider(name, newlyAdded) {
      if (newlyAdded && loadingAll) return allPromise.then(function () { return refreshProvider(name, true); });
      if ((!snapshot && !newlyAdded) || loadingAll) return Promise.resolve();
      if (newlyAdded) {
        // Earlier card snapshots predate the config change and can omit the new row.
        flags.forEach(function (flag, key) {
          if (!flag.loading) return;
          seq.set(key, (seq.get(key) || 0) + 1);
          flags.set(key, { loading: false, error: null });
        });
      }
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


  function safeVersionQuery(endpoint) {
    var start = endpoint.indexOf('?');
    if (start < 0) return true;
    var query = endpoint.slice(start + 1);
    if (/^version=\d{1,3}(?:\.\d{1,3}){0,2}$/.test(query)) return true;
    var match = /^api-version=(\d{4}-\d{2}-\d{2})(?:-preview)?$/.exec(query);
    if (!match) return false;
    var date = new Date(match[1] + 'T00:00:00Z');
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === match[1];
  }

  function providerInputError(provider, editing) {
    function validText(value, maxBytes) {
      return typeof value === 'string' && value.trim() && !/[\u0000-\u001f\u007f-\u009f]/.test(value)
        && new TextEncoder().encode(value.trim()).length <= maxBytes;
    }
    function validId(value) { return validText(value, 256) && !value.includes(','); }
    if (!provider || !validId(provider.name)) return 'name';
    if (!validText(provider.baseUrl, 2048)) return 'baseUrl';
    var endpoint = provider.baseUrl.trim();
    var authority = /^https?:\/\/([^/?#]+)/i.exec(endpoint);
    if (!safeVersionQuery(endpoint) || !authority || authority[1].includes('@') || /[\\#\s]/.test(endpoint)) return 'baseUrl';
    try { if (!new URL(endpoint).hostname) return 'baseUrl'; } catch { return 'baseUrl'; }
    var keepKey = editing && (provider.apiKey === undefined || provider.apiKey === '');
    if (!keepKey && !validText(provider.apiKey, 4096)) return 'apiKey';
    var models = provider.models;
    if (!Array.isArray(models) || !models.length || models.length > 256 || !models.every(validId)) return 'models';
    if (new Set(models.map(function (m) { return m.trim(); })).size !== models.length) return 'models';
    return null;
  }

  // ---- Coding Plan quota credentials (quota tab) -------------------------
  // quota_credentials_status() / quota_credentials_save({name, accessKey?, secretKey?})
  // Rust lists only providers on ark.cn-beijing.volces.com/api/coding/ (the
  // same condition as the core adapter) and projects {name, configured} only:
  // secret values never cross IPC. Omitted input keeps the saved field; an
  // empty string clears it. Inputs are never prefilled with saved values.

  function normalizeCredentialsStatus(r) {
    var s = r && typeof r === 'object' ? r : {};
    var list = Array.isArray(s.providers) ? s.providers : [];
    var seen = {}, providers = [];
    list.forEach(function (p) {
      var o = p && typeof p === 'object' ? p : {};
      var name = toStr(o.name);
      if (!name || seen[name]) return;
      seen[name] = true;
      providers.push({ name: name, configured: o.configured === true });
    });
    return { providers: providers };
  }

  function createCredentialsController(options) {
    var invoke = options && options.invoke;
    if (typeof invoke !== 'function') throw new TypeError('createCredentialsController: 需要 invoke 函数');
    // Best-effort usage refresh after credentials change; ownership stays with the quota controller.
    var onSaved = options && typeof options.onSaved === 'function' ? options.onSaved : function () {};
    var status = null, loading = false, error = null;
    var openName = null, saving = false, saveError = null, savedFlash = null;
    var epoch = 0;
    var listeners = new Set();

    function state() {
      return { status: status, loading: loading, error: error, openName: openName, saving: saving, saveError: saveError, savedFlash: savedFlash };
    }
    function emit() { var s = state(); listeners.forEach(function (fn) { try { fn(s); } catch { /* Rendering errors do not affect controller state. */ } }); }
    function subscribe(fn) { listeners.add(fn); return function () { listeners.delete(fn); }; }
    function known(name) {
      return !!status && status.providers.some(function (p) { return p.name === name; });
    }
    function configured(name) {
      if (!status) return false;
      for (var i = 0; i < status.providers.length; i++) if (status.providers[i].name === name) return status.providers[i].configured;
      return false;
    }
    function adopt(result) {
      status = normalizeCredentialsStatus(result);
      error = null;
      if (openName !== null && !known(openName)) { openName = null; saveError = null; savedFlash = null; }
    }

    var refreshQueued = false;
    function drainRefresh() {
      if (!refreshQueued || loading || saving) return;
      refreshQueued = false;
      refresh();
    }
    function refresh(afterConfigChange) {
      if (loading || saving) {
        if (afterConfigChange === true) refreshQueued = true;
        return;
      }
      loading = true;
      error = null;
      emit();
      var my = ++epoch;
      invoke('quota_credentials_status').then(function (r) {
        if (my !== epoch) return;
        adopt(r);
        loading = false;
        emit();
      }, function (err) {
        if (my !== epoch) return;
        loading = false;
        error = errorMessage(err);
        emit();
      }).then(drainRefresh);
    }

    function open(name) {
      if (saving || !known(name)) return false;
      openName = name;
      saveError = null;
      savedFlash = null;
      emit();
      return true;
    }
    function close() {
      if (openName === null || saving) return false;
      openName = null;
      saveError = null;
      savedFlash = null;
      emit();
      return true;
    }

    function performSave(name, args, cleared) {
      saving = true;
      saveError = null;
      savedFlash = null;
      emit();
      var my = ++epoch;
      invoke('quota_credentials_save', args).then(function (r) {
        if (my !== epoch) return;
        saving = false;
        adopt(r);
        if (openName === name) savedFlash = { name: name, at: Date.now(), cleared: cleared };
        emit();
        // The card's usage snapshot is stale once credentials change; refresh it
        // (best-effort: the Rust quota service applies the 3s attempt dedupe, while this
        // controller's loading flag collapses concurrent in-flight refreshes).
        try { onSaved(name); } catch { /* rendering-only hook */ }
      }, function (err) {
        if (my !== epoch) return;
        saving = false;
        saveError = errorMessage(err);
        emit();
      }).then(drainRefresh);
    }

    function save(name, values) {
      if (saving || openName !== name || !known(name)) return false;
      var v = values && typeof values === 'object' ? values : {};
      var ak = typeof v.accessKey === 'string' ? v.accessKey.trim() : '';
      var sk = typeof v.secretKey === 'string' ? v.secretKey.trim() : '';
      if (!ak && !sk) {
        // Blank inputs never overwrite saved credentials; clearing is explicit.
        saveError = configured(name) ? '留空表示不修改；如需清除已保存凭证请点「清除凭证」' : '请输入 AccessKey ID 和 Secret AccessKey';
        emit();
        return false;
      }
      var args = { name: name };
      if (ak) args.accessKey = ak;
      if (sk) args.secretKey = sk;
      performSave(name, args, false);
      return true;
    }

    function clear(name) {
      if (saving || openName !== name || !known(name) || !configured(name)) return false;
      performSave(name, { name: name, accessKey: '', secretKey: '' }, true);
      return true;
    }

    return { subscribe: subscribe, state: state, refresh: refresh, open: open, close: close, save: save, clear: clear, configured: configured };
  }


  // ---- Routing tab -------------------------------------------------------
  // Projection contract (docs/design/desktop-control-center.md):
  // snapshot = {providers:[{name,models:[string]}], routes:[{scope,field,target,fallback}],
  //             familyRouting, fallbackEnabled, revision}
  // save    = routing_save({change:{revision,scope,field,target:string|null,fallback:[string]|null}})
  //           null fallback preserves it; null/empty target clears the override.
  // groups  = routing_save_groups({changes:[...]}) uses one revision and one write.
  // flags   = routing_flags({revision,familyRouting,fallbackEnabled})

  var ROUTING_SCOPES = ['global', 'opus', 'sonnet', 'haiku', 'models'];
  var MODEL_GROUPS = ['opus', 'sonnet', 'haiku'];
  var ROUTING_SCENARIOS = ['default', 'background', 'think', 'longContext', 'extendedContext', 'webSearch', 'image'];
  var USAGE_PERIOD_LABELS = { today: '今天', '7d': '近 7 天', '30d': '近 30 天', all: '全部' };
  var USAGE_PERIODS = Object.keys(USAGE_PERIOD_LABELS);
  var DEFAULT_USAGE_PERIOD = '7d';
  var SCOPE_LABELS = { global: '全局', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', models: '模型别名' };
  var SCENARIO_LABELS = { default: '默认', background: '后台', think: '思考', longContext: '长上下文', extendedContext: '扩展上下文', webSearch: '网页搜索', image: '图像' };

  function routeKey(scope, field) { return scope + '|' + field; }
  function splitKey(key) {
    var i = String(key).indexOf('|');
    return { scope: i === -1 ? String(key) : String(key).slice(0, i), field: i === -1 ? '' : String(key).slice(i + 1) };
  }
  function isModelGroup(scope) { return MODEL_GROUPS.indexOf(scope) !== -1; }
  function isModelGroupKey(key) {
    var parts = splitKey(key);
    return isModelGroup(parts.scope) && parts.field !== 'background' && ROUTING_SCENARIOS.indexOf(parts.field) !== -1;
  }
  function routeLabel(scope, field) {
    if (scope === 'models') return field || '(空别名)';
    return SCENARIO_LABELS[field] || field || '(未命名)';
  }

  function normalizeRoutingSnapshot(r) {
    var s = r && typeof r === 'object' ? r : {};
    var providers = Array.isArray(s.providers) ? s.providers : [];
    var routes = Array.isArray(s.routes) ? s.routes : [];
    return {
      providers: providers.map(function (p) {
        var o = p && typeof p === 'object' ? p : {};
        return {
          name: toStr(o.name) || '未命名提供方',
          models: Array.isArray(o.models) ? o.models.filter(function (m) { return typeof m === 'string' && m; }) : [],
        };
      }),
      routes: routes.map(function (rt) {
        var o = rt && typeof rt === 'object' ? rt : {};
        return {
          scope: toStr(o.scope) || 'global',
          field: toStr(o.field) || '',
          target: toStr(o.target),
          fallback: Array.isArray(o.fallback) ? o.fallback.filter(function (f) { return typeof f === 'string' && f; }) : [],
        };
      }),
      familyRouting: s.familyRouting === true,
      fallbackEnabled: s.fallbackEnabled === true,
      revision: toStr(s.revision) || '',
    };
  }

  function findRoute(snapshot, scope, field) {
    var routes = snapshot && Array.isArray(snapshot.routes) ? snapshot.routes : [];
    for (var i = 0; i < routes.length; i++) {
      if (routes[i].scope === scope && routes[i].field === field) return routes[i];
    }
    return null;
  }
  function canonicalTarget(snapshot, scope, field) {
    var rt = findRoute(snapshot, scope, field);
    return rt && rt.target ? rt.target : '';
  }
  function canonicalFallback(snapshot, scope, field) {
    var rt = findRoute(snapshot, scope, field);
    return rt ? rt.fallback.slice() : [];
  }

  function createRoutingController(options) {
    var invoke = options && options.invoke;
    if (typeof invoke !== 'function') throw new TypeError('createRoutingController: 需要 invoke 函数');
    var snapshot = null, loading = false, error = null;
    var flagsSaving = false, flagsError = null;
    var savingKey = null, saveQueue = [], saveError = null, savedFlash = null;
    var savingGroups = false, groupSaveMessage = '';
    var drafts = new Map(); // key -> {target, fallback, fallbackDirty}
    var epoch = 0;
    var listeners = new Set();

    function isClean(key) {
      var d = drafts.get(key);
      if (!d) return true;
      var parts = splitKey(key);
      if (d.target !== canonicalTarget(snapshot, parts.scope, parts.field)) return false;
      if (d.fallbackDirty && !arrayEq(d.fallback, canonicalFallback(snapshot, parts.scope, parts.field))) return false;
      return true;
    }
    function state() {
      var dirtyKeys = [];
      drafts.forEach(function (d, k) {
        if (!isClean(k)) dirtyKeys.push(k);
      });
      return {
        snapshot: snapshot, loading: loading, error: error,
        flagsSaving: flagsSaving, flagsError: flagsError,
        savingKey: savingKey, queued: saveQueue.slice(),
        saveError: saveError, savedFlash: savedFlash,
        savingGroups: savingGroups, groupSaveMessage: groupSaveMessage,
        dirtyGroupKeys: dirtyKeys.filter(isModelGroupKey),
        dirtyKeys: dirtyKeys, isClean: isClean,
        draftKeys: Array.from(drafts.keys()),
        draft: function (key) { return drafts.get(key) || null; },
      };
    }
    function emit() { var s = state(); listeners.forEach(function (fn) { try { fn(s); } catch { /* Rendering errors do not affect controller state. */ } }); }
    function subscribe(fn) { listeners.add(fn); return function () { listeners.delete(fn); }; }
    function clearFlash(key) {
      if (savedFlash && savedFlash.key === key) savedFlash = null;
      if (isModelGroupKey(key)) groupSaveMessage = '';
    }

    // Adopt a server snapshot: drafts whose values now match the server are
    // dropped; drafts that still differ survive refreshes and saves.
    function adopt(result) {
      snapshot = normalizeRoutingSnapshot(result);
      error = null;
      drafts.forEach(function (draft, key) {
        if (isClean(key)) drafts.delete(key);
        else if (!draft.fallbackDirty) {
          var parts = splitKey(key);
          draft.fallback = canonicalFallback(snapshot, parts.scope, parts.field);
        }
      });
    }

    function ensureDraft(key) {
      var d = drafts.get(key);
      if (d) return d;
      var parts = splitKey(key);
      d = {
        target: canonicalTarget(snapshot, parts.scope, parts.field),
        fallback: canonicalFallback(snapshot, parts.scope, parts.field),
        fallbackDirty: false,
      };
      drafts.set(key, d);
      return d;
    }

    function refresh() {
      if (loading || savingKey || savingGroups || flagsSaving) return;
      loading = true;
      error = null;
      emit();
      var my = ++epoch;
      invoke('routing_snapshot').then(function (r) {
        if (my !== epoch) return;
        adopt(r);
        loading = false;
        emit();
      }, function (err) {
        if (my !== epoch) return;
        loading = false;
        error = errorMessage(err);
        emit();
      });
    }

    function setTarget(key, value) {
      if (!snapshot) return;
      var d = ensureDraft(key);
      var next = String(value == null ? '' : value);
      if (d.target === next) return;
      d.target = next;
      clearFlash(key);
      emit();
    }

    function addFallback(key, rawValue) {
      if (!snapshot) return { ok: false, message: '路由配置尚未读取' };
      var v = String(rawValue == null ? '' : rawValue).trim();
      if (!v) return { ok: false, message: '请输入 提供方,模型' };
      var d = ensureDraft(key);
      if (d.fallback.indexOf(v) !== -1) return { ok: false, message: '该回退已存在' };
      d.fallback = d.fallback.concat([v]);
      d.fallbackDirty = true;
      clearFlash(key);
      emit();
      return { ok: true };
    }

    function removeFallback(key, index) {
      if (!snapshot) return;
      var d = ensureDraft(key);
      var i = toNum(index);
      if (i === null || i < 0 || i >= d.fallback.length) return;
      d.fallback = d.fallback.slice(0, i).concat(d.fallback.slice(i + 1));
      d.fallbackDirty = true;
      clearFlash(key);
      emit();
    }

    function moveFallback(key, index, direction) {
      if (!snapshot) return;
      var d = ensureDraft(key);
      var i = toNum(index);
      var j = i === null ? null : i + (direction < 0 ? -1 : 1);
      if (i === null || j === null || i < 0 || j < 0 || i >= d.fallback.length || j >= d.fallback.length) return;
      var arr = d.fallback.slice();
      var moved = arr.splice(i, 1)[0];
      arr.splice(j, 0, moved);
      d.fallback = arr;
      d.fallbackDirty = true;
      clearFlash(key);
      emit();
    }

    function resetDraft(key) {
      if (!snapshot || (savingGroups && isModelGroupKey(key))) return;
      drafts.delete(key);
      clearFlash(key);
      emit();
    }

    function createAlias(field, target) {
      if (savingGroups) return { ok: false, message: '正在保存模型组，请稍后重试' };
      if (!snapshot) return { ok: false, message: '路由配置尚未读取' };
      var name = String(field == null ? '' : field).trim();
      if (!name) return { ok: false, message: '请输入模型别名' };
      if (name.indexOf('|') !== -1) return { ok: false, message: '别名不能包含 |' };
      var key = routeKey('models', name);
      var d = ensureDraft(key);
      d.target = String(target == null ? '' : target);
      if (isClean(key)) {
        drafts.delete(key);
        return { ok: false, message: '该别名已是当前配置' };
      }
      saveRow(key);
      return { ok: true };
    }

    function routeChange(key, draft) {
      var parts = splitKey(key);
      return {
        revision: snapshot.revision,
        scope: parts.scope,
        field: parts.field,
        target: draft.target.trim() || null,
        fallback: draft.fallbackDirty ? draft.fallback.slice() : null,
      };
    }

    function saveGroups() {
      if (!snapshot || loading || flagsSaving || savingKey || savingGroups || saveQueue.length) return;
      var keys = state().dirtyGroupKeys;
      if (!keys.length) return;
      var targets = keys.map(function (key) { return drafts.get(key).target; });
      var changes = keys.map(function (key) { return routeChange(key, drafts.get(key)); });
      savingGroups = true;
      saveError = null;
      groupSaveMessage = '';
      emit();
      invoke('routing_save_groups', { changes: changes }).then(function (response) {
        keys.forEach(function (key, index) {
          var draft = drafts.get(key);
          if (draft && draft.target === targets[index]) draft.target = changes[index].target || '';
        });
        adopt(response);
        savingGroups = false;
        groupSaveMessage = '已保存 ' + keys.length + ' 项模型组修改';
        emit();
      }, function (err) {
        savingGroups = false;
        saveError = { message: errorMessage(err) };
        emit();
      });
    }

    // Saves run one at a time so every change carries the latest known
    // revision; the server rejects stale revisions instead of merging.
    function pump() {
      if (savingKey || flagsSaving || loading || !saveQueue.length) return;
      var key = saveQueue.shift();
      var d = drafts.get(key);
      if (!d || isClean(key)) { pump(); return; }
      savingKey = key;
      var submittedTarget = d.target;
      var change = routeChange(key, d);
      emit();
      var my = ++epoch;
      invoke('routing_save', { change: change }).then(function (resp) {
        if (my !== epoch) return;
        savingKey = null;
        var hadError = saveError && (!saveError.key || saveError.key === key);
        var currentDraft = drafts.get(key);
        // Normalize only the submitted target; newer typing remains a draft.
        if (currentDraft && currentDraft.target === submittedTarget) currentDraft.target = change.target || '';
        adopt(resp);
        if (isClean(key)) {
          drafts.delete(key);
          savedFlash = { key: key, at: Date.now() };
        }
        if (hadError) saveError = null;
        pump();
        emit();
      }, function (err) {
        if (my !== epoch) return;
        savingKey = null;
        saveQueue = []; // Abort queued siblings: they would reuse a stale revision.
        saveError = { key: key, message: errorMessage(err) };
        emit();
      });
    }
    function saveRow(key) {
      if (!snapshot || loading || flagsSaving || savingGroups) return;
      if (savingKey === key || saveQueue.indexOf(key) !== -1) return;
      if (isClean(key)) return;
      saveQueue.push(key);
      emit();
      pump();
    }

    function setFlag(name, value) {
      if (!snapshot || flagsSaving || savingKey || savingGroups || loading) return false;
      if (typeof value !== 'boolean') return false;
      if (name !== 'familyRouting' && name !== 'fallbackEnabled') return false;
      var payload = {
        revision: snapshot.revision,
        familyRouting: name === 'familyRouting' ? value : snapshot.familyRouting,
        fallbackEnabled: name === 'fallbackEnabled' ? value : snapshot.fallbackEnabled,
      };
      flagsSaving = true;
      flagsError = null;
      emit();
      var my = ++epoch;
      invoke('routing_flags', payload).then(function (resp) {
        if (my !== epoch) return;
        adopt(resp);
        flagsSaving = false;
        emit();
      }, function (err) {
        if (my !== epoch) return;
        flagsSaving = false;
        flagsError = errorMessage(err);
        emit();
      });
      return true;
    }

    return {
      subscribe: subscribe, state: state, refresh: refresh,
      setTarget: setTarget, addFallback: addFallback, removeFallback: removeFallback,
      moveFallback: moveFallback, resetDraft: resetDraft,
      saveRow: saveRow, saveGroups: saveGroups, setFlag: setFlag, createAlias: createAlias,
    };
  }


  // ---- Usage tab ---------------------------------------------------------
  // usage_snapshot({period:'today'|'7d'|'30d'|'all'}) -> totals + byModel/byProvider/byDay.
  // Numbers come from the server summary only; no currency/cost is shown.

  function usageRow(x) {
    var o = x && typeof x === 'object' ? x : {};
    return {
      name: toStr(o.name) || '—',
      requests: toNum(o.requests),
      inputTokens: toNum(o.inputTokens),
      outputTokens: toNum(o.outputTokens),
      cacheReadTokens: toNum(o.cacheReadTokens),
      cacheWriteTokens: toNum(o.cacheWriteTokens),
    };
  }
  function normalizeUsageSnapshot(r) {
    var s = r && typeof r === 'object' ? r : {};
    return {
      period: toStr(s.period),
      totalRequests: toNum(s.totalRequests),
      successCount: toNum(s.successCount),
      errorCount: toNum(s.errorCount),
      inputTokens: toNum(s.inputTokens),
      outputTokens: toNum(s.outputTokens),
      cacheReadTokens: toNum(s.cacheReadTokens),
      cacheWriteTokens: toNum(s.cacheWriteTokens),
      estimatedCount: toNum(s.estimatedCount),
      avgTtftMs: toNum(s.avgTtftMs),
      avgTokensPerSecond: toNum(s.avgTokensPerSecond),
      byModel: Array.isArray(s.byModel) ? s.byModel.map(usageRow) : [],
      byProvider: Array.isArray(s.byProvider) ? s.byProvider.map(usageRow) : [],
      byDay: Array.isArray(s.byDay) ? s.byDay.map(usageRow) : [],
      updatedAt: toNum(s.updatedAt),
    };
  }

  // Core's SQLite buckets use date(timestamp, 'localtime'). Step through local
  // calendar dates so UTC offsets and daylight-saving transitions match them.
  function usageDayKey(end, daysAgo) {
    var date = new Date(end.getFullYear(), end.getMonth(), end.getDate() - daysAgo, 12);
    return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
  }

  function usageTrendRows(rows, dayCount, end) {
    var byDate = new Map(rows.map(function (row) { return [row.name, row]; }));
    var days = [];
    for (var i = dayCount - 1; i >= 0; i--) {
      var name = usageDayKey(end, i);
      days.push(byDate.get(name) || { name: name, inputTokens: 0, outputTokens: 0 });
    }
    return days;
  }

  function createUsageController(options) {
    var invoke = options && options.invoke;
    if (typeof invoke !== 'function') throw new TypeError('createUsageController: 需要 invoke 函数');
    var snapshot = null, loading = false, error = null, period = DEFAULT_USAGE_PERIOD;
    var epoch = 0, trend = null;
    var listeners = new Set();

    function state() {
      return { snapshot: snapshot, loading: loading, error: error, period: period, trend: trend };
    }
    function emit() { var s = state(); listeners.forEach(function (fn) { try { fn(s); } catch { /* Rendering errors do not affect controller state. */ } }); }
    function subscribe(fn) { listeners.add(fn); return function () { listeners.delete(fn); }; }

    function load(p) {
      if (USAGE_PERIODS.indexOf(p) === -1) return;
      period = p;
      loading = true;
      error = null;
      var my = ++epoch;
      var dayCount = p === 'today' || p === '7d' ? 7 : p === '30d' ? 30 : 0;
      trend = dayCount ? { dayCount: dayCount, rows: null, error: null } : null;
      emit();
      invoke('usage_snapshot', { period: p }).then(function (r) {
        if (my !== epoch) return;
        snapshot = normalizeUsageSnapshot(r);
        loading = false;
        emit();
      }, function (err) {
        if (my !== epoch) return;
        loading = false;
        error = errorMessage(err);
        emit();
      });
      if (trend) {
        invoke('usage_snapshot', { period: dayCount + 'd', trend: true }).then(function (r) {
          if (my !== epoch) return;
          var end = new Date(r.updatedAt);
          if (!Number.isFinite(end.getTime())) throw new Error('趋势时间无效');
          trend.rows = usageTrendRows(r.byDay.map(usageRow), dayCount, end);
          emit();
        }).catch(function (err) {
          if (my !== epoch) return;
          trend.error = errorMessage(err);
          emit();
        });
      }
    }

    return {
      subscribe: subscribe, state: state,
      setPeriod: function (p) { if (p !== period) load(p); },
      refresh: function () { load(period); },
    };
  }


  // ---- Usage records -----------------------------------------------------
  // usage_records({period:'today'|'7d'|'30d'|'all',page,pageSize}) -> paged,
  // whitelisted projections of individual calls. The server never sends
  // responseBody/sessionId/keys; normalizeRecord re-enforces that whitelist
  // on the client before anything renders.

  var RECORDS_PAGE_SIZE = 20;
  var CLIENT_LABELS = { 'claude-code': 'Claude Code', 'zcode': 'ZCode', codex: 'Codex', pi: 'Pi', 'qwen-code': 'Qwen Code', opencode: 'OpenCode', api: 'API' };
  function clientLabel(type) {
    var t = toStr(type);
    return t ? (CLIENT_LABELS[t] || t) : '未知';
  }
  function normalizeRecord(r) {
    var o = r && typeof r === 'object' ? r : {};
    return {
      timestamp: toStr(o.timestamp),
      provider: toStr(o.provider) || '—',
      model: toStr(o.model) || '—',
      originalModel: toStr(o.originalModel),
      upstreamModel: toStr(o.upstreamModel),
      clientType: toStr(o.clientType),
      scenarioType: toStr(o.scenarioType) || 'default',
      inputTokens: toNum(o.inputTokens),
      outputTokens: toNum(o.outputTokens),
      cacheReadTokens: toNum(o.cacheReadTokens),
      cacheWriteTokens: toNum(o.cacheWriteTokens),
      ttftMs: toNum(o.ttftMs),
      tokensPerSecond: toNum(o.tokensPerSecond),
      durationMs: toNum(o.durationMs),
      status: o.status === 'error' ? 'error' : 'success',
      usageEstimated: o.usageEstimated === true,
      errorMessage: toStr(o.errorMessage),
    };
  }
  function normalizeRecordsPage(r) {
    var s = r && typeof r === 'object' ? r : {};
    return {
      period: toStr(s.period),
      page: toNum(s.page),
      pageSize: toNum(s.pageSize),
      total: toNum(s.total),
      records: Array.isArray(s.records) ? s.records.map(normalizeRecord) : [],
    };
  }
  // Model column shows the routing chain originalModel → model → upstreamModel;
  // adjacent identical legs collapse so an unchanged route doesn't read as a
  // "m → m" hop (mirrors the Web usage table).
  function modelChain(r) {
    var o = r && typeof r === 'object' ? r : {};
    var model = toStr(o.model) || '—';
    var legs = [toStr(o.originalModel) || model, model];
    var upstream = toStr(o.upstreamModel);
    if (upstream && upstream !== model) legs.push(upstream);
    var out = [];
    for (var i = 0; i < legs.length; i++) {
      if (out.length && out[out.length - 1] === legs[i]) continue;
      out.push(legs[i]);
    }
    return out.join(' → ');
  }
  // byModel arrives sorted by request count; charts rank by total tokens.
  // Effective input mirrors the Web UsageStats heuristic (computeEffectiveInputTokens):
  // some upstreams report inputTokens inclusive of cache read/write (then input
  // ~= cache sum within a tolerance), others report net input. Never double-count.
  function effectiveInputTokens(input, cacheRead, cacheWrite) {
    if (input === null) return null;
    var cacheTotal = (toNum(cacheRead) || 0) + (toNum(cacheWrite) || 0);
    if (cacheTotal <= 0) return input;
    var tolerance = Math.max(500, input * 0.02);
    return Math.abs(input - cacheTotal) <= tolerance ? input : input + cacheTotal;
  }
  function rowTotalTokens(row) {
    var input = effectiveInputTokens(row.inputTokens, row.cacheReadTokens, row.cacheWriteTokens);
    if (input === null || row.outputTokens === null) return null;
    return input + row.outputTokens;
  }

  function topModelsByTotal(rows, limit) {
    var list = (Array.isArray(rows) ? rows : []).slice();
    list.sort(function (a, b) {
      var ta = rowTotalTokens(a) || 0;
      var tb = rowTotalTokens(b) || 0;
      return tb - ta;
    });
    return typeof limit === 'number' ? list.slice(0, limit) : list;
  }

  function createRecordsController(options) {
    var invoke = options && options.invoke;
    if (typeof invoke !== 'function') throw new TypeError('createRecordsController: 需要 invoke 函数');
    var period = DEFAULT_USAGE_PERIOD, page = 1, pageSize = RECORDS_PAGE_SIZE;
    var data = null, loading = false, error = null;
    var epoch = 0;
    var listeners = new Set();

    function state() {
      var total = data ? data.total : null;
      return {
        period: period, page: page, pageSize: pageSize,
        data: data, loading: loading, error: error,
        total: total,
        totalPages: total === null ? null : Math.max(1, Math.ceil(total / pageSize)),
        canPrev: page > 1,
        canNext: total !== null && page * pageSize < total,
      };
    }
    function emit() { var s = state(); listeners.forEach(function (fn) { try { fn(s); } catch { /* Rendering errors do not affect controller state. */ } }); }
    function subscribe(fn) { listeners.add(fn); return function () { listeners.delete(fn); }; }

    function load() {
      loading = true;
      error = null;
      emit();
      var my = ++epoch;
      invoke('usage_records', { period: period, page: page, pageSize: pageSize }).then(function (r) {
        if (my !== epoch) return;
        data = normalizeRecordsPage(r);
        loading = false;
        emit();
      }, function (err) {
        if (my !== epoch) return;
        loading = false;
        error = errorMessage(err);
        emit();
      });
    }

    return {
      subscribe: subscribe, state: state,
      setPeriod: function (p) {
        if (USAGE_PERIODS.indexOf(p) === -1 || p === period) return;
        period = p;
        page = 1; // a new period always starts from the first page
        load();
      },
      prev: function () { if (page <= 1) return; page -= 1; load(); },
      next: function () {
        var total = data ? data.total : null;
        if (total === null || page * pageSize >= total) return;
        page += 1;
        load();
      },
      refresh: load,
    };
  }


  // ---- Clients tab -------------------------------------------------------
  // clients_snapshot() / clients_update({id,action:'enable'|'disable'|'restore'})
  // Operations are strictly per-client; restore requires an explicit local
  // confirmation and there is no bulk apply.

  function normalizeClientsResponse(r) {
    var s = r && typeof r === 'object' ? r : {};
    var list = Array.isArray(s.clients) ? s.clients : [];
    return {
      clients: list.map(function (c) {
        var o = c && typeof c === 'object' ? c : {};
        return {
          id: toStr(o.id) || '',
          name: toStr(o.name) || toStr(o.id) || '未知客户端',
          enabled: o.enabled === true,
          managed: o.managed === true,
          exists: o.exists !== false,
          activeModel: toStr(o.activeModel),
          modelAlias: toStr(o.modelAlias),
        };
      }),
      success: s.success !== false,
      message: toStr(s.message),
    };
  }

  function createClientsController(options) {
    var invoke = options && options.invoke;
    if (typeof invoke !== 'function') throw new TypeError('createClientsController: 需要 invoke 函数');
    var snapshot = null, loading = false, error = null;
    var pending = null; // {id, action}
    var rowError = null; // {id, message}
    var confirmId = null;
    var epoch = 0;
    var listeners = new Set();

    function state() {
      return { snapshot: snapshot, loading: loading, error: error, pending: pending, rowError: rowError, confirmId: confirmId };
    }
    function emit() { var s = state(); listeners.forEach(function (fn) { try { fn(s); } catch { /* Rendering errors do not affect controller state. */ } }); }
    function subscribe(fn) { listeners.add(fn); return function () { listeners.delete(fn); }; }

    function refresh() {
      if (loading || pending) return;
      loading = true;
      error = null;
      emit();
      var my = ++epoch;
      invoke('clients_snapshot').then(function (r) {
        if (my !== epoch) return;
        snapshot = normalizeClientsResponse(r);
        loading = false;
        emit();
      }, function (err) {
        if (my !== epoch) return;
        loading = false;
        error = errorMessage(err);
        emit();
      });
    }

    function performUpdate(id, action) {
      if (!snapshot || pending || loading) return false;
      // An open restore confirmation blocks other mutations until confirmed or cancelled.
      if (confirmId !== null) return false;
      if (['enable', 'disable', 'restore'].indexOf(action) === -1) return false;
      var known = snapshot.clients.some(function (c) { return c.id === id; });
      if (!known) return false;
      pending = { id: id, action: action };
      rowError = null;
      confirmId = null;
      emit();
      var my = ++epoch;
      invoke('clients_update', { id: id, action: action }).then(function (r) {
        if (my !== epoch) return;
        pending = null;
        var resp = normalizeClientsResponse(r);
        snapshot = resp;
        if (resp.success === false) {
          rowError = { id: id, message: resp.message || '部分客户端操作未成功' };
        }
        emit();
      }, function (err) {
        if (my !== epoch) return;
        pending = null;
        rowError = { id: id, message: errorMessage(err) };
        emit();
      });
      return true;
    }

    return {
      subscribe: subscribe, state: state, refresh: refresh,
      connect: function (id) { return performUpdate(id, 'enable'); },
      disconnect: function (id) { return performUpdate(id, 'disable'); },
      // Restore rewrites the client's config file, so it must be confirmed
      // through requestRestore/confirmRestore; never auto-enabled.
      requestRestore: function (id) {
        if (pending || !snapshot) return false;
        if (!snapshot.clients.some(function (c) { return c.id === id && c.managed; })) return false;
        confirmId = id;
        emit();
        return true;
      },
      cancelRestore: function () {
        if (confirmId === null) return false;
        confirmId = null;
        emit();
        return true;
      },
      confirmRestore: function (id) {
        if (confirmId !== id) return false;
        confirmId = null; // close the strip before performing the mutation
        return performUpdate(id, 'restore');
      },
    };
  }


  // ---- Service state -----------------------------------------------------
  // service_snapshot() / service_action({action:'start'|'stop'}).
  // Stop only ever targets a desktop-owned child process; an external
  // gateway is never stopped from here (UI disables it, Rust rejects it).

  var SERVICE_MODES = ['owned', 'external', 'stopped', 'starting', 'error'];
  function normalizeServiceState(r) {
    var s = r && typeof r === 'object' ? r : {};
    var mode = SERVICE_MODES.indexOf(s.mode) !== -1 ? s.mode : null;
    return { mode: mode, running: s.running === true, message: toStr(s.message) };
  }

  function serviceView(service) {
    var s = service && SERVICE_MODES.indexOf(service.mode) !== -1 ? service : null;
    var mode = s ? s.mode : null;
    if (mode === null) {
      return { label: '服务状态未知', tone: 'muted', canStart: false, canStop: false, startTitle: '服务状态未知，请先刷新', stopTitle: '服务状态未知' };
    }
    if (mode === 'owned') {
      if (s.running) {
        return { label: '托管服务 · 运行中', tone: 'ok', canStart: false, canStop: true, startTitle: '服务已在运行', stopTitle: '停止由桌面启动的网关服务' };
      }
      return { label: '托管服务 · 已停止', tone: 'muted', canStart: true, canStop: false, startTitle: '启动桌面托管的网关服务', stopTitle: '服务未在运行' };
    }
    if (mode === 'external') {
      return { label: '外部服务 · 运行中', tone: 'ok', canStart: false, canStop: false, startTitle: '服务已在运行', stopTitle: '外部启动的网关服务不能从这里停止' };
    }
    if (mode === 'starting') {
      return { label: '服务启动中…', tone: 'warn', canStart: false, canStop: false, startTitle: '服务启动中', stopTitle: '服务启动中' };
    }
    if (mode === 'stopped') {
      return { label: '服务已停止', tone: 'muted', canStart: true, canStop: false, startTitle: '启动桌面托管的网关服务', stopTitle: '服务未在运行' };
    }
    // error
    return { label: '服务异常', tone: 'warn', canStart: true, canStop: false, startTitle: '再次尝试启动服务', stopTitle: '服务未在运行' };
  }
  function quitTitleFor(service) {
    var mode = service && SERVICE_MODES.indexOf(service.mode) !== -1 ? service.mode : null;
    if (mode === 'external') return '退出桌面应用；外部启动的网关服务不受影响';
    return '退出桌面应用；由本应用启动的网关服务会一并停止';
  }

  function createServiceController(options) {
    var invoke = options && options.invoke;
    if (typeof invoke !== 'function') throw new TypeError('createServiceController: 需要 invoke 函数');
    var service = null, loading = false, pending = null, error = null;
    var epoch = 0;
    var listeners = new Set();

    function state() {
      return { service: service, loading: loading, pending: pending, error: error };
    }
    function emit() { var s = state(); listeners.forEach(function (fn) { try { fn(s); } catch { /* Rendering errors do not affect controller state. */ } }); }
    function subscribe(fn) { listeners.add(fn); return function () { listeners.delete(fn); }; }

    function refresh() {
      if (loading || pending) return;
      loading = true;
      error = null;
      emit();
      var my = ++epoch;
      invoke('service_snapshot').then(function (r) {
        if (my !== epoch) return;
        service = normalizeServiceState(r);
        loading = false;
        emit();
      }, function (err) {
        if (my !== epoch) return;
        loading = false;
        error = errorMessage(err);
        emit();
      });
    }

    function action(a) {
      if (pending || loading || (a !== 'start' && a !== 'stop')) return false;
      var view = serviceView(service);
      if ((a === 'start' && !view.canStart) || (a === 'stop' && !view.canStop)) return false;
      pending = a;
      error = null;
      emit();
      var my = ++epoch;
      invoke('service_action', { action: a }).then(function (r) {
        if (my !== epoch) return;
        service = normalizeServiceState(r);
        pending = null;
        emit();
      }, function (err) {
        if (my !== epoch) return;
        pending = null;
        error = errorMessage(err);
        emit();
      });
      return true;
    }

    return { subscribe: subscribe, state: state, refresh: refresh, action: action };
  }


  // ---- Preview mode (?preview=1 without Tauri) ---------------------------
  // In-memory fixtures covering every contract command, so the panel is fully
  // browsable outside Tauri. Never used when window.__TAURI__ is present.

  function createPreviewInvoke() {
    var projectsPreview = typeof ProjectsUI !== 'undefined' ? ProjectsUI.createPreviewProjects() : null;
    var rev = 1;
    var routing = {
      providers: [
        { name: 'alpha.example.com', models: ['claude-opus-4-5', 'claude-sonnet-4-5'] },
        { name: 'beta.example.com', models: ['gemini-3-pro', 'glm-5'] },
      ],
      routes: [
        { scope: 'global', field: 'default', target: 'alpha.example.com,claude-sonnet-4-5', fallback: ['beta.example.com,gemini-3-pro'] },
        { scope: 'global', field: 'background', target: 'beta.example.com,glm-5', fallback: [] },
        { scope: 'global', field: 'think', target: 'alpha.example.com,claude-opus-4-5', fallback: [] },
        { scope: 'opus', field: 'default', target: 'alpha.example.com,claude-opus-4-5', fallback: ['alpha.example.com,claude-sonnet-4-5', 'beta.example.com,gemini-3-pro'] },
        { scope: 'sonnet', field: 'default', target: 'alpha.example.com,claude-sonnet-4-5', fallback: [] },
        { scope: 'models', field: 'glm-5', target: 'beta.example.com,glm-5', fallback: [] },
      ],
      familyRouting: true,
      fallbackEnabled: true,
      revision: 'rev-1',
    };
    var previewDay = new Date();
    var usage = {
      today: {
        period: 'today', totalRequests: 128, successCount: 125, errorCount: 3,
        inputTokens: 842100, outputTokens: 231500, cacheReadTokens: 102400, cacheWriteTokens: 30700, estimatedCount: 12,
        avgTtftMs: 842, avgTokensPerSecond: 36.2,
        byProvider: [
          { name: 'alpha.example.com', requests: 96, inputTokens: 640000, outputTokens: 180000, cacheReadTokens: 80000, cacheWriteTokens: 10700 },
          { name: 'beta.example.com', requests: 32, inputTokens: 202100, outputTokens: 51500, cacheReadTokens: 22400, cacheWriteTokens: 20000 },
        ],
        byModel: [{ name: 'claude-sonnet-4-5', requests: 128, inputTokens: 842100, outputTokens: 231500, cacheReadTokens: 102400, cacheWriteTokens: 30700 }],
        byDay: [{ name: usageDayKey(previewDay, 0), requests: 128, inputTokens: 842100, outputTokens: 231500, cacheReadTokens: 102400, cacheWriteTokens: 30700 }],
        updatedAt: Date.now() - 3000,
      },
      '7d': {
        period: '7d', totalRequests: 902, successCount: 890, errorCount: 12,
        inputTokens: 6210000, outputTokens: 1540000, cacheReadTokens: 810300, cacheWriteTokens: 214500, estimatedCount: 57,
        avgTtftMs: 905, avgTokensPerSecond: 33.8,
        byModel: [{ name: 'claude-sonnet-4-5', requests: 902, inputTokens: 6210000, outputTokens: 1540000, cacheReadTokens: 810300, cacheWriteTokens: 214500 }],
        byProvider: [
          { name: 'alpha.example.com', requests: 655, inputTokens: 4500000, outputTokens: 1150000, cacheReadTokens: 610300, cacheWriteTokens: 114500 },
          { name: 'beta.example.com', requests: 247, inputTokens: 1710000, outputTokens: 390000, cacheReadTokens: 200000, cacheWriteTokens: 100000 },
        ],
        byDay: [
          { name: usageDayKey(previewDay, 0), requests: 128, inputTokens: 842100, outputTokens: 231500, cacheReadTokens: 102400, cacheWriteTokens: 30700 },
          { name: usageDayKey(previewDay, 1), requests: 140, inputTokens: 900000, outputTokens: 240000, cacheReadTokens: 120000, cacheWriteTokens: 35000 },
          { name: usageDayKey(previewDay, 2), requests: 155, inputTokens: 950000, outputTokens: 250000, cacheReadTokens: 130000, cacheWriteTokens: 40000 },
          { name: usageDayKey(previewDay, 3), requests: 132, inputTokens: 720000, outputTokens: 190000, cacheReadTokens: 90000, cacheWriteTokens: 26000 },
          { name: usageDayKey(previewDay, 4), requests: 147, inputTokens: 880000, outputTokens: 228000, cacheReadTokens: 105000, cacheWriteTokens: 31000 },
          { name: usageDayKey(previewDay, 5), requests: 101, inputTokens: 520000, outputTokens: 152000, cacheReadTokens: 66000, cacheWriteTokens: 20000 },
          { name: usageDayKey(previewDay, 6), requests: 99, inputTokens: 498000, outputTokens: 148500, cacheReadTokens: 67200, cacheWriteTokens: 18800 },
        ],
        updatedAt: Date.now() - 3000,
      },
      '30d': {
        period: '30d', totalRequests: 4120, successCount: 4044, errorCount: 76,
        inputTokens: 28600000, outputTokens: 7100000, cacheReadTokens: 3600000, cacheWriteTokens: 980000, estimatedCount: 231,
        avgTtftMs: 878, avgTokensPerSecond: 34.9,
        byModel: [{ name: 'claude-sonnet-4-5', requests: 4120, inputTokens: 28600000, outputTokens: 7100000, cacheReadTokens: 3600000, cacheWriteTokens: 980000 }],
        byProvider: [
          { name: 'alpha.example.com', requests: 3010, inputTokens: 21000000, outputTokens: 5300000, cacheReadTokens: 2600000, cacheWriteTokens: 680000 },
          { name: 'beta.example.com', requests: 1110, inputTokens: 7600000, outputTokens: 1800000, cacheReadTokens: 1000000, cacheWriteTokens: 300000 },
        ],
        byDay: [
          { name: usageDayKey(previewDay, 0), requests: 128, inputTokens: 842100, outputTokens: 231500, cacheReadTokens: 102400, cacheWriteTokens: 30700 },
          { name: usageDayKey(previewDay, 1), requests: 140, inputTokens: 900000, outputTokens: 240000, cacheReadTokens: 120000, cacheWriteTokens: 35000 },
        ],
        updatedAt: Date.now() - 3000,
      },
    };
    var olderDay = { name: '2026-09-01', requests: 1, inputTokens: 1000, outputTokens: 250, cacheReadTokens: 0, cacheWriteTokens: 0 };
    usage.all = Object.assign({}, usage['30d'], {
      period: 'all', totalRequests: 4121, successCount: 4045, inputTokens: 28601000, outputTokens: 7100250,
      byDay: [olderDay].concat(usage['30d'].byDay),
    });
    var clients = {
      clients: [
        { id: 'claudeCode', name: 'Claude Code', enabled: true, managed: true, exists: true, activeModel: 'claude-sonnet-4-5', modelAlias: 'claude-sonnet-4-5' },
        { id: 'codex', name: 'Codex', enabled: true, managed: true, exists: true, activeModel: 'gpt-5-codex', modelAlias: null },
        { id: 'pi', name: 'Pi', enabled: false, managed: true, exists: true, activeModel: null, modelAlias: null },
        { id: 'qwenCode', name: 'Qwen Code', enabled: false, managed: false, exists: false, activeModel: null, modelAlias: null },
        { id: 'opencode', name: 'OpenCode', enabled: true, managed: true, exists: true, activeModel: 'claude-opus-4-5', modelAlias: null },
      ],
      success: true,
      message: null,
    };
    var service = { mode: 'owned', running: true, message: '' };
    // Coding Plan credentials preview: fake in-memory values only; the DTO
    // never carries them, mirroring the Rust projection.
    var credentials = { providers: [{ name: '火山agent plan', configured: false }] };
    var credentialKeys = { accessKey: '', secretKey: '' };

    // Deterministic record fixtures spanning several pages (45/132/260 items)
    // with one stable error record and one estimated record on the first page.
    var RECORD_PROVIDERS = ['alpha.example.com', 'beta.example.com'];
    var RECORD_CLIENTS = ['claude-code', 'codex', 'pi'];
    var RECORD_CHAINS = [
      { original: null, model: 'claude-sonnet-4-5', upstream: null },
      { original: 'claude-opus-4-5', model: 'glm-5', upstream: 'glm-5-air' },
      { original: 'gpt-5-codex', model: 'gpt-5-codex', upstream: null },
    ];
    var RECORD_COUNTS = { today: 45, '7d': 132, '30d': 260, all: 320 };
    function previewRecords(period) {
      var n = RECORD_COUNTS[period] || 45;
      var records = [];
      for (var i = 0; i < n; i++) {
        var chain = RECORD_CHAINS[i % RECORD_CHAINS.length];
        var failed = i === 4; // stable error record on the first page
        records.push({
          timestamp: new Date(Date.now() - i * 240000).toISOString(),
          provider: RECORD_PROVIDERS[i % RECORD_PROVIDERS.length],
          model: chain.model,
          originalModel: chain.original,
          upstreamModel: chain.upstream,
          clientType: RECORD_CLIENTS[i % RECORD_CLIENTS.length],
          scenarioType: i % 4 === 0 ? 'background' : 'default',
          inputTokens: 1200 + (i % 7) * 350,
          outputTokens: 300 + (i % 5) * 120,
          cacheReadTokens: (i % 3) * 900,
          cacheWriteTokens: (i % 2) * 400,
          ttftMs: failed ? null : 420 + (i % 6) * 95,
          tokensPerSecond: failed ? null : 18 + (i % 5) * 4.5,
          durationMs: 1800 + (i % 9) * 700,
          status: failed ? 'error' : 'success',
          usageEstimated: i === 8, // stable estimated record on the first page
          errorMessage: failed ? '上游提供方返回 429，重试 3 次后仍失败' : null,
        });
      }
      return records;
    }
    var recordsCache = null;
    function recordsFor(period) {
      if (!recordsCache) recordsCache = { today: previewRecords('today'), '7d': previewRecords('7d'), '30d': previewRecords('30d'), all: previewRecords('all') };
      return recordsCache[period] || recordsCache.today;
    }

    function copy(v) { return JSON.parse(JSON.stringify(v)); }
    function delay(v) { return new Promise(function (resolve) { setTimeout(function () { resolve(v); }, 120); }); }
    var pluginsPreview = typeof PluginsUI !== 'undefined' ? PluginsUI.createPreviewPlugins(function (v) { return delay(copy(v)); }) : null;
    function bump() { rev += 1; routing.revision = 'rev-' + rev; }

    function previewQuotaProviders(now) {
      var h = function (n) { return new Date(now + n * 3600e3).toISOString(); };
      return [
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
        { name: '火山agent plan', enabled: true, plan: null, status: 'unavailable', message: '未提供可用额度数据（来源未声明查询能力）', windows: [], updatedAt: null },
      ];
    }
    var quotaProviders = previewQuotaProviders(Date.now());
    var providerDetails = new Map(quotaProviders.map(function (row) {
      var route = routing.providers.find(function (p) { return p.name === row.name; });
      return [row.name, { name: row.name, baseUrl: 'https://example.com/v1', models: route ? route.models.slice() : ['model'], managed: false, transformer: null, transformerProtected: false }];
    }));

    var previewCatalog = { names: ['OpenAI', 'customparams'], parameterizedNames: ['customparams'] };

    function applyPreviewRoute(change) {
      var idx = routing.routes.findIndex(function (route) {
        return route.scope === change.scope && route.field === change.field;
      });
      var target = typeof change.target === 'string' ? change.target.trim() || null : null;
      var fallback = Array.isArray(change.fallback)
        ? change.fallback.map(function (f) { return typeof f === 'string' ? f.trim() : ''; }).filter(Boolean)
        : (idx !== -1 ? routing.routes[idx].fallback : []);
      var entry = { scope: change.scope, field: change.field, target: target, fallback: fallback };
      if (!target && !fallback.length) {
        if (idx !== -1) routing.routes.splice(idx, 1);
      } else if (idx === -1) routing.routes.push(entry);
      else routing.routes[idx] = entry;
    }

    var STALE_MSG = '路由配置已被其他程序修改，请刷新后重试';
    return function (cmd, args) {
      var a = args && typeof args === 'object' ? args : {};
      if (cmd.indexOf('projects_') === 0 && projectsPreview) return projectsPreview(cmd, args);
      if (cmd.indexOf('plugin_') === 0 && pluginsPreview) return pluginsPreview.invoke(cmd, a);
      if (cmd === 'quota_snapshot') {
        return delay({ providers: copy(quotaProviders), updatedAt: Date.now() - 2e3, online: true, error: null });
      }
      if (cmd === 'provider_transformers') return delay(copy(previewCatalog));
      if (cmd === 'provider_get') {
        var detail = providerDetails.get(a.name);
        if (detail && detail.managed) return Promise.reject(new Error('PROVIDER_MANAGED'));
        return detail ? delay(copy(detail)) : Promise.reject(new Error('PROVIDER_UNAVAILABLE'));
      }
      if (cmd === 'provider_add' || cmd === 'provider_update') {
        var editing = cmd === 'provider_update';
        var provider = a.provider;
        if (providerInputError(provider, editing)) return Promise.reject(new Error('PROVIDER_INVALID'));
        var name = provider.name.trim();
        var previous = editing && providerDetails.get(a.name);
        if (editing && !previous) return Promise.reject(new Error('PROVIDER_UNAVAILABLE'));
        if (previous && previous.managed) return Promise.reject(new Error('PROVIDER_MANAGED'));
        if (editing && name !== a.name) return Promise.reject(new Error('PROVIDER_INVALID'));
        var row = editing && quotaProviders.find(function (p) { return p.name === a.name; });
        if (quotaProviders.some(function (p) { return p !== row && p.name.toLowerCase() === name.toLowerCase(); })) {
          return Promise.reject(new Error('PROVIDER_DUPLICATE'));
        }
        var models = provider.models.map(function (m) { return m.trim(); });
        var managed = name === 'ccr' || (provider.apiKey || '').trim().startsWith('ccr-managed-');
        var transformer = previous ? previous.transformer : null;
        var transformerProtected = previous ? previous.transformerProtected : false;
        if (provider.transformer !== undefined) {
          var chain = provider.transformer === null ? [] : provider.transformer.use;
          var validName = function (value) {
            return typeof value === 'string' && value.trim() && Array.from(value.trim()).length <= 64 && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
          };
          if (provider.transformer === null ? !editing :
              Object.keys(provider.transformer).length !== 1 || !Array.isArray(chain) || !chain.length || chain.length > 8 || chain.some(function (item) {
                if (!Array.isArray(item)) return !validName(item);
                return item.length !== 2 || !validName(item[0]) || !previewCatalog.parameterizedNames.includes(item[0].trim()) ||
                  !item[1] || typeof item[1] !== 'object' || Array.isArray(item[1]) || new TextEncoder().encode(JSON.stringify(item[1])).length > 2048;
              })) return Promise.reject(new Error('PROVIDER_INVALID'));
          transformerProtected = chain.some(Array.isArray);
          transformer = chain.length ? { use: chain.map(function (item) { return (Array.isArray(item) ? item[0] : item).trim(); }) } : null;
        }
        providerDetails.set(name, { name: name, baseUrl: provider.baseUrl.trim(), models: models, managed: managed,
          transformer: transformer, transformerProtected: transformerProtected });
        if (!row) quotaProviders.push({ name: name, enabled: true, plan: null, status: 'unsupported', message: null, updatedAt: null, windows: [] });
        var route = editing && routing.providers.find(function (p) { return p.name === a.name; });
        if (route) route.models = models;
        else if (!row || row.enabled) routing.providers.push({ name: name, models: models });
        bump();
        return delay({ name: name });
      }
      if (cmd === 'routing_snapshot') return delay(copy(routing));
      if (cmd === 'routing_save') {
        var change = a.change && typeof a.change === 'object' ? a.change : {};
        if (change.revision !== routing.revision) return Promise.reject(new Error(STALE_MSG));
        if (ROUTING_SCOPES.indexOf(change.scope) === -1) return Promise.reject(new Error('路由范围无效'));
        if (typeof change.field !== 'string' || !change.field) return Promise.reject(new Error('路由字段无效'));
        applyPreviewRoute(change);
        bump();
        return delay(copy(routing));
      }
      if (cmd === 'routing_save_groups') {
        var changes = Array.isArray(a.changes) ? a.changes : [];
        var seen = new Set();
        if (!changes.length || changes.some(function (change) {
          if (!change || typeof change.field !== 'string') return true;
          var key = routeKey(change.scope, change.field.trim());
          if (!isModelGroupKey(key) || seen.has(key)) return true;
          seen.add(key);
          return false;
        })) return Promise.reject(new Error('模型组修改无效'));
        if (changes.some(function (change) { return change.revision !== routing.revision; })) {
          return Promise.reject(new Error(STALE_MSG));
        }
        changes.forEach(function (change) {
          applyPreviewRoute(Object.assign({}, change, { field: change.field.trim() }));
        });
        bump();
        return delay(copy(routing));
      }
      if (cmd === 'routing_flags') {
        if (a.revision !== routing.revision) return Promise.reject(new Error(STALE_MSG));
        routing.familyRouting = a.familyRouting === true;
        routing.fallbackEnabled = a.fallbackEnabled === true;
        bump();
        return delay(copy(routing));
      }
      if (cmd === 'usage_snapshot') {
        var period = USAGE_PERIODS.indexOf(a.period) !== -1 ? a.period : 'today';
        var result = copy(usage[period]);
        if (a.trend) result.updatedAt = previewDay.getTime();
        return delay(result);
      }
      if (cmd === 'usage_records') {
        // Mirrors the native contract: invalid period is a fixed error, page
        // clamps to >=1 and pageSize clamps to 1..50 with default 20.
        if (USAGE_PERIODS.indexOf(a.period) === -1) return Promise.reject(new Error('统计周期无效'));
        var recPage = Math.max(1, Math.floor(Number(a.page) || 1));
        var recSize = Math.min(50, Math.max(1, Math.floor(Number(a.pageSize) || RECORDS_PAGE_SIZE)));
        var all = recordsFor(a.period);
        var recStart = (recPage - 1) * recSize;
        return delay({ period: a.period, page: recPage, pageSize: recSize, total: all.length, records: all.slice(recStart, recStart + recSize) });
      }
      if (cmd === 'clients_snapshot') return delay(copy(clients));
      if (cmd === 'clients_update') {
        var client = null;
        for (var j = 0; j < clients.clients.length; j++) if (clients.clients[j].id === a.id) { client = clients.clients[j]; break; }
        if (!client) return Promise.reject(new Error('未知客户端'));
        if (['enable', 'disable', 'restore'].indexOf(a.action) === -1) return Promise.reject(new Error('客户端操作无效'));
        if (a.action === 'enable') client.enabled = true;
        else if (a.action === 'disable') client.enabled = false;
        else if (a.action === 'restore') { client.enabled = false; client.managed = false; client.activeModel = null; client.modelAlias = null; }
        return delay(copy(clients));
      }
      if (cmd === 'quota_credentials_status') return delay(copy(credentials));
      if (cmd === 'quota_credentials_save') {
        var credEntry = null;
        for (var k = 0; k < credentials.providers.length; k++) if (credentials.providers[k].name === a.name) { credEntry = credentials.providers[k]; break; }
        // Keep wording identical to credentials.rs ERR_NOT_FOUND so preview and production match.
        if (!credEntry) return Promise.reject(new Error('Coding Plan provider is no longer configured; refresh the panel'));
        if (typeof a.accessKey === 'string') credentialKeys.accessKey = a.accessKey.trim();
        if (typeof a.secretKey === 'string') credentialKeys.secretKey = a.secretKey.trim();
        credEntry.configured = !!(credentialKeys.accessKey && credentialKeys.secretKey);
        return delay(copy(credentials));
      }
      if (cmd === 'service_snapshot') return delay(copy(service));
      if (cmd === 'service_action') {
        if (a.action === 'start') {
          if (service.mode === 'owned' || service.mode === 'external' || service.mode === 'starting') {
            return Promise.reject(new Error('服务已在运行或启动中'));
          }
          service = { mode: 'owned', running: true, message: '' };
          if (pluginsPreview) pluginsPreview.start();
          return delay(copy(service));
        }
        if (a.action === 'stop') {
          if (service.mode === 'external') return Promise.reject(new Error('外部服务不能从这里停止'));
          if (service.mode !== 'owned') return Promise.reject(new Error('服务未在运行'));
          service = { mode: 'stopped', running: false, message: '' };
          return delay(copy(service));
        }
        return Promise.reject(new Error('服务操作无效'));
      }
      return Promise.resolve(null);
    };
  }


  // ---- Exports (pure logic for tests; DOM code is document-guarded) ------

  var QuotaUI = {
    // quota tab (unchanged contract)
    normalizeSnapshot: normalizeSnapshot, normalizeProvider: normalizeProvider, normalizeWindow: normalizeWindow,
    statusMeta: statusMeta, computePercent: computePercent, formatPercent: formatPercent,
    formatAmount: formatAmount, formatResetTime: formatResetTime, formatTimestamp: formatTimestamp,
    describeWindow: describeWindow, createController: createController,
    // Coding Plan quota credentials (quota tab)
    normalizeCredentialsStatus: normalizeCredentialsStatus, createCredentialsController: createCredentialsController,
    // shared helpers
    errorMessage: errorMessage, formatInt: formatInt, formatCompact: formatCompact, formatClock: formatClock,
    formatMs: formatMs, formatSpeed: formatSpeed, formatSuccessRate: formatSuccessRate,
    // routing tab
    ROUTING_SCOPES: ROUTING_SCOPES, ROUTING_SCENARIOS: ROUTING_SCENARIOS, USAGE_PERIODS: USAGE_PERIODS,
    SCOPE_LABELS: SCOPE_LABELS, SCENARIO_LABELS: SCENARIO_LABELS,
    routeKey: routeKey, splitKey: splitKey, routeLabel: routeLabel,
    normalizeRoutingSnapshot: normalizeRoutingSnapshot, findRoute: findRoute,
    canonicalTarget: canonicalTarget, canonicalFallback: canonicalFallback,
    createRoutingController: createRoutingController,
    // usage / clients / service
    normalizeUsageSnapshot: normalizeUsageSnapshot, createUsageController: createUsageController,
    // usage records
    RECORDS_PAGE_SIZE: RECORDS_PAGE_SIZE, clientLabel: clientLabel,
    normalizeRecord: normalizeRecord, normalizeRecordsPage: normalizeRecordsPage,
    modelChain: modelChain, topModelsByTotal: topModelsByTotal,
    createRecordsController: createRecordsController,
    normalizeClientsResponse: normalizeClientsResponse, createClientsController: createClientsController,
    SERVICE_MODES: SERVICE_MODES, normalizeServiceState: normalizeServiceState,
    serviceView: serviceView, quitTitleFor: quitTitleFor, createServiceController: createServiceController,
    // preview fixtures (complete contracts, ?preview=1 only)
    createPreviewInvoke: createPreviewInvoke,
  };
  if (typeof globalThis !== 'undefined') globalThis.QuotaUI = QuotaUI;


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
  function mkBtn(text, label, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn';
    b.textContent = text;
    if (label) { b.title = label; b.setAttribute('aria-label', label); }
    b.addEventListener('click', onClick);
    return b;
  }
  function noteEl(text) { return el('div', 'note', text); }

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
    // Coding Plan credentials affordances; visibility is driven by the
    // credentials status projection (only matching volces providers).
    var creds = document.createElement('button');
    creds.type = 'button';
    creds.className = 'btn card-creds';
    creds.setAttribute('data-creds-open', '1');
    creds.textContent = '用量凭证';
    creds.title = '配置火山 Coding Plan 用量查询凭证（AK/SK）';
    creds.hidden = true;
    var edit = el('button', 'btn card-edit', '编辑');
    edit.type = 'button';
    edit.setAttribute('aria-controls', 'provider-add-form');
    var refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.className = 'btn btn-icon card-refresh';
    refresh.dataset.refresh = '1';
    refresh.appendChild(icon(REFRESH_PATHS));
    actions.appendChild(status);
    actions.appendChild(creds);
    actions.appendChild(edit);
    actions.appendChild(refresh);
    head.appendChild(title);
    head.appendChild(actions);
    var message = el('p', 'card-message'); message.hidden = true;
    var error = el('p', 'card-error'); error.hidden = true;
    var credsNote = el('p', 'card-creds-note', '未配置 AK/SK，无法查询套餐用量'); credsNote.hidden = true;
    var windows = el('ul', 'windows');
    var credsPanel = buildCredsPanel();
    var loading = el('p', 'card-loading'); loading.hidden = true;
    li.appendChild(head); li.appendChild(message); li.appendChild(error); li.appendChild(credsNote); li.appendChild(windows); li.appendChild(credsPanel.root); li.appendChild(loading);
    return { li: li, name: name, badges: badges, status: status, edit: edit, refresh: refresh, creds: creds, credsNote: credsNote, credsPanel: credsPanel.root, credsAk: credsPanel.ak, credsSk: credsPanel.sk, credsMsg: credsPanel.msg, credsSave: credsPanel.saveBtn, credsClear: credsPanel.clearBtn, credsCancel: credsPanel.cancelBtn, credsWasOpen: false, credsFlashStamp: null, message: message, error: error, windows: windows, loading: loading };
  }

  // Inline AK/SK editor in the client-confirm style; buttons are wired by
  // delegation on the quota list. Password inputs are never prefilled.
  function buildCredsPanel() {
    var root = el('div', 'creds-panel'); root.hidden = true;
    root.appendChild(el('div', 'creds-title', '火山 Coding Plan 用量凭证'));
    function field(labelText) {
      var label = el('label', 'creds-field');
      label.appendChild(el('span', null, labelText));
      var input = document.createElement('input');
      input.type = 'password';
      input.className = 'route-input';
      input.setAttribute('autocomplete', 'new-password');
      input.setAttribute('aria-label', labelText);
      label.appendChild(input);
      root.appendChild(label);
      return input;
    }
    var ak = field('AccessKey ID');
    var sk = field('Secret AccessKey');
    var msg = el('p', 'creds-msg'); msg.hidden = true;
    root.appendChild(msg);
    var actions = el('div', 'creds-actions');
    var saveBtn = mkBtn('保存', '保存用量凭证', function () {});
    saveBtn.className = 'btn btn-primary';
    saveBtn.setAttribute('data-creds-save', '1');
    var clearBtn = mkBtn('清除凭证', '清除已保存的 AK/SK', function () {});
    clearBtn.className = 'btn btn-danger-quiet';
    clearBtn.setAttribute('data-creds-clear', '1');
    clearBtn.hidden = true;
    var cancelBtn = mkBtn('取消', '关闭凭证面板', function () {});
    cancelBtn.setAttribute('data-creds-cancel', '1');
    actions.appendChild(saveBtn); actions.appendChild(clearBtn); actions.appendChild(cancelBtn);
    root.appendChild(actions);
    return { root: root, ak: ak, sk: sk, msg: msg, saveBtn: saveBtn, clearBtn: clearBtn, cancelBtn: cancelBtn };
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

  function mountTransformerEditor() {
    var section = document.getElementById('provider-transformers');
    var rows = document.getElementById('provider-transformer-rows');
    var add = document.getElementById('provider-transformer-add');
    var protectedPanel = document.getElementById('provider-transformer-protected');
    var summary = document.getElementById('provider-transformer-summary');
    var replace = document.getElementById('provider-transformer-replace');
    var confirmPanel = document.getElementById('provider-transformer-confirm');
    var keep = document.getElementById('provider-transformer-keep');
    var confirmReplace = document.getElementById('provider-transformer-confirm-replace');
    var names = [], parameterizedNames = [], originalChain = [], keepProtected = false, confirmedReplacement = false;

    function input(label, cls) {
      var field = el('input', 'route-input ' + cls);
      field.setAttribute('aria-label', label);
      field.placeholder = label;
      return field;
    }
    function select(label, cls, options) {
      var field = el('select', 'route-input ' + cls);
      field.setAttribute('aria-label', label);
      options.forEach(function (value) {
        var option = el('option', null, value);
        option.value = value;
        field.appendChild(option);
      });
      return field;
    }
    function addParam(params) {
      var pair = el('div', 'transformer-param');
      var key = input('参数名', 'param-key');
      pair.appendChild(key);
      pair.appendChild(select('参数值类型', 'param-type', ['文本', 'JSON']));
      var value = input('参数值', 'param-value');
      value.setAttribute('autocomplete', 'off');
      value.spellcheck = false;
      pair.appendChild(value);
      pair.appendChild(mkBtn('移除', '移除参数', function () { pair.remove(); }));
      params.appendChild(pair);
      key.focus();
    }
    function addRow(name) {
      var row = el('div', 'transformer-row');
      var field = names.length && (!name || names.includes(name))
        ? select('转换器名称', 'transformer-name', names) : input('转换器名称', 'transformer-name');
      field.value = name || names[0] || '';
      row.appendChild(field);
      row.appendChild(mkBtn('移除', '移除转换器', function () { row.remove(); }));
      var params = el('div', 'transformer-params');
      row.appendChild(params);
      var addParameter = mkBtn('添加参数', null, function () { addParam(params); });
      function syncParameterButton() { addParameter.disabled = !parameterizedNames.includes(field.value.trim()); }
      field.addEventListener('input', syncParameterButton);
      field.addEventListener('change', syncParameterButton);
      syncParameterButton();
      row.appendChild(addParameter);
      rows.appendChild(row);
      return field;
    }
    function reset() {
      rows.textContent = summary.textContent = '';
      protectedPanel.hidden = true;
      confirmPanel.hidden = true;
      replace.hidden = false;
      keepProtected = false;
      add.hidden = false;
      add.disabled = true;
      names = [];
      parameterizedNames = [];
      originalChain = [];
      confirmedReplacement = false;
    }
    add.addEventListener('click', function () { addRow('').focus(); });
    replace.addEventListener('click', function () {
      replace.hidden = true;
      confirmPanel.hidden = false;
      keep.focus();
    });
    keep.addEventListener('click', function () {
      confirmPanel.hidden = true;
      replace.hidden = false;
      replace.focus();
    });
    confirmReplace.addEventListener('click', function () {
      keepProtected = false;
      confirmedReplacement = true;
      protectedPanel.hidden = true;
      add.hidden = false;
      add.focus();
    });
    function prefill(entry) {
      var chain = entry.transformer && entry.transformer.use || [];
      if (!Array.isArray(chain) || !chain.every(function (name) { return typeof name === 'string'; })) throw new Error();
      originalChain = chain;
      keepProtected = entry.transformerProtected === true;
      if (keepProtected) {
        summary.textContent = '已保留现有转换器和参数。' + chain.join(' → ');
        protectedPanel.hidden = false;
        add.hidden = true;
      } else chain.forEach(addRow);
    }
    function writeTo(provider, editing, error) {
      if (keepProtected) return true;
      function invalid(field, message) { error.textContent = message; field.focus(); return false; }
      var use = [];
      for (var row of rows.children) {
        var field = row.querySelector('.transformer-name');
        var name = field.value.trim();
        if (!name) return invalid(field, '请输入转换器名称。');
        var params = Object.create(null);
        var pairs = row.querySelectorAll('.transformer-param');
        if (pairs.length && !parameterizedNames.includes(name)) return invalid(field, '此转换器不支持参数，请移除参数或选择其他转换器。');
        for (var pair of pairs) {
          var key = pair.querySelector('.param-key');
          var paramName = key.value.trim();
          if (!paramName || paramName in params) return invalid(key, '请输入唯一的参数名。');
          var value = pair.querySelector('.param-value');
          if (pair.querySelector('.param-type').value === 'JSON') {
            try { params[paramName] = JSON.parse(value.value); }
            catch { return invalid(value, '请输入有效的 JSON 值。'); }
          } else params[paramName] = value.value;
        }
        use.push(Object.keys(params).length ? [name, params] : name);
      }
      if (editing && !confirmedReplacement && use.length === originalChain.length && use.every(function (item, i) { return item === originalChain[i]; })) return true;
      if (use.length) provider.transformer = { use: use };
      else if (editing) provider.transformer = null;
      return true;
    }
    return {
      reset: reset, prefill: prefill, writeTo: writeTo,
      disable: function (disabled) { section.disabled = disabled; },
      setNames: function (result) {
        names = result && Array.isArray(result.names) ? result.names.filter(function (n) { return typeof n === 'string' && n.trim(); }) : [];
        parameterizedNames = result && Array.isArray(result.parameterizedNames) ? result.parameterizedNames.filter(function (n) { return names.includes(n); }) : [];
        add.disabled = false;
      },
    };
  }

  function mountProviderForm(invoke, onSaved) {
    var open = document.getElementById('provider-add-open');
    var form = document.getElementById('provider-add-form');
    var title = document.getElementById('provider-form-title');
    var cancel = document.getElementById('provider-add-cancel');
    var save = document.getElementById('provider-add-save');
    var error = document.getElementById('provider-add-error');
    var status = document.getElementById('provider-add-status');
    var fields = {
      name: document.getElementById('provider-name'), baseUrl: document.getElementById('provider-base-url'),
      apiKey: document.getElementById('provider-api-key'), models: document.getElementById('provider-models'),
    };
    var invalidMessages = {
      name: '请输入供应商名称，不能包含逗号或控制字符。',
      baseUrl: '请输入完整的 HTTP 或 HTTPS 地址，不能包含账号、密码或片段；查询参数仅支持版本号。',
      apiKey: '请输入有效的 API 密钥。', models: '请输入 1 至 256 个有效的模型 ID。',
    };
    var saving = false, loading = false, managed = false, editName = null;
    var trigger = open, readId = 0;
    var transformers = mountTransformerEditor();
    var managedNote = '系统托管的供应商请在对应插件卡片中管理';

    function close(restoreFocus) {
      if (form.hidden) return;
      Object.values(fields).forEach(function (field) { field.value = ''; });
      error.textContent = '';
      transformers.reset();
      form.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      if (restoreFocus) trigger.focus();
      trigger = open;
      editName = null;
      loading = managed = false;
      readId++;
    }
    function syncControls() {
      Object.values(fields).forEach(function (field) { field.disabled = saving || loading || managed; });
      transformers.disable(saving || loading || managed);
      form.setAttribute('aria-busy', String(saving || loading));
      open.disabled = !invoke || saving;
      cancel.disabled = saving;
      save.disabled = saving || loading || managed;
      save.textContent = saving ? '正在保存…' : editName !== null ? '保存修改' : '保存';
    }
    function show(name, button) {
      close(false);
      editName = name;
      loading = name !== null;
      trigger = button;
      title.textContent = loading ? '编辑供应商' : '添加供应商';
      fields.name.readOnly = loading;
      fields.name.title = loading ? '名称用于路由，创建后不可修改。' : '';
      fields.apiKey.required = !loading;
      fields.apiKey.placeholder = loading ? '已保存，留空则不修改' : '';
      status.textContent = '';
      form.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      transformers.reset();
      syncControls();
      var id = ++readId;
      return invoke('provider_transformers').catch(function () { return null; }).then(function (result) {
        if (id === readId) transformers.setNames(result);
      });
    }
    async function edit(name, button) {
      if (!invoke || saving) return;
      var catalog = show(name, button);
      var id = readId;
      try {
        var results = await Promise.all([invoke('provider_get', { name: name }), catalog]);
        var entry = results[0];
        if (id !== readId) return;
        if (entry && entry.managed === true) throw new Error('PROVIDER_MANAGED');
        if (!entry || entry.name !== name || typeof entry.baseUrl !== 'string' || !safeVersionQuery(entry.baseUrl) || !Array.isArray(entry.models)
            || !entry.models.every(function (m) { return typeof m === 'string'; }) || typeof entry.managed !== 'boolean') throw new Error();
        fields.name.value = entry.name;
        fields.baseUrl.value = entry.baseUrl;
        fields.models.value = entry.models.join('\n');
        transformers.prefill(entry);
        loading = false;
        syncControls();
        fields.baseUrl.focus();
      } catch (err) {
        if (id !== readId) return;
        if ((typeof err === 'string' ? err : err && err.message) === 'PROVIDER_MANAGED') {
          managed = true;
          loading = false;
          syncControls();
          error.textContent = managedNote;
          cancel.focus();
          return;
        }
        close(true);
        status.textContent = '暂时无法读取供应商，请刷新后重试。';
      }
    }
    open.disabled = !invoke;
    open.addEventListener('click', function () {
      if (!form.hidden && editName === null) { close(true); return; }
      show(null, open);
      fields.name.focus();
    });
    cancel.addEventListener('click', function () { close(true); });
    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      if (!invoke || saving || loading || managed || form.hidden) return;
      var editing = editName !== null;
      var models = fields.models.value.split(/[\r\n,]/).map(function (m) { return m.trim(); }).filter(Boolean);
      var provider = {
        name: editing ? editName : fields.name.value.trim(), baseUrl: fields.baseUrl.value.trim(),
        models: Array.from(new Set(models)),
      };
      if (!editing || fields.apiKey.value !== '') provider.apiKey = fields.apiKey.value;
      var invalid = providerInputError(provider, editing);
      if (invalid) {
        error.textContent = invalidMessages[invalid];
        fields[invalid].focus();
        return;
      }
      if (!transformers.writeTo(provider, editing, error)) return;
      if (provider.apiKey !== undefined) provider.apiKey = provider.apiKey.trim();
      error.textContent = '';
      saving = true;
      syncControls();
      var name = provider.name;
      var saved;
      try {
        var request = editing ? invoke('provider_update', { name: editName, provider: provider }) : invoke('provider_add', { provider: provider });
        provider = null;
        saved = await request;
        if (!saved || saved.name !== name) throw new Error('PROVIDER_SAVE_UNCONFIRMED');
      } catch (err) {
        saving = false;
        var code = typeof err === 'string' ? err : err && err.message;
        var duplicate = code === 'PROVIDER_DUPLICATE';
        var message = editing ? '更新供应商失败，请检查输入后重试。' : '添加供应商失败，请检查输入后重试。';
        if (duplicate) message = editing ? '供应商名称已存在，请先解决配置中的重复名称。' : '供应商名称已存在，请使用其他名称。';
        if (code === 'PROVIDER_INVALID') message = '供应商信息无效，请检查输入后重试。';
        if (code === 'PROVIDER_SAVE_UNCONFIRMED') message = editing ? '暂时无法确认保存结果，请刷新后再决定是否重试' : '暂时无法确认保存结果，请刷新供应商列表后再决定是否重试。';
        if (editing && code === 'PROVIDER_MANAGED') { managed = !form.hidden; message = managedNote; fields.apiKey.value = ''; }
        syncControls();
        if (form.hidden) status.textContent = message;
        else {
          error.textContent = message;
          if (!editing && (duplicate || code === 'PROVIDER_INVALID')) fields.name.focus();
          else (managed ? cancel : save).focus();
        }
        return;
      }
      saving = false;
      syncControls();
      close(true);
      status.textContent = editing ? '已更新供应商' : '供应商已添加。';
      onSaved(saved.name);
    });
    // A tray window can be hidden and reused without unloading its document.
    window.addEventListener('blur', function () { fields.apiKey.value = ''; });
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') close(false); });
    return {
      close: close,
      edit: edit,
      escape: function () {
        if (form.hidden) return false;
        if (!saving) close(true);
        return true;
      },
    };
  }

  function detectTauri() {
    var t = typeof window !== 'undefined' && window.__TAURI__;
    return t && t.core && typeof t.core.invoke === 'function' ? t : null;
  }

  function boot() {
    var previewWanted = typeof location !== 'undefined' && /(?:^|[?&])preview=1(?:&|$)/.test(location.search);
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
    var credentialsCtrl = mode === 'missing' ? null : createCredentialsController({
      invoke: invoke,
      onSaved: function (name) { if (controller) controller.refreshProvider(name); },
    });
    var routingCtrl = mode === 'missing' ? null : createRoutingController({ invoke: invoke });
    var usageCtrl = mode === 'missing' ? null : createUsageController({ invoke: invoke });
    var recordsCtrl = mode === 'missing' ? null : createRecordsController({ invoke: invoke });
    var clientsCtrl = mode === 'missing' ? null : createClientsController({ invoke: invoke });
    var serviceCtrl = mode === 'missing' ? null : createServiceController({ invoke: invoke });
    var els = {
      list: document.getElementById('list'),
      empty: document.getElementById('empty'),
      banner: document.getElementById('banner'),
      count: document.getElementById('provider-count'),
      updatedAt: document.getElementById('updated-at'),
      refreshAll: document.getElementById('refresh-all'),
      openUi: document.getElementById('open-ui'),
      quit: document.getElementById('quit'),
      tabs: document.getElementById('tabs'),
      serviceChip: document.getElementById('service-chip'),
      serviceText: document.getElementById('service-text'),
      serviceStart: document.getElementById('service-start'),
      serviceStop: document.getElementById('service-stop'),
      serviceRefresh: document.getElementById('service-refresh'),
      routingRevision: document.getElementById('routing-revision'),
      routingRefresh: document.getElementById('routing-refresh'),
      routingSaveGroups: document.getElementById('routing-save-groups'),
      flagFamily: document.getElementById('flag-family'),
      flagFallback: document.getElementById('flag-fallback'),
      routingFlagsMsg: document.getElementById('routing-flags-msg'),
      routingMsg: document.getElementById('routing-msg'),
      routingScopes: document.getElementById('routing-scopes'),
      routeChoices: document.getElementById('route-choices'),
      routingBody: document.getElementById('routing-body'),
      aliasAdd: document.getElementById('alias-add'),
      aliasName: document.getElementById('alias-name'),
      aliasTarget: document.getElementById('alias-target'),
      aliasAddBtn: document.getElementById('alias-add-btn'),
      aliasAddMsg: document.getElementById('alias-add-msg'),
      usageUpdated: document.getElementById('usage-updated'),
      usageRefresh: document.getElementById('usage-refresh'),
      usagePeriods: document.getElementById('usage-periods'),
      usageMsg: document.getElementById('usage-msg'),
      usageBody: document.getElementById('usage-body'),
      clientsRefresh: document.getElementById('clients-refresh'),
      clientsMsg: document.getElementById('clients-msg'),
      clientsList: document.getElementById('clients-list'),
    };
    var projectsCtrl = mode === 'missing' ? null : ProjectsUI.createProjectsController({ invoke: invoke });
    ProjectsUI.mount(document, projectsCtrl);
    var pluginsPanel = PluginsUI.mount(document, invoke);
    var cards = new Map();

    function safeCommand(cmd) {
      if (!invoke) return;
      try {
        var r = invoke(cmd);
        if (r && typeof r.catch === 'function') r.catch(function () {});
      } catch { /* Never log command payloads. */ }
    }

    function setBanner(node, text, tone) {
      node.hidden = !text;
      node.textContent = text || '';
      if (tone) node.setAttribute('data-tone', tone); else node.removeAttribute('data-tone');
    }

    // ---- quota tab (unchanged behavior) ----------------------------------

    function renderBanner(state) {
      var tone = null, text = null;
      if (mode === 'missing') { tone = 'error'; text = '无法访问桌面 IPC（window.__TAURI__ 不可用），额度数据不可用。'; }
      else if (state.fullError) { tone = 'error'; text = '刷新失败，正在显示最后已知数据：' + state.fullError; }
      else if (state.snapshot && !state.snapshot.online) { tone = 'warn'; text = '网关离线 · 显示最后已知数据'; }
      else if (state.snapshot && state.snapshot.error) { tone = 'warn'; text = '部分数据获取失败：' + state.snapshot.error; }
      setBanner(els.banner, text, tone);
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
      refs.refresh.disabled = row.loading || (controller && controller.state().loadingAll) || mode === 'missing';
      refs.refresh.setAttribute('aria-label', '刷新 ' + p.name);
      refs.refresh.title = '刷新 ' + p.name;
      refs.edit.setAttribute('aria-label', '编辑 ' + p.name);
      syncCardCredentials(refs, p.name, credentialsCtrl ? credentialsCtrl.state() : null);
    }

    // Credentials affordances follow the credentials status projection, not
    // the quota snapshot: only Rust-matched Coding Plan providers get them.
    function syncCardCredentials(refs, name, s) {
      var matched = !!s && !!s.status && s.status.providers.some(function (p) { return p.name === name; });
      var configured = matched && s.status.providers.some(function (p) { return p.name === name && p.configured; });
      var saving = !!s && !!s.saving;
      refs.creds.hidden = !matched || mode === 'missing';
      refs.creds.disabled = !matched || saving;
      refs.credsNote.hidden = !matched || configured;
      var open = matched && s.openName === name;
      refs.credsPanel.hidden = !open;
      if (!open) { refs.credsWasOpen = false; return; }
      if (!refs.credsWasOpen) {
        // Opening always starts blank: saved secrets are never echoed.
        refs.credsAk.value = '';
        refs.credsSk.value = '';
        refs.credsWasOpen = true;
      }
      refs.credsAk.placeholder = configured ? '已保存，留空则不修改' : '输入 AccessKey ID';
      refs.credsSk.placeholder = configured ? '已保存，留空则不修改' : '输入 Secret AccessKey';
      refs.credsAk.disabled = saving;
      refs.credsSk.disabled = saving;
      refs.credsSave.disabled = saving;
      refs.credsSave.textContent = saving ? '保存中…' : '保存';
      refs.credsClear.hidden = !configured;
      refs.credsClear.disabled = saving;
      refs.credsCancel.disabled = saving;
      var flash = s.savedFlash && s.savedFlash.name === name ? s.savedFlash : null;
      if (flash && refs.credsFlashStamp !== flash.at) {
        refs.credsFlashStamp = flash.at;
        refs.credsAk.value = '';
        refs.credsSk.value = '';
      }
      var text = '', tone = null;
      if (s.saveError) { text = s.saveError; }
      else if (flash) {
        var clock = formatClock(flash.at);
        text = (flash.cleared ? '已清除' : '已保存') + (clock ? ' ' + clock : '');
        tone = 'ok';
      }
      refs.credsMsg.hidden = !text;
      refs.credsMsg.textContent = text;
      if (tone) refs.credsMsg.setAttribute('data-tone', tone); else refs.credsMsg.removeAttribute('data-tone');
    }

    function renderCredentials(s) {
      cards.forEach(function (refs, name) { syncCardCredentials(refs, name, s); });
    }

    function render(state) {
      els.refreshAll.classList.toggle('is-loading', !!state.loadingAll);
      els.refreshAll.setAttribute('aria-busy', String(!!state.loadingAll));
      els.refreshAll.disabled = !!state.loadingAll || mode === 'missing';
      els.openUi.disabled = mode === 'missing';
      els.quit.disabled = mode === 'missing';
      els.count.textContent = state.count === null ? (mode === 'missing' || state.fullError ? '不可用' : '正在读取…')
        : state.count === 0 && (state.fullError || !state.snapshot.online || state.snapshot.error)
          ? '服务不可用' : '已配置 ' + state.count + ' 个提供方';
      var ts = state.snapshot ? formatTimestamp(state.snapshot.updatedAt) : null;
      els.updatedAt.textContent = ts ? '额度更新于 ' + ts : '—';
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
      // A missing snapshot or an offline gateway is NOT an empty state; keep
      // the loading/offline banner instead of claiming no providers exist.
      els.empty.hidden = state.rows.length !== 0 || !state.snapshot || !state.snapshot.online || !!state.fullError || !!state.snapshot.error;
      els.list.setAttribute('aria-busy', String(!!state.loadingAll));
    }

    // ---- service bar ------------------------------------------------------

    function renderService(sState) {
      pluginsPanel.serviceChanged(sState);
      var view = serviceView(sState.service);
      var busy = !!sState.pending || sState.loading;
      if (sState.error) {
        els.serviceChip.className = 'status tone-warn';
        els.serviceText.textContent = '服务操作失败：' + sState.error;
        els.serviceChip.title = sState.error;
      } else {
        els.serviceChip.className = 'status tone-' + view.tone;
        els.serviceText.textContent = sState.pending === 'start' ? '正在启动服务…'
          : sState.pending === 'stop' ? '正在停止服务…' : view.label;
        els.serviceChip.title = sState.service && sState.service.message ? sState.service.message : view.label;
      }
      els.serviceStart.disabled = mode === 'missing' || !view.canStart || busy;
      els.serviceStart.title = view.startTitle;
      els.serviceStop.disabled = mode === 'missing' || !view.canStop || busy;
      els.serviceStop.title = view.stopTitle;
      els.serviceRefresh.disabled = mode === 'missing' || sState.loading || !!sState.pending;
      els.quit.title = quitTitleFor(sState.service);
      els.quit.querySelector('span').textContent = sState.service && sState.service.mode === 'owned'
        ? '退出并停止托管服务' : '退出桌面';
    }

    // ---- routing tab ------------------------------------------------------

    var activeScope = 'global';
    var routeRefs = new Map();
    var lastRoutingRevision = null;
    var restoreFocus = null;

    function scopeButtons() { return Array.prototype.slice.call(els.routingScopes.querySelectorAll('.scope-btn')); }

    function updateChoices(snapshot) {
      var seen = {}, out = [];
      ((snapshot && snapshot.providers) || []).forEach(function (p) {
        (p.models || []).forEach(function (m) {
          var v = p.name + ',' + m;
          if (!seen[v]) { seen[v] = true; out.push(v); }
        });
      });
      els.routeChoices.textContent = '';
      out.forEach(function (v) {
        var o = document.createElement('option');
        o.value = v;
        els.routeChoices.appendChild(o);
      });
    }

    function routingKeysForScope(scope, s) {
      var keys = [];
      if (scope === 'models') {
        var seen = {};
        s.snapshot.routes.forEach(function (rt) {
          if (rt.scope === 'models' && rt.field && !seen[rt.field]) { seen[rt.field] = true; keys.push(routeKey('models', rt.field)); }
        });
        s.draftKeys.forEach(function (k) {
          var p = splitKey(k);
          if (p.scope === 'models' && p.field && !seen[p.field]) keys.push(k);
        });
      } else {
        ROUTING_SCENARIOS.forEach(function (field) {
          if (scope === 'global' || field !== 'background') keys.push(routeKey(scope, field));
        });
      }
      return keys;
    }

    function captureRoutingFocus() {
      restoreFocus = null;
      var a = document.activeElement;
      if (!a || !els.routingBody.contains(a)) return;
      var root = a.closest ? a.closest('.route') : null;
      if (!root || !root.dataset.key) return;
      var kind = null;
      if (a === root.querySelector('.route-target > .route-input')) kind = 'target';
      else if (a.closest && a.closest('.fallback-add') && a.tagName === 'INPUT') kind = 'add';
      if (!kind) return;
      restoreFocus = { key: root.dataset.key, kind: kind, start: a.selectionStart, end: a.selectionEnd };
    }

    function restoreRoutingFocus() {
      if (!restoreFocus) return;
      var refs = routeRefs.get(restoreFocus.key);
      var input = refs && (restoreFocus.kind === 'target' ? refs.target : refs.addInput);
      if (input) {
        input.focus();
        if (typeof input.setSelectionRange === 'function') {
          var len = input.value.length;
          var s0 = Math.min(restoreFocus.start == null ? len : restoreFocus.start, len);
          var e0 = Math.min(restoreFocus.end == null ? len : restoreFocus.end, len);
          try { input.setSelectionRange(s0, e0); } catch { /* non-text inputs */ }
        }
      }
      restoreFocus = null;
    }

    function renderFallbackChips(refs, key, list) {
      refs.fbList.textContent = '';
      list.forEach(function (name, i) {
        var li = el('li', 'fallback-item');
        li.appendChild(el('span', 'fallback-order', (i + 1) + '.'));
        li.appendChild(el('span', 'fallback-name', name));
        var up = mkBtn('↑', '上移 ' + name, function () { routingCtrl.moveFallback(key, i, -1); });
        up.disabled = i === 0;
        var down = mkBtn('↓', '下移 ' + name, function () { routingCtrl.moveFallback(key, i, 1); });
        down.disabled = i === list.length - 1;
        var rm = mkBtn('✕', '删除回退 ' + name, function () { routingCtrl.removeFallback(key, i); });
        li.appendChild(up); li.appendChild(down); li.appendChild(rm);
        refs.fbList.appendChild(li);
      });
    }

    function syncRouteRow(refs, key) {
      var s = routingCtrl.state();
      var parts = splitKey(key);
      var draft = s.draft(key);
      var snap = s.snapshot;
      var canonicalT = snap ? canonicalTarget(snap, parts.scope, parts.field) : '';
      var canonicalF = snap ? canonicalFallback(snap, parts.scope, parts.field) : [];
      var targetVal = draft ? draft.target : canonicalT;
      // Never rewrite the value of a focused input; that would drop the draft
      // or move the caret mid-typing.
      if (document.activeElement !== refs.target && refs.target.value !== targetVal) refs.target.value = targetVal;
      refs.unset.hidden = targetVal !== '';
      var isDirty = !!draft && !s.isClean(key);
      var saving = s.savingKey === key;
      if (refs.saveBtn) {
        refs.saveBtn.disabled = !isDirty || saving || s.savingGroups || s.flagsSaving || s.loading || mode === 'missing';
        refs.saveBtn.textContent = saving ? '保存中…' : '保存';
        refs.saveBtn.setAttribute('aria-busy', String(saving));
      }
      refs.resetBtn.hidden = !isDirty;
      refs.resetBtn.disabled = s.savingGroups && isModelGroupKey(key);
      refs.root.setAttribute('data-dirty', String(isDirty));
      var list = draft ? draft.fallback : canonicalF;
      var sig = JSON.stringify(list);
      if (refs.lastChips !== sig) { refs.lastChips = sig; renderFallbackChips(refs, key, list); }
      var msgText = '', tone = null;
      if (s.saveError && s.saveError.key === key) msgText = s.saveError.message;
      else if (s.savedFlash && s.savedFlash.key === key) {
        var c = formatClock(s.savedFlash.at);
        msgText = c ? '已保存 ' + c : '已保存';
        tone = 'ok';
      }
      refs.msg.textContent = msgText;
      if (tone) refs.msg.setAttribute('data-tone', tone); else refs.msg.removeAttribute('data-tone');
    }

    function buildRouteRow(key) {
      var parts = splitKey(key);
      var labelText = routeLabel(parts.scope, parts.field);
      var root = el('div', 'route');
      root.dataset.key = key;
      var head = el('div', 'route-head');
      head.appendChild(el('span', 'route-name', labelText));
      var unset = el('span', 'badge badge-off route-unset', '未设置');
      head.appendChild(unset);
      root.appendChild(head);

      var targetWrap = el('div', 'route-target');
      var target = document.createElement('input');
      target.type = 'text';
      target.className = 'route-input';
      target.setAttribute('list', 'route-choices');
      target.placeholder = '提供方,模型（留空清除）';
      target.setAttribute('aria-label', SCOPE_LABELS[parts.scope] + ' · ' + labelText + ' 目标');
      var clearBtn = mkBtn('✕', '清除 ' + labelText + '（保存后生效）', function () { routingCtrl.setTarget(key, ''); });
      clearBtn.className = 'btn btn-icon route-clear';
      targetWrap.appendChild(target);
      targetWrap.appendChild(clearBtn);
      root.appendChild(targetWrap);

      var fb = el('div', 'route-fallback');
      fb.appendChild(el('span', 'route-fallback-label', '回退顺序'));
      var fbList = el('ol', 'fallback-list');
      fb.appendChild(fbList);
      var fbAdd = el('div', 'fallback-add');
      var addInput = document.createElement('input');
      addInput.type = 'text';
      addInput.className = 'route-input';
      addInput.setAttribute('list', 'route-choices');
      addInput.placeholder = '添加回退，如 provider,model';
      addInput.setAttribute('aria-label', labelText + ' 添加回退');
      var addBtn = mkBtn('添加', '添加 ' + labelText + ' 回退', submitAdd);
      fbAdd.appendChild(addInput);
      fbAdd.appendChild(addBtn);
      fb.appendChild(fbAdd);
      root.appendChild(fb);

      var foot = el('div', 'route-foot');
      var msg = el('span', 'route-msg');
      foot.appendChild(msg);
      foot.appendChild(el('span', 'spacer'));
      var resetBtn = mkBtn('撤销', '撤销未保存的修改', function () { routingCtrl.resetDraft(key); });
      foot.appendChild(resetBtn);
      var saveBtn = null;
      if (!isModelGroup(parts.scope)) {
        saveBtn = mkBtn('保存', '保存 ' + labelText, function () { routingCtrl.saveRow(key); });
        saveBtn.className = 'btn btn-primary route-save';
        foot.appendChild(saveBtn);
      }
      root.appendChild(foot);

      function submitAdd() {
        var r = routingCtrl.addFallback(key, addInput.value);
        if (r && r.ok === false) {
          addInput.setAttribute('aria-invalid', 'true');
          addInput.title = r.message;
        } else {
          addInput.value = '';
          addInput.removeAttribute('aria-invalid');
          addInput.title = '';
          addInput.focus();
        }
      }
      // Typing only updates the draft; controller emits refresh status bits,
      // never the input values themselves.
      target.addEventListener('input', function () { routingCtrl.setTarget(key, target.value); });
      addInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); submitAdd(); } });
      addInput.addEventListener('input', function () { addInput.removeAttribute('aria-invalid'); addInput.title = ''; });

      var refs = { root: root, target: target, unset: unset, fbList: fbList, addInput: addInput, resetBtn: resetBtn, saveBtn: saveBtn, msg: msg, lastChips: null };
      syncRouteRow(refs, key);
      return refs;
    }

    function rebuildRouting() {
      captureRoutingFocus();
      els.routingBody.textContent = '';
      routeRefs.clear();
      if (!routingCtrl) {
        els.routingBody.appendChild(noteEl('桌面 IPC 不可用，无法读取路由配置。'));
        restoreRoutingFocus();
        return;
      }
      var s = routingCtrl.state();
      if (!s.snapshot) {
        // Before the first snapshot there is no real empty state to show.
        els.routingBody.appendChild(noteEl(s.loading ? '正在读取路由配置…' : '路由配置读取失败：' + (s.error || '未知错误')));
        restoreRoutingFocus();
        return;
      }
      updateChoices(s.snapshot);
      routingKeysForScope(activeScope, s).forEach(function (key) {
        var refs = buildRouteRow(key);
        routeRefs.set(key, refs);
        els.routingBody.appendChild(refs.root);
      });
      lastRoutingRevision = s.snapshot.revision;
      restoreRoutingFocus();
    }

    function renderRouting(s) {
      var busy = mode === 'missing' || s.loading || !!s.savingKey || s.savingGroups || s.flagsSaving;
      els.routingRefresh.disabled = busy;
      var snap = s.snapshot;
      var groupCount = (s.dirtyGroupKeys || []).length;
      els.routingSaveGroups.hidden = !isModelGroup(activeScope) && !groupCount && !s.savingGroups;
      els.routingSaveGroups.disabled = busy || !snap || !groupCount;
      els.routingSaveGroups.setAttribute('aria-busy', String(!!s.savingGroups));
      els.routingSaveGroups.textContent = s.savingGroups ? '保存模型组…' : '保存模型组' + (groupCount ? '（' + groupCount + ' 项）' : '');
      els.aliasAddBtn.disabled = !!s.savingGroups;
      els.routingRevision.textContent = snap ? '修订 ' + (snap.revision || '—') : '';
      if (snap && !s.flagsSaving) {
        els.flagFamily.checked = snap.familyRouting;
        els.flagFallback.checked = snap.fallbackEnabled;
      }
      var flagsBlocked = busy || !snap;
      els.flagFamily.disabled = flagsBlocked;
      els.flagFallback.disabled = flagsBlocked;
      els.routingFlagsMsg.textContent = s.flagsError || '';
      var banner = null, tone = null;
      if (s.error) { banner = '路由配置读取失败：' + s.error; tone = 'error'; }
      else if (s.saveError) { banner = s.saveError.message + '（未保存的修改已保留）'; tone = 'error'; }
      else if (s.groupSaveMessage) { banner = s.groupSaveMessage; tone = 'ok'; }
      setBanner(els.routingMsg, banner, tone);
      els.aliasAdd.hidden = activeScope !== 'models' || mode === 'missing';
      if (!snap) { rebuildRouting(); els.routingBody.setAttribute('aria-busy', String(s.loading)); return; }
      var expected = routingKeysForScope(activeScope, s);
      var current = Array.from(routeRefs.keys());
      var same = expected.length === current.length && expected.every(function (k) { return current.indexOf(k) !== -1; });
      if (!same) rebuildRouting();
      else {
        if (snap.revision !== lastRoutingRevision) { updateChoices(snap); lastRoutingRevision = snap.revision; }
        routeRefs.forEach(function (refs, k) { syncRouteRow(refs, k); });
      }
      els.routingBody.setAttribute('aria-busy', String(s.loading));
    }

    // ---- usage tab --------------------------------------------------------

    function usageNumCell(metric, label, value, fullValue) {
      var cell = el('div', 'usage-cell');
      cell.dataset.metric = metric;
      var num = el('span', 'usage-num', value === null ? '—' : String(value));
      if (fullValue != null) num.title = fullValue;
      cell.appendChild(num);
      cell.appendChild(el('span', 'usage-label', label));
      return cell;
    }

    function usageTable(titleText, headers, rows, numFrom) {
      var card = el('div', 'usage-card');
      card.appendChild(el('div', 'usage-title', titleText));
      if (!rows.length) {
        card.appendChild(noteEl('该周期暂无调用记录'));
        return card;
      }
      var table = el('table', 'usage-table');
      var thead = el('thead');
      var hr = el('tr');
      headers.forEach(function (h, i) {
        var th = el('th', i >= numFrom ? 'num' : null, h);
        th.setAttribute('scope', 'col');
        hr.appendChild(th);
      });
      thead.appendChild(hr);
      table.appendChild(thead);
      var tbody = el('tbody');
      rows.forEach(function (cells) {
        var tr = el('tr');
        cells.forEach(function (c, i) {
          var td = el('td', i >= numFrom ? 'num' : null, c.text);
          if (c.title != null) td.title = c.title;
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      card.appendChild(table);
      return card;
    }

    function renderUsage(s) {
      els.usageRefresh.disabled = mode === 'missing' || s.loading;
      Array.prototype.slice.call(els.usagePeriods.querySelectorAll('.period-btn')).forEach(function (b) {
        b.setAttribute('aria-pressed', String(b.dataset.period === s.period));
      });
      var ts = s.snapshot ? formatTimestamp(s.snapshot.updatedAt) : null;
      els.usageUpdated.textContent = ts ? '更新于 ' + ts : (s.loading ? '正在读取…' : '');
      setBanner(els.usageMsg, s.error ? '用量读取失败：' + s.error : null, s.error ? 'error' : null);
      var body = els.usageBody;
      body.textContent = '';
      body.setAttribute('aria-busy', String(s.loading));
      if (!s.snapshot) {
        // No snapshot yet: never fabricate an empty state.
        body.appendChild(noteEl(s.loading ? '正在读取用量…' : (s.error ? '用量读取失败：' + s.error : '尚未读取用量数据')));
        if (s.trend) body.appendChild(buildUsageTrend(s.trend));
        renderRecords(recordsCtrl ? recordsCtrl.state() : null);
        return;
      }
      var u = s.snapshot;
      var totals = el('div', 'usage-card');
      totals.appendChild(el('div', 'usage-title', '汇总 · ' + USAGE_PERIOD_LABELS[u.period]));
      var grid = el('div', 'usage-grid');
      grid.appendChild(usageNumCell('requests', '请求', formatInt(u.totalRequests)));
      grid.appendChild(usageNumCell('success', '成功', formatInt(u.successCount)));
      grid.appendChild(usageNumCell('errors', '失败', formatInt(u.errorCount)));
      grid.appendChild(usageNumCell('rate', '成功率', formatSuccessRate(u.successCount, u.totalRequests)));
      var totalTokens = rowTotalTokens(u);
      var totalCell = usageNumCell('total', '总 tokens', formatCompact(totalTokens), formatInt(totalTokens));
      totalCell.title = '有效输入 + 输出；上游 inputTokens 已含缓存时直接采用，否则加计缓存读/写';
      grid.appendChild(totalCell);
      grid.appendChild(usageNumCell('input', '输入 tokens', formatCompact(u.inputTokens), formatInt(u.inputTokens)));
      grid.appendChild(usageNumCell('output', '输出 tokens', formatCompact(u.outputTokens), formatInt(u.outputTokens)));
      grid.appendChild(usageNumCell('cache-read', '缓存读', formatCompact(u.cacheReadTokens), formatInt(u.cacheReadTokens)));
      grid.appendChild(usageNumCell('cache-write', '缓存写', formatCompact(u.cacheWriteTokens), formatInt(u.cacheWriteTokens)));
      var effectiveInput = effectiveInputTokens(u.inputTokens, u.cacheReadTokens, u.cacheWriteTokens);
      var hitRate = effectiveInput > 0 && u.cacheReadTokens !== null
        ? ((u.cacheReadTokens / effectiveInput) * 100).toFixed(1) + '%'
        : null;
      var cacheHitCell = usageNumCell('cache-hit', '缓存命中率', hitRate);
      cacheHitCell.title = '缓存读取 tokens ÷ 有效输入 tokens';
      grid.appendChild(cacheHitCell);
      grid.appendChild(usageNumCell('ttft', '平均 TTFT', formatMs(u.avgTtftMs)));
      grid.appendChild(usageNumCell('speed', '生成速度', formatSpeed(u.avgTokensPerSecond)));
      totals.appendChild(grid);
      body.appendChild(totals);
      totals.appendChild(noteEl('总 tokens = 有效输入 + 输出；缓存按上游口径折算，不重复计数。'));
      if (s.trend) {
        body.appendChild(buildUsageTrend(s.trend));
      } else {
        body.appendChild(buildDayChart(u.byDay, u.period === 'all'));
      }
      body.appendChild(buildModelChart(topModelsByTotal(u.byModel, 10)));
      function tokenRow(m) {
        var rowTotal = rowTotalTokens(m);
        return [{ text: m.name }, { text: formatInt(m.requests) || '—' },
          { text: formatCompact(m.inputTokens) || '—', title: formatInt(m.inputTokens) },
          { text: formatCompact(m.outputTokens) || '—', title: formatInt(m.outputTokens) },
          { text: (formatCompact(m.cacheReadTokens) || '—') + ' / ' + (formatCompact(m.cacheWriteTokens) || '—'),
            title: '缓存读 ' + (formatInt(m.cacheReadTokens) || '—') + ' / 缓存写 ' + (formatInt(m.cacheWriteTokens) || '—') },
          { text: formatCompact(rowTotal) || '—', title: formatInt(rowTotal) }];
      }
      var tokenHeaders = ['请求', '输入', '输出', '缓存（读 / 写）', '总 tokens'];
      body.appendChild(usageTable('按模型', ['模型'].concat(tokenHeaders), u.byModel.map(tokenRow), 1));
      body.appendChild(usageTable('按提供方', ['提供方'].concat(tokenHeaders), u.byProvider.map(tokenRow), 1));
      body.appendChild(usageTable('按日期', ['日期'].concat(tokenHeaders), u.byDay.map(tokenRow), 1));
      renderRecords(recordsCtrl ? recordsCtrl.state() : null);
    }

    function buildUsageTrend(trend) {
      var title = '每日用量 · 近 ' + trend.dayCount + ' 天（有效输入 + 输出）';
      var card = trend.rows ? buildDayChart(trend.rows) : el('div', 'usage-card');
      if (trend.rows) card.querySelector('.usage-title').textContent = title;
      else {
        card.appendChild(el('div', 'usage-title', title));
        card.appendChild(noteEl(trend.error ? '趋势读取失败：' + trend.error : '正在读取趋势…'));
      }
      return card;
    }

    // Charts are plain divs; per-bar sizes go through CSSOM writes because the
    // CSP (style-src 'self') blocks inline style attributes.
    function buildDayChart(rows, compact) {
      var card = el('div', 'usage-card');
      card.appendChild(el('div', 'usage-title', '每日用量（有效输入 + 输出）'));
      var days = (Array.isArray(rows) ? rows : []).slice().sort(function (a, b) {
        return String(a.name) < String(b.name) ? -1 : String(a.name) > String(b.name) ? 1 : 0;
      });
      if (!days.length) {
        card.appendChild(noteEl('该周期暂无调用记录'));
        return card;
      }
      if (days.length === 1) {
        var day = days[0];
        var single = el('div', 'usage-day-summary');
        single.appendChild(el('div', 'usage-day-date', String(day.name)));
        var singleTotal = rowTotalTokens(day);
        var totalValue = el('div', 'usage-day-total', (formatCompact(singleTotal) || '—') + ' tokens');
        if (singleTotal !== null) totalValue.title = formatInt(singleTotal) + ' tokens';
        single.appendChild(totalValue);
        single.appendChild(el('div', 'usage-day-caption', '当日总量 · 有效输入 + 输出'));
        card.appendChild(single);
        return card;
      }
      var totals = days.map(function (d) { return rowTotalTokens(d); });
      var max = Math.max.apply(null, totals.map(function (v) { return v === null ? 0 : v; }));
      var scroll = el('div', compact ? 'usage-days-compact' : 'usage-days-scroll');
      if (!compact) scroll.tabIndex = 0;
      scroll.setAttribute('role', 'region');
      scroll.setAttribute('aria-label', compact ? '每日用量，全部历史' : '每日用量，日期较多时可横向滚动');
      var bars = el('div', 'usage-bars');
      days.forEach(function (d, i) {
        var v = totals[i];
        var pct = v > 0 && max > 0 ? Math.max(1, Math.round((v / max) * 100)) : 0;
        var col = el('div', 'usage-bar-col');
        if (!compact) {
          var value = el('div', 'usage-day-value', formatCompact(v) || '—');
          if (v !== null) value.title = formatInt(v) + ' tokens';
          col.appendChild(value);
        }
        var track = el('div', 'usage-day-track');
        var bar = el('div', 'usage-bar');
        bar.style.height = pct + '%';
        bar.title = d.name + ' · 输入 ' + (formatCompact(d.inputTokens) || '—') + '（' + (formatInt(d.inputTokens) || '—') + '）'
          + ' · 输出 ' + (formatCompact(d.outputTokens) || '—') + '（' + (formatInt(d.outputTokens) || '—') + '）'
          + ' · 总量 ' + (formatCompact(v) || '—') + '（' + (formatInt(v) || '—') + '）';
        track.appendChild(bar);
        col.appendChild(track);
        if (compact) col.title = bar.title;
        else col.appendChild(el('div', 'usage-day-date', String(d.name)));
        bars.appendChild(col);
      });
      scroll.appendChild(bars);
      if (compact) {
        var axis = el('div', 'usage-day-range');
        axis.appendChild(el('span', 'usage-day-date', days[0].name));
        axis.appendChild(el('span', 'usage-day-date', days[days.length - 1].name));
        scroll.appendChild(axis);
      }
      card.appendChild(scroll);
      return card;
    }

    function buildModelChart(models) {
      var card = el('div', 'usage-card');
      card.appendChild(el('div', 'usage-title', '模型 Top 10（按有效总量）'));
      if (!Array.isArray(models) || !models.length) {
        card.appendChild(noteEl('该周期暂无调用记录'));
        return card;
      }
      var max = 0;
      models.forEach(function (m) {
        var t = rowTotalTokens(m) || 0;
        if (t > max) max = t;
      });
      var list = el('div', 'usage-hbar');
      models.forEach(function (m) {
        var total = rowTotalTokens(m) || 0;
        // Visible bars floor at 1% so a tiny-but-nonzero total still renders.
        var pct = total > 0 && max > 0 ? Math.max(1, Math.round((total / max) * 1000) / 10) : 0;
        var row = el('div', 'usage-hbar-row');
        var name = el('span', 'usage-hbar-name', m.name);
        name.title = m.name + ' · 请求 ' + (formatInt(m.requests) || '—')
          + ' · 输入 ' + (formatInt(m.inputTokens) || '—') + ' · 输出 ' + (formatInt(m.outputTokens) || '—')
          + ' · 缓存读 ' + (formatInt(m.cacheReadTokens) || '—') + ' / 缓存写 ' + (formatInt(m.cacheWriteTokens) || '—');
        var track = el('div', 'usage-hbar-track');
        var fill = el('div', 'usage-hbar-fill');
        fill.style.width = pct + '%';
        track.appendChild(fill);
        var totalSpan = el('span', 'usage-hbar-total', formatCompact(total) || '—');
        if (formatInt(total) != null) totalSpan.title = formatInt(total);
        row.appendChild(name);
        row.appendChild(track);
        row.appendChild(totalSpan);
        list.appendChild(row);
      });
      card.appendChild(list);
      return card;
    }

    function recordClock(ts) {
      var s = toStr(ts);
      if (!s) return null;
      var t = new Date(s);
      return Number.isNaN(t.getTime()) ? s : formatClock(t.getTime());
    }
    var RECORD_HEADERS = ['时间', '提供方', '模型', '客户端', '输入', '输出', '缓存读', '缓存写', '耗时', 'TTFT', '速度', '状态'];
    function recordsTokenCell(value, estimated) {
      return {
        text: (estimated ? '≈' : '') + (formatCompact(value) || '—'),
        title: formatInt(value) == null ? null : formatInt(value),
      };
    }
    function recordsNumCell(cell) {
      var td = el('td', 'num', cell.text);
      if (cell.title != null) td.title = cell.title;
      return td;
    }
    function buildRecordsTable(records) {
      var table = el('table', 'records-table');
      var thead = el('thead');
      var hr = el('tr');
      RECORD_HEADERS.forEach(function (h, i) {
        var th = el('th', i >= 4 && i <= 10 ? 'num' : null, h);
        th.setAttribute('scope', 'col');
        hr.appendChild(th);
      });
      thead.appendChild(hr);
      table.appendChild(thead);
      var tbody = el('tbody');
      records.forEach(function (r) {
        var tr = el('tr');
        var time = recordClock(r.timestamp);
        var timeTd = el('td', null, time || '—');
        if (r.timestamp) timeTd.title = r.timestamp;
        tr.appendChild(timeTd);
        tr.appendChild(el('td', null, r.provider));
        var chain = modelChain(r);
        var modelTd = el('td', 'cell-truncate', chain);
        modelTd.title = chain;
        tr.appendChild(modelTd);
        tr.appendChild(el('td', null, clientLabel(r.clientType)));
        tr.appendChild(recordsNumCell(recordsTokenCell(r.inputTokens, r.usageEstimated)));
        tr.appendChild(recordsNumCell(recordsTokenCell(r.outputTokens, r.usageEstimated)));
        tr.appendChild(recordsNumCell(recordsTokenCell(r.cacheReadTokens, false)));
        tr.appendChild(recordsNumCell(recordsTokenCell(r.cacheWriteTokens, false)));
        tr.appendChild(recordsNumCell({ text: formatMs(r.durationMs) || '—' }));
        tr.appendChild(recordsNumCell({ text: formatMs(r.ttftMs) || '—' }));
        tr.appendChild(recordsNumCell({ text: formatSpeed(r.tokensPerSecond) || '—' }));
        var failed = r.status === 'error';
        var statusTd = el('td', null);
        var dot = el('span', 'record-dot');
        dot.setAttribute('data-tone', failed ? 'error' : 'ok');
        statusTd.appendChild(dot);
        // The message stays a tooltip; responseBody is never projected across IPC.
        statusTd.title = failed ? (r.errorMessage || '调用失败') : '成功';
        tr.appendChild(statusTd);
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      return table;
    }

    function buildRecordsCard() {
      var root = el('div', 'usage-card records-card');
      root.appendChild(el('div', 'usage-title', '调用记录'));
      var pager = el('div', 'records-pager');
      var prev = mkBtn('‹ 上一页', '上一页', function () { if (recordsCtrl) recordsCtrl.prev(); });
      var info = el('span', 'records-info');
      var next = mkBtn('下一页 ›', '下一页', function () { if (recordsCtrl) recordsCtrl.next(); });
      pager.appendChild(prev);
      pager.appendChild(info);
      pager.appendChild(next);
      root.appendChild(pager);
      var scroll = el('div', 'records-scroll');
      root.appendChild(scroll);
      return { root: root, prev: prev, info: info, next: next, scroll: scroll };
    }

    function syncRecordsCard(refs, rs) {
      var missing = !recordsCtrl;
      var loading = !!rs && rs.loading === true;
      refs.prev.disabled = missing || loading || !rs || !rs.canPrev;
      refs.next.disabled = missing || loading || !rs || !rs.canNext;
      if (rs && rs.totalPages !== null) {
        refs.info.textContent = '第 ' + rs.page + ' / ' + rs.totalPages + ' 页 · 共 ' + (formatInt(rs.total) || '—') + ' 条';
      } else if (loading) {
        refs.info.textContent = '正在读取调用记录…';
      } else {
        refs.info.textContent = '—';
      }
      refs.scroll.textContent = '';
      if (missing) {
        refs.scroll.appendChild(noteEl('桌面 IPC 不可用，无法读取调用记录。'));
        return;
      }
      if (rs && rs.error) {
        var err = noteEl('调用记录读取失败：' + rs.error);
        err.setAttribute('data-tone', 'error');
        refs.scroll.appendChild(err);
        return;
      }
      if (!rs || !rs.data) {
        refs.scroll.appendChild(noteEl(loading ? '正在读取调用记录…' : '尚未读取调用记录'));
        return;
      }
      if (!rs.data.records.length) {
        refs.scroll.appendChild(noteEl('该周期暂无调用记录'));
        return;
      }
      refs.scroll.appendChild(buildRecordsTable(rs.data.records));
    }

    var recordsRefs = null;
    function renderRecords(rs) {
      // renderUsage rebuilds usage-body on every emit, so the records card is
      // re-appended after it; records-only updates sync the existing card.
      if (!recordsRefs || !recordsRefs.root.parentNode) {
        recordsRefs = buildRecordsCard();
        els.usageBody.appendChild(recordsRefs.root);
      }
      syncRecordsCard(recordsRefs, rs);
    }

    // ---- clients tab ------------------------------------------------------

    var clientRefs = new Map();

    function clientNote(text) {
      var li = el('li', 'note');
      li.textContent = text;
      return li;
    }

    function rebuildClientActions(refs, c, s) {
      refs.actions.textContent = '';
      refs.confirm.textContent = '';
      if (s.confirmId === c.id) {
        refs.actions.hidden = true;
        refs.confirm.hidden = false;
        refs.confirm.appendChild(el('span', 'client-confirm-text', '恢复会改写「' + c.name + '」的配置并断开 CCR 接管，确认恢复？'));
        var row = el('div', 'client-confirm-actions');
        var yes = document.createElement('button');
        yes.type = 'button'; yes.className = 'btn btn-danger'; yes.textContent = '确认恢复';
        yes.addEventListener('click', function () { clientsCtrl.confirmRestore(c.id); });
        var no = document.createElement('button');
        no.type = 'button'; no.className = 'btn'; no.textContent = '取消';
        no.addEventListener('click', function () { clientsCtrl.cancelRestore(); });
        row.appendChild(yes); row.appendChild(no);
        refs.confirm.appendChild(row);
        return;
      }
      refs.actions.hidden = false;
      refs.confirm.hidden = true;
      var blocked = !!s.pending || s.loading || s.confirmId !== null || mode === 'missing';
      var missing = !c.exists;
      var missingTitle = missing ? '未找到该客户端的配置文件' : null;
      var main = document.createElement('button');
      main.type = 'button';
      main.className = 'btn';
      main.textContent = c.enabled ? '断开' : '接入';
      main.disabled = blocked || missing;
      main.title = missingTitle || (c.enabled ? '断开该客户端与 CCR 的接入' : '将「' + c.name + '」接入 CCR');
      main.setAttribute('aria-label', c.name + ' ' + main.textContent);
      main.addEventListener('click', function () {
        if (c.enabled) clientsCtrl.disconnect(c.id); else clientsCtrl.connect(c.id);
      });
      refs.actions.appendChild(main);
      if (c.managed) {
        var r = document.createElement('button');
        r.type = 'button';
        r.className = 'btn btn-danger-quiet';
        r.textContent = '恢复原配置';
        r.disabled = blocked || missing;
        r.title = missingTitle || '恢复客户端接入 CCR 前的原始配置（需确认）';
        r.setAttribute('aria-label', c.name + ' 恢复原配置');
        r.addEventListener('click', function () { clientsCtrl.requestRestore(c.id); });
        refs.actions.appendChild(r);
      }
    }

    function syncClientRow(refs, c, s) {
      refs.name.textContent = c.name;
      refs.idSpan.textContent = c.id;
      var badgeSig = [c.enabled, c.managed, c.exists].join('|');
      if (refs.badgeSig !== badgeSig) {
        refs.badgeSig = badgeSig;
        refs.badges.textContent = '';
        refs.badges.appendChild(el('span', 'badge ' + (c.enabled ? 'badge-plan' : 'badge-off'), c.enabled ? '已接入' : '未接入'));
        if (c.managed) refs.badges.appendChild(el('span', 'badge', '接管'));
        if (!c.exists) refs.badges.appendChild(el('span', 'badge badge-stale', '配置缺失'));
      }
      var metaParts = [];
      if (c.activeModel) metaParts.push('当前模型 ' + c.activeModel);
      if (c.modelAlias) metaParts.push('别名 ' + c.modelAlias);
      if (!c.exists) metaParts.push('未找到配置文件');
      refs.meta.textContent = metaParts.join(' · ');
      refs.meta.hidden = metaParts.length === 0;
      var actionSig = [c.enabled, c.managed, c.exists, s.confirmId, !!s.pending, s.loading].join('|');
      if (refs.actionSig !== actionSig) {
        refs.actionSig = actionSig;
        rebuildClientActions(refs, c, s);
      }
      refs.error.textContent = s.rowError && s.rowError.id === c.id ? s.rowError.message : '';
      refs.root.setAttribute('aria-busy', String(!!s.pending && s.pending.id === c.id));
      refs.root.dataset.disabled = String(!c.enabled);
    }

    function buildClientRow() {
      var li = el('li', 'client');
      var head = el('div', 'client-head');
      var nameWrap = el('div');
      nameWrap.className = 'client-title';
      var name = el('span', 'client-name');
      var idSpan = el('span', 'client-id');
      nameWrap.appendChild(name);
      nameWrap.appendChild(idSpan);
      var badges = el('span', 'card-badges');
      head.appendChild(nameWrap);
      head.appendChild(badges);
      li.appendChild(head);
      var meta = el('p', 'client-meta'); meta.hidden = true;
      li.appendChild(meta);
      var actions = el('div', 'client-actions');
      li.appendChild(actions);
      var confirm = el('div', 'client-confirm'); confirm.hidden = true;
      li.appendChild(confirm);
      var error = el('p', 'client-error');
      li.appendChild(error);
      els.clientsList.appendChild(li);
      return { root: li, name: name, idSpan: idSpan, badges: badges, meta: meta, actions: actions, confirm: confirm, error: error, badgeSig: null, actionSig: null };
    }

    function renderClients(s) {
      els.clientsRefresh.disabled = mode === 'missing' || s.loading || !!s.pending;
      var banner = null, tone = null;
      if (s.error) { banner = '客户端状态读取失败：' + s.error; tone = 'error'; }
      else if (s.snapshot && s.snapshot.success === false && s.snapshot.message) { banner = s.snapshot.message; tone = 'error'; }
      setBanner(els.clientsMsg, banner, tone);
      els.clientsList.setAttribute('aria-busy', String(s.loading));
      var note = null;
      if (!s.snapshot) note = s.loading ? '正在读取客户端…' : (s.error ? '' : '尚未读取客户端状态');
      else if (!s.snapshot.clients.length) note = '未发现可接入的客户端';
      var noteLi = els.clientsList.querySelector('.note');
      if (note) {
        if (!noteLi) { noteLi = clientNote(''); els.clientsList.insertBefore(noteLi, els.clientsList.firstChild); }
        noteLi.textContent = note;
        if (s.error && !s.snapshot) { noteLi.textContent = '客户端状态读取失败：' + s.error; noteLi.setAttribute('data-tone', 'error'); }
        else noteLi.removeAttribute('data-tone');
      } else if (noteLi) noteLi.remove();
      if (!s.snapshot) {
        clientRefs.forEach(function (refs) { refs.root.remove(); });
        clientRefs.clear();
        return;
      }
      var seen = new Set();
      s.snapshot.clients.forEach(function (c) {
        if (!c.id) return;
        seen.add(c.id);
        var refs = clientRefs.get(c.id);
        if (!refs) { refs = buildClientRow(); clientRefs.set(c.id, refs); }
        syncClientRow(refs, c, s);
      });
      clientRefs.forEach(function (refs, id) {
        if (!seen.has(id)) { refs.root.remove(); clientRefs.delete(id); }
      });
    }

    // ---- tabs -------------------------------------------------------------

    var TAB_IDS = ['quota', 'routing', 'usage', 'clients', 'projects', 'plugins'];
    var tabButtons = {};
    var panels = {};
    TAB_IDS.forEach(function (id) {
      tabButtons[id] = document.getElementById('tab-' + id);
      panels[id] = document.getElementById('panel-' + id);
    });
    var activeTab = 'quota';
    var loadedTabs = { quota: true };
    var providerForm = mountProviderForm(invoke, function (name) {
      controller.refreshProvider(name, true);
      credentialsCtrl.refresh(true);
      if (!loadedTabs.routing) return;
      // A snapshot taken before the addition can still be in flight. Wait for
      // the current routing read/write to finish so its result cannot win.
      function busy(s) { return s.loading || s.savingKey || s.flagsSaving; }
      if (!busy(routingCtrl.state())) { routingCtrl.refresh(); return; }
      var unsubscribe = routingCtrl.subscribe(function (s) {
        if (busy(s)) return;
        unsubscribe();
        routingCtrl.refresh();
      });
    });

    // While the usage tab stays open, periodically refresh snapshot + records
    // so long sessions see fresh totals. Entering the tab always loads once;
    // leaving clears the timer. Tests/preview can shorten the interval via
    // window.__CCR_USAGE_REFRESH_MS__.
    var usageTimer = null;
    function stopUsageAutoRefresh() {
      if (usageTimer) { clearInterval(usageTimer); usageTimer = null; }
    }
    function startUsageAutoRefresh() {
      stopUsageAutoRefresh();
      if (!usageCtrl || !recordsCtrl) return;
      var ms = 30000;
      if (typeof window !== 'undefined' && window.__CCR_USAGE_REFRESH_MS__ > 0) ms = Number(window.__CCR_USAGE_REFRESH_MS__);
      usageTimer = setInterval(function () { usageCtrl.refresh(); recordsCtrl.refresh(); }, ms);
      // Tests/embedded runs must not be kept alive by the polling timer.
      if (usageTimer && typeof usageTimer.unref === 'function') usageTimer.unref();
    }

    function maybeLoadTab(name) {
      if (mode === 'missing') return;
      if (name === 'projects') { projectsCtrl.refresh(); return; }
      if (loadedTabs[name]) return;
      loadedTabs[name] = true;
      if (name === 'routing') routingCtrl.refresh();
      if (name === 'usage') { usageCtrl.refresh(); recordsCtrl.refresh(); startUsageAutoRefresh(); }
      if (name === 'clients') clientsCtrl.refresh();
      if (name === 'plugins') pluginsPanel.load();
    }

    function selectTab(name) {
      if (TAB_IDS.indexOf(name) === -1) return;
      if (name !== 'quota') providerForm.close(false);
      if (name !== 'plugins') pluginsPanel.cancel(false);
      activeTab = name;
      // Polling lifecycle lives here (maybeLoadTab early-returns once a tab
      // has loaded, so a re-entry must still resume the timer).
      if (name === 'usage') startUsageAutoRefresh();
      else stopUsageAutoRefresh();
      TAB_IDS.forEach(function (id) {
        var on = id === name;
        tabButtons[id].setAttribute('aria-selected', String(on));
        tabButtons[id].tabIndex = on ? 0 : -1;
        panels[id].hidden = !on;
      });
      maybeLoadTab(name);
    }

    els.tabs.addEventListener('keydown', function (event) {
      var idx = TAB_IDS.indexOf(activeTab);
      var next = null;
      if (event.key === 'ArrowRight') next = TAB_IDS[(idx + 1) % TAB_IDS.length];
      else if (event.key === 'ArrowLeft') next = TAB_IDS[(idx + TAB_IDS.length - 1) % TAB_IDS.length];
      else if (event.key === 'Home') next = TAB_IDS[0];
      else if (event.key === 'End') next = TAB_IDS[TAB_IDS.length - 1];
      if (!next) return;
      event.preventDefault();
      selectTab(next);
      tabButtons[next].focus();
    });
    TAB_IDS.forEach(function (id) {
      tabButtons[id].addEventListener('click', function () { selectTab(id); });
    });

    // ---- wiring -----------------------------------------------------------

    scopeButtons().forEach(function (b) {
      b.addEventListener('click', function () {
        var scope = b.dataset.scope;
        if (ROUTING_SCOPES.indexOf(scope) === -1) return;
        activeScope = scope;
        scopeButtons().forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
        renderRouting(routingCtrl ? routingCtrl.state() : { snapshot: null, loading: false, error: null, flagsSaving: false, flagsError: null, savingKey: null, saveError: null, savedFlash: null, draftKeys: [], draft: function () { return null; }, isClean: function () { return true; } });
      });
    });
    els.flagFamily.addEventListener('change', function () {
      if (routingCtrl) routingCtrl.setFlag('familyRouting', els.flagFamily.checked);
    });
    els.flagFallback.addEventListener('change', function () {
      if (routingCtrl) routingCtrl.setFlag('fallbackEnabled', els.flagFallback.checked);
    });
    els.routingRefresh.addEventListener('click', function () { if (routingCtrl) routingCtrl.refresh(); });
    els.routingSaveGroups.addEventListener('click', function () { if (routingCtrl) routingCtrl.saveGroups(); });
    els.aliasAddBtn.addEventListener('click', function () {
      if (!routingCtrl) return;
      var r = routingCtrl.createAlias(els.aliasName.value, els.aliasTarget.value);
      if (r && r.ok === false) els.aliasAddMsg.textContent = r.message;
      else {
        els.aliasAddMsg.textContent = '';
        els.aliasName.value = '';
        els.aliasTarget.value = '';
        els.aliasName.focus();
      }
    });
    [els.aliasName, els.aliasTarget].forEach(function (input) {
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); els.aliasAddBtn.click(); }
      });
    });
    Array.prototype.slice.call(els.usagePeriods.querySelectorAll('.period-btn')).forEach(function (b) {
      b.addEventListener('click', function () {
        if (usageCtrl) usageCtrl.setPeriod(b.dataset.period);
        if (recordsCtrl) recordsCtrl.setPeriod(b.dataset.period); // resets to page 1
      });
    });
    els.usageRefresh.addEventListener('click', function () {
      if (usageCtrl) usageCtrl.refresh();
      if (recordsCtrl) recordsCtrl.refresh();
    });
    els.clientsRefresh.addEventListener('click', function () { if (clientsCtrl) clientsCtrl.refresh(); });
    els.serviceStart.addEventListener('click', function () { if (serviceCtrl) serviceCtrl.action('start'); });
    els.serviceStop.addEventListener('click', function () { if (serviceCtrl) serviceCtrl.action('stop'); });
    els.serviceRefresh.addEventListener('click', function () { if (serviceCtrl) serviceCtrl.refresh(); });

    if (controller) {
      controller.subscribe(render);
      render(controller.state());
      els.refreshAll.addEventListener('click', function () {
        controller.refreshAll();
        if (activeTab === 'projects' && projectsCtrl) projectsCtrl.refresh();
      });
      els.list.addEventListener('click', function (event) {
        var target = event.target && event.target.closest ? event.target : null;
        if (!target) return;
        var btn = target.closest('[data-refresh]');
        if (btn) {
          var card = btn.closest('.card');
          if (card && card.dataset.provider) controller.refreshProvider(card.dataset.provider);
          return;
        }
        var providerCard = target.closest('.card');
        if (!providerCard || !providerCard.dataset.provider) return;
        var name = providerCard.dataset.provider;
        var edit = target.closest('.card-edit');
        if (edit) { providerForm.edit(name, edit); return; }
        if (!credentialsCtrl) return;
        if (target.closest('[data-creds-open]')) credentialsCtrl.open(name);
        else if (target.closest('[data-creds-cancel]')) credentialsCtrl.close();
        else if (target.closest('[data-creds-save]')) {
          var refs = cards.get(name);
          if (refs) credentialsCtrl.save(name, { accessKey: refs.credsAk.value, secretKey: refs.credsSk.value });
        } else if (target.closest('[data-creds-clear]')) credentialsCtrl.clear(name);
      });
      controller.refreshAll();
    } else {
      render({ snapshot: null, rows: [], count: null, loadingAll: false, fullError: null });
    }
    if (credentialsCtrl) {
      credentialsCtrl.subscribe(renderCredentials);
      credentialsCtrl.refresh();
    }
    if (serviceCtrl) {
      serviceCtrl.subscribe(renderService);
      renderService(serviceCtrl.state());
      serviceCtrl.refresh();
      // Startup finishes asynchronously after the first paint. Keep the local
      // service controls current without reloading route drafts or other tabs.
      if (typeof window.setInterval === 'function') {
        window.setInterval(function () {
          if (document.visibilityState !== 'hidden') serviceCtrl.refresh();
        }, 3000);
      }
    } else renderService({ service: null, loading: false, pending: null, error: null });
    if (routingCtrl) {
      routingCtrl.subscribe(renderRouting);
      renderRouting(routingCtrl.state());
    } else renderRouting({ snapshot: null, loading: false, error: null, flagsSaving: false, flagsError: null, savingKey: null, saveError: null, savedFlash: null, draftKeys: [], draft: function () { return null; }, isClean: function () { return true; } });
    if (usageCtrl) {
      usageCtrl.subscribe(renderUsage);
      renderUsage(usageCtrl.state());
    } else renderUsage({ snapshot: null, loading: false, error: null, period: DEFAULT_USAGE_PERIOD });
    if (recordsCtrl) {
      recordsCtrl.subscribe(renderRecords);
      renderRecords(recordsCtrl.state());
    } else renderRecords(null);
    if (clientsCtrl) {
      clientsCtrl.subscribe(renderClients);
      renderClients(clientsCtrl.state());
    } else renderClients({ snapshot: null, loading: false, error: null, pending: null, rowError: null, confirmId: null });

    els.openUi.addEventListener('click', function () { safeCommand('quota_open_ui'); });
    els.quit.addEventListener('click', function () { safeCommand('quota_quit'); });
    window.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !event.isComposing && !event.defaultPrevented) {
        if (providerForm.escape() || (activeTab === 'plugins' && pluginsPanel.cancel(true))) event.preventDefault();
        else safeCommand('quota_hide');
      }
    });
    // The web UI can change project settings while the desktop is unfocused.
    window.addEventListener('focus', function () {
      if (serviceCtrl) serviceCtrl.refresh();
      if (activeTab === 'projects' && projectsCtrl) projectsCtrl.refresh();
      if (activeTab === 'quota' && controller) controller.refreshAll();
      if (activeTab === 'quota' && credentialsCtrl) credentialsCtrl.refresh();
    });
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }
})();
