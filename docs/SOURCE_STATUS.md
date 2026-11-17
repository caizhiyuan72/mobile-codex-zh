# Source availability and limitations

The APK has been programmatically patched from an earlier modified signed APK; the original project is available at https://github.com/nokryong/mobile-codex/tree/v0.3.9 under GPL-3.0.

The `patches/` directory includes locally recovered web UI sources and builder scripts, but some earlier V2/V3 native modifications are not fully represented in a source-level, reproducible Android project. **Do not claim this repository contains complete corresponding source or a reproducible from-source build.**

Before publicly distributing the modified APK, integrate and provide the corresponding source for all modifications, plus the necessary build/install scripts and license notices. Never commit the Android signing private key. Ensure the app's license notice is corrected to match the upstream license.

This kit is preparation material, not evidence of a completed GitHub upload or GPL-compliant public release.