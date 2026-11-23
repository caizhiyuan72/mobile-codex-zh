import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location('api_signing', Path(__file__).parents[1] / 'tools/sign_api_apk.py')
signing = importlib.util.module_from_spec(spec)
spec.loader.exec_module(signing)


class ApiSigningTests(unittest.TestCase):
    certificate = b'fixture-der-certificate'
    private_key = b'fixture-private-key'

    def secret(self, **changes):
        data = dict(schemaVersion=1, privateKeyPkcs8Base64=base64.b64encode(self.private_key).decode(),
                    certificateDerBase64=base64.b64encode(self.certificate).decode())
        data.update(changes)
        return json.dumps(data)

    def certificate_pin(self):
        return patch.object(signing, 'EXPECTED_CERT_SHA256', hashlib.sha256(self.certificate).hexdigest())

    def test_fresh_signing_requires_its_own_package_bundle_and_certificate(self):
        api_pin = signing.EXPECTED_CERT_SHA256
        with tempfile.TemporaryDirectory() as directory:
            bundle, info = self.make_bundle(Path(directory))
            try:
                signing.configure_edition('fresh')
                self.assertEqual(signing.SECRET_NAME, 'DAFEILONG_SIGNING_JSON')
                self.assertNotEqual(signing.EXPECTED_CERT_SHA256, api_pin)
                with self.assertRaises(signing.SigningError):
                    signing.verify_certificate('Signer #1 certificate SHA-256 digest: ' + api_pin)
                with self.assertRaises(signing.SigningError):
                    signing.validate_bundle(bundle)

                apk = bundle / info['apk']
                fresh_apk = apk.with_name(apk.name.replace('-parallel-', '-fresh-'))
                apk.rename(fresh_apk)
                info.update(package='dev.mobilecodex.app.zhcnv3.fresh', label='大肥龙',
                            variant='fresh', apk=fresh_apk.name)
                (bundle / 'build-info.json').write_text(json.dumps(info))
                self.assertEqual(signing.validate_bundle(bundle)[1], fresh_apk.resolve())

                signing.configure_edition('api')
                with self.assertRaises(signing.SigningError):
                    signing.validate_bundle(bundle)
            finally:
                signing.configure_edition('api')

    def test_credentials_require_strict_schema_limited_base64_and_existing_certificate(self):
        with self.certificate_pin():
            self.assertEqual(signing.read_credentials(self.secret()), (self.private_key, self.certificate))
            invalid = ['', '{}', '[]', 'null', 'not-json', self.secret(schemaVersion=True),
                       self.secret(schemaVersion=2), self.secret(extra='unexpected'),
                       self.secret(privateKeyPkcs8Base64='YQ==\n'), self.secret(privateKeyPkcs8Base64='%%%'),
                       self.secret(privateKeyPkcs8Base64=''), self.secret(certificateDerBase64=None),
                       self.secret(privateKeyPkcs8Base64=base64.b64encode(b'x' * 65537).decode()),
                       self.secret(certificateDerBase64=base64.b64encode(b'another-certificate').decode()),
                       self.secret()[:-1] + ', "schemaVersion":1}']
            for raw in invalid:
                with self.subTest(raw=raw[:70]), self.assertRaises(signing.SigningError):
                    signing.read_credentials(raw)

    def make_bundle(self, root):
        bundle = root / 'unsigned'; bundle.mkdir()
        apk = bundle / 'mobile-codex-0.3.9-cn.9-parallel-arm64-unsigned.apk'
        with zipfile.ZipFile(apk, 'w') as archive:
            archive.writestr('AndroidManifest.xml', b'fixture-manifest')
            archive.writestr('assets/web/main.js', b'fixture-web-payload')
            archive.writestr('META-INF/service.config', b'non-signature-metadata')
        source = bundle / 'mobile-codex-0.3.9-cn.9-source.tar.gz'; source.write_bytes(b'fixture-source')
        info = dict(commit='a' * 40, versionName='0.3.9-cn.9', versionCode=80,
                    package=signing.POLICY['applicationId'], variant='parallel', label=signing.POLICY['applicationLabel'],
                    apk=apk.name, apkBytes=apk.stat().st_size, apkSha256=signing.file_hash(apk), signed=False,
                    source=source.name, sourceSha256=signing.file_hash(source),
                    signer='apksigner-android.jar', signerSha256='b' * 64)
        (bundle / 'build-info.json').write_text(json.dumps(info))
        return bundle, info

    def test_bundle_rejects_wrong_package_variant_hash_source_commit_and_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); bundle, original = self.make_bundle(root)
            signing.validate_bundle(bundle)
            for changes in [dict(package='dev.mobilecodex.app.zhcnv3'), dict(variant='release'), dict(signed=True),
                            dict(apkSha256='0' * 64), dict(sourceSha256='0' * 64), dict(apkBytes=True),
                            dict(versionCode=False), dict(versionName='../version'), dict(source='../source.tar.gz'),
                            dict(commit='untrusted')]:
                (bundle / 'build-info.json').write_text(json.dumps({**original, **changes}))
                with self.subTest(changes=changes), self.assertRaises(signing.SigningError):
                    signing.validate_bundle(bundle)
            (bundle / 'build-info.json').write_text(json.dumps(original))
            with patch.dict(os.environ, {'BUILD_COMMIT': 'b' * 40}), self.assertRaises(signing.SigningError):
                signing.validate_bundle(bundle)

    def run_signing(self, failure=None):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); bundle, info = self.make_bundle(root)
            output = root / 'signed'; key_files = []; original_apk = (bundle / info['apk']).read_bytes()
            def run(args, env):
                self.assertNotIn(signing.SECRET_NAME, env)
                self.assertNotIn(base64.b64encode(self.private_key).decode(), args)
                if args[1] == 'sign':
                    for flag, expected in [('--key', self.private_key), ('--cert', self.certificate)]:
                        path = Path(args[args.index(flag) + 1]); key_files.append(path)
                        self.assertEqual(path.read_bytes(), expected)
                        if os.name != 'nt': self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                    if failure == 'tool': raise signing.SigningError('fixture-tool-failed')
                    target = Path(args[args.index('--out') + 1]); target.write_bytes(original_apk)
                    with zipfile.ZipFile(target, 'a') as archive:
                        archive.writestr('META-INF/SIGNER.SF', b'fixture-signature')
                        if failure == 'payload': archive.writestr('assets/injected.js', b'bad-payload')
                    return ''
                if args[1] == 'verify':
                    digest = '0' * 64 if failure == 'certificate' else signing.EXPECTED_CERT_SHA256
                    return 'Verified\nSigner #1 certificate SHA-256 digest: ' + digest
                if args[1] == 'dump':
                    package = 'wrong.package' if failure == 'package' else info['package']
                    return (f"package: name='{package}' versionCode='80' versionName='0.3.9-cn.9'\n"
                            "sdkVersion:'29'\napplication-label:'Codex CN API'\nnative-code: 'arm64-v8a'\n")
                return ''
            with self.certificate_pin(), patch.dict(os.environ, {signing.SECRET_NAME: self.secret(), 'RUNNER_TEMP': str(root)}), patch.object(signing, 'checked_run', side_effect=run):
                if failure:
                    with self.assertRaises(signing.SigningError):
                        signing.sign_bundle(bundle, root / 'tools', output, self.secret())
                    self.assertFalse(output.exists())
                else:
                    signed = signing.sign_bundle(bundle, root / 'tools', output, self.secret())
                    self.assertTrue(signed['signed'])
                    self.assertEqual(signed['unsignedApkSha256'], info['apkSha256'])
                    self.assertNotEqual(signed['apkSha256'], info['apkSha256'])
                    self.assertEqual(signed['apkSha256'], signing.file_hash(output / signed['apk']))
                    self.assertNotIn('signer', signed)
                    self.assertEqual({path.name for path in output.iterdir()}, {
                        signed['apk'], info['source'], 'build-info.json', 'SHA256SUMS'})
                    self.assertEqual(json.loads((output / 'build-info.json').read_text()), signed)
                self.assertEqual((bundle / info['apk']).read_bytes(), original_apk)
                self.assertTrue(all(not path.exists() for path in key_files))
                self.assertEqual({path.name for path in root.iterdir()}, {'unsigned'} | ({'signed'} if not failure else set()))

    def test_signing_preserves_payload_copies_source_and_records_actual_signed_hash(self):
        self.run_signing()

    def test_failed_signing_cleans_private_material_and_never_outputs_an_artifact(self):
        for failure in ('tool', 'certificate', 'payload', 'package'):
            with self.subTest(failure=failure): self.run_signing(failure)

    def test_certificate_output_requires_exactly_one_pinned_signer(self):
        good = 'Signer #1 certificate SHA-256 digest: ' + signing.EXPECTED_CERT_SHA256
        signing.verify_certificate(good)
        for output in ('', good + '\n' + good, 'Signer #1 certificate SHA-256 digest: ' + '0' * 64):
            with self.assertRaises(signing.SigningError): signing.verify_certificate(output)

    def test_duplicate_payload_member_is_rejected_and_only_signature_metadata_is_ignored(self):
        self.assertTrue(signing.is_signature_member('META-INF/SIGNER.SF'))
        self.assertFalse(signing.is_signature_member('META-INF/services/service.SF'))
        self.assertFalse(signing.is_signature_member('assets/key.RSA'))
        self.assertFalse(signing.is_signature_member('META-INF/service.config'))
        with tempfile.TemporaryDirectory() as directory:
            apk = Path(directory) / 'duplicate.apk'
            with zipfile.ZipFile(apk, 'w') as archive:
                archive.writestr('duplicate', b'first')
                with self.assertWarns(UserWarning): archive.writestr('duplicate', b'second')
            with self.assertRaises(signing.SigningError): signing.payload_hashes(apk)


if __name__ == '__main__':
    unittest.main()
