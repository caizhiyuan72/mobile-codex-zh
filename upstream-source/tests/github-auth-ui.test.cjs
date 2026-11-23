const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');
const script = fs.readFileSync('app/src/main/assets/web/github-auth.js', 'utf8');
const css = fs.readFileSync('app/src/main/assets/web/github-auth.css', 'utf8');
const clientId = 'Ov23liExampleClientID';
const configured = {configured:true, clientId, state:'idle', scopes:[]};
const pending = () => ({...configured, state:'pending', userCode:'ABCD-1234', verificationUri:'https://github.com/login/device', expiresAt:Date.now() + 600000});
const settle = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return {promise, resolve, reject}; };
function fixture(t, initial = {}, handler = async () => ({})) {
  const dom = new JSDOM('<!doctype html><dialog id="settings-dialog" open><nav class="settings-nav"><button data-settings-tab="providers">模型 API</button><button data-settings-tab="advanced">高级</button></nav><div class="settings-content"></div></dialog>', {runScripts:'outside-only', url:'https://appassets.androidplatform.net/'});
  t.after(() => dom.window.close());
  const {window:w} = dom, d = w.document, calls = [], notices = [], storageWrites = [];
  let state = {github:initial}, refreshes = 0;
  w.Storage.prototype.setItem = function(key, value) { storageWrites.push({key, value}); };
  const style = d.createElement('style'); style.textContent = css; d.head.append(style);
  w.eval(script);
  const ui = w.MobileCodexGitHub;
  const options = {call:async (action, args) => {
    calls.push({action, args:args == null ? undefined : JSON.parse(JSON.stringify(args))});
    return handler(action, args, {setState(value) { state = {github:value}; }, ui});
  }, refresh:async () => { refreshes++; ui.render(state); }, toast:value => notices.push(value)};
  ui.init(options); ui.render(state);
  const get = id => d.getElementById(id);
  const input = value => { get('github-client-id').value = value; get('github-client-id').dispatchEvent(new w.Event('input')); };
  const submit = async () => { get('github-config-form').dispatchEvent(new w.Event('submit', {bubbles:true, cancelable:true})); await settle(); };
  const visible = node => !node.hidden && !node.closest('[hidden]');
  // The app chooses the active settings panel; this fixture focuses on its contents.
  get('github-panel').hidden = false;
  return {w, d, ui, options, get, calls, notices, storageWrites, input, submit, visible, refreshes:() => refreshes,
    render(value) { state = {github:value}; ui.render(state); }};
}

test('unconfigured GitHub setup has one primary action, public Client ID instructions and no automatic bridge traffic', async t => {
  const x = fixture(t);
  x.ui.init(x.options);
  assert.equal(x.d.querySelectorAll('[data-settings-tab="github"]').length, 1);
  assert.equal(x.d.querySelectorAll('[data-settings-panel="github"]').length, 1);
  assert.equal(x.d.querySelector('[data-settings-tab="providers"]').nextElementSibling.dataset.settingsTab, 'github');
  assert.equal(x.get('github-app-config').open, true);
  assert.equal(x.get('github-setup-steps').hidden, false);
  assert.equal(x.get('github-main-action').textContent, '保存 Client ID');
  assert.equal(x.get('github-main-action').disabled, true);
  assert.equal(x.get('github-main-action').closest('form').id, 'github-config-form');
  assert.equal([...x.get('github-panel').querySelectorAll('.primary-button')].filter(x.visible).length, 1);
  assert.match(x.get('github-panel').textContent, /自己的 GitHub OAuth App/);
  assert.match(x.get('github-panel').textContent, /启用 Device Flow/);
  assert.match(x.get('github-config-note').textContent, /无需填写 Client Secret/);
  assert.match(x.get('github-panel').textContent, /不能限制到单个仓库，暂不支持私有仓库/);
  assert.match(x.get('github-panel').textContent, /不会自动推送、发布或触发 Actions/);
  assert.equal(x.calls.length, 0);
  x.get('github-open-setup').click(); await settle();
  assert.deepEqual(x.calls, [{action:'github.openSetup', args:undefined}]);
});

