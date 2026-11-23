(() => {
  'use strict';
  const english = window.MobileCodexEnglish || {}, chinese = window.MobileCodexChinese || {};
  const packaged = key => Object.hasOwn(english, key) || Object.hasOwn(chinese, key);
  let native = {};
  try { native = JSON.parse(window.Native?.locale?.() || '{}'); } catch {}
  const languageChoices = ['system', 'en', 'zh-CN'];
  let choice = native.choice || localStorage.getItem('language') || 'zh-CN';
  if (!languageChoices.includes(choice)) choice = 'zh-CN';
  if (native.brandName) document.documentElement.classList.add('portrait-brand');
  const deviceLanguage = native.systemLanguage || navigator.language || 'zh-CN';
  const engineCredit = 'Android Codex 移植版 ';
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
    return /^en(?:[-_]|$)/.test(code) ? 'en' : 'zh-CN';
  };
  const t = (key, args = {}) => {
    const messages = language() === 'zh-CN' ? chinese : english;
    const value = Object.hasOwn(messages, key) ? messages[key] : key;
    // Apply the brand to packaged copy before interpolating user/project data.
    const label = packaged(key) && !key.startsWith(engineCredit) ? brand(value) : value;
    return label.replace(/\{([a-zA-Z]+)\}/g, (token, name) => Object.hasOwn(args, name) ? String(args[name]) : token);
  };
  const bindings = [];
  function staticLabel(key) { return packaged(key) ? t(key) : brand(key); }
  function bind(root) {
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walk.nextNode()) {
      const node = walk.currentNode, raw = node.textContent, key = raw.trim();
      if (packaged(key) || brand(key) !== key) bindings.push({node, key, raw, last:raw});
    }
    for (const node of [root, ...root.querySelectorAll('[aria-label], [aria-description], [title], [placeholder], [data-prompt], [alt]')]) {
      for (const attribute of ['aria-label', 'aria-description', 'title', 'placeholder', 'data-prompt', 'alt']) {
        const key = node.getAttribute(attribute);
        if (key && (packaged(key) || brand(key) !== key)) bindings.push({node, key, attribute, last:key});
      }
    }
    apply();
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
  window.MobileCodexLocale = {t, brand, language, choice:() => choice, apply, bind,
    set(value) {
      choice = languageChoices.includes(value) ? value : 'zh-CN';
      localStorage.setItem('language', choice);
      apply();
      document.dispatchEvent(new Event('mobilecodex:languagechange'));
    }};
  bind(document.documentElement);
})();
