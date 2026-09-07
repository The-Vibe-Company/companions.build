#!/usr/bin/env python3
"""Run deterministic, authenticated scenarios against the active local stack."""

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.error
import urllib.request
from urllib.parse import urlparse
import uuid

ROOT = Path(__file__).resolve().parent.parent
TERMINAL = {"succeeded", "failed", "interrupted", "cancelled"}


def endpoints() -> tuple[str, dict[str, object]]:
    path = ROOT / ".local/dev-endpoints.json"
    if not path.exists():
        raise SystemExit("Local stack metadata is missing; run ./dev up first.")
    try:
        value = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit(f"Could not read local stack metadata: {error}") from error
    base = value.get("url") or (f"http://127.0.0.1:{value['webPort']}" if isinstance(value.get("webPort"), int) else None)
    parsed = urlparse(str(base or ""))
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.username or parsed.password:
        raise SystemExit("Local stack metadata contains no valid url; run ./dev up again.")
    return str(base).rstrip("/"), value


class Api:
    def __init__(self, base: str, cookie: str):
        self.base = base
        self.cookie = cookie

    def request(self, method: str, path: str, body: object | None = None) -> dict[str, object]:
        data = json.dumps(body).encode() if body is not None else None
        headers = {"cookie": self.cookie, "accept": "application/json"}
        if data is not None:
            headers.update({"content-type": "application/json", "origin": self.base})
        request = urllib.request.Request(self.base + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                value = json.load(response)
        except urllib.error.HTTPError as error:
            try:
                message = json.load(error).get("error", "Request failed")
            except Exception:
                message = "Request failed"
            raise RuntimeError(f"{method} {path} returned {error.code}: {message}") from error
        except urllib.error.URLError as error:
            raise RuntimeError(f"Could not reach the local stack at {self.base}: {error.reason}") from error
        if not isinstance(value, dict):
            raise RuntimeError(f"{method} {path} returned an invalid JSON response")
        return value


def authenticated_api(base: str) -> Api:
    cookie_path = Path(os.environ.get("SESSION_COOKIE_FILE", ROOT / ".local/session-cookie"))
    if not cookie_path.is_absolute():
        cookie_path = ROOT / cookie_path
    subprocess.run([sys.executable, str(ROOT / "scripts/dev-session.py"), "--cookie-file", str(cookie_path)],
                   cwd=ROOT, check=True)
    return Api(base, cookie_path.read_text().strip())


def wait_run(api: Api, companion_id: str, run_id: str, statuses: set[str], timeout: float = 60) -> dict[str, object]:
    deadline = time.monotonic() + timeout
    last = "missing"
    while time.monotonic() < deadline:
        detail = api.request("GET", f"/api/companions/{companion_id}")
        run = next((item for item in detail.get("runs", []) if item.get("id") == run_id), None)
        if run:
            last = str(run.get("status"))
            if last in statuses:
                return detail
            if last in TERMINAL and last not in statuses:
                raise RuntimeError(f"Run {run_id} finished as {last}: {run.get('error') or 'no error detail'}")
        time.sleep(0.2)
    raise RuntimeError(f"Run {run_id} did not reach {sorted(statuses)} within {timeout:g}s (last state: {last})")


def create_companion(api: Api, label: str) -> dict[str, object]:
    marker = uuid.uuid4()
    response = api.request("POST", "/api/companions", {
        "clientCreationId": str(marker), "name": f"Dev {label} {str(marker)[:8]}",
        "instructions": "Exercise the deterministic local development model.",
        "provider": "local", "prepare": False,
    })
    companion = response.get("companion")
    if not isinstance(companion, dict) or not isinstance(companion.get("id"), str):
        raise RuntimeError("Companion creation did not return a persisted companion")
    return companion


def send(api: Api, companion_id: str, content: str) -> str:
    response = api.request("POST", f"/api/companions/{companion_id}/messages", {
        "clientMessageId": str(uuid.uuid4()), "content": content, "attachmentCount": 0,
    })
    run_id = response.get("runId")
    if not isinstance(run_id, str):
        raise RuntimeError("Message admission did not return a persisted run")
    return run_id


def chat_ready(api: Api) -> dict[str, object]:
    companion = create_companion(api, "chat-ready")
    companion_id = str(companion["id"])
    run_id = send(api, companion_id, "write-note")
    detail = wait_run(api, companion_id, run_id, {"succeeded"})
    replies = [message for message in detail.get("messages", [])
               if message.get("runId") == run_id and message.get("role") == "assistant"]
    if [reply.get("content") for reply in replies] != ["The note was written and read back."]:
        raise RuntimeError("The persisted assistant reply did not prove the write/read tool round trip")
    return {"companionId": companion_id, "runIds": [run_id], "url": f"{api.base}/companions/{companion_id}"}


def cancel_recovery(api: Api) -> dict[str, object]:
    companion = create_companion(api, "cancel-recovery")
    companion_id = str(companion["id"])
    cancelled_id = send(api, companion_id, "slow-write")
    wait_run(api, companion_id, cancelled_id, {"running"}, timeout=45)
    api.request("POST", f"/api/companions/{companion_id}/cancel")
    wait_run(api, companion_id, cancelled_id, {"cancelled"}, timeout=20)
    recovery_id = send(api, companion_id, "write-note")
    detail = wait_run(api, companion_id, recovery_id, {"succeeded"})
    reply = next((message for message in detail.get("messages", [])
                  if message.get("runId") == recovery_id and message.get("role") == "assistant"), None)
    if not reply or reply.get("content") != "The note was written and read back.":
        raise RuntimeError("The post-cancellation run did not persist its expected reply")
    return {"companionId": companion_id, "runIds": [cancelled_id, recovery_id], "url": f"{api.base}/companions/{companion_id}"}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("scenario", choices=["chat-ready", "cancel-recovery"])
    parser.add_argument("--json", action="store_true", help="Print the final result as JSON")
    args = parser.parse_args()
    base, metadata = endpoints()
    started = datetime.now(timezone.utc)
    result: dict[str, object] = {"scenario": args.scenario, "status": "failed", "startedAt": started.isoformat()}
    artifacts = ROOT / ".artifacts/dev-scenarios" / f"{started.strftime('%Y%m%dT%H%M%SZ')}-{str(uuid.uuid4())[:8]}-{args.scenario}"
    artifacts.mkdir(parents=True, exist_ok=False)
    try:
        if metadata.get("testMode") is not True:
            raise RuntimeError("Scenarios require endpoint metadata with testMode=true")
        api = authenticated_api(base)
        config = api.request("GET", "/api/config")
        if config.get("model") != "Local test model" or config.get("localAvailable") is not True:
            raise RuntimeError("Scenarios require ./dev up with AGENT_TEST_MODE=1 and the local runtime enabled")
        evidence = chat_ready(api) if args.scenario == "chat-ready" else cancel_recovery(api)
        result.update(evidence, status="passed")
    except Exception as error:
        result["error"] = str(error)
    result["finishedAt"] = datetime.now(timezone.utc).isoformat()
    result["artifactDir"] = str(artifacts.relative_to(ROOT))
    (artifacts / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    if args.json:
        print(json.dumps(result))
    elif result["status"] == "passed":
        print(f"{args.scenario}: passed\nOpen: {result['url']}\nEvidence: {result['artifactDir']}/result.json")
    else:
        print(f"{args.scenario}: failed: {result.get('error')}\nEvidence: {result['artifactDir']}/result.json", file=sys.stderr)
    raise SystemExit(0 if result["status"] == "passed" else 1)


if __name__ == "__main__":
    main()
