const {test, afterEach} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {JSDOM} = require('jsdom');
const C = require('../app/src/main/assets/web/ui-core.js');
const root = 'app/src/main/assets/web/';
const opened = [];
afterEach(() => { for (const dom of opened.splice(0)) dom.window.close(); });
const tick = () => new Promise(r => setTimeout(r, 10));
async function answerConfirmation(document, accept, message) {
  await Promise.resolve();
  const dialog = document.getElementById('confirm-dialog');
  assert.equal(dialog.open, true);
  const copy = document.getElementById('confirm-message').textContent;
  assert.ok(copy.trim());
  if (message) assert.match(copy, message);
  assert.equal(document.activeElement.id, 'confirm-cancel');
  document.getElementById(accept ? 'confirm-accept' : 'confirm-cancel').click();
  await tick();
  assert.equal(dialog.open, false);
}
const fastModel = {id:'fast-model',model:'fast-model',displayName:'Fast-capable model',isDefault:true,serviceTiers:[{id:'priority',name:'Fast'}]};
const historyMessages = (from, to) => Array.from({length:to-from+1}, (_,i)=>({id:'m'+(from+i),role:(from+i)%2?'user':'assistant',text:'Message '+(from+i)}));
const historyMeta = (before, total=100) => ({beforeId:before?'m'+before:'',hasMore:!!before,total});
const workspaceRoot = {rootName:'大肥龙',path:'',parent:null,entries:[]};
const resetCredit = (id, expiresAt) => ({id, expiresAt, grantedAt:1900000000, status:'available', resetType:'codexRateLimits'});
function setup(overrides = {}, options = {}) {
  const dom = new JSDOM(fs.readFileSync(root+'index.html','utf8'), {url: 'https://appassets.androidplatform.net/index.html', runScripts: 'outside-only'}); opened.push(dom);
  const w = dom.window, calls = [], responses = [], frames = [];
  if (options.manualFrames) w.requestAnimationFrame = callback => frames.push(callback);
  w.matchMedia = query => ({matches:!!options.mobile && query.includes('max-width'), addEventListener(){}});
  if (options.drafts) for (const [key,value] of Object.entries(options.drafts)) w.localStorage.setItem(key,value);
  w.HTMLDialogElement.prototype.showModal = function(){this.setAttribute('open','');};
  w.HTMLDialogElement.prototype.close = function(){this.removeAttribute('open');this.dispatchEvent(new w.Event('close'));};
  w.confirm = () => { throw new Error('Unexpected native confirmation'); };
  const snapshot = {ready:true,busy:false,permissions:'workspace-write',models:[{id:'fixture-model',displayName:'Fixture model',isDefault:true,supportedReasoningEfforts:[{reasoningEffort:'high'}],defaultReasoningEffort:'high'}],messages:[],sessions:[],account:{},apiActive:'fixture-api',apiProviders:[{id:'fixture-api',hasKey:true}],workspace:{selected:true,name:'Project'},cwd:'/test/project',threadId:'t',status:'연결됨'};
  w.Native = {postMessage(raw){ const m=JSON.parse(raw); calls.push(m); queueMicrotask(async () => {
    if(m.action==='rpc.respond') responses.push(m.args);
    try {
      if (m.action === 'rpc' && m.args.method?.startsWith('sync.')) throw new Error('Sync belongs to the native bridge, not Codex RPC');
      const result=m.action.startsWith('sync.') && overrides.sync ? await overrides.sync(m) : overrides[m.action] ? await overrides[m.action](m) : m.action==='state' ? snapshot : m.action==='projects.workspaceFolders' ? workspaceRoot : m.action==='rpc' ? {data:[],marketplaces:[]} : {};
      w.mobileCodexEvent('response',{id:m.id,result});
    } catch(error) { w.mobileCodexEvent('response',{id:m.id,error:error.message}); }
  });}};
  w.Native.locale = () => JSON.stringify({brandName:options.brandName,choice:options.language || 'ko',systemLanguage:options.systemLanguage || 'ko'});
  w.Native.textSize = () => JSON.stringify({percent:options.textSize ?? 100});
  w.eval(fs.readFileSync(root+'translations.js','utf8')); w.eval(fs.readFileSync(root+'translations-zh.js','utf8')); w.eval(fs.readFileSync(root+'locale.js','utf8'));
  for (const file of ['appearance.js','ui-core.js','reasoning-policy.js','app.js']) w.eval(fs.readFileSync(root+file,'utf8'));
  return {w,calls,responses,snapshot,frames};
}
test('liquid glass is opt-in and switching styles preserves the conversation and draft', async () => {
 const {w, calls, snapshot} = setup({}, {drafts:{chatPreview:'true'}}); await tick();
 const doc = w.document, rootElement = doc.documentElement;
 const classic = doc.getElementById('appearance-classic');
 const glass = doc.getElementById('appearance-glass');
 w.mobileCodexEvent('state', {...snapshot, messages:[{id:'keep', role:'assistant', text:'Keep this reply'}]});
 const message = doc.querySelector('[data-id="keep"]');
 const prompt = doc.getElementById('prompt');
 prompt.value = 'Unsent draft';
 prompt.dispatchEvent(new w.Event('input'));

 doc.getElementById('settings').click();
 await tick();
 assert.ok(glass.closest('#settings-dialog .settings-primary'));
 const advanced = doc.getElementById('settings-advanced');
 const segment = glass.closest('[role="radiogroup"]');
 assert.equal(advanced.hidden, true);
 assert.equal(segment.dataset.segment, '0');
 assert.equal(doc.getElementById('chat-preview'), null);
 assert.equal(classic.checked, true);
 assert.equal(glass.checked, false);
 assert.equal(rootElement.hasAttribute('data-liquid-glass'), false);
 assert.equal(w.localStorage.getItem('interfaceStyle'), null);
 assert.deepEqual(calls.find(call => call.action === 'ui.theme').args, {theme:'system', liquidGlass:false});

 const callsBeforeSwitch = calls.length;
 glass.click();
 assert.equal(segment.dataset.segment, '1');
 assert.equal(rootElement.hasAttribute('data-liquid-glass'), true);
 assert.equal(w.localStorage.getItem('interfaceStyle'), 'glass');
 const reopened = setup({}, {drafts:{interfaceStyle:w.localStorage.getItem('interfaceStyle')}});
 assert.equal(reopened.w.document.getElementById('appearance-glass').checked, true);
 assert.equal(reopened.w.document.documentElement.hasAttribute('data-liquid-glass'), true);
 assert.deepEqual(reopened.calls.find(call => call.action === 'ui.theme').args, {theme:'system', liquidGlass:true});

 classic.click();
 assert.equal(segment.dataset.segment, '0');
 assert.equal(rootElement.hasAttribute('data-liquid-glass'), false);
 assert.equal(w.localStorage.getItem('interfaceStyle'), 'classic');
 const restored = setup({}, {drafts:{interfaceStyle:w.localStorage.getItem('interfaceStyle')}});
 assert.equal(restored.w.document.getElementById('appearance-classic').checked, true);
 assert.equal(restored.w.document.documentElement.hasAttribute('data-liquid-glass'), false);
 assert.equal(doc.querySelector('[data-id="keep"]'), message);
 assert.equal(doc.getElementById('prompt'), prompt);
 assert.equal(prompt.value, 'Unsent draft');
 assert.deepEqual(calls.slice(callsBeforeSwitch).map(({action, args}) => ({action, args})), [
   {action:'ui.theme', args:{theme:'system', liquidGlass:true}},
   {action:'ui.theme', args:{theme:'system', liquidGlass:false}},
 ]);
});
test('text size restores natively, saves explicitly and preserves the conversation and draft',async()=>{
 let saved=130;
 const {w,calls,snapshot}=setup({'ui.textSize':m=>({percent:saved=m.args.percent})},{textSize:saved});await tick();
 const d=w.document,select=d.getElementById('text-size');
 assert.equal(select.value,'130');assert.equal(d.documentElement.dataset.textSize,'130');
 assert.equal(calls.some(c=>c.action==='ui.textSize'),false,'startup does not overwrite saved preference');
 w.mobileCodexEvent('state',{...snapshot,messages:[{id:'keep',role:'user',text:'keep me'}]});
 d.getElementById('prompt').value='unsent draft';
 assert.deepEqual([...select.options].map(option=>option.value),['75','85','100','115','130','150']);
 for(const size of [150,115,85,75,100]) {
  select.value=String(size);select.dispatchEvent(new w.Event('change'));await tick();
  assert.equal(saved,size);assert.equal(d.documentElement.dataset.textSize,String(size));assert.equal(select.disabled,false);
 }
 assert.equal(d.getElementById('prompt').value,'unsent draft');assert.equal(d.querySelector('[data-id="keep"] .user-message-text').textContent,'keep me');
 assert.equal(calls.some(c=>c.action==='chat.send'||c.action==='config.save'||c.action==='projects.select'),false);
 const reopened=setup({}, {textSize:saved});await tick();assert.equal(reopened.w.document.getElementById('text-size').value,String(saved));
});
test('text shrink is opt-in, restores a saved reduced value and leaves the default at 100',async()=>{
 const fresh=setup();await tick();
 assert.equal(fresh.w.document.getElementById('text-size').value,'100');
 assert.equal(fresh.w.document.documentElement.style.getPropertyValue('--text-size-factor'),'1');
 assert.equal(fresh.calls.some(c=>c.action==='ui.textSize'),false);
 for(const size of [75,85]) {
  const reduced=setup({}, {textSize:size});await tick();
  assert.equal(reduced.w.document.getElementById('text-size').value,String(size));
  assert.equal(reduced.w.document.documentElement.style.getPropertyValue('--text-size-factor'),String(size/100));
  assert.equal(reduced.calls.some(c=>c.action==='ui.textSize'),false);
 }
});
test('text size rolls back failed saves and rejects an invalid native value',async()=>{
 const {w}=setup({'ui.textSize':()=>{throw Error('storage failed');}},{textSize:130});await tick();
 const select=w.document.getElementById('text-size');select.value='150';select.dispatchEvent(new w.Event('change'));await tick();
 assert.equal(select.value,'130');assert.equal(select.disabled,false);assert.equal(w.document.documentElement.dataset.textSize,'130');
 assert.match(w.document.getElementById('toast').textContent,/storage failed/);
 const invalid=setup({}, {textSize:999});await tick();assert.equal(invalid.w.document.getElementById('text-size').value,'100');
});
test('reply indent applies to prose in saved and streaming replies and restores on reopen',async()=>{
 const {w,snapshot}=setup();await tick();const doc=w.document;
 const style=doc.createElement('style');style.textContent=fs.readFileSync(root+'app.css','utf8');doc.head.append(style);
 const messages=[
  {id:'ask',role:'user',text:'Question'},
  {id:'reply',role:'assistant',text:'First line\nSame paragraph\n\nSecond paragraph\n\n- **通用**\n• 设置\n◦圆点\n\n1. 编号\n\n```sh\npwd\n```'},
  {id:'work:turn:cmd',role:'tool',kind:'toolActivity',activityKind:'command',detail:'pwd'},
  {id:'stream',role:'assistant',text:'Streaming reply\n\n● 流式圆点',status:'streaming'}
 ];
 w.mobileCodexEvent('state',{...snapshot,busy:true,turnId:'turn',messages});
 const checkbox=doc.getElementById('reply-indent');
 const indent=selector=>w.getComputedStyle(doc.querySelector(selector)).textIndent;
 assert.equal(checkbox.checked,false);
 checkbox.click();
 const prose=[...doc.querySelectorAll('.assistant-prose > .prose-line')];
 assert.equal(prose.length,3);assert.ok(prose.every(paragraph=>w.getComputedStyle(paragraph).textIndent==='2em'));
 assert.equal(prose[0].textContent,'First line\nSame paragraph');
 const listItems=[...doc.querySelectorAll('.assistant-prose li')];
 assert.deepEqual(listItems.map(item=>item.textContent),['通用','设置','圆点','编号','流式圆点']);
 assert.ok(listItems.every(item=>w.getComputedStyle(item).textIndent!=='2em'));
 for(const selector of ['.user-message-text','.message pre','.message-tool summary','.message-tool pre'])assert.notEqual(indent(selector),'2em');
 assert.equal(w.localStorage.getItem('replyIndent'),'true');
 const reopened=setup({}, {drafts:{replyIndent:w.localStorage.getItem('replyIndent')}});await tick();
 assert.equal(reopened.w.document.getElementById('reply-indent').checked,true);
 checkbox.click();assert.notEqual(indent('.assistant-prose > .prose-line'),'2em');
});
test('user bubbles show small dates only when a real timestamp exists',async()=>{
 const {w,snapshot}=setup();await tick();const now=Date.UTC(2026,8,29,12,34);
 w.mobileCodexEvent('state',{...snapshot,messages:[
  {id:'dated',role:'user',text:'hello',createdAt:now},
  {id:'assistant',role:'assistant',text:'answer',createdAt:now},
  {id:'legacy',role:'user',text:'old'},
  {id:'invalid',role:'user',text:'invalid',createdAt:'bad date'},
  {id:'zero',role:'user',text:'unknown',createdAt:0}
 ]});
 const dates=w.document.querySelectorAll('#messages time');assert.equal(dates.length,1);
 assert.equal(dates[0].dateTime,new Date(now).toISOString());assert.match(dates[0].textContent,/09\.29 \d{2}:\d{2}/);
 assert.equal(dates[0].closest('article').dataset.id,'dated');assert.ok(dates[0].title);
});
test('history lazy-loads in the existing scroller and keeps order, nodes and reading position',async()=>{
 let resolveHistory;
 const {w,calls,snapshot}=setup({'chat.history':()=>new Promise(resolve=>{resolveHistory=resolve;})});await tick();
 const d=w.document,area=d.getElementById('chat-scroll'),list=d.getElementById('messages');
 Object.defineProperty(area,'scrollHeight',{get:()=>list.children.length*100});Object.defineProperty(area,'clientHeight',{value:300});
 const recent={...snapshot,messages:historyMessages(61,100),messageHistory:historyMeta(61)};
 w.mobileCodexEvent('state',recent);await tick();assert.equal(list.children.length,40);
 assert.equal(calls.filter(c=>c.action==='chat.history').length,0);
 const original=d.querySelector('[data-id="m61"]');area.scrollTop=100;area.dispatchEvent(new w.Event('scroll'));await tick();
 assert.equal(d.getElementById('jump-latest').hidden,true);
 area.dispatchEvent(new w.Event('wheel'));await tick();
 assert.equal(calls.filter(c=>c.action==='chat.history').length,1);
 assert.deepEqual(calls.find(c=>c.action==='chat.history').args,{threadId:'t',beforeId:'m61',limit:40});
 resolveHistory({threadId:'t',messages:historyMessages(21,61),messageHistory:historyMeta(21)});await tick();
 assert.equal(list.children.length,80);assert.equal(list.firstElementChild.dataset.id,'m21');assert.equal(list.lastElementChild.dataset.id,'m100');
 assert.equal(d.querySelector('[data-id="m61"]'),original);assert.equal(area.scrollTop,4100);
 assert.equal(d.getElementById('jump-latest').hidden,true);
 assert.equal(d.querySelectorAll('#chat-scroll').length,1);assert.equal(d.querySelector('#history-status button'),null);
 w.mobileCodexEvent('state',{...recent,messages:historyMessages(62,101),messageHistory:historyMeta(62,101)});
 assert.equal(list.children.length,81);assert.equal(list.firstElementChild.dataset.id,'m21');assert.equal(list.lastElementChild.dataset.id,'m101');
 assert.equal(d.querySelector('[data-id="m61"]'),original);
 assert.equal(d.getElementById('jump-latest').hidden,true);
 w.mobileCodexEvent('state',{...recent,messages:historyMessages(63,102),messageHistory:historyMeta(63,102)});
 assert.equal(d.getElementById('jump-latest').hidden,false);
});
test('deferred viewport and focus scrolling respects newer upward navigation',async()=>{
 for (const trigger of ['viewport','focus']) {
  const {w,snapshot,frames}=setup({}, {manualFrames:true});await tick();
  const area=w.document.getElementById('chat-scroll');
  Object.defineProperty(area,'scrollHeight',{value:4000});
  Object.defineProperty(area,'clientHeight',{value:300});
  w.mobileCodexEvent('state',{...snapshot,messages:historyMessages(61,100),messageHistory:historyMeta(0)});
  for(const callback of frames.splice(0))callback();
  if(trigger==='viewport')w.mobileCodexEvent('viewport',{keyboardVisible:true});
  else w.document.getElementById('prompt').dispatchEvent(new w.Event('focus'));
  assert.ok(frames.length>0,trigger+' schedules a layout follow-up');
  area.scrollTop=100;area.dispatchEvent(new w.Event('scroll'));
  for(const callback of frames.splice(0))callback();
  assert.equal(area.scrollTop,100,trigger+' must not pull the reader back to the tail');
 }
});
test('history never expands the recent window without upward navigation',async()=>{
 const {w,calls,snapshot}=setup();await tick();const list=w.document.getElementById('messages');
 w.mobileCodexEvent('state',{...snapshot,messages:historyMessages(61,100),messageHistory:historyMeta(61)});
 w.mobileCodexEvent('state',{...snapshot,messages:historyMessages(62,101),messageHistory:historyMeta(62,101)});
 assert.equal(list.children.length,40);assert.equal(list.firstElementChild.dataset.id,'m62');
 assert.equal(calls.some(c=>c.action==='chat.history'),false);
});
test('history discards an in-flight page after switching conversations',async()=>{
 let resolveHistory;
 const {w,snapshot}=setup({'chat.history':()=>new Promise(resolve=>{resolveHistory=resolve;})});await tick();
 w.mobileCodexEvent('state',{...snapshot,messages:historyMessages(61,100),messageHistory:historyMeta(61)});
 w.document.getElementById('chat-scroll').dispatchEvent(new w.WheelEvent('wheel',{deltaY:-20}));await tick();
 w.mobileCodexEvent('state',{...snapshot,threadId:'second',messages:[{id:'other',role:'user',text:'Other conversation'}],messageHistory:historyMeta(0,1)});
 resolveHistory({threadId:'t',messages:historyMessages(21,60),messageHistory:historyMeta(21)});await tick();
 assert.equal(w.document.getElementById('messages').children.length,1);assert.equal(w.document.querySelector('#messages article').dataset.id,'other');
});
test('history preserves the live tail while a page is pending and errors retry only on upward navigation',async()=>{
 let resolveHistory,attempt=0;
 const {w,calls,snapshot}=setup({'chat.history':()=>{if(++attempt===1)throw new Error('offline');return new Promise(resolve=>{resolveHistory=resolve;});}});await tick();
 const area=w.document.getElementById('chat-scroll'),list=w.document.getElementById('messages');
 const recent={...snapshot,messages:historyMessages(61,100),messageHistory:historyMeta(61)};w.mobileCodexEvent('state',recent);
 area.dispatchEvent(new w.WheelEvent('wheel',{deltaY:-20}));await tick();assert.equal(list.children.length,40);
 assert.match(w.document.getElementById('history-status').textContent,/重试/);await tick();assert.equal(attempt,1);
 area.dispatchEvent(new w.WheelEvent('wheel',{deltaY:-20}));await tick();
 w.mobileCodexEvent('state',{...recent,messages:historyMessages(62,101),messageHistory:historyMeta(62,101)});
 resolveHistory({threadId:'t',messages:historyMessages(21,60),messageHistory:historyMeta(21,100)});await tick();
 assert.equal(list.children.length,81);assert.equal(list.firstElementChild.dataset.id,'m21');assert.equal(list.lastElementChild.dataset.id,'m101');
 assert.equal(calls.filter(c=>c.action==='chat.history').length,2);assert.equal(w.document.getElementById('history-status').hidden,true);
});
test('collapsed commands can load earlier history even without a scrollable page',async()=>{
 let fail=true;
 const {w,calls,snapshot}=setup({'chat.history':()=>{
  if(fail) throw new Error('offline');
  return {threadId:'t',messages:[{id:'earlier',role:'user',text:'Older question'}],messageHistory:historyMeta(0,3)};
 }});await tick();
 const d=w.document,area=d.getElementById('chat-scroll'),load=d.getElementById('history-load');
 Object.defineProperties(area,{scrollHeight:{get:()=>d.querySelector('[data-id="earlier"]')?1200:500},clientHeight:{value:500}});
 w.mobileCodexEvent('state',{...snapshot,messages:[{id:'m2',kind:'toolActivity',activityKind:'command',completed:true},{id:'m3',role:'assistant',text:'Done'}],messageHistory:historyMeta(2,3)});
 assert.equal(d.querySelector('.tool-group').getAttribute('aria-expanded'),'false');
 assert.equal(d.querySelector('[data-id="m2"]').hidden,true);
 assert.equal(calls.some(call=>call.action==='chat.history'),false);
 assert.equal(load.hidden,false);
 load.click();await tick();
 assert.match(d.getElementById('history-status').textContent,/重试/);assert.equal(load.disabled,false);
 fail=false;load.click();load.click();await tick();
 assert.equal(calls.filter(call=>call.action==='chat.history').length,2);
 assert.ok(d.querySelector('[data-id="earlier"]'));assert.equal(load.hidden,true);
 assert.equal(area.scrollTop,0,'newly loaded history stays in view when a short conversation becomes scrollable');
 assert.equal(d.querySelector('[data-id="m2"]').hidden,true);
});
test('login URLs reject non-OpenAI hosts and embedded credentials',()=>{
 assert.equal(C.safeLoginUrl('https://auth.openai.com/codex/device'),true);
 for(const url of ['javascript:alert(1)','http://auth.openai.com','https://auth.openai.com.evil.test','https://user:pass@auth.openai.com'])assert.equal(C.safeLoginUrl(url),false);
});
test('streaming reuses message identity',()=>{const m=[];C.appendDelta(m,'one','가');C.appendDelta(m,'one','나');assert.equal(m.length,1);assert.equal(m[0].text,'가나');});
test('every wired control exists and initial state renders safely',async()=>{
 const {w,snapshot}=setup();await tick();
 w.mobileCodexEvent('state',{...snapshot,messages:[{id:'u',role:'user',text:'<img src=x onerror=alert(1)>'},{id:'a',role:'assistant',text:'```html\n<script>alert(1)</script>\n```'}]});
 assert.equal(w.document.querySelectorAll('#messages img:not(.chat-character), #messages script').length,0);
 assert.match(w.document.getElementById('messages').textContent,/<script>/);
 assert.equal(w.document.getElementById('project-label').textContent,'Project');
});
test('Linux environment stays idle until the user explicitly installs it',async()=>{
 const {w,calls,snapshot}=setup();await tick();
 const linux={supported:true,installed:false,enabled:false,busy:false,state:'not_installed',label:'Debian',downloadBytes:152000000,requiredFreeBytes:300000000,availableBytes:900000000};
 w.mobileCodexEvent('state',{...snapshot,linux});await tick();
 assert.equal(calls.filter(c=>c.action==='linux.install').length,0);
 assert.match(w.document.getElementById('linux-environment-details').textContent,/Debian/);
 assert.match(w.document.getElementById('linux-environment-details').textContent,/B/);
 w.MobileCodexLocale.set('en');w.mobileCodexEvent('state',{...snapshot,linux});await tick();
 assert.match(w.document.getElementById('linux-environment-description').textContent,/Codex and terminal/);
});
test('Linux progress and cancellation reflect native status events',async()=>{
 const {w,calls,snapshot}=setup();await tick();
 const linux={supported:true,installed:false,enabled:false,busy:true,state:'downloading',label:'Debian',downloadedBytes:25,totalBytes:100};
 w.mobileCodexEvent('state',{...snapshot,linux});await tick();
 const progress=w.document.getElementById('linux-environment-progress');
 assert.equal(progress.hidden,false);assert.equal(progress.max,100);assert.equal(progress.value,25);
 assert.equal(w.document.getElementById('linux-install').hidden,true);
 w.document.getElementById('linux-cancel').click();await tick();
  assert.equal(calls.filter(c=>c.action==='linux.cancel').length,1);
 w.mobileCodexEvent('linux.changed',{...linux,state:'verifying'});await tick();
 assert.equal(progress.hasAttribute('value'),false);
  w.mobileCodexEvent('linux.changed',{...linux,busy:false,state:'cancelled'});await tick();
 assert.match(w.document.getElementById('linux-environment-status').textContent,/取消/);
 assert.equal(w.document.getElementById('linux-install').textContent,'重试');
});
test('Linux settings suppress duplicate bridge mutations and reset the terminal note after disabling',async()=>{
 let resolveInstall;
 const {w,calls,snapshot}=setup({'linux.install':()=>new Promise(resolve=>{resolveInstall=resolve;})});await tick();
 const linux={supported:true,installed:false,enabled:false,busy:false,state:'not_installed',label:'Debian'};
 w.mobileCodexEvent('state',{...snapshot,devtools:{bundled:false},linux});await tick();
 const install=w.document.getElementById('linux-install');install.click();install.click();await tick();
 assert.equal(calls.filter(c=>c.action==='linux.install').length,1);assert.equal(install.disabled,true);
 resolveInstall({...linux,installed:true,state:'ready',enabled:true});await tick();
 assert.equal(install.disabled,false);
 assert.match(w.document.getElementById('terminal-tools-note').textContent,/Debian/);
 w.mobileCodexEvent('linux.changed',{...linux,installed:true,state:'ready',enabled:false});await tick();
 assert.match(w.document.getElementById('terminal-tools-note').textContent,/未提供捆绑开发工具/);
});
test('Linux installation errors retry only on click and failed enable never flips the toggle',async()=>{
 const {w,calls,snapshot}=setup({'linux.enable':()=>{throw new Error('<img src=x onerror=alert(1)>');}});await tick();
 const failed={supported:true,installed:false,enabled:false,busy:false,state:'error',label:'Debian',error:'network down'};
 w.mobileCodexEvent('state',{...snapshot,linux:failed});await tick();
 const install=w.document.getElementById('linux-install');assert.equal(install.textContent,'重试');install.click();await tick();
 assert.equal(calls.filter(c=>c.action==='linux.install').length,1);
 const ready={supported:true,installed:true,enabled:false,busy:false,state:'ready',label:'Debian'};
 w.mobileCodexEvent('linux.changed',ready);await tick();
 const enabled=w.document.getElementById('linux-enabled');enabled.checked=true;enabled.dispatchEvent(new w.Event('change'));await tick();
 assert.equal(calls.filter(c=>c.action==='linux.enable').at(-1).args.enabled,true);
 assert.equal(enabled.checked,false);
 assert.equal(w.document.querySelector('#linux-environment-status img'),null);
 assert.match(w.document.getElementById('linux-environment-status').textContent,/<img/);
});
test('Linux incomplete installation can be explicitly removed without automatic retry',async()=>{
 const {w,calls,snapshot}=setup({'linux.remove':()=>({supported:true,installed:false,hasFiles:false,enabled:false,busy:false,state:'not_installed'})});await tick();
 w.mobileCodexEvent('state',{...snapshot,linux:{supported:true,installed:false,hasFiles:true,enabled:false,busy:false,state:'error',error:'incomplete installation'}});await tick();
 const remove=w.document.getElementById('linux-remove');
 assert.equal(remove.hidden,false);
 remove.click();assert.equal(calls.filter(c=>c.action==='linux.remove').length,0);
 await answerConfirmation(w.document,false,/Linux/);
 assert.equal(calls.filter(c=>c.action==='linux.remove').length,0);
 remove.click();await answerConfirmation(w.document,true,/Linux/);
 assert.equal(calls.filter(c=>c.action==='linux.remove').length,1);
 assert.equal(remove.hidden,true);assert.equal(calls.filter(c=>c.action==='linux.install').length,0);
});
test('submit is cancelled synchronously and calls native with chosen model and effort',async()=>{
 const {w,calls}=setup();await tick();w.document.getElementById('prompt').value='실제 파일 수정';
 const e=new w.Event('submit',{cancelable:true});w.document.getElementById('composer').dispatchEvent(e);
 assert.equal(e.defaultPrevented,true);await tick();
 assert.equal(calls.find(m=>m.action==='chat.send').args.text,'실제 파일 수정');
});
test('retired subscription and Live resources have no UI or transport entry',()=>{
 const main=fs.readFileSync('app/src/main/java/dev/mobilecodex/app/MainActivity.java','utf8');
 const app=fs.readFileSync(root+'app.js','utf8');
 const html=fs.readFileSync(root+'index.html','utf8');
 assert.doesNotMatch(main,/new ProWebTransport/);
 assert.doesNotMatch(app,/chat\.pro\.send|auth\.(?:login|add|refresh|switch|logout)|account\/rateLimits/);
 assert.doesNotMatch(html,/id="(?:login-dialog|live-dialog|account-button|usage-limits|live-start)"/);
 for(const name of ['pro-web-transport.js','chat-web-custom.js','chat-icon-renderer.js','pro-consult-mcp.py']) assert.equal(fs.existsSync('app/src/main/assets/'+name),false);
 for(const name of ['live.js','live.css','agents-ui.js','agents.css']) assert.equal(fs.existsSync(root+name),false);
});
test('sidebar sections collapse independently and restore their state',async()=>{
 const {w,snapshot}=setup();await tick();const d=w.document;
 d.getElementById('toggle-projects').click();await tick();
 assert.equal(d.getElementById('projects').hidden,true);
 assert.equal(d.getElementById('sessions').hidden,false);
 w.mobileCodexEvent('state',snapshot);
 assert.equal(d.getElementById('projects').hidden,true);
 d.getElementById('toggle-history').click();await tick();
 assert.equal(d.getElementById('sessions').hidden,true);
 d.getElementById('toggle-projects').click();await tick();
 assert.equal(d.getElementById('projects').hidden,false);
 assert.equal(d.getElementById('toggle-projects').getAttribute('aria-expanded'),'true');
 assert.equal(d.querySelector('.topbar .sidebar-toggle use').getAttribute('href'),'#i-menu');
 assert.equal(d.querySelector('#files-toggle use').getAttribute('href'),'#i-panel');
 for(const id of ['new-chat','projects','sessions']) assert.ok(d.getElementById(id).closest('.sidebar-scroll'));
 for(const id of ['show-tools','settings']) assert.equal(d.getElementById(id).closest('.sidebar-bottom'),d.querySelector('.sidebar-bottom'));
 assert.equal(d.querySelector('.sidebar-bottom').parentElement,d.getElementById('sidebar'));
 assert.equal(d.querySelector('.sidebar-bottom').closest('.sidebar-scroll'),null);
 const restored=setup({}, {drafts:{'sidebar-section-sessions':'collapsed'}});await tick();
 assert.equal(restored.w.document.getElementById('sessions').hidden,true);
});
test('work permissions contains approval review without changing file access',async()=>{
 const {w,calls,snapshot}=setup({'approvals.set':()=>({ok:true})});await tick();
 const select=w.document.getElementById('approval-mode');assert.equal(select.value,'auto-review');
 assert.equal(select.closest('#composer'),null);
 assert.equal(select.closest('dialog').id,'options-dialog');
 select.value='allow-all';select.dispatchEvent(new w.Event('change'));await tick();
 assert.equal(calls.filter(m=>m.action==='approvals.set').at(-1).args.mode,'allow-all');
 assert.equal(w.document.getElementById('permissions').value,'workspace-write');
 assert.match(select.title,/全部允许/);
 w.mobileCodexEvent('state',{...snapshot,busy:true,approvalMode:'allow-all'});
 assert.equal(select.disabled,true);
});
test('approval UI returns original key and acceptance, never silently auto-approves',async()=>{
 const {w,responses}=setup();await tick();w.mobileCodexEvent('server.request',{key:'k',method:'item/commandExecution/requestApproval',params:{command:'pwd'}});
 assert.equal(responses.length,0);
 const approve=[...w.document.querySelectorAll('#request-actions button')].find(b=>b.textContent==='允许');approve.click();await tick();
 assert.deepEqual(responses[0],{key:'k',result:{decision:'accept'}});
});
test('question UI preserves stable question ids and answer array',async()=>{
 const {w,responses}=setup();await tick();w.mobileCodexEvent('server.request',{key:'q',method:'item/tool/requestUserInput',params:{questions:[{id:'lang',question:'언어는?',options:[{label:'Java'}]}]}});
 w.document.querySelector('#request-fields input').value='Java';w.document.querySelector('#request-actions button').click();await tick();
 assert.deepEqual(responses[0].result,{answers:{lang:{answers:['Java']}}});
});
test('plugin, skill, MCP screens query real protocol routes',async()=>{
 const {w,calls}=setup();await tick();w.document.getElementById('show-tools').click();await tick();w.document.getElementById('show-tools-panel').click();await tick();await tick();
 const routes=calls.filter(m=>m.action==='rpc').map(m=>m.args.method);
 assert.deepEqual(routes,['plugin/list','skills/list','mcpServerStatus/list']);
});
test('tool refresh keeps a prior category list when one protocol request fails',async()=>{
 let pluginCalls=0;
 const {w}=setup({'rpc':m=>{
   if(m.args.method==='plugin/list') { pluginCalls++; if(pluginCalls > 1) throw new Error('transport closed'); return {marketplaces:[{name:'local',plugins:[{name:'Keep me',id:'keep'}]}]}; }
   if(m.args.method==='skills/list') return {data:[]};
   return {data:[]};
 }});await tick();w.document.getElementById('show-tools').click();await tick();w.document.getElementById('show-tools-panel').click();await tick();await tick();
 assert.match(w.document.getElementById('tools-list').textContent,/Keep me/);
 w.document.getElementById('refresh-tools').click();await tick();await tick();
 assert.match(w.document.getElementById('tools-list').textContent,/显示上次的列表/);
 assert.match(w.document.getElementById('tools-list').textContent,/Keep me/);
});
test('plugins, skills and MCP servers have separate tabs with counts and search',async()=>{
 const {w}=setup({'rpc':m=>{
   if(m.args.method==='plugin/list') return {marketplaces:[{name:'local',plugins:[{name:'Alpha plugin',id:'a'},{name:'Beta plugin',id:'b'}]}]};
   if(m.args.method==='skills/list') return {data:[{skills:[{name:'writer',description:'Drafts docs',path:'/s/writer',enabled:true}]}]};
   return {data:[{name:'github',tools:{a:{},b:{}}},{name:'linear',tools:{}},{name:'figma',tools:{}}]};
 }});await tick();w.document.getElementById('show-tools').click();await tick();w.document.getElementById('show-tools-panel').click();await tick();await tick();
 const d=w.document,tabs=[...d.querySelectorAll('.tools-tab')],panels=[...d.querySelectorAll('.tools-panel')];
 assert.deepEqual(tabs.map(t=>t.querySelector('.tools-count').textContent),['2','1','3']);
 assert.deepEqual(panels.map(p=>p.hidden),[false,true,true]);
 tabs[2].click();assert.deepEqual(panels.map(p=>p.hidden),[true,true,false]);assert.equal(tabs[2].getAttribute('aria-selected'),'true');
 const search=d.querySelector('.tools-search');search.value='lin';search.dispatchEvent(new w.Event('input'));
 assert.deepEqual([...panels[2].querySelectorAll('.tool-card')].filter(c=>!c.hidden).map(c=>c.querySelector('strong').textContent),['linear']);
 search.value='nothing matches';search.dispatchEvent(new w.Event('input'));assert.equal(d.querySelector('.tools-no-match').hidden,false);
});
test('tool recovery action keeps protocol failures handled after menu relocation',async()=>{
 const {w}=setup({'recovery.list':()=>{throw new Error('recovery offline');}});let unhandled=0;
 w.addEventListener('unhandledrejection',()=>unhandled++);await tick();
 w.document.getElementById('show-tools').click();await tick();w.document.getElementById('show-recovery').click();await tick();await tick();
 assert.match(w.document.getElementById('toast').textContent,/recovery offline/);assert.equal(unhandled,0);
});
test('a different project cannot inherit the previous project tool cache after a failure',async()=>{
 let offline=false;
 const {w,snapshot}=setup({'rpc':m=>{if(offline)throw new Error('offline');return m.args.method==='skills/list'?{data:[{skills:[{name:'project-only-skill',description:'local',path:'/first/SKILL.md'}]}]}:{data:[],marketplaces:[]};}});await tick();
  w.document.getElementById('show-tools').click();await tick();w.document.getElementById('show-tools-panel').click();await tick();await tick();
 assert.match(w.document.getElementById('tools-list').textContent,/project-only-skill/);
 offline=true;w.mobileCodexEvent('state',{...snapshot,cwd:'/second',threadId:'second'});
 w.document.getElementById('refresh-tools').click();await tick();await tick();
 assert.doesNotMatch(w.document.getElementById('tools-list').textContent,/project-only-skill/);
});

