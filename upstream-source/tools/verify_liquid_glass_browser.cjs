#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright');
const {PNG} = require('pngjs');

const root = path.resolve(__dirname, '..');
const web = path.join(root, 'app/src/main/assets/web');
const origin = 'https://appassets.androidplatform.net';
const baselineRef = 'ba06d734';
const baselineFile = process.env.LIQUID_GLASS_BASELINE_CSS;
const baselineCss = baselineFile ? fs.readFileSync(baselineFile, 'utf8') : execFileSync('git', [
  'show', `${baselineRef}:upstream-source/app/src/main/assets/web/liquid-glass.css`,
], {cwd: root, encoding: 'utf8'});
assert.ok(baselineCss.includes('html[data-liquid-glass]'), 'Expected liquid-glass.css from the baseline revision');
const android = fs.readFileSync(path.join(root, 'app/src/main/java/dev/mobilecodex/app/MainActivity.java'), 'utf8');
const systemColors = android.match(/\? \(dark \? "#([\da-f]{6})" : "#([\da-f]{6})"\)/i);
assert.ok(systemColors, 'Could not locate native Liquid Glass system bar colors');
const viewports = [[320, 568, 326], [393, 852, 395], [393, 508, 305], [852, 393, 238], [1280, 900]];
const topControls = '.topbar, .topbar-left, .topbar button, #header-title';
const draft = '保留未发送的草稿。\nKeep editing this line.\nThird line.\nFourth line.\nFifth line.';
const messages = Array.from({length: 24}, (_, index) => [
  {id: `user-${index}`, role: 'user', text: '检查项目布局并保留阅读位置。'},
  {id: `reply-${index}`, role: 'assistant', text: index === 23 ? '已完成。 Latest reply.' : [
    '界面切换后应保留对话、阅读位置和输入草稿。',
    'The controls float over the conversation as you scroll.',
    '```js\nconst draft = "hello";\n```',
    '最后一条消息不应被输入栏或键盘遮住。',
  ].join('\n\n')},
]).flat();
const fixture = {
  ready: true, busy: false, models: [], sessions: [], projects: [], account: {}, permissions: 'workspace-write',
  status: '已连接', threadId: 'glass-regression', cwd: '/workspace/demo', apiActive: 'demo',
  apiProviders: [{id: 'demo', name: '示例', baseUrl: 'https://example.test/v1', hasKey: true, models: []}],
  workspace: {selected: true, name: '大肥龙', key: 'demo', available: true, hasLocalFolder: true}, messages,
};

async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await Promise.all(document.getAnimations().filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime))
      .map(animation => animation.finished.catch(() => {})));
  });
}

async function installFixture(page, css) {
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    const file = path.resolve(web, '.' + url.pathname);
    if (url.origin !== origin || !file.startsWith(web + path.sep)) return route.abort();
    if (css && url.pathname === '/liquid-glass.css') return route.fulfill({contentType: 'text/css', body: css});
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return route.abort();
    return route.fulfill({path: file});
  });
  await page.addInitScript(snapshot => {
    window.Native = {
      locale: () => JSON.stringify({choice: 'zh-CN', systemLanguage: 'zh-CN', brandName: '大肥龙'}),
      textSize: () => JSON.stringify({percent: 100}),
      postMessage(raw) {
        const call = JSON.parse(raw);
        const result = call.action === 'state' ? snapshot : {};
        setTimeout(() => window.mobileCodexEvent('response', {id: call.id, result}), 0);
      },
    };
  }, fixture);
  await page.goto(origin + '/index.html');
  await page.locator('[data-id="reply-23"]').waitFor();
  await page.locator('#prompt').fill(draft);
  await page.locator('#prompt').blur();
  await page.mouse.move(0, 0);
  await settle(page);
}

async function openSettings(page) {
  if (page.viewportSize().width <= 760) await page.locator('.topbar .sidebar-toggle').click();
  await page.locator('#settings').click();
  await page.locator('#settings-dialog[open]').waitFor();
  await settle(page);
}

