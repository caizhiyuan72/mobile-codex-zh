#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const android = path.join(root, 'app/src');
const assets = path.join(android, 'main/assets');
const web = path.join(assets, 'web');
const origin = 'https://appassets.androidplatform.net';
const textFile = /\.(?:[cm]?js|ts|tsx|jsx|css|html?|json|xml|svg|java|kt|kts|py|properties|txt|md|yml|yaml|mustache|hbs|tmpl|vue|svelte)$/i;
const hangul = /\p{Script=Hangul}/u;
const escapedChar = /\\u\{([\da-f]{1,6})\}|\\u([\da-f]{4})|&#x([\da-f]+);|&#(\d+);/giu;
const draft = Array.from({length: 18}, (_, index) => `${index + 1}. 保留未发送的草稿。 Keep editing this line.`).join('\n');
const tail = '[data-id="reply-23"]';
const messages = Array.from({length: 24}, (_, index) => [
  {id: `user-${index}`, role: 'user', text: '检查项目布局并保留阅读位置。'},
  ...(index === 0 ? [
    {id: 'tool-0', kind: 'toolActivity', activityKind: 'command', activityTurnId: 'turn-0', detail: 'printf fixture', output: 'fixture output', completed: true},
  ] : []),
  {id: `reply-${index}`, role: 'assistant', completedTurnId: `turn-${index}`, finalForTurn: true,
    text: index === 23 ? '已完成。 Latest reply.' : [
      '界面切换后应保留对话、阅读位置和输入草稿。',
      '```js\nconst draft = "hello";\n```',
      '最后一条消息不应被输入栏或键盘遮住。',
    ].join('\n\n')},
]).flat();
const model = {id: 'demo-model', model: 'demo-model', displayName: 'Demo Model', isDefault: true};
const fixture = {
  ready: true, busy: false, models: [model], sessions: [], projects: [], account: {}, permissions: 'workspace-write',
  status: '已连接', threadId: 'glass-regression', cwd: '/workspace/demo', apiActive: 'demo',
  apiProviders: [{id: 'demo', name: '示例', baseUrl: 'https://example.test/v1', hasKey: true, models: [model]}],
  workspace: {selected: true, name: '大肥龙', key: 'demo', available: true, hasLocalFolder: true}, messages,
};

function filesUnder(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(file) : entry.isFile() ? [file] : [];
  });
}

function checkHangul() {
  const nativeSets = fs.readdirSync(android, {withFileTypes: true})
    .filter(entry => entry.isDirectory() && !/^(?:androidTest|test)/.test(entry.name));
  const files = [...filesUnder(web), ...filesUnder(path.join(assets, 'document-preview')), ...filesUnder(path.join(assets, 'rooms')),
    ...nativeSets.flatMap(({name}) => ['res', 'java', 'kotlin'].flatMap(group => filesUnder(path.join(android, name, group)))
      .concat(path.join(android, name, 'AndroidManifest.xml'))),
    ...fs.readdirSync(assets).filter(name => /^translations-.*\.json$/.test(name)).map(name => path.join(assets, name)),
  ].filter(file => textFile.test(file) && fs.existsSync(file));
  assert.ok(files.length > 0, 'No packaged text sources found');
  const findings = [];
  for (const file of files.sort()) {
    const relative = path.relative(root, file);
    if (hangul.test(relative) || /(?:^|[\\/])(?:values-ko(?:-|[\\/])|values-b\+ko(?:[+\\/]))/.test(relative)) findings.push(relative);
    fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, index) => {
      const decoded = line.replace(escapedChar, (match, braced, fixed, hexEntity, decimalEntity) => {
        const code = parseInt(braced || fixed || hexEntity || decimalEntity, decimalEntity ? 10 : 16);
        return code <= 0x10ffff ? String.fromCodePoint(code) : match;
      });
      const css = file.endsWith('.css') ? decoded.replace(/\\([\da-f]{1,6})(?:\s|(?=[^\da-f])|$)/giu,
        (match, hex) => parseInt(hex, 16) <= 0x10ffff ? String.fromCodePoint(parseInt(hex, 16)) : match) : decoded;
      if (hangul.test(css)) findings.push(`${relative}:${index + 1}`);
    });
  }
  assert.equal(findings.length, 0, `${findings.length} Hangul locations:\n${findings.slice(0, 18).join('\n')}`);
  return `${files.length} source files`;
}

