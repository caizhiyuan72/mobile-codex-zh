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

test('long provider lists, model IDs and the editor disclose independently on demand', t => {
  const profiles = Array.from({length:9}, (_, index) => ({...profile, id:`profile-${index}`, name:`服务商 ${index}`}));
  profiles[0].models = Array.from({length:75}, (_, index) => `model-${index}`);
  const state = {apiProviders:profiles, apiActive:'profile-8'};
  const x = fixture(t, undefined, state);
  const summaries = () => [...x.d.querySelectorAll('.api-card > summary')];
  const opened = () => x.d.querySelectorAll('.api-card[open]');
  assert.equal(x.get('api-form').hidden, true);
  assert.equal(summaries().length, 3);
  assert.match(summaries()[0].textContent, /服务商 8.*1 个模型.*使用中/);
  assert.equal(opened().length, 0);
  summaries()[0].click(); summaries()[1].click();
  assert.equal(opened().length, 1);
  assert.equal(opened()[0].querySelector('summary'), summaries()[1]);
  x.w.MobileCodexApiProviders.render({...state});
  assert.equal(opened()[0].querySelector('summary'), summaries()[1]);
  const models = opened()[0].querySelector('.api-models');
  assert.equal(models.open, false);
  models.querySelector('summary').click();
  assert.equal(models.open, true);
  assert.equal(models.querySelectorAll('li').length, 75);
  x.get('api-show-more').click(); assert.equal(summaries().length, 9);
  assert.equal(x.get('api-profiles-overflow').querySelectorAll('.api-card').length, 6);
  assert.equal(opened()[0].querySelector('.api-models').open, true);
  x.get('api-show-more').click(); assert.equal(summaries().length, 3);
  opened()[0].querySelectorAll('button')[1].click();
  assert.equal(x.get('api-form').hidden, false);
  assert.equal(x.get('api-name').value, '服务商 0');
  x.get('api-cancel').click(); assert.equal(x.get('api-form').hidden, true);
  x.get('api-new').click(); assert.equal(x.get('api-form').hidden, false);
  assert.equal(x.get('api-name').value, '');
  x.get('api-name').value = '未保存草稿';
  x.get('api-new').click(); assert.equal(x.get('api-form').hidden, true);
  x.get('api-new').click(); assert.equal(x.get('api-form').hidden, false);
  assert.equal(x.get('api-name').value, '未保存草稿');
});

