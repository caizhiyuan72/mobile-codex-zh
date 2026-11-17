# Update channel setup

1. Publish a **public** GitHub Release with a version tag and ARM64 APK asset under `caizhiyuan72/mobile-codex-zh`.
2. In Codex CN, open **Settings > Updates**, enter the repository name exactly as above, and save/check for updates.
3. For future versions, increase Android `versionCode` above 76, keep package ID `dev.mobilecodex.app.zhcnv3`, and use the *same signing key* as the user's currently installed APK.
4. Never uninstall the existing app to update. Back up configuration separately before major upgrades; Android Keystore-protected API keys may be non-exportable.
5. Signing private keys and API keys must stay out of this public repository and release attachments.

The current application's updater defaults to `nokryong/mobile-codex` until reconfigured. This preparation kit does not change that setting on an installed phone.