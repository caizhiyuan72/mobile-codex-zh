/* Runtime metadata defines available levels; custom providers without metadata use standard requests. */
(() => {
  'use strict';
  const levels = Object.freeze(['low','medium','high','xhigh','max']);
  const labels = Object.freeze(Object.fromEntries(levels.map(level => [level, level])));
  const levelSet = new Set(levels);
  function id(model) { return String(model?.model || model?.id || ''); }
  function metadata(model) {
    return [model?.supportedReasoningEfforts, model?.supported_reasoning_efforts,
      model?.reasoning?.supportedEfforts, model?.reasoning?.supported_efforts].filter(Array.isArray);
  }
  function efforts(model) {
    const result = new Set();
    for (const raw of metadata(model)) for (const item of raw) {
      const candidate = typeof item === 'string' ? item :
        (item?.reasoningEffort ?? item?.reasoning_effort ?? item?.effort ?? item?.id);
      const value = typeof candidate === 'string' ? candidate.toLowerCase() : '';
      if (levelSet.has(value)) result.add(value);
    }
    return levels.filter(level => result.has(level));
  }
  function known() { return []; }
  function supported(model, thirdParty = false) {
    const reported = efforts(model);
    return thirdParty && id(model) && !metadata(model).some(items => items.length)
      ? ['low','medium','high'] : reported;
  }
  function offered() { return levels.slice(); }
  function source(model, effort, thirdParty = false) {
    if (efforts(model).includes(effort)) return '运行时上报';
    return thirdParty ? '标准请求' : '未报告支持';
  }
  function canSelect(effort, model, thirdParty = false) {
    const available = supported(model, thirdParty);
    return effort ? !!id(model) && available.includes(effort) : available.length === 0;
  }
  function choose({previous = '', fallback = '', model = null, thirdParty = false}) {
    const available = supported(model, thirdParty);
    return [previous, fallback, 'medium', ...available].find(value => available.includes(value)) || '';
  }
  const api = Object.freeze({levels, labels, id, efforts, known, supported, offered, source,
    canSelect, choose, validSelection:canSelect});
  if (typeof window !== 'undefined') window.MobileCodexReasoning = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
