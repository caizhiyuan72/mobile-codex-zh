const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {JSDOM} = require('jsdom');
const script = fs.readFileSync('app/src/main/assets/web/api-providers.js', 'utf8');
const profile = {id:'provider-1', name:'示例 API', baseUrl:'https://api.example.test/v1', models:['coding-model'], hasKey:true};
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function fixture(t, handler = async () => ({}), state = {apiProviders:[profile], apiActive:profile.id}) {
  const dom = new JSDOM('<!doctype html><dialog id="settings-dialog"><nav class="settings-nav"><button data-settings-tab="advanced">高级</button></nav><div class="settings-content"></div></dialog>', {runScripts:'outside-only', url:'https://appassets.androidplatform.net/'});
  t.after(() => dom.window.close());
  const {window:w} = dom, d = w.document, calls = [], notices = [];
  w.eval(script);
  const ui = w.MobileCodexApiProviders;
  ui.init({call:async (action, args) => { calls.push({action, args:JSON.parse(JSON.stringify(args))}); return handler(action, args); },
    refresh:async () => ui.render(state), toast:message => notices.push(message)});
  ui.render(state);
  const get = id => d.getElementById(id);
  const findButton = text => [...d.querySelectorAll('button')].find(button => button.textContent === text);
  const submit = async () => { get('api-form').dispatchEvent(new w.Event('submit', {bubbles:true, cancelable:true})); await settle(); };
  return {w, d, get, calls, notices, findButton, submit};
}

test('API settings show saved profiles safely and never display a subscription fallback or saved key', t => {
  const x = fixture(t, undefined, {apiProviders:[{...profile, name:'<img src=x onerror=alert(1)>'}], apiActive:profile.id});
  assert.equal(x.d.querySelectorAll('[data-settings-tab="providers"]').length, 1);
  assert.equal(x.d.querySelectorAll('.api-card img').length, 0);
  assert.match(x.d.querySelector('.api-card strong').textContent, /<img/);
  assert.equal(x.get('api-key').value, '');
  assert.doesNotMatch(x.d.body.textContent, /ChatGPT|订阅|Claude|思考强度/);
  x.findButton('编辑').click();
  assert.equal(x.get('api-key').value, '');
  assert.equal(x.get('api-key').required, false);
  assert.match(x.get('api-key-note').textContent, /留空/);
  assert.equal(x.w.localStorage.length, 0);
  x.get('api-url').value = 'https://another.example.test/v1';
  x.get('api-url').dispatchEvent(new x.w.Event('input'));
  assert.equal(x.get('api-key').required, true);
  assert.match(x.get('api-key-note').textContent, /重新填写/);
  x.w.MobileCodexApiProviders.render({apiProviders:[profile], apiActive:profile.id, apiMigrationError:'sk-should-not-be-rendered'});
  assert.equal(x.get('api-migration').hidden, false);
  assert.doesNotMatch(x.get('api-migration').textContent, /sk-/);
});

test('save passes the provider protocol to Android and enables the returned id', async t => {
  const x = fixture(t, async action => action === 'providers.save' ? {id:'saved-provider'} : {});
  x.get('api-name').value = '新服务商'; x.get('api-url').value = 'https://relay.example.test/v1';
  x.get('api-models').value = 'model-a\nmodel-b'; x.get('api-key').value = 'test-credential';
  await x.submit();
  assert.deepEqual(x.calls.map(call => call.action), ['providers.save', 'providers.select']);
  assert.equal(x.calls[0].args.protocol, 'responses');
  assert.equal(x.calls[0].args.apiKey, 'test-credential');
  assert.equal(x.calls[1].args.id, 'saved-provider');
  assert.equal(x.get('api-key').value, '');
  assert.match(x.get('api-status').textContent, /保存并启用/);
  assert.equal(x.get('api-save').disabled, false);
});

test('editing preserves the key by sending an empty value and clearing it when the settings close', async t => {
  const x = fixture(t, async action => action === 'providers.save' ? {id:profile.id} : {});
  x.findButton('编辑').click(); await x.submit();
  assert.equal(x.calls[0].args.id, profile.id); assert.equal(x.calls[0].args.apiKey, '');
  x.get('api-key').value = 'not-yet-saved';
  x.get('settings-dialog').dispatchEvent(new x.w.Event('close'));
  assert.equal(x.get('api-key').value, '');
});

test('a failed runtime activation keeps the saved profile and reports that state accurately', async t => {
  const x = fixture(t, async action => {
    if (action === 'providers.save') return {id:'saved-provider'};
    if (action === 'providers.select') throw new Error('运行时启动失败');
    return {};
  });
  x.get('api-key').value = 'test-credential'; await x.submit();
  assert.match(x.get('api-status').textContent, /已保存，启用失败/);
  assert.equal(x.get('api-key').value, '');
  assert.equal(x.calls.filter(call => call.action === 'providers.remove').length, 0);
});

test('disabling uses an empty API selection, while deleting requires the card action confirmation', async t => {
  const x = fixture(t);
  x.findButton('停用').click(); await settle();
  assert.deepEqual(x.calls[0], {action:'providers.select', args:{id:''}});
  x.w.confirm = () => false; x.findButton('删除').click(); await settle();
  assert.equal(x.calls.length, 1);
  x.w.confirm = () => true; x.findButton('删除').click(); await settle();
  assert.deepEqual(x.calls[1], {action:'providers.remove', args:{id:profile.id}});
});

test('model discovery filters and deduplicates results without treating discovery as inference validation', async t => {
  const x = fixture(t, async action => action === 'providers.discover' ? {models:['model-a','model-b','model-a']} : {});
  x.get('api-url').value = profile.baseUrl; x.get('api-key').value = 'test-credential';
  x.get('api-scan').click(); await settle();
  assert.equal(x.d.querySelectorAll('.api-model-row').length, 2);
  assert.match(x.get('api-status').textContent, /不代表已通过对话和工具调用测试/);
  x.get('api-filter').value = 'model-b'; x.get('api-filter').dispatchEvent(new x.w.Event('input'));
  x.get('api-select-all').click(); x.get('api-add-selected').click();
  assert.equal(x.get('api-models').value, 'model-b');
  x.get('api-url').dispatchEvent(new x.w.Event('input'));
  assert.equal(x.get('api-discovery').hidden, true);
});

test('API errors cannot copy a credential into the status or toast', async t => {
  const x = fixture(t, async () => { throw new Error('Authorization: Bearer sk-test-only'); });
  x.get('api-key').value = 'sk-test-only'; await x.submit();
  assert.doesNotMatch(x.get('api-status').textContent, /sk-test-only|Bearer/);
  assert.ok(x.notices.every(message => !message.includes('sk-test-only')));
  assert.equal(x.get('api-key').value, '');
});
