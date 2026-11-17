import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import threading
import unittest

HELPER = Path(__file__).resolve().parents[1] / "app/src/main/assets/git-credential-mobile.py"
spec = importlib.util.spec_from_file_location("mobile_github_credentials", HELPER)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class GitHubCredentialTests(unittest.TestCase):
    def serve(self, response):
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        listener.settimeout(5)
        requests = []

        def run():
            try:
                with listener.accept()[0] as client:
                    client.settimeout(3)
                    with client.makefile("rb") as source:
                        requests.append(json.loads(source.readline(8193)))
                    client.sendall(response)
            finally:
                listener.close()

        worker = threading.Thread(target=run, daemon=True)
        worker.start()
        return {"MC_GITHUB_PORT": str(listener.getsockname()[1]), "MC_GITHUB_CAPABILITY": "fixture-capability"}, requests, worker

    def test_get_uses_authenticated_loopback_and_only_writes_git_fields(self):
        env, requests, worker = self.serve(b'{"username":"x-access-token","password":"test-only-credential"}\n')
        out = io.StringIO()
        result = helper.main(["get"], io.BytesIO(b"protocol=https\nhost=github.com\npath=owner/project.git\n\n"), out, env)
        worker.join(5)
        self.assertEqual(result, 0)
        self.assertEqual(requests, [{"protocol": "https", "host": "github.com", "path": "owner/project.git", "capability": "fixture-capability"}])
        self.assertEqual(out.getvalue(), "username=x-access-token\npassword=test-only-credential\n\n")

    def test_wrong_host_protocol_and_store_erase_do_not_contact_broker(self):
        inputs = [b"protocol=http\nhost=github.com\n\n", b"protocol=https\nhost=github.com.attacker.test\n\n", b"protocol=https\nhost=github.com:443\n\n"]
        for value in inputs:
            with self.subTest(value=value):
                out = io.StringIO()
                self.assertEqual(helper.main(["get"], io.BytesIO(value), out, {}), 0)
                self.assertEqual(out.getvalue(), "")
        for operation in ("store", "erase"):
            out = io.StringIO()
            self.assertEqual(helper.main([operation], None, out, {}), 0)
            self.assertEqual(out.getvalue(), "")

    def test_duplicate_or_oversized_git_fields_are_rejected(self):
        for data in [b"protocol=https\nhost=github.com\nhost=attacker.test\n\n", b"protocol=https\nhost=github.com\npath=" + b"a" * 8192, b"host=github.com\x00evil\n"]:
            with self.subTest(size=len(data)):
                out = io.StringIO()
                self.assertEqual(helper.main(["get"], io.BytesIO(data), out, {}), 0)
                self.assertEqual(out.getvalue(), "")

    def test_broker_cannot_inject_extra_git_fields_or_unbounded_replies(self):
        for response in [b'{"username":"x-access-token","password":"fixture\\nurl=https://evil.test"}\n', b'{"username":"other","password":"fixture"}\n', b"x" * 8193 + b"\n", b'{"username":"x-access-token","password":"fixture"}']:
            env, _, worker = self.serve(response)
            out = io.StringIO()
            helper.main(["get"], io.BytesIO(b"protocol=https\nhost=github.com\n\n"), out, env)
            worker.join(5)
            self.assertEqual(out.getvalue(), "")

    def test_real_git_credential_fill_invokes_bundled_python_helper(self):
        env, requests, worker = self.serve(b'{"username":"x-access-token","password":"test-only-credential"}\n')
        env = {**os.environ, **env, "MC_PYTHON": sys.executable, "MC_GITHUB_HELPER": str(HELPER),
               "GIT_TERMINAL_PROMPT": "0", "GIT_CONFIG_COUNT": "3",
               "GIT_CONFIG_KEY_0": "credential.helper", "GIT_CONFIG_VALUE_0": "",
               "GIT_CONFIG_KEY_1": "credential.https://github.com.helper", "GIT_CONFIG_VALUE_1": "",
               "GIT_CONFIG_KEY_2": "credential.https://github.com.helper",
               "GIT_CONFIG_VALUE_2": '!"$MC_PYTHON" "$MC_GITHUB_HELPER"'}
        result = subprocess.run(["git", "credential", "fill"], input=b"protocol=https\nhost=github.com\n\n", env=env, capture_output=True, timeout=8)
        worker.join(5)
        self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace"))
        self.assertIn(b"username=x-access-token\npassword=test-only-credential", result.stdout)
        self.assertEqual(requests[0]["host"], "github.com")
        self.assertNotIn(b"test-only-credential", result.stderr)


if __name__ == "__main__":
    unittest.main()
