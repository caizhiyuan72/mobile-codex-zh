/* Only labels captured from the packaged HTML and explicit t() calls are translated. */
(() => {
  'use strict';
  const english = window.MobileCodexEnglish || {}, chinese = window.MobileCodexChinese || {};
  const catalog = {...english, ...chinese};
  let native = {};
  try { native = JSON.parse(window.Native?.locale?.() || '{}'); } catch {}
  const languageChoices = ['system', 'en', 'zh-CN'];
  let choice = native.choice || localStorage.getItem('language') || 'system';
  if (!languageChoices.includes(choice)) choice = 'zh-CN';
  if (native.brandName) document.documentElement.classList.add('portrait-brand');
  const deviceLanguage = native.systemLanguage || navigator.language || 'en';
  // The engine attribution names the upstream software, irrespective of the app brand.
  const engineCredit = 'Android용 Codex 포트 0.162.1-termux.1 · Apache-2.0';
  const brandToken = /\b(?:Mobile Codex|Codex CN|Codex)\b/g;
  function brand(label) {
    if (!native.brandName || !label.includes('Codex')) return label;
    // Drop the spaces used around the original Latin name in Chinese labels.
    return label.replace(/([\u3400-\u9fff]) (?=(?:Mobile )?Codex\b)/g, '$1')
      .replace(/\b((?:Mobile )?Codex(?: CN)?) (?=[\u3400-\u9fff])/g, '$1')
      .replace(brandToken, () => native.brandName);
  }
  const language = () => {
    const code = (choice === 'system' ? deviceLanguage : choice).toLowerCase();
    return code.startsWith('en') ? 'en' : 'zh-CN';
  };
  const t = (key, args = {}) => {
    const value = (language() === 'zh-CN' ? chinese[key] : english[key]) ?? key;
    // Apply the brand to packaged copy before interpolating user/project data.
    const label = key !== engineCredit && Object.hasOwn(catalog, key) ? brand(value) : value;
    return label.replace(/\{([a-zA-Z]+)\}/g, (token, name) => Object.hasOwn(args, name) ? String(args[name]) : token);
  };
  const bindings = [];
  function staticLabel(key) { return Object.hasOwn(catalog, key) ? t(key) : brand(key); }
  const walk = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT);
  while (walk.nextNode()) {
    const node = walk.currentNode, raw = node.textContent, key = raw.trim();
    if (!Object.hasOwn(catalog, key) && brand(key) === key) continue;
    bindings.push({node, key, raw, last:raw});
  }
  for (const node of document.querySelectorAll('*')) {
    for (const attribute of ['aria-label', 'title', 'placeholder', 'data-prompt', 'alt']) {
      const key = node.getAttribute(attribute);
      if (key && (Object.hasOwn(catalog, key) || brand(key) !== key)) bindings.push({node, key, attribute, last:key});
    }
  }
  function apply() {
    document.documentElement.lang = language();
    for (const b of bindings) {
      if (!b.node.isConnected) continue;
      const current = b.attribute ? b.node.getAttribute(b.attribute) : b.node.textContent;
      // A dynamic label has taken ownership. Never overwrite its data with static text.
      if (current !== b.last) continue;
      const value = b.attribute ? staticLabel(b.key) : b.raw.replace(b.key, () => staticLabel(b.key));
      if (b.attribute) b.node.setAttribute(b.attribute, value); else b.node.textContent = value;
      b.last = value;
    }
  }
  window.MobileCodexLocale = {t, brand, language, choice:() => choice, apply,
    set(value) { choice = languageChoices.includes(value) ? value : 'zh-CN'; localStorage.setItem('language', choice); apply(); }};
  apply();
})();