test('saving sends only the trimmed public Client ID and keeps login as a separate explicit action', async t => {
  const save = deferred();
  const x = fixture(t, {}, async (action, args, context) => {
    assert.equal(action, 'github.configure'); await save.promise;
    context.setState({...configured, clientId:args.clientId}); return {};
  });
  x.input('  ' + clientId + '  ');
  x.get('github-main-action').click();
  x.get('github-main-action').click();
  await x.submit();
  assert.deepEqual(x.calls, [{action:'github.configure', args:{clientId}}]);
  assert.equal(x.get('github-client-id').disabled, true);
  save.resolve(); await settle();
  assert.equal(x.refreshes(), 1);
  assert.equal(x.get('github-main-action').textContent, '浏览器登录');
  assert.equal(x.get('github-client-id').value, clientId);
  assert.equal(x.get('github-app-config').open, false);
  assert.equal(x.get('github-config-save').hidden, false);
  assert.equal(x.get('github-client-id').disabled, false);
});

test('invalid Client IDs stay local, unsaved edits survive renders and changed configuration must be saved before login', async t => {
  const x = fixture(t, configured);
  x.input('<img src=x onerror=alert(1)>'); await x.submit();
  assert.equal(x.calls.length, 0);
  assert.match(x.get('github-action-status').textContent, /有效的公开 OAuth Client ID/);
  x.input('new-own-client-id'); x.render(configured);
  assert.equal(x.get('github-client-id').value, 'new-own-client-id');
  assert.equal(x.get('github-main-action').disabled, true);
  assert.equal(x.get('github-config-save').disabled, false);
  x.get('github-main-action').click(); await settle();
  assert.equal(x.calls.length, 0);
  assert.equal(x.d.querySelectorAll('#github-panel img').length, 0);
});

test('Client ID validation matches native length and leading character rules before sending configuration', async t => {
  const x = fixture(t);
  for (const value of ['a', 'A123456', 'A'.repeat(129), '_1234567', '.1234567', '-1234567', 'A123 567', 'A12345中文']) {
    x.input(value);
    assert.equal(x.get('github-main-action').disabled, true, value);
    await x.submit();
    assert.equal(x.calls.length, 0, 'invalid Client ID never reaches Android');
  }
  for (const value of ['A1234567', '1._-' + 'a'.repeat(124)]) {
    x.input(value);
    assert.equal(x.get('github-main-action').disabled, false, value);
    await x.submit();
  }
  assert.deepEqual(x.calls.map(call => call.args), [{clientId:'A1234567'}, {clientId:'1._-' + 'a'.repeat(124)}]);
  assert.ok(x.calls.every(call => call.action === 'github.configure'));
});

test('browser login suppresses duplicate clicks and shows only the returned user code after native refresh', async t => {
  const login = deferred();
  const x = fixture(t, configured, async (action, args, context) => {
    if (action === 'github.login') { await login.promise; context.setState(pending()); }
    return {};
  });
  assert.equal(x.get('github-main-action').textContent, '浏览器登录');
  assert.equal(x.get('github-app-config').open, false);
  x.get('github-main-action').click(); x.get('github-main-action').click();
  assert.deepEqual(x.calls.map(call => call.action), ['github.login']);
  assert.equal(x.get('github-main-action').disabled, true);
  assert.equal(x.get('github-cancel').hidden, false);
  assert.equal(x.get('github-user-code').value, '');
  login.resolve(); await settle();
  assert.equal(x.get('github-user-code').value, 'ABCD-1234');
  assert.equal(x.get('github-user-code').readOnly, true);
  assert.equal(x.get('github-pending').hidden, false);
  assert.equal(x.get('github-main-action').textContent, '打开 GitHub 授权页');
  assert.deepEqual(x.calls.map(call => call.action), ['github.login']);
});

