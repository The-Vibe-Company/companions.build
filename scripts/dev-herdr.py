#!/usr/bin/env python3
"""Optional Herdr controls. Core development commands also work outside Herdr."""
import argparse
import concurrent.futures
import curses
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
import urllib.parse

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
                            capture_output=True, text=True, timeout=10)
    try:
        return json.loads(result.stdout)
    except ValueError:
        return {'state': 'unknown'}


def publish(current=None):
    if os.environ.get('HERDR_ENV') != '1':
        return
    workspace = os.environ.get('HERDR_WORKSPACE_ID')
    if not workspace:
        raise RuntimeError('HERDR_WORKSPACE_ID is missing.')
    current = status() if current is None else current
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
    """Install a single control panel alongside the caller, without switching tabs."""
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
        owned = saved['panes'].get('Dashboard', {})
        pane = live.get(owned.get('pane_id'))
        if pane and pane.get('tab_id') == owned.get('tab_id'):
            info = herdr('pane', 'process-info', '--pane', owned['pane_id'])['process_info']
            shell = info.get('shell_pid')
            if not shell or info.get('foreground_process_group_id') != shell:
                print('Control panel already has a foreground process; left untouched.')
                return 0
            pid = owned['pane_id']
        else:
            created = herdr('pane', 'split', caller['pane_id'], '--direction', 'right',
                            '--ratio', '0.45', '--cwd', str(ROOT), '--no-focus')
            pid = created['pane']['pane_id']
            saved['panes']['Dashboard'] = {'pane_id': pid, 'tab_id': created['pane']['tab_id']}
            atomic(state_path, json.dumps(saved, indent=2) + '\n')
            time.sleep(.5)
        herdr('pane', 'rename', pid, 'companions controls')
        herdr('pane', 'run', pid, shlex.join([str(ROOT / 'dev'), 'menu']))
    print('Control panel ready. Use Start all to start this worktree.')
    return 0


SERVICES = ('web', 'api', 'executor', 'worker', 'postgres', 'storage', 'mailpit')
ACTIONS = [
    ('Start all', ['up']), ('Restart all', ['restart']), ('Stop all', ['down']),
    ('Open app', ['open']), ('Web tests', ['check', 'web']),
    ('Server tests', ['check', 'server']), ('Agent tests', ['check', 'agent']),
    ('Full check', ['check', 'full']), ('Chat scenario', ['scenario', 'chat-ready']),
    ('Browser test', ['browser-test', 'chat-recovery']),
]


def clean_display(value):
    """Do not interpret terminal escape sequences from logs or service responses."""
    text = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', str(value))
    return ''.join(character for character in text if character.isprintable())


def panel_layout(current, width):
    """Return text rows and hit boxes shared by mouse and keyboard navigation."""
    width = max(12, width)
    rows = []
    buttons = []

    def line(text='', kind='normal'):
        rows.append((clean_display(text), kind))

    def controls(items):
        text = ''
        pending = []
        for label, command in items:
            label = '[' + label + ']'
            if text and len(text) + 1 + len(label) > width:
                rows.append((text, 'normal'))
                buttons.extend(pending)
                text, pending = '', []
            start = len(text) + (1 if text else 0)
            text += (' ' if text else '') + label
            pending.append({'row': len(rows), 'start': start, 'end': start + len(label),
                            'label': label, 'command': command})
        if text:
            rows.append((text, 'normal'))
            buttons.extend(pending)

    line('COMPANIONS.BUILD', 'title')
    line(ROOT.name, 'dim')
    line('App: ' + str(current.get('status', current.get('state', 'unknown'))),
         str(current.get('status', 'unknown')))
    controls(ACTIONS[:3])
    controls(ACTIONS[3:4])
    line()
    service_states = current.get('services') or {}
    for name in SERVICES:
        service = service_states.get(name) or {}
        state = str(service.get('status', 'unknown'))
        line(name.upper() + '  ' + state, state)
        url = service.get('url')
        if url:
            # Status URLs are local service endpoints. Never display URL credentials.
            parsed = urllib.parse.urlsplit(str(url))
            display = urllib.parse.urlunsplit((parsed.scheme, parsed.netloc.rsplit('@', 1)[-1], parsed.path, '', ''))
            row = len(rows)
            line(display, 'link')
            buttons.append({'row': row, 'start': 0, 'end': min(width, len(display)),
                            'label': display, 'command': ['open', name]})
        elif service.get('port'):
            line('Port ' + str(service['port']), 'dim')
        controls([(label, ['service', action, name]) for label, action in
                  [('Start', 'start'), ('Restart', 'restart'), ('Stop', 'stop')]] +
                 [('Logs', ['logs', name])])
        line()
    validation = current.get('validation') or {}
    line('VALIDATION', 'title')
    line(str(validation.get('status', 'unknown')) if isinstance(validation, dict) else str(validation))
    controls(ACTIONS[4:])
    return rows, buttons