test('save passes the provider protocol to Android without changing the default', async t => {
  const x = fixture(t, async action => action === 'providers.save' ? {id:'saved-provider'} : {});
  x.get('api-name').value = '新服务商'; x.get('api-url').value = 'https://relay.example.test/v1';
  x.get('api-models').value = 'model-a\nmodel-b'; x.get('api-key').value = 'test-credential';
  await x.submit();
  assert.deepEqual(x.calls.map(call => call.action), ['providers.save']);
  assert.equal(x.calls[0].args.protocol, 'responses');
  assert.equal(x.calls[0].args.apiKey, 'test-credential');
  assert.equal(x.get('api-key').value, '');
  assert.match(x.get('api-status').textContent, /已保存.*启用/);
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

test('the first provider is saved and can be explicitly enabled', async t => {
  const state = {apiProviders:[], apiActive:''};
  const x = fixture(t, async action => {
    if (action === 'providers.save') { state.apiProviders = [profile]; return {id:profile.id}; }
    if (action === 'providers.select') state.apiActive = profile.id;
    return {};
  }, state);
  x.get('api-key').value = 'test-credential'; await x.submit();
  assert.equal(state.apiActive, '');
  assert.match(x.get('api-status').textContent, /已保存.*启用/);
  assert.equal(x.get('api-key').value, '');
  x.findButton('启用').click(); await settle();
  assert.equal(state.apiActive, profile.id);
  assert.deepEqual(x.calls.map(call => call.action), ['providers.save', 'providers.select']);
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

test('a 401 from model discovery preserves the form and allows saving and enabling manual models', async t => {
  const message = '未能读取模型列表（HTTP 401）。你仍可以手动填写模型 ID，保存后新建对话测试。';
  const x = fixture(t, async action => {
    if (action === 'providers.discover') throw new Error(message);
    if (action === 'providers.save') return {id:'saved-provider'};
    return {};
  });
  x.get('api-new').click();
  const draft = {'api-name':'新服务商', 'api-url':profile.baseUrl, 'api-key':'test-credential', 'api-models':'manual-model'};
  for (const [id, value] of Object.entries(draft)) x.get(id).value = value;
  assert.match(x.get('api-scan').textContent, /可选/);
  x.get('api-scan').click(); await settle();
  assert.equal(x.get('api-discovery-status').textContent, message);
  assert.equal(x.get('api-discovery-status').parentElement, x.get('api-models').parentElement);
  assert.equal(x.get('api-discovery').hidden, true);
  assert.equal(x.get('api-form').hidden, false);
  for (const [id, value] of Object.entries(draft)) assert.equal(x.get(id).value, value);
  assert.equal(x.get('api-models').disabled, false);
  assert.equal(x.get('api-save').disabled, false);
  assert.deepEqual(x.calls.map(call => call.action), ['providers.discover']);

  x.get('api-models').value += '\nsecond-manual-model';
  x.get('api-save').click(); await settle();
  assert.deepEqual(x.calls.slice(1), [
    {action:'providers.save', args:{id:'', name:draft['api-name'], baseUrl:draft['api-url'],
      models:'manual-model\nsecond-manual-model', apiKey:'test-credential', protocol:'responses'}},
  ]);
  assert.match(x.get('api-status').textContent, /已保存.*启用/);
  assert.equal(x.get('api-discovery-status').textContent, '');
});

test('successful model discovery still filters, deduplicates and imports checked models', async t => {
  const x = fixture(t, async action => action === 'providers.discover' ? {models:['model-a','model-b','model-a']} : {});
  x.get('api-new').click();
  x.get('api-url').value = profile.baseUrl; x.get('api-key').value = 'test-credential';
  x.get('api-models').value = 'manual-model';
  x.get('api-scan').click(); await settle();
  assert.equal(x.get('api-discovery').hidden, false);
  assert.equal(x.d.querySelectorAll('.api-model-row').length, 2);
  assert.match(x.get('api-discovery-status').textContent, /不代表已通过对话和工具调用测试/);
  x.get('api-filter').value = 'model-b'; x.get('api-filter').dispatchEvent(new x.w.Event('input'));
  const checkboxes = x.get('api-discovery-results').querySelectorAll('input[type="checkbox"]');
  assert.equal(checkboxes.length, 1);
  checkboxes[0].click(); x.get('api-add-selected').click();
  assert.equal(x.get('api-models').value, 'manual-model\nmodel-b');
  x.get('api-url').dispatchEvent(new x.w.Event('input'));
  assert.equal(x.get('api-discovery').hidden, true);
  assert.equal(x.get('api-discovery-status').textContent, '');
});

test('API errors cannot copy a credential into the status or toast', async t => {
  const x = fixture(t, async () => { throw new Error('Authorization: Bearer sk-test-only'); });
  x.get('api-key').value = 'sk-test-only'; await x.submit();
  assert.doesNotMatch(x.get('api-status').textContent, /sk-test-only|Bearer/);
  assert.ok(x.notices.every(message => !message.includes('sk-test-only')));
  assert.equal(x.get('api-key').value, '');
});

test('public pricing lists model IDs without implying that the key or Responses works', async t => {
  const x = fixture(t, async () => ({source:'publicPricing', models:['gpt-6.2-sol'],
    listIssue:'读取模型列表失败（HTTP 401）', chatOnlyModels:['gpt-6.2-sol']}));
  x.get('api-new').click();
  x.get('api-url').value = 'https://example.test'; x.get('api-key').value = 'test-credential';
  x.get('api-scan').click(); await settle();
  assert.match(x.get('api-discovery-status').textContent, /HTTP 401.*公开价目表.*Responses/);
  assert.match(x.get('api-discovery-results').textContent, /gpt-6.2-sol.*Chat Completions/);
  x.get('api-discovery-results').querySelector('input').click();
  x.get('api-add-selected').click();
  assert.equal(x.get('api-models').value, 'gpt-6.2-sol');
  assert.match(x.get('api-discovery-status').textContent, /仍需实测/);
});

test('New API connection exports fill the form without saving or keeping the pasted JSON', async t => {
  const x = fixture(t, async () => ({}));
  x.get('api-new').click();
  x.get('api-import').open = true;
  const field = x.get('api-import-json');
  field.value = JSON.stringify({_type:'newapi_channel_conn', key:'test-key', url:'https://gateway.test'});
  x.get('api-import-apply').click();
  assert.equal(field.value, '');
  assert.equal(x.get('api-import').open, false);
  assert.equal(x.get('api-name').value, 'gateway.test');
  assert.equal(x.get('api-url').value, 'https://gateway.test/v1');
  assert.equal(x.get('api-key').value, 'test-key');
  assert.equal(x.calls.length, 0);
  field.value = JSON.stringify({_type:'newapi_channel_conn', key:'example-secret', url:'http://gateway.test'});
  x.get('api-import-apply').click();
  assert.equal(field.value, '');
  assert.equal(x.get('api-key').value, 'test-key');
  assert.match(x.get('api-discovery-status').textContent, /格式无效/);
});

test('a slow scan allows switching providers and discards results after the address changes', async t => {
  let completeScan;
  const other = {...profile, id:'another-provider', name:'另一个 API'};
  const x = fixture(t, action => action === 'providers.discover' ? new Promise(resolve => { completeScan = resolve; }) : {},
    {apiProviders:[profile, other], apiActive:profile.id});
  x.get('api-new').click();
  x.get('api-url').value = 'https://first.test'; x.get('api-key').value = 'test-credential';
  x.get('api-scan').click();
  assert.equal(x.get('api-scan').disabled, true);
  assert.equal(x.get('api-save').disabled, false);
  x.findButton('启用').click(); await settle();
  assert.deepEqual(x.calls[1], {action:'providers.select', args:{id:other.id}});
  x.get('api-url').value = 'https://second.test';
  x.get('api-url').dispatchEvent(new x.w.Event('input'));
  completeScan({models:['outdated-model']}); await settle();
  assert.equal(x.get('api-discovery').hidden, true);
  assert.equal(x.get('api-discovery-status').textContent, '');
  assert.equal(x.get('api-scan').disabled, false);
});