function checkTranslations() {
  const read = file => fs.readFileSync(file, 'utf8');
  const context = vm.createContext({window: {}});
  for (const name of ['translations.js', 'translations-zh.js']) {
    vm.runInContext(read(path.join(web, name)), context, {filename: name, timeout: 1000});
  }
  const catalogs = [
    ['Web', context.window.MobileCodexEnglish, context.window.MobileCodexChinese],
    ['Android', ...['en', 'zh-CN'].map(language => JSON.parse(read(path.join(assets, `translations-${language}.json`))))],
  ];
  const placeholders = text => (text.match(/\{[\w]+\}|%(?:(?:\d+\$)?[sdif])|\$\{[\w]+\}/g) || []).sort();
  const findings = [];
  for (const [label, english, chinese] of catalogs) {
    assert.ok(english && chinese && Object.keys(english).length && Object.keys(chinese).length, `${label} catalogs are missing or empty`);
    for (const key of new Set([...Object.keys(english), ...Object.keys(chinese)])) {
      const en = english[key], zh = chinese[key];
      if (!Object.hasOwn(english, key) || !Object.hasOwn(chinese, key)) {
        findings.push(`${label} missing ${Object.hasOwn(english, key) ? 'zh-CN' : 'en'}: ${JSON.stringify(key)}`);
      } else if (typeof en !== 'string' || typeof zh !== 'string' || !en.trim() || !zh.trim()) {
        findings.push(`${label} empty/non-string translation: ${JSON.stringify(key)}`);
      } else if (JSON.stringify(placeholders(en)) !== JSON.stringify(placeholders(zh))) {
        findings.push(`${label} mismatched placeholders for ${JSON.stringify(key)}`);
      }
    }
  }
  assert.equal(findings.length, 0, `${findings.length} catalog mismatches:\n${findings.slice(0, 18).join('\n')}`);
  return catalogs.map(([label, english]) => `${label}: ${Object.keys(english).length} keys`).join(', ');
}

async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const active = document.getAnimations().filter(animation => {
      const end = animation.effect?.getComputedTiming().endTime;
      return Number.isFinite(end) && end <= 1000 && animation.playState === 'running';
    });
    if (active.length) await Promise.race([
      Promise.all(active.map(animation => animation.finished.catch(() => {}))),
      new Promise(resolve => setTimeout(resolve, 1100)),
    ]);
  });
}

async function installFixture(page, style, scheme) {
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    const file = path.resolve(web, '.' + decodeURIComponent(url.pathname));
    if (url.origin !== origin || !file.startsWith(web + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return route.abort();
    return route.fulfill({path: file});
  });
  await page.addInitScript(({snapshot, style, scheme}) => {
    if (!localStorage.getItem('interfaceStyle')) localStorage.setItem('interfaceStyle', style);
    if (!localStorage.getItem('theme')) localStorage.setItem('theme', scheme);
    window.fixtureCalls = [];
    window.Native = {
      locale: () => JSON.stringify({choice: localStorage.getItem('language') || 'zh-CN', systemLanguage: 'zh-CN', brandName: '大肥龙'}),
      textSize: () => JSON.stringify({percent: 100}),
      postMessage(raw) {
        const call = JSON.parse(raw);
        window.fixtureCalls.push(call);
        const responses = {
          state: snapshot,
          'files.list': {entries: [{path: 'fixture.txt', name: 'fixture.txt', directory: false, size: 16}]},
          'files.read': {path: 'fixture.txt', content: 'original content', sha256: 'a'.repeat(64)},
        };
        const result = responses[call.action] || {};
        setTimeout(() => window.mobileCodexEvent('response', {id: call.id, result}), 0);
      },
    };
  }, {snapshot: fixture, style, scheme});
  await page.goto(origin + '/index.html');
  await page.locator(tail).waitFor();
  await settle(page);
}

async function openSettings(page) {
  if (!(await page.locator('#settings').isVisible()) || page.viewportSize().width <= 760) {
    const toggle = page.locator('.topbar .sidebar-toggle');
    if (!(await page.locator('body').evaluate(body => body.classList.contains('sidebar-open')))) await toggle.click();
  }
  await page.locator('#settings').click();
  await page.locator('#settings-dialog[open]').waitFor();
  await settle(page);
}

async function closeDialog(page, name) {
  const dialog = page.locator(`#${name}`);
  const button = dialog.locator(`[data-close="${name}"]:not(.sheet-grip, .sheet-grabber, [data-sheet-grabber]):visible`).first();
  if (await button.count()) await button.click(); else await page.keyboard.press('Escape');
  await dialog.waitFor({state: 'hidden'});
  await settle(page);
}

const grip = '.sheet-grip, .sheet-grabber, [data-sheet-grabber]';
const topButtons = '.topbar > button';
const prompt = '#prompt';
const scroll = '#chat-scroll';

