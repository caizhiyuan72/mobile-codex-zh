const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {JSDOM} = require('jsdom');
const root = 'app/src/main/assets/web/';

test('saved glass and Android system colors are available before deferred scripts', () => {
  const dom = new JSDOM(readFileSync(root + 'index.html', 'utf8'), {
    url: 'https://appassets.androidplatform.net/index.html', runScripts: 'outside-only'
  });
  try {
    const {window} = dom;
    const {document} = window;
    const bootstrap = document.querySelector('head script');
    assert.equal(bootstrap.getAttribute('src'), 'appearance.js');
    assert.equal(bootstrap.hasAttribute('defer') || bootstrap.hasAttribute('async'), false);
    window.matchMedia = () => ({matches: false});
    window.Native = {systemUsesDarkTheme: () => true};
    window.localStorage.setItem('interfaceStyle', 'glass');
    window.eval(readFileSync(root + 'appearance.js', 'utf8'));
    assert.equal(document.documentElement.dataset.theme, 'dark');
    assert.equal(document.documentElement.hasAttribute('data-liquid-glass'), true);

    window.localStorage.setItem('theme', 'light');
    window.eval(readFileSync(root + 'appearance.js', 'utf8'));
    assert.equal(document.documentElement.dataset.theme, 'light');
    assert.equal(window.MobileCodexAppearance.choice, 'light');
  } finally {
    dom.window.close();
  }
});