test('pending codes select and copy exactly once, while verification navigation goes through the fixed native route', async t => {
  const navigation = deferred(), clipboard = deferred(), copies = [];
  const x = fixture(t, {...pending(), verificationUri:'javascript:alert(1)'}, async action => {
    if (action === 'github.openVerification') await navigation.promise;
    return {};
  });
  Object.defineProperty(x.w.navigator, 'clipboard', {value:{writeText:async text => { copies.push(text); await clipboard.promise; }}});
  x.get('github-user-code').focus();
  assert.equal(x.get('github-user-code').selectionStart, 0);
  assert.equal(x.get('github-user-code').selectionEnd, 9);
  x.get('github-copy-code').click(); x.get('github-copy-code').click();
  assert.deepEqual(copies, ['ABCD-1234']);
  clipboard.resolve(); await settle();
  assert.match(x.get('github-action-status').textContent, /已复制/);
  x.get('github-main-action').click(); x.get('github-main-action').click();
  assert.deepEqual(x.calls, [{action:'github.openVerification', args:undefined}]);
  assert.equal(x.d.querySelectorAll('#github-panel a[href]').length, 0);
  assert.doesNotMatch(x.get('github-panel').textContent, /javascript:/);
  navigation.resolve(); await settle();
  assert.equal(x.get('github-main-action').disabled, false);
});

test('copy failure offers manual selection without claiming the code was copied', async t => {
  const x = fixture(t, pending());
  Object.defineProperty(x.w.navigator, 'clipboard', {value:{writeText:async () => { throw new Error('denied'); }}});
  x.get('github-copy-code').click(); await settle();
  assert.match(x.get('github-action-status').textContent, /长按复制/);
  assert.doesNotMatch(x.get('github-action-status').textContent, /已复制/);
  assert.equal(x.get('github-user-code').selectionEnd, 9);
});

test('cancellation and local disconnect require clicks and clear the displayed authorization state', async t => {
  const x = fixture(t, pending(), async (action, args, context) => {
    if (action === 'github.cancel' || action === 'github.disconnect') context.setState(configured);
    return {};
  });
  assert.equal(x.calls.length, 0);
  x.get('github-cancel').click(); await settle();
  assert.equal(x.get('github-user-code').value, '');
  assert.equal(x.get('github-main-action').textContent, '浏览器登录');
  x.render({...configured, state:'connected', login:'example-user', scopes:['public_repo','workflow']});
  assert.equal(x.get('github-account').textContent, '已连接 @example-user');
  assert.equal(x.get('github-scopes').textContent, '已授权：public_repo · workflow');
  assert.equal(x.get('github-main-action').hidden, true);
  assert.equal(x.get('github-main-action').disabled, true);
  x.get('github-main-action').click(); await settle();
  assert.deepEqual(x.calls.map(call => call.action), ['github.cancel']);
  assert.equal(x.get('github-client-id').disabled, true);
  assert.match(x.get('github-config-note').textContent, /先退出/);
  x.get('github-disconnect').click(); x.get('github-disconnect').click(); await settle();
  assert.deepEqual(x.calls.map(call => call.action), ['github.cancel','github.disconnect']);
  assert.equal(x.get('github-account').textContent, '');
  assert.equal(x.get('github-client-id').value, clientId);
});

test('cancel can interrupt a pending login request and late request failures cannot overwrite the cancelled state', async t => {
  const login = deferred();
  const x = fixture(t, configured, async (action, args, context) => {
    if (action === 'github.login') await login.promise;
    if (action === 'github.cancel') context.setState(configured);
    return {};
  });
  x.get('github-main-action').click();
  assert.equal(x.get('github-cancel').disabled, false);
  x.get('github-cancel').click(); x.get('github-cancel').click(); await settle();
  assert.deepEqual(x.calls.map(call => call.action), ['github.login','github.cancel']);
  login.reject(new Error('secret late failure')); await settle();
  assert.equal(x.get('github-main-action').textContent, '浏览器登录');
  assert.equal(x.get('github-main-action').disabled, false);
  assert.equal(x.get('github-action-status').hidden, true);
  assert.deepEqual(x.notices, []);
  assert.equal(x.refreshes(), 1);
});

