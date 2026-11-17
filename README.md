# Codex CN

Community-made, unofficial Android modification of [Mobile Codex v0.3.9](https://github.com/nokryong/mobile-codex/tree/v0.3.9).

## Latest prepared build

- Release tag: `v0.3.9-cn.5`
- Display name: **Codex CN**
- Android package ID: `dev.mobilecodex.app.zhcnv3`
- Android versionCode: **76**
- ARM64 installation file: `Codex-CN-V5-arm64.apk`

V5 adds a complete reasoning-effort selector and a user interface for native Codex subagent settings. Availability of `max` or spawning actual subagents depends on the selected model, API provider, and installed Codex runtime. The APK was not validated on a physical Android device.

## Downloads

The APK belongs in **GitHub Releases**, not the Git commit history. Check its SHA-256 against the `SHA256SUMS` file.

## In-app updates

In the installed app, open **Settings > Updates** and set repository to `caizhiyuan72/mobile-codex-zh`, then choose **Check for updates**.

For safe in-place upgrades, keep the Android package ID and signing certificate unchanged, increment `versionCode`, and **never** uninstall the previous app. An APK from another signing certificate cannot overwrite the installed one.

## Security

Never publish API keys, Android signing private keys, `*.pem`, `*.jks`, or private configuration. A secret previously sent in a chat should be revoked and replaced with a new one.

## Source & license

The upstream `v0.3.9` repository uses **GPL-3.0**, not Apache-2.0. See `LICENSE` and `docs/SOURCE_STATUS.md`. The modified APK must be accompanied by the legally required Corresponding Source if it is publicly distributed. The files in `patches/` are extracted modifications/build scripts, **not** a verified complete reproducible Android source project.

This is **not an official OpenAI or Mobile Codex release**.