"""One-time browser login and optional source push before the new APK is installed.

Uses the project's own public OAuth Client ID. OAuth credentials live only in
this process and its authenticated loopback broker; nothing is saved to disk.
"""
import argparse
import json
import os
from pathlib import Path
import re
import secrets
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

DEVICE_URL = "https://github.com/login/device/code"
TOKEN_URL = "https://github.com/login/oauth/access_token"
USER_URL = "https://api.github.com/user"
SCOPES = {"public_repo", "workflow"}
LIMIT = 64 * 1024


class LoginError(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, url):
        return None


def request_json(url, form=None, token=None):
    if url not in (DEVICE_URL, TOKEN_URL, USER_URL) or (token is not None and url != USER_URL):
        raise LoginError("拒绝无效的 GitHub 授权地址。")
    headers = {"Accept": "application/json", "User-Agent": "Mobile-Codex-CN-browser-login"}
    body = None
    if form is not None:
        headers["Content-Type"] = "application/x-www-form-urlencoded"
        body = urllib.parse.urlencode(form).encode("ascii")
    if token is not None:
        headers["Authorization"] = "Bearer " + token
    opener = urllib.request.build_opener(NoRedirect())
    try:
        try:
            response = opener.open(urllib.request.Request(url, data=body, headers=headers), timeout=20)
        except urllib.error.HTTPError as error:
            if error.code != 400 or url not in (DEVICE_URL, TOKEN_URL):
                error.close()
                raise
            response = error
        with response:
            data = response.read(LIMIT + 1)
            scope_header = response.headers.get("X-OAuth-Scopes", "")
        if len(data) > LIMIT:
            raise LoginError("GitHub 授权响应过大，请重试。")
        result = json.loads(data)
        if not isinstance(result, dict):
            raise ValueError()
        return result, scope_header
    except (OSError, ValueError, urllib.error.URLError):
        raise LoginError("无法连接 GitHub 授权服务，或授权已失效；没有保存凭据。") from None


def scopes(value):
    result = set(filter(None, re.split(r"[ ,]+", str(value).strip())))
    if result != SCOPES:
        raise LoginError("授权需要且仅接受 public_repo 和 workflow。请使用本项目独立注册、开启 Device Flow 的 OAuth App。")
    return result


def authorize(client_id, expected_login, request=request_json, monotonic=time.monotonic, sleep=time.sleep, announce=print):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{7,127}", client_id):
        raise LoginError("请提供自有 GitHub OAuth 应用的公开 Client ID，不需要 Client Secret。")
    began = monotonic()
    device, _ = request(DEVICE_URL, {"client_id": client_id, "scope": "public_repo workflow"})
    if device.get("error"):
        raise LoginError("GitHub 未能开始授权，请检查 Client ID 并开启 Device Flow。")
    code, user_code = device.get("device_code"), device.get("user_code")
    if not isinstance(code, str) or not code or len(code) > 2048 or any(ord(c) < 33 or ord(c) > 126 for c in code):
        raise LoginError("GitHub 返回的设备授权信息无效。")
    if not isinstance(user_code, str) or not re.fullmatch(r"[A-Za-z0-9-]{4,32}", user_code):
        raise LoginError("GitHub 返回的用户授权码无效。")
    if device.get("verification_uri") not in ("https://github.com/login/device", "https://github.com/login/device/"):
        raise LoginError("GitHub 返回的浏览器授权地址无效。")
    try:
        lifetime = int(device["expires_in"])
        interval = max(5, int(device.get("interval", 5)))
    except (KeyError, ValueError, TypeError):
        raise LoginError("GitHub 返回的授权期限无效。") from None
    if not 1 <= lifetime <= 3600 or interval > 300:
        raise LoginError("GitHub 返回的授权期限无效。")
    deadline = began + lifetime
    announce("打开 https://github.com/login/device ，输入一次性授权码：" + user_code)
    announce("请确认 GitHub 登录账号为 " + expected_login + "；等待浏览器授权，令牌不会输出或保存。")
    while monotonic() < deadline:
        sleep(min(interval, max(0, deadline - monotonic())))
        if monotonic() >= deadline:
            break
        started = monotonic()
        response, _ = request(TOKEN_URL, {"client_id": client_id, "device_code": code,
                                       "grant_type": "urn:ietf:params:oauth:grant-type:device_code"})
        if monotonic() >= deadline:
            break
        error = response.get("error")
        if error == "authorization_pending":
            continue
        if error == "slow_down":
            try:
                interval = max(interval + 5, int(response.get("interval", 0)))
            except (ValueError, TypeError):
                interval += 5
            continue
        if error in ("expired_token", "token_expired"):
            break
        if error == "access_denied":
            raise LoginError("已拒绝 GitHub 授权，没有推送代码。")
        if error:
            raise LoginError("GitHub 授权未完成，请检查应用配置后重试。")
        token = response.get("access_token")
        if not isinstance(token, str) or not token or len(token) > 4096 or any(c.isspace() or ord(c) < 32 for c in token):
            raise LoginError("GitHub 返回的访问令牌无效。")
        if str(response.get("token_type", "")).lower() != "bearer":
            raise LoginError("GitHub 返回的令牌类型无效。")
        expiry = 0
        if "expires_in" in response:
            try:
                expiry = started + int(response["expires_in"])
            except (ValueError, TypeError):
                raise LoginError("GitHub 返回的令牌期限无效。") from None
            if expiry <= monotonic():
                raise LoginError("GitHub 访问令牌已过期，请重新登录。")
        user, granted_header = request(USER_URL, token=token)
        scopes(granted_header or response.get("scope", ""))
        login = user.get("login", "")
        if not isinstance(login, str) or not re.fullmatch(r"[A-Za-z0-9-]{1,39}", login):
            raise LoginError("未能验证 GitHub 登录账号。")
        if login.lower() != expected_login.lower():
            raise LoginError("登录账号为 " + login + "，与预期账号不符；没有推送代码。")
        if expiry and expiry <= monotonic():
            raise LoginError("GitHub 访问令牌已过期，请重新登录。")
        return token, expiry, login
    raise LoginError("一次性授权码已过期，请重新开始登录。")


