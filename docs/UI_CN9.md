# cn.9 API 更新

目标版本 `0.3.9-cn.9` / versionCode `80`，继续使用 `dev.mobilecodex.app.zhcnv3.next`。现有 Gradle `parallel` 目标对应已安装的 Codex CN API，不创建其他安装身份。

- 输入区同一位置空闲时显示发送，运行时显示红色停止；Ctrl/Cmd+Enter 保留追加指令，失败保留草稿。
- 阅读旧消息时保持可见消息偏移；流式消息、完整快照和任务完成均不主动拉回底部。返回最新消息按钮在任务完成后出现，淡入不会改变水平位置。
- 聊天插图改为真实运行事件的简短活动和可展开输出；推理正文不进入活动记录。后台会话与未知子线程的活动不进入当前会话。
- 完成通知仅接受已跟踪且 ID 相符的整轮结束事件；停止、失败使用对应状态；前台静默并清除历史任务通知，运行服务通知保留。前台状态放在进程内，避免进程重启后沿用过期偏好。
- 模型名称加大，推理滑块使用模型元数据支持的 low / medium / high / xhigh / max；缺失元数据的第三方模型沿用 low / medium / high 后备范围。

## 签名交接

CI 仅生成未签名材料。最终交付包必须是 `.next` / `80` 的 ARM64 非调试包，并核对 `build-info.json` 和 SHA-256。

现有 API 签名材料位于旧 V5 私有目录 `/data/data/dev.mobilecodex.app.zhcnv3/files/.codex/signing/codex-cn-api-next/`，包含 `release-key.pk8`、`release-cert.der` 和 `identity.json`。此目录属于旧 V5；新 API 应用不能访问不表示密钥丢失。它与 V5 原版签名不同。

将未签名 APK 交回旧 V5，用现有 API 密钥签名。不得重新生成密钥，不得把私钥上传 GitHub、构建附件或聊天。证书 SHA-256 应为 `c3537a4bbf12e671868127ef3267c4806ffabed83d62208d94085ae4fe12b207`。签名后使用 Google apksigner 验证证书，再覆盖安装已有 API 版。未经真机验证的行为不可宣称已验收。

## 验证进度

本机 `npm test` 268/268 通过；Python 工具测试运行 144 项，4 项按环境条件跳过，其余通过。新增 DOM 回归覆盖上方消息变化时保持当前阅读偏移、活动跟随条件和按钮/追加指令状态。Chromium 新增 320/360/412/768 宽度与明暗主题下的操作位置、滑块和完成滚动检查。

Android 单元测试、lint、实际 Chromium 和 APK 身份以本次 CI 结果为准；本机没有 JDK/SDK，尚未真机验收新版。