async function checkAppearance(page, style, scheme, choice = scheme) {
  assert.deepEqual(await page.locator('html').evaluate(node => ({
    liquid: node.hasAttribute('data-liquid-glass'), theme: node.dataset.theme,
    savedStyle: localStorage.getItem('interfaceStyle'), savedTheme: localStorage.getItem('theme'),
  })), {liquid: style === 'glass', theme: scheme, savedStyle: style, savedTheme: choice});
}

async function checkLayout(page, style, scheme) {
  await checkAppearance(page, style, scheme);
  const shape = await page.evaluate(({topButtons, tail}) => {
    const box = node => node.getBoundingClientRect().toJSON();
    const form = document.querySelector('#composer');
    const add = document.querySelector('#add-attachment'), send = document.querySelector('#send');
    const composerStyle = getComputedStyle(form);
    const control = node => ({rect: box(node), radius: getComputedStyle(node).borderTopLeftRadius});
    return {width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth,
      top: [...document.querySelectorAll(topButtons)].map(node => ({id: node.id, rect: box(node)})),
      bar: box(document.querySelector('.topbar')), field: box(document.querySelector('#prompt')),
      composer: box(form), add: control(add), send: control(send), last: box(document.querySelector(tail)),
      padding: parseFloat(composerStyle.paddingLeft), outer: parseFloat(composerStyle.borderTopLeftRadius)};
  }, {topButtons, tail});
  assert.equal(shape.top.length, 3, 'Topbar must have three direct buttons');
  assert.deepEqual(shape.top.slice(1).map(button => button.id), ['header-more', 'header-new-chat']);
  assert.ok(shape.top[0].rect.right <= shape.top[1].rect.left + 1 && shape.top[1].rect.right <= shape.top[2].rect.left + 1,
    'Topbar buttons overlap or are out of order');
  for (const {rect, id} of shape.top) {
    assert.ok(rect.width >= 40 && rect.height >= 40 && rect.left >= -1 && rect.right <= shape.width + 1, `${id || 'sidebar'} is clipped or too small`);
  }
  assert.equal(shape.documentWidth, shape.width, 'Page has horizontal overflow');
  assert.ok(shape.composer.left >= 6 && shape.composer.right <= shape.width - 6 && shape.composer.bottom <= shape.height + 1,
    'Composer must fit inside viewport gutters');
  assert.ok(shape.field.width > 0 && shape.field.right <= shape.composer.right && shape.field.left >= shape.composer.left,
    'Prompt falls outside composer');
  for (const {radius, rect} of [shape.add, shape.send]) {
    assert.ok(rect.width >= 40 && rect.height >= 40, 'Composer touch targets are too small');
    const inner = Math.min(parseFloat(radius) * (radius.endsWith('%') ? Math.min(rect.width, rect.height) / 100 : 1), rect.width / 2, rect.height / 2);
    assert.ok(Math.abs(shape.outer - shape.padding - inner) <= 1,
      `Composer radii: ${shape.outer}px outer − ${shape.padding}px inset != ${inner}px inner`);
  }
}

async function checkFilters(page, style, scheme) {
  const active = await page.evaluate(grip => [...document.querySelectorAll('*')].flatMap(node => {
    const approved = node.closest('.topbar') && node.matches('.topbar, .topbar > button') ||
      node.matches(`#composer, #composer-add-menu, #jump-latest, dialog, .appearance-choices, .segment-thumb, ${grip}`);
    return ['', '::before', '::after', ...(node.matches('dialog') ? ['::backdrop'] : [])].flatMap(pseudo => {
      const filter = getComputedStyle(node, pseudo || null).backdropFilter;
      return filter === 'none' ? [] : [{approved: Boolean(approved) && pseudo !== '::backdrop', node: node.id || node.className || node.tagName, pseudo, filter}];
    });
  }), grip);
  if (style === 'classic') assert.deepEqual(active, [], 'Classic surfaces must not apply backdrop blur');
  else {
    assert.deepEqual(active.filter(node => !node.approved), [], 'Backdrop blur spilled beyond the floating control layer');
    const expected = scheme === 'dark' ? 'blur(24px) saturate(1.6)' : 'blur(22px) saturate(1.9)';
    assert.ok(active.some(node => node.node === 'composer' && node.filter === expected), `Composer must use ${expected}`);
    assert.ok(active.some(node => /topbar|header-more|header-new-chat|sidebar-toggle/.test(node.node) && node.filter === expected), `Topbar must use ${expected}`);
  }
}

function luminance(color) {
  return [0.2126, 0.7152, 0.0722].reduce((total, weight, channel) => {
    const srgb = color[channel] / 255;
    return total + weight * (srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4);
  }, 0);
}