async function selectInterface(page, interfaceStyle) {
  await page.locator(`label:has(#appearance-${interfaceStyle}) span`).click();
  assert.equal(await page.locator(`#appearance-${interfaceStyle}`).isChecked(), true);
  assert.deepEqual(await page.evaluate(() => ({
    glass: document.documentElement.hasAttribute('data-liquid-glass'), saved: localStorage.getItem('interfaceStyle'),
  })), {glass: interfaceStyle === 'glass', saved: interfaceStyle});
  await settle(page);
}

async function closeSettings(page) {
  await page.locator('#settings-dialog .dialog-head [data-close="settings-dialog"]').click();
  await page.locator('#settings-dialog').waitFor({state: 'hidden'});
  await page.mouse.move(0, 0);
  await settle(page);
}

async function captureLayout(page, selector) {
  return page.locator(selector).evaluateAll(nodes => nodes.map(node => {
    const style = getComputedStyle(node);
    return {node: node.id || node.className || node.tagName, box: node.getBoundingClientRect().toJSON(), style: [
      style.display, style.color, style.backgroundColor, style.backgroundImage, style.boxShadow, style.backdropFilter,
      style.borderRadius, style.padding, style.margin, style.fontFamily, style.fontSize, style.lineHeight,
    ]};
  }));
}

async function readingAnchor(page, move = false) {
  return page.evaluate(moveToMiddle => {
    const area = document.querySelector('#chat-scroll');
    const readingTop = document.documentElement.hasAttribute('data-liquid-glass')
      ? document.querySelector('.topbar').getBoundingClientRect().bottom : area.getBoundingClientRect().top;
    if (moveToMiddle) {
      const reply = document.querySelector('[data-id="reply-9"]');
      area.scrollTop += reply.getBoundingClientRect().top - readingTop + 12;
    }
    const row = [...document.querySelector('#messages').children].find(node =>
      node.dataset.id && !node.hidden && node.getBoundingClientRect().bottom > readingTop);
    return {id: row?.dataset.id, offset: row?.getBoundingClientRect().top - readingTop, scrollTop: area.scrollTop};
  }, move);
}

function assertAnchor(actual, expected, label) {
  assert.equal(actual.id, expected.id, `${label}: first visible message changed`);
  assert.ok(Math.abs(actual.offset - expected.offset) <= 2, `${label}: ${expected.offset}px → ${actual.offset}px`);
}

async function checkFilters(page, expected = 'none', required = []) {
  const active = await page.evaluate(() => [...document.querySelectorAll('*')].flatMap(node => {
    const role = [
      ['.topbar-left', 'top group'], ['#files-toggle', 'files button'], ['#composer', 'composer'],
      ['#composer-add-menu', 'attachment menu'], ['#jump-latest', 'jump button'],
      ['dialog:not(.editor-dialog, .image-dialog)', 'dialog'],
    ].find(([selector]) => node.matches(selector))?.[1];
    return ['', '::before', '::after', ...(node.matches('dialog') ? ['::backdrop'] : [])].flatMap(pseudo => {
      const style = getComputedStyle(node, pseudo || null);
      return style.backdropFilter === 'none' ? [] : [{role: pseudo ? null : role, node: (node.id || node.className || node.tagName) + pseudo, filter: style.backdropFilter}];
    });
  }));
  assert.deepEqual(active.filter(item => !item.role || item.filter !== expected), [], `Only approved floating controls may use ${expected}`);
  for (const role of required) assert.ok(active.some(item => item.role === role), `Missing ${expected} on ${role}`);
}

