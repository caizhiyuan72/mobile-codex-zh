/* Replays identical delta frames through the packaged Web UI. No network or tools are invoked. */
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {performance} = require('node:perf_hooks');
const {JSDOM} = require('jsdom');

const root = path.join(__dirname, '../app/src/main/assets/web');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const baseline = process.argv.includes('--baseline');
const original = '901ebe93df99a4782db3f9b6a837d2acf26fe263';
const blocks = Array.from({length:140}, (_, i) =>
  `### Section ${i + 1}\n\n**Result**: measured \`value_${i}\` and rendered text.\n\n` +
  `\`\`\`html\n<p data-index="${i}">Streaming sample</p>\n\`\`\`\n\n`);
const chunks = blocks.join('').match(/.{1,24}|\n/g) || [];
const frames = [];
for (let i = 0; i < chunks.length; i += 5) frames.push(chunks.slice(i, i + 5));

async function measure() {
  const dom = new JSDOM(read('index.html'), {url:'https://appassets.androidplatform.net/index.html', runScripts:'outside-only'});
  const w = dom.window, scheduled = [];
  const snapshot = {threadId:'stream-replay', turnId:'turn', ready:true, busy:true,
    apiActive:'proxy', apiProviders:[{id:'proxy',hasKey:true}], workspace:{},
    messages:[{id:'answer',role:'assistant',text:''}]};
  const js = baseline ? execFileSync('git', ['show', `${original}:${path.relative(path.join(__dirname, '../..'), path.join(root, 'app.js'))}`],
    {cwd:__dirname,encoding:'utf8'}) : read('app.js');
  w.matchMedia = () => ({matches:false,addEventListener(){}});
  w.requestAnimationFrame = callback => { scheduled.push(callback); return scheduled.length; };
  w.Native = {locale:() => '{"choice":"en","systemLanguage":"en"}', postMessage(raw) {
    const {id, action} = JSON.parse(raw);
    queueMicrotask(() => w.mobileCodexEvent('response', {id,result:action === 'state' ? snapshot : {}}));
  }};
  function drawFrame() { for (const draw of scheduled.splice(0)) draw(); }
  try {
    for (const file of ['translations.js', 'locale.js', 'ui-core.js', 'reasoning-policy.js']) w.eval(read(file));
    w.eval(js);
    await new Promise(resolve => setImmediate(resolve));
    drawFrame();
    const elapsed = [];
    for (const frame of frames) {
      const start = performance.now();
      for (const delta of frame) w.mobileCodexEvent('message.delta', {threadId:snapshot.threadId, id:'answer', delta});
      drawFrame();
      elapsed.push(performance.now() - start);
    }
    assert.equal(w.document.querySelectorAll('#messages .code-card').length, blocks.length);
    const sorted = [...elapsed].sort((a,b) => a-b);
    const ms = value => Math.round(value * 100) / 100;
    return {frames:frames.length, chars:blocks.join('').length, firstFrameMs:ms(elapsed[0]),
      totalMs:ms(elapsed.reduce((a,b) => a+b, 0)), medianFrameMs:ms(sorted[Math.floor(sorted.length/2)]),
      p95FrameMs:ms(sorted[Math.floor(sorted.length*.95)]), peakFrameMs:ms(sorted.at(-1))};
  } finally { w.close(); }
}

measure().then(result => console.log(JSON.stringify({baseline, ...result}))).catch(error => {
  console.error(error); process.exitCode = 1;
});
