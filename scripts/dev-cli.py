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
import uuid
import urllib.request

from dev_environment import runtime_environment, MODEL_KEYS
from dev_support import ROOT, LOCAL, lock, prepare, proxy_command, read_json, write_json, terminate_process

STATE = LOCAL / 'dev-state.json'

def alive(state):
    pid = state.get('pid')
    if not isinstance(pid, int) or pid < 2:
        return False
    identity = subprocess.run(['ps', '-p', str(pid), '-o', 'lstart='], capture_output=True, text=True)
    command = subprocess.run(['ps', '-p', str(pid), '-o', 'command='], capture_output=True, text=True)
    if identity.returncode != 0 or identity.stdout.strip() != state.get('identity') or command.returncode != 0:
        return False
    if str(ROOT / 'scripts/dev.py') in command.stdout:
        return True
    # `bun run dev` invokes a relative script; confirm its cwd before claiming it.
    try:
        argv = shlex.split(command.stdout)
        if len(argv) < 2 or not Path(argv[0]).name.lower().startswith('python') or argv[1] not in ('scripts/dev.py', './scripts/dev.py'):
            return False
        proc_cwd = Path('/proc') / str(pid) / 'cwd'
        if proc_cwd.exists():
            return proc_cwd.resolve() == ROOT
        observed = subprocess.run(['lsof', '-a', '-p', str(pid), '-d', 'cwd', '-Fn'], capture_output=True, text=True)
        return observed.returncode == 0 and f'n{ROOT}' in observed.stdout.splitlines()
    except (OSError, ValueError):
        return False

def status():
    state = read_json(STATE)
    if not alive(state):
        state['status'] = 'stopped' if state.get('status') == 'stopped' or not state else 'failed'
        for service in state.get('services', {}).values():
            service['status'] = 'stopped' if state['status'] == 'stopped' else 'unknown'
    elif state.get('status') == 'ready':
        for service in state.get('services', {}).values():
            if 'pid' not in service:
                continue
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
    threshold = 120 if state.get('status') in ('changing', 'restarting') else 15
    if alive(state) and state.get('heartbeat') and time.time() - state['heartbeat'] > threshold:
        state['status'] = 'unresponsive'
    validation = read_json(LOCAL / 'latest-validation.json')
    if validation:
        from validation_evidence import source_evidence
        if validation.get('source', {}).get('fingerprint') != source_evidence(ROOT)['fingerprint']:
            validation['status'] = 'stale'
        elif validation.get('status') == 'running':
            try:
                handle = lock('verification.lock')
            except RuntimeError:
                pass
            else:
                handle.close()
                validation['status'] = 'interrupted'
        state['validation'] = validation
    return state

SERVICES = ['api', 'web', 'executor', 'worker', 'postgres', 'storage', 's3', 'mailpit']

def service_action(action, name):
    if name == 's3': name = 'storage'
    state = read_json(STATE)
    if not alive(state):
        if action == 'stop':
            print(f'{name}: already stopped.')
        else:
            up(only=name)
        return
    with lock('dev-command.lock', blocking=True):
        _service_action(action, name)

def _service_action(action, name):
    state = read_json(STATE)
    if not alive(state):
        raise RuntimeError('Supervisor stopped before admission; command not submitted.')
    identifier = uuid.uuid4().hex
    directory = LOCAL / 'dev-commands'
    path = directory / (identifier + '.request.json')
    write_json(path, {'id': identifier, 'action': action, 'service': name,
                     'supervisor': state['pid'], 'identity': state['identity']})
    result_path = directory / (identifier + '.result.json')
    deadline = time.monotonic() + 100
    while time.monotonic() < deadline:
        result = read_json(result_path)
        if result:
            if result['status'] != 'passed':
                raise RuntimeError(result['error'])
            print(f'{name}: {action} completed.')
            return
        if not alive(state):
            raise RuntimeError('Supervisor exited; command outcome unknown. Inspect status before retrying.')
        time.sleep(.25)
    raise RuntimeError('Command outcome unknown after timeout. Inspect status before retrying.')

