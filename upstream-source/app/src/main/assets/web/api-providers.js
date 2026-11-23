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
  let scanning = false, discoveryGeneration = 0;
  let profiles = [], active = '', editing = '', discovered = [], selected = new Set();
  let chatOnly = new Set(), publicCatalog = false;
  const previewLimit = 3;
  let expandedId = '', renderedProfiles = '', showAllProfiles = false;
  function status(message = '', error = false) {
    $('api-status').textContent = message;
    $('api-status').classList.toggle('api-error', error);
  }
  function discoveryStatus(message = '', error = false) {
    $('api-discovery-status').textContent = message;
    $('api-discovery-status').classList.toggle('api-error', error);
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
      control.disabled = value || control.dataset.inactive === 'true' || (control.id === 'api-scan' && scanning);
    });
  }
  async function perform(operation, reportError = message => { status(message, true); toast(message); }) {
    if (busy) return false;
    setBusy(true);
    try { await operation(); return true; }
    catch (error) { reportError(errorMessage(error)); return false; }
    finally { setBusy(false); }
  }
  function button(text, action, inactive = false) {
    const result = element('button', text, 'secondary-button');
    result.type = 'button'; result.dataset.inactive = String(inactive); result.disabled = busy || inactive;
    result.addEventListener('click', () => { if (!busy) action(); });
    return result;
  }
  function resetDiscovery() {
    discoveryGeneration++;
    discovered = []; selected.clear();
    chatOnly.clear(); publicCatalog = false;
    $('api-discovery').hidden = true;
    $('api-discovery-results').replaceChildren();
    discoveryStatus();
  }
  function clear() {
    editing = ''; $('api-form').reset(); $('api-key').required = true;
    $('api-import').open = false;
    $('api-editor-heading').textContent = '添加服务商';
    $('api-key-note').textContent = '密钥加密保存在此设备，不会再次显示。';
    $('api-form').hidden = true;
    $('api-new').setAttribute('aria-expanded', 'false');
    resetDiscovery();
  }
  function showEditor() {
    $('api-form').hidden = false;
    $('api-new').setAttribute('aria-expanded', 'true');
    status(); $('api-name').focus();
  }
  function edit(profile) {
    editing = profile.id; $('api-name').value = profile.name; $('api-url').value = profile.baseUrl;
    $('api-import').open = false; $('api-import-json').value = '';
    $('api-models').value = profile.models.join('\n'); $('api-key').value = ''; $('api-key').required = false;
    $('api-key-note').textContent = '留空保留已保存的密钥，填写则替换。';
    $('api-editor-heading').textContent = '编辑服务商';
    resetDiscovery(); showEditor();
  }
  async function select(id) {
    await perform(async () => {
      status(id ? '正在切换服务商…' : '正在停用 API…');
      await call('providers.select', {id}); await refresh();
      status(id ? '已启用，将使用此服务商开始新对话。' : 'API 已停用。选择服务商后可继续对话。');
    });
  }
  function draw() {
    const signature = JSON.stringify([active, profiles, showAllProfiles]);
    if (signature === renderedProfiles) return;
    renderedProfiles = signature;
    const currentProfile = profiles.find(profile => profile.id === active);
    const prioritized = currentProfile ? [currentProfile, ...profiles.filter(profile => profile !== currentProfile)] : profiles;
    const visibleProfiles = showAllProfiles ? prioritized : prioritized.slice(0, previewLimit);
    if (!visibleProfiles.some(profile => profile.id === expandedId)) expandedId = '';
    const list = $('api-profiles');
    const modelsOpen = list.querySelector('.api-card[open] .api-models')?.open === true;
    list.replaceChildren();
    const remaining = element('div', null, 'api-profiles-overflow');
    remaining.id = 'api-profiles-overflow';
    remaining.hidden = !showAllProfiles;
    for (const profile of visibleProfiles) {
      const current = profile.id === active;
      const card = element('details', null, 'api-card');
      card.open = profile.id === expandedId;
      const heading = element('summary', null, 'api-card-heading');
      const caption = element('span', null, 'api-card-caption');
      caption.append(element('strong', profile.name), element('small', `${profile.models.length} 个模型`, 'muted'));
      heading.append(caption);
      if (current) heading.append(element('span', '使用中', 'status-pill'));
      heading.addEventListener('click', event => {
        event.preventDefault();
        if (busy) return;
        expandedId = card.open ? '' : profile.id;
        for (const other of list.querySelectorAll('.api-card[open]')) if (other !== card) other.open = false;
        card.open = !!expandedId;
      });
      card.append(heading, element('p', profile.baseUrl, 'api-meta'),
        element('small', profile.hasKey ? '密钥已加密保存' : '尚未设置密钥', 'muted'));
      if (profile.models.length) {
        const models = element('details', null, 'api-models');
        models.open = card.open && modelsOpen;
        const ids = element('ul', null, 'api-model-ids');
        for (const id of profile.models) ids.append(element('li', id));
        models.append(element('summary', `查看 ${profile.models.length} 个模型 ID`), ids);
        card.append(models);
      }
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
      card.append(actions);
      (list.children.length < previewLimit ? list : remaining).append(card);
    }
    if (!profiles.length) list.append(element('p', '添加 API 服务商，即可开始使用。', 'muted'));
    if (profiles.length > previewLimit) {
      const more = button(showAllProfiles ? '收起服务商列表' : `显示其余 ${profiles.length - previewLimit} 个服务商`, () => {
        showAllProfiles = !showAllProfiles; draw();
        if (showAllProfiles) list.querySelectorAll('summary')[previewLimit]?.focus();
        else $('api-show-more')?.focus();
      });
      more.id = 'api-show-more';
      more.setAttribute('aria-controls', remaining.id);
      more.setAttribute('aria-expanded', String(showAllProfiles));
      list.append(more, remaining);
    }
    $('api-current').textContent = currentProfile ? '' : '尚未启用 API';
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
        if (checkbox.checked && selected.size >= 150) { checkbox.checked = false; discoveryStatus('最多可选择 150 个模型。', true); return; }
        if (checkbox.checked) selected.add(id); else selected.delete(id);
        $('api-discovery-count').textContent = '找到 ' + discovered.length + ' 个模型 · 已选 ' + selected.size + ' / 150';
      });
      const name = element('span', id);
      if (chatOnly.has(id)) name.append(element('small', '（价目表仅标注 Chat Completions）', 'muted'));
      row.append(checkbox, name); box.append(row);
    }
    if (!matching.length) box.append(element('p', '没有匹配的模型。', 'muted'));
  }
  const modelIds = () => $('api-models').value.split(/[\r\n,]/).map(id => id.trim()).filter(Boolean);
  function importConnection() {
    const field = $('api-import-json');
    const input = field.value.trim();
    field.value = '';
    try {
      const info = JSON.parse(input);
      if (info?._type !== 'newapi_channel_conn' || typeof info.url !== 'string' || typeof info.key !== 'string') throw new Error();
      const address = new URL(info.url.trim());
      const key = info.key.trim();
      if (address.protocol !== 'https:' || !address.hostname || address.username || address.password || address.search || address.hash
          || info.url.trim().length > 512 || !key || key.length > 4096 || /[\s\u0000-\u001f\u007f-\u009f]/u.test(key)) throw new Error();
      $('api-url').value = address.pathname === '/' ? address.origin + '/v1' : info.url.trim();
      $('api-key').value = key;
      if (!$('api-name').value.trim()) $('api-name').value = address.hostname.slice(0, 60);
      $('api-url').dispatchEvent(new Event('input'));
      $('api-import').open = false;
      discoveryStatus('已导入连接。获取模型列表，或手动填写模型 ID。');
    } catch (_) {
      discoveryStatus('连接信息格式无效。请粘贴服务商导出的 New API 连接 JSON。', true);
    }
  }
  async function scan() {
    if (busy || scanning) return;
    const baseUrl = $('api-url').value.trim(), apiKey = $('api-key').value;
    if (!baseUrl || (!editing && !apiKey.trim())) { discoveryStatus('请先填写接口地址和密钥。', true); return; }
    resetDiscovery(); discoveryStatus('正在读取模型列表…');
    const generation = discoveryGeneration;
    scanning = true; $('api-scan').disabled = true;
    try {
      const data = await call('providers.discover', {id:editing, baseUrl, apiKey});
      if (generation !== discoveryGeneration) return;
      discovered = [...new Set((Array.isArray(data.models) ? data.models : []).filter(id => typeof id === 'string'))];
      publicCatalog = data.source === 'publicPricing';
      chatOnly = new Set(publicCatalog && Array.isArray(data.chatOnlyModels) ? data.chatOnlyModels : []);
      const existing = new Set(modelIds()); selected = new Set(discovered.filter(id => existing.has(id)).slice(0, 150));
      $('api-filter').value = ''; renderDiscovery();
      if (publicCatalog) {
        const issue = errorMessage({message:data.listIssue});
        discoveryStatus(issue + '。已读取公开价目表供参考，密钥权限和 Responses 对话能力仍需实测。');
      } else {
        discoveryStatus(discovered.length ? '请选择要添加的模型。模型列表不代表已通过对话和工具调用测试。' : '服务商未返回模型，可手动填写模型 ID。');
      }
    } catch (error) {
      if (generation === discoveryGeneration) discoveryStatus(errorMessage(error), true);
    } finally {
      scanning = false; $('api-scan').disabled = busy;
    }
  }
  async function save(event) {
    event.preventDefault();
    await perform(async () => {
      status('正在保存…');
      resetDiscovery();
      const result = await call('providers.save', {id:editing, name:$('api-name').value.trim(),
        baseUrl:$('api-url').value.trim(), models:$('api-models').value, apiKey:$('api-key').value, protocol:'responses'});
      $('api-key').value = '';
      await refresh(); clear();
      status((result?.id && result.id === active) ? '已保存。' : '已保存。在服务商卡片中点「启用」可设为新聊天的默认 API。');
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
    panel.innerHTML = `<div class="api-panel-heading"><h3>模型 API</h3><button id="api-new" class="secondary-button" type="button" aria-controls="api-form" aria-expanded="false">添加服务商</button></div>
      <p class="muted" id="api-current"></p><p id="api-migration" class="muted api-error" role="status" hidden></p>
      <p id="api-status" class="muted" role="status" aria-live="polite"></p>
      <form id="api-form" class="api-form" autocomplete="off" hidden>
        <h4 id="api-editor-heading">添加服务商</h4>
        <details id="api-import">
          <summary>导入 New API 连接</summary>
          <label for="api-import-json">连接 JSON</label><input id="api-import-json" class="text-input" type="password" maxlength="8192" autocomplete="off" spellcheck="false" autocapitalize="off">
          <button id="api-import-apply" class="secondary-button" type="button">导入连接</button>
        </details>
        <label for="api-name">服务商名称</label><input id="api-name" class="text-input" maxlength="60" required placeholder="自定义名称">
        <label for="api-url">接口地址</label><input id="api-url" class="text-input" type="url" maxlength="512" required spellcheck="false" autocapitalize="off" placeholder="https://api.example.com/v1">
        <small class="muted">填写服务商提供的 HTTPS 接口地址。导入 New API 连接时，裸域名会补 /v1。</small>
        <label for="api-key">API Key</label><input id="api-key" class="text-input" type="password" maxlength="4096" required autocomplete="new-password" spellcheck="false" autocapitalize="off">
        <small id="api-key-note" class="muted"></small>
        <label for="api-models">模型 ID（每行一个）</label><textarea id="api-models" class="text-input" rows="3" required spellcheck="false" autocapitalize="off" placeholder="填写服务商提供的模型 ID"></textarea>
        <button id="api-scan" class="secondary-button" type="button">获取模型列表（可选）</button>
        <small id="api-discovery-status" class="muted" role="status" aria-live="polite"></small>
        <div id="api-discovery" class="api-discovery" hidden>
          <label for="api-filter">搜索模型</label><input id="api-filter" class="text-input" type="search" placeholder="搜索模型 ID">
          <small id="api-discovery-count" class="muted"></small>
          <div class="api-buttons"><button id="api-select-all" class="secondary-button" type="button">选择筛选结果</button><button id="api-select-none" class="secondary-button" type="button">取消选择</button></div>
          <div id="api-discovery-results" class="api-discovery-results" role="group" aria-label="可用模型"></div>
          <button id="api-add-selected" class="secondary-button" type="button">添加选中模型</button>
        </div>
        <div class="api-buttons"><button id="api-save" class="primary-button" type="submit">保存</button><button id="api-cancel" class="secondary-button" type="button">取消</button></div>
      </form>
      <div id="api-profiles"></div>`;
    content.append(panel);
    $('api-form').addEventListener('submit', save);
    $('api-new').addEventListener('click', () => {
      if (busy) return;
      if (editing) clear();
      if ($('api-form').hidden) showEditor();
      else {
        $('api-import-json').value = '';
        resetDiscovery();
        $('api-form').hidden = true;
        $('api-new').setAttribute('aria-expanded', 'false');
      }
    });
    $('api-cancel').addEventListener('click', () => { clear(); status(); $('api-new').focus(); });
    $('api-scan').addEventListener('click', scan);
    $('api-import-apply').addEventListener('click', importConnection);
    $('api-filter').addEventListener('input', renderDiscovery);
    ['api-url','api-key'].forEach(id => $(id).addEventListener('input', resetDiscovery));
    $('api-url').addEventListener('input', () => {
      const profile = profiles.find(profile => profile.id === editing);
      const entered = $('api-url').value.trim().replace(/\/+$/, '');
      const endpoint = /\/(?:chat\/completions|responses|models)$/;
      const base = entered.replace(endpoint, '');
      const changed = !!profile && entered !== profile.baseUrl && base !== profile.baseUrl;
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
      if (!selected.size) { discoveryStatus('请先选择模型。', true); return; }
      const ids = [...new Set([...modelIds(), ...selected])];
      if (ids.length > 150) { discoveryStatus('最多可保存 150 个模型。', true); return; }
      $('api-models').value = ids.join('\n');
      discoveryStatus(publicCatalog ? '已添加公开价目表中的模型 ID。密钥权限和 Responses 对话能力仍需实测。' : '模型已添加，保存后生效。');
    });
    $('settings-dialog')?.addEventListener('close', () => {
      $('api-key').value = ''; $('api-import-json').value = '';
      resetDiscovery();
    });
    installed = true; clear(); draw();
  }
  function render(state) {
    if (!installed) return;
    $('api-migration').hidden = !state.apiMigrationError;
    $('api-migration').textContent = state.apiMigrationError ? '旧版 API 配置未能迁移，原配置已保留。请重新添加服务商。' : '';
    profiles = Array.isArray(state.apiProviders) ? state.apiProviders : [];
    active = state.apiDefault ?? state.apiActive ?? '';
    draw();
  }
  window.MobileCodexApiProviders = {init, render};
})();
