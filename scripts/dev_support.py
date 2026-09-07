"""Shared local development preparation and ownership primitives (no effects at import)."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
LOCAL = ROOT / '.local'

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
                subprocess.run([bun, 'install', '--frozen-lockfile'], cwd=directory, check=True)
                cache[key] = fingerprint
        if build:
            fingerprint = source_digest()
            if cache.get('agent') != fingerprint or not (ROOT / 'dist/agent/companion-agent').exists():
                subprocess.run([bun, 'scripts/build-agent.ts'], cwd=ROOT, check=True)
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