async function checkContrast(page, targets) {
  const {PNG} = require('pngjs');
  const samples = await page.evaluate(targets => targets.map(([selector, kind]) => {
    const node = document.querySelector(selector);
    if (!node) throw new Error(`Missing contrast target: ${selector}`);
    const style = getComputedStyle(node);
    const range = document.createRange();
    range.selectNodeContents(node);
    let opacity = 1;
    for (let parent = node; parent; parent = parent.parentElement) opacity *= Number(getComputedStyle(parent).opacity);
    const color = kind === 'icon' ? (style.stroke === 'none' ? style.fill : style.stroke) : style.webkitTextFillColor;
    const rects = kind === 'icon' ? [node.getBoundingClientRect()] : [...range.getClientRects()];
    const clip = node.getBoundingClientRect();
    const bounds = rects.map(rect => ({left: Math.max(clip.left, rect.left), right: Math.min(clip.right, rect.right),
      top: Math.max(clip.top, rect.top), bottom: Math.min(clip.bottom, rect.bottom)}));
    return {selector, color, opacity, bounds, icon: kind === 'icon'};
  }), targets);
  const rule = targets.map(([selector, kind]) => kind === 'icon'
    ? `:is(${selector}), :is(${selector}) * { stroke: transparent !important; fill: transparent !important; }`
    : `:is(${selector}) { -webkit-text-fill-color: transparent !important; text-shadow: none !important; }`).join('\n');
  const sheet = await page.evaluateHandle(css => {
    const style = new CSSStyleSheet();
    style.replaceSync(css);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, style];
    return style;
  }, rule);
  let image;
  try { image = PNG.sync.read(await page.screenshot({animations: 'disabled', scale: 'css'})); }
  finally {
    await page.evaluate(style => { document.adoptedStyleSheets = document.adoptedStyleSheets.filter(sheet => sheet !== style); }, sheet);
    await sheet.dispose();
  }
  const results = samples.map(({selector, color, opacity, bounds, icon}) => {
    assert.match(color, /^rgba?\(/, `${selector} must have an RGB foreground`);
    const [red, green, blue, alpha = 1] = color.match(/[\d.]+/g).map(Number);
    const coverage = alpha * opacity;
    let minimum = Infinity;
    for (const box of bounds) {
      for (let row = Math.max(0, Math.ceil(box.top) + 1); row < Math.min(image.height, Math.floor(box.bottom) - 1); row++) {
        for (let column = Math.max(0, Math.ceil(box.left) + 1); column < Math.min(image.width, Math.floor(box.right) - 1); column++) {
          const offset = (row * image.width + column) * 4;
          const rgb = image.data.subarray(offset, offset + 3);
          const back = luminance(rgb);
          const front = luminance([red, green, blue].map((value, channel) => value * coverage + rgb[channel] * (1 - coverage)));
          minimum = Math.min(minimum, (Math.max(back, front) + 0.05) / (Math.min(back, front) + 0.05));
        }
      }
    }
    return {selector, minimum, required: icon ? 3 : 4.5};
  });
  const failures = results.filter(({minimum, required}) => !Number.isFinite(minimum) || minimum < required);
  assert.equal(failures.length, 0, failures.map(({selector, minimum, required}) => `${selector}: ${Number.isFinite(minimum) ? minimum.toFixed(2) : 'not visible'} (need ${required}:1)`).join('\n'));
  return results.map(({minimum}) => minimum);
}

async function checkChatContrast(page) {
  await page.locator(scroll).evaluate(node => { node.scrollTop = 0; });
  await page.locator('#prompt').fill('Draft');
  await page.locator('#prompt').blur();
  await settle(page);
  const banner = page.locator('#phone-stop-banner');
  await banner.evaluate(node => { node.hidden = false; });
  try {
    const [stop, area] = await Promise.all([banner.boundingBox(), page.locator(scroll).boundingBox()]);
    assert.ok(stop && area && stop.y + stop.height <= area.y + 1, 'Phone stop banner overlaps the conversation');
    return await checkContrast(page, [
      ['#header-title'], ['[data-id="user-0"] .user-message-text'], ['[data-id="reply-0"] > p:first-of-type'],
      ['[data-id="reply-0"] .code-lang'], ['[data-id="reply-0"] .code-card pre code'], ['#send svg', 'icon'], ['#phone-stop-banner'],
    ]);
  } finally { await banner.evaluate(node => { node.hidden = true; }); }
}

async function checkSettingsContrast(page) {
  await openSettings(page);
  try {
    return await checkContrast(page, [
      ['#settings-dialog .dialog-head h2'], ['#appearance-title'], ['#theme-title'],
      ['.appearance-choices label:has(input:checked) span'], ['.appearance-choices label:has(input:not(:checked)) span'],
      ['#theme-choices label:has(input:checked) span'], ['#theme-choices label:has(input:not(:checked)) span'],
    ]);
  } finally { await closeDialog(page, 'settings-dialog'); }
}

