#!/usr/bin/env python3
"""Verify a persisted local scenario in an isolated real browser session."""

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.request
from urllib.parse import urlparse
import uuid

ROOT = Path(__file__).resolve().parent.parent


def load_settings() -> tuple[str, str, str]:
    path = ROOT / ".local/dev-endpoints.json"
    if not path.exists():
        raise RuntimeError("Local stack metadata is missing; run ./dev up first")
    value = json.loads(path.read_text())
    if value.get("testMode") is not True:
        raise RuntimeError("Browser tests require endpoint metadata with testMode=true")
    base = value.get("url")
    mail = value.get("mailUrl")
    for label, candidate in (("url", base), ("mailUrl", mail)):
        parsed = urlparse(str(candidate or ""))
        if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.username or parsed.password:
            raise RuntimeError(f"Local stack metadata contains no valid {label}")
    email = os.environ.get("LOCAL_DEV_EMAIL", "developer@companions.build").strip().lower()
    return str(base).rstrip("/"), str(mail).rstrip("/"), email


def mail_ids(mail_url: str) -> set[str]:
    with urllib.request.urlopen(mail_url + "/api/v1/messages", timeout=3) as response:
        return {str(message.get("ID")) for message in json.load(response).get("messages", [])}


def magic_link(mail_url: str, email: str, old_ids: set[str], base: str) -> str:
    expected = urlparse(base)
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        with urllib.request.urlopen(mail_url + "/api/v1/messages", timeout=3) as response:
            messages = json.load(response).get("messages", [])
        matching = next((message for message in messages
                         if str(message.get("ID")) not in old_ids
                         and any(str(recipient.get("Address", "")).lower() == email
                                 for recipient in message.get("To", []))), None)
        if matching:
            with urllib.request.urlopen(mail_url + "/api/v1/message/" + str(matching["ID"]), timeout=3) as response:
                body = str(json.load(response).get("Text", ""))
            for candidate in re.findall(r"https?://[^\s<>]+", body):
                candidate = candidate.rstrip(".,)")
                parsed = urlparse(candidate)
                if parsed.scheme == expected.scheme and parsed.netloc == expected.netloc and parsed.path == "/api/auth/magic-link/verify":
                    return candidate
        time.sleep(0.1)
    raise RuntimeError("Local sign-in email was not delivered by Mailpit")


class Browser:
    def __init__(self, session: str, artifact_dir: Path):
        self.env = {**os.environ, "AGENT_BROWSER_SESSION": session,
                    "AGENT_BROWSER_SCREENSHOT_DIR": str(artifact_dir)}

    def run(self, *arguments: str, quiet: bool = False) -> str:
        for attempt in range(4):
            result = subprocess.run(["agent-browser", *arguments], cwd=ROOT, env=self.env,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            if result.returncode == 0:
                return "" if quiet else result.stdout
            detail = (result.stderr or result.stdout).strip()
            if "Resource temporarily unavailable" not in detail or attempt == 3:
                raise RuntimeError(f"agent-browser {' '.join(arguments[:2])} failed: {detail[-600:]}")
            time.sleep(0.5)
        raise AssertionError("unreachable")

    def wait_text(self, expected: str, timeout: float = 90) -> str:
        deadline = time.monotonic() + timeout
        last = ""
        while time.monotonic() < deadline:
            last = self.run("get", "text", "body")
            if expected in last:
                return last
            time.sleep(0.5)
        raise RuntimeError(f"Browser did not show expected persisted text within {timeout:g}s: {expected}")

    def wait_text_count(self, expected: str, count: int, timeout: float = 90) -> str:
        deadline = time.monotonic() + timeout
        last = ""
        while time.monotonic() < deadline:
            last = self.run("get", "text", "body")
            if last.count(expected) >= count:
                return last
            time.sleep(0.5)
        raise RuntimeError(f"Browser showed fewer than {count} persisted occurrences within {timeout:g}s: {expected}")

    def close(self) -> None:
        subprocess.run(["agent-browser", "close"], cwd=ROOT, env=self.env,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def prepare_scenario() -> dict[str, object]:
    process = subprocess.run([sys.executable, str(ROOT / "scripts/dev-scenario.py"), "chat-ready", "--json"],
                             cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if process.returncode:
        raise RuntimeError((process.stderr or process.stdout).strip())
    lines = [line for line in process.stdout.splitlines() if line.strip().startswith("{")]
    if not lines:
        raise RuntimeError("Scenario did not return machine-readable evidence")
    result = json.loads(lines[-1])
    if result.get("status") != "passed":
        raise RuntimeError(str(result.get("error") or "Scenario failed"))
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("test", nargs="?", choices=["chat-recovery", "chat-ready"], default="chat-recovery")
    args = parser.parse_args()
    started = datetime.now(timezone.utc)
    artifact_dir = ROOT / ".artifacts/browser-tests" / f"{started.strftime('%Y%m%dT%H%M%SZ')}-{str(uuid.uuid4())[:8]}-{args.test}"
    artifact_dir.mkdir(parents=True, exist_ok=False)
    result: dict[str, object] = {"test": args.test, "status": "failed", "startedAt": started.isoformat(),
                                "artifactDir": str(artifact_dir.relative_to(ROOT))}
    browser = Browser(f"companions-{uuid.uuid4().hex}", artifact_dir)
    try:
        base, mail_url, email = load_settings()
        scenario = prepare_scenario()
        old_ids = mail_ids(mail_url)
        browser.run("open", base + "/login")
        browser.run("find", "label", "Email", "fill", email)
        browser.run("find", "role", "button", "click", "--name", "Email me a sign-in link")
        browser.wait_text("Check your inbox", timeout=15)
        link = magic_link(mail_url, email, old_ids, base)
        # The one-time token is never copied into output or artifacts.
        browser.run("open", link, quiet=True)
        browser.wait_text("companions.build", timeout=20)
        browser.run("open", str(scenario["url"]))
        browser.wait_text("The note was written and read back.", timeout=30)
        browser.run("fill", "textarea", "write-note")
        browser.run("press", "Enter")
        browser.wait_text_count("The note was written and read back.", 2)
        browser.run("screenshot", str(artifact_dir / "persisted-chat.png"), "--full")
        before = browser.run("snapshot", "-c")
        (artifact_dir / "before-reload.txt").write_text(before)
        browser.run("reload")
        browser.wait_text_count("The note was written and read back.", 2, timeout=30)
        browser.run("screenshot", str(artifact_dir / "after-reload.png"), "--full")
        after = browser.run("snapshot", "-c")
        (artifact_dir / "after-reload.txt").write_text(after)
        result.update(status="passed", url=scenario["url"], companionId=scenario["companionId"],
                      scenarioEvidence=scenario["artifactDir"], screenshots=["persisted-chat.png", "after-reload.png"])
    except Exception as error:
        result["error"] = str(error)
        try:
            browser.run("screenshot", str(artifact_dir / "failure.png"), "--full")
        except Exception:
            pass
    finally:
        browser.close()
    result["finishedAt"] = datetime.now(timezone.utc).isoformat()
    (artifact_dir / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    if result["status"] == "passed":
        print(f"{args.test}: passed\nEvidence: {result['artifactDir']}/result.json")
    else:
        print(f"{args.test}: failed: {result.get('error')}\nEvidence: {result['artifactDir']}/result.json", file=sys.stderr)
    raise SystemExit(0 if result["status"] == "passed" else 1)


if __name__ == "__main__":
    main()
