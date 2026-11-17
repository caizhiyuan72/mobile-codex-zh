# 语音输入 · API 版

本版已移除 Codex Live 实时语音对话、WebRTC、音色选择、通话后台服务和相应通知。没有为第三方 API 模拟实时语音能力。

保留的“系统听写”位于输入框“+”菜单。它使用 Android `SpeechRecognizer` 将语音转成草稿文字，与模型 API 协议无关。点击完成后等待最终识别结果；取消会丢弃本次结果。文字不会自动发送。

首次使用仍需 Android 麦克风权限。切到后台或锁屏会结束当前识别，回到界面不会自动恢复录音。识别服务可能联网，准确率、支持语言和离线能力取决于设备上的系统服务。界面语言用于请求相应识别语言。

浮动聊天使用 Android 独立识别界面。两种入口都沿用已有的结果回执：结果属于原对话和项目；保留识别期间用户编辑过的草稿；进程恢复不会重复追加识别文字。识别期间仍暂停新的手机自动化动作。

JavaScript 交互检查覆盖状态、取消、草稿与回执恢复。麦克风权限、实际识别、输入法、旋转、网络中断和浮动聊天返回仍需真机验证。

参考：[SpeechRecognizer](https://developer.android.com/reference/android/speech/SpeechRecognizer) · [RecognizerIntent](https://developer.android.com/reference/android/speech/RecognizerIntent)。
