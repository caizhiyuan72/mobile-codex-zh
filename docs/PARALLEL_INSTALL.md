# 并行迁移版

找不到 V5 原签名时，按 [安全迁移方案](SAFE_V5_MIGRATION.md) 保留 V5，安装独立的 API 版。该版本的应用名称为 **Codex CN API**，包名为 `dev.mobilecodex.app.zhcnv3.next`；旧 V5 仍为 `dev.mobilecodex.app.zhcnv3`。

`0.3.9-cn.7` 修复选择图片后输入区被撑满的问题：附件使用固定缩略图，一排横向滚动，保留点击放大和删除。已安装 `cn.6` 的 Codex CN API 可使用下方同包名、同签名的 `cn.7` 直接更新，保留应用数据；从 V5 首次迁移时仍按本文后面的步骤处理。布局验证范围见[图片附件预览说明](../upstream-source/docs/attachment-previews.md)。

## 已完成的构建与本地交付

源码提交 `809b95cef64d893ad87665d6ac770ab96e97c554` 的[完整构建](https://github.com/caizhiyuan72/mobile-codex-zh/actions/runs/44081907430)已通过 UI、Chromium、Python、Debug/Release/parallel 单元测试、lint 和 APK 打包。图片回归检查覆盖 4 种宽度的明暗主题，包括大图、多图、短视口、放大、删除、草稿恢复和发送后缩略图。并行 APK 已在用户手机本地签名，通过 Google apksigner 验证，并核对签名前后全部 ZIP 成员内容、ARM64 和 48 个 Web 资源。

- 已交付本地文件：`Download/Codex-CN-API-0.3.9-cn.7-arm64.apk`
- 大小：186,215,218 字节。
- SHA-256：`e9b46f663282cc12c7909f7caeae0e2b50566d6bf8afbd4f1a69e35a0384e928`。
- 包名：`dev.mobilecodex.app.zhcnv3.next`；版本：`0.3.9-cn.7` / `78`。
- 签名证书：`c3537a4bbf12e671868127ef3267c4806ffabed83d62208d94085ae4fe12b207`。

签名后的文件已复制并复核 SHA-256。本轮未自动安装 `cn.7`，也尚未在 Android 真机中启动新版或使用真实服务商验收；Chromium 检查通过不代表已完成手机内操作验收。未发布到 GitHub Release。下载目录中另一个带 `unsigned` 的原包名 APK 是构建检查材料，安装时使用上面不带 `unsigned` 的 API 版。

## 构建与签名

```sh
cd upstream-source
bash gradlew testParallelUnitTest lintParallel assembleParallel
```

运行前须按工程说明准备 ARM64 runtime/devtools。根 CI 在原包名的 Debug/Release 检查通过后，执行并行版单元测试、lint 和打包；附上对应提交的源码、身份、哈希，以及由 Google Android SDK build-tools 35.0.0 转换的 Android 可执行 apksigner。

CI 产物仍未签名。下载后使用单独、长期保存的本地签名密钥签名，并通过 apksigner 验证，再把最终 APK 交付用户。私钥不得进入源码、构建附件或公开仓库。后续并行版更新须保持 `.next` 包名和该签名。

若已有同运行时的源码构建 APK，可使用 CI 的 `parallel-download-kit`，通过 `tools/apk_download_kit.py reconstruct` 复用其中逐段校验过的压缩运行时文件。重建结果必须与完整并行 APK 的 SHA-256 完全相同；该步骤只减少传输量，不修改 APK。相应源码可用固定提交的 `git archive --format=tar.gz` 取得，并核对 `build-info.json` 中的源码哈希；完整源码同时保留在完整构建附件中。

并行版公开证书指纹固定在 `upstream-source/tools/parallel-release-policy.json`：`c3537a4bbf12e671868127ef3267c4806ffabed83d62208d94085ae4fe12b207`。本机私钥保存在应用私有的 `.codex/signing/codex-cn-api-next/`，没有提交或上传。在卸载存放该私钥的旧应用之前，必须将它安全备份到用户控制的私有存储；公开证书和 APK 无法恢复私钥。

## 从 V5 迁移

1. 保留 V5 已安装状态。在 V5 中导出需要的项目文件，在 Codex CN API 中通过项目导入入口预览并导入。
2. Android 的文件夹授权不能自动跨应用继承；在新应用中为导入项目重新选择对应文件夹。旧应用私有目录中的文件须先通过系统文件选择器复制到可访问目录。
3. 在新应用设置中重新填写 API 服务商名称、地址、模型及密钥。两应用分别使用自身的 Android Keystore，不复制旧密文或令牌，也不把明文密钥写入迁移文件。
4. 全局设置按需重新配置。项目导出不包含完整聊天历史；旧聊天继续留在 V5 中查阅。本轮不声称聊天或设置已自动迁移。
5. 验证新应用启动、项目访问、API 推理、工具调用和停止/恢复后，再决定后续数据处理。保留 V5 与新签名密钥备份。

本方案创建独立安装，不改变 V5 的签名、数据或权限，不需要卸载旧应用。仓库 Release 中的 V5 APK 也不是并行版后续升级包；使用同包名同签名的新并行版 APK 更新。