test('MCP forms collect typed answers without asking users to write JSON',async()=>{
 const {w,responses}=setup();await tick();
 w.mobileCodexEvent('server.request',{key:'mcp',method:'mcpServer/elicitation/request',params:{serverName:'demo',mode:'form',message:'환경 선택',requestedSchema:{type:'object',required:['environment'],properties:{environment:{type:'string',enum:['dev','prod']},retries:{type:'integer',minimum:0},enabled:{type:'boolean',default:true}}}}});
 assert.equal(w.document.querySelectorAll('#request-fields textarea').length,0);
 w.document.querySelector('#request-fields select').value='0';w.document.querySelector('#request-fields input[type=number]').value='3';
 [...w.document.querySelectorAll('#request-actions button')].find(b=>b.textContent==='提交').click();await tick();
 assert.deepEqual(responses[0].result,{action:'accept',content:{environment:'dev',retries:3,enabled:true}});
});

test('composer survives keyboard resize, grows with content and preserves input focus',async()=>{
 const {w,frames}=setup({}, {manualFrames:true});await tick();
 const flushFrame=()=>frames.splice(0).forEach(callback=>callback());flushFrame();
 const d=w.document,prompt=d.getElementById('prompt');
 Object.defineProperty(prompt,'scrollHeight',{configurable:true,get:()=>300});
 prompt.value='긴 요청\n두 번째 줄';prompt.focus();prompt.dispatchEvent(new w.Event('input'));
 flushFrame();assert.equal(prompt.style.height,'100px');
 Object.defineProperty(w,'innerHeight',{value:320,configurable:true});w.dispatchEvent(new w.Event('resize'));flushFrame();
 assert.equal(d.documentElement.style.getPropertyValue('--app-height'),'320px');
 assert.equal(prompt.style.height,'86.4px');assert.equal(d.activeElement,prompt);assert.equal(prompt.value,'긴 요청\n두 번째 줄');
 Object.defineProperty(w,'innerHeight',{value:800});w.dispatchEvent(new w.Event('resize'));flushFrame();
 assert.equal(d.documentElement.style.getPropertyValue('--app-height'),'800px');
});
test('drafts restore separately for each thread and remain after sending fails',async()=>{
 const key='draft:'+JSON.stringify(['/test/project','t']);
 const {w,snapshot}=setup({'chat.send':()=>{throw new Error('offline');}},{drafts:{[key]:'작성하던 요청'}});await tick();
 const prompt=w.document.getElementById('prompt');assert.equal(prompt.value,'작성하던 요청');
 w.mobileCodexEvent('state',{...snapshot,threadId:'second'});assert.equal(prompt.value,'');
 prompt.value='다른 대화';prompt.dispatchEvent(new w.Event('input'));
 w.mobileCodexEvent('state',snapshot);assert.equal(prompt.value,'작성하던 요청');
 w.document.getElementById('composer').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();
 assert.equal(prompt.value,'작성하던 요청');assert.equal(w.localStorage.getItem(key),'작성하던 요청');
});
test('a send acknowledgement never erases newer text and duplicate submits are ignored',async()=>{
 let finish;const {w,calls}=setup({'chat.send':()=>new Promise(resolve=>finish=resolve)});await tick();
 const d=w.document,p=d.getElementById('prompt');p.value='보낼 내용';p.dispatchEvent(new w.Event('input'));
 d.getElementById('composer').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();
 d.getElementById('composer').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();
 p.value='다음 요청 작성 중';p.dispatchEvent(new w.Event('input'));finish({});await tick();
 assert.equal(calls.filter(c=>c.action==='chat.send').length,1);assert.equal(p.value,'다음 요청 작성 중');
});
test('a first send clears only its transferred draft, without losing the new thread',async()=>{
 let finish;const {w,snapshot}=setup({'chat.send':()=>new Promise(resolve=>finish=resolve)});await tick();
 w.mobileCodexEvent('state',{...snapshot,threadId:''});const d=w.document,p=d.getElementById('prompt');
 p.value='첫 요청';p.dispatchEvent(new w.Event('input'));d.getElementById('composer').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();
 w.mobileCodexEvent('state',{...snapshot,threadId:'created',busy:true});finish({});await tick();
 assert.equal(p.value,'');assert.equal(w.localStorage.getItem('draft:'+JSON.stringify(['/test/project','new'])),null);
 assert.equal(w.localStorage.getItem('draft:'+JSON.stringify(['/test/project','created'])),null);
});
test('reading older messages stops streaming auto-scroll until latest is requested',async()=>{
 const {w,snapshot}=setup();await tick();const area=w.document.getElementById('chat-scroll');
 Object.defineProperties(area,{scrollHeight:{value:1800},clientHeight:{value:500}});
 w.mobileCodexEvent('state',{...snapshot,messages:[{id:'a',role:'assistant',text:'이전 답변'}]});
 area.scrollTop=100;area.dispatchEvent(new w.Event('scroll'));
 const jump=w.document.getElementById('jump-latest');
 assert.equal(jump.hidden,true);
 w.mobileCodexEvent('message.delta',{id:'a',delta:'  '});assert.equal(jump.hidden,true);
 w.mobileCodexEvent('message.delta',{id:'a',threadId:'other',delta:'다른 대화'});assert.equal(jump.hidden,true);
 w.mobileCodexEvent('message.delta',{id:'a',delta:' 새 내용'});assert.equal(area.scrollTop,100);
 assert.equal(jump.hidden,false);
 jump.click();await tick();assert.equal(area.scrollTop,1800);assert.equal(jump.hidden,true);
 area.scrollTop=100;area.dispatchEvent(new w.Event('scroll'));assert.equal(jump.hidden,true);
});
test('mobile settings expose full model, reasoning and permission controls',async()=>{
 const {w,snapshot,calls}=setup({}, {mobile:true});await tick();const d=w.document;
 w.mobileCodexEvent('state',{...snapshot,models:[{id:'model-long',model:'model-long',displayName:'A model with a long name',supportedReasoningEfforts:[{reasoningEffort:'high'}]}]});
 d.getElementById('composer-options').click();await tick();assert.equal(d.getElementById('model-picker').open,true);
 const model=d.getElementById('model');model.value='model-long';model.dispatchEvent(new w.Event('change'));await tick();
 d.getElementById('model-picker-permissions').click();await tick();assert.equal(d.getElementById('options-dialog').open,true);
 assert.equal(d.getElementById('model-picker').open,false);
 d.getElementById('effort').value='high';d.getElementById('permissions').value='danger-full-access';d.getElementById('permissions').dispatchEvent(new w.Event('change'));await tick();
 assert.equal(d.getElementById('model-summary').textContent,'A model with a long name');
 assert.equal(calls.find(c=>c.action==='permissions.set').args.mode,'danger-full-access');
 assert.equal(d.getElementById('effort').value,'high');
});
test('opening the model picker refreshes available models without waiting to show it',async()=>{
 let finish;
 const oldModels=[{id:'gpt-6-astra',displayName:'GPT-6-Astra'},{id:'gpt-5.6-sol',displayName:'GPT-5.6-Sol'}];
 const newModels=[...oldModels,{id:'gpt-6-sol',displayName:'GPT-6-Sol'},{id:'gpt-6-luna',displayName:'GPT-6-Luna'}];
 const {w,calls,snapshot}=setup({'models.refresh':()=>new Promise(resolve=>{finish=resolve;})},{mobile:true});await tick();
 const d=w.document;w.mobileCodexEvent('state',{...snapshot,models:oldModels});
 d.getElementById('model').value='gpt-6-astra';d.getElementById('model').dispatchEvent(new w.Event('change'));
 d.getElementById('composer-options').click();await tick();
 assert.equal(d.getElementById('model-picker').open,true);
 assert.equal(calls.filter(c=>c.action==='models.refresh').length,1);
 assert.match(d.getElementById('model-list').textContent,/GPT-5.6-Sol/);
 assert.doesNotMatch(d.getElementById('model-list').textContent,/GPT-6-Luna/);
 assert.equal(d.getElementById('model-refresh-status').hidden,false);
 w.mobileCodexEvent('state',{...snapshot,models:newModels});finish({models:newModels});await tick();
 assert.match(d.getElementById('model-list').textContent,/GPT-6-Sol/);
 assert.match(d.getElementById('model-list').textContent,/GPT-6-Luna/);
 assert.equal(d.querySelector('#model-list input[value="gpt-6-astra"]').checked,true);
 assert.equal(d.getElementById('model-refresh-status').hidden,true);
 assert.equal(calls.some(c=>c.action==='runtime.stop'||c.action==='runtime.start'),false);
});
test('model picker sends actual catalog values and reselecting the active model returns to reasoning',async()=>{
 const {w,snapshot,calls}=setup({}, {mobile:true});await tick();const d=w.document;
 const models=[
  {id:'catalog-a',displayName:'Catalog A',defaultReasoningEffort:'high',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}]},
  {id:'catalog-b',displayName:'Catalog B',defaultReasoningEffort:'ultra',supportedReasoningEfforts:[{reasoningEffort:'medium'},{reasoningEffort:'ultra'}]}
 ];
 w.mobileCodexEvent('state',{...snapshot,models});
 d.getElementById('composer-options').click();await tick();
 assert.equal(d.getElementById('model').hidden,true);assert.equal(d.getElementById('effort').hidden,true);
 d.getElementById('model-picker-model').click();await tick();
 assert.equal(d.getElementById('model-panel').inert,false);
 d.querySelector('#model-list input[value="catalog-b"]').click();await tick();
 assert.equal(d.getElementById('model').value,'catalog-b');
 assert.equal(d.getElementById('effort').value,'ultra');
 assert.equal(d.getElementById('effort-heading').textContent,'ultra');
 assert.equal(d.querySelector('#effort-levels .selected').textContent,'ultra');
 assert.equal(d.getElementById('model-heading').textContent,'Catalog B');
 assert.equal(d.getElementById('reasoning-panel').inert,false);
 const slider=d.getElementById('effort-slider');
 assert.equal(slider.hidden,false);assert.equal(slider.disabled,false);
 assert.deepEqual([...d.querySelectorAll('#effort-levels span')].map(span=>span.textContent),['medium','ultra']);
 slider.value='1';slider.dispatchEvent(new w.Event('input'));slider.dispatchEvent(new w.Event('change'));await tick();
 assert.equal(d.getElementById('effort').value,'ultra');
 assert.equal(d.getElementById('effort-heading').textContent,'ultra');
 assert.equal(d.getElementById('effort-summary').textContent,d.getElementById('effort-heading').textContent);
 d.getElementById('model-picker-model').click();await tick();
 d.querySelector('#model-list input[value="catalog-b"]').click();await tick();
 assert.equal(d.getElementById('model-panel').inert,true);
 d.getElementById('prompt').value='Check the selected settings';
 d.getElementById('composer').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();
 const request=calls.find(c=>c.action==='chat.send');
 assert.equal(request.args.model,'catalog-b');assert.equal(request.args.effort,'ultra');
});