test('closing settings hides the user code without cancelling polling, and opening settings restores public state', async t => {
  const x = fixture(t, pending());
  x.get('settings-dialog').removeAttribute('open');
  x.get('settings-dialog').dispatchEvent(new x.w.Event('close'));
  assert.equal(x.get('github-user-code').value, '');
  x.render(pending());
  assert.equal(x.get('github-user-code').value, '');
  assert.equal(x.calls.length, 0);
  x.get('settings-dialog').setAttribute('open', ''); await settle();
  assert.equal(x.get('github-user-code').value, 'ABCD-1234');
  assert.equal(x.calls.length, 0);
});

test('malicious account and error strings render safely, and private credential fields never enter DOM, storage or bridge arguments', async t => {
  const secret = 'ghp_test_private_credential_never_display';
  const deviceCode = 'private_device_credential_never_display';
  const x = fixture(t, {...configured, state:'connected', login:'<img src=x onerror=alert(1)>',
    token:secret, accessToken:secret, deviceCode, scopes:['public_repo','workflow',secret]});
  assert.equal(x.d.querySelectorAll('#github-panel img, #github-panel script').length, 0);
  assert.match(x.get('github-account').textContent, /<img/);
  assert.equal(x.get('github-scopes').textContent, '已授权：public_repo · workflow');
  x.render({...configured, state:'error', error:'<img src=x> Authorization: Bearer ' + secret, token:secret, deviceCode});
  assert.equal(x.get('github-status').textContent, 'GitHub 操作失败，请检查网络或 OAuth 应用配置后重试。');
  assert.doesNotMatch(x.d.body.innerHTML, /ghp_test_private|private_device_credential/);
  assert.equal(x.w.localStorage.length, 0);
  assert.equal(x.w.sessionStorage.length, 0);
  assert.deepEqual(x.storageWrites, []);
  assert.deepEqual(x.calls, []);
});

test('known errors have fixed recovery text and thrown bridge errors never expose their original message', async t => {
  let failures = 0;
  const x = fixture(t, {...configured, state:'error', error:'device_flow_disabled'}, async () => {
    failures++; throw new Error('Authorization: Bearer private-credential <script>bad</script>');
  });
  assert.match(x.get('github-status').textContent, /启用 Device Flow/);
  x.get('github-main-action').click(); await settle();
  assert.equal(x.get('github-main-action').disabled, false);
  assert.match(x.get('github-action-status').textContent, /GitHub 操作失败/);
  assert.doesNotMatch(x.d.body.textContent, /private-credential|<script>/);
  assert.ok(x.notices.every(text => !text.includes('private-credential')));
  x.get('github-main-action').click(); await settle();
  assert.equal(failures, 2);
});

test('only exact native OAuth errors receive actionable fixed text in both snapshots and bridge failures', async t => {
  const errors = [
    ['此 GitHub OAuth App 尚未启用 Device Flow，请先在应用设置中启用。', '请先在你的 GitHub OAuth 应用设置中启用 Device Flow。'],
    ['此 GitHub OAuth App 尚未启用 Device Flow。', '请先在你的 GitHub OAuth 应用设置中启用 Device Flow。'],
    ['现有 GitHub 授权权限过宽，请使用本项目独立注册的 OAuth App 重新授权。', '请为本项目单独创建 GitHub OAuth 应用，保存其 Client ID 后重新授权。'],
    ['GitHub 授权范围不足，需要公共仓库和工作流权限，请重新授权。', '请重新登录，并确认授权公开仓库（public_repo）和工作流（workflow）权限。']
  ];
  for (const [nativeError, expected] of errors) {
    const x = fixture(t, {...configured, state:'error', error:nativeError}, async () => { throw new Error(nativeError); });
    assert.equal(x.get('github-status').textContent, expected);
    x.get('github-main-action').click(); await settle();
    assert.equal(x.get('github-action-status').textContent, expected);
    assert.deepEqual(x.notices, [expected]);
    x.render({...configured, state:'error', error:nativeError + ' private-error-detail'});
    assert.equal(x.get('github-status').textContent, 'GitHub 操作失败，请检查网络或 OAuth 应用配置后重试。');
    assert.doesNotMatch(x.get('github-panel').textContent, /private-error-detail/);
  }
});

