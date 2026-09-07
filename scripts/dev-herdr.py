#!/usr/bin/env python3
"""Optional Herdr controls. Core development commands also work outside Herdr."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile
import time
import tomllib

ROOT = Path(__file__).resolve().parents[1]
BEGIN = '# BEGIN companions.build controls'
END = '# END companions.build controls'
MARKER = '# companions.build development entrypoint; works from any current directory.'


def herdr(*args):
    if os.environ.get('HERDR_ENV') != '1':
        raise RuntimeError('Herdr controls require a Herdr-managed pane (HERDR_ENV=1).')
    result = subprocess.run(['herdr', *args], text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError('Herdr command failed: ' + ' '.join(args[:2]))
    # pane run is intentionally silent on success in Herdr 0.8.2.
    return json.loads(result.stdout).get('result', {}) if result.stdout.strip() else {}


def atomic(path, content, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=path.name + '.')
    try:
        with os.fdopen(fd, 'w') as stream:
            stream.write(content)
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def dev(*args):
    return subprocess.run([str(ROOT / 'dev'), *args], cwd=ROOT).returncode


def status():
    result = subprocess.run([str(ROOT / 'dev'), 'status', '--json'], cwd=ROOT,
                            capture_output=True, text=True)
    try:
        return json.loads(result.stdout)
    except ValueError:
        return {'state': 'unknown'}


def publish():
    if os.environ.get('HERDR_ENV') != '1':
        return
    workspace = os.environ.get('HERDR_WORKSPACE_ID')
    if not workspace:
        raise RuntimeError('HERDR_WORKSPACE_ID is missing.')
    current = status()
    app = str(current.get('state', current.get('status', 'unknown')))
    tests = current.get('validation', {})
    tests = tests.get('state', tests.get('status', 'unknown')) if isinstance(tests, dict) else tests
    herdr('workspace', 'report-metadata', workspace, '--source', 'companions-dev',
          '--token', 'companions_app=app: ' + app[:32],
          '--token', 'companions_tests=tests: ' + str(tests or 'unknown')[:32],
          '--ttl-ms', '15000')


def watch():
    previous = None
    while True:
        current = status()
        display = json.dumps({key: current.get(key) for key in ('status', 'url', 'validation')}, sort_keys=True)
        if display != previous:
            print(display, flush=True)
            previous = display
        try:
            publish()
        except RuntimeError as error:
            print(error, file=sys.stderr, flush=True)
        time.sleep(5)


def workspace():
    # Context is validated before starting any services or creating UI resources.
    caller = herdr('pane', 'current', '--current')['pane']
    wid = caller['workspace_id']
    state_path = ROOT / '.local/herdr.json'
    state_path.parent.mkdir(parents=True, exist_ok=True)
    with (state_path.parent / 'herdr.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            saved = json.loads(state_path.read_text())
        except (OSError, ValueError):
            saved = {}
        identity = {'root': str(ROOT), 'workspace_id': wid,
                    'session': os.environ.get('HERDR_SESSION', ''),
                    'socket': os.environ.get('HERDR_SOCKET_PATH', '')}
        if any(saved.get(k) != v for k, v in identity.items()):
            saved = {**identity, 'panes': {}}
        live = {p['pane_id']: p for p in herdr('pane', 'list', '--workspace', wid)['panes']}
        for role in ('Services', 'Tests'):
            owned = saved['panes'].get(role, {})
            pane = live.get(owned.get('pane_id'))
            # Do not send commands into a reused, moved, or repurposed pane.
            if pane and pane.get('tab_id') == owned.get('tab_id'):
                info = herdr('pane', 'process-info', '--pane', owned['pane_id'])['process_info']
                if info.get('foreground_process_group_id') != info.get('shell_pid'):
                    continue
                pid = owned['pane_id']
            else:
                created = herdr('tab', 'create', '--workspace', wid, '--cwd', str(ROOT),
                                '--label', 'companions ' + role, '--no-focus')
                pid = created['root_pane']['pane_id']
                saved['panes'][role] = {'pane_id': pid, 'tab_id': created['tab']['tab_id']}
                atomic(state_path, json.dumps(saved, indent=2) + '\n')
                # Let the new interactive shell initialize before submitting input.
                time.sleep(.5)
            command = [sys.executable, str(Path(__file__).resolve()), 'watch'] if role == 'Services' else [str(ROOT / 'dev'), 'menu']
            herdr('pane', 'run', pid, shlex.join(command))
    result = dev('up')
    publish()
    current = status()
    herdr('notification', 'show', 'companions.build', '--body',
          ('Ready: ' + str(current.get('url', ''))) if result == 0 and current.get('status') == 'ready'
          else 'Startup has not reached ready; see ./dev status and ./dev logs.', '--sound', 'none')
    return result


ACTIONS = [
    ('Start app', ['up']), ('Open app', ['open']),
    ('Test web', ['check', 'web']), ('Test server', ['check', 'server']),
    ('Test agent', ['check', 'agent']), ('Full validation', ['check', 'full']),
    ('Prepare chat scenario', ['scenario', 'chat-ready']),
    ('Browser chat recovery', ['browser-test', 'chat-recovery']),
    ('Logs', ['logs']), ('Restart', ['restart']), ('Stop', ['down']),
]


def menu():
    if not sys.stdin.isatty():
        raise RuntimeError('The menu needs an interactive terminal. Use ./dev --help for CLI commands.')
    while True:
        current = status()
        print('\ncompanions.build · ' + ROOT.name)
        print('App: ' + str(current.get('state', current.get('status', 'unknown'))))
        for index, (label, _) in enumerate(ACTIONS, 1):
            print(f'{index:2}. {label}')
        print(' q. Close menu')
        try:
            choice = input('Command: ').strip().lower()
        except EOFError:
            return 0
        if choice in ('q', 'quit', 'exit'):
            return 0
        if choice.isdigit() and 1 <= int(choice) <= len(ACTIONS):
            result = dev(*ACTIONS[int(choice) - 1][1])
            print(f'Command exited with status {result}')
            try:
                publish()
            except RuntimeError as error:
                print(error, file=sys.stderr)


def launcher():
    return '''#!/usr/bin/env python3
# companions.build managed dispatcher
import pathlib, subprocess, sys
result = subprocess.run(['git', 'rev-parse', '--show-toplevel'], capture_output=True, text=True)
if result.returncode:
    sys.exit('Run this command inside a companions.build worktree.')
root = pathlib.Path(result.stdout.strip())
command = root / 'dev'
if not command.is_file() or '# companions.build development entrypoint; works from any current directory.' not in command.read_text()[:4096]:
    sys.exit('This worktree does not provide the companions.build developer CLI.')
sys.exit(subprocess.call([str(command), *sys.argv[1:]], cwd=root))
'''


def updated_config(original, dispatch):
    text = re.sub(re.escape(BEGIN) + r'.*?' + re.escape(END) + r'\n?', '', original, flags=re.S)
    config = tomllib.loads(text)
    keys = config.get('keys', {})
    existing = [entry.get('key') for entry in keys.get('command', [])]
    existing += [value for value in keys.values() if isinstance(value, str)]
    bindings = [('prefix+d', 'menu'), ('prefix+alt+u', 'workspace'), ('prefix+alt+t', 'check full')]
    for key, _ in bindings:
        if key in existing:
            raise RuntimeError(f'Herdr shortcut {key} is already configured; config left unchanged.')
    blocks = [BEGIN]
    for key, action in bindings:
        blocks.append('\n[[keys.command]]\nkey = ' + json.dumps(key) + '\ntype = "popup"\ncommand = ' + json.dumps(shlex.quote(str(dispatch)) + ' ' + action) + '\nwidth = "85%"\nheight = "80%"')
    # Preserve customized sidebar rows; provide metadata through the existing token API.
    if 'spaces' not in config.get('ui', {}).get('sidebar', {}):
        blocks.append('\n[ui.sidebar.spaces]\nrows = [["state_icon", "workspace"], ["branch", "git_status"], ["$companions_app"], ["$companions_tests"]]')
    blocks.append(END)
    candidate = text.rstrip() + '\n\n' + '\n'.join(blocks) + '\n'
    tomllib.loads(candidate)
    return candidate


def install():
    if os.environ.get('HERDR_ENV') != '1':
        raise RuntimeError('Install from a Herdr-managed pane (HERDR_ENV=1).')
    config = Path(os.environ.get('HERDR_CONFIG_PATH', str(Path.home() / '.config/herdr/config.toml'))).expanduser()
    dispatch = Path.home() / '.local/bin/companions-dev'
    original = config.read_text() if config.exists() else ''
    candidate = updated_config(original, dispatch)
    if dispatch.exists() and 'companions.build managed dispatcher' not in dispatch.read_text():
        raise RuntimeError(f'Refusing to replace unrelated launcher: {dispatch}')
    config.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='companions-herdr-') as temporary:
        staged = Path(temporary) / 'config.toml'
        staged.write_text(candidate)
        checked = subprocess.run(['herdr', 'config', 'check'], capture_output=True, text=True,
                                 env={**os.environ, 'HERDR_CONFIG_PATH': str(staged)})
        if checked.returncode:
            raise RuntimeError('Herdr rejected the generated config; existing files left unchanged.')
    if original != candidate and original:
        backup = config.with_name(config.name + '.companions-' + hashlib.sha256(original.encode()).hexdigest()[:12] + '.bak')
        if not backup.exists():
            atomic(backup, original)
    atomic(dispatch, launcher(), 0o755)
    if original != candidate:
        atomic(config, candidate)
    herdr('server', 'reload-config')
    print(f'Installed {dispatch}\nHerdr: prefix+d menu; prefix+alt+u workspace; prefix+alt+t full validation.')
    if 'spaces' in tomllib.loads(original).get('ui', {}).get('sidebar', {}):
        print('Custom sidebar preserved. Add $companions_app and $companions_tests to its rows to display status.')
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['menu', 'workspace', 'install', 'publish', 'watch'])
    args = parser.parse_args()
    try:
        return globals()[args.command]() or 0
    except (RuntimeError, OSError, ValueError, KeyError) as error:
        print(str(error), file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == '__main__':
    sys.exit(main())