def local_env(live=None):
    # Keep infrastructure local; model credentials require an explicit live choice.
    runtime = runtime_environment(ROOT)
    if live is None:
        live = read_json(LOCAL / "dev-options.json").get("liveModel", runtime.get("DEV_LIVE_MODEL") == "1")
    result = {key: value for key, value in os.environ.items() if key in
              {'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'TERM'}
              or key.startswith(('LC_', 'DOCKER_', 'HERDR_'))}
    result.update({key: value for key, value in runtime.items() if key in {"BOX_API_KEY", "BOX_TEMPLATE"}})
    result.update(COMPANIONS_DEV_LOCAL='1', AGENT_TEST_MODE='1', BILLING_TEST_MODE='1',
                  LOCAL_RUNTIME=runtime.get('LOCAL_RUNTIME', '0'), EMAIL_PROVIDER='smtp', NODE_ENV='development',
                  COMPANIONS_DATA_DIR=str(LOCAL), COMPANIONS_DEV_WATCH=os.environ.get('COMPANIONS_DEV_WATCH', '1'))
    if live:
        result.update(runtime)
        result.update(AGENT_TEST_MODE='0')
        result.setdefault('MODEL_PROVIDER', 'google')
    return result

def validate_model_env(env):
    if env.get('AGENT_TEST_MODE') == '0' and not any(env.get(key) for key in [key for keys in MODEL_KEYS.values() for key in keys]):
        raise RuntimeError('Live mode needs a model API key in the main checkout .env, worktree .env or shell. No credentials are saved in dev options.')

def choose_base():
    endpoints = read_json(LOCAL / 'dev-endpoints.json')
    previous = endpoints.get('basePort')
    # Older launchers persisted only adjacent web/API ports. Retain that block:
    # existing Docker services keep their original port bindings across restarts.
    if not previous and isinstance(endpoints.get('webPort'), int) and endpoints.get('apiPort') == endpoints['webPort'] + 1:
        previous = endpoints['webPort']
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

def up(direct=False, only=None):
    with lock('dev-command.lock', blocking=True):
        current = status()
        if alive(current):
            if current['status'] == 'ready':
                print(current['url'])
                return
            if current['status'] in ('degraded', 'build-failed'):
                for name in ['postgres', 'storage', 'mailpit', 'api', 'executor', 'worker', 'web']:
                    service = current.get('services', {}).get(name, {})
                    if service.get('status') != 'ready' and service.get('managed', True):
                        _service_action('start', name)
                print(current.get('url', 'Services started.'))
                return
            raise RuntimeError('Stack is already starting/restarting or unhealthy. Inspect ./dev logs.')
        LOCAL.mkdir(exist_ok=True, mode=0o700)
        env = local_env()
        validate_model_env(env)
        if only:
            env['COMPANIONS_DEV_COMPONENTS'] = only
        env['CONDUCTOR_PORT'] = str(choose_base())
        command = [sys.executable, str(ROOT / 'scripts/dev.py')]
        proxy = read_json(LOCAL / 'dev-options.json').get('portless', False) and not direct
        if proxy:
            options = read_json(LOCAL / 'dev-options.json')
            env.update(PORTLESS_PORT=str(options.get('proxyPort', 1355)), PORTLESS_HTTPS='1' if options.get('https') else '0',
                       PORTLESS_LAN='0', PORTLESS_SYNC_HOSTS='0', PORTLESS_TAILSCALE='0', PORTLESS_FUNNEL='0', PORTLESS_NGROK='0',
                       PORTLESS_STATE_DIR=str(Path.home() / '.local/state/companions-portless'))
            label = re.sub(r'^worktree-|-[0-9a-f]{4,}$', '', ROOT.name.lower())
            name = re.sub('[^a-z0-9-]', '-', label)[:28].strip('-') or 'worktree'
            name += '-' + hashlib.sha256(str(ROOT).encode()).hexdigest()[:4] + '.companions'
            command = [*proxy_command(), name, *command]
        write_json(STATE, {'status': 'starting'})
        with (LOCAL / 'dev-launch.log').open('a') as output:
            child = subprocess.Popen(command, cwd=ROOT, env=env, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        deadline = time.monotonic() + 180
        try:
            while time.monotonic() < deadline:
                current = status()
                if current.get('status') == 'ready' or (only and current.get('heartbeat') and current.get('services', {}).get(only, {}).get('status') == 'ready'):
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
                terminate_process(child)
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
            if identity.returncode == 0 and identity.stdout.strip() == service.get('identity') and command.stdout.strip() in (service.get('command'), service.get('launchCommand')):
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
        proxy_env = state.get('endpoints', {}).get('proxyEnv')
        from dev_portless import cleanup_recorded
        cleanup_recorded({**local_env(), **(proxy_env or {})})
        for service in state.get('services', {}).values():
            service['status'] = 'stopped'
        state.update(status='stopped', cleanup={'verified': True})
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
    for name in ['up', 'restart']:
        p = subs.add_parser(name); p.add_argument('--direct', action='store_true')
        mode = p.add_mutually_exclusive_group()
        mode.add_argument('--live', action='store_true', help='Use a real model with the API key from your shell')
        mode.add_argument('--scripted', action='store_true', help='Use deterministic test responses')
    subs.add_parser('down')
    p = subs.add_parser('status'); p.add_argument('--json', action='store_true')
    p = subs.add_parser('logs'); p.add_argument('service', nargs='?', choices=SERVICES)
    p = subs.add_parser('open'); p.add_argument('service', nargs='?', choices=SERVICES, default='web')
    p = subs.add_parser('service'); p.add_argument('action', choices=['start', 'stop', 'restart']); p.add_argument('service', choices=SERVICES)
    for command in ['menu', 'workspace', 'herdr-install']:
        subs.add_parser(command)
    for command in ['check', 'scenario', 'browser-test']:
        p = subs.add_parser(command); p.add_argument('arguments', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.command in ('up', 'restart') and (args.live or args.scripted):
        validate_model_env(local_env(live=args.live))
        if args.command == 'up' and alive(status()) and read_json(LOCAL / 'dev-options.json').get('liveModel', False) != args.live:
            raise RuntimeError('The stack is running. Use ./dev restart --live or --scripted to change its model mode.')
        options = read_json(LOCAL / 'dev-options.json'); options['liveModel'] = args.live
        write_json(LOCAL / 'dev-options.json', options)
    if args.command == 'up': up(args.direct)
    elif args.command == 'down': down()
    elif args.command == 'restart':
        validate_model_env(local_env())
        down(); up(args.direct)
    elif args.command == 'setup': setup(args.portless, args.https)
    elif args.command == 'service': service_action(args.action, args.service)
    elif args.command == 'status':
        state = status()
        print(json.dumps(state, indent=2) if args.json else f"{state['status']} · {state.get('url', 'no URL')}")
    elif args.command == 'logs':
        if args.service in ('postgres', 'storage', 's3', 'mailpit'):
            prefix = {'postgres': 'pg', 'storage': 'minio', 's3': 'minio', 'mailpit': 'mailpit'}[args.service]
            owner = hashlib.sha256(str(ROOT).encode()).hexdigest()[:10]
            name = f'companions-{prefix}-{owner}'
            inspected = subprocess.check_output(['docker', 'inspect', name], text=True)
            if json.loads(inspected)[0].get('Config', {}).get('Labels', {}).get('companions.build.workspace') != owner:
                raise RuntimeError('Container ownership mismatch')
            subprocess.run(['docker', 'logs', '--tail', '60', name], check=True)
            return
        files = [LOCAL / 'logs' / f'{args.service}.log'] if args.service else sorted((LOCAL / 'logs').glob('*.log'))
        if not files: files = [LOCAL / 'dev-launch.log']
        for file in files:
            print(f'[{file.name}]')
            if file.exists(): print('\n'.join(file.read_text(errors='replace').splitlines()[-60:]))
    elif args.command == 'open':
        current = status()
        url = current.get('services', {}).get(args.service, {}).get('url') or (current.get('url') if args.service == 'web' else None)
        if not url: raise RuntimeError('This component has no browser URL. Use its logs.')
        if args.service == 'postgres':
            print('PostgreSQL has no web interface. Connect your database client to: ' + url)
            return
        subprocess.run(['open' if sys.platform == 'darwin' else 'xdg-open', url], check=True)
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
