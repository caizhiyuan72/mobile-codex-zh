# 源码状态 · 2026-11-17

## 基线与旧 APK

`upstream-source/` 最初从 Mobile Codex v0.3.9 完整恢复，基线提交为 `b6c12eb65fd29a38b0c2825bf12a7aca64736c5a`，记录在 `.upstream-commit`。原恢复与原版测试曾通过；它们只证明基线导入，不证明后续修改可用。

已发布 V5（`v0.3.9-cn.5` / versionCode `76`）采用旧 APK 二进制补丁制作，历史原生改动未全部在当时的源码中提供。其 `release-manifest.json` 的 `source_complete` 保持 `false`。本次工作不声称能够逐字节重建 V5。

## 本轮已进入真实工程的内容

- 恢复 V5 WebView 修改作为起点，在工程 `assets/web/` 内实施新的界面、中文、动效和流式刷新策略。
- 从 Java 源码重建第三方 API 服务商管理、Keystore 加密密钥、独立 CODEX_HOME、有效 API 配置启动及服务商作用域会话。
- 增加旧 V5 API 配置格式迁移路径；迁移失败保留旧数据并在设置中提示。
- 移除订阅/Live/WebRTC/Pro 网页/用量组件和外部 CLI 邀请的原生及前端主流程，保留文件、工具、审批、系统听写和原生子智能体配置。
- 设置 fork 身份 `dev.mobilecodex.app.zhcnv3`、版本 `77 / 0.3.9-cn.6`、默认中文及本仓库更新源。
- 插图生成工具、资源和哈希一同更新，原画不变。
- 增加 GitHub 浏览器设备授权、加密凭据存储和 Git helper；旧安装可使用一次性 Python 设备授权脚本推送已提交源码。已用用户自建 OAuth App 完成真实设备授权并推送开发分支，详见 [GitHub 登录说明](GITHUB_LOGIN.md)。

当前目录已包含 fork 修改，不再是“未修改的上游源码”。旧的自动恢复工作流已退役，避免再次覆盖修改；保留的 provenance 工作流只检查记录的上游基线。

## 源码与新包的关联方式

根 `.github/workflows/build-android.yml` 直接编译 `upstream-source`，不再修补旧 APK。它将校验实际 APK 身份、ABI 和 Web 资源，并附上相同 Git 提交的源码归档、APK/源码 SHA-256 和 `build-info.json`。不会调用旧发布流程，也不会自动发布。

开发分支 `feat/api-codex-ui` 的提交 `ee0e1f2c6f70ecb3e47b068c2da57235a5f70d28` 已通过[完整构建](https://github.com/caizhiyuan72/mobile-codex-zh/actions/runs/44071083752)：JavaScript、Python、图标、真实 Chromium 布局检查，以及 Android Debug/Release 单元测试、lint、设备测试 APK 编译和未签名 Release APK 打包。

本轮移除已删除的旧 Pro 方法引用，补充历史保留、禁止旧请求重发和保存失败回滚测试，并将运行时恢复测试迁移到独立 API 配置。另修正 Android 测试中的不兼容文件接口，并通过预先创建项目来验证切换后旧文件审批失效，保留待审批时不得创建项目的检查。上述修复已经实际 Android 编译和测试验证。

本机没有 JDK/SDK，本地语法检查不被视为编译；实际验证来自上面的 GitHub 构建。它已输出 APK、相同提交的源码、身份和校验和，但仍未签名，也未完成真机在线服务商验收。

按照用户补充的 [V5 安全迁移方案](SAFE_V5_MIGRATION.md)，已新增独立包名 `dev.mobilecodex.app.zhcnv3.next` 和名称 `Codex CN API` 的 `parallel` 构建。其测试、lint 和身份另行检查，本地签名使用独立且固定的证书；不会用新签名冒充 V5 覆盖更新。项目可通过现有导入入口迁移，密钥需重新录入，旧聊天仍保留在 V5，详见[并行安装说明](PARALLEL_INSTALL.md)。

## 发布前仍需完成

- 完成并行版构建、独立签名和最终 APK 校验。
- 保留 V5，在真机验证并行安装、项目导入与重新授权文件夹；不宣称旧聊天或设置已自动迁移。
- 使用用户自己的第三方服务商测试 Responses 流式输出、工具调用、停止、重连和原生子智能体；目前没有 API 密钥，未进行这些在线调用。
- 完成不同屏幕、输入法和系统听写的真机检查，并保留对应源码与构建记录。
