"""Ownership and isolation regressions for the local launcher; no provider effects."""
import importlib.util
import os
from pathlib import Path
import subprocess
import json
import signal
import socket
import shlex
import sys
import time
import tempfile
import unittest
from contextlib import nullcontext
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('dev_cli', Path(__file__).with_name('dev-cli.py'))
cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cli)

class IsolationTests(unittest.TestCase):
    def test_relative_bun_launcher_requires_matching_worktree_directory(self):
        for directory, expected in [(str(cli.ROOT), True), ('/another/worktree', False)]:
            with self.subTest(directory=directory):
                def observe(args, **kwargs):
                    output = ('same start\n' if args[-1] == 'lstart=' else
                              f'p999999\nfcwd\nn{directory}\n' if args[0] == 'lsof' else
                              'python3 scripts/dev.py\n')
                    return subprocess.CompletedProcess(args, 0, output)
                with patch.object(cli.subprocess, 'run', side_effect=observe):
                    self.assertEqual(cli.alive({'pid': 999999, 'identity': 'same start'}), expected)


    def test_legacy_endpoints_keep_existing_service_port_block(self):
        with patch.object(cli, 'read_json', return_value={'webPort': 17140, 'apiPort': 17141}):
            self.assertEqual(cli.choose_base(), 17140)

    def test_explicit_base_wins_over_portless_web_port(self):
        with patch.object(cli, 'read_json', return_value={'basePort': 17140, 'webPort': 32000, 'apiPort': 32001}):
            self.assertEqual(cli.choose_base(), 17140)


    def test_occupied_service_port_is_reported_without_disrupting_its_owner(self):
        from dev_support import check_service_ports
        with socket.socket() as owner:
            owner.bind(('127.0.0.1', 0))
            owner.listen()
            port = owner.getsockname()[1]
            with self.assertRaisesRegex(RuntimeError, f"api cannot start: local port {port}"):
                check_service_ports({'api': port})
            with socket.create_connection(('127.0.0.1', port), timeout=1):
                pass
        check_service_ports({'api': port})


    def test_hard_parent_crash_cannot_launch_an_unrecorded_service(self):
        for phase in ('before_record', 'before_release', 'after_release'):
            with self.subTest(phase=phase), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                marker, journal = root / 'started', root / 'ownership.json'
                service = ['/bin/sh', '-c', f'touch {shlex.quote(str(marker))}; sleep 60; :']
                code = '''import sys,json,time
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from dev_support import launch_owned,write_json
phase,journal=sys.argv[2:4]
def persist(child,record):
    if phase != 'before_record': write_json(Path(journal),record)
    print(child.pid,flush=True)
    if phase != 'after_release': sys.stdin.readline()
launch_owned(json.loads(sys.argv[4]),persist)
time.sleep(60)
'''
                parent = subprocess.Popen([sys.executable, '-c', code, str(cli.ROOT / 'scripts'), phase,
                                           str(journal), json.dumps(service)], stdin=subprocess.PIPE,
                                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                child_pid = None
                try:
                    child_pid = int(parent.stdout.readline())
                    if phase == 'after_release':
                        deadline = time.monotonic() + 5
                        while not marker.exists() and time.monotonic() < deadline:
                            time.sleep(.02)
                        self.assertTrue(marker.exists())
                    parent.kill()
                    parent.wait(timeout=5)
                    if phase == 'after_release':
                        record = json.loads(journal.read_text())
                        command = subprocess.check_output(['ps', '-p', str(child_pid), '-o', 'command='], text=True).strip()
                        identity = subprocess.check_output(['ps', '-p', str(child_pid), '-o', 'lstart='], text=True).strip()
                        self.assertEqual(record['command'], command)
                        self.assertEqual(record['identity'], identity)
                    else:
                        deadline = time.monotonic() + 5
                        while time.monotonic() < deadline:
                            result = subprocess.run(['ps', '-p', str(child_pid), '-o', 'stat='], capture_output=True, text=True)
                            if result.returncode or result.stdout.strip().startswith('Z'):
                                break
                            time.sleep(.02)
                        else:
                            self.fail('Unreleased child survived its parent')
                        self.assertFalse(marker.exists())
                finally:
                    if parent.poll() is None:
                        parent.kill()
                    if child_pid is not None:
                        try:
                            os.killpg(child_pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                    parent.communicate(timeout=5)

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
        with patch.object(cli, 'read_json', side_effect=[{'status': 'ready', 'services': {'api': {'pid': 9}}}, {}]), patch.object(cli, 'alive', return_value=False):
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

    def test_start_all_resumes_only_stopped_components(self):
        state = {'status': 'degraded', 'url': 'http://app.localhost', 'services': {
            name: {'status': 'stopped' if name == 'worker' else 'ready'}
            for name in cli.SERVICES}}
        with patch.object(cli, 'status', return_value=state), patch.object(cli, 'alive', return_value=True), \
             patch.object(cli, 'lock', return_value=nullcontext()), patch.object(cli, '_service_action') as action:
            cli.up()
        action.assert_called_once_with('start', 'worker')

    def test_process_exit_race_does_not_interrupt_shutdown(self):
        import dev_support
        from unittest.mock import Mock
        child = Mock(pid=999)
        child.poll.return_value = None
        with patch.object(dev_support.os, 'killpg', side_effect=ProcessLookupError):
            dev_support.terminate_process(child)
        child.wait.assert_called_once_with(timeout=10)

if __name__ == '__main__':
    unittest.main()
