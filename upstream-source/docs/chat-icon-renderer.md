# 聊天图标资源

当前 Codex 聊天使用本地内置资源和用户选择的自定义角色包。旧的 ChatGPT 网页图标 renderer、远端图标缓存及网页咨询入口已退役。

32 张原始 PNG 保留在 `icon-pack/gptchan/`，由 `tests/chat-icons.sha256.json` 固定原画哈希。`assets/web/chat-icons/manifest.json` 将既有逻辑 PNG 路径映射到内置 WebP；`BuiltinIcons` 只服务允许的文件名，返回 `image/webp`。消息标签和自定义包的逻辑路径不变。

内置部署图从 1254×1254 缩至 384×384，以 Lanczos3、预乘透明度及线性 RGB 缩放，WebP 质量 88，透明通道质量 100。压缩不是原尺寸无损转换；原画仍可用于重新生成。部署资源总计 1,429,728 字节，原部署资源为 27,729,762 字节，减少 26,300,034 字节。最终 APK 大小需要实际构建确认。

生成器使用固定版本的纯 JavaScript/WASM 开发依赖，无需 Pillow 或本地编译器，这些依赖不会进入 APK：

```sh
npm ci --ignore-scripts
node tools/optimize_chat_icons.mjs
# 重新生成部署资源与其清单/哈希：
node tools/optimize_chat_icons.mjs --generate
```

保留 `python3 tools/optimize_chat_icons.py` 作为兼容入口。校验检查全部原画、部署资源哈希、尺寸、解码后的像素哈希，以及缩放后每个像素的透明度未被编码改变。前端还检查图标资源的 2 MB 预算。

## 来源记录

图标词汇与分类别名沿用 [`nokryong/ChatGPT-DCCon-Renderer-Optimized`](https://github.com/nokryong/ChatGPT-DCCon-Renderer-Optimized)，原记录固定提交为 `98e9aee413c2ff6a91531f46f4a92da008b19a95`；原画来源记录为 Firebase Storage bucket `mytaskmanager-cf059.appspot.com`。这里记录来源，不为上游未提供许可证的部分自行指定新许可证；项目既有声明保留。
