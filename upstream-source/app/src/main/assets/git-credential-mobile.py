"""Git credential helper for the app's in-memory, authenticated loopback broker."""
import json
import os
import socket
import sys

LIMIT = 8192


def credential_request(stream):
    fields = {}
    total = 0
    while True:
        line = stream.readline(LIMIT + 1)
        total += len(line)
        if total > LIMIT or b"\x00" in line:
            raise ValueError("Invalid Git credential request")
        if not line or line in (b"\n", b"\r\n"):
            return fields
        key, separator, value = line.rstrip(b"\r\n").partition(b"=")
        if not separator:
            raise ValueError("Invalid Git credential request")
        name = key.decode("utf-8", errors="strict")
        if name in ("protocol", "host", "path"):
            if name in fields:
                raise ValueError("Ambiguous Git credential request")
            fields[name] = value.decode("utf-8", errors="strict")


def main(args, stdin, stdout, environ):
    # store/erase deliberately do nothing: the app owns login and local sign-out.
    if args != ["get"]:
        return 0
    try:
        fields = credential_request(stdin)
        if fields.get("protocol") != "https" or fields.get("host") != "github.com":
            return 0
        capability = environ.get("MC_GITHUB_CAPABILITY", "")
        port = int(environ.get("MC_GITHUB_PORT", "0"))
        if not capability or not 1 <= port <= 65535:
            return 0
        fields["capability"] = capability
        payload = json.dumps(fields, ensure_ascii=True).encode("ascii") + b"\n"
        if len(payload) > LIMIT:
            return 0
        with socket.create_connection(("127.0.0.1", port), timeout=4) as connection:
            connection.sendall(payload)
            with connection.makefile("rb") as reply:
                raw = reply.readline(LIMIT + 1)
        if len(raw) > LIMIT or not raw.endswith(b"\n"):
            return 0
        result = json.loads(raw)
        username, password = result.get("username"), result.get("password")
        if username != "x-access-token" or not isinstance(password, str) or not password:
            return 0
        if any(character in password for character in "\r\n\x00"):
            return 0
        stdout.write("username=x-access-token\npassword=" + password + "\n\n")
        stdout.flush()
    except (OSError, ValueError, UnicodeError, TypeError, AttributeError):
        # Git receives no credential on failure. Tokens and input never reach stderr.
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:], sys.stdin.buffer, sys.stdout, os.environ))