test('device code expiry and native access authorization expiry share a renewal prompt and clear stale account details', t => {
  const x = fixture(t, {...configured, state:'connected', login:'signed-in-user', scopes:['public_repo','workflow']});
  x.render({...configured, state:'expired'});
  assert.equal(x.get('github-status').textContent, 'GitHub 授权已过期，请重新登录。');
  assert.equal(x.get('github-account').textContent, '');
  assert.equal(x.get('github-scopes').hidden, true);
  assert.equal(x.get('github-disconnect').hidden, true);
  assert.equal(x.get('github-main-action').textContent, '浏览器登录');
  assert.equal(x.get('github-main-action').disabled, false);
  x.render({...pending(), expiresAt:Date.now() - 1});
  assert.equal(x.get('github-status').textContent, 'GitHub 授权已过期，请重新登录。');
  assert.equal(x.get('github-user-code').value, '');
  assert.equal(x.get('github-pending').hidden, true);
  x.render({...configured, state:'error', error:'expired_token'});
  assert.equal(x.get('github-status').textContent, 'GitHub 授权已过期，请重新登录。');
  assert.deepEqual(x.calls, []);
});

test('expired, denied and malformed states never offer a stale code or unsafe navigation', t => {
  const x = fixture(t, {...pending(), expiresAt:Date.now() - 1});
  assert.equal(x.get('github-user-code').value, '');
  assert.equal(x.get('github-main-action').textContent, '浏览器登录');
  assert.match(x.get('github-status').textContent, /过期/);
  x.render({...configured, state:'denied'});
  assert.match(x.get('github-status').textContent, /拒绝/);
  x.render({...pending(), userCode:'<script>', expiresAt:Infinity});
  assert.equal(x.get('github-user-code').value, '');
  assert.equal(x.get('github-main-action').disabled, true);
  assert.equal(x.get('github-cancel').disabled, false);
  x.render({configured:true, clientId:'<img>', state:'constructor', login:42, userCode:{}, error:'__proto__'});
  assert.equal(x.get('github-client-id').value, '');
  assert.equal(x.get('github-panel').dataset.authState, 'idle');
  assert.equal(x.d.querySelectorAll('#github-panel img, #github-panel script').length, 0);
});

test('all GitHub action buttons retain 44px touch targets and reduced motion disables entry animation', t => {
  const x = fixture(t, pending());
  for (const button of x.get('github-panel').querySelectorAll('button')) {
    assert.equal(x.w.getComputedStyle(button).minHeight, '44px', button.id);
    assert.equal(x.w.getComputedStyle(button).minWidth, '44px', button.id);
  }
  const sheet = x.d.styleSheets[0];
  const reduced = [...sheet.cssRules].find(rule => rule.conditionText === '(prefers-reduced-motion: reduce)');
  assert.ok(reduced, 'reduced motion preference has an explicit override');
  assert.ok([...reduced.cssRules].some(rule => rule.selectorText === '.github-code-card' && rule.style.animation === 'none'));
});