test('reasoning slider follows runtime metadata, saves English values and removes model prose',async()=>{
 const {w,snapshot,calls}=setup({}, {mobile:true});await tick();const d=w.document;
 const model={id:'slider-model',displayName:'Slider model',description:'Do not show this description',defaultReasoningEffort:'high',supported_reasoning_efforts:['low','medium','high','xhigh','max','ultra']};
 w.mobileCodexEvent('state',{...snapshot,models:[model]});await tick();
 const slider=d.getElementById('effort-slider');
 assert.deepEqual([...d.getElementById('effort').options].map(option=>option.value),['low','medium','high','xhigh','max','ultra']);
 assert.equal(slider.max,'5');assert.equal(slider.disabled,false);
 const control=d.getElementById('reasoning-control');
 assert.equal(control.dataset.effort,'high');
 slider.value='0';slider.dispatchEvent(new w.Event('input'));await tick();
 assert.equal(control.dataset.effort,'low');
 slider.value='5';slider.dispatchEvent(new w.Event('input'));await tick();
 assert.equal(control.dataset.effort,'ultra');
 assert.equal(slider.getAttribute('aria-valuetext'),'ultra');
 assert.equal(d.querySelector('#effort-levels .selected').textContent,'ultra');
 assert.equal(d.getElementById('effort-heading').textContent,'ultra');
 slider.dispatchEvent(new w.Event('change'));await tick();
 assert.equal(d.getElementById('effort').value,'ultra');
 assert.equal(d.getElementById('effort-summary').textContent,'ultra');
 assert.equal(d.querySelector('#model-list small'),null);
 assert.doesNotMatch(d.getElementById('model-picker').textContent,/Do not show this description|试验|实验|全部 7|自动/);
 assert.equal(d.getElementById('effort-experimental'),null);
 assert.ok([...Array(w.localStorage.length)].map((_,i)=>w.localStorage.getItem(w.localStorage.key(i))).some(value=>value.includes('\"effort\":\"ultra\"')));
 w.mobileCodexEvent('state',{...snapshot,models:[{id:'custom'}]});await tick();
 d.getElementById('model').value='custom';d.getElementById('model').dispatchEvent(new w.Event('change'));await tick();
 assert.equal(slider.disabled,false);assert.equal(slider.max,'2');
 assert.deepEqual([...d.getElementById('effort').options].map(option=>option.value),['low','medium','high']);
 assert.equal(d.getElementById('effort').value,'medium');
 assert.equal(control.dataset.effort,'medium');
});

test('model refresh failure keeps the previous choices and explains their age',async()=>{
 const oldModels=[{id:'gpt-5.6-sol',displayName:'GPT-5.6-Sol'}];
 const {w,snapshot}=setup({'models.refresh':()=>{throw new Error('offline');}},{mobile:true});await tick();
 const d=w.document;w.mobileCodexEvent('state',{...snapshot,models:oldModels});
 d.getElementById('composer-options').click();await tick();
 assert.match(d.getElementById('model-list').textContent,/GPT-5.6-Sol/);
 assert.match(d.getElementById('model-refresh-status').textContent,/上次的列表/);
 assert.equal(d.getElementById('model-refresh-status').hidden,false);
});
test('back closes the actual top dialog, then the mobile drawer, then yields to Android',async()=>{
 const {w}=setup({}, {mobile:true});await tick();const d=w.document;
  d.getElementById('show-tools').click();await tick();d.getElementById('show-tools-panel').click();await tick();await tick();d.getElementById('marketplace-add').click();await tick();
 assert.equal(d.getElementById('input-dialog').open,true);assert.equal(w.mobileCodexBack(),true);
 assert.equal(d.getElementById('input-dialog').open,false);assert.equal(d.getElementById('tools-dialog').open,true);
 w.mobileCodexBack();d.querySelector('.topbar .sidebar-toggle').click();assert.equal(d.querySelector('main').inert,true);
 w.mobileCodexBack();assert.equal(d.querySelector('main').inert,false);assert.equal(w.mobileCodexBack(),false);
});
test('file management uses labelled actions and protects unsaved editor changes',async()=>{
 const {w,calls}=setup({'files.list':()=>({entries:[{name:'test.md',path:'test.md',size:3}]}),'files.read':()=>({path:'test.md',content:'old',sha256:'hash'})});await tick();const d=w.document;
 d.getElementById('files-toggle').click();await tick();d.querySelector('.file-entry .icon-button').click();await tick();
 assert.deepEqual([...d.querySelectorAll('#file-actions button')].map(b=>b.textContent),['重命名','移动','移除','选择其他应用打开']);
 d.querySelector('#file-actions button').click();await tick();d.getElementById('input-value').value='new.md';d.getElementById('input-confirm').click();await tick();await tick();
 assert.deepEqual(calls.find(c=>c.action==='files.mutate').args,{operation:'mobile_rename',arguments:{path:'test.md',name:'new.md'},workspaceKey:''});
 d.querySelector('.file-row').click();await tick();const editor=d.getElementById('editor');editor.value='unsaved';
 assert.equal(w.mobileCodexBack(),true);await answerConfirmation(d,false);
 assert.equal(d.getElementById('editor-dialog').open,true);assert.equal(editor.value,'unsaved');
 assert.equal(w.mobileCodexBack(),true);await answerConfirmation(d,true);
 assert.equal(d.getElementById('editor-dialog').open,false);assert.equal(editor.value,'old');
});
test('generated images appear, open full-screen, export and survive a snapshot refresh',async()=>{
 const {w,snapshot,calls}=setup();await tick();const d=w.document,id='a'.repeat(64),image={id,url:'/images/'+id,name:'robot.png',width:1024,height:1024};
 const message={id:'image-call',role:'assistant',text:'',imageStatus:'completed',images:[image]};
 w.mobileCodexEvent('state',{...snapshot,messages:[message]});assert.equal(d.querySelector('#messages img:not(.chat-character)').getAttribute('src'),image.url);
 d.querySelector('.image-open').click();await tick();assert.equal(d.getElementById('image-dialog').open,true);
 d.getElementById('image-save').click();await tick();assert.deepEqual(calls.find(c=>c.action==='images.export').args,{id,name:'robot.png'});
 w.mobileCodexEvent('state',{...snapshot,messages:[message]});assert.equal(d.querySelectorAll('#messages img:not(.chat-character)').length,1);
});
test('local Markdown images resolve via native, while arbitrary image URLs do not load',async()=>{
 const image={id:'b'.repeat(64),url:'/images/'+'b'.repeat(64),name:'local.png'};
 const {w,snapshot,calls}=setup({'images.read':()=>image});await tick();
 w.mobileCodexEvent('state',{...snapshot,messages:[{id:'a',role:'assistant',text:'- **결과** `test.md`\n\n![로봇](sandbox:/output/robot.png)\n\n![bad](https://evil.test/pixel)'}]});await tick();
 assert.equal(w.document.querySelectorAll('#messages img:not(.chat-character)').length,1);assert.equal(w.document.querySelector('#messages strong').textContent,'결과');
 assert.equal(w.document.querySelector('#messages code').textContent,'test.md');assert.equal(calls.filter(c=>c.action==='images.read').length,1);
 assert.equal(C.safeImageUrl('javascript:alert(1)'),false);assert.equal(C.safeImageUrl('/images/../../auth.json'),false);
});
test('image generation failures are visible instead of an empty successful message',async()=>{
 const {w,snapshot}=setup();await tick();
 w.mobileCodexEvent('state',{...snapshot,messages:[{id:'image',role:'assistant',text:'',imageStatus:'failed',imageError:'이미지 사용 한도를 확인해 주세요.',images:[]}]});
 assert.match(w.document.querySelector('.image-error').textContent,/한도/);assert.equal(w.document.querySelectorAll('#messages img:not(.chat-character)').length,0);
});

test('separate image tool results from one turn form a gallery with correct navigation and saving',async()=>{
 const {w,snapshot,calls}=setup();await tick();const d=w.document;
 const attachments=['a','b','c'].map((char,i)=>({id:char.repeat(64),url:'/images/'+char.repeat(64),name:'image-'+(i+1)+'.png'}));
 const messages=attachments.map((image,i)=>({id:'call-'+i,role:'assistant',kind:'image',imageGroup:'turn-one',text:'',images:[image],imageStatus:'completed'}));
 w.mobileCodexEvent('state',{...snapshot,messages});
 assert.equal(d.querySelectorAll('#messages .image-gallery').length,1);assert.equal(d.querySelectorAll('#messages .image-gallery img').length,3);
 d.querySelectorAll('#messages .image-open')[1].click();await tick();assert.equal(d.getElementById('image-counter').textContent,'2 / 3');
 d.getElementById('image-next').click();await tick();assert.equal(d.getElementById('image-counter').textContent,'3 / 3');assert.equal(d.getElementById('image-next').disabled,true);
 d.getElementById('image-save').click();await tick();assert.equal(calls.find(c=>c.action==='images.export').args.id,attachments[2].id);
 d.dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowLeft'}));assert.equal(d.getElementById('image-counter').textContent,'2 / 3');
 d.querySelector('.image-thumbnail').click();await tick();assert.equal(d.getElementById('image-counter').textContent,'1 / 3');assert.equal(d.getElementById('image-prev').disabled,true);
});
test('a gallery keeps partial successes, later images and failures without grouping other turns',async()=>{
 const image={id:'a'.repeat(64),url:'/images/'+'a'.repeat(64),name:'a.png'};
 const {w,snapshot}=setup();await tick();const d=w.document;
 const first={id:'a',role:'assistant',kind:'image',imageGroup:'one',images:[image],imageStatus:'completed'};
 const pending={id:'b',role:'assistant',kind:'image',imageGroup:'one',imageStatus:'generating'};
 w.mobileCodexEvent('state',{...snapshot,messages:[first,pending]});assert.match(d.querySelector('.image-placeholder').textContent,/正在生成图片/);
 d.querySelector('.image-open').click();await tick();
 const second={...pending,images:[{id:'b'.repeat(64),url:'/images/'+'b'.repeat(64),name:'b.png'}],imageStatus:'completed'};
 w.mobileCodexEvent('state',{...snapshot,messages:[first,second,{id:'c',role:'assistant',kind:'image',imageGroup:'two',images:[image],imageStatus:'completed'}]});
 assert.equal(d.getElementById('image-counter').textContent,'1 / 2');assert.equal(d.querySelectorAll('#messages .image-gallery').length,2);
 w.mobileCodexEvent('state',{...snapshot,messages:[first,{...pending,imageStatus:'failed',imageError:'두 번째 이미지 실패'}]});
 assert.equal(d.querySelectorAll('#messages img:not(.chat-character)').length,1);assert.match(d.querySelector('.image-error').textContent,/두 번째/);
});
test('a horizontal swipe changes images but zoomed panning does not',async()=>{
 const {w,snapshot}=setup();await tick();const d=w.document;
 const images=['a','b'].map(s=>({id:s.repeat(64),url:'/images/'+s.repeat(64),name:s+'.png'}));
 w.mobileCodexEvent('state',{...snapshot,messages:[{id:'images',role:'assistant',images}]});d.querySelector('.image-open').click();await tick();
 function swipe(){const start=new w.Event('touchstart');Object.defineProperty(start,'touches',{value:[{clientX:250,clientY:100}]});d.getElementById('image-stage').dispatchEvent(start);const end=new w.Event('touchend');Object.defineProperty(end,'changedTouches',{value:[{clientX:60,clientY:110}]});d.getElementById('image-stage').dispatchEvent(end);}
 swipe();assert.equal(d.getElementById('image-counter').textContent,'2 / 2');d.getElementById('image-prev').click();await tick();d.getElementById('image-zoom').click();await tick();swipe();assert.equal(d.getElementById('image-counter').textContent,'1 / 2');
});

test('project tree groups workspace history while general history stays separate',async()=>{
 const {w,calls,snapshot}=setup();await tick();
 w.mobileCodexEvent('state',{...snapshot,workspace:{selected:true,key:'p1',name:'Alpha'},projects:[{key:'p1',name:'Alpha',selected:true,available:true}],sessions:[{id:'a',title:'프로젝트 대화',workspaceKey:'p1'},{id:'g',title:'普通聊天'}]});
 const tree=w.document.querySelector('.project-tree');assert.match(tree.textContent,/프로젝트 대화/);assert.doesNotMatch(w.document.getElementById('sessions').textContent,/프로젝트 대화/);assert.match(w.document.getElementById('sessions').textContent,/普通聊天/);
 tree.querySelector('.tree-toggle').click();await tick();assert.equal(tree.classList.contains('collapsed'),true);
 w.document.getElementById('new-chat').click();await tick();assert.deepEqual(calls.find(c=>c.action==='chat.new').args,{workspaceKey:'',eventOnly:true});
});

test('general and workspace drafts keep attachments separately and picker receipts survive duplicate delivery',async()=>{
 const generalKey='draft:'+C.draftKey('', 't'), projectKey='draft:'+C.draftKey('p1','t');
 const {w,snapshot,calls}=setup({}, {drafts:{[generalKey]:'일반 초안',[generalKey+':context']:JSON.stringify({attachments:[{id:'g1',name:'general.txt'}],mentions:[],skills:[]}),[projectKey]:'프로젝트 초안'}});await tick();
 w.mobileCodexEvent('state',{...snapshot,workspace:{selected:false,key:'',name:'일반'},threadId:'t'});assert.equal(w.document.getElementById('prompt').value,'일반 초안');assert.match(w.document.getElementById('draft-context').textContent,/general.txt/);
 w.mobileCodexEvent('attachments.picked',{receiptId:'r1',draftKey:projectKey.slice(6),attachments:[{id:'p1',name:'project.txt'}],errors:[]});await tick();
 w.mobileCodexEvent('attachments.picked',{receiptId:'r1',draftKey:projectKey.slice(6),attachments:[{id:'p1',name:'project.txt'}],errors:[]});await tick();
 assert.match(w.localStorage.getItem(projectKey+':context'),/project.txt/);assert.equal(calls.filter(c=>c.action==='attachments.ack').length,1);
});

test('a removed project keeps its same-thread draft when the conversation becomes general',async()=>{
 const {w,snapshot}=setup({
  'files.list':()=>({entries:[{name:'old.md',path:'old.md'}]}),
  'files.mention':()=>({name:'old.md',path:'old.md'}),
  rpc:m=>m.args.method==='skills/list'?{data:[{skills:[{name:'review',path:'/skills/review'}]}]}:{data:[]},
 });await tick();const d=w.document,p=d.getElementById('prompt');
 const project={...snapshot,models:[fastModel],threadId:'moved',workspace:{selected:true,key:'gone',name:'Gone',available:true},projects:[{key:'gone',name:'Gone',available:true}]};
 w.mobileCodexEvent('state',project);await tick();
 w.mobileCodexEvent('attachments.picked',{receiptId:'gone-attachment',draftKey:C.draftKey('gone','moved'),attachments:[{id:'keep',name:'keep.txt'}],errors:[]});await tick();
 p.value='@';p.setSelectionRange(1,1);p.click();await tick();d.querySelector('.autocomplete-item').click();await tick();
 p.value='$re';p.setSelectionRange(p.value.length,p.value.length);p.click();await tick();d.querySelector('.autocomplete-item').click();await tick();
 p.value='keep this draft';p.dispatchEvent(new w.Event('input'));d.getElementById('effort').value='high';d.getElementById('effort').dispatchEvent(new w.Event('change'));await tick();
 const source='draft:'+C.draftKey('gone','moved'), target='draft:'+C.draftKey('','moved');
 w.mobileCodexEvent('state',{...project,workspace:{selected:false,key:'',projectId:'',name:'Codex',hasLocalFolder:true,available:true,defaultWorkspace:true},projects:[],sessions:[{id:'moved',title:'Moved chat'}]});await tick();
 assert.equal(p.value,'keep this draft');assert.equal(w.localStorage.getItem(source),'keep this draft');assert.equal(w.localStorage.getItem(target),'keep this draft');
 const oldContext=JSON.parse(w.localStorage.getItem(source+':context')), movedContext=JSON.parse(w.localStorage.getItem(target+':context'));
 assert.deepEqual(movedContext.attachments,[{id:'keep',name:'keep.txt'}]);assert.deepEqual(movedContext.skills,[{name:'review',path:'/skills/review'}]);assert.deepEqual(movedContext.mentions,[]);
 assert.deepEqual(oldContext.mentions,[{name:'old.md',path:'old.md'}]);assert.equal(JSON.parse(w.localStorage.getItem(target+':options')).model, 'fast-model');
 assert.match(d.getElementById('toast').textContent,/原草稿/);
});

test('picker cancellation and partial errors preserve the draft while accepted attachments are sent',async()=>{
 const {w,calls}=setup({'attachments.pick':()=>({cancelled:false,attachments:[{id:'a1',name:'ok.txt'}],errors:['bad.bin을 읽지 못했습니다.']})});await tick();const d=w.document;
 d.getElementById('add-attachment').click();d.getElementById('composer-attach').click();await tick();assert.match(d.getElementById('draft-context').textContent,/ok.txt/);
 d.getElementById('prompt').value='첨부 전송';d.getElementById('composer').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();
 assert.deepEqual(calls.find(c=>c.action==='chat.send').args.attachments,['a1']);
});

test('autocomplete resolves actual file and app mentions plus structured skills in send payload',async()=>{
 const {w,calls}=setup({'files.list':()=>({entries:[{name:'README.md',path:'README.md'}]}),'files.mention':()=>({name:'README.md',path:'README.md'}),'rpc':m=>m.args.method==='app/list'?{data:[{id:'calendar',name:'Calendar',isAccessible:true,isEnabled:true},{id:'off',name:'Off',isAccessible:false,isEnabled:true}]}:m.args.method==='skills/list'?{data:[{skills:[{name:'review',path:'/skills/review'},{name:'hidden',path:'/skills/hidden',enabled:false}]}]}:{}});await tick();const d=w.document,p=d.getElementById('prompt');
 p.value='@';p.selectionStart=p.selectionEnd=p.value.length;p.dispatchEvent(new w.Event('input'));await new Promise(r=>setTimeout(r,150));assert.match(d.getElementById('autocomplete').textContent,/README/);assert.match(d.getElementById('autocomplete').textContent,/Calendar/);assert.doesNotMatch(d.getElementById('autocomplete').textContent,/Off/);d.querySelector('.autocomplete-item').click();await tick();assert.equal(p.value,'@README.md ');
 p.value='$re';p.selectionStart=p.selectionEnd=p.value.length;p.dispatchEvent(new w.Event('input'));await new Promise(r=>setTimeout(r,150));assert.doesNotMatch(d.getElementById('autocomplete').textContent,/hidden/);d.querySelector('.autocomplete-item').click();await tick();assert.equal(p.value,'$review ');
 p.value='검토';d.getElementById('composer').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();const sent=calls.find(c=>c.action==='chat.send').args;
 assert.deepEqual(sent.mentions,[{name:'README.md',path:'README.md'}]);assert.deepEqual(sent.skills,[{name:'review',path:'/skills/review'}]);
});

