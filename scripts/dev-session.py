#!/usr/bin/env python3
"""Create an authenticated local Better Auth session without printing its token."""

import argparse
import http.cookiejar
import json
import os
from pathlib import Path
import re
import time
import urllib.error
import urllib.request
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent


def env_file_values() -> dict[str, str]:
    values: dict[str, str] = {}
    path = ROOT / ".env"
    for line in path.read_text().splitlines() if path.exists() else []:
        key, separator, value = line.partition("=")
        if separator:
            values[key.strip()] = value.strip().strip("\"'")
    return values


def load_endpoints() -> dict[str, object]:
    path = ROOT / ".local/dev-endpoints.json"
    if not path.exists():
        raise SystemExit("Local stack metadata is missing; run ./dev up first.")
    try:
        value = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit(f"Could not read local stack metadata: {error}") from error
    if not isinstance(value, dict):
        raise SystemExit("Local stack metadata must be a JSON object; run ./dev up again.")
    return value


def endpoint_url(value: object, label: str) -> str:
    if not isinstance(value, str):
        raise SystemExit(f"Local stack metadata does not contain {label}; run ./dev up again.")
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.username or parsed.password:
        raise SystemExit(f"Local stack metadata contains an invalid {label}.")
    return value.rstrip("/")


def find_magic_link(mail_url: str, email: str, previous_messages: set[str], expected_base: str) -> str:
    expected = urlparse(expected_base)
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        with urllib.request.urlopen(mail_url + "/api/v1/messages", timeout=3) as response:
            messages = json.load(response).get("messages", [])
        matching = next((message for message in messages
                         if message.get("ID") not in previous_messages
                         and any(str(recipient.get("Address", "")).lower() == email
                                 for recipient in message.get("To", []))), None)
        if matching:
            message_id = matching.get("ID")
            with urllib.request.urlopen(mail_url + "/api/v1/message/" + str(message_id), timeout=3) as response:
                message = json.load(response)
            for candidate in re.findall(r"https?://[^\s<>]+", str(message.get("Text", ""))):
                parsed = urlparse(candidate.rstrip(".,)"))
                if parsed.scheme == expected.scheme and parsed.netloc == expected.netloc and parsed.path == "/api/auth/magic-link/verify":
                    return candidate.rstrip(".,)")
        time.sleep(0.1)
    raise SystemExit("Local sign-in email was not delivered by Mailpit.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cookie-file", type=Path, help="Private destination for the Cookie request header")
    args = parser.parse_args()
    values = env_file_values()
    endpoints = load_endpoints()
    web_port = int(os.environ.get("WEB_PORT", values.get("WEB_PORT", endpoints.get("webPort", 4310))))
    base = endpoint_url(endpoints.get("url", f"http://127.0.0.1:{web_port}"), "url")
    mail_url = endpoint_url(endpoints.get("mailUrl", f"http://127.0.0.1:{web_port + 6}"), "mailUrl")
    email = os.environ.get("LOCAL_DEV_EMAIL", values.get("LOCAL_DEV_EMAIL", "developer@companions.build")).strip().lower()

    try:
        with urllib.request.urlopen(mail_url + "/api/v1/messages", timeout=3) as response:
            previous_messages = {str(message.get("ID")) for message in json.load(response).get("messages", [])}
        request = urllib.request.Request(
            base + "/api/auth/sign-in/magic-link",
            data=json.dumps({"email": email, "callbackURL": "/"}).encode(),
            headers={"content-type": "application/json", "origin": base},
        )
        with urllib.request.urlopen(request, timeout=5) as response:
            if response.status != 200:
                raise SystemExit("Sign-in email could not be requested.")
        link = find_magic_link(mail_url, email, previous_messages, base)
        jar = http.cookiejar.CookieJar()
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
        with opener.open(link, timeout=10) as response:
            response.read()
    except urllib.error.URLError as error:
        raise SystemExit(f"Local sign-in failed; is ./dev up ready? ({error.reason})") from error

    cookie = "; ".join(f"{item.name}={item.value}" for item in jar if item.name == "better-auth.session_token")
    if not cookie:
        raise SystemExit("Local email verification did not establish a session.")
    path = args.cookie_file or Path(os.environ.get("SESSION_COOKIE_FILE", str(ROOT / ".local/session-cookie")))
    if not path.is_absolute():
        path = ROOT / path
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.touch(mode=0o600, exist_ok=True)
    path.chmod(0o600)
    path.write_text(cookie)
    print(f"Better Auth local session saved to {path.relative_to(ROOT) if path.is_relative_to(ROOT) else path}.")


if __name__ == "__main__":
    main()
