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
async function toolbar(page,width,height){
 const geometry=await page.evaluate(()=>{
  const box=id=>{const r=document.getElementById(id).getBoundingClientRect();return {id,left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
  return {viewport:innerWidth,scrollWidth:document.documentElement.scrollWidth,composer:box('composer'),prompt:box('prompt'),controls:['add-attachment','composer-options','send'].map(box),stop:document.getElementById('stop').hidden,active:document.activeElement.id};
 });
 assert.ok(geometry.scrollWidth<=width+1,'document fits '+width);
 assert.ok(geometry.composer.left>=0&&geometry.composer.right<=width+1,'composer fits');
 assert.ok(geometry.composer.bottom<=height+1,'composer stays above viewport edge');
 for(const control of geometry.controls){assert.ok(control.width>=43.5&&control.height>=43.5,control.id+' retains 44px target');assert.ok(control.left>=geometry.composer.left&&control.right<=geometry.composer.right+1,control.id+' stays in composer');}
 const [attach,model,send]=geometry.controls;assert.ok(Math.abs(attach.top-send.top)<=1&&Math.abs(model.top-send.top)<=1,'actions share one row');
 assert.ok(attach.right<=model.left+1&&model.right<=send.left+1,'actions do not overlap');assert.ok(geometry.prompt.bottom<=attach.top+1,'input does not overlap toolbar');
 assert.ok(geometry.prompt.height<=Math.max(112,height*.27)+2,'input has a bounded height');
 assert.equal(geometry.active,'prompt');return geometry;
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
   await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin!=='https://appassets.androidplatform.net')return route.abort();const file=require('./icon_asset.cjs').iconAsset(web,url.pathname);return file.startsWith(web+path.sep)&&fs.existsSync(file)?route.fulfill({path:file}):route.fulfill({status:404,body:''});});
   await page.addInitScript(snapshot=>{
    localStorage.setItem('chat-icons','off');window.layoutState=snapshot;window.layoutCalls=[];
    window.Native={locale:()=>JSON.stringify({choice:'zh-CN',systemLanguage:'zh-CN'}),postMessage(raw){const message=JSON.parse(raw);window.layoutCalls.push(message);const result=message.action==='state'?window.layoutState:message.action==='github.status'?{github:window.layoutState.github}:message.action==='rpc'?{data:[],marketplaces:[]}:{};setTimeout(()=>window.mobileCodexEvent('response',{id:message.id,result}),0);}};
   },state);
   await page.goto('https://appassets.androidplatform.net/index.html');await page.locator('[data-id="a"]').waitFor();
   await page.locator('#prompt').fill('这是第一行\n第二行\n第三行\n第四行\n第五行应在输入框内滚动');await page.locator('#prompt').focus();await settle(page);
   await toolbar(page,width,820);await page.screenshot({path:path.join(output,`composer-${width}-${theme}.png`)});
   await page.setViewportSize({width,height:420});await settle(page);await toolbar(page,width,420);
   await page.screenshot({path:path.join(output,`keyboard-${width}-${theme}.png`)});
   await page.locator('#composer-options').click();await settle(page);
   const picker=await page.locator('#model-picker').boundingBox();assert.ok(picker.x>=-1&&picker.x+picker.width<=width+1&&picker.y>=-1&&picker.y+picker.height<=421,'model picker fits short viewport');
   await page.locator('#model-picker [data-close]').click();await settle(page);
   await page.setViewportSize({width,height:820});await settle(page);
   if(width<=760)await page.locator('.topbar .sidebar-toggle').click();
   await page.locator('#settings').click();await page.locator('[data-settings-tab="providers"]').click();await settle(page);
   assert.equal(await page.locator('[data-settings-panel="providers"]').evaluate(panel=>panel.scrollWidth<=panel.clientWidth+1),true,'API panel fits narrow viewport');
   assert.equal(await page.locator('#settings-dialog').evaluate(dialog=>{const r=dialog.getBoundingClientRect();return r.left>=-1&&r.right<=innerWidth+1&&r.top>=-1&&r.bottom<=innerHeight+1;}),true);
   await page.screenshot({path:path.join(output,`api-${width}-${theme}.png`)});
   const githubStates=[320,412].includes(width)?await githubLayout(page,width,theme):[];
   await page.locator('#settings-dialog .dialog-head > [data-close]').click();await settle(page);
   await page.evaluate(()=>window.mobileCodexEvent('state',{...window.layoutState,busy:true,turnId:'turn'}));await page.locator('#prompt').fill('');await settle(page);
   const stop=await page.locator('#stop').boundingBox();assert.ok(stop.width>=43.5&&stop.height>=43.5,'Stop remains reachable');
   await page.locator('#stop').click();await page.waitForFunction(()=>window.layoutCalls.some(call=>call.action==='chat.stop'));
   assert.equal(await page.locator('#live-start,#account-button,#composer-invite').count(),0);
   assert.deepEqual(errors,[]);results.push({width,theme,longModel:true,keyboard:true,picker:true,apiPanel:true,githubStates,stop:true});await page.close();
  }
  fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results));
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
