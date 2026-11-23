const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');

const web = path.join(__dirname, '../app/src/main/assets/web');
const read = file => fs.readFileSync(path.join(web, file), 'utf8');

test('streaming preserves Markdown and copies only the completed fenced block', async () => {
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
    for (const file of ['appearance.js','translations.js','locale.js','ui-core.js','reasoning-policy.js','katex/katex.min.js','app.js']) w.eval(read(file));
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
    assert.equal(reply().querySelector('.code-copy-btn'), null);
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
    assert.equal(reply().querySelector('.msg-copy-btn'), null);
    assert.deepEqual(copied, []);
    const copy = reply().querySelector('.code-copy-btn');
    assert.equal(copy.parentElement.className, 'code-head');
    copy.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(copied, ['<a>text\n\n</a>\n']);
    assert.equal(copy.textContent, 'Copied!');

    delta('\n\n$$\nF = \\frac{36}{3}\n\n'); paint();
    assert.equal(reply().querySelector('.katex'), null);
    delta('= 12\n$'); paint();
    assert.equal(reply().querySelector('.katex'), null);
    delta('$\n\n'); paint();
    const formula = reply().querySelector('.chat-math-display .katex');
    assert.ok(formula.querySelector('.mfrac'));
    delta('Next paragraph.'); paint();
    assert.equal(reply().querySelector('.chat-math-display .katex'), formula);

    const finalText = '**Final**\n\n```html\n<b>replacement</b>\n```\n\n' + [
      String.raw`自由度 **\(df=4-1=3\)**，$P < 0.05$。`,
      '总价 $5 或 $10，行内代码 `$x^2$`。',
      String.raw`\[ F = \frac{36}{3} = 12 \]`,
      '```text\n$$x^2$$\n```',
      String.raw`无效公式 \(\unknowncommand\)，外链公式 \(\href{https://example.com}{x}\)。`
    ].join('\n\n');
    w.mobileCodexEvent('state', {...state,busy:false,messages:[{...answer,text:finalText}]});
    assert.equal(reply().querySelector('strong').textContent, 'Final');
    assert.equal(reply().querySelector('pre code').textContent.trim(), '<b>replacement</b>');
    assert.ok(reply().querySelector('strong .katex'));
    assert.equal(reply().querySelectorAll('.katex').length, 4);
    assert.ok(reply().querySelector('.chat-math-display .mfrac'));
    assert.ok(reply().textContent.includes('总价 $5 或 $10'));
    assert.equal(reply().querySelector('p code').textContent, '$x^2$');
    assert.ok(reply().textContent.includes(String.raw`\(\unknowncommand\)`));
    assert.equal(reply().querySelector('a'), null);
    assert.equal(reply().querySelectorAll('pre code')[1].textContent.trim(), '$$x^2$$');
    assert.equal(reply().querySelectorAll('.code-copy-btn').length, 2);
  } finally { dom.window.close(); }
});
