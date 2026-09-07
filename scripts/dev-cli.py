"""Worktree-local development commands. All effects are scoped to this checkout."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import signal
import socket
import subprocess
import sys
import time
import urllib.request

from dev_support import ROOT, LOCAL, lock, prepare, proxy_command, read_json, write_json

STATE = LOCAL / 'dev-state.json'

def alive(state):
    pid = state.get('pid')
    if not isinstance(pid, int) or pid < 2:
        return False
    identity = subprocess.run(['ps', '-p', str(pid), '-o', 'lstart='], capture_output=True, text=True)
    command = subprocess.run(['ps', '-p', str(pid), '-o', 'command='], capture_output=True, text=True)
    return (identity.returncode == 0 and identity.stdout.strip() == state.get('identity')
            and str(ROOT / 'scripts/dev.py') in command.stdout)

def status():
    state = read_json(STATE)
    if not alive(state):
        state['status'] = 'stopped' if state.get('status') == 'stopped' or not state else 'failed'
        state['services'] = {}
    elif state.get('status') == 'ready':
        for service in state.get('services', {}).values():
            try:
                os.kill(service['pid'], 0)
            except (ProcessLookupError, KeyError):
                state['status'] = 'failed'
        try:
            port = state['endpoints']['apiPort']
            with urllib.request.urlopen(f'http://127.0.0.1:{port}/health', timeout=1) as response:
                if response.status != 200:
                    state['status'] = 'failed'
        except Exception:
            state['status'] = 'failed'
    return state

def local_env():
    # A development stack never inherits hosted credentials or a hosted DATABASE_URL.
    result = {key: value for key, value in os.environ.items() if key in
              {'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'TERM'}
              or key.startswith(('LC_', 'DOCKER_', 'HERDR_'))}
    result.update(COMPANIONS_DEV_LOCAL='1', AGENT_TEST_MODE='1', BILLING_TEST_MODE='1',
                  LOCAL_RUNTIME='1', EMAIL_PROVIDER='smtp', NODE_ENV='development',
                  COMPANIONS_DATA_DIR=str(LOCAL), COMPANIONS_DEV_WATCH=os.environ.get('COMPANIONS_DEV_WATCH', '1'))
    return result

def choose_base():
    previous = read_json(LOCAL / 'dev-endpoints.json').get('basePort')
    if previous:
        return int(previous)
    initial = 10000 + int(hashlib.sha256(str(ROOT).encode()).hexdigest()[:4], 16) % 3000 * 10
    for offset in range(100):
        candidate = initial + offset * 10
        sockets = []
        try:
            for port in range(candidate, candidate + 7):
                sock = socket.socket()
                sockets.append(sock)
                sock.bind(('127.0.0.1', port))
            return candidate
        except OSError:
            continue
        finally:
            for sock in sockets:
                sock.close()
    raise RuntimeError('No free local port block; stop owned services or choose another worktree.')

def up(direct=False):
    with lock('dev-command.lock', blocking=True):
        current = status()
        if alive(current):
            if current['status'] == 'ready':
                print(current['url'])
                return
            raise RuntimeError('Stack is already starting/restarting or unhealthy. Inspect ./dev logs.')
        LOCAL.mkdir(exist_ok=True, mode=0o700)
        env = local_env()
        env['CONDUCTOR_PORT'] = str(choose_base())
        command = [sys.executable, str(ROOT / 'scripts/dev.py')]
        proxy = read_json(LOCAL / 'dev-options.json').get('portless', False) and not direct
        if proxy:
            options = read_json(LOCAL / 'dev-options.json')
            env.update(PORTLESS_PORT=str(options.get('proxyPort', 1355)), PORTLESS_HTTPS='1' if options.get('https') else '0',
                       PORTLESS_LAN='0', PORTLESS_SYNC_HOSTS='0', PORTLESS_TAILSCALE='0', PORTLESS_FUNNEL='0', PORTLESS_NGROK='0',
                       PORTLESS_STATE_DIR=str(Path.home() / '.local/state/companions-portless'))
            name = re.sub('[^a-z0-9-]', '-', ROOT.name.lower())[:35].strip('-') or 'worktree'
            name += '-' + hashlib.sha256(str(ROOT).encode()).hexdigest()[:6] + '.companions'
            command = [*proxy_command(), name, *command]
        write_json(STATE, {'status': 'starting'})
        with (LOCAL / 'dev-launch.log').open('a') as output:
            child = subprocess.Popen(command, cwd=ROOT, env=env, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        deadline = time.monotonic() + 180
        try:
            while time.monotonic() < deadline:
                current = status()
                if current.get('status') == 'ready':
                    print(current['url'])
                    return
                if child.poll() is not None:
                    raise RuntimeError('Stack startup failed. See .local/dev-launch.log and ./dev logs.')
                time.sleep(.25)
            raise RuntimeError('Stack readiness timed out. See .local/dev-launch.log.')
        except BaseException:
            current = read_json(STATE)
            if alive(current):
                os.kill(current['pid'], signal.SIGTERM)
            try:
                child.wait(timeout=25)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGTERM)
            raise

def down():
    with lock('dev-command.lock', blocking=True):
        state = read_json(STATE)
        if alive(state):
            os.kill(state['pid'], signal.SIGTERM)
            deadline = time.monotonic() + 40
            while alive(state) and time.monotonic() < deadline:
                time.sleep(.25)
            if alive(state):
                raise RuntimeError('Shutdown timed out; inspect owned processes with ./dev status --json.')
        # If the supervisor died, terminate only children whose saved start time AND command match.
        for service in state.get('services', {}).values():
            pid = service.get('pid')
            if not isinstance(pid, int) or pid < 2:
                continue
            identity = subprocess.run(['ps', '-p', str(pid), '-o', 'lstart='], capture_output=True, text=True)
            command = subprocess.run(['ps', '-p', str(pid), '-o', 'command='], capture_output=True, text=True)
            if identity.returncode == 0 and identity.stdout.strip() == service.get('identity') and command.stdout.strip() == service.get('command'):
                os.killpg(pid, signal.SIGTERM)
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    result = subprocess.run(['ps', '-p', str(pid), '-o', 'lstart='], capture_output=True, text=True)
                    if result.returncode or result.stdout.strip() != service['identity']:
                        break
                    time.sleep(.2)
                else:
                    raise RuntimeError('An owned service did not stop; retry ./dev down after inspecting logs.')
        # Recover orphaned local containers after a hard supervisor crash, with exact labels only.
        for directory in (ROOT, LOCAL):
            owner = hashlib.sha256(str(directory).encode()).hexdigest()[:10]
            command = ['docker', 'ps', '-q', '--filter', f'label=companions.build.workspace={owner}']
            ids = subprocess.check_output(command, text=True).split()
            if ids:
                subprocess.run(['docker', 'stop', '--time', '3', *ids], check=True, stdout=subprocess.DEVNULL)
            if subprocess.check_output(command, text=True).strip():
                raise RuntimeError('Owned containers remain running')
        state.update(status='stopped', services={}, cleanup={'verified': True})
        write_json(STATE, state)
        print('Stopped; owned containers verified stopped, disks retained.')

def setup(portless=False, https=False):
    prepare()
    if portless:
        subprocess.run(['npm', 'ci', '--prefix', str(ROOT / 'tools/dev'), '--no-audit', '--no-fund'], check=True)
        options = {'portless': True, 'https': https, 'proxyPort': 443 if https else 1355}
        write_json(LOCAL / 'dev-options.json', options)
        if https:
            subprocess.run([*proxy_command(), 'proxy', 'start', '--https', '--port', '443'], check=True,
                           env={**os.environ, 'PORTLESS_STATE_DIR': str(Path.home() / '.local/state/companions-portless'), 'PORTLESS_SYNC_HOSTS': '0'})
    print('Prepared. Run ./dev up.')

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    subs = parser.add_subparsers(dest='command', required=True)
    p = subs.add_parser('setup'); p.add_argument('--portless', action='store_true'); p.add_argument('--https', action='store_true')
    p = subs.add_parser('up'); p.add_argument('--direct', action='store_true')
    subs.add_parser('down'); subs.add_parser('restart')
    p = subs.add_parser('status'); p.add_argument('--json', action='store_true')
    p = subs.add_parser('logs'); p.add_argument('service', nargs='?', choices=['api', 'executor', 'worker', 'web'])
    subs.add_parser('open')
    for command in ['menu', 'workspace', 'herdr-install']:
        subs.add_parser(command)
    for command in ['check', 'scenario', 'browser-test']:
        p = subs.add_parser(command); p.add_argument('arguments', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.command == 'up': up(args.direct)
    elif args.command == 'down': down()
    elif args.command == 'restart': down(); up()
    elif args.command == 'setup': setup(args.portless, args.https)
    elif args.command == 'status':
        state = status()
        print(json.dumps(state, indent=2) if args.json else f"{state['status']} · {state.get('url', 'no URL')}")
    elif args.command == 'logs':
        files = [LOCAL / 'logs' / f'{args.service}.log'] if args.service else sorted((LOCAL / 'logs').glob('*.log'))
        if not files: files = [LOCAL / 'dev-launch.log']
        for file in files:
            print(f'[{file.name}]')
            if file.exists(): print('\n'.join(file.read_text(errors='replace').splitlines()[-60:]))
    elif args.command == 'open':
        current = status()
        if current['status'] != 'ready': raise RuntimeError('Run ./dev up first.')
        subprocess.run(['open' if sys.platform == 'darwin' else 'xdg-open', current['url']], check=True)
    else:
        scripts = {'check': 'check.py', 'scenario': 'dev-scenario.py', 'browser-test': 'dev-browser-test.py',
                   'menu': 'dev-herdr.py', 'workspace': 'dev-herdr.py', 'herdr-install': 'dev-herdr.py'}
        extra = getattr(args, 'arguments', None)
        if extra is None: extra = ['install' if args.command == 'herdr-install' else args.command]
        result = subprocess.run([sys.executable, str(ROOT / 'scripts' / scripts[args.command]), *extra], cwd=ROOT)
        raise SystemExit(result.returncode)

if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
