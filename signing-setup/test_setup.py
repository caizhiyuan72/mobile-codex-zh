import base64
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('api_setup', Path(__file__).with_name('setup_api_signing.py'))
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


class SetupTests(unittest.TestCase):
    def fixture(self, directory):
        root = Path(directory)
        keys = root / 'keys'; keys.mkdir()
        bundle = root / 'download'; bundle.mkdir()
        (keys / 'release-key.pk8').write_bytes(b'fixture-key-not-real')
        (keys / 'release-cert.der').write_bytes(b'fixture-certificate')
        return keys, bundle

    def test_repeated_setup_reuses_verified_encrypted_backup_and_private_password(self):
        with tempfile.TemporaryDirectory() as directory:
            keys, bundle = self.fixture(directory)
            operations = []; requests = []
            payload = None
            def checked(args, *, data=None, **kwargs):
                nonlocal payload
                operation = args[-1]; operations.append(operation)
                if operation == 'validate-key':
                    payload = base64.b64decode(data); return b'valid'
                if operation == 'backup': return b'fixture-encrypted-backup\n'
                if operation == 'restore': return payload
                if operation == 'seal': return b'fixture-sealed-secret'
                self.fail('Unexpected operation')
            def request(endpoint, token, method='GET', payload=None):
                requests.append((endpoint, method, payload))
                if endpoint.endswith('/public-key'): return {'key':'public', 'key_id':'one'}
                return {'name':setup.SECRET, 'updated_at':'fixture-date'}
            with patch.object(setup, 'KEY_DIR', keys), patch.object(setup, 'CERT', hashlib.sha256(b'fixture-certificate').hexdigest()), \
                    patch.object(setup, 'checked', side_effect=checked), patch.object(setup, 'github_token', return_value='fixture-token'), \
                    patch.object(setup, 'request', side_effect=request), contextlib.redirect_stdout(io.StringIO()) as output:
                setup.install_secret(bundle)
                password = (keys / 'api-signing-recovery-password.txt').read_bytes()
                encrypted = (bundle / 'Codex-CN-API-signing-key.encrypted.json').read_bytes()
                setup.install_secret(bundle)
                self.assertEqual((keys / 'api-signing-recovery-password.txt').read_bytes(), password)
                self.assertEqual((bundle / 'Codex-CN-API-signing-key.encrypted.json').read_bytes(), encrypted)
                self.assertEqual(operations.count('backup'), 1)
                self.assertEqual(operations.count('restore'), 2)
                self.assertEqual((keys / 'api-signing-recovery-password.txt').stat().st_mode & 0o777, 0o600)
                receipt = (bundle / 'automatic-signing-setup-receipt.json').read_text()
                for text in [output.getvalue(), receipt]:
                    self.assertNotIn('fixture-key-not-real', text)
                    self.assertNotIn('fixture-token', text)
                    self.assertNotIn(password.decode().strip(), text)
                self.assertEqual(sum(method == 'PUT' for _, method, _ in requests), 2)
                for _, method, body in requests:
                    if method == 'PUT': self.assertEqual(set(body), {'encrypted_value', 'key_id'})

    def test_wrong_existing_certificate_stops_before_crypto_backup_or_network(self):
        with tempfile.TemporaryDirectory() as directory:
            keys, bundle = self.fixture(directory)
            with patch.object(setup, 'KEY_DIR', keys), patch.object(setup, 'checked') as crypto, patch.object(setup, 'request') as network:
                with self.assertRaises(setup.SetupError): setup.install_secret(bundle)
                crypto.assert_not_called(); network.assert_not_called()
                self.assertEqual(list(bundle.iterdir()), [])

    def test_private_write_refuses_to_replace_an_existing_password(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'password'
            setup.private_write(path, b'original')
            with self.assertRaises(FileExistsError): setup.private_write(path, b'replacement')
            self.assertEqual(path.read_bytes(), b'original')
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_http_errors_do_not_expose_token_or_server_body(self):
        error = setup.urllib.error.HTTPError('https://example.test', 403, 'private response', {}, None)
        with patch.object(setup.urllib.request, 'urlopen', side_effect=error):
            with self.assertRaises(setup.SetupError) as failure: setup.request('/actions/secrets', 'fixture-token')
        self.assertIn('HTTP 403', str(failure.exception))
        self.assertNotIn('fixture-token', str(failure.exception))
        self.assertNotIn('private response', str(failure.exception))

    def test_selftest_rejects_a_tampered_helper_before_running_node(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); (root / 'crypto-helper.cjs').write_text('changed')
            (root / 'bootstrap-files.json').write_text(json.dumps({'crypto-helper.cjs':'0' * 64}))
            with patch.object(setup, 'ROOT', root), patch.object(setup, 'checked') as execute:
                with self.assertRaises(setup.SetupError): setup.expected_runtime()
                execute.assert_not_called()


if __name__ == '__main__':
    unittest.main()
