"""Shared local development preparation and ownership primitives (no effects at import)."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import signal

ROOT = Path(__file__).resolve().parents[1]
LOCAL = ROOT / '.local'

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
