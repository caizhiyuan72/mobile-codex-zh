# API 版固定密钥自动签名

API 版使用包名 `dev.mobilecodex.app.zhcnv3.next`。后续更新必须沿用当前已安装 API 版的签名私钥；该私钥保存在旧 V5 中，但不是 V5 本体的原签名私钥。

固定证书 SHA-256 为：

```text
c3537a4bbf12e671868127ef3267c4806ffabed83d62208d94085ae4fe12b207
```

此值由 [`parallel-release-policy.json`](../upstream-source/tools/parallel-release-policy.json) 固定。不得使用原上游发布证书，也不得因签名材料缺失而生成替代密钥，否则已安装 API 版无法正常覆盖升级。

## 一次性配置

在仓库的 GitHub Actions Secrets 中配置 `CODEX_CN_API_SIGNING_JSON`。Secret 的 JSON 结构如下，两个 Base64 字段分别来自已有的 PKCS#8 私钥文件和 DER 证书文件：

```json
{
  "schemaVersion": 1,
  "privateKeyPkcs8Base64": "<release-key.pk8 的 Base64>",
  "certificateDerBase64": "<release-cert.der 的 Base64>"
}
```

从能合法访问现有密钥的旧 V5 执行环境完成一次性导入；原文件位于应用私有目录 `files/.codex/signing/codex-cn-api-next/`。当前 API 应用无法读取旧 V5 私有目录，不能通过仓库源码或 APK 恢复该私钥。上传前须确认 DER 证书哈希与上面的固定值一致。

CI 的 `api-signing-setup` 附件提供只含公开助手和固定依赖的交接 ZIP，操作见[一次性导入工具](../signing-setup/README.md)。工具验证现有私钥和证书匹配，先生成并验证加密备份，再加密上传 Secret。它不包含真实私钥，不会自动签当前下载目录中的旧构建；配置成功后重新运行目标提交的 CI。

Secret 的值只能通过受保护的 Secrets 配置或加密上传接口传入。不要把 JSON、私钥、临时证书或密码写入仓库、聊天、命令行参数、日志、构建缓存或公开附件。配置成功后，后续 CI 从该 Secret 获取签名材料，无需每次返回旧 V5 找私钥。

## 构建与交付

根 [`build-android.yml`](../.github/workflows/build-android.yml) 保留原有 unsigned 构建和 `parallel-download-kit`。配置 Secret 后，受信任的 push 或手动构建在检查通过后额外输出 `codex-cn-api-signed-<完整提交 SHA>` 附件；PR 构建不签名。Secret 未配置时仍只输出 unsigned 构建，不创建新密钥。

[`sign_api_apk.py`](../upstream-source/tools/sign_api_apk.py) 核对并行版构建清单、APK 身份和固定证书，再使用 SDK apksigner 签名。它还验证实际签名证书、ZIP 对齐及签名前后的 APK 内容。签名材料仅写入权限为 `0600` 的临时文件，处理结束后清理。

签名附件单独包含 APK、对应源码、`build-info.json` 和 `SHA256SUMS`。清单中的 `signed` 为 `true`，`apkSha256` 是签名后文件的哈希，`unsignedApkSha256` 记录签名前的哈希。签名失败会使构建失败；不能把 unsigned 附件当作已签名交付。该流程不自动安装 APK，也不创建 GitHub Release。

## 恢复备份

同一私钥还应保留一份由用户控制的本地加密恢复备份，密码与备份分开保管。GitHub Secret 不是可下载的密钥备份；公开证书、APK 和源码也不能恢复私钥。

在卸载旧 V5、清除其数据或更换设备前，先完成加密备份并验证可恢复，恢复出的证书仍须与固定指纹一致。备份及其密码均不进入仓库或构建附件。若 Secret 不可用但仍有合法备份，可恢复同一密钥后重新配置；若私钥与备份均丢失，自动签名不能解决既有安装的升级签名问题。
