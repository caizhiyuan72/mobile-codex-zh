import importlib.util
import io
import json
from pathlib import Path
import socket
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "tools/github_device_login.py"
spec = importlib.util.spec_from_file_location("github_device_login", SCRIPT)
login = importlib.util.module_from_spec(spec)
spec.loader.exec_module(login)


class Clock:
    def __init__(self):
        self.now = 1000
        self.sleeps = []

    def read(self):
        return self.now

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds


class GitHubDeviceLoginTests(unittest.TestCase):
    def authorize(self, responses, user=None, header="public_repo,workflow", life=900):
        clock, calls, messages = Clock(), [], []
        values = iter(responses)

        def network(url, form=None, token=None):
            calls.append((url, form, token, clock.now))
            if url == login.DEVICE_URL:
                return {"device_code": "test-device-code", "user_code": "ABCD-1234", "verification_uri": "https://github.com/login/device", "expires_in": life, "interval": 5}, ""
            if url == login.USER_URL:
                return user or {"login": "caizhiyuan72"}, header
            return next(values), ""

        result = login.authorize("Iv1.fixtureClient", "caizhiyuan72", request=network, monotonic=clock.read, sleep=clock.sleep, announce=messages.append)
        return result, clock, calls, messages

    def test_pending_slowdown_and_success_validate_actual_user_without_printing_token(self):
        result, clock, calls, messages = self.authorize([
            {"error": "authorization_pending"}, {"error": "slow_down", "interval": 15},
            {"access_token": "fixture-token", "token_type": "bearer", "scope": "public_repo,workflow", "expires_in": 28800, "refresh_token": "fixture-refresh"}])
        self.assertEqual(clock.sleeps, [5, 5, 15])
        self.assertEqual(result, ("fixture-token", 1025 + 28800, "caizhiyuan72"))
        self.assertEqual(calls[-1][0], login.USER_URL)
        self.assertEqual(calls[-1][2], "fixture-token")
        self.assertTrue(all(call[2] is None for call in calls[:-1]))
        self.assertIn("ABCD-1234", " ".join(messages))
        self.assertNotIn("fixture-token", " ".join(messages))
        self.assertNotIn("fixture-refresh", " ".join(messages))

    def test_denied_expired_and_wrong_account_never_return_credentials(self):
        for problem in ("access_denied", "expired_token", "token_expired"):
            with self.subTest(problem=problem), self.assertRaises(login.LoginError):
                self.authorize([{"error": problem}])
        with self.assertRaisesRegex(login.LoginError, "预期账号"):
            self.authorize([{"access_token": "fixture", "token_type": "bearer", "scope": "public_repo,workflow"}], user={"login": "another-user"})

    def test_actual_scope_header_cannot_broaden_requested_permissions(self):
        good = {"access_token": "fixture", "token_type": "bearer", "scope": "public_repo,workflow"}
        for scope in ("repo,workflow", "public_repo", "public_repo,workflow,read:user"):
            with self.subTest(scope=scope), self.assertRaises(login.LoginError):
                self.authorize([good], header=scope)

    def test_device_lifetime_stops_polling_and_does_not_poll_early(self):
        with self.assertRaisesRegex(login.LoginError, "过期"):
            self.authorize([], life=2)

    def test_malformed_and_non_bearer_tokens_are_rejected(self):
        for response in ({"access_token": "fixture\npassword=other", "token_type": "bearer"}, {"access_token": "fixture", "token_type": "mac"}, {"access_token": "fixture", "token_type": "bearer", "expires_in": 0}):
            with self.subTest(response=response), self.assertRaises(login.LoginError):
                self.authorize([response])

    def test_network_layer_forbids_redirects_and_unapproved_endpoints(self):
        self.assertIsNone(login.NoRedirect().redirect_request(None, None, 302, "Found", {}, "https://attacker.test"))
        for url in ("http://github.com/login/device/code", "https://github.com.attacker.test/login/device/code", "https://api.github.com/user?token=fixture"):
            with self.subTest(url=url), self.assertRaises(login.LoginError):
                login.request_json(url)
        with self.assertRaises(login.LoginError):
            login.request_json(login.TOKEN_URL, token="fixture")

    def test_oauth_http_400_keeps_structured_errors_but_user_errors_are_redacted(self):
        error = login.urllib.error.HTTPError(login.TOKEN_URL, 400, "Bad Request", {}, io.BytesIO(b'{"error":"authorization_pending"}'))
        with patch.object(login.urllib.request, "build_opener") as opener:
            opener.return_value.open.side_effect = error
            response, _ = login.request_json(login.TOKEN_URL, {"client_id": "Iv1.fixture"})
            self.assertEqual(response, {"error": "authorization_pending"})
        error = login.urllib.error.HTTPError(login.USER_URL, 401, "fixture-token", {}, io.BytesIO(b'{"secret":"fixture-token"}'))
        with patch.object(login.urllib.request, "build_opener") as opener:
            opener.return_value.open.side_effect = error
            with self.assertRaises(login.LoginError) as result:
                login.request_json(login.USER_URL, token="fixture-token")
            self.assertNotIn("fixture-token", str(result.exception))

    def test_temporary_broker_is_bound_to_exact_repository_and_capability(self):
        bridge = login.CredentialBridge("fixture-token", 0, "caizhiyuan72/mobile-codex-zh")
        try:
            def request(**fields):
                data = {"capability": bridge.capability, "protocol": "https", "host": "github.com", "path": "caizhiyuan72/mobile-codex-zh.git", **fields}
                with socket.create_connection(("127.0.0.1", bridge.port), timeout=2) as client:
                    client.sendall(json.dumps(data).encode() + b"\n")
                    with client.makefile("rb") as source:
                        return json.loads(source.readline(8193))
            self.assertEqual(request()["password"], "fixture-token")
            self.assertEqual(request(capability="wrong"), {})
            self.assertEqual(request(host="github.com.attacker.test"), {})
            self.assertEqual(request(path="caizhiyuan72/other-repo.git"), {})
            env = bridge.environment()
            self.assertNotIn("fixture-token", str(env))
            self.assertNotIn("fixture-token", str(bridge.__dict__.get("capability")))
        finally:
            bridge.close()
        self.assertEqual(bridge.token, "")


if __name__ == "__main__":
    unittest.main()
