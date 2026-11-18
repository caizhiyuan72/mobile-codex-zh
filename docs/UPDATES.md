# 更新与构建产物

当前分支源码版本为 `0.3.9-cn.9`、versionCode `80`，并行 API 版应用 ID 为 `dev.mobilecodex.app.zhcnv3.next`。原生更新源默认使用 `caizhiyuan72/mobile-codex-zh`，支持 `cn.N` 版本比较。

现有安装的更新源不会因本地源码修改而自动改变。V5 可以在“设置 → 更新”中手动填写仓库名称。

根 `build-android.yml` 生成未签名构建验证产物，并附上源码与哈希。配置原 API 版密钥 Secret 后，受信任的 push 或手动构建还会生成独立的已签名附件，见[自动签名说明](API_SIGNING.md)；PR 不签名，Secret 缺失时仍只输出 unsigned。该流程不创建 GitHub Release。未经签名的 APK 不能直接安装，也不能覆盖现有应用。

准备可安装更新时，需要：

1. 完成 Android 构建、单元测试、lint 和真机验证。
2. 为目标应用沿用其现有签名私钥，保持相同应用 ID，版本号递增。API 并行版使用自己的固定证书，不是 V5 本体的签名。
3. 从签名后的实际 APK 提取包名、版本、ABI、大小和 SHA-256，再生成更新信息。
4. 将 APK 和对应源码关联到同一 Git 提交后发布。

旧 `patches/build_codex_cn_v*.py` 与工程里的上游发布脚本是历史参考；后者的身份规则针对原上游，尚未作为本 fork 的签名发布流程接通。不要把它的测试通过当成已发布新版。