async function composerLayout(page) {
  const layout = await page.evaluate(() => {
    const box = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
    const form = document.querySelector('#composer');
    const style = getComputedStyle(form);
    const scroller = document.querySelector('#chat-scroll');
    return {
      outer: ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius'].map(property => style[property]),
      padding: style.padding, form: box('#composer'), wrap: box('.composer-wrap'), scroll: box('#chat-scroll'),
      bar: box('.topbar'), last: box('[data-id="reply-23"]'), prompt: box('#prompt'),
      appHeight: getComputedStyle(document.documentElement).getPropertyValue('--app-height'),
      inset: getComputedStyle(document.documentElement).getPropertyValue('--glass-composer-height'), wrapHeight: form.parentElement.offsetHeight,
      scrollTop: scroller.scrollTop, remaining: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
      width: innerWidth, documentWidth: document.documentElement.scrollWidth, background: getComputedStyle(document.body, '::after').content,
      controls: ['#add-attachment', '#composer-options', '#send'].map(selector => {
        const control = document.querySelector(selector);
        return {selector, radius: getComputedStyle(control).borderBottomLeftRadius, box: box(selector)};
      }),
    };
  });
  return layout;
}

function checkTail(layout, height) {
  assert.ok(layout.remaining <= 2 && layout.last.top >= layout.bar.bottom - 1 && layout.last.bottom <= layout.wrap.top + 1,
    `Latest reply at ${height}px: reply=${layout.last.top.toFixed(1)}..${layout.last.bottom.toFixed(1)}, composer starts at ${layout.wrap.top.toFixed(1)}, ${layout.remaining}px remains unscrolled`);
}

async function checkComposer(page, height, keyboard) {
  const layout = await composerLayout(page);
  assert.deepEqual(layout.outer, Array(4).fill('28px'), 'Composer outer radius');
  assert.equal(layout.padding, '6px', 'Composer inset');
  for (const control of layout.controls) {
    const radius = control.radius.endsWith('%') ? parseFloat(control.radius) / 100 * control.box.height : parseFloat(control.radius);
    assert.equal(radius, 22, `${control.selector}: 28px - 6px must equal inner radius`);
    if (control.selector !== '#composer-options') assert.ok(control.box.height >= 44 && control.box.width >= 44, `${control.selector} touch target`);
    assert.ok(layout.prompt.bottom <= control.box.top + 1, `${control.selector} overlaps the prompt`);
  }
  assert.equal(layout.appHeight, `${height}px`, 'Viewport resize did not update app height');
  assert.equal(layout.inset, `${layout.wrapHeight}px`, 'Scroll inset must track the live composer height');
  assert.ok(layout.scroll.top <= layout.bar.bottom - 20 && layout.scroll.bottom >= layout.wrap.bottom - 1, 'Conversation should scroll behind both floating bars');
  assert.ok(layout.form.left >= 12 && layout.form.right <= layout.width - 12 && layout.documentWidth === layout.width, 'Composer needs safe side gutters without horizontal overflow');
  assert.ok(layout.form.bottom <= height + 1, 'Composer is below the available viewport');
  checkTail(layout, height);
  assert.equal(layout.background === 'none', keyboard, 'System bottom edge must disappear while the keyboard is present');
}

const screenshot = async page => PNG.sync.read(await page.screenshot({animations: 'disabled', scale: 'css'}));
const pixel = (image, column, row) => image.data.subarray((row * image.width + column) * 4, (row * image.width + column) * 4 + 3);
const pixelDifference = (first, second) => Math.max(...first.map((value, channel) => Math.abs(value - second[channel])));

async function withRule(page, rule, action) {
  const index = await page.evaluate(value => {
    const sheet = document.querySelector('link[href="liquid-glass.css"]').sheet;
    return sheet.insertRule(value, sheet.cssRules.length);
  }, rule);
  try { return await action(); }
  finally { await page.evaluate(value => document.querySelector('link[href="liquid-glass.css"]').sheet.deleteRule(value), index); }
}