async function checkDialogGeometry(page, name) {
  const bounds = await page.locator(`#${name}`).evaluate(node => {
    const rect = node.getBoundingClientRect();
    return {left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: innerWidth, height: innerHeight};
  });
  assert.ok(bounds.left >= -1 && bounds.top >= -1 && bounds.right <= bounds.width + 1 && bounds.bottom <= bounds.height + 1,
    `${name} is clipped: ${JSON.stringify(bounds)}`);
}

async function checkDisclosure(page) {
  await page.locator('#header-more').click();
  const header = page.locator('#header-menu-dialog[open]');
  await header.waitFor();
  for (const id of ['header-api', 'files-toggle']) await header.locator(`#${id}`).waitFor();
  await closeDialog(page, 'header-menu-dialog');

  const options = page.locator('#composer-add-menu #composer-options');
  assert.equal(await options.count(), 1, 'Model options must be inside the + menu');
  assert.equal(await options.isVisible(), false, 'Model options must be hidden by default');
  await page.locator('#add-attachment').click();
  await options.click();
  await page.locator('#model-picker[open]').waitFor();
  await settle(page);
  await checkDialogGeometry(page, 'model-picker');
  const picker = await page.locator('#model-picker').boundingBox();
  assert.ok(picker.y + picker.height >= page.viewportSize().height - 16, 'Mobile model picker is not a bottom sheet');
  await closeDialog(page, 'model-picker');
  assert.equal(await options.isVisible(), false, 'Closing the model picker must restore the compact composer');

  const work = page.locator('.work-toggle:not(.tool-group)').first();
  const tools = page.locator('.work-toggle.tool-group').first();
  const entry = page.locator('[data-id="tool-0"]');
  assert.equal(await work.getAttribute('aria-expanded'), 'false');
  assert.equal(await entry.isVisible(), false);
  await work.click();
  assert.equal(await work.getAttribute('aria-expanded'), 'true');
  await tools.waitFor();
  assert.equal(await tools.getAttribute('aria-expanded'), 'false');
  await tools.click();
  const details = entry.locator('details');
  await details.locator('summary').click();
  assert.match(await details.locator('pre').innerText(), /fixture output/);
  await tools.click();
  await entry.waitFor({state: 'hidden'});
  await work.click();
  await tools.waitFor({state: 'hidden'});

  await openSettings(page);
  const primary = page.locator('#settings-dialog .settings-primary');
  for (const item of ['#appearance-classic', '#theme-choices', '#language']) assert.equal(await primary.locator(item).count(), 1);
  try {
    const advanced = page.locator('#settings-dialog details.settings-advanced');
    const summary = advanced.locator(':scope > summary');
    await summary.waitFor();
    assert.equal(await advanced.evaluate(node => node.open), false);
    await summary.click();
    assert.equal(await advanced.evaluate(node => node.open), true);
    await summary.click();
    assert.equal(await advanced.evaluate(node => node.open), false);
  } finally { await closeDialog(page, 'settings-dialog'); }
}

async function checkSheets(page) {
  const missing = await page.locator('dialog').evaluateAll((dialogs, grip) => dialogs
    .filter(dialog => !dialog.querySelector(grip)).map(dialog => dialog.id || dialog.className), grip);
  assert.deepEqual(missing, [], 'Dialogs missing grabbers');
  await openSettings(page);
  const settingsGrip = page.locator('#settings-dialog').locator(grip).first();
  await settingsGrip.waitFor();
  const rect = await settingsGrip.boundingBox();
  const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 128, {steps: 8});
  await page.mouse.up();
  await page.locator('#settings-dialog').waitFor({state: 'hidden'});
}

