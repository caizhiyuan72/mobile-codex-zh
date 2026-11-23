const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {JSDOM} = require('jsdom');
const root = 'app/src/main/assets/web/';
const html = fs.readFileSync(root+'index.html','utf8');
const css = ['app.css','visual-system.css','spacing.css','model-controls.css'].map(file=>fs.readFileSync(root+file,'utf8')).join('\n');

test('composer keeps equal touch targets and one action row at supported text sizes',()=>{
 const dom=new JSDOM(html.replace('</head>','<style>'+css+'</style></head>'));
 const {document,getComputedStyle}=dom.window;
 for(const zoom of [75,100,130,150]) {
  document.documentElement.style.setProperty('--text-size-factor',String(zoom/100));
  for(const id of ['add-attachment','send','stop']) {
   const button=document.getElementById(id), style=getComputedStyle(button);
   assert.equal(style.width,'44px');assert.equal(style.height,'44px');
   assert.equal(style.minWidth,'44px');assert.equal(style.minHeight,'44px');
   const symbol=getComputedStyle(button.querySelector('svg'));
   const iconSize=id==='send'?'28px':'20px';
   assert.equal(symbol.width,iconSize);assert.equal(symbol.height,iconSize);
  }
  assert.equal(getComputedStyle(document.querySelector('.composer-bottom')).display,'flex');
  assert.equal(getComputedStyle(document.querySelector('.composer-bottom')).gap,'8px');
  assert.equal(getComputedStyle(document.querySelector('.composer-actions')).gap,'8px');
 }
 assert.equal(document.getElementById('approval-mode').closest('#composer'),null);
 assert.ok(document.getElementById('voice-input').closest('#composer-add-menu'));
 for(const id of ['fast-mode','live-start','composer-folder','composer-invite'])assert.equal(document.getElementById(id),null);
 dom.window.close();
});

test('long model names may shrink while actions retain their target sizes',()=>{
 const dom=new JSDOM(html.replace('</head>','<style>'+css+'</style></head>'));
 const {document,getComputedStyle}=dom.window;
 const model=document.getElementById('model-summary');model.textContent='third-party/provider/a-very-long-model-name';
 assert.equal(getComputedStyle(model).textOverflow,'ellipsis');
 assert.equal(getComputedStyle(model).whiteSpace,'nowrap');
 assert.equal(getComputedStyle(model).minWidth,'0');
 const options=getComputedStyle(document.getElementById('composer-options'));
 assert.equal(options.minWidth,'0');
 assert.equal(options.flexGrow,'0');
 assert.equal(options.flexShrink,'1');
 assert.equal(options.flexBasis,'auto');
 assert.equal(options.borderRadius,'999px');
 assert.equal(getComputedStyle(document.getElementById('model-picker-model')).flexDirection,'row');
 const control=document.getElementById('reasoning-control');
 const accents=['low','medium','high','xhigh','max','ultra'].map(effort=>{
  control.dataset.effort=effort;
  return getComputedStyle(control).getPropertyValue('--effort-accent');
 });
 assert.ok(accents.every(Boolean));assert.equal(new Set(accents).size,6);
 assert.equal(getComputedStyle(document.getElementById('send')).marginInlineStart,'auto');
 assert.ok(document.getElementById('header-project').tagName==='BUTTON');
 assert.ok(document.getElementById('choose-folder').closest('#onboarding'));
 dom.window.close();
});
