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
 w.confirm=()=>{throw new Error('Unexpected native confirmation');};
 w.Native={locale:()=>JSON.stringify({choice:'zh-CN',systemLanguage:'zh-CN'}),postMessage(raw){const message=JSON.parse(raw);calls.push(message);queueMicrotask(async()=>{try{const result=overrides[message.action]?await overrides[message.action](message):message.action==='state'?state:message.action==='rpc'?{data:[],marketplaces:[]}:{};w.mobileCodexEvent('response',{id:message.id,result});}catch(error){w.mobileCodexEvent('response',{id:message.id,error:error.message});}});}};
 for(const script of w.document.querySelectorAll('script[src]')) w.eval(fs.readFileSync(path.join(web,script.getAttribute('src')),'utf8'));
 const flush=()=>{let count=0;while(frames.length){assert.ok(++count<100,'animation frames settle');const queued=frames.splice(0);for(const callback of queued)callback();}};
 return {w,calls,state,frames,flush};
}
function touch(target,type,clientY) {
 const event=new target.ownerDocument.defaultView.Event(type,{bubbles:true});
 Object.defineProperty(event,'touches',{value:clientY == null ? [] : [{clientY,identifier:1}]});
 target.dispatchEvent(event);
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

test('a stale chat can rebind to the same provider only after confirmation', async () => {
 const {w, calls, state, flush} = setup({apiScope:'proxy:1', apiCanRebind:true, authState:'unconfigured', models:[],
  messages:[{id:'history', role:'user', text:'历史消息'}]}, {
  'chat.provider.rebind': () => ({...state, apiScope:'proxy:2', apiCanRebind:false, authState:'configured'})
 });
 await tick(); flush();
 const document = w.document;
 const header = document.getElementById('header-api');
 const picker = document.getElementById('picker-provider');
 const confirmation = document.getElementById('confirm-dialog');
 assert.equal(header.textContent, 'API · 重新绑定');
 document.getElementById('header-more').click(); await Promise.resolve();
 assert.equal(document.getElementById('header-menu-dialog').open, true);
 header.click(); await tick(); flush();
 assert.equal(document.getElementById('header-menu-dialog').open, false);
 assert.equal(document.getElementById('model-picker').open, true);
 assert.equal(document.getElementById('model-picker').classList.contains('show-models'), true);
 assert.equal(picker.disabled, false);
 assert.equal(picker.value, '');
 const choose = () => { picker.value = 'proxy'; picker.dispatchEvent(new w.Event('change')); };
 choose(); await tick();
 assert.equal(confirmation.open, true);
 assert.equal(calls.some(call => call.action === 'chat.provider.rebind'), false);
 document.getElementById('confirm-cancel').click(); await tick();
 assert.equal(confirmation.open, false);
 assert.equal(picker.value, '');
 assert.equal(calls.some(call => call.action === 'chat.provider.rebind'), false);
 choose(); await Promise.resolve();
 assert.equal(confirmation.open, true);
 assert.match(document.getElementById('confirm-message').textContent, /本地消息和项目会保留/);
 document.getElementById('confirm-accept').click(); await tick(); flush();
 assert.equal(confirmation.open, false);
 const rebind = calls.find(call => call.action === 'chat.provider.rebind');
 assert.equal(rebind.args.id, 'proxy');
 assert.equal(rebind.args.expectedThreadId, 'test');
 assert.equal(rebind.args.expectedApiScope, 'proxy:1');
 assert.equal(picker.disabled, true);
 assert.match(w.document.getElementById('messages').textContent, /历史消息/);
});

test('changing the language translates live labels without replacing notification switches', async () => {
 const {w,flush}=setup({apiCanRebind:true,conversationFailure:{code:'upstream_auth'}});
 await tick(); flush();
 const doc=w.document, element=id=>doc.getElementById(id), notification=element('notifications-toggle');
 notification.checked=false;
 const select=element('language');
 select.value='en'; select.dispatchEvent(new w.Event('change'));
 await tick(); flush();
 assert.equal(doc.documentElement.lang,'en');
 assert.equal(element('header-api').textContent,'API · Reconnect');
 assert.equal(element('picker-provider').options[0].textContent,'Reconnect API');
 assert.match(element('conversation-failure-message').textContent,/rejected authentication/);
 assert.equal(element(notification.getAttribute('aria-labelledby')).textContent,'Task notifications');
 assert.equal(element('notifications-toggle'),notification);
 assert.equal(notification.checked,false);
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


test('an upward swipe pauses streaming follow before the first scroll event',async()=>{
 const {w,state,flush}=setup({busy:true,turnId:'one',messages:[{id:'progress',role:'assistant',text:'正在检查文件'}]});await tick();flush();
 const d=w.document,area=d.getElementById('chat-scroll'),jump=d.getElementById('jump-latest');
 let height=1400,top=0;
 Object.defineProperties(area,{scrollHeight:{get:()=>height},clientHeight:{value:400},
  scrollTop:{get:()=>top,set:value=>{top=Math.max(0,Math.min(value,height-area.clientHeight));}}});
 const delta=text=>{w.mobileCodexEvent('message.delta',{threadId:'test',id:'progress',delta:text});flush();};
 area.scrollTop=1000;area.dispatchEvent(new w.Event('scroll'));assert.equal(jump.hidden,true);
 const originalParagraph=area.querySelector('.prose-line');
 touch(originalParagraph,'touchstart',200);height=1500;delta('，接着运行测试');assert.equal(area.scrollTop,1000);
 assert.equal(originalParagraph.isConnected,false);
 touch(originalParagraph,'touchend');assert.equal(area.scrollTop,1100);assert.equal(jump.hidden,true);
 touch(area,'touchstart',200);touch(area,'touchmove',212);assert.equal(jump.hidden,true);
 height=1600;delta('，还有更多输出');assert.equal(area.scrollTop,1100);
 assert.equal(jump.hidden,false);
 area.scrollTop=1080;area.dispatchEvent(new w.Event('scroll'));assert.equal(jump.hidden,false);
 touch(area,'touchend');assert.equal(area.scrollTop,1080);
 area.scrollTop=1200;area.dispatchEvent(new w.Event('scroll'));assert.equal(jump.hidden,true);
 area.scrollTop=1170;area.dispatchEvent(new w.Event('scroll'));assert.equal(jump.hidden,true);
 w.mobileCodexEvent('state',{...state,busy:false,turnId:''});flush();assert.equal(jump.hidden,true);
 const css=fs.readFileSync(path.join(web,'app.css'),'utf8');
 assert.match(css,/left: 50%; transform: translateX\(-50%\)/);
 assert.match(css,/@keyframes latest-enter \{ from \{ opacity: 0; \} to \{ opacity: 1; \} \}/);
});

test('a touch at the oldest edge loads history once per gesture without a scroll event',async()=>{
 const {w,calls,flush}=setup({messages:[{id:'recent',role:'assistant',text:'最近的消息'}],
  messageHistory:{beforeId:'recent',hasMore:true,total:2}}, {'chat.history':()=>{
  if(calls.filter(call=>call.action==='chat.history').length===1) throw Error('offline');
  return {threadId:'test',messages:[{id:'older',role:'user',text:'更早的消息'}],messageHistory:{beforeId:'',hasMore:false,total:2}};
 }});
 await tick();flush();
 const area=w.document.getElementById('chat-scroll');
 const requestCount=()=>calls.filter(call=>call.action==='chat.history').length;
 touch(area,'touchstart',200);touch(area,'touchmove',180);assert.equal(requestCount(),0);
 touch(area,'touchmove',212);await tick();assert.equal(requestCount(),1);
 touch(area,'touchmove',224);await tick();assert.equal(requestCount(),1);
 touch(area,'touchcancel');touch(area,'touchstart',200);touch(area,'touchmove',212);await tick();flush();
 assert.equal(requestCount(),2);
 assert.deepEqual([...w.document.querySelectorAll('#messages > article')].map(row=>row.dataset.id),['older','recent']);
});

test('a new swipe recovers when a rendered touch target disappears without a touchend',async()=>{
 const history={beforeId:'recent',hasMore:true,total:2};
 const {w,calls,state,flush}=setup({messages:[{id:'recent',role:'assistant',text:'Original paragraph'}],messageHistory:history},{
  'chat.history':()=>({threadId:'test',messages:[{id:'older',role:'user',text:'Earlier message'}],messageHistory:{beforeId:'',hasMore:false,total:2}})
 });await tick();flush();
 const area=w.document.getElementById('chat-scroll'),paragraph=area.querySelector('.prose-line');
 touch(paragraph,'touchstart',200);
 w.mobileCodexEvent('state',{...state,messages:[{id:'recent',role:'assistant',text:'Paragraph replaced during rendering'}]});flush();
 assert.equal(paragraph.isConnected,false);
 touch(area,'touchstart',200);touch(area,'touchmove',220);touch(area,'touchend');await tick();flush();
 assert.equal(calls.filter(call=>call.action==='chat.history').length,1);
 assert.ok(w.document.querySelector('[data-id="older"]'));
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
  assert.equal(d.getElementById('jump-latest').hidden,true);
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
 assert.equal(d.getElementById('jump-latest').hidden,true);
});

test('latest shortcut appears for new assistant results in a snapshot and resets when switching chats',async()=>{
 const reply={id:'reply',role:'assistant',text:'Earlier answer'};
 const {w,state,flush}=setup({messages:[reply]});await tick();flush();
 const d=w.document,area=d.getElementById('chat-scroll'),jump=d.getElementById('jump-latest');
 Object.defineProperties(area,{scrollHeight:{value:1600},clientHeight:{value:400}});
 area.scrollTop=1200;area.dispatchEvent(new w.Event('scroll'));
 area.scrollTop=200;area.dispatchEvent(new w.Event('scroll'));
 const image={id:'image',role:'assistant',kind:'image',imageStatus:'generating'};
 const messages=[{id:'history',role:'assistant',text:'Loaded from history'},reply,{id:'question',role:'user',text:'Next question'},image];
 w.mobileCodexEvent('state',{...state,busy:true,messages});flush();
 assert.equal(jump.hidden,true);
 const completed=[...messages.slice(0,-1),{...image,imageStatus:'completed',images:[{id:'result',url:'/images/result'}]}];
 w.mobileCodexEvent('state',{...state,messages:completed});flush();
 assert.equal(jump.hidden,false);
 assert.equal(area.scrollTop,200);
 jump.click();await tick();flush();
 area.scrollTop=200;area.dispatchEvent(new w.Event('scroll'));
 w.mobileCodexEvent('state',{...state,messages:completed.map(message=>({...message}))});flush();
 assert.equal(jump.hidden,true,'a repeated snapshot does not mark already seen results unread');
 w.mobileCodexEvent('state',{...state,messages:[...completed,{id:'new',role:'assistant',text:'New answer'}]});flush();
 assert.equal(jump.hidden,false);
 w.mobileCodexEvent('state',{...state,threadId:'other',messages:[reply]});flush();
 assert.equal(jump.hidden,true);
 area.scrollTop=200;area.dispatchEvent(new w.Event('scroll'));
 assert.equal(jump.hidden,true);
});

test('a shifted message window only marks newly appended assistant output unread',async()=>{
 const reply={id:'reply',role:'assistant',text:'Visible answer'};
 const tail={id:'tail',role:'user',text:'Most recent question'};
 const {w,state,flush}=setup({messages:[reply,tail],messageHistory:{total:5}});await tick();flush();
 const area=w.document.getElementById('chat-scroll'),jump=w.document.getElementById('jump-latest');
 Object.defineProperties(area,{scrollHeight:{value:1600},clientHeight:{value:400}});
 area.scrollTop=200;area.dispatchEvent(new w.Event('scroll'));
 const publish=(messages,total)=>{w.mobileCodexEvent('state',{...state,messages,messageHistory:{total}});flush();};
 publish([reply,{id:'earlier',role:'assistant',text:'Earlier history only'}],5);
 assert.equal(jump.hidden,true,'older messages after an overlap are not new without the known tail');
 publish([{id:'past',role:'assistant',text:'Historical answer'},tail],5);
 assert.equal(jump.hidden,true,'a disjoint historical window has no new output');
 publish([{id:'past',role:'assistant',text:'Historical answer'},{id:'new',role:'assistant',text:'New answer'}],6);
 assert.equal(jump.hidden,false,'the increment in the total identifies the new tail');
});

test('a final answer merges adjacent progress and folds independently across an in-flight user message',async()=>{
 const msg=(id,text,phase,completedTurnId='one')=>({id,text,role:'assistant',phase,completedTurnId});
 const tool=(id,activityKind)=>({id,kind:'toolActivity',activityKind,activityTurnId:'one',completed:true,command:'ls'});
 const messages=[msg('step1','找到目录','commentary'),tool('command','command'),tool('edit','editing'),
  msg('checks','完成检查','commentary'),{id:'follow-up',role:'user',text:'请另存'},
  msg('step2','另存文件','commentary'),tool('second-command','command'),msg('step3','确认结果','commentary')];
 const {w,state,flush}=setup({busy:true,turnId:'one',messages});await tick();flush();
 const d=w.document,article=id=>d.querySelector(`[data-id="${id}"]`);
 assert.equal(article('step1').hidden,false);assert.equal(d.querySelector('.work-toggle:not(.tool-group)'),null);
 const commandGroup=d.querySelector('.tool-group');assert.equal(commandGroup.hidden,false);
 const done={...state,busy:false,turnId:'',messages:[...messages,msg('final','已保存 report.html','final_answer'),tool('late-check','command'),
  {id:'old-summary',role:'assistant',kind:'taskSummary',summary:{status:'completed'}},msg('other','检查失败前的进展','commentary','two')]};
 w.mobileCodexEvent('state',done);flush();
 const sections=d.querySelectorAll('.work-toggle:not(.tool-group)');assert.equal(sections.length,3);
 const [toggle,later,afterReply]=sections;
 assert.equal(toggle.textContent,'查看工作过程（4）');assert.equal(article('step1').hidden,true);
 assert.equal(later.textContent,'查看工作过程（3）');assert.equal(later.previousElementSibling,article('follow-up'));
 assert.equal(afterReply.previousElementSibling,article('final'));
 assert.equal(article('follow-up').hidden,false);
 assert.equal(commandGroup.hidden,true);assert.equal(article('command').hidden,true);assert.equal(article('late-check').hidden,true);
 assert.equal(article('final').hidden,false);assert.match(article('final').textContent,/report.html/);
 assert.equal(article('other').hidden,false);assert.equal(article('old-summary'),null);
 later.click();await tick();flush();assert.equal(article('step2').hidden,false);assert.equal(article('step3').hidden,false);
 assert.equal(article('step1').hidden,true);assert.equal(article('checks').hidden,true);
 toggle.click();await tick();flush();assert.equal(article('step1').hidden,false);assert.equal(article('checks').hidden,false);
 assert.equal(commandGroup.hidden,false);assert.equal(article('command').hidden,true);
 commandGroup.click();await tick();assert.equal(article('command').hidden,false);
 w.mobileCodexEvent('state',done);flush();assert.equal(toggle.getAttribute('aria-expanded'),'true');
 toggle.click();await tick();assert.equal(article('step1').hidden,true);assert.equal(article('step2').hidden,false);
 assert.equal(commandGroup.hidden,true);assert.equal(article('command').hidden,true);
 w.mobileCodexEvent('state',{...done,threadId:'other',messages:[]});flush();assert.equal(d.querySelector('.work-toggle'),null);
 w.mobileCodexEvent('state',done);flush();assert.equal(article('step1').hidden,true);
});

test('empty assistant messages do not split completed work or leave blank rows',async()=>{
 const commentary=(id,text)=>({id,role:'assistant',text,phase:'commentary',completedTurnId:'one'});
 const tool=(id)=>({id,kind:'toolActivity',activityKind:'command',activityTurnId:'one',completed:true});
 const messages=[commentary('first','开始检查'),tool('command'),commentary('empty',' \n '),
  tool('next-command'),{id:'placeholder',role:'assistant',text:''},commentary('second','检查完毕'),
  {id:'answer',role:'assistant',text:'最终答复',phase:'final_answer',completedTurnId:'one'}];
 const {w,state,flush}=setup({messages});await tick();flush();
 const d=w.document,row=id=>d.querySelector(`[data-id="${id}"]`);
 const sections=d.querySelectorAll('.work-toggle:not(.tool-group)');
 assert.equal(sections.length,1);
 const [toggle]=sections;
 assert.equal(toggle.textContent,'查看工作过程（4）');
 assert.deepEqual([...d.querySelectorAll('#messages > :not([hidden])')],[toggle,row('answer')]);
 toggle.click();await tick();flush();
 assert.equal(row('empty').hidden,true);assert.equal(row('placeholder').hidden,true);
 assert.equal(row('first').hidden,false);assert.equal(row('second').hidden,false);
 assert.equal(d.querySelector('.tool-group').textContent,'运行了 2 条命令');
 w.mobileCodexEvent('state',{...state,busy:true,turnId:'two',messages:[...messages,{id:'streaming',role:'assistant',text:'',status:'streaming'}]});flush();
 assert.equal(row('streaming').hidden,true);
 w.mobileCodexEvent('message.delta',{threadId:'test',id:'streaming',delta:'新回复'});flush();
 assert.equal(row('streaming').hidden,false);assert.match(row('streaming').textContent,/新回复/);
});

test('adjacent completed searches collapse while an in-flight search stays visible',async()=>{
 const search=(id,completed)=>({id,kind:'toolActivity',activityKind:'searching',activityTurnId:'one',detail:`Search ${id}`,completed});
 const messages=[search('first',true),search('second',false)];
 const {w,state,flush}=setup({busy:true,turnId:'one',persistedWorkActivity:true,liveTaskActivity:true,messages});await tick();flush();
 const d=w.document,article=id=>d.querySelector(`[data-id="${id}"]`),group=d.querySelector('.tool-group');
 assert.equal(group.textContent,'搜索了 1 次');assert.equal(article('first').hidden,true);assert.equal(article('second').hidden,false);
 w.mobileCodexEvent('state',{...state,messages:[messages[0],search('second',true)]});flush();
 assert.equal(d.querySelector('.tool-group'),group);assert.equal(group.textContent,'搜索了 2 次');
 assert.equal(article('second').hidden,true);
 group.click();await tick();flush();
 assert.equal(article('first').hidden,false);assert.match(article('second').textContent,/Search second/);
 w.mobileCodexEvent('state',{...state,busy:false,turnId:'',messages:[messages[0],search('second',true),
  {id:'answer',role:'assistant',text:'已查到',completedTurnId:'one',finalForTurn:true}]});flush();
 assert.equal(group.hidden,true);assert.equal(article('second').hidden,true);assert.equal(article('answer').hidden,false);
});

test('public turn status and timer share the composer row, scope updates and clear on completion',async()=>{
 let now=Date.now();
 const p={turnId:'one',phase:'waiting',lastVisibleAt:now-6000,lastEventAt:now-6000,engineReplyAt:now,summary:'检查配置\n\n核对请求'};
 const {w,state,flush}=setup({busy:true,turnId:'one',turnProgress:p});
 const doc=w.document;
 let hidden=false;
 Object.defineProperty(doc,'hidden',{get:()=>hidden});
 const setPageHidden=value=>{hidden=value;doc.dispatchEvent(new w.Event('visibilitychange'));flush();};
 const timers=new Map();let nextTimer=0;
 w.Date.now=()=>now;
 w.setInterval=(callback,delay)=>{const id=++nextTimer;timers.set(id,{callback,delay});return id;};
 w.clearInterval=id=>timers.delete(id);
 await tick();flush();
 const el=id=>doc.getElementById(id),fire=(name,data)=>{w.mobileCodexEvent(name,data);flush();};
 assert.equal(el('activity').nextElementSibling,el('composer'));
 assert.equal(el('chat-scroll').contains(el('activity')),false);
 assert.equal(el('activity-text').textContent,'等待下一步 · 思考 6 秒了');
 assert.match(el('activity-details').title,/本机引擎 \d+ 秒前有回应/);
 assert.equal(timers.size,1);const {callback,delay}=timers.values().next().value;
 assert.equal(delay,1000);now+=delay;callback();
 assert.equal(el('activity-text').textContent,'等待下一步 · 思考 7 秒了');
 setPageHidden(true);assert.equal(timers.size,0);
 const commandAt=now;
 fire('turn.progress',{threadId:'test',progress:{...p,phase:'command',lastEventAt:now,lastVisibleAt:commandAt}});
 assert.equal(timers.size,0);assert.equal(el('activity-text').textContent,'等待下一步 · 思考 7 秒了');
 now+=delay;setPageHidden(false);assert.equal(timers.size,1);
 assert.equal(el('activity-text').textContent,'运行命令 · 思考 1 秒了');
 now+=35000;timers.values().next().value.callback();
 assert.equal(el('activity-text').textContent,'等待新的任务进展 · 思考 36 秒了');
 assert.equal(el('turn-summary'),null);assert.doesNotMatch(doc.body.textContent,/检查配置/);
 for(const [threadId,turnId] of [['other','one'],['test','old']])fire('turn.progress',{threadId,progress:{...p,turnId,phase:'responding',lastEventAt:now}});
 assert.equal(el('activity-text').textContent,'等待新的任务进展 · 思考 36 秒了');
 fire('turn.progress',{threadId:'test',progress:{...p,phase:'reasoning',lastEventAt:now,lastVisibleAt:commandAt}});
 assert.equal(el('activity-text').textContent,'思考中 · 思考 36 秒了');
 fire('message.delta',{threadId:'test',id:'commentary',delta:'开始回复'});
 fire('turn.progress',{threadId:'test',progress:{...p,phase:'responding',lastEventAt:now,lastVisibleAt:now}});
 assert.equal(el('activity-text').textContent,'正在回复 · 思考 0 秒了');
 fire('state',{...state,streamRetrying:true});assert.equal(el('activity-text').textContent,'响应流中断，正在重连');
 fire('state',{...state,threadId:'away',turnProgress:null});assert.equal(timers.size,0);
 fire('state',state);assert.equal(timers.size,1);
 fire('server.request',{key:'a',method:'item/commandExecution/requestApproval',params:{threadId:'test',turnId:'one'}});
 fire('turn.progress',{threadId:'test',progress:{...p,lastEventAt:now}});assert.equal(el('activity-text').textContent,'等待审批');
 setPageHidden(true);assert.equal(timers.size,0);
 fire('server.resolved',{key:'a'});fire('state',{...state,busy:false,turnId:'',turnProgress:null});
 setPageHidden(false);
 fire('turn.progress',{threadId:'test',progress:p});assert.equal(timers.size,0);assert.equal(el('activity').hidden,true);
});
