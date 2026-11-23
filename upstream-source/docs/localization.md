# Localization

**Settings → Language** offers **Simplified Chinese** (default), **English**, and **Follow device language**. The last option uses English on English-language devices and Simplified Chinese otherwise. Changing the interface language does not restart Codex, clear drafts, translate messages, change file contents, or change custom instructions. Speech recognition can follow the actual device language, subject to installed speech services.

Use Simplified Chinese source keys in `t(source)` in JavaScript and `Texts.t(source)` in Java, and add each new label to both `app/src/main/assets/translations-zh-CN.json` and `app/src/main/assets/translations-en.json`. The Chinese value is the source key itself. Run `node tools/sync_translations.cjs --write` from `upstream-source/` to generate the WebView catalogs, or use `--check` to validate them without editing files. Static copy in the packaged HTML is bound before rendering; keep it in the same catalogs.

Use the same named placeholders in both languages. Do not translate protocol identifiers, model responses, user messages, filenames, terminal output, or editor contents. Maintain native accessibility descriptions in `app/src/main/res/values/` and `app/src/main/res/values-zh/` as well. `node tools/verify_liquid_glass_browser.cjs` checks the packaged catalogs and language switching alongside the appearance regressions.
