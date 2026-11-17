import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('apk_download_kit', Path(__file__).parents[1] / 'tools/apk_download_kit.py')
kit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(kit)


class ApkDownloadKitTests(unittest.TestCase):
    def archives(self, root, changed_runtime=False):
        base, target = root / 'base.apk', root / 'target.apk'
        for path, manifest, native in [(base, b'old-identity', b'A' * 4096),
                                       (target, b'new-parallel-identity', (b'B' if changed_runtime else b'A') * 4096)]:
            with zipfile.ZipFile(path, 'w') as archive:
                archive.writestr('AndroidManifest.xml', manifest)
                archive.writestr('lib/arm64-v8a/runtime.so', native)
                archive.writestr('assets/web/app.js', b'unchanged source')
        return base, target

    def test_reconstruction_matches_the_entire_target_apk(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            base, target = self.archives(root)
            metadata = kit.make_kit(target, root / 'kit', threshold=100)
            self.assertLess(metadata['skeletonBytes'], metadata['apkBytes'] // 2)
            output = kit.reconstruct(base, root / 'kit', root / 'restored.apk')
            self.assertEqual(target.read_bytes(), output.read_bytes())

    def test_different_runtime_is_rejected_without_leaving_an_apk(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            base, target = self.archives(root, changed_runtime=True)
            kit.make_kit(target, root / 'kit', threshold=100)
            with self.assertRaisesRegex(ValueError, 'compressed checksum differs'):
                kit.reconstruct(base, root / 'kit', root / 'restored.apk')
            self.assertFalse((root / 'restored.apk').exists())
            self.assertEqual([], list(root.glob('.apk-kit-*')))

    def test_corrupt_literal_and_final_digest_are_rejected(self):
        for tamper in ['literal', 'final']:
            with self.subTest(tamper=tamper), tempfile.TemporaryDirectory() as name:
                root = Path(name)
                base, target = self.archives(root)
                kit.make_kit(target, root / 'kit', threshold=100)
                if tamper == 'literal':
                    skeleton = root / 'kit/apk-skeleton.bin'
                    skeleton.write_bytes(b'X' + skeleton.read_bytes()[1:])
                else:
                    metadata = root / 'kit/apk-reconstruction.json'
                    content = json.loads(metadata.read_text()); content['apkSha256'] = '0' * 64
                    metadata.write_text(json.dumps(content))
                with self.assertRaises(ValueError):
                    kit.reconstruct(base, root / 'kit', root / 'restored.apk')
                self.assertFalse((root / 'restored.apk').exists())
