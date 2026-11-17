const {test,afterEach}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('jsdom');
const web=path.join(__dirname,'../app/src/main/assets/web');
const opened=[];
afterEach(()=>{for(const dom of opened.splice(0))dom.window.close();});
const tick=()=>new Promise(resolve=>setTimeout(resolve,10));
function setup(extra={},overrides={}) {
 const dom=new JSDOM(fs.readFileSync(path.join(web,'index.html'),'utf8'),{url:'https://appassets.androidplatform.net/index.html',runScripts:'outside-only'});opened.push(dom);
 const w=dom.window,calls=[],frames=[];
 const state={ready:true,busy:false,permissions:'workspace-write',status:'Connected',threadId:'test',cwd:'/project',workspace:{selected:true,key:'project',name:'Project',available:true},apiActive:'proxy',apiProviders:[{id:'proxy',name:'Proxy',hasKey:true,models:['gpt-6.1-sol'],baseUrl:'https://proxy.example/v1'}],models:[{id:'gpt-6.1-sol',model:'gpt-6.1-sol',displayName:'openai · gpt-6.1-sol',isDefault:true}],messages:[],sessions:[],projects:[],...extra};
 w.matchMedia=()=>({matches:false,addEventListener(){}});
 w.requestAnimationFrame=callback=>frames.push(callback);
 w.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
 w.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');this.dispatchEvent(new w.Event('close'));};
 w.Native={locale:()=>JSON.stringify({choice:'zh-CN',systemLanguage:'zh-CN'}),postMessage(raw){const message=JSON.parse(raw);calls.push(message);queueMicrotask(async()=>{try{const result=overrides[message.action]?await overrides[message.action](message):message.action==='state'?state:message.action==='rpc'?{data:[],marketplaces:[]}:{};w.mobileCodexEvent('response',{id:message.id,result});}catch(error){w.mobileCodexEvent('response',{id:message.id,error:error.message});}});}};
 for(const script of w.document.querySelectorAll('script[src]')) w.eval(fs.readFileSync(path.join(web,script.getAttribute('src')),'utf8'));
 const flush=()=>{let count=0;while(frames.length){assert.ok(++count<100,'animation frames settle');const queued=frames.splice(0);for(const callback of queued)callback();}};
 return {w,calls,state,frames,flush};
}

test('API-only startup configures providers without subscription auth and preserves a draft',async()=>{
 const {w,calls,flush}=setup({apiActive:'',apiProviders:[],models:[]});await tick();flush();
 const d=w.document,prompt=d.getElementById('prompt');prompt.value='保留我的草稿';
 d.getElementById('configure-api').click();await tick();flush();
 assert.equal(d.documentElement.lang,'zh-CN');assert.equal(d.getElementById('settings-dialog').open,true);
 assert.equal(d.querySelector('[data-settings-panel="providers"]').hidden,false);
 assert.equal(prompt.value,'保留我的草稿');
 assert.equal(calls.some(call=>call.action.startsWith('auth.')||call.action.startsWith('live.')),false);
 for(const id of ['account-button','login-dialog','usage-limits','live-start','invite-dialog'])assert.equal(d.getElementById(id),null);
});

test('stream chunks share a frame and leave earlier message content untouched',async()=>{
 const {w,flush}=setup({busy:true,messages:[{id:'old',role:'assistant',text:'之前的正文'},{id:'tail',role:'assistant',text:'开始',status:'streaming'}]});await tick();flush();
 const d=w.document,old=d.querySelector('[data-id="old"]'),oldContent=old.firstChild,tail=d.querySelector('[data-id="tail"]');
 for(const delta of ['一','二','三'])w.mobileCodexEvent('message.delta',{threadId:'test',id:'tail',delta});
 assert.doesNotMatch(tail.textContent,/一二三/);
 flush();assert.match(tail.textContent,/开始一二三/);assert.equal(old.firstChild,oldContent);
 assert.equal(d.querySelector('[data-id="tail"]'),tail);
 w.mobileCodexEvent('message.delta',{threadId:'other',id:'tail',delta:'越界'});flush();assert.doesNotMatch(tail.textContent,/越界/);
});

test('long provider names stay outside the composer and Stop stays reachable during work',async()=>{
 const {w,flush,state}=setup({busy:true});await tick();flush();const d=w.document;
 assert.equal(d.getElementById('model-summary').textContent,'gpt-6.1-sol');
 assert.equal(d.getElementById('stop').hidden,false);assert.equal(d.getElementById('send').hidden,true);
 const prompt=d.getElementById('prompt');prompt.value='再检查测试';prompt.dispatchEvent(new w.Event('input'));flush();
 assert.equal(d.getElementById('stop').hidden,false);assert.equal(d.getElementById('send').hidden,false);
 w.mobileCodexEvent('state',{...state,busy:false});flush();assert.equal(d.getElementById('stop').hidden,true);
 assert.equal(d.getElementById('send').hidden,false);assert.equal(prompt.value,'再检查测试');
});

test('subagent settings write runtime-verified keys and do not claim a model test',async()=>{
 let content='[features]\nmulti_agent = false\n\n[agents]\nmax_concurrent_threads_per_session = 1\n';
 const {w,calls,flush}=setup({}, {'config.read':()=>({content}),'config.save':message=>{content=message.args.content;return {};}});await tick();flush();
 const d=w.document;d.getElementById('subagents-enabled').checked=true;d.getElementById('subagents-limit').value='2';d.getElementById('subagents-save').click();await tick();flush();
 assert.match(content,/multi_agent = true/);assert.match(content,/max_threads = 2/);assert.doesNotMatch(content,/max_concurrent_threads_per_session/);
 assert.ok(calls.some(call=>call.action==='config.save'));assert.ok(calls.some(call=>call.action==='runtime.start'));
 assert.match(d.getElementById('subagents-status').textContent,/测试.*spawn_agent/);
 assert.equal(calls.some(call=>call.action==='chat.send'),false);
});

test('subagent changes wait until a running task is complete',async()=>{
 const {w,calls,flush}=setup({busy:true});await tick();flush();const d=w.document;
 assert.equal(d.getElementById('subagents-save').disabled,true);assert.equal(d.getElementById('subagents-test').disabled,true);
 d.getElementById('subagents-save').click();await tick();assert.equal(calls.some(call=>call.action==='config.save'),false);
});
