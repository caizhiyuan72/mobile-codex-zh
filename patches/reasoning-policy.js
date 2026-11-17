/* Codex CN V5: visible full effort inventory + model-specific availability.
   Availability is distinct from actual server acceptance; never silently downgrade. */
(() => {
  'use strict';
  const levels = Object.freeze(['none','minimal','low','medium','high','xhigh','max']);
  const labels = Object.freeze({none:'关闭',minimal:'极低',low:'低',medium:'中',high:'高',xhigh:'超高',max:'最大'});
  const levelSet = new Set(levels);
  const KNOWN_MODELS = Object.freeze([
    [/^gpt-6-astra(?:$|-)/i, ['low','medium','high','xhigh','max']],
    [/^gpt-6\.1-sol(?:$|-)/i, ['low','medium','high','xhigh','max']],
    [/^gpt-6\.1-terra(?:$|-)/i, ['none','low','medium','high','xhigh','max']],
    [/^gpt-6-sol(?:$|-)/i, ['none','low','medium','high','xhigh','max']],
    [/^gpt-6-luna(?:$|-)/i, ['none','low','medium','high','xhigh','max']]
  ]);
  function id(model) { return String(model?.model || model?.id || ''); }
  function efforts(model) {
    const inputs = [model?.supportedReasoningEfforts,model?.supported_reasoning_efforts,
      model?.reasoning?.supportedEfforts,model?.reasoning?.supported_efforts];
    const result = new Set();
    for (const raw of inputs) if (Array.isArray(raw)) for (const item of raw) {
      const candidate = typeof item === 'string' ? item :
        (item?.reasoningEffort ?? item?.reasoning_effort ?? item?.effort ?? item?.id);
      const value = typeof candidate === 'string' ? candidate.toLowerCase() : '';
      if (levelSet.has(value)) result.add(value);
    }
    return levels.filter(x => result.has(x));
  }
  function known(model) {
    const name=id(model); const entry=KNOWN_MODELS.find(([pattern])=>pattern.test(name));
    return entry ? entry[1].slice() : [];
  }
  function supported(model,thirdParty=false) {
    if (thirdParty) return efforts(model);  // Third party ids cannot be treated as authoritative OpenAI capabilities.
    const set=new Set([...known(model),...efforts(model)]);
    return levels.filter(x=>set.has(x));
  }
  function offered() { return levels.slice(); }
  function source(model,effort,thirdParty=false) {
    if (thirdParty) return '试验：第三方接口尚未验证';
    if (known(model).includes(effort)) return '文档确认';
    if (efforts(model).includes(effort)) return '运行时上报';
    return '未报告支持';
  }
  function canSelect(effort,model,thirdParty=false,experimental=false) {
    if (!effort) return true;
    if (!levelSet.has(effort) || !id(model)) return false;
    return !!thirdParty || supported(model,false).includes(effort) || !!experimental;
  }
  function choose({previous='',fallback='',model=null,thirdParty=false,experimental=false}) {
    if (canSelect(previous,model,thirdParty,experimental)) return previous;
    if (canSelect(fallback,model,thirdParty,experimental)) return fallback;
    if (canSelect('medium',model,thirdParty,experimental)) return 'medium';
    return supported(model,thirdParty).find(x=>canSelect(x,model,thirdParty,experimental)) || '';
  }
  function validSelection(effort,model,thirdParty=false,experimental=false) {
    return canSelect(effort,model,thirdParty,experimental);
  }
  function explain({modelId='',effort='',apiActive=false,reported=[],supportedLevels=[],experimental=false}) {
    const name=modelId || '未选择模型';
    const chosen=effort?(labels[effort]||effort)+' ('+effort+')':'自动（不指定 effort）';
    const caveat = apiActive ? '第三方 API 的档位均属于试验，服务商可能拒绝。' :
      '灰色档位未报告支持；开启试验选项后可手动请求，但可能失败。';
    const claim=effort && !apiActive ? (supportedLevels.includes(effort) ? '支持来源：'+source({model:modelId},effort,false)+'。' : '该档位未验证，可能被拒绝。') : '';
    return name+' · 当前：'+chosen+'\n'+claim+caveat+'\n不会用提示词模拟，也不会偷偷降级。';
  }
  const api=Object.freeze({levels,labels,id,efforts,known,supported,offered,source,canSelect,choose,validSelection,explain});
  if (typeof window!=='undefined') window.MobileCodexReasoning=api;
  if (typeof module!=='undefined' && module.exports) module.exports=api;
})();
