import argparse
import importlib.util
from pathlib import Path
import subprocess
import unittest
from unittest import mock

SCRIPT = Path(__file__).with_name("check.py")
SPEC = importlib.util.spec_from_file_location("check", SCRIPT)
check = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(check)


class CheckTest(unittest.TestCase):
    def test_server_pattern_is_forwarded(self):
        args = argparse.Namespace(profile="server", test="retirement")
        self.assertEqual(check.command_for(args)[-4:], ["--profile", "server", "--test", "retirement"])

    def test_web_rejects_server_pattern(self):
        with self.assertRaises(SystemExit):
            check.parse_args(["web", "--test", "chat"])

    def test_full_verification_cannot_silently_skip_server_suites(self):
        with self.assertRaises(SystemExit):
            check.parse_args(["full", "--test", "chat"])

    @mock.patch.object(subprocess, "run")
    def test_exit_code_is_preserved(self, run):
        run.return_value.returncode = 7
        self.assertEqual(check.main(["agent"]), 7)
        self.assertEqual(run.call_args.kwargs["cwd"], check.ROOT)


if __name__ == "__main__":
    unittest.main()
