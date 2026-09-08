#!/usr/bin/env python3
"""Behavior coverage for config preservation and workspace ownership; no live Herdr."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import tomllib
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('dev_herdr', Path(__file__).with_name('dev-herdr.py'))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ConfigTests(unittest.TestCase):
    def test_install_is_idempotent_and_preserves_unrelated_bindings(self):
        original = '[theme]\nname = "nord"\n[[keys.command]]\nkey="prefix+alt+g"\ntype="popup"\ncommand="lazygit"\n'
        first = MODULE.updated_config(original, Path('/tmp/bin with space/companions-dev'))
        self.assertEqual(first, MODULE.updated_config(first, Path('/tmp/bin with space/companions-dev')))
        config = tomllib.loads(first)
        self.assertEqual(config['theme']['name'], 'nord')
        self.assertEqual(len(config['keys']['command']), 4)
        self.assertIn("'/tmp/bin with space/companions-dev'", first)

    def test_conflicting_shortcut_refuses_without_overwriting(self):
        with self.assertRaisesRegex(RuntimeError, 'already configured'):
            MODULE.updated_config('[keys]\nnew_tab="prefix+d"\n', Path('/tmp/bin'))

    def test_custom_sidebar_is_preserved(self):
        original = '[ui.sidebar.spaces]\nrows=[["workspace"], ["$custom"]]\n'
        updated = tomllib.loads(MODULE.updated_config(original, Path('/tmp/bin')))
        self.assertEqual(updated['ui']['sidebar']['spaces']['rows'], [['workspace'], ['$custom']])

    def test_dispatcher_resolves_shortcut_context_and_preserves_direct_callers(self):
        cases = [
            ({'HERDR_ACTIVE_WORKSPACE_ID': 'w1', 'HERDR_ACTIVE_TAB_ID': 'w1:t2', 'HERDR_ACTIVE_PANE_ID': 'w1:p3'},
             {'HERDR_ENV': '1', 'HERDR_WORKSPACE_ID': 'w1', 'HERDR_TAB_ID': 'w1:t2', 'HERDR_PANE_ID': 'w1:p3'}),
            ({'HERDR_ENV': '1', 'HERDR_WORKSPACE_ID': 'w2', 'HERDR_TAB_ID': 'w2:t1', 'HERDR_PANE_ID': 'w2:p1', 'HERDR_ACTIVE_PANE_ID': 'w1:p3'},
             {'HERDR_ENV': '1', 'HERDR_WORKSPACE_ID': 'w2', 'HERDR_TAB_ID': 'w2:t1', 'HERDR_PANE_ID': 'w2:p1'}),
            ({}, {'HERDR_ENV': None, 'HERDR_WORKSPACE_ID': None, 'HERDR_TAB_ID': None, 'HERDR_PANE_ID': None}),
        ]
        with tempfile.TemporaryDirectory() as tmp:
            subprocess.run(['git', 'init', '-q', tmp], check=True)
            launcher = Path(tmp) / 'dispatch.py'
            launcher.write_text(MODULE.launcher())
            command = Path(tmp) / 'dev'
            command.write_text('#!' + sys.executable + '\n' + MODULE.MARKER + '\nimport os,json\nprint(json.dumps({k:os.environ.get(k) for k in ["HERDR_ENV","HERDR_WORKSPACE_ID","HERDR_TAB_ID","HERDR_PANE_ID"]}))\n')
            command.chmod(0o755)
            clean = {key: value for key, value in os.environ.items() if not key.startswith('HERDR_')}
            for supplied, expected in cases:
                with self.subTest(supplied=supplied):
                    result = subprocess.run([sys.executable, str(launcher), 'workspace'], cwd=tmp, env={**clean, **supplied}, capture_output=True, text=True, check=True)
                    self.assertEqual(json.loads(result.stdout), expected)

    def test_dispatcher_rejects_other_repositories(self):
        with tempfile.TemporaryDirectory() as tmp:
            subprocess.run(['git', 'init', '-q', tmp], check=True)
            launcher = Path(tmp) / 'dispatch.py'
            launcher.write_text(MODULE.launcher())
            (Path(tmp) / 'dev').write_text('#!/bin/sh\necho BAD\n')
            result = subprocess.run(['python3', str(launcher), 'down'], cwd=tmp, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn('BAD', result.stdout)


class WorkspaceTests(unittest.TestCase):
    def test_restart_reuses_owned_panes_and_does_not_send_input(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(MODULE, 'ROOT', Path(tmp)), patch.object(MODULE, 'dev', return_value=0), patch.object(MODULE, 'publish'), patch.object(MODULE, 'status', return_value={'status': 'ready'}):
            live = []
            calls = []
            def fake(*args):
                calls.append(args)
                if args[:2] == ('pane', 'current'):
                    return {'pane': {'workspace_id': 'w9', 'pane_id': 'w9:p0', 'tab_id': 'w9:t0'}}
                if args[:2] == ('pane', 'list'):
                    return {'panes': live}
                if args[:2] == ('pane', 'process-info'):
                    return {'process_info': {'foreground_process_group_id': 200, 'shell_pid': 100}}
                if args[:2] == ('pane', 'split'):
                    number = len(live) + 1
                    pane = {'pane_id': f'w9:p{number}', 'tab_id': f'w9:t{number}'}
                    live.append(pane)
                    return {'pane': pane}
                return {}
            with patch.object(MODULE, 'herdr', side_effect=fake), patch.object(MODULE.time, 'sleep'):
                MODULE.workspace()
                self.assertEqual(sum(call[:2] == ('pane', 'run') for call in calls), 1)
                calls.clear()
                MODULE.workspace()
                self.assertFalse(any(call[:2] in [('pane', 'run'), ('pane', 'split')] for call in calls))
                # Closing the dashboard creates only its replacement in the caller's tab.
                live.pop()
                MODULE.workspace()
                creates = [call for call in calls if call[:2] == ('pane', 'split')]
                self.assertEqual(len(creates), 1)
                self.assertIn('--no-focus', creates[0])
                self.assertEqual(creates[0][2], 'w9:p0')
                self.assertFalse(any(call[0] == 'tab' for call in calls))
                self.assertFalse(any('close' in call or 'focus' in call for call in calls))

    def test_controls_outside_herdr_fail_before_effects(self):
        with patch.dict(os.environ, {'HERDR_ENV': '0'}), patch.object(MODULE.subprocess, 'run') as run:
            with self.assertRaisesRegex(RuntimeError, 'Herdr-managed'):
                MODULE.workspace()
            run.assert_not_called()

    def test_metadata_has_short_expiry(self):
        with patch.dict(os.environ, {'HERDR_ENV': '1', 'HERDR_WORKSPACE_ID': 'w9'}), patch.object(MODULE, 'status', return_value={'status': 'ready', 'validation': {'status': 'stale'}}), patch.object(MODULE, 'herdr') as call:
            MODULE.publish()
            args = call.call_args.args
            self.assertIn('companions_tests=tests: stale', args)
            self.assertEqual(args[-2:], ('--ttl-ms', '15000'))


class DashboardTests(unittest.TestCase):
    def test_every_component_exposes_its_real_state_and_controls(self):
        rows, buttons = MODULE.panel_layout({'status': 'stopped', 'services': {
            'api': {'status': 'failed', 'url': 'http://user:password@localhost:3333/'},
            'postgres': {'status': 'stopped', 'port': 5555},
        }}, 45)
        text = '\n'.join(row[0] for row in rows)
        self.assertIn('API  failed', text)
        self.assertIn('Port 5555', text)
        self.assertNotIn('password', text)
        self.assertNotIn('user:', text)
        for service in MODULE.SERVICES:
            for action in ('start', 'stop', 'restart'):
                self.assertTrue(any(button['command'] == ['service', action, service] for button in buttons))
            self.assertTrue(any(button['command'] == ['logs', service] for button in buttons))
        self.assertTrue(any(button['command'] == ['open', 'api'] for button in buttons))
        for button in buttons:
            self.assertEqual(rows[button['row']][0][button['start']:button['end']], button['label'])

    def test_global_buttons_use_complete_stack_commands(self):
        rows, buttons = MODULE.panel_layout({}, 32)
        self.assertEqual([button['command'] for button in buttons[:3]], [['up'], ['restart'], ['down']])
        self.assertTrue(all(len(text) <= 32 for text, _ in rows if text.startswith('[')))

    def test_commands_run_asynchronously_and_preserve_failures(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(MODULE, 'ROOT', Path(tmp)):
            script = Path(tmp) / 'dev'
            script.write_text('#!/usr/bin/env python3\nimport time, sys\ntime.sleep(.15)\nprint("failed behavior")\nsys.exit(7)\n')
            script.chmod(0o755)
            command = MODULE.DashboardCommand()
            self.assertTrue(command.start(['check', 'web']))
            self.assertTrue(command.busy)
            self.assertFalse(command.start(['down']))
            command.process.wait(timeout=3)
            command.poll()
            self.assertEqual(command.last_code, 7)
            self.assertIn('failed (exit 7)', command.message)
            self.assertEqual(command.output[-1], 'failed behavior')
            self.assertIsNone(command.stream)

    def test_main_shortcut_opens_pane_without_modal_popup(self):
        config = tomllib.loads(MODULE.updated_config('', Path('/tmp/companions-dev')))
        shortcut = next(entry for entry in config['keys']['command'] if entry['key'] == 'prefix+d')
        self.assertEqual(shortcut['type'], 'shell')
        self.assertTrue(shortcut['command'].endswith(' workspace'))

    def test_terminal_escape_sequences_are_not_replayed_from_logs(self):
        self.assertEqual(MODULE.clean_display('hello\x1b[31mred\x1b[0m\x07'), 'hellored')


if __name__ == '__main__':
    unittest.main()
