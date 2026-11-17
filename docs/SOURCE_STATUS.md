# Source restoration status — 2026-11-17

## Completed and verified

- The complete *unmodified upstream* Mobile Codex v0.3.9 source is now vendored under [`upstream-source/`](../upstream-source/).
- Its Git commit is pinned to `b6c12eb65fd29a38b0c2825bf12a7aca64736c5a`. The restoration workflow verifies this commit before importing it.
- The GitHub Actions [restore workflow](../.github/workflows/restore-upstream.yml) succeeded.
- The GitHub Actions [verification workflow](../.github/workflows/verify-upstream.yml) succeeded, including upstream `npm test`.
- The upstream source retains its GPL-3.0 license and third-party notices.
- Recovered **partial** V5 modifications and release metadata are under [`patches/`](../patches/).

## Still missing — do not mislabel V5 as a reproducible source build

The current V5 APK was made by binary patching an earlier Android APK. **The Android-native changes introduced in earlier V2/V3 builds have not all been reconstructed at the Java/Gradle source level.** Additionally, this repository currently does not include all exact V5 generated WebView script/style files or an end-to-end from-source V5 build that matches the existing APK.

The green upstream tests verify the restored **original** version, **not** that V5 Max reasoning, API-provider compatibility, native subagents, or in-place updating are working.

## Work required before shipping V5 from source

1. Restore the modified WebView assets and the missing Android-native modifications against the pinned original source.
2. Update the Android application ID to `dev.mobilecodex.app.zhcnv3`, versionCode to `76` or higher (strictly increasing for future updates), and maintain the previous signing certificate.
3. Run a complete Android build, unit tests, compatibility checks, and **real on-device in-place upgrade tests with existing settings**.
4. Fulfil GPL-3.0 Corresponding Source obligations prior to public distribution. The source archive must include build/install scripts and the complete modifications.
5. Keep the signing **private** key and all API credentials outside the public repository. The original signing certificate alone cannot sign new builds.

This is a trustworthy restoration milestone, **not a finished V5 source release**.