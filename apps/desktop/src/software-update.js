(function () {
  'use strict';

  const AUTO_KEY = 'ccr.desktop.update.autoCheck';
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  const EVENT = 'desktop-update-progress';
  const WARNING = '更新会短暂中断桌面托管的网关。请等进行中的请求结束后再更新。';
  const messages = new Map([
    ['UPDATE_FEED_UNAVAILABLE', '当前发布尚未提供桌面更新清单，请稍后重新检查。'],
    ['UPDATE_CHECK_FAILED', '检查更新失败，请检查网络连接后重试。'],
    ['UPDATE_DOWNLOAD_FAILED', '下载失败，请检查网络连接，重新检查更新后再试。'],
    ['UPDATE_INSTALL_FAILED', '安装失败，请重新检查更新后再试。'],
    ['UPDATE_SIGNATURE_INVALID', '更新包签名无效，已取消安装。请稍后重新检查。'],
    ['UPDATE_VERSION_CHANGED', '可安装版本已变化，请重新检查更新。'],
    ['UPDATE_BUSY', '已有更新操作在进行，请稍后重新检查。'],
    ['UPDATE_UNSUPPORTED', '此平台或安装方式暂不支持应用内更新。'],
  ]);

  function mount(doc, api) {
    const id = name => doc.getElementById(name);
    const checkButton = id('update-check'), toggle = id('update-auto');
    const installButton = id('update-install'), noticeButton = id('update-notice-install');
    const meter = id('update-progress'), notes = id('update-notes');
    let supported = null, offer = null, settingsOpen = false, phase = 'idle';
    let notice = false, message = '', error = false, percent = null, timer = null;
    let automatic = true;
    try { automatic = window.localStorage.getItem(AUTO_KEY) !== 'false'; }
    catch { automatic = false; id('update-pref-error').textContent = '无法读取自动检查偏好，可手动检查更新。'; }

    function locked() { return ['status', 'checking', 'downloading', 'installing', 'done'].includes(phase); }
    function render() {
      const canInstall = Boolean(offer) && phase === 'available';
      id('update-card').hidden = false;
      checkButton.disabled = supported === false || locked();
      toggle.checked = automatic;
      toggle.disabled = supported !== true;
      id('update-pref-error').hidden = !id('update-pref-error').textContent;
      id('update-status').textContent = id('update-notice-status').textContent = message;
      id('update-status').dataset.tone = error ? 'error' : '';
      id('update-install-row').hidden = !offer;
      installButton.disabled = !canInstall;
      noticeButton.disabled = !canInstall && checkButton.disabled;
      noticeButton.textContent = offer ? '立即更新' : '重新检查';
      id('update-warning').textContent = id('update-notice-warning').textContent = offer ? WARNING : '';
      id('update-notice').hidden = !notice || settingsOpen;
      id('tab-settings-update').hidden = !notice;
      meter.hidden = phase !== 'downloading';
      if (percent === null) meter.removeAttribute('value'); else meter.setAttribute('value', String(percent));
    }

    function setOffer(next) {
      offer = next;
      notes.hidden = !next?.notes;
      id('update-notes-body').textContent = next?.notes || '';
    }
    function failure(cause, fallback) {
      const code = typeof cause === 'string' ? cause : cause?.message;
      if (code === 'UPDATE_UNSUPPORTED') supported = false;
      // Native installation consumes the checked candidate even when the download fails.
      setOffer(null);
      phase = code === 'UPDATE_BUSY' ? 'busy' : 'error';
      error = true;
      message = messages.get(code) || fallback;
      if (supported === false) notice = false;
      render();
    }
    async function check() {
      if (locked() || supported === false) return;
      if (supported === null) {
        if (!await readStatus()) return;
        scheduleChecks();
      }
      phase = 'checking'; error = false; message = '正在检查更新…';
      render();
      try {
        const answer = await api.invoke('desktop_update_check');
        if (!answer || (answer.version !== null && !(typeof answer.version === 'string' && answer.version.trim())) ||
            (answer.notes !== null && typeof answer.notes !== 'string')) throw new Error();
        setOffer(answer.version ? answer : null);
        phase = offer ? 'available' : 'latest';
        notice = Boolean(offer);
        message = offer ? '发现新版本 ' + offer.version : '已是最新版本';
        render();
      } catch (cause) { failure(cause, '无法确认最新版本，请重新检查。'); }
    }
    function progress({ payload }) {
      if (!['downloading', 'installing', 'busy'].includes(phase) || !payload) return;
      if (payload.phase === 'installing') {
        phase = 'installing'; message = '正在安装更新…';
      } else if (payload.phase === 'downloading' && phase !== 'installing') {
        phase = 'downloading';
        const downloaded = Number.isFinite(payload.downloaded) && payload.downloaded >= 0 ? payload.downloaded : 0;
        percent = Number.isFinite(payload.total) && payload.total > 0
          ? Math.min(100, Math.floor(downloaded / payload.total * 100)) : null;
        message = percent !== null ? '正在下载更新… ' + percent + '%'
          : '正在下载更新… 已下载 ' + (downloaded / 1048576).toFixed(1) + ' MB';
      } else return;
      error = false;
      render();
    }
    async function install() {
      if (phase !== 'available' || !offer) return;
      const version = offer.version;
      phase = 'downloading'; percent = null; error = false; message = '正在下载更新…';
      render();
      let unlisten;
      try {
        // Register before invoking install so the first native progress event is observed.
        unlisten = await api.listen(EVENT, progress, { target: { kind: 'WebviewWindow', label: 'main' } });
        await api.invoke('desktop_update_install', { version });
        phase = 'done'; message = '更新已交给安装程序，请等待桌面重新启动。';
        render();
      } catch (cause) {
        failure(cause, '无法完成更新，请重新检查后再试。');
        if ((cause?.message || cause) === 'UPDATE_VERSION_CHANGED') await check();
      }
      finally { if (unlisten) await Promise.resolve(unlisten()).catch(() => {}); }
    }
    async function readStatus() {
      phase = 'status'; error = false; message = '正在读取桌面版本…'; render();
      try {
        const status = await api.invoke('desktop_update_status');
        if (!status || typeof status.supported !== 'boolean' || typeof status.currentVersion !== 'string' || !status.currentVersion) throw new Error();
        id('update-current-version').textContent = status.currentVersion;
        supported = status.supported;
        phase = 'idle'; message = supported ? '尚未检查更新' : messages.get('UPDATE_UNSUPPORTED');
        render();
        return supported;
      } catch (cause) { failure(cause, '无法读取桌面版本，请点击「检查更新」重试。'); return false; }
    }
    function scheduleChecks() {
      if (timer !== null) clearInterval(timer);
      timer = automatic && supported === true ? setInterval(check, SIX_HOURS) : null;
    }
    toggle.addEventListener('change', () => {
      try {
        window.localStorage.setItem(AUTO_KEY, String(toggle.checked));
        automatic = toggle.checked;
        id('update-pref-error').textContent = '';
        scheduleChecks();
        if (automatic) check();
      } catch { id('update-pref-error').textContent = '无法保存自动检查偏好，请重试。'; }
      render();
    });
    checkButton.addEventListener('click', check);
    installButton.addEventListener('click', install);
    noticeButton.addEventListener('click', () => offer ? install() : check());
    readStatus().then(ok => { if (ok && automatic) { scheduleChecks(); check(); } });
    return { showSettings(open) { settingsOpen = open; render(); } };
  }

  function preview() {
    let listener;
    const pause = () => new Promise(resolve => setTimeout(resolve, 300));
    return {
      async listen(name, handler) { if (name === EVENT) listener = handler; return () => { listener = null; }; },
      async invoke(command) {
        if (command === 'desktop_update_status') return { currentVersion: '0.1.1', supported: true };
        if (command === 'desktop_update_check') return { version: '0.1.2', notes: '新增桌面软件更新，支持查看下载进度。' };
        if (command === 'desktop_update_install') {
          for (const downloaded of [0, 50, 100]) { await pause(); listener?.({ payload: { phase: 'downloading', downloaded, total: 100 } }); }
          listener?.({ payload: { phase: 'installing', downloaded: 100, total: 100 } });
          await pause();
        }
      },
    };
  }
  globalThis.SoftwareUpdateUI = { mount, preview };
})();
