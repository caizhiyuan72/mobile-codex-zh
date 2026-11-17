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

开发分支 `feat/api-codex-ui` 的提交 `0b69bed429b7df5ded098ce6ac135507c827960f` 已通过 GitHub Actions 的 UI/source checks，包括 JavaScript、Python、图标校验和真实 Chromium 布局检查。对应[构建记录](https://github.com/caizhiyuan72/mobile-codex-zh/actions/runs/44059852791)中的 Android 作业仍然失败：旧 Pro 恢复代码引用了四个已经删除的方法，尚未执行完 Android 单元测试、lint 和 APK 构建。

当前本地工作区已移除上述旧引用，补充了历史保留、禁止旧请求重发和保存失败回滚的测试，并将运行时恢复测试迁移到独立的 API 配置。接手后本地 260 项 JavaScript 测试通过；117 个 Java 文件通过语法解析，61 处字面量 Engine 反射引用核对通过。这些检查不能代替 Java 编译或执行 Android 测试。

本地 Python 全套运行 126 项，其中 4 项跳过、1 项慢 CLI 测试首次失败；该失败项单独复跑通过，未更改其代码或放宽断言。上述修复尚待 GitHub 的 JDK/SDK 环境完成验证；没有新版 APK 或真机覆盖升级的实测结论。只有这些检查完成后，才能把新版本标记为可发布。

## 发布前仍需完成

- 从本轮源码成功构建，审核 CI 输出与实际包体积。
- 使用与已安装 V5 相同的签名完成覆盖升级，验证对话、项目及旧 API 配置迁移。
- 使用用户自己的第三方服务商测试 Responses 流式输出、工具调用、停止、重连和原生子智能体；目前没有 API 密钥，未进行这些在线调用。
- 完成不同屏幕、输入法和系统听写的真机检查，并保留对应源码与构建记录。