test('clicking the prompt preserves file search text and opens the root for bare @',async()=>{
 const {w,calls}=setup({
  'files.search':()=>({entries:[{name:'README.md',path:'README.md'}]}),
  'files.list':()=>({entries:[{name:'src',path:'src',directory:true}]}),
 });await tick();const d=w.document,p=d.getElementById('prompt');
 p.value='@README';p.setSelectionRange(p.value.length,p.value.length);p.click();await tick();
 assert.deepEqual(calls.filter(c=>c.action==='files.search').map(c=>c.args),[{query:'README'}]);
 assert.equal(calls.some(c=>c.action==='files.list'),false);
 assert.match(d.getElementById('autocomplete').textContent,/README.md/);
 assert.equal(p.value,'@README');
 p.value='@';p.setSelectionRange(1,1);p.click();await tick();
 assert.deepEqual(calls.filter(c=>c.action==='files.list').map(c=>c.args),[{path:''}]);
 assert.match(d.getElementById('autocomplete').textContent,/src\//);
 assert.equal(calls.some(c=>c.action==='chat.send'),false);
});

test('clicking the prompt keeps the skill query filtered and selectable',async()=>{
 const {w,calls}=setup({rpc:m=>m.args.method==='skills/list'?{data:[{skills:[
  {name:'review',path:'/skills/review'},
  {name:'deploy',path:'/skills/deploy'},
  {name:'review-disabled',path:'/skills/disabled',enabled:false},
 ]}]}:{data:[]}});await tick();const d=w.document,p=d.getElementById('prompt');
 p.value='$re';p.setSelectionRange(p.value.length,p.value.length);p.click();await tick();
 const labels=[...d.querySelectorAll('.autocomplete-item strong')].map(el=>el.textContent);
 assert.ok(labels.includes('$review'));
 assert.equal(labels.includes('$deploy'),false);
 assert.equal(labels.includes('$review-disabled'),false);
 assert.equal(p.value,'$re');
 [...d.querySelectorAll('.autocomplete-item')].find(el=>el.querySelector('strong').textContent==='$review').click();await tick();
 assert.equal(p.value,'$review ');
 assert.equal(calls.some(c=>c.action==='files.list'||c.action==='chat.send'),false);
});

test('picker result lands in its original workspace draft after the user switches projects',async()=>{
 let finish;const {w,snapshot}=setup({'attachments.pick':()=>new Promise(resolve=>finish=resolve)});await tick();
 w.mobileCodexEvent('state',{...snapshot,workspace:{selected:true,key:'one',name:'One'},threadId:'t'});w.document.getElementById('add-attachment').click();w.document.getElementById('composer-attach').click();await tick();
 w.mobileCodexEvent('state',{...snapshot,workspace:{selected:true,key:'two',name:'Two'},threadId:'t'});finish({receiptId:'switch',draftKey:C.draftKey('one','t'),attachments:[{id:'one-file',name:'one.txt'}],errors:[]});await tick();
 assert.equal(w.document.getElementById('draft-context').hidden,true);assert.match(w.localStorage.getItem('draft:'+C.draftKey('one','t')+':context'),/one.txt/);
});

test('stale autocomplete results and delayed file mentions cannot leak into a switched workspace',async()=>{
 let resolveSearch,resolveMention;const {w,snapshot}=setup({'files.list':()=>new Promise(resolve=>resolveSearch=resolve),'rpc':()=>({data:[]}), 'files.mention':()=>new Promise(resolve=>resolveMention=resolve)});await tick();const p=w.document.getElementById('prompt');
 w.mobileCodexEvent('state',{...snapshot,workspace:{selected:true,key:'one',name:'One'},threadId:'t'});p.value='@';p.selectionStart=p.selectionEnd=1;p.dispatchEvent(new w.Event('input'));await new Promise(r=>setTimeout(r,140));
 w.mobileCodexEvent('state',{...snapshot,workspace:{selected:true,key:'two',name:'Two'},threadId:'t'});resolveSearch({entries:[{name:'one.md',path:'one.md'}]});await tick();assert.equal(w.document.getElementById('autocomplete').hidden,true);
 // A result already chosen before a switch must also be discarded when files.mention returns late.
 w.mobileCodexEvent('state',{...snapshot,workspace:{selected:true,key:'one',name:'One'},threadId:'t'});p.value='@';p.selectionStart=p.selectionEnd=1;p.dispatchEvent(new w.Event('input'));await new Promise(r=>setTimeout(r,140));
 resolveSearch({entries:[{name:'one.md',path:'one.md'}]});await tick();w.document.querySelector('.autocomplete-item').click();await tick();w.mobileCodexEvent('state',{...snapshot,workspace:{selected:true,key:'two',name:'Two'},threadId:'t'});resolveMention({name:'one.md',path:'one.md'});await tick();assert.equal(w.document.getElementById('draft-context').hidden,true);
});

test('a successful send preserves a newer draft and its attachment context',async()=>{
 let finish;const {w}=setup({'chat.send':()=>new Promise(resolve=>finish=resolve)});await tick();const d=w.document,p=d.getElementById('prompt');
 w.mobileCodexEvent('attachments.picked',{receiptId:'old',draftKey:C.draftKey('/test/project','t'),attachments:[{id:'old',name:'old.txt'}],errors:[]});await tick();p.value='first';p.dispatchEvent(new w.Event('input'));d.getElementById('composer').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();p.value='second';p.dispatchEvent(new w.Event('input'));finish({});await tick();
 assert.equal(p.value,'second');assert.match(d.getElementById('draft-context').textContent,/old.txt/);
});

test('permission radio values remain synchronized with the native permission command',async()=>{
 const {w,calls,snapshot}=setup({}, {mobile:true});await tick();w.mobileCodexEvent('state',{...snapshot,permissions:'read-only'});const d=w.document;
 assert.equal(d.querySelector('input[name=permission][value="read-only"]').checked,true);d.querySelector('input[name=permission][value="danger-full-access"]').click();await tick();
 assert.equal(d.getElementById('permissions').value,'danger-full-access');assert.deepEqual(calls.find(c=>c.action==='permissions.set').args,{mode:'danger-full-access'});
});

test('adding a project never rebinds the selected project while reconnect targets its stable key',async()=>{
 const {w,calls,snapshot}=setup();await tick();w.mobileCodexEvent('state',{...snapshot,workspace:{selected:true,key:'a',name:'A'},projects:[{key:'a',name:'A',selected:true,available:true},{key:'b',name:'B',available:false}]});const d=w.document;
 d.getElementById('add-project').click();await tick();
 const pick=d.querySelector('[data-project-folder-action="pick"]');assert.equal(pick.textContent,'Android 选择其他文件夹');
 pick.click();await tick();assert.deepEqual(calls.filter(c=>c.action==='files.pick').at(-1).args,{});
 [...d.querySelectorAll('.project-tree')].at(-1).querySelector('.new-thread').click();await tick();assert.deepEqual(calls.filter(c=>c.action==='files.pick').at(-1).args,{projectKey:'b'});
});

test('missing folder permission does not hide saved project conversations',async()=>{
 const {w,calls,snapshot}=setup();await tick();
 w.mobileCodexEvent('state',{...snapshot,ready:false,account:{},workspace:{selected:true,key:'lost',name:'Lost',available:false},projects:[{key:'lost',name:'Lost',available:false}],sessions:[{id:'saved',title:'권한 없어도 읽는 기록',workspaceKey:'lost'}]});
 const row=w.document.querySelector('.project-tree .session');assert.ok(row);row.click();await tick();
 assert.deepEqual(calls.find(c=>c.action==='chat.resume').args,{id:'saved',eventOnly:true});
 assert.equal(calls.some(c=>c.action==='runtime.start'||c.action==='auth.login'),false);
});

test('chat switching gives immediate feedback and reveals only the latest session and approval',async()=>{
 const requests=new Map();
 const {w,calls,snapshot}=setup({'chat.resume':call=>new Promise(resolve=>requests.set(call.args.id,resolve))},{mobile:true});await tick();
 const d=w.document,prompt=d.getElementById('prompt'),status=d.getElementById('chat-switch-status'),conversation=d.getElementById('conversation');
 const sessions=[{id:'t',title:'Current'},{id:'first',title:'First'},{id:'last',title:'Last'}];
 const chat=(id,text)=>({...snapshot,sessions,threadId:id,messages:[{id,role:'user',text}]});
 const row=id=>d.querySelector(`[data-session-id="${id}"] .session`);
 const sidebar=d.querySelector('.topbar .sidebar-toggle');
 const request=id=>w.mobileCodexEvent('server.request',{key:id,method:'item/commandExecution/requestApproval',params:{threadId:id,command:`For ${id}`}});
 w.mobileCodexEvent('state',chat('t','Current answer'));
 w.localStorage.setItem('draft:'+C.draftKey('/test/project','last'),'last draft');
 prompt.value='current draft';
 sidebar.click();row('t').click();
 assert.equal(d.body.classList.contains('sidebar-open'),false);
 assert.equal(calls.some(call=>call.action==='chat.resume'),false);
 sidebar.click();row('first').click();
 assert.equal(d.body.classList.contains('sidebar-open'),false);assert.equal(status.hidden,false);assert.equal(conversation.inert,true);
 d.getElementById('composer').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();
 assert.equal(calls.some(call=>call.action==='chat.send'),false);
 w.mobileCodexEvent('notification.open',{threadId:'last'});
 await tick();
 w.mobileCodexEvent('state',chat('first','Intermediate answer'));request('first');requests.get('first')({ok:true});await tick();
 assert.equal(status.hidden,false);assert.equal(conversation.inert,true);assert.equal(d.getElementById('request-dialog').open,false);
 request('last');w.mobileCodexEvent('state',chat('last','Final answer'));requests.get('last')({ok:true});await tick();
 assert.equal(status.hidden,true);assert.equal(conversation.inert,false);
 assert.doesNotMatch(d.getElementById('messages').textContent,/Intermediate answer/);
 assert.match(d.getElementById('messages').textContent,/Final answer/);
 assert.equal(prompt.value,'last draft');assert.equal(w.localStorage.getItem('draft:'+C.draftKey('/test/project','t')),'current draft');
 assert.match(d.getElementById('request-detail').textContent,/For last/);
});

test('a failed switch keeps the confirmed chat usable and can retry without a late error',async()=>{
 const requests=[];
 const {w,calls,snapshot}=setup({'chat.resume':call=>new Promise((resolve,reject)=>requests.push({id:call.args.id,resolve,reject}))});await tick();
 const d=w.document,status=d.getElementById('chat-switch-status'),prompt=d.getElementById('prompt');
 const sessions=[{id:'old',title:'Old selection'},{id:'new',title:'New selection'}];
 w.mobileCodexEvent('state',{...snapshot,sessions,messages:[{id:'keep',role:'user',text:'Keep current'}]});
 prompt.value='keep typing';
 const select=id=>d.querySelector(`[data-session-id="${id}"] .session`).click();
 select('old');select('new');select('new');await tick();
 assert.deepEqual(requests.map(request=>request.id),['old','new']);
 requests[0].reject(new Error('outdated error'));await tick();
 assert.equal(d.getElementById('toast').hidden,true);assert.equal(status.hidden,false);
 requests[1].reject(new Error('temporarily unavailable'));await tick();
 assert.equal(status.hidden,true);assert.equal(prompt.value,'keep typing');assert.equal(d.getElementById('send').disabled,false);
 assert.match(d.getElementById('messages').textContent,/Keep current/);
 assert.match(d.getElementById('toast').textContent,/temporarily unavailable/);
 select('new');await tick();assert.equal(calls.filter(call=>call.action==='chat.resume').length,3);
 w.mobileCodexEvent('state',{...snapshot,sessions,threadId:'new'});requests[2].resolve({ok:true});await tick();
 assert.equal(status.hidden,true);assert.equal(d.getElementById('header-title').textContent,'New selection');
});

test('attachments picked during send survive acknowledgement even when text is unchanged',async()=>{
 let finish;const {w}=setup({'chat.send':()=>new Promise(resolve=>finish=resolve)});await tick();const d=w.document;
 const receipt=(id)=>w.mobileCodexEvent('attachments.picked',{receiptId:id,draftKey:C.draftKey('/test/project','t'),attachments:[{id,name:id+'.txt'}],errors:[]});
 receipt('sent');await tick();d.getElementById('composer').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();
 receipt('new');await tick();finish({});await tick();
 assert.match(d.getElementById('draft-context').textContent,/new.txt/);assert.doesNotMatch(d.getElementById('draft-context').textContent,/sent.txt/);
});

test('accepted first send transfers model options into its new conversation scope',async()=>{
 let finish;const {w,snapshot}=setup({'chat.send':()=>new Promise(resolve=>finish=resolve)});await tick();const d=w.document;
 const models=[{id:'model-a',supportedReasoningEfforts:[{reasoningEffort:'high'}]}];
 w.mobileCodexEvent('state',{...snapshot,workspace:{key:'p',selected:true},threadId:'',models});
 d.getElementById('model').value='model-a';d.getElementById('model').dispatchEvent(new w.Event('change'));await tick();
 d.getElementById('effort').value='high';d.getElementById('effort').dispatchEvent(new w.Event('change'));await tick();
 d.getElementById('prompt').value='start';d.getElementById('composer').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();
 w.mobileCodexEvent('state',{...snapshot,workspace:{key:'p',selected:true},threadId:'created',models});finish({});await tick();
 assert.equal(d.getElementById('model').value,'model-a');assert.equal(d.getElementById('effort').value,'high');
 assert.match(w.localStorage.getItem('draft:'+C.draftKey('p','created')+':options'),/model-a/);
});


test('bare @ lists local files immediately while app discovery is pending and can browse folders',async()=>{
 const {w,calls}=setup({'files.list':m=>({entries:m.args.path==='src'?[{name:'Main.java',path:'src/Main.java'}]:[{name:'src',path:'src',directory:true},{name:'README.md',path:'README.md'}]}),'files.search':()=>{throw new Error('blank search must never run');},'rpc':()=>new Promise(()=>{})});await tick();
 const d=w.document,p=d.getElementById('prompt');p.value='@';p.dispatchEvent(new w.Event('input'));await tick();
 assert.equal(d.getElementById('autocomplete').hidden,false);assert.match(d.getElementById('autocomplete').textContent,/README.md/);assert.match(d.getElementById('autocomplete').textContent,/正在加载应用/);assert.equal(calls.some(c=>c.action==='files.search'),false);
 [...d.querySelectorAll('.autocomplete-item')].find(b=>b.textContent.includes('src/')).click();await tick();assert.match(d.getElementById('autocomplete').textContent,/Main.java/);assert.equal(calls.filter(c=>c.action==='files.list').at(-1).args.path,'src');
});
test('bare $ lists every enabled skill with descriptions and exposes empty or failed loading',async()=>{
 let response={data:[{skills:Array.from({length:16},(_,i)=>({name:'skill'+i,path:'/skills/'+i,description:'작업 '+i}))}]};
 const {w}=setup({'rpc':()=>{if(response instanceof Error)throw response;return response;}});await tick();const d=w.document,p=d.getElementById('prompt');
 const type=()=>{p.value='$';p.dispatchEvent(new w.Event('input'));};type();await tick();assert.match(d.getElementById('autocomplete').textContent,/skill15/);assert.match(d.getElementById('autocomplete').textContent,/작업 15/);
 response={data:[]};type();await tick();assert.equal(d.getElementById('autocomplete').hidden,false);assert.match(d.getElementById('autocomplete').textContent,/暂无可用技能/);assert.match(d.getElementById('autocomplete').textContent,/导入技能/);
 response=new Error('offline');type();await tick();assert.match(d.getElementById('autocomplete').textContent,/offline/);assert.match(d.getElementById('autocomplete').textContent,/重新加载/);
});
test('erasing trigger invalidates a late result and composition Enter does not choose a skill',async()=>{
 let finish;const {w}=setup({'rpc':()=>new Promise(resolve=>finish=resolve)});await tick();const d=w.document,p=d.getElementById('prompt');
 p.value='$';p.dispatchEvent(new w.Event('input'));await tick();p.value='plain';p.dispatchEvent(new w.Event('input'));finish({data:[{skills:[{name:'late',path:'/late'}]}]});await tick();assert.equal(d.getElementById('autocomplete').hidden,true);
 p.value='$';p.dispatchEvent(new w.Event('input'));await tick();finish({data:[{skills:[{name:'review',path:'/review'}]}]});await tick();p.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',isComposing:true,cancelable:true}));assert.equal(p.value,'$');
});
test('personal instructions load offline, retain failed saves and can be cleared',async()=>{
 let failed=true;const {w,calls}=setup({'instructions.read':()=>({content:'한국어로 답변',activePath:'/private/.codex/AGENTS.md'}),'instructions.save':()=>{if(failed)throw new Error('disk full');return {ok:true};}});await tick();const d=w.document;
 d.querySelector('[data-settings-tab="personal"]').click();await tick();assert.equal(d.getElementById('instructions-editor').value,'한국어로 답변');assert.match(d.getElementById('instructions-path').textContent,/\.codex\/AGENTS.md/);assert.equal(calls.some(c=>c.action==='runtime.start'),false);
 d.getElementById('instructions-editor').value='새 지침';d.getElementById('instructions-save').click();await tick();assert.equal(d.getElementById('instructions-editor').value,'새 지침');assert.match(d.getElementById('instructions-status').textContent,/disk full/);
 failed=false;d.getElementById('instructions-editor').value='';d.getElementById('instructions-save').click();await tick();assert.equal(calls.filter(c=>c.action==='instructions.save').at(-1).args.content,'');assert.match(d.getElementById('instructions-status').textContent,/已保存/);
});
test('personal instructions preserve unsaved edits on cancel and explain an active override',async()=>{
 const {w}=setup({'instructions.read':()=>({content:'override',activePath:'/private/.codex/AGENTS.override.md',notice:'AGENTS.override.md가 우선 적용됩니다.'})});await tick();const d=w.document;
 d.getElementById('settings').click();await tick();d.getElementById('settings-open-advanced').click();
 d.querySelector('[data-settings-tab="personal"]').click();await tick();assert.match(d.getElementById('instructions-status').textContent,/우선 적용/);
 const editor=d.getElementById('instructions-editor');editor.value='작성 중';
 d.querySelector('.dialog-head [data-close="settings-dialog"]').click();await answerConfirmation(d,false);
 assert.equal(d.getElementById('settings-dialog').open,true);assert.equal(editor.value,'작성 중');
});

test('clearing an override shows the newly effective base instructions without lying about disabling both',async()=>{
 const {w}=setup({'instructions.read':()=>({content:'override',path:'/home/.codex/AGENTS.override.md'}),'instructions.save':()=>({content:'base rules',activePath:'/home/.codex/AGENTS.md',notice:'AGENTS.md가 다시 활성화됩니다.'})});await tick();const d=w.document;
 d.querySelector('[data-settings-tab="personal"]').click();await tick();d.getElementById('instructions-editor').value='';d.getElementById('instructions-save').click();await tick();
 assert.equal(d.getElementById('instructions-editor').value,'base rules');assert.match(d.getElementById('instructions-path').textContent,/AGENTS.md$/);assert.match(d.getElementById('instructions-status').textContent,/다시 활성화/);
});


test('chat removes built-in illustrations and preserves generated images',async()=>{
 const {w,snapshot}=setup();await tick();const d=w.document;
 const state={...snapshot,messages:[{id:'u',role:'user',text:'生成图片'},{id:'a',role:'assistant',text:'[[icon:완료]]\n已生成',images:[{id:'a'.repeat(64),url:'/images/'+'a'.repeat(64),name:'result.png'}]}]};
 w.mobileCodexEvent('state',state);
 assert.equal(d.getElementById('chat-icons-toggle'),null);
 assert.equal(d.querySelectorAll('.chat-character').length,0);
 assert.equal(d.querySelectorAll('.image-gallery img').length,1);
 assert.doesNotMatch(d.getElementById('messages').textContent,/\[\[icon:/);
});
test('legacy character pack state does not restore settings or trigger any pack requests',async()=>{
 const {w,snapshot,calls}=setup();await tick();
 const characters={folderConfigured:true,selectedPackId:'custom',packs:[{id:'custom',name:'Custom',valid:true,icons:{done:'/packs/done.png'}}]};
 w.mobileCodexEvent('state',{...snapshot,characters,messages:[{id:'a',role:'assistant',text:'[[icon:완료]]\n완료했어요.'}]});
 w.document.getElementById('settings').click();await tick();
 assert.equal(w.document.querySelector('[id^="character-pack"], .chat-character'),null);
 assert.doesNotMatch(w.document.getElementById('messages').textContent,/\[\[icon:/);
 assert.equal(calls.some(call=>call.action.startsWith('characters.')),false);
});
test('live activity shows one line during a turn and keeps command details in the work log',async()=>{
 const {w,snapshot}=setup();await tick();const d=w.document;
 w.mobileCodexEvent('state',{...snapshot,busy:true,messages:[{id:'a',role:'assistant',text:'[[icon:설명]]\n설명할게요.'}]});
 assert.equal(d.getElementById('activity').hidden,false);
 assert.equal(d.querySelector('#activity-character img, #welcome-character img, .message .chat-character'),null);
 w.mobileCodexEvent('tool',{name:'mobile_read',path:'README.md'});
 assert.equal(d.getElementById('activity-text').textContent,'读取文件');
 const command='/bin/sh -lc '+ '/long/path/AGENTS.md '.repeat(12);
 const event={threadId:'t',method:'item/completed',params:{item:{id:'cmd',type:'commandExecution',command,aggregatedOutput:'<script>literal</script>',exitCode:1}}};
 w.mobileCodexEvent('agent.event',event);
 assert.match(d.getElementById('activity-text').textContent,/运行命令.*任务失败/);
 assert.doesNotMatch(d.getElementById('activity').textContent,/AGENTS/);
 assert.equal(d.querySelector('#chat-scroll details:not([hidden])'),null);
 d.getElementById('activity-details').click();await tick();
 assert.equal(d.getElementById('activity-dialog').open,true);
 const card=d.querySelector('#event-log details:last-child');
 assert.equal(card.querySelector('pre').textContent,command+'\n\n<script>literal</script>');
 assert.equal(card.querySelector('script'),null);
 const before=d.getElementById('activity-text').textContent;
 w.mobileCodexEvent('agent.event',{threadId:'other',method:'item/started',params:{item:{id:'private',type:'commandExecution',command:'other thread'}}});
 assert.equal(d.getElementById('activity-text').textContent,before);
 w.mobileCodexEvent('agent.event',{method:'item/reasoning/textDelta',params:{delta:'PRIVATE REASONING'}});
 assert.equal(d.getElementById('activity-text').textContent,'思考中');
 assert.doesNotMatch(d.getElementById('activity').textContent+d.getElementById('event-log').textContent,/PRIVATE REASONING/);
 w.mobileCodexEvent('message.delta',{id:'a',delta:' 이어서'});
 assert.equal(d.getElementById('activity-text').textContent,'正在回复');
 assert.equal(d.querySelectorAll('.message').length,1);
 w.mobileCodexEvent('state',{...snapshot,busy:false,messages:[{id:'a',role:'assistant',text:'[[icon:수정완료]]\n수정을 완료했어요.'}]});
 assert.equal(d.getElementById('activity').hidden,true);
 w.mobileCodexEvent('agent.event',event);
 assert.equal(d.getElementById('activity').hidden,true);
 assert.equal(d.getElementById('activity-text').textContent,'Codex 正在工作');
 assert.equal(d.querySelector('.message .chat-character'),null);
});
test('fresh activities batch live output into one scoped row without moving the reader',async()=>{
 const {w,snapshot,frames}=setup({}, {manualFrames:true,language:'zh-CN'});await tick();
 const d=w.document, area=d.getElementById('chat-scroll'), list=d.getElementById('task-activities');
 const flush=()=>{for(const callback of frames.splice(0))callback();};
 const live={...snapshot,liveTaskActivity:true,busy:true,turnId:'a',messages:historyMessages(1,12)};
 w.mobileCodexEvent('state',live);flush();
 Object.defineProperties(area,{scrollHeight:{value:4000},clientHeight:{value:500}});
 area.scrollTop=200;area.dispatchEvent(new w.Event('scroll'));
 const emit=(method,params,threadId='t',turnId='a')=>w.mobileCodexEvent('agent.event',{threadId,method,params:{threadId:'remote',turnId,...params}});
 const command={id:'c',type:'commandExecution',command:'cat README.md',commandActions:[{type:'read',path:'README.md'}]};
 emit('item/started',{item:command});
 emit('item/commandExecution/outputDelta',{itemId:'c',delta:'hello '});
 emit('item/commandExecution/outputDelta',{itemId:'c',delta:'world'});
 assert.equal(frames.length,1);assert.equal(list.children.length,0);
 flush();const row=list.firstElementChild;
 assert.equal(list.children.length,1);assert.match(row.querySelector('summary').textContent,/读取文件.*hello world/);
 assert.equal(row.querySelector('pre').textContent,'cat README.md\n\nhello world');
 assert.equal(area.scrollTop,200);
 d.getElementById('activity-details').click();await tick();assert.equal(row.open,true);
 w.mobileCodexEvent('server.request',{key:'req',method:'item/commandExecution/requestApproval',params:{threadId:'t',turnId:'a',itemId:'c',reason:'File access'}});
 flush();assert.equal(list.children.length,1);assert.match(row.querySelector('summary').textContent,/等待审批/);
 assert.match(row.querySelector('pre').textContent,/File access/);
 w.mobileCodexEvent('server.resolved',{key:'req'});flush();
 assert.match(row.querySelector('summary').textContent,/读取文件/);
 emit('item/commandExecution/outputDelta',{itemId:'c',delta:'x'.repeat(15000)+'END'});
 flush();assert.ok(row.querySelector('pre').textContent.length<=12030);assert.match(row.querySelector('pre').textContent,/…\nx+END$/);
 emit('item/completed',{item:{...command,aggregatedOutput:'<script>final</script>',status:'failed',exitCode:1}});
 emit('item/commandExecution/outputDelta',{itemId:'c',delta:'late delta'});
 emit('item/reasoning/textDelta',{itemId:'c',delta:'private reasoning'});
 flush();assert.equal(list.firstElementChild,row);assert.equal(row.open,true);
 assert.match(row.querySelector('summary').textContent,/任务失败/);assert.equal(row.querySelector('script'),null);
 assert.equal(row.querySelector('pre').textContent,'cat README.md\n\n<script>final</script>');
 emit('item/fileChange/outputDelta',{itemId:'file',delta:'pending old frame'});
 w.mobileCodexEvent('state',{...live,threadId:'other',turnId:'b'});
 emit('item/commandExecution/outputDelta',{itemId:'c',delta:'wrong thread'});
 emit('item/commandExecution/outputDelta',{itemId:'c',delta:'wrong turn'},'other','a');
 emit('item/fileChange/outputDelta',{itemId:'c',delta:'new turn only'},'other','b');
 flush();assert.equal(list.children.length,1);assert.match(list.textContent,/修改文件.*new turn only/);
 assert.doesNotMatch(list.textContent,/wrong|pending old|private reasoning|final/);
 w.mobileCodexEvent('state',{...live,threadId:'other',turnId:'',busy:false});flush();
 assert.equal(list.children.length,0);assert.equal(d.getElementById('activity').hidden,true);
});


test('legacy assistant icon tags disappear without adding illustrations',async()=>{
 const {w,snapshot}=setup();await tick();const d=w.document;
 w.mobileCodexEvent('state',{...snapshot,messages:[{id:'plain',role:'assistant',text:'현재 8장이 생성됐고 7장이 저장됐습니다.'},
  {id:'marked',role:'assistant',text:'[[icon:작업중]]\n진행하고 있어요.\n\n[[icon:완료]]'}]});
 assert.equal(d.querySelector('[data-id="plain"] .chat-character'),null);
 const marked=d.querySelector('[data-id="marked"]');
 assert.equal(marked.querySelectorAll('.chat-character').length,0);
 assert.doesNotMatch(marked.textContent,/\[\[icon:/);
});

test('hides streamed, unknown and previous assistant tags without altering user or code text',async()=>{
 const {w,snapshot}=setup();await tick();const d=w.document;
 w.mobileCodexEvent('state',{...snapshot,busy:true,messages:[{id:'u',role:'user',text:'[[icon:완료]]'},
  {id:'a',role:'assistant',text:'[[icon:없는태그]]\n\n`[[icon:완료]]`\n\n[[icon:'}]});
 let answer=d.querySelector('[data-id="a"]');assert.equal(answer.querySelectorAll('.chat-character').length,0);
 assert.equal(answer.querySelector('code').textContent,'[[icon:완료]]');
 assert.doesNotMatch(answer.textContent.replace(answer.querySelector('code').textContent,''),/\[\[icon:/);
 assert.match(d.querySelector('[data-id="u"]').textContent,/\[\[icon:완료\]\]/);
 w.mobileCodexEvent('message.delta',{id:'a',delta:'작업중]'});answer=d.querySelector('[data-id="a"]');
 assert.doesNotMatch(answer.textContent.replace(answer.querySelector('code').textContent,''),/\[\[icon:/);
 w.mobileCodexEvent('message.delta',{id:'a',delta:']'});answer=d.querySelector('[data-id="a"]');
 assert.equal(answer.querySelectorAll('.chat-character').length,0);
 assert.doesNotMatch(answer.textContent.replace(answer.querySelector('code').textContent,''),/\[\[icon:/);
});


test('a partial tag stays hidden when another participant becomes the last message',async()=>{
 const {w,snapshot}=setup({}, {drafts:{'chat-icons':'off'}});await tick();const d=w.document;
 w.mobileCodexEvent('state',{...snapshot,busy:true,messages:[{id:'a',role:'assistant',text:'진행 중\n\n[[icon:작업중]'},
  {id:'b',role:'assistant',agent:'claude',text:'응답'}]});
 assert.doesNotMatch(d.querySelector('[data-id="a"]').textContent,/\[\[icon:/);
});

test('copy buttons target each code block or a user message, never the whole assistant reply',async()=>{
 const {w,snapshot}=setup();await tick();const d=w.document;
 w.mobileCodexEvent('state',{...snapshot,messages:[{id:'u1',role:'user',text:'Question'},{id:'m1',role:'assistant',text:'```python\nprint("hello")\n```'}]});
 const card=d.querySelector('.code-card');assert.ok(card);
 const lang=card.querySelector('.code-lang');assert.equal(lang.textContent,'python');
 const pre=card.querySelector('pre code');assert.match(pre.textContent,/print\("hello"\)/);
 assert.equal(d.querySelector('.assistant .msg-copy-btn'),null);
 assert.equal(card.querySelector('.code-copy-btn')?.textContent,'复制');
 const msgCopy=d.querySelector('.msg-copy-btn');assert.ok(msgCopy);
 assert.equal(msgCopy.previousElementSibling,d.querySelector('.user-bubble'));
 assert.equal(msgCopy.previousElementSibling.textContent,'Question');
 msgCopy.click();await tick();
 assert.match(msgCopy.textContent,/已复制/);
});

test('markdown tables render as scrollable table elements',async()=>{
 const {w,snapshot}=setup();await tick();const d=w.document;
 const tableMarkdown='| 제목 | 내용 |\n| --- | --- |\n| 1열 | 값1 |\n| 2열 | 값2 |';
 w.mobileCodexEvent('state',{...snapshot,messages:[{id:'t1',role:'assistant',text:tableMarkdown}]});
 const wrap=d.querySelector('.table-wrap');assert.ok(wrap);
 const table=wrap.querySelector('table.markdown-table');assert.ok(table);
 const headers=[...table.querySelectorAll('th')].map(th=>th.textContent);
 assert.deepEqual(headers,['제목','내용']);
 const cells=[...table.querySelectorAll('td')].map(td=>td.textContent);
 assert.deepEqual(cells,['1열','값1','2열','값2']);
});

test('mobile session cards keep history open for renaming, cancelling and consecutive deletions by ID',async()=>{
 const sessions=[{id:'one',title:'Same'},{id:'two',title:'Same'},{id:'three',title:'Other'}];
 const projects=[{key:'other',name:'Other project'}];
 const {w,calls,snapshot}=setup({
  'chat.rename':({args})=>{sessions.find(s=>s.id===args.id).title=args.title;update();return {};},
  'chat.delete':({args})=>{sessions.splice(sessions.findIndex(s=>s.id===args.id),1);update();return {};}
 },{mobile:true});
 const update=()=>w.mobileCodexEvent('state',{...snapshot,sessions:[...sessions],projects});
 await tick();update();const d=w.document;
 const more=id=>d.querySelector(`[data-session-id="${id}"] .session-more`);
 const card=()=>d.querySelector('.session-card');
 const action=async(label)=>{[...card().querySelectorAll('button')].find(b=>b.textContent===label).click();await tick();};
 d.querySelector('main .sidebar-toggle').click();
 d.querySelector('.tree-toggle').click();await tick();
 const scroller=d.querySelector('.sidebar-scroll');scroller.scrollTop=120;
 more('two').click();await tick();
 assert.equal(card().parentElement.dataset.sessionId,'two');
 await action('删除对话');assert.equal(calls.some(c=>c.action==='chat.delete'),false);
 assert.equal(w.mobileCodexBack(),true);assert.equal(card(),null);
 assert.equal(d.body.classList.contains('sidebar-open'),true);assert.equal(d.activeElement,more('two'));
 more('one').click();await tick();await action('重命名');
 const field=card().querySelector('input');field.value='Changed';
 sessions[2].busy=true;update();assert.equal(card().querySelector('input'),field);assert.equal(field.value,'Changed');
 await action('保存');assert.deepEqual(calls.find(c=>c.action==='chat.rename').args,{id:'one',title:'Changed'});
 for(const id of ['two','one']) {
  more(id).click();await tick();await action('删除对话');await action('删除对话');
  assert.equal(d.body.classList.contains('sidebar-open'),true);assert.equal(scroller.scrollTop,120);
  assert.equal(d.querySelector('.tree-toggle').getAttribute('aria-expanded'),'false');assert.equal(card(),null);
 }
 assert.deepEqual(calls.filter(c=>c.action==='chat.delete').map(c=>c.args.id),['two','one']);
 assert.equal(calls.some(c=>c.action==='chat.resume'),false);
});

test('cancelling a refreshed delete card returns to the last intentional scroll position',async()=>{
 const {w,snapshot}=setup({}, {mobile:true});await tick();
 const d=w.document, scroller=d.querySelector('.sidebar-scroll');
 const update=title=>w.mobileCodexEvent('state',{...snapshot,sessions:[{id:'target',title}]});
 update('Target');d.querySelector('main .sidebar-toggle').click();
 w.HTMLElement.prototype.scrollIntoView=function(){if(this.matches('.session-card'))scroller.scrollTop+=45;};
 scroller.scrollTop=100;d.querySelector('.session-more').click();await tick();
 assert.equal(scroller.scrollTop,145);
 scroller.scrollTop=170;update('Renamed');assert.equal(scroller.scrollTop,170);
 d.querySelector('[data-session-delete]').click();await tick();assert.equal(scroller.scrollTop,215);
 assert.equal(w.mobileCodexBack(),true);assert.equal(scroller.scrollTop,170);
});

test('delete card follows busy changes, keeps failed deletion retryable, and guards duplicate submissions',async()=>{
 let rejectDelete;const {w,snapshot,calls}=setup({'chat.delete':()=>new Promise((resolve,reject)=>{rejectDelete=reject;})},{mobile:true});
 await tick();const d=w.document;
 const update=busy=>w.mobileCodexEvent('state',{...snapshot,threadId:'target',busy,sessions:[{id:'target',title:'Target'}]});
 update(false);d.querySelector('main .sidebar-toggle').click();d.querySelector('.session-more').click();await tick();
 const remove=()=>d.querySelector('[data-session-delete]');update(true);assert.equal(remove().disabled,true);
 update(false);remove().click();await tick();update(true);assert.equal(remove().disabled,true);
 update(false);remove().click();remove().click();await tick();assert.equal(remove().disabled,true);
 rejectDelete(Error('Deletion failed'));await tick();assert.equal(remove().disabled,false);
 assert.equal(d.querySelector('#toast').textContent,'Deletion failed');assert.ok(d.body.classList.contains('sidebar-open'));
 assert.equal(calls.filter(c=>c.action==='chat.delete').length,1);
 d.querySelector('.session-card button').click();await tick();assert.equal(remove(),null);
});

test('table escaped pipes preserve header and body cells including inline code',async()=>{
 const {w,snapshot}=setup();await tick();
 const text=String.raw`| a\|b | Meaning |
| --- | --- |
| x\|y | either value |
| \`a\|b\` | code expression |
| C:\\ | trailing slash |`.replaceAll('\\`','`');
 w.mobileCodexEvent('state',{...snapshot,messages:[{id:'table',role:'assistant',text}]});
 const d=w.document;
 assert.deepEqual([...d.querySelectorAll('th')].map(n=>n.textContent),['a|b','Meaning']);
 assert.deepEqual([...d.querySelectorAll('td')].map(n=>n.textContent),['x|y','either value','a|b','code expression','C:\\','trailing slash']);
 assert.equal(d.querySelector('td code').textContent,'a|b');
});

test('clipboard denial falls back to native and only confirms successful copying',async()=>{
 let fail=false;
 const {w,calls,snapshot}=setup({'ui.copyCode':()=>{if(fail)throw new Error('Clipboard unavailable');return {ok:true};}});await tick();
 Object.defineProperty(w.navigator,'clipboard',{value:{writeText:async()=>{throw new w.DOMException('Denied','NotAllowedError');}}});
 w.mobileCodexEvent('state',{...snapshot,messages:[{id:'copy',role:'user',text:'const x = 1;\n'},{id:'again',role:'user',text:'next'}]});
 const d=w.document;
 d.querySelector('.msg-copy-btn').click();await tick();
 assert.deepEqual(calls.filter(c=>c.action==='ui.copyCode').at(-1).args,{code:'const x = 1;\n'});
 assert.match(d.querySelector('.msg-copy-btn').textContent,/已复制/);
 const second=d.querySelector('[data-id="again"] .msg-copy-btn');fail=true;second.click();await tick();
 assert.doesNotMatch(second.textContent,/已复制/);
 assert.match(d.getElementById('toast').textContent,/无法复制/);
});

test('file panel and tools settings keep normal storage controls without Root file access',async()=>{
 const {w}=setup();await tick();
 const d=w.document;
 assert.ok(d.querySelector('#file-panel .file-search'));
 assert.ok(d.querySelector('[data-settings-panel="tools"] #storage-access'));
 assert.equal(d.querySelector('#root-files-settings'),null);
 assert.equal(d.querySelector('#root-files-panel'),null);
});

test('switching chats in one workspace reuses sidebar rows and moves the selected state',async()=>{
 const {w,snapshot}=setup();await tick();
 const d=w.document,sessions=[{id:'t',title:'First',workspaceKey:'project'},{id:'next',title:'Second',workspaceKey:'project',approvalPending:true}];
 const projects=[{key:'project',name:'Project',selected:true,available:true}];
 const before={...snapshot,sessions,projects,workspace:{selected:true,key:'project',name:'Project'}};
 w.mobileCodexEvent('state',before);
 const first=d.querySelector('[data-session-id="t"]'),second=d.querySelector('[data-session-id="next"]');
 assert.equal(first.querySelector('.session').getAttribute('aria-current'),'true');
 w.mobileCodexEvent('state',{...before,threadId:'next',messages:[{id:'reply',role:'assistant',text:'Second chat'}]});
 assert.equal(d.querySelector('[data-session-id="t"]'),first);
 assert.equal(d.querySelector('[data-session-id="next"]'),second);
 assert.equal(first.classList.contains('active'),false);
 assert.equal(first.querySelector('.session').hasAttribute('aria-current'),false);
 assert.equal(second.classList.contains('active'),true);
 assert.equal(second.querySelector('.session').getAttribute('aria-current'),'true');
 assert.ok(second.querySelector('.session-approval-indicator'));
 assert.match(d.getElementById('messages').textContent,/Second chat/);
});

test('message HTTP and HTTPS links use the dedicated browser route, unsafe schemes stay text',async()=>{
 const {w,calls,snapshot}=setup();await tick();
 w.mobileCodexEvent('state',{...snapshot,messages:[{id:'link',role:'assistant',text:'[HTTP](http://example.com) [HTTPS](https://example.com) [bad](javascript:alert)'}]});
 const links=w.document.querySelectorAll('.inline-link');assert.equal(links.length,2);
 links[0].click();await tick();links[1].click();await tick();
 assert.deepEqual(calls.filter(c=>c.action==='ui.openLink').map(c=>c.args.url),['http://example.com','https://example.com']);
 assert.equal(calls.some(c=>c.action==='ui.externalBrowser'),false);
});

test('offline deletion is reported as pending instead of claiming the original is deleted',async()=>{
 const {w,snapshot}=setup({'chat.delete':()=>({deletionPending:true})});await tick();const d=w.document;
 w.mobileCodexEvent('state',{...snapshot,sessions:[{id:'s',title:'Offline'}]});
 d.querySelector('.session-more').click();await tick();
 d.querySelector('[data-session-delete]').click();await tick();
 d.querySelector('[data-session-delete]').click();await tick();
 assert.match(d.getElementById('toast').textContent,/删除请求已保存/);
 assert.match(d.getElementById('toast').textContent,/连接后将删除原始记录/);
 w.mobileCodexEvent('state',{...snapshot,sessions:[],pendingDeletionCount:1});
 assert.equal(d.getElementById('pending-deletions').hidden,false);
 assert.match(d.getElementById('pending-deletions').textContent,/1 条原始聊天等待删除/);
 w.mobileCodexEvent('state',{...snapshot,sessions:[],pendingDeletionCount:0});
 assert.equal(d.getElementById('pending-deletions').hidden,true);
});

test('development tools use an honest old-backend fallback and retain the project terminal cwd',async()=>{
 const {w}=setup();await tick();const d=w.document;
 d.querySelector('[data-settings-tab="tools"]').click();await tick();
 assert.match(d.getElementById('devtools-status').textContent,/未提供开发工具信息/);
 assert.match(d.getElementById('terminal-cwd').textContent,/\/test\/project/);
 assert.match(d.getElementById('terminal-tools-note').textContent,/设置 > 工具/);
});

test('development tool check shows checked versions and HTML-looking command output as text',async()=>{
 const devtools={bundled:true,prepared:true,tools:[{name:'Python',version:'3.13.1'},{name:'Node.js',version:'22.0.0'},{name:'Git',version:'2.47.0'},{name:'npm',version:'10.9.0'},{name:'pip',version:'24.3'}]};
 const {w,calls,snapshot}=setup({'state':()=>({...snapshot,devtools}),'devtools.check':()=>({ok:true,checks:[{name:'Python',ok:true,output:'Python 3.13.1 <img src=x onerror=alert(1)>'}]})});await tick();const d=w.document;
 d.querySelector('[data-settings-tab="tools"]').click();await tick();assert.match(d.getElementById('devtools-versions').textContent,/Node.js 22.0.0/);
 assert.match(d.getElementById('terminal-tools-note').textContent,/Python · Node.js · Git · npm · pip/);
 d.getElementById('devtools-check').click();await tick();
 assert.equal(calls.filter(c=>c.action==='devtools.check').length,1);assert.match(d.getElementById('devtools-status').textContent,/完成/);
 assert.match(d.getElementById('devtools-output').textContent,/<img src=x/);assert.equal(d.getElementById('devtools-output').querySelector('img'),null);
});

test('development tool partial failures and rejected checks keep output and allow retry',async()=>{
 let attempt=0;const devtools={bundled:true,prepared:false,tools:[{name:'Python',version:'확인 전'}]};
 const {w,snapshot}=setup({'state':()=>({...snapshot,devtools}),'devtools.check':()=>{attempt++;if(attempt===1)return {ok:false,checks:[{name:'Python',ok:true,output:'Python 3.13'},{name:'Git',ok:false,output:'not found'}]};if(attempt===2)throw new Error('runtime unavailable');return {ok:true,checks:[{name:'Git',ok:true,output:'git version'}]};}});await tick();const d=w.document;
 d.getElementById('devtools-check').click();await tick();assert.match(d.getElementById('devtools-status').textContent,/部分工具/);assert.match(d.getElementById('devtools-output').textContent,/✕ Git/);
 d.getElementById('devtools-check').click();await tick();assert.match(d.getElementById('devtools-status').textContent,/失败/);assert.match(d.getElementById('devtools-output').textContent,/runtime unavailable/);assert.equal(d.getElementById('devtools-check').disabled,false);
 d.getElementById('devtools-check').click();await tick();assert.match(d.getElementById('devtools-status').textContent,/完成/);assert.match(d.getElementById('devtools-output').textContent,/✓ Git/);
});

test('general Codex workspace uses its default folder and orphan conversations fall back to general chat',async()=>{
 const {w,calls,snapshot}=setup({'projects.remove':()=>({...snapshot,workspace:{selected:false},projects:[]})});await tick();const d=w.document;
 const project={key:'kept',name:'Keep this project',selected:false,available:false,hasLocalFolder:true};
 w.mobileCodexEvent('state',{...snapshot,workspace:{selected:false,key:'',projectId:'',name:'Codex',hasLocalFolder:true,available:true,defaultWorkspace:true},projects:[project],sessions:[{id:'old',title:'보존 대화',workspaceKey:'gone'}]});
 assert.equal(d.getElementById('project-label').textContent,'Codex');assert.equal(d.getElementById('header-project').textContent,'普通聊天');
 assert.equal(d.querySelectorAll('.detached-projects').length,0);assert.equal(d.querySelectorAll('#projects .session').length,0);assert.equal(d.querySelectorAll('#sessions .session').length,1);
 assert.equal(d.querySelector('#projects .new-thread').textContent,'重新关联文件夹');
 d.getElementById('files-toggle').click();await tick();assert.equal(calls.some(c=>c.action==='files.list'),true);
  const menu=d.querySelector('.project-more');assert.ok(menu);menu.click();await tick();
 [...d.querySelectorAll('#project-actions button')].find(b=>b.textContent==='从项目列表中移除').click();await tick();
 const confirmation=d.querySelector('#project-remove-card p').textContent;assert.match(confirmation,/对话将移至普通对话/);assert.match(confirmation,/文件保持不变/);
 d.querySelector('#project-remove-card .danger').click();await tick();assert.deepEqual(calls.filter(c=>c.action==='projects.remove').at(-1).args,{key:'kept'});
 d.querySelector('#sessions .session').click();await tick();assert.deepEqual(calls.filter(c=>c.action==='chat.resume').at(-1).args,{id:'old',eventOnly:true});
 });
test('project import and rebinding stay disabled through a busy refresh and an import picker response',async()=>{
 let finishImport;
 const {w,calls,snapshot}=setup({'ui.projects.importFile':()=>new Promise(resolve=>{finishImport=resolve;})});await tick();const d=w.document;
 const project={key:'a',projectId:'pa',name:'A',available:false,hasLocalFolder:false,bindings:[{key:'a',name:'A'}]};
 const other={id:'other',title:'Other',workspaceKey:'',busy:false}, idle={...snapshot,projects:[project],sessions:[other]};
 w.mobileCodexEvent('state',idle);
 const add=d.getElementById('add-project');add.click();await tick();
 const choices=[...d.querySelectorAll('#project-link-choices button')], importButton=d.querySelector('[data-project-folder-action="import"]');
 assert.equal(choices.length,4);assert.ok(choices.every(button=>!button.disabled));
 importButton.click();await tick();assert.ok(choices.every(button=>button.disabled));
 w.mobileCodexEvent('state',{...idle,busy:true});
 finishImport({content:'picked while idle'});await tick();
 assert.ok(importButton.disabled);assert.ok(choices.filter(button=>button!==importButton).every(button=>!button.disabled));
 assert.equal(add.disabled,false);assert.equal(d.querySelector('.project-more').disabled,false);assert.equal(d.querySelector('.project-new').disabled,true);
 importButton.click();d.querySelector('#projects .new-thread').click();await tick();
 assert.deepEqual(calls.filter(call=>/^ui\.projects\.import|^projects\.import|^files\.pick/.test(call.action)).map(call=>call.action),['ui.projects.importFile']);
 w.mobileCodexEvent('state',{...idle,sessions:[{...other,busy:true}]});
 assert.ok(importButton.disabled);assert.equal(d.querySelector('#projects .new-thread').disabled,true);
 w.mobileCodexEvent('state',idle);
 assert.equal(importButton.disabled,false);assert.equal(d.querySelector('#projects .new-thread').disabled,false);
});
test('project add browses the workspace and only adds projects while the current conversation is running',async()=>{
 let working;
 const active={key:'active',selected:true,available:true,name:'Active project'};
 const added=name=>{
  const workspace={key:name,name,available:true};
  working={...working,projects:[...working.projects,workspace]};w.mobileCodexEvent('state',working);
  return {workspace};
 };
 const {w,calls,snapshot}=setup({
  'projects.workspaceFolders':({args:{path}})=>({
   ...workspaceRoot,path,parent:path==='Work/Nested'?'Work':path?'':null,
   entries:path==='Work/Nested'?[]:path?[{name:'<Nested>',path:'Work/Nested'}]:[{name:'Work',path:'Work'}]
  }),
  'projects.bindWorkspaceFolder':()=>added('Nested'),
  'projects.createWorkspaceFolder':({args})=>added(args.name),
  'projects.create':({args})=>added(args.name),
  'files.pick':()=>added('External')
 });await tick();
 working={...snapshot,workspace:active,projects:[active],sessions:[{id:snapshot.threadId,title:'Running chat',workspaceKey:'active',busy:true}],busy:true,turnId:'working',messages:[{id:'answer',role:'assistant',text:'Streaming answer'}]};
 w.mobileCodexEvent('state',working);
 const d=w.document,dialog=d.getElementById('project-link-dialog'),prompt=d.getElementById('prompt');
 prompt.value='Unsent draft';prompt.dispatchEvent(new w.Event('input'));
 const action=name=>dialog.querySelector(`[data-project-folder-action="${name}"]`);
 const open=async()=>{d.getElementById('add-project').click();await tick();};
 const enter=async path=>{dialog.querySelector(`[data-workspace-folder="${path}"]`).click();await tick();};
 const submit=async name=>{d.getElementById('input-value').value=name;d.getElementById('input-confirm').click();await tick();};
 await open();assert.equal(d.getElementById('project-link-description').textContent,'大肥龙');assert.equal(action('bind'),null);
 assert.ok(action('import').disabled);
 await enter('Work');assert.equal(dialog.querySelector('[data-workspace-folder="Work/Nested"]').textContent,'<Nested>');assert.equal(dialog.querySelector('nested'),null);
 await enter('Work/Nested');assert.equal(d.getElementById('project-link-description').textContent,'大肥龙 / Work / Nested');
 action('up').click();await tick();action('up').click();await tick();assert.equal(action('bind'),null);
 await enter('Work');await enter('Work/Nested');action('bind').click();await tick();assert.equal(dialog.open,false);
 await open();await enter('Work');action('create').click();await tick();
 d.getElementById('input-dialog').close();await tick();assert.equal(dialog.open,true);assert.equal(d.activeElement,action('create'));
 action('create').click();await tick();await submit(' New folder ');assert.equal(dialog.open,false);
 await open();action('metadata').click();await tick();await submit('Metadata');assert.equal(dialog.open,false);
 await open();action('pick').click();await tick();assert.equal(dialog.open,false);
 assert.deepEqual(calls.filter(call=>['projects.bindWorkspaceFolder','projects.createWorkspaceFolder','projects.create','files.pick'].includes(call.action)).map(call=>[call.action,call.args]),[
  ['projects.bindWorkspaceFolder',{path:'Work/Nested'}],['projects.createWorkspaceFolder',{path:'Work',name:'New folder'}],['projects.create',{name:'Metadata'}],['files.pick',{}]
 ]);
 assert.match(d.getElementById('projects').textContent,/Nested.*New folder.*Metadata.*External/);
 assert.equal(d.getElementById('header-title').textContent,'Running chat');assert.equal(d.getElementById('header-project-label').textContent,'Active project');
 assert.equal(d.getElementById('activity').hidden,false);assert.equal(prompt.value,'Unsent draft');
 assert.equal(calls.some(call=>call.action==='projects.select'||call.action.startsWith('chat.')),false);
});
test('dismissing a pending workspace listing does not affect a reopened project picker',async()=>{
 let finishFirst, attempt=0;
 const {w}=setup({'projects.workspaceFolders':()=>++attempt===1?new Promise(resolve=>{finishFirst=resolve;}):{...workspaceRoot,entries:[{name:'Current',path:'Current'}]}});
 await tick();const d=w.document,dialog=d.getElementById('project-link-dialog'),add=d.getElementById('add-project');
 add.click();await tick();dialog.close();add.click();await tick();
 finishFirst({...workspaceRoot,entries:[{name:'Stale',path:'Stale'}]});await tick();
 assert.ok(dialog.open);assert.ok(dialog.querySelector('[data-workspace-folder="Current"]'));assert.equal(dialog.querySelector('[data-workspace-folder="Stale"]'),null);
});
test('adding an external folder without switching conversations keeps the file directory and filter',async()=>{
 let finishPick;
 const {w,calls,snapshot}=setup({
  'files.list':({args:{path}})=>({entries:path?[]:[{name:'src',path:'src',directory:true}]}),
  'files.search':()=>({entries:[{name:'Report.md',path:'src/Report.md'}]}),
  'files.pick':()=>new Promise(resolve=>{finishPick=resolve;})
 });await tick();const d=w.document,query=d.getElementById('file-query');
 const current={...snapshot,workspace:{...snapshot.workspace,key:'current'}};
 const busy={...current,busy:true,turnId:'active'};
 w.mobileCodexEvent('state',current);
 d.getElementById('files-toggle').click();await tick();d.querySelector('#file-list .file-row').click();await tick();
 assert.equal(d.getElementById('breadcrumbs').textContent,'Project / src');
 query.value='report';query.dispatchEvent(new w.Event('input'));await new Promise(resolve=>setTimeout(resolve,340));
 assert.match(d.getElementById('file-list').textContent,/Report\.md/);
 const listCount=calls.filter(call=>call.action==='files.list').length;
 for(const startedBusy of [false,true]) {
  if(startedBusy)w.mobileCodexEvent('state',busy);
  d.getElementById('add-project').click();await tick();d.querySelector('[data-project-folder-action="pick"]').click();await tick();
  if(!startedBusy)w.mobileCodexEvent('state',busy);
  w.mobileCodexEvent('state',current);
  finishPick(startedBusy?{}:{key:'added'});await tick();
  assert.equal(d.getElementById('project-link-dialog').open,false);
  assert.equal(query.value,'report');assert.match(d.getElementById('file-list').textContent,/Report\.md/);
  assert.equal(calls.filter(call=>call.action==='files.list').length,listCount);
 }
 query.value='';query.dispatchEvent(new w.Event('input'));await new Promise(resolve=>setTimeout(resolve,340));
 assert.deepEqual(calls.filter(call=>call.action==='files.list').at(-1).args,{path:'src',workspaceKey:'current'});
});
test('mobile project menu supports new chat, persisted display rename and cancellable removal',async()=>{
  const {w,calls,snapshot}=setup({
    'chat.new':()=>({...snapshot}),
    'projects.rename':m=>({key:m.args.key,name:m.args.name}),
    'projects.remove':()=>({...snapshot,workspace:{selected:false},projects:[]})
  },{mobile:true});
  await tick();const d=w.document;
  const project={key:'project-menu',name:'Folder name',selected:true,available:true};
  w.mobileCodexEvent('state',{...snapshot,workspace:{selected:true,key:project.key,name:project.name},projects:[project]});await tick();
  const open=()=>{d.querySelector('.project-more').click();};
  d.querySelector('.sidebar-toggle').click();open();await tick();assert.ok(d.querySelector('#projects #project-actions'));assert.match(d.getElementById('project-actions').textContent,/新建对话/);
 d.querySelector('#project-actions button').click();await tick();assert.deepEqual(calls.filter(c=>c.action==='chat.new').at(-1).args,{workspaceKey:project.key,eventOnly:true});
  open();await tick();[...d.querySelectorAll('#project-actions button')].find(b=>b.textContent==='重命名').click();await tick();
  d.getElementById('input-value').value='표시 이름';d.getElementById('input-confirm').click();await tick();await tick();
  assert.deepEqual(calls.filter(c=>c.action==='projects.rename').at(-1).args,{key:project.key,name:'표시 이름'});assert.equal(d.querySelector('.project-tree .project-button span').textContent,'표시 이름');
  if(!d.body.classList.contains('sidebar-open'))d.querySelector('.sidebar-toggle').click();
  open();await tick();[...d.querySelectorAll('#project-actions button')].find(b=>b.textContent==='从项目列表中移除').click();await tick();assert.equal(calls.some(c=>c.action==='projects.remove'),false);assert.ok(d.body.classList.contains('sidebar-open'));
  d.querySelector('#project-remove-card button').click();await tick();assert.equal(d.querySelector('#project-remove-card'),null);assert.equal(calls.some(c=>c.action==='projects.remove'),false);
  open();await tick();[...d.querySelectorAll('#project-actions button')].find(b=>b.textContent==='从项目列表中移除').click();await tick();d.querySelector('#project-remove-card button:last-child').click();await tick();assert.deepEqual(calls.filter(c=>c.action==='projects.remove').at(-1).args,{key:project.key});assert.ok(d.body.classList.contains('sidebar-open'));
 });

test('shared projects group conversations without changing their original workspace keys',async()=>{
 const {w,calls,snapshot}=setup();await tick();const d=w.document;
 const project={key:'b',projectId:'shared',name:'Shared',selected:true,available:true,workspaceKeys:['a','b'],bindings:[{key:'a',name:'A',uri:'content://a',hasLocalFolder:true},{key:'b',name:'B',uri:'content://b',hasLocalFolder:true}]};
 w.mobileCodexEvent('state',{...snapshot,workspace:{selected:true,key:'a',name:'Shared'},projects:[project],sessions:[{id:'one',workspaceKey:'a',title:'From A'},{id:'two',workspaceKey:'b',title:'From B'}]});
 assert.equal(d.querySelectorAll('.project-tree').length,1);assert.equal(d.querySelectorAll('.detached-projects').length,0);
 assert.equal(d.querySelectorAll('#projects .session').length,2);
 d.querySelectorAll('#projects .session')[0].click();await tick();assert.deepEqual(calls.filter(c=>c.action==='chat.resume').at(-1).args,{id:'one',eventOnly:true});
 d.querySelector('.project-new').click();await tick();assert.deepEqual(calls.filter(c=>c.action==='chat.new').at(-1).args,{workspaceKey:'b',eventOnly:true});
});
test('project merge requires confirmation, handles failure, and suppresses duplicate writes',async()=>{
 let resolveMerge, fail=true;
 const {w,calls,snapshot}=setup({'projects.merge':()=>fail?Promise.reject(new Error('storage full')):new Promise(resolve=>{resolveMerge=resolve;})});
 await tick();const d=w.document;
 const projects=[{key:'a',projectId:'pa',name:'Same',available:true,bindings:[{key:'a',uri:'content://one'}]},{key:'b',projectId:'pb',name:'Same',available:true,bindings:[{key:'b',uri:'content://two'}]}];
 w.mobileCodexEvent('state',{...snapshot,projects});d.querySelector('.project-more').click();await tick();
 [...d.querySelectorAll('#project-actions button')].find(b=>b.textContent==='合并项目').click();await tick();
 const choice=d.querySelector('#project-link-choices button');assert.match(choice.textContent,/content:\/\/two/);
 choice.click();await answerConfirmation(d,false,/Same/);assert.equal(calls.some(c=>c.action==='projects.merge'),false);
 choice.click();await answerConfirmation(d,true,/Same/);assert.equal(d.getElementById('project-link-dialog').open,true);assert.match(d.getElementById('toast').textContent,/storage full/);
 assert.equal(d.querySelectorAll('.project-tree').length,2);
 fail=false;choice.click();choice.click();await answerConfirmation(d,true,/Same/);
 choice.click();assert.equal(d.getElementById('confirm-dialog').open,false);
 assert.equal(calls.filter(c=>c.action==='projects.merge').length,2);
 assert.deepEqual(calls.filter(c=>c.action==='projects.merge').at(-1).args,{sourceKey:'a',targetKey:'b'});
 resolveMerge({projects:[{...projects[1],workspaceKeys:['a','b']}]});await tick();await tick();
 assert.equal(d.getElementById('project-link-dialog').open,false);assert.equal(d.querySelectorAll('.project-tree').length,1);
 assert.equal(d.activeElement.dataset.projectMenuKey,'b');
});
test('default local binding is persisted without switching an existing conversation',async()=>{
 const {w,calls,snapshot}=setup({'projects.prefer':()=>({})});await tick();const d=w.document;
 const project={key:'a',projectId:'p',name:'Shared',available:true,workspaceKeys:['a','b'],bindings:[{key:'a',name:'A',uri:'content://a'},{key:'b',name:'B',uri:'content://b'}]};
 w.mobileCodexEvent('state',{...snapshot,projects:[project]});d.querySelector('.project-more').click();await tick();
 [...d.querySelectorAll('#project-actions button')].find(b=>b.textContent==='默认本地文件夹').click();await tick();
 d.querySelectorAll('#project-link-choices button')[1].click();await tick();
 assert.deepEqual(calls.filter(c=>c.action==='projects.prefer').at(-1).args,{key:'b'});
 assert.equal(calls.some(c=>c.action==='projects.select'||c.action==='chat.new'),false);
});
test('unbound projects keep history readable but block send including keyboard submit',async()=>{
 const {w,calls,snapshot}=setup();await tick();const d=w.document;
 w.mobileCodexEvent('state',{...snapshot,workspace:{key:'none',selected:true,available:false},projects:[{key:'none',projectId:'p',name:'Remote',hasLocalFolder:false,available:false}],sessions:[{id:'saved',workspaceKey:'none',title:'Saved'}]});
 assert.match(d.getElementById('projects').textContent,/关联本地文件夹/);assert.equal(d.querySelector('#projects .sidebar-empty'),null);
 assert.equal(d.querySelector('.project-new').disabled,true);assert.equal(d.querySelector('#projects .session').disabled,false);
 d.getElementById('prompt').value='Run';d.getElementById('prompt').dispatchEvent(new w.Event('input'));
 assert.equal(d.getElementById('send').disabled,true);
 d.getElementById('composer').dispatchEvent(new w.Event('submit',{cancelable:true,bubbles:true}));await tick();
 assert.equal(calls.some(c=>c.action==='chat.send'),false);
 d.querySelector('#projects .new-thread').click();await tick();assert.deepEqual(calls.filter(c=>c.action==='files.pick').at(-1).args,{projectKey:'none'});
});
test('project creation without a folder persists only after entering a name',async()=>{
 const {w,calls}=setup();await tick();const d=w.document;
 d.getElementById('add-project').click();await tick();[...d.querySelectorAll('#project-link-choices button')].find(b=>b.textContent==='创建不含文件夹的项目').click();await tick();
 d.getElementById('input-value').value='Metadata only';d.getElementById('input-confirm').click();await tick();await tick();
 assert.deepEqual(calls.filter(c=>c.action==='projects.create').at(-1).args,{name:'Metadata only'});
 assert.equal(calls.some(c=>c.action==='files.pick'||c.action==='runtime.start'),false);
});
test('shared project choices escape project content and translate action labels',async()=>{
 const {w,snapshot}=setup({}, {language:'en'});await tick();const d=w.document;
 w.mobileCodexEvent('state',{...snapshot,projects:[{key:'a',projectId:'pa',name:'A'},{key:'b',projectId:'pb',name:'<img src=x onerror=bad()>',bindings:[{uri:'<script>bad()</script>'}]}]});
 d.querySelector('.project-more').click();await tick();[...d.querySelectorAll('#project-actions button')].find(b=>b.textContent==='Merge projects').click();await tick();
 assert.equal(d.querySelectorAll('#project-link-choices img, #project-link-choices script').length,0);
 assert.match(d.getElementById('project-link-choices').textContent,/<script>/);
});

test('project import previews safely, cancels without applying, and uses the exact confirmation token',async()=>{
 let cancelled=false, fail=false, applied=0;
 const project={key:'new',projectId:'proj_new',name:'<img src=x>',nameConflicts:['Desktop','Phone'],available:false,hasLocalFolder:false};
 const {w,calls}=setup({
  'ui.projects.importFile':()=>cancelled?{cancelled:true}:{content:'portable-content'},
  'projects.import.preview':()=>({token:'exact-preview',result:{addedEvents:2,summary:{projects:[project],linkCount:1}}}),
  'projects.import.apply':()=>{applied++;if(fail)throw new Error('stale preview');return{projects:[project]};}
 }); await tick();const d=w.document;
 const pick=async()=>{d.getElementById('add-project').click();await tick();[...d.querySelectorAll('#project-link-choices button')].find(b=>b.textContent==='导入项目').click();await tick();await tick();};
 cancelled=true;await pick();assert.equal(calls.some(c=>c.action==='projects.import.preview'),false);d.getElementById('project-link-dialog').close();
 cancelled=false;await pick();assert.equal(applied,0);assert.match(d.getElementById('project-link-description').textContent,/名称冲突/);assert.equal(d.querySelector('#project-link-dialog img'),null);
 d.getElementById('project-link-dialog').close();assert.equal(applied,0);
 await pick();fail=true;d.querySelector('#project-link-choices button').click();await tick();assert.equal(d.getElementById('project-link-dialog').open,true);assert.match(d.getElementById('toast').textContent,/stale preview/);
 fail=false;d.querySelector('#project-link-choices button').click();await tick();
 assert.deepEqual(calls.filter(c=>c.action==='projects.import.apply').at(-1).args,{content:'portable-content',token:'exact-preview'});
 assert.equal(d.getElementById('project-link-dialog').open,false);assert.equal(d.querySelector('.project-new').disabled,true);
});
test('project export asks before opening a destination and conflict resolution can select current display name',async()=>{
 const bundle={format:'mobile-codex-projects',schemaVersion:1,events:[]};
 const {w,calls,snapshot}=setup({'projects.export':()=>bundle}); await tick();const d=w.document;
 w.mobileCodexEvent('state',{...snapshot,projects:[{key:'a',projectId:'proj_a',name:'Desktop',nameConflicts:['Desktop','Phone'],available:true}]});
 const exportIt=async()=>{d.querySelector('.project-more').click();await tick();[...d.querySelectorAll('#project-actions button')].find(b=>b.textContent==='导出项目').click();await tick();};
 await exportIt();assert.equal(calls.some(c=>c.action==='ui.projects.exportFile'),false);
 await answerConfirmation(d,false,/Desktop/);assert.equal(calls.some(c=>c.action==='ui.projects.exportFile'),false);
 await exportIt();await answerConfirmation(d,true,/Desktop/);
 assert.equal(calls.filter(c=>c.action==='ui.projects.exportFile').at(-1).args.content,JSON.stringify(bundle));
 [...d.querySelectorAll('#projects button')].find(b=>b.textContent==='解决名称冲突').click();await tick();d.querySelector('#project-link-choices button').click();await tick();
 assert.deepEqual(calls.filter(c=>c.action==='projects.rename').at(-1).args,{key:'a',name:'Desktop'});
});
test('phone control requires native consent and does not enable on service connection',async()=>{
 const {w,calls,snapshot}=setup({'ui.phoneEnable':()=>({cancelled:true})});await tick();
 w.mobileCodexEvent('state',{...snapshot,phone:{connected:true,enabled:false,status:'접근성 연결됨',screenshotsSupported:true},phoneToolsAvailable:false});
 assert.equal(calls.some(c=>c.action==='ui.phoneEnable'),false);
 assert.equal(w.document.getElementById('phone-thread-note').hidden,false);
 w.document.getElementById('phone-enable').click();await tick();
 assert.equal(calls.filter(c=>c.action==='ui.phoneEnable').length,1);
 assert.equal(w.document.getElementById('phone-stop-banner').hidden,true);
 w.document.getElementById('phone-settings').click();await tick();
 assert.equal(calls.some(c=>c.action==='ui.phoneSettings'),true);
});
test('phone emergency stop remains visible and stops without ending a chat or losing its draft',async()=>{
 const {w,calls,snapshot}=setup();await tick();
 w.document.getElementById('prompt').value='keep my draft';
 w.mobileCodexEvent('state',{...snapshot,busy:true,phone:{connected:true,enabled:true,status:'휴대폰 제어 켜짐',screenshotsSupported:false},phoneToolsAvailable:true});
 assert.equal(w.document.getElementById('phone-stop-banner').hidden,false);
 assert.match(w.document.getElementById('phone-screenshot-note').textContent,/Android 10/);
 w.document.getElementById('phone-stop-banner').click();await tick();
 assert.equal(calls.some(c=>c.action==='phone.stop'),true);
 assert.equal(calls.some(c=>c.action==='runtime.stop'),false);
 assert.equal(w.document.getElementById('phone-stop-banner').hidden,true);
 assert.equal(w.document.getElementById('prompt').value,'keep my draft');
});

test('busy composer offers Send while keyboard steering retains rejected instructions',async()=>{
 const {w,calls,snapshot}=setup({'chat.steer':async()=>{throw new Error('turn already completed');}});await tick();
 const d=w.document,prompt=d.getElementById('prompt'),send=d.getElementById('send'),stop=d.getElementById('stop');
 w.mobileCodexEvent('state',{...snapshot,busy:true,turnId:'active-turn'});
 prompt.value='색만 바꿔';prompt.dispatchEvent(new w.Event('input'));
 assert.equal(send.disabled,false);assert.equal(send.hidden,false);assert.equal(stop.hidden,true);
 prompt.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,cancelable:true}));await tick();
 const call=calls.find(x=>x.action==='chat.steer');assert.equal(call.args.expectedTurnId,'active-turn');assert.equal(call.args.expectedThreadId,'t');assert.equal(prompt.value,'색만 바꿔');assert.equal(calls.some(x=>x.action==='chat.send'),false);
 assert.equal(send.hidden,false);assert.equal(stop.hidden,true);
 w.mobileCodexEvent('state',{...snapshot,busy:false,turnId:''});
 assert.equal(stop.hidden,true);assert.equal(send.hidden,false);assert.equal(send.disabled,false);assert.equal(prompt.value,'색만 바꿔');
});
test('change preview renders file text safely and restore uses its exact token and project',async()=>{
 const {w,calls,snapshot}=setup({'changes.list':()=>({entries:[{path:'a.txt',status:' M'}]}),'changes.preview':()=>({path:'a.txt',token:'review-1',before:'old',after:'<img src=x onerror=alert(1)>',canRestore:true,actionLabel:'복원'})});await tick();
 w.mobileCodexEvent('state',{...snapshot,workspace:{selected:true,key:'project-a'}});w.document.getElementById('show-changes').click();await tick();
 w.document.querySelector('#changes-list button').click();await tick();assert.equal(w.document.querySelectorAll('#change-diff img').length,0);assert.match(w.document.getElementById('change-diff').textContent,/<img/);
 const restore=w.document.getElementById('change-restore');restore.click();await answerConfirmation(w.document,false,/a[.]txt/);
 assert.equal(calls.some(call=>call.action==='changes.restore'),false);
 restore.click();await answerConfirmation(w.document,true,/a[.]txt/);
 assert.deepEqual(calls.find(call=>call.action==='changes.restore').args,{token:'review-1',workspaceKey:'project-a'});
});
test('late change previews cannot restore into a switched project',async()=>{
 let resolve;const {w,calls,snapshot}=setup({'changes.list':()=>({entries:[{path:'a.txt'}]}),'changes.preview':()=>new Promise(r=>resolve=r)});await tick();
 w.mobileCodexEvent('state',{...snapshot,workspace:{selected:true,key:'a'}});w.document.getElementById('show-changes').click();await tick();w.document.querySelector('#changes-list button').click();await tick();
 w.mobileCodexEvent('state',{...snapshot,workspace:{selected:true,key:'b'}});resolve({path:'a.txt',token:'old',canRestore:true,before:'one',after:'two'});await tick();
 assert.equal(w.document.getElementById('change-preview').hidden,true);assert.equal(w.document.getElementById('change-restore').disabled,true);assert.equal(calls.some(x=>x.action==='changes.restore'),false);
});
test('floating chat requires an accessibility connection but not armed phone control',async()=>{
 const {w,calls,snapshot}=setup();await tick();w.mobileCodexEvent('state',{...snapshot,phone:{connected:false,enabled:false}});assert.equal(w.document.getElementById('floating-chat').disabled,true);
 w.mobileCodexEvent('state',{...snapshot,phone:{connected:true,enabled:false}});w.document.getElementById('floating-chat').click();await tick();assert.equal(calls.some(x=>x.action==='ui.floatingChat'),true);assert.equal(calls.some(x=>x.action==='ui.phoneEnable'),false);
});

test('voice input captures selection, fills the draft and never sends automatically',async()=>{
 let receipts=[];const {w,calls}=setup({'voice.recover':()=>({receipts,active:false})});await tick();
 const prompt=w.document.getElementById('prompt');prompt.value='old draft';prompt.setSelectionRange(0,3);prompt.dispatchEvent(new w.Event('input'));
 w.document.getElementById('voice-input').click();await tick();
 const request=calls.find(c=>c.action==='voice.start').args;assert.equal(request.original,'old draft');assert.equal(request.start,0);assert.equal(request.end,3);
 receipts=[{...request,origin:'main',receiptId:'v1',text:'새 음성'}];w.mobileCodexEvent('voice.changed',{});await tick();
 assert.equal(prompt.value,'새 음성 draft');assert.equal(calls.filter(c=>c.action==='chat.send'||c.action==='chat.steer').length,0);
 assert.equal(calls.filter(c=>c.action==='voice.ack').length,1);
 w.mobileCodexEvent('voice.changed',{});await tick();assert.equal(prompt.value,'새 음성 draft');assert.equal(calls.filter(c=>c.action==='voice.ack').length,1);
});
test('voice results stay with the original conversation after a project switch',async()=>{
 let receipts=[];const {w,snapshot,calls}=setup({'voice.recover':()=>({receipts})});await tick();
 const prompt=w.document.getElementById('prompt');prompt.value='A';prompt.setSelectionRange(1,1);prompt.dispatchEvent(new w.Event('input'));
 w.document.getElementById('voice-input').click();await tick();const request=calls.find(c=>c.action==='voice.start').args;
 w.mobileCodexEvent('state',{...snapshot,threadId:'other',workspace:{key:'other-project',name:'Other'}});prompt.value='B';prompt.dispatchEvent(new w.Event('input'));
 receipts=[{...request,origin:'main',receiptId:'v2',text:' 원래 요청'}];w.mobileCodexEvent('voice.changed',{});await tick();
 assert.equal(prompt.value,'B');assert.equal(w.localStorage.getItem('draft:'+request.scope),'A 원래 요청');
 w.mobileCodexEvent('state',snapshot);assert.equal(prompt.value,'A 원래 요청');
});
test('voice errors, cancellation and edits during recognition preserve the current draft',async()=>{
 let receipts=[];const {w,calls}=setup({'voice.recover':()=>({receipts})});await tick();
 const prompt=w.document.getElementById('prompt');prompt.value='before';prompt.dispatchEvent(new w.Event('input'));
 w.document.getElementById('voice-input').click();await tick();const request=calls.find(c=>c.action==='voice.start').args;
 prompt.value='edited';prompt.dispatchEvent(new w.Event('input'));
 receipts=[{...request,origin:'main',receiptId:'v3',text:'dictation'}];w.mobileCodexEvent('voice.changed',{});await tick();assert.equal(prompt.value,'edited\ndictation');
 receipts=[{...request,origin:'main',receiptId:'v4',text:'',error:'인식 서비스 없음'},{...request,origin:'main',receiptId:'v5',text:'',cancelled:true}];w.mobileCodexEvent('voice.changed',{});await tick();
 assert.equal(prompt.value,'edited\ndictation');assert.match(w.document.getElementById('toast').textContent,/인식 서비스 없음/);assert.equal(w.document.getElementById('voice-input').disabled,false);
});
test('interrupted voice receipt application recovers without appending twice',async()=>{
 const scope=C.draftKey('/test/project','t'),receipt={scope,origin:'main',receiptId:'recovered',original:'before',start:6,end:6,text:' voice'};
 const {w,calls}=setup({'voice.recover':()=>({receipts:[receipt]})},{drafts:{['draft:'+scope]:'before voice',['voice-receipt:recovered']:JSON.stringify({before:'before',after:'before voice'})}});await tick();await tick();
 assert.equal(w.document.getElementById('prompt').value,'before voice');assert.equal(calls.filter(c=>c.action==='voice.ack').length,1);
});

test('updates load local version without automatically checking or downloading',async()=>{
 const {w,calls}=setup({'updates.state':()=>({versionName:'0.1.11-alpha',versionCode:12,repository:'nokryong/mobile-codex',prereleases:true,status:'idle',revision:1})});await tick();
 assert.equal(w.document.getElementById('app-version').textContent,'0.1.11-alpha');assert.equal(calls.filter(c=>['updates.check','updates.download','updates.install'].includes(c.action)).length,0);
 const field=w.document.getElementById('update-repository');field.value='other/repo';field.dispatchEvent(new w.Event('input'));
 w.mobileCodexEvent('updates.changed',{revision:2,status:'idle',repository:'old/repo'});assert.equal(field.value,'other/repo');
 w.document.getElementById('update-check').click();await tick();assert.equal(calls.find(c=>c.action==='updates.configure').args.repository,'other/repo');assert.equal(calls.filter(c=>c.action==='updates.check').length,1);
});
test('update progress cannot regress and installation requires explicit permission and click',async()=>{
 const {w,calls,snapshot}=setup();await tick();const candidate={versionName:'0.1.12-alpha',size:100,notes:'<script>bad</script>'};
 w.mobileCodexEvent('updates.changed',{revision:3,status:'downloading',candidate,busy:true,received:50,canCancel:true});assert.equal(w.document.getElementById('update-progress').value,50);assert.equal(w.document.getElementById('update-cancel').hidden,false);
 w.mobileCodexEvent('updates.changed',{revision:2,status:'idle'});assert.equal(w.document.getElementById('update-progress').value,50);assert.equal(w.document.querySelectorAll('#update-notes script').length,0);
 w.mobileCodexEvent('updates.changed',{revision:4,status:'ready',candidate,ready:true,available:true,canInstall:false});assert.equal(w.document.getElementById('update-install').disabled,true);
 w.document.getElementById('update-permission').click();await tick();assert.equal(calls.filter(c=>c.action==='updates.install').length,0);
 w.mobileCodexEvent('updates.changed',{revision:5,status:'ready',candidate,ready:true,canInstall:true});w.mobileCodexEvent('state',{...snapshot,busy:true});assert.equal(w.document.getElementById('update-install').disabled,true);
 w.mobileCodexEvent('state',{...snapshot,busy:false});w.document.getElementById('update-install').click();await tick();assert.equal(calls.filter(c=>c.action==='updates.install').length,1);
});
test('update cancellation and signature errors never offer automatic installation',async()=>{
 const {w,calls}=setup({'updates.cancel':()=>({revision:3,status:'cancelled',message:'취소했습니다',busy:false})});await tick();
 w.mobileCodexEvent('updates.changed',{revision:2,status:'downloading',busy:true,canCancel:true});w.document.getElementById('update-cancel').click();await tick();assert.equal(w.document.getElementById('update-status').textContent,'취소했습니다');
 w.mobileCodexEvent('updates.changed',{revision:4,status:'error',message:'서명키가 다릅니다. <b>삭제하지 마세요</b>',available:true,candidate:{versionName:'0.1.12-alpha',size:200},ready:false});
 assert.equal(w.document.getElementById('update-install').hidden,true);assert.equal(w.document.querySelectorAll('#update-status b').length,0);assert.equal(calls.filter(c=>c.action==='updates.install').length,0);
});

test('edited update source disables old candidate actions and download names its hash',async()=>{
 const {w,calls}=setup();await tick();const candidate={versionName:'0.1.12-alpha',size:100,sha256:'ab'.repeat(32)};
 w.mobileCodexEvent('updates.changed',{revision:1,status:'available',candidate,available:true,repository:'owner/repo'});
 w.document.getElementById('update-download').click();await tick();assert.equal(calls.find(c=>c.action==='updates.download').args.sha256,candidate.sha256);
 w.mobileCodexEvent('updates.changed',{revision:2,status:'ready',candidate,available:true,ready:true,canInstall:true});
 const source=w.document.getElementById('update-repository');source.value='other/repo';source.dispatchEvent(new w.Event('input'));
 assert.equal(w.document.getElementById('update-download').disabled,true);assert.equal(w.document.getElementById('update-install').disabled,true);
 assert.equal(w.document.getElementById('update-check').disabled,false);
});

test('language switch preserves drafts, model content and editor values',async()=>{
 const {w,snapshot,calls}=setup({}, {language:'ko'});await tick();const d=w.document;
 const raw='설정 파일 보내기';w.mobileCodexEvent('state',{...snapshot,messages:[{id:'a',role:'assistant',text:raw}]});
 d.getElementById('prompt').value='기존 초안';d.getElementById('prompt').dispatchEvent(new w.Event('input'));
 d.getElementById('editor').value='사용자 파일';d.getElementById('instructions-editor').value='기존 지침';
 d.getElementById('language').value='en';d.getElementById('language').dispatchEvent(new w.Event('change'));await tick();await tick();
 assert.equal(d.documentElement.lang,'en');assert.match(d.getElementById('settings').textContent,/Settings/);
 assert.equal(d.getElementById('appearance-title').textContent,'Interface style');
 assert.equal(d.querySelector('label:has(#appearance-glass) span').textContent,'Liquid Glass');
 assert.equal(d.getElementById('prompt').value,'기존 초안');assert.equal(d.getElementById('editor').value,'사용자 파일');assert.equal(d.getElementById('instructions-editor').value,'기존 지침');
 w.mobileCodexEvent('state',{...snapshot,messages:[{id:'a',role:'assistant',text:raw}]});
 assert.match(d.getElementById('messages').textContent,/설정 파일 보내기/);assert.equal(d.querySelector('[data-id="a"] .msg-copy-btn'),null);
 assert.match(d.querySelector('[data-prompt]').dataset.prompt,/Look through/);
 assert.equal(calls.filter(x=>['runtime.stop','runtime.start'].includes(x.action)).length,0);
 d.getElementById('language').value='zh-CN';d.getElementById('language').dispatchEvent(new w.Event('change'));await tick();await tick();
 assert.equal(d.getElementById('prompt').value,'기존 초안');assert.match(d.getElementById('settings').textContent,/设置/);
 assert.equal(d.getElementById('appearance-title').textContent,'界面主题');
 assert.equal(d.querySelector('label:has(#appearance-glass) span').textContent,'液态玻璃');
});
test('system locale uses Chinese fallback and catalog copies match',async()=>{
 const {w}=setup({}, {language:'system',systemLanguage:'ja-JP'});await tick();
 assert.equal(w.document.documentElement.lang,'zh-CN');assert.match(w.document.getElementById('prompt').placeholder,/Codex/);
 assert.deepEqual(JSON.parse(JSON.stringify(w.MobileCodexEnglish)), JSON.parse(fs.readFileSync('app/src/main/assets/translations-en.json','utf8')));
});

test('chat folders preserve same-title sessions by ID across reload and provider changes',async()=>{
 const {w,snapshot}=setup();await tick();const doc=w.document;
 const sessions=[{id:'one',title:'同名'},{id:'two',title:'同名'}];
 const state={...snapshot,sessions};w.mobileCodexEvent('state',state);
 async function move(id,choice){
  doc.querySelector(`[data-session-id="${id}"] .session-more`).click();await tick();
  const action=text=>[...doc.querySelectorAll('#session-card button')].find(button=>button.textContent===text);
  assert.equal(doc.querySelector('#session-card button:last-child').dataset.sessionDelete,'');
  action('移至项目或文件夹').click();await tick();assert.equal(doc.querySelector('#session-card input'),null);
  if(choice==='new'){action('新建文件夹').click();await tick();doc.querySelector('#session-card input').value='工作';action('确定').click();}
  else action(choice==='none'?'移出文件夹':'工作').click();await tick();
 }
 await move('one','new');await move('two','0');assert.equal(doc.querySelectorAll('.history-folder .session-row').length,2);
 await move('one','none');assert.equal(doc.querySelector('.history-folder .session-row').dataset.sessionId,'two');
 const key='chat-folders:v1:'+state.apiActive;
 const restored=setup({}, {drafts:{[key]:w.localStorage.getItem(key)}});await tick();restored.w.mobileCodexEvent('state',state);
 assert.equal(restored.w.document.querySelector('.history-folder .session-row').dataset.sessionId,'two');
 w.mobileCodexEvent('state',{...state,apiActive:'another'});assert.equal(doc.querySelector('.history-folder'),null);
 w.mobileCodexEvent('state',state);assert.equal(doc.querySelector('.history-folder .session-row').dataset.sessionId,'two');
});

test('recent messages sort general, project and folder chats without promoting a viewed thread',async()=>{
 const {w,snapshot}=setup({}, {drafts:{'chat-folders:v1:fixture-api':JSON.stringify([{name:'F',ids:['f1','f2']}])}});await tick();
 const state={...snapshot,projects:[{key:'p',name:'Project'}],sessions:['a','b','p1','p2','f1','f2'].map((id,index)=>({id,lastMessageAt:index+1,workspaceKey:id.startsWith('p')?'p':''}))};
 const order=selector=>[...w.document.querySelectorAll(selector)].map(row=>row.dataset.sessionId);
 w.mobileCodexEvent('state',state);assert.deepEqual(order('#sessions > .session-row'),['b','a']);assert.deepEqual(order('#projects .session-row'),['p2','p1']);assert.deepEqual(order('.history-folder .session-row'),['f2','f1']);
 w.mobileCodexEvent('state',{...state,threadId:'a'});assert.deepEqual(order('#sessions > .session-row'),['b','a']);state.sessions.find(session=>session.id==='a').lastMessageAt=100;
 w.mobileCodexEvent('state',state);assert.deepEqual(order('#sessions > .session-row'),['a','b']);
});

test('moving chat into an existing project does not create a project or switch the sidebar',async()=>{
 const {w,snapshot,calls}=setup({'chat.move':request=>({...snapshot,sessions:[{id:'chat',title:'History',workspaceKey:request.args.key}]})},{mobile:true});await tick();
 snapshot.projects=[{key:'existing',name:'Existing project'}];snapshot.sessions=[{id:'chat',title:'History'}];w.mobileCodexEvent('state',snapshot);
 const doc=w.document;doc.querySelector('.sidebar-toggle').click();doc.querySelector('.session-more').click();await tick();
 const action=label=>[...doc.querySelectorAll('#session-card button')].find(button=>button.textContent===label);
 action('移至项目或文件夹').click();await tick();action('Existing project').click();await tick();
 assert.deepEqual(calls.find(request=>request.action==='chat.move').args,{id:'chat',key:'existing'});assert.ok(doc.querySelector('#projects [data-session-id="chat"]'));assert.ok(doc.body.classList.contains('sidebar-open'));assert.ok(!calls.some(request=>request.action==='projects.create'));
});

test('provider picker guards pending sends and restores selection on failure',async()=>{
 let finish,fail=true;const {w,snapshot,calls}=setup({'chat.provider':async request=>{
  await new Promise(resolve=>{finish=resolve;});if(fail)throw Error('offline');
  snapshot.apiActive=request.args.id;snapshot.models=[{id:'other-model',isDefault:true}];return snapshot;
 }});await tick();const doc=w.document,select=doc.getElementById('picker-provider');
 snapshot.threadId='';snapshot.apiProviders.push({id:'other',name:'Other API',hasKey:true},{id:'no-key',hasKey:false});
 snapshot.sessions=[{id:'running-chat',busy:true}];w.mobileCodexEvent('state',snapshot);
 assert.deepEqual([...select.options].map(option=>option.value),['','fixture-api','other']);
 const choose=async()=>{select.value='other';select.dispatchEvent(new w.Event('change'));await tick();};
 await choose();assert.ok(select.disabled);doc.getElementById('prompt').value='pending';
 doc.getElementById('composer').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();assert.ok(!calls.some(request=>request.action==='chat.send'));
 finish();await tick();assert.equal(select.value,'fixture-api');assert.ok(!select.disabled);
 fail=false;await choose();finish();await tick();assert.equal(select.value,'other');assert.equal(doc.getElementById('model').value,'other-model');
 assert.equal(doc.getElementById('header-api').textContent,'API · Other API');
 w.mobileCodexEvent('state',{...snapshot,threadId:'bound-chat'});assert.ok(select.disabled);
});

test('saved command rows stay under commentary when returning to another API chat',async()=>{
 const {w,snapshot}=setup({}, {language:'zh-CN'});await tick();const doc=w.document;
 const first={...snapshot,persistedWorkActivity:true,apiProviders:[{id:'first',name:'API One',hasKey:true},{id:'second',name:'API Two',hasKey:true}],apiActive:'first',messages:[
  {id:'preamble',role:'assistant',text:'Checking files',phase:'commentary',completedTurnId:'turn'},
  {id:'work:turn:cmd',kind:'toolActivity',role:'tool',activityKind:'command',activityTurnId:'turn',detail:'pwd',output:'/workspace',completed:true},
  {id:'reply',role:'assistant',text:'Done',phase:'final_answer',completedTurnId:'turn'}]};
 w.mobileCodexEvent('state',{...first,busy:true,turnId:'turn',messages:first.messages.slice(0,1)});
 w.mobileCodexEvent('state',{...first,threadId:'another',apiActive:'second',messages:[]});
 assert.equal(doc.getElementById('header-api').textContent,'API · API Two');
 assert.equal(doc.querySelector('.message-tool'),null);
 w.mobileCodexEvent('state',first);
 assert.equal(doc.getElementById('header-api').textContent,'API · API One');
 const row=doc.querySelector('.message-tool');
 const group=doc.querySelector('.tool-group');
 const process=doc.querySelector('.work-toggle:not(.tool-group)');
 assert.equal(group.hidden,true);
 process.click();await tick();assert.equal(group.hidden,false);
 assert.equal(group.previousElementSibling.dataset.id,'preamble');
 assert.equal(group.nextElementSibling,row);
 assert.equal(group.textContent,'运行了 1 条命令');
 assert.equal(row.hidden,true);
 group.click();await tick();
 assert.equal(group.getAttribute('aria-expanded'),'true');
 assert.equal(row.hidden,false);
 assert.match(row.querySelector('summary').textContent,/pwd/);
 row.querySelector('summary').click();
 assert.equal(row.firstElementChild.open,true);
 assert.match(row.querySelector('pre').textContent,/\/workspace/);
 w.mobileCodexEvent('state',{...first,threadId:'another',apiActive:'second',messages:[]});
 w.mobileCodexEvent('state',first);
 assert.equal(doc.querySelector('.tool-group').getAttribute('aria-expanded'),'true');
 assert.equal(doc.querySelector('.tool-group').hidden,true);
 doc.querySelector('.work-toggle:not(.tool-group)').click();await tick();
 doc.querySelector('.tool-group').click();await tick();
 assert.equal(doc.querySelector('.message-tool').hidden,true);
});

test('completed mixed tools fold in order and streamed commentary separates groups',async()=>{
 const {w,snapshot,frames}=setup({}, {language:'zh-CN',manualFrames:true});await tick();const doc=w.document;
 const flush=()=>{for(const callback of frames.splice(0))callback();};
 const work=(id,activityKind='command')=>({id,kind:'toolActivity',role:'tool',activityKind,activityTurnId:'turn',detail:id,completed:true});
 const commentary={id:'commentary',role:'assistant',text:'Starting'};
 const progress={id:'progress',role:'assistant',text:'',status:'streaming'};
 const first=[commentary,work('pwd'),work('web','searching'),work('ls'),work('edit','editing'),progress];
 const active={...snapshot,busy:true,turnId:'turn',persistedWorkActivity:true};
 const visibleWork=()=>[...doc.querySelectorAll('.message-tool:not([hidden])')].map(row=>row.dataset.id);
 const summaries=()=>[...doc.querySelectorAll('.tool-group')].map(group=>group.textContent);
 const mixed='运行了 2 条命令 · 搜索了 1 次 · 1 项文件修改';
 w.mobileCodexEvent('state',{...active,messages:first});flush();
 assert.deepEqual(visibleWork(),[]);
 assert.equal(doc.querySelector('.tool-group').previousElementSibling.dataset.id,'commentary');
 assert.deepEqual(summaries(),[mixed]);
 w.mobileCodexEvent('message.delta',{threadId:'t',id:'progress',delta:' '});flush();
 assert.deepEqual(summaries(),[mixed]);
 const reply={id:'reply',role:'assistant',text:'',status:'streaming'};
 w.mobileCodexEvent('state',{...active,messages:[...first,work('npm test'),reply]});flush();
 w.mobileCodexEvent('message.delta',{threadId:'t',id:'progress',delta:'A'});flush();
 assert.deepEqual(summaries(),[mixed,'运行了 1 条命令']);
 w.mobileCodexEvent('message.delta',{threadId:'t',id:'reply',delta:'D'});flush();
 assert.deepEqual(summaries(),[mixed,'运行了 1 条命令']);
 assert.deepEqual(visibleWork(),[]);
 doc.querySelector('.tool-group').click();await tick();
 assert.deepEqual(visibleWork(),['pwd','web','ls','edit']);
 const trailing=[{...work('last check'),completed:false}];
 w.mobileCodexEvent('state',{...active,messages:trailing});flush();
 assert.deepEqual(visibleWork(),['last check']);
 w.mobileCodexEvent('state',{...active,busy:false,turnId:'',messages:[{...trailing[0],completed:true,interrupted:true}]});flush();
 assert.deepEqual(summaries(),['运行了 1 条命令']);
 assert.deepEqual(visibleWork(),[]);
});

test('ultra commits on slider input and survives a provider model refresh before sending',async()=>{
 const {w,snapshot,calls}=setup();await tick();const doc=w.document;
 const model={id:'gpt-6.2-sol',isDefault:true};
 w.mobileCodexEvent('state',{...snapshot,models:[model]});
 const slider=doc.getElementById('effort-slider');
 slider.value=slider.max;slider.dispatchEvent(new w.Event('input'));
 w.mobileCodexEvent('state',{...snapshot,models:[{...model,displayName:'Updated display name'}]});
 doc.getElementById('prompt').value='verify selected effort';
 doc.getElementById('composer').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();
 assert.equal(calls.find(request=>request.action==='chat.send').args.effort,'ultra');
});

test('live work follows transcript messages and stays out of older turns after navigation',async()=>{
 const {w,snapshot}=setup();await tick();const doc=w.document;
 const messages=[{id:'old',role:'assistant',text:'old answer'},{id:'ask',role:'user',text:'question'},{id:'reply',role:'assistant',text:'answer',status:'streaming'}];
 const active={...snapshot,busy:true,turnId:'turn',liveTaskActivity:true,persistedWorkActivity:true};
 w.mobileCodexEvent('state',{...active,messages});
 const search={id:'work:turn:search',role:'tool',kind:'toolActivity',activityKind:'searching',detail:'mobile_search · README'};
 w.mobileCodexEvent('state',{...active,messages:[...messages,search]});
 const command={id:'work:turn:cmd',role:'tool',kind:'toolActivity',activityKind:'command',detail:'pwd'};
 w.mobileCodexEvent('state',{...active,messages:[...messages,search,command]});
 w.mobileCodexEvent('agent.event',{threadId:'t',method:'item/commandExecution/outputDelta',params:{turnId:'turn',itemId:'cmd',delta:'/workspace'}});
 await tick();
 assert.deepEqual([...doc.getElementById('messages').children].map(child=>child.dataset.id),['old','ask','reply',search.id,command.id]);
 assert.match(doc.querySelector('[data-id="work:turn:cmd"] pre').textContent,/\/workspace/);
 assert.equal(doc.getElementById('task-activities').childElementCount,0);
 assert.ok(doc.getElementById('messages').compareDocumentPosition(doc.getElementById('live-work')) & w.Node.DOCUMENT_POSITION_FOLLOWING);
 w.mobileCodexEvent('state',{...snapshot,threadId:'new-thread',messages:[]});assert.ok(doc.getElementById('live-work'));assert.equal(doc.getElementById('messages').childElementCount,0);
});
test('welcome logo is visible before startup and fresh portraits retain their colors in dark mode',()=>{
 const dom=new JSDOM(fs.readFileSync(root+'index.html','utf8'),{url:'https://appassets.androidplatform.net',runScripts:'outside-only'});
 opened.push(dom);
 const {window}=dom, doc=window.document;
 for(const link of doc.querySelectorAll('link[rel="stylesheet"]')) {
  const style=doc.createElement('style');style.textContent=fs.readFileSync(root+link.getAttribute('href'),'utf8');doc.head.append(style);
 }
 doc.documentElement.dataset.theme='dark';
 assert.notEqual(window.getComputedStyle(doc.querySelector('.welcome-mark')).display,'none');
 const images=[doc.querySelector('.welcome-mark img'), doc.querySelector('.brand img')];
 for(const image of images)assert.equal(window.getComputedStyle(image).filter,'brightness(0) invert(1)');
 window.Native={locale:()=>JSON.stringify({brandName:'大肥龙'})};
 window.eval(fs.readFileSync(root+'locale.js','utf8'));
 for(const image of images)assert.ok(['','none'].includes(window.getComputedStyle(image).filter));
});
test('fresh identity reaches Chinese and English UI without changing user text or runtime IDs',async()=>{
 const {w,snapshot}=setup({}, {language:'zh-CN',brandName:'大肥龙'});await tick();
 const d=w.document, prompt=d.getElementById('prompt'), draft='Ask Codex about gpt-codex and .codex/AGENTS.md';
 assert.equal(d.title,'大肥龙');assert.equal(prompt.placeholder,'询问大肥龙');
 for(const el of d.querySelectorAll('.brand img,.welcome-mark img'))assert.equal(el.alt,'大肥龙');
 assert.equal(d.getElementById('sidebar-brand-name').textContent,'大肥龙');
 assert.match(d.getElementById('subagents-title').textContent,/大肥龙/);
 const message={id:'identity',role:'assistant',text:draft};
 w.mobileCodexEvent('state',{...snapshot,workspace:{selected:true,name:'Codex'},messages:[message]});
 prompt.value=draft;prompt.dispatchEvent(new w.Event('input'));
 for(const language of ['en','zh-CN']) {
  const select=d.getElementById('language');select.value=language;select.dispatchEvent(new w.Event('change'));await tick();await tick();
  w.mobileCodexEvent('state',{...snapshot,workspace:{selected:true,name:'Codex'},messages:[message]});
  assert.match(prompt.placeholder,/大肥龙/);assert.match(prompt.getAttribute('aria-label'),/大肥龙/);
  assert.equal(d.querySelector('.welcome-mark img').alt,'大肥龙');
  assert.ok(d.getElementById('welcome-title').textContent.trim());
  assert.equal(d.getElementById('project-label').textContent,'Codex');assert.equal(prompt.value,draft);
  assert.equal(d.querySelector('[data-id="identity"] p').textContent,draft);
  assert.equal(d.getElementById('update-repository').value,'caizhiyuan72/mobile-codex-zh');
 }
});
test('inline dictation displays partial text, supports done and cancel, and cannot auto-send',async()=>{
 const {w,calls}=setup({}, {language:'en'});await tick();const d=w.document;
 d.getElementById('prompt').value='Existing draft';
 w.mobileCodexEvent('voice.state',{phase:'listening',partial:'partial voice',level:0.6,elapsedMs:4200});
 assert.equal(d.getElementById('dictation').hidden,false);assert.equal(d.getElementById('composer').classList.contains('composer-expanded'),true);assert.match(d.getElementById('dictation-status').textContent,/Listening/);
 assert.equal(d.getElementById('dictation-preview').textContent,'partial voice');assert.equal(d.getElementById('prompt').value,'Existing draft');assert.equal(d.getElementById('prompt').readOnly,true);
 d.getElementById('composer').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();assert.equal(calls.some(x=>x.action==='chat.send'),false);
 d.getElementById('dictation-done').click();await tick();assert.equal(calls.some(x=>x.action==='voice.stop'),true);
 w.mobileCodexEvent('voice.state',{phase:'transcribing'});assert.equal(d.getElementById('dictation-done').disabled,true);
 d.getElementById('dictation-cancel').click();await tick();assert.equal(calls.some(x=>x.action==='voice.cancel'),true);
 w.mobileCodexEvent('voice.state',{phase:'idle'});assert.equal(d.getElementById('dictation').hidden,true);assert.equal(d.getElementById('prompt').readOnly,false);assert.equal(d.getElementById('prompt').value,'Existing draft');
});

function sheetPointer(w, grip, type, x, y) {
 const event=new w.Event(type,{bubbles:true,cancelable:true});
 for(const [key,value] of Object.entries({pointerId:1,isPrimary:true,button:0,clientX:x,clientY:y})) Object.defineProperty(event,key,{value});
 grip.dispatchEvent(event);
}
function backdropPointer(w, dialog, x, y, target = dialog) {
 dialog.getBoundingClientRect = () => ({left:20,right:320,top:200,bottom:600});
 sheetPointer(w,target,'pointerdown',x,y);
 sheetPointer(w,target,'pointerup',x,y);
}
test('outside taps dismiss sheets and centered dialogs, while inside taps stay open',async()=>{
 const {w}=setup({}, {mobile:true});await tick();const d=w.document;
 d.getElementById('composer-options').click();await tick();
 d.getElementById('model-picker-permissions').click();await tick();
 const sheet=d.getElementById('options-dialog');
 backdropPointer(w,sheet,100,300);
 assert.equal(sheet.open,true);
 backdropPointer(w,sheet,100,100,sheet.querySelector('.dialog-head'));
 assert.equal(sheet.open,true);
 backdropPointer(w,sheet,100,100);
 assert.equal(sheet.open,false);
 d.getElementById('settings').click();await tick();
 const modal=d.getElementById('settings-dialog');
 backdropPointer(w,modal,400,300);
 assert.equal(modal.open,false);
});
test('outside taps respect unsaved changes and do not answer approval requests',async()=>{
 const {w,responses}=setup({'instructions.read':()=>({content:'Saved instructions',activePath:'/private/AGENTS.md'})},{mobile:true});await tick();const d=w.document;
 d.getElementById('settings').click();await tick();d.getElementById('settings-open-advanced').click();
 d.querySelector('[data-settings-tab="personal"]').click();await tick();
 d.getElementById('instructions-editor').value='Unsaved edit';
 const settings=d.getElementById('settings-dialog');backdropPointer(w,settings,100,100);
 await answerConfirmation(d,false);
 assert.equal(settings.open,true);assert.equal(d.getElementById('instructions-editor').value,'Unsaved edit');
 backdropPointer(w,settings,100,100);await answerConfirmation(d,true);assert.equal(settings.open,false);
 w.mobileCodexEvent('server.request',{key:'approval',method:'item/commandExecution/requestApproval',params:{threadId:'t',command:'true'}});
 const request=d.getElementById('request-dialog');assert.equal(request.open,true);
 backdropPointer(w,request,100,100);assert.equal(request.open,false);assert.equal(responses.length,0);
 w.mobileCodexEvent('state',{ready:true,busy:false,permissions:'workspace-write',models:[],messages:[],sessions:[],account:{type:'chatgpt'},workspace:{selected:true,name:'Project'},cwd:'/test/project',threadId:'t',status:'연결됨'});
 assert.equal(request.open,true);
 const requestGrip=request.querySelector('.sheet-grip');
 sheetPointer(w,requestGrip,'pointerdown',100,20);sheetPointer(w,requestGrip,'pointermove',100,170);sheetPointer(w,requestGrip,'pointerup',100,170);
 assert.equal(request.open,false);assert.equal(responses.length,0);
});
test('mobile sheet drag closes through the existing unsaved-instructions guard',async()=>{
 const {w}=setup({'instructions.read':()=>({content:'Saved instructions',activePath:'/private/AGENTS.md'})},{mobile:true});await tick();const d=w.document;
 d.getElementById('settings').click();await tick();d.getElementById('settings-open-advanced').click();
 d.querySelector('[data-settings-tab="personal"]').click();await tick();
 d.getElementById('instructions-editor').value='Unsaved edit';
 const sheet=d.getElementById('settings-dialog'),grip=sheet.querySelector('.sheet-grip');
 const drag=()=>{sheetPointer(w,grip,'pointerdown',100,20);sheetPointer(w,grip,'pointermove',105,170);sheetPointer(w,grip,'pointerup',105,170);};
 drag();await answerConfirmation(d,false);assert.equal(sheet.open,true);assert.equal(d.getElementById('instructions-editor').value,'Unsaved edit');assert.equal(sheet.style.getPropertyValue('--sheet-offset'),'');
 drag();await answerConfirmation(d,true);assert.equal(sheet.open,false);
});
test('short or cancelled sheet drags stay open and do not turn into close clicks',async()=>{
 const {w}=setup({}, {mobile:true});await tick();const d=w.document;d.getElementById('composer-options').click();await tick();
 d.getElementById('model-picker-permissions').click();await tick();
 const sheet=d.getElementById('options-dialog'),grip=sheet.querySelector('.sheet-grip');
 sheetPointer(w,grip,'pointerdown',100,20);sheetPointer(w,grip,'pointermove',100,48);sheetPointer(w,grip,'pointerup',100,48);
 grip.dispatchEvent(new w.MouseEvent('click',{bubbles:true,cancelable:true,detail:1}));assert.equal(sheet.open,true);
 sheetPointer(w,grip,'pointerdown',100,20);sheetPointer(w,grip,'pointermove',100,180);sheetPointer(w,grip,'pointercancel',100,180);
 assert.equal(sheet.open,true);assert.equal(sheet.style.getPropertyValue('--sheet-offset'),'');
 // Keyboard activation remains available even immediately after a cancelled pointer gesture.
 grip.click();assert.equal(sheet.open,false);
});
test('dragging content or a desktop dialog never dismisses it',async()=>{
 for(const mobile of [true,false]){
  const {w}=setup({}, {mobile});await tick();const d=w.document;d.getElementById('composer-options').click();await tick();
  d.getElementById('model-picker-permissions').click();await tick();
  const sheet=d.getElementById('options-dialog'),target=mobile?sheet.querySelector('.dialog-head'):sheet.querySelector('.sheet-grip');
  sheetPointer(w,target,'pointerdown',100,20);sheetPointer(w,target,'pointermove',100,200);sheetPointer(w,target,'pointerup',100,200);
  assert.equal(sheet.open,true);
 }
});
test('composer keeps a stable toolbar through focus changes without losing the draft',async()=>{
 const {w}=setup();await tick();const d=w.document,composer=d.getElementById('composer'),prompt=d.getElementById('prompt');
 assert.equal(composer.classList.contains('composer-expanded'),true);prompt.value='보존할 초안';prompt.focus();assert.equal(composer.classList.contains('composer-expanded'),true);
 prompt.blur();await tick();assert.equal(prompt.value,'보존할 초안');assert.equal(composer.classList.contains('composer-expanded'),true);
});
test('project tree has one project plus and no duplicate general-chat row',async()=>{
 const {w,snapshot}=setup();await tick();w.mobileCodexEvent('state',{...snapshot,projects:[{key:'p',name:'Project',selected:true,available:true}],sessions:[{id:'s',title:'Existing',workspaceKey:'p'}]});
 const d=w.document;assert.equal(d.querySelectorAll('.general-project').length,0);assert.equal(d.querySelectorAll('.project-tree .project-new').length,1);assert.equal(d.querySelectorAll('.project-tree .project-sessions .new-thread').length,0);
});
test('session list marks background work and approval separately',async()=>{
 const {w,snapshot}=setup();await tick();w.mobileCodexEvent('state',{...snapshot,sessions:[{id:'busy',title:'Working',workspaceKey:'p',busy:true},{id:'approval',title:'Needs approval',workspaceKey:'p',approvalPending:true}]});
 assert.equal(w.document.querySelectorAll('.session-progress-indicator').length,1);assert.equal(w.document.querySelectorAll('.session-approval-indicator').length,1);
});
test('notification settings are persisted through the native bridge',async()=>{
 const {w,calls}=setup({'notifications.state':()=>({enabled:true,vibration:true}),'notifications.configure':m=>m.args});await tick();w.document.getElementById('settings').click();await tick();
 const toggle=w.document.getElementById('notifications-toggle');assert.ok(toggle);toggle.checked=false;toggle.dispatchEvent(new w.Event('change'));await tick();
 assert.deepEqual(calls.find(c=>c.action==='notifications.configure').args,{enabled:false,vibration:true});
});
test('background message deltas cannot alter the visible conversation',async()=>{
 const {w,snapshot}=setup();await tick();w.mobileCodexEvent('state',{...snapshot,threadId:'current',messages:[{id:'m',role:'assistant',text:'현재'}]});
 w.mobileCodexEvent('message.delta',{threadId:'background',id:'m',delta:' 침범'});assert.match(w.document.getElementById('messages').textContent,/현재/);assert.doesNotMatch(w.document.getElementById('messages').textContent,/침범/);
});
test('background errors do not become a toast for the visible conversation',async()=>{
 const {w,snapshot}=setup();await tick();w.mobileCodexEvent('state',{...snapshot,threadId:'current'});w.mobileCodexEvent('error',{threadId:'background',message:'다른 대화 실패'});
 assert.equal(w.document.getElementById('toast').hidden,true);w.mobileCodexEvent('error',{threadId:'current',message:'현재 대화 실패'});assert.equal(w.document.getElementById('toast').hidden,false);
});
test('request queue keeps background approvals hidden and opens them after switching sessions',async()=>{
 const {w,snapshot}=setup();await tick();
 w.mobileCodexEvent('server.request',{key:'background',method:'item/commandExecution/requestApproval',params:{threadId:'other',command:'background'}});
 assert.equal(w.document.getElementById('request-dialog').open,false);
 w.mobileCodexEvent('server.request',{key:'current',method:'item/commandExecution/requestApproval',params:{threadId:'t',command:'current'}});
 assert.equal(w.document.getElementById('request-dialog').open,true);assert.match(w.document.getElementById('request-detail').textContent,/current/);
 w.mobileCodexEvent('server.resolved',{key:'current'});assert.equal(w.document.getElementById('request-dialog').open,false);
 w.mobileCodexEvent('state',{...snapshot,threadId:'other',sessions:[{id:'other',title:'다른 대화',workspaceKey:'',approvalPending:true}]});
 assert.equal(w.document.getElementById('request-dialog').open,true);assert.match(w.document.getElementById('request-detail').textContent,/background/);
});
test('session title grows before the fixed activity indicator at the row end',async()=>{
 const {w,snapshot}=setup();await tick();w.mobileCodexEvent('state',{...snapshot,sessions:[{id:'t',title:'아주 긴 대화 제목이 잘려야 하는 항목',workspaceKey:'',busy:true}]});
 const row=w.document.querySelector('#sessions .session'),title=row.querySelector('.session-title'),indicator=row.querySelector('.session-progress-indicator');
 assert.ok(title&&indicator);assert.equal(title.nextElementSibling,indicator);assert.match(fs.readFileSync(root+'app.css','utf8'),/\.session-title\s*\{[^}]*flex:1/);
});
test('notification permission guidance follows the Android permission state',async()=>{
 let permission=false;const {w,calls}=setup({'notifications.state':()=>({enabled:true,vibration:true,permission}),'notifications.openSettings':()=>({ok:true})});await tick();
 w.document.getElementById('settings').click();await tick();await tick();const row=w.document.querySelector('.notification-permission-row');
 assert.equal(row.hidden,false);assert.equal(w.document.getElementById('notification-settings-button').textContent,'Android 通知设置');w.document.getElementById('notification-settings-button').click();await tick();
 assert.ok(calls.some(call=>call.action==='notifications.openSettings'));permission=true;w.mobileCodexEvent('notifications.changed',{});await tick();await tick();assert.equal(row.hidden,true);
});

test('Codex user messages stay fully visible even when long',async()=>{
 const {w,snapshot}=setup();await tick();
 const text='<img src=x onerror=alert(1)>\n'+'긴 사용자 메시지 '.repeat(100);
 w.mobileCodexEvent('state',{...snapshot,messages:[{id:'long-user',role:'user',text}]});
 const body=w.document.querySelector('[data-id="long-user"] .user-message-text');
 assert.equal(body.textContent,text); assert.equal(body.querySelector('img'),null);
 assert.equal(body.classList.contains('is-collapsed'),false);
 assert.equal(w.document.querySelector('.user-message-toggle'),null);
});




test('settings have no GitHub sync tab and the app never calls sync actions',async()=>{
 const {w,calls}=setup();await tick();await tick();
 const d=w.document;
 assert.equal(d.querySelector('[data-settings-tab="sync"]'),null);assert.equal(d.querySelector('[data-settings-panel="sync"]'),null);
 d.getElementById('settings').click();await tick();
 for(const tab of d.querySelectorAll('[data-settings-tab]')){tab.click();await tick();}
 assert.equal(calls.some(call=>call.action.startsWith('sync.')||call.action.startsWith('cloud.')),false);
});

test('tool errors are compact and failed buttons show feedback inside the open modal',async()=>{
 const payload='<html>private-response\n'+'diagnostic line\n'.repeat(300);
 const {w}=setup({rpc:m=>{
  if(m.args.method==='plugin/list')return {marketplaces:[],marketplaceLoadErrors:[{message:payload}]};
  if(m.args.method==='skills/list')return {data:[]};
  if(m.args.method==='mcpServerStatus/list')return {data:[{name:'GitHub',tools:{},toolsError:payload}]};
  throw Error(payload);
 }});await tick();const d=w.document;d.getElementById('show-tools').click();await tick();d.getElementById('show-tools-panel').click();await tick();await tick();
 assert.doesNotMatch(d.getElementById('tools-list').textContent,/private-response|diagnostic line/);
 const login=[...d.querySelectorAll('#tools-list button')].find(b=>b.textContent==='登录');assert.ok(login);
 login.click();await tick();const feedback=d.getElementById('toast');
 assert.equal(feedback.parentElement,d.getElementById('tools-dialog'));
 assert.equal(feedback.hidden,false);assert.match(feedback.textContent,/无法完成请求/);
 assert.equal(login.disabled,false);
});






test('GitHub sync has no settings entry or bridge traffic',async()=>{
 const {w,calls}=setup();await tick();const d=w.document;
 assert.equal(d.querySelector('[data-settings-tab="sync"]'),null);
 assert.equal(d.querySelector('[data-settings-panel="sync"]'),null);
 for(const tab of d.querySelectorAll('[data-settings-tab]')) {tab.click();await tick();}
 assert.equal(calls.some(c=>c.action.startsWith('sync.')),false);
 w.close();
});

test('terminal sends code and blank Enter to the running session without logging them',async()=>{
 let terminal={id:'',revision:0,running:false,output:'',exitCode:null};
 const {w,calls}=setup({
  'terminal.state':()=>terminal,
  'terminal.run':()=>terminal={id:'login-1',revision:1,running:true,output:'Paste code:',exitCode:null},
  'terminal.input':()=>({ok:true}),
 });await tick();const d=w.document;
 d.getElementById('show-terminal').click();await tick();
 const entry=d.getElementById('terminal-command'),form=d.getElementById('terminal-form');
 entry.value='claude auth login';form.dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();
 assert.equal(d.getElementById('terminal-submit').textContent,'发送输入');
 entry.value='fixture-private-code';form.dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();
 assert.deepEqual(calls.filter(c=>c.action==='terminal.input').at(-1).args,{id:'login-1',text:'fixture-private-code'});
 assert.equal(entry.value,'');assert.equal(entry.type,'password');
 assert.doesNotMatch(d.getElementById('terminal-output').textContent,/fixture-private-code/);
 form.dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();
 assert.equal(calls.filter(c=>c.action==='terminal.input').at(-1).args.text,'');
 assert.equal(calls.filter(c=>c.action==='terminal.run').length,1);
 d.querySelector('[data-close="terminal-dialog"]').click();d.getElementById('show-terminal').click();await tick();
 assert.equal(d.getElementById('terminal-submit').textContent,'发送输入');
 w.close();
});

test('terminal exit clears unsent code and stale input is never executed as a command',async()=>{
 let terminal={id:'login-1',revision:1,running:true,output:'Paste code:',exitCode:null};
 const {w,calls}=setup({'terminal.state':()=>terminal,'terminal.input':()=>{
  terminal={...terminal,revision:2,running:false,exitCode:1};throw Error('Terminal ended');
 }});await tick();const d=w.document;d.getElementById('show-terminal').click();await tick();
 const entry=d.getElementById('terminal-command');entry.value='expired-code';
 d.getElementById('terminal-form').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();await tick();
 assert.equal(entry.value,'');assert.equal(d.getElementById('terminal-submit').textContent,'运行');
 assert.match(d.getElementById('terminal-status').textContent,/Terminal ended/);
 assert.equal(calls.filter(c=>c.action==='terminal.run').length,0);
 w.mobileCodexEvent('terminal.state',{id:'login-1',revision:1,running:true,output:'old'});
 assert.equal(d.getElementById('terminal-submit').textContent,'运行');w.close();
});

test('terminal queue rejection keeps unsent input and leaves stop available',async()=>{
 const terminal={id:'blocked',revision:1,running:true,output:'Waiting',exitCode:null};
 const {w,calls}=setup({'terminal.state':()=>terminal,'terminal.input':()=>({ok:false,reason:'input_queue_full'}),'terminal.stop':()=>({...terminal,stopping:true})});await tick();
 const d=w.document;d.getElementById('show-terminal').click();await tick();
 d.getElementById('terminal-command').value='keep this';d.getElementById('terminal-form').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();await tick();
 assert.equal(d.getElementById('terminal-command').value,'keep this');assert.match(d.getElementById('terminal-status').textContent,/已满/);
 assert.equal(d.getElementById('terminal-stop').disabled,false);d.getElementById('terminal-stop').click();await tick();
 assert.equal(calls.filter(c=>c.action==='terminal.stop').length,1);w.close();
});

test('terminal input failure disables only input, survives reopening and still drains output',async()=>{
 let terminal={id:'failed',revision:1,running:true,output:'Waiting',exitCode:null,inputError:''};
 const {w,calls}=setup({'terminal.state':()=>terminal,'terminal.stop':()=>terminal={...terminal,revision:5,stopping:true}});await tick();
 const d=w.document,entry=d.getElementById('terminal-command'),form=d.getElementById('terminal-form');
 d.getElementById('show-terminal').click();await tick();entry.value='keep-private-code';
 w.mobileCodexEvent('terminal.inputError',{id:'failed',revision:2,reason:'input_closed'});
 assert.match(d.getElementById('terminal-status').textContent,/无法将输入发送到终端/);
 assert.equal(entry.disabled,true);assert.equal(d.getElementById('terminal-submit').disabled,true);
 assert.equal(d.getElementById('terminal-stop').disabled,false);
 form.dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();
 assert.equal(calls.filter(c=>c.action==='terminal.input').length,0);
 w.mobileCodexEvent('terminal.output',{id:'failed',revision:3,text:'Still running'});
 assert.match(d.getElementById('terminal-output').textContent,/Still running/);
 assert.doesNotMatch(d.getElementById('terminal-output').textContent,/keep-private-code/);
 terminal={...terminal,revision:3,output:'WaitingStill running',inputError:'input_closed'};
 d.querySelector('[data-close="terminal-dialog"]').click();d.getElementById('show-terminal').click();await tick();
 assert.equal(entry.value,'keep-private-code');assert.equal(entry.disabled,true);
 assert.match(d.getElementById('terminal-status').textContent,/无法将输入发送到终端/);
 d.getElementById('terminal-stop').click();await tick();
 assert.equal(calls.filter(c=>c.action==='terminal.stop').length,1);
 assert.match(d.getElementById('terminal-status').textContent,/正在停止/);w.close();
});

test('terminal closed-input rejection is persistent and distinct from queue backpressure',async()=>{
 let terminal={id:'failed',revision:1,running:true,output:'Waiting',exitCode:null};
 const {w,calls}=setup({'terminal.state':()=>terminal,'terminal.input':()=>{
  terminal={...terminal,revision:2,inputError:'input_closed'};
  return {ok:false,id:terminal.id,revision:2,reason:'input_closed'};
 }});await tick();const d=w.document;d.getElementById('show-terminal').click();await tick();
 const entry=d.getElementById('terminal-command'),form=d.getElementById('terminal-form');entry.value='private-code';
 form.dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();await tick();
 assert.match(d.getElementById('terminal-status').textContent,/无法将输入发送到终端/);
 assert.doesNotMatch(d.getElementById('terminal-status').textContent,/가득|전송했습니다/);
 assert.equal(entry.value,'private-code');assert.equal(entry.disabled,true);
 form.dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();
 assert.equal(calls.filter(c=>c.action==='terminal.input').length,1);w.close();
});

test('terminal queued acknowledgement cannot overwrite an asynchronous input failure',async()=>{
 let finish;
 const terminal={id:'failed',revision:1,running:true,output:'Waiting',exitCode:null};
 const {w}=setup({'terminal.state':()=>terminal,'terminal.input':()=>new Promise(resolve=>{finish=resolve;})});await tick();
 const d=w.document;d.getElementById('show-terminal').click();await tick();
 const entry=d.getElementById('terminal-command');entry.value='private-code';
 d.getElementById('terminal-form').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();
 w.mobileCodexEvent('terminal.inputError',{id:'failed',revision:2,reason:'input_closed'});
 finish({ok:true,queued:true,id:'failed'});await tick();
 assert.match(d.getElementById('terminal-status').textContent,/无法将输入发送到终端/);
 assert.equal(entry.value,'private-code');assert.equal(entry.disabled,true);w.close();
});

test('terminal ignores stale input errors and late replies after a replacement',async()=>{
 for (const reply of ['accepted','rejected','exception']) {
  let finish,fail,terminal={id:'old',revision:1,running:true,output:'Old',exitCode:null};
  const {w}=setup({'terminal.state':()=>terminal,'terminal.input':()=>new Promise((resolve,reject)=>{finish=resolve;fail=reject;})});await tick();
  const d=w.document;d.getElementById('show-terminal').click();await tick();
  const entry=d.getElementById('terminal-command');entry.value='old-secret';
  d.getElementById('terminal-form').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();
  terminal={id:'new',revision:5,running:true,output:'New',exitCode:null,inputError:''};
  w.mobileCodexEvent('terminal.state',terminal);entry.value='new-draft';
  w.mobileCodexEvent('terminal.inputError',{id:'old',revision:100,reason:'input_closed'});
  w.mobileCodexEvent('terminal.inputError',{id:'new',revision:4,reason:'input_closed'});
  if (reply==='exception') fail(new Error('Old terminal failed'));
  else finish(reply==='accepted'?{ok:true,queued:true,id:'old'}:{ok:false,reason:'input_closed',id:'old',revision:2});
  await tick();await tick();
  assert.equal(entry.value,'new-draft',reply);assert.equal(entry.disabled,false,reply);
  assert.equal(d.getElementById('terminal-submit').disabled,false,reply);
  assert.equal(d.getElementById('terminal-output').textContent,'New',reply);
  assert.equal(d.getElementById('terminal-status').textContent,'输入将发送到正在运行的程序。',reply);w.close();
 }
});

test('terminal ignores failure events after stopping and restores failed state on a fresh view',async()=>{
 const terminal={id:'failed',revision:2,running:true,output:'Waiting',exitCode:null,inputError:'input_closed'};
 const {w}=setup({'terminal.state':()=>terminal},{language:'en'});await tick();
 const d=w.document;d.getElementById('show-terminal').click();await tick();
 assert.equal(d.getElementById('terminal-command').disabled,true);
 assert.match(d.getElementById('terminal-status').textContent,/Could not send input/);
 w.mobileCodexEvent('terminal.state',{...terminal,revision:3,stopping:true});
 const stopping=d.getElementById('terminal-status').textContent;
 w.mobileCodexEvent('terminal.inputError',{id:'failed',revision:4,reason:'input_closed'});
 assert.equal(d.getElementById('terminal-status').textContent,stopping);
 w.mobileCodexEvent('terminal.state',{...terminal,revision:5,stopping:false,running:false,exitCode:1});
 assert.equal(d.getElementById('terminal-command').disabled,false);
 assert.equal(d.getElementById('terminal-submit').textContent,'Run');w.close();
});

test('deleting unrelated projects and conversations remains available during Codex work',async()=>{
 for (const mode of ['busy','background']) {
  const {w,calls,snapshot}=setup();await tick();const d=w.document;
  const projects=[{key:'a',name:'A',available:true},{key:'b',name:'B',available:true}];
  const sessions=[{id:'a-chat',title:'A chat',workspaceKey:'a',busy:true},{id:'b-chat',title:'B chat',workspaceKey:'b',busy:false}];
  const current={...snapshot,threadId:mode==='background'?'b-chat':'a-chat',workspace:{key:mode==='background'?'b':'a',selected:true},projects,sessions,[mode==='background'?'busy':mode]:mode!=='background'};
  w.mobileCodexEvent('state',current);
  d.querySelector('[data-project-menu-key="b"]').click();await tick();
  const removal=()=>[...d.querySelectorAll('#project-actions button')].find(b=>b.textContent==='从项目列表中移除');
  assert.equal(removal().disabled,false);
  w.mobileCodexEvent('state',current);assert.equal(removal().disabled,false,'live updates preserve target-scoped availability');
  removal().click();await tick();d.querySelector('#project-remove-card .danger').click();await tick();assert.deepEqual(calls.find(c=>c.action==='projects.remove').args,{key:'b'});
  d.querySelector('[data-project-menu-key="a"]').click();await tick();assert.equal(removal().disabled,true);
  w.mobileCodexBack();
  [...d.querySelectorAll('.session-more')].find(b=>b.getAttribute('aria-label')==='B chat 操作').click();await tick();
  d.querySelector('[data-session-delete]').click();await tick();
 d.querySelector('[data-session-delete]').click();await tick();
  assert.deepEqual(calls.find(c=>c.action==='chat.delete').args,{id:'b-chat'});
 }
});