class DashboardCommand:
    """One background operation at a time; persist output without blocking the UI."""
    def __init__(self):
        self.process = None
        self.stream = None
        self.path = ROOT / '.local/herdr-dashboard.log'
        self.message = 'Choose a command. Status reflects the running services.'
        self.output = []
        self.last_code = None

    @property
    def busy(self):
        return self.process is not None and self.process.poll() is None

    def start(self, command):
        if self.busy:
            self.message = 'A command is still running. Wait for its result.'
            return False
        self.poll()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.stream = self.path.open('w')
        self.path.chmod(0o600)
        self.output = []
        self.last_code = None
        try:
            self.process = subprocess.Popen([str(ROOT / 'dev'), *command], cwd=ROOT,
                                            stdin=subprocess.DEVNULL, stdout=self.stream,
                                            stderr=subprocess.STDOUT)
        except OSError:
            self.stream.close()
            self.stream = None
            raise
        self.message = 'Running: ./dev ' + ' '.join(command)
        return True

    def poll(self):
        if self.process is not None:
            code = self.process.poll()
            if code is not None:
                self.last_code = code
                self.message = 'Command finished: ' + ('passed' if code == 0 else f'failed (exit {code})')
                self.process = None
                if self.stream:
                    self.stream.close()
                    self.stream = None
        try:
            with self.path.open('rb') as stream:
                stream.seek(0, 2)
                stream.seek(max(0, stream.tell() - 12000))
                self.output = [clean_display(line) for line in stream.read().decode('utf-8', errors='replace').splitlines()[-40:]]
        except OSError:
            self.output = []