async function checkApproval(page) {
  const request = {key: 'test-approval', method: 'item/commandExecution/requestApproval',
    params: {threadId: fixture.threadId, reason: 'Fixture approval', command: 'printf fixture'}};
  await page.evaluate(request => window.mobileCodexEvent('server.request', request), request);
  const approval = page.locator('#request-dialog[open]');
  await approval.waitFor();
  const approvalGrip = approval.locator(grip).first();
  await approvalGrip.waitFor();
  if (await approvalGrip.evaluate(node => node.matches('button') && !node.disabled && node.getAttribute('aria-disabled') !== 'true')) {
    await approvalGrip.click();
    await settle(page);
    if (!(await approval.count())) {
      await page.locator('#resume-request').click();
      await approval.waitFor();
      assert.equal(await approval.locator('#request-reason').innerText(), 'Fixture approval', 'Dismissing the sheet must preserve the queued request');
    }
  }
  await page.keyboard.press('Escape');
  await settle(page);
  if (!(await approval.count())) {
    await page.evaluate(() => window.mobileCodexEvent('notification.open', {}));
    await approval.waitFor();
    assert.equal(await approval.locator('#request-reason').innerText(), 'Fixture approval', 'Escape must preserve the queued request');
  }
  assert.equal(await page.evaluate(() => window.fixtureCalls.filter(call => ['rpc.respond', 'chat.stop'].includes(call.action)).length), 0,
    'Dismissal must never respond on behalf of the user');
  await page.evaluate(key => window.mobileCodexEvent('server.resolved', {key}), request.key);
  await approval.waitFor({state: 'hidden'});
  const question = {key:'test-answer', method:'item/tool/requestUserInput', params:{threadId:fixture.threadId,
    questions:[{id:'answer', question:'Fixture question', isSecret:true}]}};
  await page.evaluate(question => window.mobileCodexEvent('server.request', question), question);
  const answer = approval.locator('#request-fields input');
  await answer.fill('unsubmitted answer');
  await approval.locator(grip).first().click();
  await approval.waitFor({state:'hidden'});
  assert.equal(await page.locator('#request-fields input').count(), 0, 'Hidden answer fields are detached from the page');
  await page.locator('#resume-request').click();
  assert.equal(await answer.inputValue(), 'unsubmitted answer', 'Reopening a request keeps the unsent answer');
  await page.evaluate(key => window.mobileCodexEvent('server.resolved', {key}), question.key);
  assert.equal(await page.locator('#resume-request').isVisible(), false);
  assert.equal(await page.locator('#request-fields input').count(), 0, 'Resolution clears the answer');
}

async function checkDirtyEditor(page) {
  await page.locator('#header-more').click();
  await page.locator('#header-menu-dialog #files-toggle').click();
  await page.locator('#file-list .file-row').filter({hasText: 'fixture.txt'}).click();
  const editor = page.locator('#editor-dialog[open]');
  await editor.waitFor();
  await settle(page);
  await checkDialogGeometry(page, 'editor-dialog');
  await editor.locator('#editor').fill('unsaved content');
  await editor.locator(grip).first().click();
  await page.locator('#confirm-dialog[open]').waitFor();
  await settle(page);
  await checkDialogGeometry(page, 'confirm-dialog');
  await page.locator('#confirm-cancel').click();
  await page.locator('#confirm-dialog').waitFor({state: 'hidden'});
  assert.equal(await editor.locator('#editor').inputValue(), 'unsaved content');
  await editor.locator(grip).first().click();
  await page.locator('#confirm-accept').click();
  await editor.waitFor({state: 'hidden'});
  await page.locator('#file-close').click();
}

async function segment(page, group, value, key) {
  const control = page.locator(group);
  const radio = control.locator(`input[value="${value}"]`);
  const thumb = control.locator('span.segment-thumb');
  const index = await radio.evaluate(node => [...node.closest('.appearance-choices').querySelectorAll('input[type="radio"]')].indexOf(node));
  const before = await thumb.boundingBox();
  const wasChecked = await radio.isChecked();
  assert.ok(before?.width > 0, `${group} has no visible sliding thumb`);
  if (key) {
    await control.locator('input:checked').focus();
    await page.keyboard.press(key);
  } else await control.locator(`label:has(input[value="${value}"])`).click();
  await settle(page);
  assert.equal(await radio.isChecked(), true, `${group}: expected ${value}`);
  assert.equal(await control.getAttribute('data-segment'), String(index));
  const after = await thumb.boundingBox();
  const label = await control.locator(`label:has(input[value="${value}"])`).boundingBox();
  assert.ok(after && label && Math.abs(after.x + after.width / 2 - label.x - label.width / 2) <= 4,
    `${group} thumb is not aligned with ${value}`);
  if (!wasChecked) assert.ok(Math.abs(after.x - before.x) > 8, `${group} thumb did not slide`);
}

async function readingAnchor(page, move = false) {
  return page.evaluate(({scroll, move}) => {
    const area = document.querySelector(scroll);
    const readingTop = Math.max(document.querySelector('.topbar').getBoundingClientRect().bottom, area.getBoundingClientRect().top);
    if (move) area.scrollTop += document.querySelector('[data-id="reply-9"]').getBoundingClientRect().top - readingTop - 12;
    const row = [...document.querySelector('#messages').children].find(node =>
      node.dataset.id && !node.hidden && node.getBoundingClientRect().bottom > readingTop);
    return {id: row?.dataset.id, offset: row?.getBoundingClientRect().top - readingTop, scrollTop: area.scrollTop};
  }, {scroll, move});
}