test('the actual index loads GitHub settings with the app bridge, handles live auth events and preserves the coding draft', async t => {
  const web = path.resolve('app/src/main/assets/web');
  const dom = new JSDOM(fs.readFileSync(path.join(web, 'index.html'), 'utf8'), {runScripts:'outside-only', url:'https://appassets.androidplatform.net/index.html'});
  t.after(() => dom.window.close());
  const {window:w} = dom, d = w.document, calls = [], frames = [], errors = [];
  const state = {ready:true, busy:false, permissions:'workspace-write', status:'Connected', threadId:'github-integration', cwd:'/project',
    workspace:{selected:true, key:'project', name:'项目', available:true}, projects:[], sessions:[], messages:[],
    apiActive:'provider', apiProviders:[{id:'provider', name:'API', hasKey:true, models:['coding-model'], baseUrl:'https://api.example/v1'}],
    models:[{id:'coding-model', model:'coding-model', displayName:'coding-model', isDefault:true}],
    github:{configured:false, clientId:'', state:'idle', scopes:[]}};
  w.matchMedia = () => ({matches:false, addEventListener(){}});
  w.requestAnimationFrame = callback => frames.push(callback);
  w.HTMLDialogElement.prototype.showModal = function() { this.setAttribute('open', ''); };
  w.HTMLDialogElement.prototype.close = function() { this.removeAttribute('open'); this.dispatchEvent(new w.Event('close')); };
  w.addEventListener('error', event => errors.push(event.error?.message || event.message));
  w.Native = {locale:() => JSON.stringify({choice:'zh-CN', systemLanguage:'zh-CN'}), postMessage(raw) {
    const message = JSON.parse(raw); calls.push(message);
    queueMicrotask(() => {
      try {
        let result = {};
        if (message.action === 'state') result = state;
        else if (message.action === 'rpc') result = {data:[], marketplaces:[]};
        else if (message.action === 'github.configure') state.github = {...configured, clientId:message.args.clientId};
        else if (message.action === 'github.login') state.github = pending();
        else if (message.action === 'github.cancel' || message.action === 'github.disconnect') state.github = configured;
        if (message.action === 'github.status') result = {github:state.github};
        w.mobileCodexEvent('response', {id:message.id, result});
      } catch (error) { errors.push(error.message); }
    });
  }};
  const sources = [...d.querySelectorAll('script[src]')].map(node => node.getAttribute('src'));
  assert.ok(sources.includes('github-auth.js'));
  assert.ok(d.querySelector('link[href="github-auth.css"]'));
  assert.equal(sources.filter(name => name === 'github-auth.js').length, 1);
  assert.ok(sources.indexOf('github-auth.js') < sources.indexOf('app.js'));
  for (const source of sources) w.eval(fs.readFileSync(path.join(web, source), 'utf8'));
  const tick = async () => {
    await new Promise(resolve => setTimeout(resolve, 10));
    for (let turn = 0; frames.length; turn++) {
      assert.ok(turn < 100, 'animation frames settle');
      for (const callback of frames.splice(0)) callback();
    }
    await settle();
  };
  await tick();
  assert.equal(calls.some(call => call.action.startsWith('github.')), false);
  const prompt = d.getElementById('prompt');
  prompt.value = '保留编程任务草稿'; prompt.dispatchEvent(new w.Event('input')); await tick();
  d.getElementById('settings').click(); d.getElementById('settings-open-advanced').click(); d.querySelector('[data-settings-tab="github"]').click(); await tick();
  assert.equal(d.getElementById('settings-dialog').open, true);
  assert.equal(d.getElementById('github-panel').hidden, false);
  assert.equal(d.querySelector('[data-settings-panel="providers"]').hidden, true);
  d.getElementById('github-client-id').value = clientId;
  d.getElementById('github-client-id').dispatchEvent(new w.Event('input'));
  d.getElementById('github-main-action').click(); await tick();
  assert.deepEqual(calls.filter(call => call.action.startsWith('github.')).map(call => call.action), ['github.configure', 'github.status']);
  assert.equal(d.getElementById('github-main-action').textContent, '浏览器登录');
  d.getElementById('github-main-action').click(); await tick();
  assert.equal(d.getElementById('github-user-code').value, 'ABCD-1234');
  w.mobileCodexEvent('github.changed', {github:{...configured, state:'connected', login:'integration-user', scopes:['public_repo','workflow']}});
  await tick();
  assert.equal(d.getElementById('github-account').textContent, '已连接 @integration-user');
  assert.equal(d.getElementById('github-user-code').value, '');
  assert.equal(prompt.value, '保留编程任务草稿');
  assert.equal(calls.some(call => call.action === 'chat.send'), false);
  assert.deepEqual(errors, []);
});
