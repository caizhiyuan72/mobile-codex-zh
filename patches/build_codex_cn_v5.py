"""Safely patch Codex CN V4 WebView interface without altering user data, package,
Android signing identity, native runtime, or existing provider credentials.
Known model effort levels are derived from published API documentation;
experimental entries can still be rejected by the actual provider/runtime.
"""
from pathlib import Path
from zipfile import ZipFile, ZIP_STORED, ZIP_DEFLATED
import hashlib, struct, zlib
from cryptography.hazmat.primitives import serialization
from rename_codex_cn import read_zip_layout, cd_records, copy_region, content_digest, verify_v2
from fix_codex_cn_alignment import source_cert, signing_block

ROOT=Path('/mnt/data')
INPUT=ROOT/'Codex-CN-V4-arm64.apk'
OUTPUT=ROOT/'Codex-CN-V5-arm64.apk'
TEMP=ROOT/'codex-cn-v5-unsigned.tmp'
KEY=ROOT/'codex-cn-signing-key-private.pem'
WORK=ROOT/'codex_v5work'
WORK.mkdir(exist_ok=True)

POLICY=r'''/* Codex CN V5: visible full effort inventory + model-specific availability.
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
'''

MULTIAGENT=r'''/* Codex CN V5: native Codex subagents, not Claude/Gemini invited speakers.
   Only config.read/config.save/runtime.start touch the local Codex config TOML. */
  function cnSectionEntries(content,section) {
    const lines=String(content||'').replace(/\r\n/g,'\n').split('\n');
    let inside=false;const obj={};
    for (const line of lines) {
      const hdr=line.match(/^\s*\[([^\]\n]+)\]\s*(?:#.*)?$/);
      if (hdr) {inside=hdr[1].trim()===section;continue;}
      if (!inside)continue;
      const m=line.match(/^\s*([A-Za-z_][A-Za-z_0-9]*)\s*=\s*([^#\n]*?)(?:\s+#.*)?$/);
      if (m)obj[m[1]]=m[2].trim();
    }
    return obj;
  }
  function cnSetTomlSection(content,section,entries) {
    const lines=String(content||'').replace(/\r\n/g,'\n').split('\n');
    const table=/^\s*\[\[?([^\]\n]+)\]\]?\s*(?:#.*)?$/;
    let start=-1,end=lines.length;
    for(let i=0;i<lines.length;i++){
      const m=lines[i].match(table);
      if(m && start>=0){end=i;break;}
      if(m && m[1].trim()===section && start<0)start=i;
    }
    if(start<0){
      let out=lines.join('\n').replace(/\s*$/,'');
      out+='\n\n['+section+']\n'+Object.entries(entries).map(([key,value])=>key+' = '+value).join('\n')+'\n';
      return out;
    }
    for(const [key,value] of Object.entries(entries)){
      const re=new RegExp('^\\s*'+key+'\\s*=');
      const hits=[];
      for(let i=start+1;i<end;i++)if(re.test(lines[i]))hits.push(i);
      if(hits.length>1)throw new Error('已有重复配置键：['+section+'] '+key+'。请先在配置编辑器处理。');
      if(hits.length)lines[hits[0]]=key+' = '+value;
      else {lines.splice(end,0,key+' = '+value);end++;}
    }
    return lines.join('\n');
  }
  let subagentBusy=false;
  function cnReadAgentPrefs(content) {
    const feats=cnSectionEntries(content,'features'),agents=cnSectionEntries(content,'agents');
    const active=feats.multi_agent==='true'||feats.multi_agent_v2==='true';
    const n=Number(agents.max_concurrent_threads_per_session||agents.max_threads||3);
    return {active:active&&agents.enabled!=='false',limit:[1,2,3,4].includes(n)?n:3};
  }
  async function cnLoadSubagents() {
    const el=$('subagents-status');
    el.textContent='正在读取 Codex 本地配置…';
    try{
      const cfg=await call('config.read');
      const prefs=cnReadAgentPrefs(cfg?.content||'');
      $('subagents-enabled').checked=prefs.active;
      $('subagents-limit').value=String(prefs.limit);
      el.textContent=prefs.active?'配置中已启用多智能体；能否成功派遣仍需实际测试。':'当前未在配置中启用多智能体。';
    }catch(error){el.textContent='读取失败：'+errorText(error);}
  }
  async function cnSaveSubagents() {
    if(subagentBusy)return;
    subagentBusy=true;
    const save=$('subagents-save'),status=$('subagents-status');
    save.disabled=true;status.textContent='正在保存本地配置…';
    try{
      const read=await call('config.read');
      if(typeof read?.content!=='string')throw new Error('未能读取完整 config.toml，已中止保存。');
      const enabled=$('subagents-enabled').checked;
      const limit=Number($('subagents-limit').value);
      if(![1,2,3,4].includes(limit))throw new Error('并行数无效');
      let content=cnSetTomlSection(read.content,'features',{multi_agent:String(enabled)});
      if(!enabled)content=cnSetTomlSection(content,'features',{multi_agent_v2:'false'});
      content=cnSetTomlSection(content,'agents',{enabled:String(enabled),max_concurrent_threads_per_session:String(limit)});
      if(content===read.content){status.textContent='设置没有变化；仍需实际发送任务验证。';return;}
      await call('config.save',{content});
      status.textContent='配置已保存，正在重新连接 Codex…';
      await call('runtime.start');
      const check=await call('config.read');
      const actual=cnReadAgentPrefs(check?.content||'');
      if(actual.active!==enabled||actual.limit!==limit)throw new Error('保存后复查结果不一致');
      status.textContent=enabled?'已启用多智能体配置（最多 '+limit+' 个）。请使用测试任务验证 spawn_agent 是否可调用。':'已停用多智能体配置。';
    }catch(error){status.textContent='未确认启用成功：'+errorText(error)+ '。可在「Codex 设置编辑」中检查。';}
    finally{subagentBusy=false;save.disabled=false;}
  }
  on('subagents-refresh',cnLoadSubagents);
  on('subagents-save',cnSaveSubagents);
  on('subagents-test',()=>{
    const task='请使用 Codex 原生 spawn_agent 派遣两个子智能体：一个检查当前项目的代码结构，一个只读检查潜在问题。等待它们完成并汇总结果。请报告是否真正调用了 spawn_agent；如果不可用，明确说明，不要假装创建了子智能体。';
    $('prompt').value=task;saveDraft();sizeComposer();close('settings-dialog');$('prompt').focus();
    toast('测试提示词已填入，确认后手动点击发送。');
  });
'''

