#!/usr/bin/env python3
"""Collect the independently installable edition and its exact source/recipe."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import zipfile
from apk_download_kit import make_kit, reconstruct

POLICY = json.loads(Path(__file__).with_name('fresh-release-policy.json').read_text())


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    original = json.loads(Path('../parallel-build-artifacts/build-info.json').read_text())
    if original['commit'] != os.environ['BUILD_COMMIT']:
        raise ValueError('Fresh source commit differs from the verified build')
    out = Path('../fresh-build-artifacts'); out.mkdir()
    name = f"mobile-codex-{original['versionName']}-fresh-arm64-unsigned.apk"
    apk = out / name
    candidates = list(Path('app/build/outputs/apk/fresh').glob('*.apk'))
    if len(candidates) != 1:
        raise ValueError('Expected exactly one fresh APK')
    shutil.copyfile(candidates[0], apk)
    tools = Path(os.environ['ANDROID_HOME']) / 'build-tools/35.0.0'
    badging = subprocess.check_output([str(tools / 'aapt'), 'dump', 'badging', str(apk)], text=True)
    identity = re.search(r"package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'", badging)
    package = POLICY['applicationId']
    label = POLICY['applicationLabel']
    if not identity or (identity.group(1), int(identity.group(2)), identity.group(3)) != (package, original['versionCode'], original['versionName']):
        raise ValueError('Unexpected fresh APK identity')
    if f"application-label:'{label}'" not in badging.splitlines():
        raise ValueError('Fresh app label must be 大肥龙')
    abis = re.search(r'^native-code: (.+)$', badging, re.M)
    if not abis or re.findall(r"'([^']+)'", abis.group(1)) != [POLICY['abi']]:
        raise ValueError('Fresh APK must contain only ARM64 libraries')
    if re.search(r'^application-debuggable', badging, re.M) or f"sdkVersion:'{POLICY['minimumSdk']}'" not in badging.splitlines():
        raise ValueError('Fresh APK must be non-debuggable with minSdk 29')
    subprocess.run([str(tools / 'zipalign'), '-c', '-P', '16', '4', str(apk)], check=True)
    with zipfile.ZipFile(apk) as archive:
        for asset in Path('app/src/main/assets/web').rglob('*'):
            if asset.is_file() and archive.read('assets/web/' + asset.relative_to('app/src/main/assets/web').as_posix()) != asset.read_bytes():
                raise ValueError('Fresh APK web asset differs from source: ' + asset.name)
    for filename in [original['source'], original['signer']]:
        shutil.copyfile(Path('../parallel-build-artifacts') / filename, out / filename)
    info = {**original, 'variant':'fresh', 'package':package, 'label':label,
            'apk':name, 'apkBytes':apk.stat().st_size, 'apkSha256':digest(apk), 'signed':False}
    (out / 'build-info.json').write_text(json.dumps(info, ensure_ascii=False, indent=2) + '\n')
    (out / 'SHA256SUMS').write_text(''.join(info[field] + '  ' + info[name] + '\n'
        for field, name in [('apkSha256','apk'), ('sourceSha256','source'), ('signerSha256','signer')]))
    kit = Path('../fresh-download-kit'); kit.mkdir()
    recipe = make_kit(apk, kit)
    restored = kit / '.verification.apk'
    reconstruct(Path('../parallel-build-artifacts') / original['apk'], kit, restored)
    restored.unlink()
    for filename in ['build-info.json', 'SHA256SUMS', info['signer']]:
        shutil.copyfile(out / filename, kit / filename)
    print('Verified 大肥龙 download kit:', recipe['skeletonBytes'], 'bytes of literal APK data')


if __name__ == '__main__':
    main()
