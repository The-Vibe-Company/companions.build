import argparse
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

SCRIPT = Path(__file__).with_name("verify.py")
SPEC = importlib.util.spec_from_file_location("verify", SCRIPT)
verify = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(verify)
EVIDENCE_SCRIPT = Path(__file__).with_name("validation_evidence.py")
EVIDENCE_SPEC = importlib.util.spec_from_file_location("validation_evidence_tested", EVIDENCE_SCRIPT)
evidence = importlib.util.module_from_spec(EVIDENCE_SPEC)
EVIDENCE_SPEC.loader.exec_module(evidence)


def arguments(profile="server", test=None):
    return argparse.Namespace(profile=profile, postgres="17", test=test)


class VerifyTest(unittest.TestCase):
    def setUp(self):
        publisher = mock.patch.object(verify.Verifier, "publish_latest")
        self.publish = publisher.start()
        self.addCleanup(publisher.stop)

    @mock.patch.object(verify.module, "toolchain", return_value="bun")
    def test_reproduction_includes_profile_and_pattern(self, _toolchain):
        runner = verify.Verifier(arguments(test="retirement"))
        self.assertIn("--profile server", runner.reproduction)
        self.assertIn("--test retirement", runner.reproduction)

    @mock.patch.object(verify.module, "toolchain", return_value="bun")
    @mock.patch.object(verify.subprocess, "Popen")
    def test_timeout_is_recorded_as_failure(self, popen, _toolchain):
        child = popen.return_value
        child.pid = 999999
        child.wait.side_effect = [subprocess.TimeoutExpired("test", 1), None]
        with mock.patch.object(verify, "source_evidence", return_value={"commit": "abc", "dirty": False, "fingerprint": "123"}):
            runner = verify.Verifier(arguments())
        with mock.patch.object(os, "killpg"):
            with self.assertRaisesRegex(RuntimeError, "timed out"):
                runner.run("slow", ["unused"], timeout=1)
        self.assertEqual(runner.steps[0]["status"], "failed")
        self.assertTrue(runner.steps[0]["timedOut"])
        self.assertEqual(runner.steps[0]["timeoutSeconds"], 1)

    @mock.patch.object(verify.module, "toolchain", return_value="bun")
    @mock.patch.object(verify.subprocess, "Popen")
    def test_interruption_terminates_the_child_process_group(self, popen, _toolchain):
        child = popen.return_value
        child.pid = 999999
        child.wait.side_effect = [KeyboardInterrupt(), None]
        with mock.patch.object(verify, "source_evidence", return_value={"commit": "abc", "dirty": False, "fingerprint": "123"}):
            runner = verify.Verifier(arguments())
        with mock.patch.object(os, "killpg") as killpg:
            with self.assertRaises(KeyboardInterrupt):
                runner.run("interrupted", ["unused"])
        killpg.assert_called_once_with(child.pid, verify.signal.SIGTERM)
        self.assertEqual(runner.steps[0]["status"], "failed")

    @mock.patch.object(verify.module, "toolchain", return_value="bun")
    @mock.patch.object(verify.subprocess, "run")
    def test_cleanup_records_owned_resources(self, run, _toolchain):
        run.side_effect = [
            subprocess.CompletedProcess([], 0, "one\ntwo\n", ""),
            subprocess.CompletedProcess([], 0),
            subprocess.CompletedProcess([], 0, "", ""),
            subprocess.CompletedProcess([], 0, "volume\n", ""),
            subprocess.CompletedProcess([], 0),
            subprocess.CompletedProcess([], 0, "", ""),
        ]
        with mock.patch.object(verify, "source_evidence", return_value={"commit": "abc", "dirty": False, "fingerprint": "123"}):
            runner = verify.Verifier(arguments())
        runner.clean_owned_resources()
        self.assertEqual(runner.cleanup["status"], "passed")
        self.assertEqual(runner.cleanup["containers"], {"found": 2, "removed": 2, "remaining": 0})
        self.assertEqual(runner.cleanup["volumes"], {"found": 1, "removed": 1, "remaining": 0})

    @mock.patch.object(verify, "source_evidence", return_value={"commit": "abc", "dirty": False, "fingerprint": "123"})
    def test_provider_credentials_are_removed_from_child_environment(self, _evidence):
        with mock.patch.dict(os.environ, {"OPENAI_API_KEY": "secret", "BOX_API_KEY": "secret",
                                              "CUSTOM_PROVIDER_TOKEN": "secret", "SAFE_VALUE": "kept"}, clear=True):
            runner = verify.Verifier(arguments(profile="agent"))
        self.assertNotIn("OPENAI_API_KEY", runner.env)
        self.assertNotIn("BOX_API_KEY", runner.env)
        self.assertNotIn("CUSTOM_PROVIDER_TOKEN", runner.env)
        self.assertEqual(runner.env["SAFE_VALUE"], "kept")
        latest = runner.latest_payload("running")
        self.assertEqual(latest["run"], runner.run_id)
        self.assertEqual(latest["pid"], os.getpid())

    @mock.patch.object(verify, "source_evidence", return_value={"commit": "abc", "dirty": False, "fingerprint": "start"})
    def test_source_change_invalidates_a_passing_run(self, _evidence):
        runner = verify.Verifier(arguments(profile="web"))
        runner.status = "passed"
        changed = {"commit": "abc", "dirty": True, "fingerprint": "changed"}
        with mock.patch.object(verify, "source_evidence", return_value=changed):
            runner.write_report()
        self.assertEqual(runner.status, "failed")
        self.assertTrue(runner.source_changed)
        self.assertEqual(runner.failure["type"], "SourceChanged")

    def test_dirty_fingerprint_changes_with_untracked_content(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(["git", "init", "-q"], cwd=root, check=True)
            subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=root, check=True)
            subprocess.run(["git", "config", "user.name", "Test"], cwd=root, check=True)
            (root / "tracked").write_text("one")
            subprocess.run(["git", "add", "tracked"], cwd=root, check=True)
            subprocess.run(["git", "commit", "-qm", "initial"], cwd=root, check=True)
            clean = evidence.source_evidence(root)
            (root / "new").write_text("first")
            first = evidence.source_evidence(root)
            (root / "new").write_text("second")
            second = evidence.source_evidence(root)
        self.assertFalse(clean["dirty"])
        self.assertTrue(first["dirty"])
        self.assertNotEqual(first["fingerprint"], second["fingerprint"])

    def test_failure_diagnostics_keep_exit_facts_and_only_sanitized_startup_codes(self):
        runner = verify.Verifier(arguments())
        responses = [
            subprocess.CompletedProcess([], 0, "owned-container\n", ""),
            subprocess.CompletedProcess([], 0, '{"Status":"exited","ExitCode":1,"OOMKilled":false,"Error":"private-value"}', ""),
            subprocess.CompletedProcess([], 0, "private-value\nSTARTUP_PI_EACCES\n", "provider private-value"),
        ]
        with mock.patch.object(verify.subprocess, "run", side_effect=responses), mock.patch("builtins.print") as output:
            runner.diagnose_owned_resources()
        self.assertEqual(runner.container_diagnostics, [{"container": "owned-container", "Status": "exited",
            "ExitCode": 1, "OOMKilled": False, "startupCodes": ["STARTUP_PI_EACCES"]}])
        self.assertNotIn("private-value", str(output.call_args_list))


if __name__ == "__main__":
    unittest.main()
