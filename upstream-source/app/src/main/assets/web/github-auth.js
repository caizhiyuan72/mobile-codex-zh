/* GitHub Device Flow uses the Android bridge; only public authorization state reaches this UI. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const t = (key, args = {}) => window.MobileCodexLocale?.t(key, args) ?? key.replace(/\{([a-zA-Z]+)\}/g, (token, name) => args[name] ?? token);
  const states = new Set(['idle', 'requesting', 'pending', 'connected', 'denied', 'expired', 'error']);
  const validClientId = value => /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(value);
  const validUserCode = value => /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(value);
  const errorMessages = {
    access_denied: '你已拒绝本次 GitHub 授权，可以重新登录。',
    authorization_declined: '你已拒绝本次 GitHub 授权，可以重新登录。',
    expired_token: 'GitHub 授权已过期，请重新登录。',
    incorrect_client_credentials: 'Client ID 无效，请检查你的 GitHub OAuth 应用配置。',
    invalid_client: 'Client ID 无效，请检查你的 GitHub OAuth 应用配置。',
    device_flow_disabled: '请先在你的 GitHub OAuth 应用设置中启用 Device Flow。',
    network_error: '无法连接 GitHub，请检查网络后重试。',
    rate_limited: 'GitHub 请求过于频繁，请稍后再试。',
    insufficient_scope: 'GitHub 未授予所需权限，请重新登录并确认公开仓库与工作流权限。',
    '此 GitHub OAuth App 尚未启用 Device Flow，请先在应用设置中启用。': '请先在你的 GitHub OAuth 应用设置中启用 Device Flow。',
    '此 GitHub OAuth App 尚未启用 Device Flow。': '请先在你的 GitHub OAuth 应用设置中启用 Device Flow。',
    '现有 GitHub 授权权限过宽，请使用本项目独立注册的 OAuth App 重新授权。': '请为本项目单独创建 GitHub OAuth 应用，保存其 Client ID 后重新授权。',
    'GitHub 授权范围不足，需要公共仓库和工作流权限，请重新授权。': '请重新登录，并确认授权公开仓库（public_repo）和工作流（workflow）权限。'
  };
  const genericError = 'GitHub 操作失败，请检查网络或 OAuth 应用配置后重试。';
  let call, refresh, toast, installed = false;
  let snapshot = {configured:false, clientId:'', state:'idle', login:'', userCode:'', expiresAt:0, error:'', scopes:[]};
  let busy = '', operation = 0, auxiliaryBusy = '', auxiliaryOperation = 0, copying = false;
  let dirty = false, codeHidden = false, notice = '', noticeError = false, mainAction = '';

  function message(text = '', error = false) {
    notice = text; noticeError = error; draw();
  }

  function currentState() {
    if (busy === 'github.login' && snapshot.state !== 'pending') return 'requesting';
    if (snapshot.state === 'pending' && snapshot.expiresAt && snapshot.expiresAt <= Date.now()) return 'expired';
    return snapshot.state;
  }

  function draw() {
    if (!installed) return;
    const state = currentState(), waiting = state === 'requesting' || state === 'pending';
    const locked = !!busy, configured = snapshot.configured;
    const codeVisible = state === 'pending' && !codeHidden && validUserCode(snapshot.userCode);
    const input = $('github-client-id');
    const actionParent = configured ? $('github-auth-card') : $('github-config-form');
    if ($('github-action-area').parentElement !== actionParent) actionParent.append($('github-action-area'));
    if (!dirty) input.value = snapshot.clientId;
    input.disabled = locked || waiting || state === 'connected';
    $('github-panel').setAttribute('aria-busy', String(locked));
    $('github-panel').dataset.authState = state;
    $('github-setup-steps').hidden = configured;
    $('github-config-save').hidden = !configured;
    $('github-config-save').disabled = input.disabled || !validClientId(input.value.trim()) || input.value.trim() === snapshot.clientId;
    $('github-config-note').textContent = t(state === 'connected' ? '更换 Client ID 前，请先退出本机登录。'
      : waiting ? '本次登录结束后可修改 Client ID。' : 'Client ID 是公开标识，无需填写 Client Secret。');
    $('github-open-setup').disabled = locked || !!auxiliaryBusy;
    $('github-account').hidden = state !== 'connected';
    $('github-account').textContent = state === 'connected' ? (snapshot.login ? t('已连接 @{login}', {login:snapshot.login}) : t('已连接 GitHub')) : '';
    $('github-scopes').hidden = state !== 'connected' || !snapshot.scopes.length;
    $('github-scopes').textContent = snapshot.scopes.length ? t('已授权：{scopes}', {scopes:snapshot.scopes.join(' · ')}) : '';

    const status = state === 'connected' ? '可按需使用 GitHub 仓库功能。'
      : state === 'requesting' ? '正在向 GitHub 获取授权码…'
      : state === 'pending' ? '在浏览器中输入授权码并确认授权，App 会自动确认登录结果。'
      : state === 'denied' ? '你已拒绝本次 GitHub 授权，可以重新登录。'
      : state === 'expired' ? 'GitHub 授权已过期，请重新登录。'
      : state === 'error' ? (errorMessages[snapshot.error] || genericError)
      : configured ? 'Client ID 已配置，可以使用浏览器登录 GitHub。' : '先配置你自己的 GitHub OAuth 应用。';
    $('github-status').textContent = t(status);
    $('github-status').classList.toggle('github-auth-error', ['denied', 'expired', 'error'].includes(state));
    $('github-pending').hidden = !codeVisible;
    $('github-user-code').value = codeVisible ? snapshot.userCode : '';
    $('github-copy-code').disabled = !codeVisible || copying || locked;
    $('github-code-expiry').textContent = codeVisible && snapshot.expiresAt
      ? t('有效至 {time}', {time:new Date(snapshot.expiresAt).toLocaleTimeString(window.MobileCodexLocale?.language() || 'zh-CN', {hour:'2-digit', minute:'2-digit'})})
      : t('授权码过期后需要重新登录。');
    $('github-cancel').hidden = !waiting;
    $('github-cancel').disabled = locked && busy !== 'github.login';
    $('github-cancel').textContent = t(busy === 'github.cancel' ? '正在取消…' : '取消登录');
    $('github-disconnect').hidden = state !== 'connected';
    $('github-disconnect').disabled = locked;
    $('github-disconnect').textContent = t(busy === 'github.disconnect' ? '正在退出…' : '退出登录');

    const main = $('github-main-action');
    main.hidden = state === 'connected';
    mainAction = state === 'connected' ? '' : !configured ? 'configure' : waiting ? (codeVisible ? 'verify' : '') : 'login';
    main.textContent = t(!configured ? (busy === 'github.configure' ? '正在保存…' : '保存 Client ID')
      : state === 'requesting' ? '正在获取授权码…' : state === 'pending' ? (codeVisible ? '打开 GitHub 授权页' : '等待授权码…') : '浏览器登录');
    main.disabled = locked || !mainAction || !!auxiliaryBusy || (mainAction === 'configure' && !validClientId(input.value.trim()))
      || (mainAction === 'login' && dirty && input.value.trim() !== snapshot.clientId);
    $('github-action-status').hidden = !notice;
    $('github-action-status').textContent = t(notice);
    $('github-action-status').classList.toggle('github-auth-error', noticeError);
  }

  async function perform(action, args) {
    if (busy && !(action === 'github.cancel' && busy === 'github.login')) return;
    const version = ++operation;
    busy = action; notice = ''; noticeError = false;
    if (action === 'github.login') codeHidden = false;
    if (action === 'github.cancel' || action === 'github.disconnect') {
      codeHidden = true; ++auxiliaryOperation; auxiliaryBusy = '';
    }
    draw();
    try {
      await call(action, args);
      if (version !== operation) return;
      await refresh();
      if (version !== operation) return;
      if (action === 'github.configure' && snapshot.configured && snapshot.clientId === args.clientId) dirty = false;
    } catch (error) {
      if (version !== operation) return;
      const reason = typeof error?.message === 'string' ? error.message : '';
      notice = Object.hasOwn(errorMessages, reason) ? errorMessages[reason] : genericError;
      noticeError = true; toast(t(notice));
    } finally {
      if (version === operation) { busy = ''; draw(); }
    }
  }

  async function openPage(action) {
    if (busy || auxiliaryBusy) return;
    const version = ++auxiliaryOperation;
    auxiliaryBusy = action; notice = ''; noticeError = false; draw();
    try { await call(action); }
    catch (_) {
      if (version === auxiliaryOperation) {
        notice = '未能打开浏览器，请检查浏览器是否可用后重试。'; noticeError = true; toast(t(notice));
      }
    } finally {
      if (version === auxiliaryOperation) { auxiliaryBusy = ''; draw(); }
    }
  }

  function save(event) {
    event?.preventDefault();
    if (busy || ['requesting', 'pending', 'connected'].includes(currentState())) return;
    const clientId = $('github-client-id').value.trim();
    if (!validClientId(clientId)) { message('请填写有效的公开 OAuth Client ID。', true); return; }
    if (snapshot.configured && clientId === snapshot.clientId) return;
    perform('github.configure', {clientId});
  }

  async function copyCode() {
    const code = snapshot.userCode;
    if (copying || busy || codeHidden || currentState() !== 'pending' || !validUserCode(code)) return;
    copying = true; draw();
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(code);
      else {
        $('github-user-code').focus(); $('github-user-code').select();
        if (!document.execCommand?.('copy')) throw new Error();
      }
      if (snapshot.userCode === code && currentState() === 'pending' && !codeHidden) message('授权码已复制。');
    } catch (_) {
      if (snapshot.userCode === code && currentState() === 'pending' && !codeHidden) {
        $('github-user-code').focus(); $('github-user-code').select();
        message('未能自动复制，授权码已选中，请长按复制。');
      }
    } finally { copying = false; draw(); }
  }

  function init(options) {
    if (installed) return;
    const nav = document.querySelector('.settings-nav'), content = document.querySelector('.settings-content');
    if (!nav || !content) return;
    call = options.call; refresh = options.refresh; toast = options.toast || (() => {});
    const tab = document.createElement('button');
    tab.type = 'button'; tab.textContent = 'GitHub'; tab.dataset.settingsTab = 'github';
    const providers = nav.querySelector('[data-settings-tab="providers"]');
    if (providers) providers.after(tab); else nav.append(tab);
    const panel = document.createElement('section');
    panel.id = 'github-panel'; panel.className = 'settings-section github-auth-panel';
    panel.dataset.settingsPanel = 'github'; panel.hidden = true;
    panel.innerHTML = `<h3>GitHub</h3>
      <p class="muted">通过浏览器授权，把你的 GitHub 账户连接到此设备。</p>
      <div id="github-auth-card" class="github-auth-card">
        <strong id="github-account" hidden></strong>
        <p id="github-status" class="muted" role="status" aria-live="polite"></p>
        <p id="github-scopes" class="muted" hidden></p>
        <div id="github-pending" class="github-code-card" hidden>
          <label for="github-user-code">GitHub 授权码</label>
          <div class="github-code-row"><input id="github-user-code" class="text-input github-user-code" type="text" readonly autocomplete="off" spellcheck="false" aria-describedby="github-code-expiry"><button id="github-copy-code" class="secondary-button" type="button">复制</button></div>
          <small id="github-code-expiry" class="muted"></small>
        </div>
        <div id="github-action-area" class="github-action-area"><div class="github-auth-actions">
          <button id="github-main-action" class="primary-button" type="button">保存 Client ID</button>
          <button id="github-cancel" class="secondary-button" type="button" hidden>取消登录</button>
          <button id="github-disconnect" class="secondary-button subtle-danger" type="button" hidden>退出登录</button>
        </div>
        <p id="github-action-status" class="muted" role="status" aria-live="polite" hidden></p></div>
      </div>
      <details id="github-app-config" class="github-app-config" open>
        <summary>OAuth 应用配置</summary>
        <div id="github-setup-steps">
          <ol><li>创建你自己的 GitHub OAuth App。</li><li>在应用设置中启用 Device Flow（设备授权）。</li><li>复制公开的 Client ID，填入下方。</li></ol>
          <button id="github-open-setup" class="secondary-button" type="button">创建 OAuth 应用</button>
        </div>
        <form id="github-config-form" class="github-config-form" autocomplete="off">
          <label for="github-client-id">OAuth Client ID</label>
          <input id="github-client-id" class="text-input" maxlength="128" required autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="github-config-note" placeholder="填写你自己的 Client ID">
          <small id="github-config-note" class="muted">Client ID 是公开标识，无需填写 Client Secret。</small>
          <button id="github-config-save" class="secondary-button" type="submit" hidden>保存 Client ID 修改</button>
        </form>
      </details>
      <p class="muted github-permission-note">请求公开仓库读写（public_repo）和工作流（workflow）权限。GitHub OAuth 授权不能限制到单个仓库，暂不支持私有仓库。不会自动推送、发布或触发 Actions。</p>
      <p class="muted github-disconnect-note">退出登录只移除此设备的 GitHub 连接。</p>`;
    content.append(panel);
    window.MobileCodexLocale?.bind(panel);
    document.addEventListener('mobilecodex:languagechange', draw);
    $('github-config-form').addEventListener('submit', save);
    $('github-client-id').addEventListener('input', () => { dirty = true; notice = ''; noticeError = false; draw(); });
    $('github-main-action').addEventListener('click', () => {
      if ($('github-main-action').disabled) return;
      if (mainAction === 'configure') save();
      else if (mainAction === 'login') perform('github.login');
      else if (mainAction === 'verify') openPage('github.openVerification');
    });
    $('github-open-setup').addEventListener('click', () => openPage('github.openSetup'));
    $('github-cancel').addEventListener('click', () => {
      if (['requesting', 'pending'].includes(currentState())) perform('github.cancel');
    });
    $('github-disconnect').addEventListener('click', () => {
      if (currentState() === 'connected') perform('github.disconnect');
    });
    $('github-copy-code').addEventListener('click', copyCode);
    $('github-user-code').addEventListener('focus', () => $('github-user-code').select());
    const showCode = () => { codeHidden = false; draw(); };
    tab.addEventListener('click', showCode);
    const dialog = $('settings-dialog');
    dialog?.addEventListener('close', () => {
      codeHidden = true; notice = ''; noticeError = false; draw();
    });
    if (dialog) new MutationObserver(records => {
      if (records.some(record => record.attributeName === 'open') && dialog.open) showCode();
    }).observe(dialog, {attributes:true, attributeFilter:['open']});
    installed = true; draw();
  }

  function render(state) {
    if (!installed) return;
    const source = state?.github || {};
    const configured = source.configured === true;
    const clientId = typeof source.clientId === 'string' && validClientId(source.clientId) ? source.clientId : '';
    const firstConfiguration = !snapshot.configured && configured;
    snapshot = {
      configured, clientId,
      state:states.has(source.state) ? source.state : 'idle',
      login:typeof source.login === 'string' ? source.login.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 100) : '',
      userCode:typeof source.userCode === 'string' && validUserCode(source.userCode) ? source.userCode : '',
      expiresAt:typeof source.expiresAt === 'number' && Number.isFinite(source.expiresAt) && source.expiresAt > 0 && source.expiresAt < 8640000000000000 ? source.expiresAt : 0,
      error:typeof source.error === 'string' && Object.hasOwn(errorMessages, source.error) ? source.error : '',
      scopes:Array.isArray(source.scopes) ? ['public_repo', 'workflow'].filter(scope => source.scopes.includes(scope)) : []
    };
    if (firstConfiguration) $('github-app-config').open = false;
    if (!configured) $('github-app-config').open = true;
    draw();
  }
  window.MobileCodexGitHub = {init, render};
})();
