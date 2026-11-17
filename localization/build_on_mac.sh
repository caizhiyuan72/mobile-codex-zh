#!/bin/sh
# Build a side-by-side Simplified Chinese debug variant of Mobile Codex 0.3.9.
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BUILD_PARENT=${1:-"$HOME/mobile-codex-zhcn-build"}
REPO="$BUILD_PARENT/mobile-codex"
mkdir -p "$BUILD_PARENT"
for cmd in git python3 node npm java; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$cmd" >&2
    exit 1
  fi
done
ANDROID_HOME=${ANDROID_HOME:-"$HOME/Library/Android/sdk"}
export ANDROID_HOME
if [ ! -d "$ANDROID_HOME/platforms/android-35" ] || [ ! -d "$ANDROID_HOME/ndk/28.2.13676358" ]; then
  printf 'Install Android SDK Platform 35 and NDK 28.2.13676358 first. ANDROID_HOME=%s\n' "$ANDROID_HOME" >&2
  exit 1
fi
if [ ! -d "$REPO/.git" ]; then
  git clone --branch v0.3.9 --depth 1 https://github.com/nokryong/mobile-codex.git "$REPO"
fi
if [ -f "$REPO/app/src/main/assets/translations-zh-CN.json" ]; then
  if ! grep -Fq "applicationIdSuffix '.zhcn'" "$REPO/app/build.gradle"; then
    printf 'Found another Chinese patch without the isolated debug package ID.\n' >&2
    exit 1
  fi
  printf 'Chinese patch already exists; skipping re-application.\n'
else
  python3 "$SCRIPT_DIR/apply_zhcn.py" "$REPO" --parallel
fi
cd "$REPO"
python3 tools/prepare_runtime.py
python3 -m pip install -r tools/requirements-devtools.txt
python3 tools/build_native.py --ndk "$ANDROID_HOME/ndk/28.2.13676358"
python3 tools/prepare_devtools.py
npm ci --ignore-scripts
npm test
./gradlew --no-daemon assembleDebug testDebugUnitTest lintDebug
mkdir -p "$BUILD_PARENT/output"
cp app/build/outputs/apk/debug/app-debug.apk "$BUILD_PARENT/output/Mobile-Codex-v0.3.9-zhCN-debug.apk"
printf '\nBuilt APK: %s\n' "$BUILD_PARENT/output/Mobile-Codex-v0.3.9-zhCN-debug.apk"
