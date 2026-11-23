# 一次性导入现有 API 签名密钥

本工具只在旧 V5 中执行。它使用旧 V5 已有的 `.codex/signing/codex-cn-api-next/` 私钥，不生成替代密钥。运行前确认该 V5 中的 GitHub 已连接到 `caizhiyuan72`，并授予执行工具所需的文件夹访问。

下载并解压受信任构建的 `api-signing-setup.zip`，在旧 V5 的执行环境运行：

```sh
python3 /storage/emulated/0/Download/Codex-CN-API-cn.9-signing/api-signing-setup/setup_api_signing.py
```

如解压到其他位置，请替换脚本路径。脚本先校验内置依赖，再将执行助手复制到旧 V5 私有目录；无需在手机安装 npm 依赖。`--self-test` 只验证加密和依赖，不访问真实私钥。源码开发时先在此目录运行 `npm ci --ignore-scripts`。

正常执行会核对固定证书、核对私钥与证书匹配，创建并解密校验 AES-256-GCM/scrypt 恢复备份，以 GitHub 公钥 sealed box 加密上传 `CODEX_CN_API_SIGNING_JSON`，并检查 Secret 元数据。可重跑，原私钥、密码和可恢复的现有备份不会被替换。GitHub 拒绝请求时保留原密钥和备份并报出 HTTP 状态。

下载交接目录会增加加密备份和非敏感配置回执。恢复密码只保存在旧 V5 私有的 `.codex/signing/codex-cn-api-next/api-signing-recovery-password.txt`。请在旧 V5 中将密码保存到自己的密码管理器，和加密备份分开保管；不要粘贴到聊天或提交 GitHub。卸载旧 V5 前必须完成此步骤。

工具仅配置自动签名，不安装 APK、不发布 Release。完成后重新运行 GitHub 的 `Build API edition from source`，下载 `codex-cn-api-signed-<commit>`，核对其 `signed: true` 和固定证书。不要安装带 `unsigned` 的文件。当前应用无权读取旧 V5 的私有目录，必须在旧 V5 完成这一次导入。
