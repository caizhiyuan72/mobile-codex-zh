#!/usr/bin/env python3
"""Sign a verified Android bundle with the selected edition's pinned key."""
import argparse
import base64
import binascii
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import zipfile

SECRET_NAME = 'CODEX_CN_API_SIGNING_JSON'
VARIANT = 'parallel'
POLICY = json.loads(Path(__file__).with_name('parallel-release-policy.json').read_text())
EXPECTED_CERT_SHA256 = POLICY['signingCertificateSha256'][0]
MAX_CREDENTIAL_BYTES = 64 * 1024
MAX_APK_BYTES = 512 * 1024 * 1024


class SigningError(RuntimeError):
    pass


def configure_edition(edition):
    global SECRET_NAME, VARIANT, POLICY, EXPECTED_CERT_SHA256
    if edition not in ('api', 'fresh'):
        raise SigningError('Unknown signing edition.')
    VARIANT = 'fresh' if edition == 'fresh' else 'parallel'
    SECRET_NAME = 'DAFEILONG_SIGNING_JSON' if edition == 'fresh' else 'CODEX_CN_API_SIGNING_JSON'
    policy_file = 'fresh-release-policy.json' if edition == 'fresh' else 'parallel-release-policy.json'
    POLICY = json.loads(Path(__file__).with_name(policy_file).read_text())
    EXPECTED_CERT_SHA256 = POLICY['signingCertificateSha256'][0]


def strict_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate JSON key')
        result[key] = value
    return result


