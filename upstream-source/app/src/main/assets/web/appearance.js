(() => {
  'use strict';
  const root = document.documentElement;
  const systemTheme = matchMedia('(prefers-color-scheme: dark)');
  function applyTheme(choice) {
    if (choice === 'system') {
      const dark = window.Native?.systemUsesDarkTheme?.() ?? systemTheme.matches;
      root.dataset.theme = dark ? 'dark' : 'light';
    } else {
      root.dataset.theme = choice;
    }
  }

  let choice = 'system';
  try {
    const saved = localStorage.getItem('theme');
    if (saved === 'light' || saved === 'dark') choice = saved;
    root.toggleAttribute('data-liquid-glass', localStorage.getItem('interfaceStyle') === 'glass');
  } catch {}
  applyTheme(choice);
  window.MobileCodexAppearance = { choice, applyTheme, systemTheme };
})();