def dashboard(screen):
    curses.curs_set(0)
    curses.mousemask(curses.ALL_MOUSE_EVENTS)
    curses.mouseinterval(0)
    screen.timeout(150)
    screen.keypad(True)
    if curses.has_colors():
        curses.start_color()
        curses.use_default_colors()
        for pair, color in ((1, curses.COLOR_CYAN), (2, curses.COLOR_GREEN), (3, curses.COLOR_YELLOW), (4, curses.COLOR_RED)):
            curses.init_pair(pair, color, -1)
    palette = {'title': curses.A_BOLD, 'dim': curses.A_DIM,
               'ready': curses.color_pair(2), 'running': curses.color_pair(2),
               'starting': curses.color_pair(3), 'stopped': curses.A_DIM,
               'failed': curses.color_pair(4), 'unhealthy': curses.color_pair(4),
               'link': curses.color_pair(1) | curses.A_UNDERLINE}
    current = {'status': 'loading'}
    commands = DashboardCommand()
    pool = concurrent.futures.ThreadPoolExecutor(max_workers=2)
    pending = None
    metadata = None
    next_poll = 0
    selected = 0
    scroll = 0
    show_output = False

    def put(row, column, text, attributes=0):
        height, width = screen.getmaxyx()
        if row < 0 or row >= height or column >= width - 1:
            return
        try:
            screen.addnstr(row, column, clean_display(text), max(0, width - column - 1), attributes)
        except curses.error:
            pass

    try:
        while True:
            now = time.monotonic()
            if pending is not None and pending.done():
                try:
                    current = pending.result()
                except Exception:
                    current = {'status': 'unavailable'}
                pending = None
                next_poll = now + 2
                if metadata is None or metadata.done():
                    metadata = pool.submit(publish, current)
            if pending is None and now >= next_poll:
                pending = pool.submit(status)
            commands.poll()
            height, width = screen.getmaxyx()
            rows, buttons = panel_layout(current, width - 2)
            selected = min(selected, len(buttons) - 1)
            body_height = max(1, height - 5)
            scroll = max(0, min(scroll, max(0, len(rows) - body_height)))
            screen.erase()
            if show_output:
                put(0, 0, 'COMMAND OUTPUT · Esc to return', curses.A_BOLD)
                for index, text in enumerate(commands.output[-max(1, height - 5):], 1):
                    put(index, 0, text)
            else:
                for index, (text, kind) in enumerate(rows[scroll:scroll + body_height]):
                    put(index, 0, text, palette.get(kind, 0))
                if buttons:
                    button = buttons[selected]
                    if scroll <= button['row'] < scroll + body_height:
                        put(button['row'] - scroll, button['start'], button['label'], curses.A_REVERSE)
            put(height - 4, 0, commands.message, curses.color_pair(3) if commands.busy else 0)
            if commands.output:
                put(height - 3, 0, commands.output[-1], curses.A_DIM)
            put(height - 2, 0, 'Tab/↑↓ choose · Enter run · click buttons')
            put(height - 1, 0, 'PgUp/PgDn scroll · o output · r refresh · q close', curses.A_DIM)
            screen.refresh()
            key = screen.getch()
            if key == -1:
                continue
            if key in (ord('q'), 27):
                if show_output:
                    show_output = False
                elif commands.busy:
                    commands.message = 'Command running; wait before closing the panel.'
                else:
                    break
                continue
            if key == ord('o'):
                show_output = not show_output
                continue
            if key == ord('r'):
                next_poll = 0
                continue
            if show_output:
                continue
            activate = False
            if key in (9, curses.KEY_DOWN, curses.KEY_RIGHT):
                selected = (selected + 1) % len(buttons)
            elif key in (curses.KEY_BTAB, curses.KEY_UP, curses.KEY_LEFT):
                selected = (selected - 1) % len(buttons)
            elif key in (10, 13, curses.KEY_ENTER):
                activate = True
            elif key == curses.KEY_NPAGE:
                scroll += body_height
                continue
            elif key == curses.KEY_PPAGE:
                scroll -= body_height
                continue
            elif key == curses.KEY_MOUSE:
                try:
                    _, x, y, _, event = curses.getmouse()
                except curses.error:
                    continue
                if event & (curses.BUTTON1_CLICKED | curses.BUTTON1_PRESSED):
                    for index, button in enumerate(buttons):
                        if button['row'] == y + scroll and button['start'] <= x < button['end']:
                            selected = index
                            activate = True
                            break
                else:
                    continue
            else:
                continue
            selected_row = buttons[selected]['row']
            if selected_row < scroll:
                scroll = selected_row
            elif selected_row >= scroll + body_height:
                scroll = selected_row - body_height + 1
            if activate:
                try:
                    if commands.start(buttons[selected]['command']):
                        show_output = buttons[selected]['command'][0] == 'logs'
                        next_poll = 0
                except OSError as error:
                    commands.message = 'Could not start command: ' + str(error)
    finally:
        pool.shutdown(wait=False, cancel_futures=True)
    return 0


def menu():
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        raise RuntimeError('The dashboard needs an interactive terminal. Use ./dev --help for CLI commands.')
    return curses.wrapper(dashboard)


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
    bindings = [('prefix+d', 'workspace'), ('prefix+alt+u', 'workspace'), ('prefix+alt+t', 'check full')]
    for key, _ in bindings:
        if key in existing:
            raise RuntimeError(f'Herdr shortcut {key} is already configured; config left unchanged.')
    blocks = [BEGIN]
    for key, action in bindings:
        blocks.append('\n[[keys.command]]\nkey = ' + json.dumps(key) + ('\ntype = "shell"\ncommand = ' if action == 'workspace' else '\ntype = "popup"\ncommand = ') + json.dumps(shlex.quote(str(dispatch)) + ' ' + action) + '\nwidth = "85%"\nheight = "80%"')
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
    print(f'Installed {dispatch}\nHerdr: prefix+d controls; prefix+alt+u controls; prefix+alt+t full validation.')
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
