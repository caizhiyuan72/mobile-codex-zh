# Publishing guide

This repository currently contains preliminary metadata and partial V5 modifications. **There is no published V5 Release yet.** The APK is not stored in Git history.

1. Restore and verify all modified Android sources against upstream GPL-3.0 v0.3.9, including native code and build instructions.
2. Remove credentials and all signing private keys from source and artifacts.
3. Preserve Android application ID `dev.mobilecodex.app.zhcnv3` and the installed signing identity for upgrades. Increase versionCode for each subsequent release.
4. Verify the APK SHA-256 in `SHA256SUMS` and test in-place upgrade with existing data on an Android phone.
5. Create a GitHub Release tagged `v0.3.9-cn.5` and attach the APK and checksum, once corresponding source and license obligations are fulfilled.

GitHub Releases can then be used by the in-app Update settings with the repository `caizhiyuan72/mobile-codex-zh`. Never uninstall an installed version to update unless the user has independently backed up and validated configuration recovery.
