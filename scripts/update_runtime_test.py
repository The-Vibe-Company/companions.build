#!/usr/bin/env python3
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import tempfile
import types
import unittest
import uuid
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("update_runtime", ROOT / "packages/box/linux/update-runtime.py")
runtime = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runtime)


def digest(data):
    return hashlib.sha256(data).hexdigest()


class Crash(BaseException):
    pass


class FakeSystem(runtime.LinuxSystem):
    def __init__(self, root):
        super().__init__(root / "opt/companions", root / "var/lib/companions-runtime")
        self.active = True
        self.busy_code = None
        self.fail_start = False

    def require_root(self):
        self.state.mkdir(parents=True, mode=0o700, exist_ok=True)

    def preflight(self):
        if self.busy_code:
            raise runtime.UpdateError(self.busy_code)

    def copy_distribution(self, candidate):
        if candidate.exists():
            raise runtime.UpdateError("RECOVERY_REQUIRED")
        shutil.copytree(self.install, candidate, symlinks=True, copy_function=shutil.copy2)

    def service_active(self):
        return self.active

    def stop_runtime(self):
        self.active = False

    def freeze_runtime(self):
        pass

    def thaw_runtime(self):
        pass

    def start_runtime(self):
        if self.fail_start:
            self.fail_start = False
            raise RuntimeError("start failed")
        self.active = True

    def wait_runtime(self):
        return self.active

    def executable_hash(self):
        return runtime.sha256_path(self.install / "companion-agent") if self.active else None

    def exchange(self, left, right):
        temporary = left.parent / ".exchange"
        left.rename(temporary)
        right.rename(left)
        temporary.rename(right)


class RuntimeUpdateTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.system = FakeSystem(self.root)
        self.system.require_root()
        self.install = self.system.install
        self.install.mkdir(parents=True)
        for name in runtime.PAYLOAD_FILES:
            (self.install / name).write_bytes(("old-" + name).encode())
        (self.install / "custom-tool").write_text("keep me")
        self.staging = self.root / "staging"
        self.staging.mkdir()
        for name in runtime.PAYLOAD_FILES:
            (self.staging / name).write_bytes(("new-" + name).encode())
        descriptors = [{"path": name, "size": (self.staging / name).stat().st_size,
                        "sha256": runtime.sha256_path(self.staging / name)} for name in runtime.PAYLOAD_FILES]
        release_id = digest(json.dumps(descriptors, separators=(",", ":")).encode())
        manifest = {"schemaVersion": 1, "id": release_id, "protocolVersion": 1,
                    "stateVersion": 1, "files": descriptors}
        (self.staging / "runtime-release.json").write_text(json.dumps(manifest, separators=(",", ":")))
        self.update_id = str(uuid.uuid4())
        self.args = types.SimpleNamespace(
            update_id=self.update_id, staging_dir=str(self.staging.resolve()),
            companion_agent_sha256=descriptors[0]["sha256"],
            photon_rs_bg_wasm_sha256=descriptors[1]["sha256"],
            package_json_sha256=descriptors[2]["sha256"],
            manifest_sha256=runtime.sha256_path(self.staging / "runtime-release.json"))
        self.expected = runtime.expected_hashes(self.args)
        self.release_digest = runtime.release_digest(self.expected)

    def tearDown(self):
        self.temporary.cleanup()

    def installer(self):
        return runtime.Installer(self.system)

    def test_success_is_idempotent_and_retains_old_distribution(self):
        result = self.installer().apply(self.args)
        self.assertEqual("succeeded", result["state"])
        self.assertEqual(self.expected, self.installer().hashes_at(self.install))
        self.assertEqual("keep me", (self.install / "custom-tool").read_text())
        retained = Path(result["retainedPath"])
        self.assertTrue(retained.is_dir())
        self.assertEqual(b"old-companion-agent", (retained / "companion-agent").read_bytes())
        self.assertEqual(result, self.installer().apply(self.args))

    def test_deferred_is_persisted_without_stopping_and_can_retry(self):
        self.system.busy_code = "EPHEMERAL_DATA_PRESENT"
        result = self.installer().apply(self.args)
        self.assertEqual(("deferred", "EPHEMERAL_DATA_PRESENT"), (result["state"], result["code"]))
        self.assertTrue(self.system.active)
        self.assertEqual(b"old-companion-agent", (self.install / "companion-agent").read_bytes())
        self.system.busy_code = None
        self.assertEqual("succeeded", self.installer().apply(self.args)["state"])

    def test_rejects_wrong_digest_and_symlink(self):
        self.args.package_json_sha256 = "0" * 64
        with self.assertRaisesRegex(runtime.UpdateError, "") as raised:
            self.installer().apply(self.args)
        self.assertEqual("DIGEST_MISMATCH", raised.exception.code)
        self.args.package_json_sha256 = runtime.sha256_path(self.staging / "package.json")
        (self.staging / "package.json").unlink()
        (self.staging / "package.json").symlink_to("/etc/passwd")
        with self.assertRaises(runtime.UpdateError) as raised:
            self.installer().apply(self.args)
        self.assertEqual("INVALID_STAGING", raised.exception.code)

    def test_start_failure_rolls_back_without_losing_custom_file(self):
        self.system.fail_start = True
        result = self.installer().apply(self.args)
        self.assertEqual("rolled_back", result["state"])
        self.assertEqual(b"old-companion-agent", (self.install / "companion-agent").read_bytes())
        self.assertEqual("keep me", (self.install / "custom-tool").read_text())
        self.assertTrue(self.system.active)

    def test_reconcile_each_persisted_phase_never_loses_user_file(self):
        phases = ("preflight_pending", "copy_pending", "candidate_ready", "freeze_pending", "frozen",
                  "stop_pending", "swap_pending", "start_pending")
        for phase in phases:
            with self.subTest(phase=phase):
                self.tearDown()
                self.setUp()
                installer = self.installer()
                original = installer.persist

                def crash_after(journal, current, state="pending", code="PENDING"):
                    original(journal, current, state, code)
                    if current == phase:
                        raise Crash()

                installer.persist = crash_after
                with self.assertRaises(Crash):
                    installer.apply(self.args)
                result = self.installer().reconcile(self.update_id, self.release_digest)
                self.assertIn(result["state"], {"succeeded", "rolled_back"})
                self.assertEqual("keep me", (self.install / "custom-tool").read_text())

    def test_reconcile_exchange_with_lost_response_observes_new_tree(self):
        original = self.system.exchange

        def exchange_then_crash(left, right):
            original(left, right)
            raise Crash()

        self.system.exchange = exchange_then_crash
        with self.assertRaises(Crash):
            self.installer().apply(self.args)
        self.system.exchange = original
        result = self.installer().reconcile(self.update_id, self.release_digest)
        self.assertEqual("succeeded", result["state"])
        self.assertTrue(Path(result["retainedPath"]).exists())
        self.assertEqual("keep me", (self.install / "custom-tool").read_text())

    def test_explicit_rollback_restores_runtime_and_preserves_new_custom_files(self):
        applied = self.installer().apply(self.args)
        self.assertIsNone(applied["oldHashes"]["runtime-release.json"])
        (self.install / "installed-after-update").write_text("preserve")
        result = self.installer().requested_rollback(self.update_id, self.release_digest)
        self.assertEqual("rolled_back", result["state"])
        self.assertEqual(b"old-companion-agent", (self.install / "companion-agent").read_bytes())
        self.assertEqual("preserve", (self.install / "installed-after-update").read_text())

    def test_reconcile_each_explicit_rollback_phase(self):
        phases = ("rollback_copy_pending", "rollback_ready", "rollback_stop_pending", "rollback_swap_pending")
        for phase in phases:
            with self.subTest(phase=phase):
                self.tearDown()
                self.setUp()
                self.installer().apply(self.args)
                (self.install / "after-update").write_text("keep")
                installer = self.installer()
                original = installer.persist

                def crash_after(journal, current, state="pending", code="PENDING"):
                    original(journal, current, state, code)
                    if current == phase:
                        raise Crash()

                installer.persist = crash_after
                with self.assertRaises(Crash):
                    installer.requested_rollback(self.update_id, self.release_digest)
                result = self.installer().reconcile(self.update_id, self.release_digest)
                self.assertEqual("rolled_back", result["state"])
                self.assertEqual(b"old-companion-agent", (self.install / "companion-agent").read_bytes())
                self.assertEqual("keep", (self.install / "after-update").read_text())

    def test_status_absent_is_not_started(self):
        value, code = runtime.run(["status", "--update-id", self.update_id, "--digest", self.release_digest], self.system)
        self.assertEqual(("not_started", 0), (value["state"], code))

    def test_git_broker_requires_exact_owned_socket_layout(self):
        system = runtime.LinuxSystem(self.install, self.system.state)
        isolated = Path(tempfile.mkdtemp(prefix="rt-", dir="/tmp"))
        broker = isolated / "tmp/companions-git-credentials-aB123z"
        broker.mkdir(parents=True, mode=0o700)
        endpoint = socket.socket(socket.AF_UNIX)
        try:
            endpoint.bind(str(broker / "broker.sock"))
            (broker / "broker.sock").chmod(0o600)
            with mock.patch.object(runtime.pwd, "getpwnam", return_value=types.SimpleNamespace(pw_uid=broker.stat().st_uid)):
                system.validate_git_brokers(isolated, {broker.name})
                (broker / "secret").write_text("must defer")
                with self.assertRaises(runtime.UpdateError) as raised:
                    system.validate_git_brokers(isolated, {broker.name})
        finally:
            endpoint.close()
            shutil.rmtree(isolated)
        self.assertEqual("EPHEMERAL_DATA_PRESENT", raised.exception.code)

    def test_run_layout_allows_desktop_mount_beside_exact_resolver_tree(self):
        class RunSystem(runtime.LinuxSystem):
            def host_resolver_target(self):
                return Path("/run/systemd/resolve/stub-resolv.conf")

            def resolver_bytes(self):
                return b"nameserver 1.1.1.1\n"

            def platform_uid(self):
                return os.getuid()

        isolated = self.root / "isolated-run"
        (isolated / "run/companions-desktop").mkdir(parents=True)
        mount = isolated / "run/mount"
        mount.mkdir(mode=0o755)
        (mount / "utab").write_text("SRC=/dev/root TARGET=/ ROOT=/\n")
        (mount / "utab").chmod(0o644)
        (mount / "utab.lock").write_bytes(b"")
        (mount / "utab.lock").chmod(0o600)
        resolver = isolated / "run/systemd/resolve/stub-resolv.conf"
        resolver.parent.mkdir(parents=True)
        resolver.write_bytes(b"nameserver 1.1.1.1\n")
        RunSystem(self.install, self.system.state).validate_run(isolated)
        (isolated / "run/systemd/resolve/user-output").write_text("must defer")
        with self.assertRaises(runtime.UpdateError) as raised:
            RunSystem(self.install, self.system.state).validate_run(isolated)
        self.assertEqual("EPHEMERAL_DATA_PRESENT", raised.exception.code)

    def test_mount_bookkeeping_rejects_extra_or_binary_content(self):
        class RunSystem(runtime.LinuxSystem):
            def platform_uid(self):
                return os.getuid()

        mount = self.root / "mount"
        mount.mkdir(mode=0o755)
        (mount / "utab").write_bytes(b"SRC=/dev/root\0hidden")
        with self.assertRaises(runtime.UpdateError) as raised:
            RunSystem(self.install, self.system.state).validate_mount_bookkeeping(mount)
        self.assertEqual("UNKNOWN_EPHEMERAL_LAYOUT", raised.exception.code)
        (mount / "utab").write_bytes(b"")
        (mount / "user-data").write_text("unsafe")
        with self.assertRaises(runtime.UpdateError) as raised:
            RunSystem(self.install, self.system.state).validate_mount_bookkeeping(mount)
        self.assertEqual("EPHEMERAL_DATA_PRESENT", raised.exception.code)


if __name__ == "__main__":
    unittest.main()