async function checkSystemEdges(page, scheme) {
  const expected = systemColors[scheme === 'dark' ? 1 : 2].match(/../g).map(value => parseInt(value, 16));
  const shapes = await page.locator('.topbar-left, #files-toggle').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().toJSON()));
  const full = await screenshot(page);
  for (const row of [0, full.height - 1]) {
    let largest = 0;
    for (let column = 8; column < full.width - 8; column++) largest = Math.max(largest, pixelDifference(pixel(full, column, row), expected));
    assert.ok(largest <= 1, `System edge at row ${row} differs from native by ${largest} RGB levels`);
  }
  const noFade = await withRule(page, 'html[data-liquid-glass] body::before { content: none !important; }', () => screenshot(page));
  const noRim = await withRule(page, 'html[data-liquid-glass] :is(.topbar-left, #files-toggle) { box-shadow: none !important; }', () => screenshot(page));
  for (const {left, top, width} of shapes) {
    let fadeDifference = 0, rimDifference = 0;
    for (let row = Math.floor(top); row < Math.floor(top) + 3; row++) {
      for (let column = Math.ceil(left + width * .4); column < left + width * .6; column++) {
        const original = pixel(full, column, row);
        fadeDifference = Math.max(fadeDifference, pixelDifference(original, pixel(noFade, column, row)));
        rimDifference = Math.max(rimDifference, pixelDifference(original, pixel(noRim, column, row)));
      }
    }
    assert.ok(fadeDifference <= 1, `System fade paints over the top rim at x=${left}: ${fadeDifference}`);
    assert.ok(rimDifference >= 2, `Top rim is not painted at x=${left}: ${rimDifference}`);
  }
}

function luminance(color) {
  return [0.2126, 0.7152, 0.0722].reduce((total, weight, channel) => {
    const srgb = color[channel] / 255;
    return total + weight * (srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4);
  }, 0);
}

