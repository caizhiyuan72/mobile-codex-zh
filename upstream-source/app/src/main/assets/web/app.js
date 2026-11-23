/* Packaged UI only. Native.postMessage is the sole transport; no remote scripts. */
(() => {
  'use strict';
  const L = window.MobileCodexLocale, t = L.t;
  const appearance = window.MobileCodexAppearance;
  const LEGACY_PRO_MODEL = 'chatgpt-web:gpt-6-pro';
  const $ = id => document.getElementById(id), C = window.UiCore;
  const pending = new Map(), requestQueue = new Map();
  let agentUi = null;
  let apiProvidersUi = window.MobileCodexApiProviders;
  const githubUi = window.MobileCodexGitHub;
  let reportsUi = null;
  let terminalState = {id:'', revision:-1, running:false, stopping:false}, terminalSending = false;
  const dialogs = [], frame = fn => (window.requestAnimationFrame || (cb => setTimeout(cb, 0)))(fn);
  let following = true, draftScope = '', draftProvider = '', sending = null, chatSelection = null, configOriginal = '', sidebarFocus = null, openedImage = null;
  let historyView = {threadId:'', hasMore:false, beforeId:'', total:0, loading:false, loaded:false, top:0};
  const imageReads = new Map();
  let viewerImages = [], viewerIndex = 0, viewerGroup = null;
  let seq = 0, state = {messages: [], sessions: [], projects: [], models: [], accounts: [], account: {}, authState:'unknown', rateLimits: {}, workspace: {}}, folder = '', openedFile = null, inputResolve = null, toastTimer, fileSeq = 0, modelKey = '', modelRefreshGeneration = 0, displayedRequest = null;
  let fileContextGeneration = 0, fileReadSeq = 0, fileInputContext = null, searchTimer;
  const fileDrafts = new Map();
  let draftContext = {attachments: [], mentions: [], skills: []}, draftOptions = {model:'', effort:''}, autocomplete = {items: [], index: -1, token: '', type: '', version: 0};
  const handledReceipts = new Set(), handledVoiceReceipts = new Set();
  let dictationState = {phase:'idle'}, dictationTimer = null;
  let voiceStarting = false, voiceActive = false, voiceRecoveryGeneration = 0;
  let instructionsOriginal = '', instructionsLoaded = false, instructionsSaving = false, devtoolsCheckResult = null, devtoolsCheckSummary = '', devtoolsChecking = false;
  const toolCache = [null, null, null];
  let updateState = {}, updateSourceDirty = false, updateRequestPending = false;
  let linuxStatusError = '', linuxRequestPending = false;
  let textSizePercent = 100;
  function call(action, args = {}) {
    return new Promise((resolve, reject) => {
      if (!window.Native) return reject(new Error(t('Android 앱에서 실행해 주세요.')));
      const id = String(++seq);
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(t('요청 시간이 초과되었습니다. 상태를 확인하고 다시 시도해 주세요.'))); }, ['files.mutate','recovery.restore','updates.install'].includes(action) ? 610000 : 150000);
      pending.set(id, {resolve, reject, timer});
      window.Native.postMessage(JSON.stringify({id, action, args}));
    });
  }
  const rpc = (method, params = {}) => call('rpc', {method, params});
  const on = (id, fn, event = 'click') => $(id).addEventListener(event, e => { if (event === 'submit') e.preventDefault(); Promise.resolve().then(() => fn(e)).catch(error => toast(error.message)); });
  function node(tag, text, cls) { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; }
  function button(text, fn, cls = 'secondary-button') { const b = node('button', text, cls); b.type = 'button'; b.addEventListener('click', () => { b.disabled = true; Promise.resolve().then(fn).catch(e => toast(e.message)).finally(() => { b.disabled = false; if (b.dataset.restoreFocus === 'true') b.focus(); }); }); return b; }
  function icon(name) { const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); const use = document.createElementNS(svg.namespaceURI, 'use'); use.setAttribute('href', '#i-' + name); svg.append(use); return svg; }
  // Network failures may contain a full HTML response or a multi-line diagnostic.
  // Keep those payloads out of user-facing status text.
  function errorText(error, fallback = t('요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.')) {
    const message = String(error?.message ?? error ?? '').trim();
    return message && message.length <= 240 && !/[\r\n<>]/.test(message)
      && !/(?:bearer\s|gh[pousr]_|github_pat_|access_token|refresh_token|client_secret)/i.test(message) ? message : fallback;
  }
  function toast(message) {
    // A body-level toast is behind modal dialogs, regardless of its z-index.
    const dialog = dialogs.map(id => $(id)).filter(item => item?.open).at(-1);
    const target = $('toast');
    if (dialog) dialog.prepend(target); else document.body.append(target);
    target.textContent = errorText(message); target.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { target.hidden = true; }, 5500);
  }

  function renderConversationFailure() {
    const messages = {
      runtime_disconnected:'本机运行时连接已中断，未收到这轮任务的最终状态。对话记录已保留，上一条消息未自动重发。',
      encrypted_transport_changed:'服务商拒绝恢复此对话（HTTP 409）：加密会话传输发生变化。长对话的自动压缩也可能因此失败。请联系服务商检查会话路由；原记录已保留，可先打开新对话。',
      upstream_conflict:'服务商返回会话冲突（HTTP 409）。请联系服务商检查会话状态；原记录已保留，可先打开新对话。',
      context_limit:'此对话的上下文已达到上限，本次请求未完成。可稍后重试，或打开新对话并补充任务进度；原记录已保留。',
      upstream_connection:'与服务商的连接在重试后仍未完成。请稍后重试；如果只有这条对话持续失败，可先打开新对话，原记录已保留。',
      usage_limit:'服务商的用量或速率限制使本次请求未完成。请检查额度或稍后重试。',
      upstream_auth:'服务商拒绝了身份验证，请在设置中检查 API 密钥。',
      upstream_bad_request:'服务商拒绝了本次请求，请检查模型和 API 配置。原对话记录已保留。'
    };
    const failure = state.conversationFailure;
    $('conversation-failure').hidden = !failure || !!state.busy;
    $('conversation-failure-message').textContent = failure ? (messages[failure.code] || '本次请求失败。请检查连接与服务商状态后重试，原对话记录已保留。') : '';
    $('conversation-failure-new').disabled = !!state.busy || !!sending;
  }

  function ensureNotificationSettings() {
    const toggle = $('theme')?.closest('.settings-row');
    if (!toggle) return;
    const make = (id, title, description) => { const row = node('div', null, 'settings-row'), copy = node('span'), strong = node('strong', title), small = node('small', description), label = node('label', null, 'toggle-switch'), input = node('input'); input.id = id; input.type = 'checkbox'; input.setAttribute('role', 'switch'); input.checked = localStorage.getItem(id) !== 'off'; input.addEventListener('change', () => { try { localStorage.setItem(id, input.checked ? 'on' : 'off'); } catch {} call('notifications.configure', {enabled: $('notifications-toggle')?.checked !== false, vibration: $('notification-vibration-toggle')?.checked !== false}).catch(error => toast(error.message)); }); label.append(input, node('span', null, 'toggle-track')); copy.append(strong, small); row.append(copy, label); return row; };
    const parent = toggle.parentElement;
    if (!$('notifications-toggle')) {
      const notifications = make('notifications-toggle', t('작업 알림'), t('답변 완료와 승인 요청을 Android 상단 알림으로 알려줍니다.'));
      const vibration = make('notification-vibration-toggle', t('알림 진동'), t('작업 알림이 도착할 때 진동합니다.'));
      const permission = node('div', null, 'settings-row notification-permission-row');
      const copy = node('span'), title = node('strong', t('Android 알림 권한')), help = node('small', t('시스템 권한이 꺼져 있으면 상단 알림을 받을 수 없습니다.'));
      const open = button(t('Android 알림 설정'), async () => { await call('notifications.openSettings'); setTimeout(refreshNotificationSettings, 250); }, 'secondary-button');
      open.id = 'notification-settings-button'; copy.append(title, help); permission.append(copy, open);
      parent.insertBefore(permission, toggle); parent.insertBefore(vibration, permission); parent.insertBefore(notifications, vibration);
    }
    function apply(value) {
      if (!value) return;
      $('notifications-toggle').checked = value.enabled !== false;
      $('notification-vibration-toggle').checked = value.vibration !== false;
      const permission = document.querySelector('.notification-permission-row');
      if (permission) permission.hidden = value.permission !== false;
    }
    function refreshNotificationSettings() { return call('notifications.state').then(apply).catch(() => {}); }
    window.refreshNotificationSettings = refreshNotificationSettings;
    refreshNotificationSettings();
  }
  function show(id) {
    sidebar(false);
    if (!$(id).open) { dialogs.push(id); $(id).showModal(); }
  }
  function close(id) { $(id).close(); }
  function dismiss(id) {
    if (id === 'report-dialog' && reportsUi) { reportsUi.cancel(); return; }
    const dirty = (id === 'editor-dialog' && openedFile && $('editor').value !== openedFile.content)
      || (id === 'config-dialog' && $('config-editor').value !== configOriginal)
      || (id === 'settings-dialog' && instructionsLoaded && $('instructions-editor').value !== instructionsOriginal);
    if (dirty && !confirm(t('저장하지 않은 변경 사항을 닫을까요?'))) return;
    if (id === 'editor-dialog' && openedFile) {
      fileDrafts.delete(fileDraftKey(openedFile.context, openedFile.path));
      $('editor').value = openedFile.content;
    }
    // Keep the request in the queue; selecting its conversation can show it again.
    if (id === 'request-dialog') displayedRequest = null;
    close(id);
  }
  function wireSheetGestures() {
    const mobile = matchMedia('(max-width:760px)');
    document.querySelectorAll('dialog .sheet-grip').forEach(grip => {
      const sheet = grip.closest('dialog');
      let drag = null, suppressClickUntil = 0;
      function reset() {
        const previous = drag; drag = null;
        sheet.classList.remove('sheet-dragging'); sheet.style.removeProperty('--sheet-offset');
        if (previous && grip.hasPointerCapture?.(previous.id)) grip.releasePointerCapture(previous.id);
      }
      grip.addEventListener('pointerdown', e => {
        if (!mobile.matches || !sheet.open || e.isPrimary === false || e.button !== 0) return;
        suppressClickUntil = 0;
        sheet.getAnimations?.().forEach(animation => animation.finish());
        drag = {id:e.pointerId, x:e.clientX, y:e.clientY, dx:0, dy:0};
        grip.setPointerCapture?.(e.pointerId); sheet.classList.add('sheet-dragging');
      });
      grip.addEventListener('pointermove', e => {
        if (!drag || drag.id !== e.pointerId) return;
        drag.dx = e.clientX - drag.x; drag.dy = Math.max(0, e.clientY - drag.y);
        const offset = Math.abs(drag.dx) > drag.dy ? 0 : drag.dy;
        sheet.style.setProperty('--sheet-offset', Math.min(offset, sheet.clientHeight * .85 || offset) + 'px');
      });
      grip.addEventListener('pointerup', e => {
        if (!drag || drag.id !== e.pointerId) return;
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        const threshold = Math.min(112, Math.max(72, sheet.clientHeight * .22));
        const moved = Math.hypot(dx, dy) > 8;
        if (moved) suppressClickUntil = performance.now() + 500;
        reset();
        // Reuse the close path so unsaved instructions still require confirmation.
        if (mobile.matches && sheet.open && dy >= threshold && dy > Math.abs(dx) * 1.25) dismiss(sheet.id);
      });
      grip.addEventListener('pointercancel', () => { suppressClickUntil = performance.now() + 500; reset(); });
      grip.addEventListener('lostpointercapture', reset);
      grip.addEventListener('click', e => {
        // A drag is followed by a synthetic click on some WebViews; keep a short drag open.
        if (e.detail > 0 && performance.now() < suppressClickUntil) { e.preventDefault(); e.stopImmediatePropagation(); }
      }, true);
      sheet.addEventListener('close', reset);
      window.addEventListener('resize', reset);
      window.addEventListener('blur', reset);
    });
  }
  function sidebar(open) {
    if (!open) { closeSessionCard(); closeProjectCard(); }
    const wasOpen = document.body.classList.contains('sidebar-open');
    document.body.classList.toggle('sidebar-open', open); $('scrim').hidden = !open;
    if (matchMedia('(max-width:760px)').matches) {
      $('sidebar').inert = !open; document.querySelector('main').inert = open;
      if (open && !wasOpen) { sidebarFocus = document.activeElement; $('new-chat').focus(); }
      else if (!open && wasOpen) sidebarFocus?.focus({preventScroll:true});
    }
    document.querySelectorAll('.sidebar-toggle').forEach(b => b.setAttribute('aria-expanded', String(open)));
  }
  function setTheme() {
    const choice = $('theme').value;
    try { localStorage.setItem('theme', choice); } catch {}
    appearance.applyTheme(choice);
    syncNativeTheme();
  }
  function syncNativeTheme() {
    call('ui.theme', {theme:$('theme').value, liquidGlass:document.documentElement.hasAttribute('data-liquid-glass')}).catch(() => {});
  }
  function setupInterfaceStyle() {
    const root = document.documentElement;
    const composerWrap = $('composer').parentElement;
    function updateGlassInset() {
      if (!root.hasAttribute('data-liquid-glass')) return;
      root.style.setProperty('--glass-composer-height', composerWrap.offsetHeight + 'px');
    }
    $('appearance-' + (root.hasAttribute('data-liquid-glass') ? 'glass' : 'classic')).checked = true;
    updateGlassInset();
    if (window.ResizeObserver) {
      const observer = new ResizeObserver(() => { updateGlassInset(); if (root.hasAttribute('data-liquid-glass')) followLatest(); });
      observer.observe(composerWrap);
    }
    for (const choice of document.querySelectorAll('[name="interface-style"]')) {
      choice.addEventListener('change', () => {
        const anchor = readingPosition();
        root.toggleAttribute('data-liquid-glass', choice.value === 'glass');
        try { localStorage.setItem('interfaceStyle', choice.value); } catch {}
        updateGlassInset();
        syncNativeTheme();
        if (following) followLatest(); else restoreReadingPosition(anchor);
      });
    }
  }
  function applyTextSize(value) {
    const percent = Number(value);
    if (![75,85,100,115,130,150].includes(percent)) return false;
    textSizePercent = percent;
    document.documentElement.dataset.textSize = String(percent);
    // Native text zoom scales glyphs. This factor only reserves layout space;
    // applying it to font-size as well would enlarge every glyph twice.
    document.documentElement.style.setProperty('--text-size-factor', String(percent / 100));
    if ($('text-size')) $('text-size').value = String(percent);
    return true;
  }
  function ensureTextSizeSettings() {
    const themeRow = $('theme').closest('.settings-row');
    const row = node('div', null, 'settings-row text-size-row'), label = node('label');
    label.htmlFor = 'text-size'; label.append(node('strong', t('글자 크기')), node('small', t('폰과 태블릿의 앱 화면에 적용됩니다.')));
    const select = node('select'); select.id = 'text-size'; select.setAttribute('aria-label', t('글자 크기'));
    for (const value of [75,85,100,115,130,150]) select.append(new Option(value === 100 ? t('기본 · 100%') : value + '%', String(value)));
    row.append(label, select); themeRow.after(row);
    try { applyTextSize(JSON.parse(window.Native?.textSize?.() || '{}').percent); } catch {}
    applyTextSize(textSizePercent);
    select.addEventListener('change', async () => {
      const requested = Number(select.value), previous = textSizePercent;
      if (![75,85,100,115,130,150].includes(requested)) { select.value = String(previous); return; }
      select.disabled = true;
      try {
        const result = await call('ui.textSize', {percent:requested});
        if (result.percent !== requested) throw new Error(t('글자 크기를 저장하지 못했습니다.'));
        applyTextSize(result.percent); viewportChanged();
      } catch (error) { applyTextSize(previous); toast(error.message); }
      finally { select.disabled = false; }
    });
  }
  function updateReplyIndentLabels() {
    const [title, description] = $('reply-indent-label').children;
    const english = L.language() === 'en';
    title.textContent = english ? 'First-line indent in replies' : '回复首行缩进两格';
    description.textContent = english ? 'Indent reply paragraphs by two characters.' : '应用于助手回复的正文段落。';
  }
  function setupReplyIndentSetting() {
    const row = node('div', null, 'settings-row');
    const label = node('label');
    label.id = 'reply-indent-label'; label.htmlFor = 'reply-indent';
    label.append(node('strong'), node('small'));
    const checkbox = node('input');
    checkbox.type = 'checkbox'; checkbox.id = 'reply-indent';
    label.firstElementChild.id = 'reply-indent-title'; label.lastElementChild.id = 'reply-indent-description';
    checkbox.setAttribute('aria-labelledby', 'reply-indent-title');
    checkbox.setAttribute('aria-describedby', 'reply-indent-description');
    row.append(label, checkbox); $('text-size').closest('.settings-row').after(row);
    updateReplyIndentLabels();
    try { checkbox.checked = localStorage.getItem('replyIndent') === 'true'; } catch {}
    const apply = () => document.documentElement.toggleAttribute('data-reply-indent', checkbox.checked);
    apply();
    checkbox.addEventListener('change', () => {
      const anchor = readingPosition();
      try { localStorage.setItem('replyIndent', String(checkbox.checked)); } catch {}
      apply();
      if (following) followLatest(); else restoreReadingPosition(anchor);
    });
  }
  function contextScope(scope = draftScope) { return scope ? scope + ':context' : ''; }
  function optionsScope(scope = draftScope) { return scope ? scope + ':options' : ''; }
  function restoreOptions(scope) { try { const value = JSON.parse(localStorage.getItem(optionsScope(scope)) || '{}'); if (value.model === LEGACY_PRO_MODEL) { value.model = ''; value.effort = ''; localStorage.setItem(optionsScope(scope), JSON.stringify(value)); } return {model:value.model || '', effort:window.MobileCodexReasoning.normalize(value.effort), fastMode:typeof value.fastMode === 'boolean' ? value.fastMode : undefined}; } catch { return {model:'', effort:''}; } }
  function providerScope(snapshot = state) { return snapshot.apiActive || ''; }
  function saveOptions() { if (!draftScope) return; draftOptions = {model:$('model').value, effort:$('effort').value, fastMode:draftOptions.fastMode === true}; try { localStorage.setItem(optionsScope(), JSON.stringify(draftOptions)); } catch {} }
  function saveDraft() {
    if (!draftScope) return;
    try {
      if ($('prompt').value) localStorage.setItem(draftScope, $('prompt').value); else localStorage.removeItem(draftScope);
      const context = {attachments:draftContext.attachments || [], mentions:draftContext.mentions || [], skills:draftContext.skills || []};
      if (context.attachments.length || context.mentions.length || context.skills.length) localStorage.setItem(contextScope(), JSON.stringify(context)); else localStorage.removeItem(contextScope());
    } catch {}
  }
  function restoreContext(scope, account = draftProvider) {
    try { const value = JSON.parse(localStorage.getItem(contextScope(scope)) || '{}'); return {attachments:Array.isArray(value.attachments) ? value.attachments : [], mentions:Array.isArray(value.mentions) ? value.mentions : [], skills:Array.isArray(value.skills) ? value.skills : []}; }
    catch { return {attachments:[], mentions:[], skills:[]}; }
  }
  function migrateDraftToGeneral(sourceScope, targetScope) {
    try {
      const targetHasContent = localStorage.getItem(targetScope) !== null || localStorage.getItem(contextScope(targetScope)) !== null;
      if (localStorage.getItem(targetScope) === null) {
        const text = localStorage.getItem(sourceScope);
        if (text !== null) localStorage.setItem(targetScope, text);
      }
      if (localStorage.getItem(optionsScope(targetScope)) === null) {
        const options = localStorage.getItem(optionsScope(sourceScope));
        if (options !== null) localStorage.setItem(optionsScope(targetScope), options);
      }
      if (localStorage.getItem(contextScope(targetScope)) === null) {
        const context = restoreContext(sourceScope), safe = {attachments:context.attachments, mentions:[], skills:context.skills};
        if (safe.attachments.length || safe.skills.length) localStorage.setItem(contextScope(targetScope), JSON.stringify(safe));
        if (context.mentions.length) toast(t('프로젝트 파일 멘션은 원래 초안에 남겨 두었습니다.'));
      }
    } catch {}
  }
  function draftKeyFor(scope = draftScope) { return scope.replace(/^draft:/, ''); }
  function removeContext(type, value) {
    draftContext[type] = (draftContext[type] || []).filter(item => item.id !== value && item.path !== value && item.name !== value); renderDraftContext(); saveDraft(); updateSend();
  }
  function renderDraftContext() {
    const target = $('draft-context'); target.replaceChildren();
    const items = [
      ...(draftContext.attachments || []).map(item => ({type:'attachments', value:item, label:item.name || t('첨부 파일')})),
      ...(draftContext.mentions || []).map(item => ({type:'mentions', value:item, label:'@' + (item.name || item.path)})),
      ...(draftContext.skills || []).map(item => ({type:'skills', value:item, label:'$' + item.name}))
    ];
    for (const item of items) {
      const chip = node('span', null, 'context-chip'), image = item.value.image || item.value;
      if (item.type === 'attachments' && C.safeImageUrl(image.url)) { const preview = button('', () => previewImage(image), 'context-image'); preview.setAttribute('aria-label', item.label + t(' 미리 보기')); const img = node('img'); img.src = image.url; img.alt = item.label; preview.append(img); chip.append(preview); }
      chip.append(node('span', item.label)); const remove = button('×', () => removeContext(item.type, item.value.id || item.value.path || item.value.name), 'chip-remove'); remove.setAttribute('aria-label', item.label + t(' 제거')); chip.append(remove); target.append(chip);
    }
    target.hidden = !items.length;
    updateComposerExpansion();
  }
  function setDraftScope(next) {
    const workspaceKey = Object.prototype.hasOwnProperty.call(next.workspace || {}, 'key') ? next.workspace.key : (next.cwd || '');
    const scope = 'draft:' + C.draftKey(workspaceKey || '', next.threadId || 'new');
    const provider = providerScope(next);
    if (scope === draftScope && provider === draftProvider) return;
    const previousScope = draftScope, previousWorkspaceKey = state.workspace?.key || '';
    saveDraft();
    if (provider === draftProvider && !workspaceKey && next.workspace?.selected === false && state.threadId && state.threadId === next.threadId && previousWorkspaceKey && previousScope) migrateDraftToGeneral(previousScope, scope);
    const createdBySend = sending && provider === sending.provider && provider === draftProvider && !state.threadId && next.threadId && state.cwd === next.cwd && state.workspace?.key === next.workspace?.key;
    draftScope = scope; draftProvider = provider; hideAutocomplete(); closeComposerAddMenu(false);
    if (createdBySend) { sending.scopes.add(scope); saveDraft(); saveOptions(); }
    else { try { $('prompt').value = localStorage.getItem(scope) || ''; } catch { $('prompt').value = ''; } draftContext = restoreContext(scope); renderDraftContext(); }
    if (!createdBySend) draftOptions = restoreOptions(scope);
    modelKey = '';
    if (draftOptions.fastMode === undefined) draftOptions.fastMode = next.fastMode === true;
    $('model').value = [...$('model').options].some(o => o.value === draftOptions.model) ? draftOptions.model : '';
    efforts(draftOptions.effort);
    sizeComposer();
  }
  const projectWorkBusy = () => !!state.busy || (state.sessions || []).some(session => !!session.busy);
  const generalFolderAvailable = (workspace = state.workspace) => !workspace?.selected && (workspace?.hasLocalFolder === true || workspace?.available === true);
  const workspaceFilesAvailable = (workspace = state.workspace) => workspace?.selected ? workspace.available !== false : generalFolderAvailable(workspace);
  const workspaceFolderLabel = (workspace = state.workspace) => workspace?.selected ? (workspace.name || t('작업 폴더 선택')) : (workspace.name || L.brand('Codex'));
  function updateSend() {
    renderConversationFailure();
    $('voice-input').disabled = !draftScope || voiceStarting || voiceActive || !!sending;
    $('voice-input').setAttribute('aria-busy', String(voiceStarting || voiceActive));
    const hasDraft = !!$('prompt').value.trim() || !!draftContext.attachments.length;
    $('send').disabled = !hasDraft || !!sending || !!chatSelection || providerSwitchPending || voiceStarting || voiceActive || (state.workspace?.selected && state.workspace.available === false);
    const steering = state.busy && !!state.turnId;
    $('stop').hidden = !state.busy || hasDraft;
    $('send').hidden = !$('stop').hidden;
    $('send').setAttribute('aria-label', steering ? t('진행 중인 작업에 추가 지시') : t('메시지 보내기'));
    $('send').title = steering ? t('추가 지시') : t('보내기'); $('composer-attach').disabled = !!sending;
  }
  function closeComposerAddMenu(restoreFocus = true) {
    if ($('composer-add-menu').hidden) return false;
    $('composer-add-menu').hidden = true; $('add-attachment').setAttribute('aria-expanded', 'false');
    if (restoreFocus) $('add-attachment').focus();
    return true;
  }
  function openComposerAddMenu(last = false) {
    hideAutocomplete(); updateSend(); $('composer-add-menu').hidden = false; $('add-attachment').setAttribute('aria-expanded', 'true');
    const choices = [...$('composer-add-menu').querySelectorAll('button:not(:disabled)')];
    (last ? choices.at(-1) : choices[0])?.focus();
  }
  let chatTouch = null, unreadAssistantOutput = false;
  function updateJumpLatest() {
    if (following) unreadAssistantOutput = false;
    $('jump-latest').hidden = !unreadAssistantOutput || !state.messages.length;
  }
  function pauseFollowing() { following = false; updateJumpLatest(); }
  function scrollLatest() {
    following = true;
    const area = $('chat-scroll'), height = area.scrollHeight;
    if (height - area.scrollTop - area.clientHeight > 1) area.scrollTop = height;
    historyView.top = area.scrollTop;
    updateJumpLatest();
  }
  function followLatest() { if (following && !chatTouch) scrollLatest(); }
  function chatReadingTop() {
    return document.documentElement.hasAttribute('data-liquid-glass')
      ? document.querySelector('.topbar').getBoundingClientRect().bottom
      : $('chat-scroll').getBoundingClientRect().top;
  }
  function readingPosition() { return following ? null : visibleMessageAnchor(); }
  function toggleInPlace(control, toggle) {
    const area = $('chat-scroll'), top = control.getBoundingClientRect().top;
    following = false;
    toggle();
    area.scrollTop += control.getBoundingClientRect().top - top;
    historyView.top = area.scrollTop;
    updateJumpLatest();
  }
  function restoreReadingPosition(anchor) {
    if (!anchor || following) return;
    const area = $('chat-scroll');
    const rows = [...$('messages').children];
    let element = anchor.id && rows.find(el => el.dataset.id === anchor.id);
    if (element?.hidden) {
      const summary = element.dataset.workSummary;
      element = summary ? rows.find(el => el.dataset.id === summary) : null;
    }
    // Keep the same line on screen when a snapshot changes content above it.
    const adjustment = element ? element.getBoundingClientRect().top - chatReadingTop() - anchor.offset : 0;
    if (element) { if (adjustment) area.scrollTop += adjustment; }
    else area.scrollTop = anchor.scrollTop;
    historyView.top = area.scrollTop;
    updateJumpLatest();
  }
  let composerFramePending = false, composerMeasureKey = '', composerLayoutKey = '', composerMeasuredHeight = 0, viewportFramePending = false;
  function updateComposerExpansion() { sizeComposer(); }
  function revealComposerSelection(field, styles, line) {
    const range = document.createRange();
    if (typeof range.getBoundingClientRect !== 'function') return;
    const mirror = document.createElement('div');
    mirror.setAttribute('aria-hidden', 'true');
    for (const property of ['fontFamily','fontSize','fontWeight','fontStyle','fontStretch','fontVariant','fontFeatureSettings','fontVariationSettings','lineHeight','letterSpacing','wordSpacing','textIndent','textAlign','textTransform','direction','tabSize','whiteSpace','wordBreak','overflowWrap','paddingTop','paddingRight','paddingBottom','paddingLeft']) mirror.style[property] = styles[property];
    Object.assign(mirror.style, {position:'fixed', left:'-10000px', top:'0', visibility:'hidden', pointerEvents:'none', contain:'layout style paint', boxSizing:'border-box', width:field.clientWidth + 'px'});
    // A real text range accounts for wrapping; it never changes the textarea's selection.
    const text = document.createTextNode(field.value + '\u200b');
    mirror.append(text); document.body.append(mirror);
    try {
      const position = field.selectionDirection === 'backward' ? field.selectionStart : field.selectionEnd;
      range.setStart(text, position); range.collapse(true);
      let rect = range.getBoundingClientRect();
      if (!rect.height) { range.setEnd(text, position + 1); rect = range.getBoundingClientRect(); }
      if (!rect.height) return;
      const paddingTop = parseFloat(styles.paddingTop) || 0, paddingBottom = parseFloat(styles.paddingBottom) || 0;
      const row = Math.max(0, Math.round((rect.top - mirror.getBoundingClientRect().top - paddingTop) / line));
      const top = paddingTop + row * line, bottom = top + line;
      if (top < field.scrollTop + paddingTop) field.scrollTop = top - paddingTop;
      else if (bottom > field.scrollTop + field.clientHeight - paddingBottom) field.scrollTop = bottom - field.clientHeight + paddingBottom;
    } finally { mirror.remove(); }
  }
  function measureComposer() {
    composerFramePending = false;
    const field = $('prompt');
    const height = window.visualViewport?.height || window.innerHeight;
    const key = [field.value, field.clientWidth, height, textSizePercent].join('\u0000');
    if (key === composerMeasureKey) return;
    composerMeasureKey = key;
    const styles = getComputedStyle(field), line = parseFloat(styles.lineHeight) || 24;
    const padding = (parseFloat(styles.paddingTop) || 0) + (parseFloat(styles.paddingBottom) || 0);
    const cssMax = parseFloat(styles.maxHeight);
    const cap = Math.min(Number.isFinite(cssMax) ? cssMax : Infinity, Math.max(line + padding, Math.min(line * 4 + padding, height * .27)));
    const scrollTop = field.scrollTop;
    field.style.height = 'auto';
    const contentHeight = field.scrollHeight;
    field.style.height = Math.min(Math.max(line + padding, contentHeight), cap) + 'px';
    field.style.overflowY = contentHeight > cap ? 'auto' : 'hidden';
    field.scrollTop = scrollTop;
    const layoutKey = [field.clientWidth, line, padding, textSizePercent].join('\u0000');
    if ((layoutKey !== composerLayoutKey || field.clientHeight !== composerMeasuredHeight) && document.activeElement === field && field.clientHeight && contentHeight > field.clientHeight) revealComposerSelection(field, styles, line);
    composerLayoutKey = layoutKey; composerMeasuredHeight = field.clientHeight;
    followLatest();
  }
  function sizeComposer() {
    updateSend();
    if (composerFramePending) return;
    composerFramePending = true;
    frame(() => { if (composerFramePending) measureComposer(); });
  }
  function viewportChanged() {
    if (viewportFramePending) return;
    viewportFramePending = true;
    frame(() => {
      viewportFramePending = false;
      const visual = window.visualViewport, height = visual && visual.scale === 1 ? Math.min(window.innerHeight, visual.height) : window.innerHeight;
      document.documentElement.style.setProperty('--app-height', height + 'px');
      // Resize the composer in this viewport frame so the keyboard cannot leave it one frame behind.
      updateSend(); measureComposer(); positionModelPicker();
      if (!matchMedia('(max-width:760px)').matches) {
        document.body.classList.remove('sidebar-open'); $('scrim').hidden = true;
        $('sidebar').inert = false; document.querySelector('main').inert = false;
      } else $('sidebar').inert = !document.body.classList.contains('sidebar-open');
    });
  }
  function shortModelName(value) {
    return String(value || '').replace(/^[^·]+\s*·\s*/, '').split('/').pop().trim();
  }
  function optionsSummary() {

    const model = $('model').selectedOptions[0]?.textContent || t('모델 목록 조회 필요');
    const effort = $('effort').selectedOptions[0]?.textContent || t('추론 설정 정보 없음');
    const approval = $('approval-mode').selectedOptions[0]?.textContent || t('자동 검토');
    $('model-summary').textContent = shortModelName(model);
    $('effort-summary').textContent = $('effort').value ? effort : '';
    $('composer-options').setAttribute('aria-label', t('작업 설정: ') + model + t(', 추론 ') + effort + t(', 승인 ') + approval);
    $('composer-options').title = model + ' · ' + effort;
    $('approval-mode').title = t('Codex 승인 방식') + ': ' + approval;
    $('approval-mode').setAttribute('aria-label', t('Codex 승인 방식'));
    $('permission-help').textContent = state.busy ? t('작업이 끝나면 권한을 변경할 수 있습니다.') : ({'read-only':t('파일을 읽고 검토합니다.'), 'workspace-write':t('선택한 프로젝트의 파일을 수정할 수 있습니다.'), 'danger-full-access':t('앱에 허용된 기기 파일과 명령에 접근할 수 있습니다.')}[$('permissions').value] || '');
    syncReasoningPicker();
  }
  function positionModelPicker() {
    const picker = $('model-picker'); if (!picker.open) return;
    const anchor = $('composer-options').getBoundingClientRect(), viewport = window.visualViewport;
    const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
    const width = viewport?.width || innerWidth, height = viewport?.height || innerHeight;
    const availableAbove = anchor.top - top - 20, availableBelow = top + height - anchor.bottom - 20;
    const below = availableAbove < 220 && availableBelow > availableAbove;
    picker.style.left = Math.max(left + 12, Math.min(anchor.left, left + width - picker.offsetWidth - 12)) + 'px';
    picker.style.top = below ? anchor.bottom + 8 + 'px' : 'auto';
    picker.style.bottom = below ? 'auto' : innerHeight - anchor.top + 8 + 'px';
    picker.style.maxHeight = Math.max(100, below ? availableBelow : availableAbove) + 'px';
  }
  function sizeModelPicker() {
    if (!$('model-picker').open) return;
    const panel = $('model-picker').classList.contains('show-models') ? $('model-panel') : $('reasoning-panel');
    $('model-picker-panels').style.height = panel.scrollHeight + 'px';
    positionModelPicker();
  }
  function showModelPanel(models, focus = true) {
    $('model-picker').classList.toggle('show-models', models);
    $('reasoning-panel').inert = models; $('model-panel').inert = !models;
    $('reasoning-panel').setAttribute('aria-hidden', String(models)); $('model-panel').setAttribute('aria-hidden', String(!models));
    $('model-picker-model').setAttribute('aria-expanded', String(models));
    $('model-picker-title').textContent = t(models ? '모델' : '설정');
    sizeModelPicker();
    if (focus) (models ? $('model-list').querySelector('input:checked, input') || $('model-picker-back') : $('model-picker-model')).focus({preventScroll:true});
  }
  function previewReasoning() {
    const options = [...$('effort').options].filter(option => option.value), slider = $('effort-slider');
    const option = options[Number(slider.value)];
    $('reasoning-control').dataset.effort = option?.value || '';
    if (option && $('effort').value) $('effort-heading').textContent = option.textContent;
    [...$('effort-levels').children].forEach((level, index) => level.classList.toggle('selected', index === Number(slider.value)));
    slider.setAttribute('aria-valuetext', option?.textContent || t('추론 강도 조절 미지원'));
    slider.style.setProperty('--effort-fill', (options.length > 1 ? Number(slider.value) / (options.length - 1) * 100 : 0) + '%');
  }
  let reasoningSignature = '';
  function syncReasoningPicker() {
    const options = [...$('effort').options].filter(option => option.value), slider = $('effort-slider');
    const signature = JSON.stringify([state.models, $('model').value, $('effort').value, L.language()]);
    if (signature === reasoningSignature) return;
    reasoningSignature = signature;
    $('model-heading').textContent = shortModelName($('model').selectedOptions[0]?.textContent || t('모델 목록 조회 필요'));
    $('effort-heading').textContent = $('effort').value;
    slider.max = String(Math.max(0, options.length - 1));
    slider.value = String(Math.max(0, options.findIndex(option => option.value === $('effort').value)));
    slider.disabled = options.length < 2;
    $('reasoning-control').hidden = !options.length;
    const ticks = $('effort-levels');
    ticks.replaceChildren(...options.map(option => node('span', option.textContent)));
    const quick = $('api-effort-settings'), select = $('api-effort-choice');
    if (quick && select) {
      quick.hidden = !state.apiActive || !options.length;
      select.replaceChildren(...options.map(option => new Option(option.textContent, option.value)));
      select.value = $('effort').value;
      $('api-effort-current').textContent = $('model').value;
    }
    previewReasoning(); sizeModelPicker();
  }
  function refreshPickerModels() {
    const generation = ++modelRefreshGeneration, status = $('model-refresh-status');
    status.textContent = t('모델 목록 확인 중…'); status.hidden = false;
    call('models.refresh').then(() => {
      if (generation === modelRefreshGeneration) status.hidden = true;
    }).catch(() => {
      if (generation !== modelRefreshGeneration) return;
      status.textContent = t('모델 목록을 갱신하지 못했습니다. 이전 목록을 표시합니다.');
    });
  }
  function syncPermissionControls(mode, disabled = !!state.busy) {
    const value = ['read-only','workspace-write','danger-full-access'].includes(mode) ? mode : 'workspace-write';
    $('permissions').value = value; $('permissions').disabled = disabled;
    document.querySelectorAll('input[name="permission"]').forEach(r => { r.checked = r.value === value; r.disabled = disabled; });
  }
  function syncApprovalControl(disabled = !!state.busy) {
    const select = $('approval-mode'); select.value = state.approvalMode || 'auto-review'; select.disabled = disabled;
  }
  async function setApprovalMode(mode) {
    const previous = state.approvalMode || 'auto-review';
    $('approval-mode').disabled = true;
    try { await call('approvals.set', {mode}); state.approvalMode = mode; }
    catch (error) { $('approval-mode').value = previous; throw error; }
    finally { $('approval-mode').value = state.approvalMode || previous; $('approval-mode').disabled = !!state.busy; optionsSummary(); }
  }
  async function setPermissionMode(mode) {
    const previous = state.permissions || 'workspace-write';
    syncPermissionControls(mode, true); optionsSummary();
    try { await call('permissions.set', {mode}); state.permissions = mode; }
    catch (error) { syncPermissionControls(previous, !!state.busy); throw error; }
    finally { syncPermissionControls(state.permissions, !!state.busy); optionsSummary(); }
  }
  async function insertToken(token, item) {
    const scope = draftScope, field = $('prompt'), start = field.selectionStart, end = field.selectionEnd, original = field.value, selectedToken = (item.kind === 'skill' ? '$' : '@') + item.name, before = original.slice(0, start).replace(/(?:^|\s)[@$][^\s@#$]*$/, m => m.slice(0, m.lastIndexOf(token)) + selectedToken);
    let mention = null;
    if (item.kind === 'mention' && !draftContext.mentions.some(x => x.path === item.path)) {
      mention = item.path.startsWith('app://') ? {name:item.name, path:item.path} : await call('files.mention', {path:item.path});
    }
    if (scope !== draftScope || field.value !== original) return;
    field.value = before + ' ' + original.slice(end); field.selectionStart = field.selectionEnd = before.length + 1;
    if (item.kind === 'skill' && !draftContext.skills.some(x => x.path === item.path || x.name === item.name)) draftContext.skills.push({name:item.name, path:item.path});
    if (mention) draftContext.mentions.push({name:mention.name || item.name, path:mention.path || item.path});
    hideAutocomplete(); renderDraftContext(); saveDraft(); sizeComposer(); field.focus();
  }
  function insertParticipant(id) {
    const field = $('prompt'), start = field.selectionStart, original = field.value;
    const before = original.slice(0, start).replace(/@[^\s@#$]*$/, '@' + id);
    field.value = before + ' ' + original.slice(field.selectionEnd).replace(/^ /, ''); field.selectionStart = field.selectionEnd = before.length + 1;
    hideAutocomplete(); saveDraft(); sizeComposer(); updateSend(); field.focus();
  }
  function hideAutocomplete() {
    autocomplete = {...autocomplete, version:autocomplete.version + 1, items:[], index:-1};
    $('autocomplete').hidden = true; $('autocomplete').replaceChildren(); $('prompt').setAttribute('aria-expanded', 'false');
  }
  function chooseAutocomplete(item) {
    if (item.run) return item.run();
    return insertToken(autocomplete.token, item);
  }
  function drawAutocomplete(items, messages = []) {
    const target = $('autocomplete'); target.replaceChildren(); autocomplete.items = items; autocomplete.index = items.length ? 0 : -1;
    target.append(node('div', autocomplete.type === '$' ? t('스킬') : t('파일 및 앱'), 'autocomplete-heading'));
    for (const [index, item] of items.entries()) {
      const row = button('', () => chooseAutocomplete(item), 'autocomplete-item'); row.setAttribute('role', 'option');
      row.id = 'context-option-' + index; row.dataset.index = String(index);
      row.append(node('strong', item.label || item.name), node('small', item.detail || item.path || ''));
      target.append(row);
    }
    for (const message of messages) { const status = node('p', message, 'autocomplete-status'); status.setAttribute('role', 'status'); target.append(status); }
    target.hidden = false; $('prompt').setAttribute('aria-expanded', 'true'); updateAutocompleteActive();
  }
  function updateAutocompleteActive() {
    $('autocomplete').querySelectorAll('.autocomplete-item').forEach((el, i) => el.setAttribute('aria-selected', String(i === autocomplete.index)));
    if (autocomplete.index >= 0) $('prompt').setAttribute('aria-activedescendant', 'context-option-' + autocomplete.index);
    else $('prompt').removeAttribute('aria-activedescendant');
  }
  async function queryAutocomplete(directory = '') {
    const field = $('prompt'), before = field.value.slice(0, field.selectionStart), match = before.match(/(?:^|\s)([@$])([^\s@#$]*)$/);
    if (!match) return hideAutocomplete();
    const type = match[1], query = directory ? '' : match[2], version = ++autocomplete.version, scope = draftScope;
    autocomplete.type = type; autocomplete.token = type + query;
    const current = () => version === autocomplete.version && scope === draftScope;
    const retry = {label:t('다시 불러오기'), detail:t('사용 가능한 목록을 새로 확인합니다.'), run:() => queryAutocomplete(directory)};
    drawAutocomplete([], [t('사용 가능한 ') + (type === '$' ? t('스킬') : t('파일 및 앱')) + t('을 불러오는 중…')]);
    if (type === '$') {
      try {
        const result = await rpc('skills/list', {cwds:state.cwd ? [state.cwd] : [], forceReload:true});
        if (!current()) return;
        const items = [], seen = new Set(), messages = [];
        for (const group of result.data || []) {
          for (const error of group.errors || []) messages.push(error.message || t('일부 스킬을 읽지 못했습니다.'));
          for (const skill of group.skills || []) {
            if (skill.enabled === false || !skill.name || !skill.path || seen.has(skill.path)) continue;
            if (query && !(skill.name + ' ' + (skill.description || '')).toLowerCase().includes(query.toLowerCase())) continue;
            seen.add(skill.path); items.push({kind:'skill', name:skill.name, path:skill.path, label:'$' + skill.name, detail:skill.description || skill.path});
          }
        }
        if (!items.length) messages.push(query ? t('일치하는 스킬이 없습니다.') : t('사용 가능한 스킬이 없습니다. 스킬 폴더를 가져와 추가하세요.'));
        drawAutocomplete([...items, {label:t('스킬 가져오기'), detail:t('SKILL.md가 들어 있는 폴더 선택'), run:() => { hideAutocomplete(); $('skill-import').click(); }}], messages);
      } catch (error) {
        if (current()) drawAutocomplete([retry], [t('스킬 목록을 불러오지 못했습니다. ') + error.message]);
      }
      return;
    }
    const sections = {files:[], apps:[]}, messages = {files:t('파일을 불러오는 중…'), apps:t('앱을 불러오는 중…')};
    // Calling a participant is plain text in the message; Engine reads it to pick who answers.
    const people = directory ? [] : (agentUi?.mentionChoices(query) || []).map(p => ({label:'@' + p.id, detail:p.id === 'all' ? t('참가자 모두 호출') : t('{name} 호출', {name:p.name}), run:() => insertParticipant(p.id)}));
    const render = () => { if (current()) drawAutocomplete([...people, ...sections.files, ...sections.apps], Object.values(messages).filter(Boolean)); };
    // Render each source when ready: a slow app connection must not hide local files.
    const filesRequest = state.workspace?.selected
      ? call(query ? 'files.search' : 'files.list', query ? {query} : {path:directory})
      : Promise.resolve({entries:[]});
    filesRequest.then(result => {
      if (!current()) return;
      sections.files = (result.entries || []).filter(x => x.path).map(x => x.directory
        ? {label:x.name + '/', detail:t('폴더 열기'), run:() => queryAutocomplete(x.path)}
        : {kind:'mention', name:x.name || C.basename(x.path), path:x.path, label:'@' + (x.name || C.basename(x.path)), detail:t('파일 · ') + x.path});
      if (directory && !query) sections.files.unshift({label:t('상위 폴더'), detail:directory, run:() => queryAutocomplete(directory.split('/').slice(0,-1).join('/'))});
      messages.files = !state.workspace?.selected ? t('프로젝트를 선택하면 파일 목록도 표시됩니다.') : sections.files.length ? '' : t('일치하는 파일이 없습니다.');
      render();
    }).catch(error => { if (current()) { messages.files = t('파일 목록을 불러오지 못했습니다. ') + error.message; sections.files = [retry]; render(); } });
    rpc('app/list', {}).then(result => {
      if (!current()) return;
      sections.apps = (result.data || result.apps || []).filter(x => x.isAccessible && x.isEnabled && (!query || (x.name || x.id || '').toLowerCase().includes(query.toLowerCase())))
        .map(x => ({kind:'mention', name:x.name || x.id, path:'app://' + x.id, label:'@' + (x.name || x.id), detail:t('연결된 앱')}));
      messages.apps = sections.apps.length ? '' : t('사용 가능한 연결 앱이 없습니다.'); render();
    }).catch(error => { if (current()) { messages.apps = t('앱 목록을 불러오지 못했습니다. ') + error.message; if (!sections.files.includes(retry)) sections.apps = [retry]; render(); } });
  }
  async function chooseAttachment() {
    const key = draftKeyFor(), result = await call('attachments.pick', {draftKey:key});
    acceptPickedAttachments(result, key);
  }
  function acceptPickedAttachments(result, receiptKey) {
    if (!result) return;
    const key = result.draftKey || receiptKey || draftKeyFor(), receipt = result.receiptId || '';
    if (receipt && handledReceipts.has(receipt)) return;
    const scope = 'draft:' + key, context = scope === draftScope ? draftContext : restoreContext(scope), ids = new Set(context.attachments.map(x => x.id));
    context.attachments.push(...(result.attachments || []).filter(x => x?.id && !ids.has(x.id)));
    try { if (context.attachments.length || context.mentions.length || context.skills.length) localStorage.setItem(contextScope(scope), JSON.stringify(context)); }
    catch { toast(t('첨부 초안을 저장할 공간이 부족합니다. 첨부를 줄인 뒤 다시 시도해 주세요.')); return; }
    if (scope === draftScope) { draftContext = context; renderDraftContext(); updateSend(); }
    if (result.errors?.length && !result.cancelled) toast(result.errors.join('\n'));
    if (receipt) { handledReceipts.add(receipt); call('attachments.ack', {receiptId:receipt}).catch(() => {}); }
  }
  async function startVoiceInput() {
    if (voiceStarting || voiceActive || !draftScope || sending) return;
    const field = $('prompt'); saveDraft(); hideAutocomplete();
    const draft = {scope:draftKeyFor(), original:field.value, start:field.selectionStart, end:field.selectionEnd};
    field.blur(); voiceStarting = true; updateSend();
    try { await call('voice.start', draft); }
    finally { voiceStarting = false; updateSend(); await recoverVoiceInput(); }
  }
  function drawDictation(value) {
    dictationState = value || {phase:'idle'};
    const phase = dictationState.phase || 'idle', active = phase !== 'idle';
    $('dictation').hidden = !active;
    $('prompt').readOnly = active;
    $('dictation-status').textContent = ({permission:t('마이크 권한 확인 중'), starting:t('마이크 준비 중…'), listening:t('듣고 있어요…'), transcribing:t('음성을 텍스트로 바꾸는 중…')})[phase] || '';
    $('dictation-preview').textContent = dictationState.partial || '';
    $('dictation-level').value = Number(dictationState.level) || 0;
    $('dictation-done').disabled = phase !== 'listening';
    clearInterval(dictationTimer); dictationTimer = null;
    const base = Date.now(), elapsed = Number(dictationState.elapsedMs) || 0;
    const tick = () => { const seconds = Math.floor((elapsed + (phase === 'listening' ? Date.now() - base : 0)) / 1000); $('dictation-time').textContent = Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2,'0'); };
    tick(); if (phase === 'listening') dictationTimer = setInterval(tick, 1000);
    voiceActive = active; updateComposerExpansion(); updateSend(); viewportChanged();
  }
  function mergeVoiceText(current, result) {
    if (!result.text) return current;
    if (current === result.original) {
      const start = Math.max(0, Math.min(current.length, Number.isInteger(result.start) ? result.start : current.length));
      const end = Math.max(start, Math.min(current.length, Number.isInteger(result.end) ? result.end : start));
      return current.slice(0, start) + result.text + current.slice(end);
    }
    return current + (!current || /\s$/.test(current) ? '' : '\n') + result.text;
  }
  function acceptVoiceReceipt(result) {
    if (!result || result.origin !== 'main' || !result.receiptId || !result.scope || handledVoiceReceipts.has(result.receiptId)) return;
    const scope = 'draft:' + result.scope, marker = 'voice-receipt:' + result.receiptId;
    try {
      let journal = JSON.parse(localStorage.getItem(marker) || 'null');
      if (!journal?.done) {
        const current = scope === draftScope ? $('prompt').value : localStorage.getItem(scope) || '';
        if (!journal) {
          journal = {before:current, after:mergeVoiceText(current, result)};
          localStorage.setItem(marker, JSON.stringify(journal));
        }
        // A process restart between saving the draft and its completion marker must not append twice.
        const merged = current === journal.before || current === journal.after ? journal.after : mergeVoiceText(current, {...result, original:null});
        localStorage.setItem(scope, merged);
        localStorage.setItem(marker, JSON.stringify({done:true}));
        if (scope === draftScope) { $('prompt').value = merged; sizeComposer(); }
        if (result.error) toast(result.error);
        else if (result.text && scope !== draftScope) toast(t('원래 대화의 음성 초안을 저장했습니다.'));
      }
      handledVoiceReceipts.add(result.receiptId);
      call('voice.ack', {receiptId:result.receiptId}).then(() => localStorage.removeItem(marker)).catch(() => {});
    } catch { toast(t('음성 초안을 저장하지 못했습니다. 저장 공간을 확인한 뒤 앱을 다시 열어 주세요.')); }
  }
  async function recoverVoiceInput() {
    const generation = ++voiceRecoveryGeneration;
    try {
      const result = await call('voice.recover');
      if (generation !== voiceRecoveryGeneration) return;
      if (result.dictation) drawDictation(result.dictation);
      voiceActive = !!result.active; updateSend();
      for (const receipt of result.receipts || []) acceptVoiceReceipt(receipt);
    } catch { /* Receipts remain native until the next resume or startup. */ }
  }
  function drawUpdates(value) {
    if (!value || (Number.isFinite(value.revision) && value.revision < (updateState.revision || 0))) return;
    updateState = value;
    const busy = !!value.busy || updateRequestPending, release = value.candidate;
    if (value.versionName) { $('update-current').textContent = t('현재 ') + value.versionName + t(' · 빌드 ') + value.versionCode; $('app-version').textContent = value.versionName; }
    if (!updateSourceDirty) { if (value.repository) $('update-repository').value = value.repository; if (typeof value.prereleases === 'boolean') $('update-prereleases').checked = value.prereleases; }
    $('update-repository').disabled = busy; $('update-prereleases').disabled = busy; $('update-check').disabled = busy;
    $('update-status').textContent = value.message || t('업데이트 확인을 누르면 공개 릴리스를 조회합니다.');
    $('update-cancel').hidden = !value.canCancel; $('update-cancel').disabled = updateRequestPending;
    $('update-progress').hidden = !['downloading','verifying'].includes(value.status);
    const percent = release?.size ? Math.max(0, Math.min(100, 100 * (value.received || 0) / release.size)) : 0;
    $('update-progress').value = percent;
    $('update-release').hidden = !release;
    $('update-version').textContent = release ? t('공개 릴리스 ') + release.versionName : '';
    $('update-size').textContent = release ? (release.size / 1048576).toFixed(1) + ' MiB' + (value.status === 'downloading' ? ' · ' + Math.floor(percent) + '%' : '') : '';
    $('update-notes').textContent = release?.notes || '';
    $('update-download').hidden = !value.available || !!value.ready; $('update-download').disabled = busy || updateSourceDirty;
    $('update-permission').hidden = !value.ready || !!value.canInstall; $('update-permission').disabled = busy;
    $('update-install').hidden = !value.ready; $('update-install').disabled = busy || updateSourceDirty || !value.canInstall || state.busy;
    $('update-clear').hidden = !value.ready && !value.hasDownload; $('update-clear').disabled = busy;
  }
  async function loadUpdates() { try { drawUpdates(await call('updates.state')); } catch(error) { $('update-status').textContent = error.message; } }
  async function updateAction(action) {
    if (updateRequestPending) return;
    updateRequestPending = true; drawUpdates(updateState);
    try {
      if (action === 'check' && updateSourceDirty) {
        const result = await call('updates.configure', {repository:$('update-repository').value.trim(), prereleases:$('update-prereleases').checked});
        updateSourceDirty = false; drawUpdates(result);
      }
      const result = await call('updates.' + action, ['download','install'].includes(action) ? {sha256:updateState.candidate?.sha256 || ''} : {});
      if (result.status) drawUpdates(result);
    } finally { updateRequestPending = false; drawUpdates(updateState); }
  }
  function renderMath(target, formula, source, displayMode = false) {
    const math = node(displayMode ? 'div' : 'span', null, displayMode ? 'chat-math chat-math-display' : 'chat-math');
    try {
      if (window.katex && formula.trim() && formula.length <= 8192) {
        window.katex.render(formula, math, {displayMode, trust:false, maxExpand:500, maxSize:50});
      } else math.textContent = source;
    } catch {
      math.textContent = source;
    }
    target.append(math);
  }
  const inlinePattern = new RegExp([
    /(?<ticks>`+)(?<code>[^`\n]+?)\k<ticks>/,
    /\*\*(?<bold>[^*\n]+)\*\*/,
    /\[(?<label>[^\]]+)\]\((?<url>https?:\/\/[^\s)]+)\)/,
    /\\\((?<parenMath>(?:\\[^)`\r\n]|[^`\\\r\n])*)\\\)/,
    /(?<!\$)\$(?![\s$])(?<dollarMath>(?:\\[^`\r\n]|[^`$\\\r\n])+?)(?<!\s)\$(?![\d$])/,
    /\\[\\$]/
  ].map(token => token.source).join('|'), 'g');
  function inline(target, text) {
    let position = 0;
    for (const match of text.matchAll(inlinePattern)) {
      const {code, bold, label, url, parenMath, dollarMath} = match.groups;
      target.append(document.createTextNode(text.slice(position, match.index)));
      if (code != null) target.append(node('code', code));
      else if (bold != null) {
        const strong = node('strong');
        inline(strong, bold);
        target.append(strong);
      }
      else if (url != null) {
        const link = button(label, () => call('ui.openLink', {url}), 'inline-link');
        link.title = url;
        target.append(link);
      } else if (parenMath != null || dollarMath != null) renderMath(target, parenMath ?? dollarMath, match[0]);
      else target.append(document.createTextNode(match[0]));
      position = match.index + match[0].length;
    }
    target.append(document.createTextNode(text.slice(position)));
  }
  function imageCard(attachment, label = '', gallery = [attachment], group = null) {
    const figure = node('figure', null, 'image-card');
    if (!C.safeImageUrl(attachment.url)) { figure.append(node('p', t('이미지 주소를 읽을 수 없습니다.'), 'muted')); return figure; }
    const open = button('', () => previewImage(attachment, gallery, group), 'image-open');
    open.setAttribute('aria-label', (label || attachment.name || t('생성 이미지')) + t(' 크게 보기'));
    const img = node('img'); img.src = attachment.url; img.alt = label || attachment.name || t('생성 이미지'); img.loading = 'lazy'; img.decoding = 'async';
    if (attachment.width && attachment.height) { img.width = attachment.width; img.height = attachment.height; }
    const error = node('p', t('이미지를 불러오지 못했습니다.'), 'muted'); error.hidden = true;
    img.addEventListener('load', followLatest);
    img.addEventListener('error', () => { error.hidden = false; });
    open.append(img); figure.append(open, error);
    const caption = node('figcaption'); caption.append(node('span', attachment.name || label || t('이미지')));
    if (attachment.id) caption.append(button(t('저장'), () => call('images.export', {id:attachment.id, name:attachment.name})));
    figure.append(caption); return figure;
  }
  function previewImage(attachment, gallery = [attachment], group = null) {
    if (!C.safeImageUrl(attachment.url)) return;
    viewerImages = gallery.filter(a => a && C.safeImageUrl(a.url)); viewerIndex = Math.max(0, viewerImages.indexOf(attachment)); viewerGroup = group;
    updateViewer(); show('image-dialog');
  }
  function updateViewer(reset = true) {
    const attachment = viewerImages[viewerIndex]; if (!attachment) return; openedImage = attachment;
    $('image-title').textContent = attachment.name || t('이미지'); $('image-preview').src = attachment.url;
    $('image-preview').alt = attachment.name || t('이미지'); $('image-save').hidden = !attachment.id;
    $('image-counter').textContent = (viewerIndex + 1) + ' / ' + viewerImages.length;
    $('image-navigation').hidden = viewerImages.length < 2;
    $('image-prev').disabled = viewerIndex === 0; $('image-next').disabled = viewerIndex === viewerImages.length - 1;
    $('image-thumbnails').replaceChildren(); $('image-thumbnails').hidden = viewerImages.length < 2;
    viewerImages.forEach((item, i) => {
      const b = button('', () => { viewerIndex = i; updateViewer(); }, 'image-thumbnail');
      b.setAttribute('aria-label', (i+1) + t('번째 이미지')); b.setAttribute('aria-current', String(i === viewerIndex));
      const img = node('img'); img.src = item.url; img.alt = ''; img.loading = 'lazy'; b.append(img); $('image-thumbnails').append(b);
    });
    if (reset) { $('image-stage').classList.remove('zoomed'); $('image-stage').scrollTop = 0; $('image-stage').scrollLeft = 0; $('image-zoom').setAttribute('aria-pressed', 'false'); }
  }
  function changeImage(delta) {
    const next = viewerIndex + delta;
    if (next < 0 || next >= viewerImages.length) return;
    viewerIndex = next; updateViewer();
  }
  function imageGallery(attachments, group) {
    const gallery = node('div', null, 'image-gallery'); gallery.classList.toggle('multiple', attachments.length > 1);
    gallery.setAttribute('aria-label', t('이미지 ') + attachments.length + t('장'));
    for (const attachment of attachments) gallery.append(imageCard(attachment, '', attachments, group));
    if (viewerGroup === group && $('image-dialog').open) {
      viewerImages = attachments.filter(a => C.safeImageUrl(a.url));
      viewerIndex = Math.max(0, viewerImages.findIndex(a => a.id === openedImage?.id)); updateViewer(false);
    }
    return gallery;
  }
  function sentAttachments(attachments) {
    const wrap = node('div', null, 'sent-attachments');
    for (const attachment of attachments || []) {
      if (attachment.image?.url || attachment.url) wrap.append(imageCard(attachment.image || attachment, attachment.name));
      else {
        const b = button(attachment.name || t('첨부 파일'), () => call('attachments.export', {id:attachment.id, name:attachment.name}), 'attachment-download');
        b.prepend(icon('file')); wrap.append(b);
      }
    }
    return wrap;
  }
  function imageReference(target, path, label) {
    if (!C.localImagePath(path)) { target.append(node('span', label || path)); return; }
    let gallery = target.lastElementChild;
    if (!gallery?.classList.contains('markdown-gallery')) { gallery = node('div', null, 'image-gallery markdown-gallery'); gallery.attachments = []; target.append(gallery); }
    const index = gallery.attachments.length; gallery.attachments.push(null); gallery.classList.toggle('multiple', gallery.attachments.length > 1);
    const placeholder = node('div', t('이미지 불러오는 중…'), 'image-placeholder'); gallery.append(placeholder);
    const key = (state.workspace.key || state.cwd || '') + '\n' + path;
    if (!imageReads.has(key)) {
      const request = call('images.read', {path}); imageReads.set(key, request);
      request.catch(() => imageReads.delete(key));
    }
    imageReads.get(key).then(attachment => {
      if (placeholder.isConnected) { gallery.attachments[index] = attachment; placeholder.replaceWith(imageCard(attachment, label, gallery.attachments)); }
    }).catch(e => { if (placeholder.isConnected) placeholder.textContent = t('이미지를 불러오지 못했습니다: ') + e.message; });
  }
  async function copyText(text, btn, normalText = t('복사'), copiedText = t('복사됨!')) {
    const finish = () => {
      btn.textContent = copiedText;
      setTimeout(() => {
        if (btn.isConnected) {
          btn.textContent = normalText;
          btn.prepend(icon('copy'));
        }
      }, 2000);
    };
    try {
      let copied = false;
      if (navigator.clipboard?.writeText) {
        try { await navigator.clipboard.writeText(text); copied = true; } catch { /* Try the native clipboard below. */ }
      }
      if (!copied && window.Native) {
        await call('ui.copyCode', {code: text}); copied = true;
      } else if (!copied && document.execCommand) {
        const ta = document.createElement('textarea');
        const focused = document.activeElement;
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        try { copied = document.execCommand('copy'); }
        finally { ta.remove(); focused?.focus(); }
      }
      if (!copied) throw new Error('Clipboard unavailable');
      finish();
    } catch {
      toast(t('클립보드에 복사하지 못했습니다.'));
    }
  }
  function codeCard(lang, codeText, allowCopy) {
    const card = node('div', null, 'code-card');
    const head = node('div', null, 'code-head');
    const langSpan = node('span', (lang || 'code').trim().toLowerCase(), 'code-lang');
    head.append(langSpan);
    if (allowCopy && codeText) {
      const copy = button(t('복사'), () => copyText(codeText, copy), 'code-copy-btn');
      copy.title = t('코드 복사');
      copy.prepend(icon('copy'));
      head.append(copy);
    }
    const pre = node('pre');
    pre.append(node('code', codeText));
    card.append(head, pre);
    return card;
  }
  function* parseMarkdownBlocks(text) {
    const openings = /```|^[ \t]*(\$\$|\\\[)/gm;
    let start = 0, opening;
    while ((opening = openings.exec(text))) {
      if (opening.index > start) yield {type:'prose', start, content:text.slice(start, opening.index)};
      const bodyStart = openings.lastIndex;
      if (opening[1]) {
        const closing = opening[1] === '$$' ? /(?<!\\)\$\$[ \t]*(?=\r?$)/gm : /\\\][ \t]*(?=\r?$)/gm;
        closing.lastIndex = bodyStart;
        const close = closing.exec(text);
        if (!close) {
          yield {type:'pending', content:text.slice(opening.index)};
          return;
        }
        start = closing.lastIndex;
        yield {type:'math', end:start, content:text.slice(bodyStart, close.index), source:text.slice(opening.index, start)};
      } else {
        const newline = text.indexOf('\n', bodyStart);
        if (newline < 0) {
          yield {type:'pending', content:text.slice(opening.index)};
          return;
        }
        const closing = text.indexOf('```', newline + 1);
        start = closing < 0 ? text.length : closing + 3;
        yield {type:'code', end:closing < 0 ? null : start, lang:text.slice(bodyStart, newline), content:text.slice(newline + 1, closing < 0 ? text.length : closing)};
      }
      openings.lastIndex = start;
    }
    if (start < text.length) yield {type:'prose', start, content:text.slice(start)};
  }
  function tableCells(line) {
    const cells = [''];
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '\\' && (line[i + 1] === '|' || line[i + 1] === '\\')) cells[cells.length - 1] += line[++i];
      else if (ch === '|') cells.push('');
      else cells[cells.length - 1] += ch;
    }
    return cells.slice(1, -1);
  }
  function renderProseLines(target, content) {
    let paragraph = null, list = null;
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) { paragraph = null; list = null; continue; }
      const image = line.match(/^\s*!\[([^\]]*)\]\((?:<([^>]+)>|([^\n]+))\)\s*$/);
      if (image) { imageReference(target, image[2] || image[3], image[1]); paragraph = null; list = null; continue; }
      const isTableRow = /^\s*\|(.+)\|\s*$/.test(line);
      const nextLine = lines[i + 1] || '';
      const isDelimiter = /^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/.test(nextLine);
      if (isTableRow && isDelimiter) {
        paragraph = null; list = null;
        const wrap = node('div', null, 'table-wrap');
        const table = node('table', null, 'markdown-table');
        const thead = node('thead'), headerRow = node('tr');
        const headerCells = tableCells(line);
        for (const cell of headerCells) {
          const th = node('th'); inline(th, cell.trim()); headerRow.append(th);
        }
        thead.append(headerRow); table.append(thead);
        i++;
        const tbody = node('tbody');
        while (i + 1 < lines.length && /^\s*\|(.+)\|\s*$/.test(lines[i + 1])) {
          i++;
          const tr = node('tr');
          const cells = tableCells(lines[i]);
          for (let c = 0; c < headerCells.length; c++) {
            const td = node('td'); inline(td, (cells[c] || '').trim()); tr.append(td);
          }
          tbody.append(tr);
        }
        table.append(tbody); wrap.append(table);
        target.append(wrap);
        continue;
      }
      if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
        target.append(node('hr', null, 'prose-hr'));
        paragraph = null; list = null;
        continue;
      }
      const item = line.match(/^\s*(?:[-*+] |\d+[.)] |[•●◦▪]\s*)(.*)$/), heading = line.match(/^#{1,6} (.*)$/);
      if (item) {
        const tag = /^\s*\d/.test(line) ? 'ol' : 'ul';
        if (!list || list.tagName.toLowerCase() !== tag) { list = node(tag); target.append(list); }
        const li = node('li'); inline(li, item[1]); list.append(li); paragraph = null;
      } else if (heading || line.startsWith('> ')) {
        const block = node(heading ? 'h3' : 'blockquote'); inline(block, heading ? heading[1] : line.slice(2)); target.append(block); paragraph = null; list = null;
      } else {
        list = null;
        if (!paragraph) { paragraph = node('p', null, 'prose-line'); target.append(paragraph); }
        else paragraph.append(document.createTextNode('\n'));
        inline(paragraph, line);
      }
    }
  }
  function prose(target, text, streaming = false) {
    target.replaceChildren();
    // Deliberately construct text nodes: model output and file names cannot inject HTML.
    const blocks = parseMarkdownBlocks(text);
    for (const block of blocks) {
      if (block.type === 'code') target.append(codeCard(block.lang, block.content, !streaming || block.end != null));
      else if (block.type === 'math') renderMath(target, block.content, block.source, true);
      else renderProseLines(target, block.content);
    }
  }
  function renderMessageIconTags(target, streaming) {
    // Replace only assistant prose. Code examples and user messages retain their literal text.
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) {
      const textNode = walker.currentNode;
      if (!textNode.parentElement?.closest('code,pre,button,.chat-math')) nodes.push(textNode);
    }
    for (const textNode of nodes) {
      const text = textNode.nodeValue || '';
      const pattern = streaming
        ? /\[\[\s*icon\s*:\s*([^\]\r\n]*?)\s*\]\]|\[\[\s*(?:i(?:c(?:o(?:n(?:\s*:\s*[^\]\r\n]*\]?)?)?)?)?)?$/gi
        : /\[\[\s*icon\s*:\s*([^\]\r\n]*?)\s*\]\]|\[\[\s*i(?:c(?:o(?:n(?:\s*:\s*[^\]\r\n]*\]?)?)?)?)?$/gi;
      let match, cursor = 0, changed = false;
      const fragment = document.createDocumentFragment();
      while ((match = pattern.exec(text))) {
        changed = true;
        fragment.append(document.createTextNode(text.slice(cursor, match.index)));
        cursor = match.index + match[0].length;
      }
      if (changed) {
        fragment.append(document.createTextNode(text.slice(cursor)));
        textNode.replaceWith(fragment);
      }
    }
    for (const paragraph of target.querySelectorAll('p.prose-line')) {
      if (!paragraph.textContent.trim() && !paragraph.querySelector('img,button')) paragraph.remove();
    }
  }
  // A blank line outside a fence, or a closed fence, ends a block whose
  // Markdown cannot be changed by the next delta.
  function completeProseLength(text) {
    let end = 0;
    for (const block of parseMarkdownBlocks(text)) {
      if (block.type === 'prose') {
        for (const separator of block.content.matchAll(/\n[^\S\n]*\n/g)) end = block.start + separator.index + separator[0].length;
      } else if (block.type === 'code' && block.end != null) end = block.end;
      else if (block.type === 'math' && /[\r\n]/.test(text[block.end] || '')) end = block.end;
    }
    return end;
  }
  const streamViews = new WeakMap();
  function renderStreamProse(target, view, text) {
    if (text === view.text) return;
    for (const child of view.tail) child.remove();
    const pending = text.slice(view.prefix), ready = completeProseLength(pending);
    const append = content => {
      const fragment = document.createDocumentFragment();
      prose(fragment, content, true);
      renderMessageIconTags(fragment, true);
      const children = [...fragment.childNodes];
      target.insertBefore(fragment, view.footer);
      return children;
    };
    if (ready) append(pending.slice(0, ready));
    view.tail = append(pending.slice(ready));
    view.prefix += ready;
    view.text = text;
  }
  const taskActivityLabels = {
    thinking:['思考中', 'Thinking'], reading:['读取文件', 'Reading files'],
    searching:['搜索中', 'Searching'], command:['运行命令', 'Running command'],
    editing:['修改文件', 'Editing files'], tool:['调用工具', 'Using tool'],
    responding:['正在回复', 'Responding'], approval:['等待审批', 'Waiting for approval']
  };
  function taskActivityLabel(kind) {
    const labels = taskActivityLabels[kind] || taskActivityLabels.tool;
    return labels[L.language() === 'zh-CN' ? 0 : 1];
  }
  const taskActivities = new Map(), dirtyActivities = new Set(), evictedActivities = new Set(), activityOutputLimit = 12000;
  let activityFramePending = false, activityStatus = '';
  let progressTimer = 0;
  function drawTurnProgress() {
    const p = state.turnProgress, valid = state.busy && p && state.turnId && p.turnId === state.turnId;
    const visible = !document.hidden;
    if (!valid || !visible) {
      clearInterval(progressTimer); progressTimer = 0;
      if (visible) $('activity-details').title = t('작업 기록');
      return;
    }
    if (!progressTimer) progressTimer = setInterval(drawTurnProgress, 1000);
    const age = stamp => Math.max(0, Math.floor((Date.now() - stamp) / 1000));
    const quiet = age(p.lastEventAt);
    const phase = state.streamRetrying ? '响应流中断，正在重连' : !state.ready ? '本机引擎未连接' :
      quiet >= 30 ? '等待新的任务进展' : p.phase === 'waiting' ? '等待下一步' : taskActivityLabel(p.phase === 'reasoning' ? 'thinking' : p.phase);
    const pendingApproval = [...requestQueue.values()].some(r => requestThread(r) === state.threadId &&
      (!r.params?.turnId || r.params.turnId === state.turnId) && String(r.method).includes('requestApproval'));
    const label = pendingApproval && !state.streamRetrying ? taskActivityLabel('approval') : phase;
    const sinceVisible = age(p.lastVisibleAt ?? p.lastEventAt);
    const timer = state.ready && !state.streamRetrying && !pendingApproval ?
      (L.language() === 'en' ? ` · ${sinceVisible}s since activity` : ` · 思考 ${sinceVisible} 秒了`) : '';
    const status = $('activity-text');
    if (status.textContent !== label + timer) status.textContent = label + timer;
    const engine = !state.ready ? '本机引擎未连接' : !p.engineReplyAt ? '等待本机引擎回应' : `本机引擎 ${age(p.engineReplyAt)} 秒前有回应`;
    $('activity-details').title = engine;
  }
  function showTaskActivity(activity, data) {
    const thread = data.threadId || data.params?.threadId;
    const turn = data.turnId || data.params?.turnId;
    if (!state.busy || !activity || (thread && thread !== state.threadId) ||
        (turn && state.turnId && turn !== state.turnId)) return;
    if (state.persistedWorkActivity && data.method?.match(/^item\/(commandExecution|fileChange)\/outputDelta$/)) {
      const id = `work:${turn}:${activity.key}`, row = messageLookup.get(id);
      if (row && !row.completed) {
        const output = (row.output || '') + activity.output.slice(-4000);
        row.output = output.length > 4000 ? '…\n' + output.slice(-3998) : output;
        scheduleMessageDraw(id);
      }
      return;
    }
    if (!state.liveTaskActivity) {
      if (activity.append || activity.approval) return;
      const anchor = readingPosition();
      const label = taskActivityLabel(activity.kind);
      const status = activity.failed ? label + ' · ' + t('작업 실패') : label;
      $('activity-text').textContent = status;
      if (activity.kind !== 'thinking' && activity.kind !== 'responding') {
        logEvent(activity.completed && !activity.failed ? label + ' · ' + t('완료') : status,
          [activity.detail, activity.output].filter(Boolean).join('\n\n').slice(0, 24000));
      }
      if (following) followLatest(); else restoreReadingPosition(anchor);
      return;
    }
    if (activity.key) {
      const key = JSON.stringify([thread || state.threadId, turn || state.turnId || '', activity.key]);
      let row = taskActivities.get(key);
      if (!row) {
        row = {kind:activity.kind, detail:'', output:'', omitted:false};
        taskActivities.set(key, row);
      }
      // Once finalized, a delayed start or delta cannot overwrite the canonical result.
      if (row.completed && !activity.completed) return;
      if (!activity.append && !activity.approval) row.kind = activity.kind;
      if (activity.detail) row.detail = activity.detail.slice(0, 4000);
      if (activity.approval) { row.approval = data.key; row.reason = activity.reason.slice(0, 2000); }
      if (activity.completed) {
        row.completed = true;
        row.failed = activity.failed;
        row.interrupted = activity.interrupted;
        row.approval = null;
        if (activity.output) { row.output = ''; row.omitted = false; }
      }
      if (activity.output) {
        row.omitted ||= row.output.length + activity.output.length > activityOutputLimit;
        row.output = (row.output + activity.output.slice(-activityOutputLimit)).slice(-activityOutputLimit);
      }
      activityStatus = activityRowStatus(row);
      dirtyActivities.add(key);
      if (taskActivities.size > 16) {
        const oldest = taskActivities.keys().next().value;
        const element = taskActivities.get(oldest).element;
        if (element) evictedActivities.add(element);
        taskActivities.delete(oldest);
        dirtyActivities.delete(oldest);
      }
    } else {
      activityStatus = taskActivityLabel(activity.kind);
    }
    scheduleActivityDraw();
  }
  function activityRowStatus(row, completed = false) {
    const label = taskActivityLabel(row.approval ? 'approval' : row.kind);
    return label + (row.interrupted ? ' · ' + t('작업 중지됨') : row.failed ? ' · ' + t('작업 실패') :
      row.completed && completed ? ' · ' + t('완료') : '');
  }
  function resolveTaskActivity(key) {
    for (const [id, row] of taskActivities) if (row.approval === key) {
      row.approval = null;
      activityStatus = activityRowStatus(row);
      dirtyActivities.add(id);
      scheduleActivityDraw();
    }
  }
  function scheduleActivityDraw() {
    if (activityFramePending) return;
    activityFramePending = true;
    frame(() => {
      activityFramePending = false;
      if (!state.busy || (!dirtyActivities.size && !activityStatus)) return;
      const anchor = readingPosition();
      const viewportChanged = dirtyActivities.size > 0 || evictedActivities.size > 0;
      for (const element of evictedActivities) element.remove();
      evictedActivities.clear();
      for (const key of dirtyActivities) {
        const row = taskActivities.get(key);
        if (!row) continue;
        if (!row.element) {
          row.element = node('details', null, 'task-activity-row');
          row.label = node('span'); row.preview = node('span', null, 'task-activity-preview'); row.body = node('pre', null, 'console');
          const summary = node('summary'); summary.append(row.label, row.preview); row.element.append(summary, row.body);
          $('task-activities').append(row.element);
        }
        row.label.textContent = activityRowStatus(row, true);
        row.preview.textContent = (row.output.slice(-240).trim() || row.detail).split(/\r?\n/).at(-1) || '';
        row.body.textContent = [row.approval ? row.reason : '', row.detail, (row.omitted ? '…\n' : '') + row.output].filter(Boolean).join('\n\n');
      }
      dirtyActivities.clear();
      if (state.turnProgress) drawTurnProgress();
      else if (activityStatus && $('activity-text').textContent !== activityStatus) $('activity-text').textContent = activityStatus;
      activityStatus = '';
      if (viewportChanged) { if (following) followLatest(); else restoreReadingPosition(anchor); }
    });
  }
  function resetTaskActivities() {
    $('task-activities').replaceChildren();
    taskActivities.clear(); dirtyActivities.clear(); evictedActivities.clear(); activityStatus = '';
  }
  function historyStatus(message = '') {
    let status = $('history-status');
    if (!status) { status = node('p', '', 'history-status'); status.id = 'history-status'; status.setAttribute('role','status'); $('history-load').before(status); }
    status.textContent = message; status.hidden = !message;
  }
  function updateHistoryControl() {
    const control = $('history-load');
    control.hidden = !historyView.hasMore || !historyView.beforeId;
    control.disabled = historyView.loading;
    const label = L.language() === 'en' ? 'Load earlier messages' : '加载更早的消息';
    if (control.textContent !== label) control.textContent = label;
  }
  function historySnapshot(next, changedThread) {
    const incoming = next.messages || [], meta = next.messageHistory;
    const total = Number(meta?.total) || incoming.length;
    const overlap = incoming.length ? (state.messages || []).findIndex(m => m.id === incoming[0].id) : -1;
    const retain = !changedThread && meta && historyView.loaded && total >= historyView.total && overlap >= 0;
    if (retain) {
      const ids = new Set(incoming.map(m => m.id));
      next = {...next, messages:[...(state.messages || []).slice(0,overlap).filter(m => !ids.has(m.id)), ...incoming]};
      historyView.total = total;
    } else {
      historyView = {threadId:next.threadId || '', hasMore:meta?.hasMore === true, beforeId:meta?.beforeId || '', total,
        loading:false, loaded:false, top:changedThread ? 0 : $('chat-scroll').scrollTop};
      historyStatus();
    }
    return next;
  }
  function hasNewAssistantOutput(next) {
    const messages = next.messages || [];
    const previous = new Map(state.messages.map(message => [message.id, message]));
    const previousTail = state.messages.at(-1)?.id;
    const tailIndex = previousTail ? messages.findIndex(message => message.id === previousTail) : -1;
    const total = next.messageHistory?.total;
    const previousTotal = state.messageHistory?.total ?? state.messages.length;
    const appended = Number.isInteger(total) ? Math.max(0, total - previousTotal) : previousTotal ? 0 : messages.length;
    const firstNew = tailIndex >= 0 ? tailIndex + 1 : messages.length - appended;
    return messages.some((message, index) => {
      const before = previous.get(message.id);
      if (message.role !== 'assistant' || (message.kind && message.kind !== 'image') || (!before && index < firstNew)) return false;
      const text = !message.kind && message.text?.trim();
      return (text && !(before?.text?.trim() || '').startsWith(text)) ||
        message.images?.some(image => image.id && !before?.images?.some(older => older.id === image.id));
    });
  }
  function visibleMessageAnchor() {
    const area = $('chat-scroll'), top = chatReadingTop();
    const element = [...$('messages').children].find(el => el.dataset.id && !el.hidden && el.getBoundingClientRect().bottom > top);
    return {id:element?.dataset.id, offset:element ? element.getBoundingClientRect().top - top : 0,
      scrollTop:area.scrollTop, height:area.scrollHeight};
  }
  async function loadEarlierMessages(revealOnShortPage = false) {
    const view = historyView;
    if (chatSelection || view.loading || !view.hasMore || !view.beforeId || !state.threadId) return;
    const hadHistory = view.loaded;
    view.loading = true; view.loaded = true;
    updateHistoryControl();
    historyStatus(t('이전 대화 불러오는 중…'));
    try {
      const result = await call('chat.history', {threadId:state.threadId, beforeId:view.beforeId, limit:40});
      if (view !== historyView || view.threadId !== state.threadId) return;
      if (result.threadId !== state.threadId || !Array.isArray(result.messages) || !result.messageHistory)
        throw new Error(t('이전 대화를 불러오지 못했습니다. 위로 올려 다시 시도해 주세요.'));
      // Capture at response time so scrolling while the request is pending is respected.
      const area = $('chat-scroll');
      const revealEarlier = revealOnShortPage && area.scrollHeight <= area.clientHeight;
      const anchor = visibleMessageAnchor(), preservePosition = !following;
      const ids = new Set(state.messages.map(m => m.id)), older = [];
      for (const message of result.messages) if (message.id && !ids.has(message.id)) { ids.add(message.id); older.push(message); }
      state.messages = [...older,...state.messages];
      view.beforeId = result.messageHistory.beforeId || '';
      view.hasMore = result.messageHistory.hasMore === true;
      view.total = Math.max(Number(result.messageHistory.total) || 0, view.total);
      updateHistoryControl();
      historyStatus(); drawMessages(null, false);
      if (preservePosition) {
        const element = [...$('messages').children].find(el => el.dataset.id === anchor.id);
        const adjustment = element ? element.getBoundingClientRect().top - chatReadingTop() - anchor.offset : area.scrollHeight - anchor.height;
        const behavior = area.style.scrollBehavior; area.style.scrollBehavior = 'auto';
        area.scrollTop = revealEarlier ? 0 : anchor.scrollTop + adjustment; area.style.scrollBehavior = behavior;
        view.top = area.scrollTop;
      }
    } catch (_) {
      if (view !== historyView || view.threadId !== state.threadId) return;
      view.loaded = hadHistory;
      historyStatus(L.language() === 'en' ? 'Could not load earlier messages. Try again.' : '无法加载更早的消息，请重试。');
    } finally { if (view === historyView) { view.loading = false; updateHistoryControl(); } }
  }
  function messageDate(value) {
    if (value === undefined || value === null || value === '') return null;
    const date = new Date(value);
    if (!Number.isFinite(date.getTime()) || date.getTime() <= 0) return null;
    const pad = value => String(value).padStart(2,'0');
    const time = node('time', `${pad(date.getMonth()+1)}.${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`, 'message-time');
    time.dateTime = date.toISOString(); time.title = date.toLocaleString(L.language());
    time.setAttribute('aria-label', time.title); return time;
  }
  function agentSpeaker(m) {
    const name = m.agent ? (m.agentName || m.agent) : L.brand('Codex'), label = node('div', null, 'agent-speaker');
    const avatar = node('span', name.slice(0, 1), 'agent-avatar'); avatar.dataset.agent = m.agent || 'codex'; avatar.setAttribute('aria-hidden', 'true');
    label.append(avatar, node('strong', name)); return label;
  }
  const dirtyMessages = new Set(), messageLookup = new Map(), renderedMessages = new Map();
  const pendingToolReplies = new Set(), expandedToolGroups = new Set();
  let messagesFramePending = false, groupedMessages = false;
  function scheduleMessageDraw(id) {
    dirtyMessages.add(id);
    if (messagesFramePending) return;
    messagesFramePending = true;
    frame(() => {
      messagesFramePending = false;
      if (!dirtyMessages.size) return;
      const ids = new Set(dirtyMessages); dirtyMessages.clear();
      drawMessages(ids);
    });
  }
  function emptyAssistantMessage(message) {
    return message.role === 'assistant' && !message.kind && !message.agent && !message.text?.trim() &&
      !message.images?.length && !message.imageStatus && !message.imageError;
  }
  function workFolds(messages) {
    const final = new Map(), folds = new Map();
    messages.forEach((message, index) => {
      if (!message.kind && !message.agent && message.role === 'assistant' && message.completedTurnId &&
          message.text?.trim() && (message.finalForTurn || message.phase === 'final_answer')) {
        final.set(message.completedTurnId, index);
      }
    });
    let section = null;
    messages.forEach((message, index) => {
      if (emptyAssistantMessage(message) || (message.kind === 'taskSummary' && !legacySummaryNotice(message))) return;
      const isTool = message.kind === 'toolActivity';
      const turn = isTool ? message.activityTurnId : message.completedTurnId;
      const commentary = index < final.get(turn) && !message.kind && message.role === 'assistant' &&
        message.text?.trim() && !message.images?.length && !message.finalForTurn &&
        (!message.phase || message.phase === 'commentary');
      if (!final.has(turn) || message.agent || (!isTool && !commentary)) {
        section = null;
        return;
      }
      if (section?.turn !== turn) {
        section = {turn, key:JSON.stringify(['work',state.threadId,turn,message.id]), count:0};
      }
      section.count++;
      folds.set(message.id, section);
    });
    return folds;
  }
  function toolFolds(messages) {
    pendingToolReplies.clear();
    const folds = new Map();
    let rows = [];
    const fold = () => {
      if (!rows.length) return;
      const group = {key:JSON.stringify(['tools',state.threadId,rows[0].id]), commands:0, edits:0, searches:0, other:0};
      for (const row of rows) {
        if (!row.completed) continue;
        if (row.activityKind === 'command') group.commands++;
        else if (row.activityKind === 'editing') group.edits++;
        else if (row.activityKind === 'searching') group.searches++;
        else group.other++;
        folds.set(row.id, group);
      }
      rows = [];
    };
    for (const message of messages) {
      if (message.kind === 'toolActivity') {
        const first = rows[0];
        if (first && (first.activityTurnId !== message.activityTurnId || first.agent !== message.agent)) fold();
        rows.push(message);
      } else if (emptyAssistantMessage(message)) {
        pendingToolReplies.add(message.id);
      } else if (message.kind !== 'taskSummary' || legacySummaryNotice(message)) fold();
    }
    fold();
    return folds;
  }
  function toolGroupLabel({commands, edits, searches, other}) {
    const labels = L.language() === 'zh-CN' ? [
      commands && `运行了 ${commands} 条命令`, searches && `搜索了 ${searches} 次`,
      edits && `${edits} 项文件修改`, other && `${other} 项工具操作`
    ] : [
      commands && `Ran ${commands} command${commands === 1 ? '' : 's'}`,
      searches && `Searched ${searches} time${searches === 1 ? '' : 's'}`,
      edits && `${edits} file change${edits === 1 ? '' : 's'}`,
      other && `${other} tool action${other === 1 ? '' : 's'}`
    ];
    return labels.filter(Boolean).join(' · ');
  }
  function renderWorkRow(message, element) {
    const details = element.firstElementChild || node('details', null, 'task-activity-row');
    if (!details.firstElementChild) {
      const summary = node('summary');
      summary.append(node('span'), node('span', null, 'task-activity-preview'));
      details.append(summary, node('pre', null, 'console'));
      element.append(details);
    }
    const {activityKind:kind, detail, output, completed, failed, interrupted} = message;
    const [label, preview] = details.firstElementChild.children;
    label.textContent = activityRowStatus({kind, completed, failed, interrupted}, true);
    preview.textContent = detail?.split(/\r?\n/)[0] || '';
    details.lastElementChild.textContent = [detail, output].filter(Boolean).join('\n\n');
  }
  function legacySummaryNotice(m) {
    return m.summary?.status === 'failed' ? t('작업 실패') : m.summary?.status === 'interrupted' ? t('작업 중지됨') :
      m.summary?.missingReply ? t('작업이 끝났지만 최종 답변을 받지 못했습니다.') : '';
  }
  function drawMessages(dirtyIds = null, preserveReading = true) {
    const anchor = preserveReading ? readingPosition() : null;
    const allMessages = state.messages || [];
    if (dirtyIds && [...dirtyIds].some(id => !renderedMessages.has(id) ||
        (pendingToolReplies.has(id) && messageLookup.get(id)?.text?.trim()))) dirtyIds = null;
    if (!dirtyIds) {
      dirtyMessages.clear(); messageLookup.clear(); renderedMessages.clear();
      for (const message of allMessages) messageLookup.set(message.id, message);
      groupedMessages = !!agentUi?.grouped() || allMessages.some(message => message.agent);
    }
    const messages = dirtyIds ? [...dirtyIds].map(id => messageLookup.get(id)).filter(Boolean) : allMessages;
    const elements = dirtyIds ? new Map([...dirtyIds].map(id => [id, renderedMessages.get(id)])) : new Map(Array.from($('messages').children).filter(n => n.hasAttribute('data-id')).map(n => [n.dataset.id, n]));
    const keep = new Set();
    const folds = dirtyIds ? null : workFolds(allMessages);
    const tools = dirtyIds ? null : toolFolds(allMessages);
    const positionAfter = el => {
      const next = previous ? previous.nextSibling : $('messages').firstChild;
      if (el !== next) $('messages').insertBefore(el, next);
      previous = el;
    };
    let previous = null;
    const grouped = groupedMessages;
    C.groupImageMessages(messages).forEach(m => {
      if (m.kind === 'taskSummary' && !legacySummaryNotice(m)) return;
      keep.add(m.id); let el = elements.get(m.id);
      if (!el) { el = node('article', null, m.kind === 'toolActivity' ? 'message-tool' : 'message ' + (m.role === 'user' ? 'user' : 'assistant')); el.dataset.id = m.id; }
      if (!dirtyIds) {
        const section = folds.get(m.id);
        const group = tools.get(m.id);
        let workKey = '', workOpen = true;
        if (section) {
          workKey = section.key;
          let control = elements.get(workKey);
          if (!control) {
            control = button('', () => {
              toggleInPlace(control, () => {
                control.setAttribute('aria-expanded', String(control.getAttribute('aria-expanded') !== 'true'));
                drawMessages(null, false);
              });
            }, 'work-toggle');
            control.dataset.id = workKey; control.setAttribute('aria-expanded','false'); elements.set(workKey,control);
          }
          workOpen = control.getAttribute('aria-expanded') === 'true';
          if (!keep.has(workKey)) {
            keep.add(workKey); positionAfter(control);
            control.textContent = (workOpen ? '收起工作过程' : '查看工作过程') + `（${section.count}）`;
          }
        }
        delete el.dataset.workSummary;
        el.hidden = !workOpen || pendingToolReplies.has(m.id);
        if (!workOpen) el.dataset.workSummary = workKey;
        if (group) {
          const {key} = group;
          if (!keep.has(key)) {
            let control = elements.get(key);
            if (!control) {
              control = button('', () => toggleInPlace(control, () => {
                if (!expandedToolGroups.delete(key)) {
                  if (expandedToolGroups.size >= 100) expandedToolGroups.delete(expandedToolGroups.values().next().value);
                  expandedToolGroups.add(key);
                }
                drawMessages(null, false);
              }), 'work-toggle tool-group');
              control.dataset.id = key;
            }
            control.hidden = !workOpen;
            if (workOpen) delete control.dataset.workSummary;
            else control.dataset.workSummary = workKey;
            control.setAttribute('aria-expanded', String(expandedToolGroups.has(key)));
            control.textContent = toolGroupLabel(group);
            keep.add(key); positionAfter(control);
          }
          if (workOpen) el.dataset.workSummary = key;
          el.hidden = !workOpen || !expandedToolGroups.has(key);
        }
        positionAfter(el);
      }
      renderedMessages.set(m.id, el);
      if (m.kind === 'toolActivity') { renderWorkRow(m, el); return; }
      if (m.kind === 'taskSummary' && m.summary) {
        el.textContent = legacySummaryNotice(m);
        return;
      }
      el.classList.toggle('pro-consultation-message', m.kind === 'proConsultation');
      el.classList.toggle('agent-message', !!m.agent);
      el.classList.toggle('assistant-prose', m.role === 'assistant' && !m.kind);
      const streaming = m.status === 'streaming' || (state.busy && m.id === allMessages[allMessages.length - 1]?.id);
      const text = m.text || '';
      const incremental = m.role !== 'user' && streaming && !!text.trim() && !m.images?.length && !m.imageStatus && !m.imageError && !m.kind;
      let view = streamViews.get(el);
      const signature = JSON.stringify([m.agent, m.agentName, grouped, incremental ? null : m.text, m.kind, m.prompt, m.createdAt, m.status, m.source, m.backend, m.displayModel, m.error, m.images, m.attachments, m.imageStatus, m.imageError, L.language(), streaming]);
      if (el.dataset.signature !== signature || (incremental && !text.startsWith(view?.text ?? ''))) {
        el.dataset.signature = signature;
        streamViews.delete(el);
        if (m.role === 'user') {
          const bubble = node('div', null, 'user-bubble');
          bubble.append(node('div', text, 'user-message-text')); el.replaceChildren(bubble);
          const date = messageDate(m.createdAt); el.classList.toggle('has-date', !!date); if (date) bubble.append(date);
          if (m.attachments?.length) bubble.append(sentAttachments(m.attachments));
          if (text.trim()) {
            const copy = button(t('복사'), () => copyText(text, copy), 'msg-copy-btn');
            copy.setAttribute('aria-label', t('메시지 복사')); copy.prepend(icon('copy')); el.append(copy);
          }
          if (['not_sent','uncertain','failed'].includes(m.status)) bubble.append(node('p', m.status === 'uncertain' ? t('전송 상태를 확인해야 합니다. 같은 메시지를 다시 보내기 전에 ChatGPT 웹 대화를 확인하세요.') : (m.error || t('보내지 못했습니다.')), 'message-transport-status'));
        }
        else {
          if (incremental) {
            el.replaceChildren();
            view = {text:'', prefix:0, tail:[], footer:document.createComment('end of streaming prose'), message:m};
            el.append(view.footer);
            streamViews.set(el, view);
          } else {
            prose(el, text);
            renderMessageIconTags(el, streaming);
          }
          if (grouped) el.prepend(agentSpeaker(m));
          if (m.agent && m.status === 'streaming' && !m.text) el.append(node('p', t('응답 중…'), 'agent-pending'));
          if (m.agent && ['error','interrupted'].includes(m.status)) el.append(node('p', m.status === 'interrupted' ? t('중단된 응답입니다.') + (m.error ? ' ' + m.error : '') : (m.error || t('답하지 못했습니다.')), 'message-transport-status'));
          if (m.images?.length) el.append(imageGallery(m.images, m.id));
          if (m.imageStatus === 'generating') el.append(node('p', t('이미지 생성 중…'), 'image-placeholder'));
          if (m.imageError) el.append(node('p', m.imageError, 'image-error'));
        }
      }
      if (incremental) { view.message = m; renderStreamProse(el, view, text); }
    });
    if (!dirtyIds) for (const [id, el] of elements) if (!keep.has(id)) el.remove();
    if (following) followLatest();
    else { restoreReadingPosition(anchor); updateJumpLatest(); }
  }
  function efforts(previous = $('effort').value) {
    const selected = state.models.find(m => (m.model || m.id) === $('model').value);
    const policy = window.MobileCodexReasoning;
    const thirdParty = !!state.apiActive, supported = policy.supported(selected, thirdParty);
    $('effort').replaceChildren(...supported.map(level => new Option(policy.labels[level], level)));
    $('effort').disabled = !supported.length;
    $('effort').value = policy.choose({previous, fallback:selected?.defaultReasoningEffort,
      model:selected, thirdParty});
    optionsSummary();
  }
  let modelListSignature = '';
  function renderModelList() {
    const provider = $('picker-provider'), profiles = (state.apiProviders || []).filter(profile => profile.hasKey);
    const rebind = state.apiCanRebind === true;
    $('picker-provider-row').hidden = profiles.length === 0;
    const choicesKey = JSON.stringify([rebind, profiles.map(profile => [profile.id, profile.name])]);
    if (provider.dataset.choices !== choicesKey) {
      provider.dataset.choices = choicesKey;
      provider.replaceChildren(new Option(rebind ? '重新绑定 API' : '选择 API', ''), ...profiles.map(profile => new Option(profile.name || profile.id, profile.id)));
      provider.options[0].disabled = true;
    }
    provider.value = rebind ? '' : state.apiActive || '';
    provider.disabled = (!!state.threadId && !rebind) || !!state.busy || !!sending || providerSwitchPending;
    provider.title = rebind ? '为此聊天重新绑定 API' : state.threadId ? '此聊天已绑定服务商。可在新聊天选择其他 API。' : '选择此聊天的 API';
    $('header-api').disabled = (!!state.threadId && !rebind) || providerSwitchPending;
    $('model-list').inert = providerSwitchPending;
    const signature = JSON.stringify([state.models, $('model').value, L.language()]);
    if (signature === modelListSignature) return;
    modelListSignature = signature;
    const target = $('model-list'), focused = target.contains(document.activeElement) ? document.activeElement.value : null;
    target.replaceChildren();
    const choices = state.models.filter(m => (m.model || m.id) !== LEGACY_PRO_MODEL).map(m => ({id:m.model || m.id, label:m.displayName || m.model || m.id}));
    if ($('model').value && !choices.some(m => m.id === $('model').value)) target.append(node('p', $('model').value + ' · ' + t('목록 확인 필요'), 'muted'));
    if (!choices.length) target.append(node('p',t('모델 목록을 새로고침해 주세요.'),'muted'));
    for (const choice of choices) {
      const label = node('label', null, 'model-choice'); const input = node('input'); input.type = 'radio'; input.name = 'model-choice'; input.value = choice.id; input.checked = $('model').value === choice.id;
      input.addEventListener('change', () => { $('model').value = choice.id; $('model').dispatchEvent(new Event('change')); showModelPanel(false); });
      label.addEventListener('click', e => { if ($('model').value === choice.id) { e.preventDefault(); showModelPanel(false); } });
      const check = icon('check'); check.setAttribute('aria-hidden', 'true');
      const copy = node('span', null, 'model-choice-copy'); copy.append(node('strong', shortModelName(choice.label)));
      label.append(input, copy, check); target.append(label);
    }
    if (focused) [...target.querySelectorAll('input')].find(input => input.value === focused)?.focus({preventScroll:true});
    sizeModelPicker();
  }
  function renderDevtools() {
    const info = state.devtools;
    const versions = $('devtools-versions'); versions.replaceChildren();
    if (!info || typeof info !== 'object') {
      $('devtools-status').textContent = t('개발 도구 정보를 제공하지 않는 앱 버전입니다. 실행 확인으로 현재 상태를 점검할 수 있습니다.');
      $('terminal-tools-note').textContent = t('현재 프로젝트 폴더에서 셸 명령을 실행합니다. 개발 도구 상태는 설정 > 도구에서 확인하세요.');
    } else {
      if (info.error) $('devtools-status').textContent = t('준비 오류: ') + info.error;
      else if (!info.bundled) $('devtools-status').textContent = t('번들 개발 도구가 없습니다.');
      else if (info.prepared) $('devtools-status').textContent = t('번들 준비 완료. 아래 실행 확인으로 현재 상태를 검증하세요.');
      else $('devtools-status').textContent = t('번들 개발 도구가 준비 중이거나 아직 확인되지 않았습니다.');
      for (const tool of Array.isArray(info.tools) ? info.tools : []) {
        const row = node('span', (tool?.name || t('도구')) + (tool?.version ? ' ' + tool.version : t(' 버전 확인 전')), 'devtools-version');
        versions.append(row);
      }
      const names = (Array.isArray(info.tools) ? info.tools.map(tool => tool?.name).filter(Boolean) : []).join(' · ');
      $('terminal-tools-note').textContent = info.bundled
        ? t('현재 프로젝트 폴더에서 {tools} 명령을 실행합니다.', {tools:names || 'Python · Node.js · Git · npm · pip'})
        : t('현재 프로젝트 폴더에서 셸 명령을 실행합니다. 번들 개발 도구는 사용할 수 없습니다.');
    }
    if (devtoolsCheckSummary) $('devtools-status').textContent = devtoolsCheckSummary;
    const output = $('devtools-output');
    output.hidden = !devtoolsCheckResult;
    output.textContent = devtoolsCheckResult || '';
    $('devtools-check').disabled = devtoolsChecking;
    $('devtools-check').textContent = devtoolsChecking ? t('실행 확인 중…') : t('도구 실행 확인');
  }
  function linuxStatus(value) {
    return value && typeof value === 'object' ? value : null;
  }
  function linuxBytes(value) { return Number.isFinite(Number(value)) && Number(value) >= 0 ? C.size(Number(value)) : ''; }
  function linuxPhase(info) {
    const phases = {not_installed:t('설치되지 않음'), downloading:t('다운로드 중…'), verifying:t('검증 중…'), extracting:t('압축 해제 중…'), checking:t('확인 중…'), ready:t('준비됨'), error:t('설치 실패'), cancelled:t('설치 취소됨')};
    return phases[info?.state] || '';
  }
  function ensureLinuxUi() {
    if ($('linux-environment-card')) return;
    const tools = document.querySelector('[data-settings-panel="tools"]'); if (!tools) return;
    const card = node('section', null, 'devtools-card linux-environment-card'); card.id = 'linux-environment-card';
    const heading = node('div', null, 'card-heading'); const copy = node('span'), title = node('strong', t('Linux 환경')), description = node('small', t('필요할 때만 내려받아 Codex와 터미널 명령에 사용합니다. 프로젝트 파일은 그대로 유지됩니다.')); title.id = 'linux-environment-title'; description.id = 'linux-environment-description'; copy.append(title, description); heading.append(copy);
    const details = node('p', '', 'muted'); details.id = 'linux-environment-details';
    const status = node('p', '', 'muted'); status.id = 'linux-environment-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const progress = node('progress'); progress.id = 'linux-environment-progress'; progress.hidden = true; progress.setAttribute('aria-label', t('Linux 환경 설치 진행률'));
    const actions = node('div', null, 'linux-environment-actions');
    const install = node('button', t('설치'), 'primary-button'); install.id = 'linux-install'; install.type = 'button';
    const cancel = node('button', t('취소'), 'secondary-button'); cancel.id = 'linux-cancel'; cancel.type = 'button'; cancel.hidden = true;
    const remove = node('button', t('Linux 환경 삭제'), 'secondary-button subtle-danger'); remove.id = 'linux-remove'; remove.type = 'button'; remove.hidden = true;
    actions.append(install, cancel, remove);
    const enabled = node('input'); enabled.id = 'linux-enabled'; enabled.type = 'checkbox'; enabled.setAttribute('role', 'switch');
    const toggle = node('label', null, 'toggle-switch linux-environment-toggle'); toggle.append(enabled, node('span', null, 'toggle-track'));
    const enableRow = node('div', null, 'settings-row linux-enable-row'); const enableCopy = node('span'), enableTitle = node('strong', t('Linux 환경 사용')), enableDescription = node('small', t('Codex와 기본 터미널에서 Linux 명령을 실행합니다.')); enableTitle.id = 'linux-enable-title'; enableDescription.id = 'linux-enable-description'; enableCopy.append(enableTitle, enableDescription); enableRow.append(enableCopy, toggle);
    card.append(heading, details, status, progress, actions, enableRow); tools.append(card);
    install.addEventListener('click', async () => { if (linuxRequestPending) return; linuxRequestPending = true; try { linuxStatusError = ''; renderLinux(); const result = await call('linux.install'); if (linuxStatus(result)) state.linux = result; } catch (error) { linuxStatusError = error.message || t('Linux 환경을 설치하지 못했습니다. 다시 시도해 주세요.'); } finally { linuxRequestPending = false; renderLinux(); } });
    cancel.addEventListener('click', async () => { try { await call('linux.cancel'); } catch (error) { linuxStatusError = error.message; renderLinux(); } });
    enabled.addEventListener('change', async () => { if (linuxRequestPending) return; const wanted = enabled.checked; linuxRequestPending = true; try { linuxStatusError = ''; renderLinux(); enabled.checked = wanted; const result = await call('linux.enable', {enabled:wanted}); if (linuxStatus(result)) state.linux = result; } catch (error) { linuxStatusError = error.message || t('Linux 환경을 전환하지 못했습니다.'); } finally { linuxRequestPending = false; renderLinux(); } });
    remove.addEventListener('click', async () => { if (linuxRequestPending || !confirm(t('Linux 환경과 설치된 패키지를 삭제할까요? 프로젝트 파일은 유지됩니다.'))) return; linuxRequestPending = true; try { linuxStatusError = ''; renderLinux(); const result = await call('linux.remove'); if (linuxStatus(result)) state.linux = result; } catch (error) { linuxStatusError = error.message; } finally { linuxRequestPending = false; renderLinux(); } });
  }
  function renderLinux() {
    ensureLinuxUi(); const card = $('linux-environment-card'); if (!card) return;
    const info = linuxStatus(state.linux), supported = !!info && info.supported !== false;
    card.hidden = false;
    const details = $('linux-environment-details'), status = $('linux-environment-status'), progress = $('linux-environment-progress'), install = $('linux-install'), cancel = $('linux-cancel'), remove = $('linux-remove'), enabled = $('linux-enabled'), enableRow = card.querySelector('.linux-enable-row');
    $('linux-environment-title').textContent = t('Linux 환경'); $('linux-environment-description').textContent = t('필요할 때만 내려받아 Codex와 터미널 명령에 사용합니다. 프로젝트 파일은 그대로 유지됩니다.'); $('linux-enable-title').textContent = t('Linux 환경 사용'); $('linux-enable-description').textContent = t('Codex와 기본 터미널에서 Linux 명령을 실행합니다.'); cancel.textContent = t('취소'); remove.textContent = t('Linux 환경 삭제');
    if (!supported) {
      details.textContent = t('이 앱 버전에서는 Linux 환경을 사용할 수 없습니다.'); status.textContent = info?.error || ''; status.classList.toggle('error', !!info?.error); progress.hidden = true; install.hidden = true; cancel.hidden = true; remove.hidden = true; enableRow.hidden = true; return;
    }
    const total = Number(info.totalBytes ?? info.downloadBytes), downloaded = Number(info.downloadedBytes);
    const parts = [info.label || t('Linux 환경')];
    if (Number.isFinite(total) && total > 0) parts.push(t('다운로드 {size}', {size:linuxBytes(total)}));
    if (Number.isFinite(Number(info.requiredFreeBytes))) parts.push(t('필요 공간 {size}', {size:linuxBytes(info.requiredFreeBytes)}));
    if (Number.isFinite(Number(info.availableBytes))) parts.push(t('사용 가능 {size}', {size:linuxBytes(info.availableBytes)}));
    details.textContent = parts.join(' · ');
    const busy = !!info.busy, ready = !!info.installed && info.state === 'ready';
    const progressState = ['downloading','verifying','extracting','checking'].includes(info.state);
    progress.hidden = !progressState;
    if (progressState) { if (info.state === 'downloading' && Number.isFinite(total) && total > 0) { progress.max = total; progress.value = Math.min(Math.max(downloaded || 0, 0), total); } else progress.removeAttribute('value'); }
    status.textContent = linuxStatusError || info.error || linuxPhase(info);
    status.classList.toggle('error', !!(linuxStatusError || info.error || info.state === 'error'));
    install.hidden = !!info.installed || busy;
    install.textContent = info.state === 'error' || info.state === 'cancelled' ? t('다시 시도') : t('설치');
    install.disabled = busy || linuxRequestPending;
    cancel.hidden = !busy; cancel.disabled = !busy;
    remove.hidden = !info.installed && !info.hasFiles; remove.disabled = busy || linuxRequestPending;
    enableRow.hidden = !ready; enabled.checked = !!info.enabled; enabled.disabled = !ready || busy || linuxRequestPending;
    $('terminal-tools-note').textContent = info.enabled && ready
      ? t('{label}에서 현재 프로젝트 폴더로 Linux 명령을 실행합니다.', {label:info.label || t('Linux 환경')})
      : terminalDefaultNote();
  }
  function terminalDefaultNote() {
    const info = state.devtools;
    if (!info || typeof info !== 'object') return t('현재 프로젝트 폴더에서 셸 명령을 실행합니다. 개발 도구 상태는 설정 > 도구에서 확인하세요.');
    const names = (Array.isArray(info.tools) ? info.tools.map(tool => tool?.name).filter(Boolean) : []).join(' · ');
    return info.bundled ? t('현재 프로젝트 폴더에서 {tools} 명령을 실행합니다.', {tools:names || 'Python · Node.js · Git · npm · pip'}) : t('현재 프로젝트 폴더에서 셸 명령을 실행합니다. 번들 개발 도구는 사용할 수 없습니다.');
  }
  async function refreshLinuxStatus() {
    if (!linuxStatus(state.linux) || state.linux.supported === false) return;
    try { const result = await call('linux.status'); if (linuxStatus(result)) { state.linux = result; linuxStatusError = ''; renderLinux(); } }
    catch (_) { /* Older native apps can omit this optional API. */ }
  }
  async function checkDevtools() {
    devtoolsChecking = true; renderDevtools();
    try {
      const result = await call('devtools.check');
      const checks = Array.isArray(result?.checks) ? result.checks : [];
      devtoolsCheckResult = checks.length
        ? checks.map(check => `${check?.ok ? '✓' : '✕'} ${check?.name || t('도구')}\n${check?.output || ''}`).join('\n\n')
        : (result?.ok ? t('도구 실행 확인이 완료되었습니다.') : t('실행 결과를 받지 못했습니다. 다시 시도해 주세요.'));
      devtoolsCheckSummary = result?.ok ? t('도구 실행 확인을 완료했습니다.') : t('일부 도구를 실행하지 못했습니다. 출력에서 원인을 확인한 뒤 다시 시도해 주세요.');
    } catch (error) {
      devtoolsCheckResult = t('실행 확인 실패\n') + (error?.message || t('알 수 없는 오류'));
      devtoolsCheckSummary = t('실행 확인에 실패했습니다. 다시 시도할 수 있습니다.');
    } finally {
      devtoolsChecking = false; renderDevtools();
    }
  }
  function drawChatSelection() {
    const status = $('chat-switch-status');
    const switching = !!chatSelection;
    status.parentElement.classList.toggle('chat-switching', switching);
    for (const control of ['conversation', 'file-panel', 'header-project', 'header-api', 'files-toggle']) $(control).inert = switching;
    status.hidden = !switching;
    status.textContent = switching ? (L.language() === 'en' ? 'Opening conversation…' : '正在切换对话…') : '';
    updateSend();
  }
  async function navigateChat(action, args) {
    const selection = {action, args};
    chatSelection = selection;
    sidebar(false);
    chatTouch?.cancel();
    drawChatSelection();
    nextRequest();
    try { await call(action, {...args, eventOnly:true}); }
    catch (error) { if (chatSelection === selection) toast(error.message); }
    finally {
      if (chatSelection === selection) {
        chatSelection = null;
        drawChatSelection();
        nextRequest();
      }
    }
  }
  const selectProject = key => navigateChat('projects.select', {key:key || ''});
  const newChat = workspaceKey => navigateChat('chat.new', {workspaceKey:workspaceKey || ''});
  function openChat(id) {
    if (!chatSelection && id === state.threadId) { sidebar(false); nextRequest(); return; }
    if (chatSelection?.action === 'chat.resume' && chatSelection.args.id === id) return;
    return navigateChat('chat.resume', {id});
  }
  function removeProject(project) {
    const trigger = [...$('projects').querySelectorAll('[data-project-menu-key]')].find(item => item.dataset.projectMenuKey === project.key);
    if (!trigger || projectRemovalBusy(project)) return;
    $('project-remove-card')?.remove();
    const card = node('div', null, 'session-card'); card.id = 'project-remove-card';
    const question = project.bindings?.length > 1 ? t('기본 로컬 연결을 해제할까요? 다른 연결과 파일은 그대로 유지됩니다.') : t('프로젝트를 제거할까요? 대화는 일반 대화로 이동해요.\n파일은 그대로 유지됩니다.');
    const actions = node('div', null, 'session-card-actions');
    const cancel = button(t('취소'), () => { card.remove(); trigger.focus({preventScroll:true}); });
    const remove = button(t(project.bindings?.length > 1 ? '기본 로컬 연결 해제' : '프로젝트 목록에서 제거'), async () => {
      if (!card.isConnected || projectRemovalBusy(project)) return;
      cancel.disabled = true;
      try {
        await call('projects.remove', {key:project.key}); card.remove();
        toast(t(project.bindings?.length > 1 ? '로컬 연결을 해제했습니다.' : '프로젝트를 제거했습니다. 대화는 일반 대화에 있습니다.'));
      } finally { cancel.disabled = false; }
    }, 'secondary-button danger');
    actions.append(cancel, remove); card.append(node('p', question), actions); trigger.closest('.project-row').after(card);
    cancel.focus({preventScroll:true}); card.scrollIntoView?.({block:'nearest'});
  }
  async function renameProject(project) {
    const name = await input(t('프로젝트 이름 변경'), t('새 프로젝트 표시 이름을 입력하세요.'), project.name || '');
    if (!name || !name.trim() || (name.trim() === project.name && !project.nameConflicts?.length)) return;
    const result = await call('projects.rename', {key:project.key, name:name.trim()});
    const projects = (state.projects || []).map(value => value.key === project.key ? {...value, name:result.name || name.trim(), nameConflicts:[]} : value);
    const workspace = projectKeys(project).includes(state.workspace?.key) ? {...state.workspace, name:result.name || name.trim()} : state.workspace;
    render({...state, projects, workspace});
    toast(t('프로젝트 이름을 변경했습니다.'));
  }
  function projectKeys(project) { return project.workspaceKeys || [project.key]; }
  function sessionWorkBusy(session) {
    return !!session.busy || (session.id === state.threadId && (!!state.busy));
  }
  function projectRemovalBusy(project) {
    return (state.sessions || []).some(session => session.workspaceKey === project.key && sessionWorkBusy(session))
      || (state.workspace?.key === project.key && (!!state.busy));
  }
  let projectLinkView = null, projectLinkPending = false;
  const currentProjectLink = view => view === projectLinkView && $('project-link-dialog').open;
  function syncProjectLinkControls() {
    if (!$('project-link-dialog').open) return;
    const busy = projectWorkBusy();
    const list = $('project-link-choices');
    list.setAttribute('aria-busy', String(projectLinkPending));
    list.querySelectorAll('button').forEach(item => {
      item.disabled = projectLinkPending || (busy && !item.hasAttribute('data-project-allowed-while-busy'));
    });
  }
  function projectChoices(title, description, choices, returnKey = '') {
    const view = {returnKey};
    projectLinkView = view;
    const dialog = $('project-link-dialog'), heading = $('project-link-title');
    heading.textContent = title;
    heading.tabIndex = -1;
    $('project-link-description').textContent = description;
    if (description) dialog.setAttribute('aria-describedby', 'project-link-description');
    else dialog.removeAttribute('aria-describedby');
    const choiceButton = choice => {
      const item = node('button', null, 'secondary-button project-choice');
      item.type = 'button';
      if (choice.whileBusy) item.dataset.projectAllowedWhileBusy = '';
      if (choice.action) item.dataset.projectFolderAction = choice.action;
      if (choice.folderPath !== undefined) item.dataset.workspaceFolder = choice.folderPath;
      const label = node('span', choice.label);
      if (choice.icon) {
        const glyph = icon(choice.icon);
        glyph.setAttribute('aria-hidden', 'true');
        label.className = 'project-folder-label';
        label.replaceChildren(glyph, node('span', choice.label));
      }
      item.append(label);
      if (choice.detail) item.append(node('small', choice.detail, 'muted'));
      item.addEventListener('click', async () => {
        if (item.disabled || !currentProjectLink(view) || projectLinkPending || (!choice.whileBusy && projectWorkBusy())) return;
        projectLinkPending = true;
        syncProjectLinkControls();
        try { await choice.run(view); }
        catch (error) { toast(error.message); }
        finally {
          projectLinkPending = false;
          syncProjectLinkControls();
          if (currentProjectLink(view) && !item.disabled && !document.querySelector('dialog[open]:not(#project-link-dialog)')) item.focus({preventScroll:true});
        }
      });
      return item;
    };
    $('project-link-choices').replaceChildren(...choices.map(choice => {
      if (!choice.entries) return choiceButton(choice);
      const group = node('div', null, 'model-list');
      group.setAttribute('role', 'group'); group.setAttribute('aria-label', t('子文件夹'));
      group.append(...choice.entries.map(choiceButton));
      return group;
    }));
    show('project-link-dialog');
    syncProjectLinkControls();
    dialog.scrollTop = 0;
    if (!document.querySelector('dialog[open]:not(#project-link-dialog)')) heading.focus({preventScroll:true});
    return view;
  }
  function rootProjectChoices() {
    return [
      {label:t('프로젝트 가져오기'), action:'import', run:importProjects},
      {label:t('Android 选择其他文件夹'), action:'pick', whileBusy:true, run:async view => {
        const result = await pickFolder();
        if (result && !result.cancelled && currentProjectLink(view)) close('project-link-dialog');
      }},
      {label:t('폴더 없이 프로젝트 만들기'), action:'metadata', whileBusy:true, run:createProjectFromChoice}
    ];
  }
  async function createProjectFromChoice(view, path) {
    const title = path === undefined ? t('프로젝트 만들기') : t('新建项目文件夹');
    const name = (await input(title, t('프로젝트 이름을 입력하세요.')))?.trim();
    if (!name || !currentProjectLink(view)) return;
    if (path === undefined) await call('projects.create', {name});
    else await call('projects.createWorkspaceFolder', {path, name});
    if (currentProjectLink(view)) close('project-link-dialog');
  }
  async function loadProjectFolders(path, view, initial = false) {
    const title = t('프로젝트 추가');
    let listing;
    try {
      listing = await call('projects.workspaceFolders', {path});
      if (typeof listing.path !== 'string' || !Array.isArray(listing.entries)) throw new Error(t('无法加载文件夹'));
    } catch (error) {
      if (!currentProjectLink(view)) return;
      if (initial) projectChoices(title, t('无法加载文件夹'), [
        {label:t('다시 시도'), action:'retry', whileBusy:true, run:current => loadProjectFolders('', current, true)},
        ...rootProjectChoices()
      ]);
      toast(error.message);
      return;
    }
    if (!currentProjectLink(view)) return;
    const {rootName, path:currentPath, parent, entries} = listing;
    const choices = [];
    if (currentPath && typeof parent === 'string') {
      choices.push({label:t('上一级'), icon:'up', action:'up', whileBusy:true, run:current => loadProjectFolders(parent, current)});
      choices.push({label:t('关联当前文件夹'), action:'bind', whileBusy:true, run:async current => {
        await call('projects.bindWorkspaceFolder', {path:currentPath});
        if (currentProjectLink(current)) close('project-link-dialog');
      }});
    }
    choices.push({label:t('新建项目文件夹'), icon:'plus', action:'create', whileBusy:true, run:current => createProjectFromChoice(current, currentPath)});
    if (entries.length) choices.push({entries:entries.map(entry => ({
      label:entry.name, icon:'folder', folderPath:entry.path, whileBusy:true, run:current => loadProjectFolders(entry.path, current)
    }))});
    if (!currentPath) choices.push(...rootProjectChoices());
    projectChoices(title, [rootName, ...currentPath.split('/').filter(Boolean)].join(' / '), choices);
  }
  function addProject() {
    if (projectLinkPending || $('project-link-dialog').open) return;
    const view = projectChoices(t('프로젝트 추가'), t('正在加载文件夹…'), []);
    return loadProjectFolders('', view, true);
  }
  async function importProjects(view) {
    if (projectWorkBusy()) return;
    const picked = await call('ui.projects.importFile');
    if (picked.cancelled || !currentProjectLink(view) || projectWorkBusy()) return;
    const preview = await call('projects.import.preview', {content:picked.content});
    if (!currentProjectLink(view)) return;
    const summary = preview.result.summary;
    const names = summary.projects.map(p => p.name + (p.nameConflicts?.length ? '\n' + t('이름 충돌') + ': ' + p.nameConflicts.join(' / ') : '')).join('\n');
    projectChoices(t('프로젝트 가져오기'), t('새 변경 {count}개 · 병합 이력 {links}개', {count:preview.result.addedEvents, links:summary.linkCount}) + '\n\n' + names, [
      {label:t('가져오기'), detail:t('프로젝트 ID가 같으면 기존 항목을 갱신합니다. 포함된 병합 이력도 적용됩니다.'), run:async () => {
        if (projectWorkBusy()) return;
        const result = await call('projects.import.apply', {content:picked.content, token:preview.token});
        render({...state, ...result}); close('project-link-dialog'); toast(t('프로젝트 정보를 가져왔습니다.'));
      }}
    ]);
  }
  async function exportProject(project) {
    const bundle = await call('projects.export', {key:project.key});
    if (!confirm(t('“{name}”의 프로젝트 ID, 이름, 병합 이력을 내보낼까요?\n\n대화, 파일, 로컬 경로, 인증정보는 포함되지 않습니다.', {name:project.name}))) return;
    await call('ui.projects.exportFile', {content:JSON.stringify(bundle)});
  }
  function resolveProjectName(project) {
    if (projectLinkPending || projectWorkBusy()) return;
    projectChoices(t('이름 충돌 해결'), t('다른 기기에서 동시에 변경된 이름입니다. 사용할 이름을 선택하세요.'), project.nameConflicts.map(name => ({label:name, run:async () => {
      if (projectWorkBusy()) return;
      await call('projects.rename', {key:project.key, name}); close('project-link-dialog');
    }})), project.key);
  }
  function mergeProject(project) {
    if (projectLinkPending || projectWorkBusy()) return;
    const candidates = (state.projects || []).filter(p => p.projectId && p.projectId !== project.projectId);
    projectChoices(t('프로젝트 병합'), t('같은 프로젝트로 묶을 항목을 선택하세요. 폴더와 파일은 그대로 유지됩니다.'), candidates.map(target => ({
      label:target.name,
      detail:(target.bindings || []).map(b => b.uri || t('로컬 폴더 없음')).join('\n'),
      run:async view => {
        if (projectWorkBusy()) return;
        if (!confirm(t('“{source}”와 “{target}”을 같은 프로젝트로 묶을까요?\n\n대상 프로젝트의 이름과 기본 폴더를 사용합니다. 기존 대화는 각자의 폴더에 연결된 채 유지됩니다.', {source:project.name, target:target.name}))) return;
        const result = await call('projects.merge', {sourceKey:project.key, targetKey:target.key});
        if (result.projects) render({...state, projects:result.projects});
        view.returnKey = target.key;
        if (currentProjectLink(view)) close('project-link-dialog');
        toast(t('프로젝트를 병합했습니다.'));
      }
    })), project.key);
  }
  function chooseProjectBinding(project) {
    if (projectLinkPending || projectWorkBusy()) return;
    projectChoices(t('기본 로컬 폴더'), t('새 대화에서 사용할 폴더를 선택하세요. 기존 대화의 폴더는 바뀌지 않습니다.'), (project.bindings || []).map(binding => ({
      label:binding.name,
      detail:(binding.uri || t('로컬 폴더 없음')) + (binding.key === project.key ? '\n' + t('기본 폴더') : ''),
      run:async view => {
        if (projectWorkBusy()) return;
        const result = await call('projects.prefer', {key:binding.key});
        if (result.projects) render({...state, projects:result.projects});
        view.returnKey = binding.key;
        if (currentProjectLink(view)) close('project-link-dialog');
      }
    })), project.key);
  }
  function closeProjectCard(focus = false) {
    const card = $('project-actions') || $('project-remove-card');
    if (!card) return false;
    const trigger = card.closest('.project-tree')?.querySelector('.project-more');
    card.remove(); trigger?.setAttribute('aria-expanded','false'); if (focus) trigger?.focus({preventScroll:true}); return true;
  }
  function projectAction(project, trigger) {
    const same = !!trigger.closest('.project-tree').querySelector('#project-actions,#project-remove-card');
    closeSessionCard(); closeProjectCard(); if (same) return;
    const card = node('div', null, 'session-card'); card.id = 'project-actions';
    const action = (label, fn, cls, blocked = projectWorkBusy) => { const item = button(label, async () => { if (blocked()) return; closeProjectCard(); await fn(); }, cls); item.disabled = blocked(); return item; };
    const actions = [
      action(t('이름 변경'), () => renameProject(project), undefined, () => false)
    ];
    if (project.projectId) actions.push(action(t('프로젝트 내보내기'), () => exportProject(project), undefined, () => false));
    if (project.nameConflicts?.length) actions.push(action(t('이름 충돌 해결'), () => resolveProjectName(project)));
    if (project.available !== false) actions.unshift(action(t('새 대화'), () => newChat(project.key), undefined, () => false));
    if (project.available === false) actions.push(action(t(project.hasLocalFolder === false ? '로컬 폴더 연결' : '폴더 다시 연결'), () => pickFolder(project.key)));
    if (project.projectId && (state.projects || []).some(p => p.projectId && p.projectId !== project.projectId)) actions.push(action(t('프로젝트 병합'), () => mergeProject(project)));
    if (project.bindings?.length > 1) actions.push(action(t('기본 로컬 폴더'), () => chooseProjectBinding(project)));
    actions.push(action(t(project.bindings?.length > 1 ? '기본 로컬 연결 해제' : '프로젝트 목록에서 제거'), () => removeProject(project), 'secondary-button danger', () => projectRemovalBusy(project)));
    const row = node('div', null, 'project-inline-actions'); row.append(...actions); card.append(row);
    trigger.closest('.project-row').after(card); trigger.setAttribute('aria-expanded','true'); actions[0]?.focus({preventScroll:true});
  }
  let sessionCard = null;
  let providerSwitchPending = false;
  const folderStorageKey = () => 'chat-folders:v1:' + providerScope();
  let folderScope = '', chatFolders = [];
  function readChatFolders() {
    const key = folderStorageKey();
    if (folderScope === key) return;
    if (sessionCard) closeSessionCard();
    folderScope = key;
    try { chatFolders = JSON.parse(localStorage.getItem(key) || '[]').filter(group => typeof group.name === 'string' && Array.isArray(group.ids)); }
    catch { chatFolders = []; }
  }
  const folderFor = id => chatFolders.find(group => group.ids.includes(id));
  function storeFolders(next) {
    localStorage.setItem(folderStorageKey(), JSON.stringify(next));
    chatFolders = next;
  }
  function moveToFolder(id, name) {
    const next = chatFolders.map(group => ({...group, ids:group.ids.filter(member => member !== id)}));
    if (name) {
      let dest = next.find(group => group.name === name);
      if (!dest) { dest = {name, ids:[], open:true}; next.push(dest); }
      dest.ids.push(id); dest.open = true;
    }
    storeFolders(next.filter(group => group.ids.length));
    closeSessionCard(); navigationSignature = ''; render(state);
  }
  function renderChatFolders() {
    for (const group of chatFolders) {
      const ids = new Set(group.ids), members = (state.sessions || []).filter(session => ids.has(session.id));
      if (!members.length) continue;
      const section = node('details', null, 'history-folder'); section.open = group.open !== false;
      const title = node('summary', group.name + '（' + members.length + '）'); section.append(title);
      section.addEventListener('toggle', () => {
        if (section.isConnected && group.open !== section.open) {
          group.open = section.open; storeFolders(chatFolders);
        }
      });
      for (const session of members) section.append(sessionRow(session));
      $('sessions').append(section);
    }
  }
  const sessionEdits = new Set();
  function closeSessionCard(restoreFocus = false) {
    if (!sessionCard) return false;
    const {card, menu, scroller, originalScrollTop, cardScrollTop} = sessionCard;
    const restoreScroll = Math.abs(scroller.scrollTop - cardScrollTop) < 1;
    sessionCard = null;
    card.remove();
    menu.setAttribute('aria-expanded', 'false');
    menu.removeAttribute('aria-controls');
    if (restoreFocus && menu.isConnected) menu.focus({preventScroll:true});
    if (restoreScroll) scroller.scrollTop = originalScrollTop;
    return true;
  }
  function openSessionCard(session, row, menu) {
    const same = sessionCard?.id === session.id;
    closeSessionCard();
    if (same || sessionEdits.has(session.id)) return;
    const card = node('div', null, 'session-card');
    card.id = 'session-card';
    card.setAttribute('role', 'group');
    card.setAttribute('aria-label', session.title || t('대화 관리'));
    const scroller = $('sidebar').querySelector('.sidebar-scroll');
    sessionCard = {id:session.id, card, menu, mode:'actions', scroller, originalScrollTop:scroller.scrollTop};
    row.append(card);
    menu.setAttribute('aria-expanded', 'true');
    menu.setAttribute('aria-controls', card.id);
    drawSessionCard();
  }
  function drawSessionCard() {
    const selected = sessionCard;
    const session = (state.sessions || []).find(item => item.id === selected.id);
    if (!session) { closeSessionCard(); return; }
    const {card, mode, id} = selected;
    const actions = node('div', null, 'session-card-actions');
    const cancel = button(t('취소'), () => closeSessionCard(true));
    const change = next => {
      const scrollTop = selected.scroller.scrollTop;
      if (Math.abs(scrollTop - selected.cardScrollTop) >= 1) selected.originalScrollTop = scrollTop;
      selected.mode = next;
      drawSessionCard();
    };
    const reveal = () => {
      card.scrollIntoView?.({block:'nearest'});
      selected.cardScrollTop = selected.scroller.scrollTop;
    };
    async function submit(title) {
      if (selected !== sessionCard || sessionEdits.has(id)) return;
      const current = (state.sessions || []).find(item => item.id === id);
      if (!current || (mode === 'delete' && sessionWorkBusy(current))) return;
      sessionEdits.add(id);
      for (const control of card.querySelectorAll('button,input')) control.disabled = true;
      try {
        if (mode === 'delete') {
          const result = await call('chat.delete', {id});
          toast(result.deletionPending ? t('삭제 요청을 저장했습니다. Codex에 연결되면 원본 기록도 삭제합니다.') : t('대화를 삭제했습니다.'));
        } else {
          await call('chat.rename', {id, title});
          toast(t('대화 이름을 변경했습니다.'));
        }
        if (selected === sessionCard) closeSessionCard(true);
      } catch (error) {
        if (selected === sessionCard) {
          for (const control of card.querySelectorAll('button,input')) control.disabled = false;
          const remove = card.querySelector('[data-session-delete]');
          if (remove) remove.disabled = sessionWorkBusy((state.sessions || []).find(item => item.id === id) || current);
        }
        toast(error.message);
      } finally { sessionEdits.delete(id); }
    }
    card.replaceChildren();
    if (mode === 'folder') {
      const list = node('div', null, 'folder-destinations');
      if (state.projects?.length) list.append(node('strong', '已有项目'));
      for (const project of state.projects || []) {
        const choice = button(project.name || t('이름 없는 프로젝트'), async () => {
          if (selected !== sessionCard || sessionEdits.has(id)) return;
          sessionEdits.add(id);
          try {
            const scope = folderScope;
            const result = await call('chat.move', {id, key:project.key});
            if (folderScope !== scope) return;
            if (folderFor(id)) moveToFolder(id, '');
            else if (selected === sessionCard) closeSessionCard();
            if (result.sessions) render(result);
          } finally { sessionEdits.delete(id); }
        });
        choice.prepend(icon('folder')); choice.disabled = sessionWorkBusy(session) || (projectKeys(project).includes(session.workspaceKey) && !folderFor(id)); list.append(choice);
      }
      if (chatFolders.length) list.append(node('strong', '聊天文件夹'));
      for (const group of [...chatFolders].sort((left, right) => left.name.localeCompare(right.name))) {
        const choice = button(group.name, () => moveToFolder(id, group.name));
        choice.prepend(icon('folder')); choice.disabled = group.ids.includes(id); list.append(choice);
      }
      if (folderFor(id)) list.append(button('移出文件夹', () => moveToFolder(id, '')));
      actions.append(cancel, button('新建文件夹', () => change('new-folder')));
      card.append(list, actions); reveal(); return;
    }
    if (mode === 'new-folder') {
      const field = node('input'); field.placeholder = '新文件夹名称'; field.setAttribute('aria-label', field.placeholder); field.maxLength = 80;
      const move = () => {
        const name = field.value.trim(); if (!name) { field.focus(); return; }
        moveToFolder(id, name);
      };
      field.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); move(); } });
      actions.append(button(t('취소'), () => change('folder')), button('确定', move)); card.append(field, actions); field.focus({preventScroll:true}); reveal(); return;
    }
    if (mode === 'rename') {
      const field = node('input');
      field.setAttribute('aria-label', t('대화 이름 변경'));
      field.value = session.title || '';
      const save = () => { const title = field.value.trim(); if (title) return submit(title); field.focus(); };
      field.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); save(); } });
      actions.append(cancel, button(t('저장'), save));
      card.append(field, actions);
      field.focus({preventScroll:true}); field.select(); reveal();
      return;
    }
    const confirm = mode === 'delete';
    if (confirm) card.append(node('p', t('“{title}” 대화를 삭제할까요?', {title:session.title || t('대화')})));
    const first = confirm ? cancel : button(t('이름 변경'), () => change('rename'));
    const remove = node('button', t('대화 삭제'), 'secondary-button danger');
    remove.type = 'button';
    remove.addEventListener('click', confirm ? () => submit() : () => change('delete'));
    remove.dataset.sessionDelete = '';
    remove.disabled = sessionWorkBusy(session);
    actions.append(first);
    if (!confirm) actions.append(button('移至项目或文件夹', () => change('folder')));
    actions.append(remove); card.append(actions);
    first.focus({preventScroll:true}); reveal();
  }
  const sessionRows = new Map();
  function setSessionActive(row, active) {
    row.classList.toggle('active', active);
    const button = row.firstElementChild;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'true');
    else button.removeAttribute('aria-current');
  }
  function sessionRow(session) {
    const row = node('div', null, 'session-row');
    const b = node('button', '', 'session');
    b.type = 'button';
    b.addEventListener('click', () => openChat(session.id));
    b.append(node('span', session.title || t('제목 없는 대화'), 'session-title'));
    if (session.approvalPending) b.append(node('span', '!', 'session-approval-indicator'));
    else if (session.busy) b.append(node('span', '', 'session-progress-indicator'));
    b.title = session.workspace || t('일반 대화');
    row.dataset.sessionId = session.id;
    const menu = button('', () => openSessionCard(session, row, menu), 'icon-button session-more');
    menu.setAttribute('aria-expanded', 'false');
    menu.setAttribute('aria-label', (session.title || t('대화')) + t(' 관리'));
    menu.append(icon('more'));
    row.append(b, menu);
    sessionRows.set(session.id, row);
    setSessionActive(row, session.id === state.threadId);
    return row;
  }
  function renderProjects() {
    const target = $('projects'); target.replaceChildren();
    const projects = state.projects || [];
    const workBusy = projectWorkBusy();
    for (const project of projects) {
      const expandedKey = 'project-expanded:' + (project.projectId || project.key), expanded = localStorage.getItem(expandedKey) !== 'false';
      const section = node('section', null, 'project-tree' + (project.selected ? ' selected' : ''));
      const row = node('div', null, 'project-row');
      const toggle = button('', () => { const expandedNow = section.classList.toggle('collapsed') === false; localStorage.setItem(expandedKey, String(expandedNow)); toggle.setAttribute('aria-expanded', String(expandedNow)); }, 'tree-toggle'); toggle.setAttribute('aria-label', project.name + t(' 대화 펼치기')); toggle.setAttribute('aria-expanded', String(expanded)); toggle.append(icon('down'));
      const select = button('', () => selectProject(project.key), 'project-button'); select.append(icon('folder'), node('span', project.name || t('이름 없는 프로젝트'))); select.setAttribute('aria-current', String(!!project.selected));
       const menu = button('', () => projectAction(project, menu), 'icon-button project-more'); menu.setAttribute('aria-label', project.name + t(' 메뉴')); menu.dataset.projectMenuKey = project.key; menu.append(icon('more'));
       const projectNew = button('', () => newChat(project.key), 'icon-button project-new'); projectNew.disabled = project.available === false; projectNew.setAttribute('aria-label', project.name + t(' 새 대화')); projectNew.append(icon('plus'));
       row.append(toggle, select, projectNew, menu); section.append(row);
      const children = node('div', null, 'project-sessions');
      if (project.nameConflicts?.length) { const resolve = button(t('이름 충돌 해결'), () => resolveProjectName(project), 'new-thread'); resolve.disabled = workBusy; children.append(resolve); }
      if (project.available === false) { const bind = button(t(project.hasLocalFolder === false ? '로컬 폴더 연결' : '폴더 다시 연결'), () => pickFolder(project.key), 'new-thread'); bind.disabled = workBusy; children.append(bind); }
      if (project.bindings?.length > 1) { const choose = button(t('기본 로컬 폴더'), () => chooseProjectBinding(project), 'new-thread'); choose.disabled = workBusy; children.append(choose); }
      for (const session of (state.sessions || []).filter(s => projectKeys(project).includes(s.workspaceKey) && !folderFor(s.id))) children.append(sessionRow(session));
      section.append(children); if (!expanded) section.classList.add('collapsed'); target.append(section);
    }
    if (!projects.length && !generalFolderAvailable()) target.append(button(t('작업 폴더 선택'), pickFolder, 'project-button'));
  }
  function renderPhone() {
    const phone = state.phone || {};
    $('phone-status').textContent = phone.status || t('접근성 설정에서 Mobile Codex 휴대폰 제어를 켜 주세요.');
    $('phone-enable').disabled = !phone.connected || !!phone.enabled; $('floating-chat').disabled = !phone.connected;
    $('phone-enable').hidden = !!phone.enabled;
    $('phone-disable').hidden = !phone.enabled;
    $('phone-stop-banner').hidden = !phone.enabled;
    $('phone-thread-note').hidden = state.phoneToolsAvailable !== false;
    $('phone-screenshot-note').textContent = phone.screenshotsSupported === false ? t('Android 10에서는 화면 요소를 읽어 조작합니다. 스크린샷은 Android 11 이상에서 지원합니다.') : t('화면 위의 중지 버튼으로 즉시 끌 수 있습니다. 앱 프로세스가 다시 시작되면 제어는 꺼집니다.');
  }
  async function enablePhone() {
    const result = await call('ui.phoneEnable');
    if (!result.cancelled) { state.phone = result; renderPhone(); }
  }
  async function stopPhone() {
    await call('phone.stop');
    state.phone = {...state.phone, enabled:false, status:t('휴대폰 제어 꺼짐')}; renderPhone();
  }
  function configuredApi() { return state.authState !== 'unconfigured' && !!(state.apiActive && (state.apiProviders || []).some(p => p.id === state.apiActive && p.hasKey)); }
  let navigationSignature = '';
  function render(next) {
    const previousThread = state.threadId;
    const changedThread = previousThread !== next.threadId;
    if (changedThread) unreadAssistantOutput = false;
    else if (!following && !unreadAssistantOutput && hasNewAssistantOutput(next)) unreadAssistantOutput = true;
    const changedTurn = !!state.turnId && state.turnId !== next.turnId;
    const anchor = changedThread ? null : readingPosition();
    const wasBusy = !!state.busy;
    const changedFileContext = fileWorkspaceScope(state) !== fileWorkspaceScope(next);
    if (changedFileContext) resetFileContext();
    setDraftScope(next); state = {...historySnapshot(next, changedThread), sessions:[...(next.sessions || [])].sort((left, right) => (right.lastMessageAt || 0) - (left.lastMessageAt || 0))};
    apiProvidersUi?.render(state);
    githubUi?.render(state);
    state.models ||= []; state.messages ||= []; state.projects ||= []; state.accounts ||= []; state.workspace ||= {}; state.account ||= {}; state.rateLimits ||= {};
    const logged = configuredApi(), selected = state.workspace.selected;
    const name = selected ? state.workspace.name : t('일반 대화');
    $('project-label').textContent = workspaceFolderLabel(); $('header-project-label').textContent = name;
    $('header-title').textContent = (state.sessions || []).find(s => s.id === state.threadId)?.title || t('새 대화');
    const apiName = (state.apiProviders || []).find(profile => profile.id === state.apiActive)?.name;
    $('header-api').textContent = state.apiCanRebind ? 'API · 重新绑定' : 'API · ' + (apiName || (state.threadId ? '不可用' : '未选择')) + (apiName && !logged ? '（不可用）' : '');
    $('header-api').title = $('header-api').textContent;
    $('welcome').hidden = state.messages.length > 0; $('onboarding').hidden = logged; $('suggestions').hidden = !logged;
    const generalPrompts = [t('작업을 계획하고 필요한 정보를 정리해줘.'),t('아이디어를 구조화하고 다음 단계를 제안해줘.'),t('무엇을 도와줄 수 있는지 알려줘.')];
    document.querySelectorAll('[data-prompt]').forEach((button, i) => { button.dataset.prompt = selected ? [t('이 폴더에 어떤 파일이 있는지 살펴보고 정리해줘.'),t('이 프로젝트를 살펴보고 실행 방법과 개선할 부분을 알려줘.'),t('이 프로젝트의 변경 사항을 검토하고 버그가 있는지 찾아줘.')][i] : generalPrompts[i]; if (button.lastChild?.nodeType === Node.TEXT_NODE) button.lastChild.textContent = selected ? [t('폴더 살펴보기'),t('프로젝트 이해하기'),t('변경 사항 검토')][i] : [t('작업 계획하기'),t('아이디어 정리하기'),t('도움말 보기')][i]; });
    $('api-step').textContent = logged ? '✓' : '1'; $('api-step').classList.toggle('done', logged);
    const folderReady = workspaceFilesAvailable();
    $('folder-step').textContent = folderReady ? '✓' : '2'; $('folder-step').classList.toggle('done', folderReady);
    $('settings-status').textContent = state.status; $('settings-indicator').textContent = state.ready ? t('연결됨') : t('연결 안 됨'); $('settings-indicator').classList.toggle('online', !!state.ready);
    const pendingDeletes = Number(state.pendingDeletionCount) || 0;
    $('pending-deletions').hidden = pendingDeletes === 0;
    $('pending-deletions').textContent = pendingDeletes ? t('원본 삭제 대기 {count}건. 아래 ‘Codex 시작 / 다시 연결’을 누르면 다시 시도합니다.', {count:pendingDeletes}) : '';
    const anyBusy = !!state.busy;
    $('stream-retry').hidden = !(anyBusy && state.streamRetrying);
    const usage = state.subagentUsage, counter = $('subagent-usage');
    const liveUsage = anyBusy && usage && usage.turnId === state.turnId;
    const totalAgents = liveUsage || !anyBusy ? usage?.total || 0 : 0;
    counter.hidden = totalAgents === 0;
    const countLabel = counter.hidden ? '' : t('이번 작업에서 시작한 하위 에이전트: {count}', {count:totalAgents}) +
      (liveUsage && totalAgents && Number.isInteger(usage.running) ? ' · ' + t('실행 중: {count}', {count:usage.running}) : '');
    if (counter.textContent !== countLabel) counter.textContent = countLabel;
    $('activity').hidden = !anyBusy;
    updateComposerExpansion();
    if (!anyBusy || changedThread || changedTurn || !wasBusy) {
      resetTaskActivities();
      $('activity-text').textContent = t('Codex 작업 중');
      if (anyBusy) for (const request of requestQueue.values()) if (requestThread(request) === state.threadId)
        showTaskActivity(C.taskActivity('server.request', request), request);
    }

    drawTurnProgress();
    $('terminal-cwd').textContent = state.cwd || '';
    if (state.terminal) renderTerminal(state.terminal);
    $('storage-status').textContent = state.directWorkspace ? t('선택한 폴더에서 셸 명령을 실행합니다.') : t('폴더의 셸 접근은 기기 파일 권한이 필요합니다. 문서 제공자 폴더는 파일 도구로 접근합니다.');
    $('storage-access').textContent = state.allFilesAccess ? t('기기 파일 접근 설정') : t('기기 파일 접근 허용');
    renderDevtools();
    renderLinux();
    renderPhone();
    if (changesScope !== reviewScope()) { changesGeneration++; changesScope = reviewScope(); selectedChange = null; $('change-preview').hidden = true; $('change-restore').disabled = true; $('changes-list').replaceChildren(); if ($('changes-dialog').open) $('changes-status').textContent = t('대화 또는 프로젝트가 바뀌었습니다. 새로고침해 주세요.'); }
    $('changes-turn-diff').textContent = state.turnDiff || t('이 대화에 기록된 작업 diff가 없습니다.');
    if (selectedChange) $('change-restore').disabled = restoringChange || !selectedChange.data.canRestore || !!state.busy || state.permissions === 'read-only';
    readChatFolders();
    const navigationKey = JSON.stringify([folderScope, state.projects, state.sessions, !state.projects.length && generalFolderAvailable(), projectWorkBusy(), L.language()]);
    if (navigationKey !== navigationSignature) {
      const scroller = $('sidebar').querySelector('.sidebar-scroll');
      let scrollTop = scroller.scrollTop;
      const focused = sessionCard?.card.contains(document.activeElement) ? document.activeElement : null;
      sessionRows.clear();
      navigationSignature = navigationKey; renderProjects();
      syncProjectLinkControls();
      $('sessions').replaceChildren();
      renderChatFolders();
      const projectWorkspaceKeys = new Set((state.projects || []).flatMap(projectKeys));
      const sessionWorkspaceKey = session => session.workspaceKey || (typeof session.workspace === 'string' ? session.workspace : '');
      for (const session of (state.sessions || []).filter(session => !projectWorkspaceKeys.has(sessionWorkspaceKey(session)) && !folderFor(session.id))) $('sessions').append(sessionRow(session));
      if (!state.sessions?.length) $('sessions').append(node('p', t('대화를 시작하면 여기에 표시됩니다.'), 'sidebar-empty'));
      if (sessionCard) {
        const current = (state.sessions || []).find(session => session.id === sessionCard.id);
        const row = current && sessionRows.get(current.id);
        if (row) {
          const {card} = sessionCard;
          const menu = row.querySelector('.session-more');
          sessionCard.menu = menu;
          menu.setAttribute('aria-expanded', 'true'); menu.setAttribute('aria-controls', card.id);
          row.append(card);
          focused?.focus({preventScroll:true});
        } else {
          if (Math.abs(scrollTop - sessionCard.cardScrollTop) < 1) scrollTop = sessionCard.originalScrollTop;
          closeSessionCard();
        }
      }
      scroller.scrollTop = scrollTop;
    } else if (changedThread) {
      const previousRow = sessionRows.get(previousThread), currentRow = sessionRows.get(state.threadId);
      if (previousRow) setSessionActive(previousRow, false);
      if (currentRow) setSessionActive(currentRow, true);
    }
    if (sessionCard) {
      const current = (state.sessions || []).find(session => session.id === sessionCard.id);
      const remove = sessionCard.card.querySelector('[data-session-delete]');
      if (current && remove) remove.disabled = sessionEdits.has(current.id) || sessionWorkBusy(current);
    }
    const key = JSON.stringify([state.apiActive || '', state.models]);
    if (key !== modelKey) {
      modelKey = key; const value = draftOptions.model || $('model').value, choices = state.models.filter(m => (m.model || m.id) !== LEGACY_PRO_MODEL);
      $('model').replaceChildren(); for (const m of choices) $('model').add(new Option(m.displayName || m.model || m.id, m.model || m.id));
      if (!choices.length) $('model').add(new Option(t('모델 목록 조회 필요'), ''));
      const savedMissing = draftOptions.model && value !== LEGACY_PRO_MODEL && !choices.some(m => (m.model || m.id) === value);
      if (savedMissing) $('model').add(new Option(value + ' · ' + t('목록 확인 필요'), value));
      $('model').value = savedMissing || choices.some(m => (m.model || m.id) === value) ? value : ((choices.find(m => m.isDefault)?.model || choices.find(m => m.isDefault)?.id) || choices[0]?.model || choices[0]?.id || '');
      efforts(draftOptions.effort || $('effort').value);
    }
    syncPermissionControls(state.permissions, anyBusy);
    syncApprovalControl(anyBusy);
    renderModelList();
    if (changedThread) { chatTouch?.cancel(); following = true; $('event-log').replaceChildren(); if ($('live-work').parentElement === $('messages')) $('messages').after($('live-work')); $('messages').replaceChildren(); }
    updateHistoryControl();
    updateSend(); optionsSummary(); drawUpdates(updateState);
    drawMessages(null, false);
    agentUi?.render();
    restoreReadingPosition(anchor);
    $('prompt').placeholder = agentUi?.grouped() ? t('모두에게 보내기 · @로 한 명만 부르기') : t('Codex에게 물어보기');
    // A request can arrive while another conversation is visible. Once the
    // selected session is restored, show only that session's pending request.
    nextRequest(); syncSubagentControls();
    if (changedFileContext && !$('file-panel').hidden) listFiles().catch(error => toast(error.message));
  }
  function logEvent(title, data) {
    const detail = node('details', null, 'event-card'); detail.append(node('summary', title), node('pre', typeof data === 'string' ? data : JSON.stringify(data, null, 2), 'console'));
    $('event-log').append(detail);
    while ($('event-log').children.length > 150) $('event-log').firstChild.remove();
  }
  function fileWorkspaceScope(snapshot = state) {
    return JSON.stringify([accountScope(snapshot.account), snapshot.workspace?.key || '', !!snapshot.workspace?.selected, snapshot.workspace?.available !== false, snapshot.cwd || '']);
  }
  function fileContext() { return {scope:fileWorkspaceScope(), workspaceKey:state.workspace?.key || '', generation:fileContextGeneration}; }
  function sameFileContext(context) { return !!context && context.scope === fileWorkspaceScope() && context.generation === fileContextGeneration; }
  function requireFileContext(context) { if (!sameFileContext(context)) throw new Error(t('프로젝트가 바뀌었습니다. 다시 열어 주세요.')); }
  function fileDraftKey(context, path) { return JSON.stringify([context.scope, path]); }
  function rememberFileDraft() {
    if (!openedFile) return;
    const key = fileDraftKey(openedFile.context, openedFile.path);
    if ($('editor').value !== openedFile.content) fileDrafts.set(key, {content:$('editor').value, originalContent:openedFile.content, sha256:openedFile.sha256});
    else fileDrafts.delete(key);
  }
  function relocateFileDraft(context, source, destination) {
    if (source === destination) return;
    const relocated = [];
    for (const [key, draft] of fileDrafts) {
      const [scope, path] = JSON.parse(key);
      if (scope === context.scope && (path === source || path.startsWith(source + '/')))
        relocated.push({previousKey:key, nextKey:fileDraftKey(context, destination + path.slice(source.length)), draft});
    }
    // Snapshot first so a directory move cannot remap its own newly written keys.
    for (const entry of relocated) fileDrafts.delete(entry.previousKey);
    for (const entry of relocated) fileDrafts.set(entry.nextKey, entry.draft);
  }
  function resetFileContext() {
    rememberFileDraft(); fileContextGeneration++; fileSeq++; fileReadSeq++;
    clearTimeout(searchTimer); folder = ''; $('file-query').value = '';
    $('breadcrumbs').textContent = ''; $('file-up').disabled = true; $('file-list').replaceChildren();
    openedFile = null; $('editor').value = ''; $('editor-title').textContent = t('파일');
    if ($('editor-dialog').open) close('editor-dialog');
    if ($('file-actions-dialog').open) close('file-actions-dialog');
    if (fileInputContext && $('input-dialog').open) close('input-dialog');
  }
  async function fileInput(context, title, description, value = '') {
    requireFileContext(context); fileInputContext = context;
    try { const result = await input(title, description, value); requireFileContext(context); return result; }
    finally { if (fileInputContext === context) fileInputContext = null; }
  }
  async function pickFolder(projectKey = '') {
    const busy = projectWorkBusy();
    if (projectKey && busy) return;
    const threadId = state.threadId, workspaceKey = state.workspace?.key || '';
    const result = await call('files.pick', projectKey ? {projectKey} : {});
    const onlyAdded = !projectKey && result.key && result.key !== workspaceKey
      && threadId === state.threadId && workspaceKey === (state.workspace?.key || '');
    if (!result.cancelled && !onlyAdded && !busy && !projectWorkBusy()) {
      folder = ''; $('file-query').value = '';
      if (!$('file-panel').hidden) await listFiles();
    }
    return result;
  }
  async function listFiles(query = '') {
    const context = fileContext(), requestedFolder = folder, version = ++fileSeq;
    if (!workspaceFilesAvailable()) { $('file-list').replaceChildren(button(t('작업 폴더 선택'), pickFolder)); return; }
    $('file-list').replaceChildren(node('p', t('불러오는 중…'), 'empty-note'));
    const result = await call(query ? 'files.search' : 'files.list', {workspaceKey:context.workspaceKey, ...(query ? {query} : {path:requestedFolder})});
    if (version !== fileSeq || !sameFileContext(context)) return;
    $('breadcrumbs').textContent = query ? t('검색: ') + query : workspaceFolderLabel() + (requestedFolder ? ' / ' + requestedFolder : '');
    $('file-up').disabled = !requestedFolder || !!query; $('file-list').replaceChildren();
    for (const entry of result.entries || []) {
      const row = node('div', null, 'file-entry');
      const b = button('', async () => { requireFileContext(context); if (entry.directory) { folder = entry.path; $('file-query').value = ''; await listFiles(); } else await openFile(entry.path, context); }, 'file-row');
      b.append(icon(entry.directory ? 'folder' : 'file'), node('span', entry.name), node('small', entry.directory ? '' : C.size(entry.size))); row.append(b);
      const menu = button('⋯', () => fileAction(entry, context), 'icon-button'); menu.setAttribute('aria-label', entry.name + t(' 관리')); row.append(menu); $('file-list').append(row);
    }
    if (!result.entries?.length) $('file-list').append(node('p', t('항목이 없습니다.'), 'empty-note'));
    if (result.truncated) $('file-list').append(node('p', t('일부 검색 결과입니다. 더 구체적인 이름으로 검색하세요.'), 'empty-note'));
  }
  async function openFile(path, context = fileContext()) {
    requireFileContext(context); const version = ++fileReadSeq;
    if (/\.(png|jpe?g|webp|gif|bmp|heic|heif|avif)$/i.test(path)) {
      const image = await call('images.read', {path, workspaceKey:context.workspaceKey});
      if (version === fileReadSeq && sameFileContext(context)) previewImage(image);
      return;
    }
    const result = await call('files.read', {path, workspaceKey:context.workspaceKey, preview:true});
    if (version !== fileReadSeq || !sameFileContext(context)) return;
    if (result.openWithApp) return openFileWithApp(path, context, false);
    rememberFileDraft();
    const draft = fileDrafts.get(fileDraftKey(context, result.path || path));
    openedFile = {...result, context, ...(draft ? {content:draft.originalContent, sha256:draft.sha256} : {})};
    $('editor-title').textContent = openedFile.path; $('editor').value = draft ? draft.content : openedFile.content; show('editor-dialog');
  }
  function openFileWithApp(path, context, choose) {
    requireFileContext(context);
    fileReadSeq++;
    return call('files.open', {path, workspaceKey:context.workspaceKey, choose});
  }
  function input(title, description, value = '') {
    if (inputResolve) inputResolve(null);
    $('input-title').textContent = title; $('input-description').textContent = description; $('input-value').value = value; show('input-dialog'); $('input-value').focus();
    return new Promise(resolve => inputResolve = resolve);
  }
  async function mutate(operation, args, context = fileContext(), applied) {
    requireFileContext(context);
    const result = await call('files.mutate', {operation, arguments:args, workspaceKey:context.workspaceKey});
    if (applied) applied(result);
    requireFileContext(context); toast(t('적용했습니다.'));
    if (!$('file-panel').hidden) {
      try { await listFiles($('file-query').value.trim()); }
      catch (error) { if (sameFileContext(context)) toast(error.message); }
    }
    // A failed panel refresh must not hide a completed move from the editor.
    requireFileContext(context); return result;
  }
  function fileAction(entry, context = fileContext()) {
    requireFileContext(context);
    $('file-actions-title').textContent = entry.name;
    const action = (label, fn, cls) => button(label, async () => { close('file-actions-dialog'); await fn(); }, cls);
    $('file-actions').replaceChildren(
      action(t('이름 변경'), async () => { const name = await fileInput(context, t('이름 변경'), t('새 이름'), entry.name); if (name) await mutate('mobile_rename', {path:entry.path, name}, context, result => relocateFileDraft(context, entry.path, result.path || C.join(C.parent(entry.path), name))); }),
      action(t('이동'), async () => { const destination = await fileInput(context, t('이동'), t('작업 폴더 기준 대상 폴더 경로 (루트는 빈칸)')); if (destination !== null) await mutate('mobile_move', {path:entry.path, destination}, context, result => relocateFileDraft(context, entry.path, result.path || C.join(destination, C.basename(entry.path)))); }),
      action(t('삭제'), () => mutate('mobile_delete', {path:entry.path}, context), 'secondary-button danger'),
      ...(!entry.directory ? [action(t('다른 앱으로 열기'), () => openFileWithApp(entry.path, context, true))] : [])
    );
    show('file-actions-dialog');
  }
  function currentEditor() {
    if (!openedFile) throw new Error(t('파일을 읽을 수 없습니다.'));
    requireFileContext(openedFile.context); return openedFile;
  }
  async function saveEditor() {
    const file = currentEditor(), content = $('editor').value;
    const result = await mutate('mobile_write', {path:file.path, expectedSha256:file.sha256, content}, file.context);
    if (openedFile !== file) return;
    const saved = await call('files.read', {path:result.path || file.path, workspaceKey:file.context.workspaceKey});
    if (openedFile !== file || !sameFileContext(file.context)) return;
    openedFile = {...saved, context:file.context}; rememberFileDraft();
  }
  async function relocateEditor(operation) {
    const file = currentEditor();
    const value = await fileInput(file.context, t(operation === 'mobile_rename' ? '이름 변경' : '이동'), t(operation === 'mobile_rename' ? '새 파일 이름' : '대상 폴더 경로 (루트는 빈칸)'), operation === 'mobile_rename' ? C.basename(file.path) : '');
    if (value === null || (operation === 'mobile_rename' && !value)) return;
    if (openedFile !== file) return;
    const args = operation === 'mobile_rename' ? {path:file.path, name:value} : {path:file.path, destination:value};
    await mutate(operation, args, file.context, result => {
      const requestedPath = C.join(operation === 'mobile_rename' ? C.parent(file.path) : value, operation === 'mobile_rename' ? value : C.basename(file.path));
      const path = result.path || requestedPath;
      relocateFileDraft(file.context, file.path, path);
      // Record the successful relocation before refreshing. If the user has
      // switched projects, only migrate that project's draft; never paint it here.
      if (openedFile !== file || !sameFileContext(file.context)) return;
      openedFile = {...file, path}; $('editor-title').textContent = path; rememberFileDraft();
    });
  }
  async function loadInstructions() {
    if (instructionsSaving) return;
    if (instructionsLoaded && $('instructions-editor').value !== instructionsOriginal && !confirm(t('저장하지 않은 지침을 다시 불러올까요?'))) return;
    $('instructions-status').textContent = t('지침을 불러오는 중…');
    $('instructions-editor').disabled = true; $('instructions-save').disabled = true;
    try {
      const result = await call('instructions.read');
      instructionsOriginal = result.content || ''; $('instructions-editor').value = instructionsOriginal;
      instructionsLoaded = true; $('instructions-path').textContent = t('저장 위치: ') + (result.activePath || result.path || '.codex/AGENTS.md');
      $('instructions-status').textContent = result.notice || t('저장된 지침을 편집할 수 있습니다.');
    } catch (error) { $('instructions-status').textContent = t('지침을 불러오지 못했습니다. ') + error.message; }
    finally { $('instructions-editor').disabled = !instructionsLoaded; $('instructions-save').disabled = !instructionsLoaded; }
  }
  async function saveInstructions() {
    if (!instructionsLoaded || instructionsSaving) return;
    const content = $('instructions-editor').value; instructionsSaving = true;
    $('instructions-save').disabled = true; $('instructions-status').textContent = t('저장 중…');
    try {
      const result = await call('instructions.save', {content});
      instructionsOriginal = typeof result.content === 'string' ? result.content : content;
      if ($('instructions-editor').value === content) $('instructions-editor').value = instructionsOriginal;
      if (result.activePath || result.path) $('instructions-path').textContent = t('저장 위치: ') + (result.activePath || result.path);
      $('instructions-status').textContent = t('저장했습니다. 다음 요청부터 적용됩니다.') + (result.notice ? ' ' + result.notice : '');
    } catch (error) { $('instructions-status').textContent = t('저장하지 못했습니다. 작성 내용은 그대로 남아 있습니다. ') + error.message; }
    finally { instructionsSaving = false; $('instructions-save').disabled = false; }
  }
  async function config() { const result = await call('config.read'); configOriginal = result.content; $('config-editor').value = result.content; show('config-dialog'); }
  let changesGeneration = 0, changesScope = '', selectedChange = null, restoringChange = false;
  const reviewScope = () => (state.workspace?.key || '') + '\0' + (state.threadId || '');
  const reviewArgs = extra => ({workspaceKey:state.workspace?.key || '', ...extra});
  function showFileDiff(before, after) {
    const diff=C.fileDiff(before,after),box=$('change-diff');box.replaceChildren();
    if(diff.identical){box.textContent=t('내용 차이가 없습니다.');return;}
    for(const hunk of diff.hunks){
      box.append(node('span',`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@\n`,'diff-context'));
      for(const line of hunk.lines){
        if(line.kind==='omitted'){box.append(node('span',`… ${line.count} …\n`,'diff-context'));continue;}
        const oldNumber=line.kind==='+'?'':String(line.oldLine),newNumber=line.kind==='-'?'':String(line.newLine);
        box.append(node('span',oldNumber.padStart(5)+' '+newNumber.padStart(5)+' '+line.kind+' '+line.text+'\n',line.kind==='-'?'diff-removed':line.kind==='+'?'diff-added':'diff-context'));
        if(line.noNewline)box.append(node('span',t('\\ 마지막 줄에 줄바꿈 없음')+'\n','diff-context'));
      }
    }
    if(diff.approximate)box.append(node('span',t('큰 변경 구간은 간략히 비교했습니다. 표시된 문맥 밖의 변경도 확인하세요.')+'\n','diff-context'));
    if(diff.truncated)box.append(node('span',t('… 일부 변경 내용은 생략했습니다. 파일 탐색기에서 전체 내용을 확인하세요.')+'\n','diff-context'));
  }
  async function previewChange(kind, value) {
    const generation=++changesGeneration, scope=reviewScope(), args=reviewArgs(kind==='git'?{path:value}:{id:value});
    selectedChange=null; $('change-restore').disabled=true; $('changes-status').textContent=t('파일 내용을 확인하는 중…');
    const action=kind==='git'?'changes.preview':kind==='backup'?'changes.backupPreview':'recovery.preview';
    try {
      const data=await call(action,args); if(generation!==changesGeneration || scope!==reviewScope())return;
      selectedChange={kind,data,workspaceKey:args.workspaceKey};
      $('change-path').textContent=data.path; $('change-note').textContent=data.note || '';
      if (data.previewLimited) $('change-diff').textContent = t('텍스트 전체를 표시할 수 없는 파일입니다.\n이전: ') + data.before + '\nSHA-256: ' + data.beforeSha256 + t('\n현재: ') + data.after + '\nSHA-256: ' + data.afterSha256;
      else showFileDiff(data.before,data.after);
      $('change-preview').hidden=false;
      $('change-restore').textContent=data.actionLabel || t('복원'); $('change-restore').disabled=!data.canRestore || state.busy || state.permissions==='read-only';
      $('changes-status').textContent=(data.beforeExists===false?t('이전 파일 없음 · '):'')+(data.afterExists===false?t('현재 파일 없음'):'');
    } catch(error) { if(generation===changesGeneration) $('changes-status').textContent=error.message; }
  }
  async function loadChanges(history=false) {
    const generation=++changesGeneration, scope=reviewScope(), args=reviewArgs({}); changesScope=scope;
    selectedChange=null; $('change-preview').hidden=true; $('change-restore').disabled=true;
    show('changes-dialog'); sidebar(false); $('changes-list').replaceChildren(); $('changes-status').textContent=t('불러오는 중…');
    try {
      const result=await call(history?'changes.history':'changes.list',args);
      if(generation!==changesGeneration || scope!==reviewScope())return;
      $('changes-status').textContent=result.note || (history?t('파일 복원 직전의 사본입니다. 이후 수정된 파일은 자동으로 덮어쓰지 않습니다.'):'');
      for(const entry of result.entries || []) {
        const row=node('div',null,'recovery-item'), desc=node('div'); desc.append(node('strong',entry.path),node('small',history?new Date(entry.timestamp).toLocaleString(L.language()):entry.status));
        row.append(desc,button(t('비교'),()=>previewChange(history?'backup':'git',history?entry.id:entry.path))); $('changes-list').append(row);
      }
      if(!result.entries?.length) $('changes-list').append(node('p',history?t('복원 사본이 없습니다.'):t('현재 Git 변경 사항이 없습니다.'),'empty-note'));
    } catch(error) { if(generation===changesGeneration) $('changes-status').textContent=error.message+t(' 문서 제공자 파일은 복구 사본에서 확인할 수 있습니다.'); }
  }
  async function restoreChange() {
    const selected=selectedChange; if(!selected || !selected.data.canRestore || restoringChange)return;
    if(selected.workspaceKey!==(state.workspace?.key || ''))throw new Error(t('프로젝트가 바뀌었습니다.'));
    if(!confirm(selected.data.path+'\n'+(selected.data.actionLabel || t('복원'))+t('할까요?')))return;
    restoringChange=true; $('change-restore').disabled=true;
    try {
      const args={workspaceKey:selected.workspaceKey};
      if(selected.kind==='saf')args.id=selected.data.id;else args.token=selected.data.token;
      await call(selected.kind==='saf'?'recovery.restore':'changes.restore',args);
      toast(t('파일 내용을 복원했습니다.'));
      if(selected.workspaceKey===(state.workspace?.key || '')) { if(selected.kind==='saf'){close('changes-dialog');await recovery();}else await loadChanges(); if(!$('file-panel').hidden)await listFiles(); }
    } finally { restoringChange=false; if(selectedChange===selected)$('change-restore').disabled=false; }
  }
  async function recovery() {
    show('recovery-dialog'); const {entries} = await call('recovery.list'); $('recovery-list').replaceChildren();
    for (const entry of entries || []) { const row = node('div', null, 'recovery-item'), desc = node('div'); desc.append(node('strong', entry.path), node('small', new Date(entry.timestamp).toLocaleString(L.language()))); row.append(desc, button(t('비교 / 복원'), async () => { close('recovery-dialog'); show('changes-dialog'); await previewChange('saf',entry.id); }), button(t('다른 위치에 저장'), () => call('recovery.export', {id: entry.id, name: C.basename(entry.path)}))); $('recovery-list').append(row); }
    if (!entries?.length) $('recovery-list').append(node('p', t('저장된 복구 사본이 없습니다.'), 'empty-note'));
  }
  let toolsScope = "", toolsGeneration = 0, toolsTab = 0, toolsQuery = "";
  const currentToolsScope = () => JSON.stringify([state.cwd, state.threadId, state.apiActive]);
  function accountScope() { return providerScope(); }
  function selectSettingsTab(name) {
    document.querySelectorAll('[data-settings-tab]').forEach(button => {
      const selected = button.dataset.settingsTab === name;
      button.classList.toggle('active', selected);
      if (selected) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    document.querySelectorAll('[data-settings-panel]').forEach(panel => panel.hidden = panel.dataset.settingsPanel !== name);
    $('settings-dialog').scrollTop = 0;
    const content = document.querySelector('.settings-content'); if (content) content.scrollTop = 0;
    frame(() => {
      const selected = document.querySelector('.settings-nav button.active'), nav = selected?.parentElement;
      if (!$('settings-dialog').open || !selected || !nav) return;
      const item = selected.getBoundingClientRect(), bounds = nav.getBoundingClientRect();
      if (item.left < bounds.left) nav.scrollLeft -= bounds.left - item.left;
      else if (item.right > bounds.right) nav.scrollLeft += item.right - bounds.right;
    });
  }
  function setFilePanelOpen(open) {
    $('file-panel').hidden = !open;
    $('files-toggle').setAttribute('aria-controls', 'file-panel');
    $('files-toggle').setAttribute('aria-expanded', String(open));
  }
  function openProviderSettings() { selectSettingsTab('providers'); show('settings-dialog'); sidebar(false); }
  async function loadTools(force = false) {
    show('tools-dialog'); const target = $('tools-list');
    const scope = currentToolsScope(), generation = ++toolsGeneration;
    if (toolsScope !== scope) { toolCache.fill(null); toolsScope = scope; }
    if (!toolCache.some(Boolean)) target.replaceChildren(node('p', t('불러오는 중…'), 'muted'));
    const cwds = state.cwd ? [state.cwd] : [];
    const results = await Promise.allSettled([rpc('plugin/list', {cwds, ...(force ? {forceRefetch:true} : {})}), rpc('skills/list', {cwds, ...(force ? {forceReload:true} : {})}), rpc('mcpServerStatus/list', {limit: 100, ...(state.threadId ? {threadId: state.threadId} : {})})]);
    if (generation !== toolsGeneration || scope !== currentToolsScope()) return;
    target.replaceChildren();
    // Plugins, skills and MCP servers each get a tab; long lists stay searchable instead of one long scroll.
    const titles = [t('플러그인'), t('스킬'), t('MCP 서버')], counts = [0, 0, 0];
    const tabs = node('div', null, 'tools-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', t('도구 종류'));
    const search = node('input', null, 'tools-search'); search.type = 'search'; search.placeholder = t('이름 또는 설명 검색'); search.setAttribute('aria-label', t('도구 검색')); search.value = toolsQuery;
    const panels = titles.map((title, i) => { const panel = node('section', null, 'tools-panel'); panel.dataset.toolsPanel = String(i); panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-label', title); return panel; });
    const empty = node('p', t('검색 결과가 없습니다.'), 'empty-note tools-no-match'); empty.hidden = true;
    const card = (name, description, parent) => {
      const c = node('div', null, 'tool-card'), main = node('div', null, 'tool-card-main');
      main.append(node('strong', name), node('p', description || '', 'muted')); c.append(main); parent.append(c); return c;
    };
    const actions = (c, ...buttons) => { let row = c.querySelector('.tool-card-actions'); if (!row) { row = node('div', null, 'tool-card-actions'); c.append(row); } row.append(...buttons); return row; };
    const group = (title, parent) => { const g = node('div', null, 'tools-group'); g.append(node('h4', title, 'tools-group-title')); parent.append(g); return g; };
    titles.forEach((title, i) => {
      const panel = panels[i], result = results[i];
      if (result.status === 'fulfilled') toolCache[i] = result.value;
      const data = result.status === 'fulfilled' ? result.value : toolCache[i];
      if (result.status === 'rejected') { card(t('불러오지 못했습니다'), errorText(result.reason) + (data ? t(' 이전 목록을 표시합니다.') : ''), panel).classList.add('tool-card-notice'); if (!data) return; }
      if (i === 0) {
        for (const market of data.marketplaces || []) {
          const parent = group(market.interface?.displayName || market.name, panel);
          for (const plugin of market.plugins || []) {
            counts[0]++;
            const c = card(plugin.interface?.displayName || plugin.name, plugin.interface?.shortDescription || plugin.id, parent);
            if (plugin.installed) c.classList.add(plugin.enabled ? 'is-enabled' : 'is-disabled');
            const params = {pluginName: plugin.name, ...(market.path ? {marketplacePath: market.path} : {remoteMarketplaceName: market.name})};
            actions(c, button(t('상세'), async () => { const detail = await rpc('plugin/read', params); logEvent(t('플러그인: ') + plugin.name, detail.plugin); show('activity-dialog'); }));
            if (plugin.installed) {
              actions(c, button(plugin.enabled ? t('비활성화') : t('활성화'), async () => { await rpc('config/value/write', {keyPath: 'plugins.' + JSON.stringify(plugin.id) + '.enabled', value: !plugin.enabled, mergeStrategy: 'replace'}); await loadTools(); }),
                button(t('제거'), async () => { if (!confirm(plugin.name + t(' 플러그인을 제거할까요?'))) return; await rpc('plugin/uninstall', {pluginId: plugin.id}); await loadTools(); }, 'secondary-button subtle-danger'));
            } else actions(c, button(t('설치'), async () => {
              const detail = await rpc('plugin/read', params);
              const summary = detail.plugin;
              if (!confirm(plugin.name + t(' 설치\n\n') + (summary.description || '') + t('\n\n스킬 ') + (summary.skills?.length || 0) + t('개 · MCP ') + (summary.mcpServers?.length || 0) + t('개 · 훅 ') + (summary.hooks?.length || 0) + t('개'))) return;
              const result = await rpc('plugin/install', params);
              for (const app of result.appsNeedingAuth || []) if (app.installUrl) { const c = card(app.name + t(' 계정 연결'), t('플러그인을 사용하려면 계정 연결이 필요합니다.'), panel); actions(c, button(t('연결'), () => call('ui.externalBrowser', {url: app.installUrl}))); }
              toast(t('플러그인을 설치했습니다.')); if (!result.appsNeedingAuth?.length) await loadTools();
            }, 'primary-button'));
          }
        }
        for (const e of data.marketplaceLoadErrors || []) card(t('마켓플레이스 오류'), errorText(e.message), panel).classList.add('tool-card-notice');
        if (!data.marketplaces?.length) card(t('등록된 플러그인이 없습니다'), t('마켓플레이스를 추가하거나 계정 연결 상태를 확인하세요.'), panel).classList.add('tool-card-notice');
      } else if (i === 1) {
        for (const entry of data.data || []) {
          for (const skill of entry.skills || []) {
            counts[1]++; const c = card(skill.interface?.displayName || skill.name, skill.description, panel);
            c.classList.add(skill.enabled === false ? 'is-disabled' : 'is-enabled');
            c.querySelector('.tool-card-main').append(node('small', skill.path, 'tool-card-path'));
            actions(c, button(t('대화에 사용'), () => { $('prompt').value += '$' + skill.name + ' '; close('tools-dialog'); $('prompt').focus(); }),
              button(skill.enabled ? t('비활성화') : t('활성화'), async () => { await rpc('skills/config/write', {path: skill.path, enabled: !skill.enabled}); await loadTools(); }));
          }
          for (const e of entry.errors || []) card(t('스킬 로드 오류'), errorText(e.message), panel).classList.add('tool-card-notice');
        }
        if (!counts[1]) card(t('설치된 스킬이 없습니다'), t('SKILL.md가 들어 있는 스킬 폴더를 가져오거나 Codex에게 스킬 생성을 요청하세요.'), panel).classList.add('tool-card-notice');
      } else {
        for (const server of data.data || []) {
          counts[2]++;
          const c = card(server.name, (server.runtimeStatus?.status || server.authStatus) + t(' · 도구 ') + Object.keys(server.tools || {}).length + t('개'), panel);
          if (server.toolsError) c.querySelector('.tool-card-main').append(node('p', errorText(server.toolsError), 'muted tool-card-error'));
          actions(c, button(t('도구 보기'), () => { logEvent('MCP: ' + server.name, server); show('activity-dialog'); }), button(t('로그인'), async () => { const r = await rpc('mcpServer/oauth/login', {name: server.name}); await call('ui.externalBrowser', {url: r.authorizationUrl}); }));
        }
        if (!data.data?.length) card(t('설정된 MCP 서버가 없습니다'), t('서버 설정에서 HTTP 또는 stdio 서버를 추가할 수 있습니다.'), panel).classList.add('tool-card-notice');
        if (data.nextCursor) panel.append(node('p', t('표시된 서버: 처음 100개'), 'muted'));
      }
    });
    const tabButtons = titles.map((title, i) => {
      const b = node('button', null, 'tools-tab'); b.type = 'button'; b.id = 'tools-tab-' + i; b.setAttribute('role', 'tab'); b.dataset.toolsTab = String(i);
      b.append(node('span', title), node('span', String(counts[i]), 'tools-count')); panels[i].setAttribute('aria-labelledby', b.id);
      b.addEventListener('click', () => { toolsTab = i; applyTools(); });
      b.addEventListener('keydown', event => { const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0; if (!step) return; event.preventDefault(); toolsTab = (toolsTab + step + titles.length) % titles.length; applyTools(); tabButtons[toolsTab].focus(); });
      tabs.append(b); return b;
    });
    function applyTools() {
      const query = search.value.trim().toLowerCase(); toolsQuery = search.value;
      tabButtons.forEach((b, i) => { const selected = i === toolsTab; b.setAttribute('aria-selected', String(selected)); b.tabIndex = selected ? 0 : -1; panels[i].hidden = !selected; });
      const panel = panels[toolsTab]; let visible = 0;
      for (const c of panel.querySelectorAll('.tool-card:not(.tool-card-notice)')) { const match = !query || c.textContent.toLowerCase().includes(query); c.hidden = !match; if (match) visible++; }
      for (const g of panel.querySelectorAll('.tools-group')) g.hidden = !!query && !g.querySelector('.tool-card:not([hidden])');
      empty.hidden = !query || visible > 0;
    }
    search.addEventListener('input', applyTools);
    target.append(tabs, search, ...panels, empty);
    applyTools();
  }
  function elicitationForm(schema, target) {
    const fields = [];
    for (const [key, spec] of Object.entries(schema.properties || {})) {
      const box = node('div', null, 'question'), label = node('label', spec.title || key);
      const type = Array.isArray(spec.type) ? spec.type.find(t => t !== 'null') : spec.type;
      const choices = spec.enum || spec.oneOf?.map(o => o.const);
      let field, read;
      if (type === 'object') {
        box.append(label); read = elicitationForm(spec, box);
      } else {
        if (choices) {
          field = node('select'); field.add(new Option(t('선택하세요'), ''));
          choices.forEach((value, i) => field.add(new Option(spec.enumNames?.[i] || spec.oneOf?.[i]?.title || String(value), String(i))));
          if (spec.default !== undefined) field.value = String(choices.indexOf(spec.default));
          read = () => field.value === '' ? undefined : choices[Number(field.value)];
        } else if (type === 'boolean') {
          field = node('input'); field.type = 'checkbox'; field.checked = !!spec.default; read = () => field.checked;
        } else if (type === 'array') {
          const values = spec.items?.enum;
          if (values) {
            field = node('select'); field.multiple = true; values.forEach((value, i) => field.add(new Option(spec.items.enumNames?.[i] || String(value), String(i))));
            for (const option of field.options) option.selected = (spec.default || []).includes(values[Number(option.value)]);
            read = () => [...field.selectedOptions].map(o => values[Number(o.value)]);
          } else {
            field = node('textarea'); field.placeholder = t('항목마다 한 줄씩 입력하세요'); field.value = (spec.default || []).join('\n');
            read = () => field.value.split('\n').filter(value => value.length > 0);
          }
        } else {
          field = node('input'); field.type = ['number', 'integer'].includes(type) ? 'number' : spec.format === 'email' ? 'email' : 'text';
          field.value = spec.default ?? ''; field.step = type === 'integer' ? '1' : 'any';
          if (spec.minimum !== undefined) field.min = spec.minimum;
          if (spec.maximum !== undefined) field.max = spec.maximum;
          if (spec.minLength !== undefined) field.minLength = spec.minLength;
          if (spec.maxLength !== undefined) field.maxLength = spec.maxLength;
          read = () => field.value === '' ? undefined : field.type === 'number' ? Number(field.value) : field.value;
        }
        field.required = (schema.required || []).includes(key) && type !== 'boolean';
        field.setAttribute('aria-label', spec.title || key); label.append(field); box.append(label);
      }
      if (spec.description) box.append(node('p', spec.description, 'muted'));
      target.append(box); fields.push({key, field, read});
    }
    return () => {
      const entries = [];
      for (const entry of fields) {
        if (entry.field && !entry.field.reportValidity()) throw new Error(t('입력 내용을 확인해 주세요.'));
        const value = entry.read(); if (value !== undefined) entries.push([entry.key, value]);
      }
      return Object.fromEntries(entries);
    };
  }
  function requestThread(req) { return String(req?.params?.threadId || ''); }
  function closeBackgroundRequest() {
    if (!displayedRequest) return;
    const req = requestQueue.get(displayedRequest), thread = requestThread(req);
    if (chatSelection || (thread && thread !== state.threadId)) {
      displayedRequest = null;
      if ($('request-dialog').open) close('request-dialog');
    }
  }
  function nextRequest() {
    closeBackgroundRequest();
    if (chatSelection || displayedRequest || !requestQueue.size) return;
    let entry;
    for (const candidate of requestQueue.entries()) {
      const thread = requestThread(candidate[1]);
      if (!thread || thread === state.threadId) { entry = candidate; break; }
    }
    if (!entry) return;
    const [key, req] = entry; displayedRequest = key;
    $('request-title').textContent = req.method.includes('requestUserInput') ? t('Codex 질문') : req.method.includes('requestApproval') ? t('작업 승인') : t('Codex 요청');
    $('request-reason').textContent = req.params.reason || req.params.message || req.method;
    $('request-detail').textContent = JSON.stringify(req.params, null, 2); $('request-fields').replaceChildren(); $('request-actions').replaceChildren();
    const complete = async result => {
      result = await result;
      await call('rpc.respond', {key, result});
      requestQueue.delete(key);
      if (displayedRequest === key) { displayedRequest = null; close('request-dialog'); }
      nextRequest();
    };
    const add = (text, result, cls) => $('request-actions').append(button(text, () => complete(typeof result === 'function' ? result() : result), cls));
    if (req.method === 'item/commandExecution/requestApproval' || req.method === 'item/fileChange/requestApproval') {
      add(t('거절'), {decision: 'decline'}); add(t('이번 대화에 허용'), {decision: 'acceptForSession'}); add(t('허용'), {decision: 'accept'}, 'primary-button');
    } else if (req.method === 'item/permissions/requestApproval') {
      add(t('거절'), {permissions: {}, scope: 'turn'}); add(t('허용'), {permissions: req.params.permissions, scope: 'turn'}, 'primary-button');
    } else if (req.method === 'item/tool/requestUserInput') {
      const answers = [];
      for (const question of req.params.questions || []) {
        const wrap = node('div', null, 'question'), label = node('label', question.question), field = node('input'); field.type = question.isSecret ? 'password' : 'text'; field.setAttribute('aria-label', question.question); label.append(field); wrap.append(label);
        if (question.options?.length) { const select = node('select'); select.setAttribute('aria-label', question.header || question.question); select.add(new Option(t('선택 또는 직접 입력'), '')); for (const o of question.options) select.add(new Option(o.label + (o.description ? ' — ' + o.description : ''), o.label)); select.addEventListener('change', () => field.value = select.value); wrap.append(select); }
        answers.push([question.id, field]); $('request-fields').append(wrap);
      }
      add(t('답변 보내기'), () => ({answers: Object.fromEntries(answers.map(([id, field]) => [id, {answers: [field.value]}]))}), 'primary-button');
    } else if (req.method === 'mcpServer/elicitation/request') {
      add(t('취소'), {action: 'decline'});
      if (req.params.mode === 'url') {
        $('request-fields').append(button(t('연결 페이지 열기'), () => call('ui.externalBrowser', {url: req.params.url})));
        add(t('완료'), {action: 'accept'}, 'primary-button');
      } else {
        const read = elicitationForm(req.params.requestedSchema || {}, $('request-fields'));
        add(t('전송'), () => ({action: 'accept', content: read()}), 'primary-button');
      }
    } else {
      const field = node('textarea'); field.setAttribute('aria-label', t('프로토콜 응답 JSON')); field.value = '{}'; $('request-fields').append(node('p', t('확장 프로토콜 요청입니다. 응답 JSON을 입력할 수 있습니다.'), 'muted'), field);
      $('request-actions').append(button(t('작업 중지'), async () => { await call('chat.stop'); requestQueue.delete(key); displayedRequest = null; close('request-dialog'); nextRequest(); })); add(t('응답 전송'), () => JSON.parse(field.value), 'primary-button');
    }
    show('request-dialog');
  }
  reportsUi = window.MobileCodexReports?.({document, call, t, show, close});
  window.mobileCodexEvent = (name, data) => {
    if (name === 'github.changed') { state.github = data.github; githubUi?.render(data); return; }
    if (name === 'reports.available') { reportsUi?.available(data); return; }
    if (name.startsWith('agents.')) { agentUi?.event(name, data); return; }
    if (name === 'response') { const p = pending.get(data.id); if (p) { clearTimeout(p.timer); pending.delete(data.id); data.error ? p.reject(new Error(data.error)) : p.resolve(data.result || {}); } return; }
    if (name === 'state') render(data);
    else if (name === 'turn.progress' && state.busy && data.threadId === state.threadId && data.progress?.turnId === state.turnId) {
      state.turnProgress = data.progress; drawTurnProgress();
    }
    else if (name === 'error') { if (!data.threadId || data.threadId === state.threadId) toast(data.message); }
    else if (name === 'notice') toast(data.message);
    else if (name === 'message.delta') {
      if ((data.threadId && data.threadId !== state.threadId) || typeof data.delta !== 'string') return;
      showTaskActivity(C.taskActivity(name, data), data);
      let message = messageLookup.get(data.id);
      if (message) message.text += data.delta;
      else message = C.appendDelta(state.messages, data.id, data.delta);
      if (!following && !unreadAssistantOutput && message.role === 'assistant' && !message.kind && data.delta.trim()) {
        unreadAssistantOutput = true;
        updateJumpLatest();
      }
      scheduleMessageDraw(data.id);
    }
    else if (name === 'tool' || name === 'agent.event') { if (data.threadId && data.threadId !== state.threadId) return; showTaskActivity(C.taskActivity(name, data), data); }
    else if (name === 'files.changed' && (!data.threadId || data.threadId === state.threadId) && !$('file-panel').hidden) listFiles().catch(e => toast(e.message));
    else if (name === 'updates.changed') drawUpdates(data);
    else if (name === 'linux.changed') { state.linux = linuxStatus(data); linuxStatusError = ''; renderDevtools(); renderLinux(); }
    else if (name === 'voice.state') drawDictation(data);
    else if (name === 'voice.changed') recoverVoiceInput();
    else if (name === 'attachments.picked') acceptPickedAttachments(data, data.draftKey || '');
    else if (name === 'terminal.state') renderTerminal(data);
    else if (name === 'terminal.inputError' && data.id === terminalState.id && data.revision > terminalState.revision && terminalState.running && !terminalState.stopping) {
      terminalState.revision = data.revision;
      terminalState.inputError = data.reason;
      terminalControls();
    }
    else if (name === 'terminal.output' && data.id === terminalState.id && data.revision > terminalState.revision) {
      terminalState.revision = data.revision;
      $('terminal-output').textContent = ($('terminal-output').textContent + data.text).slice(-1000000);
      $('terminal-output').scrollTop = $('terminal-output').scrollHeight;
    }
    else if (name === 'server.request') { requestQueue.set(data.key, data); showTaskActivity(C.taskActivity(name, data), data); nextRequest(); }
    else if (name === 'server.resolved') { requestQueue.delete(data.key); resolveTaskActivity(data.key); if (displayedRequest === data.key) { displayedRequest = null; close('request-dialog'); } nextRequest(); }
    else if (name === 'viewport') { document.body.classList.toggle('keyboard-open', !!data.keyboardVisible); viewportChanged(); }
    else if (name === 'theme') document.documentElement.dataset.theme = data.theme === 'dark' ? 'dark' : 'light';
    else if (name === 'notification.open') { if (data.threadId) openChat(data.threadId); else nextRequest(); }
    else if (name === 'widget.open') openProviderSettings();
    else if (name === 'notifications.changed') { window.refreshNotificationSettings?.(); }
    else if (name === 'back') window.mobileCodexBack();
  };
  reportsUi?.refresh();
  window.mobileCodexBack = () => {
    const roomDialog = document.querySelector('.room-dialog[open]');
    if (roomDialog) { roomDialog.close(); return true; }
    if (closeComposerAddMenu()) return true;
    if (dictationState.phase !== 'idle') { call('voice.cancel').catch(error => toast(error.message)); return true; }
    const id = dialogs.at(-1);
    if (id) { dismiss(id); return true; }
    if (closeSessionCard(true)) return true;
    if (closeProjectCard(true)) return true;
    if (document.body.classList.contains('sidebar-open')) { sidebar(false); return true; }
    if (!$('file-panel').hidden) { setFilePanelOpen(false); return true; }
    saveDraft(); return false;
  };
  document.querySelectorAll('dialog').forEach(d => {
    let backdropPointer = null;
    const onBackdrop = e => {
      if (e.target !== d || dialogs.at(-1) !== d.id) return false;
      const rect = d.getBoundingClientRect();
      return e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom;
    };
    d.addEventListener('pointerdown', e => {
      backdropPointer = e.isPrimary !== false && e.button === 0 && onBackdrop(e) ? e.pointerId : null;
    });
    d.addEventListener('pointerup', e => {
      const outside = backdropPointer === e.pointerId && onBackdrop(e);
      backdropPointer = null;
      if (outside) dismiss(d.id);
    });
    d.addEventListener('pointercancel', () => { backdropPointer = null; });
    d.addEventListener('close', () => {
      backdropPointer = null;
      const i = dialogs.indexOf(d.id); if (i !== -1) dialogs.splice(i, 1);
    });
    d.addEventListener('cancel', e => { e.preventDefault(); dismiss(d.id); });
  });
  wireSheetGestures();
  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => dismiss(b.dataset.close)));
  document.addEventListener('click', event => {
    if (!event.target.closest('#project-actions,#project-remove-card,.project-more')) closeProjectCard();
    if (sessionCard && !event.target.closest('.session-card, .session-more')) closeSessionCard();
  }, true);
  document.querySelectorAll('.sidebar-toggle').forEach(b => b.addEventListener('click', () => { if (matchMedia('(max-width:760px)').matches) sidebar(!document.body.classList.contains('sidebar-open')); else document.body.classList.toggle('sidebar-collapsed'); }));
  document.querySelectorAll('[data-prompt]').forEach(b => b.addEventListener('click', () => { $('prompt').value = b.dataset.prompt; saveDraft(); sizeComposer(); $('prompt').focus(); }));
  for (const [buttonId, listId] of [['toggle-projects','projects'], ['toggle-history','sessions']]) {
    const button = $(buttonId), list = $(listId);
    const key = 'sidebar-section-' + listId;
    const apply = expanded => {
      button.setAttribute('aria-expanded', String(expanded));
      button.setAttribute('aria-label', (listId === 'projects' ? '项目 ' : '普通对话 ') + (expanded ? '收起' : '展开'));
      list.hidden = !expanded;
    };
    apply(localStorage.getItem(key) !== 'collapsed');
    on(buttonId, () => { const expanded = button.getAttribute('aria-expanded') !== 'true'; apply(expanded); localStorage.setItem(key, expanded ? 'expanded' : 'collapsed'); });
  }
  on('scrim', () => sidebar(false)); on('new-chat', async () => newChat(''));
  on('conversation-failure-copy', () => copyText($('conversation-failure-message').textContent, $('conversation-failure-copy'), '复制说明', '已复制'));
  on('conversation-failure-new', () => newChat(state.workspace?.key || ''));
  on('add-project', addProject);
  ['choose-folder', 'header-project'].forEach(id => on(id, () => pickFolder()));
  $('project-link-dialog').addEventListener('close', () => {
    if ($('project-link-dialog').open) return;
    const key = projectLinkView?.returnKey;
    projectLinkView = null;
    if (document.querySelector('dialog[open]')) return;
    const trigger = key ? [...document.querySelectorAll('[data-project-menu-key]')].find(b => b.dataset.projectMenuKey === key) : $('add-project');
    if (matchMedia('(max-width:760px)').matches && !document.body.classList.contains('sidebar-open')) sidebar(true);
    trigger?.focus({preventScroll:true});
  });
   const closeToolMenu = () => { if ($('tool-menu-dialog').open) close('tool-menu-dialog'); };
   setFilePanelOpen(false);
   ['files-toggle'].forEach(id => on(id, async () => { closeToolMenu(); setFilePanelOpen($('file-panel').hidden); sidebar(false); if (!$('file-panel').hidden) await listFiles(); }));
  on('file-close', () => setFilePanelOpen(false)); on('file-up', async () => { folder = C.parent(folder); await listFiles(); });
  on('file-query', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => listFiles($('file-query').value.trim()).catch(e => toast(e.message)), 300); }, 'input');
  ['file-new', 'folder-new'].forEach(id => on(id, async () => { const context = fileContext(), destination = folder; const name = await fileInput(context, id === 'file-new' ? t('새 파일') : t('새 폴더'), t('이름을 입력하세요.')); if (name) await mutate(id === 'file-new' ? 'mobile_create' : 'mobile_mkdir', {path:C.join(destination, name), content:''}, context); }));
  on('show-changes', () => { closeToolMenu(); return loadChanges(); }); on('changes-refresh', () => loadChanges()); on('changes-history', () => loadChanges(true)); on('change-restore', restoreChange);
  on('editor-save', saveEditor);
  on('editor-delete', async () => { const file = currentEditor(); await mutate('mobile_delete', {path:file.path}, file.context); if (openedFile === file) { fileDrafts.delete(fileDraftKey(file.context, file.path)); openedFile = null; close('editor-dialog'); } });
  on('editor-rename', () => relocateEditor('mobile_rename'));
  on('editor-move', () => relocateEditor('mobile_move'));
  on('input-confirm', () => { const r = inputResolve; inputResolve = null; const value = $('input-value').value; close('input-dialog'); if (r) r(value); });
  $('input-dialog').addEventListener('close', () => { if (inputResolve) { const r = inputResolve; inputResolve = null; r(null); } });
  on('input-value', e => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) $('input-confirm').click(); }, 'keydown');
  on('composer', async () => {
    if (chatSelection || providerSwitchPending) return;
    if (!configuredApi()) {
      if (state.apiCanRebind) { $('header-api').click(); toast('请为此聊天重新绑定 API。'); }
      else { openProviderSettings(); toast('请先配置 API 服务商。'); }
      return;
    }
    if (state.workspace?.selected && state.workspace.available === false) { toast(t('먼저 로컬 폴더를 연결해 주세요.')); return; }
    const value = $('prompt').value, text = value.trim();
    if ((!text && !draftContext.attachments.length) || sending || voiceStarting || voiceActive) return;
    if (!state.models.some(m => (m.model || m.id) === $('model').value)) { toast(t('모델 목록을 새로고침해 주세요.')); return; }
    const chosenModel = state.models.find(m => (m.model || m.id) === $('model').value);
    if (!window.MobileCodexReasoning.validSelection($('effort').value, chosenModel, !!state.apiActive)) {
      toast('当前模型不支持所选思考强度，已阻止发送。请重新选择思考档位。'); return;
    }
    const steer = !!state.busy && !!state.turnId, expectedTurnId = state.turnId || '', expectedThreadId = state.threadId || '', workspaceKey = state.workspace?.key || '';
    const submitted = {value, context:JSON.parse(JSON.stringify(draftContext)), provider:draftProvider, scopes:new Set([draftScope])}; sending = submitted;
    closeComposerAddMenu(false);
    saveDraft(); updateSend(); scrollLatest();
    try {
      await call(steer ? 'chat.steer' : 'chat.send', {text, expectedTurnId, expectedThreadId, expectedApiScope:state.apiScope, workspaceKey, model:$('model').value, effort:$('effort').value,

        attachments:submitted.context.attachments.map(x => x.id), skills:submitted.context.skills, mentions:submitted.context.mentions});
      // Keep text typed during the request, or drafts from a different conversation.
      if (submitted.scopes.has(draftScope) && $('prompt').value === value) {
        $('prompt').value = '';
        for (const type of ['attachments','mentions','skills']) {
          const sentIds = new Set(submitted.context[type].map(x => x.id || x.path));
          draftContext[type] = draftContext[type].filter(x => !sentIds.has(x.id || x.path));
        }
        renderDraftContext();
      }
      for (const scope of submitted.scopes) {
        try {
          if (localStorage.getItem(scope) === value) localStorage.removeItem(scope);
          const submittedContext = {attachments:submitted.context.attachments, mentions:submitted.context.mentions, skills:submitted.context.skills};
          if (localStorage.getItem(contextScope(scope)) === JSON.stringify(submittedContext)) localStorage.removeItem(contextScope(scope));
        } catch {}
      }
      saveDraft();
    } finally { sending = null; sizeComposer(); }
  }, 'submit');
  // Physical keyboards: Ctrl/Cmd+Enter sends, Enter remains useful on touch keyboards.
  $('prompt').addEventListener('keydown', e => {
    if (!e.isComposing && e.keyCode !== 229 && !$('autocomplete').hidden && ['ArrowDown','ArrowUp','Enter','Escape'].includes(e.key)) {
      e.preventDefault();
      if (e.key === 'Escape') hideAutocomplete();
      else if (e.key === 'Enter') { const item = autocomplete.items[autocomplete.index]; if (item) Promise.resolve(chooseAutocomplete(item)).catch(error => toast(error.message)); }
      else if (autocomplete.items.length) { autocomplete.index = (autocomplete.index + (e.key === 'ArrowDown' ? 1 : -1) + autocomplete.items.length) % autocomplete.items.length; updateAutocompleteActive(); }
      return;
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); $('composer').requestSubmit(); }
  });
  let autocompleteTimer; $('prompt').addEventListener('input', () => { saveDraft(); sizeComposer(); clearTimeout(autocompleteTimer); hideAutocomplete(); if (/[@$]$/.test($('prompt').value.slice(0, $('prompt').selectionStart))) queryAutocomplete(); else autocompleteTimer = setTimeout(queryAutocomplete, 120); });
  $('prompt').addEventListener('focus', () => { if (following) frame(followLatest); });
  $('composer').addEventListener('click', e => { if (e.target === $('composer')) $('prompt').focus(); });
  $('prompt').addEventListener('click', () => queryAutocomplete());
  const chatScroll = $('chat-scroll');
  on('history-load', () => { pauseFollowing(); return loadEarlierMessages(true); });
  function loadHistoryFromScroll() {
    if (chatTouch?.requestedHistory) return;
    if (chatTouch) chatTouch.requestedHistory = true;
    loadEarlierMessages();
  }
  chatScroll.addEventListener('touchstart', event => {
    if (event.touches.length !== 1) return;
    chatTouch?.cancel();
    const target = event.target;
    const {identifier, clientY} = event.touches[0];
    const gesture = {clientY, towardHistory:false, requestedHistory:false, cancel};
    function move(touchEvent) {
      if (touchEvent.touches.length !== 1 || touchEvent.touches[0].identifier !== identifier) return;
      const currentY = touchEvent.touches[0].clientY, distance = currentY - gesture.clientY;
      if (Math.abs(distance) <= 6) return;
      gesture.clientY = currentY; gesture.towardHistory = distance > 0;
      if (!gesture.towardHistory) return;
      pauseFollowing();
      if (chatScroll.scrollTop <= 0) loadHistoryFromScroll();
    }
    function cancel() {
      target.removeEventListener('touchmove', move);
      target.removeEventListener('touchend', end);
      target.removeEventListener('touchcancel', end);
      chatTouch = null;
    }
    function end(touchEvent) {
      if (Array.from(touchEvent.touches).some(touch => touch.identifier === identifier)) return;
      cancel(); followLatest();
    }
    chatTouch = gesture;
    target.addEventListener('touchmove', move, {passive:true});
    target.addEventListener('touchend', end, {passive:true});
    target.addEventListener('touchcancel', end, {passive:true});
  }, {passive:true});
  chatScroll.addEventListener('scroll', () => {
    const top = chatScroll.scrollTop, previous = historyView.top;
    historyView.top = top;
    if (top !== previous) following = top > previous && !chatTouch?.towardHistory && chatScroll.scrollHeight - top - chatScroll.clientHeight <= 2;
    updateJumpLatest();
    if (top < previous && top <= 160) loadHistoryFromScroll();
  }, {passive:true});
  chatScroll.addEventListener('wheel', event => {
    if (event.deltaY >= 0) return;
    pauseFollowing();
    if (chatScroll.scrollTop <= 160) loadEarlierMessages();
  }, {passive:true});
  on('voice-input', () => { closeComposerAddMenu(false); return startVoiceInput(); });
  on('dictation-done', () => call('voice.stop'));
  on('dictation-cancel', () => call('voice.cancel'));
  function openModelPicker(showModels = false) {
    optionsSummary(); showModelPanel(showModels, false); show('model-picker');
    $('composer-options').setAttribute('aria-expanded', 'true');
    updateComposerExpansion(); sizeModelPicker();
    (showModels && !$('picker-provider').disabled ? $('picker-provider') : $('model-picker-model')).focus({preventScroll:true});
    refreshPickerModels();
  }
  on('jump-latest', scrollLatest); on('composer-options', () => openModelPicker());
  on('model-picker-model', () => { showModelPanel(true); refreshPickerModels(); });
  on('header-api', () => {
    if (!(state.apiProviders || []).some(profile => profile.hasKey)) { openProviderSettings(); return; }
    openModelPicker(true);
  });
  on('model-picker-back', () => showModelPanel(false));
  on('picker-provider', async () => {
    const id = $('picker-provider').value;
    const rebind = state.apiCanRebind === true;
    if (!id || (!rebind && (id === state.apiActive || state.threadId)) || state.busy || sending || providerSwitchPending) return;
    const expectedThreadId = state.threadId || '', expectedApiScope = state.apiScope, workspaceKey = state.workspace?.key || '';
    if (rebind) {
      const name = (state.apiProviders || []).find(profile => profile.id === id)?.name || id;
      if (!confirm(`将此聊天重新绑定到「${name}」？本地消息和项目会保留。新模型会从下一条消息开始建立上下文。`)) {
        renderModelList(); return;
      }
    }
    providerSwitchPending = true; saveDraft(); renderModelList(); updateSend();
    try {
      render(await call(rebind ? 'chat.provider.rebind' : 'chat.provider', {id, expectedThreadId, expectedApiScope, workspaceKey}));
      if (rebind) toast('已重新绑定 API。');
    }
    finally { providerSwitchPending = false; renderModelList(); updateSend(); }
  }, 'change');
  on('model-picker-permissions', () => { close('model-picker'); show('options-dialog'); });
  function selectSliderEffort() {
    const option = [...$('effort').options].filter(option => option.value)[Number($('effort-slider').value)];
    if (option && $('effort').value !== option.value) {
      $('effort').value = option.value; saveOptions(); optionsSummary();
    }
  }
  $('effort-slider').addEventListener('input', selectSliderEffort);
  $('effort-slider').addEventListener('change', selectSliderEffort);
  $('model-picker').addEventListener('close', () => { $('composer-options').setAttribute('aria-expanded', 'false'); updateComposerExpansion(); });
  if (window.ResizeObserver) {
    const pickerObserver = new ResizeObserver(sizeModelPicker);
    ['reasoning-panel', 'model-panel', 'composer'].forEach(id => pickerObserver.observe($(id)));
  }
  on('image-save', () => openedImage && call('images.export', {id:openedImage.id, name:openedImage.name}));
  on('image-zoom', () => { const zoomed = $('image-stage').classList.toggle('zoomed'); $('image-zoom').setAttribute('aria-pressed', String(zoomed)); });
  on('image-prev', () => changeImage(-1)); on('image-next', () => changeImage(1));
  let imageTouch = null;
  $('image-stage').addEventListener('touchstart', e => { imageTouch = e.touches.length === 1 ? {x:e.touches[0].clientX,y:e.touches[0].clientY,time:Date.now()} : null; }, {passive:true});
  $('image-stage').addEventListener('touchend', e => {
    if (imageTouch && !$('image-stage').classList.contains('zoomed') && e.changedTouches.length === 1) {
      const dx = e.changedTouches[0].clientX - imageTouch.x, dy = e.changedTouches[0].clientY - imageTouch.y;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5 && Date.now() - imageTouch.time < 800) changeImage(dx < 0 ? 1 : -1);
    }
    imageTouch = null;
  }, {passive:true});
  $('image-stage').addEventListener('touchcancel', () => imageTouch = null, {passive:true});
  $('chat-scroll').addEventListener('click', event => {
    const summary = event.target.closest('.task-activity-row > summary');
    if (!summary || event.defaultPrevented) return;
    event.preventDefault();
    toggleInPlace(summary, () => { summary.parentElement.open = !summary.parentElement.open; });
  });
  on('activity-details', () => {
    if (!state.liveTaskActivity) { show('activity-dialog'); return; }
    const latest = $('task-activities').lastElementChild;
    if (latest) {
      toggleInPlace(latest, () => { latest.open = !latest.open; });
    }
  });
  on('stop', () => call('chat.stop')); on('model', () => { efforts(); syncPermissionControls(state.permissions, !!state.busy); syncApprovalControl(!!state.busy); saveOptions(); updateSend(); renderModelList(); }, 'change'); on('effort', () => { optionsSummary(); saveOptions(); }, 'change');
  $('add-attachment').addEventListener('click', () => { if (!closeComposerAddMenu()) openComposerAddMenu(); });
  // Focusing the compact plus before pointerup moves it to the expanded row.
  // Keep its target still until the click opens and focuses the menu.
  $('add-attachment').addEventListener('pointerdown', e => { if (e.button === 0) e.preventDefault(); });
  on('composer-attach', () => { closeComposerAddMenu(false); return chooseAttachment(); });
  $('add-attachment').addEventListener('keydown', e => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); openComposerAddMenu(e.key === 'ArrowUp'); } });
  $('composer-add-menu').addEventListener('keydown', e => {
    const choices = [...$('composer-add-menu').querySelectorAll('button:not(:disabled)')], current = choices.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeComposerAddMenu(); }
    else if (e.key === 'Tab') closeComposerAddMenu(false);
    else if (['ArrowDown','ArrowUp','Home','End'].includes(e.key)) { e.preventDefault(); const index = e.key === 'Home' ? 0 : e.key === 'End' ? choices.length - 1 : (current + (e.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length; choices[index]?.focus(); }
    else if ((e.key === 'Enter' || e.key === ' ') && choices.includes(e.target)) { e.preventDefault(); e.target.click(); }
  });
  document.addEventListener('pointerdown', e => { if (!e.target.closest('.composer-add-wrap')) closeComposerAddMenu(false); });
  document.addEventListener('focusin', e => { if (!e.target.closest('.composer-add-wrap')) closeComposerAddMenu(false); });
  on('permissions', () => setPermissionMode($('permissions').value), 'change');
  on('approval-mode', () => setApprovalMode($('approval-mode').value), 'change');
  document.querySelectorAll('input[name="permission"]').forEach(r => r.addEventListener('change', () => setPermissionMode(r.value).catch(error => toast(error.message))));
  ensureNotificationSettings();
  apiProvidersUi?.init({call, refresh:()=>call('state').then(render), toast});
  githubUi?.init({call, refresh:()=>call('github.status').then(value => { state.github = value.github; githubUi?.render(value); }), toast});
  if ($('api-effort-choice')) on('api-effort-choice', () => {
    const value = $('api-effort-choice').value;
    if (![...$('effort').options].some(o => o.value === value)) {
      toast('该档位不可用，请重新选择。'); return;
    }
    $('effort').value = value;
    $('effort').dispatchEvent(new Event('change', {bubbles:true}));
  }, 'change');
/* Native Codex subagent configuration. Availability requires runtime verification. */
  function cnSectionEntries(content,section) {
    const lines=String(content||'').replace(/\r\n/g,'\n').split('\n');
    let inside=false;const obj={};
    for (const line of lines) {
      const hdr=line.match(/^\s*\[([^\]\n]+)\]\s*(?:#.*)?$/);
      if (hdr) {inside=hdr[1].trim()===section;continue;}
      if (!inside)continue;
      const m=line.match(/^\s*([A-Za-z_][A-Za-z_0-9]*)\s*=\s*([^#\n]*?)(?:\s+#.*)?$/);
      if (m)obj[m[1]]=m[2].trim();
    }
    return obj;
  }
  function cnSetTomlSection(content,section,entries) {
    const lines=String(content||'').replace(/\r\n/g,'\n').split('\n');
    const table=/^\s*\[\[?([^\]\n]+)\]\]?\s*(?:#.*)?$/;
    let start=-1,end=lines.length;
    for(let i=0;i<lines.length;i++){
      const m=lines[i].match(table);
      if(m && start>=0){end=i;break;}
      if(m && m[1].trim()===section && start<0)start=i;
    }
    if(start<0){
      let out=lines.join('\n').replace(/\s*$/,'');
      out+='\n\n['+section+']\n'+Object.entries(entries).filter(([,value])=>value!==null).map(([key,value])=>key+' = '+value).join('\n')+'\n';
      return out;
    }
    for(const [key,value] of Object.entries(entries)){
      const re=new RegExp('^\\s*'+key+'\\s*=');
      const hits=[];
      for(let i=start+1;i<end;i++)if(re.test(lines[i]))hits.push(i);
      if(value===null){ for(const index of hits.reverse()){lines.splice(index,1);end--;} continue; }
      if(hits.length>1)throw new Error('已有重复配置键：['+section+'] '+key+'。请先在配置编辑器处理。');
      if(hits.length)lines[hits[0]]=key+' = '+value;
      else {lines.splice(end,0,key+' = '+value);end++;}
    }
    return lines.join('\n');
  }
  let subagentBusy=false;
  function subagentPrerequisite() {
    if (!configuredApi()) return '请先配置并选择 API 服务商。';
    if (!state.ready) return L.brand('请先启动 Codex 运行时。');
    if (state.busy) return '当前任务结束后可更改配置。';
    const model = state.models.find(model => (model.model || model.id) === $('model').value);
    if (!model) return '请先选择可用模型。';
    if (state.subagentsAvailable === false || model.supportsToolCalls === false || model.supportsTools === false) return '当前运行时或模型未提供子智能体所需的工具调用。';
    return '';
  }
  function syncSubagentControls() {
    const reason = subagentPrerequisite(), blocked = subagentBusy || !!reason;
    $('subagents-save').disabled = blocked; $('subagents-test').disabled = blocked;
    $('subagents-enabled').disabled = subagentBusy || !!state.busy;
    $('subagents-limit').disabled = subagentBusy || !!state.busy;
    $('subagents-save').title = reason; $('subagents-test').title = reason;
  }

  function cnReadAgentPrefs(content) {
    const feats=cnSectionEntries(content,'features'),agents=cnSectionEntries(content,'agents');
    const active=feats.multi_agent==='true'||feats.multi_agent_v2==='true';
    const n=Number(agents.max_threads||agents.max_concurrent_threads_per_session||3);
    return {active:active&&agents.enabled!=='false',limit:[1,2,3,4].includes(n)?n:3};
  }
  async function cnLoadSubagents() {
    const el=$('subagents-status');
    el.textContent=L.brand('正在读取 Codex 本地配置…');
    try{
      const cfg=await call('config.read');
      const prefs=cnReadAgentPrefs(cfg?.content||'');
      $('subagents-enabled').checked=prefs.active;
      $('subagents-limit').value=String(prefs.limit);
      el.textContent=prefs.active?'配置中已启用多智能体；能否成功派遣仍需实际测试。':'当前未在配置中启用多智能体。';
    }catch(error){el.textContent='读取失败：'+errorText(error);}
  }
  async function cnSaveSubagents() {
    const reason = subagentPrerequisite();
    if (reason) { $('subagents-status').textContent = reason; return; }
    if(subagentBusy)return;
    subagentBusy=true; syncSubagentControls();
    const save=$('subagents-save'),status=$('subagents-status');
    save.disabled=true;status.textContent='正在保存本地配置…';
    try{
      const read=await call('config.read');
      if(typeof read?.content!=='string')throw new Error('未能读取完整 config.toml，已中止保存。');
      const enabled=$('subagents-enabled').checked;
      const limit=Number($('subagents-limit').value);
      if(![1,2,3,4].includes(limit))throw new Error('并行数无效');
      let content=cnSetTomlSection(read.content,'features',{multi_agent:String(enabled)});
      if(!enabled)content=cnSetTomlSection(content,'features',{multi_agent_v2:'false'});
      content=cnSetTomlSection(content,'agents',{enabled:String(enabled),max_concurrent_threads_per_session:null,max_threads:String(limit)});
      if(content===read.content){status.textContent='设置没有变化；仍需实际发送任务验证。';return;}
      await call('config.save',{content});
      status.textContent=L.brand('配置已保存，正在重新连接 Codex…');
      await call('runtime.start');
      const check=await call('config.read');
      const actual=cnReadAgentPrefs(check?.content||'');
      if(actual.active!==enabled||actual.limit!==limit)throw new Error('保存后复查结果不一致');
      status.textContent=enabled?'已启用多智能体配置（最多 '+limit+' 个）。请使用测试任务验证 spawn_agent 是否可调用。':'已停用多智能体配置。';
    }catch(error){status.textContent='未确认启用成功：'+errorText(error)+ L.brand('。可在「Codex 设置编辑」中检查。');}
    finally{subagentBusy=false;syncSubagentControls();}
  }
  on('subagents-refresh',cnLoadSubagents);
  on('subagents-save',cnSaveSubagents);
  on('subagents-test',()=>{
    const reason = subagentPrerequisite(); if (reason) { $('subagents-status').textContent = reason; return; }
    const task=L.brand('请使用 Codex 原生 spawn_agent 派遣两个子智能体：一个检查当前项目的代码结构，一个只读检查潜在问题。等待它们完成并汇总结果。请报告是否真正调用了 spawn_agent；如果不可用，明确说明，不要假装创建了子智能体。');
    $('prompt').value=task;saveDraft();sizeComposer();close('settings-dialog');$('prompt').focus();
    toast('测试提示词已填入，确认后手动点击发送。');
  });

  on('restart', async () => { await call('runtime.stop'); await call('runtime.start'); });
  on('engine-stop', () => call('runtime.stop'));
  on('battery-settings', () => call('ui.batterySettings'));
  selectSettingsTab('general');
  on('configure-api', openProviderSettings); on('settings', () => { ensureNotificationSettings(); show('settings-dialog'); sidebar(false); });
  document.querySelectorAll('[data-settings-tab]').forEach(tab => tab.addEventListener('click', () => {
    const selected = tab.dataset.settingsTab; selectSettingsTab(selected);
    if (selected === 'personal' && !instructionsLoaded) loadInstructions();
    if (selected === 'tools') refreshLinuxStatus();
    if (selected === 'updates') loadUpdates();
    if (selected === 'advanced') cnLoadSubagents();
  }));
  ['check','download','cancel','clear','permission','install'].forEach(action => on('update-' + action, () => updateAction(action)));
  $('update-repository').addEventListener('input', () => { updateSourceDirty = true; drawUpdates(updateState); });
  $('update-prereleases').addEventListener('change', () => { updateSourceDirty = true; drawUpdates(updateState); });
  ensureTextSizeSettings();
  setupReplyIndentSetting();
  setupInterfaceStyle();
  $('language').value = L.choice();
  on('language', async () => {
    const choice = $('language').value;
    try { await call('ui.locale', {language:choice}); } catch (error) { $('language').value = L.choice(); throw error; }
    saveDraft(); saveOptions(); L.set(choice);
    agentUi?.localize();
    const sizeRow = $('text-size').closest('.text-size-row');
    sizeRow.querySelector('strong').textContent = t('글자 크기');
    sizeRow.querySelector('small').textContent = t('폰과 태블릿의 앱 화면에 적용됩니다.');
    $('text-size').setAttribute('aria-label', t('글자 크기')); $('text-size').options[0].textContent = t('기본 · 100%');
    updateReplyIndentLabels();
    modelKey = ''; render(await call('state')); renderDraftContext(); drawDictation(dictationState); await loadUpdates();
    if (!$('file-panel').hidden) await listFiles();
    if ($('tools-dialog').open) await loadTools(false);
  }, 'change');
  on('instructions-reload', loadInstructions); on('instructions-save', saveInstructions);
  $('settings-dialog').addEventListener('cancel', event => { event.preventDefault(); dismiss('settings-dialog'); });
  on('storage-access', () => call('ui.storageAccess')); on('theme', setTheme, 'change');
  on('devtools-check', checkDevtools);
  on('floating-chat', () => call('ui.floatingChat')); on('phone-settings', () => call('ui.phoneSettings')); on('phone-enable', enablePhone);
  on('phone-disable', stopPhone); on('phone-stop-banner', stopPhone);
  ['edit-config', 'tools-config'].forEach(id => on(id, config)); on('config-save', async () => { await call('config.save', {content: $('config-editor').value}); configOriginal = $('config-editor').value; await call('runtime.start'); close('config-dialog'); toast(t('설정을 적용했습니다.')); });
  function terminalControls() {
    const running = terminalState.running, input = $('terminal-command');
    const inputFailed = running && !!terminalState.inputError;
    $('terminal-submit').textContent = t(running ? '입력 전송' : '실행');
    $('terminal-submit').disabled = terminalSending || terminalState.stopping || inputFailed;
    $('terminal-stop').disabled = !running || terminalState.stopping;
    input.disabled = terminalSending || terminalState.stopping || inputFailed;
    input.type = running ? 'password' : 'text';
    input.placeholder = t(running ? '입력 후 전송 · 빈 입력은 Enter' : '명령 입력');
    input.setAttribute('aria-label', t(running ? '프로그램 입력' : '셸 명령'));
    if (inputFailed && !terminalState.stopping) $('terminal-status').textContent = t('터미널에 입력을 보내지 못했습니다.');
  }
  function renderTerminal(value) {
    if (typeof value.revision !== 'number' || value.revision < terminalState.revision) return;
    if (value.id !== terminalState.id || value.running !== terminalState.running) $('terminal-command').value = '';
    terminalState = {...value};
    $('terminal-output').textContent = (value.output || '') + (value.exitCode == null ? '' : t('\n[종료 코드 ') + value.exitCode + ']\n');
    $('terminal-output').scrollTop = $('terminal-output').scrollHeight;
    $('terminal-status').textContent = t(value.stopping ? '중지하는 중…' : value.running ? '실행 중인 프로그램에 입력을 보냅니다.' : '');
    terminalControls();
  }
  on('show-recovery', () => { closeToolMenu(); return recovery(); });
  on('show-terminal', async () => { closeToolMenu(); show('terminal-dialog'); sidebar(false); renderTerminal(await call('terminal.state')); });
  on('terminal-stop', async () => { renderTerminal(await call('terminal.stop', {id:terminalState.id})); });
  on('terminal-form', async e => {
    e.preventDefault();
    if (terminalSending || terminalState.stopping || (terminalState.running && terminalState.inputError)) return;
    const text = $('terminal-command').value, session = {...terminalState};
    if (!session.running && !text.trim()) return;
    terminalSending = true; terminalControls();
    try {
      if (session.running) {
        const result = await call('terminal.input', {id:session.id, text});
        if (terminalState.id !== session.id || !terminalState.running || terminalState.stopping) return;
        if (result.ok === false) {
          if (result.reason === 'input_closed') {
            terminalState.inputError = result.reason;
            if (result.revision > terminalState.revision) terminalState.revision = result.revision;
          }
          throw new Error(t(result.reason === 'input_queue_full' ? '터미널 입력 대기열이 가득 찼습니다. 잠시 후 다시 보내 주세요.' : '터미널에 입력을 보내지 못했습니다.'));
        }
        if (terminalState.inputError) return;
        $('terminal-status').textContent = t('입력을 전송했습니다.');
      } else renderTerminal(await call('terminal.run', {command:text}));
      $('terminal-command').value = '';
    } catch (error) {
      // A stale reply must never be retried as a fresh shell command.
      try { const current = await call('terminal.state'); renderTerminal(current); } catch {}
      if (terminalState.id === session.id && !terminalState.stopping) $('terminal-status').textContent = errorText(error.message);
    } finally { terminalSending = false; terminalControls(); $('terminal-command').focus(); }
  }, 'submit');
  on('show-tools', () => show('tool-menu-dialog')); on('show-tools-panel', () => { closeToolMenu(); return loadTools(false); }); on('refresh-tools', () => loadTools(true));
  on('marketplace-add', async () => { const source = await input(t('마켓플레이스 추가'), t('Git URL 또는 기기의 로컬 경로')); if (source) { const result = await rpc('marketplace/add', {source}); toast(result.marketplaceName + t(' 추가 완료')); await loadTools(); } });
  on('skill-import', async () => { const r = await call('skills.import'); if (!r.cancelled) { toast(t('스킬 폴더를 가져왔습니다.')); await loadTools(); } });
  $('request-dialog').addEventListener('cancel', e => e.preventDefault());
  $('theme').value = appearance.choice;
  syncNativeTheme();
  appearance.systemTheme.addEventListener('change', setTheme);
  window.addEventListener('resize', viewportChanged);
  window.visualViewport?.addEventListener('resize', viewportChanged);
  window.addEventListener('pagehide', saveDraft);
  document.addEventListener('visibilitychange', () => {
    drawTurnProgress();
    if (document.hidden) { chatTouch?.cancel(); saveDraft(); }
    else { followLatest(); recoverVoiceInput(); }
  });
  document.addEventListener('keydown', e => {
    if (dialogs.at(-1) === 'image-dialog' && !$('image-stage').classList.contains('zoomed') && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); changeImage(e.key === 'ArrowRight' ? 1 : -1); }
    if (e.key === 'Escape' && !dialogs.length) window.mobileCodexBack();
    if (e.key !== 'Tab' || !document.body.classList.contains('sidebar-open')) return;
    const controls = [...$('sidebar').querySelectorAll('button:not(:disabled)')], first = controls[0], last = controls.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  viewportChanged();
  call('state').then(async initial => { render(initial); recoverVoiceInput(); loadUpdates(); try { acceptPickedAttachments(await call('attachments.recover'), ''); } catch {} }).catch(e => toast(e.message));
})();
