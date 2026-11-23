const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const assets = path.resolve(__dirname, '../app/src/main/assets');
const format = catalog => JSON.stringify(catalog, null, 2) + '\n';
const tokens = value => [...new Set(value.match(/\{[a-zA-Z]+\}/g))].sort();
const hangul = /\p{Script=Hangul}/u;
const targets = [['en', 'English', 'translations.js'], ['zh-CN', 'Chinese', 'translations-zh.js']];

function syncTranslations(write = false) {
  const catalogs = targets.map(([lang]) => JSON.parse(fs.readFileSync(path.join(assets, `translations-${lang}.json`), 'utf8')));
  const [english, chinese] = catalogs;
  assert.deepEqual(Object.keys(english).sort(), Object.keys(chinese).sort(), 'Chinese and English must define the same source keys');
  for (const [key, value] of Object.entries(english)) {
    assert.equal(chinese[key], key, `Simplified Chinese source must be the key: ${key}`);
    assert.ok(typeof value === 'string' && value.trim(), `No English message for ${key}`);
    assert.ok(!hangul.test(key) && !hangul.test(value), `Unexpected Hangul in ${key}`);
    assert.deepEqual(tokens(key), tokens(value), `Placeholder mismatch in ${key}`);
  }
  for (const [[, global, file], catalog] of targets.map((target, index) => [target, catalogs[index]])) {
    const target = path.join(assets, 'web', file);
    const source = `/* Generated from the bundled JSON by tools/sync_translations.cjs. */\nwindow.MobileCodex${global} = ${format(catalog).trimEnd()};\n`;
    if (write) fs.writeFileSync(target, source);
    else assert.ok(fs.readFileSync(target, 'utf8') === source, `${file} is out of sync; run node tools/sync_translations.cjs --write`);
  }
  return Object.keys(english).length;
}

if (require.main === module) {
  const mode = process.argv[2] || '--check';
  assert.ok(mode === '--check' || mode === '--write', 'Use --check or --write');
  console.log(`${syncTranslations(mode === '--write')} synchronized Chinese and English UI messages`);
}

module.exports = {syncTranslations};