with ZipFile(INPUT) as archive:
    app=archive.read('assets/web/app.js').decode('utf8')
    index=archive.read('assets/web/index.html').decode('utf8')
    provider=archive.read('assets/web/api-providers.js').decode('utf8')
    css=archive.read('assets/web/app.css').decode('utf8')
    manifest=bytearray(archive.read('AndroidManifest.xml'))
    orig_info={x.filename:x for x in archive.infolist()}

# replace previously embedded policy
anchor='/* Packaged UI only. Native.postMessage is the sole transport; no remote scripts. */'
assert anchor in app and app.count(anchor)==1
app='/* V5 embedded full reasoning capability policy */\n'+POLICY+'\n'+anchor+app.split(anchor,1)[1]

old="""    const offeredLevels = policy.offered(selected, thirdParty);"""
new="""    const offeredLevels = policy.offered();
    const supportedLevels = policy.supported(selected,thirdParty);
    const experimental = $('effort-experimental').checked;"""
assert app.count(old)==1
app=app.replace(old,new)

old="""    $('effort-heading').textContent = $('effort').value ? $('effort').selectedOptions[0].textContent :
      (thirdParty ? '自动 · 服务商默认' : t('추론 강도 조절 미지원'));"""
new="""    $('effort-heading').textContent = $('effort').value ? $('effort').selectedOptions[0].textContent : '自动 · 模型默认';"""
assert app.count(old)==1
app=app.replace(old,new)