async function checkContrast(page, surfaces) {
  const samples = await page.evaluate(targets => targets.map(({selector, kind, name}) => {
    const node = document.querySelector(selector);
    if (!node) throw new Error(`Missing contrast target: ${selector}`);
    const style = getComputedStyle(node);
    const color = kind === 'icon' ? style.stroke : style.webkitTextFillColor;
    const range = new Range();
    range.selectNodeContents(node);
    const bounds = (kind ? [node.getBoundingClientRect()] : [...range.getClientRects()])
      .filter(rect => rect.width >= 3 && rect.height >= 3).map(rect => rect.toJSON());
    return {name: name || selector, color, opacity: Number(style.opacity), bounds, icon: kind === 'icon'};
  }), surfaces);
  const background = await withRule(page, `html[data-liquid-glass] :is(${surfaces.map(({selector}) => selector).join(', ')}) {
    -webkit-text-fill-color: transparent !important; text-shadow: none !important;
    stroke: transparent !important;
  }`, () => screenshot(page));
  return samples.map(({name, color, opacity, bounds, icon}) => {
    assert.match(color, /^rgba?\(/, `${name} must have a computed RGB foreground`);
    const [red, green, blue, alpha = 1] = color.match(/[\d.]+/g).map(Number);
    const coverage = alpha * opacity;
    let minimum = Infinity;
    for (const box of bounds) {
      const inset = icon ? 5 : 1;
      assert.ok(box.top >= -1 && box.bottom <= background.height + 1, `${name} must be visible for contrast sampling`);
      for (let row = Math.max(0, Math.ceil(box.top) + inset); row < Math.min(background.height, Math.floor(box.bottom) - inset); row++) {
        for (let column = Math.max(0, Math.ceil(box.left) + inset); column < Math.min(background.width, Math.floor(box.right) - inset); column++) {
          const rgb = pixel(background, column, row);
          const back = luminance(rgb);
          const front = luminance([red, green, blue].map((value, channel) => value * coverage + rgb[channel] * (1 - coverage)));
          minimum = Math.min(minimum, (Math.max(back, front) + 0.05) / (Math.min(back, front) + 0.05));
        }
      }
    }
    const threshold = icon ? 3 : 4.5;
    assert.ok(Number.isFinite(minimum) && minimum >= threshold, `${name}: ${minimum.toFixed(2)}:1, expected at least ${threshold}:1`);
    return `${name} ${minimum.toFixed(2)}:1`;
  });
}

async function scrollLatest(page) {
  await page.locator('#chat-scroll').evaluate(node => { node.scrollTop = node.scrollHeight; });
  await settle(page);
}

async function resizeWithKeyboard(page, width, height, keyboardHeight, inspect) {
  await page.locator('#prompt').focus();
  await page.setViewportSize({width, height: keyboardHeight});
  await page.evaluate(() => window.mobileCodexEvent('viewport', {keyboardVisible: true}));
  await settle(page);
  try { await inspect(); }
  finally {
    await page.setViewportSize({width, height});
    await page.evaluate(() => window.mobileCodexEvent('viewport', {keyboardVisible: false}));
    await page.locator('#prompt').blur();
    await settle(page);
  }
}

async function checkColorChoices(page, scheme) {
  const other = scheme === 'light' ? 'dark' : 'light';
  for (const choice of [other, 'system']) {
    const radio = page.locator(`#theme-choices input[value="${choice}"]`);
    await page.locator(`#theme-choices label:has(input[value="${choice}"]) span`).click();
    assert.equal(await radio.isChecked(), true);
    assert.equal(await page.locator('#theme').inputValue(), choice);
    assert.equal(await page.locator('html').getAttribute('data-theme'), choice === 'system' ? scheme : choice);
    assert.equal(await page.evaluate(() => localStorage.getItem('theme')), choice);
    assert.equal(await page.locator('html').getAttribute('data-liquid-glass'), '');
  }
}

async function check(browser, [width, height, keyboardHeight], scheme) {
  const options = {viewport: {width, height}, colorScheme: scheme, deviceScaleFactor: 1};
  const page = await browser.newPage(options);
  page.setDefaultTimeout(5000);
  const errors = [];
  const expectedFilter = scheme === 'dark' ? 'blur(24px) saturate(1.6)' : 'blur(22px) saturate(1.9)';
  const required = ['top group', 'files button', 'composer', 'attachment menu', 'jump button', 'dialog'];
  const classicSelectors = `${topControls}, .conversation, #chat-scroll, .composer-wrap, #composer, #prompt, #send, #add-attachment`;
  page.on('pageerror', error => errors.push(error.message));
  let baseline;
  try {
    await installFixture(page);
    assert.equal(await page.locator('html').getAttribute('data-theme'), scheme);
    assert.equal(await page.locator('html').getAttribute('data-liquid-glass'), null);
    await readingAnchor(page, true);
    await settle(page);
    const originalAnchor = await readingAnchor(page);
    assert.equal(originalAnchor.id, 'reply-9', 'Fixture must pause following at an earlier reply');
    const originalLayout = await captureLayout(page, classicSelectors);
    const conversationSamples = '.message.user, .user-bubble, .assistant-prose, .code-card, .code-head, .code-copy-btn';
    const originalStyles = await captureLayout(page, conversationSamples);
    await page.evaluate(() => {
      const nodes = [...document.querySelector('#messages').querySelectorAll('*')];
      window.originalConversation = {nodes, draft: document.querySelector('#prompt')};
    });
    await checkFilters(page);

    baseline = await browser.newPage(options);
    baseline.setDefaultTimeout(5000);
    await installFixture(baseline, baselineCss);
    assert.deepEqual(await captureLayout(baseline, classicSelectors), originalLayout, `${baselineRef}: classic differs with only the Liquid Glass stylesheet replaced`);
    await openSettings(baseline);
    await selectInterface(baseline, 'glass');
    await closeSettings(baseline);
    const baselineTop = (await captureLayout(baseline, topControls)).map(({box}) => box);

    await openSettings(page);
    assert.equal(await page.locator('#appearance-classic').isChecked(), true);
    await selectInterface(page, 'glass');
    await checkFilters(page, expectedFilter, required);
    if (width === 393 && height === 852) {
      await checkColorChoices(page, scheme);
      console.log(`  ${scheme} settings: ${(await checkContrast(page, [
        {selector: '#appearance-title'}, {selector: 'label:has(#appearance-classic) span'}, {selector: 'label:has(#appearance-glass) span'},
        {selector: '#theme-choices label:has(input[value="system"]) span', name: 'selected color mode'},
        {selector: '#theme-choices label:has(input[value="light"]) span', name: 'unselected color mode'},
      ])).join(', ')}`);
    }
    await closeSettings(page);
    assertAnchor(await readingAnchor(page), originalAnchor, 'Classic → Glass');
    assert.deepEqual((await captureLayout(page, topControls)).map(({box}) => box), baselineTop, `Top bar geometry changed from ${baselineRef}`);
    assert.equal(await page.locator('#prompt').inputValue(), draft);
    await openSettings(page);
    await selectInterface(page, 'classic');
    await closeSettings(page);
    const returnedAnchor = await readingAnchor(page);
    assertAnchor(returnedAnchor, originalAnchor, 'Glass → Classic');
    assert.ok(Math.abs(returnedAnchor.scrollTop - originalAnchor.scrollTop) <= 2, 'Classic scroll position changed after roundtrip');
    assert.deepEqual(await captureLayout(page, classicSelectors), originalLayout, 'Classic CSS or geometry changed after roundtrip');
    const after = await page.evaluate(() => {
      const {nodes, draft} = window.originalConversation;
      const current = [...document.querySelector('#messages').querySelectorAll('*')];
      return {sameNodes: nodes.length === current.length && nodes.every((node, index) => node === current[index]),
        sameDraftNode: draft === document.querySelector('#prompt'), value: draft.value};
    });
    assert.deepEqual(after, {sameNodes: true, sameDraftNode: true, value: draft}, 'Roundtrip must preserve conversation and draft DOM');
    assert.deepEqual((await captureLayout(page, conversationSamples)).map(({style}) => style), originalStyles.map(({style}) => style), 'Classic message styles changed after roundtrip');
    await checkFilters(page);

    await openSettings(page);
    await selectInterface(page, 'glass');
    await closeSettings(page);
    await checkSystemEdges(page, scheme);
    await scrollLatest(page);
    await checkComposer(page, height, false);
    let keyboardError;
    if (keyboardHeight) {
      try {
        await resizeWithKeyboard(page, width, height, keyboardHeight, async () => {
          await checkComposer(page, keyboardHeight, true);
          assert.equal(await page.locator('#prompt').inputValue(), draft);
          assert.equal(await page.locator('#prompt:focus').count(), 1, 'Keyboard resize lost composer focus');
        });
        await checkComposer(page, height, false);
      } catch (error) {
        keyboardError = error;
        await readingAnchor(baseline, true);
        await settle(baseline);
        await scrollLatest(baseline);
        try {
          await resizeWithKeyboard(baseline, width, height, keyboardHeight, async () => checkTail(await composerLayout(baseline), keyboardHeight));
          console.error(`  ${baselineRef} stylesheet: keyboard tail check passed`);
        } catch (baselineError) {
          console.error(`  ${baselineRef} stylesheet: ${baselineError.message}`);
        }
      }
    }
    if (width === 393 && height === 852) {
      await page.locator('#chat-scroll').evaluate(node => { node.scrollTop = 0; });
      await settle(page);
      console.log(`  ${scheme} chat: ${(await checkContrast(page, [
        {selector: '#header-project-label'}, {selector: '#files-toggle span'}, {selector: '[data-id="user-0"] .user-message-text'},
        {selector: '[data-id="reply-0"] > p:first-of-type'}, {selector: '[data-id="reply-0"] .code-lang'},
        {selector: '[data-id="reply-0"] .code-card pre code'}, {selector: '#model-summary'}, {selector: '#send svg', kind: 'icon'},
      ])).join(', ')}`);
    }
    assert.deepEqual(errors, []);
    if (keyboardError) throw keyboardError;
  } finally { await Promise.all([page.close(), baseline?.close()]); }
}

async function main() {
  const browser = await chromium.launch({executablePath: process.env.MOBILE_CODEX_BROWSER_EXECUTABLE, args: ['--no-sandbox', '--disable-dev-shm-usage']});
  let failed = 0;
  try {
    for (const viewport of viewports) for (const scheme of ['light', 'dark']) {
      const label = `${viewport[0]}x${viewport[1]} ${scheme}`;
      try {
        await check(browser, viewport, scheme);
        console.log(`PASS ${label}`);
      } catch (error) {
        failed++;
        console.error(`FAIL ${label}\n${error.stack}`);
      }
    }
  } finally { await browser.close(); }
  if (failed) process.exitCode = 1;
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });
