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

test('subagent counts restore from the current turn, then show only the final total',async()=>{
 const {w,state,flush}=setup({busy:true,turnId:'one',subagentUsage:{turnId:'one',total:3,running:1}});
 await tick();flush();const counter=w.document.getElementById('subagent-usage');
 assert.equal(counter.textContent,'本轮已启动子代理：3 · 运行中：1');
 w.mobileCodexEvent('state',{...state,busy:false,turnId:'',subagentUsage:{turnId:'one',total:3}});
 assert.equal(counter.textContent,'本轮已启动子代理：3');
 w.mobileCodexEvent('state',{...state,turnId:'two'});assert.equal(counter.hidden,true);assert.equal(counter.textContent,'');
 w.mobileCodexEvent('state',{...state,turnId:'two',subagentUsage:{turnId:'two',total:0,running:0}});
 assert.equal(counter.hidden,true);assert.equal(counter.textContent,'');
 w.mobileCodexEvent('state',{...state,turnId:'two',subagentUsage:{turnId:'two',total:1,running:0}});
 assert.equal(counter.hidden,false);assert.equal(counter.textContent,'本轮已启动子代理：1 · 运行中：0');
 w.mobileCodexEvent('state',{...state,threadId:'other',busy:false,subagentUsage:null});assert.equal(counter.hidden,true);
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

test('long provider names stay outside the composer and a draft exposes Send during work',async()=>{
 const {w,flush,state}=setup({busy:true});await tick();flush();const d=w.document;
 assert.equal(d.getElementById('model-summary').textContent,'gpt-6.1-sol');
 assert.equal(d.getElementById('stop').hidden,false);assert.equal(d.getElementById('send').hidden,true);
 const prompt=d.getElementById('prompt');prompt.value='再检查测试';prompt.dispatchEvent(new w.Event('input'));flush();
 assert.equal(d.getElementById('stop').hidden,true);assert.equal(d.getElementById('send').hidden,false);
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


test('latest-message shortcut waits for whole task completion and stays centered',async()=>{
 const {w,state,flush}=setup({busy:true,turnId:'one',messages:[{id:'progress',role:'assistant',text:'正在检查文件'}]});await tick();flush();
 const d=w.document,area=d.getElementById('chat-scroll'),jump=d.getElementById('jump-latest');
 Object.defineProperties(area,{scrollHeight:{configurable:true,value:1400},clientHeight:{configurable:true,value:400}});
 area.scrollTop=0;area.dispatchEvent(new w.Event('scroll'));assert.equal(jump.hidden,true);
 w.mobileCodexEvent('message.delta',{threadId:'test',id:'progress',delta:'，接着运行测试'});flush();assert.equal(jump.hidden,true);
 w.mobileCodexEvent('state',{...state,busy:false,turnId:''});flush();assert.equal(jump.hidden,false);
 jump.click();await tick();assert.equal(jump.hidden,true);
 const css=fs.readFileSync(path.join(web,'app.css'),'utf8');
 assert.match(css,/left: 50%; transform: translateX\(-50%\)/);
 assert.match(css,/@keyframes latest-enter \{ from \{ opacity: 0; \} to \{ opacity: 1; \} \}/);
});


test('snapshot and streaming changes above the reader keep the same visible message offset',async()=>{
 for(const mode of ['snapshot','stream']) {
  const {w,state,flush}=setup({busy:true,turnId:'turn',messages:[{id:'head',role:'assistant',text:'short'},{id:'reading',role:'assistant',text:'Read this paragraph'},{id:'tail',role:'assistant',text:'Working'}]});await tick();flush();
  const d=w.document,area=d.getElementById('chat-scroll');
  Object.defineProperties(area,{scrollHeight:{get:()=>1500},clientHeight:{value:400}});
  area.getBoundingClientRect=()=>({top:0,bottom:400});
  for(const el of d.querySelectorAll('#messages > article')) el.getBoundingClientRect=()=>{
   const headHeight=d.querySelector('[data-id="head"]').textContent.includes('expanded')?250:100;
   const top=(el.dataset.id==='head'?0:el.dataset.id==='reading'?headHeight:headHeight+400)-area.scrollTop;
   return {top,bottom:top+(el.dataset.id==='head'?headHeight:400)};
  };
  area.scrollTop=150;area.dispatchEvent(new w.Event('scroll'));
  const reader=d.querySelector('[data-id="reading"]');assert.equal(reader.getBoundingClientRect().top,-50);
  if(mode==='snapshot')w.mobileCodexEvent('state',{...state,messages:[{...state.messages[0],text:'expanded'},...state.messages.slice(1)]});
  else w.mobileCodexEvent('message.delta',{threadId:'test',id:'head',delta:' expanded'});
  flush();assert.equal(area.scrollTop,300,mode);assert.equal(reader.getBoundingClientRect().top,-50,mode);
  w.mobileCodexEvent('state',{...state,busy:false,turnId:'',messages:[{...state.messages[0],text:'expanded'},...state.messages.slice(1)]});flush();
  assert.equal(area.scrollTop,300,'completion preserves the reading position');
  assert.equal(d.getElementById('jump-latest').hidden,false);
 }
});

test('tool activity follows the tail only while the reader is following',async()=>{
 const {w,flush}=setup({busy:true,messages:[{id:'a',role:'assistant',text:'Working'}]});await tick();flush();
 const d=w.document,area=d.getElementById('chat-scroll');
 Object.defineProperties(area,{scrollHeight:{value:1240},clientHeight:{value:400}});
 d.getElementById('jump-latest').click();
 w.mobileCodexEvent('tool',{threadId:'test',name:'mobile_read',path:'one.txt'});assert.equal(area.scrollTop,1240);
 area.scrollTop=100;area.dispatchEvent(new w.Event('scroll'));
 w.mobileCodexEvent('tool',{threadId:'test',name:'mobile_read',path:'two.txt'});assert.equal(area.scrollTop,100);
});

test('a final answer folds its own commentary, preserves the original answer and omits the redundant app summary',async()=>{
 const msg=(id,text,phase,completedTurnId='one')=>({id,text,role:'assistant',phase,completedTurnId});
 const messages=[msg('step1','找到目录','commentary'),msg('step2','另存文件','commentary')];
 const {w,state,flush}=setup({busy:true,turnId:'one',messages});await tick();flush();
 const d=w.document,article=id=>d.querySelector(`[data-id="${id}"]`);
 assert.equal(article('step1').hidden,false);assert.equal(d.querySelector('.work-toggle'),null);
 const done={...state,busy:false,turnId:'',messages:[...messages,msg('final','已保存 report.html','final_answer'),
  {id:'old-summary',role:'assistant',kind:'taskSummary',summary:{status:'completed'}},msg('other','检查失败前的进展','commentary','two')]};
 w.mobileCodexEvent('state',done);flush();const toggle=d.querySelector('.work-toggle');
 assert.equal(toggle.textContent,'查看工作过程（2）');assert.equal(article('step1').hidden,true);
 assert.equal(article('final').hidden,false);assert.match(article('final').textContent,/report.html/);
 assert.equal(article('other').hidden,false);assert.equal(article('old-summary'),null);
 toggle.click();await tick();flush();assert.equal(article('step2').hidden,false);
 w.mobileCodexEvent('state',done);flush();assert.equal(toggle.getAttribute('aria-expanded'),'true');
 toggle.click();await tick();assert.equal(article('step2').hidden,true);
 w.mobileCodexEvent('state',{...done,threadId:'other',messages:[]});flush();assert.equal(d.querySelector('.work-toggle'),null);
 w.mobileCodexEvent('state',done);flush();assert.equal(article('step1').hidden,true);
});

test('public turn progress separates quiet model output from the local engine, scopes updates and clears on completion',async()=>{
 const now=Date.now(), p={turnId:'one',phase:'reasoning',lastEventAt:now-35000,engineReplyAt:now,summary:'检查配置\n\n核对请求'};
 const {w,state,flush}=setup({busy:true,turnId:'one',turnProgress:p});await tick();flush();
 const d=w.document,el=id=>d.getElementById(id),fire=(name,data)=>{w.mobileCodexEvent(name,data);flush();};
 assert.match(el('activity-text').textContent,/等待新的任务进展/);assert.match(el('turn-connection').textContent,/^思考 \d+ 秒了$/);assert.match(el('turn-connection').title,/本机引擎 \d+ 秒前有回应/);
 assert.equal(el('turn-summary-text').textContent,p.summary);el('turn-summary').open=true;
 for(const [threadId,turnId] of [['other','one'],['test','old']])fire('turn.progress',{threadId,progress:{...p,turnId,summary:'stale'}});
 assert.equal(el('turn-summary-text').textContent,p.summary);
 fire('state',{...state,streamRetrying:true});assert.match(el('activity-text').textContent,/响应流中断/);
 fire('state',{...state,threadId:'away',turnProgress:null});assert.equal(el('turn-summary').hidden,true);
 fire('state',state);assert.equal(el('turn-summary').open,false);assert.equal(el('turn-summary-text').textContent,p.summary);
 fire('server.request',{key:'a',method:'item/commandExecution/requestApproval',params:{threadId:'test',turnId:'one'}});
 fire('turn.progress',{threadId:'test',progress:{...p,lastEventAt:now}});assert.match(el('activity-text').textContent,/等待审批/);
 fire('server.resolved',{key:'a'});fire('state',{...state,busy:false,turnId:'',turnProgress:null});
 fire('turn.progress',{threadId:'test',progress:p});assert.equal(el('turn-summary').hidden,true);assert.equal(el('turn-connection').hidden,true);
});
