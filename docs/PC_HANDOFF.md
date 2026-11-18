# 电脑接手提示词

下面这段可以直接交给电脑版 Codex：

> 继续开发 `caizhiyuan72/mobile-codex-zh` 的 `ui-polish-cn9` 分支，Android 工程在 `upstream-source/`。先读本文件并核对当前分支和 GitHub Actions 检查。用户的首要问题是切屏、熄屏后回到 App 总要重连模型。目标是让原任务在后台继续，而不是亮屏后重新发送提示词。聊天以模型最终答复收尾，同轮过程可折叠。保留通知、流式渲染及子代理计数。请直接做实现和验证。
>
> 1. 用户本轮要求推迟编译 APK。等用户要求统一构建时，再按现有工作流准备运行时和工具，跑 Android 单测、lint，并产出测试 APK。不要更换包名、签名、服务商、模型或服务档位。除非明确要求，不发布 Release。
> 2. 有 Android 真机时，使用同一条持续输出的任务，分别做保持前台、切到其他 App、熄屏 1 分钟和 10 分钟的对照；另测断网再联网及系统回收进程。不记录密钥、聊天正文或原始 HTTP 响应。分别记录：收到响应流的时间、任务完成时间、解锁时间、运行时是否重启、是否重复发起 turn。确认正常切屏不会重建引擎；进程丢失能自动连回原会话，未知结果不会当成成功或自动重发。手动停止运行时后不能自动启动。
> 3. 验证聊天里的“本轮已启动子代理”和“运行中”取自真实协议事件。检查并行、完成、重复事件、会话切换和亮屏恢复；不要把配置上限当成实际数量。区分本机进程退出与远端流重试。
> 4. 性能对比必须用相同模型、输入、服务档位和网络。分别报告首字、持续输出和完成延迟，区分协议、渲染及供应商耗时。标明真机测到的结果与尚未验证项；不要承诺永不断线或已经达到原生速度。

上次签名 APK 对应 `55cf251`，不含下述聊天和 Ultra 改动。在线首字、整轮耗时以及真机验收缺口见 [后台与速度实测](benchmarks/background-2026-11-18.md)。

## 手机端已验证

- `cd upstream-source && node --test --test-concurrency=2 tests/*.test.cjs`：277 项通过。
- `cd upstream-source && python3 tests/check_ultra_wire.py` 用手机内置 0.162.1 与回环模拟服务对照。在 `gpt-6.2-sol` 和 `gpt-6.2-astra` 上，`low` 和 `max` 保持原档，`ultra` 的主模型请求从 `medium` 变为 `max`。开启多代理 v2 后，主动分工指令、工具列表和开发者提示词均已与修复前对照。真实服务商内部采用的算力未知。
- `python3 tools/measure_runtime_stream.py`：手机自带 Codex 0.162.1 在本机回环假服务上交替测 6 组。最后一个 SSE 事件发出到客户端报告完成，中位数 `codex exec` 8.6 ms、`app-server` 10.4 ms。未测在线模型吞吐、APK 端到端延迟或锁屏速度。
- 手机没有 Java。上一版 `e038c45` 已通过 GitHub Actions 的 Android 单测、lint 和 APK 构建。手机上的独立 Codex 进程在模拟服务商静默 19 秒期间回答了 3 次本地健康查询，原任务随后完成，服务商只收到 1 个请求。新版 APK 的 1 分钟和 10 分钟真机锁屏对照仍待完成。

## 代码入口

- `Engine.java` 和 `EngineService.java` 在任务进行期间每 5 分钟续订 15 分钟的 CPU 唤醒锁，最后一轮结束后释放。系统重建前台服务或引擎意外退出时，后台只对仍有任务且服务商配置匹配的运行时尝试恢复一次。原任务的结束状态未知时保留提示，避免重复执行工具。
- `AppServerWatchdog.java` 每 15 秒检查本地引擎。连续 3 次只读探测超时才恢复，任意协议消息重置计数，等待审批期间暂停判定。`TurnWifiLease.java` 在默认网络为 Wi-Fi 且有任务时申请保持连接，Android 14 起使用系统网络请求，任务结束时释放。
- `TurnAgents.java`、`app.js`：每轮子代理去重、运行状态、聊天计数。`TurnProgress.java` 仅处理公开的进展事件和推理摘要，界面分别显示任务进展和本机引擎上次回应的时间。模型给出最终答复后同轮过程消息可折叠，App 不再另写任务汇总。
- `EngineRuntimeRecoveryTest.java`、`EngineTurnCompletionTest.java`、`tests/api-only-ui.test.cjs`、`tests/stream-render.test.cjs`：相关回归。两组本地测量脚本在 `upstream-source/tools/measure_*`。
