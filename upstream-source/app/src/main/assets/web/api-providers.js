/* Provider settings use the Android bridge. Credentials never enter web storage. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const element = (tag, text, className) => {
    const result = document.createElement(tag);
    if (text != null) result.textContent = text;
    if (className) result.className = className;
    return result;
  };
  let call, refresh, toast, installed = false, busy = false;
  let profiles = [], active = '', editing = '', discovered = [], selected = new Set();
  function status(message = '', error = false) {
    $('api-status').textContent = message;
    $('api-status').classList.toggle('api-error', error);
  }
  function errorMessage(error) {
    const message = String(error?.message || '').trim();
    return message && message.length <= 240 && !/[\r\n<>]/.test(message)
      && !/(?:bearer\s|sk-|api[_-]?key\s*[:=])/i.test(message)
      ? message : '操作失败，请检查服务商配置后重试。';
  }
  function setBusy(value) {
    busy = value;
    const panel = document.querySelector('[data-settings-panel="providers"]');
    panel.setAttribute('aria-busy', String(value));
    panel.querySelectorAll('input, textarea, button').forEach(control => {
      control.disabled = value || control.dataset.inactive === 'true';
    });
  }
  async function perform(operation) {
    if (busy) return false;
    setBusy(true);
    try { await operation(); return true; }
    catch (error) { const message = errorMessage(error); status(message, true); toast(message); return false; }
    finally { setBusy(false); }
  }
  function button(text, action, inactive = false) {
    const result = element('button', text, 'secondary-button');
    result.type = 'button'; result.dataset.inactive = String(inactive); result.disabled = busy || inactive;
    result.addEventListener('click', () => { if (!busy) action(); });
    return result;
  }
  function resetDiscovery() {
    discovered = []; selected.clear();
    $('api-discovery').hidden = true;
    $('api-discovery-results').replaceChildren();
  }
  function clear() {
    editing = ''; $('api-form').reset(); $('api-key').required = true;
    $('api-editor-heading').textContent = '添加服务商';
    $('api-key-note').textContent = '密钥加密保存在此设备，不会再次显示。';
    $('api-cancel').hidden = true; resetDiscovery();
  }
  function edit(profile) {
    editing = profile.id; $('api-name').value = profile.name; $('api-url').value = profile.baseUrl;
    $('api-models').value = profile.models.join('\n'); $('api-key').value = ''; $('api-key').required = false;
    $('api-key-note').textContent = '留空保留已保存的密钥，填写则替换。';
    $('api-editor-heading').textContent = '编辑服务商'; $('api-cancel').hidden = false;
    resetDiscovery(); status(); $('api-name').focus();
  }
  async function select(id) {
    await perform(async () => {
      status(id ? '正在切换服务商…' : '正在停用 API…');
      await call('providers.select', {id}); await refresh();
      status(id ? '已启用，将使用此服务商开始新对话。' : 'API 已停用。选择服务商后可继续对话。');
    });
  }
  function draw() {
    const list = $('api-profiles'); list.replaceChildren();
    for (const profile of profiles) {
      const current = profile.id === active;
      const card = element('article', null, 'api-card');
      const heading = element('div', null, 'api-card-heading');
      heading.append(element('strong', profile.name));
      if (current) heading.append(element('span', '使用中', 'status-pill'));
      card.append(heading, element('p', profile.baseUrl, 'api-meta'),
        element('p', profile.models.join(' · '), 'api-model-summary'),
        element('small', profile.hasKey ? '密钥已加密保存' : '尚未设置密钥', 'muted'));
      const actions = element('div', null, 'api-buttons');
      actions.append(button(current ? '停用' : '启用', () => select(current ? '' : profile.id)),
        button('编辑', () => edit(profile)), button('删除', async () => {
          if (!window.confirm('删除“' + profile.name + '”及其密钥？本地对话记录会保留。')) return;
          await perform(async () => {
            await call('providers.remove', {id:profile.id}); await refresh();
            if (editing === profile.id) clear();
            status('服务商已删除。');
          });
        }));
      card.append(actions); list.append(card);
    }
    if (!profiles.length) list.append(element('p', '添加 API 服务商，即可开始使用。', 'muted'));
    const current = profiles.find(profile => profile.id === active);
    $('api-current').textContent = current ? '当前服务商：' + current.name : '尚未启用 API';
    setBusy(busy);
  }
  function renderDiscovery() {
    const query = $('api-filter').value.toLowerCase().trim();
    const box = $('api-discovery-results'); box.replaceChildren(); $('api-discovery').hidden = false;
    $('api-discovery-count').textContent = '找到 ' + discovered.length + ' 个模型 · 已选 ' + selected.size + ' / 150';
    const matching = discovered.filter(id => id.toLowerCase().includes(query));
    for (const id of matching) {
      const row = element('label', null, 'api-model-row'), checkbox = element('input');
      checkbox.type = 'checkbox'; checkbox.checked = selected.has(id);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked && selected.size >= 150) { checkbox.checked = false; status('最多可选择 150 个模型。', true); return; }
        if (checkbox.checked) selected.add(id); else selected.delete(id);
        $('api-discovery-count').textContent = '找到 ' + discovered.length + ' 个模型 · 已选 ' + selected.size + ' / 150';
      });
      row.append(checkbox, element('span', id)); box.append(row);
    }
    if (!matching.length) box.append(element('p', '没有匹配的模型。', 'muted'));
  }
  const modelIds = () => $('api-models').value.split(/[\r\n,]/).map(id => id.trim()).filter(Boolean);
  async function scan() {
    const baseUrl = $('api-url').value.trim(), apiKey = $('api-key').value;
    if (!baseUrl || (!editing && !apiKey.trim())) { status('请先填写接口地址和密钥。', true); return; }
    await perform(async () => {
      status('正在读取模型列表…'); resetDiscovery();
      const data = await call('providers.discover', {id:editing, baseUrl, apiKey});
      discovered = [...new Set((Array.isArray(data.models) ? data.models : []).filter(id => typeof id === 'string'))];
      const existing = new Set(modelIds()); selected = new Set(discovered.filter(id => existing.has(id)).slice(0, 150));
      $('api-filter').value = ''; renderDiscovery();
      status(discovered.length ? '请选择要添加的模型。模型列表不代表已通过对话和工具调用测试。' : '服务商未返回模型，可手动填写模型 ID。');
    });
  }
  async function save(event) {
    event.preventDefault();
    await perform(async () => {
      status('正在保存…');
      const result = await call('providers.save', {id:editing, name:$('api-name').value.trim(),
        baseUrl:$('api-url').value.trim(), models:$('api-models').value, apiKey:$('api-key').value, protocol:'responses'});
      $('api-key').value = '';
      const id = result?.id || editing;
      if (!id) { await refresh(); throw new Error('已保存，请在列表中启用服务商。'); }
      try { await call('providers.select', {id}); }
      catch (error) {
        await refresh(); clear(); status('已保存，启用失败：' + errorMessage(error), true); return;
      }
      await refresh(); clear(); status('已保存并启用，可以开始新对话。');
    });
    $('api-key').value = '';
  }
  function init(options) {
    if (installed) return;
    call = options.call; refresh = options.refresh; toast = options.toast;
    const nav = document.querySelector('.settings-nav'), content = document.querySelector('.settings-content');
    if (!nav || !content) return;
    const tab = element('button', '模型 API'); tab.type = 'button'; tab.dataset.settingsTab = 'providers';
    nav.insertBefore(tab, nav.firstChild);
    const panel = element('section', null, 'settings-section'); panel.dataset.settingsPanel = 'providers'; panel.hidden = true;
    panel.innerHTML = `<h3>模型 API</h3>
      <p class="muted" id="api-current"></p><p id="api-migration" class="muted api-error" role="status" hidden></p><div id="api-profiles"></div>
      <form id="api-form" class="api-form" autocomplete="off">
        <h4 id="api-editor-heading">添加服务商</h4>
        <label for="api-name">服务商名称</label><input id="api-name" class="text-input" maxlength="60" required placeholder="自定义名称">
        <label for="api-url">接口地址</label><input id="api-url" class="text-input" type="url" maxlength="512" required spellcheck="false" autocapitalize="off" placeholder="https://api.example.com/v1">
        <small class="muted">支持 HTTPS 的 Responses 协议，地址按服务商说明填写。</small>
        <label for="api-key">API Key</label><input id="api-key" class="text-input" type="password" maxlength="4096" required autocomplete="new-password" spellcheck="false" autocapitalize="off">
        <small id="api-key-note" class="muted"></small>
        <label for="api-models">模型 ID（每行一个）</label><textarea id="api-models" class="text-input" rows="3" required spellcheck="false" autocapitalize="off" placeholder="填写服务商提供的模型 ID"></textarea>
        <button id="api-scan" class="secondary-button" type="button">获取模型列表</button>
        <div id="api-discovery" class="api-discovery" hidden>
          <label for="api-filter">搜索模型</label><input id="api-filter" class="text-input" type="search" placeholder="搜索模型 ID">
          <small id="api-discovery-count" class="muted"></small>
          <div class="api-buttons"><button id="api-select-all" class="secondary-button" type="button">选择筛选结果</button><button id="api-select-none" class="secondary-button" type="button">取消选择</button></div>
          <div id="api-discovery-results" class="api-discovery-results" role="group" aria-label="可用模型"></div>
          <button id="api-add-selected" class="secondary-button" type="button">添加选中模型</button>
        </div>
        <div class="api-buttons"><button id="api-save" class="primary-button" type="submit">保存并启用</button><button id="api-cancel" class="secondary-button" type="button" hidden>取消编辑</button></div>
        <p id="api-status" class="muted" role="status" aria-live="polite"></p>
      </form>`;
    content.append(panel);
    $('api-form').addEventListener('submit', save);
    $('api-cancel').addEventListener('click', () => { clear(); status(); });
    $('api-scan').addEventListener('click', scan);
    $('api-filter').addEventListener('input', renderDiscovery);
    ['api-url','api-key'].forEach(id => $(id).addEventListener('input', resetDiscovery));
    $('api-url').addEventListener('input', () => {
      const profile = profiles.find(profile => profile.id === editing);
      const changed = !!profile && $('api-url').value.trim().replace(/\/+$/, '') !== profile.baseUrl;
      $('api-key').required = !editing || changed;
      $('api-key-note').textContent = changed ? '接口地址已更改，请重新填写此地址的密钥。'
        : editing ? '留空保留已保存的密钥，填写则替换。' : '密钥加密保存在此设备，不会再次显示。';
    });
    $('api-select-none').addEventListener('click', () => { selected.clear(); renderDiscovery(); });
    $('api-select-all').addEventListener('click', () => {
      const query = $('api-filter').value.toLowerCase().trim();
      for (const id of discovered.filter(id => id.toLowerCase().includes(query))) { if (selected.size >= 150) break; selected.add(id); }
      renderDiscovery();
    });
    $('api-add-selected').addEventListener('click', () => {
      if (!selected.size) { status('请先选择模型。', true); return; }
      const ids = [...new Set([...modelIds(), ...selected])];
      if (ids.length > 150) { status('最多可保存 150 个模型。', true); return; }
      $('api-models').value = ids.join('\n'); status('模型已添加，保存后生效。');
    });
    $('settings-dialog')?.addEventListener('close', () => { $('api-key').value = ''; });
    installed = true; clear(); draw();
  }
  function render(state) {
    if (!installed) return;
    $('api-migration').hidden = !state.apiMigrationError;
    $('api-migration').textContent = state.apiMigrationError ? '旧版 API 配置未能迁移，原配置已保留。请重新添加服务商。' : '';
    profiles = Array.isArray(state.apiProviders) ? state.apiProviders : [];
    active = typeof state.apiActive === 'string' ? state.apiActive : '';
    draw();
  }
  window.MobileCodexApiProviders = {init, render};
})();
