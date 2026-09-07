#!/usr/bin/env python3
"""Behavior coverage for config preservation and workspace ownership; no live Herdr."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
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
                    return {'pane': {'workspace_id': 'w9'}}
                if args[:2] == ('pane', 'list'):
                    return {'panes': live}
                if args[:2] == ('tab', 'create'):
                    number = len(live) + 1
                    pane = {'pane_id': f'w9:p{number}', 'tab_id': f'w9:t{number}'}
                    live.append(pane)
                    return {'root_pane': pane, 'tab': {'tab_id': pane['tab_id']}}
                return {}
            with patch.object(MODULE, 'herdr', side_effect=fake):
                MODULE.workspace()
                self.assertEqual(sum(call[:2] == ('pane', 'run') for call in calls), 2)
                calls.clear()
                MODULE.workspace()
                self.assertFalse(any(call[:2] in [('pane', 'run'), ('tab', 'create')] for call in calls))
                # Closing one owned tab creates only its replacement.
                live.pop()
                MODULE.workspace()
                creates = [call for call in calls if call[:2] == ('tab', 'create')]
                self.assertEqual(len(creates), 1)
                self.assertIn('--no-focus', creates[0])
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


if __name__ == '__main__':
    unittest.main()
