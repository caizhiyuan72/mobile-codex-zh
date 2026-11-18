# 大肥龙独立安装版

应用名为“大肥龙”，包名 `dev.mobilecodex.app.zhcnv3.fresh`，源码版本 `0.3.9-cn.9` / `80`。它是用户要求的新 APP，使用单独的新密钥签名，可与 V5 和 Codex CN API 同时安装，无需旧版私钥。

构建目标为 `testFreshUnitTest lintFresh assembleFresh`。CI 核对实际 APK 名称、包名、版本、ARM64、minSdk 29、非调试配置、ZIP 对齐及全部 Web 资源，提供 unsigned 构建附件和经过实际重建验证的下载套件。附件名为 `dafeilong-fresh-build-<commit>` 和 `dafeilong-fresh-download-kit-<commit>`。安装前需完成新签名并核对签名与内容；unsigned 文件不能安装。

首次启动需要重新设置服务商和 API 密钥、授权项目文件夹。应用数据按包名隔离，旧对话仍在旧版中。后续“大肥龙”更新应沿用其新签名密钥；旧 API 版的固定证书只适用于 `.next`，不适用于此独立应用。
