// Shared by the project and global routing forms. Searches never edit a route.
(function () {
  var sequence = 0;
  var refreshers = new WeakMap();
  function refresh(root) {
    root.querySelectorAll('.model-picker').forEach(function (picker) {
      var update = refreshers.get(picker);
      if (update) update();
    });
  }
  function mount(field, choices, commit) {
    var doc = document;
    function element(tag, cls) { var n = doc.createElement(tag); n.className = cls; return n; }
    var wrap = element('div', 'model-picker');
    wrap.appendChild(field);
    if (field.disabled) return wrap;
    var label = field.getAttribute('aria-label') || '供应商和模型';
    var panel = element('div', 'model-picker-panel');
    var search = element('input', 'route-input');
    var list = element('div', 'model-picker-list');
    var listId = 'route-model-options-' + (++sequence);
    list.id = listId;
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', label);
    search.type = 'search'; search.placeholder = '搜索供应商或模型';
    search.setAttribute('role', 'combobox');
    search.setAttribute('aria-label', search.placeholder);
    search.setAttribute('aria-autocomplete', 'list');
    search.setAttribute('aria-controls', listId);
    search.setAttribute('autocomplete', 'off');
    field.readOnly = true;
    field.setAttribute('role', 'button');
    field.setAttribute('aria-haspopup', 'listbox');
    field.setAttribute('aria-expanded', 'false');
    panel.hidden = true;
    panel.appendChild(search); panel.appendChild(list); wrap.appendChild(panel);
    var matches = [], active = -1;
    function close(restore) {
      panel.hidden = true;
      field.setAttribute('aria-expanded', 'false');
      search.setAttribute('aria-expanded', 'false');
      search.removeAttribute('aria-activedescendant');
      if (restore) field.focus();
    }
    function choose(value) {
      if (panel.hidden) return;
      if (value && !choices().includes(value)) { render(); return; }
      close(true);
      field.value = value;
      commit(value);
    }
    function highlight(index) {
      if (active >= 0 && list.children[active]) list.children[active].setAttribute('aria-selected', 'false');
      active = index;
      if (index < 0) { search.removeAttribute('aria-activedescendant'); return; }
      var option = list.children[index];
      option.setAttribute('aria-selected', 'true');
      search.setAttribute('aria-activedescendant', option.id);
      if (option.scrollIntoView) option.scrollIntoView({block: 'nearest'});
    }
    function render() {
      var q = search.value.trim().toLowerCase();
      matches = choices().filter(function (v) { return v.toLowerCase().includes(q); });
      if (!q && field.value) matches.unshift('');
      list.textContent = ''; active = -1;
      matches.forEach(function (value, index) {
        var item = element('div', 'model-picker-option');
        item.id = listId + '-' + index;
        item.setAttribute('role', 'option');
        item.textContent = value || '清除选择';
        item.addEventListener('mousedown', function (e) { e.preventDefault(); });
        item.addEventListener('click', function () { choose(value); });
        list.appendChild(item);
      });
      if (!matches.length) { var empty = element('div', 'hint'); empty.textContent = '没有匹配的供应商或模型'; list.appendChild(empty); }
      var current = matches.indexOf(field.value);
      highlight(current >= 0 ? current : (matches.length ? 0 : -1));
    }
    refreshers.set(wrap, function () {
      if (panel.hidden) return;
      var previous = matches[active];
      render();
      highlight(matches.indexOf(previous));
    });
    function open() {
      search.value = ''; panel.hidden = false;
      field.setAttribute('aria-expanded', 'true'); search.setAttribute('aria-expanded', 'true');
      search.focus(); render();
    }
    field.addEventListener('click', open);
    field.addEventListener('keydown', function (e) {
      if (e.isComposing || e.keyCode === 229) return;
      if (['Enter', ' ', 'ArrowDown'].includes(e.key)) { e.preventDefault(); open(); }
    });
    search.addEventListener('input', render);
    search.addEventListener('keydown', function (e) {
      if (e.isComposing || e.keyCode === 229) { e.stopPropagation(); return; }
      if (e.key === 'Escape' || e.key === 'Enter') {
        e.preventDefault(); e.stopPropagation();
        if (e.key === 'Escape') close(true);
        else if (active >= 0) choose(matches[active]);
      } else if (matches.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        var next = e.key === 'ArrowDown' ? active + 1 : (active < 0 ? -1 : active - 1);
        highlight((next + matches.length) % matches.length);
      }
    });
    wrap.addEventListener('keydown', function (e) {
      if (panel.hidden || e.key !== 'Escape') return;
      e.stopPropagation();
      if (e.isComposing || e.keyCode === 229) return;
      e.preventDefault(); close(true);
    });
    wrap.addEventListener('focusout', function (e) { if (!e.relatedTarget || !wrap.contains(e.relatedTarget)) close(false); });
    return wrap;
  }
  globalThis.RouteModelPicker = { mount: mount, refresh: refresh };
})();
