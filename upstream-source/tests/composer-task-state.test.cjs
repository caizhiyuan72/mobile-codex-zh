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
    messages:[{id:'question',role:'user',text:'Please continue.'},{id:'answer',role:'assistant',text:'A message to read while the task continues.'}], ...task
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
  for (const file of ['appearance.js', 'translations.js', 'locale.js', 'ui-core.js', 'reasoning-policy.js', 'app.js']) w.eval(fs.readFileSync(path.join(webRoot, file), 'utf8'));
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


test('typing replaces Stop with Send and clicking it steers the running task', async () => {
  const {w, calls} = setup({busy:true,turnId:'running'}); await tick();
  const prompt = w.document.getElementById('prompt');
  const send = w.document.getElementById('send');
  const stop = w.document.getElementById('stop');
  assertStopReachable(w);
  prompt.value = 'Additional instruction';
  prompt.dispatchEvent(new w.Event('input'));
  assert.equal(send.hidden, false);
  assert.equal(stop.hidden, true);
  prompt.value = '   ';
  prompt.dispatchEvent(new w.Event('input'));
  assertStopReachable(w);
  prompt.value = 'Additional instruction';
  prompt.dispatchEvent(new w.Event('input'));
  send.click(); await tick();
  assert.equal(calls.find(call => call.action === 'chat.steer').args.text, 'Additional instruction');
  assert.equal(prompt.value, '');
  assertStopReachable(w);
});

test('Ctrl/Cmd+Enter sends only once while waiting for acknowledgement', async () => {
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
    const send = w.document.getElementById('send');
    assert.equal(send.hidden, false);
    assert.equal(send.disabled, true);
    prompt.dispatchEvent(new w.KeyboardEvent('keydown', {key:'Enter',[modifier]:true,bubbles:true,cancelable:true}));
    await tick();
    assert.equal(calls.filter(call => call.action === action).length, 1);
    finish({}); await tick();
    assert.equal(prompt.value, '');
    assertStopReachable(w);
  }
});

test('a rejected steering request keeps the draft and allows retry', async () => {
  const {w} = setup({busy:true,turnId:'running'}, {'chat.steer':() => { throw new Error('Try again'); }}); await tick();
  const prompt = w.document.getElementById('prompt');
  prompt.value = 'Do not lose this instruction';
  prompt.dispatchEvent(new w.Event('input'));
  prompt.dispatchEvent(new w.KeyboardEvent('keydown', {key:'Enter',ctrlKey:true,bubbles:true,cancelable:true}));
  await tick();
  assert.equal(prompt.value, 'Do not lose this instruction');
  assert.equal(w.document.getElementById('send').hidden, false);
  assert.equal(w.document.getElementById('send').disabled, false);
});

test('failed conversations show a persistent safe explanation and open a new chat in the same project', async () => {
  const {w, calls, snapshot} = setup({conversationFailure:{code:'encrypted_transport_changed',message:'private upstream body'}});
  await tick();
  const panel = w.document.getElementById('conversation-failure');
  assert.equal(panel.hidden, false);
  assert.match(panel.textContent, /HTTP 409/);
  assert.equal(panel.textContent.includes('private upstream body'), false);
  w.mobileCodexEvent('state', snapshot);
  assert.equal(panel.hidden, false);
  w.document.getElementById('conversation-failure-new').click(); await tick();
  const created = calls.filter(call => call.action === 'chat.new');
  assert.equal(created.length, 1);
  assert.equal(created[0].args.workspaceKey, 'project');
  assert.equal(calls.some(call => call.action === 'chat.send' || call.action === 'sessions.delete'), false);

});

test('failure panel follows the selected conversation and stays hidden during retry or after recovery', async () => {
  const {w, snapshot} = setup({conversationFailure:{code:'upstream_conflict'}}); await tick();
  const panel = w.document.getElementById('conversation-failure');
  assert.equal(panel.hidden, false);
  w.mobileCodexEvent('state', {...snapshot,busy:true});
  assert.equal(panel.hidden, true);
  w.mobileCodexEvent('state', {...snapshot,threadId:'other',conversationFailure:null});
  assert.equal(panel.hidden, true);
  w.mobileCodexEvent('state', snapshot);
  assert.equal(panel.hidden, false);
  w.mobileCodexEvent('state', {...snapshot,conversationFailure:null});
  assert.equal(panel.hidden, true);
  assert.equal(w.document.getElementById('conversation-failure-message').textContent, '');
});

test('a pending resend prevents the failure action from switching chats and a rejected resend keeps the draft', async () => {
  let rejectSend;
  const pending = new Promise((_, reject) => { rejectSend = reject; });
  const {w} = setup({conversationFailure:{code:'upstream_connection'}}, {'chat.send':() => pending}); await tick();
  const prompt = w.document.getElementById('prompt');
  const newChat = w.document.getElementById('conversation-failure-new');
  prompt.value = 'Continue the existing task'; prompt.dispatchEvent(new w.Event('input'));
  w.document.getElementById('composer').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
  await tick();
  assert.equal(newChat.disabled, true);
  rejectSend(new Error('Request failed')); await tick();
  assert.equal(newChat.disabled, false);
  assert.equal(prompt.value, 'Continue the existing task');
  assert.equal(w.document.getElementById('conversation-failure').hidden, false);
});
