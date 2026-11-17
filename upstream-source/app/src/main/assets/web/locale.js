/* Only labels captured from the packaged HTML and explicit t() calls are translated. */
(() => {
  'use strict';
  const english = window.MobileCodexEnglish || {}, chinese = window.MobileCodexChinese || {};
  const catalog = {...english, ...chinese};
  let native = {};
  try { native = JSON.parse(window.Native?.locale?.() || '{}'); } catch {}
  let choice = native.choice || localStorage.getItem('language') || 'system';
  const deviceLanguage = native.systemLanguage || navigator.language || 'en';
  const language = () => {
    const code = (choice === 'system' ? deviceLanguage : choice).toLowerCase();
    return code.startsWith('ko') ? 'ko' : code.startsWith('en') ? 'en' : 'zh-CN';
  };
  const t = (key, args = {}) => {
    const value = language() === 'ko' ? key : ((language() === 'zh-CN' ? chinese[key] : english[key]) ?? key);
    return value.replace(/\{([a-zA-Z]+)\}/g, (token, name) => Object.hasOwn(args, name) ? String(args[name]) : token);
  };
  const bindings = [];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walk.nextNode()) {
    const node = walk.currentNode, raw = node.textContent, key = raw.trim();
    if (!catalog[key]) continue;
    bindings.push({node, key, raw, last:raw});
  }
  for (const node of document.querySelectorAll('*')) {
    for (const attribute of ['aria-label', 'title', 'placeholder', 'data-prompt']) {
      const key = node.getAttribute(attribute);
      if (catalog[key]) bindings.push({node, key, attribute, last:key});
    }
  }
  function apply() {
    document.documentElement.lang = language();
    for (const b of bindings) {
      if (!b.node.isConnected) continue;
      const current = b.attribute ? b.node.getAttribute(b.attribute) : b.node.textContent;
      // A dynamic label has taken ownership. Never overwrite its data with static text.
      if (current !== b.last) continue;
      const value = b.attribute ? t(b.key) : b.raw.replace(b.key, t(b.key));
      if (b.attribute) b.node.setAttribute(b.attribute, value); else b.node.textContent = value;
      b.last = value;
    }
  }
  window.MobileCodexLocale = {t, language, choice:() => choice, apply,
    set(value) { choice = ['system','en','ko','zh-CN'].includes(value) ? value : 'system'; localStorage.setItem('language', choice); apply(); }};
  apply();
})();
