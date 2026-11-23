"""Read the app's GitHub status and public repositories without exposing its token.

Invoked by the existing shell tool: python3 "$MC_GITHUB_CLI" status|repos.
Repository writes continue to use Git HTTPS and the app's credential helper.
"""
import argparse
import json
import os
import re
import socket
import sys
import urllib.error
import urllib.parse
import urllib.request

BROKER_LIMIT = 8192
RESPONSE_LIMIT = 4 * 1024 * 1024
API = "https://api.github.com/user/repos"
STATES = {"idle", "requesting", "pending", "connected", "expired", "denied", "error", "unavailable"}


class GitHubError(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Never forward the OAuth header to a redirect destination.
        return None


def broker(fields, environ):
    try:
        port = int(environ.get("MC_GITHUB_PORT", "0"))
        capability = environ.get("MC_GITHUB_CAPABILITY", "")
        if not 1 <= port <= 65535 or not capability:
            raise ValueError()
        payload = json.dumps({**fields, "capability": capability}).encode("utf-8") + b"\n"
        if len(payload) > BROKER_LIMIT:
            raise ValueError()
        with socket.create_connection(("127.0.0.1", port), timeout=4) as connection:
            connection.settimeout(30)
            connection.sendall(payload)
            with connection.makefile("rb") as response:
                raw = response.readline(BROKER_LIMIT + 1)
        if len(raw) > BROKER_LIMIT or not raw.endswith(b"\n"):
            raise ValueError()
        result = json.loads(raw)
        if not isinstance(result, dict):
            raise ValueError()
        return result
    except (OSError, ValueError, TypeError):
        raise GitHubError("无法连接 App 内的 GitHub 登录服务，请检查工具运行状态。") from None


def status(environ):
    value = broker({"operation": "status"}, environ)
    state, login, scopes = value.get("state"), value.get("login"), value.get("scopes")
    if (not isinstance(state, str) or state not in STATES or not isinstance(login, str)
            or (login and not re.fullmatch(r"[A-Za-z0-9-]{1,39}", login))
            or not isinstance(scopes, list) or any(s not in ("public_repo", "workflow") for s in scopes)):
        raise GitHubError("App 返回的 GitHub 状态无效。")
    return {"state": state, "login": login, "scopes": scopes}


def repositories(environ, page, per_page, opener=None):
    current = status(environ)
    if current["state"] != "connected":
        raise GitHubError("App 当前 GitHub 状态为 " + current["state"] + "，请检查设置中的连接状态。")
    value = broker({"protocol": "https", "host": "github.com"}, environ)
    token = value.get("password")
    if (value.get("username") != "x-access-token" or not isinstance(token, str)
            or not re.fullmatch(r"[\x21-\x7e]{1,2048}", token)):
        raise GitHubError("GitHub 登录凭据当前不可用，请检查设置中的连接状态。")
    query = urllib.parse.urlencode({"visibility": "public", "affiliation": "owner", "sort": "updated",
                                    "direction": "desc", "per_page": per_page, "page": page})
    request = urllib.request.Request(API + "?" + query, headers={
        "Accept": "application/vnd.github+json", "User-Agent": "Mobile-Codex-Android",
        "Authorization": "Bearer " + token, "X-GitHub-Api-Version": "2022-11-28"}, method="GET")
    if opener is None:
        opener = urllib.request.build_opener(NoRedirect())
    try:
        with opener.open(request, timeout=20) as response:
            if response.status != 200:
                raise GitHubError("GitHub 仓库查询失败（HTTP " + str(response.status) + "）。")
            raw = response.read(RESPONSE_LIMIT + 1)
            link = response.headers.get("Link", "")
        if len(raw) > RESPONSE_LIMIT:
            raise GitHubError("GitHub 仓库响应过大，请减小 --per-page 后重试。")
        rows = json.loads(raw)
        if not isinstance(rows, list) or len(rows) > per_page:
            raise ValueError()
        repos = []
        for row in rows:
            if not isinstance(row, dict) or not isinstance(row.get("private"), bool):
                raise ValueError()
            if row["private"]:
                continue
            name = row.get("full_name", "")
            if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", name):
                raise ValueError()
            permissions = row.get("permissions")
            repos.append({"fullName": name, "url": "https://github.com/" + name,
                          "cloneUrl": "https://github.com/" + name + ".git",
                          "canPush": isinstance(permissions, dict) and permissions.get("push") is True,
                          "archived": row.get("archived") is True})
        return {"login": current["login"], "visibility": "public", "affiliation": "owner", "page": page,
                "perPage": per_page, "nextPage": page + 1 if re.search(r';\s*rel="next"', link) else None,
                "repositories": repos}
    except urllib.error.HTTPError as error:
        code = error.code
        error.close()
        detail = "请检查设置中的授权状态。" if code == 401 else "请检查网络、权限或请求频率限制。"
        raise GitHubError("GitHub 仓库查询失败（HTTP " + str(code) + "），" + detail) from None
    except (OSError, ValueError, TypeError, AttributeError):
        # Raw server bodies, exceptions and request headers may contain secrets.
        raise GitHubError("GitHub 仓库查询失败，请检查网络或稍后重试。") from None


def main(args, stdout, environ, opener=None):
    parser = argparse.ArgumentParser(prog="mobile-github", description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("status", help="读取 App 当前 GitHub 登录状态")
    repos = commands.add_parser("repos", help="列出已登录账号拥有的公开仓库")
    repos.add_argument("--page", type=int, default=1)
    repos.add_argument("--per-page", type=int, default=30)
    options = parser.parse_args(args)
    try:
        if options.command == "status":
            result = status(environ)
        else:
            if not 1 <= options.page <= 10000 or not 1 <= options.per_page <= 100:
                raise GitHubError("--page 需要为 1–10000，--per-page 需要为 1–100。")
            result = repositories(environ, options.page, options.per_page, opener)
        stdout.write(json.dumps({"ok": True, **result}, ensure_ascii=False) + "\n")
        return 0
    except GitHubError as error:
        stdout.write(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False) + "\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:], sys.stdout, os.environ))
