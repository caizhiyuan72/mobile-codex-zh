#!/usr/bin/env node
/* Chromium layout fixtures; provider requests stay mocked and no credentials are used. */
'use strict';
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const web=path.resolve(__dirname,'../app/src/main/assets/web');
const output=path.resolve(__dirname,'../artifacts/api-ui-preview');
const state={ready:true,busy:false,permissions:'workspace-write',status:'Connected',threadId:'layout',cwd:'/project',directWorkspace:true,
 workspace:{selected:true,key:'project',name:'很长的项目名称仍应保持顶部按钮可用',available:true},projects:[],sessions:[],apiActive:'fixture',
 apiProviders:[{id:'fixture',name:'第三方服务商名称'.repeat(8),baseUrl:'https://proxy.example/v1',hasKey:true,models:['gpt-6.1-sol-'+ 'long-model-'.repeat(12)]}],
 github:{configured:false,clientId:'',state:'idle',scopes:[]},
 models:[{id:'gpt-6.1-sol-'+ 'long-model-'.repeat(12),model:'gpt-6.1-sol-'+ 'long-model-'.repeat(12),displayName:'openai · gpt-6.1-sol-'+ 'long-model-'.repeat(12),isDefault:true}],
 messages:[{id:'u',role:'user',text:'请检查项目并说明修改。'},{id:'a',role:'assistant',text:'已经读取项目。\n\n接下来可以修复布局、运行测试并审查变更。'}]};
