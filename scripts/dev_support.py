"""Shared local development preparation and ownership primitives (no effects at import)."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import signal
import socket
import sys

ROOT = Path(__file__).resolve().parents[1]
LOCAL = ROOT / '.local'

def check_service_ports(ports):
    """Fail before startup effects; never stop the process owning an occupied port."""
    for service, port in ports.items():
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                probe.bind(('127.0.0.1', int(port)))
            except OSError as error:
                raise RuntimeError(
                    f"{service} cannot start: local port {port} is unavailable. "
                    f"Inspect its owner with lsof -nP -iTCP:{port} -sTCP:LISTEN; "
                    "stop it only if it belongs to this worktree, or choose another port."
                ) from error


def launch_owned(command, persist, **kwargs):
    """Release a child into its service only after its ownership record is saved.

    A killed parent closes the gate: an unrecorded child exits without executing.
    Exec preserves the recorded PID, start time and process group.
    """
    read_fd, write_fd = os.pipe()
    child = None
    try:
        child = subprocess.Popen([sys.executable, str(ROOT / 'scripts/dev-child.py'),
                                  str(read_fd), *command], pass_fds=(read_fd,),
                                 start_new_session=True, **kwargs)
        os.close(read_fd)
        read_fd = None
        record = {'pid': child.pid, 'command': ' '.join(command),
                  'identity': subprocess.check_output(['ps', '-p', str(child.pid), '-o', 'lstart='], text=True).strip(),
                  'launchCommand': subprocess.check_output(['ps', '-p', str(child.pid), '-o', 'command='], text=True).strip()}
        persist(child, record)
        os.write(write_fd, b'1')
        return child
    except BaseException:
        if child is not None:
            terminate_process(child)
        raise
    finally:
        if read_fd is not None:
            os.close(read_fd)
        os.close(write_fd)

def terminate_process(child, grace=10):
    """Terminate an owned process group; process-exit races are already successful exits."""
    if child.poll() is None:
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    try:
        child.wait(timeout=grace)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait(timeout=5)

def run_preparation(command, cwd):
    child = subprocess.Popen(command, cwd=cwd, start_new_session=True)
    try:
        code = child.wait(timeout=180)
        if code:
            raise subprocess.CalledProcessError(code, command)
    except BaseException:
        terminate_process(child)
        raise

def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.chmod(0o600)
    temporary.replace(path)

def read_json(path):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, ValueError):
        return {}

def lock(name, blocking=False):
    LOCAL.mkdir(parents=True, exist_ok=True, mode=0o700)
    handle = (LOCAL / name).open('a+')
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
    except BlockingIOError:
        handle.close()
        raise RuntimeError('This worktree already has an operation running: ' + name)
    return handle

def digest(paths):
    value = hashlib.sha256()
    for path in sorted(set(paths)):
        if path.is_file():
            value.update(str(path.relative_to(ROOT)).encode())
            value.update(path.read_bytes())
    return value.hexdigest()

def source_digest():
    return digest([ROOT / 'bun.lock', ROOT / 'package.json', *ROOT.glob('packages/**/*'),
                   *ROOT.glob('scripts/lib/*'), ROOT / 'scripts/build-agent.ts'])

def prepare(build=True):
    from bun import module
    with lock('prepare.lock', blocking=True):
        bun = module.toolchain()
        cache = read_json(LOCAL / 'dev-build.json')
        for relative, key in [('', 'root'), ('apps/web', 'web')]:
            directory = ROOT / relative
            fingerprint = digest([directory / 'package.json', directory / 'bun.lock'])
            if cache.get(key) != fingerprint or not (directory / 'node_modules').is_dir():
                run_preparation([bun, '--no-env-file', 'install', '--frozen-lockfile'], directory)
                cache[key] = fingerprint
        if build:
            fingerprint = source_digest()
            if cache.get('agent') != fingerprint or not (ROOT / 'dist/agent/companion-agent').exists():
                run_preparation([bun, '--no-env-file', 'scripts/build-agent.ts'], ROOT)
                cache['agent'] = fingerprint
        write_json(LOCAL / 'dev-build.json', cache)
        return bun

def proxy_command():
    directory = ROOT / 'tools/dev/node_modules'
    node = directory / 'node/bin/node'
    script = directory / 'portless/dist/cli.js'
    package = read_json(directory / 'portless/package.json')
    entry = package.get('bin', {})
    if isinstance(entry, dict):
        script = directory / 'portless' / entry.get('portless', 'dist/cli.js')
    if not node.exists() or not script.exists():
        raise RuntimeError('Portless is not prepared. Run ./dev setup --portless once.')
    return [str(node), str(script)]