old="""    $('reasoning-control').hidden = !offeredLevels.length && !thirdParty;
    $('effort-unavailable').hidden = !!offeredLevels.length || thirdParty;
    // A clearly labeled button per level, instead of a disabled anonymous slider.
    const grid = $('effort-preset-grid');
    grid.replaceChildren();
    const choices = (thirdParty ? [{value:'', label:'自动'}] : []).concat(
      offeredLevels.map(value => ({value, label:policy.labels[value]})));
    for (const choice of choices) {
      const button = node('button', choice.label, 'effort-preset-button');
      button.type = 'button';
      button.dataset.effort = choice.value;
      button.setAttribute('aria-pressed', String($('effort').value === choice.value));
      button.setAttribute('aria-label', choice.label + (thirdParty && choice.value ? '，第三方 API 未验证' : ''));
      button.addEventListener('click', () => {
        $('effort').value = choice.value;
        $('effort').dispatchEvent(new Event('change', {bubbles:true}));
      });
      grid.append(button);
    }
    $('effort-contract').textContent = policy.explain({modelId:$('model').value,
      effort:$('effort').value, apiActive:thirdParty,
      reported:policy.efforts(selected), offeredLevels});
    const quick = $('api-effort-settings');
    const select = $('api-effort-choice');
    if (quick && select) {
      quick.hidden = !thirdParty;
      select.replaceChildren();
      for (const choice of choices) select.add(new Option(choice.label + (choice.value && !policy.efforts(selected).length ? '（试验）' : ''), choice.value));
      select.value = $('effort').value;
      $('api-effort-current').textContent = '当前聊天模型：' + ($('model').value || '未选择');
    }"""
new="""    $('reasoning-control').hidden = false;
    $('effort-unavailable').hidden = true;
    const grid = $('effort-preset-grid');
    grid.replaceChildren();
    const choices = [{value:'', label:'自动'}, ...offeredLevels.map(value=>({value,label:policy.labels[value]}))];
    for (const choice of choices) {
      const available = policy.canSelect(choice.value,selected,thirdParty,experimental);
      const button = node('button', choice.label, 'effort-preset-button');
      button.type='button';button.dataset.effort=choice.value;
      button.disabled=!available;
      const tag=choice.value ? policy.source(selected,choice.value,thirdParty) : '模型默认';
      button.title=choice.label+' · '+tag;
      button.classList.toggle('is-experimental', !!choice.value && (thirdParty || !supportedLevels.includes(choice.value)));
      button.setAttribute('aria-pressed',String($('effort').value===choice.value));
      button.setAttribute('aria-label',choice.label+' · '+tag+(available?'':'，暂不可选'));
      button.addEventListener('click',()=>{
        if(!policy.canSelect(choice.value,selected,thirdParty,$('effort-experimental').checked)){
          toast('该档位未获当前模型确认，可开启实验选项尝试。');return;
        }
        $('effort').value=choice.value;
        $('effort').dispatchEvent(new Event('change',{bubbles:true}));
      });
      grid.append(button);
    }
    const officialKnown=policy.known(selected);
    $('effort-availability').textContent=thirdParty ? '第三方服务商：全部档位均为手动试验，请以真实请求为准。' :
      (supportedLevels.length ? '可用：'+supportedLevels.map(x=>policy.labels[x]).join(' / ')+
        (officialKnown.length ? '（已结合官方模型文档补全）' : '（运行时上报）') : '该模型未报告思考档位；可开启实验模式尝试。');
    $('effort-contract').textContent=policy.explain({modelId:$('model').value,
      effort:$('effort').value,apiActive:thirdParty,
      reported:policy.efforts(selected),supportedLevels,experimental});
    const quick=$('api-effort-settings'),select=$('api-effort-choice');
    if(quick && select){
      quick.hidden=!thirdParty;
      select.replaceChildren();
      for(const choice of choices){
        const option=new Option(choice.label+(choice.value?'（试验）':''),choice.value);
        option.disabled=!policy.canSelect(choice.value,selected,thirdParty,experimental);
        select.add(option);
      }
      select.value=$('effort').value;
      $('api-effort-current').textContent='当前聊天模型：'+($('model').value||'未选择');
    }"""
assert app.count(old)==1
app=app.replace(old,new)

old="""    const supported = policy.offered(selected, thirdParty);
    $('effort').replaceChildren();
    // Third-party entries are manual/experimental if native model metadata is absent.
    if (thirdParty) $('effort').add(new Option('自动（不指定强度）', ''));
    for (const level of supported) $('effort').add(new Option(policy.labels[level], level));
    if (!supported.length && !thirdParty) $('effort').add(new Option(t('추론 설정 정보 없음'), ''));
    $('effort').disabled = !supported.length;
    $('effort').value = policy.choose({previous, fallback:selected?.defaultReasoningEffort,
      supported, thirdParty});"""
new="""    const supported = policy.offered();
    const experimental = $('effort-experimental').checked;
    $('effort').replaceChildren();
    $('effort').add(new Option('自动（模型默认）',''));
    for (const level of supported){
      const option=new Option(policy.labels[level],level);
      option.disabled=!policy.canSelect(level,selected,thirdParty,experimental);
      $('effort').add(option);
    }
    $('effort').disabled = false;
    $('effort').value = policy.choose({previous, fallback:selected?.defaultReasoningEffort,
      model:selected, thirdParty, experimental});"""
assert app.count(old)==1
app=app.replace(old,new)
old="""    if (!window.MobileCodexReasoning.validSelection($('effort').value, chosenModel, !!state.apiActive)) {"""
new="""    if (!window.MobileCodexReasoning.validSelection($('effort').value, chosenModel, !!state.apiActive, $('effort-experimental').checked)) {"""
assert app.count(old)==1
app=app.replace(old,new)

# Disable cached-only four-option UI and maintain experimental setting locally.
anchor="""  on('effort-slider', previewReasoning, 'input');"""
add="""  $('effort-experimental').checked = localStorage.getItem('codex-cn-effort-experimental') === 'yes';
  on('effort-experimental',()=>{
    try{localStorage.setItem('codex-cn-effort-experimental',$('effort-experimental').checked?'yes':'no');}catch{}
    efforts();syncReasoningPicker();saveOptions();
  },'change');
"""
assert app.count(anchor)==1
app=app.replace(anchor,add+anchor)

# Subagent functions must be declared inside the existing WebView closure after `on`
anchor="""  selectSettingsTab('general');"""
assert app.count(anchor)==1
app=app.replace(anchor,MULTIAGENT+'\n'+anchor)
anchor="""    if (selected === 'updates') loadUpdates();"""
assert app.count(anchor)==1
app=app.replace(anchor,anchor+"\n    if (selected === 'advanced') cnLoadSubagents();")

old="""          <small class="muted" style="display:block;margin-top:9px">点击档位即可选择，聊天发送时会传递该强度。第三方 API 未声明支持的档位属于试验项，可能被服务商拒绝。</small>"""
new="""          <small id="effort-availability" class="muted" style="display:block;margin-top:8px;line-height:1.45"></small>
          <label class="effort-experimental-label"><input id="effort-experimental" type="checkbox"> 允许试用未报告支持的思考档位</label>
          <small class="muted" style="display:block;margin-top:8px">全部 7 个档位固定显示；不支持的档位默认置灰。第三方 API 为手动试验，实际请求失败不会自动改成低强度。</small>"""
assert index.count(old)==1
index=index.replace(old,new)

old='''<section class="settings-section" data-settings-panel="advanced" hidden><h3>고급</h3><button id="edit-config" class="secondary-button">Codex 설정 편집</button><p class="muted">설정을 저장하면 실행 엔진을 다시 시작합니다.</p></section>'''
new='''<section class="settings-section" data-settings-panel="advanced" hidden>
  <h3>高级</h3>
  <section class="devtools-card cn-subagent-card" aria-labelledby="subagents-title">
    <strong id="subagents-title">原生 Codex 子智能体</strong>
    <p class="muted">让主智能体通过 spawn_agent 分派、并行处理和汇总任务。这与邀请 Claude/Gemini 参与群聊不同。</p>
    <div class="settings-row"><span><strong>启用多智能体</strong><small>写入本地 Codex 配置，保存后重新连接运行时。</small></span><label class="toggle-switch"><input id="subagents-enabled" type="checkbox" role="switch" aria-label="启用多智能体"><span class="toggle-track" aria-hidden="true"></span></label></div>
    <label for="subagents-limit">最多并行子智能体</label>
    <select id="subagents-limit" class="text-input" aria-label="最大并行子智能体数"><option value="1">1 个（稳妥）</option><option value="2">2 个</option><option value="3" selected>3 个（推荐）</option><option value="4">4 个（高资源占用）</option></select>
    <div class="cn-subagent-buttons"><button id="subagents-refresh" type="button" class="secondary-button">读取当前设置</button><button id="subagents-save" type="button" class="primary-button">保存并启用</button></div>
    <p id="subagents-status" class="muted" role="status" aria-live="polite">尚未读取配置。</p>
    <button id="subagents-test" type="button" class="secondary-button">填入子智能体测试任务</button>
    <p class="muted">注意：运行时、当前模型及 API 服务商必须支持工具调用。开启配置不代表已实测成功；并行任务会增加资源和用量。</p>
  </section>
  <button id="edit-config" class="secondary-button">Codex 设置编辑</button><p class="muted">修改配置可能触发运行时重启；不删除现有聊天或 API 服务商。</p>
</section>'''
assert index.count(old)==1
index=index.replace(old,new)
assert '<title>Codex CN</title>' in index
index=index.replace('Codex CN V4 ·','Codex CN V5 ·')
css+='''\n/* Codex CN V5: full effort list and subagent settings */
.effort-preset-grid{grid-template-columns:repeat(4,minmax(0,1fr))!important}
.effort-preset-button:disabled{opacity:.42;cursor:not-allowed;filter:grayscale(.45)}
.effort-preset-button.is-experimental:not(:disabled){border-style:dashed}
.effort-experimental-label{display:flex;gap:8px;align-items:center;margin-top:8px;font-size:12px;line-height:1.5}
.effort-experimental-label input{width:18px;height:18px;flex:0 0 auto}
.cn-subagent-card{display:flex;flex-direction:column;gap:9px;margin-bottom:12px}
.cn-subagent-card p{margin:0;line-height:1.5}
.cn-subagent-card .settings-row{margin:0}
.cn-subagent-buttons{display:flex;flex-wrap:wrap;gap:8px}
.cn-subagent-buttons button{flex:1 1 145px}
#subagents-limit{width:100%;min-height:44px}
@media(max-width:370px){.effort-preset-grid{grid-template-columns:repeat(3,minmax(0,1fr))!important}}
'''

# In-place Android update: versionCode 75->76, same package & cert
assert manifest[:4]==b'\x03\x00\x08\x00'
o=8; num_versions=0
while o+8<=len(manifest):
    typ,hdr,sz=struct.unpack_from('<HHI',manifest,o)
    if typ==0x0102 and num_versions==0:
        ns,name,astart,asize,acount,idi,cls,sty=struct.unpack_from('<IIHHHHHH',manifest,o+16)
        p=o+16+astart
        a_ns,a_name,raw,size,r0,vtype,oldcode=struct.unpack_from('<IIIHBBI',manifest,p)
        assert vtype==0x10 and oldcode==75,(vtype,oldcode)
        struct.pack_into('<I',manifest,p+16,76)
        num_versions+=1
    o+=sz
assert num_versions==1
sp_start=8
sp_typ,sp_hdr,sp_size=struct.unpack_from('<HHI',manifest,sp_start)
count,_,flags,strings_start,_=struct.unpack_from('<IIIII',manifest,sp_start+8)
assert sp_typ==1 and (flags & 256)==0
replaced=0
for i in range(count):
    off=sp_start+strings_start+struct.unpack_from('<I',manifest,sp_start+sp_hdr+4*i)[0]
    length=struct.unpack_from('<H',manifest,off)[0]
    if length>=0x8000:continue
    value=manifest[off+2:off+2+length*2].decode('utf-16le')
    if value=='0.3.9-cn.4':
        newer='0.3.9-cn.5'
        assert len(newer)==length
        manifest[off+2:off+2+length*2]=newer.encode('utf-16le')
        replaced+=1
assert replaced==1

modifications={
    'AndroidManifest.xml':bytes(manifest),
    'assets/web/app.js':app.encode('utf8'),
    'assets/web/index.html':index.encode('utf8'),
    'assets/web/reasoning-policy.js':POLICY.encode('utf8'),
    'assets/web/app.css':css.encode('utf8'),
}
for name,value in modifications.items():
    (WORK/Path(name).name).write_bytes(value)

def raw_deflate(data):
    obj=zlib.compressobj(level=6,method=zlib.DEFLATED,wbits=-15)
    return obj.compress(data)+obj.flush()

sig_start,cd,eocd=read_zip_layout(INPUT)
central=cd_records(cd)
ordered=sorted(orig_info.values(),key=lambda i:i.header_offset)
offsets={};meta={}
with INPUT.open('rb') as src,TEMP.open('wb') as dst:
    for idx,entry in enumerate(ordered):
        name=entry.filename
        offsets[name]=dst.tell()
        src.seek(entry.header_offset)
        header=bytearray(src.read(30))
        assert header[:4]==b'PK\x03\x04'
        nlen,xlen=struct.unpack_from('<HH',header,26)
        name_raw=src.read(nlen);extra=src.read(xlen)
        assert name_raw.decode('utf8')==name
        data_off=entry.header_offset+30+nlen+xlen
        if entry.compress_type==ZIP_STORED:
            padding=(-(dst.tell()+30+nlen+xlen))%4
            extra+=struct.pack('<HH',0xCAFD,padding)+bytes(padding)
            assert len(extra)<65536
        struct.pack_into('<H',header,28,len(extra))
        if name in modifications:
            clear=modifications[name]
            payload=raw_deflate(clear) if entry.compress_type==ZIP_DEFLATED else clear
            crc=zlib.crc32(clear)&0xffffffff
            flags=struct.unpack_from('<H',header,6)[0]&~8
            struct.pack_into('<H',header,6,flags)
            struct.pack_into('<III',header,14,crc,len(payload),len(clear))
            meta[name]=(crc,len(payload),len(clear),flags)
            dst.write(header);dst.write(name_raw);dst.write(extra);dst.write(payload)
        else:
            dst.write(header);dst.write(name_raw);dst.write(extra)
            end=ordered[idx+1].header_offset if idx+1<len(ordered) else sig_start
            copy_region(src,dst,data_off,end-data_off)
    cd_start=dst.tell()
    for name,rec in central:
        struct.pack_into('<I',rec,42,offsets[name])
        if name in meta:
            crc,csize,usize,flags=meta[name]
            struct.pack_into('<III',rec,16,crc,csize,usize)
            struct.pack_into('<H',rec,8,flags)
        dst.write(rec)
    cd_size=dst.tell()-cd_start
    eo=bytearray(eocd)
    struct.pack_into('<I',eo,12,cd_size)
    struct.pack_into('<I',eo,16,cd_start)
    dst.write(eo)
private=serialization.load_pem_private_key(KEY.read_bytes(),password=None)
cert=source_cert(INPUT)
digest=content_digest(TEMP,cd_start,cd_size)
block=signing_block(digest,private,cert)
with TEMP.open('rb') as src,OUTPUT.open('wb') as dst:
    copy_region(src,dst,0,cd_start)
    dst.write(block)
    copy_region(src,dst,cd_start,cd_size)
    src.seek(cd_start+cd_size)
    eo=bytearray(src.read());struct.pack_into('<I',eo,16,cd_start+len(block))
    dst.write(eo)
TEMP.unlink(missing_ok=True)
assert verify_v2(OUTPUT,digest)
assert source_cert(OUTPUT)==source_cert(INPUT)
with ZipFile(INPUT) as before,ZipFile(OUTPUT) as after:
    assert after.namelist()==before.namelist()
    assert after.testzip() is None
    changed={n for n in after.namelist() if after.getinfo(n).CRC!=before.getinfo(n).CRC}
    assert changed==set(modifications),changed
    assert 'dev.mobilecodex.app.zhcnv3'.encode('utf-16le') in after.read('AndroidManifest.xml')
    assert b'Codex CN' in after.read('assets/web/index.html')
    assert b"'subagents-save'" in after.read('assets/web/app.js')
    assert b'"report-open"' not in after.read('assets/web/index.html')
    with OUTPUT.open('rb') as fh:
        unaligned=[]
        for e in after.infolist():
            if e.compress_type!=ZIP_STORED:continue
            fh.seek(e.header_offset);head=fh.read(30)
            n,x=struct.unpack_from('<HH',head,26)
            data_off=e.header_offset+30+n+x
            if data_off%4:unaligned.append((e.filename,data_off))
    assert not unaligned,unaligned[:10]
print('SUCCESS',OUTPUT,'SIZE',OUTPUT.stat().st_size)
print('SHA256',hashlib.sha256(OUTPUT.read_bytes()).hexdigest())
print('CHANGED',sorted(changed))
print('VERSION',76,'0.3.9-cn.5','SAME PACKAGE AND CERT, ALL ZIP STORED MEMBERS ALIGNED')
