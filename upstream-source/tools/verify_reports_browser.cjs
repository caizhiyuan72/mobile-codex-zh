/* Native bridge fixtures only; production relay E2E is a separate release gate. */
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const {createReviewServer}=require('./ui_review_server.cjs');
const copy={
 'zh-CN':{disclosure:'以下诊断信息将发布到公开的 GitHub Issue，任何人都可以查看。',retry:'无法确认是否提交。',cancelled:'已取消发送。'},
 en:{disclosure:'The diagnostic information below will be posted to a public GitHub issue. Anyone can read it.',retry:'Could not confirm submission.',cancelled:'Sending cancelled.'}
};
async function fixture(){
 const payload={schema:1,reportId:'synthetic-preview',appVersion:'0.3.6',errorCode:'initialize_timeout',operation:'login',stage:'initialize_sent',elapsedMs:60000,processAlive:true,stdoutBytes:0,stdoutLines:0,androidApi:35,manufacturer:'samsung',deviceClass:'phone',ramClass:'le8gb',pageSize:'16k'};
 const fx=window.__reportFx={calls:[],attempts:0,hold:false,available:false,payload}, original=window.Native.postMessage.bind(window.Native);
 window.Native.postMessage=raw=>{
  const request=JSON.parse(raw),{id,action}=request;if(!action.startsWith('reports.'))return original(raw);
  fx.calls.push(request);const reply=value=>window.mobileCodexEvent('response',{id,result:value});
  if(action==='reports.status')return reply({available:fx.available});
  if(action==='reports.preview'&&!fx.available)return reply({status:'unavailable'});
  if(action==='reports.preview')return reply({status:'preview',reportId:payload.reportId,payload});
  if(action==='reports.cancel'){fx.finish?.({status:'cancelled'});return reply({status:'cancelled'});}
  if(action==='reports.send'){
   if(fx.hold){fx.finish=reply;return;}
   fx.attempts++;if(fx.attempts>1){fx.available=false;window.mobileCodexEvent('reports.available',{available:false});}return reply(fx.attempts===1?{status:'failed',code:'send_unconfirmed'}:{status:'sent',url:'https://github.com/nokryong/mobile-codex/issues/15',grouped:true});
  }
 };
 window.mobileCodexEvent('reports.available',{available:false});
}
(async()=>{
 const server=createReviewServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
 try{
  browser=await chromium.launch({headless:true,executablePath:process.env.MOBILE_CODEX_BROWSER_EXECUTABLE||undefined});
  for(const [width,language,theme]of [[320,'zh-CN','light'],[393,'en','dark'],[1280,'en','light']]){
   const page=await browser.newPage({viewport:{width,height:844},reducedMotion:'reduce'}),errors=[];page.on('pageerror',error=>errors.push(error.message));
   await page.goto('http://127.0.0.1:'+server.address().port+'/app?language='+language+'&theme='+theme);await page.waitForFunction(()=>window.__uiReviewSurfaceReady);
   const launcher=page.locator('#header-menu-dialog #report-error-open');
   const missing=[];
   if (await page.evaluate(()=>typeof window.MobileCodexReports!=='function')) missing.push('reports.js is not loaded');
   if (await launcher.count()!==1) missing.push('expected one #report-error-open in #header-menu-dialog');
   assert.deepEqual(missing,[],`${width}px ${language}: diagnostic report UI is not wired: ${missing.join('; ')}`);
   assert.deepEqual(errors,[],`${width}px ${language}: application failed to initialize`);
   const open=async()=>{await page.locator('#header-more').click();await launcher.click();};
   const launcherHidden=()=>launcher.evaluate(button=>button.hidden);
   const waitForStatus=text=>page.waitForFunction(expected=>document.getElementById('report-status').textContent.startsWith(expected),text);
   await page.evaluate(fixture);
   assert.equal(await launcherHidden(),true);
   assert.ok(await page.evaluate(()=>window.__uiReviewCalls.some(call=>call.action==='reports.status')));
   await page.evaluate(()=>{window.__reportFx.available=true;window.mobileCodexEvent('reports.available',{available:true});});
   assert.equal(await launcherHidden(),false);
   await open();await page.waitForFunction(()=>!document.getElementById('report-send').disabled);
   assert.deepEqual(JSON.parse(await page.locator('#report-payload').textContent()),await page.evaluate(()=>window.__reportFx.payload));
   assert.equal(await page.evaluate(()=>window.__reportFx.calls.filter(call=>call.action==='reports.send').length),0);
   assert.equal(await page.locator('#report-dialog').evaluate(el=>el.scrollWidth<=el.clientWidth+1),true);
   assert.equal(await page.locator('#report-dialog').evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1;}),true);
   assert.ok((await page.locator('#report-dialog').textContent()).includes(copy[language].disclosure));
   await page.locator('#report-send').click();await waitForStatus(copy[language].retry);
   await page.locator('#report-send').click();await page.waitForFunction(()=>!document.getElementById('report-result').hidden);
   const sendArgs=await page.evaluate(()=>window.__reportFx.calls.filter(call=>call.action==='reports.send').map(call=>call.args));
   assert.deepEqual(sendArgs,Array.from({length:2},()=>({reportId:'synthetic-preview',consent:true})));
   assert.equal(await launcherHidden(),true);
   assert.equal(await page.locator('#report-payload').textContent(),'');
   await page.locator('#report-result').click();
   assert.ok(await page.evaluate(()=>window.__uiReviewCalls.some(call=>call.action==='ui.externalBrowser'&&call.args.url==='https://github.com/nokryong/mobile-codex/issues/15')));
   await page.locator('#report-cancel').click();assert.equal(await page.locator('#report-dialog').evaluate(el=>el.open),false);
   await page.evaluate(()=>{window.__reportFx.hold=true;window.__reportFx.available=true;window.mobileCodexEvent('reports.available',{available:true});});await open();await page.locator('#report-send').click();assert.equal(await page.locator('#report-send').isDisabled(),true);
   await page.locator('#report-cancel').click();await waitForStatus(copy[language].cancelled);
   assert.equal(await page.locator('#report-send').isDisabled(),true);
   await page.locator('#report-cancel').click();await open();
   await page.waitForFunction(()=>!document.getElementById('report-send').disabled);
   await page.evaluate(()=>{window.__reportFx.available=false;window.mobileCodexEvent('reports.available',{available:false,previewInvalidated:true});});
   assert.equal(await launcherHidden(),true);assert.equal(await page.locator('#report-send').isDisabled(),true);
   assert.equal(await page.locator('#report-payload').textContent(),'');
   assert.ok(await page.evaluate(()=>window.__reportFx.calls.some(call=>call.action==='reports.cancel')));
   assert.deepEqual(errors,[]);await page.close();
  }
  console.log('Diagnostic report browser flow passed at 320, 393, and 1280px: header menu, consent, exact preview, offline/retry, cancellation, invalidation, and result links; Simplified Chinese/English.');
 }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
