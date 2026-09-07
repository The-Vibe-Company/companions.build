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
    @mock.patch.object(verify.subprocess, "run")
    def test_cleanup_records_owned_resources(self, run, _toolchain):
        run.side_effect = [
            subprocess.CompletedProcess([], 0, "one\ntwo\n", ""),
            subprocess.CompletedProcess([], 0),
            subprocess.CompletedProcess([], 0, "volume\n", ""),
            subprocess.CompletedProcess([], 0),
        ]
        with mock.patch.object(verify, "source_evidence", return_value={"commit": "abc", "dirty": False, "fingerprint": "123"}):
            runner = verify.Verifier(arguments())
        runner.clean_owned_resources()
        self.assertEqual(runner.cleanup["status"], "passed")
        self.assertEqual(runner.cleanup["containers"], {"found": 2, "removed": 2})
        self.assertEqual(runner.cleanup["volumes"], {"found": 1, "removed": 1})

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


if __name__ == "__main__":
    unittest.main()
