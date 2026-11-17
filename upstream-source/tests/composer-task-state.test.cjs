const {test, afterEach} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');

const webRoot = path.join(__dirname, '../app/src/main/assets/web');
const opened = [];
afterEach(() => { for (const dom of opened.splice(0)) dom.window.close(); });
const tick = () => new Promise(resolve => setTimeout(resolve, 10));

function setup(task = {}, overrides = {}) {
  const css = ['app.css', 'visual-system.css'].map(file => fs.readFileSync(path.join(webRoot, file), 'utf8')).join('\n');
  const html = fs.readFileSync(path.join(webRoot, 'index.html'), 'utf8').replace('</head>', '<style>' + css + '</style></head>');
  const dom = new JSDOM(html, {url:'https://appassets.androidplatform.net/index.html', runScripts:'outside-only'});
  opened.push(dom);
  const w = dom.window, calls = [];
  const snapshot = {
    ready:true, busy:false, proBusy:false, permissions:'workspace-write', status:'Connected',
    threadId:'task', cwd:'/test/project', workspace:{selected:true,key:'project',name:'Project',available:true},
    apiActive:'proxy', apiProviders:[{id:'proxy',hasKey:true}],
    models:[{id:'gpt-6.1-sol',model:'gpt-6.1-sol',isDefault:true}], projects:[], sessions:[],
    messages:[{id:'answer',role:'assistant',text:'A message to read while the task continues.'}], ...task
  };
  w.matchMedia = () => ({matches:false, addEventListener(){}});
  w.requestAnimationFrame = callback => w.setTimeout(callback, 0);
  w.HTMLDialogElement.prototype.showModal = function(){this.setAttribute('open', '');};
  w.HTMLDialogElement.prototype.close = function(){this.removeAttribute('open');this.dispatchEvent(new w.Event('close'));};
  w.Native = {
    locale:() => JSON.stringify({choice:'en',systemLanguage:'en'}),
    postMessage(raw) {
      const message = JSON.parse(raw); calls.push(message);
      queueMicrotask(async () => {
        try {
          const result = overrides[message.action] ? await overrides[message.action](message) :
            message.action === 'state' ? snapshot : message.action === 'rpc' ? {data:[],marketplaces:[]} : {};
          w.mobileCodexEvent('response', {id:message.id, result});
        } catch (error) { w.mobileCodexEvent('response', {id:message.id, error:error.message}); }
      });
    }
  };
  for (const file of ['translations.js', 'locale.js', 'ui-core.js', 'reasoning-policy.js', 'app.js']) w.eval(fs.readFileSync(path.join(webRoot, file), 'utf8'));
  return {w, calls, snapshot};
}

function assertStopReachable(w) {
  const stop = w.document.getElementById('stop');
  assert.equal(stop.hidden, false, 'The active task exposes its stop button');
  assert.notEqual(w.getComputedStyle(stop).display, 'none', 'Composer CSS must keep Stop visible outside the input');
  assert.equal(stop.disabled, false, 'Stop stays actionable');
  const send = w.document.getElementById('send');
  assert.equal(send.hidden, true, 'A running task exposes only Stop in the action position');
  assert.equal(w.getComputedStyle(send).display, 'none');
  assert.equal(w.getComputedStyle(stop).backgroundColor, 'rgb(215, 58, 73)');
}

test('Codex tasks expose Stop on initial restore without input focus', async () => {
  for (const task of [{busy:true}]) {
    const {w} = setup(task); await tick();
    assert.equal(w.document.activeElement, w.document.body);
    assertStopReachable(w);
  }
});

test('reading a message after leaving the composer keeps Stop visible and routes cancellation', async () => {
  for (const [task, action] of [[{busy:true}, 'chat.stop']]) {
    const {w, calls} = setup(task); await tick();
    w.document.getElementById('prompt').focus();
    w.document.querySelector('.msg-copy-btn').focus();
    await tick();
    assertStopReachable(w);
    w.document.getElementById('stop').click(); await tick();
    assert.equal(calls.filter(call => call.action === action).length, 1);
  }
});

test('task transitions use the newest restored conversation state and keep the idle toolbar stable', async () => {
  const {w, snapshot} = setup({busy:true}); await tick();
  w.document.querySelector('.msg-copy-btn').focus();
  await tick();
  w.mobileCodexEvent('state', {...snapshot,busy:false,threadId:'idle'});
  assert.equal(w.document.getElementById('stop').hidden, true);
  assert.equal(w.document.getElementById('composer').classList.contains('composer-expanded'), true);
  w.mobileCodexEvent('state', {...snapshot,busy:true,threadId:'next-task'});
  assertStopReachable(w);
  w.mobileCodexEvent('state', {...snapshot,busy:false,proBusy:false,threadId:'done'});
  assert.equal(w.document.getElementById('stop').hidden, true);
  assert.equal(w.document.getElementById('composer').classList.contains('composer-expanded'), true);
});


test('typing during a task preserves one red Stop until completion', async () => {
  const {w, snapshot} = setup({busy:true,turnId:'running'}); await tick();
  const prompt = w.document.getElementById('prompt');
  prompt.value = 'Keep this draft while the task is running';
  prompt.dispatchEvent(new w.Event('input'));
  assertStopReachable(w);
  w.mobileCodexEvent('state', {...snapshot,busy:false,turnId:''});
  assert.equal(w.document.getElementById('stop').hidden, true);
  assert.equal(w.document.getElementById('send').hidden, false);
  assert.equal(w.document.getElementById('send').disabled, false);
  assert.equal(prompt.value, 'Keep this draft while the task is running');
});

test('Ctrl/Cmd+Enter preserves steering and queued input while Stop remains available', async () => {
  for (const [turnId, modifier, action] of [['running','ctrlKey','chat.steer'],['','metaKey','chat.send']]) {
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    const {w, calls} = setup({busy:true,turnId}, {[action]:() => pending}); await tick();
    const prompt = w.document.getElementById('prompt');
    prompt.value = 'Additional instruction';
    prompt.dispatchEvent(new w.Event('input'));
    prompt.dispatchEvent(new w.KeyboardEvent('keydown', {key:'Enter',[modifier]:true,bubbles:true,cancelable:true}));
    await tick();
    const sent = calls.filter(call => call.action === action);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].args.text, 'Additional instruction');
    assert.equal(sent[0].args.expectedTurnId, turnId);
    assertStopReachable(w);
    finish({}); await tick();
    assert.equal(prompt.value, '');
    assertStopReachable(w);
  }
});

test('a rejected steering request keeps the draft and the active Stop button', async () => {
  const {w} = setup({busy:true,turnId:'running'}, {'chat.steer':() => { throw new Error('Try again'); }}); await tick();
  const prompt = w.document.getElementById('prompt');
  prompt.value = 'Do not lose this instruction';
  prompt.dispatchEvent(new w.Event('input'));
  prompt.dispatchEvent(new w.KeyboardEvent('keydown', {key:'Enter',ctrlKey:true,bubbles:true,cancelable:true}));
  await tick();
  assert.equal(prompt.value, 'Do not lose this instruction');
  assertStopReachable(w);
});
