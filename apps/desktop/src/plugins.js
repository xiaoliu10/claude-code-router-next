(function () {
  'use strict';

  var ACTION_LABELS = { sync: '同步模型', usage: '刷新用量', disconnect: '断开连接' };
  var ACTIONS = Object.keys(ACTION_LABELS);
  var CONNECTION_LABELS = { connected: '已连接', disconnected: '未连接', unknown: '未知' };
  var MANIFEST_ID = /^[a-z0-9][a-z0-9-]*$/i;
  var NPM_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
  var INSTALLED = 'installed';
  var MARKET = 'market';
  var COMMANDS = { installed: 'plugin_inventory', market: 'plugin_catalog' };

  function text(value) { return typeof value === 'string' ? value : ''; }

  function projectList(view, result) {
    if (!result || !Array.isArray(result.plugins)) throw new Error();
    var seen = new Set();
    return {
      partial: view === MARKET && result.partial === true,
      plugins: result.plugins.filter(function (row) {
        var key = row && text(view === INSTALLED ? row.id : row.name);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      }).map(function (row) {
        if (view === INSTALLED) {
          return {
            id: row.id, name: text(row.name) || row.id, version: text(row.version), loaded: row.loaded === true,
            connectionState: row.connectionState === 'connected' || row.connectionState === 'disconnected'
              ? row.connectionState : 'unknown',
            actions: row.loaded === true && MANIFEST_ID.test(row.id) && Array.isArray(row.actions)
              ? ACTIONS.filter(function (action) { return row.actions.indexOf(action) !== -1; }) : [],
          };
        }
        return {
          name: row.name, description: text(row.description), version: text(row.version),
          installed: row.installed === true || row.localOnly === true, installedVersion: text(row.installedVersion),
          installedName: text(row.installedName),
          updateAvailable: row.updateAvailable === true && row.installed === true && row.localOnly !== true && MANIFEST_ID.test(text(row.installedName)),
          localOnly: row.localOnly === true,
        };
      }),
    };
  }

  function mount(doc, invoke) {
    var installed = doc.getElementById('plugins-installed');
    var market = doc.getElementById('plugins-market');
    var advanced = doc.getElementById('plugins-advanced');
    var refreshButton = doc.getElementById('plugins-refresh');
    var list = doc.getElementById('plugins-list');
    var readStatus = doc.getElementById('plugins-read-status');
    var feedback = doc.getElementById('plugins-feedback');
    var restart = doc.getElementById('plugins-restart');
    var confirmation = doc.getElementById('plugins-confirm');
    var confirmText = doc.getElementById('plugins-confirm-text');
    var confirmButton = doc.getElementById('plugins-confirm-button');
    var cancelButton = doc.getElementById('plugins-cancel');
    var view = INSTALLED;
    var views = {
      installed: { data: null, request: null, error: '' },
      market: { data: null, request: null, error: '' },
    };
    var controls = [];
    var confirm = null;
    var pending = false;
    // Install uses a catalog name, while inventory is keyed by manifest ID.
    var awaitingActivation = new Map();
    var service = null;
    var startingForActivation = false;
    var lastServiceAction = null;

    function el(tag, cls, value) {
      var node = doc.createElement(tag);
      node.className = cls;
      if (value) node.textContent = value;
      return node;
    }

    function status(node, message, tone) {
      if (node.textContent !== message) node.textContent = message;
      node.hidden = !message;
      if (tone) node.setAttribute('data-tone', tone);
      else node.removeAttribute('data-tone');
    }

    function renderRestart() {
      var message = '';
      if (awaitingActivation.size) {
        if (service && service.mode === 'external') message = '需要重启外部网关才能生效。请在原启动环境中手动重启，然后刷新已安装列表。';
        else if (service && service.mode === 'owned' && service.running) message = '需要重启托管网关才能生效。请在上方服务栏手动点击「停止」，再点击「启动」。';
        else if (service && (service.mode === 'stopped' || service.mode === 'error')) message = '插件变更将在网关启动后生效。请在上方服务栏手动点击「启动」。';
        else message = '需要在下次启动或重启网关后生效。请先查看上方服务状态。';
        message = awaitingActivation.size + ' 个插件变更待激活。' + message;
      }
      status(restart, message, 'warn');
    }

    function addControl(container, label, cardName, request) {
      var button = el('button', 'btn', label);
      button.type = 'button';
      button.setAttribute('aria-label', label + ' ' + cardName);
      button.addEventListener('click', function () {
        if (pending || confirm || views[view].request || views[view].error) return;
        request.origin = button;
        if (request.cmd === 'plugin_install' || request.args.action === 'disconnect') {
          confirm = request;
          confirmText.textContent = request.cmd === 'plugin_install'
            ? '确认' + label + '「' + cardName + '@' + request.args.version + '」？插件将在网关中运行，可能需要手动重启才能生效。'
            : '确认断开「' + cardName + '」？断开后通过此插件接入的服务可能不可用。';
          confirmButton.textContent = '确认' + label;
          renderStatus();
          cancelButton.focus();
        } else perform(request);
      });
      controls.push(button);
      container.appendChild(button);
    }

    function renderList() {
      var current = views[view];
      list.textContent = '';
      controls = [];
      if (!current.data) return;
      current.data.plugins.forEach(function (plugin) {
        var card = el('li', 'card');
        var title = el('div', 'plugins-card-title');
        var installedView = view === INSTALLED;
        var awaiting = !installedView && awaitingActivation.get(plugin.name);
        var label = installedView ? (plugin.loaded ? '已加载' : '未加载')
          : (plugin.localOnly ? '仅本地' : plugin.updateAvailable ? '有更新' : plugin.installed ? '已安装' : '未安装');
        title.appendChild(el('span', 'card-name', plugin.name));
        title.appendChild(el('span', awaiting ? 'badge badge-stale' : 'badge', awaiting ? awaiting.label : label));
        card.appendChild(title);
        var version = (installedView && plugin.loaded ? '已加载版本：' : '版本：') + (plugin.version || '未知');
        if (!installedView && plugin.installed) {
          version = '已安装版本：' + (plugin.installedVersion || '未知');
          if (!plugin.localOnly) version += ' · 市场版本：' + (plugin.version || '未知');
        }
        card.appendChild(el('p', 'card-message', version));
        if (!installedView && plugin.description) card.appendChild(el('p', 'card-message', plugin.description));
        var actions = el('div', 'plugins-actions');
        if (installedView) {
          card.appendChild(el('p', 'card-message', '连接状态：' + CONNECTION_LABELS[plugin.connectionState]));
          plugin.actions.forEach(function (action) {
            addControl(actions, ACTION_LABELS[action], plugin.name, {
              cmd: 'plugin_action', args: { id: plugin.id, action: action }, label: ACTION_LABELS[action],
            });
          });
          if (!plugin.actions.length) card.appendChild(el('p', 'card-message',
            plugin.loaded ? '此插件没有可在桌面使用的基础操作。' : '加载后才可使用此插件。'));
        } else if (!awaiting && !plugin.localOnly && NPM_NAME.test(plugin.name) && (!plugin.installed || plugin.updateAvailable)) {
          var verb = plugin.installed ? '更新' : '安装';
          addControl(actions, verb, plugin.name, {
            cmd: 'plugin_install', args: { name: plugin.name, version: plugin.version,
              installed: plugin.installed ? { name: plugin.installedName, version: plugin.installedVersion } : null }, label: verb,
          });
        }
        if (actions.children.length) card.appendChild(actions);
        list.appendChild(card);
      });
      if (current.data.plugins.length) return;
      var empty = view === INSTALLED ? '暂无已安装的插件。可前往插件市场查看。'
        : current.data.partial ? '当前没有可显示的插件。请稍后刷新市场，或查看已安装插件。'
          : '插件市场暂无插件。';
      list.appendChild(el('li', 'empty', empty));
    }

    function renderStatus() {
      var current = views[view];
      var message = '', tone;
      if (!invoke) { message = '无法访问桌面服务，插件列表不可用。'; tone = 'error'; }
      else if (current.request) message = '正在读取' + (view === INSTALLED ? '已安装插件' : '插件市场') + '…';
      else if (current.error) {
        message = current.error;
        tone = 'error';
      } else if (current.data && current.data.partial) {
        message = '无法获取完整的注册表数据。当前显示可用结果；可刷新重试或查看已安装插件。'; tone = 'warn';
      }
      status(readStatus, message, tone);
      refreshButton.disabled = !invoke || !!current.request || pending || !!confirm;
      installed.disabled = market.disabled = pending;
      installed.setAttribute('aria-pressed', String(view === INSTALLED));
      market.setAttribute('aria-pressed', String(view === MARKET));
      advanced.hidden = view !== INSTALLED;
      list.setAttribute('aria-label', view === INSTALLED ? '已安装插件列表' : '插件市场列表');
      list.setAttribute('aria-busy', String(!!current.request || pending));
      confirmation.hidden = confirm === null;
      controls.forEach(function (button) { button.disabled = !!current.request || !!current.error || pending || !!confirm; });
    }

    async function refresh(targetView, supersede) {
      var target = views[targetView];
      if (!invoke || (target.request && !supersede)) return;
      var request = {};
      target.request = request;
      renderStatus();
      try {
        var data = projectList(targetView, await invoke(COMMANDS[targetView]));
        if (target.request !== request) return;
        target.data = data;
        target.error = '';
        if (targetView === INSTALLED) {
          awaitingActivation.forEach(function (expected, name) {
            if (data.plugins.some(function (p) { return p.loaded && p.id === expected.id && p.version === expected.version; })) {
              awaitingActivation.delete(name);
            }
          });
          renderRestart();
          if (view === MARKET) renderList();
        }
      } catch {
        if (target.request !== request) return;
        target.error = targetView === INSTALLED ? '无法读取已安装插件。' : '无法读取插件市场。';
        target.error += target.data ? '下方为上次读取的结果，请刷新后再操作。' : '请检查网关状态后刷新。';
      }
      target.request = null;
      if (targetView === view) renderList();
      renderStatus();
    }

    function cancel(restoreFocus) {
      if (!confirm) return false;
      var origin = confirm.origin;
      confirm = null;
      renderStatus();
      if (restoreFocus) origin.focus();
      return true;
    }

    async function perform(request) {
      var install = request.cmd === 'plugin_install';
      pending = true;
      confirm = null;
      list.focus();
      renderStatus();
      status(feedback, '正在' + request.label + '…');
      try {
        var result = await invoke(request.cmd, request.args);
        if (install) {
          if (!result || typeof result.restartRequired !== 'boolean') throw new Error();
          if (result.restartRequired) {
            if (!MANIFEST_ID.test(text(result.id)) || result.version !== request.args.version) throw new Error();
            awaitingActivation.set(request.args.name, { id: result.id, version: result.version,
              label: request.args.installed ? '已更新 · 待激活' : '已安装 · 待激活' });
            startingForActivation = false;
            if (view === MARKET) renderList();
          }
          renderRestart();
          status(feedback, request.label + (result.restartRequired ? '完成，等待激活。' : '完成。'));
          await Promise.all([refresh(INSTALLED, true), refresh(MARKET)]);
        } else if (request.args.action === 'usage') {
          if (result && result.usage === 'fresh') status(feedback, '已获取当前用量。');
          else if (result && result.usage === 'stale') status(feedback, '当前仅有上次读取的用量。', 'warn');
          else status(feedback, '暂无可用的用量数据。', 'warn');
        } else {
          if (!result || result.success !== true) throw new Error();
          status(feedback, request.label + '完成。');
          await refresh(INSTALLED);
        }
      } catch {
        if (install) {
          views[MARKET].error = '无法确认' + request.label + '结果。请刷新后再试。';
          status(feedback, '');
        } else status(feedback, request.label + '失败。请检查插件的连接状态后重试。', 'error');
      }
      pending = false;
      renderStatus();
    }

    function select(targetView) {
      if (pending || targetView === view) return;
      cancel(false);
      view = targetView;
      status(feedback, '');
      renderList();
      renderStatus();
      if (!views[view].data && !views[view].error) refresh(view);
    }

    installed.addEventListener('click', function () { select(INSTALLED); });
    market.addEventListener('click', function () { select(MARKET); });
    refreshButton.addEventListener('click', function () {
      if (pending || confirm) return;
      status(feedback, '');
      refresh(view);
    });
    cancelButton.addEventListener('click', function () { cancel(true); });
    confirmButton.addEventListener('click', function () {
      if (confirm && !pending) perform(confirm);
    });
    renderStatus();

    return {
      load: function () { refresh(INSTALLED); },
      cancel: cancel,
      serviceChanged: function (state) {
        service = state.service;
        if (state.pending === 'start' && lastServiceAction !== 'start') startingForActivation = awaitingActivation.size > 0;
        lastServiceAction = state.pending;
        if (startingForActivation && !state.pending && !state.loading) {
          if (!state.error && service && service.mode === 'owned' && service.running) {
            startingForActivation = false;
            status(feedback, '托管网关已启动。请在已安装列表核对插件的加载状态。');
            if (view === MARKET) { renderList(); renderStatus(); }
            refresh(INSTALLED, true);
          } else if (state.error || !service || service.mode !== 'starting') startingForActivation = false;
        }
        renderRestart();
      },
    };
  }

  // Browser preview uses the same DTOs and mutations entirely in memory.
  function createPreviewPlugins(delay) {
    var inventory = [
      { id: 'codex', name: 'Codex', version: '1.0.0', loaded: true, actions: ['sync', 'usage', 'disconnect'], connectionState: 'connected' },
      { id: 'workbuddy', name: 'WorkBuddy', version: '1.0.0', loaded: true, actions: [], connectionState: 'unknown' },
      { id: 'local-example', name: 'local-example', version: '0.1.0', loaded: false, actions: [] },
    ];
    var catalog = [
      { id: 'codex', name: '@wengine-ai/ccr-provider-codex', description: 'Codex 模型与用量支持', version: '1.1.0', installed: true, installedVersion: '1.0.0', updateAvailable: true, localOnly: false },
      { id: 'gemini-oauth', name: '@wengine-ai/ccr-provider-gemini-oauth', description: 'Gemini OAuth 模型支持', version: '1.0.0', installed: false, installedVersion: null, updateAvailable: false, localOnly: false },
      { id: 'local-example', name: 'local-example', description: '', version: '0.1.0', installed: true, installedVersion: '0.1.0', updateAvailable: false, localOnly: true },
      { id: 'workbuddy', name: '@wengine-ai/ccr-provider-workbuddy', description: 'WorkBuddy 模型支持', version: '1.0.0', installed: true, installedVersion: '1.0.0', updateAvailable: false, localOnly: false },
    ];
    var awaitingLoad = new Set();
    return {
      invoke: function (cmd, args) {
        if (cmd === 'plugin_inventory') return delay({ plugins: inventory });
        if (cmd === 'plugin_catalog') {
          return delay({ partial: true, plugins: catalog.map(function (row) {
            return { name: row.name, description: row.description, version: row.version, installed: row.installed,
              installedVersion: row.installedVersion, ...(row.installed && !row.localOnly ? { installedName: row.id } : {}), updateAvailable: row.updateAvailable, localOnly: row.localOnly };
          }) });
        }
        if (cmd === 'plugin_install') {
          var entry = catalog.find(function (row) { return row.name === args.name; });
          if (entry && !entry.localOnly && entry.version === args.version && (entry.installed
              ? args.installed && args.installed.name === entry.id && args.installed.version === entry.installedVersion && entry.updateAvailable
              : args.installed === null)) {
            entry.installed = true;
            entry.installedVersion = entry.version;
            entry.updateAvailable = false;
            if (!inventory.some(function (row) { return row.id === entry.id; })) {
              inventory.push({ id: entry.id, name: 'Gemini OAuth', version: entry.version, loaded: false, actions: [] });
            }
            awaitingLoad.add(entry.id);
            return delay({ restartRequired: true, id: entry.id, version: entry.version });
          }
          return Promise.reject(new Error('PLUGIN_INSTALL_FAILED'));
        }
        if (cmd === 'plugin_action') {
          var plugin = inventory.find(function (row) { return row.id === args.id; });
          if (!plugin || !plugin.loaded || plugin.actions.indexOf(args.action) === -1) {
            return Promise.reject(new Error('PLUGIN_ACTION_FAILED'));
          }
          if (args.action === 'usage') return delay({ usage: 'fresh' });
          if (args.action === 'disconnect') {
            plugin.actions = [];
            plugin.connectionState = 'disconnected';
          }
          return delay({ success: true });
        }
        return Promise.resolve(null);
      },
      start: function () {
        inventory.forEach(function (row) {
          if (!awaitingLoad.has(row.id)) return;
          row.version = catalog.find(function (entry) { return entry.id === row.id; }).version;
          row.loaded = true;
          if (row.id === 'gemini-oauth') {
            row.actions = ['sync', 'disconnect'];
            row.connectionState = 'disconnected';
          }
        });
        awaitingLoad.clear();
      },
    };
  }

  globalThis.PluginsUI = { mount: mount, createPreviewPlugins: createPreviewPlugins };
})();
