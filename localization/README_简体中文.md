# Mobile Codex v0.3.9 简体中文汉化补丁

适用原项目：[nokryong/mobile-codex](https://github.com/nokryong/mobile-codex)，**仅适配已固定的 v0.3.9 标签**（源码提交 `b6c12eb65fd29a38b0c2825bf12a7aca64736c5a`）。**交付的是可复现的源码汉化补丁，不是 APK 安装包。** 这是第三方本地化补丁，不是 OpenAI 或原作者发布的官方版本。

## 本次实际完成的内容

- 逐条翻译官方 `translations-en.json` 中的 **1,257 条 UI 消息**，涵盖聊天、设置、文件、终端、账号、用量、语音、Linux、插件、MCP、智能体、手机控制和错误信息；动态占位符（例如 `{count}`）保留。
- 增加 `zh-CN` 语言选择：**设置 → 常规 → 语言 → 简体中文**，保留系统、英语、韩语三个旧选项。简体中文系统语言自动匹配。
- 原生 Java 翻译接口、WebView JS 翻译接口、无障碍服务说明和用量桌面小组件新增简体中文资源。
- 补充中文日期格式与原始单元测试中的中文断言。
- 不改动 Codex 登录、额度、权限判断、请求路由、手机控制工具、文件内容或聊天内容。
- `--parallel` 选项可以让自行构建的 **Debug APK** 使用独立包名 `dev.mobilecodex.app.zhcn`，避免覆盖已安装的官方签名版本。此独立版本无法直接安装官方更新，更新时需要用相同签名重新构建。

## 使用方法（Mac / Windows / Linux 均可先打补丁）

```bash
git clone --branch v0.3.9 --depth 1 https://github.com/nokryong/mobile-codex.git
python3 apply_zhcn.py ./mobile-codex --check-only
python3 apply_zhcn.py ./mobile-codex --parallel
```

两个文件 `apply_zhcn.py` 与 `zh_translations.tsv` 必须放在同一个文件夹中。`--parallel` 建议用于首次编译与测试；希望保持原包名时去掉该选项，但**不同签名的 APK 不能覆盖现有安装，且卸载会清除应用数据**。不要为了汉化冒险丢失原版记录。

### 在 macOS 上编译

需要准备：JDK 17、Android SDK Platform 35、Build Tools 35.0.0、NDK `28.2.13676358`、Python 3、Node.js 22.23.4 或兼容版本，且可以访问相关下载站点。设置 `ANDROID_HOME`（例如 `~/Library/Android/sdk`）。按照官方 README 的顺序运行：

```bash
cd mobile-codex
python3 tools/prepare_runtime.py
python3 -m pip install -r tools/requirements-devtools.txt
python3 tools/build_native.py --ndk "$ANDROID_HOME/ndk/28.2.13676358"
python3 tools/prepare_devtools.py
npm ci --ignore-scripts
npm test
./gradlew assembleDebug testDebugUnitTest lintDebug
```

Debug APK 输出位置：`app/build/outputs/apk/debug/app-debug.apk`。

也可以在 macOS 上运行压缩包内的 `build_on_mac.sh`，它会检查基础工具、克隆对应版本、打上并行安装补丁并调用上述步骤；Android SDK、NDK 和 JDK 仍需你提前安装。

## 验证与限制

`python3 selftest.py` 是**不需要网络、不需要 Android SDK 的补丁结构自检**，验证目录条数、变量占位符、JS 语法、Java `Texts` 编译与资源 XML 解析。当前仅通过该级别测试，**并未获得或实机验证编译后的 APK**。需要在一加 Ace 5 或模拟器检查输入法组合、长文字换行、语言热切换、无障碍提示和工作流。

如果后续原版新增或修改翻译项，脚本会因为翻译表 SHA 不一致而拒绝打补丁，以避免把错位文本写入错误位置。需要先针对新版本重新同步译文，不要删除此校验。

## 安全与版权

- 原项目采用 **GPL-3.0-only**；重新分发修改后的完整程序时，请保留原项目的许可证及第三方声明，并按许可证提供对应源码。
- 汉化不会让第三方 APK 自动安全可信。尤其是手机控制和设备文件权限，应先验证自行编译的 APK 来源与签名，再逐步授予权限。
- 仅本地化 UI，不翻译你的聊天记录、代码、终端输出或私有文件。