function assertAnchor(actual, expected, name) {
  assert.equal(actual.id, expected.id, `${name}: the first visible message changed`);
  assert.ok(Math.abs(actual.offset - expected.offset) <= 3, `${name}: anchor moved ${actual.offset - expected.offset}px`);
}

async function checkRoundtrip(page, style, scheme) {
  const otherStyle = style === 'classic' ? 'glass' : 'classic', otherScheme = scheme === 'light' ? 'dark' : 'light';
  const interfaceGroup = '.appearance-choices:has(#appearance-classic)';
  await page.locator(prompt).fill(draft);
  await page.locator(prompt).blur();
  await readingAnchor(page, true);
  await settle(page);
  const initial = await readingAnchor(page);
  await page.evaluate(() => {
    window.fixtureNodes = {prompt: document.querySelector('#prompt'), messages: [...document.querySelector('#messages').children]};
  });
  await openSettings(page);
  await segment(page, interfaceGroup, otherStyle, style === 'classic' ? 'ArrowRight' : 'ArrowLeft');
  await checkAppearance(page, otherStyle, scheme);
  await segment(page, '#theme-choices', otherScheme);
  await checkAppearance(page, otherStyle, otherScheme);
  await closeDialog(page, 'settings-dialog');
  const switched = await readingAnchor(page);
  await openSettings(page);
  await segment(page, '#theme-choices', 'system', otherScheme === 'dark' ? 'ArrowLeft' : 'ArrowRight');
  await checkAppearance(page, otherStyle, scheme, 'system');
  await segment(page, '#theme-choices', scheme);
  await segment(page, interfaceGroup, style);
  await closeDialog(page, 'settings-dialog');
  await checkAppearance(page, style, scheme);
  const returned = await readingAnchor(page);
  assert.equal(await page.locator(prompt).inputValue(), draft);
  assert.equal(await page.evaluate(() => {
    const current = [...document.querySelector('#messages').children];
    return window.fixtureNodes.prompt === document.querySelector('#prompt') && current.length === window.fixtureNodes.messages.length &&
      current.every((node, index) => window.fixtureNodes.messages[index] === node);
  }), true, 'Appearance changes recreated the prompt or conversation nodes');
  assertAnchor(returned, initial, 'Appearance roundtrip');
  assert.ok(Math.abs(returned.scrollTop - initial.scrollTop) <= 3, 'Roundtrip changed scrollTop');
  assertAnchor(switched, initial, 'Appearance change');
}

async function checkLanguage(page) {
  await openSettings(page);
  const language = page.locator('#language'), title = page.locator('#appearance-title');
  assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN');
  assert.match(await title.innerText(), /界面主题/);
  await language.selectOption('en');
  await page.waitForFunction(() => document.documentElement.lang === 'en');
  assert.match(await title.innerText(), /interface|appearance/i);
  assert.match(await page.locator('#theme-choices label:has(input[value="dark"])').innerText(), /dark/i);
  assert.match(await page.locator('#send').getAttribute('aria-label'), /send/i);
  await language.selectOption('zh-CN');
  await page.waitForFunction(() => document.documentElement.lang === 'zh-CN');
  assert.match(await title.innerText(), /界面主题/);
  assert.match(await page.locator('#theme-choices label:has(input[value="dark"])').innerText(), /深色/);
  assert.match(await page.locator('#send').getAttribute('aria-label'), /发送/);
  await closeDialog(page, 'settings-dialog');
}

async function checkTail(page, height) {
  await page.waitForFunction(({scroll, tail, height}) => {
    const area = document.querySelector(scroll), last = document.querySelector(tail).getBoundingClientRect();
    const composer = document.querySelector('#composer').getBoundingClientRect();
    return area.scrollHeight - area.clientHeight - area.scrollTop <= 2 && last.bottom <= composer.top + 1 &&
      last.top >= Math.max(area.getBoundingClientRect().top, document.querySelector('.topbar').getBoundingClientRect().bottom) - 1 &&
      composer.bottom <= height + 1 && parseFloat(document.documentElement.style.getPropertyValue('--app-height')) === height;
  }, {scroll, tail, height}, {timeout: 3500}).catch(async () => {
    const metrics = await page.evaluate(({scroll, tail}) => {
      const area = document.querySelector(scroll), latest = document.querySelector(tail).getBoundingClientRect();
      const composer = document.querySelector('#composer').getBoundingClientRect();
      return {remaining: area.scrollHeight - area.clientHeight - area.scrollTop, latest: [latest.top, latest.bottom],
        composer: [composer.top, composer.bottom], appHeight: document.documentElement.style.getPropertyValue('--app-height')};
    }, {scroll, tail});
    assert.fail(`Latest reply not visible above composer at ${height}px: ${JSON.stringify(metrics)}`);
  });
}

