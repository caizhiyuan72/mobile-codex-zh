import importlib.util
import io
import json
from pathlib import Path
import socket
import subprocess
import sys
import threading
import unittest
from unittest.mock import patch
import urllib.error
import urllib.parse
import urllib.request

SCRIPT = Path(__file__).resolve().parents[1] / "app/src/main/assets/mobile-github.py"
spec = importlib.util.spec_from_file_location("mobile_github_cli", SCRIPT)
cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cli)
TOKEN = "fixture-private-token"
CONNECTED = {"state": "connected", "login": "fixture-user", "scopes": ["public_repo", "workflow"]}
CREDENTIAL = {"username": "x-access-token", "password": TOKEN}


class Response(io.BytesIO):
    status = 200

    def __init__(self, value, link=""):
        super().__init__(json.dumps(value).encode())
        self.headers = {"Link": link}


class Opener:
    def __init__(self, response):
        self.response = response
        self.requests = []

    def open(self, request, timeout):
        self.requests.append((request, timeout))
        if isinstance(self.response, Exception):
            raise self.response
        return self.response


class GitHubCliTests(unittest.TestCase):
    def invoke(self, args, broker_responses, response=None):
        output = io.StringIO()
        opener = Opener(response)
        with patch.object(cli, "broker", side_effect=broker_responses) as broker:
            result = cli.main(args, output, {}, opener)
        text = output.getvalue()
        self.assertNotIn(TOKEN, text)
        self.assertNotIn("fixture-capability", text)
        return result, json.loads(text), broker, opener

    def test_status_is_a_local_read_with_no_credential_or_api_request(self):
        code, output, broker, opener = self.invoke(["status"], [{**CONNECTED, "password": TOKEN, "userCode": "SECRET-CODE"}])
        self.assertEqual(code, 0)
        self.assertEqual(output, {"ok": True, **CONNECTED})
        broker.assert_called_once_with({"operation": "status"}, {})
        self.assertEqual(opener.requests, [])
        self.assertNotIn("SECRET-CODE", str(output))

    def test_repository_list_uses_fixed_authenticated_get_and_bounded_pagination(self):
        response = Response([
            {"full_name": "fixture-user/project", "private": False, "permissions": {"push": True},
             "html_url": "https://attacker.test", "clone_url": "https://attacker.test/token=" + TOKEN},
            {"full_name": "fixture-user/private", "private": True},
        ], '<https://api.github.com/user/repos?page=3>; rel="next"')
        code, output, broker, opener = self.invoke(["repos", "--page", "2", "--per-page", "2"], [CONNECTED, CREDENTIAL], response)
        self.assertEqual(code, 0)
        self.assertEqual(output["nextPage"], 3)
        self.assertEqual(output["repositories"], [{"fullName": "fixture-user/project", "url": "https://github.com/fixture-user/project",
                                                "cloneUrl": "https://github.com/fixture-user/project.git", "canPush": True, "archived": False}])
        self.assertEqual(broker.call_args_list[1].args[0], {"protocol": "https", "host": "github.com"})
        request, timeout = opener.requests[0]
        self.assertEqual(request.method, "GET")
        address = urllib.parse.urlsplit(request.full_url)
        self.assertEqual((address.scheme, address.netloc, address.path), ("https", "api.github.com", "/user/repos"))
        self.assertEqual(urllib.parse.parse_qs(address.query), {"visibility": ["public"], "affiliation": ["owner"],
                         "sort": ["updated"], "direction": ["desc"], "page": ["2"], "per_page": ["2"]})
        self.assertEqual(request.get_header("Authorization"), "Bearer " + TOKEN)
        self.assertEqual(timeout, 20)

    def test_disconnected_and_expired_logins_never_request_a_token_or_contact_github(self):
        for state in ("idle", "pending", "expired", "error"):
            code, output, broker, opener = self.invoke(["repos"], [{**CONNECTED, "state": state}])
            self.assertEqual(code, 1)
            self.assertIn(state, output["error"])
            self.assertEqual(broker.call_count, 1)
            self.assertEqual(opener.requests, [])

    def test_invalid_arguments_and_unknown_commands_cannot_make_requests(self):
        for args in (["repos", "--page", "0"], ["repos", "--page", "10001"], ["repos", "--per-page", "101"]):
            code, _, broker, opener = self.invoke(args, [])
            self.assertEqual(code, 1)
            broker.assert_not_called()
            self.assertEqual(opener.requests, [])
        with patch.object(cli, "broker") as broker, patch("sys.stderr", new_callable=io.StringIO):
            for args in (["api", "https://attacker.test"], ["repos", "--url", "https://attacker.test"], ["push"]):
                with self.assertRaises(SystemExit):
                    cli.main(args, io.StringIO(), {})
            broker.assert_not_called()

    def test_http_failures_and_network_exceptions_do_not_echo_body_headers_or_tokens(self):
        for failure in [urllib.error.HTTPError("https://attacker.test/" + TOKEN, code, TOKEN, {}, io.BytesIO(TOKEN.encode()))
                        for code in (301, 302, 401, 403, 429, 500)] + [OSError("secret=" + TOKEN)]:
            code, output, _, opener = self.invoke(["repos"], [CONNECTED, CREDENTIAL], failure)
            self.assertEqual(code, 1)
            self.assertFalse(output["ok"])
            self.assertEqual(len(opener.requests), 1)
            self.assertNotIn("attacker.test", output["error"])

    def test_redirect_handler_refuses_to_forward_authorization(self):
        opener = urllib.request.build_opener(cli.NoRedirect())
        handler = next(h for h in opener.handlers if isinstance(h, cli.NoRedirect))
        req = urllib.request.Request(cli.API, headers={"Authorization": "Bearer " + TOKEN})
        self.assertIsNone(handler.redirect_request(req, None, 302, "", {}, "https://attacker.test"))

    def test_bad_or_oversized_api_responses_fail_without_echoing_raw_data(self):
        for response in [Response({"error": TOKEN}), Response([{"private": False, "full_name": "https://attacker.test"}]),
                         Response([{"private": False, "full_name": 123}]), Response([TOKEN]),
                         Response(TOKEN * (cli.RESPONSE_LIMIT // len(TOKEN) + 1))]:
            code, output, _, _ = self.invoke(["repos"], [CONNECTED, CREDENTIAL], response)
            self.assertEqual(code, 1)
            self.assertFalse(output["ok"])

    def test_missing_credentials_or_invalid_status_fail_before_api_access(self):
        for value in ({}, {"username": "other", "password": TOKEN}, {"username": "x-access-token", "password": "line\nbreak"}):
            code, _, _, opener = self.invoke(["repos"], [CONNECTED, value])
            self.assertEqual(code, 1)
            self.assertEqual(opener.requests, [])
        for status in ({**CONNECTED, "state": []}, {**CONNECTED, "scopes": "repo"}, {**CONNECTED, "login": "<script>"}):
            code, _, _, opener = self.invoke(["status"], [status])
            self.assertEqual(code, 1)
            self.assertEqual(opener.requests, [])

    def test_real_cli_reads_status_from_authenticated_loopback_without_emitting_secrets(self):
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0)); listener.listen(1); listener.settimeout(5)
        requests = []

        def serve():
            try:
                with listener.accept()[0] as client:
                    client.settimeout(3)
                    with client.makefile("rb") as source:
                        requests.append(json.loads(source.readline(8193)))
                    client.sendall(json.dumps({**CONNECTED, "password": TOKEN}).encode() + b"\n")
            finally:
                listener.close()

        worker = threading.Thread(target=serve, daemon=True); worker.start()
        import os
        env = {**os.environ, "MC_GITHUB_PORT": str(listener.getsockname()[1]), "MC_GITHUB_CAPABILITY": "fixture-capability"}
        result = subprocess.run([sys.executable, str(SCRIPT), "status"], capture_output=True, env=env, timeout=8)
        worker.join(5)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual(json.loads(result.stdout), {"ok": True, **CONNECTED})
        self.assertEqual(requests, [{"operation": "status", "capability": "fixture-capability"}])
        self.assertEqual(result.stderr, b"")
        self.assertNotIn(TOKEN.encode(), result.stdout)

    def test_broker_failure_has_no_traceback_or_environment_dump(self):
        out = io.StringIO()
        code = cli.main(["status"], out, {"MC_GITHUB_PORT": "bad", "MC_GITHUB_CAPABILITY": TOKEN})
        self.assertEqual(code, 1)
        self.assertNotIn(TOKEN, out.getvalue())
        self.assertFalse(json.loads(out.getvalue())["ok"])


if __name__ == "__main__":
    unittest.main()
