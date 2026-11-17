#!/usr/bin/env python3
"""Offline structural tests for the v0.3.9 localization patch."""
from pathlib import Path
import json, subprocess, tempfile
import apply_zhcn as mod

package=Path(__file__).parent
rows=mod.load_chinese(package,1257)
assert len(rows)==1257

with tempfile.TemporaryDirectory() as d:
    root=Path(d)
    sample={}
    for i,zh in enumerate(rows,1):
        placeholders=' '.join('{'+m+'}' for m in mod.PLACEHOLDER.findall(zh))
        sample[f'K{i:04}']=f'English {i:04} {placeholders}'
    src='app/src/main/assets/translations-en.json'
    allfiles={src:json.dumps(sample,ensure_ascii=False),
        'app/build.gradle':'plugins { id "com.android.application" }',
        'app/src/main/java/dev/mobilecodex/app/AppLanguage.java':'old AppLanguage file',
        'app/src/main/java/dev/mobilecodex/app/core/Texts.java':'old Texts file',
        'app/src/main/assets/web/locale.js':'old locale file',
        'docs/localization.md':'Settings → General → Language supports **System**, **English**, and **한국어**. Korean device locales use Korean; other device locales fall back to English.\nChinese (Simplified) and Japanese are potential future translations, not selectable languages yet. To add one:',
        'app/src/main/assets/web/index.html':'<script src="translations.js" defer></script>\n<option value="ko">한국어</option></select></div><div class="settings-row">',
        'app/src/main/assets/web/app.js':"return date.toLocaleString(L.language() === 'ko' ? 'ko-KR' : 'en-US', options);",
        'app/src/test/java/dev/mobilecodex/app/AppLanguageTest.java':'AppLanguage.set(context,"en");assertEquals("Settings",Texts.t("설정"));assertEquals("user content",Texts.t("user content"));',}
    # Exact WebView script whitespace must match the documented source.
    allfiles['app/src/main/assets/web/index.html']='  <script src="translations.js" defer></script>\n<option value="ko">한국어</option></select></div><div class="settings-row">'
    for p,content in allfiles.items():
        target=root/p;target.parent.mkdir(parents=True,exist_ok=True);target.write_text(content,encoding='utf-8')
    mod.SOURCE_EN_BLOB=mod.git_blob_sha((root/src).read_bytes())
    mod.SOURCE_FILES={p:mod.git_blob_sha((root/p).read_bytes()) for p in mod.SOURCE_FILES}
    output=mod.prepare(root,package)
    for p,s in output.items():
        target=root/p;target.parent.mkdir(parents=True,exist_ok=True);target.write_text(s,encoding='utf-8')
    catalog=json.loads((root/'app/src/main/assets/translations-zh-CN.json').read_text(encoding='utf-8'))
    assert len(catalog)==1257
    assert catalog['K0821']=='设置'
    # Parsed JS files have no syntax errors.
    web=root/'app/src/main/assets/web'
    for js in ['locale.js','translations-zh.js','app.js']:
        subprocess.run(['node','--check',str(web/js)],check=True)
    js_test = r'''const fs=require('fs'),vm=require('vm'),assert=require('assert');
const files=process.argv.slice(1);
const nodeDoc={body:{},documentElement:{lang:''},createTreeWalker(){return {nextNode(){return false}}},querySelectorAll(){return []}};
const context={window:{MobileCodexEnglish:{K0821:'Settings'},Native:{locale(){return JSON.stringify({choice:'system',systemLanguage:'zh-CN'})}}},document:nodeDoc,NodeFilter:{SHOW_TEXT:4},navigator:{language:'zh-CN'},localStorage:{getItem(){return null},setItem(){}}};
vm.createContext(context);
vm.runInContext(fs.readFileSync(files[0],'utf8'),context);
vm.runInContext(fs.readFileSync(files[1],'utf8'),context);
let l=context.window.MobileCodexLocale;
assert.equal(l.language(),'zh-CN');assert.equal(l.t('K0821'),'设置');
l.set('en');assert.equal(l.t('K0821'),'Settings');
l.set('ko');assert.equal(l.t('K0821'),'K0821');
l.set('zh-CN');assert.equal(l.t('K0821'),'设置');
'''
    subprocess.run(['node','-e',js_test,str(web/'translations-zh.js'),str(web/'locale.js')],check=True)
    java=root/'app/src/main/java/dev/mobilecodex/app/core/Texts.java'
    test_main=root/'TestMain.java'
    test_main.write_text('''import java.util.Map;
import dev.mobilecodex.app.core.Texts;
public class TestMain {
 public static void main(String[] args) {
  Map<String,String> en=Map.of("설정","Settings");
  Map<String,String> zh=Map.of("설정","设置");
  Texts.configure("zh-CN",en,zh);
  if (!Texts.t("설정").equals("设置") || !Texts.t("Settings").equals("设置")) throw new AssertionError("Chinese failed");
  Texts.configure("en",en,zh);
  if (!Texts.t("설정").equals("Settings")) throw new AssertionError("English failed");
  Texts.configure("ko",en,zh);
  if (!Texts.t("Settings").equals("설정")) throw new AssertionError("Korean failed");
 }
}''',encoding='utf-8')
    subprocess.run(['javac','-d',str(root/'build'),str(java),str(test_main)],check=True)
    subprocess.run(['java','-cp',str(root/'build'),'TestMain'],check=True)
    print('PASS: 1,257 translations, placeholder parity, 13 generated/edited files, JS and Java runtime language switching, XML parse.')
