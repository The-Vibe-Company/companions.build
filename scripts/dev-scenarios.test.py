#!/usr/bin/env python3
"""Regression tests for local scenario safety boundaries and browser evidence."""

import importlib.util
import json
import subprocess
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parent


def load_script(name: str) -> types.ModuleType:
    path = SCRIPTS / name
    spec = importlib.util.spec_from_file_location(f"test_{path.stem.replace('-', '_')}", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class SessionGuardTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.session = load_script("dev-session.py")

    def test_endpoint_rejects_credentials_and_non_http_schemes(self) -> None:
        for value in ("file:///tmp/app", "ftp://localhost/app", "http://user:secret@localhost:4310"):
            with self.subTest(value=value), self.assertRaises(SystemExit):
                self.session.endpoint_url(value, "url")

    def test_magic_link_must_match_public_origin_and_verification_path(self) -> None:
        email = "developer@companions.build"
        messages = {"messages": [{"ID": "new", "To": [{"Address": email}]}]}
        message = {"Text": "https://evil.example/api/auth/magic-link/verify?token=secret\n"
                           "https://app.companions.localhost/api/auth/magic-link/verify?token=expected"}

        class Response:
            def __init__(self, body: object):
                self.body = body

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return None

        responses = [Response(messages), Response(message)]
        with patch.object(self.session.urllib.request, "urlopen", side_effect=responses), \
             patch.object(self.session.json, "load", side_effect=lambda response: response.body):
            link = self.session.find_magic_link(
                "http://127.0.0.1:8025", email, set(), "https://app.companions.localhost"
            )
        self.assertEqual(link, "https://app.companions.localhost/api/auth/magic-link/verify?token=expected")


class ScenarioGuardTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.scenario = load_script("dev-scenario.py")
        cls.browser = load_script("dev-browser-test.py")

    def test_browser_settings_require_explicit_test_mode(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / ".local").mkdir()
            (root / ".local/dev-endpoints.json").write_text(json.dumps({
                "url": "http://app.companions.localhost:1355",
                "mailUrl": "http://127.0.0.1:8025",
                "testMode": False,
            }))
            with patch.object(self.browser, "ROOT", root), self.assertRaisesRegex(RuntimeError, "testMode=true"):
                self.browser.load_settings()

    def test_auth_navigation_failure_never_echoes_magic_link(self) -> None:
        token = 'PRIVATE_MAGIC_TOKEN'
        failed = subprocess.CompletedProcess([], 1, '', 'Navigation failed at ?token=' + token)
        browser = self.browser.Browser('isolated-test', Path('/tmp'))
        with patch.object(self.browser.subprocess, 'run', return_value=failed):
            with self.assertRaises(RuntimeError) as error:
                browser.run('open', 'http://app.localhost/api/auth/magic-link/verify?token=' + token, quiet=True)
        self.assertNotIn(token, str(error.exception))

    def test_scenario_endpoint_rejects_embedded_credentials(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / ".local").mkdir()
            (root / ".local/dev-endpoints.json").write_text(json.dumps({
                "url": "http://user:secret@app.companions.localhost:1355",
                "testMode": True,
            }))
            with patch.object(self.scenario, "ROOT", root), self.assertRaises(SystemExit):
                self.scenario.endpoints()

    def test_browser_failure_always_closes_its_isolated_session(self) -> None:
        closed: list[bool] = []

        class FakeBrowser:
            def __init__(self, _session: str, _artifact_dir: Path):
                pass

            def close(self) -> None:
                closed.append(True)

        with tempfile.TemporaryDirectory() as directory, \
             patch.object(self.browser, "ROOT", Path(directory)), \
             patch.object(self.browser, "Browser", FakeBrowser), \
             patch.object(self.browser, "load_settings", side_effect=RuntimeError("fixture failure")), \
             patch.object(sys, "argv", ["dev-browser-test.py"]), \
             self.assertRaisesRegex(SystemExit, "1"):
            self.browser.main()
        self.assertEqual(closed, [True])

    def test_browser_artifacts_never_store_magic_link_or_session_cookie(self) -> None:
        secret = "DO_NOT_STORE_MAGIC_TOKEN"
        cookie_marker = "better-auth.session_token=DO_NOT_STORE_COOKIE"
        closed: list[bool] = []
        commands: list[tuple[str, ...]] = []

        class FakeBrowser:
            def __init__(self, _session: str, artifact_dir: Path):
                self.artifact_dir = artifact_dir

            def run(self, *arguments: str, quiet: bool = False) -> str:
                commands.append(arguments)
                if arguments[0] == "screenshot":
                    Path(arguments[1]).write_bytes(b"safe image")
                if arguments[0] == "snapshot":
                    return "safe persisted page snapshot"
                return "" if quiet else "safe browser output"

            def wait_text(self, _expected: str, timeout: float = 90) -> str:
                return "safe"

            def wait_text_count(self, _expected: str, _count: int, timeout: float = 90) -> str:
                return "safe"

            def close(self) -> None:
                closed.append(True)

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            scenario = {"status": "passed", "url": "http://app/companions/example",
                        "companionId": "example", "artifactDir": ".artifacts/scenario"}
            with patch.object(self.browser, "ROOT", root), \
                 patch.object(self.browser, "Browser", FakeBrowser), \
                 patch.object(self.browser, "load_settings", return_value=("http://app", "http://mail", "dev@example.com")), \
                 patch.object(self.browser, "prepare_scenario", return_value=scenario), \
                 patch.object(self.browser, "mail_ids", return_value=set()), \
                 patch.object(self.browser, "magic_link", return_value=f"http://app/api/auth/magic-link/verify?token={secret}"), \
                 patch.dict(self.browser.os.environ, {"COOKIE_FIXTURE": cookie_marker}), \
                 patch.object(sys, "argv", ["dev-browser-test.py"]), \
                 self.assertRaisesRegex(SystemExit, "0"):
                self.browser.main()

            files = [path for path in root.rglob("*") if path.is_file()]
            self.assertTrue(files)
            self.assertFalse(any(path.suffix == ".zip" for path in files))
            evidence = b"\n".join(path.read_bytes() for path in files)
            self.assertNotIn(secret.encode(), evidence)
            self.assertNotIn(cookie_marker.encode(), evidence)
            self.assertFalse(any(arguments[0] == "trace" for arguments in commands))
            self.assertEqual(closed, [True])


if __name__ == "__main__":
    unittest.main()