async function checkIme(page) {
  const viewport = page.viewportSize(), keyboardHeight = Math.round(viewport.height * .36);
  const input = page.locator(prompt);
  async function keyboard(open) {
    await page.setViewportSize({...viewport, height: open ? keyboardHeight : viewport.height});
    await page.evaluate(open => window.mobileCodexEvent('viewport', {keyboardVisible: open}), open);
    await settle(page);
  }
  await input.fill(draft);
  await input.focus();
  await page.locator(scroll).evaluate(node => { node.scrollTop = node.scrollHeight; });
  await settle(page);
  await checkTail(page, viewport.height);
  const originalHeight = await input.evaluate(node => node.clientHeight);
  await keyboard(true);
  try {
    await checkTail(page, keyboardHeight);
    assert.ok(await input.evaluate((node, originalHeight) => node.clientHeight < originalHeight &&
      node.scrollHeight > node.clientHeight && getComputedStyle(node).overflowY === 'auto', originalHeight),
    'Composer did not shrink and remain scrollable after IME opened');
    await input.press('Control+End');
    await input.press('Enter');
    await settle(page);
    await checkTail(page, keyboardHeight);
    assert.equal(await input.inputValue(), draft + '\n');
    assert.equal(await page.locator(`${prompt}:focus`).count(), 1, 'IME resize lost the input focus');
  } finally { await keyboard(false); }
  await checkTail(page, viewport.height);
  await readingAnchor(page, true);
  await settle(page);
  const reading = await readingAnchor(page);
  await keyboard(true);
  try { assertAnchor(await readingAnchor(page), reading, 'IME while reading history'); }
  finally { await keyboard(false); }
  assertAnchor(await readingAnchor(page), reading, 'IME dismissed while reading history');
}

async function main() {
  let failed = 0, passed = 0;
  async function report(name, test) {
    try {
      const detail = await test();
      passed++;
      console.log(`PASS ${name}${detail ? ` (${detail})` : ''}`);
      return true;
    } catch (error) {
      failed++;
      console.error(`FAIL ${name}: ${error.message}`);
      return false;
    }
  }
  await report('Web and Android Hangul', checkHangul);
  await report('Web and Android translation catalogs', checkTranslations);
  const {chromium} = require('playwright');
  const browser = await chromium.launch({executablePath: process.env.MOBILE_CODEX_BROWSER_EXECUTABLE, args: ['--no-sandbox', '--disable-dev-shm-usage']});
  try {
    for (const [width, height] of [[393, 852], [320, 568], [852, 393], [1280, 900]]) {
      for (const scheme of ['light', 'dark']) for (const style of ['classic', 'glass']) {
        const label = `${width}x${height} ${style}/${scheme}`;
        const page = await browser.newPage({viewport: {width, height}, colorScheme: scheme, deviceScaleFactor: 1});
        page.setDefaultTimeout(3000);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        async function verify(name, test) {
          if (await report(`${label} ${name}`, test)) return;
          await page.evaluate(() => localStorage.clear());
          await page.reload();
          await page.locator(tail).waitFor();
          await settle(page);
        }
        try {
          if (!await report(`${label} load`, () => installFixture(page, style, scheme))) continue;
          await verify('geometry', () => checkLayout(page, style, scheme));
          await verify('blur budget', () => checkFilters(page, style, scheme));
          if (width === 393) {
            await verify('chat AA', async () => `minimum ${Math.min(...await checkChatContrast(page)).toFixed(2)}:1`);
            await verify('settings AA', async () => `minimum ${Math.min(...await checkSettingsContrast(page)).toFixed(2)}:1`);
            await verify('IME simulation', () => checkIme(page));
            await verify('theme roundtrip and sliding segments', () => checkRoundtrip(page, style, scheme));
            if (scheme === 'light') {
              await verify('disclosures', () => checkDisclosure(page));
              await verify('sheet drag dismissal', () => checkSheets(page));
              await verify('queued approval', () => checkApproval(page));
              await verify('dirty editor confirmation', () => checkDirtyEditor(page));
            }
            if (style === 'classic' && scheme === 'light') await verify('live language change', () => checkLanguage(page));
          }
          await report(`${label} script errors`, () => assert.deepEqual(errors, []));
        } finally { await page.close(); }
      }
    }
  } finally { await browser.close(); }
  console.log(`${passed} passed, ${failed} failed. Chromium viewport/IME simulation only; Android input and frame pacing are not measured.`);
  if (failed) process.exitCode = 1;
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });
