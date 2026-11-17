"""Patch Codex CN's installed-APK UI (reasoning preset buttons; no report button).
Keep the same Android package and signing identity so in-place updates can preserve app data.
No API credentials are read or embedded. The existing local signing key stays private.
"""
from pathlib import Path
from zipfile import ZipFile, ZIP_STORED, ZIP_DEFLATED
import hashlib
import os
import re
import struct
import zlib
from cryptography.hazmat.primitives import serialization
from rename_codex_cn import read_zip_layout, cd_records, copy_region, content_digest, verify_v2
from fix_codex_cn_alignment import source_cert, signing_block

ROOT = Path('/mnt/data')
INPUT = ROOT / 'Codex-CN-V3-API-Fix-arm64.apk'
OUTPUT = ROOT / 'Codex-CN-V4-arm64.apk'
TEMP = ROOT / 'codex-cn-v4-unsigned.tmp'
KEY = ROOT / 'codex-cn-signing-key-private.pem'
BUILD = ROOT / 'codex_v4work' / 'new'
BUILD.mkdir(parents=True, exist_ok=True)

POLICY = r'''/* Codex CN V4: explicit per-model reasoning picker.
   The presence of manual choices for third-party API is not evidence of support.
   The selected value is forwarded as the runtime's chat.send effort parameter. */
(() => {
  'use strict';
  const levels = Object.freeze(['none','minimal','low','medium','high','xhigh','max']);
  const labels = Object.freeze({
    none:'关闭', minimal:'极低', low:'低', medium:'中', high:'高', xhigh:'超高', max:'最大'
  });
  const valid = new Set(levels);
  function efforts(model) {
    const raw = Array.isArray(model?.supportedReasoningEfforts)
      ? model.supportedReasoningEfforts : [];
    const reported = new Set();
    for (const item of raw) {
      const val = typeof item === 'string' ? item : item?.reasoningEffort;
      if (valid.has(val)) reported.add(val);
    }
    return levels.filter(item => reported.has(item));
  }
  function offered(model, thirdParty) {
    const reported = efforts(model);
    // Third-party /models often provides just IDs, no reasoning capability metadata.
    // Offer *manual, unverified* levels; remote /responses may reject any of them.
    return reported.length ? reported : (thirdParty ? levels.slice() : []);
  }
  function choose({previous='', fallback='', supported=[], thirdParty=false}) {
    if (supported.includes(previous)) return previous;
    if (thirdParty) return '';
    return supported.includes(fallback) ? fallback : (supported[0] || '');
  }
  function validSelection(effort, model, thirdParty) {
    if (!effort) return !!thirdParty || offered(model, false).length === 0;
    return offered(model, !!thirdParty).includes(effort);
  }
  function explain({modelId='', effort='', apiActive=false, reported=[], offeredLevels=[]}) {
    const name = modelId || '未选择模型';
    if (!offeredLevels.length)
      return name + '：运行时未提供思考档位，当前不支持手动调整。';
    const chosen = effort ? (labels[effort] || effort) + ' (' + effort + ')' : '自动（不指定 effort）';
    if (apiActive) {
      return name + ' · 已选：' + chosen + '\n' +
        (reported.length ? '档位来自运行时模型元数据；服务商能否接受仍需实测。'
                         : '第三方模型未报告支持档位，以上是手动尝试选项，不代表服务商支持。') +
        '\n请求会传给 Codex 运行时；若服务商拒绝，请改用“自动”。';
    }
    return name + ' · 已选：' + chosen + '\n只显示 Codex 运行时报告的档位，不通过提示词模拟。';
  }
  const api = Object.freeze({levels, labels, efforts, offered, choose, validSelection, explain});
  if (typeof window !== 'undefined') window.MobileCodexReasoning = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
'''

with ZipFile(INPUT) as archive:
    app = archive.read('assets/web/app.js').decode('utf-8')
    index = archive.read('assets/web/index.html').decode('utf-8')
    provider = archive.read('assets/web/api-providers.js').decode('utf-8')
    css = archive.read('assets/web/app.css').decode('utf-8')
    manifest = bytearray(archive.read('AndroidManifest.xml'))
    original_infos = {x.filename:x for x in archive.infolist()}

assert '/* V3.1 bundled reasoning compatibility */' in app
anchor = '/* Packaged UI only. Native.postMessage is the sole transport; no remote scripts. */'
assert app.count(anchor) == 1
app = '/* V4 embedded reasoning policy; no remote asset loading */\n' + POLICY + '\n' + anchor + app.split(anchor, 1)[1]

# Include third-party manual levels when the provider does not disclose capability metadata.
old = """    const previous = $('effort').value, supported = policy.efforts(selected);
    $('effort').replaceChildren();
    // Use only model-advertised levels; never synthesize a high/xhigh/max level.
    for (const effort of supported) $('effort').add(new Option(policy.labels[effort], effort));
    if (state.apiActive) $('effort').add(new Option('自动（服务商默认）', ''));
    if (!supported.length && !state.apiActive) $('effort').add(new Option(t('추론 설정 정보 없음'), ''));
    $('effort').disabled = !supported.length;
    $('effort').value = policy.choose({previous, fallback:selected?.defaultReasoningEffort,
      supported, thirdParty:!!state.apiActive});
    optionsSummary();"""
new = """    const previous = $('effort').value;
    const thirdParty = !!state.apiActive;
    const supported = policy.offered(selected, thirdParty);
    $('effort').replaceChildren();
    // Third-party entries are manual/experimental if native model metadata is absent.
    if (thirdParty) $('effort').add(new Option('自动（不指定强度）', ''));
    for (const level of supported) $('effort').add(new Option(policy.labels[level], level));
    if (!supported.length && !thirdParty) $('effort').add(new Option(t('추론 설정 정보 없음'), ''));
    $('effort').disabled = !supported.length;
    $('effort').value = policy.choose({previous, fallback:selected?.defaultReasoningEffort,
      supported, thirdParty});
    optionsSummary();"""
assert app.count(old)==1
app=app.replace(old,new)

# Distinguish provider changed even if the models JSON happens to be unchanged.
assert 'const key = JSON.stringify(state.models);' in app
app=app.replace('const key = JSON.stringify(state.models);', "const key = JSON.stringify([state.apiActive || '', state.models]);")

# Visible tap targets in the model picker; both controls update the same #effort value
# that chat.send forwards to Android.
old = """  function syncReasoningPicker() {
    const options = [...$('effort').options].filter(option => option.value), slider = $('effort-slider');
    $('model-heading').textContent = $('model').selectedOptions[0]?.textContent || t('모델 목록 조회 필요');
    $('effort-heading').textContent = $('effort').value ? $('effort').selectedOptions[0].textContent : t('모델');
    slider.max = String(Math.max(0, options.length - 1));
    slider.value = String(Math.max(0, options.findIndex(option => option.value === $('effort').value)));
    slider.disabled = options.length < 2;
    const auto = $('effort-auto');
    if (auto) {
      auto.hidden = !state.apiActive;
      auto.disabled = !options.length;
      auto.setAttribute('aria-pressed', String(state.apiActive && !$('effort').value));
    }
    $('reasoning-control').hidden = !options.length && !state.apiActive; $('effort-unavailable').hidden = !!options.length || !!state.apiActive;
    const selected = state.models.find(m => (m.model || m.id) === $('model').value);
    const policy = window.MobileCodexReasoning;
    $('effort-contract').textContent = policy.explain({modelId:$('model').value,
      effort:$('effort').value, apiActive:!!state.apiActive, supported:policy.efforts(selected)});
    previewReasoning(); sizeModelPicker();
  }"""
new = """  function syncReasoningPicker() {
    const options = [...$('effort').options].filter(option => option.value), slider = $('effort-slider');
    const thirdParty = !!state.apiActive;
    const policy = window.MobileCodexReasoning;
    const selected = state.models.find(m => (m.model || m.id) === $('model').value);
    const offeredLevels = policy.offered(selected, thirdParty);
    $('model-heading').textContent = $('model').selectedOptions[0]?.textContent || t('모델 목록 조회 필요');
    $('effort-heading').textContent = $('effort').value ? $('effort').selectedOptions[0].textContent :
      (thirdParty ? '自动 · 服务商默认' : t('추론 강도 조절 미지원'));
    slider.max = String(Math.max(0, options.length - 1));
    slider.value = String(Math.max(0, options.findIndex(option => option.value === $('effort').value)));
    slider.disabled = options.length < 2;
    const auto = $('effort-auto');
    if (auto) { auto.hidden = true; auto.disabled = !options.length; }
    $('reasoning-control').hidden = !offeredLevels.length && !thirdParty;
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
    }
    previewReasoning(); sizeModelPicker();
  }"""
assert app.count(old)==1
app=app.replace(old,new)

# Keep the automatic label visible; the old hidden slider must not replace it with "关闭".
old_line = "    if (option) $('effort-heading').textContent = option.textContent;"
assert old_line in app
app = app.replace(old_line, "    if (option && $('effort').value) $('effort-heading').textContent = option.textContent;")

# Show the chosen automatic mode in the chat composer too.
old="$('effort-summary').textContent = $('effort').value ? effort : '';"
new="$('effort-summary').textContent = $('effort').value ? effort : (state.apiActive ? '自动' : '');"
assert app.count(old)==1
app=app.replace(old,new)

# Fast access to the same effort select from API settings; persists via existing saveOptions().
old="  apiProvidersUi?.init({call, refresh:()=>call('state').then(render), toast});\n  selectSettingsTab('general');"
new="""  apiProvidersUi?.init({call, refresh:()=>call('state').then(render), toast});
  if ($('api-effort-choice')) on('api-effort-choice', () => {
    const value = $('api-effort-choice').value;
    if (![...$('effort').options].some(o => o.value === value)) {
      toast('该档位不可用，请重新选择。'); return;
    }
    $('effort').value = value;
    $('effort').dispatchEvent(new Event('change', {bubbles:true}));
  }, 'change');
  selectSettingsTab('general');"""
assert app.count(old)==1
app=app.replace(old,new)

# Make V4 clearly visible in app settings; app name remains short.
assert 'Codex CN 中文增强 V3' in index
index=index.replace('Codex CN 中文增强 V3','Codex CN V4')
index=index.replace('独立 V3 不能直接安装上游 APK 更新。升级需使用相同 V3 签名，或备份数据后另行安装。',
                    '请仅安装同一签名的 Codex CN 更新包。请勿安装原作者官方版覆盖此应用。')

# Add a clear selector where the user scanned their 21 models.
old='''      <p class="muted" id="api-current"></p>
      <div id="api-profiles"></div>'''
new='''      <p class="muted" id="api-current"></p>
      <div id="api-profiles"></div>
      <div class="api-card" id="api-effort-settings" hidden>
        <strong>思考强度（当前聊天模型）</strong>
        <p id="api-effort-current" class="api-meta"></p>
        <label for="api-effort-choice">选择档位</label>
        <select class="text-input" id="api-effort-choice" aria-label="当前聊天模型思考强度"></select>
        <small class="muted">保存后立即生效。第三方模型如未声明支持强度，档位仅供手动尝试；实际支持取决于服务商 /responses 接口。</small>
      </div>'''
assert provider.count(old)==1
provider=provider.replace(old,new)
provider=provider.replace('.api-form label{font-weight:600;font-size:13px}', '.api-form label{font-weight:600;font-size:13px}\n      #api-effort-settings{display:flex;flex-direction:column;gap:7px}\n      #api-effort-settings[hidden]{display:none}\n      #api-effort-choice{min-height:44px;width:100%}')

# Remove ALL visible error report entry points + the opt-in report dialog, and do not load its JS.
assert '<script src="reports.js" defer></script>' in index
index = index.replace('  <script src="reports.js" defer></script>\n','')
index = index.replace('  <script src="reasoning-policy.js" defer></script>\n','')
assert 'id="report-error-open"' in index and 'id="report-login-open"' in index and 'id="report-open"' in index
index,n=re.subn(r'<button id="report-error-open"[^>]*>.*?</button>', '', index); assert n==1
index,n=re.subn(r'<button id="report-login-open"[^>]*>.*?</button>', '', index); assert n==1
index,n=re.subn(r'<button id="report-open"[^>]*>.*?</button><p class="muted">.*?</p>', '', index); assert n==1
index,n=re.subn(r'<dialog id="report-dialog".*?</dialog>', '', index); assert n==1
assert 'id="report-dialog"' not in index
index=index.replace('<title>Codex CN V3</title>','<title>Codex CN</title>')
old='''        <div id="reasoning-control" class="reasoning-control">
          <input id="effort-slider" type="range" min="0" max="0" step="1" value="0" aria-label="思考强度">
          <button id="effort-auto" class="secondary-button" type="button" hidden style="margin-top:12px;width:100%">自动（使用服务商默认强度）</button>
          <small class="muted" style="display:block;margin-top:9px">强度按模型可用档位列出，实际传入运行时；切换服务商并不改变模型本身。第三方 API 是否接受此档位须实际测试。</small>'''
new='''        <div id="reasoning-control" class="reasoning-control">
          <div id="effort-preset-grid" class="effort-preset-grid" role="group" aria-label="选择思考强度"></div>
          <input id="effort-slider" type="range" min="0" max="0" step="1" value="0" aria-label="思考强度（辅助控制）" hidden>
          <button id="effort-auto" class="secondary-button" type="button" hidden>自动</button>
          <small class="muted" style="display:block;margin-top:9px">点击档位即可选择，聊天发送时会传递该强度。第三方 API 未声明支持的档位属于试验项，可能被服务商拒绝。</small>'''
assert index.count(old)==1
index=index.replace(old,new)

# A responsive Chinese-labeled button grid for small Android screens.
css += '''\n/* Codex CN V4: prominent reasoning effort selection */
#effort-slider[hidden],#effort-auto[hidden]{display:none!important}
.effort-preset-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:7px;margin:6px 0 12px}
.effort-preset-button{min-height:43px;padding:9px 3px;border:1px solid var(--border,#8885);background:var(--fill-1);color:var(--text);border-radius:12px;font-size:13px;font-weight:600;cursor:pointer;touch-action:manipulation}
.effort-preset-button[aria-pressed="true"]{color:var(--surface);background:var(--text);border-color:var(--text)}
.effort-preset-button:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
#effort-contract{font-size:12px;line-height:1.45}
#model-picker{overflow-y:auto;overscroll-behavior:contain}
@media(max-width:370px){.effort-preset-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
'''

# Update binary XML versionCode without shifting offsets (same package and label).
assert manifest[:4] == b'\x03\x00\x08\x00'
o=8
num_versions=0
while o+8<=len(manifest):
    typ,hdr,sz=struct.unpack_from('<HHI',manifest,o)
    if typ==0x0102:  # START_ELEMENT
        ns,name,astart,asize,acount,idi,cls,sty=struct.unpack_from('<IIHHHHHH',manifest,o+16)
        if num_versions==0:
            # The manifest root has versionCode as the first attribute.
            p=o+16+astart
            a_ns,a_name,raw,size,r0,vtype,oldcode=struct.unpack_from('<IIIHBBI',manifest,p)
            assert vtype==0x10 and oldcode==74, (vtype,oldcode)
            struct.pack_into('<I',manifest,p+16,75)
            num_versions+=1
    o+=sz
assert num_versions==1
# Rename versionName in the existing UTF16 string table (exact character count).
sp_start=8
sp_typ,sp_hdr,sp_size=struct.unpack_from('<HHI',manifest,sp_start)
count,style_count,flags,strings_start,styles_start=struct.unpack_from('<IIIII',manifest,sp_start+8)
assert sp_typ==1 and (flags & 256)==0
replaced=0
for i in range(count):
    off=sp_start+strings_start+struct.unpack_from('<I',manifest,sp_start+sp_hdr+4*i)[0]
    length=struct.unpack_from('<H',manifest,off)[0]
    if length >= 0x8000:continue
    value=manifest[off+2:off+2+length*2].decode('utf-16le')
    if value=='0.3.9-zhcn':
        newer='0.3.9-cn.4'
        assert len(newer)==length
        manifest[off+2:off+2+length*2]=newer.encode('utf-16le')
        replaced+=1
assert replaced==1

modifications = {
  'AndroidManifest.xml':bytes(manifest),
  'assets/web/app.js':app.encode('utf-8'),
  'assets/web/index.html':index.encode('utf-8'),
  'assets/web/reasoning-policy.js':POLICY.encode('utf-8'),
  'assets/web/api-providers.js':provider.encode('utf-8'),
  'assets/web/app.css':css.encode('utf-8')
}

for name,data in modifications.items():
    (BUILD/Path(name).name).write_bytes(data)

# Copy original compressed member bytes for all untouched assets; re-align stored
# resources.arsc and lib members; then sign with the SAME persistent EC key.
def raw_deflate(data):
    obj=zlib.compressobj(level=6,method=zlib.DEFLATED,wbits=-15)
    return obj.compress(data)+obj.flush()

sig_start, cd, eocd=read_zip_layout(INPUT)
central=cd_records(cd)
ordered=sorted(original_infos.values(),key=lambda i:i.header_offset)
offsets={}; meta={}
with INPUT.open('rb') as src,TEMP.open('wb') as dst:
    for idx,entry in enumerate(ordered):
        name=entry.filename
        offsets[name]=dst.tell()
        src.seek(entry.header_offset)
        header=bytearray(src.read(30))
        assert header[:4]==b'PK\x03\x04'
        nlen,xlen=struct.unpack_from('<HH',header,26)
        name_raw=src.read(nlen)
        extra=src.read(xlen)
        assert name_raw.decode('utf-8')==name
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
            flags=struct.unpack_from('<H',header,6)[0] & ~8
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
    eo=bytearray(src.read()); struct.pack_into('<I',eo,16,cd_start+len(block))
    dst.write(eo)
TEMP.unlink(missing_ok=True)

assert verify_v2(OUTPUT,digest)
assert source_cert(OUTPUT)==source_cert(INPUT)
with ZipFile(INPUT) as before, ZipFile(OUTPUT) as after:
    assert after.namelist()==before.namelist()
    assert after.testzip() is None
    changed={n for n in after.namelist() if after.getinfo(n).CRC!=before.getinfo(n).CRC}
    assert changed==set(modifications), changed
    assert 'dev.mobilecodex.app.zhcnv3'.encode('utf-16le') in after.read('AndroidManifest.xml')
    assert b'Codex CN' in after.read('assets/web/index.html')
    assert b'window.MobileCodexReasoning' in after.read('assets/web/app.js')
    assert b'effort-preset-grid' in after.read('assets/web/index.html')
    assert b'"report-open"' not in after.read('assets/web/index.html')
    assert b'<script src="reports.js"' not in after.read('assets/web/index.html')
    with OUTPUT.open('rb') as fh:
        unaligned=[]
        for e in after.infolist():
            if e.compress_type!=ZIP_STORED:continue
            fh.seek(e.header_offset);head=fh.read(30)
            n,x=struct.unpack_from('<HH',head,26)
            data_offset=e.header_offset+30+n+x
            if data_offset % 4:unaligned.append((e.filename,data_offset))
    assert not unaligned, unaligned[:10]
print('SUCCESS',OUTPUT)
print('SIZE',OUTPUT.stat().st_size)
print('SHA256',hashlib.sha256(OUTPUT.read_bytes()).hexdigest())
print('CHANGED',sorted(changed))
print('VERSION CODE',75,'VERSION NAME','0.3.9-cn.4')
print('SIGNING CERT SAME, PACKAGE SAME, ZIP ALIGNED, CRC ALL VALID')
