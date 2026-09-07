"""Ownership and isolation regressions for the local launcher; no provider effects."""
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('dev_cli', Path(__file__).with_name('dev-cli.py'))
cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cli)

class IsolationTests(unittest.TestCase):
    def test_local_environment_does_not_inherit_hosted_configuration(self):
        with patch.dict(os.environ, {'DATABASE_URL': 'postgres://remote', 'BOX_API_KEY': 'secret',
                                    'AGENT_TEST_MODE': '0', 'PORTLESS_FUNNEL': '1', 'PATH': '/bin'}, clear=True):
            env = cli.local_env()
        self.assertNotIn('DATABASE_URL', env)
        self.assertNotIn('BOX_API_KEY', env)
        self.assertNotIn('PORTLESS_FUNNEL', env)
        self.assertEqual(env['AGENT_TEST_MODE'], '1')
        self.assertEqual(env['BILLING_TEST_MODE'], '1')

    def test_recycled_pid_is_not_an_owned_supervisor(self):
        def ps(args, **kwargs):
            return subprocess.CompletedProcess(args, 0, 'different start\n' if args[-1] == 'lstart=' else str(cli.ROOT / 'scripts/dev.py'))
        with patch.object(cli.subprocess, 'run', side_effect=ps):
            self.assertFalse(cli.alive({'pid': 999, 'identity': 'original start'}))

    def test_same_time_but_different_process_is_not_owned(self):
        def ps(args, **kwargs):
            return subprocess.CompletedProcess(args, 0, 'same start\n' if args[-1] == 'lstart=' else 'unrelated server')
        with patch.object(cli.subprocess, 'run', side_effect=ps):
            self.assertFalse(cli.alive({'pid': 999, 'identity': 'same start'}))

    def test_dead_supervisor_cannot_report_ready(self):
        with patch.object(cli, 'read_json', return_value={'status': 'ready', 'services': {'api': {'pid': 9}}}), patch.object(cli, 'alive', return_value=False):
            self.assertEqual(cli.status()['status'], 'failed')

    def test_lock_excludes_a_second_process_and_releases_after_exit(self):
        import dev_support
        with tempfile.TemporaryDirectory() as tmp, patch.object(dev_support, 'LOCAL', Path(tmp)):
            handle = dev_support.lock('stack.lock')
            code = 'import fcntl,sys; f=open(sys.argv[1],"a+"); fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)'
            path = str(Path(tmp) / 'stack.lock')
            blocked = subprocess.run(['python3', '-c', code, path], capture_output=True)
            self.assertNotEqual(blocked.returncode, 0)
            handle.close()
            available = subprocess.run(['python3', '-c', code, path], capture_output=True)
            self.assertEqual(available.returncode, 0)

if __name__ == '__main__':
    unittest.main()
