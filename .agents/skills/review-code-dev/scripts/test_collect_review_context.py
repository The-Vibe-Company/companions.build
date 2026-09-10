#!/usr/bin/env python3
"""Behavior checks for branch scope and credential redaction in review artifacts."""

import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("collect_review_context", Path(__file__).with_name("collect_review_context.py"))
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


class ReviewContextTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.repo = Path(self.temporary.name)
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.name", "Skill Test")
        self.git("config", "user.email", "skill-test@example.invalid")
        (self.repo / "config.txt").write_text("initial\n")
        self.git("add", ".")
        self.git("commit", "-qm", "initial fixture")

    def git(self, *args):
        env = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}
        return subprocess.run(["git", "-C", str(self.repo), *args], env=env, check=True, capture_output=True, text=True).stdout.strip()

    def test_credentials_are_redacted_in_every_patch_mode(self):
        token = "sk-" + "synthetic-test-only" * 3
        assignment = "synthetic-password-value"
        (self.repo / "config.txt").write_text(f'api_key = "{token}"\npassword = "{assignment}"\n')
        unstaged = collector.collect_uncommitted(self.repo, 100_000)["diff"]["text"]
        self.git("add", "config.txt")
        staged = collector.collect_worktree_state(self.repo, 100_000)["staged_diff"]["text"]
        base = collector.git(["rev-parse", "HEAD"], self.repo)["stdout"].strip()
        self.git("commit", "-qm", "credential fixture")
        branch = collector.collect_base(self.repo, base, 100_000)["diff"]["text"]
        commit = collector.collect_commit(self.repo, "HEAD", 100_000)["diff"]["text"]
        for patch in (unstaged, staged, branch, commit):
            self.assertIn("<redacted", patch)
            self.assertNotIn(token, patch)
            self.assertNotIn(assignment, patch)
            self.assertIn("config.txt", patch)
        clipped = collector.truncate_text(token, 12)
        self.assertNotIn("synthetic", clipped["text"])

    def test_base_scope_excludes_base_only_commits_and_keeps_local_edits(self):
        fork = self.git("rev-parse", "HEAD")
        self.git("checkout", "-qb", "feature")
        (self.repo / "feature.txt").write_text("branch change\n")
        self.git("add", "feature.txt")
        self.git("commit", "-qm", "branch fixture")
        self.git("checkout", "-q", "main")
        (self.repo / "base-only.txt").write_text("base change\n")
        self.git("add", "base-only.txt")
        self.git("commit", "-qm", "base fixture")
        self.git("checkout", "-q", "feature")
        (self.repo / "config.txt").write_text("local staged change\n")
        self.git("add", "config.txt")
        (self.repo / "feature.txt").write_text("local unstaged change\n")
        context = collector.collect_base(self.repo, "main", 100_000)
        self.assertEqual(fork, context["merge_base"])
        self.assertEqual(["config.txt", "feature.txt"], context["changed_files"])
        self.assertNotIn("base-only.txt", context["diff"]["text"])
        self.assertIn("local staged change", context["diff"]["text"])
        self.assertIn("local unstaged change", context["diff"]["text"])


if __name__ == "__main__":
    unittest.main()
