# Codex CN · API 版

基于 [Mobile Codex v0.3.9](https://github.com/nokryong/mobile-codex/tree/v0.3.9) 的非官方 Android 客户端。核心是 Android Java + WebView 界面，以及随 APK 分发的 Codex app-server；模型推理通过网络 API 完成。

当前源码版本为 **`0.3.9-cn.6` / versionCode `77`**。原包名 `dev.mobilecodex.app.zhcnv3` 的源码已通过完整 CI 并生成未签名 APK，见[构建记录](https://github.com/caizhiyuan72/mobile-codex-zh/actions/runs/44071083752)。由于 V5 原签名尚未找到，新增独立包名 `dev.mobilecodex.app.zhcnv3.next`、名称 **Codex CN API** 的并行构建；其签名与验收进度见[迁移说明](docs/PARALLEL_INSTALL.md)。Releases 中的 V5 仍是旧二进制补丁包，本轮没有发布新 Release。

## 当前范围

- 第三方 API 独立配置，无需 ChatGPT 订阅；当前支持 HTTPS 的 **Responses 协议**。
- 保留项目、文件、命令、Git、技能、MCP、审批及 Codex 原生子智能体配置。
- 移除订阅登录、订阅用量组件、Live 实时语音、Pro 网页咨询、外部 Claude/Gemini CLI 邀请流程。
- 输入操作收为单排，统一按钮点击尺寸；加入轻量面板和按压动效，流式消息按帧合并刷新。
- Android 系统听写放入添加菜单，识别结果进入草稿，由用户发送。
- 新增 GitHub 浏览器设备授权设置页，内置 Git 使用加密保存的授权；首次配置使用自己注册的公开 OAuth Client ID，无需 `gh` 或 Client Secret。详见 [登录说明](docs/GITHUB_LOGIN.md)。
- 32 张聊天插图从 27,729,762 字节缩为 1,429,728 字节；原画保留，最终 APK 大小待构建后测量。

`/models` 扫描只读取模型 ID。模型能否完成对话、工具调用、推理强度和原生子智能体任务，取决于第三方服务商的实际兼容情况，不能由扫描成功推断。

暂不接入 Claude。服务商记录保留显式 `protocol` 字段、独立配置和运行目录，后续可增加 Claude 原生 Messages 协议适配；当前版本不会把 Claude 模型名当成协议支持。

## 源码与构建

实际 Android 工程位于 [`upstream-source/`](upstream-source/)。[`patches/`](patches/) 是旧 V5 恢复材料，构建不再依赖 APK 二进制补丁脚本。

根目录的 [Build API edition from source](.github/workflows/build-android.yml) 会在代码提交后执行：

1. 前端交互、插图完整性、Python 工具检查与 Chromium 布局检查。
2. 准备校验和固定的 Codex/开发工具运行时，运行 Android 单元测试和 lint。
3. 构建未签名 ARM64 release APK，核对 APK 实际包名、版本、ABI 及每个 Web 资源与源码的一致性。
4. 同时提供对应 Git 提交的源码归档、`build-info.json` 和 `SHA256SUMS`。

原包名构建已在 `ee0e1f2c6f70ecb3e47b068c2da57235a5f70d28` 完整通过；新增并行构建将另行执行单元测试、lint、打包和身份检查。CI 产物为未签名构建材料，不会自动发布。设备测试只会编译，仍需在真机执行。原包名覆盖安装必须使用 V5 原签名私钥；并行版使用独立的长期签名，保留旧安装和数据。

本地构建需要 JDK 17、Android SDK/build-tools 35、NDK `28.2.13676358`、Python 3.12 和满足 `package.json` 要求的 Node.js，例如 `24.22.1`：

```sh
cd upstream-source
npm ci --ignore-scripts
npm test
node tools/optimize_chat_icons.mjs
python3 -m pip install -r tools/requirements-devtools.txt
python3 -m unittest discover -s tests -p 'test_*.py'
python3 tools/prepare_runtime.py
python3 tools/build_native.py --ndk "$ANDROID_HOME/ndk/28.2.13676358"
python3 tools/prepare_devtools.py
bash gradlew --no-daemon testDebugUnitTest lintDebug assembleRelease
```

详见 [优化与验证记录](docs/API_OPTIMIZATION.md)、[GitHub 浏览器授权与首次构建](docs/GITHUB_LOGIN.md)、[源码恢复状态](docs/SOURCE_STATUS.md)、[更新说明](docs/UPDATES.md)。

## 历史发布

最新历史发布为 `v0.3.9-cn.5`：`Codex-CN-V5-arm64.apk`，versionCode `76`，220,595,479 字节。校验值保留在 [`release-manifest.json`](release-manifest.json)；其中 `source_complete: false` 仍描述该旧发布，不表示新版已经完成验证。

## 许可证

项目沿用上游 GPL-3.0，见 [`LICENSE`](LICENSE) 及工程内的第三方声明。本项目不是 OpenAI 或 Mobile Codex 官方发行版。
