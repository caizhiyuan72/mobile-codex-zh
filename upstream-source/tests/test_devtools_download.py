import hashlib
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

spec = importlib.util.spec_from_file_location('download_devtools', Path(__file__).parents[1] / 'tools' / 'prepare_devtools.py')
devtools = importlib.util.module_from_spec(spec)
spec.loader.exec_module(devtools)

class PinnedDownloadTests(unittest.TestCase):
    def test_missing_primary_uses_mirror_only_for_identical_pinned_bytes(self):
        data = b'pinned bytes'
        with tempfile.TemporaryDirectory() as directory:
            dest = Path(directory) / 'input.deb'
            url = devtools.POOL_URL + 'pool/input.deb'
            with patch.object(devtools.urllib.request, 'urlopen', side_effect=[urllib.error.HTTPError(url, 404, 'missing', {}, None), io.BytesIO(data)]) as request:
                devtools.download(url, dest, hashlib.sha256(data).hexdigest())
                self.assertEqual(dest.read_bytes(), data)
                self.assertIn('ro.mirror.flokinet.net', request.call_args_list[1].args[0])

    def test_retained_mirrors_restore_pinned_archives_missing_from_newer_pools(self):
        data = b'pinned archive retained by an official-listed mirror'
        for failures, mirror in (
            (2, 'https://mirror.nyist.edu.cn/termux/apt/termux-main/'),
            (3, 'https://mirror.iscas.ac.cn/termux/apt/termux-main/'),
        ):
            with self.subTest(mirror=mirror), tempfile.TemporaryDirectory() as directory:
                dest = Path(directory) / 'input.deb'
                relative = 'pool/main/c/c-ares/c-ares_1.34.8_aarch64.deb'
                url = devtools.POOL_URL + relative
                responses = [urllib.error.HTTPError(url, 404, 'missing', {}, None) for _ in range(failures)]
                for error in responses:
                    self.addCleanup(error.close)
                responses.append(io.BytesIO(data))
                with patch.object(devtools.urllib.request, 'urlopen', side_effect=responses) as request:
                    devtools.download(url, dest, hashlib.sha256(data).hexdigest())
                self.assertEqual(dest.read_bytes(), data)
                self.assertEqual(request.call_args_list[0].args[0], url)
                self.assertEqual(request.call_args_list[-1].args[0], mirror + relative)
                self.assertEqual(request.call_count, failures + 1)
                self.assertFalse(dest.with_suffix('.deb.partial').exists())

    def test_wrong_mirror_bytes_are_never_cached(self):
        with tempfile.TemporaryDirectory() as directory:
            dest = Path(directory) / 'input.deb'
            url = devtools.POOL_URL + 'pool/input.deb'
            with patch.object(devtools.urllib.request, 'urlopen', side_effect=[urllib.error.HTTPError(url, 404, 'missing', {}, None), io.BytesIO(b'wrong')]):
                with self.assertRaises(devtools.PackagingError):
                    devtools.download(url, dest, hashlib.sha256(b'right').hexdigest())
            self.assertFalse(dest.exists())
            self.assertFalse(dest.with_suffix('.deb.partial').exists())
