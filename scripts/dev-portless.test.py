#!/usr/bin/env python3
"""Ownership regressions for worktree-scoped Portless service aliases."""

import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("dev_portless", Path(__file__).with_name("dev_portless.py"))
portless = importlib.util.module_from_spec(spec)
spec.loader.exec_module(portless)


class FakePortless:
    def __init__(self, fail_alias: str | None = None):
        self.routes: dict[str, int] = {}
        self.calls: list[list[str]] = []
        self.fail_alias = fail_alias

    def run(self, command, **_kwargs):
        args = list(command)
        self.calls.append(args)
        action = args[1:]
        if action[0] == "alias" and action[1] != "--remove":
            name, port = action[1], int(action[2])
            if name == self.fail_alias or name in self.routes:
                return subprocess.CompletedProcess(args, 1, "", "collision")
            self.routes[name] = port
            return subprocess.CompletedProcess(args, 0, "registered", "")
        if action[:2] == ["alias", "--remove"]:
            self.routes.pop(action[2], None)
            return subprocess.CompletedProcess(args, 0, "removed", "")
        if action[0] == "get":
            return subprocess.CompletedProcess(args, 0, f"http://{action[1]}:1355\n", "")
        if action[0] == "list":
            lines = [f"http://{name}:1355 -> localhost:{value} (alias)" for name, value in self.routes.items()]
            return subprocess.CompletedProcess(args, 0, "\n".join(lines), "")
        raise AssertionError(action)


class PortlessRouteTests(unittest.TestCase):
    env = {"PORTLESS_URL": "http://quiet-meadow.companions.localhost:1355", "PATH": "/bin"}
    ports = {"api": 4101, "storage": 4104, "s3": 4103, "mailpit": 4106}

    def harness(self, fake: FakePortless, directory: str):
        return patch.multiple(portless, MANIFEST=Path(directory) / "manifest.json"), \
            patch.object(portless, "proxy_command", return_value=["portless"]), \
            patch.object(portless.subprocess, "run", side_effect=fake.run)

    def test_registers_prefixed_aliases_without_force_and_returns_proxy_urls(self):
        fake = FakePortless()
        with tempfile.TemporaryDirectory() as directory:
            patches = self.harness(fake, directory)
            with patches[0], patches[1], patches[2]:
                urls = portless.register_services(self.env, self.ports)
        self.assertEqual(urls["api"], "http://api.quiet-meadow.companions.localhost:1355")
        self.assertEqual(set(fake.routes), {f"{name}.quiet-meadow.companions.localhost" for name in self.ports})
        self.assertFalse(any("--force" in command for command in fake.calls))

    def test_partial_registration_failure_removes_only_created_aliases(self):
        failing = "s3.quiet-meadow.companions.localhost"
        fake = FakePortless(fail_alias=failing)
        foreign = "foreign.other-worktree.companions.localhost"
        fake.routes[foreign] = 9999
        with tempfile.TemporaryDirectory() as directory:
            patches = self.harness(fake, directory)
            with patches[0], patches[1], patches[2], self.assertRaisesRegex(RuntimeError, "registration failure"):
                portless.register_services(self.env, self.ports)
            self.assertFalse((Path(directory) / "manifest.json").exists())
        self.assertEqual(fake.routes, {foreign: 9999})

    def test_context_cleanup_runs_when_supervised_body_fails(self):
        fake = FakePortless()
        with tempfile.TemporaryDirectory() as directory:
            patches = self.harness(fake, directory)
            with patches[0], patches[1], patches[2], self.assertRaisesRegex(ValueError, "fixture"):
                with portless.routes(self.env, self.ports):
                    raise ValueError("fixture")
            self.assertFalse((Path(directory) / "manifest.json").exists())
        self.assertEqual(fake.routes, {})

    def test_registration_journal_recovers_without_published_supervisor_endpoints(self):
        fake = FakePortless()
        foreign = "api.other-worktree.companions.localhost"
        fake.routes[foreign] = 9999
        with tempfile.TemporaryDirectory() as directory:
            patches = self.harness(fake, directory)
            with patches[0], patches[1], patches[2]:
                portless.register_services(self.env, self.ports)
                # A hard crash here skips supervisor endpoint publication and finally cleanup.
                portless.cleanup_recorded({"PATH": "/bin"})
                self.assertFalse((Path(directory) / "manifest.json").exists())
        self.assertEqual(fake.routes, {foreign: 9999})

    def test_cleanup_refuses_a_route_now_pointing_to_a_foreign_port(self):
        fake = FakePortless()
        alias = "api.quiet-meadow.companions.localhost"
        fake.routes[alias] = 9999
        with tempfile.TemporaryDirectory() as directory:
            manifest = Path(directory) / "manifest.json"
            manifest.write_text(json.dumps({"primaryHost": "quiet-meadow.companions.localhost", "aliases": [
                {"service": "api", "name": alias, "port": 4101, "state": "created"},
            ]}))
            patches = self.harness(fake, directory)
            with patches[0], patches[1], patches[2], self.assertRaisesRegex(RuntimeError, "foreign port"):
                portless.cleanup_stale(self.env)
            self.assertTrue(manifest.exists())
        self.assertEqual(fake.routes[alias], 9999)
        self.assertFalse(any(command[1:3] == ["alias", "--remove"] for command in fake.calls))

    def test_cleanup_refuses_ambiguous_pending_ownership(self):
        fake = FakePortless()
        alias = "api.quiet-meadow.companions.localhost"
        fake.routes[alias] = 4101
        with tempfile.TemporaryDirectory() as directory:
            manifest = Path(directory) / "manifest.json"
            manifest.write_text(json.dumps({"primaryHost": "quiet-meadow.companions.localhost", "aliases": [
                {"service": "api", "name": alias, "port": 4101, "state": "pending"},
            ]}))
            patches = self.harness(fake, directory)
            with patches[0], patches[1], patches[2], self.assertRaisesRegex(RuntimeError, "ambiguous ownership"):
                portless.cleanup_stale(self.env)
            self.assertTrue(manifest.exists())
        self.assertIn(alias, fake.routes)


if __name__ == "__main__":
    unittest.main()
