(function () {
  'use strict';

  // ---- Projects tab: pure logic + preview backend -------------------------
  // DOM wiring lives in quota.js; this file never touches document/window so
  // it can be loaded in any order before quota.js and tested headlessly.
  //
  // IPC contract (all commands return ProjectsSnapshot):
  //   projects_snapshot()
  //   projects_add({path})                          absolute project path
  //   projects_save({change:{id,revision,useGlobal,router}})
  //   projects_takeover({id,revision,clients})
  //   projects_delete({id,revision})
  // ProjectRouter fields are OPTIONAL: absence means "not configured" and
  // must stay absent (never coerced to false/0/[]). Unknown raw config fields
  // never cross IPC; the server preserves them around the typed projection.

  var PROJECT_SCENARIOS = ['default', 'background', 'think', 'longContext', 'extendedContext', 'webSearch', 'image'];
  var PROJECT_FAMILIES = ['opus', 'sonnet', 'haiku'];
  var PROJECT_FLAGS = ['enableFamilyRouting', 'enableFallback', 'enableExtendedContext'];
  var FAMILY_FLAGS = ['enableExtendedContext'];
  var PROJECT_THRESHOLDS = ['longContextThreshold', 'extendedContextThreshold'];
  var THRESHOLD_LABELS = { longContextThreshold: '长上下文阈值', extendedContextThreshold: '扩展上下文阈值' };
  // Mirrors PROJECT_TAKEOVER_CLIENT_IDS on the server; Codex is global-only.
  var TAKEOVER_CLIENTS = [
    { id: 'claudeCode', name: 'Claude Code' },
    { id: 'pi', name: 'Pi' },
    { id: 'qwenCode', name: 'Qwen Code' },
    { id: 'opencode', name: 'OpenCode' },
    { id: 'zcode', name: 'ZCode' },
  ];
  var TAKEOVER_IDS = TAKEOVER_CLIENTS.map(function (c) { return c.id; });
  var STALE_MSG = '项目配置已被其他程序修改，请刷新后重试';

  function toStr(v) { return typeof v === 'string' && v ? v : null; }
  function errorMessage(err) {
    var message = typeof err === 'string' ? err : err && typeof err.message === 'string' ? err.message : '';
    if (/修改|过期|stale|revision/i.test(message)) return STALE_MSG;
    return '操作失败，请检查服务状态后重试；未保存的修改已保留。';
  }
  function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }
  function boundText(v) { var s = String(v == null ? '' : v); return s.length > 80 ? s.slice(0, 80) + '…' : s; }
  function sameSet(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    var x = a.slice().sort(), y = b.slice().sort();
    for (var i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    return true;
  }
  function validAlias(alias) {
    return !!alias && alias.length <= 64 && /^[\x20-\x7e]+$/.test(alias) && !/[,|]/.test(alias)
      && ['__proto__', 'constructor', 'prototype'].indexOf(alias) === -1;
  }
  var ALIAS_ERROR = '别名须为 1–64 个英文字符，不能包含逗号、竖线或保留名称';
  function isAbsolutePath(path) {
    var s = String(path == null ? '' : path);
    return s.charAt(0) === '/' || /^[A-Za-z]:[\\/]/.test(s) || /^\\\\[^\\]/.test(s);
  }
  // Stable stringify (sorted keys) so draft/canonical routers compare equal
  // regardless of key insertion order.
  function canonicalJson(v) {
    if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
    if (v && typeof v === 'object') {
      return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + canonicalJson(v[k]); }).join(',') + '}';
    }
    return JSON.stringify(v === undefined ? null : v);
  }
  function routerEq(a, b) { return canonicalJson(a) === canonicalJson(b); }

  function normalizeFallbackMap(src) {
    var out = {};
    if (!src || typeof src !== 'object') return out;
    PROJECT_SCENARIOS.forEach(function (k) {
      var list = src[k];
      if (!Array.isArray(list)) return;
      var clean = list.filter(function (x) { return typeof x === 'string' && x; });
      if (clean.length) out[k] = clean;
    });
    return out;
  }

  // Whitelist projection of a raw Router. Optional fields stay absent when
  // missing/invalid; families never carry nested families/models.
  function normalizeRouter(r, isFamily) {
    var s = r && typeof r === 'object' && !Array.isArray(r) ? r : {};
    var out = {};
    PROJECT_SCENARIOS.forEach(function (k) { if (typeof s[k] === 'string' && s[k]) out[k] = s[k]; });
    (isFamily ? FAMILY_FLAGS : PROJECT_FLAGS).forEach(function (k) { if (typeof s[k] === 'boolean') out[k] = s[k]; });
    PROJECT_THRESHOLDS.forEach(function (k) {
      var n = s[k];
      if (typeof n === 'number' && Number.isSafeInteger(n) && n > 0) out[k] = n;
    });
    var fb = normalizeFallbackMap(s.fallback);
    if (Object.keys(fb).length) out.fallback = fb;
    if (!isFamily) {
      if (s.models && typeof s.models === 'object' && !Array.isArray(s.models)) {
        var models = Object.create(null);
        Object.keys(s.models).forEach(function (alias) {
          var t = s.models[alias];
          if (alias && typeof t === 'string' && t) models[alias] = t;
        });
        if (Object.keys(models).length) out.models = models;
      }
      if (s.families && typeof s.families === 'object' && !Array.isArray(s.families)) {
        var fams = {};
        PROJECT_FAMILIES.forEach(function (f) {
          var v = s.families[f];
          // Presence is meaningful even when the projected family is empty.
          if (v && typeof v === 'object' && !Array.isArray(v)) fams[f] = normalizeRouter(v, true);
        });
        if (Object.keys(fams).length) out.families = fams;
      }
    }
    return out;
  }

  function normalizeProjectsSnapshot(r) {
    var s = r && typeof r === 'object' ? r : {};
    var providers = (Array.isArray(s.providers) ? s.providers : []).map(function (p) {
      var o = p && typeof p === 'object' ? p : {};
      return {
        name: toStr(o.name) || '未命名提供方',
        models: Array.isArray(o.models) ? o.models.filter(function (m) { return typeof m === 'string' && m; }) : [],
      };
    });
    var projects = [], seen = Object.create(null);
    (Array.isArray(s.projects) ? s.projects : []).forEach(function (p) {
      var o = p && typeof p === 'object' ? p : {};
      var id = toStr(o.id) || '', path = toStr(o.path) || '';
      if (!id || !path || seen[id]) return;
      seen[id] = true;
      projects.push({
        id: id,
        path: path,
        useGlobal: o.useGlobal === true,
        router: normalizeRouter(o.router, false),
        revision: toStr(o.revision) || '',
        takeoverClients: Array.isArray(o.takeoverClients)
          ? o.takeoverClients.filter(function (c) { return TAKEOVER_IDS.indexOf(c) !== -1; })
          : [],
      });
    });
    return { providers: providers, globalRouter: normalizeRouter(s.globalRouter, false), projects: projects };
  }

  function thresholdValue(v) {
    if (typeof v === 'number') return Number.isSafeInteger(v) && v > 0 ? v : null;
    if (typeof v === 'string' && /^\d+$/.test(v.trim())) {
      var n = parseInt(v.trim(), 10);
      return Number.isSafeInteger(n) && n > 0 ? n : null;
    }
    return null;
  }

  // The typed subset submitted to projects_save. Known fields are replaced
  // wholesale by the server (present -> set, absent -> delete); unknown raw
  // fields are preserved server-side. keepInvalid retains invalid threshold
  // input so dirty detection still sees it (save validation rejects it).
  function saveProjection(router, keepInvalid) {
    var s = router && typeof router === 'object' ? router : {};
    var out = {};
    PROJECT_SCENARIOS.forEach(function (k) {
      var t = typeof s[k] === 'string' ? s[k].trim() : '';
      if (t) out[k] = t;
    });
    (PROJECT_FLAGS).forEach(function (k) { if (typeof s[k] === 'boolean') out[k] = s[k]; });
    PROJECT_THRESHOLDS.forEach(function (k) {
      if (!Object.prototype.hasOwnProperty.call(s, k)) return;
      var n = thresholdValue(s[k]);
      if (n !== null) out[k] = n;
      else if (keepInvalid && s[k] !== '' && s[k] != null) out[k] = s[k];
    });
    var fb = normalizeFallbackMap(s.fallback);
    if (Object.keys(fb).length) out.fallback = fb;
    if (s.models && typeof s.models === 'object') {
      var models = Object.create(null);
      Object.keys(s.models).forEach(function (alias) {
        var t = typeof s.models[alias] === 'string' ? s.models[alias].trim() : '';
        if (alias && t) models[alias] = t;
      });
      if (Object.keys(models).length) out.models = models;
    }
    if (s.families && typeof s.families === 'object') {
      var fams = {};
      PROJECT_FAMILIES.forEach(function (f) {
        var v = s.families[f];
        if (!v || typeof v !== 'object' || Array.isArray(v)) return;
        var fo = {};
        PROJECT_SCENARIOS.forEach(function (k) {
          var t = typeof v[k] === 'string' ? v[k].trim() : '';
          if (t) fo[k] = t;
        });
        FAMILY_FLAGS.forEach(function (k) { if (typeof v[k] === 'boolean') fo[k] = v[k]; });
        PROJECT_THRESHOLDS.forEach(function (k) {
          if (!Object.prototype.hasOwnProperty.call(v, k)) return;
          var n = thresholdValue(v[k]);
          if (n !== null) fo[k] = n;
          else if (keepInvalid && v[k] !== '' && v[k] != null) fo[k] = v[k];
        });
        var ffb = normalizeFallbackMap(v.fallback);
        if (Object.keys(ffb).length) fo.fallback = ffb;
        fams[f] = fo; // empty family stays present: removal is deliberate
      });
      if (Object.keys(fams).length) out.families = fams;
    }
    return out;
  }

  function availableChoices(providers) {
    var seen = {}, out = [];
    (Array.isArray(providers) ? providers : []).forEach(function (p) {
      (p && Array.isArray(p.models) ? p.models : []).forEach(function (m) {
        var v = p.name + ',' + m;
        if (!seen[v]) { seen[v] = true; out.push(v); }
      });
    });
    return out;
  }

  // Validate CHANGED targets only: values equal to the baseline roundtrip even
  // when the provider/model is currently stale or disabled; new or edited
  // targets must match the current available choices.
  function validateRouterChange(router, baseline, choices) {
    var s = router && typeof router === 'object' ? router : {};
    var base = baseline && typeof baseline === 'object' ? baseline : {};
    var list = Array.isArray(choices) ? choices : [];

    function checkThresholds(obj, prefix) {
      for (var i = 0; i < PROJECT_THRESHOLDS.length; i++) {
        var k = PROJECT_THRESHOLDS[i];
        if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
        var v = obj[k];
        if (v === '' || v == null) continue; // cleared -> absent
        if (thresholdValue(v) === null) return prefix + THRESHOLD_LABELS[k] + '需为正整数';
      }
      return null;
    }
    function checkTarget(value, baseValue) {
      if (!value) return null;
      if (value === baseValue) return null;
      if (list.indexOf(value) === -1) return '目标「' + boundText(value) + '」不在当前可用提供方/模型中';
      return null;
    }
    function checkFallback(fb, baseFb) {
      var keys = Object.keys(fb || {});
      for (var i = 0; i < keys.length; i++) {
        var scenario = keys[i];
        var entries = fb[scenario] || [];
        var baseEntries = (baseFb && baseFb[scenario]) || [];
        for (var j = 0; j < entries.length; j++) {
          if (baseEntries.indexOf(entries[j]) !== -1) continue;
          if (list.indexOf(entries[j]) === -1) return '回退「' + boundText(entries[j]) + '」不在当前可用提供方/模型中';
        }
      }
      return null;
    }

    var err = checkThresholds(s, '');
    if (err) return { ok: false, message: err };
    var projected = saveProjection(s, false);
    var i, k;
    for (i = 0; i < PROJECT_SCENARIOS.length; i++) {
      k = PROJECT_SCENARIOS[i];
      err = checkTarget(projected[k], base[k]);
      if (err) return { ok: false, message: err };
    }
    err = checkFallback(projected.fallback, base.fallback);
    if (err) return { ok: false, message: err };
    var famKeys = Object.keys(projected.families || {});
    for (i = 0; i < famKeys.length; i++) {
      var f = famKeys[i];
      var fam = projected.families[f];
      var baseFam = (base.families && base.families[f]) || {};
      err = checkThresholds(s.families && s.families[f] ? s.families[f] : {}, '家族 ' + f + ' ');
      if (err) return { ok: false, message: err };
      for (var j = 0; j < PROJECT_SCENARIOS.length; j++) {
        k = PROJECT_SCENARIOS[j];
        err = checkTarget(fam[k], baseFam[k]);
        if (err) return { ok: false, message: '家族 ' + f + ' ' + err };
      }
      err = checkFallback(fam.fallback, baseFam.fallback);
      if (err) return { ok: false, message: '家族 ' + f + ' ' + err };
    }
    var aliases = Object.keys(projected.models || {});
    for (i = 0; i < aliases.length; i++) {
      var alias = aliases[i];
      var isNew = !(base.models && Object.prototype.hasOwnProperty.call(base.models, alias));
      if (isNew && !validAlias(alias)) return { ok: false, message: ALIAS_ERROR };
      err = checkTarget(projected.models[alias], base.models ? base.models[alias] : undefined);
      if (err) return { ok: false, message: '别名 ' + boundText(alias) + ' ' + err };
    }
    return { ok: true, router: projected };
  }

  function createProjectsController(options) {
    var invoke = options && options.invoke;
    if (typeof invoke !== 'function') throw new TypeError('createProjectsController: 需要 invoke 函数');
    var snapshot = null, loading = false, error = null;
    var selectedId = null;
    // Per-project drafts keep identity under async requests: a save for A can
    // never carry B's edits, and late responses never move the selection.
    var drafts = new Map(); // id -> {useGlobal, router|null, clients, baseRev, staleExternally}
    var pending = null; // {kind:'add'|'save'|'takeover'|'delete', id:string|null}
    var actionError = null; // {id, kind, message, stale}
    var savedFlash = null; // {id, kind, at, path}
    var confirmDeleteId = null;
    var epoch = 0;
    var listeners = new Set();

    function findProject(id) {
      if (!snapshot || !id) return null;
      for (var i = 0; i < snapshot.projects.length; i++) if (snapshot.projects[i].id === id) return snapshot.projects[i];
      return null;
    }
    function choices() { return snapshot ? availableChoices(snapshot.providers) : []; }
    function isRouterDirty(id) {
      var d = drafts.get(id), p = findProject(id);
      if (!d || !p) return false;
      if (d.useGlobal !== p.useGlobal) return true;
      if (d.useGlobal) return false;
      var eff = d.router ? d.router : snapshot.globalRouter;
      return !routerEq(saveProjection(eff, true), p.router);
    }
    function isClean(id) {
      var d = drafts.get(id);
      if (!d) return true;
      var p = findProject(id);
      if (!p) return false;
      if (!sameSet(d.clients, p.takeoverClients)) return false;
      return !isRouterDirty(id);
    }
    function staleFor(id) {
      if (actionError && actionError.id === id && actionError.stale) return { tone: 'error', message: actionError.message };
      var d = drafts.get(id);
      if (d && d.staleExternally && !isClean(id)) {
        return { tone: 'warn', message: '项目配置已在外部更新，未保存的修改仍保留；可重新加载或放弃修改。' };
      }
      return null;
    }
    function state() {
      var dirtyIds = [];
      drafts.forEach(function (d, id) { if (!isClean(id)) dirtyIds.push(id); });
      return {
        snapshot: snapshot, loading: loading, error: error, selectedId: selectedId,
        pending: pending, actionError: actionError, savedFlash: savedFlash, confirmDeleteId: confirmDeleteId,
        dirtyIds: dirtyIds, choices: choices(),
        draft: function (id) { return drafts.get(id) || null; },
        isClean: isClean, isRouterDirty: isRouterDirty, staleFor: staleFor,
        effectiveRouter: effectiveRouter,
      };
    }
    function emit() { var s = state(); listeners.forEach(function (fn) { try { fn(s); } catch { /* Rendering errors do not affect controller state. */ } }); }
    function subscribe(fn) { listeners.add(fn); return function () { listeners.delete(fn); }; }
    function clearFlash(id) { if (savedFlash && savedFlash.id === id) savedFlash = null; }
    function clearError(id) { if (actionError && actionError.id === id) actionError = null; }
    function isStaleError(err) {
      var raw = typeof err === 'string' ? err : err && typeof err.message === 'string' ? err.message : '';
      return /修改|过期|stale|revision/i.test(raw);
    }

    // Refresh never rebases dirty drafts onto a newer revision. Only an
    // acknowledged mutation for that same project advances its draft revision.
    function adopt(result, acknowledgedId) {
      snapshot = normalizeProjectsSnapshot(result);
      error = null;
      Array.from(drafts.keys()).forEach(function (id) {
        var p = findProject(id), d = drafts.get(id);
        if (!p) { d.staleExternally = true; return; }
        if (isClean(id)) { drafts.delete(id); return; }
        if (id === acknowledgedId) d.baseRev = p.revision;
        d.staleExternally = p.revision !== d.baseRev;
      });
      if (selectedId && !findProject(selectedId)) selectedId = null;
      if (!selectedId && snapshot.projects.length) selectedId = snapshot.projects[0].id;
    }

    function ensureDraft(id) {
      var p = findProject(id);
      if (!p) return null;
      var d = drafts.get(id);
      if (!d) {
        d = {
          useGlobal: p.useGlobal,
          // null = not materialized yet: a custom draft for a global project
          // starts from the CURRENT globalRouter (incl. nested fallback).
          router: p.useGlobal ? null : clone(p.router),
          clients: p.takeoverClients.slice(),
          baseRev: p.revision,
          staleExternally: false,
        };
        drafts.set(id, d);
      }
      return d;
    }
    function effectiveRouter(id) {
      var p = findProject(id);
      if (!p || !snapshot) return null;
      var d = drafts.get(id);
      var useGlobal = d ? d.useGlobal : p.useGlobal;
      if (useGlobal) return snapshot.globalRouter;
      if (d && d.router) return d.router;
      if (d) return snapshot.globalRouter;
      return p.router;
    }
    // Materialize the editable draft router; preview (useGlobal) is read-only.
    function editRouter(id) {
      var d = ensureDraft(id);
      if (!d || d.useGlobal || !snapshot) return null;
      if (!d.router) d.router = clone(snapshot.globalRouter);
      return d.router;
    }
    function scopeObj(router, scope) {
      if (scope === 'root') return router;
      if (PROJECT_FAMILIES.indexOf(scope) !== -1) return router.families ? router.families[scope] : null;
      return null;
    }

    function refresh() {
      if (loading || pending) return;
      loading = true;
      error = null;
      emit();
      var my = ++epoch;
      invoke('projects_snapshot').then(function (r) {
        if (my !== epoch) return;
        adopt(r, null);
        loading = false;
        emit();
      }, function (err) {
        if (my !== epoch) return;
        loading = false;
        error = errorMessage(err);
        emit();
      });
    }

    function select(id) {
      if (id !== null && !findProject(id)) return false;
      if (selectedId === id) return true;
      selectedId = id;
      confirmDeleteId = null;
      emit();
      return true;
    }

    function setUseGlobal(id, checked) {
      var d = ensureDraft(id);
      if (!d || typeof checked !== 'boolean' || d.useGlobal === checked) return false;
      d.useGlobal = checked;
      if (!checked && !d.router) d.router = clone(snapshot.globalRouter);
      clearFlash(id);
      emit();
      return true;
    }

    function setTarget(id, scope, field, value) {
      var r = editRouter(id);
      if (!r) return false;
      var next = String(value == null ? '' : value);
      if (scope === 'models') {
        if (!field) return false;
        r.models = r.models || Object.create(null);
        if (r.models[field] === next) return false;
        r.models[field] = next; // empty target stays a draft row; save drops it
      } else {
        var obj = scopeObj(r, scope);
        if (!obj || PROJECT_SCENARIOS.indexOf(field) === -1) return false;
        if (next === '') delete obj[field];
        else obj[field] = next;
      }
      clearFlash(id);
      emit();
      return true;
    }

    function setFlag(id, scope, name, value) {
      var r = editRouter(id);
      if (!r || (value !== null && typeof value !== 'boolean')) return false;
      var allowed = scope === 'root' ? PROJECT_FLAGS : FAMILY_FLAGS;
      if (allowed.indexOf(name) === -1) return false;
      var obj = scopeObj(r, scope);
      if (!obj) return false;
      if (value === null) delete obj[name]; else obj[name] = value;
      clearFlash(id);
      emit();
      return true;
    }

    function setThreshold(id, scope, name, raw) {
      var r = editRouter(id);
      if (!r || PROJECT_THRESHOLDS.indexOf(name) === -1) return false;
      var obj = scopeObj(r, scope);
      if (!obj) return false;
      var v = String(raw == null ? '' : raw);
      if (v === '') delete obj[name]; // absent keeps the server-side default
      else obj[name] = v; // validated as a positive integer on save
      clearFlash(id);
      emit();
      return true;
    }

    function fallbackList(id, scope, scenario, create) {
      var r = editRouter(id);
      if (!r) return null;
      var obj = scopeObj(r, scope);
      if (!obj || PROJECT_SCENARIOS.indexOf(scenario) === -1) return null;
      if (!obj.fallback) {
        if (!create) return null;
        obj.fallback = {};
      }
      if (!obj.fallback[scenario]) {
        if (!create) return null;
        obj.fallback[scenario] = [];
      }
      return { obj: obj, list: obj.fallback[scenario] };
    }
    function pruneFallback(obj) {
      if (!obj.fallback) return;
      Object.keys(obj.fallback).forEach(function (k) { if (!obj.fallback[k].length) delete obj.fallback[k]; });
      if (!Object.keys(obj.fallback).length) delete obj.fallback;
    }

    function addFallback(id, scope, scenario, rawValue) {
      var v = String(rawValue == null ? '' : rawValue).trim();
      if (!v) return { ok: false, message: '请输入 提供方,模型' };
      var ctx = fallbackList(id, scope, scenario, true);
      if (!ctx) return { ok: false, message: '路由配置尚未读取' };
      if (ctx.list.indexOf(v) !== -1) return { ok: false, message: '该回退已存在' };
      ctx.list.push(v);
      clearFlash(id);
      emit();
      return { ok: true };
    }
    function removeFallback(id, scope, scenario, index) {
      var ctx = fallbackList(id, scope, scenario, false);
      if (!ctx) return false;
      var i = typeof index === 'number' ? index : NaN;
      if (!(i >= 0 && i < ctx.list.length)) return false;
      ctx.list.splice(i, 1);
      pruneFallback(ctx.obj);
      clearFlash(id);
      emit();
      return true;
    }
    function moveFallback(id, scope, scenario, index, direction) {
      var ctx = fallbackList(id, scope, scenario, false);
      if (!ctx) return false;
      var i = typeof index === 'number' ? index : NaN;
      var j = i + (direction < 0 ? -1 : 1);
      if (!(i >= 0 && j >= 0 && i < ctx.list.length && j < ctx.list.length)) return false;
      var moved = ctx.list.splice(i, 1)[0];
      ctx.list.splice(j, 0, moved);
      clearFlash(id);
      emit();
      return true;
    }

    function addFamily(id, family) {
      if (PROJECT_FAMILIES.indexOf(family) === -1) return false;
      var r = editRouter(id);
      if (!r) return false;
      r.families = r.families || {};
      if (r.families[family]) return false;
      var first = choices()[0] || '';
      r.families[family] = first ? { default: first } : {};
      clearFlash(id);
      emit();
      return true;
    }
    function removeFamily(id, family) {
      var r = editRouter(id);
      if (!r || !r.families || !r.families[family]) return false;
      delete r.families[family]; // deliberate removal; save deletes it server-side
      if (!Object.keys(r.families).length) delete r.families;
      clearFlash(id);
      emit();
      return true;
    }

    function addAlias(id, name, target) {
      var alias = String(name == null ? '' : name).trim();
      if (!alias) return { ok: false, message: '请输入模型别名' };
      if (!validAlias(alias)) return { ok: false, message: ALIAS_ERROR };
      var t = String(target == null ? '' : target).trim();
      if (!t) return { ok: false, message: '请输入目标 提供方,模型' };
      var r = editRouter(id);
      if (!r) return { ok: false, message: '路由配置尚未读取' };
      r.models = r.models || Object.create(null);
      if (Object.prototype.hasOwnProperty.call(r.models, alias)) return { ok: false, message: '该别名已存在' };
      r.models[alias] = t;
      clearFlash(id);
      emit();
      return { ok: true };
    }
    function removeAlias(id, name) {
      var r = editRouter(id);
      if (!r || !r.models || !Object.prototype.hasOwnProperty.call(r.models, name)) return false;
      delete r.models[name];
      if (!Object.keys(r.models).length) delete r.models;
      clearFlash(id);
      emit();
      return true;
    }

    function setTakeoverClient(id, clientId, checked) {
      if (TAKEOVER_IDS.indexOf(clientId) === -1 || typeof checked !== 'boolean') return false;
      var d = ensureDraft(id);
      if (!d) return false;
      var has = d.clients.indexOf(clientId) !== -1;
      if (has === checked) return false;
      d.clients = checked ? d.clients.concat([clientId]) : d.clients.filter(function (c) { return c !== clientId; });
      clearFlash(id);
      emit();
      return true;
    }

    function resetDraft(id) {
      if (!drafts.has(id)) { clearError(id); emit(); return false; }
      drafts.delete(id);
      clearError(id);
      clearFlash(id);
      emit();
      return true;
    }

    function mutationError(id, kind, err) {
      pending = null;
      actionError = { id: id, kind: kind, message: errorMessage(err), stale: isStaleError(err) };
      emit();
    }

    function save(id) {
      if (!snapshot || loading || pending || confirmDeleteId) return false;
      var p = findProject(id);
      if (!p || !drafts.has(id) || !isRouterDirty(id)) return false;
      var d = drafts.get(id);
      var router = {};
      if (!d.useGlobal) {
        var eff = d.router ? d.router : snapshot.globalRouter;
        var baseline = p.useGlobal ? snapshot.globalRouter : p.router;
        var v = validateRouterChange(eff, baseline, choices());
        if (!v.ok) {
          actionError = { id: id, kind: 'save', message: v.message, stale: false };
          emit();
          return false;
        }
        router = v.router;
      }
      // useGlobal=true stores {} exactly; custom saves preserve unknown fields server-side.
      var change = { id: id, revision: d.baseRev, useGlobal: d.useGlobal, router: router };
      pending = { kind: 'save', id: id };
      clearError(id);
      clearFlash(id);
      emit();
      var my = ++epoch;
      invoke('projects_save', { change: change }).then(function (resp) {
        if (my !== epoch) return;
        pending = null;
        var currentDraft = drafts.get(id);
        if (change.useGlobal && currentDraft && currentDraft.useGlobal) currentDraft.router = null;
        // Only the server knows whether unexposed fields remain after clearing
        // all visible fields. Adopt inheritance only for an unchanged empty
        // submitted draft; never discard edits typed while the save ran.
        var savedProject = resp && Array.isArray(resp.projects) && resp.projects.find(function (x) { return x.id === id; });
        if (!change.useGlobal && Object.keys(change.router).length === 0 && savedProject && savedProject.useGlobal
          && currentDraft && !currentDraft.useGlobal && routerEq(saveProjection(currentDraft.router || {}, true), change.router)) {
          currentDraft.useGlobal = true;
          currentDraft.router = null;
        }
        adopt(resp, id);
        if (!isRouterDirty(id)) savedFlash = { id: id, kind: 'save', at: Date.now(), path: p.path };
        emit();
      }, function (err) {
        if (my !== epoch) return;
        mutationError(id, 'save', err);
      });
      return true;
    }

    function applyTakeover(id) {
      if (!snapshot || loading || pending || confirmDeleteId) return false;
      var p = findProject(id);
      if (!p) return false;
      var d = drafts.get(id);
      var clients = (d ? d.clients : p.takeoverClients).filter(function (c) { return TAKEOVER_IDS.indexOf(c) !== -1; });
      if (sameSet(clients, p.takeoverClients)) return false;
      pending = { kind: 'takeover', id: id };
      clearError(id);
      clearFlash(id);
      emit();
      var my = ++epoch;
      invoke('projects_takeover', { id: id, revision: d ? d.baseRev : p.revision, clients: clients }).then(function (resp) {
        if (my !== epoch) return;
        pending = null;
        adopt(resp, id);
        var d2 = drafts.get(id);
        if (!d2 || sameSet(d2.clients, findProject(id) ? findProject(id).takeoverClients : [])) {
          savedFlash = { id: id, kind: 'takeover', at: Date.now(), path: p.path };
        }
        emit();
      }, function (err) {
        if (my !== epoch) return;
        mutationError(id, 'takeover', err);
      });
      return true;
    }

    function requestDelete(id) {
      if (pending || loading || !findProject(id)) return false;
      confirmDeleteId = id;
      emit();
      return true;
    }
    function cancelDelete() {
      if (confirmDeleteId === null) return false;
      confirmDeleteId = null;
      emit();
      return true;
    }
    function confirmDelete(id) {
      if (confirmDeleteId !== id) return false;
      confirmDeleteId = null;
      if (!snapshot || loading || pending || confirmDeleteId) return false;
      var p = findProject(id);
      if (!p) return false;
      pending = { kind: 'delete', id: id };
      clearError(id);
      emit();
      var my = ++epoch;
      invoke('projects_delete', { id: id, revision: drafts.has(id) ? drafts.get(id).baseRev : p.revision }).then(function (resp) {
        if (my !== epoch) return;
        pending = null;
        drafts.delete(id);
        adopt(resp, id);
        savedFlash = { id: id, kind: 'delete', at: Date.now(), path: p.path };
        emit();
      }, function (err) {
        if (my !== epoch) return;
        mutationError(id, 'delete', err);
      });
      return true;
    }

    function addProject(rawPath) {
      if (!snapshot || loading || pending || confirmDeleteId) return { ok: false, message: '项目配置尚未读取' };
      var path = String(rawPath == null ? '' : rawPath).trim();
      if (!path) return { ok: false, message: '请输入项目绝对路径' };
      if (!isAbsolutePath(path)) return { ok: false, message: '请输入绝对路径，如 /Users/you/project' };
      var norm = path.replace(/[\\/]+$/, '');
      var exists = snapshot.projects.some(function (p) { return p.path === norm || p.path === path; });
      if (exists) return { ok: false, message: '该项目已配置' };
      pending = { kind: 'add', id: null };
      actionError = null;
      emit();
      var selectionAtStart = selectedId;
      var my = ++epoch;
      invoke('projects_add', { path: path }).then(function (resp) {
        if (my !== epoch) return;
        pending = null;
        adopt(resp, null);
        var added = null;
        snapshot.projects.forEach(function (p) { if (p.path === norm || p.path === path) added = p; });
        if (added && selectedId === selectionAtStart) selectedId = added.id;
        savedFlash = { id: added ? added.id : null, kind: 'add', at: Date.now(), path: path };
        emit();
      }, function (err) {
        if (my !== epoch) return;
        pending = null;
        actionError = { id: null, kind: 'add', message: errorMessage(err), stale: false };
        emit();
      });
      return { ok: true };
    }

    return {
      subscribe: subscribe, state: state, refresh: refresh, select: select,
      setUseGlobal: setUseGlobal, setTarget: setTarget, setFlag: setFlag, setThreshold: setThreshold,
      addFallback: addFallback, removeFallback: removeFallback, moveFallback: moveFallback,
      addFamily: addFamily, removeFamily: removeFamily, addAlias: addAlias, removeAlias: removeAlias,
      setTakeoverClient: setTakeoverClient, resetDraft: resetDraft,
      save: save, applyTakeover: applyTakeover,
      requestDelete: requestDelete, cancelDelete: cancelDelete, confirmDelete: confirmDelete,
      addProject: addProject,
    };
  }


  // ---- Preview backend (?preview=1 only, in-memory, never writes) ---------
  // Mirrors the server merge contract: known projected fields are replaced by
  // the submitted subset (absent -> deleted), unknown raw fields survive.

  function createPreviewProjects() {
    var providers = [
      { name: 'alpha.example.com', models: ['claude-opus-4-5', 'claude-sonnet-4-5'] },
      { name: 'beta.example.com', models: ['gemini-3-pro', 'glm-5'] },
    ];
    // globalRaw already carries the root fallback merged into Router.fallback.
    var globalRaw = {
      default: 'alpha.example.com,claude-sonnet-4-5',
      background: 'beta.example.com,glm-5',
      think: 'alpha.example.com,claude-opus-4-5',
      enableFamilyRouting: true,
      enableFallback: true,
      longContextThreshold: 60000,
      extendedContextThreshold: 200000,
      fallback: { default: ['beta.example.com,gemini-3-pro'] },
      families: { opus: { default: 'alpha.example.com,claude-opus-4-5' } },
      models: { 'glm-5': 'beta.example.com,glm-5' },
      previewUnknownGlobal: 'keep-me',
    };
    var seq = 2;
    var rawProjects = [
      { id: 'proj-website', path: '/Users/demo/work/website', useGlobal: true, raw: {}, rev: 1, clients: ['claudeCode'] },
      {
        id: 'proj-api', path: '/Users/demo/work/api-server', useGlobal: false, rev: 1, clients: ['claudeCode', 'pi'],
        raw: {
          default: 'beta.example.com,gemini-3-pro',
          think: 'alpha.example.com,claude-opus-4-5',
          enableFallback: true,
          longContextThreshold: 120000,
          fallback: { default: ['alpha.example.com,claude-sonnet-4-5'], think: ['beta.example.com,glm-5'] },
          families: { sonnet: { default: 'beta.example.com,glm-5', fallback: { default: ['alpha.example.com,claude-sonnet-4-5'] } } },
          models: { 'kimi-k2': 'beta.example.com,glm-5' },
          customUnknownField: { keep: true },
        },
      },
    ];

    function copy(v) { return JSON.parse(JSON.stringify(v)); }
    function delay(v) { return new Promise(function (resolve) { setTimeout(function () { resolve(v); }, 120); }); }
    function fail(msg) { return Promise.reject(new Error(msg)); }
    function revOf(p) { return p.id + '-rev-' + p.rev; }
    function find(id) {
      for (var i = 0; i < rawProjects.length; i++) if (rawProjects[i].id === id) return rawProjects[i];
      return null;
    }
    function snapshot() {
      return {
        providers: copy(providers),
        globalRouter: normalizeRouter(globalRaw, false),
        projects: rawProjects.map(function (p) {
          return {
            id: p.id, path: p.path, useGlobal: p.useGlobal,
            router: normalizeRouter(p.raw, false), revision: revOf(p), takeoverClients: p.clients.slice(),
          };
        }),
      };
    }
    function mergeRouter(base, submitted, isFamily) {
      var out = copy(base) || {};
      var known = PROJECT_SCENARIOS.concat(isFamily ? FAMILY_FLAGS : PROJECT_FLAGS, PROJECT_THRESHOLDS);
      known.forEach(function (k) {
        if (submitted && Object.prototype.hasOwnProperty.call(submitted, k)) out[k] = copy(submitted[k]);
        else delete out[k];
      });
      var fb = out.fallback && typeof out.fallback === 'object' ? copy(out.fallback) : {};
      PROJECT_SCENARIOS.forEach(function (k) {
        if (submitted && submitted.fallback && Object.prototype.hasOwnProperty.call(submitted.fallback, k)) fb[k] = submitted.fallback[k].slice();
        else delete fb[k];
      });
      if (Object.keys(fb).length) out.fallback = fb; else delete out.fallback;
      if (!isFamily) {
        if (submitted && submitted.models && Object.keys(submitted.models).length) out.models = copy(submitted.models);
        else delete out.models;
        var fams = out.families && typeof out.families === 'object' ? copy(out.families) : {};
        PROJECT_FAMILIES.forEach(function (f) {
          if (submitted && submitted.families && Object.prototype.hasOwnProperty.call(submitted.families, f)) {
            var baseFam = fams[f] && typeof fams[f] === 'object' ? fams[f] : {};
            fams[f] = mergeRouter(baseFam, submitted.families[f], true);
          } else delete fams[f];
        });
        if (Object.keys(fams).length) out.families = fams; else delete out.families;
      }
      return out;
    }

    return function (cmd, args) {
      var a = args && typeof args === 'object' ? args : {};
      if (cmd === 'projects_snapshot') return delay(snapshot());
      if (cmd === 'projects_add') {
        var path = typeof a.path === 'string' ? a.path.trim() : '';
        if (!isAbsolutePath(path)) return fail('请输入绝对路径，如 /Users/you/project');
        var norm = path.replace(/[\\/]+$/, '');
        if (rawProjects.some(function (p) { return p.path === norm; })) return fail('该项目已配置');
        seq += 1;
        // Server default: Claude Code takeover + follow global router.
        rawProjects.push({ id: 'proj-' + seq, path: norm, useGlobal: true, raw: {}, rev: 1, clients: ['claudeCode'] });
        return delay(snapshot());
      }
      if (cmd === 'projects_save') {
        var ch = a.change && typeof a.change === 'object' ? a.change : {};
        var p = find(ch.id);
        if (!p) return fail('未知项目');
        if (ch.revision !== revOf(p)) return fail(STALE_MSG);
        if (typeof ch.useGlobal !== 'boolean') return fail('useGlobal 无效');
        if (ch.useGlobal) {
          p.raw = {};
          p.useGlobal = true;
        } else {
          var router = ch.router && typeof ch.router === 'object' ? ch.router : {};
          var baselineRaw = p.useGlobal || !Object.keys(p.raw).length ? globalRaw : p.raw;
          var v = validateRouterChange(router, normalizeRouter(baselineRaw, false), availableChoices(providers));
          if (!v.ok) return fail(v.message);
          var base = Object.keys(p.raw).length ? p.raw : copy(globalRaw);
          p.raw = mergeRouter(base, v.router, false);
          p.useGlobal = false;
        }
        p.rev += 1;
        return delay(snapshot());
      }
      if (cmd === 'projects_takeover') {
        var pt = find(a.id);
        if (!pt) return fail('未知项目');
        if (a.revision !== revOf(pt)) return fail(STALE_MSG);
        if (!Array.isArray(a.clients)) return fail('clients 无效');
        pt.clients = a.clients.filter(function (c) { return TAKEOVER_IDS.indexOf(c) !== -1; });
        pt.rev += 1;
        return delay(snapshot());
      }
      if (cmd === 'projects_delete') {
        var pd = find(a.id);
        if (!pd) return fail('未知项目');
        if (a.revision !== revOf(pd)) return fail(STALE_MSG);
        rawProjects = rawProjects.filter(function (p) { return p.id !== pd.id; });
        return delay(snapshot());
      }
      return Promise.resolve(null);
    };
  }


  // Rebuild only on structural changes; ordinary typing updates state without
  // replacing the focused input. Temporary add fields are keyed by project.
  function mount(doc, controller) {
    var body = doc.getElementById('projects-body');
    var picker = doc.getElementById('projects-select');
    var count = doc.getElementById('projects-count');
    var message = doc.getElementById('projects-msg');
    var refresh = doc.getElementById('projects-refresh');
    var scopes = new Map(), buffers = new Map();
    var currentSignature = null, refs = [], localError = '', newPath = '';
    function el(tag, cls, text) {
      var n = doc.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    }
    // Disabled-in-preview hint: projects using the global router render a
    // read-only mirror, so every locked control explains why and how to edit.
    var GLOBAL_PREVIEW_HINT = '使用全局路由：此处为全局配置预览；取消勾选「使用全局路由」后可编辑';
    var hintWhen = function (locked, node) { if (locked) node.title = GLOBAL_PREVIEW_HINT; return node; };
    function button(text, fn, disabled, cls) {
      var n = el('button', cls || 'btn', text); n.type = 'button'; n.disabled = !!disabled;
      n.addEventListener('click', fn); return n;
    }
    function input(label, value, fn, disabled, key, type) {
      var n = el('input', 'route-input'); n.type = type || 'text'; n.value = value == null ? '' : String(value);
      n.setAttribute('aria-label', label); n.disabled = !!disabled;
      if (key) n.dataset.projectInput = key;
      n.addEventListener('input', function () { fn(n.value); });
      return n;
    }
    function labeled(label, node) { var wrap = el('label', 'project-field'); wrap.appendChild(el('span', '', label)); wrap.appendChild(node); return wrap; }
    function check(label, value, fn, disabled) {
      var wrap = el('label', 'flag'), n = el('input', 'switch'); n.type = 'checkbox'; n.checked = !!value;
      n.setAttribute('role', 'switch'); n.setAttribute('aria-label', label); n.disabled = !!disabled;
      n.addEventListener('change', function () { fn(n.checked); }); wrap.appendChild(n); wrap.appendChild(el('span', '', label)); return wrap;
    }
    function tempInput(label, key, disabled) {
      return input(label, buffers.get(key) || '', function (v) { buffers.set(key, v); }, disabled, key);
    }
    function render() {
      var s = controller && controller.state();
      refresh.disabled = !s || s.loading || !!s.pending;
      count.textContent = s && s.snapshot ? '已配置 ' + s.snapshot.projects.length + ' 个项目' : s && s.loading ? '正在读取…' : '';
      var projects = s && s.snapshot ? s.snapshot.projects : [];
      picker.textContent = '';
      projects.forEach(function (p) {
        var option = el('option', '', p.path + (s.dirtyIds.indexOf(p.id) !== -1 ? ' · 未保存' : ''));
        option.value = p.id; picker.appendChild(option);
      });
      picker.value = s && s.selectedId || ''; picker.disabled = !projects.length;
      var p = s && projects.find(function (x) { return x.id === s.selectedId; });
      var d = p && s.draft(p.id), router = p && s.effectiveRouter(p.id);
      var global = p && (d ? d.useGlobal : p.useGlobal);
      var scope = p ? scopes.get(p.id) || 'root' : 'root';
      var obj = router && (scope === 'root' ? router : scope === 'models' ? router.models || {} : router.families && router.families[scope]);
      var stale = p && s.staleFor(p.id);
      var actionError = s && s.actionError && (s.actionError.id === null || s.actionError.id === s.selectedId) ? s.actionError.message : '';
      var flash = s && s.savedFlash;
      if (flash && flash.kind === 'add' && newPath.trim() === flash.path) newPath = '';
      var flashText = flash && (flash.id === s.selectedId || flash.kind === 'delete') ?
        (flash.kind === 'delete' ? '已移除 CCR 项目配置：' + flash.path : flash.kind === 'takeover' ? '已应用接管客户端' : flash.kind === 'add' ? '项目已添加，请检查实际接管状态' : '项目路由已保存') : '';
      var text = localError || actionError || (s && s.error) || (stale && stale.message) || flashText;
      message.textContent = text || ''; message.hidden = !text;
      message.setAttribute('data-tone', localError || actionError || s && s.error ? 'error' : 'warn');
      var busy = !s || s.loading || !!s.pending || !!s.confirmDeleteId;
      // Text targets/thresholds are synced separately to retain caret and IME.
      var structuralRouter = router && clone(router);
      function omitInputs(o) {
        if (!o) return;
        PROJECT_SCENARIOS.concat(PROJECT_THRESHOLDS).forEach(function (k) { delete o[k]; });
      }
      if (structuralRouter) {
        omitInputs(structuralRouter);
        Object.keys(structuralRouter.families || {}).forEach(function (f) { omitInputs(structuralRouter.families[f]); });
        if (structuralRouter.models) Object.keys(structuralRouter.models).forEach(function (a) { structuralRouter.models[a] = true; });
      }
      var signature = canonicalJson([s && s.selectedId, scope, global, structuralRouter, busy,
        d ? d.clients : p && p.takeoverClients, s && s.confirmDeleteId, s && s.pending,
        s && s.choices, !!p, !!(s && s.snapshot)]);
      if (signature === currentSignature) {
        refs.forEach(function (r) {
          var source = r.scope === 'root' ? router : r.scope === 'models' ? router.models || {} : router.families && router.families[r.scope] || {};
          var v = source[r.field] == null ? '' : String(source[r.field]);
          if (doc.activeElement !== r.node) r.node.value = v;
        });
        updateActions(s, p, d, busy);
        return;
      }
      currentSignature = signature;
      var active = doc.activeElement;
      var focusKey = active && active.dataset && active.dataset.projectInput;
      var selectionStart = active && active.selectionStart, selectionEnd = active && active.selectionEnd;
      var scroll = body.scrollTop;
      body.textContent = ''; refs = [];
      var addCard = el('div', 'card');
      addCard.appendChild(el('div', 'route-name', '添加项目'));
      addCard.appendChild(el('p', 'project-note', '添加时会创建 CCR 项目配置并默认接管 Claude Code；其他客户端需手动选择。'));
      var addRow = el('div', 'route-target');
      var pathInput = input('新项目绝对路径', newPath, function (v) { newPath = v; }, busy, 'new-project-path');
      pathInput.placeholder = '/Users/you/project'; addRow.appendChild(pathInput);
      addRow.appendChild(button(s && s.pending && s.pending.kind === 'add' ? '添加中…' : '添加', function () {
        var result = controller.addProject(newPath); localError = result.ok ? '' : result.message; render();
      }, busy || !s.snapshot));
      addCard.appendChild(addRow); body.appendChild(addCard);
      if (!p) {
        body.appendChild(el('div', 'empty', !s ? '桌面 IPC 不可用，无法读取项目。' : s.loading ? '正在读取项目…' : s.snapshot ? '暂无已配置项目，请输入绝对路径添加。' : '打开项目页后读取项目；读取失败可点击刷新重试。'));
        return;
      }
      var id = p.id;
      var header = el('div', 'card project-summary'); header.appendChild(el('div', 'card-name', p.path));
      header.appendChild(el('span', 'badge project-dirty', s.isClean(id) ? '已同步' : '未保存'));
      header.appendChild(el('p', 'project-note', global ? '使用当前全局路由 · 下方仅预览' : '自定义项目路由 · 修改后点击保存'));
      header.appendChild(check('使用全局路由', global, function (v) { controller.setUseGlobal(id, v); }, false));
      header.appendChild(el('p', 'project-note', '勾选并保存将清除项目路由覆盖；取消勾选可从全局配置开始编辑。'));
      var actions = el('div', 'project-actions');
      var save = button('保存项目路由', function () { localError = ''; controller.save(id); }, busy, 'btn btn-primary project-save');
      actions.appendChild(save);
      actions.appendChild(button('重新加载 / 放弃修改', function () {
        controller.resetDraft(id); localError = ''; controller.refresh();
      }, busy, 'btn project-reset'));
      actions.appendChild(button('移除项目配置', function () { controller.requestDelete(id); }, busy, 'btn btn-danger-quiet'));
      header.appendChild(actions);
      if (s.confirmDeleteId === id) {
        var confirm = el('div', 'client-confirm');
        confirm.appendChild(el('span', '', '移除 CCR 项目配置，不删除项目文件。将恢复该项目的客户端接管配置；未保存的修改会丢弃。确认移除「' + p.path + '」？'));
        var confirmActions = el('div', 'client-confirm-actions');
        confirmActions.appendChild(button('确认移除', function () { controller.confirmDelete(id); }, false, 'btn btn-danger'));
        confirmActions.appendChild(button('取消', function () { controller.cancelDelete(); })); confirm.appendChild(confirmActions); header.appendChild(confirm);
      }
      body.appendChild(header);
      var takeover = el('div', 'card'); takeover.appendChild(el('div', 'route-name', '项目客户端接管'));
      takeover.appendChild(el('p', 'project-note', '选择后点击应用；取消所有选择并应用可恢复接管前的配置。'));
      var clients = d ? d.clients : p.takeoverClients;
      var clientChoices = el('div', 'project-flags');
      TAKEOVER_CLIENTS.forEach(function (c) { clientChoices.appendChild(check(c.name, clients.indexOf(c.id) !== -1, function (v) { controller.setTakeoverClient(id, c.id, v); }, false)); });
      takeover.appendChild(clientChoices);
      takeover.appendChild(button('应用所选客户端', function () { localError = ''; controller.applyTakeover(id); }, busy, 'btn project-apply'));
      body.appendChild(takeover);
      var nav = el('div', 'project-scopes');
      ['root'].concat(PROJECT_FAMILIES, ['models']).forEach(function (f) {
        var label = f === 'root' ? '项目路由' : f === 'models' ? '模型别名' : f.charAt(0).toUpperCase() + f.slice(1);
        var b = button(label, function () { scopes.set(id, f); localError = ''; render(); }, false, 'scope-btn');
        b.setAttribute('aria-pressed', String(scope === f)); nav.appendChild(b);
      }); body.appendChild(nav);
      var choices = el('datalist'); choices.id = 'project-route-choices'; choices.setAttribute('id', 'project-route-choices');
      s.choices.forEach(function (v) { var o = el('option'); o.value = v; choices.appendChild(o); }); body.appendChild(choices);
      if (scope === 'models') {
        Object.keys(obj || {}).forEach(function (alias) {
          var card = el('div', 'route'); card.appendChild(el('div', 'route-name', alias));
          var n = routeInput(alias, obj[alias], alias); card.appendChild(n);
          card.appendChild(button('移除别名', function () { controller.removeAlias(id, alias); }, global)); body.appendChild(card);
        });
        if (!global) {
          var aliasCard = el('div', 'card');
          var aliasName = tempInput('新模型别名', id + '|alias-name', false), aliasTarget = tempInput('别名目标', id + '|alias-target', false);
          aliasTarget.setAttribute('list', 'project-route-choices');
          aliasCard.appendChild(labeled('新别名', aliasName)); aliasCard.appendChild(labeled('目标 提供方,模型', aliasTarget));
          aliasCard.appendChild(button('添加别名', function () {
            var result = controller.addAlias(id, aliasName.value, aliasTarget.value);
            localError = result.ok ? '' : result.message;
            if (result.ok) { buffers.delete(id + '|alias-name'); buffers.delete(id + '|alias-target'); currentSignature = null; }
            render();
          })); body.appendChild(aliasCard);
        }
      } else if (!obj) {
        var absent = el('div', 'card'); absent.appendChild(el('p', 'project-note', '该家族尚未配置，将使用项目路由。'));
        absent.appendChild(button('添加家族配置', function () { controller.addFamily(id, scope); }, global)); body.appendChild(absent);
      } else {
        var flags = el('div', 'card project-settings');
        var labels = { enableFamilyRouting: '家族路由', enableFallback: '回退', enableExtendedContext: '扩展上下文' };
        (scope === 'root' ? PROJECT_FLAGS : FAMILY_FLAGS).forEach(function (k) {
          var row = el('div', 'project-setting');
          row.appendChild(hintWhen(global, check(labels[k], obj[k], function (v) { controller.setFlag(id, scope, k, v); }, global)));
          row.appendChild(el('span', 'count', Object.prototype.hasOwnProperty.call(obj, k) ? '' : '未设置'));
          if (!global && Object.prototype.hasOwnProperty.call(obj, k)) row.appendChild(button('使用默认', function () { controller.setFlag(id, scope, k, null); }));
          flags.appendChild(row);
        });
        PROJECT_THRESHOLDS.forEach(function (k) {
          var n = hintWhen(global, input(THRESHOLD_LABELS[k], obj[k], function (v) { controller.setThreshold(id, scope, k, v); }, global, id + '|' + scope + '|' + k, 'number'));
          n.min = '1'; n.step = '1'; n.placeholder = k === 'longContextThreshold' ? '默认 60000' : '默认 200000';
          refs.push({ node: n, scope: scope, field: k }); flags.appendChild(labeled(THRESHOLD_LABELS[k] + '（留空使用默认值）', n));
        });
        if (scope !== 'root') flags.appendChild(hintWhen(global, button('移除家族配置', function () { controller.removeFamily(id, scope); }, global, 'btn btn-danger-quiet')));
        body.appendChild(flags);
        var grid = el('div', 'project-routes');
        var labelsByScenario = { default: '默认', background: '后台', think: '思考', longContext: '长上下文', extendedContext: '扩展上下文', webSearch: '网页搜索', image: '图像' };
        PROJECT_SCENARIOS.forEach(function (scenario) {
          var label = labelsByScenario[scenario], card = el('div', 'route'); card.dataset.scenario = scenario;
          card.appendChild(el('div', 'route-name', label));
          card.appendChild(routeInput(label + ' 目标', obj[scenario], scenario));
          card.appendChild(el('div', 'route-fallback-label', '回退顺序'));
          var list = el('ol', 'fallback-list'), entries = obj.fallback && obj.fallback[scenario] || [];
          entries.forEach(function (name, i) {
            var row = el('li', 'fallback-item'); row.appendChild(el('span', 'fallback-order', (i + 1) + '.')); row.appendChild(el('span', 'fallback-name', name));
            var up = hintWhen(global, button('↑', function () { controller.moveFallback(id, scope, scenario, i, -1); }, global || i === 0)); up.setAttribute('aria-label', label + ' 上移回退 ' + name);
            var down = hintWhen(global, button('↓', function () { controller.moveFallback(id, scope, scenario, i, 1); }, global || i === entries.length - 1)); down.setAttribute('aria-label', label + ' 下移回退 ' + name);
            var remove = hintWhen(global, button('移除', function () { controller.removeFallback(id, scope, scenario, i); }, global)); remove.setAttribute('aria-label', label + ' 移除回退 ' + name);
            row.appendChild(up); row.appendChild(down); row.appendChild(remove); list.appendChild(row);
          }); card.appendChild(list);
          if (!global) {
            var key = id + '|' + scope + '|' + scenario + '|fallback', add = el('div', 'fallback-add');
            var n = tempInput(label + ' 添加回退', key, false); n.setAttribute('list', 'project-route-choices'); n.placeholder = '提供方,模型';
            function submit() {
              var result = controller.addFallback(id, scope, scenario, n.value); localError = result.ok ? '' : result.message;
              if (result.ok) { buffers.delete(key); currentSignature = null; } render();
            }
            n.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
            add.appendChild(n); add.appendChild(button('添加', submit)); card.appendChild(add);
          }
          grid.appendChild(card);
        }); body.appendChild(grid);
      }
      function routeInput(label, value, field) {
        var n = hintWhen(global, input(label, value, function (v) { controller.setTarget(id, scope, field, v); }, global, id + '|' + scope + '|' + field));
        n.setAttribute('list', 'project-route-choices'); n.placeholder = '提供方,模型（留空清除）';
        refs.push({ node: n, scope: scope, field: field }); return n;
      }
      updateActions(s, p, d, busy);
      body.scrollTop = scroll;
      if (focusKey) {
        var node = Array.prototype.find.call(body.querySelectorAll('[data-project-input]'), function (n) { return n.dataset.projectInput === focusKey; });
        if (node && !node.disabled) {
          node.focus();
          try { node.setSelectionRange(selectionStart, selectionEnd); } catch (_) { /* Number inputs do not support text selection. */ }
        }
      }
    }
    function updateActions(s, p, d, busy) {
      if (!s || !p) return;
      var dirty = body.querySelector('.project-dirty');
      if (dirty) dirty.textContent = s.isClean(p.id) ? '已同步' : '未保存';
      var save = body.querySelector('.project-save'), apply = body.querySelector('.project-apply');
      if (save) { save.disabled = busy || !s.isRouterDirty(p.id); save.textContent = s.pending && s.pending.kind === 'save' && s.pending.id === p.id ? '保存中…' : '保存项目路由'; }
      if (apply) apply.disabled = busy || sameSet(d ? d.clients : p.takeoverClients, p.takeoverClients);
    }
    refresh.addEventListener('click', function () { if (controller) { localError = ''; controller.refresh(); } });
    picker.addEventListener('change', function () { if (controller) { localError = ''; controller.select(picker.value); } });
    if (controller) controller.subscribe(render);
    render();
  }

  var ProjectsUI = {
    PROJECT_SCENARIOS: PROJECT_SCENARIOS, PROJECT_FAMILIES: PROJECT_FAMILIES,
    PROJECT_FLAGS: PROJECT_FLAGS, FAMILY_FLAGS: FAMILY_FLAGS, PROJECT_THRESHOLDS: PROJECT_THRESHOLDS,
    THRESHOLD_LABELS: THRESHOLD_LABELS, TAKEOVER_CLIENTS: TAKEOVER_CLIENTS, TAKEOVER_IDS: TAKEOVER_IDS,
    STALE_MSG: STALE_MSG,
    normalizeRouter: normalizeRouter, normalizeProjectsSnapshot: normalizeProjectsSnapshot,
    saveProjection: saveProjection, validateRouterChange: validateRouterChange, thresholdValue: thresholdValue,
    availableChoices: availableChoices, routerEq: routerEq, canonicalJson: canonicalJson,
    sameSet: sameSet, isAbsolutePath: isAbsolutePath, clone: clone,
    mount: mount, createProjectsController: createProjectsController, createPreviewProjects: createPreviewProjects,
  };
  if (typeof globalThis !== 'undefined') globalThis.ProjectsUI = ProjectsUI;
})();