async function settle(page){await page.evaluate(async()=>{await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));await Promise.all(document.getAnimations().filter(animation=>Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation=>animation.finished.catch(()=>{})));});}
async function toolbar(page,width,height,{busy=false,focused=true}={}){
 const geometry=await page.evaluate(busy=>{
  const box=id=>{const r=document.getElementById(id).getBoundingClientRect();return {id,left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
  return {viewport:innerWidth,scrollWidth:document.documentElement.scrollWidth,composer:box('composer'),prompt:box('prompt'),controls:['add-attachment','composer-options',busy?'stop':'send'].map(box),actionIds:[...document.querySelectorAll('.composer-actions > .send-button')].filter(button=>button.getClientRects().length).map(button=>button.id),stopColor:getComputedStyle(document.getElementById('stop')).backgroundColor,stopDisabled:document.getElementById('stop').disabled,active:document.activeElement.id};
 },busy);
 assert.ok(geometry.scrollWidth<=width+1,'document fits '+width);
 assert.ok(geometry.composer.left>=0&&geometry.composer.right<=width+1,'composer fits');
 assert.ok(geometry.composer.bottom<=height+1,'composer stays above viewport edge');
 for(const control of geometry.controls){assert.ok(control.width>=43.5&&control.height>=43.5,control.id+' retains 44px target');assert.ok(control.left>=geometry.composer.left&&control.right<=geometry.composer.right+1,control.id+' stays in composer');}
 const [attach,model,send]=geometry.controls;assert.ok(Math.abs(attach.top-send.top)<=1&&Math.abs(model.top-send.top)<=1,'actions share one row');
 assert.ok(attach.right<=model.left+1&&model.right<=send.left+1,'actions do not overlap');assert.ok(geometry.prompt.bottom<=attach.top+1,'input does not overlap toolbar');
 assert.ok(geometry.prompt.height<=Math.max(112,height*.27)+2,'input has a bounded height');
 assert.deepEqual(geometry.actionIds,[busy?'stop':'send'],'exactly one composer action is visible');
 if(busy){assert.equal(geometry.stopDisabled,false);assert.equal(geometry.stopColor,'rgb(215, 58, 73)','Stop is visibly red');}
 if(focused)assert.equal(geometry.active,'prompt');return geometry;
}
async function editingLine(page,expected){
 const result=await page.locator('#prompt').evaluate(field=>{
  const style=getComputedStyle(field),line=parseFloat(style.lineHeight),paddingTop=parseFloat(style.paddingTop),paddingBottom=parseFloat(style.paddingBottom);
  const position=field.selectionDirection==='backward'?field.selectionStart:field.selectionEnd;
  // These fixtures use short explicit lines, so this check is independent of caret measurement.
  const row=field.value.slice(0,position).split('\n').length-1;
  return {value:field.value,start:field.selectionStart,end:field.selectionEnd,direction:field.selectionDirection,
   top:paddingTop+row*line-field.scrollTop,bottom:paddingTop+(row+1)*line-field.scrollTop,
   visibleTop:paddingTop,visibleBottom:field.clientHeight-paddingBottom,scrollTop:field.scrollTop,
   maxScroll:field.scrollHeight-field.clientHeight,height:field.clientHeight,cssMax:parseFloat(style.maxHeight)};
 });
 assert.equal(result.value,expected.value,'keyboard resize preserves the draft');
 assert.equal(result.start,expected.start,'keyboard resize preserves selection start');
 assert.equal(result.end,expected.end,'keyboard resize preserves selection end');
 if(expected.direction)assert.equal(result.direction,expected.direction,'keyboard resize preserves selection direction');
 assert.ok(result.height<=result.cssMax+1,'composer uses the actual CSS height limit');
 assert.ok(result.top>=result.visibleTop-1,'active editing line stays below the top padding');
 assert.ok(result.bottom<=result.visibleBottom+1,'active editing line stays above the bottom padding');
 return result;
}
async function earlierSelection(page,width,theme){
 const value=Array.from({length:9},(_,i)=>'第'+(i+1)+'行内容').join('\n');
 await page.setViewportSize({width,height:820});await page.locator('#prompt').fill(value);await settle(page);
 const selection=await page.locator('#prompt').evaluate(field=>{
  const start=field.value.indexOf('第2行')+2,end=field.value.indexOf('第7行')+2;
  field.setSelectionRange(start,end,'backward');field.scrollTop=parseFloat(getComputedStyle(field).lineHeight);
  return {value:field.value,start,end,direction:'backward'};
 });
 await page.setViewportSize({width,height:420});await settle(page);
 const result=await editingLine(page,selection);
 assert.ok(result.scrollTop<result.maxScroll,'editing an earlier line never jumps to the draft tail');
 await page.screenshot({path:path.join(output,`keyboard-selection-${width}-${theme}.png`)});
}
const attachmentFixtures=[
 {id:'portrait',name:'手机长截图-'+ '很长的文件名'.repeat(20)+'.png',image:{id:'portrait',url:'/images/'+'a'.repeat(64),width:1080,height:24000}},
 {id:'landscape',name:'超宽图片.png',image:{id:'landscape',url:'/images/'+'b'.repeat(64),width:8000,height:250}},
 {id:'square',name:'大尺寸图片.png',image:{id:'square',url:'/images/'+'c'.repeat(64),width:4096,height:4096}},
 {id:'document',name:'项目说明-'+ '很长的文件名'.repeat(20)+'.txt'}
];
async function attachmentGeometry(page,width,height){
 const geometry=await page.evaluate(()=>{
  const box=element=>{const r=element.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
  const rail=document.getElementById('draft-context');
  return {rail:{...box(rail),clientWidth:rail.clientWidth,scrollWidth:rail.scrollWidth,clientHeight:rail.clientHeight,scrollHeight:rail.scrollHeight},
   chat:box(document.getElementById('chat-scroll')),previews:[...rail.querySelectorAll('.context-image')].map(box),
   images:[...rail.querySelectorAll('img')].map(box),remove:[...rail.querySelectorAll('.chip-remove')].map(box)};
 });
 assert.ok(geometry.rail.height>0&&geometry.rail.height<=80,'attachments occupy a bounded row');
 assert.ok(geometry.rail.scrollWidth>geometry.rail.clientWidth,'multiple attachments scroll horizontally');
 assert.ok(geometry.rail.scrollHeight<=geometry.rail.clientHeight+1,'attachments never overflow vertically');
 assert.ok(geometry.chat.height>=80,'conversation remains visible with attachments and keyboard');
 for(const preview of [...geometry.previews,...geometry.images])assert.ok(preview.width<=44.5&&preview.height<=44.5,'large images stay inside thumbnails');
 for(const control of [...geometry.previews,...geometry.remove])assert.ok(control.width>=43.5&&control.height>=43.5,'preview and remove keep 44px touch targets');
 await toolbar(page,width,height);return geometry;
}
async function attachmentLayout(page,width,theme){
 const draft='这张图片需要检查\n输入框与发送按钮应该一直可用';
 await page.locator('#prompt').fill(draft);
 await page.evaluate(attachments=>window.mobileCodexEvent('attachments.picked',{receiptId:'layout-images',attachments}),attachmentFixtures);
 await page.waitForFunction(()=>[...document.querySelectorAll('#draft-context img')].length===3&&[...document.querySelectorAll('#draft-context img')].every(img=>img.complete&&img.naturalWidth>0));
 await page.locator('#prompt').focus();await settle(page);await attachmentGeometry(page,width,820);
 await page.screenshot({path:path.join(output,`attachments-${width}-${theme}.png`)});
 await page.setViewportSize({width,height:420});await settle(page);await attachmentGeometry(page,width,420);
 await page.screenshot({path:path.join(output,`attachments-keyboard-${width}-${theme}.png`)});
 await page.locator('#draft-context .context-image').first().click();await settle(page);
 assert.equal(await page.locator('#image-dialog').evaluate(dialog=>dialog.open),true,'thumbnail still opens the image viewer');
 assert.ok(await page.locator('#image-dialog').evaluate(dialog=>{const r=dialog.getBoundingClientRect();return r.left>=-1&&r.right<=innerWidth+1&&r.top>=-1&&r.bottom<=innerHeight+1;}),'image viewer fits the short viewport');
 await page.locator('#image-dialog [data-close]').click();await settle(page);
 await page.locator('#draft-context .chip-remove').nth(2).click();await settle(page);
 assert.equal(await page.locator('#draft-context .context-image').count(),2,'an attachment can be removed');
 assert.equal(await page.locator('#draft-context .context-chip').count(),3,'other attachments are preserved');
 assert.equal(await page.locator('#prompt').inputValue(),draft,'removing an attachment preserves the text');
 await page.reload();await page.locator('[data-id="a"]').waitFor();
 await page.waitForFunction(()=>document.querySelectorAll('#draft-context .context-image').length===2);
 await page.locator('#prompt').focus();await settle(page);await attachmentGeometry(page,width,420);
 assert.equal(await page.locator('#prompt').inputValue(),draft,'restored attachment drafts preserve the text');
 await page.evaluate(attachments=>window.mobileCodexEvent('state',{...window.layoutState,messages:[...window.layoutState.messages,
  {id:'sent-images',role:'user',text:'已经发送的图片',attachments}]}),attachmentFixtures);
 await settle(page);
 const sent=await page.locator('[data-id="sent-images"] .sent-attachments').evaluate(element=>({
  fits:element.scrollWidth<=element.clientWidth+1,images:[...element.querySelectorAll('img')].map(img=>({width:img.getBoundingClientRect().width,height:img.getBoundingClientRect().height}))}));
 assert.ok(sent.fits,'sent attachments fit the message');
 assert.equal(sent.images.length,3);for(const image of sent.images)assert.ok(image.width<=88.5&&image.height<=88.5,'sent images remain thumbnails');
 while(await page.locator('#draft-context .chip-remove').count())await page.locator('#draft-context .chip-remove').first().click();
 assert.equal(await page.locator('#draft-context').isVisible(),false,'empty attachment row is hidden');
 await page.setViewportSize({width,height:820});await settle(page);
}
async function taskControls(page,width,theme){
 await page.locator('#prompt').fill('保留这条后续指令');await settle(page);
 const idle=(await toolbar(page,width,820)).controls.at(-1);
 await page.evaluate(()=>window.mobileCodexEvent('state',{...window.layoutState,busy:true,turnId:'turn'}));await settle(page);
 const working=(await toolbar(page,width,820,{busy:true})).controls.at(-1);
 // Native restores and textarea input both update the same action position.
 for(const property of ['left','top','width','height'])assert.ok(Math.abs(idle[property]-working[property])<=1,'Stop replaces Send at the same '+property);
 await page.locator('#prompt').fill('工作时输入也不能隐藏停止按钮');await settle(page);await toolbar(page,width,820,{busy:true});
 await page.locator('.msg-copy-btn').first().focus();await settle(page);await toolbar(page,width,820,{busy:true,focused:false});
 await page.screenshot({path:path.join(output,`stop-${width}-${theme}.png`)});
 await page.locator('#stop').click();await page.waitForFunction(()=>window.layoutCalls.some(call=>call.action==='chat.stop'));
 assert.equal(await page.locator('#stop').isVisible(),true,'Stop waits for native completion');
 await page.evaluate(()=>window.mobileCodexEvent('state',{...window.layoutState,busy:false,turnId:''}));await settle(page);
 await toolbar(page,width,820,{focused:false});
 assert.equal(await page.locator('#prompt').inputValue(),'工作时输入也不能隐藏停止按钮','completion preserves the draft');
}
async function reasoningLayout(page,width){
 const result=await page.evaluate(()=>{
  const picker=document.getElementById('model-picker'),slider=document.getElementById('effort-slider'),heading=document.getElementById('model-heading');
  const box=element=>{const r=element.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
  return {picker:box(picker),slider:box(slider),summaryFont:parseFloat(getComputedStyle(document.getElementById('model-summary')).fontSize),headingFont:parseFloat(getComputedStyle(heading).fontSize),
   fits:picker.scrollWidth<=picker.clientWidth+1,levels:[...document.querySelectorAll('#effort-levels span')].map(span=>span.textContent),
   forbidden:picker.querySelectorAll('#model-help,#effort-experimental,#effort-preset-grid,#effort-contract').length};
 });
 assert.ok(result.fits,'model picker content fits '+width);
 assert.ok(result.slider.width>0&&result.slider.height>=43.5,'reasoning uses a visible 44px range control');
 assert.ok(result.slider.left>=result.picker.left&&result.slider.right<=result.picker.right+1,'slider fits the picker');
 assert.ok(result.summaryFont>=14&&result.headingFont>=18,'model names remain readable on phone');
 assert.deepEqual(result.levels,['low','medium','high'],'provider without metadata offers standard English levels');
 assert.equal(result.forbidden,0,'model picker omits descriptions and experimental controls');
 await page.locator('#effort-slider').evaluate(slider=>{slider.value=slider.max;slider.dispatchEvent(new Event('input',{bubbles:true}));slider.dispatchEvent(new Event('change',{bubbles:true}));});
 await page.waitForFunction(()=>document.getElementById('effort').value==='high');
 assert.equal(await page.locator('#effort').inputValue(),'high','slider changes the selected request level');
}
async function readingThroughCompletion(page,width,theme){
 const messages=Array.from({length:36},(_,i)=>({id:'read-'+i,role:i%2?'assistant':'user',text:'第 '+(i+1)+' 条消息。'+('保留当前阅读位置并继续检查项目。'.repeat(3))}));
 await page.evaluate(messages=>{window.layoutState={...window.layoutState,busy:true,turnId:'reading-turn',messages};window.mobileCodexEvent('state',window.layoutState);},messages);
 await settle(page);
 const before=await page.evaluate(()=>{
  const area=document.getElementById('chat-scroll'),target=document.querySelector('[data-id="read-12"]');
  area.scrollTop+=target.getBoundingClientRect().top-area.getBoundingClientRect().top-24;
  area.dispatchEvent(new Event('scroll'));
  return {top:target.getBoundingClientRect().top-area.getBoundingClientRect().top,scrollTop:area.scrollTop};
 });
 assert.ok(before.scrollTop>0,'reading fixture is above the live tail');
 assert.equal(await page.locator('#jump-latest').isVisible(),false,'running task does not show latest shortcut');
 await page.evaluate(()=>{
  window.mobileCodexEvent('message.delta',{threadId:window.layoutState.threadId,id:'read-35',delta:'流式输出仍在继续。'});
  window.mobileCodexEvent('agent.event',{threadId:window.layoutState.threadId,method:'item/started',params:{item:{id:'reading-command',type:'commandExecution',command:'npm test'}}});
 });await settle(page);
 const readingOffset=()=>page.evaluate(()=>document.querySelector('[data-id="read-12"]').getBoundingClientRect().top-document.getElementById('chat-scroll').getBoundingClientRect().top);
 assert.ok(Math.abs(await readingOffset()-before.top)<=1,'stream output preserves the line being read');
 await page.evaluate(()=>{
  const messages=window.layoutState.messages.map(message=>message.id==='read-3'?{...message,text:message.text+'\n\n上方消息更新。'.repeat(12)}:message);
  window.layoutState={...window.layoutState,busy:false,turnId:'',messages};window.mobileCodexEvent('state',window.layoutState);
 });await settle(page);
 assert.ok(Math.abs(await readingOffset()-before.top)<=1,'completion and changed content above preserve the reading position');
 assert.equal(await page.locator('#jump-latest').isVisible(),true,'latest shortcut appears after whole-task completion');
 const centered=await page.locator('#jump-latest').evaluate(button=>{const r=button.getBoundingClientRect(),parent=button.parentElement.getBoundingClientRect();return Math.abs(r.left+r.width/2-parent.left-parent.width/2)<=1;});
 assert.ok(centered,'latest shortcut remains horizontally centered');
 await page.screenshot({path:path.join(output,`completion-reading-${width}-${theme}.png`)});
 await page.locator('#jump-latest').click();await settle(page);
 assert.equal(await page.locator('#jump-latest').isVisible(),false);
 assert.ok(await page.locator('#chat-scroll').evaluate(area=>area.scrollHeight-area.scrollTop-area.clientHeight<=2),'latest shortcut reaches the tail');
}
async function githubLayout(page,width,theme){
 const states=[
  ['unconfigured',{configured:false,clientId:'',state:'idle',scopes:[]}],
  ['pending',{configured:true,clientId:'Ov23liOwnClientID',state:'pending',userCode:'ABCD-1234',verificationUri:'https://github.com/login/device',expiresAt:Date.now()+600000,scopes:[]}],
  ['connected',{configured:true,clientId:'Ov23liOwnClientID',state:'connected',login:'very-long-github-username-with-dashes',scopes:['public_repo','workflow']}]
 ];
 await page.locator('[data-settings-tab="github"]').click();
 for(const [name,github] of states){
  await page.evaluate(snapshot=>{window.layoutState={...window.layoutState,github:snapshot};window.mobileCodexEvent('github.changed',{github:snapshot});},github);
  await settle(page);
  const geometry=await page.locator('#github-panel').evaluate(panel=>{
   const rect=element=>{const r=element.getBoundingClientRect();return {id:element.id||element.tagName,left:r.left,right:r.right,width:r.width,height:r.height};};
   const shown=element=>element.getClientRects().length>0&&getComputedStyle(element).visibility!=='hidden';
   return {panel:rect(panel),fits:panel.scrollWidth<=panel.clientWidth+1,
    controls:[...panel.querySelectorAll('button,input,summary')].filter(shown).map(rect),
    primary:[...panel.querySelectorAll('.primary-button')].filter(shown).length};
  });
  assert.ok(geometry.fits,'GitHub '+name+' panel fits '+width);
  for(const control of geometry.controls){
   assert.ok(control.width>=43.5&&control.height>=43.5,'GitHub '+control.id+' retains 44px target');
   assert.ok(control.left>=geometry.panel.left-1&&control.right<=geometry.panel.right+1,'GitHub '+control.id+' fits the panel');
   assert.ok(control.left>=-1&&control.right<=width+1,'GitHub '+control.id+' stays within the viewport');
  }
  assert.equal(geometry.primary,name==='connected'?0:1,'GitHub has at most one primary action');
  if(name==='pending'){
   assert.equal(await page.locator('#github-user-code').inputValue(),'ABCD-1234');
   const [code,copy]=await Promise.all([page.locator('#github-user-code').boundingBox(),page.locator('#github-copy-code').boundingBox()]);
   assert.ok(code.x+code.width<=copy.x+1,'GitHub code and copy button do not overlap');
   await page.locator('#github-main-action').scrollIntoViewIfNeeded();
   await page.locator('#github-main-action').click();await page.waitForFunction(()=>window.layoutCalls.some(call=>call.action==='github.openVerification'));
  }else if(name==='connected'){
   assert.match(await page.locator('#github-account').textContent(),/@very-long-github/);
   await page.locator('#github-disconnect').scrollIntoViewIfNeeded();
  }else await page.locator('#github-main-action').scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(output,`github-${name}-${width}-${theme}.png`)});
 }
 assert.equal(await page.evaluate(()=>window.layoutCalls.some(call=>['github.configure','github.login','github.disconnect'].includes(call.action))),false,'GitHub does not configure or log in automatically');
 return states.map(([name])=>name);
}
(async()=>{
 fs.mkdirSync(output,{recursive:true});
 const browser=await chromium.launch({headless:true,executablePath:process.env.MOBILE_CODEX_BROWSER_EXECUTABLE||undefined,args:['--no-sandbox','--disable-dev-shm-usage']});
 const results=[];
 try {
  for(const width of [320,360,412,768])for(const theme of ['light','dark']){
   const page=await browser.newPage({viewport:{width,height:820},colorScheme:theme}),errors=[];
   page.on('pageerror',error=>errors.push(error.message));
   await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin!=='https://appassets.androidplatform.net')return route.abort();const image=attachmentFixtures.find(item=>item.image?.url===url.pathname)?.image;if(image)return route.fulfill({contentType:'image/svg+xml',body:`<svg xmlns="http://www.w3.org/2000/svg" width="${image.width}" height="${image.height}"><rect width="100%" height="100%" fill="#8ac5ee"/><path d="M0 0L${image.width} ${image.height}" stroke="#16344a" stroke-width="20"/></svg>`});const file=require('./icon_asset.cjs').iconAsset(web,url.pathname);return file.startsWith(web+path.sep)&&fs.existsSync(file)?route.fulfill({path:file}):route.fulfill({status:404,body:''});});
   await page.addInitScript(snapshot=>{
    localStorage.setItem('chat-icons','off');window.layoutState=snapshot;window.layoutCalls=[];
    window.Native={locale:()=>JSON.stringify({choice:'zh-CN',systemLanguage:'zh-CN'}),postMessage(raw){const message=JSON.parse(raw);window.layoutCalls.push(message);const result=message.action==='state'?window.layoutState:message.action==='github.status'?{github:window.layoutState.github}:message.action==='rpc'?{data:[],marketplaces:[]}:{};setTimeout(()=>window.mobileCodexEvent('response',{id:message.id,result}),0);}};
   },state);
   await page.goto('https://appassets.androidplatform.net/index.html');await page.locator('[data-id="a"]').waitFor();
   const draft='这是第一行\n第二行\n第三行\n第四行\n第五行应在输入框内滚动';
   await page.locator('#prompt').fill(draft);await page.locator('#prompt').focus();await settle(page);
   await toolbar(page,width,820);await page.screenshot({path:path.join(output,`composer-${width}-${theme}.png`)});
   await page.setViewportSize({width,height:420});await settle(page);await toolbar(page,width,420);
   if(width===320)await editingLine(page,{value:draft,start:draft.length,end:draft.length});
   await page.screenshot({path:path.join(output,`keyboard-${width}-${theme}.png`)});
   if(width===320)await earlierSelection(page,width,theme);
   await page.locator('#composer-options').click();await settle(page);
   const picker=await page.locator('#model-picker').boundingBox();assert.ok(picker.x>=-1&&picker.x+picker.width<=width+1&&picker.y>=-1&&picker.y+picker.height<=421,'model picker fits short viewport');
   await reasoningLayout(page,width);
   await page.locator('#model-picker [data-close]').click();await settle(page);
   await page.setViewportSize({width,height:820});await settle(page);
   if(width<=760)await page.locator('.topbar .sidebar-toggle').click();
   await page.locator('#settings').click();await page.locator('[data-settings-tab="providers"]').click();await settle(page);
   assert.equal(await page.locator('[data-settings-panel="providers"]').evaluate(panel=>panel.scrollWidth<=panel.clientWidth+1),true,'API panel fits narrow viewport');
   assert.equal(await page.locator('#settings-dialog').evaluate(dialog=>{const r=dialog.getBoundingClientRect();return r.left>=-1&&r.right<=innerWidth+1&&r.top>=-1&&r.bottom<=innerHeight+1;}),true);
   await page.screenshot({path:path.join(output,`api-${width}-${theme}.png`)});
   const githubStates=[320,412].includes(width)?await githubLayout(page,width,theme):[];
   await page.locator('#settings-dialog .dialog-head > [data-close]').click();await settle(page);
   await attachmentLayout(page,width,theme);
   await taskControls(page,width,theme);
   await readingThroughCompletion(page,width,theme);
   assert.equal(await page.locator('#live-start,#account-button,#composer-invite').count(),0);
   assert.deepEqual(errors,[]);results.push({width,theme,longModel:true,keyboard:true,caret:width===320,selection:width===320,picker:true,apiPanel:true,githubStates,attachments:true,stop:true,exclusiveAction:true,reasoningSlider:true,readingStable:true});await page.close();
  }
  fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results));
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