class CredentialBridge:
    def __init__(self, token, expiry, repository):
        self.token = token
        self.expiry = expiry
        self.repository = repository.lower().removesuffix(".git")
        self.capability = secrets.token_urlsafe(32)
        self.listener = socket.socket()
        self.listener.bind(("127.0.0.1", 0))
        self.listener.listen(4)
        self.port = self.listener.getsockname()[1]
        self.closed = False
        self.worker = threading.Thread(target=self.serve, daemon=True)
        self.worker.start()

    def serve(self):
        while not self.closed:
            try:
                with self.listener.accept()[0] as client:
                    client.settimeout(3)
                    result = {}
                    try:
                        with client.makefile("rb") as source:
                            raw = source.readline(8193)
                        if len(raw) > 8192 or not raw.endswith(b"\n"):
                            raise ValueError()
                        request = json.loads(raw)
                        valid = secrets.compare_digest(str(request.get("capability", "")), self.capability)
                        valid &= request.get("protocol") == "https" and request.get("host") == "github.com"
                        valid &= str(request.get("path", "")).lower().removesuffix(".git") == self.repository
                        valid &= not self.expiry or time.monotonic() < self.expiry
                        if valid:
                            result = {"username": "x-access-token", "password": self.token}
                    except (ValueError, TypeError, AttributeError, OSError):
                        pass
                    client.sendall(json.dumps(result).encode("utf-8") + b"\n")
            except OSError:
                pass

    def environment(self):
        helper = Path(__file__).resolve().parents[1] / "app/src/main/assets/git-credential-mobile.py"
        env = dict(os.environ)
        try:
            count = int(env.get("GIT_CONFIG_COUNT", "0"))
        except ValueError:
            raise LoginError("Git 配置环境无效。") from None
        if not 0 <= count <= 64:
            raise LoginError("Git 配置环境无效。")
        pairs = [("credential.https://github.com.helper", ""),
                 ("credential.https://github.com.helper", '!"$MC_PYTHON" "$MC_GITHUB_HELPER"'),
                 ("credential.https://github.com.useHttpPath", "true")]
        for key, value in pairs:
            env["GIT_CONFIG_KEY_" + str(count)] = key
            env["GIT_CONFIG_VALUE_" + str(count)] = value
            count += 1
        env.update({"GIT_CONFIG_COUNT": str(count), "MC_PYTHON": sys.executable, "MC_GITHUB_HELPER": str(helper),
                    "MC_GITHUB_PORT": str(self.port), "MC_GITHUB_CAPABILITY": self.capability, "GIT_TERMINAL_PROMPT": "0"})
        return env

    def close(self):
        self.closed = True
        self.token = ""
        self.listener.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description="使用自有 OAuth 应用在浏览器授权 GitHub；令牌只保留在内存。")
    parser.add_argument("--client-id", required=True, help="公开 Client ID，不是 Client Secret")
    parser.add_argument("--repository", default="caizhiyuan72/mobile-codex-zh")
    parser.add_argument("--expected-login", default="caizhiyuan72")
    parser.add_argument("--branch", default="feat/api-codex-ui")
    parser.add_argument("--push", action="store_true", help="授权后推送当前 HEAD 到指定分支，触发仓库现有工作流")
    args = parser.parse_args(argv)
    bridge = None
    try:
        if not re.fullmatch(r"[A-Za-z0-9-]{1,39}/[A-Za-z0-9_.-]{1,100}", args.repository):
            raise LoginError("仓库名称无效。")
        if not re.fullmatch(r"[A-Za-z0-9-]{1,39}", args.expected_login):
            raise LoginError("预期 GitHub 账号无效。")
        if args.push and (args.branch.startswith("-") or subprocess.run(["git", "check-ref-format", "refs/heads/" + args.branch], capture_output=True).returncode):
            raise LoginError("开发分支名称无效。")
        token, expiry, login = authorize(args.client_id, args.expected_login)
        print("已验证 GitHub 账号：" + login, flush=True)
        if args.push:
            bridge = CredentialBridge(token, expiry, args.repository)
            print("正在推送当前提交到 " + args.repository + " 的 " + args.branch + " 分支。", flush=True)
            result = subprocess.run(["git", "push", "https://github.com/" + args.repository + ".git", "HEAD:refs/heads/" + args.branch], env=bridge.environment())
            if result.returncode:
                raise LoginError("Git 推送未成功；临时凭据已结束，不会自动重试其他仓库。")
            print("推送完成。构建记录：https://github.com/" + args.repository + "/actions", flush=True)
        else:
            print("浏览器登录验证完成；未推送，未保存访问令牌。", flush=True)
        return 0
    except LoginError as error:
        print(str(error), file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("已取消登录；没有保存访问令牌。", file=sys.stderr)
        return 130
    finally:
        if bridge is not None:
            bridge.close()


if __name__ == "__main__":
    raise SystemExit(main())
