const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {JSDOM} = require('jsdom');
const root = 'app/src/main/assets/web/';
const html = fs.readFileSync(root+'index.html','utf8');
const css = ['app.css','visual-system.css','spacing.css','model-controls.css'].map(file=>fs.readFileSync(root+file,'utf8')).join('\n');

test('composer keeps fixed touch targets in the primary input row at supported text sizes',()=>{
 const dom=new JSDOM(html.replace('</head>','<style>'+css+'</style></head>'));
 const {document,getComputedStyle}=dom.window;
 const touch=getComputedStyle(document.documentElement).getPropertyValue('--touch').trim();
 assert.equal(touch,'44px');
 const size=value=>value === 'var(--touch)' ? touch : value;
 for(const zoom of [75,100,130,150]) {
  document.documentElement.style.setProperty('--text-size-factor',String(zoom/100));
  for(const id of ['add-attachment','send','stop']) {
   const button=document.getElementById(id), style=getComputedStyle(button);
   assert.equal(size(style.width),'44px');assert.equal(size(style.height),'44px');
   const symbol=getComputedStyle(button.querySelector('svg'));
   const iconSize=id==='send'?'28px':'20px';
   assert.equal(symbol.width,iconSize);assert.equal(symbol.height,iconSize);
  }
  const composer=getComputedStyle(document.getElementById('composer'));
  assert.equal(composer.display,'grid');
  assert.match(composer.gridTemplateAreas,/"add prompt actions"/);
  assert.equal(composer.gridTemplateColumns,'var(--touch) minmax(0, 1fr) var(--touch)');
 }
 assert.equal(document.getElementById('approval-mode').closest('#composer'),null);
 const menu=document.getElementById('composer-add-menu');
 assert.equal(menu.hidden,true);
 for(const id of ['composer-attach','composer-file-context','voice-input','composer-options']) {
  assert.equal(document.getElementById(id).closest('[role="menu"]'),menu);
 }
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
 const summary=model.closest('.composer-options-summary');
 assert.equal(summary.closest('[role="menuitem"]').id,'composer-options');
 assert.equal(getComputedStyle(summary).minWidth,'0');
 assert.equal(getComputedStyle(model).overflow,'hidden');
 assert.equal(getComputedStyle(document.getElementById('composer-options')).width,'100%');
 assert.equal(getComputedStyle(document.getElementById('model-picker-model')).flexDirection,'row');
 const control=document.getElementById('reasoning-control');
 const accents=['low','medium','high','xhigh','max','ultra'].map(effort=>{
  control.dataset.effort=effort;
  return getComputedStyle(control).getPropertyValue('--effort-accent');
 });
 assert.ok(accents.every(Boolean));assert.equal(new Set(accents).size,6);
 assert.equal(getComputedStyle(document.querySelector('.composer-actions')).gridArea,'actions');
 assert.ok(document.getElementById('header-project').closest('#header-menu-dialog'));
 assert.ok(document.getElementById('choose-folder').closest('#onboarding'));
 dom.window.close();
});
