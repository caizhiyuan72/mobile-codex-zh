# 电脑接手提示词

下面这段可以直接交给电脑版 Codex：

> 继续开发 `caizhiyuan72/mobile-codex-zh` 的 `ui-polish-cn9` 分支，Android 工程在 `upstream-source/`。先读本文件并核对当前分支和 GitHub Actions 检查。用户的首要问题是切屏、熄屏后回到 App 总要重连模型。目标是让原任务在后台继续，而不是亮屏后重新发送提示词。保留本分支已有的任务汇总、通知、流式渲染及子代理计数。请直接做实现和验证。
>
> 1. 依照仓库现有工作流准备运行时和构建工具，跑 Android 单测、lint，并产出可供测试的 APK。不要更换包名、签名、服务商、模型或服务档位。除非明确要求，不发布 Release。
> 2. 有 Android 真机时，使用同一条持续输出的任务，分别做保持前台、切到其他 App、熄屏 1 分钟和 10 分钟的对照；另测断网再联网及系统回收进程。不记录密钥、聊天正文或原始 HTTP 响应。分别记录：收到响应流的时间、任务完成时间、解锁时间、运行时是否重启、是否重复发起 turn。确认正常切屏不会重建引擎；进程丢失能自动连回原会话，未知结果不会当成成功或自动重发。手动停止运行时后不能自动启动。
> 3. 验证聊天里的“本轮已启动子代理”和“运行中”取自真实协议事件。检查并行、完成、重复事件、会话切换和亮屏恢复；不要把配置上限当成实际数量。区分本机进程退出与远端流重试。
> 4. 性能对比必须用相同模型、输入、服务档位和网络。分别报告首字、持续输出和完成延迟，区分协议、渲染及供应商耗时。标明真机测到的结果与尚未验证项；不要承诺永不断线或已经达到原生速度。

## 手机端已验证

- `cd upstream-source && node --test --test-concurrency=2 tests/*.test.cjs`：275 项通过。
- `python3 tools/measure_runtime_stream.py`：手机自带 Codex 0.162.1 在本机回环假服务上交替测 6 组。最后一个 SSE 事件发出到客户端报告完成，中位数 `codex exec` 8.6 ms、`app-server` 10.4 ms。未测在线模型吞吐、APK 端到端延迟或锁屏速度。
- 该机没有 Java，Gradle 未运行，桌面先核验 Android 编译及原生回归。手机当前安装的 APK 不包含本分支新改动。

## 代码入口

- `Engine.java`、`EngineService.java`、`MainActivity.java`、`AndroidManifest.xml`：任务、前台服务、CPU 唤醒锁、恢复与断线状态。锁随任务获取，最后一轮结束释放；持续收到进度时续期，长时间完全静默会超时。
- `TurnAgents.java`、`app.js`：每轮子代理去重、运行状态、聊天计数。`TaskSummary.java` 是之前未提交的任务汇总实现。
- `EngineRuntimeRecoveryTest.java`、`EngineTurnCompletionTest.java`、`tests/api-only-ui.test.cjs`、`tests/stream-render.test.cjs`：相关回归。两组本地测量脚本在 `upstream-source/tools/measure_*`。