def file_hash(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def read_credentials(raw):
    if not raw:
        raise SigningError('Configure ' + SECRET_NAME + ' with this edition\'s signing key.')
    try:
        if len(raw) > 2 * ((MAX_CREDENTIAL_BYTES + 2) // 3 * 4) + 1024:
            raise ValueError()
        data = json.loads(raw, object_pairs_hook=strict_object)
        if (not isinstance(data, dict) or type(data.get('schemaVersion')) is not int
                or data['schemaVersion'] != 1 or set(data) != {
                    'schemaVersion', 'privateKeyPkcs8Base64', 'certificateDerBase64'}):
            raise ValueError()
        decoded = []
        for field in ('privateKeyPkcs8Base64', 'certificateDerBase64'):
            value = data[field]
            if not isinstance(value, str) or not value or len(value) > (MAX_CREDENTIAL_BYTES + 2) // 3 * 4:
                raise ValueError()
            content = base64.b64decode(value, validate=True)
            if not 0 < len(content) <= MAX_CREDENTIAL_BYTES:
                raise ValueError()
            decoded.append(content)
    except (ValueError, TypeError, binascii.Error):
        raise SigningError('Invalid API signing secret schema or base64 data.') from None
    if hashlib.sha256(decoded[1]).hexdigest() != EXPECTED_CERT_SHA256:
        raise SigningError('API signing certificate differs from the pinned existing installation certificate.')
    return tuple(decoded)


def checked_run(args, env):
    # Capture tool errors because their diagnostics may contain key material.
    try:
        return subprocess.run(args, env=env, check=True, capture_output=True, text=True).stdout
    except (OSError, subprocess.CalledProcessError):
        raise SigningError('API APK signing or verification failed; check the existing signing key.') from None


def verify_certificate(output):
    certificates = re.findall(r'Signer #\d+ certificate SHA-256 digest: ([0-9a-fA-F]{64})', output)
    if [digest.lower() for digest in certificates] != [EXPECTED_CERT_SHA256]:
        raise SigningError('Signed API APK does not use the pinned existing certificate.')


def bundle_file(bundle, name):
    if (not isinstance(name, str) or not name or name in ('.', '..')
            or '/' in name or '\\' in name or '\0' in name):
        raise SigningError('Invalid bundle filename in build-info.json.')
    path = bundle / name
    if path.is_symlink() or not path.is_file():
        raise SigningError('Required bundle file is missing or is a symlink.')
    return path


def validate_bundle(bundle):
    bundle = Path(bundle).resolve()
    manifest = bundle_file(bundle, 'build-info.json')
    try:
        if manifest.stat().st_size > 64 * 1024:
            raise ValueError()
        info = json.loads(manifest.read_text(), object_pairs_hook=strict_object)
        if (not isinstance(info, dict) or info.get('package') != POLICY['applicationId']
                or info.get('variant') != VARIANT or info.get('label') != POLICY['applicationLabel']
                or info.get('signed') is not False
                or type(info.get('versionCode')) is not int or info['versionCode'] < 1
                or not isinstance(info.get('versionName'), str)
                or not re.fullmatch(r'[0-9A-Za-z][0-9A-Za-z.+_-]{0,79}', info['versionName'])
                or not isinstance(info.get('commit'), str)
                or not re.fullmatch(r'[0-9a-f]{40}', info['commit'])
                or type(info.get('apkBytes')) is not int or not 0 < info['apkBytes'] <= MAX_APK_BYTES):
            raise ValueError()
        for field in ('apkSha256', 'sourceSha256'):
            if not isinstance(info.get(field), str) or not re.fullmatch(r'[0-9a-f]{64}', info[field]):
                raise ValueError()
        if info.get('apk') != f"mobile-codex-{info['versionName']}-{VARIANT}-arm64-unsigned.apk":
            raise ValueError()
        if info.get('source') != f"mobile-codex-{info['versionName']}-source.tar.gz":
            raise ValueError()
        apk = bundle_file(bundle, info['apk'])
        source = bundle_file(bundle, info['source'])
        if (apk.stat().st_size != info['apkBytes'] or file_hash(apk) != info['apkSha256']
                or file_hash(source) != info['sourceSha256']):
            raise ValueError()
        build_commit = os.environ.get('BUILD_COMMIT')
        if build_commit and build_commit != info['commit']:
            raise ValueError()
    except (ValueError, TypeError, KeyError, OSError, UnicodeError):
        raise SigningError('Invalid API unsigned bundle identity or checksum.') from None
    return info, apk, source


def verify_apk_identity(apk, info, build_tools, env):
    badging = checked_run([str(build_tools / 'aapt'), 'dump', 'badging', str(apk)], env)
    identity = re.search(r"package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'", badging)
    abis = re.search(r'^native-code: (.+)$', badging, re.M)
    sdk = re.search(r"^sdkVersion:'(\d+)'$", badging, re.M)
    if (not identity or (identity.group(1), int(identity.group(2)), identity.group(3)) != (
            info['package'], info['versionCode'], info['versionName'])
            or not abis or re.findall(r"'([^']+)'", abis.group(1)) != [POLICY['abi']]
            or not sdk or int(sdk.group(1)) != POLICY['minimumSdk']
            or f"application-label:'{POLICY['applicationLabel']}'" not in badging
            or re.search(r'^application-debuggable', badging, re.M)):
        raise SigningError('API APK identity differs from its manifest or release policy.')


def is_signature_member(name):
    upper = name.upper()
    if not upper.startswith('META-INF/') or '/' in upper[len('META-INF/'):]:
        return False
    return upper == 'META-INF/MANIFEST.MF' or upper.endswith(('.SF', '.RSA', '.DSA', '.EC')) or upper.startswith('META-INF/SIG-')


def payload_hashes(path):
    try:
        with zipfile.ZipFile(path) as archive:
            names = archive.namelist()
            if len(set(names)) != len(names):
                raise SigningError('APK contains duplicate ZIP members.')
            result = {}
            for name in names:
                if not is_signature_member(name):
                    with archive.open(name) as stream:
                        result[name] = hashlib.file_digest(stream, 'sha256').hexdigest()
            return result
    except (OSError, ValueError, zipfile.BadZipFile, RuntimeError):
        raise SigningError('Cannot verify APK ZIP member contents.') from None


def private_file(path, content):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(content)


def sign_bundle(bundle, build_tools, output, raw):
    private_key, certificate = read_credentials(raw)
    info, apk, source = validate_bundle(bundle)
    build_tools, output = Path(build_tools).resolve(), Path(output).resolve()
    if output.exists():
        raise SigningError('Refusing to replace an existing signed artifact folder.')
    if not output.parent.is_dir():
        raise SigningError('Signed artifact parent folder is missing.')
    env = dict(os.environ)
    for secret_name in ('CODEX_CN_API_SIGNING_JSON', 'DAFEILONG_SIGNING_JSON'):
        env.pop(secret_name, None)
    verify_apk_identity(apk, info, build_tools, env)
    payload = payload_hashes(apk)
    if file_hash(apk) != info['apkSha256']:
        raise SigningError('Unsigned APK changed after bundle verification.')
    with tempfile.TemporaryDirectory(prefix='codex-api-signing-', dir=os.environ.get('RUNNER_TEMP')) as key_directory:
        key_path, cert_path = Path(key_directory) / 'private.pk8', Path(key_directory) / 'certificate.der'
        private_file(key_path, private_key)
        private_file(cert_path, certificate)
        with tempfile.TemporaryDirectory(prefix='.api-signed-', dir=output.parent) as stage_directory:
            stage = Path(stage_directory)
            signed_name = f"mobile-codex-{info['versionName']}-{VARIANT}-arm64.apk"
            signed_apk = stage / signed_name
            signer = str(build_tools / 'apksigner')
            checked_run([signer, 'sign', '--key', str(key_path), '--cert', str(cert_path),
                         '--v4-signing-enabled', 'false', '--out', str(signed_apk), str(apk)], env)
            verify_certificate(checked_run([signer, 'verify', '--verbose', '--print-certs', str(signed_apk)], env))
            checked_run([str(build_tools / 'zipalign'), '-c', '-P', '16', '4', str(signed_apk)], env)
            verify_apk_identity(signed_apk, info, build_tools, env)
            if payload_hashes(signed_apk) != payload:
                raise SigningError('Signing changed the API APK payload members.')
            if file_hash(apk) != info['apkSha256']:
                raise SigningError('Unsigned APK changed during signing.')
            shutil.copyfile(source, stage / source.name)
            if file_hash(stage / source.name) != info['sourceSha256']:
                raise SigningError('Corresponding source changed during signing.')
            signed_info = {key: value for key, value in info.items() if key not in ('signer', 'signerSha256')}
            signed_info.update(apk=signed_name, apkBytes=signed_apk.stat().st_size, signed=True,
                               apkSha256=file_hash(signed_apk), unsignedApkSha256=info['apkSha256'],
                               signingCertificateSha256=EXPECTED_CERT_SHA256)
            (stage / 'build-info.json').write_text(json.dumps(signed_info, indent=2) + '\n')
            (stage / 'SHA256SUMS').write_text(signed_info['apkSha256'] + '  ' + signed_name + '\n'
                + info['sourceSha256'] + '  ' + source.name + '\n')
            stage.rename(output)
    print('API APK signed and verified with the existing pinned certificate: ' + EXPECTED_CERT_SHA256)
    return signed_info


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--edition', choices=('api', 'fresh'), default='api')
    parser.add_argument('--bundle', type=Path, required=True, help='Unsigned build artifact folder')
    parser.add_argument('--build-tools', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True, help='New signed artifact folder')
    args = parser.parse_args()
    configure_edition(args.edition)
    try:
        sign_bundle(args.bundle, args.build_tools, args.output, os.environ.get(SECRET_NAME, ''))
    except SigningError as error:
        parser.exit(1, str(error) + '\n')


if __name__ == '__main__':
    main()
