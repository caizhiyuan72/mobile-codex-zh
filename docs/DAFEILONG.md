# 大肥龙独立安装版

应用名为“大肥龙”，包名 `dev.mobilecodex.app.zhcnv3.fresh`，源码版本 `0.3.9-cn.11` / `82`。它使用独立签名，可与 V5 和 Codex CN API 同时安装，无需旧版私钥。`upstream-source/icon-pack/dafeilong/` 中的 `white-original.png` 用于桌面图标，`in-app-original.png` 用于首页、侧栏和悬浮窗头像。运行 `node upstream-source/tools/prepare_fresh_icon.mjs` 可重新生成这两套资源。通知小图标使用单色龙角轮廓。

在设置中添加多个 API 后，新聊天可从顶部 API 标签选择服务商。发送首条消息后，聊天记住所选服务商。返回历史聊天时，顶部显示该聊天的服务商。不同服务商的任务可以同时运行。

命令和文件修改记录按出现顺序保存在聊天中。命令紧跟助手文字，下一段回复开始时，前一组命令收成「运行了 N 条命令」，点开即可查看详情。旧记录在打开历史聊天时尝试从本地引擎的聊天记录恢复。推理滑块在拖动时保存所选档位。使用 `ultra` 时，本版内置引擎在模拟 Responses 请求中使用 `max` 强度。

构建目标为 `testFreshUnitTest lintFresh assembleFresh`。CI 核对实际 APK 名称、包名、版本、ARM64、minSdk 29、非调试配置、ZIP 对齐及全部 Web 资源，提供 unsigned 构建附件和经过实际重建验证的下载套件。附件名为 `dafeilong-fresh-build-<commit>` 和 `dafeilong-fresh-download-kit-<commit>`。unsigned 文件不能安装。

永久签名材料保存在仓库 Actions Secret `DAFEILONG_SIGNING_JSON`，结构与 API 版签名工具一致，但采用独立的 RSA 3072 位新密钥。公开证书固定在 `fresh-release-policy.json`，SHA-256 为 `ecfc26efdc5cb36beb7a8773f73c105c8fe72fc03e634399f46f7d462d567b94`。受信任的 push 或手动构建自动签名，输出可安装附件 `dafeilong-signed-<commit>`；PR 不读取密钥，不签名。构建只读取已有 Secret，不会每次生成新密钥。

后续制作“大肥龙”更新直接运行同一工作流，无需再寻找旧 V5 私钥。递增应用版本后，使用相同包名和已保存的新密钥升级。不要删除或覆盖该 Secret。GitHub Secret 不能下载原值，额外的加密恢复备份保存在生成密钥的应用私有存储，密码与备份分开保存；不要清除唯一备份。

首次启动需要重新设置服务商和 API 密钥、授权项目文件夹。应用数据按包名隔离，旧对话仍在旧版中。后续“大肥龙”更新应沿用其新签名密钥；旧 API 版的固定证书只适用于 `.next`，不适用于此独立应用。
