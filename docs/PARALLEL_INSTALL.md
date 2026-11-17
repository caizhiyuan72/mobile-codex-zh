# 并行迁移版

找不到 V5 原签名时，按 [安全迁移方案](SAFE_V5_MIGRATION.md) 保留 V5，安装独立的 API 版。该版本的应用名称为 **Codex CN API**，包名为 `dev.mobilecodex.app.zhcnv3.next`；旧 V5 仍为 `dev.mobilecodex.app.zhcnv3`。

## 构建与签名

```sh
cd upstream-source
bash gradlew testParallelUnitTest lintParallel assembleParallel
```

运行前须按工程说明准备 ARM64 runtime/devtools。根 CI 在原包名的 Debug/Release 检查通过后，执行并行版单元测试、lint 和打包；附上对应提交的源码、身份、哈希，以及由 Google Android SDK build-tools 35.0.0 转换的 Android 可执行 apksigner。

CI 产物仍未签名。下载后使用单独、长期保存的本地签名密钥签名，并通过 apksigner 验证，再把最终 APK 交付用户。私钥不得进入源码、构建附件或公开仓库。后续并行版更新须保持 `.next` 包名和该签名。

并行版公开证书指纹固定在 `upstream-source/tools/parallel-release-policy.json`：`c3537a4bbf12e671868127ef3267c4806ffabed83d62208d94085ae4fe12b207`。本机私钥保存在应用私有的 `.codex/signing/codex-cn-api-next/`，没有提交或上传。在卸载存放该私钥的旧应用之前，必须将它安全备份到用户控制的私有存储；公开证书和 APK 无法恢复私钥。

## 从 V5 迁移

1. 保留 V5 已安装状态。在 V5 中导出需要的项目文件，在 Codex CN API 中通过项目导入入口预览并导入。
2. Android 的文件夹授权不能自动跨应用继承；在新应用中为导入项目重新选择对应文件夹。旧应用私有目录中的文件须先通过系统文件选择器复制到可访问目录。
3. 在新应用设置中重新填写 API 服务商名称、地址、模型及密钥。两应用分别使用自身的 Android Keystore，不复制旧密文或令牌，也不把明文密钥写入迁移文件。
4. 全局设置按需重新配置。项目导出不包含完整聊天历史；旧聊天继续留在 V5 中查阅。本轮不声称聊天或设置已自动迁移。
5. 验证新应用启动、项目访问、API 推理、工具调用和停止/恢复后，再决定后续数据处理。保留 V5 与新签名密钥备份。

本方案创建独立安装，不改变 V5 的签名、数据或权限，不需要卸载旧应用。仓库 Release 中的 V5 APK 也不是并行版后续升级包；使用同包名同签名的新并行版 APK 更新。
