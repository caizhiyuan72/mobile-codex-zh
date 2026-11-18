const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');

const web = path.join(__dirname, '../app/src/main/assets/web');
const read = file => fs.readFileSync(path.join(web, file), 'utf8');

test('streaming keeps completed Markdown nodes without reply copy actions and accepts the final snapshot', async () => {
  const dom = new JSDOM(read('index.html'), {url:'https://appassets.androidplatform.net/index.html', runScripts:'outside-only'});
  try {
    const w = dom.window, frames = [], copied = [];
    const answer = {id:'reply', role:'assistant', text:''};
    const state = {threadId:'current', turnId:'turn', busy:true, ready:true, workspace:{}, messages:[answer]};
    w.matchMedia = () => ({matches:false, addEventListener(){}});
    w.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
    w.Native = {locale:() => '{"choice":"en","systemLanguage":"en"}', postMessage(raw) {
      const {id, action, args} = JSON.parse(raw);
      if (action === 'ui.copyCode') copied.push(args.code);
      queueMicrotask(() => w.mobileCodexEvent('response', {id,result:action === 'state' ? state : {}}));
    }};
    function paint() { for (const callback of frames.splice(0)) callback(); }
    function delta(text, threadId = 'current') { w.mobileCodexEvent('message.delta', {id:'reply', threadId, delta:text}); }
    for (const file of ['translations.js','locale.js','ui-core.js','reasoning-policy.js','app.js']) w.eval(read(file));
    await new Promise(resolve => setImmediate(resolve));
    paint();
    const reply = () => w.document.querySelector('#messages [data-id="reply"]');
    delta('  '); paint();
    delta('**Start**\n\n');
    delta('```ht');
    delta('ml\n<a>');
    assert.equal(reply().querySelector('strong'), null);
    paint();
    const start = reply().querySelector('strong');
    assert.equal(start.textContent, 'Start');
    assert.equal(reply().querySelector('pre code').textContent, '<a>');
    delta('not this thread', 'other');
    delta('text\n\n</a>\n``');
    paint();
    assert.equal(reply().querySelector('strong'), start);
    delta('`\n\n| H |\n| - |\n| cell |\n\n');
    paint();
    const code = reply().querySelector('pre code');
    assert.equal(code.textContent, '<a>text\n\n</a>\n');
    assert.equal(reply().querySelector('td').textContent, 'cell');
    delta('Latest.'); paint();
    assert.equal(reply().querySelector('strong'), start);
    assert.equal(reply().querySelector('pre code'), code);
    assert.equal(reply().querySelector('button'),null);
    assert.deepEqual(copied, []);

    const finalText = '**Final**\n\n```html\n<b>replacement</b>\n```';
    w.mobileCodexEvent('state', {...state,busy:false,messages:[{...answer,text:finalText}]});
    assert.equal(reply().querySelector('strong').textContent, 'Final');
    assert.equal(reply().querySelector('pre code').textContent.trim(), '<b>replacement</b>');
  } finally { dom.window.close(); }
});
